// ─────────────────────────────────────────────────────────────
// Persistenz: Projekte → Spots → Termine (Shoots) + Einstellungen
// ─────────────────────────────────────────────────────────────
import { uid, deviceTz } from './utils.js';

const DATA_KEY = 'lichtplan.data.v1';
const SETTINGS_KEY = 'lichtplan.settings.v1';

export const PROJECT_COLORS = ['#ff9f43', '#ff6b6b', '#f368e0', '#a29bfe', '#54a0ff', '#2ed3b7', '#1dd1a1', '#feca57', '#c8d6e5'];
export const STATUS = {
  idee: { label: 'Idee', color: '#8395a7' },
  geplant: { label: 'Geplant', color: '#54a0ff' },
  erledigt: { label: 'Fotografiert', color: '#1dd1a1' },
};
export const TAG_SUGGESTIONS = ['Sonnenaufgang', 'Sonnenuntergang', 'Goldene Stunde', 'Blaue Stunde', 'Mond', 'Milchstraße', 'Sterne', 'Aussicht', 'Wasserfall', 'Berg', 'See', 'Küste', 'Stadt', 'Architektur', 'Wald', 'Drohne', 'Top-Spot'];

function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}

let data = load(DATA_KEY, null) || { version: 1, projects: [], spots: [] };
data.deleted ||= {}; // Grabsteine gelöschter Einträge (für die Synchronisierung)
const listeners = new Set();
const anyListeners = new Set(); // auch für „stille“ Änderungen (Tippen in Notizen)
const emit = (why) => { listeners.forEach((f) => f(why)); anyListeners.forEach((f) => f(why)); };
function persist(why) {
  localStorage.setItem(DATA_KEY, JSON.stringify(data));
  emit(why);
}

export const store = {
  get projects() { return data.projects.filter((p) => !p.archived).sort((a, b) => (b.updated || 0) - (a.updated || 0)); },
  get allProjects() { return data.projects; },
  get spots() { return data.spots; },
  get isEmpty() { return !data.projects.length && !data.spots.length; },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  onAnyChange(fn) { anyListeners.add(fn); return () => anyListeners.delete(fn); },

  project: (id) => data.projects.find((p) => p.id === id) || null,
  spot: (id) => data.spots.find((s) => s.id === id) || null,
  spotsOf: (pid) => data.spots.filter((s) => (pid ? s.projectId === pid : !s.projectId)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),

  addProject(p = {}) {
    const now = Date.now();
    const proj = { id: uid('p_'), name: 'Neues Projekt', color: PROJECT_COLORS[data.projects.length % PROJECT_COLORS.length], description: '', dateFrom: null, dateTo: null, archived: false, created: now, updated: now, ...p };
    data.projects.push(proj); persist('project'); return proj;
  },
  updateProject(id, patch) {
    const p = store.project(id); if (!p) return;
    Object.assign(p, patch, { updated: Date.now() }); persist('project');
  },
  deleteProject(id, deleteSpots = false) {
    const now = Date.now();
    data.projects = data.projects.filter((p) => p.id !== id);
    data.deleted[id] = now;
    if (deleteSpots) {
      data.spots.filter((s) => s.projectId === id).forEach((s) => { data.deleted[s.id] = now; });
      data.spots = data.spots.filter((s) => s.projectId !== id);
    } else data.spots.forEach((s) => { if (s.projectId === id) { s.projectId = null; s.updated = now; } });
    persist('project');
  },

  addSpot(s) {
    const now = Date.now();
    const spot = { id: uid('s_'), projectId: null, name: 'Neuer Spot', lat: 0, lng: 0, elevation: null, tz: null, notes: '', tags: [], status: 'idee', rating: 0, target: null, shoots: [], order: now, created: now, updated: now, ...s };
    data.spots.push(spot);
    touchProject(spot.projectId);
    persist('spot'); return spot;
  },
  updateSpot(id, patch, silent = false) {
    const s = store.spot(id); if (!s) return;
    Object.assign(s, patch, { updated: Date.now() });
    touchProject(s.projectId);
    if (silent) { localStorage.setItem(DATA_KEY, JSON.stringify(data)); anyListeners.forEach((f) => f('silent')); } else persist('spot');
  },
  deleteSpot(id) { data.spots = data.spots.filter((s) => s.id !== id); data.deleted[id] = Date.now(); persist('spot'); },
  addShoot(spotId, sh) {
    const s = store.spot(spotId); if (!s) return;
    const shoot = { id: uid('t_'), time: new Date().toISOString(), label: '', notes: '', done: false, ...sh };
    s.shoots.push(shoot); s.shoots.sort((a, b) => a.time.localeCompare(b.time));
    s.updated = Date.now(); if (s.status === 'idee') s.status = 'geplant';
    touchProject(s.projectId); persist('shoot'); return shoot;
  },
  updateShoot(spotId, shootId, patch) {
    const s = store.spot(spotId); const sh = s?.shoots.find((x) => x.id === shootId); if (!sh) return;
    Object.assign(sh, patch); s.shoots.sort((a, b) => a.time.localeCompare(b.time));
    s.updated = Date.now(); touchProject(s.projectId); persist('shoot');
  },
  deleteShoot(spotId, shootId) {
    const s = store.spot(spotId); if (!s) return;
    s.shoots = s.shoots.filter((x) => x.id !== shootId);
    s.updated = Date.now(); persist('shoot');
  },

  allTags() {
    const set = new Set(); data.spots.forEach((s) => (s.tags || []).forEach((t) => set.add(t))); return [...set].sort();
  },
  exportJSON() { return JSON.stringify({ app: 'Specula', version: 1, exported: new Date().toISOString(), projects: data.projects, spots: data.spots }, null, 1); },
  /** mode: 'merge' (Duplikate per id überspringen) | 'replace' */
  importJSON(obj, mode = 'merge') {
    if (!obj || !Array.isArray(obj.spots)) throw new Error('Keine gültige Specula-Datei');
    if (mode === 'replace') data = { version: 1, projects: [], spots: [], deleted: data.deleted || {} };
    const pIds = new Set(data.projects.map((p) => p.id)), sIds = new Set(data.spots.map((s) => s.id));
    const now = Date.now();
    let np = 0, ns = 0;
    // Importierte Einträge gelten als „jetzt geändert“ – sonst würde die Synchronisierung sie ggf. als gelöscht verwerfen
    for (const p of obj.projects || []) if (!pIds.has(p.id)) { data.projects.push({ ...p, updated: now }); delete data.deleted[p.id]; np++; }
    for (const s of obj.spots) if (!sIds.has(s.id)) { data.spots.push({ shoots: [], tags: [], ...s, updated: now }); delete data.deleted[s.id]; ns++; }
    persist('import');
    return { projects: np, spots: ns };
  },
  importPlacemarks(name, placemarks) {
    const proj = store.addProject({ name });
    placemarks.forEach((pm, i) => data.spots.push({ id: uid('s_'), projectId: proj.id, name: pm.name || `Spot ${i + 1}`, lat: pm.lat, lng: pm.lng, elevation: null, notes: pm.notes || '', tags: [], status: 'idee', rating: 0, target: null, shoots: [], order: i, created: Date.now(), updated: Date.now() }));
    persist('import');
    return proj;
  },
  /** Alles löschen – bei aktiver Synchronisierung auch auf den anderen Geräten */
  clearAll() {
    const now = Date.now();
    const deleted = { ...(data.deleted || {}) };
    [...data.projects, ...data.spots].forEach((x) => { deleted[x.id] = now; });
    data = { version: 1, projects: [], spots: [], deleted };
    persist('import');
  },
  /** Für „Rückgängig“ (z. B. Änderungen durch den KI-Assistenten) */
  snapshot() { return JSON.stringify(data); },
  restore(snap) {
    // Wiederhergestellte Einträge bekommen einen neuen Zeitstempel, danach angelegte werden als gelöscht markiert –
    // so übernimmt auch die Synchronisierung das Rückgängigmachen.
    const old = JSON.parse(snap), now = Date.now();
    const deleted = { ...(data.deleted || {}) };
    const oldIds = new Set([...old.projects, ...old.spots].map((x) => x.id));
    [...data.projects, ...data.spots].forEach((x) => { if (!oldIds.has(x.id)) deleted[x.id] = now; });
    const cur = new Map([...data.projects, ...data.spots].map((x) => [x.id, JSON.stringify(x)]));
    [...old.projects, ...old.spots].forEach((x) => { if (cur.get(x.id) !== JSON.stringify(x)) x.updated = now; delete deleted[x.id]; });
    data = { version: 1, projects: old.projects, spots: old.spots, deleted };
    persist('import');
  },
  // ── Synchronisierung ──
  syncPayload() {
    const shared = settings.gmapsKey ? { gmapsKey: settings.gmapsKey, gmapsKeyAt: settings.gmapsKeyAt || 1 } : {};
    return { projects: data.projects, spots: data.spots, deleted: data.deleted || {}, shared };
  },
  applySync(m) {
    data = { version: 1, projects: m.projects, spots: m.spots, deleted: m.deleted || {} };
    localStorage.setItem(DATA_KEY, JSON.stringify(data));
    // geteilte Einstellungen (Google-Key) vom anderen Gerät übernehmen, wenn neuer
    const sh = m.shared || {};
    if (sh.gmapsKey && (sh.gmapsKeyAt || 0) > (settings.gmapsKeyAt || 0)) {
      settings = { ...DEFAULT_SETTINGS, ...load(SETTINGS_KEY, {}), gmapsKey: sh.gmapsKey, gmapsKeyAt: sh.gmapsKeyAt };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }
    listeners.forEach((f) => f('sync'));
  },
};
function touchProject(pid) { const p = pid && store.project(pid); if (p) p.updated = Date.now(); }

// ── Einstellungen ───────────────────────────────────────────
const DEFAULT_SETTINGS = {
  gmapsKey: '',
  mapStyle: 'dark',
  layers: { sun: true, moon: true, milky: false, spots: true },
  svLayers: { sun: true, moon: true, milky: false, grid: true },
  svFov: 1.0,
  last: null, // { lat, lng, zoom, tz }
  firstRunDone: false,
  opp: { altMin: 3, altMax: 12 },
};
let settings = { ...DEFAULT_SETTINGS, ...load(SETTINGS_KEY, {}) };
settings.layers = { ...DEFAULT_SETTINGS.layers, ...settings.layers };
settings.svLayers = { ...DEFAULT_SETTINGS.svLayers, ...settings.svLayers };
window.addEventListener('storage', (e) => {
  if (e.key === SETTINGS_KEY && e.newValue) { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(e.newValue) }; listeners.forEach((f) => f('settings')); }
  if (e.key === DATA_KEY && e.newValue) { data = JSON.parse(e.newValue); data.deleted ||= {}; listeners.forEach((f) => f('sync')); }
});
export const prefs = {
  get: (k) => settings[k],
  set(k, v) {
    // erst den aktuellen Stand lesen (ein anderes Specula-Fenster könnte ihn geändert haben)
    settings = { ...DEFAULT_SETTINGS, ...load(SETTINGS_KEY, {}), [k]: v };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    if (k === 'gmapsKey') { settings.gmapsKeyAt = Date.now(); localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); anyListeners.forEach((f) => f('settings')); }
  },
  all: () => settings,
};

// ── KML ─────────────────────────────────────────────────────
export function toKML(name, spots, tz = deviceTz) {
  const x = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const pms = spots.map((s) => {
    const shoots = (s.shoots || []).map((t) => `• ${new Date(t.time).toLocaleString('de-AT', { timeZone: s.tz || tz })} ${t.label || ''}`).join('\n');
    const desc = [s.notes, shoots, (s.tags || []).join(', ')].filter(Boolean).join('\n\n');
    return `  <Placemark><name>${x(s.name)}</name><description>${x(desc)}</description><Point><coordinates>${s.lng},${s.lat},${s.elevation || 0}</coordinates></Point></Placemark>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(name)}</name>\n${pms}\n</Document></kml>`;
}
export function parseKML(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return [...doc.getElementsByTagName('Placemark')].map((pm) => {
    const c = pm.getElementsByTagName('coordinates')[0]?.textContent.trim().split(/\s+/)[0].split(',');
    if (!c) return null;
    return { name: pm.getElementsByTagName('name')[0]?.textContent.trim(), notes: pm.getElementsByTagName('description')[0]?.textContent.trim(), lng: +c[0], lat: +c[1] };
  }).filter((p) => p && isFinite(p.lat) && isFinite(p.lng));
}
