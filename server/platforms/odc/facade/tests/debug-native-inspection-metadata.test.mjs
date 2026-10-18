import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeInspectionActionMetadata, nativeInspectionScopeMetadata, nativeBoundScopeCoverage } from '../debug-native-inspection-metadata.mjs';
import { debugSchema } from '../debug.mjs';
import { scopeCompleteness } from '../debug-scope-completeness.mjs';
const node = { key: 'A'.repeat(22), kind: 'ServerAction', childrenTotal: 2, childrenOmitted: 0,
  children: [{ key: 'B'.repeat(22), kind: 'InputParameter', name: 'Amount', children: [] },
    { key: 'C'.repeat(22), kind: 'LocalVariable', name: 'Result', children: [] }] };
test('native scope projection binds hash, function and breakpoint and preserves original addresses', () => {
  const binding = { moduleKey: 'D'.repeat(22), functionKey: 'A'.repeat(22), nodeKey: 'E'.repeat(22), sourceSha256: 'a'.repeat(64) };
  const scope = { schema:'ssam-native-debug-scope/1', authority:'installed-model-scope-and-watchability',
    modelScopeEnumerated:true, runtimeValuesEvaluated:false, runtime:'client', ...binding,
    variables:[{moduleKey:binding.moduleKey,variableKey:'B'.repeat(22),name:'Client.LastValue',category:'client',nativePath:'LastValue',modelKind:'ServiceStudio.Model.Variables.ClientVariable'}] };
  const result = nativeInspectionScopeMetadata({scope,...binding});
  assert.equal(result.client.variables[0].nodeKey,binding.nodeKey);
  assert.equal(result.client.variables[0].nativePath,'LastValue');
  assert.equal(result.client.variables[0].modelKind,'ServiceStudio.Model.Variables.ClientVariable');
  const exceptionKey='LXQ1dKTtRUeai5qBhffq7g.#FlowExceptionHandler';
  const exception=nativeInspectionScopeMetadata({scope:{...scope,functionKey:exceptionKey},...binding,functionKey:exceptionKey});
  assert.equal(exception.client.variables[0].actionKey,exceptionKey);
  assert.throws(()=>nativeInspectionScopeMetadata({scope:{...scope,functionKey:exceptionKey+'.other'},...binding,functionKey:exceptionKey+'.other'}));
  const server = nativeInspectionScopeMetadata({scope:{...scope,runtime:'server'},...binding});
  assert.equal('modelKind' in server.server.variables[0],false);
  assert.equal(result.coverage.scopeComplete,false);
  assert.equal(result.coverage.variableCounts.input,0);
  assert.equal(result.coverage.variableCounts.client,1);
  const bound={ok:true,metadataBound:true,context:binding};
  assert.equal(nativeBoundScopeCoverage(bound,[result.coverage]).metadataCoverage.variableCounts.input,0);
  assert.equal(nativeBoundScopeCoverage(bound,[result.coverage]).metadataCoverage.runtimeValuesComplete,false);
  assert.equal(nativeBoundScopeCoverage({...bound,metadataBound:false},[result.coverage]).metadataCoverage,undefined);
  assert.equal(nativeBoundScopeCoverage({...bound,context:{...binding,nodeKey:'F'.repeat(22)}},[result.coverage]).metadataCoverage,undefined);
  assert.equal(nativeBoundScopeCoverage(bound,[result.coverage,result.coverage]).metadataCoverage,undefined);
  const autoScope = {...scope, automaticExpressionsEnumerated:true, variables:[...scope.variables,
    {moduleKey:binding.moduleKey,variableKey:'C'.repeat(22),name:'MakeText.Result',category:'local',nativePath:'MakeText.Result'}]};
  const auto = nativeInspectionScopeMetadata({scope:autoScope,...binding});
  assert.equal(auto.coverage.automaticExpressionsEnumerated,true);
  assert.equal(auto.client.variables[1].nativePath,'MakeText.Result');
  assert.equal(auto.coverage.scopeComplete,false);
  for(const field of ['sourceSha256','nodeKey','functionKey','moduleKey'])
    assert.throws(()=>nativeInspectionScopeMetadata({scope,...binding,[field]:'X'}));
  assert.throws(()=>nativeInspectionScopeMetadata({scope:{...scope,variables:[...scope.variables,...scope.variables]},...binding}));
});
test('runtimeValuesComplete comes only from a matching per-leaf completeness result', () => {
  const binding = { moduleKey: 'D'.repeat(22), functionKey: 'A'.repeat(22), nodeKey: 'E'.repeat(22), sourceSha256: 'a'.repeat(64) };
  const scope = { schema:'ssam-native-debug-scope/1', authority:'installed-model-scope-and-watchability',
    modelScopeEnumerated:true, runtimeValuesEvaluated:false, runtime:'server', ...binding,
    variables:[{moduleKey:binding.moduleKey,variableKey:'B'.repeat(22),name:'Amount',category:'input',nativePath:'Amount'}] };
  const { coverage } = nativeInspectionScopeMetadata({ scope, ...binding });
  const context = { runtime:'server', threadId:'T1', eventId:'7', frame:0, generation:3, ...binding };
  const bound = { ok:true, metadataBound:true, context };
  const metadataCoverage = nativeBoundScopeCoverage(bound,[coverage]).metadataCoverage;
  const reference = 'r'.repeat(32);
  const reads = [{ ok:true, context, reference, evaluationRevision:1, changed:null, children:[], offset:0, nextOffset:null, availableChildren:0,
    collectionCoverage:null, deferred:false, nativeTrimmed:false, redacted:false,
    value:{ reference, path:'Amount', category:'input', type:'Scalar', value:'42', textOffset:0, textLength:2, nextTextOffset:null,
      valueComplete:true, nativeSummary:false, redacted:false, unavailable:false, undefined:false, trimmed:false, deferred:false, hasChildren:false } }];
  const variables = [{ reference, name:'Amount', category:'input', moduleKey:binding.moduleKey, functionKey:binding.functionKey,
    variableKey:'B'.repeat(22), source:'published-model', sourceSha256:binding.sourceSha256 }];
  const completeness = scopeCompleteness({ lane:'o11', runtime:'server', stop:{ threadId:'T1', eventId:'7' }, generation:3,
    metadataCoverage, scopeVariables:variables, reads });
  assert.equal(completeness.runtimeValuesComplete, true);
  assert.equal(nativeBoundScopeCoverage(bound,[coverage],completeness).metadataCoverage.runtimeValuesComplete, true);
  assert.equal(nativeBoundScopeCoverage(bound,[coverage],completeness).metadataCoverage.residualNativeLimitsOnly, false);
  // Absent, foreign-stop, older-generation or incomplete evidence keeps false.
  assert.equal(nativeBoundScopeCoverage(bound,[coverage]).metadataCoverage.runtimeValuesComplete, false);
  assert.equal('residualNativeLimitsOnly' in nativeBoundScopeCoverage(bound,[coverage]).metadataCoverage, false);
  assert.equal(nativeBoundScopeCoverage({ ...bound, context:{ ...context, eventId:'8' } },[coverage],completeness).metadataCoverage.runtimeValuesComplete, false);
  assert.equal(nativeBoundScopeCoverage({ ...bound, context:{ ...context, generation:4 } },[coverage],completeness).metadataCoverage.runtimeValuesComplete, false);
  assert.equal(nativeBoundScopeCoverage(bound,[coverage],{ ...completeness, runtimeValuesComplete:false }).metadataCoverage.runtimeValuesComplete, false);
  assert.equal(nativeBoundScopeCoverage(bound,[coverage],{ runtimeValuesComplete:true }).metadataCoverage.runtimeValuesComplete, false);
});
test('inspection metadata preserves model keys and refuses incomplete roots', () => {
  const result = nativeInspectionActionMetadata({ moduleKey: 'D'.repeat(22), sourceSha256: 'a'.repeat(64), tree: node });
  assert.equal(result.server.variables[0].variableKey, 'B'.repeat(22));
  assert.equal(result.client.variables[1].actionKey, node.key);
  assert.equal(result.coverage.scopeComplete, false);
  assert.throws(() => nativeInspectionActionMetadata({ moduleKey: 'D'.repeat(22), sourceSha256: 'a'.repeat(64), tree: { ...node, childrenOmitted: 1 } }));
});
test('interactive public contract separates leases from automatic traces and protects references', () => {
  const input = { op: 'start', lane: 'o11', module: 'Fixture', moduleKey: 'D'.repeat(22), runtimeUrl: 'https://example.invalid/Fixture/', nodeKeys: ['A'.repeat(22)], inspection: { variables: [] }, autoContinue: false };
  assert.equal(debugSchema.parse(input).inspection.variables.length, 0);
  assert.equal(debugSchema.safeParse({ ...input, autoContinue: true }).success, false);
  assert.equal(debugSchema.safeParse({ op: 'read', sessionId: 'a'.repeat(32), threadId: 'T', eventId: '1' }).success, false);
  const read = { op: 'expand', sessionId: 'a'.repeat(32), threadId: 'T', eventId: '1', reference: 'b'.repeat(32) };
  assert.equal(debugSchema.safeParse({ ...read, childPath: '[151].Count' }).success, true);
  assert.equal(debugSchema.safeParse({ ...read, childPath: '.Constructor()' }).success, false);
});
test('client-shaped scope results bind coverage with their flat stop/generation; ambiguous or duplicate coverage is still dropped', () => {
  const binding = { moduleKey: 'D'.repeat(22), functionKey: 'A'.repeat(22), nodeKey: 'E'.repeat(22), sourceSha256: 'a'.repeat(64) };
  const scope = { schema:'ssam-native-debug-scope/1', authority:'installed-model-scope-and-watchability',
    modelScopeEnumerated:true, runtimeValuesEvaluated:false, runtime:'client', ...binding,
    variables:[{moduleKey:binding.moduleKey,variableKey:'B'.repeat(22),name:'Client.LastValue',category:'client',nativePath:'LastValue'},
      {moduleKey:binding.moduleKey,variableKey:'C'.repeat(22),name:'Input1',category:'local',nativePath:'Input1',modelKind:'ServiceStudio.Plugin.NRWidgets.Input'}] };
  const { coverage } = nativeInspectionScopeMetadata({ scope, ...binding });
  const ref = n => String(n).repeat(48);
  // Shape returned by the client session: flat native context, nested frame binding context.
  const result = { ok:true, runtime:'client', platform:'odc', stop:2, generation:5, frame:0, metadataBound:true,
    context:{ moduleKey:binding.moduleKey, functionKey:binding.functionKey, nodeKey:binding.nodeKey, previousNodeKey:null },
    variables:[{ ref:ref(1), name:'Client.LastValue', category:'client', nativePath:'LastValue', stop:2, generation:5 },
      { ref:ref(2), name:'Input1', category:'local', nativePath:'Input1', stop:2, generation:5 }] };
  const metadataCoverage = nativeBoundScopeCoverage(result,[coverage]).metadataCoverage;
  assert.equal(metadataCoverage.runtimeFrameBound, true);
  assert.equal(metadataCoverage.variableCounts.client, 1); assert.equal(metadataCoverage.variableCounts.local, 1);
  assert.equal(metadataCoverage.runtimeValuesComplete, false);
  const reads = [1, 2].map(n => ({ ref:ref(n), stop:2, generation:5, value:{ type:'Text', value:'v' }, valueComplete:true }));
  const completeness = scopeCompleteness({ lane:'odc', runtime:'client', stop:2, generation:5, metadataCoverage, scopeVariables:result, reads });
  assert.equal(completeness.runtimeValuesComplete, true);
  assert.equal(nativeBoundScopeCoverage(result,[coverage],completeness).metadataCoverage.runtimeValuesComplete, true);
  assert.equal(nativeBoundScopeCoverage({ ...result, stop:3 },[coverage],completeness).metadataCoverage.runtimeValuesComplete, false);
  assert.equal(nativeBoundScopeCoverage({ ...result, generation:6 },[coverage],completeness).metadataCoverage.runtimeValuesComplete, false);
  assert.equal(nativeBoundScopeCoverage(result,[coverage,coverage],completeness).metadataCoverage, undefined);
  assert.equal(nativeBoundScopeCoverage(result,[coverage,{ ...coverage, sourceSha256:'b'.repeat(64) }]).metadataCoverage, undefined);
  assert.equal(nativeBoundScopeCoverage({ ...result, context:{ ...result.context, previousNodeKey:'F'.repeat(22) } },[coverage]).metadataCoverage, undefined);
  // A nested stop is authoritative: a client result cannot replace it with a different flat stop.
  assert.equal(nativeBoundScopeCoverage({ ...result, context:{ ...result.context, stop:9, generation:5 } },[coverage],completeness).metadataCoverage.runtimeValuesComplete, false);
});
test('odc lane reports Settings (native SiteProperty) as setting; o11 and unlaned callers keep site; nativePath is identical', () => {
  const binding = { moduleKey: 'D'.repeat(22), functionKey: 'A'.repeat(22), nodeKey: 'E'.repeat(22), sourceSha256: 'a'.repeat(64) };
  const variables = [{moduleKey:binding.moduleKey,variableKey:'B'.repeat(22),name:'Site.ApiLimit',category:'site',nativePath:'Site.ApiLimit'},
    {moduleKey:binding.moduleKey,variableKey:'C'.repeat(22),name:'Amount',category:'input',nativePath:'Amount'}];
  for (const runtime of ['server', 'client']) {
    const scope = { schema:'ssam-native-debug-scope/1', authority:'installed-model-scope-and-watchability',
      modelScopeEnumerated:true, runtimeValuesEvaluated:false, runtime, ...binding, variables };
    const odc = nativeInspectionScopeMetadata({ scope, ...binding, lane:'odc' });
    const rows = odc[runtime].variables, pathOf = v => runtime === 'server' ? v.path : v.nativePath;
    assert.deepEqual(rows.map(v => v.category), ['setting', 'input']);
    assert.deepEqual(rows.map(pathOf), ['Site.ApiLimit', 'Amount']);
    assert.deepEqual(rows.map(v => v.variableKey), ['B'.repeat(22), 'C'.repeat(22)]);
    assert.equal(odc.coverage.variableCounts.setting, 1); assert.equal(odc.coverage.variableCounts.site, 0);
    for (const lane of ['o11', undefined]) {
      const kept = nativeInspectionScopeMetadata({ scope, ...binding, ...(lane ? { lane } : {}) });
      assert.deepEqual(kept[runtime].variables.map(v => v.category), ['site', 'input']);
      assert.deepEqual(kept[runtime].variables.map(pathOf), rows.map(pathOf));
      assert.equal(kept.coverage.variableCounts.site, 1); assert.equal(kept.coverage.variableCounts.setting, 0);
    }
    // A relabelled Setting that duplicates a native 'setting' row of the same address is still one identity.
    assert.throws(() => nativeInspectionScopeMetadata({ scope:{ ...scope, variables:[...variables, { ...variables[0], category:'setting' }] }, ...binding, lane:'odc' }));
    assert.throws(() => nativeInspectionScopeMetadata({ scope, ...binding, lane:'other' }));
  }
});
