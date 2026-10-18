// UI freeze of 2026-10-08, pattern 5: after a Studio restart a ServiceStudio.exe without a window stayed and held the lane.
// connect and doctor now say precisely what it is: a Studio still opening (STUDIO_STARTING: wait, connect again) or an
// orphan (STUDIO_WINDOWLESS) named by pid, start time and whether it holds the lane port, with the exact next step for the
// person. SSAM never starts a Studio, so it never ends one either. Fake process lists only; no process is touched.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStudioProcesses, studioProcessScript } from '../lanes.mjs';
import { chooseStudio, classifyO11, connectAll, windowlessFacts, STUDIO_WINDOWLESS, STUDIO_STARTING } from '../studio-connect.mjs';
import { doctorO11 } from '../ssam.mjs';

const NOW = Date.parse('2026-10-08T15:20:00Z');
const ORPHAN = { pid: 33652, path: 'C:\\SS\\ServiceStudio.exe', window: false, startedAt: '2026-10-08T03:33:53.000Z' };
const STARTING = { pid: 71788, path: 'C:\\SS\\ServiceStudio.exe', window: false, startedAt: new Date(Date.now() - 20000).toISOString() };
const WINDOWED = { pid: 202, path: 'C:\\SS\\ServiceStudio.exe', window: true, startedAt: '2026-10-08T15:00:00.000Z' };

test('the process list carries the start time (system information only, never sent to the process)', () => {
  assert.deepEqual(parseStudioProcesses(JSON.stringify([{ ProcessId: 33652, ExecutablePath: 'C:\\a.exe', MainWindowHandle: 0, MainWindowTitle: '', Titles: null, StartedAt: '2026-10-08T03:33:53.0000000Z' }])),
    [{ pid: 33652, path: 'C:\\a.exe', window: false, startedAt: '2026-10-08T03:33:53.0000000Z' }]);
  assert.deepEqual(parseStudioProcesses(JSON.stringify({ ProcessId: 5, ExecutablePath: null, MainWindowHandle: 3, MainWindowTitle: 'x', StartedAt: null })), [{ pid: 5, path: null, window: true }]);
  const script = studioProcessScript('ServiceStudio.exe');
  assert.match(script, /CreationDate/);
  assert.doesNotMatch(script, /Stop-Process|CloseMainWindow|SendMessage|PostMessage|\.Kill\(|taskkill/i);
});

test('an orphan is named exactly (pid, start time, the lane port it holds) with the step for the person; a young one is still opening', () => {
  const orphan = windowlessFacts(ORPHAN, { now: NOW, heldPid: 33652 });
  assert.equal(orphan.code, STUDIO_WINDOWLESS); assert.equal(orphan.state, 'orphan'); assert.equal(orphan.holdsLanePort, true);
  assert.match(orphan.next, /PID 33652/); assert.match(orphan.next, /03:33Z/); assert.match(orphan.next, /Task Manager/);
  assert.match(orphan.next, /holds the port of the O11 lane/); assert.match(orphan.next, /never ends/);
  const young = windowlessFacts({ ...ORPHAN, startedAt: new Date(NOW - 30000).toISOString() }, { now: NOW });
  assert.equal(young.code, STUDIO_STARTING); assert.equal(young.state, 'starting'); assert.match(young.next, /is still opening/);
  const unknown = windowlessFacts({ pid: 9, window: false }, { now: NOW });
  assert.equal(unknown.state, 'orphan', 'without a start time it is reported as the windowless process it is');
});

test('connect never picks a windowless Studio; only Studios still opening answer STUDIO_STARTING, an orphan names its pid', () => {
  assert.throws(() => chooseStudio([STARTING]), e => e.code === STUDIO_STARTING && /71788/.test(e.message));
  assert.throws(() => chooseStudio([ORPHAN]), e => /STUDIO_WINDOWLESS: 33652 ignored/.test(e.message) && /PID 33652/.test(e.message));
  assert.equal(chooseStudio([ORPHAN, WINDOWED]).pid, 202);
  assert.throws(() => chooseStudio([ORPHAN, WINDOWED], 33652), e => e.code === STUDIO_WINDOWLESS && /PID 33652/.test(e.message));
  const studio = classifyO11([ORPHAN, WINDOWED], { connected: true, pid: 33652 });
  assert.equal(studio.connected, false);
  assert.equal(studio.windowless[0].holdsLanePort, true);
});

test('ssam_connect: the orphan that holds the port is refused with its pid and the exact next step; nothing is attached or touched', async () => {
  const connected = [];
  const o11 = { processes: async () => [ORPHAN, WINDOWED], probe: async () => ({ connected: true, pid: 33652 }), record: () => ({ pid: 33652 }),
    connect: async pid => { connected.push(pid); }, session: async () => ({}) };
  const value = await connectAll({ lane: 'o11' }, { served: ['o11'], o11 });
  assert.equal(value.ok, false);
  const ghost = value.studios.find(s => s.pid === 33652);
  assert.equal(ghost.state, 'orphan'); assert.equal(ghost.holdsLanePort, true); assert.match(ghost.next, /PID 33652/);
  const target = value.studios.find(s => s.pid === 202);
  assert.equal(target.code, STUDIO_WINDOWLESS); assert.match(target.error, /PID 33652/);
  assert.deepEqual(connected, []);
});

test('ssam_doctor: the continuation names the orphan pid and what to do', async () => {
  const report = await doctorO11({ processes: async () => [ORPHAN, WINDOWED], facts: async () => ({ bridge: 4516 }), cliBuilt: true,
    probe: async () => ({ connected: true, pid: 33652 }), record: () => ({ pid: 202 }),
    reservations: { env: { ANVIL_AUTHORITY_DIR: 'C:\\nowhere-ui-freeze' }, readUserEnvironment: () => null } });
  assert.equal(report.ok, false);
  assert.equal(report.continuation.tool, 'ssam_connect');
  assert.match(report.continuation.why, /33652/); assert.match(report.continuation.why, /PID 33652/);
});
