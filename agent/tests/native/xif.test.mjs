// o11.xif in the native core, which is what ships in the app (F4 of PLANO-11H). check-xif-request answers the Node table row by row;
// check-xif-locate the Studios rule for Integration Studio; check-xif-run one stage on the real XifKinds with a stand-in engine.
// No Integration Studio, no engine process, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { xifRows, OP } from '../../agent/tests/fixtures/xif-table.mjs';
import { prepareXifRequest } from '../../agent/lib/xif.mjs';
import { createWorkspace } from '../../agent/lib/workspace.mjs';

const app = fileURLToPath(new URL('../../', import.meta.url));
const dll = path.join(app, 'native/Ssam.Agent/bin/Release/net10.0/ssam-agent.dll');
const native = (args, options = {}) => {
  const exe = process.env.SSAM_NATIVE_EXE;
  return spawnSync(exe || 'dotnet', exe ? args : [dll, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options });
};
function agentRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-native-xif-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const dir of ['odc/snapshots', 'odc/journal', 'odc/lab', 'o11', 'inbox', 'private']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  return root;
}
const codeOf = fn => { try { fn(); return { ok: true }; } catch (error) { return { error: error.code }; } };

test('native check-xif-request answers the Node table row by row', { timeout: 120000 }, t => {
  const root = agentRoot(t);
  const rows = xifRows();
  const result = native(['check-xif-request', root], { input: JSON.stringify(rows.map(row => row.params)) });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  const ws = createWorkspace(root, { platform: 'win32' });
  rows.forEach((row, i) => {
    assert.deepEqual(actual[i], codeOf(() => prepareXifRequest(row.params, { ws })), row.label + ' (as the Node agent)');
    assert.deepEqual(actual[i], row.expected === 'ok' ? { ok: true } : { error: row.expected }, row.label);
  });
});

test('native check-xif-locate: the uninstall location, its nested folder, then Program Files; a folder without the marker does not count', { timeout: 120000 }, () => {
  const marker = dir => path.join(dir, 'OutSystems.IntegrationStudio.Core.dll');
  const run = input => JSON.parse(native(['check-xif-locate'], { input: JSON.stringify(input) }).stdout);
  assert.equal(run({ locations: [null, 'D:\\OS\\IS'], programFiles: [], existing: [marker('D:\\OS\\IS')] }), 'D:\\OS\\IS');
  assert.equal(run({ locations: ['D:\\OS'], programFiles: [], existing: [marker('D:\\OS\\Integration Studio')] }), 'D:\\OS\\Integration Studio');
  assert.equal(run({ locations: [], programFiles: ['E:\\Programs'], existing: [marker('E:\\Programs\\OutSystems\\Integration Studio')] }), 'E:\\Programs\\OutSystems\\Integration Studio');
  assert.equal(run({ locations: ['D:\\OS'], programFiles: ['E:\\Programs'], existing: [] }), null);
});

const at = rel => 'agent:o11/xif/' + OP + '/' + rel;
const MODEL = { command: 'model', operationId: OP, output: at('out/ZZHybridXifLab.xif'), spec: { name: 'ZZHybridXifLab', actions: [] }, references: [at('in/0/Vendor.dll')] };

test('native check-xif-run: a model stage runs with the found Integration Studio and a private TEMP, and answers the agent path and sha256', { timeout: 120000 }, t => {
  const root = agentRoot(t);
  const vendor = path.join(root, 'o11', 'xif', OP, 'in', '0', 'Vendor.dll');
  fs.mkdirSync(path.dirname(vendor), { recursive: true }); fs.writeFileSync(vendor, 'vendor');
  const result = native(['check-xif-run', root], { input: JSON.stringify({ params: MODEL, studio: 'C:\\IS', profile: 'C:\\Users\\someone' }) });
  assert.equal(result.status, 0, result.stderr);
  const { seen, value } = JSON.parse(result.stdout);
  assert.equal(value.ok, true, result.stdout);
  assert.equal(value.xif, MODEL.output);
  assert.match(value.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(value.studio, { version: '11.14.25.134', lastUpgradeVersion: '11.0.0.200' }, 'no folder of this machine');
  assert.equal(seen.studio, 'C:\\IS');
  assert.ok(seen.temp.startsWith(path.join(root, 'o11', 'xif', OP, 'work')));
  assert.equal(seen.request.references[0], vendor);
  assert.ok(!fs.existsSync(path.join(root, 'o11', 'xif', OP, 'in')), 'the inputs leave once the stage ran');
});

test('native negatives: no Integration Studio, a build failure masked, a path escape, a XIF naming the user profile', { timeout: 120000 }, t => {
  const root = agentRoot(t);
  const run = input => JSON.parse(native(['check-xif-run', root], { input: JSON.stringify(input) }).stdout);
  const none = run({ params: MODEL, studio: null });
  assert.equal(none.error, 'XIF_ENGINE_UNAVAILABLE'); assert.equal(none.executed, false); assert.equal(none.seen, null);
  const failed = run({ params: MODEL, studio: 'C:\\IS', profile: 'C:\\Users\\someone', answer: { ok: false, code: 'XIF_VERIFY_FAILED', error: 'failed in ' + root + ' and C:\\Users\\someone\\AppData', problems: [{ code: 'XIF_VERIFY_FAILED', path: 'Add', message: 'Invalid name.' }], nativeWork: 'C:\\x' } });
  assert.equal(failed.value.code, 'XIF_VERIFY_FAILED'); assert.equal(failed.value.problems[0].path, 'Add');
  assert.ok(!JSON.stringify(failed.value).includes(root) && !JSON.stringify(failed.value).includes('C:\\\\Users\\\\someone'), JSON.stringify(failed.value));
  assert.equal(failed.value.nativeWork, undefined);
  // B2: the inputs leave even when nothing ran, and the engine's native work of a failed run leaves with it.
  const inputs = path.join(root, 'o11', 'xif', OP, 'in');
  fs.mkdirSync(inputs, { recursive: true }); fs.writeFileSync(path.join(inputs, 'x'), 'x');
  run({ params: MODEL, studio: null });
  assert.ok(!fs.existsSync(inputs), 'no Integration Studio: the inputs left');
  const nativeRoot = path.join(root, 'local', 'SSAM', 'xif'), nativeWork = path.join(nativeRoot, 'c'.repeat(32));
  fs.mkdirSync(nativeWork, { recursive: true });
  const kept = run({ params: MODEL, studio: 'C:\\IS', nativeRoot, answer: { ok: false, code: 'XIF_VERIFY_FAILED', error: 'failed', nativeWork } });
  assert.equal(kept.value.code, 'XIF_VERIFY_FAILED');
  assert.ok(!fs.existsSync(nativeWork), 'the native work of the failed run left');
  const escape = run({ params: { ...MODEL, references: ['C:\\Windows\\win.ini'] }, studio: 'C:\\IS' });
  assert.equal(escape.error, 'PATH_FORBIDDEN'); assert.equal(escape.seen, null);
  const leaky = run({ params: MODEL, studio: 'C:\\IS', profile: 'C:\\Users\\Someone', xml: '<Extension><R Path="c:\\users\\someone\\x.dll"/></Extension>' });
  assert.equal(leaky.value.code, 'XIF_VERIFY_FAILED');
  assert.ok(!fs.existsSync(path.join(root, 'o11', 'xif', OP, 'out', 'ZZHybridXifLab.xif')));
});

test('the native channel lists o11.xif in the Hello only with the engine host, runs it, and reports 0.4.8-native', () => {
  const channel = fs.readFileSync(path.join(app, 'native/Ssam.Agent/AgentChannel.cs'), 'utf8');
  assert.match(channel, /\.Concat\(xif\.Available \? new\[\] \{ XifKinds\.Name \}/);
  assert.match(channel, /kind == XifKinds\.Name\) value = await xif\.Execute/);
  assert.match(channel, /AgentVersion = "0\.4\.7-native"/);
});
