// r41 (hosted/workspace-retention.mjs): the retention cleanup of a customer workspace removes core dumps, old scratch, the
// bulk of ended deliveries and older captures, and keeps everything an open operation, a reservation, a run lease or the last
// successful delivery needs; it never leaves the workspace nor follows a link; two backends never clean one workspace at once.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanWorkspace, sweepCustomers, retentionSettings, RETENTION, lockFileOf, journalFileOf } from '../hosted/workspace-retention.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;
const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const tmp = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-retention-')); roots.push(r); return r; };
const write = (file, content = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
const age = (target, days) => {
  const at = new Date(Date.now() - days * DAY);
  const walk = p => { const st = fs.lstatSync(p); if (st.isSymbolicLink()) return; if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n)); fs.utimesSync(p, at, at); };
  walk(target);
  return target;
};
const exists = p => fs.existsSync(p);
// An ELF core dump header (e_type 4) and a minidump header; content after them is filler.
const elfCore = () => { const b = Buffer.alloc(64); b.write('\x7fELF', 0, 'latin1'); b[4] = 2; b[5] = 1; b.writeUInt16LE(4, 16); return b; };
const minidump = () => Buffer.concat([Buffer.from('MDMP', 'latin1'), Buffer.alloc(60)]);
// Linux leases faked: flock -n answers 1 for a held task; the deletion under the lease removes the paths it is given.
const linuxLease = (held, { takenDuringDelete = [] } = {}) => ({ platform: 'linux', flock: file => ({ status: held.some(id => file.includes(id)) ? 1 : 0 }),
  underLease: (file, paths) => { if (takenDuringDelete.some(id => file.includes(id))) return { status: 1 }; for (const p of paths) fs.rmSync(p, { recursive: true, force: true }); return { status: 0 }; } });
const id = c => c.repeat(32);
const task = (ws, taskId, state, days = 10) => {
  const dir = path.join(ws, 'o11', 'work', 'deliver', taskId);
  write(path.join(dir, 'task.json'), JSON.stringify({ taskId, work: dir, ...state }));
  write(path.join(dir, 'result.json'), '{}');
  write(path.join(dir, 'run.lock'), '');
  write(path.join(dir, 'attempt-1', 'base.oml'), 'B'.repeat(100));
  write(path.join(dir, 'delivered-1.oml'), 'D'.repeat(50));
  age(dir, days);
  return dir;
};

function fixture() {
  const root = tmp();
  const ws = path.join(root, 'customers', 'tok_0123456789ab');
  const outside = write(path.join(root, 'outside', 'keep.txt'), 'outside');
  const tokens = write(path.join(root, 'tokens.json'), '{"schema":"ssam-server-tokens/1","tokens":[]}');
  age(path.dirname(outside), 30); age(tokens, 30);
  const f = { root, ws, outside, tokens };
  // core dumps: removed only when the bytes are a dump
  f.core = write(path.join(ws, 'o11', 'core.1234'), elfCore());
  f.coreBare = write(path.join(ws, 'odc', 'lab', '09-x', 'coredump.77'), minidump());
  f.notCore = write(path.join(ws, 'o11', 'core.555'), 'just a user file');
  f.inboxCore = write(path.join(ws, 'inbox', 'core'), 'user upload named core');
  // scratch
  f.stagingOld = age(write(path.join(ws, 'o11', 'journal', 'staging', 'a'.repeat(64) + '.oml'), 'S'.repeat(40)), 5);
  f.stagingNew = write(path.join(ws, 'odc', 'journal', 'staging', 'b'.repeat(64) + '.oml'), 'S');
  f.tmpOld = write(path.join(ws, 'o11', 'tmp', 'versions', 'b1', 'thin-bridge', 'x.oml'), 'T'.repeat(30)); age(path.dirname(f.tmpOld), 4);
  f.tmpNew = write(path.join(ws, 'odc', 'tmp', 'versions', 'b1', 'runtime', 'y.json'), 'T');
  f.buildsOld = write(path.join(ws, 'state', 'versions', 'b1', 'builds', id('c'), 'candidate.oml'), 'C'.repeat(20)); age(path.dirname(f.buildsOld), 4);
  f.transferOld = write(path.join(ws, 'state', 'versions', 'b2', 'transfers', id('d'), '0.part'), 'P'.repeat(20)); age(path.dirname(f.transferOld), 4);
  f.bridgeKey = age(write(path.join(ws, 'state', 'versions', 'b1', 'relay-authority', 'bridge.key'), 'k'), 40);
  f.grants = age(write(path.join(ws, 'state', 'versions', 'b1', 'grants', 'standing-grants.json'), '{}'), 40);
  f.users = age(write(path.join(ws, 'state', 'users', 'r.json'), '{}'), 40);
  f.job = age(write(path.join(ws, 'o11', 'jobs', 'inline', 'j.json'), '{}'), 40);
  // O11 delivery tasks
  f.ended = task(ws, id('a'), { closed: true, writeState: 'not-applied', error: 'x', module: 'M' });
  f.repairable = task(ws, id('6'), { writeState: 'not-applied', error: 'x', module: 'R' });
  write(path.join(f.ended, 'producers', 'p.avsig'), 'sig'); age(f.ended, 10);
  f.uncertain = task(ws, id('b'), { writeState: 'unknown', module: 'M', snapshot: { path: path.join(ws, 'o11', 'snapshots', 'M-20260101000000.oml') } });
  f.pending = task(ws, id('e'), { writeState: 'applied', pendingBridgeOperation: { id: 'p' }, module: 'M' });
  f.owner = task(ws, id('f'), { writeState: 'not-sent', error: 'x', module: 'N' });
  f.lastDelivered = task(ws, id('1'), { delivered: true, writeState: 'applied', module: 'M', updatedAt: '2026-10-20T00:00:00Z' });
  f.olderDelivered = task(ws, id('2'), { delivered: true, writeState: 'applied', module: 'M', updatedAt: '2026-10-10T00:00:00Z' });
  f.leaseHeld = task(ws, id('3'), { closed: true, module: 'P' });
  f.recent = task(ws, id('4'), { closed: true, module: 'Q' }, 1);
  f.unreadable = task(ws, id('5'), {}); write(path.join(f.unreadable, 'task.json'), '{"format":1,"sha256":"00","payload":"{}"}'); age(f.unreadable, 10);
  write(path.join(ws, 'state', 'versions', 'b2', 'relay-authority', 'reservations', 'r.json'), JSON.stringify({ owner: id('f'), moduleKey: 'n' }));
  // O11 captures of M: five, all older than a day; the oldest is named by the uncertain task
  f.o11Caps = ['20260101000000', '20260102000000', '20260103000000', '20260104000000', '20260105000000']
    .map(ts => age(write(path.join(ws, 'o11', 'snapshots', 'M-' + ts + '.oml'), 'O'.repeat(10)), 3));
  f.o11Sibling = age(write(f.o11Caps[1] + '.json', '{}'), 3);
  f.o11Unknown = age(write(path.join(ws, 'o11', 'snapshots', 'captures.json'), '{}'), 30);
  f.o11Young = ['20260201000000', '20260202000000', '20260203000000', '20260204000000'].map(ts => write(path.join(ws, 'o11', 'snapshots', 'Y-' + ts + '.oml'), 'y'));
  // ODC captures of X: five, the oldest named by an in-progress lab delivery
  f.odcCaps = [1, 2, 3, 4, 5].map(n => {
    const file = write(path.join(ws, 'odc', 'snapshots', 'X-' + String(n).repeat(64).slice(0, 64) + '.oml'), 'X'.repeat(10));
    write(file + '.json', JSON.stringify({ module: 'X', moduleKey: 'kx', host: 'h', capturedAt: '2026-10-0' + n + 'T00:00:00Z' }));
    return age(file, 3), age(file + '.json', 3), file;
  });
  f.modules = age(write(path.join(ws, 'odc', 'snapshots', 'modules.json'), '{}'), 30);
  // ODC lab: an old ended delivery of X, the newest of X, one in progress, one uncertain
  const lab = (name, { result, progress, module = 'X', base, started = true, returned = true }, days) => {
    const dir = path.join(ws, 'odc', 'lab', name);
    if (result) write(path.join(dir, 'deliver-result.json'), JSON.stringify(result));
    if (progress) write(path.join(dir, 'deliver-progress.json'), '{}');
    write(path.join(dir, 'delivery', 'manifest.json'), JSON.stringify({ module, moduleKey: 'k' + module.toLowerCase(), tenant: 'h', ...(base ? { basePath: base } : {}) }));
    if (started) write(path.join(dir, 'delivery', 'evidence', 'merge-started.json'), '{}');
    if (returned) write(path.join(dir, 'delivery', 'evidence', 'native-return.json'), '{}');
    write(path.join(dir, 'work', 'candidate.oml'), 'W'.repeat(70));
    write(path.join(dir, 'delivery', 'mine.oml'), 'M'.repeat(5));
    return age(dir, days);
  };
  f.labOld = lab('01-a', { result: { completedAt: '2026-10-01T00:00:00Z' } }, 10);
  f.labNewest = lab('02-a', { result: { completedAt: '2026-10-05T00:00:00Z' } }, 9);
  f.labProgress = lab('03-b', { progress: true, base: f.odcCaps[0], returned: false }, 10);
  f.labUncertain = lab('04-c', { result: { completedAt: '2026-10-02T00:00:00Z', outcome: 'uncertain' }, module: 'Z' }, 10);
  f.labNoReturn = lab('05-z', { result: { completedAt: '2026-10-03T00:00:00Z' }, module: 'Z', returned: false }, 10);
  // open records that name files
  write(path.join(ws, 'o11', 'tasks', 't1.json'), JSON.stringify({ state: 'running', base: 'ws:o11/snapshots/M-20260102000000.oml' }));
  write(path.join(ws, 'o11', 'tasks', 't2.json'), JSON.stringify({ state: 'ok', base: 'ws:o11/snapshots/M-20260103000000.oml' }));
  // a link to a folder outside, with an old file there, inside a scratch folder
  f.linkDir = path.join(ws, 'o11', 'tmp', 'versions', 'b1', 'escape');
  fs.symlinkSync(path.dirname(outside), f.linkDir, 'junction');
  f.linkParent = write(path.join(ws, 'o11', 'journal', 'staging', 'held', 'old.bin'), 'L');
  fs.symlinkSync(path.dirname(outside), path.join(ws, 'o11', 'journal', 'staging', 'held', 'link'), 'junction');
  age(path.dirname(f.linkParent), 9);
  return f;
}

test('the cleanup removes dumps, old scratch, ended bulk and older captures, and keeps every file an open operation needs', () => {
  const f = fixture();
  const log = [];
  const r = cleanWorkspace(f.ws, { deps: linuxLease([id('3')]), backend: 'b1', log: e => log.push(e), settings: retentionSettings({}) });
  assert.equal(r.ok, true, JSON.stringify(r));
  // dumps
  assert.equal(exists(f.core), false); assert.equal(exists(f.coreBare), false);
  assert.equal(exists(f.notCore), true, 'a file named core.<n> that is not a dump stays');
  assert.equal(exists(f.inboxCore), true);
  // scratch
  for (const p of [f.stagingOld, f.tmpOld, path.dirname(f.buildsOld), path.dirname(f.transferOld)]) assert.equal(exists(p), false, p);
  for (const p of [f.stagingNew, f.tmpNew, f.bridgeKey, f.grants, f.users, f.job]) assert.equal(exists(p), true, p);
  // tasks: the ended one loses its bulk only; every kept one is whole
  assert.equal(exists(path.join(f.ended, 'attempt-1')), false); assert.equal(exists(path.join(f.ended, 'delivered-1.oml')), false);
  for (const keep of ['task.json', 'result.json', 'run.lock', 'producers/p.avsig']) assert.equal(exists(path.join(f.ended, keep)), true, keep);
  assert.equal(exists(path.join(f.olderDelivered, 'attempt-1')), false, 'an older delivered task of the same module is trimmed');
  for (const dir of [f.uncertain, f.pending, f.owner, f.lastDelivered, f.leaseHeld, f.recent, f.unreadable, f.repairable])
    assert.equal(exists(path.join(dir, 'attempt-1', 'base.oml')) && exists(path.join(dir, 'delivered-1.oml')), true, dir);
  // O11 captures of M: the three newest, the one the uncertain task names and the one the running facade task names
  assert.deepEqual(f.o11Caps.map(exists), [true, true, true, true, true]);
  // ... so with references none of M's five goes; Y's are younger than a day
  assert.deepEqual(f.o11Young.map(exists), [true, true, true, true]);
  assert.equal(exists(f.o11Unknown), true);
  // ODC: five X captures, three newest kept, the oldest named by the lab delivery in progress, the second removed with its sibling
  assert.deepEqual(f.odcCaps.map(exists), [true, false, true, true, true]);
  assert.equal(exists(f.odcCaps[1] + '.json'), false);
  assert.equal(exists(f.modules), true);
  // lab: the old ended delivery loses work/ and its .oml; the newest, the open and the uncertain ones stay whole
  assert.equal(exists(path.join(f.labOld, 'work')), false); assert.equal(exists(path.join(f.labOld, 'delivery', 'mine.oml')), false);
  assert.equal(exists(path.join(f.labOld, 'delivery', 'manifest.json')), true);
  for (const dir of [f.labNewest, f.labProgress, f.labUncertain, f.labNoReturn]) assert.equal(exists(path.join(dir, 'work', 'candidate.oml')), true, dir);
  // links: never followed, and a tree with one inside stays whole
  assert.equal(fs.readFileSync(f.outside, 'utf8'), 'outside'); assert.equal(exists(f.tokens), true);
  assert.equal(exists(f.linkDir), true); assert.equal(exists(f.linkParent), true);
  // the journal: names and bytes, never content
  const lines = fs.readFileSync(journalFileOf(f.ws), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].freedBytes, r.freedBytes);
  assert.ok(lines[0].items.some(i => i.path === 'o11/core.1234' && i.kind === 'core-dump' && i.bytes === 64));
  assert.ok(lines[0].items.every(i => !i.path.startsWith('..') && !path.isAbsolute(i.path)));
  assert.doesNotMatch(fs.readFileSync(journalFileOf(f.ws), 'utf8'), /BBBB|WWWW|outside/);
  assert.equal(exists(lockFileOf(f.ws)), false, 'the lock is released');
  assert.equal(log.filter(e => e.event === 'workspace-cleaned').length, 1);
  // a second run finds nothing more
  assert.equal(cleanWorkspace(f.ws, { deps: linuxLease([id('3')]) }).removed, 0);
});

test('without references the captures beyond the newest three of a module go; a capture younger than a day stays', () => {
  const root = tmp(); const ws = path.join(root, 'w');
  const caps = ['20260101000000', '20260102000000-0123abcd', '20260103000000', '20260104000000', '20260105000000']
    .map(ts => age(write(path.join(ws, 'o11', 'snapshots', 'Mod-A-' + ts + '.oml'), 'z'), 3));
  const build = age(write(path.join(ws, 'o11', 'snapshots', 'build-Mod-A-20260101000000.oml'), 'z'), 3);
  const young = ['20260106000000', '20260107000000', '20260108000000', '20260109000000'].map(ts => write(path.join(ws, 'o11', 'snapshots', 'Mod-A-' + ts + '.oml'), 'z'));
  const r = cleanWorkspace(ws, { settings: { scratchDays: 3, keepCaptures: 3 } });
  assert.deepEqual(caps.map(exists), [false, false, false, false, false], 'the four young captures are the newest; the old ones go');
  assert.deepEqual(young.map(exists), [true, true, true, true], 'younger than a day: kept even beyond three');
  assert.equal(exists(build), true, 'a build capture is its own group');
  assert.equal(r.removed, 5);
});

test('a lock held by another backend skips the workspace; a stale lock is broken; a lost lock stops the cleanup', () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(lockFileOf(f.ws)), { recursive: true });
  fs.writeFileSync(lockFileOf(f.ws), JSON.stringify({ id: 'other', backend: 'b2' }));
  const skipped = cleanWorkspace(f.ws, { deps: linuxLease([]) });
  assert.deepEqual([skipped.skipped, skipped.removed], ['locked', 0]);
  assert.equal(exists(f.core), true);
  age(lockFileOf(f.ws), 1);
  const broke = cleanWorkspace(f.ws, { deps: linuxLease([]) });
  assert.equal(broke.ok, true); assert.ok(broke.removed > 0); assert.equal(exists(f.core), false);
  // another process takes the lock while this one runs: it stops before the next phase
  const g = fixture();
  const lost = cleanWorkspace(g.ws, { deps: linuxLease([]), afterLock: () => fs.writeFileSync(lockFileOf(g.ws), JSON.stringify({ id: 'thief' })) });
  assert.deepEqual([lost.ok, lost.skipped, lost.removed], [false, 'lock-lost', 0]);
  assert.equal(exists(g.core), true);
});

test('four processes sweeping the same customers never hold one workspace at once and remove each file once', async () => {
  const f = fixture();
  const holds = path.join(f.root, 'holds.jsonl');
  const script = path.join(f.root, 'sweeper.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
import { sweepCustomers } from ${JSON.stringify(pathToFileURL(path.join(here, '..', 'hosted', 'workspace-retention.mjs')).href)};
const [customers, holds] = process.argv.slice(2);
const r = await sweepCustomers(customers, { force: true, deps: { platform: 'linux', flock: () => ({ status: 0 }), underLease: (f, paths) => { for (const p of paths) fs.rmSync(p, { recursive: true, force: true }); return { status: 0 }; } }, afterLock: () => {
  const start = Date.now(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  fs.appendFileSync(holds, JSON.stringify({ pid: process.pid, start, end: Date.now() }) + '\\n'); } });
process.stdout.write(JSON.stringify(r));
`);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, path.join(f.root, 'customers'), holds], { windowsHide: true });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('close', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(out))));
  });
  const results = await Promise.all([run(), run(), run(), run()]);
  const spans = fs.readFileSync(holds, 'utf8').trim().split('\n').map(JSON.parse).sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].start >= spans[i - 1].end, 'two holders overlapped: ' + JSON.stringify(spans));
  assert.ok(results.some(r => r.removed > 0));
  const lines = fs.readFileSync(journalFileOf(f.ws), 'utf8').trim().split('\n').map(JSON.parse);
  const removed = lines.flatMap(l => l.items.map(i => i.path));
  assert.equal(new Set(removed).size, removed.length, 'a file was journaled twice');
  assert.equal(results.reduce((n, r) => n + r.removed, 0), removed.length);
  assert.equal(exists(lockFileOf(f.ws)), false);
});

test('the settings take whole numbers in range from the environment, else the defaults', () => {
  assert.deepEqual(retentionSettings({}), { scratchDays: RETENTION.scratchDays, keepCaptures: RETENTION.keepCaptures });
  assert.deepEqual(retentionSettings({ SSAM_WORKSPACE_SCRATCH_DAYS: '7', SSAM_WORKSPACE_KEEP_CAPTURES: '5' }), { scratchDays: 7, keepCaptures: 5 });
  assert.deepEqual(retentionSettings({ SSAM_WORKSPACE_SCRATCH_DAYS: '0', SSAM_WORKSPACE_KEEP_CAPTURES: 'x' }), { scratchDays: 3, keepCaptures: 3 });
  assert.deepEqual([RETENTION.scratchDays, RETENTION.keepCaptures, RETENTION.sweepEveryMs], [3, 3, 30 * 60000]);
});

test('a missing workspace, a workspace that is a link and a state folder that is a link are left alone', async () => {
  const root = tmp();
  assert.equal(cleanWorkspace(path.join(root, 'none')).skipped, 'no-workspace');
  const target = path.join(root, 'real'); write(path.join(target, 'o11', 'core'), elfCore());
  const link = path.join(root, 'customers', 'tok_aaaaaaaaaaaa'); fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
  assert.equal(cleanWorkspace(link).skipped, 'no-workspace');
  assert.equal((await sweepCustomers(path.join(root, 'customers'))).workspaces, 0);
  assert.equal(exists(path.join(target, 'o11', 'core')), true);
  const ws = path.join(root, 'w2'); write(path.join(ws, 'o11', 'core'), elfCore());
  const elsewhere = path.join(root, 'state-elsewhere'); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(ws, 'state'), 'junction');
  assert.equal(cleanWorkspace(ws).skipped, 'state-not-a-folder');
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('review round: unversioned reservations, app sessions, job files, the worker folder, a lease taken during the deletion', () => {
  const root = tmp(); const ws = path.join(root, 'w');
  const owner = task(ws, id('7'), { closed: true, module: 'A' });
  write(path.join(ws, 'state', 'relay-authority', 'reservations', 'r.json'), JSON.stringify({ owner: id('7') }));
  const inSession = task(ws, id('8'), { closed: true, module: 'B', request: { ReservationOwner: id('9') } });
  write(path.join(ws, 'state', 'versions', 'b1', 'relay-authority', 'app-sessions.json'), JSON.stringify({ sessions: { s: id('9') }, tasks: {} }));
  const raced = task(ws, id('c'), { closed: true, module: 'C' });
  const caps = ['20260101000000', '20260102000000', '20260103000000', '20260104000000'].map(ts => age(write(path.join(ws, 'o11', 'snapshots', 'J-' + ts + '.oml'), 'j'), 3));
  write(path.join(ws, 'o11', 'jobs', 'inline', 'recent.json'), JSON.stringify({ base: 'ws:o11/snapshots/J-20260101000000.oml', ops: [] }));
  const worker = write(path.join(ws, 'o11', 'tmp', 'o11-worker', 'worker-7000.json'), '{}'); age(path.dirname(worker), 9);
  const r = cleanWorkspace(ws, { deps: linuxLease([], { takenDuringDelete: [id('c')] }) });
  assert.equal(r.ok, true);
  assert.equal(exists(path.join(owner, 'attempt-1')), true, 'the owner of an unversioned reservation stays whole');
  assert.equal(exists(path.join(inSession, 'attempt-1')), true, 'a task of an app session stays whole');
  assert.equal(exists(path.join(raced, 'attempt-1')), true, 'a lease taken before the deletion: nothing removed');
  assert.ok(!r.items.some(i => i.path.includes(id('c'))), 'and nothing journaled for it');
  assert.deepEqual(caps.map(exists), [true, true, true, true], 'the base a recent job names stays beyond the newest three');
  assert.equal(exists(worker), true, 'tmp/o11-worker is the worker folder, never scratch');
});

test('review round: a planted link as lock or journal is never followed; the four backends share the last sweep time', async () => {
  const root = tmp(); const customers = path.join(root, 'customers'); const ws = path.join(customers, 'tok_00000000000b');
  write(path.join(ws, 'o11', 'core'), elfCore());
  const outside = write(path.join(root, 'outside', 'journal.txt'), 'outside');
  fs.mkdirSync(path.join(ws, 'state', 'retention'), { recursive: true });
  fs.symlinkSync(path.dirname(outside), lockFileOf(ws), 'junction');
  fs.symlinkSync(path.dirname(outside), journalFileOf(ws), 'junction');
  const first = await sweepCustomers(customers, { deps: linuxLease([]) });
  assert.deepEqual([first.workspaces, first.removed], [1, 1]);
  assert.equal(exists(path.join(ws, 'o11', 'core')), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
  assert.deepEqual(fs.readdirSync(path.dirname(outside)), ['journal.txt'], 'nothing written through the links');
  write(path.join(ws, 'o11', 'core.9'), elfCore());
  const second = await sweepCustomers(customers, { deps: linuxLease([]) });
  assert.deepEqual([second.workspaces, second.skipped], [0, 1], 'swept minutes ago by another backend');
  assert.equal(exists(path.join(ws, 'o11', 'core.9')), true);
  assert.equal((await sweepCustomers(customers, { deps: linuxLease([]), force: true })).removed, 1);
});

test('review round: a stale lock is moved away, a fresh one is never taken from its holder', () => {
  const f = fixture();
  fs.mkdirSync(path.dirname(lockFileOf(f.ws)), { recursive: true });
  fs.writeFileSync(lockFileOf(f.ws), JSON.stringify({ id: 'dead' })); age(lockFileOf(f.ws), 1);
  const r = cleanWorkspace(f.ws, { deps: linuxLease([]) });
  assert.equal(r.ok, true); assert.ok(r.removed > 0);
  assert.deepEqual(fs.readdirSync(path.dirname(lockFileOf(f.ws))).filter(n => n.includes('lock')), [], 'no stale copy left');
});
