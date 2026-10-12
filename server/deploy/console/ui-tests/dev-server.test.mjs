// Mock dev server (DESIGN.md 6.12): loopback static files with the console's headers, /api/* from the scenario folder
// chosen by X-Mock-Scenario, the key rule, the console's POST checks, and /mock/* never served.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pub, fixture } from './helpers.mjs';

const { createDevServer } = await import(pub('mock/dev-server.mjs'));

async function withServer(fn) {
  const server = createDevServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

const KEY = { 'X-SSAM-Console-Key': 'mock' };

test('static files carry the console headers (CSP on HTML) and /mock, .mjs and traversal are refused', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal(r.headers.get('content-security-policy'), "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    await r.text();
    for (const p of ['/app.css', '/js/main.js', '/js/views/visao.js', '/favicon.svg']) {
      const x = await fetch(base + p);
      assert.equal(x.status, 200, p);
      await x.text();
    }
    for (const p of ['/mock/normal/meta.json', '/mock/dev-server.mjs', '/mock/make-fixtures.mjs', '/%2e%2e/server.mjs', '/../ui-tests/run-all.mjs', '/js/nao-existe.js']) {
      const x = await fetch(base + p);
      assert.equal(x.status, 404, p);
      await x.text();
    }
  });
});

test('the API needs a key (any key in mock mode) and answers each scenario from its folder', async () => {
  await withServer(async (base) => {
    const noKey = await fetch(`${base}/api/meta`);
    assert.equal(noKey.status, 401);
    assert.equal((await noKey.json()).error.code, 'KEY_REQUIRED');
    const meta = await (await fetch(`${base}/api/meta`, { headers: KEY })).json();
    assert.equal(meta.capabilities.renew, true);
    const sem = await (await fetch(`${base}/api/meta`, { headers: { ...KEY, 'X-Mock-Scenario': 'sem-renovar' } })).json();
    assert.equal(sem.capabilities.renew, false);
    const vps = await (await fetch(`${base}/api/vps`, { headers: { ...KEY, 'X-Mock-Scenario': 'sem-coletor' } })).json();
    assert.equal(vps.collector.state, 'missing');
    const unknown = await (await fetch(`${base}/api/overview`, { headers: { ...KEY, 'X-Mock-Scenario': 'outro' } })).json();
    assert.equal(unknown.ok, true, 'unknown scenario falls back to normal');
    const invalid = await fetch(`${base}/api/overview`, { headers: { ...KEY, 'X-Mock-Scenario': 'chave-invalida' } });
    assert.equal(invalid.status, 401);
    assert.equal((await invalid.json()).error.code, 'KEY_INVALID');
    await assert.rejects(fetch(`${base}/api/overview`, { headers: { ...KEY, 'X-Mock-Scenario': 'sem-conexao' } }));
  });
});

test('usage ranges, the one-day and one-customer filters, events after a seq, history', async () => {
  await withServer(async (base) => {
    const get = async (p, h = {}) => (await fetch(base + p, { headers: { ...KEY, ...h } })).json();
    assert.equal((await get('/api/usage?range=today')).range.kind, 'today');
    assert.equal((await get('/api/usage?range=30d')).range.days, 30);
    const day = await get('/api/usage?range=day&day=2026-10-08');
    assert.deepEqual([day.range.kind, day.range.from, day.range.to, day.byDay.length], ['day', '2026-10-08', '2026-10-08', 1]);
    const one = await get('/api/usage?range=7d&token=tok_0000000a1fa0');
    assert.deepEqual(one.byCustomer.map((c) => c.token), ['tok_0000000a1fa0']);
    const ring = fixture('normal', 'events');
    const first = await get('/api/events');
    assert.deepEqual([first.events.length, first.lastSeq], [ring.events.length, ring.lastSeq], 'a page load gets the ring without synthetic events');
    const all = await get('/api/events?limit=5');
    assert.equal(all.events.length, 5);
    const after = await get(`/api/events?after=${all.events[2].seq}`);
    assert.ok(after.events.every((e) => e.seq > all.events[2].seq));
    const empty = await get('/api/events', { 'X-Mock-Scenario': 'vazio' });
    assert.deepEqual([empty.lastSeq, empty.events.length], [0, 0]);
    const hist = await get('/api/history?token=tok_000000006a3a');
    assert.ok(hist.entries.length > 0 && hist.entries.every((e) => e.token === 'tok_000000006a3a'));
  });
});

test('mutations: JSON only, exact confirmation, 501 without renew, 409 on a revoked license, 201 issue', async () => {
  await withServer(async (base) => {
    const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body) });
    const text = await fetch(`${base}/api/licenses`, { method: 'POST', headers: { ...KEY, 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(text.status, 415);
    await text.text();
    const big = await post('/api/licenses', { customer: 'x'.repeat(9000) });
    assert.equal(big.status, 413);
    await big.text();
    const opt = await fetch(`${base}/api/meta`, { method: 'OPTIONS', headers: KEY });
    assert.equal(opt.status, 405);
    assert.equal(opt.headers.get('access-control-allow-origin'), null);
    await opt.text();
    const mismatch = await post('/api/licenses', { customer: 'Cliente Omega', days: 30, lanes: ['odc'], confirm: 'cliente omega' });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, 'CONFIRM_MISMATCH');
    const issued = await post('/api/licenses', { customer: 'Cliente Omega', days: 30, lanes: ['o11'], confirm: 'Cliente Omega' });
    assert.equal(issued.status, 201);
    const body = await issued.json();
    assert.deepEqual([body.license.customer, body.license.lanes.join()], ['Cliente Omega', 'o11']);
    assert.match(body.secret.token, /^ssam_EXEMPLO_NAO_E_UM_TOKEN_/);
    const dup = await (await post('/api/licenses', { customer: 'Cliente Alfa', days: null, lanes: ['odc'], confirm: 'Cliente Alfa' })).json();
    assert.deepEqual(dup.duplicates, ['tok_0000000a1fa0']);
    assert.equal(dup.license.expiresAt, null);
    const renew = await (await post('/api/licenses/tok_00000000be7a/renew', { days: 30, confirm: 'Cliente Beta', expectExpiresAt: '2026-10-15T02:58:00Z' })).json();
    assert.equal(renew.expiresAt, '2026-11-14T02:58:00Z');
    const noRenew = await post('/api/licenses/tok_00000000be7a/renew', { days: 30, confirm: 'Cliente Beta' }, { 'X-Mock-Scenario': 'sem-renovar' });
    assert.equal(noRenew.status, 501);
    assert.equal((await noRenew.json()).error.code, 'NOT_SUPPORTED');
    const revoked = await post('/api/licenses/tok_000000006a3a/revoke', { confirm: 'Cliente Gama' });
    assert.equal(revoked.status, 409);
    await revoked.text();
    const lanes = await (await post('/api/licenses/tok_0000000a1fa0/lanes', { lanes: ['odc'], confirm: 'Cliente Alfa', expectLanes: ['odc', 'o11'] })).json();
    assert.deepEqual([lanes.previousLanes.join(), lanes.license.lanes.join(), lanes.openSessions], ['odc,o11', 'odc', 1]);
    const rot = await (await post('/api/licenses/tok_0000000a1fa0/agent-rotate', { confirm: 'Cliente Alfa' })).json();
    assert.match(rot.secret.agentCredential, /^ssam_agent_EXEMPLO_/);
    const unknown = await post('/api/licenses/tok_ffffffffffff/revoke', { confirm: 'x' });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'UNKNOWN_TOKEN');
    const ack = await (await post('/api/alerts/ack', { id: 'disco:/', hours: 24 })).json();
    assert.deepEqual(ack, { ok: true, id: 'disco:/', until: '2026-10-14T02:51:08Z' });
  });
});

// DESIGN-QUALIDADE 4.6: /api/quality from quality-*.json, vazio 30 dias unavailable, the exports with the headers of 4.4.
test('quality: ranges, one day, one license, the unavailable answer and the exports', async () => {
  await withServer(async (base) => {
    const get = async (p, h = {}) => (await fetch(base + p, { headers: { ...KEY, ...h } })).json();
    assert.equal((await get('/api/quality?range=today')).range.kind, 'today');
    assert.equal((await get('/api/quality')).range.days, 7);
    assert.equal((await get('/api/quality?range=30d')).range.days, 30);
    const day = await get('/api/quality?range=day&day=2026-10-08');
    assert.deepEqual([day.range.kind, day.range.from, day.range.to], ['day', '2026-10-08', '2026-10-08']);
    const one = await get('/api/quality?range=7d&token=tok_0000000a1fa0');
    assert.equal(one.token, 'tok_0000000a1fa0');
    assert.deepEqual(one.byCustomer.map((c) => c.token), ['tok_0000000a1fa0']);
    assert.equal((await get('/api/quality?range=30d', { 'X-Mock-Scenario': 'vazio' })).available, false);
    assert.equal((await get('/api/quality?range=7d', { 'X-Mock-Scenario': 'vazio' })).available, true);
    const csv = await fetch(`${base}/api/quality/export?range=today&table=erros&format=csv`, { headers: KEY });
    assert.equal(csv.status, 200);
    assert.equal(csv.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(csv.headers.get('content-disposition'), 'attachment; filename="ssam-qualidade-erros-2026-10-12-2026-10-12.csv"');
    assert.equal(csv.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
    const text = bytes.toString('utf8');
    assert.ok(text.startsWith('﻿Código;Ocorrências;% das falhas;Ferramentas;Clientes;Última vez\r\n'), JSON.stringify(text.slice(0, 80)));
    const all = await fetch(`${base}/api/quality/export?range=7d&table=tudo`, { headers: KEY });
    assert.equal(all.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal((await all.json()).range.days, 7);
    const lines = await fetch(`${base}/api/quality/export?range=30d&table=linhas`, { headers: KEY });
    assert.equal(lines.status, 400);
    assert.equal((await lines.json()).error.field, 'range');
    const bad = await fetch(`${base}/api/quality/export?range=7d&table=nada`, { headers: KEY });
    assert.equal(bad.status, 400);
    await bad.text();
    const noKey = await fetch(`${base}/api/quality`);
    assert.equal(noKey.status, 401);
    await noKey.text();
  });
});
