// Replay of a failed O11 publication from its receipt (ESpace.Dump, never reproduced live): the receipt of 19/10 (an
// o11_publish task, "failed at compile: Internal Error") is replayed against a simulated Studio that fails the same way and a
// Service Center that holds the error of 16:41:15; the answer quotes the ESpace.Dump lines, the elements cited before them
// and the leads, in one call. Offline only: no Studio, no Service Center, nothing published.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createO11Publish, compilerErrorRow, ESPACE_DUMP_LEADS } from '../o11-publish.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DUMP = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'publish-logs', 'espace-dump-2026-10-19.json'), 'utf8'));
// The task record of 19/10 as kept in kernel/.local/tasks (argument hash and process ids dropped).
const RECEIPT = { id: 'dda06de9-52c5-455a-b0c9-a7ee34187346', tool: 'o11_publish', state: 'failed',
  summary: { module: 'Demandas_TW', environment: DUMP.publishLog.environment, operationId: '3148a696-064c-4cad-a16f-cf23b0e2ac9c' },
  startedAt: '2026-10-19T16:41:07.507Z', endedAt: '2026-10-19T16:41:17.489Z',
  result: { ok: false, outcome: 'failed', code: 'PUBLISH_FAILED', error: 'The publication of Demandas_TW failed at compile: Internal Error; it is not published.' } };

// What a receipt names: the module, its environment, and the failure it recorded.
function receiptTarget(receipt) {
  if (receipt?.tool === 'o11_publish' || receipt?.summary?.module)
    return { id: receipt.id ?? null, module: receipt.summary?.module ?? null, environment: receipt.summary?.environment ?? null, code: receipt.result?.code ?? null, error: receipt.result?.error ?? null };
  if (receipt?.request?.Module) return { id: receipt.taskId ?? null, module: receipt.request.Module, environment: receipt.request.ExpectedEnvironment ?? null, code: receipt.code ?? null, error: null };
  return null;
}

test('the receipt of 19/10 replayed offline: one answer with the ESpace.Dump lines, the elements before it and the leads', async t => {
  const target = receiptTarget(RECEIPT);
  assert.deepEqual([target.module, target.code], ['Demandas_TW', 'PUBLISH_FAILED']);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-publish-replay-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const active = { name: target.module, key: DUMP.publishLog.moduleKey, kind: 'Web', environment: target.environment, isModified: false, pendingDialogs: [] };
  const fake = await fakeBridge(async request => ({
    open_module: { success: true, data: { name: target.module, opened: true, alreadyOpen: true, selected: true } },
    get_active_module: { success: true, data: active },
    get_errors: { success: true, data: { isValid: true, errors: 0, warnings: 0, messages: [], rawMessages: [] } },
    publish: { success: false, data: { publishLog: DUMP.publishLog }, error: 'publish: \'Demandas_TW\' completed with failure; an upload is not a successful publication. compile error: Internal Error' },
  })[request.method] ?? { success: false, error: 'Unknown method: ' + request.method });
  t.after(() => fake.close());
  const reads = [];
  const publish = createO11Publish({ root: base, env: { ANVIL_WORKER: '0', ANVIL_LANE: 'ss4', ANVIL_BRIDGE_PROBE_MS: '0' }, lane: 'ss4',
    bridge: o11Bridge({ port: fake.port, authorization: 'K' }), assertSelected: async () => {}, tasksDir: path.join(base, 'tasks'), journal: () => {},
    grants: { wordsFor: ({ authorize }) => ({ words: authorize, authorization: null }) },
    // The Service Center of that day, read for the receipt's window instead of the replay's clock.
    compilerErrorOf: async () => ({ ...compilerErrorRow({ rows: DUMP.serviceCenter.listing.rows }, { startedAt: RECEIPT.startedAt, endedAt: RECEIPT.endedAt }), detail: DUMP.serviceCenter.errorDetail.detail }) });
  const value = await publish({ module: target.module, authorize: 'sim, pode publicar o Demandas_TW' });
  assert.equal(value.code, target.code); assert.equal(value.error, target.error, 'the same sentence as the receipt');
  assert.equal(value.serverLog.espaceDump, true); assert.equal(value.serverLog.timeOfLog, '2026-10-19 16:41:15');
  assert.ok(value.serverLog.excerpt.some(l => /ESpace\.Dump\(\)/.test(l)));
  assert.deepEqual(value.diagnosis.leads, ESPACE_DUMP_LEADS);
  assert.equal(fake.seen.filter(r => r.method === 'publish').length, 1);
});

