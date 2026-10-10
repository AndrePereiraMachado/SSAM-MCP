// The code under test writes under the user's profile: this process's profile is a temporary folder.
import './fixtures/isolated-profile.mjs';
// The delete engine of the Service Center (service-center/delete.mjs, contract docs/INTEGRACOES-GITSSAM.md lane scdelete):
// one call per delete through the Studio's own Service Center API, refusing before any change with every problem, the
// server's simulation and the consumers read first, the words naming every target and every outside consumer, the wait
// for the real state and the repetition by state. Offline: the fake bridge of sc-fake-bridge.mjs, no Studio, no
// Service Center, nothing live.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { guardWrite, namesWhole } from '../service-center/auth.mjs';
import { StudioBridge } from '../service-center/bridge.mjs';
import { Journal } from '../service-center/client.mjs';
import { BridgeError } from '../service-center/errors.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { DELETE_OPERATIONS, PREFIX_WORDS_NAME_ALL, derivedOperationId } from '../service-center/delete.mjs';
import { sha256 } from '../service-center/util.mjs';
import { CATALOG, FakeBridge, files, temp } from './fixtures/sc-fake-bridge.mjs';

const PERSONAL = 'personal-0000test.outsystemscloud.com';
const CORPORATE = 'test.example.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const PARENT = '11111111-2222-4333-8444-555555555555';

// A synthetic environment: applications, eSpaces and extensions (each with its application key), GetConsumers answers
// by producer key and DeleteApplication simulations by application key. Deletes change the listings.
function environment({ apps = [], espaces = [], extensions = [], consumers = {}, simulations = {}, catalog = CATALOG, host = PERSONAL, uuid = () => PARENT } = {}) {
  const s = { apps: [...apps], espaces: [...espaces], extensions: [...extensions], consumers, simulations, dir: temp(), sleeps: [], linger: {} };
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  // linger[key] = n: the key stays listed n more reads after its delete (the server takes a moment).
  const listed = rows => rows.filter(r => !r.gone || (s.linger[r.key] ?? 0) > 0 && s.linger[r.key]--);
  const moduleRows = rows => listed(rows).map(m => ({ Key: m.key, Name: m.name, ApplicationKey: m.app ?? null }));
  s.removeModule = key => { for (const m of [...s.espaces, ...s.extensions]) if (m.key === key) m.gone = true; };
  s.bridge = new FakeBridge({ serviceCenter: catalog, api: {
    ListApplications: () => listed(s.apps).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: () => (s.espacesReply ? s.espacesReply() : moduleRows(s.espaces)),
    ListExtensions: () => (s.extensionsReply ? s.extensionsReply() : moduleRows(s.extensions)),
    GetConsumers: args => { const v = s.consumers[args.producerESpaceKey] ?? []; return typeof v === 'function' ? v(args) : v; },
    DeleteApplication: args => {
      if (args.simulate) return s.simulations[args.appKey] ?? { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] };
      if (s.deleteApplication) return s.deleteApplication(args);
      for (const a of s.apps) if (a.key === args.appKey) a.gone = true;
      const taken = [...s.espaces, ...s.extensions].filter(m => m.app === args.appKey);
      taken.forEach(m => { m.gone = true; });
      return { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: taken.map(m => m.name) };
    },
    DeleteModule: args => (s.deleteModule ? s.deleteModule(args) : (s.removeModule(args.moduleKey), { success: true, message: null })),
  } });
  s.run = (...argv) => runServiceCenter([...argv, '--host=' + host], { journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false,
    opener: () => assert.fail('no prompt with a Studio connected'), exports: s.dir, registry: REGISTRY, sleep: async ms => { s.sleeps.push(ms); }, uuid });
  s.writes = () => s.bridge.writes();
  s.sent = operation => s.bridge.calls.filter(c => c[0] === 'api' && c[2] === operation && c[4]);
  s.reads = operation => s.bridge.calls.filter(c => c[0] === 'api' && c[2] === operation && !c[4]);
  s.receipts = () => files(path.join(s.dir, 'receipts'), /\.json$/);
  s.locks = () => files(path.join(s.dir, 'receipts'), /\.lock$/);
  return s;
}
const ordersAndBilling = (extra = {}) => environment({ apps: [{ key: 'app-o', name: 'Orders App' }, { key: 'app-b', name: 'Billing App' }],
  espaces: [{ key: 'k-orders', name: 'Orders', app: 'app-o' }, { key: 'k-billing', name: 'Billing', app: 'app-b' }],
  consumers: { 'k-orders': [{ Name: 'Billing' }] }, ...extra });

// ---- 1, 2, 7: consumers outside the set; the words that name them; one call
test('a module with a consumer outside the set is refused with CONSUMERS_WOULD_BREAK; nothing reserved, locked or sent', async () => {
  const s = ordersAndBilling();
  const refused = await s.run('delete', '--target=module:Orders', '--words=pode apagar o módulo Orders');
  assert.deepEqual([refused.ok, refused.code, refused.state], [false, 'DELETE_REFUSED', 'refused']);
  assert.deepEqual(refused.problems.map(p => [p.code, p.consumer, p.application, p.of, p.ssamRule]), [['CONSUMERS_WOULD_BREAK', 'Billing', 'Billing App', 'Orders', true]]);
  assert.match(refused.problems[0].fix, /Billing/);
  assert.deepEqual(refused.consumers, { Orders: ['Billing'] });
  assert.deepEqual(refused.repeat, { action: 'delete', host: PERSONAL, modules: ['Orders'], words: "<the user's own words naming Orders, Billing>" });
  assert.deepEqual([s.writes(), s.receipts(), s.locks()], [[], [], []]);
});

test('words naming the module and its consumer: exactly one DeleteModule with its key as target, confirmed in the same call', async () => {
  const s = ordersAndBilling();
  const words = 'pode apagar o Orders, o Billing quebra e tudo bem';
  const done = await s.run('delete', '--target=module:Orders', '--words=' + words);
  assert.deepEqual([done.ok, done.state, done.operationId, done.auth.path], [true, 'confirmed', PARENT, 'studio']);
  assert.deepEqual(done.deleted, [{ kind: 'module', name: 'Orders', key: 'k-orders', application: 'Orders App' }]);
  const sent = s.sent('DeleteModule');
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0][1], sent[0][3], sent[0][4], sent[0][6]], ['soap', { moduleKey: 'k-orders', moduleKind: 'eSpace' }, true, sha256(words)]);
  // One call minted the parent and derived the child from the parent and the key.
  const child = derivedOperationId(PARENT, 'module', 'k-orders', 1);
  assert.equal(sent[0][5], child);
  assert.deepEqual(s.bridge.targets.filter(Boolean), ['k-orders']);
  assert.deepEqual(s.receipts().sort(), [child + '.json', PARENT + '.json'].sort());
  assert.deepEqual(s.locks(), []);
  const parent = s.journal.lookup(PARENT);
  assert.deepEqual([parent.state, parent.plan.targets.map(t => t.key), parent.children.map(c => c.operationId)], ['confirmed', ['k-orders'], [child]]);
  assert.ok(!fs.readFileSync(path.join(s.dir, 'receipts', PARENT + '.json'), 'utf8').includes(words), 'only the sha256 of the words is kept');
  // The dependency read came before the write.
  const order = s.bridge.calls.filter(c => c[0] === 'api').map(c => c[2]);
  assert.ok(order.indexOf('GetConsumers') < order.indexOf('DeleteModule'));
});

// ---- 3: fail closed
test('GetConsumers failing or unreadable is DEPENDENCY_CHECK_UNAVAILABLE and nothing is written', async () => {
  for (const reply of [new BridgeError('REMOTE_ERROR', 'soap GetConsumers: server error'), { unexpected: true }, null]) {
    const s = ordersAndBilling({ consumers: { 'k-orders': reply } });
    s.bridge.replies.GetConsumers = reply;
    const refused = await s.run('delete', '--target=module:Orders', '--words=apagar Orders');
    assert.equal(refused.code, 'DELETE_REFUSED');
    assert.deepEqual(refused.problems.map(p => [p.code, p.target, p.ssamRule]), [['DEPENDENCY_CHECK_UNAVAILABLE', 'Orders', true]]);
    if (reply instanceof BridgeError) assert.equal(refused.problems[0].cause, 'REMOTE_ERROR');
    assert.deepEqual([s.writes(), s.receipts()], [[], []]);
  }
});

// ---- 4: extensions
test('an extension is checked with its own key in GetConsumers and its consumers block it; the alias extension-delete is the same call', async () => {
  const make = () => environment({ apps: [{ key: 'app-u', name: 'Util' }, { key: 'app-o', name: 'Orders App' }], espaces: [{ key: 'k-orders', name: 'Orders', app: 'app-o' }],
    extensions: [{ key: 'x-util', name: 'UtilExt', app: 'app-u' }], consumers: { 'x-util': [{ Name: 'Orders' }] } });
  const s = make();
  const refused = await s.run('delete', '--target=extension:UtilExt', '--words=apagar a extensão UtilExt');
  assert.deepEqual(refused.problems.map(p => [p.code, p.consumer]), [['CONSUMERS_WOULD_BREAK', 'Orders']]);
  assert.deepEqual(s.reads('GetConsumers').map(c => c[3]), [{ producerESpaceKey: 'x-util', referenceableElementKey: '' }]);
  assert.deepEqual(s.writes(), []);
  const alias = make();
  const done = await alias.run('extension-delete', '--extension=UtilExt', '--words=apagar a extensão UtilExt mesmo quebrando o Orders');
  assert.deepEqual([done.state, done.deleted.map(d => d.kind)], ['confirmed', ['extension']]);
  assert.deepEqual(alias.sent('DeleteModule').map(c => c[3]), [{ moduleKey: 'x-util', moduleKind: 'Extension' }]);
});

// ---- 5: applications
test('an application: the simulation first; affectedApplications must be named; then one DeleteApplication with its key as target', async () => {
  const make = (simulation) => environment({ apps: [{ key: 'app-z', name: 'ZZDemo' }, { key: 'app-s', name: 'Sales' }], espaces: [{ key: 'k-z', name: 'ZZDemo_CS', app: 'app-z' }],
    simulations: { 'app-z': simulation } });
  const sim = { success: true, simulated: true, messages: [{ Id: 'x', Message: 'would delete', Type: 'Info' }], affectedApplications: ['Sales'], deletedModules: ['ZZDemo_CS'] };
  const s = make(sim);
  const refused = await s.run('delete', '--target=application:ZZDemo', '--words=apagar o ZZDemo');
  assert.deepEqual(refused.problems.map(p => [p.code, p.consumer, p.of]), [['CONSUMERS_WOULD_BREAK', 'Sales', 'ZZDemo']]);
  assert.match(refused.problems[0].fix, /applications/);
  assert.deepEqual([refused.deletedModules, refused.affectedApplications], [['ZZDemo_CS'], ['Sales']]);
  assert.deepEqual(s.writes(), []);
  const ok = make(sim);
  const done = await ok.run('application-delete', '--application=ZZDemo', '--words=apagar o ZZDemo, o Sales sabe');
  assert.equal(done.state, 'confirmed');
  const calls = ok.bridge.calls.filter(c => c[0] === 'api' && c[2] === 'DeleteApplication');
  assert.deepEqual(calls.map(c => [c[3], c[4]]), [[{ appKey: 'app-z', simulate: true }, false], [{ appKey: 'app-z', simulate: false }, true]]);
  assert.deepEqual(ok.bridge.targets.filter(Boolean), ['app-z']);
  assert.deepEqual(done.deletedModules, ['ZZDemo_CS']);
  // The platform's own refusal: SIMULATION_REFUSED with its messages, never sent, no ssamRule.
  const blocked = make({ success: false, simulated: true, messages: [{ Message: 'Application has dependents', Type: 'Error' }], affectedApplications: [], deletedModules: [] });
  const no = await blocked.run('delete', '--target=application:ZZDemo', '--words=apagar o ZZDemo');
  assert.deepEqual(no.problems.map(p => [p.code, p.messages, p.ssamRule]), [['SIMULATION_REFUSED', ['Application has dependents'], undefined]]);
  assert.deepEqual(blocked.writes(), []);
});

// ---- 6: whole words
test('words name a target as a whole word, case- and accent-insensitive: ZZDemo2 does not authorize ZZDemo', async () => {
  assert.equal(namesWhole('apagar ZZDemo2', 'ZZDemo'), false);
  assert.equal(namesWhole('Pode apagar o zzdemo.', 'ZZDemo'), true);
  assert.equal(namesWhole('apague a ação de teste', 'Acao'), true);
  assert.equal(namesWhole('apague acao', 'Ação'), true);
  assert.equal(namesWhole('pode apagar o ZZ  Demo  App', 'ZZ Demo App'), true);
  assert.equal(namesWhole('apagar Orders_Old', 'Orders'), false);
  assert.throws(() => guardWrite(PERSONAL, 'apagar Orders2', null, ['Orders'], REGISTRY), /name its target/);
  assert.equal(guardWrite(PERSONAL, 'apagar ORDERS!', null, ['Orders'], REGISTRY), 'personal');
  const make = () => environment({ apps: [{ key: 'app-z', name: 'ZZDemo' }, { key: 'app-2', name: 'ZZDemo2' }] });
  const s = make();
  const refused = await s.run('delete', '--target=application:ZZDemo', '--words=apagar ZZDemo2');
  assert.deepEqual(refused.problems.map(p => [p.code, p.target, p.ssamRule]), [['WORDS_MUST_NAME', 'ZZDemo', true]]);
  assert.deepEqual(s.writes(), []);
  const accent = environment({ apps: [{ key: 'app-a', name: 'Ação' }] });
  assert.equal((await accent.run('delete', '--target=application:Ação', '--words=APAGAR A ACAO')).state, 'confirmed');
});

// ---- 8: the bounded wait
test('the call waits for the real state: listed for two more reads, then gone, is confirmed; never gone is DELETE_UNCONFIRMED keeping the lock', async () => {
  const s = environment({ apps: [{ key: 'app-o', name: 'Orders App' }], espaces: [{ key: 'k-orders', name: 'Orders', app: 'app-o' }] });
  s.deleteModule = args => { s.removeModule(args.moduleKey); s.linger[args.moduleKey] = 2; return { success: true, message: null }; };
  const done = await s.run('delete', '--target=module:Orders', '--words=apagar Orders');
  assert.deepEqual([done.ok, done.state], [true, 'confirmed']);
  assert.equal(s.sleeps.length, 2, 'two pauses between the three reads after the send');
  const stuck = environment({ apps: [{ key: 'app-o', name: 'Orders App' }], espaces: [{ key: 'k-orders', name: 'Orders', app: 'app-o' }] });
  stuck.deleteModule = () => ({ success: true, message: null });
  const unconfirmed = await stuck.run('delete', '--target=module:Orders', '--words=apagar Orders');
  assert.deepEqual([unconfirmed.ok, unconfirmed.code, unconfirmed.state], [false, 'DELETE_UNCONFIRMED', 'uncertain']);
  assert.equal(stuck.sleeps.reduce((a, b) => a + b, 0), 30000, 'about 30 s of pauses, then the answer');
  assert.ok(stuck.sleeps.every(ms => ms >= 1000 && ms <= 5000));
  assert.equal(stuck.locks().length, 1, 'the target stays locked');
  assert.equal(unconfirmed.repeat.operationId, PARENT);
  assert.equal(stuck.sent('DeleteModule').length, 1);
});

// ---- 9: every problem at once
test('a missing target, an ambiguous name and a module blocked by a consumer are three problems of one refusal, nothing written', async () => {
  const s = environment({ apps: [{ key: 'app-o', name: 'Orders App' }, { key: 'app-b', name: 'Billing App' }],
    espaces: [{ key: 'k-orders', name: 'Orders', app: 'app-o' }, { key: 'k-billing', name: 'Billing', app: 'app-b' }, { key: 'k-twin', name: 'Twin', app: 'app-o' }],
    extensions: [{ key: 'x-twin', name: 'Twin', app: 'app-o' }], consumers: { 'k-orders': [{ Name: 'Billing' }] } });
  const refused = await s.run('delete', '--target=module:Ghost', '--target=module:Twin', '--target=module:Orders', '--words=apagar Orders, Ghost e Twin');
  assert.deepEqual(refused.problems.map(p => p.code).sort(), ['CONSUMERS_WOULD_BREAK', 'TARGET_AMBIGUOUS', 'TARGET_NOT_FOUND']);
  const ambiguous = refused.problems.find(p => p.code === 'TARGET_AMBIGUOUS');
  assert.deepEqual(ambiguous.candidates.map(c => [c.kind, c.key]), [['module', 'k-twin'], ['extension', 'x-twin']]);
  assert.match(ambiguous.fix, /k-twin/); assert.match(ambiguous.fix, /extensions/);
  assert.ok(refused.problems.find(p => p.code === 'TARGET_NOT_FOUND').nearest.length <= 5);
  assert.deepEqual([s.writes(), s.receipts()], [[], []]);
  // One read of each listing for the whole plan.
  assert.deepEqual(['ListApplications', 'ListEspaces', 'ListExtensions'].map(op => s.reads(op).length), [1, 1, 1]);
});

// ---- 10: prefix
test('prefix ZZ: a consumer inside the set is exempt and goes first; more than maxDeletes is DELETE_LIMIT_EXCEEDED; a protected app matched by the prefix needs its whole name', async () => {
  assert.equal(PREFIX_WORDS_NAME_ALL, true);
  const zz = () => environment({ apps: [{ key: 'app-b', name: 'ZZB' }, { key: 'app-a', name: 'ZZA' }, { key: 'app-o', name: 'Orders App' }],
    simulations: { 'app-b': { success: true, simulated: true, messages: [], affectedApplications: ['ZZA'], deletedModules: [] } } });
  const s = zz();
  const done = await s.run('delete', '--prefix=ZZ', '--words=apagar todas as apps que começam com ZZ');
  assert.deepEqual([done.ok, done.state], [true, 'confirmed']);
  assert.deepEqual(s.sent('DeleteApplication').map(c => c[3].appKey), ['app-a', 'app-b'], 'ZZA consumes ZZB: ZZA is deleted first');
  assert.deepEqual(done.deleted.map(d => d.name), ['ZZA', 'ZZB']);
  const limited = zz();
  const tooMany = await limited.run('delete', '--prefix=ZZ', '--max-deletes=1', '--words=apagar as apps ZZ');
  assert.deepEqual(tooMany.problems.map(p => [p.code, p.matches]), [['DELETE_LIMIT_EXCEEDED', ['ZZA', 'ZZB']]]);
  assert.deepEqual(limited.writes(), []);
  const users = () => environment({ apps: [{ key: 'app-u', name: 'Users' }, { key: 'app-t', name: 'UtilApp' }] });
  const guarded = users();
  const no = await guarded.run('delete', '--prefix=U', '--words=apagar tudo que começa com U');
  assert.deepEqual(no.problems.map(p => [p.code, p.target, p.ssamRule]), [['PROTECTED_TARGET', 'Users', true]]);
  assert.deepEqual(guarded.writes(), []);
  const named = users();
  const yes = await named.run('delete', '--prefix=U', '--words=apagar as apps U, inclusive Users');
  assert.deepEqual([yes.state, named.sent('DeleteApplication').length], ['confirmed', 2]);
  // The prefix names its matches only as a whole word.
  const vague = zz();
  const partial = await vague.run('delete', '--prefix=ZZ', '--words=apagar as ZZApps');
  assert.deepEqual(partial.problems.map(p => p.code), ['WORDS_MUST_NAME', 'WORDS_MUST_NAME']);
});

// ---- 11: drift
test('a key renamed between the plan and the send is CONFLICT: nothing is sent for it and the rest stops', async () => {
  const s = environment({ apps: [{ key: 'app-o', name: 'Orders App' }], espaces: [{ key: 'k-orders', name: 'Orders', app: 'app-o' }, { key: 'k-other', name: 'Other', app: 'app-o' }] });
  let reads = 0;
  s.espacesReply = () => (++reads === 1 ? [{ Key: 'k-orders', Name: 'Orders', ApplicationKey: 'app-o' }, { Key: 'k-other', Name: 'Other', ApplicationKey: 'app-o' }]
    : [{ Key: 'k-orders', Name: 'OrdersRenamed', ApplicationKey: 'app-o' }, { Key: 'k-other', Name: 'Other', ApplicationKey: 'app-o' }]);
  const conflict = await s.run('delete', '--target=module:Orders', '--target=module:Other', '--words=apagar Orders e Other');
  assert.deepEqual([conflict.ok, conflict.code, conflict.state, conflict.observed], [false, 'CONFLICT', 'refused', 'OrdersRenamed']);
  assert.deepEqual(s.sent('DeleteModule'), []);
  assert.deepEqual(conflict.notSent.map(n => n.name), ['Orders', 'Other']);
});

// ---- 12: repetition by state
test('repeating the call: a target already gone is absent with its receipt, nothing sent', async () => {
  const s = ordersAndBilling({ consumers: {} });
  const words = 'apagar Orders';
  assert.equal((await s.run('delete', '--target=module:Orders', '--words=' + words)).state, 'confirmed');
  const again = await s.run('delete', '--target=module:Orders', '--words=' + words);
  assert.deepEqual([again.ok, again.state, again.absent.map(a => [a.name, a.receiptState])], [true, 'absent', [['Orders', 'confirmed']]]);
  assert.ok(again.absent[0].receipt.endsWith('.json'));
  assert.equal(s.sent('DeleteModule').length, 1);
});

test('an uncertain child read as gone closes confirmed; read as still there it allows exactly one new send', async () => {
  // The answer is lost but the delete took effect: the same call reads it gone and closes the receipt.
  const s = ordersAndBilling({ consumers: {} });
  s.deleteModule = args => { s.removeModule(args.moduleKey); throw new BridgeError('UNCERTAIN', 'connection lost after send', { write: true }); };
  const lost = await s.run('delete', '--target=module:Orders', '--words=apagar Orders');
  assert.deepEqual([lost.code, lost.state, s.locks().length], ['UNCERTAIN', 'uncertain', 1]);
  const settled = await s.run('delete', '--target=module:Orders', '--words=apagar Orders', '--operation-id=' + lost.operationId);
  assert.deepEqual([settled.ok, settled.state, settled.deleted.map(d => [d.name, d.reconciled])], [true, 'confirmed', [['Orders', true]]]);
  assert.deepEqual([s.sent('DeleteModule').length, s.locks()], [1, []]);
  assert.equal(s.journal.lookup(derivedOperationId(PARENT, 'module', 'k-orders', 1)).state, 'confirmed');

  // The answer is lost and the module is still there, unchanged: one new send (attempt 2), then never a third.
  const t = ordersAndBilling({ consumers: {} });
  t.deleteModule = () => { throw new BridgeError('UNCERTAIN', 'connection lost after send', { write: true }); };
  const first = await t.run('delete', '--target=module:Orders', '--words=apagar Orders');
  assert.equal(first.state, 'uncertain');
  const second = await t.run('delete', '--target=module:Orders', '--words=apagar Orders', '--operation-id=' + first.operationId);
  assert.equal(second.state, 'uncertain');
  assert.deepEqual(t.sent('DeleteModule').map(c => c[5]), [derivedOperationId(PARENT, 'module', 'k-orders', 1), derivedOperationId(PARENT, 'module', 'k-orders', 2)]);
  assert.equal(t.journal.lookup(derivedOperationId(PARENT, 'module', 'k-orders', 1)).state, 'superseded');
  const third = await t.run('delete', '--target=module:Orders', '--words=apagar Orders', '--operation-id=' + first.operationId);
  assert.deepEqual(third.problems.map(p => p.code), ['DELETE_UNCONFIRMED']);
  assert.equal(t.sent('DeleteModule').length, 2, 'never a third send');

  // A new call without the operationId reads the same: the pending child of the target allows one new send, which works.
  const u = ordersAndBilling({ consumers: {} });
  u.deleteModule = () => { throw new BridgeError('UNCERTAIN', 'lost', { write: true }); };
  await u.run('delete', '--target=module:Orders', '--words=apagar Orders');
  u.deleteModule = null;
  let ids = 0;
  const fresh = await runServiceCenter(['delete', '--target=module:Orders', '--words=apagar Orders', '--host=' + PERSONAL], { journal: u.journal, locate: () => u.bridge,
    present: async () => false, running: async () => false, exports: u.dir, registry: REGISTRY, sleep: async () => {}, uuid: () => `22222222-2222-4222-8222-22222222222${ids++}` });
  assert.deepEqual([fresh.state, u.sent('DeleteModule').length, u.locks()], ['confirmed', 2, []]);
});

// ---- 13: the bridge gate
test('a bridge whose serviceCenter catalog lacks an operation of the delete is STUDIO_BRIDGE_OUTDATED before any read', async () => {
  for (const [catalog, missing] of [[{ ...CATALOG, soap: CATALOG.soap.filter(op => op !== 'GetConsumers') }, ['GetConsumers']], [null, DELETE_OPERATIONS]]) {
    const s = ordersAndBilling({ catalog });
    const old = await s.run('delete', '--target=module:Orders', '--words=apagar Orders e Billing');
    assert.deepEqual([old.ok, old.code, old.missing], [false, 'STUDIO_BRIDGE_OUTDATED', missing]);
    assert.equal(old.continuation.tool, 'ssam_connect');
    assert.deepEqual(s.bridge.calls.filter(c => c[0] === 'api'), []);
  }
});

test('execute:false only plans: the same reads, nothing reserved; without words the plan says what the words must name', async () => {
  const s = ordersAndBilling();
  const plan = await s.run('delete', '--target=module:Orders', '--words=apagar Orders e Billing', '--plan-only');
  assert.deepEqual([plan.ok, plan.state, plan.operationId], [true, 'planned', undefined]);
  assert.deepEqual(plan.wordsMustName, ['Orders', 'Billing']);
  assert.deepEqual(plan.externalConsumers, [{ consumer: 'Billing', application: 'Billing App', of: 'Orders', kind: 'module' }]);
  const bare = await s.run('module-delete', '--module=Orders');
  assert.deepEqual([bare.state, bare.targets.map(t => t.key)], ['planned', ['k-orders']]);
  assert.deepEqual([s.writes(), s.receipts()], [[], []]);
  assert.match((await s.run('delete', '--words=x')).error, /needs its targets/);
  assert.match((await s.run('timer-run', '--module-id=3', '--name=T', '--plan-only')).error, /apply to delete/);
});

test('a corporate host needs confirmHost and words naming it; the problem joins the others in one refusal', async () => {
  const s = environment({ host: CORPORATE, apps: [{ key: 'app-z', name: 'ZZDemo' }] });
  const refused = await s.run('delete', '--target=application:ZZDemo', '--words=apagar ZZDemo');
  assert.deepEqual(refused.problems.map(p => p.code), ['CONFIRM_HOST_REQUIRED']);
  assert.equal(refused.repeat.confirmHost, CORPORATE);
  const done = await s.run('delete', '--target=application:ZZDemo', '--words=apagar ZZDemo no test', '--confirm-host=' + CORPORATE);
  assert.equal(done.state, 'confirmed');
  assert.equal(s.bridge.corporate, true);
});

// ---- 14: extension-publish for the xif lane (contract I1)
function publishEnvironment() {
  const s = { dir: temp(), sleeps: [], extensions: [{ key: 'x-util', name: 'SampleUtilExt', applicationKey: 'app-2', versionId: 3203 }], published: false, reads: 0 };
  s.journal = new Journal(path.join(s.dir, 'receipts'));
  s.xif = path.join(s.dir, 'SampleUtilExt.xif');
  fs.writeFileSync(s.xif, Buffer.from('PK\x03\x04extension', 'latin1'));
  s.bridge = new FakeBridge({ api: {
    ListExtensions: () => { if (s.published) s.reads++; return s.extensions.map(x => ({ ...x, versionId: s.published && s.reads >= 3 && x.key === 'x-util' ? 3300 : x.versionId })); },
    UploadAndPublishExtension: () => { s.published = true; return { messages: [], extensionId: 205, extensionVersionId: 3300 }; },
  } });
  s.run = (...argv) => runServiceCenter([...argv, '--host=' + PERSONAL], { journal: s.journal, locate: () => s.bridge, present: async () => false, running: async () => false,
    exports: s.dir, registry: REGISTRY, sleep: async ms => { s.sleeps.push(ms); } });
  s.uploads = () => s.bridge.calls.filter(c => c[0] === 'api' && c[2] === 'UploadAndPublishExtension');
  return s;
}

test('extension-publish waits until the listing shows the returned version; a changed version is refused before the reservation; verify reconciles by reading', async () => {
  const s = publishEnvironment();
  const operation = '33333333-3333-4333-8333-333333333333';
  const done = await s.run('extension-publish', '--xif-file=' + s.xif, '--extension=SampleUtilExt', '--expected-version-id=3203', '--words=publicar SampleUtilExt', '--operation-id=' + operation, '--execute');
  assert.deepEqual([done.state, done.extensionVersionId, done.reads, s.sleeps.length], ['confirmed', 3300, 3, 2]);
  assert.deepEqual([done.plan.extension, done.plan.observedVersionId, done.plan.expectedVersionId], ['SampleUtilExt', 3203, '3203']);

  const changed = publishEnvironment();
  const refused = await changed.run('extension-publish', '--xif-file=' + changed.xif, '--extension=SampleUtilExt', '--expected-version-id=3100', '--words=publicar SampleUtilExt', '--operation-id=' + operation, '--execute');
  assert.deepEqual([refused.ok, refused.code, refused.observed], [false, 'EXTENSION_VERSION_CHANGED', { versionId: 3203 }]);
  assert.deepEqual([changed.uploads(), files(path.join(changed.dir, 'receipts'))], [[], []]);
  const fresh = publishEnvironment();
  const none = await fresh.run('extension-publish', '--xif-file=' + fresh.xif, '--extension=BrandNewExt', '--expected-version-id=none');
  assert.deepEqual([none.execute, none.observedVersionId, none.expectedVersionId], [false, null, null]);
  const wrongNone = await fresh.run('extension-publish', '--xif-file=' + fresh.xif, '--extension=SampleUtilExt', '--expected-version-id=none');
  assert.equal(wrongNone.code, 'EXTENSION_VERSION_CHANGED');

  // A lost answer stays uncertain; verify reads the named extension running another version and closes it, never uploads.
  const lost = publishEnvironment();
  lost.bridge.replies.UploadAndPublishExtension = () => { lost.published = true; lost.reads = 3; throw new BridgeError('UNCERTAIN', 'connection lost after send', { write: true }); };
  const uncertain = await lost.run('extension-publish', '--xif-file=' + lost.xif, '--extension=SampleUtilExt', '--words=publicar SampleUtilExt', '--operation-id=' + operation, '--execute');
  assert.equal(uncertain.state, 'uncertain');
  const verified = await lost.run('verify', '--operation-id=' + operation);
  assert.deepEqual([verified.observedDesiredState, verified.state], [true, 'confirmed']);
  assert.equal(lost.uploads().length, 1);
});

// ---- 15: the integration-studio surface (contract I2)
test('bridge.api reads the integration-studio surface; a write there is BAD_REQUEST and nothing is sent; serviceCenterCatalog reads the manifest', async () => {
  const dir = temp(); const key = path.join(dir, 'bridge.key'); fs.writeFileSync(key, 'k3y', 'ascii');
  const seen = [];
  const request = async (connection, method, params) => {
    seen.push({ method, params });
    if (method === 'bridge_manifest') return { success: true, data: { verbs: ['sc_api'], capabilities: ['sc_api:soap', 'sc_api:integration-studio'], serviceCenter: { soap: ['ListEspaces'], 'integration-studio': ['Handshake'] } } };
    return { success: true, data: { ok: true, source: 'studio', result: { serverVersion: '11.x' } } };
  };
  const bridge = new StudioBridge(1, key, { request });
  const reply = await bridge.api(CORPORATE, 'integration-studio', 'Handshake', {});
  assert.deepEqual([reply.ok, reply.result, seen[0].params.surface, seen[0].params.write], [true, { serverVersion: '11.x' }, 'integration-studio', undefined]);
  await assert.rejects(bridge.api(CORPORATE, 'integration-studio', 'GenerateSourceCodeStubs', {}, { write: true, operationId: PARENT, authorizeSha256: 'a'.repeat(64) }),
    e => e instanceof BridgeError && e.code === 'BAD_REQUEST');
  assert.equal(seen.length, 1, 'the write never left');
  await assert.rejects(bridge.api(CORPORATE, 'nope', 'Handshake', {}), e => e.code === 'BAD_REQUEST');
  assert.deepEqual(await bridge.serviceCenterCatalog(), { soap: ['ListEspaces'], 'integration-studio': ['Handshake'] });
});
