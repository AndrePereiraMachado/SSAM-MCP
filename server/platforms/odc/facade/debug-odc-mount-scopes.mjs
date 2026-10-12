// scopesFrom:'mount-lifecycle' for a mounted ODC client session. After prepare,
// every declared (non-absent) screen and block handler root of the mount plan
// gets breakpoints on its Start and End nodes, read from the published model
// and confirmed by the installed Model API scope reader. No caller-supplied node.
const fail = code => { throw new Error('debug_odc_mount_scopes_' + code); };
const KEY = /^[A-Za-z0-9_+]{22}$/;
// Explicit caps of the derived mode only; explicit scopes keep 20 functions / 200 nodes.
export const mountLifecycleLimits = Object.freeze({ functions: 40, nodesPerFunction: 20, nodes: 400 });

// Schema rule for clientSessionSchema (start): issues, empty when valid.
export function mountLifecycleScopesIssues({ run, scopes, scopesFrom } = {}) {
  if (scopesFrom === undefined) return [];
  const issues = [];
  if (scopesFrom !== 'mount-lifecycle') issues.push('scopesFrom must be mount-lifecycle');
  if (scopes !== undefined) issues.push('scopes and scopesFrom are exclusive');
  if (run?.lifecycle !== 'mounted') issues.push('scopesFrom mount-lifecycle requires run.lifecycle mounted');
  return issues;
}

// Default model reader: the same kernel inspect the run uses, pinned by hash.
export function odcModelTreeReader(source) {
  return async modelPath => {
    const { inspect } = await import('./lib.mjs');
    const r = await inspect({ target: source.path, path: modelPath, depth: 3, max: 500, budget: 1000000, full: true, expectedSourceSha256: source.sha256 });
    if (!r.ok) return null;
    return r.tree ?? (r.out ? JSON.parse((await import('node:fs')).readFileSync(r.out, 'utf8')).tree : null);
  };
}

export async function expandMountLifecycleScopes(prepared, readScopes, { readTree, moduleKey, directory, limits = mountLifecycleLimits } = {}) {
  const mounted = prepared?.mount?.views;
  // Isolated runs have no mount plan: nothing to derive.
  if (!Array.isArray(mounted) || !mounted.length) fail('mount_required');
  // The navigation target's views (its OnInitialize, the OnDestroy fired by navigateBack) join the mounted ones.
  const views = [...mounted, ...(prepared?.mount?.navigation?.views ?? []).filter(v => !mounted.some(m => m.key === v.key))];
  const source = prepared.sourceContract;
  if (typeof source?.path !== 'string' || !/^[a-f0-9]{64}$/i.test(source.sha256 ?? '')) fail('source_required');
  if (!KEY.test(moduleKey ?? '') || typeof directory !== 'string' || !directory) fail('binding_required');
  const roots = [], seen = new Set();
  for (const view of views) for (const h of view.handlers ?? []) {
    if (!KEY.test(h?.actionKey ?? '') || typeof h.handler !== 'string') fail('mount_plan_invalid');
    if (seen.has(h.actionKey)) continue; seen.add(h.actionKey);
    roots.push({ viewKey: view.key, handler: h.handler, actionKey: h.actionKey });
  }
  if (!roots.length) fail('mount_plan_invalid');
  // Refuse, never truncate: a silently shortened list would hide handlers.
  if (roots.length > limits.functions) fail('cap_exceeded');
  readTree ??= odcModelTreeReader(source);
  readScopes ??= (await import('./debug-native-scope-reader.mjs')).readNativeInspectionScopes;
  const scopes = [];
  for (const root of roots) {
    const tree = await readTree('@' + root.actionKey), nodes = Array.isArray(tree?.children) ? tree.children : [];
    const enabled = n => KEY.test(n?.key ?? '') && n.properties?.IsDisabled !== 'True';
    const starts = nodes.filter(n => n?.kind === 'StartNode'), ends = nodes.filter(n => n?.kind === 'EndNode' && enabled(n));
    if (tree?.key !== root.actionKey || starts.length !== 1 || !enabled(starts[0]) || !ends.length) fail('flow_unresolved');
    const nodeKeys = [starts[0].key, ...ends.map(n => n.key)];
    if (nodeKeys.length > limits.nodesPerFunction) fail('cap_exceeded');
    Object.assign(root, { startNodeKey: starts[0].key, endNodeKeys: ends.map(n => n.key) });
    scopes.push({ functionKey: root.actionKey, nodeKeys });
  }
  const breakpoints = scopes.flatMap(s => s.nodeKeys.map(n => moduleKey + ':' + n));
  if (breakpoints.length > limits.nodes || new Set(breakpoints).size !== breakpoints.length) fail('cap_exceeded');
  // The Model API confirms each node in its function at the published hash; the
  // session reuses this read instead of reading the same scopes again.
  const metadata = await readScopes({ lane: 'odc', runtime: 'client', source, moduleKey, scopes, directory });
  const hashed = new Set((metadata?.functionHashes ?? []).filter(h => h?.moduleKey === moduleKey).map(h => h.functionKey));
  if (JSON.stringify(metadata?.breakpoints) !== JSON.stringify(breakpoints) || scopes.some(s => !hashed.has(s.functionKey))) fail('scope_unconfirmed');
  return { scopesFrom: 'mount-lifecycle', scopes, roots, limits: { ...limits }, metadata };
}
