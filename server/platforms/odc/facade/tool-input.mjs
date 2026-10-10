// The central input layer of the ssam MCP server (A15 of the 2026-10-06 package, interface I1). The SDK used to refuse a
// call before its handler for a limit no platform imposes: "data/budgetBytes must be >= 4096" (17 times), "select: Too
// big: expected array to have <=32 items", "close.reason: Too big: expected string to have <=500 characters". Each cost a
// round. Here the limit becomes the edge of the range, once, in the same call:
//   - a number out of range goes to the nearest edge (clamp);
//   - a text longer than its limit is cut, and the answer keeps the sha256 of the whole text (truncate);
//   - a `select` list above its limit runs as internal batches whose answers are merged (batch);
//   - every adjustment comes back in `inputAdjusted: [{path, from, to, rule}]`;
//   - what no adjustment can fix (a missing field, an unknown field, a value outside an enum, a wrong type, a limit on the
//     user's words or on a job) answers INPUT_INVALID with every violation {path, message, accepted} and the corrected
//     arguments, without calling the tool.
// The user's words and the payloads are never adjusted (NEVER_ADJUSTED): a limit there is the person's or the job's to fix.
//
// relaxTool(name, config, handler) -> {config, handler}: the registration the SDK sees. Its schema lists exactly what the
// tool always listed (the limits stay as guidance for the model) but validates nothing; the returned handler normalizes,
// then runs the tool's own schema (defaults and transforms included) before calling the original handler. A schema it
// cannot read comes back unchanged. F7b wires it into ssam.mjs (server.registerTool); this module never registers.
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';

export const INPUT_INVALID = 'INPUT_INVALID';
export const NEVER_ADJUSTED = Object.freeze(['authorize', 'words', 'text', 'job', 'patch', 'basedOn', 'html', 'request', 'records']);
export const BATCHED = Object.freeze(['select']);
// In `corrected` the user's words are never echoed (the marker of next-steps.mjs) and a large payload is not sent back.
export const WORDS_MARKER = '<palavras do usuário>';
export const AS_SENT = '<como enviado>';
const NEVER = new Set(NEVER_ADJUSTED);
const WORDS = new Set(['authorize', 'words']);
const LARGE_ECHO = 2048, MAX_VIOLATIONS = 50, MAX_REF_DEPTH = 32;
const SUMMED = new Set(['requested', 'count', 'total', 'bytes']);
const IDENTIFIER = /^(?:pid|port)$|(?:Id|Key|Uuid)$/;

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const pointer = keys => keys.map(k => '/' + String(k).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const typeName = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

function fitsType(type, v) {
  switch (type) {
    case 'null': return v === null;
    case 'boolean': return typeof v === 'boolean';
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'string': return typeof v === 'string';
    case 'array': return Array.isArray(v);
    case 'object': return isObject(v);
    default: return true;
  }
}

// The obvious fix of a wrong type, or undefined.
function coerce(types, v) {
  for (const t of types) {
    if ((t === 'integer' || t === 'number') && typeof v === 'string' && /^\s*-?\d+(?:\.\d+)?\s*$/.test(v)) { const n = Number(v); return t === 'integer' ? Math.round(n) : n; }
    if (t === 'integer' && typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
    if (t === 'boolean' && (v === 'true' || v === 'false')) return v === 'true';
    if (t === 'string' && (typeof v === 'number' || typeof v === 'boolean')) return String(v);
    if (t === 'array' && v !== undefined && v !== null && !Array.isArray(v)) return [v];
  }
  return undefined;
}

// Optimal string alignment distance: insertion, deletion, substitution or an adjacent swap ("nmae" -> "name") count one.
function distance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
// The closest candidate of a text: same text ignoring case and separators, a prefix of one, or a small edit distance.
export function closest(value, candidates) {
  if (typeof value !== 'string' || !value) return undefined;
  const fold = s => String(s).toLowerCase().replace(/[\s_-]+/g, '');
  const wanted = fold(value);
  const texts = candidates.filter(c => typeof c === 'string');
  const exact = texts.find(c => fold(c) === wanted);
  if (exact !== undefined) return exact;
  const prefixed = texts.filter(c => fold(c).startsWith(wanted) || wanted.startsWith(fold(c)));
  if (prefixed.length === 1 && Math.min(wanted.length, fold(prefixed[0]).length) >= 3) return prefixed[0];
  let best; let score = Infinity;
  for (const c of texts) { const d = distance(wanted, fold(c)); if (d < score) { score = d; best = c; } }
  return best !== undefined && score <= Math.max(1, Math.min(3, Math.floor(wanted.length / 3))) ? best : undefined;
}

// A short sentence of what a schema accepts, for `accepted`.
export function describe(schema, root = schema, depth = 0) {
  schema = deref(schema, root);
  if (!isObject(schema) || depth > 3) return 'any value';
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) return branches.map(b => describe(b, root, depth + 1)).join(' | ');
  if (Array.isArray(schema.enum)) return 'one of: ' + schema.enum.slice(0, 20).map(v => JSON.stringify(v)).join(', ') + (schema.enum.length > 20 ? ', ...' : '');
  if ('const' in schema) return 'exactly ' + JSON.stringify(schema.const);
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  const range = (lo, hi, unit) => (lo !== undefined && hi !== undefined ? ` ${lo}..${hi}${unit}` : lo !== undefined ? ` >= ${lo}${unit}` : hi !== undefined ? ` <= ${hi}${unit}` : '');
  if (types.includes('integer') || types.includes('number')) {
    const lo = schema.minimum ?? (typeof schema.exclusiveMinimum === 'number' ? (types.includes('integer') ? Math.floor(schema.exclusiveMinimum) + 1 : undefined) : undefined);
    const hi = schema.maximum ?? (typeof schema.exclusiveMaximum === 'number' ? (types.includes('integer') ? Math.ceil(schema.exclusiveMaximum) - 1 : undefined) : undefined);
    return (types.includes('integer') ? 'integer' : 'number') + range(lo, hi, '');
  }
  if (types.includes('string')) return 'text' + range(schema.minLength, schema.maxLength, ' characters') + (schema.pattern ? ' matching ' + schema.pattern : '');
  if (types.includes('array')) return 'list' + range(schema.minItems, schema.maxItems, ' items') + (schema.items && !Array.isArray(schema.items) ? ' of ' + describe(schema.items, root, depth + 1) : '');
  if (types.includes('object') || schema.properties) {
    const names = Object.keys(schema.properties ?? {});
    return names.length ? 'object with fields: ' + names.join(', ') : 'object';
  }
  return types.length ? types.join(' or ') : 'any value';
}

function deref(schema, root, depth = 0) {
  if (!isObject(schema) || typeof schema.$ref !== 'string' || depth > MAX_REF_DEPTH) return schema;
  if (!schema.$ref.startsWith('#')) return {};
  const keys = schema.$ref.slice(1).split('/').filter(Boolean).map(k => decodeURIComponent(k.replace(/~1/g, '/').replace(/~0/g, '~')));
  let target = root;
  for (const k of keys) target = isObject(target) ? target[k] : undefined;
  const { $ref: _ref, ...rest } = schema;
  return deref(isObject(target) ? { ...target, ...rest } : rest, root, depth + 1);
}

// ---- the walk: the normalized value; adjustments, violations, fixes and batches are collected in ctx.
function walk(schemaIn, value, keys, ctx, never) {
  const schema = deref(schemaIn, ctx.root);
  if (!isObject(schema) || value === undefined) return value;
  const path = pointer(keys);
  const violation = (message, fix) => { ctx.violations.push({ path, message, accepted: describe(schema, ctx.root) }); if (fix) ctx.fixes.push({ keys, fix }); };
  if (Array.isArray(schema.allOf)) for (const part of schema.allOf) value = walk(part, value, keys, ctx, never);
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches) && branches.length) {
    for (const branch of branches) {
      const trial = { root: ctx.root, adjusted: [], violations: [], fixes: [], batches: [] };
      const out = walk(branch, value, keys, trial, never);
      if (!trial.violations.length) { ctx.adjusted.push(...trial.adjusted); ctx.batches.push(...trial.batches); value = out; return walkOwn(schema, value, keys, ctx, never); }
    }
    violation('matches none of the accepted forms');
    return value;
  }
  return walkOwn(schema, value, keys, ctx, never, violation);
}

function walkOwn(schema, value, keys, ctx, never, violation) {
  const path = pointer(keys);
  violation ??= (message, fix) => { ctx.violations.push({ path, message, accepted: describe(schema, ctx.root) }); if (fix) ctx.fixes.push({ keys, fix }); };
  const types = schema.type === undefined ? null : [].concat(schema.type);
  if (types && !types.some(t => fitsType(t, value))) {
    const fixed = coerce(types, value);
    violation(`expected ${types.join(' or ')}, received ${typeName(value)}`, fixed !== undefined ? { set: fixed } : null);
    return value;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(e => same(e, value))) {
    const near = closest(value, schema.enum);
    violation('is not an accepted value', near !== undefined ? { set: near } : null);
    return value;
  }
  if ('const' in schema && !same(schema.const, value)) { violation('is not the accepted value', { set: schema.const }); return value; }
  if (typeof value === 'number') return number(schema, value, keys, ctx, never, types ?? [], violation);
  if (typeof value === 'string') return text(schema, value, keys, ctx, never, violation);
  if (Array.isArray(value)) return list(schema, value, keys, ctx, never, violation);
  if (isObject(value)) return object(schema, value, keys, ctx, never, violation);
  return value;
}

function number(schema, value, keys, ctx, never, types, violation) {
  const integer = types.includes('integer') && !types.includes('number');
  let to = value;
  if (typeof schema.minimum === 'number' && to < schema.minimum) to = schema.minimum;
  if (typeof schema.exclusiveMinimum === 'number' && to <= schema.exclusiveMinimum) to = integer ? Math.floor(schema.exclusiveMinimum) + 1 : null;
  if (to !== null && typeof schema.maximum === 'number' && to > schema.maximum) to = schema.maximum;
  if (to !== null && typeof schema.exclusiveMaximum === 'number' && to >= schema.exclusiveMaximum) to = integer ? Math.ceil(schema.exclusiveMaximum) - 1 : null;
  if (to === value) return value;
  // An identifier (pid, port, an id or key) is never moved to an edge: another process or record is not a nearer value.
  const identifier = IDENTIFIER.test(String(keys.at(-1) ?? ''));
  if (to === null || never || identifier) { violation('is out of range', to !== null && !identifier ? { set: to } : null); return value; }
  ctx.adjusted.push({ path: pointer(keys), from: value, to, rule: 'clamp' });
  return to;
}

function text(schema, value, keys, ctx, never, violation) {
  let out = value;
  if (typeof schema.maxLength === 'number' && out.length > schema.maxLength) {
    if (never) { violation(`has ${out.length} characters; at most ${schema.maxLength}`); return value; }
    let cut = out.slice(0, schema.maxLength);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
    ctx.adjusted.push({ path: pointer(keys), from: { length: out.length, sha256: sha256(out) }, to: { length: cut.length }, rule: 'truncate' });
    out = cut;
  }
  if (typeof schema.minLength === 'number' && out.length < schema.minLength) violation(`has ${out.length} characters; at least ${schema.minLength}`);
  if (typeof schema.pattern === 'string') {
    let re = null; try { re = new RegExp(schema.pattern, 'u'); } catch { re = null; }
    if (re && !re.test(out)) violation('does not match ' + schema.pattern);
  }
  return out;
}

function list(schema, value, keys, ctx, never, violation) {
  let out = value;
  const items = schema.items;
  const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(items) ? items : null;
  for (let i = 0; i < value.length; i++) {
    const itemSchema = prefix && i < prefix.length ? prefix[i] : isObject(items) ? items : isObject(schema.additionalItems) ? schema.additionalItems : null;
    if (!itemSchema) continue;
    const v = walk(itemSchema, value[i], [...keys, i], ctx, never);
    if (v !== value[i]) { if (out === value) out = value.slice(); out[i] = v; }
  }
  if (typeof schema.maxItems === 'number' && out.length > schema.maxItems) {
    const key = keys.at(-1);
    if (!never && keys.length === 1 && BATCHED.includes(key) && schema.maxItems > 0) {
      const batches = Math.ceil(out.length / schema.maxItems);
      ctx.adjusted.push({ path: pointer(keys), from: out.length, to: schema.maxItems, rule: 'batch', batches });
      ctx.batches.push({ key, size: schema.maxItems });
    } else violation(`has ${out.length} items; at most ${schema.maxItems}`);
  }
  if (typeof schema.minItems === 'number' && out.length < schema.minItems) violation(`has ${out.length} items; at least ${schema.minItems}`);
  return out;
}

function object(schema, value, keys, ctx, never, violation) {
  let out = value;
  const props = isObject(schema.properties) ? schema.properties : {};
  for (const [k, s] of Object.entries(props)) {
    if (!Object.hasOwn(value, k) || value[k] === undefined) continue;
    const v = walk(s, value[k], [...keys, k], ctx, never || NEVER.has(k));
    if (v !== value[k]) { if (out === value) out = { ...value }; out[k] = v; }
  }
  for (const r of Array.isArray(schema.required) ? schema.required : []) {
    if (Object.hasOwn(value, r) && value[r] !== undefined) continue;
    ctx.violations.push({ path: pointer([...keys, r]), message: 'is required', accepted: describe(props[r] ?? {}, ctx.root) });
    ctx.fixes.push({ keys: [...keys, r], fix: { set: '<' + r + '>' } });
  }
  const patterns = isObject(schema.patternProperties) ? Object.keys(schema.patternProperties).map(p => { try { return new RegExp(p, 'u'); } catch { return null; } }).filter(Boolean) : [];
  const extra = Object.keys(value).filter(k => !Object.hasOwn(props, k) && !patterns.some(p => p.test(k)));
  if (schema.additionalProperties === false) {
    const free = Object.keys(props).filter(p => !Object.hasOwn(value, p));
    for (const k of extra) {
      const near = closest(k, free);
      ctx.violations.push({ path: pointer([...keys, k]), message: 'is not a field here' + (near ? `; closest: ${near}` : ''), accepted: 'fields: ' + Object.keys(props).join(', ') });
      ctx.fixes.push({ keys: [...keys, k], fix: near ? { rename: near } : { remove: true } });
      if (near) free.splice(free.indexOf(near), 1);
    }
  } else if (isObject(schema.additionalProperties)) {
    for (const k of extra) {
      const v = walk(schema.additionalProperties, value[k], [...keys, k], ctx, never || NEVER.has(k));
      if (v !== value[k]) { if (out === value) out = { ...value }; out[k] = v; }
    }
  }
  const count = Object.keys(out).length;
  if (typeof schema.maxProperties === 'number' && count > schema.maxProperties) violation(`has ${count} fields; at most ${schema.maxProperties}`);
  if (typeof schema.minProperties === 'number' && count < schema.minProperties) violation(`has ${count} fields; at least ${schema.minProperties}`);
  return out;
}

function applyFixes(value, fixes) {
  let out = structuredClone(value);
  for (const { keys, fix } of fixes) {
    if (!keys.length) { if ('set' in fix) out = fix.set; continue; }
    let parent = out;
    for (const k of keys.slice(0, -1)) parent = parent == null ? parent : parent[k];
    if (parent == null || typeof parent !== 'object') continue;
    const key = keys.at(-1);
    if (fix.remove) delete parent[key];
    else if (fix.rename) { parent[fix.rename] = parent[key]; delete parent[key]; }
    else if ('set' in fix) parent[key] = fix.set;
  }
  return out;
}

// Pure. The arguments normalized against the JSON Schema of a tool: {args, adjusted, violations} (plus corrected, the
// arguments with every obvious fix applied, and batches, the internal batches of a select above its limit).
export function normalizeArguments(jsonSchema, args) {
  const ctx = { root: jsonSchema, adjusted: [], violations: [], fixes: [], batches: [] };
  const input = args === undefined || args === null ? {} : args;
  const value = walk(jsonSchema, input, [], ctx, false);
  return { args: value, adjusted: ctx.adjusted, violations: ctx.violations, corrected: ctx.violations.length ? applyFixes(value, ctx.fixes) : value,
    fixed: ctx.violations.length > 0 && ctx.violations.every(v => ctx.fixes.some(f => pointer(f.keys) === v.path)), batches: ctx.batches };
}

// ---- answers
function forEcho(args, words) {
  if (!isObject(args)) return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (words.has(k) && typeof v === 'string') out[k] = WORDS_MARKER;
    else if (NEVER.has(k) && Buffer.byteLength(JSON.stringify(v ?? null), 'utf8') > LARGE_ECHO) out[k] = AS_SENT;
    else out[k] = v;
  }
  if (isObject(out.request) && typeof out.request.authorization === 'string') out.request = { ...out.request, authorization: WORDS_MARKER };
  return out;
}

export function inputInvalidAnswer(name, violations, corrected, { fixed = false } = {}) {
  const shown = violations.slice(0, MAX_VIOLATIONS);
  const value = { ok: false, code: INPUT_INVALID,
    error: `${violations.length} argument problem(s) for ${name}: ` + shown.slice(0, 5).map(v => (v.path || '/') + ' ' + v.message).join('; '),
    violations: shown, ...(violations.length > shown.length ? { violationsTotal: violations.length } : {}), corrected,
    ...(fixed ? { continuation: { tool: name, arguments: corrected, why: 'os mesmos argumentos com as correções acima; troque cada <campo> pelo valor certo, as palavras do usuário pelas dele, literais, e <como enviado> pelo valor desta chamada' } } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
}

const issuePath = issue => pointer((issue.path ?? []).map(p => (p && typeof p === 'object' ? p.key : p)));
const structuredOf = result => {
  if (!result || typeof result !== 'object') return undefined;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const first = Array.isArray(result.content) ? result.content[0] : null;
  if (first?.type === 'text' && /^\s*[{[]/.test(first.text ?? '')) { try { return JSON.parse(first.text); } catch { return undefined; } }
  return undefined;
};

export function mergeValues(values) {
  if (values.every(Array.isArray)) return values.flat();
  if (!values.every(isObject)) return values[0];
  const out = {};
  for (const v of values) for (const [k, x] of Object.entries(v)) {
    if (!Object.hasOwn(out, k)) { out[k] = x; continue; }
    const prev = out[k];
    if (Array.isArray(prev) && Array.isArray(x)) out[k] = [...prev, ...x];
    else if (isObject(prev) && isObject(x)) out[k] = mergeValues([prev, x]);
    else if (typeof prev === 'boolean' && typeof x === 'boolean') out[k] = prev && x;
    else if (typeof prev === 'number' && typeof x === 'number' && SUMMED.has(k)) out[k] = prev + x;
  }
  return out;
}

export function withInputAdjusted(result, adjusted) {
  if (!result || typeof result !== 'object' || result.resultType === 'input_required' || !adjusted.length) return result;
  const content = Array.isArray(result.content) ? result.content : [];
  if (isObject(result.structuredContent)) {
    const before = JSON.stringify(result.structuredContent);
    const structuredContent = { ...result.structuredContent, inputAdjusted: adjusted };
    return { ...result, structuredContent, content: content.map((c, i) => (i === 0 && c?.type === 'text' && c.text === before ? { ...c, text: JSON.stringify(structuredContent) } : c)) };
  }
  if (content[0]?.type === 'text') {
    try { const v = JSON.parse(content[0].text); if (isObject(v)) return { ...result, content: [{ ...content[0], text: JSON.stringify({ ...v, inputAdjusted: adjusted }) }, ...content.slice(1)] }; } catch { /* plain text */ }
  }
  return { ...result, content: [...content, { type: 'text', text: JSON.stringify({ inputAdjusted: adjusted }) }] };
}

// The Standard Schema of a registration (a raw zod shape becomes z.object) and its JSON Schema, or null.
function standardOf(schema) {
  if (!schema || (typeof schema !== 'object' && typeof schema !== 'function')) return null;
  if (typeof schema['~standard']?.validate === 'function') return schema;
  const values = Object.values(schema);
  if (values.length && values.every(v => v && typeof v === 'object' && '_zod' in v)) return z.object(schema);
  return null;
}
function jsonSchemaOf(standard) {
  const std = standard['~standard'];
  if (std.jsonSchema?.input) return std.jsonSchema.input({ target: 'draft-2020-12' });
  if (std.vendor === 'zod' && '_zod' in standard) return z.toJSONSchema(standard, { target: 'draft-2020-12', io: 'input' });
  return null;
}

export function relaxTool(name, config, handler) {
  try {
    if (!config || typeof handler !== 'function') return { config, handler };
    const standard = standardOf(config.inputSchema);
    if (!standard) return { config, handler };
    const std = standard['~standard'];
    const json = jsonSchemaOf(standard);
    if (!isObject(json)) return { config, handler };
    const words = name === 'studio_authorize' ? new Set([...WORDS, 'text']) : WORDS;
    // Listed exactly as before (the SDK reads jsonSchema.input for tools/list); validated by the handler below.
    const relaxed = { '~standard': { version: 1, vendor: 'ssam-relaxed',
      jsonSchema: { input: options => (std.jsonSchema?.input ? std.jsonSchema.input(options) : json), output: options => (std.jsonSchema?.output ? std.jsonSchema.output(options) : json) },
      validate: data => ({ value: data === undefined ? {} : data }) } };
    const run = async (args, ctx) => {
      const parsed = await std.validate(args);
      if (parsed?.issues?.length) {
        const violations = parsed.issues.map(issue => ({ path: issuePath(issue), message: String(issue.message ?? 'invalid'), accepted: null }));
        return { refused: inputInvalidAnswer(name, violations, forEcho(args, words)) };
      }
      return { result: await handler(parsed?.value ?? args, ctx) };
    };
    const relaxedHandler = async (raw, ctx) => {
      const n = normalizeArguments(json, raw);
      if (n.violations.length) return inputInvalidAnswer(name, n.violations, forEcho(n.corrected, words), { fixed: n.fixed });
      if (!n.batches.length) {
        const r = await run(n.args, ctx);
        return r.refused ?? withInputAdjusted(r.result, n.adjusted);
      }
      // select above its limit: one call per batch, in order; a refused batch ends it and answers for the call.
      const [{ key, size }] = n.batches;
      const all = n.args[key]; const results = [];
      for (let i = 0; i < all.length; i += size) {
        const r = await run({ ...n.args, [key]: all.slice(i, i + size) }, ctx);
        if (r.refused) return r.refused;
        const value = structuredOf(r.result);
        if (r.result?.resultType === 'input_required' || r.result?.isError === true || value?.ok === false || value === undefined) return withInputAdjusted(r.result, n.adjusted);
        results.push(r.result);
      }
      const merged = mergeValues(results.map(structuredOf));
      const structured = results.every(r => r.structuredContent !== undefined);
      return withInputAdjusted({ content: [{ type: 'text', text: JSON.stringify(merged) }], ...(structured ? { structuredContent: merged } : {}) }, n.adjusted);
    };
    return { config: { ...config, inputSchema: relaxed }, handler: relaxedHandler };
  } catch {
    return { config, handler };
  }
}
