// The 16th release on the hosted line: the module reservations of the O11 deliveries (I8/A28) of a hosted customer live in
// <ws>/state/relay-authority (the authority of the customer's kernel runs), and ssam_doctor lists and releases only those,
// by file name. The owner's authority (ANVIL_AUTHORITY_DIR of this process) is never listed nor changed. Fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { hostedReservations, hostedRelease, HOSTED_RESTART_NEXT, RESTART_NEXT } from '../ssam.mjs';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
function reservation(dir, payload) {
  fs.mkdirSync(dir, { recursive: true });
  const name = randomBytes(32).toString('hex') + '.json';
  const text = JSON.stringify(payload);
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ format: 1, sha256: sha(text), payload: text }));
  return name;
}
const ownerOf = file => JSON.parse(JSON.parse(fs.readFileSync(file, 'utf8')).payload).owner;

test('hosted reservations: only the customer\'s relay authority, named by file name; release frees that one only', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted16-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'ws');
  const customerDir = path.join(workspace, 'state', 'relay-authority', 'reservations');
  const ownerAuthority = path.join(base, 'owner-authority');
  const saved = process.env.ANVIL_AUTHORITY_DIR;
  process.env.ANVIL_AUTHORITY_DIR = ownerAuthority;
  t.after(() => { if (saved === undefined) delete process.env.ANVIL_AUTHORITY_DIR; else process.env.ANVIL_AUTHORITY_DIR = saved; });
  const mine = reservation(customerDir, { owner: 'f'.repeat(32), environment: 'env.example.com', moduleKey: 'm1', root: path.join(base, 'other-root') });
  const owners = reservation(path.join(ownerAuthority, 'reservations'), { owner: 'e'.repeat(32), environment: 'env.example.com', moduleKey: 'm2' });

  const listed = hostedReservations({ workspace });
  assert.equal(listed.activeTotal, 1);
  assert.deepEqual(listed.active.map(r => r.file), [mine], 'the file name only, never the server folder');
  assert.ok(!JSON.stringify(listed).includes(base), 'no path of the server in the listing');

  const words = hostedRelease({ reservation: mine }, { context: { workspace } });
  assert.equal(words.code, 'WORDS_REQUIRED');
  const outside = hostedRelease({ reservation: path.join(ownerAuthority, 'reservations', owners), authorize: 'pode liberar' }, { context: { workspace } });
  assert.equal(outside.code, 'RESERVATION_NOT_FOUND', 'an owner reservation is not found through the customer');
  assert.equal(ownerOf(path.join(ownerAuthority, 'reservations', owners)), 'e'.repeat(32));

  const released = hostedRelease({ reservation: 'ws:' + mine, authorize: 'pode liberar o modulo m1' }, { context: { workspace } });
  assert.equal(released.ok, true);
  assert.equal(released.released, true);
  assert.equal(released.reservation, mine);
  assert.equal(ownerOf(path.join(customerDir, mine)), null);
  assert.equal(ownerOf(path.join(ownerAuthority, 'reservations', owners)), 'e'.repeat(32), 'the owner\'s reservation is untouched');
});

test('RELEASE_CHANGED names the server owner in hosted mode, the client restart locally', () => {
  assert.match(HOSTED_RESTART_NEXT, /dono do servidor/);
  assert.notEqual(HOSTED_RESTART_NEXT, RESTART_NEXT);
});
