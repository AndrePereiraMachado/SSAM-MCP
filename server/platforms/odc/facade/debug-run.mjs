// ssam_debug_run / `ssam debug run`: run an ODC or O11 action with chosen inputs and native app identity.
// execution=native-entry (both lanes, the path for new work) is dispatched at the end of this file: the code resolves the
// nearest public entry deterministically and publishes nothing. What follows first is the LEGACY ODC REST wrapper path
// (debug-adapter-registry: interactive 'legacy'; not interactive, live identity combination unproven, not counted in the
// debugger matrix; only release/reconcile of old leases), kept as it was and not extended:
// 1. The published revision is downloaded through the public API (no Studio) and the action is read from it.
// 2. The SSAM Debug REST wrapper (debug-wrapper.mjs) is added by the kernel, uploaded as a new revision with
//    a unique "SSAM Debug REST Create" comment carrying operationId/source hashes and published to Development.
// 3. The tracer (kernel/debug, trace mode) dumps every node of a window of the action while the wrapper is called
//    with the inputs; trace.jsonl is the map. 4. Unless keep=true the wrapper is removed from the LATEST revision
//    (a unique "SSAM Debug REST Remove" comment) and published again. Every write is recorded before send and
//    sent once; explicit reconciliation only reads bound revisions/deployments and never replays uncertain writes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as z from 'zod/v4';
import { workspaceRoot } from './workspace.mjs';
import * as W from './debug-wrapper.mjs';
import * as P from './debug-odc-portal.mjs';
import { entryChain } from './debug-entry.mjs';
import { prepareDebugAppUser, releaseDebugAppUser, appUserWorker, appUserSummary } from './debug-app-user.mjs';
import { o11RunSchema } from './debug-o11-run.mjs';
import { DIAGNOSTICS_RULE, signInFailureOf, withSignInFailure } from './debug-guidance.mjs';
import { nativeScreenContextSchema } from './debug-native-context-schema.mjs';
import { legacyNotice, legacyPrefix } from './debug-adapter-registry.mjs';
import { inputCapabilities } from './debug-input-capabilities.mjs';
import { roleCyclePending, ROLE_CYCLE_UNAVAILABLE } from './debug-foreign-pending.mjs';

const root = path.join(workspaceRoot, '.local', 'debugger', 'wrappers');
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/, KEY = /^[A-Za-z0-9_+]{22}$/;
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 1)); fs.renameSync(file + '.tmp', file); };
const now = () => new Date().toISOString();

export const runSchema = z.object({
  op: z.enum(['run', 'release', 'status', 'authorize', 'reconcile']),
  lane: z.literal('odc').default('odc'),
  tenant: z.string().min(3).max(200),
  module: z.string().regex(NAME).optional(),
  action: z.string().regex(NAME).optional(),
  operationId: z.uuid().optional(),
  // App credentials are collected in the private native sign-in window; never include them here.
  inputs: z.record(z.string().regex(NAME), z.json()).default({}),
  // Many scenarios per call: the wrapper is published once and every scenario is a plain POST (seconds).
  // Legacy as fields are parsed for a clear diagnostic. A session uses its signed-in app user and real roles.
  scenarios: z.array(z.object({ name: z.string().max(80).optional(), inputs: z.record(z.string().regex(NAME), z.json()).default({}), trace: z.boolean().optional(),
    as: z.object({ user: z.string().min(3).max(200).nullable().optional(), roles: z.record(z.string().regex(NAME), z.boolean()).optional() }).strict().optional() }).strict()).max(50).optional(),
  trace: z.enum(['all', 'none']).default('all'),
  around: z.string().regex(KEY).optional(),
  before: z.number().int().min(0).max(100).default(0),
  after: z.number().int().min(1).max(1000).default(300),
  depth: z.number().int().min(0).max(4).default(2),
  // The wrapper stays while scenarios are being tested and is removed after idleMinutes without calls (or by release).
  keep: z.boolean().default(true),
  idleMinutes: z.number().int().min(5).max(480).default(30),
  timeoutSeconds: z.number().int().min(5).max(300).default(90),
  words: z.string().min(1).max(2000).optional(),
}).strict().superRefine((v, ctx) => {
  const need = f => { if (!v[f]) ctx.addIssue({ code: 'custom', path: [f], message: `${f} is required for ${v.op}` }); };
  if (v.op === 'authorize') need('words');
  if (['run', 'release', 'status', 'reconcile'].includes(v.op)) need('module');
  if (v.op === 'run') need('action');
  if (v.op === 'reconcile') need('operationId');
  else if (v.operationId) ctx.addIssue({ code: 'custom', path: ['operationId'], message: 'operationId applies only to explicit reconciliation' });
  if (v.scenarios?.length && Object.keys(v.inputs).length) ctx.addIssue({ code: 'custom', path: ['inputs'], message: 'Give either inputs (one call) or scenarios (a batch)' });
  const named = (v.scenarios ?? []).map(s => s.name).filter(Boolean);
  if (new Set(named).size !== named.length) ctx.addIssue({ code: 'custom', path: ['scenarios'], message: 'Scenario names must be unique' });
});
// ODC remains the default. O11 must be chosen explicitly so the contract and dispatcher agree.
export const debugRunSchema = z.union([runSchema, o11RunSchema.safeExtend({ lane: z.literal('o11') })]);
// The MCP surface of ssam_debug_run: one flat object (MCP clients refuse a top-level anyOf), the fields of both lanes
// without defaults. debugRun then parses the strict lane schema above, which applies the defaults of the chosen lane
// (ODC keep=true, O11 keep=false) and refuses every field or combination outside it.
const looseScenario = z.object({ name: z.string().max(80).optional(), inputs: z.record(z.string().regex(NAME), z.json()).optional(), trace: z.boolean().optional(),
  context: nativeScreenContextSchema.optional(),
  as: z.object({ user: z.string().max(200).nullable().optional(), roles: z.record(z.string().regex(NAME), z.boolean()).optional() }).strict().optional() }).strict();
// Coordinator-only run fields (ODC): the server/client session starts consume them; ssam_debug_run itself refuses roleCycle.
const roleCycleSchema = z.object({ roleKey: z.uuid(), words: z.string().trim().min(8).max(500) }).strict();
const navigateSchema = z.object({ screen: z.string().regex(/^@[A-Za-z0-9_+]{22}$/), back: z.literal(true) }).strict();
// ODC lifecycle 'mounted' only: one trusted CDP click per entry in the SSAM-owned headless page, after the lifecycle settles.
const interactionsSchema = z.array(z.object({ target: z.string().regex(/^@[A-Za-z0-9_+]{22}$|^[A-Za-z_][A-Za-z0-9_]{0,120}$/), event: z.literal('click') }).strict()).min(1).max(10);
// Coordinator-only O11 fields over the (foreign) strict o11RunSchema: the Run Now trigger and the endpoint-credential
// context reach the native runner only through ssam_debug_server, whose runner takes the parsed request unchanged.
const o11CoordinatorRunSchema = o11RunSchema.safeExtend({
  contextMode: z.enum(['app-user', 'anonymous', 'native-background', 'endpoint-credential']).optional(),
  trigger: z.literal('service-center-run-now').optional() });
export const debugRunToolSchema = z.object({
  op: z.enum(['run', 'prepare', 'release', 'status', 'authorize', 'reconcile', 'locks']),
  lane: z.enum(['odc', 'o11']).optional(),
  tenant: z.string().min(3).max(200).optional(),
  host: z.string().min(3).max(200).optional(),
  module: z.string().regex(NAME).optional(),
  moduleKey: z.string().regex(KEY).optional(),
  applicationKey: z.string().regex(KEY).optional(),
  runtimeUrl: z.string().url().optional(),
  execution: z.enum(['rest-wrapper', 'native-entry']).optional(),
  lifecycle: z.enum(['isolated', 'mounted']).optional(),
  nativeEntry: z.object({ sourceContract: z.object({ path: z.string().min(1).max(2000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict().optional(),
  action: z.string().min(1).max(200).optional(),
  operationId: z.uuid().optional(),
  inputs: z.record(z.string().regex(NAME), z.json()).optional(),
  context: nativeScreenContextSchema.optional(),
  scenarios: z.array(looseScenario).max(50).optional(),
  contextMode: z.enum(['app-user', 'anonymous', 'native-background', 'endpoint-credential']).optional(),
  launch: z.object({ inputs: z.record(z.string().regex(NAME), z.json()).optional(),
    contextMode: z.enum(['app-user', 'anonymous']).optional() }).strict().optional(),
  // Inside ssam_debug_server start: O11 'service-center-run-now' (one Run Now of a Timer without a REST/SOAP caller);
  // ODC 'portal-wake' (one original Portal wake of a Timer, no app caller).
  trigger: z.enum(['service-center-run-now', 'portal-wake']).optional(),
  // ODC lifecycle 'mounted' only: one original in-app navigation per scenario, then navigateBack.
  navigate: navigateSchema.optional(),
  // ODC lifecycle 'mounted' only: one trusted CDP click per entry in the SSAM-owned headless page.
  interactions: interactionsSchema.optional(),
  workflow: z.object({ module: z.string().regex(NAME), process: z.string().min(1).max(200).optional() }).strict().optional(),
  // native-entry: none | nodes | full; the legacy wrapper paths take all | none.
  trace: z.enum(['all', 'none', 'nodes', 'full']).optional(),
  // native-entry only: entry is an override that must be a verified caller on the graph (never the model's choice);
  // modules adds O11 producer/consumer modules to the graph; window bounds the trace; acknowledgeEffects (ODC) lists the
  // effect classes prepare reported that the run may cause.
  entry: z.string().min(1).max(300).optional(),
  modules: z.array(z.object({ module: z.string().regex(NAME), moduleKey: z.string().regex(KEY), applicationKey: z.string().regex(KEY) }).strict()).max(8).optional(),
  window: z.object({ around: z.string().regex(KEY).optional(), before: z.number().int().min(0).max(100).optional(), after: z.number().int().min(1).max(1000).optional() }).strict().optional(),
  acknowledgeEffects: z.array(z.string().max(60)).max(20).optional(),
  around: z.string().regex(KEY).optional(),
  before: z.number().int().min(0).max(100).optional(),
  after: z.number().int().min(1).max(1000).optional(),
  depth: z.number().int().min(0).max(4).optional(),
  keep: z.boolean().optional(),
  idleMinutes: z.number().int().min(5).max(480).optional(),
  timeoutSeconds: z.number().int().min(5).max(300).optional(),
  words: z.string().min(1).max(2000).optional(),
  holdBetweenScenarios: z.literal(true).optional(),
  roleCycle: roleCycleSchema.optional(),
}).strict();

// Standing authorization for wrapper publications in Development, per tenant, in the user's own words.
const authFile = path.join(root, 'authorization.json');
function authorization(host) {
  try { return read(authFile).tenants?.[host] ?? null; } catch { return null; }
}
function authorize(host, words) {
  let all = { tenants: {} }; try { all = read(authFile); } catch { /* first grant */ }
  all.tenants[host] = { words, grantedAt: now(), scope: 'SSAM Debug REST wrapper create/remove publications in the Development stage' };
  write(authFile, all); return { ok: true, tenant: host, authorization: all.tenants[host] };
}

const leaseFile = (host, module) => path.join(root, 'odc', host, module + '.json');
function withLock(host, module, fn, file = leaseFile(host, module)) {
  const lock = file.replace(/\.json$/, '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  let fd; try { fd = fs.openSync(lock, 'wx'); } catch { throw new Error('debug_wrapper_busy: another debug operation holds ' + lock); }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now() })); fs.closeSync(fd);
  return Promise.resolve().then(fn).finally(() => { try { fs.unlinkSync(lock); } catch { /* already gone */ } });
}

// GUID asset key -> ODC module ObjectKey (inverse of P.assetKeyOf).
export function moduleKeyOf(assetKey) {
  const hex = assetKey.replace(/-/g, ''); const le = s => s.match(/../g).reverse().join('');
  const bytes = Buffer.from(le(hex.slice(0, 8)) + le(hex.slice(8, 12)) + le(hex.slice(12, 16)) + hex.slice(16), 'hex');
  return bytes.toString('base64').replace(/=+$/, '').replace(/\//g, '_');
}

async function readTree(target, modelPath, sha) {
  const { inspect } = await import('./lib.mjs');
  // max: the reader returns 60 children by default; an action with more nodes would lose part of its graph and labels
  // (seen live: ValidateQuoteRequest has 89 children, 63 of them nodes).
  const r = await inspect({ target, path: modelPath, depth: 3, max: 500, budget: 1000000, full: true, expectedSourceSha256: sha });
  if (!r.ok) return null;
  return r.tree ?? (r.out ? read(r.out).tree : null);
}
// Readers for the entry walk: direct callers of an element, and the properties of an element by path.
async function usagesOf(capture, key) {
  const { inspect } = await import('./lib.mjs');
  const r = await inspect({ target: capture.file, path: '@' + key, usages: true, scope: 'direct', depth: 1, max: 200, budget: 1000000, expectedSourceSha256: capture.sha256 });
  const data = r.entries ? r : r.out ? read(r.out) : null;
  if (!r.ok || !data) throw new Error('debug_usages_unreadable: ' + (r.error ?? 'reader'));
  return (data.entries ?? []).filter(e => /Execute\w*ActionNode$/.test(e.consumer.kind) || e.consumer.kind === 'Timer').map(e => ({ path: e.consumer.path, kind: e.consumer.kind, key: e.consumer.key }));
}
async function propsOf(capture, modelPath) {
  const { inspect } = await import('./lib.mjs');
  const r = await inspect({ target: capture.file, path: modelPath, depth: 0, all: true, budget: 200000, expectedSourceSha256: capture.sha256 });
  const tree = r.ok ? (r.tree ?? (r.out ? read(r.out).tree : null)) : null;
  return tree && { key: tree.key, kind: tree.kind, public: tree.properties?.Public === 'True', properties: tree.properties };
}
async function actionTree(file, sha, action) {
  for (const kind of ['ServerAction', 'ServiceAction']) { const tree = await readTree(file, `${kind}:${action}`, sha); if (tree) return tree; }
  throw new Error('debug_action_not_found: ' + action + ' (ServerAction/ServiceAction of the published revision)');
}

async function context(input) {
  const portal = await P.connect(input.tenant);
  const { debugDevelopmentStage, debugAsset, debugApplicationRuntime } = await import('./debug-odc-portal-session.mjs');
  const stage = await debugDevelopmentStage(portal);
  const row = await debugAsset(portal, input.module), assetKey = row.assetKey, moduleKey = moduleKeyOf(assetKey);
  const runtimeUrl = await debugApplicationRuntime(portal, stage, row, moduleKey);
  if (runtimeUrl && new URL(runtimeUrl).pathname.split('/').filter(Boolean)[0] !== input.module) throw new Error('debug_odc_session_application_name_mismatch');
  return { portal, stage, assetKey, moduleKey, runtimeUrl };
}

// Kernel job over a downloaded revision; returns the candidate path (the job never touches a Studio).
async function applyJob(job, base, dir, ctx) {
  const { applyKernel } = await import('./kernel-delivery.mjs');
  const jobFile = path.join(dir, 'job.json'); write(jobFile, job);
  const applied = await applyKernel({ job: jobFile, output: dir,
    snapshot: { path: base.file, sha256: base.sha256, developerId: ctx.portal.tenant.studioAuthor, host: ctx.portal.host, moduleKey: ctx.moduleKey } });
  if (!applied.ok) throw new Error('debug_wrapper_job_refused: ' + (applied.error ?? 'kernel') + ' (receipt ' + applied.receipt + ')');
  return { file: applied.candidate, sha256: P.sha256(fs.readFileSync(applied.candidate)) };
}

async function journal(entry) { (await import('./lib.mjs')).journal({ start: now(), tool: 'ssam_debug_run', ...entry }); }

function operationBinding(input, ctx) {
  return { tenant: ctx.portal.host, portalOrigin: ctx.portal.origin, assetKey: ctx.assetKey.toLowerCase(), module: input.module,
    moduleKey: ctx.moduleKey, environmentKey: ctx.stage.key.toLowerCase(), modelAuthor: ctx.portal.tenant.studioAuthor };
}
function beginWrite(input, ctx, lease, kind, base, candidate, dir) {
  const operation = P.writeOperation(operationBinding(input, ctx), kind, {
    baseRevision: kind === 'create' ? lease.baseRevision : lease.removeBaseRevision,
    baseSha256: base.sha256, candidateSha256: candidate.sha256 });
  operation.recordFile = path.join(dir, 'write-' + operation.id + '.json');
  if (lease.writeOperation) lease.writeHistory = [...(lease.writeHistory ?? []), lease.writeOperation];
  lease.writeOperation = operation;
  const onStage = () => { write(operation.recordFile, operation); write(leaseFile(ctx.portal.host, input.module), lease); };
  onStage(); // Record the exact model/target/comment before requesting even an upload URL.
  return { operation, onStage };
}

export async function reconcileWrapper(input, ctx, lease, { file = leaseFile(ctx.portal.host, input.module), reconcile = P.reconcileWrite } = {}) {
  const tracked = [lease?.writeOperation, ...(lease?.writeHistory ?? [])].filter(value => value?.id === input.operationId);
  if (tracked.length !== 1) return { ok: false, state: 'uncertain', error: 'debug_wrapper_reconcile_untracked_operation' };
  let operation;
  try {
    operation = read(tracked[0].recordFile);
    for (const field of ['schema', 'id', 'kind', 'preparedAt', 'recordFile', 'comment', 'baseRevision', 'baseSha256', 'candidateSha256'])
      if (operation[field] !== tracked[0][field]) throw new Error();
    if (!path.isAbsolute(operation.recordFile) || JSON.stringify(operation.binding) !== JSON.stringify(tracked[0].binding)) throw new Error();
  } catch { return { ok: false, state: 'uncertain', error: 'debug_wrapper_reconcile_record_mismatch' }; }
  const result = await reconcile(ctx.portal, operation, operationBinding(input, ctx), {
    directory: path.join(path.dirname(operation.recordFile), 'reconcile-' + Date.now()) });
  operation.reconciliation = { ...result, observedAt: now() };
  write(operation.recordFile, operation);
  const current = lease.writeOperation?.id === operation.id;
  let adopted = false;
  if (current) {
    lease.writeOperation = operation;
    if (result.state === 'published' && result.currentlyDeployed === true) {
      adopted = true;
      if (operation.kind === 'create') { lease.state = 'active'; lease.wrapperRevision = result.revision; }
      else { lease.state = 'removed'; lease.removeRevision = result.revision; lease.removedAt = now(); }
    } else if (result.state === 'failed') {
      lease.state = operation.kind === 'create' ? 'created-not-published' : 'uncertain';
    }
  } else lease.writeHistory = lease.writeHistory.map(value => value.id === operation.id ? operation : value);
  write(file, lease);
  return { ok: ['published', 'failed'].includes(result.state), ...result, adopted,
    lease: { state: lease.state, wrapperRevision: lease.wrapperRevision ?? null, removeRevision: lease.removeRevision ?? null } };
}

// Create (or re-create with the union of actions) the wrapper and publish it to Development.
async function ensureWrapper(input, ctx, lease) {
  const file = leaseFile(ctx.portal.host, input.module);
  if (lease && ['creating', 'removing', 'uncertain'].includes(lease.state)) throw new Error(`debug_wrapper_${lease.state}: reconcile ${file} before another publication (uncertain writes are never repeated)`);
  if (lease?.state === 'active' && lease.authentication === 'native-app-user' && lease.actions.some(a => a.name === input.action)) {
    const deployed = await P.deployedRevision(ctx.portal, ctx.assetKey, ctx.stage.key);
    if (deployed.revision === lease.wrapperRevision) return lease;
    lease = { ...lease, state: 'superseded', note: 'Development moved to revision ' + deployed.revision + '; the wrapper is not deployed anymore' };
    write(file, lease);
  }
  // A wrapper for another action set is removed first; the new one carries the union, so earlier actions stay callable.
  const previous = lease?.state === 'active' ? lease.actions.map(a => a.name) : [];
  if (['active', 'created-not-published', 'superseded'].includes(lease?.state)) lease = await removeWrapper(input, ctx, lease);
  const latest = await P.latestRevision(ctx.portal, ctx.assetKey), deployed = await P.deployedRevision(ctx.portal, ctx.assetKey, ctx.stage.key);
  if (latest.revision !== deployed.revision) throw new Error(`debug_development_not_at_latest: latest revision ${latest.revision}, Development runs ${deployed.revision}; publishing would ship unpublished changes`);
  const dir = path.join(root, 'odc', ctx.portal.host, input.module + '-' + Date.now()); fs.mkdirSync(dir, { recursive: true });
  const base = await P.downloadRevision(ctx.portal, ctx.assetKey, latest.revision, path.join(dir, `base-r${latest.revision}.oml`));
  const models = [];
  for (const name of [...new Set([...previous, input.action])]) {
    const tree = await actionTree(base.file, base.sha256, name);
    models.push({ name, model: W.actionModel(tree) });
  }
  const token = W.newToken();
  // Authenticate at the wrapper boundary and call the original action. Native user/role checks are intact
  // throughout local calls; no GetUserId/role-expression substitutions are made in this mode.
  const actions = models.map(m => ({ name: m.name, key: m.model.key, inputs: m.model.inputs, outputs: m.model.outputs }));
  const wrapperJob = W.createJob({ lane: 'odc', actions, token, appUser: true });
  const candidate = await applyJob(wrapperJob, base, path.join(dir, 'create'), ctx);
  // Entries of each action for the report: callers walked up in the published revision.
  const entries = {};
  for (const m of models) {
    try {
      const chain = await entryChain({ targetKey: m.model.key, targetPath: 'ServerAction:' + m.name, usages: key => usagesOf(base, key), properties: p => propsOf(base, p) });
      entries[m.name] = chain.entries.map(e => ({ entry: e.entry, depth: e.depth, chain: e.chain, roles: e.roles, anonymous: e.anonymous, needsUser: e.needsUser, authentication: e.authentication }));
    } catch (error) { entries[m.name] = { error: error.message }; }
  }
  const target = models.find(m => m.name === input.action);
  const wrappers = {};
  for (const { model: m } of models) {
    const methodTree = await readTree(candidate.file, `RestService:${W.SERVICE}/RestServiceAction:${m.name}`, candidate.sha256);
    const wrapper = methodTree ? W.actionModel(methodTree) : null;
    const callNode = wrapper?.nodes.find(n => n.name === W.names(m.name).call);
    if (!wrapper?.key || !callNode) throw new Error('debug_wrapper_not_in_candidate: ' + m.name);
    wrappers[m.name] = { key: wrapper.key, callNode: callNode.key };
  }
  const writeHistory = lease ? [...(lease.writeHistory ?? []), ...(lease.writeOperation ? [lease.writeOperation] : [])] : [];
  lease = { schema: 'ssam-debug-wrapper/1', lane: 'odc', tenant: ctx.portal.host, module: input.module, assetKey: ctx.assetKey, moduleKey: ctx.moduleKey,
    runtimeUrl: ctx.runtimeUrl, environmentKey: ctx.stage.key, state: 'creating', baseRevision: latest.revision, base, candidate, dir, token,
    actions: actions.map(a => ({ name: a.name, key: a.key })), wrappers, entries, authentication: 'native-app-user',
    targets: Object.fromEntries(models.map(m => [m.name, m.model])),
    authorization: authorization(ctx.portal.host)?.words, createdAt: now(), steps: [], writeHistory };
  write(file, lease);
  const pending = beginWrite(input, ctx, lease, 'create', base, candidate, dir);
  const created = await P.createRevision(ctx.portal, candidate.file, pending.operation.comment, pending);
  lease.steps.push({ step: 'create-revision', ...created, at: now() });
  if (created.state !== 'created') { lease.state = created.state === 'refused' ? 'not-created' : 'uncertain'; write(file, lease); await journal({ command: 'wrapper-create', module: input.module, outcome: lease.state }); throw new Error(`debug_wrapper_revision_${created.state}: ${JSON.stringify(created)}`); }
  lease.wrapperRevision = created.revision; write(file, lease);
  const published = await P.publish(ctx.portal, ctx.assetKey, created.revision, ctx.stage.key, { ...pending, onProgress: p => { lease.publish = p; write(file, lease); } });
  lease.steps.push({ step: 'publish', ...published, at: now() });
  lease.state = published.state === 'published' ? 'active' : published.state === 'failed' ? 'created-not-published' : 'uncertain';
  write(file, lease);
  await journal({ command: 'wrapper-create', operationId: pending.operation.id, module: input.module, outcome: lease.state, note: `${W.COMMIT.create} r${created.revision} [${ctx.portal.host}] authorized: ${lease.authorization}` });
  if (lease.state !== 'active') throw new Error(`debug_wrapper_publish_${published.state}: ${JSON.stringify(published)}; lease ${file}`);
  return lease;
}

async function removeWrapper(input, ctx, lease) {
  const file = leaseFile(ctx.portal.host, input.module);
  if (!lease || ['removed', 'not-created'].includes(lease.state)) return lease;
  if (['creating', 'removing', 'uncertain'].includes(lease.state)) throw new Error(`debug_wrapper_${lease.state}: reconcile ${file} first`);
  // active, superseded or created-not-published: whatever the latest revision holds, only the wrapper is taken out.
  const latest = await P.latestRevision(ctx.portal, ctx.assetKey);
  const dir = path.join(lease.dir, 'remove-r' + latest.revision); fs.mkdirSync(dir, { recursive: true });
  const base = await P.downloadRevision(ctx.portal, ctx.assetKey, latest.revision, path.join(dir, `latest-r${latest.revision}.oml`));
  // Removal starts from the LATEST revision: anything published meanwhile is kept, only the wrapper goes.
  const still = await readTree(base.file, `RestService:${W.SERVICE}`, base.sha256);
  if (!still) { lease = { ...lease, state: 'removed', removedAt: now(), note: 'revision ' + latest.revision + ' has no wrapper' }; write(file, lease); return lease; }
  const candidate = await applyJob(W.removeJob({ lane: 'odc', actions: lease.actions }), base, path.join(dir, 'job'), ctx);
  lease = { ...lease, state: 'removing', removeBaseRevision: latest.revision }; write(file, lease);
  const pending = beginWrite(input, ctx, lease, 'remove', base, candidate, dir);
  const created = await P.createRevision(ctx.portal, candidate.file, pending.operation.comment, pending);
  lease.steps.push({ step: 'remove-revision', ...created, at: now() });
  if (created.state !== 'created') { lease.state = created.state === 'refused' ? 'active' : 'uncertain'; write(file, lease); throw new Error(`debug_wrapper_remove_revision_${created.state}: ${JSON.stringify(created)}`); }
  lease.removeRevision = created.revision; write(file, lease);
  const published = await P.publish(ctx.portal, ctx.assetKey, created.revision, ctx.stage.key, { ...pending, onProgress: p => { lease.publish = p; write(file, lease); } });
  lease.steps.push({ step: 'publish-remove', ...published, at: now() });
  lease.state = published.state === 'published' ? 'removed' : 'uncertain'; if (lease.state === 'removed') lease.removedAt = now();
  write(file, lease);
  await journal({ command: 'wrapper-remove', operationId: pending.operation.id, module: input.module, outcome: lease.state, note: `${W.COMMIT.remove} r${created.revision} [${ctx.portal.host}]` });
  if (lease.state !== 'removed') throw new Error(`debug_wrapper_remove_publish_${published.state}; lease ${file}`);
  return lease;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Compact map for many scenarios: the first visit of an action carries every value, later visits only what changed.
export function compactMap(entries) {
  const last = new Map();
  return entries.map(e => {
    const scope = e.threadId + '|' + e.action, previous = last.get(scope) ?? null, current = new Map();
    for (const v of e.values ?? []) current.set(v.path, JSON.stringify(v));
    last.set(scope, current);
    const values = previous ? (e.values ?? []).filter(v => previous.get(v.path) !== current.get(v.path)) : e.values ?? [];
    const { values: _, threadId: __, ...rest } = e;
    return { ...rest, ...(previous ? { changed: values } : { values }) };
  });
}

// One entry per call: name, inputs, user context (as) and whether it is traced. Live run 2026-10-02 lost `as` here.
export function normalizeScenarios(input) {
  return (input.scenarios?.length ? input.scenarios : [{ name: 'call', inputs: input.inputs }])
    .map((s, i) => ({ name: s.name ?? 'scenario-' + (i + 1), inputs: s.inputs, as: s.as, trace: s.trace ?? input.trace === 'all' }));
}

export function validateNativeScenarios(input, appUser) {
  // A different identity needs its own private login; role booleans cannot grant native permissions.
  if (normalizeScenarios(input).some(s => s.as && (s.as.user !== undefined && s.as.user !== appUser.userKey || Object.keys(s.as.roles ?? {}).length)))
    throw new Error('debug_app_user_scenario_requires_separate_login');
}

// Scenarios through the published wrapper. One debug session serves every traced scenario of the batch; the calls are
// sequential, so the visits appended to trace.jsonl during one call belong to that call.
async function callScenarios(input, ctx, lease, appUser) {
  const { headlessDebug } = await import('./debug-runtime.mjs');
  const target = lease.targets[input.action], wrapper = lease.wrappers[input.action];
  const scenarios = normalizeScenarios(input);
  validateNativeScenarios(input, appUser);
  const postAsUser = body => appUserWorker('invoke', { descriptor: appUser, module: input.module, action: input.action, token: lease.token, body, timeoutSeconds: input.timeoutSeconds },
    { timeoutMs: (input.timeoutSeconds + 15) * 1000 });
  const window = input.around ? W.traceWindow(target, { around: input.around, before: input.before, after: input.after }) : null;
  const perCall = window ? window.steps : input.after + 1, traced = scenarios.filter(s => s.trace).length;
  let sessionId = null, traceFile = null, debug = null;
  const lines = () => traceFile && fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean) : [];
  const labels = new Map(target.nodes.map(n => [n.key, n.label || n.name || n.kind]));
  labels.set(wrapper.callNode, 'SSAMDebugCall (entry: calls ' + input.action + ')');
  const results = [];
  // Untraced scenarios run before the debug session exists: they never pause at the entry breakpoint (fast path).
  for (const s of scenarios.filter(s => !s.trace)) {
    const http = await postAsUser(s.inputs);
    const errors = typeof http.body === 'object' && http.body && (http.body.Errors ?? http.body.errors ?? http.body.error);
    results.push({ name: s.name, ok: http.ok && http.status === 200 && !errors, status: http.status, elapsedMs: http.elapsedMs, inputs: s.inputs, as: { user: appUser.userKey, authenticated: true },
      outputs: http.status === 200 ? http.body : null, exception: errors ?? (http.status >= 500 || http.status === null ? (http.body ?? http.error) : null) });
  }
  if (traced) {
    const roots = W.scopeRoots(target);
    const trace = { mode: 'step', steps: Math.min(2000, perCall * traced), depth: input.depth, fullValues: true,
      focusFunctionKey: target.key, requireFunctionKey: wrapper.key, scopes: { [target.key]: roots } };
    const started = await headlessDebug({ op: 'start', lane: 'odc', tenant: ctx.portal.host, module: input.module, moduleKey: ctx.moduleKey, runtimeUrl: ctx.runtimeUrl,
      nodeKeys: window ? window.entries : [wrapper.callNode], seconds: Math.min(600, 60 + traced * (input.timeoutSeconds + 15)), pauseSeconds: 5, autoContinue: true, paths: [], trace }, { appUser });
    if (!started.ok || started.state !== 'connected') return { ok: false, state: 'debugger-not-connected', debug: started, results };
    sessionId = started.sessionId; traceFile = path.join(workspaceRoot, '.local', 'debugger', sessionId, 'trace.jsonl');
  }
  try {
    for (const s of scenarios.filter(s => s.trace)) {
      const before = lines().length;
      const http = await postAsUser(s.inputs);
      let map;
      if (s.trace && sessionId) {
        // Settle: the visits of this call stop growing (two equal polls) before the next scenario starts.
        let last = -1, stable = 0;
        for (let i = 0; i < 60 && stable < 2; i++) { await sleep(500); const n = lines().length; stable = n === last ? stable + 1 : 0; last = n; }
        // The wrapper method carries the action's name: its frames are shown as SSAMDebug.<action>.
        map = compactMap(lines().slice(before).map(l => JSON.parse(l)).map(e => ({ seq: e.seq, threadId: e.threadId, action: e.functionKey === wrapper.key ? 'SSAMDebug.' + e.action : e.action,
          node: labels.get(e.nodeKey) ?? null, nodeKey: e.nodeKey, depth: e.stackDepth, values: e.values, ...(e.error ? { error: e.error } : {}) })));
      }
      const errors = typeof http.body === 'object' && http.body && (http.body.Errors ?? http.body.errors ?? http.body.error);
      results.push({ name: s.name, ok: http.ok && http.status === 200 && !errors, status: http.status, elapsedMs: http.elapsedMs, inputs: s.inputs, as: { user: appUser.userKey, authenticated: true },
        outputs: http.status === 200 ? http.body : null, exception: errors ?? (http.status >= 500 || http.status === null ? (http.body ?? http.error) : null),
        ...(map ? { visits: map.length, map } : {}) });
    }
  } finally {
    if (sessionId) debug = await headlessDebug({ op: 'stop', sessionId }).catch(error => ({ ok: false, error: error.message }));
  }
  const order = new Map(scenarios.map((s, i) => [s.name, i]));
  results.sort((a, b) => order.get(a.name) - order.get(b.name));
  return { ok: results.every(r => r.ok), via: 'wrapper', sessionId, results,
    summary: results.map(r => ({ name: r.name, status: r.status, ms: r.elapsedMs, as: r.as, outputs: r.outputs, exception: r.exception, visits: r.visits ?? null })),
    context: { mode: 'native-app-user', ...appUserSummary(appUser), traced: target.name },
    entries: lease.entries?.[input.action] ?? null,
    trace: sessionId ? { file: traceFile, window: window ?? { entries: [wrapper.callNode], stepsPerCall: perCall, anchor: 'start' }, debugStop: { ok: debug?.ok, state: debug?.state } } : null };
}

// Idle release: a detached reaper removes the wrapper once no scenario has run for idleMinutes.
function armReaper(ctx, input, lease) {
  const file = leaseFile(ctx.portal.host, input.module);
  lease.lastCallAt = now(); lease.idleMinutes = input.idleMinutes;
  if (lease.reaperPid) { try { process.kill(lease.reaperPid, 0); write(file, lease); return; } catch { /* reaper gone: start another */ } }
  const reaper = new URL('./debug-run-reaper.mjs', import.meta.url);
  const child = spawn(process.execPath, [fileURLToPath(reaper), ctx.portal.host, input.module], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref(); lease.reaperPid = child.pid; write(file, lease);
}

async function dispatch(input, services = {}) {
  if (input.op === 'authorize') return authorize(input.tenant, input.words);
  const ctx = await (services.context ?? context)(input), file = services.leasePath ?? leaseFile(ctx.portal.host, input.module);
  let lease = fs.existsSync(file) ? read(file) : null;
  if (input.op === 'status') return { ok: true, lease: lease && { ...lease, token: lease.token ? '[private]' : null } };
  if (input.op === 'reconcile') return withLock(ctx.portal.host, input.module, () =>
    reconcileWrapper(input, ctx, fs.existsSync(file) ? read(file) : null, { file, ...(services.reconcile ? { reconcile: services.reconcile } : {}) }), file);
  if (!authorization(ctx.portal.host)) throw new Error(`debug_wrapper_authorization_required: record the user's words once with op=authorize for ${ctx.portal.host}`);
  return withLock(ctx.portal.host, input.module, async () => {
    if (input.op === 'release') { lease = await removeWrapper(input, ctx, lease); return { ok: lease?.state === 'removed' || !lease, lease: lease && { state: lease.state, removeRevision: lease.removeRevision } }; }
    const prepared = await prepareDebugAppUser({ lane: 'odc', module: input.module, moduleKey: ctx.moduleKey, runtimeUrl: ctx.runtimeUrl, seconds: 600 });
    if (!prepared.ok) return prepared;
    const appUser = prepared.descriptor, startedAt = performance.now();
    let result, publishMs, credentialCleanup;
    try {
      validateNativeScenarios(input, appUser);
      lease = await ensureWrapper(input, ctx, lease);
      publishMs = Math.round(performance.now() - startedAt);
      result = await callScenarios(input, ctx, lease, appUser);
    }
    finally {
      const released = await releaseDebugAppUser(appUser).catch(() => ({ ok: false }));
      credentialCleanup = { state: released.ok ? 'released' : 'uncertain' };
      if (lease && !input.keep) {
        try { lease = await removeWrapper(input, ctx, lease); } catch (error) { result = { ...(result ?? { ok: false }), releaseError: error.message }; }
      } else if (lease?.state === 'active') armReaper(ctx, input, lease);
    }
    return { ...result, credentialCleanup, wrapper: { state: lease.state, baseRevision: lease.baseRevision, wrapperRevision: lease.wrapperRevision, removeRevision: lease.removeRevision ?? null,
      url: W.wrapperUrl(ctx.runtimeUrl, input.module, input.action), kept: input.keep, preparedMs: publishMs,
      ...(input.keep ? { autoRelease: `after ${input.idleMinutes} min without calls, or op=release` } : {}) } };
  });
}

// ODC native-entry (no wrapper, no publishing): prepare | run | status. The CODE picks the nearest public entry
// deterministically. This branch is separate from the wrapper branch below, which is left exactly as it was.
export const nativeEntrySchema = z.object({
  op: z.enum(['prepare', 'run', 'status']),
  lane: z.literal('odc').default('odc'),
  execution: z.literal('native-entry'),
  lifecycle: z.enum(['isolated', 'mounted']).optional(),
  tenant: z.string().min(3).max(200),
  module: z.string().regex(NAME).optional(),
  action: z.string().min(1).max(200).optional(),
  entry: z.string().min(1).max(200).optional(), // override only; must be a verified caller on the graph
  inputs: z.record(z.string().regex(NAME), z.json()).optional(),
  context: nativeScreenContextSchema.optional(),
  scenarios: z.array(z.object({ name: z.string().max(80).optional(), inputs: z.record(z.string().regex(NAME), z.json()).default({}),
    context: nativeScreenContextSchema.optional() }).strict()).min(1).max(50).optional(),
  contextMode: z.enum(['app-user', 'anonymous', 'native-background', 'endpoint-credential']).optional(),
  workflow: z.object({ module: z.string().regex(NAME), process: z.string().min(1).max(200).optional() }).strict().optional(),
  launch: z.object({ inputs: z.record(z.string().regex(NAME), z.json()).default({}),
    contextMode: z.literal('app-user').default('app-user') }).strict().optional(),
  // Mounted only: scenarios[].context.screen.inputs are the target screen's inputs, one navigateTo + navigateBack each.
  navigate: navigateSchema.optional(),
  // Mounted only: one journaled trusted click per entry after the lifecycle settles (debug-native-browser-interaction.mjs).
  interactions: interactionsSchema.optional(),
  // native-background only: the ODC Timer is woken once by the original Portal action (no app caller).
  trigger: z.literal('portal-wake').optional(),
  trace: z.enum(['none', 'nodes', 'full']).default('none'),
  depth: z.number().int().min(0).max(4).default(2),
  words: z.string().trim().min(1).max(2000).optional(),
  window: z.object({ around: z.string().regex(KEY).optional(), before: z.number().int().min(0).max(100).optional(), after: z.number().int().min(1).max(1000).optional() }).strict().optional(),
  acknowledgeEffects: z.array(z.string().max(60)).max(20).optional(),
  timeoutSeconds: z.number().int().min(5).max(300).default(90),
  // ODC only: the coordinator holds after each answered scenario and renews the native session on resume.
  holdBetweenScenarios: z.literal(true).optional(),
}).strict().superRefine((v, ctx) => {
  if (['prepare', 'run'].includes(v.op) && !v.action) ctx.addIssue({ code: 'custom', path: ['action'], message: 'action is required for ' + v.op });
  if (v.navigate && v.lifecycle !== 'mounted') ctx.addIssue({ code: 'custom', path: ['navigate'], message: 'navigate requires lifecycle mounted (ODC, inside ssam_debug_client start)' });
  if (v.interactions && v.lifecycle !== 'mounted') ctx.addIssue({ code: 'custom', path: ['interactions'], message: 'interactions require lifecycle mounted (ODC, inside ssam_debug_client start)' });
  if (v.trigger && (v.contextMode !== 'native-background' || v.lifecycle === 'mounted' || v.launch || v.workflow || v.inputs !== undefined ||
      v.scenarios !== undefined || v.context !== undefined))
    ctx.addIssue({ code: 'custom', path: ['trigger'], message: 'portal-wake requires native-background and words; omit launch, workflow, inputs, scenarios and context' });
  if (v.holdBetweenScenarios && (v.lifecycle === 'mounted' || v.launch || v.workflow || v.contextMode === 'native-background'))
    ctx.addIssue({ code: 'custom', path: ['holdBetweenScenarios'], message: 'holdBetweenScenarios requires an isolated original-entry run with a server trace' });
  if (!v.module) ctx.addIssue({ code: 'custom', path: ['module'], message: 'module is required for ' + v.op });
  if (v.scenarios?.length && v.inputs) ctx.addIssue({ code: 'custom', path: ['inputs'], message: 'Give either inputs (one scenario) or scenarios (a batch)' });
  if (v.op === 'run' && v.contextMode === 'native-background' && !v.words)
    ctx.addIssue({ code: 'custom', path: ['words'], message: 'The user authorization words are required for a native background run' });
  if (v.workflow && (v.contextMode !== 'native-background' || !v.launch || v.inputs !== undefined || v.scenarios !== undefined || v.context !== undefined))
    ctx.addIssue({ code: 'custom', path: ['workflow'], message: 'Workflow requires native-background and launch.inputs for the original app-user event emitter; omit target inputs, scenarios and context' });
  if (v.launch && !v.workflow && (v.contextMode !== 'native-background' || Object.keys(v.launch.inputs).length || v.inputs !== undefined || v.scenarios !== undefined || v.context !== undefined))
    ctx.addIssue({ code: 'custom', path: ['launch'], message: 'ODC Timer original launch requires native-background and empty launch.inputs; omit target inputs, scenarios and context' });
});

// ssam_debug_server explicit ODC owners: the consumer's nodes become traceTarget.consumerNodeKeys, used only for the
// library-reference pair (odcBreakpointOwners refuses anything else before sign-in); a foreign owner is refused here.
export function withServerScopeOwners(readers, owners) {
  if (!owners?.length || typeof readers?.traceTarget !== 'function') return readers;
  return { ...readers, traceTarget: async (...args) => {
    const target = await readers.traceTarget(...args);
    if (!target) return target;
    const consumer = readers.binding?.moduleKey, producer = target.producerTarget?.kind === 'library-reference' ? target.producerTarget.producerModuleKey : null;
    if (owners.some(o => o.moduleKey !== consumer && o.moduleKey !== producer)) throw new Error('debug_odc_native_breakpoint_owner_unqualified');
    const consumerNodeKeys = owners.filter(o => o.moduleKey === consumer).flatMap(o => o.nodeKeys);
    return consumerNodeKeys.length ? { ...target, consumerNodeKeys } : target;
  } };
}
async function dispatchNative(raw, services) {
  const input = nativeEntrySchema.parse(raw);
  const native = await import('./debug-odc-native-run.mjs');
  if (input.op === 'status') return native.statusNativeEntry({ tenant: input.tenant, module: input.module });
  // Port D7: a Workflow event or an original Timer launch needs the SC/Portal timer-background file; refuse before any live read.
  const pending = (input.workflow || input.launch) && native.odcBackgroundRunnerPending();
  if (pending) return { ok: false, state: 'entry-unavailable', error: pending };
  const readers = withServerScopeOwners(services.readers ?? await (services.buildNativeReaders ?? buildNativeReaders)(input), services.serverScopeOwners);
  if (input.op === 'prepare') return native.prepareNativeEntry(input, readers);
  // The default adapter starts the private native-runtime worker after preflight.
  return native.runNativeEntry(input, readers, services);
}

// Live model-graph readers from the published revision (Portal download + the lane reader). Live-only: tests inject
// services.readers. Reads nothing when offline.
async function buildNativeReaders(input) {
  const ctx = await context(input);
  const deployed = await P.deployedRevision(ctx.portal, ctx.assetKey, ctx.stage.key);
  if (!Number.isSafeInteger(deployed.revision) || deployed.revision < 1) throw new Error('debug_native_model_not_deployed');
  const dir = path.join(root, 'odc', ctx.portal.host, input.module + '-native-' + Date.now()); fs.mkdirSync(dir, { recursive: true });
  const base = await P.downloadRevision(ctx.portal, ctx.assetKey, deployed.revision, path.join(dir, 'r' + deployed.revision + '.oml'));
  const { inspect } = await import('./lib.mjs');
  const { moduleMap } = await import('./module-map.mjs');
  const { createNativeModelReader } = await import('./debug-native-model.mjs');
  const { acquireOdcNativeAssets, nativeOdcEntryKind } = await import('./debug-odc-native-assets.mjs');
  const producers = new Map();
  const readExternal = async ({ signature, reference }) => {
    const p = reference.properties ?? {}, key = signature.properties?.OriginalKey;
    const library = p.ModuleType === 'ReactiveLibrary', service = signature.kind === 'ServiceActionSignature' && !library;
    const revision = typeof p.Revision === 'string' && /^[1-9][0-9]*$/.test(p.Revision) ? Number(p.Revision) : null;
    // Native ODC app references are not version-locked: HandleRefreshForSpecificVersion
    // clears their Revision. Only libraries require an imported revision; service bodies
    // remain bound to the independently verified deployment below, never an invented import revision.
    if (!KEY.test(p.ModuleKey ?? '') || !KEY.test(key ?? '') || !library && !service ||
      library && !Number.isSafeInteger(revision) || service && p.Revision != null && p.Revision !== '' && !Number.isSafeInteger(revision)) return null;
    // Independently deployed service bodies are never downloaded at the imported
    // signature revision. Qualify their current deployment and original URL first.
    if (service) {
      const id = 'service.' + p.ModuleKey;
      if (!producers.has(id)) producers.set(id, (async () => {
        const { debugAsset, debugApplicationRuntime } = await import('./debug-odc-portal-session.mjs');
        const assetKey = P.assetKeyOf(p.ModuleKey), asset = await debugAsset(ctx.portal, null, { assetKey });
        const current = await P.deployedRevision(ctx.portal, assetKey, ctx.stage.key, { strict: true });
        if (!Number.isSafeInteger(current.revision) || current.revision < 1) return null;
        const runtimeUrl = await debugApplicationRuntime(ctx.portal, ctx.stage, asset, p.ModuleKey,
          { readApplication: moduleKey => ctx.portal.readApplication(moduleKey) });
        if (!runtimeUrl) return null;
        const module = new URL(runtimeUrl).pathname.split('/').filter(Boolean)[0];
        const producer = await P.downloadRevision(ctx.portal, assetKey, current.revision,
          path.join(dir, 'services', p.ModuleKey + '.' + current.revision + '.oml'));
        return { reader: createNativeModelReader({ base: producer, lane: 'odc', inspect, map: moduleMap, readExternal }),
          binding: { tenant: ctx.portal.host, module, moduleKey: p.ModuleKey, app: module,
            environmentKey: ctx.stage.key.toLowerCase(), runtimeUrl, revision: current.revision },
          source: { moduleKey: p.ModuleKey, revision: current.revision, sha256: producer.sha256.toLowerCase(), deployed: true,
            environmentKey: ctx.stage.key.toLowerCase() },
          sourceContract: { path: producer.file, sha256: producer.sha256, revision: current.revision },
          verifyPublication: async () => {
            const observed = await P.deployedRevision(ctx.portal, assetKey, ctx.stage.key, { strict: true });
            if (observed.revision !== current.revision) throw new Error('debug_odc_producer_publication_changed');
          } };
      })());
      const producer = await producers.get(id);
      return producer ? { ...producer, key } : null;
    }
    const id = p.ModuleKey + '.' + revision;
    if (!Number.isSafeInteger(revision)) throw new Error('debug_native_model_producer_revision_invalid');
    if (!producers.has(id)) producers.set(id, (async () => {
      const directory = path.join(dir, 'libraries'); fs.mkdirSync(directory, { recursive: true });
      let producer;
      try { producer = await P.downloadRevision(ctx.portal, P.assetKeyOf(p.ModuleKey), revision, path.join(directory, id + '.oml')); }
      catch (error) {
        if (/^debug_portal_(?:http_(?:403|404):|source_unavailable$)/.test(error.message ?? '')) return null;
        throw error;
      }
      return { reader: createNativeModelReader({ base: producer, lane: 'odc', inspect, map: moduleMap, readExternal }),
        source: { moduleKey: p.ModuleKey, revision, sha256: producer.sha256.toLowerCase() },
        sourceContract: { path: producer.file, sha256: producer.sha256, revision } };
    })());
    const producer = await producers.get(id);
    return producer ? { ...producer, key } : null;
  };
  const readers = createNativeModelReader({ base, lane: 'odc', inspect, map: moduleMap, readExternal, allowImportedTargets: true });
  const binding = { tenant: ctx.portal.host, module: input.module, moduleKey: ctx.moduleKey, app: input.module,
    environmentKey: ctx.stage.key.toLowerCase(), runtimeUrl: ctx.runtimeUrl, revision: deployed.revision };
  // A service app may expose REST callers for internal server actions without
  // any client bundle. Complete local model evidence decides asset acquisition.
  const runtime = await readers.hasClientRuntime() ? await acquireOdcNativeAssets(binding, path.join(dir, 'assets')) : null;
  let workflow;
  if (input.workflow) {
    const workflowContext = await context({ ...input, module: input.workflow.module });
    if (workflowContext.portal.host !== ctx.portal.host || workflowContext.stage.key.toLowerCase() !== binding.environmentKey)
      throw new Error('debug_odc_workflow_environment_mismatch');
    const workflowDeployed = await P.deployedRevision(workflowContext.portal, workflowContext.assetKey, workflowContext.stage.key);
    if (!Number.isSafeInteger(workflowDeployed.revision) || workflowDeployed.revision < 1) throw new Error('debug_odc_workflow_not_deployed');
    const workflowBase = await P.downloadRevision(workflowContext.portal, workflowContext.assetKey, workflowDeployed.revision,
      path.join(dir, 'workflow-r' + workflowDeployed.revision + '.oml'));
    workflow = { binding: { tenant: workflowContext.portal.host, module: input.workflow.module, moduleKey: workflowContext.moduleKey,
      environmentKey: binding.environmentKey, revision: workflowDeployed.revision },
      reader: createNativeModelReader({ base: workflowBase, lane: 'odc', inspect, map: moduleMap }),
      sourceContract: { path: workflowBase.file, sha256: workflowBase.sha256, revision: workflowDeployed.revision },
      verifyPublication: async () => {
        const current = await P.deployedRevision(workflowContext.portal, workflowContext.assetKey, workflowContext.stage.key);
        if (current.revision !== workflowDeployed.revision) throw new Error('debug_odc_workflow_publication_changed');
      } };
  }
  const selectedProducers = new Map();
  return { ...readers, binding, runtime, ...(workflow ? { workflow } : {}),
    clientInspectionModels: async () => {
      // Only version-locked Libraries execute inside this client runtime.
      // Services retain their separate deployment and server inspection binding.
      const libraries = await Promise.all([...producers].filter(([id]) => !id.startsWith('service.')).map(([, value]) => value));
      return libraries.filter(Boolean).map(producer => ({ moduleKey: producer.source.moduleKey, source: producer.sourceContract }));
    },
    inspectionModel: moduleKey => {
      if (moduleKey === binding.moduleKey) return { reader: readers,
        source: { path: base.file, sha256: base.sha256.toLowerCase(), revision: deployed.revision } };
      const target = [...selectedProducers.values()].find(t => t.producerTarget.producerModuleKey === moduleKey);
      return target ? { reader: target.producerReader, source: target.producerTarget.sourceContract } : null;
    },
    resolveTarget: async selector => {
      const { resolveOdcProducerTarget } = await import('./debug-odc-producer-target.mjs');
      const target = await resolveOdcProducerTarget(await readers.resolveTarget(selector), { binding, readExternal,
        sourceContract: { path: base.file, sha256: base.sha256, revision: deployed.revision } });
      if (target?.producerReader) selectedProducers.set(target.key, target);
      return target;
    },
    properties: async selector => {
      const node = await readers.properties(selector);
      return { ...node, nativeEntryKind: runtime ? nativeOdcEntryKind(runtime.index, node.key, node.path) : null };
    },
    prepareEndpoint: async entry => {
      const { acquireNativeRestEntry } = await import('./debug-native-endpoint-acquire.mjs');
      try {
        return await acquireNativeRestEntry({ binding: { ...binding, lane: 'odc', sourceSha256: base.sha256 }, entry,
          readTree: readers.tree, sourceContract: { path: base.file, sha256: base.sha256 } });
      } catch (error) {
        // InternalAccess=Yes is refused from the hash-bound model before any GET: a typed refusal, not a raw error.
        const refusal = (await import('./debug-native-endpoint-worker.mjs')).nativeRestTransportRefusalFromError(error);
        if (refusal) return { refused: refusal };
        throw error;
      }
    },
    verifyPublication: async () => {
      const current = await P.deployedRevision(ctx.portal, ctx.assetKey, ctx.stage.key);
      if (current.revision !== deployed.revision) throw new Error('debug_native_endpoint_publication_changed');
      if (P.sha256(fs.readFileSync(base.file)) !== base.sha256) throw new Error('debug_native_model_source_changed');
      for (const target of selectedProducers.values()) {
        await target.verifyProducerPublication?.();
        const source = target.producerTarget.sourceContract;
        if (P.sha256(fs.readFileSync(source.path)).toLowerCase() !== source.sha256.toLowerCase()) throw new Error('debug_native_model_source_changed');
      }
    },
    traceTarget: async (prepared, window) => {
      const producer = selectedProducers.get(prepared.action.key);
      if (prepared.producerTarget && (!producer || prepared.producerTarget.executable !== true))
        throw new Error(prepared.producerTarget.error ?? 'debug_odc_producer_source_binding_invalid');
      const key = producer?.producerTarget.actionKey ?? prepared.action.key;
      const tree = await (producer?.producerReader ?? readers).tree('@' + key);
      const model = W.actionModel(tree), selected = W.traceWindow(model, window ?? {});
      return { actionKey: key, nodeKeys: selected.entries, steps: selected.steps, scopes: { [key]: W.scopeRoots(model) },
        ...(producer ? { binding: producer.producerTarget.traceBinding, producerTarget: producer.producerTarget } : {}) };
    },
    sourceContract: { path: base.file, sha256: base.sha256, revision: deployed.revision } };
}

// A refused app-user sign-in (thrown by the sign-in or reported by a run) answers DEBUG_APP_USER_SIGN_IN_FAILED with the
// user, provider, environment and next step (debug-guidance.mjs); every other answer passes unchanged.
const repeat = raw => ({ tool: 'ssam_debug_run', arguments: raw });
const signInOf = raw => ({ lane: raw?.lane === 'o11' ? 'o11' : 'odc', runtimeUrl: raw?.runtimeUrl, tenant: raw?.tenant });
const failureOf = (error, raw) => signInFailureOf(error, signInOf(raw), repeat(raw)) ?? { ok: false, error: error.message };

// prepare/status answers advertise the SSAM-imposed input caps of the lane (never a platform limit).
const withInputCapabilities = (result, lane, op) => ['prepare', 'status'].includes(op) && result && typeof result === 'object' && !result.inputCapabilities
  ? { ...result, inputCapabilities: { server: inputCapabilities(lane, 'server'), client: inputCapabilities(lane, 'client') } } : result;
export async function debugRun(raw, { services = {} } = {}) {
  // Read-only lock inventory: never writes, renames, opens DPAPI or contacts a tenant.
  if (raw?.op === 'locks') {
    try { return (await import('./debug-lock-inventory.mjs')).debugLocks(raw, services.root ? { root: services.root } : {}); }
    catch (error) { return { ok: false, error: /^debug_[a-z0-9_:.@-]+$/i.test(error?.message ?? '') ? error.message : 'debug_locks_failed' }; }
  }
  // New executions never create/publish a compatibility wrapper implicitly.
  // Old leases remain addressable with execution=rest-wrapper and release/reconcile.
  if (raw && raw.execution === undefined && ['run', 'prepare', 'status'].includes(raw.op)) raw = { ...raw, execution: 'native-entry' };
  if (raw?.lane !== 'o11' && raw?.execution === 'native-entry') {
    const started = now();
    let result;
    try { result = withSignInFailure(withInputCapabilities(await dispatchNative(raw, services), 'odc', raw.op), signInOf(raw), repeat(raw)); return result; }
    catch (error) { result = failureOf(error, raw); return result; }
    finally { await (services.journal ?? journal)({ start: started, command: raw.op, module: raw.module, outcome: result?.ok ? 'ok' : 'failed-or-uncertain', note: 'native-entry ' + (raw.action ?? '') }); }
  }
  if (raw?.lane === 'o11') {
    const input = o11CoordinatorRunSchema.parse(raw);
    // The public O11 runner re-parses the strict o11RunSchema (foreign); these fields need the server-session runner.
    if (!services.runO11 && (input.trigger || input.contextMode === 'endpoint-credential'))
      return { ok: false, error: 'debug_o11_run_coordinator_field_requires_server_session' };
    try { return withSignInFailure(withInputCapabilities(await (services.runO11 ?? (await import('./debug-o11-run.mjs')).debugO11Run)(input), 'o11', input.op), signInOf(raw), repeat(raw)); }
    catch (error) { const failure = signInFailureOf(error, signInOf(raw), repeat(raw)); if (failure) return failure; throw error; }
  }
  // LEGACY rest-wrapper: every answer carries the notice; refusal codes stay unchanged for callers matching /^debug_/.
  const marked = value => ({ ...value, legacy: legacyNotice('rest-wrapper'),
    ...(value?.ok === false && typeof value.error === 'string' ? { refusal: legacyPrefix('rest-wrapper') + value.error } : {}) });
  const legacy = raw?.execution === 'rest-wrapper' ? Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'execution')) : raw;
  const input = runSchema.parse(legacy), started = now();
  let result;
  try { result = await dispatch(input, services); return marked(result); }
  catch (error) { result = failureOf(error, raw); return marked(result); }
  finally { await (services.journal ?? journal)({ start: started, command: input.op, module: input.module, outcome: result?.ok ? 'ok' : 'failed-or-uncertain', note: input.action ?? null }); }
}

export function parseRunCli(args) {
  const [op, flag, file, ...extra] = args;
  if (!op || flag !== '--request' || !file || extra.length) throw new Error('Usage: ssam debug run|prepare|release|status|authorize|reconcile --request <json-file>');
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  return { ...data, op };
}

export function registerRunTools(server, execute, wrap) {
  server.registerTool('ssam_debug_run', {
    title: 'Debug an ODC or O11 action through its original entry',
    description: DIAGNOSTICS_RULE + ' ' + "Debug ODC/O11 through original published entries. prepare/run/status default to native-entry without wrappers or publication. Caller search, fixed kind priority and model keys choose the nearest entry; overrides must be reachable. Published model hashes and original runtime contracts are required. prepare reports the entry, inputs, effects and capability gaps without executing application logic. run executes scenarios serially. Server stubs, data actions, client/screen actions and individual lifecycle handlers retain their original inputs; handlers report mounted:false and do not render a complete page. ODC lifecycle:'mounted', only inside ssam_debug_client start, mounts the default screen through the original bootstrap in an owned headless browser with pinned published assets: app-user sign-in, inspector configured and started, then one journaled native mount; it requires words (the user's Development authorization) and acknowledgeEffects, takes screen inputs only as the URL query of navigate:{screen:@key,back:true} (one original SDK navigateTo + navigateBack per scenario, full reload refused, Text/Integer/LongInteger inputs) or of an initial deep link to a qualified named route (exactly one scenario), and keeps staticEffectsQualified:false; it reports handlerCoverage {declared,observed,notObserved,absent} from native stop identities and render evidence from a read-only DOM snapshot compared with the session's own native reads; lifecycleComplete and renderVerified are computed from that evidence (with lifecycleIncompleteReasons) and are never set; OnDestroy counts only after that authorized navigation (a stop at or after report.navigation.functionsBefore with completed true); navigation, deep link and this evidence are implemented, live proof pending; a lost mount reply stays uncertain with its lock. run.interactions [{target:'@<widgetKey>'|'<WidgetName>', event:'click'}] (max 10, lifecycle mounted only): after the lifecycle settles, one trusted CDP Input.dispatchMouseEvent click per entry at the DOM.getBoxModel center of the single element whose id the pinned view's idService produces, in the SSAM-owned headless page; hidden, disabled, ambiguous, obscured or unresolved targets are refused; each click is journaled (interaction-submission/-result, wx; the result proves the dispatch only, handlerInvoked null; handlerObserved needs a native stop on the handler) and a lost reply stays uncertain with its lock; the onClick handler closure effects are added to acknowledgeEffects. The original SDK error path (handleError/navigateToErrorPage) is read-only observed even when the error navigation destroys the ready wait (location, ErrorHandlingStorage key names, Page.getNavigationHistory): with a native exception stop (pauseOnExceptions) it is the known failure debug_odc_native_mount_lifecycle_exception with lifecycleException {phase: ready|lifecycle|interaction}; without an exception stop it is debug_odc_native_mount_error_page_observed. handlerCoverage.exceptionHandlers lists .#FlowExceptionHandler stops (global:true for the global OnException). Implemented, live proof pending. Server/library/service targets require an original consumer route; producer values and identity propagation need separate evidence. context supplies declared screen/block inputs or variables, never identity or roles. REST binds the native model to published OpenAPI. O11 Basic uses the private app-user dialog; O11 Custom (published OnAuthentication request headers) and an O11 SOAP WebServiceMethod whose flow reads a literal request header use contextMode endpoint-credential: a private Endpoint Credential dialog, the header sent once as an HTTP header and redacted, never a SOAP envelope header; this context is accepted inside ssam_debug_server (the standalone O11 path refuses it with debug_o11_run_coordinator_field_requires_server_session); WS-Policy/WS-Security WSDLs are refused with debug_native_endpoint_soap_ws_security_unsupported; ODC Custom stays refused (no qualified request-header API inside ODC OnAuthentication, a documented limit of the SSAM evidence); implemented, live proof pending; ODC Basic is refused by SSAM policy, not a platform limit, with debug_native_endpoint_odc_basic_unqualified before any dialog, lock or send, unless its published OnAuthentication qualifies (exactly two native inputs, no credential reads beyond them): qualified ODC Basic and O11 developer-logic Basic use contextMode endpoint-credential with credentialScheme basic (a private Username plus one masked Password, RFC 7617; one Authorization: Basic header composed once and every form redacted); O11 Basic validated by one platform <provider>.User_Login stays app-user; a REST Authentication=None endpoint whose OnRequest or method reads a literal request header uses endpoint-credential with credentialScheme header; credentialScheme is reported in prepare needs and comes only from the published capability (a caller-supplied credentialScheme, header or credential field is refused by the schema); InternalAccess=Yes is refused before any GET with debug_native_endpoint_internal_access_only and platformRestriction:true; client-certificate HttpSecurity (debug_native_endpoint_client_certificate_unsupported) and exposed OAuth2 (debug_native_endpoint_exposed_oauth2_unqualified) are typed refusals; implemented, live proof pending. contextMode defaults to app-user; unauthenticated endpoints require explicit anonymous context. O11 SOAP uses native WebService/WebServiceMethod identity and its original document/literal WSDL. Traditional O11 runs Preparation by requesting its original published screen after original WebForms login. O11 Timer uses original Service Center Run Now or a published REST/SOAP caller of the native WakeTimerAction; inside ssam_debug_server start, trigger:'service-center-run-now' with native-background and words and no launch, inputs, scenarios or context runs one interactive Run Now (implemented, live proof pending). O11 BPT observes AutomaticActivity/ServerAction reached through its original published REST/SOAP LaunchProcess caller; it never invokes an activity body directly. These original background callers require contextMode:native-background, words with user authorization, and launch:{inputs,contextMode:app-user|anonymous}; launch.inputs belongs only to the caller. ODC Timer uses the original Portal wake operation (inside ssam_debug_server start, trigger:'portal-wake' with native-background, words and trace full and no launch, inputs, scenarios, context or workflow binds the scope before any Portal read, fixes an interactive deadline and sends one reserved POST; implemented, live proof pending), or an existing published native WakeTimerAction caller when launch:{inputs:{},contextMode:app-user} is supplied, with the native developer debugger observing the Timer body. Background scheduling and observed function frames do not prove request ownership, instance correlation or execution completion, and do not validate app-user roles; ODC Timer and Workflow runs report ok only with a ThreadEnd bound to the same native request fingerprint, and ODC Timer runs correlate the instance read-only in a separate Portal developer session after the debugger stop (instanceCorrelation, instanceCorrelationProved, executionCompleted, outcome completed|failed|pending, wakeOwnershipProved); implemented, live proof pending. ODC Workflow uses workflow:{module,process?}, with action selecting the original producer ServiceAction and launch.inputs passed to its original app-user event emitter. The published Event Start -> AutomaticActivity -> End contract and imported OriginalKey/module/revision are checked; other workflow launch contracts remain explicit gaps. Fields: lane odc|o11, action name or @key (O11 also native .#Preparation/.#LaunchProcess), inputs or scenarios, trace none|nodes|full, depth 0..4. ODC needs tenant/module and acknowledgeEffects for reported classes; O11 needs host/module/moduleKey/applicationKey/runtimeUrl, with modules for captured producers. Background runs require explicit native-background context and authorization words. Trace verification needs target frames and their terminal thread. DEV only; login, roles and propagation remain distinct proofs. Uncertain executions stop the batch and retain their lock; status never replays. Credentials stay in the private dialog. prepare and status answers carry inputCapabilities {server, client}: the SSAM-imposed per-lane caps (maxBinaryInputBytes, maxTextBytes, maxScenarioInputBytes) and their refusal codes; these are SSAM limits, not OutSystems limits. holdBetweenScenarios:true (ODC isolated original-entry runs with a server trace, inside ssam_debug_server start only) holds after each answered scenario until resume and renews the native session; implemented, live proof pending. " + (roleCyclePending() ? "roleCycle {roleKey, words} (one ODC application role around ssam_debug_server/ssam_debug_client starts) " + ROLE_CYCLE_UNAVAILABLE + "; " : "roleCycle {roleKey, words} grants one ODC application role around ssam_debug_server/ssam_debug_client starts and restores it; implemented, live proof pending; ") + "ssam_debug_run itself refuses roleCycle. op 'locks' (lane optional) returns the read-only debugger lock inventory: per lock path, sha256, owner fields, receipts with sha256, class, reason, reconciler and missing evidence, plus blockedBindings; it never writes, renames, opens DPAPI or contacts a tenant. " + legacyNotice('rest-wrapper') + " Live coverage and restrictions: docs/DEBUGGER-HEADLESS-FALTA.md.",
    inputSchema: debugRunToolSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, wrap(execute));
}
