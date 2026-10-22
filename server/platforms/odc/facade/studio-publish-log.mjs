// Publish errors of the ODC Studio, visible to the model: the last publication of a module in the running ODC Studio,
// whoever started it (the person, studio_publish, studio_create_app), and the refusal of studio_publish, both carrying
// every message (type, text, element, stage) and a continuation that says what to fix. The shape and the fix rule are
// shared with the Portal operations (portal/runtime/operation-log.mjs); the native source is the bridge's publish-log
// (studio/bridge/PublishLogCommands.cs: the Studio's server messages pane of the Publish ServerProcess).
// The bridge call is a dependency: tests pass fakes, nothing here opens a pipe.
// studio_publish {module} (2026-10-06): a session asked to publish after a delivery had to list the lab folders to find
// the manifest. The manifest of the module's last SSAM merge comes from the evidence the deliveries left (lab/<NN-name>/
// [delivery/]manifest.json, and in its evidenceDir the bridge's merge-started.json and receipt.json), in this ODC Studio
// and tenant; a merge that was not clean, one already published, one made in another Studio process, or an open module
// that changed since are refused before anything, with the exact next call.
import fs from 'node:fs';
import path from 'node:path';
import { fixContinuation } from '../portal/runtime/operation-log.mjs';
import { resolveOpenModule } from './studio-module.mjs';
import { hashedWords, wordsGiven, wordsRequired } from './destructive-operations.mjs';
import { recordPublished, recordPublicationEnded, publicationOpen } from './producer-signatures.mjs';
import { mergeState, reconcilable, reconcileCall } from './merge-reconcile.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// value: the bridge answer of `publish-log [<Module>]`. A finished log with errors gets the fix continuation; a running
// publication the wait; a module with no publication in this Studio the Portal read of its publish operations. The
// publication key the Studio polled, when found, adds the same messages from the Portal (stepId and time of each).
export function shapePublishLog(value) {
  if (!isObject(value) || value.ok !== true) return value;
  if (value.found === false) return { ...value, continuation: { tool: 'odc_read',
    arguments: { operationId: 'deployments-api-v1:get:/publish-operations', query: { assetKey: '<asset key of ' + (value.module ?? 'the app') + '>', limit: 5 } },
    why: 'no publication of this module in this Studio session: the ones made elsewhere are in the publish-operations of the Portal; then odc_operation_status {kind:"publish", operationKey, messages:true}' } };
  const lp = value.lastPublish;
  if (!isObject(lp)) return value;
  const extra = lp.publicationKey ? { serverLog: { tool: 'odc_operation_status', arguments: { kind: 'publish', operationKey: lp.publicationKey, messages: true },
    why: 'the same messages straight from the Portal, with the stepId and the time of each' } } : {};
  if (lp.running) return { ...value, ...extra, continuation: { tool: 'studio_wait', arguments: { condition: 'published', module: value.module },
    why: 'the publication is still running; wait and read the log again (studio_command publish-log)' } };
  const fix = fixContinuation({ module: value.module, messages: Array.isArray(lp.messages) ? lp.messages : [], failed: lp.failed === true });
  return { ...value, ...extra, ...(fix ? { continuation: fix } : {}) };
}

// studio_command {command:"publish-log", args:[<Module>?, "--no-resolve"?]}.
export async function studioPublishLog(args = [], pid, { studio }) {
  return shapePublishLog(await studio(['publish-log', ...args], pid));
}

// A refused studio_publish carries every message. The bridge (v35) answers a publication that ended without success with
// publishLog (its publish-log); an answer without it (an older bridge) asks publish-log once for the module of the
// manifest. A refusal before the dispatch (authorization, receipt, validation) had no publication and passes unchanged.
const AFTER_DISPATCH = /Publication of .+ (ended in state|is still running)/;
export function publishRefusal(value, log) {
  if (!isObject(log) || log.ok !== true) return value;
  const shaped = shapePublishLog(log);
  const lp = isObject(shaped.lastPublish) ? shaped.lastPublish : {};
  const { publishLog, ...rest } = value;
  return { ...rest, code: /still running/.test(String(value.error)) ? 'PUBLISH_RUNNING' : 'PUBLISH_FAILED', summary: lp.summary ?? null,
    publishLog: { module: shaped.module, moduleKey: shaped.moduleKey, ...lp },
    ...(shaped.serverLog ? { serverLog: shaped.serverLog } : {}), ...(shaped.continuation ? { continuation: shaped.continuation } : {}) };
}
// ---- studio_publish {module}: the manifest of the module's last merge, from the delivery evidence.
const readJsonOrNull = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const at = value => { const t = Date.parse(value ?? ''); return Number.isFinite(t) ? t : 0; };

// Every merge the bridge started from a manifest under lab/, newest first: {dir, manifest, document, evidence, started}.
// A delivery refused before the merge left no merge-started.json and changed nothing, so it is not a merge.
export function deliveryMerges(lab, { root = path.dirname(lab), module, moduleKey } = {}) {
  let dirs = [];
  try { dirs = fs.readdirSync(lab, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(lab, e.name)); } catch { return []; }
  const out = [];
  for (const dir of dirs) for (const manifest of [path.join(dir, 'delivery', 'manifest.json'), path.join(dir, 'manifest.json')]) {
    const document = readJsonOrNull(manifest);
    if (!isObject(document) || document.create === true) continue;
    if (!(moduleKey && document.moduleKey ? document.moduleKey === moduleKey : same(document.module, module))) continue;
    const declared = document.evidenceDir ?? document.EvidenceDir;
    const evidence = declared ? path.resolve(root, declared) : path.join(path.dirname(manifest), 'evidence');
    const started = readJsonOrNull(path.join(evidence, 'merge-started.json'));
    if (!isObject(started)) continue;
    out.push({ dir, manifest, document, evidence, started });
  }
  return out.sort((a, b) => at(b.started.at) - at(a.started.at) || b.dir.localeCompare(a.dir));
}

// The delivery a merge came from, again over the module as it is now: the same job, owners and changes (a kernel job), or
// the same C# feature, with publish:true. A job already in the module is refused by the kernel before any change.
function deliverAgain(merge, module, pid, why) {
  const result = readJsonOrNull(path.join(merge.dir, 'deliver-result.json'));
  const job = typeof result?.job === 'string' ? result.job : null;
  const feature = merge.document.feature ?? result?.feature ?? '<Feature>';
  const owners = Array.isArray(merge.document.owners) && merge.document.owners.length ? merge.document.owners : ['<Owner>'];
  const changes = Array.isArray(merge.document.changes) && merge.document.changes.length ? merge.document.changes : ['<Change>'];
  return { tool: 'studio_deliver', arguments: { feature, module, ...(job ? { job, owners, changes } : {}), publish: true, ...(Number.isInteger(pid) ? { pid } : {}) },
    why: why + ' authorize: the user\'s own words (or the standing grant of the app). NO_CHANGE means the change is already in the module: the person publishes it in the Studio.' };
}
const publishLogRead = (module, pid, why) => ({ tool: 'studio_command', arguments: { command: 'publish-log', args: [module], ...(Number.isInteger(pid) ? { pid } : {}) }, why });
const evidenceRead = (file, why) => ({ tool: 'ssam_evidence', arguments: { file }, why });
const refused = (code, error, continuation, extra = {}) => ({ ok: false, code, executed: false, error, ...extra, continuation });

// {module, pid} -> {ok:true, manifest, module, resolvedFrom} | a refusal. deps: studio (the bridge call), lab (the lab
// folder), root (where relative evidence paths resolve), catalog() (the asset catalog, for app names), reconcile (merge-
// reconcile.mjs reconcileMerge with the kernel's content proof; absent: read only, the refusal names the explicit call).
// A merge is clean when its receipt is strict or normalized, or when the SSAM proved it (merge-reconcile.mjs): a merge that
// is not clean and has no known losses is reconciled here first, in the same Studio process, never merged again.
export async function resolveDeliveryManifest({ module, pid } = {}, { studio, lab, root, catalog = () => null, reconcile = null }) {
  const status = await studio(['status'], pid);
  if (!isObject(status) || status.ok === false || !Array.isArray(status.modules)) return isObject(status) && status.ok === false ? status
    : refused('STUDIO_STATUS_UNAVAILABLE', 'The ODC Studio did not list its open modules; nothing was published.', { tool: 'studio_status', arguments: { view: 'brief', ...(Number.isInteger(pid) ? { pid } : {}) }, why: 'which modules are open in this Studio' });
  const open = resolveOpenModule(module, { open: status.modules.map(m => ({ name: m?.name, key: m?.key })), catalog: catalog() });
  if (!open.ok) return { ...open, executed: false };
  const entry = status.modules.find(m => m?.name === open.module) ?? {};
  const name = entry.name ?? open.module;
  const all = deliveryMerges(lab, { root, module: name, moduleKey: entry.key });
  // The same tenant: a merge of a module with the same key in another tenant is another asset.
  const merges = entry.host ? all.filter(m => !m.document.tenant || same(m.document.tenant, entry.host)) : all;
  if (!merges.length) return refused('NO_DELIVERY_TO_PUBLISH', 'No SSAM delivery merged ' + name + (entry.host ? ' in ' + entry.host : '') + '; nothing was published. SSAM publishes only a merge it verified.',
    { tool: 'studio_deliver', arguments: { feature: '<Feature>', module: name, job: { ops: ['<ops from ssam_discover>'] }, owners: ['<Owner>'], changes: ['<Change>'], publish: true, ...(Number.isInteger(pid) ? { pid } : {}) },
      why: 'deliver and publish in one call, with the user\'s words in authorize (or the standing grant of the app); a manifest from elsewhere is published with studio_publish {manifest}' }, { module: name });
  const last = merges[0];
  const from = { manifest: last.manifest, evidence: last.evidence, mergedAt: last.started.at ?? null };
  const otherStudio = Number.isInteger(last.started.pid) && Number.isInteger(status.pid) && last.started.pid !== status.pid;
  const state = mergeState(last.evidence);
  if (!state.clean) {
    const outcome = state.outcome;
    const notClean = (continuation, extra = {}) => refused('LAST_DELIVERY_NOT_CLEAN', 'The last SSAM merge of ' + name + ' (' + path.basename(last.dir) + ') is ' + outcome + ', not a clean merge'
      + (extra.reconciliation ? ' and its content was not proven (' + extra.reconciliation.code + ': ' + extra.reconciliation.error + ')' : '') + '; nothing was published.', continuation, { module: name, outcome, resolvedFrom: from, ...extra });
    if (outcome === 'incomplete') {
      const result = readJsonOrNull(path.join(last.dir, 'deliver-result.json'));
      return notClean(isObject(result?.continuation) ? result.continuation : evidenceRead(path.join(last.evidence, 'incomplete-receipt.json'),
        'the last merge of ' + name + ' kept known losses: its repair job is the next delivery; never publish or merge again blindly'));
    }
    // The merge ran (merge-started.json) but nothing proved it equal to the candidate: the SSAM proves it now, in the
    // Studio process that merged it, or the refusal names the one explicit call that does (never a dead end).
    if (otherStudio) return refused('DELIVERY_IN_OTHER_STUDIO', 'The last SSAM merge of ' + name + ' was made in another ODC Studio process (pid ' + last.started.pid + '); the module open in this one (pid ' + status.pid + ') is not what SSAM merged. Nothing was published.',
      deliverAgain(last, name, pid, 'the same delivery in this Studio captures the module as it is now and publishes after a clean merge;'), { module: name, resolvedFrom: from });
    if (typeof reconcile !== 'function' || !reconcilable(state)) return notClean(reconcileCall(name, pid));
    const reconciled = await reconcile({ merge: last, module: name, pid }, { next: why => deliverAgain(last, name, pid, why + ';') });
    if (reconciled?.ok !== true) {
      const { continuation, then, reconciliation } = reconciled ?? {};
      return notClean(continuation ?? reconcileCall(name, pid), { reconciliation: { code: reconciled?.code ?? 'RECONCILE_FAILED', error: reconciled?.error ?? 'no answer', ...(isObject(reconciliation) ? reconciliation : {}) }, ...(then ? { then } : {}) });
    }
    from.reconciliation = reconciled.reconciliation ?? { accepted: true };
  }
  const publishReceipt = readJsonOrNull(path.join(last.evidence, 'publish-receipt.json'));
  if (publishReceipt?.ok === true)
    return refused('ALREADY_PUBLISHED', 'The last SSAM merge of ' + name + ' (' + path.basename(last.dir) + ') is already published; nothing was published again.',
      publishLogRead(name, pid, 'the last publication of the module in this Studio, whoever started it'), { module: name, resolvedFrom: from,
        lastPublication: { at: publishReceipt.completedAt ?? null, status: 'succeeded', version: publishReceipt.published?.revision ?? null, author: null, by: 'ssam', source: 'publish-receipt' } });
  if (fs.existsSync(path.join(last.evidence, 'publish-started.json')))
    return refused('PUBLISH_ALREADY_REQUESTED', 'A publication of the last SSAM merge of ' + name + ' was already requested' + (publishReceipt ? ' and did not succeed' : '') + '; it is never requested twice from one delivery.',
      publishLogRead(name, pid, publishReceipt ? 'the messages say what to fix; the fix is a new delivery, which publishes in the same call' : 'how that publication ended, before anything else'), { module: name, resolvedFrom: from });
  // The same Studio process: the merge's own pid against the Studio this call reaches.
  if (Number.isInteger(last.started.pid) && Number.isInteger(status.pid) && last.started.pid !== status.pid)
    return refused('DELIVERY_IN_OTHER_STUDIO', 'The last SSAM merge of ' + name + ' was made in another ODC Studio process (pid ' + last.started.pid + '); the module open in this one (pid ' + status.pid + ') is not what SSAM verified. Nothing was published.',
      deliverAgain(last, name, pid, 'the same delivery in this Studio captures the module as it is now and publishes after a clean merge;'), { module: name, resolvedFrom: from });
  return { ok: true, manifest: last.manifest, module: name, resolvedFrom: from, merge: last };
}

// Round 3 (review C:\t\revisoes\unpublished-lib-2, N2): whether studio_publish {module} would take the module now, read only:
// the status and the lab evidence resolveDeliveryManifest reads (NO_DELIVERY_TO_PUBLISH, LAST_DELIVERY_NOT_CLEAN,
// ALREADY_PUBLISHED, PUBLISH_ALREADY_REQUESTED, DELIVERY_IN_OTHER_STUDIO), then the bridge's own dispatch check against the
// hash of the open module the caller captured (openSha256): it must equal the merge receipt's (MODULE_CHANGED_SINCE_DELIVERY).
// Nothing is written. -> {ok:true, manifest} | {ok:false, code, error}.
export async function publishPrecheck({ module, pid, openSha256 = null } = {}, { studio, lab, root, catalog = () => null }) {
  let target;
  try { target = await resolveDeliveryManifest({ module, pid }, { studio, lab, root, catalog }); }
  catch (error) { return { ok: false, code: 'PUBLISH_PRECHECK_FAILED', error: 'the delivery evidence of ' + module + ' could not be read (' + error.message + ')' }; }
  // Round 4 (N4): the handler's own continuation goes with its refusal (read the receipt, the publish log, the status).
  if (target?.ok !== true) return { ok: false, code: target?.code ?? 'STUDIO_STATUS_UNAVAILABLE', error: target?.error ?? 'studio_publish would refuse ' + module,
    ...(target?.continuation && typeof target.continuation === 'object' ? { continuation: target.continuation } : {}) };
  const receipt = readJsonOrNull(path.join(target.merge.evidence, 'receipt.json'));
  if (receipt?.created === true) return { ok: true, manifest: target.manifest };
  const expected = typeof receipt?.sha256 === 'string' && receipt.sha256 ? receipt.sha256 : null;
  if (!expected || !openSha256 || expected.toLowerCase() !== String(openSha256).toLowerCase())
    return { ok: false, code: 'MODULE_CHANGED_SINCE_DELIVERY', error: 'The module ' + module + ' open in the Studio ' + (openSha256 ? 'differs from' : 'could not be compared with') + ' its last SSAM merge ('
      + path.basename(target.merge.dir) + '): an edit in the Studio, a reference refresh or another merge since; SSAM publishes only what it verified.' };
  return { ok: true, manifest: target.manifest };
}

// The bridge's own check at the dispatch (StartupHook.cs PublishDispatch): the open module must hash to the merge receipt.
const CHANGED = /Open module differs from the merged receipt/;
function changedSinceDelivery(value, merge, module, pid) {
  if (!isObject(value) || value.ok !== false || !CHANGED.test(String(value.error ?? ''))) return value;
  return { ...value, code: 'MODULE_CHANGED_SINCE_DELIVERY', executed: false,
    error: 'The module open in the Studio changed after the SSAM merge of this delivery (an edit in the Studio, a reference refresh or another merge); SSAM publishes only what it verified. Nothing was published.',
    continuation: merge ? deliverAgain(merge, module, pid, 'a new delivery captures the module as it is now and publishes after a clean merge;')
      : { tool: 'studio_status', arguments: { view: 'brief', ...(Number.isInteger(pid) ? { pid } : {}) }, why: 'the open module changed after the merge of this manifest: deliver again (studio_deliver publish:true), or the person publishes in the Studio' } };
}

// studio_publish (C08, I6): manifest, or module (the manifest of its last clean merge, above). The user's words in
// authorize are recorded in the manifest first (the bridge's authorize); without them the manifest's recorded words, else
// the standing grant of its app, recorded the same way; the answer says which (authorization) and carries lastPublication
// (section 3) from the receipt, or from the log of a publication that did not succeed. Without words and without a grant
// the bridge refuses as before. deps.grants: tests pass a fake; absent, ./standing-grants.mjs if present.
export async function publishWithGrant({ manifest, module: requested, authorize, wait = true, minutes = 10, pid, reconcile: reconcileOnly = false } = {}, deps) {
  const { studio, readManifest, grants, publish = publishWithLog, lab, root, catalog, reconcile = null } = deps;
  if ((manifest == null) === (requested == null) || (reconcileOnly === true && requested == null))
    return refused('PUBLISH_TARGET', manifest == null ? 'studio_publish needs module (the open module) or manifest' : reconcileOnly === true ? 'studio_publish {reconcile:true} takes module, not manifest' : 'studio_publish takes module or manifest, not both',
      { tool: 'studio_publish', arguments: { module: requested ?? '<Module>', ...(reconcileOnly === true ? { reconcile: true } : {}), ...(Number.isInteger(pid) ? { pid } : {}) }, why: 'module finds the manifest of its last clean SSAM merge' });
  let target = null;
  if (requested != null) {
    // reconcile:true without the content proof of this SSAM: the refusal says so, it never marks anything clean.
    if (reconcileOnly === true && typeof reconcile !== 'function')
      return refused('RECONCILE_PROOF_UNAVAILABLE', 'This SSAM has no content proof to reconcile a merge; nothing was written.', { tool: 'ssam_doctor', arguments: {}, why: 'the ODC lane of this SSAM must offer anvil-odc content-proof' });
    target = await resolveDeliveryManifest({ module: requested, pid }, { studio, lab, root, catalog, reconcile });
    if (target.ok !== true) return target;
    manifest = target.manifest;
    // The explicit reconciliation (merge-reconcile.mjs): captured, proven and recorded; the publication is the next call.
    if (reconcileOnly === true) {
      const state = mergeState(target.merge.evidence);
      return { ok: true, executed: true, publishInvoked: false, module: target.module, reconciled: !!target.resolvedFrom.reconciliation, outcome: state.outcome,
        resolvedFrom: target.resolvedFrom, receipt: path.join(target.merge.evidence, 'receipt.json'),
        continuation: { tool: 'studio_publish', arguments: { module: target.module, ...(Number.isInteger(pid) ? { pid } : {}) },
          why: 'the last merge of ' + target.module + ' is clean (' + state.outcome + '); publishing needs the user\'s words in authorize or the standing grant of the app' } };
    }
  }
  let recorded = null, module = null, tenant = null;
  try { const m = readManifest(manifest); module = m?.module ?? null; tenant = typeof m?.tenant === 'string' && m.tenant ? m.tenant : null; recorded = typeof m?.publishAuthorization === 'string' && m.publishAuthorization.trim() ? m.publishAuthorization : null; }
  catch { /* the bridge reads the manifest itself and refuses what it cannot read */ }
  let authorization = null;
  // CX15 r6 (M-1): words that are a marker, a <template> or a sha256 of the server are refused, before anything.
  if (typeof authorize === 'string' && authorize.trim() && !wordsGiven(authorize)) return wordsRequired([{ path: 'authorize', value: authorize }], { tool: 'studio_publish' });
  if (typeof authorize === 'string' && authorize.trim()) {
    // CX15 r5 (N-2): the manifest, the bridge evidence and the answer keep sha256:<hex> of the words, never the words.
    const written = await studio(['authorize', manifest, 'publish', hashedWords(authorize.trim())], pid);
    if (written?.ok !== true) return { ok: false, code: 'PUBLISH_AUTHORIZATION_FAILED', error: written?.error ?? 'authorize refused', authorization: { source: 'words' } };
    authorization = { source: 'words' };
  } else if (!recorded && module) {
    const { publishAuthorization } = await import('./kernel-delivery.mjs');
    const found = await publishAuthorization({ module }, grants !== undefined ? grants : await import('./standing-grants.mjs').catch(() => null));
    if (found?.authorization?.source === 'standing-grant') {
      const written = await studio(['authorize', manifest, 'publish', hashedWords(found.words)], pid);
      if (written?.ok !== true) return { ok: false, code: 'PUBLISH_AUTHORIZATION_FAILED', error: written?.error ?? 'authorize refused', authorization: found.authorization };
      authorization = found.authorization;
    }
  } else if (recorded) authorization = { source: 'words' };
  // CX15 r7 (M-3, SA-1): no words, no recorded authorization and no standing grant: WORDS_REQUIRED, and the publish line never
  // crosses the bridge (before: the bridge refused it).
  if (!authorization) return wordsRequired([{ path: 'authorize', value: authorize }], { tool: 'studio_publish' });
  // F5 (producer-signatures.mjs): the module may be a producer; no reference snapshot of it acquired before the end of this
  // publication is reused. Without wait (or uncertain) the end is not known: it stays running for the ledger.
  const publication = module && root ? recordPublished(path.join(root, '.local', 'producer-cache'), { environment: tenant ?? '*', module, source: 'studio_publish' }) : false;
  let value = await publish({ manifest, wait, minutes, pid }, { studio, moduleOf: () => module });
  if (publication && wait && isObject(value) && !publicationOpen(value)) recordPublicationEnded(publication);
  if (!isObject(value)) return value;
  // A manifest given directly: its lab folder holds the delivery (deliver-result.json beside delivery/manifest.json).
  const merge = target?.merge ?? (() => {
    let document = null; try { document = readManifest(manifest); } catch { document = null; }
    if (!isObject(document)) return null;
    const file = path.resolve(root ?? '.', manifest);
    return { dir: path.basename(path.dirname(file)) === 'delivery' ? path.dirname(path.dirname(file)) : path.dirname(file), document };
  })();
  value = changedSinceDelivery(value, merge, target?.module ?? module ?? requested, pid);
  const { lastPublicationFrom } = await import('./kernel-delivery.mjs');
  const lastPublication = value.ok === true && wait
    ? { at: value.completedAt ? String(value.completedAt) : null, status: 'succeeded', version: value.published?.revision ?? null, author: null, by: 'ssam', source: 'publish-result' }
    : lastPublicationFrom(value.publishLog, { source: 'publish-log', by: 'ssam' });
  return { ...value, ...(authorization ? { authorization } : {}), ...(lastPublication ? { lastPublication } : {}),
    ...(target ? { resolvedFrom: target.resolvedFrom } : {}) };
}

export async function publishWithLog({ manifest, wait = true, minutes = 10, pid } = {}, { studio, moduleOf = () => null }) {
  const value = await studio(['publish', manifest, ...(wait ? ['--wait', String(minutes)] : [])], pid);
  if (!isObject(value) || value.ok !== false || !AFTER_DISPATCH.test(String(value.error ?? ''))) return value;
  let log = isObject(value.publishLog) ? value.publishLog : null;
  if (!log) {
    let module = null; try { module = moduleOf(manifest); } catch { module = null; }
    if (module) { try { log = await studio(['publish-log', module], pid); } catch { log = null; } }
  }
  return publishRefusal(value, log);
}
