// studio-write-lock.mjs: classification of every tool, the in-process and cross-process lock and its write queue (A08: a
// busy Studio is waited for, never refused at once), stale recovery and release.
// Only temporary folders; the lock never talks to a Studio, so no bridge, pipe or port is involved.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { odcRoot } from '../workspace.mjs';
import { ENVIRONMENT_READS, ENVIRONMENT_WRITES } from '../o11-environment.mjs';
import { COMMANDS } from '../o11-studio.mjs';
import { BUSY_CODE, QUEUE_TIMEOUT_CODE, QUEUE_WHY, STALE_MS, WRITE_TOOLS, busyToolResult, isWrite, laneOfTool, studioWriteTarget, withStudioWriteLock } from '../studio-write-lock.mjs';

const WHY = QUEUE_WHY;
const WORDS = 'pode entregar, palavras do usuario';
const tmp = () => fs.mkdtempSync(path.join(isolatedProfile, 'lock-')); // removed with the isolated profile on exit
const depsFor = root => ({ o11Root: path.join(root, 'kernel'), odcRoot: path.join(root, 'odc'), o11Lane: 'ss4' });
const odcLocks = deps => path.join(deps.odcRoot, '.local', 'locks');
const o11Locks = deps => path.join(deps.o11Root, '.local', 'locks');
const lockFiles = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.lock')).sort() : []);
const queueFiles = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.queue')).sort() : []);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const writeLock = (file, record) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record)); };

// ---- classification
const ID = 'a'.repeat(32);
const WRITES = [
  ['o11_deliver', { module: 'M', job: [{ op: 'x' }], authorize: WORDS }], ['o11_deliver', { module: 'M', job: [{ op: 'x' }], until: 'merge' }],
  ['o11_deliver', { resume: ID, authorize: WORDS }], ['o11_deliver', { close: { taskId: ID, reason: 'r' }, authorize: WORDS }],
  ['o11_deliver', { module: 'M', job: [{ op: 'x' }], closePrevious: ID }],
  // Calls that open a module of the O11 Studio (open_module selects its tab): a delivery's post-merge steps are pinned to
  // the tab of its module, so these are writes too.
  ['o11_deliver', { module: 'M', job: [{ op: 'x' }], until: 'apply', authorize: WORDS }],
  ['o11_publish', { module: 'M', authorize: WORDS }],
  ['o11_access', { action: 'apply', manifestPath: 'C:\\m.json', words: WORDS }],
  ...ENVIRONMENT_WRITES.map(action => ['o11_environment', { action }]),
  ['o11_studio', { command: 'open-module', args: { name: 'M' } }], ['o11_studio', { command: 'snapshot', args: { module: 'M' } }],
  ['o11_studio', { command: 'wait', args: { condition: 'open', module: 'M' } }], ['o11_studio', { command: 'dismiss-dialog', args: { title: 'X' } }],
  ['o11_studio', { command: 'login', args: { host: 'h.test' } }],
  // A24: the module named by its alias is the same open.
  ['o11_studio', { command: 'open-module', args: { module: 'M' } }], ['o11_studio', { command: 'snapshot', args: { name: 'M' } }],
  // The Studio's own Refresh References changes the module (C26).
  ['o11_studio', { command: 'refresh-references', args: { module: 'M' } }], ['o11_studio', { command: 'refresh-references' }],
  // Closing a module's tab changes the Studio (2026-10-07, second window of the DCIPS agents).
  ['o11_studio', { command: 'close-module', args: { name: 'M' } }],
  // UI freeze of 2026-10-08 (pattern 4): wait idle|no-dialogs answer the dependencies dialog and refresh references, and idle
  // must not count other writes forever: they take their turn in the queue (for up to their own timeoutSeconds).
  ...['idle', 'no-dialogs'].map(condition => ['o11_studio', { command: 'wait', args: { condition } }]),
  ...['insert', 'update', 'delete'].map(operation => ['o11_data', { request: { operation, entity: 'E' } }]),
  // A batch with any write (contract I12) is a write.
  ['o11_data', { request: { batch: [{ operation: 'read', entity: 'E' }, { operation: 'insert', entity: 'E', records: [{}] }] } }],
  // ssam_task with close closes a delivery task in the kernel (snapshot of the module, reservation).
  ['ssam_task', { id: ID, close: { reason: 'r' } }],
  ['o11_service_center_write', { action: 'timer-run', execute: true }],
  // The delete and its aliases execute with the words, in one call (contract I4).
  ['o11_service_center_write', { action: 'delete', applications: ['ZZA'], words: 'apagar ZZA' }],
  ['o11_service_center_write', { action: 'module-delete', module: 'M', words: 'apagar M', execute: true }],
  ['o11_service_center_write', { action: 'application-delete', application: 'A', words: 'apagar A' }],
  ['o11_extension', { action: 'publish', spec: { name: 'E' } }], ['o11_extension', { action: 'delete', extension: 'E', words: 'apagar E' }],
  ['odc_external_library', { action: 'deploy', spec: { name: 'L' } }], ['odc_external_library', { action: 'discard', library: 'L' }],
  ...['sign-in', 'web-sign-in', 'close'].map(action => ['o11_service_center_session', { action }]),
  ['continue', { task_id: 't' }],
  ['studio_deliver', { feature: 'f' }], ['studio_deliver', { feature: 'f', until: 'merge' }],
  ...['studio_merge', 'studio_publish', 'studio_create', 'studio_close', 'studio_refresh_references', 'studio_data_insert', 'studio_data_update',
    'studio_data_delete', 'studio_dismiss_dialog', 'studio_open', 'studio_command'].map(name => [name, {}]),
  ['studio_create_app', {}], ['studio_create_app', { action: 'create', kind: 'library' }],
];
// Reads, plus writes outside any Studio (odc_write goes to the Portal API; it has its own words and operationUuid).
const NOT_LOCKED = [
  ['o11_access', { action: 'plan', manifestPath: 'C:\\m.json' }], ['o11_access', { action: 'verify' }],
  ...ENVIRONMENT_READS.map(action => ['o11_environment', { action }]),
  ['o11_studio', { command: 'status' }], ['o11_studio', { command: 'errors', args: { max: 5 } }], ['o11_studio', { command: 'windows' }],
  ['o11_studio', { command: 'publish-log' }], ['o11_studio', { command: 'publish-log', args: { module: 'M' } }],
  ['o11_studio', { command: 'snapshot' }], ['o11_studio', { command: 'snapshot', args: { path: 'C:\\s.oml' } }],
  // A29: a system module is refused before the Studio is asked, so naming one never waits in the queue.
  ['o11_studio', { command: 'open-module', args: { name: 'Users' } }], ['o11_studio', { command: 'open-module', args: { module: 'System' } }],
  ['o11_studio', { command: 'snapshot', args: { module: 'OutSystems UI' } }], ['o11_studio', { command: 'wait', args: { condition: 'open', module: 'users' } }],
  ['o11_studio', { command: 'refresh-references', args: { module: '(System)' } }],
  ['o11_studio', { command: 'wait', args: { condition: 'signed-in' } }],
  ...['read', 'read-all'].map(operation => ['o11_data', { request: { operation, entity: 'E' } }]),
  ['o11_data', { request: { batch: [{ operation: 'read', entity: 'E' }, { operation: 'read-all', entity: 'F' }] } }],
  // ssam_grant writes only the grants file, never a Studio; ssam_task without close reads.
  ['ssam_grant', { action: 'grant', lane: 'o11', app: 'A', words: 'pode publicar o A' }], ['ssam_task', { id: ID }],
  ['o11_service_center_write', { action: 'module-delete' }], ['o11_service_center_write', { action: 'verify', execute: true }],
  // A delete without words only plans; execute:false only plans even with words; execute:true without words is refused before anything.
  ['o11_service_center_write', { action: 'delete', applications: ['ZZA'] }], ['o11_service_center_write', { action: 'delete', applications: ['ZZA'], words: 'apagar ZZA', execute: false }],
  ['o11_service_center_write', { action: 'extension-delete', extension: 'E', words: '   ' }], ['o11_service_center_write', { action: 'module-delete', execute: true }],
  ['o11_service_center_write', { action: 'timer-run' }],
  ['o11_extension', { action: 'read', extension: 'E' }], ['o11_extension', { action: 'delete', extension: 'E' }],
  ['odc_external_library', { action: 'build', spec: { name: 'L' } }], ['odc_external_library', { action: 'status', library: 'L' }],
  ['o11_service_center_session', { action: 'status' }], ['o11_service_center_read', { action: 'logs' }],
  ['o11_inspect', { oml: 'C:\\x.oml' }], ['o11_inspect', { oml: 'C:\\x.oml', path: '@k1' }], ['o11_job', { job: [] }], ['o11_dependencies', { action: 'capture' }],
  ['ssam_job', { lane: 'odc', job: [] }], ['ssam_map', { lane: 'o11', target: 'C:\\x.OML' }], ['ssam_map', { lane: 'odc', target: 'M' }], ['ssam_map', { target: 'M' }],
  ['ssam_discover', { intent: 'x' }], ['ssam_discover', { lane: 'o11', intent: 'x', app: 'C:\\x.oml' }], ['ssam_discover', { lane: 'odc', app: 'M' }], ['ssam_task', {}],
  // A live O11 module named instead of a .oml: a read by key of the open tab; its capture takes the lock itself only to open
  // the module (module-map.mjs captureO11Module, atritos-b-map-lock.test.mjs).
  ['o11_inspect', { module: 'M' }], ['o11_inspect', { module: 'M', path: '@k1' }],
  ['ssam_map', { lane: 'o11', target: 'M' }], ['ssam_map', { lane: 'ss5', target: 'Orders_CS' }], ['ssam_discover', { lane: 'o11', intent: 'x', app: 'M' }],
  ['ssam_doctor', {}], ['ssam_connect', { lane: 'o11' }], ['ssam_reference', {}], ['context', {}], ['propose', { lane: 'ss5' }], ['status', {}],
  ...['snapshot', 'build', 'check-base', 'preview'].map(until => ['studio_deliver', { feature: 'f', until }]),
  ['studio_create_app', { action: 'templates' }],
  ...['studio_status', 'studio_wait', 'studio_snapshot', 'studio_inspect', 'studio_check_base', 'studio_preview', 'studio_build', 'studio_assets',
    'studio_data', 'studio_latest', 'studio_doctor', 'studio_authorize', 'studio_manifest', 'studio_consumers', 'studio_reference_snapshot',
    'studio_attach', 'odc_read', 'odc_write', 'hybrid_tenants', 'toString', 'constructor'].map(name => [name, {}]),
];

test('classification: every write tool and argument case, and reads stay out', () => {
  for (const [name, args] of WRITES) assert.equal(isWrite(name, args), true, name + ' ' + JSON.stringify(args));
  for (const [name, args] of NOT_LOCKED) assert.equal(isWrite(name, args), false, name + ' ' + JSON.stringify(args));
  assert.deepEqual(Object.keys(WRITE_TOOLS).filter(name => !WRITES.some(([n]) => n === name)), [], 'every WRITE_TOOLS entry has a case');
  // Same lists as the tools themselves: a new environment action or o11_studio command needs a decision here.
  assert.deepEqual(ENVIRONMENT_WRITES.filter(action => !isWrite('o11_environment', { action })), []);
  assert.deepEqual(COMMANDS.filter(command => isWrite('o11_studio', { command })).sort(), ['close-module', 'dismiss-dialog', 'login', 'open-module', 'refresh-references']);
  assert.deepEqual(COMMANDS.filter(c => !['status', 'wait', 'open-module', 'close-module', 'snapshot', 'errors', 'publish-log', 'windows', 'dismiss-dialog', 'login', 'refresh-references'].includes(c)), []);
  assert.equal(isWrite('o11_deliver'), true, 'no arguments: until defaults to merge');
  assert.equal(isWrite('studio_merge', null), true);
});

test('laneOfTool: the lane argument first, then the name', () => {
  assert.equal(laneOfTool('o11_deliver', {}), 'o11');
  assert.equal(laneOfTool('continue', {}), 'o11');
  assert.equal(laneOfTool('studio_merge', {}), 'odc');
  assert.equal(laneOfTool('odc_write', {}), 'odc');
  assert.equal(laneOfTool('hybrid_tenants'), 'odc');
  assert.equal(laneOfTool('ssam_map', { lane: 'o11' }), 'o11');
  assert.equal(laneOfTool('ssam_map', { lane: 'ODC' }), 'odc');
  assert.equal(laneOfTool('propose', { lane: 'ss5' }), 'o11');
  assert.equal(laneOfTool('ssam_task', {}), null);
  assert.equal(laneOfTool('ssam_job'), null);
});

test('key: O11 lane plus pid/port of the connection record; ODC pid when given; else the whole lane', () => {
  const root = tmp(); const deps = depsFor(root);
  assert.deepEqual(studioWriteTarget({ tool: 'o11_publish', args: {}, deps }), { lane: 'o11-ss4', id: null, dir: o11Locks(deps) });
  const record = { ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, port: 40001, startedUtc: new Date().toISOString(),
    studioDir: path.join(root, 'studio'), authorityDir: path.join(root, 'authority') };
  writeLock(path.join(deps.o11Root, '.local', 'connections', 'ss4.json'), record);
  // UI freeze of 2026-10-08: the queue of one Studio is shared by every root attached to it: the record's authorityDir.
  assert.deepEqual(studioWriteTarget({ tool: 'o11_publish', args: {}, lane: 'o11', deps }), { lane: 'o11-ss4', id: 'pid4242-port40001', dir: path.join(root, 'authority', 'studio-locks') });
  assert.equal(studioWriteTarget({ tool: 'continue', args: {}, lane: 'ss5', deps }).lane, 'o11-ss5');
  writeLock(path.join(deps.o11Root, '.local', 'connections', 'ss4.json'), '{broken');
  assert.equal(studioWriteTarget({ tool: 'o11_publish', args: {}, deps }).id, null, 'an unreadable record keys the whole lane');
  assert.deepEqual(studioWriteTarget({ tool: 'studio_merge', args: { pid: 77 }, lane: 'odc', deps }), { lane: 'odc', id: 'pid77', dir: odcLocks(deps) });
  assert.equal(studioWriteTarget({ tool: 'studio_merge', args: {}, deps }).id, null);
  assert.equal(studioWriteTarget({ tool: 'studio_merge', args: { pid: 77 }, studioKey: 'odc studio/9', deps }).id, 'odc_studio_9');
});

test('in process: a second write on the same Studio waits its turn and runs after the first; reads and other Studios run at once', async () => {
  const deps = depsFor(tmp());
  const gate = deferred(); const order = [];
  const first = withStudioWriteLock({ tool: 'studio_merge', args: { manifest: 'm' }, lane: 'odc', deps }, async () => { order.push('merge'); await gate.promise; order.push('merge done'); return { ok: true, result: 'entregue' }; });
  const second = withStudioWriteLock({ tool: 'studio_publish', args: { manifest: 'm', authorize: WORDS }, lane: 'odc', deps }, async () => { order.push('publish'); return { ok: true, result: 'publicado' }; });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(order, ['merge'], 'the second write waits; nothing refuses it');
  // the lock file and the queue entry carry no arguments
  const [file] = lockFiles(odcLocks(deps));
  assert.equal(file, 'odc.lock');
  const record = JSON.parse(fs.readFileSync(path.join(odcLocks(deps), file), 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['lane', 'pid', 'schema', 'startedAt', 'studio', 'token', 'tool']);
  assert.equal(record.pid, process.pid);
  const queued = queueFiles(odcLocks(deps));
  assert.equal(queued.length, 1);
  const entry = JSON.parse(fs.readFileSync(path.join(odcLocks(deps), queued[0]), 'utf8'));
  assert.deepEqual(Object.keys(entry).sort(), ['enqueuedAt', 'lane', 'pid', 'schema', 'seq', 'studio', 'token', 'tool']);
  assert.equal(entry.tool, 'studio_publish'); assert.equal(JSON.stringify(entry).includes('palavras'), false);
  // reads never wait, even on the busy Studio
  assert.equal(await withStudioWriteLock({ tool: 'studio_status', args: {}, lane: 'odc', deps }, async () => 'lido'), 'lido');
  assert.equal(await withStudioWriteLock({ tool: 'studio_deliver', args: { feature: 'f', until: 'preview' }, lane: 'odc', deps }, () => 'preview'), 'preview');
  // another lane has its own Studio
  assert.equal(await withStudioWriteLock({ tool: 'o11_publish', args: { module: 'M', authorize: WORDS }, lane: 'o11', deps }, async () => 'o11'), 'o11');
  gate.resolve();
  assert.deepEqual(await first, { ok: true, result: 'entregue' }, 'the first write answers its own result untouched');
  const published = await second;
  assert.deepEqual(order, ['merge', 'merge done', 'publish']);
  assert.equal(published.result, 'publicado');
  assert.deepEqual([published.queue.position, published.queue.holder.tool, published.queue.holder.pid], [1, 'studio_merge', process.pid]);
  assert.ok(published.queue.waitedMs >= 0);
  assert.equal(JSON.stringify(published).includes('palavras'), false);
  assert.deepEqual(lockFiles(odcLocks(deps)), []); assert.deepEqual(queueFiles(odcLocks(deps)), []);
  // free again: a write runs at once and answers without queue
  assert.equal(await withStudioWriteLock({ tool: 'studio_merge', args: {}, lane: 'odc', deps }, async () => 'de novo'), 'de novo');
});

test('in process: many simultaneous writes on one Studio run one at a time, in the order they arrived', async () => {
  const deps = depsFor(tmp());
  let running = 0, most = 0; const order = [];
  const calls = Array.from({ length: 8 }, (_, i) => withStudioWriteLock({ tool: i % 2 ? 'o11_publish' : 'o11_deliver', args: { module: 'M', authorize: WORDS }, deps },
    async () => { running++; most = Math.max(most, running); order.push(i); await new Promise(resolve => setTimeout(resolve, 5)); running--; return { ok: true, i }; }));
  const results = await Promise.all(calls);
  assert.equal(most, 1, 'never two writes on the Studio at once');
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(results.map(r => r.ok), Array(8).fill(true));
  assert.equal(results.some(r => r.code === BUSY_CODE), false);
  assert.equal(results[0].queue, undefined, 'the first one did not wait');
  assert.deepEqual(results.slice(1).map(r => r.queue.position), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(lockFiles(o11Locks(deps)), []); assert.deepEqual(queueFiles(o11Locks(deps)), []);
});

test('in process: the select of an open module never switches the tab under a running delivery: it waits for it', async () => {
  const deps = depsFor(tmp());
  const gate = deferred(); let opened = false;
  const delivery = withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A', job: [{ op: 'x' }], authorize: WORDS }, deps }, async () => { await gate.promise; return 'entregue'; });
  // write:true is the select a capture needs (module-map.mjs captureO11Module): it waits behind the delivery.
  const open = withStudioWriteLock({ tool: 'o11_inspect', args: { module: 'B' }, write: true, queue: 'o11-capture', deps }, async () => { opened = true; return { ok: true }; });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(opened, false, 'open_module B never ran during the delivery of A');
  // the capture of an open tab and a capture file are reads and run at once
  assert.equal(await withStudioWriteLock({ tool: 'o11_inspect', args: { module: 'B' }, deps }, async () => 'lido por chave'), 'lido por chave');
  assert.equal(await withStudioWriteLock({ tool: 'o11_inspect', args: { oml: 'C:\\b.oml' }, deps }, async () => 'lido'), 'lido');
  gate.resolve(); assert.equal(await delivery, 'entregue');
  const after = await open;
  assert.equal(opened, true); assert.equal(after.queue.holder.tool, 'o11_deliver');
  assert.deepEqual(lockFiles(o11Locks(deps)), []);
  // a write made inside the write that holds the Studio (the same call) runs at once, never queued behind itself
  const nested = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'A' }, deps },
    () => withStudioWriteLock({ tool: 'ssam_map', args: {}, write: true, deps, queueMs: 0 }, async () => 'dentro'));
  assert.equal(nested, 'dentro');
  // the timeout continuation names the ODC Studio of the call
  const hold = deferred();
  const first = withStudioWriteLock({ tool: 'studio_merge', args: { pid: 9 }, lane: 'odc', deps }, () => hold.promise);
  const timedOut = await withStudioWriteLock({ tool: 'studio_publish', args: { pid: 9 }, lane: 'odc', deps: { ...deps, queueMs: 0 } }, () => 'x');
  hold.resolve(); await first;
  assert.deepEqual([timedOut.continuation.tool, timedOut.continuation.arguments], ['studio_status', { pid: 9 }], 'the ODC Studio of the call');
});

test('two levels: the whole lane excludes every pid and a pid excludes the whole lane; different pids run together', async () => {
  const deps = { ...depsFor(tmp()), queueMs: 0 }; // no wait: the exclusion answers the timeout at once
  const gate = deferred();
  const pid101 = withStudioWriteLock({ tool: 'studio_merge', args: { pid: 101 }, lane: 'odc', deps }, () => gate.promise);
  assert.equal((await withStudioWriteLock({ tool: 'studio_merge', args: {}, lane: 'odc', deps }, () => 'x')).code, QUEUE_TIMEOUT_CODE);
  assert.equal((await withStudioWriteLock({ tool: 'studio_close', args: { pid: 101 }, lane: 'odc', deps }, () => 'x')).code, QUEUE_TIMEOUT_CODE);
  assert.equal(await withStudioWriteLock({ tool: 'studio_close', args: { pid: 202 }, lane: 'odc', deps }, () => 'outro Studio'), 'outro Studio');
  gate.resolve(); await pid101;
  const lane = deferred();
  const whole = withStudioWriteLock({ tool: 'studio_open', args: {}, lane: 'odc', deps }, () => lane.promise);
  assert.equal((await withStudioWriteLock({ tool: 'studio_merge', args: { pid: 101 }, lane: 'odc', deps }, () => 'x')).holder.tool, 'studio_open');
  lane.resolve(); await whole;
  assert.deepEqual(lockFiles(odcLocks(deps)), []); assert.deepEqual(queueFiles(odcLocks(deps)), []);
});

test('two levels across processes: a pid file excludes the whole lane and a lane file excludes a pid', async () => {
  const deps = { ...depsFor(tmp()), queueMs: 0 }; const dir = odcLocks(deps);
  const foreign = { schema: 'ssam-studio-write-lock/1', pid: process.ppid, tool: 'studio_publish', startedAt: new Date().toISOString(), lane: 'odc', token: 't' };
  writeLock(path.join(dir, 'odc~pid101.lock'), { ...foreign, studio: 'pid101' });
  const refused = await withStudioWriteLock({ tool: 'studio_open', args: {}, lane: 'odc', deps }, () => 'x');
  assert.deepEqual(refused.holder, { tool: 'studio_publish', pid: process.ppid, startedAt: foreign.startedAt });
  assert.deepEqual(lockFiles(dir), ['odc~pid101.lock'], 'the refused call removed its own file and left the holder\'s');
  assert.deepEqual(queueFiles(dir), [], 'and its queue entry');
  fs.unlinkSync(path.join(dir, 'odc~pid101.lock'));
  writeLock(path.join(dir, 'odc.lock'), { ...foreign, studio: null });
  assert.equal((await withStudioWriteLock({ tool: 'studio_merge', args: { pid: 101 }, lane: 'odc', deps }, () => 'x')).code, QUEUE_TIMEOUT_CODE);
  assert.deepEqual(lockFiles(dir), ['odc.lock']);
});

test('an exception in the write releases the lock', async () => {
  const deps = depsFor(tmp());
  await assert.rejects(withStudioWriteLock({ tool: 'o11_publish', args: { module: 'M' }, deps }, async () => { throw new Error('falhou'); }), /falhou/);
  await assert.rejects(withStudioWriteLock({ tool: 'o11_publish', args: { module: 'M' }, deps }, () => { throw new Error('sincrono'); }), /sincrono/);
  assert.deepEqual(lockFiles(o11Locks(deps)), []);
  assert.equal(await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'M' }, deps }, async () => 'entregue'), 'entregue');
});

test('stale locks: dead owner, too old, damaged and old, own pid not held here; a fresh damaged file or a live owner holds', async () => {
  const deps = depsFor(tmp()); const dir = o11Locks(deps); const file = path.join(dir, 'o11-ss4.lock');
  const base = { schema: 'ssam-studio-write-lock/1', tool: 'o11_publish', lane: 'o11-ss4', studio: null, token: 'old' };
  // queueMs 0: a held Studio answers the queue timeout at once instead of waiting
  const run = (extra = {}) => withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'M' }, deps: { ...deps, queueMs: 0, ...extra } }, async () => 'entregue');
  const BUSY_CODE = QUEUE_TIMEOUT_CODE;
  const dead = { alive: pid => pid !== 999999 };
  // live foreign owner (the test runner process), recent: busy
  writeLock(file, { ...base, pid: process.ppid, startedAt: new Date().toISOString() });
  assert.equal((await run()).code, BUSY_CODE);
  // the same owner, older than the deadline: recovered
  writeLock(file, { ...base, pid: process.ppid, startedAt: new Date(Date.now() - STALE_MS - 60000).toISOString() });
  assert.equal(await run(), 'entregue');
  // dead owner (injected): recovered
  writeLock(file, { ...base, pid: 999999, startedAt: new Date().toISOString() });
  assert.equal(await run(dead), 'entregue');
  // this process's pid without being held here (a leftover): recovered
  writeLock(file, { ...base, pid: process.pid, startedAt: new Date().toISOString() });
  assert.equal(await run(), 'entregue');
  // damaged and fresh: a creation in flight, busy with an unknown holder; damaged and old: recovered
  writeLock(file, '');
  assert.deepEqual((await run()).holder, { tool: null, pid: null, startedAt: null });
  const old = new Date(Date.now() - 120000); fs.utimesSync(file, old, old);
  assert.equal(await run(), 'entregue');
  // another process is breaking it right now (fresh breaker): busy, file untouched; an old breaker is cleared
  writeLock(file, { ...base, pid: 999999, startedAt: new Date().toISOString() });
  writeLock(file + '.break', '1');
  assert.equal((await run(dead)).code, BUSY_CODE);
  assert.ok(fs.existsSync(file));
  fs.utimesSync(file + '.break', old, old);
  // the old breaker is removed on this call, and the queue's next look at the lock recovers the stale file in the same call
  assert.equal(await run(dead), 'entregue');
  assert.equal(fs.existsSync(file + '.break'), false);
  assert.equal(await run(dead), 'entregue');
  assert.deepEqual(lockFiles(dir), []);
});

// ---- over MCP, with the registerTool wrapper the integrator adds to ssam.mjs (same shape, same order).
test('over MCP: parallel calls from one client; one merge runs, the second waits and answers after it, the read answers at once', async t => {
  const deps = depsFor(tmp());
  const server = new McpServer({ name: 'lock-test', version: '1.0.0' });
  const register = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => register(name, config, async (...params) => {
    const args = config?.inputSchema && params.length > 1 ? params[0] ?? {} : {};
    const lane = args.lane ?? (/^(studio_|odc_|hybrid_)/.test(name) ? 'odc' : 'o11');
    return withStudioWriteLock({ tool: name, args, lane, deps, onBusy: busyToolResult }, () => handler(...params));
  });
  const entered = deferred(); const gate = deferred(); let merges = 0;
  const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  server.registerTool('studio_merge', { inputSchema: z.object({ manifest: z.string() }).strict() },
    async () => { merges++; entered.resolve(); await gate.promise; return text({ ok: true, result: 'entregue' }); });
  server.registerTool('studio_status', { inputSchema: z.object({}).strict() }, async () => text({ ok: true, busy: true }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lock-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const first = client.callTool({ name: 'studio_merge', arguments: { manifest: 'C:\\m.json' } });
  await entered.promise;
  const second = client.callTool({ name: 'studio_merge', arguments: { manifest: 'C:\\m.json' } });
  const status = await client.callTool({ name: 'studio_status', arguments: {} });
  assert.deepEqual(status.structuredContent, { ok: true, busy: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(merges, 1, 'the second merge waits its turn');
  gate.resolve();
  assert.deepEqual((await first).structuredContent, { ok: true, result: 'entregue' });
  const after = await second;
  assert.notEqual(after.isError, true);
  assert.equal(after.structuredContent.result, 'entregue');
  assert.deepEqual([after.structuredContent.queue.position, after.structuredContent.queue.holder.tool], [1, 'studio_merge']);
  assert.deepEqual(JSON.parse(after.content[0].text), after.structuredContent, 'the text says the same');
  assert.deepEqual(lockFiles(odcLocks(deps)), []); assert.deepEqual(queueFiles(odcLocks(deps)), []);
  // a wait that runs out is shaped by onBusy like any refusal, with the status read of that Studio
  const hold = deferred();
  const holder = withStudioWriteLock({ tool: 'studio_merge', args: {}, lane: 'odc', deps }, () => hold.promise);
  const shaped = await withStudioWriteLock({ tool: 'studio_open', args: {}, lane: 'odc', deps: { ...deps, queueMs: 30 }, onBusy: busyToolResult }, async () => 'x');
  hold.resolve(); await holder;
  assert.equal(shaped.isError, true);
  assert.equal(shaped.structuredContent.code, QUEUE_TIMEOUT_CODE);
  assert.deepEqual(shaped.structuredContent.continuation, { tool: 'studio_status', arguments: {}, why: WHY });
  assert.deepEqual(JSON.parse(shaped.content[0].text), shaped.structuredContent);
});

// ---- across processes: a child node process holds the lock in the same temporary folders (pa2-f4-queue.test.mjs: the
// FIFO order of several processes, the timeout and the cancellation).
const MODULE = pathToFileURL(path.join(odcRoot, 'facade', 'studio-write-lock.mjs')).href;
const CHILD = `
const { withStudioWriteLock } = await import(process.env.LOCK_MODULE);
const value = await withStudioWriteLock({ tool: 'studio_merge', args: { manifest: 'm', authorize: 'segredo do filho' }, lane: 'odc', deps: JSON.parse(process.env.LOCK_DEPS) }, async () => {
  process.stdout.write('held\\n');
  if (process.env.LOCK_MODE === 'exit') process.exit(0);
  await new Promise(resolve => process.stdin.once('data', resolve));
  return { ok: true, result: 'entregue' };
});
process.stdout.write(JSON.stringify(value) + '\\n');
process.stdin.destroy();
`;
function holder(deps, mode) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', LOCK_MODULE: MODULE, LOCK_DEPS: JSON.stringify(deps), LOCK_MODE: mode } });
  const io = { out: '', err: '' };
  child.stdout.on('data', chunk => { io.out += chunk; });
  child.stderr.on('data', chunk => { io.err += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  const held = new Promise((resolve, reject) => {
    child.stdout.on('data', () => { if (io.out.includes('held\n')) resolve(); });
    child.once('exit', code => reject(new Error('holder exited (' + code + ') before holding: ' + io.out + io.err)));
  });
  return { child, held, exited, io };
}

test('across processes: a write waits while a child holds the lock and runs once the child releases it', { timeout: 30000 }, async () => {
  const deps = depsFor(tmp());
  const h = holder(deps, 'wait');
  await h.held;
  let ran = false;
  const waiting = withStudioWriteLock({ tool: 'studio_publish', args: { authorize: WORDS }, lane: 'odc', deps }, async () => { ran = true; return { ok: true, result: 'publicado' }; });
  const record = JSON.parse(fs.readFileSync(path.join(odcLocks(deps), 'odc.lock'), 'utf8'));
  assert.equal(record.pid, h.child.pid);
  assert.equal(JSON.stringify(record).includes('segredo'), false);
  assert.equal(await withStudioWriteLock({ tool: 'studio_status', args: {}, lane: 'odc', deps }, async () => 'lido'), 'lido');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(ran, false, 'it waits for the child');
  assert.equal(queueFiles(odcLocks(deps)).length, 1);
  h.child.stdin.write('go\n');
  assert.equal(await h.exited, 0, h.io.err);
  assert.match(h.io.out, /"result":"entregue"/);
  const value = await waiting;
  assert.equal(value.result, 'publicado');
  assert.deepEqual([value.queue.position, value.queue.holder.tool, value.queue.holder.pid], [1, 'studio_merge', h.child.pid]);
  assert.deepEqual(lockFiles(odcLocks(deps)), []); assert.deepEqual(queueFiles(odcLocks(deps)), []);
});

test('across processes: a holder killed hard leaves a stale file that the next write recovers', { timeout: 30000 }, async () => {
  const deps = depsFor(tmp());
  const h = holder(deps, 'wait');
  await h.held;
  h.child.kill();
  await h.exited;
  assert.deepEqual(lockFiles(odcLocks(deps)), ['odc.lock'], 'no finally ran in the killed process');
  assert.equal(await withStudioWriteLock({ tool: 'studio_merge', args: {}, lane: 'odc', deps }, async () => 'entregue'), 'entregue');
  assert.deepEqual(lockFiles(odcLocks(deps)), []);
});

test('across processes: a holder that exits mid-write releases on exit', { timeout: 30000 }, async () => {
  const deps = depsFor(tmp());
  const h = holder(deps, 'exit');
  await h.held;
  assert.equal(await h.exited, 0, h.io.err);
  assert.deepEqual(lockFiles(odcLocks(deps)), []);
});
