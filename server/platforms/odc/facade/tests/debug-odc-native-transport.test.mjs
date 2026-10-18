import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOdcNativeTransport, odcNativeEndpoints } from '../debug-odc-native-transport.mjs';

const endpoints = odcNativeEndpoints({ runtimeUrl: 'https://dev.example.test/Store/' });
const sid = 'a'.repeat(32), now = 1790000000000, token = 'synthetic-token';
const clientHeaders = { authorization: 'Bearer ' + token, 'x-requested-with': 'XMLHttpRequest', 'x-signalr-user-agent': 'Microsoft SignalR/8.0 (8.0.0; Browser; Unknown; Unknown Version)' };
const body = '{"versionInfo":{"moduleVersion":"v1"},"Amount":"12.50"}';
const originalHeaders = { 'content-type': 'application/json', 'outsystems-ccid': 'original-context' };
const handshake = JSON.stringify({ protocol: 'json', version: 1 }) + '\x1e';
const invocation = () => JSON.stringify({ type: 1, target: 'ExecuteRequest', invocationId: '0', arguments: ['/Store/screenservices/Store/F/Page/ActionCompute', body, originalHeaders] }) + '\x1e';
function fixture(t, { transport = 'WebSockets', beforeActionRequest = async () => true, privateEvidence, deleteStatus = 200, deleteFetch, remoteResponse, pollBody = () => '' } = {}) {
  const sends = [], requests = []; let time = now;
  class Socket extends EventTarget { readyState = 1; constructor(url) { super(); this.url = url; } send(data) { sends.push(data); } close() { this.readyState = 3; this.dispatchEvent(new Event('close')); } }
  const handle = createOdcNativeTransport({ endpoints, WebSocketImpl: Socket, clock: () => time, beforeActionRequest, privateEvidence,
    fetchImpl: async (url, options) => { requests.push({ url: url.href, method: options.method ?? 'GET', body: options.body });
      if (options.method === 'DELETE' && deleteFetch) return deleteFetch(url, options);
      if (!url.pathname.endsWith('/negotiate') && options.method !== 'DELETE' && remoteResponse) return remoteResponse(url, options);
      return url.pathname.endsWith('/negotiate') ? Response.json({ negotiateVersion: 1, connectionToken: 'connection', connectionId: 'id', availableTransports: [{ transport, transferFormats: ['Text'] }] }) : new Response((options.method ?? 'GET') === 'GET' ? pollBody() : '', { status: options.method === 'DELETE' ? deleteStatus : 200 }); },
  });
  t.after(() => handle.dispose());
  handle.bindAuthenticatedLease({ binding: { lane: 'odc', app: 'Store', runtimeUrl: endpoints.appUrl, sessionId: sid }, accessToken: token, expiresAt: new Date(now + 600000).toISOString() });
  const begin = id => handle.beginProbe({ probeId: id, path: '/Store/screenservices/Store/F/Page/ActionCompute', serializedBody: body, headers: originalHeaders, timeoutSeconds: 30, bindingSessionId: sid });
  const negotiate = () => handle.fetch(endpoints.origin + endpoints.hub + '/negotiate?negotiateVersion=1', { method: 'POST', headers: clientHeaders });
  const socket = () => new handle.WebSocket('wss://dev.example.test' + endpoints.hub + '?id=connection&access_token=' + token);
  return { handle, begin, negotiate, socket, sends, requests, advance: ms => { time += ms; } };
}

test('native websocket sends the original request once; a lost reply remains uncertain', async t => {
  const f = fixture(t); await f.begin('one'); await f.negotiate(); const ws = f.socket();
  ws.send(handshake); ws.send(invocation()); assert.equal(f.sends.length, 2);
  assert.throws(() => ws.send(invocation()), /invocation_rejected/); assert.equal(f.sends.length, 2);
  f.handle.finishProbe(); assert.equal(f.handle.receipt().uncertain, true);
  await assert.rejects(f.begin('two'), /probe_gate_rejected/);
});

for (const method of ['GET', 'POST']) for (const status of [401, 403, 404, 500, 503]) {
  test(`native ${method} HTTP ${status} is preserved without permitting a second invocation`, async t => {
    let failed = false;
    const payload = 'private remote diagnostic';
    const f = fixture(t, { transport: 'LongPolling', remoteResponse: (_url, options) => {
      const current = options.method ?? 'GET';
      return new Response(failed && current === method ? payload : '', {status: failed && current === method ? status : 200});
    }});
    await f.begin('one'); await f.negotiate();
    const channel = endpoints.origin + endpoints.hub + '?id=connection';
    await f.handle.fetch(channel + '&_=' + now, {headers:clientHeaders});
    if (method === 'GET') await f.handle.fetch(channel, {method:'POST',headers:{...clientHeaders,'content-type':'text/plain;charset=UTF-8'},body:handshake+invocation()});
    failed = true;
    const options = method === 'GET' ? {headers:clientHeaders} : {method:'POST',headers:{...clientHeaders,'content-type':'text/plain;charset=UTF-8'},body:handshake+invocation()};
    const response = await f.handle.fetch(channel + (method === 'GET' ? '&_='+now : ''), options);
    assert.equal(response.status,status); assert.equal(await response.text(),payload);
    assert.deepEqual(f.handle.receipt().probes[0].remoteFailure,{method,status,phase:'connected'});
    assert.equal(JSON.stringify(f.handle.receipt()).includes(payload),false);
    await assert.rejects(f.handle.fetch(channel,{method:'POST',headers:{...clientHeaders,'content-type':'text/plain;charset=UTF-8'},body:invocation()}),/long_poll_scope_rejected/);
    await f.handle.fetch(channel,{method:'DELETE',headers:clientHeaders}); f.handle.finishProbe();
    assert.equal(f.handle.receipt().executeRequestSubmissions,1);
    assert.equal(f.handle.receipt().uncertain,true);
    assert.equal(f.handle.receipt().longPollingCleanupConfirmed,true);
  });
}

test('an initial poll HTTP failure reaches the native client without sending an action', async t => {
  const f=fixture(t,{transport:'LongPolling',remoteResponse:()=>new Response('not found',{status:404})});
  await f.begin('one');await f.negotiate();
  const channel=endpoints.origin+endpoints.hub+'?id=connection';
  assert.equal((await f.handle.fetch(channel+'&_='+now,{headers:clientHeaders})).status,404);
  assert.deepEqual(f.handle.receipt().probes[0].remoteFailure,{method:'GET',status:404,phase:'initial-poll'});
  assert.equal(f.handle.receipt().executeRequestSubmissions,0);
  await assert.rejects(f.handle.fetch(channel,{method:'POST',headers:{...clientHeaders,'content-type':'text/plain;charset=UTF-8'},body:handshake+invocation()}),/long_poll_scope_rejected/);
});

test('long polling observes the original completion before returning the untouched response to SignalR', async t => {
  let body = '';
  const f = fixture(t, { transport: 'LongPolling', pollBody: () => body });
  await f.begin('one'); await f.negotiate();
  const channel = endpoints.origin + endpoints.hub + '?id=connection';
  await f.handle.fetch(channel + '&_=' + now, { headers: clientHeaders });
  await f.handle.fetch(channel, { method: 'POST', headers: { ...clientHeaders, 'content-type': 'text/plain;charset=UTF-8' }, body: handshake + invocation() });
  body = JSON.stringify({ type: 3, invocationId: '0', result: { ResponseStatusCode: 200, ResponseBody: '{"data":{"Result":42}}' } }) + '\x1e';
  const response = await f.handle.fetch(channel + '&_=' + now, { headers: clientHeaders });
  assert.equal(await response.text(), body);
  assert.equal(f.handle.compareNativeResponse({ data: { Result: 42 } }).envelopeRepresentationEqual, true);
  assert.equal(f.handle.compareNativeResponse({ data: { Result: 0 } }).envelopeRepresentationEqual, false);
  await f.handle.fetch(channel, { method: 'DELETE', headers: clientHeaders }); f.handle.finishProbe({ completed: true });
});

test('native answer clears execution uncertainty but cannot reopen a consumed probe', async t => {
  const f = fixture(t); await f.begin('one'); await f.negotiate(); const ws = f.socket();
  ws.send(handshake + invocation()); f.handle.finishProbe({ completed: true });
  assert.equal(f.handle.receipt().executeRequestSubmissions, 1); assert.equal(f.handle.receipt().uncertain, false);
  await assert.rejects(f.begin('one'), /probe_gate_rejected/); await f.begin('two');
});

test('scope and correlation refusals perform no business send', async t => {
  const f = fixture(t, { beforeActionRequest: async () => false });
  await assert.rejects(f.begin('refused'), /preflight_failed/); assert.equal(f.requests.length, 0);
  const g = fixture(t); await g.begin('one'); await g.negotiate();
  assert.throws(() => new g.handle.WebSocket('wss://other.example.test' + endpoints.hub + '?id=connection&access_token=' + token), /scope_rejected/);
  const ws = g.socket(); ws.send(handshake);
  assert.throws(() => ws.send(invocation().replace('ActionCompute', 'ActionDelete')), /invocation_rejected/);
  assert.equal(g.handle.receipt().executeRequestSubmissions, 0);
  await assert.rejects(g.negotiate(), /negotiation_already_attempted/);
});

test('long polling cleanup must be acknowledged separately from the action answer', async t => {
  const f = fixture(t, { transport: 'LongPolling' }); await f.begin('one'); await f.negotiate();
  const channel = endpoints.origin + endpoints.hub + '?id=connection';
  await f.handle.fetch(channel + '&_=' + now, { headers: clientHeaders });
  await f.handle.fetch(channel, { method: 'POST', headers: { ...clientHeaders, 'content-type': 'text/plain;charset=UTF-8' }, body: handshake + invocation() });
  f.handle.finishProbe({ completed: true }); assert.equal(f.handle.receipt().longPollingCleanupUncertain, true);
  await f.handle.fetch(channel, { method: 'DELETE', headers: clientHeaders });
  assert.equal(f.handle.receipt().longPollingCleanupConfirmed, true); assert.equal(f.handle.receipt().uncertain, false);
  await assert.rejects(f.handle.fetch(channel, { method: 'DELETE', headers: clientHeaders }), /cleanup_rejected/);
});

test('timeout permits one native channel cleanup without permitting a second business send', async t => {
  const f = fixture(t, { transport: 'LongPolling' }); await f.begin('one'); await f.negotiate();
  const channel = endpoints.origin + endpoints.hub + '?id=connection';
  await f.handle.fetch(channel + '&_=' + now, { headers: clientHeaders });
  await f.handle.fetch(channel, { method: 'POST', headers: { ...clientHeaders, 'content-type': 'text/plain;charset=UTF-8' }, body: handshake + invocation() });
  f.advance(90001); f.handle.finishProbe();
  await assert.rejects(f.handle.fetch(channel, { method: 'POST', headers: clientHeaders, body: invocation() }), /probe_expired/);
  await f.handle.fetch(channel, { method: 'DELETE', headers: clientHeaders });
  assert.equal(f.handle.receipt().longPollingCleanupConfirmed, true);
  assert.equal(f.handle.receipt().uncertain, true);
  assert.equal(f.handle.receipt().executeRequestSubmissions, 1);
  await assert.rejects(f.begin('two'), /probe_gate_rejected/);
});

test('interactive server inspection uses one fixed debugger lease instead of the normal request timeout', async t => {
  const f = fixture(t);
  const expiresAt = new Date(now + 240000).toISOString();
  assert.equal(f.handle.configureServerInspection({ expiresAt }).expiresAt, expiresAt);
  assert.throws(() => f.handle.configureServerInspection({ expiresAt: new Date(now + 500000).toISOString() }), /inspection_deadline_invalid/);
  await f.begin('one'); await f.negotiate(); const ws = f.socket();
  ws.send(handshake + invocation()); f.advance(90000);
  ws.send('{"type":6}\x1e'); // Still the original request/channel, never a new execution.
  assert.equal(f.handle.receipt().executeRequestSubmissions, 1);
  f.advance(150000);
  assert.throws(() => ws.send('{"type":6}\x1e'), /probe_expired/);
  const g = fixture(t);
  assert.throws(() => g.handle.configureServerInspection({ expiresAt: new Date(now + 600001).toISOString() }), /inspection_deadline_invalid/);
  await g.begin('ordinary'); g.advance(30001);
  await assert.rejects(g.negotiate(), /probe_expired/);
  assert.throws(() => g.handle.configureServerInspection({ expiresAt }), /inspection_deadline_invalid/);
});

test('delayed cleanup cannot use an expired app-user lease', async t => {
  const f = fixture(t, { transport: 'LongPolling' }); await f.begin('one'); await f.negotiate();
  const channel = endpoints.origin + endpoints.hub + '?id=connection';
  await f.handle.fetch(channel + '&_=' + now, { headers: clientHeaders });
  f.advance(600000); f.handle.finishProbe();
  await assert.rejects(f.handle.fetch(channel, { method: 'DELETE', headers: clientHeaders }), /cleanup_rejected/);
  assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 0);
});

test('cleanup preserves original native cancellation and never resends after an aborted attempt', async t => {
  const native = new AbortController(); let suppliedSignal;
  const f = fixture(t, { transport: 'LongPolling', deleteFetch: async (_url, options) => {
    suppliedSignal = options.signal;
    native.abort(new DOMException('native cancellation', 'AbortError'));
    assert.equal(suppliedSignal.aborted, true);
    throw suppliedSignal.reason;
  } });
  await f.begin('one'); await f.negotiate();
  const channel = endpoints.origin + endpoints.hub + '?id=connection';
  await f.handle.fetch(channel + '&_=' + now, { headers: clientHeaders });
  f.handle.finishProbe({ completed: true });
  await assert.rejects(f.handle.fetch(channel, { method: 'DELETE', headers: clientHeaders, signal: native.signal }), /cleanup_rejected/);
  await f.handle.dispose();
  assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 1);
  assert.equal(f.handle.receipt().longPollingCleanupConfirmed, false);
  assert.equal(f.handle.receipt().probes[0].cleanup.failure, 'timeout-or-abort');
});

test('cleanup budget is capped by the original lease without extending it', async t => {
  const f = fixture(t, { transport: 'LongPolling' }); await f.begin('one'); await f.negotiate();
  const channel = endpoints.origin + endpoints.hub + '?id=connection';
  await f.handle.fetch(channel + '&_=' + now, { headers: clientHeaders });
  f.advance(599250); f.handle.finishProbe({ completed: true });
  await f.handle.fetch(channel, { method: 'DELETE', headers: clientHeaders });
  assert.equal(f.handle.receipt().probes[0].cleanup.budgetMs, 750);
  assert.equal(f.handle.receipt().longPollingCleanupConfirmed, true);
});

test('native cleanup may finish after two seconds within the existing lease', async t => {
  const f = fixture(t, { transport: 'LongPolling', deleteFetch: async (_url, { signal }) => {
    await new Promise((resolve, reject) => {
      const done = () => { signal.removeEventListener('abort', aborted); resolve(); };
      const aborted = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(done, 2100);
      signal.addEventListener('abort', aborted, { once: true });
    });
    return new Response(null, { status: 204 });
  } });
  await f.begin('one'); await f.negotiate();
  const channel = endpoints.origin + endpoints.hub + '?id=connection';
  await f.handle.fetch(channel + '&_=' + now, { headers: clientHeaders });
  f.handle.finishProbe({ completed: true });
  await f.handle.fetch(channel, { method: 'DELETE', headers: clientHeaders });
  assert.equal(f.handle.receipt().longPollingCleanupConfirmed, true);
  assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 1);
});

test('private identifiers are durable before send and only hashes reach public receipts and hooks', async t => {
  const records = [], metadata = [];
  const f = fixture(t, { transport: 'LongPolling', privateEvidence: { write: async (stage, probeId, data) => {
    records.push({ stage, probeId, data: structuredClone(data) }); return { sealed: true, sha256: 'f'.repeat(64) };
  } }, beforeActionRequest: async info => { metadata.push(info); return true; } });
  await f.begin('one'); assert.deepEqual(records.map(x => x.stage), ['prepared']);
  await f.negotiate(); assert.equal(records[1].data.connectionToken, 'connection');
  const channel = endpoints.origin + endpoints.hub + '?id=connection';
  await f.handle.fetch(channel + '&_=' + now, { headers: clientHeaders });
  assert.equal(records[2].stage, 'channel-opened'); assert.equal(f.handle.receipt().executeRequestSubmissions, 0);
  await f.handle.fetch(channel, { method: 'POST', headers: { ...clientHeaders, 'content-type': 'text/plain;charset=UTF-8' }, body: handshake + invocation() });
  f.handle.finishProbe();
  await f.handle.fetch(channel, { method: 'DELETE', headers: clientHeaders }); await f.handle.dispose();
  assert.deepEqual(records.map(x => x.stage), ['prepared', 'negotiated', 'channel-opened', 'cleanup-attempt', 'cleanup-accepted', 'finished']);
  assert.equal(JSON.stringify(records).includes(token), false); assert.equal(records[0].data.nativeCallContextId, 'original-context');
  assert.equal(JSON.stringify(metadata).includes('original-context'), false);
  assert.equal(JSON.stringify(f.handle.receipt()).includes('original-context'), false);
  assert.equal(f.handle.receipt().probes[0].correlation.evidence.finished.sealed, true);
  assert.equal(f.handle.receipt().probes[0].correlation.requestOwnershipProved, false);
});

test('dispose completes a missed native DELETE once but does not convert a lost action response into success', async t => {
  const f = fixture(t, { transport: 'LongPolling' }); await f.begin('one'); await f.negotiate();
  const channel = endpoints.origin + endpoints.hub + '?id=connection';
  await f.handle.fetch(channel + '&_=' + now, { headers: clientHeaders });
  await f.handle.fetch(channel, { method: 'POST', headers: { ...clientHeaders, 'content-type': 'text/plain;charset=UTF-8' }, body: handshake + invocation() });
  f.handle.finishProbe(); await f.handle.dispose();
  assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 1);
  assert.equal(f.handle.receipt().longPollingCleanupConfirmed, true); assert.equal(f.handle.receipt().uncertain, true);
});

test('failed cleanup is never resent during disposal, and persistence failure prevents business network', async t => {
  const f = fixture(t, { transport: 'LongPolling', deleteStatus: 503 }); await f.begin('one'); await f.negotiate();
  const channel = endpoints.origin + endpoints.hub + '?id=connection';
  await f.handle.fetch(channel + '&_=' + now, { headers: clientHeaders });
  await assert.rejects(f.handle.fetch(channel, { method: 'DELETE', headers: clientHeaders }), /cleanup_rejected/);
  await f.handle.dispose(); assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 1);
  assert.equal(f.handle.receipt().longPollingCleanupUncertain, true);
  assert.deepEqual(f.handle.receipt().probes[0].cleanup,{attempted:true,accepted:false,status:503,failure:'http-status',budgetMs:15000});
  const blocked = fixture(t, { privateEvidence: { write: async () => { throw new Error('private vault unavailable'); } } });
  await assert.rejects(blocked.begin('one'), /preflight_failed/); assert.equal(blocked.requests.length, 0);
});
