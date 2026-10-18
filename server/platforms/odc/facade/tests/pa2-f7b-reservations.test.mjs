// Atritos 2, lane F7b, A28: the doctor classifies every active module reservation of the shared authority (active, stale,
// foreign, orphan) and offers ssam_task only for a task of this root; another root's reservation, or one without a task
// here, is freed by ssam_doctor {lane:"o11", release:{reservation, authorize}} with the user's words (owner null,
// releasedBy "doctor", the sha256 of the words), never through ssam_task. Real case of 2026-10-05 (store C14, O11): the doctor
// offered ssam_task {id:"a471638c..."} for a reservation of 29/09 of another root and ssam_task answered TASK_NOT_FOUND.
// Temporary folders only; no Studio, no kernel.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as m_ssam from '../ssam.mjs';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const durable = payload => { const text = JSON.stringify(payload); return JSON.stringify({ format: 1, sha256: sha(text), payload: text }); };
const readPayload = file => { const doc = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(doc.sha256, sha(doc.payload), 'the envelope checks'); return JSON.parse(doc.payload); };
const HOLDER = 'a471638cb0484920a6d0c0166b6f8a46';
const RELEASE_ARGS = file => ({ lane: 'o11', release: { reservation: file, authorize: "<the user's own words>" } });

function sandbox(t) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'pa2-f7b-res-'));
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  const root = path.join(box, 'this-root', 'kernel');
  const work = path.join(root, '.local', 'work');
  const authority = path.join(box, 'authority');
  const reservations = path.join(authority, 'reservations');
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(reservations, { recursive: true });
  const env = { ANVIL_AUTHORITY_DIR: authority, LOCALAPPDATA: path.join(box, 'Local') };
  const ctx = { root, works: [work], alive: pid => pid === 31337 };
  let n = 0;
  const reserve = payload => { const file = path.join(reservations, (++n).toString(16).padStart(64, '0') + '.json'); fs.writeFileSync(file, durable(payload)); return file; };
  const task = (id, state) => { const dir = path.join(work, 'deliver', id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'task.json'), durable({ taskId: id, ...state })); };
  return { box, root, work, authority, reservations, env, ctx, reserve, task };
}
const listed = s => m_ssam.moduleReservations({ env: s.env, readUserEnvironment: () => null, ...s.ctx });
const byFile = (report, file) => report.active.find(r => r.file === file);

test('a reservation of another SSAM root is foreign: the doctor offers ssam_doctor release, never ssam_task', t => {
  assert.equal(typeof m_ssam.classifyReservation, 'function', 'the doctor classifies the reservations (A28)');
  const s = sandbox(t);
  const other = path.join(s.box, 'other-root', 'kernel');
  const file = s.reserve({ owner: HOLDER, environment: 'personal-x.outsystemscloud.com', moduleKey: '3TPPF1FCb0y5LDfjJpzx9Q', root: other, pid: 4242, since: '2026-09-29T21:14:03.0000000+00:00' });
  s.task(HOLDER, { writeState: 'not-sent', error: 'refused', delivered: false }); // even a task of the same id here is not it: the root decides
  const entry = byFile(listed(s), file);
  assert.equal(entry.state, 'foreign');
  assert.deepEqual([entry.root, entry.pid, entry.processAlive, entry.since], [other, 4242, false, '2026-09-29T21:14:03.0000000+00:00']);
  assert.equal(entry.next.tool, 'ssam_doctor');
  assert.deepEqual(entry.next.arguments, RELEASE_ARGS(file));
  assert.doesNotMatch(JSON.stringify(entry), /"tool":"ssam_task"/);
});

test('the reservation of 29/09 without a root and without a task here is orphan (the real TASK_NOT_FOUND case)', t => {
  assert.equal(typeof m_ssam.classifyReservation, 'function', 'the doctor classifies the reservations (A28)');
  const s = sandbox(t);
  const file = s.reserve({ owner: HOLDER, environment: 'personal-x.outsystemscloud.com', moduleKey: '3TPPF1FCb0y5LDfjJpzx9Q' });
  const entry = byFile(listed(s), file);
  assert.equal(entry.state, 'orphan');
  assert.match(entry.reason, /no delivery task a471638cb0484920a6d0c0166b6f8a46 in this root/);
  assert.deepEqual([entry.next.tool, entry.next.arguments], ['ssam_doctor', RELEASE_ARGS(file)]);
  assert.match(entry.next.why, /never ssam_task/);
});

test('a reservation of this root whose task ended not-sent is stale: ssam_task close; one with a write to settle is active: ssam_task read', t => {
  assert.equal(typeof m_ssam.classifyReservation, 'function', 'the doctor classifies the reservations (A28)');
  const s = sandbox(t);
  const notSent = 'b'.repeat(32), uncertain = 'c'.repeat(32), closed = 'd'.repeat(32);
  s.task(notSent, { writeState: 'not-sent', error: 'Selected Studio is not connected', delivered: false, stage: 'snapshot' });
  s.task(uncertain, { writeState: 'intent', delivered: false, stage: 'merge' });
  s.task(closed, { writeState: 'not-applied', error: 'x', closed: true, delivered: false });
  const stale = s.reserve({ owner: notSent, environment: 'env', moduleKey: 'k1', root: s.root + path.sep, pid: 999999, since: '2026-10-06T10:00:00Z' });
  const active = s.reserve({ owner: uncertain, environment: 'env', moduleKey: 'k2', root: s.root, pid: 31337, since: '2026-10-06T10:00:00Z' });
  const left = s.reserve({ owner: closed, environment: 'env', moduleKey: 'k3', root: s.root });
  const report = listed(s);
  const a = byFile(report, stale), b = byFile(report, active), c = byFile(report, left);
  assert.equal(a.state, 'stale'); assert.equal(a.processAlive, false);
  assert.deepEqual([a.next.tool, a.next.arguments], ['ssam_task', { id: notSent, close: { reason: '<reason>' } }]);
  assert.equal(b.state, 'active'); assert.equal(b.processAlive, true);
  assert.deepEqual([b.next.tool, b.next.arguments], ['ssam_task', { id: uncertain }]);
  // A task already closed frees nothing by closing again: its leftover is released like an orphan.
  assert.equal(c.state, 'stale'); assert.deepEqual([c.next.tool, c.next.arguments], ['ssam_doctor', RELEASE_ARGS(left)]);
  assert.equal(report.activeTotal, 3);
});

test('a reservation of a controlled app session task (app-sessions.json of the authority) is active and never released here', async t => {
  assert.equal(typeof m_ssam.classifyReservation, 'function', 'the doctor classifies the reservations (A28)');
  const s = sandbox(t);
  const appTask = '9'.repeat(32);
  fs.writeFileSync(path.join(s.authority, 'app-sessions.json'), durable({ sessions: { s1: appTask }, tasks: { [appTask]: { deliveryTaskId: '8'.repeat(32), deliveryWork: path.join(s.authority, 'deliveries', 'ss4') } } }));
  const file = s.reserve({ owner: appTask, environment: 'env', moduleKey: 'k', root: path.join(s.box, 'any', 'kernel') });
  const entry = byFile(listed(s), file);
  assert.deepEqual([entry.state, entry.appSession, entry.next.tool, entry.next.arguments], ['active', true, 'status', { task_id: appTask }]);
  const { call } = await serve(s, t);
  const refused = await call({ lane: 'o11', release: { reservation: file, authorize: 'libere' } });
  assert.equal(refused.code, 'RESERVATION_HAS_TASK', JSON.stringify(refused));
  assert.equal(readPayload(file).owner, appTask);
});

async function serve(s, t) {
  const server = await m_ssam.createSsamServer({ o11: false, odc: false, deps: { reservations: { env: s.env, readUserEnvironment: () => null, ...s.ctx } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa2-f7b-reservations', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async args => { try { return (await client.callTool({ name: 'ssam_doctor', arguments: args })).structuredContent; } catch (error) { return { ok: false, error: error.message }; } };
  return { client, call };
}

test('release with the user\'s words frees a foreign reservation: owner null, releasedBy doctor, only the sha256 of the words', async t => {
  const s = sandbox(t);
  const file = s.reserve({ owner: HOLDER, environment: 'env', moduleKey: 'k', root: path.join(s.box, 'other', 'kernel'), pid: 4242, since: '2026-09-29T21:14:03Z' });
  const { client, call } = await serve(s, t);
  const doctor = (await client.listTools()).tools.find(x => x.name === 'ssam_doctor');
  assert.match(doctor.inputSchema.properties.release?.description ?? '', /^Alone:/, 'release is a mode field (Alone:)');
  assert.match(doctor.description, /\brelease\b/);
  const words = 'pode liberar a reserva do modulo';
  const value = await call({ lane: 'o11', release: { reservation: file, authorize: words } });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual([value.released, value.state, value.owner, value.releasedBy], [true, 'foreign', HOLDER, 'doctor']);
  const payload = readPayload(file);
  assert.equal(payload.owner, null);
  assert.equal(payload.releasedBy, 'doctor');
  assert.equal(payload.wordsSha256, sha(words));
  assert.deepEqual([payload.environment, payload.moduleKey, payload.previousOwner], ['env', 'k', HOLDER]);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /pode liberar/, 'the words never reach the file');
  // Already free: answered, nothing written again.
  const again = await call({ lane: 'o11', release: { reservation: file, authorize: words } });
  assert.deepEqual([again.ok, again.released], [true, false]);
});

test('release without words is WORDS_REQUIRED and changes nothing; a placeholder is no words', async t => {
  const s = sandbox(t);
  const file = s.reserve({ owner: HOLDER, environment: 'env', moduleKey: 'k' });
  const before = fs.readFileSync(file, 'utf8');
  const { call } = await serve(s, t);
  for (const release of [{ reservation: file }, { reservation: file, authorize: '   ' }, { reservation: file, authorize: "<the user's own words>" }]) {
    const value = await call({ lane: 'o11', release });
    assert.equal(value.code, 'WORDS_REQUIRED', JSON.stringify(value));
    // CX15 r7 (converted): a server text as the words is refused by the hub's one rule before the tool runs (askOwner names the
    // field); missing or blank words keep the tool's own refusal and its ssam_doctor continuation.
    if (release.authorize?.trim()) assert.deepEqual(value.askOwner?.fields, ['release/authorize']);
    else assert.deepEqual([value.continuation.tool, value.continuation.arguments], ['ssam_doctor', RELEASE_ARGS(file)]);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('release never frees a reservation a task of this root can resume or close, nor one a running delivery holds, nor a file outside the authority', async t => {
  const s = sandbox(t);
  const notSent = 'e'.repeat(32);
  s.task(notSent, { writeState: 'not-sent', error: 'x', delivered: false });
  const owned = s.reserve({ owner: notSent, environment: 'env', moduleKey: 'k1', root: s.root });
  const held = s.reserve({ owner: HOLDER, environment: 'env', moduleKey: 'k2' });
  const { call } = await serve(s, t);
  const words = 'libere';
  const refused = await call({ lane: 'o11', release: { reservation: owned, authorize: words } });
  assert.equal(refused.code, 'RESERVATION_HAS_TASK', JSON.stringify(refused));
  assert.deepEqual([refused.continuation.tool, refused.continuation.arguments], ['ssam_task', { id: notSent, close: { reason: '<reason>' } }]);
  assert.equal(readPayload(owned).owner, notSent);
  if (process.platform === 'win32') {
    // The kernel's lease (DurableJson.Lease: FileShare.None on <file>.lock) while a delivery runs.
    const fd = fs.openSync(held + '.lock', fs.constants.O_RDWR | fs.constants.O_CREAT | 0x10000000);
    try {
      const busy = await call({ lane: 'o11', release: { reservation: held, authorize: words } });
      assert.equal(busy.code, 'RESERVATION_IN_USE', JSON.stringify(busy));
      assert.equal(readPayload(held).owner, HOLDER);
    } finally { fs.closeSync(fd); }
  }
  const outside = path.join(s.box, 'f'.repeat(64) + '.json'); fs.writeFileSync(outside, durable({ owner: HOLDER, environment: 'env', moduleKey: 'k9' }));
  const elsewhere = await call({ lane: 'o11', release: { reservation: outside, authorize: words } });
  assert.equal(elsewhere.code, 'RESERVATION_NOT_FOUND');
  assert.equal(readPayload(outside).owner, HOLDER);
  const odc = await call({ lane: 'odc', release: { reservation: held, authorize: words } });
  assert.equal(odc.code, 'BAD_ARGS');
});
