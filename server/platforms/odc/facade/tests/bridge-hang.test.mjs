// The bridge-hang family (2026-10-22): a merge queued in the ODC Studio did not run for 30 minutes (the tab never became
// idle), the facade gave up at 10 min while the bridge waited 15, the bridge's late answer hit a closed pipe and its
// command server ended; every later studio_attach answered attached:true (the startup hook ran, the DLL was already
// loaded) while every pipe command answered BRIDGE_NOT_ATTACHED. The rules proven here, offline (fake client, fake
// Studios, a temporary lab; no process, no pipe, no bridge):
//   1. attach answers attached:true only after a status round trip on the pipe; otherwise a refusal naming the cause
//      (pipe absent / busy / silent) and the next call.
//   2. ssam_connect never counts a Studio as attached on the hook's word or on a probe that got no answer.
//   3. the client waits for a merge longer than the bridge's own deadline, so the bridge's answer is read, never lost.
//   4. a merge whose answer did not come ends MERGE_TIMEOUT with whether it started, its evidence and the next call.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { attach, busyEvidence, client, guardDeliveryStep } from '../lib.mjs';
import { connectAll } from '../studio-connect.mjs';
import * as pipe from '../odc-pipe.mjs';
import { afterMergeTimeout, deliverKernel, MERGE_TIMEOUT_NEXT, MERGE_TIMEOUT_NEXT_PASS_2 } from '../kernel-delivery.mjs';
import { compactDelivery } from '../responses.mjs';
import { AgentExecutor } from '../hosted/agent-executor.mjs';

const DLL = { path: 'C:\\fake\\ODC3.Bridge.v32.dll', version: 'v32' };
const pipeError = (message, code, sent) => Object.assign(new Error(message), { code, sent });
const absent = () => pipeError('The ODC bridge v32 is not attached to ODC Studio 77 (no pipe for 10 s); call studio_attach', 'BRIDGE_NOT_ATTACHED', false);

async function attachWith(statusAnswer, hook = { ok: true, attached: true }) {
  let clock = 0; const calls = [];
  const call = async (pid, args) => {
    calls.push(args[0]);
    if (args[0] === 'attach') return hook;
    const next = typeof statusAnswer === 'function' ? statusAnswer() : statusAnswer;
    if (next instanceof Error) throw next;
    return next;
  };
  const result = await attach(77, { call, findPid: async pid => pid, dll: DLL, sleep: async ms => { clock += ms; }, now: () => clock });
  return { result, calls, clock };
}

test('attach: the hook ran but the pipe never answers status -> attached:false, BRIDGE_SILENT, cause pipe-absent, next call', async () => {
  const { result } = await attachWith(absent);
  assert.equal(result.ok, false);
  assert.equal(result.attached, false, 'never attached:true without a round trip');
  assert.equal(result.hookApplied, true);
  assert.equal(result.code, 'BRIDGE_SILENT');
  assert.equal(result.cause, 'pipe-absent');
  assert.match(result.error, /already loaded/);
  assert.match(result.error, /reopen the ODC Studio/);
  assert.equal(result.continuation?.tool, 'studio_status');
  assert.equal(result.continuation?.arguments?.pid, 77);
});

test('attach: a pipe that accepts but never answers is a hung bridge (cause bridge-hung); a busy pipe names the command in flight', async () => {
  let r = await attachWith(() => pipeError('ODC bridge status did not answer within 10000 ms; the native operation may still run', 'PIPE_REPLY_TIMEOUT', true));
  assert.deepEqual([r.result.ok, r.result.attached, r.result.code, r.result.cause], [false, false, 'BRIDGE_SILENT', 'bridge-hung']);
  r = await attachWith(() => pipeError('The ODC bridge v32 of ODC Studio 77 stayed busy for 10 s; a command is still running there', 'BRIDGE_BUSY', false));
  assert.deepEqual([r.result.ok, r.result.attached, r.result.code, r.result.cause], [false, false, 'BRIDGE_SILENT', 'pipe-busy']);
  assert.match(r.result.error, /never repeat a write/i);
});

test('attach: a status that answers is the only attached:true; a refused hook stays refused', async () => {
  let r = await attachWith({ ok: true, bridge: 'v32' });
  assert.deepEqual([r.result.ok, r.result.attached, r.result.status.ok], [true, true, true]);
  assert.deepEqual(r.calls, ['attach', 'status']);
  r = await attachWith({ ok: true }, { ok: false, error: 'hook refused' });
  assert.deepEqual([r.result.ok, r.result.attached], [false, false]);
});

function odcOnly(odc) {
  return { served: ['odc'], odc: { processes: async () => [{ pid: 200 }], ...odc } };
}

test('ssam_connect: a Studio counts as attached only on a status round trip, never on the hook word alone', async () => {
  // The old attach shape: the hook said attached:true, the status carried only an error.
  const value = await connectAll({ lane: 'odc' }, odcOnly({
    probe: async () => ({ attached: false, reply: null }),
    attach: async () => ({ ok: true, attached: true, status: { error: 'The ODC bridge v32 is not attached to ODC Studio 200 (no pipe for 10 s); call studio_attach' } }),
  }));
  const entry = value.studios.find(s => s.pid === 200);
  assert.equal(entry.attached, false, JSON.stringify(entry));
  assert.equal(value.ok, false);
  assert.match(entry.error, /not attached|did not answer/);
});

test('ssam_connect: a probe that connected but got no answer is a silent bridge, not an attached one', async () => {
  let attached = 0;
  const value = await connectAll({ lane: 'odc' }, odcOnly({
    probe: async () => ({ attached: true, busy: false, reply: null, error: 'ODC bridge auth-status did not answer within 8000 ms' }),
    attach: async () => { attached += 1; return { ok: true, attached: true, status: { ok: true } }; },
  }));
  const entry = value.studios.find(s => s.pid === 200);
  assert.equal(entry.attached, false, JSON.stringify(entry));
  assert.equal(entry.code, 'BRIDGE_SILENT');
  assert.equal(attached, 0, 'a loaded, silent bridge is never attached again (a loaded DLL is never replaced)');
  assert.equal(value.ok, false);
});

test('the client waits for a merge longer than the bridge itself does, so the bridge answer is always read', () => {
  const { replyTimeoutMs } = pipe;
  // The bridge's own merge deadline (StartupHook.cs Serve: 15 min); exported by odc-pipe.mjs so both sides read one number.
  const BRIDGE_COMMAND_TIMEOUT_MS = pipe.BRIDGE_COMMAND_TIMEOUT_MS ?? { merge: 15 * 60 * 1000 };
  assert.ok(replyTimeoutMs(['merge', 'manifest.json']) > BRIDGE_COMMAND_TIMEOUT_MS.merge, 'client deadline after the bridge deadline');
  assert.ok(replyTimeoutMs(['reconcile-merge', 'manifest.json']) > BRIDGE_COMMAND_TIMEOUT_MS.merge);
  assert.equal(replyTimeoutMs(['status']), 10 * 60 * 1000, 'other commands keep the 10 min of the .NET client');
});

function deliveryWithMergeTimeout(t, { started = false, returned = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hang-deliver-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'job.json'), '{"ops":[]}');
  const calls = [];
  const manifestDir = path.join(root, 'attempt', 'delivery');
  const evidence = path.join(manifestDir, 'evidence');
  const studio = async ([step]) => {
    calls.push(step);
    if (step === 'snapshot') return { ok: true, path: path.join(root, 'base.oml'), sha256: 'HASH', host: 'fixture.test', moduleKey: 'K' };
    if (step === 'merge') {
      fs.mkdirSync(evidence, { recursive: true });
      if (started) fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: 'now', pid: 5150 }));
      if (returned) fs.writeFileSync(path.join(evidence, 'native-return.json'), JSON.stringify({ outcome: 'Merged', publishInvoked: false }));
      throw pipeError('ODC bridge merge did not answer within 960000 ms; the native operation may still run: read its evidence before any retry', 'PIPE_REPLY_TIMEOUT', true);
    }
    return { ok: true };
  };
  const deps = { root, nextLabDir: () => path.join(root, 'attempt'), journal: () => {}, cache: null, guide: null, prefetch: () => {}, studio,
    apply: async () => ({ ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }),
    prepareManifest: async () => {
      fs.mkdirSync(manifestDir, { recursive: true });
      fs.writeFileSync(path.join(manifestDir, 'candidate.oml'), 'candidate');
      const manifest = path.join(manifestDir, 'manifest.json');
      fs.writeFileSync(manifest, JSON.stringify({ module: 'Fixture', moduleKey: 'K', candidatePath: path.join(manifestDir, 'candidate.oml'), candidateSha256: 'C', evidenceDir: evidence }));
      return { ok: true, manifest };
    } };
  return { calls, deps, evidence, input: { module: 'Fixture', feature: 'bridge-hang', job: 'job.json', owners: ['Options'], changes: ['Change'] } };
}

test('studio_deliver: a merge that never answered and never started ends MERGE_TIMEOUT with started:false and studio_status next', async t => {
  const f = deliveryWithMergeTimeout(t);
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MERGE_TIMEOUT');
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.timeout?.mergeStarted, false);
  assert.equal(result.timeout?.nativeReturned, false);
  assert.equal(result.timeout?.evidence, f.evidence);
  assert.match(result.error, /had not started/);
  assert.equal(result.continuation?.tool, 'studio_status');
  assert.match(result.continuation.why, /never repeat/i);
  assert.equal(f.calls.filter(c => c === 'merge').length, 1, 'never merged twice');
});

test('studio_deliver: a merge that started but never answered ends MERGE_TIMEOUT with started:true, still uncertain', async t => {
  const f = deliveryWithMergeTimeout(t, { started: true });
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.code, 'MERGE_TIMEOUT');
  assert.equal(result.timeout?.mergeStarted, true);
  assert.equal(result.timeout?.nativeReturned, false);
  assert.match(result.error, /started the native merge at/);
  assert.equal(result.continuation?.tool, 'studio_status');
});

test('every client waits past the bridge: every command of the one table, and the wait the call asks for', () => {
  const { BRIDGE_DEADLINE_TABLE: table, bridgeDeadlineMs, replyTimeoutMs } = pipe;
  for (const command of [...Object.keys(table.commandSeconds), 'snapshot', 'anything-else'])
    assert.ok(replyTimeoutMs([command, 'x']) > bridgeDeadlineMs([command, 'x']), command + ': the client cuts first');
  // The portão cases: a portal upload (13 min, the client stopped at 10), a publish that waits (20, the client 10 or the wait + 1).
  assert.ok(replyTimeoutMs(['portal-upload', 'r.json']) > 13 * 60 * 1000);
  assert.ok(replyTimeoutMs(['publish', 'm.json', '--wait']) > bridgeDeadlineMs(['publish', 'm.json', '--wait']));
  assert.ok(replyTimeoutMs(['publish', 'm.json', '--wait', '5']) > bridgeDeadlineMs(['publish', 'm.json', '--wait', '5']));
  assert.ok(replyTimeoutMs(['wait', 'idle', '30']) > bridgeDeadlineMs(['wait', 'idle', '30']));
  // A queued job gives up long before any client: its refusal is always read.
  assert.ok(table.queueStartSeconds * 1000 < bridgeDeadlineMs(['merge', 'm.json']));
  assert.ok(table.queueStartSeconds * 1000 < 600000, 'the 10 minutes of an agent that does not read timeoutMs');
});

test('the bridge, its .NET client and the facade read one table, and its samples hold on this side', () => {
  const { BRIDGE_DEADLINE_TABLE: table, bridgeDeadlineMs, replyTimeoutMs } = pipe;
  assert.ok(table.samples.length > 5);
  for (const { args, bridgeMs, clientMs } of table.samples) {
    assert.equal(bridgeDeadlineMs(args), bridgeMs, args.join(' '));
    assert.equal(replyTimeoutMs(args), clientMs, args.join(' '));
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = name => fs.readFileSync(path.join(here, '..', '..', 'studio', 'bridge', name), 'utf8');
  for (const project of ['Bridge.csproj', path.join('client', 'Client.csproj'), path.join('tests', 'Bridge.Tests.csproj')])
    assert.match(source(project), /<EmbeddedResource Include="[^"]*facade\\bridge-deadlines\.json" LogicalName="bridge-deadlines\.json" \/>/, project);
  assert.match(source('StartupHook.cs'), /BridgeDeadlines\.For\(command, argument\)/);
  assert.doesNotMatch(source('StartupHook.cs'), /TimeSpan\.FromMinutes\(15\)/, 'no second copy of the merge deadline');
  assert.match(source(path.join('client', 'Program.cs')), /BridgeDeadlines\.ClientWait\(/);
  assert.doesNotMatch(source(path.join('client', 'Program.cs')), /FromMinutes\(10\)/);
});

test('the hosted server sends the reply deadline to the agent, and covers it', async () => {
  const seen = [];
  const link = { call: async (kind, params, options) => { seen.push({ kind, params, options }); return { line: '{"ok":true}', paths: [] }; }, info: () => ({ pack: { odcBridge: 'v101' }, kernel: { odcBridge: 'v101' } }) };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hang-hosted-'));
  try {
    const executor = new AgentExecutor({ link, workspace: root, relayAuthorityDir: path.join(root, 'relay') });
    await executor.pipe({ pid: 7, version: 'v101', args: ['merge', 'x.json'] }, {}).catch(() => {});
    await executor.pipe({ pid: 7, version: 'v101', args: ['status', 'brief'] }, {});
    const status = seen.find(c => c.kind === 'odc.pipe' && c.params.args[0] === 'status');
    assert.equal(status.params.timeoutMs, pipe.replyTimeoutMs(['status', 'brief']));
    assert.ok(status.options.timeoutMs > status.params.timeoutMs, 'the server waits past the agent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hosted, a reply the agent cut brings the evidence back; when it cannot, the error says so and nothing else runs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hang-pull-'));
  try {
    const executor = new AgentExecutor({ link: { call: async () => ({}), info: () => null }, workspace: root, relayAuthorityDir: path.join(root, 'relay') });
    let pulled = 0;
    assert.equal(await executor.evidenceOf({ evidence: async () => { pulled++; return true; } }), true);
    assert.equal(pulled, 1);
    assert.equal(await executor.evidenceOf({ evidence: async () => { throw new Error('agent gone'); } }), false);
    assert.equal(await executor.evidenceOf({ evidence: () => new Promise(() => {}) }, 20), false, 'a pull that hangs never holds the answer');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('hosted, the whole road on the real staging: a reply the agent cut pulls the folder and the evidence of the manifest', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hang-staging-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'odc', 'lab', 'a', 'delivery'); const evidence = path.join(root, 'odc', 'lab', 'a', 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', module: 'M', evidenceDir: evidence }));
  const pulls = [];
  const mirror = { workspace: root, link: { supports: () => true }, output: p => 'agent:' + path.relative(root, p).replaceAll('\\', '/'), inputPlan: async () => ({ target: '', puts: [] }), missingPlan: () => [], putMany: async () => {},
    fromAgent: p => p, pullDir: async agentDir => { pulls.push(agentDir); return { listed: [], skipped: [] }; } };
  const links = [];
  const executor = new AgentExecutor({ link: { info: () => null, call: async (kind, params) => { links.push(kind); if (kind === 'odc.pipe') throw Object.assign(new Error('The Studio may still be executing'), { code: 'PIPE_REPLY_TIMEOUT', executed: null }); return { processes: [] }; } }, workspace: root, relayAuthorityDir: path.join(root, 'relay') });
  executor.mirror = mirror;
  await assert.rejects(executor.pipe({ pid: 7, version: 'v101', args: ['merge', manifest] }, {}), error => {
    assert.equal(error.code, 'PIPE_REPLY_TIMEOUT');
    assert.equal(error.evidenceSeen, true, 'the evidence came back');
    return true;
  });
  assert.deepEqual(pulls.map(p => p.replace(/^agent:/, '')), ['odc/lab/a/delivery', 'odc/lab/a/evidence'], 'the folder and the evidence of the manifest');
  // A transport loss takes the same road; a call never delivered pulls nothing.
  for (const code of ['PIPE_TRANSPORT', 'PIPE_NO_REPLY']) {
    pulls.length = 0;
    executor.link.call = async kind => { if (kind === 'odc.pipe') throw Object.assign(new Error('lost on the way'), { code, executed: null }); return { processes: [] }; };
    await assert.rejects(executor.pipe({ pid: 7, version: 'v101', args: ['merge', manifest] }, {}), error => { assert.equal(error.code, code); assert.equal(error.evidenceSeen, true, code); return true; });
    assert.equal(pulls.length, 2, code + ' brings the evidence back too');
  }
  // The answer came and its evidence could not come with it: the error says so, and the answer affirms nothing.
  const pullDir = mirror.pullDir;
  mirror.pullDir = async () => { throw new Error('agent gone'); };
  executor.link.call = async kind => kind === 'odc.pipe' ? { line: JSON.stringify({ ok: true, merged: true, strictlyEqual: true }) } : { processes: [] };
  await assert.rejects(executor.pipe({ pid: 7, version: 'v101', args: ['merge', manifest] }, {}), error => { assert.equal(error.evidenceSeen, false, 'the evidence did not come back'); return true; });
  mirror.pullDir = pullDir;
  pulls.length = 0;
  executor.link.call = async kind => { if (kind === 'odc.pipe') throw Object.assign(new Error('never delivered'), { code: 'AGENT_DISCONNECTED', executed: false }); return { processes: [] }; };
  await assert.rejects(executor.pipe({ pid: 7, version: 'v101', args: ['merge', manifest] }, {}), error => error.sent === false && error.evidenceSeen === undefined);
  assert.deepEqual(pulls, []);
});

test('studio_deliver hosted, reply cut and no evidence: unknown, no claim about the merge, never the same delivery', async t => {
  const f = deliveryWithMergeTimeout(t, { started: true }); // the merge IS running on the agent, and this server cannot see it
  const studio = f.deps.studio;
  f.deps.studio = async args => {
    if (args[0] !== 'merge') return studio(args);
    throw Object.assign(new Error('ODC bridge merge did not answer'), { code: 'PIPE_REPLY_TIMEOUT', sent: true, evidenceSeen: false });
  };
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.code, 'MERGE_TIMEOUT');
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.timeout.mergeStarted, 'unknown');
  assert.equal(result.timeout.nativeReturned, 'unknown');
  assert.equal(result.timeout.evidenceSeen, false);
  assert.doesNotMatch(result.error, /had not started|may still run later/);
  assert.match(result.error, /unknown/);
  assert.deepEqual(result.timeout.now, { state: 'unknown' });
  assert.notEqual(result.merged, true);
  assert.equal(result.continuation.tool, 'studio_status');
});

test('a busy answer of the bridge reads like a busy pipe: nothing sent, the running command named', async t => {
  const line = JSON.stringify({ ok: false, code: 'BRIDGE_BUSY', outcome: 'gate_refused', gate: 'studio_busy', executed: false, busyCommand: 'merge', busy: { command: 'merge', since: '2026-10-30T18:51:11Z', module: 'Fixture' }, error: "Command 'merge' is still running" });
  // Through the pipe of this process.
  const name = 'vbusy' + process.pid + Date.now();
  const server = net.createServer(socket => socket.on('data', () => socket.end(line + '\n')));
  await new Promise(resolve => server.listen(pipe.pipeName(name, 77), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(pipe.pipeCall(77, name, ['snapshot', 'M'], { connectMs: 30 }), error => {
    assert.equal(error.code, 'BRIDGE_BUSY'); assert.equal(error.sent, false); assert.equal(error.busy.command, 'merge');
    assert.match(error.message, /stayed busy for/); assert.match(error.message, /merge of Fixture since 2026-10-30T18:51:11Z/);
    assert.doesNotMatch(error.message, /restart/i);
    return true;
  });
  // Through the agent or the .NET client: the line comes back as the answer.
  await assert.rejects(client(77, ['snapshot', 'M'], { env: {}, version: name, call: async () => line }), error => error.code === 'BRIDGE_BUSY' && error.sent === false);
});

test('past its deadline, a busy answer says what ends the command, through the error and the status from evidence', async t => {
  const advice = 'It is past its deadline. If it never ends, only restarting ODC Studio ends it: the person closes and reopens the whole application.';
  const error = pipe.busyError('v101', 77, 10000, { command: 'merge', since: 'now', overran: true, advice });
  assert.match(error.message, /only restarting ODC Studio ends it/);
  assert.equal(pipe.busyError('v101', 77, 10000, { command: 'merge', since: 'now', overran: false }).message.includes('restarting'), false, 'in time: nothing about a restart');
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hang-advice-'));
  t.after(() => fs.rmSync(lab, { recursive: true, force: true }));
  const status = busyEvidence({ pid: 77, error, registry: new Map(), lab });
  assert.match(status.note, /only restarting ODC Studio ends it/);
});

test('pass 2 of a merge order that never left is not not-sent: pass 1 is in the module, and its repair is the next call', async t => {
  const f = deliveryWithMergeTimeout(t);
  let merges = 0;
  const studio = f.deps.studio;
  f.deps.studio = async args => {
    if (args[0] !== 'merge') return studio(args);
    if (++merges === 1) return { ok: true, merged: true, strictlyEqual: true, equivalence: 'strict' };
    throw pipe.busyError('v101', 77, 10000, { command: 'publish', since: 'now' });
  };
  f.deps.mergeOrder = async ({ output }) => {
    const firstPass = path.join(output, 'merge-order-first-pass.oml'); fs.writeFileSync(firstPass, 'first');
    return { ok: true, deferred: [{ key: 'k', objectKey: 'o', element: 'E', property: 'DefaultValue', value: '1', baseValue: null }], firstPass, firstPassSha256: null, contentPreviewSupported: true, contentPreview: { accepted: true } };
  };
  const prepare = f.deps.prepareManifest;
  f.deps.prepareManifest = async input => { const made = await prepare(input); fs.mkdirSync(input.output, { recursive: true }); const manifest = path.join(input.output, 'manifest.json'); fs.copyFileSync(made.manifest, manifest); return { ok: true, manifest }; };
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.merged, true);
  assert.equal(result.outcome, 'incomplete');
  assert.notEqual(result.outcome, 'not-sent');
  assert.equal(merges, 2);
  assert.equal(result.mergeOrder.failedPass, 2);
  assert.equal(result.continuation.tool, 'studio_deliver');
  assert.match(result.continuation.arguments.job, /repair\.json$/);
});

test('a merge the bridge never took is no doubt: not-sent, no uncertain, studio_status next', async t => {
  const f = deliveryWithMergeTimeout(t);
  const studio = f.deps.studio;
  f.deps.studio = async args => { if (args[0] === 'merge') throw pipe.busyError('v101', 77, 10000, { command: 'publish', since: 'now' }); return studio(args); };
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BRIDGE_BUSY');
  assert.equal(result.outcome, 'not-sent');
  assert.equal(result.busy.command, 'publish');
  assert.notEqual(result.merged, true);
  assert.equal(result.continuation?.tool, 'studio_status');
  const guarded = await guardDeliveryStep('merge', async () => { throw pipe.busyError('v101', 77, 10000); });
  assert.deepEqual([guarded.ok, guarded.code, guarded.outcome], [false, 'BRIDGE_BUSY', 'not-sent']);
});

test('studio_deliver: a merge past the bridge\'s own deadline ends MERGE_TIMEOUT cutBy bridge, with what a session may do next', async t => {
  const f = deliveryWithMergeTimeout(t, { started: true });
  const studio = f.deps.studio;
  f.deps.studio = async args => {
    if (args[0] !== 'merge') return studio(args);
    await studio(args).catch(() => {}); // writes the evidence of a merge that started
    return { ok: false, code: 'MERGE_TIMEOUT', outcome: 'uncertain', gate: 'studio_busy', deadlineSeconds: 900, error: "Command 'merge' is still running after 00:15:00; it was not cancelled. Poll status; do not retry." };
  };
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MERGE_TIMEOUT');
  assert.equal(result.outcome, 'uncertain');
  assert.equal(result.timeout?.cutBy, 'bridge');
  assert.equal(result.timeout?.deadlineSeconds, 900);
  assert.equal(result.timeout?.mergeStarted, true);
  assert.equal(result.timeout?.nativeReturned, false);
  assert.ok(result.timeout?.next?.some(n => /reconcile:true/.test(n.then)), 'what to do when it merged');
  assert.ok(result.timeout?.next?.some(n => /BRIDGE_BUSY/.test(n.then)), 'what to do while it runs');
  assert.equal(result.continuation?.tool, 'studio_status');
});

test('after a merge past a deadline, the evidence says a state and nothing else: only the proof that the native merge never took the candidate says it did not run', () => {
  const flags = ['notStarted', 'started', 'returned', 'ended', 'busy'];
  const didNotRun = ['not-started', 'ended-before-the-merge'];
  for (let bits = 0; bits < 32; bits++) {
    const state = Object.fromEntries(flags.map((name, i) => [name, !!(bits & (1 << i))]));
    const verdict = afterMergeTimeout(state);
    assert.deepEqual(Object.keys(verdict), ['state'], 'a state, never a permission: ' + JSON.stringify(state));
    if (state.started) assert.ok(!didNotRun.includes(verdict.state), 'merge-started.json: it may have run, ' + JSON.stringify(state));
    if (!state.notStarted && !state.ended) assert.ok(!didNotRun.includes(verdict.state), 'no sign that it ended, ' + JSON.stringify(state));
    if (state.busy && !state.notStarted) assert.ok(!didNotRun.includes(verdict.state), 'still running, ' + JSON.stringify(state));
  }
  assert.deepEqual(afterMergeTimeout({ started: true, ended: true }), { state: 'may-be-merged' }, 'the native merge threw after the hand-off');
  assert.deepEqual(afterMergeTimeout({ ended: true }), { state: 'ended-before-the-merge' });
  assert.deepEqual(afterMergeTimeout({ notStarted: true }), { state: 'not-started' });
  assert.deepEqual(afterMergeTimeout({}), { state: 'unknown' });
});

test('a session that follows timeout.next never sends the delivery twice: no rule repeats it, and the server checks a new one', async t => {
  const f = deliveryWithMergeTimeout(t, { started: true });
  const studio = f.deps.studio;
  f.deps.studio = async args => {
    if (args[0] !== 'merge') return studio(args);
    await studio(args).catch(() => {});
    // The native merge threw after the hand-off: merge-started.json and last-error.json, no native-return.json.
    fs.writeFileSync(path.join(f.evidence, 'last-error.json'), JSON.stringify({ ok: false, error: 'Native call failed', handedOff: true }));
    return { ok: false, code: 'MERGE_TIMEOUT', outcome: 'uncertain', gate: 'studio_busy', deadlineSeconds: 900, error: "Command 'merge' is still running after 00:15:00; it was not cancelled." };
  };
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.code, 'MERGE_TIMEOUT');
  assert.equal(result.outcome, 'uncertain');
  assert.notEqual(result.merged, true);
  assert.deepEqual(result.timeout.now, { state: 'may-be-merged' });
  assert.equal(f.calls.filter(c => c === 'merge').length, 1, 'never merged twice');
  for (const rule of [...result.timeout.next, ...MERGE_TIMEOUT_NEXT, ...MERGE_TIMEOUT_NEXT_PASS_2]) {
    assert.deepEqual(Object.keys(rule).sort(), ['then', 'when'], 'a rule says what is known, and allows nothing');
    assert.doesNotMatch(rule.then, /(same delivery|this delivery) (may go|goes) again/);
    assert.doesNotMatch(rule.when, /without native-return/, 'native-return.json proves nothing by its absence');
  }
  assert.ok(result.timeout.next.some(rule => /MODULE_NOT_AT_BASE/.test(rule.then)), 'the rule of a new delivery names the refusal');
  assert.equal(result.timeout.baseSha256, 'hash', 'the base a new delivery of this job is checked against');
  assert.doesNotMatch(result.continuation.why, /same delivery/);
});

for (const [code, label] of [['PIPE_REPLY_TIMEOUT', 'client'], ['PIPE_TRANSPORT', 'transport'], ['PIPE_NO_REPLY', 'transport'], ['AGENT_TIMEOUT', 'transport'], ['AGENT_DISCONNECTED', 'transport']]) {
  test('every cut has one form: ' + code + ' says who cut, and merged and mergeStarted agree', async t => {
    // The merge did start: the evidence says so.
    const seen = deliveryWithMergeTimeout(t, { started: true });
    const studio = seen.deps.studio;
    seen.deps.studio = async args => { if (args[0] !== 'merge') return studio(args); await studio(args).catch(() => {}); throw Object.assign(new Error('lost'), { code, sent: true }); };
    const a = await deliverKernel(seen.input, seen.deps);
    assert.equal(a.outcome, 'uncertain');
    assert.equal(a.timeout.cutBy, label);
    assert.equal(a.timeout.mergeStarted, true);
    assert.equal(a.merged, null, 'started and not returned: not known');
    assert.deepEqual(a.timeout.now, { state: 'may-be-merged' });
    assert.equal(a.continuation.tool, 'studio_status');
    // Hosted, the evidence did not come back.
    const blind = deliveryWithMergeTimeout(t);
    const other = blind.deps.studio;
    blind.deps.studio = async args => { if (args[0] !== 'merge') return other(args); throw Object.assign(new Error('lost'), { code, sent: true, evidenceSeen: false }); };
    const b = await deliverKernel(blind.input, blind.deps);
    assert.equal(b.timeout.mergeStarted, 'unknown');
    assert.equal(b.merged, null, 'never false beside unknown');
    assert.deepEqual(b.timeout.now, { state: 'unknown' });
  });
}

test('the answer a session reads keeps the cut block: what the evidence shows and what it may do', async t => {
  const f = deliveryWithMergeTimeout(t, { started: true });
  const result = await deliverKernel(f.input, f.deps);
  const compact = compactDelivery('studio_deliver', f.input, result);
  assert.equal(compact.timeout.mergeStarted, true);
  assert.ok(compact.timeout.next.length >= 4);
  assert.equal(compact.merged, null);
});

test('merge-started.json decides over not-started.json: nothing says nothing ran', async t => {
  const f = deliveryWithMergeTimeout(t, { started: true });
  const studio = f.deps.studio;
  f.deps.studio = async args => {
    if (args[0] === 'merge') { fs.mkdirSync(f.evidence, { recursive: true }); fs.writeFileSync(path.join(f.evidence, 'not-started.json'), JSON.stringify({ executed: false })); }
    return studio(args);
  };
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.code, 'MERGE_TIMEOUT');
  assert.equal(result.outcome, 'uncertain');
  assert.notEqual(result.timeout.now.state, 'not-started');
  assert.equal(result.merged, null);
});

test('afterMergeTimeout: with pass 1 in the module, no state of pass 2 says that nothing ran', () => {
  const flags = ['notStarted', 'started', 'returned', 'ended', 'busy'];
  for (let bits = 0; bits < 32; bits++) {
    const state = Object.fromEntries(flags.map((name, i) => [name, !!(bits & (1 << i))]));
    assert.ok(!['not-started', 'ended-before-the-merge'].includes(afterMergeTimeout({ ...state, firstPassMerged: true }).state), JSON.stringify(state));
  }
});

test('studio_deliver: an answer the client lost, on a merge the bridge abandoned, is MERGE_NOT_STARTED: the evidence decides', async t => {
  const f = deliveryWithMergeTimeout(t);
  const studio = f.deps.studio;
  f.deps.studio = async args => {
    if (args[0] === 'merge') { fs.mkdirSync(f.evidence, { recursive: true }); fs.writeFileSync(path.join(f.evidence, 'not-started.json'), JSON.stringify({ executed: false, abandoned: true })); }
    return studio(args);
  };
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.code, 'MERGE_NOT_STARTED');
  assert.notEqual(result.outcome, 'uncertain');
  assert.notEqual(result.merged, true);
  assert.match(result.continuation?.why ?? '', /never runs later/);
});

test('studio_deliver: a bridge that abandoned a merge its tab never ran ends MERGE_NOT_STARTED, nothing merged, studio_status next', async t => {
  const f = deliveryWithMergeTimeout(t);
  const refusal = { ok: false, outcome: 'gate_refused', gate: 'studio_busy', error: 'MERGE_NOT_STARTED: the Studio did not run the merge of Fixture within 120 s: its tab did not become idle (a queued job waits for an idle top level). It was abandoned and will never run; nothing was executed and the module is unchanged.' };
  const studio = f.deps.studio;
  f.deps.studio = async args => (args[0] === 'merge' ? (f.calls.push('merge'), refusal) : studio(args));
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'MERGE_NOT_STARTED');
  assert.notEqual(result.merged, true);
  assert.notEqual(result.outcome, 'uncertain');
  assert.equal(result.continuation?.tool, 'studio_status');
});
