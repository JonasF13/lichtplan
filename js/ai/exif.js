// ─────────────────────────────────────────────────────────────
// Minimaler EXIF-Leser für JPEG: GPS, Aufnahmezeit, Kamera, Brennweite
// ─────────────────────────────────────────────────────────────
export async function readExif(file) {
  try {
    const buf = await file.slice(0, 512 * 1024).arrayBuffer();
    const v = new DataView(buf);
    if (v.getUint16(0) !== 0xffd8) return null; // kein JPEG
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      if ((marker & 0xff00) !== 0xff00) break;
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
      off += 2 + len;
    }
  } catch { /* defekte Datei */ }
  return null;
}

function parseTiff(v, start) {
  const le = v.getUint16(start) === 0x4949;
  const u16 = (o) => v.getUint16(start + o, le);
  const u32 = (o) => v.getUint32(start + o, le);
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const val = (type, count, at) => {
    const total = (SIZE[type] || 1) * count;
    const o = total > 4 ? u32(at) : at;
    if (start + o + total > v.byteLength) return null;
    if (type === 2) { let s = ''; for (let i = 0; i < count; i++) { const c = v.getUint8(start + o + i); if (!c) break; s += String.fromCharCode(c); } return s.trim(); }
    const out = [];
    for (let i = 0; i < Math.min(count, 8); i++) {
      if (type === 3) out.push(u16(o + i * 2));
      else if (type === 4) out.push(u32(o + i * 4));
      else if (type === 9) out.push(v.getInt32(start + o + i * 4, le));
      else if (type === 5) { const b = u32(o + i * 8 + 4); out.push(b ? u32(o + i * 8) / b : 0); }
      else if (type === 10) { const b = v.getInt32(start + o + i * 8 + 4, le); out.push(b ? v.getInt32(start + o + i * 8, le) / b : 0); }
      else out.push(v.getUint8(start + o + i));
    }
    return count === 1 ? out[0] : out;
  };
  const ifd = (o) => {
    const res = {};
    if (!o || start + o + 2 > v.byteLength) return res;
    const n = u16(o);
    for (let i = 0; i < n && i < 200; i++) {
      const e = o + 2 + i * 12;
      if (start + e + 12 > v.byteLength) break;
      res[u16(e)] = val(u16(e + 2), u32(e + 4), e + 8);
    }
    return res;
  };
  const i0 = ifd(u32(4));
  const ex = ifd(i0[0x8769]);
  const gps = ifd(i0[0x8825]);
  const out = {};
  if (i0[0x010f] || i0[0x0110]) out.camera = [i0[0x010f], i0[0x0110]].filter(Boolean).join(' ').replace(/^(\w+) \1/i, '$1');
  if (ex[0xa434]) out.lens = ex[0xa434];
  if (ex[0x920a]) out.focal = Math.round(ex[0x920a]);
  if (ex[0xa405]) out.focal35 = ex[0xa405];
  if (ex[0x829d]) out.aperture = Math.round(ex[0x829d] * 10) / 10;
  if (ex[0x829a]) out.exposure = ex[0x829a] < 1 ? `1/${Math.round(1 / ex[0x829a])}` : `${ex[0x829a]}`;
  if (ex[0x8827]) out.iso = Array.isArray(ex[0x8827]) ? ex[0x8827][0] : ex[0x8827];
  const dt = ex[0x9003] || i0[0x0132];
  if (dt) {
    const m = dt.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/);
    if (m) { out.localTime = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`; out.offset = ex[0x9011] || null; }
  }
  const dms = (a) => (Array.isArray(a) ? a[0] + a[1] / 60 + a[2] / 3600 : null);
  const lat = dms(gps[2]), lng = dms(gps[4]);
  if (lat != null && lng != null && (lat || lng)) {
    out.lat = gps[1] === 'S' ? -lat : lat;
    out.lng = gps[3] === 'W' ? -lng : lng;
    if (gps[6] != null) out.altitude = Math.round(gps[6]);
    if (gps[0x11] != null) out.heading = Math.round(gps[0x11]);
  }
  return Object.keys(out).length ? out : null;
}

/** Text-Zusammenfassung für die KI */
export function exifSummary(x) {
  if (!x) return '';
  const p = [];
  if (x.lat != null) p.push(`GPS ${x.lat.toFixed(5)}, ${x.lng.toFixed(5)}${x.altitude != null ? ` (${x.altitude} m)` : ''}`);
  if (x.heading != null) p.push(`Blickrichtung ${x.heading}°`);
  if (x.localTime) p.push(`aufgenommen ${x.localTime.replace('T', ' ')}${x.offset ? ` (UTC${x.offset})` : ' (Ortszeit)'}`);
  if (x.focal) p.push(`Brennweite ${x.focal} mm${x.focal35 ? ` (KB ${x.focal35} mm)` : ''}`);
  if (x.aperture) p.push(`f/${x.aperture}`);
  if (x.exposure) p.push(`${x.exposure} s`);
  if (x.iso) p.push(`ISO ${x.iso}`);
  if (x.camera) p.push(x.camera);
  return p.join(' · ');
}

/** Bild verkleinern → JPEG-Data-URL (spart Tokens & Zeit) */
export async function imageToDataURL(file, max = 1280) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
