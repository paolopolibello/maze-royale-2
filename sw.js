const CACHE_NAME = 'maze-royale-2-v15';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './assets/loading-bg.jpg',
  './assets/bgm-egyptian.mp3',
  './vendor/three.module.js',
  './vendor/three.core.js',
  './vendor/peerjs.min.js',
  './js/config.js',
  './js/firebase-config.js',
  './js/maze.js',
  './js/collision.js',
  './js/visibility.js',
  './js/textures.js',
  './js/audio.js',
  './js/controls.js',
  './js/player.js',
  './js/entities.js',
  './js/rival-bot.js',
  './js/network.js',
  './js/main.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('maze-royale-2-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
