// The hosted executor of one customer (docs/FASE2-AGENTE.md 4.2, 4.3, 4.7): every machine-touching call of the facade
// in a hosted session reaches THIS customer's agent through its AgentLink, never a Studio of the server's owner.
//   - Files: odc.pipe and o11.bridge are staged by the mirror (odc-stage.mjs, o11-stage.mjs): inputs go to the agent by
//     sha256, outputs come back, and every agent path passes through fromAgent.
//   - Errors keep today's shapes (4.3): odc.pipe throws PipeError (sent:false = never delivered, sent:true = delivered
//     with an unknown outcome); o11.bridge throws BridgeError (executed:false, or undefined when unknown); the other
//     kinds throw Error {code, executed:false|null}. Callers keep marking as uncertain what may have run.
//   - O11: a relay per customer on 127.0.0.1:0 (o11-relay.mjs) with this customer's relay key; the connection record
//     the O11 modules read is synthesized from the agent's last record with the relay port, the server kernel's Studio
//     and the relay authority folder. No port and no key of the server ever travels to the agent.
// Imports only odc-pipe.mjs and o11-bridge.mjs of the facade (both frozen); never executor.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PipeError, replyTimeoutMs } from '../odc-pipe.mjs';
import { BridgeError, timeoutFor } from '../o11-bridge.mjs';
import { Mirror, createQuota, QUOTA_BYTES } from './mirror.mjs';
import { stageOdcPipe } from './odc-stage.mjs';
import { stageO11Bridge, IMPORT_METHOD } from './o11-stage.mjs';
import { startRelay } from './o11-relay.mjs';
import { stageXif, hopRefusal, XIF_KIND, XIF_TIMEOUT_MS, XIF_UPDATE_REQUIRED, XIF_UPDATE_TEXT } from './xif-stage.mjs';
import { studioIdentity, studioRefusal } from '../studio-identity.mjs';
import { studioScope } from './studio-scope.mjs';

// The machine kinds of 4.4 this executor forwards (call-kinds.mjs MACHINE_KINDS); file.* stay between the mirror and the agent.
import { MACHINE_KINDS } from '../call-kinds.mjs';
export const AGENT_KINDS = MACHINE_KINDS;
// servidor/fase4-24 (R3 of PLANO-24-PRODUCAO): the private transports of the 24th release never cross machines. Their
// bridge commands hand a session or a vault secret over a local pipe of the machine that runs SSAM (Ssam.PrivateTransport)
// or read the vault of that machine: refused here, before anything is staged or sent, whatever path asked for them
// (OdcAccess, the Service Center client, studio_command, o11_studio). The agent refuses them as well (4.8).
export const HOSTED_REFUSED_COMMANDS = Object.freeze(['portal-private-call', 'portal-private-download', 'portal-api-client-fixture-cleanup', 'portal-upload']);
export const HOSTED_REFUSED_METHODS = Object.freeze(['sc_private_http', 'sc_private_http_cookie']);
const HOSTED_ONLY_SESSION = 'HOSTED_STUDIO_SESSION_ONLY';
// fase4-28 r4-f3-import (criterion C3): the Studio's own SOAP/OpenAPI import runs in the customer's Service Studio through the
// thin bridge 1.1.0 of the agent pack (integration_import, capabilities integration_import:wsdl and integration_import:openapi).
// The server sends it only to an agent whose hello lists the method (agent.o11Methods, agent 0.3.8 / 0.4.5-native and later, the SSAM Agent app 0.2.0):
// for any other agent (0.4.0-native and every agent before this one) the capabilities are taken out of the bridge's manifest,
// so the kernel refuses the job before the snapshot with INTEGRATION_IMPORT_NEEDS_BRIDGE (Delivery.cs), and the method itself
// is refused here, nothing sent. Local use (the owner's own bridge) never passes here.
export const IMPORT_CAPABILITIES = Object.freeze(['integration_import:wsdl', 'integration_import:openapi']);
export const IMPORT_NEEDS_AGENT = 'INTEGRATION_IMPORT_NEEDS_BRIDGE';
export const importNeedsAgentText = version => 'The SSAM Agent on the user\'s machine (' + (version ?? 'an older version') + ') does not run the Service Studio '
  + 'integration import (integration_import), so the SOAP or OpenAPI import of this job was not sent: nothing was captured, imported or merged. '
  + 'Install the current SSAM Agent app on that machine (it carries the Service Studio bridge with the import), reopen the Service Studio, '
  + 'then resume this task. For REST, explicit methods (op rest without openapi) need no import.';
// Whether the connected agent declares an O11 bridge method in its hello (agent.o11Methods); an agent without the list never does.
export const agentRunsO11Method = (info, method) => Array.isArray(info?.agentO11Methods) && info.agentO11Methods.includes(method);
// ODC Studio 1.7.28 (2026-10-12) gave IReferencesManagerService.RefreshSpecificReferencesByKey a sixth optional parameter
// (nonSharedProducerKeys). A bridge compiled against an older ODC Studio references the five-parameter method, which
// 1.7.28 no longer has: in a 1.7.28 Studio its library update (refresh-references <Module> --producer <Library>) cannot
// bind the call (MissingMethodException) and never reaches the Studio's service. Every ODC bridge numbered below v97 was
// compiled against 1.7.27 or older (v97 is the first compiled against 1.7.28); the other commands of those bridges bind
// unchanged (metadata check of the bridges v96 and v48 against 1.7.28, docs/SERVIDOR-FASE4.md "ODC Studio 1.7.28").
// An accepted older package (kernel.json odcBridgeAccepted) is refused that one command before anything is sent.
export const ODC_BRIDGE_API_BREAKS = Object.freeze([Object.freeze({ studio: '1.7.28', firstBridge: 97, command: 'refresh-references',
  flag: '--producer', member: 'IReferencesManagerService.RefreshSpecificReferencesByKey' })]);
const versionParts = value => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? '')) ?? []).slice(1, 4).map(Number);
const atLeast = (value, minimum) => {
  const a = versionParts(value), b = versionParts(minimum);
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};
// The API break a pipe command would hit in an ODC Studio of studioVersion with the bridge version it is sent to, or null.
export function bridgeApiBreak(params, studioVersion) {
  const number = /^v(\d+)$/.exec(String(params?.version ?? ''))?.[1];
  if (number === undefined || !studioVersion) return null;
  const args = (params?.args ?? []).map(String);
  return ODC_BRIDGE_API_BREAKS.find(b => args[0] === b.command && (!b.flag || args.includes(b.flag)) && Number(number) < b.firstBridge
    && atLeast(studioVersion, b.studio)) ?? null;
}
const outdatedBridge = (version, studioVersion, b) => 'The ODC bridge ' + version + ' of this agent package was compiled against an ODC Studio older '
  + 'than ' + b.studio + ', and ODC Studio ' + b.studio + ' changed ' + b.member + ': in the user\'s ODC Studio ' + studioVersion + ' that bridge cannot run '
  + b.command + ' ' + b.flag + '. Nothing was sent. Ask the server owner for the current agent package (its ODC bridge is compiled against ODC Studio '
  + b.studio + '); ' + b.command + ' without ' + b.flag + ' and the other commands still work with this package.';
const privateTransport = what => what + ' uses a private transport of the machine that runs SSAM (a local pipe and its vault), which is never used in hosted mode: '
  + 'only the session of the user\'s own Studio is a path. Nothing was sent.';
const MARGIN_MS = 60000;
// r40: the kind of a document downloaded on the user's machine (integration-documents.mjs) and its longest own deadline (30 s).
export const DOCUMENT_FETCH_KIND = 'document.fetch';
const DOCUMENT_FETCH_TIMEOUT_MS = 30000;
const EVIDENCE_PULL_MS = 60000;
// The server-side deadline of each kind (4.4): the agent applies the operation's own timeout; this is the safety net.
const DEADLINES = {
  'studio.processes': () => 60000,
  'odc.attach': () => 120000,
  'o11.connect': () => 300000,
  'o11.selected': () => 60000,
  'odc.pipe': p => replyTimeoutMs((p?.args ?? []).map(String)) + (Number(p?.connectMs) || 10000) + MARGIN_MS,
  'o11.bridge': p => (Number(p?.timeoutMs) || timeoutFor(p?.method, p?.params)) + MARGIN_MS,
};

const coded = (code, message, executed) => Object.assign(new Error(message), { code, executed });
// A1 (review of studio-build-identity, round 2): the Studio image of each lane, for the process versions of studio.processes.
const STUDIO_IMAGE = Object.freeze({ odc: 'ODCStudio.exe', o11: 'ServiceStudio.exe' });
// The Studio calls a hosted tool call may send: counted in the call's studio scope once they pass the identity check.
const STUDIO_KINDS = new Set(['odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected']);
// What a hub error says beyond its code (C03: AGENT_RECONNECTING carries retryAfterSeconds and the call to repeat).
const carried = (target, error) => Object.assign(target, Number.isFinite(error?.retryAfterSeconds) ? { retryAfterSeconds: error.retryAfterSeconds } : {},
  error?.continuation ? { continuation: error.continuation } : {});
// Not delivered = the agent never saw the call (executed:false); anything else may have run.
const undelivered = error => error?.executed === false;

// stage: 'before' (staging, nothing of the command reached the agent), 'link' (the call itself) or 'after' (the reply
// was delivered: whatever fails now leaves the outcome unknown).
function pipeError(error, stage) {
  const sent = stage === 'before' ? false : stage === 'after' ? true
    : typeof error?.sent === 'boolean' ? error.sent : !undelivered(error);
  return carried(new PipeError(error?.message ?? String(error), { code: error?.code ?? 'AGENT_ERROR', sent }), error);
}
function bridgeError(error, method, stage) {
  const executed = stage === 'before' ? false : stage === 'after' ? undefined : undelivered(error) ? false : undefined;
  return carried(new BridgeError(error?.message ?? String(error), { code: error?.code ?? 'AGENT_ERROR', method, executed }), error);
}
const recordOf = value => value && Number.isInteger(value.pid)
  ? { pid: value.pid, startedUtc: value.startedUtc ?? null, studioVersion: value.studioVersion ?? value.version ?? null, connectedAt: value.connectedAt ?? null }
  : null;

export class AgentExecutor {
  constructor({ link, workspace, relayAuthorityDir, o11 = {}, log = () => {}, quotaBytes = QUOTA_BYTES } = {}) {
    if (!link || typeof link.call !== 'function') throw new Error('AgentExecutor needs an AgentLink');
    if (!workspace || !path.isAbsolute(workspace)) throw new Error('AgentExecutor needs the absolute workspace of the customer');
    this.id = 'agent:' + (link.tokenId ?? 'customer') + ':' + randomUUID();
    this.hosted = true;
    this.link = link;
    this.workspace = path.resolve(workspace);
    this.relayAuthorityDir = relayAuthorityDir ?? path.join(this.workspace, 'state', 'relay-authority');
    this.o11 = { studioDir: o11.studioDir ?? null, lane: o11.lane ?? null };
    this.log = log;
    this.quota = createQuota(this.workspace, { limitBytes: quotaBytes });
    this.mirror = new Mirror({ workspace: this.workspace, link, quota: this.quota, log });
    this.relay = null;
    this.record = null;
    this.seenInfo = undefined;
    // A1: `${image}:${pid}` -> the ProductVersion the agent reported for that process (null: unreadable), from the last
    // studio.processes listing of that image (lib.mjs lists before the Studio calls and keeps its pids for 30 s).
    this.processVersions = new Map();
  }

  // Reads this customer's relay key and opens the O11 relay.
  async start() {
    if (this.relay) return;
    const key = fs.readFileSync(path.join(this.relayAuthorityDir, 'bridge.key'), 'ascii').trim();
    this.relay = await startRelay({ key, call: (kind, params) => this.call(kind, params), log: this.log });
  }

  relayPort() { return this.relay?.port ?? null; }

  async close() {
    const relay = this.relay;
    this.relay = null;
    await relay?.close();
  }

  // The ODC bridge version this customer's agent carries, when the server accepts it (kernel.json odcBridge or
  // odcBridgeAccepted, 2026-10-08): a bridge bump keeps serving customers still on the previous agent package.
  // SSAM-MCP (2026-10-10, Docker rehearsal of server/Dockerfile): a server whose tree has no built ODC bridge (the Linux
  // image: .dockerignore leaves studio/bridge out) gets bridgeVersion() null and asked every pipe for version null, which
  // the agent refuses (BRIDGE_VERSION_MISMATCH "the server asked for null"). An odc.pipe that names version null asks for
  // the kernel's odcBridge (kernel.json, pinned by the owner on that server). odc.attach names no version and is unchanged.
  bridgeVersionFor(params) {
    if (!params) return params;
    let info = null; try { info = this.link?.info?.() ?? null; } catch { info = null; }
    const carried = info?.pack?.odcBridge, kernel = info?.kernel ?? {};
    if (params.version === null && typeof kernel.odcBridge === 'string' && kernel.odcBridge) params = { ...params, version: kernel.odcBridge };
    if (typeof params.version !== 'string') return params;
    const accepted = [kernel.odcBridge, ...(kernel.odcBridgeAccepted ?? [])].filter(Boolean);
    return carried && carried !== params.version && accepted.includes(carried) ? { ...params, version: carried } : params;
  }

  // The ODC Studio of this customer: the version the agent reported (Hello, pong.versions), else the server kernel's,
  // which the hub requires the customer's Studio to match (agent-hub.mjs compatibility).
  odcStudioVersion() {
    let info = null; try { info = this.link?.info?.() ?? null; } catch { info = null; }
    return info?.studios?.odc?.installed?.version ?? info?.kernel?.odc ?? null;
  }

  async call(kind, params = {}, options = {}) {
    if (kind === 'odc.pipe') return this.pipe(this.bridgeVersionFor(params ?? {}), options);
    if (kind === 'odc.attach') params = this.bridgeVersionFor(params ?? {});
    if (kind === 'o11.bridge') return this.bridge(params ?? {}, options);
    if (kind === XIF_KIND) return this.xif(params ?? {});
    if (!AGENT_KINDS.includes(kind)) throw coded('KIND_NOT_ALLOWED', 'Call kind not allowed through the hosted executor: ' + kind, false);
    // A1, and B1 of round 3 (C:\t\revisoes\studio-build-id-2\REVISAO.md): an attach is judged by the process it attaches,
    // the o11.connect like the odc.attach. An o11.connect without pid is judged by the only Service Studio the agent would
    // choose (kinds.mjs o11ConnectKind: one candidate, else STUDIO_NOT_SELECTED, which the agent answers itself).
    if (kind === 'odc.attach' || kind === 'o11.connect') {
      const lane = kind === 'odc.attach' ? 'odc' : 'o11';
      const pid = lane === 'o11' && (params?.pid === undefined || params?.pid === null) ? await this.onlyProcess('o11') : params?.pid;
      const refused = await this.judgeStudio(lane, pid);
      if (refused) throw Object.assign(coded('STUDIO_VERSION_MISMATCH', refused.error, false), { sent: false, continuation: refused.continuation });
    }
    this.sentToStudio(kind);
    let value;
    try { value = await this.link.call(kind, params ?? {}, { timeoutMs: options.timeoutMs ?? DEADLINES[kind](params) }); }
    catch (error) { throw carried(coded(error?.code ?? 'AGENT_ERROR', error?.message ?? String(error), undelivered(error) ? false : null), error); }
    if (kind === 'o11.connect' || kind === 'o11.selected') this.remember(value);
    if (kind === 'studio.processes') this.rememberProcesses(params?.image, value);
    return value;
  }

  // F4 (PLANO-11H): one Integration Studio stage of o11_extension on the user's machine (hosted/xif-stage.mjs), asked by the
  // kernel through the relay (method xif_engine). Always answers the engine's shape: the hop's own failures are refusals the
  // kernel reads (hopRefusal), since a stage writes only local files and nothing of it reaches the environment.
  // r40 (integration-documents.mjs agentRead): whether this customer's agent downloads an integration document on the user's
  // machine now: 'ready' (connected, its Hello lists document.fetch), 'update' (connected without it: the apps 0.2.1/0.2.2),
  // 'absent' (not connected: nothing is asked, nothing waits for a reconnection).
  documentFetchState() {
    let connected = false;
    try { connected = this.link.connected?.() === true; } catch { connected = false; }
    if (!connected) return 'absent';
    let supported = false;
    try { supported = this.link.supports?.(DOCUMENT_FETCH_KIND) === true; } catch { supported = false; }
    return supported ? 'ready' : 'update';
  }

  // One document.fetch on the user's machine through this customer's link (the one channel of every kind); the server never
  // requests the URL. params {url, accept, maxBytes, timeoutMs}; the agent's own deadline plus the margin of the other kinds.
  async documentFetch(params) {
    const timeoutMs = Math.min(Number(params?.timeoutMs) || DOCUMENT_FETCH_TIMEOUT_MS, DOCUMENT_FETCH_TIMEOUT_MS) + MARGIN_MS;
    return this.link.call(DOCUMENT_FETCH_KIND, { url: params?.url, accept: params?.accept, maxBytes: params?.maxBytes, timeoutMs: params?.timeoutMs }, { timeoutMs });
  }

  async xif(request) {
    let supported = false;
    try { supported = this.link.supports?.(XIF_KIND) === true; } catch { supported = false; }
    if (!supported) return hopRefusal(coded(XIF_UPDATE_REQUIRED, XIF_UPDATE_TEXT, false));
    try {
      const staged = await stageXif(request, this.mirror);
      await this.mirror.putMany(staged.puts);
      const value = await this.link.call(XIF_KIND, staged.params, { timeoutMs: XIF_TIMEOUT_MS });
      return await staged.after(value);
    } catch (error) { return hopRefusal(error); }
  }

  // A1 (review of studio-build-identity, round 2): the versions of the processes of one Studio image, as the agent listed them.
  rememberProcesses(image, value) {
    if (!Object.values(STUDIO_IMAGE).includes(image) || !Array.isArray(value?.processes)) return;
    for (const key of [...this.processVersions.keys()]) if (key.startsWith(image + ':')) this.processVersions.delete(key);
    for (const p of value.processes) {
      const pid = Number(p?.pid);
      if (Number.isSafeInteger(pid) && pid > 0) this.processVersions.set(image + ':' + pid, typeof p.version === 'string' && p.version ? p.version : null);
    }
  }
  knowsProcess(lane, pid) { return this.processVersions.has(STUDIO_IMAGE[lane] + ':' + Number(pid)); }
  // B1: the pid of the only process of the lane's Studio image, listed now; null with none or several (no verdict: the
  // agent refuses STUDIO_NOT_SELECTED) or when the listing fails (the agent lists again and answers for it).
  async onlyProcess(lane) {
    const image = STUDIO_IMAGE[lane];
    try { await this.call('studio.processes', { image }); } catch { return null; }
    const pids = [...this.processVersions.keys()].filter(key => key.startsWith(image + ':'));
    return pids.length === 1 ? Number(pids[0].slice(image.length + 1)) : null;
  }
  sentToStudio(kind) { const scope = studioScope(); if (scope && STUDIO_KINDS.has(kind)) scope.sent++; }
  // The identity of the PROCESS a Studio call goes to (studio-identity.mjs, the rule of the hub): a pid this executor has
  // not seen listed is listed once. Not served -> the refusal (the call is not sent), recorded in the tool call's scope and
  // named once in the server log (studio-version-unserved); another build served with a warning -> recorded for the
  // answer. A pid the agent does not list, or a lane without a kernel, has no verdict: the agent answers for it.
  // list:false judges only a process already listed (no agent call: the local refusals of a pipe come first).
  async judgeStudio(lane, pid, { list = true } = {}) {
    const number = Number(pid);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const key = STUDIO_IMAGE[lane] + ':' + number;
    if (!this.processVersions.has(key)) {
      if (!list) return null;
      try { await this.call('studio.processes', { image: STUDIO_IMAGE[lane] }); } catch { return null; }
    }
    if (!this.processVersions.has(key)) return null;
    let info = null; try { info = this.link?.info?.() ?? null; } catch { info = null; }
    const identity = studioIdentity(lane, { version: this.processVersions.get(key) }, info?.kernel ?? {});
    const scope = studioScope();
    const refusal = studioRefusal(identity);
    if (refusal) {
      scope?.refused.push(identity);
      try { this.link?.studioUnserved?.(lane, identity, refusal.cause); } catch { /* the refusal stands without its log line */ }
      return refusal;
    }
    if (identity?.warn) scope?.warned.push(identity);
    return null;
  }

  async pipe(params, options) {
    const command = String(params?.args?.[0] ?? '');
    if (HOSTED_REFUSED_COMMANDS.includes(command))
      throw Object.assign(new PipeError(privateTransport('The bridge command ' + command), { code: HOSTED_ONLY_SESSION, sent: false }), { executed: false });
    // A1: the process this command goes to must be a Studio this server serves: judged before anything is staged when the
    // executor already listed it, else right after the local checks of staging, and always before the command is sent.
    const studioRefused = refused => Object.assign(new PipeError(refused.error, { code: 'STUDIO_VERSION_MISMATCH', sent: false }), { executed: false, continuation: refused.continuation });
    const known = this.knowsProcess('odc', params?.pid);
    const early = known ? await this.judgeStudio('odc', params?.pid) : null;
    if (early) throw studioRefused(early);
    const studioVersion = this.odcStudioVersion();
    const broken = bridgeApiBreak(params, studioVersion);
    if (broken)
      throw Object.assign(new PipeError(outdatedBridge(params.version, studioVersion, broken), { code: 'STUDIO_BRIDGE_OUTDATED', sent: false }), { executed: false });
    let staged;
    try { staged = await stageOdcPipe(params, this.mirror); }
    catch (error) { throw pipeError(error, 'before'); }
    const late = known ? null : await this.judgeStudio('odc', params?.pid);
    if (late) throw studioRefused(late);
    this.sentToStudio('odc.pipe');
    let value;
    // timeoutMs: the reply deadline of the one table (bridge-deadlines.json): an agent that reads it never cuts before the
    // bridge gives up. An agent that does not read it ignores the field and keeps its own 10 minutes.
    const replyMs = replyTimeoutMs((staged.params?.args ?? []).map(String));
    try { value = await this.link.call('odc.pipe', { ...staged.params, timeoutMs: replyMs }, { timeoutMs: options.timeoutMs ?? DEADLINES['odc.pipe'](staged.params) }); }
    catch (error) {
      const lost = pipeError(error, 'link');
      // The reply was lost after the command was sent (the agent's deadline, a broken pipe, a lost channel): the evidence of the
      // command is on its machine. Bring it back, within a bound, so the answer says what happened; evidenceSeen false says it
      // could not, and the answer then affirms nothing.
      if (lost.sent !== false) lost.evidenceSeen = await this.evidenceOf(staged);
      throw lost;
    }
    try { return await staged.after(value); }
    catch (error) { const lost = pipeError(error, 'after'); lost.evidenceSeen = false; throw lost; }
  }

  async evidenceOf(staged, limitMs = EVIDENCE_PULL_MS) {
    let timer;
    try { return await Promise.race([staged.evidence(), new Promise(resolve => { timer = setTimeout(() => resolve(false), limitMs); })]); }
    catch { return false; }
    finally { clearTimeout(timer); }
  }

  // The port and authorization of the caller are dropped here: the agent uses its own record and its own key.
  async bridge(params, options) {
    const { method, params: inner, timeoutMs } = params;
    if (HOSTED_REFUSED_METHODS.includes(String(method)))
      throw new BridgeError(privateTransport('The bridge method ' + method), { code: HOSTED_ONLY_SESSION, method, executed: false });
    let info = null; try { info = this.link?.info?.() ?? null; } catch { info = null; }
    const imports = agentRunsO11Method(info, IMPORT_METHOD);
    if (method === IMPORT_METHOD && !imports)
      throw new BridgeError(importNeedsAgentText(info?.agentVersion), { code: IMPORT_NEEDS_AGENT, method, executed: false });
    let staged;
    try { staged = await stageO11Bridge({ method, params: inner }, this.mirror); }
    catch (error) { throw bridgeError(error, method, 'before'); }
    const request = { method, params: staged.params, ...(timeoutMs ? { timeoutMs } : {}) };
    this.sentToStudio('o11.bridge');
    let value;
    try { value = await this.link.call('o11.bridge', request, { timeoutMs: options.timeoutMs ?? DEADLINES['o11.bridge'](request) }); }
    catch (error) { throw bridgeError(error, method, 'link'); }
    let answer;
    try { answer = await staged.after(value); }
    catch (error) { throw bridgeError(error, method, 'after'); }
    // An agent that does not run the import never shows its bridge's import capabilities to the kernel (see IMPORT_CAPABILITIES).
    if (!imports && (method === 'bridge_manifest' || method === 'ping') && Array.isArray(answer?.reply?.data?.capabilities))
      answer.reply.data.capabilities = answer.reply.data.capabilities.filter(c => !IMPORT_CAPABILITIES.includes(c));
    return answer;
  }

  // The O11 record the agent reported last (Hello, pong.versions), as the hub keeps it in link.info().
  infoRecord() {
    let info = null;
    try { info = this.link.info?.() ?? null; } catch { info = null; }
    const fromInfo = info?.o11Connection ?? null;
    return { key: JSON.stringify(fromInfo), record: recordOf(fromInfo) };
  }

  // The agent's O11 record from the results of o11.connect / o11.selected; it stands until the agent reports another.
  remember(value) {
    if (!value || typeof value !== 'object') return;
    this.seenInfo = this.infoRecord().key;
    if (value.connected === false) { this.record = null; return; }
    const record = recordOf(value);
    if (record && value.ok !== false) this.record = { ...(this.record ?? {}), ...Object.fromEntries(Object.entries(record).filter(([, v]) => v !== null)) };
  }

  // Synchronous: the record the O11 modules read (studio-session readConnection), or null when the agent is not
  // connected or has no Service Studio connected. A newer record from the agent (Hello, pong.versions) replaces the one
  // kept from the last call.
  o11Connection() {
    const latest = this.infoRecord();
    if (latest.key !== this.seenInfo) { this.seenInfo = latest.key; this.record = latest.record; }
    let connected = false;
    try { connected = this.link.connected?.() === true; } catch { connected = false; }
    const record = this.record;
    if (!connected || !record || !this.relay) return null;
    return { ok: true, lane: 'o11', anvilLane: this.o11.lane, pid: record.pid, startedUtc: record.startedUtc ?? null,
      studioVersion: record.studioVersion ?? null, port: this.relay.port, studioDir: this.o11.studioDir,
      authorityDir: this.relayAuthorityDir, connectedAt: record.connectedAt ?? null, hosted: true };
  }

  // An agent file the LLM named (agent:inbox/<rel>, or agent:odc|o11/<rel> missing on the server) brought to <ws>/<rel>.
  async pullFile(agentPath, { ifMissing = false } = {}) {
    const dest = this.mirror.fromAgent(agentPath);
    let present = false;
    try { present = fs.statSync(dest).isFile(); } catch { present = false; }
    if (ifMissing && present) return dest;
    try { await this.mirror.pull(agentPath); }
    catch (error) { throw coded(error?.code ?? 'AGENT_ERROR', error?.message ?? String(error), undelivered(error) ? false : null); }
    return dest;
  }

  // servidor/fase4-26 a8: the sha256 of one agent file as the agent lists it (file.list of that one file: the agent hashes it
  // on the user's machine), without bringing it; null when the agent does not list exactly that file. The call deadline's
  // inputs of a run-to-end call (policy.mjs replayInputs): never a write to the workspace.
  async agentFileSha256(agentPath) {
    try {
      const wanted = this.mirror.fromAgent(agentPath);
      const listing = await this.link.call('file.list', { path: agentPath, max: 1 }, { timeoutMs: 30000 });
      const entries = Array.isArray(listing?.entries) ? listing.entries : [];
      if (entries.length !== 1 || this.mirror.fromAgent(entries[0]?.path) !== wanted) return null;
      const sha = String(entries[0].sha256 ?? '').toLowerCase();
      return /^[0-9a-f]{64}$/.test(sha) ? sha : null;
    } catch { return null; }
  }
}
