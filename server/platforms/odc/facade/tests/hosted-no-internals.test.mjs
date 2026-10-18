import './fixtures/isolated-profile.mjs';
// servidor/fase4-26 a7, phase 2: the hosted port of fix/no-internals (C:\t\revisoes\no-internals-4\REVISAO.md, the final list
// of the port), through the hosted gate with ws: paths. A hosted session is a licensee's whatever the environment says; the
// exposure rule runs inside the gate, before its presenter, with the workspace as the one handle root.
// - item 6: licensee by default, the licensee instruction, the rule before the presenter (a handle reads ws:);
// - items 7 and 11: the day per token in one store, the customer's own reference folders and kept answers;
// - item 12: the origin record of a kept answer in <ws>/state, never in the folders the customer's agent writes;
// - item 13: ssam_friction of the served mode passes the rule;
// - items 16 and 18: the generator refusal and the hosted instructions without internal reasons; ssam_reference tool;
// - items 21 and 22: MEDIUM A and B (a reference file read back, every way of writing its ws: path), the argument forms
//   (File, FILE, files, fi_le), a job check detached past the day, a kept answer read back, the day with detached calls
//   and a continuation of another customer.
// Fake executor and agent; the server's own CLIs (the tests that read the reference skip without them).
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-no-internals-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const { o11Lane, anvilRoot } = await import('../workspace.mjs');
const { createSsamServer, registerServedTool } = await import('../ssam.mjs');
const { LICENSEE_INSTRUCTION } = await import('../exposure.mjs');

class FakeExecutor {
  constructor() { this.id = 'fake-' + randomUUID(); this.hosted = true; this.calls = []; }
  relayPort() { return 41997; }
  o11Connection() { return null; }
  async close() {}
  async call(kind) { this.calls.push(kind); if (kind === 'studio.processes') return { processes: [] }; throw Object.assign(new Error('unexpected ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); }
}
const agent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, credential: true, agentVersion: '0.3.1',
  kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' }, compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function hostedContext() {
  const tokenId = 'tok_' + randomUUID().slice(0, 12);
  const workspace = path.join(fs.mkdtempSync(path.join(tmp, 'ws-')), 'customers', tokenId);
  prepareWorkspace(workspace);
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Customer ' + tokenId, lanes: ['odc', 'o11'], workspace, agent, executor: new FakeExecutor(), o11: { lane: o11Lane.lane }, close: async () => {} };
}
async function session({ context = hostedContext(), store = servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'day-')) }), onAlert = null, deps = {}, exposure = {} } = {}) {
  const server = await runWithExecutor(context, () => createSsamServer({ hosted: { context, session: { agent, lanes: context.lanes }, exposure: { store, ...(onAlert ? { onAlert } : {}) } },
    deps: { ...deps, exposure } }));
  const client = new Client({ name: 'hosted-no-internals', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  const follow = async body => {
    for (let i = 0; i < 240; i++) {
      const next = [body?.continuation, body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
      if (!next) break;
      await sleep(500);
      body = await once(next.tool, next.arguments);
    }
    return body;
  };
  return { server, context, store, once, follow, call: async (name, args) => follow(await once(name, args)), close: async () => { await client.close(); await server.close(); } };
}
const shown = list => list.map(f => f.family + ' ' + f.at + ' ' + f.sample.replace(/\s+/g, ' ').slice(0, 120));
const opsOf = value => JSON.stringify(value).match(/"ops":\[[^\]]*\]/g) ?? [];
const ws = (context, rel) => path.join(context.workspace, ...rel.split('/'));
const listUnder = dir => { const out = []; const walk = d => { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else out.push(p); } }; walk(dir); return out; };
const referenceFile = async s => {
  const first = await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
  const file = first.continuation?.arguments?.file;
  assert.match(String(file), /^ws:o11\/reference\/[0-9a-f]+\.json$/, 'the reference file is the customer\'s, shown as ws:: ' + JSON.stringify(first).slice(0, 300));
  return file;
};

test('item 6: a hosted session is a licensee\'s whatever SSAM_EXPOSURE says, with the licensee instruction', async () => {
  const saved = process.env.SSAM_EXPOSURE;
  process.env.SSAM_EXPOSURE = 'owner';
  try {
    const s = await session();
    try {
      assert.equal(s.server.ssamExposure, 'licensee');
      assert.ok(s.server.ssamInstructions.includes(LICENSEE_INSTRUCTION));
      assert.match(s.server.ssamInstructions, /This SSAM server is hosted/);
    } finally { await s.close(); }
  } finally { if (saved === undefined) delete process.env.SSAM_EXPOSURE; else process.env.SSAM_EXPOSURE = saved; }
});

test('item 13: ssam_friction of the served mode passes the licensee rule before the gate', async () => {
  const s = await session();
  try {
    const { fromJsonSchema } = await import('@modelcontextprotocol/server');
    const leak = 'failed at C:\\srv\\ssam\\kernel\\src\\Anvil.Core\\Kernel\\JobRunner.cs:line 158 in Anvil.Core.JobRunner.Apply';
    registerServedTool(s.server, 'ssam_friction', { description: 'test', inputSchema: fromJsonSchema({ type: 'object', properties: { view: { type: 'string' } }, additionalProperties: false }) },
      async () => { const value = { ok: false, error: leak }; return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true }; });
    const answer = await s.once('ssam_friction', { view: 'issues' });
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.doesNotMatch(JSON.stringify(answer), /JobRunner\.cs|Anvil\.Core|C:\\\\srv/, JSON.stringify(answer));
  } finally { await s.close(); }
});
test('items 16 and 18: the hosted generator refusal and instructions name no internal reason; ssam_reference tool is served', { skip, timeout: 600000 }, async () => {
  const s = await session();
  try {
    assert.doesNotMatch(s.server.ssamInstructions, /blind/i);
    const job = { description: 'synthetic', ops: [{ op: 'entity-actions', data: { entities: ['Customer'] } }] };
    const refused = await s.call('ssam_job', { lane: 'o11', job });
    assert.equal(refused.cause, 'GENERATOR_PENDING', JSON.stringify(refused).slice(0, 300));
    assert.deepEqual(shown(findings(refused)), []);
    assert.doesNotMatch(JSON.stringify(refused), /blind/i);
    const tool = await s.call('ssam_reference', { lane: 'o11', kind: 'tool', query: 'ssam_map' });
    assert.notEqual(tool.code, 'HOSTED_UNAVAILABLE', JSON.stringify(tool).slice(0, 300));
    assert.equal(tool.ok, true, JSON.stringify(tool).slice(0, 300));
  } finally { await s.close(); }
});

test('MEDIUM A (hosted): a reference file of the customer read back with ssam_evidence is documentation, its ops as the owner\'s', { skip, timeout: 900000 }, async () => {
  const s = await session();
  let hostedPages;
  try {
    const file = await referenceFile(s);
    assert.ok(fs.existsSync(ws(s.context, file.slice(3))), 'in the customer\'s workspace');
    hostedPages = [await s.call('ssam_evidence', { file, budgetBytes: 28672 })];
    assert.equal(hostedPages[0].ok, true, JSON.stringify(hostedPages[0]).slice(0, 300));
    assert.deepEqual(shown(findings(hostedPages[0])), []);
  } finally { await s.close(); }
  // the same reference on the owner's local server: the ops are the same, the internals there
  const { createSsamServer: local } = await import('../ssam.mjs');
  const owner = await local({ profile: 'all', deps: { exposure: { profile: 'owner' } } });
  const client = new Client({ name: 'owner', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([owner.connect(a), client.connect(b)]);
  try {
    const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
    let first = await once('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
    for (let i = 0; i < 240 && first?.continuation?.arguments?.continueTask; i++) { await sleep(500); first = await once(first.continuation.tool, first.continuation.arguments); }
    const page = await once('ssam_evidence', { file: first.continuation.arguments.file, budgetBytes: 28672 });
    assert.ok(findings(page).length, 'the owner page carries internals (the test is not vacuous)');
    assert.deepEqual(hostedPages.flatMap(opsOf), [page].flatMap(opsOf));
  } finally { await client.close(); await owner.close(); }
});

const forms = file => [['plain', { file }], ['File', { File: file }], ['FILE', { FILE: file }], ['files', { files: file }], ['fi_le', { fi_le: file }],
  ['dot segment', { file: file.replace(/\/([^/]+)$/, '/./$1') }], ['other case', { file: 'ws:O11/Reference/' + file.split('/').at(-1).toUpperCase() }]];
test('MEDIUM B and MEDIUM 1 (hosted): every way of naming the customer\'s reference file is documentation under the day and refused past it', { skip, timeout: 900000 }, async () => {
  const open = await session();
  try {
    const file = await referenceFile(open);
    for (const [label, args] of forms(file)) {
      const page = await open.call('ssam_evidence', { ...args, budgetBytes: 28672 });
      if (page.ok !== true) { assert.match(String(page.code), /^PATH_|INPUT_INVALID|FILE_NOT_FOUND|OUTSIDE_ROOTS/, label + ' ' + JSON.stringify(page).slice(0, 200)); continue; }
      assert.deepEqual(shown(findings(page)), [], label);
    }
  } finally { await open.close(); }
  const shut = await session({ exposure: { dayBytes: 3000 } });
  try {
    const file = await referenceFile(shut);
    assert.equal((await shut.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' })).code, 'REFERENCE_DAY_LIMIT');
    for (const [label, args] of forms(file)) {
      const page = await shut.call('ssam_evidence', { ...args, budgetBytes: 28672 });
      assert.notEqual(page.ok, true, label + ': served past the day ' + JSON.stringify(page).slice(0, 200));
      assert.match(String(page.code), /REFERENCE_DAY_LIMIT|^PATH_|INPUT_INVALID|FILE_NOT_FOUND|OUTSIDE_ROOTS/, label);
    }
    // the plain form and the four argument names are the reference, past the day
    for (const [label, args] of forms(file).slice(0, 5)) assert.equal((await shut.call('ssam_evidence', { ...args, budgetBytes: 28672 })).code, 'REFERENCE_DAY_LIMIT', label);
  } finally { await shut.close(); }
});

test('items 7 and 22: the day is per token in one store; a detached reference call holds its reservation; another customer never continues a task', { skip, timeout: 900000 }, async () => {
  const store = servedBytesStore({ dir: path.join(tmp, 'one-store') });
  const a = await session({ store, exposure: { dayBytes: 3000 }, deps: { callDeadlineMs: 1 } });
  const b = await session({ store, exposure: { dayBytes: 3000 } });
  try {
    // A detaches a reference call; while it runs, its reservation (16 KB) keeps A's day shut
    const first = await a.once('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
    assert.equal(first.state, 'running', JSON.stringify(first).slice(0, 200));
    const second = await a.call('ssam_reference', { lane: 'o11', kind: 'functions', query: 'NullDate' });
    assert.equal(second.code, 'REFERENCE_DAY_LIMIT', 'a second call while the first holds its reservation: ' + JSON.stringify(second).slice(0, 200));
    // B (another token, same store) is not touched by A's day, and cannot continue A's task
    const other = await b.once('ssam_reference', first.continuation.arguments);
    assert.equal(other.code, 'TASK_NOT_FOUND', JSON.stringify(other).slice(0, 200));
    assert.equal((await b.call('ssam_reference', { lane: 'o11', kind: 'functions', query: 'NullDate' })).ok, true);
    // A's continuation is served (never refused by the day) and counted once
    const final = await a.follow(first);
    assert.notEqual(final.code, 'REFERENCE_DAY_LIMIT');
    const day = store.day();
    assert.ok(day.callers[a.context.tokenId]?.ssam_reference?.calls >= 1 && day.callers[b.context.tokenId]?.ssam_reference?.calls >= 1, JSON.stringify(day.callers));
    assert.equal(day.callers[a.context.tokenId].ssam_reference.calls, 1, 'A\'s detached call counted once, its refused second call not at all');
  } finally { await a.close(); await b.close(); }
});

test('item 22 (hosted): a job check detached past the day reaches its final answer, counted as a check', { skip, timeout: 900000 }, async () => {
  const s = await session({ exposure: { dayBytes: 3000 }, deps: { callDeadlineMs: 1 } });
  try {
    await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
    assert.equal((await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' })).code, 'REFERENCE_DAY_LIMIT');
    const first = await s.once('ssam_reference', { lane: 'o11', kind: 'check-job', query: { description: 'x', ops: [] } });
    assert.equal(first.state, 'running', JSON.stringify(first).slice(0, 200));
    const final = await s.follow(first);
    assert.notEqual(final.code, 'REFERENCE_DAY_LIMIT', JSON.stringify(final).slice(0, 300));
    assert.ok((s.store.day().callers[s.context.tokenId]?.['ssam_reference:check']?.calls ?? 0) >= 1);
  } finally { await s.close(); }
});

test('items 11 and 12 (hosted): a kept answer stays in ws:o11/answers, its origin record in <ws>/state, and it is read back as its tool\'s answer', { skip, timeout: 900000 }, async () => {
  const started = Date.now() - 1000;
  const s = await session({ deps: { maxAnswerBytes: 600 } });
  let paged;
  try {
    paged = await s.call('ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' });
    assert.match(String(paged.paged?.file), /^ws:o11\/answers\/[0-9a-f]{64}\.json$/, JSON.stringify(paged).slice(0, 300));
    const name = paged.paged.file.split('/').at(-1).replace(/\.json$/, '');
    assert.ok(fs.existsSync(ws(s.context, 'state/answer-origins/' + name + '.origin')), 'the origin record is in <ws>/state');
    assert.deepEqual(listUnder(ws(s.context, 'o11')).filter(f => f.endsWith('.origin')), [], 'no origin record in the folders the agent writes');
    assert.deepEqual(listUnder(path.join(anvilRoot, '.local', 'answers')).filter(f => fs.statSync(f).mtimeMs >= started), [], 'nothing new in the server\'s answers');
  } finally { await s.close(); }
  // a later session of the same customer reads the page back as ssam_reference's: documentation, and past the day refused
  const reader = await session({ context: s.context, exposure: { dayBytes: 3000 } });
  try {
    const read = await reader.call('ssam_evidence', { file: paged.paged.file, budgetBytes: 28672 });
    assert.equal(read.ok, true, JSON.stringify(read).slice(0, 300));
    assert.deepEqual(shown(findings(read)), []);
    await reader.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
    assert.equal((await reader.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' })).code, 'REFERENCE_DAY_LIMIT');
    assert.equal((await reader.call('ssam_evidence', { file: paged.paged.file, budgetBytes: 28672 })).code, 'REFERENCE_DAY_LIMIT');
  } finally { await reader.close(); }
});

test('item 7 (hosted): past the alert, one line names the token, sizes only', { skip, timeout: 900000 }, async () => {
  const lines = [];
  const s = await session({ onAlert: line => lines.push(JSON.parse(line)), exposure: { alertBytes: 1000 } });
  try {
    await s.call('ssam_reference', { lane: 'o11', kind: 'functions', query: 'NullDate CurrDateTime' });
    await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(lines[0].caller, s.context.tokenId);
    assert.ok(lines[0].bytes > 1000 && lines[0].limitBytes === 1000);
  } finally { await s.close(); }
});

// item 21 (no-internals-answers through the gate): the read tools a licensee uses most, on both lanes, carry no family of
// "how SSAM is built"; the owner's local answers to the same calls do (the test is not vacuous).
const SWEEP = [
  ['ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' }], ['ssam_reference', { lane: 'odc', kind: 'rules', query: { doc: 'team', section: 'Subagents' } }],
  ['ssam_reference', { lane: 'o11', kind: 'functions', query: 'GetUserId CurrDateTime' }], ['ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' }],
  ['ssam_reference', { lane: 'odc', kind: 'example', query: { find: 'table pagination' } }],
  ['ssam_discover', { lane: 'o11', intent: 'add an entity Customer with name and email' }], ['ssam_discover', { lane: 'odc', intent: 'change the logic of the action CalculateTotal' }],
  ['ssam_discover', { lane: 'odc', intent: 'create list and detail screens', packet: true }],
];
test('item 21 (hosted): the read tools carry no internals through the gate; the owner\'s local answers do', { skip, timeout: 1800000 }, async () => {
  const s = await session();
  const found = [];
  try {
    for (const [name, args] of SWEEP) {
      const answer = await s.call(name, args);
      assert.notEqual(answer.code, 'REFERENCE_DAY_LIMIT');
      found.push(...shown(findings(answer)).map(f => name + ' ' + JSON.stringify(args).slice(0, 60) + ' ' + f));
    }
  } finally { await s.close(); }
  assert.deepEqual(found, []);
  const { createSsamServer: local } = await import('../ssam.mjs');
  const owner = await local({ profile: 'all', deps: { exposure: { profile: 'owner' } } });
  const client = new Client({ name: 'owner-sweep', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([owner.connect(a), client.connect(b)]);
  try {
    let ownerFindings = 0;
    for (const [name, args] of SWEEP.slice(5, 7)) {
      let answer = (await client.callTool({ name, arguments: { ...args, budgetBytes: 40960 } }, undefined, { timeout: 600000 })).structuredContent;
      for (let i = 0; i < 240 && answer?.continuation?.arguments?.continueTask; i++) { await sleep(500); answer = (await client.callTool({ name, arguments: answer.continuation.arguments }, undefined, { timeout: 600000 })).structuredContent; }
      ownerFindings += findings(answer).length;
    }
    assert.ok(ownerFindings > 0, 'the owner\'s answers carry internals');
  } finally { await client.close(); await owner.close(); }
});