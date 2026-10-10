// studio_open target: the bridge reads `open <module> [<local .oml>]` and splits at the first space, so an asset name
// with a space ("Escala Viva") would open "Escala" from the local path "Viva". A name with whitespace is resolved to its
// asset key through the catalog (snapshots/modules.json, every tenant listed) and the key goes to the bridge; a name
// the catalog does not resolve to exactly one key never reaches the bridge. Pure but for readCatalog.
import { paths, readJson } from './lib.mjs';

const catalogModules = catalog => [
  ...(catalog?.modules ?? []),
  ...(Array.isArray(catalog?.otherTenants) ? catalog.otherTenants : Object.values(catalog?.otherTenants ?? {}))
    .flatMap(t => t?.modules ?? []),
].filter(m => m && typeof m.name === 'string' && typeof m.key === 'string');

const keysOf = list => [...new Set(list.map(m => m.key))];

export function resolveOpenTarget(module, catalog) {
  if (!/\s/.test(module)) return { ok: true, target: module };
  const name = module.trim();
  const all = catalogModules(catalog);
  let keys = keysOf(all.filter(m => m.name === name));
  if (keys.length === 0) keys = keysOf(all.filter(m => m.name.toLowerCase() === name.toLowerCase()));
  if (keys.length === 1) return { ok: true, target: keys[0], resolvedFrom: name };
  return {
    ok: false, outcome: 'not_sent', gate: keys.length ? 'ambiguous_module' : 'unknown_module',
    error: keys.length
      ? `Asset name "${name}" matches ${keys.length} keys in the catalog (${keys.join(', ')}); open by key.`
      : `Asset name "${name}" has a space and is not in the catalog; a name with a space is opened by its asset key. Nothing was sent to the Studio.`,
    continuation: keys.length
      ? { tool: 'studio_open', arguments: { module: keys[0] }, why: 'Choose the key of the intended asset.' }
      : { tool: 'studio_assets', arguments: {}, why: 'Refresh the catalog from the native listing, then repeat studio_open.' },
  };
}

export function readCatalog(file = paths.catalog) {
  try { return readJson(file); } catch { return null; }
}
