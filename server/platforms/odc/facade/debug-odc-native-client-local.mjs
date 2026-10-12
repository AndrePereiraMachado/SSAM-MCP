// Independent client state evaluation, never historical request reconciliation.
// The private caller supplies evidence pins, not an ignore-lock capability.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { readOdcRuntimeSources, resolveOdcRuntimeEntry } from './debug-odc-native-assets.mjs';
import { qualifyScalarClientModel, qualifyScalarClientRuntime } from './debug-odc-native-client-scalar.mjs';
import { qualifyClientFlowRuntime } from './debug-odc-native-client-flow.mjs';
import { qualifyClientListRuntime } from './debug-odc-native-client-list.mjs';
import { qualifyClientFunctionsRuntime } from './debug-odc-native-client-functions.mjs';

const HASH = /^[a-f0-9]{64}$/, GUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = reason => { throw new Error('debug_odc_native_client_local_' + reason); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const property = n => n?.type === 'MemberExpression' && !n.computed ? n.property.name : null;
const name = n => n?.type === 'Identifier' ? n.name : null;
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
function pinned(file, expected) {
  if (!HASH.test(expected ?? '')) fail('evidence_pin_invalid');
  const bytes = fs.readFileSync(file); if (sha(bytes) !== expected) fail('evidence_changed');
  return JSON.parse(bytes.toString('utf8'));
}
function processAbsent(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

export function qualifyClientLocalHistory(root, binding, requested, { clock = Date.now, isProcessAbsent = processAbsent } = {}) {
  if (!requested || Object.keys(requested).sort().join(',') !== 'debugReceiptSha256,manifestSha256,operationId,receiptSha256'
    || !GUID.test(requested.operationId ?? '')) fail('history_contract_invalid');
  const base = path.join(root, '.local', 'debugger'), operationId = requested.operationId;
  const receiptPath = path.join(base, 'native-runs', 'odc', operationId, 'receipt.json');
  const historical = pinned(receiptPath, requested.receiptSha256);
  const sid = historical.sessionId;
  if (!/^[a-f0-9]{32}$/.test(sid ?? '') || historical.schema !== 'ssam-odc-native-run/1' || historical.lane !== 'odc'
    || historical.operationId !== operationId || historical.uncertain !== true || historical.lockRetained !== true
    || historical.credentialsReleased !== true || historical.serverTrace?.stopped !== true || historical.serverTrace?.sessionId !== sid)
    fail('history_unqualified');
  for (const key of ['tenant', 'module', 'moduleKey', 'runtimeUrl']) if (historical.binding?.[key] !== binding[key]) fail('history_binding_mismatch');
  const hash = sha('odc|' + binding.runtimeUrl + '|' + binding.moduleKey), lockPath = path.join(base, 'native-runs', hash + '.lock');
  const lockBytes = fs.readFileSync(lockPath), lock = JSON.parse(lockBytes.toString('utf8'));
  if (lock.operationId !== operationId || lock.sessionId !== sid) fail('history_lock_mismatch');
  const debugPath = path.join(base, sid, 'receipt.json'), manifestPath = path.join(base, sid, 'manifest.json');
  const debug = pinned(debugPath, requested.debugReceiptSha256), manifest = pinned(manifestPath, requested.manifestSha256);
  const expired = value => Number.isFinite(Date.parse(value)) && Date.parse(value) < clock();
  if (debug.ok !== true || debug.state !== 'stopped' || debug.sessionId !== sid || debug.lane !== 'odc' || !expired(debug.expiresAt)
    || !Number.isSafeInteger(debug.processId) || debug.processId <= 0 || !isProcessAbsent(debug.processId)) fail('history_debugger_not_terminal');
  const oldUser = manifest.appUser;
  if (manifest.sessionId !== sid || manifest.lane !== 'odc' || !expired(oldUser?.expiresAt)
    || oldUser.binding?.sessionId !== sid || oldUser.binding?.lane !== 'odc') fail('history_user_lease_not_expired');
  for (const key of ['runtimeUrl', 'module', 'moduleKey']) if (oldUser.binding[key] !== binding[key]) fail('history_binding_mismatch');
  const app = new URL(binding.runtimeUrl).pathname.split('/').filter(Boolean)[0];
  if (oldUser.binding.app !== app) fail('history_binding_mismatch');
  return { schema: 'ssam-odc-client-local-history/1', operationId, sessionId: sid, receiptSha256: requested.receiptSha256,
    debugReceiptSha256: requested.debugReceiptSha256, manifestSha256: requested.manifestSha256,
    lockSha256: sha(lockBytes), debuggerStopped: true, debuggerProcessAbsent: true, oldAppUserLeaseExpired: true,
    oldCredentialsReleased: true, historicalUncertaintyPreserved: true, historicalLockPreserved: true,
    executionOutcomeReconciled: false };
}

function literal(node) {
  if (node?.type === 'Literal' && ['boolean', 'string', 'number'].includes(typeof node.value) &&
    (typeof node.value !== 'number' || Number.isFinite(node.value))) return { ok: true, value: node.value };
  if (node?.type === 'UnaryExpression' && node.operator === '!' && node.argument?.type === 'Literal'
    && [0, 1].includes(node.argument.value)) return { ok: true, value: !node.argument.value };
  if (node?.type === 'UnaryExpression' && node.operator === '-' && node.argument?.type === 'Literal'
    && typeof node.argument.value === 'number' && Number.isFinite(node.argument.value)) return { ok: true, value: -node.argument.value };
  return { ok: false };
}
function nativeLiteral(value) {
  if (value === 'True' || value === 'False') return value === 'True';
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value ?? '')) { const n = Number(value); if (Number.isSafeInteger(n)) return n; }
  if (/^"(?:[^"\\]|\\.)*"$/.test(value ?? '')) { try { return JSON.parse(value); } catch {} }
  fail('model_expression_unsupported');
}
export function qualifyClientLocalModel(tree, prepared, owner) {
  if (!tree || tree.key !== prepared.action.key || tree.kind !== prepared.action.kind) fail('model_target_mismatch');
  if (tree.kind === 'ClientAction') return qualifyScalarClientModel(tree);
  let count = 0;
  function complete(node) {
    if (++count > 300 || node.childrenOmitted || Object.keys(node.propertyErrors ?? {}).length
      || Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length
      || Number.isInteger(node.childrenTotal) && node.childrenTotal !== (node.children ?? []).length) fail('model_incomplete');
    for (const child of node.children ?? []) complete(child);
  }
  complete(tree);
  if (owner && (!['MobileScreen', 'MobileBlock'].includes(owner.kind) ||
      tree.path !== owner.path + '/ScreenAction:' + tree.name || owner.childrenOmitted ||
      !Array.isArray(owner.children) || owner.childrenTotal !== owner.children.length ||
      Object.keys(owner.propertyErrors ?? {}).length || Object.keys(owner.propertiesOmitted ?? {}).length || owner.propertiesMissing?.length))
    fail('model_owner_unqualified');
  const inputs = (tree.children ?? []).filter(n => n.kind === 'InputParameter').map(n => {
    const input = { name: n.name ?? n.properties?.Name, key: n.key,
      dataType: n.properties?.DataType?.replace(/^BasicType:/, '').replaceAll(' ', '') };
    if (n.properties?.DataType?.startsWith('IdentifierType:')) {
      const type = n.propertyReferences?.DataType;
      // The original ODC ABI represents a local server-entity identifier as a
      // LongInteger. Pin that native type identity; static/text and imported
      // identifiers are not silently treated as numeric identifiers.
      if (type?.kind !== 'IdentifierType' || !/^[A-Za-z0-9_+]{22}\.#IdentifierType$/.test(type.key ?? '') ||
          !/^ServerEntity:[^/]+\/IdentifierType:/.test(type.path ?? '') ||
          !prepared.action.inputs?.some(p => p.key === n.key && p.dataType === 'Identifier' && p.identifierKey === type.key))
        fail('model_identifier_unqualified');
      Object.assign(input, { dataType: 'Identifier', identifierKey: type.key, runtimeDataType: 'LongInteger' });
    }
    return input;
  });
  if (inputs.length > 20 || new Set(inputs.map(i => i.name)).size !== inputs.length || inputs.some(i =>
    !/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(i.name ?? '') || !['Boolean','Integer','Text','Decimal','Currency','LongInteger','Date','Time','DateTime','Identifier'].includes(i.dataType))) fail('model_input_unsupported');
  const nodes = (tree.children ?? []).filter(n => n.kind !== 'InputParameter'), starts = nodes.filter(n => n.kind === 'StartNode'), ends = nodes.filter(n => n.kind === 'EndNode');
  const assigns = nodes.filter(n => n.kind === 'AssignNode');
  if (nodes.length !== 3 || starts.length !== 1 || ends.length !== 1 || assigns.length !== 1
    || starts[0].propertyReferences?.Target?.key !== assigns[0].key || assigns[0].propertyReferences?.Target?.key !== ends[0].key)
    fail('model_flow_unsupported');
  const values = assigns[0].children.filter(n => n.kind === 'Assignment');
  if (!values.length || values.length > 20 || assigns[0].children.some(n => !['Assignment', 'ActionConnector'].includes(n.kind))) fail('model_flow_unsupported');
  const assignments = values.map(n => {
    const variable = n.properties?.Variable;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(variable ?? '')) fail('model_assignment_unsupported');
    const input = inputs.find(i => i.name === n.properties.Value);
    const targets = owner?.children.filter(c => ['InputParameter', 'LocalVariable'].includes(c.kind) && c.name === variable);
    if (owner && (targets.length !== 1 || !/^[A-Za-z0-9_+]{22}$/.test(targets[0].key ?? ''))) fail('model_assignment_target_unqualified');
    return { variable, ...(owner ? { variableKey: targets[0].key } : { attribute: variable[0].toLowerCase() + variable.slice(1) + 'Var' }),
      ...(input ? { input: input.name } : { value: nativeLiteral(n.properties.Value) }) };
  });
  if (new Set(assignments.map(a => a.variableKey ?? a.attribute)).size !== assignments.length) fail('model_assignment_unsupported');
  return { actionKey: tree.key, kind: tree.kind, inputs, assignments, modelTreeSha256: sha(JSON.stringify(tree)),
    ...(owner ? { owner: { key: owner.key, path: owner.path, modelTreeSha256: sha(JSON.stringify(owner)) } } : {}) };
}

// Use the debugger's original registered getter for the exact model variable.
// Screen inputs and locals have different generated attributes; no suffix guess.
export function nativeStateAssignments(ast, model, plan) {
  if (!model.owner) return model.assignments;
  if (model.owner.key !== plan.view?.key) fail('runtime_owner_unqualified');
  const objects = new Map(), registered = [];
  walk(ast, n => {
    if (n.type === 'VariableDeclarator' && name(n.id) && n.init?.type === 'ObjectExpression') {
      const rows = objects.get(n.id.name) ?? []; rows.push(n.init); objects.set(n.id.name, rows);
    }
    if (n.type === 'CallExpression' && name(n.callee?.object) === 'OutSystemsDebugger' && property(n.callee) === 'registerMetaInfo') {
      if (n.arguments.length !== 1 || !name(n.arguments[0])) fail('runtime_metadata_unqualified');
      registered.push(n.arguments[0].name);
    }
  });
  return model.assignments.map(a => {
    const rows = registered.flatMap(id => (objects.get(id) ?? []).flatMap(o => o.properties.filter(p =>
      p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === a.variableKey)));
    if (rows.length !== 1 || rows[0].value.type !== 'ObjectExpression') fail('runtime_metadata_unqualified');
    const getters = rows[0].value.properties.filter(p => p.type === 'Property' && !p.computed && (p.key.name ?? p.key.value) === 'getter');
    let fn = getters[0]?.value;
    if (fn?.type === 'CallExpression' && name(fn.callee) && fn.arguments.length === 2 && fn.arguments[1].value === 'getter') fn = fn.arguments[0];
    const ret = fn?.body?.body;
    const access = ret?.[0]?.argument;
    if (getters.length !== 1 || fn?.type !== 'FunctionExpression' || !name(fn.params[0]) ||
      ret?.length !== 1 || ret[0].type !== 'ReturnStatement' || !property(access) ||
      property(access.object) !== 'variables' || property(access.object.object) !== 'model' ||
      name(access.object.object.object) !== name(fn.params[0])) fail('runtime_metadata_unqualified');
    return { ...a, attribute: property(access) };
  });
}

export function qualifyClientLocalRuntime(prepared, runtime, model) {
  if (model.classification === 'native-local-client-functions') return qualifyClientFunctionsRuntime(prepared, runtime, model);
  if (model.classification === 'native-local-list-flow') return qualifyClientListRuntime(prepared, runtime, model);
  if (model.classification === 'native-closed-client-flow') return qualifyClientFlowRuntime(prepared, runtime, model);
  const plan = resolveOdcRuntimeEntry(prepared, runtime);
  if (model.classification === 'native-scalar-local-assignments')
    return qualifyScalarClientRuntime(prepared, runtime, model, plan, readOdcRuntimeSources(runtime));
  if (!['ScreenAction', 'ClientAction'].includes(prepared.action.kind) || prepared.action.key !== prepared.entry.key
    || prepared.path?.length !== 1 || prepared.producerTarget || prepared.endpointContract || prepared.adapter
    || prepared.effects?.length || prepared.effectEvidence?.length
    || prepared.callBoundary?.boundaries?.length || plan.member.call || plan.lifecycle || Object.keys(plan.endpoints).length
    || plan.outputs.length || model.actionKey !== prepared.action.key || model.kind !== prepared.action.kind)
    fail('entry_not_pure');
  const declaredInputs = model.inputs ?? [];
  if (plan.inputs.length !== declaredInputs.length || (prepared.bindings ?? []).length !== declaredInputs.length ||
    declaredInputs.some(i => !plan.inputs.some(p => p.name === i.name && p.dataType?.replaceAll(' ', '') === (i.runtimeDataType ?? i.dataType)) ||
      !prepared.bindings.some(b => b.control === 'direct' && b.entryInput === i.name && b.targetInput === i.name))) fail('input_binding_unqualified');
  if (!model.assignments?.length || (prepared.runtimeRequestKeys ?? []).some(key => key !== prepared.action.key)) fail('entry_not_pure');
  const sources = readOdcRuntimeSources(runtime), source = sources[plan.member.chunk];
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), classes = [];
  const assignments = nativeStateAssignments(ast, model, plan);
  const coreFiles = Object.entries(runtime.index.chunks ?? {}).filter(([, c]) => Object.values(c.keepNames ?? {}).includes('WidgetIdService'));
  if (coreFiles.length !== 1) fail('runtime_core_unqualified');
  const [coreFile, coreIndex] = coreFiles[0], telemetryExports = new Set();
  walk(parse(sources[coreFile], { ecmaVersion: 'latest', sourceType: 'module' }), n => {
    // Current ODC bundles export the instrumentation namespace as a frozen
    // object with direct function references; older bundles use export getters.
    if (n.type === 'VariableDeclarator' && name(n.id) && property(n.init?.callee) === 'freeze'
      && name(n.init.callee.object) === 'Object' && n.init.arguments[0]?.type === 'ObjectExpression') {
      const start = n.init.arguments[0].properties.find(p => p.type === 'Property' && !p.computed && p.key.name === 'startActiveSpan');
      if (coreIndex.keepNames?.[name(start?.value)] === 'startActiveSpan') telemetryExports.add(n.id.name);
    }
    if (n.type !== 'CallExpression' || !name(n.arguments[0]) || n.arguments[1]?.type !== 'ObjectExpression') return;
    const start = n.arguments[1].properties.find(p => p.type === 'Property' && !p.computed && p.key.name === 'startActiveSpan');
    if (start?.value?.type === 'ArrowFunctionExpression' && coreIndex.keepNames?.[name(start.value.body)] === 'startActiveSpan') telemetryExports.add(n.arguments[0].name);
  });
  const telemetryReceivers = new Set(ast.body.filter(n => n.type === 'ImportDeclaration' && n.source.value === './' + coreFile)
    .flatMap(n => n.specifiers.filter(s => s.type === 'ImportSpecifier' && telemetryExports.has(coreIndex.exports?.[s.imported.name])).map(s => s.local.name)));
  if (telemetryReceivers.size !== 1) fail('runtime_telemetry_unqualified');
  walk(ast, n => { if (['ClassExpression', 'ClassDeclaration'].includes(n.type) && n.start === plan.member.classStart) classes.push(n); });
  if (classes.length !== 1) fail('runtime_class_unqualified');
  const members = runtime.index.functions[prepared.action.key] ?? [];
  const implementations = members.filter(m => m.chunk === plan.member.chunk && m.classStart === plan.member.classStart && m.nativeProxy === plan.member.holder.name);
  if (implementations.length !== 1 || members.filter(m => !m.nativeProxy && m.holder).length !== 1) fail('runtime_proxy_unqualified');
  const implementation = implementations[0];
  if (declaredInputs.length) {
    const groups = runtime.index.groups[implementation.varsGroup]?.filter(g => g.chunk === plan.member.chunk);
    if (groups?.length !== 1 || groups[0].attributes.length !== declaredInputs.length ||
      groups[0].attributes.some(a => !plan.inputs.some(i => i.name === a.name && i.attrName === a.attrName && i.dataType === a.dataType)))
      fail('runtime_input_unqualified');
  }
  const methods = classes[0].body.body;
  const method = n => methods.filter(m => m.type === 'MethodDefinition' && !m.computed && m.key.name === n);
  const body = method(implementation.holder.name), proxy = method(plan.member.holder.name);
  if (body.length !== 1 || proxy.length !== 1) fail('runtime_method_unqualified');
  const observed = [];
  function inspect(fn, isProxy) {
    const aliases = new Map(), spans = new Set(), bags = new Set(), parameters = new Set(fn.value.params.map(name));
    const holders = new Set(), allowedNew = new Set(), allowedGroupCalls = new Set(), inputBindings = [];
    if (fn.value.params.length !== declaredInputs.length + 1 || fn.value.params.some(p => !name(p))) fail('runtime_input_unqualified');
    const inputAttribute = node => property(node?.object) === 'value' && holders.has(name(node.object.object))
      ? plan.inputs.find(i => i.attrName === property(node)) : null;
    walk(fn.value.body, n => {
      if (n.type === 'VariableDeclarator') {
        if (!name(n.id)) fail('runtime_declaration_unqualified');
        if (n.init?.type === 'ObjectExpression' && !n.init.properties.length) bags.add(n.id.name);
        else if (n.init?.type === 'MemberExpression' && n.init.object.type === 'ThisExpression'
          && ['model', 'controller', 'idService'].includes(property(n.init))) aliases.set(n.id.name, property(n.init));
        else {
          const outer = n.init, inner = outer?.arguments?.[0], call = inner?.callee;
          const nativeImport = ast.body.some(d => d.type === 'ImportDeclaration' && d.source.value === './' + coreFile && d.specifiers.some(s => s.local.name === name(outer?.callee?.object)));
          if (isProxy || !declaredInputs.length || outer?.type !== 'NewExpression' || property(outer.callee) !== 'VariableHolder' || !nativeImport ||
            outer.arguments.length !== 1 || inner?.type !== 'NewExpression' || inner.arguments.length || call?.type !== 'CallExpression' ||
            property(call.callee) !== 'getVariableGroupType' || property(call.callee.object) !== 'constructor' ||
            aliases.get(name(call.callee.object.object)) !== 'controller' || call.arguments.length !== 1 || call.arguments[0].value !== implementation.varsGroup)
            fail('runtime_declaration_unqualified');
          holders.add(n.id.name); allowedNew.add(outer); allowedNew.add(inner); allowedGroupCalls.add(call);
        }
      }
      if (n.type === 'FunctionExpression') {
        if (n.params.length !== 1 || !name(n.params[0])) fail('runtime_callback_unqualified');
        spans.add(n.params[0].name);
      }
    });
    walk(fn.value.body, n => {
      if (['AwaitExpression','YieldExpression','UpdateExpression','ImportExpression','TaggedTemplateExpression',
        'ArrowFunctionExpression','ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoWhileStatement','WithStatement'].includes(n.type)
        || n.type === 'UnaryExpression' && n.operator === 'delete' || n.type === 'MemberExpression' && n.computed
        || n.type === 'NewExpression' && !allowedNew.has(n)) fail('runtime_sidecall');
      if (n.type === 'CallExpression') {
        const p = property(n.callee), receiver = name(n.callee?.object);
        const allowed = allowedGroupCalls.has(n) || receiver === 'OutSystemsDebugger' && ['push','pop','handleBreakpoint','handleException'].includes(p)
          || spans.has(receiver) && ['setAttribute','end'].includes(p)
          || aliases.get(receiver) === 'controller' && ['ensureControllerAlive','callContext'].includes(p)
          || telemetryReceivers.has(receiver) && p === 'startActiveSpan' && n.arguments[0]?.value === prepared.action.name && n.arguments[1]?.type === 'FunctionExpression'
          || isProxy && telemetryReceivers.has(receiver) && p === 'startActiveSpan' && n.arguments[0]?.value === prepared.action.name + '__proxy' && n.arguments[1]?.type === 'FunctionExpression'
          || isProxy && aliases.get(receiver) === 'controller' && p === 'safeExecuteClientAction'
            && property(n.arguments[0]) === implementation.holder.name && name(n.arguments[0].object) === receiver
            && n.arguments.length === fn.value.params.length + 1 && n.arguments.slice(1).every((a, i) =>
              name(a) === name(i === 0 ? fn.value.params.at(-1) : fn.value.params[i - 1]));
        if (!allowed) fail('runtime_sidecall');
      }
      if (n.type === 'AssignmentExpression') {
        if (n.operator !== '=') fail('runtime_assignment_unqualified');
        const left = n.left;
        if (name(left) && parameters.has(left.name) && property(n.right?.callee) === 'callContext'
          && aliases.get(name(n.right.callee.object)) === 'controller') return;
        if (bags.has(name(left?.object)) && ['model','idService','callContext'].includes(property(left))
          && n.right.type === 'Identifier' && (aliases.has(n.right.name) || parameters.has(n.right.name))) return;
        if (bags.has(name(left?.object)) && property(left) === 'vars' && holders.has(name(n.right))) return;
        const input = inputAttribute(left);
        if (input) {
          if (isProxy || name(n.right) !== name(fn.value.params[input.position])) fail('runtime_input_unqualified');
          inputBindings.push(input.name); return;
        }
        if (!isProxy && property(left?.object) === 'variables' && aliases.get(name(left.object.object)) === 'model') {
          const value = literal(n.right), attribute = property(left);
          const sourceInput = inputAttribute(n.right);
          if (sourceInput && assignments.some(a => a.attribute === attribute && a.input === sourceInput.name)) {
            observed.push({ attribute, input: sourceInput.name }); return;
          }
          if (!value.ok || !assignments.some(a => a.attribute === attribute && a.value === value.value)) fail('runtime_assignment_unqualified');
          observed.push({ attribute, value: value.value }); return;
        }
        fail('runtime_assignment_unqualified');
      }
    });
    if (!isProxy && (holders.size !== (declaredInputs.length ? 1 : 0) || inputBindings.length !== declaredInputs.length ||
      new Set(inputBindings).size !== declaredInputs.length)) fail('runtime_input_unqualified');
  }
  inspect(body[0], false); inspect(proxy[0], true);
  if (JSON.stringify(observed) !== JSON.stringify(assignments.map(a => ({ attribute: a.attribute, ...(a.input ? { input:a.input } : { value:a.value }) })))) fail('runtime_assignment_mismatch');
  return { schema: 'ssam-odc-client-local-plan/1', actionKey: prepared.action.key, chunk: plan.member.chunk,
    chunkSha256: runtime.pins[plan.member.chunk].sha256, modelTreeSha256: model.modelTreeSha256,
    coreChunk: coreFile, coreChunkSha256: runtime.pins[coreFile].sha256,
    bodySha256: sha(source.slice(body[0].start, body[0].end)), model,
    classification: declaredInputs.length ? 'native-input-state-assignments' : 'native-literal-state-assignments', originalEntry: true, serverDebugger: false, invocationNetworkAllowed: false };
}

export function createClientLocalNetworkBarrier(enabled) {
  let invoking = false, attempted = 0;
  return Object.freeze({
    enter() { invoking = true; },
    leave() { invoking = false; },
    check(kind) { if (enabled && (invoking || kind !== 'metadata')) { attempted++; fail('network_forbidden'); } },
    receipt() { return { enabled: enabled === true, networkAttemptsBlocked: attempted, invocationNetworkAllowed: false }; },
  });
}
