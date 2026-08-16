// Version du cache — on l'incrémente à chaque changement important
// pour forcer les téléphones à récupérer la nouvelle version.
const CACHE_NAME = "poincon-v3";

const APP_SHELL = [
  "/",
  "/index.html",
  "/css/styles.css",
  "/js/offline.js",
  "/js/app.js",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Strategie "reseau d'abord" : la version la plus recente du site est toujours
// utilisee quand la connexion est disponible. Le cache ne sert que de secours
// hors ligne (et pour un chargement plus rapide au demarrage).
// Les appels /api/ ne sont JAMAIS mis en cache : les donnees (clients,
// pointages, reglages, semaine) doivent toujours venir de la base en direct.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.url.includes("/api/")) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
