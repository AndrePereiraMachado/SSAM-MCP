// Tenant-aware access to the ODC public APIs and the internal Portal, with the authentication resolver of CONTRATO.md
// (per call, per tenant): the ODC Studio session first (bridge v32 portal-call / portal-session), then the credential in
// the Windows vault, and a private prompt only when no Studio is involved. Every read leaves a journal line; every
// write needs the user's words (only their sha256 is kept), an operationUuid, a receipt reserved before the send, the
// tenant guard, and is never resent: an uncertain outcome is reconciled by a read (odc_receipt).
// All collaborators are injected (lib.mjs wires the live ones; tests pass fakes of the bridge, vault and prompt).
import crypto from 'node:crypto';
import { prepareRequest } from './request.mjs';
import { fail, publicError, redact } from './errors.mjs';
import { DEPLOY, OPERATION_STATUS, TARGET_NAMES, effectOf, readable } from './effects.mjs';
import { isUuid, sha256 } from './write-journal.mjs';
import { withOperationLog } from './operation-log.mjs';
import { PortalReadAdapter } from './portal-read.mjs';
import { StudioPortalBroker } from './studio-portal.mjs';
import { PORTAL_READS, PORTAL_WRITES, checkSecretRefs, dbSecretTarget, envelope, rawInput, routeOf, routesModule, settingSecretTarget } from './portal-routes.mjs';

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TYPED_PORTAL_READS = new Set(['monitoring.stages', 'monitoring.applications', 'monitoring.logs', 'monitoring.errors', 'monitoring.detail',
  'monitoring.trace', 'monitoring.traceLogs', 'monitoring.traceSummary', 'monitoring.traces', 'connections.providers', 'connections.list']);
// Failures that prove the request never left: the receipt settles as not-sent and the target is free again.
const NOT_SENT = new Set(['STUDIO_BUSY', 'INPUT_INVALID', 'OPERATION_NOT_FOUND', 'WRITE_BLOCKED', 'AUTH_NOT_CONFIGURED', 'AUTH_FAILED', 'AUTH_DISCOVERY_FAILED',
  'AUTH_DISCOVERY_INVALID', 'AUTH_AUTHORITY_BLOCKED', 'AUTH_RESPONSE_INVALID', 'LOCAL_RATE_LIMIT', 'REQUEST_TOO_LARGE', 'CONTRACT_UNSUPPORTED',
  'CONTRACT_INVALID', 'CONFIGURATION_INVALID', 'STUDIO_NOT_SIGNED_IN', 'NOT_ALLOWED', 'BAD_REQUEST', 'HOST_MISMATCH', 'WEB_SIGN_IN_REQUIRED',
  'PORTAL_ORIGIN_DENIED', 'PORTAL_OPERATION_NOT_FOUND', 'PORTAL_ROUTE_UNMAPPED', 'DB_CREDENTIAL_REQUIRED', 'SECRET_IN_ARGUMENTS', 'STUDIO_REQUIRED']);
const PORTAL_NOT_SENT = new Set(['PORTAL_AUTH_REQUIRED', 'PORTAL_ACCESS_DENIED', 'PORTAL_CONTRACT_CHANGED']);
const ASSET_GET = 'asset-repository-api-v1:get:/assets/{assetKey}';
const ASSET_CONSUMERS = 'dependency-management-api-v1:get:/assets/{assetKey}/consumers';
const MAX_WAIT_SECONDS = 600;
// odc_portal_routes answers stay short: beyond these, truncated says so and next names view/match to narrow.
export const MAX_ROUTE_SCREENS = 80, MAX_ROUTE_ACTIONS = 120;
const pick = (object, keys) => Object.fromEntries(keys.filter(k => object?.[k] !== undefined && object[k] !== null && typeof object[k] !== 'object').map(k => [k, object[k]]));

// hosted (the SSAM server answering a customer, facade/executor.mjs): only the customer's ODC Studio session is a path.
// auth "api-client" and "portal-credential" are refused (HOSTED_STUDIO_SESSION_ONLY), "auto" means the Studio session,
// no prompt ever opens (HOSTED_PROMPT_UNAVAILABLE), and the vault of the server is never asked: a secret named by
// secretRefs is read by the customer's bridge from the customer's vault.
export class OdcAccess {
  constructor({ catalog, tenants, studio, vault, prompt, portalBroker, journal = () => {}, receipts, requestFile, policyOf = () => null,
    defaultTenant, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, maxRequestBytes = 8 * 1024 * 1024, hosted = false }) {
    Object.assign(this, { catalog, tenants: tenants ?? { tenants: {} }, studio, vault, prompt, portalBroker, journal, receipts, requestFile, policyOf, sleep, now, maxRequestBytes, hosted });
    this.defaultTenant = defaultTenant ?? this.tenants.default;
    this.studioBrokers = new Map(); this.prompts = new Map(); this.cached = null;
  }

  // ---- tenants and the Studio
  tenantInfo(host) {
    const entry = this.tenants.tenants?.[host];
    return { host, known: Boolean(entry), class: entry?.class ?? 'unknown', readOnly: entry?.readOnly === true, label: entry?.label ?? null };
  }
  async pickTenant(tenant) {
    if (tenant !== undefined) {
      const host = String(tenant).trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
      if (!HOST.test(host)) fail('INPUT_INVALID', 'tenant must be a host name such as personal-xxxx.outsystems.dev.');
      return host;
    }
    const signedIn = (await this.studioState()).sessions.filter(s => s.loggedIn);
    if (signedIn.length === 1) return signedIn[0].host;
    if (signedIn.length > 1) fail('TENANT_REQUIRED', 'The ODC Studio holds several sessions; pass tenant: ' + signedIn.map(s => s.host).join(', '));
    if (!this.defaultTenant) fail('TENANT_REQUIRED', 'Pass tenant.');
    return this.defaultTenant;
  }
  // The Studio as the facade sees it: running, bridge v32 answering auth-status, and its sessions per host (no secret).
  async studioState() {
    if (this.cached && this.now() - this.cached.at < 3000) return this.cached.value;
    let value;
    if (!(await this.studio.running().catch(() => false))) value = { running: false, connected: false, sessions: [], portalWindows: [] };
    else {
      try {
        const answer = await this.studio.call(['auth-status']);
        value = answer?.ok === true && Array.isArray(answer.sessions)
          ? { running: true, connected: true, bridge: answer.bridge ?? null, portalWindows: Array.isArray(answer.portalWindows) ? answer.portalWindows.map(w => pick(w, ['host', 'signedIn'])) : [],
              // The current v32 lists portal-call:secretRefs / portal-session:secretRefs; the first v32 has no capabilities.
              capabilities: Array.isArray(answer.capabilities) ? answer.capabilities.filter(c => typeof c === 'string').slice(0, 50) : [],
              sessions: answer.sessions.map(s => ({ host: String(s.host ?? '').toLowerCase(), loggedIn: s.loggedIn === true, user: s.user ?? s.email ?? null,
                tokenValidUntil: s.tokenValidUntil ?? null, ...(Array.isArray(s.permissions) ? { permissions: s.permissions.filter(p => typeof p === 'string').slice(0, 200) } : {}) })) }
          : { running: true, connected: false, sessions: [], portalWindows: [], hint: 'The attached bridge does not answer auth-status: attach bridge v32 or later (studio_attach).' };
      } catch { value = { running: true, connected: false, sessions: [], portalWindows: [], hint: 'The ODC Studio is open but its bridge did not answer: studio_attach (bridge v32 or later).' }; }
    }
    this.cached = { at: this.now(), value };
    return value;
  }
  session(state, host) { return state.sessions.find(s => s.host === host && s.loggedIn) ?? null; }

  // ---- resolver: public REST
  async resolvePublic(host, auth = 'auto') {
    if (!['auto', 'studio', 'api-client'].includes(auth)) fail('INPUT_INVALID', 'auth must be auto, studio or api-client.');
    if (this.hosted && auth === 'api-client') return hostedOnlyStudio(host, 'api-client');
    const studio = await this.studioState();
    const session = this.session(studio, host);
    if (this.hosted) return session ? { path: 'studio', host, user: session.user } : studioRefusal(studio, host, {}, true);
    if (auth !== 'api-client') {
      if (session) return { path: 'studio', host, user: session.user };
      if (auth === 'studio' || studio.running) {
        const vaultAvailable = await this.apiClientAvailable(host);
        return studioRefusal(studio, host, { vaultAvailable, ...(vaultAvailable ? { continuation: 'Repeat with auth:"api-client" to use the API Client stored in the vault.' } : {}) });
      }
    }
    if (await this.apiClientAvailable(host)) return { path: 'vault', host };
    if (session) return refusal('AUTH_NOT_CONFIGURED', 'No API Client in the vault for ' + host + '; the Studio session is the path for this tenant (auth:"auto").', { host });
    return this.openPrompt('api-client', host);
  }
  async apiClientAvailable(host) { return (await this.vault.apiClient(host).catch(() => ({ available: false })))?.available === true; }

  // ---- resolver: internal Portal
  async resolvePortal(host, auth = 'auto') {
    if (!['auto', 'studio', 'portal-credential'].includes(auth)) fail('INPUT_INVALID', 'auth must be auto, studio or portal-credential.');
    if (this.hosted && auth === 'portal-credential') return hostedOnlyStudio(host, 'portal-credential');
    const studio = await this.studioState();
    const session = this.session(studio, host);
    if (this.hosted && !session) return studioRefusal(studio, host, {}, true);
    if (auth !== 'portal-credential') {
      if (session) {
        const broker = this.studioBroker(host);
        const status = await broker.session('status').catch(error => ({ ok: false, code: error.code }));
        if (status?.ok === true && status.signedIn === true) return { path: 'studio-web', host, user: status.studioUser ?? session.user, broker };
        // The page probe can come back empty in a customer's ODC Studio (2026-10-08: window open and signed in, probe null,
        // only a page script error) — then nothing proves the window is NOT signed in, and the fetch itself is the proof:
        // a window that is not signed in answers the fetch with the sign-in redirect, refused as WEB_SIGN_IN_REQUIRED.
        if (status?.ok === true && status.windowOpen === true && status.signedIn !== true && status.page == null)
          return { path: 'studio-web', host, user: status.studioUser ?? session.user, broker, signedInUnverified: true };
        return status?.ok === true
          ? refusal('WEB_SIGN_IN_REQUIRED', 'The Studio Portal window of ' + host + ' is not signed in: call odc_portal_login {tenant:"' + host + '"} and sign in there once.',
            { host, continuation: { tool: 'odc_portal_login', arguments: { tenant: host }, why: 'Opens the Portal window inside the ODC Studio for the user to sign in once (SSO/MFA included); then repeat.' } })
          : refusal('PORTAL_WINDOW_UNAVAILABLE', 'The attached bridge has no Portal window (portal-session): attach bridge v32 or later.',
            { host, continuation: { tool: 'studio_attach', arguments: {}, why: 'Loads the newest bridge (v32 or later, with portal-session) into the ODC Studio; then repeat.' } });
      }
      if (auth === 'studio' || studio.running) {
        const credential = await this.portalCredentialAvailable(host);
        return studioRefusal(studio, host, { portalCredentialAvailable: credential, ...(credential ? { continuation: 'Repeat with auth:"portal-credential" to use the Portal account stored in the vault.' } : {}) });
      }
    }
    const broker = await this.vaultBroker(host);
    if (broker.available) {
      if (broker.authenticated) return { path: 'vault', host, broker };
      return refusal('PORTAL_AUTH_REQUIRED', 'The Portal session from the vault credential is not open: call odc_portal_login.',
        { host, continuation: { tool: 'odc_portal_login', arguments: { tenant: host, auth: 'portal-credential' }, why: 'Signs in with the Portal account stored in the vault; then repeat.' } });
    }
    if (session) return refusal('AUTH_NOT_CONFIGURED', 'No Portal account in the vault for ' + host + '; use the Studio Portal window (auth:"auto").', { host });
    return this.openPrompt('portal', host);
  }
  // Status only: whether the entry exists (Portal account, DB/<database> or Setting/<setting>), never its value.
  async portalCredentialAvailable(host, database, setting) { return (await this.vault.portal(host, database, setting).catch(() => ({ available: false })))?.available === true; }
  studioBroker(host) {
    if (!this.studioBrokers.has(host)) this.studioBrokers.set(host, new StudioPortalBroker({ host, bridge: args => this.studio.call(args), requestFile: json => this.requestFile(json) }));
    return this.studioBrokers.get(host);
  }
  async vaultBroker(host) {
    const broker = this.portalBroker(host);
    // Status only (never the secret); asked again while absent, so an entry typed in the prompt is seen next call.
    if (!broker.initializedAt || !broker.available) { await broker.initialize(); broker.initializedAt = this.now(); }
    return broker;
  }

  // The private prompt, at most one open per (kind, host) every two minutes; nothing typed there passes through here.
  async openPrompt(kind, host, database, setting) {
    if (this.hosted) return refusal('HOSTED_PROMPT_UNAVAILABLE', 'No credential prompt opens in hosted mode for ' + host + ': only what the user\'s own ODC Studio session '
      + '(and its vault, read by its bridge) already holds is used.', { host, kind });
    const key = kind + ':' + host + ':' + (database ?? '') + ':' + (setting ?? '');
    const last = this.prompts.get(key);
    if (last && this.now() - last < 120000) return refusal('CREDENTIAL_PROMPT_PENDING', 'A private credential prompt for ' + host + ' was opened less than two minutes ago; finish it, then repeat the call.', { host, kind });
    const opened = await (kind === 'api-client' ? this.prompt.apiClient(host) : this.prompt.portal(host, database, setting));
    if (!opened?.opened) return refusal('AUTH_NOT_CONFIGURED', 'No Studio session and no stored credential for ' + host + '; the private prompt could not be opened (' + (opened?.reason ?? 'unavailable') + ').', { host, kind, operatorAction: opened?.command ?? null });
    this.prompts.set(key, this.now());
    return refusal('CREDENTIAL_PROMPT_OPENED', 'A private Windows prompt is open for ' + host + ' (' + (kind === 'api-client' ? 'ODC API Client' : database ? 'external database ' + database : setting ? 'secret setting value ' + setting : 'Portal account') + '). The user types there, never in chat; repeat this call afterwards.',
      { host, kind, auth: { path: 'prompt', host } });
  }

  // ---- public REST
  async read({ tenant, auth = 'auto', operationId, ...input }) {
    const start = new Date(this.now()).toISOString();
    let host;
    try {
      host = await this.pickTenant(tenant);
      const { operation } = this.catalog.get(operationId);
      if (!readable(operation)) fail('WRITE_BLOCKED', 'This operation changes the tenant: use odc_write with the user\'s words.');
      prepareRequest(this.catalog, operationId, input, this.config(host));
      const resolved = await this.resolvePublic(host, auth);
      if (resolved.ok === false) return { ...resolved, operationId, tenant: host };
      const output = await this.send(host, resolved, operationId, input, { write: false });
      this.journal({ start, tool: 'portal', command: 'read ' + operationId, outcome: output.ok ? 'ok' : 'native_error', note: noteOf(host, resolved, output) });
      return { ...output, tenant: host, auth: authOf(resolved) };
    } catch (error) {
      this.journal({ start, tool: 'portal', command: 'read ' + operationId, outcome: 'error', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
      return { ok: false, operationId, ...(host ? { tenant: host } : {}), error: publicError(error) };
    }
  }

  // secretRefs, like portalWrite's, is not a tool argument: only configurations passes it, for secret setting values
  // (SSAM/ODC3/<host>/Setting/<name> at /settings/<i>/value), and only the Studio path (bridge portal-call) sends it.
  async write({ tenant, auth = 'auto', operationId, authorize, operationUuid, confirmTenant, ...input }, { secretRefs = [] } = {}) {
    const start = new Date(this.now()).toISOString();
    let host, receipt;
    try {
      host = await this.pickTenant(tenant);
      const info = this.tenantInfo(host);
      const { operation } = this.catalog.get(operationId);
      const effect = effectOf(operation, input.body);
      if (effect === 'read' || effect === 'search-post') fail('USE_ODC_READ', 'This operation does not change the tenant: use odc_read.');
      const policy = this.policyOf(host);
      if (policy && !policy.has(operationId)) fail('WRITE_BLOCKED', 'The tenant policy file does not list this operation.');
      const request = prepareRequest(this.catalog, operationId, input, this.config(host));
      const refs = checkSecretRefs(host, secretRefs, input.body, { kind: 'Setting' }).map(({ pointer, target, field }) => ({ pointer, target, field }));
      precheck(authorize, operationUuid);
      const identity = { kind: 'odc-public', tenant: host, operationId, target: { ...(input.path ?? {}), ...pick(input.body, ['assetKey', 'applicationKey', 'agentKey', 'environmentKey', 'key', 'name', 'email']) } };
      const existing = this.receipts.lookup(operationUuid, identity);
      if (existing) return answerExisting(existing, operationId, host);
      guardTenant(info, authorize, confirmTenant);
      const resolved = await this.resolvePublic(host, auth);
      if (resolved.ok === false) return { ...resolved, operationId, tenant: host, sent: false };
      if (refs.length && resolved.path !== 'studio') fail('STUDIO_REQUIRED', secretStudioRequired(host));
      if (effect === 'destructive') guardTarget(authorize, await this.targetNames(host, resolved, operation, input));
      const wordsSha256 = sha256(authorize);
      receipt = this.receipts.reserve({ operationUuid, identity, wordsSha256,
        plan: { method: request.method, path: request.url.pathname, query: request.url.search, bodySha256: input.body === undefined ? null : sha256(JSON.stringify(input.body)),
          ...(refs.length ? { secretRefs: refs } : {}) } });
      let output;
      // confirmTenant: the bridge v32 confirms every write host but the default one; the guard above already decided.
      try { output = await this.send(host, resolved, operationId, input, { write: true, operationUuid: receipt.operationUuid, authorizeSha256: wordsSha256, confirmTenant: host, secretRefs: refs }); }
      catch (error) { output = { ok: false, operationId, error: publicError(error), thrown: true }; }
      if (output.error) Object.assign(output, secretRefsHint(output.error, host));
      const state = outcomeOf(output);
      this.receipts.settle(receipt, { state, auth: resolved.path, status: output.status ?? null, errorCode: output.error?.code ?? null, response: pick(output.data, ['key', 'buildKey', 'analysisKey', 'operationKey', 'assetKey', 'status']) });
      this.journal({ start, tool: 'portal', command: 'write ' + operationId, outcome: state, note: noteOf(host, resolved, output) + ' words=sha256:' + wordsSha256.slice(0, 12) + ' receipt=' + receipt.operationUuid
        + (refs.length ? ' secretRefs=' + refs.length : '') });
      return { ...output, tenant: host, effect, auth: authOf(resolved), receipt: receiptOf(receipt),
        ...(refs.length ? { secretRefs: { count: refs.length, entries: [...new Set(refs.map(r => r.target))], resolvedBy: 'bridge, inside the ODC Studio' } } : {}),
        ...(state === 'uncertain' ? { reconcile: reconcileHint(operationId, host, receipt) } : {}) };
    } catch (error) {
      this.journal({ start, tool: 'portal', command: 'write ' + operationId, outcome: 'refused', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
      return { ok: false, operationId, ...(host ? { tenant: host } : {}), sent: false, error: publicError(error), ...(receipt ? { receipt: receiptOf(receipt) } : {}) };
    }
  }

  config(host) { return { origin: 'https://' + host, maxRequestBytes: this.maxRequestBytes }; }

  // One public request through the resolved path. The Studio path writes the request file of the contract
  // (portal-call) and maps the bridge answer to the OdcBridge shape; the vault path is the existing OdcBridge.
  async send(host, resolved, operationId, input, { write, operationUuid, authorizeSha256, confirmTenant, secretRefs = [] }) {
    if (resolved.path === 'vault') {
      if (secretRefs.length) fail('STUDIO_REQUIRED', secretStudioRequired(host));
      return (await this.vault.bridge(host)).execute(operationId, input, write ? 'write' : 'read');
    }
    const request = prepareRequest(this.catalog, operationId, input, this.config(host));
    let body, bodyBase64, contentType = request.headers['content-type'];
    if (request.body instanceof FormData) {
      const encoded = new Response(request.body);
      bodyBase64 = Buffer.from(await encoded.arrayBuffer()).toString('base64'); contentType = encoded.headers.get('content-type');
    } else if (Buffer.isBuffer(request.body)) bodyBase64 = request.body.toString('base64');
    else if (typeof request.body === 'string') body = JSON.parse(request.body);
    const file = this.requestFile({ operationId, apiId: request.api.id, method: request.method, basePath: request.api.basePath,
      path: request.url.pathname.slice(request.api.basePath.length), query: request.url.search.replace(/^\?/, ''),
      ...(contentType ? { contentType } : {}), ...(body !== undefined ? { body } : {}), ...(bodyBase64 ? { bodyBase64 } : {}),
      write, ...(write ? { operationUuid, authorizeSha256, confirmTenant } : {}), ...(write && secretRefs.length ? { secretRefs } : {}) });
    const answer = await this.studio.call(['portal-call', file, '--tenant', host]);
    return studioAnswer(answer, operationId, host);
  }

  // Names the user's words must contain to delete or undeploy: the target's own name (read first) or its key.
  async targetNames(host, resolved, operation, input) {
    const asset = operation.id === DEPLOY;
    const spec = asset ? { read: 'asset-repository-api-v1:get:/assets/{assetKey}', fields: ['name'] } : TARGET_NAMES[operation.id];
    const path = asset ? { assetKey: input.body?.assetKey } : input.path ?? {};
    const keys = asset ? [input.body?.assetKey] : Object.values(input.path ?? {}).slice(-1);
    const names = [];
    if (spec && Object.values(path).every(v => v !== undefined)) {
      const seen = await this.send(host, resolved, spec.read, { path }, { write: false }).catch(() => null);
      this.journal({ tool: 'portal', command: 'read ' + spec.read, outcome: seen?.ok ? 'ok' : 'native_error', note: '[' + host + '] target name before a destructive write' });
      if (seen?.ok) for (const field of spec.fields) if (typeof seen.data?.[field] === 'string' && seen.data[field]) names.push(seen.data[field]);
    }
    return [...names, ...keys.filter(k => typeof k === 'string' || typeof k === 'number').map(String)];
  }

  // ---- receipts: show one, or reconcile an uncertain one by a read the user confirms
  async receipt({ operationUuid, reconcile }) {
    if (!isUuid(operationUuid)) return { ok: false, error: { code: 'INPUT_INVALID', message: 'operationUuid must be a UUID.' } };
    const existing = this.receipts.lookup(operationUuid);
    if (!existing) return { ok: false, error: { code: 'RECEIPT_NOT_FOUND', message: 'No write with this operationUuid.' } };
    if (!reconcile) return { ok: true, receipt: receiptOf(existing), identity: existing.identity };
    try {
      const { state, read, authorize } = reconcile;
      if (typeof authorize !== 'string' || authorize.trim().length < 8) fail('AUTHORIZATION_REQUIRED', 'Reconciling a write needs the user\'s words that state what the read showed.');
      const tenant = existing.identity.tenant;
      const seen = existing.identity.kind === 'odc-portal' ? await this.portalRead({ tenant, ...read }) : await this.read({ tenant, ...read });
      if (!seen.ok) return { ok: false, error: { code: 'RECONCILE_READ_FAILED', message: 'The reconciliation read did not succeed; the receipt is unchanged.' }, read: seen };
      const settled = this.receipts.reconcile(existing, { state, observation: { operationId: read.operationId, status: seen.status ?? null,
        dataSha256: sha256(JSON.stringify(seen.data ?? seen.rows ?? null)), wordsSha256: sha256(authorize) } });
      return { ok: true, receipt: receiptOf(settled), read: seen };
    } catch (error) { return { ok: false, error: publicError(error), receipt: receiptOf(existing) }; }
  }

  // ---- internal Portal
  async portalRead({ tenant, auth = 'auto', operationId, input = {} }) {
    const start = new Date(this.now()).toISOString();
    let host;
    try {
      host = await this.pickTenant(tenant);
      routeOf(operationId, false);
      const resolved = await this.resolvePortal(host, auth);
      if (resolved.ok === false) return { ...resolved, operationId, tenant: host };
      let output;
      if (TYPED_PORTAL_READS.has(operationId)) {
        output = await new PortalReadAdapter({ target: 'odc3', origin: resolved.broker.origin, broker: resolved.broker, timeoutMs: 30000 }).execute({ operationId, input });
      } else output = envelope(operationId, await resolved.broker.callScreenservice({ operationId, write: false, input: rawInput(input) }));
      this.journal({ start, tool: 'portal', command: 'portal-read ' + operationId, outcome: output.ok ? 'ok' : 'native_error', note: '[' + host + '] auth=' + resolved.path + (output.ok ? '' : ' ' + (output.error?.code ?? '')) });
      return { ...output, tenant: host, auth: authOf(resolved) };
    } catch (error) {
      this.journal({ start, tool: 'portal', command: 'portal-read ' + operationId, outcome: 'error', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
      return { ok: false, operationId, ...(host ? { tenant: host } : {}), error: publicError(error) };
    }
  }

  // secretRefs is not a tool argument: only the typed helpers of this class pass it, naming vault entries
  // (SSAM/ODC3/<host>/DB/<name>) and the empty placeholders of the input they fill. Only the bridge reads the value,
  // inside the ODC Studio, for the Studio Portal window; any other path is refused before the reservation (CONTRATO.md,
  // wave 2 item 1: a secret value never passes through this process).
  async portalWrite({ tenant, auth = 'auto', operationId, input = {}, authorize, operationUuid, confirmTenant, target }, { secretRefs = [] } = {}) {
    const start = new Date(this.now()).toISOString();
    let host, receipt;
    try {
      host = await this.pickTenant(tenant);
      const info = this.tenantInfo(host);
      routeOf(operationId, true);
      const effect = PORTAL_WRITES[operationId].effect;
      const raw = rawInput(input);
      const refs = checkSecretRefs(host, secretRefs, raw);
      precheck(authorize, operationUuid);
      const identity = { kind: 'odc-portal', tenant: host, operationId, target: target ?? { inputSha256: sha256(JSON.stringify(raw.inputParameters)) } };
      const existing = this.receipts.lookup(operationUuid, identity);
      if (existing) return answerExisting(existing, operationId, host);
      guardTenant(info, authorize, confirmTenant);
      guardPortalTarget(effect, authorize, target);
      const resolved = await this.resolvePortal(host, auth);
      if (resolved.ok === false) return { ...resolved, operationId, tenant: host, sent: false };
      if (refs.length && resolved.path !== 'studio-web') fail('STUDIO_REQUIRED', secretStudioRequired(host));
      const wordsSha256 = sha256(authorize);
      const secrets = refs.length ? { count: refs.length, entries: [...new Set(refs.map(r => r.target))], resolvedBy: 'bridge, inside the ODC Studio' } : null;
      receipt = this.receipts.reserve({ operationUuid, identity, wordsSha256,
        plan: { operationId, inputSha256: sha256(JSON.stringify(raw)), secretRefs: refs.map(({ pointer, target: entry, field }) => ({ pointer, target: entry, field })) } });
      let output, state;
      try {
        const body = await resolved.broker.callScreenservice({ operationId, write: true, input: raw, secretRefs: refs.map(({ pointer, target: entry, field }) => ({ pointer, target: entry, field })),
          operationUuid: receipt.operationUuid, authorizeSha256: wordsSha256, confirmTenant: host });
        output = envelope(operationId, body); state = 'accepted';
      } catch (error) {
        const failure = publicError(error);
        // Without `sent`, the failure came before the POST (metadata, session, refusal by the window).
        state = failure.sent ? (failure.status >= 400 && failure.status < 500 ? 'rejected' : 'uncertain') : NOT_SENT.has(failure.code) || PORTAL_NOT_SENT.has(failure.code) ? 'not-sent' : 'uncertain';
        output = { ok: false, operationId, internalContract: true, error: failure, ...secretRefsHint(failure, host) };
      }
      this.receipts.settle(receipt, { state, auth: resolved.path, errorCode: output.error?.code ?? null, response: pick(output.data, ['Out_ConnectionId', 'ConnectionId', 'Key', 'Id']) });
      this.journal({ start, tool: 'portal', command: 'portal-write ' + operationId, outcome: state, note: '[' + host + '] auth=' + resolved.path + ' words=sha256:' + wordsSha256.slice(0, 12) + ' receipt=' + receipt.operationUuid
        + (secrets ? ' secretRefs=' + secrets.count : '') });
      return { ...output, tenant: host, effect, auth: authOf(resolved), receipt: receiptOf(receipt), ...(secrets ? { secretRefs: secrets } : {}),
        ...(state === 'uncertain' ? { reconcile: 'Read the target (odc_portal_read, e.g. connections.list) and settle with odc_receipt {operationUuid, reconcile}; never resend.' } : {}) };
    } catch (error) {
      this.journal({ start, tool: 'portal', command: 'portal-write ' + operationId, outcome: 'refused', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
      return { ok: false, operationId, ...(host ? { tenant: host } : {}), sent: false, error: publicError(error), ...(receipt ? { receipt: receiptOf(receipt) } : {}) };
    }
  }

  // odc_portal_routes: capture of an unmapped route for the live proof (PORTAL_GAPS). The screens and screenservice
  // actions a Portal module names in its own scripts, read through the same session as odc_portal_read (GETs only,
  // nothing called). The module is checked before any tenant, session or prompt is touched (never authentication,
  // identity or api). Short answer: {ok, tenant, module, view?, screens, actions:[{action, mapped}], truncated, next?}.
  async portalRoutes({ tenant, auth = 'auto', module, view, match }) {
    const start = new Date(this.now()).toISOString();
    let host;
    try {
      const name = routesModule(module);
      host = await this.pickTenant(tenant);
      const resolved = await this.resolvePortal(host, auth);
      if (resolved.ok === false) return { ...resolved, tenant: host };
      const found = await resolved.broker.metadata.routes(name, { view, match });
      const mapped = new Set([...Object.values(PORTAL_READS).map(r => r[2]), ...Object.values(PORTAL_WRITES).map(w => w.route[2])]);
      const actions = found.actions.slice(0, MAX_ROUTE_ACTIONS).map(action => ({ action, mapped: mapped.has(action) }));
      const truncated = found.truncated === true || found.actions.length > MAX_ROUTE_ACTIONS || found.screens.length > MAX_ROUTE_SCREENS;
      const next = [...(truncated ? ['More than shown: narrow with view (one screen) or match (part of the action name).'] : []),
        ...(actions.some(a => !a.mapped) ? ['Names only, nothing was called: an unmapped action enters portal-routes.mjs (PORTAL_WRITES, with its view) and is proven once with the user\'s words on a throwaway target of the personal tenant.'] : [])];
      this.journal({ start, tool: 'portal', command: 'portal-routes ' + name, outcome: 'ok', note: '[' + host + '] auth=' + resolved.path + ' actions=' + found.actions.length });
      return { ok: true, tenant: host, module: name, ...(view ? { view } : {}), screens: found.screens.slice(0, MAX_ROUTE_SCREENS), actions, truncated,
        ...(next.length ? { next: next.join(' ') } : {}) };
    } catch (error) {
      this.journal({ start, tool: 'portal', command: 'portal-routes ' + String(module ?? '').slice(0, 64), outcome: 'error', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
      return { ok: false, ...(host ? { tenant: host } : {}), error: publicError(error) };
    }
  }

  // Studio Portal window first (open it for the user to sign in once), then the vault Portal account, then the prompt.
  async portalLogin({ tenant, auth = 'auto', action = 'open' }) {
    try {
      const host = await this.pickTenant(tenant);
      if (!['open', 'status', 'close'].includes(action)) fail('INPUT_INVALID', 'action must be open, status or close.');
      if (this.hosted && auth === 'portal-credential') return hostedOnlyStudio(host, 'portal-credential');
      const studio = await this.studioState();
      const session = this.session(studio, host);
      if (this.hosted && !session) return studioRefusal(studio, host, {}, true);
      if (auth !== 'portal-credential' && session) {
        const answer = await this.studioBroker(host).session(action);
        if (answer?.ok !== true) return { ok: false, tenant: host, error: { code: answer?.code ?? 'PORTAL_WINDOW_UNAVAILABLE', message: 'The Studio Portal window did not answer (bridge v32 or later is required).' } };
        return { ok: true, tenant: host, auth: { path: 'studio-web', host, user: answer.studioUser ?? session.user }, window: pick(answer, ['opened', 'windowOpen', 'signedIn', 'closed', 'cookiesDeleted', 'cachePersistent', 'studioUser', 'instruction', 'pageError', 'lastPageError', 'signedInBasis']),
          ...(answer.page && typeof answer.page === 'object' ? { page: { origin: answer.page.origin ?? null, path: answer.page.path ?? null, ready: answer.page.ready ?? null, csrf: answer.page.csrf ?? null, csrfSource: answer.page.csrfSource ?? null, cookieNames: Array.isArray(answer.page.cookieNames) ? answer.page.cookieNames.slice(0, 40) : null } } : {}),
          next: answer.signedIn ? 'odc_portal_read / odc_portal_write now run in this window.' : action === 'open' ? 'The user signs in in the Portal window inside the ODC Studio (SSO/MFA included), then odc_portal_login {action:"status"}.' : undefined };
      }
      if (auth === 'studio' || (auth === 'auto' && studio.running)) {
        return studioRefusal(studio, host, { portalCredentialAvailable: await this.portalCredentialAvailable(host) });
      }
      const broker = await this.vaultBroker(host);
      if (action === 'status') {
        // The broker's own status names a local bootstrap command (operatorAction); here the same prompt is one call away.
        const { operatorAction, explanation, ...state } = safeSession(broker.status());
        return { ok: true, tenant: host, auth: { path: 'vault', host }, session: state, ...(broker.available ? {} : { continuation: { tool: 'odc_portal_login',
          arguments: { tenant: host, auth, action: 'open' }, why: 'No Portal account stored for ' + host + ': open asks for it in a private Windows prompt (the user types there, never in chat).' } }) };
      }
      if (action === 'close') { broker.authenticated = false; await broker.jar?.removeAllCookies?.(); return { ok: true, tenant: host, closed: true }; }
      if (broker.available) { const login = await broker.authenticate(); return { ...safeSession(login), tenant: host, auth: { path: 'vault', host } }; }
      if (session) return refusal('AUTH_NOT_CONFIGURED', 'No Portal account in the vault for ' + host + '; use the Studio Portal window (auth:"auto").', { host });
      return this.openPrompt('portal', host);
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  // ---- what each tenant would use right now, without prompting or sending anything
  async authStatus({ tenant } = {}) {
    const studio = await this.studioState();
    const hosts = tenant !== undefined ? [await this.pickTenant(tenant)]
      : [...new Set([...Object.keys(this.tenants.tenants ?? {}), ...studio.sessions.map(s => s.host)])];
    const entries = [];
    for (const host of hosts) {
      const session = this.session(studio, host);
      const window = studio.portalWindows.find(w => w.host === host) ?? null;
      const studioEntry = session ? { loggedIn: true, user: session.user, tokenValidUntil: session.tokenValidUntil, ...(session.permissions ? { permissions: session.permissions } : {}) } : null;
      const noSession = studio.connected ? 'STUDIO_NOT_SIGNED_IN' : 'STUDIO_NOT_CONNECTED';
      if (this.hosted) {
        // The vault columns: never read in hosted mode (only the customer's Studio session is a path).
        entries.push({ ...this.tenantInfo(host), studio: studioEntry, apiClient: { available: null, hosted: 'unavailable in hosted mode' },
          portal: { studioWindow: window, account: { available: null, hosted: 'unavailable in hosted mode' } },
          resolves: { public: session ? 'studio' : noSession, portal: session ? (window?.signedIn ? 'studio-web' : window ? 'studio-web (window open, sign-in not confirmed: the first Portal call proves it)' : 'WEB_SIGN_IN_REQUIRED') : noSession } });
        continue;
      }
      const apiClient = await this.apiClientAvailable(host);
      const portalAccount = await this.portalCredentialAvailable(host);
      entries.push({ ...this.tenantInfo(host), studio: studioEntry,
        apiClient: { available: apiClient, entry: 'SSAM/ODC3/' + host + '/APIClient' }, portal: { studioWindow: window, account: { available: portalAccount, entry: 'SSAM/ODC3/' + host + '/Portal' } },
        resolves: { public: session ? 'studio' : studio.running ? noSession : apiClient ? 'vault' : 'prompt',
          portal: session ? (window?.signedIn ? 'studio-web' : window ? 'studio-web (window open, sign-in not confirmed: the first Portal call proves it)' : 'WEB_SIGN_IN_REQUIRED') : studio.running ? noSession : portalAccount ? 'vault' : 'prompt' } });
    }
    return { ok: true, studio: { running: studio.running, connected: studio.connected, bridge: studio.bridge ?? null,
      ...(studio.connected ? { capabilities: studio.capabilities ?? [], secretRefs: (studio.capabilities ?? []).includes('portal-session:secretRefs') && (studio.capabilities ?? []).includes('portal-call:secretRefs') } : {}),
      ...(studio.hint ? { hint: studio.hint } : {}) },
      order: this.hosted ? 'Hosted: only the session of the user\'s own ODC Studio (bridge v32); no vault, API Client or prompt of the server. Writes always need the user\'s words.'
        : 'Studio session first (bridge v32), then the credential stored in the Windows vault, and a private prompt only when no Studio is open. Writes always need the user\'s words.',
      tenants: entries, secretsExposed: false };
  }

  // ---- typed helpers
  // One read per call, or a bounded wait until a terminal state; the start POST is never repeated.
  async operationStatus({ tenant, auth = 'auto', kind, operationKey, waitSeconds = 0, messages = false }) {
    const spec = OPERATION_STATUS[kind];
    if (!spec) return { ok: false, error: { code: 'INPUT_INVALID', message: 'kind must be one of ' + Object.keys(OPERATION_STATUS).join(', ') } };
    const deadline = this.now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_SECONDS) * 1000;
    let read, reads = 0;
    while (true) {
      read = await this.read({ tenant, auth, operationId: spec.read, path: { [spec.param]: operationKey } }); reads++;
      if (!read.ok || spec.terminal.includes(read.data?.[spec.field]) || this.now() >= deadline) break;
      await this.sleep(Math.min(5000, Math.max(deadline - this.now(), 0)));
    }
    if (!read.ok) return { ...read, kind, operationKey };
    const status = read.data?.[spec.field] ?? null, terminal = spec.terminal.includes(status);
    const log = messages && spec.messages ? await this.read({ tenant, auth, operationId: spec.messages, path: { [spec.param]: operationKey } }) : null;
    // publish, build and deployment also answer `log`: the messages in the shape of the Studio's publish-log (type, text,
    // element, stage) with counts, and a failed one the continuation that says what to fix (operation-log.mjs).
    return withOperationLog({ ok: true, tenant: read.tenant, auth: read.auth, kind, operationKey, status, terminal, failed: spec.failed.includes(status), reads, data: read.data,
      ...(log ? { messages: log.ok ? log.data : { error: log.error } } : {}),
      ...(terminal ? {} : { continuation: { tool: 'odc_operation_status', arguments: { tenant: read.tenant, kind, operationKey, waitSeconds: Math.max(Number(waitSeconds) || 0, 60) },
        why: 'Not terminal yet (' + status + '): follow it again; the POST that started it is never repeated.' } }) });
  }

  // Deploy (or undeploy, apply configs) between stages, then follow the operation to a terminal state.
  async deploy({ tenant, auth = 'auto', assetKey, environmentKey, revision, buildKey, operation = 'Deploy', authorize, operationUuid, confirmTenant, waitSeconds = 300 }) {
    const body = { operation, assetKey, environmentKey, ...(revision !== undefined ? { revision } : {}), ...(buildKey ? { buildKey } : {}) };
    const started = await this.write({ tenant, auth, operationId: DEPLOY, body, authorize, operationUuid, confirmTenant });
    const key = started.data?.key ?? started.receipt?.response?.key;
    if (!started.ok || !key || !waitSeconds) return { ...started, ...(started.ok && !key ? { warning: 'The answer carries no operation key; find it with odc_read deployments-api-v1:get:/deployment-operations.' } : {}) };
    const deployment = await this.operationStatus({ tenant: started.tenant, auth, kind: 'deployment', operationKey: key, waitSeconds, messages: true });
    if (!deployment.failed) return { ...started, deployment };
    // The deployment was accepted and ended in FinishedWithError: refused with every message and what to fix. The POST
    // is never repeated; a new deployment, after the fix, needs the user's words and a new operationUuid.
    return { ...started, ok: false, code: 'DEPLOYMENT_FAILED', sent: true, error: deployment.log?.summary ?? 'Deployment ' + key + ' ended in ' + deployment.status + '.',
      deployment, ...(deployment.continuation ? { continuation: deployment.continuation } : {}) };
  }

  // App, agent or stage configurations (settings, timers, integrations). set by name resolves keys from the current
  // configuration; a secret setting is never set from arguments: vaultSettings {Name: vault entry} names the entry
  // SSAM/ODC3/<host>/Setting/<entry> (typed by the user in the private prompt) and the bridge reads it inside the ODC
  // Studio right before the PATCH (portal-call secretRefs at /settings/<i>/value). The answer reads back what the
  // server now holds (a secret value is never compared: the server redacts it).
  async configurations({ tenant, auth = 'auto', action = 'get', scope = 'application', environmentKey, assetKey, revision, settings, vaultSettings, patch, authorize, operationUuid, confirmTenant }) {
    const ids = CONFIGURATIONS[scope];
    if (!ids) return { ok: false, error: { code: 'INPUT_INVALID', message: 'scope must be application, agent or environment.' } };
    const path = { environmentKey, ...(scope === 'environment' ? {} : { [ids.param]: assetKey }) };
    const get = () => this.read({ tenant, auth, operationId: scope !== 'environment' && revision !== undefined ? ids.revision : ids.get,
      path: { ...path, ...(scope !== 'environment' && revision !== undefined ? { baselineRevision: revision } : {}) } });
    if (action === 'get') return get();
    if (action !== 'set') return { ok: false, error: { code: 'INPUT_INVALID', message: 'action must be get or set.' } };
    let body = patch ? structuredClone(patch) : {};
    const secrets = vaultSettings && typeof vaultSettings === 'object' ? Object.entries(vaultSettings) : [];
    const secretRefs = [];
    let host;
    if (secrets.length) {
      try { host = await this.pickTenant(tenant); } catch (error) { return { ok: false, error: publicError(error) }; }
      for (const [name, entry] of secrets) if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(entry))) return { ok: false, error: { code: 'INPUT_INVALID', message: 'vaultSettings maps a setting name to its vault entry name SSAM/ODC3/<tenant>/Setting/<entry> ([A-Za-z0-9_.-], up to 64): ' + name } };
      // Before any prompt or read: only the Studio session sends a secretRefs PATCH (the bridge reads the vault there).
      if (auth === 'api-client' || !this.session(await this.studioState(), host)) return { ...refusal('STUDIO_REQUIRED', secretStudioRequired(host), { host }), sent: false };
      // Hosted the entry lives in the customer's vault: their bridge checks it (secret_ref_missing), never this server.
      if (!this.hosted) for (const [, entry] of secrets) {
        if (!(await this.portalCredentialAvailable(host, undefined, String(entry)))) return { ...(await this.openPrompt('portal', host, undefined, String(entry))), credentialEntry: settingSecretTarget(host, entry) };
      }
    }
    if ((settings && typeof settings === 'object') || secrets.length || (Array.isArray(body.settings) && body.settings.length)) {
      const current = await this.read({ tenant, auth, operationId: ids.get, path });
      if (!current.ok) return current;
      const known = Array.isArray(current.data?.settings) ? current.data.settings : [];
      body.settings = [...(body.settings ?? [])];
      // The raw patch never carries a secret value either.
      const raw = body.settings.find(s => known.find(k => k.key === s?.key)?.isSecret === true);
      if (raw) return { ok: false, error: { code: 'SECRET_IN_ARGUMENTS', message: 'A secret setting value is never a tool argument (patch.settings): store it in the private prompt and pass vaultSettings.', settingKey: raw.key } };
      for (const [name, value] of Object.entries(settings ?? {})) {
        const setting = known.find(s => s.name === name || s.key === name);
        if (!setting) return { ok: false, error: { code: 'SETTING_NOT_FOUND', message: 'No setting named ' + name + ' in the current configuration.' } };
        if (setting.isSecret) return { ok: false, error: { code: 'SECRET_IN_ARGUMENTS', message: 'A secret setting value is never a tool argument: store it in the private prompt and pass vaultSettings {"' + name + '": "<vault entry>"} (the bridge reads it inside the ODC Studio).', setting: name } };
        body.settings.push({ key: setting.key, value: String(value) });
      }
      for (const [name, entry] of secrets) {
        const setting = known.find(s => s.name === name || s.key === name);
        if (!setting) return { ok: false, error: { code: 'SETTING_NOT_FOUND', message: 'No setting named ' + name + ' in the current configuration.' } };
        // A vault value only goes to a setting the server keeps secret: anything else would come back in plain reads.
        if (setting.isSecret !== true) return { ok: false, error: { code: 'INPUT_INVALID', message: 'Setting ' + name + ' is not secret: pass its value in settings.' } };
        secretRefs.push({ pointer: '/settings/' + body.settings.length + '/value', target: settingSecretTarget(host, entry), field: 'password' });
        body.settings.push({ key: setting.key, value: '' });
      }
    }
    if (scope !== 'environment' && body.key === undefined) body = { key: assetKey, ...body };
    const written = await this.write({ tenant, auth, operationId: ids.patch, path, body, authorize, operationUuid, confirmTenant }, { secretRefs });
    if (!written.ok) return written;
    const after = await this.read({ tenant: written.tenant, auth, operationId: ids.get, path });
    const secretKeys = new Set(secretRefs.map(r => body.settings[Number(r.pointer.split('/')[2])].key));
    const expected = (body.settings ?? []).filter(s => !secretKeys.has(s.key)).map(s => ({ key: s.key, value: s.value,
      observed: (after.data?.settings ?? []).find(r => r.key === s.key) }));
    const nested = nestedConfigurations(body, after.data);
    const verified = after.ok && expected.length + nested.length > 0 && expected.every(e => e.observed && !e.observed.isSecret && String(e.observed.value) === String(e.value))
      && nested.every(e => e.observed && !e.observed.isSecret && (e.value === null ? /Default$/.test(e.observed.valueOrigin ?? '') : String(e.observed.value) === String(e.value)));
    let receipt = written.receipt;
    if (verified && receipt?.state === 'accepted') {
      this.receipts.reconcile(this.receipts.lookup(receipt.operationUuid), { state: 'confirmed', observation: { operationId: ids.get, readBack: true } });
      receipt = { ...receipt, state: 'confirmed' };
    }
    return { ...written, ...(receipt ? { receipt } : {}), readBack: after.ok ? { verified, settings: expected.map(e => ({ key: e.key, name: e.observed?.name ?? null, value: e.observed?.value ?? null })),
      ...(nested.length ? { configs: nested.map(e => ({ group: e.group, parent: e.parent, key: e.key, name: e.observed?.name ?? null,
        value: e.observed?.isSecret ? null : e.observed?.value ?? null, origin: e.observed?.valueOrigin ?? null })) } : {}),
      ...(secretKeys.size ? { vaultSettings: [...secretKeys].map(key => ({ key, present: Boolean((after.data?.settings ?? []).find(r => r.key === key)), valueVerified: false })) } : {}) } : { error: after.error } };
  }

  // DELETE /assets/{assetKey}: the words must name the asset (its name read first, or its key) and every consumer of it
  // (dependency-management GET /assets/{assetKey}/consumers, read before anything is reserved: an app or library that
  // would break is named by the user or nothing happens, CONSUMERS_WOULD_BREAK); a read afterwards confirms it is gone.
  async assetDelete({ tenant, auth = 'auto', assetKey, authorize, operationUuid, confirmTenant }) {
    const operationId = 'asset-repository-api-v1:delete:/assets/{assetKey}';
    // A repeated operationUuid answers its receipt through write(), with no new read.
    let existing = null;
    try { existing = isUuid(operationUuid) ? this.receipts.lookup(operationUuid) : null; } catch { existing = null; }
    if (!existing) {
      const start = new Date(this.now()).toISOString();
      let host;
      try {
        host = await this.pickTenant(tenant);
        precheck(authorize, operationUuid);
        guardTenant(this.tenantInfo(host), authorize, confirmTenant);
        const resolved = await this.resolvePublic(host, auth);
        if (resolved.ok === false) return { ...resolved, operationId, tenant: host, sent: false };
        const dependents = await this.dependentsOf(host, resolved, assetKey);
        if (!dependents.ok) return { ok: false, code: dependents.code, operationId, tenant: host, sent: false, error: { code: dependents.code, message: dependents.message } };
        const missing = dependents.consumers.filter(c => !namesWhole(authorize, c.name));
        if (missing.length) {
          this.journal({ start, tool: 'portal', command: 'write ' + operationId, outcome: 'refused', note: '[' + host + '] CONSUMERS_WOULD_BREAK ' + missing.length });
          const message = (dependents.name ?? assetKey) + ' has consumers that would break: ' + missing.map(c => c.name).join(', ') + '. Nothing was reserved or deleted.';
          return { ok: false, code: 'CONSUMERS_WOULD_BREAK', operationId, tenant: host, sent: false, error: { code: 'CONSUMERS_WOULD_BREAK', message },
            asset: { key: assetKey, name: dependents.name }, consumers: dependents.consumers.map(c => c.name),
            problems: missing.map(c => ({ code: 'CONSUMERS_WOULD_BREAK', target: c.name, message: c.name + ' consumes ' + (dependents.name ?? assetKey) + ' and would break.',
              fix: 'Repeat with words that also name ' + c.name + ' (the user\'s own words naming the asset and every consumer), or remove the dependency from ' + c.name + ' first.', ssamRule: true })) };
        }
      } catch (error) {
        this.journal({ start, tool: 'portal', command: 'write ' + operationId, outcome: 'refused', note: '[' + (host ?? '?') + '] ' + (error.code ?? 'error') });
        return { ok: false, operationId, ...(host ? { tenant: host } : {}), sent: false, error: publicError(error) };
      }
    }
    const deleted = await this.write({ tenant, auth, operationId, path: { assetKey }, authorize, operationUuid, confirmTenant });
    if (!deleted.ok || deleted.existingReceipt) return deleted;
    const after = await this.read({ tenant: deleted.tenant, auth, operationId: 'asset-repository-api-v1:get:/assets/{assetKey}', path: { assetKey } });
    const gone = !after.ok && after.status === 404;
    if (gone) this.receipts.reconcile(this.receipts.lookup(deleted.receipt.operationUuid), { state: 'confirmed', observation: { operationId: 'asset-repository-api-v1:get:/assets/{assetKey}', status: 404 } });
    return { ...deleted, readBack: { gone, status: after.status ?? null } };
  }

  // The asset's name and the apps and libraries that consume it, both read with the resolved session before anything
  // that depends on them. An unreadable consumers answer is DEPENDENCY_CHECK_UNAVAILABLE: nothing is deleted blind.
  async dependentsOf(host, resolved, assetKey) {
    const asset = await this.send(host, resolved, ASSET_GET, { path: { assetKey } }, { write: false }).catch(() => null);
    const consumers = await this.send(host, resolved, ASSET_CONSUMERS, { path: { assetKey } }, { write: false }).catch(() => null);
    this.journal({ tool: 'portal', command: 'read ' + ASSET_CONSUMERS, outcome: consumers?.ok ? 'ok' : 'native_error', note: '[' + host + '] consumers before a destructive write' });
    if (!consumers?.ok || !Array.isArray(consumers.data?.results))
      return { ok: false, code: 'DEPENDENCY_CHECK_UNAVAILABLE', message: 'The consumers of ' + assetKey + ' could not be read (' + (consumers?.status ?? consumers?.error?.code ?? 'no answer')
        + '); nothing was reserved or sent. Repeat once the dependency read answers.' };
    const name = asset?.ok && typeof asset.data?.name === 'string' && asset.data.name ? asset.data.name : null;
    const seen = new Set(), list = [];
    for (const row of consumers.data.results) {
      if (typeof row?.name !== 'string' || !row.name || row.key === assetKey || seen.has(row.name.toLowerCase())) continue;
      seen.add(row.name.toLowerCase());
      list.push({ name: row.name, key: row.key ?? null, type: row.type ?? null, revision: row.revision ?? null });
    }
    return { ok: true, name, consumers: list };
  }

  // External database connections through the internal Portal (Connections app). The database account lives in the
  // vault entry SSAM/ODC3/<host>/DB/<name> and reaches the request only inside the session that sends it (secretRefs).
  async externalDbConnection(input) {
    const { tenant, auth = 'auto', action } = input;
    let host;
    try {
      host = await this.pickTenant(tenant);
      if (action === 'providers') return this.portalRead({ tenant: host, auth, operationId: 'connections.providers' });
      if (action === 'list') return this.portalRead({ tenant: host, auth, operationId: 'connections.list' });
      if (action === 'delete') return this.dbDelete(host, auth, input);
      if (action === 'entities') return this.dbEntities(host, auth, input);
      if (action === 'test' || action === 'create') return this.dbTestOrCreate(host, auth, input);
      if (action === 'import-entities') return this.dbImport(host, auth, input);
      fail('INPUT_INVALID', 'action must be providers, list, entities, test, create, import-entities or delete.');
    } catch (error) { return { ok: false, ...(host ? { tenant: host } : {}), error: publicError(error) }; }
  }

  // W17 entry point (portal-routes.mjs, step 4). Until connections.delete is captured, routeOf refuses it as
  // PORTAL_ROUTE_UNMAPPED with the capture step (odc_portal_routes). Once it is in PORTAL_WRITES (destructive), this
  // reads the connection (connections.connection) for its name and calls portalWrite with target {connectionId,
  // connectionName}, then confirms by connections.list; the captured input shape is not known before W17. Synchronous
  // throw on purpose: externalDbConnection's catch turns it into the coded refusal.
  dbDelete() {
    routeOf('connections.delete', true);
    fail('HELPER_NOT_WIRED', 'connections.delete is in PORTAL_WRITES but the typed delete (connection name read first, words naming it, list read back) is not wired yet.');
  }

  async dbEntities(host, auth, { connectionId }) {
    if (!connectionId) fail('INPUT_INVALID', 'connectionId is required.');
    const screenVariables = elementVariables(connectionId);
    const connection = await this.portalRead({ tenant: host, auth, operationId: 'connections.connection', input: { screenVariables } });
    if (!connection.ok) return connection;
    const entities = await this.portalRead({ tenant: host, auth, operationId: 'connections.entities', input: { screenVariables } });
    const selected = await this.portalRead({ tenant: host, auth, operationId: 'connections.selectedEntities', input: { screenVariables } });
    return { ok: entities.ok, tenant: host, auth: connection.auth, connection: connection.data, available: listOf(entities.data?.EntityList).map(e => pick(e, ['EntityId', 'Id', 'OriginalName', 'Name', 'IsView', 'ObjectType'])),
      selected: listOf(selected.data?.SelectedEntityList_Original).map(e => pick(e, ['OriginalName', 'Name'])), ...(entities.ok ? {} : { error: entities.error }) };
  }

  async dbTestOrCreate(host, auth, input) {
    const { name, providerId, server, port, database, description = '', additionalParameters = '', privateGateway = false, privateGatewayPort, stageKey,
      credential = name, authorize, operationUuid, confirmTenant, waitSeconds = 60 } = input;
    for (const [field, value] of Object.entries({ name, providerId, server, port, database })) if (value === undefined || value === '') fail('INPUT_INVALID', field + ' is required.');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(String(credential))) fail('INPUT_INVALID', 'credential names the vault entry SSAM/ODC3/<tenant>/DB/<credential> ([A-Za-z0-9_.-], up to 64).');
    if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) fail('INPUT_INVALID', 'port must be 1..65535.');
    // The database account is typed by the user in a private prompt, once, and this process only asks whether the entry
    // exists. Only the bridge reads it, inside the ODC Studio signed in to the tenant (the Portal window path): with no
    // Studio session (or auth:"portal-credential") the write is refused before any prompt, reservation or send.
    if (auth === 'portal-credential' || !this.session(await this.studioState(), host)) return { ...refusal('STUDIO_REQUIRED', secretStudioRequired(host), { host }), sent: false };
    const entry = dbSecretTarget(host, credential);
    // Hosted the entry lives in the customer's vault: their bridge checks it (secret_ref_missing), never this server.
    if (!this.hosted && !(await this.portalCredentialAvailable(host, credential))) return { ...(await this.openPrompt('portal', host, String(credential))), credentialEntry: entry };
    const stages = await this.portalRead({ tenant: host, auth, operationId: 'monitoring.stages' });
    if (!stages.ok) return stages;
    const chosen = (stages.rows ?? []).filter(s => !stageKey || s.Key === stageKey);
    if (!chosen.length) fail('INPUT_INVALID', 'No visible stage' + (stageKey ? ' with key ' + stageKey : '') + '.');
    const configs = chosen.map(stage => ({ ConnectionDetails_Common: { ConnectionUsername: '', ConnectionPassword: '', AdvancedConnectionString: additionalParameters,
      ConnectionServer: server, ConnectionServerPort: Number(port), ConnectionDatabase: database, IsPrivateGateway: Boolean(privateGateway), PrivateGatewayPort: privateGateway ? Number(privateGatewayPort) : 0 },
      TenantStage: { Key: stage.Key, Name: stage.Name, Purpose: stage.Purpose, Order: '0', Hosting: '' } }));
    const header = { ConnectionName: name, ConnectionDescription: description, PortfolioKey: '' };
    const variant = /-azure$/.test(providerId) ? 'azure' : /-aurora$/.test(providerId) ? 'aurora' : 'vanilla';
    const refs =(list, base) => list.flatMap((_, i) => [{ pointer: base + '/' + i + '/ConnectionDetails_Common/ConnectionUsername', target: entry, field: 'username' },
      { pointer: base + '/' + i + '/ConnectionDetails_Common/ConnectionPassword', target: entry, field: 'password' }]);
    // create = test + save, two receipts; the test's UUID derives from the create's, so a repeated create never re-tests.
    const testUuid = input.action === 'test' ? operationUuid : derivedUuid(operationUuid, 'test');
    const tested = await this.portalWrite({ tenant: host, auth, operationId: 'connections.relationalTest', authorize, operationUuid: testUuid, confirmTenant, target: { connectionName: name, step: 'test' },
      input: { inputParameters: { ConnectionId: '', ProviderId: providerId, ForceErrorOnStageKeys: '', IsEditConnection: false, ValidStageConfigs: { List: configs },
        ConnectionDetails_Header: header, EditedStageConfigs: { List: configs }, IsConfigChanged: true, Variant: variant } } },
      { secretRefs: [...refs(configs, '/inputParameters/ValidStageConfigs/List'), ...refs(configs, '/inputParameters/EditedStageConfigs/List')] });
    if (!tested.ok) return tested;
    const connectionId = tested.data?.Out_ConnectionId ?? tested.receipt?.response?.Out_ConnectionId;
    if (!connectionId) return { ...tested, ok: false, error: { code: 'PORTAL_CONTRACT_CHANGED', message: 'The connection test returned no connection id.' } };
    const status = await this.dbTestStatus(host, auth, connectionId, chosen, waitSeconds);
    if (input.action === 'test' || !status.ok) return { ...tested, connectionId, testStatus: status };
    const saved = await this.portalWrite({ tenant: host, auth, operationId: 'connections.relationalSave', authorize, operationUuid, confirmTenant, target: { connectionName: name, step: 'save' },
      input: { inputParameters: { ConnectionDetails: { ConnectionDetail_StageConfig: { List: configs }, ConnectionDetails_Header: header, NullValueHandling: NULL_HANDLING },
        ConnectionId: connectionId, ConnectionOriginalUpdateTimestamp: '1900-01-01T00:00:00', ProviderId: providerId, Variant: variant, ForceErrorOnMetadataStatus: false } } },
      { secretRefs: refs(configs, '/inputParameters/ConnectionDetails/ConnectionDetail_StageConfig/List') });
    if (!saved.ok) return { ...saved, connectionId, testStatus: status };
    const list = await this.portalRead({ tenant: host, auth, operationId: 'connections.list' });
    const created = (list.rows ?? []).find(row => row.ConnectionId === connectionId || row.Id === connectionId || row.Name === name || row.ConnectionName === name) ?? null;
    if (created && saved.receipt?.state === 'accepted') this.receipts.reconcile(this.receipts.lookup(saved.receipt.operationUuid), { state: 'confirmed', observation: { operationId: 'connections.list', found: true } });
    return { ...saved, connectionId, testStatus: status, readBack: { found: Boolean(created), connection: created } };
  }

  async dbTestStatus(host, auth, connectionId, stages, waitSeconds) {
    const deadline = this.now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_SECONDS) * 1000;
    while (true) {
      const read = await this.portalRead({ tenant: host, auth, operationId: 'connections.testStatus', input: { clientVariables: { ConnectionListSearchValue: '' },
        screenVariables: { InitDateTime: new Date(this.now()).toISOString().replace('T', ' ').slice(0, 19), ConnectionId: connectionId, _connectionIdInDataFetchStatus: 1,
          StageDetails: { List: stages.map(s => ({ Key: s.Key, Name: s.Name, Purpose: s.Purpose })) }, _stageDetailsInDataFetchStatus: 1 } } });
      if (!read.ok) return read;
      const rows = listOf(read.data?.Status?.Results).map(r => pick(r, ['StageKey', 'StageName', 'Status', 'ErrorMessage', 'Errorcode']));
      const failed = rows.filter(r => String(r.Status).toLowerCase() === 'error');
      if (failed.length) return { ok: false, results: rows, error: { code: 'CONNECTION_TEST_FAILED', message: String(failed[0].ErrorMessage ?? failed[0].Errorcode ?? 'connection test failed').slice(0, 500) } };
      if (rows.length && rows.every(r => String(r.Status).toLowerCase() === 'success')) return { ok: true, results: rows };
      if (this.now() >= deadline) return { ok: false, results: rows, error: { code: 'CONNECTION_TEST_PENDING', message: 'The test did not finish in time; read connections.testStatus again, never re-run the test automatically.' } };
      await this.sleep(Math.min(2000, Math.max(deadline - this.now(), 0)));
    }
  }

  // Selects (imports) relational objects of a connection: every attribute selected, the primary key as the server
  // reports it. Read back from the selected entities afterwards.
  async dbImport(host, auth, { connectionId, objects, authorize, operationUuid, confirmTenant }) {
    if (!connectionId || !Array.isArray(objects) || !objects.length) fail('INPUT_INVALID', 'connectionId and objects (table or view names) are required.');
    const screenVariables = elementVariables(connectionId);
    const connection = await this.portalRead({ tenant: host, auth, operationId: 'connections.connection', input: { screenVariables } });
    if (!connection.ok) return connection;
    const entities = await this.portalRead({ tenant: host, auth, operationId: 'connections.entities', input: { screenVariables } });
    if (!entities.ok) return entities;
    const available = new Map(listOf(entities.data?.EntityList).map(e => [e.OriginalName || e.Name, e]));
    const missing = objects.filter(o => !available.has(o));
    if (missing.length) fail('INPUT_INVALID', 'The connection does not expose: ' + missing.join(', '));
    const updates = [];
    for (const object of objects) {
      const attributes = await this.portalRead({ tenant: host, auth, operationId: 'connections.entityAttributes', input: { inputParameters: { ConnectionId: connectionId, EntityName: object }, screenVariables } });
      if (!attributes.ok) return attributes;
      const entity = available.get(object);
      updates.push({ EntityId: entity.EntityId ?? entity.Id ?? '', OriginalName: object, Name: entity.Name || object, Description: entity.Description ?? '', IsSelected: true,
        NullWriteBehavior: entity.NullWriteBehavior || connection.data?.NullWriteBehavior || 'ConvertNull', HasCustomNullWriteBehavior: Boolean(entity.HasCustomNullWriteBehavior),
        Attributes: { List: listOf(attributes.data?.AttributesList).map(a => ({ Id: a.AttributeId ?? a.Id ?? '', OriginalName: a.OriginalName || a.Name, Name: a.Name || a.OriginalName,
          Description: a.Description ?? '', IsSelected: true, ChangeStatus: a.ChangeStatus || 'Unchanged', DefaultValue: a.DefaultValue ?? '', HasCustomDefaultValue: Boolean(a.HasCustomDefaultValue),
          DataType: a.DataType ?? '', IsPrimaryKey: Boolean(a.IsPrimaryKey) })) } });
    }
    const saved = await this.portalWrite({ tenant: host, auth, operationId: 'connections.importEntities', authorize, operationUuid, confirmTenant, target: { connectionId, step: 'import' },
      input: { inputParameters: { ConnectionId: connectionId, DatabaseObjects: { Entities: { List: updates }, Actions: { List: [] } },
        ConnectionOriginalUpdateTimestamp: connection.data?.ConnectionUpdateTimestamp || '1900-01-01T00:00:00' }, screenVariables } });
    if (!saved.ok) return saved;
    const selected = await this.portalRead({ tenant: host, auth, operationId: 'connections.selectedEntities', input: { screenVariables } });
    const names = listOf(selected.data?.SelectedEntityList_Original).map(e => e.OriginalName || e.Name);
    const all = objects.every(o => names.includes(o));
    if (all && saved.receipt?.state === 'accepted') this.receipts.reconcile(this.receipts.lookup(saved.receipt.operationUuid), { state: 'confirmed', observation: { operationId: 'connections.selectedEntities', objects } });
    return { ...saved, readBack: { selected: names, allImported: all } };
  }
}

const CONFIGURATIONS = {
  application: { param: 'applicationKey', get: 'asset-configurations-api-v1:get:/environments/{environmentKey}/applications/{applicationKey}/revisions/deployed/configurations',
    revision: 'asset-configurations-api-v1:get:/environments/{environmentKey}/applications/{applicationKey}/revisions/{baselineRevision}/configurations',
    patch: 'asset-configurations-api-v1:patch:/environments/{environmentKey}/applications/{applicationKey}/configurations' },
  agent: { param: 'agentKey', get: 'asset-configurations-api-v1:get:/environments/{environmentKey}/agents/{agentKey}/revisions/deployed/configurations',
    revision: 'asset-configurations-api-v1:get:/environments/{environmentKey}/agents/{agentKey}/revisions/{baselineRevision}/configurations',
    patch: 'asset-configurations-api-v1:patch:/environments/{environmentKey}/agents/{agentKey}/configurations' },
  environment: { get: 'asset-configurations-api-v1:get:/environments/{environmentKey}/default-system-configurations',
    patch: 'asset-configurations-api-v1:patch:/environments/{environmentKey}/default-system-configurations' },
};
const NULL_HANDLING = { NullWriteBehavior: 'ConvertNull', Boolean: 'False', Date: '1900-01-01', Time: '00:00:00', DateTime: '1900-01-01 00:00:00', Integer: '0', LongInteger: '0', Decimal: '0.0', Text: '' };
const elementVariables = connectionId => ({ ConnectionId: connectionId, _connectionIdInDataFetchStatus: 1, Source: '', _sourceInDataFetchStatus: 1,
  ForceRefreshFail: false, _forceRefreshFailInDataFetchStatus: 1, ForceSupportBoth: false, _forceSupportBothInDataFetchStatus: 1 });
const listOf = value => Array.isArray(value) ? value : Array.isArray(value?.List) ? value.List : [];

// Timer, integration and library-setting values of a configuration patch, each with what the read-back holds under the
// same keys. A null value removes the override (live: the read-back shows the default origin again).
function nestedConfigurations(body, data) {
  const found = [];
  for (const [group, items] of [['timers', 'configs'], ['integrations', 'configs'], ['libraries', 'settings']]) {
    for (const item of Array.isArray(body?.[group]) ? body[group] : []) {
      const seen = (Array.isArray(data?.[group]) ? data[group] : []).find(x => x?.key === item?.key);
      for (const config of Array.isArray(item?.[items]) ? item[items] : []) {
        found.push({ group, parent: item.key, key: config?.key, value: config?.value ?? null,
          observed: (Array.isArray(seen?.[items]) ? seen[items] : []).find(x => x?.key === config?.key) });
      }
    }
  }
  return found;
}

function derivedUuid(uuid, purpose) {
  if (!isUuid(uuid)) return uuid;
  const h = sha256(uuid.toLowerCase() + ':' + purpose);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-8' + h.slice(17, 20) + '-' + h.slice(20, 32);
}
// Step 2 of the contract: a Studio is involved but cannot serve this tenant. Never a prompt here.
function studioRefusal(studio, host, extra, hosted = false) {
  return refusal(studio.connected ? 'STUDIO_NOT_SIGNED_IN' : 'STUDIO_NOT_CONNECTED',
    studio.connected ? 'The ODC Studio has no session on ' + host + ': the user signs in to that tenant in the Studio (its own login, SSO included); then repeat.'
      : studio.running ? (studio.hint ?? 'The ODC Studio is open but its bridge is not connected.')
      : hosted ? 'No ODC Studio of the user is open: the user opens it and signs in to ' + host + ' (in hosted mode the Studio session is the only path).'
      : 'No ODC Studio is open: open it and sign in to ' + host + ', or choose the vault credential.',
    { host, ...extra });
}
// Hosted: a path other than the customer's Studio session is never taken.
function hostedOnlyStudio(host, auth) {
  return refusal('HOSTED_STUDIO_SESSION_ONLY', 'auth:"' + auth + '" uses a credential of the SSAM server, which is never used in hosted mode: the call runs only through the session '
    + 'of the user\'s own ODC Studio (auth "auto" or "studio").', { host });
}
function refusal(code, message, extra = {}) { return { ok: false, code, error: { code, message }, ...extra }; }
function precheck(authorize, operationUuid) {
  if (typeof authorize !== 'string' || authorize.trim().length < 8) fail('AUTHORIZATION_REQUIRED', 'Writes need the user\'s own authorization words (authorize), quoted verbatim; only their sha256 is kept.');
  if (!isUuid(operationUuid)) fail('INPUT_INVALID', 'operationUuid must be a new UUID for this write; reuse it only to read the same receipt.');
}
// Tenant classes (tenants.json): personal = free for tests; corporate, client and unknown hosts need the user's
// explicit instruction for each operation; readOnly tenants refuse every write. Destructive writes need words that
// name the target.
export function guardTenant(info, authorize, confirmTenant) {
  if (info.readOnly) fail('TENANT_READ_ONLY', 'Tenant ' + info.host + ' is read-only in tenants.json; no write is sent.');
  if (info.class !== 'personal') {
    const label = info.host.split('.')[0].toLowerCase();
    if (confirmTenant !== info.host || !authorize.toLowerCase().includes(label)) {
      fail('CORPORATE_TENANT_GUARD', 'Tenant ' + info.host + ' (' + info.class + ') needs the user\'s explicit instruction for this operation: confirmTenant:"' + info.host + '" and words that name ' + label + '.');
    }
  }
}
// The words name a target as whole words, without case or accents; spaces of the name match any run of spaces
// ("OldApp2" does not name "OldApp"). The same rule as the facade's namesWhole (studio-create-app.mjs, D3).
export function namesWhole(words, name) {
  if (typeof words !== 'string' || typeof name !== 'string' || !name.trim()) return false;
  const fold = text => text.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const pattern = fold(name.trim()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp('(?<![\\p{L}\\p{N}_])' + pattern + '(?![\\p{L}\\p{N}_])', 'iu').test(fold(words));
}
export function guardTarget(authorize, names = []) {
  const words = authorize.toLowerCase();
  const candidates = names.filter(n => typeof n === 'string' && n.trim());
  if (!candidates.some(n => words.includes(n.toLowerCase()))) fail('DESTRUCTIVE_TARGET_NOT_NAMED', 'A destructive write needs the user\'s words to name its target: ' + (candidates.join(' | ') || 'its key'), { candidates });
}
// An internal route added to PORTAL_WRITES as destructive (e.g. the connection delete the live proof captures) names
// its target ({connectionName} or {connectionId}) and the words must contain it, as for the public deletes.
export function guardPortalTarget(effect, authorize, target) {
  if (effect !== 'destructive') return;
  guardTarget(authorize, Object.values(target ?? {}).filter(v => typeof v === 'string' || typeof v === 'number').map(String));
}
// A write that names secretRefs runs only where the bridge reads the vault inside the ODC Studio (CONTRATO.md, wave 2
// item 1). Refused before the reservation, so the same operationUuid stays free.
const secretStudioRequired = host => 'A secret value (external database account, secret setting) goes only through the ODC Studio signed in to ' + host
  + ' with bridge v32 (secretRefs): its bridge reads the vault entry inside the Studio. The vault and prompt paths never hold it; nothing was reserved or sent. '
  + 'Open the ODC Studio on this tenant, studio_attach, and for internal routes sign in to the Portal window once (odc_portal_login).';
// The bridge's own refusals of secretRefs (PortalCore.cs): nothing was reserved by it or sent.
function secretRefsHint(failure, host) {
  if (failure.gate === 'secret_refs_unsupported') return { hint: 'The attached v32 is the first build, which does not read the vault inside the ODC Studio (auth-status lists no portal-session:secretRefs / portal-call:secretRefs); nothing was sent. Attach the current v32 (studio_attach after the Studio restarts) and repeat with a new operationUuid.' };
  if (failure.gate === 'secret_ref_missing') return { hint: 'The vault entry named by secretRefs is missing or incomplete; nothing was sent. Repeat with a new operationUuid: the call opens the private prompt for the entry when it is absent (' + host + ').' };
  if (failure.gate === 'secret_ref_vault') return { hint: 'The Windows vault could not be read inside the ODC Studio; nothing was sent.' };
  return {};
}
// 2xx accepted; 4xx refused by the server (nothing applied); 5xx, transport loss and the bridge's UNCERTAIN may have applied.
function outcomeOf(output) {
  if (output.ok) return 'accepted';
  if (typeof output.status === 'number') return output.status >= 400 && output.status < 500 ? 'rejected' : 'uncertain';
  return !output.thrown && NOT_SENT.has(output.error?.code) ? 'not-sent' : 'uncertain';
}
// The bridge v32 answer (CONTRATO.md): UNCERTAIN wins over any status; a busy gate or a refusal was never sent;
// a 4xx write comes as REMOTE_ERROR with its status; big bodies come as a redacted file under journal\portal\downloads.
function studioAnswer(answer, operationId, host) {
  if (answer?.outcome === 'gate_refused') return { ok: false, operationId, error: { code: 'STUDIO_BUSY', gate: answer.gate ?? null, message: 'The Studio was busy; nothing was sent. Repeat later (a write with a new operationUuid).' } };
  if (answer?.ok === false && answer.code === 'UNCERTAIN') return { ok: false, operationId, ...(typeof answer.status === 'number' ? { status: answer.status } : {}),
    error: { code: 'UNCERTAIN', ...(answer.reason ? { reason: answer.reason } : {}), message: 'The request may have been applied; reconcile by a read, never resend.' } };
  if (answer?.host && String(answer.host).toLowerCase() !== host) return { ok: false, operationId, error: { code: 'HOST_MISMATCH', message: 'The Studio answered for another host.' } };
  if (typeof answer?.status !== 'number') {
    const code = typeof answer?.code === 'string' ? answer.code : 'STUDIO_BRIDGE_FAILED';
    return { ok: false, operationId, error: { code, ...(answer?.gate ? { gate: answer.gate } : {}), message: 'The Studio bridge refused or failed the request.' } };
  }
  const contentType = answer.contentType ?? '';
  const summary = (byteLength, digest) => ({ contentOmitted: true, mediaType: contentType, byteLength, sha256: digest, reason: 'Non-JSON response is not exposed to the model.' });
  let data = null;
  if (answer.body !== undefined) data = answer.body;
  else if (typeof answer.bodyBase64 === 'string') { const bytes = Buffer.from(answer.bodyBase64, 'base64'); data = summary(bytes.length, crypto.createHash('sha256').update(bytes).digest('hex')); }
  else if (typeof answer.text === 'string') data = summary(Buffer.byteLength(answer.text), crypto.createHash('sha256').update(answer.text).digest('hex'));
  else if (typeof answer.bodyFile === 'string') data = { file: answer.bodyFile, byteLength: answer.bytes ?? null, sha256: answer.sha256 ?? null, mediaType: contentType, reason: 'Large body written (redacted) by the bridge.' };
  else if (answer.bodyOmitted) data = { contentOmitted: true, mediaType: contentType, byteLength: answer.bytes ?? null, sha256: answer.sha256 ?? null, reason: 'Body above 16 MB was not read.' };
  const ok = answer.status >= 200 && answer.status < 300;
  return redact({ ok, operationId, status: answer.status, data,
    ...(!ok ? { error: { code: answer.status === 401 ? 'STUDIO_SESSION_REJECTED' : answer.status === 403 ? 'API_FORBIDDEN' : 'API_ERROR',
      message: answer.status === 401 ? 'The gateway did not accept the Studio session for this API family; repeat with auth:"api-client" if a vault API Client exists.'
        : answer.status === 403 ? 'The signed-in user is not authorized for this operation.' : 'The API returned an unsuccessful response.' } } : {}) });
}
const authOf = resolved => ({ path: resolved.path, host: resolved.host, ...(resolved.user ? { user: resolved.user } : {}) });
const noteOf = (host, resolved, output) => '[' + host + '] auth=' + resolved.path + ' status=' + (output.status ?? output.error?.code ?? '?');
const receiptOf = receipt => ({ operationUuid: receipt.operationUuid, state: receipt.state, file: receipt.receipt, createdAt: receipt.createdAt, updatedAt: receipt.updatedAt ?? null,
  ...(receipt.response ? { response: receipt.response } : {}), ...(receipt.reconciliations ? { reconciliations: receipt.reconciliations.length } : {}) });
function answerExisting(existing, operationId, host) {
  return { ok: existing.ok === true, operationId, tenant: host, existingReceipt: true, replayed: false, receipt: receiptOf(existing),
    ...(existing.state === 'uncertain' ? { reconcile: reconcileHint(operationId, host, existing) } : {}),
    message: existing.state === 'not-sent' || existing.state === 'rejected' ? 'This operationUuid already ended (' + existing.state + '); nothing was sent again. A new attempt needs a new operationUuid.'
      : 'This operationUuid was already used; nothing was sent again.' };
}
function reconcileHint(operationId, host, receipt) {
  const job = Object.entries(OPERATION_STATUS).find(([, spec]) => spec.start === operationId);
  return 'Never resend. Read the target (' + (job ? 'odc_read on the list of ' + job[0] + ' operations, then odc_operation_status' : 'odc_read of the affected resource') + ' on ' + host
    + '), then odc_receipt {operationUuid:"' + receipt.operationUuid + '", reconcile:{state, read, authorize}} with the user\'s words.';
}
function safeSession(value) {
  const clean = redact(value);
  for (const key of ['credentialConfigured', 'bootstrapRequired', 'authenticated', 'ok']) if (typeof value?.[key] === 'boolean') clean[key] = value[key];
  if (value?.session && typeof value.session === 'object') clean.session = safeSession(value.session);
  return clean;
}
