// CX15 r5: the fixture of debug-o11-run.test.mjs (an O11 wrapper runner on fakes: lifecycle, app user, invoke,
// debugger), shared by the N-3 test and the r5 family test. Synthetic values; nothing reaches a Studio or a server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createO11Runner } from '../../debug-o11-run.mjs';
import { o11Hash, o11Write } from '../../debug-o11-lifecycle.mjs';
import { appUserBinding } from '../../debug-app-user.mjs';


export const target = { lane: 'o11', host: 'personal.example.test', module: 'Headless_UI', moduleKey: 'A'.repeat(22), applicationKey: 'B'.repeat(22), runtimeUrl: 'https://personal.example.test/Headless_UI/' };
export const action = { kind: 'ServerAction', name: 'GetInfo', key: 'C'.repeat(22), start: 'D'.repeat(22), inputs: [], outputs: [], locals: [],
  nodes: [{ key: 'D'.repeat(22), kind: 'StartNode', targets: ['E'.repeat(22)] }, { key: 'E'.repeat(22), kind: 'EndNode', targets: [] }] };
const wrapper = { key: 'F'.repeat(22), callNode: 'G'.repeat(22), authenticationVerified: true, nativeIdentityGuardVerified: true, originalActionKey: action.key };
const fresh = () => ({ host: target.host, capturedAtUtc: new Date().toISOString(), modules: [{ Name: target.module,
  Key: target.moduleKey, ApplicationKey: target.applicationKey, VersionId: 4870, IsActive: true }] });
export function o11WrapperFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-run-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = []; let versionId = 4870, submitted = 0, count = 0;
  const lifecycle = {
    snapshot: async (_target, directory) => { events.push('snapshot'); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'base.oml'); fs.writeFileSync(file, 'fixture');
      return { file, sha256: o11Hash(fs.readFileSync(file)), versionId, described: {} }; },
    original: async () => action, loginReference: async () => '@' + 'H'.repeat(22),
    exists: async (_base, selector) => selector.includes('SSAMDebug') && submitted > 0,
    apply: async (_base, job, directory) => { events.push('apply'); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'candidate.oml'); fs.writeFileSync(file, JSON.stringify(job));
      return { file, sha256: o11Hash(fs.readFileSync(file)) }; },
    wrapper: async () => wrapper,
    publication: (_target, _base, candidate, _auth, directory, message) => { events.push('publication:' + message);
      return { operationId: randomUUID(), receiptPath: path.join(directory, 'receipt.json'), candidate, message }; },
    publish: async operation => { events.push('publish:' + operation.message); submitted++; versionId++;
      return { ok: true, state: 'published', versionId }; },
    inventory: async (_target, directory) => { events.push('fresh'); fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, 'inventory.json'); o11Write(file, { ...fresh(), modules: [{ ...fresh().modules[0], VersionId: versionId }] });
      return { versionId, proof: { path: file, sha256: o11Hash(fs.readFileSync(file)) } }; },
    ...overrides.lifecycle,
  };
  const binding = appUserBinding(target), descriptor = { credentialRef: randomUUID(), binding, expiresAt: new Date(Date.now() + 600000).toISOString(), state: 'credentials-entered', authenticated: false };
  const runner = createO11Runner({ root, lifecycle, selected: async () => {}, prepareUser: async () => { events.push('prompt'); return { ok: true, descriptor }; },
    releaseUser: async () => { events.push('forget'); return { ok: true }; },
    invoke: async input => { events.push('invoke'); count++; assert.equal(input.descriptor, descriptor); assert.deepEqual(input.body, {});
      return { ok: true, state: 'completed', status: 200, body: { SSAMDebugCompleted: true } }; },
    debug: async input => { events.push(input.op); if (input.op === 'start') {
      assert.equal(input.o11Auth.publishedVersionId, versionId); assert.equal(input.moduleKey, target.moduleKey);
      assert.equal(input.trace.requireFunctionKey, wrapper.key); assert.equal(input.trace.focusFunctionKey, action.key);
      assert.ok(!('host' in input)); assert.ok(!('applicationKey' in input));
      return { ok: true, state: 'connected', sessionId: 'a'.repeat(32) }; }
      return { ok: true, state: 'stopped' }; }, settle: async () => {}, traceRead: () => [], ...overrides.services });
  return { root, runner, events, descriptor, count: () => count };
}
