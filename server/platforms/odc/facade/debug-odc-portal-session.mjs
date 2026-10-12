// Developer-session authorization for debugger reads only. This does not log in
// to the app, replace app roles, create an API Client, or change tenant settings.
import { OdcError } from '../portal/runtime/errors.mjs';
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.outsystems\.dev$/;
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = code => { throw new OdcError('DEBUG_ODC_SESSION_' + code.toUpperCase(), 'debug_odc_session_' + code); };
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));

export function explicitDebugTenant(host, tenantOf) {
  try { return tenantOf(host); }
  catch (error) {
    if (typeof host !== 'string' || !HOST.test(host) || !/^Unknown tenant /.test(error.message ?? '')) throw error;
    return { host, tenant: { portalOrigin: 'https://' + host, nativeSessionOnly: true } };
  }
}

export class OdcStudioSessionAuth {
  method = 'ODC Studio developer session';
  retryReadOnUnauthorized = false;
  #host; #acquire; #now; #tokens = new Set(); #rejected = new Set(); #cached; #pending; #binding; #developer;
  constructor({ host, acquire, now = Date.now }) {
    if (!HOST.test(host ?? '') || typeof acquire !== 'function') fail('target_invalid');
    this.#host = host; this.#acquire = acquire; this.#now = now;
  }
  configured() { return true; }
  secrets() { return [...this.#tokens]; }
  nativeAuthority() { return this.#binding ? { binding: JSON.parse(this.#binding), developerKey: this.#developer } : null; }
  invalidate(token) { if (this.#cached?.token === token) this.#cached = null; if (token) this.#rejected.add(token); }
  async getToken() {
    if (this.#rejected.size) fail('native_token_rejected');
    if (this.#cached?.until > this.#now()) return this.#cached.token;
    if (this.#pending) return this.#pending;
    this.#pending = this.#read();
    try { return await this.#pending; } finally { this.#pending = null; }
  }
  async #read() {
    let reply;
    try {
      reply = await this.#acquire({ host: this.#host, includeToken: true });
      if (reply?.metadata?.host !== this.#host || !GUID.test(reply.metadata.developerKey ?? '') ||
          !reply.binding || typeof reply.binding !== 'object' || Array.isArray(reply.binding) ||
          !Number.isSafeInteger(reply.binding.pid) || reply.binding.pid < 1 || reply.binding.host !== this.#host ||
          !Number.isFinite(Date.parse(reply.binding.startedUtc)) || typeof reply.binding.studioDir !== 'string' || !reply.binding.studioDir ||
          typeof reply.token !== 'string' || !reply.token ||
          reply.token.length > 65536 || /[\x00-\x20\x7f]/.test(reply.token)) fail('native_binding_invalid');
      const binding = canonical(reply.binding);
      const developer = reply.metadata.developerKey.toLowerCase();
      if (this.#binding && this.#binding !== binding || this.#developer && this.#developer !== developer) fail('native_binding_changed');
      if (this.#rejected.has(reply.token)) fail('native_token_rejected');
      this.#binding = binding; this.#developer = developer; this.#tokens.add(reply.token);
      if (this.#tokens.size > 16) this.#tokens.delete(this.#tokens.values().next().value);
      this.#cached = { token: reply.token, until: this.#now() + 60000 };
      return reply.token;
    } catch (error) {
      if (/^debug_odc_session_[a-z_]+$/.test(error.message ?? '')) fail(error.message.slice('debug_odc_session_'.length));
      fail('native_authority_unavailable');
    } finally { if (reply && typeof reply === 'object') reply.token = null; }
  }
}

export async function debugDevelopmentStage(portal) {
  const configured = portal.tenant.stages?.Development;
  if (!portal.nativeSession && GUID.test(configured?.key ?? '') && /^[a-z0-9.-]+$/i.test(configured?.domain ?? '')) return configured;
  const response = await portal.read('portfolio-api-v2:get:/environments', {});
  const environments = Array.isArray(response) ? response : response?.results;
  if (!Array.isArray(environments)) fail('environments_unreadable');
  const rows = environments.filter(e => e.purpose === 'Development');
  if (rows.length !== 1) fail('development_environment_ambiguous');
  const row = rows[0], domain = row.defaultDomain ?? row.builtinDomain;
  if (!GUID.test(row.key ?? '') || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/i.test(domain ?? '') || domain.includes('..')) fail('development_environment_invalid');
  return { key: row.key.toLowerCase(), domain: domain.toLowerCase(), source: 'portfolio-api-v2:get:/environments', purpose: 'Development' };
}

export async function debugAsset(portal, module, { assetKey } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(module ?? '') && !GUID.test(assetKey ?? '')) fail('asset_selector_invalid');
  const readPages = async filters => {
    const rows = []; let offset = 0;
    do {
      const page = await portal.read('asset-repository-api-v1:get:/assets', { query: { ...filters, embed: ['metadata'], limit: 500, offset } });
      if (!Array.isArray(page?.results) || page.page?.offset != null && page.page.offset !== offset ||
          page.page?.count != null && page.page.count !== page.results.length) fail('asset_catalog_incomplete');
      rows.push(...page.results); if (rows.length > 5000) fail('asset_catalog_limit');
      const next = page.page?.nextPageOffset;
      // The native asset API also emits zero for the terminal page. Accept
      // that sentinel only when its exact total proves every row was read.
      if (next == null || next === 0 && page.page?.totalResults === rows.length) {
        if (page.page?.totalResults != null && page.page.totalResults !== rows.length) fail('asset_catalog_incomplete');
        return rows;
      }
      if (!Number.isSafeInteger(next) || next <= offset) fail('asset_catalog_incomplete'); offset = next;
    } while (true);
  };
  const nativePath = row => row._embedded?.metadata?.urlPath?.replace(/^\/+|\/+$/g, '');
  let matches;
  if (assetKey) matches = (await readPages({ assetKeys: [assetKey] })).filter(row => row.assetKey?.toLowerCase() === assetKey.toLowerCase());
  else {
    matches = (await readPages({ nameContains: module })).filter(row => nativePath(row) === module || row.name === module);
    if (!matches.length) matches = (await readPages({ 'metadata.urlPathContains': module })).filter(row => nativePath(row) === module);
  }
  if (matches.length !== 1 || !GUID.test(matches[0].assetKey ?? '')) fail(matches.length > 1 ? 'asset_ambiguous' : 'asset_not_found');
  return matches[0];
}

export async function debugApplicationRuntime(portal, stage, asset, moduleKey, { readApplication } = {}) {
  if (!/^[A-Za-z0-9_+]{22}$/.test(moduleKey ?? '')) fail('application_key_invalid');
  if (asset.assetType === 'Workflow') return null;
  if (portal.nativeSession || readApplication) {
    const metadata = await (readApplication ?? portal.readApplication)(moduleKey);
    let url; try { url = new URL(metadata.runtimeUrl); } catch { fail('application_url_unavailable'); }
    if (metadata.host !== portal.host || metadata.moduleKey !== moduleKey || url.protocol !== 'https:' || url.username || url.password ||
        url.search || url.hash || url.hostname !== stage.domain || !/^\/[A-Za-z_][A-Za-z0-9_]{0,120}\/?$/.test(url.pathname)) fail('application_binding_invalid');
    return url.origin + url.pathname.replace(/\/$/, '') + '/';
  }
  const route = asset._embedded?.metadata?.urlPath;
  if (typeof route !== 'string' || !/^\/?[A-Za-z_][A-Za-z0-9_]{0,120}\/?$/.test(route)) fail('application_url_unavailable');
  return 'https://' + stage.domain + '/' + route.replace(/^\/+|\/+$/g, '') + '/';
}
