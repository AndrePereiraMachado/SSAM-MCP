// Qualification of a distinct, read-only request while preserving an older
// uncertain request's receipts and mutex. This never reconciles or replays it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { qualifyClientLocalHistory } from './debug-odc-native-client-local.mjs';
import { qualifyScalarDataReadModel } from './debug-odc-native-scalar-read.mjs';
import { qualifyContextReadModel, qualifyContextReadRuntime } from './debug-odc-native-context-read.mjs';
const fail = code => { throw new Error('debug_odc_native_static_read_' + code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ref = (n, p) => n.propertyReferences?.[p];
function complete(tree) {
  let count = 0;
  function visit(n) {
    if (++count > 10000 || !n?.key || !Array.isArray(n.children) || n.childrenOmitted ||
        n.childrenTotal !== undefined && n.childrenTotal !== n.children.length || Object.keys(n.propertyErrors ?? {}).length ||
        Object.keys(n.propertiesOmitted ?? {}).length || n.propertiesMissing?.length) fail('model_incomplete');
    n.children.forEach(visit);
  }
  visit(tree);
}
function flow(tree, allowed) {
  const nodes = tree.children.filter(n => n.kind.endsWith('Node'));
  if (tree.children.some(n => !allowed.includes(n.kind))) fail('flow_unsupported');
  const starts = nodes.filter(n => n.kind === 'StartNode');
  if (starts.length !== 1) fail('flow_unsupported');
  const chain = [], seen = new Set(); let node = starts[0];
  while (node) {
    if (seen.has(node.key) || node.properties?.IsDisabled === 'True') fail('flow_unsupported');
    chain.push(node); seen.add(node.key);
    const connectors = node.children.filter(n => n.kind === 'ActionConnector');
    if (node.kind === 'EndNode') { if (connectors.length || ref(node, 'Target')) fail('flow_unsupported'); break; }
    if (connectors.length !== 1 || ref(connectors[0], 'Target')?.key !== ref(node, 'Target')?.key) fail('flow_unsupported');
    node = nodes.find(n => n.key === ref(node, 'Target')?.key); if (!node) fail('flow_unsupported');
  }
  if (seen.size !== nodes.length || chain.at(-1)?.kind !== 'EndNode') fail('flow_unsupported');
  return chain;
}
function onlyChildren(node, kinds) { if (node.children.some(n => !kinds.includes(n.kind))) fail('flow_unsupported'); }
function expressionChildren(node, fields) {
  return node.children.length === fields.length && fields.every(field => node.children.some(child =>
    child.kind === 'TextBasedExpression' && child.key === node.key + '.#' + field && !child.children.length && child.name === node.properties[field]));
}
export function qualifyStaticReadModel({ prepared, entry, producer, append, entity, builtinListAppend }) {
  [entry, producer, append, entity].forEach(complete);
  const target = prepared.producerTarget;
  if (prepared.entry.key !== entry.key || entry.kind !== 'DataAction' || producer.kind !== 'ServerAction' ||
      target?.kind !== 'library-reference' || target.executable !== true || target.actionKey !== producer.key ||
      target.signatureKey !== prepared.action.key || prepared.adapter || prepared.endpointContract ||
      prepared.action.inputs.length || prepared.bindings.length || prepared.path.length !== 2 ||
      prepared.path[0].key !== entry.key || prepared.path[1].key !== target.signatureKey) fail('entry_unsupported');
  if (append.kind !== 'ServerActionSignature' || !/^[A-Za-z0-9_+]{22}$/.test(builtinListAppend ?? '') ||
      append.properties?.OriginalKey !== builtinListAppend || entity.kind !== 'StaticEntity') fail('native_identity_unproved');
  const systemCalls = prepared.effectEvidence.filter(e => e.actionKey === append.key);
  if (!systemCalls.length || systemCalls.some(e => e.bodyUnavailable !== 'system-model-unavailable' ||
      e.reference?.originalActionKey !== builtinListAppend || e.reference?.moduleKey !== e.producer?.moduleKey ||
      e.reference?.consumerSourceSha256 !== target.sourceContract.sha256.toLowerCase())) fail('native_identity_unproved');
  const actionFlow = flow(producer, ['OutputParameter', 'StartNode', 'EndNode', 'ExecuteServerActionNode']);
  const outputs = producer.children.filter(n => n.kind === 'OutputParameter');
  if (outputs.length !== 1 || ref(outputs[0], 'DataType')?.kind !== 'ListType' || outputs[0].children.length) fail('output_unsupported');
  const output = outputs[0].name;
  const getKey = entity.key + '.#GetEntity', get = entity.children.find(n => n.key === getKey);
  if (!get || get.kind !== 'EntityActionSignature' || !get.children.some(n => n.key === getKey + '.#Id') ||
      !get.children.some(n => n.key === getKey + '.#Record')) fail('static_entity_unproved');
  const records = new Set(entity.children.filter(n => n.kind === 'StaticEntityRecord').map(n => 'Entities.' + entity.name + '.' + n.properties.Identifier));
  const parameters = append.children.filter(n => n.kind === 'InputParameterSignature');
  if (parameters.length !== 2 || append.children.length !== 2 || !parameters.some(n => n.name === 'List') ||
      !parameters.some(n => n.name === 'Element')) fail('native_signature_unproved');
  const parameterKey = name => parameters.find(n => n.name === name).key;
  const body = actionFlow.slice(1, -1), selected = [];
  if (!body.length || body.length > 400 || body.length % 2) fail('flow_unsupported');
  onlyChildren(actionFlow[0], ['ActionConnector']); onlyChildren(actionFlow.at(-1), []);
  for (let i = 0; i < body.length; i += 2) {
    const read = body[i], add = body[i + 1];
    if (read.kind !== 'ExecuteServerActionNode' || ref(read, 'Action')?.key !== getKey ||
        add.kind !== 'ExecuteServerActionNode' || ref(add, 'Action')?.key !== append.key) fail('call_unsupported');
    for (const n of [read, add]) onlyChildren(n, ['Argument', 'ActionConnector']);
    const args = read.children.filter(n => n.kind === 'Argument');
    if (args.length !== 1 || ref(args[0], 'Parameter')?.key !== getKey + '.#Id' || !records.has(args[0].properties.Value) || !expressionChildren(args[0], ['Value']))
      fail('static_identifier_required');
    const addArgs = add.children.filter(n => n.kind === 'Argument');
    if (addArgs.length !== 2 || addArgs.some(n => !expressionChildren(n, ['Value'])) ||
        !addArgs.some(n => ref(n, 'Parameter')?.key === parameterKey('List') && n.properties.Value === output) ||
        !addArgs.some(n => ref(n, 'Parameter')?.key === parameterKey('Element') && n.properties.Value === read.name + '.Record' &&
          ref(n, 'ConcreteParameterType')?.key === entity.key)) fail('append_target_unproved');
    selected.push(args[0].properties.Value);
  }
  const entryFlow = flow(entry, ['OutputParameter', 'UILifeCycleEvent', 'StartNode', 'EndNode', 'ExecuteServerActionNode', 'AssignNode']);
  const out = entry.children.filter(n => n.kind === 'OutputParameter');
  if (out.length !== 1 || out[0].children.length || ref(out[0], 'DataType')?.kind !== 'ListType' ||
      entry.children.filter(n => n.kind === 'UILifeCycleEvent').some(n => n.children.length || Object.keys(n.properties ?? {}).length || Object.keys(n.propertyReferences ?? {}).length) ||
      entryFlow.map(n => n.kind).join(',') !== 'StartNode,ExecuteServerActionNode,AssignNode,EndNode') fail('entry_flow_unsupported');
  const call = entryFlow[1], assign = entryFlow[2];
  if (ref(call, 'Action')?.key !== target.signatureKey) fail('entry_flow_unsupported');
  onlyChildren(entryFlow[0], ['ActionConnector']); onlyChildren(call, ['ActionConnector']); onlyChildren(entryFlow[3], []);
  onlyChildren(assign, ['Assignment', 'ActionConnector']);
  const assignments = assign.children.filter(n => n.kind === 'Assignment');
  if (assignments.length !== 1 || !expressionChildren(assignments[0], ['Variable', 'Value']) || assignments[0].properties.Variable !== out[0].name ||
      assignments[0].properties.Value !== call.name + '.' + output) fail('entry_assignment_unsupported');
  const expectedCalls = [target.signatureKey, ...body.map(n => ref(n, 'Action').key)].sort();
  if (prepared.effectEvidence.some(e => e.kind !== 'ExecuteServerActionNode') ||
      JSON.stringify(prepared.effectEvidence.map(e => e.actionKey).sort()) !== JSON.stringify(expectedCalls)) fail('closure_unsupported');
  return { schema: 'ssam-odc-static-read-model/1', entryKey: entry.key, producerActionKey: producer.key,
    producerModuleKey: target.producerModuleKey, nativeListAppendKey: builtinListAppend, staticEntityKey: entity.key,
    staticReads: selected.length, identifiers: selected, output: out[0].name,
    modelTreeSha256: hash(JSON.stringify({ entry, producer, append, entity })), writesBusinessData: false };
}
export function qualifyStaticReadRuntime(prepared, plan, model, binding, runtime) {
  if (model.classification === 'native-user-context-read') return qualifyContextReadRuntime(prepared, plan, model, binding, runtime);
  if (prepared.entry.key !== model.entryKey || plan.member.key !== model.entryKey || plan.member.call?.kind !== 'data-action' ||
      plan.invocation !== 'data-action' || !plan.view || !plan.screen || plan.lifecycle || plan.inputs.length ||
      Object.keys(plan.endpoints).length !== 1 || !Object.hasOwn(plan.endpoints, plan.member.call.endpoint)) fail('runtime_unsupported');
  if (!/^screenservices\/[A-Za-z0-9_/]+$/.test(plan.member.call.endpoint)) fail('runtime_unsupported');
  if (model.classification === 'native-scalar-data-read' && plan.view.key !== model.ownerKey) fail('runtime_unsupported');
  const runtimeUrl = prepared.producerTarget?.consumer.runtimeUrl ?? binding?.runtimeUrl;
  if (!runtimeUrl) fail('runtime_unsupported');
  const endpoint = new URL(plan.member.call.endpoint, runtimeUrl).pathname;
  return { ...model, endpoint, generatedEndpoint: plan.member.call.endpoint, apiVersion: plan.member.call.apiVersion,
    ownerKey: plan.view.key, screenKey: plan.screen.key };
}
export async function prepareStaticReadQualification(prepared, readers, directory, services = {}) {
  if (!prepared.producerTarget && prepared.entry?.kind === 'ScreenAction' && prepared.action?.kind === 'ServerAction') {
    const source = readers.sourceContract;
    const guard = () => { if (!source || hash(fs.readFileSync(source.path)) !== source.sha256.toLowerCase()) fail('source_changed'); };
    guard();
    if (prepared.path?.length !== 3 || !services.plan?.view?.key || !readers.tree) fail('entry_unsupported');
    const trees = [];
    for (const step of prepared.path) trees.push(await readers.tree('@' + step.key));
    const owner = await readers.tree('@' + services.plan.view.key);
    const nativeBindings = [], readScopes = services.readScopes ?? (await import('./debug-native-scope-reader.mjs')).readNativeInspectionScopes;
    for (let i = 0; i < trees.length; i++) {
      const start = trees[i].children.filter(n => n.kind === 'StartNode');
      if (start.length !== 1) fail('flow_unsupported');
      const native = await readScopes({ lane: 'odc', runtime: i === 2 ? 'server' : 'client', source,
        moduleKey: readers.binding.moduleKey, scopes: [{functionKey: trees[i].key, nodeKeys: [start[0].key]}], directory: path.join(directory, String(i)) });
      if (native.expressionBindings?.length !== 1) fail('native_identity_unproved');
      nativeBindings.push(native.expressionBindings[0]);
    }
    guard();
    return qualifyContextReadModel({prepared,trees,owner,nativeBindings,sourceSha256:source.sha256.toLowerCase(),moduleKey:readers.binding.moduleKey});
  }
  if (!prepared.producerTarget && prepared.entry?.kind === 'DataAction') {
    const source = readers.sourceContract;
    const guard = () => { if (!source || hash(fs.readFileSync(source.path)) !== source.sha256.toLowerCase()) fail('source_changed'); };
    guard();
    if (!services.plan?.view?.key || !readers.tree) fail('entry_unsupported');
    const entry = await readers.tree('@' + prepared.entry.key), owner = await readers.tree('@' + services.plan.view.key);
    guard();
    return {...qualifyScalarDataReadModel({prepared,entry,owner}),sourceSha256:source.sha256.toLowerCase()};
  }
  const owner = readers.inspectionModel?.(prepared.producerTarget?.producerModuleKey);
  if (!owner || !readers.tree) fail('producer_model_required');
  const guard = () => {
    for (const source of [readers.sourceContract, owner.source])
      if (!source || hash(fs.readFileSync(source.path)) !== source.sha256.toLowerCase()) fail('source_changed');
  };
  guard();
  const entry = await readers.tree('@' + prepared.entry.key), producer = await owner.reader.tree('@' + prepared.producerTarget.actionKey);
  const refs = producer.children.filter(n => n.kind === 'ExecuteServerActionNode').map(n => ref(n, 'Action'));
  const entityKeys = [...new Set(refs.filter(r => r?.kind === 'EntityActionSignature' && r.key.endsWith('.#GetEntity')).map(r => r.key.slice(0, 22)))];
  const appendKeys = [...new Set(refs.filter(r => r?.kind === 'ServerActionSignature').map(r => r.key))];
  const starts = producer.children.filter(n => n.kind === 'StartNode');
  if (entityKeys.length !== 1 || appendKeys.length !== 1 || starts.length !== 1) fail('flow_unsupported');
  const entity = await owner.reader.tree('@' + entityKeys[0]), append = await owner.reader.tree('@' + appendKeys[0]);
  const readScopes = services.readScopes ?? (await import('./debug-native-scope-reader.mjs')).readNativeInspectionScopes;
  const native = await readScopes({ lane: 'odc', runtime: 'server', source: owner.source,
    moduleKey: prepared.producerTarget.producerModuleKey, scopes: [{ functionKey: producer.key, nodeKeys: [starts[0].key] }], directory });
  guard();
  return { ...qualifyStaticReadModel({ prepared, entry, producer, entity, append, builtinListAppend: native.nativeBuiltins?.listAppend }),
    sourceSha256: readers.sourceContract.sha256.toLowerCase(), producerSourceSha256: owner.source.sha256.toLowerCase(), nativeEvidence: native.evidence };
}
export function qualifyStaticReadHistory(root, binding, requested, prepared, services) {
  const checked = qualifyClientLocalHistory(root, binding, requested, services);
  const old = JSON.parse(fs.readFileSync(path.join(root, '.local/debugger/native-runs/odc', requested.operationId, 'receipt.json')));
  const oldKeys = new Set([old.entry?.key, ...(old.path ?? []).map(p => p.key)]);
  if (!old.entry?.key || oldKeys.has(prepared.entry.key) || oldKeys.has(prepared.action.key) || oldKeys.has(prepared.producerTarget?.actionKey))
    fail('historical_entry_not_independent');
  if (prepared.entry.kind === 'ScreenAction' && prepared.path.some(p => oldKeys.has(p.key)))
    fail('historical_entry_not_independent');
  return { ...checked, schema: 'ssam-odc-independent-static-read-history/1', historicalEntryKey: old.entry.key,
    distinctEntryKey: prepared.entry.key, historicalOutcomeReconciled: false };
}
