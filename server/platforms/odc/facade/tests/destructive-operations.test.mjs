import './fixtures/isolated-profile.mjs';
// CX15 (2026-10-15): the common module of every destructive verb (destructive-operations.mjs). A delete is never one
// step: a preview with the exact list, a confirmationToken bound to that list and host, the owner's words given AFTER the
// preview with the exact count, a durable record per item. Offline: temporary roots, a fake clock, no tool.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CONFIRM_MIN_AGE_MS, DESTRUCTIVE_BRIDGE_COMMANDS, PREVIEW_TTL_MS, SEEN_WORDS_WINDOW_MS, beginOperation, checkExecute, countProblem, createPreview,
  dedicatedToolRefusal, derivedOperationId, destructivePhase, destructiveRoot, endOperation, listOperations, markItem, noteWords, normalizeWords,
  readOperation, readPreview, storeBackup, summarizeOperation, wordsSha256,
} from '../destructive-operations.mjs';
import { derivedOperationId as engineDerived } from '../service-center/delete.mjs';

const HOST = 'personal-0000test.outsystemscloud.com';
const T0 = Date.parse('2026-10-15T12:00:00Z');
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cx15-destructive-'));
const apps = () => [
  { kind: 'application', key: 'k-a', name: 'ZZDC Alpha', application: 'ZZDC Alpha', cascade: ['ZZDCAlpha_CS', 'ZZDCAlpha_UI'], consumers: [], backup: { possible: true, how: 'published OML of 2 modules' } },
  { kind: 'application', key: 'k-b', name: 'ZZDC Beta', application: 'ZZDC Beta', cascade: [], consumers: ['ZZDC Alpha'], backup: { possible: true, how: 'no modules' } },
];
let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
const preview = (dir, over = {}) => createPreview({ tool: 'o11_service_center_write', lane: 'o11', host: HOST, operation: 'delete', selection: { prefix: 'ZZDC', prefixKind: 'application' },
  items: apps(), now: T0, root: dir, uuid, ...over });
const execute = (dir, block, over = {}) => checkExecute({ token: block.confirmationToken, tool: 'o11_service_center_write', host: HOST, operation: 'delete',
  words: 'sim, apaga os 2 ZZDC', now: T0 + CONFIRM_MIN_AGE_MS, root: dir, uuid, ...over });
const codes = result => result.problems.map(p => p.code);
const allFiles = dir => fs.readdirSync(dir, { recursive: true }).map(f => path.join(dir, String(f))).filter(f => fs.statSync(f).isFile());

test('isolated-profile removes SSAM_DESTRUCTIVE_ROOT; the default root is .ssam-hybrid\\destructive under the profile', () => {
  assert.equal(process.env.SSAM_DESTRUCTIVE_ROOT, undefined);
  assert.equal(destructiveRoot(), path.join(process.env.USERPROFILE, '.ssam-hybrid', 'destructive'));
  assert.equal(destructiveRoot({ SSAM_DESTRUCTIVE_ROOT: 'C:\\x', USERPROFILE: 'C:\\u' }), 'C:\\x');
  const fixture = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'isolated-profile.mjs'), 'utf8');
  assert.match(fixture, /delete process\.env\.SSAM_DESTRUCTIVE_ROOT;/);
});

test('derivedOperationId lives in the common module and gives the same UUIDs as before (delete.mjs re-exports it)', () => {
  assert.equal(derivedOperationId('11111111-2222-4333-8444-555555555555', 'module', 'k-orders', 1), '144a4add-158a-5c2a-bdbd-be5c749ef900');
  assert.equal(derivedOperationId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'execute'), '6054c81c-bdb2-5ecc-bb59-66550d2e2523');
  assert.equal(engineDerived, derivedOperationId);
});

test('a preview: exact list, count, token bound to the list and host, the operationId the execution will have; nothing else written', () => {
  const dir = root();
  const block = preview(dir);
  assert.equal(block.state, 'previewed');
  assert.equal(block.count, 2);
  assert.match(block.confirmationToken, new RegExp('^' + block.previewId + '\\.[0-9a-f]{16}$'));
  assert.equal(block.operationId, derivedOperationId(block.previewId, 'execute'));
  assert.equal(block.expiresAt, new Date(T0 + PREVIEW_TTL_MS).toISOString());
  assert.deepEqual(block.items.map(i => i.name), ['ZZDC Alpha', 'ZZDC Beta']);
  assert.match(block.confirmWith, /\b2\b/);
  assert.match(block.next, /confirmationToken/);
  assert.deepEqual(fs.readdirSync(dir), ['previews']);
  const stored = readPreview(block.previewId, { root: dir });
  assert.equal(stored.schema, 'ssam-destructive-preview/1');
  assert.equal(stored.listSha256.length, 64);
});

test('the token changes with any name, key, host, operation, tool or consumer of the list', () => {
  const dir = root();
  const hash = block => block.confirmationToken.split('.')[1];
  const base = hash(preview(dir));
  const variants = [
    { items: apps().map((a, i) => (i ? a : { ...a, name: 'ZZDC Alpha2' })) },
    { items: apps().map((a, i) => (i ? a : { ...a, key: 'k-a2' })) },
    { host: 'other.example.test' },
    { operation: 'application-delete' },
    { tool: 'o11_environment' },
    { items: apps().map((a, i) => (i ? { ...a, consumers: [] } : a)) },
    { items: apps().map((a, i) => (i ? a : { ...a, cascade: ['ZZDCAlpha_CS'] })) },
  ];
  for (const over of variants) assert.notEqual(hash(preview(dir, over)), base, JSON.stringify(over));
  // The same list in another order is the same list.
  assert.equal(hash(preview(dir, { items: apps().reverse() })), base);
});

test('the execution checks: words after the preview with the exact count, at least 5 s later, before expiry, no selection', () => {
  const dir = root();
  const block = preview(dir);
  assert.deepEqual(execute(dir, block).problems, []);
  assert.deepEqual(codes(execute(dir, block, { now: T0 + CONFIRM_MIN_AGE_MS - 1 })), ['CONFIRMATION_TOO_SOON']);
  assert.deepEqual(codes(execute(dir, block, { now: T0 + PREVIEW_TTL_MS + 1 })), ['PREVIEW_EXPIRED']);
  assert.deepEqual(codes(execute(dir, block, { selection: { prefix: 'ZZDC' } })), ['SELECTION_ONLY_IN_PREVIEW']);
  assert.deepEqual(codes(execute(dir, block, { selection: { targets: [], ids: [] } })), [], 'an empty selection is none');
  assert.deepEqual(codes(execute(dir, block, { host: 'other.example.test' })), ['PREVIEW_OTHER_TARGET']);
  assert.deepEqual(codes(execute(dir, block, { tool: 'o11_environment' })), ['PREVIEW_OTHER_TARGET']);
  assert.deepEqual(codes(execute(dir, block, { target: 'ZZDC Gamma' })), ['PREVIEW_OTHER_TARGET']);
  assert.deepEqual(codes(execute(dir, block, { target: 'ZZDC Beta' })), []);
  assert.deepEqual(codes(execute(dir, block, { token: block.previewId + '.0000000000000000' })), ['PREVIEW_UNKNOWN']);
  assert.deepEqual(codes(execute(dir, block, { token: 'nonsense' })), ['PREVIEW_UNKNOWN']);
});

test('owner decision (option C): the words state the exact count as a number; missing or different is CONFIRMATION_COUNT_MISMATCH', () => {
  const dir = root();
  const block = preview(dir);
  for (const words of ['sim, apaga os ZZDC', 'vai la deleta', 'sim, apaga os 3 ZZDC', 'apaga os 2 e os 3']) {
    const found = execute(dir, block, { words }).problems;
    assert.deepEqual(found.map(p => p.code), ['CONFIRMATION_COUNT_MISMATCH'], words);
    assert.equal(found[0].expected, 2);
    assert.deepEqual(found[0].items, ['ZZDC Alpha', 'ZZDC Beta']);
  }
  assert.equal(countProblem('pode apagar os 2', 2), null);
  // A number inside a name is not a count: "App 2024" names the item, "2" is the count.
  assert.equal(countProblem('apaga o ZZ App 2024, os 2', 2, ['ZZ App 2024']), null);
  assert.equal(countProblem('apaga o ZZ App 2024', 2, ['ZZ App 2024']).code, 'CONFIRMATION_COUNT_MISMATCH');
  assert.equal(countProblem('apaga o ZZDemo2 e mais 2', 2, ['ZZDemo2']), null);
});

test('WORDS_BEFORE_PREVIEW: the preview words, its ownerRequest and words seen on the host in the 24 h before it never confirm', () => {
  const dir = root();
  noteWords({ host: HOST, tool: 'o11_service_center_write', words: 'Sim, apaga os 2 ZZDC!', now: T0 - SEEN_WORDS_WINDOW_MS + 60000, root: dir });
  noteWords({ host: HOST, tool: 'o11_service_center_write', words: 'sim apaga os 2 antigos', now: T0 - SEEN_WORDS_WINDOW_MS - 60000, root: dir });
  noteWords({ host: 'other.example.test', tool: 'o11_service_center_write', words: 'apaga os 2 de outro host', now: T0 - 1000, root: dir });
  const block = preview(dir, { words: 'ok deleta todos os 2 apps zzdc', ownerRequest: 'Apaga os 2 do ZZDC, por favor' });
  // Case, accents, spaces and the punctuation at the ends are normalized.
  assert.deepEqual(codes(execute(dir, block, { words: '  SIM,   apaga os 2 zzdc ' })), ['WORDS_BEFORE_PREVIEW']);
  assert.deepEqual(codes(execute(dir, block, { words: 'ok deleta todos os 2 apps ZZDC.' })), ['WORDS_BEFORE_PREVIEW']);
  assert.deepEqual(codes(execute(dir, block, { words: 'apaga os 2 do zzdc, por favor' })), ['WORDS_BEFORE_PREVIEW']);
  assert.deepEqual(codes(execute(dir, block, { words: 'sim apaga os 2 antigos' })), [], 'seen more than 24 h before');
  assert.deepEqual(codes(execute(dir, block, { words: 'apaga os 2 de outro host' })), [], 'seen on another host');
  assert.equal(normalizeWords('  Ação,  JÁ!! '), 'acao, ja');
  assert.equal(wordsSha256('Ação já'), wordsSha256('acao JA.'));
});

test('PREVIEW_STALE: the list read again differs; the refusal carries the diff and a new preview with a new token', () => {
  const dir = root();
  const block = preview(dir);
  const current = [{ ...apps()[0], name: 'ZZDC Alpha Renamed', cascade: ['ZZDCAlpha_CS'] }, { kind: 'application', key: 'k-c', name: 'ZZDC Gamma', cascade: [], consumers: [] }];
  const result = execute(dir, block, { current });
  assert.deepEqual(codes(result), ['PREVIEW_STALE']);
  const stale = result.problems[0];
  assert.deepEqual(stale.diff, { added: ['ZZDC Gamma'], removed: ['ZZDC Beta'], renamed: [{ key: 'k-a', from: 'ZZDC Alpha', to: 'ZZDC Alpha Renamed' }], consumersChanged: ['ZZDC Alpha Renamed'] });
  assert.equal(result.fresh.state, 'previewed');
  assert.notEqual(result.fresh.confirmationToken, block.confirmationToken);
  assert.deepEqual(result.fresh.items.map(i => i.name), ['ZZDC Alpha Renamed', 'ZZDC Gamma']);
  assert.deepEqual(codes(execute(dir, block, { current: apps().reverse() })), [], 'the same list read again is not stale');
});

test('every problem comes at once in one refusal', () => {
  const dir = root();
  const block = preview(dir, { words: 'ok deleta todos os apps zzdc' });
  const result = execute(dir, block, { words: 'ok deleta todos os apps zzdc', now: T0 + 1000, selection: { prefix: 'ZZDC' }, current: apps().slice(0, 1),
    nameRule: () => [{ code: 'WORDS_MUST_NAME', message: 'x', fix: 'y' }] });
  assert.deepEqual(codes(result).sort(), ['CONFIRMATION_COUNT_MISMATCH', 'CONFIRMATION_TOO_SOON', 'PREVIEW_STALE', 'SELECTION_ONLY_IN_PREVIEW', 'WORDS_BEFORE_PREVIEW', 'WORDS_MUST_NAME']);
});

test('a used token answers by state; a cancelled operation never sends again', () => {
  const dir = root();
  const block = preview(dir);
  const record = beginOperation({ preview: readPreview(block.previewId, { root: dir }), now: T0 + 6000, root: dir, words: 'sim, apaga os 2 ZZDC' });
  // CX15 r2 (A/B): while it runs (this process is alive) the token answers OPERATION_RUNNING; once it stopped, every rule
  // runs again: the words that confirmed it never confirm it again, and past the expiry it is PREVIEW_EXPIRED.
  assert.deepEqual(codes(execute(dir, block)), ['OPERATION_RUNNING']);
  endOperation(record, 'uncertain', { now: T0 + 6500, root: dir });
  const used = execute(dir, block);
  assert.deepEqual([used.used, codes(used), used.operation.operationId], [true, ['CONFIRMATION_ALREADY_USED'], block.operationId]);
  assert.deepEqual(codes(execute(dir, block, { words: 'pode tentar de novo os 2 ZZDC' })), []);
  const late = execute(dir, block, { now: T0 + PREVIEW_TTL_MS * 10, words: 'pode tentar de novo os 2 ZZDC' });
  assert.deepEqual([late.used, codes(late)], [true, ['PREVIEW_EXPIRED']]);
  markItem(record, { kind: 'application', key: 'k-a' }, { state: 'deleted' }, { now: T0 + 7000, root: dir });
  endOperation(record, 'cancelled', { now: T0 + 8000, root: dir, cancelledAt: new Date(T0 + 8000).toISOString() });
  const cancelled = execute(dir, block);
  assert.deepEqual(codes(cancelled), ['OPERATION_CANCELLED']);
  assert.equal(cancelled.operation.state, 'cancelled');
  assert.match(cancelled.problems[0].fix, /new preview/);
});

test('the operation record: atomic, per item, read by operationId or previewId, listed newest first', () => {
  const dir = root();
  const block = preview(dir);
  const record = beginOperation({ preview: readPreview(block.previewId, { root: dir }), now: T0 + 6000, root: dir });
  assert.deepEqual(record.items.map(i => [i.name, i.state]), [['ZZDC Alpha', 'not-started'], ['ZZDC Beta', 'not-started']]);
  // CX15 r2 (I): a second begin while the first runs (the lease is held) is OPERATION_RUNNING and writes nothing.
  markItem(record, 'application:k-a', { state: 'sending' }, { now: T0 + 7000, root: dir });
  assert.throws(() => beginOperation({ preview: readPreview(block.previewId, { root: dir }), now: T0 + 9000, root: dir }), error => error.code === 'OPERATION_RUNNING');
  assert.equal(readOperation(block.operationId, { root: dir }).items[0].state, 'sending', 'nothing was overwritten');
  markItem(record, 'application:k-a', { state: 'deleted', receipt: 'r.json' }, { now: T0 + 8000, root: dir });
  endOperation(record, 'partial', { now: T0 + 9000, root: dir });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'operations')), [block.operationId + '.json'], 'no temporary file is left');
  const byOperation = readOperation(block.operationId, { root: dir });
  const byPreview = readOperation(block.previewId, { root: dir });
  assert.deepEqual(byOperation, byPreview);
  assert.equal(byOperation.schema, 'ssam-destructive-operation/1');
  assert.deepEqual(byOperation.items.map(i => i.state), ['deleted', 'not-started']);
  const second = preview(dir, { items: apps().slice(1) });
  beginOperation({ preview: readPreview(second.previewId, { root: dir }), now: T0 + 60000, root: dir });
  const listed = listOperations({ root: dir });
  assert.deepEqual(listed.map(o => o.operationId), [second.operationId, block.operationId]);
  assert.deepEqual([listed[1].counts.deleted, listed[1].deleted, listed[1].notStarted], [1, ['ZZDC Alpha'], ['ZZDC Beta']]);
  assert.equal(readOperation('ffffffff-ffff-4fff-8fff-ffffffffffff', { root: dir }), null);
});

test('a running operation of a dead process reads orphaned; its sending item reads uncertain, backing-up reads not-started', () => {
  const dir = root();
  const block = preview(dir);
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  const record = beginOperation({ preview: readPreview(block.previewId, { root: dir }), now: T0 + 6000, root: dir, pid: dead });
  markItem(record, 'application:k-a', { state: 'sending' }, { now: T0 + 7000, root: dir });
  markItem(record, 'application:k-b', { state: 'backing-up' }, { now: T0 + 7000, root: dir });
  const read = readOperation(block.operationId, { root: dir });
  assert.equal(read.orphaned, true);
  assert.deepEqual(read.items.map(i => i.state), ['uncertain', 'not-started']);
  assert.equal(summarizeOperation(read).counts.uncertain, 1);
  // The same process still running: what is on disk.
  const own = preview(dir);
  const live = beginOperation({ preview: readPreview(own.previewId, { root: dir }), now: T0 + 6000, root: dir });
  markItem(live, 'application:k-a', { state: 'sending' }, { now: T0 + 7000, root: dir });
  const ownRead = readOperation(own.operationId, { root: dir });
  assert.deepEqual([ownRead.orphaned, ownRead.items[0].state], [undefined, 'sending']);
});

test('backups land under backups\\<operationId> with sha256 and bytes', () => {
  const dir = root();
  const source = path.join(dir, 'm.oml');
  fs.writeFileSync(source, 'PK oml bytes');
  const stored = storeBackup({ operationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'ZZDC:Alpha_CS.oml', source, root: dir });
  assert.equal(path.dirname(stored.path), path.join(dir, 'backups', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'));
  assert.equal(stored.bytes, 12);
  assert.equal(stored.sha256.length, 64);
  assert.equal(fs.readFileSync(stored.path, 'utf8'), 'PK oml bytes');
  const rows = storeBackup({ operationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', name: 'Customer-rows.json', data: JSON.stringify([{ Id: 1 }]), root: dir });
  assert.equal(fs.readFileSync(rows.path, 'utf8'), '[{"Id":1}]');
});

test('no preview, record or seen-words line keeps the words or the owner request: only their sha256', () => {
  const dir = root();
  const words = 'Segredo do dono: apaga os 2 ZZDC agora';
  const request = 'Pedido literal do dono: remover tudo';
  noteWords({ host: HOST, tool: 'o11_service_center_write', words, now: T0, root: dir });
  const block = preview(dir, { words, ownerRequest: request });
  const record = beginOperation({ preview: readPreview(block.previewId, { root: dir }), now: T0 + 6000, root: dir });
  endOperation(record, 'completed', { now: T0 + 7000, root: dir });
  const text = allFiles(dir).map(f => fs.readFileSync(f, 'utf8')).join('\n');
  for (const secret of [words, request, 'Segredo do dono', 'Pedido literal']) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes(wordsSha256(words)));
  assert.ok(!JSON.stringify(block).includes('Segredo'));
});

test('the bridge commands that delete or call the Portal directly are refused with the dedicated tool, nothing sent', () => {
  assert.deepEqual([...DESTRUCTIVE_BRIDGE_COMMANDS], ['data-delete', 'portal-call', 'portal-private-call', 'portal-api-client-fixture-cleanup']);
  for (const command of DESTRUCTIVE_BRIDGE_COMMANDS) {
    const refusal = dedicatedToolRefusal(command, { surface: 'studio_command' });
    assert.deepEqual([refusal.ok, refusal.code, refusal.outcome], [false, 'DESTRUCTIVE_NEEDS_DEDICATED_TOOL', 'not-sent']);
    assert.equal(typeof refusal.continuation.tool, 'string');
  }
  assert.equal(dedicatedToolRefusal('data-delete').continuation.tool, 'studio_data_delete');
  assert.equal(dedicatedToolRefusal('module-info'), null);
});

test('the exported table of destructive verbs: without confirmationToken a preview (a read), with it an execution', () => {
  assert.equal(destructivePhase('o11_service_center_write', { action: 'delete', prefix: 'ZZ' }), 'preview');
  assert.equal(destructivePhase('o11_service_center_write', { action: 'delete', confirmationToken: 'x.y' }), 'execute');
  assert.equal(destructivePhase('o11_service_center_write', { action: 'timer-run', execute: true }), null);
  assert.equal(destructivePhase('o11_environment', { action: 'delete-app', app: 'A' }), 'preview');
  assert.equal(destructivePhase('o11_extension', { action: 'delete', extension: 'X', confirmationToken: 't' }), 'execute');
  assert.equal(destructivePhase('o11_data', { request: { operation: 'delete', entity: 'E', ids: ['1'] } }), 'preview');
  assert.equal(destructivePhase('o11_data', { request: { batch: [{ operation: 'insert' }, { operation: 'delete', confirmationToken: 't' }] } }), 'execute');
  assert.equal(destructivePhase('o11_data', { request: { operation: 'read' } }), null);
  assert.equal(destructivePhase('studio_data_delete', { ids: [1] }), 'preview');
  assert.equal(destructivePhase('studio_command', { command: 'data-delete' }), 'refuse');
  assert.equal(destructivePhase('studio_command', { command: 'publish-log' }), null);
  assert.equal(destructivePhase('odc_deploy', { operation: 'Undeploy' }), 'preview');
  assert.equal(destructivePhase('odc_deploy', { operation: 'Deploy' }), null);
  assert.equal(destructivePhase('odc_asset_delete', { assetKey: 'k', confirmationToken: 't' }), 'execute');
  assert.equal(destructivePhase('odc_write', { operationId: 'x' }, { destructive: () => true }), 'preview');
  assert.equal(destructivePhase('odc_write', { operationId: 'x' }), null);
  assert.equal(destructivePhase('odc_external_library', { action: 'discard' }), 'preview');
  assert.equal(destructivePhase('odc_external_db_connection', { action: 'remove-entities', confirmationToken: 't' }), 'execute');
});
