// The icons of the app, drawn here so the repository needs no image tool: build/icon.png (512 px, the app icon
// electron-builder turns into .ico and .icns) and assets/tray/tray-<colour>-<16|32>.png (the tray, one per status
// colour: grey, amber, green, red). A minimal PNG writer (RGBA, deflate, CRC32) over a supersampled canvas.
//   node scripts/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buffer => { let c = -1; for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]); };

// rgba: Uint8Array of width*height*4.
export function encodePng(width, height, rgba) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 6; head[10] = 0; head[11] = 0; head[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// A canvas of `size` px rendered with `samples`x`samples` supersampling; shapes are functions (x, y in [0, 1]) -> [r,g,b,a] or null.
function render(size, shapes, samples = 4) {
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const x = (px + (sx + 0.5) / samples) / size; const y = (py + (sy + 0.5) / samples) / size;
      let colour = [0, 0, 0, 0];
      for (const shape of shapes) { const c = shape(x, y); if (c) colour = blend(colour, c); }
      r += colour[0] * colour[3]; g += colour[1] * colour[3]; b += colour[2] * colour[3]; a += colour[3];
    }
    const n = samples * samples;
    const i = (py * size + px) * 4;
    out[i] = a ? Math.round(r / a) : 0; out[i + 1] = a ? Math.round(g / a) : 0; out[i + 2] = a ? Math.round(b / a) : 0; out[i + 3] = Math.round((a / n) * 255);
  }
  return out;
}
const blend = (under, over) => { const a = over[3] + under[3] * (1 - over[3]); return a ? [(over[0] * over[3] + under[0] * under[3] * (1 - over[3])) / a, (over[1] * over[3] + under[1] * under[3] * (1 - over[3])) / a, (over[2] * over[3] + under[2] * under[3] * (1 - over[3])) / a, a] : [0, 0, 0, 0]; };
const disc = (cx, cy, radius, colour) => (x, y) => ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 ? colour : null);
const ring = (cx, cy, outer, inner, colour) => (x, y) => { const d = (x - cx) ** 2 + (y - cy) ** 2; return d <= outer ** 2 && d >= inner ** 2 ? colour : null; };
const roundedSquare = (inset, radius, colour) => (x, y) => { const lo = inset; const hi = 1 - inset; if (x < lo || x > hi || y < lo || y > hi) return null; const cx = Math.min(Math.max(x, lo + radius), hi - radius); const cy = Math.min(Math.max(y, lo + radius), hi - radius); return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 ? colour : null; };
// Continuous rounded S stroke, with generous padding inside the circular badge.
const curves = [
  [[.65,.30],[.57,.22],[.35,.23],[.35,.37]],
  [[.35,.37],[.35,.49],[.65,.48],[.65,.63]],
  [[.65,.63],[.65,.77],[.43,.79],[.34,.69]],
];
const stroke = curves.flatMap(points => Array.from({ length: 41 }, (_, i) => {
  const t = i / 40, q = 1 - t;
  return [0, 1].map(axis => q*q*q*points[0][axis] + 3*q*q*t*points[1][axis] + 3*q*t*t*points[2][axis] + t*t*t*points[3][axis]);
}));
const sMark = (colour, cx = .5, cy = .5, scale = 1) => (x, y) => {
  const u = (x-cx)/scale+.5, v = (y-cy)/scale+.5;
  if (u < .25 || u > .75 || v < .15 || v > .85) return null;
  for (let i=1; i<stroke.length; i++) {
    const [ax,ay]=stroke[i-1], [bx,by]=stroke[i];
    const dx=bx-ax, dy=by-ay;
    const t=Math.max(0,Math.min(1,((u-ax)*dx+(v-ay)*dy)/(dx*dx+dy*dy || 1)));
    if ((u-ax-t*dx)**2+(v-ay-t*dy)**2 <= .063**2) return colour;
  }
  return null;
};

const NAVY = [8, 8, 10, 1]; const WHITE = [231, 35, 54, 1];
const COLOURS = { grey: [154, 163, 178, 1], amber: [224, 161, 6, 1], green: [46, 158, 91, 1], red: [214, 69, 69, 1] };

function appIcon(size) {
  return encodePng(size, size, render(size, [disc(0.5, 0.5, 0.485, NAVY), sMark(WHITE, 0.5, 0.5, 1)], 4));
}
function trayIcon(size, colour) {
  // A navy disc with the S, and a status dot in the lower right corner.
  const shapes = [disc(0.44, 0.44, 0.42, NAVY), sMark(WHITE, 0.44, 0.44, 1), disc(0.78, 0.78, 0.2, [255, 255, 255, 1]), disc(0.78, 0.78, 0.15, colour)];
  return encodePng(size, size, render(size, shapes, 6));
}

fs.mkdirSync(path.join(app, 'build'), { recursive: true });
fs.mkdirSync(path.join(app, 'assets', 'tray'), { recursive: true });
fs.writeFileSync(path.join(app, 'build', 'icon.png'), appIcon(512));
for (const [name, colour] of Object.entries(COLOURS)) for (const size of [16, 32]) fs.writeFileSync(path.join(app, 'assets', 'tray', `tray-${name}-${size}.png`), trayIcon(size, colour));
console.log('icons written: build/icon.png and assets/tray/tray-{grey,amber,green,red}-{16,32}.png');
