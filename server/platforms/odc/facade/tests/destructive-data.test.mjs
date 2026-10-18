import './fixtures/isolated-profile.mjs';
// CX15 W6 (2026-10-15): data deletes and the bridge passthrough never delete in one call. o11_data with a delete op, the
// CLI `ssam data --lane o11` and studio_data_delete first PREVIEW the exact records (a read by ids, or pages of the ODC
// development database until every id is found), keep the rows read as the backup and answer a confirmationToken; the
// delete runs only on a second call with that token and the owner's words, given after the preview, that name the entity
// and state the exact number of records. studio_command refuses the destructive bridge commands without calling the
// bridge. Fakes only: a fake O11 runner (no worker, no Studio), a fake bridge data service, a fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { run } from '../lanes.mjs';
import { DESTRUCTIVE_BRIDGE_COMMANDS, OWNER_REPLY, WORDS_ECHO, readOperation, readPreview, wordsSha256 } from '../destructive-operations.mjs';
import { DATA_PREVIEW_MAX_ROWS, cliDataDelete, studioDataDelete } from '../data-delete-gate.mjs';

// No Studio process, vault entry or prompt is ever touched (lib.mjs offline()).
process.env.SSAM_ODC_OFFLINE = '1';

const T0 = Date.parse('2026-10-15T12:00:00Z');
function fakeClock() { let t = T0; const now = () => t; now.advance = ms => { t += ms; return t; }; return now; }
let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);
const allFiles = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, String(f))).filter(f => fs.statSync(f).isFile()) : []);
// Nothing the destructive root keeps (previews, records, seen words, backups) holds the owner's words, only their sha256.
function assertNoWords(dir, ...phrases) {
  for (const file of allFiles(dir)) {
    const body = fs.readFileSync(file, 'utf8').toLowerCase();
    for (const phrase of phrases) assert.ok(!body.includes(phrase.toLowerCase()), `${file} holds the words "${phrase}"`);
  }
}

// ---- o11_data through the ssam server (harness of pacote-laneC-data.test.mjs): the runner fakes the kernel `data`
// command; a read by ids answers the rows of `table` that exist, a delete removes them.
const target = { host: 'dev.example.test', module: 'Orders_CS', oml: 'C:\\captures\\Orders_CS.oml' };
const customer = id => ({ Id: String(id), Name: 'Customer ' + id + ' Ltda', Email: `c${id}@example.test` });
function kernel(table) {
  const resultOf = op => {
    if (op.operation === 'read') return { ok: true, count: 0, records: (op.ids ?? []).map(String).filter(id => table.has(id)).map(id => table.get(id)), operation: 'read', entity: op.entity };
    if (op.operation === 'delete') { for (const id of op.ids) table.delete(String(id)); return { ok: true, reports: op.ids.map(id => ({ recordId: String(id), status: 'Success', error: null })), receipt: 'C:\\work\\receipts\\x.json', operation: 'delete', entity: op.entity }; }
    if (op.operation === 'insert') return { ok: true, ids: op.records.map((_, i) => 'n' + i), operation: 'insert', entity: op.entity };
    return { ok: true, operation: op.operation, entity: op.entity };
  };
  return request => {
    const ops = Array.isArray(request.batch) ? request.batch : [request];
    const results = ops.map(resultOf);
    return { ok: true, exitCode: 0, via: 'worker', wallMs: 3, stderr: [], envelope: { ok: true, command: 'data', data: { ok: true, host: target.host, module: target.module, submitted: results.length, total: results.length, results } } };
  };
}
async function harness(t, table = new Map([1, 2, 3, 4].map(id => [String(id), customer(id)]))) {
  const dataRoot = tmp('cx15-w6-data-'); const destructiveRoot = tmp('cx15-w6-root-');
  const now = fakeClock();
  const calls = [];
  const answer = kernel(table); const state = { override: null };
  const runAnvil = async args => { const request = JSON.parse(fs.readFileSync(args[args.indexOf('--request') + 1], 'utf8')); calls.push({ args, request }); return (state.override?.(request) ?? answer(request)); };
  const server = await createSsamServer({ odc: false, deps: { runAnvil, dataRoot, answersRoot: dataRoot, lock: { o11Root: dataRoot, odcRoot: dataRoot, connection: () => null },
    destructive: { now, root: destructiveRoot, uuid } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15-w6', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); for (const dir of [dataRoot, destructiveRoot]) fs.rmSync(dir, { recursive: true, force: true }); });
  const call = async request => valueOf(await client.callTool({ name: 'o11_data', arguments: { ...target, request } }));
  const ops = kind => calls.flatMap(c => (Array.isArray(c.request.batch) ? c.request.batch : [c.request])).filter(op => op.operation === kind);
  return { call, calls, ops, now, table, destructiveRoot, state };
}
const REQUEST_WORDS = 'apaga os clientes de teste';

test('o11_data delete without confirmationToken: one read by ids, no delete; the preview lists each record, keeps no row and answers the token', async t => {
  const { call, calls, ops, destructiveRoot } = await harness(t);
  const opId = '7a1c4e1e-1111-4111-8111-111111111111';
  const preview = await call({ operation: 'delete', entity: 'Customer', ids: ['1', '2', '9'], operationId: opId, authorization: REQUEST_WORDS });
  // The incident case: words came with the request, so the answer is a refusal that IS the preview.
  assert.equal(preview.ok, false); assert.equal(preview.code, 'CONFIRMATION_REQUIRED');
  assert.match(preview.error, /two calls now/);
  assert.equal(calls.length, 1, 'one kernel call: the read');
  assert.deepEqual(calls[0].request, { operation: 'read', entity: 'Customer', ids: ['1', '2', '9'] });
  assert.equal(ops('delete').length, 0, 'nothing deleted');
  assert.equal(preview.state, 'previewed'); assert.equal(preview.count, 2);
  assert.deepEqual(preview.items.map(i => [i.kind, i.key, i.name]), [['record', '1', 'Customer 1'], ['record', '2', 'Customer 2']]);
  assert.deepEqual(preview.absent, ['9'], 'an id that is not in the table is absent: listed apart, never deleted');
  assert.deepEqual(preview.mustName, ['Customer']);
  assert.notEqual(preview.operationId, opId, 'the execution takes the operationId of the preview');
  // CX15 r2 (C6): the preview keeps no row (an unconfirmed preview leaves no data in the profile); the execution backs them up.
  assert.equal(preview.backup, undefined);
  assert.equal(fs.existsSync(path.join(destructiveRoot, 'backups', preview.operationId)), false, 'no backup folder for a preview');
  // The exact next call: the same request without the ids, with the token, the operationId of the preview and the owner's reply.
  const next = preview.continuation;
  assert.equal(next.tool, 'o11_data');
  assert.deepEqual(next.arguments.request, { operation: 'delete', entity: 'Customer', operationId: preview.operationId, confirmationToken: preview.confirmationToken,
    authorization: OWNER_REPLY });
  assert.deepEqual({ host: next.arguments.host, module: next.arguments.module, oml: next.arguments.oml }, target);
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 4096, 'the preview fits the plan budget: ' + Buffer.byteLength(JSON.stringify(preview)));
  assertNoWords(destructiveRoot, REQUEST_WORDS);
  // Without words the preview is not a refusal.
  const quiet = await call({ operation: 'delete', entity: 'Customer', ids: ['3'] });
  assert.equal(quiet.ok, true); assert.equal(quiet.code, undefined); assert.equal(quiet.count, 1);
  assert.equal(ops('delete').length, 0);
});

test('o11_data delete with the token and the owner\'s words (entity + count) after 5 s sends today\'s request, once; the record says each record was deleted', async t => {
  const { call, calls, ops, now, table, destructiveRoot } = await harness(t);
  const preview = await call({ operation: 'delete', entity: 'Customer', ids: ['1', '2', '3'] });
  now.advance(6000);
  const words = 'pode apagar os 3 registros de Customer';
  const done = await call({ ...preview.continuation.arguments.request, authorization: words });
  assert.equal(done.ok, true, JSON.stringify(done));
  const deletes = ops('delete');
  assert.equal(deletes.length, 1, 'exactly one delete');
  // CX15 r2 (C6): the kernel needs a nonempty authorization only: it gets the sha256 of the words, never the words.
  assert.deepEqual(deletes[0], { operation: 'delete', entity: 'Customer', ids: ['1', '2', '3'], operationId: preview.operationId, authorization: 'sha256:' + wordsSha256(words) },
    'today\'s request: the ids of the token, the operationId of the preview, the sha256 of the owner\'s words; no confirmationToken, no ownerRequest');
  assert.ok(calls.every(c => !JSON.stringify(c.request).includes(words)), 'no request file of the kernel holds the words');
  assert.equal(calls.length, 3, 'the preview read, the read again before the delete, the delete');
  assert.deepEqual([...table.keys()], ['4']);
  assert.equal(done.operation.state, 'completed');
  assert.deepEqual(done.operation.deleted, ['Customer 1', 'Customer 2', 'Customer 3']);
  const record = readOperation(preview.operationId, { root: destructiveRoot });
  assert.deepEqual(record.items.map(i => i.state), ['deleted', 'deleted', 'deleted']);
  assert.ok(record.items[0].backup.files[0].path.startsWith(path.join(destructiveRoot, 'backups', preview.operationId)));
  assert.equal(done.lane, 'o11'); assert.equal(done.verb, 'data'); assert.deepEqual(done.result.data.results[0].reports.length, 3);
  // The same token again answers by the record, never sends again.
  now.advance(1000);
  const again = await call({ ...preview.continuation.arguments.request, authorization: words });
  assert.equal(ops('delete').length, 1, 'never sent again');
  assert.equal(again.operation.state, 'completed'); assert.equal(again.outcome, 'not-sent');
  assertNoWords(destructiveRoot, words);
  // CX15 r2 (L5): one seen-words file per day under the host's folder.
  const seenDay = path.join(destructiveRoot, 'seen-words', 'dev.example.test', fs.readdirSync(path.join(destructiveRoot, 'seen-words', 'dev.example.test'))[0]);
  assert.ok(fs.readFileSync(seenDay, 'utf8').includes(wordsSha256(words)), 'only the sha256 of the words');
});

test('o11_data: the words must state the count and name the entity, come after the preview and not too soon; ids never come with the token', async t => {
  const { call, ops, now } = await harness(t);
  const preview = await call({ operation: 'delete', entity: 'Customer', ids: ['1', '2'], authorization: 'apaga os 2 registros de Customer' });
  const confirm = (words, extra = {}) => call({ ...preview.continuation.arguments.request, authorization: words, ...extra });
  const soon = await confirm('sim, apaga os 2 registros de Customer');
  assert.equal(soon.code, 'CONFIRMATION_TOO_SOON');
  now.advance(6000);
  const noCount = await confirm('pode apagar os registros de Customer');
  assert.equal(noCount.ok, false); assert.equal(noCount.code, 'CONFIRMATION_COUNT_MISMATCH');
  const wrongCount = await confirm('pode apagar os 3 registros de Customer');
  assert.equal(wrongCount.code, 'CONFIRMATION_COUNT_MISMATCH');
  const noEntity = await confirm('pode apagar os 2 registros');
  assert.equal(noEntity.code, 'WORDS_MUST_NAME'); assert.equal(noEntity.problems[0].target, 'Customer');
  const before = await confirm('apaga os 2 registros de Customer');
  assert.ok(before.problems.some(p => p.code === 'WORDS_BEFORE_PREVIEW'), 'the words of the preview call never confirm it');
  const withIds = await confirm('sim, pode apagar os 2 de Customer', { ids: ['1', '2'] });
  assert.ok(withIds.problems.some(p => p.code === 'SELECTION_ONLY_IN_PREVIEW'));
  const otherId = await confirm('sim, pode apagar os 2 de Customer', { operationId: '7a1c4e1e-9999-4999-8999-999999999999' });
  assert.ok(otherId.problems.some(p => p.code === 'PREVIEW_OTHER_TARGET'));
  const otherEntity = await confirm('sim, pode apagar os 2 de Order', { entity: 'Order' });
  assert.ok(otherEntity.problems.some(p => p.code === 'PREVIEW_OTHER_TARGET'));
  // All of it at once: one refusal with every problem.
  const all = await confirm('vai la deleta', { ids: ['1'] });
  assert.deepEqual(new Set(all.problems.map(p => p.code)), new Set(['SELECTION_ONLY_IN_PREVIEW', 'CONFIRMATION_COUNT_MISMATCH', 'WORDS_MUST_NAME']));
  assert.match(all.error, /3 problem\(s\); nothing was sent/);
  assert.equal(ops('delete').length, 0, 'no refusal sent a delete');
});

test('o11_data: the backup fails before the delete -> BACKUP_FAILED, nothing sent; a lost answer -> uncertain, and the same token never resends', async t => {
  const { call, ops, now, destructiveRoot, state } = await harness(t);
  const preview = await call({ operation: 'delete', entity: 'Customer', ids: ['1'] });
  // The file of the backup taken just before the delete cannot be written (a folder holds its name).
  fs.mkdirSync(path.join(destructiveRoot, 'backups', preview.operationId, 'Customer-before-delete.json'), { recursive: true });
  now.advance(6000);
  const failed = await call({ ...preview.continuation.arguments.request, authorization: 'pode apagar o 1 registro de Customer' });
  assert.equal(failed.ok, false); assert.equal(failed.code, 'BACKUP_FAILED'); assert.equal(failed.outcome, 'not-sent');
  assert.equal(ops('delete').length, 0);
  assert.equal(readOperation(preview.operationId, { root: destructiveRoot }).items[0].state, 'backup-failed');
  // A delete whose answer is lost: the record says uncertain; repeating the token answers by the record, never resends.
  const second = await call({ operation: 'delete', entity: 'Customer', ids: ['2'] });
  now.advance(6000);
  state.override = request => (request.operation === 'delete' ? { ok: false, unknown: true, timedOut: true, code: 'WORKER_OUTCOME_UNKNOWN', envelope: null, stderr: ['no reply'] } : null);
  const lost = await call({ ...second.continuation.arguments.request, authorization: 'sim, apaga o 1 registro de Customer' });
  assert.equal(lost.ok, false); assert.equal(lost.outcome, 'uncertain'); assert.equal(lost.operation.state, 'uncertain');
  assert.deepEqual(lost.operation.uncertain, ['Customer 2']);
  state.override = null;
  now.advance(1000);
  const again = await call({ ...second.continuation.arguments.request, authorization: 'sim, apaga o 1 registro de Customer' });
  assert.equal(again.ok, false); assert.equal(again.code, 'CONFIRMATION_ALREADY_USED'); assert.equal(again.outcome, 'not-sent');
  assert.equal(ops('delete').length, 1, 'the uncertain delete was sent once, never again');
});

test('o11_data: a record gone between the preview and the execution is PREVIEW_STALE with a new preview, and nothing is deleted', async t => {
  const { call, ops, now, table } = await harness(t);
  const preview = await call({ operation: 'delete', entity: 'Customer', ids: ['1', '2', '3'] });
  table.delete('2');
  now.advance(6000);
  const stale = await call({ ...preview.continuation.arguments.request, authorization: 'pode apagar os 3 registros de Customer' });
  assert.equal(stale.ok, false); assert.equal(stale.code, 'PREVIEW_STALE');
  assert.deepEqual(stale.problems.find(p => p.code === 'PREVIEW_STALE').diff.removed, ['Customer 2']);
  assert.equal(stale.preview.count, 2);
  assert.notEqual(stale.preview.confirmationToken, preview.confirmationToken);
  assert.equal(stale.continuation.arguments.request.confirmationToken, stale.preview.confirmationToken);
  assert.equal(ops('delete').length, 0);
  // The new preview confirms with its own count.
  now.advance(6000);
  const done = await call({ ...stale.continuation.arguments.request, authorization: 'ok, apaga os 2 registros de Customer' });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.deepEqual(ops('delete')[0].ids, ['1', '3']);
});

test('o11_data batch with mixed writes: the preview sends nothing (not even the insert); only the delete op needs a token, each with its own', async t => {
  const { call, calls, ops, now } = await harness(t);
  const batch = { authorization: 'grava o cliente novo e apaga o 4', batch: [
    { step: 'new', operation: 'insert', entity: 'Customer', operationId: '7a1c4e1e-2222-4222-8222-222222222222', records: [{ Name: 'Novo' }] },
    { step: 'gone', operation: 'delete', entity: 'Customer', ids: ['4'] },
    { operation: 'read', entity: 'Customer', ids: ['1'] }] };
  const preview = await call(batch);
  assert.equal(preview.code, 'CONFIRMATION_REQUIRED');
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].request, { operation: 'read', entity: 'Customer', ids: ['4'] }, 'only the read of the delete\'s ids');
  assert.equal(ops('insert').length, 0); assert.equal(ops('delete').length, 0);
  const request = preview.continuation.arguments.request;
  // CX15 r6 (M-1, the r5 conversion made honest): the continuation never gives the words back: the marker is in their place
  // and the step says the owner must fill it (askOwner). Replayed as it is, nothing runs (below).
  assert.equal(request.authorization, WORDS_ECHO, 'the batch words are the marker for the insert');
  assert.deepEqual(request.batch[0], batch.batch[0], 'the insert is unchanged: it needs no token');
  assert.deepEqual(request.batch[1], { step: 'gone', operation: 'delete', entity: 'Customer', operationId: preview.operationId, confirmationToken: preview.confirmationToken,
    authorization: OWNER_REPLY });
  now.advance(6000);
  request.batch[1].authorization = 'sim, apaga o 1 registro de Customer';
  // The continuation replayed as it is (only the owner's reply for the delete filled): WORDS_REQUIRED, nothing sent.
  const sentBefore = calls.length;
  const replayed = await call(structuredClone(request));
  assert.equal(replayed.code, 'WORDS_REQUIRED', JSON.stringify(replayed).slice(0, 300)); assert.equal(calls.length, sentBefore, 'nothing reached the kernel');
  assert.equal(ops('insert').length, 0); assert.equal(ops('delete').length, 0);
  assert.match(preview.continuation.why, /; request\/authorization: the owner's own words in place of the marker$/ /* CX15 r7 (L-8, converted): English */);
  assert.deepEqual(preview.continuation.askOwner?.fields, ['request/authorization']);
  // With the owner's words where the marker is, it runs and the kernel gets their sha256.
  request.authorization = batch.authorization;
  const done = await call(request);
  assert.equal(done.ok, true, JSON.stringify(done));
  const sent = calls.at(-1).request;
  assert.deepEqual(sent.batch.map(op => op.operation), ['insert', 'delete', 'read'], 'the batch as asked, one kernel call');
  // CX15 r2 (C6): every authorization of a request that passes through the gate reaches the kernel as its sha256.
  assert.deepEqual(sent.batch[1], { step: 'gone', operation: 'delete', entity: 'Customer', ids: ['4'], operationId: preview.operationId, authorization: 'sha256:' + wordsSha256('sim, apaga o 1 registro de Customer') });
  assert.deepEqual(sent.batch[0], batch.batch[0]);
  assert.equal(sent.authorization, 'sha256:' + wordsSha256(batch.authorization));
  // A batch without a delete is not previewed (today's path).
  const before = calls.length;
  const plain = await call({ authorization: 'grava', batch: [{ operation: 'insert', entity: 'Customer', operationId: '7a1c4e1e-3333-4333-8333-333333333333', records: [{ Name: 'X' }] }] });
  assert.equal(plain.ok, true); assert.equal(calls.length, before + 1); assert.equal(plain.state, undefined);
});

test('the o11_data schema takes confirmationToken and ownerRequest on an op, and an op delete without ids', async t => {
  const { call, ops } = await harness(t);
  const preview = await call({ operation: 'delete', entity: 'Customer', ids: ['1'], ownerRequest: 'apaga o cliente 1' });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  const next = await call({ ...preview.continuation.arguments.request, authorization: 'apaga o cliente 1' });
  assert.ok(next.problems.some(p => p.code === 'WORDS_BEFORE_PREVIEW'), 'the owner request never confirms');
  assert.equal(ops('delete').length, 0);
});

// ---- the CLI `ssam data --lane o11` (lanes.mjs run, verb data): the same gate before the kernel.
test('ssam data --lane o11 with a delete op and no token: the preview through a read, no delete reaches the kernel', async () => {
  const cwd = tmp('cx15-w6-cli-'); const destructiveRoot = tmp('cx15-w6-cli-root-');
  const table = new Map([1, 2].map(id => [String(id), customer(id)]));
  const answer = kernel(table);
  const sent = [];
  const send = async argv => { const request = JSON.parse(fs.readFileSync(argv[argv.indexOf('--request') + 1], 'utf8')); sent.push({ argv, request }); return { ok: true, lane: 'o11', verb: 'data', exitCode: 0, result: answer(request).envelope }; };
  const file = path.join(cwd, 'delete.json');
  fs.writeFileSync(file, JSON.stringify({ operation: 'delete', entity: 'Customer', ids: ['1', '2'], operationId: '7a1c4e1e-4444-4444-8444-444444444444', authorization: 'apaga' }));
  const args = ['--studio', '--host', target.host, '--module', target.module, '--oml', target.oml, '--request', file];
  const now = fakeClock();
  const preview = await run('o11', 'data', args, { dataDeps: { send, cwd, now, root: destructiveRoot, uuid } });
  assert.equal(preview.ok, false); assert.equal(preview.code, 'CONFIRMATION_REQUIRED'); assert.equal(preview.count, 2);
  assert.equal(sent.length, 1); assert.deepEqual(sent[0].request, { operation: 'read', entity: 'Customer', ids: ['1', '2'] });
  assert.deepEqual(sent[0].argv.slice(0, 7), args.slice(0, 7), 'the same line, another request file');
  assert.equal(table.size, 2, 'nothing deleted');
  // The confirmation: the request it gives, with the owner's words, in a file, the same line.
  now.advance(6000);
  fs.writeFileSync(file, JSON.stringify({ ...preview.confirmRequest, authorization: 'pode apagar os 2 registros de Customer' }));
  const done = await run('o11', 'data', args, { dataDeps: { send, cwd, now, root: destructiveRoot, uuid } });
  assert.equal(done.ok, true, JSON.stringify(done)); assert.equal(table.size, 0);
  assert.deepEqual(sent.at(-1).request, { operation: 'delete', entity: 'Customer', ids: ['1', '2'], operationId: preview.operationId, authorization: 'sha256:' + wordsSha256('pode apagar os 2 registros de Customer') });
  assert.equal(done.operation.state, 'completed');
  // A request without a delete is not the gate's: null, nothing sent, and run goes on to the kernel as today.
  fs.writeFileSync(file, JSON.stringify({ operation: 'read', entity: 'Customer', ids: ['1'] }));
  const before = sent.length;
  assert.equal(await cliDataDelete(args, { send, cwd, now, root: destructiveRoot, uuid }), null);
  assert.equal(sent.length, before);
  for (const dir of [cwd, destructiveRoot]) fs.rmSync(dir, { recursive: true, force: true });
});

// ---- studio_data_delete through the facade server: a fake bridge data service with pages of at most `limit` rows.
function bridgeData(rows) {
  const calls = [];
  const studioData = async ({ op, module, entity, limit, offset, ids, authorize, pid }) => {
    calls.push({ op, module, entity, limit, offset, ids, authorize, pid });
    if (op === 'read') {
      const page = rows.slice(offset ?? 0, (offset ?? 0) + (limit ?? 100));
      return { ok: true, module: 'Shop', entity: 'Product', owner: 'own', tenant: 'personal-test.outsystems.dev', offset, limit, count: page.length, more: page.length >= (limit ?? 100), records: page };
    }
    if (op === 'delete') {
      for (const id of ids) rows.splice(rows.findIndex(r => r.Id === String(id)), 1);
      return { ok: true, module: 'Shop', entity: 'Product', operation: 'data-delete', count: ids.length, failed: 0, reports: ids.map(id => ({ recordId: String(id), status: 'Success', error: null })), evidence: 'journal\\data\\x.json' };
    }
    throw new Error('unexpected op ' + op);
  };
  return { studioData, calls };
}
async function facade(t, deps) {
  const server = await createFacadeServer({ deps });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15-w6-odc', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
const products = n => Array.from({ length: n }, (_, i) => ({ Id: String(i + 1), Name: 'Product ' + (i + 1) }));

test('studio_data_delete without a token reads pages until every id is found: an id not in the table is absent, nothing is deleted', async t => {
  const rows = products(6000); const { studioData, calls } = bridgeData(rows);
  const root = tmp('cx15-w6-odc-'); const now = fakeClock();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = await facade(t, { studioData, destructive: { now, root, uuid } });
  const preview = valueOf(await client.callTool({ name: 'studio_data_delete', arguments: { module: 'Shop', entity: 'Product', ids: ['10', 5500, '99999'], authorize: 'apaga esses produtos' } }));
  assert.equal(preview.code, 'CONFIRMATION_REQUIRED'); assert.equal(preview.count, 2);
  assert.deepEqual(calls.map(c => [c.op, c.offset, c.limit]), [['read', 0, 5000], ['read', 5000, 5000]], 'pages of the Studio data service until the end of the table');
  assert.deepEqual(preview.items.map(i => i.name), ['Product 10', 'Product 5500']);
  assert.deepEqual(preview.absent, ['99999']);
  assert.equal(preview.scanned, 6000);
  // CX15 r2 (C6): the preview keeps no row; the execution backs up the rows it reads again.
  assert.equal(preview.backup, undefined);
  assert.equal(fs.existsSync(path.join(root, 'backups', preview.operationId)), false);
  assert.equal(calls.filter(c => c.op === 'delete').length, 0);
  assert.equal(preview.continuation.tool, 'studio_data_delete');
  assert.deepEqual(preview.continuation.arguments, { module: 'Shop', entity: 'Product', confirmationToken: preview.confirmationToken, authorize: OWNER_REPLY });
  // The confirmation: the pages read again, exactly one delete with the ids of the token.
  now.advance(6000);
  const words = 'pode apagar os 2 registros de Product';
  const done = valueOf(await client.callTool({ name: 'studio_data_delete', arguments: { ...preview.continuation.arguments, authorize: words } }));
  assert.equal(done.ok, true, JSON.stringify(done));
  const deletes = calls.filter(c => c.op === 'delete');
  assert.equal(deletes.length, 1);
  // CX15 r3 (CT-6): the bridge gets the sha256 of the owner's words, never the words.
  assert.deepEqual([deletes[0].module, deletes[0].entity, deletes[0].ids, deletes[0].authorize], ['Shop', 'Product', ['10', '5500'], 'sha256:' + wordsSha256(words)]);
  assert.equal(done.operation.state, 'completed'); assert.deepEqual(done.operation.deleted, ['Product 10', 'Product 5500']);
  assert.deepEqual(JSON.parse(fs.readFileSync(done.backup.path, 'utf8')).records, [{ Id: '10', Name: 'Product 10' }, { Id: '5500', Name: 'Product 5500' }], 'the execution backed up the rows read again');
  assert.equal(rows.length, 5998);
  // A second time: by the record, nothing sent.
  now.advance(1000);
  const again = valueOf(await client.callTool({ name: 'studio_data_delete', arguments: { ...preview.continuation.arguments, authorize: words } }));
  assert.equal(calls.filter(c => c.op === 'delete').length, 1); assert.equal(again.outcome, 'not-sent');
  assertNoWords(root, words, 'apaga esses produtos');
});

test('studio_data_delete: ids with the token, words without the count, a record gone: one refusal each, no delete', async t => {
  const rows = products(30); const { studioData, calls } = bridgeData(rows);
  const root = tmp('cx15-w6-odc-'); const now = fakeClock();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const client = await facade(t, { studioData, destructive: { now, root, uuid } });
  const preview = valueOf(await client.callTool({ name: 'studio_data_delete', arguments: { module: 'Shop', entity: 'Product', ids: ['1', '2'] } }));
  assert.equal(preview.ok, true); assert.equal(preview.count, 2);
  now.advance(6000);
  const call = async args => valueOf(await client.callTool({ name: 'studio_data_delete', arguments: { ...preview.continuation.arguments, ...args } }));
  const withIds = await call({ ids: ['1', '2'], authorize: 'apaga os 2 de Product' });
  assert.equal(withIds.code, 'SELECTION_ONLY_IN_PREVIEW');
  const noCount = await call({ authorize: 'apaga os registros de Product' });
  assert.equal(noCount.code, 'CONFIRMATION_COUNT_MISMATCH');
  const noEntity = await call({ authorize: 'apaga os 2' });
  assert.equal(noEntity.code, 'WORDS_MUST_NAME');
  rows.splice(0, 1);
  const stale = await call({ authorize: 'apaga os 2 de Product' });
  assert.equal(stale.code, 'PREVIEW_STALE'); assert.equal(stale.preview.count, 1);
  assert.equal(calls.filter(c => c.op === 'delete').length, 0);
  // No ids and no token: nothing to preview.
  const empty = valueOf(await client.callTool({ name: 'studio_data_delete', arguments: { module: 'Shop', entity: 'Product' } }));
  assert.equal(empty.ok, false); assert.equal(empty.code, 'DATA_REQUEST_INVALID');
  // Every id absent: nothing to delete, no token.
  const none = valueOf(await client.callTool({ name: 'studio_data_delete', arguments: { module: 'Shop', entity: 'Product', ids: ['777'] } }));
  assert.equal(none.code, 'TARGET_NOT_FOUND'); assert.equal(none.confirmationToken, undefined); assert.deepEqual(none.absent, ['777']);
});

test('studio_data_delete: past DATA_PREVIEW_MAX_ROWS an id not found is unverified (not proven absent) and never deleted', async () => {
  assert.equal(DATA_PREVIEW_MAX_ROWS, 10000);
  const rows = products(50); const { studioData, calls } = bridgeData(rows);
  const root = tmp('cx15-w6-odc-');
  const preview = await studioDataDelete({ module: 'Shop', entity: 'Product', ids: ['3', '45'] }, { studioData, now: T0, root, uuid, maxRows: 20, pageSize: 10 });
  assert.deepEqual(calls.map(c => c.offset), [0, 10]);
  assert.deepEqual(preview.items.map(i => i.key), ['3']); assert.deepEqual(preview.unverified, ['45']); assert.equal(preview.absent, undefined);
  assert.equal(preview.scanned, 20);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- studio_command: the destructive bridge commands never pass; the others as today.
test('studio_command refuses data-delete, portal-call, portal-private-call and portal-api-client-fixture-cleanup without calling the bridge; publish-log and module-info as today', async t => {
  const calls = [];
  const studio = async (args, pid) => { calls.push([args, pid]); return args[0] === 'publish-log' ? { ok: true, module: 'Shop', found: false, source: 'ServerMessagesPane' } : { ok: true, module: 'Shop', echo: args }; };
  const client = await facade(t, { studio });
  for (const command of DESTRUCTIVE_BRIDGE_COMMANDS) {
    const refused = valueOf(await client.callTool({ name: 'studio_command', arguments: { command, args: ['Shop', 'Product'] } }));
    assert.equal(refused.ok, false); assert.equal(refused.code, 'DESTRUCTIVE_NEEDS_DEDICATED_TOOL', command);
    assert.equal(refused.outcome, 'not-sent'); assert.ok(refused.continuation.tool, command);
  }
  // What the bridge would read as one of them (spaces, the command inside the text, upper case) is refused too.
  for (const [command, args] of [[' data-delete', ['Shop']], ['data-delete Shop Product --ids 1', []], ['DATA-DELETE', []], [' ', ['portal-call', 'x.json']]]) {
    const refused = valueOf(await client.callTool({ name: 'studio_command', arguments: { command, args } }));
    assert.equal(refused.code, 'DESTRUCTIVE_NEEDS_DEDICATED_TOOL', JSON.stringify([command, args]));
  }
  assert.equal(calls.length, 0, 'the bridge was never called');
  const info = valueOf(await client.callTool({ name: 'studio_command', arguments: { command: 'module-info', args: ['Shop'], pid: 42 } }));
  assert.deepEqual(calls[0], [['module-info', 'Shop'], 42]); assert.equal(info.ok, true);
  const log = valueOf(await client.callTool({ name: 'studio_command', arguments: { command: 'publish-log', args: ['Shop'] } }));
  assert.deepEqual(calls[1], [['publish-log', 'Shop'], undefined]); assert.equal(log.continuation.tool, 'odc_read', 'publish-log shaped by studioPublishLog as today');
  assert.equal(calls.length, 2);
});

test('the studio_data_delete schema: ids and authorize optional (the execution takes neither ids), confirmationToken and ownerRequest added', async t => {
  const client = await facade(t, {});
  const tool = (await client.listTools()).tools.find(x => x.name === 'studio_data_delete');
  assert.deepEqual(tool.inputSchema.required ?? [], ['module', 'entity']);
  for (const field of ['ids', 'authorize', 'confirmationToken', 'ownerRequest', 'pid']) assert.ok(tool.inputSchema.properties[field], field);
  const o11 = await createSsamServer({ odc: false, deps: {} });
  const [a, b] = InMemoryTransport.createLinkedPair(); const c = new Client({ name: 'x', version: '1' });
  await Promise.all([o11.connect(a), c.connect(b)]);
  try {
    const data = (await c.listTools()).tools.find(x => x.name === 'o11_data');
    const single = data.inputSchema.properties.request.anyOf[0];
    for (const field of ['confirmationToken', 'ownerRequest']) assert.ok(single.properties[field], field);
    assert.ok(data.inputSchema.properties.request.anyOf[1].properties.batch.items.properties.confirmationToken);
  } finally { await c.close(); await o11.close(); }
  assert.ok(readPreview, 'imported');
});

// CX15 W8 (principal): a preview of many records fits the answer budget of a preview without words (ok:true, 4096 B):
// the shared backup plan is said once (itemBackup) and every record keeps its name.
test('a preview of 40 records without words fits 4096 bytes through the ssam server and names every record', async t => {
  const table = new Map(Array.from({ length: 40 }, (_, i) => [String(i + 1), customer(i + 1)]));
  const h = await harness(t, table);
  const ids = [...table.keys()];
  const reply = await h.call({ operation: 'delete', entity: 'Customer', ids });
  assert.deepEqual([reply.ok, reply.state, reply.count, reply.items.length], [true, 'previewed', 40, 40]);
  const bytes = Buffer.byteLength(JSON.stringify(reply), 'utf8');
  t.diagnostic(`o11_data preview of 40 records: ${bytes} bytes`);
  assert.ok(bytes <= 4096, `${bytes} bytes`);
  for (const id of ids) assert.ok(reply.items.some(i => i.key === id), id);
  assert.equal(h.ops('delete').length, 0);
});
