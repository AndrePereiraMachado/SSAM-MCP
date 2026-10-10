import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { CookieJar } from 'tough-cookie';
import { PortalReadAdapter } from './portal-read.mjs';
import { PortalMetadata } from './portal-metadata.mjs';
import { fail, publicError, redact } from './errors.mjs';
import { cognitoLogin } from './cognito-login.mjs';
import { PORTAL_READS, routeOf, screenservice } from './portal-routes.mjs';
import { DEFAULT_PORTAL_ORIGIN } from './default-origin.mjs';

const run = promisify(execFile);
// The corporate tenant of tenants.json (default-origin.mjs); other tenants pass their own origin (and get their own vault entry).
const defaultOrigin = DEFAULT_PORTAL_ORIGIN;
export const portalCredentialHelper = fileURLToPath(new URL('./windows-portal-credential.ps1', import.meta.url));
const identityOrigins = ['https://id.outsystems.dev', 'https://cognito-idp.eu-west-1.amazonaws.com', 'https://cognito-idp.us-east-1.amazonaws.com'];
const bundledPowerShell = path.resolve(path.dirname(process.execPath), '../../native/powershell/pwsh.exe');
export const portalPowerShell = existsSync(bundledPowerShell) ? bundledPowerShell : 'pwsh.exe';
export const portalBootstrapCommand = (origin = defaultOrigin) => `& "${portalPowerShell}" -NoProfile -File "${portalCredentialHelper}" -Mode bootstrap -Origin ${origin}`;

// mode status|read on SSAM/ODC3/<host>/Portal, status on SSAM/ODC3/<host>/DB/<database> (an external DB connection)
// or SSAM/ODC3/<host>/Setting/<setting> (a secret setting value): those two are read only by the bridge, in the Studio.
export async function portalVault(mode, origin = defaultOrigin, database, setting) {
  if (process.platform !== 'win32') fail('PORTAL_AUTH_REQUIRED', 'This configured host uses Windows Credential Manager.');
  if (mode === 'read' && (database || setting)) fail('STUDIO_REQUIRED', 'Database accounts and secret setting values are read only by the bridge inside the ODC Studio.');
  try {
    const { stdout } = await run(portalPowerShell, ['-NoProfile', '-NonInteractive', '-File', portalCredentialHelper, '-Mode', mode, '-Origin', origin,
      ...(database ? ['-Database', database] : []), ...(setting ? ['-Setting', setting] : [])], { windowsHide: true, timeout: 15000, maxBuffer: 12000 });
    return JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch { fail('PORTAL_VAULT_UNAVAILABLE', 'The target-specific Windows credential manager could not be accessed.'); }
}

export class Odc3PortalBroker {
  constructor({ origin = defaultOrigin, credentialProvider, fetchImpl = fetch, cognito = cognitoLogin } = {}) {
    this.target = 'odc3'; this.origin = origin; this.fetch = fetchImpl;
    this.credentials = credentialProvider ?? (mode => portalVault(mode, origin));
    this.allowedOrigins = new Set([origin, ...identityOrigins]);
    this.jar = new CookieJar(undefined, { rejectPublicSuffixes: true, prefixSecurity: 'strict', allowSecureOnLocal: false });
    this.metadata = new PortalMetadata({ origin, request: (url, options) => this.request(url, options) });
    this.authenticated = false; this.loginPending = null; this.available = false; this.secrets = [];
    this.cognito = cognito;
    this.lastRead = null;
    // Current Portal app queries use DataActionLogSearch. The similarly named
    // AgentsLogs wrapper is not equivalent and must never be used as fallback.
    this.blockedOperations = new Set();
    this.verifiedOperations = new Set();
  }
  async initialize() {
    try { this.available = (await this.credentials('status')).available === true; this.vaultError = null; }
    catch (error) { this.available = false; this.vaultError = publicError(error); }
  }
  status() { const origin = this.origin, bootstrapCommand = portalBootstrapCommand(origin);
    return { target: this.target, origin, implementationRevision: 'odc3-portal-logs-traces-20260915-v2', credentialConfigured: this.available, authenticated: this.authenticated,
    mechanism: 'Managed Windows credential entry; own in-memory Portal HTTP session, not Studio Bearer or browser extraction',
    lastSuccessfulRead: this.lastRead, bootstrapRequired: !this.available && !this.vaultError,
    runtimeQueryCompatibility: 'Current DataActionLogSearch and app-discovery input contracts are mapped. Reads require explicit authentication, exact metadata and response scope/schema validation; agent logs are never substituted. See per-operation authenticatedReadVerified for live proof.',
    ...(this.vaultError ? { vaultError: this.vaultError } : !this.available ? { operatorAction: bootstrapCommand, explanation: 'Run locally and enter your Portal account for ' + new URL(origin).host + ' in the private OS prompt, never in chat. Then authenticate (odc3_authenticate, or odc_portal_login in the ssam MCP). Cognito SRP is supported; SSO-only or MFA accounts use the Studio Portal window instead and fail here explicitly.' } : {}),
    publicRestAuthentication: 'Separate API-client OAuth configuration; Portal credentials do not grant public REST client access.' }; }

  async request(value, { method = 'GET', body, headers = {}, signal } = {}) {
    const url = new URL(value);
    if (!this.allowedOrigins.has(url.origin) || url.username || url.password || url.hash) fail('PORTAL_ORIGIN_DENIED', 'Portal authentication/read origin is not allowlisted.');
    if (signal?.aborted) fail('PORTAL_TIMEOUT', 'Portal request cancelled.');
    const cookie = await this.jar.getCookieString(url.href);
    const response = await this.fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
      signal: signal ?? AbortSignal.timeout(15000), headers: { Accept: 'application/json', ...headers, ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': headers['Content-Type'] ?? 'application/json; charset=UTF-8' }) } });
    for (const entry of response.headers.getSetCookie()) {
      // Browsers ignore invalid cross-domain Set-Cookie entries as well; they
      // must neither widen our scope nor make valid module metadata unusable.
      const saved = await this.jar.setCookie(entry, url.href, { ignoreError: true });
      if (saved?.value) this.secrets.push(saved.value);
    }
    const reader = response.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) while (true) {
      const { value: bytes, done } = await reader.read(); if (done) break;
      size += bytes.byteLength;
      if (size > 4000000) { await reader.cancel(); fail('PORTAL_RESPONSE_TOO_LARGE', 'Portal response exceeds host budget.'); }
      chunks.push(Buffer.from(bytes));
    }
    return { status: response.status, location: response.headers.get('location'), text: Buffer.concat(chunks).toString('utf8') };
  }

  async action(module, view, action, inputParameters = {}, screenVariables = {}, signal, clientVariables = {}, discoveryView = view) {
    const origin = this.origin;
    const cookies = await this.jar.getCookies(`${origin}/${module}/`);
    const csrf = cookies.find(cookie => cookie.key === 'crf')?.value;
    try {
      return await screenservice({ origin, metadata: this.metadata, request: (url, options) => this.request(url, options) },
        { module, view, action, discoveryView, inputParameters, screenVariables, clientVariables, signal,
          extra: { headers: { Origin: origin, Referer: `${origin}/${module}/`, 'outsystems-client-env': 'browser', ...(csrf ? { 'x-csrftoken': csrf } : {}) } } });
    } catch (error) {
      if (['PORTAL_AUTH_REQUIRED', 'PORTAL_ACCESS_DENIED'].includes(error.code)) this.authenticated = false;
      throw error;
    }
  }

  async redirects(value, stop, signal) {
    let url = new URL(value);
    for (let index = 0; index < 10; index++) {
      if (!this.allowedOrigins.has(url.origin)) fail('PORTAL_LOGIN_PROVIDER_UNSUPPORTED', 'Login requires an identity provider outside the configured managed flow.');
      if (stop(url)) return url;
      const response = await this.request(url.href, { signal });
      if (response.status < 300 || response.status > 399 || !response.location) return url;
      url = new URL(response.location, url);
    }
    fail('PORTAL_LOGIN_REDIRECT_LIMIT', 'Authentication redirect budget exhausted.');
  }

  async authenticate() {
    if (this.loginPending) return this.loginPending;
    this.loginPending = this.login();
    try { return await this.loginPending; } finally { this.loginPending = null; }
  }

  async login() {
    const origin = this.origin;
    let credentials;
    try {
      this.available = (await this.credentials('status')).available === true;
      if (!this.available) return { ok: false, error: { code: 'PORTAL_AUTH_REQUIRED', message: 'Run the private local bootstrap, then call odc3_authenticate.', operatorAction: portalBootstrapCommand(origin) }, session: this.status() };
      credentials = await this.credentials('read');
      if (!credentials.available || !credentials.username || !credentials.password) fail('PORTAL_AUTH_REQUIRED', 'Managed credential entry is incomplete.');
      this.secrets = [credentials.username, credentials.password];
      this.authenticated = false;
      this.verifiedOperations.clear();
      await this.jar.removeAllCookies();
      const signal = AbortSignal.timeout(90000);
      const providers = await this.action('authentication', 'UnifiedAuthentication.login', 'authentication/UnifiedAuthentication/login/DataActionGetProviders', {}, {}, signal);
      if (providers.data?.CognitoEnabled === true && providers.data.CognitoConfig?.AuthFlow === 'USER_SRP_AUTH') {
        await this.nativeCognitoLogin(credentials, signal);
        credentials = null;
        return await this.confirmAuthentication(signal);
      }
      const redirect = providers.data?.RedirectNowUrl || providers.data?.AuthUrlExternalProvider;
      if (!redirect) fail('PORTAL_LOGIN_PROVIDER_UNSUPPORTED', 'Authentication provider did not supply a compatible redirect.');
      const loginUrl = await this.redirects(redirect, url => url.origin === 'https://id.outsystems.dev' && url.pathname.startsWith('/login'), signal);
      if (loginUrl.origin !== 'https://id.outsystems.dev' || !loginUrl.pathname.startsWith('/login')) fail('PORTAL_LOGIN_PROVIDER_UNSUPPORTED', 'OutSystems ID login was not reached.');
      const get = name => { const value = loginUrl.searchParams.get(name); if (!value) fail('PORTAL_CONTRACT_CHANGED', 'Login redirect parameters changed.'); return value; };
      const authorizationCode = get('authorization_code'), state = get('state'), clientId = get('client_id'), callback = new URL(get('redirect_uri'));
      if (!this.allowedOrigins.has(callback.origin)) fail('PORTAL_ORIGIN_DENIED', 'Authentication callback origin is not allowlisted.');
      this.secrets.push(authorizationCode, state);
      const result = await this.request('https://cognito-idp.eu-west-1.amazonaws.com/', { method: 'POST', signal,
        headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
        body: { AuthFlow: 'USER_PASSWORD_AUTH', ClientId: clientId, AuthParameters: { USERNAME: credentials.username, PASSWORD: credentials.password } } });
      credentials = null;
      if (result.status !== 200) fail('PORTAL_LOGIN_REJECTED', 'OutSystems ID did not accept this login; no retry performed.');
      let identity; try { identity = JSON.parse(result.text); } catch { fail('PORTAL_LOGIN_REJECTED', 'Invalid identity response.'); }
      if (identity.ChallengeName) fail('PORTAL_LOGIN_CHALLENGE_REQUIRED', 'This account requires an additional login challenge. No MFA/SSO bypass was attempted.');
      const tokens = identity.AuthenticationResult;
      if (!tokens?.AccessToken || !tokens.IdToken || !tokens.RefreshToken) fail('PORTAL_LOGIN_REJECTED', 'Identity response is incomplete.');
      this.secrets.push(tokens.AccessToken, tokens.IdToken, tokens.RefreshToken);
      const storage = await this.request('https://id.outsystems.dev/v1/storage', { method: 'POST', signal,
        headers: { Origin: 'https://id.outsystems.dev', Referer: loginUrl.href, 'User-Agent': 'MTSI.Web.UI' },
        body: { access_token: tokens.AccessToken, id_token: tokens.IdToken, refresh_token: tokens.RefreshToken, authorization_code: authorizationCode, stay_logged_in: false } });
      if (storage.status < 200 || storage.status > 299) fail('PORTAL_LOGIN_REJECTED', 'Identity session establishment failed.');
      callback.searchParams.set('code', authorizationCode); callback.searchParams.set('scope', 'openid server_api offline_access'); callback.searchParams.set('state', state);
      const complete = await this.redirects(callback.href, url => url.origin === origin && url.pathname.startsWith('/authentication/redirect') && url.searchParams.has('code'), signal);
      if (complete.origin !== origin || !complete.searchParams.get('code')) fail('PORTAL_LOGIN_REJECTED', 'Tenant authentication callback was not reached.');
      const code = complete.searchParams.get('code'), tenantState = complete.searchParams.get('state') ?? '';
      this.secrets.push(code, tenantState);
      await this.action('authentication', 'UnifiedAuthentication.redirect', 'authentication/UnifiedAuthentication/redirect/ActionProcessCodeRedirect',
        { Code: code, State: tenantState, IsFirstLogin: false, IsRest: false, BId: '' }, {}, signal);
      // A successful protected read, not cookie presence alone, establishes auth.
      return await this.confirmAuthentication(signal);
    } catch (error) { this.authenticated = false; return { ok: false, error: publicError(error), session: this.status() }; }
    finally { credentials = null; }
  }

  async confirmAuthentication(signal) {
    const proof = await this.action('connections', 'Connections.connections', 'connections/Connections/connections/DataActionGetProviders', {}, {}, signal);
    if (!Array.isArray(proof.data?.Providers) && !Array.isArray(proof.data?.Providers?.List)) fail('PORTAL_CONTRACT_CHANGED', 'Protected provider response did not match its expected schema.');
    this.authenticated = true; this.lastRead = { operation: 'connections.providers', at: new Date().toISOString() };
    return { ok: true, session: this.status() };
  }

  async nativeCognitoLogin(credentials, signal) {
    const origin = this.origin;
    const start = await this.action('authentication', 'UnifiedAuthentication.oslogin', 'authentication/UnifiedAuthentication/oslogin/DataActionGetRedirect', {}, {}, signal);
    if (!start.data?.Url || start.data.IsInvalidTenant || start.data.ExceptionCode) fail('PORTAL_LOGIN_PROVIDER_UNSUPPORTED', 'Portal did not provide a valid tenant login redirect.');
    const loginUrl = await this.redirects(start.data.Url, url => url.origin === origin && url.pathname === '/authentication/login', signal);
    const names = ['scope', 'state', 'response_type', 'client_id', 'redirect_uri', 'os_data1', 'os_data2', 'os_data3'];
    if (loginUrl.origin !== origin || loginUrl.pathname !== '/authentication/login' || !loginUrl.searchParams.get('client_id') || !loginUrl.searchParams.get('redirect_uri')) fail('PORTAL_CONTRACT_CHANGED', 'Expected tenant Cognito login parameters were not returned.');
    const variables = Object.fromEntries(names.map(name => [name, loginUrl.searchParams.get(name) ?? '']));
    this.secrets.push(variables.state, variables.os_data1, variables.os_data2, variables.os_data3);
    const configResponse = await this.action('authentication', 'UnifiedAuthentication.login', 'authentication/UnifiedAuthentication/login/DataActionGetProviders', {}, variables, signal);
    const config = configResponse.data?.CognitoConfig;
    if (!config) fail('PORTAL_LOGIN_PROVIDER_UNSUPPORTED', 'Cognito metadata is unavailable for this login.');
    const tokens = await this.cognito({ config, username: credentials.username, password: credentials.password,
      request: (url, options) => this.request(url, options), signal });
    this.secrets.push(tokens.AccessToken, tokens.IdToken, tokens.RefreshToken);
    const processed = await this.action('authentication', 'UnifiedAuthentication.login', 'authentication/UnifiedAuthentication/login/ActionProcessCognitoToken', {
      ClientId: variables.client_id, CognitoIdToken: tokens.IdToken, CognitoAccessToken: tokens.AccessToken,
      CognitoRefreshToken: tokens.RefreshToken, InfoEmail: credentials.username, InfoClientId: '', BId: '',
    }, variables, signal);
    if (!processed.data?.AuthCode) fail('PORTAL_LOGIN_REJECTED', 'Portal did not accept the Cognito authentication result.');
    this.secrets.push(processed.data.AuthCode);
    const callback = new URL(variables.redirect_uri);
    if (callback.origin !== origin) fail('PORTAL_ORIGIN_DENIED', 'Tenant callback must stay on the configured origin.');
    callback.searchParams.set('code', processed.data.AuthCode); callback.searchParams.set('state', variables.state);
    const complete = await this.redirects(callback.href, url => url.origin === origin && url.pathname.startsWith('/authentication/redirect') && url.searchParams.has('code'), signal);
    if (complete.origin !== origin || !complete.searchParams.get('code')) fail('PORTAL_LOGIN_REJECTED', 'Portal session callback was not reached.');
    this.secrets.push(complete.searchParams.get('code'), complete.searchParams.get('state') ?? '');
    await this.action('authentication', 'UnifiedAuthentication.redirect', 'authentication/UnifiedAuthentication/redirect/ActionProcessCodeRedirect', {
      Code: complete.searchParams.get('code'), State: complete.searchParams.get('state') ?? '', IsFirstLogin: false, IsRest: false, BId: '',
    }, {}, signal);
  }

  async readScreenservice(request) {
    if (request.target !== this.target || request.origin !== this.origin || request.readOnly !== true) fail('PORTAL_ACCESS_DENIED', 'Broker scope does not match.');
    if (!this.authenticated) fail('PORTAL_AUTH_REQUIRED', 'Call odc3_authenticate explicitly before protected Portal reads.');
    if (this.blockedOperations.has(request.operationId)) fail('PORTAL_CONTRACT_CHANGED', 'Current app-log/filter contract is mapped but still requires authenticated scoped validation; no legacy or agent-log fallback is allowed.');
    const expected = Object.hasOwn(PORTAL_READS, request.operationId) ? PORTAL_READS[request.operationId] : null;
    if (!expected || expected[0] !== request.module || expected[1] !== request.view || expected[2] !== request.action || expected[3] !== request.discoveryView) fail('PORTAL_ACCESS_DENIED', 'Internal operation is not allowlisted for this action/view.');
    const body = await this.action(request.module, request.view, request.action, request.inputParameters, request.screenVariables, request.signal, request.clientVariables, request.discoveryView ?? request.view);
    this.lastRead = { operation: request.operationId, at: new Date().toISOString() };
    return { target: this.target, origin: this.origin, body: redact(body, this.secrets) };
  }

  // Any listed route (portal-routes.mjs), read or write, with the raw screenservice input. A write that names secretRefs
  // (an external database account) is refused here, before anything is read or sent: a secret value never enters this
  // process (CONTRATO.md, wave 2 item 1); only the bridge reads it, inside the ODC Studio (studio-portal.mjs).
  async callScreenservice({ operationId, write = false, input, secretRefs = [], signal }) {
    if (!this.authenticated) fail('PORTAL_AUTH_REQUIRED', 'Authenticate the Portal session first (odc_portal_login).');
    const route = routeOf(operationId, write);
    if (secretRefs.length && !write) fail('INPUT_INVALID', 'secretRefs travel only with a write.');
    if (secretRefs.length) fail('STUDIO_REQUIRED', 'A secret value (external database account) goes only through the Portal window inside the ODC Studio, whose bridge reads it from the vault there; the vault Portal account path never holds it. Nothing was sent.');
    const answer = await this.action(route.module, route.view, route.action, input.inputParameters, input.screenVariables, signal, input.clientVariables, route.discoveryView);
    this.lastRead = { operation: operationId, at: new Date().toISOString() };
    return redact(answer, this.secrets);
  }
}

// RFC 6901 pointer into the screenservice body, e.g. /inputParameters/ValidStageConfigs/List/0/ConnectionDetails_Common/ConnectionPassword.
export function setPointer(target, pointer, value) {
  if (typeof pointer !== 'string' || !/^\/(inputParameters|screenVariables|clientVariables)\//.test(pointer)) fail('INPUT_INVALID', 'secretRefs pointers must start in inputParameters, screenVariables or clientVariables.');
  const parts = pointer.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'));
  let node = target;
  for (const part of parts.slice(0, -1)) { if (!node || typeof node !== 'object' || !(part in node)) fail('INPUT_INVALID', 'secretRefs pointer does not exist in the body.'); node = node[part]; }
  if (!node || typeof node !== 'object') fail('INPUT_INVALID', 'secretRefs pointer does not exist in the body.');
  node[parts.at(-1)] = value;
}

export async function createOdc3HostContext({ env = process.env, broker: suppliedBroker } = {}) {
  const origin = defaultOrigin;
  if (!origin) fail('PORTAL_TARGET_INVALID', 'No corporate tenant in tenants.json: this host has no verified ODC3 connection.');
  if (env.ODC_PORTAL_ORIGIN && env.ODC_PORTAL_ORIGIN !== origin) fail('PORTAL_TARGET_INVALID', 'Configured origin differs from the verified ODC3 connection (the corporate tenant of tenants.json).');
  const broker = suppliedBroker ?? new Odc3PortalBroker();
  await broker.initialize();
  return { target: 'odc3', origin, portalRead: new PortalReadAdapter({ target: 'odc3', origin, broker, timeoutMs: 30000 }),
    status: () => broker.status(), authenticate: () => broker.authenticate() };
}
