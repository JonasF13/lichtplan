// ─────────────────────────────────────────────────────────────
// Specula – Einstiegspunkt
// ─────────────────────────────────────────────────────────────
import { state, setState, onState } from './state.js';
import { store, prefs, parseKML } from './store.js';
import { initMap, flyTo, fitSpots, getMap } from './map.js';
import { initTimebar, shiftDays, shiftMinutes } from './timebar.js';
import { initPanels, showTab } from './panels.js';
import { initProjects, openSaveDialog, openSpot, openProject, refreshSidebar } from './projects.js';
import { initStreetView, activateStreetView, deactivateStreetView, resetGoogle, testGoogleKey } from './streetview.js';
import { initSky, activateSky, deactivateSky } from './sky.js';
import { initAI, toggleAI, openAI, closeAI, openAISettings, isOpen as aiOpen } from './ai/chat.js';
import { initSync, syncNow, syncConfig, setSyncConfig, syncStatus, onSync, testSync, setupLink, readSetupLink } from './sync.js';
import { isIOS, isStandalone } from './pair.js';
import { HOSTED_URL } from './config.js';
import { getTideModel } from './tides.js';
import { initLayout, go, noteView, noteTab, layout, setScreen } from './layout.js';
import { initFocus } from './focus.js';
import { initAR, activateAR, deactivateAR, arSupported } from './ar.js';
import { searchPlaces, reverseName, forecast, elevations } from './services.js';
import { modal, toast, menu, confirmDialog } from './ui.js';
import { $, $$, hydrateIcons, icon, esc, parseCoords, debounce, fmtCoord, pickFile, distance, deviceTz, relTime } from './utils.js';

hydrateIcons();

// ── Module starten ──────────────────────────────────────────
initMap({
  onSpotClick: (id) => { selectSpot(id, { keepView: true }); openSpot(id); },
  onSpotDetails: (id) => { openSpot(id); go('projects'); },
  onContext: contextMenu,
});
initTimebar({ onAddShoot: addShootToActive });
initPanels();
initProjects({ selectSpot, fitSpots, importFile, openSettings, importGoogle, pair: openPairing, showOnMap: (id) => { selectSpot(id); go('map'); if (state.view !== 'map') setView('map'); } });
initStreetView({ openSettings, toast });
initSky();
initAI({ selectSpot, openSpot, flyTo, setView });
initSync();

// ── Spot auswählen: Ort, Ziel, Zeit laden ───────────────────
function selectSpot(id, opts = {}) {
  const s = store.spot(id); if (!s) return;
  let time = opts.time;
  if (!time && s.shoots?.length) {
    const now = Date.now();
    const sorted = s.shoots.map((x) => new Date(x.time)).sort((a, b) => a - b);
    time = sorted.find((d) => d >= now - 3600e3) || sorted[sorted.length - 1];
  }
  setState({
    lat: s.lat, lng: s.lng, elev: s.elevation ?? state.elev, tz: s.tz || state.tz, placeName: s.name,
    target: s.target ? { ...s.target } : null, activeSpotId: s.id, activeProjectId: s.projectId,
    ...(time ? { time } : {}),
  });
  if (state.view === 'map' && !opts.keepView) flyTo(s.lat, s.lng);
  if (layout() === 'phone' && document.body.dataset.screen === 'projects' && opts.time) setScreen('map');
}

function addShootToActive() {
  const id = state.activeSpotId; if (!id) return toast('Erst einen Spot auswählen oder speichern');
  store.addShoot(id, { time: state.time.toISOString() });
  toast('Zeitpunkt zum Spot hinzugefügt');
}

// ── Standort-Infos (Name, Höhe, Zeitzone, Wetter) ───────────
const refreshLocation = debounce(async () => {
  const { lat, lng } = state;
  const chipName = $('#loc-name'), chipSub = $('#loc-sub');
  chipSub.textContent = fmtCoord(lat, lng, 4);
  if (!state.placeName) {
    chipName.textContent = 'Standort';
    reverseName(lat, lng).then((r) => {
      if (r && state.lat === lat && state.lng === lng) { chipName.textContent = r.name; chipSub.textContent = `${r.place ? r.place + ' · ' : ''}${fmtCoord(lat, lng, 4)}`; }
    });
  } else chipName.textContent = state.placeName;
  try {
    const [elev] = await elevations([{ lat, lng }]);
    if (state.lat === lat && state.lng === lng && elev != null) {
      setState({ elev });
      chipSub.textContent = chipSub.textContent.replace(/ · \d+ m$/, '') + ` · ${Math.round(elev)} m`;
    }
  } catch {}
  getTideModel(lat, lng).catch(() => {}); // Gezeiten im Hintergrund vorbereiten (für Zeitleiste & Reiter)
  try {
    const w = await forecast(lat, lng);
    if (Math.abs(state.lat - lat) < 0.05 && Math.abs(state.lng - lng) < 0.05) {
      // Zeitzone des Ortes übernehmen – Wanduhrzeit bleibt gleich
      if (w.tz && w.tz !== state.tz) setState({ tz: w.tz });
      setState({ weather: w });
    }
  } catch { setState({ weather: null }); }
}, 450);
onState((ch) => {
  if (ch.has('lat') || ch.has('lng') || ch.has('placeName')) refreshLocation();
  if (ch.has('targetMode')) $('#btn-target-mode').classList.toggle('on', state.targetMode);
  if (ch.has('target')) $('#btn-target-mode').classList.toggle('has', !!state.target);
});
refreshLocation();

// ── Suche ───────────────────────────────────────────────────
const searchInput = $('#search'), results = $('#search-results');
let lastResults = [];
const runSearch = debounce(async () => {
  const q = searchInput.value.trim();
  if (q.length < 2) { results.classList.add('hidden'); return; }
  const c = parseCoords(q);
  const local = store.spots.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())).slice(0, 4)
    .map((s) => ({ name: s.name, label: store.project(s.projectId)?.name || 'Gespeicherter Spot', lat: s.lat, lng: s.lng, spotId: s.id }));
  lastResults = [...(c ? [{ name: 'Koordinaten', label: fmtCoord(c.lat, c.lng), ...c }] : []), ...local];
  renderResults(true);
  if (c) return;
  try { lastResults = [...lastResults, ...(await searchPlaces(q))]; } catch {}
  renderResults(false);
}, 280);
function renderResults(loading) {
  results.innerHTML = lastResults.map((r, i) => `<button data-i="${i}" class="${r.spotId ? 'spot' : ''}">${icon(r.spotId ? 'bookmark' : 'pin')}<div><b>${esc(r.name)}</b><span>${esc(r.label)}</span></div></button>`).join('') + (loading ? '<div class="muted pad small">Suche …</div>' : lastResults.length ? '' : '<div class="muted pad small">Nichts gefunden</div>');
  results.classList.remove('hidden');
  results.querySelectorAll('button').forEach((b) => b.onclick = () => pickResult(lastResults[+b.dataset.i]));
}
function pickResult(r) {
  results.classList.add('hidden'); searchInput.blur();
  if (r.spotId) { selectSpot(r.spotId); openSpot(r.spotId); return; }
  setState({ lat: r.lat, lng: r.lng, placeName: r.name === 'Koordinaten' ? '' : r.name, activeSpotId: null });
  flyTo(r.lat, r.lng, 14);
}
searchInput.addEventListener('input', runSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && lastResults[0]) pickResult(lastResults[0]);
  if (e.key === 'Escape') { results.classList.add('hidden'); searchInput.blur(); }
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('.search-wrap')) results.classList.add('hidden'); });

// ── Kopfzeile ───────────────────────────────────────────────
$('#btn-locate').onclick = () => {
  if (!navigator.geolocation) return toast('Standortbestimmung nicht verfügbar');
  toast('Bestimme Standort …');
  navigator.geolocation.getCurrentPosition(
    (p) => { setState({ lat: p.coords.latitude, lng: p.coords.longitude, placeName: '', activeSpotId: null }); flyTo(p.coords.latitude, p.coords.longitude, 15); },
    () => toast('Standort konnte nicht bestimmt werden', 'warn'), { enableHighAccuracy: true, timeout: 10000 });
};
$('#btn-save-spot').onclick = () => openSaveDialog();
$('#btn-ai').onclick = () => (layout() === 'desktop' ? toggleAI() : aiOpen() ? (closeAI(), layout() === 'phone' && setScreen('map')) : go('ai'));
$('#btn-settings').onclick = () => openSettings();
$('#btn-target-mode').onclick = () => {
  if (state.target && !state.targetMode) {
    menu($('#btn-target-mode').getBoundingClientRect().left, $('#btn-target-mode').getBoundingClientRect().bottom + 6, [
      { label: 'Neues Ziel setzen', icon: 'target', onClick: () => setState({ targetMode: true }) },
      { label: 'Ziel entfernen', icon: 'close', onClick: () => setState({ target: null }) },
      { label: 'Planer öffnen', icon: 'route', onClick: () => go('info', 'plan') },
    ]);
  } else setState({ targetMode: !state.targetMode });
  if (state.targetMode) { toast('Klicke auf die Karte, um das Ziel zu setzen'); if (state.view !== 'map') setView('map'); }
};
$('#btn-copy-coords').onclick = () => { navigator.clipboard?.writeText(fmtCoord(state.lat, state.lng, 6)); toast('Koordinaten kopiert'); };

// ── Ansichten ───────────────────────────────────────────────
function setView(v) {
  if (v === 'ar' && !arSupported() && layout() === 'desktop') { toast('Die Live-Ansicht gibt es am iPhone und iPad'); return; }
  setState({ view: v });
  $$('#view-switch button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('#stage .view').forEach((n) => n.classList.toggle('active', n.id === `view-${v}`));
  document.body.dataset.view = v;
  v === 'sv' ? activateStreetView() : deactivateStreetView();
  v === 'sky' ? activateSky() : deactivateSky();
  v === 'stars' ? activateStars() : deactivateStars();
  v === 'ar' ? activateAR() : deactivateAR();
  if (v === 'map') setTimeout(() => getMap().invalidateSize(), 50);
  noteView(v);
}
// ── Sternkarte (js/starsky.js) ──────────────────────────────
let starView = null;
async function activateStars() {
  try {
    const m = await import('./starsky.js');
    if (!starView) {
      starView = m.initStarView({
        canvas: $('#stars-canvas'),
        getTime: () => state.time,
        getLocation: () => ({ lat: state.lat, lng: state.lng, elev: state.elev, tz: state.tz }),
        setTime: (d) => setState({ time: d }),
      });
    }
    if (state.view === 'stars') starView.activate();
  } catch (e) {
    console.warn(e);
    const v = $('#view-stars');
    if (!v.querySelector('.ar-card')) v.insertAdjacentHTML('beforeend', `<div class="ar-card glass"><div class="empty-icon">${icon('stars')}</div><h2>Sternkarte</h2><p>Die Sternkarte mit Sternbildern, Planeten und Milchstraße kommt mit dem nächsten Update.</p></div>`);
  }
}
function deactivateStars() { starView?.deactivate?.(); }
onState((ch) => { if (state.view === 'stars' && (ch.has('time') || ch.has('lat') || ch.has('lng'))) starView?.redraw?.(); });
$$('#view-switch button').forEach((b) => b.onclick = () => setView(b.dataset.view));

// ── Kontextmenü (Rechtsklick auf Karte) ─────────────────────
function contextMenu(latlng, pt) {
  const r = $('#map').getBoundingClientRect();
  menu(r.left + pt.x, r.top + pt.y, [
    { label: 'Standort hierher', icon: 'pin', onClick: () => setState({ lat: latlng.lat, lng: latlng.lng, placeName: '', activeSpotId: null }) },
    { label: 'Ziel hierher', icon: 'target', onClick: () => setState({ target: { lat: latlng.lat, lng: latlng.lng, elev: null } }) },
    '-',
    { label: 'Hier als Spot speichern …', icon: 'bookmark-plus', onClick: () => { setState({ lat: latlng.lat, lng: latlng.lng, placeName: '', activeSpotId: null }); openSaveDialog(); } },
    { label: 'Street View hier', icon: 'streetview', onClick: () => { setState({ lat: latlng.lat, lng: latlng.lng, placeName: '' }); setView('sv'); } },
    { label: 'Koordinaten kopieren', icon: 'copy', onClick: () => { navigator.clipboard?.writeText(fmtCoord(latlng.lat, latlng.lng, 6)); toast('Koordinaten kopiert'); } },
  ]);
}

// ── Tastatur ────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]') || $('.modal-backdrop')) return;
  const k = e.key;
  if (k === 'ArrowRight') { shiftMinutes(e.shiftKey ? 60 : e.altKey ? 1 : 10); e.preventDefault(); }
  else if (k === 'ArrowLeft') { shiftMinutes(e.shiftKey ? -60 : e.altKey ? -1 : -10); e.preventDefault(); }
  else if (k === 'ArrowUp') { shiftDays(e.shiftKey ? 7 : 1); e.preventDefault(); }
  else if (k === 'ArrowDown') { shiftDays(e.shiftKey ? -7 : -1); e.preventDefault(); }
  else if (k === 's' || k === 'S') { if (!e.metaKey && !e.ctrlKey) openSaveDialog(); }
  else if (k === 't' || k === 'T') setState({ targetMode: !state.targetMode });
  else if (k === 'n' || k === 'N') setState({ time: new Date() });
  else if (k === '1') setView('map');
  else if (k === '2') setView('sv');
  else if (k === '3') setView('sky');
  else if (k === '4') setView('stars');
  else if (k === '/' || (k === 'f' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  else if (k === 'Escape') setState({ targetMode: false });
  else if (k === 'k' || k === 'K') { if (layout() === 'desktop') toggleAI(); else go('ai'); }
  else if (k === '?') showShortcuts();
});
function showShortcuts() {
  modal({ title: 'Tastenkürzel', body: `<div class="kvs shortcuts">
    ${[['← / →', '10 Minuten (⇧ 1 Stunde, ⌥ 1 Minute)'], ['↑ / ↓', '1 Tag (⇧ 1 Woche)'], ['N', 'Jetzt'], ['S', 'Spot speichern'], ['T', 'Ziel setzen'], ['1 / 2 / 3 / 4', 'Karte / Street View / Himmel / Sterne'], ['/', 'Suche'], ['K', 'KI-Assistent'], ['Rechtsklick', 'Menü auf der Karte']]
      .map(([a, b]) => `<div class="kv"><span><kbd>${a}</kbd></span><b>${b}</b></div>`).join('')}</div>` });
}

// ── Layout (Handy / Tablet & Duo / Desktop), Fokus, Live-Kamera ──
initLayout({ setView, showTab, openAI, closeAI, aiOpen, openSettings, invalidateMap: () => getMap().invalidateSize() });
initFocus({ showTab, goInfo: () => go('info') });
initAR();
window.addEventListener('lp-open-ai', () => go('ai'));
window.addEventListener('lp-tab', (e) => noteTab(e.detail));
document.body.classList.toggle('no-ar', !arSupported());

// ── Einstellungen ───────────────────────────────────────────
function openSettings(focus) {
  const key = prefs.get('gmapsKey') || '';
  modal({
    title: 'Einstellungen', wide: true,
    body: `
      <div class="form">
        <section class="set-sec" id="set-gmaps">
          <h3>${icon('streetview')}Google Street View</h3>
          <p class="muted">Für die Street-View-Ansicht mit Sonnenbahn wird ein eigener Google-Maps-API-Key benötigt. Google gewährt dafür ein monatliches Gratis-Kontingent, das für privaten Gebrauch normalerweise reicht. Der Key wird nur lokal in diesem Browser gespeichert.</p>
          <label>API-Key</label>
          <div class="row-inline"><input id="set-key" value="${esc(key)}" placeholder="AIza…" spellcheck="false" autocomplete="off" ${focus === 'gmaps' ? 'autofocus' : ''}><button type="button" class="btn sm" id="set-key-test">${icon('check')}Prüfen</button></div>
          <div id="set-key-out" class="key-out small"></div>
          <details class="howto" ${key ? '' : 'open'}><summary>So bekommst du einen Key (ca. 5 Minuten, kostenlos)</summary>
            <ol>
              <li><a href="https://console.cloud.google.com/google/maps-apis/start" target="_blank" rel="noopener"><b>Google-Maps-Einrichtung öffnen</b></a> und mit deinem Google-Konto anmelden. Der Assistent dort legt ein Projekt an und fragt nach einem Zahlungsmittel – das verlangt Google, abgebucht wird nichts, solange du im Gratis-Kontingent bleibst (Street View: 5.000 Aufrufe/Monat).</li>
              <li>Am Ende zeigt Google deinen <b>API-Key</b> (beginnt mit „AIza“). Kopieren und oben einfügen.</li>
              <li>Beim Key auf <b>„Schlüssel bearbeiten“</b> → Anwendungseinschränkungen: <b>Websites</b> → diese Adresse hinzufügen:
                <span class="copy-line"><code>${esc(location.origin)}/*</code><button type="button" class="btn sm ghost" id="set-copy-ref">${icon('copy')}Kopieren</button></span>
                API-Einschränkungen: <b>Maps JavaScript API</b>. <a href="https://console.cloud.google.com/google/maps-apis/credentials" target="_blank" rel="noopener">Zu den Schlüsseln</a></li>
              <li>Falls „Maps JavaScript API“ nicht aktiv ist: <a href="https://console.cloud.google.com/apis/library/maps-backend.googleapis.com" target="_blank" rel="noopener">hier aktivieren</a>.</li>
              <li>Optional, für 100 % Kostensicherheit: <a href="https://console.cloud.google.com/google/maps-apis/quotas" target="_blank" rel="noopener">Kontingente</a> → Maps JavaScript API → Tageslimit z. B. <b>150</b>.</li>
            </ol>
            <p class="muted">Danach auf <b>Prüfen</b> klicken – die App sagt dir genau, ob noch etwas fehlt.</p>
          </details>
        </section>
        <section class="set-sec" id="set-sync">
          <h3>${icon('sync')}Synchronisierung Mac ↔ iPhone</h3>
          <p class="muted">Hält Projekte, Spots und Termine auf allen Geräten gleich – über ein <b>privates</b> GitHub-Repository, auf das nur du Zugriff hast. Jede Änderung bleibt dort als Versionsverlauf erhalten (zusätzliches Backup).</p>
          ${syncConfig() ? '' : `<div class="pair-cta">
            <button type="button" class="btn primary" id="sync-pair">${icon('qr')}Mit Mac verbinden – QR-Code scannen</button>
            <p class="muted small">Am Mac: Einstellungen → Synchronisierung → <b>iPhone verbinden</b>. Deine Projekte, Spots und der Google-Key kommen dann automatisch hierher.</p>
          </div>`}
          <div id="sync-state" class="key-out small"></div>
          <div class="row2">
            <label>Repository<input id="sync-repo" value="${esc(syncConfig()?.repo || (HOSTED_URL.match(/^https:\/\/([^.]+)\.github\.io/)?.[1] ? HOSTED_URL.match(/^https:\/\/([^.]+)\.github\.io/)[1] + '/lichtplan-daten' : ''))}" placeholder="benutzername/lichtplan-daten" spellcheck="false" autocomplete="off"></label>
            <label>Zugriffs-Token<input id="sync-token" type="password" value="${esc(syncConfig()?.token || '')}" placeholder="github_pat_…" autocomplete="off" spellcheck="false"></label>
          </div>
          <div class="btn-row wrap">
            <button type="button" class="btn sm primary" id="sync-connect">${icon('sync')}${syncConfig() ? 'Speichern &amp; synchronisieren' : 'Verbinden'}</button>
            ${syncConfig() ? `<button type="button" class="btn sm" id="sync-now">${icon('sync')}Jetzt synchronisieren</button><button type="button" class="btn sm ghost" id="sync-off">${icon('close')}Trennen</button>` : ''}
            ${HOSTED_URL && syncConfig() ? `<button type="button" class="btn sm" id="sync-qr">${icon('qr')}iPhone verbinden (QR-Code)</button>` : ''}
          </div>
          <details class="howto" ${syncConfig() ? '' : 'open'}><summary>Zugriffs-Token erstellen (1 Minute)</summary>
            <ol>
              <li><a id="sync-token-link" href="#" target="_blank" rel="noopener"><b>Token-Formular bei GitHub öffnen</b></a> – Name, Ablauf (1 Jahr) und Berechtigung sind schon ausgefüllt.</li>
              <li>Bei <b>Repository access</b>: „Only select repositories“ → <b>lichtplan-daten</b> auswählen.</li>
              <li>Ganz unten <b>Generate token</b> → Token kopieren und oben einfügen → <b>Verbinden</b>.</li>
            </ol>
            <p class="muted">Der Token darf nur dieses eine Repository lesen und schreiben – sonst nichts.</p>
          </details>
        </section>
        <section class="set-sec">
          <h3>${icon('sparkles')}KI-Assistent</h3>
          <p class="muted">Lokale Modelle (Ollama, LM Studio) oder Cloud-Modelle (OpenRouter, OpenAI, eigener Server) einrichten und wechseln.</p>
          <button class="btn sm" id="set-ai">${icon('settings')}KI-Modelle verwalten …</button>
        </section>
        <section class="set-sec">
          <h3>${icon('star')}Mond-Fotogelegenheiten</h3>
          <div class="row2">
            <label>Mondhöhe min. (°)<input type="number" id="set-opp-min" value="${prefs.get('opp').altMin}" step="0.5"></label>
            <label>Mondhöhe max. (°)<input type="number" id="set-opp-max" value="${prefs.get('opp').altMax}" step="0.5"></label>
          </div>
        </section>
        <section class="set-sec">
          <h3>${icon('folder')}Daten</h3>
          <p class="muted">${store.allProjects.length} Projekte · ${store.spots.length} Spots · ${store.spots.reduce((n, s) => n + (s.shoots?.length || 0), 0)} Termine. Gespeichert in diesem Browser${syncConfig() ? ' und synchronisiert über GitHub' : ''}.</p>
          <div class="btn-row wrap">
            <button class="btn sm" id="set-export">${icon('download')}Backup exportieren</button>
            <button class="btn sm" id="set-import">${icon('upload')}Importieren (JSON/KML)</button>
            <button class="btn sm danger ghost" id="set-clear">${icon('trash')}Alles löschen</button>
          </div>
        </section>
        <section class="set-sec">
          <h3>${icon('sliders')}Bedienung</h3>
          <p class="muted">Drücke <kbd>?</kbd> für alle Tastenkürzel. Rechtsklick auf die Karte öffnet ein Menü.</p>
        </section>
      </div>`,
    onOpen: (n) => {
      n.querySelector('#set-export').onclick = () => import('./utils.js').then((u) => u.download(`Specula-Backup-${new Date().toISOString().slice(0, 10)}.json`, store.exportJSON()));
      n.querySelector('#set-import').onclick = importFile;
      // ── Synchronisierung
      const syncState = () => {
        const st = syncStatus(), el = n.querySelector('#sync-state'); if (!el) return;
        const map = { off: ['', ''], syncing: ['info', 'Synchronisiere …'], ok: ['ok', `✓ Synchronisiert ${relTime(st.at)}`], error: ['bad', `✗ ${st.error}`], offline: ['info', 'Offline – wird automatisch nachgeholt'] };
        const [cls, txt] = map[st.state] || ['', ''];
        el.className = `key-out small ${cls}`; el.textContent = txt;
      };
      syncState();
      onSync(syncState);
      const tokenLink = () => {
        const owner = n.querySelector('#sync-repo').value.trim().split('/')[0];
        n.querySelector('#sync-token-link').href = 'https://github.com/settings/personal-access-tokens/new?name=Specula-Sync&description=' + encodeURIComponent('Synchronisierung der Specula-App (nur Repository lichtplan-daten)') + '&expires_in=365&contents=write' + (owner ? `&target_name=${encodeURIComponent(owner)}` : '');
      };
      tokenLink();
      n.querySelector('#sync-repo').addEventListener('input', tokenLink);
      n.querySelector('#sync-connect').onclick = async () => {
        const repo = n.querySelector('#sync-repo').value.trim(), token = n.querySelector('#sync-token').value.trim();
        const el = n.querySelector('#sync-state');
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, ''))) { el.className = 'key-out small bad'; el.textContent = '✗ Repository im Format benutzername/lichtplan-daten angeben.'; return; }
        if (!token) { el.className = 'key-out small bad'; el.textContent = '✗ Bitte den Zugriffs-Token einfügen.'; return; }
        el.className = 'key-out small info'; el.textContent = 'Prüfe Zugriff …';
        const t = await testSync({ repo, token });
        if (!t.ok) { el.className = 'key-out small bad'; el.textContent = `✗ ${t.message}`; return; }
        await setSyncConfig({ repo, token });
        syncState();
        if (syncStatus().state === 'ok') {
          toast(t.empty ? 'Synchronisierung eingerichtet – deine Daten sind jetzt in GitHub gesichert' : 'Verbunden – Daten zusammengeführt');
          setTimeout(() => { n.remove(); openSettings('sync'); }, 700); // neu öffnen → Knopf „iPhone verbinden“ erscheint
        }
      };
      n.querySelector('#sync-now')?.addEventListener('click', () => syncNow());
      n.querySelector('#sync-off')?.addEventListener('click', async () => { await setSyncConfig(null); toast('Synchronisierung getrennt (Daten bleiben auf diesem Gerät)'); });
      n.querySelector('#sync-qr')?.addEventListener('click', showSetupQR);
      n.querySelector('#sync-pair')?.addEventListener('click', () => { n.remove(); openPairing(); });
      n.querySelector('#set-copy-ref')?.addEventListener('click', () => { navigator.clipboard?.writeText(`${location.origin}/*`); toast('Adresse kopiert'); });
      n.querySelector('#set-key-test').onclick = async () => {
        const out = n.querySelector('#set-key-out');
        const k = n.querySelector('#set-key').value.trim();
        out.className = 'key-out small'; out.textContent = 'Prüfe bei Google …';
        const r = await testGoogleKey(k);
        out.className = `key-out small ${r.ok ? 'ok' : r.reload ? 'info' : 'bad'}`;
        out.innerHTML = `${r.ok ? '✓ ' : r.reload ? '' : '✗ '}${esc(r.message)}`;
        if (r.ok) prefs.set('gmapsKey', k);
      };
      n.querySelector('#set-ai').onclick = () => openAISettings();
      n.querySelector('#set-clear').onclick = async () => { if (await confirmDialog('Alle Daten löschen?', syncConfig() ? 'Alle Projekte, Spots und Termine werden gelöscht – <b>auch auf deinen anderen synchronisierten Geräten</b>. (Ältere Stände bleiben im GitHub-Versionsverlauf erhalten.)' : 'Alle Projekte, Spots und Termine werden aus diesem Browser entfernt. Exportiere vorher ein Backup!')) { store.clearAll(); toast('Alle Daten gelöscht'); } };
      if (focus === 'gmaps') n.querySelector('#set-gmaps details').open = true;
      if (focus === 'sync') setTimeout(() => n.querySelector('#set-sync')?.scrollIntoView({ block: 'start' }), 50);
    },
    actions: [
      { label: 'Abbrechen', kind: 'ghost' },
      { label: 'Speichern', kind: 'primary', onClick: (n) => {
        const k = n.querySelector('#set-key').value.trim();
        const changed = k !== prefs.get('gmapsKey');
        prefs.set('gmapsKey', k);
        prefs.set('opp', { altMin: +n.querySelector('#set-opp-min').value || 3, altMax: +n.querySelector('#set-opp-max').value || 12 });
        if (changed) {
          if (window.google?.maps) { toast('Neuer Key wird nach dem Neuladen aktiv'); setTimeout(() => location.reload(), 900); }
          else { resetGoogle(); if (state.view === 'sv') activateStreetView(); }
        }
      } },
    ],
  });
}

// ── iPhone verbinden (QR-Code mit Einrichtungs-Link) ───────
async function showSetupQR() {
  const { default: qrcode } = await import('../vendor/qrcode.esm.js');
  const link = setupLink(HOSTED_URL);
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  modal({
    title: 'iPhone verbinden',
    body: `<div class="qr-wrap">${qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })}</div>
      <ol class="qr-steps">
        <li><b>Specula schon am Home-Bildschirm?</b> Dort öffnen → <b>Mit Mac verbinden</b> → diesen Code scannen. Fertig – deine Projekte werden geladen.</li>
        <li><b>Noch nicht?</b> Code mit der iPhone-<b>Kamera</b> scannen → in Safari Teilen → <b>Zum Home-Bildschirm</b>. Danach wie oben in der App verbinden.</li>
      </ol>
      <div class="btn-row"><button type="button" class="btn sm ghost" id="qr-copy">${icon('copy')}Link kopieren</button><span class="muted small">zum Einfügen am iPhone (ohne Kamera)</span></div>
      <p class="muted small">Der Code enthält deinen Sync-Token${prefs.get('gmapsKey') ? ' und den Google-Key' : ''}. Nicht weitergeben.</p>`,
    onOpen: (n) => {
      n.querySelector('#qr-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(link); toast('Link kopiert – am iPhone unter „Mit Mac verbinden → Link einfügen“ einsetzen'); }
        catch { toast('Kopieren nicht möglich', 'warn'); }
      };
    },
  });
}
// ── Mit Mac verbinden (am iPhone/iPad: QR-Code in der App scannen) ──
async function openPairing() {
  const m = await import('./pair.js');
  m.openPairing({ apply: applySetup });
}
/** Einrichtung übernehmen (aus QR-Code, Link oder Einrichtungs-Link) */
async function applySetup(cfg) {
  if (cfg.gmapsKey) prefs.set('gmapsKey', cfg.gmapsKey);
  if (cfg.sync) {
    toast('Lade deine Projekte …');
    await setSyncConfig(cfg.sync);
    const ok = syncStatus().state === 'ok';
    toast(ok ? `✓ Verbunden – ${store.spots.length} ${store.spots.length === 1 ? 'Spot' : 'Spots'} geladen${cfg.gmapsKey ? ', Street View bereit' : ''}` : `Sync: ${esc(syncStatus().error || 'Fehler')}`, ok ? '' : 'warn');
  } else if (cfg.gmapsKey) toast('✓ Google-Key für Street View übernommen');
  if (state.view === 'sv') activateStreetView();
  if (store.spots.length) { refreshSidebar(); fitSpots(store.spots); }
}
/** Einrichtung über eine lokale Datei (nur am Mac, nur vom eigenen Rechner aus anlegbar) – ohne Klick */
async function applyLocalSetup() {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  let cfg;
  try { const r = await fetch('setup.json', { cache: 'no-store' }); if (!r.ok) return; cfg = await r.json(); } catch { return; }
  if (!cfg?.nonce || prefs.get('setupNonce') === cfg.nonce) return;
  prefs.set('setupNonce', cfg.nonce);
  if (cfg.gmapsKey) prefs.set('gmapsKey', cfg.gmapsKey);
  if (cfg.sync?.repo && cfg.sync?.token) await setSyncConfig(cfg.sync);
  toast(`✓ Eingerichtet${cfg.sync ? ' – Synchronisierung verbunden' : ''}${cfg.gmapsKey ? ', Street View bereit' : ''}`);
  if (state.view === 'sv') activateStreetView();
  if (store.spots.length) refreshSidebar();
}
function handleSetupLink() {
  const cfg = readSetupLink();
  if (!cfg) return;
  if (cfg.invalid) return toast('Ungültiger Einrichtungs-Link', 'warn');
  // iPhone/iPad in Safari: Die Home-Bildschirm-App hat einen eigenen Speicher → dort verbinden
  if (isIOS() && !isStandalone() && cfg.sync) {
    modal({
      title: 'Specula aufs iPhone holen',
      body: `<ol class="qr-steps big">
          <li>In Safari auf <b>Teilen</b> tippen (bei neuem iOS über <b>•••</b>) → <b>Zum Home-Bildschirm</b> → <b>Hinzufügen</b>.</li>
          <li>Specula am <b>Home-Bildschirm</b> öffnen und auf <b>Mit Mac verbinden</b> tippen.</li>
          <li>Den QR-Code am Mac <b>in der App</b> nochmal scannen – fertig.</li>
        </ol>
        <p class="muted small">Warum zweimal? Apps am Home-Bildschirm haben am iPhone einen eigenen Speicher – was hier in Safari eingerichtet wird, sieht die App nicht.</p>`,
      actions: [
        { label: 'Nur in Safari nutzen', kind: 'ghost', onClick: () => { applySetup(cfg); } },
        { label: 'Verstanden', kind: 'primary' },
      ],
    });
    return;
  }
  if (cfg.gmapsKey && !cfg.sync) { applySetup(cfg); return; }
  modal({
    title: 'Specula einrichten',
    body: `<p>Diese Einstellungen übernehmen?</p><ul>
      ${cfg.sync ? `<li>Synchronisierung mit <b>${esc(cfg.sync.repo)}</b> – deine Projekte und Spots werden geladen</li>` : ''}
      ${cfg.gmapsKey ? '<li>Google-Key für Street View</li>' : ''}</ul>`,
    actions: [
      { label: 'Abbrechen', kind: 'ghost' },
      { label: 'Übernehmen', kind: 'primary', onClick: () => { applySetup(cfg); } },
    ],
  });
}

// ── Import ──────────────────────────────────────────────────
async function importGoogle() {
  try {
    const m = await import('./importers/googlemaps.js');
    m.openGoogleMapsImport({ onDone: (r) => { if (r?.projects?.length) openProject(r.projects[0].id || r.projects[0]); if (store.spots.length) fitSpots(store.spots); } });
  } catch (e) { console.warn(e); toast('Der Google-Maps-Import kommt mit dem nächsten Update'); }
}
async function importFile() {
  const f = await pickFile('.json,.kml,application/json,application/vnd.google-earth.kml+xml');
  if (!f) return;
  const text = await f.text();
  try {
    if (/\.kml$/i.test(f.name) || text.trimStart().startsWith('<')) {
      const pms = parseKML(text);
      if (!pms.length) throw new Error('Keine Orte in der KML-Datei');
      const p = store.importPlacemarks(f.name.replace(/\.kml$/i, ''), pms);
      toast(`${pms.length} Orte als Projekt „${esc(p.name)}“ importiert`);
      openProject(p.id);
    } else {
      const obj = JSON.parse(text);
      const res = store.importJSON(obj, 'merge');
      toast(`${res.spots} Spots, ${res.projects} Projekte importiert`);
    }
  } catch (e) { toast('Import fehlgeschlagen: ' + e.message, 'warn'); }
}

// ── Start ───────────────────────────────────────────────────
setView('map');
handleSetupLink();
applyLocalSetup();
window.addEventListener('hashchange', handleSetupLink);
if (!prefs.get('firstRunDone')) {
  prefs.set('firstRunDone', true);
  setTimeout(() => toast(matchMedia('(pointer: coarse)').matches ? 'Tipp: Tippe auf die Karte, um den Standort zu setzen' : 'Tipp: Klicke auf die Karte, um den Standort zu setzen · <kbd>?</kbd> zeigt Tastenkürzel'), 1200);
}
// ── Als eigene App installieren (Chrome/Edge: eigenes Fenster + eigenes Dock-Symbol) ──
let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('#btn-install').classList.remove('hidden');
});
$('#btn-install').onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  const r = await installEvt.userChoice;
  if (r.outcome === 'accepted') $('#btn-install').classList.add('hidden');
  installEvt = null;
};
window.addEventListener('appinstalled', () => { $('#btn-install').classList.add('hidden'); toast('Specula ist jetzt eine eigene App, mit eigenem Symbol im Dock'); });

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
// Für Tests/Debugging
window.specula = window.lichtplan = { state, setState, store, prefs };
