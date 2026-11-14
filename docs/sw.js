const STATIC_CACHE = 'zhytomyr-map-static-v1';
const DATA_CACHE = 'zhytomyr-map-data-v1';

const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './data/zhytomyr_oblast.geojson',
  './data/zhytomyr_mask.geojson',
  './data/zhytomyr_raions.geojson',
  './data/zhytomyr_raion_labels.geojson',
  './data/zhytomyr_villages.geojson',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== STATIC_CACHE && k !== DATA_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Network-First для актуальних статусів відключень (outages.json)
  if (url.pathname.endsWith('/outages.json') || url.pathname.endsWith('outages.json')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(DATA_CACHE).then((cache) => cache.put('./data/outages.json', copy));
          }
          return res;
        })
        .catch(() => caches.match('./data/outages.json'))
    );
    return;
  }

  // Cache-First + фонове оновлення для статичних ресурсів того ж домену
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((cached) => {
        const networkFetch = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(STATIC_CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);

        return cached || networkFetch;
      })
    );
  }
});
