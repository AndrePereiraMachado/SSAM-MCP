import { fail } from './errors.mjs';
import { requestBytes, readJson } from './http.mjs';

export class OAuthClient {
  constructor(config, fetchImpl = globalThis.fetch, now = Date.now) {
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.cached = null;
    this.pending = null;
    this.tokenEndpoint = null;
    this.knownTokens = new Set();
  }

  configured() { return Boolean(this.config.origin && this.config.clientId && this.config.clientSecret); }
  secrets() { return [this.config.clientId, this.config.clientSecret, ...this.knownTokens]; }

  invalidate(token) { if (this.cached?.token === token) this.cached = null; }

  async getToken() {
    if (!this.configured()) fail('AUTH_NOT_CONFIGURED', 'Configure the portal origin and an authorized API client locally. Catalog discovery remains available without credentials.');
    if (this.cached && this.cached.expiresAt > this.now()) return this.cached.token;
    if (this.pending) return this.pending;
    this.pending = this.acquire();
    try { return await this.pending; } finally { this.pending = null; }
  }

  async acquire() {
    if (!this.tokenEndpoint) {
      const discovery = await requestBytes(this.fetch,
        `${this.config.origin}/identity/.well-known/openid-configuration`,
        { method: 'GET', headers: { accept: 'application/json' } }, this.config, 256 * 1024);
      if (!discovery.ok) fail('AUTH_DISCOVERY_FAILED', 'OpenID discovery failed.', { status: discovery.status });
      const document = readJson(discovery.bytes, 'AUTH_DISCOVERY_INVALID');
      let endpoint;
      try { endpoint = new URL(document.token_endpoint); }
      catch { fail('AUTH_DISCOVERY_INVALID', 'Discovery did not provide a valid token endpoint.'); }
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || endpoint.search
        || !this.config.trustedTokenOrigins.has(endpoint.origin)) {
        fail('AUTH_AUTHORITY_BLOCKED', 'The discovered token endpoint is outside the operator-approved HTTPS origins.');
      }
      if (document.grant_types_supported && !document.grant_types_supported.includes('client_credentials')) {
        fail('AUTH_GRANT_UNSUPPORTED', 'The discovered provider does not advertise client_credentials.');
      }
      if (document.token_endpoint_auth_methods_supported && !document.token_endpoint_auth_methods_supported.includes('client_secret_post')) {
        fail('AUTH_METHOD_UNSUPPORTED', 'The provider does not advertise the documented client_secret_post method.');
      }
      this.tokenEndpoint = endpoint.href;
    }
    const response = await requestBytes(this.fetch, this.tokenEndpoint, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.config.clientId, client_secret: this.config.clientSecret }).toString(),
    }, this.config, 256 * 1024);
    if (!response.ok) fail('AUTH_FAILED', 'API client authentication failed; check client status and authorization with the administrator.', { status: response.status });
    const data = readJson(response.bytes, 'AUTH_RESPONSE_INVALID');
    if (typeof data.access_token !== 'string' || !data.access_token || /[\r\n]/.test(data.access_token)
      || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      fail('AUTH_RESPONSE_INVALID', 'Token response is missing a valid Bearer token or positive expiry.');
    }
    this.knownTokens.add(data.access_token);
    // Bound redaction state; normal cache expiry uses the actual provider lifetime.
    if (this.knownTokens.size > 16) this.knownTokens.delete(this.knownTokens.values().next().value);
    const skewMs = Math.min(60_000, data.expires_in * 100);
    this.cached = { token: data.access_token, expiresAt: this.now() + data.expires_in * 1000 - skewMs };
    return data.access_token;
  }
}
