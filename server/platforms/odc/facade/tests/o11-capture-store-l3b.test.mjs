// L3b: the capture store answers what a delivery recorded (the delivered capture is the module now) and the newest known
// capture of each module, for the startup warm-up. Temporary folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rememberDelivery, rememberCapture, recentCaptures, modelSha256 } from '../o11-capture-store.mjs';

const tmp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-l3b-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const oml = (dir, name, body) => { const file = path.join(dir, name); const header = Buffer.from('{"w":1}'); const size = Buffer.alloc(4); size.writeUInt32LE(header.length);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('OML'), size, header, Buffer.from(body)])); return file; };

test('L3b rememberDelivery answers the base and the delivered capture it recorded, with their models', t => {
  const dir = tmp(t), local = path.join(dir, 'local');
  const base = oml(dir, 'base.oml', 'module before'), delivered = oml(dir, 'delivered.oml', 'module after');
  const recorded = rememberDelivery(local, { moduleKey: 'k1', module: 'M', snapshot: { path: base, key: 'k1' }, deliveredSnapshot: { path: delivered, key: 'k1' } }, { now: new Date('2026-10-24T10:00:00Z') });
  assert.deepEqual(recorded, { base: { path: path.resolve(base), model: modelSha256(base), moduleKey: 'k1' }, delivered: { path: path.resolve(delivered), model: modelSha256(delivered), moduleKey: 'k1' } });
  // no delivered snapshot (nothing merged, or an older kernel): only the base
  assert.deepEqual(rememberDelivery(local, { moduleKey: 'k1', snapshot: { path: base } }).delivered, null);
  // another module's snapshot, a missing file, no state: nothing recorded, never a throw
  assert.deepEqual(rememberDelivery(local, { moduleKey: 'k1', deliveredSnapshot: { path: delivered, key: 'other' } }), { base: null, delivered: null });
  assert.deepEqual(rememberDelivery(local, { moduleKey: 'k1', deliveredSnapshot: { path: path.join(dir, 'gone.oml') } }), { base: null, delivered: null });
  assert.deepEqual(rememberDelivery(local, null), { base: null, delivered: null });
});

test('L3b recentCaptures: the newest capture of each module, newest module first, at most the limit, files that exist', t => {
  const dir = tmp(t), local = path.join(dir, 'local');
  const at = minute => new Date(Date.UTC(2026, 9, 24, 10, minute));
  const a1 = oml(dir, 'a1.oml', 'a v1'), a2 = oml(dir, 'a2.oml', 'a v2'), b = oml(dir, 'b.oml', 'b'), c = oml(dir, 'c.oml', 'c'), d = oml(dir, 'd.oml', 'd');
  rememberCapture(local, { moduleKey: 'A', module: 'Alpha', file: a1, now: at(1) });
  rememberCapture(local, { moduleKey: 'B', module: 'Beta', file: b, now: at(2) });
  rememberCapture(local, { moduleKey: 'A', module: 'Alpha', file: a2, now: at(3) });
  rememberCapture(local, { moduleKey: 'C', module: 'Gamma', file: c, now: at(4) });
  rememberCapture(local, { moduleKey: 'D', module: 'Delta', file: d, now: at(5) });
  fs.rmSync(d);   // its file is gone: never offered
  const rows = recentCaptures(local);
  assert.deepEqual(rows.map(r => [r.moduleKey, path.basename(r.path)]), [['C', 'c.oml'], ['A', 'a2.oml'], ['B', 'b.oml']]);
  assert.equal(rows[1].model, modelSha256(a2));
  assert.equal(recentCaptures(local, { limit: 1 }).length, 1);
  // the open tabs narrow and order it
  assert.deepEqual(recentCaptures(local, { moduleKeys: ['B', 'X', 'A'] }).map(r => r.moduleKey), ['B', 'A']);
  assert.deepEqual(recentCaptures(path.join(dir, 'nothing')), []);
  assert.deepEqual(recentCaptures(null), []);
});
