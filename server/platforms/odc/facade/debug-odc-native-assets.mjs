// Published, same-origin assets only. A run never substitutes a local model for
// the deployed revision and never changes the bodies of generated actions.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { indexRuntime, endpointOwner, isOdcClientCallable } from './debug-odc-native-runtime.mjs';
import { odcNativeEndpoints } from './debug-odc-native-transport.mjs';

const fail = code => { throw new Error('debug_odc_native_' + code); };
export const assetHash = bytes => createHash('sha256').update(bytes).digest('hex');
export function nativeOdcEntryKind(index, key, modelPath = '') {
  const rows = (index.functions[key] ?? []).filter(r => r.holder);
  if (rows.some(r => r.call?.kind === 'server-action')) return 'server-stub';
  if (rows.some(r => r.call?.kind === 'data-action')) return /(?:Mobile|Web)Block:/.test(modelPath) ? 'block-data-action' : 'screen-data-action';
  if (rows.some(isOdcClientCallable)) return 'client-action';
  return null;
}
export async function acquireOdcNativeAssets(binding, directory, { fetchImpl = fetch } = {}) {
  const endpoints = odcNativeEndpoints(binding), files = {}, pins = {}, queue = [], urls = new Map();
  let total = 0;
  fs.mkdirSync(directory, { recursive: true });
  async function get(url, name) {
    let response;
    try { response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(60000) }); }
    catch { fail('asset_unavailable:' + name); }
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url.href)) fail('asset_read_failed');
    const bytes = Buffer.from(await response.arrayBuffer()); total += bytes.length;
    if (bytes.length > 8 * 1024 * 1024 || total > 100 * 1024 * 1024) fail('asset_size_limit');
    const file = path.join(directory, name); fs.writeFileSync(file, bytes, { flag: 'wx' });
    pins[name] = { path: file, sha256: assetHash(bytes), url: url.href };
    return bytes.toString('utf8');
  }
  const html = await get(new URL(endpoints.appUrl), 'index.html');
  const version = JSON.parse(await get(new URL(endpoints.origin + endpoints.versionInfo + '?' + Date.now()), 'moduleversioninfo.json'));
  if (typeof version.versionToken !== 'string' || !/^[A-Za-z0-9_+]{1,150}$/.test(version.versionToken)) fail('version_unresolved');
  const manifest = JSON.parse(await get(new URL(endpoints.origin + endpoints.moduleInfo + '?' + version.versionToken), 'moduleinfo.json'));
  if (manifest.manifest?.versionToken !== version.versionToken) fail('publication_changed');
  function enqueue(specifier, base = endpoints.appUrl) {
    const url = new URL(specifier, base), name = path.posix.basename(url.pathname);
    if (url.origin !== endpoints.origin || url.username || url.password || url.hash ||
        !url.pathname.startsWith(endpoints.base + 'scripts/') || !/^_os(?:chunk-[A-Za-z0-9]+|bundle-[A-Za-z0-9_.]+__[A-Za-z0-9_+]+)\.js$/.test(name)) fail('asset_scope_invalid');
    if (urls.has(name) && urls.get(name) !== url.href) fail('asset_ambiguous');
    if (!urls.has(name)) { urls.set(name, url.href); queue.push(url); }
    if (urls.size > 512) fail('asset_graph_limit');
  }
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].filter(m => /\btype=["']module["']/.test(m[1]));
  if (scripts.length !== 1) fail('bootstrap_missing');
  const src = /\bsrc=["']([^"']+)["']/.exec(scripts[0][1])?.[1]; if (!src) fail('bootstrap_missing'); enqueue(src);
  function imports(node, base) {
    if (!node || typeof node !== 'object') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) && node.source?.value) enqueue(node.source.value, base);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(v => imports(v, base)); else if (value && typeof value === 'object') imports(value, base);
  }
  for (let i = 0; i < queue.length; i++) {
    const url = queue[i], name = path.posix.basename(url.pathname), source = await get(url, name);
    files[name] = source; imports(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), url.href);
  }
  return { index: indexRuntime(files), pins, moduleVersion: version.versionToken, manifestSha256: pins['moduleinfo.json'].sha256,
    runtimeUrl: endpoints.appUrl, revision: binding.revision };
}

// Bind a generated callable to the graph decision by model keys, then to its
// original controller/owner. Ordering is fixed; ambiguous owners are refused.
export function resolveOdcRuntimeEntry(prepared, runtime) {
  const ix = runtime.index, pathKeys = prepared.path.map(p => p.key);
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const eligible = (ix.functions[prepared.entry.key] ?? []).filter(r => r.holder && !r.nativeProxy && (r.call || isOdcClientCallable(r)));
  const member = eligible.sort((a, b) => compare(a.ownerKey ?? '', b.ownerKey ?? '') || compare(a.chunk, b.chunk) || compare(a.holder.name, b.holder.name))[0];
  if (!member) fail('entry_not_executable:' + prepared.entry.entryKind);
  const owner = endpointOwner(member.call?.endpoint), views = Object.values(ix.views ?? {}).flat();
  const ownViews = views.filter(v => v.chunk === member.chunk && v.controllerFactory === member.controllerFactory);
  if (member.controllerFactory && ownViews.length !== 1) fail('entry_owner_ambiguous');
  const view = ownViews[0] ?? null;
  let screen = view && Object.hasOwn(ix.screens, view.displayName) ? view : null;
  if (view && !screen) {
    function containsBlock(candidate, target, seen = new Set()) {
      if (seen.has(candidate.key)) return false; seen.add(candidate.key);
      for (const key of candidate.blockKeys ?? []) {
        if (key === target) return true;
        for (const child of views.filter(v => v.key === key)) if (containsBlock(child, target, seen)) return true;
      }
      return false;
    }
    const candidates = views.filter(v => Object.hasOwn(ix.screens, v.displayName) && containsBlock(v, view.key));
    // Older saved indexes have no composition map. Keep their existing strict
    // single-screen rule; fresh captures always use the original getBlocks graph.
    if (!candidates.length && views.every(v => v.blockKeys === undefined)) candidates.push(...views.filter(v => Object.hasOwn(ix.screens, v.displayName) && v.chunk === member.chunk));
    candidates.sort((a, b) => compare(a.key, b.key) || compare(a.chunk, b.chunk));
    if (!candidates.length) fail('block_parent_unresolved');
    if (views.every(v => v.blockKeys === undefined) && candidates.length !== 1) fail('block_parent_unresolved');
    screen = candidates[0];
  }
  const inputs = member.call?.kind === 'server-action' ? member.call.inputs.map(i => ({ name: i.wire, dataType: i.dataType, position: i.position })) :
    (ix.groups[member.varsGroup]?.find(g => g.chunk === member.chunk)?.attributes ?? []).filter(a => /InLocal$/.test(a.attrName)).map((a, position) => ({ ...a, position }));
  if (inputs.some(i => i.position < 0) || new Set(inputs.map(i => i.position)).size !== inputs.length) fail('input_position_unresolved');
  const outputs = member.outputs ?? ix.groups[member.outVarsGroup]?.find(g => g.chunk === member.chunk)?.attributes ?? [];
  const lifecycleHandlers = member.lifecycleHandler ?? [];
  if (member.lifecycleBindings?.some(b => !b.binding)) fail('lifecycle_binding_unqualified');
  if (member.lifecycleBindings?.some(b => b.binding?.kind === 'native-cached-event' && !b.helper)) fail('lifecycle_helper_unqualified');
  if (lifecycleHandlers.length > 1) fail('lifecycle_handler_ambiguous');
  if (lifecycleHandlers.length && inputs.length) fail('lifecycle_inputs_not_controllable');
  const endpoints = {};
  for (const key of prepared.runtimeRequestKeys ?? [member.key]) for (const fn of ix.functions[key] ?? []) if (fn.call) {
    const previous = endpoints[fn.call.endpoint];
    if (previous && previous !== fn.call.apiVersion) fail('endpoint_version_ambiguous');
    endpoints[fn.call.endpoint] = fn.call.apiVersion;
  }
  return { member, view, screen, owner, inputs, outputs,
    lifecycle: lifecycleHandlers.length ? { handler: lifecycleHandlers[0], mounted: false, scope: 'individual-event' } : null,
    endpoints,
    invocation: member.call?.kind ?? (lifecycleHandlers.length ? 'lifecycle-event' : member.type === 'CLIENT_SCREEN_ACTION' ? 'screen-action' : 'client-action'), targetReachedBy: pathKeys.slice(pathKeys.indexOf(member.key)) };
}

export function readOdcRuntimeSources(runtime) {
  const files = {};
  for (const [name, pin] of Object.entries(runtime.pins)) {
    const bytes = fs.readFileSync(pin.path); if (assetHash(bytes) !== pin.sha256) fail('source_changed');
    files[name] = bytes.toString('utf8');
  }
  return files;
}
