// uninstall of agent/ssam-agent.sh (lib/launcher.mjs) never deletes through a link and takes from private/ only what the
// installation recorded (review M1, M2). Each path to remove is checked component by component with lstat from the real
// root: a folder of the pack that is a link (docs/ -> elsewhere), a file that is a link, or a root whose real folder
// changed keeps that item, and the result says which one and why. From private/ only the files of the setup record
// (private/installed.json, written by setup on macOS) go, and private/ itself only when it is left empty. Real folders;
// the folder links are junctions (the links Windows lets a test make; on macOS the same lstat meets symbolic links); a
// file link is a real symbolic link where the system allows one, else an lstat that says "link" for that one path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as launcher from '../lib/launcher.mjs';
import { setup } from '../ssam-agent.mjs';
import { LAYOUT } from '../lib/workspace.mjs';
import { CREDENTIAL } from './fixtures/agent-root.mjs';
import { portugueseIn, describe } from './fixtures/portuguese.mjs';

const { createLauncher } = launcher;
// The record of the setup and the files of private/ it lists (the names the installation writes there).
const INSTALL_RECORD = launcher.INSTALL_RECORD ?? 'private/installed.json';
const PRIVATE_FILES = launcher.PRIVATE_FILES ?? [];
const texts = [];
const unlink = link => { try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* gone */ } };

// <top>/root is the agent folder (a pack with docs/, agent/, private/ and work), <top>/outside a folder of the person.
function layout({ docsLink = false, record = null, privateNotes = false } = {}) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-uninstall-'));
  const root = path.join(top, 'root'); const outside = path.join(top, 'outside');
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  write(path.join(outside, 'docs', 'AGENTE-MAC.md'), 'the person own file with the name of a pack file');
  write(path.join(outside, 'docs', 'keep.txt'), 'keep');
  write(path.join(outside, 'secret.txt'), 'the person secret');
  for (const rel of ['agent/ssam-agent.mjs', 'agent/ssam-agent.sh', 'agent/lib/x.mjs', 'install.sh']) write(path.join(root, ...rel.split('/')), rel);
  if (docsLink) fs.symlinkSync(path.join(outside, 'docs'), path.join(root, 'docs'), 'junction');
  else write(path.join(root, 'docs', 'AGENTE-MAC.md'), 'pack');
  for (const folder of LAYOUT) fs.mkdirSync(path.join(root, ...folder.split('/')), { recursive: true });
  for (const rel of ['private/config.json', 'private/credential', 'private/agent.log', 'private/agent.json', 'private/authority/bridge.key']) write(path.join(root, ...rel.split('/')), 'x');
  if (privateNotes) write(path.join(root, 'private', 'notes-before-install.txt'), 'the person had this folder before');
  if (record) write(path.join(root, ...INSTALL_RECORD.split('/')), JSON.stringify(record));
  write(path.join(root, 'odc', 'snapshots', 'work.oml'), 'work');
  write(path.join(root, 'pack.json'), JSON.stringify({ id: 'pack-mac', platform: 'darwin', files: ['agent/ssam-agent.mjs', 'agent/ssam-agent.sh', 'agent/lib/x.mjs', 'install.sh', 'docs/AGENTE-MAC.md'].map(p => ({ path: p })) }));
  return { top, root, outside, remove: () => { unlink(path.join(root, 'docs')); fs.rmSync(top, { recursive: true, force: true }); } };
}
const run = async (root, options = {}) => {
  const lines = [];
  const code = await createLauncher({ root, out: { write: t => { lines.push(t); return true; } }, isAgent: async () => false, ...options }).uninstall();
  const text = lines.join('');
  texts.push(['uninstall', text]);
  return { code, text };
};

test('uninstall: a pack folder that is a link (docs/ -> elsewhere) is never entered; the file of the same name out there stays, and the result names it', async () => {
  const c = layout({ docsLink: true });
  try {
    const { code, text } = await run(c.root);
    assert.equal(code, 0, text);
    assert.equal(fs.readFileSync(path.join(c.outside, 'docs', 'AGENTE-MAC.md'), 'utf8'), 'the person own file with the name of a pack file');
    assert.equal(fs.existsSync(path.join(c.outside, 'docs', 'keep.txt')), true);
    assert.equal(fs.lstatSync(path.join(c.root, 'docs')).isSymbolicLink(), true, 'the link itself is not removed either');
    assert.match(text, /Not removed: docs\/AGENTE-MAC\.md \(docs is a link\)/);
    // The rest of the pack went.
    assert.equal(fs.existsSync(path.join(c.root, 'agent')), false);
    assert.equal(fs.existsSync(path.join(c.root, 'install.sh')), false);
  } finally { c.remove(); }
});

test('uninstall: a pack file that is a link is neither followed nor removed, and is named', async () => {
  const c = layout();
  const link = path.join(c.root, 'agent', 'lib', 'x.mjs');
  const target = path.join(c.outside, 'secret.txt');
  fs.rmSync(link);
  let files = fs;
  try { fs.symlinkSync(target, link, 'file'); }
  catch {
    // No symbolic links for this user (Windows without developer mode): the file is there and lstat says "link".
    fs.writeFileSync(link, 'stands for a link');
    const linkStat = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
    files = { ...fs, lstatSync: (p, o) => (path.resolve(p) === link ? linkStat : fs.lstatSync(p, o)),
      unlinkSync: p => { assert.notEqual(path.resolve(p), link, 'a link is never removed'); fs.unlinkSync(p); } };
  }
  try {
    const { code, text } = await run(c.root, { files });
    assert.equal(code, 0, text);
    assert.equal(fs.readFileSync(target, 'utf8'), 'the person secret');
    assert.equal(fs.lstatSync(link) !== undefined, true, 'the link stays');
    assert.match(text, /Not removed: agent\/lib\/x\.mjs \(it is a link\)/);
    assert.equal(fs.existsSync(path.join(c.root, 'agent', 'ssam-agent.mjs')), false);
  } finally { c.remove(); }
});

test('uninstall: when the real folder of the root changes while removing, nothing more is removed and the result says why', async () => {
  const c = layout();
  try {
    const real = fs.realpathSync.native(c.root);
    let calls = 0;
    const moved = path.join(c.top, 'elsewhere');
    const realpathSync = Object.assign(p => (path.resolve(p) === path.resolve(c.root) && ++calls > 1 ? moved : fs.realpathSync(p)),
      { native: p => (path.resolve(p) === path.resolve(c.root) && ++calls > 1 ? moved : fs.realpathSync.native(p)) });
    const { code, text } = await run(c.root, { files: { ...fs, realpathSync } });
    assert.equal(code, 1, text);
    assert.match(text, /the real folder of .* changed/);
    for (const rel of ['agent/ssam-agent.mjs', 'install.sh', 'private/credential', 'pack.json']) assert.equal(fs.existsSync(path.join(real, ...rel.split('/'))), true, rel);
  } finally { c.remove(); }
});

test('uninstall: from private/ only the files of the setup record; a file that was there before stays, and so does private/', async () => {
  const c = layout({ privateNotes: true, record: { by: 'ssam-agent setup', files: PRIVATE_FILES, folders: LAYOUT.filter(f => !f.startsWith('private')) } });
  try {
    const { code, text } = await run(c.root);
    assert.equal(code, 0, text);
    assert.equal(fs.readFileSync(path.join(c.root, 'private', 'notes-before-install.txt'), 'utf8'), 'the person had this folder before');
    for (const rel of ['private/config.json', 'private/credential', 'private/agent.log', 'private/agent.json', 'private/authority/bridge.key', INSTALL_RECORD])
      assert.equal(fs.existsSync(path.join(c.root, ...rel.split('/'))), false, rel);
    // private/ was not created by the setup (not in the record): kept, with what is left in it named.
    assert.equal(fs.existsSync(path.join(c.root, 'private')), true);
    assert.match(text, /Kept in .*private\/ \(\d+ files?\)/);
    assert.equal(fs.readFileSync(path.join(c.root, 'odc', 'snapshots', 'work.oml'), 'utf8'), 'work');
  } finally { c.remove(); }
});

test('setup on macOS records exactly what it created; uninstall then leaves a folder the setup found already there', async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-record-'));
  const posixOf = dir => dir.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
  const root = posixOf(top) + '/SSAM-Agent';
  const sink = () => { const chunks = []; const stream = new Writable({ write(chunk, encoding, done) { chunks.push(String(chunk)); done(); } }); stream.text = () => chunks.join(''); return stream; };
  try {
    // The person had an inbox/ with a file before the setup.
    fs.mkdirSync(path.join(top, 'SSAM-Agent', 'inbox'), { recursive: true });
    fs.writeFileSync(path.join(top, 'SSAM-Agent', 'pack.json'), JSON.stringify({ id: 'pack-mac', files: [] }));
    const err = sink();
    const code = await setup({ root, server: 'https://mcp.ssam.pro', stdin: Object.assign(Readable.from([CREDENTIAL + '\n']), { isTTY: false }), stdout: sink(), stderr: err,
      env: { HOME: posixOf(top) + '/home' }, platform: 'darwin', restrict: async () => {} });
    assert.equal(code, 0, err.text());
    const record = JSON.parse(fs.readFileSync(path.join(top, 'SSAM-Agent', ...INSTALL_RECORD.split('/')), 'utf8'));
    assert.deepEqual(record.files, PRIVATE_FILES);
    assert.equal(record.folders.includes('inbox'), false, 'inbox was already there');
    for (const folder of ['private', 'private/authority', 'private/runtime-connect', 'private/tmp', 'odc', 'odc/lab', 'o11', 'o11/downloads']) assert.ok(record.folders.includes(folder), folder);
    const { text } = await run(path.join(top, 'SSAM-Agent'));
    assert.equal(fs.existsSync(path.join(top, 'SSAM-Agent', 'private')), false, 'private/ was created by the setup and is empty now: ' + text);
    assert.equal(fs.existsSync(path.join(top, 'SSAM-Agent', 'odc')), false);
    assert.equal(fs.existsSync(path.join(top, 'SSAM-Agent', 'inbox')), true, 'a folder the setup found is not removed, even empty');
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
  const found = texts.flatMap(([where, text]) => { const f = portugueseIn(text); return f.length ? [describe(where, f)] : []; });
  assert.equal(found.join('\n'), '', 'Portuguese the customer would see');
});
