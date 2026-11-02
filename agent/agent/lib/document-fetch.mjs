// document.fetch (0.3.12, r40): one integration document (a WSDL, an XSD it imports, an OpenAPI document, the JSON answer of
// a rest-consume sample GET) downloaded HERE, on the user's machine, for a hosted SSAM server that never makes a network
// request for what a job names (integration-documents.mjs of the server line). The user's network (an intranet this machine
// reaches included) is the user's intent; the server pins the bytes it gets back as it pins a document read by URL locally.
//
// What the server can ask, and nothing else:
//   params {url, accept: 'xml'|'json', maxBytes?, timeoutMs?, sameOrigin?}. Only http: and https: URLs, without user or password; one GET
//   with no cookies, no credentials and no header of the server (only accept and this agent's user-agent); at most 5 MB
//   (maxBytes, 1..5 MB) and 30 s (timeoutMs, 1..30 s, and never past the call's deadline); redirects followed here, at most
//   5, each to an http(s) URL again (never file: or another scheme). The answer must be a document: accept 'xml' an XML text
//   (first sign '<') without <!DOCTYPE or <!ENTITY, accept 'json' a JSON text. A final status that is not 2xx answers its
//   status with no content (the agent never relays an error page).
//   Review of r40 (findings 1 and 2): sameOrigin true (what a downloaded document names) keeps every redirect on the origin
//   asked; a link-local address (169.254.0.0/16, fe80::/10, fd00:ec2::254: the cloud metadata of the machine) or a metadata
//   name is never requested, by the URL, a redirect or a name that resolves there (checked before each request); a redirect
//   never moves from another host into this machine's loopback. The user's own intranet stays reachable.
//   -> {finalUrl, status, contentType, bytes, sha256, contentBase64}.
// Refusals (executed:false: a GET leaves nothing on this machine): PARAMS_INVALID,
// DOCUMENT_FETCH_URL_REFUSED, DOCUMENT_FETCH_REDIRECT_REFUSED, DOCUMENT_FETCH_TOO_LARGE, DOCUMENT_FETCH_UNSAFE_XML,
// DOCUMENT_FETCH_NOT_DOCUMENT, DOCUMENT_FETCH_FAILED. The same rules, codes and protocol cases as the native core
// (native/Ssam.Agent/DocumentFetch.cs; tests/native-protocol/document-fetch-cases.json).
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { refuse } from './errors.mjs';

export const DOCUMENT_FETCH_KIND = 'document.fetch';
export const DOCUMENT_FETCH_LIMITS = Object.freeze({ maxBytes: 5 * 1024 * 1024, timeoutMs: 30000, maxRedirects: 5 });
export const DOCUMENT_FETCH_USER_AGENT = 'SSAM-Agent document fetch';
const ACCEPT = Object.freeze({ xml: 'application/xml, text/xml, application/wsdl+xml, */*;q=0.1', json: 'application/json, */*;q=0.1' });
const REDIRECT = new Set([301, 302, 303, 307, 308]);

const invalid = message => refuse('PARAMS_INVALID', message);

// Link-local (the cloud metadata of the machine) and loopback, by address: IPv4, IPv4-mapped IPv6 in both spellings, IPv6.
const METADATA_NAMES = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal']);
const v4Of = address => {
  const a = String(address).toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) return a;
  const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return mapped[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hex) { const h = parseInt(hex[1], 16), l = parseInt(hex[2], 16); return [h >> 8, h & 255, l >> 8, l & 255].join('.'); }
  return null;
};
export function linkLocal(address) {
  const v4 = v4Of(address);
  if (v4) return v4.startsWith('169.254.');
  const a = String(address).toLowerCase().replace(/^\[|\]$/g, '');
  if (!net.isIPv6(a)) return false;
  return /^fe[89ab][0-9a-f]:/.test(a) || a === 'fd00:ec2::254' || a === 'fd00:ec2:0:0:0:0:0:254';
}
export function loopback(address) {
  const v4 = v4Of(address);
  if (v4) return v4.startsWith('127.') || v4 === '0.0.0.0';
  const a = String(address).toLowerCase().replace(/^\[|\]$/g, '');
  return a === '::1' || a === '::' || a === 'localhost' || a.endsWith('.localhost');
}
// The host of a URL may be asked: never link-local or a metadata name, and a name that resolves to a link-local address is
// refused too (lookup: dns.lookup's signature with {all:true}). -> null | the reason.
async function hostProblem(url, lookup) {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (METADATA_NAMES.has(host) || linkLocal(host)) return 'its host is a link-local or metadata address, which is never requested';
  if (net.isIP(host.replace(/^\[|\]$/g, ''))) return null;
  let addresses = [];
  try { addresses = await new Promise((resolve, reject) => lookup(host, { all: true }, (error, list) => (error ? reject(error) : resolve(list)))); } catch { return null; }
  return addresses.some(a => linkLocal(a.address)) ? 'its name resolves to a link-local address, which is never requested' : null;
}

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
  const extra = Object.keys(params).filter(k => !['url', 'accept', 'maxBytes', 'timeoutMs', 'sameOrigin'].includes(k));
  if (extra.length) throw invalid('document.fetch takes only url, accept, maxBytes, timeoutMs and sameOrigin; not ' + extra.slice(0, 4).join(', '));
  if (params.sameOrigin !== undefined && typeof params.sameOrigin !== 'boolean') throw invalid('sameOrigin must be true or false');
  if (typeof params.url !== 'string' || params.url.length > 4096) throw invalid('url must be a text of at most 4096 characters');
  if (params.accept !== 'xml' && params.accept !== 'json') throw invalid("accept must be 'xml' or 'json'");
  const maxBytes = params.maxBytes ?? DOCUMENT_FETCH_LIMITS.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DOCUMENT_FETCH_LIMITS.maxBytes) throw invalid('maxBytes must be 1 to ' + DOCUMENT_FETCH_LIMITS.maxBytes);
  const timeoutMs = params.timeoutMs ?? DOCUMENT_FETCH_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > DOCUMENT_FETCH_LIMITS.timeoutMs) throw invalid('timeoutMs must be 1000 to ' + DOCUMENT_FETCH_LIMITS.timeoutMs);
  return { url: fetchableUrl(params.url), accept: params.accept, maxBytes, timeoutMs, sameOrigin: params.sameOrigin === true };
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
export function createDocumentFetch({ fetchImpl = globalThis.fetch, now = Date.now, lookup = dns.lookup } = {}) {
  return async function documentFetch(params, context = {}) {
    const plan = fetchPlan(params);
    const first = await hostProblem(plan.url, lookup);
    if (first) throw refuse('DOCUMENT_FETCH_URL_REFUSED', `${plan.url} was not requested: ${first}`);
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
          let target;
          try { target = fetchableUrl(next.toString(), 'the redirect'); } catch (error) { throw refuse('DOCUMENT_FETCH_REDIRECT_REFUSED', `GET ${url} redirected: ${error.message}`); }
          if (plan.sameOrigin && target.origin !== plan.url.origin) throw refuse('DOCUMENT_FETCH_REDIRECT_REFUSED', `GET ${url} redirected to another server (${target.origin}), and this download stays on ${plan.url.origin}`);
          if (loopback(target.hostname) && !loopback(url.hostname)) throw refuse('DOCUMENT_FETCH_REDIRECT_REFUSED', `GET ${url} redirected into this machine (${target.host}), which a redirect never does`);
          const refusedHop = await hostProblem(target, lookup);
          if (refusedHop) throw refuse('DOCUMENT_FETCH_REDIRECT_REFUSED', `GET ${url} redirected to ${target.host}: ${refusedHop}`);
          url = target;
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
