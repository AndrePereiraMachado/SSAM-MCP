import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deriveServiceCaller } from '../debug-o11-service-caller.mjs';
import { resolveO11TraceRuntime } from '../debug-o11-call-boundary.mjs';
import { BLOCKED_BINDINGS } from '../debug-o11-native-run.mjs';
const key = c => c.repeat(22), host = 'fixture.test';
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const blocked = moduleKey => BLOCKED_BINDINGS.find(b => b.host === host && b.moduleKey === moduleKey) ?? null;
function fixture(t, kinds, { callerKey = key('C') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-o11-service-caller-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = kinds.map(([, k]) => k === 'caller' ? callerKey : k);
  const nodes = kinds.map(([kind], i) => ({ id: String(i), key: key(String(i)), kind, moduleKey: keys[i] }));
  const graph = { nodes: new Map(nodes.map(n => [n.id, n])), edges: nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id })) };
  const captures = [...new Set(keys)].map((moduleKey, i) => {
    const module = 'Module' + i, applicationKey = key(String.fromCharCode(97 + i)), versionId = 10 + i;
    const file = path.join(dir, module, 'inventory.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ host, capturedAtUtc: new Date().toISOString(),
      modules: [{ Key: moduleKey, Name: module, ApplicationKey: applicationKey, VersionId: versionId, IsActive: true }, { Key: key('z'), Name: 'Other', ApplicationKey: key('y'), VersionId: 1, IsActive: true }] }));
    return { target: { host, module, moduleKey, applicationKey, runtimeUrl: 'https://' + host + '/' + module + '/' }, versionId, inventoryProof: { path: file, sha256: sha(file) } };
  });
  return { runtime: resolveO11TraceRuntime(graph, { path: nodes.map(({ id }) => ({ id })) }, captures), captures, keys };
}
const scopes = keys => keys.map(moduleKey => ({ moduleKey, functionKey: key('F'), nodeKeys: [key('N')] }));

test('ServiceAction with consumer scopes yields the service caller binding on its own runtime and published row', t => {
  const f = fixture(t, [['DataAction', 'caller'], ['ServiceAction', key('S')]]);
  const listing = () => f.captures.map(c => fs.readdirSync(path.dirname(c.inventoryProof.path)).sort());
  const before = listing(), result = deriveServiceCaller(f.runtime, scopes(f.keys), f.captures, { serverSession: true, host, blocked });
  const caller = f.captures[0];
  // The Service session keeps the plan's own Service row; the consumer session gets the caller row and runtime URL.
  assert.deepEqual(result.serviceCaller, { module: caller.target.module, moduleKey: caller.target.moduleKey, applicationKey: caller.target.applicationKey,
    publishedVersionId: caller.versionId, runtimeUrl: caller.target.runtimeUrl, publishedProof: caller.inventoryProof });
  assert.deepEqual(result.boundary, { kind: 'service-action', callerModuleKey: key('C'), producerModuleKey: key('S'), actionKey: key('1') });
  assert.equal(result.publishedProof, undefined); assert.deepEqual(listing(), before);
});
test('a caller capture without its own runtime URL on the proved host is not a pinned service caller', t => {
  const f = fixture(t, [['DataAction', 'caller'], ['ServiceAction', key('S')]]);
  for (const runtimeUrl of [undefined, 'https://other.test/Module0/', 'https://fixture.test/Module1/', 'https://fixture.test:8443/Module0/', 'http://fixture.test/Module0/']) {
    const captures = f.captures.map((c, i) => i ? c : { ...c, target: { ...c.target, runtimeUrl } });
    assert.equal(deriveServiceCaller(f.runtime, scopes(f.keys), captures, { serverSession: true, host, blocked }).refusal.reason, 'service_caller_capture_unpinned');
  }
});
test('without consumer scopes, outside ssam_debug_server or without a Service hop the plan is unchanged', t => {
  const f = fixture(t, [['DataAction', 'caller'], ['ServiceAction', key('S')]]);
  assert.equal(deriveServiceCaller(f.runtime, scopes([key('S')]), f.captures, { serverSession: true, host, blocked }), null);
  assert.equal(deriveServiceCaller(f.runtime, undefined, f.captures, { serverSession: true, host, blocked }), null);
  assert.equal(deriveServiceCaller(f.runtime, scopes(f.keys), f.captures, { serverSession: false, host, blocked }), null);
  const linked = fixture(t, [['DataAction', 'caller'], ['ServerAction', key('S')]]);
  assert.equal(deriveServiceCaller(linked.runtime, scopes(linked.keys), linked.captures, { serverSession: true, host, blocked }), null);
  assert.throws(() => deriveServiceCaller(f.runtime, scopes(f.keys), f.captures, { serverSession: true, host }), /blocked_check_required/);
});
test('a blocked Core caller binding is still refused and never becomes a service caller', t => {
  const core = BLOCKED_BINDINGS[0];
  const f = fixture(t, [['DataAction', 'caller'], ['ServiceAction', key('S')]], { callerKey: core.moduleKey });
  const result = deriveServiceCaller(f.runtime, scopes(f.keys), f.captures, { serverSession: true, host: core.host,
    blocked: moduleKey => BLOCKED_BINDINGS.find(b => b.moduleKey === moduleKey) ?? null });
  assert.equal(result.serviceCaller, undefined); assert.deepEqual(result.refusal, { reason: 'binding_blocked', blockedBy: core.operationId });
});
test('a third module, an unpinned caller capture or a changed proof are refused', t => {
  const third = fixture(t, [['DataAction', 'caller'], ['ServiceAction', key('S')], ['ServerAction', key('L')]]);
  assert.equal(deriveServiceCaller(third.runtime, scopes([key('C'), key('S')]), third.captures, { serverSession: true, host, blocked }).refusal.reason, 'service_caller_third_module');
  const f = fixture(t, [['DataAction', 'caller'], ['ServiceAction', key('S')]]);
  assert.equal(deriveServiceCaller(f.runtime, scopes([...f.keys, key('X')]), f.captures, { serverSession: true, host, blocked }).refusal.reason, 'service_caller_third_module');
  const unpinned = f.captures.map((c, i) => i ? c : { ...c, inventoryProof: undefined });
  assert.equal(deriveServiceCaller(f.runtime, scopes(f.keys), unpinned, { serverSession: true, host, blocked }).refusal.reason, 'service_caller_capture_unpinned');
  fs.appendFileSync(f.captures[0].inventoryProof.path, ' ');
  assert.throws(() => deriveServiceCaller(f.runtime, scopes(f.keys), f.captures, { serverSession: true, host, blocked }), /inventory_changed/);
  const g = fixture(t, [['DataAction', 'caller'], ['ServiceAction', key('S')]]);
  assert.equal(deriveServiceCaller(g.runtime, scopes(g.keys), g.captures, { serverSession: true, host: 'other.test', blocked }).refusal.reason, 'service_caller_capture_unpinned');
  const proof = g.captures[0].inventoryProof, value = JSON.parse(fs.readFileSync(proof.path, 'utf8'));
  fs.writeFileSync(proof.path, JSON.stringify({ ...value, host: 'other.test' })); proof.sha256 = sha(proof.path);
  assert.throws(() => deriveServiceCaller(g.runtime, scopes(g.keys), g.captures, { serverSession: true, host, blocked }), /publication_proof_invalid/);
});
