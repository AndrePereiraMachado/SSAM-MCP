// The next call of an answer, written out so the model does not have to work it out (hidden reasoning is about half of
// the time between steps). Pure: no I/O, no clock, no state. shapeToolResult (responses.mjs) passes every structured
// answer through addNextSteps.
//   success: `next`, a short list (1..2) of READ calls whose arguments come from the answer itself: a capture -> its map
//            and its reader; a summarized reading -> the read of its navigation and its next page; a built candidate ->
//            check-base; a checked base -> preview. Never a write (deliver, merge, publish, create, data, environment,
//            access, portal, close): READS is the only set a success `next` may name.
//   refusal: `continuation` {tool, arguments, why} when the tool gave none, from a small table by code (by gate on ODC).
//            Without the data the call needs, nothing is added (never invented). The user's words never travel: only
//            the marker, and only in the continuation of a tool that already requires words (o11_deliver).
// Exact answers ("delivered", "published", "closed", or their Portuguese aliases in older records) pass untouched; an
// answer with nothing to add keeps its identity.
import { RESULT, RESULT_ALIASES, resultIs } from './result-values.mjs';

// ONE marker for the user's words (owner rule 15/10/2026: English only): continuations.mjs WORDS, the same in o11-cycle.mjs,
// tool-input.mjs, ui-precheck.mjs, prototype-op.mjs and ssam.mjs (checked by the test). The Portuguese marker of the releases
// before, "<palavras do usuário>", is no words either: any "<...>" is refused as words (o11-cycle.mjs, standing-grants.mjs).
export const WORDS_MARKER = "<the user's own words>";
export const JOB_MARKER = '<corrected job>';
export const KEY_MARKER = '@<key>';
export const EXACT = new Set([RESULT.delivered, RESULT.deliveredAndPublished, RESULT.published, RESULT.closed,
  ...Object.keys(RESULT_ALIASES).filter(k => resultIs(k, 'delivered', 'deliveredAndPublished', 'published', 'closed'))]);
// `result` of a deliver whose change is merged: whatever its publish said, the delivery is never repeated.
const DELIVERED = { has: value => resultIs(value, 'delivered', 'deliveredAndPublished') };
// The only tools a success `next` may name: reads (readOnly annotations), never a write.
export const READS = new Set(['ssam_map', 'o11_inspect', 'studio_inspect', 'studio_snapshot', 'studio_check_base', 'studio_preview']);
const MAX_NEXT = 2, MAX_CALL_BYTES = 1024, MAX_CONTINUATION_BYTES = 2048;

const SHA = /^[a-fA-F0-9]{64}$/;
const TASK_ID = /^[0-9a-fA-F]{32}$/;
const str = v => typeof v === 'string' && v.length > 0;
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const step = (tool, args, why) => ({ tool, arguments: args, ...(why ? { why } : {}) });
const laneOf = (tool, args, opts) => opts?.lane ?? args?.lane ?? (/^(studio_|odc_|hybrid_)/.test(tool) ? 'odc' : 'o11');
// ODC Studio tools keep the Studio the call chose.
const withPid = (args, input) => (Number.isInteger(input?.pid) ? { ...args, pid: input.pid } : args);

// ---- success: reads that follow from the answer
// A capture (.oml): its module map first (the documented first read), then the lane reader with the hash guard. A file
// needs no Studio, so no pid.
function captureReads(lane, file, sha) {
  if (!str(file) || !/\.oml$/i.test(file)) return null;
  const guard = SHA.test(sha ?? '') ? { expectedSourceSha256: sha } : null;
  const map = step('ssam_map', { lane, target: file, ...guard });
  if (!guard) return [map];
  return [map, lane === 'odc' ? step('studio_inspect', { target: file, ...guard }) : step('o11_inspect', { oml: file, ...guard })];
}

// The reading filters worth repeating on the next page: defaults (the schema fills them in) are left out.
const INSPECT_FILTERS = { path: null, select: null, kind: null, name: null, text: null, properties: null, scope: null,
  usages: false, includeInternal: false, depth: 3, max: 60, all: false, full: false, budget: 60000 };
// A summarized reading (navigation): the read of one of its targets by @key; a paged list: its next page.
function readingNext(tool, input, value) {
  const fileKey = tool === 'studio_inspect' ? 'target' : 'oml';
  const file = value.navigation?.target ?? value.file;
  const sha = value.navigation?.expectedSourceSha256 ?? value.sourceSha256;
  if (!str(file) || !SHA.test(sha ?? '')) return null;
  const out = [];
  if (isObject(value.navigation))
    out.push(step(tool, { [fileKey]: file, path: KEY_MARKER, expectedSourceSha256: sha }, 'replace <key> with a reference of summary.targets'));
  const nextOffset = value.summary?.nextOffset ?? value.nextOffset;
  if (Number.isInteger(nextOffset) && nextOffset > 0) {
    const filters = {};
    for (const [key, fallback] of Object.entries(INSPECT_FILTERS)) if (input?.[key] != null && input[key] !== fallback) filters[key] = input[key];
    out.push(step(tool, { [fileKey]: file, ...filters, offset: nextOffset, expectedSourceSha256: sha }));
  }
  return out;
}

const SUCCESS = {
  o11_studio: (input, v) => (input.command === 'snapshot' ? captureReads('o11', v.path, v.sha256) : null),
  studio_snapshot: (input, v) => captureReads('odc', v.path, v.sha256),
  studio_latest: (input, v) => captureReads('odc', v.path, v.sha256),
  o11_environment: (input, v) => (input.action === 'download' ? captureReads('o11', v.file) : null),
  o11_inspect: (input, v) => readingNext('o11_inspect', input, v),
  studio_inspect: (input, v) => readingNext('studio_inspect', input, v),
  // The ODC cycle: open and refresh -> the map of the module (the first read, which captures it); never a bare snapshot:
  // studio_deliver captures the live module by itself, and a snapshot as `next` read as a step owed before delivering.
  // The manual cycle stays chained for a person who asks for it: build -> check-base -> preview. The step after preview is
  // a merge: a write, never a `next`.
  studio_open: (input, v) => (str(v.module ?? input.module) ? [step('ssam_map', withPid({ lane: 'odc', target: v.module ?? input.module }, input))] : null),
  studio_refresh_references: input => (str(input.module) ? [step('ssam_map', withPid({ lane: 'odc', target: input.module }, input))] : null),
  studio_build: (input, v) => (!input.newModule && str(v.manifest) ? [step('studio_check_base', { manifest: v.manifest })] : null),
  studio_manifest: (input, v) => (str(v.manifest) ? [step('studio_check_base', { manifest: v.manifest })] : null),
  studio_check_base: input => (str(input.manifest) ? [step('studio_preview', withPid({ manifest: input.manifest }, input))] : null),
};

// ---- refusal: the continuation by code
const CONNECT = step('ssam_connect', { lane: 'o11' }, 'connect again the Service Studio open on the O11 lane');
const O11_STATUS = step('o11_studio', { command: 'status' }, 'read the Studio state before repeating');
const NO_DIALOGS = step('o11_studio', { command: 'wait', args: { condition: 'no-dialogs' } },
  'ask the person to answer the dialog in the Studio; this call waits for it to close');
const doctor = lane => step('ssam_doctor', { lane }, 'shows what the lane is missing; the integrator or the user builds it, never the session');
const o11Only = fixed => (tool, input, value, lane) => (lane === 'o11' ? fixed : null);

// The correction of a refusal that named its job (job, jobSha256): a JSON Patch over that job (job-patch.mjs), never the
// whole job again; the op the kernel named (failedOp) goes into the path when known. An array job (jobShape 'array', or
// the inline array of the call) is patched at /<i>/..., an {ops} job at /ops/<i>/....
const patchMarker = (failedOp, array) => [{ op: 'replace', path: (array ? '/' : '/ops/') + (Number.isInteger(failedOp) ? failedOp : '<i>') + '/<field>', value: '<corrected value>' }];
function correction(value, input) {
  if (!str(value.job) || !SHA.test(value.jobSha256 ?? '')) return { job: JOB_MARKER };
  const array = value.jobShape === 'array' || (value.jobShape == null && input?.patch == null && Array.isArray(input?.job));
  return { patch: patchMarker(value.failedOp, array), basedOn: { job: value.job, sha256: value.jobSha256 } };
}
// A refused O11 delivery: the corrected job (a patch over the refused one when the refusal named it), with the refused
// task closed first (closePrevious). Not after a merge kept for review (the person decides about it in the Studio) and
// not without the module of the call. Only a call made with until=apply validates again: the kernel records stage
// "apply" for the headless validation of every delivery, so the stage never decides it.
function redeliver(tool, input, value) {
  // Merged already (a publish answer came with it): repeating the delivery would deliver twice. A publish `skipped` means
  // the merge was not clean and nothing was delivered: the corrected delivery is still the next call.
  const published = isObject(value.publish) && value.publish.outcome !== 'skipped';
  if (tool !== 'o11_deliver' || !str(input.module) || value.merged === true || DELIVERED.has(value.result) || published) return null;
  const fix = correction(value, input);
  const how = fix.patch ? 'fix only what the messages point to with a patch over basedOn (the job of this refusal; paths by name: actions/<Action>/steps/<as>/..., '
    + 'or the patchByName of the refusal) or send in job only the changed actions with the same basedOn, without resending the whole job'
    : 'fix the job by the messages above';
  const same = { module: input.module, ...fix, ...(Array.isArray(input.checks) && input.checks.length ? { checks: input.checks } : {}),
    ...(isObject(input.producers) ? { producers: input.producers } : {}),
    ...(Array.isArray(input.captureProducers) && input.captureProducers.length ? { captureProducers: input.captureProducers } : {}),
    ...(str(input.expectedEnvironment) ? { expectedEnvironment: input.expectedEnvironment } : {}) };
  if (input.until === 'apply')
    return step('o11_deliver', { ...same, until: 'apply', authorize: WORDS_MARKER },
      how + ', and validate again. authorize: the user\'s words in place of the marker.');
  if (TASK_ID.test(value.taskId ?? ''))
    return step('o11_deliver', { ...same, closePrevious: value.taskId, authorize: WORDS_MARKER },
      how + ', and deliver again; closePrevious closes the refused task. authorize: the user\'s words in place of the marker.');
  return null;
}

// The codes the shaper gives a refusal that had none (refusal-codes.mjs, A20): the index of the discover that no longer
// matches its sources and an unusable lane go to the doctor and the connect; a lost ODC bridge pipe to the attach.
const DOCTOR_ALL = step('ssam_doctor', {}, 'the discover index does not match the sources of this release; the doctor shows the release and the index; do not repeat the read before it');
const connectLane = (tool, input) => {
  const lane = ['o11', 'odc'].includes(input?.lane) ? input.lane : tool === 'studio_doctor' ? 'odc' : null;
  return step('ssam_connect', lane ? { lane } : {}, 'connects the already open Studio of the lane, without saving, publishing or restarting; then repeat the doctor');
};
const attach = (tool, input, value, lane) => (lane === 'odc' ? step('studio_attach', withPid({}, input), 'the ODC Studio bridge is not attached; attach it and repeat the call') : null);
// G11 (FarmaVirtual 2026-10-10, call 131): an @key the reader did not resolve; the map of the same capture (pinned by its
// hash) says what the key is and lists what lives under it. The map's own refusal already says it, so nothing for ssam_map.
function keyMap(tool, input, value) {
  if (tool !== 'o11_inspect' && tool !== 'studio_inspect') return null;
  const text = typeof value.error === 'string' ? value.error : value.error?.message ?? '';
  const key = /key in this (?:snapshot|capture): (@\S+)/.exec(text)?.[1] ?? (str(input.path) && /^@[^/]+$/.test(input.path) ? input.path : null);
  const file = tool === 'o11_inspect' ? input.oml ?? value.capture?.oml ?? value.file : input.target ?? value.file;
  const sha = input.expectedSourceSha256 ?? value.capture?.sha256;
  if (!key || !str(file) || !/\.oml$/i.test(file)) return null;
  return step('ssam_map', { lane: tool === 'o11_inspect' ? 'o11' : 'odc', target: file, parent: key, ...(SHA.test(sha ?? '') ? { expectedSourceSha256: sha } : {}) },
    'the key did not resolve in this reader; the map of the same capture says what it is and lists what lives under it');
}

const BY_CODE = new Map([
  ...['O11_NOT_CONNECTED', 'O11_NOT_SELECTED', 'O11_STUDIO_CHANGED', 'O11_NOT_AUTHORIZED', 'STUDIO_NOT_SELECTED',
    'BRIDGE_NOT_LISTENING', 'BRIDGE_TRANSPORT', 'BRIDGE_PROTOCOL', 'BRIDGE_NO_REPLY'].map(code => [code, o11Only(CONNECT)]),
  ['BRIDGE_TIMEOUT', o11Only(O11_STATUS)],
  ['DIALOG_BLOCKING', o11Only(NO_DIALOGS)],
  ...['O11_READER_UNAVAILABLE', 'CLI_NOT_BUILT', 'COMPONENT_STALE'].map(code => [code, (tool, input, value, lane) => doctor(lane)]),
  ['VALIDATION_REFUSED', redeliver],
  ['DISCOVERY_INDEX_INVALID', () => DOCTOR_ALL],
  ['DOCTOR_LANE_UNUSABLE', connectLane],
  ['BRIDGE_NOT_ATTACHED', attach],
  ['KEY_UNRESOLVED', keyMap],
]);

// ODC Studio gates carry no code: base_drift (the open module changed) and studio_busy (a dialog or a command holds it).
function byGate(tool, input, value, lane) {
  if (lane !== 'odc') return null;
  if (value.gate === 'base_drift' && ['studio_check_base', 'studio_preview', 'studio_merge'].includes(tool) && str(value.module))
    return step('studio_snapshot', withPid({ module: value.module }, input), 'the open module changed since the capture: a new capture, then a new build');
  // The person edited the module in the Studio between the capture and the merge: the same delivery again captures the
  // module as it is now and builds on it; nothing was merged. Without output: the refused attempt claimed that directory
  // (evidence is never overwritten), so the repeated delivery takes a new one.
  if (value.gate === 'base_drift' && tool === 'studio_deliver' && str(input.module) && input.job != null && !isObject(input.patch)) {
    const { output: _claimed, ...again } = input;
    // fase4-24: an inline job is never echoed back (a large job doubled the answer): the same delivery names the job file
    // the proxy wrote for it (nextBasedOn.job), which holds the same job.
    if (typeof again.job !== 'string' && str(value.nextBasedOn?.job)) again.job = value.nextBasedOn.job;
    return step('studio_deliver', again, 'the module changed in the Studio between the capture and the merge; nothing was merged: the same delivery captures the module as it is now and builds again');
  }
  if (value.gate === 'studio_busy') return step('studio_status', withPid({}, input), 'see the dialogs with a choice and the running command; do not repeat before');
  return null;
}

// ---- guards
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
// The user's words of the call (authorize, words, a data request's authorization, the text studio_authorize records).
// No builder copies them; this is the backstop. A long phrase is looked for inside every argument, a short one (a bare
// "sim") only as a whole argument, so a path that merely contains it does not lose its next.
function wordsOf(tool, input) {
  const words = [input?.authorize, input?.words, input?.authorization, input?.request?.authorization, tool === 'studio_authorize' ? input?.text : undefined];
  return words.filter(w => typeof w === 'string' && w.trim()).map(w => w.trim());
}
function carries(value, words) {
  if (typeof value === 'string') return words.some(w => (w.length >= 8 ? value.includes(w) : value.trim() === w));
  if (Array.isArray(value)) return value.some(v => carries(v, words));
  return isObject(value) && Object.values(value).some(v => carries(v, words));
}
const safe = (tool, input, call, limit) => isObject(call) && str(call.tool) && isObject(call.arguments) && bytes(call) <= limit
  && !carries(call.arguments, wordsOf(tool, input));

// Success: the read calls that follow (null when none). Only READS, at most MAX_NEXT, each small.
export function successNext(tool, input = {}, value = {}) {
  const build = SUCCESS[tool];
  if (!build || !isObject(value) || value.ok !== true || EXACT.has(value.result)) return null;
  const calls = (build(input ?? {}, value) ?? []).filter(c => READS.has(c?.tool) && safe(tool, input, c, MAX_CALL_BYTES)).slice(0, MAX_NEXT);
  return calls.length ? calls : null;
}

// Refusal: the continuation the table deduces (null when the answer lacks what the call needs).
export function refusalContinuation(tool, input = {}, value = {}, opts = {}) {
  if (!isObject(value) || value.ok !== false) return null;
  const lane = laneOf(tool, input, opts);
  const code = str(value.code) ? value.code : isObject(value.error) && str(value.error.code) ? value.error.code : null;
  const call = (code && BY_CODE.get(code)?.(tool, input ?? {}, value, lane)) || byGate(tool, input ?? {}, value, lane);
  // A copy: the fixed steps above are shared by every answer.
  return call && safe(tool, input, call, MAX_CONTINUATION_BYTES) ? structuredClone(call) : null;
}

// Delivered, and the publish of the same call (deliver {publish:true}) failed or is uncertain: only the publish goes on,
// never the delivery. A failed publish is published again with the user's words (marker); an uncertain one is read in
// the publish log first (never republished blind).
function publishOnly(tool, input, value) {
  const code = str(value.code) ? value.code : null;
  if (tool === 'o11_deliver' && str(input.module)) {
    if (code === 'PUBLISH_UNCERTAIN') return step('o11_studio', { command: 'publish-log', args: { module: input.module } }, 'the delivery is done; read the result of the publication before anything else (never repeat the delivery)');
    if (code === 'PUBLISH_FAILED') return step('o11_publish', { module: input.module, authorize: WORDS_MARKER }, 'the delivery is done; fix what the messages of the publication point to and publish again (never repeat the delivery). authorize: the user\'s words in place of the marker.');
  }
  if (tool === 'studio_deliver') {
    if (code === 'PUBLISH_UNCERTAIN') return step('studio_command', withPid({ command: 'publish-log', args: str(input.module) ? [input.module] : [] }, input), 'the delivery is done; read the result of the publication (never repeat the delivery)');
    if (code === 'PUBLISH_FAILED' && str(value.manifest)) return step('studio_publish', withPid({ manifest: value.manifest, wait: true }, input), 'the delivery is done; fix what the messages of the publication point to and publish again (never repeat the delivery)');
  }
  return null;
}

// ---- the screens of a prototype import (docs/PROTOTIPO-NATIVO.md 1.4): each screen of report.prototype with its link,
// so the answer that delivered them already carries what the person opens. Pure; a link is URL construction only (it never
// proves the publication). appUrl: the delivery's appLinks.appUrl (ODC), else https://<host>/<Module>/ (O11 Reactive).
export function prototypeAppUrl({ lane, host = null, module = null, appLinks = null } = {}) {
  if (isObject(appLinks) && str(appLinks.appUrl)) return appLinks.appUrl.endsWith('/') ? appLinks.appUrl : appLinks.appUrl + '/';
  if (lane !== 'o11' || !str(host) || !str(module) || /[\s/\\]/.test(module)) return null;
  const origin = /^https?:\/\//i.test(host) ? host.replace(/\/+$/, '') : 'https://' + host.replace(/\/+$/, '');
  return origin + '/' + encodeURIComponent(module) + '/';
}
// {<screen name>: url} for the screens of a receipt; empty without an app URL. The default screen also opens at the app URL.
export function prototypeScreenLinks(receipt, appUrl) {
  if (!str(appUrl) || !Array.isArray(receipt?.screens)) return {};
  return Object.fromEntries(receipt.screens.filter(s => isObject(s) && str(s.name)).map(s => [s.name, appUrl + encodeURIComponent(s.name)]));
}

// The answer with `next` (success) or `continuation` (refusal) added when one is obvious; otherwise the same object.
// An existing `next` or `continuation` is never replaced.
export function addNextSteps(tool, input, value, opts = {}) {
  if (isObject(value) && value.ok === false && DELIVERED.has(value.result)) {
    if (value.continuation != null) return value;
    const call = publishOnly(tool, input ?? {}, value);
    return call && safe(tool, input, call, MAX_CONTINUATION_BYTES) ? { ...value, continuation: call } : value;
  }
  if (!isObject(value) || EXACT.has(value.result)) return value;
  if (value.ok === true && value.next === undefined) {
    const next = successNext(tool, input ?? {}, value);
    return next ? { ...value, next } : value;
  }
  if (value.ok === false && value.continuation == null) {
    const continuation = refusalContinuation(tool, input ?? {}, value, opts);
    return continuation ? { ...value, continuation } : value;
  }
  return value;
}
