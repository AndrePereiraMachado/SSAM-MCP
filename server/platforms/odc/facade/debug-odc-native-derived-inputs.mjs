// A value computed by the published caller must stay computed by that caller.
// This narrow proof accepts the native GetUserId expression on a complete,
// straight-line path to the selected call. It never evaluates the expression.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalizeInputs } from './debug-odc-native-types.mjs';

const fail = code => { throw new Error('debug_odc_native_' + code); };
const nameOf = node => node?.modelName || node?.properties?.Name || node?.name;
const parameters = tree => tree.children.filter(node => /^(InputParameter|InputParameterSignature)$/.test(node.kind));
const typeKey = node => node?.propertyReferences?.DataType?.key;
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const getUserId = value => typeof value === 'string' && /^GetUserId\s*\(\s*\)$/.test(value.trim());
const exactly = list => list.length === 1 ? list[0] : null;

function complete(node) {
  if (!node?.key || !Array.isArray(node.children) || node.childrenOmitted !== 0 || node.childrenTotal !== node.children.length
    || Object.keys(node.propertiesOmitted ?? {}).length || Object.keys(node.propertyErrors ?? {}).length || node.propertiesMissing?.length) return false;
  for (const collection of Object.values(node.propertyReferenceCollections ?? {})) {
    if (collection.omitted !== 0 || !Array.isArray(collection.items) || collection.total !== collection.items.length) return false;
  }
  return node.children.every(complete);
}

function straightPath(tree, call) {
  let node = exactly(tree.children.filter(item => item.kind === 'StartNode'));
  const seen = new Set(), path = [];
  while (node && !seen.has(node.key)) {
    if (node.properties?.IsDisabled === 'True') return null;
    seen.add(node.key); path.push(node);
    if (node.key === call.key) return path;
    if (!['StartNode', 'AssignNode'].includes(node.kind)) return null;
    const target = node.propertyReferences?.Target?.key;
    if (!target || node.children.filter(item => item.kind === 'ActionConnector').some(item => item.propertyReferences?.Target?.key !== target)) return null;
    node = exactly(tree.children.filter(item => item.key === target));
  }
  return null;
}

function localUserId(caller, call, expression, expectedTypeKey) {
  if (!identifier.test(expression)) return null;
  const variable = exactly(caller.children.filter(node => node.kind === 'LocalVariable' && nameOf(node) === expression));
  if (!variable || !expectedTypeKey || typeKey(variable) !== expectedTypeKey) return null;
  const assignments = caller.children.filter(node => node.kind === 'AssignNode').flatMap(node =>
    node.children.filter(child => child.kind === 'Assignment' && child.properties?.Variable?.trim() === expression).map(assignment => ({ node, assignment })));
  const match = exactly(assignments);
  if (!match || !getUserId(match.assignment.properties?.Value)) return null;
  const value = exactly(match.assignment.children.filter(node => node.key === match.assignment.key + '.#Value'));
  const valueType = value?.propertyReferences?.Type, variableType = variable.propertyReferences.DataType;
  // The native Neo projection types GetUserId() as (System).User Identifier,
  // while a declared Text Identifier local is its permitted destination. Keep
  // that specific native conversion explicit; other differing types refuse.
  const userIdToText = valueType?.kind === 'IdentifierType'
    && valueType.path === 'Reference:(System)/ServerEntitySignature:User/IdentifierType:User Identifier'
    && /^[A-Za-z0-9_+]{22}\.\#IdentifierType$/.test(valueType.key ?? '')
    && variableType?.kind === 'BasicType' && variableType.label === 'Text Identifier' && variableType.path === 'BasicType:Text Identifier'
    && exactly(match.assignment.children.filter(node => node.key === match.assignment.key + '.#Variable'))?.propertyReferences?.Type?.key === expectedTypeKey;
  if (valueType?.key !== expectedTypeKey && !userIdToText) return null;
  const beforeCall = straightPath(caller, call);
  if (!beforeCall || !beforeCall.some(node => node.key === match.node.key)) return null;
  return { sourceActionKey: caller.key, variableKey: variable.key, assignmentKey: match.assignment.key, expression: 'GetUserId()',
    ...(userIdToText ? { nativeConversion: 'system-user-identifier-to-text-identifier', sourceTypeKey: valueType.key, destinationTypeKey: expectedTypeKey } : {}) };
}

function screenLiteralDefault(screen, caller, call, expression, expectedTypeKey, contexts = []) {
  if (caller.kind !== 'ScreenAction' || !identifier.test(expression) || !screen || !complete(screen)) return null;
  const variable = exactly(screen.children.filter(n => n.kind === 'LocalVariable' && nameOf(n) === expression));
  if (!variable || typeKey(variable) !== expectedTypeKey || variable.propertyReferences?.DataType?.kind !== 'BasicType') return null;
  // Do not mistake a shadowing action variable/input for the screen's variable.
  if (caller.children.some(n => /^(LocalVariable|InputParameter)$/.test(n.kind) && nameOf(n) === expression)) return null;
  const beforeCall = straightPath(caller, call);
  if (!beforeCall || beforeCall.some(n => n.children.some(c => c.kind === 'Assignment' && c.properties?.Variable?.trim() === expression))) return null;
  const literal = variable.properties?.DefaultValue, dataType = variable.propertyReferences.DataType.label;
  if (contexts.length && contexts.every(context => Object.hasOwn(context?.screen?.variables ?? {}, expression))) {
    if (!['Integer', 'Text', 'Boolean'].includes(dataType)) return null;
    return { ownerKey: screen.key, ownerKind: screen.kind, variableKey: variable.key, variableName: expression,
      dataType, explicitContext: true, sourceActionKey: caller.key,
      stateValidation: 'native-screen-value-before-invoke', evaluatedByDebugger: false };
  }
  let value;
  if (dataType === 'Integer' && /^-?\d+$/.test(literal ?? '') && Number.isSafeInteger(Number(literal))) value = Number(literal);
  else if (dataType === 'Text' && /^"(?:[^"]|"")*"$/.test(literal ?? '')) value = literal.slice(1, -1).replaceAll('""', '"');
  else if (dataType === 'Boolean' && /^(True|False)$/i.test(literal ?? '')) value = literal.toLowerCase() === 'true';
  else return null;
  return { ownerKey: screen.key, ownerKind: screen.kind, variableKey: variable.key, variableName: expression,
    dataType, defaultValueSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    defaultExpressionSha256: createHash('sha256').update(literal).digest('hex'), sourceActionKey: caller.key,
    stateValidation: 'native-screen-value-before-invoke', evaluatedByDebugger: false };
}

export async function qualifyOriginalDerivedInputs({ resolution, readers, contexts = [] }) {
  const bindings = resolution.bindings ?? [], source = readers.sourceContract;
  if (!bindings.some(binding => binding.control === 'derived') || typeof readers.tree !== 'function'
    || typeof source?.path !== 'string' || !/^[a-f0-9]{64}$/i.test(source?.sha256 ?? '')) return bindings;
  const guard = () => {
    if (createHash('sha256').update(fs.readFileSync(source.path)).digest('hex') !== source.sha256.toLowerCase()) fail('derived_input_source_changed');
  };
  guard();
  const path = resolution.path ?? [];
  if (path.length < 2 || path[0].key !== resolution.entry.key || path.at(-1).key !== resolution.target.key) return bindings;
  const trees = [];
  for (const step of path) {
    const tree = await readers.tree('@' + step.key);
    if (!complete(tree) || tree.key !== step.key) return bindings;
    trees.push(tree);
  }
  const calls = [];
  for (let i = 0; i < path.length - 1; i++) {
    const call = exactly(trees[i].children.filter(node => node.path === path[i].via && /^Execute\w*ActionNode$/.test(node.kind)));
    if (!call || call.propertyReferences?.Action?.key !== path[i + 1].key || !straightPath(trees[i], call)) return bindings;
    calls.push(call);
  }
  let screen = null;
  if (trees[0].kind === 'ScreenAction') {
    const parts = trees[0].path.split('/'), index = parts.findIndex(p => /^(MobileScreen|WebScreen):/.test(p));
    if (index >= 0) screen = await readers.tree(parts.slice(0, index + 1).join('/'));
  }
  const result = bindings.map(binding => {
    if (binding.control !== 'derived') return binding;
    let parameterName = binding.targetInput;
    const hops = [];
    for (let i = path.length - 2; i >= 0; i--) {
      const parameter = exactly(parameters(trees[i + 1]).filter(node => nameOf(node) === parameterName));
      if (!parameter || !typeKey(parameter)) return binding;
      const argument = exactly(calls[i].children.filter(node => node.kind === 'Argument' && node.propertyReferences?.Parameter?.key === parameter.key));
      const expression = argument?.properties?.Value?.trim();
      if (typeof expression !== 'string') return binding;
      hops.push({ callerKey: trees[i].key, callKey: calls[i].key, calleeKey: trees[i + 1].key, parameterKey: parameter.key, argumentKey: argument.key });
      const passthrough = exactly(parameters(trees[i]).filter(node => nameOf(node) === expression));
      if (passthrough && typeKey(passthrough) === typeKey(parameter)) { parameterName = expression; continue; }
      const userId = localUserId(trees[i], calls[i], expression, typeKey(parameter));
      const screenDefault = !userId && i === 0 ? screenLiteralDefault(screen, trees[i], calls[i], expression, typeKey(parameter), contexts) : null;
      const origin = userId ?? screenDefault;
      if (!origin) return binding;
      return { ...binding, originalDerived: { schema: 'ssam-odc-original-derived-input/1', kind: screenDefault?.explicitContext ? 'native-screen-local-context' : screenDefault ? 'native-screen-local-default' : 'native-caller-user-id',
        targetInput: binding.targetInput, entryKey: resolution.entry.key, targetKey: resolution.target.key,
        sourceSha256: source.sha256.toLowerCase(), ...origin, hops: hops.reverse(), evaluatedByDebugger: false } };
    }
    return binding;
  });
  guard(); return result;
}

export function canonicalizeOriginalScenarioInputs(inputs, signature, bindings, context) {
  const provided = inputs ?? {}, derived = new Map(bindings.filter(binding => binding.originalDerived?.schema === 'ssam-odc-original-derived-input/1').map(binding => [binding.targetInput, binding]));
  for (const binding of derived.values()) {
    const original = binding.originalDerived;
    if (original.kind === 'native-screen-local-context' && !Object.hasOwn(context?.screen?.variables ?? {}, original.variableName)) fail('screen_context_input_missing');
    if (original.kind === 'native-screen-local-default' && Object.hasOwn(context?.screen?.variables ?? {}, original.variableName)) fail('screen_default_input_overridden');
  }
  for (const binding of bindings) if (binding.control === 'derived' && Object.hasOwn(provided, binding.targetInput)) fail('target_input_not_controllable');
  // Native-entry identifiers are typed by the runtime base the signature carries (identifierBase); none refuses.
  const values = canonicalizeInputs(provided, signature.filter(field => !derived.has(field.name)), { strictIdentifiers: true });
  for (const name of derived.keys()) values[name] = { omitted: true, originalDerived: true };
  return values;
}
