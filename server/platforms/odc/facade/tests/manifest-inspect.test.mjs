import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { builder, inspect, prepareManifest, root } from '../lib.mjs';
import { applyKernel, kernelCli } from '../kernel-delivery.mjs';
import { anvilRoot as anvil } from '../workspace.mjs';

const fixture = process.env.SSAM_TEST_ODC_FIXTURE ?? path.join(anvil, 'tests', 'fixtures', 'odc', 'insurance-reactive-r8.oml');
const enabled = fs.existsSync(fixture) && fs.existsSync(kernelCli());

// Real dotnet processes (reader, kernel CLI twice, builder six times): ~3 min alone, more beside the whole suite.
test('real headless builder, kernel and MCP: inspection and candidate preparation', { skip: !enabled, timeout: 420000 }, async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-integration-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  // Fixture metadata is synthetic and used ONLY headlessly. No test contacts the Studio.
  const base = path.join(work, 'fixture.oml');
  fs.copyFileSync(fixture, base);
  let map;
  await t.test('MCP default budget without a path returns the module map', async () => {
    const client = new Client({ name: 'manifest-inspect-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'facade', 'mcp.mjs')], stderr: 'pipe' });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'studio_inspect', arguments: { target: base, depth: 2, max: 500 } });
      assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
      assert.equal(result.structuredContent.ok, true);
      map = JSON.parse(fs.readFileSync(result.structuredContent.out, 'utf8'));
      assert.equal(typeof map.module, 'string');
      assert.equal(typeof map.key, 'string');
      assert.ok(Array.isArray(map.flows));
      const tools = (await client.listTools()).tools.map(t => t.name);
      assert.ok(tools.includes('studio_manifest'));
      assert.ok(tools.includes('studio_deliver'));
      const invalid = await client.callTool({ name: 'studio_deliver', arguments: { feature: 'test', job: 'unused.json' } });
      assert.equal(invalid.isError, true);
      assert.match(invalid.structuredContent.error, /module/);
    } finally { await client.close(); }
  });
  assert.ok(map, 'map required for fixture identity');
  await t.test('repeated numeric option values cannot become a path', async () => {
    const result = await inspect({ target: base, depth: 2, max: 2, budget: 2 });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.inline, false);
    const rejected = await builder(['inspect', base, '--budget']);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /Missing value for --budget/);
  });
  const sha256 = createHash('sha256').update(fs.readFileSync(base)).digest('hex').toUpperCase();
  const snapshot = { ok: true, module: map.module, moduleKey: map.key, path: base, sha256,
    host: 'fixture.test', developerId: 'fixture-author@ssam.test', capturedAt: new Date().toISOString(), syntheticTestFixture: true };
  const writeMetadata = data => fs.writeFileSync(base + '.json', JSON.stringify(data));
  writeMetadata(snapshot);
  const job = path.join(work, 'fixture-job.json');
  fs.writeFileSync(job, JSON.stringify({ expectValid: true, ops: [
    { op: 'set', target: 'IMobileFlow:MainFlow', prop: 'Description', value: 'Headless delivery integration test' },
  ] }));
  const kernelDir = path.join(work, 'kernel'); fs.mkdirSync(kernelDir);
  const applied = await applyKernel({ job, snapshot, output: kernelDir });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  const input = { base, candidate: applied.candidate, feature: 'fixture-delivery', owners: ['MainFlow'], changes: ['Update flow description'], output: path.join(work, 'prepared') };
  await t.test('external candidate becomes a hash-bound manifest using snapshot identity', async () => {
    const result = await prepareManifest(input);
    assert.equal(result.ok, true, result.error);
    const manifest = JSON.parse(fs.readFileSync(result.manifest, 'utf8'));
    assert.equal(manifest.schema, 'odc3-manifest/1');
    assert.equal(manifest.author, snapshot.developerId);
    assert.equal(manifest.tenant, snapshot.host);
    assert.equal(manifest.moduleKey, snapshot.moduleKey);
    assert.equal(manifest.baseSha256, sha256);
    assert.equal(manifest.publishAuthorization, null);
    assert.notEqual(manifest.candidatePath, applied.candidate);
    assert.equal(manifest.candidateSha256, createHash('sha256').update(fs.readFileSync(manifest.candidatePath)).digest('hex').toUpperCase());
    const again = await prepareManifest(input);
    assert.equal(again.ok, false);
    assert.match(again.error, /new output directory/);
  });
  // The change is read from the two models, not from audit stamps (QuizLiveWeb, 2026-10-05: a default value and a
  // description set on existing attributes stamped nothing and the build answered "no change").
  await t.test('a property set on an existing child stamps nothing and is still a change', async () => {
    const childJob = path.join(work, 'child-property-job.json');
    fs.writeFileSync(childJob, JSON.stringify({ expectValid: true, ops: [
      { op: 'set', target: '@+A0gb1U6vEKk1gO0+yy1sA', prop: 'Description', value: 'Property-only edit on an existing attribute' },
    ] }));
    const childDir = path.join(work, 'kernel-child'); fs.mkdirSync(childDir);
    const child = await applyKernel({ job: childJob, snapshot, output: childDir });
    assert.equal(child.ok, true, JSON.stringify(child));
    // The kernel's receipt proves this (base, candidate) pair: the builder writes the manifest from it (C02 B1).
    const result = await prepareManifest({ ...input, candidate: child.candidate, output: path.join(work, 'prepared-child') });
    assert.equal(result.ok, true, result.error);
    const fast = JSON.parse(fs.readFileSync(path.join(work, 'prepared-child', 'builder-receipt.json'), 'utf8'));
    assert.equal(fast.path, 'kernel-receipt');
    assert.ok(fast.change.changedProperties >= 1, JSON.stringify(fast.change));
    // The same candidate without the receipt: the two models say it, property by property.
    const bare = path.join(work, 'bare-child'); fs.mkdirSync(bare);
    fs.copyFileSync(child.candidate, path.join(bare, 'kernel-candidate.oml'));
    const modelPath = await prepareManifest({ ...input, candidate: path.join(bare, 'kernel-candidate.oml'), output: path.join(work, 'prepared-child-model') });
    assert.equal(modelPath.ok, true, modelPath.error);
    const receipt = JSON.parse(fs.readFileSync(path.join(work, 'prepared-child-model', 'builder-receipt.json'), 'utf8'));
    assert.equal(receipt.path, 'model');
    assert.equal(receipt.change.stamped, 0, 'the Model API stamps no element for this edit');
    assert.ok(receipt.change.changedProperties >= 1);
    assert.ok(receipt.change.sample.some(s => s.endsWith('.Description')), JSON.stringify(receipt.change));
  });
  await t.test('a candidate equal to the live base is refused before delivery, as no change', async () => {
    const result = await prepareManifest({ ...input, candidate: base, output: path.join(work, 'prepared-equal') });
    assert.equal(result.ok, false);
    assert.match(result.error, /Candidate equals the live module .*nothing to deliver/);
  });
  for (const [name, metadata, pattern] of [
    ['changed base', { ...snapshot, sha256: '0'.repeat(64) }, /Captured base changed/],
    ['missing tenant', { ...snapshot, host: undefined }, /requires host/],
    ['missing author', { ...snapshot, developerId: undefined }, /requires developerId/],
    ['old capture', { ...snapshot, capturedAt: '2020-01-01T00:00:00Z' }, /older than/],
    ['wrong module identity', { ...snapshot, moduleKey: 'different' }, /identity mismatch/],
    ['wrong candidate author', { ...snapshot, developerId: 'other-author@ssam.test' }, /snapshot author/],
  ]) {
    await t.test('refuses ' + name, async () => {
      writeMetadata(metadata);
      const result = await prepareManifest({ ...input, output: path.join(work, name.replaceAll(' ', '-')) });
      assert.equal(result.ok, false);
      assert.match(result.error, pattern);
    });
  }
  writeMetadata(snapshot);
});
