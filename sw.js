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

// Reminders. The page writes a plan into its own cache; this file only reads it
// and rings. Both halves of the contract live in src/notify.ts — the shape
// below, the two cache names, and the wording — and are kept in step by hand,
// because a service worker cannot import from the compiled module tree.
const PLAN_CACHE = "gainz-plan";
const PLAN_URL = "./notification-plan";
const KINDS = ["weight", "nutrition"];
const TEXT = {
  weight: { title: "Weigh-in", body: "No weight logged today yet." },
  nutrition: { title: "Food log", body: "Today has not been ticked off as fully logged." },
};

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
      .then((keys) =>
        Promise.all(
          // The plan is data, not a copy of a file, so it outlives a deploy.
          keys.filter((k) => k !== CACHE && k !== PLAN_CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Chrome on Android wakes this for installed apps, on its own schedule and no
// more than a few times a day. Nowhere else fires it, which is why the page
// keeps its own timer for the case where it is open.
self.addEventListener("periodicsync", (e) => {
  if (e.tag === "gainz-reminders") e.waitUntil(checkReminders());
});

const pad = (n) => String(n).padStart(2, "0");
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const minutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

async function checkReminders() {
  const cache = await caches.open(PLAN_CACHE);
  const hit = await cache.match(PLAN_URL);
  if (!hit) return; // The app has not been opened since reminders were set up.
  const plan = await hit.json();

  const day = today();
  let changed = false;

  // A plan left over from an earlier day still carries the right settings, and
  // a day the app has not been opened on has by definition logged nothing —
  // which is exactly when the nudge is worth the most. So roll it forward
  // rather than giving up on it.
  if (plan.day !== day) {
    plan.day = day;
    for (const kind of KINDS) {
      plan[kind].done = false;
      delete plan[kind].notified;
    }
    changed = true;
  }

  const now = new Date();
  for (const kind of KINDS) {
    const slot = plan[kind];
    if (!slot.enabled || slot.done || slot.notified === day) continue;
    if (now.getHours() * 60 + now.getMinutes() < minutes(slot.time)) continue;
    await self.registration.showNotification(TEXT[kind].title, {
      body: TEXT[kind].body,
      tag: `gainz-${kind}`,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
    });
    slot.notified = day;
    changed = true;
  }

  if (changed) {
    await cache.put(
      PLAN_URL,
      new Response(JSON.stringify(plan), { headers: { "content-type": "application/json" } }),
    );
  }
}

// Tapping a reminder should land in the app that raised it, not a second copy.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) if ("focus" in c) return c.focus();
      return self.clients.openWindow("./");
    }),
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
