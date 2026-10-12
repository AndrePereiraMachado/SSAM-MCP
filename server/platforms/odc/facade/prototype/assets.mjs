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
    out.push({ path: relative, bundle: 'assets/' + hash + ext, mime: mimeOf(relative), bytes: data.length, sha256: hash, name, uses: [...set].sort(), data });
  }
  return out;
}
