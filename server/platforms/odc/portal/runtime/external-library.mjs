// External Library lifecycle on a tenant (odc_external_library, platforms/odc/facade/odc-external-library.mjs): deploy,
// status and discard over the tenant-aware access (access.mjs). The facade validates the spec, builds the package with
// the ODC kernel and checks the words name the library; deploy then runs in one call, refusing before any change with
// every problem at once:
//   1. tenant guard; both credential planes (public API and internal Portal) resolved; the publish route's Portal
//      metadata resolved (GETs only, PORTAL_CONTRACT_CHANGED); an uploader chosen (bridge portal-upload, else the vault
//      API Client, else BRIDGE_UPGRADE_REQUIRED);
//   2. reads: the asset by name (NAME_TAKEN_BY_OTHER_ASSET), a live job of the same library (GENERATION_PENDING), the
//      consumers and the published elements of an existing library (CONSUMERS_WOULD_BREAK, D9: an element removed or
//      changed while consumers exist needs the user's words naming each consumer), the release tag (TAG_TAKEN);
//   3. the receipt (identity odc-external-library: tenant, name, package sha256; steps upload, publish and release under
//      UUIDs derived from operationUuid); upload; the generation followed inside this call (GENERATION_FAILED,
//      CONTENTS_DIFFER_FROM_PLAN); publish of the job through the Portal session (externalLibraries.publishJob) followed
//      to its end (PUBLISH_FAILED); the release tag (PATCH of the revision); the readback of revision, tag and .NET 10
//      runtime (RELEASE_READBACK_FAILED); one answer.
// An answer lost after a send is uncertain and never resent: the same call (same operationUuid) reads the exact state of
// each step (the job by its file name, the publication by the library, the tag by the revision) and continues only
// from what it proved; two candidates are AMBIGUOUS with the evidence.
import { guardTenant, namesWhole } from './access.mjs';
import { sha256 } from './write-journal.mjs';
import { publicError } from './errors.mjs';
import {externalLibraryStepUuid,externalLibraryProofApproval,EXTERNAL_LIBRARY_DEPLOY} from './external-library-approval.mjs';
import {authorizationContext as readApproval} from '../../facade/authorization-context.mjs';

export const OPS = Object.freeze({
  assets: 'asset-repository-api-v1:get:/assets',
  asset: 'asset-repository-api-v1:get:/assets/{assetKey}',
  revisions: 'asset-repository-api-v1:get:/assets/{assetKey}/revisions',
  revision: 'asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}',
  revisionMetadata: 'asset-repository-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}/metadata',
  highestTag: 'asset-repository-api-v1:get:/assets/{assetKey}/highest-tag-revision',
  tag: 'asset-repository-api-v1:patch:/assets/{assetKey}/revisions/{revisionNumber}',
  publicElements: 'dependency-management-api-v1:get:/assets/{assetKey}/revisions/{revisionNumber}/public-elements',
  jobs: 'external-library-generation-api-v1:get:/generation-operations',
  job: 'external-library-generation-api-v1:get:/generation-operations/{operationKey}',
  jobContents: 'external-library-generation-api-v1:get:/generation-operations/{operationKey}/contents',
  jobLog: 'external-library-generation-api-v1:get:/generation-operations/{operationKey}/log-messages',
  jobDelete: 'external-library-generation-api-v1:delete:/generation-operations/{operationKey}',
  publishOps: 'deployments-api-v1:get:/publish-operations',
});
export const PUBLISH_ROUTE = Object.freeze({ id: 'externalLibraries.publishJob', module: 'logic', view: 'CreateExternalLibraryWizard.createnewrevision',
  action: 'logic/CreateExternalLibraryWizard/createnewrevision/ActionExternalLibraryPublishJob' });
const PENDING = new Set(['Generating', 'ReadyForReview', 'Downloading', 'None']);
const GENERATION_FAILED = new Set(['GenerationError', 'DownloadError']);
const READY = new Set(['ReadyForReview', 'Completed']);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const DEFAULT_WAITS = Object.freeze({ generationSeconds: 600, publishSeconds: 600, readbackSeconds: 60, pollMs: 5000 });
const lower = value => String(value ?? '').toLowerCase();
const rows = data => Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];

// UUID derived from the operation's own: the same deploy always names the same step, so a repeat never sends twice.
export function stepUuid(operationUuid, step) {
  return externalLibraryStepUuid(operationUuid,step);
}
export function nextPatch(tag) {
  const m = SEMVER.exec(String(tag ?? '').replace(/^v/, ''));
  return m ? m[1] + '.' + m[2] + '.' + (Number(m[3]) + 1) : '1.0.0';
}
const compareSemver = (a, b) => { const x = SEMVER.exec(a), y = SEMVER.exec(b); for (let i = 1; i <= 3; i++) { const d = Number(x[i]) - Number(y[i]); if (d) return d; } return 0; };
const problem = (code, message, fix, extra = {}) => ({ code, message, fix, ...extra });
const refusal = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

// Plan versus the generation's contents, by names and directions only (the server's type spelling is not the spec's):
// an action, structure, parameter or attribute present on one side only, or a parameter on the other side of the call.
export function contentsDifferences(plan, server) {
  const out = [];
  const index = list => new Map((Array.isArray(list) ? list : []).filter(x => typeof x?.name === 'string').map(x => [lower(x.name), x]));
  for (const [kind, list, members] of [['action', 'actions', 'parameters'], ['structure', 'structures', 'attributes']]) {
    const a = index(plan?.[list]), b = index(server?.[list]);
    for (const [name, entry] of a) {
      const other = b.get(name);
      if (!other) { out.push(kind + ' ' + entry.name + ' is in the plan but not in the generated library'); continue; }
      if (other.changeType === 'Removed') out.push(kind + ' ' + entry.name + ' is planned but the generation removes it');
      const am = index(entry[members]), bm = index(other[members]);
      for (const [m, item] of am) {
        const seen = bm.get(m);
        if (!seen || seen.changeType === 'Removed') out.push(kind + ' ' + entry.name + ': ' + item.name + ' is missing from the generated library');
        else if (members === 'parameters' && lower(item.direction ?? 'Input') !== lower(seen.direction ?? seen.parameterType ?? 'Input')) out.push(kind + ' ' + entry.name + ': ' + item.name + ' is generated as ' + (seen.parameterType ?? seen.direction));
      }
      for (const [m, item] of bm) if (!am.has(m) && item.changeType !== 'Removed') out.push(kind + ' ' + entry.name + ': the generated library adds ' + item.name);
    }
    for (const [name, entry] of b) if (!a.has(name) && entry.changeType !== 'Removed') out.push(kind + ' ' + entry.name + ' is generated but not planned');
  }
  return out;
}
// What the generation changes that breaks a consumer: removed or updated elements (the server's changeType).
export function breakingChanges(server) {
  const out = [];
  for (const [kind, list] of [['action', 'actions'], ['structure', 'structures']])
    for (const entry of Array.isArray(server?.[list]) ? server[list] : [])
      if (['Removed', 'Updated'].includes(entry?.changeType)) out.push({ kind, name: entry.name, change: entry.changeType });
  return out;
}

export class ExternalLibraryDeployer {
  // access: OdcAccess. uploaders: { studio: () => uploader | null, vault: async host => uploader | null }.
  constructor({ access, uploaders, sleep, now, waits = {} }) {
    this.access = access; this.uploaders = uploaders;
    this.sleep = sleep ?? access.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = now ?? access.now ?? Date.now;
    this.waits = { ...DEFAULT_WAITS, ...waits };
  }
  read(host, auth, operationId, input = {}) { return this.access.read({ tenant: host, auth, operationId, ...input }); }

  // plan: {name, package:{path, fileName, sha256, bytes}, contents}. words: the user's words or the standing grant's;
  // userWords false (a grant) never covers a change that breaks consumers.
  async deploy(plan, { tenant, auth = 'auto', words, userWords = true, operationUuid, confirmTenant, releaseTag, releaseNotes, authorization = null, authorizationContext,originOperationUuid=null,expectedRevision=null }) {
    const access = this.access;
    let host,approval;
    try {
      host = await access.pickTenant(tenant);
      if(authorizationContext)approval=readApproval(authorizationContext,words,{lane:'odc',host,operation:EXTERNAL_LIBRARY_DEPLOY,targets:[plan.name],
        constraints:{packageSha256:plan.package.sha256,releaseTag,releaseNotes:releaseNotes??null,originOperationUuid,expectedRevision}});
      else if(originOperationUuid!==null || expectedRevision!==null)throw Object.assign(new Error('Fixture origin requires a proposal-bound authorization context.'),{code:'AUTHORIZATION_CONTEXT_INVALID'});
      guardTenant(access.tenantInfo(host), words, confirmTenant,approval);
    } catch (error) { return { ok: false, code: error.code ?? 'INPUT_INVALID', error: publicError(error).message, ...(host ? { tenant: host } : {}), sent: false }; }
    const publicAuth = auth;
    const portalAuth = auth === 'api-client' ? 'portal-credential' : auth;
    const identity = { kind: 'odc-external-library', tenant: host, name: plan.name, packageSha256: String(plan.package.sha256).toLowerCase() };
    let existing;
    try { existing = access.receipts.lookup(operationUuid, identity); }
    catch (error) { return { ok: false, code: error.code, error: error.message, tenant: host, sent: false }; }
    if(existing && (approval || existing.progress?.authorization?.context)) {
      const saved=existing.progress?.authorization?.context;
      if(!approval || !saved || saved.sha256!==approval.sha256 || saved.wordsSha256!==approval.wordsSha256)
        return refusal('AUTHORIZATION_CONTEXT_INVALID','A resumed deploy must keep its exact approval, package and release.',{sent:false});
    }
    if (existing && ['confirmed', 'rejected', 'not-sent'].includes(existing.state))
      return { ok: existing.state === 'confirmed', code: existing.state === 'confirmed' ? undefined : 'OPERATION_ENDED', state: existing.state, tenant: host, existingReceipt: true,
        receipt: this.receiptOf(existing), ...(existing.result ? { result: existing.result } : {}),
        message: existing.state === 'confirmed' ? 'This deploy already ended; nothing was sent again.' : 'This operationUuid already ended (' + existing.state + '); a new attempt needs a new operationUuid.' };

    // 1. Both credential planes and the publish route's metadata, before any mutation.
    const publicPlane = await access.resolvePublic(host, publicAuth).catch(error => ({ ok: false, code: error.code ?? 'AUTH_FAILED', error: { code: error.code, message: error.message } }));
    if (publicPlane.ok === false) return { ...publicPlane, tenant: host, sent: false };
    const portalPlane = await access.resolvePortal(host, portalAuth).catch(error => ({ ok: false, code: error.code ?? 'PORTAL_AUTH_REQUIRED', error: { code: error.code, message: error.message } }));
    if (portalPlane.ok === false) return { ...portalPlane, tenant: host, sent: false };
    try { await portalPlane.broker.metadata.resolve(PUBLISH_ROUTE.module, PUBLISH_ROUTE.view, PUBLISH_ROUTE.action); }
    catch (error) {
      return refusal('PORTAL_CONTRACT_CHANGED', 'The Portal route that publishes an External Library job (' + PUBLISH_ROUTE.action + ') was not found in the current Portal assets; nothing was uploaded. ' + (error.message ?? ''),
        { tenant: host, sent: false, problems: [problem('PORTAL_CONTRACT_CHANGED', 'The publish route of the External Library wizard changed.', 'Capture the current route with odc_portal_routes {module:"logic", match:"PublishJob"}; the integrator updates PORTAL_WRITES.')],
          continuation: { tool: 'odc_portal_routes', arguments: { tenant: host, module: 'logic', match: 'PublishJob' }, why: 'GETs only: lists the publish action of the current Portal for the integrator.' } });
    }
    const uploader = await this.chooseUploader(host, publicPlane);
    if (!uploader.ok) return { ...uploader, tenant: host, sent: false };

    if (existing) return this.resume(plan, existing, { host, publicAuth, portalAuth, words, userWords, confirmTenant, releaseNotes, uploader: uploader.uploader });

    // 2. Reads, every problem at once.
    if(approval) {
      try {
        approval=await externalLibraryProofApproval({file:authorizationContext,words,host,name:plan.name,packageSha256:plan.package.sha256,
          releaseTag,releaseNotes:releaseNotes??null,originOperationUuid,expectedRevision,lookup:id=>access.receipts.lookup(id),
          readAssets:query=>this.read(host,publicAuth,OPS.assets,{query}),readDependents:key=>access.dependentsOf(host,publicPlane,key)});
        authorization={source:'proposal-context',context:approval};
      } catch(error) {return refusal(error.code??'AUTHORIZATION_CONTEXT_INVALID',error.message,{sent:false});}
    }
    const facts = await this.readFacts(plan, { host, publicPlane, publicAuth, words, userWords, releaseTag });
    if (!facts.ok) return { ...facts, tenant: host, sent: false };
    if(approval && (facts.consumers.length || facts.library.isNew!==approval.fixture.isNew
      || !facts.library.isNew && (facts.library.key!==approval.fixture.key || facts.library.revision!==approval.fixture.revision)))
      return refusal('EXTERNAL_LIBRARY_CHANGED','Fixture changed between authorization and deployment preflight.',{sent:false});

    // 3. The receipt, then the steps.
    let receipt;
    try {
      receipt = access.receipts.reserve({ operationUuid, identity, wordsSha256: sha256(words),
        plan: { fileName: plan.package.fileName, sha256: identity.packageSha256, bytes: plan.package.bytes, tag: facts.tag, library: facts.library, uploader: uploader.uploader.kind } });
    } catch (error) { return { ok: false, code: error.code, error: error.message, tenant: host, sent: false, ...(error.details ?? {}) }; }
    receipt.progress = { startedAt: new Date(this.now()).toISOString(), tag: facts.tag, library: facts.library, consumers: facts.consumers, uploadAttempt: 1, authorization,
      package:{fileName:plan.package.fileName,sha256:identity.packageSha256} };
    this.save(receipt);
    return this.run(plan, receipt, { host, publicAuth, portalAuth, words, userWords, confirmTenant, releaseNotes, uploader: uploader.uploader });
  }

  async chooseUploader(host, publicPlane) {
    if (publicPlane.path === 'vault') {
      const vault = await this.uploaders.vault(host);
      return vault ? { ok: true, uploader: vault } : refusal('AUTH_NOT_CONFIGURED', 'No API Client in the vault for ' + host + '.');
    }
    const state = await this.access.studioState();
    if ((state.capabilities ?? []).includes('portal-upload')) { const studio = this.uploaders.studio(); if (studio) return { ok: true, uploader: studio }; }
    if (await this.access.apiClientAvailable(host)) { const vault = await this.uploaders.vault(host); if (vault) return { ok: true, uploader: vault }; }
    return refusal('BRIDGE_UPGRADE_REQUIRED', 'The attached bridge cannot upload an External Library (no portal-upload capability) and the vault holds no API Client for ' + host + '; nothing was sent.',
      { problems: [problem('BRIDGE_UPGRADE_REQUIRED', 'The attached bridge does not advertise portal-upload.', 'Preserve the open Studio. The integrator must provide a compatible isolated bridge revision or a configured API Client uploader for this tenant; do not replace loaded DLLs.')],
        continuation: { tool: 'ssam_doctor', arguments: { lane: 'odc' }, why: 'Inspect the existing ODC session and capability gap without closing or reopening the Studio.' } });
  }

  async readFacts(plan, { host, publicPlane, publicAuth, words, userWords, releaseTag }) {
    const problems = [], extra = {};
    const assets = await this.read(host, publicAuth, OPS.assets, { query: { nameContains: plan.name, limit: 100 } });
    if (!assets.ok) return refusal('READ_FAILED', 'The asset list could not be read; nothing was sent.', { read: assets.error ?? assets.status });
    const same = rows(assets.data).filter(a => lower(a.name) === lower(plan.name));
    const library = same.find(a => a.name === plan.name && /externallibrary/i.test(String(a.assetType ?? a.applicationType ?? ''))) ?? null;
    for (const other of same.filter(a => a !== library))
      problems.push(problem('NAME_TAKEN_BY_OTHER_ASSET', 'The name ' + plan.name + ' belongs to ' + (other.assetType ?? 'another asset') + ' ' + other.name + ' (' + other.assetKey + ').',
        'Give the library another name (spec.name), or delete that asset first (odc_asset_delete, with the user\'s words naming it).', { target: other.name, assetKey: other.assetKey }));
    const jobs = await this.read(host, publicAuth, OPS.jobs);
    if (!jobs.ok) return refusal('READ_FAILED', 'The generation jobs could not be read; nothing was sent.', { read: jobs.error ?? jobs.status });
    const pending = rows(jobs.data).filter(j => PENDING.has(j.status) && (lower(j.libraryName) === lower(plan.name) || lower(j.filename).startsWith(lower(plan.name) + '-')));
    if (pending.length) {
      extra.jobKey = pending[0].key;
      problems.push(problem('GENERATION_PENDING', 'A job of ' + plan.name + ' is still open (' + pending[0].status + ', ' + pending[0].key + '): the tenant takes one at a time.',
        'Discard it in two calls: odc_external_library {action:"discard", jobKey:"' + pending[0].key + '"} previews the job (nothing is sent); after the owner\'s reply to that list (the number and ' + plan.name + '), the same call with its confirmationToken; then repeat.', { target: plan.name, jobKey: pending[0].key }));
      extra.continuation = this.discardStep(host, plan.name, pending[0].key, 'then the same deploy again');
    }
    let consumers = [], tag = releaseTag ?? null;
    if (library) {
      const dependents = await this.access.dependentsOf(host, publicPlane, library.assetKey);
      if (!dependents.ok) return refusal(dependents.code, dependents.message);
      consumers = dependents.consumers;
      const elements = await this.read(host, publicAuth, OPS.publicElements, { path: { assetKey: library.assetKey, revisionNumber: library.revision } });
      if (!elements.ok) return refusal('READ_FAILED', 'The published elements of ' + plan.name + ' could not be read; nothing was sent.', { read: elements.error ?? elements.status });
      const planned = { action: new Set((plan.contents?.actions ?? []).map(a => lower(a.name))), structure: new Set((plan.contents?.structures ?? []).map(s => lower(s.name))) };
      const removed = rows(elements.data).filter(e => typeof e?.name === 'string').map(e => ({ kind: /struct/i.test(String(e.type ?? '')) ? 'structure' : 'action', name: e.name }))
        .filter(e => !planned[e.kind].has(lower(e.name)));
      extra.contractDiff = { removed };
      if (removed.length && consumers.length) {
        const unnamed = consumers.filter(c => !userWords || !namesWhole(words, c.name));
        for (const c of unnamed) problems.push(problem('CONSUMERS_WOULD_BREAK', c.name + ' consumes ' + plan.name + ', and the deploy removes ' + removed.map(r => r.kind + ' ' + r.name).join(', ') + '.',
          'Repeat with the user\'s words that also name ' + c.name + ' (a standing grant never covers this), or keep the removed elements.', { target: c.name, ssamRule: true }));
        if (unnamed.length) extra.consumers = consumers.map(c => c.name);
      }
      const highest = await this.read(host, publicAuth, OPS.highestTag, { path: { assetKey: library.assetKey } });
      const highestTag = highest.ok && typeof highest.data?.tag === 'string' && highest.data.tag ? highest.data.tag.replace(/^v/, '') : null;
      const next = highestTag ? nextPatch(highestTag) : '1.0.0';
      if (tag == null) tag = next;
      else if (!SEMVER.test(tag)) problems.push(problem('TAG_INVALID', 'releaseTag ' + tag + ' is not major.minor.patch.', 'Use ' + next + '.', { nextTag: next }));
      else {
        const used = await this.read(host, publicAuth, OPS.revisions, { path: { assetKey: library.assetKey }, query: { tag, limit: 1 } });
        const taken = (used.ok && rows(used.data).some(r => r.tag === tag)) || (highestTag && SEMVER.test(highestTag) && compareSemver(tag, highestTag) <= 0);
        if (taken) { extra.nextTag = next; problems.push(problem('TAG_TAKEN', 'Tag ' + tag + ' of ' + plan.name + ' is used or not above the highest tag (' + (highestTag ?? 'none') + ').', 'Use ' + next + ' (or omit releaseTag).', { nextTag: next })); }
      }
    } else {
      if (tag == null) tag = '1.0.0';
      else if (!SEMVER.test(tag)) problems.push(problem('TAG_INVALID', 'releaseTag ' + tag + ' is not major.minor.patch.', 'Use 1.0.0.', { nextTag: '1.0.0' }));
    }
    if (problems.length) {
      const codes = [...new Set(problems.map(p => p.code))];
      return refusal(codes.length === 1 ? codes[0] : 'DEPLOY_REFUSED', problems.map(p => p.message).join(' '), { problems, ...extra });
    }
    return { ok: true, tag, consumers, library: library ? { key: library.assetKey, name: library.name, revision: library.revision ?? null, isNew: false } : { key: null, name: plan.name, isNew: true }, ...extra };
  }

  // The steps after the receipt, from wherever the receipt's progress says the deploy is.
  async run(plan, receipt, ctx) {
    const p = receipt.progress;
    // Upload (one attempt per derived UUID; a second one only after a read proved the first created nothing).
    if (!p.upload?.operationKey) {
      const uuid = stepUuid(receipt.operationUuid, 'upload-' + p.uploadAttempt);
      const sent = await ctx.uploader.upload({ host: ctx.host, file: plan.package.path, sha256: plan.package.sha256, fileName: plan.package.fileName,
        operationUuid: uuid, authorizeSha256: sha256(ctx.words), confirmTenant: ctx.confirmTenant });
      p.upload = { uuid, attempt: p.uploadAttempt, auth: sent.auth ?? ctx.uploader.kind, state: sent.ok ? 'accepted' : sent.state, ...(sent.ok ? { operationKey: sent.operationKey } : { code: sent.code }) };
      if (!sent.ok) {
        if (sent.state === 'uncertain') return this.uncertain(receipt, 'upload', sent.error?.message ?? 'The upload answer was lost.');
        return this.close(receipt, sent.state === 'rejected' ? 'rejected' : 'not-sent', refusal(sent.code, sent.error?.message ?? 'The upload was refused.', { step: 'upload', sent: sent.state === 'rejected' }));
      }
      this.save(receipt);
    }
    const jobKey = p.upload.operationKey;
    // Generation, followed here.
    if (!p.generation?.ready) {
      const job = await this.waitJob(ctx, jobKey);
      if (!job.ok) return job.terminal ? this.close(receipt, 'rejected', job.answer) : this.uncertain(receipt, 'generation', job.error, { jobKey, code: 'GENERATION_PENDING' });
      const contents = await this.read(ctx.host, ctx.publicAuth, OPS.jobContents, { path: { operationKey: jobKey } });
      if (!contents.ok) return this.uncertain(receipt, 'generation', 'The generated contents could not be read; the job is ready and not published.', { jobKey });
      const server = contents.data ?? {};
      const differences = contentsDifferences(plan.contents, server);
      if (job.data.libraryName && job.data.libraryName !== plan.name) differences.unshift('the job generates library ' + job.data.libraryName + ', not ' + plan.name);
      if (typeof job.data.isNewLibrary === 'boolean' && job.data.isNewLibrary !== p.library.isNew) differences.unshift(p.library.isNew ? 'the job updates an existing library, the plan creates one' : 'the job creates a new library, the plan updates ' + plan.name);
      if (differences.length)
        return this.close(receipt, 'rejected', refusal('CONTENTS_DIFFER_FROM_PLAN', 'The generated library is not the planned one; the job was not published.', { jobKey, differences: differences.slice(0, 30),
          problems: differences.slice(0, 30).map(d => problem('CONTENTS_DIFFER_FROM_PLAN', d, 'Read the generation log (odc_operation_status {kind:"generation", messages:true}); discard the job; correct the spec.')),
          continuation: this.discardStep(ctx.host, plan.name, jobKey) }));
      p.generation = { ready: true, status: job.data.status, libraryKey: job.data.libraryKey ?? p.library.key ?? null, isNewLibrary: job.data.isNewLibrary ?? null, changes: breakingChanges(server) };
      this.save(receipt);
    }
    // D9 on what the platform says changes (removed or updated), with the consumers read before the upload.
    const breaking = p.generation.changes ?? [];
    if (breaking.length && (p.consumers ?? []).length) {
      const unnamed = p.consumers.filter(c => !ctx.userWords || !namesWhole(ctx.words, c.name));
      if (unnamed.length) {
        this.save(receipt);
        return refusal('CONSUMERS_WOULD_BREAK', 'The generated revision ' + breaking.map(b => b.change.toLowerCase() + ' ' + b.kind + ' ' + b.name).join(', ') + ' of ' + plan.name + ' and '
          + unnamed.map(c => c.name).join(', ') + ' consume it; the job is ready and not published.', { tenant: ctx.host, jobKey, state: 'awaiting-words', consumers: p.consumers.map(c => c.name), changes: breaking,
          problems: unnamed.map(c => problem('CONSUMERS_WOULD_BREAK', c.name + ' consumes ' + plan.name + ' and would break.', 'Repeat this same call (same operationUuid) with the user\'s words that also name ' + c.name + '; or discard the job.', { target: c.name, ssamRule: true })),
          receipt: this.receiptOf(receipt) });
      }
    }
    // Publish of the job, followed to its end.
    if (!p.publish?.done) {
      const published = await this.publish(plan, receipt, ctx, jobKey);
      if (published) return published;
    }
    // Release tag and readback.
    return this.release(plan, receipt, ctx);
  }

  async waitJob(ctx, jobKey) {
    const deadline = this.now() + this.waits.generationSeconds * 1000;
    while (true) {
      const job = await this.read(ctx.host, ctx.publicAuth, OPS.job, { path: { operationKey: jobKey } });
      if (job.ok && READY.has(job.data?.status)) return { ok: true, data: job.data };
      if (job.ok && GENERATION_FAILED.has(job.data?.status)) {
        const log = await this.read(ctx.host, ctx.publicAuth, OPS.jobLog, { path: { operationKey: jobKey } });
        const messages = (Array.isArray(log.data?.validationMessages) ? log.data.validationMessages : []).map(m => ({ type: m.type ?? null, code: m.errorCode ?? null, message: m.message ?? null })).slice(0, 30);
        return { ok: false, terminal: true, answer: refusal('GENERATION_FAILED', 'The generation of the library failed (' + job.data.status + ')' + (messages[0]?.message ? ': ' + messages[0].message : '') + '; nothing was published.',
          { jobKey, status: job.data.status, messages, problems: messages.filter(m => m.type !== 'Information').map(m => problem(m.code ?? 'GENERATION_FAILED', m.message ?? 'generation error', 'Correct the spec (types and attributes the platform accepts) and deploy again.')) }) };
      }
      if (this.now() >= deadline) return { ok: false, error: 'The generation did not finish within ' + this.waits.generationSeconds + ' s (' + (job.data?.status ?? job.error?.code ?? 'no answer') + ').' };
      await this.sleep(Math.min(this.waits.pollMs, Math.max(deadline - this.now(), 0)));
    }
  }

  async publish(plan, receipt, ctx, jobKey) {
    const p = receipt.progress;
    if (!p.publish?.operationKey) {
      if(p.authorization?.context) {
        const job=await this.read(ctx.host,ctx.publicAuth,OPS.job,{path:{operationKey:jobKey}});
        const expectedKey=p.library.key??p.generation?.libraryKey;
        if(!job.ok || !READY.has(job.data?.status) || job.data?.libraryName!==plan.name
          || job.data?.libraryKey!==expectedKey || job.data?.isNewLibrary!==p.library.isNew)
          return this.uncertain(receipt,'pre-publication','The generated job no longer matches this own fixture.',{code:'EXTERNAL_LIBRARY_CHANGED',jobKey});
        const assets=await this.read(ctx.host,ctx.publicAuth,OPS.assets,{query:{nameContains:plan.name,limit:1000,offset:0}});
        const list=assets.data?.results;
        if(!assets.ok || !Array.isArray(list) || assets.data?.page?.totalResults!==list.length)
          return this.uncertain(receipt,'pre-publication','Complete asset inventory could not be verified.',{code:'ASSET_INVENTORY_UNAVAILABLE',jobKey});
        const same=list.filter(a=>lower(a.name)===lower(plan.name));
        const current=same[0];
        const exact=current && current.name===plan.name && current.assetType==='ExternalLibrary'
          && current.assetKey===expectedKey && current.revision===(p.library.isNew?0:p.library.revision);
        if(p.library.isNew ? same.length>0 && !(same.length===1&&exact) : same.length!==1 || !exact)
          return this.uncertain(receipt,'pre-publication','The library changed after upload; publication was not sent.',{code:'EXTERNAL_LIBRARY_CHANGED',jobKey});
        if(current) {
          const plane=await this.access.resolvePublic(ctx.host,ctx.publicAuth);
          const deps=plane.ok===false?{ok:false}:await this.access.dependentsOf(ctx.host,plane,current.assetKey);
          if(!deps.ok || !Array.isArray(deps.consumers) || deps.consumers.length)
            return this.uncertain(receipt,'pre-publication','Absence of consumers could not be confirmed; publication was not sent.',{code:'EXTERNAL_LIBRARY_HAS_CONSUMERS',jobKey});
        }
      }
      const attempt = p.publish?.attempt ?? 1;
      const uuid = stepUuid(receipt.operationUuid, 'publish-' + attempt);
      const startedAt = p.publish?.startedAt ?? new Date(this.now()).toISOString();
      const answer = await this.access.portalWrite({ tenant: ctx.host, auth: ctx.portalAuth, operationId: PUBLISH_ROUTE.id, input: { inputParameters: { JobKey: jobKey } },
        authorize: ctx.words, operationUuid: uuid, confirmTenant: ctx.confirmTenant, target: { jobKey, libraryName: plan.name } },
        p.authorization?.context?{externalLibraryParent:receipt.operationUuid}:{});
      const state = answer.receipt?.state ?? (answer.ok ? 'accepted' : 'not-sent');
      p.publish = { attempt, uuid, state, startedAt };
      if (!answer.ok && state !== 'uncertain' && !answer.existingReceipt) {
        return this.close(receipt, state === 'rejected' ? 'rejected' : 'not-sent', refusal('PUBLISH_FAILED', 'The publish of the job was refused (' + (answer.error?.code ?? 'error') + '); the job stays ready.', { jobKey, step: 'publish', publishError: answer.error ?? null }));
      }
      const key = publishKeyOf(answer.data);
      if (key) p.publish.operationKey = key;
      else {
        // No key in the answer (or an uncertain one): the publication is read by the library, never resent.
        const found = await this.findPublication(ctx, p);
        if (found.ambiguous) return this.uncertain(receipt, 'publish', 'Several publications of ' + plan.name + ' started after this deploy.', { code: 'AMBIGUOUS', candidates: found.ambiguous });
        if (!found.key) return this.uncertain(receipt, 'publish', state === 'uncertain' ? 'The publish answer was lost and no publication of the library is visible yet.' : 'The publish route answered without a publication key and none is visible yet.', { jobKey });
        p.publish.operationKey = found.key;
      }
      this.save(receipt);
    }
    const followed = await this.access.operationStatus({ tenant: ctx.host, auth: ctx.publicAuth, kind: 'publish', operationKey: p.publish.operationKey, waitSeconds: this.waits.publishSeconds, messages: true });
    if (!followed.ok) return this.uncertain(receipt, 'publish', 'The publication could not be read (' + (followed.error?.code ?? 'error') + ').', { publishKey: p.publish.operationKey });
    if (followed.failed)
      return this.close(receipt, 'rejected', refusal('PUBLISH_FAILED', followed.log?.summary ?? 'The publication of ' + plan.name + ' ended in ' + followed.status + '; no tag was applied.',
        { publishKey: p.publish.operationKey, status: followed.status, log: followed.log ?? null, ...(followed.continuation ? { continuation: followed.continuation } : {}) }));
    if (!followed.terminal) return this.uncertain(receipt, 'publish', 'The publication is still ' + followed.status + ' after ' + this.waits.publishSeconds + ' s.', { publishKey: p.publish.operationKey });
    p.publish.done = true; p.publish.status = followed.status;
    p.publish.revision = followed.data?.revision ?? null;
    p.library.key = p.library.key ?? followed.data?.assetKey ?? p.generation?.libraryKey ?? null;
    this.save(receipt);
    return null;
  }

  async findPublication(ctx, p) {
    const key = p.library.key ?? p.generation?.libraryKey ?? (await this.libraryKey(ctx, p.library.name));
    if (!key) return {};
    p.library.key = key;
    const ops = await this.read(ctx.host, ctx.publicAuth, OPS.publishOps, { query: { assetKey: key, createdDateSince: p.startedAt ?? p.publish?.startedAt, limit: 10 } });
    const list = rows(ops.data);
    if (list.length > 1) return { ambiguous: list.map(o => ({ key: o.key, status: o.status, revision: o.revision ?? null })) };
    return list.length === 1 ? { key: list[0].key } : {};
  }
  async libraryKey(ctx, name) {
    const assets = await this.read(ctx.host, ctx.publicAuth, OPS.assets, { query: { nameContains: name, limit: 100 } });
    return rows(assets.data).find(a => a.name === name && /externallibrary/i.test(String(a.assetType ?? '')))?.assetKey ?? null;
  }

  async release(plan, receipt, ctx) {
    const p = receipt.progress;
    const key = p.library.key ?? (await this.libraryKey(ctx, plan.name));
    if (!key) return this.uncertain(receipt, 'release', 'The published library is not visible in the asset list yet.');
    p.library.key = key;
    if (p.publish.revision == null) {
      const latest = await this.read(ctx.host, ctx.publicAuth, OPS.asset, { path: { assetKey: key } });
      p.publish.revision = latest.ok ? latest.data?.revision ?? null : null;
      if (p.publish.revision == null) return this.uncertain(receipt, 'release', 'The published revision could not be read.');
    }
    const revision = p.publish.revision;
    if(p.authorization?.context)this.save(receipt);
    if (!p.release?.done) {
      const uuid = stepUuid(receipt.operationUuid, 'release');
      const tagged = await this.access.write({ tenant: ctx.host, auth: ctx.publicAuth, operationId: OPS.tag, path: { assetKey: key, revisionNumber: revision },
        body: { tag: p.tag, ...(ctx.releaseNotes ? { releaseNotes: ctx.releaseNotes } : {}) }, authorize: ctx.words, operationUuid: uuid, confirmTenant: ctx.confirmTenant },
        p.authorization?.context?{externalLibraryParent:receipt.operationUuid}:{});
      const state = tagged.receipt?.state ?? (tagged.ok ? 'accepted' : 'not-sent');
      p.release = { uuid, state };
      if (!tagged.ok && state !== 'uncertain' && !tagged.existingReceipt) {
        const code = tagged.status === 409 ? 'TAG_TAKEN' : 'RELEASE_REFUSED';
        return this.close(receipt, 'rejected', refusal(code, 'Revision ' + revision + ' of ' + plan.name + ' is published but the tag ' + p.tag + ' was refused (' + (tagged.status ?? tagged.error?.code) + '); ODC Studio offers it to consumers only once tagged.',
          { library: { key, name: plan.name }, revision, tag: p.tag, nextTag: nextPatch(p.tag) }));
      }
      this.save(receipt);
    }
    // Readback: revision, tag and the .NET 10 runtime, within the readback wait.
    const deadline = this.now() + this.waits.readbackSeconds * 1000;
    let observed;
    while (true) {
      const rev = await this.read(ctx.host, ctx.publicAuth, OPS.revision, { path: { assetKey: key, revisionNumber: revision } });
      const meta = await this.read(ctx.host, ctx.publicAuth, OPS.revisionMetadata, { path: { assetKey: key, revisionNumber: revision } });
      observed = { revision: rev.data?.revision ?? null, tag: rev.data?.tag ?? null, runtime: meta.data?.runtime ?? null };
      if (rev.ok && observed.tag === p.tag) { p.release.done = true; break; }
      if (this.now() >= deadline) break;
      await this.sleep(Math.min(this.waits.pollMs, Math.max(deadline - this.now(), 0)));
    }
    const net10 = /(^|[^0-9])10([^0-9]|$)/.test(String(observed.runtime ?? '')) && /net/i.test(String(observed.runtime ?? ''));
    if (observed.tag !== p.tag || !net10) {
      if (observed.tag !== p.tag && p.release.state === 'uncertain') return this.uncertain(receipt, 'release', 'The tag answer was lost and the revision does not show it yet.');
      return this.close(receipt, 'rejected', refusal('RELEASE_READBACK_FAILED', 'Revision ' + revision + ' of ' + plan.name + ' reads back tag ' + (observed.tag ?? 'none') + ' and runtime ' + (observed.runtime ?? 'unknown')
        + ' (expected ' + p.tag + ' on .NET 10).', { library: { key, name: plan.name }, revision, expected: { tag: p.tag, runtime: 'NET10' }, observed }));
    }
    const result = { ok: true, state: 'released', tenant: ctx.host, library: { name: plan.name, key, created: p.library.isNew === true }, revision, tag: p.tag, runtime: observed.runtime,
      contents: plan.contents, package: { fileName: plan.package.fileName, sha256: plan.package.sha256, bytes: plan.package.bytes },
      upload: { auth: p.upload.auth, jobKey: p.upload.operationKey }, publish: { operationKey: p.publish.operationKey, status: p.publish.status },
      consumers: (p.consumers ?? []).map(c => ({ name: c.name, key: c.key, outdated: true })),
      references: [...(plan.contents?.actions ?? []).map(a => 'IServerAction:' + a.name), ...(plan.contents?.structures ?? []).map(s => 'IStructure:' + s.name)],
      ...(p.authorization ? { authorization: p.authorization } : {}) };
    return this.close(receipt, 'confirmed', result);
  }

  // A repeated call with the same operationUuid: each uncertain step is settled by its exact read, then the deploy
  // continues from what was proven.
  async resume(plan, receipt, ctx) {
    const p = receipt.progress ?? {};
    receipt.progress = p;
    if (p.upload && !p.upload.operationKey && p.upload.state === 'uncertain') {
      const jobs = await this.read(ctx.host, ctx.publicAuth, OPS.jobs);
      if (!jobs.ok) return this.uncertain(receipt, 'upload', 'The generation jobs could not be read to settle the upload.');
      const mine = rows(jobs.data).filter(j => j.filename === plan.package.fileName);
      if (mine.length > 1) return refusal('AMBIGUOUS', 'Two generation jobs carry the file ' + plan.package.fileName + '; nothing was sent.', { tenant: ctx.host, candidates: mine.map(j => ({ key: j.key, status: j.status, createdAt: j.createdAt ?? null })),
        problems: [problem('AMBIGUOUS', 'Several jobs carry the uploaded file name.', 'Discard the extra jobs (odc_external_library discard, words naming the library) and repeat this call.')], receipt: this.receiptOf(receipt) });
      if (mine.length === 1) { p.upload.operationKey = mine[0].key; p.upload.state = 'confirmed'; p.upload.reconciled = 'job by file name'; }
      else return this.uncertain(receipt, 'upload', 'No job carries the file yet; absence does not authorize repeating the upload.');
      this.save(receipt);
    }
    if (p.publish && !p.publish.operationKey && ['uncertain', 'accepted'].includes(p.publish.state)) {
      const found = await this.findPublication(ctx, p);
      if (found.ambiguous) return refusal('AMBIGUOUS', 'Several publications of ' + plan.name + ' started after this deploy.', { tenant: ctx.host, candidates: found.ambiguous, receipt: this.receiptOf(receipt) });
      if (found.key) { p.publish.operationKey = found.key; p.publish.reconciled = 'publication by library'; }
      else return this.uncertain(receipt, 'publish', 'No publication is visible yet; absence does not authorize repeating publication.');
      this.save(receipt);
    }
    return this.run(plan, receipt, ctx);
  }

  // CX15 r3 (N3): the discard is a delete in two calls; its continuation is the PREVIEW (no words, no operationUuid: the
  // preview answers the operationId the execution uses), never a call with a placeholder for the owner's words.
  discardStep(host, name, jobKey, after = '') {
    return { tool: 'odc_external_library', arguments: { action: 'discard', tenant: host, jobKey },
      why: 'A preview of the open job of ' + name + ' (nothing is sent): show it to the owner; after the owner\'s reply to that list (the number and ' + name + '), the same call with its confirmationToken, the preview\'s operationId as operationUuid and that reply' + (after ? '; ' + after : '') + '.' };
  }
  save(receipt) { this.access.receipts.settle(receipt, { state: 'sending' }); }
  close(receipt, state, answer) {
    this.access.receipts.settle(receipt, { state, result: answer.ok ? { state: answer.state, revision: answer.revision, tag: answer.tag, libraryKey: answer.library?.key } : { code: answer.code } });
    return { ...answer, tenant: answer.tenant ?? receipt.identity.tenant, receipt: this.receiptOf(receipt) };
  }
  uncertain(receipt, step, message, extra = {}) {
    receipt.progress.uncertainStep = step;
    this.access.receipts.settle(receipt, { state: 'uncertain' });
    return { ok: false, code: extra.code ?? 'UNCERTAIN', state: 'uncertain', step, error: message + ' Nothing is resent: the same call (same operationUuid) reads the exact state and continues.', tenant: receipt.identity.tenant,
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'code')), receipt: this.receiptOf(receipt) };
  }
  receiptOf(receipt) { return { operationUuid: receipt.operationUuid, state: receipt.state, file: receipt.receipt, progress: summary(receipt.progress) }; }

  // ---- status: the library, its revisions and runtime, its consumers and the open jobs (reads only).
  async status({ tenant, auth = 'auto', library }) {
    let host;
    try { host = await this.access.pickTenant(tenant); } catch (error) { return { ok: false, error: publicError(error) }; }
    const assets = await this.read(host, auth, OPS.assets, { query: { nameContains: library, limit: 100 } });
    if (!assets.ok) return { ...assets, tenant: host };
    const found = rows(assets.data).find(a => a.name === library && /externallibrary/i.test(String(a.assetType ?? ''))) ?? null;
    const jobs = await this.read(host, auth, OPS.jobs);
    if (!jobs.ok) return { ...jobs, ok: false, tenant: host, library, exists: found !== null, jobs: null,
      incomplete: true, failedRead: 'generation-jobs' };
    const open = rows(jobs.data).filter(j => (lower(j.libraryName) === lower(library) || lower(j.filename).startsWith(lower(library) + '-')))
      .map(j => ({ jobKey: j.key, status: j.status, filename: j.filename ?? null, createdAt: j.createdAt ?? null, pending: PENDING.has(j.status) }));
    if (!found) return { ok: true, tenant: host, library, exists: false, jobs: open };
    const revisions = await this.read(host, auth, OPS.revisions, { path: { assetKey: found.assetKey }, query: { limit: 10 } });
    if (!revisions.ok) return { ...revisions, ok: false, tenant: host, library, exists: true, key: found.assetKey,
      jobs: open, incomplete: true, failedRead: 'revisions' };
    const meta = await this.read(host, auth, OPS.revisionMetadata, { path: { assetKey: found.assetKey, revisionNumber: found.revision } });
    if (!meta.ok) return { ...meta, ok: false, tenant: host, library, exists: true, key: found.assetKey,
      jobs: open, incomplete: true, failedRead: 'revision-metadata' };
    const resolved = await this.access.resolvePublic(host, auth).catch(() => ({ ok: false }));
    const dependents = resolved.ok === false ? { ok: false } : await this.access.dependentsOf(host, resolved, found.assetKey);
    return { ok: true, tenant: host, library, exists: true, key: found.assetKey, revision: found.revision ?? null, tag: found.tag ?? null, runtime: meta.data?.runtime ?? null,
      revisions: rows(revisions.data).map(r => ({ revision: r.revision, tag: r.tag ?? null, createdAt: r.createdAt ?? null })).slice(0, 10),
      consumers: dependents.ok ? dependents.consumers.map(c => c.name) : 'unknown', jobs: open };
  }

  // ---- discard: deletes an open job (destructive: the words name its library, read first by access.write).
  async discard({ tenant, auth = 'auto', jobKey, library, authorize, operationUuid, confirmTenant,authorizationContext,originOperationUuid }) {
    let host;
    try { host = await this.access.pickTenant(tenant); } catch (error) { return { ok: false, error: publicError(error) }; }
    let key = jobKey;
    if (!key) {
      const jobs = await this.read(host, auth, OPS.jobs);
      if (!jobs.ok) return { ...jobs, tenant: host };
      const open = rows(jobs.data).filter(j => PENDING.has(j.status) && (lower(j.libraryName) === lower(library) || lower(j.filename).startsWith(lower(library) + '-')));
      if (open.length !== 1) return refusal(open.length ? 'AMBIGUOUS' : 'JOB_NOT_FOUND', open.length ? 'Several open jobs of ' + library + '; pass jobKey.' : 'No open job of ' + library + '.',
        { tenant: host, jobs: open.map(j => ({ jobKey: j.key, status: j.status, filename: j.filename })) });
      key = open[0].key;
    }
    const deleted = await this.access.write({ tenant: host, auth, operationId: OPS.jobDelete, path: { operationKey: key }, authorize, operationUuid, confirmTenant },
      authorizationContext?{externalLibraryDiscard:{file:authorizationContext,originOperationUuid}}:{});
    if (!deleted.ok && !deleted.existingReceipt) return deleted;
    const after = await this.read(host, auth, OPS.job, { path: { operationKey: key } });
    const gone = !after.ok && after.status === 404;
    if (gone) {
      const recorded=this.access.receipts.lookup(deleted.receipt.operationUuid);
      if(['accepted','uncertain'].includes(recorded.state))this.access.receipts.reconcile(recorded, { state: 'confirmed', observation: { operationId: OPS.job, status: 404 } });
    }
    return { ...deleted, jobKey: key, readBack: { gone, status: after.status ?? null } };
  }
}

// The publication key the publish route answers (the names the Portal used across versions).
export function publishKeyOf(data) {
  for (const name of ['PublicationKey', 'publicationKey', 'PublishKey', 'publishKey', 'PublishId', 'OperationKey', 'operationKey']) {
    const found = find(data, name);
    if (typeof found === 'string' && found) return found;
  }
  return null;
}
function find(value, name, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return undefined;
  if (Object.hasOwn(value, name)) return value[name];
  for (const entry of Object.values(value)) { const hit = find(entry, name, depth + 1); if (hit !== undefined) return hit; }
  return undefined;
}
function summary(progress) {
  if (!progress) return null;
  const { upload, generation, publish, release, tag, library } = progress;
  return { tag, library: library ? { key: library.key ?? null, isNew: library.isNew } : null,
    upload: upload ? { state: upload.state, jobKey: upload.operationKey ?? null, auth: upload.auth } : null,
    generation: generation ? { ready: generation.ready === true, status: generation.status } : null,
    publish: publish ? { state: publish.state ?? null, operationKey: publish.operationKey ?? null, done: publish.done === true, revision: publish.revision ?? null } : null,
    release: release ? { state: release.state, done: release.done === true } : null };
}
