// ─────────────────────────────────────────────────────────────
// Gezeiten: harmonische Analyse eines Jahres stündlicher Meereshöhen
// (Open-Meteo Marine, Meeresmodell inkl. Gezeiten) → Vorhersage für
// beliebige Zeitpunkte – auch Monate im Voraus und offline.
// Validiert: Saint-Malo (11 m Hub) Hoch-/Niedrigwasserzeit ±3 min (Median)
// ─────────────────────────────────────────────────────────────
import { distance, zonedParts, startOfLocalDay, addLocalDays } from './utils.js';
import { moonPhaseAngle } from './astro.js';

// Partialtiden: Name, Winkelgeschwindigkeit (°/h)
const CON = [
  ['Sa', 0.0410686], ['Ssa', 0.0821373], ['Mm', 0.5443747], ['MSf', 1.0158958], ['Mf', 1.0980331],
  ['2Q1', 12.8542862], ['Q1', 13.3986609], ['O1', 13.9430356], ['NO1', 14.4966939], ['P1', 14.9589314],
  ['K1', 15.0410686], ['J1', 15.5854433], ['OO1', 16.1391017], ['2N2', 27.8953548], ['MU2', 27.9682084],
  ['N2', 28.4397295], ['NU2', 28.5125831], ['M2', 28.9841042], ['L2', 29.5284789], ['S2', 30.0],
  ['K2', 30.0821373], ['M3', 43.4761563], ['MN4', 57.4238337], ['M4', 57.9682084], ['MS4', 58.9841042],
  ['S4', 60.0], ['M6', 86.9523127], ['2MS6', 87.9682084],
];
const W = CON.map(([, d]) => (d * Math.PI) / 180); // rad/h
const EPOCH = Date.UTC(2000, 0, 1);
const hrs = (ms) => (ms - EPOCH) / 3600e3;

const STORE_KEY = 'lichtplan.tides.v1';
const MAX_MODELS = 40, MAX_AGE = 45 * 864e5;
const mem = new Map();
const pending = new Map();
const keyOf = (lat, lng) => `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lng * 20) / 20).toFixed(2)}`;

function loadStore() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } }
function saveStore(s) {
  const entries = Object.entries(s).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_MODELS);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(entries))); } catch {}
}

/** Sofort verfügbares Modell (aus Speicher) oder null */
export function cachedTideModel(lat, lng) {
  const k = keyOf(lat, lng);
  if (mem.has(k)) return mem.get(k);
  const s = loadStore()[k];
  if (s && Date.now() - s.at < MAX_AGE) { mem.set(k, s.model); return s.model; }
  return null;
}

/**
 * Modell laden/berechnen. Ergebnis:
 *  { coef, gridLat, gridLng, distKm, maxRange, minRange, fitted } oder { inland: true }
 */
export async function getTideModel(lat, lng) {
  const k = keyOf(lat, lng);
  const c = cachedTideModel(lat, lng);
  if (c) return c;
  if (pending.has(k)) return pending.get(k);
  const p = (async () => {
    const end = new Date(Date.now() + 6 * 864e5), start = new Date(Date.now() - 366 * 864e5);
    const d = (x) => x.toISOString().slice(0, 10);
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&hourly=sea_level_height_msl&timezone=GMT&start_date=${d(start)}&end_date=${d(end)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Gezeitendaten nicht verfügbar (HTTP ${r.status})`);
    const j = await r.json();
    if (j.error) throw new Error(j.reason || 'Gezeitendaten nicht verfügbar');
    const T = j.hourly?.time || [], V = j.hourly?.sea_level_height_msl || [];
    const data = [];
    for (let i = 0; i < T.length; i++) if (V[i] != null) data.push([hrs(Date.parse(T[i] + 'Z')), V[i]]);
    let model;
    if (data.length < 24 * 60) model = { inland: true };
    else {
      const coef = fit(data);
      const distKm = distance(lat, lng, j.latitude, j.longitude) / 1000;
      // typischer Tidenhub (für Spring-/Nipptide): Tagesbereiche über ~2 Monate
      const ranges = [];
      for (let dd = 0; dd < 60; dd++) {
        const t0 = Date.now() + dd * 864e5;
        let mn = Infinity, mx = -Infinity;
        for (let m = 0; m < 25 * 60; m += 20) { const v = evalCoef(coef, hrs(t0 + m * 60000)); if (v < mn) mn = v; if (v > mx) mx = v; }
        ranges.push(mx - mn);
      }
      model = { coef, gridLat: j.latitude, gridLng: j.longitude, distKm, maxRange: Math.max(...ranges), minRange: Math.min(...ranges), fitted: data.length };
    }
    mem.set(k, model);
    const s = loadStore(); s[k] = { at: Date.now(), model }; saveStore(s);
    window.dispatchEvent(new CustomEvent('lp-tides', { detail: { lat, lng } }));
    return model;
  })().finally(() => pending.delete(k));
  pending.set(k, p);
  return p;
}

// ── Kleinste Quadrate ───────────────────────────────────────
function basis(t, out) {
  out[0] = 1;
  for (let i = 0; i < W.length; i++) { const a = W[i] * t; out[1 + 2 * i] = Math.cos(a); out[2 + 2 * i] = Math.sin(a); }
  return out;
}
function fit(data) {
  const n = 1 + 2 * W.length;
  const A = Array.from({ length: n }, () => new Float64Array(n)), b = new Float64Array(n), r = new Float64Array(n);
  for (const [t, v] of data) {
    basis(t, r);
    for (let i = 0; i < n; i++) { const ri = r[i]; b[i] += ri * v; const Ai = A[i]; for (let j = i; j < n; j++) Ai[j] += ri * r[j]; }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];
  // Gauß mit Pivotsuche
  for (let i = 0; i < n; i++) {
    let p = i; for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let k = i + 1; k < n; k++) { const f = A[k][i] / A[i][i]; if (!f) continue; for (let c = i; c < n; c++) A[k][c] -= f * A[i][c]; b[k] -= f * b[i]; }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x.map((v) => Math.round(v * 1e5) / 1e5);
}
const tmp = new Float64Array(1 + 2 * W.length);
function evalCoef(coef, t) { basis(t, tmp); let s = 0; for (let i = 0; i < coef.length; i++) s += coef[i] * tmp[i]; return s; }

/** Wasserstand (m, relativ zum mittleren Meeresspiegel) zum Zeitpunkt */
export function tideHeight(model, date) {
  if (!model || model.inland) return null;
  return evalCoef(model.coef, hrs(date.getTime())) - model.coef[0];
}

/** Hoch- und Niedrigwasser zwischen zwei Zeitpunkten */
export function tideEvents(model, from, to) {
  if (!model || model.inland) return [];
  const step = 10 * 60000, out = [];
  let a = tideHeight(model, new Date(from.getTime() - step)), b = tideHeight(model, from);
  for (let ms = from.getTime(); ms <= to.getTime(); ms += step) {
    const c = tideHeight(model, new Date(ms + step));
    if ((b > a && b >= c) || (b < a && b <= c)) {
      const den = a - 2 * b + c, off = den ? (0.5 * (a - c)) / den : 0;
      out.push({ type: b > a ? 'high' : 'low', t: new Date(ms + off * step), h: b - 0.25 * (a - c) * off });
    }
    a = b; b = c;
  }
  return out;
}

/** Tagesdaten für die Anzeige: Kurve, Ereignisse, Hub, Spring/Nipp */
export function tideDay(model, tz, date) {
  if (!model || model.inland) return null;
  const start = startOfLocalDay(date, tz), end = addLocalDays(start, 1, tz);
  const curve = [];
  for (let ms = start.getTime(); ms <= end.getTime(); ms += 10 * 60000) curve.push({ t: new Date(ms), h: tideHeight(model, new Date(ms)) });
  const events = tideEvents(model, start, end);
  const hs = curve.map((p) => p.h);
  const range = Math.max(...hs) - Math.min(...hs);
  // Spring-/Nipptide astronomisch: Springtide ~1–2 Tage nach Neu-/Vollmond, Nipptide nach den Vierteln
  const ph = moonPhaseAngle(new Date((start.getTime() + end.getTime()) / 2 - 36 * 3600e3));
  const dSpring = Math.min(Math.abs(ph), Math.abs(ph - 180), Math.abs(ph - 360));
  const kind = dSpring < 36 ? 'Springtide' : dSpring > 54 ? 'Nipptide' : 'Mittlere Tide';
  return { start, end, curve, events, range, kind, min: Math.min(...hs), max: Math.max(...hs) };
}

/** Zustand zum Zeitpunkt: Höhe, steigend/fallend, nächstes Ereignis */
export function tideNow(model, date) {
  if (!model || model.inland) return null;
  const h = tideHeight(model, date), h2 = tideHeight(model, new Date(date.getTime() + 600000));
  const next = tideEvents(model, date, new Date(date.getTime() + 14 * 3600e3))[0] || null;
  return { h, rising: h2 > h, next };
}

/** Bedeutsamkeit: Tidenhub klein (Mittelmeer)? */
export const isMicroTidal = (model) => model && !model.inland && model.maxRange < 0.5;
