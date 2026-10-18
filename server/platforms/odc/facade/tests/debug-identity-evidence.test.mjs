import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIdentityEvidence, applyIdentityEvidence, isIdentityEvidence } from '../debug-identity-evidence.mjs';
import { resolveO11TraceRuntime } from '../debug-o11-call-boundary.mjs';
import { describeOdcCallBoundaries } from '../debug-odc-call-boundary.mjs';
const key = c => c.repeat(22), hash = c => c.repeat(64);
const caller = key('C'), producer = key('P'), fn = key('F'), callerFn = key('G');
const boundary = { kind: 'linked-action', callerModuleKey: caller, producerModuleKey: producer, actionKey: key('A'), identityEvidence: null,
  appUserIdentityProved: false, rolesProved: false, propagationProved: false };
const decl = (id, kind, extra = {}) => ({ id, kind, moduleKey: producer, functionKey: fn, assignmentNodeKey: key('1'), afterNodeKeys: [key('2'), key('3')], qualified: true, ...extra });
const read = (witnessId, value, extra = {}) => ({ witnessId, moduleKey: producer, functionKey: fn, nodeKey: key('2'), threadId: 'T1', pauseId: 'p1', scenario: 'granted',
  value: typeof value === 'string' ? { type: 'Text', value } : { type: 'Boolean', value }, ...extra });
function base() {
  return { boundary, authState: { lane: 'o11', nativeCheckRegisteredPassed: true },
    witnesses: [decl('present', 'user-present'), decl('same', 'user-equals-caller'), decl('marker', 'run-marker'), decl('role', 'role', { role: 'SSAMIdentityRole20261010' })],
    witnessReads: [read('present', true), read('same', true), read('marker', 'M-granted'),
      read('role', true), read('present', true, { threadId: 'T2', scenario: 'revoked' }), read('role', false, { threadId: 'T2', scenario: 'revoked' })],
    compares: [], marker: { granted: 'M-granted', revoked: 'M-revoked' },
    roleStates: { SSAMIdentityRole20261010: { granted: { scenario: 'granted', before: { read: true, granted: true }, after: { read: true, granted: true } },
      revoked: { scenario: 'revoked', before: { read: true, granted: false }, after: { read: true, granted: false } } } },
    response: { answered: true, uncertain: false }, cleanup: { confirmed: true } };
}
const without = (input, id) => ({ ...input, witnessReads: input.witnessReads.filter(r => r.witnessId !== id) });

test('complete native witnesses lift identity, the named role and propagation with schema and no values', () => {
  const e = buildIdentityEvidence(base());
  assert.equal(e.schema, 'ssam-identity-evidence/1'); assert.equal(e.boundaryKey, key('A'));
  assert.equal(e.appUserIdentityProved, true); assert.deepEqual(e.rolesProved, { SSAMIdentityRole20261010: true });
  assert.equal(e.propagationProved, true); assert.equal(e.evidence.callerEquality, 'witness');
  assert.deepEqual(e.reasons.appUserIdentityProved, []); assert.ok(Object.isFrozen(e)); assert.equal(isIdentityEvidence(e), true);
  assert.doesNotMatch(JSON.stringify(e), /M-granted|M-revoked/);
});
test('no witness, wrong module, read before the assignment and incomplete reads stay false with reasons', () => {
  let e = buildIdentityEvidence(without(base(), 'present'));
  assert.equal(e.appUserIdentityProved, false); assert.ok(e.reasons.appUserIdentityProved.includes('user-present-witness-not-true'));
  e = buildIdentityEvidence({ ...base(), witnesses: base().witnesses.filter(w => w.kind !== 'user-present') });
  assert.ok(e.reasons.appUserIdentityProved.includes('user-present-witness-undeclared'));
  const wrong = base(); wrong.witnessReads[0] = read('present', true, { moduleKey: caller });
  e = buildIdentityEvidence(wrong); assert.equal(e.appUserIdentityProved, false); assert.ok(e.reasons.appUserIdentityProved.includes('witness-read-wrong-module'));
  const early = base(); early.witnessReads[0] = read('present', true, { nodeKey: key('1') });
  e = buildIdentityEvidence(early); assert.equal(e.appUserIdentityProved, false); assert.ok(e.reasons.appUserIdentityProved.includes('witness-read-before-assignment'));
  const redacted = base(); redacted.witnessReads[0] = read('present', true, { value: { type: 'Boolean', value: true, trimmed: true } });
  assert.equal(buildIdentityEvidence(redacted).appUserIdentityProved, false);
  const unqualified = base(); unqualified.witnesses[0] = { ...unqualified.witnesses[0], qualified: false };
  assert.equal(buildIdentityEvidence(unqualified).appUserIdentityProved, false);
  const falsy = base(); falsy.witnessReads[0] = read('present', false);
  assert.equal(buildIdentityEvidence(falsy).appUserIdentityProved, false);
});
test('marker mismatch, cross-thread evidence, uncertain response and unconfirmed cleanup stay false', () => {
  const mismatch = base(); mismatch.witnessReads[2] = read('marker', 'M-revoked');
  let e = buildIdentityEvidence(mismatch); assert.equal(e.appUserIdentityProved, false); assert.ok(e.reasons.appUserIdentityProved.includes('run-marker-mismatch'));
  const thread = base(); thread.witnessReads[2] = read('marker', 'M-granted', { threadId: 'T9' });
  e = buildIdentityEvidence(thread); assert.equal(e.appUserIdentityProved, false); assert.ok(e.reasons.appUserIdentityProved.includes('evidence-thread-mismatch'));
  for (const response of [{ answered: true, uncertain: true }, { answered: false, uncertain: false }, undefined, { answered: 'yes', uncertain: false }]) {
    e = buildIdentityEvidence({ ...base(), response }); assert.equal(e.appUserIdentityProved, false); assert.equal(e.propagationProved, false);
    assert.deepEqual(e.rolesProved, { SSAMIdentityRole20261010: false });
  }
  e = buildIdentityEvidence({ ...base(), cleanup: { confirmed: false } }); assert.ok(e.reasons.appUserIdentityProved.includes('cleanup-unconfirmed'));
  e = buildIdentityEvidence({ ...base(), authState: { lane: 'o11' } }); assert.ok(e.reasons.appUserIdentityProved.includes('not-authenticated'));
});
test('roles need granted true and revoked false (or a native NotRegistered refusal with zero submissions), read before and after', () => {
  const role = 'SSAMIdentityRole20261010';
  const grantedOnly = base(); grantedOnly.witnessReads = grantedOnly.witnessReads.filter(r => r.scenario !== 'revoked');
  let e = buildIdentityEvidence(grantedOnly); assert.equal(e.rolesProved[role], false); assert.ok(e.reasons.roles[role].includes('role-revoked-witness-not-false'));
  assert.equal(e.appUserIdentityProved, true); assert.equal(e.propagationProved, false);
  const refusal = structuredClone(grantedOnly); refusal.roleStates[role].revoked.refusal = { native: 'NotRegistered', businessSubmissions: 0 };
  assert.equal(buildIdentityEvidence(refusal).rolesProved[role], true);
  refusal.roleStates[role].revoked.refusal.businessSubmissions = 1; assert.equal(buildIdentityEvidence(refusal).rolesProved[role], false);
  const revokedTrue = base(); revokedTrue.witnessReads[5] = read('role', true, { threadId: 'T2', scenario: 'revoked' });
  assert.equal(buildIdentityEvidence(revokedTrue).rolesProved[role], false);
  const unread = base(); unread.roleStates[role].revoked.after = { read: false, granted: false };
  e = buildIdentityEvidence(unread); assert.equal(e.rolesProved[role], false); assert.ok(e.reasons.roles[role].includes('role-access-read-missing'));
  const state = base(); state.roleStates[role].granted.after.granted = false;
  assert.ok(buildIdentityEvidence(state).reasons.roles[role].includes('role-grant-state-mismatch'));
  const noState = base(); noState.roleStates = {};
  assert.equal(buildIdentityEvidence(noState).rolesProved[role], false);
});
test('an identity private-compare between the caller and producer user-id witnesses in the same pause proves caller equality', () => {
  const ids = [decl('callerUser', 'caller-user-id', { moduleKey: caller, functionKey: callerFn, assignmentNodeKey: key('4'), afterNodeKeys: [key('5')] }), decl('observedUser', 'user-id')];
  const input = { ...without(base(), 'same'), witnesses: [...base().witnesses.filter(w => w.kind !== 'user-equals-caller'), ...ids] };
  const operands = [{ witnessId: 'callerUser', moduleKey: caller, functionKey: callerFn, nodeKey: key('5'), pauseId: 'p1', threadId: 'T1', scenario: 'granted' },
    { witnessId: 'observedUser', moduleKey: producer, functionKey: fn, nodeKey: key('2'), pauseId: 'p1', threadId: 'T1', scenario: 'granted' }];
  const result = { op: 'private-compare', equal: true, bothNonEmpty: true, sameNativeType: true, valueType: 'Identifier', count: 2 };
  assert.equal(buildIdentityEvidence(input).appUserIdentityProved, false);
  let e = buildIdentityEvidence({ ...input, compares: [{ mode: 'identity', operands, result }] });
  assert.equal(e.appUserIdentityProved, true); assert.equal(e.evidence.callerEquality, 'private-compare');
  for (const change of [c => { c.result.equal = false; }, c => { c.result.bothNonEmpty = false; }, c => { c.result.sameNativeType = false; },
    c => { c.operands[1].pauseId = 'p2'; }, c => { c.operands[0].moduleKey = producer; }, c => { c.operands = c.operands.slice(0, 1); },
    // Any two equal values are not identity: mode, user-id types and witness binding are required.
    c => { delete c.mode; }, c => { c.mode = 'equality'; }, c => { c.result.valueType = 'Integer'; }, c => { c.result.count = 3; },
    c => { c.operands.forEach(o => delete o.witnessId); }, c => { c.operands[0].witnessId = 'observedUser'; }, c => { c.operands[1].witnessId = 'present'; },
    c => { c.operands[0].nodeKey = key('4'); }, c => { c.operands[1].functionKey = callerFn; }, c => { c.operands.forEach(o => { o.scenario = 'revoked'; }); }]) {
    const compare = structuredClone({ mode: 'identity', operands, result }); change(compare);
    assert.equal(buildIdentityEvidence({ ...input, compares: [compare] }).appUserIdentityProved, false);
  }
  // A caller-user-id declaration must live in the caller module, never in the producer.
  const misplaced = { ...input, witnesses: input.witnesses.map(w => w.id === 'callerUser' ? { ...w, moduleKey: producer } : w) };
  assert.equal(buildIdentityEvidence({ ...misplaced, compares: [{ mode: 'identity', operands, result }] }).appUserIdentityProved, false);
});
test('present, caller equality and marker must share one scenario on a thread id reused across requests', () => {
  const reused = base(); reused.witnessReads[2] = read('marker', 'M-revoked', { scenario: 'revoked' });
  const e = buildIdentityEvidence(reused); assert.equal(e.appUserIdentityProved, false); assert.ok(e.reasons.appUserIdentityProved.includes('evidence-thread-mismatch'));
  const equality = base(); equality.witnessReads[1] = read('same', true, { scenario: 'revoked' });
  assert.equal(buildIdentityEvidence(equality).appUserIdentityProved, false);
});
test('debugger UserName, ccid and requestId never establish authentication, witnesses or identity', () => {
  const debuggerFields = { userName: 'someone', ccid: 'c', requestId: 'r' };
  // A complete native input stays proved with the fields present: they are ignored, not penalized.
  const complete = buildIdentityEvidence({ ...base(), authState: { ...base().authState, ...debuggerFields }, response: { ...base().response, ...debuggerFields } });
  assert.equal(complete.appUserIdentityProved, true); assert.deepEqual(complete.ignoredInputs, ['ccid', 'requestId', 'userName']);
  assert.doesNotMatch(JSON.stringify(complete), /someone/);
  // They never replace native authentication...
  let e = buildIdentityEvidence({ ...base(), authState: { lane: 'o11', ...debuggerFields, authenticated: true } });
  assert.equal(e.appUserIdentityProved, false); assert.equal(e.evidence.authenticated, false);
  // ...nor missing witnesses: reads that carry only debugger fields (no witness binding) or values equal to them count for nothing.
  for (const id of ['present', 'same', 'marker']) {
    const input = without(base(), id); input.witnessReads.push({ ...base().witnessReads.find(r => r.witnessId === id), witnessId: undefined, ...debuggerFields },
      { ...debuggerFields, moduleKey: producer, functionKey: fn, nodeKey: key('2'), threadId: 'T1', pauseId: 'p1', scenario: 'granted', value: { type: 'Text', value: 'someone' } });
    e = buildIdentityEvidence({ ...input, marker: id === 'marker' ? { granted: 'someone' } : base().marker, compares: [{ mode: 'identity', operands: [], result: { equal: true }, ...debuggerFields }] });
    assert.equal(e.appUserIdentityProved, false, id);
  }
  const odc = buildIdentityEvidence({ ...base(), authState: { lane: 'odc', authenticated: true, userKeySha256: hash('a') } });
  assert.equal(odc.appUserIdentityProved, true);
  assert.equal(buildIdentityEvidence({ ...base(), authState: { lane: 'odc', authenticated: true, ...debuggerFields } }).appUserIdentityProved, false);
});
test('only builder evidence fills boundary slots; contract flags need every boundary', () => {
  const nodes = [['DataAction', caller], ['ServerAction', producer]].map(([kind, moduleKey], i) => ({ id: String(i), key: key(String(i)), kind, moduleKey }));
  const graph = { nodes: new Map(nodes.map(n => [n.id, n])), edges: [{ from: '0', to: '1' }] };
  const captures = [caller, producer].map((moduleKey, i) => ({ target: { moduleKey }, versionId: i + 1 }));
  const { contract } = resolveO11TraceRuntime(graph, { path: [{ id: '0' }, { id: '1' }] }, captures);
  const e = buildIdentityEvidence({ ...base(), boundary: contract.boundaries[0] });
  const applied = applyIdentityEvidence(contract, [e]);
  assert.equal(contract.boundaries[0].identityEvidence, null); assert.equal(contract.appUserIdentityProved, false);
  assert.equal(applied.boundaries[0].identityEvidence, e); assert.equal(applied.boundaries[0].appUserIdentityProved, true);
  assert.equal(applied.boundaries[0].rolesProved, true); assert.equal(applied.appUserIdentityProved, true); assert.equal(applied.propagationProved, true);
  const forged = JSON.parse(JSON.stringify(e));
  assert.throws(() => applyIdentityEvidence(contract, [forged]), /identity_evidence_unbranded/);
  const other = applyIdentityEvidence(contract, [buildIdentityEvidence({ ...base(), boundary: { ...contract.boundaries[0], actionKey: key('Z') } })]);
  assert.equal(other.boundaries[0].appUserIdentityProved, false); assert.equal(other.boundaries[0].identityEvidence, null);
  // Evidence built for another caller never fills this boundary.
  const otherCaller = applyIdentityEvidence(contract, [buildIdentityEvidence({ ...base(), boundary: { ...contract.boundaries[0], callerModuleKey: key('Q') } })]);
  assert.equal(otherCaller.boundaries[0].identityEvidence, null); assert.equal(otherCaller.appUserIdentityProved, false);
  // The same producer action reached twice is ambiguous: neither occurrence is lifted, and duplicate evidence is refused.
  const twice = { ...contract, boundaries: [contract.boundaries[0], { ...contract.boundaries[0] }] };
  const ambiguous = applyIdentityEvidence(twice, [e]);
  assert.deepEqual(ambiguous.boundaries.map(b => [b.identityEvidence, b.appUserIdentityProved, b.identityEvidenceAmbiguous]), [[null, false, true], [null, false, true]]);
  assert.throws(() => applyIdentityEvidence(contract, [e, buildIdentityEvidence({ ...base(), boundary: contract.boundaries[0] })]), /identity_evidence_duplicate/);
});
test('external logic boundaries never prove identity', () => {
  const call = { external: true, actionKey: key('a'), actionKind: 'ServerActionSignature', bodyRead: false,
    reference: { moduleKey: key('b'), originalActionKey: key('c'), moduleType: 'ExternalLibrary', revision: null, consumerSourceSha256: hash('d') } };
  const b = describeOdcCallBoundaries([call]).boundaries[0];
  const e = buildIdentityEvidence({ ...base(), boundary: b, callerModuleKey: caller,
    witnesses: base().witnesses.map(w => ({ ...w, moduleKey: key('b') })), witnessReads: base().witnessReads.map(r => ({ ...r, moduleKey: key('b') })) });
  assert.equal(e.appUserIdentityProved, false); assert.ok(e.reasons.appUserIdentityProved.includes('external-logic-not-in-debugger-model'));
});
