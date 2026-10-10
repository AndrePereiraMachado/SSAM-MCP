// The agent side of the channel `ssam-agent/1` (docs/FASE2-AGENTE.md 2 and 3). Outbound only: POST hello, a
// long-lived GET of NDJSON lines (call, ping, close), POSTs of outbox batches, PUT/GET of blob parts. Node built-ins
// only (fetch). Reconnection 1, 2, 4, 8, 16, 30 s (+-20%), back to 1 s after 60 s of a stable channel; the stream is
// dead after 45 s without a line. Stops for good (run() resolves) with 2 on 401/403/revoked/expired/rotated, 3 on
// replaced, 4 on 409, 0 after stop(); protocol-error and server-stop reconnect.
// C03 (fase4): a POST of messages gives up after 10 s (plus 1 s per 64 KiB of its batch), so a stuck POST never holds the
// channel; a pong goes in a POST of its own, never behind a result; the stream GET gives up after 15 s without response
// headers; a stream that fails right after a successful hello says hello again at once, one time, before any backoff.
export const PROTOCOL = 'ssam-agent/1';
export const EXIT = Object.freeze({ stopped: 0, credential: 2, replaced: 3, protocol: 4 });
const CLOSE_EXIT = { revoked: 2, expired: 2, rotated: 2, replaced: 3 };
const DEAD_MS = 45000;
const STABLE_MS = 60000;
const REQUEST_MS = 120000;
// The POST of a batch of messages (C03): 10 s, plus 1 s per 64 KiB of the batch (a 1 MiB batch: 26 s, still under the
// hub's 45 s dead timer); the stream's response headers: 15 s.
export const MESSAGES_MS = 10000;
export const STREAM_HEADERS_MS = 15000;
export const messagesTimeoutMs = (bytes, base = MESSAGES_MS) => base + Math.ceil(Math.max(0, Number(bytes) || 0) / 65536) * 1000;

export function createChannel({ server, credential, hello, onCall, outbox, pongVersions = () => undefined, fetch = globalThis.fetch,
  now = Date.now, setTimeout: setTimer = globalThis.setTimeout, clearTimeout: clearTimer = globalThis.clearTimeout, random = Math.random,
  log = () => {}, onState = () => {}, deadMs = DEAD_MS, messagesMs = MESSAGES_MS, streamHeadersMs = STREAM_HEADERS_MS }) {
  const base = String(server ?? '').replace(/\/+$/, '');
  let welcome = null; let channel = null; let stream = null; let resolveRun = null;
  // connecting: a hello or a stream request is in flight; connected: the stream is open.
  let connecting = false; let connected = false; let stopped = false;
  let attempt = 0; let connectedAt = 0; let postFailures = 0;
  // One immediate hello after a stream that failed right after a successful hello (C03: 3 of 5 reconnections of a client
  // session got a hello but no stream); reset when a stream opens.
  let quickHelloUsed = false;
  let reconnectTimer = null; let deadTimer = null; let flushTimer = null;

  const auth = () => ({ authorization: 'Bearer ' + credential });
  const request = (method, route, { json, body, headers = {}, signal, timeoutMs = REQUEST_MS } = {}) => {
    const init = { method, headers: { ...auth(), ...headers }, signal: signal ?? AbortSignal.timeout(timeoutMs) };
    if (json !== undefined) { init.body = typeof json === 'string' ? json : JSON.stringify(json); init.headers['content-type'] = 'application/json'; }
    else if (body !== undefined) init.body = body;
    return fetch(base + route, init);
  };
  const discard = async reply => { try { await reply.arrayBuffer(); } catch { /* body already gone */ } };
  const clear = timer => { if (timer) clearTimer(timer); return null; };

  function finish(code, reason) {
    if (stopped) return;
    stopped = true; connected = false; connecting = false;
    reconnectTimer = clear(reconnectTimer); deadTimer = clear(deadTimer); flushTimer = clear(flushTimer);
    if (stream) { const current = stream; stream = null; current.abort(); }
    log('exit', { code, reason });
    onState('stopped', { exitCode: code, reason });
    resolveRun?.(code);
  }

  function retry(minMs = 0) {
    if (stopped) return;
    connecting = false;
    const step = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    attempt++;
    const wait = Math.max(minMs, Math.round(step * (0.8 + random() * 0.4)));
    log('reconnect', { delayMs: wait });
    onState('reconnecting', { delayMs: wait });
    reconnectTimer = setTimer(() => { reconnectTimer = null; connect(); }, wait);
  }

  // The open channel is gone (stream ended or dead, close protocol-error/server-stop, channel unknown): once.
  function lose(reason) {
    if (stopped || connecting || reconnectTimer) return;
    if (stream) { const current = stream; stream = null; current.abort(); }
    deadTimer = clear(deadTimer);
    if (connected && now() - connectedAt >= STABLE_MS) attempt = 0;
    connected = false;
    log('disconnected', { reason });
    retry();
  }

  const armDead = () => { clear(deadTimer); deadTimer = setTimer(() => { deadTimer = null; lose('dead'); }, deadMs); };

  async function connect() {
    if (stopped) return;
    connecting = true;
    onState('connecting');
    let reply;
    try { reply = await request('POST', '/agent/v1/hello', { json: await hello() }); }
    catch (error) { log('hello-failed', { error: error.message }); return retry(); }
    if (stopped) return;
    if (reply.status === 401 || reply.status === 403) { await discard(reply); return finish(EXIT.credential, 'hello-' + reply.status); }
    if (reply.status === 409) { await discard(reply); return finish(EXIT.protocol, 'protocol-unsupported'); }
    if (reply.status !== 200) {
      const after = Number(reply.headers.get('retry-after'));
      await discard(reply);
      log('hello-refused', { status: reply.status });
      return retry(Number.isFinite(after) && after > 0 ? after * 1000 : 0);
    }
    const body = await reply.json().catch(() => null);
    if (body?.t !== 'welcome' || !/^[0-9a-f]{32}$/.test(body.channel ?? '')) { log('welcome-invalid'); return retry(); }
    welcome = body; channel = body.channel;
    openStream();
  }

  // A stream that did not open right after a successful hello: hello again at once, one time; then the backoff.
  function streamFailed() {
    if (!quickHelloUsed) { quickHelloUsed = true; log('rehello', { after: 'stream-failed' }); return connect(); }
    return retry();
  }

  async function openStream() {
    const controller = new AbortController();
    stream = controller;
    let response;
    // Only the response headers have a deadline (15 s): the body is the long-lived stream itself.
    const headersTimer = globalThis.setTimeout(() => controller.abort(new Error('no stream headers in ' + streamHeadersMs + ' ms')), streamHeadersMs);
    try { response = await fetch(base + '/agent/v1/stream?channel=' + channel, { headers: auth(), signal: controller.signal }); }
    catch (error) {
      globalThis.clearTimeout(headersTimer);
      if (stream === controller) { stream = null; log('stream-failed', { error: error.message }); streamFailed(); }
      return;
    }
    globalThis.clearTimeout(headersTimer);
    if (stream !== controller) return;
    if (response.status === 401 || response.status === 403) { await discard(response); return finish(EXIT.credential, 'stream-' + response.status); }
    if (response.status !== 200 || !response.body) { await discard(response); stream = null; log('stream-refused', { status: response.status }); return streamFailed(); }
    connecting = false; connected = true; connectedAt = now(); postFailures = 0; quickHelloUsed = false;
    flushTimer = clear(flushTimer);
    log('connected', { resumed: welcome.resumed === true });
    onState('connected');
    armDead();
    flush();
    const limit = welcome.maxMessageBytes ?? 1048576;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body) {
        if (stream !== controller) return;
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          armDead();
          if (line.trim()) handleLine(line);
          if (stream !== controller) return;
        }
        if (Buffer.byteLength(buffer) > limit) return lose('line-too-long');
      }
      if (stream === controller) lose('stream-ended');
    } catch (error) {
      if (stream === controller) lose('stream-error: ' + error.message);
    }
  }

  function handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { log('line-invalid'); return; }
    if (message?.t === 'ping') {
      const versions = pongVersions();
      sendPong(versions ? { t: 'pong', seq: message.seq, versions } : { t: 'pong', seq: message.seq });
    } else if (message?.t === 'call' && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 128) {
      onCall(message);
    } else if (message?.t === 'close') {
      log('close', { reason: message.reason });
      const code = CLOSE_EXIT[message.reason];
      if (code !== undefined) finish(code, 'close-' + message.reason); else lose('close-' + message.reason);
    }
  }

  // A pong in a POST of its own (C03): never queued behind a result in flight, never sent again (the next ping asks for a
  // new one). It is what keeps the hub's dead timer quiet while a long result is being posted.
  async function sendPong(message) {
    if (!connected || stopped || !channel) return;
    try {
      const reply = await request('POST', '/agent/v1/messages?channel=' + channel, { json: { messages: [message] }, timeoutMs: messagesMs });
      await discard(reply);
      if (reply.status === 401 || reply.status === 403) finish(EXIT.credential, 'messages-' + reply.status);
    } catch (error) { log('pong-failed', { error: error.message }); }
  }

  async function flush() {
    if (!connected || stopped || outbox.busy()) return;
    const batch = outbox.take((welcome?.maxMessageBytes ?? 1048576) - 64);
    if (!batch) return;
    const sentOn = channel;
    let status = 0;
    try {
      const body = JSON.stringify({ messages: batch });
      const reply = await request('POST', '/agent/v1/messages?channel=' + sentOn, { json: body, timeoutMs: messagesTimeoutMs(Buffer.byteLength(body), messagesMs) });
      status = reply.status;
      await discard(reply);
    } catch (error) { log('post-failed', { error: error.message }); }
    if (status === 204 || status === 200) { outbox.ack(); postFailures = 0; return flush(); }
    if (status === 413 && batch.length === 1) { outbox.drop(); log('message-dropped', { t: batch[0].t }); return flush(); }
    outbox.nack();
    if (stopped) return;
    if (status === 401 || status === 403) return finish(EXIT.credential, 'messages-' + status);
    // 404 on this channel: it is gone. On an older one (a POST still in flight across a reconnection): the batch goes
    // again at once on the current channel, whose own flush returned while this one was in flight.
    if (status === 404) { if (channel === sentOn) lose('channel-unknown'); else flush(); return; }
    // No 204 (connection lost, 5xx): the batch stays first in the queue; asked again with backoff on this channel,
    // and at once on the next one.
    postFailures++;
    flushTimer = clear(flushTimer);
    flushTimer = setTimer(() => { flushTimer = null; flush(); }, Math.min(30000, 1000 * 2 ** Math.min(postFailures - 1, 5)));
  }

  return {
    run() {
      return new Promise(resolve => { resolveRun = resolve; connect(); });
    },
    // Clean shutdown: tell the server (DELETE /agent/v1/channel, best effort) and resolve run() with 0.
    async stop() {
      if (stopped) return;
      const current = channel;
      if (current) {
        try { await discard(await request('DELETE', '/agent/v1/channel?channel=' + current, { signal: AbortSignal.timeout(3000) })); }
        catch { /* the server's dead timer covers it */ }
      }
      finish(EXIT.stopped, 'stop');
    },
    flush,
    welcome: () => welcome,
    connected: () => connected,
    async blobPut(transfer, index, body, headers) {
      if (!channel) throw new Error('not connected');
      const reply = await request('PUT', `/agent/v1/blobs/${transfer}/${index}?channel=${channel}`, { body, headers });
      await discard(reply);
      return reply.status;
    },
    async blobGet(transfer, index) {
      if (!channel) throw new Error('not connected');
      const reply = await request('GET', `/agent/v1/blobs/${transfer}/${index}?channel=${channel}`);
      return { status: reply.status, body: Buffer.from(await reply.arrayBuffer()), partSha: reply.headers.get('x-ssam-part-sha256') };
    },
  };
}
