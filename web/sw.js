// App-shell cache only. /api/* is never touched (answers and book text must not be cached here).
const V = "medbook-shell-v28";
const SHELL = ["./", "index.html", "style.css", "app.js", "md.js", "id-guard.js", "tools.js", "eval-tools.js", "conv.js", "case.js", "case-model.js", "note-ui.js", "case-create.js", "create-ui.js", "note-assemble.js", "note-route.js", "note-types.js", "intake-ui.js", "extract-ui.js", "extract-model.js", "intake.js", "record-ui.js", "case-record.js", "case-course.js", "record-notes.js", "record-brief.js", "casebook-state.js", "casebook-guard.js", "casebook-packet.js", "casebook-ui.js", "draft-scenes.js", "date-relative.js", "flow-schema.js", "sim-case.js", "sim-engine.js", "sim-model.js", "sim-ui.js", "answer-marks.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-180.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // stale-while-revalidate: instant open on a phone, picks up new versions on the next launch
  e.respondWith(
    caches.open(V).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || net;
    }),
  );
});
