// sw.js — Service Worker de Hobbi.
// Ubicación: raíz de "public/" (se registra desde index.html con scope '/').
//
// CACHE_VERSION es la pieza clave para que las actualizaciones lleguen solas:
// cada vez que cambies algo en index.html (o cualquier archivo cacheado) y
// subas el cambio a GitHub, subí también este número en 1. Eso hace que el
// navegador detecte un Service Worker "nuevo", descargue los archivos de
// vuelta, y los reemplace la próxima vez que se abra la app — sin que el
// usuario tenga que desinstalar ni reinstalar nada, ni ir a ninguna tienda.
const CACHE_VERSION = 'hobbi-v1';

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
