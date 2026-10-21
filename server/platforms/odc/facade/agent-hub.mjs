// The agent channel of the hosted mode (phase 2 of the distribution, docs/FASE2-AGENTE.md sections 2, 3 and 7): the
// customer's thin agent connects OUT to this server and runs only the operations that must touch the customer's
// machine. This module is the server side of protocol ssam-agent/1 and the AgentLink (I-1) the hosted executor uses.
//   - Transport: plain HTTP inside http-server.mjs. Downlink: a long GET /agent/v1/stream answering NDJSON (call, ping,
//     close); uplink: POST /agent/v1/messages with batches (accepted, result, pong); files: PUT/GET of 4 MiB parts
//     with a sha256 per part and for the whole file.
//   - Access: Authorization: Bearer ssam_agent_... (server-tokens.mjs verifyAgent), bound to the record of the MCP
//     token. 401 missing/unknown (also the credential before an agent-rotate), 403 revoked or expired.
//   - One live channel per token. The same Hello.instance resumes (only never-accepted calls are written again);
//     another instance replaces (Close replaced, the old pending calls fail AGENT_DISCONNECTED).
//   - Everything is keyed by the token id the credential proves: channel, pending calls, transfers. A channel or a
//     transfer of another token is 404, like one that never existed. Raw URL segments are checked before any file.
//   - The hub never writes tokens.json: lastSeenAt lives in memory. Logs carry events and ids, never arguments,
//     values or file contents.
//   - C03 (servidor/fase4): a call written and not accepted in acceptMs closes the stream, so a live agent whose stream died
//     without a reset reconnects at once (the call is written again on the resumed stream and its deadline gets one
//     reconnectGraceMs); a call made while a recently seen agent (recentMs) is reconnecting waits up to reconnectWaitMs for
//     its Hello instead of failing at once (then AGENT_RECONNECTING with retryAfterSeconds); a POST that left on the previous
//     channel of the same instance is still taken. deadAfterMs (45 s) stays above the agent's longest POST of messages
//     (agent/lib/channel.mjs: 10 s plus 1 s per 64 KiB, 26 s for a full batch), and a pong travels in a POST of its own.
//   - Quality (docs/QUALIDADE.md): a pending call keeps the tool call that made it (quality-meter.mjs currentCall(); null
//     from the relay socket) and every settled call is reported to onCallSettled {tokenId, kind, verb, startMs, ms, ok,
//     code, bytes?, callKey}: protocol verbs, times and sizes, never arguments or values.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AGENT_PREFIX } from './server-tokens.mjs';
import { spawn } from 'node:child_process';
import { currentCall } from './quality-meter.mjs';
import { agentVerbOf } from './quality-line.mjs';
import { buildPolicyOf, servedBuildOf, studioIdentity, studioRefusal, studioVersions, studioWarningOf, threePart, servedVersions, causeOf } from './studio-identity.mjs';
import { recordStudioVersions } from './studio-version-state.mjs';
import { UNKNOWN_EXIT } from './hosted/network-check.mjs';

// A Windows balloon on the server machine (owner test, 2026-10-08); off with SSAM_ACCESS_NOTIFY=0, never fails a call.
function notifyOwner(title, text) {
  if (process.platform !== 'win32' || process.env.SSAM_ACCESS_NOTIFY === '0') return;
  const q = v => String(v).replace(/'/g, "''").slice(0, 240);
  const script = "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; "
    + "$n.Icon = [System.Drawing.SystemIcons]::Warning; $n.Visible = $true; "
    + `$n.ShowBalloonTip(15000, '${q(title)}', '${q(text)}', 'Warning'); Start-Sleep -Seconds 16; $n.Dispose()`;
  try { spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* best effort */ }
}

export const PROTOCOL = 'ssam-agent/1';
// maxValueBytes: a result value (valueBlob) is assembled in memory, so it is capped far below maxFileBytes (files are
// streamed to disk part by part); the same 16 MiB as an MCP request body and an O11 relay line.
export const LIMITS = Object.freeze({ heartbeatMs: 15000, deadAfterMs: 45000, maxMessageBytes: 1048576, inlineMaxBytes: 524288,
  partBytes: 4194304, maxFileBytes: 536870912, maxValueBytes: 16777216, maxTransfers: 4, maxPending: 32, transferIdleMs: 600000,
  ratePerMinute: 3000, sweepMs: 500, callTimeoutMs: 60000, acceptMs: 15000, reconnectGraceMs: 60000, reconnectWaitMs: 45000, recentMs: 300000,
  probeMaxBytes: 2097152, probeRecords: 64, uploadWindowMs: 1800000, uploadSlowMs: 3000 });
// The closed list of call kinds (section 4.4). The agent refuses anything else; the hub never sends anything else.
// net.probe (fase4-24, 2.10): the network check of ssam_doctor {network:true}; only to an agent whose Hello lists it.
export const CALL_KINDS = Object.freeze(['studio.processes', 'odc.pipe', 'odc.attach', 'o11.bridge', 'o11.connect', 'o11.selected',
  'file.put', 'file.get', 'file.list', 'file.sync', 'net.probe']);
const LANES = ['odc', 'o11'];
const STUDIO = { odc: 'ODC Studio', o11: 'Service Studio' };
const HEX32 = /^[0-9a-f]{32}$/;
const INDEX = /^(0|[1-9][0-9]{0,5})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SIZE = /^(0|[1-9][0-9]{0,15})$/;
const INSTANCE = /^[A-Za-z0-9-]{1,64}$/;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex');
// prazos B: the bridge method of an o11.bridge call and the operation of an environment_session; quality (2.7): the command
// of an odc.pipe call (params.args[0]). Each only from its closed list, never by its shape: the command of studio_command is
// the model's own text, and a lowercase app or module name looks like a verb (privacy finding of 2026-10-12). The pipe
// commands and bridge methods are the lists the customer's agent enforces, kept in the ssam-quality/1 contract
// (quality-line.mjs AGENT_VERBS); the environment operations are the kernel's (connect and close of the lease, then
// Anvil.Core EnvironmentOperations.Names, of which the thin bridge's EnvironmentPrimitives.Names is a part). Drift tests in
// agent-hub.test.mjs compare both with their sources.
export const ENVIRONMENT_OPERATIONS = Object.freeze(['connect', 'close', 'applications', 'modules', 'application-icon', 'catalogs', 'referenceable',
  'extensions', 'extension-download', 'versions', 'templates', 'template-module', 'template-download', 'signature', 'template-user-provider',
  'download', 'application-save', 'module-associate', 'application-delete', 'module-delete', 'publish-start', 'publish-check', 'data-read',
  'data-write', 'users-read']);
// params: the call's own params (odc.pipe {args}; o11.bridge {method, params: {operation}}). Only listed words come back.
export const callVerbs = (kind, params) => {
  if (!params || typeof params !== 'object') return {};
  if (kind === 'odc.pipe') { const command = agentVerbOf(kind, Array.isArray(params.args) ? params.args[0] : null); return command ? { command } : {}; }
  if (kind !== 'o11.bridge') return {};
  const method = agentVerbOf(kind, params.method);
  const operation = method === 'environment_session' && typeof params.params?.operation === 'string' && ENVIRONMENT_OPERATIONS.includes(params.params.operation)
    ? params.params.operation : null;
  return { ...(method ? { method } : {}), ...(operation ? { operation } : {}) };
};
// The bytes a call moves when they are known before it runs: the file of a file.put, the files of a file.sync, a params blob.
const sizeOf = ref => (Number.isFinite(ref?.size) && ref.size > 0 ? ref.size : 0);
const bytesDown = (kind, params, blob) => sizeOf(blob?.ref) + (kind === 'file.put' ? sizeOf(params?.blob)
  : kind === 'file.sync' && Array.isArray(params?.files) ? params.files.reduce((s, f) => s + sizeOf(f?.blob), 0) : 0);
// The public address a request came from: the first X-Forwarded-For hop (Caddy sets it), else the socket's.
const addressOf = req => (String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || '').slice(0, 64);
// The exit of the customer's internet an address stands for, as the doctor shows it (fase4-24, 2.10): an IPv4 address
// without its last number (177.26.87.x), an IPv6 address by its /48, never the whole address; an address it cannot read is
// the network check's UNKNOWN_EXIT ('unknown' since the owner's decision of 2026-10-19).
export function maskAddress(address) {
  const value = String(address ?? '').trim().replace(/^::ffff:/i, '');
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(value);
  if (v4) return v4[1] + '.' + v4[2] + '.' + v4[3] + '.x';
  if (value.includes(':')) return value.split('%')[0].split(':').slice(0, 3).map(g => g || '0').join(':') + '::/48';
  return value ? UNKNOWN_EXIT : null;
}
// An upload part that took longer than 3 s plus 1 s per 128 KiB (a floor of about 1 Mbit/s) is slow: the production test of
// 2026-10-11 had parts of 60 KB in 26 s and of 2.2 MB in 135 s on one exit, 0.2-0.7 s on the other.
export const slowUpload = (bytes, ms, baseMs = 3000) => ms > baseMs + Math.ceil(Math.max(0, Number(bytes) || 0) / 131072) * 1000;
// Reads a probe body, counting what arrives (onData sees each chunk's size at once), until it ends, is aborted or passes
// limit (the rest is drained, not kept).
function readProbe(req, limit, onData = () => {}) {
  return new Promise(resolve => {
    let size = 0, done = false;
    const finish = value => { if (!done) { done = true; resolve({ ...value, size }); } };
    req.on('data', chunk => { size += chunk.length; if (!done) onData(chunk.length); if (size > limit) finish({ tooLarge: true }); });
    req.on('end', () => finish({ complete: true }));
    req.on('error', () => finish({ aborted: true }));
    req.on('close', () => finish({ aborted: true }));
  });
}

// The first three numbers of a version ("11.55.91.65012" -> "11.55.91"), or null (studio-identity.mjs).
export { threePart };
// builds (A-M1): the four-part build each lane serves (startupKernel: the image's Studio folder), kept only with the lane's
// three numbers; studioBuildPolicy (kernel.json): normalized per lane, kept only when kernel.json names it (the default is
// "warn"). Both travel in welcome.kernel and info().kernel; agent 0.3.1 reads only kernel[lane].
export const normalizeKernel = (kernel = {}) => {
  const out = { o11: threePart(kernel?.o11), odc: threePart(kernel?.odc),
    odcBridge: typeof kernel?.odcBridge === 'string' && kernel.odcBridge ? kernel.odcBridge : null,
    ...(kernel?.o11Hook === 'h1' ? { o11Hook: 'h1' } : {}),
    // kernel.json odcBridgeAccepted (owner, 2026-10-08): older ODC bridges the server still serves, so a bridge bump does
    // not cut the customers that have not installed the new agent package yet.
    ...(Array.isArray(kernel?.odcBridgeAccepted) ? { odcBridgeAccepted: kernel.odcBridgeAccepted.filter(v => typeof v === 'string' && v) } : {}) };
  const builds = Object.fromEntries(LANES.map(lane => [lane, servedBuildOf({ ...out, builds: kernel?.builds }, lane)]));
  if (Object.values(builds).some(Boolean)) out.builds = builds;
  if (kernel?.studioBuildPolicy !== undefined && kernel?.studioBuildPolicy !== null) {
    const { odc, o11 } = buildPolicyOf(kernel.studioBuildPolicy);
    out.studioBuildPolicy = { odc, o11 };
  }
  if (kernel?.servedVersions || process.env.SSAM_SERVED_VERSIONS) out.servedVersions = Object.fromEntries(LANES.map(lane => [lane, servedVersions(lane, kernel)]));
  return out;
};
// The O11 hooks an agent package may declare (pack.json o11Hook, docs/O11-BRIDGE-FINA.md 13): the development hook and
// the release hook h1. A package without the field predates them and counts as "dev".
export const O11_HOOKS = Object.freeze(['dev', 'h1']);

// Compatibility per lane (section 7): the lane is in the token and in the package, the server has a kernel for it, the
// package was built for that kernel (ODC bridge version, Service Studio of the O11 bridge) and the server serves the
// Studio installed on the customer's machine (studio-identity.mjs studioIdentity, the ONE identity rule).
//   - refused (multi-version design O.6.1, kernel-image.mjs kernelPair): a lane the image refused at start because its
//     kernel.json names another Studio version than the image carries: KERNEL_UNAVAILABLE, cause KERNEL_VERSION_MISSING.
//   - A-M1 (C:\t\multiver\minimo\PROPOSTA.md): the server serves ONE Studio build per lane. Another three-part version,
//     older or newer, and (kernel.json studioBuildPolicy "refuse") another build of the same version: STUDIO_VERSION_MISMATCH
//     with the cause of its direction (STUDIO_UPDATE_REQUIRED, STUDIO_VERSION_NOT_SERVED_YET; STUDIO_BUILD_UNKNOWN), the
//     identity in studio, served [build] and installed, before any package check: no package changes it (a bridge built
//     for 11.55.92 does not bind on 11.55.91), so "ask for the current package" would mislead. Another build under "warn"
//     (the default) is served: {ok: true, studio, warning} (studioBuildDiffers), and the gate puts it in every answer.
export function compatibility(hello, kernel, lanes, { refused = null } = {}) {
  const k = normalizeKernel(kernel);
  return Object.fromEntries(LANES.map(lane => [lane, laneCompatibility(lane, hello, k, lanes ?? [], refused?.[lane] ?? null)]));
}
function laneCompatibility(lane, hello, kernel, lanes, refused) {
  const no = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
  const name = STUDIO[lane];
  if (!lanes.includes(lane)) return no('LANE_DISABLED', 'The ' + lane + ' lane is not enabled for this token.');
  const server = kernel[lane];
  if (!server && refused) return no('KERNEL_UNAVAILABLE', 'This SSAM server image carries the kernel for ' + name + ' ' + refused.image + ', but its kernel.json names '
    + (refused.kernel ? name + ' ' + refused.kernel : 'no ' + name + ' version') + ': the ' + lane + ' lane is off and nothing runs on the user\'s ' + name
    + '. The server owner must write the kernel.json of this image.', { cause: 'KERNEL_VERSION_MISSING', image: refused.image, pinned: refused.kernel ?? null });
  if (!server || (lane === 'odc' && !kernel.odcBridge)) return no('KERNEL_UNAVAILABLE', 'This SSAM server has no kernel for ' + name + '.');
  const installed = hello?.studios?.[lane]?.installed ?? null;
  const studio = studioIdentity(lane, installed, kernel);
  const notServed = refusalOf(studio);
  if (notServed && studio.relation !== 'unknown') return notServed;
  const pack = hello?.pack;
  if (!pack || !Array.isArray(pack.lanes) || !pack.lanes.includes(lane))
    return no('AGENT_PACK_MISMATCH', 'The agent package has no ' + lane + ' lane. Ask the server owner for the current agent package.');
  if (lane === 'odc' && pack.odcBridge !== kernel.odcBridge && !(kernel.odcBridgeAccepted ?? []).includes(pack.odcBridge))
    return no('AGENT_PACK_MISMATCH', 'The agent package carries ODC bridge ' + (pack.odcBridge ?? 'none') + '; this server uses ' + kernel.odcBridge + '. Ask the server owner for the current agent package.');
  if (lane === 'o11' && !servedVersions(lane, kernel).includes(threePart(pack.o11BuiltFor)))
    return no('AGENT_PACK_MISMATCH', 'The O11 bridge of the agent package was built for Service Studio ' + (pack.o11BuiltFor ?? 'none') + '; this server has the kernel for Service Studio ' + server + '. Ask the server owner for the current agent package.');
  if (lane === 'o11') {
    const hook = pack.o11Hook ?? 'dev';
    if (!O11_HOOKS.includes(hook))
      return no('AGENT_PACK_MISMATCH', 'The agent package declares the O11 hook ' + JSON.stringify(hook) + ', which this server does not know (known: ' + O11_HOOKS.join(', ') + '). Ask the server owner for the current agent package.');
    // kernel.json {"o11Hook": "h1"}: the owner accepts only packages whose thin bridge is loaded by the signed release hook.
    if (kernel.o11Hook === 'h1' && hook !== 'h1')
      return no('AGENT_PACK_MISMATCH', 'This server accepts only agent packages with the signed release hook h1; this package uses the ' + hook + ' hook. Ask the server owner for the current agent package.');
  }
  if (!installed) return no('STUDIO_NOT_INSTALLED', 'The agent found no ' + name + ' installed on the user\'s machine; this server has the kernel for ' + name + ' ' + server + '.');
  // a version the agent could not read: after the package checks, as before (STUDIO_VERSION_UNKNOWN)
  if (notServed) return notServed;
  return studio?.warn ? { ok: true, studio, warning: studioWarningOf(studio) } : { ok: true };
}
// The hub's answer for a Studio the server does not serve: the gate's refusal (studio-identity.mjs studioRefusal) in the
// shape of a compatibility entry, with the identity for the gate and the event.
function refusalOf(studio) {
  const refusal = studioRefusal(studio);
  return refusal ? { ok: false, code: refusal.code, message: refusal.error, cause: refusal.cause, studio, served: refusal.served, installed: refusal.installed } : null;
}

function callError(code, message, { executed = false, delivered = false, ...extra } = {}) {
  return Object.assign(new Error(message), { code, executed, delivered, ...extra });
}

function reply(res, status, code, message, headers = {}) {
  if (res.headersSent) { res.destroy(); return true; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify({ ok: false, code, message }));
  return true;
}

// Reads a body up to limit bytes. Past the limit the rest is drained (not kept), so the client still reads the 413.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, over = false;
    req.on('data', chunk => {
      if (over) return;
      size += chunk.length;
      if (size > limit) { over = true; chunks.length = 0; resolve({ tooLarge: true }); } else chunks.push(chunk);
    });
    req.on('end', () => { if (!over) resolve({ body: Buffer.concat(chunks) }); });
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const read = await readBody(req, limit);
  if (read.tooLarge) return read;
  try { return { value: JSON.parse(read.body.toString('utf8')) }; } catch { return { invalid: true }; }
}

// The raw path segments and the raw channel value, with no percent-decoding and no dot-segment normalization.
function rawTarget(url) {
  const raw = String(url ?? '');
  const q = raw.indexOf('?');
  const query = q < 0 ? '' : raw.slice(q + 1);
  const channels = query.split('&').filter(p => p.startsWith('channel=')).map(p => p.slice('channel='.length));
  return { segments: (q < 0 ? raw : raw.slice(0, q)).split('/'), channel: channels.length === 1 ? channels[0] : null };
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function createAgentHub({ dir, store, kernel, kernelRefused = null, log = () => {}, now = () => new Date(), limits: overrides = {}, onCallSettled = null } = {}) {
  if (!dir) throw new Error('dir is required');
  if (!store?.verifyAgent || !store?.lookup) throw new Error('store with verifyAgent and lookup is required');
  const limits = { ...LIMITS, ...overrides };
  const serverKernel = normalizeKernel(kernel);
  const nowMs = () => +now();
  const iso = () => new Date(nowMs()).toISOString();
  const links = new Map();    // tokenId -> state
  const windows = new Map();  // tokenId -> {start, count}
  const transfersDir = tokenId => path.join(dir, 'customers', tokenId, 'state', 'transfers');

  const record = tokenId => { try { return store.lookup(tokenId); } catch { return undefined; } };

  function stateOf(tokenId) {
    let state = links.get(tokenId);
    if (state) return state;
    const rec = record(tokenId);
    state = { tokenId, customer: rec?.customer ?? null, lanes: rec?.lanes ?? [], channel: null, instance: null, hello: null,
      connectedAt: null, lastSeenAt: null, pending: new Map(), transfers: new Map(), listeners: new Set(), closedFor: null, seq: 0, api: null,
      probes: new Map(), uploads: { parts: 0, slow: [] },
      previousChannel: null, waiters: new Set(), unserved: new Map() };
    state.api = linkApi(state);
    links.set(tokenId, state);
    return state;
  }

  // ---------------------------------------------------------------- channel and pending calls
  function write(channel, message) {
    const stream = channel?.stream;
    if (!stream || stream.writableEnded || stream.destroyed) return false;
    stream.write((typeof message === 'string' ? message : JSON.stringify(message)) + '\n');
    return true;
  }
  // A written call that is not accepted in acceptMs (C03): the stream is taken as dead and closed, so a live agent reconnects
  // now instead of after the whole deadline; the call stays pending, is written again on the resumed stream and gets one
  // reconnectGraceMs more.
  function writeCall(state, pending) {
    if (!write(state.channel, pending.line)) return;
    pending.written = true;
    clearTimeout(pending.acceptTimer);
    const channel = state.channel;
    pending.acceptTimer = setTimeout(() => {
      if (state.pending.get(pending.id) !== pending || pending.accepted || state.channel !== channel) return;
      log({ event: 'agent-call-unaccepted', token: state.tokenId, kind: pending.kind, afterMs: limits.acceptMs });
      if (!pending.graced) {
        pending.graced = true;
        clearTimeout(pending.timer);
        pending.deadline += limits.reconnectGraceMs;
        pending.timer = setTimeout(() => fail(state, pending, 'AGENT_TIMEOUT', 'The agent did not answer ' + pending.kind + ' before the deadline.'),
          Math.min(2147483647, Math.max(0, pending.deadline - nowMs())));
      }
      closeChannel(state, null);
    }, limits.acceptMs);
    pending.acceptTimer.unref?.();
  }
  // A recently seen agent (Hello known, last contact within recentMs) that lost its channel: it reconnects by itself.
  const recentlySeen = state => !!state.instance && Number.isFinite(Date.parse(state.lastSeenAt ?? '')) && nowMs() - Date.parse(state.lastSeenAt) < limits.recentMs;
  // Resolves true when a Hello opens a channel within ms, false otherwise (never rejects).
  function waitConnected(state, ms) {
    if (state.channel) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = value => { clearTimeout(timer); state.waiters.delete(done); resolve(value); };
      const timer = setTimeout(() => done(false), Math.max(0, ms));
      timer.unref?.();
      state.waiters.add(done);
    });
  }
  function reconnectingError(state) {
    const seconds = Math.max(0, Math.round((nowMs() - Date.parse(state.lastSeenAt)) / 1000));
    return callError('AGENT_RECONNECTING', 'The SSAM agent of this account lost its connection ' + seconds + ' s ago and is reconnecting by itself; nothing ran.',
      { retryAfterSeconds: 15, lastSeenSecondsAgo: seconds, continuation: { tool: 'ssam_doctor', arguments: {},
        why: 'the agent reconnects by itself: repeat the same call in 15 s; the doctor shows when it is back' } });
  }

  // C33: one agent-call line per settled call {kind, ms, ok, code}: the relay's own timing, never arguments or values.
  // prazos B: an o11.bridge call also names its bridge method and, for environment_session, the environment operation
  // (protocol verbs, never values): the 89.8 s and 60 s calls of 2026-10-12 were only "o11.bridge" in this log.
  function settle(state, pending, outcome = {}) {
    if (state.pending.get(pending.id) !== pending) return false;
    state.pending.delete(pending.id);
    clearTimeout(pending.timer); clearTimeout(pending.acceptTimer);
    if (pending.blob) dropTransfer(state, pending.blob);
    const verbs = pending.verbs;
    const ms = nowMs() - pending.startedAt;
    log({ event: 'agent-call', token: state.tokenId, kind: pending.kind, ...verbs, ms, ...outcome });
    try {
      onCallSettled?.({ tokenId: state.tokenId, kind: pending.kind, verb: verbs.method ?? verbs.command ?? null, startMs: pending.startedAt, ms, ok: outcome.ok !== false,
        code: outcome.code ?? null, ...(pending.bytes ? { bytes: pending.bytes } : {}), callKey: pending.callKey ?? null });
    } catch { /* the quality record never changes a call */ }
    return true;
  }
  // Never written to a stream: nothing can have run (executed:false). Written: the outcome is unknown (executed:null).
  function fail(state, pending, code, message) {
    if (!settle(state, pending, { ok: false, code })) return;
    pending.reject(callError(code, message, { executed: pending.written ? null : false, delivered: pending.written }));
  }
  function failAll(state, code, message) { for (const pending of [...state.pending.values()]) fail(state, pending, code, message); }

  // Ends the current channel. A reason sends Close first; none (dead, clean shutdown) just ends the stream.
  function closeChannel(state, reason, message) {
    const channel = state.channel;
    if (!channel) return;
    state.channel = null;
    // A POST already on its way on this channel (accepted, result) is still taken after it closes (C03).
    state.previousChannel = channel.id;
    clearInterval(channel.pingTimer);
    if (channel.stream) {
      if (reason) write(channel, { t: 'close', reason, message });
      channel.stream.end();
      channel.stream = null;
    }
    log({ event: 'agent-channel-closed', token: state.tokenId, reason: reason ?? 'ended' });
  }

  // Revoked, expired or server stop: no channel, no pending call, no transfer; the onClose listeners hear it once.
  function endLink(state, reason) {
    const messages = { revoked: 'The token was revoked by the server owner.', expired: 'The token expired.', 'server-stop': 'The SSAM server stopped.' };
    closeChannel(state, reason, messages[reason]);
    failAll(state, reason === 'server-stop' ? 'AGENT_DISCONNECTED' : 'AGENT_REVOKED', messages[reason]);
    dropTransfers(state);
    state.instance = null;
    // Once per link: a revoked link that the server then stops is not closed again (a new Hello resets it).
    if (state.closedFor) return;
    state.closedFor = reason;
    for (const fn of [...state.listeners]) { try { fn(reason); } catch { /* a listener never stops the others */ } }
  }

  // ---------------------------------------------------------------- transfers
  function dropTransfer(state, transfer) {
    if (state.transfers.get(transfer.id) !== transfer) return;
    state.transfers.delete(transfer.id);
    if (transfer.direction === 'up') { try { fs.rmSync(transfer.dir, { recursive: true, force: true }); } catch { /* removed at the next start at worst */ } }
  }
  function dropTransfers(state, direction) {
    for (const transfer of [...state.transfers.values()]) if (!direction || transfer.direction === direction) dropTransfer(state, transfer);
  }
  function registerDown(state, source) {
    const id = randomBytes(16).toString('hex');
    const size = source.buffer ? source.buffer.length : source.size;
    const ref = { transfer: id, sha256: source.buffer ? sha256Of(source.buffer) : source.sha256, size,
      parts: Math.max(1, Math.ceil(size / limits.partBytes)), partBytes: limits.partBytes };
    const transfer = { id, direction: 'down', ref, buffer: source.buffer ?? null, file: source.file ?? null, held: !!source.held, lastAccess: nowMs() };
    state.transfers.set(id, transfer);
    return transfer;
  }
  // An agent upload named by a BlobRef that came from the agent: same token, same total hash, size and parts.
  function uploaded(state, ref) {
    const transfer = typeof ref?.transfer === 'string' && HEX32.test(ref.transfer) ? state.transfers.get(ref.transfer) : null;
    if (!transfer || transfer.direction !== 'up') throw callError('TRANSFER_INVALID', 'The agent named a transfer it never uploaded.', { executed: null, delivered: true });
    if (ref.sha256 !== transfer.sha256 || ref.size !== transfer.size || ref.parts !== transfer.parts) {
      dropTransfer(state, transfer);
      throw callError('BLOB_HASH_MISMATCH', 'The BlobRef does not match the uploaded parts.', { executed: null, delivered: true });
    }
    if (transfer.received.size !== transfer.parts) throw callError('TRANSFER_INVALID', 'The upload is incomplete (' + transfer.received.size + ' of ' + transfer.parts + ' parts).', { executed: null, delivered: true });
    return transfer;
  }
  const partFile = (transfer, index) => path.join(transfer.dir, index + '.part');
  function dropUploaded(state, ref) {
    const transfer = typeof ref?.transfer === 'string' && HEX32.test(ref.transfer) ? state.transfers.get(ref.transfer) : null;
    if (transfer?.direction === 'up') dropTransfer(state, transfer);
  }

  async function blobValue(state, ref) {
    const transfer = uploaded(state, ref);
    try {
      // Checked before any part is read: a larger value never enters memory.
      if (transfer.size > limits.maxValueBytes) throw callError('VALUE_TOO_LARGE', 'The result value has ' + transfer.size + ' bytes, above the '
        + limits.maxValueBytes + ' a value may have; nothing was read.', { executed: null, delivered: true });
      const parts = [];
      for (let i = 0; i < transfer.parts; i++) parts.push(await fs.promises.readFile(partFile(transfer, i)));
      const bytes = Buffer.concat(parts);
      if (bytes.length !== transfer.size || sha256Of(bytes) !== transfer.sha256) throw callError('BLOB_HASH_MISMATCH', 'The assembled value does not match its sha256.', { executed: null, delivered: true });
      try { return JSON.parse(bytes.toString('utf8')); }
      catch { throw callError('AGENT_PROTOCOL_VIOLATION', 'The value blob is not JSON.', { executed: null, delivered: true }); }
    } finally { dropTransfer(state, transfer); }
  }

  async function receiveBlob(state, ref, dest) {
    const transfer = uploaded(state, ref);
    const temp = dest + '.' + randomBytes(6).toString('hex') + '.part';
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      const hash = createHash('sha256'); let size = 0;
      const out = await fs.promises.open(temp, 'wx');
      try {
        for (let i = 0; i < transfer.parts; i++) {
          const bytes = await fs.promises.readFile(partFile(transfer, i));
          hash.update(bytes); size += bytes.length;
          await out.write(bytes);
        }
      } finally { await out.close(); }
      const sha256 = hash.digest('hex');
      if (sha256 !== transfer.sha256 || size !== transfer.size) {
        log({ event: 'agent-blob-mismatch', token: state.tokenId, transfer: transfer.id });
        throw callError('BLOB_HASH_MISMATCH', 'The assembled file does not match its sha256; nothing was written.');
      }
      await fs.promises.rename(temp, dest);
      return { sha256, size };
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => {});
      dropTransfer(state, transfer);
    }
  }

  // ---------------------------------------------------------------- AgentLink (I-1)
  function linkApi(state) {
    return {
      tokenId: state.tokenId,
      get customer() { return state.customer; },
      connected: () => !!state.channel,
      info() {
        const rec = record(state.tokenId);
        if (rec) state.lanes = rec.lanes;
        const hello = state.hello;
        return { connected: !!state.channel, credential: !!rec?.credential, instance: state.instance, agentVersion: hello?.agent?.version ?? null,
          agentRoot: hello?.agent?.root ?? null, agentKinds: hello?.agent?.kinds ?? null, agentPlatform: hello?.agent?.platform ?? null,
          connectedAt: state.connectedAt, lastSeenAt: state.lastSeenAt, lanes: [...state.lanes], pack: hello?.pack ?? null,
          studios: hello?.studios ?? null, o11Connection: hello?.o11Connection ?? null, kernel: { ...serverKernel },
          compatible: compatibility(hello, serverKernel, state.lanes, { refused: kernelRefused }) };
      },
      // A1 (round 2): a Studio process the executor or the gate refused (studio-identity.mjs), named once like the hub's.
      studioUnserved: (lane, studio, cause) => logUnserved(state, lane, studio, cause),
      // C03: true when the agent is connected now or a Hello opens its channel within ms.
      waitConnected: ms => waitConnected(state, ms),
      // The kinds the connected agent runs (Hello agent.kinds, agent 0.2.0+); an older agent runs the nine of protocol 1.
      supports: kind => (Array.isArray(state.hello?.agent?.kinds) ? state.hello.agent.kinds.includes(kind) : CALL_KINDS.slice(0, 9).includes(kind)),
      // A server->agent transfer the agent will never fetch (file.put answered skipped): released now, not after 10 min.
      releaseTransfer(ref) { const transfer = typeof ref?.transfer === 'string' ? state.transfers.get(ref.transfer) : null; if (transfer?.direction === 'down') dropTransfer(state, transfer); },
      call(kind, params = {}, { timeoutMs } = {}) {
        if (!CALL_KINDS.includes(kind)) return Promise.reject(callError('KIND_NOT_ALLOWED', 'Not an agent call kind: ' + String(kind).slice(0, 64)));
        if (!state.channel) {
          if (!recentlySeen(state)) return Promise.reject(callError('AGENT_NOT_CONNECTED', 'The SSAM agent of this account is not connected.'));
          // C03: a recently seen agent reconnects by itself; the call waits for its Hello instead of failing at once.
          return waitConnected(state, limits.reconnectWaitMs).then(connected => (connected ? state.api.call(kind, params, { timeoutMs })
            : Promise.reject(recentlySeen(state) ? reconnectingError(state) : callError('AGENT_NOT_CONNECTED', 'The SSAM agent of this account is not connected.'))));
        }
        if (state.pending.size >= limits.maxPending) return Promise.reject(callError('AGENT_BUSY', 'The agent already has ' + limits.maxPending + ' calls pending.'));
        const id = randomUUID();
        const deadline = nowMs() + (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : limits.callTimeoutMs);
        let line = JSON.stringify({ t: 'call', id, kind, params, deadline });
        let blob = null;
        // Measured on the whole serialized message: escaped JSON and non-ASCII text count as they travel.
        if (Buffer.byteLength(line) > limits.inlineMaxBytes) {
          blob = registerDown(state, { buffer: Buffer.from(JSON.stringify(params), 'utf8'), held: true });
          line = JSON.stringify({ t: 'call', id, kind, paramsBlob: { ...blob.ref }, deadline });
        }
        return new Promise((resolve, reject) => {
          const pending = { id, kind, line, written: false, accepted: false, blob, resolve, reject, timer: null, acceptTimer: null, deadline, graced: false, startedAt: nowMs(),
            verbs: callVerbs(kind, params),
            callKey: currentCall(), bytes: bytesDown(kind, params, blob) };
          pending.timer = setTimeout(() => fail(state, pending, 'AGENT_TIMEOUT', 'The agent did not answer ' + kind + ' before the deadline.'),
            Math.min(2147483647, Math.max(0, deadline - nowMs())));
          state.pending.set(id, pending);
          writeCall(state, pending);
        });
      },
      async putFile(absPath) {
        const stat = await fs.promises.stat(absPath).catch(() => null);
        if (!stat?.isFile()) throw callError('FILE_NOT_FOUND', 'Not a file on the server.');
        if (stat.size > limits.maxFileBytes) throw callError('FILE_TOO_LARGE', 'The file is larger than ' + limits.maxFileBytes + ' bytes.');
        const transfer = registerDown(state, { file: absPath, size: stat.size, sha256: await hashFile(absPath) });
        return { ...transfer.ref };
      },
      receiveBlob: (ref, destAbsPath) => receiveBlob(state, ref, destAbsPath),
      // fase4-24 (2.10): what the hub saw of the network check's uploads (by id, each taken once), and the upload parts of
      // this token with the slow ones of the last uploadWindowMs.
      probes(ids) {
        const out = [];
        for (const id of Array.isArray(ids) ? ids : []) { const record = state.probes.get(id); if (record) { out.push({ ...record }); state.probes.delete(id); } }
        return out;
      },
      uploads() {
        const since = nowMs() - limits.uploadWindowMs;
        const slow = state.uploads.slow.filter(entry => entry.atMs >= since);
        return { parts: state.uploads.parts, slow: slow.length, recent: slow.slice(-5).map(({ atMs, ...rest }) => ({ ...rest, at: new Date(atMs).toISOString() })) };
      },
      protocolError(message) { closeChannel(state, 'protocol-error', String(message ?? 'Protocol error').slice(0, 500)); },
      onClose(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); },
    };
  }

  // ---------------------------------------------------------------- routes
  function rateLimited(tokenId) {
    const at = Date.now();
    const w = windows.get(tokenId);
    if (!w || at - w.start >= 60000) { windows.set(tokenId, { start: at, count: 1 }); return 0; }
    w.count++;
    return w.count > limits.ratePerMinute ? Math.ceil((w.start + 60000 - at) / 1000) : 0;
  }

  // E1 (A-M1, C:\t\multiver\minimo\PROPOSTA.md): a Studio the server does not serve (studio-identity.mjs) is named once per
  // token, lane, installed and served version, when the hub first judges it (Hello or pong.versions): the owner learns who
  // a Studio update (or a server update) cut, before the first refused call. The token id, the lane, version numbers and
  // codes only: never a credential, a folder or an argument. A lane served again forgets its entry.
  function noteUnserved(state, compatible) {
    const observed = Object.fromEntries(LANES.filter(lane => state.lanes.includes(lane)).map(lane => {
      const studio = studioIdentity(lane, state.hello?.studios?.[lane]?.installed, serverKernel);
      return [lane, {studio, ok: studio?.ok, cause: causeOf(studio)}];
    }));
    try { recordStudioVersions(dir, state, observed, iso()); }
    catch (error) { log({ event: 'studio-versions-write-failed', code: error.code ?? 'EIO' }); }
    for (const lane of LANES) {
      const entry = observed[lane];
      if (!entry?.studio || !entry.studio.installed || (entry.ok !== false && entry.studio.relation !== 'newer')) { state.unserved.delete(lane); continue; }
      logUnserved(state, lane, entry.studio, entry.cause ?? 'STUDIO_VERSION_NOT_SERVED_YET');
    }
  }
  // A1 (round 2): the same line for a refusal of the PROCESS a call goes to (AgentLink studioUnserved, from the
  // AgentExecutor and the gate), with the same key: one event per Studio, whoever saw it first.
  function logUnserved(state, lane, studio, cause) {
    if (!LANES.includes(lane) || !studio || typeof cause !== 'string') return;
    const key = studio.installed + '>' + studio.served + ':' + studio.policy;
    if (state.unserved.get(lane) === key) return;
    state.unserved.set(lane, key);
    log({ event: 'studio-version-unserved', token: state.tokenId, lane, installed: studio.installed, served: studio.served, relation: studio.relation,
      cause, policy: studio.policy });
  }

  async function hello(state, auth, req, res) {
    const read = await readJson(req, limits.maxMessageBytes);
    if (read.tooLarge) return reply(res, 413, 'MESSAGE_TOO_LARGE', 'Hello larger than ' + limits.maxMessageBytes + ' bytes.', { connection: 'close' });
    const h = read.value;
    if (read.invalid || h?.t !== 'hello' || typeof h !== 'object') return reply(res, 400, 'MESSAGE_INVALID', 'Not a hello message.');
    if (h.protocol !== PROTOCOL) return reply(res, 409, 'AGENT_PROTOCOL_UNSUPPORTED', 'This server speaks ' + PROTOCOL + '.');
    if (typeof h.instance !== 'string' || !INSTANCE.test(h.instance)) return reply(res, 400, 'MESSAGE_INVALID', 'Hello.instance must be a UUID.');
    // Machine alert (owner test, 2026-10-08): the first machine an agent reports is recorded for its token in
    // <dir>/machine-pins.json. Another machine is NOT refused: the server logs agent-machine-changed, appends the alert to
    // <dir>/access-alerts.jsonl and shows a Windows notification on the server machine. The owner reads, decides, and may
    // revoke the token. An agent that reports no machine (before the access-trail pack) is not judged.
    const machineId = typeof h.agent?.machine?.id === 'string' ? h.agent.machine.id.slice(0, 32) : null;
    if (dir && machineId) {
      const seen = { id: machineId, name: String(h.agent.machine.name ?? '').slice(0, 64), user: String(h.agent.machine.user ?? '').slice(0, 64) };
      const ip = (String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || '').slice(0, 64);
      const pinFile = path.join(dir, 'machine-pins.json');
      let pins = {};
      try { pins = JSON.parse(fs.readFileSync(pinFile, 'utf8')); } catch { pins = {}; }
      const first = pins[state.tokenId];
      if (!first) {
        pins[state.tokenId] = { ...seen, at: iso() };
        try { fs.writeFileSync(pinFile, JSON.stringify(pins, null, 2)); log({ event: 'agent-machine-pinned', token: state.tokenId, machine: pins[state.tokenId], ip }); } catch { /* recorded on the next hello */ }
      } else if (first.id !== machineId) {
        const alert = { time: iso(), event: 'agent-machine-changed', token: state.tokenId, customer: auth.customer, first, machine: seen, ip };
        log(alert);
        try { fs.appendFileSync(path.join(dir, 'access-alerts.jsonl'), JSON.stringify(alert) + '\n'); } catch { /* the log line stays */ }
        notifyOwner('SSAM: access from another machine', `${auth.customer}: ${seen.name} (${seen.user}) instead of ${first.name} (${first.user}). IP ${ip}`);
      }
    }
    const resumed = state.instance === h.instance;
    if (resumed) closeChannel(state, null);
    else {
      if (state.channel) log({ event: 'agent-replaced', token: state.tokenId });
      closeChannel(state, 'replaced', 'Another SSAM agent connected with this credential.');
      failAll(state, 'AGENT_DISCONNECTED', 'The agent instance was replaced by another one.');
      dropTransfers(state, 'up');
    }
    state.customer = auth.customer; state.lanes = auth.lanes; state.closedFor = null;
    state.instance = h.instance;
    state.hello = { agent: h.agent ?? null, pack: h.pack ?? null, studios: h.studios ?? null, o11Connection: h.o11Connection ?? null };
    state.connectedAt = iso(); state.lastSeenAt = state.connectedAt;
    state.channel = { id: randomBytes(16).toString('hex'), agentSha256: auth.agentSha256, stream: null, pingTimer: null, lastPostAt: nowMs() };
    // A replacing instance: the old channel's late POSTs belong to calls that already failed.
    if (!resumed) state.previousChannel = null;
    for (const done of [...state.waiters]) done(true);
    // Access trail (owner test, 2026-10-08): client IP behind the tunnel, the machine the agent reports, the O11 connection.
    const machine = h.agent?.machine && typeof h.agent.machine === 'object'
      ? { id: String(h.agent.machine.id ?? '').slice(0, 32), name: String(h.agent.machine.name ?? '').slice(0, 64), user: String(h.agent.machine.user ?? '').slice(0, 64) } : null;
    const ip = (String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || '').slice(0, 64);
    // E1 (A-M1): the version of each installed Studio, the numbers only (studioVersions: never the folder).
    log({ event: resumed ? 'agent-resumed' : 'agent-connected', token: state.tokenId, agent: String(h.agent?.version ?? '?').slice(0, 32),
      ip, machine, o11: h.o11Connection ? JSON.stringify(h.o11Connection).slice(0, 200) : null, studios: studioVersions(h.studios) });
    const compatible = compatibility(state.hello, serverKernel, state.lanes, { refused: kernelRefused });
    noteUnserved(state, compatible);
    const welcome = { t: 'welcome', channel: state.channel.id, customer: auth.customer, resumed,
      heartbeatMs: limits.heartbeatMs, deadAfterMs: limits.deadAfterMs, maxMessageBytes: limits.maxMessageBytes,
      inlineMaxBytes: limits.inlineMaxBytes, partBytes: limits.partBytes, maxFileBytes: limits.maxFileBytes, maxValueBytes: limits.maxValueBytes,
      kernel: { ...serverKernel }, compatible };
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(welcome));
    return true;
  }

  function stream(state, req, res) {
    const channel = state.channel;
    if (channel.stream) { clearInterval(channel.pingTimer); channel.stream.end(); channel.stream = null; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    // A first byte right behind the headers: a reverse proxy written in Go (Traefik, as Coolify runs it) holds the
    // response headers until the first byte of the body arrives, and the first ping only comes after heartbeatMs
    // (15 s), exactly the time the agent waits for the headers of its stream (STREAM_HEADERS_MS): behind such a proxy
    // every stream was aborted at 15 s (2026-10-21). An empty NDJSON line is skipped by the agent (channel.mjs).
    res.write('\n');
    channel.stream = res;
    res.on('close', () => { if (channel.stream === res) { channel.stream = null; clearInterval(channel.pingTimer); } });
    channel.pingTimer = setInterval(() => write(channel, { t: 'ping', seq: ++state.seq, at: nowMs() }), limits.heartbeatMs);
    channel.pingTimer.unref?.();
    // A (re)opened stream carries every call never accepted; an accepted one waits for its result (outbox, 3.4).
    for (const pending of state.pending.values()) if (!pending.accepted) writeCall(state, pending);
    log({ event: 'agent-stream-opened', token: state.tokenId });
    return true;
  }

  async function messages(state, channelId, req, res) {
    const read = await readJson(req, limits.maxMessageBytes);
    if (read.tooLarge) return reply(res, 413, 'MESSAGE_TOO_LARGE', 'Batch larger than ' + limits.maxMessageBytes + ' bytes.', { connection: 'close' });
    if (read.invalid || !Array.isArray(read.value?.messages)) return reply(res, 400, 'MESSAGE_INVALID', 'Expected {"messages":[...]}.');
    const current = state.channel?.id === channelId;
    if (!current && !(channelId === state.previousChannel && state.instance)) return reply(res, 404, 'CHANNEL_UNKNOWN', 'Unknown channel.');
    if (current) state.channel.lastPostAt = nowMs();
    state.lastSeenAt = iso();
    for (const message of read.value.messages) await uplink(state, message);
    res.writeHead(204); res.end();
    return true;
  }

  async function uplink(state, m) {
    if (m?.t === 'pong') {
      if (m.versions && typeof m.versions === 'object' && state.hello) {
        if ('studios' in m.versions) state.hello.studios = m.versions.studios ?? null;
        if ('o11Connection' in m.versions) state.hello.o11Connection = m.versions.o11Connection ?? null;
        // a Studio that changed under a connected agent is judged now (the gate reads info() on every call)
        if ('studios' in m.versions) noteUnserved(state, compatibility(state.hello, serverKernel, state.lanes, { refused: kernelRefused }));
      }
      return;
    }
    if (m?.t !== 'accepted' && m?.t !== 'result') { log({ event: 'agent-unknown-message', token: state.tokenId }); return; }
    const pending = typeof m.id === 'string' ? state.pending.get(m.id) : undefined;
    // Only the calls pending for THIS token: a stale, repeated or foreign id changes nothing, except that the uploads a
    // late result names (its valueBlob, a file.get blob) are freed now instead of holding an upload slot for 10 min.
    if (!pending) {
      log({ event: 'agent-unknown-id', token: state.tokenId, type: m.t });
      if (m.t === 'result') for (const ref of [m.valueBlob, m.value?.blob]) dropUploaded(state, ref);
      return;
    }
    pending.written = true;
    if (m.t === 'accepted') { pending.accepted = true; clearTimeout(pending.acceptTimer); return; }
    // What came back up, when its size is known: the file of a file.get, a value blob.
    if (m.ok === true) pending.bytes = (pending.bytes ?? 0) + sizeOf(m.valueBlob) + (pending.kind === 'file.get' ? sizeOf(m.value?.blob) : 0);
    if (!settle(state, pending, m.ok === true ? { ok: true } : { ok: false, code: typeof m.error?.code === 'string' && CODE.test(m.error.code) ? m.error.code : 'AGENT_ERROR' })) return;
    if (m.ok === true) {
      if (m.valueBlob === undefined) { pending.resolve(m.value); return; }
      try { pending.resolve(await blobValue(state, m.valueBlob)); } catch (error) { pending.reject(error); }
      return;
    }
    const e = m.error && typeof m.error === 'object' ? m.error : {};
    pending.reject(callError(typeof e.code === 'string' && CODE.test(e.code) ? e.code : 'AGENT_ERROR',
      typeof e.message === 'string' ? e.message.slice(0, 4000) : 'The agent reported an error.',
      { executed: typeof e.executed === 'boolean' ? e.executed : null, delivered: true, ...(typeof e.sent === 'boolean' ? { sent: e.sent } : {}) }));
  }

  async function putPart(state, transferId, index, req, res) {
    const header = name => String(req.headers[name] ?? '').trim().toLowerCase();
    const partSha = header('x-ssam-part-sha256'), totalSha = header('x-ssam-total-sha256'), totalSize = header('x-ssam-total-size'), parts = header('x-ssam-parts');
    if (!SHA256.test(partSha) || !SHA256.test(totalSha) || !SIZE.test(totalSize) || !INDEX.test(parts))
      return reply(res, 400, 'TRANSFER_INVALID', 'Missing or malformed x-ssam-part-sha256, x-ssam-total-sha256, x-ssam-total-size or x-ssam-parts.');
    const size = Number(totalSize);
    if (size > limits.maxFileBytes) return reply(res, 413, 'FILE_TOO_LARGE', 'Files are limited to ' + limits.maxFileBytes + ' bytes.', { connection: 'close' });
    const count = Math.max(1, Math.ceil(size / limits.partBytes));
    if (Number(parts) !== count || index >= count) return reply(res, 400, 'TRANSFER_INVALID', 'Part index or part count out of range.');
    const known = state.transfers.get(transferId);
    if (known && (known.direction !== 'up' || known.sha256 !== totalSha || known.size !== size)) return reply(res, 409, 'TRANSFER_CONFLICT', 'This transfer was registered with another file.');
    if (!known && [...state.transfers.values()].filter(t => t.direction === 'up').length >= limits.maxTransfers)
      return reply(res, 429, 'TRANSFER_LIMIT', 'At most ' + limits.maxTransfers + ' uploads at a time.', { 'retry-after': '1' });
    const expected = index < count - 1 ? limits.partBytes : size - (count - 1) * limits.partBytes;
    const startedAt = performance.now();
    const read = await readBody(req, limits.partBytes);
    if (!read.tooLarge) noteUpload(state, read.body.length, performance.now() - startedAt, addressOf(req));
    if (read.tooLarge) return reply(res, 413, 'MESSAGE_TOO_LARGE', 'Parts are limited to ' + limits.partBytes + ' bytes.', { connection: 'close' });
    if (read.body.length !== expected) return reply(res, 400, 'TRANSFER_INVALID', 'Part ' + index + ' must have ' + expected + ' bytes.');
    if (sha256Of(read.body) !== partSha) return reply(res, 400, 'PART_HASH_MISMATCH', 'The part does not match x-ssam-part-sha256.');
    let transfer = state.transfers.get(transferId);
    if (transfer && (transfer.direction !== 'up' || transfer.sha256 !== totalSha || transfer.size !== size)) return reply(res, 409, 'TRANSFER_CONFLICT', 'This transfer was registered with another file.');
    if (transfer?.received.has(index)) {
      if (transfer.received.get(index) !== partSha) return reply(res, 409, 'TRANSFER_CONFLICT', 'Part ' + index + ' was already received with other content.');
      transfer.lastAccess = nowMs(); res.writeHead(204); res.end(); return true;
    }
    if (!transfer) {
      transfer = { id: transferId, direction: 'up', sha256: totalSha, size, parts: count, received: new Map(), dir: path.join(transfersDir(state.tokenId), transferId), lastAccess: nowMs() };
      state.transfers.set(transferId, transfer);
    }
    await fs.promises.mkdir(transfer.dir, { recursive: true });
    const temp = partFile(transfer, index) + '.' + randomBytes(4).toString('hex');
    await fs.promises.writeFile(temp, read.body);
    await fs.promises.rename(temp, partFile(transfer, index));
    transfer.received.set(index, partSha); transfer.lastAccess = nowMs();
    res.writeHead(204); res.end();
    return true;
  }

  // fase4-24 (2.10): how long each upload part took, per token. The slow ones of the last uploadWindowMs (at most 32) go to
  // ssam_doctor (agent.uploads), so a session that lost seconds to a stalled exit is told to run the network check.
  function noteUpload(state, bytes, ms, address) {
    state.uploads.parts++;
    if (!slowUpload(bytes, ms, limits.uploadSlowMs)) return;
    state.uploads.slow.push({ atMs: nowMs(), bytes, ms: Math.round(ms), via: maskAddress(address) });
    if (state.uploads.slow.length > 32) state.uploads.slow.shift();
    log({ event: 'agent-upload-slow', token: state.tokenId, bytes, ms: Math.round(ms), via: maskAddress(address) });
  }

  // PUT /agent/v1/probe/<id> (fase4-24, 2.10): one upload of the network check (kind net.probe). The bytes are counted and
  // discarded; the hub keeps, per token and in memory only, where the upload came from (the exit, masked), what arrived and
  // when, so the doctor can tell an upload that reached the server and stalled from one that never got here.
  async function probeUpload(state, id, req, res) {
    const startedAt = performance.now();
    const record = { id, via: maskAddress(addressOf(req)), at: iso(), received: 0, complete: false, ms: null };
    state.probes.set(id, record);
    while (state.probes.size > limits.probeRecords) state.probes.delete(state.probes.keys().next().value);
    // received grows while the body arrives: a doctor that asks before a stalled upload is closed reads what came so far.
    const read = await readProbe(req, limits.probeMaxBytes, bytes => { record.received += bytes; record.ms = Math.round(performance.now() - startedAt); });
    record.received = Math.min(read.size, limits.probeMaxBytes + 1); record.ms = Math.round(performance.now() - startedAt);
    if (read.tooLarge) return reply(res, 413, 'PROBE_TOO_LARGE', 'Probe uploads are limited to ' + limits.probeMaxBytes + ' bytes.', { connection: 'close' });
    if (!read.complete) { res.destroy(); return true; }
    record.complete = true;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, bytes: read.size, ms: record.ms, via: record.via }));
    return true;
  }

  async function getPart(state, transferId, index, res) {
    const transfer = state.transfers.get(transferId);
    if (!transfer || transfer.direction !== 'down') return reply(res, 404, 'TRANSFER_UNKNOWN', 'Unknown transfer.');
    if (index >= transfer.ref.parts) return reply(res, 400, 'TRANSFER_INVALID', 'Part index out of range.');
    const start = index * limits.partBytes, length = Math.min(limits.partBytes, transfer.ref.size - start);
    let bytes;
    if (transfer.buffer) bytes = transfer.buffer.subarray(start, start + length);
    else {
      const handle = await fs.promises.open(transfer.file, 'r').catch(() => null);
      if (!handle) { dropTransfer(state, transfer); return reply(res, 404, 'FILE_NOT_FOUND', 'The file of this transfer is gone.'); }
      try { const buffer = Buffer.alloc(Math.max(0, length)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, start); bytes = buffer.subarray(0, bytesRead); }
      finally { await handle.close(); }
    }
    transfer.lastAccess = nowMs();
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length), 'cache-control': 'no-store',
      'x-ssam-part-sha256': sha256Of(bytes), 'x-ssam-total-sha256': transfer.ref.sha256, 'x-ssam-total-size': String(transfer.ref.size), 'x-ssam-parts': String(transfer.ref.parts) });
    res.end(bytes);
    return true;
  }

  // /agent/v1/* (called by http-server after its Host/Origin checks). Returns false for any other path.
  async function handle(req, res) {
    const { segments, channel } = rawTarget(req.url);
    if (segments[0] !== '' || segments[1] !== 'agent') return false;
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!bearer) return reply(res, 401, 'AGENT_CREDENTIAL_MISSING', 'Missing agent credential.', { 'www-authenticate': 'Bearer realm="ssam-agent"' });
    // An MCP token never opens the agent channel (and an agent credential never opens /mcp).
    if (!bearer.startsWith(AGENT_PREFIX)) return reply(res, 401, 'AGENT_CREDENTIAL_UNKNOWN', 'Only an agent credential (ssam_agent_...) is accepted here.', { 'www-authenticate': 'Bearer realm="ssam-agent", error="invalid_token"' });
    let auth;
    try { auth = store.verifyAgent(bearer); } catch { log({ event: 'tokens-unreadable' }); return reply(res, 500, 'TOKEN_STORE_UNAVAILABLE', 'Token store unavailable.'); }
    if (auth.status === 'unknown') return reply(res, 401, 'AGENT_CREDENTIAL_UNKNOWN', 'Unknown agent credential.', { 'www-authenticate': 'Bearer realm="ssam-agent", error="invalid_token"' });
    if (auth.status !== 'ok') {
      if (links.has(auth.id)) endLink(links.get(auth.id), auth.status === 'expired' ? 'expired' : 'revoked');
      return reply(res, 403, auth.status === 'expired' ? 'AGENT_EXPIRED' : 'AGENT_REVOKED', auth.status === 'expired' ? 'Token expired.' : 'Token revoked.');
    }
    const retry = rateLimited(auth.id);
    if (retry) return reply(res, 429, 'RATE_LIMITED', 'Rate limit: ' + limits.ratePerMinute + ' agent requests per minute.', { 'retry-after': String(retry) });
    const state = stateOf(auth.id);
    const [version, route, transferId, index, extra] = segments.slice(2);
    const method = req.method;
    if (version !== 'v1') return reply(res, 404, 'NOT_FOUND', 'Not found.');
    if (route === 'hello' && transferId === undefined && method === 'POST') return hello(state, auth, req, res);
    const known = (route === 'stream' && method === 'GET') || (route === 'messages' && method === 'POST') || (route === 'channel' && method === 'DELETE');
    const blob = route === 'blobs' && (method === 'PUT' || method === 'GET');
    const probe = route === 'probe' && method === 'PUT';
    if (!(known && transferId === undefined) && !(blob && index !== undefined && extra === undefined) && !(probe && transferId !== undefined && index === undefined))
      return reply(res, 404, 'NOT_FOUND', 'Not found.');
    // Raw formats first, then memory, then (only for a valid part) the disk.
    if (blob && (!HEX32.test(transferId) || !INDEX.test(index))) return reply(res, 400, 'TRANSFER_INVALID', 'Transfer id or part index out of format.');
    if (probe && !HEX32.test(transferId)) return reply(res, 400, 'PROBE_INVALID', 'Probe id out of format.');
    // The previous channel of the same instance still takes the POSTs and the blob parts already on their way (C03).
    const previous = channel !== null && channel === state.previousChannel && !!state.instance && (route === 'messages' || blob || probe);
    if (channel === null || !HEX32.test(channel) || (state.channel?.id !== channel && !previous)) {
      log({ event: 'agent-route-refused', token: auth.id, route: String(route ?? '').slice(0, 16), status: 404, code: 'CHANNEL_UNKNOWN' });
      return reply(res, 404, 'CHANNEL_UNKNOWN', 'Unknown channel.');
    }
    if (route === 'stream') return stream(state, req, res);
    if (route === 'messages') return messages(state, channel, req, res);
    if (route === 'channel') {
      // Clean shutdown: the instance is gone, so its pending calls can never get a result.
      closeChannel(state, null);
      failAll(state, 'AGENT_DISCONNECTED', 'The agent shut down.');
      dropTransfers(state, 'up');
      state.instance = null;
      res.writeHead(204); res.end();
      return true;
    }
    if (state.channel?.id === channel) state.channel.lastPostAt = nowMs();
    state.lastSeenAt = iso();
    if (probe) return probeUpload(state, transferId, req, res);
    return method === 'PUT' ? putPart(state, transferId, Number(index), req, res) : getPart(state, transferId, Number(index), res);
  }

  // Every sweepMs: revoked/expired tokens end, a rotated agent credential closes its channel, a silent channel dies and
  // idle transfers expire. A tokens file that cannot be read now is skipped for this tick (the next request answers 500).
  function sweep() {
    const at = nowMs();
    for (const state of links.values()) {
      let rec;
      try { rec = store.lookup(state.tokenId); } catch { log({ event: 'tokens-unreadable' }); continue; }
      const status = rec ? rec.state : 'revoked';
      if (status !== 'active') { endLink(state, status === 'expired' ? 'expired' : 'revoked'); continue; }
      const channel = state.channel;
      if (channel && rec.agentSha256 !== channel.agentSha256) {
        closeChannel(state, 'rotated', 'The agent credential was replaced by the server owner.');
        failAll(state, 'AGENT_DISCONNECTED', 'The agent credential was replaced.');
        dropTransfers(state, 'up');
        state.instance = null;
      } else if (channel && at - channel.lastPostAt > limits.deadAfterMs) {
        log({ event: 'agent-dead', token: state.tokenId });
        closeChannel(state, null);
      }
      // Idle transfers expire; one line per sweep with their count (C33: 138 single lines in one client session).
      let expired = 0;
      for (const transfer of [...state.transfers.values()])
        if (!transfer.held && at - transfer.lastAccess > limits.transferIdleMs) { expired++; dropTransfer(state, transfer); }
      if (expired) log({ event: 'agent-transfers-expired', token: state.tokenId, count: expired });
    }
  }
  const timer = setInterval(sweep, limits.sweepMs); timer.unref?.();

  return {
    handle,
    link: tokenId => stateOf(tokenId).api,
    sweep,
    async close() {
      clearInterval(timer);
      for (const state of links.values()) endLink(state, 'server-stop');
    },
  };
}
