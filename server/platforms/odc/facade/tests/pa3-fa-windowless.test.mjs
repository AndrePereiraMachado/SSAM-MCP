// Atritos 3, lane fa, D5: a Service Studio without a main window never holds the O11 lane. Session of 2026-10-06 22:58Z:
// the user closed the Studio, the hidden Service Center window of SSAM kept the process alive, connect and doctor chose it
// and the sign-in failed with "the Studio has no window". The process list says which Studio has a window (system
// information only), connect never selects a windowless one, the record that names one is stale and the doctor lists it
// with the fix. Fake process lists and bridges only; no Studio is touched.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowState, parseStudioProcesses, studioProcessScript } from '../lanes.mjs';
import { chooseStudio, classifyO11, connectAll, STUDIO_WINDOWLESS } from '../studio-connect.mjs';
import { staleConnection } from '../studio-session.mjs';
import { doctor, doctorO11 } from '../ssam.mjs';

const WINDOWLESS = { pid: 101, path: 'C:\\SS\\ServiceStudio.exe', window: false };
const WINDOWED = { pid: 202, path: 'C:\\SS\\ServiceStudio.exe', window: true };

test('D5: the process list says whether each Studio still has a main window', () => {
  assert.equal(windowState({ MainWindowHandle: 0, MainWindowTitle: '' }), false, 'no visible top-level window');
  assert.equal(windowState({ MainWindowHandle: 4242, MainWindowTitle: 'Service Studio 11 - Shop' }), true);
  // The only window is SSAM's hidden Service Center window: listed, and SSAM windows only means windowless.
  assert.equal(windowState({ MainWindowHandle: 77, MainWindowTitle: 'Service Center - h.test (SSAM)', Titles: ['Service Center - h.test (SSAM)'] }), false);
  assert.equal(windowState({ MainWindowHandle: 77, MainWindowTitle: 'Service Center - h.test (SSAM)', Titles: ['Service Center - h.test (SSAM)', 'Service Studio 11 - Shop'] }), true);
  assert.equal(windowState({ MainWindowHandle: 77, MainWindowTitle: 'Service Center - h.test (SSAM)' }), null, 'unknown without the list');
  assert.deepEqual(parseStudioProcesses(JSON.stringify([{ ProcessId: 101, ExecutablePath: 'C:\\a.exe', MainWindowHandle: 0, MainWindowTitle: '', Titles: null },
    { ProcessId: 202, ExecutablePath: 'C:\\a.exe', MainWindowHandle: 9, MainWindowTitle: 'Service Studio', Titles: null }])),
  [{ pid: 101, path: 'C:\\a.exe', window: false }, { pid: 202, path: 'C:\\a.exe', window: true }]);
  assert.deepEqual(parseStudioProcesses(JSON.stringify({ ProcessId: 5, ExecutablePath: null, MainWindowHandle: 3, MainWindowTitle: 'x' })), [{ pid: 5, path: null, window: true }]);
  assert.deepEqual(parseStudioProcesses(''), []);
  // Read only: process facts and the window list of the system; nothing is sent to the process.
  const script = studioProcessScript('ServiceStudio.exe');
  assert.match(script, /Get-Process -Id/); assert.match(script, /EnumWindows/);
  assert.doesNotMatch(script, /Stop-Process|CloseMainWindow|SendMessage|PostMessage|\.Kill\(/);
});

test('D5: connect never selects a windowless Studio; asking for it by pid is STUDIO_WINDOWLESS', () => {
  assert.equal(chooseStudio([WINDOWLESS, WINDOWED]).pid, 202);
  assert.throws(() => chooseStudio([WINDOWLESS, WINDOWED], 101), error => error.code === STUDIO_WINDOWLESS && /101/.test(error.message) && /ignores this process/.test(error.message));
  assert.throws(() => chooseStudio([WINDOWLESS]), /No matching Studio is open with a window \(STUDIO_WINDOWLESS: 101 ignored\)/);
  const studio = classifyO11([WINDOWLESS, WINDOWED], { connected: true, pid: 101 });
  assert.equal(studio.connected, false, 'a bridge in a windowless Studio does not connect the lane');
  assert.deepEqual(studio.laneHeldBy, { pid: 101, code: STUDIO_WINDOWLESS });
  assert.deepEqual(studio.windowless.map(w => w.pid), [101]);
  assert.equal(classifyO11([WINDOWLESS, WINDOWED], { connected: true, pid: 202 }).connected, true);
  assert.deepEqual(staleConnection({ pid: 101 }, [WINDOWLESS, WINDOWED]), { pid: 101, reason: 'windowless', code: STUDIO_WINDOWLESS });
  assert.deepEqual(staleConnection({ pid: 303 }, [WINDOWLESS, WINDOWED]), { pid: 303, reason: 'gone' });
  assert.equal(staleConnection({ pid: 202 }, [WINDOWLESS, WINDOWED]), null);
});

test('D5: ssam_connect lists the windowless Studio, attaches the one with a window, and names the windowless one that holds the port', async () => {
  const side = probe => ({ processes: async () => [WINDOWLESS, WINDOWED], probe: async () => probe, record: () => ({ pid: probe.pid }),
    connect: async pid => { side.connected.push(pid); }, session: async () => ({ tenant: 'h.test', account: 'ana' }) });
  side.connected = [];
  const served = await connectAll({ lane: 'o11' }, { served: ['o11'], o11: side({ connected: true, pid: 202 }) });
  assert.equal(served.ok, true, JSON.stringify(served));
  const [ghost, studio] = served.studios;
  assert.deepEqual([ghost.pid, ghost.windowless, ghost.target, ghost.attached, ghost.code], [101, true, false, false, STUDIO_WINDOWLESS]);
  assert.deepEqual([studio.pid, studio.target, studio.attached], [202, true, true]);
  const held = await connectAll({ lane: 'o11' }, { served: ['o11'], o11: side({ connected: true, pid: 101 }) });
  assert.equal(held.ok, false);
  const target = held.studios.find(s => s.pid === 202);
  assert.equal(target.code, STUDIO_WINDOWLESS); assert.match(target.error, /held by the bridge of Service Studio 101/);
  assert.deepEqual(side.connected, [], 'nothing attached, nothing touched');
});

test('D5: the doctor lists windowless:[{pid}] with the fix and treats the record that names one as stale', async () => {
  const deps = record => ({ processes: async () => [WINDOWLESS, WINDOWED], facts: async () => ({ bridge: 4516 }), cliBuilt: true,
    probe: async () => ({ connected: true, pid: record }), record: () => ({ pid: record }), reservations: { env: { ANVIL_AUTHORITY_DIR: 'C:\\nowhere-pa3-fa' }, readUserEnvironment: () => null } });
  const good = await doctorO11(deps(202));
  assert.equal(good.ok, true, JSON.stringify(good.continuation));
  assert.deepEqual(good.windowless.map(w => [w.pid, w.code]), [[101, STUDIO_WINDOWLESS]]);
  assert.match(good.windowless[0].fix, /SSAM ignores this process; the Studio with a window is the one of the lane/);
  const stale = await doctorO11(deps(101));
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.connectionStale, { pid: 101, reason: 'windowless', code: STUDIO_WINDOWLESS });
  assert.equal(stale.continuation.tool, 'ssam_connect'); assert.match(stale.continuation.why, /101.*STUDIO_WINDOWLESS/);
  const report = await doctor('o11', { o11: deps(202), lanes: {} });
  assert.deepEqual(report.windowless.map(w => w.pid), [101]);
});
