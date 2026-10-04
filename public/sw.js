// sw.js — Service Worker de Hobbi.
// Ubicación: raíz de "public/" (se registra desde index.html con scope '/').
//
// CACHE_VERSION usa un timestamp automático (fecha del día) — no tenés que
// acordarte de cambiar nada. Cada día (o cada vez que se carga en un nuevo día
// calendario), el Service Worker detecta que CACHE_VERSION cambió, descarga los
// archivos nuevos, y los cachea. Así las actualizaciones llegan solas sin que
// hagas nada extra.
const CACHE_VERSION = 'hobbi-' + new Date().toISOString().slice(0, 10);

// Archivos esenciales para que la app abra incluso sin conexión. No hace
// falta listar TODO — el resto (imágenes de pósters, pedidos a la API de
// TVMaze) ya tiene su propio manejo de caché adentro de index.html.
// Caché aparte para los pósters de TVMaze (no se borra al cambiar de versión).
const CACHE_IMAGENES = 'hobbi-img-v1';
const MAX_IMAGENES = 250;

const ARCHIVOS_ESENCIALES = [
  '/',
  '/index.html',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(ARCHIVOS_ESENCIALES))
  );
  // No esperamos a que se cierren las pestañas viejas: el Service Worker
  // nuevo se activa apenas termina de instalar. Junto con clients.claim()
  // de abajo, esto es lo que hace que la actualización llegue rápido en vez
  // de recién aplicarse la vez siguiente que se abre la app desde cero.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      // Borramos cualquier caché de una versión anterior (CACHE_VERSION
      // distinto) — así no se va acumulando espacio con versiones viejas.
      Promise.all(
        nombres.filter((nombre) => nombre !== CACHE_VERSION && nombre !== CACHE_IMAGENES).map((nombre) => caches.delete(nombre))
      )
    ).then(() => self.clients.claim())
  );
});

// Deja como máximo MAX_IMAGENES pósters en el caché (borra los más viejos primero).
async function recortarCacheImagenes() {
  const cache = await caches.open(CACHE_IMAGENES);
  const claves = await cache.keys();
  const sobran = claves.length - MAX_IMAGENES;
  for (let i = 0; i < sobran; i++) await cache.delete(claves[i]);
}

// Pósters de TVMaze: primero el caché; si no está, se baja y se guarda.
// Se pide en modo CORS para poder guardar solo respuestas reales (las "opaque"
// ocupan mucho cupo de almacenamiento). Si el servidor no permite CORS, la
// imagen se muestra igual pero no se guarda.
async function manejarImagenTvmaze(request) {
  const cache = await caches.open(CACHE_IMAGENES);
  const guardada = await cache.match(request.url);
  if (guardada) return guardada;
  try {
    const res = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) {
      await cache.put(request.url, res.clone());
      recortarCacheImagenes();
    }
    return res;
  } catch (err) {
    return fetch(request); // sin CORS o sin red: pedido normal, sin guardar
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Pósters: caché primero (funcionan sin conexión y no se vuelven a bajar).
  if (url.hostname === 'static.tvmaze.com' && event.request.destination === 'image') {
    event.respondWith(manejarImagenTvmaze(event.request));
    return;
  }

  // Solo interceptamos pedidos a nuestro propio origen (el HTML, el manifest).
  // Todo lo demás (TVMaze, OMDb, Google, /api/*) va directo a la red.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    // "Network first, cache fallback": siempre intenta la red primero y, si falla
    // (sin internet), usa lo que haya en caché.
    fetch(event.request)
      .then((respuesta) => {
        // Solo guardamos respuestas buenas y completas: un 404/500 o una respuesta
        // parcial en el caché se serviría después, sin conexión, como si fuera la app.
        if (respuesta.ok && respuesta.status === 200 && respuesta.type === 'basic') {
          const respuestaClonada = respuesta.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, respuestaClonada));
        }
        return respuesta;
      })
      .catch(async () => {
        const guardada = await caches.match(event.request);
        if (guardada) return guardada;
        // Navegación sin conexión y sin esa página guardada: abrimos la app.
        if (event.request.mode === 'navigate') {
          const inicio = await caches.match('/') || await caches.match('/index.html');
          if (inicio) return inicio;
        }
        return Response.error();
      })
  );
});

/* ---------- Aviso diario de "hoy sale…" (Periodic Background Sync) ----------
   La página guarda en IndexedDB ('hobbi-sw') la lista de series que seguís y
   el idioma. Cuando Android/Chrome despierta al service worker (best-effort:
   el sistema decide cuándo, normalmente cada 12 hs o más, y solo en la app
   instalada), se mira el capítulo anterior y el próximo de cada favorita y, si alguno sale hoy, se muestra UNA notificación por día. */
function abrirDbSw() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('hobbi-sw', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function leerKv(clave) {
  const db = await abrirDbSw();
  return new Promise((resolve) => {
    const r = db.transaction('kv').objectStore('kv').get(clave);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => resolve(undefined);
  });
}
async function guardarKv(clave, valor) {
  const db = await abrirDbSw();
  return new Promise((resolve) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(valor, clave);
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
}

async function avisarEpisodiosDeHoy() {
  if (!self.Notification || self.Notification.permission !== 'granted') return;
  const favoritos = await leerKv('favoritos');
  if (!Array.isArray(favoritos) || !favoritos.length) return;

  const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const ahora = new Date();
  const hoy = fmt(ahora);
  if ((await leerKv('ultimoAvisoDiario')) === hoy) return; // ya avisamos hoy

  // "Hoy" = de 00:00 a 24:00 en la hora del celu, mirando la hora exacta de cada episodio (airstamp):
  // el día del calendario de TVMaze no coincide con el día local (en Argentina lo que sale de noche
  // figura en el día siguiente).
  const inicio = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const fin = new Date(inicio); fin.setDate(fin.getDate() + 1);
  const esDeHoy = (ep) => {
    if (!ep) return false;
    if (ep.airstamp) { const c = new Date(ep.airstamp); return c >= inicio && c < fin; }
    return ep.airdate === hoy;
  };

  // Se le pide a TVMaze el capítulo anterior y el próximo de CADA serie favorita (en vez del calendario
  // de streaming de hoy, que dejaba afuera a las series de TV tradicional). El anterior sirve para
  // capítulos que ya salieron hoy antes de que Android despertara al service worker.
  const nombres = [];
  const TAMANO_LOTE = 5;
  for (let i = 0; i < favoritos.length; i += TAMANO_LOTE) {
    const lote = favoritos.slice(i, i + TAMANO_LOTE);
    const resultados = await Promise.all(lote.map(async (fav) => {
      try {
        const res = await fetch('https://api.tvmaze.com/shows/' + encodeURIComponent(fav.id) + '?embed[]=nextepisode&embed[]=previousepisode');
        if (!res.ok) return null;
        const show = await res.json();
        const emb = (show && show._embedded) || {};
        const nombre = (show && show.name) || fav.name;
        return (esDeHoy(emb.nextepisode) || esDeHoy(emb.previousepisode)) ? nombre : null;
      } catch { return null; }
    }));
    resultados.forEach((n) => { if (n) nombres.push(n); });
    if (i + TAMANO_LOTE < favoritos.length) await new Promise((r) => setTimeout(r, 1500)); // TVMaze corta a ~20 pedidos / 10 s
  }
  if (!nombres.length) return;

  const en = (await leerKv('idioma')) === 'en';
  const lista = nombres.slice(0, 3).join(', ') + (nombres.length > 3 ? ' +' + (nombres.length - 3) : '');
  await self.registration.showNotification(en ? '📺 Out today' : '📺 Hoy sale', {
    body: lista,
    icon: '/icons/icon-192.png',
    tag: 'hobbi-hoy',
    data: { url: '/' }
  });
  await guardarKv('ultimoAvisoDiario', hoy);
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'hobbi-hoy') event.waitUntil(avisarEpisodiosDeHoy().catch(() => {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((lista) => {
      if (lista.length) return lista[0].focus();
      return self.clients.openWindow((event.notification.data && event.notification.data.url) || '/');
    })
  );
});

// (El chequeo de versión nueva ya no vive acá: un setInterval dentro del service worker
//  se corta cuando Android lo duerme. Ahora lo hace la propia página — ver vigilarVersionNueva en index.html.)
