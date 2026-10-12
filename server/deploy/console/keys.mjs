// Plain objects used as maps keyed by data the console does not control: tool names and error codes of the audit lines,
// close reasons and agent codes of server.log. A key such as "__proto__", "constructor" or "toString" names a member
// that every plain object inherits, so `map[key] ??= {}` returns Object.prototype (or a function) and the next write
// changes it for the whole process. These helpers read own properties only and create them with defineProperty, so they
// behave the same on fresh objects and on objects parsed back from the day files and the checkpoint (JSON.parse keeps
// "__proto__" as an own property, and JSON.stringify writes it back).
export const own = (obj, key) => (obj != null && Object.hasOwn(obj, key) ? obj[key] : undefined);
export function put(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });
  return value;
}
// The entry of `key`, created with make() when missing.
export const slot = (obj, key, make) => (Object.hasOwn(obj, key) ? obj[key] : put(obj, key, make()));
// Adds n to a counter entry.
export const inc = (obj, key, n = 1) => put(obj, key, (Number(own(obj, key)) || 0) + n);
// A constant table (reason words, state words) looked up by a data key: only its own entries count.
export const pick = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined);
