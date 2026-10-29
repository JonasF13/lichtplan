// ─────────────────────────────────────────────────────────────
// Import: gespeicherte Orte aus Google Maps (über Google Takeout)
//  · Takeout-ZIP (im Browser entpackt mit fflate) · CSV-Listen aus „Gespeichert“
//  · „Saved Places.json“ / „Gespeicherte Orte.json“ / „Labeled places.json“ (GeoJSON) · KML/KMZ
//  · Orte ohne Koordinaten → Nominatim (OpenStreetMap), höchstens 1 Anfrage pro Sekunde
//  · Duplikate (< 40 m zu einem vorhandenen Spot oder gleicher Google-Ort) werden übersprungen
// Aufruf: openGoogleMapsImport({ onDone({ projects, spots, skipped, unresolved }) })
// ─────────────────────────────────────────────────────────────
import { store, parseKML } from '../store.js';
import { modal, toast } from '../ui.js';
import { esc, el, icon, distance, uid, parseCoords } from '../utils.js';

const FFLATE = '../../vendor/fflate.esm.js';
const TAKEOUT_URL = 'https://takeout.google.com/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=de';
const ACCEPT = '.zip,.csv,.json,.geojson,.kml,.kmz';
const DUP_RADIUS = 40;          // m – näher an einem vorhandenen Spot = Duplikat
const GEO_GAP = 1100;           // ms zwischen zwei Nominatim-Anfragen (Richtlinie: max. 1 pro Sekunde)
const GEO_MAX_REQ = 3;          // höchstens so viele Suchanfragen pro Ort
const GEO_CACHE_KEY = 'specula.geocache.v1';
const MAX_ENTRY_BYTES = 50e6;   // größere Einzeldateien im ZIP ignorieren
const CHECK_TAG = 'Position prüfen'; // per Ortssuche gefunden → nur ungefähr

// Bekannte Takeout-Dateien (englisch/deutsch) → Projektname
const JSON_LISTS = [
  { re: /^(saved places|gespeicherte orte)$/i, name: 'Gespeicherte Orte' },
  { re: /^(labell?ed places|orte mit label|mit label versehene orte)$/i, name: 'Orte mit Label' },
  { re: /^(reviews|bewertungen|rezensionen)$/i, name: 'Bewertungen', off: true },
];
// Spaltennamen der CSV-Listen (Takeout: Title,Note,URL,Tags,Comment – teils übersetzt)
const HEAD_RAW = {
  title: ['title', 'titel', 'name', 'titre', 'titolo', 'título', 'naam'],
  note: ['note', 'notiz', 'notes', 'notizen', 'nota', 'remarque', 'notitie'],
  url: ['url', 'link', 'google maps url', 'maps url'],
  tags: ['tags', 'tag', 'labels', 'schlagwörter'],
  comment: ['comment', 'kommentar', 'comments', 'kommentare', 'commentaire', 'commento', 'comentario', 'opmerking'],
  address: ['address', 'adresse', 'anschrift', 'indirizzo', 'dirección'],
  lat: ['latitude', 'lat', 'breitengrad', 'breite'],
  lng: ['longitude', 'lng', 'lon', 'long', 'längengrad', 'länge'],
};

// ── kleine Helfer ───────────────────────────────────────────
const str = (v) => (v == null ? '' : String(v).trim());
const baseName = (p) => String(p).split(/[\\/]/).pop();
const extOf = (n) => (String(n).match(/\.([^./\\]+)$/)?.[1] || '').toLowerCase();
const stripExt = (n) => String(n).replace(/\.[^./\\]+$/, '');
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const HEAD = Object.fromEntries(Object.entries(HEAD_RAW).map(([k, v]) => [k, v.map(norm)]));
const hasLL = (e) => Number.isFinite(e.lat) && Number.isFinite(e.lng);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
const fmtSecs = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} Min.`);
const nextFrame = () => new Promise((r) => setTimeout(r, 30));

function toLL(lat, lng) {
  if (lat == null || lng == null || lat === '' || lng === '') return null;
  const la = +String(lat).trim().replace(',', '.'), lo = +String(lng).trim().replace(',', '.');
  if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  if (Math.abs(la) < 1e-6 && Math.abs(lo) < 1e-6) return null; // [0,0] = „keine Position“ bei Google
  return { lat: la, lng: lo };
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { s = new TextDecoder('windows-1252').decode(bytes); }
  return s.replace(/^\uFEFF/, '');
}
/** ZIP-Namen ohne UTF-8-Kennzeichen liefert fflate als Latin-1 („MÃ¶chte“) → reparieren */
function fixName(s) {
  if (!/[\u0080-\u00ff]/.test(s) || /[^\u0000-\u00ff]/.test(s)) return s;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0))); } catch { return s; }
}
const isZip = (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);

// ── Google-Maps-Links ───────────────────────────────────────
const N = '(-?\\d{1,3}(?:\\.\\d+)?)';
const RE_PIN = new RegExp(`!3d${N}!4d${N}`, 'g');                 // Ortsmarke im data-Teil
const RE_EMBED = new RegExp(`!2d${N}!3d${N}`);                     // Einbettungs-Links (Länge zuerst)
const RE_PARAM = new RegExp(`[?&](?:query|q|ll|sll|center|destination|daddr)=\\s*${N}\\s*,\\s*\\+?\\s*${N}(?![\\d.])`, 'i');
const RE_PATH = new RegExp(`/(?:search|place)/\\s*${N}\\s*,\\s*\\+?\\s*${N}(?![\\d.])`, 'i');
const RE_AT = new RegExp(`@${N},\\s*${N}`);
const RE_GEO = new RegExp(`^geo:${N},${N}`, 'i');
const RE_OSM = new RegExp(`[?&]mlat=${N}&mlon=${N}`, 'i');

/** Koordinaten aus einem (Google-Maps-)Link: !3d…!4d… · query=/q=/ll= · /search/LAT,+LNG · @LAT,LNG */
export function coordsFromUrl(url) {
  if (!url) return null;
  let u = String(url).trim();
  try { u = decodeURIComponent(u.replace(/\+/g, ' ')); } catch { u = u.replace(/\+/g, ' '); }
  const pin = [...u.matchAll(RE_PIN)].pop();
  if (pin) return toLL(pin[1], pin[2]);
  let m;
  if ((m = u.match(RE_EMBED))) return toLL(m[2], m[1]);
  if ((m = u.match(RE_PARAM) || u.match(RE_PATH) || u.match(RE_AT) || u.match(RE_GEO) || u.match(RE_OSM))) return toLL(m[1], m[2]);
  return null;
}
/** Eindeutige Google-Orts-ID (cid) – aus ?cid=…, ludocid=… oder der Feature-ID 0x…:0x… (zweiter Teil = cid hexadezimal) */
export function placeKey(url) {
  const u = String(url || '');
  let m = u.match(/[?&](?:cid|ludocid)=(\d{5,})/i);
  if (m) return 'cid:' + m[1].replace(/^0+/, '');
  m = u.match(/(?:ftid=|!1s|[?&]fid=)0x[0-9a-f]+(?::|%3a)0x([0-9a-f]+)/i);
  if (m && /[1-9a-f]/i.test(m[1])) { try { return 'cid:' + BigInt('0x' + m[1]).toString(); } catch { /* ungültig */ } }
  return null;
}
function isPlaceUrl(u) {
  const m = String(u || '').trim().match(/^(?:https?:\/\/)?([^/?#]+)(.*)$/i);
  if (!m) return false;
  const host = m[1].toLowerCase(), rest = m[2];
  if (/(^|\.)(goo\.gl|g\.page)$/.test(host)) return true;
  if (/(^|\.)google\.[a-z.]+$/.test(host)) return host.startsWith('maps.') || /^\/maps\b/i.test(rest) || /[?&](cid|ludocid|ftid)=/i.test(rest);
  return !!coordsFromUrl(u);
}
/** Ortsname aus /maps/place/NAME/… oder ?q=NAME (keine reinen Koordinaten) */
function nameFromUrl(url) {
  const m = String(url || '').match(/\/maps\/place\/([^/?#@]+)/i) || String(url || '').match(/[?&]q=([^&#]+)/i);
  if (!m) return '';
  let s = m[1];
  try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch { s = s.replace(/\+/g, ' '); }
  s = s.trim();
  return !s || parseCoords(s) || /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(s) ? '' : s;
}
/** Titel, die selbst Koordinaten sind (abgelegte Markierungen): „46.61236, 12.29560“ oder 46°36'44"N 12°17'44"E */
function coordsFromText(t) {
  if (!t || !/\d/.test(t)) return null;
  const c = parseCoords(t);
  return c ? toLL(c.lat, c.lng) : null;
}

function htmlToText(s) {
  if (!s || !/<[a-z!/][^>]*>/i.test(s)) return str(s);
  const t = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n');
  const doc = new DOMParser().parseFromString(t, 'text/html'); // inertes Dokument, lädt/startet nichts
  return (doc.body.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Ein importierter Ort (Zwischenformat) */
function entry(o) {
  const e = { name: '', note: '', comment: '', address: '', url: '', tags: [], date: null, countryCode: '', lat: null, lng: null, coordSource: null, ...o };
  if (o.ll) { e.lat = o.ll.lat; e.lng = o.ll.lng; e.coordSource ||= 'file'; }
  delete e.ll;
  e.key = placeKey(e.url);
  if (!e.name) {
    const q = nameFromUrl(e.url);
    if (q) { const [a, ...rest] = q.split(/\s*,\s*/); e.name = a; if (!e.address) e.address = rest.join(', '); }
  }
  e.searchable = !!(e.name || e.address);
  if (!e.name) e.name = e.address.split(',')[0].trim() || 'Unbenannter Ort';
  if (e.comment && e.comment === e.note) e.comment = '';
  return e;
}

// ── CSV ─────────────────────────────────────────────────────
/** RFC-4180-CSV: Anführungszeichen, "" als Escape, Kommas/Zeilenumbrüche in Feldern, BOM, , ; oder Tab */
export function parseCSV(text, delim) {
  text = String(text).replace(/^\uFEFF/, '');
  if (!delim) {
    const first = (text.match(/^[ \t]*[^\r\n]*\S[^\r\n]*/m) || [''])[0].replace(/"[^"]*"/g, '');
    const cnt = (ch) => first.split(ch).length - 1;
    delim = [',', ';', '\t'].sort((a, b) => cnt(b) - cnt(a))[0];
    if (!cnt(delim)) delim = ',';
  }
  const rows = [];
  let row = [], field = '', q = false, i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { q = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1; continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvList(text, listName, source) {
  const rows = parseCSV(text);
  const hi = rows.findIndex((r) => r.some((c) => c.trim()));
  if (hi < 0) return null;
  const head = rows[hi].map(norm), col = {};
  for (const [k, names] of Object.entries(HEAD)) { const i = head.findIndex((h) => names.includes(h)); if (i >= 0) col[k] = i; }
  let start = hi + 1;
  if (col.title == null && col.url == null && col.lat == null) {
    // ohne Kopfzeile: Takeout-Reihenfolge Titel, Notiz, URL, Tags, Kommentar
    if (!rows.slice(hi, hi + 20).some((r) => isPlaceUrl(r[2]))) return null;
    Object.assign(col, { title: 0, note: 1, url: 2, tags: 3, comment: 4 });
    start = hi;
  }
  const L = { kind: 'csv', name: listName, source, description: '', entries: [], nonPlace: 0 };
  const width = start > hi ? rows[hi].length : 0;
  let first = true;
  for (let r of rows.slice(start)) {
    if (!r.some((c) => c.trim())) continue; // leere Zeilen (Takeout: „,,,,“ unter der Kopfzeile)
    // fehlerhaft exportiert: Link mit Kommas ohne Anführungszeichen (…/@46.6,11.7,15z/…) → überzählige Spalten wieder anfügen
    const extra = r.length - width;
    if (width && extra > 0 && col.url != null && /^https?:\/\//i.test(str(r[col.url]))) {
      r = [...r.slice(0, col.url), r.slice(col.url, col.url + extra + 1).join(','), ...r.slice(col.url + extra + 1)];
    }
    const g = (k) => (col[k] != null ? str(r[col[k]]) : '');
    const title = g('title'), url = g('url'), note = g('note'), comment = g('comment');
    const llCols = col.lat != null ? toLL(g('lat'), g('lng')) : null;
    if (!title && !url && !llCols && !g('address')) { if (first && (note || comment)) L.description = note || comment; first = false; continue; }
    first = false;
    const ll = coordsFromUrl(url) || llCols || coordsFromText(title);
    if (!ll && url && !isPlaceUrl(url)) { L.nonPlace++; continue; } // gespeicherte Webseiten/Bilder sind keine Orte
    L.entries.push(entry({ name: title, note, comment, url, address: g('address'), tags: g('tags').split(/\s*[,;]\s*/).filter(Boolean), ll }));
  }
  return L;
}

// ── GeoJSON (Saved Places.json, Labeled places.json, …) ─────
function pointOf(g) {
  if (!g) return null;
  if (g.type === 'GeometryCollection') return pointOf(g.geometries?.[0]);
  let c = g.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0]; // Linien/Flächen: erster Punkt
  return Array.isArray(c) ? toLL(c[1], c[0]) : null;
}
function featureEntry(f) {
  const p = f?.properties || {}, loc = p.location || p.Location || {};
  const geo = loc['Geo Coordinates'] || loc.geo_coordinates || {};
  const url = str(p.google_maps_url || p['Google Maps URL'] || p.url || p.URL);
  const comment = str(p.Comment || p.comment);
  const ll = pointOf(f?.geometry) || toLL(geo.Latitude ?? geo.latitude, geo.Longitude ?? geo.longitude) || coordsFromUrl(url);
  const name = str(loc.name || loc['Business Name'] || p.Title || p.title || p.name || p.Name);
  const address = str(loc.address || loc.Address || p.address || p.Address);
  if (!name && !address && !ll && !url) return null;
  return entry({
    name, address, url, ll,
    note: str(p.note || p.Note || p.review_text_published),
    comment: /no location information/i.test(comment) ? '' : comment,
    date: str(p.date || p.Published || p.published || p.Updated) || null,
    countryCode: str(loc.country_code || loc['Country Code'] || p.country_code),
  });
}
function geojsonList(obj, file, source) {
  const feats = Array.isArray(obj?.features) ? obj.features : obj?.type === 'Feature' ? [obj] : null;
  if (!feats) return null;
  const known = JSON_LISTS.find((j) => j.re.test(stripExt(file).trim()));
  return { kind: 'geojson', name: known?.name || stripExt(file).trim(), source, off: !!known?.off, description: '', entries: feats.map(featureEntry).filter(Boolean) };
}

// ── KML / KMZ ───────────────────────────────────────────────
function kmlList(text, fallbackName, source) {
  const pms = parseKML(text);
  if (!pms.length) return null;
  let docName = '';
  try {
    const d = new DOMParser().parseFromString(text, 'application/xml').getElementsByTagName('Document')[0];
    docName = str([...(d?.children || [])].find((c) => c.localName === 'name')?.textContent);
  } catch { /* egal */ }
  return { kind: 'kml', name: docName || fallbackName, source, description: '', entries: pms.map((pm) => entry({ name: str(pm.name), note: htmlToText(pm.notes || ''), ll: toLL(pm.lat, pm.lng) })) };
}
async function kmzList(bytes, fallbackName, source) {
  const { unzipSync } = await import(FFLATE);
  const files = unzipSync(bytes, { filter: (f) => extOf(f.name) === 'kml' });
  const names = Object.keys(files).sort((a, b) => /(^|\/)doc\.kml$/i.test(b) - /(^|\/)doc\.kml$/i.test(a));
  for (const n of names) { const L = kmlList(decodeText(files[n]), fallbackName, source); if (L) return L; }
  return null;
}

// ── Dateien einlesen ────────────────────────────────────────
function wantedInZip(path, size) {
  if (path.endsWith('/') || /(^|\/)(__MACOSX\/|\._)/.test(path) || size > MAX_ENTRY_BYTES) return false;
  const ext = extOf(path);
  if (['csv', 'kml', 'kmz', 'geojson'].includes(ext)) return true;
  return ext === 'json' && /maps|saved|gespeichert|places|orte|label/i.test(path);
}

/** Eine Datei (direkt gewählt oder aus dem ZIP) → Liste oder null */
async function readEntry(path, bytes, quiet, warnings) {
  const file = baseName(path), ext = extOf(file), title = stripExt(file).trim() || 'Import';
  const warn = (msg) => { if (!quiet) warnings.push(`„${file}“: ${msg}`); };
  if (ext === 'kmz' || (ext !== 'zip' && isZip(bytes))) {
    const L = await kmzList(bytes, title, path);
    if (!L) warn('keine Orte in der KMZ-Datei gefunden');
    return L;
  }
  const text = decodeText(bytes);
  const head = text.trimStart()[0];
  const kind = ext === 'csv' || ext === 'tsv' ? 'csv' : ext === 'kml' ? 'kml' : ext === 'json' || ext === 'geojson' ? 'json'
    : head === '<' ? 'kml' : head === '{' || head === '[' ? 'json' : 'csv';
  if (kind === 'kml') {
    const L = kmlList(text, title, path);
    if (!L) warn('keine Orte in der KML-Datei gefunden');
    return L;
  }
  if (kind === 'json') {
    let obj;
    try { obj = JSON.parse(text); } catch { warn('kein gültiges JSON'); return null; }
    if (obj?.app === 'Specula' || (Array.isArray(obj?.spots) && Array.isArray(obj?.projects))) { warn('das ist eine Specula-Sicherung – bitte über „Importieren (JSON / KML)“ laden'); return null; }
    const L = geojsonList(obj, file, path);
    if (!L) warn('kein GeoJSON mit Orten');
    else if (!L.entries.length && obj.features?.length) warn('keine verwertbaren Orte');
    return L;
  }
  const L = csvList(text, title, path);
  if (!L) warn('keine Google-Maps-Liste erkannt (erwartet: Title, Note, URL …)');
  else if (!L.entries.length && L.nonPlace) warn('enthält nur Links, keine Orte');
  return L;
}

/**
 * Dateien (Takeout-ZIP, CSV, GeoJSON, KML/KMZ) lesen → { lists, warnings }
 * lists: [{ kind, name, source, description, off, entries: [{ name, note, comment, address, url, tags, date, lat, lng, coordSource, key }] }]
 */
export async function parseFiles(files) {
  const lists = [], warnings = [];
  for (const f of files) {
    const name = f.name || 'Datei';
    let bytes;
    try { bytes = new Uint8Array(await f.arrayBuffer()); } catch {
      warnings.push(`„${name}“ konnte nicht gelesen werden${f.size > 5e8 ? ' – die Datei ist sehr groß. Beim Export nur „Gespeichert“ und „Maps (Meine Orte)“ auswählen.' : '.'}`);
      continue;
    }
    const n0 = lists.length, w0 = warnings.length;
    try {
      if (extOf(name) === 'zip' || (isZip(bytes) && extOf(name) !== 'kmz')) {
        const { unzipSync } = await import(FFLATE);
        let files2;
        try { files2 = unzipSync(bytes, { filter: (z) => wantedInZip(fixName(z.name), z.originalSize) }); } catch { throw new Error('ZIP-Datei ist beschädigt oder unvollständig'); }
        for (const [p, data] of Object.entries(files2)) {
          try {
            const L = await readEntry(fixName(p), data, true, warnings);
            if (L) lists.push(L);
          } catch (e) { console.warn('Google-Maps-Import:', p, e); } // eine kaputte Datei im ZIP überspringen
        }
      } else {
        const L = await readEntry(name, bytes, false, warnings);
        if (L) lists.push(L);
      }
    } catch (e) { warnings.push(`„${name}“: ${e.message || e}`); }
    const found = lists.slice(n0).some((L) => L.entries.length);
    if (!found && warnings.length === w0) warnings.push(`In „${name}“ wurden keine gespeicherten Orte gefunden.`);
  }
  // leere Listen weg, doppelt gewählte Dateien nur einmal
  const seen = new Set();
  const out = lists.filter((L) => {
    if (!L.entries.length) return false;
    const sig = L.name + '|' + L.entries.map((e) => `${e.name}@${e.lat},${e.lng}`).join('|');
    if (seen.has(sig)) return false;
    seen.add(sig); return true;
  });
  const KIND = { csv: 0, geojson: 1, kml: 2 };
  out.sort((a, b) => (!!a.off - !!b.off) || (KIND[a.kind] - KIND[b.kind]) || a.name.localeCompare(b.name, 'de'));
  out.forEach((L) => L.entries.forEach((e) => { e.list = L.name; }));
  crossResolve(out);
  return { lists: out, warnings };
}

/** Orte ohne Koordinaten übernehmen sie aus einer anderen Liste, wenn es derselbe Google-Ort ist (cid) oder der Name eindeutig passt */
function crossResolve(lists) {
  const byKey = new Map(), byName = new Map();
  for (const L of lists) for (const e of L.entries) if (hasLL(e)) {
    if (e.key && !byKey.has(e.key)) byKey.set(e.key, { e, L });
    const k = norm(e.name);
    if (k) byName.set(k, [...(byName.get(k) || []), { e, L }]);
  }
  for (const L of lists) for (const e of L.entries) if (!hasLL(e)) {
    let src = e.key && byKey.get(e.key);
    if (!src) {
      // gleicher Name: nur wenn eindeutig (alle Treffer < 200 m beieinander) und die Google-IDs nicht widersprechen
      const arr = byName.get(norm(e.name))?.filter((x) => !(e.key && x.e.key && x.e.key !== e.key));
      if (arr?.length && arr.every((x) => distance(x.e.lat, x.e.lng, arr[0].e.lat, arr[0].e.lng) < 200)) src = arr[0];
    }
    if (!src) continue;
    Object.assign(e, { lat: src.e.lat, lng: src.e.lng, coordSource: 'ref', refList: src.L.name });
    if (!e.address) e.address = src.e.address;
  }
}

// ── Duplikate ───────────────────────────────────────────────
/** Google-Orts-IDs aus den Notizen vorhandener Spots (dort steht nach einem Import der Google-Maps-Link) */
function existingKeys() {
  const keys = new Map();
  for (const s of store.spots) {
    for (const u of String(s.notes || '').match(/https?:\/\/[^\s<>"]+/g) || []) {
      const k = placeKey(u);
      if (k && !keys.has(k)) keys.set(k, s);
    }
  }
  return keys;
}
/** Rasterindex für die 40-m-Prüfung (Zellen 0,001° ≈ 111 m) – bleibt auch bei Tausenden Orten schnell */
function geoIndex(items = []) {
  const cells = new Map();
  const idx = {
    add(it) {
      if (!hasLL(it)) return;
      const k = `${Math.floor(it.lat * 1000)}:${Math.floor(it.lng * 1000)}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(it);
    },
    /** nächstgelegener Eintrag im Umkreis r (m) oder null */
    find(lat, lng, r = DUP_RADIUS) {
      const i = Math.floor(lat * 1000), j = Math.floor(lng * 1000);
      const di = Math.ceil(r / 111), dj = Math.min(60, Math.ceil(r / (111.3 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)))));
      let best = null, bd = r;
      for (let a = i - di; a <= i + di; a++) for (let b = j - dj; b <= j + dj; b++) {
        for (const it of cells.get(`${a}:${b}`) || []) { const d = distance(lat, lng, it.lat, it.lng); if (d < bd) { bd = d; best = it; } }
      }
      return best;
    },
  };
  items.forEach(idx.add);
  return idx;
}
function findExisting(e, keys, near) {
  if (e.key && keys.has(e.key)) return keys.get(e.key);
  return hasLL(e) ? near.find(e.lat, e.lng) : null;
}
const needsGeocode = (e) => !hasLL(e) && !e.dupOf && e.searchable;
/** Wie viele Orte der Auswahl wirklich neu wären (ohne vorhandene Spots und ohne Doppelte zwischen den Listen) */
function estimateNew(sel) {
  const keys = new Set(), near = geoIndex();
  let n = 0;
  for (const L of sel) for (const e of L.entries) {
    if (e.dupOf || (e.key && keys.has(e.key)) || (hasLL(e) && near.find(e.lat, e.lng))) continue;
    if (e.key) keys.add(e.key);
    near.add(e);
    n++;
  }
  return n;
}

// ── Nominatim (OpenStreetMap) ───────────────────────────────
let lastRequest = 0;
let geoCache = null;
const memMiss = new Set();
function cacheGet(k) {
  if (memMiss.has(k)) return null;
  try { geoCache ||= JSON.parse(localStorage.getItem(GEO_CACHE_KEY)) || {}; } catch { geoCache = {}; }
  const c = geoCache[k];
  if (!c) return undefined;
  if (c.miss) return Date.now() - c.t < 7 * 864e5 ? null : undefined; // „nicht gefunden“ nur eine Woche merken
  return { lat: c.lat, lng: c.lng, label: c.label };
}
function cachePut(k, r) {
  if (!r) memMiss.add(k);
  try {
    geoCache ||= JSON.parse(localStorage.getItem(GEO_CACHE_KEY)) || {};
    geoCache[k] = r ? { lat: r.lat, lng: r.lng, label: r.label, t: Date.now() } : { miss: 1, t: Date.now() };
    const ks = Object.keys(geoCache);
    if (ks.length > 1500) ks.sort((a, b) => geoCache[a].t - geoCache[b].t).slice(0, ks.length - 1500).forEach((x) => delete geoCache[x]);
    localStorage.setItem(GEO_CACHE_KEY, JSON.stringify(geoCache));
  } catch { /* Speicher voll – egal */ }
}
function sleep(ms, signal) {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(new DOMException('Abgebrochen', 'AbortError'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', stop); res(); }, ms);
    const stop = () => { clearTimeout(t); rej(new DOMException('Abgebrochen', 'AbortError')); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}
class GeoError extends Error {}

/** Eine Suchanfrage; zählt gegen das Limit (gecachte Antworten nicht). Wirft GeoError, wenn die Suche nicht erreichbar ist. */
async function nominatim(q, cc, signal, budget) {
  const key = `${q}|${cc}`.toLowerCase();
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  if (budget.left <= 0) return null;
  budget.left--;
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequest + GEO_GAP - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastRequest = Date.now();
    let r;
    try {
      r = await fetch(`${NOMINATIM}&q=${encodeURIComponent(q)}${cc ? `&countrycodes=${cc}` : ''}`, { signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (attempt < 1) { await sleep(3000, signal); continue; }
      throw new GeoError('Keine Verbindung zur Ortssuche (OpenStreetMap). Bist du online?');
    }
    if (r.status === 429 || r.status === 503) {
      if (attempt < 1) { await sleep(5000, signal); continue; }
      throw new GeoError('Die Ortssuche (OpenStreetMap) ist gerade überlastet – bitte später noch einmal versuchen.');
    }
    if (!r.ok) throw new GeoError(`Die Ortssuche (OpenStreetMap) antwortet nicht (HTTP ${r.status}).`);
    const js = await r.json().catch(() => []);
    const res = js?.[0] ? toLL(js[0].lat, js[0].lon) : null;
    if (res) res.label = str(js[0].display_name);
    cachePut(key, res);
    return res;
  }
}

/** Suchvarianten für einen Namen: vollständig · Klammer als Ortsangabe · ohne Klammern/Anführungszeichen · erster Teil (muss zum Rest passen) */
function nameQueries(s) {
  const out = [{ q: s }];
  const paren = s.match(/^(.*?)\s*[([]([^)\]]+)[)\]]\s*(.*)$/);
  if (paren && paren[1] && /^[^\d]*\p{L}{3}[^\d]*$/u.test(paren[2])) out.push({ q: `${paren[1]} ${paren[3]}`.trim() + `, ${paren[2]}` }); // „Hintersee (Ramsau)“ → „Hintersee, Ramsau“
  const plain = s.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/["„“”‚‘’«»]/g, '').replace(/\s+/g, ' ').trim();
  out.push({ q: plain });
  const parts = plain.split(/\s+[-–—|·•]\s+|\s*,\s*/).filter(Boolean);
  if (parts.length > 1) out.push({ q: parts[0], mustContain: parts.slice(1).map(norm).filter((x) => x.length > 2) });
  const seen = new Set();
  return out.filter((x) => x.q.length > 1 && !seen.has(x.q.toLowerCase()) && seen.add(x.q.toLowerCase()));
}
async function geocodeEntry(e, signal) {
  const cc = /^[a-z]{2}$/i.test(e.countryCode) ? e.countryCode.toLowerCase() : '';
  const budget = { left: GEO_MAX_REQ };
  const name = e.name && e.name !== 'Unbenannter Ort' ? e.name : '', addr = e.address;
  if (name && addr) {
    const full = norm(addr).startsWith(norm(name)) ? addr : `${name}, ${addr}`;
    const r = await nominatim(full, cc, signal, budget);
    if (r) return r;
    const a = full !== addr ? await nominatim(addr, cc, signal, budget) : null; // Adresse: sicher, aber evtl. nur der Ort
    const b = await nominatim(name, cc, signal, budget);                       // Name: genauer, aber evtl. mehrdeutig
    if (a && b) return distance(a.lat, a.lng, b.lat, b.lng) < 25000 ? b : a;
    return a || b;
  }
  for (const v of nameQueries(name || addr)) {
    const r = await nominatim(v.q, cc, signal, budget);
    if (r && (!v.mustContain?.length || v.mustContain.some((w) => norm(r.label).includes(w)))) return r;
    if (budget.left <= 0) break;
  }
  return null;
}

// ── Übernehmen ──────────────────────────────────────────────
function notesOf(e) {
  const lines = [];
  for (const s of [e.note, e.comment, e.address !== e.name ? e.address : '', e.url]) {
    const t = str(s);
    if (t && !lines.includes(t)) lines.push(t);
  }
  return lines.join('\n');
}

/** Ausgewählte Listen in den Store schreiben (Projekte einzeln, alle Spots in einem Rutsch) */
function commitImport(lists, { mode, name }) {
  const now = Date.now();
  const merged = mode === 'one';
  const groups = new Map();
  for (const L of lists) {
    const pname = merged ? name || 'Google Maps' : L.name;
    const k = norm(pname) || pname;
    if (!groups.has(k)) groups.set(k, { name: pname, descriptions: [], items: [] });
    const g = groups.get(k);
    if (L.description && !g.descriptions.includes(L.description)) g.descriptions.push(L.description);
    L.entries.forEach((e) => g.items.push({ e, L }));
  }
  const keys = existingKeys();
  const placed = geoIndex(store.spots.map((s) => ({ lat: s.lat, lng: s.lng })));
  const out = { projects: [], spots: [], skipped: 0, unresolved: [] };
  const unresolvedSeen = new Set();
  const spots = [], touched = [];
  const date = new Date(now).toLocaleDateString('de-AT');
  for (const g of groups.values()) {
    const take = [];
    for (const it of g.items) {
      const { e } = it;
      if (e.key && keys.has(e.key)) { out.skipped++; continue; }
      if (!hasLL(e)) {
        const id = e.key || norm(e.name) + '|' + norm(e.address);
        if (!unresolvedSeen.has(id)) { unresolvedSeen.add(id); out.unresolved.push({ name: e.name, list: e.list, address: e.address, url: e.url, note: e.note }); }
        continue;
      }
      if (placed.find(e.lat, e.lng)) { out.skipped++; continue; }
      placed.add({ lat: e.lat, lng: e.lng });
      if (e.key) keys.set(e.key, null);
      take.push(it);
    }
    if (!take.length) continue; // keine leeren Projekte anlegen
    let proj = store.projects.find((p) => norm(p.name) === norm(g.name));
    if (proj) touched.push(proj);
    else {
      const desc = [...g.descriptions, `Aus Google Maps importiert am ${date}.`].join('\n\n');
      // absteigende Zeitstempel → in der Seitenleiste (neueste zuerst) in der Reihenfolge der Listen
      proj = store.addProject({ name: g.name, description: desc, created: now, updated: now - out.projects.length });
    }
    if (!out.projects.includes(proj)) out.projects.push(proj);
    let order = store.spotsOf(proj.id).length;
    for (const { e, L } of take) {
      const created = e.date ? Date.parse(e.date) : NaN;
      const tags = [...new Set([...e.tags, ...(merged && norm(L.name) !== norm(g.name) ? [L.name] : []), ...(e.coordSource === 'geocode' ? [CHECK_TAG] : [])])];
      spots.push({
        id: uid('s_'), projectId: proj.id, name: e.name, lat: +e.lat.toFixed(6), lng: +e.lng.toFixed(6), elevation: null, tz: null,
        notes: notesOf(e), tags, status: 'idee', rating: 0, target: null, shoots: [], order: order++,
        created: Number.isFinite(created) ? created : now, updated: now,
        source: `${L.kind === 'kml' ? 'KML' : 'Google Maps'} · ${L.name}`,
      });
    }
  }
  if (spots.length) store.importJSON({ projects: [], spots }, 'merge');
  touched.forEach((p) => store.updateProject(p.id, {})); // bestehende Projekte mit neuen Spots nach oben
  out.spots = spots.map((s) => store.spot(s.id)).filter(Boolean);
  return out;
}

function summaryText(r) {
  let s = r.spots.length ? `${plural(r.spots.length, 'Ort', 'Orte')} in ${plural(r.projects.length, 'Projekt', 'Projekten')} importiert` : 'Keine neuen Orte importiert';
  if (r.skipped) s += ` · ${r.skipped} schon vorhanden`;
  if (r.unresolved.length) s += ` · ${r.unresolved.length} nicht gefunden`;
  return s;
}

// ── Oberfläche ──────────────────────────────────────────────
const CSS = `
.gm { display: grid; gap: 12px; }
.gm p { margin: 0; }
.gm-steps { margin: 0; padding-left: 20px; color: var(--text2); }
.gm-steps li { margin: 5px 0; }
.gm-steps b { color: var(--text); font-weight: 600; }
.gm-drop { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 18px 14px; border: 1.5px dashed var(--line2); border-radius: 12px; text-align: center; transition: .15s; }
.gm-drop > .ic { width: 26px; height: 26px; color: var(--accent); }
.gm-drop.over { border-color: rgba(255,159,67,.75); background: rgba(255,159,67,.07); }
.gm-lists { display: grid; gap: 8px; }
.gm-list .tgl.big { margin: 0; }
.gm-list .tgl.big small.gm-src { color: var(--text3); font-size: 11px; overflow-wrap: anywhere; }
.gm-list .tgl.big small b { color: var(--text); font-weight: 600; }
.gm-entries { margin: 4px 0 0 32px; font-size: 12px; color: var(--text2); }
.gm-entries summary { cursor: pointer; color: var(--accent); font-weight: 600; font-size: 11.5px; }
.gm-entries ul { list-style: none; margin: 6px 0 2px; padding: 0; display: grid; gap: 3px; max-height: 190px; overflow: auto; }
.gm-entries li { display: flex; align-items: baseline; gap: 7px; }
.gm-entries li .gm-n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gm-entries li em { margin-left: auto; padding-left: 8px; font-style: normal; color: var(--text3); font-size: 11px; white-space: nowrap; }
.gm-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; align-self: center; background: var(--good); }
.gm-dot.ref { background: #54a0ff; } .gm-dot.geo { background: var(--warn); } .gm-dot.dup, .gm-dot.none { background: var(--text3); }
.gm-mode { display: grid; gap: 2px; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,.03); border: 1px solid var(--line); }
.gm-mode input[type=text] { margin: 2px 0 4px 24px; width: calc(100% - 24px); }
.gm-mode input[type=text]:disabled { opacity: .45; }
.gm-row { display: flex; justify-content: space-between; gap: 10px; color: var(--text2); font-size: 12px; }
.gm-row span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gm .progress { margin: 2px 0; }
.gm-unres { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; max-height: 42vh; overflow: auto; }
.gm-unres li { display: flex; gap: 10px; align-items: center; padding: 7px 10px; border-radius: 9px; background: rgba(255,255,255,.04); border: 1px solid var(--line); }
.gm-unres li > span { min-width: 0; }
.gm-unres li a { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; font-size: 12px; font-weight: 600; text-decoration: none; }
.gm-unres li a .ic { width: 13px; height: 13px; }
.modal footer .gm-left { margin-right: auto; }
@media (max-width: 520px) { .modal footer .gm-lbl { display: none; } }
`;
function injectCSS() {
  if (document.getElementById('gm-import-css')) return;
  const s = document.createElement('style');
  s.id = 'gm-import-css'; s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Öffnet den Import-Dialog für gespeicherte Google-Maps-Orte.
 * @param {{ onDone?: (r: { projects: object[], spots: object[], skipped: number, unresolved: {name, list, address, url, note}[] }) => void }} [opts]
 * @returns {Promise<null | { projects, spots, skipped, unresolved }>} Ergebnis, oder null wenn ohne Import geschlossen
 */
export async function openGoogleMapsImport({ onDone } = {}) {
  injectCSS();
  return new Promise((resolve) => {
    let lists = [], warnings = [], fileLabel = '';
    let ctrl = null, busy = false, finished = false, closed = false, onCancel = null;
    let lastClick = -Infinity; // letzter Klick auf einen Knopf unten (Doppelklick-Schutz)
    const recentClick = () => performance.now() - lastClick < 450;
    const { node, close } = modal({ title: 'Aus Google Maps importieren', body: '<div></div>', wide: true, actions: [{ label: 'Abbrechen', kind: 'ghost' }] });
    const body = node.querySelector('.modal-body');
    const footer = node.querySelector('footer');
    const done = (result) => { if (!finished) { finished = true; resolve(result); } };

    const onKey = (e) => { if (busy && onCancel && e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); onCancel(); } };
    const cleanup = () => document.removeEventListener('keydown', onKey, true);
    // Schließen (X, Esc, Klick daneben) erkennen → laufende Suche stoppen, nichts importieren
    const mo = new MutationObserver(() => {
      if (closed || (node.isConnected && !node.classList.contains('out'))) return;
      closed = true; ctrl?.abort(); mo.disconnect(); cleanup(); done(null);
    });
    mo.observe(node, { attributes: true, attributeFilter: ['class'] });
    if (node.parentNode) mo.observe(node.parentNode, { childList: true });
    // Während der Ortssuche: Esc / Klick daneben = „Abbrechen“ (Suche stoppen) statt Dialog zu verwerfen.
    // Der zweite Klick eines Doppelklicks landet nach dem Schrittwechsel (Dialog wird kleiner) oft daneben → ignorieren.
    const onDown = (e) => {
      if (e.target !== node) return;
      if (recentClick()) { e.stopImmediatePropagation(); return; }
      if (busy && onCancel) { e.stopImmediatePropagation(); onCancel(); }
    };
    document.addEventListener('keydown', onKey, true);
    node.addEventListener('mousedown', onDown, true);
    // Dateien hineinziehen (überall im Dialog) – sonst würde der Browser die Datei öffnen
    node.addEventListener('dragover', (e) => { e.preventDefault(); if (!busy) node.querySelector('.gm-drop')?.classList.add('over'); });
    node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) node.querySelector('.gm-drop')?.classList.remove('over'); });
    node.addEventListener('drop', (e) => {
      e.preventDefault(); node.querySelector('.gm-drop')?.classList.remove('over');
      if (!busy && e.dataTransfer?.files?.length) readFiles([...e.dataTransfer.files]);
    });

    const setFooter = (btns) => {
      footer.innerHTML = '';
      for (const b of btns) {
        const x = el(`<button class="btn ${b.kind || ''} ${b.left ? 'gm-left' : ''}" title="${esc(b.label)}">${b.icon ? icon(b.icon) : ''}${b.compact ? `<span class="gm-lbl">${esc(b.label)}</span>` : esc(b.label)}</button>`);
        if (b.id) x.id = b.id;
        x.onclick = (ev) => {
          if (recentClick()) return; // Doppelklick
          lastClick = performance.now();
          (b.onClick || close)(ev);
        };
        footer.appendChild(x);
      }
    };
    const commit = (sel, opts) => {
      if (finished || closed) return;
      finishWith(commitImport(sel, opts));
    };
    const finishWith = (result) => {
      try { onDone?.(result); } catch (e) { console.error(e); }
      toast(esc(summaryText(result)), result.spots.length ? '' : 'warn');
      done(result);
      if (result.unresolved.length) showResult(result); else close();
    };

    // ── Schritt 1: Anleitung + Datei wählen
    function showIntro(msg = '', kind = 'bad') {
      body.innerHTML = `
        <div class="gm">
          <p class="muted">Google Maps hat keinen direkten Export – deine gespeicherten Orte bekommst du über <b>Google Takeout</b>:</p>
          <ol class="gm-steps">
            <li><a href="${TAKEOUT_URL}" target="_blank" rel="noopener">takeout.google.com</a> öffnen und mit deinem Google-Konto anmelden.</li>
            <li>Oben <b>„Auswahl aufheben“</b> klicken, dann nur <b>„Gespeichert“</b> und <b>„Maps (Meine Orte)“</b> anhaken.</li>
            <li>Ganz unten <b>„Nächster Schritt“</b> → <b>„Export erstellen“</b>. Nach ein paar Minuten schickt Google eine E-Mail mit dem Download-Link.</li>
            <li>Die <b>ZIP-Datei</b> herunterladen und hier auswählen – entpacken ist nicht nötig.</li>
          </ol>
          <div class="gm-drop">
            ${icon('upload')}
            <b>Takeout-ZIP hierher ziehen</b>
            <button class="btn primary" id="gm-pick">${icon('folder')}Datei auswählen …</button>
            <span class="muted small">Auch einzeln möglich: CSV-Listen aus „Gespeichert“, „Gespeicherte Orte.json“, GeoJSON oder KML/KMZ</span>
            <input type="file" id="gm-file" multiple accept="${ACCEPT}" hidden>
          </div>
          <div class="key-out small ${kind}" id="gm-msg">${msg}</div>
          <p class="muted small">Orte ohne Koordinaten (in den CSV-Listen der Normalfall) sucht Specula über OpenStreetMap – etwa ein Ort pro Sekunde.</p>
        </div>`;
      const input = body.querySelector('#gm-file');
      body.querySelector('#gm-pick').onclick = () => input.click();
      input.onchange = () => { const fs = [...input.files]; input.value = ''; if (fs.length) readFiles(fs); };
      setFooter([
        { label: 'Google Takeout öffnen', icon: 'ext', kind: 'ghost', left: true, onClick: () => window.open(TAKEOUT_URL, '_blank', 'noopener') },
        { label: 'Abbrechen', kind: 'ghost' },
      ]);
    }

    async function readFiles(files) {
      busy = true;
      fileLabel = files.length === 1 ? files[0].name : `${files.length} Dateien`;
      body.innerHTML = `<div class="gm"><p>Lese <b>${esc(fileLabel)}</b> …</p><div class="progress indet"><i></i></div></div>`;
      setFooter([{ label: 'Abbrechen', kind: 'ghost' }]);
      await nextFrame();
      try { ({ lists, warnings } = await parseFiles(files)); } catch (e) { lists = []; warnings = [e.message || String(e)]; }
      busy = false;
      if (closed) return;
      if (!lists.length) {
        return showIntro(`${warnings.map(esc).join('<br>') || 'Keine Orte gefunden.'}<br>Tipp: Beim Takeout-Export „Gespeichert“ und „Maps (Meine Orte)“ auswählen und die ZIP-Datei unverändert hier laden.`);
      }
      showPreview();
    }

    // ── Schritt 2: Vorschau
    function showPreview() {
      const keys = existingKeys(), near = geoIndex(store.spots);
      for (const L of lists) for (const e of L.entries) e.dupOf = findExisting(e, keys, near);
      const total = lists.reduce((n, L) => n + L.entries.length, 0);
      const projByName = (n) => store.projects.find((p) => norm(p.name) === norm(n));
      const row = (e) => {
        const [cls, txt] = e.dupOf ? ['dup', `schon vorhanden${e.dupOf.name ? ` („${e.dupOf.name}“)` : ''}`]
          : e.coordSource === 'ref' ? ['ref', `Position aus „${e.refList}“`]
          : hasLL(e) ? ['ok', ''] : e.searchable ? ['geo', 'wird gesucht'] : ['none', 'keine Position'];
        return `<li title="${esc([e.address, e.note].filter(Boolean).join(' · '))}"><span class="gm-dot ${cls}"></span><span class="gm-n">${esc(e.name)}</span>${txt ? `<em>${esc(txt)}</em>` : ''}</li>`;
      };
      body.innerHTML = `
        <div class="gm">
          <p>In <b>${esc(fileLabel)}</b> gefunden: <b>${plural(lists.length, 'Liste', 'Listen')}</b> mit <b>${plural(total, 'Ort', 'Orten')}</b>. Welche sollen übernommen werden?</p>
          <div class="gm-lists">${lists.map((L, i) => {
            const geo = L.entries.filter(needsGeocode).length, dup = L.entries.filter((e) => e.dupOf).length;
            const existing = projByName(L.name);
            const info = [plural(L.entries.length, 'Ort', 'Orte'), geo && `<b>${geo}</b> ohne Koordinaten → werden gesucht`, dup && `${dup} schon vorhanden`, existing && `→ in bestehendes Projekt „${esc(existing.name)}“`].filter(Boolean).join(' · ');
            return `
            <div class="gm-list">
              <label class="tgl big"><input type="checkbox" data-li="${i}" ${L.off ? '' : 'checked'}>
                <span><b>${esc(L.name)}</b><small>${info}</small><small class="gm-src">${esc(L.source)}</small></span>
              </label>
              <details class="gm-entries"><summary>Orte anzeigen</summary>
                <ul>${L.entries.slice(0, 300).map(row).join('')}${L.entries.length > 300 ? `<li><em>… und ${L.entries.length - 300} weitere</em></li>` : ''}</ul>
              </details>
            </div>`;
          }).join('')}</div>
          <div class="gm-mode">
            <label class="tgl"><input type="radio" name="gm-mode" value="each" checked><span>Jede Liste als eigenes Projekt</span></label>
            <label class="tgl"><input type="radio" name="gm-mode" value="one"><span>Alles in ein Projekt</span></label>
            <input type="text" id="gm-pname" value="Google Maps" placeholder="Name des Projekts" disabled>
          </div>
          <div class="key-out small info" id="gm-sel"></div>
          ${warnings.length ? `<div class="key-out small bad">${warnings.map(esc).join('<br>')}</div>` : ''}
        </div>`;
      const boxes = [...body.querySelectorAll('input[data-li]')];
      const radios = [...body.querySelectorAll('input[name=gm-mode]')];
      const pname = body.querySelector('#gm-pname');
      const selected = () => lists.filter((_, i) => boxes[i].checked);
      const options = () => ({ mode: radios.find((r) => r.checked)?.value === 'one' ? 'one' : 'each', name: pname.value.trim() || 'Google Maps' });
      const update = () => {
        const sel = selected(), o = options();
        pname.disabled = o.mode !== 'one';
        const n = estimateNew(sel), geo = new Set(sel.flatMap((L) => L.entries).filter(needsGeocode)).size;
        const into = o.mode === 'one' && projByName(o.name);
        body.querySelector('#gm-sel').innerHTML = !sel.length ? 'Keine Liste ausgewählt.'
          : `Ausgewählt: <b>${plural(n, 'neuer Ort', 'neue Orte')}</b> aus ${plural(sel.length, 'Liste', 'Listen')}${into ? ` → in bestehendes Projekt „${esc(into.name)}“` : ''}.`
            + (geo ? ` ${plural(geo, 'Ort wird', 'Orte werden')} über OpenStreetMap gesucht (ca. ${fmtSecs(geo * GEO_GAP / 1000 * 1.2)}).` : '')
            + ' Orte im Umkreis von 40 m um einen vorhandenen Spot werden übersprungen.';
        const btn = footer.querySelector('#gm-go');
        if (btn) btn.disabled = !sel.length;
      };
      boxes.forEach((b) => (b.onchange = update));
      radios.forEach((r) => (r.onchange = () => { update(); if (r.value === 'one' && r.checked) pname.select(); }));
      pname.oninput = update;
      setFooter([
        { label: 'Andere Datei', icon: 'back', kind: 'ghost', left: true, compact: true, onClick: () => showIntro() },
        { label: 'Abbrechen', kind: 'ghost' },
        { label: 'Importieren', icon: 'download', kind: 'primary', id: 'gm-go', onClick: () => startImport(selected(), options()) },
      ]);
      update();
    }

    // ── Schritt 3: fehlende Koordinaten suchen, dann übernehmen
    async function startImport(sel, opts) {
      if (!sel.length || busy || closed || finished) return;
      const todo = [...new Set(sel.flatMap((L) => L.entries).filter(needsGeocode))];
      if (!todo.length) return commit(sel, opts);
      const r = await geocodeAll(todo);
      if (closed) return;
      if (r.stopped) return showStopped(r, sel, opts);
      commit(sel, opts);
    }

    async function geocodeAll(todo) {
      busy = true;
      ctrl = new AbortController();
      let found = 0, miss = 0, fatal = null;
      onCancel = () => ctrl.abort();
      body.innerHTML = `
        <div class="gm">
          <p><b>Suche Koordinaten</b> für ${plural(todo.length, 'Ort', 'Orte')} ohne Position …</p>
          <div class="progress"><i style="width:0%"></i></div>
          <div class="gm-row"><span id="gm-cur"></span><span id="gm-cnt">0 / ${todo.length}</span></div>
          <p class="muted small" id="gm-stat"></p>
          <p class="muted small">Ortssuche über OpenStreetMap (Nominatim) – höchstens eine Anfrage pro Sekunde. Gefundene Positionen sind ungefähr und bekommen den Tag „${CHECK_TAG}“.</p>
        </div>`;
      setFooter([{ label: 'Abbrechen', kind: 'ghost', onClick: () => onCancel?.() }]);
      const bar = body.querySelector('.progress i'), cur = body.querySelector('#gm-cur'), cnt = body.querySelector('#gm-cnt'), stat = body.querySelector('#gm-stat');
      const t0 = Date.now();
      let i = 0;
      for (; i < todo.length; i++) {
        if (ctrl.signal.aborted || closed) break;
        const e = todo[i];
        cur.textContent = `„${e.name}“ (${e.list})`;
        cnt.textContent = `${i + 1} / ${todo.length}`;
        const left = todo.length - i;
        const perPlace = Math.max(GEO_GAP, i ? (Date.now() - t0) / i : GEO_GAP * 1.2); // mind. 1 Anfrage pro Ort
        stat.textContent = `Gefunden: ${found} · Nicht gefunden: ${miss} · noch ca. ${fmtSecs((perPlace * left) / 1000)}`;
        try {
          const res = await geocodeEntry(e, ctrl.signal);
          if (res) { Object.assign(e, { lat: res.lat, lng: res.lng, coordSource: 'geocode', geoLabel: res.label }); found++; } else miss++;
        } catch (err) {
          if (err?.name === 'AbortError' || ctrl.signal.aborted) break;
          fatal = err instanceof GeoError ? err.message : `Ortssuche fehlgeschlagen: ${err?.message || err}`;
          break;
        }
        bar.style.width = `${((i + 1) / todo.length) * 100}%`;
      }
      busy = false; onCancel = null;
      const stopped = i < todo.length;
      return { stopped, fatal, found, missing: todo.filter((e) => !hasLL(e)).length, total: todo.length };
    }

    function showStopped(r, sel, opts) {
      body.innerHTML = `
        <div class="gm">
          <div class="key-out ${r.fatal ? 'bad' : 'info'}">${esc(r.fatal || 'Suche abgebrochen.')}</div>
          <p>${r.found} von ${plural(r.total, 'Ort', 'Orten')} gefunden – <b>${r.missing}</b> noch ohne Koordinaten.</p>
          <p class="muted">Die übrigen Orte trotzdem importieren? Die Orte ohne Koordinaten werden danach aufgelistet.</p>
        </div>`;
      setFooter([
        { label: 'Nichts importieren', kind: 'ghost' },
        { label: 'Trotzdem importieren', icon: 'download', kind: 'primary', id: 'gm-go', onClick: () => commit(sel, opts) },
      ]);
    }

    // ── Schritt 4: Ergebnis mit den nicht gefundenen Orten
    function showResult(r) {
      const link = (u) => safeUrl(u.url) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([u.name, u.address].filter(Boolean).join(', '))}`;
      body.innerHTML = `
        <div class="gm">
          <div class="key-out ${r.spots.length ? 'ok' : 'info'}">${r.spots.length ? '✓ ' : ''}${esc(summaryText(r))}</div>
          <p><b>Nicht gefunden (${r.unresolved.length})</b><br><span class="muted small">Diese Orte haben keine Koordinaten und wurden nicht übernommen. Öffne sie in Google Maps und lege sie bei Bedarf von Hand an.</span></p>
          <ul class="gm-unres">${r.unresolved.map((u) => `
            <li><span><b>${esc(u.name)}</b> <span class="muted small">· ${esc(u.list)}</span>${u.address ? `<br><span class="muted small">${esc(u.address)}</span>` : ''}</span>
            <a href="${esc(link(u))}" target="_blank" rel="noopener">${icon('ext')}Google Maps</a></li>`).join('')}
          </ul>
        </div>`;
      setFooter([
        { label: 'Liste kopieren', icon: 'copy', kind: 'ghost', left: true, onClick: () => {
          const txt = r.unresolved.map((u) => [u.name, u.list, u.address, u.url].filter(Boolean).join(' · ')).join('\n');
          (navigator.clipboard?.writeText(txt) || Promise.reject()).then(() => toast('Liste kopiert'), () => toast('Kopieren nicht möglich', 'warn'));
        } },
        { label: 'Fertig', icon: 'check', kind: 'primary' },
      ]);
    }

    showIntro();
  });
}
