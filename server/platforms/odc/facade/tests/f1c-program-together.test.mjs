// F1c (owner 2026-11-02, "o ssam deve permitir que o usuario programe junto com ele"), the facade half of review items A4 and
// A5 of REVISAO-F1: on the hosted server (Linux) the kernel's run lease is an advisory flock, so a running not-sent task is
// never taken for ended (the reservation waits for it, the doctor never advises closing it); and what a closed refused task
// left in the module reaches the next delivery's answer by element. Temporary folders only; no Studio, no kernel.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as lineage from '../delivery-lineage.mjs';
import * as cycle from '../o11-cycle.mjs';

const folder = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1c-together-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const held = () => ({ status: 1 });
const free = () => ({ status: 0 });
const missing = () => ({ status: null, error: Object.assign(new Error('spawnSync flock ENOENT'), { code: 'ENOENT' }) });

test('A5: off Windows the run lease is tried as the flock .NET holds, never claimed free by a plain open', t => {
  const work = folder(t);
  const task = { writeState: 'not-sent', work };
  // A running task (its kernel holds run.lock): not free, so not ended, and the reservation waits for it.
  assert.equal(lineage.runLeaseFree(task, { platform: 'linux', flock: held }), false);
  assert.equal(lineage.holderEnded(task, { platform: 'linux', flock: held }), false);
  // No flock to try the lock with: never claimed free.
  assert.equal(lineage.runLeaseFree(task, { platform: 'linux', flock: missing }), false);
  assert.equal(lineage.runLeaseFree(task, { platform: 'linux', flock: () => { throw new Error('spawn failed'); } }), false);
  // A lease no process holds: free, the next delivery closes that task (2a).
  assert.equal(lineage.runLeaseFree(task, { platform: 'linux', flock: free }), true);
  assert.equal(lineage.holderEnded(task, { platform: 'linux', flock: free }), true);
  // The flock is tried on the task's own run.lock.
  let tried = null;
  lineage.runLeaseFree(task, { platform: 'linux', flock: file => { tried = file; return free(); } });
  assert.equal(tried, path.join(work, 'run.lock'));
});

test('A5: with flock installed (Linux), a lease another process holds is not free', { skip: process.platform === 'win32' || spawnSync('flock', ['--version']).status !== 0 }, async t => {
  const work = folder(t);
  const lock = path.join(work, 'run.lock');
  // -o: flock itself holds the lock and its command does not inherit it, so killing the holder frees the lease (without -o the
  // orphaned sleep kept the lock, F6 run inside the image).
  const holder = spawn('flock', ['-o', lock, 'sleep', '5'], { stdio: 'ignore' });
  t.after(() => holder.kill());
  await new Promise(r => setTimeout(r, 400));
  assert.equal(lineage.runLeaseFree({ work }), false);
  holder.kill(); await new Promise(r => holder.once('exit', r));
  assert.equal(lineage.runLeaseFree({ work }), true);
});

test('A4: what a closed refused task left in the module reaches the answer by element', () => {
  const fields = cycle.deliveryFields({ previousClosed: { taskId: 'c150ccf09d37423eaaedbb8f91daafac', was: 'refused',
    note: 'task c150 had ended refused and still held this module: it was closed; 1 TrueChange error(s) that task\'s merge left in the module are in this delivery\'s base and are not new for it (OS-ELG-000 at FirstTry (ServerAction))',
    inherited: { newErrors: 1, errors: ['OS-ELG-000 at FirstTry (ServerAction)'], differences: 2, elements: ['ServerAction:Refused', 'ServerAction:Refused/OutputParameter:Out'] } } });
  assert.equal(fields.previousClosed?.taskId, 'c150ccf09d37423eaaedbb8f91daafac');
  assert.deepEqual(fields.previousClosed?.inherited, { newErrors: 1, errors: ['OS-ELG-000 at FirstTry (ServerAction)'], differences: 2,
    elements: ['ServerAction:Refused', 'ServerAction:Refused/OutputParameter:Out'] });
  assert.match(fields.previousClosed?.note ?? '', /not new for it \(OS-ELG-000 at FirstTry/);
});
