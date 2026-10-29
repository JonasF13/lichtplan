// ─────────────────────────────────────────────────────────────
// Live-Ansicht: Kamera + Bewegungssensor (wie Sun Surveyor „Live View“)
//  · Bahnen: Sonne, Mond, Milchstraßen-Kern (folgt dem Fokus)
//  · Sterne: Sterne, Sternbilder, Planeten, Milchstraße (über starsky.js)
//  · echte Nordrichtung: Kompass + Missweisung (WMM-2025)
//  · Kalibrieren an Sonne/Mond: Fadenkreuz drauf, tippen → exakt
// ─────────────────────────────────────────────────────────────
import { state, onState } from './state.js';
import { prefs } from './store.js';
import { getDay, sunPos, moonPos, gcPos } from './astro.js';
import { layerOn, getFocus } from './focus.js';
import { $, icon, esc, rad, deg, fmtTime, fmtDeg, compass, wrap360, wrap180 } from './utils.js';
import { COLORS, drawMoon, hexAlpha, roundRect } from './map.js';
import { declination } from '../vendor/geomagnetism.esm.js';

let active = false, running = false, stream = null, raf = 0;
let video, canvas, ctx, ui;
let raw = null;          // letzte Sensorwerte
let cam = null;          // geglättete Kamera-Vektoren (ENU)
let starsMod = null;     // dynamisch geladen
let lastErr = '';
const cal = () => ({ fov: 1, yaw: 0, pitch: 0, ...(prefs.get('arCal') || {}) });
const mode = () => prefs.get('arMode') || 'paths';

export const arSupported = () => typeof window.DeviceOrientationEvent !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && matchMedia('(pointer: coarse)').matches;

export function initAR() {
  video = $('#ar-video'); canvas = $('#ar-canvas'); ctx = canvas.getContext('2d'); ui = $('#ar-ui');
  onState(() => { if (active && running) {/* Neuzeichnen passiert im Loop */} });
}

export function activateAR() {
  active = true;
  renderUI();
  if (running) loop();
}
export function deactivateAR() {
  active = false;
  cancelAnimationFrame(raf);
  stopCamera(); // Akku schonen
}

// ── Start / Stopp ───────────────────────────────────────────
async function start() {
  lastErr = '';
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') throw new Error('Zugriff auf den Bewegungssensor wurde nicht erlaubt (Einstellungen › Safari › Bewegungs- & Ausrichtungszugriff).');
    }
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    video.srcObject = stream;
    await video.play().catch(() => {});
    window.addEventListener('deviceorientationabsolute', onOri, true);
    window.addEventListener('deviceorientation', onOri, true);
    running = true;
    renderUI();
    loop();
  } catch (e) {
    lastErr = e?.name === 'NotAllowedError' ? 'Kamerazugriff wurde nicht erlaubt. Erlaube ihn in den Einstellungen und versuche es erneut.' : (e?.message || String(e));
    stopCamera();
    renderUI();
  }
}
function stopCamera() {
  running = false;
  window.removeEventListener('deviceorientationabsolute', onOri, true);
  window.removeEventListener('deviceorientation', onOri, true);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) video.srcObject = null;
}

// ── Sensoren ────────────────────────────────────────────────
function onOri(e) {
  if (e.alpha == null && e.webkitCompassHeading == null) return;
  // iOS: webkitCompassHeading (magnetisch) → absolute Gierrichtung; Android: deviceorientationabsolute
  let alpha = e.alpha ?? 0;
  let absolute = e.absolute === true || e.type === 'deviceorientationabsolute';
  if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) { alpha = 360 - e.webkitCompassHeading; absolute = true; }
  if (e.type === 'deviceorientation' && raw?.fromAbsoluteEvent && !('webkitCompassHeading' in e)) return; // Android: absolutes Ereignis bevorzugen
  raw = { alpha, beta: e.beta ?? 0, gamma: e.gamma ?? 0, absolute, acc: e.webkitCompassAccuracy, fromAbsoluteEvent: e.type === 'deviceorientationabsolute' || raw?.fromAbsoluteEvent };
}

const mul = (R, v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const rotZ = (v, a) => { const c = Math.cos(a), s = Math.sin(a); return [c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]]; }; // im Uhrzeigersinn (Azimut +)
function rotAxis(v, k, a) { // Rodrigues
  const c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), kd = dot(k, v);
  return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
}

/** W3C-Rotationsmatrix (Gerät → Erde, ENU: x=Ost, y=Nord, z=oben) */
function rotation(alpha, beta, gamma) {
  const a = rad(alpha), b = rad(beta), g = rad(gamma);
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  return [
    [cA * cG - sA * sB * sG, -cB * sA, cA * sG + cG * sA * sB],
    [cG * sA + cA * sB * sG, cA * cB, sA * sG - cA * cG * sB],
    [-cB * sG, sB, cB * cG],
  ];
}
function cameraFromSensors() {
  if (!raw) return null;
  const decl = raw.absolute ? declination(state.lat, state.lng, state.time) : 0;
  const R = rotation(raw.alpha - decl, raw.beta, raw.gamma);
  const sa = rad(screen.orientation?.angle ?? window.orientation ?? 0);
  let fwd = mul(R, [0, 0, -1]);
  let up = mul(R, [Math.sin(sa), Math.cos(sa), 0]);
  // Kalibrierung: Gier (um Senkrechte) + Neigung (um Bild-Rechts)
  const c = cal();
  if (c.yaw) { fwd = rotZ(fwd, rad(c.yaw)); up = rotZ(up, rad(c.yaw)); }
  if (c.pitch) { const r = norm(cross(fwd, up)); fwd = rotAxis(fwd, r, rad(c.pitch)); up = rotAxis(up, r, rad(c.pitch)); }
  return { fwd: norm(fwd), up: norm(up) };
}
function smoothCam() {
  const t = cameraFromSensors(); if (!t) return cam;
  if (!cam) cam = { fwd: t.fwd, up: t.up };
  else {
    const k = 0.22; // Glättung
    cam.fwd = norm([cam.fwd[0] + (t.fwd[0] - cam.fwd[0]) * k, cam.fwd[1] + (t.fwd[1] - cam.fwd[1]) * k, cam.fwd[2] + (t.fwd[2] - cam.fwd[2]) * k]);
    cam.up = norm([cam.up[0] + (t.up[0] - cam.up[0]) * k, cam.up[1] + (t.up[1] - cam.up[1]) * k, cam.up[2] + (t.up[2] - cam.up[2]) * k]);
  }
  cam.right = norm(cross(cam.fwd, cam.up));
  cam.up = norm(cross(cam.right, cam.fwd));
  return cam;
}
const azAlt = (v) => ({ az: wrap360(deg(Math.atan2(v[0], v[1]))), alt: deg(Math.asin(Math.max(-1, Math.min(1, v[2])))) });
const vec = (az, alt) => { const A = rad(az), E = rad(alt); return [Math.cos(E) * Math.sin(A), Math.cos(E) * Math.cos(A), Math.sin(E)]; };

// ── Zeichnen ────────────────────────────────────────────────
function focalPx(W, H) {
  // Bildwinkel der Hauptkamera entlang der langen Bildseite (≈ 66° bei 16:9-Video) – kalibrierbar
  const vw = video.videoWidth || 1920, vh = video.videoHeight || 1080;
  const fv = (Math.max(vw, vh) / 2) / Math.tan(rad(66 / 2));
  const s = Math.max(W / vw, H / vh); // object-fit: cover
  return fv * s / (cal().fov || 1);
}
function loop() {
  cancelAnimationFrame(raf);
  if (!active || !running) return;
  draw();
  raf = requestAnimationFrame(loop);
}
function draw() {
  const box = canvas.parentElement.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = box.width, H = box.height;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.width = W + 'px'; canvas.style.height = H + 'px'; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const c = smoothCam();
  if (!c) { hud(W, H, 'Warte auf Bewegungssensor … Handy kurz bewegen.'); return; }
  const f = focalPx(W, H);
  const project = (az, alt) => {
    const d = vec(az, alt), z = dot(d, c.fwd);
    if (z <= 0.05) return null;
    return [W / 2 + (f * dot(d, c.right)) / z, H / 2 - (f * dot(d, c.up)) / z];
  };
  const day = getDay(state.lat, state.lng, state.elev, state.tz, state.time);
  const obs = day.obs;

  if (mode() === 'stars' && starsMod) {
    const s = sunPos(state.time, obs);
    starsMod.drawSky(ctx, { width: W, height: H, project, pxPerDeg: f * Math.PI / 180, date: state.time, lat: state.lat, lng: state.lng, elev: state.elev,
      layers: { stars: true, constellations: true, names: true, planets: true, milkyway: true, moon: true, sun: true }, magLimit: 5, twinkle: true, sunAlt: s.alt, labelScale: 1.1 });
  }
  // Horizont & Kompass
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 6]);
  polyline(project, Array.from({ length: 361 }, (_, i) => [i, 0]));
  ctx.setLineDash([]);
  for (let a = 0; a < 360; a += 10) {
    const p = project(a, 0); if (!p) continue;
    const major = a % 30 === 0;
    ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.beginPath(); ctx.moveTo(p[0], p[1] - (major ? 9 : 4)); ctx.lineTo(p[0], p[1] + (major ? 9 : 4)); ctx.stroke();
    if (major) pill(a % 90 === 0 ? ['N', 'O', 'S', 'W'][a / 90] : `${a}°`, p[0], p[1] + 22, a === 0 ? '#ff6b6b' : '#fff');
  }
  ctx.restore();

  if (mode() !== 'stars') {
    if (layerOn('milky')) {
      ctx.save(); ctx.lineWidth = 3; ctx.setLineDash([2, 6]);
      seg(project, day.gcPath, (p) => (p.alt > -2 ? hexAlpha(COLORS.milky, sunAlt(day, p.t) < -12 ? 0.95 : 0.35) : null));
      ctx.restore(); hours(project, day.gcPath, COLORS.milky);
    }
    if (layerOn('moon')) {
      ctx.save(); ctx.lineWidth = 2.5; ctx.setLineDash([7, 5]);
      seg(project, day.moonPath, (p) => (p.alt > -3 ? 'rgba(200,225,255,.95)' : null));
      ctx.restore(); hours(project, day.moonPath, 'rgba(210,230,255,1)');
    }
    if (layerOn('sun')) {
      ctx.save(); ctx.lineWidth = 4; ctx.lineCap = 'round';
      seg(project, day.sunPath, (p) => (p.alt < -6 ? null : p.alt < -4 ? COLORS.blue : p.alt < 6 ? COLORS.golden : COLORS.sun));
      ctx.restore(); hours(project, day.sunPath, '#fff3c4');
      if (day.sun.rise) marker(project, day.sun.riseAz, `↑ ${fmtTime(day.sun.rise, state.tz)}`, COLORS.sunrise);
      if (day.sun.set) marker(project, day.sun.setAz, `↓ ${fmtTime(day.sun.set, state.tz)}`, COLORS.sunset);
    }
  }
  // aktuelle Positionen + Randpfeil zum Fokus-Objekt
  const F = getFocus();
  const s = sunPos(state.time, obs), m = moonPos(state.time, obs), g = gcPos(state.time, obs);
  const bodies = [];
  if (layerOn('sun') || mode() === 'stars') bodies.push({ k: 'sun', p: s, color: s.alt < 6 ? COLORS.golden : COLORS.sun, label: `Sonne ${fmtDeg(s.alt, 1)}` });
  if (layerOn('moon') || mode() === 'stars') bodies.push({ k: 'moon', p: m, color: COLORS.moon, label: `Mond ${Math.round(m.illum * 100)} %` });
  if (layerOn('milky')) bodies.push({ k: 'milky', p: g, color: COLORS.milky, label: 'Milchstraßen-Kern' });
  for (const b of bodies) {
    if (b.p.alt < -8) continue;
    const pp = project(b.p.az, b.p.alt);
    if (pp && pp[0] > -40 && pp[0] < W + 40 && pp[1] > -40 && pp[1] < H + 40) {
      if (b.k === 'moon') drawMoon(ctx, pp[0], pp[1], Math.max(12, f * Math.tan(rad(0.26))), m.illum, m.waxing);
      else glow(pp[0], pp[1], Math.max(12, f * Math.tan(rad(0.27))), b.color);
      pill(b.label, pp[0], pp[1] - 30, b.color);
    }
  }
  const tgt = bodies.find((b) => b.k === F) || (F === 'all' ? bodies.find((b) => b.p.alt > -6) : null);
  if (tgt) edgeArrow(W, H, c, tgt);
  // Fadenkreuz + Anzeige
  const look = azAlt(c.fwd);
  ctx.save(); ctx.strokeStyle = 'rgba(46,229,157,.95)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(W / 2, H / 2, 16, 0, 7); ctx.moveTo(W / 2 - 26, H / 2); ctx.lineTo(W / 2 - 8, H / 2); ctx.moveTo(W / 2 + 8, H / 2); ctx.lineTo(W / 2 + 26, H / 2); ctx.moveTo(W / 2, H / 2 - 26); ctx.lineTo(W / 2, H / 2 - 8); ctx.moveTo(W / 2, H / 2 + 8); ctx.lineTo(W / 2, H / 2 + 26); ctx.stroke(); ctx.restore();
  $('#ar-readout') && ($('#ar-readout').innerHTML = `<b>${Math.round(look.az)}° ${compass(look.az)}</b><span>Höhe ${fmtDeg(look.alt, 1)}</span>${raw?.acc != null && raw.acc > 15 ? `<em>Kompass ungenau (±${Math.round(raw.acc)}°) – Handy in einer 8 bewegen oder an Sonne/Mond kalibrieren</em>` : ''}`);
  window.__lpArLook = look;

  function hud(w, h, t) { pill(t, w / 2, h / 2, '#fff'); }
}
function sunAlt(day, t) { const i = Math.round((t - day.start) / 600000); return day.sunPath[Math.max(0, Math.min(day.sunPath.length - 1, i))].alt; }
function polyline(project, pts) {
  let on = false; ctx.beginPath();
  for (const [az, alt] of pts) { const p = project(az, alt); if (!p) { on = false; continue; } on ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); on = true; }
  ctx.stroke();
}
function seg(project, pts, colorFn) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], col = colorFn(b); if (!col) continue;
    const da = ((b.az - a.az + 540) % 360) - 180;
    ctx.strokeStyle = col; ctx.beginPath(); let on = false;
    for (let k = 0; k <= 4; k++) { const p = project(a.az + (da * k) / 4, a.alt + ((b.alt - a.alt) * k) / 4); if (!p) { on = false; continue; } on ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); on = true; }
    ctx.stroke();
  }
}
function hours(project, pts, color) {
  ctx.save(); ctx.font = '600 12px -apple-system, Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  pts.forEach((p, i) => {
    if (i % 6 || p.alt < -4) return;
    const pp = project(p.az, p.alt); if (!pp) return;
    ctx.fillStyle = 'rgba(10,14,22,.8)'; ctx.beginPath(); ctx.arc(pp[0], pp[1], 5, 0, 7); ctx.fill();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(pp[0], pp[1], 3.4, 0, 7); ctx.fill();
    ctx.shadowColor = 'rgba(0,0,0,.95)'; ctx.shadowBlur = 5; ctx.fillText(fmtTime(p.t, state.tz).slice(0, 2) + ' h', pp[0], pp[1] - 14); ctx.shadowBlur = 0;
  });
  ctx.restore();
}
function marker(project, az, text, color) {
  const p = project(az, 0); if (!p) return;
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(p[0], p[1] - 16); ctx.lineTo(p[0], p[1] + 16); ctx.stroke(); ctx.restore();
  pill(text, p[0], p[1] + 40, color);
}
function glow(x, y, r, color) {
  ctx.save(); const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
  g.addColorStop(0, '#fff'); g.addColorStop(0.3, color); g.addColorStop(1, hexAlpha(color, 0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 3, 0, 7); ctx.fill(); ctx.restore();
}
function pill(text, x, y, color) {
  ctx.save(); ctx.font = '600 12.5px -apple-system, "SF Pro Text", Inter, sans-serif';
  const w = ctx.measureText(text).width + 16, h = 22;
  ctx.fillStyle = 'rgba(10,14,22,.72)'; roundRect(ctx, x - w / 2, y - h / 2, w, h, 11); ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 0.5); ctx.restore();
}
/** Pfeil am Bildrand, wenn das Objekt außerhalb des Bildes liegt */
function edgeArrow(W, H, c, b) {
  const d = vec(b.p.az, b.p.alt);
  const x = dot(d, c.right), y = dot(d, c.up), z = dot(d, c.fwd);
  const f = focalPx(W, H);
  const sx = W / 2 + (z > 0.05 ? (f * x) / z : x * 1e4), sy = H / 2 - (z > 0.05 ? (f * y) / z : y * 1e4);
  if (z > 0.05 && sx > 30 && sx < W - 30 && sy > 30 && sy < H - 30) return;
  const ang = Math.atan2(sy - H / 2, sx - W / 2);
  const r = Math.min(W, H) / 2 - 48;
  const px = W / 2 + Math.cos(ang) * r, py = H / 2 + Math.sin(ang) * r;
  ctx.save(); ctx.translate(px, py); ctx.rotate(ang);
  ctx.fillStyle = b.color; ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(-10, -12); ctx.lineTo(-4, 0); ctx.lineTo(-10, 12); ctx.closePath(); ctx.fill();
  ctx.restore();
  const look = azAlt(c.fwd);
  const daz = Math.round(wrap180(b.p.az - look.az)), dalt = Math.round(b.p.alt - look.alt);
  pill(`${b.label.split(' ')[0]}: ${Math.abs(daz)}° ${daz >= 0 ? 'rechts' : 'links'}${Math.abs(dalt) > 3 ? `, ${Math.abs(dalt)}° ${dalt > 0 ? 'höher' : 'tiefer'}` : ''}`, px - Math.cos(ang) * 46, py - Math.sin(ang) * 30, b.color);
}

// ── Bedienoberfläche ────────────────────────────────────────
function renderUI() {
  if (!ui) return;
  if (!arSupported()) {
    ui.innerHTML = `<div class="ar-card glass"><div class="empty-icon">${icon('camera')}</div><h2>Live-Ansicht</h2><p>Die Live-Ansicht nutzt Kamera und Bewegungssensor deines iPhones oder iPads. Öffne Specula dort, um Sonne, Mond, Milchstraße und Sterne direkt im Kamerabild zu sehen.</p></div>`;
    return;
  }
  if (!running) {
    ui.innerHTML = `<div class="ar-card glass"><div class="empty-icon">${icon('camera')}</div><h2>Live-Ansicht</h2>
      <p>Halte dein Handy in den Himmel: Specula blendet ${mode() === 'stars' ? 'Sterne, Sternbilder und Planeten' : 'Sonnen-, Mond- und Milchstraßenbahn'} ins Kamerabild ein – passend zur gewählten Zeit.</p>
      ${lastErr ? `<p class="warn">${esc(lastErr)}</p>` : ''}
      <button class="btn primary" id="ar-start">${icon('camera')}Kamera &amp; Sensor starten</button>
      <p class="muted small">Specula fragt einmal nach Kamera- und Bewegungszugriff. Bilder werden nicht gespeichert oder gesendet.</p></div>`;
    $('#ar-start').onclick = start;
    return;
  }
  ui.innerHTML = `
    <div class="ar-top">
      <div class="segmented ar-mode"><button data-m="paths" class="${mode() === 'paths' ? 'active' : ''}">${icon('sun')}Bahnen</button><button data-m="stars" class="${mode() === 'stars' ? 'active' : ''}">${icon('stars')}Sterne</button></div>
      <button class="tool glass" id="ar-cal" title="Kalibrieren">${icon('sliders')}</button>
    </div>
    <div id="ar-readout" class="ar-readout glass"></div>`;
  ui.querySelectorAll('.ar-mode button').forEach((b) => b.onclick = async () => { prefs.set('arMode', b.dataset.m); if (b.dataset.m === 'stars') await loadStars(); renderUI(); });
  $('#ar-cal').onclick = calDialog;
  if (mode() === 'stars') loadStars();
}
async function loadStars() {
  if (starsMod) return starsMod;
  try { starsMod = await import('./starsky.js'); await starsMod.loadSky(); } catch { starsMod = null; }
  return starsMod;
}

function calDialog() {
  const old = document.querySelector('.ar-calbox'); if (old) { old.remove(); return; }
  const c = cal();
  const box = document.createElement('div');
  box.className = 'ar-calbox glass';
  box.innerHTML = `
    <h4>Kalibrieren</h4>
    <p class="muted small">Am genauesten: Fadenkreuz exakt auf die echte Sonne oder den Mond richten und tippen.</p>
    <div class="btn-row wrap"><button class="btn sm primary" data-b="sun">${icon('sun')}Auf Sonne ausrichten</button><button class="btn sm primary" data-b="moon">${icon('moon')}Auf Mond ausrichten</button></div>
    <label class="small">Richtung feinjustieren <b id="cal-yaw-v">${c.yaw.toFixed(1)}°</b></label>
    <input type="range" min="-20" max="20" step="0.5" value="${c.yaw}" id="cal-yaw">
    <label class="small">Bildwinkel <b id="cal-fov-v">${Math.round(c.fov * 100)} %</b></label>
    <input type="range" min="0.6" max="1.6" step="0.01" value="${c.fov}" id="cal-fov">
    <div class="btn-row"><button class="btn sm ghost" id="cal-reset">Zurücksetzen</button><button class="btn sm" id="cal-ok">Fertig</button></div>`;
  ui.appendChild(box);
  const save = (patch) => prefs.set('arCal', { ...cal(), ...patch });
  box.querySelector('#cal-yaw').oninput = (e) => { save({ yaw: +e.target.value }); box.querySelector('#cal-yaw-v').textContent = `${(+e.target.value).toFixed(1)}°`; };
  box.querySelector('#cal-fov').oninput = (e) => { save({ fov: +e.target.value }); box.querySelector('#cal-fov-v').textContent = `${Math.round(e.target.value * 100)} %`; };
  box.querySelector('#cal-reset').onclick = () => { prefs.set('arCal', { fov: 1, yaw: 0, pitch: 0 }); box.remove(); };
  box.querySelector('#cal-ok').onclick = () => box.remove();
  box.querySelectorAll('[data-b]').forEach((b) => b.onclick = () => {
    const obs = getDay(state.lat, state.lng, state.elev, state.tz, new Date()).obs;
    const p = b.dataset.b === 'sun' ? sunPos(new Date(), obs) : moonPos(new Date(), obs);
    if (p.alt < -1) return alert(`${b.dataset.b === 'sun' ? 'Die Sonne' : 'Der Mond'} steht gerade unter dem Horizont.`);
    // aktuelle Abweichung zwischen Fadenkreuz und echtem Objekt übernehmen (zur JETZT-Zeit)
    const look = window.__lpArLook; if (!look) return;
    const cc = cal();
    save({ yaw: Math.round((cc.yaw + wrap180(p.az - look.az)) * 10) / 10, pitch: Math.round((cc.pitch + (p.alt - look.alt)) * 10) / 10 });
    box.remove();
  });
}
