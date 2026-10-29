// ─────────────────────────────────────────────────────────────
// Inspector: Licht · Mond · Nacht · Planer · Wetter
// ─────────────────────────────────────────────────────────────
import { state, setState, onState } from './state.js';
import {
  getDay, sunPos, moonPos, gcPos, moonPhaseName, nextQuarters, seasons, milkyWayNight, milkyWayCalendar,
  searchAlignment, searchMoonOpportunities, OPP_TYPES, observer,
} from './astro.js';
import {
  $, $$, icon, esc, fmtTime, fmtDate, fmtDateShort, fmtDuration, fmtDeg, fmtAz, fmtNum, fmtDist, fmtRel,
  phaseOf, PHASES, distance, bearing, elevationAngle, rafThrottle, zonedParts, zonedToUtc, debounce,
} from './utils.js';
import { drawMoon, COLORS } from './map.js';
import { elevations } from './services.js';
import { prefs } from './store.js';
import { getTideModel, cachedTideModel, tideDay, tideNow, tideEvents, isMicroTidal } from './tides.js';

let current = 'light';
export function initPanels() {
  $$('#insp-tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  buildPlanner();
  const r = rafThrottle(render);
  onState((ch) => {
    if (ch.has('target') || ch.has('lat') || ch.has('lng')) updateTargetInfo();
    r(ch);
  });
  render(new Set(['init']));
  updateTargetInfo();
  window.addEventListener('lp-tides', () => { if (current === 'tides') render(new Set(['tides'])); });
}
export function showTab(tab) {
  if (tab === 'ai') { window.dispatchEvent(new CustomEvent('lp-open-ai')); return; }
  current = tab;
  window.dispatchEvent(new CustomEvent('lp-tab', { detail: tab }));
  $$('#insp-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
  render(new Set(['tab']));
}

let lastNightKey = '', lastMoonKey = '';
function render(ch) {
  const day = getDay(state.lat, state.lng, state.elev, state.tz, state.time);
  if (current === 'light') renderLight(day);
  if (current === 'moon') renderMoon(day);
  if (current === 'night') renderNight(day);
  if (current === 'weather') renderWeather(day);
  if (current === 'tides') renderTides(day);
  if (current === 'plan') renderPlanLive(day);
}

const row = (label, value, sub = '', cls = '') => `<div class="kv ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
const card = (title, body, ic = '', extra = '') => `<section class="card">${title ? `<h3>${ic ? icon(ic) : ''}${title}${extra}</h3>` : ''}${body}</section>`;

// ── Licht ───────────────────────────────────────────────────
function renderLight(day) {
  const tz = state.tz, obs = day.obs;
  const s = sunPos(state.time, obs);
  const ph = phaseOf(s.alt);
  const E = day.ev;
  const shadow = s.alt > 0.5 ? 1 / Math.tan((s.alt * Math.PI) / 180) : null;
  const evRow = (t, label, color, extra = '') => {
    if (!t) return '';
    const past = t < state.time;
    const az = sunPos(t, obs).az;
    return `<button class="ev ${past ? 'past' : ''}" data-t="${t.getTime()}"><i style="background:${color}"></i><span class="ev-l">${label}</span><b>${fmtTime(t, tz)}</b><em>${fmtAz(az)}</em>${extra}</button>`;
  };
  const blue = PHASES[3].color, gold = PHASES[4].color;
  const html =
    card('', `
      <div class="hero">
        <div class="hero-icon" style="--c:${ph.color}">${icon('sun')}</div>
        <div>
          <div class="hero-title">${ph.label}</div>
          <div class="hero-sub">Sonne ${fmtDeg(s.alt, 1)} hoch · ${fmtAz(s.az)}</div>
        </div>
      </div>
      <div class="grid3">
        <div><span>Azimut</span><b>${fmtDeg(s.az, 1)}</b></div>
        <div><span>Höhe</span><b>${fmtDeg(s.alt, 1)}</b></div>
        <div><span>Schatten</span><b>${shadow ? fmtNum(shadow, shadow > 10 ? 0 : 1) + ' : 1' : '–'}</b></div>
      </div>`) +
    card('Tagesablauf', `
      <div class="evlist">
        ${evRow(E.astroDawn, 'Astron. Dämmerung', PHASES[1].color)}
        ${evRow(E.nautDawn, 'Nautische Dämmerung', PHASES[2].color)}
        ${evRow(E.civilDawn, 'Blaue Stunde', blue)}
        ${evRow(E.blueEnd, 'Goldene Stunde', gold)}
        ${evRow(E.sunrise, 'Sonnenaufgang', COLORS.sunrise)}
        ${evRow(E.goldenEnd, 'Ende Goldene Stunde', gold)}
        ${evRow(E.noon, `Höchststand · ${fmtDeg(day.sun.noonAlt, 1)}`, '#fff3a3')}
        ${evRow(E.goldenStart, 'Goldene Stunde', gold)}
        ${evRow(E.sunset, 'Sonnenuntergang', COLORS.sunset)}
        ${evRow(E.blueStart, 'Blaue Stunde', blue)}
        ${evRow(E.civilDusk, 'Ende Blaue Stunde', PHASES[2].color)}
        ${evRow(E.nautDusk, 'Nautische Dämmerung Ende', PHASES[1].color)}
        ${evRow(E.astroDusk, 'Astronomische Nacht', PHASES[0].color)}
      </div>
      ${!E.sunrise && !E.sunset ? `<p class="muted">${day.sun.maxAlt > 0 ? 'Polartag – die Sonne geht nicht unter.' : 'Polarnacht – die Sonne geht nicht auf.'}</p>` : ''}
      <div class="kvs">
        ${row('Tageslänge', fmtDuration(day.sun.dayLength))}
        ${row('Goldene Stunde morgens', E.blueEnd && E.goldenEnd ? fmtDuration(E.goldenEnd - E.blueEnd) : '–')}
        ${row('Goldene Stunde abends', E.goldenStart && E.blueStart ? fmtDuration(E.blueStart - E.goldenStart) : '–')}
      </div>`, 'clock') +
    card('Schattenlänge', `
      <div class="inline-form">
        <label>Objekthöhe <input type="number" id="shadow-h" value="${prefs.get('shadowH') ?? 10}" min="0" step="0.5"> m</label>
        <b id="shadow-out">${shadow ? fmtNum((prefs.get('shadowH') ?? 10) * shadow, 1) + ' m' : '–'}</b>
      </div>
      <p class="muted">Schatten fällt Richtung ${fmtAz((s.az + 180) % 360)}.</p>`, 'shadow') +
    seasonsCard(day);
  paint('light', html);
  $('#shadow-h')?.addEventListener('input', (e) => {
    prefs.set('shadowH', +e.target.value);
    $('#shadow-out').textContent = shadow ? fmtNum(+e.target.value * shadow, 1) + ' m' : '–';
  });
}

function seasonsCard(day) {
  const y = zonedParts(state.time, state.tz).y;
  const list = seasons(y).map((x) => {
    const d = getDay(state.lat, state.lng, state.elev, state.tz, x.time);
    return `<button class="ev" data-t="${(d.sun.set || x.time).getTime()}"><span class="ev-l">${x.name}<small>${fmtDate(x.time, state.tz)}</small></span><em>↑ ${fmtAz(d.sun.riseAz)}<br>↓ ${fmtAz(d.sun.setAz)}</em></button>`;
  }).join('');
  return card(`Sonnenwenden ${y}`, `<div class="evlist">${list}</div><p class="muted">Rechts: Richtung von Sonnenauf- und Sonnenuntergang an diesem Tag. Dazwischen pendeln die Richtungen übers Jahr.</p>`, 'calendar');
}

// ── Mond ────────────────────────────────────────────────────
function renderMoon(day) {
  const tz = state.tz, obs = day.obs;
  const m = moonPos(state.time, obs);
  const qs = nextQuarters(new Date(day.start.getTime()), 8);
  const html =
    card('', `
      <div class="hero">
        <canvas class="moon-cv" width="112" height="112"></canvas>
        <div>
          <div class="hero-title">${moonPhaseName(m.phase)}</div>
          <div class="hero-sub">${Math.round(m.illum * 100)} % beleuchtet · ${m.waxing ? 'zunehmend' : 'abnehmend'}</div>
        </div>
      </div>
      <div class="grid3">
        <div><span>Azimut</span><b>${fmtDeg(m.az, 1)}</b></div>
        <div><span>Höhe</span><b>${fmtDeg(m.alt, 1)}</b></div>
        <div><span>Distanz</span><b>${Math.round(m.dist * 149597870.7).toLocaleString('de-AT')} km</b></div>
      </div>`) +
    card('Heute', `
      <div class="evlist">
        ${day.moon.rise ? `<button class="ev" data-t="${day.moon.rise.getTime()}"><i style="background:${COLORS.moonrise}"></i><span class="ev-l">Mondaufgang</span><b>${fmtTime(day.moon.rise, tz)}</b><em>${fmtAz(day.moon.riseAz)}</em></button>` : '<p class="muted">Kein Mondaufgang an diesem Tag.</p>'}
        ${day.moon.set ? `<button class="ev" data-t="${day.moon.set.getTime()}"><i style="background:${COLORS.moonset}"></i><span class="ev-l">Monduntergang</span><b>${fmtTime(day.moon.set, tz)}</b><em>${fmtAz(day.moon.setAz)}</em></button>` : '<p class="muted">Kein Monduntergang an diesem Tag.</p>'}
      </div>`, 'moon') +
    card('Nächste Mondphasen', `<div class="evlist">${qs.map((q) => `<button class="ev" data-t="${q.time.getTime()}"><span class="moon-ico q${q.quarter}"></span><span class="ev-l">${q.name}</span><b>${fmtDateShort(q.time, tz)}</b><em>${fmtTime(q.time, tz)}</em></button>`).join('')}</div>`, 'calendar') +
    card('Mond-Fotogelegenheiten', `
      <p class="muted">Mond tief am Horizont (${prefs.get('opp').altMin}–${prefs.get('opp').altMax}°) während goldener oder blauer Stunde – die klassischen Mond-Landschaftsbilder.</p>
      <div class="opp-filter">${OPP_TYPES.map((t) => `<label class="tgl"><input type="checkbox" value="${t.key}" checked><span>${t.label}</span></label>`).join('')}
        ${state.target ? `<label class="tgl accent"><input type="checkbox" id="opp-target"><span>Nur Richtung Ziel (±8°)</span></label>` : ''}
      </div>
      <button class="btn block" id="opp-run">${icon('search')}Nächste 12 Monate durchsuchen</button>
      <div id="opp-out"></div>`, 'star');
  paint('moon', html);
  const cv = $('.tab-pane[data-pane="moon"] .moon-cv');
  if (cv) { const c = cv.getContext('2d'); c.clearRect(0, 0, 112, 112); drawMoon(c, 56, 56, 40, m.illum, m.waxing); }
  $('#opp-run').onclick = runOpportunities;
  if (oppCache.html) $('#opp-out').innerHTML = oppCache.html, bindEvButtons($('#opp-out'));
}
const oppCache = { html: '' };
async function runOpportunities() {
  const out = $('#opp-out'), btn = $('#opp-run');
  const types = $$('.opp-filter input[value]').filter((i) => i.checked).map((i) => i.value);
  const tgt = $('#opp-target')?.checked && state.target;
  btn.disabled = true;
  out.innerHTML = progressBar();
  const res = await searchMoonOpportunities(state.lat, state.lng, state.elev, state.tz, state.time, 365, {
    types, ...prefs.get('opp'),
    az: tgt ? bearing(state.lat, state.lng, state.target.lat, state.target.lng) : null, azTol: 8,
    onProgress: (f) => setProgress(out, f),
  });
  btn.disabled = false;
  oppCache.html = res.length
    ? `<div class="evlist">${res.slice(0, 40).map((r) => `<button class="ev" data-t="${r.t.getTime()}"><span class="ev-l">${fmtDate(r.t, state.tz)}<small>${r.type.label}</small></span><b>${fmtTime(r.from, state.tz)}–${fmtTime(r.to, state.tz)}</b><em>${fmtAz(r.az)}<br>${Math.round(r.illum * 100)} %</em></button>`).join('')}</div>`
    : '<p class="muted">Keine passenden Termine in den nächsten 12 Monaten.</p>';
  out.innerHTML = oppCache.html;
  bindEvButtons(out);
}

// ── Nacht / Milchstraße ─────────────────────────────────────
function renderNight(day) {
  const tz = state.tz, obs = day.obs;
  const n = milkyWayNight(state.lat, state.lng, state.elev, tz, state.time);
  const g = gcPos(state.time, obs);
  const key = `${state.lat.toFixed(2)}|${state.lng.toFixed(2)}|${day.start.getTime()}`;
  if (key !== lastNightKey) { lastNightKey = key; nightCal = null; }
  const html =
    card('', `
      <div class="hero">
        <div class="hero-icon" style="--c:${COLORS.milky}">${icon('galaxy')}</div>
        <div>
          <div class="hero-title">Milchstraßen-Kern</div>
          <div class="hero-sub">jetzt ${fmtDeg(g.alt, 1)} hoch · ${fmtAz(g.az)}</div>
        </div>
      </div>
      <div class="kvs">
        ${row('Astronomische Nacht', n.darkStart ? `${fmtTime(n.darkStart, tz)} – ${fmtTime(n.darkEnd, tz)}` : 'keine', n.darkMin ? fmtDuration(n.darkMin * 60000) : '')}
        ${row('Kern sichtbar (dunkel, ohne Mond)', n.visStart ? `${fmtTime(n.visStart, tz)} – ${fmtTime(n.visEnd, tz)}` : 'nicht sichtbar', n.visMin ? fmtDuration(n.visMin * 60000) : '')}
        ${row('Beste Zeit', n.best ? `<a href="#" data-t="${n.best.t.getTime()}">${fmtTime(n.best.t, tz)}</a>` : '–', n.best ? `${fmtAz(n.best.az)} · ${fmtDeg(n.best.alt)}` : '')}
        ${row('Mond', `${Math.round(n.illum * 100)} %`, `${fmtDuration(n.moonFreeMin * 60000)} mondfrei`)}
      </div>`) +
    card('Gute Milchstraßen-Nächte', `
      <p class="muted">Nächte der nächsten 2 Monate, in denen der Kern bei voller Dunkelheit und ohne Mond über 5° steht.</p>
      <div id="mw-cal">${nightCal ?? `<button class="btn block" id="mw-run">${icon('search')}Berechnen</button>`}</div>`, 'calendar');
  paint('night', html);
  $('#mw-run')?.addEventListener('click', () => {
    $('#mw-cal').innerHTML = progressBar(true);
    setTimeout(() => {
      const cal = milkyWayCalendar(state.lat, state.lng, state.elev, tz, state.time, 60).filter((x) => x.visMin >= 30);
      nightCal = cal.length ? `<div class="evlist">${cal.map((x) => `<button class="ev" data-t="${x.best.t.getTime()}"><span class="ev-l">${fmtDateShort(x.date, tz)}<small>${fmtTime(x.visStart, tz)}–${fmtTime(x.visEnd, tz)}</small></span><b>${fmtDuration(x.visMin * 60000)}</b><em>${fmtAz(x.best.az)}<br>Mond ${Math.round(x.illum * 100)} %</em></button>`).join('')}</div>`
        : '<p class="muted">Keine guten Nächte im Zeitraum (Saison: ca. Feb–Okt auf der Nordhalbkugel).</p>';
      $('#mw-cal').innerHTML = nightCal; bindEvButtons($('#mw-cal'));
    }, 30);
  });
}
let nightCal = null;

// ── Planer: Ziel-Ausrichtung ────────────────────────────────
function buildPlanner() {
  const pane = $('.tab-pane[data-pane="plan"]');
  pane.innerHTML =
    card('Ziel', `<div id="target-info"></div>`, 'target') +
    card('Wann steht … genau dort?', `
      <p class="muted">Findet Tage und Uhrzeiten, an denen Sonne oder Mond genau in einer Richtung und Höhe stehen – z. B. hinter einem Gipfel, Turm oder Bogen.</p>
      <div class="seg-row">
        <div class="segmented sm" id="pl-body"><button data-v="sun" class="active">${icon('sun')}Sonne</button><button data-v="moon">${icon('moon')}Mond</button></div>
      </div>
      <div class="form-grid">
        <label>Azimut<input type="number" id="pl-az" step="0.1" min="0" max="360"><small>°</small></label>
        <label>Höhe<input type="number" id="pl-alt" step="0.1" min="-2" max="90"><small>°</small></label>
        <label>Toleranz Höhe<input type="number" id="pl-tol" value="1" step="0.1" min="0.1" max="20"><small>±°</small></label>
        <label>Zeitraum<select id="pl-days"><option value="90">3 Monate</option><option value="365" selected>12 Monate</option><option value="730">2 Jahre</option></select></label>
        <label class="moon-only hidden">Mond min.<input type="number" id="pl-ill" value="0" step="5" min="0" max="100"><small>%</small></label>
      </div>
      <div class="btn-row">
        <button class="btn ghost sm" id="pl-from-target">${icon('target')}Vom Ziel übernehmen</button>
        <button class="btn ghost sm" id="pl-from-sun">${icon('sun')}Aktuelle Position</button>
      </div>
      <button class="btn primary block" id="pl-run">${icon('search')}Suchen</button>
      <div id="pl-out"></div>`, 'route') +
    `<div id="plan-live"></div>`;
  hydrate(pane);
  const body = $('#pl-body');
  body.querySelectorAll('button').forEach((b) => b.onclick = () => {
    body.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    pane.querySelector('.moon-only').classList.toggle('hidden', b.dataset.v !== 'moon');
  });
  $('#pl-from-target').onclick = () => fillFromTarget(true);
  $('#pl-from-sun').onclick = () => {
    const isMoon = body.querySelector('.active').dataset.v === 'moon';
    const obs = observer(state.lat, state.lng, state.elev);
    const p = isMoon ? moonPos(state.time, obs) : sunPos(state.time, obs);
    $('#pl-az').value = p.az.toFixed(1); $('#pl-alt').value = p.alt.toFixed(1);
  };
  $('#pl-run').onclick = runAlignment;
}
let abortCtl = null;
async function runAlignment() {
  const out = $('#pl-out'), btn = $('#pl-run');
  const az = parseFloat($('#pl-az').value), alt = parseFloat($('#pl-alt').value);
  if (!isFinite(az) || !isFinite(alt)) { out.innerHTML = '<p class="warn">Bitte Azimut und Höhe angeben – oder ein Ziel auf der Karte setzen.</p>'; return; }
  abortCtl?.abort(); abortCtl = new AbortController();
  const bodyKey = $('#pl-body .active').dataset.v;
  btn.disabled = true; out.innerHTML = progressBar();
  const hits = await searchAlignment(state.lat, state.lng, state.elev, state.tz, state.time, {
    body: bodyKey, az, alt, altTol: parseFloat($('#pl-tol').value) || 1, days: +$('#pl-days').value,
    minIllum: (parseFloat($('#pl-ill').value) || 0) / 100, maxIllum: 1, signal: abortCtl.signal,
    onProgress: (f) => setProgress(out, f),
  });
  btn.disabled = false;
  if (!hits.length) { out.innerHTML = '<p class="muted">Keine Treffer. Toleranz erhöhen oder Zeitraum verlängern.</p>'; return; }
  hits.sort((a, b) => Math.abs(a.dAlt) - Math.abs(b.dAlt) || a.t - b.t);
  const best = hits.slice(0, 60).sort((a, b) => a.t - b.t);
  out.innerHTML = `<p class="muted">${hits.length} Treffer · sortiert nach Datum · Δ = Abweichung der Höhe</p><div class="evlist">${best.map((h) => {
    const ph = phaseOf(h.sunAlt);
    return `<button class="ev" data-t="${h.t.getTime()}"><i style="background:${ph.color}"></i><span class="ev-l">${fmtDate(h.t, state.tz)}<small>${ph.label}${h.illum != null ? ` · Mond ${Math.round(h.illum * 100)} %` : ''}</small></span><b>${fmtTime(h.t, state.tz)}</b><em>${fmtDeg(h.alt, 1)}<br>Δ ${fmtNum(h.dAlt, 1)}°</em></button>`;
  }).join('')}</div>`;
  bindEvButtons(out);
}

async function updateTargetInfo() {
  const box = $('#target-info');
  if (!box) return;
  if (!state.target) {
    box.innerHTML = `<p class="muted">Kein Ziel gesetzt. Klicke oben auf <b>Ziel</b> (oder drücke <kbd>T</kbd>) und dann auf die Karte – z. B. auf einen Gipfel, eine Kirche oder einen Leuchtturm.</p>`;
    return;
  }
  const t = state.target;
  const d = distance(state.lat, state.lng, t.lat, t.lng), b = bearing(state.lat, state.lng, t.lat, t.lng);
  const render = () => {
    const ang = t.elev != null && state.elev != null ? elevationAngle(state.elev, t.elev, d) : null;
    box.innerHTML = `<div class="kvs">
      ${row('Entfernung', fmtDist(d))}
      ${row('Richtung', fmtAz(b), fmtDeg(b, 1))}
      ${row('Höhe Standort', state.elev != null ? `${Math.round(state.elev)} m` : '…')}
      ${row('Höhe Ziel', t.elev != null ? `${Math.round(t.elev)} m` : '…')}
      ${row('Höhenwinkel zum Ziel', ang != null ? fmtDeg(ang, 2) : '…', 'inkl. Erdkrümmung')}
    </div>
    <div class="btn-row"><button class="btn ghost sm" id="tg-clear">${icon('close')}Ziel entfernen</button><button class="btn ghost sm" id="tg-swap">${icon('route')}Tauschen</button></div>`;
    $('#tg-clear').onclick = () => setState({ target: null });
    $('#tg-swap').onclick = () => setState({ lat: t.lat, lng: t.lng, elev: t.elev ?? 0, target: { lat: state.lat, lng: state.lng, elev: state.elev }, placeName: '' });
    fillFromTarget(false);
  };
  render();
  if (t.elev == null) {
    debouncedElev(t);
  }
}
const debouncedElev = debounce(async (t) => {
  try {
    const [e1, e2] = await elevations([{ lat: state.lat, lng: state.lng }, t]);
    if (state.target !== t) return;
    t.elev = e2; setState({ elev: e1 });
    updateTargetInfo();
  } catch {}
}, 400);
function fillFromTarget(force) {
  const t = state.target; if (!t) return;
  const azI = $('#pl-az'), altI = $('#pl-alt');
  if (!force && azI.dataset.manual) return;
  const d = distance(state.lat, state.lng, t.lat, t.lng);
  azI.value = bearing(state.lat, state.lng, t.lat, t.lng).toFixed(1);
  if (t.elev != null) altI.value = Math.max(0, elevationAngle(state.elev || 0, t.elev, d)).toFixed(2);
}

function renderPlanLive(day) {
  const box = $('#plan-live'); if (!box) return;
  if (!state.target) { box.innerHTML = ''; return; }
  const b = bearing(state.lat, state.lng, state.target.lat, state.target.lng);
  const s = sunPos(state.time, day.obs), m = moonPos(state.time, day.obs);
  const diff = (x) => { const d = ((x - b + 540) % 360) - 180; return `${d > 0 ? '+' : ''}${fmtNum(d, 1)}°`; };
  box.innerHTML = card('Jetzt relativ zum Ziel', `<div class="kvs">${row('Sonne', diff(s.az), `Höhe ${fmtDeg(s.alt, 1)}`)}${row('Mond', diff(m.az), `Höhe ${fmtDeg(m.alt, 1)}`)}</div><p class="muted">0° = genau in Zielrichtung. Positiv = rechts vom Ziel.</p>`, 'eye');
}

// ── Wetter ──────────────────────────────────────────────────
// ── Gezeiten ────────────────────────────────────────────────
let tideErr = null, tideSearchHtml = '';
function renderTides(day) {
  const tz = state.tz;
  const model = cachedTideModel(state.lat, state.lng);
  if (!model) {
    paint('tides', card('Gezeiten', tideErr ? `<p class="warn">${esc(tideErr)}</p>` : `<div class="progress indet"><i></i></div><p class="muted">Berechne die Gezeiten für diesen Ort aus einem Jahr Meeresdaten …</p>`, 'wave'));
    if (!tideErr) getTideModel(state.lat, state.lng).then(() => { tideErr = null; }).catch((e) => { tideErr = e.message; render(new Set(['tides'])); });
    return;
  }
  if (model.inland) {
    paint('tides', card('Gezeiten', '<p class="muted">Hier gibt es keine Gezeiten – dieser Ort liegt nicht am Meer.</p><p class="muted small">Setze den Standort an eine Küste, z. B. auf einen deiner Küsten-Spots.</p>', 'wave'));
    return;
  }
  const T = tideDay(model, tz, state.time);
  const now = tideNow(model, state.time);
  const fmtH = (h) => `${h >= 0 ? '+' : '−'}${fmtNum(Math.abs(h), Math.abs(h) < 1 ? 2 : 1)} m`;
  const evList = T.events.map((e) => `<button class="ev" data-t="${e.t.getTime()}"><span class="tide-ico ${e.type}">${e.type === 'high' ? '▲' : '▼'}</span><span class="ev-l">${e.type === 'high' ? 'Hochwasser' : 'Niedrigwasser'}</span><b>${fmtTime(e.t, tz)}</b><em>${fmtH(e.h)}</em></button>`).join('');
  const micro = isMicroTidal(model);
  paint('tides',
    card('', `
      <div class="hero">
        <div class="hero-icon" style="--c:#4dd0e1">${icon('wave')}</div>
        <div>
          <div class="hero-title">${now.rising ? 'Steigend ↗' : 'Fallend ↘'} · ${fmtH(now.h)}</div>
          <div class="hero-sub">${now.next ? `${now.next.type === 'high' ? 'Hochwasser' : 'Niedrigwasser'} um ${fmtTime(now.next.t, tz)} (${fmtRel(now.next.t - state.time).replace('in ', 'in ')}) · ${fmtH(now.next.h)}` : ''}</div>
        </div>
      </div>
      ${micro ? '<p class="muted small">Im Mittelmeer sind die Gezeiten sehr klein – Wind und Luftdruck verändern den Wasserstand oft stärker als die Tide.</p>' : ''}`) +
    card(`Tidenverlauf · ${fmtDateShort(state.time, tz)}`, `
      <canvas class="tide-cv" id="tide-cv"></canvas>
      <div class="evlist">${evList || '<p class="muted">Keine Hoch-/Niedrigwasser an diesem Tag.</p>'}</div>
      <div class="kvs">${row('Tidenhub', `${fmtNum(T.range, T.range < 1 ? 2 : 1)} m`, T.kind)}</div>`, 'clock') +
    card('Gezeit zum Licht', `
      <p class="muted">Findet Tage, an denen Hoch- oder Niedrigwasser mit dem schönsten Licht zusammenfällt – z. B. Felsen und Gezeitentümpel bei Ebbe im Abendlicht.</p>
      <div class="form-grid">
        <label>Gezeit<select id="td-type"><option value="low">Niedrigwasser</option><option value="high">Hochwasser</option></select></label>
        <label>Licht<select id="td-light">
          <option value="sunset">Sonnenuntergang</option><option value="sunrise">Sonnenaufgang</option>
          <option value="goldenPm">Goldene Stunde abends</option><option value="goldenAm">Goldene Stunde morgens</option>
          <option value="bluePm">Blaue Stunde abends</option></select></label>
        <label>Toleranz<select id="td-tol"><option value="30">± 30 min</option><option value="60" selected>± 1 h</option><option value="90">± 1,5 h</option></select></label>
        <label>Zeitraum<select id="td-days"><option value="30">1 Monat</option><option value="90" selected>3 Monate</option><option value="365">12 Monate</option></select></label>
      </div>
      <button class="btn primary block" id="td-run">${icon('search')}Suchen</button>
      <div id="td-out">${tideSearchHtml}</div>`, 'search') +
    `<p class="muted small pad">Berechnet aus Meeresmodell-Daten (Open-Meteo Marine, Meerespunkt ${fmtNum(model.distKm, 0)} km entfernt). Genauigkeit typ. ±5–15 Min. Höhen relativ zum Mittelwasser, ohne Wettereinfluss. Nicht für die Navigation.</p>`);
  drawTideChart(T, day, tz);
  bindEvButtons($('#td-out'));
  $('#td-run').onclick = () => runTideSearch(model);
}

function drawTideChart(T, day, tz) {
  const cv = $('#tide-cv'); if (!cv) return;
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height, pad = 14;
  const span = T.end - T.start;
  const X = (t) => ((t - T.start) / span) * w;
  const lo = T.min - (T.max - T.min) * 0.15, hi = T.max + (T.max - T.min) * 0.25;
  const Y = (v) => pad + (1 - (v - lo) / (hi - lo || 1)) * (h - pad * 2);
  // Licht-Hintergrund (Phasen der Sonne)
  for (let i = 1; i < day.sunPath.length; i++) {
    const a = day.sunPath[i - 1];
    ctx.fillStyle = phaseOf(a.alt).color; ctx.globalAlpha = phaseOf(a.alt).key === 'day' ? 0.12 : 0.35;
    ctx.fillRect(X(a.t), 0, X(day.sunPath[i].t) - X(a.t) + 0.5, h);
  }
  ctx.globalAlpha = 1;
  // Kurve
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(77,208,225,.55)'); grad.addColorStop(1, 'rgba(77,208,225,.05)');
  ctx.beginPath(); ctx.moveTo(0, h);
  T.curve.forEach((p) => ctx.lineTo(X(p.t), Y(p.h)));
  ctx.lineTo(w, h); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath(); T.curve.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.h)) : ctx.moveTo(X(p.t), Y(p.h))));
  ctx.strokeStyle = '#4dd0e1'; ctx.lineWidth = 2; ctx.stroke();
  // Sonnenauf-/untergang
  ctx.font = '600 9.5px -apple-system, Inter, sans-serif'; ctx.textAlign = 'center';
  [[day.sun.rise, COLORS.sunrise], [day.sun.set, COLORS.sunset]].forEach(([t, c]) => { if (!t) return; ctx.fillStyle = c; ctx.fillRect(X(t) - 0.75, 0, 1.5, h); });
  // Ereignisse
  T.events.forEach((e) => {
    const x = X(e.t), y = Y(e.h);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillText(fmtTime(e.t, tz), Math.min(w - 16, Math.max(16, x)), e.type === 'high' ? y - 7 : y + 13);
  });
  // aktuelle Zeit
  if (state.time >= T.start && state.time <= T.end) { ctx.fillStyle = '#fff'; ctx.fillRect(X(state.time) - 1, 0, 2, h); }
  // Stunden
  ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.textAlign = 'left';
  for (let hh = 3; hh < 24; hh += 3) ctx.fillText(String(hh), X(T.start.getTime() + hh * 3600e3) + 2, h - 3);
}

async function runTideSearch(model) {
  const out = $('#td-out'), btn = $('#td-run');
  const type = $('#td-type').value, light = $('#td-light').value, tol = +$('#td-tol').value * 60000, days = +$('#td-days').value;
  btn.disabled = true; out.innerHTML = progressBar();
  const tz = state.tz, hits = [];
  const base = startOfDayLocal(state.time, tz);
  for (let i = 0; i < days; i++) {
    const d = new Date(base.getTime() + (i + 0.5) * 864e5);
    const day = getDay(state.lat, state.lng, state.elev, tz, d);
    const E = day.ev;
    const win = { sunset: [E.sunset, E.sunset], sunrise: [E.sunrise, E.sunrise], goldenPm: [E.goldenStart, E.blueStart], goldenAm: [E.blueEnd, E.goldenEnd], bluePm: [E.blueStart, E.civilDusk] }[light];
    if (!win[0] || !win[1]) continue;
    const a = new Date(win[0].getTime() - tol), b = new Date(win[1].getTime() + tol);
    for (const e of tideEvents(model, a, b)) {
      if (e.type !== type) continue;
      const mid = (win[0].getTime() + win[1].getTime()) / 2;
      hits.push({ e, light: win, delta: e.t - mid, day });
    }
    if (i % 20 === 19) { setProgress(out, i / days); await new Promise((r) => setTimeout(r, 0)); }
  }
  btn.disabled = false;
  const lbl = { sunset: 'Sonnenuntergang', sunrise: 'Sonnenaufgang', goldenPm: 'Goldene Stunde', goldenAm: 'Goldene Stunde', bluePm: 'Blaue Stunde' }[light];
  tideSearchHtml = hits.length
    ? `<p class="muted">${hits.length} Treffer</p><div class="evlist">${hits.slice(0, 50).map((x) => `<button class="ev" data-t="${x.e.t.getTime()}"><span class="tide-ico ${x.e.type}">${x.e.type === 'high' ? '▲' : '▼'}</span><span class="ev-l">${fmtDate(x.e.t, tz)}<small>${lbl} ${fmtTime(x.light[0], tz)}${x.light[1] !== x.light[0] ? '–' + fmtTime(x.light[1], tz) : ''}</small></span><b>${fmtTime(x.e.t, tz)}</b><em>${x.e.h >= 0 ? '+' : '−'}${fmtNum(Math.abs(x.e.h), 1)} m</em></button>`).join('')}</div>`
    : '<p class="muted">Keine Treffer im Zeitraum – Toleranz erhöhen oder Zeitraum verlängern.</p>';
  out.innerHTML = tideSearchHtml;
  bindEvButtons(out);
}
const startOfDayLocal = (d, tz) => { const p = zonedParts(d, tz); return zonedToUtc(p.y, p.m, p.d, 0, 0, tz); };

function renderWeather(day) {
  const w = state.weather;
  const tz = state.tz;
  if (!w) { paint('weather', card('Bewölkung', '<p class="muted">Lade Vorhersage …</p>', 'cloud')); return; }
  const hours = [];
  const H = w.hourly;
  for (let i = 0; i < H.time.length; i++) {
    const [dt, tm] = H.time[i].split('T');
    const [y, mo, d] = dt.split('-').map(Number); const hh = +tm.slice(0, 2);
    const t = zonedToUtc(y, mo, d, hh, 0, tz);
    if (t >= day.start && t < day.end) hours.push({ t, hh, c: H.cloud_cover[i], lo: H.cloud_cover_low[i], mid: H.cloud_cover_mid[i], hi: H.cloud_cover_high[i], pp: H.precipitation_probability?.[i], vis: H.visibility?.[i], temp: H.temperature_2m?.[i], wind: H.wind_speed_10m?.[i], rh: H.relative_humidity_2m?.[i] });
  }
  if (!hours.length) {
    paint('weather', card('Bewölkung', `<p class="muted">Für ${fmtDate(state.time, tz)} gibt es noch keine Vorhersage (max. 16 Tage voraus).</p>`, 'cloud'));
    return;
  }
  const E = day.ev;
  const at = (t) => t && hours.reduce((a, h) => (Math.abs(h.t - t) < Math.abs(a.t - t) ? h : a), hours[0]);
  const sr = at(E.sunrise), ss = at(E.sunset);
  const verdict = (h) => {
    if (!h) return '';
    if (h.lo > 70) return '<span class="tag bad">Tiefe Wolken – eher schlecht</span>';
    if (h.hi > 25 && h.hi < 80 && h.lo < 40) return '<span class="tag good">Hohe Wolken – Chance auf Farben</span>';
    if (h.c < 15) return '<span class="tag ok">Klar</span>';
    if (h.c > 85) return '<span class="tag bad">Bedeckt</span>';
    return '<span class="tag ok">Wechselhaft</span>';
  };
  const cur = at(state.time);
  const bars = hours.map((h) => `
    <div class="wbar ${h === cur ? 'cur' : ''}" title="${h.hh}:00 · ${h.c}% (tief ${h.lo} · mittel ${h.mid} · hoch ${h.hi})">
      <div class="wstack"><i class="hi" style="height:${h.hi / 3}%"></i><i class="mid" style="height:${h.mid / 3}%"></i><i class="lo" style="height:${h.lo / 3}%"></i></div>
      <span>${h.hh % 3 === 0 ? h.hh : ''}</span>
    </div>`).join('');
  paint('weather',
    card('Bewölkung', `
      <div class="wchart">${bars}</div>
      <div class="wlegend"><span><i class="lo"></i>tief</span><span><i class="mid"></i>mittel</span><span><i class="hi"></i>hoch</span></div>
      <div class="kvs">
        ${sr ? row('Sonnenaufgang ' + fmtTime(E.sunrise, tz), `${sr.c} %`, verdict(sr)) : ''}
        ${ss ? row('Sonnenuntergang ' + fmtTime(E.sunset, tz), `${ss.c} %`, verdict(ss)) : ''}
      </div>`, 'cloud') +
    card(`Um ${cur.hh}:00`, `<div class="kvs">
      ${row('Bewölkung', `${cur.c} %`, `tief ${cur.lo} · mittel ${cur.mid} · hoch ${cur.hi}`)}
      ${cur.pp != null ? row('Regenwahrscheinlichkeit', `${cur.pp} %`) : ''}
      ${cur.vis != null ? row('Sichtweite', fmtDist(cur.vis)) : ''}
      ${cur.temp != null ? row('Temperatur', `${fmtNum(cur.temp, 1)} °C`, cur.rh != null ? `Luftfeuchte ${cur.rh} %` : '') : ''}
      ${cur.wind != null ? row('Wind', `${Math.round(cur.wind)} km/h`) : ''}
    </div><p class="muted">Quelle: Open-Meteo. Hohe Wolken bei freiem Horizont = beste Chance auf Farben.</p>`, 'sun'));
}

// ── Helfer ──────────────────────────────────────────────────
function paint(pane, html) {
  const el = $(`.tab-pane[data-pane="${pane}"]`);
  const scroll = el.parentElement.scrollTop;
  el.innerHTML = html;
  el.parentElement.scrollTop = scroll;
  bindEvButtons(el);
}
function bindEvButtons(root) {
  root.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); setState({ time: new Date(+b.dataset.t) }); }));
}
function hydrate(root) { root.querySelectorAll('[data-t]').forEach(() => {}); }
const progressBar = (indet) => `<div class="progress ${indet ? 'indet' : ''}"><i style="width:0%"></i></div>`;
function setProgress(out, f) { const i = out.querySelector('.progress i'); if (i) i.style.width = `${Math.round(f * 100)}%`; }
