// INTERNAL ONLY: bearer and native SSO SOAP context belong exclusively in the debugger's private stdin bootstrap.
// This module is never a MCP/CLI tool and never logs tokens or returns private context to public tools.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { anvilRoot, workspaceRoot } from './workspace.mjs';

const exec = promisify(execFile);
const root = path.join(workspaceRoot, '.local', 'debugger', 'o11-auth');
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const KEY = /^[A-Za-z0-9_+]{22}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,198}$/;
const DIAGNOSTICS = ['decodeSucceeded', 'notBeforeValid', 'expirationValid', 'timeValid', 'allowDebugTarget', 'allowDebugEntry'];
const privateText = (value, chars, bytes) => typeof value === 'string' && value.trim().length > 0 && value.length <= chars
  && Buffer.byteLength(value) <= bytes && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const safeDiagnostics = value => value === undefined || value && !Array.isArray(value) && typeof value === 'object'
  && Object.keys(value).length === DIAGNOSTICS.length && DIAGNOSTICS.every(key => typeof value[key] === 'boolean');
const safePreflight = value => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === 3
  && value.pingSucceeded === true && value.inDebug === true && value.debuggerVersion === 1;
const fail = code => { throw new Error(code); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = value => createHash('sha256').update(value).digest('hex');
const write = (file, value) => { fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); };
const field = (value, name) => Object.entries(value ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
const targets = binding => [binding, ...(binding.entry ? [binding.entry] : [])];

export function o11DebugAuthTarget(input) {
  for (const name of ['operationId', 'pid', 'host', 'module', 'moduleKey', 'applicationKey', 'publishedVersionId', 'sessionId', 'publishedProof'])
    if (input?.[name] === undefined) fail('debug_o11_token_contract_missing_' + name.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase()));
  let origin; try { origin = new URL('https://' + input.host + '/'); } catch { fail('debug_o11_token_contract_invalid'); }
  if (input.authDiagnostics !== undefined && typeof input.authDiagnostics !== 'boolean') fail('debug_o11_token_contract_invalid');
  if (!GUID.test(input.operationId) || !Number.isSafeInteger(input.pid) || input.pid < 1 ||
      origin.hostname !== input.host || origin.host !== input.host || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash ||
      !/^[a-f0-9]{32}$/.test(input.sessionId) || !input.publishedProof || !path.isAbsolute(input.publishedProof.path ?? '') || !/^[a-f0-9]{64}$/.test(input.publishedProof.sha256 ?? '')) fail('debug_o11_token_contract_invalid');
  const target = value => {
    if (!NAME.test(value?.module ?? '') || !KEY.test(value?.moduleKey ?? '') || !KEY.test(value?.applicationKey ?? '') || !Number.isSafeInteger(value?.publishedVersionId) || value.publishedVersionId < 1) fail('debug_o11_module_scope_missing');
    return { module: value.module, moduleKey: value.moduleKey, applicationKey: value.applicationKey, publishedVersionId: value.publishedVersionId };
  };
  return { pid: input.pid, host: input.host, ...target(input), sessionId: input.sessionId, ...(input.entry ? { entry: target(input.entry) } : {}) };
}

export function validateO11PublicationProof(binding, proof, time = Date.now()) {
  const captured = Date.parse(field(proof, 'capturedAtUtc'));
  if (!Number.isFinite(captured) || captured > time + 30000 || captured < time - 900000) fail('debug_o11_publication_proof_stale');
  if (field(proof, 'host')?.toLowerCase() !== binding.host || !Array.isArray(field(proof, 'modules'))) fail('debug_o11_publication_proof_invalid');
  for (const target of targets(binding)) {
    const matching = field(proof, 'modules').filter(row => field(row, 'Key') === target.moduleKey);
    if (matching.length !== 1 || field(matching[0], 'Name') !== target.module || field(matching[0], 'ApplicationKey') !== target.applicationKey ||
        field(matching[0], 'VersionId') !== target.publishedVersionId || field(matching[0], 'IsActive') !== true) fail('debug_o11_module_scope_mismatch');
  }
  return true;
}

function readProof(input, binding) {
  let bytes, value;
  try { bytes = fs.readFileSync(input.publishedProof.path); value = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { fail('debug_o11_publication_proof_invalid'); }
  if (bytes.length > 8 * 1024 * 1024 || hash(bytes) !== input.publishedProof.sha256) fail('debug_o11_publication_proof_changed');
  validateO11PublicationProof(binding, value);
}

export function reconcileO11DebugAuth(journal, receipt, expectedBinding) {
  if (JSON.stringify(journal?.binding) !== JSON.stringify(expectedBinding)) fail('debug_o11_module_scope_mismatch');
  if (receipt?.phase === 'consumed' || journal.phase === 'consumed') fail('debug_o11_token_already_consumed');
  if (receipt?.phase === 'failed') return { state: 'failed', error: /^debug_o11_[a-z_]+$/.test(receipt.error ?? '') ? receipt.error : 'debug_o11_token_exchange_unavailable' };
  return { state: 'uncertain', error: 'debug_o11_token_attach_uncertain' };
}

async function buildProject(project, out, extra = []) {
  try {
    await exec('dotnet', ['build', project, '-c', 'Release', '--nologo', '-v', 'quiet', '--artifacts-path', out + '-artifacts', '-o', out, ...extra],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 180000 });
  } catch { fail('debug_o11_auth_hook_build_failed'); }
}

async function connector() {
  // Same current source hash as the existing connector; never replace a loaded bridge.
  const project = path.join(anvilRoot, 'tools', 'Anvil.Connect');
  const sourceHash = createHash('sha256').update(fs.readFileSync(path.join(project, 'Program.cs'))).update(fs.readFileSync(path.join(project, 'Anvil.Connect.csproj'))).digest('hex').slice(0, 20);
  const out = path.join(anvilRoot, '.local', 'runtime-connect', 'client-' + sourceHash), dll = path.join(out, 'Anvil.Connect.dll');
  if (!fs.existsSync(path.join(out, 'ready.json'))) {
    await buildProject(path.join(project, 'Anvil.Connect.csproj'), out);
    write(path.join(out, 'ready.json'), { hash: sourceHash });
  }
  return async args => {
    try {
      const { stdout } = await exec('dotnet', [dll, ...args.map(String)], { windowsHide: true, timeout: 30000, maxBuffer: 65536 });
      const result = JSON.parse(stdout.trim());
      if (!result.ok) fail('debug_o11_studio_operation_failed');
      return result;
    } catch { fail('debug_o11_studio_operation_failed'); }
  };
}

async function clientFacts() {
  try {
    const command = `[Diagnostics.Process]::GetProcessById(${process.pid}).StartTime.ToUniversalTime().ToString('O')`;
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
    const startedUtc = stdout.trim();
    if (!Number.isFinite(Date.parse(startedUtc))) fail('debug_o11_private_client_unavailable');
    return { pid: process.pid, startedUtc };
  } catch { fail('debug_o11_private_client_unavailable'); }
}

// Sole secret channel: this reply is consumed inside the private debugger controller.
export function exchangeO11DebugToken({ pipeName, operationId, binding, receiptPath }, { connect = net.createConnection, timeoutMs = 85000 } = {}) {
  return new Promise((resolve, reject) => {
    let socket, retry, data = '', pendingReply, settled = false, requestSubmitted = false;
    const deadline = Date.now() + timeoutMs;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(retry); socket?.destroy(); data = ''; pendingReply = undefined; error ? reject(new Error(error)) : resolve(result); };
    const timer = setTimeout(() => finish('debug_o11_token_exchange_uncertain'), timeoutMs);
    const attempt = () => {
      if (settled) return;
      try { socket = connect('\\\\.\\pipe\\' + pipeName); } catch { finish('debug_o11_private_pipe_unavailable'); return; }
      const peer = socket;
      peer.setEncoding('utf8');
      peer.once('connect', () => {
        if (settled || peer !== socket) return;
        if (requestSubmitted) return finish('debug_o11_token_exchange_uncertain');
        // Set this before writing: a write error cannot prove that the hook did not
        // receive the request. No second connection/request is allowed afterwards.
        requestSubmitted = true;
        peer.write(JSON.stringify({ operationId, binding }) + '\n');
      });
      peer.on('data', chunk => {
        if (settled || peer !== socket) return;
        data += chunk;
        // Two independently bounded private tokens plus JSON escaping and public target metadata.
        if (Buffer.byteLength(data) > 524288) return finish('debug_o11_token_response_invalid');
        while (data.includes('\n')) {
          const end = data.indexOf('\n');
          let reply; try { reply = JSON.parse(data.slice(0, end)); } catch { return finish('debug_o11_token_response_invalid'); }
          data = data.slice(end + 1);
          if (pendingReply) {
            if (reply.ok !== true || reply.operationId !== operationId || reply.phase !== 'consumed'
                || Object.keys(reply).some(key => !['ok', 'operationId', 'phase'].includes(key))) return finish('debug_o11_token_response_invalid');
            return finish(null, pendingReply);
          }
          if (reply.ok !== true || reply.operationId !== operationId || reply.newAuthentication !== true || !['oauth', 'server-identity', 'identity-service'].includes(reply.path)
              || Object.keys(reply).some(key => !['ok', 'operationId', 'binding', 'newAuthentication', 'path', 'token', 'soapUser', 'soapSecret', 'diagnostics', 'preflight'].includes(key)) ||
              JSON.stringify(reply.binding) !== JSON.stringify(binding) || !privateText(reply.token, 65536, 65536)
              || !privateText(reply.soapUser, 512, 2048) || !privateText(reply.soapSecret, 65536, 65536)
              || !safeDiagnostics(reply.diagnostics) || !safePreflight(reply.preflight)) return finish('debug_o11_token_response_invalid');
          pendingReply = reply;
          // Ack contains no bearer. Wait for the hook's metadata confirmation; a
          // lost ACK/confirmation remains uncertain even when the token arrived.
          peer.write(JSON.stringify({ operationId }) + '\n', error => { if (error) finish('debug_o11_token_exchange_uncertain'); });
        }
      });
      peer.once('error', error => {
        if (settled || peer !== socket) return;
        let receipt; try { receipt = read(receiptPath); } catch { }
        if (receipt?.phase === 'failed') return finish(/^debug_o11_[a-z_]+$/.test(receipt.error ?? '') ? receipt.error : 'debug_o11_token_exchange_unavailable');
        // Waiting for the same hook's pipe is not another attach or authentication request.
        if (!requestSubmitted && !['authenticating', 'preflighting', 'minting', 'delivered-unconfirmed', 'uncertain', 'consumed'].includes(receipt?.phase) &&
            ['ENOENT', 'ECONNREFUSED'].includes(error.code) && Date.now() < deadline) { peer.removeAllListeners(); peer.destroy(); retry = setTimeout(attempt, 100); }
        else finish('debug_o11_token_exchange_uncertain');
      });
      peer.once('end', () => { if (!settled && peer === socket) finish('debug_o11_token_exchange_uncertain'); });
    };
    attempt();
  });
}

export async function getO11DebugToken(input, services = {}) {
  const requested = o11DebugAuthTarget(input);
  readProof(input, requested);
  const runConnector = services.describe && services.attach ? null : await connector();
  const describe = services.describe ?? (pid => runConnector(['describe', pid]));
  const attach = services.attach ?? (({ pid, startedUtc, hook }) => runConnector(['attach', pid, startedUtc, hook]));
  const actual = await describe(requested.pid);
  if (actual.pid !== requested.pid || !Number.isFinite(Date.parse(actual.startedUtc)) || !path.isAbsolute(actual.studioDir ?? '') || actual.diagnosticsAvailable !== true) fail('debug_o11_studio_target_unavailable');
  const binding = { ...requested, startedUtc: actual.startedUtc };
  if (input.startedUtc !== undefined && input.startedUtc !== actual.startedUtc) fail('debug_o11_process_changed');
  const dir = path.join(root, input.operationId), journalPath = path.join(dir, 'journal.json');
  const assemblyName = 'Anvil.DebugTokenHook.' + input.operationId.replaceAll('-', ''), out = path.join(dir, 'hook');
  const hook = path.join(out, assemblyName + '.dll'), receiptPath = hook + '.receipt.json';
  if (fs.existsSync(journalPath)) {
    let receipt; try { receipt = read(receiptPath); } catch { }
    const reconciled = reconcileO11DebugAuth(read(journalPath), receipt, binding);
    fail(reconciled.error);
  }
  fs.mkdirSync(dir, { recursive: true });
  const lockRoot = path.join(root, 'locks'); fs.mkdirSync(lockRoot, { recursive: true });
  const lockTarget = { pid: binding.pid, startedUtc: binding.startedUtc, host: binding.host, moduleKey: binding.moduleKey, applicationKey: binding.applicationKey,
    ...(binding.entry ? { entryModuleKey: binding.entry.moduleKey, entryApplicationKey: binding.entry.applicationKey } : {}) };
  const lock = path.join(lockRoot, hash(JSON.stringify(lockTarget)) + '.json');
  let handle; try { handle = fs.openSync(lock, 'wx'); } catch { fail('debug_o11_token_target_has_operation'); }
  fs.writeFileSync(handle, JSON.stringify({ operationId: input.operationId, journalPath, receiptPath })); fs.closeSync(handle);
  let submitted = false, terminal = false;
  try {
    write(journalPath, { operationId: input.operationId, binding, phase: 'preparing', receiptPath });
    await (services.build ?? buildProject)(path.join(anvilRoot, 'tools', 'Anvil.DebugTokenHook', 'Anvil.DebugTokenHook.csproj'), out,
      ['-p:StudioDir=' + actual.studioDir, '-p:AssemblyName=' + assemblyName]);
    const current = await describe(binding.pid);
    if (current.startedUtc !== binding.startedUtc || current.studioDir !== actual.studioDir) fail('debug_o11_process_changed');
    readProof(input, binding);
    const client = await (services.clientFacts ?? clientFacts)();
    if (!Number.isSafeInteger(client.pid) || client.pid < 1 || !Number.isFinite(Date.parse(client.startedUtc))) fail('debug_o11_private_client_unavailable');
    const config = { operationId: input.operationId, pipeName: 'ssam-o11-debug-token-' + input.operationId, binding, publishedProof: input.publishedProof,
      clientPid: client.pid, clientStartedUtc: client.startedUtc, expiresAt: new Date(Date.now() + 90000).toISOString(), authDiagnostics: input.authDiagnostics === true };
    write(hook + '.json', config);
    write(journalPath, { operationId: input.operationId, binding, phase: 'attaching', receiptPath });
    submitted = true;
    let attachFailed = false;
    try { await attach({ pid: binding.pid, startedUtc: binding.startedUtc, hook }); } catch { attachFailed = true; }
    // Even an uncertain attach is reconciled through its same pipe/receipt, never submitted again.
    const reply = await (services.exchange ?? exchangeO11DebugToken)({ pipeName: config.pipeName, operationId: input.operationId, binding, receiptPath, attachFailed });
    write(journalPath, { operationId: input.operationId, binding, phase: 'consumed', receiptPath });
    terminal = true;
    return reply; // PRIVATE bearer + SSO SOAP fields: consumed only through the debugger bootstrap pipe.
  } catch (error) {
    let receipt; try { receipt = read(receiptPath); } catch { }
    terminal = !submitted || receipt?.phase === 'failed';
    write(journalPath, { operationId: input.operationId, binding, phase: terminal ? 'failed' : 'uncertain', receiptPath,
      error: /^debug_o11_[a-z_]+$/.test(error.message ?? '') ? error.message : 'debug_o11_token_exchange_unavailable' });
    fail(/^debug_o11_[a-z_]+$/.test(error.message ?? '') ? error.message : 'debug_o11_token_exchange_unavailable');
  } finally {
    if (terminal && fs.existsSync(lock) && read(lock).operationId === input.operationId) fs.unlinkSync(lock);
  }
}
