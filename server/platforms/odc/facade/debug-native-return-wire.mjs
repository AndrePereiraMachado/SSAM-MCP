// Navigation over the original debugger's typed wire result, after redaction.
// The installed IDebuggerAPIHelper likewise builds child containers from these
// descriptors. This never evaluates expressions or reads runtime object bags.
const fail = code => { throw new Error('debug_native_client_' + code); };
export const returnCompound = value => value && ['Record', 'RecordList'].includes(value.type);
export function selectReturnWire(root, keys = []) {
  let value = root;
  for (const key of keys) {
    if (!returnCompound(value) || !value.value || !Object.hasOwn(value.value, key)) fail('return_child_unavailable');
    const child = Object.getOwnPropertyDescriptor(value.value, key);
    if (!child || !Object.hasOwn(child, 'value')) fail('return_child_unavailable');
    value = child.value;
  }
  if (!value || typeof value !== 'object' || typeof value.type !== 'string' || !Object.hasOwn(value, 'value')) fail('return_child_unavailable');
  return value;
}
export function returnPathKeys(path) {
  if (typeof path !== 'string' || path.length > 2048 || !/^(?:\.[A-Za-z_$][\w$ ]*|\[\d+\]){1,64}$/.test(path)) fail('path_invalid');
  return path.match(/\.[A-Za-z_$][\w$ ]*|\[\d+\]/g).map(part => part.startsWith('.') ? part.slice(1) : part);
}
export function returnChildren(value, offset = 0, limit = 150) {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 150) fail('page_invalid');
  if (!returnCompound(value) || !value.value || typeof value.value !== 'object') fail('return_children_unavailable');
  const keys = Object.keys(value.value);
  if (offset > keys.length) fail('page_invalid');
  const end = Math.min(keys.length, offset + limit);
  return { keys: keys.slice(offset, end), offset, total: keys.length, nextOffset: end < keys.length ? end : null };
}
export function returnTextSlice(value, offset = 0, limit = 8192) {
  if (returnCompound(value) || value?.type === 'BinaryData' || typeof value.value !== 'string') fail('return_text_unavailable');
  if (!Number.isInteger(offset) || offset < 0 || offset > value.value.length || !Number.isInteger(limit) || limit < 1 || limit > 65536) fail('page_invalid');
  const end = Math.min(value.value.length, offset + limit);
  return { value: { type: value.type, value: value.value.slice(offset, end) }, offset,
    total: value.value.length, nextOffset: end < value.value.length ? end : null, unit: 'utf16-code-unit' };
}
