import './fixtures/isolated-profile.mjs';
// The reference a licensee is served (fix/no-internals): the team rules by section (a whole-document request answers its
// sections with sizes and calls), at most callBytes of rules text per answer (the rest named with its calls), no coverage
// matrix of the proven examples, and a day's bytes per caller (served-bytes.mjs, sizes only) after which ssam_reference
// answers REFERENCE_DAY_LIMIT with the reset time and ssam_discover as the way on. The owner's server answers as before.
// Nothing here needs a lane CLI: the kinds called are answered from files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { licenseeReferenceAnswer, licenseeReferenceRefusal, LICENSEE_REFERENCE } from '../ssam-reference.mjs';
import { servedBytesStore, nextDay, SERVED_SCHEMA, callerId } from '../served-bytes.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-internals-ref-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });

async function session(exposure, extra = {}) {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const server = await createSsamServer({ profile: 'all', deps: { exposure: { profile: exposure, ...extra } } });
  const client = new Client({ name: 'no-internals-ref', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async args => { const r = await client.callTool({ name: 'ssam_reference', arguments: args }); return r.structuredContent; };
  return { server, call, close: async () => { await client.close(); await server.close(); } };
}

test('a whole team-rules request answers its sections, each with its size and its call; a section answers its text', async () => {
  const s = await session('licensee', { store: servedBytesStore({ dir: path.join(tmp, 'a') }), caller: () => 'tok_a' });
  try {
    const whole = await s.call({ lane: 'o11', kind: 'rules', query: 'all' });
    assert.equal(whole.ok, true);
    assert.equal(whole.byPart, true);
    assert.equal(whole.text, undefined);
    assert.ok(whole.sections.length >= 2);
    for (const section of whole.sections) {
      assert.ok(section.bytes > 0);
      assert.deepEqual(section.call.arguments, { lane: 'o11', kind: 'rules', query: { doc: 'team', section: section.id } });
    }
    const one = await s.call(whole.sections[0].call.arguments);
    assert.equal(one.ok, true);
    assert.ok(one.text.length > 500);
    // the standards and the session rules: usage rules, whole
    assert.ok((await s.call({ lane: 'odc', kind: 'rules', query: 'session' })).text.length > 1000);
    assert.ok((await s.call({ lane: 'odc', kind: 'rules', query: 'standards' })).text.length > 1000);
    // the coverage matrix is not served; an example by id is
    const matrix = await s.call({ lane: 'o11', kind: 'example', query: 'matriz' });
    assert.equal(matrix.code, 'REFERENCE_NOT_SERVED');
    assert.deepEqual(matrix.continuation.arguments, { lane: 'o11', kind: 'example', query: { find: '<widget, pattern or capability>' } });
    assert.equal((await s.call({ lane: 'odc', kind: 'example', query: 'timer-action' })).ok, true);
  } finally { await s.close(); }
});

test('the owner\'s server answers the whole document and the matrix as before', async () => {
  const s = await session('owner');
  try {
    const whole = await s.call({ lane: 'o11', kind: 'rules', query: 'all' });
    assert.equal(whole.byPart, undefined);
    assert.ok(whole.text.length > 5000);
    assert.equal((await s.call({ lane: 'o11', kind: 'example', query: 'matriz' })).ok, true);
  } finally { await s.close(); }
});

test('a section above the call limit answers its first lessons and names each other one with its call', () => {
  const text = '## 3. Platform lessons\n\nintro\n\n' + Array.from({ length: 6 }, (_, i) => '### Lesson ' + i + '\n\n' + 'x'.repeat(900) + '\n\n').join('');
  const answer = { ok: true, lane: 'o11', kind: 'rules', doc: 'team', section: [{ id: '3' }], sections: [], text };
  const cut = licenseeReferenceAnswer('o11', 'rules', '3', answer, { callBytes: 2500 });
  assert.ok(Buffer.byteLength(cut.text) <= 2500);
  assert.ok(cut.cut.parts.length >= 4);
  assert.deepEqual(cut.cut.parts.at(-1).call.arguments, { lane: 'o11', kind: 'rules', query: { doc: 'team', section: 'Lesson 5' } });
  // under the limit: unchanged
  assert.equal(licenseeReferenceAnswer('o11', 'rules', '3', answer, { callBytes: 100000 }), answer);
  assert.equal(licenseeReferenceRefusal('odc', 'example', { id: 'jobs-odc/examples/matriz' }).code, 'REFERENCE_NOT_SERVED');
  assert.equal(licenseeReferenceRefusal('odc', 'example', 'timer-action'), null);
  assert.ok(LICENSEE_REFERENCE.callBytes > 0 && LICENSEE_REFERENCE.dayBytes > LICENSEE_REFERENCE.callBytes);
});

test('past the day\'s bytes of a caller, ssam_reference refuses before reading; another caller still reads', async () => {
  const dir = path.join(tmp, 'b');
  const store = servedBytesStore({ dir });
  let caller = 'tok_b';
  const s = await session('licensee', { store, caller: () => caller, dayBytes: 12000 });
  try {
    let answer;
    for (let i = 0; i < 6 && answer?.code !== 'REFERENCE_DAY_LIMIT'; i++) answer = await s.call({ lane: 'o11', kind: 'rules', query: 'session' });
    assert.equal(answer.code, 'REFERENCE_DAY_LIMIT');
    assert.equal(answer.limitBytes, 12000);
    assert.ok(answer.usedBytes >= 12000);
    assert.equal(answer.resetsAt, nextDay());
    assert.equal(answer.continuation.tool, 'ssam_discover');
    caller = 'tok_c';
    assert.equal((await s.call({ lane: 'o11', kind: 'rules', query: 'session' })).ok, true);
    // the day file holds sizes only: no argument, no answer text
    const day = JSON.parse(fs.readFileSync(path.join(dir, 'served-' + store.dayOf() + '.json'), 'utf8'));
    assert.equal(day.schema, SERVED_SCHEMA);
    assert.deepEqual(Object.keys(day.callers).sort(), ['tok_b', 'tok_c']);
    assert.deepEqual(Object.keys(day.callers.tok_b.ssam_reference).sort(), ['bytes', 'calls']);
    assert.doesNotMatch(JSON.stringify(day), /session|rules|deliver/);
  } finally { await s.close(); }
});

test('the store counts per caller, tool and UTC day, and an alert is written once', () => {
  let at = new Date('2026-10-17T23:59:00Z');
  const store = servedBytesStore({ dir: path.join(tmp, 'c'), now: () => at });
  store.record('tok', 'ssam_reference', 100); store.record('tok', 'ssam_discover', 50); store.record('other', 'ssam_reference', 7);
  assert.equal(store.usage('tok'), 150);
  assert.equal(store.usage('tok', ['ssam_reference']), 100);
  assert.equal(store.alert('tok', 'reference+discover', 150, 100), true);
  assert.equal(store.alert('tok', 'reference+discover', 160, 100), false);
  at = new Date('2026-10-18T00:01:00Z');
  assert.equal(store.usage('tok'), 0);
  assert.equal(store.usage('tok', null, '2026-10-17'), 150);
  assert.equal(store.record('../x', 'ssam_reference', 1).total, 1); // an odd caller id is counted under a hash of it (its own bucket), never a path
  assert.deepEqual(Object.keys(store.day().callers), [callerId('../x')]); assert.match(callerId('../x'), /^h-[0-9a-f]{16}$/);
});
