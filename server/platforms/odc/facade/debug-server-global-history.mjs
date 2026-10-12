// Cross-stop change flags for server session/site/setting values, mirroring
// the client nativeHistory. Locals are never compared across stops: recursion
// cannot be excluded on the server. Only a complete public value is
// fingerprinted (sha256 of type plus described value); a redacted value keeps
// only the native within-stop `changed` flag and never updates the history.
// A native request fingerprint, when present, also separates requests that
// reuse a pool thread; threadEnded() forgets a thread at its ThreadEnd.
import { createHash } from 'node:crypto';
const globalCategories = new Set(['session', 'site', 'setting']);
const none = { previousStop: null, changedSincePreviousStop: null };
const binding = c => c && typeof c.threadId === 'string' && /^\d+$/.test(c.eventId ?? '') && Number.isInteger(c.generation)
  ? { threadId: c.threadId, eventId: c.eventId, generation: c.generation, request: c.correlation?.nativeRequestIdSha256 ?? null } : null;
const sameBinding = (a, b) => a.threadId === b.threadId && a.eventId === b.eventId && a.generation === b.generation;
export function createServerGlobalHistory() {
  const history = new Map(), identities = new Map(), roots = new Map();
  // References are valid only for one stop and generation of their thread.
  const prune = (threadId, keep) => {
    for (const map of [identities, roots]) for (const [k, v] of map) if (v.threadId === threadId && !(keep && sameBinding(v, keep))) map.delete(k);
  };
  function learnScope(scope) {
    const b = binding(scope?.context);
    if (scope?.ok !== true || !b || !Array.isArray(scope.variables)) return scope;
    prune(b.threadId, b);
    for (const v of scope.variables) if (typeof v?.reference === 'string' && typeof v.category === 'string')
      identities.set(v.reference, { ...b, category: v.category, moduleKey: v.moduleKey ?? null, variableKey: v.variableKey ?? null });
    return scope;
  }
  function identityOf(reference, value, b) {
    const known = identities.get(reference);
    if (known) return sameBinding(known, b) ? known : null;
    // An expanded child path belongs to the root whose path prefixes it.
    if (typeof value?.path !== 'string' || typeof value.category !== 'string') return null;
    for (const root of roots.values()) if (sameBinding(root, b) && root.category === value.category && value.path.startsWith(root.path + '.')) return { ...root, child: true };
    return null;
  }
  function flags(value, identity, b) {
    if (value?.redacted === true || value?.valueComplete !== true || typeof value.path !== 'string') return none;
    const key = JSON.stringify([b.threadId, b.request, identity.category, identity.moduleKey, identity.variableKey, value.path]);
    const hash = createHash('sha256').update(JSON.stringify([value.type, value.value])).digest('hex');
    const old = history.get(key);
    const entry = !old ? { stop: b.eventId, hash, prior: null }
      : old.stop !== b.eventId ? { stop: b.eventId, hash, prior: { stop: old.stop, hash: old.hash } } : { ...old, hash };
    history.set(key, entry);
    return { previousStop: entry.prior?.stop ?? null, changedSincePreviousStop: entry.prior ? entry.prior.hash !== hash : null };
  }
  function one(result, outer) {
    const b = binding(result?.context ?? outer);
    if (result?.ok === false || !b || typeof result?.reference !== 'string') return result;
    const value = result.value, identity = identityOf(result.reference, value, b);
    if (!identity) return globalCategories.has(value?.category) ? { ...result, ...none } : result;
    if (!globalCategories.has(identity.category)) return result;
    if (!identity.child && typeof value?.path === 'string')
      roots.set(JSON.stringify([b.threadId, identity.category, value.path]), { ...identity, path: value.path });
    const children = Array.isArray(result.children) ? result.children.map(child => {
      if (typeof child?.reference !== 'string') return child;
      if (!identities.has(child.reference)) identities.set(child.reference, { ...identity, path: undefined, child: true });
      return { ...child, ...flags(child, identity, b) };
    }) : result.children;
    return { ...result, ...flags(value, identity, b), ...(children ? { children } : {}) };
  }
  return {
    learnScope,
    annotate(result) {
      if (!result || typeof result !== 'object' || result.ok === false) return result;
      return Array.isArray(result.values) ? { ...result, values: result.values.map(v => one(v, result.context)) } : one(result);
    },
    threadEnded(threadId) {
      for (const k of history.keys()) if (JSON.parse(k)[0] === threadId) history.delete(k);
      prune(threadId);
    },
    inspect: () => ({ entries: history.size, references: identities.size }),
  };
}
