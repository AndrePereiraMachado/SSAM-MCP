// Native provenance qualifier for identity/role witnesses (ssam-identity-witness-qualification/1), O11 and ODC.
// A declared witness {moduleKey, functionKey, nodeKey, variable, kind, role?, roleKey?, roleModuleKey?, sourceSha256}
// is trusted only when the published assignment of its variable is natively bound (installed model expression
// tree, never evaluated) to GetUserId()/NullIdentifier() or to the Check<Role>Role action of the pinned Role.
// Names are labels only: builtins come from the native canonical binding, roles from key + owner module.
// Output feeds buildIdentityEvidence (debug-identity-evidence.mjs); refusals carry reason codes only.
const KEY = /^[A-Za-z0-9_+]{22}$/, HASH = /^[a-f0-9]{64}$/, NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/;
const USER = ['GetUserId'], NULLS = ['NullIdentifier', 'NullTextIdentifier'], IDENTITY = [...USER, ...NULLS];
// Declared kind -> evidence-builder kind.
const KINDS = Object.freeze({ 'user-present': 'user-present', 'user-equals-input': 'user-equals-caller', role: 'role', 'user-id': 'user-id', 'caller-user-id': 'caller-user-id' });
export const IDENTITY_WITNESS_KINDS = Object.freeze(Object.keys(KINDS));
const CAPTURES = new Set(['consumer', 'producer', 'service-app', 'library']);
const AUTHORITY = 'installed-model-expression-tree';
const declarations = new Set(['InputParameter', 'OutputParameter', 'LocalVariable']);
const deepFreeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
const refuse = reason => { throw Object.assign(new Error(reason), { witnessReason: 'witness-' + reason }); };

// Original builtin call with no arguments (GetUserId by default). Bindings from NativeExpressionBindings
// carry no role/functionObject fields and are read the same way.
export function nativeBuiltin(root, names = USER) {
  return root?.kind === 'FunctionCall' && root.functionCall === true && root.originalBuiltin === true && names.includes(root.builtin) &&
    !root.role && !root.functionObject && Array.isArray(root.children) && root.children.length === 0 ? root.builtin : null;
}
// Expression roots of one function, only from a model-only native binding pinned to module, function and source.
export function nativeExpressionMap(binding, { moduleKey, functionKey, sourceSha256 }) {
  if (binding?.available !== true || binding.authority !== AUTHORITY || binding.runtimeValuesEvaluated !== false || !Array.isArray(binding.expressions) ||
      binding.identity?.moduleKey !== moduleKey || binding.identity?.functionKey !== functionKey || binding.identity?.sourceSha256 !== sourceSha256 ||
      !HASH.test(sourceSha256 ?? '')) return null;
  const map = new Map(binding.expressions.filter(e => typeof e?.key === 'string' && e.root && typeof e.root === 'object').map(e => [e.key, e.root]));
  return map.size === binding.expressions.length ? map : null;
}
const unwrap = n => { let d = 0; while (n?.kind === 'ParenthesizedExpression' && n.children?.length === 1 && d++ < 40) n = n.children[0]; return n; };
const foreignCall = n => n?.functionCall === true && !nativeBuiltin(n, IDENTITY);
function substituted(root) {
  let count = 0;
  const visit = (n, depth) => { if (!n || depth > 40 || ++count > 10000) return true;
    return n.functionCall === true && IDENTITY.includes(n.builtin) && n.originalBuiltin !== true || (n.children ?? []).some(c => visit(c, depth + 1)); };
  return visit(root, 0);
}
function value(root, kind, declared, inputs) {
  root = unwrap(root);
  if (substituted(root)) refuse('value-substituted-builtin');
  if (/Literal$/.test(root?.kind ?? '')) refuse('value-literal');
  const pair = () => root?.kind === 'BinaryOperation' && root.children?.length === 2 ? root.children.map(unwrap) : null;
  const ops = pair();
  if (kind === 'user-id' || kind === 'caller-user-id') {
    if (nativeBuiltin(root)) return {};
    refuse(foreignCall(root) ? 'value-foreign-function' : 'value-shape-mismatch');
  }
  if (kind === 'user-present') {
    if (ops && root.operator === 'NotEqual' && (nativeBuiltin(ops[0]) && nativeBuiltin(ops[1], NULLS) || nativeBuiltin(ops[1]) && nativeBuiltin(ops[0], NULLS))) return {};
    refuse(ops?.some(foreignCall) ? 'value-foreign-function' : 'value-shape-mismatch');
  }
  if (kind === 'user-equals-input') {
    const operand = ops && root.operator === 'Equal' ? ops.find(o => !nativeBuiltin(o)) : null;
    const key = operand?.kind === 'Identifier' && !operand.children?.length && operand.usedObjects?.length === 1 ? operand.usedObjects[0]?.key : null;
    if (ops?.filter(o => nativeBuiltin(o)).length === 1 && inputs.has(key) && (declared.input === undefined || declared.input === key)) return { inputKey: key };
    refuse(ops?.some(foreignCall) ? 'value-foreign-function' : 'value-shape-mismatch');
  }
  // role: the pinned role's own Check<Role>Role, for the current user (no argument or GetUserId()).
  if (root?.kind !== 'FunctionCall' || root.functionCall !== true) refuse('value-shape-mismatch');
  const role = root.role;
  if (!role || typeof role !== 'object' || root.functionObject || !['server', 'client'].includes(role.check)) refuse('value-foreign-function');
  if (role.roleKey !== declared.roleKey) refuse('role-key-mismatch');
  if (role.ownerModuleKey !== declared.roleModuleKey) refuse('role-foreign-module');
  if (role.name !== declared.role) refuse('role-name-mismatch');
  const args = (root.children ?? []).map(unwrap);
  if (!(args.length === 0 || args.length === 1 && nativeBuiltin(args[0]))) refuse('role-other-user');
  return { roleBinding: { roleKey: role.roleKey, roleModuleKey: role.ownerModuleKey, persistent: role.persistent ?? null, public: role.public ?? null,
    check: role.check, system: role.system ?? null } };
}
function findFunction(capture, functionKey) {
  const found = []; let count = 0;
  const visit = n => { if (!n || typeof n !== 'object' || ++count > 50000) return; if (n.key === functionKey && Array.isArray(n.children)) found.push(n); (n.children ?? []).forEach(visit); };
  for (const t of Array.isArray(capture.trees) ? capture.trees : []) visit(t?.tree ?? t);
  return found.length === 1 ? found[0] : null;
}
function descendants(root, kind) {
  const out = []; let count = 0;
  const visit = n => { if (++count > 50000) refuse('function-too-large'); if (n.kind === kind) out.push(n); (n.children ?? []).forEach(visit); };
  (root.children ?? []).forEach(visit); return out;
}
function qualify(declared, captures, read) {
  const kind = declared?.kind;
  if (!Object.hasOwn(KINDS, kind ?? '')) refuse('kind-unsupported');
  if (!['moduleKey', 'functionKey', 'nodeKey', 'variable'].every(f => KEY.test(declared[f] ?? '')) || declared.input !== undefined && !KEY.test(declared.input ?? '')) refuse('declaration-invalid');
  if (kind === 'role' && !(NAME.test(declared.role ?? '') && KEY.test(declared.roleKey ?? '') && KEY.test(declared.roleModuleKey ?? ''))) refuse('role-unpinned');
  if (!HASH.test(declared.sourceSha256 ?? '')) refuse('source-unpinned');
  const matching = captures.filter(c => c?.moduleKey === declared.moduleKey);
  if (matching.length !== 1 || !CAPTURES.has(matching[0].kind) || !HASH.test(matching[0].sourceSha256 ?? '')) refuse('capture-invalid');
  const capture = matching[0];
  if (capture.sourceSha256 !== declared.sourceSha256) refuse('source-mismatch');
  const fn = findFunction(capture, declared.functionKey);
  if (!fn) refuse('function-missing');
  const pin = { moduleKey: declared.moduleKey, functionKey: declared.functionKey, sourceSha256: capture.sourceSha256 };
  let binding;
  try { binding = read(pin); } catch { refuse('binding-unavailable'); }
  if (!binding) refuse('binding-unavailable');
  const native = nativeExpressionMap(binding, { ...pin, sourceSha256: binding.identity?.sourceSha256 });
  if (!native || binding.identity.moduleKey !== pin.moduleKey || binding.identity.functionKey !== pin.functionKey) refuse('binding-unqualified');
  if (binding.identity.sourceSha256 !== pin.sourceSha256) refuse('source-mismatch');
  // Flow: the assignment node is enabled and reachable from the single Start; reads happen strictly after it.
  const flow = fn.children.filter(n => typeof n?.kind === 'string' && n.kind.endsWith('Node')), keys = new Set(flow.map(n => n.key));
  const assign = flow.find(n => n.key === declared.nodeKey);
  if (assign?.kind !== 'AssignNode' || assign.properties?.IsDisabled === 'True') refuse('node-invalid');
  const next = n => [n, ...(n.children ?? []).filter(c => /Connector$/.test(c?.kind ?? ''))].flatMap(x => Object.values(x.propertyReferences ?? {}))
    .map(r => r?.key).filter(k => keys.has(k));
  const reach = from => { const seen = new Set(), queue = [from]; for (let i = 0; i < queue.length; i++) for (const k of next(flow.find(n => n.key === queue[i])))
    if (!seen.has(k)) { seen.add(k); queue.push(k); } return seen; };
  const starts = flow.filter(n => n.kind === 'StartNode');
  if (starts.length !== 1 || !reach(starts[0].key).has(assign.key)) refuse('node-unreachable');
  const vars = fn.children.filter(n => declarations.has(n?.kind)), variable = vars.find(v => v.key === declared.variable);
  if (!variable || variable.kind === 'InputParameter') refuse('variable-invalid');
  const bound = a => { const root = native.get(a.key + '.#Variable'); if (!root) refuse('binding-incomplete');
    const r = unwrap(root); return r.kind === 'Identifier' && r.usedObjects?.length === 1 && r.usedObjects[0]?.key === variable.key; };
  const own = (assign.children ?? []).filter(c => c?.kind === 'Assignment').filter(bound);
  if (own.length !== 1) refuse('assignment-missing');
  const root = native.get(own[0].key + '.#Value');
  if (!root) refuse('binding-incomplete');
  if (descendants(fn, 'Assignment').filter(bound).length !== 1) refuse('variable-reassigned');
  const type = variable.propertyReferences?.DataType;
  const userType = variable.properties?.DataType === 'IdentifierType:User Identifier' ||
    type?.kind === 'IdentifierType' && typeof type.path === 'string' && type.path.startsWith('Reference:(System)/ServerEntitySignature:User/');
  if (['user-id', 'caller-user-id'].includes(kind) ? !userType : variable.properties?.DataType !== 'BasicType:Boolean') refuse('variable-type');
  const extra = value(root, kind, declared, new Set(vars.filter(v => v.kind === 'InputParameter').map(v => v.key)));
  const after = [...reach(assign.key)].filter(k => k !== assign.key).sort();
  if (!after.length) refuse('no-node-after-assignment');
  return { id: declared.id, kind: KINDS[kind], declaredKind: kind, qualified: true, moduleKey: declared.moduleKey, functionKey: declared.functionKey,
    assignmentNodeKey: assign.key, afterNodeKeys: after, variableKey: variable.key, sourceSha256: capture.sourceSha256, captureKind: capture.kind,
    ...(kind === 'role' ? { role: declared.role } : {}), ...extra,
    provenance: { authority: AUTHORITY, schema: binding.schema ?? null, contract: binding.contract ?? null, valueExpressionKey: own[0].key + '.#Value',
      runtimeValuesEvaluated: false } };
}

// bindingsReader: ({moduleKey, functionKey, sourceSha256}) => native binding, or an array of bindings.
export function qualifyIdentityWitnesses(declared, captures, bindingsReader) {
  const list = Array.isArray(declared) ? declared.slice(0, 200) : [], caps = Array.isArray(captures) ? captures : [];
  const read = typeof bindingsReader === 'function' ? bindingsReader : pin => (Array.isArray(bindingsReader) ? bindingsReader : [])
    .filter(b => b?.identity?.moduleKey === pin.moduleKey && b.identity.functionKey === pin.functionKey).at(0);
  const ids = list.map(d => typeof d?.id === 'string' && d.id.length > 0 && d.id.length <= 200 ? d.id
    : KEY.test(d?.functionKey ?? '') && KEY.test(d?.nodeKey ?? '') && KEY.test(d?.variable ?? '') ? d.moduleKey + ':' + d.functionKey + ':' + d.nodeKey + ':' + d.variable : null);
  const qualified = [], refused = [];
  list.forEach((d, i) => {
    const id = ids[i];
    if (!id) { refused.push({ id: null, kind: d?.kind ?? null, reason: 'witness-declaration-invalid' }); return; }
    if (ids.filter(x => x === id).length > 1) { refused.push({ id, kind: d.kind ?? null, reason: 'witness-duplicate-id' }); return; }
    try { qualified.push(qualify({ ...d, id }, caps, read)); }
    catch (error) { refused.push({ id, kind: d.kind ?? null, reason: error.witnessReason ?? 'witness-unqualified' }); }
  });
  return deepFreeze({ schema: 'ssam-identity-witness-qualification/1', qualified, refused });
}
