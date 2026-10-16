import './fixtures/isolated-profile.mjs';
// CX15 r2, family F1 (confirmation): no text the SERVER wrote can confirm a delete (T1), a used token never becomes a
// blank check (A, B, B2), an interrupted operation needs a new preview (C3), the texts say the words are the owner's next
// message (T3, T4). Offline: fake bridge, fake clock, synthetic names (the reviewer's reproductions of
// C:\t\revisoes\cx15\bypass\...\bypass-review-sc.test.mjs and text-hosted R1-R3, turned into the rule).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Journal } from '../service-center/client.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import * as destructive from '../destructive-operations.mjs';
import { registerO11Environment } from '../o11-environment.mjs';
import { createO11Extension } from '../o11-extension.mjs';
import { CATALOG, FakeBridge, SC, fixture, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock, noBackup } from './fixtures/destructive-flow.mjs';

const { CONFIRM_MIN_AGE_MS, checkExecute, createPreview, operationFile, readOperation, readPreview } = destructive;
// (Read through the namespace so the suite runs, and fails on behavior, on the commit before the fix.)
const OWNER_REPLY = destructive.OWNER_REPLY ?? "<the owner's next message after the list, verbatim>";
const WORDS_RULE = destructive.WORDS_RULE ?? "The words are the owner's next message after the list, copied whole";
const PERSONAL = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');

function environment({ apps = [], espaces = [], extensions = [], sticky = new Set() } = {}) {
  const s = { apps: apps.map(a => ({ ...a })), espaces: espaces.map(m => ({ ...m })), extensions: extensions.map(x => ({ ...x })), dir: temp(), clock: fakeClock(), ids: 0, sticky };
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  s.root = path.join(s.dir, 'destructive');
  const listed = rows => rows.filter(r => !r.gone);
  s.bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => listed(s.apps).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: () => listed(s.espaces).map(m => ({ Key: m.key, Name: m.name, ApplicationKey: m.app })),
    ListExtensions: () => listed(s.extensions).map(m => ({ Key: m.key, Name: m.name, ApplicationKey: m.app ?? null })), GetConsumers: () => [],
    DeleteApplication: args => {
      if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] };
      for (const a of s.apps) if (a.key === args.appKey && !s.sticky.has(a.key)) a.gone = true;
      return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: [] };
    },
    DeleteModule: args => { for (const m of [...s.espaces, ...s.extensions]) if (m.key === args.moduleKey && !s.sticky.has(m.key)) m.gone = true; return { success: true, message: null }; },
  } });
  s.deps = (extra = {}) => ({ journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false, opener: () => assert.fail('no prompt'),
    exports: s.dir, registry: REGISTRY, sleep: async () => {}, clock: s.clock, destructiveRoot: s.root,
    previewUuid: () => `00000000-0000-4000-8000-${String(++s.ids).padStart(12, '0')}`, backup: noBackup, ...extra });
  s.run = (argv, extra) => runServiceCenter([...argv, '--host=' + PERSONAL], s.deps(extra));
  s.sends = () => s.bridge.calls.filter(c => c[0] === 'api' && c[4]).map(c => c[3].appKey ?? c[3].moduleKey);
  return s;
}
const three = sticky => environment({ apps: [{ key: 'a-1', name: 'ZZ A' }, { key: 'a-2', name: 'ZZ B' }, { key: 'a-3', name: 'ZZ C' }], sticky });
// Every string the server wrote in an answer (recursively), the candidates a model could copy as the owner's words.
const strings = (value, out = new Set()) => {
  if (typeof value === 'string') { if (value.trim()) out.add(value); }
  else if (Array.isArray(value)) value.forEach(v => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, out));
  return [...out];
};

test('T1: no text of the preview answer (repeat.words, continuation, next, confirmWith, ...) confirms; the owner\'s own words do', async () => {
  const s = environment({ apps: Array.from({ length: 7 }, (_, i) => ({ key: 'zz-' + i, name: 'ZZRV App' + String.fromCharCode(65 + i) })) });
  const preview = await s.run(['delete', '--prefix=ZZRV']);
  assert.equal(preview.count, 7);
  s.clock.advance(CONFIRM_MIN_AGE_MS + 1000);
  const texts = strings(preview);
  assert.ok(texts.includes(preview.repeat.words));
  for (const words of texts) {
    const answer = await s.run(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=' + words]);
    assert.notEqual(answer.ok, true, 'a server text confirmed: ' + words);
    assert.deepEqual(s.sends(), [], 'nothing sent for: ' + words);
  }
  // The placeholder of every template, and the rule of the words, never confirm either.
  for (const words of [OWNER_REPLY, '<the owner reply: 7 ZZRV>', WORDS_RULE + ' 7 ZZRV']) {
    const answer = await s.run(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=' + words]);
    assert.ok(answer.problems.some(p => p.code === 'WORDS_BEFORE_PREVIEW'), words + ': ' + JSON.stringify(answer.problems?.map(p => p.code)));
  }
  const done = await s.run(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=pode apagar as 7 ZZRV']);
  assert.equal(done.state, 'confirmed', JSON.stringify(done.problems ?? done.error));
  assert.equal(s.sends().length, 7);
});

test('T1: the continuations of delete-app, o11_extension and the page deletes never carry words that confirm', async () => {
  const s = environment({ apps: [{ key: 'a-9', name: 'ZZApp' }], extensions: [{ key: 'x-1', name: 'ZZExt' }] });
  const tools = {};
  registerO11Environment({ registerTool: (name, config, handler) => { tools[name] = { config, handler }; } }, { serviceCenterDeps: s.deps(), studioHosts: async () => [PERSONAL], destructiveRoot: s.root });
  const env = async input => (await tools.o11_environment.handler(tools.o11_environment.config.inputSchema.parse(input))).structuredContent;
  const preview = await env({ action: 'delete-app', app: 'ZZApp', host: PERSONAL });
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  // The model copies the whole continuation.
  const copied = await env(preview.continuation.arguments);
  assert.notEqual(copied.ok, true, JSON.stringify(copied).slice(0, 400));
  assert.deepEqual(s.sends(), []);
  // delete-app with the token and no words: WORDS_REQUIRED with the warning back.
  const bare = await env({ action: 'delete-app', host: PERSONAL, confirmationToken: preview.confirmationToken });
  assert.equal(bare.code, 'WORDS_REQUIRED'); assert.match(bare.continuation.why, /never write the words yourself/);
  const ext = createO11Extension({ destructiveRoot: s.root, serviceCenter: (argv, extra) => runServiceCenter(argv, { ...s.deps(), ...extra }) });
  const xp = await ext({ action: 'delete', host: PERSONAL, extension: 'ZZExt' });
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const xcopied = await ext(xp.continuation.arguments);
  assert.notEqual(xcopied.ok, true); assert.deepEqual(s.sends(), []);
  // db-connection-delete (page delete): its continuation copied whole.
  const deleted = [];
  const bridge = new FakeBridge({ pages: {
    [`GET ${SC}DatabaseConnections_List.aspx`]: () => fixture('db-connections.html'),
    [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: fixture('db-connection-edit.html'),
    [`POST ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: f => { deleted.push(f.__EVENTTARGET); return fixture('db-connections.html'); } } });
  const page = (...argv) => runServiceCenter(['db-connection-delete', '--host', PERSONAL, '--connection', 'LegacyERP', ...argv], { ...s.deps(), locate: () => bridge });
  const pp = await page();
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const pc = await page('--confirmation-token', pp.continuation.arguments.confirmationToken, '--words', pp.continuation.arguments.words).catch(e => ({ ok: false, code: e.code }));
  assert.notEqual(pc.ok, true); assert.deepEqual(deleted, []);
  for (const value of [preview.continuation.arguments.authorize, xp.continuation.arguments.words, pp.continuation.arguments.words]) assert.equal(value, OWNER_REPLY);
});

test('T3/T4: confirmWith is the rule (the number and the names), never a phrase to copy; the fixes say to ask the owner again', async () => {
  const s = three();
  const preview = await s.run(['delete', '--prefix=ZZ']);
  assert.match(preview.confirmWith, /\b3\b/); assert.match(preview.confirmWith, /ZZ/);
  assert.match(preview.next, /next message after the list/);
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const vague = await s.run(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=vai la deleta']);
  for (const p of vague.problems) assert.match(p.fix, /ask the owner again/i, p.code);
  assert.equal(vague.repeat.words, OWNER_REPLY);
});

test('A: a token whose execution stopped before any reservation runs every rule again: "ok" two hours later sends nothing', async () => {
  const deleted = [];
  const bridge = new FakeBridge({ pages: {
    [`GET ${SC}DatabaseConnections_List.aspx`]: () => (deleted.length ? '<table><tr><th>Name</th></tr></table><p>No connections found</p>' : fixture('db-connections.html')),
    [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: fixture('db-connection-edit.html'),
    [`POST ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: f => { deleted.push(f.__EVENTTARGET); return fixture('db-connections.html'); } } });
  const s = environment();
  const host = 'test.example.com';
  const run = (...argv) => runServiceCenter(['db-connection-delete', '--host', host, '--connection', 'LegacyERP', ...argv], { ...s.deps(), locate: () => bridge });
  const testId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await s.journal.reserve(testId, { host, action: 'db-connection-test', connection: 'LegacyERP' }, 'testa LegacyERP', {}, null, async r => { r.state = 'uncertain'; return r; });
  const preview = await run();
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  await run('--confirm-host', host, '--confirmation-token', preview.confirmationToken, '--words', 'sim, apaga a 1 LegacyERP no test').catch(e => e);
  assert.deepEqual(deleted, []);
  const record = readOperation(preview.operationId, { root: s.root });
  assert.ok(!record || record.state !== 'running', 'the record never stays running when the reservation refused: ' + JSON.stringify(record?.state));
  if (record) assert.deepEqual(record.items.map(i => i.state), ['not-started']);
  s.journal.discard(s.journal.lookup(testId), 'descarta o teste da LegacyERP');
  s.clock.advance(2 * 3600 * 1000);
  const reused = await run('--confirmation-token', preview.confirmationToken, '--words', 'ok').catch(e => ({ ok: false, code: e.code, problems: e.fields?.problems ?? [] }));
  assert.notEqual(reused.ok, true);
  assert.deepEqual(deleted, [], 'nothing sent with "ok"');
  const codes = (reused.problems ?? []).map(p => p.code);
  for (const code of ['PREVIEW_EXPIRED', 'CONFIRMATION_COUNT_MISMATCH']) assert.ok(codes.includes(code), code + ' in ' + codes);
});

test('A (variant): a used token never deletes a consumer the owner never saw; checkExecute never answers problems:[] for a used token', () => {
  const root = temp();
  const items = [{ kind: 'application', key: 'k-1', name: 'ZZ One', cascade: [], consumers: [] }];
  const block = createPreview({ tool: 'o11_service_center_write', lane: 'o11', host: PERSONAL, operation: 'delete', items, now: 0, root });
  const preview = readPreview(block.previewId, { root });
  fs.mkdirSync(path.dirname(operationFile(preview.operationId, { root })), { recursive: true });
  fs.writeFileSync(operationFile(preview.operationId, { root }), JSON.stringify({ schema: 'ssam-destructive-operation/1', operationId: preview.operationId, previewId: preview.previewId,
    tool: preview.tool, host: PERSONAL, operation: 'delete', pid: process.pid, startedAt: new Date(6000).toISOString(), endedAt: new Date(7000).toISOString(), state: 'refused',
    items: [{ kind: 'application', key: 'k-1', name: 'ZZ One', state: 'not-started' }] }));
  const current = [{ ...items[0], consumers: ['ZZ New Consumer'] }];
  const check = checkExecute({ token: block.confirmationToken, tool: 'o11_service_center_write', host: PERSONAL, operation: 'delete', words: 'ok', current, now: 60000, root });
  assert.equal(check.used, true);
  const codes = check.problems.map(p => p.code);
  for (const code of ['CONFIRMATION_COUNT_MISMATCH', 'PREVIEW_STALE']) assert.ok(codes.includes(code), code + ' in ' + codes);
});

test('B and B2: after a stop that was not a cancellation, the same token and words send nothing; a new reply resends only the uncertain item still listed', async () => {
  const s = three(new Set(['a-2']));
  const preview = await s.run(['delete', '--prefix=ZZ']);
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const words = 'sim, apaga os 3 ZZ';
  const first = await s.run(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=' + words]);
  assert.deepEqual([first.code, first.notStarted, s.sends()], ['DELETE_UNCONFIRMED', ['ZZ C'], ['a-1', 'a-2']]);
  assert.match(first.next, /ssam_task/); assert.doesNotMatch(first.next, /repeat this same call/);
  s.sticky.clear();
  s.clock.advance(60000);
  const again = await s.run(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=' + words]);
  assert.ok(again.problems.some(p => p.code === 'CONFIRMATION_ALREADY_USED'), JSON.stringify(again.problems?.map(p => p.code)));
  assert.deepEqual(s.sends(), ['a-1', 'a-2'], 'the same words never send again');
  const fresh = await s.run(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=confirmo de novo os 3 ZZ']);
  assert.deepEqual(s.sends(), ['a-1', 'a-2', 'a-2'], 'only the uncertain item still listed is sent again; the never-tried ZZ C needs a new preview');
  assert.deepEqual(fresh.notStarted, ['ZZ C']);
  assert.match(fresh.next, /new preview/);
  // B2: a BACKUP_FAILED stop: the same words never resume the rest.
  const b = three();
  b.espaces.push({ key: 'm-1', name: 'ZZA_CS', app: 'a-1' }, { key: 'm-2', name: 'ZZB_CS', app: 'a-2' }, { key: 'm-3', name: 'ZZC_CS', app: 'a-3' });
  let fail = true;
  const backup = async item => { if (item.name === 'ZZ B' && fail) throw new Error('download failed'); return { files: [] }; };
  const p2 = await b.run(['delete', '--prefix=ZZ']);
  b.clock.advance(CONFIRM_MIN_AGE_MS);
  const f2 = await b.run(['delete', '--confirmation-token=' + p2.confirmationToken, '--words=' + words], { backup });
  assert.deepEqual([f2.code, b.sends()], ['BACKUP_FAILED', ['a-1']]);
  fail = false;
  b.clock.advance(60000);
  await b.run(['delete', '--confirmation-token=' + p2.confirmationToken, '--words=' + words], { backup });
  await b.run(['delete', '--confirmation-token=' + p2.confirmationToken, '--words=outra resposta: os 3 ZZ'], { backup });
  assert.deepEqual(b.sends(), ['a-1'], 'items never tried are sent only after a new preview');
});

test('C3: an operation whose process died answers OPERATION_INTERRUPTED with a new preview of what is left; nothing is sent', async () => {
  const s = three();
  const preview = await s.run(['delete', '--prefix=ZZ']);
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  // The first item was deleted by a process that died before the second.
  s.apps[0].gone = true;
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  fs.mkdirSync(path.dirname(operationFile(preview.operationId, { root: s.root })), { recursive: true });
  fs.writeFileSync(operationFile(preview.operationId, { root: s.root }), JSON.stringify({ schema: 'ssam-destructive-operation/1', operationId: preview.operationId, previewId: preview.previewId,
    tool: 'o11_service_center_write', host: PERSONAL, operation: 'delete', pid: dead, startedAt: new Date().toISOString(), state: 'running',
    items: preview.items.map((i, n) => ({ kind: i.kind, key: i.key, name: i.name, state: n === 0 ? 'deleted' : 'not-started' })) }));
  const answer = await s.run(['delete', '--confirmation-token=' + preview.confirmationToken, '--words=confirmo, os 3 ZZ']);
  assert.ok(answer.problems.some(p => p.code === 'OPERATION_INTERRUPTED'), JSON.stringify(answer.problems?.map(p => p.code)));
  assert.deepEqual(answer.preview?.items.map(i => i.name), ['ZZ B', 'ZZ C']);
  assert.deepEqual(s.sends(), []);
});
