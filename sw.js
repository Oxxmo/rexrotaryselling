/* Rex Seller — service worker (mode hors-ligne) */
const CACHE = "rexseller-v14";
const ASSETS = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/config.js",
  "./js/vendor/supabase.js",
  "./js/data.js",
  "./js/offline.js",
  "./js/app.js",
  "./js/admin.js",
  "./js/tickets.js",
  "./js/supa.js",
  "./manifest.webmanifest",
  "./assets/icon.svg",
  "./assets/logo-white.png",
  "./assets/logo-red.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Réseau d'abord, cache en secours — les mises à jour arrivent immédiatement
// quand il y a du réseau ; l'app reste utilisable hors connexion.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  // Ne jamais intercepter les requêtes cross-origin (API Supabase, CDN) :
  // l'authentification et l'accès aux données doivent toujours passer par
  // le réseau, sans mise en cache.
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
