import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WriteJournal, fingerprint } from '../runtime/write-journal.mjs';

test('request fingerprints survive restart, reject changed requests and preserve target locks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-request-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = new WriteJournal(root), operationUuid = '7a1e2e2b-307c-4c9f-82da-c7fcde358462';
  const identity = { kind: 'odc-public', tenant: 'fixture.test', operationId: 'fixture.patch', target: { key: 'one' } };
  const requestSha256 = fingerprint({ path: '/one', body: { order: 101, label: 'Test' } });
  const receipt = journal.reserve({ operationUuid, identity, requestSha256, wordsSha256: fingerprint('synthetic'), plan: {} });
  const restarted = new WriteJournal(root);
  assert.equal(restarted.lookup(operationUuid, identity, fingerprint({ body: { label: 'Test', order: 101 }, path: '/one' })).state, 'uncertain');
  assert.throws(() => restarted.lookup(operationUuid, identity, fingerprint({ path: '/one', body: { order: 102, label: 'Test' } })), { code: 'OPERATION_UUID_REUSED' });
  assert.throws(() => restarted.reserve({ operationUuid: 'f84459d2-fc48-4cc9-96c1-9fd46a7f8d3f', identity, requestSha256: fingerprint('changed'), plan: {} }), { code: 'TARGET_PENDING' });
  assert.equal(fs.existsSync(journal.lockFile(identity)), true);
  journal.settle(receipt, { state: 'confirmed' });
  assert.equal(restarted.lookup(operationUuid, identity, requestSha256).state, 'confirmed');
  assert.equal(fs.existsSync(journal.lockFile(identity)), false);
});

test('a relocated receipt still blocks replay and resolves locally without rewriting evidence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-journal-relocation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = new WriteJournal(root);
  const id = 'be5a44d9-53eb-40b4-a560-34e0e0eea56b';
  const identity = { host: 'fixture.test', operationId: 'fixture.write', target: 'fixture' };
  const receipt = { schema: 'ssam-odc-write/1', operationUuid: id, identity,
    state: 'confirmed', ok: true, receipt: '/preserved-checkout/receipt.json' };
  const original = JSON.stringify(receipt);
  fs.writeFileSync(journal.file(id), original);
  const result = journal.lookup(id, identity);
  assert.equal(result.state, 'confirmed');
  assert.equal(result.receipt, journal.file(id));
  assert.equal(fs.readFileSync(journal.file(id), 'utf8'), original);
  assert.throws(() => journal.lookup(id, { ...identity, target: 'other' }), { code: 'OPERATION_UUID_REUSED' });
});
