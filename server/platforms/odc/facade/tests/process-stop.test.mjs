// R4 family C (C:\t\r4\CAPTURA-FALHA.md, operation c150ccf0 of 02/11): a kernel process that stopped without an envelope
// (an unhandled SkiaSharp finalizer exception aborted it) answered "deliver ended without an answer" and stage "snapshot",
// which read as a failed capture; its stderr, with the reason, was dropped. The answer now names the reason from the
// process's stderr (cold) or the worker's startup log (resident worker), exception lines only, server paths <server>.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverOutcome } from '../o11-cycle.mjs';
import { stoppedProcessDetail, logTailSince, sizeOf, serverPathsRedacted } from '../process-stop.mjs';

// The stderr of worker 9474 (o11/tmp/o11-worker/worker-36495-startup.log), as the runtime writes it on Linux.
const SKIA_ABORT = [
  'Unhandled exception. System.TypeInitializationException: The type initializer for \'SkiaSharp.SKObject\' threw an exception.',
  ' ---> System.DllNotFoundException: Unable to load shared library \'libSkiaSharp\' or one of its dependencies. In order to help diagnose loading problems, consider using a tool like strace. If you\'re using glibc, consider setting the LD_DEBUG environment variable: ',
  '/studio/o11/libSkiaSharp.so: cannot open shared object file: No such file or directory',
  '/usr/share/dotnet/shared/Microsoft.NETCore.App/10.0.12/libSkiaSharp.so: cannot open shared object file: No such file or directory',
  '   at SkiaSharp.SkiaApi.sk_version_get_milestone()',
  '   at SkiaSharp.SKObject..cctor()',
  '   --- End of inner exception stack trace ---',
  '   at SkiaSharp.SKObject.DeregisterHandle(IntPtr handle, SKObject instance)',
  '   at SkiaSharp.SKPaint.Dispose(Boolean disposing)',
  '   at SkiaSharp.SKNativeObject.Finalize()',
  '   at System.GC.RunFinalizers()',
];
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-stop-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const ID = 'c150ccf09d37423eaaedbb8f91daafac';
// The task the process left: checkpoint snapshot, nothing sent, no error recorded (it died before any catch).
function stoppedTask(work, job) {
  const payload = JSON.stringify({ taskId: ID, stage: 'snapshot', writeState: 'not-sent', delivered: false, error: null,
    updatedAt: new Date().toISOString(), request: { JobPath: job }, history: [{ seq: 1, stage: 'snapshot', error: null }] });
  fs.mkdirSync(path.join(work, 'deliver', ID), { recursive: true });
  fs.writeFileSync(path.join(work, 'deliver', ID, 'task.json'), JSON.stringify({ format: 1, sha256: 'x', payload }));
}

test('the reason of a stopped process: exception lines only, the runtime advice and every server path left out', () => {
  const said = stoppedProcessDetail({ exitCode: 134, envelope: null, stderr: SKIA_ABORT });
  assert.match(said, /^System\.TypeInitializationException: The type initializer for 'SkiaSharp\.SKObject' threw an exception\./);
  assert.match(said, /System\.DllNotFoundException: Unable to load shared library 'libSkiaSharp'/);
  assert.doesNotMatch(said, /\/studio|\/usr\/share|dotnet\/shared|\bat SkiaSharp|In order to help|LD_DEBUG/);
  assert.ok(said.length <= 240, said);
  // A worker run: only its startup log speaks, never the facade's own "outcome unknown" text.
  assert.equal(stoppedProcessDetail({ via: 'worker', stderr: ['worker connection failed after submission'] }), '');
  assert.match(stoppedProcessDetail({ via: 'worker', stderr: ['worker connection failed'], stderrTail: SKIA_ABORT }), /DllNotFoundException/);
  // An envelope is the kernel's own answer: nothing added.
  assert.equal(stoppedProcessDetail({ envelope: { ok: false, error: 'x' }, stderr: SKIA_ABORT }), '');
  assert.equal(serverPathsRedacted('see C:\\Users\\x\\a.log and https://host/path and /data/server/customers/tok_1/o11'), 'see <server> and https://host/path and <server>');
});

test('a delivery whose process stopped after the snapshot says why, not "ended without an answer" (cold run)', t => {
  const work = temp(t); const job = path.join(work, 'job.json');
  stoppedTask(work, job);
  const answer = deliverOutcome({ ok: false, exitCode: 134, envelope: null, stderr: SKIA_ABORT, stdout: [] },
    { trackId: 'track', work, job, since: Date.now() - 60000, input: { module: 'ProdSSAM_CS' } });
  assert.equal(answer.ok, false);
  assert.match(answer.error, /The delivery process stopped after the snapshot stage \(System\.TypeInitializationException/);
  assert.match(answer.error, /libSkiaSharp/);
  assert.doesNotMatch(answer.error, /\/studio|\bat SkiaSharp/);
});

test('the same through the resident worker that died with the request: its startup log tail since the request', t => {
  const work = temp(t); const job = path.join(work, 'job.json');
  stoppedTask(work, job);
  const answer = deliverOutcome({ ok: false, exitCode: 1, envelope: null, timedOut: true, unknown: true, via: 'worker',
    stderr: ['worker connection failed after submission; execution outcome is unknown, command was not replayed'], stderrTail: SKIA_ABORT },
    { trackId: 'track', work, job, since: Date.now() - 60000, input: { module: 'ProdSSAM_CS' } });
  assert.match(answer.error, /The delivery process stopped after the snapshot stage \(System\.TypeInitializationException.*libSkiaSharp/);
  assert.match(answer.error, /deliver timed out|libSkiaSharp/);
});

test('logTailSince reads only what the log got after the offset, and never throws', t => {
  const dir = temp(t); const file = path.join(dir, 'worker-1-startup.log');
  fs.writeFileSync(file, 'an older launch\nits own lines\n');
  const at = sizeOf(file);
  fs.appendFileSync(file, SKIA_ABORT.join('\n') + '\n');
  const tail = logTailSince(file, at);
  assert.equal(tail[0], SKIA_ABORT[0]);
  assert.ok(!tail.includes('an older launch'));
  assert.deepEqual(logTailSince(path.join(dir, 'missing.log'), 0), []);
  assert.equal(sizeOf(path.join(dir, 'missing.log')), 0);
});
