// Service Worker — офлайн-кеш
// Стратегия: network-first для HTML/JS/CSS (быстро подхватывает обновления),
// cache-only для CDN-ресурсов. API запросы не кешируются.
const CACHE = 'fintracker-v4';
const ASSETS = [
  '/',
  '/add.html',
  '/history.html',
  '/settings.html',
  '/charts.html',
  '/css/styles.css',
  '/js/app.js',
  '/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  if (e.request.url.includes('/api/')) return; // не кешируем API

  // Network-first: пробуем сеть, при ошибке — кэш.
  // Это гарантирует что обновления видны сразу, а офлайн работает.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(cache => cache.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(cached => cached || caches.match('/')))
  );
});
