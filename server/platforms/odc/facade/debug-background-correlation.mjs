// Request-bound background observation shared by the O11 and ODC runners.
// Thread ids are reused across requests (DebugSession.cs TraceStop), so a native
// ThreadEnd attests a target thread only with the same (threadId, native request
// fingerprint) and a later native eventId. ThreadEnd carries no outcome: this
// never sets scheduling, ownership or completion; those stay separate facts.
import { rootCoverage } from './debug-scope-completeness.mjs';

const SHA = /^[a-f0-9]{64}$/;
const fail = code => { throw new Error('debug_background_correlation_' + code); };
// The kernel writes the fingerprint only for an original requestId; provenance false is no fingerprint.
const fingerprintOf = row => row?.nativeRequestIdProvenance !== false && SHA.test(row?.nativeRequestIdSha256 ?? '') ? row.nativeRequestIdSha256 : null;
const eventOf = row => /^\d{1,30}$/.test(String(row?.eventId ?? '')) ? BigInt(row.eventId) : null;
const thread = row => typeof row?.threadId === 'string' || Number.isSafeInteger(row?.threadId) ? String(row.threadId) : null;

export function backgroundThreadOutcome(lines, functionKey) {
  if (!Array.isArray(lines)) fail('lines_invalid');
  const frames = lines.filter(row => row && row.kind !== 'thread-end' && row.functionKey === functionKey && thread(row) !== null);
  const groups = new Map();
  for (const frame of frames) {
    const fingerprint = fingerprintOf(frame), id = thread(frame) + '\n' + (fingerprint ?? ''), at = eventOf(frame);
    const group = groups.get(id) ?? { threadId: thread(frame), fingerprint, last: 0n, ordered: true };
    // One frame without a native eventId makes the whole group unordered.
    if (at === null) group.ordered = false; else if (at > group.last) group.last = at;
    groups.set(id, group);
  }
  const threads = new Set(frames.map(thread));
  const ends = lines.filter(row => row?.kind === 'thread-end' && threads.has(thread(row)));
  const bound = [];
  let loose = 0, unmatched = 0;
  for (const end of ends) {
    const fingerprint = fingerprintOf(end), at = eventOf(end), candidates = [...groups.values()].filter(g => g.threadId === thread(end));
    // true: later; false: not later (refused); null: no comparable native order.
    const later = g => at === null || !g.ordered ? null : at > g.last;
    const same = fingerprint && candidates.find(g => g.fingerprint === fingerprint && later(g) === true);
    if (same) { bound.push(fingerprint); continue; }
    // A fingerprint missing on either side may show that the thread ended; it never binds a request.
    if (candidates.some(g => (!fingerprint || !g.fingerprint) && later(g) !== false)) { loose++; continue; }
    unmatched++;
  }
  const fingerprints = [...new Set(frames.map(fingerprintOf).filter(Boolean))];
  const allFingerprinted = frames.length > 0 && frames.every(frame => fingerprintOf(frame));
  const requestFingerprintConsistent = allFingerprinted && fingerprints.length === 1;
  const endedFingerprints = [...new Set(bound)];
  return { captured: frames.length > 0, targetObserved: frames.length > 0, targetFrames: frames.length, targetThreads: threads.size,
    fingerprints, allTargetFramesFingerprinted: allFingerprinted, requestFingerprintConsistent,
    observedThreadEnds: bound.length + loose, requestBoundThreadEnds: bound.length, endedFingerprints, unmatchedEnds: unmatched,
    traceVerified: frames.length > 0 && bound.length + loose > 0,
    requestBound: requestFingerprintConsistent && endedFingerprints.includes(fingerprints[0]),
    threadEndOutcome: 'native-thread-end-carries-no-outcome', executionCompleted: false };
}

// Root coverage of a background scope across observed stops, from native reads only
// (debug-scope-completeness rootCoverage). A root counts complete when one stop read
// it completely; native undefined/unavailable and policy redaction keep their evidence.
const NATIVE = new Set(['native-unavailable-in-context', 'native-undefined', 'native-binary-summary']);
const RANK = ['complete', 'native-unavailable', 'redacted', 'incomplete'];
export function backgroundValuesCoverage({ modelRoots = [], omittedRoots = 0, stops = [] } = {}) {
  if (!Array.isArray(modelRoots) || !Array.isArray(stops) || !Number.isSafeInteger(omittedRoots) || omittedRoots < 0) fail('coverage_input_invalid');
  const names = [...new Set(modelRoots.filter(n => typeof n === 'string' && n))], states = new Map();
  let invalidStops = 0;
  for (const stop of stops) {
    let coverage;
    const variables = Array.isArray(stop?.scopeVariables) ? stop.scopeVariables : null;
    try { if (!variables || !variables.length) throw Error('empty'); coverage = rootCoverage(variables, stop.reads ?? []); }
    catch { invalidStops++; continue; }
    for (const variable of variables) {
      const name = typeof variable.name === 'string' && variable.name ? variable.name : variable.reference;
      if (!names.includes(name)) names.push(name);
      // Judge each stop on its own; the most informative stop wins (complete > native > redacted > incomplete).
      const leaves = coverage.incompleteLeaves.filter(leaf => leaf.root === variable.reference);
      const reasons = [...new Set(leaves.map(leaf => leaf.reason))].sort();
      const state = !leaves.length ? 'complete' : reasons.every(r => NATIVE.has(r)) ? 'native-unavailable'
        : reasons.includes('private-redacted') ? 'redacted' : 'incomplete';
      const evidence = [...new Map(leaves.filter(leaf => NATIVE.has(leaf.reason)).map(leaf =>
        [leaf.reason, { reason: leaf.reason, ...(leaf.evidence?.flag ? { flag: leaf.evidence.flag } : {}) }])).values()];
      const previous = states.get(name);
      if (!previous || RANK.indexOf(state) < RANK.indexOf(previous.state)) states.set(name, { name, category: variable.category, state, reasons, evidence });
    }
  }
  const roots = names.map(name => {
    const entry = states.get(name);
    if (!entry) return { name, state: 'not-enumerated' };
    return { name, category: entry.category, state: entry.state, ...(entry.state === 'complete' ? {} : { reasons: entry.reasons }),
      ...(entry.state === 'native-unavailable' ? { evidence: entry.evidence } : {}) };
  });
  return { coverageSource: 'rootCoverage', valuesComplete: roots.length > 0 && omittedRoots === 0 && roots.every(r => r.state === 'complete'),
    roots, nativeUnavailableRoots: roots.filter(r => r.state === 'native-unavailable').map(({ name, evidence }) => ({ name, evidence })),
    redactedRoots: roots.filter(r => r.state === 'redacted').map(({ name }) => ({ name })),
    incompleteRoots: roots.filter(r => ['incomplete', 'not-enumerated'].includes(r.state)).map(({ name, state, reasons }) => ({ name, state, ...(reasons ? { reasons } : {}) })),
    omittedRoots, stopsObserved: stops.length, invalidStops, valuesReturned: false };
}
