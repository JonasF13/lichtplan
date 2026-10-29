// ─────────────────────────────────────────────────────────────
// Sterne: Planetarium + wiederverwendbarer Himmels-Renderer
// ─────────────────────────────────────────────────────────────
// API
//   loadSky()                                   → Promise<Sky>  (einmal laden, gecached)
//   skyFrame(date, lat, lng, elevMeters)        → { toHor(vec), fromHor(az, alt), horVec(vec), m, observer }
//   skyBodies(date, lat, lng, elevMeters)       → { sun, moon, planets[] }  (J2000-Vektoren, mag …)
//   drawSky(ctx, opts)                          → zeichnet in beliebige Projektion, liefert eine „Szene“
//   pickSky(scene, x, y)                        → nächstes Objekt an einer Bildschirmposition
//   initStarView({ canvas, getTime, getLocation, setTime, onPick }) → Planetarium-Controller
//
// Koordinaten: Sterndaten J2000 (EQJ, x → RA 0h, z → Himmelsnordpol).
// Horizont-System (astronomy-engine Rotation_EQJ_HOR, empirisch geprüft):
//   x = Nord, y = West, z = Zenit  →  Azimut = atan2(−y, x)  (0° N, 90° O, 180° S, 270° W)
// ─────────────────────────────────────────────────────────────
import { clamp, wrap360, wrap180, esc, el, icon, fmtTime, fmtDeg, fmtAz, fmtDateShort } from './utils.js';

const AE = () => {
  const A = window.Astronomy;
  if (!A) throw new Error('astronomy-engine (window.Astronomy) fehlt – vendor/astronomy.browser.min.js vorher laden');
  return A;
};
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif';
const VIOLET = '#c792ea';
const D2R = Math.PI / 180, R2D = 180 / Math.PI, TAU = Math.PI * 2;
const GC_RA = (17 + 45 / 60 + 40 / 3600) * 15, GC_DEC = -(29 + 0 / 60 + 28 / 3600); // Sgr A*, J2000
const POLARIS = 11767;
const DATA_URL = new URL('../data/sky/', import.meta.url);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ── Vektoren ────────────────────────────────────────────────
function radecVec(raDeg, decDeg, out = [0, 0, 0], o = 0) {
  const r = raDeg * D2R, d = decDeg * D2R, cd = Math.cos(d);
  out[o] = cd * Math.cos(r); out[o + 1] = cd * Math.sin(r); out[o + 2] = Math.sin(d);
  return out;
}
/** RA/Dec (Grad, J2000) → Einheitsvektor [x, y, z] */
export const raDecToVec = (raDeg, decDeg) => radecVec(raDeg, decDeg);
const vecRaDec = (v) => ({ ra: wrap360(Math.atan2(v[1], v[0]) * R2D), dec: Math.asin(clamp(v[2], -1, 1)) * R2D });
const horAz = (x, y) => wrap360(Math.atan2(-y, x) * R2D);
/** Azimut/Höhe (Grad) → HOR-Einheitsvektor (x = N, y = W, z = Zenit) */
export function azAltToHor(az, alt) {
  const a = az * D2R, h = alt * D2R, ch = Math.cos(h);
  return [ch * Math.cos(a), -ch * Math.sin(a), Math.sin(h)];
}
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; };

/** Refraktion in Grad für eine wahre Höhe – identisch zu astronomy-engine 'normal' */
export function refraction(altDeg) {
  if (!(altDeg >= -90 && altDeg <= 90)) return 0;
  const hd = Math.max(altDeg, -1);
  let r = 1.02 / Math.tan((hd + 10.3 / (hd + 5.11)) * D2R) / 60;
  if (altDeg < -1) r *= (altDeg + 90) / 89;
  return r;
}
// Refraktion auf einen HOR-Vektor (in place) – nur in Horizontnähe relevant (> 30° < 1,7′)
function refractInPlace(v) {
  const z = v[2];
  if (z > 0.5 || z < -0.25) return;
  const alt = Math.asin(z) * R2D, a2 = (alt + refraction(alt)) * D2R;
  const c = Math.cos(a2) / Math.sqrt(Math.max(1e-12, 1 - z * z));
  v[0] *= c; v[1] *= c; v[2] = Math.sin(a2);
}

// ── Daten ───────────────────────────────────────────────────
let SKY = null, skyPromise = null;
/** Lädt die Himmelsdaten (data/sky/*.json) einmalig; Positionen als J2000-Einheitsvektoren vorberechnet. */
export function loadSky() {
  if (SKY) return Promise.resolve(SKY);
  if (!skyPromise) {
    const get = (f) => fetch(new URL(f, DATA_URL)).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); });
    skyPromise = Promise.all(['stars.json', 'starnames.json', 'constlines.json', 'constnames.json', 'milkyway.json'].map(get))
      .then(([st, sn, cl, cn, mw]) => (SKY = prepare(st, sn, cl, cn, mw)))
      .catch((e) => { skyPromise = null; throw e; });
  }
  return skyPromise;
}
/** Bereits geladene Daten (oder null) */
export const getSky = () => SKY;

// B–V → Farbe (Temperatur nach Ballesteros, Schwarzkörper nach T. Helland, leicht entsättigt)
function bvRgb(bv, s = 0.82) {
  bv = clamp(bv, -0.35, 2.0);
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)) / 100;
  let r, g, b;
  if (T <= 66) { r = 255; g = 99.47 * Math.log(T) - 161.12; b = T <= 19 ? 0 : 138.52 * Math.log(T - 10) - 305.04; }
  else { r = 329.7 * Math.pow(T - 60, -0.1332); g = 288.12 * Math.pow(T - 60, -0.0755); b = 255; }
  const mix = (c) => Math.round(clamp(255 - (255 - clamp(c, 0, 255)) * s, 0, 255));
  return [mix(r), mix(g), mix(b)];
}
const BV_BINS = [-0.25, 0, 0.2, 0.4, 0.6, 0.85, 1.1, 1.4, 1.8];
const STAR_RGB = BV_BINS.map((b) => bvRgb(b));
const GLOW_RGB = BV_BINS.map((b) => bvRgb(b, 1.15));
const bvBin = (bv) => { let best = 0; for (let i = 1; i < BV_BINS.length; i++) if (Math.abs(bv - BV_BINS[i]) < Math.abs(bv - BV_BINS[best])) best = i; return best; };

function prepare(st, sn, cl, cn, mw) {
  const list = st.stars, n = list.length;
  const vec = new Float64Array(n * 3), mag = new Float32Array(n), bv = new Float32Array(n), hip = new Int32Array(n);
  const cb = new Uint8Array(n), r0 = new Float32Array(n), am = new Float32Array(n), ph = new Float32Array(n * 4);
  const idxByHip = new Map();
  list.forEach(([ra, dec, m, b, h], i) => {
    radecVec(ra, dec, vec, i * 3);
    mag[i] = m; bv[i] = b ?? 0.6; hip[i] = h; cb[i] = bvBin(bv[i]);
    r0[i] = 3.3 * Math.pow(0.79, m + 1.5);               // Grundradius in px
    am[i] = m <= 3 ? 1 : clamp(1 - (m - 3) * 0.13, 0.55, 1); // schwache Sterne zarter
    const h1 = Math.sin(i * 12.9898) * 43758.5453, h2 = Math.sin(i * 78.233) * 12345.6789;
    ph[i * 4] = (h1 - Math.floor(h1)) * TAU; ph[i * 4 + 1] = 2.2 + (h2 - Math.floor(h2)) * 3.5;
    ph[i * 4 + 2] = ((h1 * 7) % 1 + 1) % 1 * TAU; ph[i * 4 + 3] = 5 + ((h2 * 3) % 1 + 1) % 1 * 4;
    idxByHip.set(h, i);
  });
  // Namen
  const names = new Map();
  for (const k in sn) { const [name, desig, con] = sn[k]; names.set(+k, { name, desig, con }); }
  const named = [];
  for (let i = 0; i < n; i++) { const e = names.get(hip[i]); if (e?.name) named.push(i); }
  // Sternbilder
  const cons = new Map();
  for (const c of cn) if (!cons.has(c.id)) cons.set(c.id, { id: c.id, de: c.de, la: c.la, gen: c.gen });
  const conLabels = cn.map((c) => ({ id: c.id, de: c.de, la: c.la, rank: c.rank, vec: radecVec(c.ra, c.dec) }));
  // Linien: auf ≤ 2° verdichtet (große Bildwinkel), Sternpunkte markiert
  const lines = [];
  for (const [id, polys] of Object.entries(cl)) {
    for (const flat of polys) {
      const pts = [], star = [];
      for (let i = 0; i < flat.length; i += 2) {
        const v = radecVec(flat[i], flat[i + 1]);
        if (pts.length) {
          const p = pts[pts.length - 1];
          const ang = Math.acos(clamp(p[0] * v[0] + p[1] * v[1] + p[2] * v[2], -1, 1));
          const k = Math.ceil(ang / (2 * D2R));
          for (let j = 1; j < k; j++) { const t = j / k; pts.push(norm3([p[0] + (v[0] - p[0]) * t, p[1] + (v[1] - p[1]) * t, p[2] + (v[2] - p[2]) * t])); star.push(0); }
        }
        pts.push(v); star.push(1);
      }
      lines.push({ id, v: Float64Array.from(pts.flat()), star: Uint8Array.from(star) });
    }
  }
  // Milchstraße: Gauß-Splats (Detail mit Kontrastkurve) + „Sternenstaub“ (Körnung, Dichte ∝ Helligkeit)
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const gaussRnd = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(TAU * rnd());
  const dust = [];
  const mwLayers = mw.layers.map((L, li) => {
    const m = L.pts.length / 4;
    const v = new Float64Array(m * 3), I = new Float32Array(m), w = new Uint8Array(m);
    for (let i = 0; i < m; i++) {
      radecVec(L.pts[i * 4], L.pts[i * 4 + 1], v, i * 3);
      const raw = L.pts[i * 4 + 2], warm = L.pts[i * 4 + 3];
      I[i] = li ? Math.pow(raw, 1.15) : raw;
      w[i] = Math.min(MW_BINS - 1, Math.round(warm * (MW_BINS - 1)));
      // Staubpunkte um den Splat verteilt
      const k = Math.floor(raw * (li ? 7 : 2.2) + rnd());
      for (let j = 0; j < k; j++) {
        const x = v[i * 3], y = v[i * 3 + 1], z = v[i * 3 + 2];
        // Tangentialbasis
        let ex = -y, ey = x, ez = 0; const el0 = Math.hypot(ex, ey) || 1; ex /= el0; ey /= el0;
        const nx = y * ez - z * ey, ny = z * ex - x * ez, nz = x * ey - y * ex;
        const s = L.sigma * D2R * 0.9, a = gaussRnd() * s, b = gaussRnd() * s;
        const p = norm3([x + ex * a + nx * b, y + ey * a + ny * b, z + ez * a + nz * b]);
        dust.push(p[0], p[1], p[2], Math.min(1, 0.25 + rnd() * 0.75 * (0.4 + raw)), warm);
      }
    }
    return { li, n: m, v, I, w, sigma: L.sigma * D2R, norm: (L.step * L.step) / (TAU * L.sigma * L.sigma) };
  });
  return {
    n, vec, mag, bv, hip, cb, r0, am, ph, idxByHip, names, named, cons, conLabels, lines, mw: mwLayers,
    dust: Float32Array.from(dust), gc: radecVec(GC_RA, GC_DEC),
  };
}

// ── Bezugssystem ────────────────────────────────────────────
/**
 * Rotation J2000 → Horizont für Zeit & Ort (eine Matrix pro Zeitpunkt, astronomy-engine Rotation_EQJ_HOR).
 * toHor(vec) erwartet einen J2000-Einheitsvektor ([x,y,z] oder {x,y,z}) und liefert { az, alt } in Grad
 * (Azimut 0° = N, 90° = O). Refraktion ('normal' wie astronomy-engine) standardmäßig an.
 */
export function skyFrame(date, lat, lng, elevMeters = 0) {
  const A = AE();
  const d = date instanceof Date ? date : new Date(date);
  const observer = new A.Observer(lat, lng, elevMeters || 0);
  const R = A.Rotation_EQJ_HOR(d, observer).rot;
  // hor_j = Σ_i rot[i][j] · v_i   (so rechnet auch Astronomy.RotateVector)
  const m = new Float64Array([R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1], R[0][2], R[1][2], R[2][2]]);
  const horVec = (v, out = [0, 0, 0]) => {
    const x = v[0] ?? v.x, y = v[1] ?? v.y, z = v[2] ?? v.z;
    out[0] = m[0] * x + m[1] * y + m[2] * z; out[1] = m[3] * x + m[4] * y + m[5] * z; out[2] = m[6] * x + m[7] * y + m[8] * z;
    return out;
  };
  return {
    date: d, lat, lng, elev: elevMeters || 0, observer, m, horVec,
    toHor(v, refr = true) {
      const h = horVec(v), alt = Math.asin(clamp(h[2], -1, 1)) * R2D;
      return { az: horAz(h[0], h[1]), alt: refr ? alt + refraction(alt) : alt };
    },
    /** scheinbare Az/Höhe → J2000-Einheitsvektor */
    fromHor(az, alt, refr = true) {
      const a = refr ? alt - refraction(alt - refraction(alt)) : alt;
      const h = azAltToHor(az, a);
      return [m[0] * h[0] + m[3] * h[1] + m[6] * h[2], m[1] * h[0] + m[4] * h[1] + m[7] * h[2], m[2] * h[0] + m[5] * h[1] + m[8] * h[2]];
    },
  };
}
let frameCache = { key: '', f: null };
function cachedFrame(date, lat, lng, elev) {
  const key = `${date.getTime()}|${lat}|${lng}|${elev}`;
  if (frameCache.key !== key) frameCache = { key, f: skyFrame(date, lat, lng, elev) };
  return frameCache.f;
}

// ── Sonne, Mond, Planeten ───────────────────────────────────
const PLANETS = [
  { key: 'Mercury', name: 'Merkur', color: '#dccbb2' },
  { key: 'Venus', name: 'Venus', color: '#fff4d6' },
  { key: 'Mars', name: 'Mars', color: '#ff9466' },
  { key: 'Jupiter', name: 'Jupiter', color: '#f6dfbb' },
  { key: 'Saturn', name: 'Saturn', color: '#f0d89c' },
  { key: 'Uranus', name: 'Uranus', color: '#a9e9e6' },
  { key: 'Neptune', name: 'Neptun', color: '#94b2ff' },
];
let bodyCache = { key: '', val: null };
/** Topozentrische J2000-Positionen von Sonne, Mond und Planeten (astronomy-engine Equator, mit Aberration). */
export function skyBodies(date, lat, lng, elev = 0) {
  const d = date instanceof Date ? date : new Date(date);
  const key = `${d.getTime()}|${lat}|${lng}|${elev || 0}`;
  if (bodyCache.key === key) return bodyCache.val;
  const A = AE(), obs = new A.Observer(lat, lng, elev || 0);
  const pos = (body) => { const eq = A.Equator(body, d, obs, false, true); return { vec: radecVec(eq.ra * 15, eq.dec), ra: eq.ra * 15, dec: eq.dec, dist: eq.dist }; };
  const sun = { type: 'sun', id: 'sun', name: 'Sonne', color: '#ffe680', mag: -26.7, ...pos(A.Body.Sun) };
  const moon = { type: 'moon', id: 'moon', name: 'Mond', color: '#f1f3f5', ...pos(A.Body.Moon) };
  const il = A.Illumination(A.Body.Moon, d);
  moon.mag = il.mag; moon.illum = il.phase_fraction; moon.phase = A.MoonPhase(d);
  const planets = PLANETS.map((p) => {
    const b = A.Body[p.key];
    let mag = 8, illum = 1;
    try { const i = A.Illumination(b, d); mag = i.mag; illum = i.phase_fraction; } catch { /* egal */ }
    return { type: 'planet', id: p.key.toLowerCase(), name: p.name, color: p.color, mag, illum, ...pos(b) };
  });
  const val = { date: d, sun, moon, planets };
  bodyCache = { key, val };
  return val;
}

// ── Sprites ─────────────────────────────────────────────────
const MW_BINS = 6;
let SPR = null;
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function sprites() {
  if (SPR) return SPR;
  const star = GLOW_RGB.map(([r, g, b]) => {
    const c = mkCanvas(64, 64), x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, `rgba(${r},${g},${b},0.85)`); gr.addColorStop(0.1, `rgba(${r},${g},${b},0.5)`);
    gr.addColorStop(0.24, `rgba(${r},${g},${b},0.2)`); gr.addColorStop(0.45, `rgba(${r},${g},${b},0.07)`);
    gr.addColorStop(0.7, `rgba(${r},${g},${b},0.02)`); gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return c;
  });
  // Milchstraße: Gauß-Profil (auf 0 auslaufend), Farbe von kühl-violett (Arme) bis warm (Bulge)
  const COOL = [[118, 112, 232], [200, 210, 255]], WARM = [[226, 172, 142], [255, 230, 192]];
  const gauss = (rgb) => {
    const c = mkCanvas(64, 64), x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    const e = Math.exp(-0.5 * 2.5 * 2.5);
    for (let k = 0; k <= 12; k++) { const t = k / 12, a = Math.max(0, (Math.exp(-0.5 * (t * 2.5) ** 2) - e) / (1 - e)); gr.addColorStop(t, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(4)})`); }
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return c;
  };
  const mw = [0, 1].map((li) => Array.from({ length: MW_BINS }, (_, k) => {
    const t = k / (MW_BINS - 1), a = COOL[li], b = WARM[li];
    return gauss([0, 1, 2].map((j) => Math.round(a[j] + (b[j] - a[j]) * t)));
  }));
  const glow = (() => { // weicher Lichthof für Mond/Sonne/Planeten
    const c = mkCanvas(64, 64), x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.18)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.05)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64); return c;
  })();
  const fill = STAR_RGB.map(([r, g, b]) => { // Kernfarbe (aufgehellt) je Alpha-Stufe
    const w = (c) => Math.round(c + (255 - c) * 0.35);
    return Array.from({ length: A_BINS + 1 }, (_, a) => `rgba(${w(r)},${w(g)},${w(b)},${(a / A_BINS).toFixed(3)})`);
  });
  SPR = { star, mw, glow, fill };
  return SPR;
}
const A_BINS = 10;

// ── Text ────────────────────────────────────────────────────
const widthCache = new Map();
function textW(ctx, font, t) {
  const k = font + '|' + t;
  let w = widthCache.get(k);
  if (w == null) { ctx.font = font; w = ctx.measureText(t).width; if (widthCache.size > 3000) widthCache.clear(); widthCache.set(k, w); }
  return w;
}
class Labels {
  constructor(ctx, W, H) { this.ctx = ctx; this.W = W; this.H = H; this.r = []; }
  /** Halo-Stärke (0 = aus) für folgende Beschriftungen */
  halo(a) { this.h = a; if (a > 0.02) this.ctx.strokeStyle = `rgba(4,7,14,${a.toFixed(3)})`; }
  free(x, y, w, h) {
    if (x < 2 || y < 2 || x + w > this.W - 2 || y + h > this.H - 2) return false;
    for (const r of this.r) if (x < r[0] + r[2] && x + w > r[0] && y < r[1] + r[3] && y + h > r[1]) return false;
    return true;
  }
  block(x, y, w, h) { this.r.push([x, y, w, h]); }
  /** Beschriftung neben einem Objekt (rechts, links, oben, unten – erste freie Position) */
  place(text, x, y, gap, font, size, color, { center = false, spacing = 0 } = {}) {
    const ctx = this.ctx, w = textW(ctx, font, text) + spacing * text.length, h = size + 2;
    const cand = center ? [[x - w / 2, y - h / 2]]
      : [[x + gap, y - h / 2], [x - gap - w, y - h / 2], [x - w / 2, y - gap - h], [x - w / 2, y + gap]];
    for (const [lx, ly] of cand) {
      if (!this.free(lx, ly, w, h)) continue;
      this.block(lx - 2, ly - 1, w + 4, h + 2);
      ctx.font = font; ctx.fillStyle = color;
      if (spacing && 'letterSpacing' in ctx) ctx.letterSpacing = spacing + 'px';
      if (this.h > 0.02) ctx.strokeText(text, lx, ly + h / 2 + 0.5);
      ctx.fillText(text, lx, ly + h / 2 + 0.5);
      if (spacing && 'letterSpacing' in ctx) ctx.letterSpacing = '0px';
      return true;
    }
    return false;
  }
}

// ── Projektion (generisch) ──────────────────────────────────
function genericProj(project) {
  return (x, y, z, o) => {
    const p = project(horAz(x, y), Math.asin(clamp(z, -1, 1)) * R2D);
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
    o[0] = p[0]; o[1] = p[1]; return true;
  };
}
function genericScale(proj, fallback) {
  const a = [0, 0], b = [0, 0], d = 0.01;
  return (x, y, z) => {
    if (!proj(x, y, z, a)) return fallback;
    let tx = -z * x, ty = -z * y, tz = 1 - z * z; // Richtung „nach oben“ tangential
    let l = Math.hypot(tx, ty, tz);
    if (l < 1e-6) { tx = 1; ty = 0; tz = 0; l = 1; }
    const nx = x + (tx / l) * d, ny = y + (ty / l) * d, nz = z + (tz / l) * d, nl = Math.hypot(nx, ny, nz);
    if (!proj(nx / nl, ny / nl, nz / nl, b)) return fallback;
    return Math.hypot(b[0] - a[0], b[1] - a[1]) / d || fallback;
  };
}

// ── drawSky ─────────────────────────────────────────────────
const DEFAULT_LAYERS = { stars: true, constellations: true, names: true, planets: true, milkyway: true, moon: true, sun: true, grid: false, horizon: false };
const CARD = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
const caches = new WeakMap();

/**
 * Zeichnet den Himmel in ctx (in den aktuellen Transform-Einheiten des Kontexts, z. B. CSS-Pixel).
 * Löscht nichts – Hintergrund zeichnet der Aufrufer.
 *
 * opts: {
 *   width, height,                 Zeichenfläche (Kontext-Einheiten)
 *   project(az, alt) → [x, y]|null Projektion (Grad; az 0 = N, 90 = O), null = nicht sichtbar
 *   pxPerDeg,                      Maßstab in Bildmitte (für Größen/Detailgrad)
 *   date, lat, lng, elev,
 *   layers: { stars, constellations, names, planets, milkyway, moon, sun, grid, horizon },
 *   magLimit (6), twinkle (false), labelScale (1),
 *   // optional:
 *   horizonClip (true)   nichts unter dem Horizont zeichnen
 *   daylightFade (true)  Sterne/Milchstraße mit Sonnenhöhe ausblenden (AR-Planung: false)
 *   milkyWayAlpha (1), starScale (1), now (ms, für Funkeln), cacheKey (gleich → Milchstraße wiederverwenden),
 *   projectHor(x, y, z, out) → bool  schneller Pfad mit HOR-Vektor statt az/alt,
 *   scaleHor(x, y, z) → px/rad       lokaler Maßstab (sonst numerisch)
 *   viewAz                           Azimut für Höhen-Beschriftung des Rasters
 * }
 * Rückgabe: Szene für pickSky() – { stars:{x,y,a}, bodies:[…], gc, sunAlt, moonAlt, frame, … } oder null (Daten fehlen).
 */
export function drawSky(ctx, opts) {
  const S = SKY;
  if (!S) { loadSky().catch(() => {}); return null; }
  const W = opts.width, H = opts.height;
  const L = { ...DEFAULT_LAYERS, ...(opts.layers || {}) };
  const date = opts.date instanceof Date ? opts.date : new Date(opts.date ?? Date.now());
  const elev = opts.elev || 0;
  const frame = cachedFrame(date, opts.lat, opts.lng, elev);
  const bodies = skyBodies(date, opts.lat, opts.lng, elev);
  const m = frame.m;
  const ls = opts.labelScale ?? 1;
  const ppd = opts.pxPerDeg ?? 10;
  const clipH = opts.horizonClip !== false;
  const now = opts.now ?? performance.now();
  const P = opts.projectHor || genericProj(opts.project);
  const scaleAt = opts.scaleHor || genericScale(P, ppd * R2D);
  const spr = sprites();
  let cache = caches.get(ctx);
  if (!cache) { cache = {}; caches.set(ctx, cache); }

  const o = [0, 0], h = [0, 0, 0];
  const toH = (v, i = 0) => { const x = v[i], y = v[i + 1], z = v[i + 2]; h[0] = m[0] * x + m[1] * y + m[2] * z; h[1] = m[3] * x + m[4] * y + m[5] * z; h[2] = m[6] * x + m[7] * y + m[8] * z; return h; };
  const onScreen = (x, y, pad) => x > -pad && y > -pad && x < W + pad && y < H + pad;

  // Sonne/Mond → Ausblenden
  const sunH = toH(bodies.sun.vec).slice(), sunAlt = Math.asin(sunH[2]) * R2D;
  const moonH = toH(bodies.moon.vec).slice(), moonAlt = Math.asin(moonH[2]) * R2D;
  const fade = opts.daylightFade !== false;
  const night = fade ? smooth(0, -12, sunAlt) : 1;           // 0 = Tag (Sonne > 0°), 1 = ab −12°
  const moonLight = fade ? Math.pow(bodies.moon.illum, 1.5) * smooth(-2, 25, moonAlt) : 0;
  const mwVis = (fade ? smooth(-8, -17, sunAlt) : 1) * (1 - 0.3 * moonLight) * (opts.milkyWayAlpha ?? 1);
  const scene = { W, H, frame, bodies, sunAlt, moonAlt, night, stars: null, bodiesXY: [], gc: null, cons: [] };

  // 1 ── Milchstraße ──
  if (L.milkyway && mwVis > 0.01) drawMilkyWay(ctx, S, cache, opts, W, H, toH, P, scaleAt, clipH, mwVis, spr, ppd, m);

  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  // 2 ── Raster ──
  if (L.grid) drawGrid(ctx, P, W, H, ls, opts.viewAz, clipH);

  // 3 ── Sternbildlinien ──
  const zf = clamp(Math.pow(ppd / 12, 0.3), 0.8, 1.75) * (opts.starScale ?? 1);
  if (L.constellations) {
    ctx.beginPath();
    const gap = 3.2 * zf, a = [0, 0], b = [0, 0];
    let hp = [0, 0, 0], hv = [0, 0, 0];
    for (const ln of S.lines) {
      const v = ln.v, cnt = v.length / 3;
      for (let k = 0; k < cnt; k++) {
        toH(v, k * 3); refractInPlace(h);
        const sw = hp; hp = hv; hv = sw; // hp = vorheriger Punkt
        hv[0] = h[0]; hv[1] = h[1]; hv[2] = h[2];
        if (k === 0) continue;
        // Segment hp → hv, ggf. am Horizont kappen
        let p0 = hp, p1 = hv, cut0 = false, cut1 = false;
        if (clipH && (p0[2] < 0 || p1[2] < 0)) {
          if (p0[2] < 0 && p1[2] < 0) continue;
          const t = p0[2] / (p0[2] - p1[2]);
          const c = norm3([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, 0]);
          if (p0[2] < 0) { p0 = c; cut0 = true; } else { p1 = c; cut1 = true; }
        }
        if (!P(p0[0], p0[1], p0[2], a) || !P(p1[0], p1[1], p1[2], b)) continue;
        if (!onScreen(a[0], a[1], 300) && !onScreen(b[0], b[1], 300)) continue;
        let dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (len > 2500) continue;
        const g0 = ln.star[k - 1] && !cut0 ? gap : 0, g1 = ln.star[k] && !cut1 ? gap : 0;
        if (len <= g0 + g1 + 0.5) continue;
        dx /= len; dy /= len;
        ctx.moveTo(a[0] + dx * g0, a[1] + dy * g0); ctx.lineTo(b[0] - dx * g1, b[1] - dy * g1);
      }
    }
    ctx.strokeStyle = `rgba(120,160,255,${(0.34 * (0.45 + 0.55 * night)).toFixed(3)})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 4 ── Sterne ──
  const n = S.n;
  if (!cache.sx || cache.sx.length !== n) { cache.sx = new Float32Array(n); cache.sy = new Float32Array(n); cache.sa = new Float32Array(n); cache.sr = new Float32Array(n); cache.salt = new Float32Array(n); }
  const sx = cache.sx, sy = cache.sy, sa = cache.sa, sr = cache.sr, salt = cache.salt;
  sa.fill(0);
  scene.stars = { x: sx, y: sy, a: sa, r: sr };
  if (L.stars && night > 0.001) {
    let lim = opts.magLimit ?? 6;
    lim = -1.6 + (lim + 1.6) * Math.pow(night, 0.6) - 0.7 * moonLight;
    const gA = 0.35 + 0.65 * night;
    const buckets = cache.buckets || (cache.buckets = Array.from({ length: STAR_RGB.length * (A_BINS + 1) }, () => []));
    for (const bk of buckets) bk.length = 0;
    const bright = cache.bright || (cache.bright = []);
    bright.length = 0;
    const V = S.vec, mag = S.mag;
    for (let i = 0; i < n; i++) {
      const mg = mag[i];
      if (mg > lim + 0.6) break; // nach Helligkeit sortiert
      toH(V, i * 3);
      if (clipH && h[2] < -0.02) continue;
      refractInPlace(h);
      if (clipH && h[2] < 0) continue;
      if (!P(h[0], h[1], h[2], o) || !onScreen(o[0], o[1], 8)) continue;
      let a = S.am[i] * gA * clamp((lim + 0.6 - mg) / 0.8, 0, 1);
      if (a < 0.02) continue;
      let r = S.r0[i] * zf;
      if (r < 0.7) { a *= Math.sqrt(r / 0.7); r = 0.7; }
      sx[i] = o[0]; sy[i] = o[1]; sa[i] = a; sr[i] = r; salt[i] = h[2];
      if (mg < 3.2 || r > 1.7) bright.push(i);
      else buckets[S.cb[i] * (A_BINS + 1) + Math.round(a * A_BINS)].push(i);
    }
    // schwache Sterne gebündelt
    for (let bI = 0; bI < buckets.length; bI++) {
      const bk = buckets[bI];
      if (!bk.length) continue;
      const ab = bI % (A_BINS + 1);
      if (!ab) continue;
      ctx.fillStyle = spr.fill[(bI / (A_BINS + 1)) | 0][ab];
      ctx.beginPath();
      for (const i of bk) { ctx.moveTo(sx[i] + sr[i], sy[i]); ctx.arc(sx[i], sy[i], sr[i], 0, TAU); }
      ctx.fill();
    }
    // helle Sterne mit Lichthof (und Funkeln) – hellste zuletzt
    const t = now / 1000;
    for (let k = bright.length - 1; k >= 0; k--) {
      const i = bright[k];
      let a = sa[i], r = sr[i];
      if (opts.twinkle) {
        const amp = 0.1 + 0.26 * clamp(1 - Math.asin(clamp(salt[i], -1, 1)) * R2D / 40, 0, 1);
        const tw = 1 + amp * (0.6 * Math.sin(t * S.ph[i * 4 + 1] + S.ph[i * 4]) + 0.4 * Math.sin(t * S.ph[i * 4 + 3] + S.ph[i * 4 + 2]));
        a = clamp(a * tw, 0, 1); r *= 1 + (tw - 1) * 0.35;
      }
      const mg = S.mag[i], g = r * (11 + Math.max(0, 2.4 - mg) * 4.2);
      ctx.globalAlpha = a * (mg < 1.5 ? 0.9 : 0.65);
      ctx.drawImage(spr.star[S.cb[i]], sx[i] - g / 2, sy[i] - g / 2, g, g);
      if (mg < 0.7) { // zarte Beugungsstrahlen der hellsten Sterne
        const l = r * (5 + (0.7 - mg) * 2.2);
        ctx.globalAlpha = a * 0.3;
        ctx.strokeStyle = spr.fill[S.cb[i]][A_BINS]; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(sx[i] - l, sy[i]); ctx.lineTo(sx[i] + l, sy[i]); ctx.moveTo(sx[i], sy[i] - l); ctx.lineTo(sx[i], sy[i] + l); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = spr.fill[S.cb[i]][Math.max(1, Math.round(a * A_BINS))];
      ctx.beginPath(); ctx.arc(sx[i], sy[i], r, 0, TAU); ctx.fill();
      if (r > 1.6) { // heller Kern
        ctx.fillStyle = `rgba(255,255,255,${(a * 0.85).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(sx[i], sy[i], r * 0.5, 0, TAU); ctx.fill();
      }
    }
  }

  // 5 ── Milchstraßen-Kern ──
  if (L.milkyway) {
    toH(S.gc); refractInPlace(h);
    if ((!clipH || h[2] > 0) && P(h[0], h[1], h[2], o) && onScreen(o[0], o[1], 20)) {
      const x = o[0], y = o[1], al = 0.55 + 0.45 * night;
      ctx.strokeStyle = `rgba(199,146,234,${(0.9 * al).toFixed(3)})`; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(x, y, 6.5 * ls, 0, TAU);
      for (let k = 0; k < 4; k++) { const an = k * Math.PI / 2 + Math.PI / 4, c = Math.cos(an), s = Math.sin(an); ctx.moveTo(x + c * 9 * ls, y + s * 9 * ls); ctx.lineTo(x + c * 13 * ls, y + s * 13 * ls); }
      ctx.stroke();
      scene.gc = { type: 'gc', id: 'gc', name: 'Milchstraßen-Kern', x, y, hor: h.slice(), vec: S.gc };
    }
  }

  // 6 ── Planeten, Sonne, Mond ──
  const discs = [];
  const bodyAt = (b) => {
    toH(b.vec); refractInPlace(h);
    if (clipH && h[2] < -0.005) return null;
    if (!P(h[0], h[1], h[2], o)) return null;
    return { x: o[0], y: o[1], hor: h.slice() };
  };
  if (L.planets) {
    for (const pl of bodies.planets) {
      const q = bodyAt(pl);
      if (!q || !onScreen(q.x, q.y, 30)) continue;
      // nachts alle (auch Uranus/Neptun zur Planung), in der Dämmerung helle Planeten länger, am Tag aus
      const vis = fade ? clamp(night * 1.8 + Math.max(0, -pl.mag) * 0.12 * Math.min(1, night * 4), 0, 1) : 1;
      if (vis < 0.03) continue;
      const r = clamp(1.7 + (1.5 - pl.mag) * 0.55, 1.6, 4.6) * clamp(zf, 0.9, 1.4);
      ctx.globalAlpha = vis * 0.9;
      const g = r * 7;
      ctx.drawImage(spr.glow, q.x - g / 2, q.y - g / 2, g, g);
      ctx.globalAlpha = vis;
      ctx.fillStyle = pl.color;
      ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, TAU); ctx.fill();
      if (pl.id === 'saturn' && r > 2.4) { // angedeuteter Ring
        ctx.strokeStyle = pl.color; ctx.lineWidth = 0.9;
        ctx.beginPath(); ctx.ellipse(q.x, q.y, r * 2, r * 0.7, -0.35, 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      const e = { ...pl, x: q.x, y: q.y, r, hor: q.hor, vis };
      scene.bodiesXY.push(e); discs.push(e);
    }
  }
  if (L.sun) {
    const q = bodyAt(bodies.sun);
    if (q && onScreen(q.x, q.y, 80)) {
      const r = Math.max(9 * ls, 0.267 * D2R * scaleAt(q.hor[0], q.hor[1], q.hor[2]));
      const g = r * 9;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.9; ctx.drawImage(spr.glow, q.x - g / 2, q.y - g / 2, g, g);
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      const gr = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, r);
      gr.addColorStop(0, '#fffdf2'); gr.addColorStop(0.7, '#ffe9a0'); gr.addColorStop(1, '#ffc94d');
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, TAU); ctx.fill();
      const e = { ...bodies.sun, x: q.x, y: q.y, r, hor: q.hor };
      scene.bodiesXY.push(e); discs.push(e);
    }
  }
  if (L.moon) {
    const q = bodyAt(bodies.moon);
    if (q && onScreen(q.x, q.y, 60)) {
      const angR = Math.asin(1737.4 / (bodies.moon.dist * 149597870.7));
      const r = Math.max(8.5 * ls, angR * scaleAt(q.hor[0], q.hor[1], q.hor[2]));
      // Richtung zur Sonne auf dem Bildschirm (Großkreis Mond → Sonne)
      const mh = q.hor, dt = sunH[0] * mh[0] + sunH[1] * mh[1] + sunH[2] * mh[2];
      const tx = sunH[0] - dt * mh[0], ty = sunH[1] - dt * mh[1], tz = sunH[2] - dt * mh[2], tl = Math.hypot(tx, ty, tz) || 1, e1 = 0.02;
      let ang = -Math.PI / 2;
      const p2 = [0, 0];
      const nx = mh[0] + tx / tl * e1, ny = mh[1] + ty / tl * e1, nz = mh[2] + tz / tl * e1, nl = Math.hypot(nx, ny, nz);
      if (P(nx / nl, ny / nl, nz / nl, p2)) ang = Math.atan2(p2[1] - q.y, p2[0] - q.x);
      drawMoonDisc(ctx, q.x, q.y, r, bodies.moon.illum, ang, spr, night);
      const e = { ...bodies.moon, x: q.x, y: q.y, r, hor: q.hor, limbAngle: ang };
      scene.bodiesXY.push(e); discs.push(e);
    }
  }

  // 7 ── Beschriftungen ──
  if (L.names) {
    const lab = new Labels(ctx, W, H);
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    lab.halo(0.3 + 0.42 * night);
    for (const d of discs) lab.block(d.x - d.r - 1, d.y - d.r - 1, 2 * d.r + 2, 2 * d.r + 2);
    const f1 = `600 ${Math.round(12 * ls)}px ${FONT}`, f2 = `500 ${Math.round(11 * ls)}px ${FONT}`, f3 = `600 ${Math.round(10 * ls)}px ${FONT}`;
    for (const d of discs) {
      if (d.type === 'moon') lab.place(`Mond ${Math.round(d.illum * 100)} %`, d.x, d.y, d.r + 6, f1, 12 * ls, 'rgba(241,243,245,0.95)');
      else if (d.type === 'sun') lab.place('Sonne', d.x, d.y, d.r + 6, f1, 12 * ls, '#ffe680');
      else if (d.vis > 0.25) lab.place(d.name, d.x, d.y, d.r + 5, f1, 12 * ls, d.color);
    }
    lab.halo(0.72 * night);
    if (scene.gc) lab.place('Milchstraßen-Kern', scene.gc.x, scene.gc.y, 15 * ls, f2, 11 * ls, 'rgba(214,176,240,0.95)');
    if (L.stars && night > 0.05) {
      const magLab = 1.6 + clamp((ppd - 14) / 18, 0, 1.3);
      for (const i of S.named) {
        if (S.mag[i] > magLab && S.hip[i] !== POLARIS) continue;
        if (sa[i] < 0.15) continue;
        lab.place(S.names.get(S.hip[i]).name, sx[i], sy[i], sr[i] + 4.5, f2, 11 * ls, `rgba(232,236,244,${(0.55 + 0.4 * night).toFixed(2)})`);
      }
    }
    if (L.constellations) {
      const maxRank = ppd > 13 ? 3 : ppd > 7 ? 2 : 1;
      ctx.lineWidth = 2.5; lab.halo(0.5 * night);
      for (const c of S.conLabels) {
        if (c.rank > maxRank) continue;
        toH(c.vec);
        if (clipH && h[2] < 0.03) continue;
        if (!P(h[0], h[1], h[2], o) || !onScreen(o[0], o[1], 0)) continue;
        const t = c.de.toUpperCase();
        if (lab.place(t, o[0], o[1], 0, f3, 10 * ls, `rgba(150,180,255,${(0.5 * (0.5 + 0.5 * night)).toFixed(3)})`, { center: true, spacing: 1.4 })) scene.cons.push({ id: c.id, x: o[0], y: o[1] });
      }
    }
  }

  // 8 ── Horizontlinie + Himmelsrichtungen (AR) ──
  if (L.horizon) drawHorizonMarks(ctx, P, W, H, ppd, ls, { line: true });

  ctx.restore();
  return scene;
}

function drawMoonDisc(ctx, x, y, r, illum, ang, spr, night) {
  const darkA = 0.12 + 0.8 * night;
  ctx.save();
  // Lichthof
  const g = r * (6 + 6 * illum);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = (0.25 + 0.55 * illum) * (0.5 + 0.5 * night);
  ctx.drawImage(spr.glow, x - g / 2, y - g / 2, g, g);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.translate(x, y); ctx.rotate(ang); // +x zeigt zur Sonne
  // Nachtseite (Erdschein)
  ctx.fillStyle = `rgba(52,60,78,${darkA.toFixed(3)})`;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
  // beleuchteter Teil: Halbkreis zur Sonne + Terminator-Ellipse
  const k = 1 - 2 * clamp(illum, 0, 1);
  const lit = ctx.createRadialGradient(r * 0.25, -r * 0.2, r * 0.1, 0, 0, r);
  lit.addColorStop(0, '#fbf8ef'); lit.addColorStop(1, '#d9d4c6');
  ctx.fillStyle = lit;
  ctx.beginPath();
  ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.ellipse(0, 0, Math.max(0.001, Math.abs(k) * r), r, 0, Math.PI / 2, -Math.PI / 2, k > 0);
  ctx.fill();
  // angedeutete Maria
  if (r > 9) {
    ctx.globalAlpha = 0.13; ctx.fillStyle = '#5b6170';
    ctx.rotate(-ang);
    for (const [mx, my, mr] of [[-0.25, -0.3, 0.28], [0.15, -0.35, 0.2], [0.3, 0.05, 0.22], [-0.1, 0.2, 0.18]]) { ctx.beginPath(); ctx.arc(mx * r, my * r, mr * r, 0, TAU); ctx.fill(); }
  }
  ctx.restore();
}

function drawMilkyWay(ctx, S, cache, opts, W, H, toH, P, scaleAt, clipH, alpha, spr, ppd, m) {
  const q = opts.mwResolution ?? 0.4; // Puffer-Auflösung relativ zu Kontext-Einheiten
  const bw = Math.max(8, Math.ceil(W * q)), bh = Math.max(8, Math.ceil(H * q));
  const gw = Math.max(4, Math.ceil(bw / 4)), gh = Math.max(4, Math.ceil(bh / 4));
  const key = opts.cacheKey != null ? `${opts.cacheKey}|${bw}x${bh}` : null;
  const buf = cache.mw || (cache.mw = mkCanvas(bw, bh));
  const glow = cache.mwGlow || (cache.mwGlow = mkCanvas(gw, gh));
  if (!key || key !== cache.mwKey) {
    if (buf.width !== bw || buf.height !== bh) { buf.width = bw; buf.height = bh; }
    if (glow.width !== gw || glow.height !== gh) { glow.width = gw; glow.height = gh; }
    const b = buf.getContext('2d');
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'source-over'; b.globalAlpha = 1;
    b.clearRect(0, 0, bw, bh);
    b.globalCompositeOperation = 'lighter';
    const o = [0, 0];
    for (const Ly of S.mw) {
      const sp = spr.mw[Ly.li ? 1 : 0], V = Ly.v, gain = Ly.norm * (Ly.li ? 0.9 : 1.0);
      for (let i = 0; i < Ly.n; i++) {
        const h = toH(V, i * 3);
        if (clipH && h[2] < -0.03) continue;
        if (!P(h[0], h[1], h[2], o)) continue;
        const x = o[0] * q, y = o[1] * q;
        let rad = 2.5 * Ly.sigma * scaleAt(h[0], h[1], h[2]) * q;
        if (!(rad > 0) || rad > bw * 2) continue;
        if (x + rad < 0 || y + rad < 0 || x - rad > bw || y - rad > bh) continue;
        let a = Ly.I[i] * gain;
        if (rad < 1.6) { a *= (rad / 1.6) ** 2; rad = 1.6; }
        b.globalAlpha = Math.min(1, a);
        b.drawImage(sp[Ly.w[i]], x - rad, y - rad, rad * 2, rad * 2);
      }
    }
    // weiches Glühen (verkleinerte Kopie)
    const g = glow.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    g.clearRect(0, 0, gw, gh); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(buf, 0, 0, bw, bh, 0, 0, gw, gh);
    cache.mwKey = key;
  }
  const a = clamp(alpha, 0, 1);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.globalAlpha = a * 0.55; ctx.drawImage(glow, 0, 0, gw, gh, 0, 0, W, H);
  ctx.globalAlpha = a * 0.9; ctx.drawImage(buf, 0, 0, bw, bh, 0, 0, W, H);
  // Sternenstaub: feine Körnung der Sternwolken
  const D = S.dust, o = [0, 0], sz = clamp(0.55 + ppd / 40, 0.6, 1.3);
  const bins = cache.dustBins || (cache.dustBins = [[], [], [], []]);
  for (const bn of bins) bn.length = 0;
  const hv = [0, 0, 0];
  for (let i = 0; i < D.length; i += 5) {
    const x = D[i], y = D[i + 1], z = D[i + 2];
    hv[2] = m[6] * x + m[7] * y + m[8] * z;
    if (clipH && hv[2] < 0) continue;
    hv[0] = m[0] * x + m[1] * y + m[2] * z; hv[1] = m[3] * x + m[4] * y + m[5] * z;
    if (!P(hv[0], hv[1], hv[2], o) || o[0] < 0 || o[1] < 0 || o[0] > W || o[1] > H) continue;
    bins[Math.min(3, (D[i + 3] * 4) | 0)].push(o[0], o[1]);
  }
  ctx.globalCompositeOperation = 'lighter';
  for (let k = 0; k < 4; k++) {
    const bn = bins[k];
    if (!bn.length) continue;
    ctx.globalAlpha = a * (0.16 + k * 0.12);
    ctx.fillStyle = k > 1 ? '#f4eee6' : '#d9dcff';
    ctx.beginPath();
    for (let j = 0; j < bn.length; j += 2) ctx.rect(bn[j] - sz / 2, bn[j + 1] - sz / 2, sz, sz);
    ctx.fill();
  }
  ctx.restore();
}

function drawGrid(ctx, P, W, H, ls, viewAz, clipH) {
  const a = [0, 0];
  ctx.beginPath();
  const seg = (pts) => { let pen = false; for (const [az, alt] of pts) { const v = azAltToHor(az, alt); if (P(v[0], v[1], v[2], a) && Math.abs(a[0]) < 4 * W + 2000 && Math.abs(a[1]) < 4 * H + 2000) { if (pen) ctx.lineTo(a[0], a[1]); else ctx.moveTo(a[0], a[1]); pen = true; } else pen = false; } };
  for (let alt = 15; alt < 90; alt += 15) { const pts = []; for (let az = 0; az <= 360; az += 2) pts.push([az, alt]); seg(pts); }
  if (!clipH) for (let alt = -15; alt > -90; alt -= 15) { const pts = []; for (let az = 0; az <= 360; az += 2) pts.push([az, alt]); seg(pts); }
  for (let az = 0; az < 360; az += 15) { const pts = []; for (let alt = clipH ? 0 : -88; alt <= 88; alt += 2) pts.push([az, alt]); seg(pts); }
  ctx.strokeStyle = 'rgba(150,175,255,0.13)'; ctx.lineWidth = 1; ctx.stroke();
  if (viewAz != null) {
    ctx.font = `600 ${Math.round(10 * ls)}px ${FONT}`; ctx.fillStyle = 'rgba(170,190,255,0.55)';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    for (let alt = 15; alt < 90; alt += 15) { const v = azAltToHor(viewAz, alt); if (P(v[0], v[1], v[2], a) && a[0] > 0 && a[1] > 12 && a[0] < W && a[1] < H) ctx.fillText(`${alt}°`, a[0] + 4, a[1] - 2); }
  }
}

/** Horizontlinie, Gradstriche und Himmelsrichtungen (N, NO, O … in Deutsch) für beliebige Projektion */
function drawHorizonMarks(ctx, P, W, H, ppd, ls, { line = true } = {}) {
  const a = [0, 0], b = [0, 0];
  ctx.save();
  if (line) {
    ctx.beginPath();
    let pen = false;
    for (let az = 0; az <= 360; az += 1) {
      const v = azAltToHor(az, 0);
      if (P(v[0], v[1], v[2], a) && Math.abs(a[0]) < 3 * W + 1000 && Math.abs(a[1]) < 3 * H + 1000) { if (pen) ctx.lineTo(a[0], a[1]); else ctx.moveTo(a[0], a[1]); pen = true; } else pen = false;
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.3; ctx.stroke();
  }
  const fine = ppd > 9;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (let az = 0; az < 360; az += 5) {
    const major = az % 15 === 0, card = az % 45 === 0;
    if (!major && !fine) continue;
    const v = azAltToHor(az, 0), v2 = azAltToHor(az, -0.8);
    if (!P(v[0], v[1], v[2], a) || !P(v2[0], v2[1], v2[2], b)) continue;
    if (a[0] < -40 || a[0] > W + 40 || a[1] < -40 || a[1] > H + 40) continue;
    let dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
    const len = card ? 9 : major ? 6 : 3.5;
    ctx.strokeStyle = card ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.4)';
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(a[0] + dx * len, a[1] + dy * len); ctx.stroke();
    if (card) {
      const t = CARD[az / 45], main = az % 90 === 0;
      ctx.font = `${main ? 700 : 600} ${Math.round((main ? 14 : 12) * ls)}px ${FONT}`;
      ctx.fillStyle = az === 0 ? '#ff7b6b' : main ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.75)';
      ctx.fillText(t, a[0] + dx * (len + 11 * ls), a[1] + dy * (len + 11 * ls));
    } else if (major) {
      ctx.font = `500 ${Math.round(10 * ls)}px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.fillText(`${az}°`, a[0] + dx * (len + 9 * ls), a[1] + dy * (len + 9 * ls));
    }
  }
  ctx.restore();
}

// ── Objektinfos & Auswahl ───────────────────────────────────
const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
function desigText(S, desig, con) {
  if (!desig || !con) return '';
  const c = S.cons.get(con);
  const d = /^[α-ω]/.test(desig) ? desig.replace(/\d/g, (x) => SUP[x]) : desig;
  return `${d} ${c?.gen || con}`;
}
function conOf(S, vecJ2000) {
  try {
    const { ra, dec } = vecRaDec(vecJ2000);
    const c = AE().Constellation(ra / 15, dec);
    return S.cons.get(c.symbol) || { id: c.symbol, de: c.name, la: c.name };
  } catch { return null; }
}
const MOON_PHASES = ['Neumond', 'Zunehmende Sichel', 'Erstes Viertel', 'Zunehmender Mond', 'Vollmond', 'Abnehmender Mond', 'Letztes Viertel', 'Abnehmende Sichel'];
function moonPhaseName(p) {
  p = wrap360(p);
  if (p < 6 || p >= 354) return MOON_PHASES[0];
  if (p < 84) return MOON_PHASES[1]; if (p < 96) return MOON_PHASES[2]; if (p < 174) return MOON_PHASES[3];
  if (p < 186) return MOON_PHASES[4]; if (p < 264) return MOON_PHASES[5]; if (p < 276) return MOON_PHASES[6];
  return MOON_PHASES[7];
}
function bvText(bv) {
  if (bv < -0.02) return 'bläulich weiß';
  if (bv < 0.3) return 'weiß'; if (bv < 0.58) return 'gelblich weiß'; if (bv < 0.9) return 'gelb';
  if (bv < 1.35) return 'orange'; return 'orangerot';
}

/**
 * Nächstes Objekt zur Bildschirmposition (x, y) in einer Szene von drawSky().
 * Liefert { type: 'star'|'planet'|'moon'|'sun'|'gc'|'constellation', id, name, … } oder null.
 * unproject(x, y) → HOR-Vektor (optional) ermöglicht die Sternbild-Erkennung im leeren Himmel.
 */
export function pickSky(scene, x, y, unproject) {
  const S = SKY;
  if (!scene || !S) return null;
  let best = null, bs = 1;
  const consider = (score, make) => { if (score < bs) { bs = score; best = make; } };
  for (const b of scene.bodiesXY) { const d = Math.hypot(b.x - x, b.y - y), R = Math.max(18, b.r + 10); consider(d / R * 0.8, () => bodyInfo(scene, b)); }
  if (scene.gc) { const d = Math.hypot(scene.gc.x - x, scene.gc.y - y); consider(d / 18 * 0.9, () => gcInfo(scene)); }
  const st = scene.stars;
  if (st) {
    for (let i = 0; i < S.n; i++) {
      if (st.a[i] < 0.12) continue;
      const dx = st.x[i] - x, dy = st.y[i] - y;
      if (dx > 26 || dx < -26 || dy > 26 || dy < -26) continue;
      const R = clamp(7 + (4.5 - S.mag[i]) * 2.6, 7, 24);
      const sc = Math.hypot(dx, dy) / R;
      if (sc < bs) { const ii = i; consider(sc, () => starInfo(scene, ii)); }
    }
  }
  if (best) return best();
  if (unproject) {
    const hv = unproject(x, y);
    if (!hv || hv[2] < 0) return null;
    const m = scene.frame.m;
    const v = [m[0] * hv[0] + m[3] * hv[1] + m[6] * hv[2], m[1] * hv[0] + m[4] * hv[1] + m[7] * hv[2], m[2] * hv[0] + m[5] * hv[1] + m[8] * hv[2]];
    return conInfo(scene, conOf(S, v), v);
  }
  return null;
}
function horOf(scene, vec) { return scene.frame.toHor(vec, true); }
function starInfo(scene, i) {
  const S = SKY, e = S.names.get(S.hip[i]) || {};
  const v = [S.vec[i * 3], S.vec[i * 3 + 1], S.vec[i * 3 + 2]];
  const con = e.con ? S.cons.get(e.con) : conOf(S, v);
  const des = desigText(S, e.desig, e.con);
  const { az, alt } = horOf(scene, v);
  const rd = vecRaDec(v);
  return {
    type: 'star', id: 'hip' + S.hip[i], index: i, hip: S.hip[i], name: e.name || des || `HIP ${S.hip[i]}`, designation: des,
    mag: S.mag[i], bv: S.bv[i], color: bvText(S.bv[i]), con: con?.id, conName: con?.de, conLatin: con?.la,
    az, alt, ra: rd.ra, dec: rd.dec, vec: v, x: scene.stars.x[i], y: scene.stars.y[i],
  };
}
function bodyInfo(scene, b) {
  const { az, alt } = horOf(scene, b.vec);
  const con = conOf(SKY, b.vec);
  const o = { type: b.type, id: b.id, name: b.name, mag: b.mag, az, alt, ra: b.ra, dec: b.dec, dist: b.dist, con: con?.id, conName: con?.de, conLatin: con?.la, vec: b.vec, x: b.x, y: b.y, color: b.color };
  if (b.type === 'moon') { o.illum = b.illum; o.phase = b.phase; o.phaseName = moonPhaseName(b.phase); }
  if (b.type === 'planet') o.illum = b.illum;
  return o;
}
function gcInfo(scene) {
  const S = SKY, { az, alt } = horOf(scene, S.gc), con = conOf(S, S.gc);
  return { type: 'gc', id: 'gc', name: 'Milchstraßen-Kern', az, alt, ra: GC_RA, dec: GC_DEC, con: con?.id, conName: con?.de, conLatin: con?.la, vec: S.gc, x: scene.gc.x, y: scene.gc.y };
}
function conInfo(scene, con, v) {
  if (!con) return null;
  const S = SKY;
  let bi = -1;
  for (let i = 0; i < S.n; i++) { const e = S.names.get(S.hip[i]); if (e?.con === con.id) { bi = i; break; } } // nach Helligkeit sortiert
  const lab = S.conLabels.find((c) => c.id === con.id);
  const { az, alt } = horOf(scene, lab ? lab.vec : v);
  const be = bi >= 0 ? S.names.get(S.hip[bi]) : null;
  return {
    type: 'constellation', id: con.id, name: con.de, latin: con.la, az, alt, vec: lab ? lab.vec : v, at: v,
    brightest: bi >= 0 ? { name: be.name || desigText(S, be.desig, be.con), mag: S.mag[bi] } : null,
  };
}

// ─────────────────────────────────────────────────────────────
// Planetarium
// ─────────────────────────────────────────────────────────────
// Himmelsfarben (Zenit / Horizont) über Sonnenhöhe
const SKY_KEYS = [
  [-90, [3, 5, 12], [9, 13, 28]],
  [-18, [3, 5, 12], [10, 15, 32]],
  [-12, [6, 10, 26], [22, 30, 64]],
  [-6, [13, 23, 58], [58, 70, 122]],
  [-2, [26, 45, 98], [150, 122, 138]],
  [2, [40, 82, 160], [214, 178, 150]],
  [10, [44, 104, 198], [160, 198, 238]],
  [90, [36, 104, 212], [168, 208, 246]],
];
function skyKey(sunAlt) {
  for (let i = 1; i < SKY_KEYS.length; i++) {
    if (sunAlt <= SKY_KEYS[i][0]) {
      const [a0, z0, h0] = SKY_KEYS[i - 1], [a1, z1, h1] = SKY_KEYS[i], t = (sunAlt - a0) / (a1 - a0);
      return [z0.map((c, j) => c + (z1[j] - c) * t), h0.map((c, j) => c + (h1[j] - c) * t)];
    }
  }
  return [SKY_KEYS[SKY_KEYS.length - 1][1], SKY_KEYS[SKY_KEYS.length - 1][2]];
}

const LAYER_DEFS = [
  { key: 'constellations', label: 'Sternbilder', svg: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18 9 9l6 4 5-8"/><circle cx="4" cy="18" r="1.7" fill="currentColor"/><circle cx="9" cy="9" r="1.7" fill="currentColor"/><circle cx="15" cy="13" r="1.7" fill="currentColor"/><circle cx="20" cy="5" r="1.7" fill="currentColor"/></svg>' },
  { key: 'names', label: 'Namen', svg: icon('tag') },
  { key: 'milkyway', label: 'Milchstraße', svg: icon('galaxy') },
  { key: 'planets', label: 'Planeten', svg: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><path d="M5.2 15.6C2.4 17.4 1.4 19 2 19.9c1 1.6 6.6-.3 12.5-4.3S23 7.4 22 5.9c-.6-.9-2.4-.6-4.9.5"/></svg>' },
  { key: 'grid', label: 'Raster', svg: icon('grid') },
];
const PLAY_SVG = '<svg class="ic" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.4-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z"/></svg>';
const PAUSE_SVG = '<svg class="ic" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4.5" width="4.2" height="15" rx="1.2"/><rect x="13.8" y="4.5" width="4.2" height="15" rx="1.2"/></svg>';
const PREF_KEY = 'specula.stars.v1';
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch { return {}; } };
const savePrefs = (p) => { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* privat */ } };

/**
 * Vollbild-Planetarium auf `canvas` (füllt sein Elternelement).
 * getTime() → Date · getLocation() → { lat, lng, elev, tz } · setTime(date) (für „Nachtverlauf“) · onPick(obj)
 * Rückgabe: { activate(), deactivate(), redraw(), lookAt(az, alt, fovDeg, animate?), destroy() }
 */
export function initStarView({ canvas, getTime, getLocation, setTime, onPick } = {}) {
  if (!canvas) throw new Error('initStarView: canvas fehlt');
  const parent = canvas.parentElement;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  canvas.classList.add('stv-canvas');
  canvas.style.touchAction = 'none';
  if (!canvas.hasAttribute('aria-label')) { canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Interaktiver Sternhimmel – ziehen zum Drehen, zoomen, tippen für Infos'); }
  const ctx = canvas.getContext('2d');
  const prefs = loadPrefs();
  const layers = { stars: true, constellations: true, names: true, milkyway: true, planets: true, moon: true, sun: true, grid: false, ...(prefs.layers || {}) };
  const pr = parent.getBoundingClientRect();
  const view = { az: 180, ...(pr.height > pr.width * 1.15 ? { alt: 38, fov: 100 } : { alt: 30, fov: 115 }), ...(prefs.view || {}) };
  let W = 0, H = 0, dpr = 1, active = false, raf = 0, dirty = true, lastKey = '', lastTw = 0;
  let cam = null, scene = null, selected = null, tween = null, animTime = null, lastCardUpd = 0, destroyed = false;
  const night = { state: 'idle', start: 0, end: 0, tau: 0, dur: 20000, lastTs: 0, resumeAt: 0, lastSet: 0 };
  const sky = { cv: mkCanvas(8, 8), key: '' };

  // ── Oberfläche ──
  const ui = el(`<div class="stv-ui">
    <div class="stv-card" hidden></div>
    <div class="stv-bar" role="toolbar" aria-label="Sternhimmel">
      <div class="stv-group">${LAYER_DEFS.map((d) => `<button type="button" class="stv-tg" data-layer="${d.key}" title="${d.label}" aria-label="${d.label}" aria-pressed="false">${d.svg}<span>${d.label}</span></button>`).join('')}</div>
      <button type="button" class="stv-play" title="Himmel bis Sonnenaufgang abspielen"><span class="stv-play-ic">${PLAY_SVG}</span><span class="stv-play-txt"><b>Nachtverlauf</b><small></small></span><i class="stv-play-prog"></i></button>
    </div>
    <div class="stv-loading">Sterne werden geladen …</div>
  </div>`);
  parent.appendChild(ui);
  const card = ui.querySelector('.stv-card'), bar = ui.querySelector('.stv-bar'), playBtn = ui.querySelector('.stv-play');
  const playTxt = playBtn.querySelector('b'), playTime = playBtn.querySelector('small'), playIc = playBtn.querySelector('.stv-play-ic'), playProg = playBtn.querySelector('.stv-play-prog');
  const syncToggles = () => { for (const b of ui.querySelectorAll('.stv-tg')) { const on = !!layers[b.dataset.layer]; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); } };
  syncToggles();
  bar.addEventListener('click', (e) => {
    const tg = e.target.closest('.stv-tg');
    if (tg) { layers[tg.dataset.layer] = !layers[tg.dataset.layer]; syncToggles(); persist(); dirty = true; return; }
    if (e.target.closest('.stv-play')) togglePlay();
  });
  card.addEventListener('click', (e) => { if (e.target.closest('.stv-card-x')) select(null); });
  for (const elx of [bar, card]) elx.addEventListener('pointerdown', (e) => e.stopPropagation());

  let persistT = 0;
  function persist() { clearTimeout(persistT); persistT = setTimeout(() => savePrefs({ layers, view: { az: view.az, alt: view.alt, fov: view.fov } }), 400); }

  loadSky().then(() => { ui.querySelector('.stv-loading')?.remove(); dirty = true; }).catch((e) => {
    const l = ui.querySelector('.stv-loading'); if (l) l.textContent = 'Sterndaten konnten nicht geladen werden.'; console.error(e);
  });

  // ── Größe ──
  const ro = new ResizeObserver(() => { dirty = true; if (active && !raf) raf = requestAnimationFrame(loop); });
  ro.observe(parent);
  function resize() {
    const r = parent.getBoundingClientRect();
    const nd = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width)), hh = Math.max(1, Math.round(r.height));
    if (w !== W || hh !== H || nd !== dpr) {
      W = w; H = hh; dpr = nd;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    }
  }

  // ── Kamera (stereografisch um Blickrichtung) ──
  function makeCam() {
    const A = view.az * D2R, h = view.alt * D2R, ca = Math.cos(A), sa = Math.sin(A), ch = Math.cos(h), sh = Math.sin(h);
    const f = [ch * ca, -ch * sa, sh], r = [-sa, -ca, 0], u = [-sh * ca, sh * sa, ch];
    const s = (Math.max(W, H) / 2) / (2 * Math.tan((view.fov * D2R) / 4));
    const cx = W / 2, cy = H / 2, CLIP = Math.cos(165 * D2R);
    return {
      f, r, u, s, cx, cy, az: view.az, alt: view.alt, fov: view.fov, pxPerDeg: s * D2R,
      projectHor(x, y, z, o) {
        const a = x * f[0] + y * f[1] + z * f[2];
        if (a < CLIP) return false;
        const k = (2 * s) / (1 + a);
        o[0] = cx + k * (x * r[0] + y * r[1]); o[1] = cy - k * (x * u[0] + y * u[1] + z * u[2]);
        return true;
      },
      scaleHor(x, y, z) { return (2 * s) / (1 + x * f[0] + y * f[1] + z * f[2]); },
      unproject(X, Y) {
        const b = (X - cx) / s, c = (cy - Y) / s, rho = Math.hypot(b, c);
        if (rho < 1e-9) return f.slice();
        const th = 2 * Math.atan(rho / 2), st = Math.sin(th) / rho, ct = Math.cos(th);
        return [ct * f[0] + st * (b * r[0] + c * u[0]), ct * f[1] + st * (b * r[1] + c * u[1]), ct * f[2] + st * (c * u[2])];
      },
      project(az, alt) { const v = azAltToHor(az, alt), o = [0, 0]; return this.projectHor(v[0], v[1], v[2], o) ? o : null; },
    };
  }

  // ── Zeichnen ──
  const curTime = () => animTime || getTime?.() || new Date();
  function draw(ts) {
    resize();
    cam = makeCam();
    const date = curTime(), loc = getLocation?.() || { lat: 47.07, lng: 15.44, elev: 0, tz: 'Europe/Vienna' };
    const elev = loc.elev || 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let bodies = null, frame = null;
    try { frame = cachedFrame(date, loc.lat, loc.lng, elev); bodies = skyBodies(date, loc.lat, loc.lng, elev); } catch (e) { console.error(e); return; }
    const toHorV = (v) => frame.horVec(v);
    const sunH = toHorV(bodies.sun.vec), moonH = toHorV(bodies.moon.vec);
    const sunAlt = Math.asin(clamp(sunH[2], -1, 1)) * R2D;
    drawBackground(sunH, sunAlt, moonH, bodies.moon.illum, date, loc);
    const key = `${view.az.toFixed(3)}|${view.alt.toFixed(3)}|${view.fov.toFixed(3)}|${W}x${H}@${dpr}|${date.getTime()}|${loc.lat}|${loc.lng}|${elev}`;
    scene = drawSky(ctx, {
      width: W, height: H, projectHor: cam.projectHor, scaleHor: cam.scaleHor, project: cam.project.bind(cam), pxPerDeg: cam.pxPerDeg,
      date, lat: loc.lat, lng: loc.lng, elev, layers, twinkle: layers.twinkle !== false, now: ts, labelScale: 1,
      horizonClip: true, cacheKey: key, viewAz: view.az,
    });
    drawGround(sunAlt);
    drawHorizonMarks(ctx, cam.projectHor, W, H, cam.pxPerDeg, 1, { line: false });
    if (selected) drawSelection();
    updateCard();
    updatePlay(date, loc.tz);
  }

  function drawBackground(sunH, sunAlt, moonH, moonIllum) {
    const cell = 14, cols = Math.ceil(W / cell) + 1, rows = Math.ceil(H / cell) + 1;
    const key = `${view.az}|${view.alt}|${view.fov}|${W}x${H}|${sunH.map((x) => x.toFixed(4))}|${moonH.map((x) => x.toFixed(3))}`;
    if (key !== sky.key) {
      sky.key = key;
      if (sky.cv.width !== cols || sky.cv.height !== rows) { sky.cv.width = cols; sky.cv.height = rows; sky.img = null; }
      const sc = sky.cv.getContext('2d');
      const img = sky.img || (sky.img = sc.createImageData(cols, rows)), d = img.data;
      const [zen, hor] = skyKey(sunAlt);
      // Sonnen-Lichthof: Dämmerungsglühen am Horizont, tagsüber Aureole
      const glowAmt = clamp(1 - Math.abs(sunAlt - 1) / 16, 0, 1) ** 1.6;
      const glowCol = sunAlt > 4 ? [255, 246, 220] : [255, 150, 90];
      const aureole = smooth(-2, 8, sunAlt);
      const moonUp = smooth(-3, 10, Math.asin(clamp(moonH[2], -1, 1)) * R2D) * Math.pow(moonIllum, 1.5) * (1 - smooth(-4, 6, sunAlt));
      const sx = sunH[0], sy = sunH[1], sz = sunH[2], mx = moonH[0], my = moonH[1], mz = moonH[2];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const v = cam.unproject(((i + 0.5) * W) / cols, ((j + 0.5) * H) / rows);
          const z = Math.max(0, v[2]);
          const iz = 1 - z, t = iz * iz * Math.sqrt(iz); // (1 − sin h)^2,5
          let R = zen[0] + (hor[0] - zen[0]) * t, G = zen[1] + (hor[1] - zen[1]) * t, B = zen[2] + (hor[2] - zen[2]) * t;
          const cs = v[0] * sx + v[1] * sy + Math.max(v[2], 0) * sz;
          if (glowAmt > 0.001) {
            const c = (cs + 1) / 2, c2 = c * c, g = glowAmt * c2 * c2 * c2 * c * (0.25 + 0.75 * t) * 0.85;
            R += (glowCol[0] - R) * g; G += (glowCol[1] - G) * g; B += (glowCol[2] - B) * g;
          }
          if (aureole > 0.001) {
            const c2 = ((cs + 1) / 2) ** 2, c4 = c2 * c2, c8 = c4 * c4, c16 = c8 * c8, c32 = c16 * c16;
            const g = aureole * (c32 * c32 * c16 * 0.75 + c8 * c4 * 0.12);
            R += (255 - R) * g; G += (252 - G) * g; B += (240 - B) * g;
          }
          if (moonUp > 0.001) {
            const q = (v[0] * mx + v[1] * my + v[2] * mz + 1) / 2, q2 = q * q, q4 = q2 * q2, q8 = q4 * q4, q16 = q8 * q8, q32 = q16 * q16, q64 = q32 * q32;
            const g = moonUp * (q64 * q32 * q16 * q8 * 0.22 + q8 * q4 * q2 * 0.07 + 0.025);
            R += 120 * g; G += 145 * g; B += 205 * g;
          }
          const p = (j * cols + i) * 4;
          d[p] = R; d[p + 1] = G; d[p + 2] = B; d[p + 3] = 255;
        }
      }
      sc.putImageData(img, 0, 0);
    }
    ctx.save();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sky.cv, 0, 0, W, H);
    ctx.restore();
  }

  function drawGround(sunAlt) {
    const al = view.alt * D2R, s = cam.s;
    const day = smooth(-10, 8, sunAlt);
    const c0 = [12 + 14 * day, 16 + 18 * day, 24 + 20 * day], c1 = [6 + 8 * day, 8 + 10 * day, 12 + 12 * day];
    const rgb = (c) => `rgb(${c.map(Math.round).join(',')})`;
    ctx.save();
    ctx.beginPath();
    // Horizont = Kreis (stereografisch): Mitte (cx, cy − 2s·cot h), Radius 2s / |sin h|
    const hx = cam.cx, R = (2 * s) / Math.abs(Math.sin(al)), hy = cam.cy - (2 * s) / Math.tan(al);
    if (!(R < 2e5)) {
      // fast gerade (Blick nahe Horizont): Kreisbogen als Polylinie in doppelter Genauigkeit
      const pts = [];
      for (let k = 0; k <= 48; k++) {
        const x = -20 + ((W + 40) * k) / 48, dx = x - hx;
        const y = Number.isFinite(R) ? (al > 0 ? hy + Math.sqrt(Math.max(0, R * R - dx * dx)) : hy - Math.sqrt(Math.max(0, R * R - dx * dx))) : cam.cy;
        pts.push([x, y]);
      }
      pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.lineTo(W + 20, H + 20); ctx.lineTo(-20, H + 20); ctx.closePath();
      const top = Math.min(...pts.map((p) => p[1]));
      const g = ctx.createLinearGradient(0, top, 0, Math.max(top + 1, H)); g.addColorStop(0, rgb(c0)); g.addColorStop(1, rgb(c1)); ctx.fillStyle = g;
      ctx.fill();
      ctx.beginPath(); pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    } else {
      if (al > 0) { ctx.rect(-10, -10, W + 20, H + 20); ctx.arc(hx, hy, R, 0, TAU, true); }
      else ctx.arc(hx, hy, R, 0, TAU);
      const g = al > 0 ? ctx.createRadialGradient(hx, hy, R, hx, hy, R + Math.max(H, 200) * 0.9) : ctx.createRadialGradient(hx, hy, Math.max(0, R - Math.max(H, 200) * 0.9), hx, hy, R);
      if (al > 0) { g.addColorStop(0, rgb(c0)); g.addColorStop(1, rgb(c1)); } else { g.addColorStop(0, rgb(c1)); g.addColorStop(1, rgb(c0)); }
      ctx.fillStyle = g;
      ctx.fill('evenodd');
      ctx.beginPath(); ctx.arc(hx, hy, R, 0, TAU);
    }
    // Horizontlinie mit zartem Leuchten
    ctx.strokeStyle = 'rgba(160,185,255,0.12)'; ctx.lineWidth = 6; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();
  }

  function drawSelection() {
    const p = selectedScreen();
    if (!p) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,159,67,0.95)'; ctx.lineWidth = 1.6;
    const r = Math.max(11, (p.r || 0) + 7);
    ctx.beginPath();
    for (let k = 0; k < 4; k++) { const a0 = k * Math.PI / 2 + 0.28, a1 = a0 + Math.PI / 2 - 0.56; ctx.moveTo(p.x + Math.cos(a0) * r, p.y + Math.sin(a0) * r); ctx.arc(p.x, p.y, r, a0, a1); }
    ctx.stroke();
    ctx.restore();
  }
  // aktuelle Bildschirmposition des ausgewählten Objekts
  function selectedScreen() {
    if (!selected || !scene) return null;
    if (selected.type === 'star') { const i = selected.index; return scene.stars.a[i] > 0 ? { x: scene.stars.x[i], y: scene.stars.y[i], r: scene.stars.r[i] } : null; }
    if (selected.type === 'gc') return scene.gc ? { x: scene.gc.x, y: scene.gc.y, r: 8 } : null;
    if (selected.type === 'constellation') return null;
    const b = scene.bodiesXY.find((x) => x.id === selected.id);
    return b ? { x: b.x, y: b.y, r: b.r } : null;
  }

  // ── Infokarte ──
  function select(obj) {
    selected = obj; cardPos = null;
    if (!obj) { card.hidden = true; dirty = true; return; }
    renderCard();
    card.hidden = false;
    dirty = true;
    try { onPick?.(obj); } catch (e) { console.error(e); }
  }
  function renderCard() {
    const o = selected, loc = getLocation?.() || {};
    // Position/Höhe zur aktuellen Zeit neu bestimmen
    const f = cachedFrame(curTime(), loc.lat, loc.lng, loc.elev || 0);
    if (o.vec && o.type !== 'planet' && o.type !== 'moon' && o.type !== 'sun') { const p = f.toHor(o.vec); o.az = p.az; o.alt = p.alt; }
    else if (o.type === 'planet' || o.type === 'moon' || o.type === 'sun') {
      const b = skyBodies(curTime(), loc.lat, loc.lng, loc.elev || 0);
      const nb = o.type === 'sun' ? b.sun : o.type === 'moon' ? b.moon : b.planets.find((p) => p.id === o.id);
      if (nb) { const p = f.toHor(nb.vec); o.az = p.az; o.alt = p.alt; o.vec = nb.vec; o.mag = nb.mag; o.dist = nb.dist; if (o.type === 'moon') { o.illum = nb.illum; o.phase = nb.phase; o.phaseName = moonPhaseName(nb.phase); } }
    }
    const num = (x, d = 1) => (x == null || !isFinite(x) ? '–' : x.toFixed(d).replace('.', ','));
    const rows = [];
    const row = (k, v) => rows.push(`<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`);
    let kicker = '', sub = '', dot = '#e8ecf4';
    if (o.type === 'star') {
      kicker = 'Stern'; dot = '#e8ecf4';
      sub = [o.designation && o.designation !== o.name ? o.designation : '', `HIP ${o.hip}`].filter(Boolean).join(' · ');
      row('Helligkeit', `${num(o.mag, 2)} mag`);
    } else if (o.type === 'planet') {
      kicker = 'Planet'; dot = o.color; sub = `Entfernung ${num(o.dist, 2)} AE`;
      row('Helligkeit', `${num(o.mag, 1)} mag`);
    } else if (o.type === 'moon') {
      kicker = 'Mond'; dot = '#f1f3f5'; sub = `${o.phaseName} · ${Math.round(o.illum * 100)} % beleuchtet`;
      row('Helligkeit', `${num(o.mag, 1)} mag`);
    } else if (o.type === 'sun') {
      kicker = 'Sonne'; dot = '#ffe680'; sub = 'Unser Stern';
    } else if (o.type === 'gc') {
      kicker = 'Galaktisches Zentrum'; dot = VIOLET; sub = 'Sgr A* · ca. 26 000 Lichtjahre';
    } else if (o.type === 'constellation') {
      kicker = 'Sternbild'; dot = '#96b4ff'; sub = o.latin;
      if (o.brightest) row('Hellster Stern', `${o.brightest.name} (${num(o.brightest.mag, 1)} mag)`);
    }
    row('Azimut', fmtAz(o.az));
    row('Höhe', o.alt < -0.5 ? `${fmtDeg(o.alt, 1)} (unter dem Horizont)` : fmtDeg(o.alt, 1));
    if (o.type !== 'constellation' && o.conName) row('Sternbild', o.conName);
    if (o.type === 'star') row('Farbe', o.color);
    if (o.type === 'moon' && o.dist > 0) row('Entfernung', `${(Math.round((o.dist * 149597870.7) / 100) * 100).toLocaleString('de-AT')} km`);
    card.innerHTML = `<button type="button" class="stv-card-x" aria-label="Schließen">×</button>
      <div class="stv-card-kicker"><i style="background:${esc(dot)}"></i>${esc(kicker)}</div>
      <div class="stv-card-title">${esc(o.name)}</div>
      ${sub ? `<div class="stv-card-sub">${esc(sub)}</div>` : ''}
      <div class="stv-card-rows">${rows.join('')}</div>`;
  }
  let cardPos = null;
  function updateCard() {
    if (!selected || card.hidden) return;
    let p = null;
    if (selected.type === 'constellation') { // am angetippten Punkt verankert (dreht mit dem Himmel)
      const v = frameVec(selected.at || selected.vec), o = [0, 0];
      if (v && v[2] > -0.02 && cam.projectHor(v[0], v[1], v[2], o)) p = { x: o[0], y: o[1], r: 4 };
    } else p = selectedScreen();
    const cw = card.offsetWidth || 240, ch = card.offsetHeight || 140;
    const barTop = bar.offsetTop || H;
    let x, y;
    const visible = !!p && p.x > -20 && p.x < W + 20 && p.y > -20 && p.y < H + 20;
    card.classList.toggle('stv-away', !visible); // Objekt außer Sicht: Karte blendet aus, bleibt ausgewählt
    if (visible) {
      const gap = (p.r || 0) + 16;
      x = p.x + gap + cw < W - 10 ? p.x + gap : p.x - gap - cw;
      y = p.y - ch / 2;
    } else if (cardPos) [x, y] = cardPos;
    else { x = 12; y = 12; }
    x = clamp(x, 10, Math.max(10, W - cw - 10));
    y = clamp(y, 10, Math.max(10, Math.min(H, barTop) - ch - 10));
    cardPos = [x, y];
    card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }
  function frameVec(v) {
    const loc = getLocation?.() || {};
    try { return cachedFrame(curTime(), loc.lat, loc.lng, loc.elev || 0).horVec(v); } catch { return null; }
  }

  // ── Nachtverlauf ──
  function togglePlay() {
    if (night.state === 'playing') { night.state = 'paused'; dirty = true; return; }
    const cur = getTime?.() || new Date();
    if (night.state === 'paused' && Math.abs(cur - night.lastSet) < 90000) {
      night.state = 'playing'; night.lastTs = 0; night.resumeAt = performance.now(); dirty = true; return;
    }
    const loc = getLocation?.() || {};
    const A = AE(), obs = new A.Observer(loc.lat, loc.lng, loc.elev || 0);
    let start = new Date(cur);
    const sunAlt = (() => { const e = A.Equator(A.Body.Sun, start, obs, true, true); return A.Horizon(start, obs, e.ra, e.dec, 'normal').altitude; })();
    if (sunAlt > -0.8) { const ss = A.SearchRiseSet(A.Body.Sun, obs, -1, start, 1); if (ss) start = ss.date; }
    const sr = A.SearchRiseSet(A.Body.Sun, obs, +1, start, 1.5);
    let end = sr ? sr.date : new Date(start.getTime() + 10 * 3600e3);
    if (end - start < 20 * 60000) end = new Date(start.getTime() + 8 * 3600e3);
    Object.assign(night, { state: 'playing', start: +start, end: +end, tau: 0, dur: 20000 * clamp((end - start) / (8 * 3600e3), 0.75, 1.15), lastTs: 0, resumeAt: 0, lastSet: +start });
    dirty = true;
  }
  function stepNight(ts) {
    if (night.state !== 'playing') return;
    const ext = getTime?.();
    if (ext && Math.abs(ext - night.lastSet) > 90000 && night.tau > 0) { night.state = 'idle'; animTime = null; return; } // Zeit wurde von außen verstellt
    const dt = night.lastTs ? Math.min(80, ts - night.lastTs) : 0;
    night.lastTs = ts;
    const ramp = night.resumeAt ? clamp((ts - night.resumeAt) / 500, 0, 1) : 1;
    night.tau += dt * ramp;
    const p = clamp(night.tau / night.dur, 0, 1);
    const e = (1 - Math.cos(Math.PI * p)) / 2; // ease-in-out
    const t = new Date(Math.round(night.start + e * (night.end - night.start)));
    animTime = t; night.lastSet = +t;
    try { setTime?.(t); } catch (err) { console.error(err); }
    dirty = true;
    if (p >= 1) { night.state = 'idle'; animTime = null; }
  }
  let playState = '';
  function updatePlay(date, tz) {
    const st = night.state, tstr = fmtTime(date, tz || undefined);
    const p = night.dur ? clamp(night.tau / night.dur, 0, 1) : 0;
    const k = `${st}|${tstr}|${(p * 200) | 0}`;
    if (k === playState) return;
    playState = k;
    playBtn.classList.toggle('playing', st === 'playing');
    playBtn.classList.toggle('paused', st === 'paused');
    playIc.innerHTML = st === 'playing' ? PAUSE_SVG : PLAY_SVG;
    playTxt.textContent = st === 'playing' ? 'Pause' : st === 'paused' ? 'Weiter' : 'Nachtverlauf';
    playTime.textContent = st === 'idle' ? `${fmtDateShort(date, tz || undefined)} · ${tstr}` : `${tstr} → ${fmtTime(new Date(night.end), tz || undefined)}`;
    playBtn.title = st === 'playing' ? 'Pausieren' : st === 'paused' ? 'Fortsetzen' : 'Himmel bis Sonnenaufgang abspielen';
    playProg.style.transform = `scaleX(${st === 'idle' ? 0 : p})`;
  }

  // ── Blick-Animation ──
  function lookAt(az, alt, fovDeg, animate = false) {
    const to = { az: wrap360(az ?? view.az), alt: clamp(alt ?? view.alt, -20, 90), fov: clamp(fovDeg ?? view.fov, 25, 150) };
    if (animate && active) tween = { from: { ...view }, to, t0: performance.now(), dur: 650 };
    else { tween = null; Object.assign(view, to); persist(); }
    dirty = true;
    if (active && !raf) raf = requestAnimationFrame(loop);
  }
  function stepTween(ts) {
    if (!tween) return;
    const p = clamp((ts - tween.t0) / tween.dur, 0, 1), e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    view.az = wrap360(tween.from.az + wrap180(tween.to.az - tween.from.az) * e);
    view.alt = tween.from.alt + (tween.to.alt - tween.from.alt) * e;
    view.fov = tween.from.fov + (tween.to.fov - tween.from.fov) * e;
    dirty = true;
    if (p >= 1) { tween = null; persist(); }
  }

  // ── Bedienung ──
  const ptrs = new Map();
  let gesture = null, lastTap = { t: 0, x: 0, y: 0 };
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  // Blick so drehen, dass ein HOR-Vektor unter dem Punkt (X, Y) liegt (2 Iterationen)
  function keepUnder(hv, X, Y) {
    for (let it = 0; it < 3; it++) {
      cam = makeCam();
      const o = [0, 0];
      if (!cam.projectHor(hv[0], hv[1], hv[2], o)) return;
      panBy(X - o[0], Y - o[1]);
    }
  }
  function panBy(dx, dy) {
    if (!cam) cam = makeCam();
    const k = R2D / cam.s;
    view.alt = clamp(view.alt + dy * k, -20, 90);
    view.az = wrap360(view.az - (dx * k) / Math.max(0.25, Math.cos(view.alt * D2R)));
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    canvas.setPointerCapture?.(e.pointerId);
    const [x, y] = local(e);
    ptrs.set(e.pointerId, { x, y });
    tween = null;
    if (ptrs.size === 1) gesture = { type: 'drag', x0: x, y0: y, lx: x, ly: y, moved: false, t0: performance.now(), id: e.pointerId };
    else if (ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      gesture = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, fov0: view.fov, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, moved: true };
    }
    canvas.classList.add('grabbing');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    const [x, y] = local(e);
    ptrs.set(e.pointerId, { x, y });
    if (!gesture) return;
    if (gesture.type === 'drag' && ptrs.size === 1) {
      if (!gesture.moved && Math.hypot(x - gesture.x0, y - gesture.y0) > 5) gesture.moved = true;
      if (gesture.moved) { panBy(x - gesture.lx, y - gesture.ly); gesture.lx = x; gesture.ly = y; dirty = true; persist(); }
    } else if (gesture.type === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      cam = makeCam();
      const anchor = cam.unproject(gesture.mx, gesture.my);
      view.fov = clamp(gesture.fov0 * (gesture.d0 / d), 25, 150);
      keepUnder(anchor, mx, my);
      gesture.mx = mx; gesture.my = my;
      dirty = true; persist();
    }
  });
  const endPtr = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (gesture?.type === 'drag' && !gesture.moved && e.type === 'pointerup' && performance.now() - gesture.t0 < 600) {
      const [x, y] = local(e);
      const now = performance.now();
      const dbl = e.pointerType !== 'mouse' && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30;
      lastTap = { t: dbl ? 0 : now, x, y };
      if (dbl) centerOn(x, y); else tap(x, y);
    }
    if (ptrs.size === 0) { gesture = null; canvas.classList.remove('grabbing'); }
    else if (ptrs.size === 1) { const [p] = [...ptrs.values()]; gesture = { type: 'drag', x0: p.x, y0: p.y, lx: p.x, ly: p.y, moved: true, t0: 0 }; }
  };
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);
  canvas.addEventListener('dblclick', (e) => { const [x, y] = local(e); centerOn(x, y); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const [x, y] = local(e);
    cam = makeCam();
    const anchor = cam.unproject(x, y);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    view.fov = clamp(view.fov * Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0016)), 25, 150);
    tween = null;
    keepUnder(anchor, x, y);
    dirty = true; persist();
  }, { passive: false });
  function centerOn(x, y) {
    if (!cam) return;
    const v = cam.unproject(x, y);
    lookAt(horAz(v[0], v[1]), Math.asin(clamp(v[2], -1, 1)) * R2D, view.fov, true);
  }
  function tap(x, y) {
    if (!scene) return;
    const o = pickSky(scene, x, y, cam ? (X, Y) => cam.unproject(X, Y) : null);
    select(o);
  }

  // ── Schleife (nur aktiv) ──
  function loop(ts) {
    raf = 0;
    if (!active || destroyed) return;
    raf = requestAnimationFrame(loop);
    stepTween(ts); stepNight(ts);
    const t = curTime(), loc = getLocation?.() || {};
    const key = `${+t}|${loc.lat}|${loc.lng}|${loc.elev}`;
    if (key !== lastKey) { lastKey = key; dirty = true; if (selected && ts - lastCardUpd > 200) { lastCardUpd = ts; renderCard(); } }
    const twinkle = layers.twinkle !== false && layers.stars;
    if (twinkle && ts - lastTw > 55) dirty = true;
    if (!dirty || !SKY) { if (!SKY && dirty) { resize(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#05070d'; ctx.fillRect(0, 0, W, H); } return; }
    dirty = false; lastTw = ts;
    draw(ts);
  }

  return {
    activate() { if (destroyed) return; active = true; dirty = true; if (!raf) raf = requestAnimationFrame(loop); },
    deactivate() { active = false; if (raf) cancelAnimationFrame(raf); raf = 0; if (night.state === 'playing') night.state = 'paused'; },
    redraw() { dirty = true; if (active && !raf) raf = requestAnimationFrame(loop); },
    lookAt,
    /** aktueller Blick { az, alt, fov } */
    get view() { return { ...view }; },
    get scene() { return scene; },
    setLayer(name, on) { layers[name] = !!on; syncToggles(); persist(); dirty = true; },
    pick(x, y) { if (scene) select(pickSky(scene, x, y, cam ? (X, Y) => cam.unproject(X, Y) : null)); return selected; },
    destroy() { destroyed = true; active = false; if (raf) cancelAnimationFrame(raf); ro.disconnect(); ui.remove(); canvas.classList.remove('stv-canvas'); },
  };
}
