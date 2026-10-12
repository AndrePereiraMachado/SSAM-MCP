// Port D7: a debugger test file whose module needs an SC/Portal file the consolidation does not have yet imports that
// module through foreignImport(). While the file is pending, every export is a stand-in that throws a marked error on
// use, and gatedTest() turns exactly the tests that reach one into a skip named after the pending file; the other tests
// of the file keep running. When the file arrives, the real module loads and nothing is skipped (no change here).
import nodeTest from 'node:test';
import { foreignPendingReason } from '../../debug-foreign-pending.mjs';

const PENDING = Symbol('foreign-pending');
const pendingError = reason => Object.assign(new Error(reason), { [PENDING]: reason });
// A stand-in export: any call, construction, property read or iteration throws the marked error.
function standIn(reason, name) {
  const fail = () => { throw pendingError(reason + ' (' + name + ')'); };
  return new Proxy(function pendingExport() {}, { apply: fail, construct: fail,
    get: (_target, key) => (key === 'then' || typeof key === 'symbol' && key !== Symbol.iterator && key !== Symbol.asyncIterator ? undefined : fail()) });
}
// The module itself while pending: destructuring yields stand-ins.
const pendingModule = reason => new Proxy({}, { get: (_target, key) => (typeof key === 'symbol' || key === 'then' ? undefined : standIn(reason, String(key))) });

export async function foreignImport(specifier, base, ...keys) {
  const reason = foreignPendingReason(...keys);
  return reason ? pendingModule(reason) : import(new URL(specifier, base).href);
}
const pendingOf = error => error?.[PENDING] ?? error?.actual?.[PENDING] ?? error?.cause?.[PENDING] ?? null;
// node:test's test(), with the stand-in error of a pending file turned into a named skip. skipAll (a pending reason)
// skips every test of a file whose subject runs through the pending file as a whole (the real dispatcher loads it).
export function gatedTest(test = nodeTest, skipAll = false) {
  const wrap = fn => (typeof fn !== 'function' ? fn : async function gated(t, ...rest) {
    try { return await fn.call(this, t, ...rest); } catch (error) { const reason = pendingOf(error); if (!reason) throw error; t.skip(reason); }
  });
  const run = (name, options, fn) => (typeof options === 'function' ? test(name, wrap(options)) : test(name, options, wrap(fn)));
  return Object.assign(skipAll ? (name, options, fn) => (typeof options === 'function' ? test(name, { skip: skipAll }, options) : test(name, { ...options, skip: skipAll }, fn)) : run, test);
}
