// ─────────────────────────────────────────────────────────────
// UI-Bausteine: Modal, Bestätigung, Toast, Menü
// ─────────────────────────────────────────────────────────────
import { $, icon, el, esc } from './utils.js';

export function modal({ title, body, actions = [], wide = false, onOpen }) {
  const root = $('#modal-root');
  const node = el(`
    <div class="modal-backdrop">
      <div class="modal glass ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <header><h2>${esc(title)}</h2><button class="icon-btn sm close" title="Schließen">${icon('close')}</button></header>
        <div class="modal-body"></div>
        <footer></footer>
      </div>
    </div>`);
  const bodyEl = node.querySelector('.modal-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
  const footer = node.querySelector('footer');
  const close = () => { node.classList.add('out'); setTimeout(() => node.remove(), 160); document.removeEventListener('keydown', onKey); };
  actions.forEach((a) => {
    const b = el(`<button class="btn ${a.kind || ''}">${a.icon ? icon(a.icon) : ''}${esc(a.label)}</button>`);
    b.onclick = async () => { const r = await a.onClick?.(node); if (r !== false) close(); };
    footer.appendChild(b);
  });
  if (!actions.length) footer.remove();
  node.querySelector('.close').onclick = close;
  node.addEventListener('mousedown', (e) => { if (e.target === node) close(); });
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) footer?.querySelector('.btn.primary')?.click();
  };
  document.addEventListener('keydown', onKey);
  root.appendChild(node);
  requestAnimationFrame(() => node.classList.add('in'));
  onOpen?.(node);
  setTimeout(() => node.querySelector('[autofocus]')?.focus(), 50);
  return { node, close };
}

export function confirmDialog(title, text, okLabel = 'Löschen', danger = true) {
  return new Promise((res) => {
    modal({
      title, body: `<p>${text}</p>`,
      actions: [
        { label: 'Abbrechen', kind: 'ghost', onClick: () => res(false) },
        { label: okLabel, kind: danger ? 'danger' : 'primary', onClick: () => res(true) },
      ],
    });
  });
}

export function toast(msg, kind = '') {
  const t = el(`<div class="toast glass ${kind}">${msg}</div>`);
  $('#toast-root').appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, 2600);
}

/** Kontextmenü an Position (x,y relativ zum Viewport) */
export function menu(x, y, items) {
  document.querySelectorAll('.pop-menu').forEach((m) => m.remove());
  const m = el(`<div class="pop-menu dropdown glass"></div>`);
  items.filter(Boolean).forEach((it) => {
    if (it === '-') { m.appendChild(el('<div class="sep"></div>')); return; }
    const b = el(`<button class="${it.danger ? 'danger' : ''}">${it.icon ? icon(it.icon) : ''}<span>${esc(it.label)}</span></button>`);
    b.onclick = (e) => { e.stopPropagation(); m.remove(); it.onClick(); };
    m.appendChild(b);
  });
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  setTimeout(() => document.addEventListener('mousedown', function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } }), 0);
  return m;
}
