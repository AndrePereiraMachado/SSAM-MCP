// studio_create_app (studio-create-app.mjs) over a fake bridge and a fake ODC kernel: the contract refusals, the order
// of the steps (session, template, model, words, upload, open, publish), the journal reserved before the upload and
// closed with the outcome, a lost upload answer is uncertain and never repeated, and the continuations are reads.
// No Studio, no tenant, no kernel process.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerStudioCreateApp, validateCreateAppInput, kernelArguments, namesWhole, APP_TEMPLATES } from '../studio-create-app.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { hashedWords } from '../destructive-operations.mjs';
import { tempKernel, linked } from './fixtures/o11env-kernel.mjs';

const WORDS = 'pode criar o app ZZ Criar Web e publicar';
const TENANT = 'personal-test.outsystems.dev';
const STAMP = '20261004T120000000Z';
const journalLines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);

// The bridge: one answer per command; `override` replaces one command's answer (a value, a function, or a throw).
function fakeBridge(override = {}) {
  const calls = [];
  const answers = {
    'auth-status': () => ({ ok: true, sessions: [{ host: TENANT, loggedIn: true, user: 'dev@example.com' }] }),
    templates: () => ({ ok: true, tenant: TENANT, templates: [{ key: APP_TEMPLATES.web.key, label: 'Web app', applicationKind: 'CrossDevice', asset: { name: 'Template Web App', revision: 21 } }] }),
    'template-download': args => ({ ok: true, key: args[1], name: 'Template Web App', revision: 21, sha256: 'AB'.repeat(32), path: 'C:\\odc\\snapshots\\templates\\web.oml' }),
    'create-app': () => ({ ok: true, created: true, module: 'ZZCriarWeb', moduleKey: 'KEY1', assetKey: 'KEY1', assetName: 'ZZ Criar Web', appName: 'ZZ Criar Web', assetType: 'WebApplication', revision: 1 }),
    open: () => ({ ok: true, opened: true, module: 'ZZCriarWeb', key: 'KEY1', developerId: 'dev-id-from-studio' }),
    publish: () => ({ ok: true, completed: true, state: 'CompletedWithSuccess', published: { revision: 1, matchesOpenModule: true } }),
    ...override,
  };
  async function studio(args, pid) {
    calls.push({ args: [...args], pid });
    const answer = answers[args[0]];
    if (!answer) throw new Error('unexpected bridge command ' + args[0]);
    return typeof answer === 'function' ? answer(args) : answer;
  }
  studio.calls = calls;
  return studio;
}

// The kernel: writes the manifest the bridge reads and answers like OdcAppFactory.
const kernel = (extra = {}) => fakeAnvil({
  'create-app': args => {
    const out = args[args.indexOf('--out') + 1];
    const kind = args[args.indexOf('--kind') + 1];
    fs.mkdirSync(out, { recursive: true });
    const manifest = path.join(out, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', module: 'ZZCriarWeb', moduleKey: 'KEY1', appName: 'ZZ Criar Web', kind, tenant: TENANT, author: 'dev@example.com', create: true }));
    return { ok: true, command: 'create-app', data: { ok: true, module: 'ZZCriarWeb', moduleKey: 'KEY1', manifest, settings: { appName: 'ZZ Criar Web' },
      content: { references: ['(System)', 'OutSystemsUI'], flows: ['MainFlow', 'Common', 'Layouts'], screens: 11 }, theme: { theme: 'ZZCriarWeb', colorApplied: true }, ...extra } };
  },
});

async function harness(t, { bridge = fakeBridge(), runAnvil = kernel(), cli = true, tenants } = {}) {
  const k = tempKernel({ cli });
  const deps = { root: k.root, env: k.env, studio: bridge, runAnvil, now: () => new Date('2026-10-04T12:00:00.000Z'),
    uuid: () => '00000000-0000-4000-8000-000000000001', tenants: tenants ?? (async () => ({ tenants: { [TENANT]: { class: 'personal' } } })),
    appUrl: async ({ app, host }) => ({ appUrl: `https://${host}/${app}` }), templateCache: path.join(k.root, 'templates') };
  const mcp = await linked(registerStudioCreateApp, deps);
  t.after(async () => { await mcp.close(); k.cleanup(); });
  const local = path.join(k.root, '.local', 'lane-odc');
  return { ...mcp, bridge, runAnvil, root: k.root, local, journal: path.join(local, 'journal', 'studio_create_app.jsonl'), evidence: path.join(local, 'create-app', STAMP) };
}

test('the tool is listed with its actions and kinds, and no credential field', async t => {
  const h = await harness(t);
  const tool = (await h.client.listTools()).tools.find(x => x.name === 'studio_create_app');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['templates', 'create']);
  assert.deepEqual(tool.inputSchema.properties.kind.enum, ['reactive', 'mobile', 'library', 'mobile-library', 'agentic']);
  for (const key of Object.keys(tool.inputSchema.properties)) assert.doesNotMatch(key, /credential|password|secret|token/i);
  assert.equal(tool.annotations.readOnlyHint, false);
});

test('the contract refuses before anything is read or written', async t => {
  const h = await harness(t);
  const refused = async (args, code) => { const v = await h.call('studio_create_app', args); assert.equal(v.ok, false, JSON.stringify(v)); assert.equal(v.code, code, JSON.stringify(v)); return v; };
  const words = await refused({ kind: 'reactive', name: 'ZZ Criar Web' }, 'WORDS_REQUIRED');
  assert.equal(words.continuation.tool, 'studio_create_app');
  assert.match(words.continuation.why, /ask the user/);
  await refused({ kind: 'reactive', name: 'ZZ Criar Web', authorize: 'pode criar o app' }, 'WORDS_MUST_NAME_APP');
  await refused({ kind: 'reactive', name: 'ZZ Criar Web', authorize: 'pode criar o app ZZ Criar Web2' }, 'WORDS_MUST_NAME_APP');
  await refused({ kind: 'library', name: 'ZZLib', template: 'web', authorize: 'criar ZZLib' }, 'NO_TEMPLATE');
  await refused({ kind: 'library', name: 'ZZLib', templateKey: 'k', authorize: 'criar ZZLib' }, 'NO_TEMPLATE');
  await refused({ kind: 'mobile', name: 'ZZMob', template: 'web', authorize: 'criar ZZMob' }, 'BAD_VALUE');
  await refused({ kind: 'reactive', name: 'ZZWeb', template: 'web', templateKey: 'k', authorize: 'criar ZZWeb' }, 'BAD_VALUE');
  await refused({ kind: 'reactive', name: '123', authorize: 'criar 123' }, 'BAD_VALUE');
  await refused({ kind: 'reactive', name: 'ZZWeb', icon: 'relative.png', authorize: 'criar ZZWeb' }, 'BAD_VALUE');
  await refused({ action: 'templates', authorize: 'x' }, 'UNKNOWN_FIELD');
  await refused({ action: 'templates', kind: 'library' }, 'NO_TEMPLATE');
  await refused({ kind: 'reactive', authorize: 'x' }, 'MISSING_FIELD');
  // the SDK refuses what the schema does not allow (WebResponsive, unknown fields)
  const traditional = await h.call('studio_create_app', { kind: 'traditional', name: 'ZZWeb', authorize: 'criar ZZWeb' });
  assert.equal(traditional.isError, true);
  assert.deepEqual(h.bridge.calls, [], 'nothing reached the bridge');
  assert.deepEqual(h.runAnvil.calls, [], 'nothing reached the kernel');
  assert.equal(fs.existsSync(h.journal), false);
});

test('create: session, template, model, words, upload, open, publish, in that order, journaled', async t => {
  const h = await harness(t);
  const v = await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', color: '#C0392B', publish: true, authorize: WORDS });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(h.bridge.calls.map(c => c.args[0]), ['auth-status', 'template-download', 'create-app', 'open', 'publish']);
  assert.deepEqual(h.bridge.calls[1].args, ['template-download', APP_TEMPLATES.web.key, '--tenant', TENANT]);
  assert.deepEqual(h.runAnvil.calls[0].args, ['create-app', '--kind', 'reactive', '--name', 'ZZ Criar Web', '--out', h.evidence, '--module', 'ZZCriarWeb',
    '--template-oml', 'C:\\odc\\snapshots\\templates\\web.oml', '--template-key', APP_TEMPLATES.web.key, '--color', '#C0392B', '--tenant', TENANT, '--author', 'dev@example.com']);
  assert.match(h.runAnvil.calls[0].options.cli, /anvil-odc\.dll$/);
  const manifest = path.join(h.evidence, 'manifest.json');
  assert.deepEqual(h.bridge.calls[2].args, ['create-app', manifest]);
  assert.deepEqual(h.bridge.calls[3].args, ['open', 'KEY1']);
  assert.deepEqual(h.bridge.calls[4].args, ['publish', manifest, '--wait', '15']);
  // one authorization, recorded for creating and publishing; the author is the open module's developer
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  // CX15 r5 (N-2, converted): the manifest keeps sha256:<hex> of the words, never the words (before: the words).
  assert.match(m.createAuthorization, new RegExp('^' + hashedWords('pode criar o app ZZ Criar Web e publicar') + ' \\[recorded '));
  assert.equal(m.createAuthorization.includes('pode criar'), false);
  assert.equal(m.publishAuthorization, m.createAuthorization);
  assert.equal(m.author, 'dev-id-from-studio');
  assert.equal(v.app, 'ZZ Criar Web'); assert.equal(v.module, 'ZZCriarWeb'); assert.equal(v.published, true);
  assert.equal(v.asset.revision, 1); assert.equal(v.template.name, 'Template Web App');
  assert.deepEqual(v.appLinks, { appUrl: `https://${TENANT}/ZZCriarWeb` });
  assert.equal(v.next.tool, 'ssam_map');
  // the journal keeps only the sha256 of the words, reserved before the upload and closed with the outcome
  const lines = journalLines(h.journal);
  assert.deepEqual(lines.map(l => l.phase), ['reserved', 'result']);
  assert.equal(lines[0].wordsSha256, createHash('sha256').update(WORDS, 'utf8').digest('hex'));
  assert.equal(lines[1].outcome, 'ok');
  assert.doesNotMatch(fs.readFileSync(h.journal, 'utf8'), /pode criar/);
  const receipt = JSON.parse(fs.readFileSync(path.join(h.evidence, 'studio_create_app-receipt.json'), 'utf8'));
  assert.equal(receipt.ok, true);
});

test('a library has no template; publish:false stops after opening and never offers a write as next', async t => {
  const h = await harness(t);
  const v = await h.call('studio_create_app', { kind: 'library', name: 'ZZCriarLib', publish: false, authorize: 'pode criar a ZZCriarLib' });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.deepEqual(h.bridge.calls.map(c => c.args[0]), ['auth-status', 'create-app', 'open']);
  assert.ok(!h.runAnvil.calls[0].args.includes('--template-oml'));
  assert.equal(v.published, false);
  assert.equal(v.next, undefined);
  assert.deepEqual(v.toPublish.map(s => s.tool), ['studio_authorize', 'studio_publish']);
  const m = JSON.parse(fs.readFileSync(v.manifest, 'utf8'));
  assert.ok(m.createAuthorization); assert.equal(m.publishAuthorization, undefined);
  assert.equal(v.appLinks, undefined);
});

test('a lost upload answer is uncertain, never repeated, and continues with a read', async t => {
  for (const lost of [() => ({ ok: false, outcome: 'uncertain', gate: 'studio_busy', error: 'still running' }), () => { throw new Error('pipe broken after write'); }]) {
    const h = await harness(t, { bridge: fakeBridge({ 'create-app': lost }) });
    const v = await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', authorize: WORDS });
    assert.equal(v.ok, false); assert.equal(v.code, 'UNCERTAIN'); assert.equal(v.outcome, 'uncertain');
    assert.deepEqual(v.continuation, { tool: 'studio_assets', arguments: { tenant: TENANT }, why: 'list the tenant to see whether ZZ Criar Web exists; never repeat before that' });
    assert.equal(h.bridge.calls.filter(c => c.args[0] === 'create-app').length, 1);
    assert.ok(!h.bridge.calls.some(c => c.args[0] === 'open'));
    assert.deepEqual(journalLines(h.journal).map(l => [l.phase, l.outcome]), [['reserved', undefined], ['result', 'uncertain']]);
  }
});

test('refusals at each step say what happened and continue with a read', async t => {
  // the bridge refuses the upload (name taken): failed, read the tenant
  let h = await harness(t, { bridge: fakeBridge({ 'create-app': () => ({ ok: false, outcome: 'gate_refused', error: 'An app named ZZ Criar Web already exists' }) }) });
  let v = await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', authorize: WORDS });
  assert.equal(v.code, 'CREATE_REFUSED'); assert.equal(v.outcome, 'failed'); assert.equal(v.continuation.tool, 'studio_assets');
  // the kernel refuses the model: nothing reached the tenant, no journal line; the failing step is named (the template
  // was downloaded) and a deterministic refusal is never sent back to doctor-and-repeat
  h = await harness(t, { runAnvil: fakeAnvil({ 'create-app': () => ({ ok: false, command: 'create-app', error: 'InvalidOperationException: 2 validation errors' }) }) });
  v = await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', authorize: WORDS });
  assert.equal(v.code, 'MODEL_REFUSED'); assert.match(v.error, /validation errors/);
  assert.match(v.error, /template was downloaded/);
  assert.equal(v.failedStep, 'model'); assert.deepEqual(v.steps, ['template-download']); assert.equal(v.repeat, false);
  assert.notEqual(v.continuation.tool, 'ssam_doctor'); assert.match(v.continuation.why, /do not repeat/);
  assert.ok(!h.bridge.calls.some(c => c.args[0] === 'create-app'));
  assert.equal(fs.existsSync(h.journal), false);
  // the kernel gave no answer at all (crash, timeout): that one may be the lane, so doctor, then repeat
  h = await harness(t, { runAnvil: fakeAnvil({ 'create-app': () => ({ exitCode: 1, envelope: null, stderr: ['Unhandled exception'] }) }) });
  v = await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', authorize: WORDS });
  assert.equal(v.code, 'MODEL_REFUSED'); assert.equal(v.failedStep, 'model'); assert.equal(v.continuation.tool, 'ssam_doctor'); assert.equal(v.repeat, undefined);
  // created but not opened: the next call is studio_open of the new module
  h = await harness(t, { bridge: fakeBridge({ open: () => ({ ok: false, error: 'Document opening is unconfirmed after 180 s' }) }) });
  v = await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', authorize: WORDS });
  assert.equal(v.code, 'OPEN_FAILED'); assert.equal(v.created, true); assert.deepEqual(v.continuation.arguments, { module: 'KEY1' });
  // a publish whose answer was lost: uncertain, read the publication state
  h = await harness(t, { bridge: fakeBridge({ publish: () => ({ ok: false, outcome: 'uncertain', error: 'still running' }) }) });
  v = await h.call('studio_create_app', { kind: 'reactive', name: 'ZZ Criar Web', publish: true, authorize: WORDS });
  assert.equal(v.code, 'PUBLISH_UNCERTAIN'); assert.equal(v.continuation.tool, 'studio_command'); assert.equal(v.continuation.arguments.command, 'publish-status');
  // the template download fails: nothing created
  h = await harness(t, { bridge: fakeBridge({ 'template-download': () => ({ ok: false, error: 'no asset' }) }) });
  v = await h.call('studio_create_app', { kind: 'mobile', name: 'ZZMob', template: 'outsystems-ui', authorize: 'criar ZZMob' });
  assert.equal(v.code, 'TEMPLATE_DOWNLOAD_FAILED'); assert.equal(h.bridge.calls[1].args[1], APP_TEMPLATES['outsystems-ui'].key);
  assert.equal(h.runAnvil.calls.length, 0);
});

test('model plugins: the Studio cache reaches the kernel; a missing plugin is refused before or by the model step, never repeated', async t => {
  const PLUGINS = 'C:\\Users\\dev\\AppData\\Local\\OutSystems\\ODC Studio\\Plugins';
  const mobileDownload = plugin => args => ({ ok: true, key: args[1], name: 'Template_MobileApp', revision: 1, sha256: 'CD'.repeat(32), path: 'C:\\odc\\snapshots\\templates\\mobile.oml',
    pluginsDirectory: PLUGINS, modelPlugins: [{ name: 'MobileUI', version: '1.5.0.0', file: PLUGINS + '\\MobileUI-1.5.0.0.xif', ...plugin }] });
  // cached (here fetched by the bridge): the kernel reads the Studio's own cache folder, the answer shows the plugin
  let h = await harness(t, { bridge: fakeBridge({ 'template-download': mobileDownload({ cached: true, fetched: true, error: null }) }) });
  let v = await h.call('studio_create_app', { kind: 'mobile', name: 'ZZ Criar Mobile', authorize: 'pode criar o ZZ Criar Mobile' });
  assert.equal(v.ok, true, JSON.stringify(v));
  const argv = h.runAnvil.calls[0].args;
  assert.equal(argv[argv.indexOf('--plugins-dir') + 1], PLUGINS);
  assert.deepEqual(v.template.modelPlugins, [{ name: 'MobileUI', version: '1.5.0.0', cached: true, fetched: true }]);
  // the bridge could not fetch it: refused before the kernel, with the plugin, the folder and the Studio's error
  h = await harness(t, { bridge: fakeBridge({ 'template-download': mobileDownload({ cached: false, fetched: false, error: 'NotLoggedInException: not logged in' }) }) });
  v = await h.call('studio_create_app', { kind: 'mobile', name: 'ZZ Criar Mobile', authorize: 'pode criar o ZZ Criar Mobile' });
  assert.equal(v.code, 'MODEL_PLUGIN_MISSING', JSON.stringify(v));
  assert.match(v.error, /MobileUI 1\.5\.0\.0/); assert.ok(v.error.includes(PLUGINS)); assert.match(v.error, /not logged in/);
  assert.equal(v.failedStep, 'model-plugins'); assert.equal(v.pluginsDirectory, PLUGINS);
  assert.equal(v.continuation.tool, 'studio_assets'); assert.match(v.continuation.why, /Mobile UI app/);
  assert.equal(h.runAnvil.calls.length, 0, 'the kernel never ran');
  assert.ok(!h.bridge.calls.some(c => c.args[0] === 'create-app'));
  // an older bridge names no plugin: the kernel refuses with its own type, mapped to the same code
  h = await harness(t, { runAnvil: fakeAnvil({ 'create-app': () => ({ ok: false, command: 'create-app',
    error: 'OdcModelPluginMissingException: the template requires model plugins that could not be loaded from the ODC Studio\'s plugin cache (C:\\p): MobileUI 1.5.0.0 (Unable to locate plugin binaries). The ODC Studio downloads...' }) }) });
  v = await h.call('studio_create_app', { kind: 'mobile', name: 'ZZ Criar Mobile', authorize: 'pode criar o ZZ Criar Mobile' });
  assert.equal(v.code, 'MODEL_PLUGIN_MISSING'); assert.equal(v.failedStep, 'model'); assert.match(v.error, /MobileUI 1\.5\.0\.0/);
  assert.ok(!h.runAnvil.calls[0].args.includes('--plugins-dir'));
  assert.equal(v.continuation.tool, 'studio_assets');
  assert.equal(fs.existsSync(h.journal), false);
});

test('the tenant is a signed-in session; a corporate one must be named in the call and in the words', async t => {
  let h = await harness(t, { bridge: fakeBridge({ 'auth-status': () => ({ ok: true, sessions: [{ host: 'a.test', loggedIn: true }, { host: 'b.test', loggedIn: true }] }) }) });
  let v = await h.call('studio_create_app', { kind: 'library', name: 'ZZLib', authorize: 'criar ZZLib' });
  assert.equal(v.code, 'TENANT_AMBIGUOUS');
  const corporate = async () => ({ tenants: { [TENANT]: { class: 'corporate' } } });
  h = await harness(t, { tenants: corporate });
  v = await h.call('studio_create_app', { kind: 'library', name: 'ZZLib', authorize: 'criar ZZLib' });
  assert.equal(v.code, 'CORPORATE_TENANT');
  h = await harness(t, { tenants: corporate });
  v = await h.call('studio_create_app', { kind: 'library', name: 'ZZLib', tenant: TENANT, authorize: `criar ZZLib em ${TENANT}` });
  assert.equal(v.ok, true, JSON.stringify(v));
  h = await harness(t, { cli: false });
  v = await h.call('studio_create_app', { kind: 'library', name: 'ZZLib', authorize: 'criar ZZLib' });
  assert.equal(v.code, 'CLI_NOT_BUILT');
});

test('templates is a read through the bridge', async t => {
  const h = await harness(t);
  const v = await h.call('studio_create_app', { action: 'templates', kind: 'reactive' });
  assert.equal(v.ok, true);
  assert.deepEqual(h.bridge.calls[0].args, ['templates', '--kind', 'reactive']);
  assert.deepEqual(v.templates, [{ key: APP_TEMPLATES.web.key, label: 'Web app', kind: 'CrossDevice', asset: 'Template Web App', revision: 21, template: 'web' }]);
  assert.equal(fs.existsSync(h.journal), false);
});

test('pure helpers: words name the app as whole words, kernel argv in a fixed order', () => {
  assert.equal(namesWhole('pode criar o ZZ  Criar   Web', 'ZZ Criar Web'), true);
  assert.equal(namesWhole('pode criar o ZZ Criar Web2', 'ZZ Criar Web'), false);
  assert.equal(validateCreateAppInput({ kind: 'library', name: 'ZZLib', authorize: 'criar a zzlib' }), null);
  assert.deepEqual(kernelArguments({ kind: 'library', name: 'ZZLib' }, { out: 'C:\\o', tenant: 't', author: 'a' }),
    ['create-app', '--kind', 'library', '--name', 'ZZLib', '--out', 'C:\\o', '--tenant', 't', '--author', 'a']);
});

 test('agentic app uses the native agent template and does not invent a browser URL', async t => {
 const h = await harness(t);
 const v = await h.call('studio_create_app', {kind:'agentic', name:'ZZ Criar Web', authorize:WORDS});
 assert.equal(v.ok,true,JSON.stringify(v));
 assert.equal(v.kind,'agentic');
 assert.equal(v.published,false); // C25 (mb): publish only when asked
 assert.equal(v.appLinks,undefined);
 assert.deepEqual(h.bridge.calls[1].args,['template-download',APP_TEMPLATES.agent.key,'--tenant',TENANT]);
 assert.equal(h.runAnvil.calls[0].args[2],'agentic');
 assert.equal(validateCreateAppInput({kind:'reactive',name:'Test',template:'agent',authorize:'criar Test'}).code,'BAD_VALUE');
 });
