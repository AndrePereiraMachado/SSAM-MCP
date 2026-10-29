// file.upload (docs/FASE2-AGENTE.md 4.4): the checks before any byte is read (the table the native core shares through
// check-upload, tests/native/upload.test.mjs), the handle and read rules with a counting file system, the transport to a
// fake hub (exactly {blob}, the deadline between parts, two uploads at a time, the server's clock) and the approvals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareUpload, auditFile, UPLOAD_KIND } from '../lib/upload.mjs';
import { KINDS } from '../lib/kinds.mjs';
import { createAgent } from '../lib/agent.mjs';
import { rootsCommand, readRoots, rootsFile, checkApproval } from '../lib/upload-roots.mjs';
import { fakeHub } from './fixtures/fake-hub.mjs';
import { CREDENTIAL } from './fixtures/agent-root.mjs';
import { uploadFixture, moveHook, tempProblem, MiB, foldedSiblings } from './fixtures/upload-table.mjs';

const windows = process.platform === 'win32';
const skip = !windows ? 'the table is written for Windows paths' : tempProblem();
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const outcome = async (request, options) => {
  try { const prepared = await prepareUpload(request, options); return { decision: { size: prepared.size, sha256: prepared.sha256 } }; }
  catch (error) { return { error: error.code, executed: error.executed, sent: error.sent, message: error.message }; }
};

test('file.upload table: every refusal before a byte is read, in the order of the checks', { skip }, async t => {
  const f = uploadFixture();
  t.after(f.remove);
  if (f.fileLinkSkip) t.diagnostic('file symbolic link row skipped: ' + f.fileLinkSkip);
  for (const row of f.rows) {
    const result = await outcome(row.request, { dataRoot: f.data, runtimeRoot: f.runtime, deadline: row.request.deadline ?? null, hooks: { beforeOpen: moveHook(row.request) } });
    if (row.expected === 'send') {
      assert.equal(result.error, undefined, row.label + ': ' + result.message);
      assert.equal(result.decision.size, row.size, row.label);
      assert.equal(result.decision.sha256, sha(fs.readFileSync(row.request.path)), row.label);
    } else {
      assert.equal(result.error, row.expected, row.label + ': ' + result.message);
      assert.equal(result.executed, false, row.label);
      assert.equal(result.sent, false, row.label);
      // Never the link target nor the list of approved folders.
      assert.ok(!result.message.includes(path.join(f.base, 'outside')), row.label + ': ' + result.message);
      assert.ok(!result.message.includes(path.join(f.base, 'real2')), row.label + ': ' + result.message);
    }
  }
});

test('file.upload: no approved folder at all', { skip }, async t => {
  const f = uploadFixture();
  t.after(f.remove);
  fs.rmSync(rootsFile(f.data));
  const result = await outcome({ path: path.join(f.approved, 'a.csv'), maxBytes: MiB }, { dataRoot: f.data, runtimeRoot: f.runtime });
  assert.equal(result.error, 'UPLOAD_ROOT_NOT_APPROVED');
  assert.match(result.message, /Folders SSAM may read|roots add/);
});

test('file.upload: a junction swapped after the open is seen through the handle identity', { skip }, async t => {
  const f = uploadFixture();
  t.after(f.remove);
  const swap = path.join(f.approved, 'swap');
  // To another folder outside: the real path leaves the approved folder.
  let result = await outcome({ path: path.join(swap, 'b.txt'), maxBytes: MiB }, { dataRoot: f.data, runtimeRoot: f.runtime, hooks: {
    afterOpen: () => { fs.renameSync(swap, path.join(f.base, 'swap-old')); fs.renameSync(path.join(f.base, 'swap-evil'), swap); } } });
  assert.equal(result.error, 'PATH_LEAVES_ROOT', result.message);
  // To another file of the same name inside the approved folder: the real path is another file than the handle.
  const other = path.join(f.approved, 'other-sub'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'b.txt'), 'inside\n');
  fs.renameSync(swap, path.join(f.base, 'swap-evil')); fs.renameSync(path.join(f.base, 'swap-old'), swap);
  result = await outcome({ path: path.join(swap, 'b.txt'), maxBytes: MiB }, { dataRoot: f.data, runtimeRoot: f.runtime, hooks: {
    afterOpen: () => { fs.renameSync(swap, path.join(f.base, 'swap-old')); fs.symlinkSync(other, swap, 'junction'); } } });
  assert.equal(result.error, 'PATH_CHANGED', result.message);
});

test('file.upload: size and folders are refused through the handle without a single read', { skip }, async t => {
  const f = uploadFixture();
  t.after(f.remove);
  let reads = 0; let opens = 0;
  const files = {
    open: async file => { opens++; const handle = await fs.promises.open(file, 'r'); const read = handle.read.bind(handle); handle.read = (...args) => { reads++; return read(...args); }; return handle; },
    realpath: file => fs.realpathSync.native(file), stat: file => fs.statSync(file, { bigint: true }) };
  const big = path.join(f.approved, 'big.bin');
  assert.equal(fs.statSync(big).size, 64 * MiB + 1);
  let result = await outcome({ path: big, maxBytes: 64 * MiB }, { dataRoot: f.data, runtimeRoot: f.runtime, files });
  assert.equal(result.error, 'FILE_TOO_LARGE', result.message);
  assert.equal(opens, 1); assert.equal(reads, 0);
  result = await outcome({ path: path.join(f.approved, 'hard.csv'), maxBytes: MiB }, { dataRoot: f.data, runtimeRoot: f.runtime, files });
  assert.equal(result.error, 'PATH_FORBIDDEN'); assert.equal(reads, 0);
  result = await outcome({ path: path.join(f.approved, 'a.csv'), maxBytes: MiB }, { dataRoot: f.data, runtimeRoot: f.runtime, files });
  assert.equal(result.decision.size, 5);
  // One read to the end and one read that proves the end: the file is read once.
  assert.equal(reads, 2);
});

test('file.upload: a locked file and a file that changes while it is read', { skip }, async t => {
  const f = uploadFixture();
  t.after(f.remove);
  const real = { realpath: file => fs.realpathSync.native(file), stat: file => fs.statSync(file, { bigint: true }) };
  let result = await outcome({ path: path.join(f.approved, 'a.csv'), maxBytes: MiB }, { dataRoot: f.data, runtimeRoot: f.runtime,
    files: { ...real, open: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } } });
  assert.equal(result.error, 'FILE_LOCKED');
  assert.match(result.message, /close it in the other program/);
  result = await outcome({ path: path.join(f.approved, 'a.csv'), maxBytes: MiB }, { dataRoot: f.data, runtimeRoot: f.runtime,
    files: { ...real, open: async file => { const handle = await fs.promises.open(file, 'r'); handle.read = async () => ({ bytesRead: 0 }); return handle; } } });
  assert.equal(result.error, 'FILE_CHANGED');
  result = await outcome({ path: path.join(f.approved, 'a.csv'), maxBytes: MiB }, { dataRoot: f.data, runtimeRoot: f.runtime,
    files: { ...real, open: async file => { const handle = await fs.promises.open(file, 'r'); const read = handle.read.bind(handle);
      handle.read = async (buffer, offset, length, position) => (position >= 5 ? { bytesRead: 1 } : read(buffer, offset, length, position)); return handle; } } });
  assert.equal(result.error, 'FILE_CHANGED');
});

// The agent with a fake hub: the hub calls file.upload as the server does.
async function agentWithHub(t, f, { welcome = {}, deps = {} } = {}) {
  const hub = await fakeHub({ credential: CREDENTIAL, welcome });
  const agent = createAgent({ root: f.data, runtimeRoot: f.runtime, config: { server: hub.url, credential: CREDENTIAL },
    deps: { processes: async () => [], locate: async () => null, machine: null, studioRuntime: async () => null, bridgeProcessSnapshot: async () => [], ...deps },
    log: (event, fields) => { f.log.push(JSON.stringify({ event, ...fields })); } });
  t.after(async () => { await agent.stop(); await hub.close(); });
  agent.run();
  await hub.until(() => hub.stream);
  // The server's clock, to the millisecond (the welcome's Date header gives it only to the second).
  hub.send({ t: 'ping', seq: 0, at: Date.now() });
  await hub.until(() => hub.messages.some(m => m.t === 'pong' && m.seq === 0));
  let serial = 0;
  const call = async (params, extra = {}) => {
    const id = 'upload-' + ++serial;
    hub.send({ t: 'call', id, kind: UPLOAD_KIND, params, ...extra });
    await hub.until(() => hub.results(id).length > 0, 30000);
    return hub.results(id)[0];
  };
  return { hub, agent, call };
}

test('file.upload through the channel: exactly {blob}, the bytes and sha256 at the hub, the record kept on this computer', { skip, timeout: 60000 }, async t => {
  const f = uploadFixture(); f.log = [];
  t.after(f.remove);
  const { hub, call } = await agentWithHub(t, f, { welcome: { partBytes: 4 } });
  assert.ok(hub.hellos[0].agent.kinds.includes('file.upload'));
  const file = path.join(f.approved, 'sub', 'b.txt');
  let answer = await call({ path: file, maxBytes: 64 * MiB }, { deadline: Date.now() + 120000 });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(Object.keys(answer.value), ['blob']);
  assert.deepEqual(Object.keys(answer.value.blob).sort(), ['partBytes', 'parts', 'sha256', 'size', 'transfer']);
  assert.equal(answer.value.blob.parts, 2);
  assert.deepEqual(hub.assembled(answer.value.blob), fs.readFileSync(file));
  answer = await call({ path: path.join(f.approved, 'empty.csv'), maxBytes: 64 * MiB });
  assert.equal(answer.value.blob.size, 0);
  assert.equal(answer.value.blob.parts, 1);
  assert.deepEqual(hub.assembled(answer.value.blob), Buffer.alloc(0));
  const refused = await call({ path: path.join(f.approved, 'link', 'secret.csv'), maxBytes: 64 * MiB });
  assert.deepEqual(refused.error, { code: 'PATH_LEAVES_ROOT', message: refused.error.message, executed: false, sent: false });
  const records = fs.readFileSync(auditFile(f.data), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(records.map(({ at, ...rest }) => rest), [
    { root: 0, relative: 'sub/b.txt', size: 7, sha256: sha(fs.readFileSync(file)) },
    { root: 0, relative: 'empty.csv', size: 0, sha256: sha(Buffer.alloc(0)) }]);
  // The agent log never carries a path of this computer.
  assert.ok(f.log.length > 0);
  assert.ok(!f.log.some(line => line.includes('approved') || line.includes('b.txt')), f.log.join('\n'));
});

test('file.upload through the channel: the deadline before reading and between parts', { skip, timeout: 60000 }, async t => {
  const f = uploadFixture(); f.log = [];
  t.after(f.remove);
  const { hub, call } = await agentWithHub(t, f, { welcome: { partBytes: 4 } });
  const puts = hub.blobPuts;
  let answer = await call({ path: path.join(f.approved, 'a.csv'), maxBytes: MiB }, { deadline: Date.now() - 1000 });
  assert.deepEqual(answer.error, { code: 'AGENT_TIMEOUT', message: answer.error.message, executed: false, sent: false });
  assert.equal(hub.blobPuts, puts);
  hub.delayPuts = 400;
  answer = await call({ path: path.join(f.approved, 'a.csv'), maxBytes: MiB }, { deadline: Date.now() + 300 });
  assert.equal(answer.error.code, 'AGENT_TIMEOUT');
  assert.equal(answer.error.sent, null);
  assert.equal(hub.blobPuts, puts + 1);
});

test('file.upload through the channel: the deadline is the server clock, read from its pings', { skip, timeout: 60000 }, async t => {
  const f = uploadFixture(); f.log = [];
  t.after(f.remove);
  const { hub, call } = await agentWithHub(t, f);
  // The server's clock is 10 minutes behind this computer's: its deadline of 60 s is still ahead.
  const behind = Date.now() - 600000;
  hub.send({ t: 'ping', seq: 1, at: behind });
  await hub.until(() => hub.messages.some(m => m.t === 'pong' && m.seq === 1));
  const answer = await call({ path: path.join(f.approved, 'a.csv'), maxBytes: MiB }, { deadline: behind + 60000 });
  assert.equal(answer.ok, true, JSON.stringify(answer));
});

test('file.upload through the channel: at most two uploads at a time', { skip, timeout: 60000 }, async t => {
  const f = uploadFixture(); f.log = [];
  t.after(f.remove);
  const { hub, call } = await agentWithHub(t, f);
  hub.delayPuts = 300;
  const answers = await Promise.all(['a.csv', 'empty.csv', 'sub/b.txt', 'A Report.CSV'].map(name => call({ path: path.join(f.approved, ...name.split('/')), maxBytes: MiB })));
  for (const answer of answers) assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(hub.maxActivePuts, 2);
});

test('file.upload record: the last 1000 uploads only', async t => {
  const { recordUpload, AUDIT_LINES } = await import('../lib/upload.mjs');
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'ssam-upload-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let i = 0; i < AUDIT_LINES + 5; i++) recordUpload(dir, { root: 0, relative: 'f' + i + '.csv', size: i, sha256: 'x' });
  const lines = fs.readFileSync(auditFile(dir), 'utf8').trim().split('\n');
  assert.equal(lines.length, AUDIT_LINES);
  assert.equal(JSON.parse(lines[0]).relative, 'f5.csv');
  assert.equal(JSON.parse(lines.at(-1)).relative, 'f' + (AUDIT_LINES + 4) + '.csv');
});

test('hello: file.upload is announced with the other kinds', () => {
  assert.ok(KINDS.includes('file.upload'));
  assert.equal(new Set(KINDS).size, KINDS.length);
});

// ---- approvals (roots add | remove | list)
const sink = () => { const stream = { text: '', write(chunk) { stream.text += chunk; return true; } }; return stream; };
function roots(op, folder, f, extra = {}) {
  const stdout = sink(); const stderr = sink();
  const code = rootsCommand({ op, folder, dataRoot: f.data, runtimeRoot: f.runtime, stdout, stderr, ...extra });
  return { code, out: stdout.text, err: stderr.text };
}

test('roots: add, list, remove, and the same folder twice', { skip }, async t => {
  const f = uploadFixture();
  t.after(f.remove);
  fs.rmSync(rootsFile(f.data));
  let r = roots('list', undefined, f);
  assert.equal(r.code, 0); assert.match(r.out, /No folder is approved/);
  r = roots('add', f.approved + '\\', f);
  assert.equal(r.code, 0, r.err); assert.match(r.out, /^Approved: /);
  const [entry] = readRoots(f.data);
  assert.equal(entry.path, f.approved[0].toUpperCase() + f.approved.slice(1));
  assert.equal(entry.real.toLowerCase(), fs.realpathSync.native(f.approved).toLowerCase());
  assert.ok(!Number.isNaN(Date.parse(entry.addedAt)));
  assert.deepEqual(JSON.parse(fs.readFileSync(rootsFile(f.data), 'utf8')).schema, 'ssam-upload-roots/1');
  r = roots('add', f.approved.toUpperCase(), f);
  assert.equal(r.code, 0); assert.match(r.out, /Already approved/);
  assert.equal(readRoots(f.data).length, 1);
  r = roots('list', undefined, f);
  assert.match(r.out, /Folders SSAM may read \(1\):/);
  r = roots('list', undefined, f, { json: true });
  assert.equal(JSON.parse(r.out).roots.length, 1);
  r = roots('remove', f.approved, f);
  assert.equal(r.code, 0); assert.equal(readRoots(f.data).length, 0);
  r = roots('remove', f.approved, f);
  assert.equal(r.code, 1); assert.match(r.err, /not an approved folder/);
});

test('roots: every approval refusal', { skip }, async t => {
  const f = uploadFixture();
  t.after(f.remove);
  fs.rmSync(rootsFile(f.data));
  const env = { USERPROFILE: path.join(f.base, 'home'), SystemRoot: path.join(f.base, 'Windows'), ProgramData: path.join(f.base, 'ProgramData'),
    ProgramFiles: path.join(f.base, 'Apps') };
  for (const dir of ['home/Documents/Project', 'Windows/System32', 'ProgramData/x', 'Apps/x', 'home/AppData/Roaming/x'])
    fs.mkdirSync(path.join(f.base, ...dir.split('/')), { recursive: true });
  fs.symlinkSync(path.join(f.base, 'Windows', 'System32'), path.join(f.base, 'to-windows'), 'junction');
  const cases = [
    ['relative', 'approved'],
    ['missing', path.join(f.base, 'missing')],
    ['a file', path.join(f.approved, 'a.csv')],
    ['a drive root', path.parse(f.base).root],
    ['UNC', '\\\\server\\share\\folder'],
    ['device path', '\\\\?\\' + f.approved],
    ['~', '~\\Documents'],
    ['the user folder itself', env.USERPROFILE],
    ['a folder that holds the user folder', f.base],
    ['Windows', path.join(env.SystemRoot, 'System32')],
    ['ProgramData', path.join(env.ProgramData, 'x')],
    ['Program Files', path.join(env.ProgramFiles, 'x')],
    ['AppData', path.join(env.USERPROFILE, 'AppData', 'Roaming', 'x')],
    ['the agent data folder', f.data],
    ['inside the agent data folder', path.join(f.data, 'inbox')],
    ['the agent runtime folder', f.runtime],
    ['a junction to Windows', path.join(f.base, 'to-windows')],
  ];
  for (const [label, folder] of cases) {
    const r = roots('add', folder, f, { env });
    assert.equal(r.code, 1, label + ': ' + r.out);
    assert.match(r.err, /Nothing was approved|is not|names no|path|folder/, label);
  }
  assert.equal(readRoots(f.data).length, 0);
  // A folder inside the user folder is fine.
  assert.equal(roots('add', path.join(env.USERPROFILE, 'Documents', 'Project'), f, { env }).code, 0);
  // A folder whose name starts with "Program Files" at the root of a drive is refused on the real machine too.
  assert.match(checkApproval('C:\\Program Files', { dataRoot: f.data }).problem ?? '', /Program Files|Windows|applications/);
});

test('roots CLI: ssam-agent.mjs roots add|list|remove', { skip, timeout: 30000 }, async t => {
  const f = uploadFixture();
  t.after(f.remove);
  fs.rmSync(rootsFile(f.data));
  const { spawnSync } = await import('node:child_process');
  const script = path.resolve(import.meta.dirname, '..', 'ssam-agent.mjs');
  const run = (...args) => spawnSync(process.execPath, [script, ...args, '--root', f.data, '--runtime-root', f.runtime], { encoding: 'utf8', windowsHide: true });
  let r = run('roots', 'add', '--folder', f.approved);
  assert.equal(r.status, 0, r.stderr);
  r = run('roots', 'list', '--json');
  assert.equal(JSON.parse(r.stdout).roots[0].path.toLowerCase(), f.approved.toLowerCase());
  r = run('roots', 'remove', '--folder', f.approved);
  assert.equal(r.status, 0, r.stderr);
  r = run('roots', 'add', '--folder', f.data);
  assert.equal(r.status, 1); assert.match(r.stderr, /SSAM agent folder/);
  r = run('roots', 'move', '--folder', f.approved);
  assert.equal(r.status, 1);
  r = run('roots', 'list', '--server', 'x');
  assert.equal(r.status, 1); assert.match(r.stderr, /unknown option/);
});

test('file.upload: every pair of folders the case pre-selection folds but NTFS keeps apart is refused', { skip, timeout: 300000 }, async t => {
  const f = foldedSiblings();
  t.after(f.remove);
  t.diagnostic(`${f.pairs} folded pairs, ${f.rows.length} kept apart by the file system`);
  assert.ok(f.rows.length > 100, 'the file system keeps folded pairs apart');
  const sent = [];
  for (const row of f.rows) {
    const result = await outcome(row.request, { dataRoot: f.data, runtimeRoot: f.runtime });
    if (!result.error) sent.push(row.label);
    else assert.ok(['PATH_LEAVES_ROOT', 'UPLOAD_ROOT_NOT_APPROVED'].includes(result.error), row.label + ': ' + result.error);
  }
  assert.deepEqual(sent.slice(0, 30), []);
});