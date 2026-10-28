// ─────────────────────────────────────────────────────────────
// Ortsinfo für Spots – nur freie Quellen, ohne Key:
//  · Fotos: Wikimedia Commons (frei lizenziert, mit Ortsangabe)
//  · Fakten: Wikipedia (Deutsch, Landessprache, Englisch)
//  · Parken/Anreise: OpenStreetMap (Nominatim, Overpass) + Fußweg (FOSSGIS-Routing)
//  · „Gut zu wissen“: Schutzgebiete, Flugplätze (Drohnen), Toiletten, Trinkwasser, ÖPNV
// Ergebnisse werden 30 Tage zwischengespeichert (auch offline verfügbar).
// ─────────────────────────────────────────────────────────────
import { distance, bearing, compass } from './utils.js';

const CACHE_KEY = 'lichtplan.placeinfo.v1';
const TTL = 30 * 864e5;
const keyOf = (lat, lng) => `${lat.toFixed(4)},${lng.toFixed(4)}`;
const inflight = new Map();

function cacheAll() { try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; } }
export function cachedPlaceInfo(lat, lng) {
  const c = cacheAll()[keyOf(lat, lng)];
  return c && Date.now() - c.at < TTL ? c.info : null;
}
function saveInfo(lat, lng, info) {
  const all = cacheAll();
  all[keyOf(lat, lng)] = { at: Date.now(), info };
  const entries = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, 80);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries))); } catch {}
}
export function updateCachedInfo(lat, lng, patch) {
  const info = cachedPlaceInfo(lat, lng); if (!info) return;
  saveInfo(lat, lng, { ...info, ...patch });
}

async function getJSON(url, { timeout = 15000, body } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, ...(body ? { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
/** Wikimedia-API mit Wiederholung, falls die Suche überlastet ist */
async function wmQuery(url) {
  for (let i = 0; i < 4; i++) {
    const r = await getJSON(url, { timeout: 15000 });
    if (r?.error) {
      if (/busy|too many|try again/i.test(r.error.info || '') && i < 3) { await wait(1200 * (i + 1) + Math.random() * 500); continue; }
      throw new Error(r.error.info || 'Wikimedia-Fehler');
    }
    return r;
  }
  throw new Error('Wikimedia überlastet');
}
const strip = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ortsinfo laden. onPartial(info) wird mit jedem fertigen Teil aufgerufen.
 * info = { photos, wiki, parking, walk, transit, notes, country, done }
 */
export function loadPlaceInfo(lat, lng, { onPartial, force, hint = '' } = {}) {
  const k = keyOf(lat, lng);
  if (!force) { const c = cachedPlaceInfo(lat, lng); if (c?.done && c.complete) { onPartial?.(c); return Promise.resolve(c); } }
  if (inflight.has(k)) { inflight.get(k).listeners.add(onPartial); return inflight.get(k).p; }
  const listeners = new Set([onPartial]);
  const info = { photos: null, wiki: null, parking: null, walk: null, transit: null, notes: null, country: null, done: false };
  const emit = () => listeners.forEach((f) => f?.({ ...info }));
  const p = (async () => {
    const country = await reverseCountry(lat, lng).catch(() => null);
    info.country = country;
    let failed = false;
    const photoP = photos(lat, lng).catch(() => { failed = true; return null; });
    await Promise.allSettled([
      wiki(lat, lng, country, hint).then((x) => { info.wiki = x; emit(); }).catch(() => { failed = true; info.wiki = []; emit(); }),
      photoP.then(async (x) => {
        if (x?.length) { info.photos = x; emit(); return; }
        // Ersatz: Bilder der Wikipedia-Artikel in der Umgebung
        for (let i = 0; i < 40 && !info.wiki; i++) await wait(250);
        info.photos = (info.wiki || []).filter((w) => w.thumb).map((w) => ({ thumb: w.thumb, full: w.thumb.replace(/\/\d+px-/, '/1280px-'), page: w.url, title: w.title, author: '', license: 'Wikipedia', dist: w.dist }));
        emit();
      }),
      (async () => {
        info.parking = await parking(lat, lng).catch(() => { failed = true; return []; }); emit();
        if (info.parking[0]) { info.walk = await walkRoute(info.parking[0], { lat, lng }).catch(() => null); emit(); }
      })(),
      osmContext(lat, lng).then((x) => { info.transit = x.transit; info.notes = x.notes; emit(); })
        .catch(async () => {
          failed = true;
          info.notes = await notesFallback(lat, lng).catch(() => []); info.transit = info.transit || []; emit();
        }),
    ]);
    info.done = true; info.complete = !failed; emit();
    saveInfo(lat, lng, info);
    return info;
  })().finally(() => inflight.delete(k));
  inflight.set(k, { p, listeners });
  return p;
}

// ── Land (für Wikipedia-Sprache) ────────────────────────────
async function reverseCountry(lat, lng) {
  const r = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=8&accept-language=de&lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}`, { timeout: 8000 });
  return r?.address?.country_code || null;
}
const LANG = { it: 'it', si: 'sl', hr: 'hr', fr: 'fr', es: 'es', pt: 'pt', gr: 'el', nl: 'nl', no: 'no', se: 'sv', dk: 'da', pl: 'pl', cz: 'cs', sk: 'sk', hu: 'hu', at: 'de', de: 'de', ch: 'de', is: 'is', gb: 'en', ie: 'en', us: 'en', ca: 'en', au: 'en', nz: 'en' };

// ── Fotos (Wikimedia Commons) ───────────────────────────────
async function photos(lat, lng) {
  let pages = [];
  for (const radius of [2500, 7000]) {
    const r = await wmQuery(`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=geosearch&ggscoord=${lat}|${lng}&ggsradius=${radius}&ggsnamespace=6&ggslimit=40&prop=imageinfo|coordinates&iiprop=url|extmetadata|mime&iiurlwidth=640&iiextmetadatafilter=Artist|LicenseShortName|ImageDescription|ObjectName`);
    pages = Object.values(r?.query?.pages || {});
    if (pages.length >= 4) break;
  }
  return pages
    .map((p) => {
      const ii = p.imageinfo?.[0]; if (!ii || !/jpeg|png|webp/.test(ii.mime || '')) return null;
      const c = p.coordinates?.[0];
      const md = ii.extmetadata || {};
      const title = strip(md.ObjectName?.value) || p.title.replace(/^File:|\.[a-z]+$/gi, '').replace(/_/g, ' ');
      if (/\b(map|karte|mappa|logo|wappen|stemma|coat of arms|plan|diagram)\b/i.test(title)) return null;
      return {
        thumb: ii.thumburl, full: ii.thumburl?.replace(/\/\d+px-/, '/1600px-') || ii.url, page: ii.descriptionurl,
        title, author: strip(md.Artist?.value).slice(0, 80), license: strip(md.LicenseShortName?.value),
        dist: c ? distance(lat, lng, c.lat, c.lon) : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.dist ?? 9e9) - (b.dist ?? 9e9))
    .slice(0, 12);
}

// ── Wikipedia (Deutsch, Landessprache, Englisch) ────────────
const norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const SETTLEMENT = /(einwohner|gemeinde|ortschaft|ortsteil|dorf|stadtteil|village|inhabitants|population|municipality|settlement|hamlet|naselje|prebival|abitanti|comune|frazione|commune|habitants|municipio|habitantes)/i;
async function wiki(lat, lng, country, hint = '') {
  // Deutsch zuerst, dann Englisch, dann Landessprache
  const langs = [...new Set(['de', 'en', LANG[country] || 'en'])];
  const words = norm(hint).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !/^(wasserfall|aussicht|parkplatz|sonnenuntergang|sonnenaufgang|spot|ueber|nach|blick|beim|from|with)$/.test(w));
  const lists = await Promise.all(langs.map((lang) => wmQuery(
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&generator=geosearch&ggscoord=${lat}|${lng}&ggsradius=10000&ggslimit=10&prop=extracts|pageimages|coordinates|pageprops|info&inprop=url&ppprop=wikibase_item&exintro=1&explaintext=1&exsentences=3&exlimit=10&piprop=thumbnail&pithumbsize=320`,
  ).then((r) => Object.values(r?.query?.pages || {}).map((p) => ({ ...p, lang }))).catch(() => [])));
  const byItem = new Map();
  for (const p of lists.flat()) {
    if (!p.extract || p.extract.length < 40) continue;
    const c = p.coordinates?.[0];
    const item = p.pageprops?.wikibase_item || `${p.lang}:${p.title}`;
    const entry = { title: p.title, lang: p.lang, extract: p.extract.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim(), url: p.fullurl, thumb: p.thumbnail?.source, dist: c ? distance(lat, lng, c.lat, c.lon) : null };
    const prev = byItem.get(item);
    const rank = (e) => langs.indexOf(e.lang); // Deutsch bevorzugt
    if (!prev || rank(entry) < rank(prev)) byItem.set(item, entry);
  }
  // Sehenswertes vor Ortschaften; Artikel, die zum Spot-Namen/den Notizen passen, zuerst
  const score = (e) => (e.dist ?? 9000) + (SETTLEMENT.test(e.extract.split('. ')[0]) ? 2500 : 0) - (words.some((w) => norm(e.title).includes(w)) ? 6000 : 0);
  return [...byItem.values()].sort((a, b) => score(a) - score(b)).slice(0, 5);
}

// ── Parken (Nominatim, schnell) ─────────────────────────────
async function parking(lat, lng) {
  const d = 0.02;
  const r = await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=parking&extratags=1&limit=12&bounded=1&viewbox=${lng - d * 1.3},${lat + d},${lng + d * 1.3},${lat - d}`, { timeout: 10000 });
  return (r || [])
    .filter((x) => x.category === 'amenity' && /parking/.test(x.type))
    .map((x) => {
      const t = x.extratags || {};
      const la = +x.lat, lo = +x.lon;
      return {
        name: x.name || t.name || null, lat: la, lng: lo, dist: distance(lat, lng, la, lo), dir: compass(bearing(lat, lng, la, lo)),
        fee: t.fee === 'yes' ? 'gebührenpflichtig' : t.fee === 'no' ? 'kostenlos' : null,
        capacity: t.capacity ? +t.capacity : null, access: t.access && t.access !== 'yes' ? t.access : null,
        surface: t.surface || null, hours: t.opening_hours || null, kind: t.parking || null,
      };
    })
    .filter((p) => p.access !== 'private')
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 4);
}

// ── Fußweg vom Parkplatz (FOSSGIS OSRM, Profil „zu Fuß“) ────
async function walkRoute(from, to) {
  const r = await getJSON(`https://routing.openstreetmap.de/routed-foot/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false`, { timeout: 10000 });
  const rt = r?.routes?.[0]; if (!rt) return null;
  return { meters: Math.round(rt.distance), minutes: Math.max(1, Math.round(rt.duration / 60)) };
}

// ── Umgebung (Overpass, mehrere Server parallel) ────────────
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
async function overpass(q) {
  const body = 'data=' + encodeURIComponent(q);
  return Promise.any(OVERPASS.map((u) => getJSON(u, { body, timeout: 25000 }).then((r) => { if (!r?.elements) throw new Error('leer'); return r; })));
}
async function osmContext(lat, lng) {
  const q = `[out:json][timeout:20];(
    nwr(around:1500,${lat},${lng})["highway"="bus_stop"];
    nwr(around:2500,${lat},${lng})["railway"~"^(station|halt)$"];
    nwr(around:1000,${lat},${lng})["amenity"="toilets"];
    nwr(around:800,${lat},${lng})["amenity"="drinking_water"];
    nwr(around:9000,${lat},${lng})["aeroway"~"^(aerodrome|airstrip|heliport)$"];
    nwr(around:400,${lat},${lng})["tourism"~"^(attraction|viewpoint|museum)$"]["opening_hours"];
  );out center tags 40;
  is_in(${lat},${lng})->.a;(area.a["boundary"~"^(protected_area|national_park)$"];area.a["leisure"="nature_reserve"];);out tags 5;`;
  const r = await overpass(q);
  const els = r.elements || [];
  const pos = (e) => ({ la: e.lat ?? e.center?.lat, lo: e.lon ?? e.center?.lon });
  const dist = (e) => { const { la, lo } = pos(e); return la != null ? distance(lat, lng, la, lo) : null; };
  const transit = els.filter((e) => e.tags?.highway === 'bus_stop' || e.tags?.railway)
    .map((e) => ({ name: e.tags.name || (e.tags.railway ? 'Bahnhof' : 'Bushaltestelle'), type: e.tags.railway ? 'train' : 'bus', dist: dist(e) }))
    .filter((t) => t.dist != null).sort((a, b) => a.dist - b.dist)
    .filter((t, i, arr) => arr.findIndex((x) => x.name === t.name) === i).slice(0, 3);
  const notes = [];
  for (const a of els.filter((e) => e.type === 'area')) {
    const n = a.tags.name || 'Schutzgebiet';
    const np = a.tags.boundary === 'national_park';
    notes.push({ icon: 'mountain', kind: 'protect', text: `${np ? 'Nationalpark' : 'Naturschutzgebiet'} „${n}“ – Wege nicht verlassen; Drohnenflug ist dort meist verboten oder genehmigungspflichtig.` });
  }
  const air = els.filter((e) => e.tags?.aeroway).map((e) => ({ n: e.tags.name || 'Flugplatz', d: dist(e), t: e.tags.aeroway })).sort((a, b) => a.d - b.d)[0];
  if (air && air.d != null) notes.push({ icon: 'satellite', kind: 'drone', text: `${air.t === 'heliport' ? 'Hubschrauberlandeplatz' : 'Flugplatz'} „${air.n}“ ${(air.d / 1000).toFixed(1).replace('.', ',')} km entfernt – Drohnenflug in der Nähe nur mit Genehmigung.` });
  const wc = els.filter((e) => e.tags?.amenity === 'toilets').map(dist).filter((d) => d != null).sort((a, b) => a - b)[0];
  notes.push(wc != null ? { icon: 'check', kind: 'wc', text: `Toilette in ${Math.round(wc)} m.` } : { icon: 'close', kind: 'wc', text: 'Keine öffentliche Toilette in der Nähe eingetragen.' });
  const water = els.filter((e) => e.tags?.amenity === 'drinking_water').map(dist).filter((d) => d != null).sort((a, b) => a - b)[0];
  if (water != null) notes.push({ icon: 'check', kind: 'water', text: `Trinkwasser in ${Math.round(water)} m.` });
  const att = els.find((e) => e.tags?.opening_hours && e.tags?.tourism);
  if (att) notes.push({ icon: 'clock', kind: 'hours', text: `„${att.tags.name || 'Sehenswürdigkeit'}“ hat Öffnungszeiten: ${att.tags.opening_hours}.` });
  return { transit, notes };
}

/** Ausweichweg, wenn Overpass überlastet ist: Flugplätze & Toiletten über Nominatim */
async function notesFallback(lat, lng) {
  const box = (d) => `${lng - d * 1.3},${lat + d},${lng + d * 1.3},${lat - d}`;
  const notes = [];
  const air = await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=airport&limit=5&bounded=1&viewbox=${box(0.08)}`, { timeout: 8000 }).catch(() => []);
  const a = (air || []).filter((x) => x.category === 'aeroway').map((x) => ({ n: x.name, d: distance(lat, lng, +x.lat, +x.lon) })).sort((p, q) => p.d - q.d)[0];
  if (a && a.d < 9000) notes.push({ icon: 'satellite', kind: 'drone', text: `Flugplatz „${a.n || 'Flugplatz'}“ ${(a.d / 1000).toFixed(1).replace('.', ',')} km entfernt – Drohnenflug in der Nähe nur mit Genehmigung.` });
  await wait(1100); // Nominatim: max. 1 Anfrage pro Sekunde
  const wc = await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=toilets&limit=5&bounded=1&viewbox=${box(0.009)}`, { timeout: 8000 }).catch(() => []);
  const w = (wc || []).map((x) => distance(lat, lng, +x.lat, +x.lon)).sort((p, q) => p - q)[0];
  notes.push(w != null ? { icon: 'check', kind: 'wc', text: `Toilette in ${Math.round(w)} m.` } : { icon: 'close', kind: 'wc', text: 'Keine öffentliche Toilette in der Nähe eingetragen.' });
  return notes;
}

/** Kurztext für die KI-Zusammenfassung */
export function placeInfoText(name, info) {
  const lines = [`Spot: ${name}`];
  for (const w of info.wiki || []) lines.push(`Wikipedia „${w.title}“ (${w.dist != null ? Math.round(w.dist) + ' m entfernt' : ''}): ${w.extract}`);
  if (info.parking?.length) lines.push('Parkplätze: ' + info.parking.map((p) => `${p.name || 'Parkplatz'} ${Math.round(p.dist)} m ${p.dir}${p.fee ? ', ' + p.fee : ''}`).join('; '));
  if (info.walk) lines.push(`Fußweg vom nächsten Parkplatz: ${info.walk.meters} m, ca. ${info.walk.minutes} min`);
  if (info.transit?.length) lines.push('ÖPNV: ' + info.transit.map((t) => `${t.name} ${Math.round(t.dist)} m`).join('; '));
  for (const n of info.notes || []) lines.push('Hinweis: ' + n.text);
  return lines.join('\n');
}
