import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { CredentialRegistry } from '../runtime/credential-registry.mjs';
import * as registryModule from '../runtime/credential-registry.mjs';
import { redact, redactValues } from '../runtime/errors.mjs';

function workload(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./fixtures/redaction-performance-worker.mjs', import.meta.url), { workerData: data,
      ...(data.kind === 'nested' ? { resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } } : {}) });
    const hardLimit = data.kind === 'nested' ? 5000 : 100000;
    const timer = setTimeout(() => { worker.terminate(); reject(new assert.AssertionError({ message: 'Synthetic redaction workload exceeded its ' + hardLimit + '-millisecond hard limit' })); }, hardLimit);
    const finish = () => clearTimeout(timer);
    worker.once('message', message => { finish(); worker.terminate();
      if (message.failure) reject(new assert.AssertionError({ message: 'Synthetic workload failed: ' + message.failure }));
      else resolve(message.result);
    });
    worker.once('error', error => { finish(); reject(error); });
    worker.once('exit', code => { finish(); if (code !== 0) reject(new Error('Synthetic worker exited')); });
  });
}

for (const count of [0, 108, 1008, 4096]) test('C2: real 1000-span adapter remains responsive with N=' + count, async t => {
  const result = await workload({ kind: 'trace', count });
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.ok, true); assert.equal(result.spans, 1000);
  assert.ok(result.bodyBytes > 900000 && result.bodyBytes < 1048576);
  assert.equal(result.count, count);
  if (count === 4096) {
    assert.equal(result.matcherReadyBeforeRead, true, 'The cap read must start with an independently compiled matcher');
    assert.equal(typeof result.compileMs, 'number', 'The cap matcher compilation must be measured separately');
    assert.ok(result.compileMs >= 0);
    assert.equal(result.measurementMode, 'warm-read');
  } else assert.equal(result.measurementMode, 'cold-read');
  assert.ok(result.elapsedMs < 1000, 'Trace projection must finish within one second');
  assert.ok(result.maxGapMs < 1000, 'Trace projection must not pause the event loop for one second');
});

test('N1/C2: real 1000-span adapter remains responsive with 5000 live active values', async t => {
  const result = await workload({ kind: 'trace', count: 5000, active: true }); t.diagnostic(JSON.stringify(result));
  assert.equal(result.ok, true); assert.equal(result.spans, 1000); assert.equal(result.activeCount, 5000); assert.equal(result.count, 5000);
  assert.ok(result.elapsedMs < 1000); assert.ok(result.maxGapMs < 1000);
});

test('C2: 8MB redaction with 1000 values stays under two seconds per projection', async t => {
  const result = await workload({ kind: 'bulk' }); t.diagnostic(JSON.stringify(result));
  assert.equal(result.count, 1000); assert.equal(result.bytes, 8 * 1024 * 1024);
  for (const name of ['redactValues', 'redact']) {
    assert.equal(result[name].safe, true); assert.equal(result[name].masked, true);
    assert.ok(result[name].elapsedMs < 2000, name + ' must finish within two seconds');
  }
});

test('C2: 1000 login, OAuth, cookie and released-broker cycles have bounded retention', async t => {
  const result = await workload({ kind: 'growth' }); t.diagnostic(JSON.stringify(result));
  for (const name of ['loginSummary', 'cookieSummary', 'releaseSummary', 'oauthSummary'])
    assert.ok(result[name].retiredCount <= result.limit, name + ' must respect the retired retention ceiling');
  assert.equal(result.loginSummary.activeCount, 18);
  assert.equal(result.cookieSummary.activeCount, 19);
  assert.equal(result.releaseSummary.activeCount, 19);
  assert.ok(result.oauthSummary.activeCount - result.releaseSummary.activeCount <= 17, 'OAuth keeps at most its secret and 16 known tokens active');
  assert.ok(result.registrySize <= 146); assert.ok(result.cookieRegistrySize <= 129); assert.ok(result.oauthRegistrySize <= 145);
  assert.ok(Number.isInteger(result.liveBefore) && Number.isInteger(result.liveAfter), 'Live registry counts must be observable without credentials');
  assert.equal(result.liveAfter, result.liveBefore, 'Released brokers must leave the live process registry');
  assert.ok(result.oauthKnown <= 16);
});

test('C2: fixed redaction fixtures preserve longest-first raw/encoded and remote-key behavior', () => {
  const long = 'fixture-credential-long-0123456789/+=', short = 'fixture-credential-long-0123456789';
  const registry = new CredentialRegistry(); registry.add(short); registry.add(long);
  const input = { text: 'raw ' + long + ' encoded ' + encodeURIComponent(long) + ' small ' + short,
    nested: [{ description: 'Bearer abcdefghijklmnopqrstuvwxyz' }], link: 'https://docs.example.test/run?api_key=YOUR_KEY_HERE',
    bad: 'https://example.test:99999/x', plain: 'unchanged', number: 4, enabled: false };
  const expected = { text: 'raw [REDACTED] encoded [REDACTED] small [REDACTED]',
    nested: [{ description: 'Bearer [REDACTED]' }], link: 'https://docs.example.test/run?api_key=%5BREDACTED%5D',
    bad: '[INVALID URL]', plain: 'unchanged', number: 4, enabled: false };
  assert.deepEqual(redactValues(input, registry), expected);
  assert.deepEqual(redact({ ...input, password: 'remote-secret', isSecret: true, value: 'remote-value' }, registry),
    { ...expected, password: '[REDACTED]', isSecret: true, value: '[REDACTED]' });
});

test('C2/C3: untruncated typed text never loses a credential prefix at the edge', () => {
  const credential = '11111111-2222-3333-4444-555555555555-extra-private-value';
  const registry = new CredentialRegistry(); registry.add(credential);
  const typed = { id: credential.slice(0, 36), description: 'ordinary text ' + credential.slice(0, 12) };
  assert.equal(JSON.stringify(redactValues(typed, registry)) === JSON.stringify(typed), true,
    'Only explicitly truncated fields may lose a partial credential suffix');
});

test('C2: matcher cache observes new values and retained generations', () => {
  const registry = new CredentialRegistry();
  const first = 'cache-fixture-credential-one-0123456789', second = 'cache-fixture-credential-two-0123456789';
  assert.equal(redactValues(first, registry) === first, true);
  registry.add(first);
  assert.equal(redactValues(first, registry), '[REDACTED]');
  registry.reset(); registry.add(second);
  assert.equal(redactValues(first + ' ' + second, registry), '[REDACTED] [REDACTED]');
});

test('C2: overlapping registered values preserve the existing longest-first output', () => {
  const registry = new CredentialRegistry();
  registry.add('abcdefghijklmnop'); registry.add('hijklmnopqrstuvwxyz');
  assert.equal(redactValues('abcdefghijklmnopqrstuvwxyz', registry), 'abcdefg[REDACTED]');
  assert.equal(redact('abcdefghijklmnopqrstuvwxyz', registry), 'abcdefg[REDACTED]');
});

test('C2: FIFO retention evicts only retired credentials and rebuilds the process matcher', () => {
  const registry = new CredentialRegistry(), oldest = 'fifo-oldest-' + randomUUID();
  const newest = 'fifo-newest-' + randomUUID(), limit = registryModule.MAX_PROCESS_CREDENTIALS ?? 4096;
  registry.add(oldest); registry.reset();
  assert.equal(redactValues(oldest), '[REDACTED]');
  for (let i = 0; i < limit; i++) { registry.add('fifo-rotation-' + randomUUID()); registry.reset(); }
  registry.add(newest); registry.reset();
  const retained = registryModule.processCredentials();
  assert.ok(registryModule.processCredentialSummary().retiredCount <= limit);
  assert.equal(retained.includes(oldest), false, 'The oldest process value must leave the bounded retention window');
  assert.equal(retained.includes(newest), true, 'The latest value must survive retention');
  assert.equal(redactValues(oldest) === oldest, true, 'The cached matcher must stop matching evicted values');
  assert.equal(redactValues(newest), '[REDACTED]');
});

test('C2: disposing a registry invalidates its live registration while retaining recent masking', () => {
  const registry = new CredentialRegistry(), value = 'dispose-fixture-' + randomUUID();
  registry.add(value); assert.equal(redactValues(value), '[REDACTED]');
  assert.equal(typeof registry.dispose, 'function', 'Registries need an explicit disposal lifecycle');
  const before = registryModule.processCredentialSummary().registryCount;
  const version = registryModule.credentialStateVersion();
  registry.dispose();
  assert.equal(registryModule.processCredentialSummary().registryCount, before - 1);
  assert.ok(registryModule.credentialStateVersion() > version);
  assert.equal(redactValues(value), '[REDACTED]', 'Recently disposed credentials must protect resumed reads');
});

test('C2: deeply nested overlapping values avoid a match-output or memory explosion', async t => {
  for (const count of [100, 1000]) {
    const result = await workload({ kind: 'nested', count }); t.diagnostic(JSON.stringify(result));
    assert.equal(result.count, count); assert.equal(result.bytes, 1024 * 1024);
    assert.equal(result.exact, true, 'Nested overlaps must match the former longest-first split/join output');
    assert.ok(result.elapsedMs < 2000, 'Nested overlaps must finish within two seconds including matcher compilation');
    assert.ok(result.heapUsedBytes < 256 * 1024 * 1024, 'Nested overlaps must fit within the worker memory ceiling');
  }
});


test('C2: shared credentials remain active until their last live registry retires them', () => {
  assert.equal(typeof registryModule.processCredentialSummary, 'function');
  const before = registryModule.processCredentialSummary();
  const first = new CredentialRegistry(), second = new CredentialRegistry();
  const shared = 'shared-diagnostic-fixture-credential-0123456789';
  try {
    first.add(shared); second.add(shared);
    const added = registryModule.processCredentialSummary();
    assert.equal(registryModule.processCredentialSummary().activeCount, before.activeCount + 1);
    first.reset();
    assert.equal(registryModule.processCredentialSummary().activeCount, before.activeCount + 1);
    second.dispose();
    assert.equal(registryModule.processCredentialSummary().activeCount, before.activeCount);
    assert.equal(registryModule.processCredentialSummary().retiredCount, Math.min(4096, added.retiredCount + 1));
  } finally { first.dispose(); second.dispose(); }
});
