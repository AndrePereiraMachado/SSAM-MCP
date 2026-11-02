// fase4-28 r4-rest-hosted, review M1 and B1 (C:\t\r4\REVISAO-REST-HOSTED.md): through the REAL hosted server (createSsamServer
// hosted, an MCP client, a fake executor; no hub, agent or Studio):
//   - M1: ssam_discover asked about a generator by name, at the default budget, answers its `generators` block inline: the one
//     text of discover that teaches the hosted mode (rest-consume: "sample" inline in each GET, with a call that passes the
//     gate as it is). The block had moved to the stored answer once the hosted example grew;
//   - B1: ssam_reference check-job of a rest-consume without a sample answers the hosted rule (DOCUMENT_FETCH_HOSTED_REFUSED,
//     how to give the sample), never the kernel's local advice that the delivery tools GET the url.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { servedBytesStore } from '../served-bytes.mjs';
import { runWithExecutor, prepareWorkspace } from '../executor.mjs';
import { o11Lane } from '../workspace.mjs';
import { createSsamServer } from '../ssam.mjs';
import { restConsumeUnsampled } from '../hosted/policy.mjs';

class FakeExecutor {
  constructor() { this.id = 'fake'; this.hosted = true; }
  relayPort() { return 41997; } o11Connection() { return null; } async close() {}
  async call(kind) { if (kind === 'studio.processes') return { processes: [] }; throw Object.assign(new Error('unexpected ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); }
}
const agent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, credential: true, agentVersion: '0.3.1',
  kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' }, compatible: { odc: { ok: true }, o11: { ok: true } } }) };

async function session() {
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-discover-'));
  const tokenId = 'tok_' + randomUUID().slice(0, 12);
  const workspace = path.join(tmp, 'customers', tokenId);
  prepareWorkspace(workspace);
  const context = { id: randomUUID(), hosted: true, tokenId, customer: 'C', lanes: ['odc', 'o11'], workspace, agent, executor: new FakeExecutor(), o11: { lane: o11Lane.lane }, close: async () => {} };
  const store = servedBytesStore({ dir: fs.mkdtempSync(path.join(tmp, 'day-')) });
  const server = await runWithExecutor(context, () => createSsamServer({ hosted: { context, session: { agent, lanes: context.lanes }, exposure: { store } }, deps: {} }));
  const client = new Client({ name: 'gen-discover', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  return { call, close: async () => { await client.close(); await server.close(); fs.rmSync(tmp, { recursive: true, force: true }); } };
}

test('M1: hosted ssam_discover by name, default budget, answers the generators block inline for each generator and lane; rest-consume teaches the inline sample', { timeout: 600000 }, async () => {
  const s = await session();
  try {
    for (const lane of ['o11', 'odc']) {
      for (const [intent, id] of [['rest-consume', 'rest-consume'], ['entity-actions', 'entity-actions'], ['gen-screen', 'gen-screen']]) {
        const answer = await s.call('ssam_discover', { intent, lane });
        assert.ok(Array.isArray(answer.generators), lane + ' ' + intent + ': keys ' + Object.keys(answer).join(','));
        const block = answer.generators.find(g => g.id === id);
        assert.ok(block, lane + ' ' + intent + ': ' + JSON.stringify(answer.generators).slice(0, 300));
        assert.match(block.use, /this hosted server runs it called explicitly/, lane + ' ' + intent);
        if (id === 'rest-consume') {
          assert.match(block.use, /"sample"/, lane);
          assert.deepEqual(restConsumeUnsampled(block.call.arguments.ops), [], lane + ': the call passes the gate as it is');
        }
      }
    }
  } finally { await s.close(); }
});

test('B1: hosted ssam_reference check-job of a rest-consume without a sample answers DOCUMENT_FETCH_HOSTED_REFUSED, never the advice to GET the url', { timeout: 600000 }, async () => {
  const s = await session();
  try {
    const unsampled = { op: 'rest-consume', data: { name: 'Api', methods: [{ name: 'Items', url: 'https://api.example.com/items' }] } };
    for (const query of [{ ops: [unsampled] }, JSON.stringify({ ops: [unsampled] })]) {
      const answer = await s.call('ssam_reference', { lane: 'o11', kind: 'check-job', query });
      const text = JSON.stringify(answer);
      assert.equal(answer.code, 'DOCUMENT_FETCH_HOSTED_REFUSED', text.slice(0, 600));
      assert.equal(answer.cause, 'REST_CONSUME_SAMPLE_MISSING');
      assert.match(answer.fix, /"sample"/);
      assert.doesNotMatch(text, /GET the url|they sample the url/i, 'no local advice on a hosted server');
    }
    // A sampled one is checked by the kernel as before (no hosted refusal).
    const sampled = { ops: [{ op: 'rest-consume', data: { name: 'Api', methods: [{ name: 'Items', url: 'https://api.example.com/items', sample: [{ id: 1 }] }] } }] };
    const checked = await s.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: sampled });
    assert.notEqual(checked.code, 'DOCUMENT_FETCH_HOSTED_REFUSED', JSON.stringify(checked).slice(0, 400));
  } finally { await s.close(); }
});

test('B2: the hosted instructions follow each generator\'s mode when served: a generator switched off is said to be refused', async () => {
  const { hostedInstructions, HOSTED_INSTRUCTIONS } = await import('../ssam.mjs');
  const { withGeneratorStates } = await import('../generators.mjs');
  assert.ok(hostedInstructions({}).startsWith(HOSTED_INSTRUCTIONS), 'the shipped modes: the paragraph as exported');
  await withGeneratorStates({ 'rest-consume': { hosted: null } }, async () => {
    const text = hostedInstructions({});
    assert.match(text, /The generator ops entity-actions and screen with data\.generate are not offered by ssam_discover but run here when a job names their op\./);
    assert.match(text, /The generator op rest-consume is not offered here yet and refused \(GENERATOR_PENDING\)\./);
    assert.doesNotMatch(text, /"sample"/);
  });
  await withGeneratorStates({ 'rest-consume': { hosted: null }, 'entity-actions': { hosted: null }, 'gen-screen': { hosted: null } }, async () => {
    assert.match(hostedInstructions({}), /The generator ops not offered here yet \(entity-actions, rest-consume, screen with data\.generate\) are refused \(GENERATOR_PENDING\)\./);
  });
});

test('B3: the texts maintainers read say the generators run hosted in their mode (hosted/tools.json reasons, FASE2-AGENTE, SERVIDOR-FASE4)', () => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const repo = path.resolve(here, '..', '..', '..', '..');
  const tools = JSON.parse(fs.readFileSync(path.join(here, '..', 'hosted', 'tools.json'), 'utf8'));
  const entries = tools.tools ?? tools;
  for (const name of ['ssam_job', 'o11_job', 'o11_deliver', 'studio_deliver']) {
    const reason = JSON.stringify(entries[name] ?? Object.values(entries).find(e => e?.name === name) ?? null);
    assert.doesNotMatch(reason, /so is a generator op not offered here yet/, name);
    assert.match(reason, /runs called by name in its hosted mode/, name);
    assert.match(reason, /DOCUMENT_FETCH_HOSTED_REFUSED/, name);
  }
  assert.match(fs.readFileSync(path.join(repo, 'docs', 'FASE2-AGENTE.md'), 'utf8'), /r4-rest-hosted:\*\* no hospedado a amostra nunca é buscada/);
  assert.match(fs.readFileSync(path.join(repo, 'docs', 'SERVIDOR-FASE4.md'), 'utf8'), /nunca no hospedado: sem `sample`, `DOCUMENT_FETCH_HOSTED_REFUSED`/);
});

test('B4: the network watch of the "nothing fetched" tests sees node:https, DNS, fetch and the hosted public-only client, not only fetch', async () => {
  const { watchNetwork } = await import('./fixtures/no-network.mjs');
  const https = await import('node:https');
  const dns = await import('node:dns');
  const { createPublicFetch } = await import('../hosted/public-fetch.mjs');
  const watch = watchNetwork();
  try {
    assert.throws(() => https.request('https://example.com/x'));
    await new Promise(resolve => dns.lookup('example.com', () => resolve()));
    await assert.rejects(fetch('http://10.0.0.1/'));
    await assert.rejects(createPublicFetch()('https://example.com/a'));
  } finally { watch.restore(); }
  assert.deepEqual(watch.asked.map(a => a.split(' ')[0]), ['https.request', 'dns.lookup', 'fetch', 'https.request']);
});
