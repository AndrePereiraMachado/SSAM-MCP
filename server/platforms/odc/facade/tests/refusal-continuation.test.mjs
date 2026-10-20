import './fixtures/isolated-profile.mjs';
// Review vps-a9, E1 (C:\t\revisoes\vps-a9\REVISAO.md): a refusal that carries what is needed to go on reaches the client with
// it. The kernel puts it on the problem itself (HTML_BASE_CHANGED and HTML_KEY_FOREIGN: current {html, text, elements?},
// next {basedOn}, k; a flow or data merge: edit {text|ddl, basedOn}, merged; a choice: candidates), and the facade's problemOf
// copied a closed list of fields that left all of them out, for the owner and the licensee alike. Here, on the real path:
// the kernel's envelope -> job-runner summarize (problemsOf, refusalFields, fitProblems, problemOf) -> the hub's exit
// (shapeToolResult, fitAnswer, pageAnswer) -> exposure, through ssam_job on a fake CLI.
//   1. the fields arrive whole, for the owner and the licensee;
//   2. two problems with different current texts are never grouped into one (the answer groups equal problems);
//   3. a screen longer than the answer's ceiling: the answer stays under it and, where the text was, the problem says the
//      exact read that returns it (ssam_evidence on the kept answer, by characters when longer than one read), and the read
//      gives back the very text; the patch and the fix stay;
//   4. the kernel's texts name where the field is: never data.current / data.edit (the fields are on the problem).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobTool } from '../job-runner.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { servedBytesStore } from '../served-bytes.mjs';
import { createEvidenceReader } from '../ssam-evidence.mjs';
import { maxAnswerBytes } from '../context-budget.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-continuation-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const brief = value => JSON.stringify(value).slice(0, 1500);

const READING = 'd'.repeat(64);
const screenOf = (name, filler = '') => `<screen name="${name}" k="w1">\n<div class="banner" k="w5">Novos pedidos</div>\n${filler}<table k="w9"><thead><tr><th>Data</th></tr></thead></table>\n</screen>`;
// The problem WholeDocumentRebased writes (Verbs.ScreenHtml.cs), with its patch, current and next.
function baseChanged(name, text, capture) {
  return { phase: 'apply', op: 0, pointer: '/basedOn', code: 'HTML_BASE_CHANGED', severity: 'error',
    message: `${name} is not the reading 0123456789ab the element edits (the document they make on it) were written on (it changed since; now ${READING.slice(0, 12)}), and the three-way merge could not lay it over that reading: the element edits would write that reading back over what changed, so nothing is written`,
    fix: `write the edit again on the current text (current.text, basedOn {"capture": "${capture.replace(/\\/g, '\\\\')}", "html": "${READING}"}), or send in 'edit' only the elements it changes, each whole with its k`,
    patch: [{ op: 'replace', path: '/basedOn', value: { capture, html: READING } }, { op: 'replace', path: '/edits', value: [{ set: 'w5', attributes: { class: 'banner wide' } }] }],
    current: { html: READING, text, elements: [{ address: 'w5', edit: 0, k: 'w5', text: '<div class="banner" k="w5">Novos pedidos</div>' }] },
    next: { basedOn: { capture, html: READING } } };
}
// The problem Rebase writes for a k of the reading that is gone (HTML_KEY_FOREIGN), with k and current.
const keyForeign = (name, k, text) => ({ phase: 'apply', op: 0, pointer: '/ops/0/data/edit/0', code: 'HTML_KEY_FOREIGN', severity: 'error',
  message: `k="${k}" of the reading 0123456789ab names an element of ${name} that no longer exists`,
  fix: 'write the edit on the screen\'s current text (current.text of this problem)', k, current: { html: READING, text } });
// A flow merge refusal (Verbs.Flow.cs Problem: the data of the refusal copied onto the problem): the edit ready.
const flowTaken = text => ({ phase: 'apply', op: 0, pointer: '/ops/0/data/flow', code: 'FLOW_MERGE_NAME_TAKEN', severity: 'error',
  message: 'since the read the Studio and the text gave one name to two elements (Local Total, Output Total): they are not the same element',
  fix: 'give the text\'s element another name, or write it on the action now (edit of this problem: the action now, with its basedOn)',
  edit: { text, basedOn: 'e'.repeat(64) }, candidates: ['Total2', 'TotalOut'] });

function envelope(problems) {
  return { ok: false, command: 'apply', elapsedMs: 7, code: problems[0].code,
    error: 'op #0 (html Audit): KernelRefusalException: ' + problems[0].message, problems, stack: '   at Anvil.Core.ModelSession.Apply()' };
}
async function session(t, exposure, problems) {
  const root = fs.mkdtempSync(path.join(tmp, 'root-'));
  const env = { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  const runAnvil = fakeAnvil({ apply: () => ({ exitCode: 1, envelope: envelope(problems) }) });
  // The guidance of a failed job (job-guidance.mjs) reads the discovery index; it is not what these tests are about.
  const guidance = async (lane, job, result) => result;
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const store = servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'day-')) });
  const server = await createSsamServer({ profile: 'all', o11: false, odc: false, deps: { answersRoot: root,
    jobTool: input => jobTool(input, { root, env, o11Lane: 'ss4', runAnvil, guidance }),
    exposure: { profile: exposure, caller: () => 'continuation-' + exposure + '-' + process.pid, store, dayBytes: 500 * 1024 * 1024 } } });
  const client = new Client({ name: 'refusal-continuation', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    return { body: r.structuredContent ?? JSON.parse(r.content[0].text), text: r.content?.[0]?.text ?? '' }; };
  const call = async (name, args) => {
    let answer = await once(name, args);
    for (let i = 0; i < 240; i++) {
      const next = [answer.body?.continuation, answer.body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
      if (!next) break;
      await sleep(100);
      answer = await once(next.tool, next.arguments);
    }
    return answer;
  };
  const job = { ops: [{ op: 'get', target: 'Screen:Audit' }] };
  return { root, call, run: () => call('ssam_job', { lane: 'o11', job }) };
}

for (const exposure of ['owner', 'licensee']) {
  test(`E1 (${exposure}): HTML_BASE_CHANGED and HTML_KEY_FOREIGN reach the client with current, next, k and the patch, through ssam_job`, async t => {
    const capture = path.join(tmp, 'captures', 'audit-7.oml');
    const text = screenOf('Audit');
    const s = await session(t, exposure, [baseChanged('Audit', text, capture)]);
    const { body } = await s.run();
    assert.equal(body.ok, false, brief(body));
    const [p] = body.problems ?? [];
    assert.equal(p?.code, 'HTML_BASE_CHANGED', brief(body));
    assert.equal(p.current?.text, text, 'the current text of the screen, whole: ' + brief(p));
    assert.equal(p.current.html, READING);
    assert.deepEqual(p.current.elements, [{ address: 'w5', edit: 0, k: 'w5', text: '<div class="banner" k="w5">Novos pedidos</div>' }]);
    assert.equal(p.next?.basedOn?.html, READING, 'the next basedOn: ' + brief(p));
    assert.equal(p.patch?.length, 2, 'the patch stays: ' + brief(p));

    const k = await session(t, exposure, [keyForeign('Audit', 'w42', text)]);
    const [q] = (await k.run()).body.problems ?? [];
    assert.equal(q?.k, 'w42', brief(q));
    assert.equal(q.current?.text, text, brief(q));
  });

  test(`E1 (${exposure}): the edit ready and the candidates of a flow merge refusal reach the client`, async t => {
    const action = 'action Total(...)\n  assign Total = 1\nend';
    const s = await session(t, exposure, [flowTaken(action)]);
    const [p] = (await s.run()).body.problems ?? [];
    assert.deepEqual(p?.edit, { text: action, basedOn: 'e'.repeat(64) }, brief(p));
    assert.deepEqual(p.candidates, ['Total2', 'TotalOut']);
  });

  test(`E1 (${exposure}): two screens refused alike are two problems, each with its own current text (never grouped into one)`, async t => {
    const one = screenOf('Audit'), two = screenOf('Orders');
    const s = await session(t, exposure, [keyForeign('Audit', 'w42', one), { ...keyForeign('Orders', 'w43', two), op: 1, pointer: '/ops/1/data/edit/0' }]);
    const { body } = await s.run();
    const texts = (body.problems ?? []).map(p => p.current?.text);
    assert.deepEqual(texts.sort(), [one, two].sort(), brief(body));
    assert.deepEqual((body.problems ?? []).map(p => p.k).sort(), ['w42', 'w43']);
  });

  test(`E1 (${exposure}): two problems on the same screen are one group with the screen's text once; each k is read back exactly`, async t => {
    const text = screenOf('Audit');
    const s = await session(t, exposure, [keyForeign('Audit', 'w42', text), { ...keyForeign('Audit', 'w43', text), pointer: '/ops/0/data/edit/1' }]);
    const { body } = await s.run();
    assert.equal(body.problems?.length, 1, brief(body));
    const [g] = body.problems;
    assert.equal(g.count, 2);
    assert.equal(g.current?.text, text, 'the screen text, once: ' + brief(g));
    assert.equal(g.k, 'w42', 'the first member\'s k, as its message');
    // the members (each with its k) are in the kept answer, by the omitted call
    const reader = createEvidenceReader({ roots: [s.root] });
    const read = body.omitted?.tool === 'ssam_evidence' ? reader.read({ ...body.omitted.arguments, budgetBytes: 28672 }) : null;
    assert.ok(read?.ok, 'the omitted read: ' + brief(body.omitted));
    assert.match(JSON.stringify(read), /"k":"w42"[\s\S]*"k":"w43"/, brief(read));
  });

  test(`E1 (${exposure}): a screen longer than the answer's ceiling: the answer stays under it and the problem says the exact read that returns the text`, async t => {
    const filler = Array.from({ length: 900 }, (_, i) => `<div class="row" k="w${100 + i}">Linha ${i} do relatório de pedidos</div>\n`).join('');
    const text = screenOf('Audit', filler);
    assert.ok(Buffer.byteLength(text) > maxAnswerBytes() + 10000, 'the fixture is longer than the ceiling: ' + Buffer.byteLength(text));
    const capture = path.join(tmp, 'captures', 'audit-8.oml');
    const s = await session(t, exposure, [baseChanged('Audit', text, capture)]);
    const answer = await s.run();
    const { body } = answer;
    assert.ok(Buffer.byteLength(answer.text) <= maxAnswerBytes(), 'under the ceiling: ' + Buffer.byteLength(answer.text));
    assert.equal(body.paged, undefined, 'one answer, not a paged one: ' + brief(body));
    const [p] = body.problems ?? [];
    assert.equal(p?.code, 'HTML_BASE_CHANGED', brief(body));
    assert.equal(p.patch?.length, 2, 'the patch stays: ' + brief(p));
    assert.match(p.fix ?? '', /current\.text/);
    assert.equal(p.current.html, READING, 'the sha256 of the reading stays');
    assert.equal(p.next?.basedOn?.html, READING);
    const marker = p.current.text;
    assert.equal(typeof marker, 'object', brief(p.current));
    assert.equal(marker.omitted, true);
    assert.equal(marker.characters, text.length);
    assert.equal(marker.read?.tool, 'ssam_evidence');
    // The read, as the client sends it (paging by characters with offset = next), gives back the very text.
    const reader = createEvidenceReader({ roots: [s.root] });
    let page = reader.read(marker.read.arguments), got = page.value;
    assert.equal(page.ok, true, brief(page));
    let reads = 1;
    while (page.next !== undefined) { page = reader.read({ ...marker.read.arguments, offset: page.next }); assert.equal(page.ok, true); got += page.value; reads++; }
    assert.equal(got, text, 'the exact text of the screen');
    assert.ok(reads > 1 ? /offset/.test(marker.pages ?? '') : true, 'a text of several reads says how to page it: ' + brief(marker));
  });
}

test('E1: an O11 delivery refusal (o11-cycle preflightProblems -> refusalFields) keeps what the kernel problem carries to go on and its certainty', async () => {
  const { preflightProblems } = await import('../o11-cycle.mjs');
  const { refusalFields } = await import('../refusal-problems.mjs');
  const text = screenOf('Audit');
  const capture = path.join(tmp, 'captures', 'audit-9.oml');
  const choice = { phase: 'apply', op: 1, pointer: '/ops/1/data/html', code: 'HTML_INVALID', severity: 'error', message: 'line 1 col 41: "Hunt" is no expression of the screen',
    fix: 'a text: quote it; a name: write the one the page declares', patch: [{ op: 'replace', path: '/ops/1/data/html', value: '<screen name="Orders"/>' }],
    patchRule: 'TEXT_LITERAL_CHOICE', patchCertain: false, patchChoice: 'quoting it would choose between code and prose.' };
  const { problems } = refusalFields(preflightProblems([baseChanged('Audit', text, capture), keyForeign('Audit', 'w42', text), flowTaken('action A()\nend'), choice]), {});
  const [base, foreign, flow, literal] = problems;
  assert.equal(base.current?.text, text, brief(base));
  assert.equal(base.next?.basedOn?.html, READING);
  assert.equal(foreign.k, 'w42');
  assert.deepEqual(flow.edit, { text: 'action A()\nend', basedOn: 'e'.repeat(64) });
  assert.deepEqual(flow.candidates, ['Total2', 'TotalOut']);
  assert.deepEqual([literal.patchRule, literal.patchCertain, literal.patchChoice], ['TEXT_LITERAL_CHOICE', false, choice.patchChoice], brief(literal));
});

test('E1: the kernel texts name where the field is: the problem carries current/edit, never data.current or data.edit', () => {
  const files = ['Verbs.ScreenHtml.cs', 'Verbs.Flow.cs', 'FlowMerge.cs', 'Verbs.Ddl.cs', 'DataDdlMerge.cs'].map(f => path.join(kernel, 'src', 'Anvil.Core', 'Kernel', f));
  const found = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const m of source.matchAll(/"(?:[^"\\\r\n]|\\.)*"/g)) if (/\bdata\.(?:current|edit)\b/.test(m[0])) found.push(path.basename(file) + ': ' + m[0].slice(0, 140));
  }
  assert.deepEqual(found, []);
});
