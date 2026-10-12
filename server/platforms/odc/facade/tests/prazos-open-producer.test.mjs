// prazos B (production test of 2026-10-12, screens delivery 03:37-03:42 UTC): the producer FolhaPonto_CS was open, unchanged,
// in the same Service Studio, yet every consumer delivery captured it from the environment through the Studio's login
// (89.8 s, 31.2 s, 10.5 s and a 60 s cut by the Studio's WCF SendTimeout), twice without success, until the model bound
// the open producer by hand. Now o11_deliver binds an open, unmodified producer by a capture of its tab (no environment
// call), the cut that remains is typed (ENVIRONMENT_CALL_CUT, never "repeat"), and the hub log names the bridge method.
// Real McpServer over InMemoryTransport, a fake Anvil CLI, a fake bridge and temporary folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Cycle, deliverOutcome, cutOf, ENVIRONMENT_CALL_CUT } from '../o11-cycle.mjs';
import { openProducerBindings, tabRefusal } from '../o11-open-producer.mjs';
import { callVerbs } from '../agent-hub.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with { type: 'json' };

const WORDS = 'agora crie as telas';
const TASK = 'dc157d4d693b4d54b903b88b4aace008';
const ENV = 'andre-machado.outsystemscloud.com';

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prazos-open-producer-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority');
  for (const dir of [root, home, auth]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, port: 45998,
    studioDir: path.join(base, 'Studio'), authorityDir: auth }));
  const job = (name, document) => { const file = path.join(base, 'jobs', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(document)); return file; };
  let clock = Date.parse('2026-10-12T03:39:09.000Z');
  return { base, root, env, job, local: path.join(root, '.local'), work: path.join(root, '.local', 'work'), now: () => new Date(clock += 1000) };
}

// The Studio of the production test: FolhaPonto_UI and FolhaPonto_CS open in one window of the same environment.
function studio({ modified = false, environment = ENV, snapshotKey = null, failSnapshot = false, failList = false } = {}) {
  const calls = [];
  const tabs = [
    { name: 'FolhaPonto_UI', key: 'zzXaQ_DHeEypYZguIiJJEg', hasESpace: true, environment: ENV, isModified: false, hasOpenedActiveESpace: true, serverSilentMode: false, serverOperation: null, pendingDialogs: [], window: 0 },
    { name: 'FolhaPonto_CS', key: 'k0oq5kAcR0G5BKnWufyYDw', hasESpace: true, environment, isModified: modified, hasOpenedActiveESpace: true, serverSilentMode: false, serverOperation: null, pendingDialogs: [], window: 0 }];
  const client = {
    async ok(method, params = {}) {
      calls.push({ method, params });
      if (method === 'list_open_modules') { if (failList) throw Object.assign(new Error('bridge down'), { code: 'BRIDGE_UNREACHABLE' }); return { count: tabs.length, modules: tabs, environments: [ENV] }; }
      if (method === 'snapshot_module') {
        if (failSnapshot) throw Object.assign(new Error('Requested module identity is not open in any Studio tab'), { code: 'BRIDGE_ERROR' });
        fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, 'oml of ' + params.module_key);
        return { path: params.path, sha256: 'AB'.repeat(32), name: 'FolhaPonto_CS', key: snapshotKey ?? params.module_key, environment: ENV, snapshot_id: 's1' };
      }
      throw new Error('unexpected bridge call ' + method);
    },
  };
  return { client, calls };
}

async function serve(t, deps) {
  const server = new McpServer({ name: 'prazos-open-producer', version: '1.0.0' });
  registerO11Cycle(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'prazos-open-producer-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return args => client.callTool({ name: 'o11_deliver', arguments: args })
    .then(reply => reply.structuredContent ?? JSON.parse(reply.content[0].text === 'entregue' ? '{"ok":true,"result":"entregue"}' : reply.content[0].text));
}

const screensJob = s => s.job('telas.json', { ops: [{ op: 'reference', producer: 'FolhaPonto_CS', elements: ['IServerActionSignature:RegistrarBatida', 'IServerActionSignature:GetEspelhoMensal'] },
  { op: 'get', target: 'IMobileScreen:Ponto' }] });
const flag = (args, name) => args.flatMap((a, i) => a === name ? [args[i + 1]] : []);

test('an open, unmodified producer in the same Studio is bound by a capture of its tab: no environment capture', async t => {
  const s = sandbox(t); const bridge = studio();
  const runAnvil = fakeAnvil({ deliver: () => envelopes.delivered });
  const call = await serve(t, { root: s.root, env: s.env, lane: 'ss4', now: s.now, runAnvil, assertSelected: async () => {}, lastPublication: async () => null, bridge: bridge.client });
  const value = await call({ module: 'FolhaPonto_UI', job: screensJob(s), expectedEnvironment: ENV, authorize: WORDS });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.producersFromStudio, ['FolhaPonto_CS']);
  const args = runAnvil.calls.find(c => c.args[0] === 'deliver').args;
  assert.deepEqual(flag(args, '--capture-producer'), [], 'nothing is read from the environment for it');
  const [binding] = flag(args, '--producer');
  assert.match(binding, /^FolhaPonto_CS=.*producer-FolhaPonto_CS-\d{14}-[0-9a-f]{8}\.oml$/);
  assert.ok(fs.existsSync(binding.split('=')[1]));
  assert.ok(binding.split('=')[1].startsWith(path.join(s.local, 'snapshots')), 'a capture folder the kernel accepts as a producer source');
  // The tab is captured by its key, never selected or opened.
  assert.deepEqual(bridge.calls.map(c => c.method), ['list_open_modules', 'snapshot_module']);
  assert.equal(bridge.calls[1].params.module_key, 'k0oq5kAcR0G5BKnWufyYDw');
  const journal = fs.readFileSync(path.join(s.local, 'journal', 'o11_deliver.jsonl'), 'utf8');
  assert.match(journal, /"fromStudio":\["FolhaPonto_CS"\]/);
});

test('a producer with unsaved changes, in another environment or whose capture fails keeps the environment capture (C27)', async t => {
  for (const [options, reason] of [[{ modified: true }, 'modified'], [{ environment: 'other.outsystemscloud.com' }, 'not-open'], [{ failSnapshot: true }, 'capture-failed'],
    [{ failList: true }, 'not-listed'], [{ snapshotKey: 'another-key' }, 'another-module']]) {
    const s = sandbox(t); const bridge = studio(options);
    const runAnvil = fakeAnvil({ deliver: () => envelopes.delivered });
    const call = await serve(t, { root: s.root, env: s.env, lane: 'ss4', now: s.now, runAnvil, assertSelected: async () => {}, lastPublication: async () => null, bridge: bridge.client });
    const value = await call({ module: 'FolhaPonto_UI', job: screensJob(s), expectedEnvironment: ENV, authorize: WORDS });
    assert.equal(value.ok, true, reason);
    assert.equal(value.producersFromStudio, undefined, reason);
    const args = runAnvil.calls.find(c => c.args[0] === 'deliver').args;
    assert.deepEqual(flag(args, '--capture-producer'), ['FolhaPonto_CS'], reason);
    assert.deepEqual(flag(args, '--producer'), [], reason);
    const skipped = await openProducerBindings(['FolhaPonto_CS'], { bridge: () => studio(options).client, local: s.local, consumer: 'FolhaPonto_UI', environment: ENV });
    assert.deepEqual(skipped.skipped, [{ producer: 'FolhaPonto_CS', reason }]);
  }
});

test('explicit choices of the call are kept: producers "published" and captureProducers still capture from the environment', async t => {
  const s = sandbox(t); const bridge = studio();
  const runAnvil = fakeAnvil({ deliver: () => envelopes.delivered });
  const call = await serve(t, { root: s.root, env: s.env, lane: 'ss4', now: s.now, runAnvil, assertSelected: async () => {}, lastPublication: async () => null, bridge: bridge.client,
    downloadPublished: async () => { throw new Error('no theme here'); } });
  await call({ module: 'FolhaPonto_UI', job: screensJob(s), producers: 'published', authorize: WORDS });
  await call({ module: 'FolhaPonto_UI', job: screensJob(s), captureProducers: ['FolhaPonto_CS'], authorize: WORDS });
  for (const run of runAnvil.calls.filter(c => c.args[0] === 'deliver')) {
    assert.deepEqual(flag(run.args, '--capture-producer'), ['FolhaPonto_CS']);
    assert.deepEqual(flag(run.args, '--producer'), []);
  }
  assert.equal(bridge.calls.filter(c => c.method === 'snapshot_module').length, 0);
});

test('tabRefusal and the system producer: only a settled, unmodified tab of the same environment stands for its producer', async () => {
  const tab = { key: 'k', environment: ENV, isModified: false, hasOpenedActiveESpace: true, serverSilentMode: false, serverOperation: null, pendingDialogs: [] };
  assert.equal(tabRefusal(tab, ENV), null);
  assert.equal(tabRefusal({ ...tab, isModified: true }, ENV), 'modified');
  assert.equal(tabRefusal({ ...tab, isModified: undefined }, ENV), 'modified', 'an older bridge that does not say is not trusted');
  assert.equal(tabRefusal({ ...tab, serverOperation: { kind: 'publish' } }, ENV), 'server-operation');
  assert.equal(tabRefusal({ ...tab, pendingDialogs: [{ kind: 'DependenciesDialog' }] }, ENV), 'dialog');
  assert.equal(tabRefusal({ ...tab, hasOpenedActiveESpace: false }, ENV), 'opening');
  assert.equal(tabRefusal({ ...tab, environment: 'b.example' }, ENV), 'other-environment');
  const none = await openProducerBindings(['System=(System)'], { bridge: () => { throw new Error('never asked'); }, local: os.tmpdir() });
  assert.deepEqual(none, { bound: {}, fromStudio: [], skipped: [{ producer: 'System=(System)', reason: 'environment-producer' }] });
});

// The kernel task of the 03:39:09 delivery, as it would answer now (EnvironmentCut.cs): typed, nothing written.
const cutState = { taskId: TASK, module: 'FolhaPonto_UI', delivered: false, writeState: 'not-sent', stage: 'producer-signatures', code: ENVIRONMENT_CALL_CUT,
  error: 'EnvironmentCallCutException: The Service Studio\'s own call to ' + ENV + ' (environment operation modules) for the published signature of FolhaPonto_CS timed out after 60 s: '
    + 'BridgeCallException: environment_session: TimeoutException: O canal de solicitação atingiu o tempo limite ao tentar o envio após 00:01:00.',
  cut: { what: 'the published signature', stage: 'producer-signatures', producer: 'FolhaPonto_CS', host: ENV, operation: 'modules', cause: 'timeout', afterSeconds: 60,
    elapsedSeconds: 60, cutBy: 'service-studio', writeState: 'not-sent' } };

test('ENVIRONMENT_CALL_CUT answers what was cut, that nothing was written and when to deliver again, never a blind retry', async t => {
  const s = sandbox(t);
  const job = screensJob(s);
  const value = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: cutState } }, { trackId: 't1', work: s.work, job, taskId: null, since: 0,
    input: { module: 'FolhaPonto_UI', expectedEnvironment: ENV } });
  assert.equal(value.code, ENVIRONMENT_CALL_CUT);
  assert.equal(value.outcome, 'refused');
  assert.equal(value.writeState, 'not-sent');
  assert.equal(value.retry, 'after-network');
  assert.deepEqual(value.cut, cutState.cut);
  assert.match(value.error, /timed out after 60 s/);
  assert.match(value.error, /outside SSAM; nothing was captured, applied or merged/);
  assert.doesNotMatch(value.error, /O canal de solicita/, 'the raw WCF text stays in the task, not in the answer');
  assert.equal(value.continuation.tool, 'o11_deliver');
  assert.equal(value.continuation.arguments.closePrevious, TASK);
  assert.equal(value.continuation.arguments.resume, undefined);
  assert.match(value.continuation.why, /Não repita às cegas/);
  assert.match(value.continuation.why, /FolhaPonto_CS aberto e sem alterações/);
  // Through the tool: the same answer, with the job named for the next call.
  const runAnvil = fakeAnvil({ deliver: () => ({ ok: false, command: 'deliver', data: cutState }) });
  const call = await serve(t, { root: s.root, env: s.env, lane: 'ss4', now: s.now, runAnvil, assertSelected: async () => {}, lastPublication: async () => null,
    bridge: studio({ modified: true }).client });
  const answer = await call({ module: 'FolhaPonto_UI', job, expectedEnvironment: ENV, authorize: WORDS });
  assert.equal(answer.code, ENVIRONMENT_CALL_CUT);
  assert.ok(answer.job && answer.nextBasedOn);
});

test('a job the preflight refused keeps PREFLIGHT_REFUSED and carries the cut that stopped the other phases', async t => {
  const s = sandbox(t);
  const state = { ...cutState, code: 'PREFLIGHT_REFUSED', stage: 'preflight', verifyRan: false,
    verifyReason: 'the delivery stopped before the apply over the live module (EnvironmentCallCutException: ...): only the job was read',
    problems: [{ op: 71, pointer: '/ops/71/html', code: 'HTML_INVALID', severity: 'error', message: 'a <button> needs text', fix: 'x', phase: 'preflight' }] };
  const value = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: state } }, { trackId: 't1', work: s.work, job: screensJob(s), taskId: null, since: 0, input: { module: 'FolhaPonto_UI' } });
  assert.equal(value.code, 'PREFLIGHT_REFUSED');
  assert.equal(value.cut.cause, 'timeout');
  assert.equal(value.problems[0].code, 'HTML_INVALID');
  assert.equal(cutOf(null), null);
});

test('the hub log names the bridge method and the environment operation of an o11.bridge call, never a value', () => {
  assert.deepEqual(callVerbs('o11.bridge', { method: 'environment_session', operation: 'modules' }), { method: 'environment_session', operation: 'modules' });
  assert.deepEqual(callVerbs('o11.bridge', { method: 'snapshot_module', operation: 'x' }), { method: 'snapshot_module' });
  assert.deepEqual(callVerbs('o11.bridge', { method: 'C:\\Users\\x', operation: 'modules' }), {});
  assert.deepEqual(callVerbs('o11.bridge', { method: 'environment_session', operation: 'lease 123 secret' }), { method: 'environment_session' });
  assert.deepEqual(callVerbs('file.get', { method: 'x' }), {});
});

// The time budget of an environment read: the local path waits 330 s (Program.cs BridgeClient(port, 330)); hosted, the relay
// now asks the agent for the same instead of its 120 s wire default.
test('the relay gives an environment_session the local path\'s 330 s on the agent; other methods keep their wire budget', async t => {
  const { randomBytes } = await import('node:crypto');
  const { bridgeRequest } = await import('../o11-bridge.mjs');
  const { AgentExecutor } = await import('../hosted/agent-executor.mjs');
  const { RELAY_BUDGET_MS } = await import('../hosted/o11-relay.mjs');
  const { fakeAgentLink, hostedDirs, cleanupHostedDirs } = await import('./fixtures/fake-agent-link.mjs');
  t.after(cleanupHostedDirs);
  const dirs = hostedDirs(os.tmpdir());
  const key = randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(dirs.workspace, 'state', 'relay-authority', 'bridge.key'), key);
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, handlers: { 'o11.bridge': params => ({ reply: { success: true, data: { echo: params.method } } }) } });
  const executor = new AgentExecutor({ link, workspace: dirs.workspace, o11: { studioDir: 'C:\Kernel', lane: 'ss4' }, log: () => {} });
  await executor.start();
  t.after(() => executor.close());
  const port = executor.relayPort();
  await bridgeRequest({ port, authorization: key }, 'environment_session', { operation: 'modules', lease: 'l1' });
  await bridgeRequest({ port, authorization: key }, 'get_active_module', {});
  assert.equal(RELAY_BUDGET_MS.environment_session, 330000);
  const [environment, active] = link.calls;
  assert.equal(environment.params.timeoutMs, 330000);
  assert.equal(environment.options.timeoutMs, 330000 + 60000, 'the hub keeps its margin over the agent budget');
  assert.equal(active.params.timeoutMs, undefined);
});
