// CX15 (ODC, items 9-14 of the inventory): every destructive ODC tool takes two calls, guarded at the ENTRY of the tools
// (MCP and the .\odc CLI), never inside OdcAccess.write/portalWrite: the internal flows that delete SSAM's own fixtures by
// their origin receipt keep calling the unguarded access.
//   guardedAccess(access, deps) wraps an OdcAccess (or a fake with the same public methods) for registerAccessTools,
//   registerExternalLibrary and the CLI. Reads and non-destructive writes pass through unchanged. A destructive call
//   WITHOUT confirmationToken is a PREVIEW: the identity read now (asset, consumers, target name, detail), the backup plan,
//   a token bound to that list, tool, host and operation, and the operationId the execution will use as operationUuid.
//   Nothing is reserved or sent. WITH the token it is the EXECUTION: checkExecute (destructive-operations.mjs) with the
//   list read again, the tool's own name rules and the tenant guard, every problem in one refusal; then the record of the
//   operation, the backup of the item and the unchanged call of the unguarded access, whose approvals (own fixtures,
//   corporate tenants, consumers) still decide as before.
//   CX15 r2 (D, E): a generic route whose effect has a dedicated tool is refused at the entry, in one answer with every
//   problem and the exact call of that tool as its continuation (dedicatedRoute below): odc_write DELETE /assets/{assetKey}
//   -> odc_asset_delete; odc_portal_write connections.importEntities/importActions that can unselect anything ->
//   odc_external_db_connection. Nothing is read for the asset; the connection's current selection is read (read only).
// Uses only public methods of OdcAccess: pickTenant, tenantInfo, resolvePublic, apiClientAvailable, read, portalRead,
// targetNames, dependentsOf, assetSource, catalog, receipts.lookup and the destructive methods themselves.
import fs from 'node:fs';
import {
  OWNER_REPLY, checkExecute, createPreview, currentSignal, noteWords, beginOperation, markItem, endOperation, summarizeOperation, storeBackup, withSignal, previewFile,
} from '../../facade/destructive-operations.mjs';
import * as destructiveOperations from '../../facade/destructive-operations.mjs';
// CX15 r3 (CT-7, the family): the error of CONFIRMATION_REQUIRED ends with what goes WITHOUT a backup (withPreviewNote of
// the common module; read through the namespace so this file loads with a module that does not have it yet).
const previewError = (error, items) => (typeof destructiveOperations.withPreviewNote === 'function' ? destructiveOperations.withPreviewNote(error, items) : error);
import { withValidatedReply } from './owned-cleanup-approval.mjs';
import crypto from 'node:crypto';
import { DEPLOY, REMOVAL_NAMES, TARGET_NAMES, effectOf, removalsOf } from './effects.mjs';
import { PORTAL_WRITES } from './portal-routes.mjs';
import { elementVariables, guardTenant, namesWhole } from './access.mjs';
import { OdcError, publicError } from './errors.mjs';

export const DESTRUCTIVE_GUARD = Symbol.for('ssam.destructive.guard');
export const UNGUARDED = Symbol.for('ssam.destructive.unguarded');
// The neutral marker of the owner's words (CX15 r2: one for every destructive tool, in the common module).
export { OWNER_REPLY };
export const TWO_CALLS = 'deletes take two calls now: show the list, then call again with confirmationToken and the owner\'s reply';
const ASSET_DELETE = 'asset-repository-api-v1:delete:/assets/{assetKey}';
const ASSET_GET = 'asset-repository-api-v1:get:/assets/{assetKey}';
const ENVIRONMENTS = 'portfolio-api-v2:get:/environments';
const JOBS = 'external-library-generation-api-v1:get:/generation-operations';
const JOB_GET = 'external-library-generation-api-v1:get:/generation-operations/{operationKey}';
const PENDING_JOBS = new Set(['Pending', 'Uploaded', 'Generating', 'ReadyForReview', 'Validating']);
const DB_ACTIONS = new Set(['delete', 'remove-entities']);
// CX15 r2 (D): the two internal routes of the same native save (ActionConnectionDBObjects_Save_V1_1_Wrapper): its body
// selects and unselects the entities and the actions of a connection.
export const DB_OBJECT_SAVES = Object.freeze(new Set(['connections.importEntities', 'connections.importActions']));
export const NEEDS_DEDICATED_TOOL = 'DESTRUCTIVE_NEEDS_DEDICATED_TOOL';

// The internal Portal routes with effect 'destructive' (portal-routes.mjs): the inputParameters that name the target and
// the detail read that needs only that key (the others need the portfolio of their approval: identity by key only).
const PORTAL_TARGETS = Object.freeze({
  'apiClients.delete': { kind: 'api-client', keys: ['Key'], detail: p => ({ operationId: 'apiClients.detail', input: { screenVariables: { id: p.Key, _idInDataFetchStatus: 1 } } }) },
  'aiModels.trialDelete': { kind: 'ai-model-trial', keys: ['AIModelId'], why: 'its detail read needs the portfolio of the approval' },
  'knowledgeBases.delete': { kind: 'knowledge-base', keys: ['KnowledgeBaseId'], list: () => ({ operationId: 'knowledgeBases.list', input: { screenVariables: {} } }) },
  'connections.delete': { kind: 'connection', keys: ['ConnectionId', 'ProviderId'], detail: p => ({ operationId: 'connections.detail', input: { connectionId: p.ConnectionId, providerId: p.ProviderId } }) },
  'agents.datasetDelete': { kind: 'dataset', keys: ['DatasetId'], detail: p => ({ operationId: 'agents.dataset', input: { screenVariables: { id: p.DatasetId, _idInDataFetchStatus: 1 } } }) },
  'agents.evaluationDelete': { kind: 'evaluation', keys: ['EvaluationId'], why: 'its detail read needs the portfolio of the approval' },
});

const text = value => (value === null || value === undefined ? '' : String(value));
const trimmed = value => text(value).trim();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const problem = (code, message, fix, extra = {}) => ({ code, ...extra, message, fix });
const defined = object => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));
const without = (object, keys) => Object.fromEntries(Object.entries(object ?? {}).filter(([k]) => !keys.includes(k)));
const strip = input => without(input, ['confirmationToken', 'ownerRequest']);
const CALL_ONLY = ['confirmationToken', 'ownerRequest', 'authorize', 'operationUuid'];
const errorOf = error => publicError(error);
const refusalOf = (code, message, extra = {}) => ({ ok: false, code, error: { code, message }, sent: false, ...extra });
const listOf = value => (Array.isArray(value) ? value : Array.isArray(value?.List) ? value.List : []);
const rowName = row => trimmed(row?.OriginalName) || trimmed(row?.Name);

// A name of a record in a Portal answer: the object that carries the key (a list), else the first Name of a detail.
function recordIn(data, key, { list = false } = {}) {
  const queue = [[data, 0]]; let first = null;
  while (queue.length) {
    const [value, depth] = queue.shift();
    if (!value || typeof value !== 'object' || depth > 5) continue;
    if (!Array.isArray(value)) {
      const name = ['Name', 'name'].map(k => value[k]).find(v => typeof v === 'string' && v.trim());
      if (name && key && Object.values(value).some(v => typeof v === 'string' && v.toLowerCase() === text(key).toLowerCase())) return { record: value, name };
      if (name && first === null) first = { record: value, name };
    }
    for (const v of Object.values(value)) if (v && typeof v === 'object') queue.push([v, depth + 1]);
  }
  return list ? null : first;
}
// The key of a public request: the path values (in order), the asset and stage of a deployment.
function requestKey(operationId, { path, body } = {}) {
  if (operationId === DEPLOY) return [body?.assetKey, body?.environmentKey].every(Boolean) ? `${body.assetKey}@${body.environmentKey}` : null;
  const values = Object.values(path ?? {}).filter(v => v !== undefined && v !== null).map(String);
  return values.length ? values.join('/') : null;
}
const kindOfOperation = operationId => (operationId === DEPLOY ? 'deployment' : /\/([A-Za-z-]+)\/\{[^}]+\}$/.exec(operationId)?.[1] ?? 'public-api');
// The approval files the odc_write handler moved into options (odc-access.mjs): back into the call that repeats it.
function writeContext(options = {}) {
  const context = Object.entries(options).find(([k, v]) => /Context$/.test(k) && typeof v === 'string' && v)?.[1];
  return defined({ authorizationContext: context, originOperationUuid: options.originOperationUuid, groupOriginOperationUuid: options.groupOriginOperationUuid,
    userOriginOperationUuid: options.userOriginOperationUuid, revisionPrecondition: options.revisionPrecondition });
}
// 'deleted' when the tool confirmed it (read-back or receipt), 'uncertain' when it may have applied, 'absent' when the
// server answered 404, 'refused' when nothing was applied.
function itemState(result) {
  const state = result?.receipt?.state;
  if (result?.readBack?.gone === true || result?.readBack?.absent === true || state === 'confirmed') return 'deleted';
  if (result?.code === 'DEPLOYMENT_FAILED') return 'refused';
  if (state === 'accepted') return result?.ok === false ? 'uncertain' : 'deleted';
  if (state === 'uncertain' || result?.thrown === true || result?.error?.code === 'UNCERTAIN' || result?.state === 'uncertain') return 'uncertain';
  if (result?.status === 404) return 'absent';
  return 'refused';
}
const operationState = states => (states.every(s => s === 'deleted' || s === 'absent') ? 'completed'
  : states.some(s => s === 'uncertain') ? 'uncertain' : states.every(s => s === 'refused') ? 'refused' : 'partial');
function tenantProblems(info, words, confirmTenant, { context = false } = {}) {
  try {
    if (context) { if (info.readOnly) guardTenant(info, words || '-', confirmTenant); }
    else if (words) guardTenant(info, words, confirmTenant);
    return [];
  } catch (error) {
    const e = errorOf(error);
    return [problem(e.code, e.message, e.code === 'CORPORATE_TENANT_GUARD' ? 'the owner\'s reply that also names the tenant, and confirmTenant with its host' : 'a tenant the owner may change')];
  }
}
// The words name the target (the name or the key) as a WHOLE word, case- and accent-insensitive, as the O11 lane does (CX15
// r2, M: before, a substring, so "OtherLib" named the asset Lib).
function targetNamed(words, names) {
  const candidates = names.filter(n => typeof n === 'string' && n.trim());
  if (!candidates.length || candidates.some(n => namesWhole(text(words), n))) return [];
  return [problem('DESTRUCTIVE_TARGET_NOT_NAMED', 'A destructive write needs the owner\'s words to name its target: ' + candidates.join(' | '),
    'the owner\'s reply naming ' + candidates[0], { candidates })];
}

export const unguarded = access => access?.[UNGUARDED] ?? access;
// CX15 r3 (CT-4): the ends of records this process could not write, by operationId (written at the next call of the token).
const pendingEnds = new Map();

// The guarded view of an access: the six destructive methods two-step, everything else is the access itself.
export function guardedAccess(access, deps = {}) {
  if (!access || access[UNGUARDED]) return access;
  const guard = destructiveGuard(access, deps);
  const methods = { write: guard.write, deploy: guard.deploy, portalWrite: guard.portalWrite, assetDelete: guard.assetDelete,
    a2aConnectionDelete: guard.a2aConnectionDelete, externalDbConnection: guard.externalDbConnection };
  return new Proxy(access, {
    get(target, prop) {
      if (prop === UNGUARDED) return target;
      if (prop === DESTRUCTIVE_GUARD) return guard;
      if (Object.hasOwn(methods, prop) && typeof target[prop] === 'function') return methods[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// deps: now (ms, Date or a function), root (the destructive root, default destructiveRoot()), uuid (preview ids).
export function destructiveGuard(access, deps = {}) {
  const raw = unguarded(access);
  const root = deps.root;
  const ids = deps.uuid ? { uuid: deps.uuid } : {};
  const now = () => { const v = typeof deps.now === 'function' ? deps.now() : deps.now; return v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.now(); };
  const receiptOf = uuid => { try { return uuid ? raw.receipts?.lookup?.(text(uuid)) ?? null : null; } catch { return null; } };
  // An approval of an own fixture: authorizationContext plus every origin it names (the call's originOperationUuid, the
  // approval's constraints.originOperationUuid and ownedAssetOrigins) being a receipt of SSAM's own journal.
  const ownFixture = context => {
    if (!trimmed(context?.authorizationContext)) return false;
    const origins = [context.originOperationUuid];
    try {
      const file = context.authorizationContext;
      if (fs.statSync(file).size <= 32768) {
        const c = JSON.parse(fs.readFileSync(file, 'utf8'))?.constraints ?? {};
        origins.push(c.originOperationUuid, ...(isObject(c.ownedAssetOrigins) ? Object.values(c.ownedAssetOrigins) : []));
      }
    } catch { /* an unreadable approval names no origin here; the unguarded tool refuses it */ }
    const named = origins.filter(o => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(o)));
    return named.length > 0 && named.every(o => receiptOf(o) !== null);
  };

  // spec: {tool, input, operation, selection?, executionSelection?, target?, request, base, read(host, preview?) ->
  // {ok, items, mustName?, extra?} | refusal, nameRule?(preview, words), tenantRule?(host, words), backup?(item, ctx),
  // send(preview, operationUuid, words), reconcile()}
  async function run(spec) {
    const input = spec.input ?? {};
    const words = trimmed(input.authorize), ownerRequest = trimmed(input.ownerRequest), token = trimmed(input.confirmationToken);
    let host;
    try { host = await raw.pickTenant(input.tenant); } catch (error) { return { ok: false, sent: false, error: errorOf(error) }; }
    const at = now();
    for (const value of [words, ownerRequest]) if (value) noteWords({ host, tool: spec.tool, words: value, now: at, root });
    if (!token) {
      // The same operationUuid of a write that already has a receipt: the unguarded tool only reads and reconciles it.
      if (receiptOf(input.operationUuid)) return spec.reconcile();
      return preview(spec, host, at, words, ownerRequest);
    }
    return execute(spec, host, at, words, token);
  }

  const confirmStep = (spec, block, host, why) => ({ tool: spec.tool, arguments: { ...spec.base, tenant: host, confirmationToken: block.confirmationToken,
    operationUuid: block.operationId, authorize: OWNER_REPLY }, why: why ?? 'After the owner sees this exact list and replies (the next message states the number of items and names the target): the same call with this confirmationToken, operationUuid and that message, verbatim; never write the words yourself.' });
  const previewStep = (spec, host, why, preview = null, auth = null) => ({ tool: spec.tool, arguments: { ...spec.base, ...(preview?.selection ?? spec.selection ?? {}), tenant: host, ...(auth ? { auth } : {}) }, why });
  // A retry sentence of the access layer ('Repeat with auth:"api-client" ...') becomes a call step here, built from the
  // call without the owner's words (withContinuation would rebuild it from the raw input, ownerRequest included).
  const retryOf = (spec, host, value, preview = null) => {
    const sentence = typeof value?.continuation === 'string' ? value.continuation : null;
    const auth = sentence ? /auth:"([a-z-]+)"/.exec(sentence)?.[1] ?? null : null;
    return auth ? previewStep(spec, host, sentence + ' A new preview, then the owner\'s confirmation.', preview, auth) : null;
  };

  async function preview(spec, host, at, words, ownerRequest) {
    let seen;
    try { seen = await spec.read(host, null); } catch (error) { seen = { ok: false, error: errorOf(error) }; }
    if (!seen || seen.ok === false) {
      const retry = retryOf(spec, host, seen);
      return { ...seen, ...(seen?.code || !seen?.error?.code ? {} : { code: seen.error.code }), tenant: host, sent: false, ...(retry ? { continuation: retry } : {}) };
    }
    const block = createPreview({ tool: spec.tool, lane: 'odc', host, operation: spec.operation, selection: spec.selection ?? {}, items: seen.items, ownerRequest, words,
      mustName: seen.mustName ?? [], now: at, root, ...ids, extra: { request: spec.request } });
    return { ...(words ? { ok: false, code: 'CONFIRMATION_REQUIRED', error: previewError(TWO_CALLS, seen.items) } : { ok: true }), ...block, tenant: host, sent: false,
      ...(seen.extra ?? {}), continuation: confirmStep(spec, block, host) };
  }

  async function execute(spec, host, at, words, token) {
    // CX15 r2 (F, M4; provisional decision "strict" until the owner decides): an approval of an own fixture no longer
    // relaxes anything here. The count and the words-before-preview rule bind every execution, as in the O11 lane; the
    // approval is still required by the unguarded tool, with its own proposal. own only marks the answer (ownFixture).
    const own = ownFixture(spec.context?.() ?? spec.input);
    const common = { token, tool: spec.tool, host, operation: spec.operation, words, selection: spec.executionSelection ?? {}, target: spec.target ?? null, now: at, root, ...ids };
    let check = checkExecute(common);
    // CX15 r3 (CT-4): the end of an earlier execution of this token that this process could not write (a local failure
    // after its lease was released) is written now, before anything reads the record.
    if (check.preview && flushPending(check.preview.operationId)) check = checkExecute(common);
    if (check.used) return byState(spec, host, check, words);
    const blocking = check.problems.some(p => ['PREVIEW_UNKNOWN', 'OPERATION_CANCELLED', 'OPERATION_RUNNING', 'OPERATION_INTERRUPTED'].includes(p.code) || (p.code === 'PREVIEW_OTHER_TARGET' && p.previewOf));
    const extra = [];
    // CX15 r2 (C2/T5): the client's cancellation, read before the record, after each backup and before the send; the record
    // opens at the start of the execution (ssam_task finds it during the read again). A refusal before any send closes it as
    // refused with notSent, which leaves the token usable for the owner's corrected reply.
    const signal = deps.signal ?? currentSignal();
    let record = null;
    // CX15 r3 (CT-4, F3): from the lease on, ONE try: any exception before 'sending' closes the record refused with notSent
    // (the token stays usable) and releases the lease; after 'sending' the record closes uncertain. The answer names the
    // operation, the items by state and ssam_task (localFailure). phase.sent turns true right before the access is called.
    const phase = { sent: false };
    const begunPreview = check.preview;
    if (!blocking) {
      if (signal?.aborted) return cancelledBefore(spec, host, check.preview, null, 'before the execution started');
      // The lease of the operation (CX15 r2, I): another execution of this token running now sends nothing.
      try { record = beginOperation({ preview: check.preview, now: now(), root, words }); }
      catch (error) { if (error?.code !== 'OPERATION_RUNNING') throw error; return runningElsewhere(host, check.preview, error); }
    }
    try {
      if (!blocking || check.interrupted) {
        // CX15 r3 (CT-5): an interrupted operation (its process is gone) reads the list again too, without a lease, so the
        // refusal carries the new preview of what is left (checkExecute builds it from current); never its own token again.
        let seen;
        try { seen = await spec.read(host, check.preview); } catch (error) { seen = { ok: false, error: errorOf(error) }; }
        const current = seen && seen.ok !== false ? seen.items : null;
        if (!current && !blocking) {
          const e = seen?.error && typeof seen.error === 'object' ? seen.error : { code: seen?.code, message: text(seen?.error) };
          extra.push(problem(seen?.code ?? e.code ?? 'TARGET_UNREADABLE', (e.message || 'The target could not be read again') + ' Nothing was sent.', 'read the target again; a new preview when it changed'));
        }
        check = checkExecute({ ...common, current, nameRule: spec.nameRule ?? null, ...(record ? { begun: record } : {}) });
      }
      const problems = [...check.problems, ...extra];
      const known = check.preview;
      if (known && !check.problems.some(p => ['OPERATION_CANCELLED', 'OPERATION_RUNNING', 'OPERATION_INTERRUPTED'].includes(p.code))) {
        if (!words) problems.push(problem('AUTHORIZATION_REQUIRED', 'The execution needs the owner\'s reply in authorize, quoted verbatim; only its sha256 is kept.', 'the owner\'s reply after the preview'));
        const uuid = trimmed(spec.input.operationUuid).toLowerCase();
        if (!uuid) problems.push(problem('INPUT_INVALID', 'operationUuid must be the operationId of the preview: ' + known.operationId, 'operationUuid: "' + known.operationId + '"', { path: '/operationUuid' }));
        else if (uuid !== known.operationId) problems.push(problem('PREVIEW_OTHER_TARGET', 'operationUuid ' + uuid + ' is not the operationId of this preview (' + known.operationId + ')', 'operationUuid: "' + known.operationId + '"', { path: '/operationUuid' }));
        problems.push(...(spec.tenantRule?.(host, words) ?? []), ...(spec.targetRule?.(known) ?? []));
      }
      if (problems.length) {
        const unwritten = record ? closeRecord(record, 'refused', { notSent: true }) : null;
        const fresh = check.fresh ?? null;
        const restart = problems.some(p => ['PREVIEW_UNKNOWN', 'PREVIEW_EXPIRED', 'OPERATION_CANCELLED'].includes(p.code) || (p.code === 'PREVIEW_OTHER_TARGET' && !p.path));
        const running = problems.some(p => p.code === 'OPERATION_RUNNING'), interrupted = problems.some(p => p.code === 'OPERATION_INTERRUPTED');
        const other = check.operation && (running || interrupted) ? check.operation : null;
        const nextPreview = fresh ? confirmStep(spec, fresh, host, 'The new preview of what is left (preview): show it to the owner and confirm it with ITS token and the owner\'s new reply.')
          : previewStep(spec, host, 'A new preview of what is left (no token), shown to the owner, then the confirmation with its own token.', known?.tool === spec.tool ? known : null);
        return { ok: false, code: problems[0].code, error: `${problems.length} problem(s); nothing was sent`, problems, tenant: host, sent: false,
          ...(fresh ? { preview: fresh } : {}),
          ...(other ? { operation: summarizeOperation(other, { root }) } : {}),
          ...(unwritten ? { recordNotWritten: text(unwritten.code) || 'error' } : {}),
          ...(interrupted ? { nextPreview } : {}),
          continuation: running ? taskStep(known, 'read the record of the execution that is running before telling the owner anything; never repeat this call')
            : interrupted ? taskStep(known, 'this call sent nothing: read what the interrupted operation did, item by item, and tell the owner; then show the owner the new preview (nextPreview) and confirm it with its own token and the owner\'s new reply; never this token again')
              : fresh ? confirmStep(spec, fresh, host, 'The list changed: show the owner this new list (preview) and confirm it with its own token and the owner\'s new reply.')
                : restart || !known ? previewStep(spec, host, 'A new preview of the exact list (no token), shown to the owner, then the confirmation.', known?.tool === spec.tool ? known : null)
                  : confirmStep(spec, { confirmationToken: token, operationId: known.operationId, count: known.items.length }, host, 'The same call with this token once the problems are solved and the owner replied again (the next message states the number of items and names the target); never write the words yourself.') };
      }
      if (signal?.aborted) return cancelledBefore(spec, host, check.preview, record, 'after the read again');
      return await send(spec, host, check.preview, words, own, record, signal, phase);
    } catch (error) {
      if (!record) throw error;
      return localFailure(host, begunPreview, record, phase.sent, error);
    }
  }

  const taskStep = (preview, why) => ({ tool: 'ssam_task', arguments: { id: preview.operationId }, why });
  // CX15 r3 (CT-4): the end of a record that could not be written (EPERM, a full disk): the lease is released all the same
  // (endOperation), the end is kept here and written at the next call of the same token (flushPending).
  function closeRecord(record, state, extra = {}) {
    const id = text(record.operationId).toLowerCase();
    try { endOperation(record, state, { now: now(), root, ...extra }); pendingEnds.delete(id); return null; }
    catch (error) { pendingEnds.set(id, { record, state, extra, root }); return error ?? new Error('record not written'); }
  }
  function flushPending(operationId) {
    const id = text(operationId).toLowerCase(), pending = pendingEnds.get(id);
    if (!pending || pending.root !== root) return false;
    try { endOperation(pending.record, pending.state, { now: now(), root, ...pending.extra }); pendingEnds.delete(id); return true; } catch { return false; }
  }
  // A local failure after the lease (CX15 r3, CT-4): before 'sending' nothing was sent (refused, notSent: the token stays
  // usable); after it the write may have been applied (uncertain). Never an answer without the operation.
  function localFailure(host, preview, record, sent, error) {
    const cause = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(error.code) ? error.code : errorOf(error).code;
    for (const item of record.items) {
      if (item.state === 'sending') item.state = sent ? 'uncertain' : 'not-started';
      else if (item.state === 'backing-up') item.state = 'not-started';
    }
    const unwritten = closeRecord(record, sent ? 'uncertain' : 'refused', { localFailure: cause, ...(sent ? {} : { notSent: true }) });
    const names = state => record.items.filter(i => i.state === state).map(i => i.name);
    const byName = Object.fromEntries([['deleted', names('deleted')], ['absent', names('absent')], ['uncertain', names('uncertain')], ['notStarted', names('not-started')], ['refused', names('refused')]]
      .filter(([, list]) => list.length));
    return { ok: false, code: 'ODC_LOCAL_FAILURE', cause, outcome: sent ? 'uncertain' : 'not-sent', sent, tenant: host, operationId: preview.operationId,
      error: sent ? `A local failure (${cause}) stopped the execution after the write was handed to the access: it may have been applied. Read ssam_task {id:"${preview.operationId}"} and tell the owner item by item; never repeat this call by yourself.`
        : `A local failure (${cause}) stopped the execution before the write was sent: nothing was sent. Once the cause is solved, the owner's new reply with this token runs every rule again.`,
      ...byName, operation: summarizeOperation(record, { root }), ...(unwritten ? { recordNotWritten: text(unwritten.code) || 'error' } : {}),
      continuation: taskStep(preview, sent ? 'read the record of this operation (item by item) before telling the owner anything; a new send needs the owner\'s new reply'
        : 'read the record of this operation (nothing was sent) before telling the owner anything') };
  }

  // Another execution of the same token holds the lease of its operation: nothing read again, reserved or sent.
  function runningElsewhere(host, preview, error) {
    return { ok: false, code: 'OPERATION_RUNNING', outcome: 'not-sent', sent: false, tenant: host, error: error.message, problems: [error.problem],
      continuation: { tool: 'ssam_task', arguments: { id: preview.operationId }, why: 'read the record of the execution that is running before telling the owner anything; never repeat this call' } };
  }

  // A cancellation that came before the send: nothing was sent, every item not-started, the record cancelled.
  function cancelledBefore(spec, host, preview, record, when) {
    const at = new Date(now()).toISOString();
    if (record) { for (const item of record.items) item.state = 'not-started'; endOperation(record, 'cancelled', { now: now(), root, cancelledAt: at }); }
    return { ok: false, code: 'CANCELLED', outcome: 'not-sent', sent: false, tenant: host, cancelledAt: at, error: 'Cancelled by the client ' + when + '; nothing was sent.',
      ...(record ? { operation: summarizeOperation(record, { root }) } : {}),
      continuation: { tool: 'ssam_task', arguments: { id: preview.operationId }, why: 'read the record of this operation before telling the owner anything; a new delete is a new preview and a new confirmation' } };
  }

  async function send(spec, host, preview, words, own = false, begun = null, signal = null, phase = { sent: false }) {
    const at = () => ({ now: now(), root });
    const record = begun ?? beginOperation({ preview, now: now(), root, words });
    const backups = [];
    for (const item of preview.items) {
      if (!item.backup?.possible || !spec.backup) continue;
      markItem(record, item, { state: 'backing-up' }, at());
      let files;
      try { files = await spec.backup(item, { host, operationId: preview.operationId, preview }); }
      catch (error) {
        const e = errorOf(error);
        markItem(record, item, { state: 'backup-failed', error: { code: e.code, message: e.message } }, at());
        endOperation(record, 'refused', at());
        return { ok: false, code: 'BACKUP_FAILED', error: 'The backup of ' + item.name + ' failed (' + e.code + '); nothing was sent.', sent: false, tenant: host,
          problems: [problem('BACKUP_FAILED', 'The backup of ' + item.name + ' failed: ' + e.message, 'read the cause; a new preview once the backup can be made', { cause: e.code })],
          operation: summarizeOperation(record, { root }) };
      }
      markItem(record, item, { state: 'backed-up', backup: { files } }, at());
      backups.push({ name: item.name, files });
      if (signal?.aborted) return { ...cancelledBefore(spec, host, preview, record, 'after the backup of ' + item.name), backup: backups };
    }
    if (signal?.aborted) return { ...cancelledBefore(spec, host, preview, record, 'before the send'), ...(backups.length ? { backup: backups } : {}) };
    for (const item of preview.items) markItem(record, item, { state: 'sending' }, at());
    // CX15 r3 (CT-3): the signal goes INTO the unguarded access (withSignal), which reads it again right before its write
    // leaves (after its own reads: consumers, approvals, target names). An abort there sends nothing (CANCELLED, not-sent):
    // the items go back to not-started and the record ends cancelled. An abort that comes while the write is in flight
    // does not cut it: the record keeps cancelRequestedAt and the item cancelledInFlight, with the outcome of the send.
    let abortedAt = null;
    const onAbort = () => { abortedAt ??= new Date(now()).toISOString(); };
    if (signal && !signal.aborted) signal.addEventListener('abort', onAbort, { once: true });
    let result;
    phase.sent = true;
    // CX15 r3 (N3): the reply this execution validated (count, names, words never seen before the list) reaches the
    // approvals of own fixtures (owned-cleanup-approval.mjs): a new approval of that reply with the preview as its
    // proposal, bound to the creation receipt of this target, replaces the creation's words.
    const reply = { host, tool: preview.tool, previewId: preview.previewId, operationId: preview.operationId, previewFile: previewFile(preview.previewId, { root }),
      wordsSha256: crypto.createHash('sha256').update(words).digest('hex'), keys: preview.items.map(i => i.key) };
    try { result = await withSignal(signal, () => withValidatedReply(reply, () => spec.send(preview, preview.operationId, words))); } catch (error) { result = { ok: false, error: errorOf(error), thrown: true }; }
    finally { signal?.removeEventListener?.('abort', onAbort); }
    if (cancelledInAccess(result)) {
      const answer = cancelledBefore(spec, host, preview, record, 'before the write left the access (after its reads)');
      return { ...answer, ...(backups.length ? { backup: backups } : {}), ...(result?.receipt ? { receipt: result.receipt } : {}) };
    }
    const flight = abortedAt ? { cancelledInFlight: true } : {};
    const state = itemState(result);
    const receipt = result?.receipt?.operationUuid ? defined({ operationUuid: result.receipt.operationUuid, state: result.receipt.state, file: result.receipt.file }) : null;
    for (const item of preview.items) markItem(record, item, { state, ...(receipt ? { receipt } : {}), ...(state === 'deleted' && result?.receipt?.state === 'accepted' ? { verified: false } : {}), ...flight }, at());
    endOperation(record, operationState(preview.items.map(() => state)), { ...at(), ...(abortedAt ? { cancelRequestedAt: abortedAt } : {}) });
    const nothingSent = state === 'refused' && !receipt;
    // Nothing sent: the token is spent, so the next step is always a new preview (with the other auth the access named).
    const spent = 'Nothing was sent and this token is spent: solve the cause, then a new preview and the owner\'s confirmation.';
    const inFlight = abortedAt ? { cancelRequestedAt: abortedAt, inFlightAtCancel: preview.items.map(i => i.name),
      cancelNote: 'The cancellation came while the write was being sent: that send went out (see operation), nothing was sent after it. Read ssam_task {id:"' + preview.operationId + '"} before telling the owner anything.' } : {};
    return { ...result, tenant: result?.tenant ?? host, ...(own ? { ownFixture: true } : {}), operation: summarizeOperation(record, { root }), ...(backups.length ? { backup: backups } : {}), ...inFlight,
      ...(nothingSent ? { continuation: retryOf(spec, host, result, preview) ?? previewStep(spec, host, spent, preview) } : {}) };
  }
  // The access refused the write for the client's cancellation before it left (CT-3): no receipt says it was sent.
  function cancelledInAccess(result) {
    const code = result?.error?.code ?? result?.code;
    return code === 'CANCELLED' && result?.thrown !== true && (!result?.receipt || result.receipt.state === 'not-sent');
  }

  // The token already ran: never sent again. With a receipt, the unguarded tool reads and reconciles it (an existing
  // receipt is never resent); without one, the record answers.
  async function byState(spec, host, check, words) {
    const record = check.operation, known = check.preview;
    if (known.tool !== spec.tool || text(known.host).toLowerCase() !== text(host).toLowerCase() || known.operation !== spec.operation) {
      const p = problem('PREVIEW_OTHER_TARGET', `The token is of ${known.tool} ${known.operation} on ${known.host}, not of ${spec.tool} ${spec.operation} on ${host}`,
        'the token of a preview of this call, or a new preview', { previewOf: { tool: known.tool, operation: known.operation, host: known.host } });
      return { ok: false, code: p.code, error: '1 problem(s); nothing was sent', problems: [p], tenant: host, sent: false,
        continuation: previewStep(spec, host, 'A new preview of the exact list (no token), shown to the owner, then the confirmation.') };
    }
    if (receiptOf(known.operationId)) {
      let result;
      try { result = await spec.send(check.preview, check.preview.operationId, words); } catch (error) { result = { ok: false, error: errorOf(error) }; }
      const state = itemState(result);
      if (record.state !== 'running' && ['deleted', 'absent'].includes(state) && record.items.some(i => i.state !== state)) {
        for (const item of record.items) markItem(record, item, { state }, { now: now(), root });
        endOperation(record, operationState(record.items.map(i => i.state)), { now: now(), root });
      }
      return { ...result, tenant: result?.tenant ?? host, alreadyExecuted: true, operation: summarizeOperation(record, { root }) };
    }
    return { ok: record.state === 'completed', state: 'executed', alreadyExecuted: true, sent: false, tenant: host,
      message: 'This confirmationToken already ran (' + record.state + '); nothing was sent again. The record says how each item ended.',
      operation: summarizeOperation(record, { root }),
      ...(record.state === 'completed' ? {} : { continuation: previewStep(spec, host, 'A new preview lists what is left; the owner confirms it with a new token.', known) }) };
  }
  // The typed deletes of own fixtures run only with their contextual approval: missing, the execution refuses before the
  // token is spent (the unguarded tool would refuse it too, after the token was spent).
  const contextRequired = (clean, what, { origin = false } = {}) => () => [
    ...(clean.authorizationContext ? [] : [problem('AUTHORIZATION_CONTEXT_INVALID', what + ' runs only with the contextual approval of the owned fixture (authorizationContext). Nothing was sent.',
      'authorizationContext: the approval written after this preview, whose words are the owner\'s reply', { path: '/authorizationContext' })]),
    ...(!origin || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text(clean.originOperationUuid)) ? []
      : [problem('INPUT_INVALID', what + ' needs originOperationUuid, the receipt that created the fixture.', 'originOperationUuid of its successful test/create receipt', { path: '/originOperationUuid' })])];

  const backupJson = (operationId, name, data) => [storeBackup({ operationId, name, data: JSON.stringify(data ?? null, null, 2), root })];

  // ---- CX15 r2 (D, E): a generic route whose effect has a dedicated tool. The generic call does not read or check what
  // the dedicated tool does (an asset's consumers in every stage and the source of its revision as backup; the entities of
  // a connection with their preview and count), so it is refused before anything is reserved or sent: ONE answer with
  // every problem and, as its continuation, the exact call of the dedicated tool, without the owner's words (a preview of
  // that tool first, then the owner's reply). The words a refused call carries are noted (seen-words) as those of any
  // destructive call: they never confirm the dedicated tool's preview.
  const hostOf = async tenant => { try { return await raw.pickTenant(tenant); } catch { return null; } };
  const noteSaid = (host, tool, input) => {
    if (!host) return;
    for (const value of [trimmed(input?.authorize), trimmed(input?.ownerRequest)]) if (value) noteWords({ host, tool, words: value, now: now(), root });
  };
  const authArgument = auth => (auth && auth !== 'auto' ? auth : undefined);
  // route: the refused call ({tool, operationId}); never 'operationId' at the top, which names a preview elsewhere.
  function dedicatedRoute({ tool, operationId, host, problems, continuation, continuations = {}, why }) {
    const steps = Object.fromEntries(Object.entries(continuations).filter(([, step]) => step && step !== continuation));
    return { ok: false, code: NEEDS_DEDICATED_TOOL, outcome: 'not-sent', sent: false, ...(host ? { tenant: host } : {}), route: { tool, operationId },
      error: `${problems.length} problem(s); nothing was sent: ${why}`, problems,
      tools: [...new Set([continuation.tool, ...Object.values(steps).map(step => step.tool)])],
      continuation, ...(Object.keys(steps).length ? { continuations: steps } : {}) };
  }

  // E: odc_write (and .\odc portal write) DELETE /assets/{assetKey} -> odc_asset_delete. Nothing is read: the refusal does
  // not depend on the asset. An operationUuid that already has a receipt was sent before: its receipt comes first.
  async function assetDeleteByWrite(input, clean) {
    const host = clean.tenant !== undefined ? await hostOf(clean.tenant) : null;
    noteSaid(host, 'odc_write', input);
    const assetKey = trimmed(clean.path?.assetKey);
    const problems = [problem(NEEDS_DEDICATED_TOOL, 'odc_write does not delete assets: odc_asset_delete reads the asset and its consumers in every stage (CONSUMERS_WOULD_BREAK), '
      + 'backs up the source (OML) of its current revision and previews the exact list with its count before the owner confirms.', 'odc_asset_delete {assetKey}', { path: '/operationId' })];
    if (!assetKey) problems.push(problem('INPUT_INVALID', 'path.assetKey names the asset to delete.', 'path: {assetKey: "<the asset key>"}', { path: '/path/assetKey' }));
    const dedicated = { tool: 'odc_asset_delete', arguments: defined({ tenant: host ?? undefined, assetKey: assetKey || undefined, auth: authArgument(clean.auth) }),
      why: 'the dedicated tool of an asset delete: a preview of the asset with its consumers and its backup, shown to the owner; then the same call with the confirmationToken and the owner\'s reply' };
    const receipt = receiptOf(clean.operationUuid) ? { tool: 'odc_receipt', arguments: { operationUuid: text(clean.operationUuid) },
      why: 'this operationUuid already has a receipt: a write was sent with it; read it before anything else and never send it again' } : null;
    return dedicatedRoute({ tool: 'odc_write', operationId: clean.operationId, host, problems, continuation: receipt ?? dedicated, continuations: { assetDelete: dedicated },
      why: 'an asset is deleted only through odc_asset_delete (consumers, OML backup, preview and count).' });
  }

  // D: odc_portal_write (and .\odc portal internal-write) connections.importEntities/importActions, one native save of the
  // entities and actions of a connection. It runs as before only when it can unselect nothing: a list that is not empty,
  // every entity, attribute and action in it selected, and everything selected now (read here, read only) named in it; an
  // unreadable selection refuses (fail closed). Otherwise ONE refusal with every problem; the continuation is
  // odc_external_db_connection: remove-entities for what the save would unselect (a preview with the count), import-entities
  // for the entities it selects, odc_mcp_connection import-plan for the tools of an MCP connection.
  async function dbObjectsRoute(input, clean) {
    let host;
    try { host = await raw.pickTenant(clean.tenant); } catch (error) { return { ok: false, sent: false, error: errorOf(error) }; }
    const route = clean.operationId, auth = clean.auth ?? 'auto';
    const p = isObject(clean.input?.inputParameters) ? clean.input.inputParameters : {};
    const connectionId = trimmed(p.ConnectionId);
    const saved = isObject(p.DatabaseObjects) ? p.DatabaseObjects : {};
    const lists = { entities: listOf(saved.Entities), actions: listOf(saved.Actions) };
    const LABEL = { entities: 'entity', actions: 'action' }, FIELD = { entities: 'Entities', actions: 'Actions' };
    const at = kind => `/input/inputParameters/DatabaseObjects/${FIELD[kind]}/List`;
    const problems = [], chosen = { entities: [], actions: [] }, dropped = { entities: [], actions: [] }, omitted = { entities: [], actions: [] };
    for (const kind of ['entities', 'actions']) {
      lists[kind].forEach((row, i) => {
        const name = rowName(row);
        if (!isObject(row) || !name) { problems.push(problem('INPUT_INVALID', `The ${LABEL[kind]} at ${i} has no OriginalName or Name: what the save does to it cannot be checked.`, `name every ${LABEL[kind]}`, { path: `${at(kind)}/${i}` })); return; }
        if (row.IsSelected !== true) { dropped[kind].push(name); return; }
        chosen[kind].push(name);
        const left = listOf(row.Attributes).filter(a => a?.IsSelected !== true).map(a => rowName(a) || '?');
        if (left.length) problems.push(problem('ATTRIBUTE_UNSELECTED', `The save leaves ${left.join(', ')} of ${name} unselected: it removes those attributes from the ${LABEL[kind]}.`,
          'odc_external_db_connection import-entities (attributes as the metadata has them), or plan-entities with objectContracts for a reviewed selection', { path: `${at(kind)}/${i}/Attributes`, target: name, targets: left }));
      });
    }
    if (dropped.entities.length) problems.push(problem('ENTITY_UNSELECTED', `The save unselects ${dropped.entities.length} entit${dropped.entities.length === 1 ? 'y' : 'ies'} (IsSelected not true), which removes them from the connection: ${dropped.entities.join(', ')}.`,
      'odc_external_db_connection remove-entities: a preview of the exact list with its count, then the owner\'s reply', { targets: dropped.entities }));
    if (dropped.actions.length) problems.push(problem('ACTION_UNSELECTED', `The save unselects ${dropped.actions.length} action(s) (IsSelected not true), which removes them from the connection: ${dropped.actions.join(', ')}.`,
      'no tool removes the actions of a connection with a preview yet: ask the owner; never through this route', { targets: dropped.actions }));
    if (!lists.entities.length && !lists.actions.length) problems.push(problem('SELECTION_EMPTY', 'The save names no entity and no action: it may unselect everything the connection has selected.',
      'odc_external_db_connection entities, to see what is selected; then the dedicated action', { path: '/input/inputParameters/DatabaseObjects' }));
    if (!connectionId) problems.push(problem('INPUT_INVALID', route + ' needs input.inputParameters.ConnectionId.', 'the ConnectionId of the connection', { path: '/input/inputParameters/ConnectionId' }));
    // What is selected now: the entities for importEntities (or a body that names entities), the actions for importActions
    // (or a body that names actions). Actions:[] in importEntities and Entities:[] in importActions are the native shape the
    // dedicated tools send (dbImport, mcp-import-plan), read as "this save does not touch that kind".
    const reads = !connectionId ? [] : [
      ...(route === 'connections.importEntities' || lists.entities.length ? [['entities', 'connections.selectedEntities', data => data?.SelectedEntityList_Original]] : []),
      ...(route === 'connections.importActions' || lists.actions.length ? [['actions', 'connections.selectedActions', data => data?.ActionList]] : [])];
    for (const [kind, operationId, rowsOf] of reads) {
      let seen;
      try { seen = await raw.portalRead({ tenant: host, auth, operationId, input: { screenVariables: elementVariables(connectionId) } }); } catch (error) { seen = { ok: false, error: errorOf(error) }; }
      const rows = seen?.ok === true ? rowsOf(seen.data) : undefined;
      if (!Array.isArray(rows) && !Array.isArray(rows?.List)) {
        problems.push(problem('SELECTION_UNREADABLE', `What ${connectionId} has selected now (${kind}) could not be read (${operationId}): a save that may unselect some of it is refused (fail closed).`,
          'read it again (odc_external_db_connection entities), then the dedicated action', { cause: seen?.error?.code ?? seen?.code ?? 'PORTAL_CONTRACT_CHANGED' }));
        continue;
      }
      const named = new Set(lists[kind].map(rowName).filter(Boolean));
      omitted[kind] = [...new Set(listOf(rows).map(rowName).filter(name => name && !named.has(name)))];
      if (omitted[kind].length) problems.push(problem('SELECTED_OMITTED', `${omitted[kind].length} ${LABEL[kind]}(s) selected now are left out of the save, which may unselect them: ${omitted[kind].join(', ')}.`,
        'name them in the save, selected, or use the dedicated tool', { targets: omitted[kind] }));
    }
    if (!problems.length) return null;
    noteSaid(host, 'odc_portal_write', input);
    const base = defined({ tenant: host, auth: authArgument(clean.auth), connectionId: connectionId || undefined });
    const db = (action, extra, why) => ({ tool: 'odc_external_db_connection', arguments: { ...base, action, ...extra }, why });
    const removal = [...new Set([...dropped.entities, ...omitted.entities])];
    const steps = {
      removeEntities: removal.length ? db('remove-entities', { objects: removal }, 'the removal this save could do, through the dedicated tool: a preview of the exact list with its count (nothing is sent), shown to the owner; then the same call with the confirmationToken and the owner\'s reply') : null,
      importEntities: chosen.entities.length ? db('import-entities', { objects: chosen.entities }, 'selects these entities from the database metadata without unselecting the others') : null,
      importTools: route === 'connections.importActions' && chosen.actions.length ? { tool: 'odc_mcp_connection', arguments: defined({ tenant: host, auth: authArgument(clean.auth), action: 'import-plan',
        connectionId: connectionId || undefined, toolNames: chosen.actions }), why: 'an MCP connection: the plan that keeps every imported tool and adds these; then odc_mcp_import with its hash' } : null,
    };
    const continuation = dropped.entities.length ? steps.removeEntities : chosen.entities.length ? steps.importEntities
      : steps.importTools ?? steps.removeEntities ?? db('entities', {}, 'reads the entities of the connection and what is selected now; then the dedicated action');
    return dedicatedRoute({ tool: 'odc_portal_write', operationId: route, host, problems, continuation, continuations: steps,
      why: `odc_portal_write ${route} can unselect (remove) entities or actions of a connection without a preview, a count or the owner's confirmation; odc_external_db_connection does it in two calls.` });
  }

  // ---- odc_asset_delete: identity and consumers (dependentsOf), the current revision, the source as backup.
  async function assetDelete(input = {}) {
    const clean = strip(input), auth = clean.auth ?? 'auto', context = Boolean(clean.authorizationContext);
    const keyOf = preview => preview?.request?.assetKey ?? clean.assetKey;
    const read = async (host, preview) => {
      const assetKey = keyOf(preview);
      const resolved = await raw.resolvePublic(host, auth);
      if (resolved?.ok === false) return { ...resolved, operationId: ASSET_DELETE };
      const dependents = await raw.dependentsOf(host, resolved, assetKey);
      if (!dependents?.ok) return refusalOf(dependents?.code ?? 'DEPENDENCY_CHECK_UNAVAILABLE', dependents?.message ?? 'The asset identity or its consumers could not be read; nothing was reserved or deleted.', { operationId: ASSET_DELETE });
      const asset = await raw.read({ tenant: host, auth, operationId: ASSET_GET, path: { assetKey } }).catch(() => null);
      const revision = asset?.ok && Number.isInteger(asset.data?.revision) && asset.data.revision > 0 ? asset.data.revision : null;
      const apiClient = await Promise.resolve(raw.apiClientAvailable?.(host)).catch(() => false) === true;
      const consumers = dependents.consumers.map(c => c.name);
      const backup = apiClient && revision ? { possible: true, how: `source of revision ${revision} (odc_asset_source, API Client), before the DELETE` }
        : { possible: false, why: !apiClient ? `no API Client stored for ${host}: the source of the current revision cannot be downloaded (studio_latest as the alternative: to confirm)` : 'the current revision of the asset could not be read' };
      return { ok: true, items: [defined({ kind: 'asset', key: assetKey, name: dependents.name, assetType: asset?.data?.assetType, revision, consumers, backup })],
        mustName: [dependents.name, ...consumers],
        extra: { asset: defined({ key: assetKey, name: dependents.name, revision, assetType: asset?.data?.assetType }), consumers,
          dependencyCheck: { checkedEnvironments: dependents.checkedEnvironments, includesPublishingDefault: dependents.includesPublishingDefault } } };
    };
    return run({ tool: 'odc_asset_delete', input, operation: ASSET_DELETE, target: clean.assetKey ?? null, request: { assetKey: clean.assetKey },
      base: without(clean, CALL_ONLY), read,
      nameRule: (preview, words) => (context ? [] : [...targetNamed(words, [preview.items[0].name, preview.items[0].key]),
        ...(preview.items[0].consumers ?? []).filter(c => !namesWhole(words, c)).map(c => problem('CONSUMERS_WOULD_BREAK', c + ' consumes ' + preview.items[0].name + ' and would break.',
          'the owner\'s reply that also names ' + c + ' (the asset and every consumer), or remove the dependency from ' + c + ' first', { target: c, ssamRule: true }))]),
      tenantRule: (host, words) => tenantProblems(raw.tenantInfo(host), words, clean.confirmTenant, { context }),
      backup: async (item, { host, operationId }) => {
        if (!(await Promise.resolve(raw.apiClientAvailable?.(host)).catch(() => false))) throw new OdcError('AUTH_NOT_CONFIGURED', 'No API Client is stored for ' + host + ' any more.');
        const fresh = await raw.read({ tenant: host, auth, operationId: ASSET_GET, path: { assetKey: item.key } }).catch(() => null);
        const revision = Number.isInteger(fresh?.data?.revision) && fresh.data.revision > 0 ? fresh.data.revision : item.revision;
        const source = await raw.assetSource({ tenant: host, assetKey: item.key, revisionNumber: revision, auth: 'api-client', kind: 'source' });
        if (!source?.ok || typeof source.file !== 'string' || !fs.existsSync(source.file)) {
          const e = source?.error ?? {};
          throw new OdcError(e.code ?? 'SOURCE_DOWNLOAD_FAILED', e.message ?? 'The source of revision ' + revision + ' could not be downloaded.');
        }
        return [{ ...storeBackup({ operationId, name: `${item.name}-${item.key}-r${revision}.oml`, source: source.file, root }), revision }];
      },
      send: (preview, operationUuid, words) => raw.assetDelete({ ...clean, assetKey: preview.request?.assetKey ?? preview.items[0].key, authorize: words, operationUuid }),
      reconcile: () => raw.assetDelete(clean) });
  }

  // ---- odc_write and .\odc portal write: a DELETE or an Undeploy (effects.mjs) previews; anything else is unchanged.
  async function write(input = {}, options = {}) {
    const clean = strip(input);
    if (clean.operationId === ASSET_DELETE) return assetDeleteByWrite(input, clean);
    let operation;
    try { operation = raw.catalog.get(clean.operationId).operation; } catch { return raw.write(clean, options); }
    if (effectOf(operation, clean.body) !== 'destructive') return raw.write(clean, options);
    if (operation.method !== 'DELETE' && removalsOf(clean.body).length) return removalWrite(input, clean, options, operation);
    const auth = clean.auth ?? 'auto', context = Object.keys(writeContext(options)).some(k => /Context$/.test(k));
    const request = defined({ path: clean.path, query: clean.query, body: clean.body, contentType: clean.contentType });
    const read = async (host, preview) => {
      const req = preview?.request ?? request;
      const resolved = await raw.resolvePublic(host, auth);
      if (resolved?.ok === false) return { ...resolved, operationId: clean.operationId };
      const names = (await raw.targetNames(host, resolved, operation, req)) ?? [];
      const key = requestKey(operation.id, req) ?? clean.operationId;
      const spec = operation.id === DEPLOY ? { read: ASSET_GET, path: { assetKey: req.body?.assetKey } } : TARGET_NAMES[operation.id] ? { read: TARGET_NAMES[operation.id].read, path: req.path ?? {} } : null;
      const detail = spec ? await raw.read({ tenant: host, auth, operationId: spec.read, path: spec.path }).catch(() => null) : null;
      const name = names.find(n => n !== key && !Object.values(req.path ?? {}).map(String).includes(n)) ?? names[0] ?? key;
      const backup = detail?.ok ? { possible: true, how: 'the JSON of ' + spec.read + ' (redacted as read), before the send' }
        : { possible: false, why: spec ? 'the detail read of the target failed' : 'no detail read exists for this operation' };
      return { ok: true, items: [{ kind: kindOfOperation(operation.id), key, name, aliases: names, operationId: clean.operationId, backup }], mustName: names,
        detail: detail?.ok ? detail.data : null };
    };
    return run({ tool: 'odc_write', input, operation: clean.operationId, target: requestKey(operation.id, request), request, context: () => writeContext(options),
      base: { ...without(clean, CALL_ONLY), ...writeContext(options) }, read,
      nameRule: (preview, words) => (context ? [] : targetNamed(words, [preview.items[0].name, ...(preview.items[0].aliases ?? [])])),
      tenantRule: (host, words) => tenantProblems(raw.tenantInfo(host), words, clean.confirmTenant, { context }),
      backup: async (item, { host, operationId, preview }) => {
        const seen = await read(host, preview);
        if (!seen?.ok || !seen.detail) throw new OdcError('DETAIL_UNREADABLE', 'The detail of ' + item.name + ' could not be read again.');
        return backupJson(operationId, `${item.kind}-${item.key}.json`.replace(/\//g, '_'), seen.detail);
      },
      send: (preview, operationUuid, words) => raw.write({ ...clean, ...(preview.request ?? {}), authorize: words, operationUuid }, options),
      reconcile: () => raw.write(clean, options) });
  }

  // ---- CX15 r3 (BYPASS-2): odc_write (and .\odc portal write) PATCH with a non-empty *ToRemove list (effects.mjs
  // removalsOf). Each key that leaves is an item (the count is theirs), named by its read when readable (a user's name
  // and email, a role's name; else the key); the group is their parent (application), read by TARGET_NAMES. The words
  // name the group and every key that leaves (name, email or key, whole word), with the count. The execution sends the
  // previewed request (path, query and body, *ToAdd included) in ONE PATCH; the record and the receipt keep the keys.
  // Nothing is downloaded as a backup: the keys are what restores the membership (the same list in *ToAdd).
  const MAX_NAMED = 50;
  const canonical = value => JSON.stringify(value ?? null, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
  async function removalWrite(input, clean, options, operation) {
    const auth = clean.auth ?? 'auto', context = Object.keys(writeContext(options)).some(k => /Context$/.test(k));
    const request = defined({ path: clean.path, query: clean.query, body: clean.body, contentType: clean.contentType });
    const read = async (host, preview) => {
      const req = preview?.request ?? request;
      const resolved = await raw.resolvePublic(host, auth);
      if (resolved?.ok === false) return { ...resolved, operationId: clean.operationId };
      const names = (await raw.targetNames(host, resolved, operation, req)) ?? [];
      const parentKey = requestKey(operation.id, req) ?? clean.operationId;
      const parent = names.find(n => n !== parentKey && !Object.values(req.path ?? {}).map(String).includes(n)) ?? parentKey;
      const items = [], adds = {};
      let named = 0;
      for (const [field, value] of Object.entries(req.body ?? {})) if (/ToAdd$/.test(field) && Array.isArray(value) && value.length) adds[field] = value.map(String);
      for (const { field, keys } of removalsOf(req.body)) {
        const spec = REMOVAL_NAMES[field];
        for (const key of keys) {
          let aliases = [];
          if (spec && named++ < MAX_NAMED) {
            const seen = await raw.read({ tenant: host, auth, operationId: spec.read, ...(spec.byQuery ? { query: { key } } : { path: { key } }) }).catch(() => null);
            const rows = spec.byQuery ? (Array.isArray(seen?.data?.results) ? seen.data.results : []) : [];
            const row = spec.byQuery ? (rows.length === 1 && rows[0]?.key === key ? rows[0] : null) : seen?.ok ? seen.data : null;
            aliases = spec.fields.map(f => row?.[f]).filter(v => typeof v === 'string' && v.trim());
          }
          items.push(defined({ kind: spec?.kind ?? `removed-${field}`, key, name: aliases[0] ?? key, aliases: aliases.length > 1 ? aliases.slice(1) : undefined, application: parent, field,
            backup: { possible: false, why: 'nothing to download: the record and the receipt keep the keys that leave; the same keys in the matching ToAdd list restore them' } }));
        }
      }
      return { ok: true, items, mustName: [parent, ...items.map(i => i.name)],
        extra: { removes: { [operation.id.includes('/application-roles') ? 'groupApplicationRoles' : 'groupMembers']: items.length, parent: { key: parentKey, name: parent },
          keys: Object.fromEntries(removalsOf(req.body).map(r => [r.field, r.keys])) }, ...(Object.keys(adds).length ? { alsoAdds: adds } : {}) } };
    };
    // The words name the parent (its name or key) and every key that leaves (name, email or key), whole words.
    const nameRule = (preview, words) => {
      if (context) return [];
      const parent = preview.items[0]?.application, parentKey = requestKey(operation.id, preview.request ?? {});
      const unnamed = preview.items.filter(i => ![i.name, i.key, ...(i.aliases ?? [])].some(n => namesWhole(text(words), text(n))));
      return [...targetNamed(words, [parent, parentKey]),
        ...(unnamed.length ? [problem('WORDS_MUST_NAME', `The owner's reply does not name ${unnamed.length} of the ${preview.items.length} key(s) that leave ${parent}: ${unnamed.map(i => i.name).join(', ')}.`,
          'the owner\'s reply that states the number and names every key that leaves (name, email or key)', { targets: unnamed.map(i => i.name) })] : [])];
    };
    // The call that carries the token sends the previewed request: another path, query or body is another target.
    const targetRule = known => {
      const asked = defined({ path: clean.path, query: clean.query, body: clean.body });
      const previewed = defined({ path: known.request?.path, query: known.request?.query, body: known.request?.body });
      return canonical(asked) === canonical(previewed) ? [] : [problem('PREVIEW_OTHER_TARGET', 'The path, query or body of this call is not the previewed request (the token removes exactly the keys it listed).',
        'a new preview of this request (no token), shown to the owner, then the confirmation', { target: 'request' })];
    };
    return run({ tool: 'odc_write', input, operation: clean.operationId, target: null, request, context: () => writeContext(options), targetRule,
      base: { ...without(clean, CALL_ONLY), ...writeContext(options) }, read, nameRule,
      tenantRule: (host, words) => tenantProblems(raw.tenantInfo(host), words, clean.confirmTenant, { context }),
      send: (preview, operationUuid, words) => raw.write({ ...clean, ...(preview.request ?? {}), authorize: words, operationUuid }, options),
      reconcile: () => raw.write(clean, options) });
  }

  // ---- odc_deploy: Undeploy previews (the app and the stage); Deploy and ApplyConfigs are unchanged.
  async function deploy(input = {}) {
    const clean = strip(input);
    if ((clean.operation ?? 'Deploy') !== 'Undeploy') return raw.deploy(clean);
    const auth = clean.auth ?? 'auto', context = Boolean(clean.authorizationContext);
    const request = defined({ assetKey: clean.assetKey, environmentKey: clean.environmentKey, revision: clean.revision, buildKey: clean.buildKey });
    const read = async (host, preview) => {
      const req = preview?.request ?? request;
      const resolved = await raw.resolvePublic(host, auth);
      if (resolved?.ok === false) return { ...resolved, operationId: DEPLOY };
      let operation;
      try { operation = raw.catalog.get(DEPLOY).operation; } catch (error) { return { ok: false, error: errorOf(error) }; }
      const body = { operation: 'Undeploy', assetKey: req.assetKey, environmentKey: req.environmentKey };
      const names = (await raw.targetNames(host, resolved, operation, { body })) ?? [];
      const detail = await raw.read({ tenant: host, auth, operationId: ASSET_GET, path: { assetKey: req.assetKey } }).catch(() => null);
      const stages = await raw.read({ tenant: host, auth, operationId: ENVIRONMENTS }).catch(() => null);
      const stage = (Array.isArray(stages?.data?.results) ? stages.data.results : []).find(s => s?.key === req.environmentKey);
      const name = names.find(n => n !== req.assetKey) ?? req.assetKey;
      return { ok: true, items: [defined({ kind: 'deployment', key: `${req.assetKey}@${req.environmentKey}`, name, aliases: names, stage: stage?.name ?? req.environmentKey,
        backup: detail?.ok ? { possible: true, how: 'the asset JSON before the Undeploy (the revision stays in the asset repository)' } : { possible: false, why: 'the asset could not be read' } })],
      mustName: names, detail: detail?.ok ? detail.data : null };
    };
    return run({ tool: 'odc_deploy', input, operation: 'Undeploy', target: clean.assetKey && clean.environmentKey ? `${clean.assetKey}@${clean.environmentKey}` : null, request,
      base: without(clean, CALL_ONLY), read,
      nameRule: (preview, words) => (context ? [] : targetNamed(words, [preview.items[0].name, ...(preview.items[0].aliases ?? [])])),
      tenantRule: (host, words) => tenantProblems(raw.tenantInfo(host), words, clean.confirmTenant, { context }),
      backup: async (item, { host, operationId, preview }) => {
        const seen = await read(host, preview);
        if (!seen?.ok || !seen.detail) throw new OdcError('DETAIL_UNREADABLE', 'The asset of ' + item.name + ' could not be read again.');
        return backupJson(operationId, `deployment-${item.key.replace(/[@/]/g, '_')}.json`, seen.detail);
      },
      send: (preview, operationUuid, words) => raw.deploy({ ...clean, ...(preview.request ?? {}), operation: 'Undeploy', authorize: words, operationUuid }),
      reconcile: () => raw.deploy(clean) });
  }

  // ---- odc_portal_write and .\odc portal internal-write: the routes with effect 'destructive'. They run only with the
  // contextual approval of an own fixture (the unguarded portalWrite checks it, with its own proposal).
  async function portalWrite(input = {}, options = {}) {
    const clean = strip(input);
    if (DB_OBJECT_SAVES.has(clean.operationId)) return (await dbObjectsRoute(input, clean)) ?? raw.portalWrite(clean, options);
    const route = PORTAL_WRITES[clean.operationId];
    if (route?.effect !== 'destructive') return raw.portalWrite(clean, options);
    const auth = clean.auth ?? 'auto';
    const spec = PORTAL_TARGETS[clean.operationId] ?? { kind: 'portal-route', keys: [] };
    const keyOf = value => {
      const p = isObject(value?.inputParameters) ? value.inputParameters : {};
      const parts = spec.keys.map(k => p[k]).filter(v => v !== undefined && v !== null && v !== '').map(String);
      return parts.length ? parts.join('/') : null;
    };
    const request = { input: clean.input };
    const read = async (host, preview) => {
      const value = preview?.request?.input ?? clean.input ?? {};
      const p = isObject(value.inputParameters) ? value.inputParameters : {};
      const key = keyOf(value);
      if (!key) return refusalOf('INPUT_INVALID', clean.operationId + ' needs ' + (spec.keys.join(', ') || 'its inputParameters') + ' in input.inputParameters.');
      const lookup = spec.detail?.(p) ?? spec.list?.() ?? null;
      const seen = lookup ? await raw.portalRead({ tenant: host, auth, operationId: lookup.operationId, input: lookup.input }).catch(() => null) : null;
      const found = seen?.ok ? recordIn(seen.data, p[spec.keys[0]], { list: Boolean(spec.list) }) : null;
      const backup = found ? { possible: true, how: 'the JSON of ' + lookup.operationId + ' (redacted as read), before the send' }
        : { possible: false, why: lookup ? 'the read of ' + lookup.operationId + ' did not return the target' : spec.why ?? 'no detail read exists for this route' };
      return { ok: true, items: [{ kind: spec.kind, key, name: found?.name ?? key, route: clean.operationId, backup }], mustName: found?.name ? [found.name] : [],
        detail: found ? (spec.list ? found.record : seen.data) : null };
    };
    return run({ tool: 'odc_portal_write', input, operation: clean.operationId, target: keyOf(clean.input), request,
      base: without(clean, CALL_ONLY), read,
      tenantRule: () => (clean.authorizationContext || options.externalLibraryParent || options.preparedConnectionApproval ? []
        : [problem('DESTRUCTIVE_TARGET_NOT_NAMED', 'odc_portal_write has no target argument: ' + clean.operationId + ' runs only with the contextual approval of an own fixture (authorizationContext).',
          'authorizationContext: the approval of this own fixture, bound to its creation receipt', { candidates: [] })]),
      backup: async (item, { host, operationId, preview }) => {
        const seen = await read(host, preview);
        if (!seen?.ok || !seen.detail) throw new OdcError('DETAIL_UNREADABLE', 'The detail of ' + item.name + ' could not be read again.');
        return backupJson(operationId, `${item.kind}-${item.key}.json`.replace(/\//g, '_'), seen.detail);
      },
      send: (preview, operationUuid, words) => raw.portalWrite({ ...clean, ...(preview.request ?? {}), authorize: words, operationUuid }, options),
      reconcile: () => raw.portalWrite(clean, options) });
  }

  // ---- odc_a2a_connection_delete: the owned connection read by its detail (projected, no secret).
  async function a2aConnectionDelete(input = {}) {
    const clean = strip(input), auth = clean.auth ?? 'auto';
    const request = defined({ connectionId: clean.connectionId, originOperationUuid: clean.originOperationUuid });
    const read = async (host, preview) => {
      const req = preview?.request ?? request;
      const detail = await raw.portalRead({ tenant: host, auth, operationId: 'connections.detail', input: { connectionId: req.connectionId, providerId: 'a2a' } });
      if (!detail?.ok) return { ...detail, ok: false };
      let origin = null; try { origin = req.originOperationUuid ? raw.receipts?.lookup?.(req.originOperationUuid) : null; } catch { origin = null; }
      const name = detail.data?.Connection?.name ?? origin?.reconciliation?.a2aConnection?.name ?? req.connectionId;
      return { ok: true, items: [{ kind: 'a2a-connection', key: req.connectionId, name, backup: { possible: true, how: 'the JSON of connections.detail (projected, no secret), before the send' } }],
        mustName: [name], detail: detail.data };
    };
    return run({ tool: 'odc_a2a_connection_delete', input, operation: 'connections.delete', target: clean.connectionId ?? null, request,
      base: without(clean, CALL_ONLY), read, tenantRule: contextRequired(clean, 'odc_a2a_connection_delete', { origin: true }),
      backup: async (item, { host, operationId, preview }) => {
        const seen = await read(host, preview);
        if (!seen?.ok) throw new OdcError('DETAIL_UNREADABLE', 'The detail of ' + item.name + ' could not be read again.');
        return backupJson(operationId, `a2a-connection-${item.key}.json`, seen.detail);
      },
      send: (preview, operationUuid, words) => raw.a2aConnectionDelete({ ...clean, ...(preview.request ?? {}), authorize: words, operationUuid }),
      reconcile: () => raw.a2aConnectionDelete(clean) });
  }

  // ---- odc_external_db_connection delete (the connection) and remove-entities (each object is an item; the objects
  // exist only in the preview: the execution takes them from the token).
  async function externalDbConnection(input = {}) {
    const clean = strip(input);
    if (!DB_ACTIONS.has(clean.action)) return raw.externalDbConnection(clean);
    const auth = clean.auth ?? 'auto', remove = clean.action === 'remove-entities';
    const request = defined({ connectionId: clean.connectionId, providerId: clean.providerId });
    const read = async (host, preview) => {
      const req = preview?.request ?? request;
      if (!req.connectionId) return refusalOf('INPUT_INVALID', clean.action + ' needs connectionId.');
      const detail = await raw.portalRead({ tenant: host, auth, operationId: 'connections.detail', input: { connectionId: req.connectionId, providerId: req.providerId ?? 'mssql' } });
      if (!detail?.ok) return { ...detail, ok: false };
      const name = detail.data?.Connection?.name ?? req.connectionId;
      if (!remove) return { ok: true, items: [{ kind: 'db-connection', key: req.connectionId, name, backup: { possible: true, how: 'the JSON of connections.detail (projected, no secret), before the send' } }],
        mustName: [name], detail: detail.data };
      const objects = preview ? preview.selection?.objects ?? [] : clean.objects ?? [];
      if (!Array.isArray(objects) || !objects.length) return refusalOf('INPUT_INVALID', 'remove-entities needs objects (the entity names to unselect).');
      return { ok: true, items: objects.map(object => ({ kind: 'db-connection-entity', key: `${req.connectionId}/${object}`, name: String(object), application: name,
        backup: { possible: true, how: 'the entities metadata of the connection (no database record), before the send' } })), mustName: [name, ...objects.map(String)] };
    };
    let entities = null;
    // remove-entities: the items are the objects; the connection the call names must be the preview's.
    const targetRule = known => (remove && clean.connectionId && known.request?.connectionId && clean.connectionId !== known.request.connectionId
      ? [problem('PREVIEW_OTHER_TARGET', `The token lists entities of ${known.request.connectionId}, not of ${clean.connectionId}`, 'the token of a preview of this connection, or a new preview', { target: clean.connectionId })] : []);
    return run({ tool: 'odc_external_db_connection', input, operation: clean.action, target: remove ? null : clean.connectionId ?? null, request, targetRule,
      selection: remove ? { objects: clean.objects ?? [] } : {}, executionSelection: remove ? { objects: clean.objects ?? [] } : {},
      base: without(clean, [...CALL_ONLY, 'objects']), read, tenantRule: contextRequired(clean, 'odc_external_db_connection ' + clean.action, { origin: true }),
      backup: async (item, { host, operationId, preview }) => {
        if (!remove) {
          const seen = await read(host, preview);
          if (!seen?.ok) throw new OdcError('DETAIL_UNREADABLE', 'The detail of ' + item.name + ' could not be read again.');
          return backupJson(operationId, `db-connection-${item.key}.json`, seen.detail);
        }
        entities ??= await raw.externalDbConnection({ tenant: host, auth, action: 'entities', connectionId: preview.request.connectionId });
        if (!entities?.ok) throw new OdcError(entities?.error?.code ?? 'DETAIL_UNREADABLE', 'The entities of the connection could not be read.');
        const found = recordIn(entities, item.name, { list: true });
        return backupJson(operationId, `db-entity-${item.key}.json`.replace(/\//g, '_'), found?.record ?? entities);
      },
      send: (preview, operationUuid, words) => raw.externalDbConnection({ ...without(clean, ['objects']), ...(preview.request ?? {}), action: clean.action,
        ...(remove ? { objects: preview.selection?.objects ?? [] } : {}), authorize: words, operationUuid }),
      reconcile: () => raw.externalDbConnection(clean) });
  }

  // ---- odc_external_library discard: the open job (by jobKey, or the one pending job of the library). discard(args)
  // is the deployer's (portal/runtime/external-library.mjs), which deletes through the unguarded access.
  async function discard(input = {}, runDiscard) {
    const clean = strip(input), auth = clean.auth ?? 'auto', context = Boolean(clean.authorizationContext);
    const request = defined({ jobKey: clean.jobKey });
    const read = async (host, preview) => {
      let jobKey = preview?.request?.jobKey ?? preview?.items?.[0]?.key ?? clean.jobKey;
      if (!jobKey) {
        const jobs = await raw.read({ tenant: host, auth, operationId: JOBS });
        if (!jobs?.ok) return { ...jobs, ok: false };
        const lower = v => text(v).toLowerCase(), library = lower(clean.library);
        const rows = Array.isArray(jobs.data?.results) ? jobs.data.results : Array.isArray(jobs.data) ? jobs.data : [];
        const open = rows.filter(j => PENDING_JOBS.has(j?.status) && (lower(j.libraryName) === library || lower(j.filename).startsWith(library + '-')));
        if (open.length !== 1) return refusalOf(open.length ? 'AMBIGUOUS' : 'JOB_NOT_FOUND', open.length ? 'Several open jobs of ' + clean.library + '; pass jobKey.' : 'No open job of ' + clean.library + '.',
          { jobs: open.map(j => ({ jobKey: j.key, status: j.status, filename: j.filename })) });
        jobKey = open[0].key;
      }
      const job = await raw.read({ tenant: host, auth, operationId: JOB_GET, path: { operationKey: jobKey } });
      if (!job?.ok) return { ...job, ok: false, jobKey };
      const libraryName = typeof job.data?.libraryName === 'string' && job.data.libraryName ? job.data.libraryName : undefined;
      const name = libraryName || clean.library || job.data?.filename || jobKey;
      return { ok: true, items: [defined({ kind: 'external-library-job', key: jobKey, name, libraryName, filename: job.data?.filename, status: job.data?.status,
        backup: { possible: true, how: 'the JSON of the generation job (metadata), before the DELETE' } })], mustName: [name], detail: job.data,
      extra: { jobKey } };
    };
    return run({ tool: 'odc_external_library', input, operation: 'discard', target: clean.jobKey ?? null, request: { ...request },
      base: { action: 'discard', ...without(clean, [...CALL_ONLY, 'action']) }, read,
      // Today's two rules, in one refusal: the words name the library as a whole word (WORDS_MUST_NAME_LIBRARY) and,
      // without an approval, the job's library, file or key as the raw DELETE guard reads it (DESTRUCTIVE_TARGET_NOT_NAMED).
      nameRule: (preview, words) => {
        if (context) return [];
        const item = preview.items[0];
        const names = [...new Set([item.libraryName, clean.library].filter(Boolean))];
        return [...(names.length && !names.some(n => namesWhole(words, n)) ? [problem('WORDS_MUST_NAME_LIBRARY', 'The words do not name ' + names[0] + ' as a whole word.',
          'the owner\'s reply that names ' + names[0], { path: '/authorize', ssamRule: true })] : []),
        ...targetNamed(words, [item.libraryName, item.filename, item.key])];
      },
      tenantRule: (host, words) => tenantProblems(raw.tenantInfo(host), words, clean.confirmTenant, { context }),
      backup: async (item, { host, operationId, preview }) => {
        const seen = await read(host, preview);
        if (!seen?.ok) throw new OdcError('DETAIL_UNREADABLE', 'The job ' + item.key + ' could not be read again.');
        return backupJson(operationId, `external-library-job-${item.key}.json`, seen.detail);
      },
      send: (preview, operationUuid, words) => runDiscard({ ...without(clean, ['action']), jobKey: preview.items[0].key, authorize: words, operationUuid }),
      reconcile: () => runDiscard(without(clean, ['action'])) });
  }

  return { write, deploy, portalWrite, assetDelete, a2aConnectionDelete, externalDbConnection, discard };
}
