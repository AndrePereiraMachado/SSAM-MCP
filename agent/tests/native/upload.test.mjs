// file.upload in the native core: the same table as the Node agent (check-upload against agent/tests/upload.test.mjs's
// fixture), the transport to the fake hub in qualification mode (exactly {blob}, sent:null mid-transfer, the server's
// clock, two at a time) and the roots CLI with each approval refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fakeHub } from '../../agent/tests/fixtures/fake-hub.mjs';
import { uploadFixture, moveHook, tempProblem, MiB, foldedSiblings } from '../../agent/tests/fixtures/upload-table.mjs';
import { prepareUpload } from '../../agent/lib/upload.mjs';
import { readRoots, rootsFile, fileIdentity } from '../../agent/lib/upload-roots.mjs';
import { insidePath } from '../../agent/lib/local-paths.mjs';

const app = fileURLToPath(new URL('../../', import.meta.url));
const dll = path.join(app, 'native/Ssam.Agent/bin/Release/net10.0/ssam-agent.dll');
const skip = process.platform !== 'win32' ? 'the table is written for Windows paths' : tempProblem();
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const native = (args, options = {}) => {
  const exe = process.env.SSAM_NATIVE_EXE;
  return spawnSync(exe || 'dotnet', exe ? args : [dll, ...args], { encoding: 'utf8', windowsHide: true, ...options });
};

test('native check-upload answers the Node table row by row', { skip, timeout: 60000 }, async t => {
  const nodeFixture = uploadFixture({ prefix: 'ssam-upload-node-' });
  const nativeFixture = uploadFixture({ prefix: 'ssam-upload-native-' });
  t.after(() => { nodeFixture.remove(); nativeFixture.remove(); });
  const expected = [];
  for (const row of nodeFixture.rows) {
    try {
      const prepared = await prepareUpload(row.request, { dataRoot: nodeFixture.data, runtimeRoot: nodeFixture.runtime, deadline: row.request.deadline ?? null, hooks: { beforeOpen: moveHook(row.request) } });
      expected.push({ decision: { size: prepared.size, sha256: prepared.sha256 } });
    } catch (error) { expected.push({ error: error.code }); }
  }
  const result = native(['check-upload', '--root', nativeFixture.data, '--runtime-root', nativeFixture.runtime], { input: JSON.stringify(nativeFixture.rows.map(row => row.request)) });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  nativeFixture.rows.forEach((row, i) => {
    assert.deepEqual(actual[i], expected[i], row.label);
    if (row.expected === 'send') assert.equal(actual[i].decision.size, row.size, row.label);
    else assert.equal(actual[i].error, row.expected, row.label);
  });
  // No approved folder at all.
  fs.rmSync(rootsFile(nativeFixture.data));
  const none = native(['check-upload', '--root', nativeFixture.data, '--runtime-root', nativeFixture.runtime], { input: JSON.stringify([{ path: path.join(nativeFixture.approved, 'a.csv'), maxBytes: MiB }]) });
  assert.deepEqual(JSON.parse(none.stdout), [{ error: 'UPLOAD_ROOT_NOT_APPROVED' }]);
});

async function qualify(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-upload-'));
  fs.rmdirSync(root);
  const credential = 'ssam_native_qualification';
  const hub = await fakeHub({ credential, ...options });
  const args = ['qualify', '--root', root, '--server', hub.url, '--bridge-port', '9'];
  const proc = process.env.SSAM_NATIVE_EXE ? spawn(process.env.SSAM_NATIVE_EXE, args, { windowsHide: true }) : spawn('dotnet', [dll, ...args], { windowsHide: true });
  let stderr = ''; proc.stderr.on('data', chunk => { stderr += chunk; });
  proc.stdin.end(credential + '\n');
  const exit = new Promise(resolve => proc.once('exit', resolve));
  t.after(async () => { proc.kill(); await exit; await hub.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await hub.until(() => hub.streams === 1, 30000);
  hub.send({ t: 'ping', seq: 0, at: Date.now() });
  await hub.until(() => hub.messages.some(m => m.t === 'pong' && m.seq === 0));
  let serial = 0;
  const call = async (params, extra = {}) => {
    const id = 'upload-' + ++serial;
    hub.send({ t: 'call', id, kind: 'file.upload', params, ...extra });
    await hub.until(() => hub.results(id).length > 0, 30000);
    return hub.results(id)[0];
  };
  return { root, hub, call, stderr: () => stderr };
}

test('native file.upload through the channel: exactly {blob}, the deadline and two at a time', { skip, timeout: 90000 }, async t => {
  const f = uploadFixture({ prefix: 'ssam-upload-channel-' });
  t.after(f.remove);
  const q = await qualify(t, { welcome: { partBytes: 4 } });
  assert.ok(q.hub.hellos[0].agent.kinds.includes('file.upload'));
  assert.equal(q.hub.hellos[0].agent.version, '0.4.3-native');
  assert.ok(!q.hub.hellos[0].agent.kinds.includes('screen.render'));
  // The approvals of the fixture, now in the qualification root (the file is read at every call).
  fs.copyFileSync(rootsFile(f.data), rootsFile(q.root));
  assert.equal(readRoots(q.root).length, 9);
  const file = path.join(f.approved, 'sub', 'b.txt');
  let answer = await q.call({ path: file, maxBytes: 64 * MiB }, { deadline: Date.now() + 120000 });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(Object.keys(answer.value), ['blob']);
  assert.deepEqual(Object.keys(answer.value.blob).sort(), ['partBytes', 'parts', 'sha256', 'size', 'transfer']);
  assert.equal(answer.value.blob.parts, 2);
  assert.deepEqual(q.hub.assembled(answer.value.blob), fs.readFileSync(file));
  answer = await q.call({ path: path.join(f.approved, 'empty.csv'), maxBytes: 64 * MiB });
  assert.equal(answer.value.blob.parts, 1);
  assert.equal(answer.value.blob.sha256, sha(Buffer.alloc(0)));
  answer = await q.call({ path: path.join(f.approved, 'link', 'secret.csv'), maxBytes: 64 * MiB });
  assert.deepEqual(answer.error, { code: 'PATH_LEAVES_ROOT', message: answer.error.message, executed: false, sent: false });
  const records = fs.readFileSync(path.join(q.root, 'private', 'uploads.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(({ at, ...rest }) => rest), [{ root: 0, relative: 'sub/b.txt', size: 7, sha256: sha(fs.readFileSync(file)) },
    { root: 0, relative: 'empty.csv', size: 0, sha256: sha(Buffer.alloc(0)) }]);
  // The deadline: before reading (nothing sent), then between parts (sent: null).
  const puts = q.hub.blobPuts;
  answer = await q.call({ path: path.join(f.approved, 'a.csv'), maxBytes: MiB }, { deadline: Date.now() - 1000 });
  assert.deepEqual(answer.error, { code: 'AGENT_TIMEOUT', message: answer.error.message, executed: false, sent: false });
  assert.equal(q.hub.blobPuts, puts);
  q.hub.delayPuts = 400;
  answer = await q.call({ path: path.join(f.approved, 'a.csv'), maxBytes: MiB }, { deadline: Date.now() + 300 });
  assert.equal(answer.error.code, 'AGENT_TIMEOUT');
  assert.equal(answer.error.sent, null);
  // The server's clock 10 minutes behind this computer's.
  q.hub.delayPuts = 0;
  const behind = Date.now() - 600000;
  q.hub.send({ t: 'ping', seq: 2, at: behind });
  await q.hub.until(() => q.hub.messages.some(m => m.t === 'pong' && m.seq === 2));
  answer = await q.call({ path: path.join(f.approved, 'a.csv'), maxBytes: MiB }, { deadline: behind + 60000 });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  // Two at a time.
  q.hub.send({ t: 'ping', seq: 3, at: Date.now() });
  await q.hub.until(() => q.hub.messages.some(m => m.t === 'pong' && m.seq === 3));
  q.hub.delayPuts = 300; q.hub.maxActivePuts = 0;
  const answers = await Promise.all(['a.csv', 'empty.csv', 'A Report.CSV'].map(name => q.call({ path: path.join(f.approved, name), maxBytes: MiB })));
  for (const each of answers) assert.equal(each.ok, true, JSON.stringify(each));
  assert.equal(q.hub.maxActivePuts, 2);
});

test('native roots: add, list, remove and every approval refusal, with the Node texts', { skip, timeout: 60000 }, async t => {
  const f = uploadFixture({ prefix: 'ssam-upload-roots-' });
  t.after(f.remove);
  fs.rmSync(rootsFile(f.data));
  // Every spelling of these keys goes first (a Node started from Git Bash has SYSTEMROOT besides SystemRoot; Windows would
  // keep the real one).
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['userprofile', 'systemroot', 'programdata', 'programfiles'].includes(key.toLowerCase())));
  Object.assign(env, { USERPROFILE: path.join(f.base, 'home'), SystemRoot: path.join(f.base, 'Windows'), ProgramData: path.join(f.base, 'ProgramData'), ProgramFiles: path.join(f.base, 'Apps') });
  for (const dir of ['home/Documents/Project', 'Windows/System32', 'ProgramData/x', 'Apps/x', 'home/AppData/Roaming/x']) fs.mkdirSync(path.join(f.base, ...dir.split('/')), { recursive: true });
  fs.symlinkSync(path.join(f.base, 'Windows', 'System32'), path.join(f.base, 'to-windows'), 'junction');
  const roots = (...args) => native(['roots', ...args, '--root', f.data, '--runtime-root', f.runtime], { env });
  let r = roots('list');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /No folder is approved/);
  r = roots('add', '--folder', f.approved + '\\');
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^Approved: /);
  const [entry] = readRoots(f.data);
  assert.equal(entry.path.toLowerCase(), f.approved.toLowerCase());
  assert.equal(entry.real.toLowerCase(), fs.realpathSync.native(f.approved).toLowerCase());
  // The identity the native core records is the one the Node agent computes (volume and file id).
  assert.equal(entry.id, fileIdentity(fs.statSync(f.approved, { bigint: true })));
  r = roots('add', '--folder', f.approved.toUpperCase());
  assert.match(r.stdout, /Already approved/);
  r = roots('list', '--json');
  assert.equal(JSON.parse(r.stdout).roots.length, 1);
  r = roots('list');
  assert.match(r.stdout, /Folders SSAM may read \(1\):/);
  r = roots('remove', '--folder', f.approved);
  assert.equal(r.status, 0, r.stderr);
  r = roots('remove', '--folder', f.approved);
  assert.equal(r.status, 1); assert.match(r.stderr, /not an approved folder/);
  const cases = [['relative', 'approved'], ['missing', path.join(f.base, 'missing')], ['a file', path.join(f.approved, 'a.csv')], ['a drive root', path.parse(f.base).root],
    ['UNC', '\\\\server\\share\\folder'], ['device path', '\\\\?\\' + f.approved], ['the user folder itself', env.USERPROFILE], ['a folder that holds the user folder', f.base],
    ['Windows', path.join(env.SystemRoot, 'System32')], ['ProgramData', path.join(env.ProgramData, 'x')], ['Program Files (Windows sets ProgramFiles itself in a child process: the real folder)', path.join(process.env.ProgramW6432 ?? 'C:\\Program Files', 'Common Files')],
    ['AppData', path.join(env.USERPROFILE, 'AppData', 'Roaming', 'x')], ['the agent data folder', f.data], ['inside the agent data folder', path.join(f.data, 'inbox')],
    ['the agent runtime folder', f.runtime], ['a junction to Windows', path.join(f.base, 'to-windows')]];
  for (const [label, folder] of cases) {
    r = roots('add', '--folder', folder);
    assert.equal(r.status, 1, label + ': ' + r.stdout);
    assert.match(r.stderr, /^Error: .*\. Nothing was approved\./, label);
  }
  assert.equal(readRoots(f.data).length, 0);
  assert.equal(roots('add', '--folder', path.join(env.USERPROFILE, 'Documents', 'Project')).status, 0);
});

test('native and Node compare paths the same way: ordinal without case, never Unicode folding', { skip: process.platform !== 'win32' && 'Windows comparison', timeout: 60000 }, () => {
  const pairs = [];
  const add = (child, parent) => pairs.push(['C:\\d\\' + child + '\\f.csv', 'C:\\d\\' + parent]);
  for (const code of [...Array.from({ length: 0x3000 - 0x20 }, (_, i) => 0x20 + i), ...Array.from({ length: 0x100 }, (_, i) => 0xff00 + i), ...Array.from({ length: 0x80 }, (_, i) => 0x10400 + i)]) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const ch = String.fromCodePoint(code);
    for (const other of new Set([ch.toUpperCase(), ch.toLowerCase(), ch.normalize('NFKC')])) if ([...other].length === 1) { add(ch, other); add(other, ch); }
  }
  for (const [a, b] of [['K', '\u212A'], ['k', '\u212A'], ['\u00E5', '\u212B'], ['\u00C5', '\u212B'], ['\u03C9', '\u2126'], ['\u03A9', '\u2126'], ['i', '\u0130'], ['I', '\u0131'],
    ['s', '\u017F'], ['ss', '\u00DF'], ['SS', '\u00DF'], ['\uD801\uDC28', '\uD801\uDC00'], ['A.CSV', 'a.csv'], ['K', 'k']]) { add(a, b); add(b, a); }
  const result = native(['check-inside'], { input: JSON.stringify(pairs) });
  assert.equal(result.status, 0, result.stderr);
  const answers = JSON.parse(result.stdout);
  const differ = pairs.filter(([child, parent], i) => insidePath(child, parent, 'win32') !== answers[i]);
  assert.deepEqual(differ.slice(0, 60).map(([c, p]) => [...c.slice(5, -6)].map(x => x.codePointAt(0).toString(16)).join(' ') + ' / ' + [...p.slice(5)].map(x => x.codePointAt(0).toString(16)).join(' ')), []);
  // The signs NTFS keeps apart stay apart; letters still match without case.
  assert.equal(insidePath('C:\\d\\\u212A\\f.csv', 'C:\\d\\K', 'win32'), false);
  assert.equal(insidePath('C:\\d\\\u2126\\f.csv', 'C:\\d\\\u03C9', 'win32'), false);
  assert.equal(insidePath('C:\\d\\k\\f.csv', 'C:\\d\\K', 'win32'), true);
});
test('native check-upload refuses every folded pair NTFS keeps apart, as the Node agent does', { skip, timeout: 300000 }, async t => {
  const f = foldedSiblings({ prefix: 'ssam-folded-native-' });
  t.after(f.remove);
  assert.ok(f.rows.length > 100);
  const expected = [];
  for (const row of f.rows) {
    try { await prepareUpload(row.request, { dataRoot: f.data, runtimeRoot: f.runtime }); expected.push({ decision: 'send' }); }
    catch (error) { expected.push({ error: error.code }); }
  }
  const result = native(['check-upload', '--root', f.data, '--runtime-root', f.runtime], { input: JSON.stringify(f.rows.map(row => row.request)), maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  // Both cores refuse every pair. The refusal code may differ only where the lexical pre-selection's case tables differ
  // (letters newer than the .NET table, which JavaScript already maps): PATH_LEAVES_ROOT in one, UPLOAD_ROOT_NOT_APPROVED in
  // the other; the decision itself is the exact real comparison, the same in both.
  const sent = f.rows.filter((row, i) => actual[i].decision || expected[i].decision).map(row => row.label);
  assert.deepEqual(sent.slice(0, 30), []);
  const codes = ['PATH_LEAVES_ROOT', 'UPLOAD_ROOT_NOT_APPROVED'];
  assert.ok(actual.every((answer, i) => codes.includes(answer.error) && codes.includes(expected[i].error)));
  t.diagnostic(`refusal codes differ on ${f.rows.filter((row, i) => actual[i].error !== expected[i].error).length} of ${f.rows.length} pairs (case tables of the pre-selection)`);
});
test('native roots: a folder deleted and created again is refused with its own code, then approved again by roots add', { skip, timeout: 60000 }, async t => {
  const f = uploadFixture({ prefix: 'ssam-upload-again-' });
  t.after(f.remove);
  const recreated = path.join(f.base, 'recreated');
  const check = () => JSON.parse(native(['check-upload', '--root', f.data, '--runtime-root', f.runtime], { input: JSON.stringify([{ path: path.join(recreated, 'x.csv'), maxBytes: MiB }]) }).stdout)[0];
  assert.deepEqual(check(), { error: 'UPLOAD_ROOT_REPLACED' });
  let r = native(['roots', 'add', '--folder', recreated, '--root', f.data, '--runtime-root', f.runtime]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /^Approved again: /);
  assert.equal(check().decision?.size, 10);
  r = native(['roots', 'add', '--folder', recreated, '--root', f.data, '--runtime-root', f.runtime]);
  assert.match(r.stdout, /^Already approved: /);
  r = native(['roots', 'add', '--folder', path.join(f.base, 'swapped'), '--root', f.data, '--runtime-root', f.runtime]);
  assert.equal(r.status, 1); assert.match(r.stderr, /was approved as a folder and is now a link or junction\. Nothing was approved\./);
});