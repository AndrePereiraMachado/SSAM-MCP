// The central input layer of the ssam MCP server (A15 of the 2026-10-06 package, interface I1). The SDK used to refuse a
// call before its handler for a limit no platform imposes: "data/budgetBytes must be >= 4096" (17 times), "select: Too
// big: expected array to have <=32 items", "close.reason: Too big: expected string to have <=500 characters". Each cost a
// round. Here the limit becomes the edge of the range, once, in the same call:
//   - a number out of range goes to the nearest edge (clamp);
//   - a text longer than its limit is cut, and the answer keeps the sha256 of the whole text (truncate);
//   - a `select` list above its limit runs as internal batches whose answers are merged (batch);
//   - budget and budgetBytes, the answer budget under its two names across the tools, are one field: on a tool that
//     declares one of them only, the other name is taken as it (alias), on any tool;
//   - every adjustment comes back in `inputAdjusted: [{path, from?, to, rule}]` (a rename or an alias has no `from`: path
//     is the name sent, to the field's); an answer with entries of its own (discover's raise of a budget) keeps them,
//     after the layer's;
//   - what no adjustment can fix (a missing field, an unknown field, a value outside an enum, a wrong type, a limit on the
//     user's words or on a job) answers INPUT_INVALID with every violation {path, message, accepted} and the corrected
//     arguments, without calling the tool;
//   - except on a read-only tool (readOnlyHint true) whose every problem has a deterministic fix: a field renamed to the
//     one name it surely is, a lossless type coercion ("8000" -> 8000). It runs the corrected arguments and reports each
//     fix in inputAdjusted ({path, to, rule:'rename'}, {path, from, to, rule:'coerce'}). A name sent surely is a field when
//     it is the field's but for case and separators (budget_bytes is budgetBytes), its plural (lanes is lane), or a slip of
//     one letter inside a name of five letters or more (targt is target), and no other field is as close. Anything wider
//     is a guess and refuses, with the field as its closest name: a name the field extends or one that extends a field
//     (the rest is a unit, a count or another field: timeout is not timeoutSeconds, max is not maxPages, maxDepth is not
//     max), a wider edit (dbServer is not server, keep is not deep), an identifier (pid, port, an id or key) under any
//     other name than its own but for case and separators (id is not pid), and a number or a boolean the field would read
//     as text (messages true, a switch, is not the text filter message "true"). G7 of the UI-Mockup diagnosis: a read
//     refused for the very fix its refusal named cost a round. A tool that writes keeps refusing: a guessed name never
//     reaches a write.
// The user's words and the payloads are never adjusted (NEVER_ADJUSTED): a limit there is the person's or the job's to fix.
//
// relaxTool(name, config, handler, {prepare}) -> {config, handler, argsOf}: the registration the SDK sees. Its schema lists
// exactly what the tool always listed (the limits stay as guidance for the model) but validates nothing; the returned
// handler normalizes, applies prepare (when given) to the normalized arguments, then runs the tool's own schema (defaults
// and transforms included) before calling the original handler. argsOf(raw) is what that handler runs for raw (normalized,
// then prepare; the tool's defaults left out), or null when it refuses them: a renamed, aliased or coerced field under the
// name the tool knows. A schema it cannot read comes back unchanged (no argsOf). F7b wires it into ssam.mjs
// (server.registerTool; prepare holds a budget under the answer ceiling; the lane, the Studio lock and the next steps of the
// answer read argsOf); this module never registers.
// Before the schema, the call shapes of one meaning (call-shapes.mjs: ssam_code, the deliveries and the job runners) are
// written as the tool takes them and listed in `normalizations` [{rule, at, note}] of the answer (refusals included).
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { shapeCall } from './call-shapes.mjs';
import { mergeNormalizations } from './normalizations.mjs';

export const INPUT_INVALID = 'INPUT_INVALID';
export const NEVER_ADJUSTED = Object.freeze(['authorize', 'words', 'text', 'job', 'patch', 'basedOn', 'html', 'request', 'records']);
export const BATCHED = Object.freeze(['select']);
// In `corrected` the user's words are never echoed (the marker of next-steps.mjs) and a large payload is not sent back.
export const WORDS_MARKER = '<palavras do usuário>';
export const AS_SENT = '<como enviado>';
const NEVER = new Set(NEVER_ADJUSTED);
const WORDS = new Set(['authorize', 'words']);
const LARGE_ECHO = 2048, MAX_VIOLATIONS = 50, MAX_REF_DEPTH = 32, MAX_PASSES = 3;
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

// A value the layer moves to another name keeps its kind there: a number or a boolean read as text is another tool's value,
// not a slip of the name (odc_operation_status {messages: true} is a switch; o11_service_center_read {message} a text
// filter, and ssam_map {key} an @key, never 7). True when the field, or what it holds (the item of the list it wraps the
// value in included), would read a number or a boolean as text; a text read as a number or a boolean, a value wrapped in
// its list and a number read as an integer keep their kind. A union coerces nothing (a branch that needs a fix is no match).
function readAsText(schemaIn, value, root, depth = 0) {
  const schema = deref(schemaIn, root);
  if (!isObject(schema) || value === undefined || depth > MAX_REF_DEPTH) return false;
  if (Array.isArray(schema.allOf) && schema.allOf.some(part => readAsText(part, value, root, depth + 1))) return true;
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches) && branches.length) return false;
  const types = schema.type === undefined ? null : [].concat(schema.type);
  if (types && !types.some(t => fitsType(t, value))) {
    const fixed = coerce(types, value);
    return typeof fixed === 'string' ? typeof value !== 'string' : Array.isArray(fixed) && readAsText(schema, fixed, root, depth + 1);
  }
  if (Array.isArray(value)) {
    const items = schema.items;
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(items) ? items : null;
    return value.some((v, i) => readAsText(prefix && i < prefix.length ? prefix[i] : isObject(items) ? items : schema.additionalItems, v, root, depth + 1));
  }
  if (isObject(value)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    return Object.entries(value).some(([k, v]) => readAsText(Object.hasOwn(props, k) ? props[k] : schema.additionalProperties, v, root, depth + 1));
  }
  return false;
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
// The closest candidate of a text: same text ignoring case and separators, a prefix of one, or a small edit distance (the
// closest name of a refusal). `sure` when the text is that candidate beyond doubt, the only rename a read runs by itself:
// the same text but for case and separators, its plural, or a slip of one letter inside two names of five letters or more
// (a substitution, an adjacent swap, one letter more or less, never at the end), with no other candidate as close. A
// prefix is a guess (the field extends the text, or the text a field): the rest names a unit, a count or another field
// (timeout -> timeoutSeconds is 30 s read as 30000 s, max -> maxPages a count of items read as pages, maxDepth -> max).
const fold = s => String(s).toLowerCase().replace(/[\s_-]+/g, '');
const plural = (a, b) => a === b + 's' || b === a + 's';
const slip = (a, b, d) => d === 1 && a.length >= 5 && b.length >= 5 && !a.startsWith(b) && !b.startsWith(a);
function nearest(value, candidates) {
  if (typeof value !== 'string' || !value) return {};
  const wanted = fold(value);
  const texts = candidates.filter(c => typeof c === 'string');
  const exact = texts.filter(c => fold(c) === wanted);
  if (exact.length) return { match: exact[0], sure: exact.length === 1, exact: true };
  const prefixed = texts.filter(c => fold(c).startsWith(wanted) || wanted.startsWith(fold(c)));
  if (prefixed.length === 1 && Math.min(wanted.length, fold(prefixed[0]).length) >= 3) return { match: prefixed[0], sure: plural(wanted, fold(prefixed[0])) };
  let best; let score = Infinity; let ties = 0;
  for (const c of texts) { const d = distance(wanted, fold(c)); if (d < score) { score = d; best = c; ties = 1; } else if (d === score) ties++; }
  return best !== undefined && score <= Math.max(1, Math.min(3, Math.floor(wanted.length / 3))) ? { match: best, sure: ties === 1 && slip(wanted, fold(best), score) } : {};
}
export function closest(value, candidates) { return nearest(value, candidates).match; }

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
// A fix that is deterministic carries `auto`, the inputAdjusted entry a read-only tool reports when it runs it.
const reporter = (schema, keys, ctx) => (message, fix, auto) => {
  const path = pointer(keys);
  ctx.violations.push({ path, message, accepted: describe(schema, ctx.root) });
  if (fix) ctx.fixes.push({ keys, fix, ...(auto ? { auto: { path, ...auto } } : {}) });
};

function walk(schemaIn, value, keys, ctx, never) {
  const schema = deref(schemaIn, ctx.root);
  if (!isObject(schema) || value === undefined) return value;
  const violation = reporter(schema, keys, ctx);
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
  violation ??= reporter(schema, keys, ctx);
  const types = schema.type === undefined ? null : [].concat(schema.type);
  if (types && !types.some(t => fitsType(t, value))) {
    const fixed = coerce(types, value);
    // Deterministic when the value stays as written ("8000" -> 8000, "true" -> true, 7 -> "7", x -> [x]); a rounding is
    // not, nor a text that reads as a list ("a,b" is one item or two), and a payload's value is never coerced by itself.
    const lossless = fixed !== undefined && !never && (Array.isArray(fixed) ? !(typeof value === 'string' && /[,;\n]/.test(value)) : String(fixed) === String(value).trim());
    violation(`expected ${types.join(' or ')}, received ${typeName(value)}`, fixed !== undefined ? { set: fixed } : null, lossless ? { from: value, to: fixed, rule: 'coerce' } : null);
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

// A fixed alias (G7): budget and budgetBytes are the one answer budget under two names across the tools (o11_inspect and
// studio_inspect declare budget; ssam_discover, ssam_map and ssam_evidence budgetBytes). On a tool that declares one of the
// two only, the other name sent (any case or separators) is that field, on every tool, read or write: an adjustment
// {path, to, rule:'alias'}, then the value is clamped or coerced like any other. Both sent: no alias, the extra one refuses;
// a number or a boolean the field would read as text is no alias either (it keeps its kind, like a renamed value).
const ALIASES = Object.freeze({ budget: 'budgetBytes', budgetbytes: 'budget' });
function aliased(schema, props, patterns, value, ctx) {
  if (isObject(schema.additionalProperties)) return value;
  let out = value;
  for (const k of Object.keys(value)) {
    const to = ALIASES[fold(k)];
    if (!to || Object.hasOwn(props, k) || patterns.some(p => p.test(k)) || !Object.hasOwn(props, to) || Object.hasOwn(props, ALIASES[fold(to)]) || Object.hasOwn(out, to)
      || readAsText(props[to], out[k], ctx.root)) continue;
    const { [k]: moved, ...rest } = out;
    out = { ...rest, [to]: moved };
    ctx.adjusted.push({ path: pointer([k]), to: pointer([to]), rule: 'alias' });
  }
  return out;
}

function object(schema, sent, keys, ctx, never, violation) {
  const props = isObject(schema.properties) ? schema.properties : {};
  const patterns = isObject(schema.patternProperties) ? Object.keys(schema.patternProperties).map(p => { try { return new RegExp(p, 'u'); } catch { return null; } }).filter(Boolean) : [];
  // The alias applies to the tool's own arguments, never inside a payload.
  const value = keys.length || never ? sent : aliased(schema, props, patterns, sent, ctx);
  let out = value;
  for (const [k, s] of Object.entries(props)) {
    if (!Object.hasOwn(value, k) || value[k] === undefined) continue;
    const v = walk(s, value[k], [...keys, k], ctx, never || NEVER.has(k));
    if (v !== value[k]) { if (out === value) out = { ...value }; out[k] = v; }
  }
  for (const r of Array.isArray(schema.required) ? schema.required : []) {
    if (Object.hasOwn(value, r) && value[r] !== undefined) continue;
    ctx.violations.push({ path: pointer([...keys, r]), message: 'is required', accepted: describe(props[r] ?? {}, ctx.root) });
    ctx.fixes.push({ keys: [...keys, r], fix: { set: '<' + r + '>' }, required: true });
  }
  const extra = Object.keys(value).filter(k => !Object.hasOwn(props, k) && !patterns.some(p => p.test(k)));
  if (schema.additionalProperties === false) {
    const free = Object.keys(props).filter(p => !Object.hasOwn(value, p));
    const initial = free.slice();
    for (const k of extra) {
      const near = closest(k, free);
      const path = pointer([...keys, k]);
      ctx.violations.push({ path, message: 'is not a field here' + (near ? `; closest: ${near}` : ''), accepted: 'fields: ' + Object.keys(props).join(', ') });
      // Deterministic only when the name sent surely is that field among the fields free before any rename (the order of
      // the keys sent never decides) and the field is still free; an identifier only from its own name but for case and
      // separators (another process or record is not a nearer name: id is not pid); no user's words or payload change name;
      // and the value keeps its kind there (a number or a boolean is never read as text: messages true is not message "true").
      const first = nearest(k, initial);
      const identifier = !first.exact && (IDENTIFIER.test(k) || IDENTIFIER.test(near ?? ''));
      const auto = near && first.sure && first.match === near && !identifier && !never && !NEVER.has(k) && !NEVER.has(near)
        && !readAsText(props[near], value[k], ctx.root)
        ? { auto: { path, to: pointer([...keys, near]), rule: 'rename' } } : {};
      ctx.fixes.push({ keys: [...keys, k], fix: near ? { rename: near } : { remove: true }, ...auto });
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
// arguments with every obvious fix applied, batches, the internal batches of a select above its limit, and corrections,
// the inputAdjusted entries of the fixes when every violation has a deterministic one, else null). A required field a
// deterministic rename fills ({targt} -> target) leaves no placeholder: the rename is its fix.
export function normalizeArguments(jsonSchema, args) {
  const ctx = { root: jsonSchema, adjusted: [], violations: [], fixes: [], batches: [] };
  const input = args === undefined || args === null ? {} : args;
  const value = walk(jsonSchema, input, [], ctx, false);
  const fixed = ctx.violations.length > 0 && ctx.violations.every(v => ctx.fixes.some(f => pointer(f.keys) === v.path));
  const renamed = new Set(ctx.fixes.filter(f => f.auto?.rule === 'rename').map(f => f.auto.to));
  const deterministic = fixed && ctx.fixes.every(f => f.auto || (f.required && renamed.has(pointer(f.keys))));
  return { args: value, adjusted: ctx.adjusted, violations: ctx.violations, corrected: ctx.violations.length ? applyFixes(value, ctx.fixes) : value,
    fixed, batches: ctx.batches, corrections: deterministic ? ctx.fixes.filter(f => f.auto).map(f => f.auto) : null };
}

// A read-only tool: the corrected arguments when every problem has a deterministic fix, normalized again (a renamed value
// is clamped or coerced like any other, bounded passes), with every fix and adjustment in `adjusted`. A problem the
// corrected arguments still have refuses the call with the violations of every pass and the arguments of the last one
// ({limits: 8.5} names /limits and /limit, and corrects to {limit: 9}); without a deterministic fix in the first pass the
// refusal is the same as for any tool.
function readNormalized(jsonSchema, args) {
  let n = normalizeArguments(jsonSchema, args);
  const adjusted = [], violations = [];
  const add = (into, list) => { for (const a of list) if (!into.some(b => same(a, b))) into.push(a); };
  add(adjusted, n.adjusted);
  for (let pass = 0; pass < MAX_PASSES && n.violations.length && n.corrections; pass++) {
    add(adjusted, n.corrections); add(violations, n.violations);
    n = normalizeArguments(jsonSchema, n.corrected); add(adjusted, n.adjusted);
  }
  if (!n.violations.length) return { ...n, adjusted };
  add(violations, n.violations);
  return { ...n, violations };
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

// One list: what the layer adjusted, then what the tool adjusted itself (discover raises a budget below its minimal
// answer, U5), in the order applied; neither replaces the other.
const joined = (own, adjusted) => {
  const out = adjusted.slice();
  for (const a of own === undefined || own === null ? [] : [].concat(own)) if (!out.some(b => same(a, b))) out.push(a);
  return out;
};

export function withInputAdjusted(result, adjusted) {
  if (!result || typeof result !== 'object' || result.resultType === 'input_required' || !adjusted.length) return result;
  const content = Array.isArray(result.content) ? result.content : [];
  if (isObject(result.structuredContent)) {
    const before = JSON.stringify(result.structuredContent);
    const structuredContent = { ...result.structuredContent, inputAdjusted: joined(result.structuredContent.inputAdjusted, adjusted) };
    return { ...result, structuredContent, content: content.map((c, i) => (i === 0 && c?.type === 'text' && c.text === before ? { ...c, text: JSON.stringify(structuredContent) } : c)) };
  }
  if (content[0]?.type === 'text') {
    try { const v = JSON.parse(content[0].text); if (isObject(v)) return { ...result, content: [{ ...content[0], text: JSON.stringify({ ...v, inputAdjusted: joined(v.inputAdjusted, adjusted) }) }, ...content.slice(1)] }; } catch { /* plain text */ }
  }
  return { ...result, content: [...content, { type: 'text', text: JSON.stringify({ inputAdjusted: adjusted }) }] };
}

// The call shapes taken as meant (call-shapes.mjs), first in the answer's normalizations (the tool may add its own after).
export function withNormalizations(result, normalizations) {
  if (!result || typeof result !== 'object' || result.resultType === 'input_required' || !normalizations?.length) return result;
  const content = Array.isArray(result.content) ? result.content : [];
  const merged = v => ({ ...v, normalizations: mergeNormalizations(v.normalizations, normalizations) });
  if (isObject(result.structuredContent)) {
    const before = JSON.stringify(result.structuredContent);
    const structuredContent = merged(result.structuredContent);
    return { ...result, structuredContent, content: content.map((c, i) => (i === 0 && c?.type === 'text' && c.text === before ? { ...c, text: JSON.stringify(structuredContent) } : c)) };
  }
  if (content[0]?.type === 'text') {
    try { const v = JSON.parse(content[0].text); if (isObject(v)) return { ...result, content: [{ ...content[0], text: JSON.stringify(merged(v)) }, ...content.slice(1)] }; } catch { /* plain text */ }
  }
  return { ...result, content: [...content, { type: 'text', text: JSON.stringify({ normalizations }) }] };
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

export function relaxTool(name, config, handler, { prepare } = {}) {
  try {
    if (!config || typeof handler !== 'function') return { config, handler };
    const standard = standardOf(config.inputSchema);
    if (!standard) return { config, handler };
    const std = standard['~standard'];
    const json = jsonSchemaOf(standard);
    if (!isObject(json)) return { config, handler };
    const words = name === 'studio_authorize' ? new Set([...WORDS, 'text']) : WORDS;
    // Only a tool that declares it changes nothing runs corrected arguments (G7); no annotation is a write.
    const normalize = config.annotations?.readOnlyHint === true ? readNormalized : normalizeArguments;
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
    // What the layer renamed or coerced is held like what was sent (ssam.mjs: a budget under the answer ceiling).
    // The call shapes of one meaning first (call-shapes.mjs), then the field names, then prepare.
    const prepared = raw => {
      const shaped = shapeCall(name, raw === undefined || raw === null ? {} : raw);
      const n = normalize(json, shaped.args);
      return { n, shaped, args: n.violations.length ? null : typeof prepare === 'function' ? prepare(n.args) : n.args };
    };
    const relaxedHandler = async (raw, ctx) => {
      const { n, shaped, args } = prepared(raw);
      const noted = result => withNormalizations(result, shaped.normalizations);
      if (n.violations.length) return noted(inputInvalidAnswer(name, n.violations, forEcho(n.corrected, words), { fixed: n.fixed }));
      if (!n.batches.length) {
        const r = await run(args, ctx);
        return noted(r.refused ?? withInputAdjusted(r.result, n.adjusted));
      }
      // select above its limit: one call per batch, in order; a refused batch ends it and answers for the call.
      const [{ key, size }] = n.batches;
      const all = args[key]; const results = [];
      for (let i = 0; i < all.length; i += size) {
        const r = await run({ ...args, [key]: all.slice(i, i + size) }, ctx);
        if (r.refused) return noted(r.refused);
        const value = structuredOf(r.result);
        if (r.result?.resultType === 'input_required' || r.result?.isError === true || value?.ok === false || value === undefined) return noted(withInputAdjusted(r.result, n.adjusted));
        results.push(r.result);
      }
      const merged = mergeValues(results.map(structuredOf));
      const structured = results.every(r => r.structuredContent !== undefined);
      return noted(withInputAdjusted({ content: [{ type: 'text', text: JSON.stringify(merged) }], ...(structured ? { structuredContent: merged } : {}) }, n.adjusted));
    };
    return { config: { ...config, inputSchema: relaxed }, handler: relaxedHandler, argsOf: raw => prepared(raw).args };
  } catch {
    return { config, handler };
  }
}
