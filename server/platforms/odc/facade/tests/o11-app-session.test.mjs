// The O11 app session in the facade process (o11-app-session.mjs): the 20 cases of kernel/tests/test_ssam_app.py
// ported (marked "py:"), the Python answers recorded once in fixtures/appsession-python-parity.json (schemas, the
// contract review text, the host stdin and 21 hook runs), and what only this process can do: the contract
// acceptance by elicitation on both protocol eras. Fakes only: no dotnet, no Studio, ephemeral ports.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Client } from '@modelcontextprotocol/client';
import { ACCEPTANCE_UNSUPPORTED, REVIEW_SCHEMA, appHost, appSessionSchemas, contractReview, createAppSession, laneReadiness,
  registerO11AppSession, runHook } from '../o11-app-session.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';
import parity from './fixtures/appsession-python-parity.json' with { type: 'json' };

process.env.ANVIL_WORKER = '0';
process.env.ANVIL_ODC_NO_WORKER = '1';

const temp = prefix => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const cleanup = [];
test.after(() => { for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true }); });
function sandbox() {
  const home = temp('appsession-home-'); cleanup.push(home);
  const root = path.join(home, 'anvil'); fs.mkdirSync(root);
  const env = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ANVIL_AUTHORITY_DIR: path.join(home, 'authority'), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  return { home, root, env };
}

// The host as ssam_app.py's tests patch it: replies in call order (side_effect) or by action; refuse() is an error.
const refuse = error => ({ refuse: error });
function fakeHost(replies, more = {}) {
  let index = 0;
  const run = fakeAnvil({ ...more, 'app-session': (args, options) => {
    const reply = Array.isArray(replies) ? replies[index++] : typeof replies === 'function' ? replies(args[2], JSON.parse(options.input)) : replies[args[2]];
    if (reply === undefined) return { ok: false, error: 'unexpected host action ' + args[2] };
    return reply?.refuse !== undefined ? { ok: false, error: reply.refuse } : { ok: true, data: reply };
  } });
  run.host = () => run.calls.filter(c => c.args[0] === 'app-session').map(c => ({ action: c.args[2], input: JSON.parse(c.options.input), options: c.options }));
  return run;
}
const noBridge = () => { throw new Error('bridge must not be used'); };

async function connect(deps, { elicitation = false, answer, modern = false } = {}) {
  const asked = [];
  const client = new Client({ name: 'appsession-test', version: '1.0.0' }, { capabilities: elicitation ? { elicitation: {} } : {},
    ...(modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}) });
  if (elicitation) client.setRequestHandler('elicitation/create', async request => { asked.push(request.params); return answer; });
  const build = () => { const server = new McpServer({ name: 'ssam', version: '0.0.0' }); registerO11AppSession(server, deps); return server; };
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  let close;
  if (modern) { const handle = serveStdio(build, { transport: serverSide }); await client.connect(clientSide); close = () => handle.close(); }
  else { const server = build(); await Promise.all([server.connect(serverSide), client.connect(clientSide)]); close = () => server.close(); }
  return { client, asked, era: client.getProtocolEra?.(), close: async () => { await client.close(); await close(); } };
}
const propose = (extra = {}) => ({ task_id: 'task', module: 'Probe', lane: 'ss5', environment: 'fixture.test', ...extra });

// ---- py: AppProtocolTests, one case each

test('py: csharp source is forwarded as authored files', async () => {
  const source = { files: { 'Domain.cs': 'public record Item(int Quantity);', 'Rules.cs': 'public static class Rules { public static int Double(int x)=>x*2; }' } };
  const host = fakeHost([{ authorized: true }, { accepted: true }]);
  const session = createAppSession({ runAnvil: host, bridgeFor: noBridge });
  assert.equal((await session.call('propose', propose({ lane: 'ss4', csharpSource: source }))).accepted, true);
  const sent = host.host().at(-1).input.proposal;
  assert.deepEqual(sent.csharpSource, source); assert.equal('logic' in sent, false); assert.equal('data' in sent, false);
});

test('py: ui bundle is forwarded with all authored files', async () => {
  const source = { entry: 'main.html', files: { 'main.html': '<component name="Page" kind="screen"></component>', 'card.html': '<component name="Card"></component>' } };
  const host = fakeHost([{ authorized: true }, { accepted: true }]);
  assert.equal((await createAppSession({ runAnvil: host }).call('propose', propose({ uiSource: source }))).accepted, true);
  assert.deepEqual(host.host().at(-1).input.proposal.uiSource, source);
});

test('py: ui source is forwarded without a second binding manifest', async () => {
  const source = '<component name="Page" kind="screen"><p>Hello</p></component>';
  const host = fakeHost([{ authorized: true }, { accepted: true }]);
  assert.equal((await createAppSession({ runAnvil: host }).call('propose', propose({ uiSource: source }))).accepted, true);
  const sent = host.host().at(-1).input.proposal;
  assert.equal(sent.uiSource, source); assert.equal('bindings' in sent, false);
});

test('py: only four controlled tools are exposed, with the Python schemas, descriptions and annotations', async () => {
  const definitions = appSessionSchemas();
  assert.deepEqual(new Set(definitions.map(d => d.name)), new Set(['context', 'propose', 'continue', 'status']));
  assert.ok(definitions.every(d => d.inputSchema.additionalProperties === false && d.inputSchema.required.includes('task_id')));
  assert.deepEqual(definitions, parity.schemas);
  const mcp = await connect({ runAnvil: fakeHost({}) });
  try {
    const { tools } = await mcp.client.listTools();
    assert.deepEqual(tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })), parity.schemas);
  } finally { await mcp.close(); }
});

test('py: missing host permission fails before dispatch', async () => {
  const host = fakeHost([refuse('no host grant')]);
  await assert.rejects(createAppSession({ runAnvil: host }).call('continue', { task_id: 'task' }), /no host grant/);
  assert.deepEqual(host.host().map(c => c.action), ['authorize']);
  assert.deepEqual(host.host()[0].input, { tool: 'continue', arguments: { task_id: 'task' } });
  assert.deepEqual(host.calls[0].options.timeoutMs, 30000);
});

test('py: the model cannot supply an approval flag or a raw job (direct and through MCP)', async () => {
  const host = fakeHost({});
  const session = createAppSession({ runAnvil: host });
  for (const args of [{ task_id: 'task', approved: true }, { task_id: 'task', job: 'arbitrary.json' }, {}])
    await assert.rejects(session.call('continue', args), e => e.code === 'UNDECLARED_ARGUMENTS' && e.message === 'Only the declared app tool arguments are accepted');
  const mcp = await connect({ runAnvil: host });
  try {
    const result = await mcp.client.callTool({ name: 'continue', arguments: { task_id: 'task', approved: true } });
    assert.equal(result.isError, true);
  } finally { await mcp.close(); }
  assert.equal(host.calls.length, 0);
});

test('py: a declined review does not accept the changed contract', async () => {
  const host = fakeHost([{ authorized: true }, { accepted: false, proposal: { data: {} }, contractHash: 'hash' }]);
  const mcp = await connect({ runAnvil: host }, { elicitation: true, answer: { action: 'decline' } });
  try {
    const result = await mcp.client.callTool({ name: 'propose', arguments: propose({ data: {} }) });
    assert.deepEqual(result.structuredContent, { accepted: false, state: 'awaiting-user-acceptance', taskId: 'task' });
    assert.equal(host.host().length, 2); assert.equal(mcp.asked.length, 1);
  } finally { await mcp.close(); }
});

test('py: the initial contract does not request a redundant acceptance', async () => {
  const host = fakeHost([{ authorized: true }, { accepted: true }]);
  const mcp = await connect({ runAnvil: host }, { elicitation: true, answer: { action: 'accept', content: { accepted: true } } });
  try {
    const result = await mcp.client.callTool({ name: 'propose', arguments: propose({ data: {} }) });
    assert.equal(result.structuredContent.accepted, true); assert.equal(mcp.asked.length, 0);
  } finally { await mcp.close(); }
});

test('py: a connected lane is ready without an open module', async () => {
  const bridge = await fakeBridge(request => ({ success: true, data: {
    bridge_manifest: { protocolVersion: 2 }, list_open_modules: { environments: ['fixture.test'], modules: [] } }[request.method] }));
  try {
    const lanes = await laneReadiness({ bridgeFor: lane => o11Bridge({ lane, port: bridge.port, authorization: 'K' }) });
    assert.deepEqual(lanes.map(l => l.lane), ['ss4', 'ss5']);
    assert.ok(lanes.every(l => l.ready && l.environment === 'fixture.test' && l.activeModule === null));
    assert.equal(bridge.seen.some(r => r.method === 'get_active_module'), false);
    assert.ok(bridge.seen.every(r => r.authorization === 'K'));
  } finally { await bridge.close(); }
});

test('py: a disconnected lane requires login', async () => {
  const bridge = await fakeBridge(request => ({ success: true, data: {
    bridge_manifest: { protocolVersion: 2 }, list_open_modules: { environments: [], modules: [] } }[request.method] }));
  try {
    const lanes = await laneReadiness({ bridgeFor: lane => o11Bridge({ lane, port: bridge.port }) });
    assert.ok(lanes.every(l => !l.ready && l.reason === 'Connect the Studio to the requested environment first'));
  } finally { await bridge.close(); }
});

test('py: a hook error denies the tool', async () => {
  const out = await runHook(JSON.stringify({ hook_event_name: 'PreToolUse' }), { runAnvil: fakeHost([refuse('offline')]) });
  assert.equal(out.exitCode, 0);
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('py: the workspace is trusted launch metadata, not model input (same stdin bytes as Python)', async () => {
  const payload = { ...parity.hostInput.payload };
  const host = fakeHost([{}, {}]);
  await appHost({ runAnvil: host, workspace: parity.hostInput.workspace })('capture', payload);
  await appHost({ runAnvil: host })('capture', payload);
  assert.equal(host.calls[0].options.input, parity.hostInput.withWorkspace);
  assert.equal(host.calls[1].options.input, parity.hostInput.withoutWorkspace);
  assert.equal(payload.trustedWorkspace, 'forged');
  assert.deepEqual(host.calls[0].args, ['app-session', '--action', 'capture']);
});

test('py: a scoped model cannot override the workspace', async () => {
  const { home } = sandbox();
  const host = fakeHost({});
  const session = createAppSession({ runAnvil: host, workspace: home });
  for (const key of ['workspace', 'trustedWorkspace'])
    await assert.rejects(session.call('context', { task_id: 'task', [key]: home }), e => e.code === 'UNDECLARED_ARGUMENTS');
  assert.equal(host.calls.length, 0);
  assert.ok(appSessionSchemas().every(d => !('trustedWorkspace' in d.inputSchema.properties)));
});

test('py: a cached MCP requires the active workspace before dispatch', async () => {
  const { home } = sandbox();
  const host = fakeHost([refuse('workspace inactive')]);
  let probed = 0;
  const session = createAppSession({ runAnvil: host, workspace: home, bridgeFor: () => { probed++; throw new Error('no'); } });
  await assert.rejects(session.call('context', { task_id: 'task' }), /workspace inactive/);
  assert.deepEqual(host.host().map(c => c.input), [{ tool: 'context', arguments: { task_id: 'task' }, trustedWorkspace: home }]);
  assert.equal(probed, 0);
});

// Hook cases of test_ssam_app.py run against a real folder, as Python does with ROOT and ROOT.parent.
function hookFolders() {
  const parent = temp('appsession-hook-'); cleanup.push(parent);
  const ws = path.join(parent, 'ws'); fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
  return { parent, ws };
}

test('py: an outside prompt is not forwarded or announced as controlled', async () => {
  const { parent, ws } = hookFolders();
  const host = fakeHost([{ captured: false, inScope: false }]);
  const out = await runHook(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't', cwd: parent, prompt: 'Private maintenance request' }), { runAnvil: host, workspace: ws });
  assert.deepEqual(out, { stdout: '', stderr: '', exitCode: 0 });
  const sent = host.host()[0].input;
  assert.equal('prompt' in sent, false); assert.equal(sent.session_id, 's'); assert.equal(sent.trustedWorkspace, ws);
});

test('py: an outside maintenance tool is neutral and its arguments are not forwarded', async () => {
  const { parent, ws } = hookFolders();
  const host = fakeHost([{ allowed: false, inScope: false }]);
  const out = await runHook(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't', cwd: parent, tool_name: 'Bash', tool_input: { command: 'private' } }), { runAnvil: host, workspace: ws });
  assert.equal(out.stdout, ''); assert.equal('tool_input' in host.host()[0].input, false);
});

test('py: an outside Hybrid tool is denied', async () => {
  const { parent, ws } = hookFolders();
  const out = await runHook(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', turn_id: 't', cwd: parent, tool_name: 'mcp__ssam_hybrid__context', tool_input: { task_id: 'task' } }),
    { runAnvil: fakeHost([{ allowed: false, inScope: false }]), workspace: ws });
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('py: an outside host error does not block or capture maintenance', async () => {
  const { parent, ws } = hookFolders();
  for (const kind of ['UserPromptSubmit', 'PreToolUse']) {
    const out = await runHook(JSON.stringify({ hook_event_name: kind, cwd: parent, tool_name: 'Bash', prompt: 'private' }), { runAnvil: fakeHost([refuse('offline')]), workspace: ws });
    assert.deepEqual(out, { stdout: '', stderr: '', exitCode: 0 }, kind);
  }
});

test('py: a real capture supplies the task id automatically', async () => {
  const { ws } = hookFolders();
  const event = { hook_event_name: 'UserPromptSubmit', session_id: 's', turn_id: 't', cwd: ws, prompt: 'Create Entry' };
  const host = fakeHost([{ captured: true, taskId: 'host-task' }]);
  const out = await runHook(JSON.stringify(event), { runAnvil: host, workspace: ws });
  const { trustedWorkspace, ...sent } = host.host()[0].input;
  assert.deepEqual(sent, event); assert.equal(trustedWorkspace, ws);
  assert.match(JSON.parse(out.stdout).hookSpecificOutput.additionalContext, /host-task/);
});

test('py: the explicit workspace reaches every host call of the MCP tools; a relative one is refused', async () => {
  const { home } = sandbox();
  const host = fakeHost([{ authorized: true }, { taskId: 'task', state: 'ready' }]);
  const session = createAppSession({ runAnvil: host, workspace: home, bridgeFor: lane => ({ ok: async () => { throw new Error(lane + ' offline'); } }) });
  const context = await session.call('context', { task_id: 'task' });
  assert.ok(host.host().every(c => c.input.trustedWorkspace === home));
  assert.deepEqual(context.lanes, [{ lane: 'ss4', ready: false, reason: 'ss4 offline' }, { lane: 'ss5', ready: false, reason: 'ss5 offline' }]);
  assert.throws(() => createAppSession({ runAnvil: host, workspace: 'relative\\dir' }), /absolute existing directory/);
  assert.deepEqual(await runHook('{}', { runAnvil: host, workspace: 'relative\\dir' }), { stdout: '', stderr: '--workspace must be an absolute existing directory\n', exitCode: 2 });
});

// ---- Python parity fixtures: byte-for-byte answers

test('parity: the contract review text and every recorded hook run match ssam_app.py byte for byte', async () => {
  assert.equal(contractReview(parity.review.proposal), parity.review.message);
  const { parent, ws } = hookFolders();
  const json = value => JSON.stringify(value).slice(1, -1);
  const fill = value => JSON.parse(JSON.stringify(value).replaceAll('{WS_SUB}', json(path.join(ws, 'sub'))).replaceAll('{WS}', json(ws)).replaceAll('{PARENT}', json(parent)));
  for (const c of parity.hooks) {
    const host = fakeHost((action) => { const reply = c.replies[action]; return typeof reply === 'string' ? refuse(reply) : reply; });
    const out = await runHook(JSON.stringify(fill(c.event)), { runAnvil: host, workspace: c.workspace ? ws : undefined });
    assert.deepEqual(out, { stdout: c.stdout, stderr: c.stderr, exitCode: c.exitCode }, c.name);
    const calls = host.host().map(({ action, input: { trustedWorkspace, ...payload } }) => ({ action, payload, workspace: trustedWorkspace === ws }));
    assert.deepEqual(calls, fill(c.calls), c.name);
  }
});

// ---- the contract acceptance, now in-process: elicitation on both protocol eras

const changed = { accepted: false, requiresUserAcceptance: true, contractHash: 'h1', sourceHash: 's1', proposal: parity.review.proposal };
for (const modern of [false, true]) {
  const era = modern ? '2026-07-28' : '2025';
  test(`propose (${era}): an accepted review accepts the stored contract hash, spending one permit`, async () => {
    const host = fakeHost([{ authorized: true }, changed, { accepted: true, contractHash: 'h1' }]);
    const mcp = await connect({ runAnvil: host }, { modern, elicitation: true, answer: { action: 'accept', content: { accepted: true } } });
    try {
      assert.equal(mcp.era, modern ? 'modern' : 'legacy');
      const result = await mcp.client.callTool({ name: 'propose', arguments: propose(parity.review.proposal) });
      assert.deepEqual(result.structuredContent, { accepted: true, contractHash: 'h1' });
      assert.equal(mcp.asked.length, 1);
      assert.equal(mcp.asked[0].message, parity.review.message); assert.deepEqual(mcp.asked[0].requestedSchema, REVIEW_SCHEMA);
      assert.deepEqual(host.host().map(c => c.action), ['authorize', 'propose', 'accept']);
      assert.deepEqual(host.host()[2].input, { task_id: 'task', contract_hash: 'h1' });
    } finally { await mcp.close(); }
  });
  test(`propose (${era}): a review answered without accepted:true leaves the task awaiting acceptance`, async () => {
    for (const answer of [{ action: 'accept', content: { accepted: false } }, { action: 'cancel' }, { action: 'accept', content: { accepted: 'yes' } }]) {
      const host = fakeHost([{ authorized: true }, changed]);
      const mcp = await connect({ runAnvil: host }, { modern, elicitation: true, answer });
      try {
        const result = await mcp.client.callTool({ name: 'propose', arguments: propose(parity.review.proposal) });
        assert.deepEqual(result.structuredContent, { accepted: false, state: 'awaiting-user-acceptance', taskId: 'task' });
        assert.deepEqual(host.host().map(c => c.action), ['authorize', 'propose']);
      } finally { await mcp.close(); }
    }
  });
  test(`propose (${era}): a client without elicitation is refused with the Python sentence`, async () => {
    const host = fakeHost([{ authorized: true }, changed]);
    const mcp = await connect({ runAnvil: host }, { modern });
    try {
      const result = await mcp.client.callTool({ name: 'propose', arguments: propose(parity.review.proposal) });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent, { ok: false, code: 'CONTRACT_ACCEPTANCE_UNSUPPORTED', error: ACCEPTANCE_UNSUPPORTED });
      assert.deepEqual(host.host().map(c => c.action), ['authorize', 'propose']);
    } finally { await mcp.close(); }
  });
}

test('propose: a review id is one-use, bound to the arguments and expires; a forged one touches nothing', async () => {
  let clock = 1000;
  const host = fakeHost(action => (action === 'propose' ? changed : action === 'accept' ? { accepted: true, contractHash: 'h1' } : { authorized: true }));
  const session = createAppSession({ runAnvil: host, acceptsForm: () => true, now: () => clock });
  const yes = state => ({ mcpReq: { requestState: () => state, inputResponses: { acceptance: { action: 'accept', content: { accepted: true } } } } });
  await assert.rejects(session.call('propose', propose(), yes('forged')), e => e.code === 'CONTRACT_REVIEW_EXPIRED' && e.continuation.tool === 'propose');
  assert.equal(host.calls.length, 0);
  const first = await session.call('propose', propose());
  assert.equal(first.resultType, 'input_required'); assert.match(first.requestState, /^[0-9a-f]{32}$/);
  assert.deepEqual(await session.call('propose', propose(), yes(first.requestState)), { accepted: true, contractHash: 'h1' });
  await assert.rejects(session.call('propose', propose(), yes(first.requestState)), e => e.code === 'CONTRACT_REVIEW_EXPIRED');
  const second = await session.call('propose', propose());
  await assert.rejects(session.call('propose', propose({ environment: 'other.test' }), yes(second.requestState)), e => e.code === 'CONTRACT_REVIEW_EXPIRED');
  const third = await session.call('propose', propose());
  clock += 900001;
  await assert.rejects(session.call('propose', propose(), yes(third.requestState)), e => e.code === 'CONTRACT_REVIEW_EXPIRED');
  const older = await session.call('propose', propose());
  const newer = await session.call('propose', propose());
  await assert.rejects(session.call('propose', propose(), yes(older.requestState)), e => e.code === 'CONTRACT_REVIEW_EXPIRED');
  assert.deepEqual(await session.call('propose', propose(), yes(newer.requestState)), { accepted: true, contractHash: 'h1' });
  assert.equal(host.host().filter(c => c.action === 'accept').length, 2);
  assert.equal(host.host().filter(c => c.action === 'authorize').length, 5);
  assert.equal(session.reviews.size, 0);
});

test('a gate refusal (selected Studio check) spends no permit', async () => {
  const host = fakeHost({});
  const session = createAppSession({ runAnvil: host, gate: async () => { throw new Error('The selected Studio session is no longer connected.'); } });
  await assert.rejects(session.call('status', { task_id: 'task' }), /no longer connected/);
  assert.equal(host.calls.length, 0);
});

test('a host that prints no JSON makes the session unavailable', async () => {
  const run = async () => ({ ok: false, exitCode: 1, envelope: null, stderr: ['boom'] });
  await assert.rejects(createAppSession({ runAnvil: run }).call('status', { task_id: 'task' }),
    e => e.code === 'HOST_UNAVAILABLE' && e.message === 'Hybrid host did not return valid JSON; the controlled app session is unavailable');
});

// ---- continue: the prepared lane's environment, "delivered", and errors alone

function continueSession({ status, deliver }) {
  const { root, env } = sandbox();
  const host = fakeHost([{ authorized: true }, { taskId: 'task', deliveryTaskId: 'd-1', work: 'C:\\work\\ss5', lane: 'ss5' }, status]);
  const runners = [];
  const createRunner = options => { const run = fakeAnvil({ deliver }); runners.push({ options, run }); return run; };
  return { root, env, host, runners, deps: { runAnvil: host, createRunner, root, env } };
}

test('continue: delivered without error answers only "delivered", after a resume in the prepared lane', async () => {
  const s = continueSession({ deliver: () => ({ ok: true, data: { delivered: true } }),
    status: { taskId: 'task', state: 'complete', result: { scope: 'accepted module contract', delivered: true, error: null, dataProof: { accepted: true, count: 3 } } } });
  const mcp = await connect(s.deps);
  try {
    const result = await mcp.client.callTool({ name: 'continue', arguments: { task_id: 'task' } });
    assert.deepEqual(result.content, [{ type: 'text', text: 'delivered' }]);
    assert.deepEqual(result.structuredContent, { delivered: true }); assert.equal(result.isError, undefined);
  } finally { await mcp.close(); }
  assert.deepEqual(s.host.host().map(c => c.action), ['authorize', 'prepare', 'status']);
  const [{ options, run }] = s.runners.slice(-1);
  assert.equal(options.lane, 'ss5'); assert.equal(options.root, s.root);
  assert.equal(options.env.ANVIL_LANE, 'ss5');
  assert.equal(options.env.ANVIL_STUDIO_DIR, o11LaneOf('ss5', { root: s.root, env: s.env }).studioDir);
  assert.ok(options.env.ANVIL_STUDIO_DIR.startsWith(s.env.USERPROFILE));
  assert.deepEqual(run.calls.map(c => c.args), [['deliver', '--resume', 'd-1', '--work', 'C:\\work\\ss5']]);
});

test('continue: a validation contract refusal returns the verifier errors and nothing else', async () => {
  const preparation = { details: ['Entity Pedido: attribute Descricao has no type'], policyMessages: [], validation: { isValid: false, errors: 1 } };
  const s = continueSession({ deliver: () => ({ exitCode: 1, envelope: { ok: true, data: { delivered: false } } }),
    status: { taskId: 'task', state: 'incomplete', result: { scope: 'accepted module contract', delivered: false, hasAppliedWrites: false, writeState: 'not-sent', stage: 'apply',
      error: 'job rejected by validation contract; merge was not attempted', dataProof: null,
      diagnostics: { newErrors: null, messageContract: null, preparation, preMergeDifferences: [] }, elapsedMs: 900, failures: null } } });
  const mcp = await connect(s.deps);
  try {
    const result = await mcp.client.callTool({ name: 'continue', arguments: { task_id: 'task' } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { ok: false, code: 'DELIVERY_ERRORS', errors: { error: 'job rejected by validation contract; merge was not attempted', preparation } });
  } finally { await mcp.close(); }
});

test('continue: new TrueChange errors after the merge come back as errors (merge kept for review, not delivered)', async () => {
  const unexpected = [{ id: 'm1', type: 'Error', text: 'Invalid expression' }];
  const failures = [{ stage: 'validation', error: 'merge kept for review: new TrueChange errors or unexpected messages' }];
  const s = continueSession({ deliver: () => ({ ok: true, data: { delivered: false } }),
    status: { taskId: 'task', state: 'incomplete', result: { delivered: false, writeState: 'applied', error: failures[0].error,
      dataProof: { accepted: true, differences: [] }, diagnostics: { newErrors: 1, messageContract: { unexpected, missingExpected: [], ambiguous: [], tolerated: [{ id: 'w' }] }, preparation: null, preMergeDifferences: [] }, failures } } });
  const value = await createAppSession(s.deps).call('continue', { task_id: 'task' });
  assert.deepEqual(value, { ok: false, code: 'DELIVERY_ERRORS', errors: { error: failures[0].error, newErrors: 1, messageContract: { unexpected }, failures } });
});

test('continue: a CLI refusal without a recorded error is the transport error', async () => {
  const s = continueSession({ deliver: () => ({ exitCode: 1, envelope: { ok: false, error: "Resume must use the task's original Studio lane" } }),
    status: { taskId: 'task', state: 'ready', result: null } });
  const value = await createAppSession(s.deps).call('continue', { task_id: 'task' });
  assert.deepEqual(value, { ok: false, code: 'DELIVERY_ERRORS', errors: { transportError: "Resume must use the task's original Studio lane" } });
});

test('continue: an incomplete prepare reply runs nothing (no lane is ever assumed)', async () => {
  const { root, env } = sandbox();
  const host = fakeHost([{ authorized: true }, { taskId: 'task', deliveryTaskId: 'd-1', work: 'C:\\w' }]);
  let runners = 0;
  await assert.rejects(createAppSession({ runAnvil: host, root, env, createRunner: () => { runners++; return fakeAnvil({}); } }).call('continue', { task_id: 'task' }),
    e => e.code === 'HOST_REPLY_INCOMPLETE' && e.message === "'lane'");
  assert.equal(runners, 0); assert.deepEqual(host.host().map(c => c.action), ['authorize', 'prepare']);
});

test('continue: a write to reconcile (no error, not delivered) is the host status as is', async () => {
  const status = { taskId: 'task', state: 'reconcile', result: { delivered: false, writeState: 'unknown', error: null, diagnostics: {} } };
  const s = continueSession({ deliver: () => ({ ok: true, data: {} }), status });
  assert.deepEqual(await createAppSession(s.deps).call('continue', { task_id: 'task' }), status);
});

// ---- context and status

test('context adds both lanes read from their bridges; status is the host answer', async () => {
  const bridge = await fakeBridge(request => ({ success: true, data: {
    bridge_manifest: { protocolVersion: 2 },
    list_open_modules: { environments: ['a.test', 'b.test'], modules: [{ name: 'Probe', hasESpace: true }] },
    get_active_module: { name: 'Probe', environment: 'b.test', pendingDialogs: [] } }[request.method] }));
  const old = await fakeBridge(() => ({ success: true, data: { protocolVersion: 1 } }));
  try {
    const ports = { ss4: bridge.port, ss5: old.port };
    const host = fakeHost([{ authorized: true }, { taskId: 'task', state: 'ready', contractHash: null }, { authorized: true }, { taskId: 'task', state: 'ready', result: null }]);
    const mcp = await connect({ runAnvil: host, bridgeFor: lane => o11Bridge({ lane, port: ports[lane] }) });
    try {
      const context = (await mcp.client.callTool({ name: 'context', arguments: { task_id: 'task' } })).structuredContent;
      assert.deepEqual(context, { taskId: 'task', state: 'ready', contractHash: null, lanes: [
        { lane: 'ss4', ready: true, environments: ['a.test', 'b.test'], activeModule: 'Probe', environment: 'b.test' },
        { lane: 'ss5', ready: false, reason: 'Bridge update required before controlled app delivery' }] });
      const status = await mcp.client.callTool({ name: 'status', arguments: { task_id: 'task' } });
      assert.deepEqual(status.structuredContent, { taskId: 'task', state: 'ready', result: null });
      assert.deepEqual(host.host().map(c => c.action), ['authorize', 'context', 'authorize', 'status']);
    } finally { await mcp.close(); }
  } finally { await bridge.close(); await old.close(); }
});

test('a host refusal through MCP is a coded error with the host sentence', async () => {
  const mcp = await connect({ runAnvil: fakeHost([refuse('The trusted client hook did not authorize this exact tool call; app session is not active')]) });
  try {
    const result = await mcp.client.callTool({ name: 'status', arguments: { task_id: 'task' } });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { ok: false, code: 'HOST_REFUSED', error: 'The trusted client hook did not authorize this exact tool call; app session is not active' });
  } finally { await mcp.close(); }
});
