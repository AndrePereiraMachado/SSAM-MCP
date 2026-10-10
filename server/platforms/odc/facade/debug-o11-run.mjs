// O11 same-module server/service-action runner. Original provider login occurs within each wrapper request.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { workspaceRoot } from './workspace.mjs';
import * as W from './debug-wrapper.mjs';
import { createO11Lifecycle, o11Hash, o11Read, o11Write, o11PublicTarget, o11NativeEntryMetadata } from './debug-o11-lifecycle.mjs';
import { prepareDebugAppUser, releaseDebugAppUser, appUserWorker, sameAppUserTarget, appUserBinding } from './debug-app-user.mjs';
import { o11NativePublicCode } from './debug-o11-native-entry.mjs';
import { createO11NativeRun } from './debug-o11-native-run.mjs';
import { SIGN_IN_FAILURES } from './debug-guidance.mjs';

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/, KEY = /^[A-Za-z0-9_+]{22}$/;
const fail = code => { throw new Error(code); };
const sensitive = /password|credential|authorization|cookie|(?:^|_)token(?:$|_)|secret/i;
const safeError = error => {
  const code = error?.code ?? error?.message;
  if (typeof code === 'string' && code.startsWith('debug_o11_native_')) return o11NativePublicCode(code);
  return /^(?:debug_o11_run|debug_app_user|publish_oml)_[a-z_]+$/.test(code ?? '') ? code : 'debug_o11_run_failed';
};
const descriptorPin = z.object({ path: z.string().refine(path.isAbsolute), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const KEY_SELECTOR = /^@[A-Za-z0-9_+]{22}$/, QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]{0,120}\.(?:[A-Za-z_][A-Za-z0-9_]{0,120}|@[A-Za-z0-9_+]{22})$/;
export const o11RunSchema = z.object({
  op: z.enum(['run', 'prepare', 'release', 'status', 'authorize', 'reconcile']), lane: z.literal('o11').default('o11'),
  host: z.string().min(3).max(200), module: z.string().regex(NAME), moduleKey: z.string().regex(KEY),
  applicationKey: z.string().regex(KEY), runtimeUrl: z.string().url(),
  execution: z.enum(['rest-wrapper', 'native-entry']).default('rest-wrapper'),
  nativeEntry: z.object({ sourceContract: descriptorPin }).strict().optional(),
  action: z.string().refine(v => NAME.test(v) || KEY.test(v) || KEY_SELECTOR.test(v) || QUALIFIED.test(v)).optional(),
  // Graph native-entry only: an override that must be a verified invocable caller, extra modules of the graph
  // (consumers/producers of the target) and the server trace window.
  entry: z.string().min(1).max(300).optional(),
  modules: z.array(z.object({ module: z.string().regex(NAME), moduleKey: z.string().regex(KEY), applicationKey: z.string().regex(KEY) }).strict()).max(8).optional(),
  window: z.object({ around: z.string().regex(KEY).optional(), before: z.number().int().min(0).max(100).default(0),
    after: z.number().int().min(1).max(1000).default(300) }).strict().optional(),
  inputs: z.record(z.string().regex(NAME), z.json()).default({}),
  scenarios: z.array(z.object({ name: z.string().min(1).max(80).optional(), inputs: z.record(z.string().regex(NAME), z.json()).default({}),
    trace: z.boolean().optional() }).strict()).min(1).max(50).optional(),
  // No schema default: rest-wrapper and the legacy native entry keep 'all' (applied in the dispatcher); the graph
  // native-entry defaults to 'none'. 'nodes'/'full' belong to the graph native-entry.
  trace: z.enum(['all', 'none', 'nodes', 'full']).optional(), around: z.string().regex(KEY).optional(),
  before: z.number().int().min(0).max(100).default(0), after: z.number().int().min(1).max(1000).default(300),
  depth: z.number().int().min(0).max(4).default(2), keep: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(5).max(300).default(90), words: z.string().min(1).max(2000).optional(),
}).strict().superRefine((v, ctx) => {
  if (['run', 'prepare'].includes(v.op) && !v.action) ctx.addIssue({ code: 'custom', path: ['action'], message: 'action is required' });
  if (v.op === 'authorize' && !v.words) ctx.addIssue({ code: 'custom', path: ['words'], message: 'words are required' });
  if (v.scenarios?.length && Object.keys(v.inputs).length) ctx.addIssue({ code: 'custom', path: ['inputs'], message: 'Give inputs or scenarios' });
  if (v.execution === 'rest-wrapper' && v.nativeEntry) ctx.addIssue({ code: 'custom', path: ['nativeEntry'], message: 'nativeEntry requires execution=native-entry' });
  const graph = v.execution === 'native-entry' && !v.nativeEntry;
  if (!graph && (v.entry !== undefined || v.modules || v.window || ['nodes', 'full'].includes(v.trace)))
    ctx.addIssue({ code: 'custom', path: ['execution'], message: 'entry, modules, window and trace nodes|full belong to execution=native-entry without nativeEntry' });
  if (graph) {
    if (!['run', 'prepare', 'status'].includes(v.op)) ctx.addIssue({ code: 'custom', path: ['op'], message: 'native-entry supports run, prepare and status only' });
    if (v.keep || v.around || v.before || v.after !== 300 || v.words) ctx.addIssue({ code: 'custom', path: ['execution'], message: 'native-entry publishes nothing: no keep/words; use window {around, before, after}' });
    if (v.scenarios?.some(s => s.trace !== undefined)) ctx.addIssue({ code: 'custom', path: ['scenarios'], message: 'native-entry traces every scenario with the request trace' });
  }
  if (v.execution === 'native-entry' && !graph) {
    if (!['run', 'prepare', 'status'].includes(v.op)) ctx.addIssue({ code: 'custom', path: ['op'], message: 'native-entry supports run, prepare and status only' });
    if (v.op !== 'status' && (v.trace !== 'none' || v.around || v.keep || Object.keys(v.inputs).length ||
        v.scenarios && (v.scenarios.length !== 1 || Object.keys(v.scenarios[0].inputs).length || v.scenarios[0].trace))
        )
      ctx.addIssue({ code: 'custom', path: ['execution'], message: 'The proved native ABI requires one empty-input call, trace=none and keep=false' });
  }
});

// Only the verified wrapper's post-call serialization can establish completion; HTTP200 alone cannot.
export function o11WrapperResponse(action, reply) {
  const body = reply?.body, fields = action.outputs.length ? action.outputs.map(parameter => parameter.name) : ['SSAMDebugCompleted'];
  if (reply?.ok !== true || reply.status !== 200 || body?.error || body?.Errors || body?.errors)
    return { ok: false, answered: reply?.state === 'completed', error: 'debug_o11_run_target_or_login_rejected' };
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== fields.sort().join(',') ||
      !action.outputs.length && body.SSAMDebugCompleted !== true)
    return { ok: false, answered: false, error: 'debug_o11_run_response_schema_unproved' };
  return { ok: true, answered: true };
}

export function o11Scenarios(input, action) {
  const scenarios = (input.scenarios ?? [{ name: 'call', inputs: input.inputs }]).map((scenario, i) => ({
    name: scenario.name ?? 'scenario-' + (i + 1), inputs: scenario.inputs ?? {}, trace: scenario.trace ?? input.trace === 'all' }));
  if (new Set(scenarios.map(s => s.name)).size !== scenarios.length) fail('debug_o11_run_duplicate_scenarios');
  const signature = new Map(action.inputs.map(p => [p.name, p]));
  for (const scenario of scenarios) {
    for (const name of Object.keys(scenario.inputs)) if (!signature.has(name) || sensitive.test(name) || Object.values(W.APP_USER_FIELDS).some(f => f.toLowerCase() === name.toLowerCase())) fail('debug_o11_run_invalid_or_private_input');
    for (const parameter of action.inputs) {
      if (!(parameter.name in scenario.inputs)) { if (parameter.mandatory) fail('debug_o11_run_required_input_missing'); continue; }
      const value = scenario.inputs[parameter.name], type = W.jobType(parameter);
      if (value === null && !parameter.mandatory) continue;
      const valid = type === 'Text' || type === 'Email' || type === 'Phone Number' ? typeof value === 'string'
        : type === 'Boolean' ? typeof value === 'boolean'
        : type === 'Integer' ? Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
        : type === 'Long Integer' || type === 'Identifier' ? typeof value === 'string' && /^-?\d+$/.test(value) || Number.isSafeInteger(value)
        : ['Decimal', 'Currency'].includes(type) ? typeof value === 'number' && Number.isFinite(value)
        : ['Date', 'Date Time', 'Time', 'Binary Data'].includes(type) ? typeof value === 'string'
        : type.startsWith('@') ? typeof value === 'object' || typeof value === 'string' || Number.isSafeInteger(value) : false;
      if (!valid) fail('debug_o11_run_input_type_mismatch');
    }
  }
  return scenarios;
}
export function o11CompactMap(entries) {
  const last = new Map();
  return entries.map(entry => {
    const scope = [entry.threadId, entry.functionKey ?? entry.action, entry.frameId ?? ''].join('|');
    const previous = last.get(scope), current = new Map((entry.values ?? []).map(value => [value.path, JSON.stringify(value)]));
    last.set(scope, current);
    const values = previous ? (entry.values ?? []).filter(value => previous.get(value.path) !== current.get(value.path)) : entry.values ?? [];
    const { values: _, threadId: __, ...rest } = entry;
    return { ...rest, ...(previous ? { changed: values } : { values }) };
  });
}
const summary = lease => lease ? { state: lease.state, module: lease.module, action: lease.action?.name,
  baseVersionId: lease.base?.versionId, wrapperVersionId: lease.wrapperVersionId ?? null,
  removeVersionId: lease.removeVersionId ?? null, receiptPath: lease.receiptPath,
  publicationReceipt: lease.publication?.receiptPath ?? null } : null;

export function createO11Runner(services = {}) {
  const root = services.root ?? workspaceRoot, lifecycle = services.lifecycle ?? createO11Lifecycle({ root });
  const folder = path.join(root, '.local', 'debugger', 'wrappers', 'o11');
  const prepareUser = services.prepareUser ?? prepareDebugAppUser, releaseUser = services.releaseUser ?? releaseDebugAppUser;
  const invoke = services.invoke ?? ((input) => appUserWorker('invoke', input, { timeoutMs: (input.timeoutSeconds + 15) * 1000 }));
  const debug = services.debug ?? (async (input, privateContext) => (await import('./debug-runtime.mjs')).headlessDebug(input, privateContext));
  const selected = services.selected ?? (async () => (await import('./studio-connect.mjs')).assertSelectedO11());
  const traceRead = services.traceRead ?? (sessionId => {
    const file = path.join(root, '.local', 'debugger', sessionId, 'trace.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  });
  const settle = services.settle ?? (async sessionId => {
    let previous = -1, stable = 0;
    for (let i = 0; i < 60 && stable < 2; i++) { await new Promise(resolve => setTimeout(resolve, 500)); const count = traceRead(sessionId).length;
      stable = count === previous ? stable + 1 : 0; previous = count; }
    if (stable < 2) fail('debug_o11_run_trace_not_settled');
  });
  async function runNativeEntry(input, target) {
    const nativeFolder = path.join(root, '.local', 'debugger', 'native-entries', 'o11', target.host),
      lockPath = path.join(nativeFolder, target.moduleKey + '.lock'), latestPath = path.join(nativeFolder, target.moduleKey + '.json');
    if (input.op === 'status') return { ok: true, lane: 'o11', execution: 'native-entry',
      operation: fs.existsSync(latestPath) ? o11Read(latestPath) : null, reconciliationRequired: fs.existsSync(lockPath) };
    const operationId = randomUUID(), sessionId = randomUUID().replaceAll('-', ''), directory = path.join(nativeFolder, operationId), receiptPath = path.join(directory, 'receipt.json');
    const report = { schema: 'ssam-o11-native-entry-run/1', operationId, lane: 'o11', execution: 'native-entry', state: 'preparing',
      target, sourceContract: input.nativeEntry.sourceContract, receiptPath, appUserAuthenticated: false, nativeRegisteredCheckPassed: false,
      loginSubmittedCount: 0, loginAnsweredCount: 0, loginUncertain: false, requestSubmittedCount: 0, requestAnsweredCount: 0, requestUncertain: false,
      requestReserved: false, requestEnvelopeVerified: false, nativeClientRequestBound: false, nativeCallContextObjectVerified: false,
      userRequestIsolationProved: false, serverTraceProved: false, serviceFramesProved: false, debuggerStarted: false,
      credentialsReleased: false, memoryCleared: false, nativeContextReferencesReleased: false, lockRetained: false };
    let fd, ownsLock = false, handle, metadata, descriptor, returned, workerAttempted = false;
    const save = () => { o11Write(receiptPath, report); o11Write(latestPath, report); };
    const unchangedPreparation = () => {
      const current = o11NativeEntryMetadata(input, handle.receipt(), sessionId);
      if (JSON.stringify(current) !== JSON.stringify(metadata)) fail('debug_o11_run_native_entry_preparation_changed');
    };
    const ledger = value => {
      if (!value || typeof value !== 'object' || typeof value.loginUncertain !== 'boolean' || typeof value.requestUncertain !== 'boolean')
        fail('debug_o11_run_native_entry_ledger_unproved');
      for (const key of ['loginSubmittedCount', 'loginAnsweredCount', 'requestSubmittedCount', 'requestAnsweredCount']) {
        if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 1 || value[key] < report[key]) fail('debug_o11_run_native_entry_ledger_unproved');
        report[key] = value[key];
      }
      if (report.loginAnsweredCount > report.loginSubmittedCount || report.requestAnsweredCount > report.requestSubmittedCount ||
          report.requestSubmittedCount && !report.requestReserved) fail('debug_o11_run_native_entry_ledger_unproved');
      report.loginUncertain ||= value.loginUncertain === true || report.loginSubmittedCount > report.loginAnsweredCount;
      report.requestUncertain ||= value.requestUncertain === true || report.requestSubmittedCount > report.requestAnsweredCount;
    };
    try {
      if (fs.existsSync(lockPath)) fail('debug_o11_run_native_entry_reconciliation_required');
      // An unavailable native component must refuse before any wrapper creation, publication or window.
      let broker = services.nativeBroker;
      if (!broker) {
        const file = new URL('./debug-o11-native-entry.mjs', import.meta.url);
        if (!fs.existsSync(file)) fail('debug_o11_run_native_entry_component_unavailable');
        const component = await import(file.href);
        if (typeof component.createO11NativeEntryBroker !== 'function') fail('debug_o11_run_native_entry_component_unavailable');
        broker = component.createO11NativeEntryBroker({ root });
      }
      if (typeof broker.prepare !== 'function') fail('debug_o11_run_native_entry_component_unavailable');
      fs.mkdirSync(directory, { recursive: true }); fd = fs.openSync(lockPath, 'wx'); ownsLock = true;
      fs.writeFileSync(fd, JSON.stringify({ operationId, sessionId, pid: process.pid, host: target.host, moduleKey: target.moduleKey })); fs.fsyncSync(fd); save();
      workerAttempted = true;
      handle = await broker.prepare({ target: { lane: 'o11', ...target }, sourceContract: input.nativeEntry.sourceContract,
        action: input.action, sessionId, timeoutSeconds: input.timeoutSeconds, directory });
      if (!handle || typeof handle.receipt !== 'function' || typeof handle.authenticate !== 'function' || typeof handle.invoke !== 'function' || typeof handle.dispose !== 'function')
        fail('debug_o11_run_native_entry_component_unavailable');
      metadata = o11NativeEntryMetadata(input, handle.receipt(), sessionId); ledger(handle.receipt());
      if (report.loginSubmittedCount || report.requestSubmittedCount || report.loginUncertain || report.requestUncertain) fail('debug_o11_run_native_entry_preparation_unproved');
      report.target = metadata.target; report.entry = metadata.entry;
      if (input.op === 'prepare') { report.state = 'prepared'; returned = report; return returned; }
      report.state = 'sign-in'; save();
      const entered = await prepareUser({ lane: 'o11', ...target, seconds: 600 }, { sessionId });
      if (!entered.ok) { report.state = entered.state === 'cancelled' ? 'cancelled' : 'sign-in-refused'; report.error = safeError({ message: entered.error }); returned = report; return returned; }
      descriptor = entered.descriptor;
      const binding = appUserBinding({ lane: 'o11', ...target }, sessionId);
      if (descriptor?.state !== 'credentials-entered' || descriptor.authenticated !== false || !sameAppUserTarget(descriptor.binding, binding) ||
          !Number.isFinite(Date.parse(descriptor.expiresAt)) || Date.parse(descriptor.expiresAt) <= Date.now() || Date.parse(descriptor.expiresAt) > Date.now() + 600000)
        fail('debug_o11_run_app_user_scope_mismatch');
      report.state = 'authenticating'; save();
      const authenticated = await handle.authenticate(descriptor); ledger(handle.receipt()); unchangedPreparation();
      report.appUserAuthenticated = authenticated?.authenticated === true;
      report.nativeRegisteredCheckPassed = authenticated?.nativeCheckRegisteredPassed === true;
      if (!authenticated?.ok || !report.appUserAuthenticated || !report.nativeRegisteredCheckPassed || authenticated.rolesLoadedFromServer !== true ||
          report.loginAnsweredCount !== 1 || report.loginUncertain || report.requestSubmittedCount) fail('debug_o11_run_native_entry_login_rejected');
      if (Date.parse(descriptor.expiresAt) <= Date.now()) fail('debug_app_user_expired');
      report.state = 'invoking'; save();
      const result = await handle.invoke({ beforeRequest: async value => {
        unchangedPreparation();
        if (report.requestReserved || !sameAppUserTarget(value?.binding, binding) || value.sessionId !== sessionId ||
            value.sourceContractSha256 !== metadata.sourceContract.sha256 || value.actionKey !== metadata.entry.actionKey ||
            value.endpoint !== metadata.entry.endpoint || value.apiVersion !== metadata.entry.apiVersion || value.viewName !== metadata.entry.viewName ||
            value.inputsCount !== 0 || value.requestEnvelopeVerified !== true || !/^[a-f0-9]{64}$/.test(value.ccidSha256 ?? '') || Date.parse(descriptor.expiresAt) <= Date.now())
          fail('debug_o11_run_native_entry_request_scope_mismatch');
        report.requestReserved = true; report.requestEnvelopeVerified = true; report.ccidSha256 = value.ccidSha256;
        report.submissionReservedAt = new Date().toISOString(); save();
      } });
      ledger(handle.receipt());
      if (!result?.ok || report.requestSubmittedCount !== 1 || report.requestAnsweredCount !== 1 || report.requestUncertain || !report.requestReserved)
        fail('debug_o11_run_native_entry_response_unproved');
      const outputs = result.outputs, expected = metadata.entry.outputs;
      if (!outputs || Object.keys(outputs).sort().join(',') !== expected.map(output => output.name).sort().join(',') ||
          expected.some(output => typeof outputs[output.name] !== 'boolean')) {
        report.requestUncertain = true; fail('debug_o11_run_native_entry_response_schema_unproved');
      }
      report.outputs = Object.fromEntries(expected.map(output => [output.name, outputs[output.name]]));
      report.state = 'answered'; returned = report; return returned;
    } catch (error) {
      // The broker issues this private capability only after verifying its own failed child receipt.
      // Never load an arbitrary receipt path from an exception or infer cleanup from error text.
      if (!handle && error?.nativeEntryCleanupHandle) {
        const candidate = error.nativeEntryCleanupHandle;
        try {
          if (typeof candidate.receipt !== 'function' || typeof candidate.dispose !== 'function') fail('debug_o11_run_native_entry_cleanup_unproved');
          const proof = candidate.receipt();
          if (proof?.schema !== 'ssam-o11-native-entry-receipt/1' || proof.prepared !== false || proof.sessionId !== sessionId || proof.target?.lane !== 'o11' ||
              Object.entries(target).some(([key, expected]) => proof.target[key] !== expected) ||
              proof.sourceContract?.path !== input.nativeEntry.sourceContract.path || proof.sourceContract?.sha256 !== input.nativeEntry.sourceContract.sha256 ||
              ['loginSubmittedCount', 'loginAnsweredCount', 'requestSubmittedCount', 'requestAnsweredCount'].some(key => proof[key] !== 0) ||
              proof.loginUncertain !== false || proof.requestUncertain !== false || proof.memoryCleared !== true || proof.nativeContextReferencesReleased !== true)
            fail('debug_o11_run_native_entry_cleanup_unproved');
          handle = candidate; report.preparationFailureCleanupProved = true;
        } catch { /* An unproved child keeps this operation locked for reconciliation. */ }
      }
      report.error = safeError(error); report.state = 'refused-or-uncertain';
      // A refused sign-in names the account it tried, masked (debug-guidance.mjs maskUser), for DEBUG_APP_USER_SIGN_IN_FAILED.
      const user = descriptor?.userHint ?? error?.signIn?.user;
      if (typeof user === 'string' && SIGN_IN_FAILURES.includes(report.error)) report.signInUser = user;
      returned = report; return returned;
    } finally {
      if (handle) {
        try { ledger(handle.receipt()); } catch { report.workerLedgerUnproved = true; }
        try { await handle.dispose(); }
        catch { report.memoryCleanupUnproved = true; }
        try { const cleared = handle.receipt(); report.memoryCleared = cleared.memoryCleared === true;
          report.nativeContextReferencesReleased = cleared.nativeContextReferencesReleased === true;
          try { ledger(cleared); } catch { report.workerLedgerUnproved = true; } }
        catch { report.memoryCleanupUnproved = true; }
      } else if (!workerAttempted) { report.memoryCleared = true; report.nativeContextReferencesReleased = true; }
      if (descriptor) try { report.credentialsReleased = (await releaseUser(descriptor)).ok === true; } catch { report.credentialsReleased = false; }
      else report.credentialsReleased = true; // The credential controller owns cancelled/failed prompt cleanup.
      report.ok = ['answered', 'prepared'].includes(report.state) && !report.loginUncertain && !report.requestUncertain &&
        report.credentialsReleased && report.memoryCleared && report.nativeContextReferencesReleased && !report.workerLedgerUnproved && !report.memoryCleanupUnproved;
      if (report.memoryCleanupUnproved || !report.memoryCleared || !report.nativeContextReferencesReleased || !report.credentialsReleased)
        report.error ??= 'debug_o11_run_native_entry_cleanup_unproved';
      const uncertain = report.loginUncertain || report.requestUncertain || report.workerLedgerUnproved || report.memoryCleanupUnproved ||
        !report.memoryCleared || !report.nativeContextReferencesReleased || !report.credentialsReleased || report.requestReserved && report.requestAnsweredCount !== 1;
      if (fd !== undefined) try { fs.closeSync(fd); } catch { report.lockRetained = true; report.ok = false; }
      if (ownsLock) {
        report.lockRetained ||= uncertain;
        try {
          const owner = o11Read(lockPath);
          if (owner.operationId !== operationId || owner.sessionId !== sessionId || owner.pid !== process.pid) fail('debug_o11_run_lock_ownership_changed');
          if (!report.lockRetained) fs.unlinkSync(lockPath);
        } catch { report.lockRetained = true; report.ok = false; }
      }
      if (fs.existsSync(directory)) save();
    }
  }
  async function remove(target, lease, authorization) {
    if (!lease || lease.state === 'removed') return lease;
    if (lease.state !== 'active') fail('debug_o11_run_reconciliation_required');
    const base = await lifecycle.snapshot(target, path.join(lease.directory, 'remove-base-' + randomUUID()));
    if (base.versionId !== lease.wrapperVersionId) fail('debug_o11_run_publication_superseded');
    if (!await lifecycle.exists(base, 'RestService:' + W.SERVICE)) fail('debug_o11_run_wrapper_missing');
    const currentAction = await lifecycle.original(base, lease.action.key);
    const removalJob = W.removeJob({ actions: [currentAction] });
    removalJob.ops.push(...(lease.addedReferences ?? []).map(reference => ({ op: 'delete', target: '@' + reference.key })));
    const candidate = await lifecycle.apply(base, removalJob, path.join(lease.directory, 'remove'));
    lease.state = 'removing'; lease.removal = lifecycle.publication(target, base, candidate, authorization, path.join(lease.directory, 'remove-publish'), W.COMMIT.remove);
    saveLease(lease);
    const outcome = await lifecycle.publish(lease.removal);
    lease.state = outcome.ok ? 'removed' : outcome.state === 'refused' || outcome.state === 'failed' ? 'removal-failed' : 'uncertain';
    lease.removeVersionId = outcome.versionId; saveLease(lease); return lease;
  }
  function saveLease(lease) {
    o11Write(lease.leasePath, lease);
    o11Write(lease.receiptPath, { schema: 'ssam-o11-debug-run/1', ...summary(lease),
      calls: lease.calls ?? [], cleanup: lease.cleanup ?? null, updatedAt: new Date().toISOString() });
  }
  const nativeRun = services.nativeRun ?? createO11NativeRun({ root, ...(services.native ?? {}) });
  return async function runO11(raw) {
    const parsed = o11RunSchema.parse(raw), target = o11PublicTarget(parsed);
    // Graph native-entry: the entry is chosen by the deterministic call-graph resolver; nothing is published.
    if (parsed.execution === 'native-entry' && !parsed.nativeEntry) return nativeRun({ ...parsed, ...target }, { traceExplicit: parsed.trace !== undefined });
    const input = { ...parsed, trace: parsed.trace ?? 'all' };
    if (input.execution === 'native-entry') return runNativeEntry(input, target);
    const leasePath = path.join(folder, target.host, target.moduleKey + '.json'), lockPath = leasePath + '.lock';
    const grantPath = path.join(folder, target.host, target.moduleKey + '.authorization.json');
    let lease = fs.existsSync(leasePath) ? o11Read(leasePath) : null;
    if (input.op === 'status') return { ok: true, lane: 'o11', wrapper: summary(lease) };
    if (input.op === 'authorize') {
      o11Write(grantPath, { host: target.host, modules: [target.moduleKey], scope: 'ssam-debug-wrapper-create-remove',
        words: input.words, grantedAt: new Date().toISOString() });
      return { ok: true, lane: 'o11', state: 'authorized', moduleKey: target.moduleKey };
    }
    let fd, appUser, sessionId, ownOperationId, stopped = null, cleanup = null, returned;
    const results = [];
    const answer = value => { returned = value; return value; };
    try {
      if (lease && ['host', 'module', 'moduleKey', 'applicationKey', 'runtimeUrl'].some(key => lease[key] !== target[key])) fail('debug_o11_run_lease_scope_mismatch');
      if (input.op === 'reconcile') {
        if (!lease || lease.calls?.some(call => call.state === 'uncertain')) fail('debug_o11_run_call_requires_manual_reconciliation');
        const removing = !!lease.removal, operation = removing ? lease.removal : lease.publication;
        if (!operation) fail('debug_o11_run_reconciliation_requires_publication_receipt');
        // A live owner must finish first. A crashed owner is not permission to resend its publication.
        if (fs.existsSync(lockPath)) {
          const locked = o11Read(lockPath); if (!Number.isSafeInteger(locked.pid)) fail('debug_o11_run_target_has_operation');
          let alive = false; try { process.kill(locked.pid, 0); alive = true; } catch { /* no process */ }
          if (alive) fail('debug_o11_run_target_has_operation');
        }
        await selected();
        const reconciled = await lifecycle.publish(operation, 'reconcile');
        if (reconciled.ok) {
          lease.state = removing ? 'removed' : 'active';
          if (removing) lease.removeVersionId = reconciled.versionId; else lease.wrapperVersionId = reconciled.versionId;
          saveLease(lease); if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
        }
        return answer({ ok: reconciled.ok, state: reconciled.state, wrapper: summary(lease) });
      }
      if (fs.existsSync(lockPath)) fail('debug_o11_run_target_has_operation');
      if (lease && !['removed', 'prepared', 'active'].includes(lease.state)) fail('debug_o11_run_reconciliation_required');
      const authorization = fs.existsSync(grantPath) ? o11Read(grantPath) : null;
      if (input.op !== 'prepare' && !authorization) fail('debug_o11_run_authorization_required');
      fs.mkdirSync(path.dirname(lockPath), { recursive: true }); fd = fs.openSync(lockPath, 'wx');
      ownOperationId = randomUUID();
      fs.writeFileSync(fd, JSON.stringify({ operationId: ownOperationId, pid: process.pid, host: target.host, moduleKey: target.moduleKey })); fs.fsyncSync(fd);
      await selected();
      if (input.op === 'release') { lease = await remove(target, lease, authorization); return answer({ ok: !lease || lease.state === 'removed', wrapper: summary(lease) }); }
      if (lease?.state === 'active' && lease.action.name !== input.action && lease.action.key !== input.action) fail('debug_o11_run_release_existing_wrapper_first');
      if (lease?.state !== 'active') {
        const directory = path.join(folder, target.host, target.moduleKey + '-' + randomUUID());
        const base = await lifecycle.snapshot(target, path.join(directory, 'base'));
        const action = await lifecycle.original(base, input.action), scenarios = o11Scenarios(input, action);
        const login = lifecycle.loginContext ? await lifecycle.loginContext(base, path.join(directory, 'user-provider'), target)
          : { source: base, loginRef: await lifecycle.loginReference(base), addedReferences: [] };
        const loginRef = login.loginRef;
        if (await lifecycle.exists(base, 'RestService:' + W.SERVICE)) fail('debug_o11_run_unowned_wrapper_present');
        const token = W.newToken(), candidate = await lifecycle.apply(login.source, W.createJob({ lane: 'o11', actions: [action], token, appUser: true, loginRef }), path.join(directory, 'create'));
        const wrapper = await lifecycle.wrapper(candidate, action, { loginRef, loginContract: login.loginContract, token });
        if (wrapper.authenticationVerified !== true || wrapper.nativeIdentityGuardVerified !== true || wrapper.originalActionKey !== action.key)
          fail('debug_o11_run_wrapper_authentication_unproved');
        const gatePath = path.join(directory, 'private-gate.json'); o11Write(gatePath, { token });
        lease = { schema: 'ssam-o11-wrapper/1', ...target, leasePath, directory, receiptPath: path.join(directory, 'run-receipt.json'),
          state: 'prepared', base, candidate, action, wrapper, gatePath, loginRef, loginContract: login.loginContract,
          addedReferences: login.addedReferences, calls: [] };
        saveLease(lease);
      }
      const scenarios = o11Scenarios(input, lease.action);
      if (input.op === 'prepare') return answer({ ok: true, state: lease.state, candidate: { path: lease.candidate.file, sha256: lease.candidate.sha256 },
        wrapper: summary(lease), inputParameters: lease.action.inputs.map(p => ({ name: p.name, type: W.jobType(p), mandatory: p.mandatory })), scenarios: scenarios.length,
        actionKind: lease.action.kind, limitations: ['same-module-actions', 'native-verify-required', 'no-client-screen-timer-bpt-invocation'] });
      if (lease.wrapper.authenticationVerified !== true || lease.wrapper.nativeIdentityGuardVerified !== true || lease.wrapper.originalActionKey !== lease.action.key)
        fail('debug_o11_run_wrapper_authentication_unproved');
      const prepared = await prepareUser({ lane: 'o11', ...target, seconds: 600 });
      if (!prepared.ok) return answer({ ok: false, state: prepared.state === 'cancelled' ? 'cancelled' : 'sign-in-refused',
        error: safeError({ message: prepared.error }), wrapper: summary(lease) });
      appUser = prepared.descriptor;
      if (!appUser || appUser.state !== 'credentials-entered' || appUser.authenticated !== false || appUser.binding?.lane !== 'o11' ||
          !Number.isFinite(Date.parse(appUser.expiresAt)) || Date.parse(appUser.expiresAt) <= Date.now() || Date.parse(appUser.expiresAt) > Date.now() + 600000 ||
          !sameAppUserTarget(appUserBinding(targetWithLane(target), appUser.binding.sessionId), appUser.binding)) fail('debug_o11_run_app_user_scope_mismatch');
      if (lease.state !== 'active') {
        lease.publication = lifecycle.publication(target, lease.base, lease.candidate, authorization, path.join(lease.directory, 'create-publish'), W.COMMIT.create);
        lease.state = 'creating'; saveLease(lease);
        const publication = await lifecycle.publish(lease.publication);
        lease.state = publication.ok ? 'active' : publication.state === 'refused' || publication.state === 'failed' ? 'creation-failed' : 'uncertain';
        lease.wrapperVersionId = publication.versionId; saveLease(lease);
        if (!publication.ok) return answer({ ok: false, error: 'debug_o11_run_publication_not_confirmed', wrapper: summary(lease) });
      }
      const fresh = await lifecycle.inventory(target, path.join(lease.directory, 'session-' + randomUUID()));
      if (fresh.versionId !== lease.wrapperVersionId) fail('debug_o11_run_publication_superseded');
      const token = o11Read(lease.gatePath).token;
      const call = async scenario => {
        const timeoutSeconds = Math.min(input.timeoutSeconds, Math.floor((Date.parse(appUser.expiresAt) - Date.now()) / 1000));
        if (timeoutSeconds < 5) fail('debug_app_user_expired');
        lease.calls.push({ index: lease.calls.length + 1, state: 'uncertain', traced: scenario.trace }); saveLease(lease);
        let result; try { result = await invoke({ descriptor: appUser, module: target.module, action: lease.action.name, token,
          body: scenario.inputs, timeoutSeconds }); }
        catch { result = { ok: false, state: 'uncertain', status: null, error: 'debug_call_outcome_uncertain' }; }
        const last = lease.calls.at(-1);
        if (!result.ok && ['uncertain', 'invalid-response'].includes(result.state)) { lease.state = 'uncertain'; last.state = 'uncertain'; saveLease(lease); fail('debug_o11_run_call_outcome_uncertain'); }
        const response = o11WrapperResponse(lease.action, result);
        if (!response.answered) { lease.state = 'uncertain'; last.state = 'uncertain'; last.status = result.status; saveLease(lease); fail('debug_o11_run_call_outcome_uncertain'); }
        last.state = 'answered'; last.status = result.status; saveLease(lease);
        const ok = response.ok;
        return { name: scenario.name, ok, status: result.status ?? null, elapsedMs: result.elapsedMs,
          context: { mode: 'native-provider-login-in-request', targetReached: ok, authenticated: ok,
            nativeIdentityGuardPassed: ok, originalRoleChecksPreserved: true, namedRolesProved: false,
            exactPrivateUserIdMatchesServer: false, serviceBoundaryProved: false, userRequestIsolationProved: false },
          outputs: ok ? result.body : null, ...(ok ? {} : { error: 'debug_o11_run_target_or_login_rejected' }) };
      };
      for (const scenario of scenarios.filter(s => !s.trace)) results.push(await call(scenario));
      const traced = scenarios.filter(s => s.trace);
      if (traced.length) {
        const window = input.around ? W.traceWindow(lease.action, input) : null;
        const started = await debug({ op: 'start', lane: 'o11', tenant: target.host, module: target.module,
          moduleKey: target.moduleKey, runtimeUrl: target.runtimeUrl,
          o11Auth: { applicationKey: target.applicationKey, publishedVersionId: fresh.versionId, publishedProof: fresh.proof },
          nodeKeys: window?.entries ?? [lease.wrapper.callNode], seconds: Math.min(600, 60 + traced.length * (input.timeoutSeconds + 15)),
          pauseSeconds: 5, autoContinue: true, paths: [], trace: { mode: 'step', steps: Math.min(2000, (window?.steps ?? input.after + 1) * traced.length),
            depth: input.depth, fullValues: true, focusFunctionKey: lease.action.key, requireFunctionKey: lease.wrapper.key,
            scopes: { [lease.action.key]: W.scopeRoots(lease.action) } } }, { appUser });
        sessionId = started.sessionId;
        if (!started.ok || started.state !== 'connected') {
          if (sessionId) { lease.state = 'uncertain'; saveLease(lease); }
          fail('debug_o11_run_debugger_not_connected');
        }
        for (const scenario of traced) {
          const before = traceRead(sessionId).length, result = await call(scenario);
          await settle(sessionId);
          const entries = traceRead(sessionId).slice(before);
          results.push({ ...result, visits: entries.length, map: o11CompactMap(entries) });
        }
      }
      return answer({ ok: results.every(r => r.ok), lane: 'o11', state: 'answered', results, wrapper: summary(lease),
        sessionId: sessionId ?? null, scope: 'same-module-action', execution: 'rest-wrapper', actionKind: lease.action.kind,
        roleValidation: 'original-native-actions', serviceBoundaryProved: false, userRequestIsolationProved: false });
    }
    catch (error) { return answer({ ok: false, lane: 'o11', error: safeError(error), results, wrapper: summary(lease) }); }
    finally {
      if (sessionId) { try { stopped = await debug({ op: 'stop', sessionId }); } catch { stopped = { ok: false }; }
        if (!stopped.ok && lease) { lease.state = 'uncertain'; saveLease(lease); } }
      if (appUser) { try { cleanup = await releaseUser(appUser); } catch { cleanup = { ok: false }; }
        if (!cleanup.ok && lease) { lease.state = 'uncertain'; saveLease(lease); } }
      if (input.op === 'run' && !input.keep && lease?.state === 'active') {
        try { lease = await remove(target, lease, o11Read(grantPath)); } catch { lease.state = 'removal-failed'; saveLease(lease); }
      }
      if (lease && (stopped || cleanup)) { lease.cleanup = { debuggerStopped: stopped?.ok ?? null, credentialsReleased: cleanup?.ok ?? null }; saveLease(lease); }
      if (returned) {
        returned.wrapper = summary(lease);
        returned.cleanup = { debuggerStopped: stopped?.ok ?? null, credentialsReleased: cleanup?.ok ?? null };
        if (lease?.state === 'uncertain' || lease?.state === 'removal-failed') { returned.ok = false; returned.error ??= 'debug_o11_run_cleanup_not_confirmed'; }
      }
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { if (returned) { returned.ok = false; returned.error ??= 'debug_o11_run_lock_cleanup_unproved'; } }
        if (lease?.state !== 'uncertain') try {
          const owner = o11Read(lockPath);
          if (owner.operationId !== ownOperationId || owner.pid !== process.pid || owner.host !== target.host || owner.moduleKey !== target.moduleKey)
            fail('debug_o11_run_lock_ownership_changed');
          fs.unlinkSync(lockPath);
        } catch { if (returned) { returned.ok = false; returned.error ??= 'debug_o11_run_lock_cleanup_unproved'; } }
      }
    }
  };
}
const targetWithLane = target => ({ lane: 'o11', ...target });
export const debugO11Run = createO11Runner();
