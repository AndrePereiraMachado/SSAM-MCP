// A Node client of the O11 Service Studio bridge (kernel\src\Anvil.Bridge\Server.cs): JSON lines over loopback TCP,
// `{method, params, authorization}` in, `{success, data, error}` out. One connection per call, a reply cap and a
// timeout per command, so long verbs (open_module, merge_from_oml, publish) and large replies (get_errors, windows)
// fit, unlike the 2.5 s / 64 KiB health probe of studio-connect.mjs. Positive stall evidence uses the shared pure rule.
//
// The target comes from the lane's connection record (.local\connections\<lane>.json, written by ssam_connect):
// its port, pid and authorityDir. Without a record, the lane table port and the authority folder rules of
// o11-lane.mjs. No Python, no credential: the bridge key is the trusted-controller key, never a user secret.
import net from 'node:net';
import { BridgeStallRule, PROBE_MS, PROBE_TIMEOUT_MS, MAX_TEXTS, currentBlocker } from './bridge-stall.mjs';
import { readConnection } from './studio-session.mjs';
import { o11LaneOf, authorityKeyPath, readAuthorityKey } from './o11-lane.mjs';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { currentExecutor } from './executor.mjs';
import { registerBridgeFlight, FLIGHT_CAP_MS } from './studio-write-lock.mjs';

export const MAX_REPLY_BYTES = 100 * 1024 * 1024;
// Milliseconds a reply may take, per bridge method. The bridge bounds its own waits (open_module timeout <= 300 s,
// publish 300 s + 45 s settle, login 90 s, studio_login waitMs <= 60 s, close_module 30 s read + idle_timeout_ms + 30 s
// close, every UI step: UiGate.cs); the client adds a margin, as studio_env.py does.
const seconds = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback) * 1000;
export const TIMEOUTS = {
  ping: () => 5000, bridge_manifest: () => 5000, ui_alive: p => (p?.timeout_ms ?? 5000) + 5000,
  open_module: p => seconds(p?.timeout, 120) + 60000, close_module: p => 60000 + (Number(p?.idle_timeout_ms) || 30000) + 30000,
  snapshot_module: () => 300000, merge_from_oml: () => 900000, merge_status: () => 60000,
  get_errors: () => 300000, windows: () => 30000, close_dialog: () => 30000,
  publish: p => seconds(p?.timeout, 300) + 45000 + 60000, login: p => seconds(p?.timeout, 90) + 30000,
  studio_login: p => (Number(p?.waitMs) || 3000) + 30000, sc_session: () => 60000,
  sc_api: () => 300000, sc_web: () => 300000, export_modules: () => 900000,
  // The native Refresh References downloads each producer signature through the Studio's own login.
  refresh_references: p => seconds(p?.timeout, 600) + 60000,
};
export const timeoutFor = (method, params) => (TIMEOUTS[method] ?? (() => 120000))(params);

export class BridgeError extends Error {
  constructor(message, { code, method, executed, reply, stall, transportCode } = {}) {
    super(message); this.name = 'BridgeError'; this.code = code; this.method = method; this.executed = executed; this.reply = reply;
    if (stall) this.stall = stall; if (transportCode) this.transportCode = transportCode;
  }
}

// Watched UI calls use independent ping/windows probes, never UI actions. Before selected writes, an error report
// refuses without sending unless the manifest declares automatic handling. During a call, only repeated positive
// dialog/connection/process evidence abandons it (2 error/gone probes, 8 other dialogs; default cadence 2 seconds).
// Timeouts and protocol refusals are not evidence. ANVIL_BRIDGE_PROBE_MS=0 disables both pre-probe and watcher;
// short deadlines <= the cadence never probe. A stalled call keeps its original socket/fence; no write is resent.
// One request on its own connection. Resolves with the bridge reply object; rejects only for transport failures
// (refused, timeout, malformed or oversize reply) and for a cancellation (signal, code CANCELLED: the caller stops
// waiting; a request already written keeps running in the Studio, so its outcome is unknown). A refusal by the bridge
// is a reply with success:false.
// UI freeze of 2026-10-08 (pattern 4): a request written to the bridge that times out or is cancelled is still running in
// the Studio. The caller gets its BRIDGE_TIMEOUT / CANCELLED at once, but the connection stays open, listening for the
// late answer, and the call is registered as in flight (studio-write-lock.mjs registerBridgeFlight, target.flight): no
// write of that Studio starts until the bridge answers, the Studio closes the connection or FLIGHT_CAP_MS passes.
// CX14 follow-up: the pre-probe never adds a round trip an answer it already has covers (owner rule: fewer rounds).
// - bridge_manifest: ONE read per Studio process (pid + start of the connection record), shared with bridgeOffers and
//   status of o11-studio.mjs; a client without that identity (a fake, no record) shares it per client (target).
// - ping: only for a Studio identity the pre-probe does not have (record pid + start, or a ping of the same client).
// - windows: a read of the same client is reused when no call other than a read was sent through it since that read
//   began, and it began at most FRESH_WINDOWS_MS ago; else the pre-probe reads windows (once before every watched write).
export const FRESH_WINDOWS_MS = 1000;
const READ_VERBS = new Set(['ping', 'windows', 'bridge_manifest', 'list_open_modules', 'get_active_module', 'ui_alive', 'merge_status']);
const sentWrites = new WeakMap();   // target -> number of calls other than reads sent through it
const lastWindows = new WeakMap();  // target -> {at, writes, windows}: the latest valid windows read through it
const learnedIdentity = new WeakMap(); // target -> {pid, startedUtc} of an earlier ping of the same client
const writesOf = target => sentWrites.get(target) ?? 0;
function rememberWindows(target, at, writes, reply) {
  const windows = validProbeWindows(reply);
  if (windows !== null) lastWindows.set(target, { at, writes, windows });
}
export async function bridgeRequest(target, method, params = {}, options = {}) {
  const limit=options.timeoutMs??timeoutFor(method,params);
  const interval=options.probeMs??configuredProbeMs();
  const rule=new BridgeStallRule(method,{probeMs:interval,timeoutMs:limit});
  if(!rule.enabled) {
    if(method==='windows') { const at=Date.now(),writes=writesOf(target);const reply=await rawBridgeRequest(target,method,params,options);rememberWindows(target,at,writes,reply);return reply; }
    if(!READ_VERBS.has(method)) sentWrites.set(target,writesOf(target)+1);
    return rawBridgeRequest(target,method,params,options);
  }
  if(options.signal?.aborted) throw new BridgeError(`Bridge ${method} cancelled before it was sent`,{code:'CANCELLED',method,executed:false});
  const probeTimeoutMs=options.probeTimeoutMs??PROBE_TIMEOUT_MS;
  const probeOptions={timeoutMs:probeTimeoutMs,signal:options.signal,probeOnly:true};
  const learned=learnedIdentity.get(target);
  let pid=Number.isSafeInteger(target.pid)?target.pid:Number.isSafeInteger(target.record?.pid)?target.record.pid:learned?.pid;
  let startedUtc=typeof target.startedUtc==='string'?target.startedUtc:typeof target.record?.startedUtc==='string'?target.record.startedUtc:learned?.startedUtc;
  if(rule.needsPreProbe) {
    const fresh=lastWindows.get(target);
    const reuse=fresh&&fresh.writes===writesOf(target)&&Date.now()-fresh.at<=FRESH_WINDOWS_MS?fresh.windows:null;
    // A bridge whose ping has no start (an older bridge) answers the same to another ping: one ping per client.
    const needPing=!learned&&(!Number.isSafeInteger(pid)||typeof startedUtc!=='string');
    const at=Date.now(),writes=writesOf(target);
    const [ping,windows,manifest]=await Promise.allSettled([
      needPing?rawBridgeRequest(target,'ping',{},probeOptions):Promise.resolve(null),
      reuse?Promise.resolve(null):rawBridgeRequest(target,'windows',{max_texts:MAX_TEXTS},probeOptions),
      bridgeManifest(target,{timeoutMs:probeTimeoutMs}),
    ]);
    if(options.signal?.aborted) throw new BridgeError(`Bridge ${method} cancelled before it was sent`,{code:'CANCELLED',method,executed:false});
    if(ping.status==='fulfilled' && ping.value?.success===true) {
      if(pid===undefined && Number.isSafeInteger(ping.value.data?.pid)) pid=ping.value.data.pid;
      if(typeof ping.value.data?.startedUtc==='string') startedUtc=ping.value.data.startedUtc;
      learnedIdentity.set(target,{pid,startedUtc});
    }
    if(!reuse&&windows.status==='fulfilled') rememberWindows(target,at,writes,windows.value);
    const before=reuse??(windows.status==='fulfilled' && windows.value?.success===true ? windows.value.data?.windows : undefined);
    const capabilities=manifest.status==='fulfilled'&&manifest.value.ok?manifest.value.capabilities:[];
    const stall=rule.begin(before,{pid,startedUtc,capabilities});
    if(stall) return {success:false,executed:false,code:'STUDIO_ERROR_DIALOG_OPEN',error:`The Studio error report "${stall.blockedBy.title}" is open; nothing was sent.`,data:{stall}};
  } else rule.begin([],{pid,startedUtc});
  sentWrites.set(target,writesOf(target)+1);
  return rawBridgeRequest(target,method,params,{...options,watch:{rule,interval,probeTimeoutMs,pid,startedUtc,alive:options.alive??processAlive}});
}
// The bridge's manifest, read once per Studio process (see above): {ok:true, data, capabilities} with the answer (a bridge
// that refuses the verb offers nothing, kept as such) or {ok:false, error} after a transport failure or a timeout, which
// is not kept: the next call reads again. Never the arguments of a call; bridge_manifest is exempt from the bridge key.
const manifestByStudio = new Map();
const manifestByTarget = new WeakMap();
function studioIdentityKey(target) {
  const pid = Number.isSafeInteger(target?.pid) ? target.pid : Number.isSafeInteger(target?.record?.pid) ? target.record.pid : null;
  const start = typeof target?.startedUtc === 'string' ? target.startedUtc : typeof target?.record?.startedUtc === 'string' ? target.record.startedUtc : null;
  return pid !== null && start !== null ? (target.host ?? '127.0.0.1') + ':' + target.port + '|' + pid + '|' + start : null;
}
// A failed read stays only for the client that made it (it does not retry within its call); another client reads again.
export function bridgeManifest(target, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const key = studioIdentityKey(target);
  const cached = (key ? manifestByStudio.get(key) : null) ?? manifestByTarget.get(target);
  if (cached) return cached;
  const read = rawBridgeRequest(target, 'bridge_manifest', {}, { timeoutMs, probeOnly: true })
    .then(reply => { const data = reply?.success === true && reply.data && typeof reply.data === 'object' ? reply.data : {};
      return { ok: true, data, capabilities: Array.isArray(data.capabilities) ? data.capabilities : [] }; },
      error => { if (key && manifestByStudio.get(key) === read) manifestByStudio.delete(key); return { ok: false, error }; });
  if (key) manifestByStudio.set(key, read);
  manifestByTarget.set(target, read);
  return read;
}
function configuredProbeMs() {
  const value=Number(process.env.ANVIL_BRIDGE_PROBE_MS);
  return process.env.ANVIL_BRIDGE_PROBE_MS!==undefined && Number.isFinite(value) && value>=0 ? value : PROBE_MS;
}
function processAlive(pid) {
  if(!Number.isSafeInteger(pid) || pid<=0) return undefined;
  try {process.kill(pid,0);return true} catch(error) {return error?.code==='ESRCH'?false:error?.code==='EPERM'?true:undefined}
}
function validProbeWindows(reply) {
  if(reply?.success!==true || !Array.isArray(reply.data?.windows)) return null;
  // Invalid records mean an unreadable probe, never evidence that the blocker disappeared.
  if(reply.data.windows.some(w=>!w || typeof w!=='object' || Array.isArray(w) || typeof w.type!=='string' || (w.title!==undefined && w.title!==null && typeof w.title!=='string') || (w.isVisible!==undefined && w.isVisible!==null && typeof w.isVisible!=='boolean') || (w.isModal!==undefined && w.isModal!==null && typeof w.isModal!=='boolean') || (w.texts!==undefined && w.texts!==null && (!Array.isArray(w.texts)||w.texts.some(t=>typeof t!=='string'))))) return null;
  return reply.data.windows;
}
async function observeBridge(target,watch,signal,postStall=false) {
  let studioAlive;
  try {studioAlive=await watch.alive(watch.pid)}catch{ /* a failed process check is not positive evidence */ }
  if(studioAlive===false) return {studioAlive:false};
  const probeOptions={timeoutMs:watch.probeTimeoutMs,signal,probeOnly:true};
  const [windowsReply,pingReply]=await Promise.allSettled([
    rawBridgeRequest(target,'windows',{max_texts:MAX_TEXTS},probeOptions),
    postStall ? Promise.resolve(null) : rawBridgeRequest(target,'ping',{},probeOptions),
  ]);
  const ping=pingReply.status==='fulfilled' && pingReply.value?.success===true ? pingReply.value.data : null;
  // A record PID is authoritative. Timestamp identity may be learned by the first successful watched ping,
  // including reads without a pre-probe; learning it never erases already observed dialog evidence.
  if(!Number.isSafeInteger(watch.pid) && Number.isSafeInteger(ping?.pid)) {
    watch.pid=ping.pid;watch.rule.studio.pid=watch.pid;
    try {studioAlive=await watch.alive(watch.pid)}catch{ /* no positive process evidence */ }
  }
  if(!watch.startedUtc && typeof ping?.startedUtc==='string') {
    watch.startedUtc=ping.startedUtc;watch.rule.studio.startedUtc=watch.startedUtc;
  }
  const observation={...(typeof studioAlive==='boolean'?{studioAlive}:{}),...(typeof ping?.startedUtc==='string'?{startedUtc:ping.startedUtc}:{})};
  if(windowsReply.status==='fulfilled') {
    const windows=validProbeWindows(windowsReply.value);
    if(windows!==null) observation.windows=windows;
  } else {
    const error=windowsReply.reason;
    if(error?.code==='BRIDGE_NOT_LISTENING' || ['ECONNREFUSED','ECONNRESET'].includes(error?.transportCode)) observation.connectionRefused=true;
  }
  return observation;
}
// One transport connection. Probes are isolated and close at their own deadline; they never register a flight.
function rawBridgeRequest({ port, host = '127.0.0.1', authorization, maxBytes = MAX_REPLY_BYTES, flight }, method, params = {}, { timeoutMs, signal, watch, probeOnly = false } = {}) {
  const limit = timeoutMs ?? timeoutFor(method, params);
  if (signal?.aborted) return Promise.reject(new BridgeError(`Bridge ${method} cancelled before it was sent`, { code: 'CANCELLED', method, executed: false }));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const chunks = []; let size = 0; let settled = false; let sent = false; let release = null; let cap = null;
    let watchTimer=null,closed=false,stalled=null,sentAt=0,nextProbeAt=0;
    const probeController=new AbortController();
    const close = () => { closed=true; clearTimeout(cap);clearTimeout(watchTimer);probeController.abort(); socket.destroy(); if (release) { const r = release; release = null; r(); } };
    const schedule=()=>{
      // CX14 R5: a stalled call keeps sampling while its flight lives (late answer, connection end or cap), not only
      // until its first blocker goes away: a blocker that comes back marks the flight stalled again.
      if(!watch || closed || (settled && !stalled)) return;
      watchTimer=setTimeout(async()=>{
        if(closed) return;
        const sampledAt=Date.now();
        const observation=await observeBridge({port,host,authorization,maxBytes},watch,probeController.signal,settled);
        if(closed) return;
        observation.afterMs=Date.now()-sentAt;
        if(settled) {
          const now=Array.isArray(observation.windows)?currentBlocker(observation.windows,stalled?.blockedBy):undefined;
          if(now) { release?.update?.({blockedBy:now,observedAt:sampledAt});stalled={...stalled,blockedBy:now}; }
          else if(now===null && stalled?.blockedBy) { release?.update?.({blockedBy:null});stalled={...stalled,blockedBy:null}; }
        } else {
          const stall=watch.rule.observe(observation);
          if(stall) abandon(new BridgeError(`Bridge ${method} stopped with positive evidence: ${stall.verdict}`,{code:'BRIDGE_STALLED',method,executed:undefined,stall}));
        }
        nextProbeAt=Math.max(nextProbeAt+watch.interval,Date.now());
        schedule();
      },Math.max(0,nextProbeAt-Date.now()));
      watchTimer.unref?.();
    };
    // Abandoning never resends: the main socket and its fence remain until a terminal answer/connection close/cap.
    const abandon = error => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort);
      if (!sent || probeOnly) { close(); return reject(error); }
      stalled=error.stall??null;
      try { release = flight ? flight(method, params, stalled?{stall:stalled,blockedBy:stalled.blockedBy,...(typeof params?.operation_id==='string'?{operationId:params.operation_id}:{})}:undefined) : null; } catch { release = null; }
      if(!stalled) clearTimeout(watchTimer);
      cap = setTimeout(close, FLIGHT_CAP_MS); cap.unref?.();
      socket.unref?.();
      reject(error);
    };
    const finish = (error, value) => { if (settled) return close(); settled = true; clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); close(); error ? reject(error) : resolve(value); };
    const onAbort = () => abandon(new BridgeError(`Bridge ${method} cancelled`, { code: 'CANCELLED', method, executed: sent ? undefined : false }));
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => abandon(new BridgeError(`Bridge ${method} timed out after ${limit} ms`, { code: 'BRIDGE_TIMEOUT', method, executed: sent ? undefined : false })), limit);
    socket.on('error', error => finish(new BridgeError(error.message, { code: error.code === 'ECONNREFUSED' ? 'BRIDGE_NOT_LISTENING' : 'BRIDGE_TRANSPORT', method, executed: sent ? undefined : false,transportCode:error.code })));
    socket.on('connect', () => { socket.write(JSON.stringify({ method, params, ...(authorization ? { authorization } : {}) }) + '\n'); sent = true;sentAt=Date.now();if(watch)nextProbeAt=sentAt+watch.interval;schedule(); });
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) return finish(new BridgeError(`Bridge ${method} reply exceeded ${maxBytes} bytes`, { code: 'BRIDGE_REPLY_TOO_LARGE', method }));
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) { chunks.push(chunk); return; }
      chunks.push(chunk.subarray(0, newline));
      let reply;
      try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return finish(new BridgeError('Unexpected service on the bridge port', { code: 'BRIDGE_PROTOCOL', method })); }
      finish(null, reply);
    });
    socket.on('end', () => finish(new BridgeError(`Bridge closed ${method} without a reply`, { code: 'BRIDGE_NO_REPLY', method })));
    socket.on('close', () => { if (settled) close(); });
  });
}

// The flight of a lane's Studio (bridgeTarget): the module of the call, never its other arguments.
const flightModule = params => {
  const name = typeof params?.name === 'string' ? params.name : typeof params?.module === 'string' ? params.module : null;
  const key = typeof params?.module_key === 'string' ? params.module_key : null;
  return name || key ? { name, key } : null;
};
export function flightOf({ lane, root, record }) {
  if (!Number.isSafeInteger(record?.pid)) return undefined;
  return (method, params, extra) => registerBridgeFlight({ lane, root, record, method, module: flightModule(params), ...(extra ?? {}) });
}

// Where the lane's bridge listens and which key it trusts. A record names the selected Studio; without one the
// lane table port is used (the bridge may not be there: the first call says so). Hosted: the relay port of the
// customer's record and no key (the agent puts its own); without a record O11_NOT_CONNECTED (o11-lane.mjs). The flight
// (pattern 4) applies in both: locally the late answer ends it (bridgeRequest); hosted it is keyed by the customer's
// record in the customer's <ws>/state/locks (studio-write-lock.mjs o11StudioLockDir) and ends at FLIGHT_CAP_MS, since the
// late answer stays on the customer's machine.
export function bridgeTarget({ lane = o11Lane.lane, root = anvilRoot, env = process.env } = {}) {
  const record = readConnection(root, lane);
  const port = Number.isInteger(record?.port) ? record.port : o11LaneOf(lane, { root, env }).bridge;
  if (currentExecutor().hosted) return { lane, port, pid: record?.pid ?? null, record, keyFile: null, authorization: null, flight: flightOf({ lane, root, record }) };
  return { lane, port, pid: record?.pid ?? null, record, keyFile: authorityKeyPath({ env, record }),
    authorization: readAuthorityKey({ env, record }), flight: flightOf({ lane, root, record }) };
}

// Hosted, a call whose outcome is unknown (timed out or cancelled after it was sent) may still run in the customer's
// Studio: it is registered as in flight for FLIGHT_CAP_MS, so no write of that Studio starts on this server meanwhile.
const UNKNOWN_OUTCOME = new Set(['BRIDGE_TIMEOUT', 'AGENT_TIMEOUT', 'CANCELLED']);
function hostedFlight(target, method, params, error) {
  if (typeof target?.flight !== 'function' || !UNKNOWN_OUTCOME.has(error?.code) || error?.executed === false) return;
  let release = null;
  try { release = target.flight(method, params); } catch { release = null; }
  if (release) { const cap = setTimeout(release, FLIGHT_CAP_MS); cap.unref?.(); }
}

// The client callers use: call() returns the reply; ok() returns data or throws a BridgeError with the bridge's code.
// Every request is the o11.bridge call of the executor seam: locally bridgeRequest on the target, hosted the customer's
// agent (no port and no key leave this server).
export function o11Bridge(target = bridgeTarget()) {
  const request = async (method, params, options) => {
    const executor = currentExecutor();
    if (!executor.hosted) {
      // Locally the flight and the cancellation reach bridgeRequest itself (it keeps listening for the late answer).
      // servidor/fase4-26 (CX14 through the seam): this client's own target (the Studio identity and the per-client caches of
      // the watch: manifest, windows, ping) and the watch options (probeMs, probeTimeoutMs, alive) reach bridgeRequest as the
      // product passes them; without them every local call read the manifest again and dropped the caller's cadence.
      const { reply } = await executor.call('o11.bridge', { method, params, timeoutMs: options?.timeoutMs, signal: options?.signal,
        port: target.port, host: target.host, authorization: target.authorization, maxBytes: target.maxBytes, flight: target.flight, target, options });
      return reply;
    }
    try {
      const { reply } = await executor.call('o11.bridge', { method, params: params ?? {}, ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
      return reply;
    } catch (error) {
      hostedFlight(target, method, params, error);
      throw error;
    }
  };
  let hostedRead = null;
  const hostedManifest = options => (hostedRead ??= request('bridge_manifest', {}, options).then(reply => {
    const data = reply?.success === true && reply.data && typeof reply.data === 'object' ? reply.data : {};
    return { ok: true, data, capabilities: Array.isArray(data.capabilities) ? data.capabilities : [] };
  }, error => { hostedRead = null; return { ok: false, error }; }));
  return {
    target,
    call: request,
    // CX14 follow-up: the manifest of this Studio, read once and shared (bridgeManifest). servidor/fase4-26 (D): hosted, through
    // the executor seam like every other call of this client (the customer's agent; never a socket of this server), once per
    // client; a failed read is not kept.
    manifest: options => (currentExecutor().hosted ? hostedManifest(options) : bridgeManifest(target, options)),
    async ok(method, params = {}, options) {
      const reply = await request(method, params, options);
      if (reply?.success === true) return reply.data;
      const code = reply?.code ?? reply?.data?.code ?? (reply?.executed === false ? 'BRIDGE_REFUSED' : 'BRIDGE_ERROR');
      throw new BridgeError(reply?.error ?? reply?.data?.message ?? `Bridge ${method} failed`, { code, method, executed: reply?.executed, reply, stall: reply?.data?.stall });
    },
  };
}
