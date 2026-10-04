// Работа без интернета: файлы приложения хранятся в кэше телефона.
// При каждом открытии с интернетом берётся свежая версия с сайта.
const CACHE = 'kiz-scan-v6';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './config.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Файлы приложения: сначала сеть (свежая версия), без сети — из кэша.
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request, {ignoreSearch: true})
            .then(hit => hit || caches.match('./index.html'))
        )
    );
    return;
  }

  // Библиотека распознавания: из кэша, чтобы работала без интернета.
  if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'fastly.jsdelivr.net' ||
      url.hostname === 'unpkg.com') {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      }))
    );
  }
  // Запросы к Google (сканы) не трогаем — они всегда идут в сеть.
});
