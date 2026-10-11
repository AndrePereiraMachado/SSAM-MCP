// ssam_reference: the kernel's own references, read-only, for either lane, from that lane's CLI (anvil.dll for O11,
// anvil-odc.dll for ODC): Model API (api), built-in functions, UI blocks of a UI catalog, Studio types, where an
// object can be created (where-can), recipes, Verify messages, and the two offline checks (check-job, check-delivery);
// plus the team rules (rules), answered from their files on both lanes.
// The ODC CLI has only `api --op`, `check-job` and `verify-catalog` (kernel/src/Anvil.Cli.Odc/Program.cs): an interface
// name there is answered by `api --op native --type`, a Verify message by verify-catalog; the other kinds refuse by
// naming the O11 lane. Static answers are cached in memory per (lane, kind, query) for the life of the server;
// check-job and check-delivery always run. where-can, verify-message, api and recipe find the repository from the
// process folder (RepoRoot falls back to the working directory once the Studio assemblies are bound), so every call
// runs with cwd = the kernel (anvilRoot). A large answer is written to <lane.local>/reference/<hash>.json.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { anvilRoot, o11Lane } from './workspace.mjs';
import { o11LaneOf } from './o11-lane.mjs';
import { createAnvilRunner } from './anvil-cli.mjs';
import { hostedContext, seamFields, usesWorkspace, workspacePath } from './executor.mjs';
import { GUIDE_FILES, guideSections, guideText } from './runtime-guides.mjs';
import { closest } from './tool-input.mjs';
import { refusalFields } from './refusal-problems.mjs';
import { resolvePatchedJob, jobIdentity, withNamedPatches } from './job-patch.mjs';

// The base a job names ({"base": "..."}), or null: a job without one is checked alone (the CLI's default fixture is not
// the module the job was written for).
const declaredBase = file => {
  try { const job = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); return job && !Array.isArray(job) && typeof job.base === 'string' && job.base.trim() ? job.base : null; }
  catch { return null; }
};
// Hosted (servidor/fase4-22): the base a job declares resolves on the server (a path anywhere on it, or a name of the
// kernel's suite, whose fixtures are customer captures), never inside the customer's workspace; the hosted ssam_job never
// applies over it either (hosted/policy.mjs NEUTRAL_ODC_BASE). So a hosted check-job reads the job alone, as before the
// 22nd release, and says why the other phases did not run.
export const HOSTED_DECLARED_BASE_REASON = 'hosted SSAM server: the base this job declares is not read here (it would resolve on the server, outside '
  + 'your workspace), so only the job was read and the base check, the apply and the Verify did not run; studio_deliver (ODC) and o11_deliver (O11) '
  + 'check every phase over your live module, once, before any change';

export const REFERENCE_KINDS = ['api', 'functions', 'ui-block', 'types', 'where-can', 'recipe', 'check-job', 'check-delivery', 'verify-message', 'example', 'rules'];
// recipe and example on ODC are answered here from the suite files (no CLI): the ODC CLI has no recipe, and a session
// that asked for one got KIND_NOT_IN_LANE (62a884e8, 2026-10-04 22:09). rules is the same text on both lanes.
const ODC_KINDS = ['api', 'check-job', 'verify-message', 'recipe', 'example', 'rules'];
const FILE_KINDS = ['example'];
const UNCACHED = ['check-job', 'check-delivery'];
const INLINE_LIMIT = 48 * 1024;
const FIND_CAP = 50;

const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) });
const firstLine = text => String(text ?? '').split(/\r?\n/)[0].slice(0, 500);
const refusal = (code, error, continuation, extra = {}) => ({ ok: false, code, error, ...extra, continuation });
const canonical = value => (Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value);
const again = (lane, kind, query, why) => ({ tool: 'ssam_reference', arguments: { lane, kind, query }, why });
const doctor = (lane, why = 'the doctor reports the CLI build of each lane') => ({ tool: 'ssam_doctor', arguments: { lane }, why });

// Values become CLI option values; a value starting with "--" could switch a presence flag (recipe --ops).
const plain = value => typeof value === 'string' && value.trim() !== '' && !value.trim().startsWith('--');

// The UI catalogs are catalog/ui/<Name>-<version>.json; a name picks the newest version of that library.
export function uiCatalogs(root) {
  const dir = path.join(root, 'catalog', 'ui');
  try { return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map(f => path.join(dir, f)); }
  catch { return []; }
}
const libraryOf = file => path.basename(file, '.json').replace(/-(?:\d[\w.]*|unversioned)$/i, '');
export function resolveUiCatalog(root, name = 'OutSystemsUI') {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const wanted = name.toLowerCase().replace(/\.json$/, '');
  const all = uiCatalogs(root);
  return all.find(f => path.basename(f, '.json').toLowerCase() === wanted) ?? all.filter(f => libraryOf(f).toLowerCase() === wanted).at(-1) ?? null;
}

// recipe {find, ops:true} without max: the ops are bounded across all matches (the CLI requires --max), so the facade
// gives the bound itself (A18; "recipe --ops requires --max" cost a round in the friction report).
export const RECIPE_OPS_MAX = 20;
// A kernel task id (the folder name under <lane.work>/deliver): letters, digits and dashes, never a path.
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
// The field a query meant when it used another name (A18: "api query does not take: find"): the aliases of each field,
// then the closest name. find comes before name, so a search word stays a search where the kind has one.
const FIELD_ALIASES = {
  find: ['search', 'query', 'text', 'filter', 'term', 'contains', 'like', 'pattern', 'keyword', 'q', 'words'],
  name: ['find', 'search', 'query', 'text', 'id', 'interface', 'title', 'exact', 'key', 'verb'],
  op: ['operation', 'verb', 'grammar', 'language'],
  ops: ['withOps', 'includeOps', 'steps'],
  max: ['limit', 'top', 'count', 'take', 'size'],
  result: ['file', 'path', 'receipt', 'resultFile'],
  taskId: ['task', 'id', 'task_id', 'taskid'],
  catalog: ['library', 'lib', 'ui'],
  type: ['interface', 'native'],
  assembly: ['dll', 'module'],
  filter: ['find', 'search', 'text', 'name'],
};
// The closest valid form of a query with unknown fields: each unknown field renamed to the free field it meant (its value
// kept) or left out; the known fields as given.
export function closestForm(query, allowed) {
  const form = {}; const renamed = {}; const dropped = [];
  const free = [...allowed].sort((a, b) => (a === 'find' ? -1 : b === 'find' ? 1 : 0)).filter(k => !Object.hasOwn(query, k));
  for (const [key, value] of Object.entries(query)) {
    if (allowed.includes(key)) { form[key] = value; continue; }
    const target = free.find(k => FIELD_ALIASES[k]?.includes(key)) ?? closest(key, free);
    if (target === undefined) { dropped.push(key); continue; }
    form[target] = value; renamed[key] = target; free.splice(free.indexOf(target), 1);
  }
  return { form, renamed, dropped };
}

// The refusal of a query with unknown fields: UNKNOWN_FIELD with the closest valid form, already filled, as the continuation.
function unknownFields(lane, kind, q, allowed, extra, hint) {
  const { form, renamed, dropped } = closestForm(q, allowed);
  const note = [...Object.entries(renamed).map(([from, to]) => `${from} -> ${to}`), ...dropped.map(k => `${k} left out`)].join('; ');
  return refusal('UNKNOWN_FIELD', `${kind} query does not take: ${extra.join(', ')}; closest valid form: ${JSON.stringify(form)} (${note})`,
    again(lane, kind, form, `query fields of ${kind}: ${allowed.join(', ')}; the same query with ${note}${hint ? '; ' + hint : ''}`), { closest: form, renamed, ...(dropped.length ? { dropped } : {}) });
}

// One query -> {argv} or a refusal; an inline job comes back as {inlineJob} for the caller to store.
export function referenceArguments(lane, kind, query, { root, work }) {
  const isText = typeof query === 'string';
  const q = isText ? null : query;
  const keys = q ? Object.keys(q) : [];
  const only = (...allowed) => {
    const extra = keys.filter(k => !allowed.includes(k));
    return extra.length ? unknownFields(lane, kind, q, allowed, extra) : null;
  };
  const oneOf = (a, b) => (q[a] === undefined) === (q[b] === undefined)
    ? refusal('QUERY_SHAPE', `${kind}: give exactly one of ${a} or ${b}`, again(lane, kind, { [a]: '<' + a + '>' }, 'one lookup per call')) : null;
  const bad = (...names) => {
    const wrong = names.find(n => q?.[n] !== undefined && !plain(q[n]));
    return wrong ? refusal('BAD_VALUE', `${wrong}: empty values and values starting with "--" are refused`, again(lane, kind, '<text>', 'plain text')) : null;
  };
  if (isText && !plain(query) && !['check-job', 'check-delivery'].includes(kind))
    return refusal('BAD_VALUE', 'query: empty values and values starting with "--" are refused', again(lane, kind, '<text>', 'plain text'));
  const file = (value, label) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return refusal('PATH_NOT_ABSOLUTE', `${label} must be an absolute path`, again(lane, kind, '<absolute path>', 'absolute path'));
    if (!fs.existsSync(value)) return refusal('FILE_NOT_FOUND', `${label} not found: ${value}`, again(lane, kind, '<absolute path>', 'an existing file'));
    return null;
  };

  if (kind === 'check-job') {
    if (isText) return file(query, 'job') ?? { argv: ['check-job', '--job', query], job: query };
    // {basedOn, patch?, job?}: a patch (by index or by name) or a partial job over an earlier job (job-patch.mjs), the whole
    // job written to a new file once the call can run.
    if (q.basedOn !== undefined || q.patch !== undefined) {
      const refused = only('basedOn', 'patch', 'job');
      if (refused) return refused;
      return { argv: ['check-job', '--job'], patched: { job: q.job, patch: q.patch, basedOn: q.basedOn } };
    }
    // Stored only once the call can run (the caller checks the CLI first); its path completes the argv.
    return { argv: ['check-job', '--job'], inlineJob: q };
  }
  if (lane === 'odc') {
    if (kind === 'api') {
      if (isText) return { argv: ['api', '--op', 'native', '--type', query] };
      const refused = only('name', 'op', 'type') ?? oneOf('name', 'op') ?? bad('name', 'op', 'type');
      if (refused) return refused;
      if (q.name !== undefined) return { argv: ['api', '--op', 'native', '--type', q.name] };
      if (q.op === 'native' && q.type === undefined) return refusal('QUERY_SHAPE', 'api op native needs type', again(lane, kind, { op: 'native', type: '<Interface>' }, 'the interface to describe'));
      return { argv: q.op === 'native' ? ['api', '--op', 'native', '--type', q.type] : ['api', '--op', q.op] };
    }
    // verify-message: the ODC CLI has verify-catalog; a name is --id, a search filters the catalog here.
    if (isText) return { argv: ['verify-catalog', '--id', query] };
    const refused = only('name', 'find') ?? oneOf('name', 'find') ?? bad('name', 'find');
    if (refused) return refused;
    return q.name !== undefined ? { argv: ['verify-catalog', '--id', q.name] } : { argv: ['verify-catalog'], find: q.find };
  }

  switch (kind) {
    case 'api': {
      if (isText) return { argv: ['api', '--name', query] };
      const refused = only('name', 'op', 'type', 'catalog') ?? oneOf('name', 'op') ?? bad('name', 'op', 'type');
      if (refused) return refused;
      if (q.op !== undefined) {
        if (q.catalog !== undefined) return refusal('QUERY_SHAPE', 'catalog goes with name, not op', again(lane, kind, { op: q.op }, 'op answers from the kernel'));
        if (q.op === 'native' && q.type === undefined) return refusal('QUERY_SHAPE', 'api op native needs type', again(lane, kind, { op: 'native', type: '<Interface>' }, 'the interface to describe'));
        return { argv: q.op === 'native' ? ['api', '--op', 'native', '--type', q.type] : ['api', '--op', q.op] };
      }
      if (q.type !== undefined) return refusal('QUERY_SHAPE', 'type goes with op native', again(lane, kind, { op: 'native', type: q.type }, 'native surface of the type'));
      if (q.catalog !== undefined) return file(q.catalog, 'catalog') ?? { argv: ['api', '--name', q.name, '--catalog', q.catalog] };
      return { argv: ['api', '--name', q.name] };
    }
    case 'functions':
    case 'verify-message':
    case 'where-can': {
      const verb = kind;
      if (isText) return { argv: [verb, '--name', query] };
      const refused = kind === 'where-can' ? only('name') ?? bad('name') : only('name', 'find') ?? oneOf('name', 'find') ?? bad('name', 'find');
      if (refused) return refused;
      if (kind === 'where-can' && q.name === undefined) return refusal('QUERY_SHAPE', 'where-can needs name', again(lane, kind, '<Interface>', 'the interface to place'));
      return q.name !== undefined ? { argv: [verb, '--name', q.name] } : { argv: [verb, '--find', q.find] };
    }
    case 'ui-block': {
      const shaped = isText ? { name: query } : q;
      if (!isText) { const refused = only('catalog', 'name', 'find') ?? oneOf('name', 'find') ?? bad('catalog', 'name', 'find'); if (refused) return refused; }
      const catalog = resolveUiCatalog(root, shaped.catalog ?? 'OutSystemsUI');
      if (!catalog) {
        const available = [...new Set(uiCatalogs(root).map(f => path.basename(f, '.json')))];
        return refusal('UI_CATALOG_UNKNOWN', 'UI catalog not found: ' + (shaped.catalog ?? 'OutSystemsUI'),
          again(lane, kind, { ...shaped, catalog: available[0] ?? '<catalog>' }, 'available catalogs are listed'), { available });
      }
      return { argv: ['ui-block', '--catalog', catalog, ...(shaped.name !== undefined ? ['--name', shaped.name] : ['--find', shaped.find])] };
    }
    case 'types': {
      if (isText) return refusal('QUERY_SHAPE', 'types needs {assembly, filter, max?}', again(lane, kind, { assembly: 'ServiceStudio.Framework', filter: query }, 'the assembly to probe'));
      const refused = only('assembly', 'filter', 'max') ?? bad('assembly', 'filter');
      if (refused) return refused;
      if (q.assembly === undefined || q.filter === undefined) return refusal('QUERY_SHAPE', 'types needs assembly and filter', again(lane, kind, { assembly: q.assembly ?? 'ServiceStudio.Framework', filter: q.filter ?? '<text>' }, 'both are required'));
      if (q.max !== undefined && !(Number.isInteger(q.max) && q.max > 0 && q.max <= 5000)) return refusal('BAD_VALUE', 'max is an integer 1..5000', again(lane, kind, { assembly: q.assembly, filter: q.filter }, 'default 400'));
      return { argv: ['types', '--assembly', q.assembly, '--filter', q.filter, ...(q.max !== undefined ? ['--max', String(q.max)] : [])] };
    }
    case 'recipe': {
      if (isText) return { argv: ['recipe', '--find', query] };
      const refused = only('find', 'ops', 'max') ?? bad('find');
      if (refused) return refused;
      if (q.find === undefined) return refusal('QUERY_SHAPE', 'recipe needs find', again(lane, kind, '<text>', 'what to build'));
      if (q.ops !== undefined && typeof q.ops !== 'boolean') return refusal('BAD_VALUE', 'ops is a boolean', again(lane, kind, { find: q.find, ops: true }, 'ops: true lists the ops'));
      if (q.max !== undefined && !(Number.isInteger(q.max) && q.max > 0 && q.max <= 1000)) return refusal('BAD_VALUE', 'max is an integer 1..1000', again(lane, kind, { find: q.find }, 'no max'));
      const max = q.max ?? (q.ops === true ? RECIPE_OPS_MAX : undefined);
      return { argv: ['recipe', '--find', q.find, ...(q.ops === true ? ['--ops'] : []), ...(max !== undefined ? ['--max', String(max)] : [])], ...(q.max === undefined && max !== undefined ? { defaultMax: max } : {}) };
    }
    case 'check-delivery': {
      // A task id (text or {taskId}) is the result.json of that delivery under <lane.work>/deliver/<taskId>/ (A18): the
      // id every o11_deliver answer names, instead of an absolute path the session had to build.
      const asTask = isText ? (!path.isAbsolute(query) && TASK_ID.test(query.trim()) ? query.trim() : null) : q.taskId;
      if (!isText) {
        const refused = only('result', 'taskId'); if (refused) return refused;
        if ((q.result === undefined) === (q.taskId === undefined))
          return refusal('QUERY_SHAPE', 'check-delivery: give exactly one of result or taskId', again(lane, kind, { taskId: '<taskId>' }, 'the taskId of the delivery answer'));
      }
      if (asTask !== null && asTask !== undefined) {
        if (typeof asTask !== 'string' || !TASK_ID.test(asTask)) return refusal('BAD_VALUE', 'taskId: the id of a delivery task (letters, digits and dashes)', again(lane, kind, { taskId: '<taskId>' }, 'the taskId of the delivery answer'));
        if (!work) return refusal('LANE_WORK_UNKNOWN', 'the lane work folder is unknown here', again(lane, kind, '<absolute path of result.json>', 'pass the result file'));
        const result = path.join(work, 'deliver', asTask, 'result.json');
        if (!fs.existsSync(result)) return refusal('TASK_RESULT_NOT_FOUND', `no result.json for task ${asTask} under ${path.join(work, 'deliver')}`,
          { tool: 'ssam_task', arguments: { id: asTask }, why: 'the task state says whether it ended and where its receipts are' }, { result });
        return { argv: ['check-delivery', '--result', result], result, taskId: asTask };
      }
      const result = isText ? query : q.result;
      return file(result, 'result') ?? { argv: ['check-delivery', '--result', result] };
    }
    default: return refusal('UNKNOWN_KIND', 'Unknown kind ' + kind, again(lane, 'api', '<Interface>', 'kinds: ' + REFERENCE_KINDS.join(', ')));
  }
}

// ---- proven examples by id, from the suite files themselves (kernel/tests): the jobs of the lane (tests/jobs on O11,
// tests/jobs-odc on ODC), the proven examples of the lane (<that folder>/examples, with their coverage matrix
// matriz.json: id `matriz`) and the html sources of the op html (tests/html, both lanes). An id is the job name (the
// suite first, then the examples), or `jobs/<name>`, `jobs-odc/<name>`, `jobs-odc/examples/<name>`, `html/<path>` (with
// or without the extension). Nothing outside those folders is read; `find` lists the ids whose name or description hold
// every word.
const EXAMPLE_DIRS = { jobs: 'jobs', 'jobs-odc': 'jobs-odc', html: 'html' };
const EXAMPLE_ID = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
const fold = text => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const exampleWords = text => fold(text).split(/[^a-z0-9_]+/).filter(w => w.length > 1 && !['de', 'da', 'do', 'das', 'dos', 'com', 'para', 'the', 'of', 'and', 'with', 'for', 'um', 'uma'].includes(w));
function laneJobs(lane) { return lane === 'odc' ? 'jobs-odc' : 'jobs'; }
// The proven examples of each lane (tests/<jobs>/examples, one job per widget, pattern or capability and level) and their
// coverage matrix: the machine-readable matriz.json beside them and the document that explains it.
const MATRIX_DOCS = { odc: 'docs/COBERTURA-EXEMPLOS-ODC.md', o11: 'docs/COBERTURA-EXEMPLOS-O11.md' };
function listExamples(root, lane) {
  const tests = path.join(root, 'tests'); const out = [];
  const dir = laneJobs(lane);
  try { for (const f of fs.readdirSync(path.join(tests, dir)).filter(f => f.endsWith('.json')).sort()) out.push({ id: `${dir}/${f.slice(0, -5)}`, file: path.join(tests, dir, f), kind: 'job' }); } catch { /* no suite */ }
  try { for (const f of fs.readdirSync(path.join(tests, dir, 'examples')).filter(f => f.endsWith('.json')).sort()) out.push({ id: `${dir}/examples/${f.slice(0, -5)}`, file: path.join(tests, dir, 'examples', f), kind: f === 'matriz.json' ? 'matrix' : 'example' }); } catch { /* no examples */ }
  const walk = (folder, rel) => { let entries = []; try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; } for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) { if (e.isDirectory()) { if (e.name !== 'vendor') walk(path.join(folder, e.name), rel + e.name + '/'); } else if (/\.(html|css|js|json)$/i.test(e.name)) out.push({ id: `html/${rel}${e.name}`, file: path.join(folder, e.name), kind: 'html' }); } };
  walk(path.join(tests, 'html'), '');
  return out;
}
export function resolveExample(root, lane, id) {
  const raw = String(id ?? '').trim().replaceAll('\\', '/');
  if (!EXAMPLE_ID.test(raw) || raw.split('/').includes('..')) return null;
  const head = raw.split('/')[0];
  const all = listExamples(root, lane);
  const bare = raw.replace(/\.json$/i, '');
  const candidates = EXAMPLE_DIRS[head] ? [raw, raw + '.json', raw + '.html']
    : /^(matriz|matrix|coverage-matrix)$/i.test(bare) ? [`${laneJobs(lane)}/examples/matriz`]
    : [`${laneJobs(lane)}/${raw}`, `${laneJobs(lane)}/${bare}`, `${laneJobs(lane)}/examples/${bare}`, `html/${raw}`, `html/${raw}.html`];
  return all.find(e => candidates.includes(e.id) || candidates.includes(e.id.replace(/\.json$/i, ''))) ?? null;
}
function exampleAnswer(root, lane, query, sized) {
  const q = typeof query === 'string' ? { id: query } : query ?? {};
  const extra = Object.keys(q).filter(k => !['id', 'find'].includes(k));
  if (extra.length) return unknownFields(lane, 'example', q, ['id', 'find'], extra);
  if ((q.id === undefined) === (q.find === undefined)) return refusal('QUERY_SHAPE', 'example: give exactly one of id or find', again(lane, 'example', { find: '<text>' }, 'find lists the ids'));
  if (q.find !== undefined) {
    if (!plain(q.find)) return refusal('BAD_VALUE', 'find: plain text', again(lane, 'example', { find: '<text>' }, 'plain text'));
    const words = exampleWords(q.find);
    const matches = [];
    for (const e of listExamples(root, lane)) {
      let description = '';
      if (e.kind === 'job' || e.kind === 'example') { try { description = JSON.parse(fs.readFileSync(e.file, 'utf8').replace(/^﻿/, '')).description ?? ''; } catch { continue; } }
      if (e.kind === 'matrix') description = `coverage matrix of the ${lane} proven examples (${MATRIX_DOCS[lane]})`;
      const text = fold(e.id + ' ' + description);
      if (words.length && words.every(w => text.includes(w))) matches.push({ id: e.id, kind: e.kind, ...(description ? { description: description.slice(0, 300) } : {}) });
    }
    return { ok: true, lane, kind: 'example', find: q.find, count: matches.length, matches: matches.slice(0, FIND_CAP), ...(matches.length > FIND_CAP ? { more: matches.length - FIND_CAP } : {}),
      continuation: { tool: 'ssam_reference', arguments: { lane, kind: 'example', query: { id: matches[0]?.id ?? '<id>' } }, why: 'the whole example by id' } };
  }
  if (!plain(q.id)) return refusal('BAD_VALUE', 'id: plain text', again(lane, 'example', { find: '<text>' }, 'find lists the ids'));
  const found = resolveExample(root, lane, q.id);
  if (!found) return refusal('EXAMPLE_NOT_FOUND', `no example '${q.id}' in tests/${laneJobs(lane)}, tests/${laneJobs(lane)}/examples or tests/html`, again(lane, 'example', { find: String(q.id).split(/[\\/]/).at(-1).replace(/\.\w+$/, '') }, 'search the ids by text'));
  const text = fs.readFileSync(found.file, 'utf8').replace(/^﻿/, '');
  const relative = path.relative(root, found.file).replaceAll('\\', '/');
  if (found.kind === 'job' || found.kind === 'example' || found.kind === 'matrix') {
    let job; try { job = JSON.parse(text); } catch (e) { return refusal('EXAMPLE_UNREADABLE', firstLine(e.message), doctor(lane)); }
    if (found.kind === 'matrix')
      return { ok: true, lane, kind: 'example', id: found.id, path: relative, doc: MATRIX_DOCS[lane],
        proof: `the coverage matrix of the ${lane} proven examples: each entry (widget, pattern or capability, level) names its example job (${lane === 'odc' ? 'ExamplesOdcTests' : 'ExamplesO11Tests'} checks it)`, ...sized(lane, job) };
    const proof = found.kind === 'example'
      ? `a proven example of the ${lane} lane (${lane === 'odc' ? 'ExamplesOdcTests' : 'ExamplesO11Tests'} applies it headless on its base${job.expectError != null ? ' and expects the refusal it declares' : ''}); coverage matrix: ${laneJobs(lane)}/examples/matriz, ${MATRIX_DOCS[lane]}`
      : `a job of the ${lane} suite (${lane === 'odc' ? 'OdcJobTests' : 'JobTests'} applies it headless on its base)`;
    return { ok: true, lane, kind: 'example', id: found.id, path: relative, proof,
      description: job.description ?? null, base: job.base ?? null, ...sized(lane, job) };
  }
  // An html source: its siblings with the same stem (css, bindings, fields, fixture) are named, not inlined.
  const stem = found.id.replace(/\.(html|css|js|json)$/i, '').replace(/\.(bindings|fields|fixture|product|value|pdf|expected|product\.expected)$/i, '');
  const siblings = listExamples(root, lane).filter(e => e.kind === 'html' && e.id !== found.id && e.id.startsWith(stem + '.')).map(e => e.id);
  return { ok: true, lane, kind: 'example', id: found.id, path: relative, proof: 'a source of the op html suite (kernel/tests/html, compiled by the Html*Tests of both lanes)', ...(siblings.length ? { siblings } : {}), ...sized(lane, { content: text }) };
}
// ODC recipe: the suite jobs (tests/jobs-odc) whose name, description or ops hold every word, curated nothing; the same
// fields as the O11 answer of the CLI (name, path, description, opCount, ops?).
function odcRecipe(root, query) {
  const q = typeof query === 'string' ? { find: query } : query ?? {};
  const extra = Object.keys(q).filter(k => !['find', 'ops', 'max'].includes(k));
  if (extra.length) return unknownFields('odc', 'recipe', q, ['find', 'ops', 'max'], extra);
  if (!plain(q.find)) return refusal('QUERY_SHAPE', 'recipe needs find (plain text)', again('odc', 'recipe', '<text>', 'what to build'));
  if (q.max !== undefined && !(Number.isInteger(q.max) && q.max > 0 && q.max <= 1000)) return refusal('BAD_VALUE', 'max is an integer 1..1000: the ops are bounded across all matches', again('odc', 'recipe', { find: q.find, ...(q.ops === true ? { ops: true } : {}) }, 'max defaults to ' + RECIPE_OPS_MAX));
  const words = exampleWords(q.find);
  const dir = path.join(root, 'tests', 'jobs-odc'); let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { /* no suite */ }
  const definitions = []; let remaining = q.ops === true ? q.max ?? RECIPE_OPS_MAX : 0;
  for (const f of files) {
    const name = f.slice(0, -5); let text; let job;
    try { text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, ''); job = JSON.parse(text); } catch { continue; }
    const exact = name === q.find.trim();
    if (!exact && !(words.length && words.every(w => fold(name + ' ' + (job.description ?? '') + ' ' + text).includes(w)))) continue;
    const ops = Array.isArray(job.ops) ? job.ops : [];
    const take = Math.min(remaining, ops.length); remaining -= take;
    definitions.push({ name, path: 'tests/jobs-odc/' + f, description: job.description ?? '', opCount: ops.length, ...(q.ops === true ? { ops: ops.slice(0, take).map(({ _why, ...op }) => op), truncated: take < ops.length } : {}) });
    if (exact) return [definitions.at(-1)];
  }
  return definitions;
}

// ---- the owner's rules (kind rules): the files the team reads, served whole or by section, never the CLI. An app
// session never reads a file (AGENTS.md), and one had to ask the user for an exception to read the team rules
// (2026-10-06). doc "time" is docs/CONHECIMENTO-DO-TIME.md (its "## N." sections; a "### " lesson by the words of its
// heading); doc "padroes" the 35 rules of OutSystems padrões. Same text on both lanes.
const RULE_DOCS = { time: 'rules', padroes: 'padroes' };
const WHOLE = new Set(['all', 'tudo', 'todas', 'time', 'team', 'equipe']);
const subsections = section => guideSections(section.text, 3).map(s => ({ section: section.id, title: s.title, text: s.text }));
export function rulesAnswer(lane, query, { read = guideText } = {}) {
  const raw = typeof query === 'string' ? query.trim() : null;
  const q = raw !== null ? (fold(raw) === 'padroes' ? { doc: 'padroes' } : WHOLE.has(fold(raw)) ? {} : { section: raw }) : query ?? {};
  const extra = Object.keys(q).filter(k => !['doc', 'section'].includes(k));
  if (extra.length) return unknownFields(lane, 'rules', q, ['doc', 'section'], extra, 'query: "all", a section ("1"), the words of a heading, "padroes", or {doc, section}');
  const doc = q.doc ?? 'time';
  if (!Object.hasOwn(RULE_DOCS, doc)) return refusal('BAD_VALUE', 'doc is "time" (the team rules) or "padroes" (the 35 rules)', again(lane, 'rules', 'all', 'the whole team rules'));
  if (q.section !== undefined && !plain(q.section)) return refusal('BAD_VALUE', 'section: plain text', again(lane, 'rules', 'all', 'the whole document lists its sections'));
  const topic = RULE_DOCS[doc];
  const text = read(topic);
  const sections = guideSections(text);
  const index = sections.map(s => ({ id: s.id, title: s.title }));
  const source = GUIDE_FILES[topic];
  if (q.section === undefined) return { ok: true, lane, kind: 'rules', doc, source, sections: index, text };
  const wanted = String(q.section).trim();
  const words = exampleWords(wanted);
  const hit = s => s.id === wanted || (words.length > 0 && words.every(w => fold(s.title).includes(w)));
  const found = sections.filter(hit);
  if (found.length) return { ok: true, lane, kind: 'rules', doc, source, sections: index, section: found.map(s => ({ id: s.id, title: s.title })), text: found.map(s => s.text).join('\n') };
  const lessons = sections.flatMap(subsections).filter(hit);
  if (lessons.length) return { ok: true, lane, kind: 'rules', doc, source, sections: index, section: lessons.map(s => ({ id: s.section, title: s.title })), text: lessons.map(s => s.text).join('\n') };
  return refusal('RULES_SECTION_NOT_FOUND', `no section of ${source} is "${wanted}"`, again(lane, 'rules', doc === 'time' ? 'all' : 'padroes', 'the whole document, with every section'), { sections: index });
}

// A refusal of the CLI itself: the natural next lookup for that kind.
function nextLookup(lane, kind, query) {
  const name = typeof query === 'string' ? query : query?.name;
  if (name && ['functions', 'verify-message'].includes(kind)) return again(lane, kind, { find: name }, 'search by part of the name');
  if (name && kind === 'ui-block') return again(lane, kind, { ...(typeof query === 'object' && query.catalog ? { catalog: query.catalog } : {}), find: name }, 'search the catalog by text');
  if (name && kind === 'api' && lane === 'o11') return again(lane, kind, { op: 'native', type: name }, 'the type as loaded in the installed Studio');
  if (kind === 'api' && typeof query === 'object' && typeof query?.op === 'string' && query.op !== 'verbs')
    return again(lane, kind, { op: 'verbs' }, 'the job verbs (create, set, link...) and the reference grammar; the grammars are logic, spec, screen, html, html-visual, rest, rest-expose, soap');
  return doctor(lane, 'check the lane CLI and its Studio installation');
}

export function registerSsamReference(server, deps = {}) {
  const root = deps.root ?? anvilRoot;
  const laneName = deps.lane ?? o11Lane.lane;
  const env = deps.env ?? process.env;
  const runAnvil = deps.runAnvil ?? createAnvilRunner({ lane: laneName, root, env });
  const uuid = deps.uuid ?? randomUUID;
  const timeoutMs = deps.timeoutMs ?? 180000;
  const cache = new Map();
  // Hosted (executor.mjs), the lane folders are the customer's (<ws>/odc/.local, <ws>/o11); the CLIs stay the server's.
  const local = lane => (lane === 'odc' ? (usesWorkspace(root, anvilRoot) ? workspacePath('odc', '.local') : path.join(root, '.local', 'lane-odc'))
    : o11LaneOf(laneName, { root, env }).local);
  // deps.cli {o11?, odc?}: a CLI build outside the lane folder (the offline bench runs a build of its own).
  const cliOf = lane => deps.cli?.[lane] ?? (lane === 'odc' ? path.join(root, '.local', 'lane-odc', 'cli', 'anvil-odc.dll') : o11LaneOf(laneName, { root, env }).cli);

  // Answers up to INLINE_LIMIT travel inline; a larger one goes to a file with a short preview, under
  // <lane.local>/reference (one of the ssam_evidence roots) or, with deps.outDir, <outDir>/<lane> (a bench keeps it in
  // its sandbox, where its own ssam_evidence reads).
  const outDir = lane => (deps.outDir ? path.join(deps.outDir, lane) : path.join(local(lane), 'reference'));
  function sized(lane, data) {
    const text = JSON.stringify(data ?? null);
    if (text.length <= INLINE_LIMIT) return { data };
    const file = path.join(outDir(lane), createHash('sha256').update(text).digest('hex').slice(0, 16) + '.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return { file, bytes: text.length, preview: Array.isArray(data) ? { count: data.length, first: data.slice(0, 20) } : { keys: Object.keys(data ?? {}).slice(0, 40) } };
  }

  async function reference({ lane, kind, query }) {
    if (lane === 'odc' && !ODC_KINDS.includes(kind))
      return refusal('KIND_NOT_IN_LANE', `the ODC CLI (anvil-odc) has no ${kind}; it answers ${ODC_KINDS.join(', ')}`,
        again('o11', kind, query, 'the O11 lane answers it from the same kernel, for Service Studio 11; confirm it applies to ODC'));
    // Answered from the suite files, without the CLI (both lanes for example, ODC for recipe).
    if (FILE_KINDS.includes(kind)) return exampleAnswer(root, lane, query, sized);
    if (kind === 'rules') return rulesAnswer(lane, query, deps.guideText ? { read: deps.guideText } : {});
    if (kind === 'recipe' && lane === 'odc') {
      const found = odcRecipe(root, query);
      if (!Array.isArray(found)) return found;
      const q = typeof query === 'string' ? { find: query } : query;
      return { ok: true, lane, kind, source: 'tests/jobs-odc (suite jobs of the ODC lane; every word of find in the name, description or ops)',
        ...(q.ops === true && q.max === undefined ? { maxDefaulted: RECIPE_OPS_MAX } : {}), ...sized(lane, { find: q.find, count: found.length, definitions: found }) };
    }
    const key = UNCACHED.includes(kind) ? null : JSON.stringify([lane, kind, canonical(query)]);
    if (key && cache.has(key)) return { ...cache.get(key), cached: true };
    const built = referenceArguments(lane, kind, query, { root, work: lane === 'odc' ? null : o11LaneOf(laneName, { root, env }).work });
    if (built.ok === false) return built;
    const cli = cliOf(lane);
    if (!fs.existsSync(cli)) return refusal('CLI_NOT_BUILT', `The ${lane === 'odc' ? 'ODC (anvil-odc)' : 'O11 (anvil)'} CLI is not built`, doctor(lane));
    if (built.inlineJob) {
      built.job = path.join(local(lane), 'jobs', 'inline', uuid() + '.json');
      fs.mkdirSync(path.dirname(built.job), { recursive: true });
      fs.writeFileSync(built.job, JSON.stringify(built.inlineJob, null, 2));
      built.argv.push(built.job);
    }
    if (built.patched) {
      const patched = resolvePatchedJob(built.patched, { inlineDir: path.join(local(lane), 'jobs', 'inline'), work: lane === 'odc' ? null : o11LaneOf(laneName, { root, env }).work,
        journalDir: path.join(local(lane), 'journal'), tool: 'ssam_reference', uuid });
      if (!patched.ok) return refusal(patched.code, patched.error, again(lane, kind, { basedOn: built.patched.basedOn, patch: '<patch>' }, 'fix the patch or the partial job as the error says'),
        { ...(patched.at != null ? { at: patched.at } : {}), ...(patched.candidates ? { candidates: patched.candidates } : {}), ...(patched.job ? { job: patched.job } : {}) });
      built.job = patched.path; built.partial = patched.partial;
      built.argv.push(built.job);
    }
    // Every answer names the job it checked, ready for the next basedOn (and what a partial job merged); a refusal's
    // patches come by index and by name.
    const named = value => {
      const identity = jobIdentity(built.job);
      const answer = { ...value, ...(identity.jobSha256 ? { jobSha256: identity.jobSha256, nextBasedOn: identity.nextBasedOn } : {}), ...(built.partial ? { partial: built.partial } : {}) };
      return answer.ok === false ? withNamedPatches(answer, built.job) : answer;
    };
    // primeira-certa A3: a job that names its base (a fixture, job:<name>, a capture) is checked over it: the apply of the
    // CLI runs every phase (preflight, base, apply, Verify) on a disposable copy and refuses once with all of them. A job
    // without a base is read alone (check-job), and the answer says the Verify did not run.
    const hostedBase = kind === 'check-job' && hostedContext() !== null && declaredBase(built.job) !== null;
    if (kind === 'check-job' && !hostedBase && declaredBase(built.job)) {
      const out =path.join(local(lane), 'jobs', 'check', uuid() + '.oml');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const work = lane === 'odc' ? path.join(local(lane), 'jobs', 'work') : o11LaneOf(laneName, { root, env }).work;
      const applied = await runAnvil(['apply', '--job', built.job, '--out', out, '--work', work], { timeoutMs, cwd: root, ...(lane === 'odc' ? { cli } : {}) });
      const verdict = applied.envelope;
      if (!verdict) return refusal(applied.timedOut ? 'TIMEOUT' : 'CLI_FAILED', firstLine((applied.stderr ?? []).at(-1) ?? 'the CLI gave no answer'), doctor(lane, 'check the lane CLI'));
      const ran = verdict.data;
      if (verdict.ok === true && ran?.accepted === true && ran?.isValid === true)
        return named({ ok: true, lane, kind, job: built.job, valid: true, verifyRan: true, base: declaredBase(built.job), accepted: true, isValid: true, messages: ran.messages ?? null });
      return named(refusal('JOB_INVALID', 'the job does not pass: every problem of every phase over its base, at once', again(lane, kind, built.job, 'fix every problem (apply the patches) and check the stored job again'),
        { job: built.job, base: declaredBase(built.job), ...(verdict.code ? { refusalCode: verdict.code } : {}),
          errors: String(verdict.error ?? '').split(/\r?\n/).filter(Boolean).slice(0, 20).map(l => l.slice(0, 500)),
          ...refusalFields(verdict.problems ?? ran?.preflight?.problems, verdict.problems ? verdict : { verifyRan: true, phases: ['verify'] }),
          ...(!verdict.problems && Array.isArray(ran?.policyMessages) ? { policyMessages: ran.policyMessages.slice(0, 20) } : {}) }));
    }
    const run = await runAnvil(built.argv, { timeoutMs, cwd: root, ...(lane === 'odc' ? { cli } : {}) });
    const envelope = run.envelope;
    if (!envelope) return refusal(run.timedOut ? 'TIMEOUT' : 'CLI_FAILED', firstLine((run.stderr ?? []).at(-1) ?? 'the CLI gave no answer'), doctor(lane, 'check the lane CLI'));
    if (envelope.ok === false && envelope.data === undefined)
      return refusal('CLI_REFUSED', firstLine(envelope.error), nextLookup(lane, kind, query));
    let data = envelope.data;
    if (kind === 'check-job') {
      const alone = { verifyRan: false, verifyReason: hostedBase ? HOSTED_DECLARED_BASE_REASON
        : data?.verifyReason ?? 'only the job was read: it names no base, so the base check, the apply and the Verify did not run; give the job a base (a fixture, job:<name>) to check every phase' };
      if (data?.valid === true) return named({ ok: true, lane, kind, job: built.job, ...sized(lane, data), ...alone });
      return named(refusal('JOB_INVALID', 'the job does not pass the preflight', again(lane, kind, built.job, 'fix the errors and check the stored job again'),
        { job: built.job, errors: (data?.errors ?? []).slice(0, 20), ...refusalFields(data?.problems, alone) }));
    }
    if (kind === 'check-delivery') {
      const named = built.taskId ? { taskId: built.taskId, result: built.result } : {};
      if (data?.accepted === true) return { ok: true, lane, kind, ...named, ...sized(lane, data) };
      return refusal('DELIVERY_NOT_ACCEPTED', firstLine(data?.error) || 'the delivery receipt is not accepted', doctor(lane, 'check the lane before delivering again'), { ...named, data });
    }
    if (built.find !== undefined) {
      const wanted = built.find.toLowerCase();
      const matches = (data?.definitions ?? []).filter(d => JSON.stringify(d).toLowerCase().includes(wanted));
      data = { find: built.find, count: matches.length, matches: matches.slice(0, FIND_CAP), ...(matches.length > FIND_CAP ? { more: matches.length - FIND_CAP } : {}) };
    }
    const value = { ok: true, lane, kind, ...(built.defaultMax ? { maxDefaulted: built.defaultMax } : {}), ...sized(lane, data) };
    if (key) cache.set(key, value);
    return value;
  }

  server.registerTool('ssam_reference', {
    title: 'Kernel references: Model API, functions, UI blocks, types, recipes, proven examples, Verify messages, job and delivery checks, team rules',
    description: 'Read-only lookups answered by the lane\'s own CLI; prefer them to reading kernel source code or docs. query is text or an object per kind: api "IForEachNode" | {name, catalog?} | '
      + '{op} (a grammar such as logic, or a job verb such as create: its line) | {op:"native", type}; functions "Name" | {name}|{find}; ui-block "Block" | {catalog?, name}|{catalog?, find} (catalog: '
      + 'library name such as OutSystemsUI, default OutSystemsUI); types {assembly, filter, max?}; where-can "IInterface"; recipe "text" | '
      + '{find, ops?, max?} (ops without max: 20); verify-message "Id" | {name}|{find}; check-job: absolute path or the job object itself (stored under '
      + '<lane>/jobs/inline), or {basedOn, patch?, job?} (a patch by index or by name, or a partial job, over an earlier job: answers name nextBasedOn); '
      + 'a job that names its base is checked over it, every phase at once as a delivery refuses (problems[] with phase, '
      + 'pointer, fix, patch, patchByName; verifyRan), one without base is read alone (verifyRan:false); check-delivery: {taskId} of an o11_deliver answer, or the absolute path of its result.json; an unknown query field answers the closest valid form; example "<id>" | {id}|{find}: a whole proven '
      + 'example by id (a job of the lane suite, e.g. "timer-action", or an html source, e.g. "html/visual/block-event.html"); '
      + 'rules "all" | "<section number or heading words>" | "padroes" | {doc?: "time"|"padroes", section?}: the team rules to read '
      + 'before generating or changing modules (how to work, standards, platform lessons; padroes: the 35 OutSystems padrões rules), '
      + 'the same text on both lanes. Lane odc answers api (a name is described by op native), check-job, verify-message, recipe, '
      + 'example and rules. Static answers are cached for the session.',
    inputSchema: z.object({
      lane: z.enum(['o11', 'odc']),
      kind: z.enum(REFERENCE_KINDS),
      query: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).describe('Text or an object, per kind'),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try { return reply(await reference(input)); }
    catch (error) { return reply({ ok: false, ...seamFields(error), error: firstLine(error.message) }); }
  });
}
