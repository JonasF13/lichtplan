// ─────────────────────────────────────────────────────────────
// KI-Assistent: Chat-Panel, Agenten-Schleife, Einstellungen
// ─────────────────────────────────────────────────────────────
import { state, setState, onState } from '../state.js';
import { store } from '../store.js';
import * as P from './provider.js';
import { toolDefs, runTool, TOOL_MAP, appContext, initTools, localISO } from './tools.js';
import { readExif, exifSummary, imageToDataURL } from './exif.js';
import { $, $$, icon, esc, el, rafThrottle, zonedToUtc, fmtDateShort, fmtTime } from '../utils.js';
import { modal, toast, confirmDialog, menu } from '../ui.js';

const CHAT_KEY = 'lichtplan.chat.v1';
const MAX_STEPS = 10;
let api = {};
let history = [];   // Nachrichten im API-Format
let turns = [];     // Anzeige
let busy = false, abortCtl = null;
let attachments = []; // { url, name, exif }

export function initAI(a) {
  api = a;
  initTools(a);
  try { const s = JSON.parse(localStorage.getItem(CHAT_KEY)); if (s) { history = s.history || []; turns = s.turns || []; } } catch {}
  buildPanel();
  window.addEventListener('lp-ai-config', () => { updateHeader(); renderAll(); });
  onState((ch) => { if (ch.has('time') || ch.has('lat') || ch.has('placeName') || ch.has('activeSpotId') || ch.has('target') || ch.has('activeProjectId')) updateContextChip(); });
}

export function isOpen() { return $('#inspector').classList.contains('ai-mode'); }
export async function openAI(prompt) {
  $('#inspector').classList.add('ai-mode');
  $('#btn-ai')?.classList.add('on');
  if (!P.profiles().length) {
    const p = await P.autoSetup();
    if (p) toast(`KI eingerichtet: ${esc(p.model)} (Ollama)`);
  }
  updateHeader(); updateContextChip(); renderAll();
  if (prompt) send(prompt);
  else setTimeout(() => $('#ai-input')?.focus(), 50);
}
export function closeAI() { $('#inspector').classList.remove('ai-mode'); $('#btn-ai')?.classList.remove('on'); }
export function toggleAI() { isOpen() ? closeAI() : openAI(); }

// ── Panel ───────────────────────────────────────────────────
function buildPanel() {
  const panel = el(`
    <div id="ai-panel">
      <div class="ai-head">
        <div class="ai-title">${icon('sparkles')}<b>Assistent</b></div>
        <button class="ai-model" id="ai-model-btn" title="Modell wählen"></button>
        <button class="icon-btn sm" id="ai-new" title="Neuer Chat">${icon('edit')}</button>
        <button class="icon-btn sm" id="ai-settings" title="KI-Einstellungen">${icon('settings')}</button>
        <button class="icon-btn sm" id="ai-close" title="Schließen (K)">${icon('close')}</button>
      </div>
      <div class="ai-msgs" id="ai-msgs"></div>
      <div class="ai-compose" id="ai-compose">
        <div class="ai-ctx" id="ai-ctx"></div>
        <div class="ai-attach" id="ai-attach"></div>
        <div class="ai-input-row">
          <button class="icon-btn sm" id="ai-attach-btn" title="Foto anhängen (mit GPS/Zeit aus EXIF)">${icon('image')}</button>
          <textarea id="ai-input" rows="1" placeholder="Frag mich etwas …"></textarea>
          <button class="ai-send" id="ai-send" title="Senden (Enter)">${icon('send')}</button>
        </div>
        <div class="ai-foot muted small">Enter senden · ⇧Enter neue Zeile · Fotos hierher ziehen</div>
      </div>
    </div>`);
  $('#inspector').appendChild(panel);

  const input = $('#ai-input');
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(180, input.scrollHeight) + 'px'; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { input.blur(); }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); files.forEach(addAttachment); }
  });
  $('#ai-send').onclick = () => (busy ? abortCtl?.abort() : submit());
  $('#ai-attach-btn').onclick = () => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.multiple = true;
    i.onchange = () => [...i.files].forEach(addAttachment); i.click();
  };
  $('#ai-close').onclick = closeAI;
  $('#ai-settings').onclick = () => openAISettings();
  $('#ai-new').onclick = () => { if (busy) abortCtl?.abort(); history = []; turns = []; save(); renderAll(); $('#ai-input').focus(); };
  $('#ai-model-btn').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const act = P.activeProfile();
    menu(r.left, r.bottom + 6, [
      ...P.profiles().map((p) => ({ label: `${p.id === act?.id ? '✓ ' : '   '}${P.profileName(p)}`, onClick: () => { P.setActive(p.id); toast(`Modell: ${esc(P.profileName(p))}`); } })),
      '-',
      { label: 'Modell hinzufügen …', icon: 'plus', onClick: () => editProfile() },
      { label: 'KI-Einstellungen …', icon: 'settings', onClick: () => openAISettings() },
    ]);
  };
  // Drag & Drop von Fotos
  panel.addEventListener('dragover', (e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) { e.preventDefault(); panel.classList.add('drop'); } });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drop'); });
  panel.addEventListener('drop', (e) => {
    e.preventDefault(); panel.classList.remove('drop');
    [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(f.name)).forEach(addAttachment);
  });
  // Klicks auf lp:-Links in Antworten
  $('#ai-msgs').addEventListener('click', onMsgClick);
  updateHeader();
}

function updateHeader() {
  const p = P.activeProfile();
  const b = $('#ai-model-btn'); if (!b) return;
  b.innerHTML = p ? `<span class="dot ${P.PRESETS[p.preset]?.local ? 'local' : 'cloud'}"></span>${esc(p.model || 'Modell wählen')}${icon('chevron')}` : `<span class="dot off"></span>Kein Modell${icon('chevron')}`;
  b.title = p ? P.profileName(p) : 'Modell einrichten';
}
function updateContextChip() {
  const c = $('#ai-ctx'); if (!c) return;
  const sp = store.spot(state.activeSpotId);
  c.innerHTML = `<span>${icon('pin')}${esc(sp?.name || state.placeName || `${state.lat.toFixed(3)}, ${state.lng.toFixed(3)}`)}</span><span>${icon('calendar')}${fmtDateShort(state.time, state.tz)} ${fmtTime(state.time, state.tz)}</span>${state.target ? `<span class="tg">${icon('target')}Ziel</span>` : ''}`;
  c.title = 'Diese Infos sieht der Assistent automatisch';
}

// ── Anhänge ─────────────────────────────────────────────────
async function addAttachment(file) {
  try {
    const exif = await readExif(file);
    const url = await imageToDataURL(file);
    attachments.push({ url, name: file.name, exif });
    renderAttachments();
  } catch {
    toast('Bild konnte nicht gelesen werden (JPG/PNG verwenden)', 'warn');
  }
}
function renderAttachments() {
  const box = $('#ai-attach');
  box.innerHTML = '';
  attachments.forEach((a, i) => {
    const n = el(`<div class="att">
      <img src="${a.url}" alt="">
      <div class="att-info"><b>${esc(a.name)}</b><span>${a.exif ? esc(exifSummary(a.exif)) : 'keine Foto-Metadaten'}</span>
        ${a.exif?.lat != null ? `<button class="btn sm ghost att-use">${icon('pin')}Ort${a.exif.localTime ? ' & Zeit' : ''} übernehmen</button>` : ''}</div>
      <button class="icon-btn xs att-del" title="Entfernen">${icon('close')}</button></div>`);
    n.querySelector('.att-del').onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    n.querySelector('.att-use')?.addEventListener('click', () => applyExif(a.exif));
    box.appendChild(n);
  });
}
async function applyExif(x) {
  setState({ lat: x.lat, lng: x.lng, placeName: '', activeSpotId: null });
  api.flyTo?.(x.lat, x.lng, 15);
  if (x.localTime) {
    const [d, t] = x.localTime.split('T'); const [y, m, dd] = d.split('-').map(Number); const [hh, mi] = t.split(':').map(Number);
    const time = x.offset ? new Date(`${x.localTime}:00${x.offset}`) : zonedToUtc(y, m, dd, hh, mi, state.tz);
    if (!isNaN(time)) setState({ time });
  }
  if (x.heading != null) toast(`Blickrichtung laut Foto: ${x.heading}°`);
}

// ── Senden / Agenten-Schleife ───────────────────────────────
function submit() {
  const input = $('#ai-input');
  const text = input.value.trim();
  if (!text && !attachments.length) return;
  input.value = ''; input.style.height = 'auto';
  send(text || 'Was siehst du auf dem Foto, und wie kann ich das Motiv mit dem besten Licht fotografieren?');
}

function systemPrompt(useTools, extra = '') {
  return `Du bist der Assistent der Foto-Planungs-App „Specula“ (ähnlich Sun Surveyor / PhotoPills) – ein erfahrener Landschafts- und Reisefotograf. Du hilfst, Sonne, Mond, Milchstraße und Wetter zu planen und Foto-Spots in Projekten (Reisen) zu organisieren.

REGELN
1. ${useTools ? 'Uhrzeiten, Richtungen (Azimut), Mondphasen, Wetter und Koordinaten NIE schätzen oder aus dem Gedächtnis nennen – immer die Werkzeuge verwenden. Mehrere Werkzeuge nacheinander nutzen ist ausdrücklich erwünscht.' : 'Du hast in diesem Modus KEINE Werkzeuge. Nutze ausschließlich die Daten unten. Wenn etwas fehlt, sag ehrlich, dass du es nicht berechnen kannst, und verweise auf den Planer-Reiter der App.'}
   Vor einem Werkzeugaufruf höchstens EIN kurzer Satz („Ich prüfe …“) – keine Vermutungen über das Ergebnis.
2. Alle Uhrzeiten sind Ortszeit des jeweiligen Ortes im 24-h-Format. Formate für Werkzeuge: Datum YYYY-MM-DD, Zeit YYYY-MM-DDTHH:MM.
3. „heute“, „morgen“, „am Wochenende“ beziehen sich auf das echte heutige Datum (unten). Ohne Datumsangabe gilt der in der App gewählte Zeitpunkt.
4. Ohne Ortsangabe gilt der Standort der App. Gespeicherte Spots über ihre id ansprechen (ids via list_spots / list_projects).
5. Daten nur ändern (create_project, create_spot, update_spot, add_shoot), wenn der Nutzer das wünscht oder es eindeutig zur Aufgabe gehört. Danach kurz bestätigen, was geändert wurde. Nie Koordinaten erfinden – search_place verwenden.
6. Antworte auf Deutsch, kurz und praxisnah: Stichpunkte statt Fließtext, konkrete Empfehlung (beste Zeit, Richtung, ggf. Brennweite/Tipps). Keine langen Einleitungen.
7. Werkzeug-Ergebnisse enthalten fertige Links (Feld „link“) – übernimm sie unverändert in deine Antwort. Sonst selbst: Mach konkrete Zeitpunkte anklickbar: [Sa 14.08. 19:58](lp:time/2027-08-14T19:58) (Ortszeit). Bezieht sich die Zeit auf einen gespeicherten Spot, hänge @id an: [19:58](lp:time/2027-08-14T19:58@SPOTID). Spots: [Name](lp:spot/SPOTID). Orte: [Name](lp:place/LAT,LNG).

WISSEN: Azimut 0°=N, 90°=O, 180°=S, 270°=W. Goldene Stunde: Sonne −4° bis +6°. Blaue Stunde: −6° bis −4°. Astronomische Nacht: Sonne unter −18°. Mond bei Sonnenuntergang nahe Horizont + ≥ 96 % beleuchtet = klassisches Vollmondmotiv. Milchstraßen-Kern: Saison ca. Feb–Okt (Nordhalbkugel).

AKTUELLER APP-ZUSTAND
${appContext()}${extra}`;
}

async function fallbackContext() {
  // Ohne Werkzeuge: wichtigste Daten direkt mitgeben
  try {
    const light = await TOOL_MAP.get_light_times.run({});
    const spots = store.spots.slice(0, 40).map((s) => `${s.name} (id ${s.id}, ${s.lat.toFixed(4)}, ${s.lng.toFixed(4)})`).join('; ');
    return `\n\nLICHTZEITEN AM GEWÄHLTEN TAG (JSON): ${JSON.stringify(light)}\nGESPEICHERTE SPOTS: ${spots || 'keine'}`;
  } catch { return ''; }
}

function trimmedHistory() {
  // die letzten 12 Nutzer-Nachrichten (inkl. aller zugehörigen Antworten/Werkzeuge)
  const userIdx = history.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
  const from = userIdx.length > 12 ? userIdx[userIdx.length - 12] : 0;
  return history.slice(from);
}

export async function send(text) {
  if (busy) return;
  const prof = P.activeProfile();
  if (!prof) {
    turns.push({ role: 'assistant', parts: [], error: 'Noch kein KI-Modell eingerichtet. Starte Ollama oder richte ein Modell in den KI-Einstellungen ein.', setup: true });
    renderAll(); return;
  }
  busy = true; setBusy(true);
  let caps;
  try { caps = await P.capabilities(prof); } catch { caps = { tools: true, vision: false }; }
  const imgs = attachments.splice(0);
  renderAttachments();
  let userText = text;
  const exifLines = imgs.filter((a) => a.exif).map((a) => `Foto „${a.name}“: ${exifSummary(a.exif)}`);
  if (exifLines.length) userText += `\n\n[Metadaten der angehängten Fotos]\n${exifLines.join('\n')}`;
  if (imgs.length && !caps.vision) userText += `\n\n(Hinweis: ${imgs.length} Foto(s) angehängt, aber dieses Modell kann keine Bilder sehen – nur die Metadaten oben sind verfügbar.)`;
  const content = imgs.length && caps.vision
    ? [{ type: 'text', text: userText }, ...imgs.map((a) => ({ type: 'image_url', image_url: { url: a.url } }))]
    : userText;
  history.push({ role: 'user', content });
  turns.push({ role: 'user', text, images: imgs.map((a) => a.url), exif: exifLines });
  const turn = { role: 'assistant', parts: [], model: prof.model, t0: Date.now() };
  turns.push(turn);
  renderAll(); scrollDown(true);

  abortCtl = new AbortController();
  let useTools = caps.tools, noReasoning = false, snapshot = null, steps = 0;
  const upd = rafThrottle(() => updateTurn(turn));
  try {
    while (steps < MAX_STEPS) {
      steps++;
      const extra = useTools ? '' : await fallbackContext();
      const msgs = [{ role: 'system', content: systemPrompt(useTools, extra) }, ...trimmedHistory()];
      let rPart = null, tPart = null;
      let res;
      try {
        res = await P.chat(prof, msgs, {
          tools: useTools ? toolDefs() : null, noReasoning, signal: abortCtl.signal,
          onReasoning: (r) => { if (!rPart) { rPart = { type: 'reasoning', text: '', live: true }; turn.parts.push(rPart); } rPart.text = r; upd(); },
          onContent: (c) => {
            const sp = P.splitThink(c);
            if (sp.reasoning) { if (!rPart) { rPart = { type: 'reasoning', text: '', live: true }; turn.parts.push(rPart); } rPart.text = sp.reasoning; rPart.live = !!sp.open; }
            if (sp.text.trim()) { if (rPart) rPart.live = false; if (!tPart) { tPart = { type: 'text', text: '' }; turn.parts.push(tPart); } tPart.text = sp.text; }
            upd();
          },
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (e.kind === 'no-tools' && useTools) { useTools = false; turn.parts.push({ type: 'note', text: 'Dieses Modell kann keine Werkzeuge nutzen – Antwort nur mit Basisdaten (eingeschränkt).' }); steps--; continue; }
        if (e.kind === 'no-reasoning' && !noReasoning) { noReasoning = true; steps--; continue; }
        if (e.kind === 'no-vision' && Array.isArray(content)) { history[history.length - 1 - 0].content = userText; turn.parts.push({ type: 'note', text: 'Das Modell kann keine Bilder verarbeiten – nur Metadaten gesendet.' }); steps--; continue; }
        throw e;
      }
      if (rPart) { rPart.live = false; rPart.text = res.reasoning || rPart.text; }
      if (res.content && !tPart) { tPart = { type: 'text', text: '' }; turn.parts.push(tPart); }
      if (tPart) { tPart.text = res.content; if (res.toolCalls.length) tPart.interim = true; }
      const msg = { role: 'assistant', content: res.content || '' };
      if (res.toolCalls.length) msg.tool_calls = res.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function.name, arguments: c.function.arguments || '{}' } }));
      history.push(msg);
      updateTurn(turn);
      if (!res.toolCalls.length) break;

      for (const c of res.toolCalls) {
        const T = TOOL_MAP[c.function.name];
        let args = {}; try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
        const part = { type: 'tool', name: c.function.name, args, status: 'running', label: toolLabel(T, args, null, c.function.name) };
        turn.parts.push(part); updateTurn(turn); scrollDown();
        if (T?.mutates && !snapshot) snapshot = store.snapshot();
        const result = await runTool(c.function.name, c.function.arguments);
        part.result = result;
        part.status = result?.error ? 'error' : 'done';
        part.label = toolLabel(T, args, result, c.function.name);
        part.mutates = !!T?.mutates && !result?.error;
        const tm = { role: 'tool', tool_call_id: c.id, content: clip(JSON.stringify(result), 9000) };
        if (prof.preset === 'ollama' || prof.preset === 'lmstudio') tm.name = c.function.name;
        history.push(tm);
        updateTurn(turn);
        if (abortCtl.signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
      }
      if (steps >= MAX_STEPS) turn.parts.push({ type: 'note', text: `Nach ${MAX_STEPS} Schritten angehalten. Frag gern nach, um weiterzumachen.` });
    }
  } catch (e) {
    if (e.name === 'AbortError') turn.parts.push({ type: 'note', text: 'Gestoppt.' });
    else { turn.error = e.message || String(e); turn.errorKind = e.kind; }
    repairHistory();
  } finally {
    busy = false; setBusy(false);
    turn.ms = Date.now() - turn.t0;
    turn.parts.forEach((p) => { if (p.status === 'running') p.status = 'error'; if (p.type === 'reasoning') p.live = false; });
    if (snapshot && turn.parts.some((p) => p.mutates)) turn.undo = snapshot;
    save(); updateTurn(turn); scrollDown();
  }
}
/** Unvollständige Werkzeug-Sequenzen entfernen (sonst lehnt die API den nächsten Aufruf ab) */
function repairHistory() {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && m.tool_calls) {
      const answered = new Set(history.slice(i + 1).filter((x) => x.role === 'tool').map((x) => x.tool_call_id));
      if (!m.tool_calls.every((c) => answered.has(c.id))) history.splice(i);
      break;
    }
  }
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…(gekürzt)' : s);
function toolLabel(T, args, result, name) {
  try { return T?.label ? T.label(args || {}, result) : name; } catch { return name; }
}
function setBusy(b) {
  const s = $('#ai-send');
  s.classList.toggle('stop', b);
  s.innerHTML = icon(b ? 'stop' : 'send');
  s.title = b ? 'Stoppen' : 'Senden (Enter)';
}
function save() {
  // Bilder nicht dauerhaft speichern (zu groß)
  const h = history.slice(-80).map((m) => (Array.isArray(m.content) ? { ...m, content: m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') + '\n[Foto]' } : m));
  const t = turns.slice(-60).map((x) => (x.images ? { ...x, images: x.images.map(() => null) } : x));
  try { localStorage.setItem(CHAT_KEY, JSON.stringify({ history: h, turns: t })); } catch {}
}

// ── Darstellung ─────────────────────────────────────────────
function renderAll() {
  const box = $('#ai-msgs'); if (!box) return;
  box.innerHTML = '';
  if (!turns.length) { box.appendChild(emptyState()); return; }
  turns.forEach((t) => box.appendChild(renderTurn(t)));
  scrollDown(true);
}
function updateTurn(turn) {
  const box = $('#ai-msgs');
  const old = box.querySelector(`[data-turn="${turns.indexOf(turn)}"]`);
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const n = renderTurn(turn);
  // offene Details beibehalten
  if (old) {
    const open = [...old.querySelectorAll('details')].map((d) => d.open);
    old.replaceWith(n);
    n.querySelectorAll('details').forEach((d, i) => { if (open[i]) d.open = true; });
  } else box.appendChild(n);
  if (near) box.scrollTop = box.scrollHeight;
}
function scrollDown(force) {
  const box = $('#ai-msgs'); if (!box) return;
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
}

function renderTurn(t) {
  const i = turns.indexOf(t);
  if (t.role === 'user') {
    return el(`<div class="msg user" data-turn="${i}">
      ${(t.images || []).filter(Boolean).map((u) => `<img class="msg-img" src="${u}" alt="">`).join('')}
      ${(t.images || []).some((u) => !u) ? `<div class="msg-imgph">${icon('image')}Foto</div>` : ''}
      <div class="bubble">${esc(t.text).replace(/\n/g, '<br>')}</div>
      ${t.exif?.length ? `<div class="msg-exif">${t.exif.map(esc).join('<br>')}</div>` : ''}
    </div>`);
  }
  const parts = t.parts.map((p) => {
    if (p.type === 'reasoning') {
      return `<details class="ai-think ${p.live ? 'live' : ''}"><summary>${icon('brain')}${p.live ? 'Denkt nach …' : 'Gedankengang'}<span class="muted">${p.text.length > 0 ? ` · ${Math.round(p.text.length / 4)} Tokens` : ''}</span></summary><div class="think-body">${esc(p.text)}</div></details>`;
    }
    if (p.type === 'tool') {
      const res = p.result ? clip(JSON.stringify(p.result, null, 1), 2500) : '';
      return `<details class="ai-tool ${p.status}"><summary><span class="tool-ic">${p.status === 'running' ? '<i class="spin"></i>' : icon(p.status === 'error' ? 'close' : p.mutates ? 'edit' : 'check')}</span><span class="tool-l">${esc(p.label)}</span></summary>
        <div class="tool-body"><div class="muted small">${esc(p.name)}(${esc(JSON.stringify(p.args))})</div>${res ? `<pre>${esc(res)}</pre>` : ''}</div></details>`;
    }
    if (p.type === 'note') return `<div class="ai-note">${esc(p.text)}</div>`;
    if (p.interim) {
      return p.text.length > 160
        ? `<details class="ai-interim"><summary>${icon('chevron')}Zwischenschritt</summary><div class="ai-text">${md(p.text)}</div></details>`
        : `<div class="ai-text interim">${md(p.text)}</div>`;
    }
    return `<div class="ai-text">${md(p.text)}</div>`;
  }).join('');
  const waiting = busy && t === turns[turns.length - 1] && !t.parts.some((p) => p.type === 'text' || p.live || p.status === 'running');
  const changes = t.parts.filter((p) => p.mutates).length;
  const err = t.error ? errorBox(t) : '';
  const n = el(`<div class="msg assistant" data-turn="${i}">
    ${parts}
    ${waiting ? '<div class="ai-typing"><i></i><i></i><i></i></div>' : ''}
    ${err}
    ${(t.undo && !t.undone) ? `<button class="btn sm ghost ai-undo">${icon('undo')}${changes} Änderung${changes === 1 ? '' : 'en'} rückgängig machen</button>` : ''}
    ${t.undone ? '<div class="ai-note">Änderungen wurden rückgängig gemacht.</div>' : ''}
    ${t.ms && !busy ? `<div class="msg-meta">${esc(t.model || '')} · ${(t.ms / 1000).toFixed(1).replace('.', ',')} s</div>` : ''}
  </div>`);
  n.querySelector('.ai-undo')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Rückgängig machen?', 'Alle Änderungen dieser Antwort (und alles, was du danach geändert hast) werden zurückgesetzt.', 'Rückgängig', false))) return;
    store.restore(t.undo); t.undone = true; delete t.undo; save(); updateTurn(t); toast('Rückgängig gemacht');
  });
  n.querySelector('.ai-setup')?.addEventListener('click', () => openAISettings());
  n.querySelector('.ai-retry')?.addEventListener('click', () => {
    const lastUser = [...turns].reverse().find((x) => x.role === 'user');
    turns.splice(turns.indexOf(t), 1);
    const hi = history.map((m) => m.role).lastIndexOf('user');
    if (hi >= 0) history.splice(hi);
    if (lastUser) { turns.splice(turns.indexOf(lastUser), 1); send(lastUser.text); }
  });
  return n;
}
function errorBox(t) {
  const p = P.activeProfile();
  let hint = '';
  if (t.errorKind === 'network' && p?.preset === 'ollama') hint = 'Starte die Ollama-App (Menüleiste) und versuche es erneut.';
  else if (t.errorKind === 'network' && p?.preset === 'lmstudio') hint = 'In LM Studio den lokalen Server starten und „CORS“ aktivieren.';
  else if (t.errorKind === 'auth') hint = 'API-Key prüfen (KI-Einstellungen).';
  else if (t.errorKind === 'model') hint = 'Modellname prüfen – in den KI-Einstellungen „Modelle laden“.';
  return `<div class="ai-error">${icon('close')}<div><b>${esc(t.error)}</b>${hint ? `<span>${esc(hint)}</span>` : ''}
    <div class="btn-row">${t.setup ? `<button class="btn sm primary ai-setup">${icon('settings')}KI einrichten</button>` : `<button class="btn sm ai-retry">${icon('undo')}Nochmal</button><button class="btn sm ghost ai-setup">${icon('settings')}Einstellungen</button>`}</div></div></div>`;
}

function emptyState() {
  const p = P.activeProfile();
  const sp = store.spot(state.activeSpotId), pr = store.project(state.activeProjectId);
  const sugg = [];
  if (sp) sugg.push(`Wann ist in den nächsten 4 Wochen die beste Zeit für „${sp.name}“? Prüf auch das Wetter.`);
  if (state.target) sugg.push('Wann geht die Sonne genau hinter dem Ziel unter?', 'Wann steht der Vollmond über dem Ziel?');
  if (pr) sugg.push(`Erstelle einen Drehplan für „${pr.name}“: pro Abend der beste Sonnenuntergangs-Spot. Trag die Termine ein.`);
  sugg.push('Wie wird das Licht heute Abend hier – und wie das Wetter?', 'Gute Milchstraßen-Nächte im nächsten Monat?', 'Finde Vollmond-Aufgänge zur blauen Stunde in den nächsten 6 Monaten.', 'Lege einen Spot für den Pragser Wildsee an und sag mir den besten Sonnenaufgang im Juni.');
  const n = el(`<div class="ai-empty">
    <div class="ai-hero">${icon('sparkles')}</div>
    <h3>Dein Foto-Planungs-Assistent</h3>
    <p class="muted">${p ? `Läuft mit <b>${esc(p.model)}</b>${P.PRESETS[p.preset]?.local ? ' – lokal auf deinem Mac, privat.' : '.'}` : 'Noch kein Modell eingerichtet.'}
    Er rechnet mit den Daten der App (Sonne, Mond, Wetter, deine Spots) und kann Spots, Projekte und Termine für dich anlegen.</p>
    ${p ? '' : `<button class="btn primary" id="ai-setup-btn">${icon('settings')}KI-Modell einrichten</button>`}
    <div class="ai-sugg">${sugg.slice(0, 6).map((s) => `<button class="sugg">${esc(s)}</button>`).join('')}</div>
  </div>`);
  n.querySelectorAll('.sugg').forEach((b) => b.onclick = () => send(b.textContent));
  n.querySelector('#ai-setup-btn')?.addEventListener('click', () => openAISettings());
  return n;
}

function onMsgClick(e) {
  const a = e.target.closest('a.lp-link');
  if (!a) return;
  e.preventDefault();
  const v = a.dataset.lp;
  let m;
  if ((m = v.match(/^lp:spot\/(.+)$/))) {
    if (store.spot(m[1])) { api.selectSpot?.(m[1]); api.openSpot?.(m[1]); } else toast('Spot nicht gefunden');
  } else if ((m = v.match(/^lp:time\/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?:@(.+))?$/))) {
    let tz = state.tz;
    if (m[6] && store.spot(m[6])) { api.selectSpot?.(m[6]); api.openSpot?.(m[6]); tz = store.spot(m[6]).tz || tz; }
    setState({ time: zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz) });
  } else if ((m = v.match(/^lp:place\/(-?[\d.]+),(-?[\d.]+)$/))) {
    setState({ lat: +m[1], lng: +m[2], placeName: a.textContent, activeSpotId: null });
    api.flyTo?.(+m[1], +m[2], 14);
  }
}

// ── Mini-Markdown (sicher: erst escapen, dann formatieren) ──
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/\[([^\]]+)\]\(((?:https?:\/\/|lp:)[^)\s]+)\)/g, (_, t, u) =>
    u.startsWith('lp:') ? `<a href="#" class="lp-link" data-lp="${u}">${t}</a>` : `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
  return s;
}
export function md(src) {
  if (!src) return '';
  const out = [];
  const lines = src.replace(/\r/g, '').split('\n');
  let list = null, para = [], i = 0;
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara(); flushList();
      const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); i++; continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushPara(); flushList();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      const [head, ...rest] = body;
      out.push(`<div class="tbl"><table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { flushPara(); flushList(); out.push(`<h4>${inline(m[2])}</h4>`); i++; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr>'); i++; continue; }
    if ((m = line.match(/^\s*([-*•]|\d+[.)])\s+(.*)/))) {
      flushPara();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[2]); i++; continue;
    }
    if (!line.trim()) { flushPara(); flushList(); i++; continue; }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ' ' + line.trim(); i++; continue; }
    flushList(); para.push(line); i++;
  }
  flushPara(); flushList();
  return out.join('');
}

// ── KI-Einstellungen ────────────────────────────────────────
export function openAISettings() {
  const render = (node) => {
    const act = P.activeProfile();
    const list = node.querySelector('#ai-prof-list');
    list.innerHTML = P.profiles().length ? '' : '<p class="muted">Noch kein Modell eingerichtet.</p>';
    P.profiles().forEach((p) => {
      const r = el(`<div class="prof ${p.id === act?.id ? 'on' : ''}">
        <button class="prof-main"><span class="radio"></span><div><b>${esc(P.profileName(p))}</b><span>${esc(P.PRESETS[p.preset]?.label || p.preset)} · ${esc(p.baseUrl)}</span></div></button>
        <button class="icon-btn xs" data-a="edit" title="Bearbeiten">${icon('edit')}</button>
        <button class="icon-btn xs" data-a="del" title="Entfernen">${icon('trash')}</button></div>`);
      r.querySelector('.prof-main').onclick = () => { P.setActive(p.id); render(node); };
      r.querySelector('[data-a=edit]').onclick = () => editProfile(p, () => render(node));
      r.querySelector('[data-a=del]').onclick = async () => { if (await confirmDialog('Modell entfernen?', `„${esc(P.profileName(p))}“ wird aus der Liste entfernt.`)) { P.deleteProfile(p.id); render(node); } };
      list.appendChild(r);
    });
  };
  modal({
    title: 'KI-Assistent', wide: true,
    body: `<div class="form">
      <p class="muted">Der Assistent funktioniert mit jedem Modell, das die OpenAI-kompatible Chat-API spricht – lokal (Ollama, LM Studio) oder in der Cloud (OpenRouter, OpenAI, …). Lokale Modelle sind privat und kostenlos. Für die besten Ergebnisse braucht das Modell <b>Werkzeug-Unterstützung</b> (Function Calling) – z. B. Qwen 3.x, Llama 3.1+, Mistral, GPT, Claude.</p>
      <div id="ai-prof-list" class="prof-list"></div>
      <div class="btn-row wrap"><button class="btn sm primary" id="ai-add">${icon('plus')}Modell hinzufügen</button><button class="btn sm ghost" id="ai-detect">${icon('search')}Ollama-Modelle suchen</button></div>
      <p class="muted small">API-Keys werden nur lokal in diesem Browser gespeichert.</p>
    </div>`,
    onOpen: (node) => {
      render(node);
      node.querySelector('#ai-add').onclick = () => editProfile(null, () => render(node));
      node.querySelector('#ai-detect').onclick = async () => {
        const models = await P.listOllama();
        if (!models) return toast('Ollama nicht erreichbar – läuft die Ollama-App?', 'warn');
        const have = new Set(P.profiles().filter((p) => p.preset === 'ollama').map((p) => p.model));
        const add = models.filter((m) => !have.has(m));
        add.forEach((m) => P.upsertProfile({ ...P.newProfile('ollama', m), name: `${m} (lokal)` }));
        toast(add.length ? `${add.length} Ollama-Modell(e) hinzugefügt` : 'Alle Ollama-Modelle sind schon eingetragen');
        render(node);
      };
    },
    actions: [{ label: 'Fertig', kind: 'primary' }],
  });
}

export function editProfile(p0, onDone) {
  const p = p0 ? { ...p0 } : P.newProfile('ollama');
  const presetOpts = Object.entries(P.PRESETS).map(([k, v]) => `<option value="${k}" ${k === p.preset ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
  modal({
    title: p0 ? 'Modell bearbeiten' : 'Modell hinzufügen', wide: true,
    body: `<div class="form">
      <label>Anbieter<select id="pf-preset">${presetOpts}</select></label>
      <p class="muted small" id="pf-hint"></p>
      <label>Server-URL<input id="pf-url" value="${esc(p.baseUrl)}" spellcheck="false"></label>
      <label id="pf-key-l">API-Key <span class="muted" id="pf-key-link"></span><input id="pf-key" type="password" value="${esc(p.apiKey || '')}" placeholder="sk-…" autocomplete="off" spellcheck="false"></label>
      <label>Modell
        <div class="row-inline"><input id="pf-model" list="pf-models" value="${esc(p.model || '')}" placeholder="z. B. qwen3.6:27b" spellcheck="false"><button type="button" class="btn sm" id="pf-load">${icon('download')}Modelle laden</button></div>
        <datalist id="pf-models"></datalist>
      </label>
      <div class="row2">
        <label>Nachdenken (Reasoning)<select id="pf-reason">
          ${[['default', 'Modell-Standard'], ['none', 'Aus – schnell'], ['low', 'Niedrig'], ['medium', 'Mittel'], ['high', 'Hoch – gründlich, langsam']].map(([k, l]) => `<option value="${k}" ${p.reasoning === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
        <label>Werkzeuge (Function Calling)<select id="pf-tools">
          ${[['auto', 'Automatisch'], ['on', 'An'], ['off', 'Aus']].map(([k, l]) => `<option value="${k}" ${p.tools === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      </div>
      <div class="row2">
        <label>Bilder verstehen<select id="pf-vision">
          ${[['auto', 'Automatisch'], ['on', 'An'], ['off', 'Aus']].map(([k, l]) => `<option value="${k}" ${p.vision === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
        <label>Anzeigename (optional)<input id="pf-name" value="${esc(p.name || '')}" placeholder="z. B. Qwen lokal"></label>
      </div>
      <div class="btn-row"><button type="button" class="btn sm" id="pf-test">${icon('play')}Verbindung testen</button><span id="pf-test-out" class="muted small"></span></div>
    </div>`,
    onOpen: (n) => {
      const q = (s) => n.querySelector(s);
      const sync = (changedPreset) => {
        const pr = P.PRESETS[q('#pf-preset').value];
        q('#pf-hint').textContent = pr.hint || '';
        if (changedPreset) { q('#pf-url').value = pr.baseUrl; q('#pf-reason').value = q('#pf-preset').value === 'ollama' ? 'none' : 'default'; }
        q('#pf-key-l').style.display = pr.needsKey || q('#pf-key').value ? '' : 'none';
        q('#pf-key-link').innerHTML = pr.keyUrl ? `· <a href="${pr.keyUrl}" target="_blank" rel="noopener">Key holen</a>` : '';
      };
      sync(false);
      q('#pf-preset').onchange = () => sync(true);
      const read = () => ({ ...p, preset: q('#pf-preset').value, baseUrl: q('#pf-url').value.trim().replace(/\/$/, ''), apiKey: q('#pf-key').value.trim(), model: q('#pf-model').value.trim(), reasoning: q('#pf-reason').value, tools: q('#pf-tools').value, vision: q('#pf-vision').value, name: q('#pf-name').value.trim() });
      q('#pf-load').onclick = async () => {
        try {
          const models = await P.listModels(read());
          q('#pf-models').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
          if (!q('#pf-model').value && models[0]) q('#pf-model').value = models.find((m) => /qwen/i.test(m)) || models[0];
          toast(`${models.length} Modelle gefunden`);
          q('#pf-model').focus();
        } catch (e) { toast(esc(e.message), 'warn'); }
      };
      q('#pf-test').onclick = async () => {
        const out = q('#pf-test-out');
        const pr = read();
        if (!pr.model) { out.textContent = 'Bitte zuerst ein Modell angeben.'; return; }
        out.textContent = 'Teste … (beim ersten Mal lädt das Modell, das kann dauern)';
        try {
          const r = await P.testProfile(pr);
          const caps = await P.capabilities(pr);
          out.innerHTML = `<span style="color:var(--good)">✓ Verbunden</span> · ${(r.ms / 1000).toFixed(1).replace('.', ',')} s · Werkzeuge ${caps.tools ? '✓' : '✗'} · Bilder ${caps.vision ? '✓' : '✗'}${caps.known ? '' : ' (angenommen)'}`;
        } catch (e) { out.innerHTML = `<span style="color:var(--bad)">✗ ${esc(e.message)}</span>`; }
      };
      if (!p0 && p.preset === 'ollama') q('#pf-load').click();
    },
    actions: [
      { label: 'Abbrechen', kind: 'ghost' },
      { label: 'Speichern', kind: 'primary', onClick: (n) => {
        const q = (s) => n.querySelector(s);
        const np = { ...p, preset: q('#pf-preset').value, baseUrl: q('#pf-url').value.trim().replace(/\/$/, ''), apiKey: q('#pf-key').value.trim(), model: q('#pf-model').value.trim(), reasoning: q('#pf-reason').value, tools: q('#pf-tools').value, vision: q('#pf-vision').value, name: q('#pf-name').value.trim() };
        if (!np.model) { toast('Bitte ein Modell angeben', 'warn'); return false; }
        const saved = P.upsertProfile(np);
        if (!p0) P.setActive(saved.id);
        onDone?.();
      } },
    ],
  });
}
