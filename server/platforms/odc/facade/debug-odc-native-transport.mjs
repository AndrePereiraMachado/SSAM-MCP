// Transport boundary for the ORIGINAL published SignalR client of an ODC app (native-entry debugger, live worker).
// Generalized from the GetFloodZones proof adapter: every origin, app base path and hub path comes from the endpoint
// contract derived from the runtime URL, never from app literals. This module never creates or starts a hub itself;
// the app's own DebuggerHttpClient does. All network is refused until the worker binds an authenticated lease and opens
// one probe (one scenario). Per probe: one negotiate, one socket (or one LongPolling channel), one ExecuteRequest.
import { createHash } from 'node:crypto';
import { createNativeResponseObserver } from './debug-odc-native-response-observer.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/;
const USER_AGENT = /^Microsoft SignalR\/\d{1,3}\.\d{1,3} \([^()\x00-\x1f]{1,160}\)$/;
const SCREEN_SERVICE = /^\/[A-Za-z_][A-Za-z0-9_]{0,120}\/screenservices\/[A-Za-z0-9_]{1,120}(?:\/[A-Za-z0-9_]{1,160}){1,4}$/;
const REJECT_CODES = new Set(['request_not_authorized', 'lease_unavailable', 'probe_not_active', 'probe_expired', 'negotiation_already_attempted',
  'auth_header_rejected', 'negotiation_failed', 'negotiation_rejected', 'negotiation_invalid', 'negotiation_scope_changed', 'socket_scope_rejected',
  'socket_already_attempted', 'socket_failed', 'message_rejected', 'message_invalid', 'handshake_rejected', 'invocation_rejected',
  'message_type_rejected', 'send_uncertain', 'long_poll_scope_rejected', 'long_poll_headers_rejected', 'long_poll_limit', 'long_poll_failed',
  'long_poll_cleanup_rejected', 'channel_already_selected'].map(code => 'debug_odc_native_transport_' + code));
const fail = code => { throw new Error(code.startsWith('debug_odc_native_') ? code : 'debug_odc_native_transport_' + code); };
const safeHeaders = value => Object.fromEntries(new Headers(value ?? {}).entries());
const validConnectionId = value => typeof value === 'string' && !!value && value.length <= 512 && !/[\x00-\x20\x7f]/.test(value);

// Endpoint contract of one published app, from its runtime URL (https://<host>/<App>/). The hub path may be overridden
// by a captured contract, but it must stay under the app's moduleservices.
export function odcNativeEndpoints({ runtimeUrl, hub } = {}) {
  let url; try { url = new URL(runtimeUrl); } catch { fail('endpoints_invalid'); }
  const app = url.pathname.split('/').filter(Boolean)[0];
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !NAME.test(app ?? '') || url.pathname !== '/' + app + '/') fail('endpoints_invalid');
  const base = '/' + app + '/', hubPath = hub ?? base + 'moduleservices/debugger/requestshub';
  if (typeof hubPath !== 'string' || !hubPath.startsWith(base + 'moduleservices/') || !/^[A-Za-z0-9_/]+$/.test(hubPath)) fail('endpoints_invalid');
  return Object.freeze({ origin: url.origin, appUrl: url.origin + base, app, base, hub: hubPath,
    sync: base + 'moduleservices/users/userinfosync', versionInfo: base + 'moduleservices/moduleversioninfo', moduleInfo: base + 'moduleservices/moduleinfo',
    authConfigs: base + 'moduleservices/auth/configs', clientSettings: base + 'moduleservices/clientsettingsinfo', screenServices: base + 'screenservices/' });
}

export function isScreenServicePath(endpoints, value) {
  return typeof value === 'string' && value.startsWith(endpoints.screenServices) && SCREEN_SERVICE.test(value);
}

function negotiationShape(value) {
  const object = !!value && typeof value === 'object' && !Array.isArray(value), has = key => object && Object.hasOwn(value, key);
  const version = !has('negotiateVersion') ? 'absent' : value.negotiateVersion === 0 ? 'zero' : value.negotiateVersion === 1 ? 'one' : 'unsupported';
  const rows = object ? value.availableTransports : undefined, known = ['WebSockets', 'ServerSentEvents', 'LongPolling'], seen = new Set();
  const canonicalTransportList = Array.isArray(rows) && rows.length > 0 && rows.length <= 3 && rows.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'transferFormats,transport' || !known.includes(row.transport) ||
        seen.has(row.transport) || !Array.isArray(row.transferFormats) || row.transferFormats.length < 1 || row.transferFormats.length > 2 ||
        new Set(row.transferFormats).size !== row.transferFormats.length || row.transferFormats.some(format => !['Text', 'Binary'].includes(format))) return false;
    seen.add(row.transport); return true;
  });
  const offered = (transport, format) => Array.isArray(rows) && rows.some(row => row?.transport === transport && Array.isArray(row.transferFormats) && row.transferFormats.includes(format));
  return Object.freeze({ payloadKind: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value, hasUrl: has('url'), hasAccessToken: has('accessToken'),
    hasError: has('error'), negotiateVersion: version, webSocketsText: offered('WebSockets', 'Text'), longPollingText: offered('LongPolling', 'Text'),
    canonicalTransportList, connectionTokenValid: object && validConnectionId(value.connectionToken), connectionIdValid: object && validConnectionId(value.connectionId), selectedId: 'none' });
}

export function originalTimeoutWithinLease(timeoutSeconds, expiresAt, now = Date.now()) {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || !Number.isFinite(expiresAt) || expiresAt <= now) fail('deadline_invalid');
  return Math.max(1, Math.floor(Math.min(timeoutSeconds * 1000, expiresAt - now, 300000)));
}

// responseParityKey: the coordinator's private per-run producer-parity key (64 hex); each probe's response
// observer keeps keyed per-path fingerprints, released by responseParity() for that probe's ExecuteRequest only.
export function createOdcNativeTransport({ endpoints, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, clock = Date.now, beforeActionRequest, privateEvidence, responseParityKey } = {}) {
  if (!endpoints?.hub || typeof fetchImpl !== 'function' || typeof WebSocketImpl !== 'function') fail('node_apis_unavailable');
  if (responseParityKey !== undefined && (typeof responseParityKey !== 'string' || !/^[a-f0-9]{64}$/.test(responseParityKey))) fail('response_parity_key_invalid');
  const ORIGIN = endpoints.origin, HUB = endpoints.hub, HOST = new URL(ORIGIN).host;
  let lease, active, interactiveDeadline, closed = false; const consumed = new Set(), states = [], sockets = new Set(), cleanups = new Set();
  const report = { nativeSignalR: true, networkRequests: 0, blockedRequests: 0, lastRejectCode: null, negotiationShape: null, negotiations: 0, socketConnections: 0,
    executeRequestSubmissions: 0, uncertain: false, deadlineExpired: false, retriesBlocked: 0, longPollingConnections: 0, longPollingPollRequests: 0,
    longPollingSendRequests: 0, longPollingCleanupRequests: 0, longPollingCleanupAccepted: 0, selectedTransport: 'none' };
  function deny(code = 'debug_odc_native_transport_request_not_authorized') {
    report.blockedRequests++; report.lastRejectCode = REJECT_CODES.has(code) ? code : 'debug_odc_native_transport_request_not_authorized'; throw new Error(report.lastRejectCode);
  }
  const D = code => 'debug_odc_native_transport_' + code;
  const evidenceData = state => ({ path: state.path, hub: HUB, requestSha256: state.requestSha256,
    nativeCallContextId: state.nativeCallContextId, connectionToken: state.connectionToken ?? null, connectionId: state.connectionId ?? null,
    nativeUserAgent: state.nativeUserAgent ?? null, leaseExpiresAt: lease.expiresAt, startedAt: state.startedAt, deadline: state.deadline,
    appUserKeySha256: lease.appUserKeySha256, executeRequestSubmissions: state.invocations, responseCompleted: state.responseCompleted === true,
    cleanupAttempted: state.lpDeleteAttempted, cleanupAccepted: state.lpCleanupAccepted, cleanupStatus: state.cleanupStatus ?? null, transport: state.channel });
  async function persist(stage, state) {
    if (!privateEvidence) return; // Synthetic transports may provide no vault; the production host always provides one.
    state.evidence[stage] = await privateEvidence.write(stage, state.probeId, evidenceData(state));
    if (state.evidence[stage]?.sealed !== true || !/^[a-f0-9]{64}$/.test(state.evidence[stage]?.sha256 ?? '')) fail('evidence_not_saved');
  }
  function current() {
    if (closed || !lease || clock() >= lease.expiresAt) deny(D('lease_unavailable'));
    if (!active) deny(D('probe_not_active'));
    if (active.finished || clock() >= active.deadline) deny(D('probe_expired'));
    return active;
  }
  function stopActive({ deadline = false } = {}) {
    if (!active) return;
    const state = active; state.finished = true; clearTimeout(state.timer); state.abort.abort();
    if (deadline) { state.deadlineExpired = true; report.deadlineExpired = true; state.uncertain = state.invocations > 0; report.uncertain ||= state.uncertain; }
    for (const socket of sockets) { try { socket.close(); } catch {} }
  }
  async function awaitScoped(promise, state) {
    let onAbort;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        onAbort = () => reject(new Error('debug_odc_native_transport_wait_stopped'));
        state.abort.signal.addEventListener('abort', onAbort, { once: true }); if (state.abort.signal.aborted) onAbort();
      })]);
    } finally { state.abort.signal.removeEventListener('abort', onAbort); }
  }
  const headersMatch = (actual, expected) => JSON.stringify(Object.entries(safeHeaders(actual)).sort()) === JSON.stringify(Object.entries(safeHeaders(expected)).sort());
  const clientHeaders = (headers, extra = []) => {
    const keys = Object.keys(headers).sort(), expected = ['authorization', 'x-requested-with', 'x-signalr-user-agent', ...extra].sort();
    return keys.join(',') === expected.join(',') && headers.authorization === 'Bearer ' + lease?.accessToken && headers['x-requested-with'] === 'XMLHttpRequest' &&
      USER_AGENT.test(headers['x-signalr-user-agent'] ?? '');
  };
  async function negotiateFetch(url, options) {
    const state = current(), headers = safeHeaders(options.headers);
    if (url.search !== '?negotiateVersion=1' || (options.method ?? 'GET').toUpperCase() !== 'POST' || ![undefined, ''].includes(options.body)) deny();
    if (state.negotiations !== 0) { report.retriesBlocked++; deny(D('negotiation_already_attempted')); }
    if (!clientHeaders(headers)) deny(D('auth_header_rejected'));
    state.negotiations++; report.negotiations++; report.networkRequests++;
    let response;
    try { response = await awaitScoped(fetchImpl(url, { ...options, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([state.abort.signal, ...(options.signal ? [options.signal] : [])]) }), state); }
    catch { deny(D('negotiation_failed')); }
    if (response.redirected || (response.url && response.url !== url.href) || response.status !== 200) { if (response.status === 401) report.retriesBlocked++; deny(D('negotiation_rejected')); }
    let value;
    try { const text = await awaitScoped(response.clone().text(), state); if (text.length > 32768) deny(); value = JSON.parse(text); } catch { deny(D('negotiation_invalid')); }
    const shape = negotiationShape(value); report.negotiationShape = shape;
    if (shape.payloadKind !== 'object' || shape.hasUrl || shape.hasAccessToken || shape.hasError || shape.negotiateVersion === 'unsupported' || !shape.canonicalTransportList ||
        !(shape.webSocketsText || shape.longPollingText)) deny(D('negotiation_scope_changed'));
    // The original SignalR client uses connectionId when negotiateVersion is absent/0, connectionToken otherwise.
    const legacy = shape.negotiateVersion !== 'one';
    if (legacy ? !shape.connectionIdValid : !shape.connectionTokenValid) deny(D('negotiation_scope_changed'));
    state.connectionToken = legacy ? value.connectionId : value.connectionToken; state.connectionId = value.connectionId ?? null;
    state.nativeUserAgent = headers['x-signalr-user-agent']; state.webSocketsText = shape.webSocketsText; state.longPollingText = shape.longPollingText;
    report.negotiationShape = Object.freeze({ ...shape, selectedId: legacy ? 'connection-id' : 'connection-token' });
    await persist('negotiated', state); // Durable private IDs precede any channel/business send.
    return response;
  }
  // Client-to-server frames: one handshake, pings, exactly one ExecuteRequest that matches the probe.
  function frames(data, state) {
    if (typeof data !== 'string' || data.length > 1048576 || !data.endsWith('\x1e')) deny(D('message_rejected'));
    const values = data.slice(0, -1).split('\x1e').map(text => { try { return JSON.parse(text); } catch { deny(D('message_invalid')); } });
    let handshakes = state.handshakes, invocations = state.invocations, pings = state.pings;
    for (const frame of values) {
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) deny(D('message_invalid'));
      if (frame.protocol !== undefined) {
        if (handshakes++ !== 0 || frame.protocol !== 'json' || frame.version !== 1 || Object.keys(frame).sort().join(',') !== 'protocol,version') deny(D('handshake_rejected'));
      } else if (frame.type === 6) {
        if (handshakes !== 1 || ++pings > 64 || Object.keys(frame).length !== 1) deny(D('message_type_rejected'));
      } else if (frame.type === 1) {
        if (handshakes !== 1 || invocations++ !== 0 || frame.target !== 'ExecuteRequest' || typeof frame.invocationId !== 'string' || !/^\d{1,10}$/.test(frame.invocationId) ||
            Object.keys(frame).some(key => !['type', 'target', 'invocationId', 'arguments'].includes(key)) || !Array.isArray(frame.arguments) || frame.arguments.length !== 3 ||
            frame.arguments[0] !== state.path || frame.arguments[1] !== state.body || !headersMatch(frame.arguments[2], state.headers)) deny(D('invocation_rejected'));
        state.nativeInvocationId = frame.invocationId;
      } else deny(D('message_type_rejected'));
    }
    const submits = invocations - state.invocations;
    state.handshakes = handshakes; state.pings = pings; state.invocations = invocations;
    if (submits) { report.executeRequestSubmissions += submits; state.uncertain = true; report.uncertain = true; }
  }
  function longPollingUrl(url, state, poll) {
    if (url.protocol !== 'https:' || url.origin !== ORIGIN || url.pathname !== HUB || url.username || url.password || url.hash || !state.connectionToken ||
        [...url.searchParams.keys()].length !== (poll ? 2 : 1) || url.searchParams.get('id') !== state.connectionToken) deny(D('long_poll_scope_rejected'));
    if (poll) { const time = url.searchParams.get('_'); if (!/^\d{13}$/.test(time ?? '') || Number(time) < state.startedAt - 1000 || Number(time) > clock() + 1000) deny(D('long_poll_scope_rejected')); }
  }
  async function scopedFetch(url, options, state, check) {
    const response = await awaitScoped(fetchImpl(url, { ...options, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([state.abort.signal, ...(options.signal ? [options.signal] : [])]) }), state);
    if (response.status === 401) report.retriesBlocked++;
    if (response.redirected || (response.url && response.url !== url.href) || response.status < 200 || response.status > 599) deny(D('long_poll_failed'));
    const text = await awaitScoped(response.clone().text(), state); if (text.length > 1048576) deny(D('long_poll_failed'));
    // This request was already authorized. Preserve server HTTP failures for
    // the original SignalR HttpClient instead of replacing its HttpError with
    // a local policy exception. The failed channel still cannot send again.
    if (!check(response.status)) {
      state.lpFailed = true;
      state.remoteFailure = { method: (options.method ?? 'GET').toUpperCase(), status: response.status,
        phase: state.lpInitialPollAccepted ? 'connected' : 'initial-poll' };
      return response;
    }
    if ((options.method ?? 'GET').toUpperCase() === 'GET') state.responseObserver.observe(text, state.nativeInvocationId);
    return response;
  }
  async function longPollingFetch(url, options) {
    const method = (options.method ?? 'GET').toUpperCase(), state = active;
    if (!state) deny(D('probe_not_active'));
    const headers = safeHeaders(options.headers);
    if (method === 'DELETE') {
      // Inspection/stop can outlast the request deadline. Closing this known
      // channel remains necessary until the authenticated lease expires; this
      // never permits another invocation or an extension of that lease.
      if (closed || !lease || clock() >= lease.expiresAt) deny(D('long_poll_cleanup_rejected'));
      longPollingUrl(url, state, false);
      if (!clientHeaders(headers) || ![undefined, ''].includes(options.body) || state.channel !== 'long-polling' || !state.lpStarted || state.lpDeleteAttempted) deny(D('long_poll_cleanup_rejected'));
      state.lpDeleteAttempted = true;
      const cleanup = (async () => {
        await persist('cleanup-attempt', state); // Immutable reservation: an uncertain DELETE is never repeated.
        if (closed || !lease || clock() >= lease.expiresAt) deny(D('long_poll_cleanup_rejected'));
        report.longPollingCleanupRequests++; report.networkRequests++;
        // Honor the original SignalR HTTP client's cancellation while bounding
        // the one cleanup attempt by the existing app-user lease. A fixed 2 s
        // replacement discarded the native signal and could stop cleanup early.
        const cleanupBudgetMs = Math.max(1, Math.floor(Math.min(15000, lease.expiresAt - clock())));
        state.cleanupBudgetMs = cleanupBudgetMs;
        const response = await fetchImpl(url, { ...options, redirect: 'error', credentials: 'omit',
          signal: AbortSignal.any([AbortSignal.timeout(cleanupBudgetMs), ...(options.signal ? [options.signal] : [])]) });
        state.cleanupStatus = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
        if (response.redirected || (response.url && response.url !== url.href) || response.status < 200 || response.status > 299) {
          state.cleanupFailure = response.redirected ? 'redirect' : response.url && response.url !== url.href ? 'url-mismatch' : 'http-status';
          deny(D('long_poll_cleanup_rejected'));
        }
        state.lpCleanupAccepted = true; state.cleanupStatus = response.status; report.longPollingCleanupAccepted++;
        await persist('cleanup-accepted', state); return response;
      })();
      cleanups.add(cleanup);
      try { return await cleanup; }
      catch (error) {
        state.cleanupFailure ??= ['TimeoutError','AbortError'].includes(error?.name) ? 'timeout-or-abort' : 'transport-or-evidence';
        if (REJECT_CODES.has(error?.message)) throw error; deny(D('long_poll_cleanup_rejected'));
      }
      finally { cleanups.delete(cleanup); }
    }
    current();
    if (!['GET', 'POST'].includes(method) || state.lpFailed) deny(D('long_poll_scope_rejected'));
    longPollingUrl(url, state, method === 'GET');
    if (!clientHeaders(headers, method === 'POST' ? ['content-type'] : [])) deny(D('long_poll_headers_rejected'));
    if (!state.longPollingText || state.negotiations !== 1 || (state.channel && state.channel !== 'long-polling')) deny(D('channel_already_selected'));
    if (!state.channel) { state.channel = 'long-polling'; report.selectedTransport = 'long-polling'; report.longPollingConnections++; }
    if (method === 'GET') {
      if (![undefined, ''].includes(options.body) || state.lpPollInFlight || state.lpPolls >= 256) deny(D('long_poll_limit'));
      if (!state.lpStarted) {
        state.lpStarted = true; state.lpCleanupHeaders = { ...headers };
        await persist('channel-opened', state);
        current();
      }
      state.lpPollInFlight = true; state.lpPolls++; report.longPollingPollRequests++;
    } else {
      if (!state.lpInitialPollAccepted || state.lpSendInFlight || state.lpSends >= 64) deny(D('long_poll_limit'));
      frames(options.body, state); state.lpSendInFlight = true; state.lpSends++; report.longPollingSendRequests++;
    }
    report.networkRequests++;
    try {
      const response = await scopedFetch(url, options, state, status => method === 'GET' ? [200, 204].includes(status) : status >= 200 && status <= 299);
      if (method === 'GET' && !state.lpInitialPollAccepted && !state.remoteFailure) { if (response.status !== 200) deny(D('long_poll_failed')); state.lpInitialPollAccepted = true; }
      return response;
    } catch (error) {
      if (method === 'GET' && options.signal?.aborted && !state.abort.signal.aborted) throw new Error('debug_odc_native_transport_poll_stopped');
      if (!state.abort.signal.aborted) { state.lpFailed = true; state.abort.abort(); }
      if (REJECT_CODES.has(error?.message)) throw error; deny(D('long_poll_failed'));
    } finally { if (method === 'GET') state.lpPollInFlight = false; else state.lpSendInFlight = false; }
  }
  async function restrictedFetch(input, options = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url ?? '', endpoints.appUrl);
    if (url.origin !== ORIGIN || url.username || url.password || url.hash) deny();
    if (url.pathname === HUB + '/negotiate') return negotiateFetch(url, options);
    if (url.pathname !== HUB) deny();
    return longPollingFetch(url, options);
  }
  class ScopedWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    #socket; #state; #handlers = new Map();
    constructor(value, protocols) {
      const state = current(); let url;
      try { url = new URL(value); } catch { deny(D('socket_scope_rejected')); }
      if (url.protocol !== 'wss:' || url.host !== HOST || url.pathname !== HUB || url.username || url.password || url.hash || [...url.searchParams.keys()].length !== 2 ||
          url.searchParams.get('id') !== state.connectionToken || url.searchParams.get('access_token') !== lease.accessToken || state.negotiations !== 1 || !state.webSocketsText) deny(D('socket_scope_rejected'));
      if (state.channel && state.channel !== 'websockets') deny(D('channel_already_selected'));
      if (state.sockets !== 0) { report.retriesBlocked++; deny(D('socket_already_attempted')); }
      state.sockets++; state.channel = 'websockets'; report.selectedTransport = 'websockets'; report.socketConnections++; this.#state = state;
      try { this.#socket = new WebSocketImpl(url.href, protocols); } catch { deny(D('socket_failed')); }
      sockets.add(this); this.#socket.addEventListener?.('close', () => sockets.delete(this));
      this.#socket.addEventListener?.('message', event => state.responseObserver.observe(event.data, state.nativeInvocationId));
    }
    get readyState() { return this.#socket.readyState; } get bufferedAmount() { return this.#socket.bufferedAmount; } get url() { return this.#socket.url; }
    get protocol() { return this.#socket.protocol; } get extensions() { return this.#socket.extensions; }
    get binaryType() { return this.#socket.binaryType; } set binaryType(value) { this.#socket.binaryType = value; }
    #setHandler(name, value) { this.#handlers.set(name, value); this.#socket[name] = typeof value === 'function' ? event => value.call(this, event) : value; }
    get onopen() { return this.#handlers.get('onopen') ?? null; } set onopen(value) { this.#setHandler('onopen', value); }
    get onmessage() { return this.#handlers.get('onmessage') ?? null; } set onmessage(value) { this.#setHandler('onmessage', value); }
    get onerror() { return this.#handlers.get('onerror') ?? null; } set onerror(value) { this.#setHandler('onerror', value); }
    get onclose() { return this.#handlers.get('onclose') ?? null; } set onclose(value) { this.#setHandler('onclose', value); }
    addEventListener(...args) { return this.#socket.addEventListener(...args); }
    removeEventListener(...args) { return this.#socket.removeEventListener(...args); }
    dispatchEvent(...args) { return this.#socket.dispatchEvent(...args); }
    send(data) {
      const state = current(); if (state !== this.#state || state.channel !== 'websockets') deny(D('message_rejected'));
      frames(data, state); try { this.#socket.send(data); } catch { deny(D('send_uncertain')); }
    }
    close(code, reason) { this.#socket.close(code, reason); }
  }
  return Object.freeze({
    endpoints, fetch: restrictedFetch, WebSocket: ScopedWebSocket,
    bindAuthenticatedLease({ binding, expiresAt, accessToken, userKey }) {
      if (closed || lease || binding?.lane !== 'odc' || binding.runtimeUrl !== endpoints.appUrl || binding.app !== endpoints.app || !/^[a-f0-9]{32}$/.test(binding.sessionId ?? '') ||
          typeof accessToken !== 'string' || !accessToken || /[\x00-\x20\x7f]/.test(accessToken) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= clock())
        fail('lease_binding_rejected');
      lease = { sessionId: binding.sessionId, expiresAt: Date.parse(expiresAt), accessToken, appUserKeySha256: typeof userKey === 'string' && userKey ? hash(userKey) : null };
    },
    configureServerInspection({ expiresAt }) {
      const deadline = Date.parse(expiresAt);
      if (closed || !lease || active || states.length || interactiveDeadline !== undefined ||
          !Number.isFinite(deadline) || deadline <= clock() || deadline > lease.expiresAt)
        fail('inspection_deadline_invalid');
      // The private coordinator supplies its already connected debugger lease.
      // The original DebuggerHttpClient remains responsible for the request;
      // this host must not cancel it on a normal HTTP timeout while inspecting.
      interactiveDeadline = deadline;
      report.inspectionExpiresAt = new Date(deadline).toISOString();
      return { configured: true, expiresAt: report.inspectionExpiresAt };
    },
    // One probe = one scenario: the action path and body the worker gated, consumed once, never reopened.
    async beginProbe({ probeId, path, serializedBody, headers, timeoutSeconds, bindingSessionId }) {
      if (closed || !lease || clock() >= lease.expiresAt || typeof probeId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(probeId) || !isScreenServicePath(endpoints, path) ||
          typeof serializedBody !== 'string' || serializedBody.length > 1048576 || bindingSessionId !== lease.sessionId || consumed.has(probeId) ||
          (active && !active.finished) || states.some(row => row.uncertain || (row.lpStarted && !row.lpCleanupAccepted))) fail('probe_gate_rejected');
      const nativeHeaders = safeHeaders(headers);
      if (Object.entries(nativeHeaders).some(([key, value]) => !['content-type', 'outsystems-ccid', 'outsystems-dbg-stop', 'outsystems-dbg-bkp', 'outsystems-locale'].includes(key) || value.length > 300))
        fail('native_headers_rejected');
      const normalTimeoutMs = originalTimeoutWithinLease(timeoutSeconds, lease.expiresAt, clock());
      if (interactiveDeadline !== undefined && clock() >= interactiveDeadline) fail('inspection_deadline_expired');
      const timeoutMs = interactiveDeadline === undefined ? normalTimeoutMs : interactiveDeadline - clock();
      consumed.add(probeId);
      const state = { probeId, path, body: serializedBody, headers: nativeHeaders, startedAt: clock(), deadline: clock() + timeoutMs, deadlineExpired: false, negotiations: 0,
        sockets: 0, handshakes: 0, pings: 0, invocations: 0, channel: null, lpPolls: 0, lpSends: 0, lpPollInFlight: false, lpSendInFlight: false, lpInitialPollAccepted: false,
        lpDeleteAttempted: false, lpCleanupAccepted: false, lpStarted: false, lpFailed: false, finished: false, uncertain: false, abort: new AbortController(), evidence: {},
        requestSha256: hash(serializedBody), nativeCallContextId: nativeHeaders['outsystems-ccid'] ?? null };
      state.responseObserver = createNativeResponseObserver(responseParityKey ? { parityKey: responseParityKey } : {});
      active = state; states.push(state);
      state.timer = setTimeout(() => stopActive({ deadline: true }), timeoutMs); state.timer.unref?.();
      if (typeof beforeActionRequest !== 'function') { stopActive(); fail('correlation_hook_missing'); }
      try {
        await persist('prepared', state);
        if (await awaitScoped(beforeActionRequest({ probeId, path, nativeCallContextSha256: state.nativeCallContextId ? hash(state.nativeCallContextId) : null,
          privateEvidenceConfirmed: state.evidence.prepared?.sealed === true, bindingSessionId: lease.sessionId, timeoutMs }), state) !== true) {
          stopActive(); fail('correlation_not_accepted');
        }
        current();
      } catch { stopActive(); fail('preflight_failed'); }
    },
    awaitNativeResult: promise => awaitScoped(promise, current()),
    compareNativeResponse: result => active?.responseObserver.compare(result) ?? { complete: false, reason: 'probe-not-active' },
    responseParity: () => active ? active.responseObserver.responsePrints(active.nativeInvocationId) : { complete: false, reason: 'probe-not-active' },
    finishProbe({ completed = false } = {}) {
      const state = active; if (!state) return;
      if (completed && state.invocations === 1) { state.uncertain = false; state.responseCompleted = true; }
      stopActive(); report.uncertain = states.some(row => row.uncertain);
    },
    probe: probeId => { const row = states.find(state => state.probeId === probeId); return row ? { negotiations: row.negotiations, socketConnections: row.sockets,
      longPolling: row.channel === 'long-polling', executeRequestSubmissions: row.invocations, finished: row.finished, uncertain: row.uncertain, deadlineExpired: row.deadlineExpired } : null; },
    receipt: () => ({ ...report,
      longPollingCleanupConfirmed: states.filter(row => row.lpStarted).every(row => row.lpCleanupAccepted),
      longPollingCleanupUncertain: states.some(row => row.lpStarted && !row.lpCleanupAccepted && (row.finished || row.lpDeleteAttempted)),
      probes: states.map(row => ({ probeId: row.probeId, negotiations: row.negotiations, socketConnections: row.sockets, executeRequestSubmissions: row.invocations,
        finished: row.finished, uncertain: row.uncertain,
        ...(row.remoteFailure ? { remoteFailure: { ...row.remoteFailure } } : {}),
        ...(row.lpDeleteAttempted ? { cleanup: { attempted: true, accepted: !!row.lpCleanupAccepted,
          status: row.cleanupStatus ?? null, failure: row.cleanupFailure ?? null,
          ...(row.cleanupBudgetMs === undefined ? {} : { budgetMs: row.cleanupBudgetMs }) } } : {}),
        correlation: { nativeCallContextSha256: row.nativeCallContextId ? hash(row.nativeCallContextId) : null,
          connectionTokenSha256: row.connectionToken ? hash(row.connectionToken) : row.connectionTokenSha256 ?? null,
          connectionIdSha256: row.connectionId ? hash(row.connectionId) : row.connectionIdSha256 ?? null,
          requestSha256: row.requestSha256, evidence: { ...row.evidence }, requestOwnershipProved: false } })) }),
    async dispose() {
      if (closed) return; stopActive();
      // Give the original SignalR stop/finally path time to submit and acknowledge its DELETE.
      const until = Date.now() + 2500;
      while (Date.now() < until && states.some(s => s.lpStarted && !s.lpDeleteAttempted))
        await new Promise(resolve => setTimeout(resolve, 10));
      await Promise.allSettled([...cleanups]);
      // The original published LongPolling.stop aborts polling then DELETEs the
      // negotiated URL. If its finally path never ran, close that same channel
      // once within the original authenticated lease only.
      if (active?.lpStarted && !active.lpDeleteAttempted && active.lpCleanupHeaders) {
        const url = new URL(HUB, ORIGIN); url.searchParams.set('id', active.connectionToken);
        try { await longPollingFetch(url, { method: 'DELETE', headers: active.lpCleanupHeaders }); } catch { /* receipt retains uncertainty */ }
      }
      for (const state of states) {
        try { await persist('finished', state); } catch { report.uncertain = true; state.uncertain = true; }
        state.connectionTokenSha256 = state.connectionToken ? hash(state.connectionToken) : null;
        state.connectionIdSha256 = state.connectionId ? hash(state.connectionId) : null;
      }
      closed = true; lease = undefined;
      // Clear process secrets only after durable private evidence has retained
      // correlation/cleanup identifiers. No bearer is persisted in that evidence.
      for (const state of states) { state.connectionToken = undefined; state.connectionId = undefined; state.body = undefined; state.headers = undefined; state.lpCleanupHeaders = undefined; state.responseObserver?.dispose(); }
    },
  });
}
