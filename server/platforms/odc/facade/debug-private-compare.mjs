// Public boolean comparison of private native values. A private read keeps only
// an HMAC-SHA256 fingerprint under a random per-public-session key, in memory,
// behind an opaque handle. Results are booleans: never a value, hash or key.
// Not an evaluator: it compares two values already produced by the native debugger.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const fail = code => { throw new Error('debug_private_compare_' + code); };
const HANDLE = /^pc_[a-f0-9]{32}$/, SHA = /^[a-f0-9]{64}$/, MEMBER = /^[a-f0-9]{32}(?:[a-f0-9]{16})?$/;
const IDENTITY_TYPES = new Set(['Identifier', 'LongInteger', 'Text']);
const TEXT = new Set(['Text', 'Email', 'PhoneNumber']), NUMBER = new Set(['Integer', 'LongInteger', 'Decimal', 'Currency']);
const INDEX = /^\[(?:0|[1-9][0-9]{0,8})\]$/;
const zero = v => typeof v === 'number' ? v === 0 : typeof v === 'string' && /^[-+]?0+(?:\.0+)?$/.test(v);
const sorted = entries => {
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (entries.some(([name], i) => i && entries[i - 1][0] === name)) fail('value_incomplete');
  return entries;
};
// A native list is comparable only with its declared Length and every index.
function listComplete(entries) {
  const length = entries.find(([name]) => name === 'Length')?.[1], n = Number(length?.[2]);
  const indexes = entries.filter(([name]) => INDEX.test(name));
  if (!Number.isSafeInteger(n) || n < 0 || indexes.length !== n || indexes.some(([name]) => Number(name.slice(1, -1)) >= n)) fail('value_incomplete');
  return n;
}
// Exact native typed form: type tag, native value and named children. Display
// paths are not identity; trimmed/deferred/unavailable/summary wire never compares.
function canonical(node, depth = 0) {
  if (depth > 64 || !node || typeof node !== 'object' || Array.isArray(node) || typeof node.type !== 'string' ||
      !node.type || node.type.length > 64 || !Object.hasOwn(node, 'value')) fail('value_incomplete');
  if ([node.unavailable, node.undefined, node.trimmed, node.deferred].includes(true)) fail('value_incomplete');
  const value = node.value;
  if (Array.isArray(node.children)) {
    // Server native container: values are native renderings, children carry paths.
    if (typeof node.path !== 'string' || !node.path || value !== null && typeof value !== 'string' ||
        typeof value === 'string' && (value === '-undefined-' || value.startsWith('-unavailable') || /^BinaryData \([0-9]+ bytes\)$/.test(value)))
      fail('value_incomplete');
    const children = sorted(node.children.map(child => {
      if (typeof child?.path !== 'string' || !child.path.startsWith(node.path + '.')) fail('value_incomplete');
      return [child.path.slice(node.path.length + 1), canonical(child, depth + 1)];
    }));
    if (node.type === 'RecordList') listComplete(children);
    // A compound rendering repeats its descendants; compare the children only.
    return ['s', node.type, children.length ? null : value, children];
  }
  if (value !== null && typeof value === 'object') {
    // Client native wire: Record fields / RecordList items are typed wire nodes.
    if (Array.isArray(value)) fail('value_incomplete');
    const fields = sorted(Object.entries(value).map(([name, child]) => [name, canonical(child, depth + 1)]));
    if (node.type === 'RecordList') listComplete(fields);
    return ['c', node.type, fields];
  }
  if (['Record', 'RecordList'].includes(node.type) || node.type === 'BinaryData' && node.encoding !== 'base64' ||
      value !== null && !['string', 'number', 'boolean'].includes(typeof value)) fail('value_incomplete');
  return ['v', node.type, value];
}
// Native default value: NullIdentifier, 0, empty Text, False or an empty list.
// The server wire renders scalars without a data type, quoting Text. Called
// only after canonical() proved the list Length matches its indexed items.
function nativeEmpty(node) {
  const v = node.value;
  if (node.type === 'RecordList') return (Array.isArray(node.children) ? node.children.map(c => c.path.slice(node.path.length + 1))
    : Object.keys(v ?? {})).every(name => !INDEX.test(name));
  if (v === null || v === undefined) return true;
  if (typeof v === 'object' || Array.isArray(node.children) && node.children.length) return false;
  if (TEXT.has(node.type)) return v === '';
  if (NUMBER.has(node.type)) return zero(v);
  if (node.type === 'Boolean') return v === false || v === 'False' || v === 'false';
  if (node.type === 'Identifier') return v === '' || zero(v);
  if (node.type === 'Scalar' || node.type === 'Unknown') return v === '' || v === '""' || v === 'False' || zero(v);
  return v === '';
}

export function createPrivateCompareSession({ sessionId, lane, runtime, anchorProvider } = {}, { random = randomBytes, maxHandles = 4096 } = {}) {
  if (anchorProvider !== undefined && typeof anchorProvider !== 'function') fail('anchor_provider_invalid');
  const key = random(32), records = new Map(), members = new Map(), anchors = new WeakMap();
  let closed = false;
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('key_invalid');
  const forget = record => { record.mac?.fill(0); record.mac = null; };
  function seal(value) {
    const type = typeof value?.type === 'string' && value.type.length <= 64 ? value.type : null;
    let canon, mac = null, empty = null;
    try { canon = JSON.stringify(canonical(value)); empty = nativeEmpty(value); } catch { canon = undefined; }
    if (canon !== undefined) mac = createHmac('sha256', key).update('ssam-private-compare/1\n').update(canon).digest();
    canon = undefined;
    return { mac, complete: mac !== null, type, empty };
  }
  function fingerprint(envelope, member) {
    if (closed || member.released) fail('closed');
    const c = envelope?.context;
    if (c?.sessionId !== member.nativeSessionId || lane && c.platform !== lane || runtime && c.runtime !== runtime) fail('binding_invalid');
    if (records.size >= maxHandles) fail('handle_budget');
    // Native request provenance binds members of one O11 group to one request.
    const correlation = c.correlation;
    const requestFingerprint = correlation?.nativeRequestIdProvenance === true && SHA.test(correlation.nativeRequestIdSha256 ?? '')
      ? correlation.nativeRequestIdSha256 : null;
    const handle = 'pc_' + Buffer.from(random(16)).toString('hex');
    if (!HANDLE.test(handle) || records.has(handle)) fail('handle_invalid');
    records.set(handle, { ...seal(envelope.value), member, nativeSessionId: member.nativeSessionId, requestFingerprint });
    return handle;
  }
  function compare(handles, options = {}) {
    if (closed) fail('closed');
    if (!options || typeof options !== 'object' || Array.isArray(options)) fail('options_invalid');
    // No caller-supplied comparison values: this is not an identity oracle.
    if (Object.keys(options).some(k => !['mode', 'anchor'].includes(k))) fail('caller_value_refused');
    const mode = options.mode ?? 'equality', anchor = options.anchor;
    if (!['equality', 'identity'].includes(mode)) fail('mode_invalid');
    if (anchor !== undefined && anchor !== 'app-user') fail('anchor_invalid');
    if (!Array.isArray(handles)) fail('operands_invalid');
    if (handles.some(h => typeof h !== 'string')) fail('caller_value_refused');
    if (handles.some(h => !HANDLE.test(h))) fail('handle_invalid');
    const count = handles.length + (anchor ? 1 : 0);
    if (count > 8) fail('budget');
    if (count < 2 || new Set(handles).size !== handles.length) fail('operands_invalid');
    const operands = handles.map(h => { const r = records.get(h); if (!r || r.member.released) fail('handle_unavailable'); return r; });
    if (new Set(operands.map(r => r.nativeSessionId)).size > 1) {
      const requests = new Set(operands.map(r => r.requestFingerprint));
      if (requests.size !== 1 || requests.has(null)) fail('request_mismatch');
    }
    let anchored;
    try {
      if (anchor) {
        if (!anchorProvider) fail('anchor_unavailable');
        let token;
        try { token = anchorProvider({ anchor, lane, runtime, seal: value => { const t = Object.freeze({}); anchors.set(t, seal(value)); return t; } }); }
        catch { fail('anchor_unavailable'); }
        // Synchronous only: an asynchronous provider is refused, never awaited.
        if (typeof token?.then === 'function') token.then(() => {}, () => {});
        anchored = token && typeof token === 'object' ? anchors.get(token) : undefined;
        if (!anchored) fail('anchor_unavailable');
        anchors.delete(token); operands.push(anchored);
      }
      if (operands.some(r => !r.complete)) fail('value_incomplete');
      if (mode === 'identity' && operands.some(r => !IDENTITY_TYPES.has(r.type))) fail('type_unsupported');
      const sameNativeType = operands.every(r => r.type === operands[0].type);
      let equal = sameNativeType;
      for (const r of operands.slice(1)) equal = timingSafeEqual(r.mac, operands[0].mac) && equal;
      return { equal, bothNonEmpty: operands.every(r => r.empty === false), sameNativeType,
        valueType: sameNativeType ? operands[0].type : null, count };
    } finally { if (anchored) forget(anchored); }
  }
  return Object.freeze({
    // One member per native debug session. Release (stop) destroys its handles.
    member(nativeSessionId) {
      if (closed) fail('closed');
      if (typeof nativeSessionId !== 'string' || !MEMBER.test(nativeSessionId) || members.has(nativeSessionId)) fail('member_invalid');
      const state = { nativeSessionId, released: false };
      members.set(nativeSessionId, state);
      return Object.freeze({
        fingerprint: envelope => fingerprint(envelope, state),
        release() {
          state.released = true;
          for (const [handle, record] of records) if (record.member === state) { forget(record); records.delete(handle); }
          return { released: true };
        },
      });
    },
    compare,
    close() {
      if (!closed) {
        closed = true;
        for (const record of records.values()) forget(record);
        for (const state of members.values()) state.released = true;
        records.clear(); members.clear(); key.fill(0);
      }
      return { closed: true, handles: 0 };
    },
    receipt: () => ({ ...(typeof sessionId === 'string' ? { sessionId } : {}), closed, handles: records.size, members: members.size, persisted: false }),
  });
}
export function compareHandles(session, handles, options = {}) {
  if (typeof session?.compare !== 'function') fail('session_unavailable');
  return session.compare(handles, options);
}
export const privateCompareHandlePattern = HANDLE;
// Public command {op:'private-compare', handles, mode?, anchor?}; session
// addressing (sessionId, stop, generation) is stripped by the coordinator first.
// Any other field is a caller value and refused. Errors keep the code, re-prefixed.
export function privateCompareCommand(session, input, prefix = 'debug_private_compare_') {
  if (typeof prefix !== 'string' || !/^debug_[a-z0-9_]*_$/.test(prefix)) fail('prefix_invalid');
  if (typeof session?.compare !== 'function') fail('session_unavailable');
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.op !== 'private-compare') fail('operation_invalid');
    if (Object.keys(input).some(k => !['op', 'handles', 'mode', 'anchor'].includes(k))) fail('caller_value_refused');
    const { equal, bothNonEmpty, sameNativeType, valueType, count } = session.compare(input.handles,
      { ...(input.mode !== undefined ? { mode: input.mode } : {}), ...(input.anchor !== undefined ? { anchor: input.anchor } : {}) });
    return { op: 'private-compare', equal, bothNonEmpty, sameNativeType, valueType, count };
  } catch (error) {
    throw new Error(prefix + (/^debug_private_compare_([a-z_]+)$/.exec(error?.message ?? '')?.[1] ?? 'failed'));
  }
}
