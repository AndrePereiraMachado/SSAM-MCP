// The module a Studio tool names, resolved against the modules open in that Studio, so the name a person sees (the app
// name "QuizLive Web") reaches the open module (QuizLiveWeb) without a refusal and a second call. Rules, in this order;
// the first rule with exactly one open module wins, two or more are ambiguous and never chosen:
//   1. exact name or key of an open module;
//   2. the same name in another case;
//   3. (ODC) an asset name of the catalog (snapshots/modules.json) whose key is an open module: ODC asset key = module key.
//      A name the catalog knows is that asset and no other: when none of its keys is open, the answer is MODULE_NOT_OPEN
//      with studio_open of that asset, never an open module with a similar name;
//   4. only for a name the catalog does not know: the letters and digits of the name, case-insensitive ("QuizLive Web" and
//      "QuizLive_Web" -> quizliveweb), the way an ODC module name is derived from its app name and an O11 label differs
//      from its module name (spaces, underscores). Another catalog asset with the same letters and digits (a name other
//      than the open module's own) makes it ambiguous.
// Nothing matches: ODC refuses with the open modules (a module that is not open has no snapshot); O11 passes the name on,
// because o11_deliver opens a module of the environment by name and the kernel answers for a name that does not exist.
// Pure: the open modules and the catalog come from the caller.

export const compactName = name => String(name ?? '').normalize('NFD').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

// O11 system and platform modules (A29, 2026-10-06): never opened in a Studio tab. A read by name takes their published OML
// (module-map.mjs captureO11Module); o11_studio refuses to open them (SYSTEM_MODULE_NOT_OPENABLE). The canonical name for
// "Users", "OutSystems UI", "outsystems_ui", "(System)" and the like; null for any other module.
const SYSTEM_MODULES = new Map([['users', 'Users'], ['outsystemsui', 'OutSystemsUI'], ['system', 'System']]);
export const systemModuleName = name => SYSTEM_MODULES.get(compactName(name)) ?? null;

const catalogModules = catalog => [
  ...(catalog?.modules ?? []),
  ...(Array.isArray(catalog?.otherTenants) ? catalog.otherTenants : Object.values(catalog?.otherTenants ?? {})).flatMap(t => t?.modules ?? []),
].filter(m => m && typeof m.name === 'string' && typeof m.key === 'string');

const distinct = list => [...new Map(list.map(m => [m.key ?? m.name, m])).values()];

// The kind the catalog lists for an asset key ("app" | "library" | ...), or null when the catalog does not know the key
// (the bridge's Kind(AssetType): WebApplication/MobileApplication -> app, the library asset types -> library).
export function catalogKind(catalog, key) {
  if (typeof key !== 'string' || !key) return null;
  const kinds = [...new Set(catalogModules(catalog).filter(m => m.key === key).map(m => m.kind).filter(k => typeof k === 'string' && k))];
  return kinds.length === 1 ? kinds[0] : null;
}
// Ordinal order (code units), the same on every machine and locale.
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// open: [{name, key}] of the Studio; catalog: the parsed asset catalog (ODC) or null; lane: 'odc' | 'o11'.
// -> {ok:true, module, via, requested} | {ok:false, code, error, openModules, candidates?, continuation?}
export function resolveOpenModule(requested, { open = [], catalog = null, lane = 'odc' } = {}) {
  const name = String(requested ?? '').trim();
  const modules = (Array.isArray(open) ? open : []).filter(m => m && typeof m.name === 'string' && m.name);
  const names = [...new Set(modules.map(m => m.name))].sort(ordinal);
  const found = (via, list) => ({ ok: true, module: list[0].name, via, requested: name });
  const ambiguous = (list, assets = []) => {
    const candidates = [...new Set([...list.map(m => m.name), ...assets])].sort(ordinal);
    return { ok: false, code: 'MODULE_AMBIGUOUS', outcome: 'not_sent', openModules: names, candidates,
      error: assets.length
        ? `"${name}" has the letters and digits of ${candidates.length} assets (${candidates.join(', ')}; open: ${list.map(m => m.name).join(', ')}); nothing was sent. Repeat with the exact module name.`
        : `"${name}" names ${list.length} open modules (${candidates.join(', ')}); nothing was sent. Repeat with the exact module name.` };
  };
  const exact = modules.filter(m => m.name === name || (m.key && m.key === name));
  if (exact.length) return { ok: true, module: name, via: 'exact', requested: name };
  const all = lane === 'odc' ? catalogModules(catalog) : [];
  let named = all.filter(m => m.name === name);
  if (!named.length) named = all.filter(m => m.name.toLowerCase() === name.toLowerCase());
  const rules = [
    ['case', () => modules.filter(m => m.name.toLowerCase() === name.toLowerCase())],
    ['catalog', () => modules.filter(m => m.key && named.some(a => a.key === m.key))],
    ['compact', () => (!named.length && compactName(name) ? modules.filter(m => compactName(m.name) === compactName(name)) : [])],
  ];
  for (const [via, match] of rules) {
    const list = distinct(match());
    if (list.length > 1) return ambiguous(list);
    if (list.length === 1) {
      if (via !== 'compact') return found(via, list);
      // The catalog names of the open module are its own; any other asset with the same letters and digits is another app.
      const same = all.filter(a => compactName(a.name) === compactName(name));
      const own = new Set(same.filter(a => a.key === list[0].key).map(a => a.name));
      const others = same.filter(a => !own.has(a.name)).map(a => a.name);
      return others.length ? ambiguous(list, others) : found(via, list);
    }
    if (via === 'catalog' && named.length) {
      // The catalog knows this name as an asset that is not open: that asset, never an open module with a similar name.
      const keys = [...new Set(named.map(a => a.key))].sort(ordinal);
      return { ok: false, code: 'MODULE_NOT_OPEN', outcome: 'not_sent', openModules: names,
        error: `No module open in the ODC Studio is "${name}" (open: ${names.length ? names.join(', ') : 'none'}); nothing was sent. The catalog names it: asset ${keys.join(', ')}.`,
        continuation: { tool: 'studio_open', arguments: { module: keys.length === 1 ? keys[0] : name }, why: 'Opens it from the organization; then repeat this call with the same arguments.' } };
    }
  }
  if (lane !== 'odc') return { ok: true, module: name, via: 'unresolved', requested: name };
  return { ok: false, code: 'MODULE_NOT_OPEN', outcome: 'not_sent', openModules: names,
    error: `No module open in the ODC Studio is "${name}" (open: ${names.length ? names.join(', ') : 'none'}); nothing was sent.`,
    continuation: { tool: 'studio_open', arguments: { module: name }, why: 'Opens it from the organization; then repeat this call with the same arguments.' } };
}
