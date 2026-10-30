// A stand-in for the render worker (src/main/render/worker.mjs): `node fake-renderer.mjs <mode> --ssam-render-worker`,
// the request on its standard input, one line of facts on its standard output. Modes:
//   success   facts for every document and viewport, with "text" and "innerText" fields the agent must drop, and a
//             small JPEG per viewport when the request asks for images; it also writes a file in its TEMP;
//   slow      success after 800 ms;  sleep  never answers;  crash  exits with code 3;  large  writes 21 MiB;
//   unknown   an element whose key the request did not ask for;  big-image  a JPEG above 1 MiB;
//   many      3000 elements with long style values (a value above the inline limit);  env  reports
//             ELECTRON_RUN_AS_NODE in engine.version.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const mode = process.argv[2];
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (!process.argv.includes('--ssam-render-worker')) process.exit(9);
if (mode === 'crash') process.exit(3);
if (mode === 'sleep') setInterval(() => {}, 1000);
else {
  if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 800));
  if (mode === 'large') { process.stdout.write('x'.repeat(21 * 1024 * 1024)); process.exit(0); }
  try { fs.writeFileSync(path.join(process.env.TEMP ?? process.env.TMPDIR ?? '.', 'profile.txt'), 'chromium profile'); } catch { /* no TEMP */ }
  const jpeg = size => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, size - 4), 7)]);
  const images = [];
  const keys = request.probes?.keys === 'all' || !request.probes?.keys ? ['a1', 'b2'] : request.probes.keys;
  const count = mode === 'many' ? 3000 : keys.length;
  const facts = { schema: 'ssam-render-facts/1', engine: { name: 'electron', version: mode === 'env' ? String(process.env.ELECTRON_RUN_AS_NODE ?? 'none') : '44.9.2', chromium: '146.0.0.0', protocol: 1 },
    documents: request.documents.map(document => ({ id: document.id, sha256: document.sha256, text: 'SECRET-SCREEN-TEXT',
      viewports: request.viewports.map(viewport => {
        let image = null;
        if (request.image) {
          const bytes = jpeg(mode === 'big-image' ? 1024 * 1024 + 1 : 600);
          image = images.length;
          images.push({ document: document.id, viewport: viewport.name, mime: 'image/jpeg', width: Math.min(viewport.width, request.image.maxEdge),
            height: Math.min(viewport.height, request.image.maxEdge), sha256: createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') });
        }
        return { name: viewport.name, width: viewport.width, height: viewport.height, ms: 12.4, page: { scrollWidth: viewport.width, scrollHeight: 2140, overflowX: false },
          fonts: { missing: ['Roboto'] }, innerText: 'SECRET-SCREEN-TEXT',
          elements: Array.from({ length: count }, (_, i) => ({ k: mode === 'unknown' && i === 0 ? 'zz' : keys[i % keys.length], box: [16, 64 + i, 300.5, 40], visible: true,
            coveredBy: viewport.name === 'tablet' ? { k: null, tag: 'div', classes: ['app-menu-content'] } : null, clippedBy: null, lines: 2, textLength: 18, overflowX: false,
            text: 'SECRET-SCREEN-TEXT', innerText: 'SECRET-SCREEN-TEXT',
            styles: Object.fromEntries([...(request.probes?.properties ?? []), 'content'].map(name => [name, mode === 'many' ? 'v'.repeat(300) : 'normal'])) })),
          truncated: false, image };
      }), errors: [] })), images };
  process.stdout.write(JSON.stringify(facts) + '\n', () => process.exit(0));
}
