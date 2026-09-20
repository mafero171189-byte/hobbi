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
        nombres.filter((nombre) => nombre !== CACHE_VERSION).map((nombre) => caches.delete(nombre))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Solo interceptamos pedidos a nuestro propio origen (el HTML, el
  // manifest). Todo lo demás (TVMaze, OMDb, Google, la API de /api/*) sigue
  // yendo directo a la red — la app ya maneja sus propios caches y fallbacks
  // para esos pedidos (ver fetchJSON en index.html), no queremos que el
  // Service Worker interfiera ahí.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    // "Network first, cache fallback": siempre intenta traer la versión más
    // nueva de la red primero (así las actualizaciones se ven apenas hay
    // conexión), y si falla (sin internet), usa lo que haya en caché.
    fetch(event.request)
      .then((respuesta) => {
        const respuestaClonada = respuesta.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, respuestaClonada));
        return respuesta;
      })
      .catch(() => caches.match(event.request))
  );
});
