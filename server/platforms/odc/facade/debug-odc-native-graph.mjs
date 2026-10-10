// Build the static call graph of a published ODC model for the deterministic entry resolver.
// It wraps the lane reader (the same `usages` + `properties` projections used by ssam_map / inspect) behind the
// { node, inputs, callers } interface resolveEntry expects. Every caller is a real reference in the published model;
// no name is used. The graph is lazy and cached, so BFS reads only the slice of the model it needs.
//
// readers:
//   usages(key)        -> [{ consumer: { kind, key, path } }]   (direct callers of the element with this key)
//   properties(path)   -> { key, kind, public, properties }     (an element's own properties)
//   inputs(path)       -> [{ name, key, dataType }]              (ordered input parameters)
//   argumentsOf(nodePath) -> [{ parameterName, value }]         (arguments a call node passes), optional

const kindOf = segment => (segment ?? '').split(':')[0];
const CALL_NODE = /^Execute\w*ActionNode$/;

// From a call-node path, the innermost action/flow CONTAINER that holds it, and the owning screen/block if any.
// e.g. MobileFlow:MainFlow/MobileScreen:Location/ScreenAction:ConfirmProperty/ExecuteServerActionNode:GetProperty
//   -> container MobileFlow:MainFlow/MobileScreen:Location/ScreenAction:ConfirmProperty, owner the MobileScreen.
export function containerOf(nodePath) {
  const parts = (nodePath ?? '').split('/');
  const parentParts = parts.slice(0, -1);
  const screenAt = parentParts.map(kindOf).findIndex(k => /^(MobileScreen|WebScreen)$/.test(k));
  const blockAt = parentParts.map(kindOf).findIndex(k => /^(MobileBlock|WebBlock)$/.test(k));
  const ownerAt = screenAt >= 0 ? screenAt : blockAt;
  return {
    containerPath: parentParts.join('/'), containerKind: kindOf(parentParts.at(-1)),
    ownerPath: ownerAt >= 0 ? parentParts.slice(0, ownerAt + 1).join('/') : null,
    ownerKind: ownerAt >= 0 ? kindOf(parentParts[ownerAt]) : null,
  };
}

export function buildModelGraph({ usages, properties, inputs, argumentsOf } = {}) {
  if (typeof usages !== 'function' || typeof properties !== 'function') throw new Error('debug_odc_native_graph_readers_missing');
  const nodeCache = new Map(), inputCache = new Map(), callerCache = new Map();
  const propsByKey = new Map(); // key -> {path, props}

  const readProps = path => properties(path);
  function nodeByPath(path) {
    const props = readProps(path);
    if (!props?.key) return null;
    const kind = props.kind ?? kindOf(path);
    const owner = kind === 'DataAction' ? containerOfElement(path) : null;
    const node = { key: props.key, kind, name: props.properties?.Name ?? path.split('/').at(-1).split(':').slice(1).join(':') ?? null,
      path, public: props.public === true || props.properties?.Public === 'True',
      ownerKind: owner?.ownerKind ?? null, ownerKey: owner?.ownerKey ?? null,
      roles: parseRoles(props.properties?.Roles), anonymous: props.properties?.AnonymousAccess === 'True',
      authentication: props.properties?.Authentication ?? null };
    nodeCache.set(props.key, node); propsByKey.set(props.key, { path, props });
    return node;
  }
  // DataAction owner: the screen/block whose path prefixes the data action's path.
  function containerOfElement(path) {
    const parts = path.split('/'), ownerAt = parts.map(kindOf).findIndex(k => /^(MobileScreen|WebScreen|MobileBlock|WebBlock)$/.test(k));
    if (ownerAt < 0) return null;
    const ownerPath = parts.slice(0, ownerAt + 1).join('/'), props = readProps(ownerPath);
    return props?.key ? { ownerKind: kindOf(parts[ownerAt]), ownerKey: props.key, ownerPath } : null;
  }

  function node(key) {
    if (nodeCache.has(key)) return nodeCache.get(key);
    return null; // only known once discovered through a path (callers populate it)
  }

  function callers(calleeKey) {
    if (callerCache.has(calleeKey)) return callerCache.get(calleeKey);
    const list = [];
    for (const usage of usages(calleeKey) ?? []) {
      const consumer = usage.consumer; if (!consumer?.path) continue;
      if (!CALL_NODE.test(consumer.kind) && consumer.kind !== 'DataAction' && consumer.kind !== 'Timer') continue;
      const where = containerOf(consumer.path);
      const container = nodeByPath(where.containerPath);
      if (!container) continue;
      const edge = { path: consumer.path, kind: consumer.kind,
        arguments: typeof argumentsOf === 'function' ? (argumentsOf(consumer.path) ?? null) : null };
      list.push({ key: container.key, node: container, edge });
      // A screen/block member (screen action, event handler, aggregate) is reached through its OWNER screen/block,
      // which is the externally invocable entry. Add that ownership edge so BFS can reach the screen/block.
      if (where.ownerPath && where.ownerPath !== where.containerPath && !/^(MobileScreen|WebScreen|MobileBlock|WebBlock)$/.test(where.containerKind)) {
        const owner = nodeByPath(where.ownerPath);
        if (owner) callerCache.set(container.key, [{ key: owner.key, node: owner, edge: { path: where.containerPath, kind: 'OwnedBy', arguments: null } }]);
      }
    }
    callerCache.set(calleeKey, list);
    return list;
  }

  function actionInputs(key) {
    if (inputCache.has(key)) return inputCache.get(key);
    const path = propsByKey.get(key)?.path;
    const list = (typeof inputs === 'function' && path) ? (inputs(path) ?? []) : [];
    inputCache.set(key, list);
    return list;
  }

  // Seed the target node from its path so node(targetKey) is known before BFS.
  return { node, inputs: actionInputs, callers, seed: path => nodeByPath(path) };
}

// Live readers are async (Portal/reader), but the deterministic resolver is a pure synchronous function so its result
// never depends on timing. This prefetches the whole reachable caller graph of the target with the async readers,
// into plain maps, and returns a SYNCHRONOUS graph over them that resolveEntry/resolveOverride consume unchanged.
export async function materializeGraph({ usages, properties, inputs, argumentsOf }, targetPath, { maxDepth = 12, maxNodes = 4000 } = {}) {
  const nodesByKey = new Map(), nodesByPath = new Map(), inputsByKey = new Map(), callersByKey = new Map();
  const propsOf = async p => { if (nodesByPath.has(p)) return nodesByPath.get(p); const v = await properties(p); nodesByPath.set(p, v); return v; };
  async function elementAt(p) {
    const props = await propsOf(p); if (!props?.key) return null;
    const kind = props.kind ?? (p.split('/').at(-1).split(':')[0]);
    let ownerKind = null, ownerKey = null;
    if (kind === 'DataAction') {
      const parts = p.split('/'), oa = parts.map(s => s.split(':')[0]).findIndex(k => /^(MobileScreen|WebScreen|MobileBlock|WebBlock)$/.test(k));
      if (oa >= 0) { const op = await propsOf(parts.slice(0, oa + 1).join('/')); if (op?.key) { ownerKind = parts[oa].split(':')[0]; ownerKey = op.key; } }
    }
    const node = { key: props.key, kind, name: props.properties?.Name ?? p.split('/').at(-1).split(':').slice(1).join(':'), path: p,
      public: props.public === true || props.properties?.Public === 'True', ownerKind, ownerKey,
      roles: parseRoles(props.properties?.Roles), anonymous: props.properties?.AnonymousAccess === 'True', authentication: props.properties?.Authentication ?? null };
    nodesByKey.set(node.key, node);
    if (typeof inputs === 'function') inputsByKey.set(node.key, (await inputs(p)) ?? []);
    return node;
  }
  const target = await elementAt(targetPath);
  if (!target) throw new Error('debug_odc_native_target_unreadable');
  const seen = new Set([target.key]); let frontier = [target.key];
  for (let depth = 1; depth <= maxDepth && frontier.length && seen.size < maxNodes; depth++) {
    const next = [];
    for (const key of frontier) {
      const list = [];
      for (const usage of (await usages(key)) ?? []) {
        const consumer = usage.consumer; if (!consumer?.path) continue;
        if (!/^Execute\w*ActionNode$/.test(consumer.kind) && consumer.kind !== 'DataAction' && consumer.kind !== 'Timer') continue;
        const where = containerOf(consumer.path), container = await elementAt(where.containerPath);
        if (!container) continue;
        const edge = { path: consumer.path, kind: consumer.kind, arguments: typeof argumentsOf === 'function' ? ((await argumentsOf(consumer.path)) ?? null) : null };
        list.push({ key: container.key, node: container, edge });
        if (where.ownerPath && where.ownerPath !== where.containerPath && !/^(MobileScreen|WebScreen|MobileBlock|WebBlock)$/.test(where.containerKind)) {
          const owner = await elementAt(where.ownerPath);
          if (owner && !callersByKey.has(container.key)) callersByKey.set(container.key, [{ key: owner.key, node: owner, edge: { path: where.containerPath, kind: 'OwnedBy', arguments: null } }]);
        }
        if (!seen.has(container.key)) { seen.add(container.key); next.push(container.key); }
      }
      if (!callersByKey.has(key)) callersByKey.set(key, list);
    }
    frontier = next;
  }
  return { node: key => nodesByKey.get(key) ?? null, inputs: key => inputsByKey.get(key) ?? [],
    callers: key => callersByKey.get(key) ?? [], seed: () => target, target };
}

export function parseRoles(text) {
  if (!text || typeof text !== 'string') return [];
  return [...text.matchAll(/(?:AppRole|Role):([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
}
