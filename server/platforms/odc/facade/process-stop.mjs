// A kernel process that stopped without an envelope (R4, family C of the capture of 02/11: an unhandled exception on the
// finalizer thread aborted the O11 kernel, and the answer said only "deliver ended without an answer" while the reason sat in
// the process's stderr). Two sources, one reading:
//   - a cold run: run.stderr, the tail of the process's stderr (anvil-cli.mjs);
//   - a resident worker that died with the request written: run.stderrTail, what the worker wrote to its startup log (its
//     stderr) from the moment the request was sent (anvil-worker.mjs, logTailSince).
// stoppedProcessDetail keeps only the exception lines (never a stack frame), each server path as <server>, short enough to
// travel inside an answer's error. Pure but for logTailSince, which reads one file and never throws.
import fs from 'node:fs';

// The size of a file now (0 when it is missing): the offset logTailSince reads from.
export function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

// The non-empty lines a log got after `offset` (at most the last `maxBytes` of it, the last `lines` lines). [] on any error.
export function logTailSince(file, offset = 0, { lines = 40, maxBytes = 64 * 1024 } = {}) {
  try {
    const size = fs.statSync(file).size;
    const from = Math.max(Number(offset) || 0, size - maxBytes, 0);
    if (size <= from) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buffer, 0, buffer.length, from);
      return buffer.toString('utf8').split(/\r?\n/).filter(line => line.trim()).slice(-lines);
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

const STACK_FRAME = /^\s*(?:at\s|---\s*End of)/;
// An absolute path of the server (POSIX or Windows), never part of a URL (a scheme's ':' or '/' before it) nor of a word.
const SERVER_PATH = /(?<![\w.:/\\-])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'`<>|*?,;:()]+/g;
export const serverPathsRedacted = text => String(text ?? '').replace(SERVER_PATH, '<server>').replace(/(?:<server>[\s,:]*){2,}/g, '<server> ');

// The reason a kernel process gave before it stopped, from its stderr: '' when it wrote none. A worker run reads only its
// startup log (its stderr field is the facade's own "outcome unknown" text, not the process's).
export function stoppedProcessDetail(run, limit = 240) {
  const lines = Array.isArray(run?.stderrTail) && run.stderrTail.length ? run.stderrTail
    : run?.via === 'worker' ? [] : (Array.isArray(run?.stderr) ? run.stderr : []);
  const kept = lines.map(String).filter(line => line.trim() && !STACK_FRAME.test(line));
  if (!kept.length || run?.envelope) return '';
  // From the first "Unhandled exception" on, when the process wrote one; else its last lines.
  const start = kept.findIndex(line => /Unhandled exception|Fatal error|Process terminated/i.test(line));
  // The runtime's own advice after a DllNotFoundException ("In order to help diagnose ... LD_DEBUG ...") says nothing of the
  // cause; the paths it then tried read <server> once (one line per probed folder, all alike).
  const said = (start >= 0 ? kept.slice(start) : kept.slice(-4))
    .map(line => serverPathsRedacted(line.trim().replace(/^Unhandled exception\.\s*/i, '').replace(/\s*In order to help diagnose loading problems.*$/i, '')))
    .filter((line, i, all) => line && all.indexOf(line) === i);
  const plain = said.join(' ').replace(/\s+/g, ' ').trim();
  return plain.length <= limit ? plain : plain.slice(0, Math.max(0, limit - 1)) + '…';
}
