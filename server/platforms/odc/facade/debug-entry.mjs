// Deterministic entry resolution: walk the callers of an action up to the points where execution starts (screens and
// their data/screen actions, timers, exposed REST methods, service actions, events). Each entry says whether it needs
// a user (screen roles / anonymous access, REST authentication) — the default user context of a debug comes from here,
// and only an entry that needs no user can be called directly instead of through the SSAMDebug wrapper.

const ENTRY = [
  [/^(MobileScreen|WebScreen)$/, 'screen'],
  [/^Timer$/, 'timer'],
  [/^RestService(Action)?$/, 'rest'],
  [/^SoapService(Action)?$/, 'soap'],
  [/^ServiceAction$/, 'service-action'],
  [/^(Process|ProcessFlow|ProcessActivity|AutomaticActivity)$/, 'process'],
  [/LifeCycle\w*Event$|^Event$|^EventHandler$/, 'event'],
];
const kindOf = segment => segment.split(':')[0];

// Container of a calling node: the path up to the flow that holds it (screen action, data action, server action...).
export function container(consumerPath) {
  const parts = consumerPath.split('/');
  return { path: parts.slice(0, -1).join('/'), kind: kindOf(parts.at(-2) ?? ''), parts: parts.slice(0, -1) };
}

// What the container makes of the call: another action to climb, or an entry (with the screen/service it belongs to).
export function classify(containerInfo) {
  const kinds = containerInfo.parts.map(kindOf);
  const screenAt = kinds.findIndex(k => /^(MobileScreen|WebScreen)$/.test(k));
  if (screenAt >= 0) return { entry: 'screen', screenPath: containerInfo.parts.slice(0, screenAt + 1).join('/'), via: containerInfo.parts.slice(screenAt + 1).join('/') };
  const restAt = kinds.findIndex(k => /^RestService$/.test(k));
  if (restAt >= 0) return { entry: 'rest', servicePath: containerInfo.parts.slice(0, restAt + 1).join('/'), via: containerInfo.parts.slice(restAt + 1).join('/') };
  const last = containerInfo.kind;
  for (const [pattern, entry] of ENTRY) if (pattern.test(last)) return { entry, via: containerInfo.path };
  if (/^(ServerAction|ClientAction)$/.test(last)) return { climb: containerInfo.path };
  return { entry: 'other', kind: last, via: containerInfo.path };
}

// BFS over usages. read(target, path, options) is the lane reader (inspect); usages(key) returns consumer paths.
export async function entryChain({ targetKey, targetPath, usages, properties, maxDepth = 6, maxNodes = 60 }) {
  const entries = [], seen = new Set([targetKey]), chains = [];
  let frontier = [{ key: targetKey, path: targetPath, chain: [targetPath] }];
  for (let depth = 1; depth <= maxDepth && frontier.length && seen.size < maxNodes; depth++) {
    const next = [];
    for (const item of frontier) {
      const consumers = await usages(item.key);
      if (!consumers.length) chains.push({ chain: item.chain, entry: null, note: 'no caller in this module' });
      for (const c of consumers) {
        const holder = container(c.path), info = classify(holder);
        if (info.climb) {
          const parent = await properties(info.climb);
          if (!parent?.key || seen.has(parent.key)) continue;
          seen.add(parent.key);
          next.push({ key: parent.key, path: info.climb, chain: [...item.chain, info.climb], public: parent.public });
          // A public action is reachable from other modules: it is an entry for this module's view.
          if (parent.public) entries.push({ entry: 'public-action', path: info.climb, depth, chain: [...item.chain, info.climb], needsUser: 'caller' });
          continue;
        }
        const entry = { ...info, depth, chain: [...item.chain, holder.path] };
        if (info.entry === 'screen') {
          const screen = await properties(info.screenPath);
          entry.roles = parseRoles(screen?.properties?.Roles);
          entry.anonymous = screen?.properties?.AnonymousAccess === 'True';
          entry.needsUser = !entry.anonymous;
        } else if (info.entry === 'rest') {
          const service = await properties(info.servicePath);
          entry.authentication = service?.properties?.Authentication ?? null;
          entry.needsUser = !(entry.authentication == null || /^none$/i.test(entry.authentication));
        } else entry.needsUser = info.entry === 'timer' ? false : info.entry === 'service-action' ? 'caller' : null;
        entries.push(entry);
      }
    }
    frontier = next;
  }
  entries.sort((a, b) => a.depth - b.depth);
  return { entries, nearest: entries[0] ?? null, unresolved: chains };
}

// "[AppRole:Quotes, AppRole:Administrator]" -> ['Quotes', 'Administrator']
export function parseRoles(text) {
  if (!text || typeof text !== 'string') return [];
  return [...text.matchAll(/(?:AppRole|Role):([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
}
