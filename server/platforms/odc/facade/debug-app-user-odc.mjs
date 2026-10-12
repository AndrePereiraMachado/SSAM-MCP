// PRIVATE worker adapter. Passwords and returned tokens must never enter MCP arguments, logs or receipts.
// Contract follows BuiltinAuth.login/AuthConfigsManager in the published ODC app client runtime,
// rechecked in .local/debugger/proofs/client-headless/assets/_oschunk-5BKE6E4Q.js, not the Portal broker.
// Captured code proves the wire contract, not a successful live login for this implementation.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import * as cognitoRuntime from '../portal/runtime/cognito-login.mjs';

// Port D7: until the SC/Portal lane delivers cognito-login.mjs with cognitoRegionSupported (us-east-2 user pools),
// the region allowlist is the one the installed adapter verifies (us-east-1). A namespace import keeps this module
// loadable either way; a named import of the missing export made every ODC app-user sign-in fail to load.
const { cognitoLogin } = cognitoRuntime;
const cognitoRegionSupported = cognitoRuntime.cognitoRegionSupported ?? (region => region === 'us-east-1');

const CLIENT = 'client_runtime', SCOPE = 'openid', MAX_BYTES = 512 * 1024;
const MESSAGES = {
  debug_app_auth_scope_mismatch: 'Application authentication does not match the requested target.',
  debug_app_auth_provider_unsupported: 'This application identity provider requires a supported authentication adapter.',
  debug_app_auth_rejected: 'Application sign-in was rejected.',
  debug_app_auth_challenge_required: 'Application sign-in requires an additional authentication challenge.',
  debug_app_auth_unavailable: 'Application authentication is unavailable; no automatic retry was performed.',
  debug_app_auth_expired: 'The application authentication token is expired or not yet valid.',
  debug_app_auth_anchor_unavailable: 'No authenticated application user identity anchor is available.',
};
export class DebugAppAuthError extends Error {
  constructor(code) { super(MESSAGES[code]); this.name = 'DebugAppAuthError'; this.code = code; }
}
const fail = code => { throw new DebugAppAuthError(code); };
const requireValue = (value, code = 'debug_app_auth_scope_mismatch') => { if (!value) fail(code); };
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\x00-\x1f\x7f]/.test(value);

function safeUrl(value, origins) {
  let url; try { url = new URL(value); } catch { fail('debug_app_auth_scope_mismatch'); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.hash && origins.has(url.origin));
  return url;
}

export function odcAppUserBinding(binding) {
  requireValue(binding?.lane === 'odc' && /^[A-Za-z_][A-Za-z0-9_]{0,198}$/.test(binding.app ?? '')
    && (/^[a-f0-9]{32}$/i.test(binding.sessionId ?? '') || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(binding.sessionId ?? '')));
  const hasProducer = binding.module !== undefined || binding.moduleKey !== undefined;
  if (hasProducer) requireValue(/^[A-Za-z_][A-Za-z0-9_]{0,198}$/.test(binding.module ?? '') && /^[A-Za-z0-9_+]{22}$/.test(binding.moduleKey ?? ''));
  let runtime; try { runtime = new URL(binding.runtimeUrl); } catch { fail('debug_app_auth_scope_mismatch'); }
  requireValue(runtime.protocol === 'https:' && !runtime.username && !runtime.password && !runtime.search && !runtime.hash
    && runtime.pathname === '/' + binding.app + '/');
  return { lane: 'odc', runtimeUrl: runtime.href, app: binding.app, sessionId: binding.sessionId.replace(/-/g, '').toLowerCase(),
    ...(hasProducer ? { module: binding.module, moduleKey: binding.moduleKey } : {}) };
}

// Coordinator-side identity anchor of the ORIGINAL ODC login (ODC Service frames have no consumer frame).
// Only after the private session proved userKey and the native host proved auth.getUserId() === userKey
// (authenticated + identityMatches). The canonical lower-case userKey lives in this closure and reaches only
// a sealing function: private-compare's seal, an HMAC under its per-public-session key. Never enumerable,
// serialized, logged or returned.
const USER_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function odcAppUserAnchor(descriptor, authentication) {
  if (descriptor?.binding?.lane !== 'odc' || descriptor.authenticated !== true || descriptor.state !== 'authenticated' ||
      typeof descriptor.userKey !== 'string' || !USER_GUID.test(descriptor.userKey) || !(Date.parse(descriptor.expiresAt) > Date.now()) ||
      authentication?.authenticated !== true || authentication.identityMatches !== true) fail('debug_app_auth_anchor_unavailable');
  const userKey = descriptor.userKey.toLowerCase();
  // Server native renderings are untyped Scalars; the server channel canonicalizes GUID text the same way.
  const seal = (sealer, { runtime } = {}) => {
    if (runtime !== 'server' || typeof sealer !== 'function') fail('debug_app_auth_anchor_unavailable');
    return sealer({ type: 'Scalar', value: userKey, path: 'app-user', unavailable: false, undefined: false, trimmed: false, deferred: false, children: [] });
  };
  return Object.freeze(Object.defineProperties({ kind: 'app-user', lane: 'odc' }, { seal: { value: seal } }));
}

function jwtParts(token) {
  requireValue(nonempty(token));
  const parts = token.split('.');
  requireValue(parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)));
  try {
    return { header: JSON.parse(Buffer.from(parts[0], 'base64url')), claims: JSON.parse(Buffer.from(parts[1], 'base64url')),
      signed: parts[0] + '.' + parts[1], signature: Buffer.from(parts[2], 'base64url') };
  } catch { fail('debug_app_auth_scope_mismatch'); }
}

function validateJwt(token, keys, issuer, time, { nonce, idToken = false } = {}) {
  const jwt = jwtParts(token), claims = jwt.claims;
  requireValue(jwt.header.alg === 'RS256' && nonempty(jwt.header.kid) && claims && typeof claims === 'object');
  const matching = keys.filter(key => key.kid === jwt.header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
  requireValue(matching.length === 1);
  try {
    const { kty, n, e } = matching[0];
    const publicKey = createPublicKey({ key: { kty, n, e }, format: 'jwk' });
    requireValue(publicKey.asymmetricKeyDetails?.modulusLength >= 2048
      && verify('RSA-SHA256', Buffer.from(jwt.signed), publicKey, jwt.signature));
  } catch { fail('debug_app_auth_scope_mismatch'); }
  requireValue(claims.iss === issuer && nonempty(claims.sub));
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  requireValue(idToken ? audience.includes(CLIENT) : audience.includes(CLIENT) || claims.azp === CLIENT);
  if (claims.azp !== undefined) requireValue(claims.azp === CLIENT);
  if (nonce !== undefined) requireValue(claims.nonce === nonce);
  requireValue(Number.isFinite(claims.exp) && claims.exp * 1000 > time + 10000
    && (claims.nbf === undefined || Number.isFinite(claims.nbf) && claims.nbf * 1000 <= time)
    && (claims.iat === undefined || Number.isFinite(claims.iat) && claims.iat * 1000 <= time + 10000), 'debug_app_auth_expired');
  return claims;
}

// Returns a PRIVATE session. The caller stores it privately and exposes only safe authentication metadata.
// No browser, Studio calls, Portal session, filesystem credential input, or persisted password is used.
export async function authenticateOdcAppUser({ binding, credentials, fetchImpl = fetch, cognito = cognitoLogin, now = Date.now, observer } = {}) {
  const target = odcAppUserBinding(binding);
  requireValue(nonempty(credentials?.username) && typeof credentials?.password === 'string' && credentials.password.length > 0
    && credentials.password.length <= 16384, 'debug_app_auth_rejected');
  const origin = new URL(target.runtimeUrl).origin, origins = new Set([origin]);
  const jar = new CookieJar(undefined, { rejectPublicSuffixes: true, prefixSecurity: 'strict', allowSecureOnLocal: false });
  const signal = AbortSignal.timeout(90000);
  let requests = 0;
  // PRIVATE diagnostics deliberately have no URL, query, header, body, identity or native error.
  // Observer failures cannot change authentication. Observers should record these small events synchronously.
  let stage = 'runtime-config', detail = 'stage-contract', authorizationPath, resumePath;
  const observe = event => {
    if (typeof observer !== 'function') return;
    try {
      const result = observer(Object.freeze(event));
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {}
  };
  const enter = value => { stage = value; detail = 'stage-contract'; observe({ event: 'stage', stage }); };
  const endpointLabels = { 'runtime-config': 'runtime_auth_configs', 'identity-discovery': 'identity_discovery',
    'builtin-broker': 'broker_redirect', 'srp-signin': 'cognito_srp', 'broker-store-token': 'token_store',
    'broker-resume': 'broker_resume', 'platform-token': 'platform_token', 'platform-jwks': 'platform_jwks',
    'user-profile': 'user_profile', 'user-roles': 'user_roles' };
  const request = async (value, { method = 'GET', headers = {}, body } = {}) => {
    const url = safeUrl(value, origins);
    requireValue(++requests <= 32, 'debug_app_auth_unavailable');
    const cookie = await jar.getCookieString(url.href);
    let response;
    try {
      response = await fetchImpl(url.href, { method, headers: { Accept: 'application/json', ...headers, ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), signal, redirect: 'manual', credentials: 'omit' });
      const endpoint = stage === 'runtime-config' && url.pathname === '/' + target.app + '/moduleservices/clientsettingsinfo' ? 'runtime_client_settings'
        : stage === 'builtin-broker' && url.pathname === authorizationPath ? 'broker_authorize'
        : stage === 'broker-resume' && url.pathname !== resumePath ? 'broker_redirect' : endpointLabels[stage];
      observe({ event: 'http', stage, endpoint, method: method === 'POST' ? 'POST' : 'GET',
        status: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0 });
      for (const entry of response.headers.getSetCookie?.() ?? []) await jar.setCookie(entry, url.href, { ignoreError: true });
      const chunks = []; let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value: bytes } = await reader.read(); if (done) break;
          size += bytes.byteLength;
          if (size > MAX_BYTES) { await reader.cancel(); fail('debug_app_auth_unavailable'); }
          chunks.push(Buffer.from(bytes));
        }
      }
      return { status: response.status, location: response.headers.get('location'), text: Buffer.concat(chunks).toString('utf8') };
    } catch (error) { if (error instanceof DebugAppAuthError) throw error; fail('debug_app_auth_unavailable'); }
  };
  const json = async (url, options, acceptedStatuses = [200]) => {
    const response = await request(url, options);
    detail = 'http-status';
    requireValue(acceptedStatuses.includes(response.status), response.status === 401 || response.status === 403 ? 'debug_app_auth_rejected' : 'debug_app_auth_provider_unsupported');
    detail = 'json-response';
    try { const value = JSON.parse(response.text); detail = 'stage-contract'; return value; } catch { fail('debug_app_auth_provider_unsupported'); }
  };
  const redirect = async value => {
    let url = safeUrl(value, origins);
    for (let i = 0; i < 8; i++) {
      // The final /identity callback is consumed locally, just as the native client parses its code/state.
      if (url.pathname === '/identity' && url.searchParams.has('code')) return url;
      const response = await request(url.href);
      if (response.status >= 300 && response.status < 400 && response.location) url = safeUrl(new URL(response.location, url).href, origins);
      else { requireValue(response.status === 200, 'debug_app_auth_rejected'); return url; }
    }
    fail('debug_app_auth_unavailable');
  };
  try {
    enter('runtime-config');
    // Published useSettingsAndAuthConfigs/selectAuthConfigsManager prefers the
    // IdentityProviders setting. A present but invalid setting must not silently
    // select another provider from the legacy endpoint.
    const settings = await json(target.runtimeUrl + 'moduleservices/clientsettingsinfo');
    detail = 'configuration-shape';
    requireValue(settings?.clientSettings && typeof settings.clientSettings === 'object'
      && !Array.isArray(settings.clientSettings), 'debug_app_auth_provider_unsupported');
    const providerSetting = settings.clientSettings.IdentityProviders;
    let configurations;
    if (providerSetting === undefined || providerSetting === null || providerSetting === '') {
      const metadata = await json(target.runtimeUrl + 'moduleservices/auth/configs');
      detail = 'configuration-shape';
      configurations = metadata?.authConfigurations;
    } else {
      requireValue(typeof providerSetting === 'string', 'debug_app_auth_provider_unsupported');
      try { configurations = JSON.parse(providerSetting); } catch { fail('debug_app_auth_provider_unsupported'); }
    }
    requireValue(Array.isArray(configurations) && configurations.every(item => item && typeof item === 'object' && !Array.isArray(item)),
      'debug_app_auth_provider_unsupported');
    const builtins = configurations.filter(item => item.type === 'cognito' || item.kc_hint === 'cognito');
    detail = 'builtin-provider-count';
    requireValue(builtins.length === 1, 'debug_app_auth_provider_unsupported');
    const builtin = builtins[0], config = builtin.configs, pool = config?.poolId;
    const client = config?.amplifyClientId ?? config?.clientId, flow = config?.authFlow ?? 'USER_SRP_AUTH';
    const poolRegion = typeof pool === 'string' ? pool.split('_')[0] : undefined;
    const region = config?.region ?? poolRegion;
    // The pool/client and region come from this app; an explicit region must
    // agree with the pool. No default tenant or alternate provider is selected.
    detail = 'builtin-provider-contract';
    requireValue(cognitoRegionSupported(region) && region === poolRegion && /^(us-east-[12])_[A-Za-z0-9]+$/.test(pool ?? '') && /^[A-Za-z0-9]+$/.test(client ?? '')
      && flow === 'USER_SRP_AUTH' && /^[A-Za-z0-9_-]+$/.test(builtin.kc_hint ?? 'cognito'), 'debug_app_auth_provider_unsupported');
    const cognitoOrigin = `https://cognito-idp.${region}.amazonaws.com`;
    enter('identity-discovery');
    const discovery = await json(origin + '/identity/.well-known/openid-configuration');
    const issuer = safeUrl(discovery.issuer, origins);
    detail = 'discovery-capabilities';
    requireValue(!issuer.search && typeof discovery.issuer === 'string' && discovery.code_challenge_methods_supported?.includes('S256')
      && discovery.response_types_supported?.includes('code') && discovery.id_token_signing_alg_values_supported?.includes('RS256'), 'debug_app_auth_provider_unsupported');
    const authorization = safeUrl(discovery.authorization_endpoint, origins), tokenUrl = safeUrl(discovery.token_endpoint, origins), jwksUrl = safeUrl(discovery.jwks_uri, origins);
    authorizationPath = authorization.pathname;
    detail = 'discovery-endpoints';
    requireValue(!authorization.search && !tokenUrl.search && !jwksUrl.search, 'debug_app_auth_provider_unsupported');
    const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(24).toString('base64url'), nonce = randomBytes(24).toString('base64url'), callback = origin + '/identity';
    authorization.search = new URLSearchParams({ client_id: CLIENT, scope: SCOPE, redirect_uri: callback, response_type: 'code',
      kc_idp_hint: builtin.kc_hint ?? 'cognito', code_challenge: challenge, code_challenge_method: 'S256', state, nonce }).toString();
    enter('builtin-broker');
    const login = await redirect(authorization.href);
    // A fresh, isolated attempt must reach the built-in broker, never adopt a preexisting authenticated code.
    detail = 'broker-parameters';
    requireValue(!login.searchParams.has('code') && nonempty(login.searchParams.get('state')) && nonempty(login.searchParams.get('redirect_uri')), 'debug_app_auth_provider_unsupported');
    const resume = safeUrl(login.searchParams.get('redirect_uri'), origins);
    resumePath = resume.pathname;
    let cognitoTokens;
    enter('srp-signin');
    try {
      origins.add(cognitoOrigin);
      cognitoTokens = await cognito({ config: { Region: region, PoolKey: pool, AmplifyClientKey: client, AuthFlow: flow },
        username: credentials.username, password: credentials.password, request, signal, observer: observe });
    } catch (error) {
      fail(error?.code === 'PORTAL_LOGIN_CHALLENGE_REQUIRED' ? 'debug_app_auth_challenge_required'
        : error?.code === 'PORTAL_LOGIN_PROVIDER_UNSUPPORTED' ? 'debug_app_auth_provider_unsupported' : 'debug_app_auth_rejected');
    } finally { origins.delete(cognitoOrigin); }
    requireValue(['IdToken', 'AccessToken', 'RefreshToken'].every(key => nonempty(cognitoTokens?.[key])), 'debug_app_auth_rejected');
    enter('broker-store-token');
    // The native exchange creates a code and can return 201. Other endpoints retain their 200 contract.
    const stored = await json(origin + '/identityapi/v1alpha1/oidc/store-token', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: { clientId: client, idToken: cognitoTokens.IdToken, accessToken: cognitoTokens.AccessToken, refreshToken: cognitoTokens.RefreshToken } }, [200, 201]);
    cognitoTokens = null;
    requireValue(nonempty(stored.authCode), 'debug_app_auth_rejected');
    resume.searchParams.set('code', stored.authCode); resume.searchParams.set('state', login.searchParams.get('state'));
    enter('broker-resume');
    const complete = await redirect(resume.href);
    detail = 'callback-binding';
    requireValue(complete.origin === origin && complete.pathname === '/identity' && complete.searchParams.get('state') === state
      && nonempty(complete.searchParams.get('code')) && (!complete.searchParams.has('iss') || complete.searchParams.get('iss') === discovery.issuer));
    enter('platform-token');
    const tokens = await json(tokenUrl.href, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: complete.searchParams.get('code'), client_id: CLIENT, redirect_uri: callback, code_verifier: verifier }).toString() });
    requireValue(tokens.token_type?.toLowerCase() === 'bearer' && nonempty(tokens.access_token) && nonempty(tokens.id_token)
      && nonempty(tokens.refresh_token) && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0);
    enter('platform-jwks');
    const jwks = await json(jwksUrl.href); requireValue(Array.isArray(jwks.keys) && jwks.keys.length <= 30);
    enter('token-validation');
    const time = now(), access = validateJwt(tokens.access_token, jwks.keys, discovery.issuer, time);
    const id = validateJwt(tokens.id_token, jwks.keys, discovery.issuer, time, { nonce, idToken: true });
    requireValue(access.sub === id.sub && access.scope?.split(' ').includes(SCOPE)
      && (tokens.scope === undefined || tokens.scope.split(' ').includes(SCOPE)));
    const headers = { Authorization: 'Bearer ' + tokens.access_token };
    enter('user-profile');
    const profile = await json(origin + '/api/user-information/v1/profiles/me?embed=UserIdentityProviders', { headers });
    enter('user-roles');
    const roleClaims = await json(origin + '/api/user-information/v1/claims', { headers });
    requireValue(nonempty(profile.id) && Array.isArray(roleClaims.claims) && roleClaims.claims.length <= 10000 && roleClaims.claims.every(nonempty));
    const expiresAt = Math.min(access.exp * 1000, id.exp * 1000, time + tokens.expires_in * 1000);
    requireValue(expiresAt > now() + 10000, 'debug_app_auth_expired');
    enter('session-complete');
    return { binding: target, userKey: profile.id, roles: [...new Set(roleClaims.claims)], authenticatedAt: new Date(time).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(), accessToken: tokens.access_token, idToken: tokens.id_token, refreshToken: tokens.refresh_token };
  } catch (error) {
    observe({ event: 'failure', stage, detail, code: error instanceof DebugAppAuthError ? error.code : 'debug_app_auth_unavailable' });
    if (error instanceof DebugAppAuthError) throw error;
    fail('debug_app_auth_unavailable');
  } finally { await jar.removeAllCookies(); }
}
