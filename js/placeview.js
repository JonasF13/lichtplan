// ─────────────────────────────────────────────────────────────
// Ortsinfo-Ansicht: Fotos, Fakten, Anreise & Parken, Gut zu wissen
// (im Spot-Editor und als Vorschau-Popup auf der Karte)
// ─────────────────────────────────────────────────────────────
import { loadPlaceInfo, cachedPlaceInfo, placeInfoText, updateCachedInfo } from './placeinfo.js';
import { getDay, seasons } from './astro.js';
import { $, el, esc, icon, fmtTime, fmtAz, fmtDist, zonedParts } from './utils.js';
import { modal, toast } from './ui.js';
import { state } from './state.js';

let showParkingOnMap = null; // von map.js gesetzt
export function setParkingHandler(fn) { showParkingOnMap = fn; }

const nav = (lat, lng) => ({
  google: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
  apple: `https://maps.apple.com/?daddr=${lat},${lng}`,
});
const km = (m) => (m == null ? '' : fmtDist(m));

// ── Großansicht eines Fotos ─────────────────────────────────
export function openPhoto(ph, all = []) {
  let i = Math.max(0, all.indexOf(ph));
  const body = el(`<div class="lightbox"><img alt=""><div class="lb-meta"></div></div>`);
  const show = () => {
    const p = all[i] || ph;
    body.querySelector('img').src = p.full || p.thumb;
    body.querySelector('.lb-meta').innerHTML = `<b>${esc(p.title)}</b><span>${p.author ? 'Foto: ' + esc(p.author) + ' · ' : ''}${esc(p.license || '')}${p.dist != null ? ' · ' + km(p.dist) + ' vom Spot' : ''}</span>${p.page ? `<a href="${p.page}" target="_blank" rel="noopener">${icon('ext')}Auf Wikimedia Commons ansehen</a>` : ''}`;
  };
  show();
  const { node } = modal({ title: 'Foto', body, wide: true });
  node.querySelector('.modal').classList.add('photo-modal');
  const key = (e) => { if (e.key === 'ArrowRight') { i = (i + 1) % all.length; show(); } if (e.key === 'ArrowLeft') { i = (i - 1 + all.length) % all.length; show(); } };
  document.addEventListener('keydown', key);
  new MutationObserver((_, o) => { if (!document.body.contains(node)) { document.removeEventListener('keydown', key); o.disconnect(); } }).observe(document.body, { childList: true, subtree: true });
}

// ── Licht-Fakten (berechnet) ────────────────────────────────
function lightFacts(spot) {
  const tz = spot.tz || state.tz;
  const y = zonedParts(new Date(), tz).y;
  const S = seasons(y);
  const sum = getDay(spot.lat, spot.lng, spot.elevation || 0, tz, S[1].time);
  const win = getDay(spot.lat, spot.lng, spot.elevation || 0, tz, S[3].time);
  const facts = [];
  if (spot.elevation) facts.push(`Höhe ${Math.round(spot.elevation)} m`);
  if (sum.sun.set && win.sun.set) facts.push(`Sonnenuntergang zwischen ${fmtAz(win.sun.setAz)} (Winter, ${fmtTime(win.sun.set, tz)}) und ${fmtAz(sum.sun.setAz)} (Sommer, ${fmtTime(sum.sun.set, tz)})`);
  if (sum.sun.rise && win.sun.rise) facts.push(`Sonnenaufgang zwischen ${fmtAz(win.sun.riseAz)} (Winter) und ${fmtAz(sum.sun.riseAz)} (Sommer)`);
  return facts;
}

// ── Karte „Ortsinfo“ im Spot-Editor ─────────────────────────
export function renderPlaceCard(container, spot, { aiAvailable } = {}) {
  container.innerHTML = `
    <h3>${icon('image')}Ortsinfo</h3>
    <div class="ph-strip"><div class="ph-skel"></div><div class="ph-skel"></div><div class="ph-skel"></div></div>
    <div class="pi-sec pi-light"></div>
    <div class="pi-sec pi-wiki"><div class="pi-load">Suche Wissenswertes …</div></div>
    <div class="pi-sec pi-access"><div class="pi-load">Suche Parkplätze …</div></div>
    <div class="pi-sec pi-notes"></div>
    <div class="pi-ai"></div>
    <div class="pi-foot muted small"></div>`;
  const lf = lightFacts(spot);
  container.querySelector('.pi-light').innerHTML = lf.length ? `<h4>${icon('sun')}Licht</h4><ul class="pi-list">${lf.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '';
  const paint = (info) => fill(container, spot, info, { aiAvailable });
  const c = cachedPlaceInfo(spot.lat, spot.lng);
  if (c) paint(c);
  loadPlaceInfo(spot.lat, spot.lng, { onPartial: paint, hint: `${spot.name} ${spot.notes || ''}` }).catch(() => {});
}

function fill(root, spot, info, { aiAvailable }) {
  // Fotos
  const strip = root.querySelector('.ph-strip');
  if (info.photos) {
    if (info.photos.length) {
      strip.innerHTML = '';
      info.photos.forEach((p) => {
        const b = el(`<button class="ph" title="${esc(p.title)}"><img loading="lazy" src="${p.thumb}" alt=""><span>${km(p.dist)}</span></button>`);
        b.onclick = () => openPhoto(p, info.photos);
        strip.appendChild(b);
      });
    } else {
      strip.innerHTML = `<div class="ph-none">${icon('image')}<span>Keine freien Fotos aus der Nähe gefunden.</span><a href="https://www.google.com/search?tbm=isch&q=${encodeURIComponent(spot.name)}" target="_blank" rel="noopener">${icon('ext')}Im Web suchen</a></div>`;
    }
  }
  // Wikipedia
  const wk = root.querySelector('.pi-wiki');
  if (info.wiki) {
    wk.innerHTML = info.wiki.length
      ? `<h4>${icon('star')}Wissenswertes</h4>${info.wiki.map((w, i) => `
        <div class="pi-wk ${i > 1 ? 'more hidden' : ''}">
          ${w.thumb ? `<img src="${w.thumb}" alt="" loading="lazy">` : ''}
          <div><a href="${w.url}" target="_blank" rel="noopener"><b>${esc(w.title)}</b></a>${w.dist != null ? `<em>${km(w.dist)}${w.lang !== 'de' ? ' · ' + w.lang.toUpperCase() : ''}</em>` : ''}<p>${esc(w.extract)}</p></div>
        </div>`).join('')}${info.wiki.length > 2 ? `<button class="btn sm ghost pi-more">${icon('chevron')}${info.wiki.length - 2} weitere</button>` : ''}`
      : `<h4>${icon('star')}Wissenswertes</h4><p class="muted small">Keine Wikipedia-Artikel in der Umgebung.</p>`;
    wk.querySelector('.pi-more')?.addEventListener('click', (e) => { wk.querySelectorAll('.more').forEach((n) => n.classList.remove('hidden')); e.currentTarget.remove(); });
  }
  // Anreise & Parken
  const ac = root.querySelector('.pi-access');
  if (info.parking) {
    const p0 = info.parking[0];
    const nv = nav(p0?.lat ?? spot.lat, p0?.lng ?? spot.lng);
    ac.innerHTML = `<h4>${icon('route')}Anreise &amp; Parken</h4>
      ${info.parking.length ? `<div class="pi-park">${info.parking.map((p, i) => `
        <div class="pk ${i === 0 ? 'first' : ''}"><span class="pk-ico">P</span><div><b>${esc(p.name || 'Parkplatz')}</b><em>${km(p.dist)} ${p.dir}${p.fee ? ' · ' + p.fee : ''}${p.capacity ? ' · ' + p.capacity + ' Plätze' : ''}${p.surface === 'unpaved' || p.surface === 'gravel' ? ' · Schotter' : ''}${p.hours ? ' · ' + esc(p.hours) : ''}</em></div></div>`).join('')}</div>
        ${info.walk ? `<p class="pi-walk">${icon('route')}<span>Vom nächsten Parkplatz <b>${info.walk.minutes} min zu Fuß</b> (${km(info.walk.meters)})</span></p>` : ''}`
      : '<p class="muted small">Kein Parkplatz im Umkreis von 2 km in OpenStreetMap eingetragen – evtl. am Straßenrand parken.</p>'}
      ${info.transit?.length ? `<p class="pi-transit">${icon('route')}<span>Öffentlich: ${info.transit.map((t) => `${t.type === 'train' ? 'Bahn' : 'Bus'} „${esc(t.name)}“ ${km(t.dist)}`).join(' · ')}</span></p>` : ''}
      <div class="btn-row wrap">
        <a class="btn sm" target="_blank" rel="noopener" href="${nv.google}">${icon('route')}${p0 ? 'Zum Parkplatz' : 'Zum Spot'} (Google)</a>
        <a class="btn sm ghost" target="_blank" rel="noopener" href="${nv.apple}">${icon('map')}Apple Karten</a>
        ${info.parking.length ? `<button class="btn sm ghost pi-showpark">${icon('pin')}Auf Karte zeigen</button>` : ''}
      </div>`;
    ac.querySelector('.pi-showpark')?.addEventListener('click', () => showParkingOnMap?.(info.parking, spot));
  }
  // Gut zu wissen
  const nt = root.querySelector('.pi-notes');
  if (info.notes) {
    const notes = [...info.notes];
    if (info.parking?.[0]?.fee === 'gebührenpflichtig') notes.unshift({ icon: 'clock', text: 'Nächster Parkplatz ist gebührenpflichtig – Kleingeld/App bereithalten.' });
    nt.innerHTML = notes.length ? `<h4>${icon('eye')}Gut zu wissen</h4><ul class="pi-notes-list">${notes.map((n) => `<li>${icon(n.icon || 'check')}<span>${esc(n.text)}</span></li>`).join('')}</ul>` : '';
  }
  // KI-Zusammenfassung
  const ai = root.querySelector('.pi-ai');
  if (info.done && aiAvailable && !ai.dataset.ready) {
    ai.dataset.ready = '1';
    if (info.aiSummary) ai.innerHTML = aiBox(info.aiSummary);
    else {
      ai.innerHTML = `<button class="btn sm block pi-ai-btn">${icon('sparkles')}Key Facts &amp; Tipps vom Assistenten</button>`;
      ai.querySelector('.pi-ai-btn').onclick = () => runAI(ai, spot, info);
    }
  }
  root.querySelector('.pi-foot').innerHTML = info.done ? `Quellen: Wikimedia Commons, Wikipedia, OpenStreetMap · <a href="#" class="pi-refresh">${icon('sync')}aktualisieren</a>` : 'Lade Ortsinfos …';
  root.querySelector('.pi-refresh')?.addEventListener('click', (e) => { e.preventDefault(); delete ai.dataset.ready; loadPlaceInfo(spot.lat, spot.lng, { force: true, hint: `${spot.name} ${spot.notes || ''}`, onPartial: (i) => fill(root, spot, i, { aiAvailable }) }); });
}

const aiBox = (md) => `<div class="pi-ai-out"><h4>${icon('sparkles')}Key Facts &amp; Tipps</h4><div class="ai-text">${md}</div><p class="muted small">KI-generiert auf Basis von Wikipedia &amp; OpenStreetMap – bitte vor Ort prüfen.</p></div>`;

async function runAI(box, spot, info) {
  const [{ activeProfile, chat }, { md }] = await Promise.all([import('./ai/provider.js'), import('./ai/chat.js')]);
  const prof = activeProfile();
  if (!prof) return toast('Kein KI-Modell eingerichtet');
  box.innerHTML = '<div class="ai-typing"><i></i><i></i><i></i></div>';
  try {
    const res = await chat(prof, [
      { role: 'system', content: 'Du bist ein erfahrener Landschafts- und Reisefotograf. Antworte auf Deutsch, knapp, als Markdown. Nutze NUR die gegebenen Fakten, erfinde nichts. Wenn Fakten fehlen, lass den Punkt weg.' },
      { role: 'user', content: `Erstelle für diesen Foto-Spot:\n1. „Key Facts“: 3–5 spannende, kurze Fakten zum Ort.\n2. „Vor Ort beachten“: 3–5 praktische Tipps (Anreise, Parken, Zeitpunkt, Ausrüstung, Regeln).\n\nDaten:\n${placeInfoText(spot.name, info)}\n\nNotizen des Fotografen: ${spot.notes || '–'}` },
    ], {});
    const html = md(res.content || '');
    box.innerHTML = aiBox(html);
    updateCachedInfo(spot.lat, spot.lng, { aiSummary: html });
  } catch (e) {
    box.innerHTML = `<p class="warn small">${esc(e.message || 'KI nicht erreichbar')}</p>`;
    delete box.dataset.ready;
  }
}

// ── Vorschau-Popup auf der Karte ────────────────────────────
export function popupContent(spot, project, { onOpen }) {
  const node = el(`<div class="spot-pop">
    <div class="sp-img"></div>
    <div class="sp-body">
      <b>${esc(spot.name)}</b>
      ${project ? `<span class="sp-proj" style="--c:${project.color}">${esc(project.name)}</span>` : ''}
      <div class="sp-facts muted small">Lade Infos …</div>
      <div class="sp-btns"><button class="btn sm primary sp-open">${icon('list')}Details</button><a class="btn sm ghost" target="_blank" rel="noopener" href="${nav(spot.lat, spot.lng).google}">${icon('route')}Navi</a></div>
    </div></div>`);
  node.querySelector('.sp-open').onclick = () => onOpen?.();
  const paint = (info) => {
    const ph = info.photos?.[0];
    if (ph) { const im = node.querySelector('.sp-img'); im.innerHTML = `<img src="${ph.thumb}" alt="">`; im.onclick = () => openPhoto(ph, info.photos); }
    else if (info.photos) node.querySelector('.sp-img').classList.add('none');
    const f = [];
    if (info.parking?.[0]) f.push(`🅿 ${km(info.parking[0].dist)}${info.walk ? ` · ${info.walk.minutes} min zu Fuß` : ''}${info.parking[0].fee ? ' · ' + info.parking[0].fee : ''}`);
    if (info.wiki?.[0]) f.push(`ℹ︎ ${esc(info.wiki[0].title)}`);
    if (info.notes?.find((n) => n.kind === 'protect')) f.push('🌿 Schutzgebiet');
    if (info.notes?.find((n) => n.kind === 'drone')) f.push('✈︎ Drohnen-Einschränkung');
    node.querySelector('.sp-facts').innerHTML = f.length ? f.join('<br>') : info.done ? 'Keine weiteren Infos gefunden.' : 'Lade Infos …';
  };
  const c = cachedPlaceInfo(spot.lat, spot.lng);
  if (c) paint(c);
  loadPlaceInfo(spot.lat, spot.lng, { onPartial: paint, hint: `${spot.name} ${spot.notes || ''}` }).catch(() => {});
  return node;
}
