import './fixtures/isolated-profile.mjs';
// ssam_preview prepares the profile itself when the target has none and a qualified input names it (proto dd4264de and
// d5394178, relato 84a4a6a3 of 23/10: profiles:[] and installationRequired:true, no visual comparison for a migration). A
// simulated engine (engines/o11/host.mjs answering "fixture" on loopback) stands for the installed one; nothing outside the
// temporary folders is touched. r4-w3-preview: what the preparation reads is confined to the workspace (malicious paths
// below), and a hosted call never prepares.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createPreviewManager } from '../preview/manager.mjs';
import { atomicJson, digest, readJson } from '../preview/profile.mjs';

const INPUT_SCHEMA = 'ssam-preview-input/1';
const delay = ms => new Promise(r => setTimeout(r, ms));
const pin = file => ({ file, sha256: digest(fs.readFileSync(file)) });
const SETTLE_MS = 60000;
const SCRIPT = path.join(import.meta.dirname, '..', 'preview', 'prepare.mjs');
const HOST = `import http from 'node:http';export async function startLiveHost(c){const s=http.createServer((q,r)=>r.end('fixture'));await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r)});return{url:'http://127.0.0.1:'+s.address().port+'/',manager:{state:{promoted:{buildId:'fixture'},rendered:null}},poll(){},close:()=>new Promise(r=>s.close(r))}}`;

function world(t, { engine = true, env = {} } = {}) {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-preview-auto-')));
  const engines = path.join(workspace, 'engines');
  fs.mkdirSync(path.join(engines, 'o11'), { recursive: true });
  if (engine) fs.writeFileSync(path.join(engines, 'o11', 'host.mjs'), HOST);
  const qualified = path.join(workspace, 'qualified');
  fs.mkdirSync(qualified);
  const host = path.join(qualified, 'host.json');
  atomicJson(host, { startAllowed: true, bindHost: '127.0.0.1', port: 1, target: { moduleKey: 'loan-module', screenKey: 'loan-home' } });
  const input = { schema: INPUT_SCHEMA, id: 'loan-portal', lane: 'o11', target: { app: 'EquipmentLoanPortal', moduleKey: 'loan-module', tenant: 'personal' },
    screens: [{ name: 'Home', key: 'loan-home' }], limitations: ['Simulated engine only'], hostConfig: pin(host), port: 34567 };
  const inputs = path.join(workspace, '.local', 'preview', 'inputs');
  const write = (value, name = 'loan-portal.json') => atomicJson(path.join(inputs, name), value);
  const children = [];
  const manager = createPreviewManager({ workspace, engines, env: { ...process.env, ...env }, spawnProcess(...args) { const c = spawn(...args); children.push(c); return c; } });
  t.after(async () => {
    await manager({ action: 'stop', sessionId: 'loan-portal' });
    for (const c of children) { const end = Date.now() + SETTLE_MS; while (c.exitCode === null && Date.now() < end) await delay(50); }
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const profiles = path.join(workspace, '.local', 'preview', 'profiles');
  return { workspace, engines, host, input, inputs, write, manager, profiles, catalog: path.join(workspace, '.local', 'preview', 'catalog.json'),
    prepared: () => (fs.existsSync(profiles) ? fs.readdirSync(profiles) : []) };
}
// Another account's or the server's folder, outside the workspace: its file must never be read.
function elsewhere(t) {
  const folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-preview-other-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const host = path.join(folder, 'host.json');
  atomicJson(host, { startAllowed: true, bindHost: '127.0.0.1', port: 1, target: { moduleKey: 'loan-module', screenKey: 'loan-home' } });
  const listing = () => fs.readdirSync(folder).sort();
  return { folder, host, listing };
}

async function settled(manager) {
  const end = Date.now() + SETTLE_MS; let s;
  while (Date.now() < end) { s = await manager({ action: 'status', sessionId: 'loan-portal' }); if (!['starting', 'unreachable'].includes(s.status)) return s; await delay(50); }
  assert.fail('the preview did not settle: ' + JSON.stringify(s));
}

test('a missing profile is prepared from the qualified input, registered once, and opens', async t => {
  const w = world(t);
  w.write(w.input);
  const listed = await w.manager({ action: 'list', lane: 'o11', app: 'EquipmentLoanPortal' });
  assert.equal(listed.code, 'PREVIEW_PROFILE_PREPARED', JSON.stringify(listed));
  assert.equal(listed.prepared.profile, 'loan-portal');
  assert.equal(listed.profiles.length, 1);
  assert.ok(listed.prepared.directory.startsWith(w.profiles + path.sep));
  assert.equal(readJson(w.catalog).profiles.length, 1);
  assert.deepEqual(w.prepared(), [path.basename(listed.prepared.directory)], 'one folder, no lock left');
  // the pins name the simulated engine and a fresh, private host configuration
  const profile = readJson(listed.prepared.pin.file);
  assert.equal(profile.host.module.file, path.join(w.engines, 'o11', 'host.mjs'));
  assert.equal(readJson(profile.host.config.file).port, 34567);
  // prepared once: the next call finds the profile and prepares nothing
  const again = await w.manager({ action: 'list', lane: 'o11', app: 'EquipmentLoanPortal' });
  assert.equal(again.code, undefined);
  assert.equal(readJson(w.catalog).profiles.length, 1);
  let opened = await w.manager({ action: 'open', profile: 'loan-portal', screen: 'Home' });
  if (opened.status === 'starting') { await settled(w.manager); opened = await w.manager({ action: 'open', profile: 'loan-portal', screen: 'Home' }); }
  assert.equal(opened.status, 'running', JSON.stringify(opened));
  assert.equal(await (await fetch(opened.url)).text(), 'fixture');
});

test('open prepares too, when the first call for the target is open', async t => {
  const w = world(t);
  w.write(w.input);
  let opened = await w.manager({ action: 'open', app: 'EquipmentLoanPortal' });
  assert.equal(opened.code, 'PREVIEW_PROFILE_PREPARED', JSON.stringify(opened));
  if (opened.status === 'starting') opened = await settled(w.manager);
  assert.equal(opened.status, 'running', JSON.stringify(opened));
});

test('an open refused after the preparation keeps its own code, beside what was prepared', async t => {
  const w = world(t);
  w.write(w.input);
  const refused = await w.manager({ action: 'open', app: 'EquipmentLoanPortal', screen: 'NotAScreen' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'PREVIEW_SCREEN_NOT_PREPARED', JSON.stringify(refused));
  assert.equal(refused.prepared.profile, 'loan-portal');
  assert.equal(readJson(w.catalog).profiles.length, 1);
});

test('without an input, with a changed pin or without the engine: PREVIEW_PROFILE_NOT_PREPARED with the exact input path and command', async t => {
  const none = world(t);
  const refused = await none.manager({ action: 'open', lane: 'o11', app: 'EquipmentLoanPortal' });
  assert.equal(refused.code, 'PREVIEW_PROFILE_NOT_PREPARED');
  assert.equal(refused.prepare.by, 'integrator');
  assert.equal(refused.prepare.input, path.join(none.inputs, 'o11-equipmentloanportal.json'));
  assert.match(refused.prepare.command, /^node platforms\/odc\/facade\/preview\/prepare\.mjs --input /);
  assert.equal(refused.prepare.schema.schema, INPUT_SCHEMA);
  assert.match(refused.error, /writes the input .*o11-equipmentloanportal\.json/);
  const listed = await none.manager({ action: 'list', lane: 'o11', app: 'EquipmentLoanPortal' });
  assert.deepEqual(listed.profiles, []);
  assert.equal(listed.prepare.meanwhile.tool, 'ssam_app_url');

  const changed = world(t);
  changed.write(changed.input);
  atomicJson(changed.host, { startAllowed: true, bindHost: '127.0.0.1', port: 2, target: { moduleKey: 'loan-module', screenKey: 'loan-home' } });
  const pinChanged = await changed.manager({ action: 'list', app: 'EquipmentLoanPortal' });
  assert.equal(pinChanged.code, undefined);
  assert.match(pinChanged.prepare.reasons[0].why, /hostConfig: PREVIEW_PIN_CHANGED/);
  assert.equal(fs.existsSync(changed.catalog), false, 'nothing registered');

  const noEngine = world(t, { engine: false });
  noEngine.write(noEngine.input);
  const missing = await noEngine.manager({ action: 'open', app: 'EquipmentLoanPortal' });
  assert.equal(missing.code, 'PREVIEW_PROFILE_NOT_PREPARED');
  assert.match(missing.prepare.reasons[0].why, /the o11 engine is not installed/);
});

test('the integrator command named by the refusal prepares and registers the input; a registered id is refused before any folder', async t => {
  const w = world(t);
  // an input never chooses the engines folder: the command pins the installed engines whatever the input says
  w.write({ ...w.input, engines: path.join(w.workspace, 'not-the-engines') });
  const catalog = path.join(w.workspace, 'integrator-catalog.json');
  const run = () => { try { return JSON.parse(execFileSync(process.execPath, [SCRIPT, '--input', path.join(w.inputs, 'loan-portal.json'), '--catalog', catalog], { encoding: 'utf8' })); } catch (error) { return JSON.parse(error.stdout); } };
  const out = run();
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.code, 'PREVIEW_PROFILE_PREPARED');
  assert.equal(readJson(catalog).profiles.length, 1);
  assert.equal(readJson(out.profile.file).host.module.file, path.join(import.meta.dirname, '..', 'preview', 'engines', 'o11', 'host.mjs'));
  const folders = fs.readdirSync(path.join(w.workspace, 'profiles'));
  // the same input again is refused by the catalog (one profile per id) BEFORE preparing: no second folder (proto d5394178)
  const failed = run();
  assert.equal(failed.code, 'PREVIEW_DUPLICATE_PROFILE');
  assert.deepEqual(fs.readdirSync(path.join(w.workspace, 'profiles')), folders);
});

test('two preparations in the same second take two fresh folders (proto d5394178)', async t => {
  const { freshFolder } = await import('../preview/prepare.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-preview-fresh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const at = new Date('2026-10-25T19:16:59.123Z');
  const first = freshFolder(root, 'loan-portal', at);
  assert.equal(path.basename(first), 'loan-portal-20261025-191659');
  fs.mkdirSync(first);
  const second = freshFolder(root, 'loan-portal', at);
  assert.equal(path.basename(second), 'loan-portal-20261025-191659-2');
  fs.mkdirSync(second);
  assert.equal(path.basename(freshFolder(root, 'loan-portal', at)), 'loan-portal-20261025-191659-3');
  assert.throws(() => freshFolder(root, '../escape', at), { code: 'PREVIEW_PROFILE_SCHEMA' });
});

// The automatic preparation is an app session's call: everything it reads stays inside the workspace. Each malicious input
// names a file of another folder (another account, the server) with a WRONG sha256: had it been read, the reason would be
// PREVIEW_PIN_CHANGED; confined, it is PATH_OUTSIDE_WORKSPACE, nothing is registered and nothing is written anywhere.
test('malicious paths in the input are refused PATH_OUTSIDE_WORKSPACE before any read, and nothing is written', async t => {
  const other = elsewhere(t);
  const before = other.listing();
  const wrong = file => ({ file, sha256: 'f'.repeat(64) });
  const cases = [];
  const w = world(t);
  const junction = path.join(w.workspace, 'qualified', 'out');
  fs.symlinkSync(other.folder, junction, 'junction');
  cases.push(['an absolute path of another folder', { hostConfig: wrong(other.host) }]);
  cases.push(['a .. traversal that leaves the workspace', { hostConfig: wrong(path.join(w.workspace, 'qualified') + path.sep + '..' + path.sep + '..' + path.sep + path.basename(other.folder) + path.sep + 'host.json') }]);
  cases.push(['a UNC path', { hostConfig: wrong('\\\\127.0.0.1\\c$\\Windows\\win.ini') }]);
  cases.push(['a device path', { hostConfig: wrong('\\\\?\\' + other.host) }]);
  cases.push(['a junction inside the workspace that leads out', { hostConfig: wrong(path.join(junction, 'host.json')) }]);
  cases.push(['a relative path', { hostConfig: wrong('..\\..\\host.json') }]);
  for (const [why, change] of cases) {
    fs.rmSync(w.inputs, { recursive: true, force: true });
    w.write({ ...w.input, ...change });
    const listed = await w.manager({ action: 'list', app: 'EquipmentLoanPortal' });
    assert.equal(listed.code, undefined, why);
    assert.ok(listed.prepare.reasons.some(r => /^PATH_OUTSIDE_WORKSPACE: hostConfig\/file /.test(r.why)), why + ': ' + JSON.stringify(listed.prepare.reasons));
    assert.ok(!listed.prepare.reasons.some(r => /PIN_CHANGED|ENOENT/.test(r.why)), why + ': the file was never read');
    const opened = await w.manager({ action: 'open', app: 'EquipmentLoanPortal' });
    assert.equal(opened.code, 'PREVIEW_PROFILE_NOT_PREPARED', why);
  }
  // the host's selection file is confined the same way (an input with watcherConfig is never prepared here: test below)
  const selecting = path.join(w.workspace, 'qualified', 'selecting.json');
  atomicJson(selecting, { startAllowed: true, bindHost: '127.0.0.1', port: 1, selectionFile: other.host, target: { moduleKey: 'loan-module', screenKey: 'loan-home' } });
  fs.rmSync(w.inputs, { recursive: true, force: true });
  w.write({ ...w.input, hostConfig: pin(selecting) });
  assert.ok((await w.manager({ action: 'list' })).prepare.reasons.some(r => /^PATH_OUTSIDE_WORKSPACE: hostConfig>\/selectionFile /.test(r.why)));
  // an id that would build a folder outside profiles/
  for (const id of ['../../escape', '..\\escape', 'C:\\escape', 'UPPER']) {
    fs.rmSync(w.inputs, { recursive: true, force: true });
    w.write({ ...w.input, id });
    const listed = await w.manager({ action: 'list' });
    assert.ok(listed.prepare.reasons.some(r => /^PREVIEW_PROFILE_SCHEMA/.test(r.why)), id + ': ' + JSON.stringify(listed.prepare));
  }
  assert.equal(fs.existsSync(w.catalog), false, 'nothing registered');
  assert.deepEqual(w.prepared(), [], 'no profile folder');
  assert.deepEqual(other.listing(), before, 'nothing written in the other folder');
  assert.ok(!fs.existsSync(path.join(w.workspace, 'escape')) && !fs.existsSync(path.join(path.dirname(w.workspace), 'escape')));
});

test('an input file or an inputs folder outside the workspace is never read', async t => {
  const other = elsewhere(t);
  // the inputs folder named by SSAM_PREVIEW_INPUTS outside the workspace
  const valid = { schema: INPUT_SCHEMA, id: 'loan-portal', lane: 'o11', target: { app: 'EquipmentLoanPortal', moduleKey: 'loan-module', tenant: 'personal' },
    screens: [{ name: 'Home', key: 'loan-home' }], limitations: ['x'], hostConfig: pin(other.host), port: 34567 };
  atomicJson(path.join(other.folder, 'inputs', 'loan-portal.json'), valid);
  const moved = world(t, { env: { SSAM_PREVIEW_INPUTS: path.join(other.folder, 'inputs') } });
  const listed = await moved.manager({ action: 'list' });
  assert.match(listed.prepare.reasons[0].why, /^PATH_OUTSIDE_WORKSPACE: the inputs folder/);
  assert.equal(fs.existsSync(moved.catalog), false);
  // an input file in the folder that is a link to a file outside
  const w = world(t);
  fs.mkdirSync(w.inputs, { recursive: true });
  let linked = true;
  try { fs.symlinkSync(path.join(other.folder, 'inputs', 'loan-portal.json'), path.join(w.inputs, 'loan-portal.json'), 'file'); } catch { linked = false; }
  if (linked) {
    const viaLink = await w.manager({ action: 'list' });
    assert.match(viaLink.prepare.reasons[0].why, /^PATH_OUTSIDE_WORKSPACE: the input/);
    assert.equal(fs.existsSync(w.catalog), false);
  } else {
    // (a file symbolic link needs a Windows privilege; the folder rule above and the junction case cover the real path check)
    t.diagnostic('file symbolic links are not allowed on this machine; the link case was not exercised');
  }
});

test('one preparation at a time: a held lock is a reason, nothing is registered', async t => {
  const w = world(t);
  w.write(w.input);
  fs.mkdirSync(w.profiles, { recursive: true });
  fs.writeFileSync(path.join(w.profiles, 'prepare.lock'), '');
  const listed = await w.manager({ action: 'list' });
  assert.match(listed.prepare.reasons[0].why, /^PREVIEW_PREPARE_BUSY/);
  assert.equal(fs.existsSync(w.catalog), false);
  fs.rmSync(path.join(w.profiles, 'prepare.lock'));
  assert.equal((await w.manager({ action: 'list' })).code, 'PREVIEW_PROFILE_PREPARED');
});

// Hosted multi-user: the gate answers ssam_preview HOSTED_UNAVAILABLE before its handler (hosted/tools.json class
// unavailable), whatever the arguments; and the preparation itself, reached inside a hosted context, reads no input and
// writes nothing (the second wall), so no profile of one account is ever on the server for another.
test('hosted: ssam_preview never runs and a hosted context never prepares', async t => {
  const { wrapHostedTool } = await import('../hosted/policy.mjs');
  const { runWithExecutor } = await import('../executor.mjs');
  const w = world(t);
  w.write(w.input);
  let ran = false;
  const gated = wrapHostedTool('ssam_preview', { inputSchema: {} }, async () => { ran = true; return { content: [] }; },
    { context: { workspace: w.workspace, lanes: ['odc', 'o11'], agent: { info: () => ({}), connected: () => true } } });
  for (const args of [{ action: 'list' }, { action: 'open', profile: 'loan-portal' }, { action: 'list', app: '..\\..\\other-customer', tenant: 'C:\\data\\server' }]) {
    const answer = await gated(args, {});
    assert.equal(answer.structuredContent.code, 'HOSTED_UNAVAILABLE', JSON.stringify(args));
  }
  assert.equal(ran, false, 'the handler never runs hosted');
  const context = { hosted: true, workspace: w.workspace, executor: { call: async () => ({}) } };
  const listed = await runWithExecutor(context, () => w.manager({ action: 'list', app: 'EquipmentLoanPortal' }));
  assert.equal(listed.code, undefined);
  assert.match(listed.prepare.reasons[0].why, /^HOSTED_UNAVAILABLE/);
  const opened = await runWithExecutor(context, () => w.manager({ action: 'open', app: 'EquipmentLoanPortal' }));
  assert.equal(opened.code, 'PREVIEW_PROFILE_NOT_PREPARED');
  assert.equal(fs.existsSync(w.catalog), false, 'nothing registered');
  assert.equal(fs.existsSync(w.profiles), false, 'nothing written');
});

// ---- Round 2 (review C:\t\r4\REVISAO-W3-PREVIEW.md) ----

// The reviewer's exploit with the REAL O11 engine (no simulated one): a host configuration inside the root whose own pins
// (contextContract and its application metadata, entry locations and installer; runtimeAssets and the asset it serves) are
// in another folder. Round 1 prepared it, and open served the outside file at GET /stolen.txt. Now the whole pinned graph
// is confined: nothing is prepared. The same graph built inside the root prepares and serves, so the walk refuses only what
// is outside.
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
function o11Graph(folder, secretText) {
  fs.mkdirSync(folder, { recursive: true });
  const write = (name, value) => { const file = path.join(folder, name); if (typeof value === 'string') fs.writeFileSync(file, value); else atomicJson(file, value); return pin(file); };
  const secret = write('secret.txt', secretText);
  const installer = write('installer.js', '/* installer */');
  const application = write('app.json', { schema: 'ssam-o11-application-bootstrap/1', moduleKey: 'mk', provenance: { capture: 'test' },
    definition: { applicationName: 'Probe', userProviderName: 'Users', homeModuleName: 'Probe', homeModuleKey: 'mk', homeModuleControllerName: 'Probe.controller', homeModuleLanguageResourcesName: 'Probe.languageResources', isWeb: true, clientEntitiesModules: [] } });
  const locations = write('loc.json', { schema: 'ssam-native-entry-locations/1', moduleKey: 'mk', entries: [{ screenKey: 'sk', location: '/Probe/Home', provenance: { capture: 'test' } }] });
  const context = write('context.json', { schema: 'ssam-local-render-context/1', status: 'authorized-local-render-scenario', moduleKey: 'mk', screenKeys: ['sk'],
    bindHost: '127.0.0.1', sessionId: 'probe', realBackend: false, realAccessValidated: false, applicationMetadata: application, installer, entryLocations: locations, scenario: {} });
  const registry = write('registry.json', { assets: [{ route: '/stolen.txt', contentType: 'text/plain', rootAccessible: true, ...secret }] });
  return { context, registry };
}
function o11World(t, graphInside) {
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-preview-o11-')));
  const other = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-preview-o11-other-')));
  const graph = o11Graph(graphInside ? path.join(workspace, 'qualified', 'graph') : other, graphInside ? 'INSIDE-THE-WORKSPACE' : 'OUTSIDE-THE-WORKSPACE-CONTENT');
  const host = path.join(workspace, 'qualified', 'host.json');
  atomicJson(host, { schema: 'ssam-native-o11-host-config/1', sourcePlatform: 'o11', stableSessionId: 'probe', transportPolicy: 'deny-all', startAllowed: true,
    bindHost: '127.0.0.1', port: 1, target: { module: 'Probe', moduleKey: 'mk', screen: 'Home', screenKey: 'sk' }, contextContract: graph.context, runtimeAssets: graph.registry });
  const manager = createPreviewManager({ workspace });
  t.after(async () => {
    await manager({ action: 'stop', sessionId: 'probe' });
    await delay(500);
    for (const dir of [workspace, other]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  return { workspace, other, host, manager, catalog: path.join(workspace, '.local', 'preview', 'catalog.json'), profiles: path.join(workspace, '.local', 'preview', 'profiles'),
    write: async () => atomicJson(path.join(workspace, '.local', 'preview', 'inputs', 'probe.json'), { schema: INPUT_SCHEMA, id: 'probe', lane: 'o11',
      target: { app: 'Probe', moduleKey: 'mk', tenant: 'local' }, screens: [{ name: 'Home', key: 'sk' }], limitations: ['probe'], hostConfig: pin(host), port: await freePort() }) };
}

test('the real O11 engine: a host config inside the root whose own pins are outside is never prepared, so open never serves them', async t => {
  const w = o11World(t, false);
  await w.write();
  const listed = await w.manager({ action: 'list', app: 'Probe' });
  assert.equal(listed.code, undefined, JSON.stringify(listed));
  const whys = listed.prepare.reasons.map(r => r.why).join('\n');
  assert.match(whys, /^PATH_OUTSIDE_WORKSPACE: hostConfig>\/contextContract\/file /m);
  assert.match(whys, /^PATH_OUTSIDE_WORKSPACE: hostConfig>\/runtimeAssets\/file /m);
  const opened = await w.manager({ action: 'open', app: 'Probe' });
  assert.equal(opened.code, 'PREVIEW_PROFILE_NOT_PREPARED');
  assert.equal(opened.url, undefined, 'no host started');
  assert.equal(fs.existsSync(w.catalog), false, 'nothing registered');
  assert.equal(fs.existsSync(w.profiles) ? fs.readdirSync(w.profiles).length : 0, 0, 'no profile folder');
});

test('the real O11 engine: the same graph inside the root is prepared and served (the walk refuses only what is outside)', async t => {
  const w = o11World(t, true);
  await w.write();
  const listed = await w.manager({ action: 'list', app: 'Probe' });
  assert.equal(listed.code, 'PREVIEW_PROFILE_PREPARED', JSON.stringify(listed.prepare ?? listed));
  let opened = await w.manager({ action: 'open', app: 'Probe' });
  if (opened.status === 'starting') {
    const end = Date.now() + SETTLE_MS;
    while (Date.now() < end) { opened = await w.manager({ action: 'status', sessionId: 'probe' }); if (!['starting', 'unreachable'].includes(opened.status)) break; await delay(100); }
    if (opened.status === 'running') opened = await w.manager({ action: 'open', app: 'Probe' });
  }
  assert.equal(opened.status, 'running', JSON.stringify(opened));
  assert.equal(await (await fetch(new URL('/stolen.txt', opened.url))).text(), 'INSIDE-THE-WORKSPACE');
});

test('pinned graph: relative, climbing, UNC and file: URL paths at any depth are outside; a scenario route is not a path', async t => {
  const { confinedGraph } = await import('../preview/auto-prepare.mjs');
  const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-preview-graph-')));
  const other = elsewhere(t);
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const q = path.join(workspace, 'q');
  fs.mkdirSync(path.join(q, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(q, 'deep', 'ok.txt'), 'ok');
  const level2 = path.join(q, 'deep', 'level2.json');
  const check = (inner, extra = {}) => {
    atomicJson(level2, inner);
    const host = path.join(q, 'host.json');
    atomicJson(host, { schema: 'x', statusFile: 'C:\\anywhere\\replaced.json', nested: pin(level2), ...extra });
    return confinedGraph(workspace, pin(host), 'hostConfig');
  };
  assert.deepEqual(check({ assets: [{ file: 'ok.txt' }], endpoints: [{ path: '/screenservices/App/Action' }], provenance: { csc: 'C:\\Program Files\\csc.exe' } }), [],
    'a relative file next to it, a URL route, a provenance record and a replaced state file pass');
  for (const [why, inner] of [
    ['an absolute path of another folder', { scope: { file: other.host, sha256: 'f'.repeat(64) } }],
    ['a relative path that climbs', { assets: [{ file: '..\\..\\..\\outside.txt' }] }],
    ['a UNC path in any field', { note: '\\\\127.0.0.1\\c$\\Windows\\win.ini' }],
    ['a file: URL', { baselineConfig: 'file:///' + other.host.replace(/\\/g, '/') }],
    ['a drive path in a list', { roots: ['C:\\Windows'] }],
    ['a root-of-drive path', { outputRoot: '\\Windows' }],
  ]) {
    const reasons = check(inner);
    assert.ok(reasons.length > 0 && reasons.every(r => /^PATH_OUTSIDE_WORKSPACE: hostConfig>\/nested\/file>/.test(r)), why + ': ' + JSON.stringify(reasons));
  }
  // a pin whose sha256 does not match is refused, and the graph is not followed past it
  atomicJson(level2, { scope: { file: other.host, sha256: 'f'.repeat(64) } });
  const host = path.join(q, 'host.json');
  atomicJson(host, { nested: { file: level2, sha256: '0'.repeat(64) } });
  assert.deepEqual(confinedGraph(workspace, pin(host), 'hostConfig'), ['hostConfig>/nested/file: PREVIEW_PIN_CHANGED']);
  // a cycle of pins ends
  const a = path.join(q, 'a.json'), b = path.join(q, 'b.json');
  atomicJson(a, { next: { file: b } }); atomicJson(b, { next: { file: a } });
  assert.deepEqual(confinedGraph(workspace, pin(a), 'hostConfig'), []);
});

test('an input with watcherConfig is never prepared by the call: the reason names the integrator command', async t => {
  const w = world(t);
  const watcher = path.join(w.workspace, 'qualified', 'watcher.json');
  atomicJson(watcher, { compiler: { file: path.join(w.workspace, 'qualified', 'compiler.mjs') }, target: { pid: 4242 } });
  w.write({ ...w.input, watcherConfig: pin(watcher) });
  const listed = await w.manager({ action: 'list', app: 'EquipmentLoanPortal' });
  assert.equal(listed.code, undefined);
  const reason = listed.prepare.reasons.find(r => /^PREVIEW_WATCHER_INTEGRATOR_ONLY/.test(r.why));
  assert.ok(reason, JSON.stringify(listed.prepare.reasons));
  assert.ok(reason.why.includes('node platforms/odc/facade/preview/prepare.mjs --input "' + path.join(w.inputs, 'loan-portal.json') + '"'), reason.why);
  const opened = await w.manager({ action: 'open', app: 'EquipmentLoanPortal' });
  assert.equal(opened.code, 'PREVIEW_PROFILE_NOT_PREPARED');
  assert.match(opened.error, /PREVIEW_WATCHER_INTEGRATOR_ONLY/);
  assert.equal(fs.existsSync(w.catalog), false);
  assert.deepEqual(w.prepared(), []);
});

// One lock for every preparer (prepare.mjs withPrepareLock).
const runCli = (input, catalog) => new Promise(resolve => {
  const child = spawn(process.execPath, [SCRIPT, '--input', input, '--catalog', catalog], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', d => { out += d; });
  child.on('close', exit => { try { resolve({ exit, ...JSON.parse(out) }); } catch { resolve({ exit, raw: out }); } });
});
const deadPid = () => new Promise(resolve => { const c = spawn(process.execPath, ['-e', '']); const pid = c.pid; c.on('exit', () => resolve(pid)); });

test('the integrator command takes the same lock: held by a live process it answers PREVIEW_PREPARE_BUSY and registers nothing', async t => {
  const w = world(t);
  w.write(w.input);
  const catalog = path.join(w.workspace, 'cli', 'catalog.json');
  const lock = path.join(w.workspace, 'cli', 'profiles', 'prepare.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: 'other' }));
  const busy = await runCli(path.join(w.inputs, 'loan-portal.json'), catalog);
  assert.equal(busy.exit, 1);
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'PREVIEW_PREPARE_BUSY');
  assert.match(busy.error, /Another preparation holds .*prepare\.lock/);
  assert.equal(fs.existsSync(catalog), false, 'nothing registered');
  assert.equal(fs.readFileSync(lock, 'utf8').includes('"token":"other"'), true, 'the other preparer\'s lock is left as it was');
  assert.deepEqual(fs.readdirSync(path.dirname(lock)), ['prepare.lock'], 'no profile folder');
});

test('a lock whose process ended, or older than the ceiling, is reclaimed by rename; a fresh one of a live process is not', async t => {
  const { withPrepareLock, prepareLockFile, PREPARE_LOCK_MAX_MS } = await import('../preview/prepare.mjs');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-preview-lock-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const catalog = path.join(root, 'catalog.json'), lock = prepareLockFile(catalog);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const hold = value => fs.writeFileSync(lock, JSON.stringify(value));
  const stale = () => fs.readdirSync(path.dirname(lock)).filter(n => n.startsWith('prepare.lock.stale-'));
  hold({ pid: await deadPid(), startedAt: new Date().toISOString(), token: 'dead' });
  assert.equal(withPrepareLock(catalog, () => JSON.parse(fs.readFileSync(lock, 'utf8')).pid), process.pid, 'taken after the dead owner');
  assert.equal(fs.existsSync(lock), false, 'released');
  assert.equal(stale().length, 1, 'the dead lock was renamed aside, never deleted');
  hold({ pid: process.pid, startedAt: new Date(Date.now() - PREPARE_LOCK_MAX_MS - 1000).toISOString(), token: 'old' });
  assert.equal(withPrepareLock(catalog, () => 'ran'), 'ran', 'an expired lock is reclaimed even with a live pid (pid reuse)');
  assert.equal(stale().length, 2);
  hold({ pid: process.pid, startedAt: new Date().toISOString(), token: 'live' });
  assert.throws(() => withPrepareLock(catalog, () => 'never'), { code: 'PREVIEW_PREPARE_BUSY' });
  assert.match(fs.readFileSync(lock, 'utf8'), /"token":"live"/, 'a live lock is never taken nor removed');
});

test('concurrent preparers (integrator commands and the call) never lose a registration', async t => {
  const w = world(t);
  // six inputs of six ids, prepared at once by six integrator commands and the automatic preparation of one of them
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  const files = ids.map(id => { const file = path.join(w.workspace, 'cli-inputs', id + '.json'); atomicJson(file, { ...w.input, id, target: { ...w.input.target, app: 'App-' + id } }); return file; });
  w.write({ ...w.input, id: 'auto', target: { ...w.input.target, app: 'App-auto' } }, 'auto.json');
  const answers = await Promise.all([...files.map(file => runCli(file, w.catalog)), w.manager({ action: 'list', app: 'App-auto' })]);
  const cli = answers.slice(0, ids.length), auto = answers.at(-1);
  for (const a of cli) assert.ok(a.ok === true || a.error?.includes('Another preparation holds'), JSON.stringify(a));
  const registered = readJson(w.catalog).profiles.map(p => readJson(p.file).id).sort();
  const expected = [...cli.filter(a => a.ok).map(a => a.profile && readJson(a.profile.file).id), ...(auto.code === 'PREVIEW_PROFILE_PREPARED' ? ['auto'] : [])].sort();
  assert.deepEqual(registered, expected, 'every preparer that said prepared is registered, and no other');
  t.diagnostic(`registered ${registered.length} of ${ids.length + 1} concurrent preparers; the others answered busy`);
  // every profile folder belongs to a registered profile: a busy preparer created none
  const folders = w.prepared().filter(n => !n.startsWith('prepare.lock'));
  assert.equal(folders.length, registered.length, JSON.stringify(folders));
});

test('a failed registration removes only the folder this preparation created', async t => {
  const w = world(t);
  w.write(w.input);
  // a catalog that notRegistered accepts and registerProfile refuses (an entry it cannot load), and another preparer's folder
  fs.mkdirSync(w.profiles, { recursive: true });
  atomicJson(w.catalog, { schema: 'ssam-preview-catalog/1', profiles: [{ file: path.join(w.workspace, 'missing.json'), sha256: 'a'.repeat(64) }] });
  const others = path.join(w.profiles, 'other-preparer-20261101-000000');
  fs.mkdirSync(others); fs.writeFileSync(path.join(others, 'keep.txt'), 'keep');
  const { autoPrepare } = await import('../preview/auto-prepare.mjs');
  const { notPrepared } = autoPrepare({ app: 'EquipmentLoanPortal' }, { workspace: w.workspace, catalogFile: w.catalog, engines: w.engines });
  assert.match(notPrepared.reasons[0].why, /ENOENT|PREVIEW_PIN/, JSON.stringify(notPrepared.reasons));
  assert.deepEqual(fs.readdirSync(w.profiles).sort(), ['other-preparer-20261101-000000'], 'the folder of this preparation is gone, the other one stays');
  assert.equal(fs.readFileSync(path.join(others, 'keep.txt'), 'utf8'), 'keep');
  // and prepareProfile never reuses a folder it did not create: PREVIEW_FRESH_DIRECTORY, nothing marked as created
  const { prepareProfile } = await import('../preview/prepare.mjs');
  let error;
  try { prepareProfile({ directory: others, id: 'loan-portal', lane: 'o11', target: w.input.target, screens: w.input.screens, limitations: ['x'], hostConfig: w.input.hostConfig, port: 34567, engines: w.engines }); } catch (e) { error = e; }
  assert.equal(error.code, 'PREVIEW_FRESH_DIRECTORY');
  assert.equal(error.createdDirectory, undefined);
  assert.equal(fs.readFileSync(path.join(others, 'keep.txt'), 'utf8'), 'keep');
});
