// ─────────────────────────────────────────────────────────────
// Astronomie: Sonne, Mond, Milchstraße – basiert auf astronomy-engine
// ─────────────────────────────────────────────────────────────
import { startOfLocalDay, addLocalDays, wrap180, wrap360, zonedParts, zonedToUtc } from './utils.js';

const A = window.Astronomy;
const SUN = A.Body.Sun, MOON = A.Body.Moon;
// Galaktisches Zentrum (Sgr A*), J2000
const GC = { ra: 17 + 45 / 60 + 40.04 / 3600, dec: -(29 + 0 / 60 + 28.1 / 3600) };

export const observer = (lat, lng, elev = 0) => new A.Observer(lat, lng, elev || 0);

export function sunPos(date, obs) { return bodyPos(SUN, date, obs); }
export function moonPos(date, obs) {
  const p = bodyPos(MOON, date, obs);
  const ill = A.Illumination(MOON, date);
  p.illum = ill.phase_fraction;
  p.phase = A.MoonPhase(date); // 0 Neumond · 90 erstes Viertel · 180 Vollmond · 270 letztes Viertel
  p.waxing = p.phase < 180;
  return p;
}
export function gcPos(date, obs) {
  const h = A.Horizon(date, obs, GC.ra, GC.dec, 'normal');
  return { az: h.azimuth, alt: h.altitude };
}
function bodyPos(body, date, obs) {
  const eq = A.Equator(body, date, obs, true, true);
  const h = A.Horizon(date, obs, eq.ra, eq.dec, 'normal');
  return { az: h.azimuth, alt: h.altitude, dist: eq.dist };
}

const t = (x) => (x ? x.date : null);
const riseSet = (body, obs, dir, from, days = 1) => { try { return t(A.SearchRiseSet(body, obs, dir, from, days)); } catch { return null; } };
const altCross = (body, obs, dir, from, days, alt) => { try { return t(A.SearchAltitude(body, obs, dir, from, days, alt)); } catch { return null; } };
const within = (d, a, b) => d && d >= a && d < b ? d : null;

// ── Tagesdaten (gecached) ───────────────────────────────────
const dayCache = new Map();
export function getDay(lat, lng, elev, tz, date) {
  const start = startOfLocalDay(date, tz);
  const key = `${lat.toFixed(4)}|${lng.toFixed(4)}|${Math.round(elev || 0)}|${tz}|${start.getTime()}`;
  if (dayCache.has(key)) return dayCache.get(key);
  const end = addLocalDays(start, 1, tz);
  const obs = observer(lat, lng, elev);
  const dayLen = (end - start) / 86400000;

  const S = (dir, alt) => within(altCross(SUN, obs, dir, start, dayLen, alt), start, end);
  const sunrise = within(riseSet(SUN, obs, +1, start, dayLen), start, end);
  const sunset = within(riseSet(SUN, obs, -1, start, dayLen), start, end);
  let noon = null;
  try { noon = A.SearchHourAngle(SUN, obs, 0, start, +1).time.date; } catch {}
  const ev = {
    astroDawn: S(+1, -18), nautDawn: S(+1, -12), civilDawn: S(+1, -6), blueEnd: S(+1, -4),
    sunrise, goldenEnd: S(+1, 6), noon,
    goldenStart: S(-1, 6), sunset, blueStart: S(-1, -4), civilDusk: S(-1, -6), nautDusk: S(-1, -12), astroDusk: S(-1, -18),
  };
  const moonrise = within(riseSet(MOON, obs, +1, start, dayLen), start, end);
  const moonset = within(riseSet(MOON, obs, -1, start, dayLen), start, end);

  const sunPath = [], moonPath = [], gcPath = [];
  const step = 10 * 60000;
  for (let ms = start.getTime(); ms <= end.getTime(); ms += step) {
    const d = new Date(ms);
    const s = sunPos(d, obs), m = bodyPos(MOON, d, obs), g = gcPos(d, obs);
    sunPath.push({ t: d, az: s.az, alt: s.alt });
    moonPath.push({ t: d, az: m.az, alt: m.alt });
    gcPath.push({ t: d, az: g.az, alt: g.alt });
  }
  const noonPos = noon ? sunPos(noon, obs) : null;
  const res = {
    start, end, obs, ev,
    sun: {
      rise: sunrise, set: sunset, noon,
      riseAz: sunrise ? sunPos(sunrise, obs).az : null,
      setAz: sunset ? sunPos(sunset, obs).az : null,
      noonAlt: noonPos?.alt ?? null,
      dayLength: sunrise && sunset ? sunset - sunrise : null,
      maxAlt: Math.max(...sunPath.map((p) => p.alt)),
    },
    moon: {
      rise: moonrise, set: moonset,
      riseAz: moonrise ? bodyPos(MOON, moonrise, obs).az : null,
      setAz: moonset ? bodyPos(MOON, moonset, obs).az : null,
      noonIllum: A.Illumination(MOON, new Date((start.getTime() + end.getTime()) / 2)).phase_fraction,
    },
    sunPath, moonPath, gcPath,
  };
  if (dayCache.size > 300) dayCache.clear();
  dayCache.set(key, res);
  return res;
}

// ── Mondphasen ──────────────────────────────────────────────
export const QUARTER_NAMES = ['Neumond', 'Erstes Viertel', 'Vollmond', 'Letztes Viertel'];
export function moonPhaseName(phase) {
  const p = wrap360(phase);
  if (p < 6 || p >= 354) return 'Neumond';
  if (p < 84) return 'Zunehmende Sichel';
  if (p < 96) return 'Erstes Viertel';
  if (p < 174) return 'Zunehmender Mond';
  if (p < 186) return 'Vollmond';
  if (p < 264) return 'Abnehmender Mond';
  if (p < 276) return 'Letztes Viertel';
  return 'Abnehmende Sichel';
}
export function nextQuarters(date, n = 8) {
  const out = [];
  let q = A.SearchMoonQuarter(date);
  for (let i = 0; i < n; i++) { out.push({ quarter: q.quarter, name: QUARTER_NAMES[q.quarter], time: q.time.date }); q = A.NextMoonQuarter(q); }
  return out;
}
export function seasons(year) {
  const s = A.Seasons(year);
  return [
    { key: 'mar', name: 'Frühlings-Tagundnachtgleiche', time: s.mar_equinox.date },
    { key: 'jun', name: 'Sommersonnenwende', time: s.jun_solstice.date },
    { key: 'sep', name: 'Herbst-Tagundnachtgleiche', time: s.sep_equinox.date },
    { key: 'dec', name: 'Wintersonnenwende', time: s.dec_solstice.date },
  ];
}
export function moonIllum(date) { return A.Illumination(MOON, date).phase_fraction; }
export function moonPhaseAngle(date) { return A.MoonPhase(date); }

// ── Milchstraße ─────────────────────────────────────────────
/** Dunkle Zeit + Sichtbarkeit des galaktischen Zentrums für die Nacht, die am lokalen Tag `date` beginnt */
export function milkyWayNight(lat, lng, elev, tz, date, minAlt = 5) {
  const day = getDay(lat, lng, elev, tz, date);
  const obs = day.obs;
  const from = day.ev.sunset || new Date(day.start.getTime() + 12 * 3600e3);
  const to = new Date(from.getTime() + 18 * 3600e3);
  const step = 10 * 60000;
  let darkStart = null, darkEnd = null, visStart = null, visEnd = null, best = null, visMin = 0, darkMin = 0;
  let moonFreeMin = 0;
  for (let ms = from.getTime(); ms <= to.getTime(); ms += step) {
    const d = new Date(ms);
    const s = sunPos(d, obs);
    if (s.alt > 0 && ms > from.getTime() + 3600e3) break; // nächster Morgen
    const dark = s.alt < -18;
    if (dark) { darkStart ??= d; darkEnd = d; darkMin += 10; }
    if (!dark) continue;
    const m = bodyPos(MOON, d, obs);
    const moonOk = m.alt < 0 || moonIllum(d) < 0.08;
    if (moonOk) moonFreeMin += 10;
    const g = gcPos(d, obs);
    if (g.alt > minAlt && moonOk) {
      visStart ??= d; visEnd = d; visMin += 10;
      const score = g.alt;
      if (!best || score > best.alt) best = { t: d, az: g.az, alt: g.alt };
    }
  }
  return { darkStart, darkEnd, darkMin, visStart, visEnd, visMin, best, moonFreeMin, illum: moonIllum(from) };
}
export function milkyWayCalendar(lat, lng, elev, tz, date, nights = 60) {
  const out = [];
  for (let i = 0; i < nights; i++) {
    const d = addLocalDays(startOfLocalDay(date, tz), i, tz);
    const n = milkyWayNight(lat, lng, elev, tz, new Date(d.getTime() + 12 * 3600e3));
    out.push({ date: d, ...n });
  }
  return out;
}

// ── Ausrichtung: Wann steht Sonne/Mond bei Azimut X & Höhe Y? ──
/**
 * Durchsucht `days` Tage ab `from`. Liefert Treffer, wo das Gestirn den Ziel-Azimut kreuzt
 * und die Höhe innerhalb der Toleranz liegt.
 * opts: { body:'sun'|'moon', az, alt, altTol, azTol, days, minIllum, maxIllum, onProgress }
 */
export async function searchAlignment(lat, lng, elev, tz, from, opts) {
  const obs = observer(lat, lng, elev);
  const body = opts.body === 'moon' ? MOON : SUN;
  const pos = (d) => bodyPos(body, d, obs);
  const step = 6 * 60000;
  const start = startOfLocalDay(from, tz).getTime();
  const end = start + opts.days * 86400000;
  const hits = [];
  let prev = null;
  let lastYield = performance.now();
  for (let ms = start; ms <= end; ms += step) {
    const d = new Date(ms);
    const p = pos(d);
    const diff = wrap180(p.az - opts.az);
    if (prev && Math.sign(diff) !== Math.sign(prev.diff) && Math.abs(diff) < 30 && Math.abs(prev.diff) < 30) {
      // Bisektion
      let a = ms - step, b = ms, da = prev.diff;
      for (let i = 0; i < 18; i++) {
        const mid = (a + b) / 2, dm = wrap180(pos(new Date(mid)).az - opts.az);
        if (Math.sign(dm) === Math.sign(da)) { a = mid; da = dm; } else b = mid;
      }
      const tHit = new Date((a + b) / 2), ph = pos(tHit);
      if (Math.abs(ph.alt - opts.alt) <= opts.altTol && ph.alt > -2) {
        let illum = null, phase = null;
        if (body === MOON) { illum = moonIllum(tHit); phase = moonPhaseAngle(tHit); }
        const ok = body !== MOON || (illum >= (opts.minIllum ?? 0) && illum <= (opts.maxIllum ?? 1));
        if (ok) {
          const s = sunPos(tHit, obs);
          hits.push({ t: tHit, az: ph.az, alt: ph.alt, illum, phase, sunAlt: s.alt, dAlt: ph.alt - opts.alt });
        }
      }
    }
    prev = { diff };
    if (performance.now() - lastYield > 30) {
      opts.onProgress?.((ms - start) / (end - start));
      await new Promise((r) => setTimeout(r, 0));
      if (opts.signal?.aborted) return hits;
      lastYield = performance.now();
    }
  }
  return hits;
}

// ── Fotogelegenheiten: Mond am Horizont zur Dämmerung ───────
export const OPP_TYPES = [
  { key: 'fullrise', label: 'Vollmond-Aufgang am Abend', minIll: 0.96, maxIll: 1, dir: +1, evening: true },
  { key: 'fullset', label: 'Vollmond-Untergang am Morgen', minIll: 0.96, maxIll: 1, dir: -1, evening: false },
  { key: 'cresset', label: 'Zunehmende Sichel am Abend', minIll: 0.04, maxIll: 0.25, dir: -1, evening: true, waxing: true },
  { key: 'cresrise', label: 'Abnehmende Sichel am Morgen', minIll: 0.04, maxIll: 0.25, dir: +1, evening: false, waxing: false },
];
export async function searchMoonOpportunities(lat, lng, elev, tz, from, days = 365, opts = {}) {
  const obs = observer(lat, lng, elev);
  const altMin = opts.altMin ?? 3, altMax = opts.altMax ?? 12;
  const out = [];
  let lastYield = performance.now();
  for (let i = 0; i < days; i++) {
    const d0 = addLocalDays(startOfLocalDay(from, tz), i, tz);
    const mid = new Date(d0.getTime() + 12 * 3600e3);
    const ill = moonIllum(mid), ph = moonPhaseAngle(mid);
    for (const T of OPP_TYPES) {
      if (opts.types && !opts.types.includes(T.key)) continue;
      if (ill < T.minIll - 0.03 || ill > T.maxIll + 0.01) continue;
      if (T.waxing != null && (ph < 180) !== T.waxing) continue;
      // Zeitfenster der Sonne: abends +4° → −6° (fallend), morgens −6° → +4° (steigend)
      const sDir = T.evening ? -1 : +1;
      const sA = altCross(SUN, obs, sDir, d0, 1, T.evening ? 4 : -6);
      const sB = altCross(SUN, obs, sDir, d0, 1, T.evening ? -6 : 4);
      if (!sA || !sB) continue;
      // Mondfenster: Höhe zwischen altMin und altMax
      const searchFrom = new Date(Math.min(sA, sB) - 4 * 3600e3);
      const mA = altCross(MOON, obs, T.dir, searchFrom, 0.5, T.dir > 0 ? altMin : altMax);
      const mB = altCross(MOON, obs, T.dir, searchFrom, 0.5, T.dir > 0 ? altMax : altMin);
      if (!mA || !mB) continue;
      const lo = Math.max(Math.min(sA, sB), Math.min(mA, mB)), hi = Math.min(Math.max(sA, sB), Math.max(mA, mB));
      if (hi <= lo) continue;
      const tBest = new Date((lo + hi) / 2);
      const mp = moonPos(tBest, obs), sp = sunPos(tBest, obs);
      if (mp.illum < T.minIll || mp.illum > T.maxIll) continue;
      if (opts.az != null && Math.abs(wrap180(mp.az - opts.az)) > (opts.azTol ?? 10)) continue;
      out.push({ type: T, t: tBest, from: new Date(lo), to: new Date(hi), az: mp.az, alt: mp.alt, illum: mp.illum, sunAlt: sp.alt });
    }
    if (performance.now() - lastYield > 30) { opts.onProgress?.(i / days); await new Promise((r) => setTimeout(r, 0)); lastYield = performance.now(); }
  }
  return out;
}

/** Jahres-Überblick: Sonnenauf/-untergangs-Azimut & Mondbeleuchtung pro Tag */
const yearCache = new Map();
export function yearOverview(lat, lng, tz, year) {
  const key = `${lat.toFixed(2)}|${lng.toFixed(2)}|${tz}|${year}`;
  if (yearCache.has(key)) return yearCache.get(key);
  const days = [];
  let d = zonedToUtc(year, 1, 1, 22, 0, tz);
  while (zonedParts(d, tz).y === year) {
    days.push({ t: d, illum: moonIllum(d), phase: moonPhaseAngle(d) });
    d = addLocalDays(d, 1, tz);
  }
  yearCache.set(key, days);
  return days;
}
