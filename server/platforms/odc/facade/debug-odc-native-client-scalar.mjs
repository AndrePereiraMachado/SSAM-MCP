// Static qualification only. Arithmetic is compared structurally between the
// published model and bundle, never evaluated or substituted for native code.
import { parse, parseExpressionAt } from 'acorn';
import { createHash } from 'node:crypto';
const fail = () => { throw new Error('debug_odc_native_client_local_scalar_unqualified'); };
const hash = value => createHash('sha256').update(value).digest('hex');
const prop = n => n?.type === 'MemberExpression' && !n.computed ? n.property.name : null;
const id = n => n?.type === 'Identifier' ? n.name : null;
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(v => walk(v, visit));
  else if (value && typeof value === 'object') walk(value, visit);
}
function expression(node, variable, extra) {
  const specialized = extra?.(node, n => expression(n, variable, extra));
  if (specialized) return specialized;
  if (node?.type === 'Literal' && Number.isSafeInteger(node.value)) return { literal: node.value };
  if (node?.type === 'UnaryExpression' && ['+', '-'].includes(node.operator)) return { unary: node.operator, value: expression(node.argument, variable, extra) };
  if (node?.type === 'BinaryExpression' && ['+', '-', '*'].includes(node.operator))
    return { binary: node.operator, left: expression(node.left, variable, extra), right: expression(node.right, variable, extra) };
  const name = variable(node); if (name) return { variable: name }; fail();
}
export function qualifyScalarClientModel(tree) {
  if (tree?.kind !== 'ClientAction') fail();
  let count = 0;
  walkModel(tree);
  function walkModel(n) {
    if (++count > 300 || !Array.isArray(n.children) || n.childrenOmitted || Object.keys(n.propertyErrors ?? {}).length ||
      Object.keys(n.propertiesOmitted ?? {}).length || n.propertiesMissing?.length ||
      Number.isInteger(n.childrenTotal) && n.childrenTotal !== n.children.length) fail();
    n.children.forEach(walkModel);
  }
  const declarations = tree.children.filter(n => ['InputParameter', 'OutputParameter', 'LocalVariable'].includes(n.kind));
  const variables = declarations.map(n => ({ name: n.name ?? n.properties.Name, kind: n.kind, key: n.key }));
  if (!variables.length || variables.length > 30 || new Set(variables.map(v => v.name)).size !== variables.length ||
    variables.some(v => !/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(v.name)) || declarations.some(n => n.properties?.DataType !== 'BasicType:Integer')) fail();
  const nodes = tree.children.filter(n => !declarations.includes(n)), starts = nodes.filter(n => n.kind === 'StartNode');
  if (starts.length !== 1 || nodes.some(n => !['StartNode', 'AssignNode', 'EndNode'].includes(n.kind))) fail();
  const visited = new Set(), assignments = []; let node = starts[0];
  while (node) {
    if (visited.has(node.key)) fail(); visited.add(node.key);
    if (node.kind === 'EndNode') { if (node.children.length) fail(); break; }
    if (node.properties?.IsDisabled === 'True' || node.children.some(c => !['ActionConnector', 'Assignment'].includes(c.kind))) fail();
    for (const child of node.children.filter(n => n.kind === 'Assignment')) {
      const variable = child.properties?.Variable, value = child.properties?.Value;
      if (!variables.some(v => v.name === variable && v.kind !== 'InputParameter') || typeof value !== 'string') fail();
      let ast; try { ast = parseExpressionAt(value, 0, { ecmaVersion: 'latest' }); } catch { fail(); }
      if (value.slice(ast.end).trim()) fail();
      assignments.push({ variable, expression: expression(ast, n => variables.some(v => v.name === id(n)) ? n.name : null) });
    }
    const next = node.propertyReferences?.Target?.key;
    node = nodes.find(n => n.key === next); if (!node) fail();
  }
  if (visited.size !== nodes.length || !assignments.length || assignments.length > 30) fail();
  return { classification: 'native-scalar-local-assignments', actionKey: tree.key, kind: tree.kind,
    variables, assignments, modelTreeSha256: hash(JSON.stringify(tree)) };
}
export function qualifyScalarClientRuntime(prepared, runtime, model, plan, sources) {
  if (model.classification !== 'native-scalar-local-assignments' || plan.member.holder?.kind !== 'function' || plan.view ||
    plan.member.call || plan.lifecycle || Object.keys(plan.endpoints).length || prepared.action.key !== prepared.entry.key ||
    prepared.path?.length !== 1 || prepared.producerTarget || prepared.endpointContract || prepared.adapter ||
    prepared.effects?.length || prepared.effectEvidence?.length || prepared.callBoundary?.boundaries?.length ||
    (prepared.runtimeRequestKeys ?? []).some(key => key !== model.actionKey) || model.actionKey !== plan.member.key ||
    prepared.bindings.some(b => b.control !== 'direct' || b.entryInput !== b.targetInput)) fail();
  return qualifyScalarClientBody(prepared.action.name, runtime, model, plan, sources);
}

// Shared body checker. Optional hooks are supplied only by the closed native
// function-graph checker, which validates each native callback before allowing it.
export function qualifyScalarClientBody(actionName, runtime, model, plan, sources, prepareHooks) {
  const source = sources[plan.member.chunk], ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const matches = ast.body.filter(n => n.type === 'FunctionDeclaration' && n.id.name === plan.member.holder.local);
  if (matches.length !== 1) fail(); const fn = matches[0];
  if (fn.params.some(n => !id(n)) || fn.params.length !== plan.inputs.length + 1) fail();
  const context = fn.params.at(-1).name, controller = plan.member.moduleController;
  const groups = new Map();
  for (const groupName of [plan.member.varsGroup, plan.member.outVarsGroup]) {
    const found = runtime.index.groups[groupName]?.filter(g => g.chunk === plan.member.chunk);
    if (found?.length !== 1 || found[0].attributes.some(v => v.dataType !== (model.variables.find(d => d.name === v.name)?.dataType ?? 'Integer'))) fail();
    groups.set(groupName, found[0].attributes);
  }
  const attrs = [...groups.values()].flat();
  if (attrs.length !== model.variables.length || model.variables.some(v => attrs.filter(a => a.name === v.name).length !== 1)) fail();
  if (plan.inputs.length !== model.variables.filter(v => v.kind === 'InputParameter').length ||
      plan.outputs.length !== model.variables.filter(v => v.kind === 'OutputParameter').length) fail();
  const core = Object.entries(runtime.index.chunks).filter(([,c]) => Object.values(c.keepNames).includes('VariableHolder'));
  if (core.length !== 1) fail(); const [coreFile] = core[0];
  const nativeImports = new Set(ast.body.filter(n => n.type === 'ImportDeclaration' && n.source.value === './' + coreFile)
    .flatMap(n => n.specifiers.map(s => s.local.name)));
  const hooks = prepareHooks?.({ fn, ast, nativeImports, context, plan }) ?? {};
  const holders = new Map(), bags = new Set(), spans = new Set(), allowedNew = new Set(), allowedGroupCalls = new Set();
  walk(fn.body, n => {
    if (n.type === 'FunctionExpression') {
      if (hooks.callbacks?.has(n)) return;
      if (n.params.length !== 1 || !id(n.params[0])) fail(); spans.add(n.params[0].name);
    }
    if (n.type !== 'VariableDeclarator') return;
    if (!id(n.id)) fail();
    if (n.init?.type === 'ObjectExpression' && !n.init.properties.length) { bags.add(n.id.name); return; }
    const outer = n.init, inner = outer?.arguments?.[0], groupCall = inner?.callee;
    if (outer?.type !== 'NewExpression' || prop(outer.callee) !== 'VariableHolder' || !nativeImports.has(id(outer.callee.object)) ||
      outer.arguments.length !== 1 || inner?.type !== 'NewExpression' || inner.arguments.length || groupCall?.type !== 'CallExpression' ||
      prop(groupCall.callee) !== 'getVariableGroupType' || prop(groupCall.callee.object) !== 'constructor' ||
      id(groupCall.callee.object.object) !== controller || groupCall.arguments.length !== 1 || !groups.has(groupCall.arguments[0].value)) fail();
    holders.set(n.id.name, groupCall.arguments[0].value); allowedNew.add(outer); allowedNew.add(inner); allowedGroupCalls.add(groupCall);
  });
  if (spans.size !== 1 || bags.size !== 1 || holders.size !== 2 || new Set(holders.values()).size !== 2) fail();
  const variable = n => prop(n?.object) === 'value' && holders.has(id(n.object.object))
    ? groups.get(holders.get(id(n.object.object))).find(a => a.attrName === prop(n))?.name : null;
  const observed = [], inputs = [];
  const inputClone = n => n?.type === 'CallExpression' && prop(n.callee) === 'clone' && n.arguments.length === 0 &&
    plan.inputs.some(p => id(n.callee.object) === fn.params[p.position]?.name &&
      model.variables.some(v => v.name === p.name && v.kind === 'InputParameter' &&
        ['Record', 'RecordList'].includes(v.dataType) && v.modelTypeKey));
  walk(fn.body, n => {
    if (['AwaitExpression','YieldExpression','UpdateExpression','ImportExpression','TaggedTemplateExpression','ArrowFunctionExpression',
      'ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoWhileStatement','WithStatement'].includes(n.type) ||
      n.type === 'UnaryExpression' && n.operator === 'delete' || n.type === 'MemberExpression' && n.computed ||
      n.type === 'NewExpression' && !allowedNew.has(n)) fail();
    if (n.type === 'CallExpression') {
      const p = prop(n.callee), receiver = id(n.callee?.object);
      if (!(inputClone(n) || hooks.calls?.has(n) || allowedGroupCalls.has(n) || receiver === 'OutSystemsDebugger' && ['push','pop','handleBreakpoint','handleException'].includes(p) ||
        spans.has(receiver) && ['setAttribute','end'].includes(p) || receiver === controller && p === 'callContext' ||
        nativeImports.has(receiver) && p === 'startActiveSpan' && n.arguments[0]?.value === actionName && n.arguments[1]?.type === 'FunctionExpression')) fail();
    }
    if (n.type !== 'AssignmentExpression') return;
    if (n.operator !== '=') fail();
    if (id(n.left) === context && prop(n.right.callee) === 'callContext' && id(n.right.callee.object) === controller) return;
    if (bags.has(id(n.left?.object)) &&
      (prop(n.left) === 'callContext' && id(n.right) === context ||
       prop(n.left) === 'vars' && holders.get(id(n.right)) === plan.member.varsGroup ||
       prop(n.left) === 'outVars' && holders.get(id(n.right)) === plan.member.outVarsGroup)) return;
    const name = variable(n.left), declaration = model.variables.find(v => v.name === name); if (!declaration) fail();
    if (declaration.kind === 'InputParameter') {
      const parameter = plan.inputs.find(p => p.name === name);
      const compound = ['Record', 'RecordList'].includes(declaration.dataType);
      if (!parameter || (compound ? !inputClone(n.right) || id(n.right.callee.object) !== fn.params[parameter.position]?.name
        : id(n.right) !== fn.params[parameter.position]?.name)) fail(); inputs.push(name); return;
    }
    observed.push({ variable: name, expression: expression(n.right, variable, hooks.expression) });
  });
  if (JSON.stringify(observed) !== JSON.stringify(model.assignments) || new Set(inputs).size !== plan.inputs.length || inputs.length !== plan.inputs.length) fail();
  return { schema: 'ssam-odc-client-local-plan/1', actionKey: model.actionKey, chunk: plan.member.chunk,
    chunkSha256: runtime.pins[plan.member.chunk].sha256, coreChunk: coreFile, coreChunkSha256: runtime.pins[coreFile].sha256,
    modelTreeSha256: model.modelTreeSha256, bodySha256: hash(source.slice(fn.start, fn.end)), model,
    classification: model.classification, originalEntry: true, serverDebugger: false, invocationNetworkAllowed: false };
}
