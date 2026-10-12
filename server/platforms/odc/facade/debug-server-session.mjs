// Coordinates the original runner and installed SERVER debugger. Native worker
// owns evaluation; runner owns requests, authentication and terminal cleanup.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { workspaceRoot } from './workspace.mjs';
import { debugSchema, inspectionSchema } from './debug.mjs';
import { readNativeInspectionScopes } from './debug-native-scope-reader.mjs';
import { nativeBoundScopeCoverage } from './debug-native-inspection-metadata.mjs';
import { createO11SessionGroup } from './debug-o11-session-group.mjs';
import { createPrivateCompareSession, privateCompareCommand, privateCompareHandlePattern } from './debug-private-compare.mjs';
import { serverCapabilities } from './debug-server-capabilities.mjs';
import { createO11RequestHold, verifyO11GatewayEvidence } from './debug-o11-request-hold.mjs';
import { createServerGlobalHistory } from './debug-server-global-history.mjs';
import { admissionRules, describeQualification } from './debug-adapter-registry.mjs';
import { inputCapabilities } from './debug-input-capabilities.mjs';
import { withScopeCategories } from './debug-scope-categories.mjs';
import { admitO11CallbackScopes } from './debug-o11-native-callbacks.mjs';
import { runNowStartAdmission, RUN_NOW_TRIGGER } from './debug-o11-runnow-interactive.mjs';
import { portalWakeStartAdmission, PORTAL_WAKE_TRIGGER } from './debug-odc-portal-wake-interactive.mjs';
import { createAppUserAnchorRegistry, createProducerOutputParity } from './debug-server-private-inspection.mjs';
import { readServerScope, readScopeDescription } from './debug-read-scope.mjs';
import { roleCyclePending, ROLE_CYCLE_UNAVAILABLE } from './debug-foreign-pending.mjs';
const fail = code => { throw new Error('debug_server_session_' + code); };
const safe = error => /^debug_[a-z0-9_:.@-]+$/i.test(error?.message ?? '') ? error.message : 'debug_server_session_failed';
const terminal = phase => ['completed', 'failed', 'uncertain'].includes(phase);
const key = z.string().regex(/^[A-Za-z0-9_+]{22}$/);
const reference = z.string().regex(/^[a-f0-9]{32}$/);
// O11 Traditional Preparation functions carry the native '<key>.#Preparation' identity (O11 only, checked below).
const functionKey = z.string().regex(/^[A-Za-z0-9_+]{22}(?:\.#Preparation)?$/);
const ops = ['start', 'status', 'stop', 'pause', 'resume', 'reconcile', 'scope', 'read', 'private-read', 'read-many', 'read-frame', 'read-scope', 'refresh', 'expand', 'frame', 'step-into', 'step-over', 'step-out', 'continue', 'private-compare'];
// Session-level commands: no observed stop token (private-compare handles survive steps until stop).
const sessionOps = ['start', 'status', 'stop', 'pause', 'resume', 'reconcile', 'private-compare'];
export function serverSessionSchema(runSchema) {
  return z.object({ op: z.enum(ops), sessionId: z.uuid().optional(), run: runSchema.optional(),
    handles: z.array(z.string().regex(privateCompareHandlePattern)).min(1).max(8).optional(),
    mode: z.enum(['equality', 'identity']).optional(), anchor: z.literal('app-user').optional(),
    scopes: z.array(z.object({ moduleKey: key.optional(), functionKey, nodeKeys: z.array(key).min(1).max(20) }).strict()).min(1).max(20).optional(),
    seconds: z.number().int().min(30).max(600).optional(),
    independentStaticRead: z.object({ operationId: z.uuid(), receiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
      debugReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/), manifestSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
    afterRevision: z.number().int().nonnegative().optional(), waitMs: z.number().int().min(0).max(10000).optional(),
    threadId: z.string().min(1).max(200).optional(), eventId: z.string().regex(/^\d+$/).optional(), generation: z.number().int().positive().optional(),
    reference: reference.optional(), references: z.array(reference).min(1).max(500).optional(),
    frame: z.number().int().min(0).max(100).optional(), depth: z.number().int().min(0).max(4).optional(),
    childPath: z.string().max(500).regex(/^(?:\.[A-Za-z_][A-Za-z0-9_]*|\[(?:0|[1-9][0-9]{0,8})\])+$/).optional(),
    offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(150).optional(),
    textOffset: z.number().int().nonnegative().optional(), textLimit: z.number().int().min(1).max(16384).optional(),
    maxNodes: z.number().int().min(1).max(20000).optional(),
    // reconcile only: re-check an existing O11 prestart archive read-only (verifyO11PrestartArchive).
    verify: z.boolean().optional(),
  }).strict().superRefine((v, ctx) => {
    const issue = message => ctx.addIssue({ code: 'custom', message }), allowed = new Set(['op', 'sessionId']);
    if (v.op === 'start') {
      ['run', 'scopes', 'seconds', 'independentStaticRead'].forEach(k => allowed.add(k));
      if (!v.run || !v.scopes || v.sessionId) issue('start requires run and scopes without sessionId');
      if (v.independentStaticRead && v.run?.lane !== 'odc') issue('independentStaticRead requires explicit ODC and pinned historical evidence');
      // Admission comes from the adapter registry rows (parity with the former hand-written rule is tested there).
      // O11 Run Now (a Timer without a REST/SOAP caller) and O11 endpoint credentials have their own rules.
      if (v.run?.trigger === PORTAL_WAKE_TRIGGER) {
        // ODC Timer woken by the original Portal action (no app caller): words, no launch/inputs/workflow, trace full.
        const verdict = portalWakeStartAdmission({ ...v.run, execution: v.run.execution ?? 'native-entry' });
        if (!verdict.ok) issue(verdict.message);
      } else if (v.run?.trigger === RUN_NOW_TRIGGER) {
        const verdict = runNowStartAdmission({ ...v.run, execution: v.run.execution ?? 'native-entry', trace: v.run.trace ?? 'full' });
        if (!verdict.ok) issue(verdict.message);
      } else if (v.run?.contextMode === 'endpoint-credential') {
        // Both lanes; the runner admits it only for an original endpoint entry whose capability requires it
        // (the credential scheme comes from that capability, never from the request).
        if (!['o11', 'odc'].includes(v.run.lane) || v.run.op !== 'run' || v.run.execution && v.run.execution !== 'native-entry' || v.run.trace && v.run.trace !== 'full' || v.run.launch || v.run.workflow || v.run.trigger)
          issue('endpoint-credential requires an explicit O11 or ODC native-entry endpoint run with trace full, without launch, workflow or trigger');
      } else if (v.run) { const verdict = admissionRules(v.run.lane ?? 'odc', 'server').admit(v.run); if (!verdict.ok) issue(verdict.message); }
      if (v.run?.holdBetweenScenarios && ((v.run.lane ?? 'odc') !== 'odc' || v.independentStaticRead))
        issue('holdBetweenScenarios requires ODC without independentStaticRead; O11 reflects the change inside the pause');
      if (v.run?.roleCycle && (v.run.lane ?? 'odc') !== 'odc') issue('roleCycle requires ODC');
      const nodes = v.scopes?.flatMap(s => s.nodeKeys) ?? [];
      if (nodes.length > 20 || new Set(nodes).size !== nodes.length) issue('initial nodes must be unique, maximum 20');
      // ODC: one explicit owner, the consumer of the runner-bound library-reference pair (checked again at binding).
      const owners = new Set((v.scopes ?? []).filter(s => s.moduleKey).map(s => s.moduleKey));
      if (v.run?.lane !== 'o11' && (owners.size > 1 || owners.size && v.independentStaticRead))
        issue('ODC explicit initial breakpoint owners name only the consumer of a library-reference pair');
      if (v.run?.lane !== 'o11' && v.scopes?.some(s => s.functionKey.includes('.#'))) issue('Native Preparation function keys apply only to O11');
    } else if (!v.sessionId) issue('sessionId is required');
    if (v.op === 'status') ['afterRevision', 'waitMs'].forEach(k => allowed.add(k));
    if (v.op === 'reconcile') allowed.add('verify');
    if (v.op === 'pause') { allowed.add('afterRevision'); if(v.afterRevision===undefined)issue('pause requires the last observed status revision'); }
    if (v.op === 'resume') { allowed.add('afterRevision'); if (v.afterRevision === undefined) issue('resume requires the last observed status revision'); }
    if (v.op === 'private-compare') {
      ['handles', 'mode', 'anchor'].forEach(k => allowed.add(k));
      const count = (v.handles?.length ?? 0) + (v.anchor ? 1 : 0);
      if (!v.handles || new Set(v.handles).size !== v.handles.length || count < 2 || count > 8)
        issue('private-compare requires 2..8 unique handles, or handles plus anchor app-user');
    }
    if (!sessionOps.includes(v.op)) {
      ['threadId', 'eventId', 'generation'].forEach(k => allowed.add(k));
      if (!v.threadId || !v.eventId || !v.generation) issue('observed threadId, eventId and generation are required');
    }
    if (['read', 'private-read', 'read-many', 'refresh', 'expand'].includes(v.op)) {
      ['depth', 'offset', 'limit', 'textOffset', 'textLimit'].forEach(k => allowed.add(k));
      if (v.op === 'read-many') { allowed.add('references'); if (!v.references || new Set(v.references).size !== v.references.length) issue('unique references required'); }
      else { allowed.add('reference'); if (!v.reference) issue('reference required'); }
    }
    if (v.op === 'read-frame') ['depth', 'offset', 'textLimit', 'maxNodes'].forEach(k => allowed.add(k));
    if (v.op === 'read-scope') ['depth', 'textLimit', 'maxNodes'].forEach(k => allowed.add(k));
    if (v.op === 'expand') allowed.add('childPath');
    if (v.op === 'frame') { allowed.add('frame'); if (v.frame === undefined) issue('frame required'); }
    for (const field of Object.keys(v)) if (!allowed.has(field)) issue(field + ' does not apply to ' + v.op);
  });
}
// roleCycleAccess(tenant) supplies the ODC application-role access (tests inject a fake; default: public ODC API).
export function createServerSessionManager({ root = workspaceRoot, run, debug, readScopes = readNativeInspectionScopes, bindScope, o11Runner, prepareUser, roleCycleAccess, pollMs = 200 } = {}) {
  const sessions = new Map(), directory = path.join(root, '.local', 'debugger', 'server-sessions');
  const snapshot = s => { const hold = s.hold?.snapshot();
    return { ok: true, sessionId: s.id, lane: s.lane, runtime: 'server', state: s.phase, revision: s.revision,
    createdAt: s.createdAt, scopeComplete: false, metadataEvidence: s.evidence, pauses: [...s.pauses.values()],
    ...(s.nativeId ? { nativeSessionId: s.nativeId } : {}), ...(s.error ? { error: s.error } : {}),
    ...(s.nativeGroup?{nativeGroup:s.nativeGroup.summary()}:{}),
    ...(s.nativeSessions.length ? { nativeSessions: s.nativeSessions } : {}), ...(s.held ? { held: s.held } : {}),
    pauseRequest: {requested:!!s.pauseRequested,scope:'native-debug-session-threads'},
    // Lane-derived only: a pause acknowledgement never changes a capability.
    capabilities: serverCapabilities(s.lane), inputCapabilities: inputCapabilities(s.lane, 'server'),
    ...(hold ? { requestHold: hold } : {}), ...(s.holdUnavailable ? { requestHoldUnavailable: s.holdUnavailable } : {}),
    ...(s.roleCycle ? { roleCycle: s.roleCycle } : {}), ...(s.startRefused ? { startRefused: s.startRefused } : {}),
    // Background values coverage stays separate from scheduling, ThreadEnd, new Timer rows and completion.
    ...(s.result ? { runResult: s.result, valuesComplete: s.result.background?.valuesComplete === true,
      valuesCoverage: s.result.results?.at(-1)?.valuesCoverage ?? null,
      // ODC Timer instance correlation (read-only Portal session) and producer/response parity counts, never values.
      ...(s.result.instanceCorrelation !== undefined ? { instanceCorrelation: s.result.instanceCorrelation,
        instanceCorrelationProved: s.result.instanceCorrelationProved === true, executionCompleted: s.result.executionCompleted === true,
        wakeOwnershipProved: s.result.wakeOwnershipProved === true } : {}),
      ...(s.result.results?.some(r => r?.producerOutputParity) ? { producerOutputParity: s.result.results.map(r => r?.producerOutputParity ?? null) } : {}) } : {}),
    receiptPath: s.file }; };
  function changed(s) {
    s.revision++; fs.writeFileSync(s.file + '.tmp', JSON.stringify(snapshot(s), null, 2)); fs.renameSync(s.file + '.tmp', s.file);
    for (const done of s.waiters.splice(0)) done();
  }
  function active(s) { if (s.cancelled) fail('cancelled'); }
  const consume = (s, id, pause) => { s.pauses.set(id, { ...pause, generation: pause.generation + 1 }); s.generationHigh = Math.max(s.generationHigh, pause.generation + 1); };
  const serial = (s, work) => { const task = s.commands.then(work); s.commands = task.catch(() => {}); return task; };
  function collect(s, status) {
    if (status.state !== 'connected') { const before = s.phase; s.phase = 'ending'; s.pauses.clear(); phaseEvent(s, before); changed(s); return; }
    const pauses = new Map();
    // A frameless BeforeSuspendEvent stop (manual pause) is recorded natively with reason 'suspend'.
    const reasons = new Map((status.events ?? []).filter(e => e?.kind === 'paused' && e.stop).map(e => [e.stop.threadId + ':' + e.stop.eventId, e.reason]));
    for (const pause of status.pauses ?? []) {
      const id = pause.threadId + ':' + pause.eventId;
      if (s.consumed.has(id)) continue;
      const reason = reasons.get(id) ?? s.pauses.get(id)?.reason;
      // A renewed native session starts above every generation of the previous one: its old tokens stay stale.
      pauses.set(id, { ...pause, ...(reason === 'suspend' ? { reason } : {}), generation: s.pauses.get(id)?.generation ?? s.generationBase + 1 });
      if (!s.seen.has(id)) {
        s.seen.add(id); const top = pause.stack?.at(-1);
        s.lines.push({ seq: s.lines.length + 1, threadId: pause.threadId, eventId: pause.eventId,
          module: top?.module, action: top?.action, functionKey: top?.functionKey, nodeKey: top?.nodeKey, stack: pause.stack,
          // Native provenance only; a fingerprint never binds the caller's submission (backgroundThreadOutcome).
          ...(/^[a-f0-9]{64}$/.test(pause.nativeRequestIdSha256 ?? '') ? { nativeRequestIdSha256: pause.nativeRequestIdSha256,
            nativeRequestIdProvenance: true, requestOwnershipProved: false } : {}) });
      }
    }
    for (const event of status.events ?? []) if (event.kind === 'thread-end') {
      const id = 'end:' + event.threadId + ':' + event.eventId;
      if (!s.seen.has(id)) { s.seen.add(id); s.lines.push(event); s.globals.threadEnded(event.threadId); }
    }
    const phase = s.cancelled ? 'ending' : pauses.size ? 'paused' : 'running';
    if(pauses.size)s.pauseRequested=false;
    if (phase !== s.phase || JSON.stringify([...pauses.values()]) !== JSON.stringify([...s.pauses.values()])) {
      for (const pause of pauses.values()) s.generationHigh = Math.max(s.generationHigh, pause.generation);
      if (phase !== s.phase) s.activeBinding?.paused(pauses.size > 0);
      const before = s.phase; s.pauses = pauses; s.phase = phase; phaseEvent(s, before); changed(s);
    }
  }
  // Pause/resume events for a worker whose request timer is pause-aware (O11 Traditional); never extends the native lease.
  function phaseEvent(s, before) {
    const kind = s.phase === 'paused' && before !== 'paused' ? 'paused' : before === 'paused' && s.phase !== 'paused' ? 'resumed' : null;
    if (kind) for (const listener of [...s.inspectionListeners]) { try { listener({ kind }); } catch { /* a listener never stops the pump */ } }
  }
  async function pump(s) {
    while (!s.endPump) {
      try { await serial(s, async () => { if (!s.endPump) collect(s, s.nativeGroup?await s.nativeGroup.status():await debug({ op: 'status', sessionId: s.nativeId })); }); }
      catch (error) { s.error = safe(error); changed(s); }
      if (!s.endPump) await new Promise(resolve => { s.wake = resolve; s.timer = setTimeout(resolve, pollMs); });
    }
  }
  async function stopPump(s) { s.endPump = true; clearTimeout(s.timer); s.wake?.(); await s.pump; }
  async function stopNative(s, context) {
    await stopPump(s);
    // Share the same attempt between public cancellation and runner finally.
    // An uncertain stop is not permission to send a second native stop.
    if (!s.stopAttempt) s.stopAttempt = serial(s, () => s.nativeGroup?s.nativeGroup.stop(context):debug({ op: 'stop', sessionId: s.nativeId }, context));
    return s.stopAttempt;
  }
  // Background values coverage evidence: scope variables and native reads per observed stop of the target function.
  function recordStop(s, input, result) {
    if (result?.ok !== true) return;
    const id = input.threadId + ':' + input.eventId;
    if (input.op === 'scope' && Array.isArray(result.variables) && result.context?.functionKey === s.model?.functionKey &&
        (s.stops.has(id) || s.stops.size < 200)) s.stops.set(id, { scopeVariables: result.variables, reads: s.stops.get(id)?.reads ?? [] });
    else if (['read', 'read-many', 'read-frame', 'refresh', 'expand'].includes(input.op) && s.stops.has(id)) s.stops.get(id).reads.push(result);
  }
  async function ensureScope(s, input, result) {
    const coverage = () => [...(s.model?.coverage ?? []), ...[...s.scopeCache.values()].flatMap(model => model.coverage ?? [])];
    // Categories per runtime: notApplicableToRuntime / emptyInModel (frame-bound count 0) / notEnumerated.
    if (result.ok !== true || result.metadataBound === true) return withScopeCategories(nativeBoundScopeCoverage(result, coverage()), s.lane, 'server');
    const context = result.context;
    if (!context || context.threadId !== input.threadId || context.eventId !== input.eventId ||
        !Number.isInteger(context.generation) || context.generation < 1 || !Number.isInteger(context.frame) ||
        !key.safeParse(context.functionKey).success || !key.safeParse(context.nodeKey).success)
      fail('native_scope_context_unavailable');
    // A foreign module requires its own published capture. Never reinterpret its
    // keys through the entry model, even if names or variable paths coincide.
    const owner = s.models.get(context.moduleKey);
    if (!owner) fail('producer_model_required');
    if (context.previousNodeKey != null && (!key.safeParse(context.previousNodeKey).success ||
        context.previousModuleKey !== context.moduleKey)) fail('native_previous_scope_context_unavailable');
    const cacheKey = context.moduleKey + ':' + context.functionKey + ':' + context.nodeKey + ':' + (context.previousNodeKey ?? '');
    let model = s.scopeCache.get(cacheKey);
    if (!model) {
      // The native frame type lets the reader refuse a screen Aggregate by name (not IBreakpointable natively).
      model = await readScopes({ lane: s.lane, moduleKey: context.moduleKey, source: owner.source,
        scopes: [{ functionKey: context.functionKey, nodeKeys: [context.nodeKey],
          ...(context.previousNodeKey ? { previousNodeKey: context.previousNodeKey } : {}),
          ...(context.functionType ? { functionType: context.functionType } : {}) }], runtime: 'server',
        directory: path.join(directory, s.id, 'lazy-' + s.scopeCache.size) });
      model.inspection = inspectionSchema.parse({ variables: model.variables });
      s.scopeCache.set(cacheKey, model); s.evidence.push(...model.evidence); changed(s);
    }
    active(s);
    const id = input.threadId + ':' + input.eventId, pause = s.pauses.get(id);
    if (!pause) fail('stale_stop');
    // Binding invalidates native references. Consume the public generation
    // before sending, including timeout; scope can reconcile a completed bind.
    consume(s, id, pause); changed(s);
    const bound = await (bindScope ?? (await import('./debug-runtime.mjs')).bindServerInspectionScope)({ sessionId: pause.nativeSessionId ?? s.nativeId,
      threadId: input.threadId, eventId: input.eventId, scopeUpdate: { moduleKey: context.moduleKey,
        functionKey: context.functionKey, nodeKey: context.nodeKey, sourceSha256: owner.source.sha256.toLowerCase(),
        previousNodeKey: context.previousNodeKey ?? null,
        generation: context.generation, frame: context.frame, variables: model.inspection.variables } });
    return withScopeCategories(nativeBoundScopeCoverage(bound, coverage()), s.lane, 'server');
  }
  async function execute(s, request) {
    try {
      const services = {
        ...(s.independentStaticRead ? { independentStaticRead: s.independentStaticRead } : {}),
        checkActive: () => active(s),
        prepareServerInspection: async binding => {
          active(s);
          const derived = Array.isArray(binding.derivedScopes) ? binding.derivedScopes : [];
          if (binding.lane !== s.lane || ![...s.scopes, ...derived].some(scope => scope.functionKey === binding.functionKey &&
              (scope.moduleKey ?? binding.moduleKey) === binding.moduleKey)) fail('target_scope_required');
          s.models = new Map();
          for (const owner of binding.models ?? [{ moduleKey: binding.moduleKey, source: binding.source }]) {
            const source = { ...owner.source, sha256: owner.source?.sha256?.toLowerCase() };
            if (!key.safeParse(owner.moduleKey).success || s.models.has(owner.moduleKey) ||
                !/^[a-f0-9]{64}$/.test(source.sha256 ?? '')) fail('model_source_invalid');
            // Extra frame owners are runner-selected published captures. Verify
            // their bytes before native start; initial owner is read below.
            if (owner.moduleKey !== binding.moduleKey && (!path.isAbsolute(source.path) ||
                createHash('sha256').update(fs.readFileSync(source.path)).digest('hex') !== source.sha256)) fail('model_source_changed');
            s.models.set(owner.moduleKey, {moduleKey:owner.moduleKey,source});
          }
          if (s.models.size > 20 || s.models.get(binding.moduleKey)?.source.sha256 !== binding.source.sha256.toLowerCase()) fail('model_source_invalid');
          if (s.lane === 'o11' && (derived.length || Array.isArray(binding.callbackKeys))) {
            // Runner-derived scopes only: callback flows reachable from the entry (a caller naming another
            // callback is refused) and the Traditional screen/block Preparation and screen-action scopes.
            s.scopes = admitO11CallbackScopes({ requested: s.scopes, derived: { moduleKey: binding.moduleKey, scopes: derived.filter(d => d.callback) },
              callbackKeys: binding.callbackKeys ?? [], modules: binding.modules ?? [...s.models.keys()], moduleKey: binding.moduleKey });
            for (const d of derived.filter(d => !d.callback)) {
              if (d.source !== 'runner-derived' || d.moduleKey !== binding.moduleKey || !functionKey.safeParse(d.functionKey).success ||
                  !Array.isArray(d.nodeKeys) || !d.nodeKeys.length || d.nodeKeys.some(node => !key.safeParse(node).success)) fail('derived_scope_invalid');
              if (!s.scopes.some(scope => (scope.moduleKey ?? binding.moduleKey) === d.moduleKey && scope.functionKey === d.functionKey))
                s.scopes.push({ moduleKey: d.moduleKey, functionKey: d.functionKey, nodeKeys: [...d.nodeKeys], role: d.role, source: 'runner-derived' });
            }
            const nodes = s.scopes.flatMap(scope => scope.nodeKeys);
            if (nodes.length > 20 || new Set(nodes).size !== nodes.length) fail('scope_limit');
          } else if (s.lane === 'odc' && (derived.length || Array.isArray(binding.callbackKeys)) &&
              derived.every(d => typeof d.callback === 'string' && d.source === 'runner-derived')) {
            // ODC REST callback flows derived by the endpoint runner (same module, Start node read); the key-only
            // admission is lane-independent, its refusal is renamed for ODC. Same-module scopes keep no explicit owner.
            try {
              s.scopes = admitO11CallbackScopes({ requested: s.scopes, derived: { moduleKey: binding.moduleKey, scopes: derived },
                callbackKeys: binding.callbackKeys ?? [], modules: binding.modules ?? [...s.models.keys()], moduleKey: binding.moduleKey })
                .map(({ moduleKey: owner, ...scope }) => owner && owner !== binding.moduleKey ? { moduleKey: owner, ...scope } : scope);
            } catch (error) { throw error?.message === 'debug_o11_native_callback_scope_not_derived' ? new Error('debug_odc_native_callback_scope_not_derived') : error; }
            const nodes = s.scopes.flatMap(scope => scope.nodeKeys);
            if (nodes.length > 20 || new Set(nodes).size !== nodes.length) fail('scope_limit');
          } else if (derived.length) fail('derived_scope_invalid');
          // ODC consumer-owned breakpoints exist only for the runner's library-reference pair: its owner map
          // (odcBreakpointOwners) must declare each node with that consumer, whose published model is pinned above.
          if (s.lane === 'odc') for (const scope of s.scopes.filter(sc => sc.moduleKey && sc.moduleKey !== binding.moduleKey))
            for (const node of scope.nodeKeys) if (binding.nodeModuleKeys?.[node] !== scope.moduleKey) fail('breakpoint_owner_unqualified');
          s.serviceCaller = binding.serviceCaller ?? null;
          const groups = new Map();
          for (const scope of s.scopes) {
            const ownerKey = scope.moduleKey ?? binding.moduleKey;
            if (!s.models.has(ownerKey)) fail('producer_model_required');
            if (!groups.has(ownerKey)) groups.set(ownerKey, []);
            groups.get(ownerKey).push({ functionKey: scope.functionKey, nodeKeys: scope.nodeKeys,
              ...(typeof scope.callback === 'string' && scope.kind ? { callback: { kind: scope.kind, name: scope.callback } } : {}) });
          }
          const callbackFlows = derived.filter(d => d.callback).map(d => ({ moduleKey: d.moduleKey, functionKey: d.functionKey, kind: d.kind, callback: d.callback }));
          const model = { variables: [], coverage: [], evidence: [] };
          let ownerIndex = 0;
          for (const [ownerKey, scopes] of groups) {
            active(s);
            const owner = s.models.get(ownerKey);
            const part = await readScopes({ ...binding, moduleKey: ownerKey, source: owner.source, scopes,
              runtime: 'server', directory: path.join(directory, s.id, ...(groups.size > 1 ? ['owner-' + ownerIndex++] : [])),
              ...(callbackFlows.length ? { callbackFlows } : {}) });
            model.variables.push(...part.variables); model.coverage.push(...(part.coverage ?? [])); model.evidence.push(...part.evidence);
          }
          active(s); const inspection = inspectionSchema.safeParse({ variables: model.variables,
            sources: [...s.models.values()].map(owner => ({ moduleKey: owner.moduleKey, sourceSha256: owner.source.sha256 })),
            scopes: s.scopes.flatMap(scope => scope.nodeKeys.map(nodeKey => ({ moduleKey: scope.moduleKey ?? binding.moduleKey,
              functionKey: scope.functionKey, nodeKey, sourceSha256: s.models.get(scope.moduleKey ?? binding.moduleKey).source.sha256 }))) });
          if (!inspection.success) fail('metadata_invalid');
          s.model = { ...binding, inspection: inspection.data, coverage: model.coverage }; s.evidence = model.evidence; changed(s);
        },
        // O11 request hold: the runner reports each scenario's submission and its fixed native lease end.
        beforeServerInvocation: async info => { active(s); if (!s.nativeId) fail('debugger_required');
          if (s.hold && typeof info?.requestId === 'string' && Number.isFinite(info.nativeDeadlineAt)) { s.hold.submitted({ requestId: info.requestId, nativeDeadlineAt: info.nativeDeadlineAt }); changed(s); } },
        afterServerInvocation: info => { if (s.hold?.snapshot()) { try { s.hold.closed(info?.requestId); } catch { /* another request is open */ } changed(s); } },
        // ODC hold between scenarios: the runner confirmed the native stop; resume or stop decides what follows.
        holdBetweenScenarios: async info => {
          active(s);
          try {
            await new Promise((resolve, reject) => {
              s.resumeHold = resolve; s.cancelHold = () => reject(new Error('debug_server_session_cancelled'));
              s.held = { scenario: info?.scenario ?? null, next: info?.next ?? null, notSent: info?.notSent ?? [], revision: s.revision + 1 };
              s.phase = 'held'; changed(s);
            });
          } finally { s.resumeHold = s.cancelHold = undefined; s.held = undefined; }
          active(s); s.phase = 'preparing'; changed(s);
        },
        nativeSessionRenewed: id => { if (id !== s.nativeId) fail('native_renewal_mismatch'); },
        activeBinding: value => { s.activeBinding = value; },
        traceRead: () => structuredClone(s.lines),
        // O11 Traditional worker: pause-aware request timer; the fixed native lease is never paused or extended.
        serverInspectionEvents: { get paused() { return s.phase === 'paused'; },
          subscribe(listener) { s.inspectionListeners.add(listener); return () => s.inspectionListeners.delete(listener); } },
        // Observed stops of the target function (native scope variables and reads), readable after the native stop.
        scopeEvidence: async () => [...s.stops.values()].map(stop => ({ scopeVariables: stop.scopeVariables, reads: [...stop.reads] })),
        serverScopes: s.scopes.map(({ moduleKey, functionKey }) => ({ moduleKey, functionKey })),
        // ODC explicit owners become the runner's traceTarget.consumerNodeKeys (library-reference pair only).
        ...(s.lane === 'odc' && s.scopes.some(scope => scope.moduleKey)
          ? { serverScopeOwners: s.scopes.filter(scope => scope.moduleKey).map(({ moduleKey, nodeKeys }) => ({ moduleKey, nodeKeys: [...nodeKeys] })) } : {}),
        // ODC app-user identity anchor and producer End/response parity (counts only); never in anonymous/background runs.
        ...(s.lane === 'odc' ? {
          registerAppUserAnchor: anchor => { active(s);
            if (['anonymous', 'native-background'].includes(request.contextMode)) fail('anchor_context_refused');
            s.anchors.register(anchor); },
          producerOutputParity: s.parity } : {}),
        prepareUser: async (...args) => {
          active(s); s.phase = 'sign-in'; changed(s);
          const result = await (prepareUser ?? (await import('./debug-app-user.mjs')).prepareDebugAppUser)(...args);
          // Return any descriptor to the runner, including after cancellation,
          // so its finally block retains ownership of credential release.
          if (!s.cancelled) { s.phase = 'preparing'; changed(s); } return result;
        },
        debug: async (input, context) => {
          if (input.op === 'start' || input.op === 'watch' &&
              (['o11', 'odc'].includes(s.lane) && context?.anonymousWatch === true && request.contextMode === 'anonymous' ||
                context?.backgroundWatch === true && request.contextMode === 'native-background' &&
                (s.lane === 'o11' || s.lane === 'odc' && !request.workflow &&
                  (request.launch?.contextMode === 'app-user' || request.trigger === PORTAL_WAKE_TRIGGER && !request.launch)))) {
            if (s.cancelled || !s.model || input.moduleKey !== s.model.moduleKey)
              return { ok: false, state: 'not-started', error: 'debug_server_session_binding_unavailable' };
            if (s.nativeId) {
              // Renewal after a hold: only once the previous native session's single stop is confirmed.
              const previous = await s.stopAttempt;
              if (s.lane !== 'odc' || s.nativeGroup || previous?.ok !== true || previous.state !== 'stopped') fail('native_renewal_unconfirmed_stop');
              s.nativeSessions.push({ nativeSessionId: s.nativeId, stopped: true, consumed: [...s.consumed] });
              s.generationBase = s.generationHigh; s.pauses.clear(); s.consumed.clear(); s.seen.clear();
              s.nativeId = undefined; s.stopAttempt = undefined; s.endPump = false;
            }
            const { trace, nodeModuleKeys: _runnerOwners, ...base } = input;
            // ODC per-node owners from the scopes (scope.moduleKey ?? the bound target module).
            const nodeModuleKeys = s.lane === 'odc' && s.scopes.some(scope => scope.moduleKey)
              ? Object.fromEntries(s.scopes.flatMap(scope => scope.nodeKeys.map(node => [node, scope.moduleKey ?? s.model.moduleKey]))) : undefined;
            const observerInspection = input.op === 'watch' ? { moduleKey: s.model.moduleKey,
              functionKey: s.model.functionKey,
              functionKeys: [...new Set([s.model.functionKey, ...s.scopes.map(scope => scope.functionKey)])],
              sourceSha256: s.model.source.sha256.toLowerCase() } : undefined;
            const nativeInput=debugSchema.parse({ ...base, op: 'start', autoContinue: false, seconds: Math.min(input.seconds, s.seconds),
              nodeKeys: s.scopes.flatMap(scope => scope.nodeKeys), ...(nodeModuleKeys ? { nodeModuleKeys } : {}), inspection: s.model.inspection });
            const nativeContext=observerInspection ? { ...context, [context.backgroundWatch ? 'backgroundInspection' : 'anonymousInspection']: observerInspection } : context;
            // One private-compare key per public session, shared by the native sessions of an O11 group.
            const internal = { privateCompare: s.privateCompare };
            // A Service hop (deriveServiceCaller) groups the consumer on its own runtime with the Service, never via o11Auth.entry.
            if(s.lane==='o11' && (input.o11Auth?.entry || s.serviceCaller) && s.scopes.some(scope=>scope.moduleKey && scope.moduleKey!==input.moduleKey))
              s.nativeGroup=createO11SessionGroup((value, context) => debug(value, context, value.op === 'start' ? internal : undefined),()=>active(s),
                s.serviceCaller ? { boundaryKind: 'service-action', serviceCaller: s.serviceCaller } : undefined);
            const started = await (s.nativeGroup?s.nativeGroup.start(nativeInput,nativeContext):debug(nativeInput,nativeContext,internal));
            // A failed read-only preflight before StartDebugSession: known not started, stopped locally, lock released.
            const knownNotStarted = started?.knownNotStarted === true && started.state === 'stopped';
            if (knownNotStarted) s.startRefused = { state: 'not-started', knownNotStarted: true, uncertain: false, lockRetained: false,
              ...(typeof started.startError === 'string' ? { startError: started.startError } : {}) };
            if (started?.sessionId && !knownNotStarted && !(started.ok === false && started.state === 'not-started' &&
                started.workerStarted === false && started.uncertain === false)) s.nativeId = started.sessionId;
            if (started?.ok && started.state === 'connected') { s.phase = 'running'; changed(s); s.pump = pump(s); }
            return started;
          }
          if (input.op === 'stop') return stopNative(s, context);
          return debug(input, context);
        },
      };
      if (s.lane === 'o11') services.runO11 = (o11Runner ?? (await import('./debug-o11-native-run.mjs')).createO11NativeRun)({ root, ...services });
      // roleCycle is coordinator-only: the runner request never carries it.
      const { roleCycle, ...runRequest } = request;
      if (roleCycle) {
        const { runWithRoleCycle, odcRoleCycleAccess, appUserKeyResolver } = await import('./debug-odc-role-cycle.mjs');
        const access = roleCycleAccess ? await roleCycleAccess(request.tenant) : odcRoleCycleAccess({ tenant: request.tenant,
          access: await (await import('./sc-portal-access.mjs')).createAccess(), resolveUserKey: appUserKeyResolver(prepareUser ? { prepareUser } : {}) });
        // The grant precedes the app-user sign-in (roles reach the token there); the revoke runs after the run.
        s.result = await runWithRoleCycle({ roleKey: roleCycle.roleKey, words: roleCycle.words, access, journalDir: path.join(directory, s.id, 'role-cycle') },
          ({ wrapPrepareUser }) => run(runRequest, { services: { ...services, prepareUser: wrapPrepareUser(services.prepareUser) } }));
      } else s.result = await run(runRequest, { services });
      s.outcome = s.result.uncertain ? 'uncertain' : s.result.ok ? 'completed' : 'failed'; s.phase = 'ending';
    } catch (error) { s.error = safe(error); if (error?.roleCycle) s.roleCycle = error.roleCycle;
      s.outcome = s.nativeId || error?.roleCycle?.uncertain ? 'uncertain' : 'failed'; s.phase = 'ending'; }
    finally {
      await stopPump(s);
      let outcome = s.outcome;
      if(s.nativeGroup?.summary().unresolvedStart)outcome='uncertain';
      if (s.nativeId) {
        try { const stopped = await stopNative(s); if (stopped?.state !== 'stopped' || stopped?.ok !== true) outcome = 'uncertain'; }
        catch (error) { outcome = 'uncertain'; s.error = safe(error); }
      }
      s.privateCompare.close(); // zeroes every fingerprint and the key
      s.anchors?.clear(); s.parity?.close();
      s.phase = outcome; s.pauses.clear(); changed(s);
    }
  }
  return async input => {
    if (input.op === 'start') {
      // Port D7: the default roleCycle access is sc-portal-access.mjs (SC/Portal). While it is pending, a roleCycle start
      // is refused typed here, before any session, sign-in or role write; an injected roleCycleAccess needs no file.
      const roleCycleRefusal = input.run?.roleCycle && !roleCycleAccess ? roleCyclePending() : null;
      if (roleCycleRefusal) throw new Error(roleCycleRefusal);
      if ([...sessions.values()].filter(s => !terminal(s.phase)).length >= 8) fail('capacity');
      const id = randomUUID(); fs.mkdirSync(directory, { recursive: true });
      const s = { id, file: path.join(directory, id + '.json'), lane: input.run.lane ?? 'odc', scopes: input.scopes,
        independentStaticRead: input.independentStaticRead,
        seconds: input.seconds ?? 300, phase: 'preparing', revision: 0, createdAt: new Date().toISOString(),
        pauses: new Map(), seen: new Set(), consumed: new Set(), scopeCache: new Map(), lines: [], waiters: [], commands: Promise.resolve(),
        nativeSessions: [], generationBase: 0, generationHigh: 1, globals: createServerGlobalHistory(),
        stops: new Map(), inspectionListeners: new Set() };
      // ODC: the app-user anchor (registered by the runner after the original login) feeds private-compare anchor 'app-user'.
      s.anchors = createAppUserAnchorRegistry();
      s.privateCompare = createPrivateCompareSession({ sessionId: id, lane: s.lane, runtime: 'server',
        ...(s.lane === 'odc' ? { anchorProvider: s.anchors.provider } : {}) });
      if (s.lane === 'odc') s.parity = createProducerOutputParity();
      if (s.lane === 'o11') {
        // The gateway budget is pinned to the item13 audit; without that evidence the hold is reported unavailable.
        try { verifyO11GatewayEvidence(root); s.hold = createO11RequestHold({ host: input.run.host }); }
        catch (error) { s.holdUnavailable = /^debug_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'debug_o11_request_hold_gateway_evidence_unavailable'; }
      }
      sessions.set(id, s); changed(s);
      s.task = execute(s, { ...input.run, lane: s.lane, execution: 'native-entry', trace: 'full' }); return snapshot(s);
    }
    const s = sessions.get(input.sessionId);
    if (input.op === 'reconcile') {
      const current = s ? snapshot(s) : JSON.parse(fs.readFileSync(path.join(directory, input.sessionId + '.json')));
      if (current.lane === 'o11') {
        // Dispatch by evidence class: answered (nativeSessionId), confirmed-not-started (prestart) or login-refusal.
        // verify:true only re-reads an existing prestart archive.
        const prestart = await import('./debug-o11-prestart-reconcile.mjs');
        return input.verify === true
          ? prestart.verifyO11PrestartArchive(root, { host: current.runResult?.target?.host, operationId: current.runResult?.operationId })
          : prestart.reconcileO11ServerByEvidence(root, current);
      }
      if (input.verify === true) fail('reconcile_verify_o11_only');
      return (await import('./debug-odc-native-preflight-reconcile.mjs')).reconcileOdcProducerPreflight(root, current);
    }
    if (!s) {
      if (input.op !== 'status') fail('owner_unavailable');
      const file = path.join(directory, input.sessionId + '.json'); if (!fs.existsSync(file)) fail('not_found');
      const stored = JSON.parse(fs.readFileSync(file));
      return { ...stored, ownerAvailable: false, ...(terminal(stored.state) ? {} : { state: 'owner-unavailable', executionOutcome: 'requires-reconciliation' }) };
    }
    if (input.op === 'status') {
      if (input.afterRevision === s.revision && input.waitMs) await new Promise(resolve => {
        const done = () => { clearTimeout(timer); s.waiters = s.waiters.filter(f => f !== done); resolve(); };
        const timer = setTimeout(done, input.waitMs); s.waiters.push(done);
      });
      return snapshot(s);
    }
    if (input.op === 'stop') {
      if (terminal(s.phase)) return snapshot(s);
      s.cancelled = true; s.phase = 'ending'; s.pauses.clear(); changed(s);
      s.cancelHold?.(); // a held run ends without another native start
      await stopPump(s);
      if (s.nativeId) await stopNative(s); // a hold's confirmed stop is reused, never resent
      s.privateCompare.close(); s.anchors?.clear(); s.parity?.close();
      return snapshot(s); // Only the runner can establish completion/cleanup.
    }
    return serial(s, async () => {
      if (input.op === 'resume') {
        if (s.cancelled || s.phase !== 'held' || input.afterRevision !== s.revision || !s.resumeHold) fail('resume_requires_current_held_revision');
        s.phase = 'resuming'; changed(s); s.resumeHold();
        return snapshot(s);
      }
      if (input.op === 'private-compare') {
        // Handles survive steps within the public session; stop and session end destroy them.
        if (s.cancelled || terminal(s.phase)) fail('stale_stop');
        return { ok: true, sessionId: s.id, ...privateCompareCommand(s.privateCompare, { op: input.op, handles: input.handles,
          ...(input.mode !== undefined ? { mode: input.mode } : {}), ...(input.anchor !== undefined ? { anchor: input.anchor } : {}) },
          'debug_server_session_private_compare_') };
      }
      if(input.op==='pause'){
        if(s.cancelled || s.phase!=='running' || !s.nativeId || s.pauseRequested || input.afterRevision!==s.revision)
          fail('pause_requires_current_running_revision');
        s.pauseRequested=true;changed(s);
        // No retry after timeout; leave the consumed revision and pending
        // request visible. A native stop event provides separate confirmation.
        const result=await debug(debugSchema.parse({op:'pause',sessionId:s.nativeId}));
        return {...result,sessionId:s.id,nativeSessionId:s.nativeId,revision:s.revision,pauseObserved:false};
      }
      const id = input.threadId + ':' + input.eventId, pause = s.pauses.get(id);
      if (s.cancelled || !pause || pause.generation !== input.generation || terminal(s.phase)) fail('stale_stop');
      // Near the O11 gateway cut only controls (step/continue/stop) are accepted; nothing is continued or resent here.
      const gate = s.hold?.classify(input.op);
      if (gate && !gate.allowed) fail('request_hold_budget_low');
      if (input.op === 'read-scope') {
        // One traversal of the whole frame (debug-read-scope.mjs) inside this queue entry: no step interleaves; every
        // native command passes the request-hold budget; ensureScope may consume the generation, so the current one is returned.
        const nativeSessionId = pause.nativeSessionId ?? s.nativeId;
        const call = command => debug(debugSchema.parse({ ...command, threadId: input.threadId, eventId: input.eventId, sessionId: nativeSessionId }));
        const observe = (op, result) => { const value = op === 'scope' ? result : s.globals.annotate(result); recordStop(s, { ...input, op }, value); return value; };
        const result = await readServerScope({
          current: () => !s.cancelled && !terminal(s.phase) && s.pauses.has(id),
          admit: op => !s.hold || s.hold.classify({ readFrame: 'read-frame', readMany: 'read-many' }[op] ?? 'read').allowed,
          scope: async () => observe('scope', s.globals.learnScope(await ensureScope(s, { ...input, op: 'scope' }, await call({ op: 'scope' })))),
          readFrame: async command => observe('read-frame', await call({ op: 'read-frame', ...command })),
          readMany: async command => observe('read-many', await call({ op: 'read-many', ...command })),
          read: async command => observe('read', await call({ op: 'read', ...command })),
        }, { lane: s.lane, threadId: input.threadId, eventId: input.eventId, generation: input.generation, depth: input.depth, maxNodes: input.maxNodes, textLimit: input.textLimit });
        return { ...result, sessionId: s.id, nativeSessionId, generation: s.pauses.get(id)?.generation ?? null };
      }
      const { generation, ...command } = input;
      if (input.op === 'frame') {
        // Consume the public generation before a potentially uncertain native
        // frame command. A timeout must not let an old command become valid.
        consume(s, id, pause); changed(s);
      }
      if (['step-into', 'step-over', 'step-out', 'continue'].includes(input.op)) {
        const before = s.phase; s.consumed.add(id); s.pauses.delete(id); s.phase = s.pauses.size ? 'paused' : 'running'; phaseEvent(s, before); changed(s);
      }
      const nativeSessionId=pause.nativeSessionId ?? s.nativeId;
      let result = await debug(debugSchema.parse({ ...command, sessionId: nativeSessionId }));
      if (['scope', 'frame'].includes(input.op)) result = s.globals.learnScope(await ensureScope(s, input, result));
      // Complete public session/site/setting values carry cross-stop change flags; locals never do.
      if (['read', 'read-many', 'read-frame', 'refresh', 'expand'].includes(input.op)) result = s.globals.annotate(result);
      recordStop(s, input, result);
      const context = result?.context, correlation = context?.correlation;
      if (result?.ok === true && context?.threadId === input.threadId && context?.eventId === input.eventId &&
          correlation?.nativeRequestIdProvenance === true && /^[a-f0-9]{64}$/.test(correlation.nativeRequestIdSha256 ?? '')) {
        const line = s.lines.find(row => row.threadId === input.threadId && row.eventId === input.eventId && row.kind !== 'thread-end');
        if (line) {
          if (line.nativeRequestIdSha256 && line.nativeRequestIdSha256 !== correlation.nativeRequestIdSha256)
            fail('native_request_identity_changed');
          // Preserve native provenance in the runner trace. A fingerprint alone
          // does not bind this observed request to the caller's HTTP submission.
          line.nativeRequestIdSha256 = correlation.nativeRequestIdSha256;
          line.nativeRequestIdProvenance = true;
          line.requestOwnershipProved = false;
        }
      }
      return { ...result, sessionId: s.id, nativeSessionId, generation: s.pauses.get(id)?.generation ?? null };
    });
  };
}
// Adapter qualification sentences are generated from the debug-adapter-registry rows and their pinned evidence;
// a capability without a live proof is described as implemented, live proof pending.
export function serverSessionDescription() {
  return 'Persistent MCP coordinator for original O11/ODC native-entry runs and installed server inspection. ' +
    'start takes run and scopes [{functionKey,nodeKeys,moduleKey?}] (20 initial nodes maximum). O11 may specify moduleKey for initial breakpoints in another runner-pinned published capture; metadata is read from that owner and native breakpoint IDs preserve it. Scopes spanning the selected O11 producer and its declared entry start a native session for each and route each shared pause to its top-frame owner; both borrow the original runner credential lease. For an O11 Service hop with consumer scopes and a pinned caller capture, the runner emits serviceCaller and the group (boundaryKind service-action) starts the consumer on its own runtime URL and published row, then the Service unchanged; threads are separate (requestOwnershipProved:false, crossThread:true, serviceHopStepInto:"not-automatic"); implemented, live proof pending. ODC explicit initial owners name only the consumer of the runner-bound library-reference pair on one runtimeUrl: one native session keyed to the library carries consumer- and library-owned breakpoints (native ExtendedBreakpointId); any other owner is refused before sign-in (debug_server_session_breakpoint_owner_unqualified); whether the ODC runtime stops at the consumer-owned breakpoint is not proved live. ' +
    'Derives scope addresses from the runner-selected published capture; caller cannot supply variable paths or evaluator code. scope/frame lazily enumerate unprepared nodes/actions from runner-pinned captures; a screen/block Aggregate frame (native functionType WebScreenDataSet, not breakpointable natively) is refused with debug_native_scope_aggregate_not_breakpointable. Native PreviousBreakpoint selects the installed previous-node watch visitor within the same parent; binding and cache include that observed identity. Previous-node server watches have live qualification in O11 SOAP; ODC same-module Server and REST caller watches passed live in the SOAP consumer; other server boundaries remain pending. O11 and ODC bind the runner-selected published consumer and producer captures, each with its own verified hash; frames from unbound modules are refused. O11 multi-model binding has local tests; live frame coverage is reported separately. ' +
    'Poll status, then use observed threadId/eventId/generation for scope, read/read-many/refresh/expand with text/list continuation, private-read for an opaque DPAPI reference to the unfiltered native evaluation (no plaintext in MCP), frame, step-into/over/out or continue. Use the returned generation after scope/frame, including a scope binding. ' +
    'read-frame {threadId,eventId,generation, maxNodes? (default 2000, cap 20000), offset? (root offset), depth?, textLimit?} reads every root of the frame in one native EvaluateMany and then the child pages level by level, with the same references, redaction, revisions and stale refusal as read; continuations nextOffset and pending; complete only when nothing remains; it does not consume the generation; implemented, live proof pending. ' +
    'scope results carry categories: notApplicableToRuntime with notApplicableReasons (server: client; ODC session with reason odc-model-refuses-session-variables), emptyInModel (frame-bound count 0) and notEnumerated; categoriesNotEnumerated lists only notEnumerated and the native return is reported in nativeReturnEnumerated. ' +
    'private-read also returns privateCompareHandle, an opaque in-memory handle to an HMAC-SHA256 fingerprint of the native value under a random per-public-session key. private-compare {handles:[2..8 handles] | handles plus anchor:"app-user", mode?:"equality"|"identity"} returns only {equal,bothNonEmpty,sameNativeType,valueType,count}: never a value, hash or key. Exact native typed equality; no coercion or evaluation; caller-supplied values are refused. Handles survive steps within the public session and are destroyed at stop. For an O11 native group, handles from different member sessions compare only when bound to the same native request fingerprint. identity mode admits only Identifier/LongInteger/Text typed values, so server Scalar renderings use equality mode; anchor app-user needs a coordinator anchor provider, otherwise debug_private_compare_anchor_unavailable: ODC sessions register one only after the runner proves the original app-user login (authenticated and identityMatches), never for anonymous or native-background runs; the GUID userKey stays in a closure and only its HMAC under the session key is compared (equality mode, GUID case and Text quoting canonicalized). private-compare is implemented, live proof pending. ' +
    'ODC producer parity: runResult.results[i].producerOutputParity and the snapshot list producerOutputParity carry only counts {compared,unequal,missing,extra,typeDifferences,complete,parityEqual}; the End-stop capture and the native response prints are not wired yet, so complete stays false (reason producer-end-not-captured); never values, paths or hashes; implemented, live proof pending. ' +
    readScopeDescription.server + ' ' +
    'Complete public session/site/setting read values carry previousStop and changedSincePreviousStop per thread and native request; locals and redacted values are never compared across stops. ' +
    'While running, pause requires afterRevision from the latest status and requests native SuspendAllThreads for this debug session. It is not request-specific isolation. Acknowledgment is not an observed stop; poll status for fresh stopped-thread tokens; a frameless suspension stop reports reason "suspend" and needs a step before scope reads. A pending or uncertain pause is never resent. status.capabilities advertises manualPause/steps/frames/crossModuleStepInto/serviceStepInto per lane: ODC server manual pause and cross-module step-into are pending live qualification; O11 service step-into is unsupported natively. status.inputCapabilities lists the SSAM-imposed input caps and refusal codes. ' +
    'O11 snapshots expose requestHold {elapsedMs,budgetMs,remainingMs,source}, measured from the scenario submission with budget = min(native deadline, the 50 s cloud gateway budget pinned to audited 504 evidence); below 8 s, inspection ops are refused with debug_server_session_request_hold_budget_low while step/continue/stop remain accepted; without the pinned evidence the snapshot reports requestHoldUnavailable. Implemented, live proof pending. ' +
    'ODC run.holdBetweenScenarios:true holds after each answered scenario with a confirmed native stop (state held); resume {afterRevision} continues only from the current held revision, after the runner re-verifies publication, runtime version and budget, with a fresh native session (nativeSessions lists the previous ones; their tokens are stale); stop during a hold ends without a native start; implemented, live proof pending. ' +
    (roleCyclePending() ? 'ODC run.roleCycle {roleKey,words} (one application role granted before the app-user sign-in and revoked after the run) ' + ROLE_CYCLE_UNAVAILABLE + '. '
      : 'ODC run.roleCycle {roleKey,words} grants one application role before the app-user sign-in and revokes it after the run, never resending an uncertain write (runResult.roleCycle); implemented, live proof pending. ') +
    'O11 run {trigger:"service-center-run-now", contextMode:"native-background", words} without launch, inputs, scenarios or context inspects a Timer that has no REST/SOAP caller: scope binding, a fixed native deadline (at most 600 s, autoContinue false), Service Center baseline, one Run Now, observation until ThreadEnd or the deadline, values coverage, debugger stop, then a read-only Service Center correlation; Run Now opens no request hold, is never resent, and an accepted-unverified or lost submission is uncertain with the runner lock retained; SSAMDebugBoundaryCore20261009 and SSAMDebuggerProbe are refused on any host; snapshots report valuesComplete and valuesCoverage separately from scheduling, ThreadEnd and completion; the Service Center instance observer is not wired in this coordinator, so instanceCorrelation reports unavailable; implemented, live proof pending. ' +
    'contextMode "endpoint-credential" (O11 and ODC original endpoint entries only; the runner refuses any other entry) opens the private Endpoint Credential dialog when the published capability requires it: header scheme for an O11 REST Custom OnAuthentication, an O11 SOAP WebServiceMethod literal request-header check or a REST Authentication=None OnRequest/method literal header guard; Basic scheme (Username plus one masked Password, RFC 7617) for qualified ODC Basic and O11 developer-logic Basic (O11 Basic validated by one platform User_Login stays app-user). The scheme comes from the capability, never from the request; the header is composed once, sent once and every form is redacted; WS-Security is refused; ODC Custom stays refused (no qualified request-header API inside ODC OnAuthentication); InternalAccess=Yes (debug_native_endpoint_internal_access_only, platformRestriction:true), client-certificate HttpSecurity and exposed OAuth2 are typed refusals before any dialog; implemented, live proof pending. ' +
    'ODC run {trigger:"portal-wake", contextMode:"native-background", words, trace:"full"} without launch, inputs, scenarios, context or workflow inspects a Timer woken by the original Portal action: the scope is bound before any Portal read, the debugger fixes an interactive deadline (autoContinue false, at most 600 s) before the single reserved POST, an uncertain POST keeps the locks and is never re-sent; ODC Timer runs require a request-bound ThreadEnd for ok and correlate the instance read-only in a separate Portal developer session after the debugger stop (instanceCorrelation, instanceCorrelationProved, executionCompleted, outcome, wakeOwnershipProved, portalCredentialsReleased; a Portal wake has no app trace link); implemented, live proof pending. ' +
    'ODC REST callbacks: runner-derived same-module stops in OnAuthentication (Basic/Custom only), OnRequest/OnResponse of the exposed service and OnBeforeRequest(/Advanced)/OnAfterResponse(/Advanced) of consumed RestActions in the entry closure join the scopes; consumed callbacks qualify only toward the app runtime origin with external-http acknowledged (debug_odc_native_consumed_callback_foreign_origin); a caller scope naming an underived callback is refused (debug_odc_native_callback_scope_not_derived); ODC Settings are reported in category setting; implemented, live proof pending. ' +
    'O11 Traditional entries (traditional-preparation and traditional-screen-action, app-user only) bind the screen Preparation, same-module block Preparations (nested included) and the screen action before the original GET and, for an action, one Submit or Ajax Submit postback; the request timer pauses while the session is paused and the native lease never does; owner state is refused; interactive Preparation scopes still need the installed scope reader to accept <key>.#Preparation; implemented, live proof pending. O11 REST/SOAP callback flows (OnAuthentication, OnRequest/OnResponse, OnBeforeRequest(/Advanced)/OnAfterResponse) reachable from the entry in the same module are added as runner-derived scopes; a caller scope naming another callback is refused with debug_o11_native_callback_scope_not_derived; implemented, live proof pending. ' +
    'An ODC start whose read-only worker preflight fails before StartDebugSession is known not started: startRefused {state:"not-started", uncertain:false, lockRetained:false}, no second stop. ' +
    'stop ends debugging; only runResult proves action response, credential release and cleanup. Fixed seconds (default 300, max 600), also bounded by app-user and native session expiry; steps never renew it. ' +
    describeQualification('o11', 'server') + ' ' + describeQualification('odc', 'server') + ' ' +
    'Anonymous inspection uses runner-bound published metadata, original developer SSO and a fixed native deadline without an app-user lease; it proves no app-user identity or roles. ODC anonymous REST through an external SOAP consumer does not qualify app identity, roles, arbitrary SOAP contracts or frames inside the external C# library. Background scheduling and observed function frames prove neither scheduler-instance ownership nor completion; the ODC Timer run requires native-background, launch with app-user and empty inputs, and authorization words. ' +
    'ODC independentStaticRead takes operationId/receiptSha256/debugReceiptSha256/manifestSha256 for preserved, expired historical evidence; only a different structurally qualified static-list or Integer scalar DataAction with one request is admitted. Scalar qualification checks a complete assignment-only graph, exact owner and published endpoint; calls, business writes and scenario overrides are refused. ' +
    'reconcile dispatches O11 by evidence class: answered (nativeSessionId), confirmed-not-started (debug_o11_native_server_trace_start_uncertain with no worker, login or post files, anonymous context, every native session of the binding in the run window not started, no token, process or lease; archived by rename to <op>/reconciled-prestart.lock with ssam-o11-prestart-reconciliation/1) or login-refusal; verify:true re-checks an existing prestart archive read-only and reports allCriteriaPassed separately from the archived claim; implemented, live proof pending. ' +
    'reconcile accepts the known ODC producer-preflight refusal or an O11 InvalidLoginException with one answered login, zero business submissions, no native debugger, a stopped owner and confirmed credential/context cleanup. For an O11 coordinator lost after invocation, reconcile also requires matching answered scenario receipts, accepted native envelopes, disposed context, a stopped native debugger and owner, and no files remaining in the private lease root (saved account subdirectories are preserved). It preserves original receipts and archives only the matching mutex; this proves response and cleanup, never complete trace or values. A lease or an unreadable store in any debugger state store (%USERPROFILE%\\.ssam-hybrid\\debugger and every legacy %LOCALAPPDATA%\\SSAM copy, MSIX package stores included) returns ok:false, credentialsReleased:false, mutexArchived:false with pending legacy-store markers, stateRoot and legacyInventory: the mutex is retained, never a success. Unanswered or uncertain requests remain refused. ' +
    'No publication, model editing, lock bypass or replay. User and role propagation remain separate evidence; scopeComplete is false. Owner loss refuses commands and preserves uncertainty.';
}
export function registerServerSessionTool(server, runSchema, wrap) {
  let manager; const schema = serverSessionSchema(runSchema);
  server.registerTool('ssam_debug_server', { title: 'Run and inspect the original server debugger',
    description: serverSessionDescription(),
    inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, wrap(async raw => {
    const input = schema.parse(raw);
    if (!manager) manager = createServerSessionManager({ run: (await import('./debug-run.mjs')).debugRun,
      debug: (await import('./debug-runtime.mjs')).headlessDebug });
    return manager(input);
  }));
}

