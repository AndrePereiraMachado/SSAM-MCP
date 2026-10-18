import './fixtures/isolated-profile.mjs';
// Item 5 of fix/no-internals: a licensee's server meters the read tools (ssam_reference, ssam_discover, ssam_evidence) per
// caller and UTC day, SIZES only, and flags a caller once a day when their total passes a configurable limit (one alert in
// the day file, one line for the server's log or quality record). The owner's server meters nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { servedBytesStore, meterRead, servedDay, servedTotals, READ_TOOLS, ALERT_GROUP } from '../served-bytes.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-internals-tel-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

async function session(exposure) {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const server = await createSsamServer({ profile: 'all', deps: exposure });
  const client = new Client({ name: 'no-internals-tel', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { call: (name, args) => client.callTool({ name, arguments: args }), close: async () => { await client.close(); await server.close(); } };
}

test('a licensee\'s read answers are counted per caller and day, and one alert is raised once past the limit', async () => {
  const store = servedBytesStore({ dir: path.join(tmp, 'a') });
  const alerts = [];
  const s = await session({ exposure: { profile: 'licensee', store, caller: () => 'tok_x', alertBytes: 15000, onAlert: line => alerts.push(line) } });
  try {
    const first = await s.call('ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' });
    const size = Buffer.byteLength(first.content[0].text, 'utf8');
    assert.deepEqual(alerts, []);
    await s.call('ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' });
    await s.call('ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' });
    assert.equal(alerts.length, 1, 'once per caller and day');
    const line = JSON.parse(alerts[0]);
    assert.deepEqual(Object.keys(line).sort(), ['bytes', 'caller', 'day', 'limitBytes', 'ssam', 'tools']);
    assert.equal(line.caller, 'tok_x'); assert.equal(line.limitBytes, 15000); assert.ok(line.bytes > 15000);
    const day = servedDay(store, 'tok_x');
    assert.equal(day.bytes.ssam_reference, 3 * size);
    assert.equal(day.total, 3 * size);
    assert.equal(day.alerted, true);
    // a tool outside the read tools is not metered
    await s.call('ssam_doctor', {});
    assert.deepEqual(Object.keys(store.day().callers.tok_x), ['ssam_reference']);
  } finally { await s.close(); }
});

test('the owner\'s server meters nothing', async () => {
  const dir = path.join(tmp, 'owner');
  const s = await session({ answersRoot: dir });
  try {
    await s.call('ssam_reference', { lane: 'o11', kind: 'rules', query: 'session' });
    assert.equal(fs.existsSync(path.join(dir, '.local', 'exposure')), false);
  } finally { await s.close(); }
});

test('meterRead: the read tools only, the alert once per caller and day, the totals sorted', () => {
  const store = servedBytesStore({ dir: path.join(tmp, 'b'), now: () => new Date('2026-10-17T12:00:00Z') });
  const logged = [];
  assert.equal(meterRead(store, 'tok', 'ssam_doctor', 999999), null);
  assert.equal(meterRead(store, 'tok', 'ssam_discover', 60, { alertBytes: 100, log: l => logged.push(l) }), null);
  const line = meterRead(store, 'tok', 'ssam_evidence', 50, { alertBytes: 100, log: l => logged.push(l) });
  assert.equal(line.bytes, 110);
  assert.deepEqual(line.tools, { ssam_reference: 0, ssam_discover: 60, ssam_evidence: 50 });
  assert.equal(meterRead(store, 'tok', 'ssam_reference', 10, { alertBytes: 100, log: l => logged.push(l) }), null);
  assert.equal(logged.length, 1);
  meterRead(store, 'small', 'ssam_reference', 5);
  assert.deepEqual(servedTotals(store).map(t => [t.caller, t.total]), [['tok', 120], ['small', 5]]);
  assert.deepEqual(READ_TOOLS, ['ssam_reference', 'ssam_discover', 'ssam_evidence']);
  assert.equal(store.day().alerts[0].tool, ALERT_GROUP);
});
