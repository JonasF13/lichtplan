// ─────────────────────────────────────────────────────────────
// „Mit Mac verbinden“ – den QR-Code vom Mac direkt IN der App scannen
// (oder den kopierten Link einfügen).
//
// Warum in der App? Am iPhone/iPad hat eine App am Home-Bildschirm einen
// eigenen Speicher, getrennt von Safari. Ein mit der Kamera-App geöffneter
// Link richtet nur Safari ein – die Home-Bildschirm-App bliebe leer.
// ─────────────────────────────────────────────────────────────
import { modal } from './ui.js';
import { icon, esc } from './utils.js';
import { parseSetupText } from './sync.js';

export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => !!window.SpeculaNative || navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; // SpeculaNative = echte iPhone-App

/**
 * Öffnet den Verbinden-Dialog.
 * @param {{ apply: (cfg) => Promise<void>|void }} opts  apply übernimmt die Einrichtung (Sync + Google-Key)
 */
export function openPairing({ apply }) {
  let stream = null, timer = 0, stopped = false, busy = false, lastHint = 0;
  let detector = null, jsQR = null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const { node, close } = modal({
    title: 'Mit Mac verbinden',
    body: `
      <p class="pair-lead">Am Mac in Specula: <b>⚙︎ Einstellungen → Synchronisierung → iPhone verbinden</b>. Dann den QR-Code hier in den Rahmen halten.</p>
      <div class="pair-cam">
        <video id="pair-video" playsinline muted autoplay></video>
        <div class="pair-frame"><i></i><i></i><i></i><i></i></div>
        <div class="pair-msg" id="pair-msg">${icon('camera')}Kamera wird gestartet …</div>
      </div>
      <details class="pair-paste" id="pair-paste">
        <summary>Ohne Kamera: Link einfügen</summary>
        <p class="muted small">Am Mac im QR-Fenster auf <b>Link kopieren</b> klicken. Über die Apple-Zwischenablage kannst du ihn hier einsetzen.</p>
        <div class="pair-row">
          <input id="pair-text" placeholder="https://…#lp-setup=…" autocomplete="off" autocapitalize="off" spellcheck="false">
          <button type="button" class="btn sm" id="pair-clip">${icon('copy')}Einfügen</button>
        </div>
        <div class="pair-out small" id="pair-out"></div>
        <button type="button" class="btn sm primary" id="pair-go">${icon('sync')}Verbinden</button>
      </details>`,
    actions: [{ label: 'Abbrechen', kind: 'ghost' }],
  });
  node.querySelector('.modal')?.classList.add('pair-modal');
  const video = node.querySelector('#pair-video');
  const msg = (html, cls = '') => { const m = node.querySelector('#pair-msg'); if (m) { m.className = `pair-msg ${cls}`; m.innerHTML = html; } };
  const out = (text, cls = 'bad') => { const o = node.querySelector('#pair-out'); if (o) { o.className = `pair-out small ${cls}`; o.textContent = text; } };

  function stop() {
    stopped = true;
    clearTimeout(timer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  // Der Dialog kennt kein „onClose“ → beim Schließen (×, Esc, Abbrechen, daneben tippen) Kamera stoppen
  const mo = new MutationObserver(() => { if (!node.isConnected || node.classList.contains('out')) { stop(); mo.disconnect(); } });
  mo.observe(node, { attributes: true, attributeFilter: ['class'] });
  mo.observe(node.parentNode || document.body, { childList: true });

  /** Gefundenen Text prüfen; true = erledigt */
  function handle(text, fromPaste = false) {
    const cfg = parseSetupText(text);
    if (!cfg) {
      const t = 'Das ist kein Specula-Verbindungscode. Am Mac bitte unter Einstellungen → Synchronisierung auf „iPhone verbinden“ klicken.';
      if (fromPaste) out(t); else if (Date.now() - lastHint > 2500) { lastHint = Date.now(); msg(esc(t), 'warn'); }
      return false;
    }
    if (cfg.invalid || (!cfg.sync && !cfg.gmapsKey)) {
      const t = 'Der Code ist unvollständig oder beschädigt. Am Mac den QR-Code bitte neu öffnen.';
      if (fromPaste) out(t); else msg(esc(t), 'warn');
      return false;
    }
    stop();
    navigator.vibrate?.(40);
    msg(`${icon('check')}Code erkannt – verbinde …`, 'ok');
    setTimeout(() => { close(); apply(cfg); }, 250);
    return true;
  }

  async function detect() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    if (detector) {
      try { const r = await detector.detect(video); return r?.[0]?.rawValue || null; } catch { detector = null; }
    }
    if (!jsQR) return null;
    // Mittleres Quadrat (dort liegt der Rahmen) – genug Auflösung auch für dichte Codes
    const s = Math.min(vw, vh), size = Math.min(s, 960);
    canvas.width = canvas.height = size;
    ctx.drawImage(video, (vw - s) / 2, (vh - s) / 2, s, s, 0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    const r = jsQR(img.data, size, size, { inversionAttempts: 'attemptBoth' });
    return r?.data || null;
  }

  async function tick() {
    if (stopped) return;
    if (!busy && video.readyState >= 2) {
      busy = true;
      try { const t = await detect(); if (t && handle(t)) return; } catch (e) { console.warn('QR', e); }
      busy = false;
    }
    timer = setTimeout(tick, 160);
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      msg(`${icon('camera')}Diese Ansicht hat keinen Kamerazugriff – nutze unten „Link einfügen“.`, 'warn');
      node.querySelector('#pair-paste').open = true;
      return;
    }
    try {
      // Native Erkennung, falls vorhanden – sonst jsQR (wird nur hier geladen)
      if ('BarcodeDetector' in window) {
        try { const f = await window.BarcodeDetector.getSupportedFormats?.(); if (!f || f.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
      }
      const lib = import('../vendor/jsqr.esm.js').then((m) => { jsQR = m.default; }).catch(() => {});
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;
      await video.play().catch(() => {});
      await lib;
      if (!detector && !jsQR) throw new Error('QR-Leser konnte nicht geladen werden');
      msg(`${icon('qr')}QR-Code vom Mac in den Rahmen halten`);
      tick();
    } catch (e) {
      const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
      msg(denied
        ? `${icon('camera')}Kein Kamerazugriff erlaubt. Am iPhone: <b>Einstellungen → Apps → Safari → Kamera → Fragen</b>, dann nochmal öffnen – oder unten den Link einfügen.`
        : `${icon('camera')}Kamera nicht verfügbar (${esc(e?.message || e?.name || 'Fehler')}). Nutze unten „Link einfügen“.`, 'warn');
      node.querySelector('#pair-paste').open = true;
    }
  }

  // ── Link einfügen ──
  const input = node.querySelector('#pair-text');
  node.querySelector('#pair-clip').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t) return out('Die Zwischenablage ist leer. Am Mac zuerst „Link kopieren“ klicken.');
      input.value = t.trim();
      handle(input.value, true);
    } catch { out('Einfügen nicht erlaubt – tippe lange ins Feld und wähle „Einsetzen“.', 'info'); input.focus(); }
  };
  node.querySelector('#pair-go').onclick = () => { if (!input.value.trim()) return out('Bitte zuerst den Link einfügen.'); handle(input.value.trim(), true); };
  input.addEventListener('paste', () => setTimeout(() => { if (input.value.includes('lp-setup=')) handle(input.value.trim(), true); }, 30));

  start();
  return { close };
}
