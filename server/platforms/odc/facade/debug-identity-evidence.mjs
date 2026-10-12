// Deterministic per-boundary identity/role evidence (ssam-identity-evidence/1).
// The ONLY code allowed to lift appUserIdentityProved, rolesProved and
// propagationProved on an O11/ODC call boundary. Inputs are native observations
// already produced by the debugger (witness Booleans read in published frames,
// private-compare booleans, access-API role reads); nothing is evaluated here.
// Debugger UserName, ccid and requestId are never evidence. Output carries
// booleans and reason codes only: no identity, marker or role-set value.
const KEY = /^[A-Za-z0-9_+]{22}$/, HASH = /^[a-f0-9]{64}$/, NAME = /^[A-Za-z_][A-Za-z0-9_]{0,120}$/;
// caller-user-id: CallerUser = GetUserId() in the caller module; user-id: ObservedUser = GetUserId() in the producer.
// Only these two may be the operands of an identity private-compare (P03 mode 'identity').
const KINDS = new Set(['user-present', 'user-equals-caller', 'run-marker', 'role', 'caller-user-id', 'user-id']);
const IDENTITY_TYPES = new Set(['Identifier', 'LongInteger', 'Text']);
const IGNORED = new Set(['username', 'ccid', 'requestid']);
const fail = code => { throw new Error('debug_identity_evidence_' + code); };
const branded = new WeakSet();
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 200;
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
// Native Boolean rendering: typed client wire or server scalar rendering. Incomplete reads never count.
function nativeBoolean(value) {
  if (!value || typeof value !== 'object' || [value.unavailable, value.undefined, value.trimmed, value.deferred, value.redacted].includes(true)) return null;
  if (!['Boolean', 'Scalar'].includes(value.type)) return null;
  return value.value === true || value.value === 'True' || value.value === 'true' ? true : value.value === false || value.value === 'False' || value.value === 'false' ? false : null;
}
function nativeText(value) {
  if (!value || typeof value !== 'object' || [value.unavailable, value.undefined, value.trimmed, value.deferred, value.redacted].includes(true)) return null;
  if (!['Text', 'Scalar'].includes(value.type) || typeof value.value !== 'string') return null;
  // Server scalar renderings quote Text.
  return value.type === 'Scalar' && /^".*"$/s.test(value.value) ? value.value.slice(1, -1) : value.value;
}
function authenticated(auth) {
  if (auth?.lane === 'o11') return auth.nativeCheckRegisteredPassed === true || auth.restBasicAnswered === true;
  if (auth?.lane === 'odc') return auth.authenticated === true && HASH.test(auth.userKeySha256 ?? '');
  return false;
}
function ignoredInputs(input) {
  const found = new Set();
  const scan = value => { if (value && typeof value === 'object' && !Array.isArray(value)) for (const k of Object.keys(value)) if (IGNORED.has(k.toLowerCase())) found.add(k); };
  scan(input.authState); scan(input.response); scan(input.cleanup); scan(input);
  for (const r of input.witnessReads ?? []) scan(r);
  return [...found].sort();
}

export function buildIdentityEvidence({ boundary, authState, witnesses = [], witnessReads = [], compares = [], marker = {}, roleStates = {},
  response, cleanup, callerModuleKey } = {}) {
  const boundaryKey = boundary?.actionKey ?? boundary?.signatureKey;
  const producer = boundary?.producerModuleKey, caller = boundary?.callerModuleKey ?? callerModuleKey;
  if (!KEY.test(boundaryKey ?? '') || !KEY.test(producer ?? '')) fail('boundary_invalid');
  const idReasons = new Set(), roleReasons = {};
  const external = boundary.kind === 'external-logic-reference';
  if (external) idReasons.add('external-logic-not-in-debugger-model');
  if (!KEY.test(caller ?? '') || caller === producer) idReasons.add('caller-module-unbound');
  const auth = authenticated(authState);
  if (!auth) idReasons.add('not-authenticated');
  const answered = response?.answered === true && response.uncertain === false && response.sent !== false;
  if (!answered) idReasons.add(response?.uncertain === false ? 'response-unanswered' : 'response-uncertain');
  const cleaned = cleanup?.confirmed === true;
  if (!cleaned) idReasons.add('cleanup-unconfirmed');
  const declared = (Array.isArray(witnesses) ? witnesses : []).filter(w => w && KINDS.has(w.kind) && text(w.id) && w.qualified === true &&
    w.moduleKey === (w.kind === 'caller-user-id' ? caller : producer) && KEY.test(w.moduleKey ?? '') && KEY.test(w.functionKey ?? '') && KEY.test(w.assignmentNodeKey ?? '') && Array.isArray(w.afterNodeKeys) &&
    w.afterNodeKeys.length && w.afterNodeKeys.every(k => KEY.test(k) && k !== w.assignmentNodeKey) && (w.kind !== 'role' || NAME.test(w.role ?? '')));
  // Qualified reads of one witness kind: frame owner = boundary producer, after the published assignment.
  const reads = (kind, role, reasons) => {
    const decls = declared.filter(w => w.kind === kind && (role === undefined || w.role === role));
    if (!decls.length) { reasons.add(kind + '-witness-undeclared'); return []; }
    const out = [];
    for (const r of Array.isArray(witnessReads) ? witnessReads : []) {
      const d = decls.find(w => w.id === r?.witnessId);
      if (!d) continue;
      if (r.moduleKey !== producer || r.moduleKey !== d.moduleKey || r.functionKey !== d.functionKey) { reasons.add('witness-read-wrong-module'); continue; }
      if (!d.afterNodeKeys.includes(r.nodeKey)) { reasons.add('witness-read-before-assignment'); continue; }
      if (!text(r.threadId) || !text(r.pauseId) || !text(r.scenario)) { reasons.add('witness-read-unbound'); continue; }
      const value = kind === 'run-marker' ? nativeText(r.value) : nativeBoolean(r.value);
      if (value === null) { reasons.add('witness-read-incomplete'); continue; }
      out.push({ threadId: r.threadId, pauseId: r.pauseId, scenario: r.scenario, value });
    }
    return out;
  };
  // Identity: one scenario on one thread carrying present=true, caller equality and that scenario's marker.
  // Pooled O11 worker thread ids repeat across requests, so the scenario is part of the join key.
  const at = r => r.scenario + '\u0000' + r.threadId;
  const present = reads('user-present', undefined, idReasons).filter(r => r.value === true);
  if (!present.length) idReasons.add('user-present-witness-not-true');
  const equalThreads = new Map();
  for (const r of reads('user-equals-caller', undefined, new Set())) if (r.value === true) equalThreads.set(at(r), 'witness');
  // Identity compare: exactly the caller's and B's user-id witnesses, read after their assignments, same pause/thread/scenario.
  const bound = (o, kind, moduleKey) => { const d = declared.find(w => w.kind === kind && w.id === o?.witnessId);
    return !!d && o.moduleKey === moduleKey && o.functionKey === d.functionKey && d.afterNodeKeys.includes(o.nodeKey); };
  const compareList = Array.isArray(compares) ? compares : [];
  for (const c of compareList) {
    const res = c?.result, ops = Array.isArray(c?.operands) ? c.operands : [];
    if (c.mode !== 'identity' || res?.equal !== true || res.bothNonEmpty !== true || res.sameNativeType !== true || !IDENTITY_TYPES.has(res.valueType) ||
        res.count !== 2 || ops.length !== 2) continue;
    if (!text(ops[0]?.pauseId) || !text(ops[0]?.threadId) || !text(ops[0]?.scenario) ||
        ops.some(o => o?.pauseId !== ops[0].pauseId || o.threadId !== ops[0].threadId || o.scenario !== ops[0].scenario)) continue;
    if (!(bound(ops[0], 'caller-user-id', caller) && bound(ops[1], 'user-id', producer) || bound(ops[1], 'caller-user-id', caller) && bound(ops[0], 'user-id', producer))) continue;
    if (!equalThreads.has(at(ops[0]))) equalThreads.set(at(ops[0]), 'private-compare');
  }
  if (!equalThreads.size) idReasons.add(compareList.length ? 'identity-compare-unbound' : 'caller-equality-not-proved');
  const markerReads = reads('run-marker', undefined, idReasons);
  const markerThreads = new Set(markerReads.filter(r => text(marker?.[r.scenario]) && r.value === marker[r.scenario]).map(at));
  if (!markerReads.length) idReasons.add('run-marker-unread');
  else if (!markerThreads.size) idReasons.add('run-marker-mismatch');
  const threads = present.map(at).filter(t => equalThreads.has(t) && markerThreads.has(t));
  if (present.length && equalThreads.size && markerThreads.size && !threads.length) idReasons.add('evidence-thread-mismatch');
  const identityCore = !external && auth && answered && cleaned && threads.length > 0 && KEY.test(caller ?? '') && caller !== producer;
  if (identityCore) idReasons.clear();
  // Roles: granted scenario true AND revoked scenario false (or native NotRegistered, zero business submissions).
  const roleNames = [...new Set([...declared.filter(w => w.kind === 'role').map(w => w.role),
    ...Object.keys(roleStates && typeof roleStates === 'object' ? roleStates : {}).filter(n => NAME.test(n))])].sort();
  const rolesProved = {};
  for (const role of roleNames) {
    const reasons = new Set(), st = roleStates?.[role];
    if (external) reasons.add('external-logic-not-in-debugger-model');
    if (!auth) reasons.add('not-authenticated');
    if (!answered) reasons.add('response-not-answered');
    if (!cleaned) reasons.add('cleanup-unconfirmed');
    const g = st?.granted, v = st?.revoked;
    if (![g?.before, g?.after, v?.before, v?.after].every(x => x?.read === true)) reasons.add('role-access-read-missing');
    else if (g.before.granted !== true || g.after.granted !== true || v.before.granted !== false || v.after.granted !== false) reasons.add('role-grant-state-mismatch');
    if (!text(g?.scenario) || !text(v?.scenario) || g.scenario === v.scenario) reasons.add('role-scenarios-unbound');
    const rs = reads('role', role, reasons);
    const gr = rs.filter(r => r.scenario === g?.scenario), vr = rs.filter(r => r.scenario === v?.scenario);
    if (!gr.length || gr.some(r => r.value !== true)) reasons.add('role-granted-witness-not-true');
    const refused = v?.refusal?.native === 'NotRegistered' && v.refusal.businessSubmissions === 0;
    if (vr.some(r => r.value !== false)) reasons.add('role-revoked-witness-true');
    else if (!vr.length && !refused) reasons.add('role-revoked-witness-not-false');
    rolesProved[role] = reasons.size === 0;
    roleReasons[role] = [...reasons].sort();
  }
  const identity = identityCore;
  const allRoles = roleNames.length > 0 && roleNames.every(r => rolesProved[r]);
  const propagationReasons = [...(identity ? [] : ['app-user-identity-not-proved']), ...(roleNames.length ? allRoles ? [] : ['roles-not-proved'] : ['roles-undeclared'])];
  const evidence = deepFreeze({ schema: 'ssam-identity-evidence/1', boundaryKey, boundaryKind: boundary.kind ?? null,
    callerModuleKey: KEY.test(caller ?? '') ? caller : null, producerModuleKey: producer,
    appUserIdentityProved: identity, rolesProved, propagationProved: identity && allRoles,
    reasons: { appUserIdentityProved: [...idReasons].sort(), roles: roleReasons, propagationProved: propagationReasons },
    evidence: { authenticated: auth, responseAnswered: answered, cleanupConfirmed: cleaned, userPresent: present.length > 0,
      callerEquality: identity ? equalThreads.get(threads[0]) : null, markerEqual: markerThreads.size > 0 },
    ignoredInputs: ignoredInputs(arguments[0] ?? {}) });
  branded.add(evidence);
  return evidence;
}
export const isIdentityEvidence = value => branded.has(value);
// Copy of a call-boundary contract with builder evidence attached. Flags are
// lifted only from branded evidence of the exact boundary (kind, action, producer
// and caller); the rest stay false. A boundary identity occurring twice in one
// contract is ambiguous and never lifted; two evidences for one identity are refused.
export function applyIdentityEvidence(contract, evidences = []) {
  if (!Array.isArray(contract?.boundaries) || !Array.isArray(evidences)) fail('contract_invalid');
  if (evidences.some(e => !branded.has(e))) fail('unbranded');
  const id = x => JSON.stringify([x.boundaryKind, x.boundaryKey, x.producerModuleKey, x.callerModuleKey]);
  if (new Set(evidences.map(id)).size !== evidences.length) fail('duplicate');
  const matches = (b, x) => x.boundaryKey === (b.actionKey ?? b.signatureKey) && x.producerModuleKey === b.producerModuleKey &&
    x.boundaryKind === (b.kind ?? null) && (b.callerModuleKey == null || x.callerModuleKey === b.callerModuleKey);
  const same = (a, b) => a.kind === b.kind && (a.actionKey ?? a.signatureKey) === (b.actionKey ?? b.signatureKey) &&
    a.producerModuleKey === b.producerModuleKey && a.callerModuleKey === b.callerModuleKey;
  const unlifted = { identityEvidence: null, appUserIdentityProved: false, rolesProved: false, propagationProved: false };
  const boundaries = contract.boundaries.map(b => {
    if (contract.boundaries.filter(o => same(o, b)).length > 1) return { ...b, ...unlifted, identityEvidenceAmbiguous: true };
    const e = evidences.find(x => matches(b, x));
    if (!e) return { ...b, ...unlifted };
    const roles = Object.values(e.rolesProved);
    return { ...b, identityEvidence: e, appUserIdentityProved: e.appUserIdentityProved,
      rolesProved: roles.length > 0 && roles.every(Boolean), propagationProved: e.propagationProved };
  });
  const every = flag => boundaries.length > 0 && boundaries.every(b => b[flag] === true);
  return { ...contract, boundaries, appUserIdentityProved: every('appUserIdentityProved'), rolesProved: every('rolesProved'), propagationProved: every('propagationProved') };
}
