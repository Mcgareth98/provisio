// PROVISIO Service Worker — Cache-First para assets, Network-First para Supabase
const CACHE_NAME = 'provisio-v1';

const STATIC_ASSETS = [
  './index.html',
  './app.js',
  './manifest.json',
];

// CDN assets a pre-cachear
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/tesseract.js@4/dist/tesseract.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache local assets (deben existir)
      return cache.addAll(STATIC_ASSETS).then(() => {
        // CDN assets: intentar cachear pero no fallar si no hay red
        return Promise.allSettled(
          CDN_ASSETS.map(url =>
            fetch(url).then(res => cache.put(url, res)).catch(() => {})
          )
        );
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Supabase API → Network First (datos siempre frescos)
  if (url.hostname.includes('supabase.co')) {
    event.respondWith(
      fetch(request)
        .then((res) => res)
        .catch(() => caches.match(request))
    );
    return;
  }

  // Tesseract workers y langdata → Network First (archivos grandes)
  if (url.pathname.includes('lang-data') || url.pathname.includes('worker')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Todo lo demás → Cache First, red como fallback
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((res) => {
          // Solo cachear respuestas válidas de GET
          if (request.method === 'GET' && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(() => {
          // Offline fallback para navegación
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
    })
  );
});

// Mensaje desde la app para limpiar cache (usado en Ajustes)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.ports[0].postMessage({ success: true });
    });
  }
});
