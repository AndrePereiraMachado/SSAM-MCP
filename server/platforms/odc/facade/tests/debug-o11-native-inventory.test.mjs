import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireO11RawExportInventory, acquireO11NativeInventory } from '../debug-o11-native-inventory.mjs';
import { createO11Lifecycle } from '../debug-o11-lifecycle.mjs';

const target = { host: 'dev.example.test', module: 'Jobs', moduleKey: 'a'.repeat(22), applicationKey: 'z'.repeat(22) };
function fixture(t, changes = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-inventory-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'bridge.key'), 'synthetic-test-key');
  const calls = [], row = { Name: target.module, Key: target.moduleKey, ApplicationKey: target.applicationKey,
    VersionId: 17, Id: 81, IsActive: true, ...changes.row };
  const services = { connection: { pid: 123, port: 4516, authorityDir: root }, bridgeCall: async (_port, method, _authorization, params) => {
    calls.push(method);
    const ok = data => ({ success: true, data });
    if (method === 'ping') return ok({ bridge: 'anvil', pid: 123 });
    if (method === 'get_active_module') return ok({ environment: changes.activeHost ?? target.host });
    if (method === 'bridge_manifest') return ok({ verbs: ['export_modules', 'export_status'] });
    if (method === 'export_modules') {
      assert.equal(params.max, 0); assert.deepEqual(Object.keys(params).sort(), ['max', 'out_dir']);
      fs.writeFileSync(path.join(params.out_dir, 'export-status.json'), JSON.stringify({ state: 'done', host: target.host,
        selected: 0, done: 0, failed: 0, bytes: 0, ...changes.status }));
      fs.writeFileSync(path.join(params.out_dir, 'inventory.json'), JSON.stringify({ host: target.host, modules: [row] }));
      if (changes.lostReply) throw Error('reply lost after read');
      return ok({ started: true, outDir: params.out_dir, host: target.host });
    }
    throw Error('unexpected bridge operation');
  } };
  return { root, calls, services, acquire: () => acquireO11RawExportInventory(target, root, services) };
}

test('loaded bridge raw inventory preserves native ID with zero downloads and reconciles a lost start reply once', async t => {
  const f = fixture(t, { lostReply: true });
  const value = await f.acquire();
  assert.equal(value.modules[0].ModuleId, 81); assert.equal(value.modules[0].VersionId, 17);
  assert.equal(value.modules[0].Key, target.moduleKey); assert.equal(Object.hasOwn(value.modules[0], 'Id'), false);
  assert.deepEqual(f.calls, ['ping', 'get_active_module', 'bridge_manifest', 'export_modules']);
});

test('native ID acquisition refuses another active environment, invalid ID, or evidence of downloads', async t => {
  const host = fixture(t, { activeHost: 'another.example.test' });
  await assert.rejects(host.acquire, /active_environment_mismatch/); assert.equal(host.calls.includes('export_modules'), false);
  const invalid = fixture(t, { row: { Id: 0 } }); await assert.rejects(invalid.acquire, /module_identity_unproved/);
  const downloaded = fixture(t, { status: { selected: 1 } }); await assert.rejects(downloaded.acquire, /read_only_export_unproved/);
});

test('typed inventory missing ModuleId falls back to same live native revision and persists only the verified identity', async t => {
  const f = fixture(t);
  const reply = { host: target.host, capturedAtUtc: new Date().toISOString(), modules: [{ Name: target.module,
    Key: target.moduleKey, ApplicationKey: target.applicationKey, VersionId: 17, IsActive: true }] };
  const lifecycle = createO11Lifecycle({ root: f.root, cli: async () => reply, nativeInventory: f.acquire });
  const capture = await lifecycle.inventory(target, path.join(f.root, 'capture'), { requireModuleId: true });
  assert.equal(capture.row.ModuleId, 81);
  const proof = JSON.parse(fs.readFileSync(capture.proof.path, 'utf8')); assert.equal(proof.modules[0].ModuleId, 81);
  reply.modules[0].VersionId = 18;
  await assert.rejects(() => lifecycle.inventory(target, path.join(f.root, 'changed'), { requireModuleId: true }), /published_version_changed/);
});

function hookFixture(t, changes = {}) {
  const f = fixture(t), calls = [];
  const connection = { pid: 123, startedUtc: '2026-10-04T00:00:00.0000000Z', studioDir: f.root };
  const publishedInventory = { host: target.host, capturedAtUtc: new Date().toISOString(), modules: [{
    Name: target.module, Key: target.moduleKey, ApplicationKey: target.applicationKey, VersionId: 17, IsActive: true }] };
  const transport = {
    describe: async () => { calls.push('describe'); return { ...connection, diagnosticsAvailable: true }; },
    build: async (_project, out, flags) => {
      calls.push('build'); assert.ok(flags.includes('-p:StudioDir=' + f.root));
      const name = flags.find(flag => flag.startsWith('-p:AssemblyName=')).slice('-p:AssemblyName='.length);
      assert.match(name, /^Anvil\.DebugInventoryHook\.[a-f0-9]{32}$/);
      fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, name + '.dll'), 'synthetic isolated assembly');
    },
    attach: async ({ hook, pid, startedUtc }) => {
      calls.push('attach'); assert.equal(pid, 123); assert.equal(startedUtc, connection.startedUtc);
      const config = JSON.parse(fs.readFileSync(hook + '.json', 'utf8'));
      const proof = JSON.parse(fs.readFileSync(config.proofPath, 'utf8')); proof.modules[0].ModuleId = 81;
      fs.writeFileSync(hook + '.receipt.json', JSON.stringify({ ok: true, phase: 'completed', operationId: config.operationId,
        binding: config.binding, assemblySha256: changes.tamperedAssembly ? '0'.repeat(64) : config.assemblySha256,
        proof, source: 'ApplicationManagementService.GetESpaceId', hostSource: 'LoginInfo.HostInfo.HostName' }));
      if (changes.lostReply) throw Error('attach reply lost');
    },
  };
  return { ...f, calls, services: { connection, transport, publishedInventory, buildRoot: path.join(f.root, 'build') } };
}

test('unique read-only inventory hook binds native ID to publication, source and assembly; lost attach is reconciled once', async t => {
  const f = hookFixture(t, { lostReply: true });
  const result = await acquireO11NativeInventory(target, f.root, f.services);
  assert.equal(result.modules[0].ModuleId, 81); assert.equal(result.host, target.host);
  assert.match(result.moduleIdentitySource.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(result.moduleIdentitySource.assemblySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls, ['describe', 'build', 'describe', 'attach']);
});

test('unique inventory hook rejects stale publication before attach and rejects a different assembly receipt', async t => {
  const stale = hookFixture(t); stale.services.publishedInventory.capturedAtUtc = '2000-01-01T00:00:00Z';
  await assert.rejects(() => acquireO11NativeInventory(target, stale.root, stale.services), /publication_proof_invalid/);
  assert.deepEqual(stale.calls, []);
  const tampered = hookFixture(t, { tamperedAssembly: true });
  await assert.rejects(() => acquireO11NativeInventory(target, tampered.root, tampered.services), /receipt_scope_mismatch/);
  assert.equal(tampered.calls.filter(call => call === 'attach').length, 1);
});
