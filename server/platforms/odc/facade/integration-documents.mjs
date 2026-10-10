// The documents and the destructive words of the integration job ops (`rest`, `rest-expose`, `soap`; lane restsoap of
// docs/INTEGRACOES-GITSSAM.md, interface I6). Called before anything is captured or sent: by o11_deliver (o11-cycle.mjs),
// by o11_job/ssam_job (job-runner.mjs, documents only: a headless job writes nothing to a Studio) and, through the hook of
// kernel-delivery.mjs, by studio_deliver.
//
// Documents: a WSDL (`soap.wsdl`) or an OpenAPI document (`rest.openapi.path`) given as a URL or an absolute path is read
// once (GET, 30 s, at most 5 MB; a `.wso` page tries its `?WSDL` companion; DTD/ENTITY refused) with the files it imports
// (xsd/wsdl imports and includes, OpenAPI external $ref; at most 32 files), pinned under <localRoot>/documents/<sha256>/
// with their relative names kept, and the op is rewritten to {path, sha256, source, imports|external}: a resume and the
// Studio's importer read the same bytes. A relative path (a suite job) stays: the kernel resolves it.
// Destructive words: `remove` of the three ops, a raw delete of an integration element (IRestClient, IRestAction,
// IRestStructure, IRestService, IRestServiceAction, ISOAPClient, ISOAPAction, ISOAPStructure), any `breaks`, and a change of
// the verb or path of an existing exposed method need the user's own words naming each target (whole words) and each
// consumer `breaks` lists; a target is written Type:Name (never $alias or @key); a standing grant never covers them.
// Every problem in one refusal, before anything happens; only the words' sha256 is ever journaled (by the callers).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { namesWhole } from './studio-create-app.mjs';

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENTS = 32;
export const FETCH_TIMEOUT_MS = 30000;
export const INTEGRATION_TYPES = Object.freeze(['IRestClient', 'IRestAction', 'IRestStructure', 'IRestService', 'IRestServiceAction', 'ISOAPClient', 'ISOAPAction', 'ISOAPStructure']);
const INTEGRATION_OPS = new Set(['rest', 'rest-expose', 'soap']);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const isUrl = text => /^https?:\/\//i.test(String(text ?? ''));
const problem = (code, message, fix, extra = {}) => ({ code, ...extra, message, fix: fix ?? null });

/** The ops of a job document (array or {ops}); a composite {jobs} is left to the kernel. */
const opsOf = document => (Array.isArray(document) ? document : Array.isArray(document?.ops) ? document.ops : []);

// ---- destructive words ------------------------------------------------------------------------------------------------

const nameOf = target => String(target).split(':').pop().split('/').pop().trim();
const named = (words, name) => typeof words === 'string' && name !== '' && namesWhole(words, name);
// The consumer a breaks entry names: the element at the root of its path ("IServerAction:Cep_Lookup/IExecute...:X").
const consumerOf = entry => String(entry).split('/')[0].split(':').pop().trim();
const routeOf = (http, urlPath) => String(http ?? 'GET').toUpperCase() + ' ' + String(urlPath ?? '').split('?')[0].replace(/\/+$/, '').replace(/\{[^{}]*\}/g, '{}').toLowerCase();

/**
 * Every destructive target of the job and every problem of its words. exposed(service) answers the current methods of an
 * exposed REST service [{name, http, path}] (null when unknown: the contract change is then not judged here).
 */
export async function destructiveProblems(ops, { words = '', grant = false, exposed = null } = {}) {
  const problems = [];
  const targets = [];
  const breaks = [];
  const aliasTypes = new Map();
  ops.forEach((op, i) => { if (op && typeof op === 'object' && typeof op.as === 'string' && typeof op.type === 'string') aliasTypes.set(op.as, op.type.split('.').pop()); });
  for (const [i, op] of ops.entries()) {
    if (!op || typeof op !== 'object') continue;
    const at = `/ops/${i}`;
    if (INTEGRATION_OPS.has(op.op) && op.data && typeof op.data === 'object') {
      for (const [j, entry] of (Array.isArray(op.data.remove) ? op.data.remove : []).entries()) {
        const text = String(entry ?? '').trim();
        if (/^[$@]/.test(text)) {
          problems.push(problem('INTEGRATION_DELETE_TARGET_FORM', `${op.op} remove '${text}' is an alias or a key: a delete names its target as Type:Name, so the user's words can name it`,
            `"remove": ["${op.op === 'soap' ? 'ISOAPAction' : op.op === 'rest-expose' ? 'IRestServiceAction' : 'IRestAction'}:<Name>"]`, { path: `${at}/data/remove/${j}` }));
          continue;
        }
        targets.push({ target: text.includes(':') ? text : `${op.op === 'soap' ? 'ISOAPAction' : op.op === 'rest-expose' ? 'IRestServiceAction' : 'IRestAction'}:${text}`, path: `${at}/data/remove/${j}` });
      }
      for (const [j, entry] of (Array.isArray(op.data.breaks) ? op.data.breaks : []).entries()) breaks.push({ entry: String(entry), path: `${at}/data/breaks/${j}` });
      if (op.op === 'rest-expose' && typeof exposed === 'function' && op.data.service?.name && Array.isArray(op.data.methods) && op.data.methods.length) {
        let current = null;
        try { current = await exposed(String(op.data.service.name)); } catch { current = null; }
        for (const [j, method] of op.data.methods.entries()) {
          const was = Array.isArray(current) ? current.find(m => String(m?.name ?? '').toLowerCase() === String(method?.name ?? '').toLowerCase()) : null;
          if (!was) continue;
          const now = routeOf(method.http, method.path ?? '/' + method.name);
          if (now !== routeOf(was.http, was.path) && !named(words, String(method.name)))
            problems.push(problem('REST_EXPOSE_CONTRACT_WORDS', `rest-expose: method '${method.name}' of ${op.data.service.name} answers ${was.http ?? 'GET'} ${was.path} today and the job changes it to ${String(method.http ?? 'GET').toUpperCase()} ${method.path ?? '/' + method.name}: its external callers break, and they are invisible to the module`,
              `the user's words name the method ${method.name} (and know its callers change), or keep its verb and path`, { target: 'IRestServiceAction:' + method.name, path: `${at}/data/methods/${j}` }));
        }
      }
    }
    if (op.op === 'delete' && typeof op.target === 'string') {
      const text = op.target.trim();
      const typed = /^(I[A-Za-z]+):([^/]+)(\/.*)?$/.exec(text);
      if (typed && INTEGRATION_TYPES.includes(typed[1])) {
        if (typed[3]) problems.push(problem('INTEGRATION_DELETE_TARGET_FORM', `delete '${text}' reaches an integration element through a path: name it as Type:Name so the user's words can name it`,
          `"target": "<Type>:${nameOf(text)}" (e.g. ${typed[1] === 'ISOAPClient' ? 'ISOAPAction' : typed[1] === 'IRestService' ? 'IRestServiceAction' : 'IRestAction'}:${nameOf(text)})`, { path: `${at}/target` }));
        else targets.push({ target: text, path: `${at}/target` });
      } else if (/^\$/.test(text) && INTEGRATION_TYPES.includes(aliasTypes.get(text))) {
        problems.push(problem('INTEGRATION_DELETE_TARGET_FORM', `delete '${text}' is an alias of ${aliasTypes.get(text)}: a delete of an integration element names it as Type:Name`, `"target": "${aliasTypes.get(text)}:<Name>"`, { path: `${at}/target` }));
      }
      for (const [j, entry] of (Array.isArray(op.breaks) ? op.breaks : []).entries()) breaks.push({ entry: String(entry), path: `${at}/breaks/${j}` });
    }
  }
  if ((targets.length || breaks.length) && grant)
    problems.push(problem('INTEGRATION_DELETE_WORDS', 'a standing grant never covers a delete: this job removes ' + targets.map(t => t.target).concat(breaks.map(b => 'consumers ' + b.entry)).join(', '),
      'ask the user and pass their own words in authorize, naming each target and each consumer'));
  else {
    for (const t of targets)
      if (!named(words, nameOf(t.target)))
        problems.push(problem('INTEGRATION_DELETE_WORDS', `the user's words do not name ${t.target}, which this job deletes`, `words that name ${nameOf(t.target)} (whole word), e.g. "apagar ${t.target}"`, { target: t.target, path: t.path }));
    for (const b of breaks)
      if (!named(words, consumerOf(b.entry)))
        problems.push(problem('DELETE_BREAKS_WORDS', `the user's words do not name ${consumerOf(b.entry)}, whose use (${b.entry}) this job accepts to break`, `words that also name ${consumerOf(b.entry)}, or delete/rewrite that consumer in the job`, { target: b.entry, path: b.path }));
  }
  return { problems, targets: targets.map(t => t.target), breaks: breaks.map(b => b.entry) };
}

// ---- documents --------------------------------------------------------------------------------------------------------

/** The documents a WSDL imports: wsdl:import location, xsd:import/include/redefine schemaLocation. */
export function wsdlImports(text) {
  const found = [];
  for (const m of String(text).matchAll(/<(?:[A-Za-z_][\w.-]*:)?(import|include|redefine)\b[^>]*?\b(location|schemaLocation)\s*=\s*["']([^"']+)["']/g)) found.push(m[3]);
  return [...new Set(found)];
}

/** The external $ref files of an OpenAPI document (the part before '#', never a local '#/...' reference). */
export function openApiReferences(node, out = new Set()) {
  if (Array.isArray(node)) for (const item of node) openApiReferences(item, out);
  else if (node && typeof node === 'object')
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) out.add(value.split('#')[0]);
      else openApiReferences(value, out);
    }
  return [...out];
}

const looksLikeWsdl = bytes => /<(?:[A-Za-z_][\w.-]*:)?definitions[\s>]/.test(bytes.subarray(0, 4096).toString('utf8').replace(/^﻿/, ''));
const unsafeXml = bytes => /<!DOCTYPE|<!ENTITY/i.test(bytes.toString('utf8'));

/** Reads one document (URL or local path) with the limits; a refusal is {problem}. */
async function readDocument(source, { fetchImpl, base, wsdl }) {
  let resolved = source;
  if (base && !isUrl(source) && !path.isAbsolute(source) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source))
    resolved = isUrl(base) ? new URL(source, base).toString() : path.resolve(path.dirname(base), source);
  if (/^file:\/\//i.test(resolved)) resolved = decodeURIComponent(new URL(resolved).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  if (isUrl(resolved)) {
    if (typeof fetchImpl !== 'function') return { problem: problem('UNSUPPORTED_DOCUMENT_SCHEME', `no HTTP client to read ${resolved}`, 'pass the downloaded file\'s absolute path') };
    const get = async url => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'SSAM-Hybrid integration documents' } });
        if (!response.ok) return { problem: problem('DOCUMENT_NOT_FOUND', `GET ${url} answered ${response.status}`, 'check the URL (the service\'s own ?WSDL or OpenAPI address)') };
        const declared = Number(response.headers?.get?.('content-length') ?? 0);
        if (declared > MAX_DOCUMENT_BYTES) return { problem: problem('DOCUMENT_TOO_LARGE', `${url} declares ${declared} bytes, more than ${MAX_DOCUMENT_BYTES}`, 'use a document of at most 5 MB') };
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_DOCUMENT_BYTES) return { problem: problem('DOCUMENT_TOO_LARGE', `${url} has ${bytes.length} bytes, more than ${MAX_DOCUMENT_BYTES}`, 'use a document of at most 5 MB') };
        return { bytes, url };
      } catch (error) {
        return { problem: problem('DOCUMENT_NOT_FOUND', `GET ${url} failed: ${error?.name === 'AbortError' ? 'no answer in 30 s' : String(error?.message ?? error).split('\n')[0]}`, 'check the URL, or pass the downloaded file\'s absolute path') };
      } finally { clearTimeout(timer); }
    };
    let read = await get(resolved);
    // A DataFlex-style .wso service page shows HTML; its contract is the ?WSDL companion.
    if (wsdl && read.bytes && !looksLikeWsdl(read.bytes) && /\.wso$/i.test(new URL(resolved).pathname) && !new URL(resolved).search) read = await get(resolved + '?WSDL');
    if (read.problem) return read;
    return { bytes: read.bytes, source: read.url, location: read.url };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(resolved) && !/^[A-Za-z]:[\\/]/.test(resolved))
    return { problem: problem('UNSUPPORTED_DOCUMENT_SCHEME', `'${source}' uses a scheme that is not http, https, file or a local path`, 'give an http(s) URL or the absolute path of the file') };
  if (!path.isAbsolute(resolved)) return { relative: true };
  let stat;
  try { stat = fs.statSync(resolved); } catch { return { problem: problem('DOCUMENT_NOT_FOUND', `${resolved} does not exist`, 'give the absolute path of the file, or its URL') }; }
  if (stat.size > MAX_DOCUMENT_BYTES) return { problem: problem('DOCUMENT_TOO_LARGE', `${resolved} has ${stat.size} bytes, more than ${MAX_DOCUMENT_BYTES}`, 'use a document of at most 5 MB') };
  return { bytes: fs.readFileSync(resolved), source: resolved, location: resolved };
}

/**
 * Pins one document and the files it imports (recursively, at most 32 in all) under <localRoot>/documents/<sha256>/.
 * Answers {document: {path, sha256, source, imports|external}, files: [{source, path, sha256, bytes}]} or {problems}.
 */
async function pin(source, { kind, localRoot, fetchImpl, at, jobDir }) {
  const wsdl = kind === 'wsdl';
  // A path relative to the job's own folder is a local file too; one that is not there is left to the kernel (suite jobs).
  const local = !isUrl(source) && !path.isAbsolute(source) && jobDir && fs.existsSync(path.resolve(jobDir, source)) ? path.resolve(jobDir, source) : source;
  const main = await readDocument(local, { fetchImpl, wsdl });
  if (main.relative) return { unchanged: true };
  if (main.problem) return { problems: [{ ...main.problem, path: at }] };
  if (wsdl && unsafeXml(main.bytes)) return { problems: [problem('UNSAFE_WSDL_XML', `the WSDL of ${main.source} declares a DTD or ENTITY`, 'use the service\'s own WSDL without <!DOCTYPE>/<!ENTITY>', { path: at })] };
  const digest = sha256(main.bytes);
  const folder = path.join(localRoot, 'documents', digest);
  const mainName = (isUrl(main.location) ? path.basename(new URL(main.location).pathname) : path.basename(main.location)) || (wsdl ? 'service.wsdl' : 'openapi.json');
  const files = [{ source: main.source, name: mainName.replace(/[^A-Za-z0-9._-]/g, '_') || 'document', bytes: main.bytes }];
  const dependencies = {};
  const queue = [{ bytes: main.bytes, location: main.location }];
  const seen = new Set([main.location]);
  const problems = [];
  while (queue.length) {
    const current = queue.shift();
    let references = [];
    if (wsdl) references = wsdlImports(current.bytes.toString('utf8'));
    else { try { references = openApiReferences(JSON.parse(current.bytes.toString('utf8').replace(/^﻿/, ''))); } catch { references = []; } }
    for (const reference of references) {
      const absolute = isUrl(reference) || path.isAbsolute(reference) ? reference : isUrl(current.location) ? new URL(reference, current.location).toString() : path.resolve(path.dirname(current.location), reference);
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      if (files.length >= MAX_DOCUMENTS) { problems.push(problem('DOCUMENT_TOO_LARGE', `${main.source} imports more than ${MAX_DOCUMENTS} documents`, 'import a smaller contract (one service, its own types)', { path: at })); break; }
      const read = await readDocument(absolute, { fetchImpl, wsdl: false });
      if (read.problem) { problems.push({ ...read.problem, path: at, target: reference }); continue; }
      if (read.relative) continue;
      if (wsdl && unsafeXml(read.bytes)) { problems.push(problem('UNSAFE_WSDL_XML', `the imported ${absolute} declares a DTD or ENTITY`, 'use documents without <!DOCTYPE>/<!ENTITY>', { path: at })); continue; }
      // The relative name is kept so the importer resolves it next to the main document; an absolute one gets its own.
      const relative = !isUrl(reference) && !path.isAbsolute(reference) && !reference.startsWith('..') ? reference.replace(/\\/g, '/') : 'external/' + sha256(Buffer.from(absolute)).slice(0, 16) + '-' + (path.basename(String(absolute).split('?')[0]) || 'document');
      files.push({ source: read.source, name: relative, bytes: read.bytes });
      dependencies[reference] = { name: relative, sha256: sha256(read.bytes) };
      queue.push({ bytes: read.bytes, location: read.location });
    }
  }
  if (problems.length) return { problems };
  for (const file of files) {
    const target = path.join(folder, ...file.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== sha256(file.bytes)) fs.writeFileSync(target, file.bytes);
    file.path = target;
  }
  const document = { path: files[0].path, sha256: digest, source: main.source };
  const deps = Object.fromEntries(Object.entries(dependencies).map(([uri, d]) => [uri, { path: path.join(folder, ...d.name.split('/')), sha256: d.sha256 }]));
  if (Object.keys(deps).length) document[wsdl ? 'imports' : 'external'] = deps;
  return { document, files: files.map(f => ({ source: f.source, path: f.path, sha256: sha256(f.bytes), bytes: f.bytes.length })) };
}

// ---- the preparation --------------------------------------------------------------------------------------------------

/**
 * I6. jobFile: the job the call runs. lane 'o11'|'odc'; words: the user's words (or the grant's, with grant:true);
 * localRoot: the lane's .local; destructive:false skips the words rule (a headless job writes nothing to a Studio);
 * exposed(service): the current methods of an exposed service (o11_deliver reads them from a capture).
 * -> {ok:true, job, changed, documents:[{source, path, sha256, bytes}]} | {ok:false, code, error, problems, continuation?}
 */
export async function prepareIntegrationJob(jobFile, { lane = 'o11', words = '', localRoot, fetchImpl = globalThis.fetch, destructive = true, grant = false, exposed = null } = {}) {
  let document;
  try { document = readJson(jobFile); } catch { return { ok: true, job: jobFile, changed: false, documents: [] }; }
  const ops = opsOf(document);
  const relevant = ops.some(op => op && typeof op === 'object' && (INTEGRATION_OPS.has(op.op) || (op.op === 'delete' && (op.breaks != null || /^I(?:Rest|SOAP)/.test(String(op.target ?? '')) || /^\$/.test(String(op.target ?? ''))))));
  if (!relevant) return { ok: true, job: jobFile, changed: false, documents: [] };
  const problems = [];
  if (destructive) problems.push(...(await destructiveProblems(ops, { words, grant, exposed })).problems);
  const copy = structuredClone(document);
  const copyOps = opsOf(copy);
  const documents = [];
  let changed = false;
  const root = localRoot ?? path.join(path.dirname(jobFile), '.local');
  for (const [i, op] of copyOps.entries()) {
    if (!op || typeof op !== 'object' || !op.data || typeof op.data !== 'object') continue;
    if (op.op === 'soap' && lane === 'odc') {
      problems.push(problem('SOAP_LANE_UNSUPPORTED', 'soap: SOAP is not available on ODC (the platform consumes REST only)', 'consume the service through a REST facade (op rest), or an External Library that calls it', { path: `/ops/${i}` }));
      continue;
    }
    const slot = op.op === 'soap' ? { owner: op.data, key: 'wsdl', kind: 'wsdl' } : op.op === 'rest' && op.data.openapi && typeof op.data.openapi === 'object' ? { owner: op.data.openapi, key: 'path', kind: 'openapi' } : null;
    if (!slot) continue;
    const value = slot.owner[slot.key];
    const source = typeof value === 'string' ? value : value && typeof value === 'object' && typeof value.path === 'string' && !value.sha256 ? value.path : null;
    if (!source) continue; // already pinned ({path, sha256}) or absent: the kernel judges it
    const at = `/ops/${i}/data/${slot.kind === 'wsdl' ? 'wsdl' : 'openapi/path'}`;
    const pinned = await pin(source, { kind: slot.kind, localRoot: root, fetchImpl, at, jobDir: path.dirname(path.resolve(jobFile)) });
    if (pinned.unchanged) continue;
    if (pinned.problems) { problems.push(...pinned.problems); continue; }
    documents.push(...pinned.files);
    if (slot.kind === 'wsdl') op.data.wsdl = pinned.document;
    else Object.assign(op.data.openapi, { path: pinned.document.path, sha256: pinned.document.sha256, source: pinned.document.source, ...(pinned.document.external ? { external: { ...(op.data.openapi.external ?? {}), ...pinned.document.external } } : {}) });
    changed = true;
  }
  if (problems.length) {
    const codes = [...new Set(problems.map(p => p.code))];
    return { ok: false, code: codes.length === 1 ? codes[0] : codes.includes('INTEGRATION_DELETE_WORDS') ? 'INTEGRATION_DELETE_WORDS' : codes[0],
      error: problems.map(p => p.message).join(' | ').slice(0, 900) + '. Nothing was captured or sent.', problems };
  }
  if (!changed) return { ok: true, job: jobFile, changed: false, documents };
  // The copy lives in the lane's folder: a base relative to the original job's folder becomes absolute.
  const jobDir = path.dirname(path.resolve(jobFile));
  if (typeof copy?.base === 'string' && !copy.base.startsWith('job:') && !path.isAbsolute(copy.base) && fs.existsSync(path.join(jobDir, copy.base))) copy.base = path.join(jobDir, copy.base);
  const text = JSON.stringify(copy, null, 2);
  const target = path.join(root, 'jobs', 'integration', sha256(text) + '.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return { ok: true, job: target, changed: true, documents };
}
