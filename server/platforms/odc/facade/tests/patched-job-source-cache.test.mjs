import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliveryCache, requiredFlowLayoutEngine } from '../kernel-delivery.mjs';
import { referencedProducers, autoCaptures } from '../o11-cycle.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patched-source-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'); const second = path.join(root, 'second');
  for (const dir of [first, second]) fs.mkdirSync(dir);
  const jobPath = path.join(first, 'kernel-candidate.oml.patched-job.json');
  const jobBytes = JSON.stringify({ base: 'job:vbase', ops: [{ op: 'reference', producer: 'job:vproducer' }] });
  fs.writeFileSync(jobPath, jobBytes);
  const sourcePath = jobPath + '.source.json';
  const source = { jobSha256: hash(jobBytes), sourceDirectory: path.join(root, 'original-input') };
  fs.writeFileSync(sourcePath, JSON.stringify(source));
  const patchedJob = { path: jobPath, sha256: hash(jobBytes), source: { path: sourcePath, sha256: hash(fs.readFileSync(sourcePath)) } };
  const data = { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, patchedJob };
  fs.writeFileSync(path.join(first, 'kernel-candidate.oml'), 'candidate');
  const writeResult = () => fs.writeFileSync(path.join(first, 'kernel-result.json'), JSON.stringify({ ok: true, data }));
  writeResult();
  const cache = deliveryCache({ root, identity: 'source-cache-test' }); const key = 'a'.repeat(64);
  return { root, first, second, source, sourcePath, jobPath, patchedJob, data, writeResult, cache, key };
}

test('a cached corrected job carries its hash-bound resolution origin into new evidence', t => {
  const s = sandbox(t); s.cache.store(s.key, s.first);
  fs.unlinkSync(s.jobPath); fs.unlinkSync(s.sourcePath);
  const restored = s.cache.restore(s.key, s.second);
  assert.equal(restored?.ok, true);
  const job = restored.patchedJob;
  assert.ok(job.source, 'the public receipt still discloses provenance');
  assert.equal(job.source.path, job.path + '.source.json');
  assert.equal(hash(fs.readFileSync(job.path)), job.sha256);
  assert.equal(hash(fs.readFileSync(job.source.path)), job.source.sha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(job.source.path, 'utf8')), s.source);
  const raw = JSON.parse(fs.readFileSync(path.join(s.second, 'kernel-result.json'), 'utf8'));
  assert.deepEqual(raw.data.patchedJob.source, job.source);
});

test('cache store refuses provenance bytes that do not match the disclosed hash', t => {
  const s = sandbox(t); fs.appendFileSync(s.sourcePath, ' ');
  s.cache.store(s.key, s.first);
  assert.equal(fs.existsSync(path.join(s.cache.dir, s.key)), false);
});

test('cache store refuses provenance bound to a different corrected job', t => {
  const s = sandbox(t);
  fs.writeFileSync(s.sourcePath, JSON.stringify({ ...s.source, jobSha256: 'b'.repeat(64) }));
  s.patchedJob.source.sha256 = hash(fs.readFileSync(s.sourcePath)); s.writeResult();
  s.cache.store(s.key, s.first);
  assert.equal(fs.existsSync(path.join(s.cache.dir, s.key)), false);
});

test('cache restore checks provenance before materializing any corrected job', t => {
  const s = sandbox(t); s.cache.store(s.key, s.first);
  fs.writeFileSync(path.join(s.cache.dir, s.key, 'patched-job.json.source.json'), '{}');
  assert.equal(s.cache.restore(s.key, s.second), null);
  assert.equal(fs.existsSync(path.join(s.second, 'kernel-candidate.oml.patched-job.json')), false);
});

test('raw corrected binding names remain discoverable after cache relocation in both document shapes', t => {
  for (const arrayShape of [false, true]) {
    const s = sandbox(t);
    const ops = [{ op: 'reference', producer: 'BinaryData', elements: ['IServerActionSignature:BinaryDataSize'] },
      { op: 'prototype', data: { source: 'prototype-input', bind: { producer: 'Customer_CS' } } }];
    const document = arrayShape ? ops : { base: 'job:base-part', ops };
    const bytes = JSON.stringify(document);
    fs.writeFileSync(s.jobPath, bytes); s.patchedJob.sha256 = hash(bytes);
    fs.writeFileSync(s.sourcePath, JSON.stringify({ ...s.source, jobSha256: s.patchedJob.sha256 }));
    s.patchedJob.source.sha256 = hash(fs.readFileSync(s.sourcePath)); s.writeResult();
    assert.deepEqual(referencedProducers(s.jobPath), ['BinaryData', 'Customer_CS']);
    s.cache.store(s.key, s.first); fs.unlinkSync(s.jobPath); fs.unlinkSync(s.sourcePath);
    const restored = s.cache.restore(s.key, s.second);
    assert.equal(restored?.ok, true);
    assert.equal(fs.readFileSync(restored.patchedJob.path, 'utf8'), bytes, 'binding spellings and raw document shape are preserved');
    assert.deepEqual(referencedProducers(restored.patchedJob.path), ['BinaryData', 'Customer_CS']);
    assert.deepEqual(autoCaptures(restored.patchedJob.path, { producers: { BinaryData: path.join(s.root, 'BinaryData.avsig') } }), ['Customer_CS']);
  }
});
