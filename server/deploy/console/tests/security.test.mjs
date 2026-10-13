// DESIGN 2.2 and 7.2 "security": Host, Origin, Sec-Fetch-Site, key, lockout, methods, bodies, confirmation, STALE,
// mutation rate, static confinement, /mock never served, response headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FAKE_MODULE, clock, makeEnv, request, startConsole } from './helpers.mjs';

const SECURITY = ['cache-control', 'pragma', 'x-content-type-options', 'referrer-policy', 'x-frame-options', 'cross-origin-opener-policy',
  'cross-origin-resource-policy', 'permissions-policy', 'content-security-policy'];
function assertHeaders(r) {
  for (const h of SECURITY) assert.ok(r.headers[h], `header ${h} missing`);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  for (const h of Object.keys(r.headers)) assert.ok(!h.startsWith('access-control-'), `CORS header ${h} present`);
}

test('security pipeline (2.2)', async t => {
  const env = makeEnv();
  const now = clock();
  const c = await startConsole(env, { now });
  t.after(() => c.close());
  const key = () => c.key;

  await t.test('Host header: evil.example refused, localhost on any port accepted', async () => {
    let r = await request(c.port, { path: '/api/meta', headers: { Host: 'evil.example:7320', 'X-SSAM-Console-Key': key() } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'HOST_REFUSED');
    assert.equal(r.body.error.message, 'Acesso recusado: o painel só atende pelo túnel em localhost.');
    assertHeaders(r);
    r = await request(c.port, { path: '/healthz', headers: { Host: 'evil.example' } });
    assert.equal(r.status, 403);
    r = await request(c.port, { path: '/healthz', headers: { Host: 'localhost.evil.example:7320' } });
    assert.equal(r.status, 403);
    for (const host of ['localhost:9999', '127.0.0.1:7320', '[::1]:7320', 'localhost', 'LOCALHOST:7320']) {
      r = await request(c.port, { path: '/api/meta', headers: { Host: host, 'X-SSAM-Console-Key': key() } });
      assert.equal(r.status, 200, host);
    }
  });

  await t.test('Origin must equal http:// + Host; Sec-Fetch-Site same-origin or none', async () => {
    const host = `localhost:${c.port}`;
    let r = await request(c.port, { path: '/api/meta', headers: { Host: host, Origin: 'http://evil.example', 'X-SSAM-Console-Key': key() } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'ORIGIN_REFUSED');
    r = await request(c.port, { path: '/api/meta', headers: { Host: host, Origin: 'http://localhost:1', 'X-SSAM-Console-Key': key() } });
    assert.equal(r.body.error.code, 'ORIGIN_REFUSED');
    r = await request(c.port, { path: '/api/meta', headers: { Host: host, Origin: 'null', 'X-SSAM-Console-Key': key() } });
    assert.equal(r.body.error.code, 'ORIGIN_REFUSED');
    r = await request(c.port, { path: '/api/meta', headers: { Host: host, Origin: `http://${host}`, 'X-SSAM-Console-Key': key() } });
    assert.equal(r.status, 200);
    for (const site of ['cross-site', 'same-site']) {
      r = await request(c.port, { path: '/api/meta', headers: { 'Sec-Fetch-Site': site, 'X-SSAM-Console-Key': key() } });
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'FETCH_SITE_REFUSED');
    }
    for (const site of ['same-origin', 'none']) {
      r = await request(c.port, { path: '/api/meta', headers: { 'Sec-Fetch-Site': site, 'X-SSAM-Console-Key': key() } });
      assert.equal(r.status, 200, site);
    }
  });

  await t.test('key required on /api/*, wrong key refused; /healthz and static files need none', async () => {
    let r = await request(c.port, { path: '/api/overview' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'KEY_REQUIRED');
    assert.equal(r.body.error.message, 'Falta a chave de acesso. Abra o painel pelo painel-ssam.ps1.');
    r = await request(c.port, { path: '/api/overview', headers: { 'X-SSAM-Console-Key': 'x'.repeat(43) } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'KEY_INVALID');
    r = await request(c.port, { path: '/healthz' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
    assertHeaders(r);
    r = await request(c.port, { path: '/api/nada', headers: { 'X-SSAM-Console-Key': key() } });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'NOT_FOUND');
    // DESIGN-QUALIDADE 4.4: the quality routes and their downloads follow the same rules and carry the same headers
    for (const p of ['/api/quality', '/api/quality?range=today', '/api/quality/export?range=7d&table=erros', '/api/quality/export?range=7d&table=linhas']) {
      r = await request(c.port, { path: p });
      assert.equal(r.status, 401, p);
      assert.equal(r.body.error.code, 'KEY_REQUIRED', p);
      r = await request(c.port, { path: p, headers: { 'X-SSAM-Console-Key': 'x'.repeat(43) } });
      assert.equal(r.status, 401, p);
      r = await request(c.port, { path: p, headers: { 'X-SSAM-Console-Key': key() } });
      assert.equal(r.status, 200, p);
      assertHeaders(r);
    }
    r = await request(c.port, { path: '/api/quality/export?range=7d&table=erros&format=csv', headers: { 'X-SSAM-Console-Key': key() } });
    assert.equal(r.headers['content-type'], 'text/csv; charset=utf-8');
    assert.match(r.headers['content-disposition'], /^attachment; filename="ssam-qualidade-erros-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"$/);
    r = await request(c.port, { path: '/api/quality/export?range=7d&table=..%2F..%2Fx', headers: { 'X-SSAM-Console-Key': key() } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.field, 'table');
    assertHeaders(r);
  });

  await t.test('OPTIONS and other methods get 405 with no CORS header', async () => {
    for (const method of ['OPTIONS', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      const r = await request(c.port, { method, path: '/api/licenses', headers: { Origin: `http://localhost:${c.port}`,
        'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-ssam-console-key,content-type' } });
      assert.equal(r.status, 405, method);
      if (method !== 'HEAD') assert.equal(r.body.error.code, 'METHOD_NOT_ALLOWED');
      assertHeaders(r);
    }
    const r = await c.api('GET', '/api/key/rotate');
    assert.equal(r.status, 405);
  });

  await t.test('POST bodies: content type, 8 KiB limit, JSON object, unknown fields', async () => {
    let r = await c.api('POST', '/api/key/rotate', { raw: '{}', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(r.status, 415);
    assert.equal(r.body.error.code, 'CONTENT_TYPE');
    const big = JSON.stringify({ customer: 'Cliente Alfa', days: 30, lanes: ['odc'], confirm: 'x'.repeat(9 * 1024) });
    r = await c.api('POST', '/api/licenses', { raw: big });
    assert.equal(r.status, 413);
    assert.equal(r.body.error.code, 'BODY_TOO_LARGE');
    r = await c.api('POST', '/api/licenses', { raw: big, headers: { 'Content-Length': undefined, 'Transfer-Encoding': 'chunked' } });
    assert.equal(r.status, 413);
    r = await c.api('POST', '/api/licenses', { raw: '{"customer":' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'BAD_JSON');
    r = await c.api('POST', '/api/licenses', { raw: '[1,2]' });
    assert.equal(r.body.error.code, 'BAD_JSON');
    r = await c.api('POST', '/api/licenses', { body: { customer: 'Cliente Alfa', days: 30, lanes: ['odc'], confirm: 'Cliente Alfa', extra: 1 } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_FIELD');
    assert.equal(r.body.error.field, 'extra');
    r = await c.api('POST', '/api/licenses', { body: { customer: 'Cliente Alfa', days: 0, lanes: ['odc'], confirm: 'Cliente Alfa' } });
    assert.equal(r.body.error.field, 'days');
    r = await c.api('POST', '/api/licenses', { body: { customer: 'Cliente Alfa', days: 30, lanes: ['odc', 'odc'], confirm: 'Cliente Alfa' } });
    assert.equal(r.body.error.field, 'lanes');
    r = await c.api('POST', '/api/licenses', { body: { customer: '<script>', days: 30, lanes: ['odc'], confirm: '<script>' } });
    assert.equal(r.body.error.field, 'customer');
    r = await c.api('POST', '/api/key/rotate', { body: { a: 1 } });
    assert.equal(r.body.error.code, 'INVALID_FIELD');
  });

  await t.test('confirmation must equal the customer name', async () => {
    const r = await c.api('POST', '/api/licenses', { body: { customer: 'Cliente Alfa', days: 30, lanes: ['odc'], confirm: 'cliente alfa' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'CONFIRM_MISMATCH');
    assert.equal(r.body.error.message, 'A confirmação não confere: digite exatamente o nome do cliente.');
  });

  await t.test('static files: whitelist, confinement, /mock never served, CSP on HTML', async () => {
    let r = await request(c.port, { path: '/' });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.match(r.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
    assertHeaders(r);
    for (const p of ['/index.html', '/app.css', '/js/main.js', '/favicon.svg']) assert.equal((await request(c.port, { path: p })).status, 200, p);
    for (const p of ['/../server.mjs', '/%2e%2e/server.mjs', '/..%2fserver.mjs', '/js/..%2f..%2fserver.mjs', '/js/%2e%2e/%2e%2e/app.mjs',
      '/mock/overview.json', '/MOCK/overview.json', '/mock/', '/notes.txt', '/server.mjs', '/..\\server.mjs', '/%00index.html', '/js/']) {
      r = await request(c.port, { path: p });
      assert.equal(r.status, 404, p);
      assertHeaders(r);
    }
  });

  await t.test('mutation rate: at most 10 per 60 s, Retry-After', async () => {
    let k = c.key;
    for (let i = 0; i < 10; i++) {
      const r = await c.api('POST', '/api/key/rotate', { body: {}, key: k });
      assert.equal(r.status, 200, `rotation ${i + 1}`);
      assert.match(r.body.key, /^[A-Za-z0-9_-]{43}$/);
      k = r.body.key;
    }
    const r = await c.api('POST', '/api/key/rotate', { body: {}, key: k });
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(r.headers['retry-after']) >= 1);
    assert.match(r.body.error.message, /^Muitas ações seguidas\. Tente de novo em \d+ s\.$/);
    now.advance(61000);
    const again = await c.api('POST', '/api/key/rotate', { body: {}, key: k });
    assert.equal(again.status, 200);
    c.key = again.body.key;
  });

  await t.test('10 wrong keys lock every request but /healthz for 60 s', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await request(c.port, { path: '/api/meta', headers: { 'X-SSAM-Console-Key': 'wrong' + i } });
      assert.equal(r.status, 401, `wrong key ${i + 1}`);
    }
    let r = await c.api('GET', '/api/meta');
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'RATE_LIMITED');
    r = await request(c.port, { path: '/' });
    assert.equal(r.status, 429);
    r = await request(c.port, { method: 'OPTIONS', path: '/api/meta' });
    assert.equal(r.status, 429);
    r = await request(c.port, { path: '/healthz' });
    assert.equal(r.status, 200);
    now.advance(61000);
    r = await c.api('GET', '/api/meta');
    assert.equal(r.status, 200);
  });
});

test('STALE: renew and lanes carry the state the owner saw (409)', async t => {
  const env = makeEnv({ tokenModule: FAKE_MODULE });
  const c = await startConsole(env);
  t.after(() => c.close());
  const issued = await c.api('POST', '/api/licenses', { body: { customer: 'Cliente Beta', days: 30, lanes: ['odc', 'o11'], confirm: 'Cliente Beta' } });
  assert.equal(issued.status, 201);
  const id = issued.body.license.id;
  let r = await c.api('POST', `/api/licenses/${id}/renew`, { body: { days: 30, confirm: 'Cliente Beta', expectExpiresAt: '2020-01-01T00:00:00.000Z' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'STALE');
  assert.equal(r.body.error.message, 'A licença mudou desde que a página foi carregada. Recarregue e confira.');
  r = await c.api('POST', `/api/licenses/${id}/lanes`, { body: { lanes: ['odc'], confirm: 'Cliente Beta', expectLanes: ['odc'] } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'STALE');
  r = await c.api('POST', `/api/licenses/${id}/renew`, { body: { days: 30, confirm: 'Cliente Beta', expectExpiresAt: issued.body.license.expiresAt } });
  assert.equal(r.status, 200);
});
