import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerO11Environment, environmentArguments, ENVIRONMENT_WRITES } from '../o11-environment.mjs';
import { Journal } from '../service-center/client.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { envelopes, failedPublish, tempKernel, linked } from './fixtures/o11env-kernel.mjs';
import { FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';

// One server per test over a temporary kernel root; the CLI is always the fake, the Studio check a counter. extra: the
// Service Center engine's fakes of delete-app (serviceCenterDeps, studioHosts).
async function harness(t, { handlers = envelopes, runAnvil, assertSelected, cli = true, extra = {} } = {}) {
  const kernel = tempKernel({ cli });
  const run = runAnvil ?? fakeAnvil(handlers);
  const selected = { calls: 0 };
  const deps = { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, now: () => new Date('2026-10-02T12:00:00.000Z'),
    uuid: () => '00000000-0000-4000-8000-000000000001', assertSelected: assertSelected ?? (async () => { selected.calls++; }), ...extra };
  const mcp = await linked(registerO11Environment, deps);
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  const local = path.join(kernel.root, '.local');
  return { ...mcp, run, selected, root: kernel.root, local, journal: path.join(local, 'journal', 'o11_environment.jsonl'),
    folder: action => path.join(local, 'environment', action, '20261002T120000000Z') };
}
const WORDS = 'Sim, pode criar o app Demo App e apagar o ZZScratch';
const journalLines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

test('o11_environment is listed with its actions and never offers a credential field', async t => {
  const h = await harness(t);
  const tool = (await h.client.listTools()).tools.find(x => x.name === 'o11_environment');
  assert.ok(tool, 'missing o11_environment');
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['inventory', 'download', 'download-app', 'templates', 'references', 'referenceable',
    'create-app', 'add-modules', 'create-module', 'update-app', 'refresh-refs', 'set-user-provider', 'delete-app']);
  for (const key of Object.keys(tool.inputSchema.properties)) assert.doesNotMatch(key, /credential|password|secret|user(name)?$/i);
});

test('reads run with the exact argv, a read-only lease, the Studio check first and never --credentials', async t => {
  const h = await harness(t);
  const oml = path.join(h.root, 'Demo_CS.oml'); fs.writeFileSync(oml, '');
  const inventory = await h.call('o11_environment', { action: 'inventory', host: 'personal-test.outsystemscloud.com' });
  assert.equal(inventory.ok, true);
  assert.deepEqual(h.run.calls[0].args, ['inventory', '--out', h.folder('inventory'), '--host', 'personal-test.outsystemscloud.com', '--read-only']);
  assert.equal(h.run.calls[0].options.cwd, h.root);
  assert.equal(inventory.file, path.join(h.folder('inventory'), 'inventory.json'));
  assert.deepEqual(inventory.apps, [{ name: 'Demo', key: 'app-1' }, { name: 'ZZScratch', key: 'app-2' }]);
  assert.equal(inventory.applications, 2); assert.equal(inventory.modules, 2);
  assert.ok(fs.statSync(h.folder('inventory')).isDirectory());

  const download = await h.call('o11_environment', { action: 'download', module: 'Demo_CS', version: 42 });
  assert.deepEqual(h.run.calls[1].args, ['download', '--module', 'Demo_CS', '--out', h.folder('download'), '--version', '42', '--cache', path.join(h.local, 'environment', 'published'), '--read-only']);
  assert.deepEqual(download, { ok: true, file: path.join(h.folder('download'), 'Demo_CS.oml'), module: 'Demo_CS', key: 'mod-1', versionId: 42, cached: false, isError: false });

  const out = path.join(h.root, 'my downloads');
  const app = await h.call('o11_environment', { action: 'download-app', apps: ['Demo', 'Other App'], out });
  assert.deepEqual(h.run.calls[2].args, ['download-app', '--app', 'Demo,Other App', '--out', out, '--read-only']);
  assert.deepEqual(app.files, [path.join(out, 'Demo', 'Demo_CS.oml')]); assert.deepEqual(app.skipped, ['Demo_Ext']); assert.equal(app.ok, true);

  const templates = await h.call('o11_environment', { action: 'templates' });
  assert.deepEqual(h.run.calls[3].args, ['templates', '--with-host', '--read-only']); // vel-entrega: {host, templates} for the cache per environment
  assert.deepEqual(templates.templates, [{ key: 'tpl-1', label: 'Reactive Web App', kind: 'CrossDevice' }]);

  const producers = await h.call('o11_environment', { action: 'referenceable', filter: 'users' });
  assert.deepEqual(h.run.calls[4].args, ['referenceable', '--read-only']);
  assert.deepEqual(producers.producers, [{ name: 'Users', key: 'ref-1', kind: 'eSpace' }]); assert.equal(producers.count, 2);
  assert.equal(JSON.parse(fs.readFileSync(producers.file, 'utf8')).length, 2);
  assert.equal(h.selected.calls, 5, 'every Studio read checks the selected Studio first');

  // references is offline: no Studio check, no lease, its own work folder.
  const references = await h.call('o11_environment', { action: 'references', oml });
  assert.deepEqual(h.run.calls[5].args, ['references', '--oml', oml, '--work', path.join(h.folder('references'), 'work')]);
  assert.deepEqual(references.references, [{ name: 'OutSystemsUI', key: 'ref-2', kind: 'eSpace', elements: 12 }]);
  assert.equal(h.selected.calls, 5);
  for (const call of h.run.calls) assert.ok(!call.args.some(a => /credential/i.test(a)), call.args.join(' '));
});

test('writes run with the exact argv of Program.cs and never --credentials', async t => {
  const h = await harness(t);
  const cases = [
    // blank with a Reactive module is BLANK_UI_MODULE before the CLI (A16, pa2-f8-environment.test.mjs); --blank is the
    // add-modules case below, with a Library module.
    [{ action: 'create-app', name: 'Demo App', modules: [{ name: 'Demo_UI', kind: 'Reactive' }, { name: 'Demo_CS', kind: 'Service' }], kind: 'Reactive',
      templateKey: 'tpl-1', template: 'Reactive Web App', color: '#2E86C1', host: 'h.example' },
      out => ['create-app', '--name', 'Demo App', '--modules', 'Demo_UI:Reactive,Demo_CS:Service', '--out', out, '--kind', 'Reactive', '--template-key', 'tpl-1',
        '--template', 'Reactive Web App', '--color', '#2E86C1', '--host', 'h.example'],
      { ok: true, app: 'Demo App', key: 'app-9', modules: [{ name: 'Demo_UI', key: 'mod-9' }] }],
    [{ action: 'add-modules', app: 'Demo', modules: [{ name: 'Demo_Lib', kind: 'Library' }], templateKey: 'tpl-1', blank: true },
      out => ['add-modules', '--app', 'Demo', '--modules', 'Demo_Lib:Library', '--out', out, '--template-key', 'tpl-1', '--blank'],
      { ok: true, app: 'Demo', modules: [{ name: 'Demo_Lib', key: 'mod-10' }] }],
    [{ action: 'create-module', app: 'Demo', name: 'Demo_UI2', replace: true, templateKey: 'tpl-1', description: 'Second UI', noPublish: true },
      out => ['create-module', '--app', 'Demo', '--name', 'Demo_UI2', '--out', out, '--replace', '--template-key', 'tpl-1', '--description', 'Second UI', '--no-publish'],
      out => ({ ok: true, module: 'Demo_UI2', key: 'mod-11', file: path.join(out, 'Demo_UI2.oml') })],
    [{ action: 'update-app', name: 'Demo', color: '#112233', description: 'New text' },
      () => ['update-app', '--name', 'Demo', '--color', '#112233', '--description', 'New text'], { ok: true, result: 'feito' }],
    [{ action: 'refresh-refs', module: 'Demo_CS', all: true, publish: true },
      out => ['refresh-refs', '--module', 'Demo_CS', '--out', out, '--all', '--publish'],
      { ok: true, module: 'Demo_CS', refreshed: ['Users', 'OutSystemsUI'], published: true }],
    [{ action: 'set-user-provider', module: 'Demo_CS', providerName: 'Users', providerKey: 'ref-1' },
      out => ['set-user-provider', '--module', 'Demo_CS', '--out', out, '--provider-name', 'Users', '--provider-key', 'ref-1'], { ok: true, result: 'feito' }],
  ];
  for (const [index, [input, argv, expected]] of cases.entries()) {
    const value = await h.call('o11_environment', { ...input, authorize: WORDS });
    const out = h.folder(input.action);
    assert.deepEqual(h.run.calls[index].args, argv(out), input.action);
    const { isError, publication, ...answer } = value;
    assert.deepEqual(answer, typeof expected === 'function' ? expected(out) : expected, input.action);
    // refresh-refs {publish:true} names its publication (version, time, operationId; atritos-a-refresh.test.mjs).
    if (input.action === 'refresh-refs') assert.deepEqual([publication.version, publication.operationId], [70, '00000000-0000-4000-8000-000000000001']);
    else assert.equal(publication, undefined, input.action);
    assert.ok(!h.run.calls[index].args.some(a => /credential/i.test(a) || a === WORDS), 'never a credential, never the words');
  }
  assert.equal(h.selected.calls, cases.length);
  // delete-app is the Service Center delete engine, never a CLI argv (its own test below).
  assert.deepEqual(new Set([...cases.map(c => c[0].action), 'delete-app']), new Set(ENVIRONMENT_WRITES));
  assert.throws(() => environmentArguments({ action: 'delete-app', app: 'ZZScratch' }), /Unknown action/);
});

test('every write needs the user\'s words; a read refuses them; nothing runs before that', async t => {
  const h = await harness(t);
  for (const input of [{ action: 'update-app', name: 'Demo', color: '#112233' }, { action: 'delete-app', app: 'ZZScratch' },
    { action: 'create-app', name: 'X', modules: [{ name: 'X_CS', kind: 'Service' }], authorize: '   ' }]) {
    const value = await h.call('o11_environment', input);
    assert.equal(value.ok, false); assert.equal(value.code, 'WORDS_REQUIRED', input.action);
    assert.equal(value.continuation.tool, 'o11_environment'); assert.match(value.continuation.why, /ask the user/);
  }
  const read = await h.call('o11_environment', { action: 'inventory', authorize: 'yes' });
  assert.equal(read.code, 'UNKNOWN_FIELD'); assert.match(read.note, /no authorization words/);
  assert.deepEqual(read.continuation.arguments, { action: 'inventory' });
  assert.equal(h.run.calls.length, 0); assert.equal(h.selected.calls, 0);
  assert.equal(fs.existsSync(h.journal), false);
});

// The Service Center fakes of delete-app: two applications, the server's simulation and the delete that removes one.
const PERSONAL = 'personal-0000test.outsystemscloud.com';
function serviceCenterFakes({ affected = [] } = {}) {
  const state = { apps: [{ Key: 'app-z', Name: 'ZZScratch' }, { Key: 'app-d', Name: 'Demo' }] };
  const dir = temp();
  const bridge = new FakeBridge({ api: { ListApplications: () => state.apps.map(a => ({ ...a })), ListEspaces: [], ListExtensions: [],
    DeleteApplication: args => (args.simulate ? { success: true, simulated: true, messages: [], affectedApplications: affected, deletedModules: ['ZZScratch_UI'] }
      : (state.apps = state.apps.filter(a => a.Key !== args.appKey), { success: true, simulated: false, messages: [], affectedApplications: [], deletedModules: ['ZZScratch_UI'] })) } });
  const deps = { journal: new Journal(path.join(dir, 'receipts')), locate: () => bridge, present: async () => false, running: async () => false, exports: dir,
    registry: path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json'), sleep: async () => {} };
  return { state, bridge, deps, simulations: () => bridge.calls.filter(c => c[2] === 'DeleteApplication' && !c[4]), deletes: () => bridge.calls.filter(c => c[2] === 'DeleteApplication' && c[4]) };
}

test('delete-app runs the Service Center delete engine (the server simulation first) and never the CLI with --confirm', async t => {
  const sc = serviceCenterFakes();
  const h = await harness(t, { extra: { serviceCenterDeps: sc.deps } });
  const vague = await h.call('o11_environment', { action: 'delete-app', app: 'ZZScratch', host: PERSONAL, authorize: 'sim, pode apagar' });
  assert.deepEqual([vague.ok, vague.code, vague.isError, vague.problems.map(p => p.code)], [false, 'DELETE_REFUSED', true, ['WORDS_MUST_NAME']]);
  assert.deepEqual(vague.continuation.arguments, { action: 'delete-app', app: 'ZZScratch', host: PERSONAL, authorize: "<the user's own words naming ZZScratch>" });
  const longer = await h.call('o11_environment', { action: 'delete-app', app: 'ZZScratch', host: PERSONAL, authorize: 'apague o ZZScratch2' });
  assert.deepEqual(longer.problems.map(p => p.code), ['WORDS_MUST_NAME'], 'another application whose name starts the same is not this one');
  assert.deepEqual(sc.deletes(), []);
  const named = await h.call('o11_environment', { action: 'delete-app', app: 'ZZScratch', host: PERSONAL, authorize: 'Pode apagar o zzscratch.' });
  assert.deepEqual([named.ok, named.result, named.state, named.deleted.map(d => d.name), named.deletedModules], [true, 'feito', 'confirmed', ['ZZScratch'], ['ZZScratch_UI']]);
  // Not only ZZ: any application the words name (the engine's rules decide, not the name).
  const demo = await h.call('o11_environment', { action: 'delete-app', app: 'Demo', host: PERSONAL, authorize: 'apague o Demo' });
  assert.equal(demo.state, 'confirmed');
  assert.deepEqual(sc.simulations().map(c => c[3].appKey), ['app-z', 'app-z', 'app-z', 'app-d'], 'the simulation is read in every call, before any delete');
  assert.deepEqual(sc.deletes().map(c => c[3]), [{ appKey: 'app-z', simulate: false }, { appKey: 'app-d', simulate: false }]);
  assert.equal(h.run.calls.length, 0, 'the CLI never ran, so no delete-app --confirm was ever sent');
  assert.equal(fs.existsSync(h.journal), false, 'the engine keeps its own receipts');
});

test('delete-app: an affected application must be named too; without host the one environment of the Studio is used, else it is asked', async t => {
  const sc = serviceCenterFakes({ affected: ['Demo'] });
  let hosts = [PERSONAL];
  const h = await harness(t, { extra: { serviceCenterDeps: sc.deps, studioHosts: async () => hosts } });
  const refused = await h.call('o11_environment', { action: 'delete-app', app: 'ZZScratch', authorize: 'apague o ZZScratch' });
  assert.deepEqual([refused.code, refused.host, refused.problems.map(p => [p.code, p.consumer])], ['DELETE_REFUSED', PERSONAL, [['CONSUMERS_WOULD_BREAK', 'Demo']]]);
  assert.match(refused.continuation.arguments.authorize, /ZZScratch, Demo/);
  hosts = ['a.example.test', 'b.example.test'];
  const ask = await h.call('o11_environment', { action: 'delete-app', app: 'ZZScratch', authorize: 'apague o ZZScratch e o Demo' });
  assert.deepEqual([ask.code, ask.signedInHosts], ['HOST_REQUIRED', hosts]);
  assert.deepEqual(sc.deletes(), []);
});

test('the journal keeps the sha256 of the words, reserved before the CLI and closed with the outcome, never the text', async t => {
  const h = await harness(t);
  await h.call('o11_environment', { action: 'update-app', name: 'Demo', color: '#112233', authorize: WORDS });
  const lines = journalLines(h.journal);
  const hash = createHash('sha256').update(WORDS, 'utf8').digest('hex');
  assert.deepEqual(lines.map(l => [l.phase, l.action, l.target, l.wordsSha256, l.operationId]), [
    ['reserved', 'update-app', 'Demo', hash, '00000000-0000-4000-8000-000000000001'],
    ['result', 'update-app', 'Demo', hash, '00000000-0000-4000-8000-000000000001']]);
  assert.equal(lines[1].outcome, 'ok');
  assert.doesNotMatch(fs.readFileSync(h.journal, 'utf8'), /Sim, pode|ZZScratch/);
  // Reads leave no journal line.
  await h.call('o11_environment', { action: 'templates' });
  assert.equal(journalLines(h.journal).length, 2);
});

test('ok comes from each verb\'s data, not from the envelope', async t => {
  const env = (command, data) => () => ({ ok: true, command, data });
  const h = await harness(t, { handlers: {
    'update-app': env('update-app', { key: 'app-1', ok: false, message: 'The color is invalid\nat ...', after: null }),
    'create-module': env('create-module', { ModuleName: 'Demo_UI2', ModuleKey: 'k', IsValid: true, Validation: {}, Publish: failedPublish }),
    'set-user-provider': env('set-user-provider', { ModuleName: 'Demo_CS', IsValid: false, Validation: { Total: 1, Sample: ['Error: Missing provider'] }, Publish: null }),
    'refresh-refs': env('refresh-refs', { ModuleName: 'Demo_CS', Before: [{ Name: 'Users', Stale: true, InCatalog: true }], RefreshApplied: true, After: [], Publish: failedPublish }),
    'create-app': () => ({ ok: false, command: 'create-app', data: { ApplicationName: 'Demo App', ApplicationKey: 'app-9', ApplicationOk: true,
      Modules: [{ Name: 'Demo_UI', Succeeded: false, IsValid: true, Error: 'Batch preparation failed', Publish: null }], Succeeded: false } }),
    download: env('download', { Name: 'Demo_CS', Status: 'failed: empty payload (versionId 0)' }),
  } });
  const cases = [
    [{ action: 'update-app', name: 'Demo', color: '#112233', authorize: WORDS }, 'UPDATE_APP_FAILED'],
    [{ action: 'create-module', app: 'Demo', name: 'Demo_UI2', authorize: WORDS }, 'CREATE_MODULE_FAILED'],
    [{ action: 'set-user-provider', module: 'Demo_CS', authorize: WORDS }, 'SET_USER_PROVIDER_FAILED'],
    [{ action: 'refresh-refs', module: 'Demo_CS', publish: true, authorize: WORDS }, 'REFRESH_PUBLISH_FAILED'],
    [{ action: 'create-app', name: 'Demo App', modules: [{ name: 'Demo_UI', kind: 'Reactive' }], authorize: WORDS }, 'CREATE_APP_FAILED'],
    [{ action: 'download', module: 'Demo_CS' }, 'DOWNLOAD_FAILED'],
  ];
  for (const [input, code] of cases) {
    const value = await h.call('o11_environment', input);
    assert.equal(value.ok, false, input.action); assert.equal(value.isError, true); assert.equal(value.code, code, input.action);
    assert.equal(value.continuation.tool, 'o11_environment'); assert.equal(value.continuation.arguments.action, 'inventory');
  }
  const updated = await h.call('o11_environment', { action: 'update-app', name: 'Demo', color: '#112233', authorize: WORDS });
  assert.equal(updated.error, 'The color is invalid', 'one line, no stack');
  assert.deepEqual((await h.call('o11_environment', { action: 'create-module', app: 'Demo', name: 'Demo_UI2', authorize: WORDS })).publishErrors, ['Compilation failed']);
  assert.ok(journalLines(h.journal).filter(l => l.phase === 'result').every(l => l.outcome === 'failed'));
});

test('fields that an action does not take are refused, top-level unknown fields by the schema', async t => {
  const h = await harness(t);
  const misplaced = await h.call('o11_environment', { action: 'download', module: 'Demo_CS', apps: ['Demo'] });
  assert.equal(misplaced.code, 'UNKNOWN_FIELD'); assert.match(misplaced.error, /download does not take: apps/);
  assert.deepEqual(misplaced.continuation.arguments, { action: 'download', module: 'Demo_CS' });
  const missing = await h.call('o11_environment', { action: 'download' });
  assert.equal(missing.code, 'MISSING_FIELD');
  const credential = await h.call('o11_environment', { action: 'inventory', credentials: 'C:\\creds.json' });
  assert.equal(credential.isError, true); assert.match(credential.sdkError ?? credential.error, /credentials|unrecognized/i);
  // A value that could act as a CLI flag (--publish, --confirm) never reaches the CLI.
  const flag = await h.call('o11_environment', { action: 'create-module', app: 'Demo', name: 'Demo_UI2', description: '--replace', authorize: WORDS });
  assert.equal(flag.code, 'BAD_VALUE');
  const nothing = await h.call('o11_environment', { action: 'update-app', name: 'Demo', authorize: WORDS });
  assert.equal(nothing.code, 'NOTHING_TO_CHANGE');
  const relative = await h.call('o11_environment', { action: 'references', oml: 'Demo_CS.oml' });
  assert.equal(relative.code, 'PATH_NOT_ABSOLUTE');
  const badKind = await h.call('o11_environment', { action: 'create-app', name: 'X', modules: [{ name: 'X_CS', kind: 'Server' }], authorize: WORDS });
  assert.equal(badKind.isError, true);
  assert.equal(h.run.calls.length, 0);
});

test('a write whose answer is lost is uncertain, runs once and points to an inventory read', async t => {
  const calls = [];
  const runAnvil = async (args, options) => { calls.push({ args, options }); return { ok: false, exitCode: 1, envelope: null, stderr: [], timedOut: true, wallMs: 1, line: '' }; };
  const h = await harness(t, { runAnvil });
  const value = await h.call('o11_environment', { action: 'create-app', name: 'Demo App', modules: [{ name: 'Demo_UI', kind: 'Reactive' }], host: 'h.example', authorize: WORDS });
  assert.equal(value.ok, false); assert.equal(value.outcome, 'uncertain'); assert.equal(value.code, 'UNCERTAIN');
  assert.deepEqual(value.continuation.arguments, { action: 'inventory', host: 'h.example' });
  assert.equal(calls.length, 1, 'never repeated');
  assert.equal(journalLines(h.journal).at(-1).outcome, 'uncertain');

  // A bridge transport error after the request is uncertain too; a plain refusal is a failure.
  const transport = await harness(t, { handlers: { 'update-app': () => ({ ok: false, command: 'update-app', error: 'IOException: application-save: bridge closed before replying; execution outcome may be unknown' }),
    'create-module': () => ({ ok: false, command: 'create-module', error: 'InvalidOperationException: the application Demo does not exist' }) } });
  assert.equal((await transport.call('o11_environment', { action: 'update-app', name: 'Demo', color: '#112233', authorize: WORDS })).outcome, 'uncertain');
  const refused = await transport.call('o11_environment', { action: 'create-module', app: 'Demo', name: 'Demo_UI2', authorize: WORDS });
  assert.equal(refused.code, 'CLI_REFUSED'); assert.equal(refused.outcome, 'failed');
  // A read that times out may simply be repeated.
  const reads = await harness(t, { runAnvil });
  const read = await reads.call('o11_environment', { action: 'templates' });
  assert.equal(read.code, 'TIMEOUT'); assert.deepEqual(read.continuation.arguments, { action: 'templates' });
});

test('without the CLI build or the selected Studio nothing runs, and the refusal names a tool, never a command', async t => {
  const unbuilt = await harness(t, { cli: false });
  const value = await unbuilt.call('o11_environment', { action: 'inventory' });
  assert.equal(value.code, 'CLI_NOT_BUILT');
  assert.deepEqual(value.continuation.tool, 'ssam_doctor'); assert.deepEqual(value.continuation.arguments, { lane: 'o11' });
  assert.equal(unbuilt.run.calls.length, 0);

  const gone = await harness(t, { assertSelected: async () => { throw new Error('The selected Studio session is no longer connected. Run ssam connect --lane o11 to select the current Studio.'); } });
  const refused = await gone.call('o11_environment', { action: 'update-app', name: 'Demo', color: '#112233', authorize: WORDS });
  assert.equal(refused.code, 'STUDIO_NOT_SELECTED'); assert.equal(refused.continuation.tool, 'ssam_doctor');
  assert.doesNotMatch(JSON.stringify(refused), /ssam connect|dotnet|python|\.ps1|odc\.cmd/);
  assert.equal(gone.run.calls.length, 0); assert.equal(fs.existsSync(gone.journal), false);
});

test('environmentArguments is a pure function of the input', () => {
  assert.deepEqual(environmentArguments({ action: 'templates', host: 'h' }), ['templates', '--host', 'h', '--read-only']);
  assert.deepEqual(environmentArguments({ action: 'download', module: 'M' }, { out: 'O' }), ['download', '--module', 'M', '--out', 'O', '--read-only']);
  assert.deepEqual(environmentArguments({ action: 'refresh-refs', module: 'M' }, { out: 'O' }), ['refresh-refs', '--module', 'M', '--out', 'O']);
  assert.deepEqual(environmentArguments({ action: 'create-module', app: 'A', name: 'N' }, { out: 'O' }), ['create-module', '--app', 'A', '--name', 'N', '--out', 'O']);
});
