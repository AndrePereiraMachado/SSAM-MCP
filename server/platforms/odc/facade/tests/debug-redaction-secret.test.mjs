import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareRedactionSecret, releaseRedactionSecret, secretVariants, scanReceipts } from '../debug-redaction-secret.mjs';

// Synthetic values only; no dialog, DPAPI, Studio, tenant or network is used here.
const sessionId = '0123456789abcdef0123456789abcdef';
const input = { lane: 'o11', runtimeUrl: 'https://fixture.dev/Fixture/', module: 'Fixture', moduleKey: 'A'.repeat(22), revision: 7, roles: ['WsSecurityPassword', 'FormClientSecret'] };
const binding = { lane: 'o11', runtimeUrl: 'https://fixture.dev/Fixture/', app: 'Fixture', sessionId, module: 'Fixture', moduleKey: 'A'.repeat(22), revision: 7,
  use: 'redact-only', roles: ['WsSecurityPassword', 'FormClientSecret'] };
const secret = `syn&th<et>ic"se'cret p+w/é`;

test('secretVariants has a stable one-argument signature and covers raw, JSON, XML, URI, form and base64 forms', () => {
  assert.equal(secretVariants.length, 1);
  const variants = secretVariants(secret);
  const expected = [
    secret,
    JSON.stringify(secret).slice(1, -1),
    'syn\\u0026th\\u003cet\\u003eic\\"se\\u0027cret p\\u002bw/\\u00e9',                  // JavaScriptSerializer / ConvertTo-Json style
    'syn\\u0026th\\u003Cet\\u003Eic\\"se\\u0027cret p\\u002Bw/\\u00E9',                  // System.Text.Json style
    'syn&amp;th&lt;et&gt;ic&quot;se&apos;cret p+w/é',
    'syn&amp;th&lt;et&gt;ic"se\'cret p+w/é',
    encodeURIComponent(secret),
    encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()),
    new URLSearchParams([['k', secret]]).toString().slice(2),
    encodeURIComponent(secret).replace(/%20/g, '+'),
    Buffer.from(secret, 'utf8').toString('base64'),
    Buffer.from(secret, 'utf8').toString('base64url'),
  ];
  for (const value of expected) assert.ok(variants.includes(value), value);
  assert.ok(variants.some(v => v.includes('+') && !v.includes(' ') && v.startsWith('syn%26')), 'form encoding uses +');
  assert.equal(new Set(variants).size, variants.length); assert.ok(variants.every(v => typeof v === 'string' && v.length > 0));
});

test('secretVariants of a Basic pair adds base64(user:pass) and the Basic header; invalid input is refused', () => {
  const pair = { username: 'synthetic-user', password: 'synthetic pass' }, b64 = Buffer.from('synthetic-user:synthetic pass', 'utf8').toString('base64');
  const variants = secretVariants(pair);
  for (const value of ['synthetic-user', 'synthetic pass', 'synthetic+pass', b64, 'Basic ' + b64]) assert.ok(variants.includes(value), value);
  assert.deepEqual(secretVariants([secret, pair]).sort(), [...new Set([...secretVariants(secret), ...variants])].sort());
  for (const bad of ['', null, undefined, 5, {}, { username: '', password: 'x' }, { username: 'x' }, [], ['ok', ''], 'x'.repeat(65537)])
    assert.throws(() => secretVariants(bad), /debug_redaction_secret_invalid/);
});

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-redaction-scan-'));

test('scanReceipts returns only {redactionSecretAbsent} and detects every variant without printing the match', async () => {
  const dir = tempDir();
  try {
    const clean = path.join(dir, 'clean.json'); fs.writeFileSync(clean, JSON.stringify({ ok: true, note: 'synthetic receipt with no private value' }));
    assert.deepEqual(await scanReceipts([clean], secret), { redactionSecretAbsent: true });
    const variants = [secret, JSON.stringify(secret).slice(1, -1), 'syn&amp;th&lt;et&gt;ic&quot;se&apos;cret p+w/é', encodeURIComponent(secret),
      new URLSearchParams([['k', secret]]).toString().slice(2), Buffer.from(secret, 'utf8').toString('base64')];
    for (const [i, variant] of variants.entries()) {
      const leak = path.join(dir, `leak-${i}.json`); fs.writeFileSync(leak, '{"frame":"prefix ' + variant + ' suffix"}');
      const result = await scanReceipts([clean, leak], secret);
      assert.deepEqual(result, { redactionSecretAbsent: false }, variant); assert.ok(!JSON.stringify(result).includes(variant));
      fs.rmSync(leak);
    }
    const wide = path.join(dir, 'wide.txt'); fs.writeFileSync(wide, Buffer.from('log ' + secret, 'utf16le'));
    assert.deepEqual(await scanReceipts([wide], secret), { redactionSecretAbsent: false }); fs.rmSync(wide);
    // Directories are scanned recursively; a receipt that was never written cannot hold a value.
    const nested = path.join(dir, 'a', 'b'); fs.mkdirSync(nested, { recursive: true }); fs.writeFileSync(path.join(nested, 'trace.json'), '{"v":"x"}');
    assert.deepEqual(await scanReceipts([dir, path.join(dir, 'missing.json')], secret), { redactionSecretAbsent: true });
    fs.writeFileSync(path.join(nested, 'frames.json'), '{"v":"' + Buffer.from(secret, 'utf8').toString('base64') + '"}');
    assert.deepEqual(await scanReceipts(dir, secret), { redactionSecretAbsent: false });
    fs.rmSync(path.join(nested, 'frames.json'));
    // Opened record shapes: a Basic pair, redact-only secrets and endpoint headers.
    const pair = { username: 'synthetic-user', password: 'synthetic pass' }, b64 = Buffer.from('synthetic-user:synthetic pass', 'utf8').toString('base64');
    fs.writeFileSync(path.join(dir, 'auth.json'), '{"h":"Basic ' + b64 + '"}');
    assert.deepEqual(await scanReceipts([dir], { kind: 'endpoint-credential', scheme: 'basic', ...pair }), { redactionSecretAbsent: false });
    assert.deepEqual(await scanReceipts([dir], { secrets: [{ role: 'WsSecurityPassword', value: 'absent-synthetic' }] }), { redactionSecretAbsent: true });
    assert.deepEqual(await scanReceipts([dir], { headers: [{ name: 'X-Api-Key', value: b64 }] }), { redactionSecretAbsent: false });
    // Nothing to compare against cannot prove absence.
    for (const bad of [null, '', { secrets: [] }]) assert.deepEqual(await scanReceipts([clean], bad), { redactionSecretAbsent: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scanReceipts opens a redact-only descriptor privately and fails closed when the record cannot be opened', async () => {
  const dir = tempDir();
  try {
    const descriptor = { credentialRef: randomUUID(), binding, expiresAt: new Date(Date.now() + 60000).toISOString(), kind: 'endpoint-credential', use: 'redact-only' };
    const values = [{ role: 'WsSecurityPassword', value: 'synthetic-ws' }, { role: 'FormClientSecret', value: 'synthetic form' }];
    let opened;
    const vault = async (mode, request) => { assert.equal(mode, 'read'); assert.deepEqual(request.binding, binding);
      opened = { ok: true, kind: 'endpoint-credential', use: 'redact-only', binding, expiresAt: descriptor.expiresAt, secrets: structuredClone(values) }; return opened; };
    fs.writeFileSync(path.join(dir, 'r.json'), '{"body":"client_secret=synthetic+form"}');
    assert.deepEqual(await scanReceipts([dir], descriptor, { vault }), { redactionSecretAbsent: false });
    assert.ok(opened.secrets.every(s => s.value === ''), 'the opened record is zeroed');
    fs.writeFileSync(path.join(dir, 'r.json'), '{"body":"clean"}');
    assert.deepEqual(await scanReceipts([dir], descriptor, { vault }), { redactionSecretAbsent: true });
    assert.deepEqual(await scanReceipts([dir], descriptor, { vault: async () => { throw new Error('synthetic failure'); } }), { redactionSecretAbsent: false });
    assert.deepEqual(await scanReceipts([dir], { ...descriptor, expiresAt: new Date(Date.now() - 1000).toISOString() }, { vault }), { redactionSecretAbsent: false });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('prepareRedactionSecret sends only role names to the private dialog, binds the session and releases the exact reference', async () => {
  const calls = [];
  const vault = async (mode, request) => { calls.push([mode, JSON.stringify(request)]);
    return mode === 'prompt-endpoint' ? { ok: true, kind: 'endpoint-credential', credentialRef: request.credentialRef, binding: request.binding,
      expiresAt: new Date(Date.now() + 600000).toISOString() } : { ok: true, forgotten: true }; };
  let armed;
  const prepared = await prepareRedactionSecret({ ...input, seconds: 600 }, { vault, expire: async value => { armed = value; }, sessionId });
  assert.equal(prepared.ok, true); assert.equal(prepared.credentialSource, 'private-dialog');
  assert.deepEqual(prepared.descriptor.binding, binding); assert.equal(prepared.descriptor.kind, 'endpoint-credential'); assert.equal(prepared.descriptor.use, 'redact-only');
  assert.equal(prepared.descriptor.authenticated, false); assert.deepEqual(armed, prepared.descriptor);
  assert.deepEqual(calls.map(([mode]) => mode), ['prompt-endpoint']);
  assert.deepEqual(Object.keys(JSON.parse(calls[0][1])).sort(), ['binding', 'credentialRef', 'ttlSeconds']);
  assert.deepEqual(await releaseRedactionSecret(prepared.descriptor, { vault }), { ok: true, forgotten: true });
  const forget = JSON.parse(calls.at(-1)[1]); assert.equal(calls.at(-1)[0], 'forget');
  assert.deepEqual(Object.keys(forget).sort(), ['binding', 'credentialRef', 'expiresAt']); assert.deepEqual(forget.binding, binding);
  assert.deepEqual(await releaseRedactionSecret(null), { ok: true });
  for (const patch of [{ values: { WsSecurityPassword: 'synthetic' } }, { secrets: ['synthetic'] }, { password: 'synthetic' }, { roles: [] }, { roles: ['bad role'] },
    { serviceKey: 'B'.repeat(22) }, { revision: 0 }])
    await assert.rejects(prepareRedactionSecret({ ...input, ...patch }, { vault, expire: async () => {}, sessionId }), /debug_app_user_redaction_secret_invalid_target/);
  assert.equal(calls.filter(([mode]) => mode === 'prompt-endpoint').length, 1);
  const cancelled = await prepareRedactionSecret(input, { sessionId, expire: async () => assert.fail('cancelled prompt arms no expiry'),
    vault: async (mode, request) => { calls.push([mode, request]); return mode === 'prompt-endpoint' ? { ok: false, cancelled: true } : { ok: true }; } });
  assert.deepEqual(cancelled, { ok: false, state: 'cancelled', error: 'debug_app_user_cancelled' }); assert.equal(calls.at(-1)[0], 'forget');
  await assert.rejects(prepareRedactionSecret(input, { sessionId, expire: async () => {}, vault: async (mode, request) => { calls.push([mode, request]);
    return mode === 'prompt-endpoint' ? { ok: true, kind: 'endpoint-credential', credentialRef: request.credentialRef, binding: { ...request.binding, revision: 8 },
      expiresAt: new Date(Date.now() + 60000).toISOString() } : { ok: true }; } }), /debug_app_user_scope_mismatch/);
  assert.equal(calls.at(-1)[0], 'forget');
});
