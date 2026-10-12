// Serialization of values already converted by the original SDK. No native
// types, records, expressions or return values are evaluated here.
export const NATIVE_OUTPUT_BYTES = 256 * 1024;
export function nativeWireOutput(value, privateValues = [], { unwrapLists = true } = {}) {
  const secrets = privateValues.filter(v => typeof v === 'string' && v.length);
  const omitted = reason => ({ omitted: true, reason, nativeInspectionRequired: true });
  function visit(value, depth) {
    if (depth > 64) throw new Error('depth_budget');
    if (value == null) return null;
    if (typeof value === 'string') {
      for (const secret of secrets) value = value.split(secret).join('[private]');
      return value;
    }
    if (typeof value !== 'object') return value;
    if (unwrapLists && Array.isArray(value.List)) return value.List.map(item => visit(item, depth + 1));
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    return Object.fromEntries(Object.entries(value)
      .filter(([name]) => (!unwrapLists || name !== 'EmptyListItem') && !secrets.some(secret => name.includes(secret)))
      .map(([name, item]) => [name, /password|token|secret|cookie|credential|authorization|username/i.test(name)
        ? '[private]' : visit(item, depth + 1)]));
  }
  let result;
  try { result = visit(value, 0); }
  catch { return omitted('depth_budget'); }
  return Buffer.byteLength(JSON.stringify(result)) > NATIVE_OUTPUT_BYTES ? omitted('transport_budget') : result;
}
