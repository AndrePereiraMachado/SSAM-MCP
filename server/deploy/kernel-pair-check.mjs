// The image/kernel.json pair check of the interim image and of every rollback (multi-version design rev. 3, O.6.1 items
// 9-10, O.6.2). Dependency-free: it runs with the node INSIDE the image that is about to start, so it works for images
// without the ssam.kernels.* labels (prod-20261012-a857a1e) and for the interim:
//
//   docker run --rm --network none --entrypoint node -v "$PWD/kernel-pair-check.mjs:/c.mjs:ro" \
//     -v /tmp/kernel.json:/k.json:ro ssam-server:<tag> /c.mjs check /k.json
//       reads the FileVersion of every ServiceStudio.Framework.dll under /studio/o11 and /studio/odc (depth <= 2) and
//       exits 0 when kernel.json's o11 and odc (three numbers) are among the image's, 2 when a lane is not ("refused-pair":
//       start nothing), 1 on a usage or read error. Prints one JSON line.
//   docker run --rm --network none --entrypoint node -v "$PWD/kernel-pair-check.mjs:/c.mjs:ro" \
//     -v "$PWD/release-record.json:/r.json:ro" ssam-server:<tag> /c.mjs print <released|previous|<tag>> /r.json
//       prints the kernel.json v1 of that image from the release record (release-record.json), never typed by hand.
//
// A rollback writes kernel.json from the record of the image it restores, checks the pair inside that image, empties the
// legacy O11 caches and only then runs `up -d` (DEPLOY.md 8). The PE reader is the one of the server line
// (platforms/odc/facade/kernel-image.mjs peFileVersion); tests/kernel-pair-check.test.mjs keeps both readers equal.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const threePart = value => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '').trim()); return m ? m[1] + '.' + m[2] + '.' + m[3] : null; };

export function peFileVersion(bytes) {
  try {
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (b.length < 0x40 || b.readUInt16LE(0) !== 0x5a4d) return null;
    const pe = b.readUInt32LE(0x3c);
    if (pe + 24 > b.length || b.readUInt32LE(pe) !== 0x4550) return null;
    const sections = b.readUInt16LE(pe + 6), optionalSize = b.readUInt16LE(pe + 20), optional = pe + 24;
    const magic = b.readUInt16LE(optional);
    const directories = optional + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN);
    if (!Number.isFinite(directories) || b.readUInt32LE(optional + (magic === 0x20b ? 108 : 92)) < 3) return null;
    const resourceRva = b.readUInt32LE(directories + 16);
    if (!resourceRva) return null;
    const table = optional + optionalSize;
    const offsetOf = rva => {
      for (let i = 0; i < sections; i++) {
        const s = table + i * 40, va = b.readUInt32LE(s + 12), size = Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16)), raw = b.readUInt32LE(s + 20);
        if (rva >= va && rva < va + size) return rva - va + raw;
      }
      return -1;
    };
    const root = offsetOf(resourceRva);
    if (root < 0) return null;
    const entries = dir => {
      const count = b.readUInt16LE(dir + 12) + b.readUInt16LE(dir + 14), out = [];
      for (let i = 0; i < count; i++) out.push({ id: b.readUInt32LE(dir + 16 + i * 8), to: b.readUInt32LE(dir + 20 + i * 8) });
      return out;
    };
    const sub = entry => (entry && entry.to & 0x80000000 ? root + (entry.to & 0x7fffffff) : -1);
    const names = sub(entries(root).find(e => e.id === 16));
    if (names < 0) return null;
    const langs = sub(entries(names)[0]);
    if (langs < 0) return null;
    const leaf = entries(langs)[0];
    if (!leaf || leaf.to & 0x80000000) return null;
    const data = offsetOf(b.readUInt32LE(root + leaf.to)), size = b.readUInt32LE(root + leaf.to + 4);
    if (data < 0) return null;
    const at = b.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]), data);
    if (at < 0 || at + 24 > Math.min(b.length, data + size)) return null;
    const four = (ms, ls) => [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
    return { file: four(b.readUInt32LE(at + 8), b.readUInt32LE(at + 12)), product: four(b.readUInt32LE(at + 16), b.readUInt32LE(at + 20)) };
  } catch { return null; }
}

// The FileVersions of ServiceStudio.Framework.dll under <root> and one folder level below it (depth <= 2), so the
// multi-version layout /studio/o11/<v>/ is read too.
export function studioVersions(root) {
  const found = [];
  const look = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of names) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'ServiceStudio.Framework.dll') {
        try { const v = peFileVersion(fs.readFileSync(full))?.file; if (v) found.push(v); } catch { /* unreadable: not counted */ }
      } else if (entry.isDirectory() && depth < 2) look(full, depth + 1);
    }
  };
  look(root, 1);
  return [...new Set(found)].sort();
}

export function checkPair(kernel, { studioRoot = '/studio' } = {}) {
  const lanes = {};
  let ok = true;
  for (const lane of ['o11', 'odc']) {
    const pinned = threePart(kernel?.[lane]);
    const image = studioVersions(path.join(studioRoot, lane));
    const match = !!pinned && image.some(v => threePart(v) === pinned);
    if (!match) ok = false;
    lanes[lane] = { kernel: pinned, image, ok: match };
  }
  return { ok, status: ok ? 'pair-ok' : 'refused-pair', ...lanes };
}

export function recordEntry(record, which) {
  if (which === 'released' || which === 'previous') return record?.[which] ?? null;
  return record?.images?.[which] ?? (record?.released?.tag === which ? record.released : record?.previous?.tag === which ? record.previous : null);
}

export function main(argv, { out = process.stdout, err = process.stderr, studioRoot = '/studio' } = {}) {
  const [verb, ...rest] = argv;
  try {
    if (verb === 'check' && rest.length === 1) {
      const kernel = JSON.parse(fs.readFileSync(rest[0], 'utf8').replace(/^\uFEFF/, ''));
      if (kernel && typeof kernel === 'object' && ['schema', 'default', 'served'].some(k => Object.hasOwn(kernel, k))) {
        out.write(JSON.stringify({ ok: false, status: 'refused-pair', reason: 'kernel.json v1 only (this file has the v2 shape)' }) + '\n');
        return 2;
      }
      const result = checkPair(kernel, { studioRoot });
      out.write(JSON.stringify(result) + '\n');
      return result.ok ? 0 : 2;
    }
    if (verb === 'print' && rest.length === 2) {
      const entry = recordEntry(JSON.parse(fs.readFileSync(rest[1], 'utf8').replace(/^\uFEFF/, '')), rest[0]);
      if (!entry?.kernelV1) { err.write('no kernelV1 for ' + rest[0] + ' in the release record\n'); return 1; }
      out.write(JSON.stringify(entry.kernelV1) + '\n');
      return 0;
    }
  } catch (error) { err.write('kernel-pair-check: ' + (error?.message ?? error) + '\n'); return 1; }
  err.write('usage: node kernel-pair-check.mjs check <kernel.json> | print <released|previous|<tag>> <release-record.json>\n');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
