import './fixtures/isolated-profile.mjs';
import { planIndex } from './fixtures/plan-index.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workPacket, nextSection } from '../work-packet.mjs';
import { codePlan } from '../code-plan.mjs';

test('R2 divided work offers a plan without six new names', () => {
  for (const intent of ['create several server actions', 'change multiple screens', 'dividir entre subagentes', 'create 2 actions'])
    assert.equal(nextSection({ lane: 'o11', intent }).plan?.arguments.action, 'plan', intent);
  assert.equal(nextSection({ lane: 'odc', intent: 'build the module', parallel: true }).plan?.arguments.action, 'plan');
  assert.equal(nextSection({ lane: 'o11', intent: 'update LookupOrder and SaveOrder', module: { digest: { actions: [{ name: 'LookupOrder' }, { name: 'SaveOrder' }] } } }).plan?.arguments.action, 'plan');
  assert.equal(nextSection({ lane: 'o11', intent: 'read one action' }).plan, undefined);
});

test('R2 packets acknowledge a stable hash and invalidate changed content', () => {
  const input = { lane: 'o11', intent: 'read one action', matches: [], basis: { index: 'x' } };
  const first = workPacket(input);
  assert.match(first.packetRef, /^[a-f0-9]{64}$/);
  const again = workPacket({ ...input, packetRef: first.packetRef });
  assert.deepEqual(again, { ok: true, unchanged: true, packetRef: first.packetRef });
  assert.ok(Buffer.byteLength(JSON.stringify(again)) < 200);
  assert.notEqual(workPacket({ ...input, intent: 'read another action', packetRef: first.packetRef }).packetRef, first.packetRef);
});

test('R2 a worker prompt contains its grammar contract example and pitfalls in one read', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, 'base.oml'); fs.writeFileSync(base, 'capture');
  const result = await codePlan({ lane: 'o11', module: 'Inventory', items: [{ kind: 'action', name: 'Lookup', intent: 'Find a record', signature: 'server action Lookup' }] }, {
    briefingIndex: planIndex, root: dir, local: path.join(dir, 'local'), odcRoot: path.join(dir, 'odc'),
    newestCapture: () => ({ path: base, sha256: 'a'.repeat(64) }),
    moduleDigest: async () => ({ ok: true, digest: { module: { name: 'Inventory' }, actions: [], sections: [] } }),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const prompt = fs.readFileSync(result.batches[0].promptFile, 'utf8');
  assert.match(prompt, /## contract/);
  assert.match(prompt, /## pitfalls/);
  assert.match(prompt, /"example":/);
  assert.match(prompt, /"write":/);
  assert.doesNotMatch(prompt, /## grammar \(cut\)/);
});
