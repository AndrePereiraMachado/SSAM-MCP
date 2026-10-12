import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireNativeRestEntry, publishedRestDescriptionUrl } from '../debug-native-endpoint-acquire.mjs';
import { restFixture } from './fixtures/debug-native-rest-fixture.mjs';
import { acquireNativeRestContract } from '../debug-native-endpoint.mjs';

test('published description discovery is inert, local, unambiguous and does not guess a URL', () => {
  const base = 'https://dev.example.test/App/rest/Api/';
  assert.equal(publishedRestDescriptionUrl('<script>window.o = {url:"swagger.json"}; throw new Error("must not execute")</script>', base), base + 'swagger.json');
  assert.throws(() => publishedRestDescriptionUrl('<a href="https://other.test/swagger.json">x</a>', base), /url_unresolved/);
  assert.throws(() => publishedRestDescriptionUrl('<a href="swagger.json">x</a><a href="openapi.json">x</a>', base), /url_unresolved/);
  assert.throws(() => publishedRestDescriptionUrl('<script src="swagger-ui.js"></script>', base), /url_unresolved/);
});

for (const uppercase of [false, true]) test(`REST acquisition binds native parent and captured bytes (uppercase hashes: ${uppercase})`, async t => {
  const f = restFixture(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-rest-acquire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'published.oml'); fs.writeFileSync(file, f.oml);
  if (uppercase) {
    f.binding.sourceSha256 = f.binding.sourceSha256.toUpperCase();
    f.model.sourceSha256 = f.model.sourceSha256.toUpperCase();
  }
  const visited = [];
  const options = { fetchImpl: async (url, init) => {
    visited.push(url); assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
    return url.endsWith('swagger.json') ? new Response(f.body, { headers: { 'content-type': 'application/json' } }) :
      new Response('<input value="swagger.json">', { headers: { 'content-type': 'text/html' } });
  } };
  const input = { binding: f.binding, entry: f.entry, sourceContract: { path: file, sha256: f.binding.sourceSha256 },
    readTree: async selector => { assert.equal(selector, 'RestService:Api'); return f.model; } };
  const acquired = await acquireNativeRestEntry(input, options);
  assert.equal(acquired.plan.entry.entryKey, f.entry.key); assert.equal(acquired.contract.source.sha256, f.contract.source.sha256);
  assert.deepEqual(visited, ['https://dev.example.test/App/rest/Api/', f.contract.source.url]);
  fs.writeFileSync(file, 'changed');
  await assert.rejects(acquireNativeRestEntry(input, options), /source_changed/);
  assert.equal(visited.length, 2);
});

for (const lane of ['o11', 'odc']) test(`InternalAccess=Yes (${lane}) is refused from the hash-bound model before the documentation GET`, async t => {
  const f = restFixture(lane), root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-rest-acquire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'published.oml'); fs.writeFileSync(file, f.oml);
  f.model.tree.properties.InternalAccess = 'Yes'; let fetches = 0;
  const input = { binding: f.binding, entry: f.entry, sourceContract: { path: file, sha256: f.binding.sourceSha256 }, readTree: async () => f.model };
  await assert.rejects(acquireNativeRestEntry(input, { fetchImpl: async () => { fetches++; return new Response('{}'); } }),
    /^Error: debug_native_endpoint_internal_access_only$/);
  assert.equal(fetches, 0);
});

for (const lane of ['o11', 'odc']) test(`acquireNativeRestContract refuses InternalAccess=Yes (${lane}) before the documentation GET`, async () => {
  const f = restFixture(lane); let fetches = 0;
  const input = () => ({ binding: f.binding, model: f.model, entryKey: f.entry.key, documentationUrl: f.contract.source.url });
  const fetchImpl = async () => { fetches++; return new Response(f.body, { headers: { 'content-type': 'application/json' } }); };
  f.model.tree.properties.InternalAccess = 'Yes';
  await assert.rejects(acquireNativeRestContract(input(), { fetchImpl }), /^Error: debug_native_endpoint_internal_access_only$/);
  assert.equal(fetches, 0);
  // Control: the same capture without InternalAccess reaches the one documentation GET.
  delete f.model.tree.properties.InternalAccess;
  await acquireNativeRestContract(input(), { fetchImpl }); assert.equal(fetches, 1);
});
