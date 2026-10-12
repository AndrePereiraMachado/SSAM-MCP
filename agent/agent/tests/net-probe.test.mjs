// The kind net.probe of the network check (fase4-24, docs/FASE2-AGENTE.md 2.10), alone: the plan is checked before
// anything is sent, the uploads of a group leave at once with random bodies on connections of their own, a group that is
// not the last keeps to 40% of the budget, an upload still running when its time is up is aborted, and the channel's
// probePut speaks the hub's route. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { netProbe, probePlan, PROBE_DEFAULTS, PROBE_MAX_BYTES, NET_PROBE_KIND } from '../lib/net-probe.mjs';
import { createChannel } from '../lib/channel.mjs';
import { createHttp } from '../lib/net.mjs';
import { createOutbox } from '../lib/outbox.mjs';
import { listenInRange } from './fixtures/ports.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('net.probe: the plan is checked before anything is sent (sizes, counts, totals, budget); the default is 8 x 1 KiB then 2 x 1 MiB in 4.5 s', async () => {
  assert.equal(NET_PROBE_KIND, 'net.probe');
  assert.deepEqual(probePlan({}), { groups: [{ bytes: 1024, count: 8 }, { bytes: 1048576, count: 2 }], budgetMs: 4500 });
  assert.deepEqual(probePlan({ probes: [{ bytes: 5000, count: 1 }, { bytes: 10, count: 2 }], budgetMs: 800 }).groups.map(g => g.bytes), [10, 5000], 'smaller first');
  const sent = [];
  const put = async (...args) => { sent.push(args); return { status: 200, value: {} }; };
  for (const params of [{ probes: [] }, { probes: [{ bytes: 0, count: 1 }] }, { probes: [{ bytes: PROBE_MAX_BYTES + 1, count: 1 }] },
    { probes: [{ bytes: 10, count: 17 }] }, { probes: [{ bytes: 10, count: 16 }, { bytes: 10, count: 9 }] },
    { probes: [{ bytes: PROBE_MAX_BYTES, count: 5 }] }, { budgetMs: 100 }, { budgetMs: 60000 }, { probes: 'x' }, []]) {
    await assert.rejects(netProbe(params, { put }), error => error.code === 'PARAMS_INVALID' && error.executed === false, JSON.stringify(params));
  }
  await assert.rejects(netProbe({}, {}), error => error.code === 'NET_PROBE_UNAVAILABLE' && error.executed === false);
  assert.equal(sent.length, 0, 'nothing was sent for a refused plan');
  assert.equal(PROBE_DEFAULTS.budgetMs, 4500);
});

test('net.probe: each group leaves at once, random bodies, fresh connections, smaller first; answers via and serverMs', async () => {
  const seen = [];
  let inFlight = 0, peak = 0;
  const put = async (id, body, options) => {
    inFlight++; peak = Math.max(peak, inFlight);
    seen.push({ id, size: body.length, fresh: options.fresh, signal: options.signal instanceof AbortSignal, head: body.subarray(0, 8).toString('hex') });
    await sleep(body.length > 1000 ? 40 : 10);
    inFlight--;
    return { status: 200, value: { ok: true, bytes: body.length, ms: 3, via: '177.26.82.x' } };
  };
  const result = await netProbe({ probes: [{ bytes: 2048, count: 2 }, { bytes: 64, count: 4 }], budgetMs: 2000 }, { put });
  assert.equal(result.probes.length, 6);
  assert.deepEqual(seen.map(s => s.size), [64, 64, 64, 64, 2048, 2048], 'the small group first');
  assert.equal(peak, 4, 'the uploads of a group leave at once');
  assert.ok(seen.every(s => s.fresh === true && s.signal), 'every upload on a connection of its own, under the budget signal');
  assert.equal(new Set(seen.map(s => s.id)).size, 6);
  assert.ok(seen.every(s => /^[0-9a-f]{32}$/.test(s.id)));
  assert.equal(new Set(seen.map(s => s.head)).size, 6, 'random bodies');
  assert.ok(result.probes.every(p => p.ok === true && p.status === 200 && p.via === '177.26.82.x' && p.serverMs === 3 && Number.isFinite(p.ms)));
  assert.equal(result.budgetMs, 2000);
});

test('net.probe: an upload that stalls is aborted at the end of its window (early groups get 40% of the budget); the others still answer', async () => {
  const put = (id, body, { signal }) => new Promise((resolve, reject) => {
    if (body.length === 32) return resolve({ status: 200, value: { via: '10.0.0.x' } });
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const started = Date.now();
  const result = await netProbe({ probes: [{ bytes: 16, count: 2 }, { bytes: 32, count: 2 }, { bytes: 4096, count: 1 }], budgetMs: 1000 }, { put });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 950 && elapsed < 2000, 'the check keeps to its budget: ' + elapsed);
  const bySize = size => result.probes.filter(p => p.bytes === size);
  assert.ok(bySize(16).every(p => p.ok === false && p.error === 'budget' && p.ms >= 380 && p.ms < 700), JSON.stringify(bySize(16)));
  assert.ok(bySize(32).every(p => p.ok === true));
  assert.ok(bySize(4096).every(p => p.ok === false && p.error === 'budget'));
  const failed = await netProbe({ probes: [{ bytes: 8, count: 1 }], budgetMs: 500 }, { put: async () => { throw new Error('ECONNRESET'); } });
  assert.deepEqual(failed.probes.map(p => [p.ok, p.status, p.error]), [[false, 0, 'ECONNRESET']]);
});

test('channel.probePut: PUT /agent/v1/probe/<id>?channel=<ch> with the credential, a body of its own and the JSON answer', async () => {
  const credential = 'ssam_agent_' + 'A'.repeat(43);
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], size: Buffer.concat(chunks).length, port: req.socket.remotePort });
      if (req.url.startsWith('/agent/v1/hello')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ t: 'welcome', channel: 'c'.repeat(32) })); return; }
      if (req.url.startsWith('/agent/v1/stream')) { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.flushHeaders(); return; }
      if (req.url.startsWith('/agent/v1/probe/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, bytes: Buffer.concat(chunks).length, ms: 1, via: '127.0.0.x' })); return; }
      res.writeHead(204); res.end();
    });
  });
  const port = await listenInRange(server);
  const transport = createHttp();
  const channel = createChannel({ server: 'http://127.0.0.1:' + port, credential, hello: async () => ({ t: 'hello' }), onCall: () => {}, outbox: createOutbox(), fetch: transport.fetch });
  const running = channel.run();
  try {
    for (let i = 0; i < 100 && !channel.connected(); i++) await sleep(20);
    assert.equal(channel.connected(), true);
    const id = 'ab'.repeat(16);
    const a = await channel.probePut(id, Buffer.alloc(3000, 1));
    const b = await channel.probePut(id, Buffer.alloc(10, 1));
    assert.deepEqual(a, { status: 200, value: { ok: true, bytes: 3000, ms: 1, via: '127.0.0.x' } });
    assert.equal(b.value.bytes, 10);
    const probes = requests.filter(r => r.url.startsWith('/agent/v1/probe/'));
    assert.equal(probes.length, 2);
    assert.ok(probes.every(r => r.method === 'PUT' && r.url === '/agent/v1/probe/' + id + '?channel=' + 'c'.repeat(32) && r.auth === 'Bearer ' + credential && r.type === 'application/octet-stream'));
    assert.notEqual(probes[0].port, probes[1].port, 'each upload on a connection of its own');
  } finally {
    await channel.stop(); transport.close(); await running;
    await new Promise(resolve => server.close(resolve));
    server.closeAllConnections?.();
  }
});
