// Lane C, C19: no answer of the ssam server goes above the client's ceiling (SSAM_MAX_ANSWER_BYTES, 40960). A bigger one
// is kept whole in <anvilRoot>/.local/answers/<sha256>.json and paged, readable by ssam_evidence; a tool with its own byte
// budget gets the budget held under the ceiling instead; a successful ssam_job answers in about 1 KB and a failed one keeps
// every problem; ssam_map below its smallest page answers the minimal page with the continuation instead of throwing.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as m_ssam from '../ssam.mjs';
const { createSsamServer, pageAnswer, clampBudget, budgetCeiling, maxAnswerBytes, MAX_ANSWER_BYTES } = m_ssam; // a namespace: at the base each test fails on its own rule, not at import
import * as m_job_runner from '../job-runner.mjs';
const { summarize, runJob, SUCCESS_BYTES } = m_job_runner; // a namespace: at the base each test fails on its own rule, not at import
import * as m_module_map from '../module-map.mjs';
const { moduleMap, DEFAULT_MAP_BUDGET } = m_module_map; // a namespace: at the base each test fails on its own rule, not at import
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { moduleIndex, writeCapture, writeIndex } from './fixtures/module-index.mjs';

const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
async function connect(t, server) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pacote-c-answers', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}
const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);

test('a 100 KB answer is kept in .local/answers and paged; ssam_evidence reads the file; small answers pass as they are', async t => {
  const root = temp(t, 'pacote-c-answers-');
  const rows = Array.from({ length: 1000 }, (_, i) => ({ i, text: 'row ' + i + ' ' + 'x'.repeat(80) }));
  const big = { ok: true, lane: 'o11', job: 'C:\\jobs\\big.json', note: 'y'.repeat(2000), continuation: { tool: 'o11_inspect', arguments: { oml: 'C:\\a.oml' } }, rows };
  assert.ok(bytes(big) > 100000);
  let answer = big;
  const server = await createSsamServer({ o11: false, odc: false, deps: { jobTool: async () => answer, answersRoot: root, evidence: { roots: [path.join(root, '.local')] } } });
  const client = await connect(t, server);
  const reply = await client.callTool({ name: 'o11_job', arguments: { job: [{ op: 'find', kind: 'Entity' }] } });
  assert.ok(bytes(reply.content[0].text) <= MAX_ANSWER_BYTES, bytes(reply.content[0].text) + ' bytes');
  // The per-kind policy now runs before the ceiling: this job receipt fits 2 KB and
  // its omitted rows remain exact evidence. Exercise the 40 KB safety net separately.
  const receipt = valueOf(reply);
  assert.ok(bytes(reply.content[0].text) <= 2048);
  assert.ok(receipt.omitted);
  assert.equal(JSON.parse(fs.readFileSync(receipt.omitted.arguments.file, 'utf8')).rows.length, 1000);
  const value = valueOf(pageAnswer({ content: [{ type: 'text', text: JSON.stringify(big) }], structuredContent: big }, { root }));
  assert.equal(value.ok, true); assert.equal(value.lane, 'o11'); assert.equal(value.job, 'C:\\jobs\\big.json');
  assert.equal(value.note.length, 501, 'a long text stays inline cut, the whole one is in the file');
  assert.deepEqual(value.answerContinuation, big.continuation, "the answer's own continuation is kept beside the paging one");
  assert.equal(value.rows, undefined);
  assert.equal(path.dirname(value.paged.file), path.join(root, '.local', 'answers'));
  assert.ok(value.paged.bytes > 100000);
  const stored = fs.readFileSync(value.paged.file, 'utf8');
  assert.equal(createHash('sha256').update(stored, 'utf8').digest('hex'), value.paged.sha256);
  assert.equal(JSON.parse(stored).rows.length, 1000);
  // The rows do not fit under the ceiling as a table (2026-10-12, paged-answer.mjs): the outline names them and the one
  // continuation reads all of them as a table, within the reader's budget.
  assert.equal(value.paged.complete, false);
  assert.deepEqual(value.paged.outline.map(o => [o.at, o.rows, o.inline]), [['/rows', 1000, false]]);
  assert.deepEqual(value.continuation, { tool: 'ssam_evidence', arguments: { file: value.paged.file, pointer: '/rows', table: true, fields: ['i', 'text'], max: 1000, budgetBytes: 65536 }, why: value.continuation.why });
  // The continuation is a call this server answers.
  const read = await client.callTool({ name: 'ssam_evidence', arguments: { file: value.paged.file, pointer: '/rows/999/i' } });
  assert.notEqual(read.isError, true, read.content[0].text);
  assert.equal(valueOf(read).value, 999);
  // Under the ceiling: untouched, no file.
  const filesBeforeSmall = fs.readdirSync(path.join(root, '.local', 'answers')).length;
  answer = { ok: true, lane: 'o11', small: true };
  const small = valueOf(await client.callTool({ name: 'o11_job', arguments: { job: [{ op: 'find', kind: 'Entity' }] } }));
  assert.equal(small.small, true); assert.equal(small.paged, undefined);
  assert.equal(fs.readdirSync(path.join(root, '.local', 'answers')).length, filesBeforeSmall);
  // pageAnswer alone: a refusal stays a refusal; SSAM_MAX_ANSWER_BYTES moves the ceiling (never below 4096).
  const refused = pageAnswer({ content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'X', rows }) }], isError: true }, { root, maxBytes: 4096 });
  assert.equal(refused.isError, true); assert.equal(refused.structuredContent.code, 'X');
  assert.equal(maxAnswerBytes({ SSAM_MAX_ANSWER_BYTES: '20000' }), 20000); assert.equal(maxAnswerBytes({ SSAM_MAX_ANSWER_BYTES: '100' }), 40960); assert.equal(maxAnswerBytes({}), 40960);
});

test('a tool with its own byte budget gets it held under the ceiling before the call, never paged', async t => {
  const root = temp(t, 'pacote-c-budget-');
  const received = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_inspect', { description: 'Fake inspect with a byte budget.', inputSchema: z.object({ target: z.string(), budgetBytes: z.number().int().optional() }).strict() }, async args => {
      received.push(args.budgetBytes);
      const value = { ok: true, budgetBytes: args.budgetBytes };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot: root, answersRoot: root, lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const client = await connect(t, server);
  const ceiling = budgetCeiling(MAX_ANSWER_BYTES);
  assert.equal(ceiling, MAX_ANSWER_BYTES - 2048);
  for (const [asked, expected] of [[undefined, ceiling], [100000, ceiling], [5000, 5000]]) {
    const reply = await client.callTool({ name: 'studio_inspect', arguments: { target: 'C:\\m.oml', ...(asked ? { budgetBytes: asked } : {}) } });
    assert.equal(valueOf(reply).budgetBytes, expected, String(asked));
  }
  assert.deepEqual(received, [ceiling, ceiling, 5000]);
  // o11_inspect's character budget is held the same way; other arguments are untouched.
  assert.deepEqual(clampBudget({ budget: 60000, max: 60 }, MAX_ANSWER_BYTES), { budget: ceiling, max: 60 });
  assert.deepEqual(clampBudget({ budgetBytes: 2000 }, MAX_ANSWER_BYTES), { budgetBytes: 2000 });
  // The map's own default is the same ceiling.
  assert.equal(DEFAULT_MAP_BUDGET({}), ceiling);
});

test('a successful ssam_job answers in about 1 KB; a refusal keeps every problem, each text cut at 300 characters', async t => {
  const results = Array.from({ length: 40 }, (_, i) => ({ op: 'get', result: { type: 'IServerAction', name: 'Action' + i, properties: { Name: 'Action' + i, Description: 'd'.repeat(200) } } }));
  const data = { accepted: true, isValid: true, ops: 40, objects: 900, applyMs: 1200, messages: Array.from({ length: 30 }, (_, i) => 'message ' + i + ' ' + 'm'.repeat(200)),
    validation: { new: 0, fixed: 0, preexisting: 3, unexpected: 0, missingExpected: 0, ambiguous: 0, tolerated: 3, verdicts: [] },
    details: Array.from({ length: 50 }, (_, i) => 'detail ' + i), policyMessages: ['policy: x'], dataContract: { count: 2, accepted: true, differences: [] }, results };
  const saved = { ok: true, data, via: 'worker', wallMs: 1500,
    capturedProducers: Array.from({ length: 6 }, (_, i) => ({ producer: 'P' + i, kind: 'module', versionIdBefore: i, signatureHash: 'h'.repeat(64), avsigPath: 'C:\\c\\P' + i + '.avsig', avsigSha256: 's'.repeat(64) })) };
  const common = { lane: 'o11', job: 'C:\\k\\.local\\jobs\\inline\\0f6c.json', out: 'C:\\k\\.local\\jobs\\0f6c.oml', resultFile: 'C:\\k\\.local\\jobs\\0f6c.result.json', note: 'n'.repeat(400) };
  const ok = summarize({ ...common, saved });
  assert.equal(ok.ok, true);
  assert.ok(bytes(ok) <= SUCCESS_BYTES - 120, bytes(ok) + ' bytes');
  assert.deepEqual([ok.accepted, ok.isValid, ok.messages, ok.detailsTotal, ok.resultsTotal], [true, true, 30, 50, 40]);
  assert.equal(ok.results, undefined); assert.equal(ok.details, undefined); assert.equal(ok.policyMessages, undefined);
  assert.deepEqual(ok.continuation.arguments, { file: common.resultFile, pointer: '/data/results' });
  for (const p of ok.capturedProducers ?? []) assert.equal(typeof p.producer, 'string', 'a compacted receipt still names its producer');
  // The refusal: the CLI's error envelope of a preflight (B: code PREFLIGHT_REFUSED + problems), every problem kept.
  const problems = [0, 1, 2].map(i => ({ op: i, pointer: '/ops/' + i, code: 'CODE_' + i, severity: 'error', message: 'm'.repeat(1000), fix: 'f'.repeat(400),
    patch: i === 2 ? [{ op: 'replace', path: '/ops/2/x', value: 'v'.repeat(500) }] : [{ op: 'replace', path: '/ops/' + i + '/x', value: 1 }] }));
  const root = temp(t, 'pacote-c-job-');
  fs.mkdirSync(path.join(root, 'tests', 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'jobs', 'three.json'), JSON.stringify({ ops: [{}, {}, {}] }));
  const runAnvil = fakeAnvil({ apply: () => ({ exitCode: 1, envelope: { ok: false, command: 'apply', code: 'PREFLIGHT_REFUSED', error: 'job refused: 3 problems', problems } }) });
  const env = { USERPROFILE: root, LOCALAPPDATA: root, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  const refused = await runJob({ lane: 'o11', job: 'tests/jobs/three.json' }, { root, env, o11Lane: 'ss4', runAnvil });
  assert.deepEqual([refused.ok, refused.code], [false, 'PREFLIGHT_REFUSED']);
  assert.equal(refused.problems.length, 3);
  for (const p of refused.problems) { assert.ok(p.message.length <= 300 && p.fix.length <= 300); assert.match(p.code, /^CODE_\d$/); }
  assert.deepEqual(refused.problems[0].patch, problems[0].patch, 'a small mechanical patch is kept');
  // primeira-certa A3: the patch is the fix patch + basedOn applies: kept whole, whatever its size.
  assert.deepEqual(refused.problems[2].patch, problems[2].patch); assert.equal(refused.problems[2].patchOmitted, undefined);
  // A failed apply (accepted:false) keeps its messages, details and policy messages, as before.
  const failed = summarize({ ...common, saved: { ok: true, data: { ...data, accepted: false, preflight: { problems: problems.slice(0, 1) } }, via: 'worker', wallMs: 1 } });
  assert.equal(failed.ok, false); assert.equal(failed.messages.length, 10); assert.equal(failed.details.length, 10); assert.deepEqual(failed.policyMessages, ['policy: x']);
  assert.equal(failed.problems.length, 1);
});

test('ssam_map below its smallest page answers the minimal page with size "insufficient" and the next call, never an exception', async t => {
  const dir = temp(t, 'pacote-c-map-');
  const store = path.join(dir, 'store');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  const capture = writeCapture(dir);
  // 300 roles counted: the counts alone do not fit 2000 bytes, and roles are never dropped.
  const byRole = Object.fromEntries(Array.from({ length: 300 }, (_, i) => ['role' + i, i]));
  writeIndex(store, 'odc', capture.sha256, moduleIndex({ lane: 'odc', sourceSha256: capture.sha256, overrides: { counts: { elements: 14, byKind: {}, byRole } } }));
  const map = await moduleMap({ lane: 'odc', target: capture.file, budgetBytes: 2000, kind: 'MobileScreen' }, { env, read: async () => { throw new Error('no reader on a hit'); } });
  assert.equal(map.ok, true, map.error);
  assert.equal(map.size.status, 'insufficient');
  assert.deepEqual([map.returned, map.entries.length], [0, 0]);
  assert.ok(map.size.minimalBytes > 2000);
  const next = map.continuation;
  assert.equal(next.tool, 'ssam_map');
  assert.deepEqual([next.arguments.kind, next.arguments.expectedSourceSha256, next.arguments.offset], ['MobileScreen', capture.sha256, 0]);
  assert.ok(next.arguments.budgetBytes >= map.size.minimalBytes, 'the next call asks a budget that holds a page');
  const page = await moduleMap({ lane: 'odc', ...next.arguments }, { env, read: async () => { throw new Error('no reader on a hit'); } });
  assert.equal(page.ok, true, page.error); assert.ok(page.returned > 0);
});
