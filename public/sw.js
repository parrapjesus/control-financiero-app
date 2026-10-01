// Service Worker para Control Financiero Pro (PWA / TWA) - Network-First
const CACHE_NAME = 'cfp-cache-v5';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/js/app.js',
  '/js/supabase-config.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch((err) => {
        console.warn('Algunos recursos estáticos no pudieron ser cacheados:', err);
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('🧹 Eliminando caché antigua:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Network-First: Siempre intenta buscar la versión fresca en el servidor
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // No interceptar llamadas a APIs ni bases de datos externas
  if (url.includes('/api/') || url.includes('supabase.co') || url.includes('googleapis.com')) {
    return;
  }

  // Para peticiones GET de la app: red primero, fallback a caché
  if (event.request.method === 'GET') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === 'basic') {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return response;
        })
        .catch(() => {
          // Si está offline o falla la red, usar la copia guardada en caché
          return caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) return cachedResponse;
            if (event.request.mode === 'navigate') {
              return caches.match('/index.html');
            }
          });
        })
    );
  }
});
