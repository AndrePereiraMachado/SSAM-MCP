// DESIGN 3.2 and 7.2 "readers": partial last line across ticks, 8 MiB chunking, rename rotation inside the 2 s window,
// rotation to .gz (skip offset), two rotations while stopped, truncation, a lost rotated part, restart from checkpoint
// with no double count, cold start whose `listening` sits in a .gz, the local day of an audit line at 22:30, audit
// .jsonl -> .gz not counted twice, corrupt and over-long lines skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CHUNK_BYTES, createAccessAlertsReader, createAuditReader, createServerLogReader } from '../readers.mjs';
import { appendLines, clock, line, makeEnv, startConsole, tempDir, writeLines } from './helpers.mjs';
import { writeAudit } from './scenario.mjs';

const ev = (n, extra = {}) => ({ time: new Date(Date.UTC(2026, 9, 11, 12, 0, n)).toISOString(), event: 'mcp-response-flushed', n, ...extra });
function logReader(dir, opts = {}) {
  const seen = [];
  let losses = 0;
  const r = createServerLogReader({ dir, onRecord: e => seen.push(e.n ?? e.event), onLoss: () => { losses++; }, ...opts });
  return { r, seen, losses: () => losses };
}
const gzipFile = (from, to) => { fs.writeFileSync(to, zlib.gzipSync(fs.readFileSync(from))); fs.unlinkSync(from); };

test('server.log: a partial last line waits for the rest', async () => {
  const dir = tempDir('rd');
  const file = path.join(dir, 'server.log');
  const full = line(ev(1));
  fs.writeFileSync(file, full.slice(0, 20));
  const { r, seen } = logReader(dir);
  await r.tick();
  assert.deepEqual(seen, []);
  assert.equal(r.checkpoint().offset, 0);
  fs.appendFileSync(file, full.slice(20) + line(ev(2)));
  await r.tick();
  assert.deepEqual(seen, [1, 2]);
  assert.equal(r.checkpoint().offset, fs.statSync(file).size);
});

test('server.log: at most 8 MiB per tick', async () => {
  const dir = tempDir('rd');
  const file = path.join(dir, 'server.log');
  const pad = 'x'.repeat(200);
  const text = [];
  let size = 0, n = 0;
  while (size < CHUNK_BYTES + 512 * 1024) { const l = line(ev(n % 50, { n, pad })); text.push(l); size += Buffer.byteLength(l); n++; }
  fs.writeFileSync(file, text.join(''));
  const { r, seen } = logReader(dir);
  const caughtUp = await r.tick();
  assert.equal(caughtUp, false);
  assert.ok(seen.length > 0 && seen.length < n, `first tick read ${seen.length} of ${n}`);
  assert.ok(r.checkpoint().offset <= CHUNK_BYTES);
  assert.equal(await r.tick(), true);
  assert.equal(seen.length, n);
  assert.deepEqual(seen.slice(0, 3), [0, 1, 2]);
  assert.equal(new Set(seen).size, n);
});

test('server.log: rename rotation inside the 2 s window (same inode, then a new file)', async () => {
  const dir = tempDir('rd');
  const file = path.join(dir, 'server.log');
  writeLines(file, [ev(1)]);
  const { r, seen, losses } = logReader(dir);
  await r.tick();
  appendLines(file, [ev(2)]);
  fs.renameSync(file, path.join(dir, 'server.log.20261011T120010Z'));
  writeLines(file, [ev(3)]);
  await r.tick();
  assert.deepEqual(seen, [1, 2, 3]);
  // gzip of the rotated file 2 s later: a new inode with the same stamp, never read again
  gzipFile(path.join(dir, 'server.log.20261011T120010Z'), path.join(dir, 'server.log.20261011T120010Z.gz'));
  appendLines(file, [ev(4)]);
  await r.tick();
  await r.tick();
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(losses(), 0);
  assert.equal(r.checkpoint().lastRotatedStamp, '20261011T120010Z');
});

test('server.log: rotation already gzipped when seen (gunzip and skip the offset)', async () => {
  const dir = tempDir('rd');
  const file = path.join(dir, 'server.log');
  writeLines(file, [ev(1), ev(2)]);
  const { r, seen } = logReader(dir);
  await r.tick();
  appendLines(file, [ev(3)]);
  fs.renameSync(file, path.join(dir, 'server.log.20261011T120010Z'));
  gzipFile(path.join(dir, 'server.log.20261011T120010Z'), path.join(dir, 'server.log.20261011T120010Z.gz'));
  writeLines(file, [ev(4)]);
  await r.tick();
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

test('server.log: two rotations while the console was stopped', async () => {
  const dir = tempDir('rd');
  const file = path.join(dir, 'server.log');
  writeLines(file, [ev(1)]);
  const first = logReader(dir);
  await first.r.tick();
  const saved = first.r.checkpoint();
  appendLines(file, [ev(2)]);
  fs.renameSync(file, path.join(dir, 'server.log.20261011T130000Z'));
  gzipFile(path.join(dir, 'server.log.20261011T130000Z'), path.join(dir, 'server.log.20261011T130000Z.gz'));
  writeLines(file, [ev(3)]);
  fs.renameSync(file, path.join(dir, 'server.log.20261011T140000Z'));
  writeLines(file, [ev(4)]);
  const second = logReader(dir);
  second.r.restore(JSON.parse(JSON.stringify(saved)));
  await second.r.tick();
  assert.deepEqual(second.seen, [2, 3, 4]);
  assert.equal(second.r.checkpoint().lastRotatedStamp, '20261011T140000Z');
  assert.equal(second.losses(), 0);
});

test('server.log: truncation restarts at 0; a vanished rotated part is reported as a loss', async () => {
  const dir = tempDir('rd');
  const file = path.join(dir, 'server.log');
  writeLines(file, [ev(1), ev(2)]);
  const { r, seen, losses } = logReader(dir);
  await r.tick();
  fs.truncateSync(file, 0);
  appendLines(file, [ev(5)]);
  await r.tick();
  assert.deepEqual(seen, [1, 2, 5]);
  // the file is replaced (new inode) and no rotated file exists
  fs.unlinkSync(file);
  writeLines(file, [ev(6)]);
  await r.tick();
  assert.deepEqual(seen, [1, 2, 5, 6]);
  assert.equal(losses(), 1);
});

test('server.log: a rotation is found by its new stamp even when the new file got the old inode number back', async () => {
  const dir = tempDir('rd');
  const file = path.join(dir, 'server.log');
  writeLines(file, [ev(1)]);
  const first = logReader(dir);
  await first.r.tick();
  const saved = first.r.checkpoint();
  appendLines(file, [ev(2)]);
  fs.renameSync(file, path.join(dir, 'server.log.20261011T120010Z'));
  gzipFile(path.join(dir, 'server.log.20261011T120010Z'), path.join(dir, 'server.log.20261011T120010Z.gz'));
  writeLines(file, [ev(3), ev(4), ev(5)]);
  // ext4 reuses the freed inode number: simulate it by saving the new file's inode in the checkpoint
  const reused = { ...saved, ino: String(fs.statSync(file, { bigint: true }).ino) };
  const second = logReader(dir);
  second.r.restore(reused);
  await second.r.tick();
  assert.deepEqual(second.seen, [2, 3, 4, 5]);
  assert.equal(second.losses(), 0);
});

test('server.log: a file replaced in place with the same inode and size is found by its first bytes', async () => {
  const dir = tempDir('rd');
  const file = path.join(dir, 'server.log');
  writeLines(file, [ev(1)]);
  const first = logReader(dir);
  await first.r.tick();
  const saved = first.r.checkpoint();
  assert.ok(saved.head && saved.head.len > 0);
  fs.unlinkSync(file);
  writeLines(file, [ev(6)]);   // same length as the old line
  assert.equal(fs.statSync(file).size, saved.offset);
  const second = logReader(dir);
  second.r.restore({ ...saved, ino: String(fs.statSync(file, { bigint: true }).ino) });
  await second.r.tick();
  assert.deepEqual(second.seen, [6]);
  assert.equal(second.losses(), 1, 'no rotated file holds the old tail: reported as a loss');
});

test('server.log: corrupt and over-long lines are skipped and counted', async () => {
  const dir = tempDir('rd');
  const file = path.join(dir, 'server.log');
  fs.writeFileSync(file, 'garbage\n{"no":"time"}\n[1,2]\n{"time":"not a date","event":"x"}\n' + line(ev(1)) + '{"time":"2026-10-11T12:00:00Z","event":"x","pad":"' + 'y'.repeat(1024 * 1024 + 10) + '"}\n' + line(ev(2)));
  const { r, seen } = logReader(dir);
  await r.tick();
  assert.deepEqual(seen, [1, 2]);
  assert.equal(r.stats.skipped, 5);
});

test('audit: local day of a line at 22:30, .jsonl -> .gz not counted twice, complete keys never read again', async () => {
  const dir = tempDir('rd');
  const now = clock('2026-10-12T00:00:30Z');
  const seen = [];
  const r = createAuditReader({ dir, now, onRecord: l => seen.push(l.n) });
  writeAudit(dir, [{ time: '2026-10-11T20:00:00.000Z', n: 1 }, { time: '2026-10-12T00:00:10.000Z', n: 2 }]);
  fs.appendFileSync(path.join(dir, 'audit-20261011.jsonl'), '{"time":"2026-10-11T23:59:59.000Z","n":3'); // partial last line
  await r.tick();
  assert.deepEqual(seen, [1, 2]);
  assert.equal(r.checkpoint().files['20261011'].complete, false, 'not complete within 60 s of the UTC midnight');
  // the line is finished, then rotate-logs.sh gzips the past UTC day: only the rest of the file is read
  fs.appendFileSync(path.join(dir, 'audit-20261011.jsonl'), '}\n');
  gzipFile(path.join(dir, 'audit-20261011.jsonl'), path.join(dir, 'audit-20261011.jsonl.gz'));
  now.set('2026-10-12T04:15:00Z');
  await r.tick();
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(r.checkpoint().files['20261011'].complete, true);
  await r.tick();
  assert.deepEqual(seen, [1, 2, 3]);
  // a restarted reader with the checkpoint does not read the complete key again
  const again = [];
  const r2 = createAuditReader({ dir, now, onRecord: l => again.push(l.n) });
  r2.restore(JSON.parse(JSON.stringify(r.checkpoint())));
  await r2.tick();
  assert.deepEqual(again, []);
});

test('audit: a past day read to its end 60 s after the UTC midnight is marked complete', async () => {
  const dir = tempDir('rd');
  const now = clock('2026-10-12T00:00:30Z');
  const r = createAuditReader({ dir, now, onRecord: () => {} });
  writeAudit(dir, [{ time: '2026-10-11T23:59:59.000Z' }]);
  await r.tick();
  assert.equal(r.checkpoint().files['20261011'].complete, false);
  now.set('2026-10-12T00:01:00Z');
  await r.tick();
  assert.equal(r.checkpoint().files['20261011'].complete, true);
});

test('access-alerts: incremental, a replaced file is read again from the start', async () => {
  const dir = tempDir('rd');
  const file = path.join(dir, 'access-alerts.jsonl');
  const seen = [];
  let resets = 0;
  const r = createAccessAlertsReader({ dir, onRecord: l => seen.push(l.n), onReset: () => { resets++; } });
  assert.equal(await r.tick(), true, 'absent file is fine');
  writeLines(file, [{ time: '2026-10-11T10:00:00Z', n: 1 }]);
  await r.tick();
  appendLines(file, [{ time: '2026-10-11T10:01:00Z', n: 2 }]);
  await r.tick();
  fs.unlinkSync(file);
  writeLines(file, [{ time: '2026-10-11T10:02:00Z', n: 3 }]);
  await r.tick();
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(resets, 1);
});

test('console: restart from the checkpoint counts nothing twice; rotation while stopped keeps the open session', async t => {
  const open = new Set();
  t.after(async () => { for (const x of open) await x.close(); });
  const startC = async e => { const x = await startConsole(e); open.add(x); x.closeOnce = async () => { open.delete(x); await x.close(); }; return x; };
  const env = makeEnv();
  const t0 = Date.now();
  const at = s => new Date(t0 - s * 1000).toISOString();
  const log = path.join(env.serverDir, 'server.log');
  const tok = 'tok_0000000a1fa0';
  writeLines(log, [
    { time: at(600), event: 'listening', mode: 'hosted', pid: 7, publicHosts: ['ssam.example.com'] },
    { time: at(500), event: 'session-opened', session: 's-1', token: tok, customer: 'Cliente Alfa', ip: '192.0.2.1', client: 'c 1' },
  ]);
  writeAudit(env.serverDir, [{ time: at(400), token: tok, customer: 'Cliente Alfa', tool: 'ssam_doctor', ms: 50, ok: true }]);
  let c = await startC(env);
  assert.equal(c.app.cold, true);
  let u = (await c.get('/api/usage?range=7d')).body;
  assert.equal(u.totals.calls, 1);
  assert.equal(u.totals.sessionsOpened, 1);
  await c.closeOnce();
  // while stopped: more lines, a rotation of server.log, another audit line
  appendLines(log, [{ time: at(300), event: 'mcp-response-flushed', session: 's-1', token: tok, tools: ['ssam_doctor'], bytes: 10 }]);
  fs.renameSync(log, path.join(env.serverDir, 'server.log.20261011T120000Z'));
  gzipFile(path.join(env.serverDir, 'server.log.20261011T120000Z'), path.join(env.serverDir, 'server.log.20261011T120000Z.gz'));
  writeLines(log, [{ time: at(200), event: 'session-opened', session: 's-2', token: tok, ip: '192.0.2.1', client: 'c 2' }]);
  writeAudit(env.serverDir, [{ time: at(100), token: tok, tool: 'ssam_doctor', ms: 70, ok: false, error: 'AGENT_NOT_CONNECTED' }]);
  c = await startC(env);
  assert.equal(c.app.cold, false, 'resumed from the checkpoint');
  await c.app.tickAll();
  u = (await c.get('/api/usage?range=7d')).body;
  assert.equal(u.totals.calls, 2);
  assert.equal(u.totals.failures, 1);
  assert.equal(u.totals.sessionsOpened, 2);
  const live = (await c.get('/api/live')).body;
  assert.deepEqual(live.sessions.map(s => s.session).sort(), ['s-1', 's-2']);
  assert.equal(live.sessions.find(s => s.session === 's-1').calls, 1);
  const events = (await c.get('/api/events?limit=500')).body.events;
  assert.equal(events.filter(e => e.text.startsWith('Servidor iniciado')).length, 1, 'no event replayed twice');
  await c.closeOnce();
  // a third start with nothing new changes nothing
  c = await startC(env);
  await c.app.tickAll();
  assert.equal((await c.get('/api/usage?range=7d')).body.totals.calls, 2);
  await c.closeOnce();
  // deleting /state/agg triggers a full rebuild with the same counts
  fs.rmSync(path.join(env.stateDir, 'agg'), { recursive: true });
  c = await startC(env);
  assert.equal(c.app.cold, true);
  u = (await c.get('/api/usage?range=7d')).body;
  assert.equal(u.totals.calls, 2);
  assert.equal(u.totals.sessionsOpened, 2);
  await c.closeOnce();
});

test('console: cold start whose listening line sits in a rotated .gz', async t => {
  const env = makeEnv();
  const t0 = Date.now();
  const at = s => new Date(t0 - s * 1000).toISOString();
  const tok = 'tok_0000000b2fb0';
  const old = path.join(env.serverDir, 'server.log.20261010T040000Z');
  writeLines(old, [
    { time: at(9000), event: 'listening', mode: 'hosted', pid: 3, publicHosts: ['old.example.com'] },
    { time: at(8500), event: 'session-opened', session: 's-old', token: tok, ip: '192.0.2.1' },
  ]);
  gzipFile(old, old + '.gz');
  const mid = path.join(env.serverDir, 'server.log.20261011T040000Z');
  writeLines(mid, [
    { time: at(8000), event: 'listening', mode: 'hosted', pid: 7, publicHosts: ['ssam.example.com'] },
    { time: at(7000), event: 'session-opened', session: 's-live', token: tok, ip: '192.0.2.2' },
    { time: at(6900), event: 'agent-connected', token: tok, agent: '0.2.0', ip: '192.0.2.2', machine: null, o11: null },
  ]);
  gzipFile(mid, mid + '.gz');
  writeLines(path.join(env.serverDir, 'server.log'), [{ time: at(100), event: 'mcp-response-flushed', session: 's-live', token: tok, tools: ['odc_read'], bytes: 5 }]);
  const c = await startConsole(env);
  t.after(() => c.close());
  const live = (await c.get('/api/live')).body;
  assert.equal(live.server.pid, 7);
  assert.deepEqual(live.server.publicHosts, ['ssam.example.com']);
  assert.deepEqual(live.sessions.map(s => s.session), ['s-live']);
  assert.equal(live.sessions[0].calls, 1);
  assert.equal(live.agents[0].state, 'connected');
  assert.equal(c.app.parts.serverLog.checkpoint().lastRotatedStamp, '20261011T040000Z');
  const meta = (await c.get('/api/meta')).body;
  assert.equal(meta.indexing.state, 'ready');
  assert.equal(meta.publicUrl, 'https://ssam.example.com/mcp');

});
