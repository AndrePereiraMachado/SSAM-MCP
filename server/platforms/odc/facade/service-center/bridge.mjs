// The connected Service Studio's Service Center verbs (port of kernel/scripts/service_center/bridge.py): sc_session,
// sc_api, sc_web and studio_login over the JSON-lines bridge (o11-bridge.mjs) with the controller authority key. The
// Studio's token, id_token and cookies never leave the Studio process; only projected business data comes back.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { o11LaneOf, authorityKeyPath } from '../o11-lane.mjs';
import { anvilRoot, o11Lane } from '../workspace.mjs';
import { LocalExecutor, contextLost, currentExecutor } from '../executor.mjs';
import { readConnection } from '../studio-session.mjs';
import { BridgeError, connectStudio } from './errors.mjs';
import { hostName } from './http.mjs';
import { canonicalUuid, falsyScalar } from './util.mjs';
import { readOptions } from '../read-budget.mjs';
import { withPrivateSessionHandoff } from '../../portal/runtime/private-session-pipe.mjs';
import {withPrivateCookieExchange} from './private-cookie-pipe.mjs';

export const VERBS = ['sc_session', 'sc_api', 'sc_web', 'studio_login'];
// SECRET_NOT_FOUND: a sc_web secretRefs (or login) entry is missing from the vault (the bridge names its target, never a value).
// Legacy error names remain readable, but runtime authentication uses headless HTTP only.
// WEB_SIGN_IN_NEEDS_LOGIN means the protected HTTP read did not prove an authenticated web session.
export const CODES = ['STUDIO_NOT_SIGNED_IN', 'WEB_SIGN_IN_REQUIRED', 'NOT_ALLOWED', 'HOST_MISMATCH', 'UNCERTAIN', 'REMOTE_ERROR', 'BAD_REQUEST', 'SECRET_NOT_FOUND',
  'WEB_LOGIN_REJECTED', 'WEB_SIGN_IN_INTERACTIVE', 'WEB_SIGN_IN_NEEDS_LOGIN', 'STUDIO_WINDOWLESS'];
// Retired capability names retained for compatibility checks; neither enables a UI fallback.
export const HIDDEN_LOGIN = 'sc_web:login';
export const STUDIO_SESSION = 'sc_web:studioSession';
// sc_api surfaces. integration-studio (IntegrationStudio.asmx, contract I2) only reads: a write there is refused here.
export const SURFACES = ['soap', 'server-api', 'sc-rest', 'integration-studio'];
export const READ_ONLY_SURFACES = ['integration-studio'];
// GetProperties can return opaque authentication material under this apparent
// configuration flag. Its name is not evidence that its value is public.
const SECRET_KEY = /pass(?:word|wd)|secret|token|cookie|authorization|connection_?string|credential|api_?key|activation_?code|HubServerSerial|^ForceSecureAlgorithmsInAuthentication$/i;

export function redactText(text) {
  return String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
    .replace(/\b(password|pwd|secret|token|access_token|id_token|refresh_token)(\s*[=:]\s*)[^;&\s,"']+/gi, '$1$2<redacted>')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<redacted-jwt>');
}

// Business data only: secret-named fields are masked whatever the bridge projected.
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const namedSecret = Object.entries(value).some(([k, v]) => /^(name|key|propertyName)$/i.test(k) && typeof v === 'string' && SECRET_KEY.test(v));
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
      (SECRET_KEY.test(k) || (namedSecret && /^(value|propertyValue)$/i.test(k))) && !falsyScalar(v) ? '<redacted>' : redact(v)]));
  }
  if (typeof value === 'string') return redactText(value);
  return value;
}

export function authorization(operationId, authorizeSha256) {
  const canonical = canonicalUuid(operationId === null || operationId === undefined ? '' : String(operationId));
  if (!canonical) throw new BridgeError('BAD_REQUEST', 'A write needs an operationId UUID', { write: true });
  if (!/^[0-9a-f]{64}$/.test(authorizeSha256 ?? '')) throw new BridgeError('BAD_REQUEST', "A write needs the sha256 of the user's authorization words", { write: true });
  return { operationId: canonical, authorizeSha256 };
}

// The request of the executor seam (o11.bridge): locally bridgeRequest on the port with the controller key, as before;
// hosted the customer's agent, with no port and no key from this server.
export async function seamRequest(target, method, params, options = {}) {
  const executor = currentExecutor();
  const { reply } = await executor.call('o11.bridge', executor.hosted
    ? { method, params: params ?? {}, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }
    : { method, params, timeoutMs: options?.timeoutMs, ...(options?.signal ? { signal: options.signal } : {}), port: target.port, authorization: target.authorization });
  return reply;
}

export class StudioBridge {
  constructor(port, keyFile, { pid = null, timeoutMs = null, request = seamRequest } = {}) {
    this.port = port; this.keyFile = keyFile; this.pid = pid; this.timeoutMs = timeoutMs; this.request = request;
    this.version = null; this.verbsCache = null; this.capabilitiesCache = null; this.serviceCenterCache = null;
    this.corporate = false; // a write to a corporate host passed auth.guardWrite (corporateInstruction)
  }

  async exchange(method, params, write = false, authenticated = true) {
    const budget = readOptions(method === 'sc_session' || method === 'studio_login' ? 'authentication' : 'transport');
    let authorizationKey;
    // Hosted the agent puts its own key: no key file is read here.
    if (authenticated && !currentExecutor().hosted) {
      try { authorizationKey = fs.readFileSync(this.keyFile, 'ascii').trim(); }
      catch { throw new BridgeError('NOT_ALLOWED', 'The local controller authority is unavailable; nothing was sent', { write }); }
    }
    const startedAt = Date.now();
    try {
      return await this.request({ port: this.port, ...(authorizationKey !== undefined ? { authorization: authorizationKey } : {}) }, method, params,
        budget.timeoutMs ? { timeoutMs: Math.min(this.timeoutMs ?? Infinity, budget.timeoutMs), signal: budget.signal }
          : this.timeoutMs ? { timeoutMs: this.timeoutMs } : {});
    } catch (error) {
      const allowed = new Set(['BRIDGE_TIMEOUT','BRIDGE_NOT_LISTENING','BRIDGE_TRANSPORT','BRIDGE_PROTOCOL','BRIDGE_NO_REPLY','BRIDGE_REPLY_TOO_LARGE','READ_DEADLINE_EXCEEDED','CANCELLED']);
      const transport = { code: allowed.has(error?.code) ? error.code : 'UNCLASSIFIED',
        method: /^[a-z_]{1,40}$/.test(method) ? method : 'unknown', elapsedMs: Math.max(0,Date.now()-startedAt) };
      if (error?.executed === false) throw new BridgeError('STUDIO_UNAVAILABLE', 'No bridge answers on the lane port; nothing was sent', { write, transport });
      if (write) throw new BridgeError('UNCERTAIN', 'The bridge connection broke after the write was sent; reconcile by a read, never repeat it', { write: true, transport });
      throw new BridgeError('STUDIO_UNAVAILABLE', 'The bridge connection broke during a read; nothing was changed', {transport});
    }
  }

  async ping() {
    let reply;
    try { reply = await this.exchange('ping', {}, false, false); } catch (error) { if (error instanceof BridgeError) return null; throw error; }
    const data = reply?.data ?? {};
    if (reply?.success !== true || data.bridge !== 'anvil' || !Number.isInteger(data.pid)) return null;
    return data;
  }

  async verbs() {
    if (this.verbsCache === null) {
      const reply = await this.exchange('bridge_manifest', {}, false, false);
      const data = reply?.success === true ? (reply.data ?? {}) : {};
      this.capabilitiesCache = new Set((data.capabilities ?? []).map(String));
      this.verbsCache = new Set([...(data.verbs ?? []), ...[...this.capabilitiesCache].map(c => c.split(':')[0])]);
      const catalog = data.serviceCenter;
      this.serviceCenterCache = catalog && typeof catalog === 'object' && !Array.isArray(catalog) ? catalog : null;
    }
    return this.verbsCache;
  }
  // The manifest's capability strings (sc_api:soap, sc_web, sc_web:secretRefs...).
  async capabilities() { await this.verbs(); return this.capabilitiesCache; }
  async supports() { const verbs = await this.verbs(); return VERBS.every(v => verbs.has(v)); }
  // The manifest's serviceCenter catalog (ScApi.Catalog: {soap, server-api, sc-rest, integration-studio?, closed}: the
  // operations this bridge sends), or null for a bridge that predates it.
  async serviceCenterCatalog() { await this.verbs(); return this.serviceCenterCache; }
  // The hosts the Studio is logged in to (sc_session without a host).
  async signedInHosts() {
    const reply = await this.verb('sc_session', {});
    const hosts = reply?.signedInHosts ?? reply?.result?.signedInHosts;
    return Array.isArray(hosts) ? hosts.filter(h => typeof h === 'string' && h).map(h => hostName(h)) : [];
  }

  async verb(method, params, write = false) {
    const reply = await this.exchange(method, params, write);
    let data = reply?.data;
    const isObject = data !== null && typeof data === 'object' && !Array.isArray(data);
    if (reply?.success === true && !(isObject && data.ok === false)) return isObject && data.ok === true ? data : { ok: true, result: data };
    // A failure carries the contract answer in data ({ok:false, code, message}) and executed:false when nothing left the
    // Studio; older bridges only have the error text.
    data = isObject ? data : {};
    let error = String(data.message || reply?.error || '');
    const executed = reply && Object.hasOwn(reply, 'executed') ? reply.executed : data.executed;
    let code = data.code || reply?.code;
    if (![...CODES, 'STUDIO_UNAVAILABLE'].includes(code)) {
      if (error.startsWith('Unknown method')) { code = 'STUDIO_BRIDGE_OUTDATED'; error = 'The loaded bridge has no ' + method + '; reconnect a new bridge version'; }
      else if (executed === false) code = 'NOT_ALLOWED';
      else code = CODES.find(c => error.includes(c)) ?? (write ? 'UNCERTAIN' : 'REMOTE_ERROR');
    }
    const extra = { write, executed };
    for (const k of ['status', 'fault', 'gate', 'signedInHosts', 'signInRequired', 'target', 'part', 'location', 'submitted', 'reentry', 'expired']) if (Object.hasOwn(data, k)) extra[k] = redact(data[k]);
    throw new BridgeError(code, redactText(error || code).slice(0, 500), extra);
  }

  session(host) { return this.verb('sc_session', { host: hostName(host) }); }
  async privateWeb(host, options, { principal, cookie, applyCookies, handoff = withPrivateSessionHandoff, cookieExchange = withPrivateCookieExchange } = {}) {
    host = hostName(host);
    // Hosted, the private transport (a local pipe and the server's vault) never crosses machines: refused before any call.
    if (currentExecutor().hosted)
      throw new BridgeError('HOSTED_STUDIO_SESSION_ONLY', 'The private Service Center HTTP transport is not available in hosted mode; only the user\'s Studio session is a path.',
        { write: Boolean(options?.write), executed: false });
    if (!(await this.capabilities()).has('sc_private_http:secretRefs'))
      throw new BridgeError('STUDIO_BRIDGE_OUTDATED', 'The selected bridge has no private headless HTTP transport.', { write: Boolean(options.write), executed: false });
    const { method, path: pagePath, form = null, accept = 'html', write = false, operationId, authorizeSha256, secretRefs = null } = options;
    if (!['GET', 'POST'].includes(method) || !String(pagePath ?? '').toLowerCase().startsWith('/servicecenter/'))
      throw new BridgeError('BAD_REQUEST', 'Private HTTP needs a Service Center GET/POST.', { write, executed: false });
    const request = { host, method, path: pagePath, form, accept,
      ...(write ? this.writeFields(operationId, authorizeSha256) : {}), ...(secretRefs?.length ? { secretRefs } : {}) };
    const requestJson = JSON.stringify(request);
    const requestSha256 = createHash('sha256').update(requestJson).digest('hex');
    if(typeof applyCookies==='function'){
      if(!(await this.capabilities()).has('sc_private_http:cookieUpdates'))
        throw new BridgeError('STUDIO_BRIDGE_OUTDATED','The selected bridge cannot preserve private server cookie updates.',{write:Boolean(options.write),executed:false});
      const url=new URL(pagePath,`https://${host}`).href;
      return cookieExchange({host,principal,requestSha256,cookie,url,applyCookies},contextPipeId=>
        this.verb('sc_private_http_cookie',{host,principal,requestJson,requestSha256,contextPipeId},write));
    }
    return handoff({ host, principal, requestSha256, cookie }, contextPipeId =>
      this.verb('sc_private_http', { host, principal, requestJson, requestSha256, contextPipeId }, write));
  }
  login(host) {
    hostName(host);
    throw new BridgeError('STUDIO_NOT_SIGNED_IN', 'The selected Studio must already be authenticated. Headless tools never open its login dialog.');
  }

  writeFields(operationId, authorizeSha256, target = null) {
    const fields = { write: true, ...authorization(operationId, authorizeSha256) };
    if (target) fields.target = target;
    // Set by the caller only after confirmHost and words naming the environment passed (auth.guardWrite).
    if (this.corporate) fields.corporateInstruction = true;
    return fields;
  }

  async api(host, surface, operation, args = null, { write = false, operationId = null, authorizeSha256 = null, target = null } = {}) {
    if (!SURFACES.includes(surface) || !/^[A-Za-z][A-Za-z0-9_-]{1,80}$/.test(operation ?? ''))
      throw new BridgeError('BAD_REQUEST', 'Unknown Service Center API surface or operation', { write });
    if (write && READ_ONLY_SURFACES.includes(surface))
      throw new BridgeError('BAD_REQUEST', `The ${surface} surface only reads; nothing was sent`, { write, executed: false });
    const params = { host: hostName(host), surface, operation, args: args ?? {} };
    if (write) Object.assign(params, this.writeFields(operationId, authorizeSha256, target));
    return this.verb('sc_api', params, write);
  }

  // reenter (login only): load the Service Center again even when the page on screen looks signed in (an expired window);
  // an older bridge ignores it and signs in as before. studioSession (login only, bridge with sc_web:studioSession): sign
  // in through the Studio's own session only, never the vault (WEB_SIGN_IN_NEEDS_LOGIN when the page asks for a login).
  async web(host, action, { method = null, path: pagePath = null, form = null, accept = null, write = false, operationId = null,
    authorizeSha256 = null, secretRefs = null, hidden = false, reenter = false, studioSession = false, credentialTarget = null, principal = null } = {}) {
    if (!['status', 'open', 'login', 'fetch', 'close'].includes(action)) throw new BridgeError('BAD_REQUEST', 'Unknown Service Center web action');
    const params = { host: hostName(host), action };
    if (action === 'open' && hidden) params.hidden = true;
    if (action === 'login' && reenter) params.reenter = true;
    if (action === 'login' && studioSession) params.session = 'studio';
    if (action === 'login' && credentialTarget)
      throw new BridgeError('HEADLESS_AUTH_UNAVAILABLE', 'The native HTTP transport cannot submit a credential profile for sign-in.');
    if (action === 'fetch') {
      if (!['GET', 'POST'].includes(method) || !String(pagePath ?? '').toLowerCase().startsWith('/servicecenter/'))
        throw new BridgeError('BAD_REQUEST', 'Studio web fetch needs GET/POST and a /ServiceCenter/ path', { write });
      Object.assign(params, { method, path: pagePath, accept: accept || 'html' });
      if (form !== null && form !== undefined) params.form = form;
      // A state-changing postback carries the same authorization fields as sc_api; reads go without them.
      if (write) Object.assign(params, this.writeFields(operationId, authorizeSha256));
      if (secretRefs?.length) {
        // Vault target names only: the Studio reads the values inside its own process right before the send.
        if (!write || form === null || form === undefined) throw new BridgeError('BAD_REQUEST', 'secretRefs go only on a write postback', { write });
        params.secretRefs = secretRefs.map(r => ({ pointer: r.pointer, target: r.target, field: r.field }));
      }
    }
    if (!(await this.capabilities()).has('sc_http:studioSession'))
      throw new BridgeError('STUDIO_BRIDGE_OUTDATED', 'Headless Service Center HTTP requires sc_http:studioSession; no window was opened.');
    return this.verb('sc_http', params, write && action === 'fetch');
  }
}

// The bridge of the Studio selected with ssam_connect on the O11 lane, or null when no bridge answers. The record is
// .local/connections/<lane>.json under the Anvil root; without one, the lane table port and the authority key folder.
// Hosted, the record is the executor's (readConnection: the customer's, with the relay port) and there is no fallback:
// without it STUDIO_NOT_CONNECTED; no connection file of this machine is read.
export async function locateStudioBridge({ root = anvilRoot, lane = null, env = process.env, timeoutMs = null, request = seamRequest } = {}) {
  const laneName = String(lane ?? env.ANVIL_LANE ?? o11Lane.lane ?? 'ss4').trim().toLowerCase();
  const executor = currentExecutor();
  if (!(executor instanceof LocalExecutor)) {
    const record = readConnection(root, laneName);
    if (!record) {
      if (!executor.hosted) throw contextLost('locateStudioBridge');
      throw new BridgeError('STUDIO_NOT_CONNECTED', 'No Service Studio of the user is connected to SSAM; run ssam_connect {lane:"o11"}',
        { continuation: connectStudio('the user\'s Service Studio is not connected; in hosted mode it is the only path') });
    }
    return pinged(new StudioBridge(record.port, null, { timeoutMs, request }), record);
  }
  const recordFile = path.join(root, '.local', 'connections', laneName + '.json');
  let record = null;
  if (fs.existsSync(recordFile)) {
    try { record = JSON.parse(fs.readFileSync(recordFile, 'utf8').replace(/^﻿/, '')); } catch { record = {}; }
    if (record?.ok !== true || !Number.isInteger(record.port) || !Number.isInteger(record.pid) || !path.isAbsolute(String(record.authorityDir ?? '')))
      throw new BridgeError('STUDIO_NOT_CONNECTED', 'Invalid Studio connection record; run ssam_connect {lane:"o11"}',
        { continuation: connectStudio('the connection record of the O11 lane is not valid') });
  }
  if (record?.serviceCenter && (record.serviceCenter.pid !== record.pid
      || record.serviceCenter.startedUtc !== record.startedUtc || !Number.isInteger(record.serviceCenter.port)
      || record.serviceCenter.port < 1024 || record.serviceCenter.port > 65535
      || !/^[a-f0-9]{64}$/.test(record.serviceCenter.sha256 ?? '')))
    throw new BridgeError('STUDIO_NOT_CONNECTED', 'The isolated Service Center revision does not match the selected Studio.');
  const [port, keyFile] = record ? [record.serviceCenter?.port ?? record.port, path.join(record.authorityDir, 'bridge.key')]
    : [o11LaneOf(laneName, { root, env }).bridge, authorityKeyPath({ env })];
  return pinged(new StudioBridge(port, keyFile, { timeoutMs, request }), record);
}
async function pinged(bridge, record) {
  const alive = await bridge.ping();
  if (!alive) return null;
  if (record && alive.pid !== record.pid)
    throw new BridgeError('STUDIO_NOT_CONNECTED', 'The Studio selected with ssam_connect is no longer the one on the bridge port; run ssam_connect {lane:"o11"} again',
      { continuation: connectStudio('another Studio answers on the bridge port') });
  if (record?.serviceCenter && (alive.revisionSha256 !== record.serviceCenter.sha256
      || alive.startedUtc !== record.serviceCenter.startedUtc))
    throw new BridgeError('STUDIO_NOT_CONNECTED', 'The isolated Service Center listener does not match its revision and process receipt.');
  bridge.pid = alive.pid; bridge.version = alive.version ?? null;
  return bridge;
}
