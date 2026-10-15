// The shapes of a prototype source that failed the independent check of 2026-10-13 (C:\t\imp-vc\RESULTADO.md findings):
// zip names in CP850/CP1252 without the UTF-8 flag, pages only in subfolders (a Mac zip with __MACOSX/, outer/inner/, v1/ and
// v2/), a zip inside the zip, a CDN script with no network (its mapping.vendor patch needs the file first), a missing local
// stylesheet or .jsx, a %-encoded image reference, a JPEG saved as .png, a page error that escapes every handler, and a build
// the Verify refused with no code. Each one answers with a typed refusal (with the patch when one exists) or is imported.
import './fixtures/isolated-profile.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolveSource, expandPrototypeOps, untypedBuildRefusal } from '../prototype-op.mjs';
import { readArchive, archiveRoot, htmlPages, innerArchive } from '../prototype/archive.mjs';
import { capturePrototype, closeResidentPools, renderProblems, similarFiles } from '../prototype/capture.mjs';
import { localReference } from '../prototype/css-inventory.mjs';
import { collectAssets, imageMime } from '../prototype/assets.mjs';
import { measureFidelity } from '../prototype/fidelity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BABEL = path.join(here, 'fixtures', 'prototype', 'react-babel', 'babel.min.js');
const clock = '2026-10-10T21:00:00Z';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-proto-shapes-'));
after(() => { closeResidentPools(); fs.rmSync(root, { recursive: true, force: true }); });
let n = 0;
const fresh = () => { const dir = path.join(root, 'c' + n++); fs.mkdirSync(dir, { recursive: true }); return dir; };
const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };

// A zip writer: entries [{name, data, nameBytes?, utf8?}] (deflate; utf8 false writes the name bytes with no UTF-8 flag).
function zip(entries) {
  const locals = []; const central = []; let offset = 0;
  for (const entry of entries) {
    const name = entry.nameBytes ?? Buffer.from(entry.name, 'utf8');
    const flag = entry.utf8 === false ? 0 : 0x800;
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const body = zlib.deflateRawSync(raw); const crc = zlib.crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flag, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x5b4c, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(flag, 8); head.writeUInt16LE(8, 10);
    head.writeUInt16LE(0x5b4c, 14); head.writeUInt32LE(crc, 16); head.writeUInt32LE(body.length, 20); head.writeUInt32LE(raw.length, 24); head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(0x20, 38); head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
const PAGE = (title, head = '', body = '<main><h1>Loja</h1><p>Item</p></main>') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
const CSS = 'body{margin:0;font-family:Arial}main{padding:12px}';
const MINI = [{ name: 'app.html', data: PAGE('Mini Loja', '<link rel="stylesheet" href="estilo.css">') }, { name: 'estilo.css', data: CSS }];
const CP850 = { 'ç': 0x87, 'ã': 0xc6, 'á': 0xa0, 'í': 0xa1, 'ó': 0xa2, 'Ç': 0x80, 'Ã': 0xc7 };
const cp850 = s => Buffer.from([...s].map(ch => (ch.charCodeAt(0) < 0x80 ? ch.charCodeAt(0) : CP850[ch])));

test('zip: names in CP850 with no UTF-8 flag (the Explorer and 7-Zip in pt-BR) keep their accents; CP1252 too, chosen by the references of the page', () => {
  for (const [label, encode] of [['cp850', cp850], ['cp1252', s => Buffer.from(s, 'latin1')]]) {
    const dir = fresh(); const file = path.join(dir, label + '.zip');
    const files = [['Protótipo Ação/Página Inicial.html', PAGE('Ações', '<link rel="stylesheet" href="estilos ação.css">', '<main><img src="ícone 1.png"></main>')],
      ['Protótipo Ação/estilos ação.css', CSS], ['Protótipo Ação/ícone 1.png', 'x']];
    write(file, zip(files.map(([name, data]) => ({ name, data, nameBytes: encode(name), utf8: false }))));
    const read = readArchive(file);
    assert.equal(read.ok, true, label);
    assert.deepEqual(read.entries.map(e => e.name).sort(), files.map(([name]) => name).sort(), label);
    const resolved = resolveSource({ source: file }, { sourcesDir: path.join(dir, 'sources') });
    assert.equal(resolved.ok, true, label + ' ' + JSON.stringify(resolved.problem));
    assert.equal(path.basename(resolved.root), 'Protótipo Ação', label);
    assert.equal(resolved.entry, 'Página Inicial.html', label);
    assert.ok(fs.existsSync(path.join(resolved.root, 'estilos ação.css')), label + ': the stylesheet the page names is there');
  }
});

test('zip: a Mac zip (__MACOSX/, ._*) is the zip of its one folder; the resource forks are never extracted', () => {
  const dir = fresh(); const file = path.join(dir, 'mac.zip');
  write(file, zip([...MINI.map(e => ({ ...e, name: 'Mini Loja/' + e.name })), { name: '__MACOSX/Mini Loja/._app.html', data: Buffer.from([0, 5, 22, 7]) }, { name: 'Mini Loja/.DS_Store', data: 'x' }]));
  const resolved = resolveSource({ source: file }, { sourcesDir: path.join(dir, 'sources') });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.problem));
  assert.equal(path.basename(resolved.root), 'Mini Loja');
  assert.equal(resolved.entry, 'app.html');
  assert.ok(!fs.existsSync(path.join(path.dirname(resolved.root), '__MACOSX')));
  assert.equal(archiveRoot('x', [{ name: 'A/i.html' }, { name: '__MACOSX/A/._i.html' }, { name: '._x' }]), path.join('x', 'A'));
});

test('zip and folder: pages only in subfolders give ONE refusal with the entry patch (the shallowest page that runs the app), naming the .zip, verified by the capture', async () => {
  const dir = fresh();
  const nested = path.join(dir, 'nested.zip'); write(nested, zip(MINI.map(e => ({ ...e, name: 'outer/inner/' + e.name }))));
  const sources = path.join(dir, 'local', 'prototype', 'sources');
  const one = resolveSource({ source: nested }, { sourcesDir: sources });
  assert.equal(one.ok, false);
  assert.equal(one.problem.at, '/entry');
  assert.deepEqual(one.problem.patch, [{ op: 'add', path: '/entry', value: 'inner/app.html' }]);
  assert.match(one.problem.message, /nested\.zip/);
  assert.ok(!one.problem.message.includes(sources), 'the message names the .zip, never the internal folder');
  const two = path.join(dir, 'two.zip'); write(two, zip([...MINI.map(e => ({ ...e, name: 'v1/' + e.name })), ...MINI.map(e => ({ ...e, name: 'v2/' + e.name }))]));
  const both = resolveSource({ source: two }, { sourcesDir: sources });
  assert.deepEqual(both.problem.patch, [{ op: 'add', path: '/entry', value: 'v1/app.html' }]);
  assert.deepEqual(both.problem.alternatives, ['v2/app.html']);
  const folder = path.join(dir, 'site-folder'); for (const e of MINI) write(path.join(folder, 'site', e.name), e.data); write(path.join(folder, 'LEIA-ME.txt'), 'abra site/app.html');
  assert.deepEqual(resolveSource({ source: folder }).problem.patch, [{ op: 'add', path: '/entry', value: 'site/app.html' }]);
  assert.deepEqual(htmlPages(folder), ['site/app.html']);
  // the expansion captures with the proposed entry: one refusal, verified, and the corrected call is the call with it
  const calls = [];
  const capture = async args => {
    calls.push(args);
    fs.mkdirSync(args.out, { recursive: true });
    const ir = { schema: 'ssam-prototype-capture/1', source: { root: args.source, entry: args.entry, files: [] }, views: [], stats: { views: 1 } };
    const capturePath = path.join(args.out, 'capture.json'); fs.writeFileSync(capturePath, JSON.stringify(ir));
    return { ok: true, capturePath, sha256: 'a'.repeat(64), summary: { views: 1, modals: 0, events: 0 } };
  };
  const expanded = await expandPrototypeOps({ ops: [{ op: 'prototype', data: { source: nested } }] }, { work: path.join(dir, 'local', 'prototype', 'w'), capture });
  assert.equal(calls[0].entry, 'inner/app.html');
  assert.equal(expanded.refusal.code, 'PROTOTYPE_SOURCE_INVALID');
  assert.equal(expanded.refusal.problems.length, 1);
  assert.equal(expanded.refusal.problems[0].verified, true);
  assert.match(expanded.refusal.problems[0].message, /With it the capture ran: 1 screen/);
  assert.equal(expanded.refusal.correctedJob.ops[0].data.entry, 'inner/app.html');
  assert.equal(expanded.refusal.ssamDefect, undefined);
});

test('zip: a zip inside the zip (alone or with a readme), or a folder that only holds the zip, is the prototype', () => {
  const dir = fresh(); const sources = path.join(dir, 'sources');
  const inner = zip(MINI);
  for (const extra of [[], [{ name: 'LEIA-ME.txt', data: 'o protótipo está no zip' }]]) {
    const file = path.join(dir, 'outer' + extra.length + '.zip'); write(file, zip([{ name: 'Mini Loja.zip', data: inner }, ...extra]));
    const resolved = resolveSource({ source: file }, { sourcesDir: sources });
    assert.equal(resolved.ok, true, JSON.stringify(resolved.problem));
    assert.equal(resolved.entry, 'app.html');
    assert.equal(resolved.archive.path, file, 'the outer archive (its bytes decide the inner one)');
    assert.equal(resolved.nested, 'Mini Loja.zip');
  }
  const folder = path.join(dir, 'pasta'); write(path.join(folder, 'Mini Loja.zip'), inner);
  assert.equal(innerArchive(folder), path.join(folder, 'Mini Loja.zip'));
  const resolved = resolveSource({ source: folder }, { sourcesDir: sources });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.problem));
  assert.equal(resolved.archive.path, path.join(folder, 'Mini Loja.zip'));
  // two zips: no guess
  write(path.join(folder, 'Outra.zip'), inner);
  assert.equal(innerArchive(folder), null);
  // the inner zip with its page in a subfolder: the entry patch, and the call with it resolves (never a loop)
  const deep = path.join(dir, 'deep.zip'); write(deep, zip([{ name: 'Mini.zip', data: zip([...MINI.map(e => ({ ...e, name: 'site/' + e.name })), { name: 'LEIA-ME.txt', data: 'abra site/app.html' }]) }]));
  const first = resolveSource({ source: deep }, { sourcesDir: sources });
  assert.deepEqual(first.problem.patch, [{ op: 'add', path: '/entry', value: 'site/app.html' }]);
  const second = resolveSource({ source: deep, entry: 'site/app.html' }, { sourcesDir: sources });
  assert.equal(second.ok, true, JSON.stringify(second.problem));
  assert.equal(second.archive.path, deep);
});

test('vendor: a CDN script with no network refuses with the mapping.vendor patch beside the source and NO correctedJob (the file must exist first); a missing mapping file is SOURCE_INVALID, never a defect', async () => {
  const dir = fresh();
  const folder = path.join(dir, 'Data Hoje');
  write(path.join(folder, 'index.html'), PAGE('Data', '', '<p id="d">--</p><script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js"></script>'));
  const file = path.join(dir, 'data-hoje.zip'); write(file, zip([{ name: 'index.html', data: fs.readFileSync(path.join(folder, 'index.html')) }]));
  const capture = args => capturePrototype({ ...args, clock, pool: 1, vendorCache: path.join(dir, 'empty-cache'), download: null });
  const url = 'https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js';
  for (const [source, base] of [[folder, folder], [file, dir]]) {
    const expanded = await expandPrototypeOps({ ops: [{ op: 'prototype', data: { source } }] }, { work: path.join(dir, 'local', 'prototype', 'w' + n++), capture });
    const refusal = expanded.refusal;
    assert.equal(refusal.code, 'PROTOTYPE_RENDER_FAILED');
    assert.equal(refusal.ssamDefect, undefined);
    assert.equal(refusal.correctedJob, undefined, 'no corrected call before the file exists');
    assert.equal(refusal.patch, undefined);
    const problem = refusal.problems[0];
    assert.equal(problem.needsFile, path.join(base, 'vendor', 'dayjs.min.js'), 'beside the folder or the .zip, never the internal extraction folder');
    assert.deepEqual(problem.patch, [{ op: 'add', path: '/ops/0/data/mapping', value: { vendor: { [url]: problem.needsFile } } }]);
    // the call with the patch, the file still missing: the path is wrong (SOURCE_INVALID), not an SSAM defect
    const again = await expandPrototypeOps({ ops: [{ op: 'prototype', data: { source, mapping: { vendor: { [url]: problem.needsFile } } } }] }, { work: path.join(dir, 'local', 'prototype', 'w' + n++), capture });
    assert.equal(again.refusal.code, 'PROTOTYPE_SOURCE_INVALID');
    assert.equal(again.refusal.ssamDefect, undefined);
    assert.equal(again.refusal.problems[0].pointer, '/ops/0/data/mapping/vendor/https:~1~1cdn.jsdelivr.net~1npm~1dayjs@1.11.10~1dayjs.min.js');
    assert.equal(again.refusal.problems[0].patch, undefined);
  }
});

test('missing files: a local stylesheet or a text/babel script the page names and the folder does not have refuses, named, with the near names', async () => {
  const dir = fresh();
  write(path.join(dir, 'css', 'index.html'), PAGE('Sem estilo', '<link rel="stylesheet" href="estilos.css">'));
  write(path.join(dir, 'css', 'estilo.css'), CSS);
  const css = await capturePrototype({ source: path.join(dir, 'css'), clock, pool: 1, download: null, vendorCache: path.join(dir, 'empty') });
  assert.equal(css.ok, false);
  assert.equal(css.problems[0].code, 'PROTOTYPE_RENDER_FAILED');
  assert.match(css.problems[0].message, /stylesheet estilos\.css does not exist in source; the folder has estilo\.css/);
  assert.deepEqual(css.problems[0].alternatives, ['estilo.css']);
  write(path.join(dir, 'jsx', 'index.html'), PAGE('Sem jsx', '', '<div id="root"></div><script src="babel.min.js"></script><script type="text/babel" src="componentes.jsx"></script><script type="text/babel" src="app.jsx"></script>'));
  fs.copyFileSync(FAKE_BABEL, path.join(dir, 'jsx', 'babel.min.js'));
  write(path.join(dir, 'jsx', 'app.jsx'), 'document.getElementById("root").textContent = "ok";');
  const jsx = await capturePrototype({ source: path.join(dir, 'jsx'), clock, pool: 1, download: null, vendorCache: path.join(dir, 'empty') });
  assert.equal(jsx.ok, false);
  assert.match(jsx.problems.map(p => p.message).join('\n'), /script componentes\.jsx does not exist in source/);
  assert.deepEqual(similarFiles('estilos ação.css', ['estilos aç╞o.css', 'outro.css', 'a.js']), ['estilos aç╞o.css']);
});

test('page errors that escape every handler: a fetch with no catch is a warning and the page imports; an exception thrown in a callback is a typed script error, the child never exits', async () => {
  const dir = fresh();
  write(path.join(dir, 'fetch', 'index.html'), PAGE('API', '', '<ul id="lista"><li>Fixo</li></ul><script>fetch("https://api.exemplo.com/lojas").then(r => r.json()).then(d => { document.getElementById("lista").innerHTML = "" })</script>'));
  const fetched = await capturePrototype({ source: path.join(dir, 'fetch'), clock, pool: 1, download: null, vendorCache: path.join(dir, 'empty') });
  assert.equal(fetched.ok, true, JSON.stringify(fetched.problems));
  assert.ok(fetched.warnings.some(w => w.code === 'PrototypeUnhandledRejection'), JSON.stringify(fetched.warnings.map(w => w.code)));
  write(path.join(dir, 'throw', 'index.html'), PAGE('Lança', '', '<p>x</p><script>var x = new XMLHttpRequest(); x.open("GET", "index.html"); x.onload = function () { throw new Error("quebrou no onload") }; x.send();</script>'));
  const thrown = await capturePrototype({ source: path.join(dir, 'throw'), clock, pool: 1, download: null, vendorCache: path.join(dir, 'empty') });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.problems[0].code, 'PROTOTYPE_RENDER_FAILED');
  assert.match(thrown.problems[0].message, /uncaught error of the page: Error: quebrou no onload/);
  assert.doesNotMatch(thrown.problems[0].message, /capture child exited/);
  assert.equal(thrown.problems[0].ssamDefect, undefined);
  // a page whose text/babel script does not compile: the refusal names the file, the line and the column (PrototypeBabelSyntax)
  const babel = renderProblems([{ reason: 'script', message: 'uncaught error of the page: SyntaxError: unknown' }], { root: dir, mapping: {}, pointer: '/ops/0/data',
    babelSyntax: [{ code: 'PrototypeBabelSyntax', where: 'babel:app.jsx', message: '/app.jsx: Expected corresponding JSX closing tag for <h1>. (11:23)' }] });
  assert.equal(babel.length, 1);
  assert.match(babel[0].message, /text\/babel script app\.jsx does not compile.*\(11:23\)/);
});

test('assets: a %-encoded reference is the decoded file; the mime is the type of the bytes (a JPEG saved as .png)', () => {
  assert.equal(localReference('foto%20grande.png', null), 'foto grande.png');
  assert.equal(localReference('img/enc%20%C3%ADcone.png?v=2', 'css/a.css'), 'css/img/enc ícone.png');
  assert.equal(localReference('100%.png', null), '100%.png', 'a malformed escape stays as written');
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  const files = { 'foto grande.png': jpeg, 'ícone 2.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10]) };
  const assets = collectAssets({ sheets: [{ urls: [{ raw: 'foto%20grande.png', asset: localReference('foto%20grande.png', null) }] }],
    trees: [{ t: 'body', c: [{ t: 'img', a: [['src', '%C3%ADcone%202.png']] }] }], readBytes: rel => files[rel] ?? null });
  assert.deepEqual(assets.map(a => [a.path, a.mime]), [['foto grande.png', 'image/jpeg'], ['ícone 2.png', 'image/png']]);
  assert.equal(imageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'image/svg+xml');
  assert.equal(imageMime(Buffer.from('hello')), null);
});

test('measure: a Static image is equal when the asset it shows (data-ssam-asset) is the file the prototype src names, decoded', () => {
  const proto = { k: 'b', t: 'body', c: [{ k: 'v:i', t: 'img', a: [['src', 'foto%20grande.png'], ['alt', 'foto']] }] };
  const native = asset => ({ k: 'b', t: 'body', c: [{ k: 'v:i', t: 'img', a: [['data-image', ''], ['alt', 'foto'], ['id', 'Image1'], ...(asset ? [['data-ssam-asset', asset]] : [])] }] });
  const measure = tree => measureFidelity({ capture: { explored: [{ id: 's', tree: 'h' }], trees: { h: proto }, css: { sheets: [] } }, nativeDom: { s: tree }, sheets: [] });
  assert.equal(measure(native('foto grande.png')).score, 1, JSON.stringify(measure(native('foto grande.png')).mismatches));
  assert.ok(measure(native('outra.png')).score < 1);
  assert.ok(measure(native(null)).score < 1);
});

test('build: a Verify refusal with no code of its own (nothing named to degrade) is VALIDATION_REFUSED with ssamDefect; a typed one stands', () => {
  const untyped = untypedBuildRefusal({ ok: false, accepted: false, isValid: false, error: '', problems: [{ code: 'LightweightExpression_UnknownObj', message: "Unknown object 'SondaFoto' used in 'SondaTheme' Style Sheet." }] });
  assert.equal(untyped.code, 'VALIDATION_REFUSED');
  assert.equal(untyped.ssamDefect, true);
  assert.match(untyped.error, /SondaFoto/);
  assert.equal(untyped.problems[0].code, 'LightweightExpression_UnknownObj');
  const typed = { ok: false, code: 'PROTOTYPE_NAME_COLLISION', problems: [] };
  assert.equal(untypedBuildRefusal(typed), typed);
  assert.equal(untypedBuildRefusal({ ok: true }).code, undefined);
});
