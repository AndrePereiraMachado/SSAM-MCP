import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeRequest, bridgeTarget, o11Bridge, timeoutFor, BridgeError } from '../o11-bridge.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

test('a bridge call sends method, params and the controller key on one line and returns the reply', async () => {
  const bridge = await fakeBridge(request => ({ success: true, data: { echo: request.method, params: request.params } }));
  try {
    const reply = await bridgeRequest({ port: bridge.port, authorization: 'KEY' }, 'get_errors', { max: 5 });
    assert.deepEqual(reply, { success: true, data: { echo: 'get_errors', params: { max: 5 } } });
    assert.deepEqual(bridge.seen[0], { method: 'get_errors', params: { max: 5 }, authorization: 'KEY' });
  } finally { await bridge.close(); }
});

test('large replies split across chunks are read whole; refusals come back as replies, ok() turns them into coded errors', async () => {
  const big = 'x'.repeat(300000);
  const bridge = await fakeBridge(request => request.method === 'windows'
    ? { success: true, data: { big } }
    : { success: false, executed: false, error: 'Bridge operation requires the trusted Hybrid controller' });
  try {
    const client = o11Bridge({ port: bridge.port, authorization: 'K' });
    assert.equal((await client.ok('windows')).big.length, 300000);
    await assert.rejects(client.ok('close_dialog', { title: 'X' }), error => error instanceof BridgeError && error.code === 'BRIDGE_REFUSED' && error.executed === false);
  } finally { await bridge.close(); }
});

test('transport failures are coded: not listening, timeout after send (unknown outcome), oversize and foreign replies', async () => {
  const closed = await fakeBridge(() => undefined); const port = closed.port; await closed.close();
  await assert.rejects(bridgeRequest({ port }, 'ping'), e => e.code === 'BRIDGE_NOT_LISTENING' && e.executed === false);
  const silent = await fakeBridge(() => undefined);
  try { await assert.rejects(bridgeRequest({ port: silent.port }, 'open_module', {}, { timeoutMs: 150 }), e => e.code === 'BRIDGE_TIMEOUT' && e.executed === undefined); }
  finally { await silent.close(); }
  const huge = await fakeBridge(() => 'y'.repeat(4096));
  try { await assert.rejects(bridgeRequest({ port: huge.port, maxBytes: 1024 }, 'ping'), e => e.code === 'BRIDGE_REPLY_TOO_LARGE'); }
  finally { await huge.close(); }
  const foreign = await fakeBridge(() => 'HTTP/1.1 400 Bad Request\n');
  try { await assert.rejects(bridgeRequest({ port: foreign.port }, 'ping'), e => e.code === 'BRIDGE_PROTOCOL'); }
  finally { await foreign.close(); }
});

test('timeouts follow the bridge own bounds per command', () => {
  assert.equal(timeoutFor('open_module', { timeout: 300 }), 360000);
  assert.equal(timeoutFor('open_module', {}), 180000);
  assert.equal(timeoutFor('studio_login', { waitMs: 60000 }), 90000);
  assert.equal(timeoutFor('unknown_verb', {}), 120000);
});

test('the target comes from the connection record, else the lane table and the authority rules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-bridge-root-'));
  const auth = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-bridge-auth-'));
  try {
    fs.writeFileSync(path.join(auth, 'bridge.key'), 'ABCDEF\n');
    const noRecord = bridgeTarget({ lane: 'ss5', root, env: { ANVIL_AUTHORITY_DIR: auth, USERPROFILE: root } });
    assert.equal(noRecord.port, 4536); assert.equal(noRecord.pid, null); assert.equal(noRecord.authorization, 'ABCDEF');
    fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
    const recordAuth = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-bridge-rec-'));
    fs.writeFileSync(path.join(recordAuth, 'bridge.key'), 'FROMRECORD');
    fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242,
      startedUtc: '2026-10-02T00:00:00Z', studioDir: 'C:\\Studio', authorityDir: recordAuth, port: 45999 }));
    const withRecord = bridgeTarget({ lane: 'ss4', root, env: { ANVIL_AUTHORITY_DIR: auth } });
    assert.equal(withRecord.port, 45999); assert.equal(withRecord.pid, 4242); assert.equal(withRecord.authorization, 'FROMRECORD');
    fs.rmSync(recordAuth, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(auth, { recursive: true, force: true }); }
});
