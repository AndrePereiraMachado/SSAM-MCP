import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePartialJob, partialSummary } from '../job-patch.mjs';

const action = (name, value = 1, kind = 'server action') => `/// Action description\n${kind} ${name}\n  assign Result = ${value}\n  end\n`;
const logic = flow => ({ op: 'logic', data: { flow } });

test('F13: two corrected texts replace their actions after the DDL op, without a new op', () => {
  const base = { ops: [{ op: 'spec', data: { ddl: 'type Result = { Value: Integer; }' } },
    logic([action('Keep'), action('GarantirPokemonNoCache'), action('BuscarPorCep')])] };
  const partial = { ops: [logic([action('GarantirPokemonNoCache', 2), action('BuscarPorCep', 3)])] };
  const original = structuredClone(base);
  const { job, summary } = mergePartialJob(base, partial);
  assert.deepEqual(base, original);
  assert.equal(job.ops.length, 2);
  assert.deepEqual(job.ops[1].data.flow, [action('Keep'), ...partial.ops[0].data.flow]);
  assert.deepEqual(partialSummary(summary), { replaced: 2, added: 0, newOps: 0,
    replacedAt: ['/ops/1/data/flow/1', '/ops/1/data/flow/2'] });
});

test('F13: scalar and object texts, owner headers and new actions use existing logic ops', () => {
  const base = { ops: [logic(action('Run', 1, 'client action')), logic([
    { text: action('Page.Run', 1, 'action'), basedOn: 'old' }, action('Page.Fetch', 1, 'data action')])] };
  const { job, summary } = mergePartialJob(base, { ops: [logic([
    { text: action('Run', 2, 'client action'), basedOn: 'new' }, action('Page.Run', 2, 'action'),
    action('Page.Fetch', 2, 'data action'), action('New', 2, 'service action')])] });
  assert.equal(summary.replaced.length, 3);
  assert.equal(summary.added.length, 1);
  assert.equal(summary.ops.length, 0);
  assert.equal(job.ops[0].data.flow[0].basedOn, 'new');
  assert.equal(job.ops[1].data.flow.at(-1), action('New', 2, 'service action'));
});

test('F13: duplicate, ambiguous and missing text headers are refused without changing the base', () => {
  const base = { ops: [logic([action('A')]), logic([action('A')])] };
  assert.throws(() => mergePartialJob(base, { ops: [logic(action('A', 2))] }), { code: 'PARTIAL_AMBIGUOUS' });
  assert.throws(() => mergePartialJob({ ops: [logic(action('A'))] }, { ops: [logic([action('B'), action('B')])] }), { code: 'PARTIAL_AMBIGUOUS' });
  assert.throws(() => mergePartialJob(base, { ops: [logic('  end\n')] }), { code: 'PARTIAL_UNNAMED' });
  assert.throws(() => mergePartialJob({ ops: [] }, { ops: [logic([action('A'), action('A')])] }), { code: 'PARTIAL_AMBIGUOUS' });
  assert.throws(() => mergePartialJob(base, { ops: [{ op: 'logic', data: { flow: action('A'), actions: [{ name: 'B' }] } }] }), { code: 'PARTIAL_INVALID' });
  assert.equal(base.ops[0].data.flow[0], action('A'));
});

test('F13: JSON partial actions still replace and append by name', () => {
  const a = { name: 'A', steps: [] }, b = { name: 'B', steps: [] }, changed = { name: 'A', steps: [{ end: true }] };
  const { job, summary } = mergePartialJob({ ops: [{ op: 'logic', data: { actions: [a] } }] },
    { ops: [{ op: 'logic', data: { actions: [changed, b] } }] });
  assert.deepEqual(job.ops[0].data.actions, [changed, b]);
  assert.equal(summary.replaced.length, 1);
  assert.equal(summary.added.length, 1);
  assert.equal(summary.ops.length, 0);
});

test('F13 on the line: over only JSON-form logic ops a new action text is a new logic op, as before; a JSON action is changed in its form', () => {
  const base = { ops: [{ op: 'spec', data: { ddl: 'type Result = { Value: Integer; }' } }, { op: 'logic', data: { actions: [{ name: 'Keep', steps: [] }] } }] };
  const { job, summary } = mergePartialJob(base, { ops: [logic([action('Fresh'), action('Other', 2)])] });
  assert.equal(job.ops.length, 3);
  assert.deepEqual(job.ops[1], base.ops[1]);
  assert.deepEqual(job.ops[2], logic([action('Fresh'), action('Other', 2)]));
  assert.deepEqual(partialSummary(summary), { replaced: 0, added: 0, newOps: 1, newOpsAt: ['/ops/2'] });
  assert.throws(() => mergePartialJob(base, { ops: [logic(action('Keep', 2))] }), { code: 'PARTIAL_INVALID' });
});

// Review of r4-w2-flow, correction 3: the identity of an action is its scope (client, or server and service), its owner and
// its name, without regard to case, as the kernel's (ActionNameRules.Scope): a client and a server action of one name are two.
test('F13 review 3: a client action never replaces the server action of its name, both come in one partial, and a new server action beside a JSON client one is new', () => {
  const server = action('Fetch', 1, 'server action'), client = action('Fetch', 2, 'client action');
  const p1 = mergePartialJob({ ops: [logic([server])] }, { ops: [logic([client])] });
  assert.deepEqual(p1.job.ops[0].data.flow, [server, client]);
  assert.deepEqual(partialSummary(p1.summary), { replaced: 0, added: 1, newOps: 0, addedAt: ['/ops/0/data/flow/1'] });
  const p2 = mergePartialJob({ ops: [logic([action('Other')])] }, { ops: [logic([server, client])] });
  assert.deepEqual(p2.job.ops[0].data.flow, [action('Other'), server, client]);
  const json = { ops: [{ op: 'logic', data: { actions: [{ name: 'A', kind: 'client', steps: [] }] } }] };
  const p7 = mergePartialJob(json, { ops: [logic([action('A', 1, 'server action')])] });
  assert.equal(p7.job.ops.length, 2);
  assert.deepEqual(p7.job.ops[1].data.flow, [action('A', 1, 'server action')]);
  // The same scope, owner and name stays one action: case, an owner's kind prefix or its flow path change nothing.
  assert.throws(() => mergePartialJob({ ops: [{ op: 'logic', data: { actions: [{ name: 'load', steps: [] }] } }, logic([action('B')])] },
    { ops: [logic([action('Load')])] }), { code: 'PARTIAL_INVALID' });
  assert.throws(() => mergePartialJob({ ops: [{ op: 'logic', data: { actions: [{ name: 'Init', kind: 'screen', owner: 'IMobileScreen:Home', steps: [] }] } }, logic([action('B')])] },
    { ops: [logic([action('Home.Init', 1, 'action')])] }), { code: 'PARTIAL_INVALID' });
  const path = mergePartialJob({ ops: [logic([action('MainFlow/Home.GetRows', 1, 'data action')])] }, { ops: [logic([action('Home.GetRows', 2, 'data action')])] });
  assert.deepEqual(partialSummary(path.summary), { replaced: 1, added: 0, newOps: 0, replacedAt: ['/ops/0/data/flow/0'] });
  assert.throws(() => mergePartialJob({ ops: [logic([action('A')])] }, { ops: [logic([action('A'), action('a', 2)])] }), { code: 'PARTIAL_AMBIGUOUS' });
});

// Correction 4: `preparation` is a header of the kernel (FlowPrinter.Labels); a text of basedOn whose header does not read
// matches nothing and never refuses the partial.
test('F13 review 4: a Preparation text is read, by its screen, in basedOn and in the partial', () => {
  const prep = (value, written = 'Home') => `preparation ${written}\n  assign X = ${value}\n  end\n`;
  const p3 = mergePartialJob({ ops: [logic([prep(1)])] }, { ops: [logic([action('New')])] });
  assert.deepEqual(p3.job.ops[0].data.flow, [prep(1), action('New')]);
  const p4 = mergePartialJob({ ops: [logic([action('A')])] }, { ops: [logic([prep(2)])] });
  assert.deepEqual(p4.job.ops[0].data.flow, [action('A'), prep(2)]);
  const same = mergePartialJob({ ops: [logic([prep(1, 'Fitmaker.Preparation')])] }, { ops: [logic([prep(2, 'Fitmaker')])] });
  assert.deepEqual(same.job.ops[0].data.flow, [prep(2, 'Fitmaker')]);
  const odd = mergePartialJob({ ops: [logic(['  end\n', action('A')])] }, { ops: [logic([action('B')])] });
  assert.deepEqual(odd.job.ops[0].data.flow, ['  end\n', action('A'), action('B')]);
});

// Correction 5: the corrected text of an action read with its @key keeps the basedOn of the text it replaces (said in a note);
// the partial's own basedOn wins, and a text of another @key inherits nothing.
test('F13 review 5: a replaced text with the same @key keeps the basedOn of basedOn, with a note', () => {
  const keyed = value => `server action Calc @k3yABC\n  assign X = ${value} @n1\n  end\n`;
  const base = { ops: [{ op: 'logic', data: { flow: keyed(1), basedOn: 'abcdef0123456789' } }] };
  const { job, summary } = mergePartialJob(base, { ops: [logic(keyed(2))] });
  assert.deepEqual(job.ops[0].data.flow, [{ text: keyed(2), basedOn: 'abcdef0123456789' }]);
  assert.deepEqual(summary.notes, [{ rule: 'partial-flow-basedOn', at: '/ops/0/data/flow/0', note: 'the text of Calc @k3yABC brought no basedOn: it keeps "abcdef0123456789", the basedOn of the text it replaces' }]);
  const own = mergePartialJob(base, { ops: [{ op: 'logic', data: { flow: keyed(3), basedOn: '0123456789abcdef' } }] });
  assert.deepEqual(own.job.ops[0].data.flow, [{ text: keyed(3), basedOn: '0123456789abcdef' }]);
  assert.equal(own.summary.notes, undefined);
  const other = mergePartialJob(base, { ops: [logic(keyed(4).replace('@k3yABC', '@otherKey'))] });
  assert.deepEqual(other.job.ops[0].data.flow, [keyed(4).replace('@k3yABC', '@otherKey')]);
  const bare = mergePartialJob(base, { ops: [logic('server action Calc\n  assign X = 5\n  end\n')] });
  assert.deepEqual(bare.job.ops[0].data.flow, ['server action Calc\n  assign X = 5\n  end\n']);
});

// The B1 integration review, case D: a text of basedOn may hold several actions. Every header of it is indexed, so an action
// that lives inside such a text is never appended again: the answer is PARTIAL_AMBIGUOUS with the text's pointer and the way
// out, and basedOn stays as it was. A text of the partial with several actions replaces nothing by name either.
test('F13 multi-action texts: an action inside a text of several is never duplicated', () => {
  const double = action('A') + action('B');
  const base = { ops: [{ op: 'spec', data: { ddl: 'type R = { V: Integer; }' } }, logic([double])] };
  const original = structuredClone(base);
  let error = null;
  try { mergePartialJob(base, { ops: [logic([action('B', 2)])] }); } catch (e) { error = e; }
  assert.equal(error?.code, 'PARTIAL_AMBIGUOUS');
  assert.match(error.message, /action B is one of the 2 actions of the text \/ops\/1\/data\/flow\/0 of basedOn; change it with a patch at that pointer/);
  assert.deepEqual(error.candidates, ['/ops/1/data/flow/0']);
  assert.deepEqual(base, original);
  // A new action beside such a text is added; a partial text of several actions adds them when none is known, and is refused
  // when one is (each goes as its own text).
  const added = mergePartialJob(base, { ops: [logic([action('C')])] });
  assert.deepEqual(added.job.ops[1].data.flow, [double, action('C')]);
  const both = mergePartialJob({ ops: [logic([action('Keep')])] }, { ops: [logic([action('X') + action('Y')])] });
  assert.deepEqual(both.job.ops[0].data.flow, [action('Keep'), action('X') + action('Y')]);
  assert.throws(() => mergePartialJob({ ops: [logic([action('Keep')])] }, { ops: [logic([action('X') + action('Keep', 2)])] }), { code: 'PARTIAL_AMBIGUOUS' });
  assert.throws(() => mergePartialJob({ ops: [logic([action('Keep')])] }, { ops: [logic([action('X') + action('Y'), action('Y', 2)])] }), { code: 'PARTIAL_AMBIGUOUS' });
});
