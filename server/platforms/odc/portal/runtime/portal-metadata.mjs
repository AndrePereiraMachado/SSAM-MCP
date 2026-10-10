import { fail } from './errors.mjs';

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Inspect only same-origin public module assets; never execute downloaded JS.
export class PortalMetadata {
  constructor({ origin, request }) { this.origin = origin; this.request = request; this.cache = new Map(); }
  async resolve(module, view, action, signal) {
    const key = `${module}:${view}:${action}`;
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    const versionResponse = await this.request(`${this.origin}/${module}/moduleservices/moduleversioninfo`, { signal });
    let version;
    try { version = JSON.parse(versionResponse.text).versionToken; } catch {}
    if (typeof version !== 'string' || !version) fail('PORTAL_CONTRACT_CHANGED', 'Module version metadata unavailable.');
    const html = (await this.request(`${this.origin}/${module}/`, { signal })).text;
    const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(match => new URL(match[1], `${this.origin}/${module}/`));
    const bundle = scripts.find(url => url.pathname.includes('_osbundle-') && url.pathname.includes('.index'));
    if (!bundle || bundle.origin !== this.origin) fail('PORTAL_CONTRACT_CHANGED', 'Module entry bundle unavailable.');
    const entry = (await this.request(bundle.href, { signal })).text;
    const actualView = view.replace(new RegExp(`^${escape(module)}\\.`), '');
    const viewPattern = new RegExp(`screenName:["']${escape(actualView)}["'][\\s\\S]{0,400}?import\\(["']([^"']+)["']`);
    const lazy = entry.match(viewPattern);
    if (!lazy) fail('PORTAL_CONTRACT_CHANGED', 'Exact Portal view metadata was not found.');
    const pending = [new URL(lazy[1], bundle)], visited = new Set(), candidates = new Map();
    const tail = action.split('/').at(-1);
    let bytes = 0;
    while (pending.length && visited.size < 48) {
      const url = pending.shift();
      if (visited.has(url.href)) continue;
      if (url.origin !== this.origin || !url.pathname.startsWith(`/${module}/scripts/`) || !url.pathname.endsWith('.js')) continue;
      visited.add(url.href);
      const code = (await this.request(url.href, { signal })).text;
      bytes += Buffer.byteLength(code);
      if (bytes > 16000000) fail('PORTAL_CONTRACT_CHANGED', 'Metadata discovery budget exhausted.');
      for (const match of code.matchAll(/["']screenservices\/([^"']+)["']\s*,\s*["']([^"']+)["']/g)) {
        if (match[1].startsWith(`${module}/`) && match[1].split('/').at(-1) === tail) candidates.set(match[1], match[2]);
      }
      if (candidates.has(action)) break;
      const imports = [...code.matchAll(/(?:from\s*|import\s*\()["'](\.\/[^"']+\.js)["']/g)].map(match => new URL(match[1], url));
      pending.push(...imports.filter(value => !visited.has(value.href)));
    }
    const exact = candidates.has(action) ? action : null;
    if (!exact) fail('PORTAL_CONTRACT_CHANGED', 'The exact allowed action was not found in its current view. Similar names in other blocks are not substitutes.');
    const value = { moduleVersion: version, apiVersion: candidates.get(exact), action: exact, view: actualView,
      remapped: exact !== action, assetsInspected: visited.size };
    this.cache.set(key, { value, expires: Date.now() + 300000 });
    return value;
  }

  // Capture of an unmapped route (PORTAL_GAPS): the screens of a module and the screenservice actions its scripts
  // name, from the same public assets resolve() reads, through GETs only. From one view when given (its lazy script
  // and imports), else from the entry bundle. Names only: nothing is called, no version token is returned.
  async routes(module, { view, match, signal, maxAssets = 48 } = {}) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(module) || ['authentication', 'identity', 'api'].includes(module.toLowerCase())) fail('INPUT_INVALID', 'module must be a Portal module name outside authentication, identity and api.');
    const versionResponse = await this.request(`${this.origin}/${module}/moduleservices/moduleversioninfo`, { signal });
    let version;
    try { version = JSON.parse(versionResponse.text).versionToken; } catch {}
    if (typeof version !== 'string' || !version) fail('PORTAL_CONTRACT_CHANGED', 'Module version metadata unavailable.');
    const html = (await this.request(`${this.origin}/${module}/`, { signal })).text;
    const bundle = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => new URL(m[1], `${this.origin}/${module}/`))
      .find(url => url.pathname.includes('_osbundle-') && url.pathname.includes('.index'));
    if (!bundle || bundle.origin !== this.origin) fail('PORTAL_CONTRACT_CHANGED', 'Module entry bundle unavailable.');
    const entry = (await this.request(bundle.href, { signal })).text;
    const screens = [...new Set([...entry.matchAll(/screenName:["']([^"']+)["']/g)].map(m => m[1]))].sort();
    const visited = new Set([bundle.href]), actions = new Set(), needle = typeof match === 'string' && match ? match.toLowerCase() : null;
    const inModule = url => url.origin === this.origin && url.pathname.startsWith(`/${module}/scripts/`) && url.pathname.endsWith('.js');
    // Collects the module's own actions named in one script and returns the scripts it imports.
    const scan = (code, base) => {
      for (const m of code.matchAll(/["']screenservices\/([^"']+)["']\s*,\s*["'][^"']+["']/g)) if (m[1].startsWith(`${module}/`)) actions.add(m[1]);
      return [...code.matchAll(/(?:from\s*|import\s*\()["'](\.\/[^"']+\.js)["']/g)].map(m => new URL(m[1], base));
    };
    let pending, bytes = Buffer.byteLength(entry);
    if (view) {
      const actualView = view.replace(new RegExp(`^${escape(module)}\\.`), '');
      const lazy = entry.match(new RegExp(`screenName:["']${escape(actualView)}["'][\\s\\S]{0,400}?import\\(["']([^"']+)["']`));
      if (!lazy) fail('PORTAL_CONTRACT_CHANGED', 'The view ' + view + ' is not a screen of ' + module + '; screens: ' + screens.slice(0, 60).join(', '));
      pending = [new URL(lazy[1], bundle)];
    } else pending = scan(entry, bundle);
    while (pending.length && visited.size < maxAssets && bytes <= 16000000) {
      const url = pending.shift();
      if (visited.has(url.href) || !inModule(url)) continue;
      visited.add(url.href);
      const code = (await this.request(url.href, { signal })).text;
      bytes += Buffer.byteLength(code);
      pending.push(...scan(code, url).filter(u => !visited.has(u.href)));
    }
    const found = [...actions].filter(a => !needle || a.toLowerCase().includes(needle)).sort();
    return { module, view: view ?? null, screens, actions: found, assetsInspected: visited.size,
      truncated: pending.some(u => !visited.has(u.href) && inModule(u)) };
  }
}
