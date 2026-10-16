import './fixtures/isolated-profile.mjs';
// CX15 r3, CT-1 (subagent SC): the page deletes of the Service Center (solution-delete, db-connection-delete) honor the
// client's cancellation like every other destructive execution. The record opens at the start of the execution (ssam_task
// finds it 'running' during the read again); an abort during the read again (the GET of the target's page) sends NOTHING:
// the item is not-started, the record cancelled with cancelledAt, the answer CANCELLED with ssam_task; the token never
// sends again. Through MCP (McpServer + Client + InMemoryTransport: notifications/cancelled -> ctx.mcpReq.signal) and
// directly. The last look before the POST (runWrite beforeSend) sends nothing either. Offline: fake bridge, fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIRM_MIN_AGE_MS, readOperation } from '../destructive-operations.mjs';
import { HOST, PAGE_DELETES, mcp, pageWorld, settled, tick } from './fixtures/r3-sc-world.mjs';

const WORDS = { 'db-connection-delete': 'sim, apaga a 1 LegacyERP no test', 'solution-delete': 'sim, apaga a 1 Billing no test' };
const AGAIN = { 'db-connection-delete': 'pode apagar a 1, LegacyERP, no test', 'solution-delete': 'pode apagar a 1, Billing, no test' };
const THIRD = { 'db-connection-delete': 'confirmo: a 1, LegacyERP, no test', 'solution-delete': 'confirmo: a 1, Billing, no test' };

for (const action of Object.keys(PAGE_DELETES)) {
  const { target, edit, name } = PAGE_DELETES[action];

  test(`CT-1 (${action}, MCP): an abort during the GET of the read again sends no POST; ssam_task finds the record running, then cancelled`, async () => {
    const w = pageWorld();
    const server = await mcp(w);
    try {
      const preview = await server.call('o11_service_center_write', { action, host: HOST, ...target, confirmHost: HOST });
      assert.equal(preview.result?.state, 'previewed', JSON.stringify(preview).slice(0, 400));
      const { operationId, confirmationToken } = preview.result;
      w.clock.advance(CONFIRM_MIN_AGE_MS);
      const controller = new AbortController();
      let during = null; let aborted = false;
      w.onWeb = async (verb, options) => {
        if (aborted || verb !== 'fetch' || options.method !== 'GET' || options.path !== edit) return;
        aborted = true;
        during = await server.call('ssam_task', { id: operationId });
        controller.abort();
        await tick();
      };
      const answer = await server.call('o11_service_center_write', { action, host: HOST, ...target, confirmHost: HOST, confirmationToken, words: WORDS[action] },
        { signal: controller.signal }).catch(error => ({ aborted: true, error: String(error?.message ?? error) }));
      assert.ok(aborted, 'the read again reached the page of the target');
      const record = await settled(operationId, w.root);
      assert.deepEqual(w.posts(), [], 'no POST after the abort: ' + JSON.stringify(answer).slice(0, 300));
      assert.equal(during?.destructiveOperation?.state, 'running', 'ssam_task finds the record during the read again: ' + JSON.stringify(during).slice(0, 300));
      assert.deepEqual([record?.state, Boolean(record?.cancelledAt), record?.items.map(i => i.state)], ['cancelled', true, ['not-started']]);
      const after = await server.call('ssam_task', { id: operationId });
      assert.deepEqual([after.destructiveOperation?.state, after.destructiveOperation?.cancelled, after.destructiveOperation?.notStarted], ['cancelled', true, [name]]);
      const listed = await server.call('ssam_task', {});
      assert.ok(listed.destructive.some(o => o.operationId === operationId && o.state === 'cancelled'), JSON.stringify(listed.destructive).slice(0, 300));
    } finally { await server.close(); }
  });

  test(`CT-1 (${action}, direct): the answer of the abort is CANCELLED with ssam_task; the token never sends again; a new preview does`, async () => {
    const w = pageWorld();
    const preview = await w.run(action);
    assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 300));
    w.clock.advance(CONFIRM_MIN_AGE_MS);
    const controller = new AbortController();
    w.onWeb = async (verb, options) => { if (verb === 'fetch' && options.method === 'GET' && options.path === edit) controller.abort(); };
    const answer = await w.run(action, ['--confirmation-token', preview.confirmationToken, '--words', WORDS[action]], { signal: controller.signal });
    w.onWeb = null;
    assert.deepEqual([answer.ok, answer.code, answer.state, answer.operationId], [false, 'CANCELLED', 'cancelled', preview.operationId], JSON.stringify(answer).slice(0, 400));
    assert.deepEqual([answer.continuation?.tool, answer.continuation?.arguments?.id], ['ssam_task', preview.operationId]);
    assert.match(answer.error, /nothing was sent/);
    assert.deepEqual([answer.operation?.state, answer.operation?.notStarted], ['cancelled', [name]]);
    assert.deepEqual(w.posts(), []);
    const record = readOperation(preview.operationId, { root: w.root });
    assert.deepEqual([record.state, Boolean(record.cancelledAt), record.items[0].state], ['cancelled', true, 'not-started']);
    assert.equal(fs.existsSync(path.join(w.root, 'operations', preview.operationId + '.lock')), false, 'the lease is released');
    w.clock.advance(1000);
    const again = await w.run(action, ['--confirmation-token', preview.confirmationToken, '--words', AGAIN[action]]);
    assert.deepEqual([again.ok, again.problems?.map(p => p.code)], [false, ['OPERATION_CANCELLED']], JSON.stringify(again).slice(0, 300));
    assert.deepEqual(w.posts(), [], 'a cancelled token never sends again');
    const fresh = await w.run(action);
    w.clock.advance(CONFIRM_MIN_AGE_MS);
    const done = await w.run(action, ['--confirmation-token', fresh.confirmationToken, '--words', THIRD[action]]);
    assert.deepEqual([done.state, w.posts().length], ['confirmed', 1], JSON.stringify(done).slice(0, 300));
  });

  test(`CT-1 (${action}): a signal already aborted sends nothing and spends nothing (no record); the same token then confirms`, async () => {
    const w = pageWorld();
    const preview = await w.run(action);
    w.clock.advance(CONFIRM_MIN_AGE_MS);
    const answer = await w.run(action, ['--confirmation-token', preview.confirmationToken, '--words', WORDS[action]], { signal: AbortSignal.abort() });
    assert.deepEqual([answer.code, answer.state, w.posts().length], ['CANCELLED', 'cancelled', 0], JSON.stringify(answer).slice(0, 300));
    assert.equal(readOperation(preview.operationId, { root: w.root }), null, 'nothing started: no record');
    w.clock.advance(1000);
    const done = await w.run(action, ['--confirmation-token', preview.confirmationToken, '--words', AGAIN[action]]);
    assert.deepEqual([done.state, w.posts().length], ['confirmed', 1], JSON.stringify(done).slice(0, 300));
  });
}

test('CT-1 (the last look before the POST): webWrite with beforeSend that stops sends nothing; the reserved receipt closes refused, notSent, its lock released', async () => {
  const w = pageWorld();
  const { Client } = await import('../service-center/client.mjs');
  const { StudioWebTransport } = await import('../service-center/http.mjs');
  const { fakeVault } = await import('./fixtures/sc-fake-bridge.mjs');
  const client = new Client(fakeVault(HOST), new StudioWebTransport(HOST, w.bridge), w.dir);
  const operationId = '00000000-0000-4000-8000-0000000000aa';
  const receipt = await client.webWrite('db-connection-delete', { connection: 'LegacyERP' }, { execute: true, words: 'apaga LegacyERP', operationId, journal: w.journal,
    beforeSend: () => ({ cancelled: true, error: 'Cancelled by the client before the send; nothing was sent' }) });
  assert.deepEqual(w.posts(), [], 'nothing posted');
  assert.deepEqual([receipt.state, receipt.ok, receipt.notSent, receipt.cancelled], ['refused', false, true, true], JSON.stringify(receipt).slice(0, 300));
  const stored = w.journal.lookup(operationId);
  assert.deepEqual([stored.state, stored.notSent], ['refused', true]);
  const locks = fs.readdirSync(path.join(w.dir, 'receipts')).filter(n => n.endsWith('.lock'));
  assert.deepEqual(locks, [], 'the target lock is released');
});
