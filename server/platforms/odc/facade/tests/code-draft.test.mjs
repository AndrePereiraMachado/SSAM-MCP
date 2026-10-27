import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerSsamCode, writeCall, headerOf, CODE_DESCRIPTION } from '../ssam-code.mjs';
import { DRAFT_TTL_MS } from '../code-draft.mjs';
import { DRAFT_TEXT, DRAFT_CONTRACT } from '../code-draft-schema.mjs';
import { listedTool } from '../tool-listing.mjs';

// R2: the ssam_code draft (code-draft.mjs) with a simulated deliver and check: the registered handler of ssam_code, as the
// server calls it, over a private drafts folder.
const here = path.dirname(fileURLToPath(import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const values = result => result.structuredContent ?? JSON.parse(result.content[0].text);

const DDL_BAD = 'CREATE TABLE Visit (\n  Id INT PRIMARY KEY\n);\n';
const DDL = 'create entity Visit label Title (\n  Id Long Integer identifier auto required,\n  Title Text(120) required\n);\n';
const HTML = '<screen name="Visits" roles="Visitor">\n<div class="visits">Visits</div>\n</screen>\n';
const flow = (name, body = ['assign Count = 1']) => `/// ${name}.\nserver action ${name}\n  out Count: Integer\n${body.map(l => '  ' + l + '\n').join('')}  end\n`;

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-draft-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// The check of a write input as ssam_code check answers it: a node with BADSYNTAX is FLOW_SYNTAX; a call of an action that
// no logic text of the same check (nor the module, `known`) defines is ExpressionUnknownObject; each problem with the
// origin of its part (also/<i>), as code-check.mjs gives it.
function fakeCheck({ known = [] } = {}) {
  const calls = [];
  const check = async input => {
    calls.push(input);
    const call = writeCall(input, { origins: true });
    if (call.refusal) return { ok: false, code: 'INPUT_INVALID', problems: call.refusal.problems };
    const also = input.also ?? [];
    const defined = new Set(known.map(n => n.toLowerCase()));
    for (const p of also) if (p.part === 'logic') { const h = headerOf(p.text); if (h) defined.add(h.name.toLowerCase()); }
    const problems = [];
    also.forEach((p, i) => {
      if (p.part !== 'logic') return;
      if (/BADSYNTAX/.test(p.text)) problems.push({ phase: 'preflight', code: 'FLOW_SYNTAX', message: 'line 4: expected a node', fix: 'write the node as X = Action(...)', origin: { at: `also/${i}` } });
      for (const m of String(p.text).matchAll(/^\s+([A-Z]\w*)\(/gm)) if (!defined.has(m[1].toLowerCase()))
        problems.push({ phase: 'verify', code: 'ExpressionUnknownObject', message: `Unknown object ${m[1]}`, fix: `create ${m[1]} or call an existing action`, origin: { at: `also/${i}` } });
    });
    return problems.length ? { ok: false, code: 'CHECK_REFUSED', problems }
      : { ok: true, valid: true, job: 'job.json', jobSha256: sha(JSON.stringify(call.arguments.job)), capture: { path: 'C:/captures/Visits.oml', sha256: 'c', model: 'm' } };
  };
  check.calls = calls;
  return check;
}
function fakeDeliver(answer = { ok: true, result: 'delivered', taskId: 'task-1' }) {
  const calls = [];
  const deliver = async (tool, args) => { calls.push({ tool, args }); return { structuredContent: typeof answer === 'function' ? answer(calls.length) : answer }; };
  deliver.calls = calls;
  return deliver;
}
function serve({ dir, check, deliver, idleMs = 60000, now } = {}) {
  let handler, config;
  registerSsamCode({ registerTool: (_name, cfg, fn) => { handler = fn; config = cfg; } }, {
    fromJsonSchema: value => value, map: async () => { throw Error('unexpected read'); }, deliver, check,
    drafts: { dir, idleMs, ...(now ? { now } : {}) } });
  return { call: async (input, ctx = { customer: 'client-a' }) => values(await handler(input, ctx)), config };
}

test('the schema offers draft and part and the three-line flow; the listing texts of ssam_code are unchanged', () => {
  const { config } = serve({ dir: os.tmpdir(), deliver: fakeDeliver() });
  const schema = config.inputSchema;
  assert.ok(schema.properties.action.enum.includes('draft') && schema.properties.action.enum.includes('part'));
  // The original text (ssam_reference kind tool) is the whole contract; the listing serves the one-line flow.
  assert.equal(schema.properties.draft.description, DRAFT_CONTRACT);
  assert.match(DRAFT_CONTRACT, /1\) action draft \{module\}.*30 min.*2\) action part .*same name.*3\) action write \{draft\}.*ONE delivery.*3 s after the last part/s);
  assert.match(DRAFT_TEXT, /draft {module}; part {draft,part,text} checks; write {draft} delivers/);   // the listing budget (integ/proto-into-product)
  const listed = listedTool({ name: 'ssam_code', description: CODE_DESCRIPTION, inputSchema: schema, annotations: config.annotations });
  assert.equal(listed.inputSchema.properties.draft.description, DRAFT_TEXT, 'the reviewed projection serves the short text');
  assert.deepEqual(schema.properties.part.enum, ['ddl', 'logic', 'html']);
});

test('draft -> 3 parts (the second refused for its syntax and corrected by sending it again) -> write = ONE deliver of the job in canonical order', async t => {
  const dir = tmp(t);
  const check = fakeCheck();
  const deliver = fakeDeliver();
  const { call } = serve({ dir, check, deliver });
  const opened = await call({ lane: 'o11', action: 'draft', module: 'Visits' });
  assert.equal(opened.ok, true);
  const id = opened.draft.id;
  assert.ok(Date.parse(opened.draft.expiresAt) > Date.now());
  assert.ok(fs.existsSync(path.join(dir, id, 'draft.json')), 'the draft is on disk');

  const p1 = await call({ lane: 'o11', action: 'part', draft: id, part: 'logic', text: flow('CompleteVisit') });
  assert.equal(p1.accepted, true);
  assert.deepEqual(p1.summary, { parts: 1, accepted: 1, pending: [] });
  assert.equal(p1.checked.ran, true);

  const bad = await call({ lane: 'o11', action: 'part', draft: id, part: 'ddl', text: DDL_BAD });
  assert.equal(bad.ok, false); assert.equal(bad.accepted, false); assert.equal(bad.code, 'DRAFT_PART_REFUSED');
  assert.ok(bad.problems.length && bad.problems.every(p => p.fix && p.part === bad.parts[0].id), JSON.stringify(bad.problems));
  assert.match(bad.problems[0].error, /not SQL Server DDL/);
  assert.deepEqual(bad.summary.pending, [bad.parts[0].id]);
  assert.equal(check.calls.length, 1, 'a part refused alone is not checked with the others');

  const fixed = await call({ lane: 'o11', action: 'part', draft: id, text: DDL });
  assert.equal(fixed.accepted, true, JSON.stringify(fixed));
  assert.deepEqual(fixed.replaced, [bad.parts[0].id], 'the same name (Visit) replaces the refused part');
  assert.deepEqual(fixed.summary, { parts: 2, accepted: 2, pending: [] });

  const p3 = await call({ lane: 'o11', action: 'part', draft: id, part: 'html', text: HTML });
  assert.equal(p3.accepted, true);
  assert.deepEqual(p3.next.arguments, { lane: 'o11', action: 'write', draft: id });
  const checks = check.calls.length;

  const status = await call({ lane: 'o11', action: 'draft', draft: id });
  assert.equal(status.ok, true);
  assert.deepEqual(status.parts.map(p => p.status), ['accepted', 'accepted', 'accepted']);
  assert.deepEqual(status.write.arguments, { lane: 'o11', action: 'write', draft: id });
  assert.equal(status.prebuilt.ok, true, 'the last part checked the whole set');

  const written = await call({ lane: 'o11', action: 'write', draft: id, authorize: 'entregue' });
  assert.equal(deliver.calls.length, 1, 'exactly one delivery');
  assert.equal(check.calls.length, checks, 'the write reuses the check of the set');
  const { tool, args } = deliver.calls[0];
  assert.equal(tool, 'o11_deliver');
  assert.equal(args.module, 'Visits'); assert.equal(args.authorize, 'entregue'); assert.equal(args.until, 'merge');
  assert.deepEqual(args.job.ops.map(op => op.op), ['spec', 'html', 'logic'], 'data, then documents, then actions');
  assert.equal(args.job.ops[0].data.ddl, DDL);
  assert.equal(written.ok, true); assert.equal(written.result, 'delivered');
  assert.equal(written.draft.id, id); assert.equal(written.draft.parts, 3); assert.equal(written.draft.state, 'delivered');
  assert.ok(written.draft.checkedAt); assert.equal(written.draft.prebuilt.reused, true);

  const again = await call({ lane: 'o11', action: 'write', draft: id });
  assert.equal(again.code, 'DRAFT_CLOSED'); assert.equal(deliver.calls.length, 1);
  const late = await call({ lane: 'o11', action: 'part', draft: id, text: flow('Other') });
  assert.equal(late.code, 'DRAFT_CLOSED');
});

test('a part that calls an action of an earlier part resolves in the joint check; one that calls nothing known is refused, with the others intact', async t => {
  const dir = tmp(t);
  const check = fakeCheck();
  const { call } = serve({ dir, check, deliver: fakeDeliver() });
  const id = (await call({ lane: 'odc', action: 'draft', module: 'Visits' })).draft.id;
  assert.equal((await call({ lane: 'odc', action: 'part', draft: id, text: flow('Helper') })).accepted, true);
  // Alone, Main would not resolve Helper: the check of the part runs with the parts already accepted.
  const alone = await fakeCheck()({ lane: 'odc', module: 'Visits', also: [{ part: 'logic', text: flow('Main', ['Helper()', 'assign Count = 2']) }] });
  assert.equal(alone.ok, false);
  const main = await call({ lane: 'odc', action: 'part', draft: id, text: flow('Main', ['Helper()', 'assign Count = 2']) });
  assert.equal(main.accepted, true, JSON.stringify(main.problems));
  assert.deepEqual(check.calls.at(-1).also.map(p => headerOf(p.text).name), ['Helper', 'Main']);

  const broken = await call({ lane: 'odc', action: 'part', draft: id, text: flow('Broken', ['Missing()']) });
  assert.equal(broken.accepted, false);
  assert.deepEqual(broken.problems.map(p => [p.part, p.code]), [[broken.parts[0].id, 'ExpressionUnknownObject']]);
  assert.ok(broken.problems[0].fix);
  assert.deepEqual(broken.summary, { parts: 3, accepted: 2, pending: [broken.parts[0].id] });
  // Corrected under the same name, it replaces the refused part in its place.
  const repaired = await call({ lane: 'odc', action: 'part', draft: id, text: flow('Broken', ['Main()']) });
  assert.equal(repaired.accepted, true); assert.deepEqual(repaired.replaced, [broken.parts[0].id]);
  const status = await call({ lane: 'odc', action: 'draft', draft: id });
  assert.deepEqual(status.parts.map(p => p.names[0]), ['Helper', 'Main', 'Broken']);
});

test('an expired draft and a draft of another client are refused; each part renews the 30 minutes', async t => {
  const dir = tmp(t);
  const clock = { t: Date.parse('2026-10-24T10:00:00Z') };
  const deliver = fakeDeliver();
  const { call } = serve({ dir, check: fakeCheck(), deliver, now: () => clock.t });
  const opened = await call({ lane: 'o11', action: 'draft', module: 'Visits' });
  const id = opened.draft.id;
  assert.equal(opened.draft.expiresAt, '2026-10-24T10:30:00.000Z');

  clock.t += 20 * 60 * 1000;
  const p1 = await call({ lane: 'o11', action: 'part', draft: id, text: flow('A') });
  assert.equal(p1.accepted, true); assert.equal(p1.draft.expiresAt, '2026-10-24T10:50:00.000Z');
  clock.t += 25 * 60 * 1000; // 10:45: past the first 30 minutes, inside the renewed ones
  assert.equal((await call({ lane: 'o11', action: 'part', draft: id, text: flow('B') })).accepted, true);

  for (const input of [{ action: 'draft', draft: id }, { action: 'part', draft: id, text: flow('C') }, { action: 'write', draft: id }]) {
    const other = await call({ lane: 'o11', ...input }, { customer: 'client-b' });
    assert.equal(other.code, 'DRAFT_NOT_OWNED', input.action);
    assert.equal(JSON.stringify(other).includes('server action'), false, 'nothing of the draft is read back');
  }
  clock.t += DRAFT_TTL_MS + 1;
  for (const input of [{ action: 'part', draft: id, text: flow('C') }, { action: 'write', draft: id }]) {
    const expired = await call({ lane: 'o11', ...input });
    assert.equal(expired.code, 'DRAFT_EXPIRED', input.action);
    assert.deepEqual(expired.continuation.arguments, { lane: 'o11', action: 'draft', module: 'Visits' });
  }
  assert.equal(deliver.calls.length, 0);
  assert.equal((await call({ lane: 'o11', action: 'part', draft: '00000000-0000-4000-8000-000000000000', text: flow('C') })).code, 'DRAFT_NOT_FOUND');
});

test('write with a part not accepted refuses in under a second, lists it and delivers nothing', async t => {
  const dir = tmp(t);
  const deliver = fakeDeliver();
  const { call } = serve({ dir, check: fakeCheck(), deliver });
  const id = (await call({ lane: 'o11', action: 'draft', module: 'Visits' })).draft.id;
  await call({ lane: 'o11', action: 'part', draft: id, text: flow('Good') });
  const bad = await call({ lane: 'o11', action: 'part', draft: id, text: flow('Bad', ['BADSYNTAX']) });
  assert.equal(bad.accepted, false); assert.equal(bad.problems[0].code, 'FLOW_SYNTAX');
  const start = performance.now();
  const refused = await call({ lane: 'o11', action: 'write', draft: id });
  const ms = performance.now() - start;
  assert.ok(ms < 1000, ms + ' ms');
  assert.equal(refused.code, 'DRAFT_PARTS_PENDING');
  assert.deepEqual(refused.pending.map(p => [p.id, p.names, p.status]), [[bad.parts[0].id, ['Bad'], 'refused']]);
  assert.equal(refused.pending[0].problems[0].code, 'FLOW_SYNTAX');
  assert.equal(deliver.calls.length, 0);
  // A write {draft} takes no code of its own, and element alone drops a part.
  assert.equal((await call({ lane: 'o11', action: 'write', draft: id, text: flow('X') })).code, 'INPUT_INVALID');
  const dropped = await call({ lane: 'o11', action: 'part', draft: id, element: 'Bad' });
  assert.deepEqual(dropped.dropped, [bad.parts[0].id]); assert.deepEqual(dropped.summary, { parts: 1, accepted: 1, pending: [] });
});

test('a refused delivery leaves the draft open for parts; the next write delivers once more', async t => {
  const dir = tmp(t);
  const deliver = fakeDeliver(n => n === 1 ? { ok: false, code: 'PREFLIGHT_REFUSED', error: 'refused', nextBasedOn: { job: 'C:/job.json', sha256: 'abc' } } : { ok: true, result: 'delivered' });
  const { call } = serve({ dir, check: fakeCheck(), deliver });
  const id = (await call({ lane: 'odc', action: 'draft', module: 'Visits' })).draft.id;
  await call({ lane: 'odc', action: 'part', draft: id, text: flow('A') });
  const first = await call({ lane: 'odc', action: 'write', draft: id });
  assert.equal(first.ok, false); assert.equal(first.code, 'PREFLIGHT_REFUSED'); assert.equal(first.draft.state, 'open');
  assert.deepEqual(first.nextBasedOn, { job: 'C:/job.json', sha256: 'abc' });
  assert.equal(deliver.calls[0].tool, 'studio_deliver');
  assert.ok(deliver.calls[0].args.owners.includes('A'));
  await call({ lane: 'odc', action: 'part', draft: id, text: flow('A', ['assign Count = 3']) });
  const second = await call({ lane: 'odc', action: 'write', draft: id });
  assert.equal(second.ok, true); assert.equal(second.draft.state, 'delivered'); assert.equal(deliver.calls.length, 2);
});

test('a new process reads the draft back from disk and writes it (reconnection)', async t => {
  const dir = tmp(t);
  const { call } = serve({ dir, check: fakeCheck(), deliver: fakeDeliver() });
  const id = (await call({ lane: 'o11', action: 'draft', module: 'Visits' })).draft.id;
  await call({ lane: 'o11', action: 'part', draft: id, text: DDL });
  await call({ lane: 'o11', action: 'part', draft: id, text: flow('A') });
  const script = `
    const { draftAction } = await import(${JSON.stringify(pathToFileURL(path.join(here, '..', 'code-draft.mjs')).href)});
    const delivered = [];
    const deps = { dir: ${JSON.stringify(dir)}, deliver: async (tool, args) => { delivered.push(args.job.ops.map(op => op.op)); return { structuredContent: { ok: true, result: 'delivered' } }; } };
    const status = await draftAction({ lane: 'o11', action: 'draft', draft: ${JSON.stringify(id)} }, { customer: 'client-a' }, deps);
    const stranger = await draftAction({ lane: 'o11', action: 'draft', draft: ${JSON.stringify(id)} }, { customer: 'client-b' }, deps);
    const written = await draftAction({ lane: 'o11', action: 'write', draft: ${JSON.stringify(id)} }, { customer: 'client-a' }, deps);
    console.log(JSON.stringify({ pid: process.pid, status, stranger: stranger.code, written, delivered }));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: here, env: process.env });
  const out = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.notEqual(out.pid, process.pid);
  assert.deepEqual(out.status.summary, { parts: 2, accepted: 2, pending: [] });
  assert.equal(out.stranger, 'DRAFT_NOT_OWNED');
  assert.equal(out.written.ok, true); assert.equal(out.written.draft.state, 'delivered');
  assert.deepEqual(out.delivered, [['spec', 'logic']]);
  assert.equal(out.written.draft.prebuilt.reused, true, 'the check kept on disk by the first process is reused');
  assert.equal((await call({ lane: 'o11', action: 'write', draft: id })).code, 'DRAFT_CLOSED');
});

test('the background check of the accepted parts runs after 3 s idle and the write reuses it (check not called again)', async t => {
  const dir = tmp(t);
  const check = fakeCheck();
  const deliver = fakeDeliver();
  const { call } = serve({ dir, check, deliver, idleMs: 30 });
  const id = (await call({ lane: 'o11', action: 'draft', module: 'Visits' })).draft.id;
  // Two actions in one text: Bad is refused, Good is accepted, and the set of the accepted parts was never checked alone.
  const both = await call({ lane: 'o11', action: 'part', draft: id, text: flow('Good') + '\n' + flow('Bad', ['BADSYNTAX']) });
  assert.deepEqual(both.parts.map(p => [p.names[0], p.status]), [['Good', 'accepted'], ['Bad', 'refused']]);
  assert.ok(both.normalizations.some(n => n.rule === 'draft-split'));
  await call({ lane: 'o11', action: 'part', draft: id, element: 'Bad' });
  const before = check.calls.length;
  for (let i = 0; i < 100 && check.calls.length === before; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(check.calls.length, before + 1, 'one background check of the accepted parts');
  assert.deepEqual(check.calls.at(-1).also.map(p => headerOf(p.text).name), ['Good']);
  for (let i = 0; i < 50 && !(await call({ lane: 'o11', action: 'draft', draft: id })).prebuilt?.ok; i++) await new Promise(resolve => setTimeout(resolve, 20));
  await new Promise(resolve => setTimeout(resolve, 100)); // no second background check of the same set
  assert.equal(check.calls.length, before + 1);
  const written = await call({ lane: 'o11', action: 'write', draft: id });
  assert.equal(check.calls.length, before + 1, 'the write does not check again');
  assert.equal(deliver.calls.length, 1);
  assert.deepEqual(written.draft.prebuilt, { reused: true, by: 'background', jobSha256: sha(JSON.stringify(deliver.calls[0].args.job)) });
});

test('without a local capture the parts are accepted on their composition and the delivery validates them', async t => {
  const dir = tmp(t);
  let checks = 0;
  const check = async () => { checks++; return { ok: false, code: 'CAPTURE_MISSING', problems: [{ code: 'CAPTURE_MISSING' }], continuation: { tool: 'ssam_map', arguments: { lane: 'o11', target: 'Visits' } } }; };
  const deliver = fakeDeliver();
  const { call } = serve({ dir, check, deliver });
  const id = (await call({ lane: 'o11', action: 'draft', module: 'Visits' })).draft.id;
  const p = await call({ lane: 'o11', action: 'part', draft: id, text: flow('A') });
  assert.equal(p.accepted, true); assert.equal(p.checked.ran, false); assert.equal(p.checked.code, 'CAPTURE_MISSING');
  const ops = await call({ lane: 'o11', action: 'part', draft: id, ops: [{ op: 'create', parent: '@espace', type: 'IUserException', name: 'VisitNotFound' }] });
  assert.equal(ops.accepted, true); assert.deepEqual(ops.parts[0].names, ['VisitNotFound']);
  const written = await call({ lane: 'o11', action: 'write', draft: id });
  assert.equal(written.ok, true); assert.equal(written.draft.prebuilt, null);
  assert.deepEqual(deliver.calls[0].args.job.ops.map(op => op.op), ['create', 'logic'], 'raw ops first');
  assert.equal(checks, 3);
});
