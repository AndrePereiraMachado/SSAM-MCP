import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const SCHEMA = 'ssam-preview-profile/1';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
export function check(ok, code, message = code) { if (!ok) fail(code, message); }
export function pinned(pin) {
  check(pin && path.isAbsolute(pin.file ?? '') && /^[a-f0-9]{64}$/.test(pin.sha256 ?? ''), 'PREVIEW_PIN_REQUIRED');
  const bytes = fs.readFileSync(pin.file);
  check(digest(bytes) === pin.sha256, 'PREVIEW_PIN_CHANGED', 'A prepared preview file changed; prepare the profile again.');
  return bytes;
}
// Windows refuses to replace a file while another process has it open (EPERM; EACCES or EBUSY from a scan): the manager
// reads the worker's receipt while the worker replaces it, and with a reader polling, most replaces of a tight loop fail.
// A lost receipt left the worker running with a stale state ('starting' after a startup failure, 'stopping' after a
// stop). The replace is retried with backoff, bounded, as debug-odc-active-binding.mjs does.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function retrying(action, budgetMs) {
  const deadline = performance.now() + budgetMs;
  for (let attempt = 0; ; attempt++) {
    try { return action(); }
    catch (error) { if (!TRANSIENT.has(error.code) || performance.now() >= deadline) throw error; pause(Math.min(100, 2 ** attempt, Math.max(1, deadline - performance.now()))); }
  }
}
export function atomicJson(file, value, { retryMs = 4000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { retrying(() => fs.renameSync(temporary, file), retryMs); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* already gone */ } throw error; }
}
export function loadProfile(pin) {
  const p = JSON.parse(pinned(pin));
  check(p.schema === SCHEMA && /^[a-z0-9][a-z0-9-]{0,79}$/.test(p.id ?? ''), 'PREVIEW_PROFILE_SCHEMA');
  check(['o11', 'odc'].includes(p.lane), 'PREVIEW_LANE');
  for (const name of ['app', 'moduleKey', 'tenant']) check(typeof p.target?.[name] === 'string' && p.target[name].length > 0, 'PREVIEW_TARGET');
  check(Array.isArray(p.screens) && p.screens.length > 0 && p.screens.every(s => typeof s.name === 'string' && typeof s.key === 'string'), 'PREVIEW_SCREENS');
  check(new Set(p.screens.map(s => s.key)).size === p.screens.length && new Set(p.screens.map(s => s.name)).size === p.screens.length, 'PREVIEW_DUPLICATE_SCREEN');
  check(p.syntheticData === true && p.realBackend === false && p.realAccessValidated === false, 'PREVIEW_LOCAL_SCENARIO_REQUIRED');
  check(p.implementation === (p.lane === 'o11' ? 'o11-native' : 'odc-adapted-o11'), 'PREVIEW_IMPLEMENTATION');
  check(Array.isArray(p.limitations) && p.limitations.length > 0, 'PREVIEW_LIMITS_REQUIRED');
  pinned(p.host.module);
  const host = JSON.parse(pinned(p.host.config));
  check(host.startAllowed === true && host.target?.moduleKey === p.target.moduleKey, 'PREVIEW_HOST_TARGET');
  check(/^127\.0\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4])$/.test(host.bindHost ?? '') && Number.isInteger(host.port) && host.port > 0 && host.port <= 65535, 'PREVIEW_LOOPBACK_REQUIRED');
  check(p.screens.some(s => s.key === host.target.screenKey), 'PREVIEW_HOST_SCREEN');
  check(p.automaticWatching === !!p.watcher, 'PREVIEW_WATCHER_DECLARATION');
  if (p.watcher) {
    check(p.lane === 'odc', 'PREVIEW_WATCHER_UNQUALIFIED');
    pinned(p.watcher.module);
    const watcher = JSON.parse(pinned(p.watcher.config));
    check(watcher.target?.moduleKey === p.target.moduleKey && watcher.target?.host === p.target.tenant, 'PREVIEW_WATCHER_TARGET');
    check(watcher.hostConfig?.sha256 === p.host.config.sha256, 'PREVIEW_WATCHER_HOST');
  }
  return { profile: p, host, pin };
}
export function publicProfile(p) {
  return { id: p.id, lane: p.lane, target: p.target, screens: p.screens, implementation: p.implementation,
    automaticWatching: p.automaticWatching, syntheticData: true, realBackend: false, realAccessValidated: false, limitations: p.limitations };
}
export function summarizeState(state) {
  const promoted = state?.promoted;
  const pipeline = state?.pipeline;
  const observed=state?.rendered?.buildId===promoted?.buildId?state?.rendered:null;
  const readiness=state?.error?'update-error':observed?.kind==='render-error'?'render-error':!promoted?'waiting-for-build':observed?.kind?.startsWith('rendered')?'rendered':'waiting-for-browser';
  return { readiness, build: promoted ? { id: promoted.buildId, sourceSha256: promoted.sourceSha256, sourceRevision: promoted.sourceRevision, capturedAt: promoted.capturedAt, promotedAt: promoted.promotedAt } : null,
    pipeline: pipeline ? { status: pipeline.status, sourceStale: pipeline.sourceStale ?? null, automaticWatching: pipeline.automaticWatching ?? null, observedRevision: pipeline.observedRevision ?? null, timings: pipeline.timings ?? null, error: pipeline.error ? { code: pipeline.error.code, message: pipeline.error.message } : null } : null,
    render: state?.rendered ? { buildId: state.rendered.buildId, screenKey: state.rendered.entryScreenKey, kind: state.rendered.kind, observedAt: state.rendered.observedAt, elapsedMs: state.rendered.elapsedMs, message: state.rendered.details?.entryFailure?.message ?? state.rendered.details?.summary ?? null } : null,
    error: state?.error ? { code: state.error.code, message: state.error.message } : null,
    note: 'Render is the latest observation of one browser, not proof of every screen or every connected browser.' };
}
