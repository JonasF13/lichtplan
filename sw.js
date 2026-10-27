// Lichtplan Service Worker – App offline verfügbar (Netzwerk zuerst, Cache als Fallback)
const CACHE = 'lichtplan-v5';
const SHELL = ['./', 'index.html', 'css/app.css', 'manifest.json', 'icons/icon.svg',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/astronomy.browser.min.js',
  'js/main.js', 'js/utils.js', 'js/astro.js', 'js/store.js', 'js/state.js', 'js/services.js', 'js/map.js',
  'js/timebar.js', 'js/panels.js', 'js/projects.js', 'js/streetview.js', 'js/sky.js', 'js/ui.js', 'js/ai/chat.js', 'js/ai/provider.js', 'js/ai/tools.js', 'js/ai/exif.js', 'js/sync.js', 'js/config.js', 'vendor/qrcode.esm.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isTile = /tile|basemaps|arcgisonline/.test(url.hostname + url.pathname);
  if (url.origin === location.origin) {
    const fresh = e.request.mode === 'navigate' ? new Request(e.request.url, { cache: 'no-cache' }) : new Request(e.request, { cache: 'no-cache' });
    e.respondWith(fetch(fresh).then((r) => { const c = r.clone(); caches.open(CACHE).then((ca) => ca.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
  } else if (isTile) {
    // Kartenkacheln: Cache zuerst (für Offline-Nutzung bereits besuchter Gebiete)
    e.respondWith(caches.open(CACHE + '-tiles').then(async (c) => {
      const hit = await c.match(e.request); if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; } catch { return hit || Response.error(); }
    }));
  }
});
