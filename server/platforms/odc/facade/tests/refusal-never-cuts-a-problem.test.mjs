import './fixtures/isolated-profile.mjs';
// Review refusal-followups M-A (C:\t\revisoes\refusal-followups\REVISAO.md) and a9-followups-line A (the same family): the
// owner's rule "one refusal with everything". E1 let what a problem carries to go on reach the client, and two things then took
// whole problems out of a refusal, and out of its kept answer:
//   - the details of a problem (the two readings of a FLOW_SYNTAX, candidates, each the patch of the op with the whole list of
//     its flow texts: JobPreflight.cs) counted in the budget of fitProblems, whose last step kept "as many as fit": four such
//     problems came back as one with problemsTotal 4, and two of them before six small ones as one of eight;
//   - the flow refusals put the action now twice, in text and in edit.text (Verbs.Flow.cs FLOW_BASE_REQUIRED, FlowMerge.cs
//     ReadyEdit): three actions of 10.5 KB came back as two problems and no patch.
// The rule, for both lanes, the owner and the licensee: a fit never takes out a problem or a patch. It first reduces what is
// bulky and repeated or optional: a text a document of the problem already carries is not copied, and a long detail becomes,
// in the answer, a reference to the kept answer that says what it was ({omitted, count | characters, read: ssam_evidence});
// every problem stays with its code, where it is and its fix, and the kept answer has every problem with every detail.
// Here on the real paths: ssam_job on a fake CLI (job-runner summarize, refusalFields -> the hub's exit, fitAnswer ->
// exposure), lanes o11 and odc, and the O11 delivery refusal (o11-cycle preflightProblems -> refusalFields -> fitAnswer ->
// exposedResult).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { jobTool } from '../job-runner.mjs';
import { preflightProblems } from '../o11-cycle.mjs';
import { refusalFields } from '../refusal-problems.mjs';
import { fitAnswer } from '../answer-size.mjs';
import { exposedResult } from '../exposure.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { servedBytesStore } from '../served-bytes.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
import { maxAnswerBytes } from '../context-budget.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-never-cuts-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const brief = value => String(JSON.stringify(value, (k, v) => (typeof v === 'string' && v.length > 160 ? v.slice(0, 157) + '...' : v)) ?? '').slice(0, 2000);

// ---- the kernel's problems, in its own shape
// FLOW_SYNTAX with two readings (JobPreflight.cs: Problem(..., patchRule FLOW_TEXT_READING) + candidates, each the patch of the
// op with that reading, FlowTextForm.Patch: replace /ops/0/data/flow with the whole list of texts).
const flowText = j => [`action SyntheticAction${j}(in Value: Integer)`, ...Array.from({ length: 60 }, (_, n) => `  assign Local${n} = Value + ${n}`), 'end'].join('\n');
const TEXTS = [0, 1, 2, 3].map(flowText);
const reading = (j, mark) => { const list = TEXTS.slice(); list[j] = list[j].replace(/\nend$/, '\n' + mark + '\nend'); return [{ op: 'replace', path: '/ops/0/data/flow', value: list }]; };
// ThroughEdit / EndsEdit in words (FlowTextNormalize.cs): four different molds of fix, so none groups with another.
const EDITS = [
  ['insert the line `goto Next` before line 5', 'insert the line `end` before line 5'],
  ['end line 9 with its id `a1`', 'insert the line `end` before line 9'],
  ['insert the line `goto Next` before line 12 and end line 12 with its id `b1`', 'end line 13 with its id `c1`'],
  ['end line 20 with its id `d1` and end line 21 with its id `e1`', 'insert the line `end` before line 20 and insert the line `end` before line 21'],
];
function flowSyntax(j) {
  const [through, ends] = EDITS[j];
  const line = Number(/line (\d+)/.exec(through)[1]);
  return { phase: 'preflight', op: 0, pointer: `/ops/0/data/flow/${j}`, code: 'FLOW_SYNTAX', severity: 'error',
    message: `logic: line ${line}: the branch falls through to the next step without a terminator`,
    fix: `a branch ends without a terminator before line ${line} and the engine does not choose between its two readings: either it goes on to the step after its block (${through}), or it ends there (${ends}); write the one you mean (candidates: the patch of each)`,
    patch: null, _kind: 'logic', patchRule: 'FLOW_TEXT_READING',
    candidates: [{ reading: 'goes on after the block', patch: reading(j, 'goto Next') }, { reading: 'ends', patch: reading(j, 'end') }] };
}
const smallOne = n => ({ phase: 'preflight', op: 0, pointer: `/ops/0/data/flow/${n % 4}`, code: `FLOW_NAME_${'ABCDEF'[n]}`, severity: 'error',
  message: `logic: line ${30 + n}: 'Missing${n}' is not declared`, fix: `declare Missing${n} first`, patch: null });
// A flow refusal with the action now (Verbs.Flow.cs FLOW_BASE_REQUIRED and FlowMerge.cs FLOW_MERGE_REMOVED_USED through
// FlowTextForm.Problem: text = the action now, and the data of the refusal, edit {text, basedOn}, copied onto the problem).
function actionText(name, size) {
  const lines = [`action ${name} @k${name.length}abc (server) "Reads the orders of a customer"`, '  in CustomerId: Long Integer #p1', '  out Orders: Order List #p2', '  local Total: Decimal #l1'];
  for (let i = 1; Buffer.byteLength(lines.join('\n'), 'utf8') < size; i++)
    lines.push(`  n${i} assign #n${i}: Total = Total + If(Orders.Current.Amount > ${i}, Orders.Current.Amount, 0) "step ${i}"`);
  return lines.join('\n');
}
const baseRequired = (i, text) => ({ phase: 'apply', op: 0, pointer: `/ops/0/data/flow/${i}`, code: 'FLOW_BASE_REQUIRED', severity: 'error',
  message: `the header names @kA${i} (an action of a read) and the text has no basedOn: its ids are of that read, and what changed in the Studio since cannot be told from what the text changes`,
  fix: `send the text with basedOn, the textSha of the read it was written on (ssam_map view flow); the edit of this problem is the action now (textSha ${sha(text)}), ready to edit and send`,
  patch: null, id: `kA${i}`, text, edit: { text, basedOn: sha(text) } });
const removedUsed = (i, text) => ({ phase: 'apply', op: 0, pointer: `/ops/0/data/flow/${i}`, code: 'FLOW_MERGE_REMOVED_USED', severity: 'error',
  message: `the text removes Local Total${i} (@kL${i} of the read), and since the read the Studio wrote \`Total${i} + 1\`, which names it: removing it would leave that without it`,
  fix: `keep Local Total${i} in the text, or also change what names it: the action now is in the edit of this problem (edit it and send it with that basedOn)`,
  patch: null, id: `kL${i}`, text, edit: { text, basedOn: sha(text) } });
// Another op's problem with a certain patch, in the same refusal.
const nameInvalid = j => ({ phase: 'preflight', op: j, pointer: `/ops/${j}/data/name`, code: 'NAME_INVALID', severity: 'error',
  message: `the name "Order ${j}" has a space`, fix: 'use the name Order' + j, patch: [{ op: 'replace', path: `/ops/${j}/data/name`, value: 'Order' + j }], patchCertain: true });

const SCENARIOS = {
  'four FLOW_SYNTAX of 16 KB': () => [0, 1, 2, 3].map(flowSyntax),
  'two FLOW_SYNTAX of 16 KB, then six small problems': () => [flowSyntax(0), flowSyntax(1), ...[0, 1, 2, 3, 4, 5].map(smallOne)],
  'three FLOW_BASE_REQUIRED of 10.5 KB': () => [0, 1, 2].map(i => baseRequired(i, actionText('Act' + i, 10750))),
  'three FLOW_MERGE_REMOVED_USED of 10.5 KB': () => [0, 1, 2].map(i => removedUsed(i, actionText('Act' + i, 10750))),
  'two FLOW_BASE_REQUIRED of 17.7 KB': () => [0, 1].map(i => baseRequired(i, actionText('Act' + i, 18125))),
  'three FLOW_BASE_REQUIRED of 10.5 KB and three patches of other ops': () => [...[0, 1, 2].map(i => baseRequired(i, actionText('Act' + i, 10750))), ...[1, 2, 3].map(nameInvalid)],
};

// ---- what the answer must hold
// The entry of the answer for one problem of the kernel: itself, or the group whose pointers name it.
const shownAs = (problems, p) => problems.find(q => q.code === p.code && (q.pointer === p.pointer || (Array.isArray(q.pointers) && q.pointers.includes(p.pointer))));
const isMarker = v => v !== null && typeof v === 'object' && !Array.isArray(v) && v.omitted === true && v.read?.tool === 'ssam_evidence';
// The value a field of the answer stands for: itself, or what its marker's read returns (pages by characters or items).
function readBack(reader, v) {
  if (!isMarker(v)) return v;
  let page = reader.read(v.read.arguments);
  assert.equal(page.ok, true, brief(page));
  if (Array.isArray(page.items)) {
    let items = page.items;
    while (page.next !== undefined) { page = reader.read({ ...v.read.arguments, offset: page.next }); assert.equal(page.ok, true); items = items.concat(page.items); }
    return items;
  }
  let value = page.value;
  while (page.next !== undefined) { page = reader.read({ ...v.read.arguments, offset: page.next }); assert.equal(page.ok, true); value += page.value; }
  return value;
}
// The kept answer: the file of the answer's omitted read, else of a marker in its problems (never the job's result file).
const keptFileOf = body => {
  if (body.omitted?.tool === 'ssam_evidence' && typeof body.omitted.arguments?.file === 'string') return body.omitted.arguments.file;
  const found = [];
  JSON.stringify(body.problems ?? [], (k, v) => { if (isMarker(v) && typeof v.read.arguments?.file === 'string') found.push(v.read.arguments.file); return v; });
  return found[0] ?? null;
};
function checkAnswer(body, kernel, root, label) {
  assert.equal(body.ok, false, label + ': ' + brief(body));
  const problems = body.problems ?? [];
  // every problem stays: its code, where it is and its fix; none is replaced by a total
  assert.equal(body.problemsTotal, undefined, label + ': no problem is cut (problemsTotal): ' + brief(body));
  assert.equal(problems.reduce((n, p) => n + (p.count ?? 1), 0), kernel.length, label + ': every problem: ' + brief(problems.map(p => [p.code, p.pointer ?? p.pointers, p.count])));
  for (const p of kernel) {
    const q = shownAs(problems, p);
    assert.ok(q, label + ': ' + p.code + ' at ' + p.pointer + ' is in the answer: ' + brief(problems.map(x => [x.code, x.pointer ?? x.pointers])));
    assert.equal(typeof q.fix, 'string', label + ': the fix of ' + p.pointer);
  }
  const reader = createEvidenceReader({ roots: [root] });
  // the readings of each FLOW_SYNTAX: in the answer, or the exact read of the kept answer in their place
  for (const p of kernel.filter(x => Array.isArray(x.candidates))) {
    const q = problems.find(x => x.code === p.code && x.pointer === p.pointer);
    assert.ok(q, label + ': the problem itself, not a group: ' + p.pointer);
    assert.ok(q.candidates !== undefined, label + ': the candidates of ' + p.pointer + ' or where they are: ' + brief(q));
    if (isMarker(q.candidates)) assert.equal(q.candidates.count, 2, label + ': the marker says how many readings: ' + brief(q.candidates));
    assert.deepEqual(readBack(reader, q.candidates), p.candidates, label + ': the readings of ' + p.pointer + ', exactly');
  }
  // the action now goes once: in the edit, never again in text (whole, or a cut of it)
  for (const q of problems) assert.ok(!(typeof q.text === 'string' && q.edit && q.text === q.edit.text), label + ': the action text twice in ' + q.pointer);
  for (const p of kernel.filter(x => x.edit)) {
    const q = shownAs(problems, p);
    const again = q.text === undefined ? undefined : readBack(reader, q.text);
    assert.ok(!(typeof again === 'string' && p.edit.text.includes(again.slice(0, 200))), label + ': the action text again, cut, in ' + p.pointer + ': ' + brief(q.text));
    assert.equal(q.edit.basedOn, p.edit.basedOn, label + ': the basedOn of the edit of ' + p.pointer);
    assert.equal(readBack(reader, q.edit.text), p.edit.text, label + ': the action now of ' + p.pointer + ', exactly');
  }
  // the patches of the other ops stay, inline
  const patched = kernel.filter(p => Array.isArray(p.patch) && p.patch.length);
  if (patched.length) {
    const ops = problems.flatMap(q => (Array.isArray(q.patch) ? q.patch : []));
    for (const p of patched) assert.ok(ops.some(op => JSON.stringify(op) === JSON.stringify(p.patch[0])), label + ': the patch of ' + p.pointer + ' inline: ' + brief(problems.map(x => [x.code, x.patch, x.patchIn, x.patchOmitted])));
  }
  // the kept answer has every problem with every detail
  const file = keptFileOf(body);
  if (file) {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const p of kernel) {
      const k = (kept.problems ?? []).find(x => x.code === p.code && (x.pointer === p.pointer || x.pointers?.includes(p.pointer)));
      assert.ok(k, label + ': ' + p.pointer + ' in the kept answer');
      if (p.candidates && k.pointer === p.pointer) assert.deepEqual(k.candidates, p.candidates, label + ': its readings in the kept answer');
      if (p.edit) assert.ok(!(typeof k.text === 'string' && p.edit.text.includes(k.text.slice(0, 200))), label + ': no action text twice in the kept answer');
    }
  }
  assert.ok(bytes(body) <= maxAnswerBytes(), label + ': under the ceiling: ' + bytes(body));
}

// ---- ssam_job on a fake CLI, as a client calls it
const envelope = problems => ({ ok: false, command: 'apply', elapsedMs: 7, code: problems[0].code, error: 'op #0 (logic): ' + problems[0].message, problems });
async function session(t, exposure, lane, problems) {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  const env = { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  const cli = path.join(root, '.local', 'lane-odc', 'cli', 'anvil-odc.dll');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, 'fake');
  const runAnvil = fakeAnvil({ apply: () => ({ exitCode: 1, envelope: envelope(problems) }) });
  const guidance = async (_lane, _job, result) => result;
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const store = servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'day-')) });
  const server = await createSsamServer({ profile: 'all', o11: false, odc: false, deps: { answersRoot: root,
    jobTool: input => jobTool(input, { root, env, o11Lane: 'ss4', runAnvil, guidance, odcRoot: root }),
    exposure: { profile: exposure, caller: () => 'never-cuts-' + exposure + '-' + process.pid, store, dayBytes: 500 * 1024 * 1024 } } });
  const client = new Client({ name: 'refusal-never-cuts', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  let body = await once('ssam_job', { lane, job: { ops: [{ op: 'get', target: 'Action:SyntheticAction0' }] } });
  for (let i = 0; i < 240; i++) {
    const next = [body?.continuation, body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
    if (!next) break;
    await sleep(100); body = await once(next.tool, next.arguments);
  }
  return { root, body };
}

for (const exposure of ['owner', 'licensee']) {
  for (const lane of ['o11', 'odc']) {
    for (const [name, make] of Object.entries(SCENARIOS)) {
      test(`M-A (${exposure}, ${lane}, ssam_job): ${name}: every problem stays, with its fix, its details read exactly, its patch`, async t => {
        const kernel = make();
        const { root, body } = await session(t, exposure, lane, kernel);
        checkAnswer(body, kernel, root, `${exposure} ${lane} ${name}`);
      });
    }
  }
  // The O11 delivery refusal (o11-cycle preflightRefusal: preflightProblems -> refusalFields), then the hub's fit and exposure.
  for (const [name, make] of Object.entries(SCENARIOS)) {
    test(`M-A (${exposure}, o11 delivery): ${name}: every problem stays, with its fix, its details read exactly, its patch`, () => {
      const kernel = make();
      const root = fs.mkdtempSync(path.join(tmp, 'deliver-'));
      const jobFile = path.join(root, 'job.json');
      fs.writeFileSync(jobFile, JSON.stringify({ ops: [{ op: 'logic', target: 'SyntheticModule', data: { flow: TEXTS } }] }));
      const full = { ok: false, outcome: 'refused', code: 'PREFLIGHT_REFUSED', stage: 'preflight', failed: 'preflight', error: kernel[0].message,
        ...refusalFields(preflightProblems(kernel), { problems: kernel }, { job: null, jobFile }) };
      const fitted = fitAnswer('o11_deliver', {}, full, { root });
      const shown = exposedResult({ content: [{ type: 'text', text: JSON.stringify(fitted) }], structuredContent: fitted }, { exposure, tool: 'o11_deliver', args: {} }).structuredContent;
      checkAnswer(shown, kernel, root, `${exposure} o11_deliver ${name}`);
    });
  }
}

test('M-A: the refusal itself (refusalFields) keeps every problem and every patch; a text a document of the problem carries is not copied again', () => {
  for (const [name, make] of Object.entries(SCENARIOS)) {
    const kernel = make();
    for (const [lane, list] of [['ssam_job', kernel], ['o11 delivery', preflightProblems(kernel)]]) {
      const fields = refusalFields(list, {}, { limit: 300 });
      assert.equal(fields.problemsTotal, undefined, `${lane} ${name}: ` + brief(fields.problems?.map(p => [p.code, p.pointer])));
      assert.equal(fields.problems.reduce((n, p) => n + (p.count ?? 1), 0), kernel.length, `${lane} ${name}`);
      assert.equal(fields.problems.filter(p => p.patchOmitted).length, 0, `${lane} ${name}: no patch left out`);
      for (const p of fields.problems) assert.ok(!(typeof p.text === 'string' && typeof p.edit?.text === 'string' && p.edit.text.includes(p.text.slice(0, 200))), `${lane} ${name}: the action text twice`);
      for (const p of kernel.filter(x => x.candidates)) assert.deepEqual(fields.problems.find(q => q.pointer === p.pointer)?.candidates, p.candidates, `${lane} ${name}: the readings whole`);
    }
  }
});

test('L-A (same family): an O11 delivery refusal carries the text of a problem whole, as ssam_job does (no sentence of it dropped, no cut at 4000)', () => {
  const block = 'if Total > 0;\n  assign Msg = "ok"\nelse;\n  assign Msg = "zero"\nend\n// run the deploy.ps1 later.\n  assign Done = True';
  const long = 'x'.repeat(4500);
  const [one, two] = preflightProblems([{ op: 0, pointer: '/ops/0/data/flow', code: 'FLOW_SYNTAX', severity: 'error', message: 'm', fix: 'f', text: block },
    { op: 0, pointer: '/ops/0/data/flow/1', code: 'FLOW_SYNTAX', severity: 'error', message: 'm', fix: 'g', text: long }]);
  assert.equal(one.text, block);
  assert.equal(two.text, long);
});
