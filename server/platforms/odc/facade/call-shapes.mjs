// The call shapes of one meaning (owner direction 2026-10-12, family "the shape of the call"): a model writes the same call
// in several shapes. Each shape that can mean only one thing is taken as meant BEFORE the tool's schema is checked, and
// listed in the answer's `normalizations` [{rule, at, note}]; a shape with two readings is left as it came, so the schema
// (or the tool) refuses it once, naming what to give. Derived from every ssam_code / o11_deliver call of the owner session
// of 2026-10-12 and from the tools' schemas, never from one scenario:
//   ssam_code
//     - action: grammar|read|write by the words a model uses for them (syntax, help, get, show, deliver, apply, save...);
//     - part: ddl|logic|html by their synonyms (data, sql, flow, pseudocode, screen, ui...);
//     - the text in another field: code, content, source, body, document(s), texts; html, ddl, sql, logic, flow (which also
//       say the part); any of them, or text and element, wrapped in data {...} (wrong nesting);
//     - the element in another field: screen(s), block(s) (part html), entity, entities, structure (part ddl);
//     - also: one item instead of a list; an item that is only a text; the same field synonyms inside an item; ops inside an
//       item (they are the write's ops); the call's own module, lane or action repeated in an item;
//     - ops: one op instead of a list.
//   o11_deliver, studio_deliver, ssam_job, o11_job
//     - ops beside the job (no job, no patch): they are the job;
//     - job as one op {op: ...}: a job of that op.
// What a job's ops look like inside (props{} on set, keys inside data, text beside data...) is normalized where every job
// enters a delivery (ssam-code.mjs normalizeCodeOps, through job-patch.mjs), so a job file gets the same rules.
// Pure: no I/O.
import { canonicalPart, CODE_PARTS } from './ssam-code.mjs';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' || (Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string'));

export const ACTION_SYNONYMS = Object.freeze({
  grammar: ['grammar', 'syntax', 'help', 'card', 'cards', 'example', 'examples', 'docs', 'doc', 'reference', 'rules'],
  read: ['read', 'get', 'view', 'show', 'inspect', 'fetch', 'load', 'open', 'list', 'dump', 'export'],
  write: ['write', 'deliver', 'apply', 'save', 'put', 'edit', 'update', 'create', 'change', 'set', 'commit', 'push', 'upsert', 'patch'],
  check: ['check', 'validate', 'verify', 'lint', 'dry-run', 'dryrun', 'preflight'],
  plan: ['plan', 'fanout', 'fan-out', 'divide', 'dividir', 'planejar', 'split-work'],
});
export const canonicalAction = word => (typeof word !== 'string' ? null
  : Object.entries(ACTION_SYNONYMS).find(([, ws]) => ws.includes(word.trim().toLowerCase()))?.[0] ?? null);

// Fields that carry the text alone, and fields whose name also says the part.
const TEXT_FIELDS = ['code', 'content', 'source', 'body', 'document', 'documents', 'texts'];
const PART_TEXT_FIELDS = { html: 'html', ddl: 'ddl', sql: 'ddl', logic: 'logic', flow: 'logic', flows: 'logic', pseudocode: 'logic' };
// Fields that carry the element, with the part they say.
const ELEMENT_FIELDS = { screen: 'html', screens: 'html', block: 'html', blocks: 'html', entity: 'ddl', entities: 'ddl', structure: 'ddl' };
const CODE_TOOLS = new Set(['ssam_code']);
const JOB_TOOLS = new Set(['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job']);

// The text and element of one write item (the call itself or an also item), in place on a copy.
function carriers(a, base, note, { list = true } = {}) {
  if (typeof a.part === 'string' && !CODE_PARTS.includes(a.part)) {
    const part = canonicalPart(a.part);
    if (part) { note('part-synonym', base + '/part', `"${a.part}" is part ${part}`); a.part = part; }
  }
  if (a.text == null) {
    const field = TEXT_FIELDS.find(k => isText(a[k]));
    if (field) { a.text = a[field]; delete a[field]; note('text-field', base + '/' + field, `${field} is the text`); }
  }
  if (a.text == null) {
    const field = Object.keys(PART_TEXT_FIELDS).find(k => isText(a[k]) && (a.part == null || a.part === PART_TEXT_FIELDS[k]));
    if (field) {
      const part = PART_TEXT_FIELDS[field];
      a.text = a[field]; delete a[field];
      note('text-field', base + '/' + field, `${field} is the text` + (a.part == null ? ` of part ${part}` : ''));
      a.part ??= part;
    }
  }
  if (a.element == null) {
    const field = Object.keys(ELEMENT_FIELDS).find(k => (typeof a[k] === 'string' && a[k]) || (list && isText(a[k])) );
    if (field && (a.part == null || a.part === ELEMENT_FIELDS[field])) {
      const part = ELEMENT_FIELDS[field];
      a.element = Array.isArray(a[field]) && a[field].length === 1 ? a[field][0] : a[field]; delete a[field];
      note('element-field', base + '/' + field, `${field} is the element` + (a.part == null ? ` of part ${part}` : ''));
      a.part ??= part;
    }
  }
  return a;
}

// data {...} around the fields of the item itself (text, part, element, basedOn and their carriers): they go up.
const OWN_IN_DATA = new Set(['text', 'part', 'element', 'basedOn', 'removes', ...TEXT_FIELDS, ...Object.keys(PART_TEXT_FIELDS), ...Object.keys(ELEMENT_FIELDS)]);
function unwrapData(a, base, note) {
  if (!isObject(a.data)) return a;
  const keys = Object.keys(a.data);
  if (!keys.length || !keys.every(k => OWN_IN_DATA.has(k)) || keys.some(k => a[k] != null)) return a;
  const { data, ...rest } = a;
  note('data-wrapper', base + '/data', `data {${keys.join(', ')}} holds the call's own fields`);
  return { ...rest, ...data };
}

function codeShape(input, note) {
  let a = { ...input };
  if (typeof a.action === 'string' && !['grammar', 'read', 'write', 'check', 'plan'].includes(a.action)) {
    const action = canonicalAction(a.action);
    if (action) { note('action-synonym', '/action', `"${a.action}" is action ${action}`); a.action = action; }
  }
  a = carriers(unwrapData(a, '', note), '', note);
  if (a.files == null) {
    const field = ['file', 'paths', 'filePaths'].find(k => typeof a[k] === 'string' || Array.isArray(a[k]));
    if (field) { a.files = a[field]; delete a[field]; note('files-field', '/' + field, `${field} is files`); }
  }
  if (typeof a.files === 'string') { a.files = [a.files]; note('files-list', '/files', 'one path is a list of one'); }
  if (isObject(a.ops)) { a.ops = [a.ops]; note('ops-list', '/ops', 'one op is a list of one'); }
  if (a.also != null && !Array.isArray(a.also) && (isObject(a.also) || typeof a.also === 'string')) { a.also = [a.also]; note('also-list', '/also', 'one item is a list of one'); }
  if (Array.isArray(a.also)) {
    const hoisted = [];
    a.also = a.also.flatMap((raw, i) => {
      const base = `/also/${i}`;
      let item = raw;
      if (isText(item)) { note('also-text', base, 'an item that is only a text is {text}'); item = { text: item }; }
      if (!isObject(item)) return [item];
      item = carriers(unwrapData({ ...item }, base, note), base, note, { list: false });
      if (Array.isArray(item.ops) || isObject(item.ops)) {
        hoisted.push(...[].concat(item.ops)); delete item.ops;
        note('also-ops', base + '/ops', 'ops of an item are ops of the write');
      }
      for (const k of ['module', 'target', 'lane', 'action']) {
        if (item[k] != null && (item[k] === a[k] || (k === 'target' && item[k] === a.module) || (k === 'module' && item[k] === a.target) || (k === 'action' && canonicalAction(item[k]) === 'write'))) {
          delete item[k]; note('also-own-field', `${base}/${k}`, `${k} of the call, repeated in the item`);
        }
      }
      return Object.keys(item).length ? [item] : [];
    });
    if (hoisted.length) a.ops = [...(Array.isArray(a.ops) ? a.ops : []), ...hoisted];
  }
  return a;
}

function jobShape(input, note) {
  const a = { ...input };
  if (a.job == null && a.patch == null && (Array.isArray(a.ops) || isObject(a.ops))) {
    a.job = { ops: [].concat(a.ops) }; delete a.ops; note('job-ops', '/ops', 'ops beside the job are the job');
  }
  if (isObject(a.job) && typeof a.job.op === 'string' && a.job.ops == null && a.job.jobs == null) {
    a.job = { ops: [a.job] }; note('job-single-op', '/job', 'one op is a job of that op');
  }
  return a;
}

/** {args, normalizations}: the arguments of a call with every shape of one meaning written as the tool takes it. */
export function shapeCall(tool, args) {
  const normalizations = [];
  if (!isObject(args)) return { args, normalizations };
  const note = (rule, at, text) => normalizations.push({ rule, at, note: text });
  const shaped = CODE_TOOLS.has(tool) ? codeShape(args, note) : JOB_TOOLS.has(tool) ? jobShape(args, note) : args;
  return { args: normalizations.length ? shaped : args, normalizations };
}
