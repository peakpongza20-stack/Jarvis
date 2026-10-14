// Caches the app shell so Jarvis opens instantly and works offline (except for the Claude call itself).
var CACHE = 'jarvis-v1';
var SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Network first so updates arrive, cache as the offline fallback.
  e.respondWith(fetch(req).then(function (res) {
    var copy = res.clone();
    caches.open(CACHE).then(function (c) { c.put(req, copy); });
    return res;
  }).catch(function () { return caches.match(req).then(function (hit) { return hit || caches.match('index.html'); }); }));
});
