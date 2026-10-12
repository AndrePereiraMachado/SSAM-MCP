// R1 of PLANO-24-PRODUCAO (servidor/fase4-24): the input layer of the 24th release (tool-input.mjs) runs a read tool with
// a renamed field under the tool's own name ({targt} runs as target, {File} as file). The hosted gate must confine the
// arguments the tool RUNS: createSsamServer hands the gate the layer's argsOf, the gate resolves the path pointers of
// hosted/tools.json on argsOf(raw) ?? raw and gives the handler those arguments, normalized and resolved. Without it the
// gate saw no path and the server's reader opened a file of the server or of another customer. A real hosted
// createSsamServer with a fake ODC lane (ssam_map and studio_inspect with their read-only shapes) and the real
// ssam_evidence; no hub, agent or Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { wrapHostedTool, effectiveArgs } from '../hosted/policy.mjs';
import { relaxTool } from '../tool-input.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const SECRET = 'S3CR3T-' + Date.now();
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const answer = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });

async function hostedServer(t) {
  const dirs = hostedDirs(os.tmpdir());
  // A file of the server outside this customer's workspace (another customer, the owner's tokens): the reader must never open it.
  const outside = path.join(dirs.root, 'server', 'owner-secret.json');
  fs.writeFileSync(outside, JSON.stringify({ secret: SECRET }));
  const otherCustomer = path.join(dirs.root, 'server', 'customers', 'tok_other', 'odc', 'snapshots', 'Orders.oml');
  fs.mkdirSync(path.dirname(otherCustomer), { recursive: true }); fs.writeFileSync(otherCustomer, SECRET);
  const inside = path.join(dirs.workspace, 'o11', 'answers', 'probe.json');
  fs.mkdirSync(path.dirname(inside), { recursive: true }); fs.writeFileSync(inside, JSON.stringify({ ok: true, where: 'inside' }));
  const capture = path.join(dirs.workspace, 'odc', 'snapshots', 'Orders.oml');
  fs.mkdirSync(path.dirname(capture), { recursive: true }); fs.writeFileSync(capture, 'oml');
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot });
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => false }, o11Connection: () => null,
    async call() { throw Object.assign(new Error('no machine call in this test'), { code: 'KIND_NOT_ALLOWED', executed: false }); },
    async pullFile() { throw Object.assign(new Error('no agent file in this test'), { code: 'FILE_NOT_FOUND' }); } };
  const context = { id: 'ctx-rename', hosted: true, tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const ran = [];
  // The fake ODC lane: the read-only shapes of ssam_map and studio_inspect (mcp.mjs), each recording what it runs.
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('ssam_map', { description: 'Fake module map.', annotations: readOnly,
      inputSchema: z.object({ lane: z.enum(['odc', 'o11']).default('odc'),
        target: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(16)]), view: z.enum(['map', 'digest', 'search', 'uses']).default('map'),
        budgetBytes: z.number().int().min(2000).max(1048576).default(60000) }).strict() },
    async args => { ran.push({ tool: 'ssam_map', args }); return answer({ ok: true, target: args.target, read: fs.readFileSync(args.target, 'utf8') }); });
    fake.registerTool('studio_inspect', { description: 'Fake inspect.', annotations: readOnly,
      inputSchema: z.object({ target: z.string().min(1), path: z.string().optional(), budget: z.number().int().min(2000).max(200000).default(60000) }).strict() },
    async args => { ran.push({ tool: 'studio_inspect', args }); return answer({ ok: true, target: args.target, read: fs.readFileSync(args.target, 'utf8') }); });
    return fake;
  };
  const session = { tokenId: 'tok_test', customer: 'Test', lanes: ['odc', 'o11'], workspace: dirs.workspace, agent: link };
  const server = await createSsamServer({ o11: false, odc: true,
    deps: { odcFacade, relayTimeoutMs: 20000, lock: { o11Root: dirs.root, odcRoot: dirs.root, connection: () => null } },
    hosted: { context, session, run: (ctx, fn) => fn() } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-input-rename-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = JSON.stringify(result);
    assert.ok(!text.includes(SECRET), name + ' ' + JSON.stringify(args) + ': a file outside the workspace reached the answer');
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };
  return { ...dirs, outside, otherCustomer, inside, capture, ran, call };
}

test('ssam_map {targt:"<server path>"}: the renamed target is confined; PATH_OUTSIDE_WORKSPACE and the reader never runs', async t => {
  const h = await hostedServer(t);
  for (const target of [h.outside, h.otherCustomer]) {
    for (const sent of [{ targt: target }, { Target: target }, { targets: target }, { traget: target }]) {
      const value = await h.call('ssam_map', { lane: 'odc', ...sent });
      assert.equal(value.code, 'PATH_OUTSIDE_WORKSPACE', JSON.stringify(sent) + ': ' + JSON.stringify(value).slice(0, 400));
      // The continuation repeats the call under the field the tool runs, never the misspelled one.
      assert.equal(value.continuation?.tool, 'ssam_map');
      assert.ok(!Object.keys(value.continuation.arguments).some(k => k !== 'target' && k !== 'lane'), JSON.stringify(value.continuation.arguments));
      assert.match(value.continuation.arguments.target, /^agent:inbox\//);
    }
  }
  // A list target (views search and uses) renamed too: each item is confined.
  const list = await h.call('ssam_map', { lane: 'odc', view: 'search', targt: ['ws:odc/snapshots/Orders.oml', h.otherCustomer] });
  assert.equal(list.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.deepEqual(h.ran, [], 'the reader never ran for a path outside the workspace');
});

test('ssam_evidence {File|files|file_:"<server path>"}: PATH_OUTSIDE_WORKSPACE; {fiel} is no sure rename: INPUT_INVALID, nothing read', async t => {
  const h = await hostedServer(t);
  for (const sent of [{ File: h.outside }, { FILE: h.outside }, { files: h.outside }, { file_: h.outside }]) {
    const value = await h.call('ssam_evidence', sent);
    assert.equal(value.code, 'PATH_OUTSIDE_WORKSPACE', JSON.stringify(sent) + ': ' + JSON.stringify(value).slice(0, 400));
  }
  // PLANO-24 named {fiel}: a four-letter field with two letters swapped is not one the layer surely renames (tool-input.mjs:
  // a slip of one letter only in a name of five letters or more), so the layer refuses it before the reader, as any guess.
  const fiel = await h.call('ssam_evidence', { fiel: h.outside });
  assert.equal(fiel.code, 'INPUT_INVALID', JSON.stringify(fiel).slice(0, 400));
  assert.equal(fiel.corrected?.file, '<file>', 'the corrected call names the field, never the path sent');
});

test('studio_inspect {Target|targt:"<server path>"} (one more read tool): PATH_OUTSIDE_WORKSPACE; the reader never runs', async t => {
  const h = await hostedServer(t);
  for (const sent of [{ Target: h.outside }, { targt: h.otherCustomer }, { targets: h.outside }]) {
    const value = await h.call('studio_inspect', sent);
    assert.equal(value.code, 'PATH_OUTSIDE_WORKSPACE', JSON.stringify(sent) + ': ' + JSON.stringify(value).slice(0, 400));
  }
  assert.deepEqual(h.ran, []);
});

test('a correct ws: path still works, sent right or renamed: the tool runs the resolved workspace path and the answer shows ws:', async t => {
  const h = await hostedServer(t);
  for (const sent of [{ target: 'ws:odc/snapshots/Orders.oml' }, { targt: 'ws:odc/snapshots/Orders.oml' }, { Target: h.capture }]) {
    h.ran.length = 0;
    const value = await h.call('ssam_map', { lane: 'odc', ...sent });
    assert.equal(value.ok, true, JSON.stringify(sent) + ': ' + JSON.stringify(value).slice(0, 400));
    assert.equal(value.target, 'ws:odc/snapshots/Orders.oml', 'presented as the workspace name');
    assert.equal(h.ran.length, 1);
    assert.equal(h.ran[0].args.target, h.capture, 'the reader ran the absolute workspace path');
    assert.equal(Object.hasOwn(h.ran[0].args, 'targt'), false);
  }
  h.ran.length = 0;
  const inspect = await h.call('studio_inspect', { targt: 'ws:odc/snapshots/Orders.oml' });
  assert.equal(inspect.ok, true); assert.equal(h.ran[0].args.target, h.capture);
  for (const sent of [{ file: 'ws:o11/answers/probe.json' }, { File: 'ws:o11/answers/probe.json' }]) {
    const value = await h.call('ssam_evidence', { ...sent, pointer: '/where' });
    assert.equal(value.ok, true, JSON.stringify(sent) + ': ' + JSON.stringify(value).slice(0, 400));
    assert.equal(value.value, 'inside');
  }
});

test('the gate alone: argsOf decides what is confined and what the handler runs; normalizing again changes nothing', async () => {
  const dirs = hostedDirs(os.tmpdir());
  const context = { workspace: dirs.workspace, lanes: ['odc'], agent: { info: () => ({}), connected: () => true }, executor: { quota: { full: () => false } } };
  const relaxed = relaxTool('ssam_map', { annotations: readOnly, inputSchema: z.object({ lane: z.enum(['odc', 'o11']).default('odc'), target: z.string().min(1) }).strict() },
    async args => answer({ ok: true, args }));
  const seen = [];
  const handler = async args => { seen.push(args); return relaxed.handler(args, {}); };
  const gated = wrapHostedTool('ssam_map', { inputSchema: {} }, handler, { context, argsOf: relaxed.argsOf });
  const refused = await gated({ targt: path.join(dirs.root, 'elsewhere.oml') }, {});
  assert.equal(refused.structuredContent.code, 'PATH_OUTSIDE_WORKSPACE');
  assert.deepEqual(seen, []);
  const ran = await gated({ targt: 'ws:odc/snapshots/A.oml' }, {});
  assert.deepEqual(seen, [{ target: path.join(dirs.workspace, 'odc', 'snapshots', 'A.oml') }], 'the handler gets the normalized, resolved arguments');
  assert.deepEqual(relaxed.argsOf(seen[0]), seen[0], 'the input layer leaves them as they are');
  assert.equal(ran.structuredContent.args.target, 'ws:odc/snapshots/A.oml');
  // Without argsOf (a tool the layer cannot read) the arguments are the ones sent; an argsOf that refuses or throws keeps them.
  assert.deepEqual(effectiveArgs(null, { a: 1 }), { a: 1 });
  assert.deepEqual(effectiveArgs(() => null, { a: 1 }), { a: 1 });
  assert.deepEqual(effectiveArgs(() => { throw new Error('x'); }, { a: 1 }), { a: 1 });
  assert.deepEqual(effectiveArgs(raw => ({ target: raw.targt }), { targt: 'x' }), { target: 'x' });
});
