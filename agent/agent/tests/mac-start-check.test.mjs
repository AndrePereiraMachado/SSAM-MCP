// One start time reader alone (review M4). The O11 runtime hook compares the start time of Service Studio to the
// microsecond and runs once per process: a wrong value refuses the bridge and only a restart of Service Studio allows
// another try. A reader that reads the right seconds but wrong microseconds (a struct read at a wrong place gives 0 or
// noise there) is not caught by the kernel seconds. So a reader counts only after it read, on processes the agent started
// itself (two, at different moments of a second), a start time inside the window the agent measured around their start
// (macos.mjs calibrateReaders): nothing of a Studio is touched for that. With no reader that passed, the Service Studio
// describe refuses before anything is sent, with the reason and the next step; one reader that passed is enough. The ODC
// lane does not use the start time and is not changed. The processes, the clock and the readers are fakes here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as macos from '../lib/macos.mjs';
import { createMacAttach } from '../lib/attach-unix.mjs';
import { fakePe } from './fixtures/pe.mjs';

const START = 1760872353;
// Two processes started at START.120 s and START.420 s (Date.now() 1 ms apart around each start).
function probes() {
  const starts = { 9001: { sec: START, usec: 120400 }, 9002: { sec: START, usec: 420300 } };
  const clock = [START * 1000 + 120, START * 1000 + 121, START * 1000 + 420, START * 1000 + 421];
  let tick = 0; let next = 9001; const killed = [];
  return { starts, killed, now: () => clock[Math.min(tick++, clock.length - 1)], sleep: async () => {},
    spawnChild: () => { const pid = next++; return { pid, kill: () => killed.push(pid) }; } };
}
const reader = fn => async pid => fn(Number(pid));

test('calibrateReaders: a reader counts only when its microseconds fall in the window measured around processes the agent started', async () => {
  assert.equal(typeof macos.calibrateReaders, 'function', 'macos.mjs has no check of the readers on processes of the agent');
  const p = probes();
  const result = await macos.calibrateReaders({ ...p, readers: {
    right: reader(pid => p.starts[pid]),
    zero: reader(pid => ({ sec: p.starts[pid].sec, usec: 0 })),
    noise: reader(pid => ({ sec: p.starts[pid].sec, usec: (p.starts[pid].usec + 400000) % 1000000 })),
    broken: async () => { throw new Error('syscall: Operation not permitted'); },
  } });
  assert.deepEqual(result.trusted, ['right']);
  const by = Object.fromEntries(result.results.map(r => [r.name, r]));
  assert.equal(by.right.ok, true);
  assert.deepEqual(by.right.offsetsMs.map(x => Number(x.toFixed(1))), [0.4, 0.3]);
  for (const name of ['zero', 'noise', 'broken']) assert.equal(by[name].ok, false, name);
  assert.match(by.zero.error, /ms from the start the agent measured/);
  assert.match(by.broken.error, /Operation not permitted/);
  assert.deepEqual(p.killed, [9001, 9002], 'the test processes are ended');
});

// A Service Studio bundle, its diagnostic socket and ps line, in a temporary folder.
function studio() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-start-')).replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
  const dir = `${top}/home/Applications/Service Studio.app/Contents/MacOS`;
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(`${top}/tmp`, { recursive: true });
  for (const n of ['ServiceStudio.Framework.dll', 'OutSystems.Model.V1.dll']) fs.writeFileSync(`${dir}/${n}`, 'x');
  fs.writeFileSync(`${dir}/ServiceStudio.dll`, fakePe({ productVersion: '11.55.92.65269' }));
  fs.writeFileSync(`${dir}/ServiceStudio.runtimeconfig.json`, '{"runtimeOptions":{"configProperties":{}}}');
  fs.writeFileSync(`${dir}/Service Studio`, 'mach-o');
  fs.writeFileSync(`${top}/home/Applications/Service Studio.app/Contents/Info.plist`, '<plist><dict><key>CFBundleExecutable</key><string>Service Studio</string></dict></plist>');
  fs.writeFileSync(`${top}/tmp/dotnet-diagnostic-601-${START}-socket`, '');
  const d = new Date(START * 1000);
  const lstart = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} ${d.getFullYear()}`;
  return { top, ps: `  601 ${lstart} ${dir}/Service Studio\n`, remove: () => fs.rmSync(top.replace(/^\//, path.parse(os.tmpdir()).root), { recursive: true, force: true }) };
}
function attachWith(s, readers, sent) {
  const p = probes();
  return createMacAttach({ env: { TMPDIR: s.top + '/tmp' }, home: s.top + '/home', ps: async () => s.ps, readers, spawnChild: p.spawnChild, clock: p.now, sleep: p.sleep,
    run: async file => { if (file === '/usr/sbin/lsof') return 'n/x/ServiceStudio.Framework.dll\n'; throw new Error('no ' + file); },
    ipc: { processInfo2: async () => ({ pid: 601, clrVersion: '8.0.31', entrypoint: 'ServiceStudio', commandLine: '"' + fs.realpathSync(s.top + '/home/Applications/Service Studio.app/Contents/MacOS/Service Studio') + '"' }), applyStartupHook: async (...args) => { sent.push(args); return { applied: true }; } } });
}

test('Service Studio describe: one reader with wrong microseconds is refused before anything is sent; one reader that passed is enough', async () => {
  const s = studio();
  try {
    const sent = [];
    // The only reader reads the right seconds and always 0 microseconds: the kernel seconds cannot tell; the check can.
    const wrong = attachWith(s, { perl: reader(pid => ({ sec: pid === 601 ? START : START, usec: 0 })) }, sent);
    await assert.rejects(wrong.describeO11(601), error => {
      assert.equal(error.code, 'ATTACH_FAILED'); assert.equal(error.executed, false);
      assert.match(error.message, /no start time reader .* a process the agent started itself/);
      assert.match(error.message, /nothing was sent and the Studio was not touched/);
      assert.match(error.message, /doctor --json/);
      return true;
    });
    await assert.rejects(wrong.attachO11(601, macos.dotnetStartTimeText(START, 0), s.top + '/hook.dll'), /no start time reader/);
    assert.deepEqual(sent, [], 'nothing was sent to the Studio');
    // One reader that reads the microseconds right is enough.
    const p = probes();
    const right = attachWith(s, { perl: reader(pid => (pid === 601 ? { sec: START, usec: 123456 } : p.starts[pid])) }, sent);
    const described = await right.describeO11(601);
    assert.equal(described.startedUtc, macos.dotnetStartTimeText(START, 123456));
    assert.deepEqual(described.startReaders, ['perl']);
  } finally { s.remove(); }
});

test('doctor on macOS: a reader with wrong microseconds is said as failed, with the reason (it was "ok" when it was within 5 s of the agent start)', async () => {
  const { macDoctor } = await import('../lib/mac-doctor.mjs');
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-start-doctor-')).replace(/^[A-Za-z]:/, '').replace(/\\/g, '/');
  try {
    const p = probes();
    const run = async (file, args) => { if (file === '/usr/bin/sw_vers') return '15.5\n'; if (file === '/usr/sbin/sysctl') return args[1] === 'hw.optional.arm64' ? '1\n' : '0\n'; throw new Error('no ' + file); };
    const { checks, facts } = await macDoctor({ pack: { lanes: ['odc', 'o11'] }, deps: { run, env: { HOME: top, TMPDIR: top }, home: top, ps: async () => '', pid: 9001, startedMs: START * 1000 + 120,
      readers: { perl: reader(pid => ({ sec: START, usec: 0 })) }, spawnChild: p.spawnChild, clock: p.now, sleep: p.sleep } });
    const check = checks.find(c => c.name === 'start time with microseconds (Service Studio hook)');
    assert.equal(check.ok, false, check.detail);
    assert.match(check.detail, /perl failed: .*ms from the start the agent measured/);
    assert.equal(facts.startTimeReaders[0].ok, false);
  } finally { fs.rmSync(top.replace(/^\//, path.parse(os.tmpdir()).root), { recursive: true, force: true }); }
});
