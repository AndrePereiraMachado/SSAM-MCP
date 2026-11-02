// document.fetch (0.3.11, r40): one integration document (a WSDL, an XSD it imports, an OpenAPI document, the JSON answer of
// a rest-consume sample GET) downloaded HERE, on the user's machine, for a hosted SSAM server that never makes a network
// request for what a job names (integration-documents.mjs of the server line). The user's network (an intranet this machine
// reaches included) is the user's intent; the server pins the bytes it gets back as it pins a document read by URL locally.
//
// What the server can ask, and nothing else:
//   params {url, accept: 'xml'|'json', maxBytes?, timeoutMs?}. Only http: and https: URLs, without user or password; one GET
//   with no cookies, no credentials and no header of the server (only accept and this agent's user-agent); at most 5 MB
//   (maxBytes, 1..5 MB) and 30 s (timeoutMs, 1..30 s, and never past the call's deadline); redirects followed here, at most
//   5, each to an http(s) URL again (never file: or another scheme). The answer must be a document: accept 'xml' an XML text
//   (first sign '<') without <!DOCTYPE or <!ENTITY, accept 'json' a JSON text. A final status that is not 2xx answers its
//   status with no content (the agent never relays an error page).
//   -> {finalUrl, status, contentType, bytes, sha256, contentBase64}.
// Refusals (executed:false: a GET leaves nothing on this machine): PARAMS_INVALID,
// DOCUMENT_FETCH_URL_REFUSED, DOCUMENT_FETCH_REDIRECT_REFUSED, DOCUMENT_FETCH_TOO_LARGE, DOCUMENT_FETCH_UNSAFE_XML,
// DOCUMENT_FETCH_NOT_DOCUMENT, DOCUMENT_FETCH_FAILED. The same rules, codes and protocol cases as the native core
// (native/Ssam.Agent/DocumentFetch.cs; tests/native-protocol/document-fetch-cases.json).
import { createHash } from 'node:crypto';
import { refuse } from './errors.mjs';

export const DOCUMENT_FETCH_KIND = 'document.fetch';
export const DOCUMENT_FETCH_LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, timeoutMs: 30000, maxRedirects: 5 });
export const DOCUMENT_FETCH_USER_AGENT = 'SSAM-Agent document fetch';
const ACCEPT = Object.freeze({ xml: 'application/xml, text/xml, application/wsdl+xml, */*;q=0.1', json: 'application/json, */*;q=0.1' });
const REDIRECT = new Set([301, 302, 303, 307, 308]);

const invalid = message => refuse('PARAMS_INVALID', message);

// The URL a request may go to: http(s), no user or password. -> URL | throws DOCUMENT_FETCH_URL_REFUSED.
export function fetchableUrl(text, what = 'url') {
  let url;
  try { url = new URL(String(text ?? '')); } catch { throw refuse('DOCUMENT_FETCH_URL_REFUSED', `${what} is not a URL`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw refuse('DOCUMENT_FETCH_URL_REFUSED', `${what} uses ${url.protocol.replace(/:$/, '')}: only http and https are downloaded`);
  if (url.username || url.password) throw refuse('DOCUMENT_FETCH_URL_REFUSED', `${what} carries a user or password: the agent never sends credentials`);
  url.hash = '';
  return url;
}

// The parameters, checked before any request. -> {url, accept, maxBytes, timeoutMs}.
export function fetchPlan(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params must be an object');
  const extra = Object.keys(params).filter(k => !['url', 'accept', 'maxBytes', 'timeoutMs'].includes(k));
  if (extra.length) throw invalid('document.fetch takes only url, accept, maxBytes and timeoutMs; not ' + extra.slice(0, 4).join(', '));
  if (typeof params.url !== 'string' || params.url.length > 4096) throw invalid('url must be a text of at most 4096 characters');
  if (params.accept !== 'xml' && params.accept !== 'json') throw invalid("accept must be 'xml' or 'json'");
  const maxBytes = params.maxBytes ?? DOCUMENT_FETCH_LIMITS.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DOCUMENT_FETCH_LIMITS.maxBytes) throw invalid('maxBytes must be 1 to ' + DOCUMENT_FETCH_LIMITS.maxBytes);
  const timeoutMs = params.timeoutMs ?? DOCUMENT_FETCH_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > DOCUMENT_FETCH_LIMITS.timeoutMs) throw invalid('timeoutMs must be 1000 to ' + DOCUMENT_FETCH_LIMITS.timeoutMs);
  return { url: fetchableUrl(params.url), accept: params.accept, maxBytes, timeoutMs };
}

// Whether the bytes are the document asked for (see the header). -> null | the refusal.
export function documentProblem(bytes, accept) {
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  if (accept === 'xml') {
    if (!/^\s*</.test(text)) return refuse('DOCUMENT_FETCH_NOT_DOCUMENT', 'the answer is not an XML document');
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) return refuse('DOCUMENT_FETCH_UNSAFE_XML', 'the XML declares a DTD or ENTITY, which is never downloaded');
    return null;
  }
  try { JSON.parse(text); return null; } catch { return refuse('DOCUMENT_FETCH_NOT_DOCUMENT', 'the answer is not a JSON document'); }
}

// The body, at most max bytes (a larger one is cut and refused, never kept).
async function bodyOf(response, max) {
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (declared > max) { try { await response.body?.cancel?.(); } catch { /* not read */ } throw refuse('DOCUMENT_FETCH_TOO_LARGE', `the document declares ${declared} bytes, more than ${max}`); }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > max) throw refuse('DOCUMENT_FETCH_TOO_LARGE', `the document has more than ${max} bytes`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch { /* cut */ } throw refuse('DOCUMENT_FETCH_TOO_LARGE', `the document has more than ${max} bytes`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The kind. fetchImpl: Node's fetch (never the channel's client to the server); now: the clock of context.deadline. */
export function createDocumentFetch({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  return async function documentFetch(params, context = {}) {
    const plan = fetchPlan(params);
    const left = Number.isFinite(context?.deadline) ? context.deadline - now() : Infinity;
    const budget = Math.min(plan.timeoutMs, left);
    if (!(budget > 0)) throw refuse('DOCUMENT_FETCH_FAILED', 'the call\'s deadline has passed; nothing was requested');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    let url = plan.url;
    try {
      for (let hop = 0; ; hop++) {
        let response;
        try {
          response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
            headers: { accept: ACCEPT[plan.accept], 'user-agent': DOCUMENT_FETCH_USER_AGENT } });
        } catch (error) {
          throw refuse('DOCUMENT_FETCH_FAILED', `GET ${url} failed: ${controller.signal.aborted ? `no answer in ${Math.round(budget / 1000)} s` : String(error?.cause?.code ?? error?.message ?? error).split('\n')[0].slice(0, 200)}`);
        }
        if (REDIRECT.has(response.status)) {
          const location = response.headers?.get?.('location');
          try { await response.body?.cancel?.(); } catch { /* not read */ }
          if (!location) throw refuse('DOCUMENT_FETCH_REDIRECT_REFUSED', `GET ${url} answered ${response.status} without a Location`);
          if (hop >= DOCUMENT_FETCH_LIMITS.maxRedirects) throw refuse('DOCUMENT_FETCH_REDIRECT_REFUSED', `GET ${plan.url} was redirected more than ${DOCUMENT_FETCH_LIMITS.maxRedirects} times`);
          let next;
          try { next = new URL(location, url); } catch { throw refuse('DOCUMENT_FETCH_REDIRECT_REFUSED', `GET ${url} redirected to a text that is not a URL`); }
          try { url = fetchableUrl(next.toString(), 'the redirect'); } catch (error) { throw refuse('DOCUMENT_FETCH_REDIRECT_REFUSED', `GET ${url} redirected: ${error.message}`); }
          continue;
        }
        const contentType = String(response.headers?.get?.('content-type') ?? '').slice(0, 200);
        if (response.status < 200 || response.status > 299) {
          try { await response.body?.cancel?.(); } catch { /* not read */ }
          return { finalUrl: url.toString(), status: response.status, contentType, bytes: 0, sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'), contentBase64: '' };
        }
        let bytes;
        try { bytes = await bodyOf(response, plan.maxBytes); }
        catch (error) {
          if (error?.code) throw error;
          throw refuse('DOCUMENT_FETCH_FAILED', `GET ${url} failed while reading: ${controller.signal.aborted ? `no answer in ${Math.round(budget / 1000)} s` : String(error?.message ?? error).slice(0, 200)}`);
        }
        const wrong = documentProblem(bytes, plan.accept);
        if (wrong) throw wrong;
        return { finalUrl: url.toString(), status: response.status, contentType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), contentBase64: bytes.toString('base64') };
      }
    } finally { clearTimeout(timer); }
  };
}
