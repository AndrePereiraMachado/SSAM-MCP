// F1 "the receipt tells the truth" (2026-10-22): a delivery receipt never claims more than was proven. The levels are
// built -> validated -> merged -> published -> served; "served" means the environment serves the stylesheet the delivery
// wrote, read back over HTTP after the publication with every cache asked to revalidate.
//
// The elements and their stylesheets come from the kernel, never from the job's text: the apply result lists every block,
// screen or theme whose effective StyleSheet changed (styleSheets: key, kind, name, flow, flavor, the stylesheet of the base
// and of the candidate, the touch; StyleSheetTouch.cs), whatever wrote it and whatever the target form. The candidate's
// text is the one the content proof holds equal to the delivered module (ThemeCss rewrites, hoisted @import included).
//
// What is compared: both texts reduced to one normal form (cssRules): comments dropped; one line per rule, nested at-rules
// (@media, @supports, @keyframes, ...) flattened with their preludes, whitespace collapsed, no space around , > + ~ and inside
// declarations, `! important` as `!important`, hex colours lowercased, url(...) reduced to its file name. The delta of the
// element (rules added and removed between the base and the candidate) is what must reach the served file:
//   - an element's own file (a Traditional block's .css): served true when it holds exactly the candidate's rules; false
//     when it holds exactly the base's, or the same rules as before the publication;
//   - a shared file (theme, extra stylesheet) or a page (a Traditional screen): read before and after the publication; true
//     when each rule of the delta changed its count by the delta, so the rules of other elements never decide; false when
//     the file did not change and the delta is not there (never for a page, which may be a sign-in page); anything else
//     "unverified".
// A cache at the exact URL that is older than the origin (a second read with a query naming the delivery) is "unverified"
// with that note, never "stale"; an answer that is not text/css (a page: text/html) is "unverified".
//
// Where the read runs: only in the person's own SSAM (the stdio entry, runStdio, hands the reader to the O11 cycle); every
// other way this facade is built (a hosted server among them) has none and answers "unverified" (SERVED_READ_UNAVAILABLE).
// The fetch goes only to https://<the environment the delivery targets>, carries no cookie, authorization or user info,
// follows no redirect, reads at most MAX_BYTES while streaming and stays inside one time budget per delivery.
import { createHash } from 'node:crypto';

export const SERVED_SCHEMA = 'ssam-served-proof/1';
export const SERVED_COMPARED = 'Each changed stylesheet of the delivered module against the CSS the environment serves for its element, both in one normal form '
  + '(comments dropped, one line per rule, whitespace collapsed, url() reduced to its file name): an element\'s own file must hold its rules; a shared file or a page '
  + 'must change, between before and after the publication, by exactly the rules the delivery added and removed.';
// What the agent on the person's machine would need for a hosted server to read the served stylesheets (said once, to the owner).
export const AGENT_NEEDS = 'An agent verb http_get {url, accept:"text/css,text/html", noCache:true, maxBytes:2097152, timeoutMs:15000} that runs on the person\'s machine, '
  + 'refuses any URL outside the origin of the environment the delivery targets, sends no cookie or authorization, follows no redirect and answers {status, contentType, location?, sha256, text}.';
export const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15000;
export const BUDGET_MS = 45000;
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const clip = (text, max = 200) => { const s = String(text ?? ''); return s.length > max ? s.slice(0, max - 3) + '...' : s; };

// ---- The elements, from the kernel's apply result (styleSheets).
const INTERFACE = { traditional: { block: 'IWebBlock', screen: 'IWebScreen', theme: 'IWebTheme' }, reactive: { block: 'IMobileBlock', screen: 'IMobileScreen', theme: 'IMobileTheme' } };
export function elementsOfKernel(styleSheets) {
  return (Array.isArray(styleSheets) ? styleSheets : []).filter(e => e && typeof e === 'object' && typeof e.name === 'string' && ['block', 'screen', 'theme'].includes(e.kind))
    .map(e => ({ target: (INTERFACE[e.flavor === 'traditional' ? 'traditional' : 'reactive'][e.kind]) + ':' + e.name, key: e.key ?? null, kind: e.kind, name: e.name,
      flow: e.flow ?? null, flavor: e.flavor === 'traditional' ? 'traditional' : 'reactive', base: String(e.baseStyleSheet ?? ''), delivered: String(e.styleSheet ?? ''),
      touch: e.touch ?? null, untouched: e.touch ? null : e.reason ?? null }));
}
// Whether a job writes a stylesheet at all (any target form, or CSS inside an html op): such a job never has served:null.
export function jobWritesStyleSheets(document) {
  const ops = Array.isArray(document) ? document : Array.isArray(document?.ops) ? document.ops : [];
  return ops.some(op => (op?.op === 'set' && op.prop === 'StyleSheet') || op?.op === 'css' || (op?.op === 'html' && /<style\b|"css"/i.test(JSON.stringify(op.data ?? op))));
}

// ---- The normal form.
function stripComments(text) {
  let out = '', quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { out += c; if (c === '\\') { out += text[++i] ?? ''; } else if (c === quote) quote = null; continue; }
    if (c === '"' || c === '\'') { quote = c; out += c; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; out += ' '; continue; }
    out += c;
  }
  return out;
}
const collapse = text => text.replace(/\s+/g, ' ').trim();
const selectorForm = text => collapse(text).replace(/\s*([,>+~])\s*/g, '$1');
const urlForm = value => value.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (_, __, url) => 'url(' + (url.split(/[?#]/)[0].split('/').pop() ?? '') + ')');
const preludeForm = text => collapse(text).replace(/\s*([(:),])\s*/g, '$1');
function declarationsForm(text) {
  const parts = []; let depth = 0, quote = null, current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { current += c; if (c === '\\') current += text[++i] ?? ''; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === '\'') { quote = c; current += c; continue; }
    if (c === '(') depth++; else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ';' && depth === 0) { parts.push(current); current = ''; continue; }
    current += c;
  }
  parts.push(current);
  return parts.map(p => {
    const at = p.indexOf(':');
    if (at < 0) return collapse(p);
    const name = collapse(p.slice(0, at)).toLowerCase();
    const value = urlForm(collapse(p.slice(at + 1)).replace(/\s*!\s*important$/i, '!important').replace(/\s*([,/])\s*/g, '$1').replace(/#([0-9a-f]{3,8})\b/gi, (m, hex) => '#' + hex.toLowerCase()));
    return name + ':' + value;
  }).filter(Boolean).join(';');
}
// At-rules whose block holds rules (flattened with their prelude) rather than declarations.
const NESTED = /^@(-[a-z]+-)?(media|supports|container|layer|document|keyframes)\b/i;
// The rules of a stylesheet, each as one normal line.
export function cssRules(text, prefix = '') {
  const source = stripComments(String(text ?? '').replace(/^﻿/, ''));
  const rules = []; let i = 0;
  const readUntil = stops => { let out = '', quote = null, depth = 0; for (; i < source.length; i++) {
    const c = source[i];
    if (quote) { out += c; if (c === '\\') out += source[++i] ?? ''; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === '\'') { quote = c; out += c; continue; }
    if (c === '(') depth++; else if (c === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && stops.includes(c)) break;
    out += c;
  } return out; };
  const block = () => { let depth = 1, out = '', quote = null; i++; for (; i < source.length; i++) {
    const c = source[i];
    if (quote) { out += c; if (c === '\\') out += source[++i] ?? ''; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === '\'') { quote = c; out += c; continue; }
    if (c === '{') depth++; else if (c === '}' && --depth === 0) { i++; break; }
    out += c;
  } return out; };
  while (i < source.length) {
    const head = readUntil(['{', ';', '}']);
    if (i >= source.length) { if (collapse(head)) rules.push(prefix + urlForm(collapse(head))); break; }
    const stop = source[i];
    if (stop === ';' || stop === '}') { i++; const statement = collapse(head); if (statement) rules.push(prefix + urlForm(statement)); continue; }
    const body = block();
    const selector = collapse(head);
    if (NESTED.test(selector)) { rules.push(...cssRules(body, prefix + preludeForm(selector) + ' >> ')); continue; }
    const declarations = declarationsForm(body);
    if (!declarations) continue;
    rules.push(prefix + (selector.startsWith('@') ? preludeForm(selector) : selectorForm(selector)) + '{' + declarations + '}');
  }
  return rules;
}
export function normalizeCss(text) { return cssRules(text).join('\n'); }
const counts = rules => { const m = new Map(); for (const r of rules) m.set(r, (m.get(r) ?? 0) + 1); return m; };
const sameSequence = (a, b) => a.length === b.length && a.every((r, n) => r === b[n]);
// The delta of an element: each rule whose count differs between the base and the candidate, with the change.
export function cssDelta(base, delivered) {
  const b = counts(cssRules(base)), d = counts(cssRules(delivered));
  const delta = new Map();
  for (const rule of new Set([...b.keys(), ...d.keys()])) { const change = (d.get(rule) ?? 0) - (b.get(rule) ?? 0); if (change !== 0) delta.set(rule, change); }
  return delta;
}

// Pure: the verdict of one element. kind 'own' (the element's own file), 'shared' or 'page'; served and before are texts
// (before null when it could not be read). {served: true|false|'unverified', reason?, firstMissing?, ...hashes}.
export function judgeServed({ base, delivered, served, before = null, kind = 'shared' }) {
  const expected = cssRules(delivered), old = cssRules(base), now = cssRules(served);
  const hashes = { expectedSha256: sha256(expected.join('\n')), servedSha256: sha256(now.join('\n')) };
  const delta = cssDelta(base, delivered);
  if (delta.size === 0) return { served: 'unverified', reason: 'SERVED_NOTHING_TO_COMPARE', ...hashes };
  const missing = () => { const c = counts(now); const first = [...delta].find(([rule, change]) => change > 0 ? (c.get(rule) ?? 0) < (counts(expected).get(rule) ?? 0) : (c.get(rule) ?? 0) > 0); return first ? clip((first[1] > 0 ? '' : 'removed rule still served: ') + first[0]) : null; };
  if (kind === 'own') {
    if (sameSequence(now, expected)) return { served: true, ...hashes };
    const firstMissing = missing();
    if (sameSequence(now, old)) return { served: false, firstMissing, ...hashes };
    if (before != null && sameSequence(now, cssRules(before))) return { served: false, firstMissing, unchanged: true, ...hashes };
    return { served: 'unverified', reason: 'SERVED_DIFFERENT', firstMissing, ...hashes };
  }
  if (before == null) return { served: 'unverified', reason: 'SERVED_NO_BASELINE', ...hashes };
  const was = counts(cssRules(before)), is = counts(now);
  const reflected = [...delta].every(([rule, change]) => (is.get(rule) ?? 0) - (was.get(rule) ?? 0) === change);
  if (reflected) return { served: true, ...hashes };
  const unchanged = sameSequence(now, cssRules(before));
  if (kind !== 'page' && unchanged) return { served: false, firstMissing: missing(), unchanged: true, ...hashes };
  return { served: 'unverified', reason: kind === 'page' ? 'SERVED_PAGE_UNPROVEN' : 'SERVED_DELTA_PARTIAL', ...hashes };
}

// ---- Where each element is served (origin: https://<environment>; module: the URL path of the module).
export function servedUrls(element, { origin, module, theme = null }) {
  const m = encodeURIComponent(module);
  if (element.flavor === 'traditional') {
    if (element.kind === 'block') return element.flow ? [{ url: origin + '/' + m + '/Blocks/' + m + '/' + encodeURIComponent(element.flow) + '/' + encodeURIComponent(element.name) + '.css', kind: 'own' }] : [];
    if (element.kind === 'theme') return [{ url: origin + '/' + m + '/Theme.' + encodeURIComponent(element.name) + '.css', kind: 'shared' }];
    return [{ url: origin + '/' + m + '/' + encodeURIComponent(element.name) + '.aspx', kind: 'page' }];
  }
  if (element.kind === 'theme') return [{ url: origin + '/' + m + '/css/' + m + '.' + encodeURIComponent(element.name) + '.css', kind: 'shared' }];
  return theme ? [{ url: origin + '/' + m + '/css/' + m + '.' + encodeURIComponent(theme) + '.extra.css', kind: 'shared' }] : [];
}

// The origin of the environment a delivery targets: a bare DNS name or an https origin; never credentials, a path or a query.
export function environmentOrigin(environment) {
  if (typeof environment !== 'string' || !environment.trim()) return null;
  try {
    const text = environment.trim();
    const url = new URL(text.includes('://') ? text : 'https://' + text);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) return null;
    return url.origin;
  } catch { return null; }
}

// The reader, given only by the person's own SSAM (runStdio). SSAM_SERVED_READ=off turns it off there too.
export function localServedReader({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (String(env.SSAM_SERVED_READ ?? '').toLowerCase() === 'off' || typeof fetchImpl !== 'function') return null;
  return fetchImpl;
}

async function bodyText(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) { const text = await response.text(); return Buffer.byteLength(text, 'utf8') > maxBytes ? null : text; }
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { try { await reader.cancel(); } catch { /* already closed */ } return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
// One bounded GET of a same-origin URL, without credentials and without following redirects.
export async function readServed(url, { origin, fetchImpl, deadline = Date.now() + TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'SERVED_URL_INVALID' }; }
  if (parsed.origin !== origin || parsed.username || parsed.password) return { ok: false, reason: 'SERVED_ORIGIN_REFUSED', refused: true };
  const left = Math.min(TIMEOUT_MS, deadline - Date.now());
  if (left <= 0) return { ok: false, reason: 'SERVED_BUDGET_SPENT' };
  let response;
  try {
    response = await fetchImpl(parsed.href, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      headers: { accept: 'text/css,text/html;q=0.9,*/*;q=0.1', 'cache-control': 'no-cache', pragma: 'no-cache' }, signal: AbortSignal.timeout(left) });
  } catch (error) { return { ok: false, reason: 'SERVED_UNREACHABLE', detail: clip(error?.message ?? error, 160) }; }
  const status = response.status ?? 0;
  if (status >= 300 && status < 400) return { ok: false, reason: 'SERVED_REDIRECTED', status };
  if (status !== 200) return { ok: false, reason: 'SERVED_HTTP_' + status, status };
  if (Number(response.headers?.get?.('content-length') ?? 0) > maxBytes) return { ok: false, reason: 'SERVED_TOO_LARGE', status };
  let text;
  try { text = await bodyText(response, maxBytes); } catch (error) { return { ok: false, reason: 'SERVED_UNREACHABLE', detail: clip(error?.message ?? error, 160) }; }
  if (text == null) return { ok: false, reason: 'SERVED_TOO_LARGE', status };
  return { ok: true, status, contentType: String(response.headers?.get?.('content-type') ?? ''), text };
}

// A page's own stylesheets: same-origin <link rel=stylesheet> hrefs and inline <style> blocks. Pure.
export function pageStyles(html, pageUrl, origin) {
  const links = [], inline = [];
  for (const tag of String(html).match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?stylesheet/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try { const url = new URL(href.replace(/&amp;/g, '&'), pageUrl); if (url.origin === origin) links.push(url.href); } catch { /* not a URL */ }
  }
  for (const match of String(html).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) inline.push(match[1]);
  return { links: [...new Set(links)], inline };
}

// The served text of one planned URL (a page: its own stylesheets joined, in document order).
async function servedText(plan, { origin, fetchImpl, deadline, query = '' }) {
  const read = await readServed(plan.url + query, { origin, fetchImpl, deadline });
  if (!read.ok) return read;
  if (plan.kind !== 'page') {
    if (!/text\/css/i.test(read.contentType) && (read.contentType || /^\s*<(!doctype|html)/i.test(read.text))) return { ok: false, reason: 'SERVED_NOT_CSS', status: read.status };
    return { ok: true, text: read.text };
  }
  if (!/text\/html/i.test(read.contentType)) return { ok: false, reason: 'SERVED_NOT_HTML', status: read.status };
  const { links, inline } = pageStyles(read.text, plan.url, origin);
  const parts = [];
  for (const link of links.slice(0, 40)) {
    const sheet = await readServed(link, { origin, fetchImpl, deadline });
    if (!sheet.ok) return { ok: false, reason: sheet.reason, status: sheet.status };
    if (/text\/css/i.test(sheet.contentType) || !sheet.contentType) parts.push(sheet.text);
  }
  return { ok: true, text: [...parts, ...inline].join('\n') };
}

function planOf(element, { origin, module, theme }) { return origin ? servedUrls(element, { origin, module, theme })[0] ?? null : null; }

// Before the publication: the served text of every shared file or page of the elements (the baseline of their delta).
export async function servedBaseline(elements, { environment, module, theme = null, reader, deadline = Date.now() + BUDGET_MS } = {}) {
  const origin = environmentOrigin(environment), baseline = new Map();
  if (!reader || !origin) return baseline;
  for (const element of elements ?? []) {
    const plan = planOf(element, { origin, module, theme });
    if (!plan || baseline.has(plan.url)) continue;
    const read = await servedText(plan, { origin, fetchImpl: reader, deadline });
    baseline.set(plan.url, read.ok ? read.text : null);
  }
  return baseline;
}

// After the publication: one verdict per element. Never throws; anything not proven is "unverified".
export async function proveServed(elements, { environment, module, theme = null, nonce = null, reader, baseline = new Map(), deadline = Date.now() + BUDGET_MS, owner = false } = {}) {
  if (!elements?.length) return null;
  const origin = environmentOrigin(environment);
  const unverified = (element, reason, extra = {}) => ({ element: element.target, kind: element.kind, served: 'unverified', reason, ...extra });
  const results = [];
  for (const element of elements) {
    if (!reader) { results.push(unverified(element, 'SERVED_READ_UNAVAILABLE')); continue; }
    if (!origin) { results.push(unverified(element, 'SERVED_ORIGIN_UNKNOWN')); continue; }
    const plan = planOf(element, { origin, module, theme });
    if (!plan) { results.push(unverified(element, 'SERVED_URL_UNKNOWN')); continue; }
    const served = await servedText(plan, { origin, fetchImpl: reader, deadline });
    if (!served.ok) { results.push(unverified(element, served.reason, { url: plan.url, ...(served.status ? { status: served.status } : {}), ...(served.refused ? { refused: true } : {}) })); continue; }
    const before = baseline.has(plan.url) ? baseline.get(plan.url) : null;
    const verdict = judgeServed({ base: element.base, delivered: element.delivered, served: served.text, before, kind: plan.kind });
    const entry = { element: element.target, kind: element.kind, url: plan.url, served: verdict.served, compared: plan.kind, expectedSha256: verdict.expectedSha256, servedSha256: verdict.servedSha256,
      ...(verdict.reason ? { reason: verdict.reason } : {}), ...(verdict.firstMissing ? { firstMissing: verdict.firstMissing } : {}) };
    // An older text at the exact URL while the origin (the same path with a query naming the delivery) has the new one: a
    // cache, not the platform: "unverified" with that note.
    if (verdict.served === false && nonce && plan.kind !== 'page') {
      const again = await servedText(plan, { origin, fetchImpl: reader, deadline, query: '?ssam-served=' + encodeURIComponent(nonce) });
      if (again.ok && judgeServed({ base: element.base, delivered: element.delivered, served: again.text, before, kind: plan.kind }).served === true)
        Object.assign(entry, { served: 'unverified', reason: 'SERVED_CACHE_OLDER', note: 'the origin serves the delivered stylesheet; a cache at this URL still has the older one' });
    }
    results.push(entry);
  }
  const status = results.some(r => r.served === false) ? false : results.every(r => r.served === true) ? true : 'unverified';
  const unavailable = results.some(r => r.reason === 'SERVED_READ_UNAVAILABLE');
  return { schema: SERVED_SCHEMA, served: status, compared: SERVED_COMPARED, elements: results, ...(owner && unavailable ? { agentNeeds: AGENT_NEEDS } : {}) };
}

// The levels a receipt may claim, each only when proven (served: true, false, "unverified"; null only without stylesheets).
export function levelsOf({ built = false, validated = false, merged = false, published = false, served = null } = {}) {
  return { built: built === true, validated: validated === true, merged: merged === true, published: published === true,
    served: published === true ? (served?.served ?? null) : null };
}

// ONE refusal for every element served older than delivered, with what SSAM already did for each (the touch of the
// delivery, or why none could reach it) and one next call: none of SSAM's calls makes the platform take it now (the
// delivery already carried the widget change), so the next call records the case for the person and the integrator.
export function servedRefusal(proof, { module, elements = [] }) {
  const stale = (proof?.elements ?? []).filter(e => e.served === false);
  const byTarget = new Map(elements.map(e => [e.target, e]));
  const remedy = target => { const e = byTarget.get(target); return e?.touch ? 'a widget of the element was changed in this delivery (' + (e.touch.name || '@' + e.touch.key) + ')'
    : e?.untouched ? 'no widget change could reach it: ' + e.untouched : 'unknown'; };
  const names = stale.map(e => e.element);
  return { ok: false, code: 'SERVED_STALE', failed: 'served',
    error: clip('Published, but ' + module + ' still serves an older stylesheet for ' + names.join(', ') + ': '
      + stale.map(e => e.element + ' expected sha256 ' + e.expectedSha256.slice(0, 12) + ', served ' + e.servedSha256.slice(0, 12)
        + (e.firstMissing ? ', first missing rule "' + clip(e.firstMissing, 80) + '"' : '')).join('; ') + '. Nothing was repeated.', 900),
    problems: stale.map(e => ({ element: e.element, property: 'StyleSheet', expected: e.expectedSha256, actual: e.servedSha256, url: e.url, remedy: remedy(e.element),
      ...(e.firstMissing ? { firstMissing: e.firstMissing } : {}) })),
    continuation: { tool: 'ssam_friction', arguments: { view: 'report', kind: 'defect', tool: 'o11_deliver', intent: 'Publish a stylesheet change of ' + module,
      attempted: clip('Delivered and published; the environment serves an older stylesheet for ' + names.join(', ') + ' (' + stale.map(e => remedy(e.element)).join('; ') + ').', 500),
      summary: 'A published stylesheet change is not served.' },
      why: 'The delivery already carried the widget change that makes a publication take an element\'s stylesheet, or none could reach the element, so another delivery would not change it: record the case; the person decides in Service Studio.' } };
}
