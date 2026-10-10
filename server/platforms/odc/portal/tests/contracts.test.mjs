import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../runtime/catalog.mjs';
import { OdcBridge } from '../runtime/bridge.mjs';
import { prepareRequest } from '../runtime/request.mjs';
import { readable } from '../runtime/effects.mjs';
import { sampleRequest, mockFetch, testConfig } from './helpers.mjs';

const catalog = new Catalog();

test('all 163 pinned operations resolve definitions and execute through mock HTTP', async () => {
  assert.equal(catalog.apis.size, 14);
  assert.equal(catalog.operations.size, 163);
  const mock = mockFetch();
  let now = 1_000_000;
  const bridge = new OdcBridge({ catalog, fetchImpl: mock.fetchImpl, now: () => now, config: testConfig({
    allowedWriteOperations: new Set([...catalog.operations.values()].filter(o => !o.readOnly).map(o => o.id)),
  }) });
  const failures = [];
  for (const operation of catalog.operations.values()) {
    now += 7_000; // Simulated clock, no sleeps; respect the 10/min environment-domain budget.
    assert.equal(catalog.describe(operation.id).id, operation.id);
    const api = catalog.apis.get(operation.apiId);
    const input = sampleRequest(api, operation);
    // The six read-only POST searches travel as reads (effects.mjs); every other non-GET as an allowlisted write.
    const output = await bridge.execute(operation.id, input, readable(operation) ? 'read' : 'write');
    if (!output.ok) failures.push({ id: operation.id, error: output.error });
  }
  assert.deepEqual(failures, []);
  assert.equal(mock.calls.filter(c => new URL(c.url).pathname.startsWith('/api/')).length, 163);
  assert.equal(mock.tokenCount, 1);
  assert.ok(mock.calls.every(c => c.redirect === 'manual'));
});

test('all published request schemas compile, including nullable allOf refs', () => {
  let count = 0;
  for (const api of catalog.apis.values()) for (const op of api.operations) {
    for (const schema of [...op.parameters.map(p => p.schema), ...Object.values(op.requestBody?.content ?? {}).map(m => m.schema)].filter(Boolean)) {
      count++;
      try { catalog.validate(api, schema, null, 'compile-test'); }
      catch (e) { assert.equal(e.code, 'INPUT_INVALID', `${op.id}: ${e.code}`); }
    }
  }
  assert.equal(count, 566);
});

test('parameters preserve JSON types, enforce required/bounds/enum and serialize arrays', () => {
  const id = 'asset-repository-api-v1:get:/assets';
  const request = prepareRequest(catalog, id, { query: { assetTypes: ['WebApplication', 'LowCodeLibrary'], limit: 10, offset: 0, isExternal: false } }, testConfig());
  assert.deepEqual(request.url.searchParams.getAll('assetTypes'), ['WebApplication', 'LowCodeLibrary']);
  assert.equal(request.url.searchParams.get('isExternal'), 'false');
  assert.throws(() => prepareRequest(catalog, id, { query: { limit: '10' } }, testConfig()), { code: 'INPUT_INVALID' });
  assert.throws(() => prepareRequest(catalog, id, { query: { limit: 1001 } }, testConfig()), { code: 'INPUT_INVALID' });
  const withPath = 'asset-repository-api-v1:get:/assets/{assetKey}';
  assert.throws(() => prepareRequest(catalog, withPath, {}, testConfig()), { code: 'INPUT_INVALID' });
});

test('JSON, wildcard JSON, octet-stream and multipart request bodies are supported', async () => {
  const id = 'asset-repository-api-v1:post:/assets';
  const api = catalog.apis.get('asset-repository-api-v1');
  const op = catalog.get(id).operation;
  const sample = sampleRequest(api, op);
  assert.equal(prepareRequest(catalog, id, sample, testConfig()).headers['content-type'], 'application/json');
  const binary = prepareRequest(catalog, id, { contentType: 'application/octet-stream', body: { $base64: 'aGVsbG8=' } }, testConfig());
  assert.equal(binary.body.toString(), 'hello');
  const multipart = prepareRequest(catalog, id, { contentType: 'multipart/form-data', body: {
    creationRequest: sample.body, assetFile: { $base64: 'aGVsbG8=', filename: 'example.oml' },
  } }, testConfig());
  const parsed = await new Response(multipart.body).formData();
  assert.equal(await parsed.get('assetFile').text(), 'hello');
  assert.deepEqual(JSON.parse(await parsed.get('creationRequest').text()), sample.body);
  const wildcard = [...catalog.operations.values()].find(o => o.requestBody?.content?.['application/*+json']);
  const wildcardSample = sampleRequest(catalog.apis.get(wildcard.apiId), wildcard);
  assert.equal(prepareRequest(catalog, wildcard.id, { ...wildcardSample, contentType: 'application/vnd.example+json' }, testConfig()).headers['content-type'], 'application/vnd.example+json');
});

test('invalid body and external URLs/headers/paths are rejected before network access', () => {
  const id = 'asset-repository-api-v1:get:/assets/{assetKey}';
  for (const value of ['..', '.', '../other', '%2f', '%252e', 'a\\b', 'https://evil.test', 'a?x', 'a#x']) {
    assert.throws(() => prepareRequest(catalog, id, { path: { assetKey: value } }, testConfig()), { code: 'INPUT_INVALID' });
  }
  for (const input of [{ url: 'https://evil.test' }, { headers: { authorization: 'supplied-token' } }, { query: { unexpected: 'x' } }]) {
    assert.throws(() => prepareRequest(catalog, 'asset-repository-api-v1:get:/assets', input, testConfig()), { code: 'INPUT_INVALID' });
  }
  assert.throws(() => prepareRequest(catalog, 'asset-repository-api-v1:post:/assets', {
    contentType: 'application/octet-stream', body: { $base64: 'not base64' },
  }, testConfig()), { code: 'INPUT_INVALID' });
});
