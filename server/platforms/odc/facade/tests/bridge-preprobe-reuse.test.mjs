import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as bridgeModule from '../o11-bridge.mjs';
const { o11Bridge } = bridgeModule;
const FRESH_WINDOWS_MS = bridgeModule.FRESH_WINDOWS_MS ?? 1000;
import { bridgeOffers } from '../o11-studio.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

// CX14 follow-up (owner rule: fewer rounds): the pre-probe of a watched write never adds a bridge round trip that an answer
// it already has covers. One bridge_manifest per Studio (pid + start), shared with bridgeOffers; a ping only for a Studio
// identity it does not have; a windows read of the same client reused while fresh. Its safety stays: a write sent through
// the client invalidates the read, and an error report seen then refuses the call. Fake bridges on loopback only.
const wait = ms => new Promise(r => setTimeout(r, ms));
const REPORT = { title: 'Unexpected Error', type: 'DialogWindow', isVisible: true, isModal: false };
const OPTIONS = { probeMs: 30, probeTimeoutMs: 300, timeoutMs: 3000 };
let stamp = 0;
async function studio({ manifestFails = 0 } = {}) {
  const s = { report: false, manifestFails };
  const bridge = await fakeBridge((req, socket) => {
    switch (req.method) {
      case 'ping': return { success: true, data: { pid: process.pid, startedUtc: 'synthetic-start' } };
      case 'bridge_manifest': if (s.manifestFails-- > 0) return undefined; /* silent: the read times out */ return { success: true, data: { protocolVersion: 2, capabilities: ['dialogs:dependencies_auto'] } };
      case 'windows': return { success: true, data: { windows: s.report ? [REPORT] : [] } };
      default: return { success: true, data: { opened: true, answered: [] } };
    }
  });
  const count = method => bridge.seen.filter(r => r.method === method).length;
  return { s, bridge, count };
}
const identified = (port, startedUtc) => ({ port, pid: process.pid, record: { pid: process.pid, startedUtc } });

test('one manifest per Studio (pid + start) for every client: pre-probes and bridgeOffers read it once, and no ping', async () => {
  const { bridge, count } = await studio();
  const start = 'synthetic-start-' + (++stamp);
  try {
    await o11Bridge(identified(bridge.port, start)).ok('open_module', { name: 'M' }, OPTIONS);
    const second = o11Bridge(identified(bridge.port, start));
    assert.equal(await bridgeOffers(second, 'dialogs:dependencies_auto'), true);
    await second.ok('refresh_references', { module_key: 'k' }, OPTIONS);
    assert.equal(count('bridge_manifest'), 1);
    assert.equal(count('ping'), 0, 'the record names the Studio');
    // Another Studio process (a restart: another start) reads its own manifest.
    await o11Bridge(identified(bridge.port, start + '-restarted')).ok('open_module', { name: 'M' }, OPTIONS);
    assert.equal(count('bridge_manifest'), 2);
  } finally { await bridge.close(); }
});

test('a client without a Studio identity pings once and keeps it for its next pre-probes', async () => {
  const { bridge, count } = await studio();
  try {
    const client = o11Bridge({ port: bridge.port });
    await client.ok('open_module', { name: 'M' }, OPTIONS);
    await client.ok('open_module', { name: 'M' }, OPTIONS);
    assert.equal(count('ping'), 1); assert.equal(count('bridge_manifest'), 1); assert.equal(count('windows'), 2);
  } finally { await bridge.close(); }
});

test('a fresh windows read of the same client is reused; a write sent since, or its age, makes the pre-probe read again', async () => {
  const { s, bridge, count } = await studio();
  try {
    const client = o11Bridge(identified(bridge.port, 'synthetic-start-' + (++stamp)));
    await client.ok('windows', { max_texts: 20 });
    await client.ok('open_module', { name: 'M' }, OPTIONS);
    assert.equal(count('windows'), 1, 'the read just done covers the pre-probe');
    await client.ok('open_module', { name: 'M' }, OPTIONS);
    assert.equal(count('windows'), 2, 'the open sent since makes it stale');
    await client.ok('windows', { max_texts: 20 }); await wait(FRESH_WINDOWS_MS + 100);
    await client.ok('open_module', { name: 'M' }, OPTIONS);
    assert.equal(count('windows'), 4, 'an old read is never reused');
    // Safety: an error report that appears with a write in between is seen by the pre-probe, which refuses the call.
    await client.ok('windows', { max_texts: 20 }); s.report = true;
    await client.ok('answer_dependencies_dialog', {});
    await assert.rejects(client.ok('open_module', { name: 'M' }, OPTIONS), e => e.code === 'STUDIO_ERROR_DIALOG_OPEN' && e.reply?.executed === false);
    assert.equal(count('open_module'), 3);
  } finally { await bridge.close(); }
});

test('a manifest read that timed out is not kept for another client, and the client that failed does not retry it', async () => {
  const { bridge, count } = await studio({ manifestFails: 1 });
  const start = 'synthetic-start-' + (++stamp);
  try {
    const first = o11Bridge(identified(bridge.port, start));
    await first.ok('open_module', { name: 'M' }, OPTIONS);
    assert.equal(await bridgeOffers(first, 'dialogs:dependencies_auto'), false);
    assert.equal(count('bridge_manifest'), 1);
    assert.equal(await bridgeOffers(o11Bridge(identified(bridge.port, start)), 'dialogs:dependencies_auto'), true);
    assert.equal(count('bridge_manifest'), 2);
  } finally { await bridge.close(); }
});
