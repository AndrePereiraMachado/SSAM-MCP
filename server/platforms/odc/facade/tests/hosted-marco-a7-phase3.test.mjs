import './fixtures/isolated-profile.mjs';
// servidor/fase4-26 a7, phase 3: what the review of phase 2 (C:\t\revisoes\vps-a7-2\REVISAO.md) asked before the image, through
// the hosted gate with ws: paths (fake executor and agent; the server's own CLIs, the tests that run the kernel skip without
// them):
// - B3: an answer the call deadline builds by itself (TASK_ANSWER_UNAVAILABLE, running, a refused continuation) passes the
//   rule and the gate's presenter like every other answer: no path of the server, no token id;
// - B4: the layout of the Linux image (/data/server, /data/cache, /data/friction, /data/odc-features, /studio, /tmp, /app,
//   /home) is withheld in every field (the presenter's roots from the server's environment) and in the prose (the rule's
//   POSIX list), path.posix as in the image;
// - the markers of withheld data are English (<server>, <customer omitted>, <fixture omitted>);
// - D13 hosted: a page kept before the swap (no origin record in <ws>/state/answer-origins) answers ANSWER_ORIGIN_UNKNOWN;
// - the reviewer's probes (zz-r2-probe.mjs listing, check, noorigin, dayr4): the hosted tools/list, every tool definition,
//   the instructions, check-job and ssam_job answers, a kept answer read back and the day with detached calls carry no
//   internal text (fixtures/internal-text.mjs), but the false positives declared below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { servedBytesStore } from '../served-bytes.mjs';
import { findings } from './fixtures/internal-text.mjs';
import { portugueseIn } from './fixtures/portuguese-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const cliBuilt = fs.existsSync(path.join(kernel, '.local', 'cli', 'anvil.dll')) && fs.existsSync(path.join(kernel, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'));
const skip = !cliBuilt && 'the lane CLIs are not built in this checkout';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-a7-p3-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const { o11Lane } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const { exposedResult } = await import('../exposure.mjs');
const policy = await import('../hosted/policy.mjs');
const evidence = await import('../hosted/evidence.mjs');

class FakeExecutor {
  constructor() { this.id = 'fake-' + randomUUID(); this.hosted = true; this.calls = []; }
  relayPort() { return 41997; }
  o11Connection() { return null; }
  async close() {}
  async call(kind) { this.calls.push(kind); if (kind === 'studio.processes') return { processes: [] }; throw Object.assign(new Error('unexpected ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); }
}
const agent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, credential: true, agentVersion: '0.3.1',
  kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' }, compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function hostedContext(tokenId = 'tok_' + randomUUID().replace(/-/g, '').slice(0, 12), workspace = null) {
  const ws = workspace ?? path.join(fs.mkdtempSync(path.join(tmp, 'ws-')), 'customers', tokenId);
  if (!workspace) prepareWorkspace(ws);
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Synthetic ' + tokenId, lanes: ['odc', 'o11'], workspace: ws, agent, executor: new FakeExecutor(), o11: { lane: o11Lane.lane }, close: async () => {} };
}
async function session({ context = hostedContext(), store = servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'day-')) }), deps = {}, exposure = {} } = {}) {
  const server = await runWithExecutor(context, () => createSsamServer({ hosted: { context, session: { agent, lanes: context.lanes }, exposure: { store } },
    deps: { ...deps, exposure } }));
  const client = new Client({ name: 'hosted-a7-p3', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  const follow = async body => {
    for (let i = 0; i < 240; i++) {
      const next = [body?.continuation, body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
      if (!next) break;
      await sleep(300);
      body = await once(next.tool, next.arguments);
    }
    return body;
  };
  return { server, client, context, store, once, follow, call: async (name, args) => follow(await once(name, args)), close: async () => { await client.close(); await server.close(); } };
}
const shown = list => list.map(f => f.family + ' ' + f.at + ' ' + f.sample.replace(/\s+/g, ' ').slice(0, 140));
// What no hosted answer may carry: a Windows or POSIX absolute path of the server, the workspace, or a token id.
const raw = (value, context) => {
  const text = JSON.stringify(value);
  const out = [];
  if (text.includes(JSON.stringify(context.workspace).slice(1, -1)) || text.includes(context.workspace)) out.push('the workspace path');
  if (text.includes(context.tokenId)) out.push('the token id');
  if (/[A-Za-z]:\\\\/.test(text)) out.push('a Windows path');
  if (/(?<![\w.:/~-])\/(?:data|studio|tmp|app|home)\//.test(text)) out.push('a POSIX path of the image');
  return out;
};

// ---- B4: the layout of the Linux image, path.posix (docker/ssam-server/Dockerfile and the SSAM-MCP image: HOME=/tmp)
const IMAGE_ENV = { SSAM_SERVER_DIR: '/data/server', SSAM_FRICTION_DIR: '/data/friction', ANVIL_STUDIO_DIR: '/studio/o11', ANVIL_ODC_STUDIO_DIR: '/studio/odc',
  ANVIL_ODC_FEATURES_DIR: '/data/odc-features', SSAM_MODULE_INDEX_ROOT: '/data/cache/module-index', SSAM_READER_CACHE_ROOT: '/data/cache/readers' };
const IMAGE_WS = '/data/server/customers/tok_aaaaaaaaaaaa';
const imagePaths = {
  other: '/data/server/customers/tok_bbbbbbbbbbbb/o11/answers/x.json', tokens: '/data/server/tokens.json', log: '/data/server/server.log',
  studio: '/studio/o11/ServiceStudio.Framework.dll', odcStudio: '/studio/odc/OutSystems.ModelAPILoader.dll', features: '/data/odc-features/Features.plain.xml',
  friction: '/data/friction/queue.jsonl', index: '/data/cache/module-index/v1/o11/abc.json', readers: '/data/cache/readers/x', tmp: '/tmp/thin-bridge/2.oml',
  home: '/tmp/.dotnet/x', code: '/app/kernel/.local/cli/anvil.dll', userHome: '/home/ssam/.nuget/x',
};

test('B4: the presenter withholds every folder of the Linux image the server environment names, path.posix, in every field', () => {
  assert.equal(typeof policy.serverRoots, 'function', 'hosted/policy.mjs serverRoots: the roots from the server environment');
  const roots = policy.serverRoots({ env: IMAGE_ENV, code: '/app', home: '/tmp', tmp: '/tmp' });
  for (const root of Object.values(IMAGE_ENV)) assert.ok(roots.includes(root), 'a root of the presenter: ' + root);
  const present = policy.presenter({ workspace: IMAGE_WS, serverRoots: [...roots, '/home'], pathApi: path.posix });
  for (const [name, value] of Object.entries(imagePaths)) {
    assert.equal(present.string(value), '<server>', name + ' as a whole value');
    assert.equal(present.string('could not read ' + value + ' for the call'), 'could not read <server> for the call', name + ' inside a text');
  }
  assert.equal(present.string(IMAGE_WS + '/o11/answers/a.json'), 'ws:o11/answers/a.json', 'the customer\'s own path stays a handle');
  assert.equal(present.string('wrote ' + IMAGE_WS + '/odc/lab/r.json'), 'wrote ws:odc/lab/r.json');
  assert.equal(present.string(IMAGE_WS + '/state/answer-origins/a.origin'), '<server>', 'the internal state of the workspace is withheld');
});

test('B4: the rule (prose) and the guard see the image\'s volumes; rule then presenter leave none of the layout in any field', () => {
  const value = { ok: false, code: 'SYNTHETIC', error: 'could not write ' + imagePaths.other + ' nor ' + imagePaths.features,
    message: 'the kernel read ' + imagePaths.index + ' and ' + imagePaths.tmp, fix: 'nothing under ' + imagePaths.friction,
    file: imagePaths.other, store: { file: imagePaths.index }, home: imagePaths.home, studio: imagePaths.studio, mine: IMAGE_WS + '/o11/jobs/z.json',
    pointer: '/data/results', at: '/data/entities/0' };
  // the guard sees them (independent of the rule)
  for (const key of ['other', 'features', 'index', 'friction', 'tmp']) assert.ok(findings({ text: imagePaths[key] }).some(f => f.family === 'absolute path'), 'the guard sees ' + key);
  const ruled = exposedResult({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }, { exposure: 'licensee', handleRoots: [IMAGE_WS], tool: 'ssam_task', args: {} });
  for (const key of ['error', 'message', 'fix']) assert.doesNotMatch(ruled.structuredContent[key], /\/data\/|\/tmp\//, 'the rule withholds the volumes in ' + key + ': ' + ruled.structuredContent[key]);
  const present = policy.presenter({ workspace: IMAGE_WS, serverRoots: [...policy.serverRoots({ env: IMAGE_ENV, code: '/app', home: '/tmp', tmp: '/tmp' }), '/home'], pathApi: path.posix });
  const out = present.result(ruled).structuredContent;
  assert.equal(out.mine, 'ws:o11/jobs/z.json');
  assert.deepEqual([out.pointer, out.at], ['/data/results', '/data/entities/0'], 'a JSON pointer is no path of the image');
  const left = JSON.stringify({ ...out, pointer: null, at: null });
  assert.doesNotMatch(left, /\/(?:data|studio|tmp|app|home)\//, left);
  assert.deepEqual([...new Set(left.match(/<[a-z][a-z ]*>/g))], ['<server>'], 'the one marker of withheld data is the English one');
});

test('markers: every marker of withheld data a hosted answer carries is English', () => {
  const present = policy.presenter({ workspace: IMAGE_WS, serverRoots: ['/app', '/tmp', '/data/server'], pathApi: path.posix });
  assert.equal(present.string('/app/kernel/x'), '<server>');
  assert.equal(evidence.OMITTED, '<fixture omitted>');
  assert.equal(evidence.CLIENT_OMITTED, '<customer omitted>');
  // Every marker literal of the hosted presenter, the evidence scrub and the hosted catalog: English only.
  const sources = ['policy.mjs', 'evidence.mjs', 'tools.json'].map(n => fs.readFileSync(path.join(here, '..', 'hosted', n), 'utf8')).join('\n');
  const quoted = [...new Set([...sources.matchAll(/['"`](<[a-z][a-z ]{1,30}>)['"`]/g)].map(m => m[1]))].sort();
  assert.deepEqual(quoted, ['<customer omitted>', '<fixture omitted>', '<server>']);
  assert.deepEqual(quoted.filter(marker => portugueseIn(marker)), []);
});

// ---- B3: the answers the call deadline builds by itself
test('B3: TASK_ANSWER_UNAVAILABLE and the other answers of the call deadline carry no path of the server and no token id', { skip, timeout: 600000 }, async () => {
  const s = await session({ deps: { callDeadlineMs: 1 } });
  try {
    const first = await s.once('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
    assert.equal(first.state, 'running', JSON.stringify(first).slice(0, 300));
    assert.deepEqual(raw(first, s.context), [], 'running');
    const id = first.continuation.arguments.continueTask;
    const junk = await s.once('ssam_reference', { continueTask: id, junk: 1 });
    assert.equal(junk.code, 'INPUT_INVALID');
    assert.deepEqual(raw(junk, s.context), [], 'a refused continuation');
    const final = await s.follow(first);
    assert.equal(final.ok, true, JSON.stringify(final).slice(0, 300));
    const tasks = path.join(s.context.workspace, 'o11', 'tasks');
    const record = fs.readdirSync(tasks).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(tasks, n), 'utf8'))).find(t => t.id === id);
    assert.ok(record?.answer?.file, 'the task keeps its final answer: ' + JSON.stringify(record).slice(0, 300));
    fs.rmSync(record.answer.file);
    const gone = await s.once('ssam_reference', { continueTask: id });
    assert.equal(gone.code, 'TASK_ANSWER_UNAVAILABLE', JSON.stringify(gone).slice(0, 300));
    assert.deepEqual(raw(gone, s.context), [], JSON.stringify(gone).slice(0, 400));
    assert.deepEqual(shown(findings(gone)), []);
    const other = await session();
    try {
      const notFound = await other.once('ssam_reference', { continueTask: id });
      assert.equal(notFound.code, 'TASK_NOT_FOUND');
      assert.deepEqual(raw(notFound, other.context), []);
    } finally { await other.close(); }
  } finally { await s.close(); }
});

// ---- D13 hosted (probe noorigin)
test('D13 hosted: a page kept without its origin record (kept before the swap) answers ANSWER_ORIGIN_UNKNOWN; with the record it is read as that answer', async () => {
  const s = await session();
  try {
    const body = { ok: true, kind: 'rules', text: 'Proven by StudioDefaultsTests (round 3, C-executed-current); see docs/CONHECIMENTO-DO-TIME.md and kernel/tests/jobs/a.json',
      rules: [{ rule: 'blind test pending (owner\'s decision)', why: 'Anvil.Core.JobRunner at C:\\srv\\ssam\\kernel\\src\\Anvil.Core\\Kernel\\JobRunner.cs:158' }], provenance: { kernelSha256: 'x' } };
    const text = JSON.stringify(body);
    const sha = createHash('sha256').update(text, 'utf8').digest('hex');
    fs.mkdirSync(path.join(s.context.workspace, 'o11', 'answers'), { recursive: true });
    fs.writeFileSync(path.join(s.context.workspace, 'o11', 'answers', sha + '.json'), text);
    const read = await s.call('ssam_evidence', { file: 'ws:o11/answers/' + sha + '.json', budgetBytes: 28672 });
    assert.equal(read.code, 'ANSWER_ORIGIN_UNKNOWN', JSON.stringify(read).slice(0, 400));
    assert.deepEqual(shown(findings(read)), []);
    assert.deepEqual(raw(read, s.context), []);
    // the record the server writes for a kept reference page, in <ws>/state (never next to the answer)
    fs.mkdirSync(path.join(s.context.workspace, 'state', 'answer-origins'), { recursive: true });
    fs.writeFileSync(path.join(s.context.workspace, 'state', 'answer-origins', sha + '.origin'), JSON.stringify({ tool: 'ssam_reference', kind: 'rules' }));
    const again = await s.call('ssam_evidence', { file: 'ws:o11/answers/' + sha + '.json', budgetBytes: 28672 });
    assert.equal(again.ok, true, JSON.stringify(again).slice(0, 400));
    assert.deepEqual(shown(findings(again)), []);
    // a record next to the answer (the folder the customer's agent writes) decides nothing
    const other = createHash('sha256').update(text + ' ', 'utf8').digest('hex');
    fs.writeFileSync(path.join(s.context.workspace, 'o11', 'answers', other + '.json'), text + ' ');
    fs.writeFileSync(path.join(s.context.workspace, 'o11', 'answers', other + '.origin'), JSON.stringify({ tool: 'ssam_reference', kind: 'rules' }));
    assert.equal((await s.call('ssam_evidence', { file: 'ws:o11/answers/' + other + '.json', budgetBytes: 28672 })).code, 'ANSWER_ORIGIN_UNKNOWN');
  } finally { await s.close(); }
});

// ---- probe listing: the tools/list of every hosted session, the instructions and every tool definition
// Declared false positives of the guard on a definition (words of the tool's own contract, no internal text): the field
// "provenance" odc_list_apis answers, and the Helpers.cs file of an O11 extension the person names.
const DECLARED = [
  { tool: 'odc_list_apis', family: 'proof level or stamp', sample: /provenance/ },
  { tool: 'o11_extension', family: 'file:line or source file', sample: /Helpers\.cs/ },
];
const seenDeclared = new Set();
const declared = (tool, f) => DECLARED.some((d, i) => d.tool === tool && d.family === f.family && d.sample.test(f.sample) && seenDeclared.add(i));
test('probe listing: the hosted tools/list, the instructions and every tool definition carry no internal text', { skip, timeout: 900000 }, async () => {
  const s = await session({ exposure: { dayBytes: 50000000 } });
  try {
    const { tools } = await s.client.listTools();
    assert.ok(tools.length >= 90, 'tools: ' + tools.length);
    const listed = [];
    for (const t of tools) for (const f of findings({ description: t.description, inputSchema: t.inputSchema, annotations: t.annotations, title: t.title }))
      if (!declared(t.name, f)) listed.push(t.name + ' ' + shown([f])[0]);
    assert.deepEqual(listed, [], 'tools/list');
    assert.deepEqual(shown(findings({ instructions: s.server.ssamInstructions })), [], 'instructions');
    const defs = [];
    for (const t of tools) {
      const answer = await s.call('ssam_reference', { lane: 'o11', kind: 'tool', query: t.name });
      assert.equal(answer.ok, true, t.name + ': ' + JSON.stringify(answer).slice(0, 200));
      for (const f of findings(answer)) if (!declared(t.name, f)) defs.push(t.name + ' ' + shown([f])[0]);
    }
    assert.deepEqual(defs, [], 'ssam_reference {kind:"tool"}');
    assert.deepEqual(DECLARED.filter((d, i) => !seenDeclared.has(i)).map(d => d.tool), [], 'a declared false positive is gone (remove it)');
  } finally { await s.close(); }
});

// ---- probe check: check-job and ssam_job answers (the scope sentence, the errors list, a base of the workspace)
test('probe check: check-job (empty and wrong) and ssam_job (wrong logic, a base of the workspace) carry no internal text', { skip, timeout: 600000 }, async () => {
  const s = await session();
  try {
    const answers = {
      empty: await s.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: { description: 'x', ops: [] } }),
      wrong: await s.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: { description: 'x', ops: [{ op: 'logic', action: 'Foo', flow: 'this is not a flow ::' }] } }),
      job: await s.call('ssam_job', { lane: 'o11', job: { description: 'x', ops: [{ op: 'logic', action: 'Foo', flow: 'this is not a flow ::' }] } }),
    };
    fs.writeFileSync(path.join(s.context.workspace, 'o11', 'mybase.oml'), 'not an oml');
    answers.base = await s.call('ssam_job', { lane: 'o11', base: 'ws:o11/mybase.oml', job: { description: 'x', ops: [{ op: 'entity', name: 'Customer', attributes: [{ name: 'Name', type: 'Text' }] }] } });
    assert.equal(answers.empty.ok, true, JSON.stringify(answers.empty).slice(0, 300));
    assert.equal(answers.wrong.code, 'JOB_INVALID', JSON.stringify(answers.wrong).slice(0, 300));
    assert.equal(answers.job.ok, false);
    assert.equal(answers.base.ok, false);
    for (const [name, answer] of Object.entries(answers)) {
      assert.deepEqual(shown(findings(answer)), [], name);
      assert.deepEqual(raw(answer, s.context), [], name);
    }
  } finally { await s.close(); }
});

// ---- probe dayr4: the day of 3000 B with every call detaching (1 ms), through the hosted gate
test('probe dayr4: one call admitted, the rest REFERENCE_DAY_LIMIT, refused continuations release nothing, a check stays outside the day', { skip, timeout: 900000 }, async () => {
  const store = servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'dayr4-')) });
  const s = await session({ store, exposure: { dayBytes: 3000 }, deps: { callDeadlineMs: 1 } });
  try {
    const answers = [];
    const firsts = [];
    for (const [kind, query] of [['recipe', 'timer'], ['functions', 'NullDate'], ['functions', 'Trim'], ['functions', 'Substr'], ['functions', 'Length']]) {
      const r = await s.once('ssam_reference', { lane: 'o11', kind, query }); firsts.push(r); answers.push(r);
    }
    assert.deepEqual(firsts.map(r => r.state ?? r.code), ['running', 'REFERENCE_DAY_LIMIT', 'REFERENCE_DAY_LIMIT', 'REFERENCE_DAY_LIMIT', 'REFERENCE_DAY_LIMIT']);
    const id = firsts[0].continuation.arguments.continueTask;
    const t2 = await s.once('ssam_reference', { continueTask: id, junk: 1 });
    const t1 = await s.once('ssam_evidence', { continueTask: id });
    const after = await s.once('ssam_reference', { lane: 'o11', kind: 'functions', query: 'Index' });
    assert.deepEqual([t2.code, t1.code, after.code], ['INPUT_INVALID', 'TASK_TOOL_MISMATCH', 'REFERENCE_DAY_LIMIT']);
    const final = await s.follow(firsts[0]);
    assert.equal(final.ok, true, 'the admitted call is served: ' + JSON.stringify(final).slice(0, 200));
    const pastDay = [
      await s.once('ssam_reference', { ContinueTask: id }),
      await s.once('ssam_reference', { lane: 'o11', Kind: 'recipe', query: 'timer' }),
      await s.once('ssam_reference', { lane: 'o11', KIND: 'recipe', query: 'timer' }),
      await s.once('ssam_reference', { lane: 'o11', kind: 'CHECK-JOB', query: { description: 'x', ops: [] } }),
    ];
    assert.deepEqual(pastDay.map(r => r.code), ['REFERENCE_DAY_LIMIT', 'REFERENCE_DAY_LIMIT', 'REFERENCE_DAY_LIMIT', 'REFERENCE_DAY_LIMIT']);
    const check = await s.follow(await s.once('ssam_reference', { lane: 'o11', Kind: 'check-job', query: { description: 'x', ops: [] } }));
    assert.equal(check.ok, true, 'a check stays outside the day: ' + JSON.stringify(check).slice(0, 200));
    const day = store.day().callers[s.context.tokenId];
    assert.equal(day.ssam_reference.calls, 1, JSON.stringify(day));
    assert.ok(day['ssam_reference:check']?.calls >= 1, JSON.stringify(day));
    for (const answer of [...answers, t2, t1, after, final, ...pastDay, check]) {
      assert.deepEqual(shown(findings(answer)), [], JSON.stringify(answer).slice(0, 200));
      assert.deepEqual(raw(answer, s.context), []);
    }
  } finally { await s.close(); }
});
