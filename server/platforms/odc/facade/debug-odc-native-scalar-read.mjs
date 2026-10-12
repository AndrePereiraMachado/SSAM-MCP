// Qualifies an original Data Action with only Integer local/output assignments.
// Expressions are inspected structurally; execution stays in the native server.
import { parseExpressionAt } from 'acorn';
import { createHash } from 'node:crypto';
const fail = () => { throw new Error('debug_odc_native_static_read_scalar_unqualified'); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const namePattern = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/;
function complete(node) {
  if (!node?.key || !Array.isArray(node.children) || node.childrenOmitted ||
      node.childrenTotal !== undefined && node.childrenTotal !== node.children.length ||
      Object.keys(node.propertyErrors ?? {}).length || Object.keys(node.propertiesOmitted ?? {}).length || node.propertiesMissing?.length) fail();
}
function integerVariable(variable) {
  complete(variable);
  if (variable.properties?.DataType !== 'BasicType:Integer') fail();
  const value = variable.properties?.DefaultValue;
  if (value === undefined || value === '') { if (variable.children.length) fail(); return; }
  if (typeof value !== 'string' || !/^-?\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) || Number(value) < -2147483648 || Number(value) > 2147483647) fail();
  if (variable.children.length !== 1) fail();
  const child = variable.children[0]; complete(child);
  if (child.kind !== 'TextBasedExpression' || child.key !== variable.key + '.#DefaultValue' ||
      child.name !== value || child.children.length) fail();
}
export function qualifyScalarDataReadModel({ prepared, entry, owner }) {
  complete(entry); complete(owner);
  if (entry.kind !== 'DataAction' || !['MobileScreen', 'MobileBlock'].includes(owner.kind) ||
      entry.path !== owner.path + '/DataAction:' + entry.name ||
      prepared.entry.key !== entry.key || prepared.action.key !== entry.key || prepared.path?.length !== 1 ||
      prepared.path[0].key !== entry.key || prepared.producerTarget || prepared.endpointContract || prepared.adapter ||
      prepared.action.inputs.length || prepared.bindings.length || prepared.effectEvidence.length ||
      prepared.effects.some(effect => effect !== 'read-only') || prepared.callBoundary?.boundaries?.length ||
      prepared.runtimeRequestKeys.some(key => key !== entry.key)) fail();
  let count = 0;
  function visit(node) { if (++count > 300) fail(); complete(node); node.children.forEach(visit); }
  visit(entry);
  const declared = entry.children.filter(n => ['LocalVariable', 'OutputParameter'].includes(n.kind));
  const ownerVariables = owner.children.filter(n => ['InputParameter', 'LocalVariable'].includes(n.kind));
  const names = new Map(), usedOwner = new Set();
  for (const variable of [...declared, ...ownerVariables]) {
    if (!namePattern.test(variable.name) || names.has(variable.name)) fail();
    names.set(variable.name, variable);
  }
  if (!declared.some(v => v.kind === 'OutputParameter') || declared.length > 30) fail();
  declared.forEach(integerVariable);
  for (const event of entry.children.filter(n => n.kind === 'UILifeCycleEvent'))
    if (event.children.length || Object.keys(event.properties ?? {}).length || Object.keys(event.propertyReferences ?? {}).length) fail();
  const nodes = entry.children.filter(n => n.kind.endsWith('Node'));
  if (entry.children.some(n => !['LocalVariable','OutputParameter','UILifeCycleEvent','StartNode','AssignNode','EndNode'].includes(n.kind))) fail();
  const starts = nodes.filter(n => n.kind === 'StartNode'); if (starts.length !== 1) fail();
  function expression(node) {
    if (node.type === 'Literal' && Number.isInteger(node.value) && Math.abs(node.value) <= 2147483648) return;
    if (node.type === 'UnaryExpression' && ['+','-'].includes(node.operator)) return expression(node.argument);
    if (node.type === 'BinaryExpression' && ['+','-','*'].includes(node.operator)) { expression(node.left); expression(node.right); return; }
    if (node.type === 'Identifier') {
      const variable = names.get(node.name);
      if (!variable || variable.properties?.DataType !== 'BasicType:Integer') fail();
      integerVariable(variable);
      if (ownerVariables.includes(variable)) usedOwner.add(variable.key);
      return;
    }
    fail();
  }
  const seen = new Set(), assignments = []; let node = starts[0];
  while (node) {
    if (seen.has(node.key) || node.properties?.IsDisabled === 'True') fail(); seen.add(node.key);
    if (node.kind === 'EndNode') { if (node.children.length || node.propertyReferences?.Target) fail(); break; }
    if (node.children.some(n => n.kind !== 'ActionConnector' && !(node.kind === 'AssignNode' && n.kind === 'Assignment'))) fail();
    for (const assignment of node.children.filter(n => n.kind === 'Assignment')) {
      const destination = assignment.properties?.Variable, value = assignment.properties?.Value;
      if (!declared.some(n => n.name === destination) || typeof value !== 'string' || value.length > 2000 ||
          assignment.children.length !== 2 || !['Variable','Value'].every(field => assignment.children.some(n =>
            n.kind === 'TextBasedExpression' && n.key === assignment.key + '.#' + field && n.name === assignment.properties[field] && !n.children.length))) fail();
      let ast; try { ast = parseExpressionAt(value, 0, {ecmaVersion:'latest'}); } catch { fail(); }
      if (value.slice(ast.end).trim()) fail(); expression(ast);
      assignments.push({ variable: destination, value });
    }
    const connectors = node.children.filter(n => n.kind === 'ActionConnector'), next = node.propertyReferences?.Target?.key;
    if (connectors.length !== 1 || connectors[0].children.length || connectors[0].propertyReferences?.Target?.key !== next) fail();
    node = nodes.find(n => n.key === next); if (!node) fail();
  }
  if (node?.kind !== 'EndNode' || seen.size !== nodes.length || !assignments.length || assignments.length > 30) fail();
  return {schema:'ssam-odc-scalar-read-model/1',classification:'native-scalar-data-read',entryKey:entry.key,
    ownerKey:owner.key,ownerVariables:ownerVariables.filter(n => usedOwner.has(n.key)).map(n => ({key:n.key,name:n.name})),
    assignments,modelTreeSha256:hash({entry,owner}),writesBusinessData:false,staticReads:0};
}
