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
// Samples (rest-consume): a GET method without sample is read once (sampleRestConsume: 10 s, 2 MB, no credentials, JSON,
// lists cut to 20 items) and the sample pinned in the op with sampledFrom {url, status, bytes, sha256}; never a POST.
// Hosted (fase4-28 r4-rest-hosted, M3 of the F3 review), never: the method answers DOCUMENT_FETCH_HOSTED_REFUSED (cause
// REST_CONSUME_SAMPLE_MISSING), the family rule of the documents: the server never fetches what a job names, before any
// lookup or connection; the gate refused the job before (hosted/policy.mjs restConsumeSampleRequired).
// Every problem in one refusal, before anything happens; only the words' sha256 is ever journaled (by the callers).
// Hosted (servidor/fase4-24, findings 1 and 3 of the confinement review): inside a hosted call (or with `workspace`) the
// documents are read for a customer, so every LOCAL file this module is about to read, the main document and each file a
// document imports or $refs (absolute, file: URL or relative to the document), must be inside the visible area of the
// customer's workspace by its lexical AND its real path, and the bytes are read from the real path; a document fetched by
// URL names only URLs (its relative names resolve against its URL; a file: or drive-letter reference is refused); a relative
// main document the job's folder does not have is refused (the kernel would look in the repository). Anything else is
// PATH_OUTSIDE_WORKSPACE naming the job pointer and the reference, before anything is read there. Every URL (the document,
// each redirect hop, each import) must reach a public address (hosted/public-fetch.mjs: DOCUMENT_HOST_NOT_PUBLIC), and the
// default fetch checks it again at connect time (superseded by fase4-28 r4-f3-import below: a hosted server fetches nothing).
// A served process that lost its hosted context reads nothing.
// fase4-28 r4-f3-import (criterion C3; supersedes the public fetch above for documents): a hosted server NEVER fetches a
// document. A WSDL or OpenAPI URL, a redirect and any import or $ref a document names by URL are refused before any request
// (DOCUMENT_FETCH_HOSTED_REFUSED); the document comes from the customer: a file of the workspace (ws:<rel>, or agent:inbox/<file>
// the SSAM Agent brings from the user's machine, where any download happened), or inline. Local use is unchanged.
// r40 (agent fetch; supersedes the refusal above when the customer's agent downloads): a URL is downloaded by the customer's
// SSAM Agent ON THE USER'S MACHINE (kind document.fetch, the agent 0.3.11 / 0.4.8-native, the SSAM Agent app 0.2.3), never by
// this server: the user's network, an intranet that machine reaches included, is the user's intent. The bytes it answers are
// read as the bytes of a URL read locally, with the same rules (the .wso companion, DTD/ENTITY, imports and $ref resolved
// against the final URL, the names of a WSDL's imports relative to it inside its folder, MAX_DOCUMENTS, the workspace quota,
// the pin under <localRoot>/documents/<sha256>/), after the server checks them again (fields, size, sha256: agentRead). One
// rule more than locally: what a downloaded document names is asked of the agent only on that document's own server
// (DOCUMENT_FETCH_OTHER_SERVER), so a document from the internet never makes the user's agent read another server for it: the
// agent is asked with sameOrigin (its redirects stay on that server) and the final URL it answers is checked again here.
// The sample GET of rest-consume goes the same way (10 s, 2 MB, JSON). Every URL the agent downloaded is listed on the answer
// (DOCUMENT_DOWNLOADED_BY_AGENT, with its sha256 and bytes). An agent without the kind (the apps 0.2.1/0.2.2), or none
// connected, keeps DOCUMENT_FETCH_HOSTED_REFUSED before anything is asked, its fix saying to update or connect the agent; the
// server's own HTTP client is never called for a hosted customer.
// Inline (both modes): "wsdl": {"content": "<the WSDL text>", "name"?: "service.wsdl"} of a soap op, or "openapi": {"content":
// "<the JSON text>", "name"?, "operations": [...]} of a rest op. The text is written once under <localRoot>/documents/inline/
// <sha256>/<name> and pinned like a file (sha256, size, DTD/ENTITY refusal); an inline document is self-contained: a file it
// imports is not there, and is refused naming it. The kernel and the bridge only ever see the pinned path and its sha256.
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { namesWhole } from './studio-create-app.mjs';
import { pinReferences } from './job-patch.mjs';
import { hostedContext, servedWithoutContext } from './executor.mjs';
import { insideVisible, createQuota, workspaceFull } from './hosted/mirror.mjs';
import { MAX_REDIRECTS } from './hosted/public-fetch.mjs';

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENTS = 32;
export const FETCH_TIMEOUT_MS = 30000;
// rest-consume (the generator, kernel RestConsume.cs): a GET method without a sample is sampled once here, never by the
// kernel: 10 s, at most 2 MB, no credentials, JSON only; every list of the answer is cut to its first 20 items (the kernel
// types a list from all the items it is given).
export const SAMPLE_TIMEOUT_MS = 10000;
export const SAMPLE_MAX_BYTES = 2 * 1024 * 1024;
export const SAMPLE_LIST_ITEMS = 20;
export const INTEGRATION_TYPES = Object.freeze(['IRestClient', 'IRestAction', 'IRestStructure', 'IRestService', 'IRestServiceAction', 'ISOAPClient', 'ISOAPAction', 'ISOAPStructure']);
const INTEGRATION_OPS = new Set(['rest', 'rest-consume', 'rest-expose', 'soap']);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
const isUrl = text => /^https?:\/\//i.test(String(text ?? ''));
const problem = (code, message, fix, extra = {}) => ({ code, ...extra, message, fix: fix ?? null });

// ---- r40: documents downloaded by the customer's agent ----------------------------------------------------------------

export const DOCUMENT_FETCH_KIND = 'document.fetch';
// The refusals of the agent's kind (agent/lib/document-fetch.mjs, DocumentFetch.cs), each with the fix the server gives.
// The keys are quoted: the quality registry lists a code only from a quoted literal (quality-registry.mjs).
export const AGENT_FETCH_FIXES = Object.freeze({
  'DOCUMENT_FETCH_URL_REFUSED': 'give an http(s) URL without a user or password and not a link-local (cloud metadata) address, or the file (agent:inbox/<file>), or the document inline',
  'DOCUMENT_FETCH_REDIRECT_REFUSED': 'give the document\'s final http(s) URL (at most 5 redirects, each to http or https; what a document names stays on its own server)',
  'DOCUMENT_FETCH_TOO_LARGE': 'use a document of at most 5 MB (a sample of at most 2 MB)',
  'DOCUMENT_FETCH_UNSAFE_XML': 'use the service\'s own WSDL and schemas without <!DOCTYPE>/<!ENTITY>',
  'DOCUMENT_FETCH_NOT_DOCUMENT': 'give the URL of the document itself (a WSDL is often <service>?WSDL; an OpenAPI document or a sample is JSON)',
  'DOCUMENT_FETCH_FAILED': 'check that the user\'s machine reaches the URL (in a browser there), or give the file (agent:inbox/<file>) or the document inline',
});
// The link's answers that mean no agent downloads now (the rest of the preparation is refused at once, nothing waits again).
const LINK_GONE = new Set(['AGENT_NOT_CONNECTED', 'AGENT_RECONNECTING', 'AGENT_DISCONNECTED', 'KIND_NOT_ALLOWED']);
const MAX_URL = 4096;
export const DOCUMENT_DOWNLOADED_BY_AGENT = 'DOCUMENT_DOWNLOADED_BY_AGENT';
// The agent's answer that the server's own check refuses (fields, base64, size or sha256 not as declared).
export const AGENT_FETCH_INVALID = 'DOCUMENT_FETCH_AGENT_INVALID';
// A reference a downloaded document names on another server than its own (pin): never asked of the agent.
export const AGENT_FETCH_ORIGIN = 'DOCUMENT_FETCH_OTHER_SERVER';
const AGENT_VERSIONS = 'the SSAM Agent 0.3.11 / 0.4.8-native, the SSAM Agent app 0.2.3 or later';
// What a hosted refusal adds for the agent: 'update' (the connected agent does not download), 'absent' (none connected).
export const agentHint = state => state === 'update' ? ` Or update the SSAM Agent to let it download on the user's machine (${AGENT_VERSIONS}).`
  : state === 'absent' ? ` Or connect the SSAM Agent on the user's machine (${AGENT_VERSIONS}) to let it download there.` : '';

// The downloads of one preparation through the customer's agent, read once. agent: the hosted executor (documentFetchState,
// documentFetch), or null. -> {state: 'ready'|'update'|'absent', fetch|null, downloads: []}.
function agentFetcher(agent) {
  let state = 'absent';
  try { state = agent?.documentFetchState?.() ?? 'absent'; } catch { state = 'absent'; }
  if (!['ready', 'update', 'absent'].includes(state)) state = 'absent';
  return { state, fetch: state === 'ready' ? params => agent.documentFetch(params) : null, downloads: [] };
}

/**
 * One GET by the customer's agent, checked again here (fields, canonical base64, bytes, sha256, the limit; DTD/ENTITY stay with
 * the rules of the caller, as for a local read). -> {bytes, finalUrl, status, contentType} | {problem}. The server never
 * requests anything itself; a refusal of the link (no agent, an agent without the kind) is the hosted refusal of the family.
 */
async function agentRead(url, { agent, accept, maxBytes, timeoutMs, from = null, at = null }) {
  if (!agent.fetch) return { problem: hostedFetchProblem(url, from, agent.state) };
  if (url.length > MAX_URL) return { problem: problem('DOCUMENT_FETCH_URL_REFUSED', `${url.slice(0, 200)}... has more than ${MAX_URL} characters, so it was not requested`, AGENT_FETCH_FIXES.DOCUMENT_FETCH_URL_REFUSED, { downloadedBy: 'agent' }) };
  // review 1: what a document names (from) is downloaded only from that document's own server, its redirects included.
  const sameOrigin = from !== null && isUrl(from);
  let value;
  try { value = await agent.fetch({ url, accept, maxBytes, timeoutMs, ...(sameOrigin ? { sameOrigin: true } : {}) }); }
  catch (error) {
    const code = String(error?.code ?? '');
    if (Object.hasOwn(AGENT_FETCH_FIXES, code))
      return { problem: problem(code, `the SSAM Agent on the user's machine did not download ${url}: ${String(error?.message ?? '').slice(0, 300)}`, AGENT_FETCH_FIXES[code], { url, downloadedBy: 'agent' }) };
    // review 3: the link lost the agent (or the agent changed under the call): the rest of this preparation is refused at once.
    if (LINK_GONE.has(code)) {
      agent.state = code === 'KIND_NOT_ALLOWED' ? 'update' : 'absent';
      agent.fetch = null;
      return { problem: hostedFetchProblem(url, from, agent.state, code) };
    }
    // review 5: any other answer (busy, a deadline, parameters the agent refused) is named as it is, the agent still connected.
    return { problem: problem('DOCUMENT_FETCH_FAILED', `the SSAM Agent on the user's machine did not download ${url} (${code || 'AGENT_ERROR'}): ${String(error?.message ?? '').slice(0, 300)}`,
      'send the call again; if it repeats, give the file (agent:inbox/<file>) or the document inline', { url, cause: code || 'AGENT_ERROR', downloadedBy: 'agent' }) };
  }
  const invalid = what => ({ problem: problem(AGENT_FETCH_INVALID, `the SSAM Agent answered the download of ${url} with ${what}, so its bytes were not used`, 'update the SSAM Agent on the user\'s machine, then send the call again', { url }) });
  if (!value || typeof value !== 'object') return invalid('no answer');
  const { finalUrl, status, contentBase64, sha256: declared, bytes: size } = value;
  if (typeof finalUrl !== 'string' || !isUrl(finalUrl) || !Number.isInteger(status) || typeof contentBase64 !== 'string' || !/^[0-9a-f]{64}$/.test(String(declared)) || !Number.isSafeInteger(size))
    return invalid('fields that are not the kind\'s');
  let parsed;
  try { parsed = new URL(finalUrl); if (parsed.username || parsed.password) return invalid('a final URL that carries a user or password'); } catch { return invalid('a final URL that is not a URL'); }
  // review 1: an agent that followed a redirect to another server for a reference (sameOrigin unknown to an older kind): not used.
  if (sameOrigin && parsed.origin !== new URL(url).origin)
    return { problem: problem(AGENT_FETCH_ORIGIN, `the download of ${url} ended on another server (${parsed.origin}), so its bytes were not used`,
      'download that file on the user\'s machine and give the document with its files (agent:inbox/<folder>/...), or put the document inline', { url, downloadedBy: 'agent' }) };
  if (contentBase64.length > Math.ceil(maxBytes / 3) * 4) return { problem: problem('DOCUMENT_TOO_LARGE', `${url} has more than ${maxBytes} bytes`, 'use a document of at most 5 MB (a sample of at most 2 MB)', { url }) };
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.toString('base64') !== contentBase64) return invalid('content that is not base64');
  if (bytes.length !== size || sha256(bytes) !== declared) return invalid('content whose size or sha256 is not the one it declared');
  if (bytes.length > maxBytes) return { problem: problem('DOCUMENT_TOO_LARGE', `${url} has ${bytes.length} bytes, more than ${maxBytes}`, 'use a document of at most 5 MB (a sample of at most 2 MB)', { url }) };
  const download = status >= 200 && status <= 299 ? { url, finalUrl, status, bytes: bytes.length, sha256: declared, ...(at ? { at } : {}) } : null;
  if (download) agent.downloads.push(download);
  return { bytes, finalUrl, status, download, contentType: typeof value.contentType === 'string' ? value.contentType.slice(0, 200) : null };
}

/** The notes of an answer: one per URL the customer's agent downloaded ({rule, at, note}, the facade's normalizations list). */
export function downloadNotes(downloads) {
  return (Array.isArray(downloads) ? downloads : []).map(d => ({ rule: DOCUMENT_DOWNLOADED_BY_AGENT, at: d.at ?? '/ops',
    note: `${d.url}${d.finalUrl !== d.url ? ` (final URL ${d.finalUrl})` : ''} was downloaded by the SSAM Agent on the user's machine: ${d.bytes} bytes, sha256 ${d.sha256}; the SSAM server made no request` }));
}

/** The ops of a job document (array or {ops}); a composite {jobs} is left to the kernel. */
const opsOf = document => (Array.isArray(document) ? document : Array.isArray(document?.ops) ? document.ops : []);

// ---- an op without data (OP_DATA_WRAPPED) -----------------------------------------------------------------------------

// The keys of the data of each integration op: the kernel's JobNormalizer.DataKeys (SoapPlan.Keys, RestExpander.RootKeys,
// RestExposeExpander.RootKeys), held equal by tests/integration-documents.test.mjs against `anvil api --op <op>`.
export const DATA_KEYS = Object.freeze({
  soap: Object.freeze(['wsdl', 'client', 'service', 'port', 'binding', 'soapVersion', 'methods', 'refresh', 'remove', 'breaks']),
  rest: Object.freeze(['client', 'methods', 'structures', 'openapi', 'remove', 'breaks']),
  'rest-expose': Object.freeze(['service', 'methods', 'remove', 'breaks']),
});
export const DATA_WRAPPED = 'OP_DATA_WRAPPED';

/**
 * F7 (25/10/2026): an integration op written without `data` ({"op":"soap","wsdl":...,"methods":[...]}) has one reading: its
 * keys of the data go into `data`, in place, each op listed as the kernel lists it (JobNormalizer.WrapData, same rule, path,
 * from, to and message). A key that is no key of the data stays where it is (the kernel's verb contract names it).
 * -> [{rule, path, from, to, message, keys}] (keys: what moved, so the caller can write the op back as it was sent).
 */
export function wrapData(ops, prefix = '/ops') {
  const done = [];
  for (const [i, op] of ops.entries()) {
    if (!op || typeof op !== 'object' || Array.isArray(op) || op.data != null || !Object.hasOwn(DATA_KEYS, op.op)) continue;
    const keys = Object.keys(op).filter(k => DATA_KEYS[op.op].includes(k));
    if (keys.length === 0) continue;
    const data = {};
    for (const key of keys) { data[key] = op[key]; delete op[key]; }
    op.data = data;
    done.push({ rule: DATA_WRAPPED, path: `${prefix}/${i}`, from: keys.join(', '), to: 'data',
      message: `${op.op}: ${keys.join(', ')} ${keys.length === 1 ? 'is a key' : 'are keys'} of the op's data and went into "data": {...} (the op's only shape)`, keys });
  }
  return done;
}

// The op as it was sent (its data keys at the top again): the kernel wraps it itself and lists OP_DATA_WRAPPED in its receipt.
function unwrapData(ops, wrapped) {
  for (const entry of wrapped) {
    const op = ops[Number(entry.path.split('/').pop())];
    if (!op?.data || typeof op.data !== 'object') continue;
    const data = op.data;
    delete op.data;
    for (const key of entry.keys) op[key] = data[key];
  }
}

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
        problems.push(problem('INTEGRATION_DELETE_WORDS', `the user's words do not name ${t.target}, which this job deletes`, `words that name ${nameOf(t.target)} (whole word), e.g. "delete ${t.target}"`, { target: t.target, path: t.path }));
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
// fase4-28 r4-f3-import: a hosted server never fetches a document (the URL is shown, nothing was requested).
export const HOSTED_FETCH_REFUSED = 'DOCUMENT_FETCH_HOSTED_REFUSED';
// r40: state (agentFetcher) adds how the agent would download it; cause: what the agent link answered, when it was asked.
const hostedFetchProblem = (url, from, state = null, cause = null) => problem(HOSTED_FETCH_REFUSED,
  `${from ? `the document ${path.basename(String(from))} names ${url}; ` : ''}the SSAM server never fetches a document for a hosted account, so ${url} was not requested`
    + (state === 'update' ? '; the SSAM Agent on the user\'s machine does not download documents' : state === 'absent' ? '; no SSAM Agent that downloads documents is connected' : ''),
  'download it on the user\'s machine and give the file (agent:inbox/<file>, or ws:<rel>; a WSDL with its imports next to it, named relative to it), or put the document inline: "wsdl": {"content": "<text>"} or "openapi": {"content": "<JSON text>", "operations": [...]}.' + agentHint(state),
  { url, ...(cause ? { cause } : {}) });
const hostProblem = refused => problem(refused.code, refused.message,
  refused.code === 'DOCUMENT_HOST_NOT_PUBLIC' ? 'give the document\'s public URL, or put the file in the agent inbox (agent:inbox/<file>) and name it'
    : refused.code === 'UNSUPPORTED_DOCUMENT_SCHEME' ? 'give an http(s) URL or the file in the workspace' : 'check the URL, or put the file in the agent inbox (agent:inbox/<file>)');

/**
 * Reads one document (URL or local path) with the limits; a refusal is {problem}. confine (hosted): {workspace,
 * workspaceReal, lookup}; from: the location of the document that names this one (null for the main document).
 */
async function readDocument(source, { fetchImpl, base, wsdl, confine = null, from = null, accept = 'xml', at = null }) {
  let resolved = source;
  if (base && !isUrl(source) && !path.isAbsolute(source) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source))
    resolved = isUrl(base) ? new URL(source, base).toString() : path.resolve(path.dirname(base), source);
  if (/^file:/i.test(resolved)) {
    if (confine) { resolved = fileUrlPath(resolved); if (!resolved) return { problem: outsideProblem(source, from) }; }
    else if (/^file:\/\//i.test(resolved)) resolved = decodeURIComponent(new URL(resolved).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  }
  // r40: hosted, a URL is downloaded by the customer's agent on the user's machine, or refused before anything is asked.
  if (isUrl(resolved) && confine) {
    if (!confine.agent?.fetch) return { problem: hostedFetchProblem(resolved, from, confine.agent?.state ?? null) };
    const get = url => agentRead(url, { agent: confine.agent, accept, maxBytes: MAX_DOCUMENT_BYTES, timeoutMs: FETCH_TIMEOUT_MS, from, at });
    const ok = read => !read.problem && read.status >= 200 && read.status <= 299;
    let read = await get(resolved);
    // The .wso companion, as locally: its HTML page (a DOCTYPE the agent refuses, or no WSDL) gives way to its ?WSDL.
    if (wsdl && /\.wso$/i.test(new URL(resolved).pathname) && !new URL(resolved).search && !(ok(read) && looksLikeWsdl(read.bytes))) {
      if (read.download) confine.agent.downloads.splice(confine.agent.downloads.indexOf(read.download), 1);
      read = await get(resolved + '?WSDL');
    }
    if (read.problem) return read;
    if (!ok(read)) return { problem: problem('DOCUMENT_NOT_FOUND', `GET ${read.finalUrl} answered ${read.status} on the user's machine (downloaded by the SSAM Agent)`, 'check the URL (the service\'s own ?WSDL or OpenAPI address)', { url: resolved, downloadedBy: 'agent' }) };
    return { bytes: read.bytes, source: read.finalUrl, location: read.finalUrl };
  }
  if (isUrl(resolved)) {
    if (typeof fetchImpl !== 'function') return { problem: problem('UNSUPPORTED_DOCUMENT_SCHEME', `no HTTP client to read ${resolved}`, 'pass the downloaded file\'s absolute path') };
    // Hosted: every hop is checked (scheme and a public address) before it is requested, and a redirect is followed here,
    // never by the client, so each new address is checked too.
    const get = async first => {
      let url = first;
      for (let hop = 0; ; hop++) {
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
// inline (fase4-28 r4-f3-import, review M1/B1): {bytes, name} of an inline document, pinned straight from the buffer (one
// write); it may name no file at all. written: the files this call created (removed again when the job is refused).
// review A1: a name relative to the document (no scheme, no drive, not rooted), and the place an import resolves to,
// relative to the main document's folder (posix), or null when it leaves that folder or is on another server.
const relativeName = reference => { const text = String(reference); return !isUrl(text) && !hasScheme(text) && !isDrive(text) && !/^[\\/]/.test(text); };
function insideName(mainLocation, absolute) {
  let rel;
  if (isUrl(mainLocation)) {
    if (!isUrl(absolute)) return null;
    const main = new URL(mainLocation), target = new URL(absolute);
    if (main.origin !== target.origin || target.search) return null;
    rel = path.posix.relative(path.posix.dirname(main.pathname), target.pathname);
  } else {
    if (typeof absolute !== 'string' || isUrl(absolute) || !path.isAbsolute(absolute)) return null;
    rel = path.relative(path.dirname(mainLocation), absolute).split(path.sep).join('/');
  }
  return rel && !rel.startsWith('..') && !path.posix.isAbsolute(rel) && !isDrive(rel) ? rel : null;
}

async function pin(source, { kind, localRoot, fetchImpl, at, jobDir, confine = null, inline = null, written = [] }) {
  const wsdl = kind === 'wsdl';
  // A path relative to the job's own folder is a local file too; one that is not there is left to the kernel (suite jobs;
  // hosted: refused). Hosted, the candidate is looked at only inside the workspace.
  const candidate = !inline && !isUrl(source) && !hasScheme(source) && !path.isAbsolute(source) && jobDir ? path.resolve(jobDir, source) : null;
  const local = candidate && (!confine || insideVisible(confine.workspace, candidate)) && fs.existsSync(candidate) ? candidate : source;
  const main = inline ? { bytes: inline.bytes, location: path.join(localRoot, 'documents', 'inline', inline.name), source: 'inline' }
    : await readDocument(local, { fetchImpl, wsdl, confine, accept: wsdl ? 'xml' : 'json', at });
  if (main.relative) return { unchanged: true };
  if (main.problem) return { problems: [{ ...main.problem, path: at }] };
  if (wsdl && unsafeXml(main.bytes)) return { problems: [problem('UNSAFE_WSDL_XML', `the WSDL of ${main.source} declares a DTD or ENTITY`, 'use the service\'s own WSDL without <!DOCTYPE>/<!ENTITY>', { path: at })] };
  const digest = sha256(main.bytes);
  const folder = path.join(localRoot, 'documents', digest);
  const mainName = inline ? inline.name : (isUrl(main.location) ? path.basename(new URL(main.location).pathname) : path.basename(main.location)) || (wsdl ? 'service.wsdl' : 'openapi.json');
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
      if (inline) { problems.push(problem('DOCUMENT_INLINE_INVALID', `the inline ${wsdl ? 'WSDL' : 'OpenAPI document'} names the file '${reference}'; an inline document cannot import files`,
        `give the document and its files as files instead: agent:inbox/<folder>/${mainName} with each file it ${wsdl ? 'imports' : 'references'} in that folder, named relative to it`, { path: at, target: reference })); continue; }
      const absolute = referenceTarget(reference, current.location, confine);
      if (absolute?.outside) { problems.push({ ...outsideProblem(reference, current.location), path: at, target: reference }); continue; }
      // review A1: the Studio's SOAP importer reads the pinned WSDL and resolves each import BY ITS NAME next to it (on the
      // customer's machine, in the agent's folder): an import that is not relative or leaves the main document's folder
      // (../x.xsd, an absolute path, file:, a URL) would be read from somewhere else, or not at all. Refused at every level.
      if (wsdl && !absolute?.outside && confine && typeof absolute === 'string' && !isUrl(absolute) && path.isAbsolute(absolute) && !insideVisible(confine.workspace, absolute)) {
        problems.push({ ...outsideProblem(reference, current.location), path: at, target: reference }); continue;
      }
      // Hosted, an import by URL is DOCUMENT_FETCH_HOSTED_REFUSED (readDocument), which says how to give the file; r40: unless
      // the customer's agent downloads it, when its name is judged as locally.
      if (wsdl && !absolute?.outside && !(confine && isUrl(absolute) && !confine.agent?.fetch)) {
        const inside = insideName(main.location, absolute);
        if (!relativeName(reference) || inside === null) {
          problems.push(problem('DOCUMENT_NAME_INVALID', `the WSDL import '${reference}'${current.location !== main.location ? ` (named by ${path.basename(String(current.location))})` : ''} is not a name relative to the WSDL inside its folder`,
            'name each import relative to the WSDL, inside its folder (the Studio\'s importer reads it by that name): put the WSDL and every file it imports in one folder (agent:inbox/<folder>/...)', { path: at, target: reference }));
          continue;
        }
      }
      // r40: the customer's agent downloads what a document names only from that document's own server (its final URL's
      // origin; a WSDL import is already inside its folder above): a document read from the internet never makes the user's
      // agent read another server, an intranet one included, on its behalf. Deviation from local use (which follows any
      // $ref), written in the design: the file can always be given (agent:inbox/<folder>/...) or the document inline.
      if (confine?.agent?.fetch && isUrl(absolute) && isUrl(current.location) && new URL(absolute).origin !== new URL(current.location).origin) {
        problems.push(problem(AGENT_FETCH_ORIGIN, `the document ${current.location} names ${absolute}, on another server: the SSAM Agent downloads what a document names only from that document's own server, so it was not requested`,
          `download that file on the user's machine and give the document with its files (agent:inbox/<folder>/${mainName} and each file it ${wsdl ? 'imports' : 'references'}, named relative to it), or put the document inline`, { path: at, target: reference }));
        continue;
      }
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      if (files.length >= MAX_DOCUMENTS) { problems.push(problem('DOCUMENT_TOO_LARGE', `${main.source} imports more than ${MAX_DOCUMENTS} documents`, 'import a smaller contract (one service, its own types)', { path: at })); break; }
      const read = await readDocument(absolute, { fetchImpl, wsdl: false, confine, from: current.location, accept: wsdl ? 'xml' : 'json', at });
      if (read.problem) { problems.push({ ...read.problem, path: at, target: reference }); continue; }
      if (read.relative) continue;
      if (wsdl && unsafeXml(read.bytes)) { problems.push(problem('UNSAFE_WSDL_XML', `the imported ${absolute} declares a DTD or ENTITY`, 'use documents without <!DOCTYPE>/<!ENTITY>', { path: at })); continue; }
      // The relative name is kept so the importer resolves it next to the main document; any other gets its own.
      const relative = wsdl ? insideName(main.location, absolute) : pinnedName(reference, absolute);
      files.push({ source: read.source, name: relative, bytes: read.bytes });
      dependencies[reference] = { name: relative, sha256: sha256(read.bytes) };
      queue.push({ bytes: read.bytes, location: read.location });
    }
  }
  if (problems.length) return { problems };
  const targets = files.map(file => path.join(folder, ...file.name.split('/')));
  const outside = files.find((file, n) => !within(folder, targets[n]));
  if (outside) return { problems: [problem('DOCUMENT_NAME_INVALID', `the import '${outside.name}' would be pinned outside ${folder}`, 'name imports relative to the document, inside its folder', { path: at })] };
  const fresh = files.filter((file, n) => !fs.existsSync(targets[n]) || sha256(fs.readFileSync(targets[n])) !== sha256(file.bytes));
  // Hosted (review M1): the bytes this call adds count against the customer's workspace quota (hosted/mirror.mjs).
  const adding = fresh.reduce((sum, file) => sum + file.bytes.length, 0);
  if (confine?.quota && adding > 0 && confine.quota.full(adding)) {
    const full = workspaceFull(confine.quota);
    return { problems: [problem(full.code, full.message, 'remove what the workspace no longer needs (old captures, documents, deliveries), then send the job again', { path: at })] };
  }
  files.forEach((file, n) => {
    const target = targets[n];
    if (fresh.includes(file)) {
      if (!fs.existsSync(target)) written.push(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.bytes);
    }
    file.path = target;
  });
  if (adding > 0) confine?.quota?.add?.(adding);
  const document = { path: files[0].path, sha256: digest, source: main.source };
  const deps = Object.fromEntries(Object.entries(dependencies).map(([uri, d]) => [uri, { path: path.join(folder, ...d.name.split('/')), sha256: d.sha256 }]));
  if (Object.keys(deps).length) document[wsdl ? 'imports' : 'external'] = deps;
  return { document, files: files.map(f => ({ source: f.source, path: f.path, sha256: sha256(f.bytes), bytes: f.bytes.length })) };
}

// ---- rest-consume samples ---------------------------------------------------------------------------------------------

const PLACEHOLDER = /\{([^{}=]*)(?:=([^{}]*))?\}/g;

/**
 * The URL a method of rest-consume is sampled with: its url (absolute, or relative to data.baseUrl) with each {p=example}
 * or {p} filled from the example or method.try. -> {url} | {problem}.
 */
export function sampleUrl(data, method, at = '') {
  const raw = String(method?.url ?? '').trim();
  const base = typeof data?.baseUrl === 'string' ? data.baseUrl.trim().replace(/\/+$/, '') : null;
  const absolute = isUrl(raw) ? raw : base && isUrl(base) ? base + (raw.startsWith('/') ? '' : '/') + raw : null;
  if (!absolute) return { problem: problem('REST_CONSUME_URL_INVALID', `rest-consume: url '${raw}' of '${method?.name}' is not an http(s) URL and the op has no baseUrl`, '"url": "https://host/path"', { path: `${at}/url` }) };
  const tries = method?.try && typeof method.try === 'object' ? method.try : {};
  const missing = [];
  const url = absolute.replace(PLACEHOLDER, (whole, name, example) => {
    const key = String(name).trim();
    const value = tries[key] ?? example;
    if (value == null || String(value) === '') { missing.push(key); return whole; }
    return encodeURIComponent(String(value));
  });
  if (missing.length) return { problem: problem('REST_CONSUME_TRY_MISSING', `rest-consume: to sample '${method?.name}' the url needs a value for ${missing.map(m => `{${m}}`).join(', ')}`,
    `write each one with an example, {${missing[0]}=<value>}, or "try": {"${missing[0]}": <value>}; or give "sample": <the JSON response>`, { path: `${at}/url` }) };
  return { url };
}

/** Every list of a JSON value cut to its first `max` items (the kernel types a list from the items it sees). */
export function trimSample(value, max = SAMPLE_LIST_ITEMS) {
  let trimmed = false;
  const walk = v => {
    if (Array.isArray(v)) { if (v.length > max) trimmed = true; return v.slice(0, max).map(walk); }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), trimmed };
}

/** One GET of a sample URL: JSON only, the limits above, no credentials. -> {sample, sampledFrom} | {problem}. */
export async function fetchSample(url, { fetchImpl = globalThis.fetch, at = '' } = {}) {
  if (typeof fetchImpl !== 'function') return { problem: problem('REST_CONSUME_SAMPLE_FETCH_FAILED', `no HTTP client to sample ${url}`, 'give "sample": <the JSON response>', { path: at }) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SAMPLE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'follow', credentials: 'omit', signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'SSAM-Hybrid rest-consume sample' } });
    if (!response.ok) return { problem: problem('REST_CONSUME_SAMPLE_FETCH_FAILED', `GET ${url} answered ${response.status}`,
      'check the url and its example values ({p=value} or "try"), or give "sample": <the JSON response>', { path: at, status: response.status }) };
    const declared = Number(response.headers?.get?.('content-length') ?? 0);
    if (declared > SAMPLE_MAX_BYTES) return { problem: problem('REST_CONSUME_SAMPLE_TOO_LARGE', `${url} declares ${declared} bytes, more than ${SAMPLE_MAX_BYTES}`, 'sample a smaller page (a query that limits the items), or give "sample"', { path: at }) };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > SAMPLE_MAX_BYTES) return { problem: problem('REST_CONSUME_SAMPLE_TOO_LARGE', `${url} has ${bytes.length} bytes, more than ${SAMPLE_MAX_BYTES}`, 'sample a smaller page (a query that limits the items), or give "sample"', { path: at }) };
    let json;
    try { json = JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')); } catch {
      return { problem: problem('REST_CONSUME_SAMPLE_NOT_JSON', `GET ${url} answered ${response.headers?.get?.('content-type') ?? 'no content type'}, not JSON`, 'give "sample": <the JSON response>, or consume a JSON endpoint', { path: at }) };
    }
    const { value, trimmed } = trimSample(json);
    return { sample: value, sampledFrom: { url, status: response.status, bytes: bytes.length, sha256: sha256(bytes), ...(trimmed ? { trimmedTo: SAMPLE_LIST_ITEMS } : {}) } };
  } catch (error) {
    return { problem: problem('REST_CONSUME_SAMPLE_FETCH_FAILED', `GET ${url} failed: ${error?.name === 'AbortError' ? `no answer in ${SAMPLE_TIMEOUT_MS / 1000} s` : String(error?.message ?? error).split('\n')[0]}`,
      'check the url, or give "sample": <the JSON response>', { path: at }) };
  } finally { clearTimeout(timer); }
}

// r40: one sample GET by the customer's agent on the user's machine (agentRead: 10 s, 2 MB, JSON), read as fetchSample reads its
// answer; the agent's refusals keep the sample codes (REST_CONSUME_SAMPLE_*), with the agent's code as the cause.
async function agentSample(url, { agent, at }) {
  const read = await agentRead(url, { agent, accept: 'json', maxBytes: SAMPLE_MAX_BYTES, timeoutMs: SAMPLE_TIMEOUT_MS, at: at.replace(/\/url$/, '') });
  if (read.problem) {
    const code = read.problem.code;
    const mapped = code === 'DOCUMENT_FETCH_TOO_LARGE' || code === 'DOCUMENT_TOO_LARGE' ? 'REST_CONSUME_SAMPLE_TOO_LARGE' : code === 'DOCUMENT_FETCH_NOT_DOCUMENT' ? 'REST_CONSUME_SAMPLE_NOT_JSON'
      : code === HOSTED_FETCH_REFUSED ? HOSTED_FETCH_REFUSED : 'REST_CONSUME_SAMPLE_FETCH_FAILED';
    return { problem: { ...read.problem, code: mapped, path: at, ...(mapped !== code ? { cause: code } : {}),
      fix: mapped === HOSTED_FETCH_REFUSED ? read.problem.fix : `${read.problem.fix}; or give "sample": <the JSON response>` } };
  }
  if (read.status < 200 || read.status > 299) return { problem: problem('REST_CONSUME_SAMPLE_FETCH_FAILED', `GET ${url} answered ${read.status} on the user's machine (downloaded by the SSAM Agent)`,
    'check the url and its example values ({p=value} or "try"), or give "sample": <the JSON response>', { path: at, status: read.status, downloadedBy: 'agent' }) };
  let json;
  try { json = JSON.parse(read.bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch {
    return { problem: problem('REST_CONSUME_SAMPLE_NOT_JSON', `GET ${url} answered ${read.contentType || 'no content type'}, not JSON`, 'give "sample": <the JSON response>, or consume a JSON endpoint', { path: at }) };
  }
  const { value, trimmed } = trimSample(json);
  return { sample: value, sampledFrom: { url, status: read.status, bytes: read.bytes.length, sha256: sha256(read.bytes), ...(trimmed ? { trimmedTo: SAMPLE_LIST_ITEMS } : {}) } };
}

/** The samples of a rest-consume op: each GET method without one is sampled once and pinned in the op. */
// The code of the family (the same text a WSDL or OpenAPI URL answers hosted).
const SAMPLE_FETCH_REFUSED = 'DOCUMENT_FETCH_HOSTED_REFUSED';
// r40: agent (agentFetcher), hosted: the customer's agent samples on the user's machine when it downloads; else the refusal.
async function sampleRestConsume(op, i, { fetchImpl, hosted = false, agent = null }) {
  const problems = [];
  let changed = false;
  const methods = Array.isArray(op.data?.methods) ? op.data.methods : [];
  // An authenticated API answers 401 to a GET without credentials, and the sampler never sends any: no request, one problem
  // per method without a sample.
  const auth = op.data?.auth && typeof op.data.auth === 'object' ? String(op.data.auth.type ?? 'none') : 'none';
  for (const [j, method] of methods.entries()) {
    if (!method || typeof method !== 'object' || method.sample !== undefined) continue;
    if (String(method.verb ?? 'GET').toUpperCase() !== 'GET') continue; // no request is ever sent that could change data
    const at = `/ops/${i}/data/methods/${j}`;
    // fase4-28 r4-rest-hosted (M3 of the F3 review): the family rule of the documents, DOCUMENT_FETCH_HOSTED_REFUSED: a
    // hosted server never fetches what a job names, here the sample GET, before any lookup or connection. Local use keeps it.
    if (hosted && !agent?.fetch) {
      const shown = sampleUrl(op.data, method, at).url ?? method.url ?? null;
      problems.push(problem(SAMPLE_FETCH_REFUSED, `rest-consume: method '${method.name}' has no sample; the SSAM server never fetches for a hosted account, so `
        + (shown ? `${shown} was not requested` : 'nothing was requested'),
        'give the response inline in the method: "sample": <the JSON response> (from the API documentation, or a call the user made on their machine).' + agentHint(agent?.state ?? null),
        { path: `${at}/sample`, cause: 'REST_CONSUME_SAMPLE_MISSING', ...(shown ? { url: shown } : {}) }));
      continue;
    }
    if (auth !== 'none') {
      problems.push(problem('REST_CONSUME_SAMPLE_MISSING', `rest-consume: method '${method.name}' has no sample and the API is authenticated (auth ${auth}): the sampler never sends credentials`,
        'give "sample": <the JSON response> (from the API\'s documentation or a call made with the credentials)', { path: `${at}/sample` }));
      continue;
    }
    const target = sampleUrl(op.data, method, at);
    if (target.problem) { problems.push(target.problem); continue; }
    const read = hosted ? await agentSample(target.url, { agent, at: `${at}/url` }) : await fetchSample(target.url, { fetchImpl, at: `${at}/url` });
    if (read.problem) { problems.push(read.problem); continue; }
    method.sample = read.sample;
    method.sampledFrom = read.sampledFrom;
    changed = true;
  }
  return { problems, changed };
}

// rest-consume auth basic on O11 encodes user:password at runtime with the system extension BinaryData (in every O11
// environment): the job references its two actions. An op of the job that already references BinaryData gets the missing
// elements; otherwise one op is appended at the end (no op of the model moves; the kernel imports a frozen reference
// before the edit, and o11_deliver captures every producer a reference op names, read-only). ODC: none (the setting holds
// the Base64). Kernel: RestConsume.BinaryDataReference.
export const BINARY_DATA_REFERENCE = Object.freeze({ op: 'reference', producer: 'BinaryData', elements: Object.freeze(['IServerAction:TextToBinaryData', 'IServerAction:BinaryToBase64']) });

export function addBinaryDataReference(ops, lane) {
  if (lane !== 'o11' || !ops.some(op => op?.op === 'rest-consume' && op.data?.auth?.type === 'basic')) return false;
  const existing = ops.find(op => op?.op === 'reference' && String(op.producer ?? '').toLowerCase() === 'binarydata');
  if (existing) {
    const elements = Array.isArray(existing.elements) ? existing.elements : (existing.elements = []);
    const missing = BINARY_DATA_REFERENCE.elements.filter(e => !elements.includes(e));
    elements.push(...missing);
    return missing.length > 0;
  }
  ops.push({ op: 'reference', producer: BINARY_DATA_REFERENCE.producer, elements: [...BINARY_DATA_REFERENCE.elements] });
  return true;
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
 * the HTTP client of local use (default the global fetch); hosted, none is ever called (r40). agent: the hosted executor whose
 * documentFetch downloads on the user's machine (default: the hosted call's; tests: a fake), asked only for a URL.
 * -> {ok:true, job, changed, documents:[{source, path, sha256, bytes}], normalizations?, notes?} | {ok:false, code, error, problems, continuation?, notes?}
 * notes (r40): DOCUMENT_DOWNLOADED_BY_AGENT, one {rule, at, note} per URL the agent downloaded (downloadNotes).
 * normalizations: OP_DATA_WRAPPED of each op written without data (wrapData); the job written keeps the op as sent, its
 * document pinned in place, so the kernel wraps it the same way and its receipt lists the same entry.
 */
// fase4-28 r4-f3-import: the inline text of a document ({content, name?}), at most MAX_DOCUMENT_BYTES, read for pin (which
// writes it once, under <root>/documents/<sha256>/<name>, within the quota). -> {bytes, name} | {problem}.
function inlineDocument(owner, { kind, at, path: alsoPath }) {
  const label = kind === 'wsdl' ? 'WSDL' : 'OpenAPI document';
  if (typeof owner.content !== 'string' || owner.content.trim() === '')
    return { problem: problem('DOCUMENT_INLINE_INVALID', `the inline ${label} is not text`, '"content": "<the whole document as text>"', { path: at }) };
  if (alsoPath !== undefined && alsoPath !== null)
    return { problem: problem('DOCUMENT_INLINE_INVALID', `the ${label} has both "content" and "path"`, 'give one: the inline text ("content") or the file ("path")', { path: at }) };
  const bytes = Buffer.from(owner.content, 'utf8');
  if (bytes.length > MAX_DOCUMENT_BYTES) return { problem: problem('DOCUMENT_TOO_LARGE', `the inline ${label} has ${bytes.length} bytes, more than ${MAX_DOCUMENT_BYTES}`, 'use a document of at most 5 MB', { path: at }) };
  const fallback = kind === 'wsdl' ? 'service.wsdl' : 'openapi.json';
  const name = (typeof owner.name === 'string' ? path.basename(owner.name) : fallback).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '') || fallback;
  return { bytes, name };
}

export async function prepareIntegrationJob(jobFile, { lane = 'o11', words = '', localRoot, fetchImpl, destructive = true, grant = false, exposed = null,
  workspace = hostedContext()?.workspace ?? null, lookup = dns.lookup, quota = null, agent = hostedContext()?.executor ?? null } = {}) {
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
    // r40: the customer's agent, which downloads on the user's machine (agentFetcher); asked only when a URL is named.
    confine = { workspace: path.resolve(workspace), workspaceReal, lookup, quota: quota ?? createQuota(path.resolve(workspace)), agent: agentFetcher(agent) };
  }
  // r40: hosted (confine), no HTTP client at all: a URL goes to the customer's agent or is refused (the server never requests it).
  const client = confine ? null : fetchImpl ?? globalThis.fetch;
  const problems = [];
  // F7: every rule reads an op written without data as the kernel will (its document pinned, its remove and breaks named).
  const copy = structuredClone(document);
  const copyOps = opsOf(copy);
  const wrapped = wrapData(copyOps);
  const normalizations = wrapped.map(({ keys, ...entry }) => entry);
  if (destructive) problems.push(...(await destructiveProblems(copyOps, { words, grant, exposed })).problems);
  const documents = [];
  const written = [];
  let changed = false;
  const root = localRoot ?? path.join(path.dirname(jobFile), '.local');
  for (const [i, op] of copyOps.entries()) {
    if (!op || typeof op !== 'object' || !op.data || typeof op.data !== 'object') continue;
    if (op.op === 'soap' && lane === 'odc') {
      problems.push(problem('SOAP_LANE_UNSUPPORTED', 'soap: SOAP is not available on ODC (the platform consumes REST only)', 'consume the service through a REST facade (op rest), or an External Library that calls it', { path: `/ops/${i}` }));
      continue;
    }
    if (op.op === 'rest-consume') {
      // servidor/fase4-25: the same client as the documents (local, fetchImpl or the global fetch, as before).
      // fase4-28 r4-rest-hosted: for a hosted customer (confine) nothing is fetched at all, not even by the public-only client:
      // the server never calls an API a job names (rest-consume's hosted input mode, every sample inline; the gate refuses
      // the job first, hosted/policy.mjs restConsumeSampleRequired; this is the same rule where the request would be made).
      const sampled = await sampleRestConsume(op, i, { fetchImpl: client, hosted: Boolean(confine), agent: confine?.agent ?? null });
      problems.push(...sampled.problems);
      if (sampled.changed) changed = true;
      continue;
    }
    const slot = op.op === 'soap' ? { owner: op.data, key: 'wsdl', kind: 'wsdl' } : op.op === 'rest' && op.data.openapi && typeof op.data.openapi === 'object' ? { owner: op.data.openapi, key: 'path', kind: 'openapi' } : null;
    if (!slot) continue;
    let value = slot.owner[slot.key];
    // fase4-28 r4-f3-import: an inline document is written once to the documents folder and read from there like a file.
    const inlineOwner = slot.kind === 'wsdl' ? (value && typeof value === 'object' && !Array.isArray(value) ? value : null) : op.data.openapi;
    const inlined = !!inlineOwner && Object.hasOwn(inlineOwner, 'content');
    let inline = null;
    if (inlined) {
      inline = inlineDocument(inlineOwner, { kind: slot.kind, at: `/ops/${i}/data/${slot.kind === 'wsdl' ? 'wsdl' : 'openapi'}/content`, path: inlineOwner.path });
      if (inline.problem) { problems.push(inline.problem); continue; }
      delete inlineOwner.content; delete inlineOwner.name;
      value = 'inline';
      changed = true;
    }
    const source = typeof value === 'string' ? value : value && typeof value === 'object' && typeof value.path === 'string' && !value.sha256 ? value.path : null;
    if (!source) continue; // already pinned ({path, sha256}) or absent: the kernel judges it
    const at = inline ? `/ops/${i}/data/${slot.kind === 'wsdl' ? 'wsdl' : 'openapi'}/content` : `/ops/${i}/data/${slot.kind === 'wsdl' ? 'wsdl' : 'openapi/path'}`;
    const pinned = await pin(source, { kind: slot.kind, localRoot: root, fetchImpl: client, at, jobDir: path.dirname(path.resolve(jobFile)), confine, inline, written });
    if (pinned.unchanged) continue;
    if (pinned.problems) { problems.push(...pinned.problems); continue; }
    documents.push(...pinned.files);
    if (inlined) pinned.document.source = 'inline';
    if (slot.kind === 'wsdl') op.data.wsdl = pinned.document;
    else Object.assign(op.data.openapi, { path: pinned.document.path, sha256: pinned.document.sha256, source: pinned.document.source, ...(pinned.document.external ? { external: { ...(op.data.openapi.external ?? {}), ...pinned.document.external } } : {}) });
    changed = true;
  }
  if (addBinaryDataReference(copyOps, lane)) changed = true;
  if (problems.length) {
    // review M1: a refused job leaves none of the documents this call pinned (the ones already there stay).
    for (const file of written) { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } }
    for (const dir of [...new Set(written.map(file => path.dirname(file)))].sort((a, b) => b.length - a.length))
      for (let d = dir; d.startsWith(path.join(root, 'documents')) && d !== path.join(root, 'documents'); d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }
    const codes = [...new Set(problems.map(p => p.code))];
    // r40: what the agent downloaded before the refusal is listed too (nothing of it was pinned).
    const fetched = downloadNotes(confine?.agent?.downloads);
    return { ok: false, code: codes.length === 1 ? codes[0] : codes.includes('INTEGRATION_DELETE_WORDS') ? 'INTEGRATION_DELETE_WORDS' : codes[0],
      error: problems.map(p => p.message).join(' | ').slice(0, 900) + '. Nothing was captured or sent.', problems, ...(normalizations.length ? { normalizations } : {}), ...(fetched.length ? { notes: fetched } : {}) };
  }
  // r40: notes, one per URL the customer's agent downloaded (DOCUMENT_DOWNLOADED_BY_AGENT); every caller lists them on its answer.
  const notes = downloadNotes(confine?.agent?.downloads);
  const noted = notes.length ? { notes } : {};
  if (!changed) return { ok: true, job: jobFile, changed: false, documents, ...(normalizations.length ? { normalizations } : {}), ...noted };
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
  // After the names above, which read an op with its data: the job written keeps the op as it was sent.
  unwrapData(copyOps, wrapped);
  const text = JSON.stringify(copy, null, 2);
  const target = path.join(folder, sha256(text) + '.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  return { ok: true, job: target, changed: true, documents, ...(normalizations.length ? { normalizations } : {}), ...noted };
}
