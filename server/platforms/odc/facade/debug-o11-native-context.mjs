// Typed owner state for original screen/block actions. No view is rendered and no data action is prefetched.
import { canonicalValue, o11SensitiveName } from './debug-o11-native-abi.mjs';

const fail = code => { throw new Error('debug_o11_native_' + code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export function canonicalO11Context(owners, value) {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some(k => !['screen', 'block'].includes(k))) fail('context_invalid');
  const result = {};
  for (const [owner, groups] of Object.entries(value)) {
    if (!owners?.[owner] || !object(groups) || Object.keys(groups).some(k => !['inputs', 'variables'].includes(k))) fail('context_owner_unavailable');
    result[owner] = {};
    for (const [group, values] of Object.entries(groups)) {
      if (!object(values)) fail('context_invalid');
      result[owner][group] = {};
      for (const [name, input] of Object.entries(values)) {
        if (o11SensitiveName(name)) fail('context_private_value');
        const definitions = owners[owner][group]?.filter(v => v.name === name) ?? [];
        if (definitions.length !== 1) fail('context_attribute_unavailable');
        result[owner][group][name] = canonicalValue({ base: definitions[0].dataType }, input, owner + '.' + group + '.' + name);
      }
    }
  }
  return result;
}

// Prepare all conversions before applying any assignment. setInputs remains the generated method, so its
// native input conversion/status handling is preserved; variables use the original record's typed setters.
export function applyO11Context({ owners, models, value, convert }) {
  const validated = canonicalO11Context(owners, value);
  if (!validated) return undefined;
  const changes = [], receipt = {};
  for (const [owner, groups] of Object.entries(validated)) {
    const model = models[owner];
    if (!model?.variables || typeof model.setInputs !== 'function') fail('context_owner_unavailable');
    const inputs = {}, variables = {};
    receipt[owner] = {};
    for (const [group, values] of Object.entries(groups)) {
      receipt[owner][group] = Object.keys(values);
      for (const [name, wire] of Object.entries(values)) {
        const spec = owners[owner][group].find(v => v.name === name);
        const native = convert(model, spec, wire);
        if (group === 'inputs') inputs[name] = spec.wireInput ? wire : native;
        else variables[spec.attribute] = native;
      }
    }
    changes.push({ model, inputs, variables });
  }
  for (const change of changes) {
    if (Object.keys(change.inputs).length) change.model.setInputs(change.inputs);
    for (const [attribute, native] of Object.entries(change.variables)) change.model.variables[attribute] = native;
  }
  return receipt;
}

export async function invokeO11Lifecycle(controller, lifecycle, timeoutSeconds) {
  if (!lifecycle || !/^On(?:Initialize|Ready|Render|Destroy|ParametersChanged)$/.test(lifecycle.event) ||
      lifecycle.handler !== lifecycle.event.replace(/^On/, 'on') + 'EventHandler' ||
      typeof controller?.[lifecycle.handler] !== 'function' || typeof controller.fireEvent !== 'function') fail('lifecycle_handler_unavailable');
  const original = controller[lifecycle.handler];
  await controller.fireEvent(function (context) {
    return original.call(this, context?.withTimeout ? context.withTimeout(timeoutSeconds) : context);
  }, lifecycle.event);
  return undefined; // Native lifecycle events have no output parameters.
}

// Observe promises returned by the ORIGINAL native proxies. A JS node can deliberately omit `return`;
// that must not make the debugger finish while its server request is still running. The same promise is
// returned to native callers and no action is invoked by this observer.
export function trackO11ClientProxies(controller, pending, onFailure) {
  const proxies = controller?.clientActionProxies;
  if (!proxies || typeof proxies !== 'object') return;
  for (const [name, original] of Object.entries(proxies)) {
    if (typeof original !== 'function') continue;
    proxies[name] = function (...args) {
      const value = original.apply(this, args);
      if (value && typeof value.then === 'function') {
        const completion = Promise.resolve(value).then(() => {}, error => { onFailure?.(error); });
        pending.add(completion); completion.finally(() => pending.delete(completion));
      }
      return value;
    };
  }
}

export async function settleO11ClientProxies(pending) {
  while (pending.size) await Promise.all([...pending]);
}
