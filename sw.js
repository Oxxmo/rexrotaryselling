/* Rex Seller — service worker (mode hors-ligne) */
const CACHE = "rexseller-v42";
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
  "./js/pilotage.js",
  "./js/commando-icones.js",
  "./js/commando-core.js",
  "./js/commando-semaine.js",
  "./js/commando.js",
  "./js/commando-console.js",
  "./js/commando-dashboard.js",
  "./js/commando-ligue.js",
  "./js/commando-vote.js",
  "./js/commando-notifs.js",
  "./js/fdr.js",
  "./css/fdr.css",
  "./css/commando.css",
  "./js/supa.js",
  "./manifest.webmanifest",
  "./assets/icon.svg",
  "./assets/notif-192.png",
  "./assets/notif-badge.png",
  "./assets/logo-white.png",
  "./assets/logo-red.png",
  "./assets/fonts/manrope-latin.woff2",
  "./assets/fonts/manrope-latin-ext.woff2"
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
    // « reload » : on court-circuite le cache HTTP du navigateur, qui pouvait
    // renvoyer un fichier périmé (page à jour mais script ancien) après une
    // mise à jour. On garde le cache comme secours hors ligne.
    fetch(e.request.url, { cache: "reload", credentials: "same-origin" }).then((resp) => {
      const copy = resp.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return resp;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

// Notifications Rex Commando (Web Push) : RDV de l'équipe, vote, listes prêtes.
// Le serveur envoie un JSON { title, body, url, tag }.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Rex Commando", {
    body: d.body || "",
    icon: "./assets/notif-192.png",
    badge: "./assets/notif-badge.png",
    tag: d.tag || undefined,
    data: { url: d.url || "./#commando" },
  }));
});

// Clic : on rouvre l'app déjà ouverte sur le bon onglet, sinon on l'ouvre.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const cible = new URL((e.notification.data && e.notification.data.url) || "./#commando", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((fenetres) => {
    const f = fenetres.find((c) => c.url.startsWith(self.registration.scope));
    if (f) {
      f.postMessage({ type: "commando-ouvrir", url: cible });
      return f.focus();
    }
    return self.clients.openWindow(cible);
  }));
});
