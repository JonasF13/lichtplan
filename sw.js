// Specula Service Worker – App offline verfügbar (Netzwerk zuerst, Cache als Fallback)
const CACHE = 'specula-v13';
const TILES = 'specula-tiles'; // Kartenkacheln bleiben über Updates hinweg erhalten
const SHELL = ['./', 'index.html', 'css/app.css', 'manifest.json', 'icons/icon.svg',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/astronomy.browser.min.js',
  'js/main.js', 'js/utils.js', 'js/astro.js', 'js/store.js', 'js/state.js', 'js/services.js', 'js/map.js',
  'js/timebar.js', 'js/panels.js', 'js/projects.js', 'js/streetview.js', 'js/sky.js', 'js/ui.js', 'js/ai/chat.js', 'js/ai/provider.js', 'js/ai/tools.js', 'js/ai/exif.js', 'js/sync.js', 'js/config.js', 'js/tides.js', 'js/placeinfo.js', 'js/placeview.js', 'js/focus.js', 'js/layout.js', 'js/ar.js', 'css/responsive.css', 'vendor/geomagnetism.esm.js', 'vendor/qrcode.esm.js',
  'js/pair.js', 'js/starsky.js', 'css/stars.css', 'js/importers/googlemaps.js',
  'data/sky/stars.json', 'data/sky/starnames.json', 'data/sky/milkyway.json', 'data/sky/constlines.json', 'data/sky/constnames.json'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    // Update (es gab schon eine ältere Version) oder allererste Installation?
    const isUpdate = ks.some((k) => /^(specula|lichtplan)-v\d+$/.test(k) && k !== CACHE);
    await Promise.all(ks.filter((k) => k !== CACHE && k !== TILES).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Nur bei einem Update alle offenen Fenster auf die neue Version bringen (alte Fenster könnten sonst
    // Einstellungen überschreiben). Beim ersten Öffnen NICHT neu laden – sonst gehen offene Dialoge verloren.
    if (isUpdate) {
      const cs = await self.clients.matchAll({ type: 'window' });
      await Promise.all(cs.map((c) => c.navigate(c.url.replace(/#.*$/, '')).catch(() => null)));
    }
  })());
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Nur unsere Karten-Kacheln zwischenspeichern – niemals Google (Street View braucht frische, CORS-fähige Antworten)
  const isTile = /(^|\.)(arcgisonline\.com|tile\.openstreetmap\.org|tile\.opentopomap\.org)$/.test(url.hostname);
  if (url.pathname.endsWith('/setup.json')) return; // Einrichtungsdatei nie zwischenspeichern
  if (url.origin === location.origin) {
    const fresh = e.request.mode === 'navigate' ? new Request(e.request.url, { cache: 'no-cache' }) : new Request(e.request, { cache: 'no-cache' });
    e.respondWith(fetch(fresh).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then((ca) => ca.put(e.request, c)); } return r; }).catch(() => caches.match(e.request)));
  } else if (isTile) {
    // Kartenkacheln: Cache zuerst (für Offline-Nutzung bereits besuchter Gebiete)
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request); if (hit) return hit;
      try { const r = await fetch(e.request); if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; } catch { return hit || Response.error(); }
    }));
  }
});
