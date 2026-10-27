// The ODC bridge command relay in the facade's own process. The bridge listens on the named pipe
// ODC3-Bridge-<version>-<pid> and answers one JSON line per command line (studio/bridge/client/Program.cs); the
// .NET client only connects, writes the line and prints the reply. Speaking the pipe from Node saves one `dotnet`
// process per studio_* call (two for `status brief`). attach stays with the .NET client (DiagnosticsClient).
// A client timeout never cancels the native operation: callers read the evidence instead of retrying.
import net from 'node:net';

export const pipeName = (version, pid) => `\\\\.\\pipe\\ODC3-Bridge-${version}-${pid}`;

// How long a reply may take: the bridge's own wait for `wait <condition> [module] <seconds>` and
// `publish <manifest> --wait <minutes>`, plus a margin; otherwise the 10 minutes of the .NET client.
// The bridge's own deadline per command (StartupHook.cs Serve: the timeout switch). Past it the bridge answers by itself
// (uncertain, with the open dialogs) and keeps serving; a client that gave up first leaves that answer on a closed pipe.
// So the client always waits past the bridge's deadline: 2026-10-22, the client stopped at 10 min, the bridge answered at
// 15 min onto a closed pipe and (bridge <= v95) its command server ended with it.
export const BRIDGE_COMMAND_TIMEOUT_MS = Object.freeze({ merge: 15 * 60 * 1000 });
const BRIDGE_ANSWER_MARGIN_MS = 60 * 1000;
export function replyTimeoutMs(args) {
  const base = 10 * 60 * 1000;
  if (args[0] === 'merge' || args[0] === 'reconcile-merge') return BRIDGE_COMMAND_TIMEOUT_MS.merge + BRIDGE_ANSWER_MARGIN_MS;
  if (args[0] === 'wait') { const s = Number(args.at(-1)); return Number.isFinite(s) ? Math.max(base, s * 1000 + 60000) : base; }
  if (args[0] === 'publish') { const i = args.indexOf('--wait'); const m = Number(args[i + 1]); return i >= 0 && Number.isFinite(m) ? Math.max(base, m * 60000 + 60000) : base; }
  return base;
}

export class PipeError extends Error {
  constructor(message, { code, sent } = {}) { super(message); this.name = 'PipeError'; this.code = code; this.sent = sent; }
}

// One command: connect, write `command args`, read one line. The bridge serves one pipe instance at a time
// (StartupHook.cs Serve: maxNumberOfServerInstances 1, a new instance after each command), so while a command runs,
// and for a moment between two commands, the pipe is absent (ENOENT) or busy (EBUSY). Like the .NET client's
// ConnectAsync(10 s), the connection is tried again with a short backoff until connectMs; nothing was written yet.
export async function pipeCall(pid, version, args, options = {}) {
  const { connectMs = 10000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = options;
  const deadline = now() + connectMs;
  for (let wait = 25; ; wait = Math.min(wait * 2, 250)) {
    try { return await pipeAttempt(pid, version, args, { ...options, connectMs: Math.max(1, deadline - now()) }); }
    catch (error) {
      if (!(error instanceof PipeError) || error.sent !== false || !['PIPE_ABSENT', 'PIPE_BUSY'].includes(error.code)) throw error;
      if (now() >= deadline) throw new PipeError(error.code === 'PIPE_BUSY'
        ? `The ODC bridge ${version} of ODC Studio ${pid} stayed busy for ${Math.round(connectMs / 1000)} s; a command is still running there: read its evidence or wait, never repeat a write`
        : `The ODC bridge ${version} is not attached to ODC Studio ${pid} (no pipe for ${Math.round(connectMs / 1000)} s); call studio_attach`,
        { code: error.code === 'PIPE_BUSY' ? 'BRIDGE_BUSY' : 'BRIDGE_NOT_ATTACHED', sent: false });
      await sleep(Math.max(1, Math.min(wait, deadline - now())));
    }
  }
}

// Is a bridge attached to this Studio, without the 10 s wait of pipeCall (ssam_connect asks every open Studio at once):
// one short connect window (connectMs, 400 ms by default: the gap between two commands of a live bridge is shorter),
// then one read-only command the bridge serves even while another command runs (auth-status: the signed-in sessions
// with host and user). {attached:true, reply} | {attached:true, busy:true} (the single pipe instance is serving a
// command: the bridge is there) | {attached:false} (no pipe of this version). A reply that does not come in timeoutMs
// still proves the bridge (it accepted the connection): {attached:true, reply:null, error}. Never throws.
export async function pipeProbe(pid, version, { args = ['auth-status'], connectMs = 400, timeoutMs = 8000, call = pipeCall, ...options } = {}) {
  try {
    const text = String(await call(pid, version, args, { ...options, connectMs, timeoutMs })).trim();
    let reply = null; try { reply = JSON.parse(text); } catch { reply = { raw: text }; }
    return { attached: true, busy: false, reply };
  } catch (error) {
    if (error?.code === 'BRIDGE_BUSY' || error?.code === 'PIPE_BUSY') return { attached: true, busy: true, reply: null };
    if (error?.code === 'BRIDGE_NOT_ATTACHED' || error?.code === 'PIPE_ABSENT' || error?.code === 'PIPE_CONNECT_TIMEOUT') return { attached: false, reply: null };
    // Connected and wrote the command, no answer (yet): the bridge exists; its answer is not needed to know that.
    if (error?.sent === true) return { attached: true, busy: false, reply: null, error: error.message };
    return { attached: false, reply: null, error: error?.message ?? String(error) };
  }
}

function pipeAttempt(pid, version, args, { connectMs = 10000, timeoutMs = replyTimeoutMs(args), path: name = pipeName(version, pid), maxBytes = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(name);
    const chunks = []; let size = 0; let sent = false; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(connectTimer); clearTimeout(replyTimer); socket.destroy(); error ? reject(error) : resolve(value); };
    const connectTimer = setTimeout(() => finish(new PipeError(`ODC bridge pipe ${version}-${pid} did not accept the connection`, { code: 'PIPE_CONNECT_TIMEOUT', sent: false })), connectMs);
    let replyTimer = null;
    socket.on('connect', () => {
      clearTimeout(connectTimer);
      socket.write(args.map(String).join(' ') + '\n', 'utf8'); sent = true;
      replyTimer = setTimeout(() => finish(new PipeError(`ODC bridge ${args[0]} did not answer within ${timeoutMs} ms; the native operation may still run: read its evidence before any retry`, { code: 'PIPE_REPLY_TIMEOUT', sent: true })), timeoutMs);
    });
    socket.on('error', error => finish(new PipeError(error.message,
      { code: !sent && error.code === 'ENOENT' ? 'PIPE_ABSENT' : !sent && error.code === 'EBUSY' ? 'PIPE_BUSY' : 'PIPE_TRANSPORT', sent })));
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
