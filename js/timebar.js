// ─────────────────────────────────────────────────────────────
// Zeitleiste: Datum, Tages-Regler (mit Lichtphasen), Jahres-Regler (Mond)
// ─────────────────────────────────────────────────────────────
import { state, setState, onState } from './state.js';
import { getDay, sunPos, yearOverview } from './astro.js';
import { cachedTideModel, tideHeight } from './tides.js';
import { getFocus, mwNight } from './focus.js';
import {
  $, icon, zonedParts, zonedToUtc, startOfLocalDay, addLocalDays, fmtTime, fmtDateLong,
  minutesOfDay, phaseOf, PHASES, rafThrottle, tzOffsetMin, fmtDateShort,
} from './utils.js';

let onAddShoot;
export function initTimebar(opts) {
  onAddShoot = opts.onAddShoot;
  const tb = $('#timebar');
  tb.innerHTML = `
    <div class="tb-row tb-head">
      <div class="tb-date">
        <button class="icon-btn sm" id="tb-prev" title="Vorheriger Tag (↓)">${icon('chev-left')}</button>
        <label class="tb-date-btn" title="Datum wählen">
          <span id="tb-date-label"></span>
          <input type="date" id="tb-date-input" />
        </label>
        <button class="icon-btn sm" id="tb-next" title="Nächster Tag (↑)">${icon('chev-right')}</button>
      </div>
      <div class="tb-time">
        <span id="tb-time-label" class="big"></span>
        <span id="tb-phase" class="phase-badge"></span>
        <span id="tb-tz" class="muted"></span>
      </div>
      <div class="tb-actions">
        <div class="chips" id="tb-jumps"></div>
        <button class="btn sm ghost" id="tb-now">${icon('now')}Jetzt</button>
        <button class="icon-btn sm" id="tb-expand" title="Mehr anzeigen">${icon('chevron')}</button>
        <button class="btn sm" id="tb-add-shoot" title="Aktuelle Zeit als Termin zum aktiven Spot hinzufügen">${icon('clock')}Zeit merken</button>
      </div>
    </div>
    <div class="tb-row">
      <span class="tb-lbl">Tag</span>
      <div class="slider-wrap" id="day-wrap">
        <canvas id="day-canvas"></canvas>
        <input type="range" id="day-slider" min="0" max="1439" step="1" />
      </div>
    </div>
    <div class="tb-row">
      <span class="tb-lbl">Jahr</span>
      <div class="slider-wrap year" id="year-wrap">
        <canvas id="year-canvas"></canvas>
        <input type="range" id="year-slider" min="0" max="364" step="1" />
      </div>
    </div>`;

  const daySlider = $('#day-slider'), yearSlider = $('#year-slider');
  const setTime = rafThrottle((d) => setState({ time: d }));

  daySlider.addEventListener('input', () => {
    const p = zonedParts(state.time, state.tz);
    const min = +daySlider.value;
    setTime(zonedToUtc(p.y, p.m, p.d, Math.floor(min / 60), min % 60, state.tz));
  });
  yearSlider.addEventListener('input', () => {
    const p = zonedParts(state.time, state.tz);
    const base = new Date(Date.UTC(p.y, 0, 1 + +yearSlider.value));
    setTime(zonedToUtc(p.y, base.getUTCMonth() + 1, base.getUTCDate(), p.h, p.mi, state.tz));
  });
  $('#tb-prev').onclick = () => shiftDays(-1);
  $('#tb-next').onclick = () => shiftDays(1);
  $('#tb-now').onclick = () => setState({ time: new Date() });
  $('#tb-add-shoot').onclick = () => onAddShoot?.();
  const di = $('#tb-date-input');
  di.addEventListener('change', () => {
    if (!di.value) return;
    const [y, m, d] = di.value.split('-').map(Number);
    const p = zonedParts(state.time, state.tz);
    setState({ time: zonedToUtc(y, m, d, p.h, p.mi, state.tz) });
  });
  $('.tb-date-btn').addEventListener('click', (e) => { try { di.showPicker(); e.preventDefault(); } catch {} });

  new ResizeObserver(() => { lastDayKey = lastYearKey = ''; render(); document.documentElement.style.setProperty('--tb-h', tb.offsetHeight + 'px'); }).observe(tb);
  window.addEventListener('lp-tides', () => { lastDayKey = ''; render(); });
  window.addEventListener('lp-focus', () => { lastDayKey = ''; render(); });
  $('#tb-expand')?.addEventListener('click', () => { tb.classList.toggle('expanded'); lastDayKey = lastYearKey = ''; setTimeout(render, 30); });
  onState((ch) => { if (ch.has('time') || ch.has('lat') || ch.has('lng') || ch.has('tz') || ch.has('elev') || ch.has('activeSpotId')) render(); });
  render();
}

export function shiftDays(n) { setState({ time: addLocalDays(state.time, n, state.tz) }); }
export function shiftMinutes(n) { setState({ time: new Date(state.time.getTime() + n * 60000) }); }

let lastDayKey = '', lastYearKey = '';
function render() {
  const tz = state.tz;
  const day = getDay(state.lat, state.lng, state.elev, tz, state.time);
  const s = sunPos(state.time, day.obs);
  const ph = phaseOf(s.alt);
  $('#tb-date-label').textContent = fmtDateLong(state.time, tz);
  const p = zonedParts(state.time, tz);
  $('#tb-date-input').value = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  $('#tb-time-label').textContent = fmtTime(state.time, tz);
  const badge = $('#tb-phase');
  badge.textContent = ph.label; badge.style.setProperty('--c', ph.color);
  const off = tzOffsetMin(state.time, tz);
  $('#tb-tz').textContent = `${tz.split('/').pop().replace(/_/g, ' ')} · UTC${off >= 0 ? '+' : '−'}${Math.floor(Math.abs(off) / 60)}${off % 60 ? ':' + String(Math.abs(off) % 60).padStart(2, '0') : ''}`;
  $('#day-slider').value = minutesOfDay(state.time, tz);
  const doy = Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(p.y, 0, 1)) / 864e5);
  const ys = $('#year-slider');
  ys.max = isLeap(p.y) ? 365 : 364; ys.value = doy;
  $('#tb-add-shoot').classList.toggle('hidden', !state.activeSpotId);

  // Sprung-Chips
  const E = day.ev;
  const jumps = [
    ['Blau', E.civilDawn, 'blue'], ['Aufgang', E.sunrise, 'sunrise'], ['Gold', E.goldenStart, 'golden'],
    ['Untergang', E.sunset, 'sunset'], ['Blau', E.blueStart, 'blue'], ['Mond ↑', day.moon.rise, 'moon'],
  ].filter((j) => j[1]);
  $('#tb-jumps').innerHTML = jumps.map(([l, t, c], i) => `<button class="chip c-${c}" data-i="${i}" title="${fmtTime(t, tz)}">${l} <b>${fmtTime(t, tz)}</b></button>`).join('');
  $('#tb-jumps').querySelectorAll('button').forEach((b) => b.onclick = () => setState({ time: jumps[+b.dataset.i][1] }));

  const dk = `${day.start.getTime()}|${state.lat.toFixed(3)}|${state.lng.toFixed(3)}`;
  if (dk !== lastDayKey) { lastDayKey = dk; drawDay(day); }
  const yk = `${p.y}|${state.lat.toFixed(1)}|${state.lng.toFixed(1)}|${tz}`;
  if (yk !== lastYearKey) { lastYearKey = yk; drawYear(p.y); }
}
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

function prepCanvas(cv) {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

function drawDay(day) {
  const { ctx, w, h } = prepCanvas($('#day-canvas'));
  const n = day.sunPath.length;
  const dayMin = (day.end - day.start) / 60000;
  // Lichtphasen-Verlauf
  for (let i = 0; i < n - 1; i++) {
    const p = day.sunPath[i];
    const x1 = ((p.t - day.start) / 60000 / dayMin) * w, x2 = ((day.sunPath[i + 1].t - day.start) / 60000 / dayMin) * w;
    ctx.fillStyle = phaseOf(p.alt).color;
    ctx.globalAlpha = phaseOf(p.alt).key === 'day' ? 0.55 + Math.min(0.35, p.alt / 120) : 0.95;
    ctx.fillRect(x1, 0, x2 - x1 + 0.6, h);
  }
  ctx.globalAlpha = 1;
  // Sonnenhöhe als Kurve
  ctx.beginPath();
  day.sunPath.forEach((p, i) => {
    const x = ((p.t - day.start) / 60000 / dayMin) * w;
    const y = h - 3 - (Math.max(-20, p.alt) + 20) / 110 * (h - 6);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.3; ctx.stroke();
  // Mond sichtbar → dünner Streifen unten
  ctx.fillStyle = 'rgba(200,220,255,.65)';
  day.moonPath.forEach((p, i) => {
    if (p.alt <= 0 || i === n - 1) return;
    const x1 = ((p.t - day.start) / 60000 / dayMin) * w, x2 = ((day.moonPath[i + 1].t - day.start) / 60000 / dayMin) * w;
    ctx.fillRect(x1, h - 3, x2 - x1 + 0.5, 3);
  });
  // Fokus: Sichtbarkeitsfenster hervorheben
  const F = getFocus();
  const X = (t) => ((t - day.start) / 60000 / dayMin) * w;
  if (F === 'milky') {
    const n = mwNight(state.lat, state.lng, state.elev, state.tz, state.time);
    const band = (a, b) => { if (!a || !b) return; const x1 = Math.max(0, X(a)), x2 = Math.min(w, X(b)); if (x2 > x1) { ctx.fillStyle = 'rgba(199,146,234,.55)'; ctx.fillRect(x1, h - 7, x2 - x1, 7); } };
    band(n.visStart, n.visEnd);
    if (n.best) { ctx.fillStyle = '#e6c8ff'; ctx.beginPath(); ctx.arc(X(n.best.t), h - 3.5, 3.5, 0, 7); ctx.fill(); }
  }
  if (F === 'moon') {
    ctx.fillStyle = 'rgba(200,220,255,.9)';
    day.moonPath.forEach((p, i) => { if (p.alt <= 0 || i === n - 1) return; ctx.fillRect(X(p.t), h - 7, X(day.moonPath[i + 1].t) - X(p.t) + 0.5, 7); });
  }
  // Gezeiten (falls am Meer): türkise Linie
  const tm = cachedTideModel(state.lat, state.lng);
  if (tm && !tm.inland) {
    const pts = [];
    for (let m = 0; m <= dayMin; m += 10) pts.push([(m / dayMin) * w, tideHeight(tm, new Date(day.start.getTime() + m * 60000))]);
    const lo = Math.min(...pts.map((p) => p[1])), hi = Math.max(...pts.map((p) => p[1]));
    ctx.beginPath();
    pts.forEach(([x, v], i) => { const y = h - 4 - ((v - lo) / (hi - lo || 1)) * (h - 10); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = 'rgba(77,208,225,.95)'; ctx.lineWidth = 1.6; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
  }
  // Stunden-Ticks
  ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = '500 9px -apple-system, Inter, sans-serif'; ctx.textBaseline = 'top';
  for (let hh = 0; hh <= 24; hh += 1) {
    const x = (hh * 60 / dayMin) * w;
    ctx.fillRect(x, 0, 1, hh % 6 === 0 ? 7 : 4);
    if (hh % 3 === 0 && hh < 24 && hh > 0) ctx.fillText(String(hh), x + 2, 2);
  }
}

function drawYear(year) {
  const { ctx, w, h } = prepCanvas($('#year-canvas'));
  const days = yearOverview(state.lat, state.lng, state.tz, year);
  const dw = w / days.length;
  days.forEach((d, i) => {
    const v = Math.round(20 + d.illum * 200);
    ctx.fillStyle = `rgb(${v * 0.85},${v * 0.9},${v})`;
    ctx.fillRect(i * dw, 0, dw + 0.5, h);
  });
  // Vollmond / Neumond markieren
  days.forEach((d, i) => {
    const prev = days[i - 1], next = days[i + 1];
    if (prev && next && d.illum >= prev.illum && d.illum > next.illum && d.illum > 0.97) {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(i * dw + dw / 2, h / 2, 3, 0, Math.PI * 2); ctx.fill();
    }
  });
  ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.font = '600 9px -apple-system, Inter, sans-serif'; ctx.textBaseline = 'top';
  const M = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  for (let m = 0; m < 12; m++) {
    const doy = (Date.UTC(year, m, 1) - Date.UTC(year, 0, 1)) / 864e5;
    const x = doy * dw;
    ctx.fillStyle = 'rgba(10,14,22,.55)'; ctx.fillRect(x, 0, 1, h);
    ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 3;
    ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillText(M[m], x + 3, 2);
    ctx.shadowBlur = 0;
  }
}
