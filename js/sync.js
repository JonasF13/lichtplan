// ─────────────────────────────────────────────────────────────
// Synchronisierung Mac ↔ iPhone über ein privates GitHub-Repository
//  · Datei „lichtplan.json“ im Repo (z. B. benutzer/lichtplan-daten)
//  · Zusammenführen pro Projekt/Spot: neuester Stand gewinnt,
//    Löschungen werden über „Grabsteine“ übertragen
//  · Jede Synchronisierung ist ein Commit → kompletter Versionsverlauf
// ─────────────────────────────────────────────────────────────
import { store, prefs } from './store.js';
import { debounce } from './utils.js';

const FILE = 'lichtplan.json';
let status = { state: 'off', at: null, error: null };
const listeners = new Set();
export const syncStatus = () => status;
export function onSync(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function setStatus(p) { status = { ...status, ...p }; listeners.forEach((f) => f(status)); }

export const syncConfig = () => { const c = prefs.get('sync'); return c?.repo && c?.token ? c : null; };
export function setSyncConfig(c) {
  prefs.set('sync', c ? { repo: c.repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, ''), token: c.token.trim() } : null);
  if (syncConfig()) return syncNow();
  setStatus({ state: 'off', error: null, at: null });
  return Promise.resolve();
}

class SyncError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }

function headers(cfg, json) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${cfg.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}
const contentsUrl = (cfg) => `https://api.github.com/repos/${cfg.repo}/contents/${FILE}`;

// UTF-8-sicheres Base64
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function fetchRemote(cfg) {
  let r;
  try { r = await fetch(contentsUrl(cfg), { headers: headers(cfg), cache: 'no-store' }); }
  catch { throw new SyncError('Keine Internetverbindung', 'offline'); }
  if (r.status === 401) throw new SyncError('Token ungültig oder abgelaufen – bitte neuen Token eintragen.', 'auth');
  if (r.status === 403) throw new SyncError('Der Token darf dieses Repository nicht lesen (Berechtigung „Contents“ fehlt).', 'perm');
  if (r.status === 404) {
    const rr = await fetch(`https://api.github.com/repos/${cfg.repo}`, { headers: headers(cfg), cache: 'no-store' });
    if (!rr.ok) throw new SyncError(`Repository „${cfg.repo}“ nicht gefunden – oder der Token hat keinen Zugriff darauf.`, 'repo');
    return null; // Repo leer → erste Synchronisierung legt die Datei an
  }
  if (!r.ok) throw new SyncError(`GitHub-Fehler ${r.status}`, 'http');
  const j = await r.json();
  let text = j.content ? b64decode(j.content) : null;
  if (text == null && j.download_url) text = await (await fetch(j.download_url, { headers: headers(cfg), cache: 'no-store' })).text();
  let data;
  try { data = JSON.parse(text); } catch { throw new SyncError('Die Datei im Repository ist beschädigt.', 'data'); }
  return { sha: j.sha, data };
}

/** Zusammenführen: pro Eintrag gewinnt der neuere Stand; Grabsteine löschen ältere Stände */
export function mergeData(local, remote) {
  if (!remote) return normalize(local);
  const deleted = { ...(remote.deleted || {}) };
  for (const [id, t] of Object.entries(local.deleted || {})) if (!deleted[id] || deleted[id] < t) deleted[id] = t;
  const pick = (kind) => {
    const A = new Map((local[kind] || []).map((x) => [x.id, x]));
    const B = new Map((remote[kind] || []).map((x) => [x.id, x]));
    const out = [];
    for (const id of new Set([...A.keys(), ...B.keys()])) {
      const a = A.get(id), b = B.get(id);
      const w = !a ? b : !b ? a : (b.updated || 0) > (a.updated || 0) ? b : a;
      if (deleted[id] && deleted[id] >= (w.updated || 0)) continue;
      out.push(w);
    }
    return out;
  };
  const cutoff = Date.now() - 180 * 864e5; // alte Grabsteine aufräumen
  for (const [id, t] of Object.entries(deleted)) if (t < cutoff) delete deleted[id];
  return normalize({ projects: pick('projects'), spots: pick('spots'), deleted });
}
function normalize(d) {
  const byId = (a, b) => String(a.id).localeCompare(String(b.id));
  const del = {};
  Object.keys(d.deleted || {}).sort().forEach((k) => { del[k] = d.deleted[k]; });
  return { projects: [...(d.projects || [])].sort(byId), spots: [...(d.spots || [])].sort(byId), deleted: del };
}
const canon = (d) => JSON.stringify(normalize(d || { projects: [], spots: [], deleted: {} }));

function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? 'iPad' : 'Mac';
  return 'Browser';
}

let running = null, again = false;
export function syncNow() {
  const cfg = syncConfig();
  if (!cfg) { setStatus({ state: 'off' }); return Promise.resolve(); }
  if (running) { again = true; return running; }
  running = (async () => {
    setStatus({ state: 'syncing' });
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const remote = await fetchRemote(cfg);
        const local = store.syncPayload();
        const merged = mergeData(local, remote?.data);
        const cm = canon(merged);
        if (cm !== canon(local)) store.applySync(merged);
        if (remote && cm === canon(remote.data)) { setStatus({ state: 'ok', at: Date.now(), error: null }); return; }
        const body = {
          message: `Lichtplan-Sync von ${deviceName()} · ${merged.projects.length} Projekte, ${merged.spots.length} Spots`,
          content: b64encode(JSON.stringify({ app: 'Lichtplan', version: 1, saved: new Date().toISOString(), ...merged }, null, 1)),
          ...(remote ? { sha: remote.sha } : {}),
        };
        let r;
        try { r = await fetch(contentsUrl(cfg), { method: 'PUT', headers: headers(cfg, true), body: JSON.stringify(body) }); }
        catch { throw new SyncError('Keine Internetverbindung', 'offline'); }
        if (r.status === 409 || r.status === 422) { await new Promise((res) => setTimeout(res, 400 + attempt * 600)); continue; } // anderes Gerät war schneller → neu zusammenführen
        if (r.status === 401) throw new SyncError('Token ungültig oder abgelaufen – bitte neuen Token eintragen.', 'auth');
        if (r.status === 403 || r.status === 404) throw new SyncError('Der Token darf nicht schreiben – Berechtigung „Contents: Read and write“ nötig.', 'perm');
        if (!r.ok) throw new SyncError(`GitHub-Fehler ${r.status}`, 'http');
        setStatus({ state: 'ok', at: Date.now(), error: null });
        return;
      }
      throw new SyncError('Konflikt beim Speichern – bitte erneut versuchen.', 'conflict');
    } catch (e) {
      setStatus({ state: e.kind === 'offline' ? 'offline' : 'error', error: e.message || String(e) });
    } finally {
      running = null;
      if (again) { again = false; setTimeout(syncNow, 300); }
    }
  })();
  return running;
}

/** Verbindung testen, ohne Daten zu ändern */
export async function testSync(cfg) {
  try { const r = await fetchRemote({ repo: cfg.repo.trim(), token: cfg.token.trim() }); return { ok: true, empty: !r, spots: r?.data?.spots?.length ?? 0 }; }
  catch (e) { return { ok: false, message: e.message }; }
}

export function initSync() {
  const push = debounce(() => syncNow(), 2500);
  store.onAnyChange((why) => { if (why !== 'sync' && syncConfig()) push(); });
  document.addEventListener('visibilitychange', () => { if (syncConfig()) syncNow(); });
  window.addEventListener('online', () => syncConfig() && syncNow());
  setInterval(() => { if (syncConfig() && document.visibilityState === 'visible') syncNow(); }, 3 * 60e3);
  if (syncConfig()) syncNow(); else setStatus({ state: 'off' });
}

// ── Einrichtungs-Link fürs iPhone (QR-Code) ─────────────────
const b64url = (s) => b64encode(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => b64decode(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
export function setupLink(baseUrl) {
  const payload = { v: 1, sync: syncConfig(), gmapsKey: prefs.get('gmapsKey') || null };
  return `${baseUrl.replace(/#.*$/, '')}#lp-setup=${b64url(JSON.stringify(payload))}`;
}
export function readSetupLink() {
  const m = location.hash.match(/lp-setup=([\w-]+)/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search); // Token nicht im Verlauf lassen
  try { return JSON.parse(unb64url(m[1])); } catch { return { invalid: true }; }
}
