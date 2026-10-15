// ODC lifecycle of the SSAM Debug REST wrapper through the official public APIs, without any Studio:
// latest revision -> source download -> (kernel job) -> upload -> new revision with commitMessage -> publish to a
// stage -> poll. Writes are limited to the two operations below; a mutation is sent once and never retried.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const WRITES = ['asset-repository-api-v1:post:/assets', 'deployments-api-v1:post:/publish-operations'];
const BASE = { assets: '/api/asset-repository/v1', deployments: '/api/deployments/v1', portfolios: '/api/portfolios/v2' };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const authorHash = value => typeof value === 'string' && value.length > 0 && value.length <= 512 &&
  !/[\x00-\x20\x7f\[\]]/.test(value) ? sha256(Buffer.from(value)) : null;
const safeCode = value => /^[A-Z][A-Z0-9_]{0,100}$/.test(value ?? '') ? value : undefined;

// The source model author is distinct from createdBy/deployedBy. Portal author hashes are pinned only from
// confirmed native responses, never inferred from studioAuthor, a token, or a similar historical revision.
export function writeOperation(binding, kind, { baseRevision, baseSha256, candidateSha256 }, { id = randomUUID(), at = new Date().toISOString() } = {}) {
  if (!['create', 'remove'].includes(kind) || !UUID.test(id) || !Number.isInteger(baseRevision) || baseRevision < 1 ||
      !HASH.test(baseSha256) || !HASH.test(candidateSha256) || !UUID.test(binding?.assetKey ?? '') || !UUID.test(binding?.environmentKey ?? '') ||
      !/^[A-Za-z0-9_+]{22}$/.test(binding?.moduleKey ?? '') || assetKeyOf(binding.moduleKey).toLowerCase() !== binding.assetKey.toLowerCase() ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(binding?.module ?? '') ||
      !/^[A-Za-z0-9_.-]{3,200}$/.test(binding?.tenant ?? '') || !/^[A-Za-z0-9_+-]{1,200}$/.test(binding?.modelAuthor ?? '') ||
      !Number.isFinite(Date.parse(at))) throw new Error('debug_wrapper_write_binding_invalid');
  let origin; try { origin = new URL(binding.portalOrigin); } catch { throw new Error('debug_wrapper_write_binding_invalid'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.port)
    throw new Error('debug_wrapper_write_binding_invalid');
  const candidateHash = candidateSha256.toUpperCase(), baseHash = baseSha256.toUpperCase();
  const comment = `SSAM Debug REST ${kind === 'create' ? 'Create' : 'Remove'} op=${id.toLowerCase()} candidate-sha256=${candidateHash} base=${baseRevision}:${baseHash} author=${binding.modelAuthor}`;
  return { schema: 'ssam-debug-odc-write/1', id: id.toLowerCase(), kind,
    binding: { tenant: binding.tenant, portalOrigin: origin.origin, assetKey: binding.assetKey.toLowerCase(), module: binding.module,
      moduleKey: binding.moduleKey, environmentKey: binding.environmentKey.toLowerCase(), modelAuthor: binding.modelAuthor },
    baseRevision, baseSha256: baseHash, candidateSha256: candidateHash, comment, preparedAt: at,
    phase: 'prepared', expectedCreatedByHash: null, publication: { phase: 'not-submitted', expectedDeployedByHash: null } };
}

function sameBinding(left, right) {
  return ['tenant', 'portalOrigin', 'assetKey', 'module', 'moduleKey', 'environmentKey', 'modelAuthor'].every(key => left?.[key] === right?.[key]);
}
function checkedOperation(operation, binding = operation?.binding) {
  const expected = writeOperation(binding, operation?.kind, operation ?? {}, { id: operation?.id, at: operation?.preparedAt });
  if (operation?.schema !== expected.schema || operation.comment !== expected.comment || !sameBinding(operation.binding, expected.binding))
    throw new Error('debug_wrapper_write_binding_invalid');
  return expected;
}

// Persist the submitted phase before crossing each write boundary. A local callback failure also prevents send.
function phase(operation, onStage, value) {
  Object.assign(operation, value); onStage?.(operation);
}

// ODC module key (ObjectKey: base64 with '_' for '/') -> asset key (the same 16 bytes as a .NET Guid).
export function assetKeyOf(moduleKey) {
  if (!/^[A-Za-z0-9_+]{22}$/.test(moduleKey)) throw new Error('debug_module_key_invalid');
  const hex = Buffer.from(moduleKey.replace(/_/g, '/') + '==', 'base64').toString('hex');
  const le = s => s.match(/../g).reverse().join('');
  return `${le(hex.slice(0, 8))}-${le(hex.slice(8, 12))}-${le(hex.slice(12, 16))}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function connect(host, { services = {} } = {}) {
  const lib = services.lib ?? await import('./lib.mjs'), m = await lib.portal();
  const { explicitDebugTenant, OdcStudioSessionAuth } = await import('./debug-odc-portal-session.mjs');
  const { host: key, tenant } = explicitDebugTenant(host, lib.tenantOf);
  // Distinguish a missing entry from an inaccessible vault. The general facade's
  // diagnostic status intentionally coalesces those cases; execution must not.
  const credential = await (services.credentialStatus ?? (origin => m.windowsApiClientCredential('status', origin)))(tenant.portalOrigin);
  if (typeof credential?.available !== 'boolean') throw new Error('debug_odc_session_api_client_status_unavailable');
  const configured = await lib.portalBridge(key, tenant, { requireCredential: false });
  if (configured.credentialAvailable !== credential.available) throw new Error('debug_odc_session_api_client_status_changed');
  const nativeSession = credential.available === false;
  // A configured API Client remains authoritative, including 401/403. Never
  // switch identity because its token or permissions were refused.
  const auth = nativeSession ? new OdcStudioSessionAuth({ host: key,
    acquire: services.getNativeSession ?? (async input => (await import('./debug-odc-session.mjs')).getOdcNativeSession(input)) }) : configured.bridge.auth;
  const bridge = nativeSession ? new m.OdcBridge({ config: { ...configured.bridge.config, allowedWriteOperations: new Set() }, auth }) : configured.bridge;
  if (nativeSession) configured.bridge.auth.dispose?.();
  const writer = new m.OdcBridge({ config: { ...bridge.config, allowedWriteOperations: new Set(nativeSession ? [] : WRITES) }, auth });
  const origin = bridge.config.origin;
  // Signed links (source download, upload) are redacted by the generic bridge on purpose; these two calls go direct.
  async function direct(method, url, { body, headers = {}, json = true } = {}) {
    const destination = new URL(url);
    if (destination.origin !== origin || destination.username || destination.password || destination.hash) throw new Error('debug_portal_direct_origin_mismatch');
    if (nativeSession && method !== 'GET') throw new Error('debug_odc_session_native_write_unavailable');
    const token = await bridge.auth.getToken();
    const response = await fetch(url, { method, headers: { accept: 'application/json', authorization: 'Bearer ' + token, ...headers }, body, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`debug_portal_http_${response.status}:${method} ${new URL(url).pathname}`);
    return json ? JSON.parse(text) : text;
  }
  const read = async (operationId, input) => {
    const r = await bridge.execute(operationId, input, 'read');
    if (!r.ok) throw new Error(`debug_portal_read_failed:${operationId}:${r.status ?? r.error?.code}`);
    return r.data;
  };
  const write = async (operationId, input) => {
    const r = await writer.execute(operationId, input, 'write');
    return r; // the caller decides: !ok with a status is a definite refusal; a thrown/timeout result is uncertain
  };
  const readApplication = async moduleKey => {
    if (!/^[A-Za-z0-9_+]{22}$/.test(moduleKey ?? '')) throw new Error('debug_odc_session_application_key_invalid');
    if (nativeSession) await auth.getToken();
    const authority = nativeSession ? auth.nativeAuthority() : null;
    const reply = await (services.getNativeSession ?? (async input => (await import('./debug-odc-session.mjs')).getOdcNativeSession(input)))({
      host: key, moduleKey, includeToken: false, ...(authority ? { pid: authority.binding.pid, expectedBinding: authority.binding } : {}) });
    if (reply?.metadata?.host !== key || reply.metadata.moduleKey !== moduleKey ||
        authority && reply.metadata.developerKey?.toLowerCase() !== authority.developerKey) throw new Error('debug_odc_session_application_binding_changed');
    return reply.metadata;
  };
  return { host: key, tenant, origin, bridge, read, write, direct, nativeSession, readApplication,
    release: async () => { auth.dispose?.(); return { released: true }; } };
}

export async function latestRevision(portal, assetKey) {
  const data = await portal.read('asset-repository-api-v1:get:/assets/{assetKey}/latest-revision', { path: { assetKey } });
  return { revision: data.revision, name: data.name, applicationType: data.applicationType ?? null, revisionDateTime: data.revisionDateTime ?? null };
}

// Revision deployed in a stage (environment) for this asset.
export async function deployedRevision(portal, assetKey, environmentKey, { strict = false } = {}) {
  // Seen live: {results:[{type, key, deployments:[{environmentKey, revision, deploymentDateTime, ...}]}]}; a library has no row.
  const data = await portal.read('portfolio-api-v2:get:/deployed-assets', { query: { environmentKey, key: assetKey } });
  const rows = (data?.results ?? []).filter(r => strict ? r.key?.toLowerCase() === assetKey.toLowerCase() : r.key === assetKey);
  const row = rows[0];
  const deployments = (row?.deployments ?? []).filter(d => strict ? d.environmentKey?.toLowerCase() === environmentKey.toLowerCase() : d.environmentKey === environmentKey);
  if (strict && (!Array.isArray(data?.results) || rows.length > 1 || deployments.length > 1)) throw new Error('debug_wrapper_reconcile_incomplete');
  const deployment = deployments[0];
  return { revision: Number.isInteger(deployment?.revision) ? deployment.revision : null, type: row?.type ?? null, deployedAt: deployment?.deploymentDateTime ?? null };
}

export async function downloadRevision(portal, assetKey, revision, file, { fetchImpl = globalThis.fetch } = {}) {
  const url = `${portal.origin}${BASE.assets}/assets/${encodeURIComponent(assetKey)}/revisions/${revision}/source-code`;
  const info = await portal.direct('GET', url);
  if (!info.sourceCodeBinaryUrl) throw new Error('debug_portal_source_unavailable');
  const response = await fetchImpl(info.sourceCodeBinaryUrl, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error('debug_portal_source_download_' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { file, sha256: sha256(bytes), bytes: bytes.length };
}

// Upload the candidate and create the revision with the commit message. Returns {state, revision} where state is
// created | refused (server answered an error: nothing was created) | uncertain (no answer: never retried).
export async function createRevision(portal, file, commitMessage, { operation, onStage, fetchImpl = globalThis.fetch } = {}) {
  checkedOperation(operation);
  if (operation.phase !== 'prepared') throw new Error('debug_wrapper_write_already_submitted');
  if (typeof onStage !== 'function') throw new Error('debug_wrapper_write_journal_required');
  const candidateBytes = fs.readFileSync(file);
  if (commitMessage !== operation.comment || portal.host !== operation.binding.tenant || portal.origin !== operation.binding.portalOrigin ||
      sha256(candidateBytes) !== operation.candidateSha256) throw new Error('debug_wrapper_write_binding_invalid');
  let upload;
  try {
    phase(operation, onStage, { phase: 'upload-request-submitted', uploadSubmittedAt: new Date().toISOString() });
    upload = await portal.direct('POST', `${portal.origin}${BASE.assets}/uploads`);
    if (!upload.uploadUrl) return { state: 'uncertain', stage: 'upload-request' };
  } catch { return { state: 'uncertain', stage: 'upload-request' }; }
  let put;
  try {
    phase(operation, onStage, { phase: 'upload-put-submitted' });
    put = await fetchImpl(upload.uploadUrl, { method: 'PUT', body: candidateBytes, redirect: 'error', signal: AbortSignal.timeout(180_000) });
  } catch { return { state: 'uncertain', stage: 'upload' }; }
  if (!put.ok) return { state: 'refused', stage: 'upload', status: put.status };
  let r;
  try {
    phase(operation, onStage, { phase: 'revision-submitted', revisionSubmittedAt: new Date().toISOString() });
    r = await portal.write('asset-repository-api-v1:post:/assets', { body: { fileUri: upload.uploadUrl, commitMessage } });
  }
  catch { return { state: 'uncertain', stage: 'create-revision' }; }
  if (r.ok) {
    if (!Number.isInteger(r.data?.revision) || r.data.revision <= operation.baseRevision || r.data.applicationKey?.toLowerCase() !== operation.binding.assetKey)
      return { state: 'uncertain', stage: 'create-revision' };
    try { phase(operation, onStage, { phase: 'revision-created', revision: r.data.revision, expectedCreatedByHash: authorHash(r.data.revisionUserKey) }); }
    catch { return { state: 'uncertain', stage: 'create-revision-record' }; }
    return { state: 'created', revision: r.data.revision, applicationKey: r.data.applicationKey };
  }
  return r.status ? { state: 'refused', stage: 'create-revision', status: r.status, code: safeCode(r.error?.code) } : { state: 'uncertain', stage: 'create-revision', code: safeCode(r.error?.code) };
}

export async function publish(portal, assetKey, revision, environmentKey, { timeoutMs = 15 * 60_000, poll = 5000, onProgress, operation, onStage } = {}) {
  checkedOperation(operation);
  if (operation.phase !== 'revision-created') throw new Error('debug_wrapper_write_already_submitted');
  if (typeof onStage !== 'function') throw new Error('debug_wrapper_write_journal_required');
  if (portal.host !== operation.binding.tenant || portal.origin !== operation.binding.portalOrigin || assetKey.toLowerCase() !== operation.binding.assetKey ||
      environmentKey.toLowerCase() !== operation.binding.environmentKey || revision !== operation.revision) throw new Error('debug_wrapper_write_binding_invalid');
  let r;
  try {
    phase(operation, onStage, { phase: 'publish-submitted', publication: { phase: 'submitted', submittedAt: new Date().toISOString(), expectedDeployedByHash: null } });
    r = await portal.write('deployments-api-v1:post:/publish-operations', { body: { operation: 'Publish', assetKey, revision, environmentKey } });
  }
  catch { return { state: 'uncertain', stage: 'publish-request' }; }
  if (!r.ok) return r.status ? { state: 'refused', stage: 'publish-request', status: r.status, code: safeCode(r.error?.code) } : { state: 'uncertain', stage: 'publish-request' };
  const key = r.data?.key, started = Date.now();
  if (!UUID.test(key ?? '')) return { state: 'uncertain', stage: 'publish-request' };
  try { phase(operation, onStage, { phase: 'publish-accepted', publication: { ...operation.publication, phase: 'accepted',
    operationKey: key, expectedDeployedByHash: authorHash(r.data.deployedBy) } }); }
  catch { return { state: 'uncertain', stage: 'publish-record', operationKey: key }; }
  onProgress?.({ publishOperation: key, status: r.data?.status });
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, poll));
    let op; try { op = await portal.read('deployments-api-v1:get:/publish-operations/{operationKey}', { path: { operationKey: key } }); } catch { continue; }
    onProgress?.({ publishOperation: key, status: op.status });
    if (['Finished', 'FinishedWithError'].includes(op.status)) {
      phase(operation, onStage, { phase: op.status === 'Finished' ? 'published' : 'publish-failed',
        publication: { ...operation.publication, phase: op.status === 'Finished' ? 'finished' : 'failed' } });
      return op.status === 'Finished' ? { state: 'published', operationKey: key, revision, finishedDateTime: op.finishedDateTime }
        : { state: 'failed', operationKey: key, revision };
    }
  }
  return { state: 'uncertain', stage: 'publish-wait', operationKey: key };
}

async function pages(portal, api, query, pathValue, { maxPages = 10 } = {}) {
  const results = []; let offset = 0;
  for (let i = 0; i < maxPages; i++) {
    const data = await portal.read(api, { ...(pathValue ? { path: pathValue } : {}), query: { ...query, limit: 100, offset } });
    if (!Array.isArray(data?.results) || !data.page) throw new Error('debug_wrapper_reconcile_incomplete');
    results.push(...data.results);
    const next = data.page.nextPageOffset;
    if (next === null || next === undefined && Number.isInteger(data.page.totalResults) && offset + data.results.length >= data.page.totalResults) return results;
    if (!Number.isInteger(next) || next <= offset) throw new Error('debug_wrapper_reconcile_incomplete');
    offset = next;
  }
  throw new Error('debug_wrapper_reconcile_incomplete');
}

// This is exclusively a read path. Zero/ambiguous/incomplete evidence stays uncertain, even if a matching source
// is observed. It never submits a revision, publication, upload or fallback mutation.
export async function reconcileWrite(portal, operation, binding, { directory, download = downloadRevision, maxPages = 10 } = {}) {
  const uncertain = reason => ({ state: 'uncertain', reason, operationId: operation?.id });
  try { checkedOperation(operation, binding); }
  catch { return uncertain('binding-mismatch'); }
  if (portal.host !== binding.tenant || portal.origin !== binding.portalOrigin) return uncertain('binding-mismatch');
  try {
    const revisions = await pages(portal, 'asset-repository-api-v1:get:/assets/{assetKey}/revisions',
      { commitMessage: operation.comment }, { assetKey: binding.assetKey }, { maxPages });
    const matches = revisions.filter(r => r.commitMessage === operation.comment);
    if (matches.length !== 1) return uncertain(matches.length ? 'ambiguous-revisions' : 'revision-not-found');
    const revision = matches[0];
    if (revision.assetKey?.toLowerCase() !== binding.assetKey || revision.name !== binding.module || !Number.isInteger(revision.revision) ||
        revision.revision <= operation.baseRevision || operation.revision != null && revision.revision !== operation.revision)
      return uncertain('revision-metadata-mismatch');
    if (!HASH.test(operation.expectedCreatedByHash ?? '') || authorHash(revision.createdBy) !== operation.expectedCreatedByHash)
      return uncertain('revision-author-unproved');
    const base = await download(portal, binding.assetKey, operation.baseRevision, path.join(directory, `base-r${operation.baseRevision}.oml`));
    const candidate = await download(portal, binding.assetKey, revision.revision, path.join(directory, `candidate-r${revision.revision}.oml`));
    if (base.sha256 !== operation.baseSha256 || candidate.sha256 !== operation.candidateSha256) return uncertain('source-hash-mismatch');
    const deployed = await deployedRevision(portal, binding.assetKey, binding.environmentKey, { strict: true });
    if (!operation.publication?.submittedAt) return uncertain('publication-not-submitted');
    const publications = await pages(portal, 'deployments-api-v1:get:/publish-operations', {
      environmentKey: binding.environmentKey, assetKey: binding.assetKey, revision: revision.revision,
      createdDateSince: operation.publication.submittedAt }, null, { maxPages });
    const matching = publications.filter(p => p.assetKey?.toLowerCase() === binding.assetKey && p.revision === revision.revision && p.operation === 'Publish');
    if (matching.length !== 1) return uncertain(matching.length ? 'ambiguous-publications' : 'publication-not-found');
    const publication = matching[0];
    if (!UUID.test(publication.key ?? '') || operation.publication.operationKey && publication.key !== operation.publication.operationKey)
      return uncertain('publication-metadata-mismatch');
    if (!HASH.test(operation.publication.expectedDeployedByHash ?? '') || authorHash(publication.deployedBy) !== operation.publication.expectedDeployedByHash)
      return uncertain('publication-author-unproved');
    const detail = await portal.read('deployments-api-v1:get:/publish-operations/{operationKey}', { path: { operationKey: publication.key } });
    if (detail.key !== publication.key || detail.assetKey?.toLowerCase() !== binding.assetKey || detail.revision !== revision.revision ||
        detail.operation !== 'Publish' || authorHash(detail.deployedBy) !== operation.publication.expectedDeployedByHash || detail.status !== publication.status)
      return uncertain('publication-metadata-mismatch');
    if (!['Finished', 'FinishedWithError'].includes(detail.status)) return uncertain('publication-not-terminal');
    return { state: detail.status === 'Finished' ? 'published' : 'failed', operationId: operation.id, revision: revision.revision,
      publishOperation: publication.key, developmentRevision: deployed.revision, currentlyDeployed: deployed.revision === revision.revision,
      sourceHashesConfirmed: true, modelAuthorBound: true, portalAuthorsConfirmed: true };
  } catch { return uncertain('read-incomplete'); }
}
