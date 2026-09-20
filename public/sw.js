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
