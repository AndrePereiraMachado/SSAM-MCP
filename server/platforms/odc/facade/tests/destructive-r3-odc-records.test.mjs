import './fixtures/isolated-profile.mjs';
// CX15 r3, F3 in the odc_* guard (CT-4 and the ODC part of N2/CT-5): one try from the lease on, like the Service Center
// engine. A local failure before 'sending' closes the record refused with notSent (the token stays usable: the owner's new
// reply deletes) and releases the lease; after 'sending' the record closes uncertain. The answer carries the operationId,
// the items by state and ssam_task; an end that could not be written is written at the next call of the token. An
// operation whose process died (a child that is gone) answers OPERATION_INTERRUPTED with the operation by state, the new
// preview of what is left and ssam_task as the continuation: never the same token again, never CONFIRMATION_ALREADY_USED.
// The failure is the Windows EPERM of a rename over a read-only record (chmod 0o444), as in the review's probe D.
// The real OdcAccess over a fake ODC Studio bridge, through the MCP SDK. Synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { r3OdcWorld, HOST, LIB } from './fixtures/r3-odc-world.mjs';
import { leaseFile, operationFile, readOperation } from '../destructive-operations.mjs';

const deletes = w => w.writes.filter(x => x.method === 'DELETE').length;
const execute = (w, preview, authorize) => w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize });

test('CT-4: EPERM on the record after the DELETE went out: the answer names the operation, the items and ssam_task, the lease is released; once the disk lets it, the record ends uncertain and nothing is resent', async () => {
  const w = await r3OdcWorld();
  let file;
  try {
    const preview = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB });
    w.wait();
    file = operationFile(preview.operationId, { root: w.root });
    w.hooks.beforeWrite = async request => { if (request.method === 'DELETE') fs.chmodSync(file, 0o444); };
    const answer = await execute(w, preview, 'pode apagar o 1, ZZScratchLib');
    assert.equal(deletes(w), 1, 'the DELETE went out');
    assert.equal(answer.ok, false);
    assert.equal(answer.operationId, preview.operationId, JSON.stringify(answer).slice(0, 500));
    assert.equal(answer.code, 'ODC_LOCAL_FAILURE');
    assert.equal(answer.cause, 'EPERM');
    assert.equal(answer.outcome, 'uncertain');
    assert.equal(answer.continuation.tool, 'ssam_task');
    assert.deepEqual(answer.continuation.arguments, { id: preview.operationId });
    assert.equal(answer.operation.operationId, preview.operationId);
    assert.ok([...(answer.deleted ?? []), ...(answer.uncertain ?? [])].includes('ZZScratchLib'), 'the item by state');
    assert.ok(!fs.existsSync(leaseFile(preview.operationId, { root: w.root })), 'the lease was released');
    fs.chmodSync(file, 0o666);
    w.clock.t += 60 * 1000;
    const again = await execute(w, preview, 'confirmo de novo, o 1 ZZScratchLib');
    assert.notEqual(again.code, 'OPERATION_RUNNING', JSON.stringify(again).slice(0, 400));
    assert.equal(deletes(w), 1, 'nothing was resent');
    const record = readOperation(preview.operationId, { root: w.root });
    assert.notEqual(record.state, 'running');
    const task = await w.call('ssam_task', { id: preview.operationId });
    assert.notEqual(task.destructiveOperation.state, 'running');
  } finally { try { if (file) fs.chmodSync(file, 0o666); } catch {} await w.close(); }
});

test('CT-4/N2 (ODC): a local failure before \'sending\' sends nothing, releases the lease and leaves the token usable: the owner\'s new reply deletes', async () => {
  const w = await r3OdcWorld();
  let file; let fired = false;
  try {
    const preview = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB });
    w.wait();
    file = operationFile(preview.operationId, { root: w.root });
    // During the guard's read again (record running, item not-started), the record becomes unwritable: 'sending' fails.
    w.hooks.beforeGet = async route => {
      if (fired || !/\/consumers$/.test(route)) return;
      const record = readOperation(preview.operationId, { root: w.root });
      if (record?.state !== 'running' || record.items[0].state !== 'not-started') return;
      fired = true; fs.chmodSync(file, 0o444);
    };
    const answer = await execute(w, preview, 'pode apagar o 1, ZZScratchLib');
    assert.ok(fired);
    assert.equal(deletes(w), 0, 'nothing was sent');
    assert.equal(answer.code, 'ODC_LOCAL_FAILURE', JSON.stringify(answer).slice(0, 500));
    assert.equal(answer.outcome, 'not-sent');
    assert.equal(answer.operationId, preview.operationId);
    assert.deepEqual(answer.notStarted, ['ZZScratchLib']);
    assert.equal(answer.continuation.tool, 'ssam_task');
    assert.ok(!fs.existsSync(leaseFile(preview.operationId, { root: w.root })), 'the lease was released');
    fs.chmodSync(file, 0o666);
    w.hooks.beforeGet = null;
    w.clock.t += 60 * 1000;
    const done = await execute(w, preview, 'sim, agora pode apagar o 1 ZZScratchLib');
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 500));
    assert.equal(deletes(w), 1);
    assert.equal(readOperation(preview.operationId, { root: w.root }).state, 'completed');
  } finally { try { if (file) fs.chmodSync(file, 0o666); } catch {} await w.close(); }
});

test('CT-5 (ODC): after a dead process, the refusal names the operation by state and carries the new preview of what is left; the continuation is ssam_task, never the same token; the new preview deletes', async () => {
  const w = await r3OdcWorld();
  try {
    const preview = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB });
    w.wait();
    // The process that executed died while sending (a child that is gone): record running, item sending, its pid.
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    const file = operationFile(preview.operationId, { root: w.root });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date(w.clock.t).toISOString();
    fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-destructive-operation/1', operationId: preview.operationId, previewId: preview.previewId, tool: 'odc_asset_delete', lane: 'odc',
      host: HOST, operation: 'asset-repository-api-v1:delete:/assets/{assetKey}', pid: dead, startedAt: at, updatedAt: at, state: 'running', usedWords: [],
      items: [{ kind: 'asset', key: LIB, name: 'ZZScratchLib', state: 'sending', at }] }));
    const first = await execute(w, preview, 'sim, pode apagar o 1 ZZScratchLib');
    assert.equal(first.code, 'OPERATION_INTERRUPTED', JSON.stringify(first).slice(0, 500));
    assert.equal(deletes(w), 0);
    assert.equal(first.operation?.orphaned, true, 'the operation by state');
    assert.deepEqual(first.operation?.uncertain, ['ZZScratchLib']);
    assert.ok(first.preview?.confirmationToken, 'the new preview of what is left');
    assert.notEqual(first.preview.confirmationToken, preview.confirmationToken);
    assert.equal(first.continuation.tool, 'ssam_task');
    assert.ok(!JSON.stringify(first.continuation).includes(preview.confirmationToken), 'never the same token');
    assert.equal(first.nextPreview.arguments.confirmationToken, first.preview.confirmationToken);
    assert.ok(!first.problems.some(p => p.code === 'CONFIRMATION_ALREADY_USED'));
    // The same token again: the same answer, never CONFIRMATION_ALREADY_USED.
    const second = await execute(w, preview, 'sim, pode apagar o 1 ZZScratchLib');
    assert.equal(second.code, 'OPERATION_INTERRUPTED');
    assert.ok(!second.problems.some(p => p.code === 'CONFIRMATION_ALREADY_USED'));
    // The new preview, shown to the owner, confirmed with ITS token and the owner's new reply: it deletes.
    w.wait();
    const done = await w.call('odc_asset_delete', { ...first.nextPreview.arguments, authorize: 'confirmo, apaga o 1: ZZScratchLib' });
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 500));
    assert.equal(deletes(w), 1);
  } finally { await w.close(); }
});
