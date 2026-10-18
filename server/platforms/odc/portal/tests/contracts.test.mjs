import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../runtime/catalog.mjs';
import { OdcBridge } from '../runtime/bridge.mjs';
import { prepareRequest } from '../runtime/request.mjs';
import { readable } from '../runtime/effects.mjs';
import { sampleRequest, mockFetch, testConfig } from './helpers.mjs';

const catalog = new Catalog();

test('closed generated portfolio wrapper accepts declared fields without weakening referenced constraints', () => {
  const id='portfolio-api-v2:patch:/portfolios/{portfolioKey}';
  const {api,operation}=catalog.get(id);
  const schema=operation.requestBody.content['application/json'].schema;
  const original=JSON.stringify(schema);
  for(const body of [{name:'Portfolio'},{name:'x'.repeat(50)}]) {
    assert.doesNotThrow(()=>catalog.validate(api,schema,body,'body'));
  }
  for(const body of [{name:''},{name:'x'.repeat(51)},{name:123},{name:'Valid',extra:true},[]]) {
    assert.throws(()=>catalog.validate(api,schema,body,'body'),{code:'INPUT_INVALID'});
  }
  assert.equal(JSON.stringify(schema),original,'Pinned contract is never mutated');
  assert.throws(()=>catalog.validate(api,{type:'object',additionalProperties:false},{name:'x'},'body'),{code:'INPUT_INVALID'});
});

test('revision metadata transport preserves explicit null and empty text without claiming restoration', async () => {
  const operationId='asset-repository-api-v1:patch:/assets/{assetKey}/revisions/{revisionNumber}';
  const sent=[];
  const mock=mockFetch({apiHandler: request=>{sent.push(JSON.parse(request.body));return new Response(null,{status:204});}});
  const bridge=new OdcBridge({catalog,fetchImpl:mock.fetchImpl,config:testConfig({allowedWriteOperations:new Set([operationId])})});
  for(const body of [{tag:null,commitMessage:null},{tag:'',commitMessage:''}]) {
    const result=await bridge.execute(operationId,{path:{assetKey:'11111111-1111-4111-8111-111111111111',revisionNumber:1},body},'write');
    assert.equal(result.status,204);assert.deepEqual(sent.at(-1),body);
    assert.equal(result.restored,undefined);
  }
});

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

test('portfolio library multi-type filter reaches a server that accepts one CSV parameter', async () => {
  const id='portfolio-api-v2:get:/libraries';
  const rows=[{key:'extension',type:'ExtensionLibrary'},{key:'widget',type:'WidgetLibrary'}];
  const mock=mockFetch({apiHandler:request=>{
    const types=new URL(request.url).searchParams.get('type').split(',');
    return Response.json({results:rows.filter(row=>types.includes(row.type))});
  }});
  const bridge=new OdcBridge({catalog,fetchImpl:mock.fetchImpl,config:testConfig()});
  const result=await bridge.execute(id,{query:{type:['ExtensionLibrary','WidgetLibrary']}},'read');
  assert.equal(result.ok,true);
  assert.deepEqual(result.data.results,rows);
  const original=catalog.get(id).operation.parameters.find(p=>p.name==='type');
  assert.equal(original.explode,undefined,'Pinned catalog must remain unchanged');
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
