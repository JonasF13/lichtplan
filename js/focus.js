// ─────────────────────────────────────────────────────────────
// Fokus: Alle · Sonne · Mond · Milchstraße
// Ein Klick blendet die anderen Himmelskörper aus (Karte, Street View,
// Himmel, Live-Kamera, Zeitleiste) und zeigt eine Info-Karte mit
// „wann am besten“ + Sprungzeiten.
// ─────────────────────────────────────────────────────────────
import { prefs } from './store.js';
import { state, setState, onState } from './state.js';
import { getDay, sunPos, moonPos, moonPhaseName, nextQuarters, milkyWayNight, milkyWayCalendar } from './astro.js';
import { $, $$, icon, esc, fmtTime, fmtAz, fmtDeg, fmtDateShort, fmtDuration, rafThrottle, debounce } from './utils.js';

export const FOCI = [
  { key: 'all', label: 'Alle', icon: 'layers' },
  { key: 'sun', label: 'Sonne', icon: 'sun' },
  { key: 'moon', label: 'Mond', icon: 'moon' },
  { key: 'milky', label: 'Milchstraße', icon: 'galaxy' },
];
export const getFocus = () => prefs.get('focus') || 'all';

/** Ist eine Ebene sichtbar? (Fokus hat Vorrang vor den einzelnen Schaltern) */
export function layerOn(name, group = 'layers') {
  const f = getFocus();
  if ((name === 'sun' || name === 'moon' || name === 'milky') && f !== 'all') return name === f;
  return !!(prefs.get(group) || {})[name];
}

let api = {};
export function setFocus(f) {
  prefs.set('focus', f);
  apply();
  window.dispatchEvent(new CustomEvent('lp-focus', { detail: f }));
}

// ── Milchstraßen-Nacht (gecached, wird bei jedem Kartenzeichnen gebraucht) ──
const mwCache = new Map();
export function mwNight(lat, lng, elev, tz, date) {
  const k = `${lat.toFixed(3)}|${lng.toFixed(3)}|${tz}|${getDay(lat, lng, elev, tz, date).start.getTime()}`;
  if (!mwCache.has(k)) { if (mwCache.size > 40) mwCache.clear(); mwCache.set(k, milkyWayNight(lat, lng, elev, tz, date)); }
  return mwCache.get(k);
}
let nextGood = { key: '', val: null };
function nextGoodNight() {
  const k = `${state.lat.toFixed(2)}|${state.lng.toFixed(2)}|${getDay(state.lat, state.lng, state.elev, state.tz, state.time).start.getTime()}`;
  if (nextGood.key !== k) {
    const cal = milkyWayCalendar(state.lat, state.lng, state.elev, state.tz, state.time, 120);
    nextGood = { key: k, val: cal.find((x, i) => i > 0 && x.visMin >= 60) || null };
  }
  return nextGood.val;
}

export function initFocus(a) {
  api = a; // { showTab(tab), goInfo() }
  const bar = $('#focus-bar');
  bar.innerHTML = FOCI.map((f) => `<button data-focus="${f.key}" title="${f.label}">${icon(f.icon)}<span>${f.label}</span></button>`).join('');
  bar.querySelectorAll('button').forEach((b) => b.onclick = () => setFocus(getFocus() === b.dataset.focus && b.dataset.focus !== 'all' ? 'all' : b.dataset.focus));
  const r = rafThrottle(renderCard);
  onState((ch) => { if (ch.has('time') || ch.has('lat') || ch.has('lng') || ch.has('tz') || ch.has('view')) r(); });
  apply();
}

function apply() {
  const f = getFocus();
  document.body.dataset.focus = f;
  $$('#focus-bar button').forEach((b) => b.classList.toggle('active', b.dataset.focus === f));
  renderCard();
}

const jump = (t, label, extra = '') => t ? `<button class="fc-row" data-t="${t.getTime()}"><span>${label}</span><b>${fmtTime(t, state.tz)}</b><em>${extra}</em></button>` : '';
const span = (a, b, label, color) => a && b ? `<button class="fc-row" data-t="${a.getTime()}"><i style="background:${color}"></i><span>${label}</span><b>${fmtTime(a, state.tz)}–${fmtTime(b, state.tz)}</b><em>${fmtDuration(b - a)}</em></button>` : '';

function collapsed() {
  const v = prefs.get('fcCollapsed');
  return v == null ? document.body.classList.contains('compact-stage') : v;
}
function renderCard() {
  const card = $('#focus-card'); if (!card) return;
  const f = getFocus();
  if (f === 'all') { card.classList.add('hidden'); return; }
  let sum = '';
  const tz = state.tz;
  const day = getDay(state.lat, state.lng, state.elev, tz, state.time);
  const E = day.ev;
  let html = '';
  if (f === 'sun') {
    const s = sunPos(state.time, day.obs);
    sum = [E.goldenStart && `Gold ${fmtTime(E.goldenStart, tz)}`, E.sunset && `↓ ${fmtTime(E.sunset, tz)}`].filter(Boolean).join(' · ');
    html = `<div class="fc-head">${icon('sun')}<b>Sonne</b><span>${fmtDateShort(state.time, tz)} · jetzt ${fmtDeg(s.alt, 1)}</span><span class="fc-sum">${sum}</span>${icon('chevron', 'fc-chev')}</div><div class="fc-body">
      ${span(E.civilDawn, E.blueEnd, 'Blaue Stunde', '#3557c9')}
      ${span(E.blueEnd, E.goldenEnd, 'Goldene Stunde', '#ff9f43')}
      ${jump(E.sunrise, 'Sonnenaufgang', fmtAz(day.sun.riseAz))}
      ${jump(E.noon, 'Höchststand', fmtDeg(day.sun.noonAlt, 0))}
      ${jump(E.sunset, 'Sonnenuntergang', fmtAz(day.sun.setAz))}
      ${span(E.goldenStart, E.blueStart, 'Goldene Stunde', '#ff9f43')}
      ${span(E.blueStart, E.civilDusk, 'Blaue Stunde', '#3557c9')}</div>`;
  } else if (f === 'moon') {
    const m = moonPos(state.time, day.obs);
    const q = nextQuarters(state.time, 4);
    const full = q.find((x) => x.quarter === 2), nw = q.find((x) => x.quarter === 0);
    sum = `${Math.round(m.illum * 100)} %${day.moon.rise ? ' · ↑ ' + fmtTime(day.moon.rise, tz) : ''}`;
    html = `<div class="fc-head">${icon('moon')}<b>Mond</b><span>${moonPhaseName(m.phase)} · ${Math.round(m.illum * 100)} %</span><span class="fc-sum">${sum}</span>${icon('chevron', 'fc-chev')}</div><div class="fc-body">
      ${jump(day.moon.rise, 'Mondaufgang', fmtAz(day.moon.riseAz))}
      ${jump(day.moon.set, 'Monduntergang', fmtAz(day.moon.setAz))}
      ${full ? `<button class="fc-row" data-t="${full.time.getTime()}"><span>Vollmond</span><b>${fmtDateShort(full.time, tz)}</b><em>${fmtTime(full.time, tz)}</em></button>` : ''}
      ${nw ? `<button class="fc-row" data-t="${nw.time.getTime()}"><span>Neumond</span><b>${fmtDateShort(nw.time, tz)}</b><em>${fmtTime(nw.time, tz)}</em></button>` : ''}
      <div class="fc-actions"><button class="btn sm ghost" data-tab="moon">${icon('star')}Mond-Fotogelegenheiten</button></div></div>`;
  } else if (f === 'milky') {
    const n = mwNight(state.lat, state.lng, state.elev, tz, state.time);
    const ng = !n.visStart || n.visMin < 60 ? nextGoodNight() : null;
    sum = n.best ? `Beste Zeit ${fmtTime(n.best.t, tz)}` : ng ? `nächste gute Nacht ${fmtDateShort(ng.date, tz)}` : 'heute nicht sichtbar';
    html = `<div class="fc-head">${icon('galaxy')}<b>Milchstraße</b><span>Nacht ab ${fmtDateShort(state.time, tz)}</span><span class="fc-sum">${sum}</span>${icon('chevron', 'fc-chev')}</div><div class="fc-body">
      ${n.visStart
        ? `${span(n.visStart, n.visEnd, 'Kern sichtbar', '#c792ea')}
           ${n.best ? `<button class="fc-row best" data-t="${n.best.t.getTime()}"><i style="background:#c792ea"></i><span>Beste Zeit</span><b>${fmtTime(n.best.t, tz)}</b><em>${fmtAz(n.best.az)} · ${fmtDeg(n.best.alt)}</em></button>` : ''}`
        : `<div class="fc-note">Heute Nacht ist der Kern nicht sichtbar – ${n.darkMin ? (n.illum > 0.5 ? 'der Mond ist zu hell.' : 'er steht zur dunklen Zeit zu tief.') : 'es wird nicht richtig dunkel.'}</div>`}
      ${span(n.darkStart, n.darkEnd, 'Astronomische Nacht', '#151d3b')}
      <div class="fc-note">Mond ${Math.round(n.illum * 100)} % · ${fmtDuration(n.moonFreeMin * 60000)} mondfrei</div>
      ${ng ? `<button class="fc-row" data-t="${ng.best.t.getTime()}"><span>Nächste gute Nacht</span><b>${fmtDateShort(ng.date, tz)}</b><em>${fmtTime(ng.best.t, tz)}</em></button>` : ''}
      <div class="fc-actions"><button class="btn sm ghost" data-tab="night">${icon('calendar')}Alle guten Nächte</button></div></div>`;
  }
  card.innerHTML = html;
  card.classList.remove('hidden');
  card.classList.toggle('collapsed', collapsed());
  card.querySelector('.fc-head').onclick = () => { prefs.set('fcCollapsed', !collapsed()); card.classList.toggle('collapsed', collapsed()); };
  card.querySelectorAll('[data-t]').forEach((b) => b.onclick = () => setState({ time: new Date(+b.dataset.t) }));
  card.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { api.showTab?.(b.dataset.tab); api.goInfo?.(); });
}
