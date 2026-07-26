// Offline shell. Deliberately has no list of files to keep in sync: the cache is
// filled at runtime with whatever the app actually fetches, and thrown away
// wholesale whenever a new version deploys.
//
// __VERSION__ is replaced with the commit SHA by .github/workflows/pages.yml.
// It stays literal when serving locally, which just means the dev cache never
// self-invalidates — hard-reload if a local change seems not to land.
const CACHE = `gainz-__VERSION__`;

// The app shell is the only thing worth having before the first offline start;
// everything else arrives as it is requested.
const SHELL = ["./", "./index.html", "./style.css", "./manifest.webmanifest"];

self.addEventListener("install", (e) => {
  // Individual failures must not abort the install, or one 404 leaves the app
  // with no worker at all.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Only same-origin GETs are ours. GitHub and the model providers must always
  // hit the network — serving a stale day's log from cache would be a data bug,
  // not a performance win.
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  // A navigation to any in-scope URL is the app shell.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).catch(() => caches.match("./index.html").then((r) => r ?? Response.error())),
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        // Only real responses get cached; a 404 or an opaque cross-origin reply
        // would otherwise be served forever.
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      });
    }),
  );
});
