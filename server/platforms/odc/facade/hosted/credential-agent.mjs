// One account-bound boundary for private credentials. Only the agent owns its vault,
// authentication headers and cookies; no server helper is a fallback for this kind.
import { hostedContext } from '../executor.mjs';
import { AuthRequired, BridgeError } from '../service-center/errors.mjs';
import { StudioPortalBroker } from '../../portal/runtime/studio-portal.mjs';
import { CREDENTIAL_CODES } from '../refusal-codes.mjs';
import { readCheckpoint, readOptions } from '../read-budget.mjs';
import { PortalMetadata } from '../../portal/runtime/portal-metadata.mjs';
import { publicPortalMetadata } from './portal-public-metadata.mjs';

export const CREDENTIAL_KIND = 'credential.session';
export const CREDENTIAL_UPDATE = 'Update the SSAM Agent from https://dist.ssam.pro/u/ssam-agent and repeat this call. No server credential was used.';
const MAX_BODY = 24 * 1024 * 1024;
const PROFILE = /^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const REDACTION_NOTE = 'Sensitive authentication values were removed from the response.';
const PRIVATE_NOTES = [REDACTION_NOTE, 'Response text encoding was normalized to UTF-8.', 'Response redirect metadata was normalized or withheld to preserve the approved origin.', 'Response content type was normalized to a recognized media type and charset.'];
const collectNotes = (target, notes) => { for (const note of notes ?? []) if (!target.includes(note)) target.push(note); };
const failure = (code, message, executed = false) => Object.assign(new BridgeError(code, message, { executed }), { executed });
const CODES = new Set([...CREDENTIAL_CODES, 'PARAMS_INVALID', 'HOST_MISMATCH', 'UNCERTAIN', 'AGENT_NOT_CONNECTED', 'AGENT_TIMEOUT', 'AGENT_DISCONNECTED', 'AGENT_BUSY', 'HOSTED_LANE_OFF']);
const safeCode = value => CODES.has(value) ? value : 'CREDENTIAL_AGENT_FAILED';
const safeProfile = value => typeof value === 'string' && PROFILE.test(value) ? value : null;
const cache = new WeakMap();

export function credentialAgent(context = hostedContext()) {
  if (!context) return null;
  if (!cache.has(context)) cache.set(context, new CredentialAgent(context));
  return cache.get(context);
}
export class CredentialAgent {
  constructor(context) { this.context = context; }
  get supported() { try { return this.context.agent?.supports?.(CREDENTIAL_KIND) === true; } catch { return false; } }
  async profile(host, service, target, principal = null) {
    const state = await this.call(host, service, 'status');
    const candidates = [...state.profiles, ...(state.profile ? [{ profile: state.profile, principal: state.principal }] : [])];
    const selected = candidates.find(p => p.profile === target && (!principal || p.principal?.toLowerCase() === principal.toLowerCase()));
    if (!selected) throw new AuthRequired('CREDENTIAL_PROFILE_MISMATCH', 'The requested profile is not available for this host and principal on the SSAM Agent.');
    return selected.profile;
  }
  async call(host, service, op, extra = {}) {
    const stage = op === 'request' ? 'transport' : 'authentication';
    readCheckpoint(stage);
    if (!this.supported) throw failure(op === 'prompt' ? 'HOSTED_PROMPT_UNAVAILABLE' : 'HOSTED_STUDIO_SESSION_ONLY', CREDENTIAL_UPDATE);
    const lane = service === 'service-center' ? 'o11' : 'odc';
    if (Array.isArray(this.context.lanes) && !this.context.lanes.includes(lane)) throw failure('HOSTED_LANE_OFF', 'This lane is disabled for the account. Nothing was sent.');
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host ?? '')) throw failure('PARAMS_INVALID', 'A plain host name is required.');
    if (extra.profile && !safeProfile(extra.profile)) throw failure('CREDENTIAL_PROFILE_MISMATCH', 'A profile identifier from this agent is required.');
    let value;
    const budget = readOptions(stage);
    try { value = await this.context.agent.call(CREDENTIAL_KIND, { host, service, op, auth: 'credential', ...extra }, { ...budget, timeoutMs: Math.min(op === 'login' ? 90000 : 30000, budget.timeoutMs ?? Infinity) }); }
    catch (error) { throw failure(safeCode(error?.code), 'The private credential operation failed on the SSAM Agent. No automatic retry was sent.', error?.executed === false ? false : null); }
    if (value?.ok === false) throw failure(safeCode(value.code), 'The private credential operation was refused by the SSAM Agent. Nothing was retried.', value.executed === false ? false : null);
    // Never forward arbitrary agent errors, headers or object properties.
    if (op === 'request') {
      const body = value?.body;
      if (typeof body !== 'string' || body.length > MAX_BODY || body.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body))
        throw failure('CREDENTIAL_AGENT_RESPONSE_INVALID', 'The SSAM Agent returned an invalid or oversized private response.');
      let url, requested;
      try { url = new URL(value.url || extra.url); requested = new URL(extra.url); }
      catch { throw failure('CREDENTIAL_AGENT_RESPONSE_INVALID', 'The SSAM Agent returned an invalid private response URL.'); }
      if (url.origin !== requested.origin || url.username || url.password) throw failure('HOST_MISMATCH', 'The private response left the requested host.');
      return { status: Number.isInteger(value.status) ? value.status : 0, body, contentType: typeof value.contentType === 'string' ? value.contentType.slice(0, 200) : '', url: url.href,
        ...(Array.isArray(value.notes) ? { notes: PRIVATE_NOTES.filter(note => value.notes.includes(note)) } : {}) };
    }
    return { ok: true, available: value?.available === true, authenticated: value?.authenticated === true,
      opened: value?.opened === true, visible: value?.visible === true, alreadyOpen: value?.alreadyOpen === true,
      saved: value?.saved === true, ...(safeProfile(value?.profile) ? { profile: value.profile } : {}),
      ...(typeof value?.principal === 'string' ? { principal: value.principal.slice(0, 320) } : {}),
      profiles: Array.isArray(value?.profiles) ? value.profiles.filter(p => safeProfile(p?.profile) && typeof p.principal === 'string')
        .slice(0, 100).map(p => ({ profile: p.profile, principal: p.principal.slice(0, 320) })) : [] };
  }
  async resolve(host, service, { auth = 'credential', prompt = 'auto', login = true, authenticate = true, profile = null, principal = null } = {}) {
    const extra = { auth, ...(profile ? { profile } : {}) };
    let status = await this.call(host, service, 'status', extra);
    // The default selection identifies a profile, not a session-key alias.
    // Re-check its explicit session so login, reuse and requests share one key.
    if (!profile && status.available && safeProfile(status.profile)) {
      extra.profile = status.profile;
      status = await this.call(host, service, 'status', extra);
    }
    if (principal && status.principal && principal.toLowerCase() !== status.principal.toLowerCase())
      throw new AuthRequired('CREDENTIAL_PROFILE_MISMATCH', 'The private profile belongs to another principal. Select a compatible profile explicitly.');
    if (!status.available) {
      if (prompt === 'never' || !login) throw new AuthRequired('AUTH_REQUIRED', 'No private credential is available on the SSAM Agent.');
      const window = await this.call(host, service, 'prompt', extra);
      if (!window.visible) throw new AuthRequired('CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE', 'The private credential window was not confirmed visible.');
      throw new AuthRequired('CREDENTIAL_PROMPT_PENDING', 'Enter the credential in the private SSAM Agent window, never in chat, then repeat this call.');
    }
    if (login && authenticate && !status.authenticated) {
      const result = await this.call(host, service, 'login', extra);
      if (!result.authenticated) throw new AuthRequired('AUTH_REQUIRED', 'The SSAM Agent has no authenticated private session.');
    }
    return { ...status, ...extra };
  }
  scBridge(host, profile = null) {
    const privateNotes = [];
    return { privateNotes, capabilities: async () => new Set(), web: async (_host, action, options = {}) => {
      if (_host !== host) throw failure('HOST_MISMATCH', 'The private session belongs to another host.');
      if (action !== 'fetch') return this.call(host, 'service-center', action === 'close' ? 'sign-out' : action, profile ? { profile } : {});
      if (options.secretRefs?.length) throw failure('HEADLESS_AUTH_UNAVAILABLE', 'This agent credential transport does not fill secret references. Nothing was sent.');
      const result = await this.call(host, 'service-center', 'request', { ...(profile ? { profile } : {}),
        url: new URL(options.path, `https://${host}`).href, method: options.method, accept: options.accept,
        ...(options.form == null ? {} : { body: Buffer.from(new URLSearchParams(options.form).toString()).toString('base64'), contentType: 'application/x-www-form-urlencoded' }),
        write: options.write === true, ...(options.write ? { operationId: options.operationId, authorizeSha256: options.authorizeSha256 } : {}) });
      collectNotes(privateNotes, result.notes);
      return { status: result.status, contentType: result.contentType, bodyBase64: result.body, finalUrl: result.url };
    } };
  }
  portalBroker(host, profile = null) { return new AgentPortalBroker(this, host, profile); }
}

// Reuse the existing Portal route/metadata implementation, replacing its transport
// only. No request file, cookie pipe, server-side login or credential helper runs.
export class AgentPortalBroker extends StudioPortalBroker {
  constructor(agent, host, profile, { publicFetch } = {}) {
    super({ host }); this.agent = agent; this.profile = profile; this.authenticated = true; this.privateNotes = [];
    this.metadata = new PortalMetadata({ origin: this.origin, request: publicPortalMetadata(this.origin, {
      ...(publicFetch ? { fetch: publicFetch } : {}), note: note => collectNotes(this.privateNotes, [note]),
    }) });
    this.transport.metadata = this.metadata;
  }
  async request(value, { method = 'GET', body, write = false, operationUuid, authorizeSha256, secretRefs = [] } = {}) {
    if (secretRefs.length) throw failure('HEADLESS_AUTH_UNAVAILABLE', 'The agent credential transport does not fill secret references. Nothing was sent.');
    const response = await this.agent.call(this.host, 'odc-portal', 'request', { ...(this.profile ? { profile: this.profile } : {}),
      url: String(value), method, ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)).toString('base64'), contentType: 'application/json' }),
      write, ...(write ? { operationId: operationUuid, authorizeSha256 } : {}) });
    collectNotes(this.privateNotes, response.notes);
    return { status: response.status, location: null, text: Buffer.from(response.body, 'base64').toString('utf8') };
  }
}
