// Context is assigned only through the published model's typed attributes and
// its own setInputs method. Runtime state (fetch status, roles, widgets) is never
// writable through this surface. No generated application body is changed.
import { parse } from 'acorn';
import { canonicalizeValue } from './debug-odc-native-types.mjs';

const fail = code => { throw new Error('debug_odc_native_' + code); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const member = node => node?.type === 'MemberExpression' ? node.computed ? node.property?.value : node.property?.name : null;
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

function nativeInputBindingDetails(model) {
  if (typeof model?.setInputs !== 'function') fail('context_model_inputs_unavailable');
  let method;
  try { method = parse('({' + Function.prototype.toString.call(model.setInputs) + '})', { ecmaVersion: 'latest' }).body[0].expression.properties[0].value; }
  catch { fail('context_input_binding_unresolved'); }
  const parameter = method.params[0]?.name, bindings = new Map();
  walk(method.body, node => {
    if (node.type !== 'AssignmentExpression' || node.operator !== '=' || member(node.left?.object) !== 'variables' || node.left.object.object?.type !== 'ThisExpression') return;
    const converted = node.right?.type === 'CallExpression' && member(node.right.callee) === 'from';
    const input = converted ? node.right.arguments[0] : node.right;
    if (input?.type !== 'MemberExpression' || input.object?.name !== parameter || typeof member(input) !== 'string') return;
    const attribute = member(node.left), name = member(input);
    // Blocks receive already-converted native values; screens may convert wire
    // values in setInputs. Internal fetch-status assignments are not inputs.
    if (typeof attribute !== 'string' || !/In$/.test(attribute)) return;
    const binding = { name, format: converted ? 'wire' : 'native' };
    const prior = bindings.get(attribute);
    if (prior && (prior.name !== binding.name || prior.format !== binding.format)) fail('context_input_binding_ambiguous');
    bindings.set(attribute, binding);
  });
  return bindings;
}

export function nativeInputBindings(model) {
  return new Map([...nativeInputBindingDetails(model)].map(([attribute, binding]) => [attribute, binding.name]));
}

function nativeType(attribute, dataTypes, depth = 0) {
  if (depth > 12) fail('context_type_depth_limit');
  const type = Object.entries(dataTypes).find(([key, value]) => typeof value === 'number' && value === attribute.dataType)?.[0];
  if (!type) fail('context_type_unresolved');
  const dataType = ({ LongInteger: 'Long Integer', DateTime: 'Date Time', PhoneNumber: 'Phone Number' })[type] ?? type;
  const field = { name: attribute.name, dataType, mandatory: false };
  if (type === 'Record' || type === 'RecordList') {
    const Class = attribute.complexType;
    const Item = type === 'RecordList' ? Class?.getItemType?.() : Class;
    const attrs = typeof Item?.getAttributes === 'function' ? Item.getAttributes() : null;
    if (attrs) {
      field.complexType = attrs.map(a => nativeType(a, dataTypes, depth + 1));
      field.nativeAttributes = attrs;
    } else if (type === 'RecordList' && typeof Item === 'number') {
      field.elementType = nativeType({ name: 'Item', dataType: Item }, dataTypes, depth + 1);
    } else fail('context_complex_type_unresolved');
  }
  return field;
}

function wireValue(value, field) {
  if (value == null) return value;
  if (field.dataType === 'Record') return Object.fromEntries(field.complexType.map((f, i) =>
    [field.nativeAttributes[i].name, wireValue(value[f.name], f)]));
  if (field.dataType === 'RecordList') return { List: value.map(v => field.elementType ? wireValue(v, field.elementType) :
    wireValue(v, { ...field, dataType: 'Record' })) };
  return value;
}

export function prepareOdcNativeContext(context, { screenModel, blockModel, dataTypes, converter } = {}) {
  if (context === undefined) return { receipt: {}, apply() {} };
  if (!plain(context) || Object.keys(context).some(k => !['screen', 'block'].includes(k))) fail('context_shape_invalid');
  const assignments = [], receipt = {};
  for (const owner of ['screen', 'block']) {
    if (!own(context, owner)) continue;
    const value = context[owner], model = owner === 'screen' ? screenModel : blockModel;
    if (!model) fail('context_owner_unavailable');
    if (!plain(value) || Object.keys(value).some(k => !['inputs', 'variables'].includes(k))) fail('context_shape_invalid');
    const attributes = model.variables?.getAttributes?.() ?? [], inputBindings = nativeInputBindingDetails(model), inputs = {}, variables = [];
    receipt[owner] = { inputs: [], variables: [] };
    for (const kind of ['inputs', 'variables']) {
      const supplied = value[kind] ?? {};
      if (!plain(supplied) || Object.keys(supplied).length > 200) fail('context_shape_invalid');
      for (const [name, raw] of Object.entries(supplied)) {
        if (/password|credential|authorization|cookie|token|secret|^__proto__$|^prototype$|^constructor$/i.test(name)) fail('context_private_name');
        const matches = attributes.filter(a => a.name === name && (kind === 'inputs' ? inputBindings.has(a.attrName) : /Var$/.test(a.attrName)));
        if (matches.length !== 1) fail('context_attribute_unresolved');
        const attribute = matches[0], field = nativeType(attribute, dataTypes);
        const canonical = canonicalizeValue(raw, field), wire = wireValue(canonical, field);
        const converted = converter.from(wire, attribute.complexType ?? attribute.dataType);
        if (kind === 'inputs') {
          const binding = inputBindings.get(attribute.attrName);
          inputs[binding.name] = binding.format === 'native' ? converted : wire;
        }
        else variables.push({ attribute: attribute.attrName, value: converted });
        receipt[owner][kind].push(name);
      }
    }
    assignments.push({ model, inputs, variables });
  }
  return { receipt, apply() {
    for (const assignment of assignments) {
      if (Object.keys(assignment.inputs).length) assignment.model.setInputs(assignment.inputs);
      for (const item of assignment.variables) assignment.model.variables[item.attribute] = item.value;
    }
  } };
}
