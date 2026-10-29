// ─────────────────────────────────────────────────────────────
// Himmel: 360°-Panorama (Azimut × Höhe) – ersetzt den „3D-Kompass“
// ─────────────────────────────────────────────────────────────
import { state, onState, setState } from './state.js';
import { getDay, sunPos, moonPos, gcPos } from './astro.js';
import { $, fmtTime, fmtDeg, fmtAz, rafThrottle, bearing, phaseOf, PHASES, wrap360, wrap180 } from './utils.js';
import { COLORS, drawMoon, hexAlpha, roundRect } from './map.js';
import { getFocus } from './focus.js';

let cv, ctx, active = false;
let center = 180, span = 360; // Azimut-Mitte, sichtbarer Bereich in Grad
const ALT_MIN = -20, ALT_MAX = 90;

export function initSky() {
  cv = $('#sky-canvas'); ctx = cv.getContext('2d');
  const redraw = rafThrottle(draw);
  new ResizeObserver(redraw).observe($('#view-sky'));
  onState(() => active && redraw());
  let drag = null;
  cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, c: center }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const w = cv.getBoundingClientRect().width;
    center = wrap360(drag.c - ((e.clientX - drag.x) / w) * span); redraw();
  });
  cv.addEventListener('pointerup', () => (drag = null));
  cv.addEventListener('wheel', (e) => { e.preventDefault(); span = Math.max(60, Math.min(360, span * (e.deltaY > 0 ? 1.1 : 0.9))); redraw(); }, { passive: false });
  cv.addEventListener('dblclick', (e) => {
    // Doppelklick: Zeit auf den Moment setzen, an dem die Sonne dieser Richtung am nächsten ist
    const r = cv.getBoundingClientRect();
    const az = wrap360(center + ((e.clientX - r.left) / r.width - 0.5) * span);
    const day = getDay(state.lat, state.lng, state.elev, state.tz, state.time);
    let best = null;
    for (const p of day.sunPath) { if (p.alt < -6) continue; const d = Math.abs(wrap180(p.az - az)); if (!best || d < best.d) best = { d, t: p.t }; }
    if (best) setState({ time: best.t });
  });
  window.__lpSkyRedraw = redraw;
  window.addEventListener('lp-focus', () => active && redraw());
}
export function activateSky() {
  active = true;
  if (state.target) center = bearing(state.lat, state.lng, state.target.lat, state.target.lng);
  else { const d = getDay(state.lat, state.lng, state.elev, state.tz, state.time); const s = sunPos(state.time, d.obs); center = s.alt > -6 ? s.az : (d.sun.setAz ?? 180); }
  window.__lpSkyRedraw?.();
}
export function deactivateSky() { active = false; }

function draw() {
  const box = cv.parentElement.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(box.width * dpr); cv.height = Math.round(box.height * dpr);
  cv.style.width = box.width + 'px'; cv.style.height = box.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const tbH = ($('#timebar')?.offsetHeight || 150) + 24;
  const W = box.width, H = box.height - tbH - 90; // unten Platz für Beschriftung + Zeitleiste
  const day = getDay(state.lat, state.lng, state.elev, state.tz, state.time);
  const obs = day.obs;
  const s = sunPos(state.time, obs);
  const X = (az) => W / 2 + (wrap180(az - center) / span) * W;
  const Y = (alt) => 70 + (1 - (alt - ALT_MIN) / (ALT_MAX - ALT_MIN)) * (H - 70);

  // Himmelsfarbe nach Sonnenhöhe
  const ph = phaseOf(s.alt);
  const sky = ctx.createLinearGradient(0, 0, 0, Y(0));
  const top = { night: '#05070f', astro: '#0a1024', naut: '#121c45', blue: '#1d3577', golden: '#3d4f8f', day: '#3f7fd1' }[ph.key];
  const hor = { night: '#0b1022', astro: '#1a2148', naut: '#33427a', blue: '#4f5fa8', golden: '#f2a35e', day: '#a9d1f5' }[ph.key];
  sky.addColorStop(0, top); sky.addColorStop(1, hor);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, Y(0));
  const ground = ctx.createLinearGradient(0, Y(0), 0, box.height);
  ground.addColorStop(0, '#1b2230'); ground.addColorStop(1, '#0b0f17');
  ctx.fillStyle = ground; ctx.fillRect(0, Y(0), W, box.height - Y(0));

  // Raster
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1;
  ctx.font = '600 11px -apple-system, Inter, sans-serif'; ctx.fillStyle = 'rgba(255,255,255,.55)';
  for (let a = 0; a <= 90; a += 15) { const y = Y(a); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); if (a) ctx.fillText(`${a}°`, 6, y - 4); }
  const step = span > 200 ? 15 : span > 100 ? 10 : 5;
  ctx.textAlign = 'center';
  for (let a = 0; a < 360; a += step) {
    const x = X(a); if (x < -20 || x > W + 20) continue;
    ctx.beginPath(); ctx.moveTo(x, 70); ctx.lineTo(x, Y(0)); ctx.stroke();
    const card = a % 90 === 0 ? ['N', 'O', 'S', 'W'][a / 90] : a % 45 === 0 ? ['NO', 'SO', 'SW', 'NW'][(a - 45) / 90] : null;
    ctx.fillStyle = card ? (a === 0 ? '#ff6b6b' : '#fff') : 'rgba(255,255,255,.55)';
    ctx.fillText(card || `${a}°`, x, Y(0) + 18);
  }
  ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(W, Y(0)); ctx.stroke();
  ctx.restore();

  // Ziel
  if (state.target) {
    const b = bearing(state.lat, state.lng, state.target.lat, state.target.lng), x = X(b);
    ctx.save(); ctx.strokeStyle = COLORS.target; ctx.setLineDash([6, 6]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 70); ctx.lineTo(x, Y(0)); ctx.stroke(); ctx.restore();
    pill(`Ziel ${fmtAz(b)}`, x, Y(0) + 40, COLORS.target);
  }

  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H + 4); ctx.clip();
  const path = (pts, colorFn, width, dash) => {
    ctx.save(); ctx.lineWidth = width; ctx.setLineDash(dash || []); ctx.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const xa = X(a.az), xb = X(b.az);
      if (Math.abs(xa - xb) > W / 2) continue; // Umbruch
      const col = colorFn(b); if (!col) continue;
      ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(xa, Y(a.alt)); ctx.lineTo(xb, Y(b.alt)); ctx.stroke();
    }
    ctx.restore();
  };
  const hours = (pts, color) => {
    ctx.save(); ctx.font = '600 10px -apple-system, Inter, sans-serif'; ctx.textAlign = 'center';
    pts.forEach((p, i) => { if (i % 6 || p.alt < ALT_MIN) return; const x = X(p.az), y = Y(p.alt); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillText(fmtTime(p.t, state.tz).slice(0, 2), x, y - 8); });
    ctx.restore();
  };

  const F = getFocus(), on = (k) => F === 'all' || F === k;
  if (on('milky')) path(day.gcPath, (p) => { const i = Math.round((p.t - day.start) / 600000); const sa = day.sunPath[Math.min(i, day.sunPath.length - 1)].alt; return hexAlpha(COLORS.milky, sa < -12 ? 0.9 : 0.25); }, F === 'milky' ? 4 : 3, [2, 5]);
  if (F === 'milky') hours(day.gcPath, COLORS.milky);
  if (on('moon')) { path(day.moonPath, () => 'rgba(200,225,255,.85)', F === 'moon' ? 3 : 2, [6, 5]); hours(day.moonPath, 'rgba(200,225,255,.9)'); }
  if (on('sun')) { path(day.sunPath, (p) => (p.alt < -6 ? 'rgba(255,224,102,.25)' : p.alt < -4 ? COLORS.blue : p.alt < 6 ? COLORS.golden : COLORS.sun), 3.5); hours(day.sunPath, COLORS.sun); }

  const g = gcPos(state.time, obs), m = moonPos(state.time, obs);
  if (on('milky') && g.alt > ALT_MIN) { dot(X(g.az), Y(g.alt), 6, COLORS.milky); pill('Milchstraße', X(g.az), Y(g.alt) - 18, COLORS.milky); }
  if (on('moon') && m.alt > ALT_MIN) { drawMoon(ctx, X(m.az), Y(m.alt), 10, m.illum, m.waxing); pill(`Mond ${Math.round(m.illum * 100)} %`, X(m.az), Y(m.alt) + 22, COLORS.moon); }
  if (on('sun') && s.alt > ALT_MIN) { dot(X(s.az), Y(s.alt), 11, s.alt < 6 ? COLORS.golden : COLORS.sun); pill(`Sonne ${fmtDeg(s.alt, 1)} · ${fmtAz(s.az)}`, X(s.az), Y(s.alt) - 24, COLORS.sun); }

  ctx.restore();
  [[day.sun.riseAz, `↑ ${fmtTime(day.sun.rise, state.tz)}`, COLORS.sunrise, 'sun'], [day.sun.setAz, `↓ ${fmtTime(day.sun.set, state.tz)}`, COLORS.sunset, 'sun'],
   [day.moon.riseAz, `☾↑ ${fmtTime(day.moon.rise, state.tz)}`, COLORS.moonrise, 'moon'], [day.moon.setAz, `☾↓ ${fmtTime(day.moon.set, state.tz)}`, COLORS.moonset, 'moon']]
    .forEach(([az, t, c, k], i) => { if (az == null || !on(k)) return; const x = X(az); ctx.fillStyle = c; ctx.fillRect(x - 1, Y(0) - 10, 2, 20); pill(t, x, Y(0) + (i < 2 ? 60 : 82), c); });

  function dot(x, y, r, c) {
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r * 2.8);
    gr.addColorStop(0, '#fff'); gr.addColorStop(0.35, c); gr.addColorStop(1, hexAlpha(c, 0));
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r * 2.8, 0, 7); ctx.fill();
  }
  function pill(t, x, y, c) {
    ctx.save(); ctx.font = '600 11px -apple-system, Inter, sans-serif';
    const w = ctx.measureText(t).width + 14;
    ctx.fillStyle = 'rgba(10,14,22,.75)'; roundRect(ctx, x - w / 2, y - 10, w, 20, 10); ctx.fill();
    ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, x, y + 0.5); ctx.restore();
  }
}
