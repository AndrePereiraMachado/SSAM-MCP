import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { portalTransportDirectory, writePortalRequest } from '../portal-request-file.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-request-root-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'loaded-bridge'), caller = path.join(dir, 'mcp-checkout');
  fs.mkdirSync(path.join(root, 'studio'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'Fixture root'); fs.mkdirSync(caller);
  const call = async args => { assert.deepEqual(args, ['status', 'root']); return { ok: true, field: 'root', value: root }; };
  return { dir, root, caller, call };
}

test('a client in another checkout writes where the loaded bridge resolves the basename', async t => {
  const f = fixture(t), payload = { method: 'GET', path: '/assets/asset-key' };
  const file = await writePortalRequest(payload, f.call);
  const nativeResolved = path.join(f.root, 'journal', 'portal', 'requests', path.basename(file));
  assert.equal(file, nativeResolved);
  assert.deepEqual(JSON.parse(fs.readFileSync(nativeResolved, 'utf8')), payload);
  assert.equal(fs.existsSync(path.join(f.caller, 'journal')), false);
  assert.notEqual(await writePortalRequest(payload, f.call), file);
  assert.equal(await portalTransportDirectory(f.call, 'uploads'), path.join(f.root, 'journal', 'portal', 'uploads'));
});

test('an absent, malformed or relative bridge root never falls back to the caller checkout', async t => {
  const f = fixture(t);
  for (const answer of [{ ok: false }, { ok: true, root: f.root }, { ok: true, field: 'root', value: '../other' },
    { ok: true, field: 'root', value: f.caller }]) {
    await assert.rejects(writePortalRequest({}, async () => answer), { code: 'BRIDGE_ROOT_UNAVAILABLE' });
  }
  await assert.rejects(writePortalRequest({}, async () => { throw Error('private failure'); }), error =>
    error.code === 'BRIDGE_ROOT_UNAVAILABLE' && !error.message.includes('private failure'));
  assert.equal(fs.existsSync(path.join(f.caller, 'journal')), false);
});

test('a transport junction escaping the bridge root is refused before creating files outside it', async t => {
  const f = fixture(t), outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.root, 'journal'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writePortalRequest({}, f.call), { code: 'BRIDGE_ROOT_UNAVAILABLE' });
  assert.deepEqual(fs.readdirSync(outside), []);
});
