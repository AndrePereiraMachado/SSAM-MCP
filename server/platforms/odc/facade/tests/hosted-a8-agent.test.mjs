// servidor/fase4-26 a8 (C:\t\agent-pack-next\PLANO.md section 2): what the next agent pack brings to a hosted customer, and
// what the server line does for a customer who still runs the older pack.
// - (a) Manage Dependencies by code: the thin bridge of the new pack offers refresh_references:add, so o11_studio
//   refresh-references with add/published reaches the customer's Studio with the parameters unchanged; a bridge without it
//   (an older pack) is refused typed, nothing sent, and the answer says the exact step (install the current agent package,
//   restart Service Studio), never the local shortcut.
// - (b) the installed extensions and Forge components of ssam_discover: hosted they are listed through the agent (the
//   kernel's dependencies producers/list over the customer's own Studio session) and kept in the customer's own folder
//   (<ws>/state/components): never the server's connection, cache or root, never another customer's. The XIF read and the
//   published-OML digest stay off hosted (names only).
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
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const net = require('node:net');
const spawned = [];
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  spawned.push({ file, args: [...(args ?? [])], cwd: options?.cwd ?? null });
  const child = new EventEmitter(); child.stdin = { end() {} }; child.unref = () => {}; child.kill = () => {}; child.pid = 0;
  setImmediate(() => callback?.(new Error('no child process in hosted tests'), '', ''));
  return child;
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));
cp.spawn = (file, args, options) => { spawned.push({ file, args, cwd: options?.cwd ?? null, spawn: true }); throw new Error('spawn is not allowed in hosted tests'); };
net.createConnection = () => { throw new Error('no TCP or pipe connection in hosted tests'); };
syncBuiltinESMExports();

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const { o11Lane } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const { hostedTools } = await import('../hosted/policy.mjs');
const { manageDependenciesHostedWhy, alignmentOf } = await import('../o11-cycle.mjs');
const { laneComponents, cacheFile } = await import('../environment-components.mjs');

const LANE = o11Lane.lane;
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const SHORTCUT = /Service Studio \(SSAM\)|next Service Studio opened/;
const OLD_TEXT = /does not run (the Studio's own Manage Dependencies|it) yet/;
class FakeExecutor {
  constructor({ record = null, relay = null, capabilities = ['merge_from_oml:module_key', 'refresh_references'], refresh = null } = {}) {
    this.id = 'fake-' + randomUUID(); this.hosted = true; this.calls = []; this.record = record; this.relay = relay; this.capabilities = capabilities; this.refresh = refresh;
  }
  relayPort() { return this.relay; }
  async call(kind, params = {}) {
    this.calls.push({ kind, params: structuredClone({ ...params, signal: undefined }) });
    if (kind === 'studio.processes') return { processes: [] };
    if (kind === 'o11.selected') return { connected: true, pid: this.record?.pid ?? null };
    if (kind === 'o11.bridge') {
      if (params.method === 'bridge_manifest') return { reply: { success: true, data: { protocolVersion: 2, flavor: 'thin', capabilities: this.capabilities } } };
      if (params.method === 'get_active_module') return { reply: { success: true, data: { name: 'ZZConsumer', key: 'k-zz', environment: null } } };
      if (params.method === 'refresh_references' && this.refresh) return { reply: { success: true, data: structuredClone(this.refresh) } };
      if (params.method === 'refresh_references') return { reply: { success: true, data: { module: 'ZZConsumer', moduleKey: 'k-zz', command: 'Manage Dependencies', committed: true, changed: true,
        added: [{ producer: 'ZZExt', element: 'ZZAction' }], alreadyReferenced: [], references: [], refreshed: [], upToDate: [], newErrors: 0, undo: 'Ctrl+Z' } } };
      return { reply: { success: true, data: {} } };
    }
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
  o11Connection() { return this.record; }
  async close() {}
}
const agent = { connected: () => true, protocolError() {},
  info: () => ({ connected: true, credential: true, agentVersion: '0.3.2', kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' },
    compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function hosted({ capabilities, record = true, refresh = null } = {}) {
  const tokenId = 'tok_' + randomUUID().slice(0, 12);
  const workspace = path.join(temp('ssam-a8-'), 'customers', tokenId);
  prepareWorkspace(workspace);
  const relay = 41000 + Math.floor(Math.random() * 8000);
  const executor = new FakeExecutor({ relay, capabilities, refresh, record: record ? { ok: true, lane: 'o11', anvilLane: LANE, pid: 5150, startedUtc: '2026-10-18T10:00:00.0000000Z',
    studioVersion: '11.55.92', port: relay, authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-18T10:00:05.000Z', hosted: true } : null });
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Customer ' + tokenId, lanes: ['odc', 'o11'], workspace, agent, executor, o11: { lane: LANE }, close: async () => {} };
}
const within = (context, fn) => runWithExecutor(context, fn);
async function hostedServer(context) {
  const server = await within(context, () => createSsamServer({ hosted: { context, session: { agent, lanes: context.lanes } } }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-a8-agent-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { close: async () => { await client.close(); await server.close(); },
    call: async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); } };
}
const files = dir => { const out = []; const walk = d => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f); } }; walk(dir); return out; };

// ---- (a) Manage Dependencies by code

test('(a) a bridge that offers refresh_references:add (the new pack) gets refresh-references with add and published unchanged', async () => {
  const context = hosted({ capabilities: ['merge_from_oml:module_key', 'refresh_references', 'refresh_references:add'] });
  const remote = await hostedServer(context);
  try {
    const answer = await remote.call('o11_studio', { command: 'refresh-references', args: { add: [{ producer: 'ZZExt', elements: ['IServerActionSignature:ZZAction'] }], published: true } });
    const sent = context.executor.calls.filter(c => c.kind === 'o11.bridge' && c.params.method === 'refresh_references');
    assert.equal(sent.length, 1, JSON.stringify(answer).slice(0, 400));
    assert.deepEqual(sent[0].params.params.add, [{ producer: 'ZZExt', elements: ['IServerActionSignature:ZZAction'] }]);
    assert.equal(sent[0].params.params.published, true);
    assert.notEqual(answer.code, 'HOSTED_UNAVAILABLE', JSON.stringify(answer).slice(0, 400));
  } finally { await remote.close(); }
});

test('(a) an older pack (no refresh_references:add) is refused typed, nothing sent, with the exact step and no local shortcut', async () => {
  const context = hosted();
  const remote = await hostedServer(context);
  try {
    const answer = await remote.call('o11_studio', { command: 'refresh-references', args: { published: true, producers: ['ZZExt'] } });
    assert.equal(answer.code, 'HOSTED_UNAVAILABLE', JSON.stringify(answer).slice(0, 400));
    assert.equal(answer.cause, 'MANAGE_DEPENDENCIES_HOSTED_PENDING');
    assert.equal(answer.outcome, 'not-sent');
    assert.match(answer.error, /install the current agent package/);
    assert.match(answer.error, /restart Service Studio/);
    assert.doesNotMatch(answer.error, OLD_TEXT);
    assert.doesNotMatch(JSON.stringify(answer), SHORTCUT);
    assert.ok(!context.executor.calls.some(c => c.kind === 'o11.bridge' && c.params.method === 'refresh_references'), 'nothing refreshed or added');
  } finally { await remote.close(); }
});

test('(a) the hosted continuation of a rolled-back merge says the same step; the classification of o11_studio says the pack decides', () => {
  const why = manageDependenciesHostedWhy(alignmentOf({ requires: 'refresh_references:add', bridgeOffers: false, add: [{ producer: 'ZZExt', kind: 'Extension', elements: ['A'] }] }));
  assert.match(why, /install the current agent package/);
  assert.match(why, /restart Service Studio/);
  assert.doesNotMatch(why, OLD_TEXT);
  assert.doesNotMatch(why, SHORTCUT);
  const reason = hostedTools().o11_studio.reason;
  assert.match(reason, /MANAGE_DEPENDENCIES_HOSTED_PENDING/);
  assert.match(reason, /older agent package/);
  assert.doesNotMatch(reason, /until the agent pack/);
});

// ---- (b) the components of the customer's environment

const PRODUCERS = [{ Name: 'ZZPdfEngine', Kind: 'Extension', Key: 'k-pdf', SignatureHash: 'h1', IsSystem: false },
  { Name: 'ZZOrders', Kind: 'eSpace', Key: 'k-orders', SignatureHash: 'h2', IsSystem: false }];
function fakeRun(calls, { fail = false } = {}) {
  return async (verb, args) => {
    calls.push([verb, ...args]);
    if (fail) return { ok: false, error: 'the agent is not connected' };
    if (verb === 'dependencies' && args[0] === 'producers') return { ok: true, result: { data: PRODUCERS }, stderr: ['listing referenceable producers to zz-env.example.com'] };
    if (verb === 'dependencies' && args[0] === 'list') return { ok: true, result: { data: { elements: [{ type: 'IServerActionSignature', name: 'ZZHtmlToPdf' }, { type: 'IStructureSignature', name: 'ZZPage' }] } } };
    return { ok: false, error: 'unexpected ' + verb };
  };
}

test('(b) hosted, the components are listed through the agent and kept in the customer\'s own folder, never in the server\'s root', async () => {
  const a = hosted();
  const serverRoot = temp('ssam-a8-root-');
  const calls = [];
  const digested = [];
  const value = await within(a, () => laneComponents({ lane: 'o11', intent: 'gerar um PDF do relatorio', needs: ['pdf'] },
    { root: serverRoot, digest: async name => { digested.push(name); return { ok: false }; }, run: fakeRun(calls) }));
  assert.equal(value.ok, true, JSON.stringify(value).slice(0, 400));
  assert.equal(value.host, 'zz-env.example.com');
  assert.deepEqual(value.components.map(c => c.name), ['ZZPdfEngine']);
  assert.deepEqual(value.components[0].actions, ['ZZHtmlToPdf']);
  assert.match(value.components[0].signatures, /names only/);
  assert.deepEqual(calls.map(c => c.slice(0, 2).join(' ')), ['dependencies producers', 'dependencies list']);
  assert.deepEqual(digested, [], 'no published-OML digest hosted');
  assert.deepEqual(files(serverRoot), [], 'nothing in the server\'s root');
  const kept = path.join(a.workspace, 'state', 'components', 'zz-env.example.com.json');
  assert.ok(fs.existsSync(kept), 'the customer\'s cache: ' + files(a.workspace).join(', '));
  assert.ok(!fs.existsSync(cacheFile(serverRoot, 'zz-env.example.com')));
  assert.doesNotMatch(JSON.stringify(value), new RegExp(serverRoot.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  // Without the customer's Studio on the O11 lane (the agent away: no record), the same customer answers from its own cache.
  a.executor.record = null;
  const away = [];
  const again = await within(a, () => laneComponents({ lane: 'o11', intent: 'gerar um PDF do relatorio', needs: ['pdf'] }, { root: serverRoot, run: fakeRun(away) }));
  assert.equal(again.ok, true, JSON.stringify(again).slice(0, 400));
  assert.deepEqual(again.components.map(c => c.name), ['ZZPdfEngine']);
  assert.deepEqual(away, [], 'nothing listed without the customer\'s Studio');
});

test('(b) another customer never reads the first one\'s cache: without its Studio it is NO_LISTING with the exact call', async () => {
  const a = hosted(), b = hosted({ record: false });
  const serverRoot = temp('ssam-a8-root-');
  await within(a, () => laneComponents({ lane: 'o11', needs: ['pdf'] }, { root: serverRoot, run: fakeRun([]) }));
  const calls = [];
  const value = await within(b, () => laneComponents({ lane: 'o11', intent: 'gerar um PDF', needs: ['pdf'] }, { root: serverRoot, run: fakeRun(calls) }));
  assert.equal(value.ok, false);
  assert.equal(value.code, 'NO_LISTING');
  assert.equal(value.continuation?.tool, 'ssam_connect');
  assert.deepEqual(calls, [], 'no Studio of B: nothing listed');
  assert.deepEqual(files(path.join(b.workspace, 'state', 'components')), []);
  assert.doesNotMatch(JSON.stringify(value), /ZZPdfEngine|zz-env/);
  // With its Studio but a listing that fails: NO_LISTING again, nothing written.
  const c = hosted();
  const failed = await within(c, () => laneComponents({ lane: 'o11', needs: ['pdf'] }, { root: serverRoot, run: fakeRun([], { fail: true }) }));
  assert.equal(failed.code, 'NO_LISTING');
  assert.deepEqual(files(path.join(c.workspace, 'state', 'components')), []);
});

test('(b) a hosted ssam_discover lists the environment through the customer\'s lane, no more COMPONENTS_HOSTED_PENDING; the classification says so', async () => {
  const context = hosted();
  const remote = await hostedServer(context);
  try {
    const answer = await remote.call('ssam_discover', { lane: 'o11', intent: 'which installed extensions of the environment can I use for a PDF' });
    assert.notEqual(answer.environment?.cause, 'COMPONENTS_HOSTED_PENDING', JSON.stringify(answer.environment ?? answer).slice(0, 400));
    // The listing ran as the customer's kernel process (no real process here: the fake refuses it), in the customer's folder.
    const listing = spawned.find(s => s.args.includes('dependencies') && s.args.includes('producers'));
    assert.ok(listing, 'the kernel listing was started: ' + JSON.stringify(spawned.map(s => s.args.slice(-3))));
    assert.ok(String(listing.cwd ?? '').startsWith(context.workspace), 'in the customer\'s workspace: ' + listing.cwd);
    assert.equal(answer.environment?.code, 'NO_LISTING', JSON.stringify(answer.environment).slice(0, 400));
  } finally { await remote.close(); }
  const reason = hostedTools().ssam_discover.reason;
  assert.doesNotMatch(reason, /COMPONENTS_HOSTED_PENDING|server's own connection/);
  assert.match(reason, /customer's own folder|their own folder/);
});

// ---- round 2 (review C:\t\revisoes\agent-pack-next\REVISAO.md): M1 and IP option D

const MANAGE = { add: [{ producer: 'ZZExt', elements: ['IServerActionSignature:ZZAction'] }], published: true };
const neutral = (cause, producer, element, facts) => ({ code: 'REFERENCES_NOT_ADDED', severity: 'error', cause, producer, key: 'k1', element,
  message: cause + ': ' + (element ?? producer ?? ''), fix: 'fix the cause, then repeat', patch: null, ...(facts ? { facts } : {}) });

test('(a) M1: a Manage Dependencies a dialog holds (a bridge that could not close it) is never ok: STUDIO_DIALOG_PENDING with the dialog', async () => {
  const blockedBy = { kind: 'Modal', type: 'LoginWindow', title: 'Sign in', source: 'window' };
  for (const [args, command] of [[MANAGE, 'Manage Dependencies'], [{ producers: ['ZZExt'] }, 'Refresh References']]) {
    const context = hosted({ capabilities: ['merge_from_oml:module_key', 'refresh_references', 'refresh_references:add'],
      refresh: { module: 'ZZConsumer', moduleKey: 'k-zz', ...(args.add ? { command } : {}), changed: null, blocked: true, outcome: 'running', blockedBy, dialogs: [],
        next: 'the person answers the dialog in the Studio; the Manage Dependencies then ends by itself (Ctrl+Z undoes it)' } });
    const remote = await hostedServer(context);
    try {
      const answer = await remote.call('o11_studio', { command: 'refresh-references', args });
      assert.equal(answer.ok, false, JSON.stringify(answer).slice(0, 400));
      assert.equal(answer.code, 'STUDIO_DIALOG_PENDING');
      assert.equal(answer.outcome, 'running');
      assert.equal(answer.blockedBy?.title, 'Sign in');
      assert.match(answer.error, /A Studio dialog is open: "Sign in"/);
      assert.match(answer.error, new RegExp(command));
      assert.equal(answer.continuation?.tool, 'o11_studio');
      assert.doesNotMatch(JSON.stringify(answer), /"committed":false|"added":\[\]/, 'never the shape of a Manage Dependencies that ended');
    } finally { await remote.close(); }
  }
});

test('(a) M1 and D: the refusal of the bridge that closed a dialog is typed, the dialog first, and every text is the server\'s', async () => {
  const context = hosted({ capabilities: ['merge_from_oml:module_key', 'refresh_references', 'refresh_references:add'],
    refresh: { module: 'ZZConsumer', moduleKey: 'k-zz', command: 'Manage Dependencies', committed: false, code: 'REFERENCES_NOT_ADDED',
      problems: [neutral('studio-dialog', null, 'Sign in', { kind: 'Modal' }), neutral('not-referenceable', 'ZZExt', null, { where: 'catalog' })],
      reason: 'nothing was applied: the Studio rolled the Manage Dependencies command back', dialogs: [{ kind: 'Modal', title: 'Sign in', type: 'LoginWindow', source: 'window', answer: 'close', closed: true }] } });
  const remote = await hostedServer(context);
  try {
    const answer = await remote.call('o11_studio', { command: 'refresh-references', args: MANAGE });
    assert.equal(answer.ok, false, JSON.stringify(answer).slice(0, 400));
    assert.equal(answer.code, 'REFERENCES_NOT_ADDED');
    // The answer shaping lists the problems (the error is their count); each problem carries the server's sentence and fix.
    assert.equal(answer.problems?.length, 2, JSON.stringify(answer).slice(0, 600));
    assert.equal(answer.problems[0].cause, 'studio-dialog');
    assert.match(answer.problems[0].message, /^A Studio dialog opened during the Manage Dependencies of ZZConsumer: "Sign in"\. The bridge closed it/);
    assert.match(answer.problems[0].fix, /^answer what the Studio asks first/);
    assert.equal(answer.problems[1].message, "The Studio's catalog has no published signature of ZZExt.");
    assert.match(answer.problems[1].fix, /^check that ZZExt is published and referenceable/);
    assert.doesNotMatch(JSON.stringify(answer), /fix the cause, then repeat|studio-dialog: Sign in/, 'the neutral texts of the bridge never reach the user');
    assert.equal(answer.dialogs?.[0]?.title, 'Sign in');
  } finally { await remote.close(); }
});

// ---- round 3 (re-review C:\t\revisoes\agent-pack-next-2\REVISAO.md): N2

test('(a) N2: a command that ends after the bridge closed or left a window names it in dialogs (Manage Dependencies and Refresh References)', async () => {
  const dialogs = [{ kind: 'UnexpectedError', title: 'Unexpected Error', type: 'MessageBoxWindow', source: 'window', answer: 'close', closed: true },
    { kind: 'Modal', title: 'Expression Editor', type: 'ExpressionEditorWindow', source: 'window', answer: null, closed: false }];
  const replies = [[MANAGE, { module: 'ZZConsumer', moduleKey: 'k-zz', command: 'Manage Dependencies', committed: true, changed: true,
      added: [{ producer: 'ZZExt', element: 'ZZAction', type: 'ReferenceAction', spec: 'IServerActionSignature:ZZAction' }], alreadyReferenced: [],
      references: [{ producer: 'ZZExt', key: 'k1', kind: 'Extension', hashBefore: 'h0', hashAfter: 'h1', published: 'h1', atPublished: true }],
      undo: 'Ctrl+Z in the Studio undoes the Manage Dependencies; nothing was published', dialogs, refreshed: ['ZZExt'], upToDate: [], newErrors: 0 }],
    [{ producers: ['ZZExt'] }, { module: 'ZZConsumer', moduleKey: 'k-zz', changed: true, refreshed: ['ZZExt'], upToDate: [], newErrors: 0, dialogs }]];
  for (const [args, refresh] of replies) {
    const context = hosted({ capabilities: ['merge_from_oml:module_key', 'refresh_references', 'refresh_references:add'], refresh });
    const remote = await hostedServer(context);
    try {
      const answer = await remote.call('o11_studio', { command: 'refresh-references', args });
      assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 400));
      assert.deepEqual(answer.dialogs?.map(d => [d.title, d.closed]), [['Unexpected Error', true], ['Expression Editor', false]], JSON.stringify(answer).slice(0, 600));
    } finally { await remote.close(); }
  }
  // Without windows, no dialogs field.
  const quiet = hosted({ capabilities: ['merge_from_oml:module_key', 'refresh_references', 'refresh_references:add'],
    refresh: { module: 'ZZConsumer', moduleKey: 'k-zz', changed: true, refreshed: ['ZZExt'], upToDate: [], newErrors: 0, dialogs: null } });
  const remote = await hostedServer(quiet);
  try {
    const answer = await remote.call('o11_studio', { command: 'refresh-references', args: { producers: ['ZZExt'] } });
    assert.equal(answer.ok, true);
    assert.equal(answer.dialogs, undefined);
  } finally { await remote.close(); }
});

test('(D) the facade and the kernel write the same sentence for every cause (manage-dependencies-text.mjs and ManageDependenciesText.cs)', async () => {
  const { MANAGE_DEPENDENCIES_TEXTS, explainManageProblem } = await import('../manage-dependencies-text.mjs');
  const source = fs.readFileSync(fileURLToPath(new URL('../../../../kernel/src/Anvil.Core/Adapters.SS11/ManageDependenciesText.cs', import.meta.url)), 'utf8');
  const literal = text => JSON.parse(text);
  const entries = [...source.matchAll(/\["([a-z:-]+)"\] = \((".*?(?<!\\)"),\s*(".*?(?<!\\)")\)/g)].map(m => [m[1], [literal(m[2]), literal(m[3])]]);
  assert.ok(entries.length >= 10, 'the kernel table: ' + entries.length);
  assert.deepEqual(Object.fromEntries(entries), Object.fromEntries(Object.entries(MANAGE_DEPENDENCIES_TEXTS).map(([k, v]) => [k, [v.message, v.fix]])));
  const said = explainManageProblem(neutral('not-in-signature', 'ZZExt', 'IServerActionSignature:ZZAction'), 'ZZConsumer');
  assert.equal(said.message, 'ZZAction is not in the published signature of ZZExt.');
  assert.equal(said.fix, 'publish ZZExt with ZZAction public, then deliver the same job again (o11_dependencies list shows what ZZExt publishes)');
  const unknown = explainManageProblem(neutral('some-new-cause', 'ZZExt', null), 'ZZConsumer');
  assert.equal(unknown.message, 'some-new-cause: ZZExt', 'an unknown cause keeps the bridge\'s text');
});