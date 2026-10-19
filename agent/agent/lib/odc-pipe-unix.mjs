// The ODC bridge pipe on macOS (docs/AGENTE-MAC.md). The bridge's NamedPipeServerStream is, on Unix, a Unix domain socket
// at Path.GetTempPath() + "CoreFxPipe_" + name of the Studio process: <its temp folder>/CoreFxPipe_ODC3-Bridge-<v>-<pid>.
// The line protocol is the Windows one (odc-pipe.mjs, kept byte-equal to the server's copy); what differs is "busy":
//   - Windows: while the single pipe instance serves a command, another client gets EBUSY (nothing written).
//   - Unix: the listening socket stays open while the instance lives, so another client CONNECTS and waits in the queue;
//     when the instance is disposed that connection is dropped after the command was already written: an unknown
//     outcome. And between two commands the old socket may still accept for a moment before it is closed.
// So, on Unix, the agent itself (1) sends one command at a time per pipe and, when another command of this agent is still
// running there, answers BRIDGE_BUSY after connectMs with nothing written (the Windows answer); and (2) connects only to a
// socket file that is not the one of the previous command (another inode), checked again once connected, so a command
// is never written to an instance about to close. ENOENT and ECONNREFUSED (the gap between two instances) are tried again
// until connectMs, as ENOENT is on Windows. Limit: a process outside this agent that talks to the same pipe is not
// queued here (only this agent talks to its bridge).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { PipeError, replyTimeoutMs } from './odc-pipe.mjs';

export const unixPipeName = (version, pid) => `CoreFxPipe_ODC3-Bridge-${version}-${pid}`;
// sun_path of macOS: 104 bytes with its NUL.
export const UNIX_PATH_MAX = 103;
const busy = new Map(); // socket path -> true while a command of this agent runs there
const served = new Map(); // socket path -> identity (ino:birthtime) of the instance that served the last command
const identityOf = stat => (stat ? stat.ino + ':' + (stat.birthtimeMs ?? stat.ctimeMs) : null);

// pipeCall-compatible: (pid, version, args, options) -> the reply line. folders(pid) -> the folders to look in (the
// Studio's temp folder first). options: connectMs, timeoutMs, sleep, now, stat, connect, maxBytes (tests).
export function createUnixPipe({ folders }) {
  return async function unixPipeCall(pid, version, args, options = {}) {
    const { connectMs = 10000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, stat = file => fs.statSync(file, { throwIfNoEntry: false }) } = options;
    const deadline = now() + connectMs;
    const name = unixPipeName(version, pid);
    const absent = () => new PipeError(`The ODC bridge ${version} is not attached to ODC Studio ${pid} (no pipe for ${Math.round(connectMs / 1000)} s); call studio_attach`, { code: 'BRIDGE_NOT_ATTACHED', sent: false });
    const candidates = (await folders(pid)).map(dir => path.posix.join(dir, name));
    for (const file of candidates) if (Buffer.byteLength(file) > UNIX_PATH_MAX)
      throw new PipeError(`The ODC bridge socket path has more than ${UNIX_PATH_MAX} bytes (${file}); macOS cannot open it`, { code: 'PIPE_TRANSPORT', sent: false });
    for (let wait = 25; ; wait = Math.min(wait * 2, 250)) {
      const file = candidates.find(candidate => stat(candidate));
      const current = file ? identityOf(stat(file)) : null;
      if (file && busy.get(file)) {
        if (now() >= deadline) throw new PipeError(`The ODC bridge ${version} of ODC Studio ${pid} stayed busy for ${Math.round(connectMs / 1000)} s; a command is still running there: read its evidence or wait, never repeat a write`, { code: 'BRIDGE_BUSY', sent: false });
      } else if (file && current !== served.get(file)) {
        busy.set(file, true);
        try {
          return await attempt(file, current, args, { ...options, connectMs: Math.max(1, deadline - now()), stat });
        } catch (error) {
          if (!(error instanceof PipeError) || error.sent !== false || !['PIPE_ABSENT', 'PIPE_CHANGED'].includes(error.code)) throw error;
        } finally { busy.delete(file); }
      }
      if (now() >= deadline) throw absent();
      await sleep(Math.max(1, Math.min(wait, deadline - now())));
    }
  };
}

function attempt(file, identity, args, { connectMs, timeoutMs = replyTimeoutMs(args), maxBytes = 256 * 1024 * 1024, stat, connect = target => net.createConnection(target) }) {
  return new Promise((resolve, reject) => {
    const socket = connect(file);
    const chunks = []; let size = 0; let sent = false; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(connectTimer); clearTimeout(replyTimer); socket.destroy(); error ? reject(error) : resolve(value); };
    const connectTimer = setTimeout(() => finish(new PipeError(`ODC bridge pipe ${path.posix.basename(file)} did not accept the connection`, { code: 'PIPE_CONNECT_TIMEOUT', sent: false })), connectMs);
    let replyTimer = null;
    socket.on('connect', () => {
      clearTimeout(connectTimer);
      // The instance this connection reached must still be the one the file named before connecting.
      if (identityOf(stat(file)) !== identity) { finish(new PipeError('The ODC bridge pipe changed while connecting; nothing was written', { code: 'PIPE_CHANGED', sent: false })); return; }
      socket.write(args.map(String).join(' ') + '\n', 'utf8'); sent = true;
      served.set(file, identity);
      replyTimer = setTimeout(() => finish(new PipeError(`ODC bridge ${args[0]} did not answer within ${timeoutMs} ms; the native operation may still run: read its evidence before any retry`, { code: 'PIPE_REPLY_TIMEOUT', sent: true })), timeoutMs);
    });
    socket.on('error', error => finish(new PipeError(error.message,
      { code: !sent && ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'PIPE_ABSENT' : 'PIPE_TRANSPORT', sent })));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) return finish(new PipeError(`ODC bridge reply exceeded ${maxBytes} bytes`, { code: 'PIPE_REPLY_TOO_LARGE', sent: true }));
      const newline = chunk.indexOf(0x0a);
      if (newline < 0) { chunks.push(chunk); return; }
      chunks.push(chunk.subarray(0, newline));
      finish(null, Buffer.concat(chunks).toString('utf8').replace(/\r$/, ''));
    });
    socket.on('end', () => finish(new PipeError(`ODC bridge closed ${args[0]} without a reply`, { code: 'PIPE_NO_REPLY', sent })));
  });
}

// Tests: forget the per-pipe state.
export const resetUnixPipes = () => { busy.clear(); served.clear(); };
