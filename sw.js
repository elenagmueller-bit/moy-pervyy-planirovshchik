const CACHE_NAME = "planner-shell-v6";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./js/main.js",
  "./js/config.js",
  "./js/date-utils.js",
  "./js/models.js",
  "./js/db.js",
  "./js/repositories.js",
  "./js/recurrence.js",
  "./js/state.js",
  "./js/router.js",
  "./js/ui.js",
  "./js/calendar-view.js",
  "./js/forms.js",
  "./js/search.js",
  "./js/google-auth.js",
  "./js/google-calendar.js",
  "./js/sync.js",
  "./js/backup.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("planner-shell-") && name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes("/tests/")) return;

  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("./index.html")));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    })),
  );
});
