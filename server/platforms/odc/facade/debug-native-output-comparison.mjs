// Compare already produced values at the transport/SDK boundary. This neither
// evaluates app code nor replaces the native conversion. No values, field names
// or value hashes leave this function, including on mismatch or budget overflow.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
export function nativeOutputComparison(wire, converted, { maxNodes = 20000, maxDepth = 64 } = {}) {
  const report = { schema: 'ssam-native-output-comparison/1', complete: true,
    representationEqual: false, semanticEqualityAssessed: false, comparedScalars: 0,
    unequalScalars: 0, typeDifferences: 0, missingFields: 0, extraFields: 0,
    nativeListEnvelopes: 0 };
  let nodes = 0;
  const activeWire = new WeakSet(), activeConverted = new WeakSet();
  function visit(left, right, depth) {
    if (++nodes > maxNodes || depth > maxDepth) { report.complete = false; return; }
    if (left && typeof left === 'object' && !Array.isArray(left) && Array.isArray(right) &&
        Array.isArray(left.List) && Object.keys(left).every(k => k === 'List' || k === 'EmptyListItem')) {
      report.nativeListEnvelopes++; left = left.List;
    }
    const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (kind(left) !== kind(right)) { report.typeDifferences++; return; }
    if (left === null || typeof left !== 'object') {
      if (!['null', 'string', 'number', 'boolean'].includes(kind(left))) { report.complete = false; return; }
      if (typeof left === 'number' && (!Number.isFinite(left) || !Number.isFinite(right))) { report.complete = false; return; }
      report.comparedScalars++;
      if (left !== right) report.unequalScalars++;
      return;
    }
    if (!Array.isArray(left) && (Object.prototype.toString.call(left) !== '[object Object]' ||
        Object.prototype.toString.call(right) !== '[object Object]')) { report.complete = false; return; }
    if (activeWire.has(left) || activeConverted.has(right)) { report.complete = false; return; }
    activeWire.add(left); activeConverted.add(right);
    const a = Object.keys(left), b = Object.keys(right);
    for (const key of a) {
      if (!Object.hasOwn(right, key)) report.missingFields++;
      else { visit(left[key], right[key], depth + 1); if (!report.complete) break; }
    }
    for (const key of b) if (!Object.hasOwn(left, key)) report.extraFields++;
    if (Array.isArray(left) && left.length !== right.length && a.length === b.length) report.typeDifferences++;
    activeWire.delete(left); activeConverted.delete(right);
  }
  try { visit(wire, converted, 0); } catch { report.complete = false; }
  report.representationEqual = report.complete && !report.unequalScalars && !report.typeDifferences && !report.missingFields && !report.extraFields;
  return report;
}

// Producer End output vs original wire response (private parity). Both sides become
// per-path HMAC fingerprints under one random per-run key, one per canonical class
// of the value (t text, g GUID, n decimal, b boolean, d date, dt date time, tm time,
// z null). A leaf compares in the first class both sides share; none is a type
// difference. Only counts are published: never values, paths or fingerprints, and
// the debugger value never replaces the response.
const NUM = Symbol('wire-number'), GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER = ['g', 'dt', 'd', 'tm', 'n', 'b', 'z', 't'], HEX = /^[a-f0-9]{64}$/;
const TEXT = new Set(['Text', 'Email', 'PhoneNumber']), NUMBER = new Set(['Integer', 'LongInteger', 'Decimal', 'Currency']);
const TEMPORAL = { Date: 'd', DateTime: 'dt', Time: 'tm' };
const isNum = v => !!v && typeof v === 'object' && Object.hasOwn(v, NUM);
// Numbers keep their JSON source text (Long Integer beyond 2^53, Decimal precision).
export const parseWireJson = text => JSON.parse(text, (k, v, c) => typeof v === 'number' ? Object.freeze({ [NUM]: c?.source ?? String(v) }) : v);
function decimal(text) {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d{1,3}))?$/.exec(text ?? ''); if (!m) return null;
  const e = Number(m[4] ?? 0); let digits = m[2] + (m[3] ?? ''), point = m[2].length + e;
  if (point < 0) { digits = '0'.repeat(-point) + digits; point = 0; }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  const int = digits.slice(0, point).replace(/^0+/, '') || '0', frac = digits.slice(point).replace(/0+$/, '');
  const out = frac ? int + '.' + frac : int;
  return out === '0' || m[1] !== '-' ? out : '-' + out;
}
const fraction = f => { const t = (f ?? '').replace(/0+$/, ''); return t ? '.' + t : ''; };
// ISO wire forms and native '#...#' renderings; an offset is converted to UTC (Z is UTC).
function temporal(text) {
  let m = /^(\d{4}-\d{2}-\d{2})$/.exec(text); if (m) return ['d', m[1]];
  m = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?$/.exec(text); if (m) return ['tm', m[1] + ':' + m[2] + ':' + (m[3] ?? '00') + fraction(m[4])];
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(text); if (!m) return null;
  let [, y, mo, d, h, mi, s = '00', f, zone] = m;
  if (zone && zone !== 'Z' && !/^[+-]00:?00$/.test(zone)) {
    const sign = zone[0] === '-' ? 1 : -1, offset = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2));
    const at = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi + sign * offset, +s));
    if (!Number.isFinite(at.getTime())) return null;
    [y, mo, d, h, mi, s] = at.toISOString().slice(0, 19).split(/[-T:]/);
  }
  return ['dt', `${y}-${mo}-${d}T${h}:${mi}:${s}` + fraction(f)];
}
const textForms = s => GUID.test(s) ? { t: s, g: s.toLowerCase() } : { t: s };
export function wireScalarForms(v) {
  if (v === null) return { z: '' };
  if (typeof v === 'boolean') return { b: String(v) };
  if (isNum(v)) { const n = decimal(v[NUM]); return n === null ? null : { n }; }
  if (typeof v === 'number') return Number.isFinite(v) ? { n: decimal(String(v)) } : null;
  if (typeof v !== 'string') return null;
  const forms = textForms(v), n = /^-?\d+(?:\.\d+)?$/.test(v) ? decimal(v) : null, at = temporal(v);
  if (n !== null) forms.n = n; if (at) forms[at[0]] = at[1];
  return forms;
}
// Server native renderings carry no data type: Text is quoted, Boolean True/False, dates #...#.
function renderingForms(r) {
  if (/^".*"$/s.test(r)) return textForms(r.slice(1, -1));
  if (r === 'True' || r === 'False') return { b: r === 'True' ? 'true' : 'false' };
  const n = decimal(r); if (n !== null) return { n };
  const hashed = /^#(.+)#$/s.exec(r); if (hashed) { const at = temporal(hashed[1]); return at ? { [at[0]]: at[1] } : null; }
  if (r === '-undefined-' || r.startsWith('-unavailable') || /^BinaryData \([0-9]+ bytes\)$/.test(r)) return null;
  return textForms(r);
}
export function nativeScalarForms({ type, value }) {
  if (value === null || value === undefined) return { z: '' };
  const number = v => typeof v === 'number' ? (Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)) ? decimal(String(v)) : null)
    : typeof v === 'string' ? decimal(v) : null;
  if (TEXT.has(type)) return typeof value === 'string' ? textForms(value) : null;
  if (NUMBER.has(type)) { const n = number(value); return n === null ? null : { n }; }
  if (type === 'Boolean') return value === true || value === 'True' || value === 'true' ? { b: 'true' } : value === false || value === 'False' || value === 'false' ? { b: 'false' } : null;
  if (TEMPORAL[type]) { const at = typeof value === 'string' ? temporal(value.replace(/^#(.*)#$/s, '$1')) : null; return at?.[0] === TEMPORAL[type] ? { [at[0]]: at[1] } : null; }
  if (type === 'Identifier') { const n = number(value); return n !== null ? { n } : typeof value === 'string' ? textForms(value) : null; }
  if (typeof value === 'boolean') return { b: String(value) };
  if (typeof value === 'number') { const n = number(value); return n === null ? null : { n }; }
  return typeof value === 'string' ? renderingForms(value) : null;
}
// Native list completeness: declared Length and every index, as private-compare requires.
const INDEX = /^\[(?:0|[1-9][0-9]{0,8})\]$/;
function listComplete(named) {
  const length = named.find(([name]) => name === 'Length')?.[1], n = Number(length?.value);
  const indexes = named.filter(([name]) => INDEX.test(name));
  return Number.isSafeInteger(n) && n >= 0 && indexes.length === n && indexes.every(([name]) => Number(name.slice(1, -1)) < n);
}
// roots: [[rootName, nativeValue]] from private reads; rootMap renames a producer root to its wire output.
export function nativeParityLeaves(roots, { rootMap, maxLeaves = 20000, maxDepth = 64 } = {}) {
  const leaves = [], result = { complete: Array.isArray(roots), leaves };
  const visit = (node, at, depth) => {
    if (!result.complete) return;
    if (depth > maxDepth || leaves.length >= maxLeaves || !node || typeof node !== 'object' || typeof node.type !== 'string' ||
        [node.unavailable, node.undefined, node.trimmed, node.deferred].includes(true)) { result.complete = false; return; }
    let named = null;
    if (Array.isArray(node.children) && node.children.length) {
      if (typeof node.path !== 'string' || node.children.some(c => typeof c?.path !== 'string' || !c.path.startsWith(node.path + '.'))) { result.complete = false; return; }
      named = node.children.map(c => [c.path.slice(node.path.length + 1), c]);
    } else if (node.value && typeof node.value === 'object' && !Array.isArray(node.value)) named = Object.entries(node.value);
    if (named) {
      if (node.type === 'RecordList' && !listComplete(named)) { result.complete = false; return; }
      for (const [name, child] of named) visit(child, [...at, name], depth + 1);
      return;
    }
    if (node.type === 'Record') return;
    if (node.type === 'RecordList') { result.complete = false; return; }
    leaves.push({ path: at, forms: nativeScalarForms(node) });
  };
  if (result.complete) for (const [root, node] of roots) visit(node, [rootMap?.[root] ?? root], 0);
  return result;
}
// Wire body: its data object (outputs) when present. Native list envelopes {List, EmptyListItem}
// become the list; every list also has a synthetic Length leaf, as the native RecordList does.
export function wireParityLeaves(body, { roots, maxLeaves = 20000, maxDepth = 64 } = {}) {
  const leaves = [], result = { complete: true, leaves };
  const plain = v => !!v && typeof v === 'object' && !Array.isArray(v) && !isNum(v);
  const visit = (v, at, depth) => {
    if (!result.complete) return;
    if (depth > maxDepth || leaves.length >= maxLeaves) { result.complete = false; return; }
    if (plain(v) && Array.isArray(v.List) && Object.keys(v).every(k => k === 'List' || k === 'EmptyListItem')) v = v.List;
    if (Array.isArray(v)) { leaves.push({ path: [...at, 'Length'], forms: { n: String(v.length) } }); v.forEach((item, i) => visit(item, [...at, '[' + i + ']'], depth + 1)); return; }
    if (plain(v)) { for (const [k, child] of Object.entries(v)) visit(child, [...at, k], depth + 1); return; }
    leaves.push({ path: at, forms: wireScalarForms(v) });
  };
  const data = plain(body) && plain(body.data) ? body.data : body;
  if (!plain(data)) result.complete = false;
  else for (const [k, v] of Object.entries(data)) if (!roots || roots.includes(k)) visit(v, [k], 0);
  return result;
}
// Exportable private prints: [pathMac, rootMac, [[class, valueMac]...]] (hex), for the private
// broker channel only. A leaf whose forms are unknown makes the print incomplete.
export function parityPrints({ complete, leaves }, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('debug_producer_output_parity_key_invalid');
  const mac = (...parts) => createHmac('sha256', key).update(parts.join('\n')).digest('hex');
  const seen = new Set(), rootMacs = new Map(), out = { complete: complete === true, leaves: [] };
  for (const { path, forms } of leaves) {
    const id = JSON.stringify(path);
    if (!forms || seen.has(id)) { out.complete = false; continue; }
    seen.add(id);
    const root = JSON.stringify(path[0]); if (!rootMacs.has(root)) rootMacs.set(root, mac('r', root));
    out.leaves.push([mac('p', id), rootMacs.get(root), Object.entries(forms).map(([cls, value]) => [cls, mac('v', cls, value)])]);
  }
  return out;
}
export function compareParityPrints(native, wire) {
  const report = { schema: 'ssam-producer-output-parity/1', complete: false, compared: 0, unequal: 0, missing: 0, extra: 0, typeDifferences: 0, parityEqual: false };
  const valid = p => Array.isArray(p?.leaves) && p.leaves.length <= 20000 && p.leaves.every(l => Array.isArray(l) && l.length === 3 && HEX.test(l[0]) && HEX.test(l[1]) &&
    Array.isArray(l[2]) && l[2].every(f => Array.isArray(f) && ORDER.includes(f[0]) && HEX.test(f[1])));
  if (!valid(native) || !valid(wire)) return report;
  const other = new Map(wire.leaves.map(([p, r, f]) => [p, { r, f: new Map(f) }])), roots = new Set(native.leaves.map(l => l[1])), seen = new Set();
  for (const [p, , f] of native.leaves) {
    const w = other.get(p); if (!w) { report.missing++; continue; }
    seen.add(p);
    const forms = new Map(f), cls = ORDER.find(c => forms.has(c) && w.f.has(c));
    if (!cls) { report.typeDifferences++; continue; }
    report.compared++;
    if (!timingSafeEqual(Buffer.from(forms.get(cls), 'hex'), Buffer.from(w.f.get(cls), 'hex'))) report.unequal++;
  }
  for (const [p, { r }] of other) if (roots.has(r) && !seen.has(p)) report.extra++;
  report.complete = native.complete === true && wire.complete === true;
  report.parityEqual = report.complete && !report.unequal && !report.missing && !report.extra && !report.typeDifferences;
  return report;
}
// One-call form (local tests and fixtures): wire text vs native roots under a fresh key.
export function nativeWireParity(roots, wireText, options = {}) {
  const key = randomBytes(32);
  try {
    let wire; try { wire = wireParityLeaves(parseWireJson(wireText), options); } catch { wire = { complete: false, leaves: [] }; }
    return compareParityPrints(parityPrints(nativeParityLeaves(roots, options), key), parityPrints(wire, key));
  } finally { key.fill(0); }
}
