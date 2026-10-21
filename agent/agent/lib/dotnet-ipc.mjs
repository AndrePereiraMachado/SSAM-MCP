// The .NET diagnostic IPC protocol (DOTNET_IPC_V1, dotnet/diagnostics documentation/design-docs/ipc-protocol.md), spoken
// from Node: the agent on macOS attaches its own bridge with ApplyStartupHook (since .NET 8) and reads ProcessInfo2 (the
// pid and the runtime version of the target) without any .NET on the machine. Windows keeps the pack's .NET client and
// Anvil.Connect (proven, with the Smart App Control handling); this module also speaks the Windows transport, which is how
// it is proven on a Windows machine against a real .NET process.
//   transport  Windows: the named pipe \\.\pipe\dotnet-diagnostic-<pid>
//              Unix:    <temp dir>/dotnet-diagnostic-<pid>-<disambiguation key>-socket (macOS: the key is the process start
//                       time in seconds since the Unix epoch), in $TMPDIR of the target, else /tmp
//   message    header of 20 bytes: magic "DOTNET_IPC_V1\0" (14), total size uint16 LE, command set uint8, command id
//              uint8, reserved uint16 = 0; then the payload. A string is a uint32 LE count of UTF-16 code units, the
//              terminating NUL included, then those units (UTF-16LE); an empty count is a null string.
//   reply      Server set 0xFF: 0x00 OK (payload per command), 0xFF error (payload int32 HRESULT).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const MAGIC = Buffer.from('DOTNET_IPC_V1\0', 'latin1');
export const HEADER_BYTES = 20;
export const COMMAND_SET = Object.freeze({ PROCESS: 0x04, SERVER: 0xff });
export const PROCESS_COMMAND = Object.freeze({ PROCESS_INFO: 0x00, PROCESS_INFO2: 0x04, APPLY_STARTUP_HOOK: 0x07 });
export const SERVER_REPLY = Object.freeze({ OK: 0x00, ERROR: 0xff });
// Known HRESULTs of the diagnostic server, named in the errors (ds-protocol.h).
const HRESULT_NAMES = { 0x80131384: 'DS_IPC_E_BAD_ENCODING', 0x80131385: 'DS_IPC_E_UNKNOWN_COMMAND', 0x80131386: 'DS_IPC_E_UNKNOWN_MAGIC',
  0x80131387: 'DS_IPC_E_NOTSUPPORTED', 0x80131388: 'DS_IPC_E_FAIL', 0x80070057: 'E_INVALIDARG', 0x80004005: 'E_FAIL' };
export const hresultText = value => { const n = value >>> 0; return '0x' + n.toString(16).padStart(8, '0') + (HRESULT_NAMES[n] ? ' (' + HRESULT_NAMES[n] + ')' : ''); };

export class IpcError extends Error {
  constructor(message, { code = 'IPC_FAILED', hresult = null, sent = false } = {}) { super(message); this.name = 'IpcError'; this.code = code; this.hresult = hresult; this.sent = sent; }
}

export function encodeString(value) {
  if (value === null || value === undefined) return Buffer.alloc(4);
  const units = Buffer.from(String(value) + '\0', 'utf16le');
  const count = Buffer.alloc(4); count.writeUInt32LE(units.length / 2);
  return Buffer.concat([count, units]);
}

export function encodeMessage(commandSet, commandId, payload = Buffer.alloc(0)) {
  const size = HEADER_BYTES + payload.length;
  if (size > 0xffff) throw new IpcError(`An IPC message of ${size} bytes does not fit the uint16 size of the header`, { code: 'IPC_MESSAGE_TOO_LARGE' });
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt16LE(size, 14);
  header.writeUInt8(commandSet, 16);
  header.writeUInt8(commandId, 17);
  header.writeUInt16LE(0, 18);
  return Buffer.concat([header, payload]);
}

// {commandSet, commandId, size} of a header, or an IpcError for anything that is not DOTNET_IPC_V1.
export function decodeHeader(buffer) {
  if (buffer.length < HEADER_BYTES || !buffer.subarray(0, 14).equals(MAGIC)) throw new IpcError('The diagnostic endpoint did not answer with a DOTNET_IPC_V1 header', { code: 'IPC_BAD_REPLY', sent: true });
  const size = buffer.readUInt16LE(14);
  if (size < HEADER_BYTES) throw new IpcError('The diagnostic endpoint answered a header with an invalid size', { code: 'IPC_BAD_REPLY', sent: true });
  return { commandSet: buffer.readUInt8(16), commandId: buffer.readUInt8(17), size };
}

// One string at offset `at`: {value, next}; value null for a zero count.
export function readString(buffer, at) {
  if (at + 4 > buffer.length) throw new IpcError('A string of the reply is cut', { code: 'IPC_BAD_REPLY', sent: true });
  const count = buffer.readUInt32LE(at);
  const end = at + 4 + count * 2;
  if (end > buffer.length) throw new IpcError('A string of the reply is cut', { code: 'IPC_BAD_REPLY', sent: true });
  if (count === 0) return { value: null, next: end };
  return { value: buffer.toString('utf16le', at + 4, end).replace(/\0$/, ''), next: end };
}

// ProcessInfo2 payload -> {pid, cookie, commandLine, os, arch, entrypoint, clrVersion}.
export function decodeProcessInfo2(payload) {
  if (payload.length < 24) throw new IpcError('The ProcessInfo2 reply is cut', { code: 'IPC_BAD_REPLY', sent: true });
  const pid = Number(payload.readBigUInt64LE(0));
  const cookie = payload.subarray(8, 24).toString('hex');
  let at = 24; const strings = [];
  for (let i = 0; i < 5; i++) { const s = readString(payload, at); strings.push(s.value); at = s.next; }
  const [commandLine, os, arch, entrypoint, clrVersion] = strings;
  return { pid, cookie, commandLine, os, arch, entrypoint, clrVersion };
}

export const windowsEndpoint = pid => `\\\\.\\pipe\\dotnet-diagnostic-${pid}`;
const SOCKET = /^dotnet-diagnostic-(\d+)-(\d+)-socket$/;

// The diagnostic sockets of one pid in the given folders, newest first (as the official client picks the default
// address): [{path, dir, key, mtimeMs}]. The key on macOS is the process start time in seconds.
export function unixEndpoints(pid, dirs, { readdir = fs.readdirSync, stat = fs.statSync } = {}) {
  const found = []; const seen = new Set();
  for (const dir of dirs) {
    if (!dir) continue;
    let names = [];
    try { names = readdir(dir); } catch { continue; }
    for (const name of names) {
      const match = SOCKET.exec(name);
      if (!match || Number(match[1]) !== Number(pid)) continue;
      const full = path.posix.join(dir.replace(/\/+$/, '') || '/', name);
      if (seen.has(full)) continue;
      seen.add(full);
      let mtimeMs = 0;
      try { mtimeMs = stat(full).mtimeMs; } catch { continue; }
      found.push({ path: full, dir: dir.replace(/\/+$/, '') + '/', key: match[2], mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// One request on a new connection: the reply {commandSet, commandId, payload}. The runtime answers one message and
// closes. connect (tests): a function(path) returning a net.Socket-like duplex.
export function ipcRequest(endpoint, message, { timeoutMs = 20000, connect = target => net.createConnection(target) } = {}) {
  return new Promise((resolve, reject) => {
    let socket;
    try { socket = connect(endpoint); } catch (error) { reject(new IpcError(`The diagnostic endpoint ${endpoint} cannot be opened: ${error.message}`, { code: 'IPC_ABSENT' })); return; }
    const chunks = []; let size = 0; let header = null; let sent = false; let settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new IpcError(`The diagnostic endpoint ${endpoint} did not answer within ${timeoutMs} ms`, { code: 'IPC_TIMEOUT', sent })), timeoutMs);
    socket.on('connect', () => { socket.write(message); sent = true; });
    socket.on('data', chunk => {
      chunks.push(chunk); size += chunk.length;
      const all = Buffer.concat(chunks, size);
      try {
        if (!header && all.length >= HEADER_BYTES) header = decodeHeader(all);
        if (header && all.length >= header.size) finish(null, { commandSet: header.commandSet, commandId: header.commandId, payload: all.subarray(HEADER_BYTES, header.size) });
      } catch (error) { finish(error); }
    });
    socket.on('error', error => finish(new IpcError(`The diagnostic endpoint ${endpoint}: ${error.message}`,
      { code: !sent && ['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 'IPC_ABSENT' : !sent && error.code === 'EBUSY' ? 'IPC_BUSY' : 'IPC_TRANSPORT', sent })));
    socket.on('end', () => finish(new IpcError(`The diagnostic endpoint ${endpoint} closed without a complete reply`, { code: 'IPC_NO_REPLY', sent })));
  });
}

// The reply as a value, or an IpcError for an error reply (with its HRESULT).
function expectOk(reply, what) {
  if (reply.commandSet === COMMAND_SET.SERVER && reply.commandId === SERVER_REPLY.ERROR) {
    const hresult = reply.payload.length >= 4 ? reply.payload.readInt32LE(0) : null;
    throw new IpcError(`${what} was refused by the runtime: ${hresult === null ? 'no code' : hresultText(hresult)}`, { code: 'IPC_REFUSED', hresult, sent: true });
  }
  if (reply.commandSet !== COMMAND_SET.SERVER || reply.commandId !== SERVER_REPLY.OK) throw new IpcError(`${what} got an unexpected reply`, { code: 'IPC_BAD_REPLY', sent: true });
  return reply.payload;
}

// The runtime's EBUSY on Windows (a pipe instance between two clients) is tried again for a short while; nothing was
// written then.
async function request(endpoint, message, options = {}) {
  const { retryMs = 2000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = options;
  const deadline = now() + retryMs;
  for (let wait = 20; ; wait = Math.min(wait * 2, 200)) {
    try { return await ipcRequest(endpoint, message, options); }
    catch (error) {
      if (!(error instanceof IpcError) || error.code !== 'IPC_BUSY' || now() >= deadline) throw error;
      await sleep(wait);
    }
  }
}

// ProcessInfo2: read only (the pid, the command line, the OS, the architecture, the entry assembly and the runtime).
export async function processInfo2(endpoint, options = {}) {
  const payload = expectOk(await request(endpoint, encodeMessage(COMMAND_SET.PROCESS, PROCESS_COMMAND.PROCESS_INFO2), options), 'ProcessInfo2');
  return decodeProcessInfo2(payload);
}

// ApplyStartupHook <absolute path of a managed DLL>: the runtime loads it and calls StartupHook.Initialize(). The answer
// carries an HRESULT (0 = applied). A failure after the request was written is an unknown outcome (sent:true).
export async function applyStartupHook(endpoint, file, options = {}) {
  const payload = expectOk(await request(endpoint, encodeMessage(COMMAND_SET.PROCESS, PROCESS_COMMAND.APPLY_STARTUP_HOOK, encodeString(file)), options), 'ApplyStartupHook');
  const hresult = payload.length >= 4 ? payload.readInt32LE(0) : 0;
  if (hresult !== 0) throw new IpcError(`ApplyStartupHook answered ${hresultText(hresult)}`, { code: 'IPC_REFUSED', hresult, sent: true });
  return { applied: true };
}

// The major version of a clrProductVersion ("8.0.31+abc..." -> 8), or null.
export const runtimeMajor = text => { const match = /^(\d+)\./.exec(String(text ?? '')); return match ? Number(match[1]) : null; };
