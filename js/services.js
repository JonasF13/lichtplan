// ─────────────────────────────────────────────────────────────
// Netzwerkdienste (alle ohne API-Key): Suche, Höhe, Zeitzone, Wetter
//  · Nominatim (OpenStreetMap) für Suche/Ortsnamen
//  · Open-Meteo für Höhe, Zeitzone und Wolken-Vorhersage
// ─────────────────────────────────────────────────────────────

const cache = new Map();
async function getJSON(url, ttl = 3600e3) {
  const c = cache.get(url);
  if (c && Date.now() - c.t < ttl) return c.v;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const v = await r.json();
  cache.set(url, { t: Date.now(), v });
  return v;
}

export async function searchPlaces(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=7&accept-language=de&q=${encodeURIComponent(q)}`;
  const res = await getJSON(url);
  return res.map((r) => ({ name: r.name || r.display_name.split(',')[0], label: r.display_name, lat: +r.lat, lng: +r.lon, type: r.type }));
}

export async function reverseName(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&accept-language=de&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`;
    const r = await getJSON(url, 864e5);
    const a = r.address || {};
    const main = r.name || a.peak || a.tourism || a.road || a.hamlet || a.village || a.suburb || a.town || a.city || '';
    const place = a.village || a.town || a.city || a.municipality || a.county || '';
    const country = a.country_code ? a.country_code.toUpperCase() : '';
    return { name: main || place || 'Unbenannter Ort', place: [place !== main ? place : '', country].filter(Boolean).join(', ') };
  } catch { return null; }
}

/** Höhe (m) für mehrere Punkte */
export async function elevations(points) {
  const lat = points.map((p) => p.lat.toFixed(5)).join(',');
  const lng = points.map((p) => p.lng.toFixed(5)).join(',');
  const r = await getJSON(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`, 864e5 * 30);
  return r.elevation;
}

/** Zeitzone + Höhe + stündliche Bewölkung (16 Tage) */
export async function forecast(lat, lng) {
  const la = lat.toFixed(2), lo = lng.toFixed(2);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&timezone=auto&forecast_days=16` +
    `&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,visibility,temperature_2m,wind_speed_10m,relative_humidity_2m`;
  const r = await getJSON(url, 1800e3);
  return {
    tz: r.timezone, elevation: r.elevation,
    utcOffset: r.utc_offset_seconds,
    hourly: r.hourly,
  };
}

/** Zeitzone für Koordinaten (leichtgewichtig, gecached) */
export async function timezoneAt(lat, lng) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lng.toFixed(2)}&timezone=auto&forecast_days=1&current=temperature_2m`;
  const r = await getJSON(url, 864e5 * 7);
  return r.timezone;
}
