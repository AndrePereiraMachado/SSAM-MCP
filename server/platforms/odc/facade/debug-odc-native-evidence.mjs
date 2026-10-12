// Private worker only. Reuse the existing CurrentUser DPAPI + current-user ACL
// vault, outside the repository. Immutable CreateNew records also reserve a
// cleanup attempt before network I/O, so a lost DELETE cannot be retried.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { privateRequest } from './debug-invoke-http.mjs';
import { openOdcAppUserSession } from './debug-app-user-worker.mjs';
import { sameAppUserTarget } from './debug-app-user.mjs';

const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
export const CLEANUP_STAGES = Object.freeze(['prepared', 'negotiated', 'channel-opened', 'cleanup-attempt', 'cleanup-accepted', 'finished']);
const STAGES = new Set(CLEANUP_STAGES);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error('debug_odc_native_evidence_' + code); };
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x20\x7f]/.test(value);

function reference(operationId, probeId, stage) {
  if (!GUID.test(operationId ?? '') || !/^[A-Za-z0-9_.:-]{1,120}$/.test(probeId ?? '') || !STAGES.has(stage)) fail('scope_invalid');
  const value = hash(`ssam-odc-native-evidence/1|${operationId}|${probeId}|${stage}`).slice(0,32);
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}

function validate(record) {
  reference(record?.operationId, record?.probeId, record?.stage);
  const binding = record.binding, data = record.data;
  if (record.schema !== 'ssam-odc-native-evidence/1' || !binding || binding.lane !== 'odc'
    || !/^[a-f0-9]{32}$/.test(binding.sessionId ?? '') || !data || typeof data !== 'object' || Array.isArray(data)) fail('scope_invalid');
  let url; try { url = new URL(binding.runtimeUrl); } catch { fail('scope_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' + binding.app + '/') fail('scope_invalid');
  if (data.path?.startsWith(url.pathname + 'screenservices/') !== true || data.hub !== url.pathname + 'moduleservices/debugger/requestshub'
    || !HASH.test(data.requestSha256 ?? '') || !Number.isFinite(data.leaseExpiresAt)
    || (data.nativeCallContextId !== null && (typeof data.nativeCallContextId !== 'string' || data.nativeCallContextId.length > 300 || /[\x00-\x1f\x7f]/.test(data.nativeCallContextId)))
    || (data.connectionToken !== null && !token(data.connectionToken)) || (data.connectionId !== null && !token(data.connectionId))
    || (data.nativeUserAgent !== null && !/^Microsoft SignalR\/\d{1,3}\.\d{1,3} \([^()\x00-\x1f]{1,160}\)$/.test(data.nativeUserAgent))
    || (data.appUserKeySha256 !== null && !HASH.test(data.appUserKeySha256))) fail('record_invalid');
  const allowed = new Set(['path','hub','requestSha256','nativeCallContextId','connectionToken','connectionId','nativeUserAgent','leaseExpiresAt',
    'startedAt','deadline','appUserKeySha256','executeRequestSubmissions','responseCompleted','cleanupAttempted','cleanupAccepted','cleanupStatus','transport']);
  if (Object.keys(data).some(key => !allowed.has(key))) fail('record_invalid');
  return record;
}

export function createOdcNativeEvidence({ operationId, binding, sessionId, vault = privateRequest } = {}) {
  const target = { ...binding, lane: 'odc', sessionId };
  return Object.freeze({
    async write(stage, probeId, data) {
      const record = validate({ schema: 'ssam-odc-native-evidence/1', operationId, probeId, stage, binding: target, at: new Date().toISOString(), data });
      try {
        const saved = await vault('Seal', reference(operationId, probeId, stage), record);
        if (saved?.ok !== true) fail('not_saved');
      } catch { fail('not_saved'); }
      // No credential reference, ccid, connection URL/token or private values cross the worker boundary.
      return { sealed: true, sha256: hash(JSON.stringify(record)) };
    },
  });
}

/** Separate channel cleanup only, using the same still-valid app-user session.
 * This cannot negotiate, poll, invoke, refresh credentials or unlock an operation.
 * A previous cleanup attempt (even with a lost answer) fails CreateNew before I/O.
 */
export async function reconcileOdcNativeCleanup({ operationId, probeId, descriptor } = {},
  { vault = privateRequest, openSession = openOdcAppUserSession, fetchImpl = fetch, clock = Date.now } = {}) {
  let record;
  try { record = validate(await vault('Open', reference(operationId, probeId, 'channel-opened'))); }
  catch { fail('unavailable'); }
  if (record.operationId !== operationId || record.probeId !== probeId || record.stage !== 'channel-opened'
    || !sameAppUserTarget(record.binding, descriptor?.binding) || record.data.transport !== 'long-polling'
    || !token(record.data.connectionToken) || !HASH.test(record.data.appUserKeySha256 ?? '')
    || clock() >= record.data.leaseExpiresAt || Date.parse(descriptor.expiresAt) <= clock()) fail('cleanup_scope_invalid');
  const session = await openSession(descriptor);
  if (!sameAppUserTarget(record.binding, session?.binding) || typeof session?.accessToken !== 'string' || !session.accessToken
    || session.accessToken.length > 65536 || /[\x00-\x20\x7f]/.test(session.accessToken)
    || hash(session?.userKey ?? '') !== record.data.appUserKeySha256 || Date.parse(session.expiresAt) <= clock()) fail('cleanup_scope_invalid');
  const evidence = createOdcNativeEvidence({ operationId, binding: record.binding, sessionId: record.binding.sessionId, vault });
  const data = { ...record.data, cleanupAttempted: true, cleanupAccepted: false };
  const attempt = await evidence.write('cleanup-attempt', probeId, data);
  if (clock() >= record.data.leaseExpiresAt || Date.parse(descriptor.expiresAt) <= clock() || Date.parse(session.expiresAt) <= clock()) fail('cleanup_scope_invalid');
  const url = new URL(record.data.hub, record.binding.runtimeUrl); url.searchParams.set('id', record.data.connectionToken);
  let response;
  try {
    const cleanupBudgetMs = Math.max(1, Math.floor(Math.min(15000, record.data.leaseExpiresAt - clock(),
      Date.parse(descriptor.expiresAt) - clock(), Date.parse(session.expiresAt) - clock())));
    response = await fetchImpl(url, { method: 'DELETE', redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(cleanupBudgetMs),
      headers: { authorization: 'Bearer ' + session.accessToken, 'x-requested-with': 'XMLHttpRequest', 'x-signalr-user-agent': record.data.nativeUserAgent } });
  } catch { return { completed: false, uncertain: true, cleanupAttempt: attempt, businessRequestSent: false, lockRetained: true }; }
  if (response.redirected || (response.url && response.url !== url.href) || response.status < 200 || response.status > 299)
    return { completed: false, uncertain: true, cleanupAttempt: attempt, businessRequestSent: false, lockRetained: true };
  const accepted = await evidence.write('cleanup-accepted', probeId, { ...data, cleanupAccepted: true, cleanupStatus: response.status });
  return { completed: true, uncertain: false, cleanupAttempt: attempt, cleanupAccepted: accepted, businessRequestSent: false,
    executionOutcomeProved: false, lockRetained: true };
}

/** Read-only stages of the reserved channel-cleanup records, from the public run receipt only.
 * Never opens the vault, never sends DELETE and never counts native lease expiry as cleanup proof.
 * A reserved attempt without a sealed acceptance forbids any retry.
 */
export function cleanupRecordStatus(runDir) {
  const file = path.join(runDir, 'receipt.json');
  let bytes, report;
  try { bytes = fs.readFileSync(file); report = JSON.parse(bytes); } catch { return { ok: false, error: 'debug_odc_native_evidence_receipt_unavailable' }; }
  const probes = (report?.cleanup?.receipt?.transport?.probes ?? []).map(probe => {
    const evidence = probe?.correlation?.evidence ?? {};
    const stages = CLEANUP_STAGES.filter(stage => evidence[stage]?.sealed === true && HASH.test(evidence[stage]?.sha256 ?? ''))
      .map(stage => ({ stage, sha256: evidence[stage].sha256 }));
    const has = stage => stages.some(s => s.stage === stage), submitted = (probe?.executeRequestSubmissions ?? 0) > 0;
    const response = !submitted ? 'no submission' : probe.finished === true && probe.uncertain === false ? 'response completed' : 'response unconfirmed';
    const accepted = has('cleanup-accepted'), attempted = accepted || has('cleanup-attempt') || probe?.cleanup?.attempted === true;
    const record = stages.filter(s => ['cleanup-attempt', 'cleanup-accepted'].includes(s.stage)).at(-1) ?? null;
    const [summary, cleanupConfirmed, retryForbidden] = accepted ? [response + ', cleanup accepted', true, true]
      : attempted ? [response + ', cleanup attempt reserved and unconfirmed, retry forbidden', false, true]
      : has('channel-opened') ? [response + ', channel opened without a reserved cleanup attempt', false, false]
      : [response + ', no channel cleanup record', true, false];
    return { probeId: probe?.probeId ?? null, responseCompleted: response === 'response completed', stages, record, summary, cleanupConfirmed, retryForbidden };
  });
  const summary = !probes.length ? 'no channel cleanup record' : probes.length === 1 ? probes[0].summary
    : probes.map(p => p.probeId + ': ' + p.summary).join('; ');
  // Top-level record: the reserved cleanup record that still forbids a retry, else the first one present.
  const record = (probes.find(p => p.record && !p.cleanupConfirmed) ?? probes.find(p => p.record))?.record ?? null;
  return { ok: true, operationId: report?.operationId ?? null, summary, record, probes,
    cleanupConfirmed: probes.every(p => p.cleanupConfirmed), retryForbidden: probes.some(p => p.retryForbidden),
    leaseExpiryIsProof: false, networkActions: 0, deleteResent: false, receipt: { path: 'receipt.json', sha256: hash(bytes) } };
}
