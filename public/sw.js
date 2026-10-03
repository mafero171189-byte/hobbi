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
   instalada), se mira el calendario de hoy y, si sale un episodio de alguna de
   tus series, se muestra UNA notificación por día. */
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

  const d = new Date();
  const hoy = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  if ((await leerKv('ultimoAvisoDiario')) === hoy) return; // ya avisamos hoy

  const res = await fetch('https://api.tvmaze.com/schedule/web?date=' + hoy);
  if (!res.ok) return;
  const dia = await res.json();
  const ids = new Set(favoritos.map((f) => f.id));
  const nombres = [];
  const vistos = new Set();
  (Array.isArray(dia) ? dia : []).forEach((ep) => {
    const show = ep && (ep.show || (ep._embedded && ep._embedded.show));
    if (!show || !ids.has(show.id) || vistos.has(show.id)) return;
    vistos.add(show.id);
    nombres.push(show.name);
  });
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

/* ---------- Chequeo automático de actualizaciones cada 2 minutos ----------
   Mientras la app esté abierta, el Service Worker chequea cada 2 minutos si
   hay versión nueva (comparando CACHE_VERSION — que incluye la fecha). Si
   detecta cambios, le notifica al cliente con un mensaje, para que la app
   pueda mostrar un banner "Hay actualización disponible" o actualizar
   silenciosamente. El cliente puede implementar la UX que quiera en respuesta. */

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Chequea el Service Worker nuevo cada 2 minutos (120 segundos).
// Esto solo funciona mientras la app esté abierta — al cerrarla, esto para.
setInterval(() => {
  fetch(self.location.href)
    .then((respuesta) => respuesta.text())
    .then((html) => {
      // Buscamos en el HTML nuevo cuál es el CACHE_VERSION que tiene ahora.
      // Si es distinto al actual, significa que hay versión nueva.
      const versionMatch = html.match(/const CACHE_VERSION = 'hobbi-\d{4}-\d{2}-\d{2}'/);
      if (versionMatch) {
        const nuevaVersion = versionMatch[0].split("'")[1];
        if (nuevaVersion !== CACHE_VERSION) {
          // Hay versión nueva — notificamos a todos los clientes (las pestañas/app abierta)
          self.clients.matchAll().then((clients) => {
            clients.forEach((cliente) => {
              cliente.postMessage({
                type: 'UPDATE_AVAILABLE',
                version: nuevaVersion
              });
            });
          });
        }
      }
    })
    .catch(() => {
      // Si falla el chequeo (sin internet), simplemente lo reintentamos en 2 minutos más.
    });
}, 120000); // 120000 ms = 2 minutos
