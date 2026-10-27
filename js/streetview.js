// ─────────────────────────────────────────────────────────────
// Street View mit eingeblendeten Sonnen-, Mond- & Milchstraßenbahnen
// ─────────────────────────────────────────────────────────────
import { state, setState, onState } from './state.js';
import { prefs, store } from './store.js';
import { syncConfig, syncNow, syncStatus } from './sync.js';
import { getDay, sunPos, moonPos, gcPos, observer } from './astro.js';
import { $, $$, rad, deg, icon, fmtTime, fmtAz, fmtDeg, fmtDist, distance, bearing, rafThrottle, phaseOf, compass, esc } from './utils.js';
import { COLORS, drawMoon, hexAlpha, roundRect } from './map.js';

let pano, svService, canvas, ctx, active = false, loading = null;
let panoPos = null; // {lat,lng}
let lastLoc = '';

export function initStreetView({ openSettings, toast }) {
  canvas = $('#sv-overlay'); ctx = canvas.getContext('2d');
  const redraw = rafThrottle(draw);
  new ResizeObserver(redraw).observe($('#view-sv'));
  onState((ch) => {
    if (!active) return;
    if (ch.has('lat') || ch.has('lng')) locate();
    redraw();
  });
  const sl = prefs.get('svLayers');
  $$('#sv-tools [data-svlayer]').forEach((b) => {
    b.classList.toggle('on', !!sl[b.dataset.svlayer]);
    b.onclick = () => { const l = { ...prefs.get('svLayers') }; l[b.dataset.svlayer] = !l[b.dataset.svlayer]; prefs.set('svLayers', l); b.classList.toggle('on', l[b.dataset.svlayer]); redraw(); };
  });
  $('#sv-look-sun').onclick = () => {
    if (!pano) return;
    const obs = observer(state.lat, state.lng, state.elev);
    let s = sunPos(state.time, obs);
    if (s.alt < -8) { const m = moonPos(state.time, obs); if (m.alt > -2) s = m; else { const d = getDay(state.lat, state.lng, state.elev, state.tz, state.time); s = { az: d.sun.setAz ?? 270, alt: 2 }; } }
    pano.setPov({ heading: s.az, pitch: Math.max(-10, Math.min(60, s.alt)) });
  };
  $('#sv-use-pos').onclick = () => { if (panoPos) setState({ lat: panoPos.lat, lng: panoPos.lng, placeName: '', activeSpotId: null }); };
  $('#sv-calib').onclick = () => calibDialog(redraw);
  window.__lpSvRedraw = redraw;
  // Key kommt nachträglich an (Synchronisierung / anderes Fenster) → Street View starten
  store.subscribe((why) => {
    if ((why === 'sync' || why === 'settings') && active && !pano && prefs.get('gmapsKey')) activateStreetView();
  });
  window.__lpOpenSettings = openSettings;
  window.__lpToast = toast;
}

let waitedForSync = false;
export async function activateStreetView() {
  active = true;
  let key = prefs.get('gmapsKey');
  const empty = $('#sv-empty');
  // Key kommt evtl. gerade über die Synchronisierung – kurz darauf warten
  if (!key && syncConfig() && !waitedForSync) {
    waitedForSync = true;
    empty.innerHTML = '<div class="empty-card glass"><div class="empty-icon"><i class="spin"></i></div><h2>Street View wird vorbereitet …</h2><p>Lade deinen Google-Key aus der Synchronisierung.</p></div>';
    empty.classList.remove('hidden');
    await syncNow();
    key = prefs.get('gmapsKey');
    if (!active) return;
  }
  if (!key) { showEmpty(); return; }
  empty.classList.add('hidden');
  try {
    await loadGoogle(key);
    if (!pano) createPano();
    await locate(true);
  } catch (e) {
    showEmpty(e.message);
  }
}
export function deactivateStreetView() { active = false; }
export function resetGoogle() { pano = null; loading = null; lastLoc = ''; $('#sv-pano').innerHTML = ''; }

function showEmpty(err) {
  const empty = $('#sv-empty');
  const heading = (() => { const d = getDay(state.lat, state.lng, state.elev, state.tz, state.time); const s = sunPos(state.time, d.obs); return s.alt > -6 ? s.az : (d.sun.setAz ?? 0); })();
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${state.lat},${state.lng}&heading=${Math.round(heading)}&pitch=5&fov=90`;
  empty.innerHTML = `
    <div class="empty-card glass">
      <div class="empty-icon">${icon('streetview')}</div>
      <h2>Street View mit Sonnenbahn</h2>
      ${err ? `<p class="warn">${esc(err)}</p>` : '<p>Für die eingeblendeten Sonnen- und Mondbahnen braucht Lichtplan einen eigenen Google-Maps-API-Key. Du hinterlegst ihn einmal in den Einstellungen; er bleibt nur auf diesem Gerät gespeichert.</p>'}
      <div class="btn-row center">
        <button class="btn primary" id="sv-open-settings">${icon('settings')}API-Key eintragen</button>
        <a class="btn ghost" href="${url}" target="_blank" rel="noopener">${icon('ext')}In Google Maps öffnen (${Math.round(heading)}° ${compass(heading)})</a>
      </div>
    </div>`;
  empty.classList.remove('hidden');
  $('#sv-info').classList.add('hidden'); $('#sv-tools').classList.add('hidden');
  $('#sv-open-settings').onclick = () => window.__lpOpenSettings?.('gmaps');
}

// ── Google-Fehler verständlich machen ───────────────────────
// Google meldet Key-Probleme nur in der Konsole (z. B. „RefererNotAllowedMapError“).
let gErr = null, loadedKey = null, authFailedFor = null;
const gErrListeners = new Set();
function hookConsole() {
  if (hookConsole.done) return;
  hookConsole.done = true;
  for (const k of ['error', 'warn']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => {
      const m = a.map((x) => String(x)).join(' ').match(/Google Maps JavaScript API (?:error|warning): (\w+)/);
      if (m && (/MapError$/.test(m[1]) || m[1] === 'InvalidKey')) { gErr = m[1]; gErrListeners.forEach((f) => f(gErr)); }
      orig(...a);
    };
  }
}
export function explainGoogleError(code) {
  const origin = `${location.origin}/*`;
  return ({
    InvalidKeyMapError: 'Der Key ist ungültig. Bitte vollständig kopieren – er beginnt mit „AIza“.',
    InvalidKey: 'Der Key ist ungültig. Bitte vollständig kopieren – er beginnt mit „AIza“.',
    RefererNotAllowedMapError: `Die Website-Beschränkung des Keys erlaubt diese Adresse nicht. In der Google Cloud Console beim Key unter „Website-Einschränkungen“ eintragen: ${origin}`,
    ApiNotActivatedMapError: 'Die „Maps JavaScript API“ ist in deinem Google-Cloud-Projekt noch nicht aktiviert.',
    BillingNotEnabledMapError: 'Im Google-Cloud-Projekt ist noch kein Rechnungskonto verknüpft – Google verlangt das auch für die Gratis-Nutzung.',
    ApiTargetBlockedMapError: 'Die API-Beschränkung des Keys erlaubt die „Maps JavaScript API“ nicht.',
    ExpiredKeyMapError: 'Der Key ist abgelaufen oder wurde gelöscht.',
    DeletedApiProjectMapError: 'Das Google-Cloud-Projekt dieses Keys wurde gelöscht.',
    OverQuotaMapError: 'Das Kontingent ist aufgebraucht (z. B. dein Tageslimit) – morgen geht es wieder.',
    MissingKeyMapError: 'Es wurde kein Key übergeben.',
  })[code] || `Google hat den Key abgelehnt${code ? ` (${code})` : ''}. Prüfe Key, aktivierte „Maps JavaScript API“, Rechnungskonto und Website-Beschränkung (${origin}).`;
}

/** Wartet auf eine Google-Auth-Fehlermeldung (Code) oder null nach `ms` */
function waitAuthFailure(ms) {
  return new Promise((res) => {
    const f = (c) => { gErrListeners.delete(f); setTimeout(() => res(gErr || c), 200); };
    gErrListeners.add(f);
    setTimeout(() => { gErrListeners.delete(f); res(null); }, ms);
  });
}

/**
 * Key prüfen: { ok, code, message, reload }
 * Google validiert den Key erst, wenn ein Panorama/eine Karte erzeugt wird –
 * daher wird ein unsichtbares Test-Panorama angelegt (1 Aufruf im Gratis-Kontingent).
 */
export async function testGoogleKey(key) {
  if (!key) return { ok: false, message: 'Bitte zuerst einen Key einfügen.' };
  if (window.google?.maps && loadedKey && loadedKey !== key) return { ok: false, reload: true, message: 'Zum Prüfen eines neuen Keys muss die App einmal neu laden – „Speichern“ macht das automatisch, danach nochmal „Prüfen“.' };
  if (authFailedFor === key) return { ok: false, code: gErr, message: explainGoogleError(gErr) };
  try {
    await loadGoogle(key);
    const failed = waitAuthFailure(5000);
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:200px;';
    document.body.appendChild(div);
    new google.maps.StreetViewPanorama(div, { position: { lat: state.lat, lng: state.lng }, visible: true });
    const code = await failed;
    setTimeout(() => div.remove(), 300);
    if (code) return { ok: false, code, message: explainGoogleError(code === 'AuthFailure' ? null : code) };
    return { ok: true, message: 'Key funktioniert – Street View mit Sonnenbahn ist bereit.' };
  } catch (e) {
    return { ok: false, code: gErr, message: gErr ? explainGoogleError(gErr) : e.message };
  }
}

function loadGoogle(key) {
  if (window.google?.maps?.StreetViewPanorama) return Promise.resolve();
  if (loading) return loading;
  hookConsole();
  loadedKey = key;
  loading = new Promise((resolve, reject) => {
    window.__lpGmReady = async () => {
      try { await google.maps.importLibrary('streetView'); resolve(); } catch (e) { reject(e); }
    };
    window.gm_authFailure = () => {
      authFailedFor = key;
      gErrListeners.forEach((f) => f('AuthFailure'));
      setTimeout(() => { if (active) showEmpty(explainGoogleError(gErr)); }, 200);
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&language=de&callback=__lpGmReady`;
    s.async = true;
    s.onerror = () => { loading = null; reject(new Error('Google Maps konnte nicht geladen werden (offline?).')); };
    document.head.appendChild(s);
  });
  return loading;
}

function createPano() {
  pano = new google.maps.StreetViewPanorama($('#sv-pano'), {
    addressControl: false, fullscreenControl: false, motionTracking: false, motionTrackingControl: false,
    showRoadLabels: false, zoomControl: true, panControl: false, linksControl: true, enableCloseButton: false,
    clickToGo: true, scrollwheel: true, visible: true,
  });
  svService = new google.maps.StreetViewService();
  const redraw = window.__lpSvRedraw;
  pano.addListener('pov_changed', redraw);
  pano.addListener('zoom_changed', redraw);
  pano.addListener('position_changed', () => {
    const p = pano.getPosition(); if (!p) return;
    panoPos = { lat: p.lat(), lng: p.lng() };
    updateInfo(); redraw();
  });
  $('#sv-tools').classList.remove('hidden');
}

async function locate(force) {
  const key = `${state.lat.toFixed(5)},${state.lng.toFixed(5)}`;
  if (!force && key === lastLoc) return;
  if (!pano) return;
  lastLoc = key;
  const info = $('#sv-info');
  info.classList.remove('hidden'); info.innerHTML = '<span class="muted">Suche Panorama …</span>';
  for (const radius of [50, 250, 1000, 5000]) {
    try {
      const { data } = await svService.getPanorama({ location: { lat: state.lat, lng: state.lng }, radius, preference: google.maps.StreetViewPreference.NEAREST, sources: [google.maps.StreetViewSource.DEFAULT] });
      if (data?.location) {
        pano.setPano(data.location.pano);
        const ll = data.location.latLng;
        panoPos = { lat: ll.lat(), lng: ll.lng(), date: data.imageDate, desc: data.location.description };
        // Blickrichtung: Ziel > Sonne > Sonnenuntergang
        let heading;
        if (state.target) heading = bearing(panoPos.lat, panoPos.lng, state.target.lat, state.target.lng);
        else {
          const obs = observer(state.lat, state.lng, state.elev);
          const s = sunPos(state.time, obs);
          const d = getDay(state.lat, state.lng, state.elev, state.tz, state.time);
          heading = s.alt > -4 ? s.az : (d.sun.setAz ?? 0);
        }
        pano.setPov({ heading, pitch: 4 });
        pano.setZoom(0.6);
        pano.setVisible(true);
        $('#sv-empty').classList.add('hidden');
        updateInfo();
        return;
      }
    } catch { /* nächster Radius */ }
  }
  info.innerHTML = '<span class="warn">Kein Street-View-Panorama in 5 km Umkreis.</span>';
  panoPos = null;
}

function updateInfo() {
  if (!panoPos) return;
  const d = distance(state.lat, state.lng, panoPos.lat, panoPos.lng);
  $('#sv-info').innerHTML = `
    <div class="sv-info-main">${icon('streetview')}<div><b>${esc(panoPos.desc || 'Panorama')}</b><span>${d < 15 ? 'am Standort' : `${fmtDist(d)} vom Standort`}${panoPos.date ? ` · Aufnahme ${panoPos.date}` : ''}</span></div></div>`;
}

// ── Projektion ──────────────────────────────────────────────
function camera(w, h) {
  const pov = pano.getPov(), zoom = pano.getZoom() ?? 1;
  const fovH = Math.min(170, (180 / Math.pow(2, zoom)) * (prefs.get('svFov') || 1));
  const f = (w / 2) / Math.tan(rad(fovH / 2));
  const H = rad(pov.heading), Pp = rad(pov.pitch);
  const fwd = [Math.cos(Pp) * Math.sin(H), Math.cos(Pp) * Math.cos(H), Math.sin(Pp)];
  const right = [Math.cos(H), -Math.sin(H), 0];
  const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  return { f, fovH, w, h, fwd, right, up, heading: pov.heading, pitch: pov.pitch };
}
function project(cam, az, alt) {
  const A = rad(az), E = rad(alt);
  const d = [Math.cos(E) * Math.sin(A), Math.cos(E) * Math.cos(A), Math.sin(E)];
  const z = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
  if (z <= 0.02) return null;
  const x = d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2];
  const y = d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2];
  return [cam.w / 2 + (cam.f * x) / z, cam.h / 2 - (cam.f * y) / z];
}

function draw() {
  const box = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(box.width * dpr) || canvas.height !== Math.round(box.height * dpr)) {
    canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
    canvas.style.width = box.width + 'px'; canvas.style.height = box.height + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, box.width, box.height);
  if (!active || !pano || !panoPos) return;
  const cam = camera(box.width, box.height);
  const L_ = prefs.get('svLayers');
  const lat = panoPos.lat, lng = panoPos.lng;
  const day = getDay(lat, lng, state.elev, state.tz, state.time);
  const obs = day.obs;

  // Horizont & Raster
  if (L_.grid) {
    ctx.save();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.setLineDash([6, 6]);
    polyline(cam, Array.from({ length: 361 }, (_, i) => [i, 0]));
    ctx.setLineDash([]);
    ctx.font = '600 11px -apple-system, Inter, sans-serif'; ctx.textAlign = 'center';
    for (let a = 0; a < 360; a += 10) {
      const p = project(cam, a, 0); if (!p) continue;
      const major = a % 30 === 0;
      ctx.strokeStyle = 'rgba(255,255,255,.6)';
      ctx.beginPath(); ctx.moveTo(p[0], p[1] - (major ? 8 : 4)); ctx.lineTo(p[0], p[1] + (major ? 8 : 4)); ctx.stroke();
      if (major) svPill(a % 90 === 0 ? ['N', 'O', 'S', 'W'][a / 90] : `${a}°`, p[0], p[1] + 20, a === 0 ? '#ff6b6b' : 'rgba(255,255,255,.9)');
    }
    ctx.restore();
  }

  // Ziel-Richtung
  if (state.target) {
    const b = bearing(lat, lng, state.target.lat, state.target.lng);
    const p0 = project(cam, b, -20), p1 = project(cam, b, 60);
    if (p0 && p1) {
      ctx.save(); ctx.strokeStyle = COLORS.target; ctx.lineWidth = 1.5; ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke(); ctx.restore();
      const pl = project(cam, b, 0);
      if (pl) svPill(`Ziel · ${fmtDist(distance(lat, lng, state.target.lat, state.target.lng))}`, pl[0], pl[1] - 22, COLORS.target);
    }
  }

  // Milchstraße
  if (L_.milky) {
    ctx.save(); ctx.lineWidth = 2.5; ctx.setLineDash([2, 5]);
    pathSegments(cam, day.gcPath, (p) => { const s = sunAt(day, p.t); return s < -12 ? hexAlpha(COLORS.milky, 0.95) : null; });
    ctx.restore();
    const g = gcPos(state.time, obs); const pp = project(cam, g.az, g.alt);
    if (pp && g.alt > -2) { glow(pp[0], pp[1], 10, COLORS.milky); svPill('Milchstraßen-Kern', pp[0], pp[1] - 24, COLORS.milky); }
  }

  // Mondbahn
  if (L_.moon) {
    ctx.save(); ctx.lineWidth = 2; ctx.setLineDash([6, 5]);
    pathSegments(cam, day.moonPath, (p) => (p.alt > -3 ? 'rgba(200,225,255,.9)' : null));
    ctx.restore();
    hourMarks(cam, day.moonPath, 'rgba(200,225,255,.95)');
    const m = moonPos(state.time, obs); const pp = project(cam, m.az, m.alt);
    if (pp && m.alt > -3) {
      const r = Math.max(9, cam.f * Math.tan(rad(0.26)));
      drawMoon(ctx, pp[0], pp[1], r, m.illum, m.waxing);
      svPill(`Mond ${Math.round(m.illum * 100)} % · ${fmtDeg(m.alt, 1)}`, pp[0], pp[1] + r + 16, COLORS.moon);
    }
    if (day.moon.rise) mark(cam, day.moon.riseAz, `☾ ↑ ${fmtTime(day.moon.rise, state.tz)}`, COLORS.moonrise);
    if (day.moon.set) mark(cam, day.moon.setAz, `☾ ↓ ${fmtTime(day.moon.set, state.tz)}`, COLORS.moonset);
  }

  // Sonnenbahn
  if (L_.sun) {
    ctx.save(); ctx.lineWidth = 3.5; ctx.lineCap = 'round';
    pathSegments(cam, day.sunPath, (p) => {
      if (p.alt < -6) return null;
      if (p.alt < -4) return hexAlpha(COLORS.blue, 0.95);
      if (p.alt < 6) return COLORS.golden;
      return COLORS.sun;
    });
    ctx.restore();
    hourMarks(cam, day.sunPath, '#fff3c4');
    if (day.sun.rise) mark(cam, day.sun.riseAz, `↑ ${fmtTime(day.sun.rise, state.tz)}`, COLORS.sunrise);
    if (day.sun.set) mark(cam, day.sun.setAz, `↓ ${fmtTime(day.sun.set, state.tz)}`, COLORS.sunset);
    const s = sunPos(state.time, obs); const pp = project(cam, s.az, s.alt);
    if (pp && s.alt > -6) {
      const r = Math.max(10, cam.f * Math.tan(rad(0.27)));
      glow(pp[0], pp[1], r, s.alt < 6 ? COLORS.golden : COLORS.sun);
      svPill(`${fmtTime(state.time, state.tz)} · ${fmtDeg(s.alt, 1)}`, pp[0], pp[1] - r - 18, s.alt < 6 ? COLORS.golden : COLORS.sun);
    }
  }

  // HUD unten links
  const s = sunPos(state.time, obs);
  const ph = phaseOf(s.alt);
  ctx.save();
  ctx.font = '600 12px -apple-system, Inter, sans-serif';
  const txt = `Blick ${Math.round(((cam.heading % 360) + 360) % 360)}° ${compass(cam.heading)} · Neigung ${Math.round(cam.pitch)}° · Bildwinkel ${Math.round(cam.fovH)}°   |   ${ph.label}`;
  const w = ctx.measureText(txt).width + 20;
  ctx.fillStyle = 'rgba(10,14,22,.7)'; roundRect(ctx, 12, box.height - 40 - 0, w, 26, 13); ctx.fill();
  ctx.fillStyle = '#e8ecf4'; ctx.textBaseline = 'middle'; ctx.fillText(txt, 22, box.height - 27);
  ctx.restore();

  // ── innere Helfer
  function polyline(cam, pts) {
    let started = false; ctx.beginPath();
    for (const [az, alt] of pts) {
      const p = project(cam, az, alt);
      if (!p) { started = false; continue; }
      if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
  }
  function pathSegments(cam, pts, colorFn) {
    // feiner interpolieren für glatte Kurven
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const col = colorFn(b); if (!col) continue;
      let da = ((b.az - a.az + 540) % 360) - 180;
      const steps = 4; let prev = project(cam, a.az, a.alt);
      ctx.strokeStyle = col;
      ctx.beginPath(); let moved = false;
      if (prev) { ctx.moveTo(prev[0], prev[1]); moved = true; }
      for (let k = 1; k <= steps; k++) {
        const az = a.az + (da * k) / steps, alt = a.alt + ((b.alt - a.alt) * k) / steps;
        const p = project(cam, az, alt);
        if (!p) { moved = false; continue; }
        if (!moved) { ctx.moveTo(p[0], p[1]); moved = true; } else ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
    }
  }
  function hourMarks(cam, pts, color) {
    ctx.save(); ctx.font = '600 11px -apple-system, Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    pts.forEach((p, i) => {
      if (i % 6 !== 0 || p.alt < -4) return;
      const pp = project(cam, p.az, p.alt); if (!pp) return;
      ctx.fillStyle = 'rgba(10,14,22,.8)'; ctx.beginPath(); ctx.arc(pp[0], pp[1], 4.5, 0, 7); ctx.fill();
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(pp[0], pp[1], 3, 0, 7); ctx.fill();
      ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 4;
      ctx.fillText(fmtTime(p.t, state.tz).slice(0, 2) + ' h', pp[0], pp[1] - 13);
      ctx.shadowBlur = 0;
    });
    ctx.restore();
  }
  function mark(cam, az, text, color) {
    const p = project(cam, az, 0); if (!p) return;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(p[0], p[1] - 14); ctx.lineTo(p[0], p[1] + 14); ctx.stroke(); ctx.restore();
    svPill(text, p[0], p[1] + 32, color);
  }
  function glow(x, y, r, color) {
    ctx.save();
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
    g.addColorStop(0, '#fff'); g.addColorStop(0.3, color); g.addColorStop(1, hexAlpha(color, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 3, 0, 7); ctx.fill();
    ctx.restore();
  }
  function svPill(text, x, y, color) {
    ctx.save();
    ctx.font = '600 11px -apple-system, "SF Pro Text", Inter, sans-serif';
    const w = ctx.measureText(text).width + 14, h = 20;
    ctx.fillStyle = 'rgba(10,14,22,.72)'; roundRect(ctx, x - w / 2, y - h / 2, w, h, 10); ctx.fill();
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y + 0.5);
    ctx.restore();
  }
}
function sunAt(day, t) {
  const i = Math.round((t - day.start) / 600000);
  return day.sunPath[Math.max(0, Math.min(day.sunPath.length - 1, i))].alt;
}

function calibDialog(redraw) {
  const cur = prefs.get('svFov') || 1;
  const box = document.createElement('div');
  box.className = 'popover glass';
  box.innerHTML = `
    <h4>Bildwinkel-Kalibrierung</h4>
    <p class="muted">Falls die Bahnen nicht exakt zum Bild passen (z. B. Horizontlinie), hier feinjustieren.</p>
    <input type="range" min="0.8" max="1.25" step="0.005" value="${cur}" id="sv-fov-r">
    <div class="btn-row"><span id="sv-fov-v">${Math.round(cur * 1000) / 10} %</span><button class="btn sm ghost" id="sv-fov-reset">Zurücksetzen</button><button class="btn sm" id="sv-fov-ok">Fertig</button></div>`;
  $('#view-sv').appendChild(box);
  const r = box.querySelector('#sv-fov-r');
  r.oninput = () => { prefs.set('svFov', +r.value); box.querySelector('#sv-fov-v').textContent = `${Math.round(r.value * 1000) / 10} %`; redraw(); };
  box.querySelector('#sv-fov-reset').onclick = () => { r.value = 1; r.oninput(); };
  box.querySelector('#sv-fov-ok').onclick = () => box.remove();
}
