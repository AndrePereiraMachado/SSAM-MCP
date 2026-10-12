// Public coordination of the original published client debugger. The runner
// still owns authentication, publication checks, requests, locks and cleanup.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { workspaceRoot } from './workspace.mjs';
import { readNativeInspectionScopes } from './debug-native-scope-reader.mjs';
import { privateCompareHandlePattern } from './debug-private-compare.mjs';
import { admissionRules, describeQualification } from './debug-adapter-registry.mjs';
import { mountLifecycleScopesIssues, expandMountLifecycleScopes } from './debug-odc-mount-scopes.mjs';
import { inputCapabilities } from './debug-input-capabilities.mjs';
import { nativeBoundScopeCoverage } from './debug-native-inspection-metadata.mjs';
import { withScopeCategories } from './debug-scope-categories.mjs';
import { readClientScope, readScopeDescription } from './debug-read-scope.mjs';
import { roleCyclePending, ROLE_CYCLE_UNAVAILABLE } from './debug-foreign-pending.mjs';
const key = z.string().regex(/^[A-Za-z0-9_+]{22}$/);
const functionIdentity = /^[A-Za-z0-9_+]{22}(?:\.\#FlowExceptionHandler)?$/;
const ref = z.string().regex(/^[a-f0-9]{48}$/);
const operations = ['start', 'status', 'reconcile', 'pause', 'scope', 'read-scope', 'read', 'private-read', 'read-many', 'refresh', 'expand', 'children', 'slice', 'frame', 'stepInto', 'stepOver', 'stepOut', 'continue', 'stop', 'private-compare'];
const fail = code => { throw new Error('debug_client_session_' + code); };
const publicError = error => /^debug_[a-z0-9_:.@-]+$/i.test(error?.message ?? '') ? error.message : 'debug_client_session_failed';
// Embedding contract only. This is never merged into the MCP/CLI schema.
const privateConsumerSchema=z.object({sessionId:z.uuid(),stop:z.number().int().positive(),generation:z.number().int().nonnegative(),
  descriptor:z.object({reference:z.uuid(),expiresAt:z.iso.datetime(),sealed:z.literal(true),roundTripVerified:z.literal(true),
    storage:z.literal('windows-current-user-dpapi'),plaintextPersisted:z.literal(false)}).strict()}).strict();
export function clientSessionSchema(runSchema) {
  return z.object({ op: z.enum(operations), sessionId: z.uuid().optional(), run: runSchema.optional(),
    operationId: z.uuid().optional(),
    scopes: z.array(z.object({ functionKey: z.string().regex(functionIdentity), nodeKeys: z.array(key).min(1).max(20) }).strict()).min(1).max(20).optional(),
    scopesFrom: z.literal('mount-lifecycle').optional(),
    // start only: the original OutSystemsDebugger.pauseOnAllExceptions switch (boolean, never coerced).
    pauseOnExceptions: z.boolean().optional(),
    handles: z.array(z.string().regex(privateCompareHandlePattern)).min(1).max(8).optional(),
    mode: z.enum(['equality', 'identity']).optional(), anchor: z.literal('app-user').optional(),
    seconds: z.number().int().min(10).max(600).optional(),
    independentClientLocal: z.object({ operationId: z.uuid(), receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
      debugReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
    stop: z.number().int().positive().optional(), generation: z.number().int().nonnegative().optional(),
    ref: ref.optional(), refs: z.array(ref).min(1).max(500).optional(), detail: z.number().int().min(0).max(8).optional(),
    frame: z.number().int().nonnegative().optional(), path: z.string().min(1).max(2048).optional(), binary: z.boolean().optional(),
    offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(65536).optional(),
    afterRevision: z.number().int().nonnegative().optional(), waitMs: z.number().int().min(0).max(10000).optional(),
    // read-scope only: traversal budget (native reference limit 20000) and text page size.
    maxNodes: z.number().int().min(1).max(20000).optional(), textLimit: z.number().int().min(1).max(65536).optional(),
  }).strict().superRefine((v, ctx) => {
    const issue = message => ctx.addIssue({ code: 'custom', message });
    const allowed = new Set(['op', 'sessionId']);
    if (v.op === 'start') {
      ['run', 'scopes', 'scopesFrom', 'seconds', 'independentClientLocal', 'pauseOnExceptions'].forEach(k => allowed.add(k));
      if (!v.run || !(v.scopes || v.scopesFrom) || v.sessionId) issue('start needs run and scopes (or scopesFrom), without sessionId');
      // Admission comes from the adapter registry rows (parity with the former hand-written rule is tested there).
      if (v.run) { const verdict = admissionRules(v.run.lane ?? 'odc', 'client').admit(v.run); if (!verdict.ok) issue(verdict.message); }
      mountLifecycleScopesIssues(v).forEach(issue);
      if (v.scopesFrom && (v.run?.lane ?? 'odc') !== 'odc') issue('scopesFrom mount-lifecycle requires ODC');
      if (v.run?.roleCycle && (v.run.lane ?? 'odc') !== 'odc') issue('roleCycle requires ODC');
      if (v.run?.holdBetweenScenarios) issue('holdBetweenScenarios applies only to ODC server sessions');
      if (v.run?.interactions && (v.run.lifecycle !== 'mounted' || (v.run.lane ?? 'odc') !== 'odc')) issue('run.interactions require ODC run.lifecycle mounted');
      if (v.independentClientLocal && v.run?.lane !== 'odc') issue('independentClientLocal requires explicit ODC and pinned historical evidence');
      const keys = v.scopes?.flatMap(s => s.nodeKeys) ?? [];
      if (keys.length > 200 || new Set(keys).size !== keys.length) issue('breakpoint nodes must be unique, maximum 200');
    } else if (!v.sessionId) issue('sessionId is required');
    if (v.op === 'status') ['afterRevision', 'waitMs'].forEach(k => allowed.add(k));
    if (v.op === 'reconcile') { allowed.add('operationId'); if (!v.operationId) issue('reconcile requires the original operationId'); }
    if (v.op === 'pause') { allowed.add('afterRevision'); if (v.afterRevision === undefined) issue('pause requires the observed running revision'); }
    if (!['start', 'status', 'reconcile', 'stop', 'pause'].includes(v.op)) {
      ['stop', 'generation'].forEach(k => allowed.add(k));
      if (v.stop === undefined || v.generation === undefined) issue('commands require the observed stop and generation');
    }
    if (['read', 'private-read', 'refresh', 'expand'].includes(v.op)) { allowed.add('ref'); allowed.add('detail'); if (!v.ref) issue('ref is required'); }
    if (v.op === 'private-read') allowed.add('binary');
    if (v.op === 'read-many') { allowed.add('refs'); allowed.add('detail'); if (!v.refs || new Set(v.refs).size !== v.refs.length) issue('unique refs are required'); }
    if (v.op === 'expand') { allowed.add('path'); if (!v.path) issue('path is required'); }
    if (['children', 'slice'].includes(v.op)) {
      ['ref', 'offset', 'limit'].forEach(k => allowed.add(k));
      if (!v.ref) issue('ref is required');
      if (v.op === 'children' && v.limit > 150) issue('children limit is 150');
    }
    if (v.op === 'frame') { allowed.add('frame'); if (v.frame === undefined) issue('frame is required'); }
    if (v.op === 'read-scope') ['detail', 'maxNodes', 'textLimit'].forEach(k => allowed.add(k));
    if (v.op === 'private-compare') {
      ['handles', 'mode', 'anchor'].forEach(k => allowed.add(k));
      const count = (v.handles?.length ?? 0) + (v.anchor ? 1 : 0);
      if (!v.handles || new Set(v.handles).size !== v.handles.length || count < 2 || count > 8)
        issue('private-compare requires 2..8 unique handles, or handles plus anchor app-user');
    }
    for (const field of Object.keys(v)) if (!allowed.has(field)) issue(field + ' is not applicable to ' + v.op);
  });
}
// readMountTree: published-model tree reader for scopesFrom mount-lifecycle (default: the pinned kernel inspect).
// roleCycleAccess(tenant): ODC application-role access for run.roleCycle (default: the public ODC API).
export function createClientSessionManager({ root = workspaceRoot, run, readScopes = readNativeInspectionScopes, o11Broker, odcBroker, readMountTree, roleCycleAccess } = {}) {
  const sessions = new Map(), base = path.join(root, '.local', 'debugger', 'client-sessions');
  const snapshot = state => ({ ok: true, sessionId: state.id, lane: state.lane, runtime: 'client', state: state.phase,
    capabilities: { manualPause: { supported: true, mode: 'native-next-node', immediateSuspension: false, liveQualified: true } },
    inputCapabilities: inputCapabilities(state.lane, 'client'),
    ...(state.derivedScopes ? { derivedScopes: state.derivedScopes } : {}), ...(state.roleCycle ? { roleCycle: state.roleCycle } : {}),
    ...(state.pauseRequest ? { pauseRequest: state.pauseRequest } : {}), pauseOnExceptions: state.pauseOnExceptions === true,
    revision: state.revision, createdAt: state.createdAt, scopeComplete: false, metadataEvidence: state.metadataEvidence,
    ...(state.pause ? { pause: state.pause } : {}), ...(state.error ? { error: state.error } : {}),
    ...(state.lastCommandFailure ? { lastCommandFailure: state.lastCommandFailure } : {}),
    ...(state.stopEvidence ? { stopEvidence: state.stopEvidence } : {}),
    ...(state.result ? { runResult: state.result } : {}), receiptPath: state.file });
  function changed(state) {
    state.revision++;
    fs.writeFileSync(state.file + '.tmp', JSON.stringify(snapshot(state), null, 2)); fs.renameSync(state.file + '.tmp', state.file);
    for (const resolve of state.waiters.splice(0)) resolve();
  }
  function event(state, value) {
    if (value.kind === 'paused' && state.pauseRequest && Number.isInteger(value.callContextId)) {
      state.pauseRequest.observedContextIds = [...new Set([...(state.pauseRequest.observedContextIds ?? []), value.callContextId])];
      if (state.pauseRequest.callContextIds?.every(id => state.pauseRequest.observedContextIds.includes(id))) state.pauseRequest.outcome = 'observed';
    }
    if (value.kind === 'paused') { state.phase = 'paused'; state.pause = value; }
    else if (value.kind === 'resumed') { state.phase = 'running'; state.pause = undefined; }
    else if (['expired', 'inspection-failed'].includes(value.kind)) { state.phase = 'ending'; state.pause = undefined; state.error = value.error ?? 'debug_native_client_expired'; }
    changed(state);
  }
  function ensureActive(state) { if (state.cancelled) fail('cancelled'); }
  // preread: the Model API read of a derived (mount-lifecycle) expansion, reused instead of reading the same scopes again.
  async function metadata(state, source, moduleKey, modelSources = [], preread) {
    ensureActive(state);
    let result;
    try { result = preread ?? await readScopes({ lane: state.lane, source, moduleKey, scopes: state.scopes, directory: path.join(base, state.id) }); }
    catch (error) { state.error = publicError(error); changed(state); throw error; }
    ensureActive(state); state.metadataEvidence = result.evidence; state.coverage = [...(result.coverage ?? [])];
    state.modelBinding = { source, moduleKey };
    state.modelBindings = new Map([[moduleKey, state.modelBinding]]);
    if (!Array.isArray(modelSources) || modelSources.length > 64) fail('producer_source_unavailable');
    for (const binding of modelSources) {
      if (!/^[A-Za-z0-9_+]{22}$/.test(binding?.moduleKey ?? '') || !/^[a-f0-9]{64}$/i.test(binding.source?.sha256 ?? '') ||
          !path.isAbsolute(binding.source?.path ?? '') ||
          createHash('sha256').update(fs.readFileSync(binding.source.path)).digest('hex') !== binding.source.sha256.toLowerCase()) fail('producer_source_unavailable');
      const existing = state.modelBindings.get(binding.moduleKey);
      if (existing && (existing.source.path !== binding.source.path || existing.source.sha256.toLowerCase() !== binding.source.sha256.toLowerCase()))
        fail('producer_source_conflict');
      state.modelBindings.set(binding.moduleKey, binding);
    }
    result.modules = [...state.modelBindings.values()].map(b => ({moduleKey:b.moduleKey,sourceSha256:b.source.sha256.toLowerCase()}));
    state.functionHashes = new Map();
    rememberFunctionHashes(state, result, state.modelBinding);
    state.loadedScopes = new Set(state.scopes.flatMap(s => s.nodeKeys.map(n => moduleKey + ':' + s.functionKey + ':' + n + ':')));
    changed(state);
    return result;
  }
  function rememberFunctionHashes(state, result, binding) {
    if (!Array.isArray(result.functionHashes) || !result.functionHashes.length) fail('function_hash_unavailable');
    for (const item of result.functionHashes) {
      if (item.moduleKey !== binding.moduleKey || item.sourceSha256 !== binding.source.sha256.toLowerCase() ||
          !functionIdentity.test(item.functionKey ?? '') || !/^[A-Za-z0-9_+]{22}$/.test(item.debuggerHash ?? '')) fail('function_hash_unavailable');
      const identity = item.moduleKey + ':' + item.functionKey;
      const previous = state.functionHashes.get(identity);
      if (previous && previous !== item.debuggerHash) fail('function_hash_changed');
      state.functionHashes.set(identity, item.debuggerHash);
    }
  }
  async function bindFrameScope(state, input) {
    const observed = state.pause, current = observed.frames?.[observed.frame];
    const [moduleKey, functionKey, , debuggerHash] = String(current?.elementKey ?? '').split(':');
    const breakpoint = String(current?.breakpoint ?? '').split(':');
    const nodeKey = breakpoint[1];
    const previous = current?.previousBreakpoint == null ? null : String(current.previousBreakpoint).split(':');
    if (previous && (previous[0] !== moduleKey || !/^[A-Za-z0-9_+]{22}$/.test(previous[1] ?? ''))) fail('previous_scope_unavailable');
    const previousNodeKey = previous?.[1] ?? null;
    if (![moduleKey, nodeKey].every(v => /^[A-Za-z0-9_+]{22}$/.test(v ?? '')) || !functionIdentity.test(functionKey ?? '')) fail('scope_frame_unavailable');
    if (breakpoint[0] !== moduleKey) fail('scope_frame_unavailable');
    const binding = state.modelBindings.get(moduleKey);
    if (!binding) fail('producer_source_unavailable');
    if (!/^[A-Za-z0-9_+]{22}$/.test(debuggerHash ?? '')) fail('function_hash_unavailable');
    const assertFunctionHash = () => {
      if (state.functionHashes.get(moduleKey + ':' + functionKey) !== debuggerHash) fail('function_hash_mismatch');
    };
    const identity = moduleKey + ':' + functionKey + ':' + nodeKey + ':' + (previousNodeKey ?? '');
    if (state.loadedScopes.has(identity)) { assertFunctionHash(); return; }
    const result = await readScopes({ lane: state.lane, ...binding,
      scopes: [{ functionKey, nodeKeys: [nodeKey], ...(previousNodeKey ? { previousNodeKey } : {}) }],
      directory: path.join(base, state.id, 'frames', createHash('sha256').update(identity).digest('hex')) });
    // Reading the model must not renew the lease or permit a bind after a
    // timeout, cancellation, frame change or new native stop.
    if (state.phase !== 'paused' || state.pause?.stop !== input.stop || state.pause?.generation !== input.generation) fail('stale_stop');
    rememberFunctionHashes(state, result, binding); assertFunctionHash();
    const bound = await state.handle.inspection({ op: 'bind-scope', stop: input.stop, generation: input.generation,
      moduleKey, functionKey, nodeKey, previousNodeKey, sourceSha256: binding.source.sha256.toLowerCase(), variables: result.variables });
    if (bound.metadataBound !== true) fail('scope_binding_failed');
    state.loadedScopes.add(identity); state.metadataEvidence.push(...result.evidence); state.coverage.push(...(result.coverage ?? [])); changed(state);
  }
  function instrument(state, handle, model) {
    return { ...handle,
      async authenticate(descriptor) {
        ensureActive(state); state.phase = 'authenticating'; changed(state);
        const authenticated = await handle.authenticate(descriptor);
        if (authenticated.authenticated !== true) return authenticated;
        ensureActive(state);
        const leaseMs = Math.min(state.seconds * 1000, Date.parse(descriptor.expiresAt) - Date.now());
        if (!Number.isFinite(leaseMs) || leaseMs < 1000) fail('lease_expired');
        await handle.configureInspection({ modules: model.modules, variables: model.variables, breakpoints: model.breakpoints,
          pauseOnExceptions: state.pauseOnExceptions === true, leaseMs, onEvent: value => event(state, value) });
        state.handle = handle; state.phase = 'running'; changed(state);
        return authenticated;
      },
      async invoke(input) { ensureActive(state); return handle.invoke(input); },
    };
  }
  async function execute(state, request) {
    try {
      const services = { requireClientInspection: true, ...(state.clientLocal ? { clientLocal: state.clientLocal } : {}) };
      services.prepareUser = async (...args) => {
        ensureActive(state); state.phase = 'sign-in'; changed(state);
        const entered = await (await import('./debug-app-user.mjs')).prepareDebugAppUser(...args);
        // Always return an entered descriptor to the runner that owns its
        // release, including cancellation while the private dialog was open.
        if (!state.cancelled) { state.phase = 'preparing'; changed(state); }
        return entered;
      };
      if (state.lane === 'o11') {
        const broker = o11Broker ?? (await import('./debug-o11-native-entry.mjs')).createO11NativeEntryBroker({ root });
        const nativeBroker = { async prepare(input) {
          ensureActive(state);
          const bytes = fs.readFileSync(input.sourceContract.path);
          if (createHash('sha256').update(bytes).digest('hex') !== input.sourceContract.sha256) fail('source_changed');
          const contract = JSON.parse(bytes);
          const model = await metadata(state, contract.snapshot, contract.target.moduleKey, contract.modelSources);
          return instrument(state, await broker.prepare(input), model);
        } };
        services.runO11 = (await import('./debug-o11-native-run.mjs')).createO11NativeRun({ root, nativeBroker,
          prepareUser: services.prepareUser, requireClientInspection: true });
        // Tests may provide a runner that exercises the same broker contract.
        services.nativeBroker = nativeBroker;
      } else {
        services.broker = options => {
          const handle = odcBroker(options); let wrapped;
          // The authorized mount prepares the owned browser instead of the isolated host;
          // both bind the published scopes before sign-in and configure inspection after it.
          const bind = async input => {
            let preread;
            if (state.scopesFrom === 'mount-lifecycle') {
              // Breakpoints of every declared screen/block handler, from the pinned mount plan and published model.
              let derived;
              try { derived = await expandMountLifecycleScopes(input.prepared, readScopes, { moduleKey: input.binding.moduleKey,
                directory: path.join(base, state.id), ...(readMountTree ? { readTree: readMountTree } : {}) }); }
              catch (error) { state.error = publicError(error); changed(state); throw error; }
              state.scopes = derived.scopes; state.derivedScopes = { scopesFrom: derived.scopesFrom, roots: derived.roots, limits: derived.limits };
              preread = derived.metadata;
            }
            const model = await metadata(state, input.prepared.sourceContract, input.binding.moduleKey, input.modelSources, preread);
            wrapped = instrument(state, handle, model);
          };
          return { ...handle, async prepare(input) { await bind(input); return handle.prepare(input); },
            async prepareBrowser(input) { await bind(input); return handle.prepareBrowser(input); },
            authenticate: descriptor => wrapped.authenticate(descriptor), invoke: input => wrapped.invoke(input) };
        };
      }
      // roleCycle is coordinator-only: the runner request never carries it. The grant precedes the app-user sign-in.
      const { roleCycle, ...runRequest } = request;
      if (roleCycle) {
        const { runWithRoleCycle, odcRoleCycleAccess, appUserKeyResolver } = await import('./debug-odc-role-cycle.mjs');
        const access = roleCycleAccess ? await roleCycleAccess(request.tenant) : odcRoleCycleAccess({ tenant: request.tenant,
          access: await (await import('./sc-portal-access.mjs')).createAccess(), resolveUserKey: appUserKeyResolver() });
        state.result = await runWithRoleCycle({ roleKey: roleCycle.roleKey, words: roleCycle.words, access, journalDir: path.join(base, state.id, 'role-cycle') },
          ({ wrapPrepareUser }) => run(runRequest, { services: { ...services, prepareUser: wrapPrepareUser(services.prepareUser) } }));
      } else state.result = await run(runRequest, { services });
      state.phase = state.result.uncertain ? 'uncertain' : state.result.ok ? 'completed' : 'failed';
    } catch (error) { state.phase = error?.roleCycle?.uncertain ? 'uncertain' : 'failed'; state.error = publicError(error); if (error?.roleCycle) state.roleCycle = error.roleCycle; }
    finally { state.handle = undefined; state.pause = undefined; changed(state); }
  }
  const manager = async input => {
    if (input.op === 'start') {
      // Port D7: the default roleCycle access is sc-portal-access.mjs (SC/Portal). While it is pending, a roleCycle start
      // is refused typed here, before any session, sign-in or role write; an injected roleCycleAccess needs no file.
      const roleCycleRefusal = input.run?.roleCycle && !roleCycleAccess ? roleCyclePending() : null;
      if (roleCycleRefusal) throw new Error(roleCycleRefusal);
      const lane = input.run.lane ?? 'odc';
      if ([...sessions.values()].filter(s => !['completed', 'failed', 'uncertain'].includes(s.phase)).length >= 8) fail('capacity');
      const id = randomUUID(); fs.mkdirSync(base, { recursive: true });
      const state = { id, lane, phase: 'preparing', revision: 0, createdAt: new Date().toISOString(),
        file: path.join(base, id + '.json'), scopes: input.scopes, scopesFrom: input.scopesFrom, seconds: input.seconds ?? 120,
        clientLocal: input.independentClientLocal, pauseOnExceptions: input.pauseOnExceptions === true, coverage: [], waiters: [], commands: Promise.resolve() };
      sessions.set(id, state); changed(state);
      // Retained by the persistent MCP server, not by a short-lived CLI call.
      state.task = execute(state, { ...input.run, lane, execution: 'native-entry', trace: 'none' });
      return snapshot(state);
    }
    const state = sessions.get(input.sessionId);
    if (!state) {
      if (!['status','reconcile'].includes(input.op)) fail('owner_unavailable');
      const file = path.join(base, input.sessionId + '.json');
      if (!fs.existsSync(file)) fail('not_found');
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (input.op === 'reconcile') return (await import('./debug-client-private-reconcile.mjs')).reconcileClientPrivateValues(root,stored,input.operationId);
      return { ...stored, ownerAvailable: false, ...(['completed', 'failed', 'uncertain'].includes(stored.state) ? {} : { state: 'owner-unavailable', executionOutcome: 'requires-reconciliation' }) };
    }
    if (input.op === 'reconcile') fail('owner_available');
    if (input.op === 'status') {
      // A cursorless wait starts at the current revision. Immediate responses in
      // an in-memory MCP polling loop can otherwise starve worker exit events.
      // Terminal receipts and changes since an explicit cursor return at once.
      if (input.waitMs && !['completed', 'failed', 'uncertain'].includes(state.phase) &&
          (input.afterRevision === undefined || input.afterRevision === state.revision)) {
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); state.waiters = state.waiters.filter(fn => fn !== done); resolve(); };
          const timer = setTimeout(done, input.waitMs); state.waiters.push(done);
        });
      }
      return snapshot(state);
    }
    const pending = state.commands.then(async () => {
      if (input.op === 'pause') {
        if (state.phase !== 'running' || !state.handle || input.afterRevision !== state.revision) fail('pause_stale_revision');
        if (state.pauseRequest && state.pauseRequest.outcome !== 'observed') fail('pause_request_pending');
        state.pauseRequest = { requested: true, outcome: 'pending', mode: 'native-next-node', at: new Date().toISOString() };
        changed(state);
        try {
          const result = await state.handle.inspection({ op: 'request-pause' });
          if (result?.requested !== true || result?.mode !== 'native-next-node' || !Array.isArray(result.callContextIds) || !result.callContextIds.length || !result.callContextIds.every(Number.isInteger)) fail('pause_acknowledgement_invalid');
          state.pauseRequest.outcome = 'acknowledged';
          state.pauseRequest.callContextIds = result.callContextIds;
          if (result.callContextIds.every(id => state.pauseRequest.observedContextIds?.includes(id))) state.pauseRequest.outcome = 'observed';
          changed(state);
          return snapshot(state);
        } catch (error) { state.pauseRequest.outcome = 'uncertain'; changed(state); throw error; }
      }
      if (input.op === 'stop') {
        if (['completed', 'failed', 'uncertain'].includes(state.phase)) return snapshot(state);
        state.cancelled = true; state.phase = 'ending'; changed(state);
        // A native stop terminates this invocation. Only its runner receipt
        // can establish whether any request was submitted or cleanup finished.
        if (state.handle) {
          const stopped = await state.handle.inspection({ op: 'stop' });
          // Persist the control acknowledgement separately from the runner's
          // completion. Killing a paused process does not prove an action reply,
          // process exit, or credential release.
          const cleanup = stopped?.privateInspectionCleanup;
          state.stopEvidence = { command: 'stop', acknowledgedAt: new Date().toISOString(),
            workerTerminationRequested: stopped?.workerTerminated === true,
            executionOutcome: 'requires-reconciliation',
            ...(typeof cleanup?.completed === 'boolean' && Number.isSafeInteger(cleanup.pending) && cleanup.pending >= 0 &&
                (!cleanup.completed || cleanup.pending === 0)
              ? { privateInspectionCleanup: { completed: cleanup.completed, pending: cleanup.pending } } : {}) };
          changed(state);
        }
        return snapshot(state);
      }
      if (state.phase !== 'paused' || !state.handle || state.pause.stop !== input.stop || state.pause.generation !== input.generation) fail('stale_stop');
      // One traversal of the whole frame (debug-read-scope.mjs) as a single queue entry: no step or private consumer interleaves.
      if (input.op === 'read-scope') return { ...await readClientScope({
        scope: async () => { await bindFrameScope(state, input); const r = await state.handle.inspection({ op: 'scope' });
          return withScopeCategories(nativeBoundScopeCoverage({ ok: true, ...r }, state.coverage), state.lane, 'client'); },
        inspection: command => state.handle.inspection(command),
        current: () => !state.cancelled && state.phase === 'paused' && !!state.handle && state.pause?.stop === input.stop && state.pause?.generation === input.generation,
      }, { lane: state.lane, stop: input.stop, generation: input.generation, detail: input.detail, maxNodes: input.maxNodes, textLimit: input.textLimit }), sessionId: state.id };
      if (input.op === 'scope') await bindFrameScope(state, input);
      const command = Object.fromEntries(Object.entries(input).filter(([k]) => !['sessionId', 'stop', 'generation'].includes(k)));
      if (['stepInto', 'stepOver', 'stepOut', 'continue'].includes(input.op)) {
        state.phase = 'running'; state.pause = undefined; changed(state);
      }
      const result = await state.handle.inspection(command);
      if (input.op === 'frame' && state.pause?.stop === input.stop) { state.pause = { ...state.pause, ...result }; changed(state); }
      const reply = { ok: true, ...result, nativeSessionId: result.sessionId, sessionId: state.id };
      // Frame-bound coverage (exactly one matching read coverage) and per-runtime categories.
      return input.op === 'scope' ? withScopeCategories(nativeBoundScopeCoverage(reply, state.coverage), state.lane, 'client') : reply;
    });
    const reported = pending.catch(error => {
      state.lastCommandFailure = { op: input.op, error: publicError(error), at: new Date().toISOString(),
        ...(input.stop !== undefined ? { stop: input.stop, generation: input.generation } : {}) };
      changed(state);
      throw error;
    });
    state.commands = reported.catch(() => {}); return reported;
  };
  // Trusted local debugger views can receive values through a callback. They
  // share the command queue with controls, so a queued step cannot race a read.
  manager.consumePrivate = async (raw,consumer) => {
    const parsed=privateConsumerSchema.safeParse(raw);
    if(!parsed.success || typeof consumer!=='function')fail('private_consumer_invalid');
    const input=parsed.data,state=sessions.get(input.sessionId);
    if(!state)fail('owner_unavailable');
    const pending=state.commands.then(async()=>{
      if(state.cancelled || state.phase!=='paused' || !state.handle || state.pause?.stop!==input.stop || state.pause?.generation!==input.generation)
        fail('stale_stop');
      if(typeof state.handle.consumePrivateInspection!=='function')fail('private_consumer_unavailable');
      let callbackFailed = false;
      try {
        const result=await state.handle.consumePrivateInspection(input.descriptor,async (...args) => {
          try { await consumer(...args); }
          catch { callbackFailed = true; throw new Error('debug_client_session_private_callback_failed'); }
        });
        if(result?.consumed!==true)fail('private_consumer_failed');
        return {consumed:true,sessionId:state.id,stop:input.stop,generation:input.generation,frame:result.frame};
      }catch{fail(callbackFailed ? 'private_consumer_callback_failed' : 'private_consumer_failed');}
    });
    state.commands=pending.catch(()=>{});return pending;
  };
  return manager;
}
export function registerClientSessionTool(server, runSchema, wrap) {
  let manager;
  const schema = clientSessionSchema(runSchema);
  server.registerTool('ssam_debug_client', { title: 'Inspect an original client debugger session',
    description: 'Persistent MCP interactive client inspection for O11/ODC. start takes an original ssam_debug_run request with trace:none and scopes [{functionKey,nodeKeys}] from the published model, or, only with run.lifecycle:"mounted" (ODC), scopesFrom:"mount-lifecycle", which derives Start/End breakpoints of every declared non-absent screen and block lifecycle handler from the pinned mount plan and published model (cap 40 functions/400 nodes, refused rather than truncated; implemented, live proof pending). Scope metadata is read through the installed Model API with the actual published hash. No caller-supplied variables, evaluator code or inspector URL. Returns immediately; status with afterRevision/waitMs observes preparation, private app-user sign-in, native pauses and final runner receipt. pause requires afterRevision from a running status and requests original stepInto for currently active, model-bound client contexts. It is a cooperative next-node stop, not immediate JavaScript suspension. Acknowledgement is separate from an observed native stop; pending or uncertain requests cannot be resent. Other inspection commands require the observed stop and generation. read-many evaluates native references in one transport command. private-read evaluates the original native value into a private DPAPI record and returns only an opaque reference; internal consumers require separate private authority. Private references expire on frame/control/end. private-read also returns privateCompareHandle, an opaque in-memory handle to an HMAC-SHA256 fingerprint of the native value under a random per-session key; private-compare {stop, generation, handles:[2..8] | handles plus anchor:"app-user", mode?:"equality"|"identity"} returns only {equal,bothNonEmpty,sameNativeType,valueType,count}, never a value, hash or key; exact native typed equality without coercion or evaluation; caller-supplied values are refused; handles survive steps and are destroyed at stop; anchor app-user needs a coordinator anchor provider; implemented, live proof pending. start.pauseOnExceptions (boolean, start only) enables the original OutSystemsDebugger.pauseOnAllExceptions on both lanes; a stop raised by the native handleException reports pause.reason "exception" and pause.exception {type, typeRedacted, family?} (allowlisted native class names only; specificType and message never copied); breakpoint/step stops carry no reason. scope returns metadataBound, context {moduleKey,functionKey,nodeKey,previousNodeKey} and, when the frame identity matches exactly one read coverage, metadataCoverage (variableCounts, runtimeValuesComplete:false until a bound completeness result); categories notApplicableToRuntime (client: session/site/setting/timer; ODC session with reason odc-model-refuses-session-variables), emptyInModel (frame-bound count 0) and notEnumerated; unavailableCategories lists only notEnumerated. ODC run.lifecycle:"mounted" also takes run.navigate {screen:"@key", back:true} with scenarios[].context.screen.inputs (target InputParameters Text/Integer/LongInteger as the URL query; one original SDK navigateTo + navigateBack per scenario; full reload refused) or, without navigate, an initial deep link to a qualified named route (one scenario); OnDestroy counts only after that authorized navigation; scopesFrom mount-lifecycle also derives Start/End breakpoints of the navigation target handlers (target OnInitialize, OnDestroy fired by navigateBack). ODC run.lifecycle:"mounted" also takes run.interactions [{target:"@<widgetKey>"|"<WidgetName>", event:"click"}] (max 10): after the lifecycle settles, one journaled trusted CDP click per entry in the SSAM-owned headless page (hidden, disabled, ambiguous, obscured or unresolved targets refused; the result journal proves the dispatch only, handlerInvoked null; report.interactions[].handlerObserved needs a native stop on the handler, so add scopes on the handler action; a lost reply stays uncertain with its lock; the onClick handler closure effects join acknowledgeEffects). The original SDK error path is observed read-only even when the error navigation destroys the ready wait: with pauseOnExceptions a lifecycle exception through the SDK error page is the known failure debug_odc_native_mount_lifecycle_exception (lifecycleException.phase ready|lifecycle|interaction); the error page without an exception stop is debug_odc_native_mount_error_page_observed; handlerCoverage.exceptionHandlers lists FlowExceptionHandler stops. These are implemented, live proof pending. status.inputCapabilities lists the SSAM-imposed input caps. ' + (roleCyclePending() ? 'ODC run.roleCycle {roleKey,words} (one application role granted before the app-user sign-in and revoked after the run) ' + ROLE_CYCLE_UNAVAILABLE + '; '
      : 'ODC run.roleCycle {roleKey,words} grants one application role before the app-user sign-in and revokes it after the run (runResult.roleCycle; implemented, live proof pending); ') +
      'holdBetweenScenarios is refused for client sessions. ' + describeQualification('o11', 'client') + ' ' + describeQualification('odc', 'client') + ' Native return trees and compound variables support children pages (offset/limit, maximum 150); variable child references use the original evaluator path grammar, while return children project the native return descriptor. Text slice pages also support inputs and variables (offset/limit, maximum 65536 UTF-16 units); non-return values retain the 2 MiB evaluation budget. These present the original evaluator response after privacy filtering, with nativeValueProjection:true; they do not submit child expressions to the evaluator. Each page includes continuation and value hash; references require the same current stop and generation. stepInto/Over/Out and continue consume that pause; stale commands are refused. stop terminates the invocation and may require reconciliation; completion and cleanup come only from runResult. Expiry is fixed and bounded by the app-user lease. References expire on frame/step. Selected scopes set the initial breakpoints. At scope requests, new observed nodes and selected frames in the entry module are loaded on demand from the same pinned published model. O11 producer models captured by the runner are pinned in the source contract and read on demand; their native function debugger hash must match the paused frame before scope binding. Unbound producers are refused. O11 live qualification covers one Integer client function boundary from a consumer into a Library: three scenarios, 27 native pauses, observed inputs/locals/outputs/returns, and confirmed cleanup. ODC client inspection also binds Library sources already acquired from model calls at their imported revision; complete producer discovery and live ODC intermodule qualification remain pending; this does not prove browser rendering or user/role propagation. Optional independentClientLocal (ODC) supplies exact historical operation/receipt/debug receipt/manifest hashes: the existing qualifier requires a stopped debugger, absent process, expired credentials and an independently verified original body: literal/direct-input screen state assignments, model-matched Integer input/local/output assignments, closed same-module Integer/Text function graphs with model-matched native handleFunctionCall wrappers (live ODC return proof in Quotes r132), or a closed nonrecursive client-only graph of original branches/state assignments and parameterless local client actions. The graph qualifier pins owner-variable metadata and original ClientVariablesService setters; external calls, identity-variable writes and business requests are refused. The invocation request barrier remains active. It preserves the historical lock and unknown outcome; it never authorizes replay or server requests. Survives tool calls within the same MCP process; after owner loss status reports uncertainty, never replays. reconcile {operationId} after owner loss runs the store-rule private-values check and, for O11, archives the client mutex by rename (<op>/reconciled-client-aborted.lock, receipt ssam-o11-client-aborted-reconciliation/1) only when zero business requests were submitted (executionOutcome aborted-unconfirmed, never replayed; a lease, worker or pending store keeps the lock with an additive blocked receipt); implemented, live proof pending. No model edits or publication. ' + readScopeDescription.client,
    inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, wrap(async raw => {
    const input = schema.parse(raw);
    if (!manager) manager = createClientSessionManager({ run: (await import('./debug-run.mjs')).debugRun,
      odcBroker: (await import('./debug-odc-native-broker.mjs')).createOdcNativeBroker });
    return manager(input);
  }));
  return Object.freeze({consumePrivate:(input,consumer)=>{
    if(!manager)fail('owner_unavailable');
    return manager.consumePrivate(input,consumer);
  }});
}
