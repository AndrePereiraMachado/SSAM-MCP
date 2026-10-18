// scripts/prova-verbos.mjs (live proof 2 of docs/PROVAS-AO-VIVO.md) against a fake request function: the 22 verbs in the
// bridge's order, the agent's own port and key, nothing that changes the Studio without the opt-in flags, and the load
// errors that only a real Studio's JIT shows classified apart. No socket, no Studio.
import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERBS, classify, parseArgs, run } from '../scripts/prova-verbos.mjs';

function agentRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-prova-verbos-'));
  fs.mkdirSync(path.join(root, 'private', 'authority'), { recursive: true });
  fs.writeFileSync(path.join(root, 'private', 'o11-connection.json'), JSON.stringify({ ok: true, pid: 6000, port: 4516, startedUtc: 'x' }));
  fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), 'agent-key\n');
  return root;
}
function fakeRequest(answer = () => ({ success: true, data: {} })) {
  const seen = [];
  return { seen, request: async (target, method, params) => { seen.push({ target, method, params }); return answer(method, params); } };
}

test('arguments: the agent root is required, a host is a bare DNS name, --publish needs a test module', () => {
  assert.deepEqual(parseArgs(['--root', 'C:\\A']), { root: 'C:\\A', host: null, module: null, publish: false });
  assert.deepEqual(parseArgs(['--root', 'C:\\A', '--host', 'personal-x.outsystemscloud.com', '--module', 'Teste', '--publish']),
    { root: 'C:\\A', host: 'personal-x.outsystemscloud.com', module: 'Teste', publish: true });
  for (const bad of [[], ['--root'], ['--root', 'C:\\A', '--host', 'https://x.com'], ['--root', 'C:\\A', '--publish'], ['--root', 'C:\\A', '--write']])
    assert.throws(() => parseArgs(bad), Error, JSON.stringify(bad));
});

test('read-only by default: every verb answered or skipped, nothing opened, closed or published, the agent key on each call', async () => {
  const root = agentRoot();
  try {
    const fake = fakeRequest(method => (method === 'environment_session' ? { success: true, data: { lease: 'L1' } }
      : method === 'merge_from_oml' || method === 'close_dialog' ? { success: false, executed: false, error: 'refused by the handler' } : { success: true, data: {} }));
    const { results, summary, passed } = await run({ root, host: null, module: null, publish: false }, { request: fake.request });
    assert.equal(passed, true);
    assert.deepEqual(results.map(r => r.verb), VERBS, 'one line per verb, in the bridge order');
    assert.deepEqual(summary.skipped.sort(), ['close_module', 'open_module', 'publish', 'sc_api', 'sc_http', 'sc_web', 'studio_login']);
    assert.deepEqual(new Set(fake.seen.map(s => s.method)).has('publish'), false);
    for (const forbidden of ['open_module', 'close_module', 'publish', 'sc_api', 'sc_web', 'sc_http', 'studio_login']) assert.equal(fake.seen.some(s => s.method === forbidden), false, forbidden);
    assert.ok(fake.seen.every(s => s.target.port === 4516 && s.target.authorization === 'agent-key'));
    // The environment lease is read-only and closed again; the merge candidate does not exist; the snapshot stays in o11/prova.
    assert.deepEqual(fake.seen.filter(s => s.method === 'environment_session').map(s => s.params.operation), ['connect', 'modules', 'close']);
    assert.equal(fake.seen.find(s => s.method === 'environment_session').params.readOnly, true);
    assert.equal(fs.existsSync(fake.seen.find(s => s.method === 'merge_from_oml').params.foreign_path), false);
    assert.equal(path.dirname(fake.seen.find(s => s.method === 'snapshot_module').params.path), path.join(root, 'o11', 'prova'));
    // refresh_references (ninth release) names only a producer key no reference has: the handler runs and refreshes nothing.
    const refresh = fake.seen.find(s => s.method === 'refresh_references').params;
    assert.equal(refresh.producers, undefined); assert.match(refresh.producer_keys[0], /^ssam-prova-inexistente-/);
    assert.equal(summary.refused, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('with --host, --module and --publish every verb runs; studio_login only on a signed-in host; load errors fail the proof', async () => {
  const root = agentRoot();
  try {
    const signedIn = fakeRequest((method, params) => (method === 'sc_session' ? { success: true, data: { studio: { signedIn: true } } }
      : method === 'get_errors' ? { success: false, error: 'TypeLoadException: Could not load type ServiceStudio.Model.Foo' } : { success: true, data: {} }));
    const all = await run({ root, host: 'lab.example.com', module: 'Teste', publish: true }, { request: signedIn.request });
    assert.deepEqual(all.summary.skipped, []);
    assert.deepEqual(all.summary.loadErrors, ['get_errors']);
    assert.equal(all.passed, false);
    assert.deepEqual(all.results.map(r => r.verb), VERBS);
    assert.deepEqual(signedIn.seen.filter(s => ['open_module', 'publish', 'close_module'].includes(s.method)).map(s => s.method), ['open_module', 'publish', 'close_module']);
    assert.deepEqual(signedIn.seen.find(s => s.method === 'sc_api').params, { host: 'lab.example.com', surface: 'soap', operation: 'ListEspaces', args: {} });
    // 24th release: sc_http only reads the status through the Studio's own session (no window, nothing sent).
    assert.deepEqual(signedIn.seen.find(s => s.method === 'sc_http').params, { host: 'lab.example.com', action: 'status' });

    const notSignedIn = fakeRequest(method => (method === 'sc_session' ? { success: true, data: { studio: { signedIn: false } } } : { success: true, data: {} }));
    const partial = await run({ root, host: 'lab.example.com', module: null, publish: false }, { request: notSignedIn.request });
    assert.ok(partial.summary.skipped.includes('studio_login'));
    assert.equal(notSignedIn.seen.some(s => s.method === 'studio_login'), false, 'never opens the sign-in dialog');
    assert.equal(partial.passed, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('classify: success, a handler refusal and the load errors of a first JIT', () => {
  assert.equal(classify('ping', { success: true }).outcome, 'ok');
  assert.equal(classify('merge_from_oml', { success: false, executed: false, error: 'foreign_path must exist' }).outcome, 'refused');
  for (const error of ['MissingMethodException: Method not found', 'TypeLoadException: x', 'MissingFieldException: y', 'FileNotFoundException: Could not load file or assembly \'Z\''])
    assert.equal(classify('publish', { success: false, error }).outcome, 'load-error', error);
});
