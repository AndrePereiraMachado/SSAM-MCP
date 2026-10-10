// ssam_debug_run / `ssam debug run`: run an ODC or O11 action with chosen inputs and native app identity.
// execution=native-entry (both lanes, the path for new work) is dispatched at the end of this file: the code resolves the
// nearest public entry deterministically and publishes nothing. What follows first is the LEGACY ODC REST wrapper path,
// kept as it was and not extended:
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
  as: z.object({ user: z.string().max(200).nullable().optional(), roles: z.record(z.string().regex(NAME), z.boolean()).optional() }).strict().optional() }).strict();
export const debugRunToolSchema = z.object({
  op: z.enum(['run', 'prepare', 'release', 'status', 'authorize', 'reconcile']),
  lane: z.enum(['odc', 'o11']).optional(),
  tenant: z.string().min(3).max(200).optional(),
  host: z.string().min(3).max(200).optional(),
  module: z.string().regex(NAME).optional(),
  moduleKey: z.string().regex(KEY).optional(),
  applicationKey: z.string().regex(KEY).optional(),
  runtimeUrl: z.string().url().optional(),
  execution: z.enum(['rest-wrapper', 'native-entry']).optional(),
  nativeEntry: z.object({ sourceContract: z.object({ path: z.string().min(1).max(2000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict().optional(),
  action: z.string().min(1).max(200).optional(),
  operationId: z.uuid().optional(),
  inputs: z.record(z.string().regex(NAME), z.json()).optional(),
  scenarios: z.array(looseScenario).max(50).optional(),
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
  const stage = portal.tenant.stages?.Development;
  if (!stage?.key || !stage?.domain) throw new Error('debug_development_stage_unknown: tenants.json needs stages.Development.key/domain for ' + portal.host);
  const list = await portal.read('asset-repository-api-v1:get:/assets', { query: { nameContains: input.module, limit: 50 } });
  const row = (list?.results ?? (Array.isArray(list) ? list : [])).find(a => a.name === input.module);
  if (!row) throw new Error('debug_asset_not_found: ' + input.module);
  const assetKey = row.assetKey ?? row.applicationKey ?? row.key; // seen live: {page, results:[{assetKey, name, revision, ...}]}
  if (!assetKey) throw new Error('debug_asset_key_missing: ' + input.module);
  return { portal, stage, assetKey, moduleKey: moduleKeyOf(assetKey), runtimeUrl: `https://${stage.domain}/${input.module}/` };
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
  tenant: z.string().min(3).max(200),
  module: z.string().regex(NAME).optional(),
  action: z.string().min(1).max(200).optional(),
  entry: z.string().min(1).max(200).optional(), // override only; must be a verified caller on the graph
  inputs: z.record(z.string().regex(NAME), z.json()).optional(),
  scenarios: z.array(z.object({ name: z.string().max(80).optional(), inputs: z.record(z.string().regex(NAME), z.json()).default({}) }).strict()).min(1).max(50).optional(),
  trace: z.enum(['none', 'nodes', 'full']).default('none'),
  window: z.object({ around: z.string().regex(KEY).optional(), before: z.number().int().min(0).max(100).optional(), after: z.number().int().min(1).max(1000).optional() }).strict().optional(),
  acknowledgeEffects: z.array(z.string().max(60)).max(20).optional(),
  timeoutSeconds: z.number().int().min(5).max(300).default(90),
}).strict().superRefine((v, ctx) => {
  if (['prepare', 'run'].includes(v.op) && !v.action) ctx.addIssue({ code: 'custom', path: ['action'], message: 'action is required for ' + v.op });
  if (!v.module) ctx.addIssue({ code: 'custom', path: ['module'], message: 'module is required for ' + v.op });
  if (v.scenarios?.length && v.inputs) ctx.addIssue({ code: 'custom', path: ['inputs'], message: 'Give either inputs (one scenario) or scenarios (a batch)' });
});

async function dispatchNative(raw, services) {
  const input = nativeEntrySchema.parse(raw);
  const native = await import('./debug-odc-native-run.mjs');
  if (input.op === 'status') return native.statusNativeEntry({ tenant: input.tenant, module: input.module });
  const readers = services.readers ?? await (services.buildNativeReaders ?? buildNativeReaders)(input);
  if (input.op === 'prepare') return native.prepareNativeEntry(input, readers);
  // run is live: it needs the secure login window and one session per binding (HARD RULES forbid it in this build).
  return native.runNativeEntry(input, readers, { worker: services.worker, login: services.login });
}

// Live model-graph readers from the published revision (Portal download + the lane reader). Live-only: tests inject
// services.readers. Reads nothing when offline.
async function buildNativeReaders(input) {
  const ctx = await context(input);
  const latest = await P.latestRevision(ctx.portal, ctx.assetKey), deployed = await P.deployedRevision(ctx.portal, ctx.assetKey, ctx.stage.key);
  if (latest.revision !== deployed.revision) throw new Error(`debug_odc_native_development_not_at_latest: latest ${latest.revision}, Development runs ${deployed.revision}`);
  const dir = path.join(root, 'odc', ctx.portal.host, input.module + '-native-' + Date.now()); fs.mkdirSync(dir, { recursive: true });
  const base = await P.downloadRevision(ctx.portal, ctx.assetKey, deployed.revision, path.join(dir, `r${deployed.revision}.oml`));
  const { inspect } = await import('./lib.mjs');
  const rd = async opts => { const r = await inspect({ target: base.file, expectedSourceSha256: base.sha256, budget: 1000000, ...opts }); return r.entries ? r : (r.ok && r.out ? read(r.out) : r); };
  const propsOfPath = async p => { const r = await rd({ path: p, depth: 0, all: true }); const t = r.tree ?? null; return t ? { key: t.key, kind: t.kind, public: t.properties?.Public === 'True', properties: t.properties } : null; };
  const inputsOfPath = async p => { const r = await rd({ path: p, depth: 1, max: 300 }); const t = r.tree; return (t?.children ?? []).filter(c => c.kind === 'InputParameter').map(c => ({ name: c.properties?.Name, key: c.key, dataType: (c.properties?.DataType ?? '').split(':').pop(), mandatory: c.properties?.IsMandatory === 'True' })); };
  const usagesOfKey = async key => { const r = await rd({ path: '@' + key, usages: true, scope: 'direct', depth: 1, max: 300 }); return (r.entries ?? []).map(e => ({ consumer: e.consumer })); };
  const resolveTarget = async nameOrKey => {
    for (const kind of ['ServerAction', 'ServiceAction', 'ClientAction', 'DataAction']) {
      const selector = /^[A-Za-z0-9_+]{22}$/.test(nameOrKey) ? '@' + nameOrKey : `${kind}:${nameOrKey}`;
      const r = await rd({ path: selector, depth: 3, max: 500, full: true }); const t = r.tree;
      if (t) return { key: t.key, name: t.properties?.Name ?? nameOrKey, kind: t.kind, path: t.path ?? selector,
        inputs: (t.children ?? []).filter(c => c.kind === 'InputParameter').map(c => ({ name: c.properties?.Name, key: c.key, dataType: (c.properties?.DataType ?? '').split(':').pop(), mandatory: c.properties?.IsMandatory === 'True' })),
        closureCalls: (t.children ?? []).filter(c => c.kind === 'ExecuteServerActionNode').map(c => ({ kind: c.kind, action: c.properties?.Action, actionKind: c.propertyReferences?.Action?.kind, external: /^Reference:/.test(c.properties?.Action ?? '') })) };
    }
    return null;
  };
  // Synchronous facade over the async readers: the graph BFS is async-unaware, so prefetch lazily via a cache the
  // readers fill. buildModelGraph calls these as sync; we memoize with a resolved-promise barrier.
  return { binding: { tenant: ctx.portal.host, module: input.module, app: input.module, runtimeUrl: ctx.runtimeUrl },
    async: true, resolveTarget, properties: propsOfPath, usages: usagesOfKey, inputs: inputsOfPath, argumentsOf: () => null,
    sourceContract: { path: base.file, sha256: base.sha256, revision: deployed.revision } };
}

// A refused app-user sign-in (thrown by the sign-in or reported by a run) answers DEBUG_APP_USER_SIGN_IN_FAILED with the
// user, provider, environment and next step (debug-guidance.mjs); every other answer passes unchanged.
const repeat = raw => ({ tool: 'ssam_debug_run', arguments: raw });
const signInOf = raw => ({ lane: raw?.lane === 'o11' ? 'o11' : 'odc', runtimeUrl: raw?.runtimeUrl, tenant: raw?.tenant });
const failureOf = (error, raw) => signInFailureOf(error, signInOf(raw), repeat(raw)) ?? { ok: false, error: error.message };

export async function debugRun(raw, { services = {} } = {}) {
  if (raw?.lane !== 'o11' && raw?.execution === 'native-entry') {
    const started = now();
    let result;
    try { result = withSignInFailure(await dispatchNative(raw, services), signInOf(raw), repeat(raw)); return result; }
    catch (error) { result = failureOf(error, raw); return result; }
    finally { await (services.journal ?? journal)({ start: started, command: raw.op, module: raw.module, outcome: result?.ok ? 'ok' : 'failed-or-uncertain', note: 'native-entry ' + (raw.action ?? '') }); }
  }
  if (raw?.lane === 'o11') {
    const input = o11RunSchema.parse(raw);
    try { return withSignInFailure(await (services.runO11 ?? (await import('./debug-o11-run.mjs')).debugO11Run)(input), signInOf(raw), repeat(raw)); }
    catch (error) { const failure = signInFailureOf(error, signInOf(raw), repeat(raw)); if (failure) return failure; throw error; }
  }
  const input = runSchema.parse(raw), started = now();
  let result;
  try { result = await dispatch(input, services); return result; }
  catch (error) { result = failureOf(error, raw); return result; }
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
    title: 'Debug an ODC or O11 action with chosen inputs as the app user',
    description: DIAGNOSTICS_RULE + ' Runs an ODC or O11 action with chosen typed inputs as the signed-in app user. Use execution=native-entry for new work: no wrapper and nothing published; the action is reached through an ORIGINAL entry of the published app. The code chooses that entry deterministically, never the model: a breadth-first search over the callers of the target in the static call graph of the published model (distance = call edges), ties broken by a fixed entry-kind priority and then model key ascending, so the same model and target always give the same entry, call path and bindings. entry is only an override and is refused unless it is a verified caller on that graph. A target no public entry reaches answers "dead code: no public entry reaches <action>" and nothing runs. op=prepare (no login): entry, distance, callPath, path, bindings of each target input (direct/fixed/derived/default/opaque), typed scenario validation, effects and needs. op=run: one native English App User Sign In window, then each scenario through the original entry with typed outputs, a classified exception and the duration; trace=nodes adds visited nodes, trace=full also variables, where the lane observes them; window {around, before, after} bounds a server trace. op=status lists receipts. Fields: action (name or @key; O11 also Module.Name), scenarios 1..50 [{name, inputs}] or inputs, trace none|nodes|full. Typed inputs: Text, Integer, Long Integer and Decimal (as strings), Boolean, Date, Time, Date Time, Identifier, Record, RecordList, null; private names are refused. ODC: tenant and module; acknowledgeEffects must list the effect classes prepare reports (entity-write, external-http, ...) before a run. ODC run answers needs-live with the exact live plan until its live execution worker lands. O11: host/module/moduleKey/applicationKey/runtimeUrl; modules adds producer/consumer modules to the graph; server stubs, data actions and client actions run, REST methods, timers and processes are resolved only; the worker is proven offline, the live run is pending; a server trace is refused on blocked bindings; across modules it runs on the producer only when the target runs in the producer process (reached through a service action), with the consumer app user used only for redaction. Every run assumes a DEV environment: a breakpoint on the entry may also catch another user request on the same action. One live run per binding; uncertain calls are never resent. Credentials only in the sign-in window, never in arguments or chat; private values are filtered. Legacy, kept and not extended: execution=rest-wrapper (the ODC default when execution is omitted; it publishes an SSAM Debug REST wrapper with op=authorize/release/reconcile, keep, idleMinutes, words, around/before/after/depth and trace all|none) and the O11 nativeEntry {sourceContract} single zero-input Refresh entry.',
    inputSchema: debugRunToolSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, wrap(execute));
}
