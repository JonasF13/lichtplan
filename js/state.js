// ─────────────────────────────────────────────────────────────
// App-Zustand (Standort, Zeit, Ziel, aktive Auswahl) + Events
// ─────────────────────────────────────────────────────────────
import { deviceTz } from './utils.js';
import { prefs } from './store.js';

const last = prefs.get('last');
export const state = {
  lat: last?.lat ?? 47.0707,
  lng: last?.lng ?? 15.4395,
  elev: last?.elev ?? 0,
  tz: last?.tz ?? deviceTz,
  placeName: last?.placeName ?? '',
  time: new Date(),
  target: null,          // { lat, lng, elev }
  targetMode: false,
  view: 'map',
  activeProjectId: null,
  activeSpotId: null,
  weather: null,
};

const listeners = new Set();
export function onState(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function setState(patch) {
  const changed = new Set();
  for (const [k, v] of Object.entries(patch)) {
    if (state[k] !== v) { state[k] = v; changed.add(k); }
  }
  if (!changed.size) return;
  if (changed.has('lat') || changed.has('lng') || changed.has('tz') || changed.has('elev') || changed.has('placeName')) {
    prefs.set('last', { lat: state.lat, lng: state.lng, elev: state.elev, tz: state.tz, placeName: state.placeName, zoom: prefs.get('last')?.zoom });
  }
  listeners.forEach((f) => f(changed));
}
