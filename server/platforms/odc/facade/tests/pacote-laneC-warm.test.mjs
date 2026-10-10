// Lane C, C38: the discover index of each served lane is warmed in the background when the stdio MCP server starts (never
// awaited by a call, never on createSsamServer, never with SSAM_NO_WARM=1); a lane that cannot build is logged and recorded
// as friction (I9) while the others still build; `ssam warm` is the foreground verb scripts/build.ps1 runs at its end.
// Fakes only: no index is built here (the build fake records the lanes it was asked for).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as m_ssam from '../ssam.mjs';
const { scheduleWarm, warmIndexes, WARM_DELAY_MS } = m_ssam; // a namespace: at the base each test fails on its own rule, not at import

const exec = promisify(execFile);
const ssam = fileURLToPath(new URL('../ssam.mjs', import.meta.url));

test('the warm-up is scheduled, never awaited, unref-ed, and off with SSAM_NO_WARM=1', async () => {
  assert.equal(scheduleWarm({ env: { SSAM_NO_WARM: '1' }, warm: () => { throw new Error('never'); }, setTimer: () => { throw new Error('never'); } }), null);
  const timers = []; const warmed = [];
  const setTimer = (fn, delay) => { const timer = { fn, delay, unref() { this.unrefd = true; } }; timers.push(timer); return timer; };
  const scheduled = scheduleWarm({ env: {}, lanes: ['odc', 'o11'], warm: async options => { warmed.push(options); }, setTimer });
  assert.deepEqual([scheduled.delay, scheduled.lanes], [WARM_DELAY_MS, ['odc', 'o11']]);
  assert.equal(timers.length, 1); assert.equal(timers[0].unrefd, true, 'a server that ends never waits for the warm-up');
  assert.deepEqual(warmed, [], 'nothing runs before the timer: the server answers at once');
  timers[0].fn(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(warmed, [{ lanes: ['odc', 'o11'] }]);
  // A failure of the warm-up itself only reaches the log.
  const logged = [];
  scheduleWarm({ env: { SSAM_WARM_DELAY_MS: '0' }, lanes: ['o11'], warm: async () => { throw new Error('boom'); }, setTimer, log: line => logged.push(JSON.parse(line)) });
  assert.equal(timers[1].delay, 0);
  timers[1].fn(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(logged, [{ ssam: 'warm', ok: false, error: 'boom' }]);
  assert.equal(scheduleWarm({ env: {}, lanes: [], warm: () => {}, setTimer }), null, 'no served lane, nothing to warm');
});

test('warmIndexes builds every lane; a lane that fails is logged and recorded as friction, the others still build', async () => {
  const asked = []; const logged = []; const events = [];
  const build = async lane => { asked.push(lane); if (lane === 'o11') throw new Error('The o11 kernel CLI is not built (C:\\k\\anvil.dll)\nsecond line'); return { index: {}, cache: { hit: lane === 'odc' } }; };
  const result = await warmIndexes({ lanes: ['odc', 'o11'], build, log: line => logged.push(JSON.parse(line)), friction: { recordEvent: async e => events.push(e) } });
  assert.deepEqual(asked, ['odc', 'o11']);
  assert.equal(result.ok, false);
  assert.deepEqual([result.lanes.odc.ok, result.lanes.odc.cache], [true, 'hit']);
  assert.deepEqual([result.lanes.o11.ok, result.lanes.o11.error], [false, 'The o11 kernel CLI is not built (C:\\k\\anvil.dll)']);
  assert.deepEqual(logged, [{ ssam: 'warm', lane: 'o11', ok: false, error: 'The o11 kernel CLI is not built (C:\\k\\anvil.dll)' }]);
  assert.deepEqual(events, [{ operation: 'warm', lane: 'o11', code: 'WARM_INDEX_FAILED', step: 'build', outcome: 'failed' }]);
  // Friction that is not there yet (before lane E) or that throws never changes the warm-up.
  const quiet = await warmIndexes({ lanes: ['o11'], build, log: () => {}, friction: { recordEvent: async () => { throw new Error('store down'); } } });
  assert.equal(quiet.lanes.o11.ok, false);
  assert.equal((await warmIndexes({ lanes: ['odc'], build, log: () => {}, friction: {} })).ok, true);
});

test('`ssam warm` is a verb of its own (scripts/build.ps1 calls it), with its own usage', async () => {
  const run = await exec(process.execPath, [ssam, 'warm', '--bogus'], { env: { ...process.env, SSAM_NO_WARM: '1' }, windowsHide: true }).catch(error => error);
  assert.match(String(run.stderr), /Usage: ssam warm \[--lane o11\|odc\]/);
  const usage = await exec(process.execPath, [ssam, 'no-such-verb'], { env: { ...process.env, SSAM_NO_WARM: '1' }, windowsHide: true }).catch(error => error);
  assert.match(String(usage.stderr), /ssam warm \[--lane o11\|odc\]/, 'the general usage names it');
  assert.match(path.basename(ssam), /^ssam\.mjs$/);
});
