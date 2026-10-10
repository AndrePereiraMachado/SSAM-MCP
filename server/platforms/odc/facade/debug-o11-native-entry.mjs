// Broker for a reviewed original Reactive entry. It never rewrites login or role checks.
// Public handles expose receipts; the original runtime and credentials live only in a child process.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9_+]{22}$/;
const ID = /^[a-f0-9]{32}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,198}$/;
const SELECTOR = /^[A-Za-z_$][A-Za-z0-9_.$]{0,240}$/;
const deny = code => { throw new Error(code); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const workerPath = fileURLToPath(new URL('./debug-o11-native-entry-worker.mjs', import.meta.url));
const TARGET_FIELDS = ['lane', 'runtimeUrl', 'module', 'moduleKey', 'applicationKey', 'publishedVersionId', 'sourceSha256'];
export const o11NativePublicTarget = target => Object.fromEntries([...TARGET_FIELDS, 'host'].map(key =>
  [key, key === 'lane' ? 'o11' : key === 'host' ? new URL(target.runtimeUrl).hostname : target[key]]));
export function o11NativeDirectory(root, directory) {
  if (!path.isAbsolute(root ?? '') || !path.isAbsolute(directory ?? '')) deny('debug_o11_native_directory_denied');
  const scope = path.join(root, '.local', 'debugger'), relative = path.relative(scope, directory);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) deny('debug_o11_native_directory_denied');
  for (let current = directory; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) deny('debug_o11_native_directory_denied');
    if (current === root) return directory;
  }
  deny('debug_o11_native_directory_denied');
}
const PUBLIC_CODES = new Set(`source_required source_invalid source_unavailable source_changed target_mismatch entry_unsupported
  abi_invalid publication_changed publication_unproved assets_invalid root_required preparation_invalid directory_denied
  worker_unavailable session_busy execution_failed memory_storage_required session_invalid closed expired already_submitted
  request_denied headers_denied envelope_invalid login_contract_invalid entry_context_invalid response_origin_changed
  response_limit response_uncertain login_failed request_failed runtime_service_unsupported debugger_context_invalid
  cookie_contract_invalid output_contract_invalid anonymous_context_invalid credentials_unavailable login_rejected
  roles_unavailable login_identity_unavailable invocation_refused timeout result_unproved submission_refused
  operation_invalid parent_closed preparation_already_reserved worker_failed inventory_unproved scenario_invalid
  input_conversion_failed record_class_unresolved entry_kind_unsupported`.split(/\s+/).map(code => 'debug_o11_native_' + code));
export const o11NativePublicCode = (value, fallback = 'debug_o11_native_worker_failed') => PUBLIC_CODES.has(value) ? value : fallback;
const safeCode = o11NativePublicCode;

export function readO11NativeEntryContract(reference, target, action) {
  if (!reference || !path.isAbsolute(reference.path ?? '') || !SHA.test(reference.sha256 ?? '')) deny('debug_o11_native_source_required');
  const read = (pin, limit) => {
    if (!pin || !path.isAbsolute(pin.path ?? '') || !SHA.test(pin.sha256 ?? '')) deny('debug_o11_native_source_invalid');
    let bytes; try { bytes = fs.readFileSync(pin.path); } catch { deny('debug_o11_native_source_unavailable'); }
    if (bytes.length > limit || digest(bytes) !== pin.sha256) deny('debug_o11_native_source_changed');
    return bytes;
  };
  let value; try { value = JSON.parse(read(reference, 1024 * 1024)); } catch (error) { deny(safeCode(error.message)); }
  if (value.schema === 'ssam-o11-native-entry-source/2') return readGraphEntryContract(value, reference, target, action, read);
  if (value.schema !== 'ssam-o11-native-entry-source/1' || !value.target ||
      ['lane', 'runtimeUrl', 'module', 'moduleKey', 'applicationKey'].some(k => value.target[k] !== target[k]) ||
      ['publishedVersionId', 'sourceSha256'].some(k => target[k] !== undefined && value.target[k] !== target[k]) ||
      target.host !== undefined && value.target.host !== undefined && target.host !== value.target.host)
    deny('debug_o11_native_target_mismatch');
  target = o11NativePublicTarget(value.target);
  if (
      target.lane !== 'o11' || !NAME.test(target.module ?? '') || !KEY.test(target.moduleKey ?? '') || !KEY.test(target.applicationKey ?? '') ||
      !Number.isSafeInteger(target.publishedVersionId) || target.publishedVersionId < 1 || !SHA.test(target.sourceSha256 ?? '')) deny('debug_o11_native_target_mismatch');
  let url; try { url = new URL(target.runtimeUrl); } catch { deny('debug_o11_native_target_mismatch'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' + target.module + '/') deny('debug_o11_native_target_mismatch');
  if (!/^[a-f0-9-]{36}$/.test(value.nativeApplicationGuid ?? '') || !NAME.test(value.userProvider ?? '') ||
      !SELECTOR.test(value.applicationDefinition ?? '') || !value.login || !value.entry ||
      !NAME.test(action ?? '') || value.entry.action !== action || !KEY.test(value.entry.actionKey ?? '') || value.entry.inputsCount !== 0 ||
      value.entry.kind !== 'native-refresh' || !Array.isArray(value.entry.outputs) || value.entry.outputs.length < 1 || value.entry.outputs.length > 60)
    deny('debug_o11_native_entry_unsupported');
  for (const spec of [value.login, value.entry]) {
    if (![spec.modelFactory, spec.controllerFactory, spec.method].every(s => SELECTOR.test(s ?? '')) ||
        [spec.modelFactory, spec.controllerFactory, spec.method].some(s => ['__proto__', 'constructor', 'prototype'].includes(s)) ||
        !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(spec.viewName ?? '') || !KEY.test(spec.apiVersion ?? '') ||
        typeof spec.endpoint !== 'string' || !spec.endpoint.startsWith('/' + target.module + '/screenservices/') ||
        /[?#\\\x00-\x20]/.test(spec.endpoint) || new URL(spec.endpoint, target.runtimeUrl).pathname !== spec.endpoint) deny('debug_o11_native_abi_invalid');
  }
  if (!SELECTOR.test(value.entry.dataProperty ?? '') || value.login.endpoint === value.entry.endpoint ||
      new Set(value.entry.outputs.map(o => o.name)).size !== value.entry.outputs.length ||
      value.entry.outputs.some(o => !NAME.test(o.name ?? '') || !SELECTOR.test(o.attribute ?? '') || o.type !== 'Boolean'))
    deny('debug_o11_native_abi_invalid');
  read(value.snapshot, 100 * 1024 * 1024);
  if (value.snapshot.sha256 !== target.sourceSha256) deny('debug_o11_native_source_changed');
  const manifest = JSON.parse(read(value.moduleInfo, 5 * 1024 * 1024));
  if (manifest.manifest?.versionSequence !== target.publishedVersionId || !manifest.manifest.versionToken || !manifest.data?.modules)
    deny('debug_o11_native_publication_changed');
  const publication = JSON.parse(read(value.publicationReceipt, 5 * 1024 * 1024));
  if (publication.ok !== true || publication.state !== 'published' || publication.versionId !== target.publishedVersionId ||
      publication.moduleKey !== target.moduleKey || publication.candidateSha256 !== target.sourceSha256)
    deny('debug_o11_native_publication_unproved');
  if (!Array.isArray(value.assets) || value.assets.length < 3 || value.assets.length > 64 ||
      new Set(value.assets.map(a => a.name)).size !== value.assets.length || !value.assets.some(a => a.name === 'OutSystems.js'))
    deny('debug_o11_native_assets_invalid');
  for (const asset of value.assets) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,240}\.js$/.test(asset.name ?? '') || typeof asset.execute !== 'boolean' ||
        asset.urlPath !== '/' + target.module + '/scripts/' + asset.name ||
        manifest.manifest.urlVersions?.[asset.urlPath] !== asset.query || typeof asset.query !== 'string' || !asset.query.startsWith('?'))
      deny('debug_o11_native_assets_invalid');
    read(asset, 5 * 1024 * 1024);
  }
  return { ...value, target, contractSha256: reference.sha256, manifest };
}

// v2: an entry chosen by the deterministic call-graph resolver (debug-o11-entry-graph.mjs) over the published model
// and the published assets. No publication receipt: nothing is published; the published identity is the fresh
// inventory row, the downloaded published capture and the runtime moduleinfo of that same version.
const DATA_TYPE_NAMES = new Set(['Integer', 'LongInteger', 'Decimal', 'Currency', 'Text', 'PhoneNumber', 'Email', 'Boolean', 'Date', 'DateTime',
  'Time', 'Record', 'RecordList', 'BinaryData', 'Object']);
const ENTRY_KINDS = new Set(['server-stub', 'data-action', 'client-action']);
const UNSAFE = ['__proto__', 'constructor', 'prototype'];
function readGraphEntryContract(value, reference, target, action, read) {
  if (!value.target || ['lane', 'runtimeUrl', 'module', 'moduleKey', 'applicationKey'].some(k => value.target[k] !== target[k]) ||
      ['publishedVersionId', 'sourceSha256'].some(k => target[k] !== undefined && value.target[k] !== target[k]) ||
      target.host !== undefined && value.target.host !== undefined && target.host !== value.target.host) deny('debug_o11_native_target_mismatch');
  target = o11NativePublicTarget(value.target);
  if (!NAME.test(target.module ?? '') || !KEY.test(target.moduleKey ?? '') || !KEY.test(target.applicationKey ?? '') ||
      !Number.isSafeInteger(target.publishedVersionId) || target.publishedVersionId < 1 || !SHA.test(target.sourceSha256 ?? '')) deny('debug_o11_native_target_mismatch');
  let url; try { url = new URL(target.runtimeUrl); } catch { deny('debug_o11_native_target_mismatch'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' + target.module + '/') deny('debug_o11_native_target_mismatch');
  const entry = value.entry, login = value.login;
  if (!/^[a-f0-9-]{36}$/.test(value.nativeApplicationGuid ?? '') || !NAME.test(value.userProvider ?? '') || !SELECTOR.test(value.applicationDefinition ?? '') ||
      typeof action !== 'string' || value.selector !== action || !entry || !login || !ENTRY_KINDS.has(entry.kind)) deny('debug_o11_native_entry_unsupported');
  const endpointOk = endpoint => typeof endpoint === 'string' && endpoint.startsWith('/' + target.module + '/screenservices/') &&
    !/[?#\\\x00-\x20]/.test(endpoint) && new URL(endpoint, target.runtimeUrl).pathname === endpoint;
  const factoriesOk = spec => [spec.modelFactory, spec.controllerFactory].every(s => SELECTOR.test(s ?? '') && !UNSAFE.includes(s)) &&
    /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(spec.viewName ?? '');
  if (!factoriesOk(login) || !SELECTOR.test(login.method ?? '') || UNSAFE.includes(login.method) || !KEY.test(login.apiVersion ?? '') || !endpointOk(login.endpoint))
    deny('debug_o11_native_abi_invalid');
  if (!SELECTOR.test(entry.controller ?? '') || typeof entry.moduleLevel !== 'boolean' || !SELECTOR.test(entry.method ?? '') || UNSAFE.includes(entry.method) ||
      (!entry.moduleLevel && !factoriesOk(entry)) || (entry.actionKey !== null && entry.actionKey !== undefined && !KEY.test(entry.actionKey)) ||
      !Array.isArray(entry.endpoints) || entry.endpoints.length > 64 || !entry.endpoints.every(endpointOk) || entry.endpoints.includes(login.endpoint) ||
      (entry.kind !== 'client-action' && (!entry.endpoints.includes(entry.endpoint) || !KEY.test(entry.apiVersion ?? ''))) ||
      (entry.kind === 'data-action' && !SELECTOR.test(entry.dataProperty ?? '')) ||
      !Array.isArray(entry.inputs) || entry.inputs.length > 60 || !Array.isArray(entry.outputs) || entry.outputs.length > 120 ||
      entry.inputs.some(i => !NAME.test(i.name ?? '') || !/^[A-Za-z_$][\w$]*$/.test(i.param ?? '') || !DATA_TYPE_NAMES.has(i.dataType) ||
        i.recordClass !== undefined && i.recordClass !== null && !SELECTOR.test(i.recordClass)) ||
      new Set(entry.inputs.map(i => i.name)).size !== entry.inputs.length ||
      entry.outputs.some(o => !NAME.test(o.name ?? '') || !SELECTOR.test(o.attribute ?? '') || !DATA_TYPE_NAMES.has(o.dataType)) ||
      (entry.screenVariables ?? []).some(v => !NAME.test(v.name ?? '') || !SELECTOR.test(v.attribute ?? '') || !DATA_TYPE_NAMES.has(v.dataType)))
    deny('debug_o11_native_abi_invalid');
  read(value.snapshot, 200 * 1024 * 1024);
  if (value.snapshot.sha256 !== target.sourceSha256) deny('debug_o11_native_source_changed');
  const manifest = JSON.parse(read(value.moduleInfo, 5 * 1024 * 1024));
  if (manifest.manifest?.versionSequence !== target.publishedVersionId || !manifest.manifest.versionToken || !manifest.data?.modules)
    deny('debug_o11_native_publication_changed');
  const inventory = JSON.parse(read(value.inventoryProof, 5 * 1024 * 1024));
  const rows = inventory.modules?.filter(m => m.Key === target.moduleKey) ?? [];
  if (rows.length !== 1 || rows[0].VersionId !== target.publishedVersionId || rows[0].IsActive !== true || rows[0].Name !== target.module ||
      rows[0].ApplicationKey !== target.applicationKey) deny('debug_o11_native_inventory_unproved');
  if (!Array.isArray(value.assets) || value.assets.length < 3 || value.assets.length > 256 ||
      new Set(value.assets.map(a => a.name)).size !== value.assets.length || !value.assets.some(a => a.name === 'OutSystems.js'))
    deny('debug_o11_native_assets_invalid');
  for (const asset of value.assets) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,240}\.js$/.test(asset.name ?? '') || typeof asset.execute !== 'boolean' ||
        asset.urlPath !== '/' + target.module + '/scripts/' + asset.name ||
        manifest.manifest.urlVersions?.[asset.urlPath] !== asset.query || typeof asset.query !== 'string' || !asset.query.startsWith('?'))
      deny('debug_o11_native_assets_invalid');
    read(asset, 8 * 1024 * 1024);
  }
  return { ...value, version: 2, target, contractSha256: reference.sha256, manifest };
}

export function createO11NativeEntryBroker({ root, spawnImpl = spawn } = {}) {
  if (!path.isAbsolute(root ?? '')) deny('debug_o11_native_root_required');
  return { async prepare({ target, sourceContract, action, sessionId, timeoutSeconds = 120, directory }) {
    try {
      if (target.host && target.host !== new URL(target.runtimeUrl).hostname) deny('debug_o11_native_target_mismatch');
      target = o11NativePublicTarget(target);
    } catch { deny('debug_o11_native_target_mismatch'); }
    sourceContract = { path: sourceContract?.path, sha256: sourceContract?.sha256 };
    target = readO11NativeEntryContract(sourceContract, target, action).target; // Published identity comes from the pinned contract before the prompt.
    if (!ID.test(sessionId ?? '') || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 300 ||
        !path.isAbsolute(directory ?? '') || !fs.existsSync(workerPath)) deny('debug_o11_native_preparation_invalid');
    o11NativeDirectory(root, directory);
    let report = { ok: false, phase: 'preparing', browser: false, serverTraceProved: false, userRequestIsolationProved: false };
    let busy = false, closed = false, sequence = 0, pending, buffer = '', submissionHandler, workerReceiptPath, submissions = 0, maxSubmissions = 1, exitObserved = false;
    const sameReceiptScope = value => value?.schema === 'ssam-o11-native-entry-receipt/1' && value.sessionId === sessionId &&
      TARGET_FIELDS.every(key => value.target?.[key] === target[key]) && value.target.host === target.host &&
      value.sourceContract?.path === sourceContract.path && value.sourceContract.sha256 === sourceContract.sha256;
    const child = spawnImpl(process.execPath, ['--experimental-webstorage', workerPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let resolveExit; const exited = new Promise(resolve => { resolveExit = resolve; });
    child.once('exit', () => { exitObserved = true; resolveExit(); });
    const terminate = async () => {
      closed = true; child.stdin.end();
      const wait = async milliseconds => { let timer; try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
        finally { clearTimeout(timer); } };
      if (!exitObserved) await wait(1000);
      if (!exitObserved && child.kill() !== false) await wait(4000);
      report.workerExited = exitObserved;
      if (!exitObserved) { report.memoryCleared = false; report.nativeContextReferencesReleased = false; }
      return exitObserved;
    };
    child.stdin.on('error', () => {}); child.stdout.setEncoding('utf8');
    const rejectPending = () => { if (pending) { clearTimeout(pending.timer); pending.reject(new Error('debug_o11_native_worker_unavailable')); pending = undefined; } };
    child.once('error', rejectPending); child.once('exit', rejectPending);
    child.stdout.on('data', data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 1024 * 1024) { buffer = ''; child.kill(); rejectPending(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let reply; try { reply = JSON.parse(line); } catch { child.kill(); rejectPending(); return; }
        if (reply.kind === 'submission' && pending?.op === 'invoke' && reply.id === pending.id &&
            (KEY.test(reply.submission?.actionKey ?? '') || /^\/[A-Za-z_][A-Za-z0-9_]*\/screenservices\/[A-Za-z0-9_/]+$/.test(reply.submission?.endpoint ?? ''))) {
          // v1: exactly one submission per invoke; v2 (scenario): every POST of the scenario, bounded.
          if (typeof submissionHandler !== 'function' || ++submissions > maxSubmissions) { child.kill(); rejectPending(); return; }
          const seq = Number.isSafeInteger(reply.seq) ? { seq: reply.seq } : {};
          Promise.resolve().then(() => submissionHandler?.(reply.submission)).then(
            () => child.stdin.write(JSON.stringify({ op: 'submission-ack', id: reply.id, ...seq, accepted: true }) + '\n'),
            () => child.stdin.write(JSON.stringify({ op: 'submission-ack', id: reply.id, ...seq, accepted: false }) + '\n'));
          continue;
        }
        if (!pending || reply.id !== pending.id || typeof reply.ok !== 'boolean') { child.kill(); rejectPending(); return; }
        const current = pending; pending = undefined; clearTimeout(current.timer);
        if (reply.receipt) {
          if (!sameReceiptScope(reply.receipt)) { child.kill(); current.reject(new Error('debug_o11_native_worker_failed')); return; }
          report = reply.receipt;
          if (reply.receiptPath === path.join(directory, 'native-entry-receipt.json')) workerReceiptPath = reply.receiptPath;
        }
        reply.ok ? current.resolve(reply) : current.reject(new Error(safeCode(reply.error)));
      }
    });
    const rpc = async (op, payload, milliseconds = (timeoutSeconds + 15) * 1000) => {
      if (closed || busy) deny('debug_o11_native_session_busy');
      busy = true;
      try { return await new Promise((resolve, reject) => {
        const id = ++sequence;
        pending = { id, op, resolve, reject, timer: setTimeout(() => { child.kill(); rejectPending(); }, milliseconds) };
        child.stdin.write(JSON.stringify({ id, op, input: payload }) + '\n');
      }); } finally { busy = false; }
    };
    try {
      const prepared = await rpc('prepare', { root, target, sourceContract, action, sessionId, timeoutSeconds, directory });
      const receiptPath = prepared.receiptPath;
      return Object.freeze({ receiptPath, receipt: () => structuredClone(report),
        authenticate: descriptor => rpc('authenticate', { descriptor }),
        invoke: async ({ beforeRequest, scenario } = {}) => {
          // The child's real outgoing request waits for accounting, before its fetch.
          if (typeof beforeRequest !== 'function') deny('debug_o11_native_submission_refused');
          submissionHandler = beforeRequest; submissions = 0; maxSubmissions = scenario ? 20 : 1;
          try { return await rpc('invoke', scenario ? { scenario } : {}); } finally { submissionHandler = undefined; }
        },
        dispose: async () => {
          if (closed) return { ok: true, ...structuredClone(report) };
          try { await rpc('dispose', {}, 15000); }
          finally { await terminate(); }
          return { ok: report.workerExited === true, ...structuredClone(report) };
        } });
    } catch (error) {
      await terminate();
      const failure = new Error(safeCode(error.message));
      if (sameReceiptScope(report) && report.prepared === false && report.phase === 'disposed' &&
          report.memoryCleared === true && report.nativeContextReferencesReleased === true && report.workerExited === true &&
          report.loginUncertain === false && report.requestUncertain === false && workerReceiptPath &&
          ['loginSubmittedCount', 'loginAnsweredCount', 'requestSubmittedCount', 'requestAnsweredCount'].every(key => report[key] === 0)) {
        const cleared = structuredClone(report);
        failure.nativeEntryCleanupHandle = Object.freeze({ receiptPath: workerReceiptPath,
          receipt: () => structuredClone(cleared), dispose: async () => structuredClone(cleared) });
      }
      throw failure;
    }
  } };
}
