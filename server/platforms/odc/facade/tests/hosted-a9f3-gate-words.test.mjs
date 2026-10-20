import './fixtures/isolated-profile.mjs';
// servidor/fase4-26 a9 follow-ups, round 3 (review C:\t\revisoes\a9-followups-2\REVISAO.md, N1, the family of B). EVERY tool
// of the hosted catalog, through EVERY refusal and continuation of the hosted gate (hosted/policy.mjs wrapHostedTool: the agent
// reconnecting, never seen or without credential, a Studio not served, no Service Studio, the workspace full, the lane or its
// kernel off, patch "verified", a delete, a path outside the workspace at every pointer of the catalog, and the call let
// through), with EVERY words field the hub's detector reads (destructive-operations.mjs callWordsProblems: WORD_KEYS at any
// depth, studio_authorize's text, the words of a studio_command line):
//   - no answer gives a word back (text or structured);
//   - every step that repeats the call carries the marker at each of those fields, with askOwner and the ASK_OWNER why, and
//     the detector reads each of them again (replayed as it came, the hub answers WORDS_REQUIRED before any handler);
//   - the handler, when the gate lets the call through, gets the words as sent (the mask is of echoes, never of the call).
// And over the live input schemas of every tool of the hub (both lanes, profile all): the mask of a step, of a corrected and
// of a whole MCP result covers every field the detector reads (one rule). The expectations come from the detector itself
// (a field is words when the detector names it holding a server text), never from the mask under test. Synthetic values; no
// agent, Studio, process or socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { wrapHostedTool, hostedTools } from '../hosted/policy.mjs';
import * as ops from '../destructive-operations.mjs'; // a namespace: at the base each test fails on its own rule, not at import
import { createSsamServer } from '../ssam.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
process.env.SSAM_ODC_OFFLINE = '1';
const MARKER = "<the user's own words>";
const ASK = "the owner's own words in place of the marker";
// Every words value carries one token N1q<k>z: an answer that holds any such token gave words back.
let serial = 0;
const words = () => `Synthetic owner words N1q${++serial}z: I authorize this exact step`;
const TOKEN = /N1q\d+z/;
const OUTSIDE = ['C:', 'Users', 'ana', 'Downloads', 'n1-input.json'].join('\\');
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });
const detected = (tool, args) => ops.callWordsProblems(tool, args).map(p => p.path);

// keys -> a copy of value with v at keys (a number makes an array; '*' is its first item).
function setAt(value, keys, v) {
  const root = structuredClone(value ?? {});
  let cursor = root;
  keys.forEach((k, i) => {
    const key = k === '*' ? 0 : k;
    if (i === keys.length - 1) { cursor[key] = v; return; }
    const next = keys[i + 1];
    if (cursor[key] === undefined || cursor[key] === null || typeof cursor[key] !== 'object') cursor[key] = next === '*' || typeof next === 'number' ? [] : {};
    cursor = cursor[key];
  });
  return root;
}
const getAt = (value, keys) => keys.reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), value);
// Every step {tool, arguments} of an answer, at any depth.
function stepsOf(value, out = []) {
  if (Array.isArray(value)) value.forEach(v => stepsOf(v, out));
  else if (value && typeof value === 'object') {
    if (typeof value.tool === 'string' && value.arguments && typeof value.arguments === 'object') out.push(value);
    Object.values(value).forEach(v => stepsOf(v, out));
  }
  return out;
}

// The places a call may hold words (top level and nested); which of them are words for a tool, the detector says.
const PLACES = [['authorize'], ['authorization'], ['words'], ['ownerRequest'], ['text'], ['request', 'authorization'],
  ['request', 'batch', 0, 'ownerRequest'], ['confirmUpdates', 'authorize'], ['roleCycle', 'words'], ['reconcile', 'authorize']];
const LINES = [
  ['authorize line', w => ({ command: 'authorize ws:odc/manifests/shop.json publish ' + w })],
  ['--authorize run', w => ({ command: 'data-insert', args: ['M', 'E', '--authorize', ...w.split(' '), '--keys', 'Id'] })],
  ['--authorize= token', w => ({ command: 'data-insert M E', args: ['--authorize=' + w.split(' ').join(' '), '--keys', 'Id'] })],
];
function casesOf(tool) {
  const twin = PLACES.reduce((v, keys) => setAt(v, keys, MARKER), {});
  const read = new Set(detected(tool, twin));
  const fields = PLACES.filter(keys => read.has(keys.join('/')));
  const cases = [{ label: 'fields', args: fields.reduce((v, keys) => setAt(v, keys, words()), {}), expect: fields.map(keys => keys.join('/')), keys: fields }];
  for (const [label, line] of LINES) if (detected(tool, line(MARKER)).includes('command/args')) cases.push({ label, args: line(words()), expect: ['command/args'], keys: [], line: true });
  return cases;
}

const RECENT = () => new Date(Date.now() - 10000).toISOString();
const MISMATCH = { ok: false, code: 'STUDIO_VERSION_MISMATCH', message: 'synthetic: the Studio of this lane is another version' };
const STATES = [
  ['agent reconnecting', { connected: false, info: { lastSeenAt: RECENT() } }],
  ['agent never seen', { connected: false }],
  ['no agent credential', { info: { credential: false } }],
  ['Studio not served', { info: { compatible: { odc: MISMATCH, o11: MISMATCH } } }],
  ['no Service Studio', { record: null }],
  ['workspace full', { full: true }],
  ['lane off', { lanes: [] }],
  ['kernel lane off', { kernelRefused: { odc: { image: '1.7.28', kernel: '1.7.27' }, o11: { image: '11.55.92', kernel: '11.55.91' } } }],
  ['patch verified', { extra: { patch: 'verified', basedOn: { job: 'ws:odc/jobs/n1-job.json' }, query: { kind: 'check-job', patch: 'verified', basedOn: { job: 'ws:odc/jobs/n1-job.json' } } } }],
  ['deleting', { extra: { action: 'delete', operation: 'delete', op: 'delete' } }],
  ['let through', {}],
];
const pointerKeys = pointer => pointer.split('/').slice(1).map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'));
// The arguments under which a pointer holds a path (hosted/policy.mjs pathOnlyWhen): ssam_reference reads its query as a job
// file only for check-job, and query.job only beside a patch or basedOn.
const POINTER_CONTEXT = { 'ssam_reference /query': { kind: 'check-job' }, 'ssam_reference /query/basedOn/job': { kind: 'check-job' },
  'ssam_reference /query/job': { kind: 'check-job', query: { patch: [] } } };

async function gateAnswer(tool, args, { connected = true, info = {}, record = { pid: 6001 }, full = false, lanes = ['odc', 'o11'], kernelRefused = null }) {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, connected, info });
  const executor = { id: 'fake-executor', hosted: true, quota: { full: () => full }, o11Connection: () => record,
    async call(kind, params) { return kind === 'studio.processes' ? { processes: [{ pid: 4120, path: 'C:\\Customer\\' + params.image, version: '1.7.28.4021' }] } : {}; },
    async pullFile() { throw Object.assign(new Error('no such agent file'), { code: 'FILE_NOT_FOUND' }); } };
  const context = { id: 'ctx-n1', hosted: true, tokenId: 'tok_test', customer: 'Synthetic', lanes, workspace: dirs.workspace, agent: link, executor, close: async () => {} };
  const calls = [];
  const handler = async (received) => { calls.push(structuredClone(received)); return reply({ ok: true }); };
  const wrapped = wrapHostedTool(tool, { inputSchema: {} }, handler, { context, link, lanes, run: (ctx, fn) => fn(), waitMs: 10, kernelRefused });
  let answer;
  try { answer = await wrapped(structuredClone(args), { requestId: 1 }); }
  catch (error) { answer = { thrown: String(error?.message ?? error) }; }
  return { answer, calls };
}

test('N1: every tool, every refusal and continuation of the hosted gate, every words field: no word comes back; a repeated call asks the owner and is WORDS_REQUIRED as it came', async t => {
  const tools = hostedTools();
  const problems = [], echoes = new Set(), codes = new Map(), answered = new Map();
  let answers = 0, through = 0;
  for (const [tool, entry] of Object.entries(tools)) {
    const pointers = [...new Set([...(entry?.paths?.in ?? []), ...(entry?.paths?.out ?? [])])];
    const states = [...STATES, ...pointers.map(p => ['outside ' + p, { at: p, extra: POINTER_CONTEXT[tool + ' ' + p] }])];
    for (const c of casesOf(tool)) for (const [state, options] of states) {
      let args = { ...structuredClone(c.args), ...(options.extra ?? {}) };
      if (options.at) args = setAt(args, pointerKeys(options.at), OUTSIDE);
      const { answer, calls } = await gateAnswer(tool, args, options);
      answers++;
      const where = `${tool} [${c.label}] ${state}`;
      if (answer.thrown) { problems.push(where + ': the gate threw ' + answer.thrown); continue; }
      const code = answer.structuredContent?.code ?? (answer.structuredContent?.ok === true ? 'ok' : '?');
      codes.set(code, (codes.get(code) ?? 0) + 1);
      answered.set(`${tool} ${c.label} ${state}`, answer.structuredContent?.cause ? code + '/' + answer.structuredContent.cause : code);
      // the handler got the words as sent: the mask is of echoes only
      for (const call of calls) {
        through++;
        for (const keys of c.keys) if (getAt(call, keys) !== getAt(args, keys)) problems.push(where + ': the handler did not get the words as sent at ' + keys.join('/'));
        if (c.line && JSON.stringify(call).match(TOKEN)?.[0] !== JSON.stringify(args).match(TOKEN)?.[0]) problems.push(where + ': the handler did not get the line as sent');
      }
      if (calls.length) continue; // let through: the hub's exit answers (its own tests)
      const seen = JSON.stringify(answer.content ?? []) + JSON.stringify(answer.structuredContent ?? null);
      if (TOKEN.test(seen)) problems.push(where + ' (' + code + '): a word came back: ' + seen.match(/.{0,120}N1q\d+z/)[0]);
      for (const step of stepsOf(answer.structuredContent)) {
        if (step.tool !== tool) continue; // a step to another tool (doctor, discover, connect) repeats none of this call
        const present = c.line ? (JSON.stringify(step.arguments).includes(MARKER) || TOKEN.test(JSON.stringify(step.arguments)) ? c.expect : [])
          : c.keys.filter(keys => getAt(step.arguments, keys) !== undefined).map(keys => keys.join('/'));
        if (!present.length) continue;
        for (const keys of c.keys) if (getAt(step.arguments, keys) !== undefined && getAt(step.arguments, keys) !== MARKER) problems.push(where + ': ' + keys.join('/') + ' is no marker in the step');
        if (c.line && !JSON.stringify(step.arguments).includes(MARKER)) problems.push(where + ': the line of the step holds no marker');
        if (JSON.stringify([...(step.askOwner?.fields ?? [])].sort()) !== JSON.stringify([...present].sort())) problems.push(where + ': askOwner.fields ' + JSON.stringify(step.askOwner?.fields ?? null) + ' for ' + JSON.stringify(present));
        if (!String(step.why ?? '').endsWith(ASK)) problems.push(where + ': the why does not ask the owner: ' + String(step.why ?? '').slice(-120));
        const again = new Set(detected(step.tool, step.arguments));
        for (const p of present) if (!again.has(p)) problems.push(where + ': replayed as it came, ' + p + ' would not be WORDS_REQUIRED');
        echoes.add(`${tool} ${c.label} ${code}`);
      }
    }
  }
  t.diagnostic('n1-gate ' + JSON.stringify({ tools: Object.keys(tools).length, answers, through, echoes: echoes.size, codes: Object.fromEntries(codes) }));
  const pointerAnswers = Object.entries(tools).filter(([, e]) => e?.class !== 'unavailable').flatMap(([name, e]) =>
    [...new Set([...(e.paths?.in ?? []), ...(e.paths?.out ?? [])])].map(p => [name + ' ' + p, answered.get(`${name} fields outside ${p}`)]));
  // Every pointer of the catalog refused the path outside the workspace (the tools that delete are refused before, T2).
  assert.deepEqual(pointerAnswers.filter(([, code]) => code !== 'PATH_OUTSIDE_WORKSPACE' && code !== 'HOSTED_UNAVAILABLE/DESTRUCTIVE_HOSTED_OFF'), [], 'every pointer answered PATH_OUTSIDE_WORKSPACE');
  t.diagnostic('n1-gate-pointers ' + JSON.stringify({ pointers: pointerAnswers.length, outside: pointerAnswers.filter(([, code]) => code === 'PATH_OUTSIDE_WORKSPACE').length }));
  assert.deepEqual(problems.slice(0, 40), [], problems.length + ' problem(s)');
  // The sweep reached the echoes it is about (a floor: the N1 cases, the B cases and the line of studio_command).
  for (const must of ['studio_authorize fields AGENT_RECONNECTING', 'studio_authorize fields PATH_OUTSIDE_WORKSPACE', 'studio_publish fields AGENT_RECONNECTING',
    'studio_data_insert fields PATH_OUTSIDE_WORKSPACE', 'o11_data fields PATH_OUTSIDE_WORKSPACE', 'studio_deliver fields PATH_OUTSIDE_WORKSPACE', 'ssam_job fields HOSTED_UNAVAILABLE',
    'studio_command authorize line AGENT_RECONNECTING', 'studio_command --authorize run PATH_OUTSIDE_WORKSPACE', 'studio_command --authorize= token AGENT_RECONNECTING'])
    assert.ok(echoes.has(must), 'the sweep reached ' + must + ' (' + [...echoes].filter(e => e.startsWith(must.split(' ')[0] + ' ')).join('; ') + ')');
  // Every tool that needs the agent repeated itself while the agent reconnects, masked; a tool that deletes is refused by the
  // gate before the agent and repeats nothing (T2, DESTRUCTIVE_HOSTED_OFF).
  const always = Object.entries(tools).filter(([, e]) => e?.agent === 'always' && e.class !== 'unavailable').map(([name]) => name);
  const notRepeated = always.filter(name => !echoes.has(name + ' fields AGENT_RECONNECTING'));
  assert.deepEqual(notRepeated.filter(name => answered.get(name + ' fields agent reconnecting') !== 'HOSTED_UNAVAILABLE/DESTRUCTIVE_HOSTED_OFF'), [],
    'every tool that needs the agent repeated itself masked: ' + notRepeated.map(name => name + ' ' + answered.get(name + ' fields agent reconnecting')).join('; '));
  assert.deepEqual(notRepeated.sort(), ['odc_a2a_connection_delete', 'odc_asset_delete', 'studio_data_delete'], 'only the tools that delete are refused before the agent');
});

// The string fields of a JSON schema, as key lists (an array item is index 0), up to depth 8.
function stringFields(schema) {
  const out = [];
  const walk = (s, at, depth) => {
    if (!s || typeof s !== 'object' || depth > 8) return;
    const types = [].concat(s.type ?? []);
    if (at.length && (types.includes('string') || s.enum || s.const !== undefined) && !types.includes('object')) out.push(at);
    for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, [...at, k], depth + 1);
    if (s.items && typeof s.items === 'object') walk(s.items, [...at, 0], depth + 1);
    for (const alt of [...(s.anyOf ?? []), ...(s.oneOf ?? []), ...(s.allOf ?? [])]) walk(alt, at, depth + 1);
  };
  walk(schema, [], 0);
  const seen = new Set();
  return out.filter(keys => { const id = keys.join('/'); if (seen.has(id)) return false; seen.add(id); return true; });
}

test('N1 (one rule): over the live schemas of every tool of the hub, the mask of a step, of a corrected and of an MCP result covers every field the detector reads', async t => {
  const hub = await createSsamServer({ o11: true, odc: true, profile: 'all', deps: { runAnvil: async () => ({ ok: false, exitCode: 2, envelope: { ok: false, error: 'fake' } }) } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'n1-one-rule', version: '1.0.0' });
  await Promise.all([hub.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await hub.close(); });
  const { tools } = await client.listTools();
  const problems = [], covered = [];
  for (const tool of tools) {
    for (const keys of stringFields(tool.inputSchema)) {
      const id = keys.join('/');
      if (!detected(tool.name, setAt({}, keys, MARKER)).includes(id)) continue; // not a words field of the detector
      covered.push(tool.name + ':' + id);
      const W = words();
      const args = setAt({}, keys, W);
      const step = ops.withoutWordEchoes({ ok: false, code: 'X', continuation: { tool: tool.name, arguments: args, why: 'the same call' } });
      if (TOKEN.test(JSON.stringify(step))) problems.push(`${tool.name} ${id}: the step gave the words back`);
      if (getAt(step.continuation.arguments, keys) !== MARKER) problems.push(`${tool.name} ${id}: no marker in the step`);
      if (!(step.continuation.askOwner?.fields ?? []).includes(id)) problems.push(`${tool.name} ${id}: askOwner misses it`);
      if (!detected(tool.name, step.continuation.arguments).includes(id)) problems.push(`${tool.name} ${id}: the step replayed would run`);
      const corrected = ops.withoutWordEchoes({ ok: false, code: 'INPUT_INVALID', corrected: args }, { tool: tool.name });
      if (TOKEN.test(JSON.stringify(corrected)) || getAt(corrected.corrected, keys) !== MARKER) problems.push(`${tool.name} ${id}: the corrected gave the words back`);
      const result = ops.resultWithoutWordEchoes(reply({ ok: false, code: 'X', continuation: { tool: tool.name, arguments: args } }), { tool: 'ssam_doctor' });
      if (TOKEN.test(JSON.stringify(result))) problems.push(`${tool.name} ${id}: the MCP result gave the words back (the scan skipped it)`);
    }
  }
  t.diagnostic('n1-one-rule ' + JSON.stringify({ tools: tools.length, fields: covered.length }));
  assert.deepEqual(problems, [], 'one rule for the detector and every echo');
  for (const must of ['studio_authorize:text', 'studio_publish:authorize', 'studio_deliver:authorize', 'o11_data:request/authorization', 'odc_write:ownerRequest', 'ssam_grant:words', 'o11_access:words'])
    assert.ok(covered.includes(must), 'the schemas name ' + must);
});
