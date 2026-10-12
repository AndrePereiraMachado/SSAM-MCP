// INTERNAL: use the explicitly selected Studio developer session. Tokens stay in
// the private process/CurrentUser pipe and are never CLI/MCP output or disk data.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { anvilRoot, workspaceRoot } from './workspace.mjs';
const exec = promisify(execFile);
const root = path.join(workspaceRoot, '.local', 'debugger', 'odc-session');
const fail = code => { throw new Error(code); };
const safe = error => /^debug_odc_session_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'debug_odc_session_unavailable';
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => { fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); };
const digest = value => createHash('sha256').update(value).digest('hex');
function validMetadata(value, binding) {
  if (!value || Array.isArray(value) || Object.keys(value).some(k => !['host', 'moduleKey', 'moduleName', 'revision', 'runtimeUrl', 'developerKey', 'developerAuthor'].includes(k)) ||
      value.host !== binding.host || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.developerKey ?? '') ||
      typeof value.developerAuthor !== 'string' || !value.developerAuthor || value.developerAuthor.length > 512 || /[\x00-\x1f\x7f]/.test(value.developerAuthor)) return false;
  if (!binding.moduleKey) return ['moduleKey', 'moduleName', 'revision', 'runtimeUrl'].every(k => value[k] === undefined);
  let url; try { url = new URL(value.runtimeUrl); } catch { return false; }
  return value.moduleKey === binding.moduleKey && typeof value.moduleName === 'string' && value.moduleName.length > 0 && value.moduleName.length < 256 &&
    Number.isSafeInteger(value.revision) && value.revision > 0 && url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash;
}

export function odcSessionRequest(input) {
  if (!/^[a-z0-9][a-z0-9.-]*\.outsystems\.dev$/.test(input?.host ?? '') ||
      input.moduleKey !== undefined && !/^[A-Za-z0-9_+]{22}$/.test(input.moduleKey) ||
      input.pid !== undefined && (!Number.isSafeInteger(input.pid) || input.pid < 1) ||
      typeof input.includeToken !== 'boolean') fail('debug_odc_session_contract_invalid');
  return { host: input.host, ...(input.moduleKey ? { moduleKey: input.moduleKey } : {}), includeToken: input.includeToken };
}
async function build(project, out, extra = []) {
  fs.mkdirSync(out, { recursive: true });
  try {
    const { stdout, stderr } = await exec('dotnet', ['build', project, '-c', 'Release', '--nologo', '-v', 'quiet', '--artifacts-path', out + '-artifacts', '-o', out, ...extra],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 180000 });
    fs.writeFileSync(path.join(out, 'build.log'), stdout + stderr);
  } catch (error) { fs.writeFileSync(path.join(out, 'build.log'), (error.stdout ?? '') + (error.stderr ?? '')); fail('debug_odc_session_build_failed'); }
}
async function connector() {
  const dir = path.join(anvilRoot, 'tools', 'Anvil.OdcConnect'), project = path.join(dir, 'Anvil.OdcConnect.csproj');
  const hash = digest(fs.readFileSync(path.join(dir, 'Program.cs')) + fs.readFileSync(project)).slice(0, 20);
  const out = path.join(root, 'connect-' + hash), dll = path.join(out, 'Anvil.OdcConnect.dll');
  if (!fs.existsSync(path.join(out, 'ready.json'))) { await build(project, out); write(path.join(out, 'ready.json'), { hash }); }
  return async args => {
    try {
      const { stdout } = await exec('dotnet', [dll, ...args.map(String)], { windowsHide: true, timeout: 30000, maxBuffer: 65536 });
      const value = JSON.parse(stdout.trim()); if (!value.ok) fail('debug_odc_session_studio_unavailable'); return value;
    } catch { fail('debug_odc_session_studio_unavailable'); }
  };
}
async function clientFacts() {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().ToString('O')`],
    { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
  const startedUtc = stdout.trim(); if (!Number.isFinite(Date.parse(startedUtc))) fail('debug_odc_session_private_client_unavailable');
  return { pid: process.pid, startedUtc };
}
export function exchangeOdcNativeSession({ pipeName, operationId, binding, receiptPath }, { connect = net.createConnection, timeoutMs = 85000 } = {}) {
  return new Promise((resolve, reject) => {
    let socket, retry, buffer = '', pending, submitted = false, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(retry); socket?.destroy(); buffer = ''; pending = undefined; error ? reject(new Error(error)) : resolve(value); };
    const timer = setTimeout(() => finish('debug_odc_session_exchange_uncertain'), timeoutMs);
    const attempt = () => {
      try { socket = connect('\\\\.\\pipe\\' + pipeName); } catch { return finish('debug_odc_session_pipe_unavailable'); }
      const peer = socket; peer.setEncoding('utf8');
      peer.once('connect', () => {
        if (settled || peer !== socket) return;
        if (submitted) return finish('debug_odc_session_exchange_uncertain');
        submitted = true; peer.write(JSON.stringify({ operationId, binding }) + '\n');
      });
      peer.on('data', chunk => {
        if (settled || peer !== socket) return;
        buffer += chunk; if (Buffer.byteLength(buffer) > 131072) return finish('debug_odc_session_reply_invalid');
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n'); let reply;
          try { reply = JSON.parse(buffer.slice(0, end)); } catch { return finish('debug_odc_session_reply_invalid'); }
          buffer = buffer.slice(end + 1);
          if (pending) {
            if (reply?.ok !== true || reply.operationId !== operationId || reply.phase !== 'consumed' || Object.keys(reply).some(k => !['ok', 'operationId', 'phase'].includes(k))) return finish('debug_odc_session_reply_invalid');
            return finish(null, pending);
          }
          if (reply?.ok !== true || reply.operationId !== operationId || JSON.stringify(reply.binding) !== JSON.stringify(binding) || !validMetadata(reply.metadata, binding) ||
              Object.keys(reply).some(k => !['ok', 'operationId', 'binding', 'metadata', 'token'].includes(k)) ||
              binding.moduleKey && reply.metadata.moduleKey !== binding.moduleKey ||
              binding.includeToken && (typeof reply.token !== 'string' || !reply.token || Buffer.byteLength(reply.token) > 65536 || /[\x00-\x20\x7f]/.test(reply.token)) ||
              !binding.includeToken && reply.token !== undefined) return finish('debug_odc_session_reply_invalid');
          pending = reply; peer.write(JSON.stringify({ operationId }) + '\n', error => { if (error) finish('debug_odc_session_exchange_uncertain'); });
        }
      });
      peer.once('error', error => {
        if (settled || peer !== socket) return;
        let receipt; try { receipt = read(receiptPath); } catch { }
        if (receipt?.phase === 'failed') return finish(safe({ message: receipt.error }));
        if (!submitted && ['ENOENT', 'ECONNREFUSED'].includes(error.code) && !['uncertain', 'consumed', 'authenticating', 'delivered-unconfirmed'].includes(receipt?.phase)) {
          peer.removeAllListeners(); peer.destroy(); retry = setTimeout(attempt, 100);
        } else finish('debug_odc_session_exchange_uncertain');
      });
      peer.once('end', () => { if (!settled && peer === socket) finish('debug_odc_session_exchange_uncertain'); });
    }; attempt();
  });
}
export async function getOdcNativeSession(input, services = {}) {
  const request = odcSessionRequest(input);
  const pid = input.pid ?? await (services.studioPid ?? (await import('./lib.mjs')).studioPid)();
  const run = services.connector ?? await connector();
  const actual = await run(['describe', pid]);
  if (actual.pid !== pid || actual.diagnosticsAvailable !== true || !Number.isFinite(Date.parse(actual.startedUtc)) || !path.isAbsolute(actual.studioDir ?? '')) fail('debug_odc_session_studio_unavailable');
  const binding = { pid, ...request, startedUtc: actual.startedUtc, studioDir: actual.studioDir };
  if (input.expectedBinding && ['pid', 'host', 'startedUtc', 'studioDir'].some(k => input.expectedBinding[k] !== binding[k])) fail('debug_odc_session_process_changed');
  const operationId = input.operationId ?? randomUUID();
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId)) fail('debug_odc_session_contract_invalid');
  const dir = path.join(root, operationId), journal = path.join(dir, 'journal.json');
  if (fs.existsSync(journal)) fail('debug_odc_session_operation_already_submitted');
  fs.mkdirSync(dir, { recursive: true });
  const lockDir = path.join(root, 'locks'); fs.mkdirSync(lockDir, { recursive: true });
  const lock = path.join(lockDir, digest(JSON.stringify({ pid, host: binding.host, startedUtc: binding.startedUtc })) + '.json');
  let fd; try { fd = fs.openSync(lock, 'wx'); } catch { fail('debug_odc_session_binding_busy'); }
  fs.writeFileSync(fd, JSON.stringify({ operationId, journal })); fs.fsyncSync(fd); fs.closeSync(fd);
  const name = 'Anvil.OdcSessionHook.' + operationId.replaceAll('-', ''), out = path.join(dir, 'hook');
  const hook = path.join(out, name + '.dll'), receiptPath = hook + '.receipt.json';
  let attached = false, terminal = false;
  try {
    write(journal, { operationId, binding, receiptPath, phase: 'building' });
    await (services.build ?? build)(path.join(anvilRoot, 'tools', 'Anvil.OdcSessionHook', 'Anvil.OdcSessionHook.csproj'), out, ['-p:StudioDir=' + actual.studioDir, '-p:AssemblyName=' + name]);
    const current = await run(['describe', pid]);
    if (current.startedUtc !== actual.startedUtc || current.studioDir !== actual.studioDir) fail('debug_odc_session_process_changed');
    const client = await (services.clientFacts ?? clientFacts)();
    const config = { operationId, pipeName: 'ssam-odc-session-' + operationId, binding, clientPid: client.pid, clientStartedUtc: client.startedUtc, expiresAt: new Date(Date.now() + 90000).toISOString() };
    write(hook + '.json', config); write(journal, { operationId, binding, receiptPath, phase: 'attaching' }); attached = true;
    try { await run(['attach', pid, actual.startedUtc, hook]); } catch { /* Reconcile same component through its pipe; never attach twice. */ }
    const reply = await (services.exchange ?? exchangeOdcNativeSession)({ ...config, receiptPath });
    write(journal, { operationId, binding, receiptPath, phase: 'consumed', metadata: reply.metadata }); terminal = true;
    return reply;
  } catch (error) {
    let receipt; try { receipt = read(receiptPath); } catch { }
    terminal = !attached || receipt?.phase === 'failed';
    write(journal, { operationId, binding, receiptPath, phase: terminal ? 'failed' : 'uncertain', error: safe(error) }); fail(safe(error));
  } finally { if (terminal && fs.existsSync(lock) && read(lock).operationId === operationId) fs.unlinkSync(lock); }
}
export async function readOdcNativeApplication(input) {
  const reply = await getOdcNativeSession({ ...input, includeToken: false });
  return reply.metadata; // Latest revision is explicitly NOT proof of deployed revision.
}
