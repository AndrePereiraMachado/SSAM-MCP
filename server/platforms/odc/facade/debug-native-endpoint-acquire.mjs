// Read-only acquisition of the original published REST description. Business
// routes, credentials and caller-supplied metadata URLs are never fetched here.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { parse } from 'acorn';
import { compileNativeRestEndpoint, nativeEndpointBinding } from './debug-native-endpoint.mjs';

const fail = code => { throw new Error('debug_native_endpoint_' + code); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const KEY = /^[A-Za-z0-9_+]{22}$/;

async function getDescription(url, fetchImpl, accept, maxBytes) {
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit',
    headers: { Accept: accept }, signal: AbortSignal.timeout(30000) });
  if (!response.ok || response.url && response.url !== url) fail('description_unavailable');
  const chunks = []; let length = 0;
  const reader = response.body?.getReader(); if (!reader) fail('description_unavailable');
  while (true) {
    const next = await reader.read(); if (next.done) break;
    length += next.value.byteLength;
    if (length > maxBytes) { await reader.cancel(); fail('contract_size_limit'); }
    chunks.push(Buffer.from(next.value));
  }
  return { body: Buffer.concat(chunks).toString('utf8'), contentType: response.headers.get('content-type') ?? '' };
}

export function publishedRestDescriptionUrl(html, documentationUrl) {
  // Parse inert HTML and JS literals only. No scripts, handlers or resources run.
  const dom = new JSDOM(html), candidates = new Set();
  const base = new URL(documentationUrl);
  const consider = text => {
    if (typeof text !== 'string' || !/(?:swagger|openapi)\.json$/i.test(text)) return;
    let url; try { url = new URL(text, base); } catch { return; }
    if (url.origin === base.origin && url.pathname.startsWith(base.pathname) && !url.username && !url.password &&
        !url.search && !url.hash && !/%(?:2e|2f|5c)/i.test(url.pathname)) candidates.add(url.href);
  };
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Literal') consider(node.value);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value?.type) visit(value);
  };
  try {
    for (const element of dom.window.document.querySelectorAll('[href], [value], [data-url]'))
      for (const name of ['href', 'value', 'data-url']) consider(element.getAttribute(name));
    for (const script of dom.window.document.querySelectorAll('script:not([src])')) {
      try { visit(parse(script.textContent, { ecmaVersion: 'latest', sourceType: 'script' })); } catch { /* No execution fallback. */ }
    }
  } finally { dom.window.close(); }
  if (candidates.size !== 1) fail('description_url_unresolved');
  return [...candidates][0];
}

export async function acquireNativeRestEntry({ binding: rawBinding, entry, readTree, sourceContract }, { fetchImpl = fetch } = {}) {
  const binding = nativeEndpointBinding(rawBinding);
  const guard = () => {
    if (typeof sourceContract?.sha256 !== 'string' || sourceContract.sha256.toLowerCase() !== binding.sourceSha256 || !sourceContract.path ||
        sha(fs.readFileSync(sourceContract.path)) !== binding.sourceSha256) fail('source_changed');
  };
  guard();
  if (!KEY.test(entry?.key ?? '') || typeof entry.path !== 'string' || typeof readTree !== 'function') fail('model_entry_unresolved');
  const parts = entry.path.split('/'), serviceAt = parts.findIndex(part => part.startsWith('RestService:'));
  if (serviceAt < 0 || serviceAt !== parts.length - 2 || !parts.at(-1).startsWith('RestServiceAction:')) fail('model_entry_unresolved');
  const read = await readTree(parts.slice(0, serviceAt + 1).join('/'));
  guard();
  const model = read?.schema === 'ssam-reading/1' ? read : {
    schema: 'ssam-reading/1', sourceSha256: binding.sourceSha256, model: binding.module, tree: read?.tree ?? read,
  };
  if (typeof model.sourceSha256 !== 'string' || model.sourceSha256.toLowerCase() !== binding.sourceSha256 || model.model !== binding.module || model.tree?.kind !== 'RestService') fail('model_binding_invalid');
  // Platform restriction stated by the hash-bound model: the SSAM caller is outside the internal network. Zero network.
  if (model.tree.properties?.InternalAccess === 'Yes') fail('internal_access_only');
  const base = new URL(binding.runtimeUrl);
  let service;
  try { service = new URL(model.tree.properties?.URL, base); } catch { fail('model_url_unavailable'); }
  if (typeof model.tree.properties?.URL !== 'string' || service.protocol !== 'https:' || service.origin !== base.origin ||
      !service.pathname.startsWith(base.pathname + 'rest/') || service.search || service.hash || service.username || service.password ||
      /%(?:2e|2f|5c)|[{}\\\x00-\x20]/i.test(service.pathname)) fail('url_outside_publication');
  if (/^(?:No|False|Hide)$/i.test(model.tree.properties.ShowDocumentation ?? '') ||
      model.tree.children?.some(node => node.kind === 'RestServiceAction' && node.properties?.HTTPMethod === 'GET' &&
        /^\/?$/.test(node.properties?.URLPath ?? '_'))) fail('description_unavailable');
  // Native documentation is published at the service base URL. Follow only its
  // observed local Swagger/OpenAPI link; do not enumerate guessed paths.
  const documentationUrl = service.href.replace(/\/$/, '') + '/';
  const documentation = await getDescription(documentationUrl, fetchImpl, 'text/html, application/json', 2 * 1024 * 1024);
  let url = documentationUrl, body = documentation.body;
  if (!/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(documentation.contentType)) {
    if (!/^text\/html(?:;|$)/i.test(documentation.contentType)) fail('description_unavailable');
    url = publishedRestDescriptionUrl(body, documentationUrl);
    const description = await getDescription(url, fetchImpl, 'application/json', 8 * 1024 * 1024);
    if (!/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(description.contentType)) fail('description_unavailable');
    body = description.body;
  }
  guard();
  const contract = { binding, entryKey: entry.key, model, source: { url, body, sha256: sha(body) } };
  return { contract, plan: compileNativeRestEndpoint(contract) };
}
