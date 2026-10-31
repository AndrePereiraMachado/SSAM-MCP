// The bridge-hang family on the real bridge DLL, over the real pipe, in a process of its own: no Studio, nothing attached
// (studio/bridge/host/Program.cs loads the DLL and runs its startup hook; the Studio's folder is only read). The chain of the
// incidents of 2026-10-22 and 2026-10-30: a command outlives its deadline, its client left, the bridge answers onto a closed
// pipe, and what happens to the next call. A UI that does not answer stands for the tab that never became idle.
//
//   BRIDGE_ISOLATED_DLL=<bin\Release\net10.0\ODC3.Bridge.v101.dll> [BRIDGE_ISOLATED_HOST=<ODC3.Bridge.IsolatedHost.dll>] node --test bridge-isolated.test.mjs
//
// BRIDGE_ISOLATED_REAL=1 adds the real case at its real times: a merge cut by its client at 600 s, answered at 900 s (about 16 min).
// Without BRIDGE_ISOLATED_DLL the tests are skipped: they need the bridge compiled against an ODC Studio.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { pipeCall, pipeName } from '../odc-pipe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DLL = process.env.BRIDGE_ISOLATED_DLL;
const HOST = process.env.BRIDGE_ISOLATED_HOST ?? path.join(HERE, '..', '..', 'studio', 'bridge', 'host', 'bin', 'Release', 'net10.0', 'ODC3.Bridge.IsolatedHost.dll');
const STUDIO = process.env.BRIDGE_ISOLATED_STUDIO ?? 'C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio';
const skip = !DLL && 'BRIDGE_ISOLATED_DLL names the compiled bridge';
const VERSION = /ODC3\.Bridge\.(v\d+)\.dll$/.exec(DLL ?? '')?.[1] ?? 'v101';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startHost(t, ...options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-isolated-'));
  const child = spawn('dotnet', [HOST, DLL, STUDIO, ...options], { env: { ...process.env, SSAM_HYBRID_ODC_ROOT: root, ODC3_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let errors = ''; child.stderr.on('data', d => { errors += d; });
  const lines = createInterface({ input: child.stdout });
  const first = await new Promise((resolve, reject) => {
    lines.once('line', resolve); child.once('exit', code => reject(new Error('the host ended: ' + code + ' ' + errors)));
  });
  child.removeAllListeners('exit');
  t.after(() => { child.stdin.end(); child.kill(); try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch { /* the temporary folder */ } });
  const { pid } = JSON.parse(first);
  // The pipe is there as soon as the hook's task reaches it.
  for (let i = 0; i < 100; i++) { try { await pipeCall(pid, VERSION, ['no-such-command'], { connectMs: 200, timeoutMs: 5000 }); break; } catch (error) { if (i === 99) throw error; await sleep(100); } }
  return { pid, root, errors: () => errors };
}
// What a client past its own deadline does: sends the command and leaves.
function sendAndLeave(pid, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipeName(VERSION, pid));
    socket.once('error', reject);
    socket.on('connect', () => socket.write(command + '\n', 'utf8', () => setTimeout(() => { socket.destroy(); resolve(); }, 300)));
  });
}
const call = async (pid, command, options = {}) => JSON.parse(await pipeCall(pid, VERSION, command.split(' '), { connectMs: 5000, timeoutMs: 30000, ...options }));
const journal = root => { try { return fs.readdirSync(path.join(root, 'journal')); } catch { return []; } };

test('a closed pipe during the answer never ends the server: the next call is served', { skip, timeout: 170000 }, async t => {
  const { pid, root } = await startHost(t, '--ui-after', '62');
  await sendAndLeave(pid, 'snapshot Fixture'); // deadline 60 s; the UI comes back at 62 s
  await sleep(75000);
  const next = await call(pid, 'no-such-command');
  assert.equal(next.ok, false);
  assert.match(next.error, /^Commands: /, 'the bridge answered the next command');
  assert.ok(journal(root).some(f => /^bridge-server-error-/.test(f) && /Pipe is broken|pipe has been ended|closed/i.test(fs.readFileSync(path.join(root, 'journal', f), 'utf8'))), 'the lost client is recorded');
});

test('a command past its deadline answers uncertain even when the UI never comes back, and the next call is answered at once', { skip, timeout: 170000 }, async t => {
  const { pid } = await startHost(t);
  const started = Date.now();
  const late = await call(pid, 'snapshot Fixture', { timeoutMs: 90000 }); // deadline 60 s
  assert.equal(late.outcome, 'uncertain');
  assert.equal(late.gate, 'studio_busy');
  assert.ok(Date.now() - started < 80000, 'answered near its deadline');
  // The snapshot still holds the turn: the next command is refused by the bridge itself, naming it; status answers beside it.
  const before = Date.now();
  await assert.rejects(pipeCall(pid, VERSION, ['snapshot', 'Other'], { connectMs: 1000, timeoutMs: 30000 }), error => {
    assert.equal(error.code, 'BRIDGE_BUSY'); assert.equal(error.sent, false); assert.equal(error.busy?.command, 'snapshot');
    assert.equal(error.busy?.overran, true);
    assert.match(error.message, /only restarting ODC Studio ends it/);
    return true;
  });
  assert.ok(Date.now() - before < 15000, 'refused within the turn wait');
  await assert.rejects(pipeCall(pid, VERSION, ['status', 'brief'], { connectMs: 1000, timeoutMs: 30000 }), error => error.code === 'BRIDGE_BUSY' && error.sent === false, 'a held UI: the bridge answers for itself');
  // The bootstrap of the agent never waits for the running command.
  const root = await call(pid, 'agent-root {"root":"relative"}', { timeoutMs: 5000 });
  assert.equal(root.ok, false);
});

test('a job on a tab that never becomes idle is abandoned at its bound, says so, and never runs later', { skip, timeout: 170000 }, async t => {
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-isolated-queue-'));
  t.after(() => fs.rmSync(evidence, { recursive: true, force: true }));
  const child = spawn('dotnet', [HOST, DLL, STUDIO, '--queue-probe', evidence], { env: { ...process.env, SSAM_HYBRID_ODC_ROOT: evidence, ODC3_ROOT: evidence }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  t.after(() => child.kill());
  const answer = await new Promise((resolve, reject) => { createInterface({ input: child.stdout }).once('line', resolve); child.once('error', reject); });
  const result = JSON.parse(answer);
  assert.equal(result.absent, undefined, result.absent);
  assert.match(result.refusal, /^MERGE_NOT_STARTED:/);
  assert.ok(result.seconds >= 119 && result.seconds < 140, 'at the bound of the table: ' + result.seconds);
  assert.equal(result.ranLate, false, 'an abandoned job never runs');
  assert.equal(result.notStarted, true, 'not-started.json is in the evidence');
});

test('the real case: a merge held past the agent\'s 600 s and the bridge\'s 900 s; the answer lands on a closed pipe and the next call is served', { skip: skip || (!process.env.BRIDGE_ISOLATED_REAL && 'BRIDGE_ISOLATED_REAL takes 16 min'), timeout: 1100000 }, async t => {
  const { pid, root } = await startHost(t, '--ui-after', '905');
  const evidence = path.join(root, 'lab', 'evidence');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  const manifest = path.join(root, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', module: 'Fixture', moduleKey: 'K', tenant: 't', author: 'a', basePath: 'b.oml', baseSha256: 'B', candidatePath: 'c.oml', candidateSha256: 'C', evidenceDir: evidence }));
  const began = Date.now(), seconds = () => Math.round((Date.now() - began) / 1000);
  const marks = [];
  const merge = pipeCall(pid, VERSION, ['merge', manifest], { connectMs: 5000, timeoutMs: 600000 }).then(() => null, error => error);
  // Meanwhile, the pipe answers: what a session sees for the whole wait. Checked at the end, so the whole chain always runs.
  const during = [];
  for (const at of [30, 300, 590]) {
    await sleep(Math.max(0, at * 1000 - (Date.now() - began)));
    const busy = await pipeCall(pid, VERSION, ['snapshot', 'Other'], { connectMs: 1000, timeoutMs: 30000 }).then(() => null, error => error);
    during.push(busy);
    marks.push({ at: seconds(), code: busy?.code, command: busy?.busy?.command, module: busy?.busy?.module });
  }
  const cut = await merge;
  assert.equal(cut?.code, 'PIPE_REPLY_TIMEOUT', 'the client gave up at its 600 s');
  marks.push({ at: seconds(), code: cut.code });
  await sleep(Math.max(0, 925000 - (Date.now() - began)));
  const next = await call(pid, 'no-such-command').catch(error => ({ lost: error.code + ': ' + error.message }));
  marks.push({ at: seconds(), next: next.lost ?? next.error?.slice(0, 40) });
  t.diagnostic(JSON.stringify(marks));
  try { t.diagnostic(fs.readdirSync(path.join(root, 'journal')).filter(f => f.startsWith('bridge-server-error')).map(f => f + ': ' + fs.readFileSync(path.join(root, 'journal', f), 'utf8').split('\n')[0]).join(' | ')); } catch { /* a note */ }
  assert.match(next.error ?? next.lost, /^Commands: /, 'the bridge answered the next command');
  for (const busy of during) { assert.equal(busy?.code, 'BRIDGE_BUSY', busy?.message); assert.equal(busy?.busy?.command, 'merge'); assert.equal(busy?.busy?.module, 'Fixture'); }
  const undelivered = JSON.parse(fs.readFileSync(path.join(evidence, 'undelivered-answer.json'), 'utf8'));
  assert.equal(undelivered.answer.code, 'MERGE_TIMEOUT');
  assert.equal(undelivered.answer.outcome, 'uncertain');
  assert.equal(undelivered.answer.deadlineSeconds, 900);
  const lines = fs.readFileSync(path.join(root, 'journal', 'operations.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(lines.some(l => l.command === 'merge-undelivered'), 'the lost answer is in the journal');
});
