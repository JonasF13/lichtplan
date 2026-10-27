// ─────────────────────────────────────────────────────────────
// Werkzeuge für den KI-Assistenten: Die KI rechnet nie selbst –
// sie ruft die Astronomie-, Wetter- und Projektfunktionen der App auf.
// ─────────────────────────────────────────────────────────────
import { state, setState } from '../state.js';
import { store, STATUS, PROJECT_COLORS } from '../store.js';
import {
  getDay, sunPos, moonPos, gcPos, moonPhaseName, searchAlignment, searchMoonOpportunities, OPP_TYPES,
  milkyWayCalendar, observer, nextQuarters,
} from '../astro.js';
import { searchPlaces, elevations, forecast, timezoneAt } from '../services.js';
import {
  zonedParts, zonedToUtc, dayKey, fmtTime, fmtDuration, distance, bearing, elevationAngle, phaseOf, compass, wrap360,
} from '../utils.js';

let ui = {}; // { selectSpot, openSpot, flyTo, setView }
export function initTools(api) { ui = api; }

// ── Hilfsfunktionen ─────────────────────────────────────────
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r0 = (x) => (x == null ? null : Math.round(x));
export function localISO(d, tz) {
  const p = zonedParts(new Date(Math.round(d.getTime() / 60000) * 60000), tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const weekday = (d, tz) => WD[zonedParts(d, tz).wd];
/** Fertiger Markdown-Link, den die KI direkt übernehmen kann */
function tlink(t, tz, spotId, withDate = true) {
  if (!t) return null;
  const p = zonedParts(new Date(Math.round(t.getTime() / 60000) * 60000), tz);
  const hm = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  const label = withDate ? `${WD[p.wd]} ${String(p.d).padStart(2, '0')}.${String(p.m).padStart(2, '0')}. ${hm}` : hm;
  return `[${label}](lp:time/${localISO(t, tz)}${spotId ? '@' + spotId : ''})`;
}

/** "YYYY-MM-DD" → Date (Mittag Ortszeit) */
function parseDay(s, tz) {
  if (!s) return new Date(zonedToUtc(...todayParts(tz), 12, 0, tz));
  const m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) throw new Error(`Ungültiges Datum „${s}“ – erwartet YYYY-MM-DD`);
  return zonedToUtc(+m[1], +m[2], +m[3], 12, 0, tz);
}
function todayParts(tz) {
  // „heute“ = in der App gewähltes Datum
  const p = zonedParts(state.time, tz); return [p.y, p.m, p.d];
}
/** "YYYY-MM-DDTHH:MM" (Ortszeit) oder ISO mit Offset → Date */
function parseDateTime(s, tz) {
  if (!s) return state.time;
  const str = String(s).trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(str)) { const d = new Date(str); if (!isNaN(d)) return d; }
  const m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/);
  if (!m) throw new Error(`Ungültige Zeit „${s}“ – erwartet YYYY-MM-DDTHH:MM (Ortszeit)`);
  return zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
}
async function tzFor(lat, lng) {
  if (distance(lat, lng, state.lat, state.lng) < 30000) return state.tz;
  const near = store.spots.find((s) => s.tz && distance(lat, lng, s.lat, s.lng) < 30000);
  if (near) return near.tz;
  try { return (await timezoneAt(lat, lng)) || state.tz; } catch { return state.tz; }
}
/** Ort aus spot_id | lat/lng | aktuellem Standort */
async function loc(a = {}, prefix = '') {
  const sid = a[prefix + 'spot_id'];
  if (sid) {
    const s = store.spot(sid);
    if (!s) throw new Error(`Spot „${sid}“ nicht gefunden – list_spots verwenden`);
    return { lat: s.lat, lng: s.lng, elev: s.elevation || 0, tz: s.tz || (await tzFor(s.lat, s.lng)), name: s.name, spot_id: s.id };
  }
  const lat = a[prefix + 'lat'], lng = a[prefix + 'lng'];
  if (lat != null && lng != null && isFinite(+lat) && isFinite(+lng)) {
    return { lat: +lat, lng: +lng, elev: 0, tz: await tzFor(+lat, +lng), name: a[prefix + 'name'] || `${(+lat).toFixed(4)}, ${(+lng).toFixed(4)}` };
  }
  return { lat: state.lat, lng: state.lng, elev: state.elev || 0, tz: state.tz, name: state.placeName || 'aktueller Standort' };
}
const locInfo = (L) => ({ name: L.name, lat: +L.lat.toFixed(5), lng: +L.lng.toFixed(5), timezone: L.tz, ...(L.spot_id ? { spot_id: L.spot_id } : {}) });

// Gemeinsame Parameter-Schemata
const LOC = {
  spot_id: { type: 'string', description: 'ID of a saved spot (from list_spots). Optional.' },
  lat: { type: 'number', description: 'Latitude (only if no spot_id). Omit both to use the current app location.' },
  lng: { type: 'number', description: 'Longitude' },
};
const shootView = (s, sh) => ({ id: sh.id, datetime_local: localISO(new Date(sh.time), s.tz || state.tz), label: sh.label || '', done: !!sh.done });
function spotView(s, full = false) {
  const p = store.project(s.projectId);
  return {
    id: s.id, name: s.name, link: `[${s.name.replace(/[[\]]/g, '')}](lp:spot/${s.id})`, project: p ? { id: p.id, name: p.name } : null,
    lat: +s.lat.toFixed(5), lng: +s.lng.toFixed(5), timezone: s.tz || null,
    status: STATUS[s.status]?.label || s.status, rating: s.rating || 0, tags: s.tags || [],
    notes: full ? (s.notes || '') : (s.notes || '').slice(0, 160) + ((s.notes || '').length > 160 ? '…' : ''),
    target: s.target ? { lat: +s.target.lat.toFixed(5), lng: +s.target.lng.toFixed(5), bearing: r1(bearing(s.lat, s.lng, s.target.lat, s.target.lng)), distance_km: r1(distance(s.lat, s.lng, s.target.lat, s.target.lng) / 1000) } : null,
    shoots: (s.shoots || []).map((sh) => shootView(s, sh)),
  };
}

// ── Werkzeug-Definitionen ───────────────────────────────────
const TOOLS = [
  {
    name: 'get_light_times',
    description: 'Sun & moon times for one local date at a place: sunrise/sunset (with azimuth), golden hour, blue hour, twilight, solar noon, moonrise/moonset, moon phase. Use for any question about times of light.',
    parameters: { date: { type: 'string', description: 'Local date YYYY-MM-DD. Omit for the date selected in the app.' }, ...LOC },
    label: (a, r) => `Lichtzeiten · ${r?.location?.name || ''} · ${r?.date || a.date || ''}`,
    async run(a) {
      const L = await loc(a);
      const d = parseDay(a.date, L.tz);
      const day = getDay(L.lat, L.lng, L.elev, L.tz, d);
      const E = day.ev, f = (t) => (t ? fmtTime(t, L.tz) : null);
      const az = (t) => (t ? r0(sunPos(t, day.obs).az) : null);
      const span = (a1, b1) => (a1 && b1 ? `${f(a1)}–${f(b1)}` : null);
      const mid = new Date((day.start.getTime() + day.end.getTime()) / 2);
      const mp = moonPos(mid, day.obs);
      return {
        location: locInfo(L), date: dayKey(d, L.tz), weekday: weekday(d, L.tz),
        sunrise: E.sunrise ? { time: f(E.sunrise), azimuth: az(E.sunrise), direction: compass(az(E.sunrise)), link: tlink(E.sunrise, L.tz, L.spot_id, false) } : null,
        sunset: E.sunset ? { time: f(E.sunset), azimuth: az(E.sunset), direction: compass(az(E.sunset)), link: tlink(E.sunset, L.tz, L.spot_id, false) } : null,
        golden_hour_evening_link: E.goldenStart ? tlink(E.goldenStart, L.tz, L.spot_id, false) : null,
        blue_hour_evening_link: E.blueStart ? tlink(E.blueStart, L.tz, L.spot_id, false) : null,
        solar_noon: E.noon ? { time: f(E.noon), sun_altitude: r1(day.sun.noonAlt) } : null,
        day_length: fmtDuration(day.sun.dayLength),
        blue_hour_morning: span(E.civilDawn, E.blueEnd), golden_hour_morning: span(E.blueEnd, E.goldenEnd),
        golden_hour_evening: span(E.goldenStart, E.blueStart), blue_hour_evening: span(E.blueStart, E.civilDusk),
        astronomical_dawn: f(E.astroDawn), nautical_dawn: f(E.nautDawn), nautical_dusk: f(E.nautDusk), astronomical_night_starts: f(E.astroDusk),
        moon: {
          rise: day.moon.rise ? { time: f(day.moon.rise), azimuth: r0(day.moon.riseAz) } : null,
          set: day.moon.set ? { time: f(day.moon.set), azimuth: r0(day.moon.setAz) } : null,
          illumination_percent: r0(mp.illum * 100), phase: moonPhaseName(mp.phase), waxing: mp.waxing,
        },
        polar: !E.sunrise && !E.sunset ? (day.sun.maxAlt > 0 ? 'midnight sun' : 'polar night') : undefined,
      };
    },
  },
  {
    name: 'get_sky_position',
    description: 'Exact positions at one local date+time: sun & moon azimuth/altitude, light phase (golden/blue hour…), moon illumination, Milky Way core position, shadow length ratio.',
    parameters: { datetime: { type: 'string', description: 'Local time YYYY-MM-DDTHH:MM. Omit for the time selected in the app.' }, ...LOC },
    label: (a, r) => `Himmelsposition · ${r?.datetime_local?.replace('T', ' ') || ''}`,
    async run(a) {
      const L = await loc(a);
      const t = parseDateTime(a.datetime, L.tz);
      const obs = observer(L.lat, L.lng, L.elev);
      const s = sunPos(t, obs), m = moonPos(t, obs), g = gcPos(t, obs);
      return {
        location: locInfo(L), datetime_local: localISO(t, L.tz), weekday: weekday(t, L.tz),
        sun: { azimuth: r1(s.az), direction: compass(s.az), altitude: r1(s.alt), light_phase: phaseOf(s.alt).label, shadow_ratio: s.alt > 0.5 ? r1(1 / Math.tan((s.alt * Math.PI) / 180)) : null },
        moon: { azimuth: r1(m.az), direction: compass(m.az), altitude: r1(m.alt), illumination_percent: r0(m.illum * 100), phase: moonPhaseName(m.phase) },
        milky_way_core: { azimuth: r1(g.az), altitude: r1(g.alt), visible_dark_sky: g.alt > 5 && s.alt < -18 && (m.alt < 0 || m.illum < 0.08) },
      };
    },
  },
  {
    name: 'find_sun_moon_alignment',
    description: 'Search dates/times when the sun or moon stands exactly at a given direction (azimuth) and altitude – e.g. sun setting behind a mountain, moon rising next to a tower. Give a target (target_spot_id or target_lat/target_lng: azimuth & altitude are computed incl. terrain elevation) OR azimuth+altitude directly.',
    parameters: {
      body: { type: 'string', enum: ['sun', 'moon'], description: 'sun or moon' },
      target_spot_id: { type: 'string', description: 'Saved spot to align with (optional)' },
      target_lat: { type: 'number', description: 'Target latitude (optional)' },
      target_lng: { type: 'number', description: 'Target longitude (optional)' },
      azimuth: { type: 'number', description: 'Direction in degrees (0=N, 90=E, 180=S, 270=W) if no target' },
      altitude: { type: 'number', description: 'Altitude in degrees above horizon if no target (0 = horizon)' },
      altitude_tolerance: { type: 'number', description: 'Allowed altitude error in degrees, default 1' },
      months: { type: 'number', description: 'Months to search, default 12, max 24' },
      from_date: { type: 'string', description: 'Start date YYYY-MM-DD, default: date selected in app' },
      min_moon_illumination: { type: 'number', description: 'Moon only: minimum illumination percent (e.g. 90 for full moon)' },
      ...LOC,
    },
    required: ['body'],
    label: (a, r) => `Ausrichtung ${a.body === 'moon' ? 'Mond' : 'Sonne'} · ${r?.searched?.azimuth ?? a.azimuth ?? ''}° · ${r?.hits_total ?? 0} Treffer`,
    async run(a) {
      const L = await loc(a);
      let az = a.azimuth != null ? +a.azimuth : null, alt = a.altitude != null ? +a.altitude : null, target = null;
      if (a.target_spot_id || (a.target_lat != null && a.target_lng != null)) {
        const T = await loc(a, 'target_');
        const d = distance(L.lat, L.lng, T.lat, T.lng);
        az = bearing(L.lat, L.lng, T.lat, T.lng);
        let e1 = L.elev, e2 = 0;
        try { [e1, e2] = await elevations([L, T]); } catch {}
        const ang = elevationAngle(e1 || 0, e2 || 0, d);
        if (alt == null) alt = Math.max(ang, -0.8);
        target = { name: T.name, distance_km: r1(d / 1000), observer_elevation_m: r0(e1), target_elevation_m: r0(e2), elevation_angle: r1(ang) };
      } else if (az == null && state.target && !a.spot_id && a.lat == null) {
        // Ziel aus der App
        const T = state.target, d = distance(L.lat, L.lng, T.lat, T.lng);
        az = bearing(L.lat, L.lng, T.lat, T.lng);
        let e1 = L.elev, e2 = T.elev || 0;
        try { [e1, e2] = await elevations([L, T]); } catch {}
        const ang = elevationAngle(e1 || 0, e2 || 0, d);
        if (alt == null) alt = Math.max(ang, -0.8);
        target = { name: 'Ziel in der App', distance_km: r1(d / 1000), elevation_angle: r1(ang) };
      }
      if (az == null) throw new Error('azimuth oder ein Ziel (target_spot_id / target_lat+target_lng) angeben');
      if (alt == null) alt = 0;
      const months = Math.min(24, Math.max(1, +a.months || 12));
      const from = a.from_date ? parseDay(a.from_date, L.tz) : state.time;
      const hits = await searchAlignment(L.lat, L.lng, L.elev, L.tz, from, {
        body: a.body === 'moon' ? 'moon' : 'sun', az: wrap360(az), alt, altTol: Math.min(10, +a.altitude_tolerance || 1), days: Math.round(months * 30.44),
        minIllum: (+a.min_moon_illumination || 0) / 100, maxIllum: 1,
      });
      const best = [...hits].sort((x, y) => Math.abs(x.dAlt) - Math.abs(y.dAlt)).slice(0, 25).sort((x, y) => x.t - y.t);
      return {
        location: locInfo(L), target, searched: { body: a.body, azimuth: r1(wrap360(az)), altitude: r1(alt), months },
        hits_total: hits.length,
        hits: best.map((h) => ({
          datetime_local: localISO(h.t, L.tz), weekday: weekday(h.t, L.tz), link: tlink(h.t, L.tz, L.spot_id), azimuth: r1(h.az), altitude: r1(h.alt), altitude_error: r1(h.dAlt),
          light_phase: phaseOf(h.sunAlt).label, ...(h.illum != null ? { moon_illumination_percent: r0(h.illum * 100) } : {}),
        })),
      };
    },
  },
  {
    name: 'find_moon_opportunities',
    description: 'Find dates when the moon is low on the horizon (3–12°) during golden/blue hour: full moon rising in the evening, full moon setting in the morning, crescent moon evening/morning. Optionally only in a direction.',
    parameters: {
      types: { type: 'array', items: { type: 'string', enum: ['full_moon_rise_evening', 'full_moon_set_morning', 'crescent_evening', 'crescent_morning'] }, description: 'Default: all' },
      months: { type: 'number', description: 'Months to search, default 12' },
      towards_azimuth: { type: 'number', description: 'Only results with moon in this direction (degrees)' },
      azimuth_tolerance: { type: 'number', description: 'Degrees, default 10' },
      ...LOC,
    },
    label: (a, r) => `Mond-Fotogelegenheiten · ${r?.results?.length ?? 0} Termine`,
    async run(a) {
      const L = await loc(a);
      const map = { full_moon_rise_evening: 'fullrise', full_moon_set_morning: 'fullset', crescent_evening: 'cresset', crescent_morning: 'cresrise' };
      const types = (a.types?.length ? a.types : Object.keys(map)).map((t) => map[t] || t);
      const res = await searchMoonOpportunities(L.lat, L.lng, L.elev, L.tz, state.time, Math.round(Math.min(24, +a.months || 12) * 30.44), {
        types, az: a.towards_azimuth != null ? +a.towards_azimuth : null, azTol: +a.azimuth_tolerance || 10,
      });
      return {
        location: locInfo(L),
        results: res.slice(0, 40).map((o) => ({
          type: o.type.label, date: dayKey(o.t, L.tz), weekday: weekday(o.t, L.tz), window_local: `${fmtTime(o.from, L.tz)}–${fmtTime(o.to, L.tz)}`,
          best_time_local: localISO(o.t, L.tz), link: tlink(o.t, L.tz, L.spot_id), moon_azimuth: r0(o.az), moon_illumination_percent: r0(o.illum * 100), sun_altitude: r1(o.sunAlt),
        })),
      };
    },
  },
  {
    name: 'find_milky_way_nights',
    description: 'Good Milky Way nights: galactic core above 5° during astronomical darkness without moon. Returns visible window, best time and direction per night.',
    parameters: { from_date: { type: 'string', description: 'YYYY-MM-DD, default date selected in app' }, nights: { type: 'number', description: 'Number of nights to check, default 45, max 120' }, ...LOC },
    label: (a, r) => `Milchstraßen-Nächte · ${r?.good_nights?.length ?? 0} gute Nächte`,
    async run(a) {
      const L = await loc(a);
      const from = a.from_date ? parseDay(a.from_date, L.tz) : state.time;
      const n = Math.min(120, Math.max(1, +a.nights || 45));
      const cal = milkyWayCalendar(L.lat, L.lng, L.elev, L.tz, from, n);
      const good = cal.filter((x) => x.visMin >= 30);
      return {
        location: locInfo(L), nights_checked: n,
        good_nights: good.map((x) => ({
          night_of: dayKey(x.date, L.tz), weekday: weekday(x.date, L.tz), visible_local: `${fmtTime(x.visStart, L.tz)}–${fmtTime(x.visEnd, L.tz)}`,
          minutes: x.visMin, best_time_local: localISO(x.best.t, L.tz), link: tlink(x.best.t, L.tz, L.spot_id), core_azimuth: r0(x.best.az), core_altitude: r0(x.best.alt), moon_illumination_percent: r0(x.illum * 100),
        })),
        note: good.length ? undefined : 'Keine guten Nächte im Zeitraum (Kern-Saison Nordhalbkugel ca. Feb–Okt).',
      };
    },
  },
  {
    name: 'get_weather_forecast',
    description: 'Cloud forecast (total/low/mid/high %), rain probability, visibility and temperature per hour for a local date (max. 16 days ahead), plus a verdict for sunrise and sunset.',
    parameters: { date: { type: 'string', description: 'Local date YYYY-MM-DD' }, ...LOC },
    label: (a, r) => `Wetter · ${r?.date || a.date || ''}`,
    async run(a) {
      const L = await loc(a);
      const d = parseDay(a.date, L.tz);
      const key = dayKey(d, L.tz);
      const w = await forecast(L.lat, L.lng);
      const H = w.hourly;
      const hours = [];
      for (let i = 0; i < H.time.length; i++) {
        if (!H.time[i].startsWith(key)) continue;
        hours.push({ hour: +H.time[i].slice(11, 13), cloud: H.cloud_cover[i], low: H.cloud_cover_low[i], mid: H.cloud_cover_mid[i], high: H.cloud_cover_high[i], rain_prob: H.precipitation_probability?.[i], visibility_km: H.visibility?.[i] != null ? r1(H.visibility[i] / 1000) : null, temp_c: r1(H.temperature_2m?.[i]) });
      }
      if (!hours.length) return { location: locInfo(L), date: key, available: false, reason: 'Vorhersage nur bis 16 Tage im Voraus verfügbar.' };
      const day = getDay(L.lat, L.lng, L.elev, L.tz, d);
      const at = (t) => t && hours.find((h) => h.hour === zonedParts(t, L.tz).h);
      const verdict = (h) => !h ? null : h.low > 70 ? 'tiefe Wolken – schlecht' : h.high > 25 && h.high < 80 && h.low < 40 ? 'hohe Wolken – Chance auf Farben' : h.cloud < 15 ? 'klar' : h.cloud > 85 ? 'bedeckt' : 'wechselhaft';
      return {
        location: locInfo(L), date: key, available: true,
        at_sunrise: day.sun.rise ? { time: fmtTime(day.sun.rise, L.tz), ...at(day.sun.rise), verdict: verdict(at(day.sun.rise)) } : null,
        at_sunset: day.sun.set ? { time: fmtTime(day.sun.set, L.tz), ...at(day.sun.set), verdict: verdict(at(day.sun.set)) } : null,
        hourly: hours,
      };
    },
  },
  {
    name: 'geo_line',
    description: 'Distance, compass bearing, terrain elevations and elevation angle between two points (spots or coordinates). Useful to check from which direction a subject is seen.',
    parameters: {
      from_spot_id: { type: 'string' }, from_lat: { type: 'number' }, from_lng: { type: 'number' },
      to_spot_id: { type: 'string' }, to_lat: { type: 'number' }, to_lng: { type: 'number' },
    },
    label: (a, r) => `Linie · ${r?.distance_km ?? ''} km · ${r?.bearing ?? ''}°`,
    async run(a) {
      const A1 = await loc(a, 'from_'), B = await loc(a, 'to_');
      const d = distance(A1.lat, A1.lng, B.lat, B.lng), b = bearing(A1.lat, A1.lng, B.lat, B.lng);
      let e1 = null, e2 = null;
      try { [e1, e2] = await elevations([A1, B]); } catch {}
      return {
        from: locInfo(A1), to: locInfo(B), distance_km: r1(d / 1000) || +(d / 1000).toFixed(3), bearing: r1(b), direction: compass(b),
        from_elevation_m: r0(e1), to_elevation_m: r0(e2), elevation_angle: e1 != null && e2 != null ? r1(elevationAngle(e1, e2, d)) : null,
      };
    },
  },
  {
    name: 'search_place',
    description: 'Geocode a place name or address to coordinates (OpenStreetMap). Never guess coordinates – use this.',
    parameters: { query: { type: 'string', description: 'Place name, e.g. "Seceda, Dolomiten"' } },
    required: ['query'],
    label: (a) => `Ortssuche · „${a.query}“`,
    async run(a) {
      const res = await searchPlaces(a.query);
      return { results: res.slice(0, 5).map((r) => ({ name: r.name, address: r.label, lat: +r.lat.toFixed(5), lng: +r.lng.toFixed(5), type: r.type })) };
    },
  },
  {
    name: 'list_projects',
    description: 'List the user\'s photo projects (trips) with ids, date ranges and counts.',
    parameters: {},
    label: (a, r) => `Projekte gelesen · ${r?.projects?.length ?? 0}`,
    async run() {
      return {
        projects: store.allProjects.map((p) => {
          const spots = store.spotsOf(p.id);
          return { id: p.id, name: p.name, date_from: p.dateFrom, date_to: p.dateTo, description: p.description || '', archived: !!p.archived, spot_count: spots.length, shoot_count: spots.reduce((n, s) => n + (s.shoots?.length || 0), 0) };
        }),
        spots_without_project: store.spotsOf(null).length,
      };
    },
  },
  {
    name: 'list_spots',
    description: 'List saved spots (optionally of one project or matching a text) with id, coordinates, tags, status, short notes and planned shoots.',
    parameters: { project_id: { type: 'string', description: 'Only this project. Use "none" for spots without project.' }, query: { type: 'string', description: 'Filter by text in name/notes/tags' } },
    label: (a, r) => `Spots gelesen · ${r?.spots?.length ?? 0}`,
    async run(a) {
      let spots = a.project_id ? store.spotsOf(a.project_id === 'none' ? null : a.project_id) : store.spots;
      if (a.query) { const q = a.query.toLowerCase(); spots = spots.filter((s) => [s.name, s.notes, ...(s.tags || [])].join(' ').toLowerCase().includes(q)); }
      return { spots: spots.slice(0, 60).map((s) => spotView(s)), total: spots.length };
    },
  },
  {
    name: 'get_spot',
    description: 'Full details of one saved spot incl. complete notes, target and all shoots.',
    parameters: { spot_id: { type: 'string' } },
    required: ['spot_id'],
    label: (a, r) => `Spot gelesen · ${r?.name || ''}`,
    async run(a) {
      const s = store.spot(a.spot_id);
      if (!s) throw new Error(`Spot „${a.spot_id}“ nicht gefunden`);
      return spotView(s, true);
    },
  },
  {
    name: 'create_project',
    description: 'Create a new project (e.g. a trip) to organise spots.',
    parameters: { name: { type: 'string' }, date_from: { type: 'string', description: 'YYYY-MM-DD' }, date_to: { type: 'string', description: 'YYYY-MM-DD' }, description: { type: 'string' } },
    required: ['name'],
    mutates: true,
    label: (a) => `Projekt angelegt · ${a.name}`,
    async run(a) {
      const p = store.addProject({ name: a.name, dateFrom: a.date_from || null, dateTo: a.date_to || null, description: a.description || '', color: PROJECT_COLORS[store.allProjects.length % PROJECT_COLORS.length] });
      return { created: true, project_id: p.id, name: p.name };
    },
  },
  {
    name: 'create_spot',
    description: 'Save a new photo spot. Without lat/lng the current app location is used. Coordinates must come from search_place, a spot, or the app – never guessed.',
    parameters: {
      name: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' },
      project_id: { type: 'string' }, notes: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
      status: { type: 'string', enum: ['idee', 'geplant', 'erledigt'] },
    },
    required: ['name'],
    mutates: true,
    label: (a) => `Spot angelegt · ${a.name}`,
    async run(a) {
      const L = await loc(a);
      if (a.project_id && !store.project(a.project_id)) throw new Error(`Projekt „${a.project_id}“ nicht gefunden`);
      const s = store.addSpot({
        name: a.name, lat: L.lat, lng: L.lng, elevation: L.spot_id ? null : (a.lat == null ? state.elev : null), tz: L.tz,
        projectId: a.project_id || null, notes: a.notes || '', tags: Array.isArray(a.tags) ? a.tags : [], status: a.status || 'idee',
        order: store.spotsOf(a.project_id || null).length,
      });
      return { created: true, spot_id: s.id, name: s.name, link: `[${s.name.replace(/[[\]]/g, '')}](lp:spot/${s.id})`, lat: +L.lat.toFixed(5), lng: +L.lng.toFixed(5) };
    },
  },
  {
    name: 'update_spot',
    description: 'Change a saved spot: name, notes (replace or append), tags, status, rating (0-5), project, position.',
    parameters: {
      spot_id: { type: 'string' }, name: { type: 'string' }, notes: { type: 'string', description: 'Replaces notes' },
      append_notes: { type: 'string', description: 'Appended to existing notes' }, tags: { type: 'array', items: { type: 'string' }, description: 'Replaces tags' },
      status: { type: 'string', enum: ['idee', 'geplant', 'erledigt'] }, rating: { type: 'number' }, project_id: { type: 'string' },
      lat: { type: 'number' }, lng: { type: 'number' },
    },
    required: ['spot_id'],
    mutates: true,
    label: (a, r) => `Spot geändert · ${r?.name || a.spot_id}`,
    async run(a) {
      const s = store.spot(a.spot_id);
      if (!s) throw new Error(`Spot „${a.spot_id}“ nicht gefunden`);
      const patch = {};
      if (a.name) patch.name = a.name;
      if (a.notes != null) patch.notes = a.notes;
      if (a.append_notes) patch.notes = [(patch.notes ?? s.notes) || '', a.append_notes].filter(Boolean).join('\n\n');
      if (Array.isArray(a.tags)) patch.tags = a.tags;
      if (a.status && STATUS[a.status]) patch.status = a.status;
      if (a.rating != null) patch.rating = Math.max(0, Math.min(5, Math.round(+a.rating)));
      if (a.project_id) { if (!store.project(a.project_id)) throw new Error('Projekt nicht gefunden'); patch.projectId = a.project_id; }
      if (a.lat != null && a.lng != null) { patch.lat = +a.lat; patch.lng = +a.lng; patch.tz = await tzFor(+a.lat, +a.lng); }
      store.updateSpot(s.id, patch);
      return { updated: true, spot_id: s.id, name: s.name, changed: Object.keys(patch) };
    },
  },
  {
    name: 'add_shoot',
    description: 'Add a planned shoot (date + local time + label) to a saved spot, e.g. "Sonnenuntergang".',
    parameters: { spot_id: { type: 'string' }, datetime: { type: 'string', description: 'Local time at the spot, YYYY-MM-DDTHH:MM' }, label: { type: 'string' }, notes: { type: 'string' } },
    required: ['spot_id', 'datetime'],
    mutates: true,
    label: (a, r) => `Termin hinzugefügt · ${r?.spot || ''} · ${(r?.datetime_local || a.datetime || '').replace('T', ' ')}`,
    async run(a) {
      const s = store.spot(a.spot_id);
      if (!s) throw new Error(`Spot „${a.spot_id}“ nicht gefunden`);
      const tz = s.tz || (await tzFor(s.lat, s.lng));
      const t = parseDateTime(a.datetime, tz);
      const sh = store.addShoot(s.id, { time: t.toISOString(), label: a.label || '', notes: a.notes || '' });
      const sp = sunPos(t, observer(s.lat, s.lng, s.elevation || 0));
      return { added: true, shoot_id: sh.id, spot: s.name, datetime_local: localISO(t, tz), link: tlink(t, tz, s.id), light_phase: phaseOf(sp.alt).label };
    },
  },
  {
    name: 'show_in_app',
    description: 'Show something to the user in the app: open a spot, move the map to coordinates, set the date/time, set a target point, or switch view (map / streetview / sky).',
    parameters: {
      spot_id: { type: 'string' }, lat: { type: 'number' }, lng: { type: 'number' }, name: { type: 'string', description: 'Place name for lat/lng' },
      datetime: { type: 'string', description: 'Local time YYYY-MM-DDTHH:MM' },
      target_lat: { type: 'number' }, target_lng: { type: 'number' },
      view: { type: 'string', enum: ['map', 'streetview', 'sky'] },
    },
    label: (a) => `In der App angezeigt${a.datetime ? ' · ' + a.datetime.replace('T', ' ') : ''}`,
    async run(a) {
      const done = [];
      if (a.spot_id) {
        if (!store.spot(a.spot_id)) throw new Error('Spot nicht gefunden');
        ui.selectSpot?.(a.spot_id); ui.openSpot?.(a.spot_id); done.push('spot');
      } else if (a.lat != null && a.lng != null) {
        setState({ lat: +a.lat, lng: +a.lng, placeName: a.name || '', activeSpotId: null });
        ui.flyTo?.(+a.lat, +a.lng, 14); done.push('location');
      }
      if (a.target_lat != null && a.target_lng != null) { setState({ target: { lat: +a.target_lat, lng: +a.target_lng, elev: null } }); done.push('target'); }
      if (a.datetime) {
        const tz = a.spot_id ? store.spot(a.spot_id).tz || state.tz : a.lat != null ? await tzFor(+a.lat, +a.lng) : state.tz;
        setState({ time: parseDateTime(a.datetime, tz) }); done.push('time');
      }
      if (a.view) { ui.setView?.({ map: 'map', streetview: 'sv', sky: 'sky' }[a.view] || 'map'); done.push('view'); }
      return { shown: done };
    },
  },
];

export const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
export function toolDefs() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name, description: t.description,
      parameters: { type: 'object', properties: t.parameters, ...(t.required ? { required: t.required } : {}) },
    },
  }));
}
export async function runTool(name, argsText) {
  const t = TOOL_MAP[name];
  if (!t) return { error: `Unbekanntes Werkzeug „${name}“` };
  let args = {};
  try { args = typeof argsText === 'string' ? (argsText.trim() ? JSON.parse(argsText) : {}) : argsText || {}; } catch { return { error: 'Argumente sind kein gültiges JSON' }; }
  // leere Strings/Null-Werte entfernen (kleine Modelle füllen gerne alles aus)
  for (const k of Object.keys(args)) if (args[k] === '' || args[k] === null) delete args[k];
  try { return await t.run(args); } catch (e) { return { error: e.message || String(e) }; }
}

/** Kompakter Kontext für den System-Prompt */
export function appContext() {
  const tz = state.tz;
  const now = new Date();
  const day = getDay(state.lat, state.lng, state.elev, tz, state.time);
  const s = sunPos(state.time, day.obs), m = moonPos(state.time, day.obs);
  const p = store.project(state.activeProjectId), sp = store.spot(state.activeSpotId);
  const lines = [
    `- Heute (echtes Datum): ${WD[zonedParts(now, tz).wd]} ${localISO(now, tz).replace('T', ' ')} (${tz})`,
    `- Standort in der App: ${state.placeName || 'ohne Namen'} · ${state.lat.toFixed(5)}, ${state.lng.toFixed(5)}${state.elev ? ` · ${Math.round(state.elev)} m` : ''} · Zeitzone ${tz}`,
    `- In der App gewählter Zeitpunkt: ${weekday(state.time, tz)} ${localISO(state.time, tz).replace('T', ' ')} Ortszeit · Sonne ${s.alt.toFixed(1)}° (${phaseOf(s.alt).label}), Az ${Math.round(s.az)}° · Mond ${Math.round(m.illum * 100)} %`,
    `- Sonnenaufgang/-untergang an diesem Tag: ${fmtTime(day.sun.rise, tz)} (${Math.round(day.sun.riseAz ?? 0)}°) / ${fmtTime(day.sun.set, tz)} (${Math.round(day.sun.setAz ?? 0)}°)`,
  ];
  if (state.target) lines.push(`- Ziel gesetzt: ${state.target.lat.toFixed(5)}, ${state.target.lng.toFixed(5)} · Richtung ${Math.round(bearing(state.lat, state.lng, state.target.lat, state.target.lng))}° · ${(distance(state.lat, state.lng, state.target.lat, state.target.lng) / 1000).toFixed(2)} km`);
  if (p) lines.push(`- Offenes Projekt: „${p.name}“ (id ${p.id})${p.dateFrom ? `, Reise ${p.dateFrom} bis ${p.dateTo || p.dateFrom}` : ''}, ${store.spotsOf(p.id).length} Spots`);
  if (sp) lines.push(`- Ausgewählter Spot: „${sp.name}“ (id ${sp.id})`);
  lines.push(`- Gespeichert insgesamt: ${store.allProjects.length} Projekte, ${store.spots.length} Spots`);
  return lines.join('\n');
}
