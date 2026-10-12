import test from 'node:test';
import assert from 'node:assert/strict';
import { describeOdcCallBoundaries } from '../debug-odc-call-boundary.mjs';
const key = char => char.repeat(22), hash = char => char.repeat(64);
const library = () => ({ external: true, actionKey: key('a'), actionKind: 'ServerActionSignature', bodyRead: true,
  reference: { moduleKey: key('b'), originalActionKey: key('c'), moduleType: 'ReactiveLibrary', revision: '7', consumerSourceSha256: hash('d') },
  producer: { moduleKey: key('b'), revision: 7, sha256: hash('e') } });

test('exact library model provenance remains distinct from producer trace values and identity', () => {
  const report = describeOdcCallBoundaries([library()], { key: key('f') });
  assert.equal(report.traceScope, 'selected-local-action'); assert.equal(report.producerTargetSelection, 'unavailable');
  const boundary = report.boundaries[0];
  assert.equal(boundary.kind, 'library-reference'); assert.equal(boundary.importedIdentityPinned, true);
  assert.equal(boundary.producerBodyPinned, true); assert.equal(boundary.bodyInspection, 'imported-library-revision');
  for (const flag of ['producerFramesObserved', 'valuesObserved', 'appUserIdentityProved', 'rolesProved', 'propagationProved'])
    assert.equal(boundary[flag], false);
});

test('bodyRead alone, wrong module/revision and unavailable system body cannot claim pinned producer body', () => {
  for (const change of [call => { delete call.reference; }, call => { call.bodyRead = false; },
    call => { call.producer.moduleKey = key('z'); }, call => { call.producer.revision++; },
    call => { call.producer.sha256 = 'invalid'; }, call => { call.reference.revision = '9007199254740993'; }]) {
    const call = library(); change(call);
    const boundary = describeOdcCallBoundaries([call]).boundaries[0];
    assert.equal(boundary.producerBodyPinned, false); assert.equal(boundary.producerSourceSha256, null);
    assert.equal(boundary.bodyInspection, 'unqualified');
  }
});

test('independently deployed service signature never becomes a qualified imported library body', () => {
  const call = library(); call.reference.moduleType = 'ReactiveWeb'; call.actionKind = 'ServiceActionSignature';
  const boundary = describeOdcCallBoundaries([call, { external: false }]).boundaries[0];
  assert.equal(boundary.kind, 'service-reference'); assert.equal(boundary.bodyInspection, 'unqualified');
  assert.equal(boundary.producerFramesObserved, false); assert.equal(boundary.propagationProved, false);
});

test('unversioned service identity is pinned by the consumer signature and current deployed producer', () => {
  const call = library(); call.actionKind = 'ServiceActionSignature';
  call.reference.moduleType = 'Service'; call.reference.revision = null;
  call.producer = { ...call.producer, deployed: true, revision: 713, environmentKey: 'dev' };
  const boundary = describeOdcCallBoundaries([call]).boundaries[0];
  assert.equal(boundary.importedRevision, null); assert.equal(boundary.importedIdentityPinned, true);
  assert.equal(boundary.deployedRevision, 713); assert.equal(boundary.producerBodyPinned, true);
  assert.equal(boundary.bodyInspection, 'deployed-service-revision'); assert.equal(boundary.propagationProved, false);
  for (const change of [value => { value.reference.revision = 'broken'; }, value => { value.reference.consumerSourceSha256 = 'wrong'; },
    value => { value.actionKey = 'wrong'; }, value => { value.producer.moduleKey = key('z'); }]) {
    const invalid = structuredClone(call); change(invalid);
    assert.equal(describeOdcCallBoundaries([invalid]).boundaries[0].producerBodyPinned, false);
  }
  const unversionedLibrary = library(); unversionedLibrary.reference.revision = null;
  assert.equal(describeOdcCallBoundaries([unversionedLibrary]).boundaries[0].importedIdentityPinned, false);
});

import { externalLogicBoundaries, recordExternalLogicStepInto } from '../debug-odc-call-boundary.mjs';
import { resolveOdcProducerTarget } from '../debug-odc-producer-target.mjs';
const external = () => ({ external: true, actionKey: key('a'), actionKind: 'ServerActionSignature', bodyRead: false,
  reference: { moduleKey: key('b'), originalActionKey: key('c'), moduleType: 'ExternalLibrary', revision: null, consumerSourceSha256: hash('d') } });
test('ExternalLibrary reference is external logic outside the debugger model, never a producer frame claim', () => {
  const report = describeOdcCallBoundaries([external(), library()], { key: key('f') }), boundary = report.boundaries[0];
  assert.equal(boundary.kind, 'external-logic-reference'); assert.equal(boundary.bodyInspection, 'external-logic-not-in-debugger-model');
  assert.equal(boundary.importedModuleType, 'ExternalLibrary'); assert.equal(boundary.producerTargetEligible, false);
  assert.equal(boundary.producerBodyPinned, false); assert.equal(boundary.producerSourceSha256, null); assert.equal(boundary.identityEvidence, null);
  assert.equal(boundary.nativeStepInto, 'not-observed');
  for (const flag of ['producerFramesObserved', 'valuesObserved', 'appUserIdentityProved', 'rolesProved', 'propagationProved']) assert.equal(boundary[flag], false);
  assert.equal(report.boundaries[1].identityEvidence, null); assert.equal(report.boundaries[1].kind, 'library-reference');
  // A body read claim on an external library still does not pin a body.
  const claimed = external(); claimed.bodyRead = true; claimed.producer = { moduleKey: key('b'), revision: 1, sha256: hash('e') };
  assert.equal(describeOdcCallBoundaries([claimed]).boundaries[0].producerBodyPinned, false);
  assert.deepEqual(externalLogicBoundaries(report), [{ signatureKey: key('a'), originalActionKey: key('c'), producerModuleKey: key('b'),
    kind: 'external-logic-reference', bodyInspection: 'external-logic-not-in-debugger-model', nativeStepInto: 'not-observed', producerTargetEligible: false }]);
});
test('an external-logic reference is never selected as a producer target', async () => {
  const report = describeOdcCallBoundaries([external()], { key: key('a'), producerTarget: { executable: true, actionKey: key('c'), producerModuleKey: key('b'), signatureKey: key('a') } });
  assert.equal(report.traceScope, 'selected-local-action'); assert.equal(report.producerTargetSelection, 'external-logic-refused');
  assert.equal(report.producerTarget, undefined);
  // An unpinned reference (no module key) never matches a producer target by a shared null module key.
  const unpinned = external(); unpinned.reference.moduleKey = null;
  const kept = describeOdcCallBoundaries([unpinned], { key: key('f'), producerTarget: { executable: true, actionKey: key('g'), signatureKey: key('f'), producerModuleKey: null } });
  assert.equal(kept.producerTargetSelection, 'exact-imported-reference'); assert.equal(kept.producerTarget.actionKey, key('g'));
  const target = { key: key('a'), importedSignature: { signature: { key: key('a'), kind: 'ServerActionSignature', path: 'Reference:Lib/ServerActionSignature:Call', properties: { OriginalKey: key('c') } },
    reference: { path: 'Reference:Lib', properties: { ModuleType: 'ExternalLibrary', ModuleKey: key('b'), Revision: null } } } };
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path'), { createHash } = await import('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-odc-external-')), file = path.join(dir, 'c.oml'); fs.writeFileSync(file, 'x');
  try {
    await assert.rejects(resolveOdcProducerTarget(target, { binding: {}, sourceContract: { path: file, sha256: createHash('sha256').update('x').digest('hex') },
      readExternal: () => assert.fail('must not read an external body') }), /debug_odc_producer_reference_invalid/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('native step-into outcome at the external call node is recorded as observed behavior only', () => {
  const boundary = describeOdcCallBoundaries([external()]).boundaries[0], consumer = key('k'), node = key('n');
  const before = { stack: [{ moduleKey: consumer, nodeKey: node }] };
  let r = recordExternalLogicStepInto(boundary, { callNodeKey: node, before, after: { stack: [{ moduleKey: consumer, nodeKey: key('m') }] } });
  assert.equal(r.schema, 'ssam-odc-external-logic-step-into/1'); assert.equal(r.outcome, 'next-pause-in-consumer-no-external-frame');
  assert.equal(r.phrasing, 'observed-behavior'); assert.equal(r.platformLimitClaimed, false); assert.equal(r.externalFramesObserved, false);
  r = recordExternalLogicStepInto(boundary, { callNodeKey: node, before, after: { stack: [{ moduleKey: consumer }, { moduleKey: key('b') }] } });
  assert.equal(r.outcome, 'external-frames-observed'); assert.equal(r.externalFramesObserved, true);
  assert.equal(recordExternalLogicStepInto(boundary, { callNodeKey: node, before, after: null }).outcome, 'unobserved');
  // Native C# frames rarely carry the reference module key: frames from no module of the pre-call stack are reported as foreign, not external.
  for (const frame of [{ nodeKey: null }, { moduleKey: key('x') }, { moduleKey: 'not-a-key' }]) {
    r = recordExternalLogicStepInto(boundary, { callNodeKey: node, before, after: { stack: [{ moduleKey: consumer }, frame] } });
    assert.equal(r.outcome, 'foreign-frames-observed'); assert.equal(r.externalFramesObserved, false); assert.equal(r.foreignFrames, 1);
  }
  r = recordExternalLogicStepInto(boundary, { callNodeKey: node, before: { stack: [{ moduleKey: key('u') }, { moduleKey: consumer, nodeKey: node }] }, after: { stack: [{ moduleKey: key('u') }] } });
  assert.equal(r.outcome, 'unclassified');
  assert.throws(() => recordExternalLogicStepInto(boundary, { callNodeKey: key('o'), before, after: before }), /step_into_call_node_mismatch/);
  assert.throws(() => recordExternalLogicStepInto(describeOdcCallBoundaries([library()]).boundaries[0], { callNodeKey: node, before, after: before }), /not_external_logic/);
});
