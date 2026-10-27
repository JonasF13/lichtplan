// ─────────────────────────────────────────────────────────────
// Allgemeine Helfer: DOM, Mathe, Zeitzonen, Formatierung, Geo
// ─────────────────────────────────────────────────────────────

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export const uid = (p = '') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;
export const wrap360 = (a) => ((a % 360) + 360) % 360;
export const wrap180 = (a) => { const x = wrap360(a); return x > 180 ? x - 360 : x; };

export function debounce(fn, ms = 250) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function rafThrottle(fn) {
  let queued = false, lastArgs;
  return (...a) => { lastArgs = a; if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(...lastArgs); }); };
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// ── Zeitzonen ───────────────────────────────────────────────
export const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const partsCache = new Map();
function partsFmt(tz) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    partsCache.set(tz, f);
  }
  return f;
}
export function zonedParts(date, tz) {
  const o = {};
  for (const p of partsFmt(tz).formatToParts(date)) o[p.type] = p.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd };
}
export function tzOffsetMin(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}
/** Wanduhrzeit in Zeitzone tz → absoluter Zeitpunkt */
export function zonedToUtc(y, m, d, h = 0, mi = 0, tz = deviceTz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = tzOffsetMin(new Date(guess), tz);
  let t = guess - off * 60000;
  const off2 = tzOffsetMin(new Date(t), tz);
  if (off2 !== off) t = guess - off2 * 60000;
  return new Date(t);
}
export function startOfLocalDay(date, tz) {
  const p = zonedParts(date, tz);
  return zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
}
export function addLocalDays(date, n, tz) {
  const p = zonedParts(date, tz);
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), p.h, p.mi, tz);
}
export function dayKey(date, tz) {
  const p = zonedParts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
export function minutesOfDay(date, tz) {
  const p = zonedParts(date, tz);
  return p.h * 60 + p.mi;
}

// ── Formatierung ────────────────────────────────────────────
const fmtCache = new Map();
function fmt(tz, opts) {
  const k = tz + JSON.stringify(opts);
  let f = fmtCache.get(k);
  if (!f) { f = new Intl.DateTimeFormat('de-AT', { timeZone: tz, ...opts }); fmtCache.set(k, f); }
  return f;
}
/** Uhrzeit HH:MM – auf die volle Minute gerundet (wie Sun Surveyor/PhotoPills) */
export const fmtTime = (d, tz) => (d ? fmt(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Math.round(d.getTime() / 60000) * 60000)) : '–');
export const fmtTimeSec = (d, tz) => (d ? fmt(tz, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d) : '–');
export const fmtDate = (d, tz) => (d ? fmt(tz, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d) : '–');
export const fmtDateShort = (d, tz) => (d ? fmt(tz, { weekday: 'short', day: 'numeric', month: 'short' }).format(d) : '–');
export const fmtDateLong = (d, tz) => (d ? fmt(tz, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d) : '–');
export const fmtMonth = (d, tz) => fmt(tz, { month: 'long', year: 'numeric' }).format(d);
export function fmtDuration(ms) {
  if (ms == null || !isFinite(ms)) return '–';
  const m = Math.round(Math.abs(ms) / 60000);
  const h = Math.floor(m / 60), r = m % 60;
  return h ? `${h} h ${String(r).padStart(2, '0')} min` : `${r} min`;
}
export function fmtRel(ms) {
  const sign = ms < 0 ? 'vor ' : 'in ';
  return sign + fmtDuration(ms);
}
export function relTime(t) {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std.`;
  return `am ${new Date(t).toLocaleDateString('de-AT')}`;
}
export const fmtDeg = (x, digits = 0) => (x == null || !isFinite(x) ? '–' : `${x.toFixed(digits).replace('.', ',')}°`);
export const fmtNum = (x, digits = 1) => (x == null || !isFinite(x) ? '–' : x.toFixed(digits).replace('.', ','));
const DIRS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (az) => DIRS[Math.round(wrap360(az) / 22.5) % 16];
export const fmtAz = (az) => (az == null || !isFinite(az) ? '–' : `${Math.round(wrap360(az))}° ${compass(az)}`);
export function fmtDist(m) {
  if (m == null) return '–';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} km`;
}
export const fmtCoord = (lat, lng, n = 5) => `${lat.toFixed(n)}, ${lng.toFixed(n)}`;

// ── Geo ─────────────────────────────────────────────────────
const R_EARTH = 6371008.8;
export function distance(lat1, lng1, lat2, lng2) {
  const p1 = rad(lat1), p2 = rad(lat2), dp = rad(lat2 - lat1), dl = rad(lng2 - lng1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}
export function bearing(lat1, lng1, lat2, lng2) {
  const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lng2 - lng1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrap360(deg(Math.atan2(y, x)));
}
export function destination(lat, lng, brg, dist) {
  const d = dist / R_EARTH, b = rad(brg), p1 = rad(lat), l1 = rad(lng);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lng: ((deg(l2) + 540) % 360) - 180 };
}
/** scheinbarer Höhenwinkel zum Ziel inkl. Erdkrümmung & Refraktion (k=0.13) */
export function elevationAngle(h1, h2, dist) {
  if (!dist) return 0;
  const drop = (dist * dist) / (2 * R_EARTH) * (1 - 0.13);
  return deg(Math.atan2(h2 - h1 - drop, dist));
}

/** Koordinaten aus Text: "46.4, 13.7" · "(46,4085, 13,7226)" · DMS · Google-Maps-Links */
export function parseCoords(str) {
  if (!str) return null;
  let s = String(str).trim();
  const at = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || s.match(/[?&](?:q|ll|query|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (at) return valid(+at[1], +at[2]);
  s = s.replace(/^\(|\)$/g, '').trim();
  let m = s.match(/^(-?\d{1,3}[.,]\d+)\s*[,;]?\s+(-?\d{1,3}[.,]\d+)$/);
  if (m) return valid(+m[1].replace(',', '.'), +m[2].replace(',', '.'));
  m = s.match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (m) return valid(+m[1], +m[2]);
  const dms = /(\d{1,3})[°\s]+(\d{1,2})['′\s]+(\d{1,2}(?:[.,]\d+)?)?["″\s]*([NSEWOnsewo])/g;
  const parts = [...s.matchAll(dms)];
  if (parts.length === 2) {
    const conv = (p) => { let v = +p[1] + +p[2] / 60 + (+(p[3] || '0').replace(',', '.')) / 3600; if (/[SWsw]/.test(p[4])) v = -v; return { v, ax: /[NSns]/.test(p[4]) ? 'lat' : 'lng' }; };
    const a = conv(parts[0]), b = conv(parts[1]);
    const lat = a.ax === 'lat' ? a.v : b.v, lng = a.ax === 'lat' ? b.v : a.v;
    return valid(lat, lng);
  }
  return null;
  function valid(lat, lng) { return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null; }
}

// ── Farben / Lichtphasen ────────────────────────────────────
export const PHASES = [
  { key: 'night', min: -90, max: -18, label: 'Nacht', color: '#0b1020' },
  { key: 'astro', min: -18, max: -12, label: 'Astronomische Dämmerung', color: '#151d3b' },
  { key: 'naut', min: -12, max: -6, label: 'Nautische Dämmerung', color: '#233067' },
  { key: 'blue', min: -6, max: -4, label: 'Blaue Stunde', color: '#3557c9' },
  { key: 'golden', min: -4, max: 6, label: 'Goldene Stunde', color: '#ff9f43' },
  { key: 'day', min: 6, max: 91, label: 'Tag', color: '#ffe08a' },
];
export function phaseOf(sunAlt) {
  for (const p of PHASES) if (sunAlt >= p.min && sunAlt < p.max) return p;
  return PHASES[PHASES.length - 1];
}
export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ── Icons (Lucide-Stil, inline SVG) ─────────────────────────
const I = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  locate: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><path d="M9 4v14M15 6v14"/>',
  streetview: '<circle cx="12" cy="5" r="2.5"/><path d="M9 21v-6l-1-1V10a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v4l-1 1v6"/>',
  sky: '<path d="M3 18a9 9 0 0 1 18 0"/><path d="M2 18h20"/><circle cx="15" cy="10" r="1.5"/>',
  'bookmark-plus': '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/><path d="M12 7v6M9 10h6"/>',
  bookmark: '<path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  'moon-map': '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  mountain: '<path d="m3 20 6-10 4 6 3-4 5 8z"/>',
  satellite: '<path d="M13 7 9 3 5 7l4 4"/><path d="m17 11 4 4-4 4-4-4"/><path d="m8 12 4 4 6-6-4-4z"/><path d="M16 8l3-3"/><path d="M9 21a6 6 0 0 0-6-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  sunrise: '<path d="M12 2v6M5 10l1.4 1.4M2 18h20M19 10l-1.4 1.4M16 18a4 4 0 0 0-8 0M9 5l3-3 3 3"/>',
  sunset: '<path d="M12 9V3M5 10l1.4 1.4M2 18h20M19 10l-1.4 1.4M16 18a4 4 0 0 0-8 0M15 6l-3 3-3-3"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  galaxy: '<path d="M12 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0"/><path d="M4 16c3 2 9 2 13-2s4-9 1-11"/><path d="M20 8c-3-2-9-2-13 2s-4 9-1 11"/>',
  pin: '<path d="M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z"/><circle cx="12" cy="9" r="2.5"/>',
  grid: '<path d="M3 15h18M3 9h18M9 3v18M15 3v18"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  'chev-left': '<path d="m15 18-6-6 6-6"/>',
  'chev-right': '<path d="m9 18 6-6-6-6"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  now: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5h4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  layers: '<path d="m12 2 10 6-10 6L2 8z"/><path d="m2 16 10 6 10-6"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1.5"/>',
  shadow: '<path d="M12 3v12"/><path d="M12 15l8 5"/><circle cx="12" cy="3" r="1"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/><path d="M5 15l.6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  brain: '<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24A2.5 2.5 0 0 0 14.5 2z"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/>',
  wave: '<path d="M2 12c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0 2 1.5 2 1.5"/><path d="M2 18c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0 2 1.5 2 1.5"/><path d="M2 6c2-2.5 4-2.5 6 0s4 2.5 6 0 4-2.5 6 0"/>',
  sync: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/>',
};
export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[name] || ''}</svg>`;
}
export function hydrateIcons(root = document) {
  for (const n of root.querySelectorAll('[data-icon]')) {
    if (n.dataset.iconDone) continue;
    n.innerHTML = icon(n.dataset.icon) + n.innerHTML;
    n.dataset.iconDone = '1';
  }
}

export function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export function pickFile(accept) {
  return new Promise((res) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept;
    i.onchange = () => res(i.files[0] || null);
    i.click();
  });
}
