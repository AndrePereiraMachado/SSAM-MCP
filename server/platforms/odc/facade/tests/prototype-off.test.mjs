// The prototype import is turned off (prototype-disabled.mjs; kernel PrototypeImport.cs; owner decision of 2026-10-22). A job,
// or the code of a job, with the op prototype is refused with ONE refusal, PROTOTYPE_IMPORT_DISABLED, before any capture,
// build, kernel or Studio work, on both lanes; its continuation is the html op (ssam_code part html). No surface a model
// reads offers the op any more: the listing of the ssam server, the delivery descriptions, the guides, the api op list.
// The lane hooks (ssam_job, studio_deliver, o11_deliver, the CLI verb) are tested in prototype-op.test.mjs.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { prototypeImportRefusal, prototypeImportRefusalOfFile, prototypeOpSites, PROTOTYPE_IMPORT_DISABLED, PROTOTYPE_DISABLED_MESSAGE, PROTOTYPE_DISABLED_FIX } from '../prototype-disabled.mjs';
import { codeFromText } from '../refusal-codes.mjs';
import { codeCheck } from '../code-check.mjs';
import { createSsamServer } from '../ssam.mjs';
import { API_OPS } from '../ssam-reference.mjs';
import { TOOL_LISTING } from '../tool-listing.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..', '..');
const opPrototype = /"op"\s*:\s*"prototype"|op:\\?"prototype/;
const job = (...ops) => ({ ops });
const proto = (extra = {}) => ({ op: 'prototype', data: { source: 'C:/protos/shop', ...extra } });
function tmp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-off-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('the refusal: one code, the turned-off text, one problem per op with its pointer, and the html op as the next call', () => {
  assert.equal(prototypeImportRefusal(job({ op: 'html', data: { html: '<screen name="A"/>' } }), { lane: 'o11' }), null, 'a job without the op passes');
  const refused = prototypeImportRefusal(job({ op: 'spec', data: {} }, proto(), proto({ bind: { producer: 'Core' } })), { lane: 'odc', module: 'Shop' });
  assert.equal(refused.ok, false); assert.equal(refused.code, PROTOTYPE_IMPORT_DISABLED);
  assert.equal(refused.error, PROTOTYPE_DISABLED_MESSAGE + ' ' + PROTOTYPE_DISABLED_FIX);
  assert.match(refused.error, /^The prototype import is turned off: the op prototype is no longer supported, and nothing ran/);
  assert.deepEqual(refused.problems.map(p => [p.op, p.pointer, p.code, p.severity]), [[1, '/ops/1', PROTOTYPE_IMPORT_DISABLED, 'error'], [2, '/ops/2', PROTOTYPE_IMPORT_DISABLED, 'error']]);
  assert.deepEqual(refused.continuation.arguments, { lane: 'odc', action: 'grammar', part: 'html' }); assert.equal(refused.continuation.tool, 'ssam_code');
  assert.deepEqual(refused.nextCalls.map(c => c.tool), ['ssam_code', 'ssam_map', 'ssam_discover']);
  assert.equal(refused.nextCalls[0].arguments.module, 'Shop'); assert.equal(refused.nextCalls[1].arguments.view, 'html');
  assert.doesNotMatch(JSON.stringify(refused), opPrototype, 'the refusal never offers the op again');
  // an array job, and a relayed text keeps the code
  assert.deepEqual(prototypeOpSites([proto()]), [{ op: 0, pointer: '/0' }]);
  assert.equal(codeFromText('ok:false The prototype import is turned off: whatever'), PROTOTYPE_IMPORT_DISABLED);
  assert.equal(codeFromText('PROTOTYPE_IMPORT_DISABLED'), PROTOTYPE_IMPORT_DISABLED);
});

test('a composite job is judged in its parts, inline or in a file beside it', t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'screens.json'), JSON.stringify(job(proto())));
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(job({ op: 'spec', data: {} })));
  const file = path.join(dir, 'all.json');
  fs.writeFileSync(file, JSON.stringify({ jobs: ['data.json', 'screens.json', job(proto())] }));
  const refused = prototypeImportRefusalOfFile(file, { lane: 'o11' });
  assert.deepEqual(refused.problems.map(p => p.pointer), ['/jobs/1/ops/0', '/jobs/2/ops/0']);
  fs.writeFileSync(file, JSON.stringify({ jobs: ['data.json'] }));
  assert.equal(prototypeImportRefusalOfFile(file, { lane: 'o11' }), null);
});

test('ssam_code check refuses the op with the same refusal before any capture or kernel check', async t => {
  const dir = tmp(t);
  const runJob = async () => { throw new Error('the kernel check must not run'); };
  const value = await codeCheck({ lane: 'o11', module: 'Shop', ops: [proto()] }, { root: dir, local: dir, runJob });
  assert.equal(value.ok, false); assert.equal(value.code, PROTOTYPE_IMPORT_DISABLED, JSON.stringify(value).slice(0, 400));
  assert.equal(value.continuation.tool, 'ssam_code'); assert.equal(value.continuation.arguments.part, 'html');
});

async function ssamClient(t, deps = {}) {
  const saved = process.env.SSAM_APP_HOOK_TOOLS; process.env.SSAM_APP_HOOK_TOOLS = '0';
  let server; try { server = await createSsamServer({ profile: 'app', deps }); } finally { if (saved === undefined) delete process.env.SSAM_APP_HOOK_TOOLS; else process.env.SSAM_APP_HOOK_TOOLS = saved; }
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'prototype-off-test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('studio_deliver of the ssam server refuses an inline prototype job with the refusal, never a schema or feature error', async t => {
  const client = await ssamClient(t);
  const response = await client.callTool({ name: 'studio_deliver', arguments: { module: 'Shop', job: job(proto()), publish: true, authorize: 'yes, publish it' } });
  const value = response.structuredContent ?? JSON.parse(response.content[0].text);
  assert.equal(value.ok, false); assert.equal(value.code, PROTOTYPE_IMPORT_DISABLED, JSON.stringify(value).slice(0, 400));
  assert.equal(value.continuation?.tool, 'ssam_code'); assert.equal(value.continuation.arguments.lane, 'odc');
});

test('the tool listing of the ssam server offers no op prototype, short or full, and shrinks the delivery tools', async t => {
  for (const deps of [{}, { listing: 'full' }]) {
    const tools = (await (await ssamClient(t, deps)).listTools()).tools;
    assert.doesNotMatch(JSON.stringify(tools), opPrototype, deps.listing ?? 'short');
    for (const name of ['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job', 'ssam_code']) {
      const tool = tools.find(x => x.name === name);
      if (tool) assert.doesNotMatch(tool.description, /prototype/i, `${deps.listing ?? 'short'} ${name}`);
    }
  }
  for (const name of ['o11_deliver', 'studio_deliver']) assert.doesNotMatch(TOOL_LISTING[name].description, /prototype/i, name);
  assert.ok(!API_OPS.includes('prototype'), 'api --op lists no prototype op');
});

test('the guides of both lanes send a prototype to the html op and never write the op prototype', () => {
  for (const lane of ['o11', 'odc']) {
    const text = fs.readFileSync(path.join(repo, 'platforms', 'odc', 'facade', 'guides', lane + '.md'), 'utf8');
    assert.doesNotMatch(text, /op:\s*"prototype"/, lane);
    assert.match(text, /PROTOTYPE_IMPORT_DISABLED/, lane);
    assert.ok(text.includes(`ssam_code {lane:"${lane}", action:"grammar", part:"html"}`), lane);
  }
});
