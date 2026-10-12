// Model identities select native evaluator addresses. This module neither
// reads values nor claims runtime access/role propagation from static metadata.
import { completenessBinding } from './debug-scope-completeness.mjs';
const key = /^[A-Za-z0-9_+]{22}$/;
// O11 Traditional Preparation functions carry '<key>.#Preparation' (the session schema refuses it on ODC).
const functionIdentity = /^[A-Za-z0-9_+]{22}(?:\.\#FlowExceptionHandler|\.#Preparation)?$/;
const name = /^[A-Za-z_][A-Za-z0-9_]*$/;
const fail = () => { throw new Error('debug_inspection_model_incomplete'); };
// lane 'odc': ODC Settings are native Variables.SiteProperty (category 'site'); they are reported as 'setting' and
// keep their native address. The server worker maps both labels to the same evaluator tag.
export function nativeInspectionScopeMetadata({ scope, moduleKey, sourceSha256, functionKey, nodeKey, previousNodeKey = null, lane }) {
  if (lane !== undefined && !['o11', 'odc'].includes(lane)) fail();
  const label = category => lane === 'odc' && category === 'site' ? 'setting' : category;
  if (scope?.schema !== 'ssam-native-debug-scope/1' || scope.authority !== 'installed-model-scope-and-watchability' ||
      scope.modelScopeEnumerated !== true || scope.runtimeValuesEvaluated !== false ||
      !key.test(moduleKey) || !functionIdentity.test(functionKey) || !key.test(nodeKey) || !/^[a-f0-9]{64}$/.test(sourceSha256) ||
      scope.moduleKey !== moduleKey || scope.functionKey !== functionKey || scope.nodeKey !== nodeKey ||
      scope.sourceSha256 !== sourceSha256 || (scope.previousNodeKey ?? null) !== previousNodeKey ||
      previousNodeKey != null && !key.test(previousNodeKey) ||
      !['client', 'server'].includes(scope.runtime) || !Array.isArray(scope.variables)) fail();
  const categories = new Set(['input', 'output', 'local', 'client', 'session', 'site', 'setting', 'timer']);
  const seen = new Set();
  const variables = scope.variables.map(v => {
    // A foreign producer needs its own published model hash and frame binding.
    if (v.moduleKey !== moduleKey || !key.test(v.variableKey) || !categories.has(v.category) ||
        typeof v.name !== 'string' || !v.name || /[\r\n\0]/.test(v.name) ||
        typeof v.nativePath !== 'string' || !v.nativePath || /[\r\n\0]/.test(v.nativePath)) fail();
    const category = label(v.category), identity = JSON.stringify([category, v.variableKey, v.nativePath]);
    if (seen.has(identity)) fail(); seen.add(identity);
    return { moduleKey, functionKey, nodeKey, variableKey: v.variableKey, sourceSha256,
      name: v.name, category, path: v.nativePath,
      ...(typeof v.modelKind === 'string' ? { modelKind: v.modelKind } : {}) };
  });
  const coverage = { scopeComplete: false, modelScopeEnumerated: true, runtimeValuesEvaluated: false,
    moduleKey, sourceSha256, functionKey,
    variableCounts: Object.fromEntries([...categories].map(category => [category, variables.filter(v => v.category === category).length])),
    automaticExpressionsEnumerated: scope.automaticExpressionsEnumerated === true,
    automaticExpressionsError: scope.automaticExpressionsError ?? null,
    previousNodeKey, previousExpressionsEnumerated: scope.previousExpressionsEnumerated === true,
    previousExpressionsError: scope.previousExpressionsError ?? null,
    previousExpressionsApplicable: scope.previousExpressionsApplicable === true,
    previousExpressionsCount: scope.previousExpressionsCount ?? null,
    authority: scope.authority, nodeKey, pending: scope.pending };
  return scope.runtime === 'server' ? { server: { variables: variables.map(({ modelKind, ...variable }) => variable) }, coverage }
    : { client: { modules: [{ moduleKey, sourceSha256 }], variables: variables.map(v => ({
      moduleKey, actionKey: functionKey, nodeKey, previousNodeKey, variableKey: v.variableKey, name: v.name, category: v.category, nativePath: v.path,
      ...(v.modelKind ? { modelKind: v.modelKind } : {}) })) }, coverage };
}

// Counts describe only the installed model's enumeration. An empty category is
// distinct from a failed enumeration and never proves runtime value visibility.
// runtimeValuesComplete comes only from a scopeCompleteness result bound to the
// same stop, generation and counts; without one it stays false.
export function nativeBoundScopeCoverage(result, coverage, completeness) {
  if (result?.ok !== true || result.metadataBound !== true || !result.context) return result;
  const context = result.context;
  const matches = (coverage ?? []).filter(c => c.moduleKey === context.moduleKey && c.functionKey === context.functionKey &&
    c.nodeKey === context.nodeKey && (c.previousNodeKey ?? null) === (context.previousNodeKey ?? null));
  if (matches.length !== 1 || matches[0].modelScopeEnumerated !== true || !matches[0].variableCounts) return result;
  // A client scope carries its stop/generation in the flat native context and
  // only the frame identity nested; a nested stop, when present, stays authoritative.
  const stopContext = result.runtime === 'client' && context.stop === undefined && context.generation === undefined
    ? { ...context, stop: result.stop, generation: result.generation } : context;
  const c = matches[0], bound = completenessBinding(completeness, stopContext, c.variableCounts);
  return { ...result, metadataCoverage: { sourceSha256: c.sourceSha256, authority: c.authority,
    modelScopeEnumerated: true, runtimeFrameBound: true,
    automaticExpressionsEnumerated: c.automaticExpressionsEnumerated,
    previousExpressionsEnumerated: c.previousExpressionsEnumerated,
    variableCounts: c.variableCounts, runtimeValuesComplete: bound?.runtimeValuesComplete === true,
    ...(bound ? { residualNativeLimitsOnly: bound.residualNativeLimitsOnly } : {}) } };
}
function complete(node) {
  if (!node || !Array.isArray(node.children) || node.childrenOmitted ||
      Number.isInteger(node.childrenTotal) && node.childrenTotal !== node.children.length ||
      Object.keys(node.propertyErrors ?? {}).length || Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length) fail();
}
export function nativeInspectionActionMetadata({ moduleKey, sourceSha256, tree }) {
  if (!key.test(moduleKey) || !/^[a-f0-9]{64}$/.test(sourceSha256) || !key.test(tree?.key)) fail();
  complete(tree);
  const variables = [];
  const categories = { InputParameter: 'input', OutputParameter: 'output', LocalVariable: 'local' };
  for (const child of tree.children) {
    const category = categories[child.kind];
    if (!category) continue;
    complete(child);
    const variableName = child.name ?? child.properties?.Name;
    if (!key.test(child.key) || !name.test(variableName)) fail();
    variables.push({ moduleKey, functionKey: tree.key, variableKey: child.key, sourceSha256,
      name: variableName, category, path: variableName });
  }
  return { server: { variables }, client: { modules: [{ moduleKey, sourceSha256 }], variables: variables.map(v => ({
    moduleKey, actionKey: v.functionKey, variableKey: v.variableKey, name: v.name, category: v.category })) },
    coverage: { scopeComplete: false, declaredParametersAndLocalsEnumerated: true,
      pending: ['node-outputs', 'owner-screen-block', 'session', 'site-settings', 'client-variables', 'return', 'timer'] } };
}
