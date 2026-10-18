// Closed guards of the compact tool listing. The projection may shorten text; it never erases a rule, in meaning and
// not only in words (CX11 correções 2 e 3).
// - Every projected parameter text (omitted or shortened) keeps each rule kind of its original (RULE_KINDS): in its own
//   words, or, under a reason of a closed list, in served evidence that carries the kind. A default keeps its value; a
//   carrier word counts only outside the parameter's own name.
// - A protected clause (PROTECTED_KINDS) of every projected parameter is declared in a closed list, bound by sha256 to
//   the sentence of the original that triggered it (review), and stays in the served listing.
// - Every sentence of an original tool description with a protected marker (TOOL_SENTENCE_KINDS) has declared clauses,
//   bound the same way, served in the tool's listing; a tool with an omission points to ssam_reference.
// - A credential-named parameter is never served without its meaning, described or not in the original.
// The tables are data of tool-listing.mjs; this module only judges them. Changing a clause, or the original sentence it
// stands for, is a problem until the review hash is recomputed: a meaning never changes in silence.
// (Circular import on purpose: toolTexts is a hoisted function declaration, used only at call time.)
import { createHash } from 'node:crypto';
import { toolTexts } from './tool-listing.mjs';

// What counts as a rule in an original parameter description (the reviewed CX11 list plus guard words).
export const RULE_KINDS = Object.freeze({
  default: /\bdefaults?\b/i,
  format: /\bformat\b|\be\.g\.|\bexample\b|\bISO\b|"[^"]+"/i,
  privacy: /\b(?:credentials?|secrets?|private(?:ly)?|passwords?)\b/i,
  authorization: /\b(?:authoriz\w*|words|grant\w*)\b/i,
  destructive: /\b(?:replac\w*|delet\w*|overwrit\w*|discard\w*)\b/i,
  constraint: /\b(?:only|never|must|absolute)\b/i,
  guard: /\b(?:refus\w*|drift|requir\w*|exact(?:ly)?|bare|verbatim)\b|\bat most\b|\bmutually exclusive\b/i,
});
// Why an omission is acceptable. Nothing else is a reason (no free text).
export const OMISSION_REASONS = Object.freeze({
  'name-and-type': 'The name and schema say it all; the original states no rule.',
  'stated-in-tool-text': 'The served tool description states the rule under this parameter name (literal evidence).',
  'carried-by-schema': 'Schema keywords served with the parameter carry the rule (keyword evidence).',
  'same-text-as': 'Another served parameter of this tool has the identical original text and keeps the rule (pointer evidence).',
});
// Why a shortened text may leave a rule kind to other served text: the same evidence rules, never name-and-type.
export const SHORTENED_REASONS = Object.freeze({
  'stated-in-tool-text': OMISSION_REASONS['stated-in-tool-text'],
  'carried-by-schema': OMISSION_REASONS['carried-by-schema'],
});
// Clauses that never leave the served listing of a projected parameter, whatever the budget. name: detection by the
// parameter's own name; text: detection in its original text (the sentences it matches are the bound source).
// detect(name, text): the kind applies to a parameter of that name and original text.
const protectedKind = p => Object.freeze({ ...p, detect: (name, text) => Boolean(p.name?.test(name) || p.text.test(text ?? '')) });
export const PROTECTED_KINDS = Object.freeze({
  destructive: protectedKind({ name: null, text: /\b(?:delet(?:e|es|ed|ing|ion)|discard(?:s|ed|ing)?|overwrit(?:e|es|ten|ing))\b|\breplaces? the existing\b/i, carrier: /delet|discard|overwrit|replac|remov|destructive/i }),
  credential: protectedKind({ name: /credential|password|secret|token|login/i, text: /\b(?:credentials?|passwords?|secrets?|non-secret)\b/i, carrier: /credential|password|secret|vault/i }),
  authorization: protectedKind({ name: /^(?:authorize|authorization|authorizationContext|words|question)$/, text: /\b(?:authoriz\w*|words|grant\w*|approval)\b/i, carrier: /\bwords\b|verbatim|authoriz|grant|approval|human/i }),
  host: protectedKind({ name: /^(?:host|tenant|expectedEnvironment|confirmHost|confirmTenant)$/, text: /\bbare host\b/i, carrier: /\bhost\b|\btenant\b|\bDNS\b|\benvironment\b/i }),
});
// Markers of a sentence of an original tool description whose rule stays in the served listing (bound clauses).
export const TOOL_SENTENCE_KINDS = Object.freeze({
  credential: Object.freeze({ detect: /credential|password|secret/i, carrier: /credential|password|secret|vault/i }),
  destructive: Object.freeze({ detect: /\bdelet/i, carrier: /delet|remov|destructive/i }),
  authorization: Object.freeze({ detect: /authoriz|\bwords\b|\bgrant/i, carrier: /authoriz|\bwords\b|grant|approval|verbatim/i }),
  never: Object.freeze({ detect: /\bnever\b/i, carrier: /\bnever\b/i }),
  onlyWhen: Object.freeze({ detect: /\bonly when\b/i, carrier: /\bonly\b|\biff\b/i }),
});

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parameterName = pointer => pointer.split('/').pop().replace(/~1/g, '/').replace(/~0/g, '~');
const word = w => new RegExp('(?<![A-Za-z0-9_])' + escapeRegExp(w) + '(?![A-Za-z0-9_])', 'i');
export const namesParameter = (text, name) => word(name).test(text);
// A carrier word counts only outside the parameter's own name (credentialTarget, replace, host, tenant...).
export const outsideName = (text, name) => name ? text.replace(new RegExp('(?<![A-Za-z0-9_])' + escapeRegExp(name) + '(?![A-Za-z0-9_])', 'gi'), ' ') : text;
export const sha256 = text => createHash('sha256').update(text).digest('hex');
// The review hash that binds a declared clause (or clauses) to the original sentences it stands for.
export const reviewHash = (sentences, clauses) => sha256(JSON.stringify([sentences, clauses]));
// The review hash that binds a served text (null: omitted) to the original text it replaces.
export const textReviewHash = (original, served) => sha256(JSON.stringify([original ?? null, served ?? null]));
// Sentences of a text (abbreviations e.g./i.e. kept whole).
export function sentencesOf(text) {
  const masked = (text ?? '').replace(/\be\.g\./gi, m => m.replace(/\./g, '․')).replace(/\bi\.e\./gi, m => m.replace(/\./g, '․'));
  return masked.split(/(?<=\.)\s+/).map(s => s.replace(/․/g, '.').trim()).filter(Boolean);
}
export function ruleKinds(text) {
  return Object.entries(RULE_KINDS).filter(([, re]) => re.test(text ?? '')).map(([kind]) => kind);
}
// Tokens a format rule is made of: quoted values, the first token of each e.g., acronyms, templates and page paths.
export function formatTokens(original) {
  const tokens = new Set();
  for (const m of original.matchAll(/"([^"]{3,})"/g)) tokens.add(m[1]);
  for (const m of original.matchAll(/\be\.g\.\s*([^\s,;()]+)/g)) { const t = m[1].replace(/^["'{]+|["'.}]+$/g, ''); if (t.length >= 2) tokens.add(t); }
  for (const m of original.matchAll(/\b[A-Z][A-Z0-9]{2,}(?:-[0-9]+)?\b/g)) tokens.add(m[0]);
  for (const m of original.matchAll(/<[^<>\s]+>|\/[A-Za-z][\w-]*\//g)) tokens.add(m[0]);
  for (const m of original.matchAll(/(\w+)\s+format\b/gi)) tokens.add(m[1]);
  return [...tokens];
}
// The values a text states as defaults, each bound to its marker: "default[s] (is|to|:|=)? <v>", "<v> (default)",
// "<v> by default" and, when the parameter is named, "<name>=<v>" (also "<a>/<name>/<b>=<v>"). A loose "=" elsewhere
// in the text states nothing.
const DEFAULT_SKIP = /^(?:the|a|an|that|this|its|it|from|is|to|be|of)$/i;
const cleanValue = w => w.replace(/'s$/i, '').replace(/[.,;:]+$/, '');
export function statedDefaults(text, name = '') {
  const values = new Set();
  for (const m of (text ?? '').matchAll(/\bdefaults?\b\s*(?:is\s+|to\s+|:\s*|=\s*)?((?:[\w.$'-]+\s+){0,3}[\w.$'-]+)?/gi)) {
    const words = (m[1] ?? '').split(/\s+/).map(cleanValue).filter(w => w && !DEFAULT_SKIP.test(w));
    if (words[0]) values.add(words[0]);
  }
  for (const m of (text ?? '').matchAll(/([\w.$-]+)\s*\(default\)/gi)) values.add(cleanValue(m[1]));
  for (const m of (text ?? '').matchAll(/([\w.$'-]+)\s+by default\b/gi)) values.add(cleanValue(m[1]));
  if (name) for (const m of (text ?? '').matchAll(/([\w$.\/-]+)\s*=\s*([\w.$'-]+)/g))
    if (m[1].split('/').some(n => n.toLowerCase() === name.toLowerCase())) values.add(cleanValue(m[2]));
  return [...values].filter(Boolean);
}
// The values a default of the original names (the same markers, read in the original text).
export const defaultValues = original => statedDefaults(original);
const CONSTRAINT = [[/\bonly\b/i, /\bonly\b|\biff\b/i], [/\bnever\b/i, /\bnever\b/i], [/\bmust\b/i, /\bmust\b|\brequire[sd]?\b|\bneeds?\b/i], [/\babsolute\b/i, /\babsolute\b/i]];
const GUARD = [[/\brefus\w*|\bdrift\b/i, /refus|drift/i], [/\brequir\w*/i, /requir|\bmust\b|\bneeds?\b/i], [/\bexact(?:ly)?\b/i, /\bexact/i], [/\bbare\b/i, /\bbare\b/i], [/\bverbatim\b/i, /\bverbatim\b/i], [/\bat most\b/i, /\bat most\b|\bmax/i], [/\bmutually exclusive\b/i, /exclusive|\bexcludes?\b|\bnot with\b/i]];
// Whether evidence text carries one rule kind of an original text, outside the parameter's own name. Marker kinds need
// every marker of the original; a default needs the same value.
export function carries(kind, original, text, name = '') {
  const t = outsideName(text, name);
  // A default keeps its value, stated together with its marker; without a value in the original, a marker suffices.
  if (kind === 'default') {
    const values = defaultValues(original), stated = statedDefaults(text, name).map(v => v.toLowerCase());
    return values.length ? values.some(v => stated.includes(v.toLowerCase())) : stated.length > 0 || /\bdefaults?\b|\(default\)|\bby default\b/i.test(t);
  }
  if (kind === 'format') { const tokens = formatTokens(original); return tokens.length ? tokens.some(tok => t.toLowerCase().includes(tok.toLowerCase())) : /\bformat\b|e\.g\.|example/i.test(t); }
  if (kind === 'privacy') return /credential|secret|private|password|vault/i.test(t);
  if (kind === 'authorization') return /authoriz|\bwords\b|grant|verbatim|approval/i.test(t);
  if (kind === 'destructive') return /replac|delet|overwrit|discard|remov|destructive/i.test(t);
  const pairs = kind === 'constraint' ? CONSTRAINT : kind === 'guard' ? GUARD : null;
  if (!pairs) return false;
  return pairs.every(([inOriginal, inEvidence]) => !inOriginal.test(original) || inEvidence.test(t));
}
// A schema keyword carries a kind: default with the same value, format by enum/const/pattern/format.
function schemaCarries(kind, original, node, keyword) {
  if (!node || !Object.hasOwn(node, keyword)) return false;
  if (kind === 'default') { if (keyword !== 'default') return false; const values = defaultValues(original); return !values.length || values.some(v => String(node.default).toLowerCase() === v.toLowerCase()); }
  if (kind === 'format') return ['enum', 'const', 'pattern', 'format'].includes(keyword);
  return false;
}
const nodeAt = (schema, pointer) => pointer.split('/').slice(1).map(k => k.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((n, k) => n?.[k], schema);
// Every property node of a schema, described or not, by JSON pointer.
function propertyNodes(schema, pointer = '', out = {}) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return out;
  for (const [name, child] of Object.entries(schema.properties ?? {})) { const p = pointer + '/properties/' + name.replace(/~/g, '~0').replace(/\//g, '~1'); out[p] = child; propertyNodes(child, p, out); }
  if (schema.items && !Array.isArray(schema.items)) propertyNodes(schema.items, pointer + '/items', out);
  for (const k of ['anyOf', 'oneOf', 'allOf']) (schema[k] ?? []).forEach((c, i) => propertyNodes(c, pointer + '/' + k + '/' + i, out));
  return out;
}
// The sentences of an original parameter text a protected kind stands on (all of them when only the name triggered it).
export function protectedSentences(kind, name, original) {
  const p = PROTECTED_KINDS[kind], all = sentencesOf(original), hit = all.filter(s => p.text.test(s));
  return hit.length ? hit : all;
}
const detectsProtected = (kind, name, original) => Boolean(PROTECTED_KINDS[kind].name?.test(name) || PROTECTED_KINDS[kind].text.test(original));
const clauseOf = c => typeof c === 'string' ? { clause: c } : c ?? {};

// Evidence items (omission or shortened text) that exist in the served listing, as carriers; problems are pushed.
function evidenceCarriers(entry, ctx) {
  const { problems, at, served, name, before, after, listed, pointer, original } = ctx, carriers = [];
  for (const item of entry.evidence ?? []) {
    if (typeof item === 'string') {
      if (entry.reason !== 'stated-in-tool-text') problems.push(at + ': literal evidence under ' + entry.reason);
      else if (!served.includes(item)) problems.push(at + ': evidence not in the served tool description: ' + JSON.stringify(item));
      else if (!namesParameter(item, name)) problems.push(at + ': evidence does not name ' + name + ': ' + JSON.stringify(item));
      else carriers.push(item);
    } else if (item && typeof item.schema === 'string') {
      const node = nodeAt(listed.inputSchema, pointer);
      if (!node || !Object.hasOwn(node, item.schema)) problems.push(at + ': schema keyword not served: ' + item.schema);
      else carriers.push({ schema: item.schema, node });
    } else if (item && typeof item.param === 'string') {
      if (entry.reason !== 'same-text-as') problems.push(at + ': pointer evidence under ' + entry.reason);
      else if (before.params[item.param] !== original) problems.push(at + ': original differs from ' + item.param);
      else if (!after.params[item.param]?.trim()) problems.push(at + ': ' + item.param + ' is not served with text');
      else carriers.push(after.params[item.param]);
    } else problems.push(at + ': malformed evidence ' + JSON.stringify(item));
  }
  if (entry.reason === 'carried-by-schema' && carriers.some(c => typeof c === 'string')) problems.push(at + ': carried-by-schema takes schema keywords only');
  return carriers;
}
const carriedBy = (kind, original, name, carriers) => carriers.some(c => typeof c === 'string' ? carries(kind, original, c, name) : schemaCarries(kind, original, c.node, c.schema));

// Every problem of one projection: an empty list means the served listing keeps every rule of the original.
// tables: { omissions, shortened, parameterClauses, toolClauses, requiredToolClauses } of this tool.
export function projectionProblems(source, listed, { omissions = {}, shortened = {}, parameterClauses = {}, toolClauses = [], requiredToolClauses = [], reviews = {} } = {}) {
  const problems = [], at = pointer => source.name + pointer;
  const before = toolTexts(source), after = toolTexts(listed), served = after.description ?? '';
  // 0. Every projected text (the description, a shortened parameter text or an omission) carries review =
  //    sha256 of [original, served]: any change of meaning is a problem until it is reviewed again (no served byte).
  const reviewed = new Set();
  if (served !== (before.description ?? '')) {
    reviewed.add('description'); const expected = textReviewHash(before.description, served);
    if (reviews.description !== expected) problems.push(source.name + ': description not reviewed against the original (review ' + expected + ')');
  }
  for (const [pointer, original] of Object.entries(before.params)) {
    const text = after.params[pointer];
    if (text === original) continue;
    reviewed.add(pointer); const expected = textReviewHash(original, text ?? null);
    if (reviews[pointer] !== expected) problems.push(at(pointer) + ': text not reviewed against the original (review ' + expected + ')');
  }
  for (const key of Object.keys(reviews)) if (!reviewed.has(key)) problems.push(source.name + ': stale review for ' + key);
  const servedListing = [served, ...Object.values(after.params)].join('\n');
  let omitted = 0;
  // 1. Rule kinds of every projected parameter text: omitted or shortened.
  for (const [pointer, original] of Object.entries(before.params)) {
    if (!original.trim()) continue;
    const name = parameterName(pointer), text = after.params[pointer];
    if (text === original) { if (shortened[pointer]) problems.push(at(pointer) + ': shortened evidence declared for an unprojected parameter'); continue; }
    const ctx = { problems, at: at(pointer), served, name, before, after, listed, pointer, original };
    const kinds = ruleKinds(original);
    if (text === undefined) {
      omitted++;
      if (shortened[pointer]) problems.push(at(pointer) + ': shortened evidence declared for an omitted parameter');
      const entry = omissions[pointer];
      if (!entry) { problems.push(at(pointer) + ': omitted without a reviewed omission'); continue; }
      if (typeof entry !== 'object' || !Object.hasOwn(OMISSION_REASONS, entry.reason)) { problems.push(at(pointer) + ': omission reason not in the closed list: ' + JSON.stringify(typeof entry === 'object' ? entry.reason : entry)); continue; }
      if (entry.reason === 'name-and-type') {
        if (kinds.length) problems.push(at(pointer) + ': original states ' + kinds.join('/') + ' rules; name-and-type cannot omit them');
        if (entry.evidence?.length) problems.push(at(pointer) + ': name-and-type takes no evidence');
        continue;
      }
      if (!entry.evidence?.length) { problems.push(at(pointer) + ': ' + entry.reason + ' without evidence'); continue; }
      const carriers = evidenceCarriers(entry, ctx);
      for (const kind of kinds) if (!carriedBy(kind, original, name, carriers)) problems.push(at(pointer) + ': ' + kind + ' rule of the original is not carried by the evidence');
      continue;
    }
    if (omissions[pointer]) problems.push(at(pointer) + ': omission declared for a served text');
    const lost = kinds.filter(kind => !carries(kind, original, text, name));
    const entry = shortened[pointer];
    if (!lost.length) { if (entry) problems.push(at(pointer) + ': stale shortened evidence (the text carries every rule kind)'); continue; }
    if (!entry) { problems.push(at(pointer) + ': shortened text loses ' + lost.join('/') + ' of the original'); continue; }
    if (!Object.hasOwn(SHORTENED_REASONS, entry.reason)) { problems.push(at(pointer) + ': shortened reason not in the closed list: ' + JSON.stringify(entry.reason)); continue; }
    const carriers = evidenceCarriers(entry, ctx);
    for (const kind of lost) if (!carriedBy(kind, original, name, carriers)) problems.push(at(pointer) + ': ' + kind + ' rule lost by the shortened text is not carried by the evidence');
  }
  // 2. Protected clauses of every projected parameter, bound to the sentence of the original that triggered them.
  const readOnly = source.annotations?.readOnlyHint === true;
  for (const [pointer, original] of Object.entries(before.params)) {
    const text = after.params[pointer];
    const declared = parameterClauses[pointer] ?? {};
    // A parameter served with its original text keeps every clause; a declaration on it is still verified (bound).
    if (text === original && !Object.keys(declared).length) continue;
    const name = parameterName(pointer);
    // An omission with the identical original text of a served sibling keeps its clauses in that sibling's text.
    const sibling = omissions[pointer]?.reason === 'same-text-as' ? omissions[pointer].evidence?.[0]?.param : undefined;
    const siblingText = sibling !== undefined && before.params[sibling] === original ? after.params[sibling] ?? '' : '';
    const detected = Object.keys(PROTECTED_KINDS).filter(kind => !(kind === 'destructive' && readOnly) && detectsProtected(kind, name, original));
    for (const kind of Object.keys(declared)) if (!detected.includes(kind)) problems.push(at(pointer) + ': stale protected ' + kind + ' clause');
    for (const kind of detected) {
      const { clause, review } = clauseOf(declared[kind]);
      if (!clause) { problems.push(at(pointer) + ': protected ' + kind + ' clause not declared'); continue; }
      const expected = reviewHash(protectedSentences(kind, name, original), clause);
      if (review !== expected) problems.push(at(pointer) + ': protected ' + kind + ' clause not reviewed against the original sentence (review ' + expected + ')');
      if (!PROTECTED_KINDS[kind].carrier.test(outsideName(clause, name))) problems.push(at(pointer) + ': declared ' + kind + ' clause does not carry it outside the parameter name: ' + JSON.stringify(clause));
      else if (!(text?.includes(clause) || siblingText.includes(clause) || (served.includes(clause) && namesParameter(clause, name)))) problems.push(at(pointer) + ': protected ' + kind + ' clause missing from the served listing: ' + JSON.stringify(clause));
    }
  }
  // 3. A credential-named parameter is never served without its meaning: its own text, or a served sentence naming it.
  const nodes = propertyNodes(listed.inputSchema);
  for (const [pointer, node] of Object.entries(nodes)) {
    const name = parameterName(pointer);
    if (!PROTECTED_KINDS.credential.name.test(name)) continue;
    const own = typeof node?.description === 'string' && node.description.trim();
    const named = sentencesOf(served).some(s => namesParameter(s, name));
    if (!own && !named) problems.push(at(pointer) + ': credential parameter served without its meaning (no text, no served sentence naming it)');
  }
  // 4. Sentences of the original tool description with protected markers keep bound clauses in the served listing.
  if (listed !== source && (after.description ?? '') !== (before.description ?? '')) {
    const sentences = sentencesOf(before.description).filter(s => Object.values(TOOL_SENTENCE_KINDS).some(k => k.detect.test(s)));
    const declared = Array.isArray(toolClauses) ? toolClauses : [];
    for (const entry of declared) if (!sentences.includes(entry?.sentence)) problems.push(source.name + ': stale tool sentence clause: ' + JSON.stringify(String(entry?.sentence).slice(0, 80)));
    for (const sentence of sentences) {
      const entry = declared.find(e => e?.sentence === sentence);
      if (!entry) { problems.push(source.name + ': tool sentence without a bound clause: ' + JSON.stringify(sentence.slice(0, 120))); continue; }
      const clauses = [entry.clauses].flat().filter(Boolean);
      const expected = reviewHash([sentence], clauses);
      if (entry.review !== expected) problems.push(source.name + ': tool sentence clause not reviewed against the original sentence (review ' + expected + '): ' + JSON.stringify(sentence.slice(0, 80)));
      for (const clause of clauses) if (!servedListing.includes(clause)) problems.push(source.name + ': tool clause missing from the served listing: ' + JSON.stringify(clause));
      for (const [kind, k] of Object.entries(TOOL_SENTENCE_KINDS)) if (k.detect.test(sentence) && !clauses.some(c => k.carrier.test(c))) problems.push(source.name + ': tool sentence ' + kind + ' rule not carried by its clauses: ' + JSON.stringify(sentence.slice(0, 80)));
    }
  }
  if (omitted && !served.includes('ssam_reference')) problems.push(source.name + ': ' + omitted + ' omitted parameter descriptions but no ssam_reference pointer');
  for (const clause of requiredToolClauses) if (!served.includes(clause)) problems.push(source.name + ': protected tool clause missing: ' + JSON.stringify(clause));
  return problems;
}
