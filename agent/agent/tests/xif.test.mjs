// o11.xif (F4 of PLANO-11H): the model and final stages of o11_extension with the Integration Studio of this machine. A fake
// engine process and a fake Integration Studio folder; no Integration Studio, no Studio, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { createWorkspace } from '../lib/workspace.mjs';
import { KINDS, helloKinds, createKinds } from '../lib/kinds.mjs';
import { readPack } from '../lib/agent.mjs';
import { XIF_KIND, INTEGRATION_STUDIO, createXifKind, prepareXifRequest, locateIntegrationStudio, resolveXifEngine, namesProfile } from '../lib/xif.mjs';
import { xifRows, OP } from './fixtures/xif-table.mjs';

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-xif-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const codeOf = fn => { try { fn(); return 'ok'; } catch (error) { return error.code; } };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const at = rel => 'agent:o11/xif/' + OP + '/' + rel;
function agentRoot(t) {
  const root = tmp(t);
  for (const dir of ['odc/snapshots', 'odc/journal', 'odc/lab', 'o11', 'inbox', 'private']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}
const put = (root, rel, content) => { const file = path.join(root, ...('o11/xif/' + OP + '/' + rel).split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
const MODEL = { command: 'model', operationId: OP, output: at('out/ZZHybridXifLab.xif'), spec: { name: 'ZZHybridXifLab', actions: [] }, references: [at('in/0/Vendor.dll')] };

// A fake engine: writes a zlib XIF at the request's output and answers as Anvil.Xif.Engine does.
function fakeEngine({ answer = null, xml = '<Extension Name="ZZHybridXifLab"/>' } = {}) {
  const runs = [];
  return { runs, spawnEngine: async (exe, input, options) => {
    const request = JSON.parse(input);
    runs.push({ exe, request, options });
    if (answer) return { code: 1, stdout: JSON.stringify(answer) + '\n' };
    fs.mkdirSync(path.dirname(request.output), { recursive: true });
    fs.writeFileSync(request.output, zlib.deflateSync(Buffer.from(xml)));
    return { code: 0, stdout: 'log line\n' + JSON.stringify({ ok: true, xif: request.output, sha256: 'x', studio: { dir: options.env.ANVIL_INTEGRATION_STUDIO_DIR, version: '11.14.25.134', lastUpgradeVersion: '11.0.0.200' }, reports: [] }) + '\n' };
  } };
}
// The pinned engine host of a pack (M1): a real file and its sha256, under the test's own folder.
function pinnedEngine(root) {
  const file = path.join(root, 'runtime', 'xif-engine', 'Anvil.Xif.Engine.exe');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'engine host');
  return { path: file, sha256: sha('engine host') };
}
const kindFor = (root, engine, { locate = async () => 'C:\\IS', platform = 'win32', profile = 'C:\\Users\\someone', env = {}, now } = {}) =>
  createXifKind({ root, ws: createWorkspace(root, { platform: 'win32' }), engine: engine.pinned ?? (engine.pinned = pinnedEngine(root)), platform,
    deps: { locate, spawnEngine: engine.spawnEngine, env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows', ...env }, profile, ...(now ? { now } : {}) } });

test('the hello lists o11.xif only when this installation carries the engine host', () => {
  assert.equal(XIF_KIND, 'o11.xif');
  assert.ok(!KINDS.includes(XIF_KIND));
  assert.deepEqual(helloKinds(null), [...KINDS]);
  assert.deepEqual(helloKinds(null, { path: 'C:\\pack\\xif-engine\\Anvil.Xif.Engine.exe' }), [...KINDS, XIF_KIND]);
  assert.deepEqual(helloKinds({ path: 'r' }, { path: 'e' }).slice(-2), ['screen.render', XIF_KIND]);
});

test('M10: the server box knows the kind and sends it only to an agent whose Hello lists it', async () => {
  const file = new URL('../../../server/platforms/odc/facade/call-kinds.mjs', import.meta.url);
  const { CALL_KINDS, HELLO_ONLY_KINDS } = await import(file.href);
  assert.deepEqual([...CALL_KINDS].sort(), [...helloKinds({ path: 'renderer' }, { path: 'engine' })].sort());
  assert.ok(HELLO_ONLY_KINDS.has(XIF_KIND));
});

test('M1: the engine host is only the one pack.json pins (path and sha256); no pin, another file or nothing off Windows is no engine', t => {
  const runtime = tmp(t);
  const exe = path.join(runtime, 'xif-engine', 'Anvil.Xif.Engine.exe');
  const pin = { path: 'xif-engine/Anvil.Xif.Engine.exe', sha256: sha('engine') };
  assert.equal(resolveXifEngine({ runtimeRoot: runtime, platform: 'win32', pack: { xifEngine: pin } }), null, 'not in the pack');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'engine');
  assert.equal(resolveXifEngine({ runtimeRoot: runtime, platform: 'win32' }), null, 'a file at the usual place without a pin never runs');
  assert.equal(resolveXifEngine({ runtimeRoot: runtime, platform: 'win32', pack: { xifEngine: { path: pin.path } } }), null, 'a pin without sha256 is no pin');
  assert.deepEqual(resolveXifEngine({ runtimeRoot: runtime, platform: 'win32', pack: { xifEngine: pin } }), { path: exe, sha256: sha('engine') });
  assert.equal(resolveXifEngine({ runtimeRoot: runtime, platform: 'win32', pack: { xifEngine: { ...pin, sha256: sha('other') } } }), null, 'a changed engine is not run');
  assert.equal(resolveXifEngine({ runtimeRoot: runtime, platform: 'win32', pack: { xifEngine: { path: '../x.exe' } } }), null);
  assert.equal(resolveXifEngine({ runtimeRoot: runtime, platform: 'darwin' }), null);
  fs.writeFileSync(path.join(runtime, 'pack.json'), JSON.stringify({ id: 'p', lanes: ['o11'], xifEngine: { path: 'xif-engine/Anvil.Xif.Engine.exe', sha256: sha('engine') } }));
  assert.deepEqual(readPack(runtime).xifEngine, { path: 'xif-engine/Anvil.Xif.Engine.exe', sha256: sha('engine') });
});

test('Integration Studio is found by the Studios rule: the uninstall key (its folder or the nested one), then Program Files; never a fixed path', async () => {
  const marker = dir => path.join(dir, INTEGRATION_STUDIO.marker);
  const has = set => file => set.has(file);
  const queries = [];
  const query = location => async (key, value, view) => { queries.push([key, value, view]); return location; };
  assert.equal(await locateIntegrationStudio({ env: {}, exists: has(new Set([marker('D:\\OS\\IS')])), query: query('D:\\OS\\IS') }), 'D:\\OS\\IS');
  assert.match(queries[0][0], /^HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OutSystems Integration Studio 11$/);
  assert.equal(await locateIntegrationStudio({ env: {}, exists: has(new Set([marker(path.join('D:\\OS', 'Integration Studio'))])), query: query('D:\\OS') }), path.join('D:\\OS', 'Integration Studio'));
  const programs = path.join('E:\\Programs', 'OutSystems', 'Integration Studio');
  assert.equal(await locateIntegrationStudio({ env: { ProgramFiles: 'E:\\Programs' }, exists: has(new Set([marker(programs)])), query: query(null) }), programs);
  assert.equal(await locateIntegrationStudio({ env: { ProgramFiles: 'E:\\Programs' }, exists: () => false, query: query('D:\\OS') }), null, 'a folder without the marker DLL does not count');
});

for (const row of xifRows()) test('table: ' + row.label, t => {
  const root = agentRoot(t);
  assert.equal(codeOf(() => prepareXifRequest(row.params, { ws: createWorkspace(root, { platform: 'win32' }) })), row.expected);
});

test('a model stage runs the pack engine with the found Integration Studio, a private TEMP, and answers the agent path and sha256', async t => {
  const root = agentRoot(t);
  put(root, 'in/0/Vendor.dll', 'vendor');
  const engine = fakeEngine();
  const value = await kindFor(root, engine).execute(structuredClone(MODEL));
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.xif, MODEL.output);
  const file = path.join(root, 'o11', 'xif', OP, 'out', 'ZZHybridXifLab.xif');
  assert.equal(value.sha256, sha(fs.readFileSync(file)));
  assert.deepEqual(value.studio, { version: '11.14.25.134', lastUpgradeVersion: '11.0.0.200' }, 'no folder of this machine');
  const [run] = engine.runs;
  assert.equal(run.exe, engine.pinned.path);
  assert.equal(run.options.env.ANVIL_INTEGRATION_STUDIO_DIR, 'C:\\IS');
  assert.ok(run.options.env.TEMP.startsWith(path.join(root, 'o11', 'xif', OP, 'work')), 'a TEMP of this operation');
  assert.equal(run.request.references[0], path.join(root, 'o11', 'xif', OP, 'in', '0', 'Vendor.dll'));
  assert.equal(run.request.output, file);
  assert.ok(!fs.existsSync(path.join(root, 'o11', 'xif', OP, 'in')), 'the inputs leave once the stage ran');
});

test('M1: an engine host replaced after the start is not run', async t => {
  const root = agentRoot(t);
  put(root, 'in/0/Vendor.dll', 'vendor');
  const engine = fakeEngine();
  const kind = kindFor(root, engine);
  fs.writeFileSync(engine.pinned.path, 'another program');
  const value = await kind.execute(structuredClone(MODEL));
  assert.equal(value.code, 'XIF_ENGINE_UNAVAILABLE'); assert.match(value.error, /changed since the app was installed/);
  assert.equal(engine.runs.length, 0);
  assert.ok(!fs.existsSync(path.join(root, 'o11', 'xif', OP, 'in')), 'the inputs leave even when nothing ran');
});

test('B2: older operation folders leave after an hour, the inputs leave on every outcome, the engine\'s native work leaves with its run', async t => {
  const root = agentRoot(t);
  const old = path.join(root, 'o11', 'xif', 'aaaaaaaaaaaaaaaa', 'out'); fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'X.xif'), 'x');
  const recent = path.join(root, 'o11', 'xif', 'bbbbbbbbbbbbbbbb'); fs.mkdirSync(recent, { recursive: true });
  const other = path.join(root, 'o11', 'xif', 'not-an-operation'); fs.mkdirSync(other, { recursive: true });
  const past = new Date(Date.now() - 2 * 3600000); fs.utimesSync(path.dirname(old), past, past);
  const local = tmp(t), native = path.join(local, 'SSAM', 'xif', 'c'.repeat(32)); fs.mkdirSync(native, { recursive: true });
  const engine = fakeEngine({ answer: { ok: false, code: 'XIF_VERIFY_FAILED', error: 'failed', nativeWork: native } });
  const none = await kindFor(root, engine, { locate: async () => null, env: { LOCALAPPDATA: local } }).execute(structuredClone(MODEL)).catch(error => error);
  assert.equal(none.code, 'XIF_ENGINE_UNAVAILABLE');
  assert.ok(!fs.existsSync(path.dirname(old)), 'an operation older than an hour is swept');
  assert.ok(fs.existsSync(recent) && fs.existsSync(other), 'a recent operation and a folder of another name stay');
  put(root, 'in/0/Vendor.dll', 'vendor');
  const failed = await kindFor(root, engine, { env: { LOCALAPPDATA: local } }).execute(structuredClone(MODEL));
  assert.equal(failed.code, 'XIF_VERIFY_FAILED');
  assert.ok(!fs.existsSync(native), 'the native work of the failed run left');
  assert.ok(!fs.existsSync(path.join(root, 'o11', 'xif', OP, 'in')));
});

test('B3: this machine\'s folders are masked whatever their case', async t => {
  const root = agentRoot(t);
  const engine = fakeEngine({ answer: { ok: false, code: 'XIF_VERIFY_FAILED', error: 'failed in c:\\USERS\\SOMEONE\\AppData and ' + root.toUpperCase() } });
  const value = await kindFor(root, engine).execute(structuredClone(MODEL));
  assert.ok(!/someone/i.test(JSON.stringify(value)), JSON.stringify(value));
  assert.ok(!JSON.stringify(value).toLowerCase().includes(root.toLowerCase().replaceAll('\\', '\\\\')));
});

test('negatives: no Integration Studio, no engine in the pack, not Windows: nothing runs', async t => {
  const root = agentRoot(t);
  const engine = fakeEngine();
  await assert.rejects(kindFor(root, engine, { locate: async () => null }).execute(structuredClone(MODEL)),
    error => error.code === 'XIF_ENGINE_UNAVAILABLE' && error.executed === false && /Integration Studio 11 is not installed/.test(error.message));
  await assert.rejects(createXifKind({ root, ws: createWorkspace(root, { platform: 'win32' }), engine: null, platform: 'win32', deps: { locate: async () => 'C:\\IS', spawnEngine: engine.spawnEngine } }).execute(structuredClone(MODEL)),
    error => error.code === 'XIF_ENGINE_UNAVAILABLE' && /does not carry the Integration Studio engine host/.test(error.message));
  await assert.rejects(kindFor(root, engine, { platform: 'darwin' }).execute(structuredClone(MODEL)), { code: 'XIF_PLATFORM_UNAVAILABLE' });
  assert.equal(engine.runs.length, 0);
});

test('a build failure answers the engine refusal, with this machine\'s folders masked', async t => {
  const root = agentRoot(t);
  const engine = fakeEngine({ answer: { ok: false, code: 'XIF_VERIFY_FAILED', error: 'ProjectVerify failed in ' + path.join(root, 'o11', 'x') + ' for C:\\Users\\someone\\AppData', problems: [{ code: 'XIF_VERIFY_FAILED', path: 'Add', message: 'Invalid name.', fix: 'Rename it.' }], nativeWork: 'C:\\Users\\someone\\AppData\\Local\\SSAM\\xif\\1' } });
  const value = await kindFor(root, engine).execute(structuredClone(MODEL));
  assert.equal(value.ok, false); assert.equal(value.code, 'XIF_VERIFY_FAILED');
  assert.equal(value.problems[0].path, 'Add');
  assert.ok(!JSON.stringify(value).includes(root) && !JSON.stringify(value).includes('C:\\Users\\someone'), JSON.stringify(value));
  assert.equal(value.nativeWork, undefined);
});

test('a path escape is refused before the engine runs; a XIF that names the user profile is removed', async t => {
  const root = agentRoot(t);
  const engine = fakeEngine();
  await assert.rejects(kindFor(root, engine).execute({ ...structuredClone(MODEL), references: ['agent:o11/xif/' + OP + '/../../../private/credential'] }), { code: 'PATH_FORBIDDEN' });
  await assert.rejects(kindFor(root, engine).execute({ ...structuredClone(MODEL), references: ['C:\\Windows\\win.ini'] }), { code: 'PATH_FORBIDDEN' });
  assert.equal(engine.runs.length, 0);
  const leaky = fakeEngine({ xml: '<Extension Name="ZZHybridXifLab"><R Path="C:\\Users\\Someone\\AppData\\Local\\x.dll"/></Extension>' });
  const value = await kindFor(root, leaky).execute(structuredClone(MODEL));
  assert.equal(value.code, 'XIF_VERIFY_FAILED');
  assert.ok(!fs.existsSync(path.join(root, 'o11', 'xif', OP, 'out', 'ZZHybridXifLab.xif')));
  assert.equal(namesProfile(zlib.deflateSync(Buffer.from('<x/>')), ['C:\\Users\\someone']), false);
});

test('the kinds table runs o11.xif only with the engine host; without it KIND_NOT_ALLOWED', async t => {
  const root = agentRoot(t);
  const base = { root, ws: createWorkspace(root, { platform: 'win32' }), pack: { lanes: ['o11'] }, deps: { processes: async () => [], xif: { locate: async () => null } }, platform: 'win32' };
  await assert.rejects(createKinds(base).execute(XIF_KIND, structuredClone(MODEL)), { code: 'KIND_NOT_ALLOWED' });
  await assert.rejects(createKinds({ ...base, xifEngine: pinnedEngine(root) }).execute(XIF_KIND, structuredClone(MODEL)), { code: 'XIF_ENGINE_UNAVAILABLE' });
});
