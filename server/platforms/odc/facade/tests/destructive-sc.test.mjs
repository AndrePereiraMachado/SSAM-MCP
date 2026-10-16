import './fixtures/isolated-profile.mjs';
// CX15 W2: the Service Center deletes in two calls (service-center/delete.mjs through runServiceCenter): the preview reads
// and lists, nothing reserved or sent; the execution takes the targets from the token, reads again and needs the owner's
// words given after the preview, with the exact count. The same path for o11_environment delete-app, o11_extension delete,
// the CLI argv and the page deletes (solution-delete, db-connection-delete). Offline: the fake bridge, no Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../service-center/client.mjs';
import { runServiceCenter, serviceCenterTool } from '../service-center/index.mjs';
import { derivedOperationId } from '../service-center/delete.mjs';
import { CONFIRM_MIN_AGE_MS, readPreview, previewFile } from '../destructive-operations.mjs';
import { sha256 } from '../service-center/util.mjs';
import { isWrite } from '../studio-write-lock.mjs';
import { registerO11Environment } from '../o11-environment.mjs';
import { createO11Extension, extensionSchema } from '../o11-extension.mjs';
import { serviceCenterArguments } from '../o11-operations.mjs';
import { CATALOG, FakeBridge, files, temp } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock, noBackup, previewThenConfirm } from './fixtures/destructive-flow.mjs';

const PERSONAL = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');

function environment({ apps = [], espaces = [], extensions = [], consumers = {}, simulations = {}, host = PERSONAL, tool } = {}) {
  const s = { apps: [...apps], espaces: [...espaces], extensions: [...extensions], consumers, simulations, dir: temp(), sleeps: [], clock: fakeClock(), ids: 0 };
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  s.root = path.join(s.dir, 'destructive');
  const listed = rows => rows.filter(r => !r.gone);
  const moduleRows = rows => listed(rows).map(m => ({ Key: m.key, Name: m.name, ApplicationKey: m.app ?? null }));
  s.bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => listed(s.apps).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: () => moduleRows(s.espaces),
    ListExtensions: () => moduleRows(s.extensions),
    GetConsumers: args => s.consumers[args.producerESpaceKey] ?? [],
    DeleteApplication: args => {
      if (args.simulate) return s.simulations[args.appKey] ?? { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] };
      for (const a of s.apps) if (a.key === args.appKey) a.gone = true;
      const taken = [...s.espaces, ...s.extensions].filter(m => m.app === args.appKey);
      taken.forEach(m => { m.gone = true; });
      return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: taken.map(m => m.name) };
    },
    DeleteModule: args => { for (const m of [...s.espaces, ...s.extensions]) if (m.key === args.moduleKey) m.gone = true; return { success: true, message: null }; },
  } });
  s.deps = () => ({ journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false, opener: () => assert.fail('no prompt'),
    exports: s.dir, registry: REGISTRY, sleep: async ms => { s.sleeps.push(ms); }, clock: s.clock, destructiveRoot: s.root, previewUuid: () => `00000000-0000-4000-8000-${String(++s.ids).padStart(12, '0')}`,
    backup: noBackup, ...(tool ? { tool } : {}) });
  s.run = (...argv) => runServiceCenter([...argv, '--host=' + host], s.deps());
  s.sends = () => s.bridge.calls.filter(c => c[0] === 'api' && c[4]);
  s.receipts = () => files(path.join(s.dir, 'receipts'), /\.json$/);
  return s;
}
const zz = () => environment({ apps: [{ key: 'a-1', name: 'ZZ One' }, { key: 'a-2', name: 'ZZ Two' }, { key: 'a-3', name: 'Other' }],
  espaces: [{ key: 'm-1', name: 'ZZOne_CS', app: 'a-1' }, { key: 'm-2', name: 'ZZOne_UI', app: 'a-1' }, { key: 'm-3', name: 'ZZTwo_CS', app: 'a-2' }],
  simulations: { 'a-2': { success: true, simulated: true, messages: [], affectedApplications: ['ZZ One'], deletedModules: ['ZZTwo_CS'] },
    'a-1': { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: ['ZZOne_CS', 'ZZOne_UI'] } } });

test('a preview without words lists the targets and what goes with them; with words it is CONFIRMATION_REQUIRED; nothing reserved or sent', async () => {
  for (const words of [null, 'ok apaga todos os apps zz']) {
    const s = zz();
    const preview = await s.run('delete', '--prefix=ZZ', ...(words ? ['--words=' + words] : []));
    assert.equal(preview.state, 'previewed');
    assert.deepEqual([preview.ok, preview.code], words ? [false, 'CONFIRMATION_REQUIRED'] : [true, undefined]);
    if (words) assert.match(preview.error, /two calls now/);
    assert.equal(preview.count, 2);
    assert.deepEqual(preview.items.map(i => [i.name, i.cascade]), [['ZZ One', ['ZZOne_CS', 'ZZOne_UI']], ['ZZ Two', ['ZZTwo_CS']]], 'the engine order: ZZ One consumes ZZ Two');
    assert.deepEqual(preview.items.map(i => i.consumers), [[], ['ZZ One']]);
    assert.equal(preview.operationId, derivedOperationId(preview.previewId, 'execute'));
    assert.match(preview.confirmationToken, /^[0-9a-f-]{36}\.[0-9a-f]{16}$/);
    assert.equal(preview.repeat.confirmationToken, preview.confirmationToken);
    assert.deepEqual(s.sends(), [], 'no DeleteApplication/DeleteModule with simulate:false');
    assert.deepEqual(s.receipts(), []);
    assert.equal(s.bridge.calls.filter(c => c[0] === 'api' && c[2] === 'DeleteApplication' && c[3].simulate === false).length, 0);
  }
});

test('the execution: token and the owner words after the preview (prefix and count) delete the token targets in the engine order', async () => {
  const s = zz();
  const { preview, result } = await previewThenConfirm(s.run, ['delete', '--prefix=ZZ'], 'sim, apaga os 2 ZZ', { clock: s.clock });
  assert.deepEqual([result.ok, result.state, result.operationId], [true, 'confirmed', preview.operationId]);
  assert.deepEqual(s.sends().map(c => c[3].appKey), ['a-1', 'a-2']);
  assert.deepEqual(result.deleted.map(d => d.name), ['ZZ One', 'ZZ Two']);
  const parent = s.journal.lookup(preview.operationId);
  assert.deepEqual([parent.state, parent.plan.request.previewId, parent.children.map(c => c.operationId)],
    ['confirmed', preview.previewId, [derivedOperationId(preview.operationId, 'application', 'a-1', 1), derivedOperationId(preview.operationId, 'application', 'a-2', 1)]]);
});

test('the prefix names the token targets only when the preview was selected by it; by names it is WORDS_MUST_NAME', async () => {
  const s = zz();
  const { result } = await previewThenConfirm(s.run, ['delete', '--target=application:ZZ One', '--target=application:ZZ Two'], 'sim, apaga os 2 ZZ', { clock: s.clock });
  assert.deepEqual([result.code, result.problems.map(p => [p.code, p.target])], ['DELETE_REFUSED', [['WORDS_MUST_NAME', 'ZZ One'], ['WORDS_MUST_NAME', 'ZZ Two']]]);
  assert.deepEqual(s.sends(), []);
});

test('a selection with the token is SELECTION_ONLY_IN_PREVIEW; the request sentence, a vague reply and a reply too soon are refused at once', async () => {
  const s = zz();
  const preview = await s.run('delete', '--prefix=ZZ', '--words=ok apaga todos os apps zz');
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const selection = await s.run('delete', '--prefix=ZZ', '--confirmation-token=' + preview.confirmationToken, '--words=sim, apaga os 2 ZZ');
  assert.deepEqual(selection.problems.map(p => p.code), ['SELECTION_ONLY_IN_PREVIEW']);
  const sentence = await s.run('delete', '--confirmation-token=' + preview.confirmationToken, '--words=ok apaga todos os apps zz');
  assert.deepEqual(sentence.problems.map(p => p.code).sort(), ['CONFIRMATION_COUNT_MISMATCH', 'WORDS_BEFORE_PREVIEW']);
  const vague = await s.run('delete', '--confirmation-token=' + preview.confirmationToken, '--words=vai la deleta');
  assert.deepEqual(vague.problems.map(p => p.code).sort(), ['CONFIRMATION_COUNT_MISMATCH', 'WORDS_MUST_NAME', 'WORDS_MUST_NAME']);
  const fresh = zz();
  const quick = await fresh.run('delete', '--prefix=ZZ');
  const early = await fresh.run('delete', '--confirmation-token=' + quick.confirmationToken, '--words=sim, apaga os 2 ZZ');
  assert.deepEqual(early.problems.map(p => p.code), ['CONFIRMATION_TOO_SOON']);
  assert.deepEqual([s.sends(), fresh.sends(), s.receipts(), fresh.receipts()], [[], [], [], []]);
});

test('a name changed between preview and execution is PREVIEW_STALE with a new preview; nothing sent; the new token works', async () => {
  const s = zz();
  const preview = await s.run('delete', '--prefix=ZZ');
  s.apps[1].name = 'ZZ Two Renamed';
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const stale = await s.run('delete', '--confirmation-token=' + preview.confirmationToken, '--words=sim, apaga os 2 ZZ');
  assert.deepEqual(stale.problems.map(p => p.code), ['PREVIEW_STALE']);
  assert.deepEqual(stale.problems[0].diff.renamed, [{ key: 'a-2', from: 'ZZ Two', to: 'ZZ Two Renamed' }]);
  assert.equal(stale.preview.state, 'previewed');
  assert.notEqual(stale.preview.confirmationToken, preview.confirmationToken);
  assert.deepEqual(s.sends(), []);
  // The words of the refused execution were seen before the new preview: the owner answers the new list.
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const again = await s.run('delete', '--confirmation-token=' + stale.preview.confirmationToken, '--words=sim, apaga os 2 ZZ');
  assert.deepEqual(again.problems.map(p => p.code), ['WORDS_BEFORE_PREVIEW']);
  const done = await s.run('delete', '--confirmation-token=' + stale.preview.confirmationToken, '--words=confirmo, os 2 ZZ');
  assert.equal(done.state, 'confirmed');
  assert.equal(s.sends().length, 2);
});

test('an authorization context is valid only with the preview file as its proposal and the preview names as its scope', async () => {
  for (const bound of [false, true]) {
    const s = environment({ apps: [{ key: 'p-1', name: 'Proof' }] });
    const preview = await s.run('delete', '--target=application:Proof');
    const words = 'Pode sim, apague o 1.';
    const proposal = bound ? previewFile(preview.previewId, { root: s.root }) : path.join(s.dir, 'proposal.md');
    if (!bound) fs.writeFileSync(proposal, 'Delete the disposable Proof app.');
    const context = path.join(s.dir, 'approval.json');
    fs.writeFileSync(context, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', words,
      source: { kind: 'human-conversation', threadId: preview.previewId, messageId: preview.previewId, question: 'May I delete this list?' },
      proposal: { file: proposal, sha256: sha256(fs.readFileSync(proposal)) }, scope: [{ lane: 'o11', host: PERSONAL, operation: 'delete', targets: ['Proof'] }] }));
    s.clock.advance(CONFIRM_MIN_AGE_MS);
    const result = await s.run('delete', '--confirmation-token=' + preview.confirmationToken, '--words=' + words, '--authorization-context=' + context);
    if (bound) assert.equal(result.state, 'confirmed', JSON.stringify(result));
    else { assert.equal(result.code, 'AUTHORIZATION_CONTEXT_INVALID'); assert.deepEqual(s.sends(), []); }
  }
});

test('repeating an older operationId without a token previews what is left of it', async () => {
  const s = zz();
  // A parent of before CX15: the first app was deleted, the second never sent.
  const old = '11111111-2222-4333-8444-555555555555';
  s.journal.create(old, { host: PERSONAL, action: 'delete', target: 'application:a-1,application:a-2' }, 'apagar ZZ',
    { host: PERSONAL, action: 'delete', request: { targets: [], prefix: 'ZZ', prefixKind: 'application', maxDeletes: 25 },
      targets: [{ kind: 'application', name: 'ZZ One', key: 'a-1', application: 'ZZ One' }, { kind: 'application', name: 'ZZ Two', key: 'a-2', application: 'ZZ Two' }] });
  s.apps[0].gone = true;
  const preview = await s.run('delete', '--operation-id=' + old);
  assert.deepEqual([preview.state, preview.resumes, preview.items.map(i => i.name), preview.absent.map(a => a.name)], ['previewed', old, ['ZZ Two'], ['ZZ One']]);
  assert.deepEqual(s.sends(), []);
});

test('the token answers by state after the execution; never sends again what is gone', async () => {
  const s = zz();
  const { result, token } = await previewThenConfirm(s.run, ['delete', '--prefix=ZZ'], 'sim, apaga os 2 ZZ', { clock: s.clock });
  assert.equal(result.state, 'confirmed');
  const again = await s.run('delete', '--confirmation-token=' + token, '--words=sim, apaga os 2 ZZ');
  assert.deepEqual([again.ok, again.state, again.absent.map(a => a.receiptState)], [true, 'absent', ['confirmed', 'confirmed']]);
  assert.equal(s.sends().length, 2);
});

test('o11_environment delete-app and o11_extension delete take the same two calls; their strict schemas accept the new fields', async () => {
  const s = environment({ apps: [{ key: 'a-9', name: 'ZZApp' }], espaces: [{ key: 'm-9', name: 'ZZApp_CS', app: 'a-9' }] });
  const tools = {};
  registerO11Environment({ registerTool: (name, config, handler) => { tools[name] = { config, handler }; } }, { serviceCenterDeps: s.deps(), studioHosts: async () => [PERSONAL], destructiveRoot: s.root });
  const call = async input => tools.o11_environment.handler(tools.o11_environment.config.inputSchema.parse(input)).then(r => r.structuredContent);
  const preview = await call({ action: 'delete-app', app: 'ZZApp', host: PERSONAL, authorize: 'apaga o ZZApp' });
  assert.deepEqual([preview.ok, preview.code, preview.state, preview.count], [false, 'CONFIRMATION_REQUIRED', 'previewed', 1]);
  assert.deepEqual(preview.continuation.arguments, { action: 'delete-app', host: PERSONAL, confirmationToken: preview.confirmationToken, authorize: preview.repeat.words });
  assert.equal(readPreview(preview.previewId, { root: s.root }).tool, 'o11_environment');
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const other = await call({ action: 'delete-app', app: 'Other', host: PERSONAL, confirmationToken: preview.confirmationToken, authorize: 'sim, apaga o 1 ZZApp' });
  assert.equal(other.code, 'PREVIEW_OTHER_TARGET');
  const done = await call({ action: 'delete-app', host: PERSONAL, confirmationToken: preview.confirmationToken, authorize: 'sim, apaga o 1 ZZApp' });
  assert.deepEqual([done.ok, done.state, done.result], [true, 'confirmed', 'feito']);
  // The token of o11_environment is not a token of o11_service_center_write.
  const x = environment({ extensions: [{ key: 'x-1', name: 'ZZExt' }] });
  const run = createO11Extension({ destructiveRoot: x.root, serviceCenter: (argv, extra) => runServiceCenter(argv, { ...x.deps(), ...extra }) });
  assert.equal(extensionSchema.safeParse({ action: 'delete', host: PERSONAL, confirmationToken: 't.x', ownerRequest: 'apaga' }).success, true);
  const xp = await run({ action: 'delete', host: PERSONAL, extension: 'ZZExt' });
  assert.deepEqual([xp.ok, xp.state, xp.continuation.tool, xp.continuation.arguments.confirmationToken], [true, 'previewed', 'o11_extension', xp.confirmationToken]);
  x.clock.advance(CONFIRM_MIN_AGE_MS);
  const wrongTool = await x.run('delete', '--confirmation-token=' + xp.confirmationToken, '--words=sim, apaga o 1 ZZExt');
  assert.deepEqual(wrongTool.problems.map(p => p.code), ['PREVIEW_OTHER_TARGET']);
  const xd = await run({ action: 'delete', host: PERSONAL, extension: 'ZZExt', confirmationToken: xp.confirmationToken, words: 'sim, apaga a 1 ZZExt' });
  assert.equal(xd.state, 'confirmed', JSON.stringify(xd));
  assert.deepEqual(x.sends().map(c => c[2]), ['DeleteModule']);
});

test('the CLI argv and the MCP arguments reach the same two calls; the Studio lock: a preview is a read, an execution a write', async () => {
  const argv = serviceCenterArguments({ action: 'delete', prefix: 'ZZ', words: 'apaga zz' }, 'write');
  assert.deepEqual(argv, ['delete', '--words=apaga zz', '--prefix=ZZ']);
  assert.deepEqual(serviceCenterArguments({ action: 'delete', confirmationToken: 'p.t', words: 'sim, os 2' }, 'write'), ['delete', '--words=sim, os 2', '--confirmation-token=p.t']);
  assert.throws(() => serviceCenterArguments({ action: 'timer-run', confirmationToken: 'p.t' }, 'write'), /deletes only/);
  const s = zz();
  const tool = await serviceCenterTool(['delete', '--prefix=ZZ', '--host=' + PERSONAL], s.deps());
  assert.deepEqual([tool.ok, tool.result.state], [true, 'previewed']);
  for (const [name, args, write] of [
    ['o11_service_center_write', { action: 'delete', prefix: 'ZZ', words: 'apaga' }, false],
    ['o11_service_center_write', { action: 'delete', confirmationToken: 't', words: 'sim' }, true],
    ['o11_service_center_write', { action: 'solution-delete', solution: 'S', execute: true, words: 'x', operationId: 'u' }, false],
    ['o11_service_center_write', { action: 'db-connection-delete', connection: 'C', confirmationToken: 't' }, true],
    ['o11_service_center_write', { action: 'timer-run', execute: true }, true],
    ['o11_environment', { action: 'delete-app', app: 'A', authorize: 'apaga' }, false],
    ['o11_environment', { action: 'delete-app', confirmationToken: 't' }, true],
    ['o11_environment', { action: 'create-app' }, true],
    ['o11_extension', { action: 'delete', extension: 'X', words: 'apaga' }, false],
    ['o11_extension', { action: 'delete', confirmationToken: 't' }, true],
  ]) assert.equal(isWrite(name, args), write, name + ' ' + JSON.stringify(args));
});

test('a standing grant never covers a delete: without words the token refuses, whatever grants exist', async () => {
  const x = environment({ extensions: [{ key: 'x-1', name: 'ZZExt' }] });
  const grants = { covers: () => true, find: () => ({ id: 'g-1' }), list: () => [{ id: 'g-1', scope: '*' }] };
  const run = createO11Extension({ grants, destructiveRoot: x.root, serviceCenter: (argv, extra) => runServiceCenter(argv, { ...x.deps(), ...extra }) });
  const preview = await run({ action: 'delete', host: PERSONAL, extension: 'ZZExt' });
  x.clock.advance(CONFIRM_MIN_AGE_MS);
  const refused = await run({ action: 'delete', host: PERSONAL, confirmationToken: preview.confirmationToken });
  assert.deepEqual(refused.problems.map(p => p.code).sort(), ['CONFIRMATION_COUNT_MISMATCH', 'WORDS_MUST_NAME']);
  assert.deepEqual(x.sends(), []);
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'o11-extension.mjs'), 'utf8');
  const removal = source.slice(source.indexOf('async function remove('), source.indexOf('// deps: root, env, now, runAnvil'));
  assert.ok(!/grant/i.test(removal.replace(/A standing grant never covers a delete/g, '')), 'the delete path never reads a grant');
});

test('solution-delete and db-connection-delete: the prepare is the preview; the token, the names and the count execute under the preview operationId', async () => {
  const { SC, fixture } = await import('./fixtures/sc-fake-bridge.mjs');
  const deleted = [];
  const bridge = new FakeBridge({ pages: {
    [`GET ${SC}DatabaseConnections_List.aspx`]: () => (deleted.length ? '<table><tr><th>Name</th></tr></table><p>No connections found</p>' : fixture('db-connections.html')),
    [`GET ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: fixture('db-connection-edit.html'),
    [`POST ${SC}DatabaseConnection_Edit.aspx?DBConnectionId=3`]: f => { deleted.push(f.__EVENTTARGET); return fixture('db-connections.html'); } } });
  const s = environment();
  const host = 'test.example.com';
  const run = (...argv) => runServiceCenter(['db-connection-delete', '--host', host, '--connection', 'LegacyERP', '--confirm-host', host, ...argv], { ...s.deps(), locate: () => bridge });
  const preview = await run('--execute', '--words', 'delete LegacyERP on test');
  assert.deepEqual([preview.ok, preview.code, preview.state, preview.count, preview.items[0].kind, preview.destructive], [false, 'CONFIRMATION_REQUIRED', 'previewed', 1, 'db-connection', true]);
  assert.deepEqual(bridge.posts(), []);
  s.clock.advance(CONFIRM_MIN_AGE_MS);
  const vague = await run('--confirmation-token', preview.confirmationToken, '--words', 'sim, apaga a 1 no test');
  assert.deepEqual([vague.code, vague.problems.map(p => p.code)], ['DELETE_REFUSED', ['WORDS_MUST_NAME']]);
  const done = await run('--confirmation-token', preview.confirmationToken, '--words', 'sim, apaga a 1 LegacyERP no test');
  assert.deepEqual([done.state, done.operationId, deleted], ['confirmed', preview.operationId, ['wt5$wtDeleteLink']]);
});
