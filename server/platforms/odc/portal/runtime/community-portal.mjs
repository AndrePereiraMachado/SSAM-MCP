// OutSystems ID community authorization for the Portal's own PKCE/state request.
// Reuse the verified private identity protocol; never export its tokens or cookies.
import { CommunityIdentity } from '../../facade/service-center/community-identity.mjs';
import { PortalMetadata } from './portal-metadata.mjs';
import { screenservice } from './portal-routes.mjs';
import { fail } from './errors.mjs';

const ID = 'https://id.outsystems.com';
export class CommunityPortalIdentity extends CommunityIdentity {
  async authorizePortal(value, origin) {
    const login = this.url(value);
    if (login.pathname !== '/community/login') fail('PORTAL_LOGIN_PROVIDER_UNSUPPORTED', 'The community login route is not supported.');
    const fields = ['response_type', 'client_id', 'scope', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'state', 'nonce', 'login_hint'];
    const vars = Object.fromEntries(fields.map(key => [key, login.searchParams.get(key) ?? '']));
    let callback;
    try { callback = new URL(vars.redirect_uri); } catch { fail('PORTAL_CONTRACT_CHANGED', 'The Portal identity callback is missing.'); }
    if (callback.origin !== origin || callback.username || callback.password || callback.hash || callback.search
      || /%2e|%2f|%5c/i.test(callback.pathname) || vars.response_type !== 'code' || vars.code_challenge_method !== 'S256'
      || !/^[A-Za-z0-9_-]{43}$/.test(vars.code_challenge) || !vars.state || !vars.client_id || !vars.scope.split(' ').includes('openid'))
      fail('PORTAL_CONTRACT_CHANGED', 'The Portal identity callback, state or PKCE contract does not match.');
    await this.authenticate();
    const metadata = new PortalMetadata({ origin: ID, request: (url, options) => this.request(url, options) });
    const response = await screenservice({ origin: ID, metadata, request: (url, options) => this.request(url, { ...options, token: true }) },
      { module: 'community', view: 'Auth.login', action: 'community/Auth/login/DataActionGetSessionData', screenVariables: vars });
    const session = response.data;
    if (session?.HasSession !== true || session.IsAuthorizedRedirect_Uri !== true)
      fail('PORTAL_LOGIN_REJECTED', 'OutSystems ID did not authorize the exact Portal callback.');
    if (session.NeedsToAcceptTerms !== false) fail('PORTAL_LOGIN_TERMS_REQUIRED', 'OutSystems ID requires the user to review terms; no acceptance was submitted.');
    if (session.AuthEndpointKC !== this.endpoints.authorization_endpoint || session.AuthRedirectUriKC !== ID + '/community/rest/redirect/login')
      fail('PORTAL_CONTRACT_CHANGED', 'OutSystems ID authorization endpoints changed.');
    let next = new URL(session.AuthEndpointKC);
    next.search = new URLSearchParams({ ...vars, redirect_uri: session.AuthRedirectUriKC, prompt: 'none' });
    for (let hop = 0; hop < 8; hop++) {
      if (next.origin === origin) {
        if (next.pathname !== callback.pathname || next.searchParams.get('state') !== vars.state
          || !next.searchParams.get('code') || next.searchParams.has('error'))
          fail('PORTAL_LOGIN_STATE_MISMATCH', 'The Portal callback does not match the original authorization request.');
        return next;
      }
      this.url(next);
      if (![new URL(this.endpoints.authorization_endpoint).pathname, '/community/rest/redirect/login'].includes(next.pathname))
        fail('PORTAL_LOGIN_CHALLENGE_REQUIRED', 'OutSystems ID requires interactive authentication.');
      const r = await this.request(next);
      if (![302, 303].includes(r.status) || !r.location) fail('PORTAL_LOGIN_CHALLENGE_REQUIRED', 'OutSystems ID did not complete silent authorization.');
      next = new URL(r.location, next);
    }
    fail('PORTAL_LOGIN_REDIRECT_LIMIT', 'The Portal authorization redirect budget was exhausted.');
  }
}
