// servidor/fase4-26 a7 (C:\t\vps-a7\PLANO.md section 4): what the candidate 144d71fc adds over the a6 line, kept per
// customer and coherent on a hosted server. One test per adjustment:
// - CX11 P: a hosted session serves the profile all (every tool of hosted/tools.json), whatever profile is asked.
// - CX11 L: the hosted tools/list is the local projection; a tool whose part is off gets its note in front of it.
// - CX11 I: the hosted instructions never name ssam_code while it is unavailable hosted, the local ones do (a8: served hosted,
//   the hosted rules are the local ones; K1 and B1 follow the same switch, hosted/served.mjs).
// - M6: a hosted ssam_discover never marks a tool of another profile and never answers a path of the server.
// - SD: the Studio's defaults of the screen reading are kept in the customer's own folder by every customer process, and
//   the processes the server shares between customers keep none on disk.
// - E1: the Studio's Manage Dependencies by code (refresh_references:add) is not in the agent pack's bridge: hosted it is
//   refused typed, nothing sent, and no answer sends the person to reopen the Studio by the local shortcut.
// Fake executor and agent; no Studio, no process, no socket.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const net = require('node:net');
const spawned = [];
const connections = [];
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  spawned.push({ file, args: [...(args ?? [])] });
  const child = new EventEmitter(); child.stdin = { end() {} }; child.unref = () => {}; child.kill = () => {}; child.pid = 0;
  setImmediate(() => callback?.(new Error('no child process in hosted tests'), '', ''));
  return child;
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));
cp.spawn = (file, args) => { spawned.push({ file, args, spawn: true }); throw new Error('spawn is not allowed in hosted tests'); };
net.createConnection = (...args) => { connections.push(args); throw new Error('no TCP or pipe connection in hosted tests'); };
syncBuiltinESMExports();

const { McpServer, InMemoryTransport, fromJsonSchema } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace, hostedSpawnEnv } = await import('../executor.mjs');
const { o11Lane, workspaceRoot } = await import('../workspace.mjs');
const { createSsamServer, hostedServerEnv, HOSTED_SHARED_STUDIO_DEFAULTS } = await import('../ssam.mjs');
const { hostedTools } = await import('../hosted/policy.mjs');
const { manageDependenciesHostedWhy, alignmentOf } = await import('../o11-cycle.mjs');

const LANE = o11Lane.lane;
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const SHORTCUT = /Service Studio \(SSAM\)|next Service Studio opened/;
class FakeExecutor {
  constructor({ record = null, relay = null, capabilities = ['merge_from_oml:module_key', 'refresh_references'] } = {}) {
    this.id = 'fake-' + randomUUID(); this.hosted = true; this.calls = []; this.record = record; this.relay = relay; this.capabilities = capabilities;
  }
  relayPort() { return this.relay; }
  async call(kind, params = {}) {
    this.calls.push({ kind, params: structuredClone({ ...params, signal: undefined }) });
    if (kind === 'studio.processes') return { processes: [] };
    if (kind === 'o11.selected') return { connected: true, pid: this.record?.pid ?? null };
    if (kind === 'o11.bridge') {
      if (params.method === 'bridge_manifest') return { reply: { success: true, data: { protocolVersion: 2, flavor: 'thin', capabilities: this.capabilities } } };
      if (params.method === 'get_active_module') return { reply: { success: true, data: { name: 'ZZConsumer', key: 'k-zz', environment: null } } };
      return { reply: { success: true, data: {} } };
    }
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
  o11Connection() { return this.record; }
  async close() {}
}
const agent = { connected: () => true, protocolError() {},
  info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' },
    compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function hosted({ pid = 5150, capabilities } = {}) {
  const tokenId = 'tok_' + randomUUID().slice(0, 12);
  const workspace = path.join(temp('ssam-a7-'), 'customers', tokenId);
  prepareWorkspace(workspace);
  const relay = 41000 + Math.floor(Math.random() * 8000);
  const executor = new FakeExecutor({ relay, capabilities, record: { ok: true, lane: 'o11', anvilLane: LANE, pid, startedUtc: '2026-10-17T10:00:00.0000000Z',
    studioVersion: '11.55.92', port: relay, authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-17T10:00:05.000Z', hosted: true } });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Customer ' + tokenId, lanes: ['odc', 'o11'], workspace, agent, executor, o11: { lane: LANE }, close: async () => {} };
}
const within = (context, fn) => runWithExecutor(context, fn);
async function connect(server) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-marco-a7-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { server, client, close: async () => { await client.close(); await server.close(); },
    tools: async () => new Map((await client.listTools()).tools.map(t => [t.name, t])),
    call: async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); } };
}
const localOriginal = (local, name) => local.server.ssamOriginalTools.find(t => t.name === name)?.description;
const hostedServer = (context, options = {}) => within(context, () => createSsamServer({ ...options, hosted: { context, session: { agent, lanes: context.lanes } } })).then(connect);

test('CX11 P: a hosted session serves the profile all (every tool of hosted/tools.json but the hook tools and ssam_friction), whatever profile is asked', async () => {
  const context = hosted();
  const local = await connect(await createSsamServer({ profile: 'all' }));
  const asked = await hostedServer(context, { profile: 'app' });
  try {
    const names = [...(await asked.tools()).keys()].sort();
    assert.deepEqual(names, [...(await local.tools()).keys()].sort(), 'the hosted listing is the profile all');
    for (const debug of ['ssam_debug', 'ssam_debug_run', 'ssam_debug_invoke', 'ssam_debug_client', 'ssam_debug_server', 'ssam_debug_matrix']) assert.ok(names.includes(debug), debug);
    assert.deepEqual(names.filter(n => !hostedTools()[n]), [], 'every listed tool has a hosted class');
    // The hosted catalog is these, ssam_friction (added by the served mode) and the four hook tools (SSAM_APP_HOOK_TOOLS=1 only).
    assert.equal(Object.keys(hostedTools()).length - names.length, 5, 'ssam_friction and the four hook tools');
  } finally { await asked.close(); await local.close(); }
});

test('CX11 L: the hosted tools/list is the local projection; a tool whose part is off has its note in front of that projection', async () => {
  const context = hosted();
  // Phase 3 (no-internals list item 13, R6): a hosted session is a licensee's, so its listing is the projection a local
  // licensee's server lists (the definition rule, exposedToolDefinition, as its last step).
  const local = await connect(await createSsamServer({ profile: 'all', deps: { exposure: { profile: 'licensee' } } }));
  const remote = await hostedServer(context);
  try {
    const mine = await local.tools(), theirs = await remote.tools();
    const { hostedListing } = await import('../hosted/destructive.mjs');
    let noted = 0, compared = 0, projected = 0;
    for (const [name, tool] of theirs) {
      const note = hostedListing(name, { description: '' }).description ?? '';
      if (note) { noted++; assert.ok(tool.description.startsWith(note), name + ': the note first'); }
      // The hosted text of a tool can differ from the local one by design (hybrid_tenants names no tenant of the owner):
      // compared where the hosted original is the local original (with the note in front).
      const original = remote.server.ssamOriginalTools.find(t => t.name === name)?.description;
      if (original !== note + localOriginal(local, name)) continue;
      compared++;
      assert.equal(tool.description, note + mine.get(name).description, name + ': the note, then the same projection as a local server');
      if (mine.get(name).description !== localOriginal(local, name)) projected++;
    }
    assert.ok(compared >= 85, 'compared: ' + compared + ' of ' + theirs.size);
    assert.ok(projected > 0, 'the CX11 projection is served hosted too');
    assert.ok(noted >= 12, 'tools with a part off: ' + noted);
    // The full text (ssam_reference {kind:"tool"}) keeps the note too.
    const original = remote.server.ssamOriginalTools.find(t => t.name === 'o11_service_center_write');
    assert.match(original.description, /^Hosted: deleting is off on this server/);
  } finally { await remote.close(); await local.close(); }
});

// a8 (owner request 18/10): ssam_code is served hosted, so the hosted session rules are the local ones; while its class in
// hosted/tools.json is unavailable (the switch, hosted/served.mjs), they leave it out as before.
test('CX11 I: the hosted session rules name ssam_code while it is served hosted (a8), never while it is not; both keep the session rules', async () => {
  const context = hosted();
  const remote = await hostedServer(context);
  const local = await createSsamServer({ profile: 'all' });
  const { serverInstructions, HOSTED_OFF_RULES } = await import('../server-instructions.mjs');
  const { codeServedHosted, overrideCodeServed } = await import('../hosted/served.mjs');
  try {
    assert.equal(codeServedHosted(), true, 'served by hosted/tools.json');
    const said = remote.server.ssamInstructions;
    const rules = said.slice(0, said.indexOf('This SSAM server is hosted'));
    assert.ok(rules.length > 0, 'the session rules come first');
    assert.match(rules, /mcp__ssam__ssam_code/);
    assert.ok(local.ssamInstructions.startsWith(serverInstructions({ profile: 'all' })), 'the local rules');
    assert.equal(serverInstructions({ profile: 'all', hosted: true }), serverInstructions({ profile: 'all' }), 'served: the hosted rules are the local ones');
    assert.doesNotMatch(said, /ssam_code is unavailable/);
    assert.match(said, /This SSAM server is hosted/);
    assert.match(said, /ssam_discover \{intent,lane\}/);
    assert.deepEqual([...HOSTED_OFF_RULES], ['code', 'code-parts', 'plan']);
    const restore = overrideCodeServed(false);
    try {
      const off = serverInstructions({ profile: 'all', hosted: true });
      assert.doesNotMatch(off, /ssam_code/, 'not served: the rules leave ssam_code out (a7)');
      assert.ok(off.length <= 2000);
    } finally { restore(); }
    assert.ok(serverInstructions({ profile: 'all', hosted: true }).length <= 2000);
  } finally { await remote.close(); await local.close(); }
});

test('M6: a hosted ssam_discover never marks a tool of another profile and never answers a path of the server; a local app server does', async () => {
  const fixture = () => {
    const facade = new McpServer({ name: 'a7-discover-fixture', version: '1' });
    facade.registerTool('ssam_discover', { description: 'Offline fixture.', inputSchema: fromJsonSchema({ type: 'object', properties: { lane: { type: 'string' }, intent: { type: 'string' } }, additionalProperties: true }) },
      async args => {
        const value = { ok: true, lane: args.lane ?? 'odc', intent: args.intent, tools: [{ tool: 'ssam_debug_run', why: 'fixture' }, { tool: 'zz_not_served', why: 'fixture' }], matches: [] };
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      });
    return facade;
  };
  const deps = { odcFacade: async () => fixture(), identity: { read: () => ({ facadeSha256: 'fixed', catalogSha256: 'fixed' }) } };
  const context = hosted();
  const remote = await hostedServer(context, { o11: false, odc: true, deps });
  const local = await connect(await createSsamServer({ o11: false, odc: true, profile: 'app', deps }));
  try {
    const mine = await local.call('ssam_discover', { lane: 'odc', intent: 'debug the action' });
    assert.ok(mine.tools.some(t => t.enable), 'the local app server marks: the fixture reaches the marking');
    const theirs = await remote.call('ssam_discover', { lane: 'odc', intent: 'debug the action' });
    assert.ok(Array.isArray(theirs.tools) && theirs.tools.length === 2, JSON.stringify(theirs).slice(0, 300));
    for (const tool of theirs.tools) { assert.equal(tool.enable, undefined, tool.tool); assert.equal(tool.server, undefined, tool.tool); }
    const text = JSON.stringify(theirs);
    assert.ok(!text.includes(workspaceRoot) && !text.includes(workspaceRoot.replace(/\\/g, '\\\\')) && !/\.mcp\.json/.test(text), 'no path of the server');
  } finally { await remote.close(); await local.close(); }
});

test('SD: every customer process keeps the Studio defaults in its own folder; the processes the server shares keep none on disk', async () => {
  const a = hosted(), b = hosted();
  for (const lane of ['o11', 'odc']) {
    const envA = within(a, () => hostedSpawnEnv(lane).env), envB = within(b, () => hostedSpawnEnv(lane).env);
    assert.equal(envA.SSAM_STUDIO_DEFAULTS_ROOT, path.join(a.workspace, 'state', 'studio-defaults'), lane);
    assert.equal(envB.SSAM_STUDIO_DEFAULTS_ROOT, path.join(b.workspace, 'state', 'studio-defaults'), lane);
    assert.notEqual(envA.SSAM_STUDIO_DEFAULTS_ROOT, envB.SSAM_STUDIO_DEFAULTS_ROOT);
    // state/ is internal: ssam_evidence reads only odc/, o11/ and inbox/ of the workspace.
    assert.ok(!['odc', 'o11', 'inbox'].some(dir => envA.SSAM_STUDIO_DEFAULTS_ROOT.startsWith(path.join(a.workspace, dir))));
  }
  const shared = hostedServerEnv({});
  assert.equal(shared.SSAM_STUDIO_DEFAULTS_ROOT, HOSTED_SHARED_STUDIO_DEFAULTS);
  // The kernel keeps nothing on disk for a root that is not absolute (StudioDefaults.CacheDir), on Windows and on Linux.
  assert.equal(path.win32.isAbsolute(shared.SSAM_STUDIO_DEFAULTS_ROOT), false);
  assert.equal(path.posix.isAbsolute(shared.SSAM_STUDIO_DEFAULTS_ROOT), false);
  assert.equal(shared.ANVIL_KEPT_READINGS, 'own'); assert.equal(shared.ANVIL_BRIDGE_PROBE_MS, '0');
});

test('E1: hosted, o11_studio refresh-references with add or published is refused typed before anything is sent; locally the bridge note stays', async () => {
  const context = hosted();
  const remote = await hostedServer(context, { o11: true, odc: false });
  try {
    for (const args of [{ add: [{ producer: 'ZZExt', elements: ['ZZAction'] }], published: true }, { published: true, producers: ['ZZExt'] }]) {
      const before = context.executor.calls.length;
      const answer = await remote.call('o11_studio', { command: 'refresh-references', args });
      assert.equal(answer.ok, false, JSON.stringify(answer).slice(0, 400));
      assert.equal(answer.code, 'HOSTED_UNAVAILABLE', JSON.stringify(answer).slice(0, 400));
      assert.equal(answer.cause, 'MANAGE_DEPENDENCIES_HOSTED_PENDING');
      assert.equal(answer.outcome, 'not-sent');
      assert.doesNotMatch(JSON.stringify(answer), SHORTCUT);
      assert.match(answer.error, /agent package/);
      const sent = context.executor.calls.slice(before).filter(c => c.kind === 'o11.bridge').map(c => c.params.method);
      assert.ok(sent.includes('bridge_manifest'), 'the capability is read from the agent\'s bridge: ' + sent.join(','));
      assert.ok(!sent.includes('refresh_references'), 'nothing is refreshed or added: ' + sent.join(','));
    }
  } finally { await remote.close(); }
  // With a bridge that offers it (a future agent pack), the call is sent: the refusal is by capability, never by tool.
  const offered = hosted({ capabilities: ['merge_from_oml:module_key', 'refresh_references', 'refresh_references:add'] });
  const next = await hostedServer(offered, { o11: true, odc: false });
  try {
    await next.call('o11_studio', { command: 'refresh-references', args: { add: [{ producer: 'ZZExt', elements: ['ZZAction'] }], published: true } });
    assert.ok(offered.executor.calls.some(c => c.kind === 'o11.bridge' && c.params.method === 'refresh_references'), 'sent to the bridge that offers it');
  } finally { await next.close(); }
});

test('E1: the hosted continuation of a rolled-back merge names the agent package, the producers as OML only when every one is an eSpace module', () => {
  const ext = alignmentOf({ requires: 'refresh_references:add', bridgeOffers: false, add: [{ producer: 'ZZExt', kind: 'Extension', elements: ['A'] }, { producer: 'ZZCore', elements: [] }] });
  const modules = alignmentOf({ requires: 'refresh_references:add', bridgeOffers: false, add: [{ producer: 'ZZCore', kind: 'eSpace', elements: ['A'] }, { producer: 'ZZLib', elements: [] }] });
  for (const alignment of [ext, modules]) {
    const why = manageDependenciesHostedWhy(alignment);
    assert.doesNotMatch(why, SHORTCUT);
    assert.match(why, /agent package/);
    assert.match(why, /MANAGE_DEPENDENCIES_HOSTED_PENDING/);
  }
  assert.match(manageDependenciesHostedWhy(modules), /ZZCore, ZZLib as OML \(producers\)/);
  assert.doesNotMatch(manageDependenciesHostedWhy(ext), /as OML/, 'an Extension has no OML');
});

test('P1: hosted, the producers of studio_deliver (new in the delta) are files of the workspace; "published" is no path on every tool that binds producers', async () => {
  const { resolvePaths } = await import('../hosted/policy.mjs');
  const context = hosted();
  const tools = hostedTools();
  // Another customer's capture beside this workspace, and a file of the server: both refused before the handler runs.
  for (const outside of [path.join(path.dirname(context.workspace), 'tok_other', 'odc', 'snapshots', 'core.oml'), path.join(workspaceRoot, 'kernel', 'tests', 'fixtures', 'x.oml')]) {
    await assert.rejects(resolvePaths('studio_deliver', tools.studio_deliver, { producers: { Core: outside } }, 'odc', context),
      e => e.code === 'PATH_OUTSIDE_WORKSPACE' && e.pointer === '/producers/*', outside);
  }
  const inside = await resolvePaths('studio_deliver', tools.studio_deliver, { producers: { Core: 'ws:odc/snapshots/core.avsig', System: 'published' } }, 'odc', context);
  assert.equal(inside.producers.Core, path.join(context.workspace, 'odc', 'snapshots', 'core.avsig'));
  assert.equal(inside.producers.System, 'published');
  for (const tool of ['o11_deliver', 'ssam_job', 'o11_job']) {
    const resolved = await resolvePaths(tool, tools[tool], { producers: { System: 'published' } }, 'o11', context);
    assert.equal(resolved.producers.System, 'published', tool + ': the word, never ws:o11/published');
  }
});

test('R1: hosted, a job binds the producers it names only to captures of the customer\'s own workspace, never of the server or of another customer', async () => {
  const { jobOdcRoot, odcCapturesForJob } = await import('../job-runner.mjs');
  const { odcRoot } = await import('../workspace.mjs');
  const a = hosted(), b = hosted();
  assert.equal(within(a, () => jobOdcRoot()), path.join(a.workspace, 'odc'));
  assert.equal(jobOdcRoot(), odcRoot, 'locally the lane root, as before');
  // A has a capture of ZZCore; B's job names ZZCore and never gets A's file.
  fs.mkdirSync(path.join(a.workspace, 'odc', 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(a.workspace, 'odc', 'snapshots', 'zzcore.avsig'), JSON.stringify({ Name: 'ZZCore', ModuleKey: 'k-zzcore', Environment: 'zz.example' }));
  const job = path.join(temp('ssam-a7-job-'), 'job.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'reference', producer: 'ZZCore', elements: ['ZZAction'] }] }));
  const forA = within(a, () => odcCapturesForJob(job, [], { odcRoot: jobOdcRoot() }));
  assert.deepEqual(forA.map(f => f.path), [path.join(a.workspace, 'odc', 'snapshots', 'zzcore.avsig')]);
  assert.deepEqual(within(b, () => odcCapturesForJob(job, [], { odcRoot: jobOdcRoot() })), [], 'B finds no capture of A');
});

// a8: served hosted, a hosted packet is the local one (the code form, the plan for six or more elements); with the switch off
// (hosted/served.mjs) it goes back to the lane's delivery tool, no plan, no code card (a7 K1).
test('K1: a hosted work packet sends its work to ssam_code while it is served hosted (a8), to the lane\'s delivery tool while it is not', async () => {
  const { nextSection } = await import('../work-packet.mjs');
  const { overrideCodeServed } = await import('../hosted/served.mjs');
  const route = { id: 'logic.flow', form: 'ssam-flow/1', code: { read: { tool: 'ssam_map', arguments: { view: 'flow', target: '<Module>' } },
    write: { tool: 'ssam_code', arguments: { lane: 'o11', action: 'write', part: 'logic', module: '<Module>' } } } };
  const input = lane => ({ lane, intent: 'change the action ZZTotal and add six actions ZZA ZZB ZZC ZZD ZZE ZZF', module: { digest: { module: { name: 'ZZModule' } } }, textRoute: route });
  const context = hosted();
  for (const lane of ['o11', 'odc']) {
    const local = nextSection(input(lane));
    assert.equal(local.deliver.tool, 'ssam_code', lane + ': locally the code form, as in the product');
    const remote = within(context, () => nextSection(input(lane)));
    assert.deepEqual(remote, local, lane + ': served hosted, the same packet section');
    assert.equal(remote.deliver.arguments.module, 'ZZModule');
    const restore = overrideCodeServed(false);
    try {
      const off = within(context, () => nextSection(input(lane)));
      assert.equal(off.deliver.tool, lane === 'o11' ? 'o11_deliver' : 'studio_deliver', lane);
      assert.equal(off.plan, undefined); assert.equal(off.code, undefined);
      assert.doesNotMatch(JSON.stringify(off), /ssam_code/, lane);
    } finally { restore(); }
  }
});

test('B1 (review a7): a hosted text route names the code form of ssam_code while it is served hosted (a8), never while it is not', async () => {
  const { sectionOf, TEXT_ROUTE_IDS } = await import('../text-routes.mjs');
  const { overrideCodeServed } = await import('../hosted/served.mjs');
  const context = hosted();
  let wired = 0;
  for (const id of TEXT_ROUTE_IDS) for (const lane of ['o11', 'odc']) {
    const route = { id, also: [], why: 'test' };
    const local = sectionOf(route, lane);
    const remote = within(context, () => sectionOf(route, lane));
    if (local.wired) { wired++; assert.ok(local.code, id + ' ' + lane + ': locally the code form, as in the product'); }
    assert.deepEqual(remote, local, id + ' ' + lane + ': served hosted, the same route');
    const restore = overrideCodeServed(false);
    try {
      const off = within(context, () => sectionOf(route, lane));
      assert.equal(off.code, undefined, id + ' ' + lane);
      assert.doesNotMatch(JSON.stringify(off), /ssam_code/, id + ' ' + lane);
      assert.deepEqual(off.call, local.call, id + ' ' + lane + ': the same delivery call');
    } finally { restore(); }
  }
  assert.ok(wired > 0, 'wired routes: ' + wired);
});

test('B4 (review a7): the hosted classification of o11_studio says the Manage Dependencies refusal (E1)', () => {
  const reason = hostedTools().o11_studio.reason;
  assert.match(reason, /MANAGE_DEPENDENCIES_HOSTED_PENDING/);
  assert.match(reason, /refresh-references with add or published/);
});