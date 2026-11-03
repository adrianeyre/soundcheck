/*
 * The Browser Version used to be served from this folder, and registered
 * coi-serviceworker here to make the page cross-origin isolated. It now lives
 * in `app/` and registers its own there (ADR 0017). A browser that visited
 * before keeps the old worker, which would put the website under COEP too, so
 * this file replaces it with one that unregisters itself and reloads the
 * pages it controlled once, without it.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.registration
      .unregister()
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url)))),
  );
});
