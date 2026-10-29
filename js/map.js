// ─────────────────────────────────────────────────────────────
// Karte (Leaflet) + Kompass-Overlay mit Sonnen-/Mondbahnen
// ─────────────────────────────────────────────────────────────
import { state, setState, onState } from './state.js';
import { store, prefs } from './store.js';
import { getDay, sunPos, moonPos, gcPos } from './astro.js';
import { popupContent, setParkingHandler } from './placeview.js';
import { layerOn, mwNight, getFocus } from './focus.js';
import { $, $$, rad, fmtTime, fmtAz, fmtDist, distance, bearing, rafThrottle, esc, icon } from './utils.js';

const L = window.L;
let map, locMarker, targetMarker, targetLine, spotLayer, baseLayer, labelLayer;
let canvas, ctx;

const STYLES = {
  dark: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', opts: { maxZoom: 19, maxNativeZoom: 16, attribution: '© Esri, HERE, Garmin, © OpenStreetMap' },
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}' },
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', opts: { maxZoom: 19, attribution: '© OpenStreetMap' } },
  topo: { url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', opts: { subdomains: 'abc', maxZoom: 17, attribution: '© OpenStreetMap, SRTM, © OpenTopoMap' } },
  sat: { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', opts: { maxZoom: 19, attribution: '© Esri, Maxar, Earthstar' } },
};

export const COLORS = {
  sunrise: '#ffd166', sunset: '#ff7b54', sun: '#ffe066', golden: '#ff9f43', blue: '#5b8cff',
  moonrise: '#a5d8ff', moonset: '#7aa2d6', moon: '#f1f3f5', milky: '#c792ea', target: '#2ee59d',
};

let parkLayer, onDetails;
export function initMap({ onSpotClick, onContext, onSpotDetails }) {
  onDetails = onSpotDetails;
  const last = prefs.get('last');
  map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true, zoomSnap: 0.5 })
    .setView([state.lat, state.lng], last?.zoom ?? 13);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  setStyle(prefs.get('mapStyle'));

  locMarker = L.marker([state.lat, state.lng], {
    draggable: true, zIndexOffset: 1000, keyboard: false,
    icon: L.divIcon({ className: 'loc-pin', html: '<div class="pin-core"></div><div class="pin-pulse"></div>', iconSize: [26, 26], iconAnchor: [13, 13] }),
  }).addTo(map);
  locMarker.on('drag', (e) => { const p = e.target.getLatLng(); setState({ lat: p.lat, lng: p.lng, activeSpotId: null }); });
  locMarker.on('dragend', () => setState({ placeName: '' }));

  targetMarker = L.marker([0, 0], {
    draggable: true, zIndexOffset: 900, keyboard: false,
    icon: L.divIcon({ className: 'target-pin', html: icon('target'), iconSize: [30, 30], iconAnchor: [15, 15] }),
  });
  targetMarker.on('drag', (e) => { const p = e.target.getLatLng(); setState({ target: { lat: p.lat, lng: p.lng, elev: null } }); });

  spotLayer = L.layerGroup().addTo(map);
  parkLayer = L.layerGroup().addTo(map);
  setParkingHandler((list, spot) => {
    parkLayer.clearLayers();
    list.forEach((p) => L.marker([p.lat, p.lng], { icon: L.divIcon({ className: 'park-pin', html: '<b>P</b>', iconSize: [22, 22], iconAnchor: [11, 11] }) })
      .bindTooltip(`${esc(p.name || 'Parkplatz')}${p.fee ? ' · ' + p.fee : ''}`, { direction: 'top', className: 'lp-tip' }).addTo(parkLayer));
    fitSpots([spot, ...list]);
  });
  renderSpots(onSpotClick);
  store.subscribe(() => renderSpots(onSpotClick));

  map.on('click', (e) => {
    $('#ctx-menu').classList.add('hidden');
    if (state.targetMode) { setState({ target: { lat: e.latlng.lat, lng: e.latlng.lng, elev: null }, targetMode: false }); return; }
    setState({ lat: e.latlng.lat, lng: e.latlng.lng, placeName: '', activeSpotId: null });
  });
  map.on('contextmenu', (e) => onContext(e.latlng, e.containerPoint));
  map.on('moveend', () => { const l = prefs.get('last') || {}; prefs.set('last', { ...l, zoom: map.getZoom() }); });

  canvas = $('#map-overlay');
  // Kompass in eigene Kartenebene: über den Kacheln, unter Markierungen und Vorschaufenstern
  const pane = map.createPane('lpCompass');
  pane.style.zIndex = 450; pane.style.pointerEvents = 'none';
  pane.appendChild(canvas);
  ctx = canvas.getContext('2d');
  const redraw = rafThrottle(draw);
  map.on('move zoom resize viewreset zoomanim', redraw);
  new ResizeObserver(() => { map.invalidateSize(); redraw(); applyPendingView(); }).observe($('#view-map'));
  window.addEventListener('lp-focus', redraw);

  onState((ch) => {
    if (ch.has('lat') || ch.has('lng')) locMarker.setLatLng([state.lat, state.lng]);
    if (ch.has('target')) updateTarget();
    if (ch.has('targetMode')) $('#map').classList.toggle('crosshair', state.targetMode);
    if (ch.has('activeProjectId')) renderSpots(onSpotClick);
    redraw();
  });

  // Toolbar
  $$('#map-tools [data-style]').forEach((b) => b.addEventListener('click', () => setStyle(b.dataset.style)));
  const layers = prefs.get('layers');
  $$('#map-tools [data-layer]').forEach((b) => {
    b.classList.toggle('on', !!layers[b.dataset.layer]);
    b.addEventListener('click', () => {
      const l = { ...prefs.get('layers') }; l[b.dataset.layer] = !l[b.dataset.layer]; prefs.set('layers', l);
      b.classList.toggle('on', l[b.dataset.layer]);
      if (b.dataset.layer === 'spots') renderSpots(onSpotClick);
      redraw();
    });
  });
  draw();
  return map;
}

export function setStyle(key) {
  if (!STYLES[key]) key = 'dark';
  prefs.set('mapStyle', key);
  if (baseLayer) map.removeLayer(baseLayer);
  if (labelLayer) { map.removeLayer(labelLayer); labelLayer = null; }
  baseLayer = L.tileLayer(STYLES[key].url, { ...STYLES[key].opts }).addTo(map);
  if (STYLES[key].labels) labelLayer = L.tileLayer(STYLES[key].labels, { maxZoom: 19, maxNativeZoom: 16, pane: 'overlayPane', opacity: 0.9 }).addTo(map);
  document.body.dataset.mapstyle = key;
  $$('#map-tools [data-style]').forEach((b) => b.classList.toggle('on', b.dataset.style === key));
}

// Ist die Karte gerade unsichtbar (Handy: anderer Bildschirm), wird das Ziel gemerkt
// und beim nächsten Anzeigen ohne Animation angesprungen – sonst rechnet Leaflet mit Größe 0.
let pendingView = null;
const mapHidden = () => { const c = map.getContainer(); return !c.offsetWidth || !c.offsetHeight; };
function applyPendingView() {
  if (!pendingView || mapHidden()) return;
  const f = pendingView; pendingView = null;
  map.invalidateSize(); f();
}
export function flyTo(lat, lng, zoom) {
  const z = zoom ?? Math.max(map.getZoom(), 14);
  if (mapHidden()) { pendingView = () => map.setView([lat, lng], z, { animate: false }); return; }
  pendingView = null;
  map.flyTo([lat, lng], z, { duration: 0.8 });
}
export function fitSpots(spots) {
  if (!spots.length) return;
  if (spots.length === 1) return flyTo(spots[0].lat, spots[0].lng, 15);
  const b = L.latLngBounds(spots.map((s) => [s.lat, s.lng])).pad(0.2);
  if (mapHidden()) { pendingView = () => map.fitBounds(b, { maxZoom: 15, animate: false }); return; }
  pendingView = null;
  map.flyToBounds(b, { duration: 0.8, maxZoom: 15 });
}
export const getMap = () => map;

function updateTarget() {
  if (state.target) {
    targetMarker.setLatLng([state.target.lat, state.target.lng]);
    if (!map.hasLayer(targetMarker)) targetMarker.addTo(map);
  } else if (map.hasLayer(targetMarker)) map.removeLayer(targetMarker);
}

let popupSpotId = null;
function renderSpots(onSpotClick) {
  const keep = popupSpotId; // offenes Vorschaufenster nach dem Neuzeichnen wieder öffnen
  spotLayer.clearLayers();
  popupSpotId = keep;
  if (!prefs.get('layers').spots) return;
  for (const s of store.spots) {
    const p = s.projectId ? store.project(s.projectId) : null;
    if (p?.archived) continue;
    const dim = state.activeProjectId && s.projectId !== state.activeProjectId;
    const color = p?.color || '#c8d6e5';
    const m = L.marker([s.lat, s.lng], {
      keyboard: false, zIndexOffset: dim ? 0 : 500, opacity: dim ? 0.45 : 1,
      icon: L.divIcon({ className: 'spot-pin', html: `<div style="--c:${color}" class="${s.status === 'erledigt' ? 'done' : ''}">${s.rating >= 4 ? '★' : ''}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
    });
    m.bindTooltip(`<b>${esc(s.name)}</b>${p ? `<br><span style="color:${color}">${esc(p.name)}</span>` : ''}`, { direction: 'top', offset: [0, -8], className: 'lp-tip' });
    m.bindPopup(() => popupContent(s, p, { onOpen: () => { m.closePopup(); onDetails ? onDetails(s.id) : onSpotClick(s.id); } }), { className: 'lp-popup', maxWidth: 290, minWidth: 260, autoPanPaddingTopLeft: [20, 90], autoPanPaddingBottomRight: [20, 200] });
    m.on('click', (e) => { L.DomEvent.stopPropagation(e); parkLayer.clearLayers(); popupSpotId = s.id; onSpotClick(s.id); });
    m.on('popupclose', () => { setTimeout(() => { if (popupSpotId === s.id && !spotLayer.hasLayer(m)) return; if (popupSpotId === s.id && !m.isPopupOpen()) popupSpotId = null; }, 0); });
    spotLayer.addLayer(m);
    if (keep === s.id) setTimeout(() => m.openPopup(), 0);
  }
}

// ── Overlay-Zeichnung ───────────────────────────────────────
function draw() {
  const box = $('#view-map').getBoundingClientRect();
  if (map) L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0])); // fest am Bildschirm, trotz Verschieben der Ebene
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(box.width * dpr) || canvas.height !== Math.round(box.height * dpr)) {
    canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
    canvas.style.width = box.width + 'px'; canvas.style.height = box.height + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  if (!map) return;

  const L_ = { sun: layerOn('sun'), moon: layerOn('moon'), milky: layerOn('milky') };
  const c = map.latLngToContainerPoint([state.lat, state.lng]);
  const R = Math.max(90, Math.min(box.width, box.height) * 0.3);
  const day = getDay(state.lat, state.lng, state.elev, state.tz, state.time);
  const obs = day.obs;
  const P = (az, alt) => { const r = R * (90 - Math.max(alt, 0)) / 90; return [c.x + r * Math.sin(rad(az)), c.y - r * Math.cos(rad(az))]; };
  const sat = document.body.dataset.mapstyle === 'sat' || document.body.dataset.mapstyle === 'dark';
  const ink = sat ? 'rgba(255,255,255,' : 'rgba(20,24,35,';

  // Kompassring
  ctx.save();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = ink + '0.55)';
  ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([2, 5]); ctx.strokeStyle = ink + '0.25)';
  for (const a of [30, 60]) { ctx.beginPath(); ctx.arc(c.x, c.y, R * (90 - a) / 90, 0, Math.PI * 2); ctx.stroke(); }
  ctx.setLineDash([]);
  for (let a = 0; a < 360; a += 5) {
    const long = a % 45 === 0, mid = a % 15 === 0;
    const r1 = R, r2 = R + (long ? 12 : mid ? 7 : 4);
    ctx.strokeStyle = ink + (long ? '0.85)' : '0.45)');
    ctx.lineWidth = long ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(c.x + r1 * Math.sin(rad(a)), c.y - r1 * Math.cos(rad(a)));
    ctx.lineTo(c.x + r2 * Math.sin(rad(a)), c.y - r2 * Math.cos(rad(a)));
    ctx.stroke();
  }
  ctx.font = '600 12px -apple-system, "SF Pro Text", Inter, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  [['N', 0], ['O', 90], ['S', 180], ['W', 270]].forEach(([t, a]) => {
    const r = R + 24; pill(t, c.x + r * Math.sin(rad(a)), c.y - r * Math.cos(rad(a)), t === 'N' ? '#ff6b6b' : ink + '0.9)', sat);
  });
  ctx.restore();

  const ray = (az, color, width, dash, extend = true) => {
    const [x, y] = [c.x + R * Math.sin(rad(az)), c.y - R * Math.cos(rad(az))];
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(x, y); ctx.stroke();
    if (extend) {
      ctx.globalAlpha = 0.35; ctx.lineWidth = Math.max(1, width - 1);
      const far = 4000;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(c.x + far * Math.sin(rad(az)), c.y - far * Math.cos(rad(az))); ctx.stroke();
    }
    ctx.restore();
    return [x, y];
  };
  const label = (az, text, color, offset = 0) => {
    const r = R + 46 + offset;
    pill(text, c.x + r * Math.sin(rad(az)), c.y - r * Math.cos(rad(az)), color, true, true);
  };

  // Tagesbogen der Sonne
  if (L_.sun) {
    drawPath(day.sunPath, P, (p) => (p.alt < 6 ? COLORS.golden : COLORS.sun), 3.5);
    // Stundenmarken
    ctx.save();
    ctx.font = '600 10px -apple-system, Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    day.sunPath.forEach((p, i) => {
      if (p.alt < 0 || i % 6 !== 0) return;
      const [x, y] = P(p.az, p.alt);
      ctx.fillStyle = '#1b1405'; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = COLORS.sun; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
      const dx = x - c.x, dy = y - c.y, dl = Math.hypot(dx, dy) || 1;
      ctx.fillStyle = 'rgba(255,240,200,.95)';
      ctx.fillText(fmtTime(p.t, state.tz).slice(0, 2), x - (dx / dl) * 12, y - (dy / dl) * 12);
    });
    ctx.restore();
    if (day.sun.riseAz != null) { ray(day.sun.riseAz, COLORS.sunrise, 3); label(day.sun.riseAz, `↑ ${fmtTime(day.sun.rise, state.tz)}`, COLORS.sunrise); }
    if (day.sun.setAz != null) { ray(day.sun.setAz, COLORS.sunset, 3); label(day.sun.setAz, `↓ ${fmtTime(day.sun.set, state.tz)}`, COLORS.sunset); }
  }
  if (L_.moon) {
    drawPath(day.moonPath, P, () => 'rgba(190,220,255,.85)', 2, [5, 4]);
    if (day.moon.riseAz != null) { ray(day.moon.riseAz, COLORS.moonrise, 2.2, [7, 5]); label(day.moon.riseAz, `☾↑ ${fmtTime(day.moon.rise, state.tz)}`, COLORS.moonrise, 26); }
    if (day.moon.setAz != null) { ray(day.moon.setAz, COLORS.moonset, 2.2, [7, 5]); label(day.moon.setAz, `☾↓ ${fmtTime(day.moon.set, state.tz)}`, COLORS.moonset, 26); }
  }
  if (L_.milky) {
    const s = sunPos(state.time, obs);
    const focusMw = getFocus() === 'milky';
    drawPath(day.gcPath.filter((p) => true), P, (p) => hexAlpha(COLORS.milky, sunAltAt(day, p.t) < -12 ? 0.9 : 0.25), focusMw ? 3.5 : 2.5, [2, 4]);
    if (focusMw) {
      // Auf-/Untergang des Kerns + beste Zeit hervorheben
      const pts = day.gcPath;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        if ((a.alt < 0) !== (b.alt < 0)) {
          const f = a.alt / (a.alt - b.alt), az = a.az + ((((b.az - a.az) + 540) % 360) - 180) * f;
          const t = new Date(a.t.getTime() + (b.t - a.t) * f), up = b.alt > a.alt;
          ray(az, hexAlpha(COLORS.milky, 0.85), 2.4, [7, 5]);
          label(az, `✦${up ? '↑' : '↓'} ${fmtTime(t, state.tz)}`, COLORS.milky, 8);
        }
      }
      const n = mwNight(state.lat, state.lng, state.elev, state.tz, state.time);
      if (n.best) {
        ray(n.best.az, COLORS.milky, 3.5, []);
        const [x, y] = P(n.best.az, n.best.alt); glow(x, y, 9, COLORS.milky);
        label(n.best.az, `★ beste Zeit ${fmtTime(n.best.t, state.tz)}`, COLORS.milky, 34);
      }
    }
    const g = gcPos(state.time, obs);
    if (g.alt > 0) {
      ray(g.az, s.alt < -12 ? COLORS.milky : hexAlpha(COLORS.milky, 0.4), 2.5, [3, 4], true);
      const [x, y] = P(g.az, g.alt); glow(x, y, 7, COLORS.milky);
    }
  }

  // aktuelle Positionen
  if (L_.moon) {
    const m = moonPos(state.time, obs);
    ray(m.az, m.alt > 0 ? COLORS.moon : 'rgba(241,243,245,.35)', 2, m.alt > 0 ? [] : [3, 4], m.alt > 0);
    if (m.alt > 0) { const [x, y] = P(m.az, m.alt); moonDisc(x, y, 8, m.illum, m.waxing); }
  }
  if (L_.sun) {
    const s = sunPos(state.time, obs);
    ray(s.az, s.alt > 0 ? '#fff3a3' : 'rgba(255,243,163,.35)', 2.5, s.alt > 0 ? [] : [3, 4], s.alt > 0);
    if (s.alt > -1) { const [x, y] = P(s.az, s.alt); glow(x, y, 9, s.alt < 6 ? COLORS.golden : COLORS.sun); }
  }

  // Ziel
  if (state.target) {
    const tp = map.latLngToContainerPoint([state.target.lat, state.target.lng]);
    ctx.save();
    ctx.strokeStyle = COLORS.target; ctx.lineWidth = 2.5; ctx.setLineDash([8, 6]);
    ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(tp.x, tp.y); ctx.stroke();
    ctx.restore();
    const d = distance(state.lat, state.lng, state.target.lat, state.target.lng);
    const b = bearing(state.lat, state.lng, state.target.lat, state.target.lng);
    const mx = (c.x + tp.x) / 2, my = (c.y + tp.y) / 2;
    const onScreen = tp.x > 0 && tp.y > 0 && tp.x < box.width && tp.y < box.height;
    ctx.font = '600 12px -apple-system, Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    pill(`${fmtDist(d)} · ${fmtAz(b)}`, onScreen ? mx : c.x, onScreen ? my : c.y + 26, COLORS.target, true, true);
  }

  // Legende aktualisieren
  updateLegend(day);

  function drawPath(points, proj, colorFn, width, dash) {
    ctx.save();
    ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.setLineDash(dash || []);
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = 3;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (a.alt < 0 && b.alt < 0) continue;
      const [x1, y1] = proj(a.az, a.alt), [x2, y2] = proj(b.az, b.alt);
      ctx.strokeStyle = colorFn(b);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.restore();
  }
  function glow(x, y, r, color) {
    ctx.save();
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.6);
    g.addColorStop(0, color); g.addColorStop(0.35, hexAlpha(color, 0.6)); g.addColorStop(1, hexAlpha(color, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function moonDisc(x, y, r, illum, waxing) { drawMoon(ctx, x, y, r, illum, waxing); }
  function pill(text, x, y, color, dark, small) {
    ctx.save();
    ctx.font = `600 ${small ? 11 : 12}px -apple-system, "SF Pro Text", Inter, sans-serif`;
    const w = ctx.measureText(text).width + 12, h = small ? 18 : 20;
    ctx.fillStyle = 'rgba(12,16,26,.78)';
    roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2); ctx.fill();
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }
}

function sunAltAt(day, t) {
  const i = Math.round((t - day.start) / 600000);
  return day.sunPath[Math.max(0, Math.min(day.sunPath.length - 1, i))].alt;
}
export function hexAlpha(hex, a) {
  if (!hex.startsWith('#')) return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
/** Mondscheibe mit Phase (beleuchteter Teil) */
export function drawMoon(ctx, x, y, r, illum, waxing) {
  ctx.save();
  ctx.shadowColor = 'rgba(200,220,255,.8)'; ctx.shadowBlur = r * 1.4;
  ctx.fillStyle = '#2a3142'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#f4f1e6';
  const k = 1 - 2 * illum; // Terminator-Ellipse: +1 neu … −1 voll
  ctx.beginPath();
  const dir = waxing ? 1 : -1; // zunehmend: rechts beleuchtet (Nordhalbkugel)
  ctx.arc(x, y, r, -Math.PI / 2, Math.PI / 2, dir < 0);
  ctx.ellipse(x, y, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, (k > 0) === (dir > 0));
  ctx.fill();
  ctx.restore();
}

function updateLegend(day) {
  const lg = $('#map-legend');
  const L_ = { sun: layerOn('sun'), moon: layerOn('moon'), milky: layerOn('milky') };
  const s = sunPos(state.time, day.obs), m = moonPos(state.time, day.obs);
  const rows = [];
  if (L_.sun) {
    rows.push(`<div class="lg-row"><i style="background:${COLORS.sunrise}"></i><span class="l">Aufgang</span><b>${fmtTime(day.sun.rise, state.tz)}</b><span>${fmtAz(day.sun.riseAz)}</span></div>`);
    rows.push(`<div class="lg-row"><i style="background:${COLORS.sunset}"></i><span class="l">Untergang</span><b>${fmtTime(day.sun.set, state.tz)}</b><span>${fmtAz(day.sun.setAz)}</span></div>`);
    rows.push(`<div class="lg-row"><i style="background:#fff3a3"></i><span class="l">Sonne jetzt</span><b>${s.alt.toFixed(1).replace('.', ',')}°</b><span>${fmtAz(s.az)}</span></div>`);
  }
  if (L_.moon) {
    rows.push(`<div class="lg-row"><i style="background:${COLORS.moonrise}"></i><span class="l">Mond ↑</span><b>${fmtTime(day.moon.rise, state.tz)}</b><span>${fmtAz(day.moon.riseAz)}</span></div>`);
    rows.push(`<div class="lg-row"><i style="background:${COLORS.moonset}"></i><span class="l">Mond ↓</span><b>${fmtTime(day.moon.set, state.tz)}</b><span>${fmtAz(day.moon.setAz)}</span></div>`);
    rows.push(`<div class="lg-row"><i style="background:${COLORS.moon}"></i><span class="l">Mond jetzt</span><b>${m.alt.toFixed(1).replace('.', ',')}°</b><span>${Math.round(m.illum * 100)} % · ${fmtAz(m.az)}</span></div>`);
  }
  if (L_.milky) {
    const g = gcPos(state.time, day.obs);
    rows.push(`<div class="lg-row"><i style="background:${COLORS.milky}"></i><span class="l">Milchstraßen-Kern</span><b>${g.alt.toFixed(1).replace('.', ',')}°</b><span>${fmtAz(g.az)}</span></div>`);
  }
  lg.innerHTML = rows.join('');
  lg.classList.toggle('hidden', !rows.length);
}
