import './fixtures/isolated-profile.mjs';
// servidor/fase4-26 a8: the "no internals" rounds 7 and 7b (C:\t\no-internals\RESULTADO-7.md and RESULTADO-7b.md, "Porte para a
// linha") through the hosted gate, with ws: paths, as a licensee's hosted session is served (fake executor and agent; the
// server's own CLIs, the tests skip without them):
// - round 7 B1 and B2: the answers of the round 7 sweep (an ssam_job whose job.base is a loose OML of the workspace inside the
//   job, check-job, ssam_discover with large budgets, rules, ui-block, recipes, examples, the doctor, a packet's parts) name no
//   kernel layout, no CLI flag, no internal proof level and no path of the server;
// - round 7b M1: every section of a packet applies the patches of its parts (the client protocol, a text op checks its
//   offset) and the rebuilt section names nothing internal;
// - round 7b M2: the review's texts keep their use (the recipe row, the ssam_debug definition, the producers argument, the
//   ODC standards, a job's _why note);
// - round 7b B6: the id an EXAMPLE_NOT_FOUND refusal echoes is the one the licensee sent;
// - the anvil family: the four examples whose code changed name no internal name of SSAM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { servedBytesStore } from '../served-bytes.mjs';
import { findings } from './fixtures/internal-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const cliBuilt = fs.existsSync(path.join(kernel, '.local', 'cli', 'anvil.dll')) && fs.existsSync(path.join(kernel, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'));
const skip = !cliBuilt && 'the lane CLIs are not built in this checkout';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-a8-x-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const { o11Lane } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');

class FakeExecutor {
  constructor() { this.id = 'fake-' + randomUUID(); this.hosted = true; }
  relayPort() { return 41998; }
  o11Connection() { return null; }
  async close() {}
  async call(kind) { if (kind === 'studio.processes') return { processes: [] }; throw Object.assign(new Error('unexpected ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); }
}
const agent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, credential: true, agentVersion: '0.3.1',
  kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' }, compatible: { odc: { ok: true }, o11: { ok: true } } }) };
// The customer's name is shown back by the doctor; it never carries the token id here (raw() checks the id).
function hostedContext() {
  const tokenId = 'tok_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const workspace = path.join(fs.mkdtempSync(path.join(tmp, 'ws-')), 'customers', tokenId);
  prepareWorkspace(workspace);
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Synthetic customer', lanes: ['odc', 'o11'], workspace, agent, executor: new FakeExecutor(), o11: { lane: o11Lane.lane }, close: async () => {} };
}
async function session() {
  const context = hostedContext();
  const store = servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'day-')) });
  const server = await runWithExecutor(context, () => createSsamServer({ hosted: { context, session: { agent, lanes: context.lanes }, exposure: { store } },
    deps: { exposure: { dayBytes: 500 * 1024 * 1024 } } }));
  const client = new Client({ name: 'hosted-a8-exposure', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  const call = async (name, args) => {
    let body = await once(name, args);
    for (let i = 0; i < 240 && body?.state === 'running' && body.continuation?.arguments?.continueTask; i++) { await sleep(250); body = await once(body.continuation.tool, body.continuation.arguments); }
    return body;
  };
  return { context, client, call, close: async () => { await client.close(); await server.close(); } };
}
const shown = list => list.map(f => f.family + ' ' + f.at + ' ' + f.sample.replace(/\s+/g, ' ').slice(0, 140));
// A CLI flag or the kernel's layout in a field of SSAM's text (never under a code key: the code of an example stays).
const CLI_FLAG = /(?<![\w-]|var\()--[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\w-]*\s*:)/;
const CODE_KEYS = new Set(['ops', 'patch', 'arguments', 'code', 'html', 'flow', 'ddl', 'content']);
const flagsIn = (node, at = '', out = []) => {
  if (Array.isArray(node)) node.forEach((v, i) => flagsIn(v, at + '/' + i, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
    if (CODE_KEYS.has(k)) continue;
    if (typeof v === 'string' && (CLI_FLAG.test(v) || /<kernel>|\.local[\\/]/.test(v))) out.push(at + '/' + k + ' ' + v.slice(Math.max(0, v.search(CLI_FLAG) - 50), Math.max(0, v.search(CLI_FLAG)) + 50));
    else flagsIn(v, at + '/' + k, out);
  }
  return out;
};
// What no hosted answer may carry: the workspace path, the token id, a Windows path of the server.
const raw = (value, context) => {
  const text = JSON.stringify(value);
  const out = [];
  if (text.includes(JSON.stringify(context.workspace).slice(1, -1)) || text.includes(context.workspace)) out.push('the workspace path');
  if (text.includes(context.tokenId)) out.push('the token id');
  if (/[A-Za-z]:\\\\/.test(text)) out.push('a Windows path');
  return out;
};
const strings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out); return out; };
const balanced = text => { let depth = 0; for (const c of text) { if (c === '(') depth++; else if (c === ')' && --depth < 0) return false; } return depth === 0; };
// The client protocol of the packet parts (context-budget-packet.test.mjs applyMissing), with the parent checked.
function applyMissing(kept, missing) {
  let value = structuredClone(kept);
  for (const change of missing) {
    const keys = change.path ? change.path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~')) : [];
    let parent = value;
    for (const key of keys.slice(0, -1)) { if (parent == null) throw new Error('no parent for ' + change.op + ' ' + change.path); parent = parent[key]; }
    if (keys.length && (parent == null || typeof parent !== 'object')) throw new Error('no parent for ' + change.op + ' ' + change.path);
    const key = keys.at(-1);
    if (change.op === 'text') {
      const current = keys.length ? parent[key] : value;
      if (typeof current !== 'string' || current.length !== change.offset) throw new Error(`text offset ${change.offset} != current length ${current?.length} at ${change.path}`);
      if (keys.length) parent[key] += change.value; else value += change.value;
    } else if (!keys.length) value = structuredClone(change.value);
    else if (change.op === 'remove') { if (Array.isArray(parent)) parent.splice(Number(key), 1); else delete parent[key]; }
    else parent[key] = structuredClone(change.value);
  }
  return value;
}

test('round 7 (B1, B2) through the gate: the answers of the sweep name no kernel layout, CLI flag, internal proof level or server path', { skip, timeout: 900000 }, async () => {
  const s = await session();
  try {
    fs.mkdirSync(path.join(s.context.workspace, 'o11', 'loose'), { recursive: true });
    fs.writeFileSync(path.join(s.context.workspace, 'o11', 'loose', 'mybase.oml'), 'not an oml');
    const badOps = [{ op: 'create', type: 'NoSuchType', parent: '$x' }, { op: 'logic', data: { action: 'A', flow: 'Start -> End' } }];
    const problems = [];
    const calls = [
      // the case of the review: job.base loose INSIDE the job (a workspace OML outside the fixtures and the captures)
      ['ssam_job', { lane: 'o11', job: { description: 'x', base: 'ws:o11/loose/mybase.oml', ops: badOps } }],
      ['ssam_job', { lane: 'o11', base: 'ws:o11/loose/mybase.oml', job: { description: 'x', ops: badOps } }],
      ['ssam_reference', { lane: 'o11', kind: 'check-job', query: { description: 'x', ops: [] } }],
      ['ssam_discover', { lane: 'o11', intent: 'add an entity Customer with name and email', budgetBytes: 40960 }],
      ['ssam_discover', { lane: 'odc', intent: 'create a mobile app', budgetBytes: 40960 }],
      ['ssam_reference', { lane: 'o11', kind: 'rules', query: 'standards' }],
      ['ssam_reference', { lane: 'o11', kind: 'ui-block', query: 'Button' }],
      ['ssam_reference', { lane: 'o11', kind: 'recipe', query: { find: 'entity' } }],
      ['ssam_reference', { lane: 'odc', kind: 'example', query: { find: 'process' } }],
      ['ssam_reference', { lane: 'odc', kind: 'example', query: { id: 'jobs-odc/agent-definition-tools' } }],
      ['ssam_reference', { lane: 'o11', kind: 'example', query: { id: 'jobs/examples/pat-consumer-reference-action' } }],
      ['ssam_doctor', { lane: 'o11' }],
    ];
    const answers = {};
    for (const [name, args] of calls) {
      const answer = await s.call(name, args);
      answers[name + ' ' + JSON.stringify(args).slice(0, 60)] = answer;
      for (const at of [...shown(findings(answer)), ...flagsIn(answer), ...raw(answer, s.context)]) problems.push(name + ' ' + JSON.stringify(args).slice(0, 80) + ' ' + at);
    }
    const loose = Object.entries(answers).find(([k]) => k.startsWith('ssam_job {"lane":"o11","job":{'))?.[1];
    assert.equal(loose?.ok, false, 'the job with a loose base is refused or unverified: ' + JSON.stringify(loose).slice(0, 300));
    // a packet's parts (the patch that rebuilds its sections)
    const base = { lane: 'o11', intent: 'create an entity Customer with name and email and its CRUD actions', limit: 8, packet: true };
    const packet = await s.call('ssam_discover', base);
    for (const expand of [...new Set(JSON.stringify(packet).match(/packet:(?:rules|capabilities|text):[^"]+/g) ?? [])]) {
      const piece = await s.call('ssam_discover', { ...base, expand });
      for (const at of [...shown(findings(piece)), ...flagsIn(piece), ...raw(piece, s.context)]) problems.push('packet ' + expand.slice(0, 20) + ' ' + at);
    }
    assert.deepEqual(problems, []);
  } finally { await s.close(); }
});

test('round 7b (M1) through the gate: every section of a packet applies the patches of its parts and names nothing internal', { skip, timeout: 900000 }, async () => {
  const s = await session();
  const cases = [['o11', 'create an entity Customer with name and email and its CRUD actions', 8192], ['o11', 'expose a REST API', 8192],
    ['odc', 'add a data action to a screen', 8192], ['odc', 'create a reactive screen with a table of orders', 12000]];
  const problems = []; let sections = 0;
  try {
    for (const [lane, intent, budgetBytes] of cases) {
      const packet = await s.call('ssam_discover', { lane, intent, packet: true, budgetBytes });
      if (!packet || packet.ok === false || !Array.isArray(packet.cuts)) { problems.push(intent + ': no packet ' + (packet?.code ?? '')); continue; }
      const missing = {};
      for (const cut of packet.cuts) {
        const part = await s.call('ssam_discover', cut.recover.arguments);
        if (part?.ok !== true) { problems.push(intent + ' part ' + cut.section + ': ' + JSON.stringify(part).slice(0, 160)); continue; }
        (missing[cut.section] ??= []).push(...(part.missing ?? []));
        for (const at of [...shown(findings(part)), ...raw(part, s.context)]) problems.push(intent + ' part ' + cut.section + ' ' + at);
      }
      for (const [section, changes] of Object.entries(missing)) {
        sections++;
        let rebuilt;
        try { rebuilt = applyMissing(packet[section], changes); }
        catch (error) { problems.push(lane + ' ' + intent.slice(0, 40) + ' ' + section + ': ' + String(error.message).slice(0, 200)); continue; }
        for (const at of [...shown(findings({ [section]: rebuilt })), ...raw(rebuilt, s.context)]) problems.push(lane + ' ' + intent.slice(0, 40) + ' rebuilt ' + at);
      }
    }
  } finally { await s.close(); }
  assert.ok(sections >= 4, 'sections read: ' + sections);
  assert.deepEqual(problems, []);
});

test('round 7b (M2) through the gate: the texts of the review\'s table keep their use', { skip, timeout: 900000 }, async () => {
  const s = await session();
  try {
    const recipe = strings(await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: { find: 'entity' } })).find(t => t.startsWith('| Reference to another module'));
    assert.ok(recipe, 'the recipe row is served');
    assert.match(recipe, /o11_job \{job:"<job\.json>", captureProducers:\["<Nome>"\]\} captures the server signature/);
    assert.ok(balanced(recipe), recipe);
    const definition = (await s.call('ssam_reference', { lane: 'o11', kind: 'tool', query: 'ssam_debug' })).definition.description;
    assert.match(definition, /read-frame \(threadId\/eventId of the observed stop; offset = root offset, maxNodes default 2000, cap 20000\)/);
    assert.match(definition, /nodeModuleKeys \(start\/watch\) declares/);
    for (const tool of ['o11_job', 'ssam_job']) {
      const producers = (await s.call('ssam_reference', { lane: 'o11', kind: 'tool', query: tool })).definition.inputSchema.properties.producers.description;
      assert.doesNotMatch(producers, /as=path/, tool);
    }
    const standards = (await s.call('ssam_reference', { lane: 'odc', kind: 'rules', query: 'standards' })).text;
    assert.match(standards, /In a run on ODC, the job, truechange and oml stages do not\s+run, and every rule that applies to ODC comes out as "not checked on ODC yet"/);
    const example = await s.call('ssam_reference', { lane: 'o11', kind: 'example', query: { id: 'jobs/entity-lifecycle' } });
    assert.ok(strings(example).some(t => t.includes('(it counts as a consumer of the FK when deleting)')), 'the _why keeps its use');
  } finally { await s.close(); }
});

test('round 7b (B6) and the anvil family through the gate: the echoed id is the one sent; the four examples name no internal name of SSAM', { skip, timeout: 900000 }, async () => {
  const s = await session();
  try {
    const refused = await s.call('ssam_reference', { lane: 'o11', kind: 'example', query: { id: 'tests/jobs/no-such-example' } });
    assert.equal(refused.code, 'EXAMPLE_NOT_FOUND', JSON.stringify(refused).slice(0, 300));
    assert.match(refused.error, /^no example 'tests\/jobs\/no-such-example' in the proven examples/);
    assert.equal(refused.continuation.arguments.query.find, 'no-such-example');
    for (const [lane, id] of [['o11', 'jobs/cat-b-flow-comment-popover'], ['o11', 'jobs/performance-lookup'], ['odc', 'jobs-odc/email-popover-metadata'], ['odc', 'jobs-odc/theme-css-halves']]) {
      const example = await s.call('ssam_reference', { lane, kind: 'example', query: { id } });
      assert.equal(example.ok, true, id + ': ' + JSON.stringify(example).slice(0, 300));
      assert.deepEqual(strings(example).filter(t => /anvil/i.test(t)), [], id);
      assert.deepEqual(raw(example, s.context), [], id);
    }
  } finally { await s.close(); }
});
