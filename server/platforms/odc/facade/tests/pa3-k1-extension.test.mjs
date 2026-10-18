// Atritos 3, lane K1-f (docs/PACOTE-ATRITOS-3.md): what `xif check` accepted in another shape (sources, references or
// resources as one object) reaches the o11_extension receipt as specNormalized. Fake bridge, fake kernel and fake Service
// Center engine (as o11-extension.test.mjs); every folder is temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createO11Extension } from '../o11-extension.mjs';
import { CAPABILITY } from '../service-center/integration-studio.mjs';

const NAME = 'ZZHybridXifLab';
const SPEC = { name: NAME, sources: { path: 'Arith.cs', text: 'class Arith {}' },
  actions: [{ name: 'Add', inputs: [{ name: 'Left', type: 'Integer' }], outputs: [{ name: 'Result', type: 'Integer' }], body: 'Result = Left;' }] };

function run(t, normalized) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-k1-extension-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return { bytes: text.length, file }; };
  const bridge = {
    supports: async () => true,
    session: async host => ({ studio: { signedIn: true, host, user: 'lab-user' }, web: {} }),
    capabilities: async () => new Set(['sc_api:soap', 'sc_api:server-api', 'sc_api:sc-rest', CAPABILITY]),
    api: async (host, surface, operation, args) => {
      switch (surface + ':' + operation) {
        case 'soap:ListExtensions': case 'soap:ListEspaces': return { ok: true, result: [] };
        case 'integration-studio:Handshake': return { ok: true, result: { ok: true, platform: '11.38.0' } };
        case 'integration-studio:GenerateSourceCodeStubs': return { ok: true, result: { ...write(args.outFile, 'PK-stubs'), meta: { messages: [], errors: 0 } } };
        case 'integration-studio:GetSourceCodeDependencies': return { ok: true, result: { ...write(args.outFile, 'PK-deps'), meta: { messages: [], errors: 0 } } };
        case 'integration-studio:UploadNeeded': return { ok: true, result: { needs: true, extensionId: 0, equalVersionId: 0, runningVersionId: 0 } };
        default: throw new Error('unexpected ' + surface + ':' + operation);
      }
    },
  };
  const runAnvil = async args => {
    const opt = name => args[args.indexOf(name) + 1];
    let data;
    if (args[1] === 'check') data = { ok: true, spec: { ...SPEC, sources: [SPEC.sources] }, create: true, ...(normalized ? { specNormalized: normalized } : {}) };
    else if (opt('--stage') === 'model') { const xif = path.join(opt('--work'), 'model', NAME + '.xif'); write(xif, 'model'); data = { ok: true, stage: 'model', xif, engine: { version: '11.14.25.134', lastUpgradeVersion: '11.0.0.200' } }; }
    else { const xif = path.join(opt('--work'), 'final', NAME + '.xif'); write(xif, 'final'); data = { ok: true, stage: 'final', xif, xifSha256: 'a'.repeat(64), dllSha256: 'b'.repeat(64), hash: 'h', key: 'ext-key-1', name: NAME }; }
    return { ok: true, exitCode: 0, envelope: { ok: true, command: 'xif', data } };
  };
  return createO11Extension({ root, now: () => new Date('2026-10-07T12:00:00Z'), runAnvil, locate: async () => bridge, grantsFile: path.join(root, 'grants.json'),
    serviceCenter: async () => ({ ok: true, state: 'confirmed', extensionId: 41, extensionVersionId: 8 }), hostClass: () => 'personal',
    publishConsumersOf: async () => ({ ok: true, consumers: [] }) })({ action: 'publish', host: 'lab.example.com', spec: SPEC, words: 'sim, pode publicar a ZZHybridXifLab' });
}

test('K1-f: the receipt carries specNormalized when the kernel normalized the spec, and nothing otherwise', async t => {
  const notes = [{ path: 'sources', from: 'object', to: 'list' }];
  const value = await run(t, notes);
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.state, 'created');
  assert.deepEqual(value.specNormalized, notes);
  const plain = await run(t, null);
  assert.equal(plain.ok, true); assert.equal(plain.specNormalized, undefined);
});
