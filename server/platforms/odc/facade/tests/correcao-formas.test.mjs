import { isolatedProfile } from './fixtures/isolated-profile.mjs';
// Wave 2 of the proto (C-18, C-42; ported from proto 58aa80b1): the forms a correction of a job takes are the ones the schema allows and AGENTS.md promises, reduced to
// one canonical job before it is checked; each refusal that remains names the exact shape it accepts. Every case is the real
// one of the friction reports (outputs/figma-apps/**/friccoes.md), in minimal form. No Studio, no kernel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeCodeOps, writeCall } from '../ssam-code.mjs';
import { applyFlowEdits } from '../flow-edits.mjs';
import { patchJob, resolvePatchedJob } from '../job-patch.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(isolatedProfile, 'correction-forms-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const LOGIN = '<screen name="Login" actions="DoLogin">\n<div class="login">\n <button class="btn" onclick="DoLogin">Entrar</button>\n</div>\n</screen>\n';
const DO_LOGIN = 'action Login.DoLogin\n  assign X = 1\n  end\n';
const DDL = 'create entity Station label Code (\n  Id Long Integer identifier auto required,\n  Code Text(20) required\n);\n';
const baseJob = () => ({ ops: [
  { op: 'spec', data: { ddl: DDL } },
  { op: 'html', data: { html: LOGIN } },
  { op: 'logic', data: { flow: [DO_LOGIN] } },
] });
function writeJob(dir, value = baseJob()) {
  const file = path.join(dir, 'refused', 'job.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2); fs.writeFileSync(file, text);
  return { job: file, sha256: sha(text) };
}

test('C-18 (F-Jesse-03): a new action in also beside the edits of a job is carried into that job, never "go in a new write"', t => {
  const dir = tmp(t); const base = writeJob(dir);
  const added = 'data action Login.GetCtaInfo\n  out Label: Text\n  assign Label = "Go"\n';
  const input = { lane: 'o11', action: 'write', module: 'Bike_UI', basedOn: base, element: 'Login', edits: [{ find: '>Entrar<', with: '>Sair<' }],
    also: [{ part: 'logic', text: added }] };
  const call = writeCall(input);
  assert.ok(!call.refusal, JSON.stringify(call.refusal));
  assert.equal(call.tool, 'o11_deliver');
  assert.deepEqual(call.arguments.basedOn, base);
  assert.deepEqual(call.arguments.job.ops, [{ op: 'logic', data: { flow: [added] } }]);
  assert.deepEqual(call.arguments.patch, [{ op: 'replace', path: '/ops/1/data/html', value: LOGIN.replace('>Entrar<', '>Sair<') }]);
  assert.ok(call.normalizations.some(n => n.rule === 'job-text-carried'), JSON.stringify(call.normalizations));
  // The delivery resolves it: the base job with the new action added (the line's merge adds it as a logic op; the merge of
  // an action text into the job's logic op by its name is the proto's F13, not on this line) and the edit applied.
  const resolved = resolvePatchedJob(call.arguments, { inlineDir: path.join(dir, 'inline') });
  assert.ok(resolved.ok, JSON.stringify(resolved));
  const job = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
  const flows = job.ops.filter(op => op.op === 'logic').flatMap(op => op.data.flow);
  assert.deepEqual(flows, [DO_LOGIN, added], 'the action of the job kept, the new one added once');
  assert.ok(job.ops[1].data.html.includes('>Sair<'));
  assert.ok(job.ops[0].data.ddl === DDL && job.ops[2].data.flow[0] === DO_LOGIN, 'the ops of basedOn keep their places (the patch addresses them)');
  // A text of an action the job already has is no new text: its change is an edit of that text, and the refusal says so.
  const same = writeCall({ ...input, also: [{ part: 'logic', text: DO_LOGIN.replace('X = 1', 'X = 3') }] }).refusal;
  assert.equal(same.code, 'INPUT_INVALID');
  assert.deepEqual(same.problems.filter(p => p.at === 'also/0').map(p => p.code), ['PARTIAL_AMBIGUOUS'], 'an action that exists, never EDIT_ELEMENT_UNKNOWN');
  assert.match(same.problems.find(p => p.at === 'also/0').error, /Login\.DoLogin \(screen action\) is already an action of the job of basedOn: change it with edits \[\{find, with\}\]/);
  // The ODC delivery carries the same partial job and patch.
  const odc = writeCall({ ...input, lane: 'odc' });
  assert.equal(odc.tool, 'studio_deliver');
  assert.deepEqual(odc.arguments.job.ops, call.arguments.job.ops);
  assert.deepEqual(odc.arguments.patch, call.arguments.patch);
  // A data text beside the edits is corrected in the job, and the refusal says the shape it takes.
  const ddl = writeCall({ ...input, also: [{ part: 'ddl', text: DDL.replace('Text(20)', 'Text(30)') }] }).refusal;
  assert.equal(ddl.code, 'INPUT_INVALID');
  assert.match(ddl.problems.find(p => p.at === 'also/0').error, /element "ddl"/);
});

// Review round 2 of B1: the edits' patch is computed over the job of basedOn, so a carried text of the element an edit
// changes was replaced in silence (the receipt said the carried document "replaces the page of its screen"); and the
// action already in the job was told by owner and name only, with a code for an unknown element.
test('C-18 (review round 2): a carried text and an edit of the same element are one EDIT_OVERLAP; an action is told by scope, owner and name', t => {
  const dir = tmp(t);
  const TWO = 'server action A\n  end\n\nserver action B\n  end\n';
  const base = writeJob(dir, { ops: [...baseJob().ops.slice(0, 2), { op: 'logic', data: { flow: [DO_LOGIN, TWO] } }] });
  const write = extra => writeCall({ lane: 'o11', action: 'write', module: 'Bike_UI', basedOn: base, ...extra });
  const only = (call, code) => { assert.ok(call.refusal, 'refused'); const at = call.refusal.problems.filter(p => p.at === 'also/0'); assert.deepEqual(at.map(p => p.code), [code], JSON.stringify(call.refusal.problems)); return at[0]; };
  // The whole screen in also and an edit of that screen: one problem, both places, nothing delivered.
  const doc = only(write({ element: 'Login', edits: [{ find: '>Entrar<', with: '>Sair<' }], also: [{ part: 'html', text: LOGIN.replace('class="login"', 'class="login2"') }] }), 'EDIT_OVERLAP');
  assert.deepEqual(doc.edits, ['edits/0']);
  assert.match(doc.error, /^also\/0 and edits\/0 change the same screen or block Login: send its whole text in also, or the edits, not both$/);
  // The same for an action: its text in also and an edit of it (one problem, not PARTIAL_AMBIGUOUS beside it).
  const action = only(write({ element: 'Login.DoLogin', edits: [{ find: 'X = 1', with: 'X = 2' }], also: [{ part: 'logic', text: DO_LOGIN.replace('X = 1', 'X = 9') }] }), 'EDIT_OVERLAP');
  assert.match(action.error, /change the same action Login\.DoLogin/);
  // The second action of a text of two is in the job too.
  assert.match(only(write({ element: 'Login', edits: [{ find: '>Entrar<', with: '>Sair<' }], also: [{ part: 'logic', text: 'server action B\n  assign Y = 1\n  end\n' }] }), 'PARTIAL_AMBIGUOUS').error,
    /^B \(server action\) is already an action/);
  // Another scope is another action: a client action A beside the job's server action A is a new action, carried.
  for (const text of ['client action A\n  end\n', 'client action DoLogin\n  end\n']) {
    const call = write({ element: 'Login', edits: [{ find: '>Entrar<', with: '>Sair<' }], also: [{ part: 'logic', text }] });
    assert.ok(!call.refusal, text + JSON.stringify(call.refusal?.problems));
    assert.deepEqual(call.arguments.job.ops, [{ op: 'logic', data: { flow: [text] } }]);
  }
});

test('C-18 (F-FitBody-15): edits of a job without element take the element their finds occur in, once in the job', t => {
  const dir = tmp(t); const base = writeJob(dir);
  const call = writeCall({ lane: 'o11', action: 'write', module: 'Bike_UI', basedOn: base, edits: [{ find: 'Code Text(20)', with: 'Code Text(30)' }] });
  assert.ok(!call.refusal, JSON.stringify(call.refusal));
  assert.deepEqual(call.arguments.patch, [{ op: 'replace', path: '/ops/0/data/ddl', value: DDL.replace('Text(20)', 'Text(30)') }]);
  assert.ok(call.normalizations.some(n => n.rule === 'job-text-edits' && /^ddl \(the element the finds occur in\)/.test(n.note)), JSON.stringify(call.normalizations));
  // A find in several texts names the elements that hold it.
  const twice = writeCall({ lane: 'o11', action: 'write', module: 'Bike_UI', basedOn: base, edits: [{ find: 'Login', with: 'Entrada' }] }).refusal;
  const problem = twice.problems.find(p => p.code === 'EDIT_ELEMENT_UNKNOWN');
  assert.ok(problem, JSON.stringify(twice.problems));
  assert.match(problem.error, /give element/);
  assert.deepEqual([...problem.names].sort(), ['Login', 'Login.DoLogin']);
});

// The read of F-FitBody-28 and -42 (FBGetProgress, lote 3 seq 24; lote 4 seq 21), in minimal form.
const READ_ACTION = [
  'server action FBGetProgress @AAAAAAAAAAAAAAAAAAAAAA',
  '  in Days: Integer @p1',
  '  local ChartStart: Date @l1',
  '  Steps = sql -> FBCount max 1 @n1',
  '    SELECT COUNT(1) FROM {FBWorkoutLog}',
  '  assign  # Chart window @n2',
  '    ChartStart = CurrDate()',
  '  end @n3',
  '',
].join('\n');

test('C-18 (F-FitBody-42): {find, with} edits a read action as it edits a job; a find that is not there says the nearest lines', () => {
  const done = applyFlowEdits(READ_ACTION, [{ find: 'SELECT COUNT(1)', with: 'SELECT COUNT(DISTINCT {FBWorkoutLog}.[MemberId])' }]);
  assert.deepEqual(done.problems, []);
  assert.equal(done.text, READ_ACTION.replace('SELECT COUNT(1)', 'SELECT COUNT(DISTINCT {FBWorkoutLog}.[MemberId])'));
  assert.deepEqual(done.removes, []);
  const missing = applyFlowEdits(READ_ACTION, [{ find: 'SELECT COUNT(2) FROM', with: 'x' }]);
  assert.equal(missing.problems[0].code, 'EDIT_TEXT_NOT_FOUND');
  assert.ok(missing.problems[0].lines.some(l => l.text.includes('SELECT COUNT(1)')), JSON.stringify(missing.problems));
  assert.equal(applyFlowEdits(READ_ACTION, [{ find: '@n', with: 'x' }]).problems[0].code, 'EDIT_TEXT_NOT_UNIQUE');
  // One item edits by finds or by lines, and says so.
  assert.match(applyFlowEdits(READ_ACTION, [{ find: 'SELECT', with: 'select' }, { delete: '@n1' }]).problems[0].error, /not both/);
});

test('C-18 (F-FitBody-28): the lines after the first of a column-zero with are relative to it, or kept where the action has them', () => {
  // Seq 24: the children written where the action has them (4 spaces under the 2 of @n2) got 2 more (depth 3, FLOW_SYNTAX).
  const absolute = applyFlowEdits(READ_ACTION, [{ replace: '@n2', with: 'assign  # Chart window\n    ChartStart = AddDays(CurrDate(), -Days)\n    Days = 7' }]);
  assert.deepEqual(absolute.problems, []);
  assert.ok(absolute.text.includes('  assign  # Chart window @n2\n    ChartStart = AddDays(CurrDate(), -Days)\n    Days = 7\n  end @n3'), absolute.text);
  // Relative children (2 spaces under the first line), as lote 4 found: the same text.
  const relative = applyFlowEdits(READ_ACTION, [{ replace: '@n2', with: 'assign  # Chart window\n  ChartStart = AddDays(CurrDate(), -Days)\n  Days = 7' }]);
  assert.equal(relative.text, absolute.text);
});

test('C-42 (F-FitBody-22): the basedOn of a write without text of its own goes to the one part it reads', t => {
  const dir = tmp(t);
  const file = path.join(dir, 'data.ddl'); fs.writeFileSync(file, DDL);
  const source = 'a'.repeat(64);
  const call = writeCall({ lane: 'o11', action: 'write', module: 'Bike_UI', basedOn: source, files: [file] });
  assert.ok(!call.refusal, JSON.stringify(call.refusal));
  assert.deepEqual(call.arguments.job.ops, [{ op: 'spec', data: { basedOn: source, ddl: DDL } }]);
  assert.ok(call.normalizations.some(n => n.rule === 'basedOn-to-part'), JSON.stringify(call.normalizations));
  // Two data texts: the base of which one is not guessed; the refusal says where it goes.
  const other = path.join(dir, 'more.ddl'); fs.writeFileSync(other, DDL.replace(/Station/g, 'Dock'));
  const two = writeCall({ lane: 'o11', action: 'write', module: 'Bike_UI', basedOn: source, files: [file, other] }).refusal;
  assert.match(two.problems.find(p => p.at === 'basedOn').error, /ONE ddl part; 2 parts could take it \(files\/0, files\/1\): give it on its part/);
});

test('C-42 (F-FitBody-22 seq 25, 26): a text replaced by patch keeps its basedOn, and data.basedOn as a list is each text\'s', () => {
  const job = { ops: [{ op: 'logic', data: { flow: [{ text: DO_LOGIN, basedOn: 'abcdefabcdef0123' }] } }] };
  const patched = patchJob(job, [{ op: 'replace', path: '/ops/0/data/flow/0', value: DO_LOGIN.replace('X = 1', 'X = 2') }]);
  assert.deepEqual(patched.job.ops[0].data.flow, [{ text: DO_LOGIN.replace('X = 1', 'X = 2'), basedOn: 'abcdefabcdef0123' }]);
  assert.ok(patched.notes.some(n => n.rule === 'patch-flow-basedOn'), JSON.stringify(patched.notes));
  // The grammar card's list form, put in the op by patch (JSON_SHAPE 'basedOn' must be text): one basedOn per text, in order.
  const listed = normalizeCodeOps({ ops: [{ op: 'logic', data: { flow: [DO_LOGIN, 'action Login.Other\n  end\n'], basedOn: ['abcdefabcdef0123', null] } }] });
  assert.deepEqual(listed.job.ops[0].data, { flow: [{ text: DO_LOGIN, basedOn: 'abcdefabcdef0123' }, 'action Login.Other\n  end\n'] });
  const spec = normalizeCodeOps({ ops: [{ op: 'spec', data: { ddl: DDL, basedOn: ['b'.repeat(64)] } }] });
  assert.equal(spec.job.ops[0].data.basedOn, 'b'.repeat(64));
});
