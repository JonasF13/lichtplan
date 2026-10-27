// ─────────────────────────────────────────────────────────────
// Projekte → Spots → Termine: Seitenleiste, Spot-Editor, Drehplan,
// „Spot speichern“-Dialog
// ─────────────────────────────────────────────────────────────
import { store, prefs, PROJECT_COLORS, STATUS, TAG_SUGGESTIONS, toKML } from './store.js';
import { state, setState, onState } from './state.js';
import { getDay, sunPos, moonPos, observer, milkyWayNight } from './astro.js';
import {
  $, $$, icon, esc, el, fmtTime, fmtDate, fmtDateShort, fmtDateLong, fmtAz, fmtDeg, fmtDist, fmtCoord,
  phaseOf, distance, debounce, download, zonedParts, zonedToUtc, addLocalDays, startOfLocalDay, dayKey, deviceTz,
} from './utils.js';
import { modal, confirmDialog, toast, menu } from './ui.js';
import { reverseName } from './services.js';
import { syncStatus, onSync, syncConfig, syncNow } from './sync.js';
import { HOSTED_URL } from './config.js';
import { relTime } from './utils.js';

let nav = { view: 'home', projectId: null, spotId: null, tab: 'spots', q: '', status: '', tag: '', sort: prefs.get('spotSort') || 'manual' };
let api;

export function initProjects(a) {
  api = a; // { selectSpot(id, opts), fitSpots(spots), importSunSurveyor() }
  store.subscribe((why) => (why === 'sync' ? renderSoon() : render()));
  onSync(updateSyncFoot);
  setInterval(updateSyncFoot, 30000);
  onState((ch) => {
    if (ch.has('activeSpotId')) highlightActive();
    if (ch.has('time') && (nav.view === 'spot' || (nav.view === 'project' && nav.tab === 'plan'))) renderSoon();
  });
  render();
}
const renderSoon = debounce(() => {
  const a = document.activeElement;
  if (a && $('#sidebar').contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return; // nicht beim Tippen stören
  render();
}, 250);

export function openProject(id, tab) {
  nav = { ...nav, view: 'project', projectId: id, tab: tab || nav.tab || 'spots' };
  setState({ activeProjectId: id });
  render();
  const spots = store.spotsOf(id);
  if (spots.length) api.fitSpots(spots);
}
export function openSpot(id) {
  const s = store.spot(id); if (!s) return;
  nav = { ...nav, view: 'spot', spotId: id, projectId: s.projectId };
  setState({ activeProjectId: s.projectId });
  render();
}
export function refreshSidebar() { render(); }

function updateSyncFoot() {
  const f = $('#sync-foot'); if (!f) return;
  const st = syncStatus();
  const txt = {
    off: `${icon('sync')}<span>Mit iPhone synchronisieren …</span>`,
    syncing: `<i class="spin"></i><span>Synchronisiere …</span>`,
    ok: `${icon('check')}<span>Synchronisiert ${relTime(st.at)}</span>`,
    offline: `${icon('cloud')}<span>Offline – Änderungen werden später übertragen</span>`,
    error: `${icon('close')}<span>Sync-Problem – tippen für Details</span>`,
  }[st.state] || '';
  f.className = `sync-foot ${st.state}`;
  f.innerHTML = txt;
}
export function goHome() { nav = { ...nav, view: 'home', projectId: null, spotId: null }; setState({ activeProjectId: null }); render(); }

function render() {
  const sb = $('#sidebar');
  if (nav.view === 'spot' && !store.spot(nav.spotId)) nav.view = nav.projectId ? 'project' : 'home';
  if (nav.view === 'project' && nav.projectId && !store.project(nav.projectId)) nav.view = 'home';
  const scroll = sb.querySelector('.sb-body')?.scrollTop || 0;
  sb.innerHTML = '';
  if (nav.view === 'home') sb.appendChild(renderHome());
  if (nav.view === 'project') sb.appendChild(renderProject());
  if (nav.view === 'spot') sb.appendChild(renderSpot());
  const body = sb.querySelector('.sb-body'); if (body && nav.view !== 'spot') body.scrollTop = scroll;
  highlightActive();
}
function highlightActive() { $$('#sidebar [data-spot]').forEach((n) => n.classList.toggle('active', n.dataset.spot === state.activeSpotId)); }

// ── Shoot-Info (Licht am Termin) ────────────────────────────
function shootInfo(spot, t) {
  const tz = spot.tz || state.tz;
  const obs = observer(spot.lat, spot.lng, spot.elevation || 0);
  const s = sunPos(t, obs), m = moonPos(t, obs), ph = phaseOf(s.alt);
  return { tz, s, m, ph };
}
function nextShoot(spot) {
  const now = Date.now();
  return (spot.shoots || []).map((x) => ({ ...x, d: new Date(x.time) })).filter((x) => x.d >= now - 3600e3).sort((a, b) => a.d - b.d)[0] || null;
}

// ── Startseite ──────────────────────────────────────────────
function renderHome() {
  const q = nav.q.trim().toLowerCase();
  const projects = store.projects;
  const loose = store.spotsOf(null);
  const upcoming = store.spots.flatMap((s) => (s.shoots || []).map((sh) => ({ s, sh, d: new Date(sh.time) })))
    .filter((x) => x.d >= Date.now() - 3600e3).sort((a, b) => a.d - b.d).slice(0, 4);
  const searchHits = q ? store.spots.filter((s) => [s.name, s.notes, ...(s.tags || [])].join(' ').toLowerCase().includes(q)) : [];

  const node = el(`<div class="sb">
    <div class="sb-head">
      <h2>Projekte</h2>
      <div class="sb-head-actions">
        <button class="icon-btn sm" id="sb-more" title="Import / Export">${icon('more')}</button>
        <button class="btn sm primary" id="sb-new">${icon('plus')}Projekt</button>
      </div>
    </div>
    <div class="sb-search"><span>${icon('search')}</span><input id="sb-q" placeholder="Spots durchsuchen …" value="${esc(nav.q)}"></div>
    <div class="sb-body"></div>
    <button class="sync-foot" id="sync-foot" title="Synchronisierung"></button>
  </div>`);
  const body = node.querySelector('.sb-body');
  node.querySelector('#sync-foot').onclick = () => (syncStatus().state === 'ok' ? syncNow() : api.openSettings('sync'));
  setTimeout(updateSyncFoot, 0);

  if (q) {
    body.appendChild(el(`<div class="sb-section"><h4>${searchHits.length} Treffer</h4></div>`));
    const list = el('<div class="spot-list"></div>');
    searchHits.forEach((s) => list.appendChild(spotItem(s, true)));
    body.appendChild(list);
  } else {
    if (store.isEmpty) {
      body.appendChild(el(`<div class="welcome card">
        <h3>${icon('bookmark')}Willkommen bei Lichtplan</h3>
        <p>Organisiere deine Foto-Spots in <b>Projekten</b> (z. B. eine Reise). Jeder Spot speichert Ort, Ziel, Notizen und beliebig viele <b>Termine</b> mit Uhrzeit – inklusive Lichtsituation.</p>
        ${window.__lpHasSSImport ? `<button class="btn primary block" id="sb-import-ss">${icon('download')}31 Orte aus Sun Surveyor übernehmen</button>` : ''}
        ${!syncConfig() && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' ? `<p class="muted small">${icon('phone')} Deine Projekte vom Mac holen: am Mac <b>Einstellungen → iPhone verbinden</b> und den QR-Code mit der Kamera scannen.</p>` : ''}
        <button class="btn ${window.__lpHasSSImport ? 'ghost' : 'primary'} block" id="sb-new2">${icon('plus')}Leeres Projekt anlegen</button>
      </div>`));
    }
    if (upcoming.length) {
      const sec = el(`<div class="sb-section"><h4>${icon('clock')}Nächste Termine</h4><div class="up-list"></div></div>`);
      upcoming.forEach(({ s, sh, d }) => {
        const p = store.project(s.projectId);
        const info = shootInfo(s, d);
        const b = el(`<button class="up-item" style="--c:${p?.color || '#c8d6e5'}">
          <div class="up-date"><b>${zonedParts(d, info.tz).d}</b><span>${fmtDateShort(d, info.tz).split(' ').slice(-1)[0]}</span></div>
          <div class="up-main"><b>${esc(sh.label || s.name)}</b><span>${esc(s.name)} · ${fmtTime(d, info.tz)}</span></div>
          <i class="ph-dot" style="background:${info.ph.color}" title="${info.ph.label}"></i>
        </button>`);
        b.onclick = () => { openSpot(s.id); api.selectSpot(s.id, { time: d }); };
        sec.querySelector('.up-list').appendChild(b);
      });
      body.appendChild(sec);
    }
    const plist = el('<div class="project-list"></div>');
    projects.forEach((p) => plist.appendChild(projectCard(p)));
    body.appendChild(plist);
    if (loose.length) {
      const sec = el(`<div class="sb-section"><h4>Ohne Projekt · ${loose.length}</h4></div>`);
      const list = el('<div class="spot-list"></div>');
      loose.forEach((s) => list.appendChild(spotItem(s)));
      sec.appendChild(list); body.appendChild(sec);
    }
    const archived = store.allProjects.filter((p) => p.archived);
    if (archived.length) {
      const sec = el(`<details class="sb-section archived"><summary>Archiv · ${archived.length}</summary></details>`);
      archived.forEach((p) => sec.appendChild(projectCard(p)));
      body.appendChild(sec);
    }
  }

  const qi = node.querySelector('#sb-q');
  qi.addEventListener('input', debounce(() => { nav.q = qi.value; render(); setTimeout(() => { const n = $('#sb-q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 200));
  node.querySelector('#sb-new').onclick = () => editProject();
  node.querySelector('#sb-new2')?.addEventListener('click', () => editProject());
  node.querySelector('#sb-import-ss')?.addEventListener('click', () => api.importSunSurveyor());
  node.querySelector('#sb-more').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.left, r.bottom + 6, [
      { label: 'Backup exportieren (JSON)', icon: 'download', onClick: () => download(`Lichtplan-Backup-${new Date().toISOString().slice(0, 10)}.json`, store.exportJSON()) },
      { label: 'Alle Spots als KML (Google Earth)', icon: 'download', onClick: () => download('Lichtplan.kml', toKML('Lichtplan', store.spots), 'application/vnd.google-earth.kml+xml') },
      '-',
      { label: 'Importieren (JSON / KML) …', icon: 'upload', onClick: () => api.importFile() },
      window.__lpHasSSImport ? { label: 'Orte aus Sun Surveyor übernehmen', icon: 'download', onClick: () => api.importSunSurveyor() } : null,
      '-',
      { label: 'Synchronisierung …', icon: 'sync', onClick: () => api.openSettings('sync') },
      { label: 'Einstellungen …', icon: 'settings', onClick: () => api.openSettings() },
    ]);
  };
  return node;
}

function projectCard(p) {
  const spots = store.spotsOf(p.id);
  const shoots = spots.reduce((n, s) => n + (s.shoots?.length || 0), 0);
  const done = spots.filter((s) => s.status === 'erledigt').length;
  const range = p.dateFrom ? `${fmtDateShort(new Date(p.dateFrom + 'T12:00'), deviceTz)}${p.dateTo ? ' – ' + fmtDateShort(new Date(p.dateTo + 'T12:00'), deviceTz) : ''}` : '';
  const n = el(`<button class="project-card" style="--c:${p.color}">
    <div class="pc-top"><span class="pc-dot"></span><b>${esc(p.name)}</b></div>
    ${range ? `<div class="pc-date">${icon('calendar')}${range}</div>` : ''}
    <div class="pc-meta"><span>${spots.length} Spots</span>${shoots ? `<span>${shoots} Termine</span>` : ''}${done ? `<span>${done} ✓</span>` : ''}</div>
    ${spots.length ? `<div class="pc-bar"><i style="width:${(done / spots.length) * 100}%"></i></div>` : ''}
  </button>`);
  n.onclick = () => openProject(p.id, 'spots');
  return n;
}

function spotItem(s, showProject = false) {
  const p = store.project(s.projectId);
  const ns = nextShoot(s);
  const dist = distance(state.lat, state.lng, s.lat, s.lng);
  const n = el(`<button class="spot-item" data-spot="${s.id}" style="--c:${p?.color || '#c8d6e5'}">
    <span class="si-status" style="background:${STATUS[s.status]?.color}" title="${STATUS[s.status]?.label}"></span>
    <div class="si-main">
      <div class="si-name">${esc(s.name)}${s.rating ? `<span class="stars">${'★'.repeat(s.rating)}</span>` : ''}</div>
      <div class="si-sub">${showProject && p ? `<span style="color:${p.color}">${esc(p.name)}</span> · ` : ''}${ns ? `${icon('clock')}${fmtDateShort(new Date(ns.time), s.tz || state.tz)} ${fmtTime(new Date(ns.time), s.tz || state.tz)}` : s.tags?.length ? esc(s.tags.slice(0, 3).join(' · ')) : esc((s.notes || '').slice(0, 60))}</div>
    </div>
    <span class="si-dist">${fmtDist(dist)}</span>
  </button>`);
  n.onclick = () => { api.selectSpot(s.id); openSpot(s.id); };
  return n;
}

// ── Projektansicht ──────────────────────────────────────────
function renderProject() {
  const p = store.project(nav.projectId);
  let spots = store.spotsOf(p.id);
  const allTags = [...new Set(spots.flatMap((s) => s.tags || []))].sort();
  if (nav.status) spots = spots.filter((s) => s.status === nav.status);
  if (nav.tag) spots = spots.filter((s) => (s.tags || []).includes(nav.tag));
  const sorters = {
    manual: (a, b) => (a.order ?? 0) - (b.order ?? 0),
    name: (a, b) => a.name.localeCompare(b.name, 'de'),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    next: (a, b) => (nextShoot(a)?.time || '9').localeCompare(nextShoot(b)?.time || '9'),
    dist: (a, b) => distance(state.lat, state.lng, a.lat, a.lng) - distance(state.lat, state.lng, b.lat, b.lng),
  };
  spots.sort(sorters[nav.sort] || sorters.manual);
  const range = p.dateFrom ? `${fmtDateShort(new Date(p.dateFrom + 'T12:00'), deviceTz)}${p.dateTo ? ' – ' + fmtDateShort(new Date(p.dateTo + 'T12:00'), deviceTz) : ''}` : '';

  const node = el(`<div class="sb">
    <div class="sb-head">
      <button class="icon-btn sm" id="sb-back" title="Alle Projekte">${icon('back')}</button>
      <div class="sb-title" style="--c:${p.color}"><span class="pc-dot"></span><h2>${esc(p.name)}</h2></div>
      <button class="icon-btn sm" id="sb-pmenu">${icon('more')}</button>
    </div>
    ${p.description || range ? `<div class="sb-desc">${range ? `<span class="pc-date">${icon('calendar')}${range}</span>` : ''}${p.description ? `<p>${esc(p.description)}</p>` : ''}</div>` : ''}
    <div class="segmented full" id="sb-tabs">
      <button data-t="spots" class="${nav.tab === 'spots' ? 'active' : ''}">${icon('pin')}Spots · ${store.spotsOf(p.id).length}</button>
      <button data-t="plan" class="${nav.tab === 'plan' ? 'active' : ''}">${icon('calendar')}Drehplan</button>
    </div>
    <div class="sb-body"></div>
    <div class="sb-foot"><button class="btn block" id="sb-add-here">${icon('bookmark-plus')}Aktuellen Ort hier speichern</button></div>
  </div>`);
  const body = node.querySelector('.sb-body');

  if (nav.tab === 'spots') {
    const filters = el(`<div class="filters">
      <select id="f-status"><option value="">Alle Status</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${nav.status === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <select id="f-tag"><option value="">Alle Tags</option>${allTags.map((t) => `<option ${nav.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="f-sort" title="Sortierung">${[['manual', 'Reihenfolge'], ['name', 'Name'], ['rating', 'Bewertung'], ['next', 'Nächster Termin'], ['dist', 'Entfernung']].map(([k, l]) => `<option value="${k}" ${nav.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>`);
    filters.querySelector('#f-status').onchange = (e) => { nav.status = e.target.value; render(); };
    filters.querySelector('#f-tag').onchange = (e) => { nav.tag = e.target.value; render(); };
    filters.querySelector('#f-sort').onchange = (e) => { nav.sort = e.target.value; prefs.set('spotSort', nav.sort); render(); };
    body.appendChild(filters);
    const list = el('<div class="spot-list"></div>');
    spots.forEach((s) => list.appendChild(spotItem(s)));
    if (!spots.length) list.appendChild(el(`<p class="muted pad">Noch keine Spots. Klicke auf die Karte und dann auf <b>Spot speichern</b> – oder unten auf „Aktuellen Ort hier speichern“.</p>`));
    body.appendChild(list);
  } else {
    body.appendChild(renderAgenda(p));
  }

  node.querySelector('#sb-back').onclick = goHome;
  node.querySelectorAll('#sb-tabs button').forEach((b) => b.onclick = () => { nav.tab = b.dataset.t; render(); });
  node.querySelector('#sb-add-here').onclick = () => openSaveDialog({ projectId: p.id });
  node.querySelector('#sb-pmenu').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.left - 160, r.bottom + 6, [
      { label: 'Projekt bearbeiten', icon: 'edit', onClick: () => editProject(p) },
      { label: 'Alle Spots auf Karte zeigen', icon: 'map', onClick: () => api.fitSpots(store.spotsOf(p.id)) },
      '-',
      { label: 'Als KML exportieren', icon: 'download', onClick: () => download(`${p.name}.kml`, toKML(p.name, store.spotsOf(p.id)), 'application/vnd.google-earth.kml+xml') },
      { label: 'Als Lichtplan-Datei exportieren', icon: 'download', onClick: () => download(`${p.name}.lichtplan.json`, JSON.stringify({ app: 'Lichtplan', version: 1, projects: [p], spots: store.spotsOf(p.id) }, null, 1)) },
      '-',
      { label: p.archived ? 'Aus Archiv holen' : 'Archivieren', icon: 'folder', onClick: () => { store.updateProject(p.id, { archived: !p.archived }); if (!p.archived) goHome(); } },
      { label: 'Projekt löschen …', icon: 'trash', danger: true, onClick: async () => {
        const n = store.spotsOf(p.id).length;
        if (await confirmDialog('Projekt löschen?', `„${esc(p.name)}“ wird gelöscht. ${n ? `Die ${n} Spots bleiben unter „Ohne Projekt“ erhalten.` : ''}`)) { store.deleteProject(p.id); goHome(); }
      } },
    ]);
  };
  return node;
}

/** Drehplan: Tage des Projekts mit Licht-Eckdaten und Terminen */
function renderAgenda(p) {
  const spots = store.spotsOf(p.id);
  const wrap = el('<div class="agenda"></div>');
  const items = spots.flatMap((s) => (s.shoots || []).map((sh) => ({ s, sh, d: new Date(sh.time) }))).sort((a, b) => a.d - b.d);
  // Mittelpunkt des Projekts für Tages-Eckdaten
  const c = spots.length ? { lat: spots.reduce((a, s) => a + s.lat, 0) / spots.length, lng: spots.reduce((a, s) => a + s.lng, 0) / spots.length } : { lat: state.lat, lng: state.lng };
  const tz = spots.find((s) => s.tz)?.tz || state.tz;
  const days = new Map();
  if (p.dateFrom) {
    const [y, m, d] = p.dateFrom.split('-').map(Number);
    let t = zonedToUtc(y, m, d, 12, 0, tz);
    const endKey = p.dateTo || p.dateFrom;
    for (let i = 0; i < 62 && dayKey(t, tz) <= endKey; i++) { days.set(dayKey(t, tz), { date: t, items: [] }); t = addLocalDays(t, 1, tz); }
  }
  for (const it of items) {
    const k = dayKey(it.d, it.s.tz || tz);
    if (!days.has(k)) days.set(k, { date: it.d, items: [] });
    days.get(k).items.push(it);
  }
  const keys = [...days.keys()].sort();
  if (!keys.length) {
    wrap.appendChild(el(`<div class="pad muted">
      <p><b>Noch kein Drehplan.</b></p>
      <p>1. Lege im Projekt einen Reisezeitraum fest (⋯ → Projekt bearbeiten) – dann siehst du hier jeden Tag mit Sonnenauf- und -untergang und Mondphase.</p>
      <p>2. Öffne einen Spot und füge Termine hinzu, z. B. „Sonnenuntergang“ an einem bestimmten Tag.</p></div>`));
    return wrap;
  }
  const todayK = dayKey(new Date(), tz);
  for (const k of keys) {
    const { date, items } = days.get(k);
    const day = getDay(c.lat, c.lng, 0, tz, date);
    const mw = null;
    const sec = el(`<div class="ag-day ${k < todayK ? 'past' : ''} ${k === todayK ? 'today' : ''}">
      <div class="ag-head">
        <b>${fmtDateLong(date, tz)}</b>
        <div class="ag-light">
          <span title="Sonnenaufgang" class="c-sunrise">${icon('sunrise')}${fmtTime(day.sun.rise, tz)}</span>
          <span title="Sonnenuntergang" class="c-sunset">${icon('sunset')}${fmtTime(day.sun.set, tz)}</span>
          <span title="Mondbeleuchtung">${icon('moon')}${Math.round(day.moon.noonIllum * 100)} %</span>
        </div>
      </div>
      <div class="ag-items"></div>
    </div>`);
    sec.querySelector('.ag-head').onclick = () => setState({ time: day.sun.set || date });
    const box = sec.querySelector('.ag-items');
    if (!items.length) box.appendChild(el('<div class="ag-empty">Noch nichts geplant</div>'));
    for (const { s, sh, d } of items) {
      const info = shootInfo(s, d);
      const n = el(`<button class="ag-item ${sh.done ? 'done' : ''}" data-spot="${s.id}">
        <span class="ag-time">${fmtTime(d, info.tz)}</span>
        <i class="ph-bar" style="background:${info.ph.color}"></i>
        <div class="ag-main"><b>${esc(sh.label || info.ph.label)}</b><span>${esc(s.name)}</span>
          <small>${info.ph.label} · ☀ ${fmtAz(info.s.az)} ${fmtDeg(info.s.alt, 0)} · ☾ ${Math.round(info.m.illum * 100)} %</small></div>
      </button>`);
      n.onclick = () => { api.selectSpot(s.id, { time: d }); openSpot(s.id); };
      box.appendChild(n);
    }
    wrap.appendChild(sec);
  }
  return wrap;
}

// ── Spot-Editor ─────────────────────────────────────────────
function renderSpot() {
  const s = store.spot(nav.spotId);
  const p = store.project(s.projectId);
  const tz = s.tz || state.tz;
  const projOpts = store.allProjects.map((x) => `<option value="${x.id}" ${x.id === s.projectId ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const dayHere = getDay(s.lat, s.lng, s.elevation || 0, tz, state.time);
  const node = el(`<div class="sb spot-editor">
    <div class="sb-head">
      <button class="icon-btn sm" id="sp-back" title="Zurück">${icon('back')}</button>
      <div class="sb-crumb" style="--c:${p?.color || '#c8d6e5'}"><span class="pc-dot"></span>${esc(p?.name || 'Ohne Projekt')}</div>
      <button class="icon-btn sm" id="sp-menu">${icon('more')}</button>
    </div>
    <div class="sb-body">
      <input class="title-input" id="sp-name" value="${esc(s.name)}" placeholder="Name des Spots">
      <div class="status-row">
        <div class="segmented sm" id="sp-status">${Object.entries(STATUS).map(([k, v]) => `<button data-v="${k}" class="${s.status === k ? 'active' : ''}" style="--c:${v.color}">${v.label}</button>`).join('')}</div>
        <div class="rating" id="sp-rating">${[1, 2, 3, 4, 5].map((i) => `<button data-v="${i}" class="${i <= (s.rating || 0) ? 'on' : ''}">★</button>`).join('')}</div>
      </div>

      <section class="card">
        <h3>${icon('clock')}Termine</h3>
        <div class="shoot-list" id="sp-shoots"></div>
        <div class="shoot-add">
          <button class="btn sm primary" id="sh-add-now">${icon('plus')}${fmtDateShort(state.time, tz)}, ${fmtTime(state.time, tz)}</button>
          ${dayHere.sun.rise ? `<button class="btn sm ghost" data-preset="sunrise">${icon('sunrise')}Aufgang ${fmtTime(dayHere.sun.rise, tz)}</button>` : ''}
          ${dayHere.sun.set ? `<button class="btn sm ghost" data-preset="sunset">${icon('sunset')}Untergang ${fmtTime(dayHere.sun.set, tz)}</button>` : ''}
          ${dayHere.ev.blueStart ? `<button class="btn sm ghost" data-preset="blue">Blaue Stunde ${fmtTime(dayHere.ev.blueStart, tz)}</button>` : ''}
          ${dayHere.ev.goldenStart ? `<button class="btn sm ghost" data-preset="golden">Goldene Stunde ${fmtTime(dayHere.ev.goldenStart, tz)}</button>` : ''}
        </div>
        <p class="muted small">Datum über die Zeitleiste unten wählen, dann hier hinzufügen.</p>
      </section>

      <section class="card">
        <h3>${icon('edit')}Notizen</h3>
        <textarea id="sp-notes" rows="4" placeholder="Anfahrt, Parken, Perspektive, Brennweite, Gezeiten …">${esc(s.notes || '')}</textarea>
      </section>

      <section class="card">
        <h3>${icon('tag')}Tags</h3>
        <div class="tags" id="sp-tags"></div>
        <input id="sp-tag-in" list="tag-sugg" placeholder="Tag hinzufügen + Enter">
        <datalist id="tag-sugg">${[...new Set([...store.allTags(), ...TAG_SUGGESTIONS])].map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      </section>

      <section class="card">
        <h3>${icon('pin')}Position</h3>
        <div class="kvs">
          <div class="kv"><span>Koordinaten</span><b class="mono">${fmtCoord(s.lat, s.lng)}</b></div>
          ${s.elevation != null ? `<div class="kv"><span>Höhe</span><b>${Math.round(s.elevation)} m</b></div>` : ''}
          ${s.target ? `<div class="kv"><span>Ziel</span><b>${fmtAz(bearingTo(s))}</b><em>${fmtDist(distance(s.lat, s.lng, s.target.lat, s.target.lng))}</em></div>` : ''}
          <div class="kv"><span>Licht heute</span><b>↑ ${fmtAz(dayHere.sun.riseAz)}</b><em>↓ ${fmtAz(dayHere.sun.setAz)}</em></div>
        </div>
        <div class="btn-row wrap">
          <button class="btn sm ghost" id="sp-setpos">${icon('locate')}Auf aktuellen Standort setzen</button>
          <button class="btn sm ghost" id="sp-settarget">${icon('target')}${s.target ? 'Ziel aktualisieren' : 'Aktuelles Ziel übernehmen'}</button>
          <a class="btn sm ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}">${icon('route')}Navigation</a>
          <a class="btn sm ghost" target="_blank" rel="noopener" href="https://maps.apple.com/?daddr=${s.lat},${s.lng}">${icon('map')}Apple Karten</a>
        </div>
      </section>
      <p class="muted small pad">Angelegt ${new Date(s.created).toLocaleDateString('de-AT')}${s.source ? ` · Quelle: ${esc(s.source)}` : ''}</p>
    </div>
  </div>`);

  // Termine
  const list = node.querySelector('#sp-shoots');
  if (!s.shoots?.length) list.appendChild(el('<p class="muted small">Noch keine Termine. Ein Termin merkt sich Datum + Uhrzeit, damit du die Lichtsituation jederzeit wieder aufrufen kannst.</p>'));
  (s.shoots || []).forEach((sh) => {
    const d = new Date(sh.time);
    const info = shootInfo(s, d);
    const isCur = Math.abs(d - state.time) < 60000;
    const n = el(`<div class="shoot ${sh.done ? 'done' : ''} ${isCur ? 'current' : ''} ${d < Date.now() ? 'past' : ''}">
      <button class="sh-check" title="Erledigt">${icon('check')}</button>
      <button class="sh-main">
        <div class="sh-when"><b>${fmtDateShort(d, info.tz)}</b> ${fmtTime(d, info.tz)}</div>
        <input class="sh-label" value="${esc(sh.label || '')}" placeholder="${esc(info.ph.label)}">
        <div class="sh-light"><i style="background:${info.ph.color}"></i>${info.ph.label} · ☀ ${fmtAz(info.s.az)} · ${fmtDeg(info.s.alt, 1)} · ☾ ${Math.round(info.m.illum * 100)} %</div>
      </button>
      <button class="icon-btn xs sh-del" title="Termin löschen">${icon('trash')}</button>
    </div>`);
    n.querySelector('.sh-main').onclick = (e) => { if (e.target.classList.contains('sh-label')) return; api.selectSpot(s.id, { time: d }); };
    n.querySelector('.sh-label').addEventListener('change', (e) => store.updateShoot(s.id, sh.id, { label: e.target.value }));
    n.querySelector('.sh-label').addEventListener('click', (e) => e.stopPropagation());
    n.querySelector('.sh-check').onclick = () => store.updateShoot(s.id, sh.id, { done: !sh.done });
    n.querySelector('.sh-del').onclick = () => store.deleteShoot(s.id, sh.id);
    list.appendChild(n);
  });
  const presets = { sunrise: [dayHere.sun.rise, 'Sonnenaufgang'], sunset: [dayHere.sun.set, 'Sonnenuntergang'], blue: [dayHere.ev.blueStart, 'Blaue Stunde'], golden: [dayHere.ev.goldenStart, 'Goldene Stunde'] };
  node.querySelector('#sh-add-now').onclick = () => { store.addShoot(s.id, { time: state.time.toISOString(), label: suggestLabel(s, state.time) }); toast('Termin hinzugefügt'); };
  node.querySelectorAll('[data-preset]').forEach((b) => b.onclick = () => {
    const [t, label] = presets[b.dataset.preset]; store.addShoot(s.id, { time: t.toISOString(), label }); setState({ time: t }); toast(`${label} gemerkt`);
  });

  // Felder
  node.querySelector('#sp-name').addEventListener('input', debounce((e) => store.updateSpot(s.id, { name: e.target.value || 'Spot' }, true), 300));
  node.querySelector('#sp-name').addEventListener('change', () => store.updateSpot(s.id, {}));
  node.querySelector('#sp-notes').addEventListener('input', debounce((e) => store.updateSpot(s.id, { notes: e.target.value }, true), 400));
  autoGrow(node.querySelector('#sp-notes'));
  node.querySelectorAll('#sp-status button').forEach((b) => b.onclick = () => store.updateSpot(s.id, { status: b.dataset.v }));
  node.querySelectorAll('#sp-rating button').forEach((b) => b.onclick = () => store.updateSpot(s.id, { rating: s.rating === +b.dataset.v ? 0 : +b.dataset.v }));
  const tagBox = node.querySelector('#sp-tags');
  (s.tags || []).forEach((t) => { const c = el(`<span class="tag">${esc(t)}<button>×</button></span>`); c.querySelector('button').onclick = () => store.updateSpot(s.id, { tags: s.tags.filter((x) => x !== t) }); tagBox.appendChild(c); });
  const tagIn = node.querySelector('#sp-tag-in');
  const addTag = () => { const v = tagIn.value.trim(); if (v && !(s.tags || []).includes(v)) store.updateSpot(s.id, { tags: [...(s.tags || []), v] }); tagIn.value = ''; };
  tagIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });
  tagIn.addEventListener('change', () => { if (TAG_SUGGESTIONS.includes(tagIn.value) || store.allTags().includes(tagIn.value)) addTag(); });

  node.querySelector('#sp-back').onclick = () => (s.projectId ? openProject(s.projectId) : goHome());
  node.querySelector('#sp-setpos').onclick = () => { store.updateSpot(s.id, { lat: state.lat, lng: state.lng, elevation: state.elev, tz: state.tz }); toast('Position aktualisiert'); };
  node.querySelector('#sp-settarget').onclick = () => {
    if (!state.target) { toast('Erst ein Ziel auf der Karte setzen (Taste T)'); return; }
    store.updateSpot(s.id, { target: { ...state.target } }); toast('Ziel gespeichert');
  };
  node.querySelector('#sp-menu').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.left - 170, r.bottom + 6, [
      ...store.allProjects.filter((x) => x.id !== s.projectId).slice(0, 8).map((x) => ({ label: `Verschieben nach „${x.name}“`, icon: 'folder', onClick: () => { store.updateSpot(s.id, { projectId: x.id }); openSpot(s.id); } })),
      { label: 'In neues Projekt verschieben …', icon: 'plus', onClick: () => editProject(null, (np) => { store.updateSpot(s.id, { projectId: np.id }); openSpot(s.id); }) },
      '-',
      { label: 'Duplizieren', icon: 'copy', onClick: () => { const c = store.addSpot({ ...JSON.parse(JSON.stringify(s)), id: undefined, name: s.name + ' (Kopie)', shoots: [] }); openSpot(c.id); } },
      { label: 'Koordinaten kopieren', icon: 'copy', onClick: () => { navigator.clipboard.writeText(fmtCoord(s.lat, s.lng, 6)); toast('Koordinaten kopiert'); } },
      '-',
      { label: 'Spot löschen …', icon: 'trash', danger: true, onClick: async () => { if (await confirmDialog('Spot löschen?', `„${esc(s.name)}“ und alle Termine werden gelöscht.`)) { const pid = s.projectId; store.deleteSpot(s.id); setState({ activeSpotId: null }); pid ? openProject(pid) : goHome(); } } },
    ]);
  };
  return node;
}
const bearingTo = (s) => { const { lat, lng } = s.target; const toR = Math.PI / 180; const y = Math.sin((lng - s.lng) * toR) * Math.cos(lat * toR); const x = Math.cos(s.lat * toR) * Math.sin(lat * toR) - Math.sin(s.lat * toR) * Math.cos(lat * toR) * Math.cos((lng - s.lng) * toR); return (Math.atan2(y, x) / toR + 360) % 360; };
function autoGrow(ta) { const f = () => { ta.style.height = 'auto'; ta.style.height = Math.min(400, ta.scrollHeight + 2) + 'px'; }; ta.addEventListener('input', f); requestAnimationFrame(f); }

function suggestLabel(spot, t) {
  const day = getDay(spot.lat, spot.lng, spot.elevation || 0, spot.tz || state.tz, t);
  const near = [[day.sun.rise, 'Sonnenaufgang'], [day.sun.set, 'Sonnenuntergang'], [day.moon.rise, 'Mondaufgang'], [day.moon.set, 'Monduntergang']]
    .filter(([x]) => x && Math.abs(x - t) < 20 * 60000)[0];
  if (near) return near[1];
  const s = sunPos(t, day.obs);
  if (s.alt < -18) {
    const mw = milkyWayNight(spot.lat, spot.lng, spot.elevation || 0, spot.tz || state.tz, t);
    if (mw.visStart && t >= mw.visStart && t <= mw.visEnd) return 'Milchstraße';
  }
  return phaseOf(s.alt).label;
}

// ── Projekt anlegen / bearbeiten ────────────────────────────
export function editProject(p = null, onCreated) {
  const isNew = !p;
  const color = p?.color || PROJECT_COLORS[store.allProjects.length % PROJECT_COLORS.length];
  modal({
    title: isNew ? 'Neues Projekt' : 'Projekt bearbeiten',
    body: `
      <div class="form">
        <label>Name<input id="pj-name" value="${esc(p?.name || '')}" placeholder="z. B. Dolomiten Herbst 2027" autofocus></label>
        <div class="row2">
          <label>Von<input type="date" id="pj-from" value="${p?.dateFrom || ''}"></label>
          <label>Bis<input type="date" id="pj-to" value="${p?.dateTo || ''}"></label>
        </div>
        <label>Beschreibung<textarea id="pj-desc" rows="3" placeholder="Ziel der Reise, Unterkunft, Ideen …">${esc(p?.description || '')}</textarea></label>
        <label>Farbe</label>
        <div class="swatches" id="pj-colors">${PROJECT_COLORS.map((c) => `<button type="button" style="--c:${c}" data-c="${c}" class="${c === color ? 'on' : ''}"></button>`).join('')}</div>
      </div>`,
    onOpen: (n) => n.querySelectorAll('#pj-colors button').forEach((b) => b.onclick = () => { n.querySelectorAll('#pj-colors button').forEach((x) => x.classList.toggle('on', x === b)); }),
    actions: [
      { label: 'Abbrechen', kind: 'ghost' },
      { label: isNew ? 'Anlegen' : 'Speichern', kind: 'primary', onClick: (n) => {
        const v = {
          name: n.querySelector('#pj-name').value.trim() || 'Neues Projekt',
          dateFrom: n.querySelector('#pj-from').value || null,
          dateTo: n.querySelector('#pj-to').value || null,
          description: n.querySelector('#pj-desc').value.trim(),
          color: n.querySelector('#pj-colors .on')?.dataset.c || color,
        };
        if (v.dateFrom && v.dateTo && v.dateTo < v.dateFrom) [v.dateFrom, v.dateTo] = [v.dateTo, v.dateFrom];
        if (isNew) { const np = store.addProject(v); onCreated ? onCreated(np) : openProject(np.id, v.dateFrom ? 'plan' : 'spots'); }
        else store.updateProject(p.id, v);
      } },
    ],
  });
}

// ── „Spot speichern“-Dialog ─────────────────────────────────
export function openSaveDialog(pre = {}) {
  const tz = state.tz;
  const day = getDay(state.lat, state.lng, state.elev, tz, state.time);
  const s = sunPos(state.time, day.obs), m = moonPos(state.time, day.obs), ph = phaseOf(s.alt);
  const defProject = pre.projectId ?? state.activeProjectId ?? prefs.get('lastProject') ?? '';
  const projOpts = store.projects.map((p) => `<option value="${p.id}" ${p.id === defProject ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const tagSugg = [...new Set([...TAG_SUGGESTIONS.slice(0, 8), ...store.allTags()])].slice(0, 14);
  const autoTags = new Set();
  if (ph.key === 'golden') autoTags.add('Goldene Stunde');
  if (ph.key === 'blue') autoTags.add('Blaue Stunde');
  if (day.sun.set && Math.abs(day.sun.set - state.time) < 45 * 60000) autoTags.add('Sonnenuntergang');
  if (day.sun.rise && Math.abs(day.sun.rise - state.time) < 45 * 60000) autoTags.add('Sonnenaufgang');
  const placeholder = state.placeName || 'Name des Spots';

  const { node } = modal({
    title: 'Spot speichern',
    body: `
      <div class="form">
        <label>Name<input id="sv-name" value="${esc(state.placeName || '')}" placeholder="${esc(placeholder)}" autofocus></label>
        <label>Projekt
          <div class="row-inline">
            <select id="sv-proj"><option value="">Ohne Projekt</option>${projOpts}<option value="__new">＋ Neues Projekt …</option></select>
          </div>
          <input id="sv-newproj" class="hidden" placeholder="Name des neuen Projekts">
        </label>
        <div class="save-summary">
          <label class="tgl big"><input type="checkbox" id="sv-time" checked>
            <span><b>Zeitpunkt mitspeichern</b><small>${fmtDateLong(state.time, tz)} · ${fmtTime(state.time, tz)}</small>
            <small class="ph"><i style="background:${ph.color}"></i>${ph.label} · ☀ ${fmtAz(s.az)} ${fmtDeg(s.alt, 1)} · ☾ ${Math.round(m.illum * 100)} %</small></span>
          </label>
          ${state.target ? `<label class="tgl big"><input type="checkbox" id="sv-target" checked><span><b>Ziel mitspeichern</b><small>${fmtAz(bearingTo({ lat: state.lat, lng: state.lng, target: state.target }))} · ${fmtDist(distance(state.lat, state.lng, state.target.lat, state.target.lng))}</small></span></label>` : ''}
          <div class="mono muted small">${fmtCoord(state.lat, state.lng)}${state.elev ? ` · ${Math.round(state.elev)} m` : ''}</div>
        </div>
        <label>Tags</label>
        <div class="tag-picker" id="sv-tags">${tagSugg.map((t) => `<button type="button" class="tag ${autoTags.has(t) ? 'on' : ''}">${esc(t)}</button>`).join('')}</div>
        <label>Notizen<textarea id="sv-notes" rows="3" placeholder="Anfahrt, Perspektive, Brennweite …"></textarea></label>
      </div>`,
    actions: [
      { label: 'Abbrechen', kind: 'ghost' },
      { label: 'Speichern', kind: 'primary', icon: 'check', onClick: (n) => {
        let projectId = n.querySelector('#sv-proj').value;
        if (projectId === '__new') projectId = store.addProject({ name: n.querySelector('#sv-newproj').value.trim() || 'Neues Projekt' }).id;
        prefs.set('lastProject', projectId);
        const name = n.querySelector('#sv-name').value.trim() || state.placeName || 'Neuer Spot';
        const spot = store.addSpot({
          projectId: projectId || null, name, lat: state.lat, lng: state.lng, elevation: state.elev || null, tz: state.tz,
          notes: n.querySelector('#sv-notes').value.trim(),
          tags: [...n.querySelectorAll('#sv-tags .tag.on')].map((b) => b.textContent),
          target: n.querySelector('#sv-target')?.checked ? { ...state.target } : null,
          order: store.spotsOf(projectId || null).length,
        });
        if (n.querySelector('#sv-time').checked) store.addShoot(spot.id, { time: state.time.toISOString(), label: suggestLabel(spot, state.time) });
        setState({ activeSpotId: spot.id, activeProjectId: spot.projectId });
        openSpot(spot.id);
        toast(`„${esc(name)}“ gespeichert`);
      } },
    ],
  });
  node.querySelectorAll('#sv-tags .tag').forEach((b) => b.onclick = () => b.classList.toggle('on'));
  const sel = node.querySelector('#sv-proj');
  sel.onchange = () => node.querySelector('#sv-newproj').classList.toggle('hidden', sel.value !== '__new');
  if (!state.placeName) reverseName(state.lat, state.lng).then((r) => { const i = node.querySelector('#sv-name'); if (r && i && !i.value) i.value = r.name; });
}
