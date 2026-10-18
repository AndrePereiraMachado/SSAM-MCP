import './fixtures/isolated-profile.mjs';
// Round 2 of fix/no-internals (review C:\t\revisoes\no-internals\REVISAO.md): the licensee rule must never change USE.
// - HIGH 1: expressions, signatures and the customer's own names pass as they are (CurrDateTime(), GetUserId(): UserId,
//   Count(GetLabTests.List), (Review.Status = "Open"), an entity LabTests, a screen UnitTests, attributes PA1 and CX15);
// - MEDIUM 2: keys of use stay (problems[].origin of ssam_code, an evidence's guidance and limits) and the customer's data
//   keeps keys named left, basis, coverage, identity, level, source or evidence;
// - MEDIUM 3: the day of a caller's reference holds across ssam_evidence of a reference file, across server instances on
//   one folder and across parallel calls; a job check is never refused by it;
// - MEDIUM 4: the coverage matrix is refused whatever form its id takes, and a find never lists it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exposedResult } from '../exposure.mjs';
import { servedBytesStore } from '../served-bytes.mjs';
import { findings } from './fixtures/internal-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const cliBuilt = fs.existsSync(path.join(kernel, '.local', 'cli', 'anvil.dll')) && fs.existsSync(path.join(kernel, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-internals-use-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const roots = ['C:\\srv\\ssam\\kernel\\.local'];
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const licensee = (tool, value, args = {}) => exposedResult(result(value), { exposure: 'licensee', handleRoots: roots, tool, args }).structuredContent;

// ---- HIGH 1 and MEDIUM 2, on the exit rule itself
const EXPRESSIONS = ['CurrDateTime()', 'GetUserId(): UserId', 'If(Owner.Id = GetUserId(), (Review.Status = "Done"), False)', 'Count(GetLabTests.List) > 0 and (Investigation.Date > #2026-01-31#)', '(Review.Status = "Open")', 'NullDate()', 'IContainer.CreateEvent()'];
test('expressions and signatures pass as they are, in every place they travel', () => {
  const functions = { ok: true, lane: 'o11', kind: 'functions', data: { functions: [{ Name: 'GetUserId', Signature: 'GetUserId(): UserId', Group: 'Roles', Description: "Returns the user or 'NullIdentifier()'." }, { Name: 'CurrDateTime', Signature: 'CurrDateTime(): Date Time', Examples: 'AddMinutes(#1982-05-21 22:20:30#, 1) = #1982-05-21 22:21:30#' }] } };
  assert.deepEqual(licensee('ssam_reference', functions, { kind: 'functions' }), functions);
  const refusal = { ok: false, code: 'PREFLIGHT_REFUSED', problems: EXPRESSIONS.map((e, i) => ({ code: 'X', pointer: '/ops/' + i, message: 'condition ' + e + ' of $LabTests.ReviewedOn', fix: 'set Condition to ' + e,
    patch: [{ op: 'replace', path: '/ops/' + i + '/condition', value: e }] })) };
  assert.deepEqual(licensee('ssam_job', refusal).problems, refusal.problems);
  const ddl = { ok: true, text: { 'ssam-ddl/1': { example: { text: 'create entity LabTests (\n  ReviewedOn Date Time default CurrDateTime(),\n  Owner User Identifier default GetUserId()\n);' } } },
    examples: { x: { job: 'x', ops: [{ op: 'logic', data: { condition: EXPRESSIONS[2] } }] } }, values: [{ property: 'Condition', set: [EXPRESSIONS[1]], rule: 'an expression such as ' + EXPRESSIONS[0] }] };
  // a card's example and rules: code, even when a line starts like a path (/// a description comment)
  const card = { ok: true, card: { rules: ['/// lines right above an element are its description.'], example: '/// A customer.\ncreate entity Customer (\n  Id Long Integer identifier auto\n);' } };
  assert.deepEqual(licensee('ssam_reference', card, { kind: 'api' }), card);
  const after = licensee('ssam_discover', ddl);
  assert.equal(after.text['ssam-ddl/1'].example.text, ddl.text['ssam-ddl/1'].example.text);
  assert.deepEqual(after.examples.x.ops, ddl.examples.x.ops);
  assert.deepEqual(after.values[0].set, ddl.values[0].set);
  assert.match(after.values[0].rule, /CurrDateTime\(\)/);
});
test('the customer\'s names and data keep every name, value and key', () => {
  const map = { ok: true, elements: [
    { key: 'k1', kind: 'ServerAction', name: 'GetLabTests', path: 'Logic/Server Actions/GetLabTests' }, { key: 'k2', kind: 'Entity', name: 'Review' },
    { key: 'k3', kind: 'Screen', name: 'UnitTests' }, { key: 'k4', kind: 'Attribute', name: 'PA1' }, { key: 'k5', kind: 'StaticRecord', name: 'CX15' },
    { key: 'k6', kind: 'Entity', name: 'Suite', description: 'A hotel suite (owner approval needed)' }] };
  assert.deepEqual(licensee('ssam_map', map), map);
  const rows = { ok: true, rows: [{ left: { name: 'A' }, right: { name: 'B' }, basis: 'patch', coverage: 'O11 and ODC', identity: 'x', level: 'declared', evidence: 'the record exists after publish', source: { index: 3, file: 'x' }, origin: 'client', at: 'Step 1\nat least one row is required' }] };
  for (const tool of ['studio_data', 'o11_data', 'odc_portal_read', 'studio_inspect']) assert.deepEqual(licensee(tool, rows), rows, tool);
});
test('ssam_code problems keep their origin; an evidence keeps its guidance and limits, only its level becomes the seal', () => {
  const check = { ok: false, code: 'CODE_CHECK_FAILED', problems: [{ code: 'UNKNOWN_ACTION', message: 'Missing() is not an action of Neutral', origin: { at: 'files/1', file: 'C:\\work\\caller.flow', action: 'Caller' } }] };
  assert.deepEqual(licensee('ssam_code', check).problems, check.problems);
  const expand = { ok: true, expansions: { 'integration.rest-expose': { evidence: { level: 'C-executed-historical', proofs: [{ job: 'rest-expose', path: 'tests/jobs/rest-expose.json' }],
    negative: [], guidance: 'Addressing outside the creating job: IRestService:<Service> and IRestService:<Service>/<Method>.',
    limits: [{ text: 'The URLPath rewrite on rename is measured on ODC only.', origin: 'tests/jobs/rename-logic-propagation.json' }] } } } };
  const ev = licensee('ssam_discover', expand).expansions['integration.rest-expose'].evidence;
  assert.equal(ev.level, 'proven');
  assert.equal(ev.guidance, expand.expansions['integration.rest-expose'].evidence.guidance);
  assert.deepEqual(ev.limits, [{ text: 'The URLPath rewrite on rename is measured on ODC only.' }]);
  assert.equal(ev.proofs, undefined);
  assert.deepEqual(findings(ev), []);
});
test('a failure of the exit rule never loses the outcome of a call', () => {
  const bad = { ok: true, outcome: 'merged', code: 'DELIVERED', continuation: { tool: 'ssam_app_url', arguments: { app: 'A' } }, get trap() { throw new Error('boom'); } };
  const out = exposedResult({ content: [{ type: 'text', text: '{}' }], structuredContent: bad }, { exposure: 'licensee', handleRoots: roots, tool: 'o11_deliver' }).structuredContent;
  assert.equal(out.ok, true); assert.equal(out.outcome, 'merged'); assert.equal(out.code, 'DELIVERED'); assert.deepEqual(out.continuation, bad.continuation);
});

// ---- live: the same calls on an owner and a licensee server
async function session(exposure, extra = {}, deps = {}) {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const server = await createSsamServer({ profile: 'all', deps: { ...deps, exposure: { profile: exposure, caller: () => 'use-' + exposure + '-' + process.pid, ...extra } } });
  const client = new Client({ name: 'no-internals-use', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  // a call the deadline detached (a cold CLI past its budget) is followed with continueTask to its final answer
  const call = async (name, args) => {
    let body = await once(name, args);
    for (let i = 0; i < 40; i++) {
      const next = [body?.continuation, body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
      if (!next) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
      body = await once(next.tool, next.arguments);
    }
    return body;
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}
async function both(calls) {
  const out = {};
  for (const exposure of ['owner', 'licensee']) {
    const s = await session(exposure, { store: servedBytesStore({ dir: path.join(tmp, 'both-' + exposure) }) });
    try { out[exposure] = []; for (const [name, args] of calls) out[exposure].push(await s.call(name, args)); } finally { await s.close(); }
  }
  return out;
}

test('live: a refusal on the customer\'s names, a function signature and ssam_code origins read the same in both profiles', { skip: !cliBuilt && 'the lane CLIs are not built in this checkout', timeout: 900000 }, async () => {
  const base = path.join(kernel, 'tests', 'fixtures', 'blank-service.oml');
  const job = { description: 'synthetic probe', base, ops: [{ op: 'spec', data: { entities: [{ name: 'LabTests', attributes: [{ name: 'ReviewedOn', type: 'DateTim', default: 'CurrDateTime()' }] }] } }] };
  const dir = path.join(tmp, 'code'); fs.mkdirSync(dir, { recursive: true });
  const flow = path.join(dir, 'caller.flow'); fs.writeFileSync(flow, 'server action Caller\n  call Missing()\nend\n');
  const { owner, licensee: lic } = await both([
    ['ssam_job', { lane: 'o11', job }],
    ['ssam_reference', { lane: 'o11', kind: 'functions', query: 'GetUserId CurrDateTime' }],
    ['ssam_code', { action: 'check', lane: 'o11', module: 'Neutral', base, files: [flow, path.join(dir, 'missing.flow')] }],
  ]);
  assert.deepEqual(lic[0].problems.map(p => [p.message, p.fix, p.pointer]), owner[0].problems.map(p => [p.message, p.fix, p.pointer]));
  assert.match(JSON.stringify(lic[0].problems), /LabTests/);
  assert.deepEqual(lic[1].data, owner[1].data);
  assert.match(JSON.stringify(lic[1]), /GetUserId\(\): UserId/);
  assert.deepEqual((lic[2].problems ?? []).map(p => p.origin), (owner[2].problems ?? []).map(p => p.origin));
  assert.ok((owner[2].problems ?? []).some(p => p.origin), JSON.stringify(owner[2]).slice(0, 300));
});
test('live: a discover expansion keeps the evidence\'s guidance', { skip: !cliBuilt && 'the lane CLIs are not built in this checkout', timeout: 900000 }, async () => {
  const { owner, licensee: lic } = await both([['ssam_discover', { lane: 'o11', expand: 'integration.rest-expose:example+evidence' }]]);
  const o = owner[0].expansions['integration.rest-expose'].evidence; const l = lic[0].expansions['integration.rest-expose'].evidence;
  assert.equal(l.guidance, o.guidance);
  assert.equal(l.limits.length, o.limits.length);
  assert.equal(l.level, 'proven');
});

test('live: the coverage matrix is refused whatever form its id takes, and no find lists it', async () => {
  const s = await session('licensee', { store: servedBytesStore({ dir: path.join(tmp, 'matrix') }) });
  try {
    for (const [lane, query] of [['odc', 'jobs-odc\\examples\\matriz'], ['o11', 'jobs/examples/matriz'], ['o11', 'examples/matriz.json'], ['o11', ' MATRIX'], ['odc', { id: 'jobs-odc/examples/Matriz.json' }]]) {
      const answer = await s.call('ssam_reference', { lane, kind: 'example', query });
      assert.equal(answer.code, 'REFERENCE_NOT_SERVED', JSON.stringify(query) + ' ' + JSON.stringify(answer).slice(0, 200));
    }
    for (const find of ['coverage matrix', 'matriz']) {
      const answer = await s.call('ssam_reference', { lane: 'o11', kind: 'example', query: { find } });
      assert.ok(!(answer.matches ?? []).some(m => /matriz/i.test(m.id) || m.kind === 'matrix'), JSON.stringify(answer).slice(0, 300));
    }
  } finally { await s.close(); }
});

test('live: the day holds across ssam_evidence of a reference file, a job check is not refused by it', async () => {
  const s = await session('licensee', { store: servedBytesStore({ dir: path.join(tmp, 'day') }), dayBytes: 4000 });
  try {
    const big = await s.call('ssam_reference', { lane: 'odc', kind: 'example', query: { id: 'jobs-odc/action-edit-lifecycle' } });
    const file = big.continuation?.arguments?.file;
    assert.ok(file && fs.existsSync(file), JSON.stringify(big).slice(0, 300));
    // the reference file read in pages counts as reference
    const page = await s.call('ssam_evidence', { file, budgetBytes: 28672 });
    assert.notEqual(page.code, 'REFERENCE_DAY_LIMIT');
    const after = await s.call('ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' });
    assert.equal(after.code, 'REFERENCE_DAY_LIMIT');
    const again = await s.call('ssam_evidence', { file, budgetBytes: 28672 });
    assert.equal(again.code, 'REFERENCE_DAY_LIMIT', JSON.stringify(again).slice(0, 200));
    // a job check stays: it checks the licensee's own job
    const check = await s.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: { description: 'x', ops: [] } });
    assert.notEqual(check.code, 'REFERENCE_DAY_LIMIT');
  } finally { await s.close(); }
});

test('the day of a caller is one count per folder: two server instances, two stores, parallel calls', async () => {
  const dir = path.join(tmp, 'shared');
  const a = servedBytesStore({ dir }); const b = servedBytesStore({ dir });
  a.usage('tok'); b.usage('tok');
  for (let i = 0; i < 5; i++) { a.record('tok', 'ssam_reference', 100000); b.record('tok', 'ssam_reference', 100000); }
  assert.equal(a.usage('tok'), 1000000); assert.equal(b.usage('tok'), 1000000); assert.equal(servedBytesStore({ dir }).usage('tok'), 1000000);
  // two tokens that differ only in characters outside the id set are two callers
  a.record('abc+/=', 'ssam_reference', 1); a.record('xyz+/=', 'ssam_reference', 2);
  assert.equal(a.usage('abc+/='), 1); assert.equal(a.usage('xyz+/='), 2);
  // parallel calls of one caller: the bytes are reserved before the answer, so they never pass the day together
  const s = await session('licensee', { store: servedBytesStore({ dir: path.join(tmp, 'parallel') }), dayBytes: 15000, callBytes: 16384 });
  try {
    const answers = await Promise.all([1, 2, 3].map(() => s.call('ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' })));
    assert.equal(answers.filter(x => x.ok === true).length, 1, JSON.stringify(answers.map(x => x.code ?? x.ok)));
  } finally { await s.close(); }
});

// ---- round 3 (re-review C:\t\revisoes\no-internals-2\REVISAO.md, MEDIUM A and B): a reference file read back with
// ssam_evidence is SSAM's documentation, whatever way its path is written, for the filter and for the day alike.
const pagesOf = async (s, file) => {
  const pages = [];
  for (let offset = 0, n = 0; n < 20; n++) {
    const page = await s.call('ssam_evidence', { file, budgetBytes: 28672, ...(offset ? { offset } : {}) });
    pages.push(page);
    if (page.ok !== true || page.next == null) break;
    offset = page.next;
  }
  return pages;
};
const variants = file => {
  const dir = path.dirname(file); const name = path.basename(file); const parent = path.basename(dir);
  return [['plain', file], ['double separator', dir + '\\\\' + name], ['dot segment', dir + '\\.\\' + name], ['parent segment', dir + '\\..\\' + parent + '\\' + name],
    ['forward slashes', file.replaceAll('\\', '/')], ['other case', dir.toUpperCase() + '\\' + name]];
};
const opsOf = value => JSON.stringify(value, (k, v) => v).match(/"ops":\[[^\]]*\]/g) ?? [];
test('live: a reference file read back with ssam_evidence is scrubbed as documentation, its ops as they are (MEDIUM A)', { skip: !cliBuilt && 'the lane CLIs are not built in this checkout', timeout: 900000 }, async () => {
  const out = {};
  for (const exposure of ['owner', 'licensee']) {
    const s = await session(exposure, { store: servedBytesStore({ dir: path.join(tmp, 'evidence-' + exposure) }) });
    try {
      const first = await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' });
      const file = first.continuation?.arguments?.file;
      assert.ok(file, JSON.stringify(first).slice(0, 300));
      out[exposure] = { file, pages: await pagesOf(s, file) };
    } finally { await s.close(); }
  }
  assert.ok(out.owner.pages.some(p => findings(p).length), 'the owner pages carry internals (the test is not vacuous)');
  for (const page of out.licensee.pages) assert.deepEqual(findings(page).map(f => f.family + ' ' + f.at + ' ' + f.sample.slice(0, 120)), []);
  assert.deepEqual(out.licensee.pages.flatMap(opsOf), out.owner.pages.flatMap(opsOf));
});
test('live: any way of writing a reference file\'s path is the same file for the day and the filter (MEDIUM B)', { skip: !cliBuilt && 'the lane CLIs are not built in this checkout', timeout: 900000 }, async () => {
  // under the day: every variant is documentation (no internals)
  const open = await session('licensee', { store: servedBytesStore({ dir: path.join(tmp, 'variants-open') }) });
  try {
    const file = (await open.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' })).continuation.arguments.file;
    for (const [label, variant] of variants(file)) {
      const page = await open.call('ssam_evidence', { file: variant, budgetBytes: 28672 });
      assert.equal(page.ok, true, label + ' ' + JSON.stringify(page).slice(0, 200));
      assert.deepEqual(findings(page).map(f => f.family + ' ' + f.sample.slice(0, 100)), [], label);
    }
  } finally { await open.close(); }
  // past the day: every variant is refused
  const shut = await session('licensee', { store: servedBytesStore({ dir: path.join(tmp, 'variants-shut') }), dayBytes: 3000 });
  try {
    const file = (await shut.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' })).continuation.arguments.file;
    assert.equal((await shut.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: 'timer' })).code, 'REFERENCE_DAY_LIMIT');
    for (const [label, variant] of variants(file)) assert.equal((await shut.call('ssam_evidence', { file: variant, budgetBytes: 28672 })).code, 'REFERENCE_DAY_LIMIT', label);
  } finally { await shut.close(); }
});
