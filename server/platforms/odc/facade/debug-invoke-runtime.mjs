import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { workspaceRoot } from './workspace.mjs';
import { invokeSchema } from './debug-invoke.mjs';
import { digest, fail, filterOutput, validateInputs, describeParameters } from './debug-invoke-contract.mjs';
import { prepareBrowserPlan } from './debug-invoke-browser.mjs';
import { privateRequest, runHeadlessHttp, checkNativeRequest } from './debug-invoke-http.mjs';
import { headlessDebug } from './debug-runtime.mjs';

export const invokeRoot = path.join(workspaceRoot, '.local', 'debugger', 'invocations');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function writeReceipt(file, value) { fs.writeFileSync(file + '.tmp', JSON.stringify(value)); fs.renameSync(file + '.tmp', file); }
const planFile = id => path.join(invokeRoot, 'plans', id + '.json');
const operationDir = id => path.join(invokeRoot, 'runs', id);
function readPlan(id) { const p = read(planFile(id)); if (p.forgotten || p.planId !== id || p.hash !== digest(p.contract)) fail('invoke_plan_invalid'); return p; }
const safeError = e => /^(?:invoke|debug)_[a-z_-]+/.exec(e?.message ?? '')?.[0] ?? 'invoke_control_failed';
export async function resolveAction(input) {
  const { moduleMap, sha256Of } = await import('./module-map.mjs');
  if (!/\.oml$/i.test(input.snapshot) || sha256Of(input.snapshot).toLowerCase() !== input.expectedSourceSha256.toLowerCase()) fail('invoke_snapshot_changed');
  const map = await moduleMap({ target: input.snapshot, lane: 'odc', key: '@' + input.actionKey, max: 1, budgetBytes: 12000, expectedSourceSha256: input.expectedSourceSha256 });
  if (!map.ok || map.entries?.length !== 1 || !map.searchComplete) fail('invoke_action_not_resolved');
  const action = map.entries[0], module = map.module.name;
  if (![module, action.name].every(n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) fail('invoke_native_name_unsupported');
  let metadata; try { metadata = read(input.snapshot + '.json'); } catch { fail('invoke_capture_environment_missing'); }
  if (!metadata.host || metadata.sha256?.toLowerCase() !== input.expectedSourceSha256.toLowerCase()) fail('invoke_capture_environment_missing');
  const tenant = new URL(metadata.host.includes('://') ? metadata.host : 'https://' + metadata.host).hostname;
  return { module, moduleKey: map.module.key, actionKey: action.key, action: action.name, kind: action.kind, nativePath: action.path, tenant, sourceSha256: map.sourceSha256 };
}
export function selectNativeEntry(identity, input = {}) {
  const { module, action, kind, nativePath } = identity;
  let entryPath;
  if (kind === 'DataAction') {
    // Published ODC blocks own DataActions just like screens. Match the immediate native owner,
    // rather than borrowing the name of a screen from an ancestor or resolving a display label.
    const owner = /(?:^|\/)MobileFlow:([^/]+)\/(?:MobileScreen|MobileBlock):([^/]+)\/DataAction:([^/]+)$/.exec(nativePath);
    if (!owner || owner[3] !== action || ![module, action, owner[1], owner[2]].every(n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) fail('invoke_entry_not_resolved');
    entryPath = '/' + module + '/screenservices/' + module + '/' + owner[1] + '/' + owner[2] + '/DataAction' + action;
  } else if (kind === 'ServerAction') {
    // Convention is only a selector for passive observation, never a guessed URL that we call.
    entryPath = input.entryPath ?? '/' + module + '/screenservices/' + module + '/' + action;
    if (!entryPath.startsWith('/' + module + '/screenservices/' + module + '/') || entryPath.split('/').at(-1) !== action) fail('invoke_entry_action_mismatch');
  } else fail(kind === 'ServiceAction' ? 'invoke_service_action_requires_native_environment_caller' : 'invoke_action_has_no_browser_entry');
  if (input.entryPath && input.entryPath !== entryPath) fail('invoke_entry_action_mismatch');
  return { ...identity, entryPath };
}
export async function resolveEntry(input) {
  return selectNativeEntry(await resolveAction(input), input);
}
async function prepare(input) {
  const identity = await resolveEntry(input), planId = randomUUID();
  const target = input.target ? await resolveAction(input.target) : null;
  if (target && (!['ServerAction', 'ServiceAction', 'DataAction'].includes(target.kind) || target.tenant !== identity.tenant)) fail('invoke_target_action_unbound');
  let captured;
  if (input.requestFile || input.sourcePlanId) {
    if (input.sourcePlanId) {
      const source = readPlan(input.sourcePlanId);
      if (source.origin !== input.origin || digest(source.identity) !== digest(identity)) fail('invoke_source_plan_mismatch');
      const native = await privateRequest('Open', source.planId); checkNativeRequest(native, identity, input.origin);
      await privateRequest('Seal', planId, native);
    } else await privateRequest('Import', planId, null, input.requestFile);
    const native = await privateRequest('Open', planId); checkNativeRequest(native, identity, input.origin);
    const parameterDiscovery = { scope: input.inputPaths.length ? 'selected-paths' : 'automatic-scalars', complete: true };
    captured = { parameters: describeParameters(native.body, input.inputPaths, parameterDiscovery), parameterDiscovery };
  } else captured = await prepareBrowserPlan(input, identity, planId);
  const contract = { identity, target, targetSnapshot: input.target ? path.resolve(input.target.snapshot) : null, parameters: captured.parameters, parameterDiscovery: captured.parameterDiscovery, origin: input.origin, snapshot: path.resolve(input.snapshot), outputPaths: input.outputPaths, transport: 'headless-http' };
  const plan = { schema: 'ssam-debug-invoke-plan/1', planId, ...contract, contract, hash: digest(contract), preparedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(planFile(planId)), { recursive: true }); writeReceipt(planFile(planId), plan);
  return { ok: true, planId, identity, target, transport: 'headless-http', parameters: captured.parameters, parameterDiscovery: captured.parameterDiscovery, outputPaths: input.outputPaths, planPath: planFile(planId), note: 'Inputs belong to the observed entry. A target action is observed through that existing caller; stack evidence is required to prove it ran. Authentication is encrypted in the current-user private vault. Hash validates the capture, not its publication. No arbitrary private-action invocation; request authentication/version may expire.' };
}
function checkDebugger(plan, request) {
  let manifest;
  if (request.debug) manifest = request.debug;
  else { try { manifest = read(path.join(workspaceRoot, '.local', 'debugger', request.sessionId, 'manifest.json')); } catch { fail('invoke_debug_session_missing'); } }
  const tenant = manifest.tenant ? new URL(manifest.tenant.includes('://') ? manifest.tenant : 'https://' + manifest.tenant).hostname : null;
  if (manifest.lane !== 'odc' || tenant !== plan.identity.tenant) fail('invoke_debug_target_unbound');
  if (plan.target && manifest.moduleKey !== plan.target.moduleKey) fail('invoke_debug_target_unbound');
}
async function launch(input) {
  const dir = operationDir(input.operationId), receiptPath = path.join(dir, 'receipt.json');
  if (fs.existsSync(receiptPath)) {
    const r = read(receiptPath); if (r.planId !== input.planId) fail('invoke_operation_identity_mismatch');
    if (r.suppliedInputHash && r.suppliedInputHash !== digest(input.inputs)) fail('invoke_operation_input_mismatch');
    return { ...r, replayedReceipt: true, note: 'Receipt only; no second request was sent.' };
  }
  const plan = readPlan(input.planId); checkDebugger(plan, input);
  const { sha256Of } = await import('./module-map.mjs');
  if (sha256Of(plan.snapshot).toLowerCase() !== plan.identity.sourceSha256.toLowerCase()) fail('invoke_snapshot_changed');
  if (plan.target && sha256Of(plan.targetSnapshot).toLowerCase() !== plan.target.sourceSha256.toLowerCase()) fail('invoke_snapshot_changed');
  const inputs = validateInputs(input.inputs, plan.parameters);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try { fs.mkdirSync(dir); } catch { fail('invoke_operation_pending: query status with the same operationId'); }
  const lock = path.join(invokeRoot, digest({ origin: plan.origin, entry: plan.identity.entryPath }) + '.lock');
  let handle;
  try { handle = fs.openSync(lock, 'wx'); } catch {
    const receipt = { ok: false, state: 'not-sent', operationId: input.operationId, planId: input.planId, error: 'invoke_entry_has_operation', receiptPath };
    writeReceipt(receiptPath, receipt); return receipt;
  }
  fs.writeFileSync(handle, JSON.stringify({ operationId: input.operationId })); fs.closeSync(handle);
  const receipt = { ok: true, state: 'accepted', operationId: input.operationId, planId: input.planId, identity: plan.identity, suppliedInputHash: digest(input.inputs), inputPaths: Object.keys(inputs), outputPaths: input.outputPaths.length ? input.outputPaths : plan.outputPaths, authorizedAt: new Date().toISOString(), receiptPath, lock };
  // CX15 r5 (N-3): the file keeps wordsSha256 of the user's words, never the words.
  writeReceipt(path.join(dir, 'authorization.json'), { operationId: input.operationId, planId: input.planId, wordsSha256: createHash('sha256').update(String(input.authorization)).digest('hex') });
  writeReceipt(receiptPath, receipt);
  const worker = fileURLToPath(new URL('./debug-invoke-worker.mjs', import.meta.url));
  let child;
  try {
    child = spawn(process.execPath, [worker], { detached: true, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.on('error', () => {});
    child.once('error', () => { writeReceipt(receiptPath, { ...receipt, ok: false, state: 'not-sent', error: 'invoke_worker_not_started' }); fs.unlinkSync(lock); });
    // Chosen input values and native credentials never go in argv, environment, journal or receipt.
    receipt.workerPid = child.pid; writeReceipt(receiptPath, receipt);
    child.stdin.end(JSON.stringify({ ...input, inputs }) + '\n'); child.unref();
  } catch { writeReceipt(receiptPath, { ...receipt, ok: false, state: 'not-sent', error: 'invoke_worker_not_started' }); fs.unlinkSync(lock); }
  return receipt;
}
export async function executeInvocation(plan, request, services, update) {
  let sessionId = request.sessionId, ownsSession = false, result, events = [], cleanup = null, attempted = false;
  try {
    if (request.debug) {
      update({ state: 'starting-debugger' });
      const started = await services.debug(request.debug); sessionId = started.sessionId; ownsSession = true;
      update({ sessionId, state: 'starting-debugger' });
      if (!started.ok || started.state !== 'connected') fail('invoke_debug_start_not_confirmed');
    }
    const status = await services.debug({ op: 'status', sessionId });
    if (!status.ok || status.state !== 'connected') fail('invoke_debug_session_not_connected');
    const previous = new Set((status.events ?? []).map(e => digest(e)));
    update({ state: 'invoking', sessionId }); attempted = true;
    result = await services.run(plan, { ...request, sessionId });
    update({ result: sanitizeResult(result), state: result.state, sessionId });
    const after = await services.debug({ op: 'status', sessionId });
    events = (after.events ?? []).filter(e => !previous.has(digest(e)));
    // Stack membership is an observation, not a unique request correlation in a shared runtime.
  } catch (error) {
    result = { state: attempted ? 'uncertain' : 'not-sent', error: safeError(error) };
  } finally {
    if (ownsSession && sessionId) {
      try { cleanup = await services.debug({ op: 'stop', sessionId }); } catch { cleanup = { ok: false, state: 'unknown', error: 'invoke_debug_stop_uncertain' }; }
    }
  }
  const captures = events.filter(e => e.kind === 'variables');
  const stackObserved = events.some(e => e.stop?.stack?.some(f => f.functionKey === plan.identity.actionKey));
  const targetObserved = plan.target ? events.some(e => e.stop?.stack?.some(f => f.functionKey === plan.target.actionKey)) : null;
  const value = { ok: result?.state === 'completed' && result.httpStatus < 400 && result.businessSuccess !== false,
    state: result?.state ?? 'uncertain', sessionId, ownsSession, result: sanitizeResult(result),
    debug: { breakpointObserved: events.some(e => e.kind === 'paused'), entryStackObserved: stackObserved, targetActionObserved: targetObserved, captureCount: captures.length, correlation: 'execution-window-and-stack; concurrent runtime requests may also appear', events },
    cleanup: cleanup ? { ok: cleanup.ok, state: cleanup.state, error: cleanup.error } : { state: 'caller-owned-session' } };
  if (ownsSession && cleanup?.state !== 'stopped') { value.ok = false; value.cleanup.error ??= 'invoke_debug_stop_uncertain'; }
  update(value); return value;
}
export function sanitizeResult(result) {
  if (!result) return null;
  return { ...result, outputs: result.outputs && typeof result.outputs === 'object' ? Object.fromEntries(Object.entries(result.outputs).map(([pointer, value]) => [pointer, filterOutput(value, pointer.split('/').at(-1))])) : result.outputs, exception: filterOutput(result.exception) };
}
export async function invocationWorker(raw) {
  const request = invokeSchema.parse(raw), dir = operationDir(request.operationId), file = path.join(dir, 'receipt.json');
  let receipt = read(file);
  const update = patch => { receipt = { ...receipt, ...patch, updatedAt: new Date().toISOString() }; writeReceipt(file, receipt); };
  try { await executeInvocation(readPlan(request.planId), request, { debug: headlessDebug, run: runHeadlessHttp }, update); }
  catch { update({ ok: false, state: 'not-sent', error: 'invoke_worker_failed' }); }
  finally {
    // An uncertain POST retains its lock; never retry to infer its outcome.
    if (receipt.state !== 'uncertain' && !/debug_start_uncertain/.test(receipt.result?.error ?? '') && (!receipt.ownsSession || receipt.cleanup?.state === 'stopped')) releaseLock(receipt);
  }
}
function releaseLock(receipt) { if (receipt.lock && fs.existsSync(receipt.lock) && read(receipt.lock).operationId === receipt.operationId) fs.unlinkSync(receipt.lock); }
async function status(input) {
  const file = path.join(operationDir(input.operationId), 'receipt.json');
  if (!fs.existsSync(file)) return { ok: false, state: 'unknown', operationId: input.operationId, error: 'invoke_operation_not_found' };
  const receipt = read(file);
  if (['accepted', 'starting-debugger', 'invoking'].includes(receipt.state) && receipt.workerPid) {
    try { process.kill(receipt.workerPid, 0); } catch (error) {
      if (error.code === 'ESRCH') { Object.assign(receipt, { ok: false, state: 'uncertain', error: 'invoke_worker_exited_without_final_receipt', updatedAt: new Date().toISOString() }); writeReceipt(file, receipt); }
    }
  }
  return receipt;
}
async function dispatchInvoke(raw) {
  const input = invokeSchema.parse(raw);
  if (input.op === 'prepare') return prepare(input);
  if (input.op === 'run') return launch(input);
  if (input.op === 'status') return status(input);
  const plan = readPlan(input.planId);
  const lock = path.join(invokeRoot, digest({ origin: plan.origin, entry: plan.identity.entryPath }) + '.lock');
  if (fs.existsSync(lock)) fail('invoke_plan_has_operation');
  await privateRequest('Forget', plan.planId); writeReceipt(planFile(input.planId), { ...plan, forgotten: true });
  return { ok: true, planId: input.planId, state: 'forgotten' };
}
export async function invokeDebug(raw) {
  const started = new Date().toISOString(); let result;
  try { result = await dispatchInvoke(raw); return result; }
  finally {
    const { journal } = await import('./lib.mjs');
    journal({ start: started, tool: 'ssam_debug_invoke', command: raw.op, outcome: result?.ok ? 'ok' : 'failed-or-uncertain', note: result?.operationId ?? result?.planId ?? raw.operationId ?? raw.planId });
  }
}
