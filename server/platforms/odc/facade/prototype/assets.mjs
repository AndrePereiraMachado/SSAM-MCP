// Images and other files referenced by the prototype (docs/PROTOTIPO-NATIVO.md 2.9): img[src], url(...) in CSS and in
// style attributes, srcset, local @font-face sources. A file of source becomes an asset with sha256, mime, bytes and its
// uses; an external URL stays as it is. Sprites are nothing special: the file is an asset, the tiles stay in the CSS.
import path from 'node:path';
import { attr, isElement, sha256, walk } from './ir.mjs';
import { mimeOf } from './network.mjs';
import { cssUrls, localReference } from './css-inventory.mjs';
import { pascal } from './names.mjs';

function addUse(map, relative, use) {
  if (!relative) return;
  if (!map.has(relative)) map.set(relative, new Set());
  map.get(relative).add(use);
}

// The type of an image by its first bytes (a JPEG saved as .png is a JPEG): the mime the asset carries; null when the bytes
// are no known image (the extension decides, as before).
export function imageMime(data) {
  if (!data || data.length < 4) return null;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp';
  if (data[0] === 0 && data[1] === 0 && data[2] === 1 && data[3] === 0) return 'image/x-icon';
  if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(data.subarray(0, 4096).toString('utf8').replace(/^﻿/, ''))) return 'image/svg+xml';
  return null;
}

export function collectAssets({ sheets, trees, readBytes, page = null }) {
  const uses = new Map();
  for (const sheet of sheets) for (const url of sheet.urls ?? []) addUse(uses, url.asset, /\.(woff2?|ttf|otf|eot)$/i.test(url.raw) ? 'font' : 'css');
  for (const tree of trees) {
    walk(tree, node => {
      if (!isElement(node)) return;
      const base = page ? path.posix.dirname(page) : '';
      const resolve = raw => localReference(raw, base ? base + '/x' : null);
      if (node.t === 'img' || node.t === 'source' || node.t === 'video' || node.t === 'audio') {
        const src = attr(node, 'src');
        if (src) addUse(uses, resolve(src), 'img');
        const srcset = attr(node, 'srcset');
        if (srcset) for (const part of srcset.split(',')) addUse(uses, resolve(part.trim().split(/\s+/)[0]), 'img');
      }
      const style = attr(node, 'style');
      if (style) for (const raw of cssUrls(style)) addUse(uses, resolve(raw), 'style');
    });
  }
  const out = [];
  const taken = new Set();
  for (const [relative, set] of [...uses.entries()].sort(([a], [b]) => a < b ? -1 : 1)) {
    const data = readBytes(relative);
    if (!data) continue;
    const hash = sha256(data);
    const ext = path.posix.extname(relative).toLowerCase();
    let name = pascal(path.posix.basename(relative, ext)) || 'Asset';
    let n = 2;
    while (taken.has(name)) name = pascal(path.posix.basename(relative, ext)) + n++;
    taken.add(name);
    out.push({ path: relative, bundle: 'assets/' + hash + ext, mime: imageMime(data) ?? mimeOf(relative), bytes: data.length, sha256: hash, name, uses: [...set].sort(), data });
  }
  return out;
}
