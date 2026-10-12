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
// Hosted (servidor/fase4-24, findings 1 and 3 of the confinement review): inside a hosted call (or with `workspace`) the
// documents are read for a customer, so every LOCAL file this module is about to read, the main document and each file a
// document imports or $refs (absolute, file: URL or relative to the document), must be inside the visible area of the
// customer's workspace by its lexical AND its real path, and the bytes are read from the real path; a document fetched by
// URL names only URLs (its relative names resolve against its URL; a file: or drive-letter reference is refused); a relative
// main document the job's folder does not have is refused (the kernel would look in the repository). Anything else is
// PATH_OUTSIDE_WORKSPACE naming the job pointer and the reference, before anything is read there. Every URL (the document,
// each redirect hop, each import) must reach a public address (hosted/public-fetch.mjs: DOCUMENT_HOST_NOT_PUBLIC), and the
// default fetch checks it again at connect time. A served process that lost its hosted context reads nothing.
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { namesWhole } from './studio-create-app.mjs';
import { pinReferences } from './job-patch.mjs';
import { hostedContext, servedWithoutContext } from './executor.mjs';
import { insideVisible } from './hosted/mirror.mjs';
import { MAX_REDIRECTS, createPublicFetch, publicUrlProblem } from './hosted/public-fetch.mjs';

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
const REDIRECT = new Set([301, 302, 303, 307, 308]);
// A drive letter (C:\, C:/ or C: alone); a scheme (http:, file:, ftp:, ...), which a drive letter never is.
const isDrive = text => /^[A-Za-z]:([\\/]|$)/.test(String(text));
const hasScheme = text => /^[A-Za-z][A-Za-z0-9+.-]+:/.test(String(text)) && !isDrive(text);
const fileUrlPath = text => { try { return fileURLToPath(text); } catch { return null; } };
const within = (folder, target) => { const rel = path.relative(folder, target); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

// Hosted: a local file a document names outside the customer's workspace (or any local file a URL document names).
const outsideProblem = (reference, from) => problem('PATH_OUTSIDE_WORKSPACE',
  from && isUrl(from)
    ? `the document read from ${from} names '${reference}', a file of this server: a document read by URL names only URLs, so nothing was read there`
    : `'${reference}'${from ? ` (named by ${path.basename(from)})` : ''} is outside the workspace of this account, so nothing was read there`,
  from && isUrl(from)
    ? 'serve that file next to the document at its URL, or bring the document and its files to the workspace (agent:inbox/<file>) and name each relative to the document'
    : 'put the document and every file it imports in the workspace (ws:<rel>, or agent:inbox/<file>) and name each relative to the document that imports it',
  { reference });
const hostProblem = refused => problem(refused.code, refused.message,
  refused.code === 'DOCUMENT_HOST_NOT_PUBLIC' ? 'give the document\'s public URL, or put the file in the agent inbox (agent:inbox/<file>) and name it'
    : refused.code === 'UNSUPPORTED_DOCUMENT_SCHEME' ? 'give an http(s) URL or the file in the workspace' : 'check the URL, or put the file in the agent inbox (agent:inbox/<file>)');

/**
 * Reads one document (URL or local path) with the limits; a refusal is {problem}. confine (hosted): {workspace,
 * workspaceReal, lookup}; from: the location of the document that names this one (null for the main document).
 */
async function readDocument(source, { fetchImpl, base, wsdl, confine = null, from = null }) {
  let resolved = source;
  if (base && !isUrl(source) && !path.isAbsolute(source) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source))
    resolved = isUrl(base) ? new URL(source, base).toString() : path.resolve(path.dirname(base), source);
  if (/^file:/i.test(resolved)) {
    if (confine) { resolved = fileUrlPath(resolved); if (!resolved) return { problem: outsideProblem(source, from) }; }
    else if (/^file:\/\//i.test(resolved)) resolved = decodeURIComponent(new URL(resolved).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  }
  if (isUrl(resolved)) {
    if (typeof fetchImpl !== 'function') return { problem: problem('UNSUPPORTED_DOCUMENT_SCHEME', `no HTTP client to read ${resolved}`, 'pass the downloaded file\'s absolute path') };
    // Hosted: every hop is checked (scheme and a public address) before it is requested, and a redirect is followed here,
    // never by the client, so each new address is checked too.
    const get = async first => {
      let url = first;
      for (let hop = 0; ; hop++) {
        if (confine) {
          const refused = await publicUrlProblem(url, { lookup: confine.lookup });
          if (refused) return { problem: hostProblem(refused) };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
          const response = await fetchImpl(url, { method: 'GET', redirect: confine ? 'manual' : 'follow', signal: controller.signal, headers: { 'user-agent': 'SSAM-Hybrid integration documents' } });
          if (confine && REDIRECT.has(response.status)) {
            const location = response.headers?.get?.('location');
            try { await response.body?.cancel?.(); } catch { /* the answer is not read */ }
            if (!location) return { problem: problem('DOCUMENT_NOT_FOUND', `GET ${url} answered ${response.status} without a Location`, 'check the URL (the service\'s own ?WSDL or OpenAPI address)') };
            if (hop >= MAX_REDIRECTS) return { problem: problem('DOCUMENT_NOT_FOUND', `GET ${first} was redirected more than ${MAX_REDIRECTS} times`, 'give the document\'s final URL') };
            try { url = new URL(location, url).toString(); } catch { return { problem: problem('DOCUMENT_NOT_FOUND', `GET ${url} redirected to '${location}', which is not a URL`, 'give the document\'s final URL') }; }
            continue;
          }
          if (!response.ok) return { problem: problem('DOCUMENT_NOT_FOUND', `GET ${url} answered ${response.status}`, 'check the URL (the service\'s own ?WSDL or OpenAPI address)') };
          const declared = Number(response.headers?.get?.('content-length') ?? 0);
          if (declared > MAX_DOCUMENT_BYTES) return { problem: problem('DOCUMENT_TOO_LARGE', `${url} declares ${declared} bytes, more than ${MAX_DOCUMENT_BYTES}`, 'use a document of at most 5 MB') };
          const bytes = Buffer.from(await response.arrayBuffer());
          if (bytes.length > MAX_DOCUMENT_BYTES) return { problem: problem('DOCUMENT_TOO_LARGE', `${url} has ${bytes.length} bytes, more than ${MAX_DOCUMENT_BYTES}`, 'use a document of at most 5 MB') };
          return { bytes, url };
        } catch (error) {
          if (error?.code === 'DOCUMENT_HOST_NOT_PUBLIC' || error?.code === 'UNSUPPORTED_DOCUMENT_SCHEME') return { problem: hostProblem({ code: error.code, message: `GET ${url} refused: ${error.message}` }) };
          return { problem: problem('DOCUMENT_NOT_FOUND', `GET ${url} failed: ${error?.name === 'AbortError' ? 'no answer in 30 s' : String(error?.message ?? error).split('\n')[0]}`, 'check the URL, or pass the downloaded file\'s absolute path') };
        } finally { clearTimeout(timer); }
      }
    };
    let read = await get(resolved);
    // A DataFlex-style .wso service page shows HTML; its contract is the ?WSDL companion.
    if (wsdl && read.bytes && !looksLikeWsdl(read.bytes) && /\.wso$/i.test(new URL(resolved).pathname) && !new URL(resolved).search) read = await get(resolved + '?WSDL');
    if (read.problem) return read;
    return { bytes: read.bytes, source: read.url, location: read.url };
  }
  if (hasScheme(resolved))
    return { problem: problem('UNSUPPORTED_DOCUMENT_SCHEME', `'${source}' uses a scheme that is not http, https, file or a local path`, 'give an http(s) URL or the absolute path of the file') };
  // Hosted: a relative name the job's folder does not have would be looked up by the kernel in the repository.
  if (!path.isAbsolute(resolved)) return confine ? { problem: outsideProblem(source, from) } : { relative: true };
  let readFrom = resolved;
  if (confine) {
    // A document read by URL never names a local file; any other is inside the visible area of the workspace by its lexical
    // path (checked before the disk is touched: a UNC path is never opened) and by its real path, which is what is read.
    if ((from && isUrl(from)) || !insideVisible(confine.workspace, resolved)) return { problem: outsideProblem(source, from) };
    let real;
    try { real = fs.realpathSync.native(resolved); } catch { return { problem: problem('DOCUMENT_NOT_FOUND', `${source} does not exist`, 'put the file in the workspace (ws:<rel>, or agent:inbox/<file>)') }; }
    if (!insideVisible(confine.workspaceReal, real)) return { problem: outsideProblem(source, from) };
    readFrom = real;
  }
  let stat;
  try { stat = fs.statSync(readFrom); } catch { return { problem: problem('DOCUMENT_NOT_FOUND', `${resolved} does not exist`, 'give the absolute path of the file, or its URL') }; }
  if (stat.size > MAX_DOCUMENT_BYTES) return { problem: problem('DOCUMENT_TOO_LARGE', `${resolved} has ${stat.size} bytes, more than ${MAX_DOCUMENT_BYTES}`, 'use a document of at most 5 MB') };
  return { bytes: fs.readFileSync(readFrom), source: resolved, location: resolved };
}

// Where a reference of a document points: a URL, a local path, or {outside} (hosted: a URL document naming a local file).
// A document read by URL resolves its relative names (and, hosted, every name) against its URL; a file: URL is a path.
function referenceTarget(reference, location, confine) {
  if (isUrl(location)) {
    if (!confine) return isUrl(reference) || path.isAbsolute(reference) ? reference : new URL(reference, location).toString();
    if (/^file:/i.test(reference) || isDrive(reference)) return { outside: true };
    try { return new URL(reference, location).toString(); } catch { return reference; }
  }
  if (/^file:/i.test(reference)) return fileUrlPath(reference) ?? reference;
  return isUrl(reference) || hasScheme(reference) || path.isAbsolute(reference) ? reference : path.resolve(path.dirname(location), reference);
}

// The name a pinned import keeps next to the main document: its relative name, normalized, only when it stays in the
// document's folder; anything else (a URL, an absolute path, a name that climbs out, even through a/../../x) gets its own
// under external/. Never a path that leaves <localRoot>/documents/<sha256>/.
function pinnedName(reference, absolute) {
  const text = String(reference).replace(/\\/g, '/');
  if (!isUrl(text) && !hasScheme(text) && !isDrive(text) && !text.startsWith('/')) {
    const name = path.posix.normalize(text);
    if (name !== '.' && name !== '..' && !name.startsWith('../') && !name.startsWith('/')) return name;
  }
  return 'external/' + sha256(Buffer.from(String(absolute))).slice(0, 16) + '-' + ((path.basename(String(absolute).split('?')[0]) || 'document').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, 'document'));
}

/**
 * Pins one document and the files it imports (recursively, at most 32 in all) under <localRoot>/documents/<sha256>/.
 * Answers {document: {path, sha256, source, imports|external}, files: [{source, path, sha256, bytes}]} or {problems}.
 */
async function pin(source, { kind, localRoot, fetchImpl, at, jobDir, confine = null }) {
  const wsdl = kind === 'wsdl';
  // A path relative to the job's own folder is a local file too; one that is not there is left to the kernel (suite jobs;
  // hosted: refused). Hosted, the candidate is looked at only inside the workspace.
  const candidate = !isUrl(source) && !hasScheme(source) && !path.isAbsolute(source) && jobDir ? path.resolve(jobDir, source) : null;
  const local = candidate && (!confine || insideVisible(confine.workspace, candidate)) && fs.existsSync(candidate) ? candidate : source;
  const main = await readDocument(local, { fetchImpl, wsdl, confine });
  if (main.relative) return { unchanged: true };
  if (main.problem) return { problems: [{ ...main.problem, path: at }] };
  if (wsdl && unsafeXml(main.bytes)) return { problems: [problem('UNSAFE_WSDL_XML', `the WSDL of ${main.source} declares a DTD or ENTITY`, 'use the service\'s own WSDL without <!DOCTYPE>/<!ENTITY>', { path: at })] };
  const digest = sha256(main.bytes);
  const folder = path.join(localRoot, 'documents', digest);
  const mainName = (isUrl(main.location) ? path.basename(new URL(main.location).pathname) : path.basename(main.location)) || (wsdl ? 'service.wsdl' : 'openapi.json');
  const files = [{ source: main.source, name: mainName.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '') || 'document', bytes: main.bytes }];
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
      const absolute = referenceTarget(reference, current.location, confine);
      if (absolute?.outside) { problems.push({ ...outsideProblem(reference, current.location), path: at, target: reference }); continue; }
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      if (files.length >= MAX_DOCUMENTS) { problems.push(problem('DOCUMENT_TOO_LARGE', `${main.source} imports more than ${MAX_DOCUMENTS} documents`, 'import a smaller contract (one service, its own types)', { path: at })); break; }
      const read = await readDocument(absolute, { fetchImpl, wsdl: false, confine, from: current.location });
      if (read.problem) { problems.push({ ...read.problem, path: at, target: reference }); continue; }
      if (read.relative) continue;
      if (wsdl && unsafeXml(read.bytes)) { problems.push(problem('UNSAFE_WSDL_XML', `the imported ${absolute} declares a DTD or ENTITY`, 'use documents without <!DOCTYPE>/<!ENTITY>', { path: at })); continue; }
      // The relative name is kept so the importer resolves it next to the main document; any other gets its own.
      const relative = pinnedName(reference, absolute);
      files.push({ source: read.source, name: relative, bytes: read.bytes });
      dependencies[reference] = { name: relative, sha256: sha256(read.bytes) };
      queue.push({ bytes: read.bytes, location: read.location });
    }
  }
  if (problems.length) return { problems };
  for (const file of files) {
    const target = path.join(folder, ...file.name.split('/'));
    if (!within(folder, target)) return { problems: [problem('DOCUMENT_NAME_INVALID', `the import '${file.name}' would be pinned outside ${folder}`, 'name imports relative to the document, inside its folder', { path: at })] };
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

// The document paths of one op the kernel resolves against the job's folder (JobRunner.ResolveDocuments): a soap wsdl
// (string or {path}) and its imports, a rest openapi.path and its external files. [{owner, key}] of string values.
function documentPaths(op) {
  const out = [];
  const data = op && typeof op === 'object' ? op.data : null;
  if (!data || typeof data !== 'object') return out;
  const take = (owner, key) => { if (owner && typeof owner === 'object' && typeof owner[key] === 'string' && owner[key]) out.push({ owner, key }); };
  const document = (owner, key, dependencies) => {
    const value = owner?.[key];
    if (typeof value === 'string') { take(owner, key); return; }
    if (!value || typeof value !== 'object') return;
    take(value, 'path');
    if (value[dependencies] && typeof value[dependencies] === 'object') for (const entry of Object.values(value[dependencies])) take(entry, 'path');
  };
  if (op.op === 'soap') document(data, 'wsdl', 'imports');
  if (op.op === 'rest') document(data, 'openapi', 'external');
  return out;
}

/**
 * I6. jobFile: the job the call runs. lane 'o11'|'odc'; words: the user's words (or the grant's, with grant:true);
 * localRoot: the lane's .local; destructive:false skips the words rule (a headless job writes nothing to a Studio);
 * exposed(service): the current methods of an exposed service (o11_deliver reads them from a capture).
 * workspace: the customer's workspace when the documents are read for a hosted customer (default: the one of the hosted
 * call this runs in, else none: local use); null forces local use. lookup: dns.lookup's signature (tests). fetchImpl:
 * the HTTP client (default: hosted, the public-only client of hosted/public-fetch.mjs; local, the global fetch).
 * -> {ok:true, job, changed, documents:[{source, path, sha256, bytes}]} | {ok:false, code, error, problems, continuation?}
 */
export async function prepareIntegrationJob(jobFile, { lane = 'o11', words = '', localRoot, fetchImpl, destructive = true, grant = false, exposed = null,
  workspace = hostedContext()?.workspace ?? null, lookup = dns.lookup } = {}) {
  let document;
  try { document = readJson(jobFile); } catch { return { ok: true, job: jobFile, changed: false, documents: [] }; }
  const ops = opsOf(document);
  const relevant = ops.some(op => op && typeof op === 'object' && (INTEGRATION_OPS.has(op.op) || (op.op === 'delete' && (op.breaks != null || /^I(?:Rest|SOAP)/.test(String(op.target ?? '')) || /^\$/.test(String(op.target ?? ''))))));
  if (!relevant) return { ok: true, job: jobFile, changed: false, documents: [] };
  // A served process that lost its hosted context does not know whose workspace confines the documents: nothing is read.
  if (!workspace && servedWithoutContext())
    return { ok: false, code: 'HOSTED_CONTEXT_LOST', error: 'The integration documents of this job were not read: the call lost its hosted context. Nothing was captured or sent.', problems: [] };
  let confine = null;
  if (workspace) {
    let workspaceReal;
    try { workspaceReal = fs.realpathSync.native(workspace); } catch { workspaceReal = path.resolve(workspace); }
    confine = { workspace: path.resolve(workspace), workspaceReal, lookup };
  }
  const client = fetchImpl ?? (confine ? createPublicFetch({ lookup, maxBytes: MAX_DOCUMENT_BYTES }) : globalThis.fetch);
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
    const pinned = await pin(source, { kind: slot.kind, localRoot: root, fetchImpl: client, at, jobDir: path.dirname(path.resolve(jobFile)), confine });
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
  // The copy lives in the lane's folder, so every name the kernel resolves against the job's folder first keeps naming the
  // file it named there (else the kernel would go on to the repository: on a hosted server, the server's own files): a
  // relative base, a job:<name> base or producer (job-patch.mjs pinReferences) and a document of another op.
  const jobDir = path.dirname(path.resolve(jobFile));
  const folder = path.join(root, 'jobs', 'integration');
  // Hosted, only a file of the workspace is named so (the gate refused any other).
  const here = value => { const file = path.join(jobDir, value); return (!confine || insideVisible(confine.workspace, file)) && fs.existsSync(file) ? file : null; };
  if (typeof copy?.base === 'string' && !copy.base.startsWith('job:') && !path.isAbsolute(copy.base) && here(copy.base)) copy.base = here(copy.base);
  pinReferences(copy, jobDir, folder);
  for (const op of copyOps) for (const field of documentPaths(op)) {
    const value = field.owner[field.key];
    if (!isUrl(value) && !hasScheme(value) && !path.isAbsolute(value) && here(value)) field.owner[field.key] = here(value);
  }
  const text = JSON.stringify(copy, null, 2);
  const target = path.join(folder, sha256(text) + '.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return { ok: true, job: target, changed: true, documents };
}
