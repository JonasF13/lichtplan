// ─────────────────────────────────────────────────────────────
// Layout: Handy · Tablet/Duo · Desktop – wechselt automatisch
//  · phone   (iPhone, iPhone Duo zugeklappt): Tab-Leiste unten, je ein Bildschirm
//  · tablet  (iPhone Duo aufgeklappt, iPad hochkant, kleine Fenster): Symbolleiste links + Panel + Hauptansicht
//  · desktop (Mac, iPad quer): drei Spalten
// ─────────────────────────────────────────────────────────────
import { $, $$, debounce } from './utils.js';

let api = {};
let lastStageView = 'map';

export function computeLayout() {
  const w = innerWidth, h = innerHeight, min = Math.min(w, h);
  if (w >= 1100 && h >= 600) return 'desktop';
  if (w >= 600 && min >= 540) return 'tablet';
  return 'phone';
}
export const layout = () => document.body.dataset.layout;
export const isTouch = () => matchMedia('(pointer: coarse)').matches;

export function initLayout(a) {
  api = a; // { setView, showTab, openAI, closeAI, aiOpen, openSettings, invalidateMap }
  document.body.dataset.screen ||= 'map';
  document.body.dataset.panel ||= 'projects';
  apply();
  addEventListener('resize', debounce(apply, 80));
  screen.orientation?.addEventListener?.('change', () => setTimeout(apply, 150));
  // Handy: Tab-Leiste unten
  $$('#mobile-nav [data-screen]').forEach((b) => b.addEventListener('click', () => setScreen(b.dataset.screen)));
  // Tablet: Symbolleiste links
  $$('#rail [data-rail]').forEach((b) => b.addEventListener('click', () => railClick(b.dataset.rail)));
  // Info-Reiter am Handy: wischen zum Wechseln
  swipeTabs($('#inspector .insp-body'));
  updateRail();
  new ResizeObserver(updateStage).observe(document.getElementById('stage'));
}

function updateStage() {
  const w = document.getElementById('stage')?.getBoundingClientRect().width || innerWidth;
  document.body.classList.toggle('compact-stage', layout() === 'phone' || w < 660);
}
function apply() {
  const l = computeLayout();
  const prev = document.body.dataset.layout;
  document.body.dataset.layout = l;
  document.body.classList.toggle('touch', isTouch());
  if (prev !== l) {
    if (l === 'phone' && ['stars', 'ar'].includes(document.body.dataset.view)) document.body.dataset.screen = document.body.dataset.view === 'ar' ? 'live' : 'stars';
    setTimeout(() => api.invalidateMap?.(), 60);
  }
  updateNav();
  updateStage();
}

// ── Handy-Bildschirme ───────────────────────────────────────
export function setScreen(s) {
  const body = document.body;
  if (s === 'ai') { body.dataset.screen = 'info'; api.openAI?.(); updateNav(); return; }
  body.dataset.screen = s;
  if (s === 'map') api.setView?.(['map', 'sv', 'sky'].includes(lastStageView) ? lastStageView : 'map');
  if (s === 'stars') api.setView?.('stars');
  if (s === 'live') api.setView?.('ar');
  if (s === 'info' && api.aiOpen?.()) api.closeAI?.();
  updateNav();
  if (s === 'map') setTimeout(() => api.invalidateMap?.(), 60);
}
/** Merkt sich die zuletzt genutzte Kartenansicht (Karte/Street View/Himmel) */
export function noteView(v) {
  if (['map', 'sv', 'sky'].includes(v)) lastStageView = v;
  if (layout() === 'phone') {
    const want = v === 'stars' ? 'stars' : v === 'ar' ? 'live' : ['map', 'sv', 'sky'].includes(v) ? 'map' : null;
    if (want && ['map', 'stars', 'live'].includes(document.body.dataset.screen)) { document.body.dataset.screen = want; updateNav(); }
  }
}
function updateNav() {
  const s = document.body.dataset.screen;
  const ai = api.aiOpen?.();
  $$('#mobile-nav [data-screen]').forEach((b) => b.classList.toggle('active', b.dataset.screen === s && !(s === 'info' && ai && b.dataset.screen !== 'info')));
}

// ── Tablet-Symbolleiste ─────────────────────────────────────
const INFO_TABS = ['light', 'moon', 'night', 'plan', 'weather', 'tides'];
let railActive = 'projects';
function railClick(r) {
  const body = document.body;
  if (r === 'settings') { api.openSettings?.(); return; }
  // erneuter Klick auf aktives Symbol klappt das Panel ein/aus
  if (r === railActive && body.dataset.panel !== 'none') { body.dataset.panel = 'none'; updateRail(); setTimeout(() => api.invalidateMap?.(), 220); return; }
  railActive = r;
  if (r === 'projects') { body.dataset.panel = 'projects'; }
  else if (r === 'ai') { body.dataset.panel = 'info'; api.openAI?.(); }
  else if (INFO_TABS.includes(r)) { body.dataset.panel = 'info'; api.closeAI?.(); api.showTab?.(r); }
  updateRail();
  setTimeout(() => api.invalidateMap?.(), 220);
}
function updateRail() {
  const p = document.body.dataset.panel;
  $$('#rail [data-rail]').forEach((b) => b.classList.toggle('active', p !== 'none' && b.dataset.rail === railActive));
}

/** Von außen: „zeige Projekte / Infos / KI“ – passend zum Layout */
export function go(where, tab) {
  const l = layout();
  if (l === 'phone') {
    if (where === 'projects') setScreen('projects');
    else if (where === 'ai') setScreen('ai');
    else if (where === 'info') { setScreen('info'); if (tab) api.showTab?.(tab); }
    else if (where === 'map') setScreen('map');
  } else if (l === 'tablet') {
    if (where === 'projects') { railActive = 'projects'; document.body.dataset.panel = 'projects'; }
    else if (where === 'ai') { railActive = 'ai'; document.body.dataset.panel = 'info'; api.openAI?.(); }
    else if (where === 'info') { railActive = tab || 'light'; document.body.dataset.panel = 'info'; if (tab) api.showTab?.(tab); }
    updateRail();
    setTimeout(() => api.invalidateMap?.(), 220);
  } else if (where === 'ai') api.openAI?.();
  else if (where === 'info' && tab) api.showTab?.(tab);
}
/** Aktiver Info-Reiter (für die Symbolleiste) */
export function noteTab(tab) { if (INFO_TABS.includes(tab) && document.body.dataset.panel === 'info') { railActive = tab; updateRail(); } }

// ── Wischen zwischen Info-Reitern (Handy) ───────────────────
function swipeTabs(el) {
  if (!el) return;
  let x0 = null, y0 = null;
  el.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 == null || layout() !== 'phone') return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    if (e.target.closest('input, .ph-strip, .wchart, canvas, .tbl')) return;
    const tabs = $$('#insp-tabs button').map((b) => b.dataset.tab);
    const cur = $('#insp-tabs button.active')?.dataset.tab;
    const i = tabs.indexOf(cur);
    const next = tabs[i + (dx < 0 ? 1 : -1)];
    if (next) api.showTab?.(next);
  });
}
