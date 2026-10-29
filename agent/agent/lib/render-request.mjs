// screen.render (docs/FASE2-AGENTE.md 4.4): the pure checks of a request (ssam-render-request/1) and of the facts the render
// worker returns (ssam-render-facts/1). No import outside agent/lib; the same rules, limits and codes are
// native/Ssam.Agent/RenderRequest.cs (tests/native/render.test.mjs compares both on one table).
// A request is refused before anything runs (executed:false): RENDER_REQUEST_INVALID for its shape and limits,
// RENDER_DOCUMENT_REFUSED for a document or a style sheet that names a script, a frame, an object, a link, a base, a
// meta http-equiv, an on<event> attribute, srcdoc, a javascript: or vbscript: URL, or an http(s), file, ftp, // or \\
// address in a URL attribute, a CSS url() or an @import. Text of the screen that contains a URL is fine. These checks are
// a diagnostic: the barrier is the worker's sandbox (no script, no network, src/main/render/worker.mjs).
import { createHash } from 'node:crypto';
import { AgentError } from './errors.mjs';

export const RENDER_KIND = 'screen.render';
export const REQUEST_SCHEMA = 'ssam-render-request/1';
export const FACTS_SCHEMA = 'ssam-render-facts/1';
export const RENDER_PROTOCOL = 1;
const MiB = 1024 * 1024;
export const RENDER_LIMITS = Object.freeze({ documents: 8, htmlBytes: 4 * MiB, styles: 16, cssBytes: 2 * MiB, packageBytes: 12 * MiB, viewports: 3,
  minWidth: 320, maxWidth: 2560, minHeight: 480, maxHeight: 4096, bodyClasses: 8, keys: 400, properties: 24, maxElements: 3000, defaultMaxElements: 1500,
  minQuality: 40, maxQuality: 90, minEdge: 320, maxEdge: 1920, minTimeoutMs: 5000, maxTimeoutMs: 90000, defaultTimeoutMs: 60000,
  images: 9, imageBytes: MiB, valueBytes: 12 * MiB, styleText: 200, fonts: 50, fontName: 100, errors: 50 });
export const RENDER_PROPERTIES = Object.freeze(['display', 'position', 'visibility', 'opacity', 'white-space', 'overflow', 'overflow-x', 'overflow-y',
  'width', 'height', 'min-width', 'max-width', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right',
  'padding-bottom', 'padding-left', 'font-size', 'font-family', 'line-height', 'text-overflow', 'z-index', 'flex-direction', 'flex-wrap', 'flex-grow',
  'flex-shrink', 'flex-basis', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'box-sizing', 'top', 'left', 'color',
  'background-color', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']);
export const RENDER_ERROR_CODES = Object.freeze(['LOAD_FAILED', 'MEASURE_FAILED', 'RENDER_TIMEOUT', 'IMAGE_FAILED']);
const ID = /^[a-z0-9-]{1,40}$/;
const KEY = /^[A-Za-z0-9_-]{1,80}$/;
const CLASS = /^[A-Za-z_-][A-Za-z0-9_-]{0,63}$/;
const TAG = /^[a-z][a-z0-9-]{0,40}$/;
const SHA = /^[0-9a-f]{64}$/;
const URL_ATTRIBUTES = new Set(['href', 'src', 'srcset', 'imagesrcset', 'action', 'formaction', 'poster', 'background', 'data', 'cite', 'longdesc', 'usemap',
  'manifest', 'ping', 'xlink:href', 'lowsrc', 'dynsrc', 'codebase', 'icon', 'profile']);
const FORBIDDEN_URL = /^(?:https?:|file:|ftp:|\/\/|\\\\)/i;
const FORBIDDEN_TAG = /<(?:script|iframe|frame|object|embed|link|base)/i;
const META_REFRESH = /<meta[^>]*http-equiv/i;
const SCRIPT_URL = /javascript:|vbscript:/i;

const invalid = message => new AgentError('RENDER_REQUEST_INVALID', message, { executed: false });
const refused = message => new AgentError('RENDER_DOCUMENT_REFUSED', message, { executed: false });
const failed = message => new AgentError('RENDER_FAILED', 'The render worker returned an invalid result: ' + message, { executed: false });
const sha256 = text => createHash('sha256').update(text).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const int = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
function only(object, keys, where) {
  if (!isObject(object)) throw invalid(`${where} must be an object`);
  for (const key of Object.keys(object)) if (!keys.includes(key)) throw invalid(`${where} has an unknown field ${JSON.stringify(key).slice(0, 60)}`);
}

// ---- CSS read as tokens (CSS Syntax 3), never by a pattern over the raw text (the rule of the kernel's CssReach): comments
// skipped, strings and identifiers with their escapes decoded before they are compared (u\72l( is url(, @\69mport is
// @import), ASCII case ignored. The targets: the body of an unquoted url(); every string inside url(), src(), image-set(),
// -webkit-image-set(), image(), -webkit-image(), cross-fade() and -webkit-cross-fade(); every string and url of an
// @import prelude; and every string and identifier in the value of a custom property (--name: ... up to ; { or } outside a
// function), because var() can carry it into any URL position. A target refused: after '\' -> '/' and trimming, one that
// starts with // or an http(s), file or ftp scheme; in a URL position also any other scheme but data:image/ (only #id and
// image data: survive the kernel's rewriting). The same reader is native/Ssam.Agent/RenderRequest.cs.
const IMAGE_FUNCTIONS = new Set(['url', 'src', 'image-set', '-webkit-image-set', 'image', '-webkit-image', 'cross-fade', '-webkit-cross-fade']);
const CSS_SPACE = new Set([' ', '\t', '\n', '\r', '\f']);
const asciiLower = text => text.replace(/[A-Z]/g, c => c.toLowerCase());
const cssTrim = text => { let s = 0; let e = text.length; while (s < e && CSS_SPACE.has(text[s])) s++; while (e > s && CSS_SPACE.has(text[e - 1])) e--; return text.slice(s, e); };
const isHex = c => /^[0-9a-fA-F]$/.test(c ?? '');
const identStart = c => c !== undefined && (/[A-Za-z_-]/.test(c) || c.charCodeAt(0) >= 0x80);
const identChar = c => c !== undefined && (/[A-Za-z0-9_-]/.test(c) || c.charCodeAt(0) >= 0x80);
const validEscape = (css, i) => css[i] === '\\' && i + 1 < css.length && css[i + 1] !== '\n' && css[i + 1] !== '\r' && css[i + 1] !== '\f';

// The escape at css[i] (a backslash): [decoded text, next index].
function readEscape(css, i) {
  let j = i + 1;
  if (isHex(css[j])) {
    let hex = '';
    while (hex.length < 6 && isHex(css[j])) hex += css[j++];
    if (css[j] === '\r' && css[j + 1] === '\n') j += 2; else if (CSS_SPACE.has(css[j])) j++;
    const code = parseInt(hex, 16);
    return [code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\uFFFD' : String.fromCodePoint(code), j];
  }
  if (j >= css.length) return ['\uFFFD', j];
  const code = css.codePointAt(j);
  return [String.fromCodePoint(code), j + (code > 0xffff ? 2 : 1)];
}

export function cssTargets(css) {
  const targets = [];
  const stack = [];
  let custom = false; let pendingCustom = false; let atImport = false;
  const inImage = () => stack.some(name => IMAGE_FUNCTIONS.has(name));
  const readName = start => { let name = ''; let i = start; while (i < css.length) { if (identChar(css[i])) { name += css[i++]; continue; } if (validEscape(css, i)) { const [text, next] = readEscape(css, i); name += text; i = next; continue; } break; } return [name, i]; };
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') { const end = css.indexOf('*/', i + 2); i = end < 0 ? css.length : end + 2; continue; }
    if (c === '"' || c === "'") {
      let value = ''; let j = i + 1;
      while (j < css.length && css[j] !== c) {
        if (css[j] === '\n' || css[j] === '\r' || css[j] === '\f') break;
        if (css[j] === '\\') {
          if (j + 1 >= css.length) { j++; continue; }
          if (css[j + 1] === '\n' || css[j + 1] === '\f') { j += 2; continue; }
          if (css[j + 1] === '\r') { j += css[j + 2] === '\n' ? 3 : 2; continue; }
          const [text, next] = readEscape(css, j); value += text; j = next; continue;
        }
        value += css[j++];
      }
      i = css[j] === c ? j + 1 : j;
      if (atImport || inImage()) targets.push({ value, url: true });
      else if (custom) targets.push({ value, url: false });
      pendingCustom = false;
      continue;
    }
    if (c === '@') {
      const [name, next] = readName(i + 1);
      if (name) { if (stack.length === 0 && asciiLower(name) === 'import') atImport = true; i = next; pendingCustom = false; continue; }
    }
    if (identStart(c) || validEscape(css, i) || (c === '-' && (identStart(css[i + 1]) || validEscape(css, i + 1)))) {
      const [name, next] = readName(i);
      if (name && next > i) {
        i = next;
        if (css[i] === '(') {
          const lower = asciiLower(name); i++;
          if (lower === 'url') {
            let j = i; while (CSS_SPACE.has(css[j])) j++;
            if (css[j] !== '"' && css[j] !== "'") {
              let value = '';
              while (j < css.length && css[j] !== ')') { if (validEscape(css, j)) { const [text, next2] = readEscape(css, j); value += text; j = next2; } else value += css[j++]; }
              i = j < css.length ? j + 1 : j;
              targets.push({ value: cssTrim(value), url: true });
              pendingCustom = false;
              continue;
            }
          }
          stack.push(lower); pendingCustom = false;
          continue;
        }
        if (custom) targets.push({ value: name, url: false });
        pendingCustom = stack.length === 0 && !custom && name.startsWith('--');
        continue;
      }
    }
    if (c === '(') stack.push('');
    else if (c === ')') stack.pop();
    else if (c === ':' && stack.length === 0 && pendingCustom) custom = true;
    else if ((c === ';' || c === '{' || c === '}') && stack.length === 0) { custom = false; atImport = false; }
    if (!CSS_SPACE.has(c)) pendingCustom = false;
    i++;
  }
  return targets;
}

const OUTSIDE = /^(?:https?|file|ftp):/i;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
function targetRefused({ value, url }) {
  const target = cssTrim(value.replace(/\\/g, '/'));
  if (target.startsWith('//') || OUTSIDE.test(target)) return true;
  return url && SCHEME.test(target) && !/^data:image\//i.test(target);
}

// The CSS checks, for a style sheet, a <style> element and a style attribute (entities already decoded).
function cssProblem(css) {
  const refused = cssTargets(css).find(targetRefused);
  return refused ? (refused.url ? 'a url, image or @import to an outside address' : 'an outside address in a custom property') : null;
}

// The character references of an attribute value (numeric, and the named ones that spell URL characters).
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', bsol: '\\', lpar: '(', rpar: ')', Tab: '\t', NewLine: '\n', period: '.',
  num: '#', percnt: '%', commat: '@', semi: ';', AMP: '&', LT: '<', GT: '>', QUOT: '"' };
export function decodeEntities(text) {
  return text.replace(/&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?|&([A-Za-z]+);/g, (match, hex, dec, name) => {
    if (name !== undefined) return Object.hasOwn(NAMED, name) ? NAMED[name] : match;
    const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) || !Number.isFinite(code) ? '\uFFFD' : String.fromCodePoint(code);
  });
}

// The attributes of every tag, as an HTML tokenizer reads them: '/' and white space separate attributes, a value is
// quoted ('...' or "...") or runs to white space or '>'.
function* attributes(html) {
  const space = c => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  const letter = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  for (let i = 0; i < html.length; i++) {
    if (html[i] !== '<' || !letter(html[i + 1] ?? '')) continue;
    let j = i + 1;
    while (j < html.length && !space(html[j]) && html[j] !== '/' && html[j] !== '>') j++;
    for (;;) {
      while (j < html.length && (space(html[j]) || html[j] === '/')) j++;
      if (j >= html.length || html[j] === '>') break;
      const start = j;
      j++;
      while (j < html.length && !space(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') j++;
      const name = html.slice(start, j).toLowerCase();
      while (j < html.length && space(html[j])) j++;
      let value = null;
      if (html[j] === '=') {
        j++;
        while (j < html.length && space(html[j])) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") { const end = html.indexOf(quote, j + 1); value = html.slice(j + 1, end < 0 ? html.length : end); j = end < 0 ? html.length : end + 1; }
        else { const from = j; while (j < html.length && !space(html[j]) && html[j] !== '>') j++; value = html.slice(from, j); }
      }
      yield [name, value];
    }
    i = j;
  }
}

// Why a document's HTML is refused, or null.
export function documentProblem(html) {
  const tag = FORBIDDEN_TAG.exec(html);
  if (tag) return `a ${tag[0].slice(1).toLowerCase()} element`;
  if (META_REFRESH.test(html)) return 'a meta http-equiv element';
  if (/srcdoc\s*=/i.test(html)) return 'a srcdoc attribute';
  if (SCRIPT_URL.test(html.replace(/[\t\n\r]/g, ''))) return 'a javascript: or vbscript: address';
  for (let [name, value] of attributes(html)) {
    if (/^on[a-z]+$/.test(name)) return `an ${name} attribute`;
    if (value === null) continue;
    value = decodeEntities(value);
    if (SCRIPT_URL.test(value.replace(/[\t\n\r]/g, ''))) return 'a javascript: or vbscript: address';
    if (URL_ATTRIBUTES.has(name)) {
      const urls = name === 'srcset' || name === 'imagesrcset' ? value.split(',').map(part => part.trim().split(/\s+/)[0]) : [value.trim()];
      if (urls.some(url => FORBIDDEN_URL.test(url))) return `an outside address in a ${name} attribute`;
    }
    if (name === 'style') { const css = cssProblem(value); if (css) return css + ' in a style attribute'; }
  }
  for (const match of html.matchAll(/<style\b[^>]*>([\s\S]*?)(?:<\/style\s*>|$)/gi)) { const css = cssProblem(match[1]); if (css) return css + ' in a style element'; }
  return null;
}

export function styleProblem(css) {
  if (/<\/style/i.test(css)) return 'a </style> end tag';
  if (SCRIPT_URL.test(css.replace(/[\t\n\r]/g, ''))) return 'a javascript: or vbscript: address';
  return cssProblem(css);
}

// The request with its defaults, or RENDER_REQUEST_INVALID / RENDER_DOCUMENT_REFUSED. documentRules: false skips the
// diagnostic text checks (the render worker itself, whose sandbox is the barrier).
export function validateRenderRequest(request, { documentRules = true } = {}) {
  only(request, ['schema', 'styles', 'documents', 'viewports', 'probes', 'image', 'timeoutMs'], 'The request');
  if (request.schema !== REQUEST_SCHEMA) throw invalid(`schema must be ${REQUEST_SCHEMA}`);
  const L = RENDER_LIMITS;
  const styles = request.styles ?? [];
  if (!Array.isArray(styles) || styles.length > L.styles) throw invalid(`styles must be an array of at most ${L.styles}`);
  let total = 0;
  const styleIds = new Set();
  for (const style of styles) {
    only(style, ['id', 'sha256', 'css'], 'A style');
    if (typeof style.id !== 'string' || !ID.test(style.id) || styleIds.has(style.id)) throw invalid('A style id must be unique and match ^[a-z0-9-]{1,40}$');
    styleIds.add(style.id);
    if (typeof style.css !== 'string') throw invalid(`The style ${style.id} has no css text`);
    const bytes = Buffer.byteLength(style.css, 'utf8');
    if (bytes > L.cssBytes) throw invalid(`The style ${style.id} has ${bytes} bytes, above ${L.cssBytes}`);
    if (typeof style.sha256 !== 'string' || !SHA.test(style.sha256) || sha256(style.css) !== style.sha256) throw invalid(`The style ${style.id} does not match its sha256`);
    total += bytes;
  }
  const documents = request.documents;
  if (!Array.isArray(documents) || documents.length < 1 || documents.length > L.documents) throw invalid(`documents must be an array of 1 to ${L.documents}`);
  const documentIds = new Set();
  for (const document of documents) {
    only(document, ['id', 'sha256', 'html', 'styles'], 'A document');
    if (typeof document.id !== 'string' || !ID.test(document.id) || documentIds.has(document.id)) throw invalid('A document id must be unique and match ^[a-z0-9-]{1,40}$');
    documentIds.add(document.id);
    if (typeof document.html !== 'string') throw invalid(`The document ${document.id} has no html text`);
    const bytes = Buffer.byteLength(document.html, 'utf8');
    if (bytes > L.htmlBytes) throw invalid(`The document ${document.id} has ${bytes} bytes, above ${L.htmlBytes}`);
    if (typeof document.sha256 !== 'string' || !SHA.test(document.sha256) || sha256(document.html) !== document.sha256) throw invalid(`The document ${document.id} does not match its sha256`);
    const uses = document.styles ?? [];
    if (!Array.isArray(uses) || uses.length > L.styles || new Set(uses).size !== uses.length || uses.some(id => typeof id !== 'string' || !styleIds.has(id)))
      throw invalid(`The document ${document.id} names a style that is not in the request`);
    total += bytes;
  }
  if (total > L.packageBytes) throw invalid(`The documents and styles have ${total} bytes, above ${L.packageBytes}`);
  const viewports = request.viewports;
  if (!Array.isArray(viewports) || viewports.length < 1 || viewports.length > L.viewports) throw invalid(`viewports must be an array of 1 to ${L.viewports}`);
  const names = new Set();
  for (const viewport of viewports) {
    only(viewport, ['name', 'width', 'height', 'bodyClasses'], 'A viewport');
    if (typeof viewport.name !== 'string' || !ID.test(viewport.name) || names.has(viewport.name)) throw invalid('A viewport name must be unique and match ^[a-z0-9-]{1,40}$');
    names.add(viewport.name);
    if (!int(viewport.width, L.minWidth, L.maxWidth) || !int(viewport.height, L.minHeight, L.maxHeight))
      throw invalid(`The viewport ${viewport.name} must be ${L.minWidth}-${L.maxWidth} wide and ${L.minHeight}-${L.maxHeight} high`);
    const classes = viewport.bodyClasses ?? [];
    if (!Array.isArray(classes) || classes.length > L.bodyClasses || classes.some(name => typeof name !== 'string' || !CLASS.test(name)))
      throw invalid(`The viewport ${viewport.name} has more than ${L.bodyClasses} body classes or a class that is not a plain name`);
  }
  const probes = request.probes ?? {};
  only(probes, ['keys', 'properties', 'maxElements'], 'probes');
  const keys = probes.keys ?? 'all';
  if (keys !== 'all' && (!Array.isArray(keys) || keys.length > L.keys || keys.some(key => typeof key !== 'string' || !KEY.test(key))))
    throw invalid(`probes.keys must be "all" or at most ${L.keys} keys matching ^[A-Za-z0-9_-]{1,80}$`);
  const properties = probes.properties ?? [];
  if (!Array.isArray(properties) || properties.length > L.properties || properties.some(name => !RENDER_PROPERTIES.includes(name)) || new Set(properties).size !== properties.length)
    throw invalid(`probes.properties must be at most ${L.properties} distinct names of the allowed list`);
  const maxElements = probes.maxElements ?? L.defaultMaxElements;
  if (!int(maxElements, 1, L.maxElements)) throw invalid(`probes.maxElements must be an integer from 1 to ${L.maxElements}`);
  const image = request.image ?? null;
  if (image !== null) {
    only(image, ['format', 'quality', 'maxEdge', 'fullPage'], 'image');
    if (image.format !== 'jpeg' || !int(image.quality, L.minQuality, L.maxQuality) || !int(image.maxEdge, L.minEdge, L.maxEdge) || typeof image.fullPage !== 'boolean')
      throw invalid(`image must be null or {format:"jpeg", quality:${L.minQuality}-${L.maxQuality}, maxEdge:${L.minEdge}-${L.maxEdge}, fullPage:boolean}`);
  }
  const timeoutMs = request.timeoutMs ?? L.defaultTimeoutMs;
  if (!int(timeoutMs, L.minTimeoutMs, L.maxTimeoutMs)) throw invalid(`timeoutMs must be an integer from ${L.minTimeoutMs} to ${L.maxTimeoutMs}`);
  if (documentRules) {
    for (const style of styles) { const problem = styleProblem(style.css); if (problem) throw refused(`The style ${style.id} has ${problem}`); }
    for (const document of documents) { const problem = documentProblem(document.html); if (problem) throw refused(`The document ${document.id} has ${problem}`); }
  }
  return { schema: REQUEST_SCHEMA, styles: styles.map(({ id, sha256: hash, css }) => ({ id, sha256: hash, css })),
    documents: documents.map(({ id, sha256: hash, html, styles: uses }) => ({ id, sha256: hash, html, styles: [...(uses ?? [])] })),
    viewports: viewports.map(({ name, width, height, bodyClasses }) => ({ name, width, height, bodyClasses: [...(bodyClasses ?? [])] })),
    probes: { keys: keys === 'all' ? 'all' : [...keys], properties: [...properties], maxElements },
    image: image === null ? null : { format: 'jpeg', quality: image.quality, maxEdge: image.maxEdge, fullPage: image.fullPage }, timeoutMs };
}

// ---- the facts the worker returned, checked against the request: only the fields of ssam-render-facts/1 are kept (a
// "text" or "innerText" is dropped), ids, viewports and keys must be those of the request, numbers finite, style values
// text of at most 200 characters, at most 9 JPEG images of at most 1 MiB each (a larger one goes to imagesOmitted).
// Anything else is RENDER_FAILED; a value above 12 MiB is VALUE_TOO_LARGE.
const finite = (value, where) => { if (typeof value !== 'number' || !Number.isFinite(value)) throw failed(`${where} is not a finite number`); return value; };
const count = (value, where) => { if (!Number.isSafeInteger(value) || value < 0) throw failed(`${where} is not a count`); return value; };
const bool = (value, where) => { if (typeof value !== 'boolean') throw failed(`${where} is not true or false`); return value; };
const short = (value, max, where) => { if (typeof value !== 'string' || value.length > max || /[\x00-\x1f]/.test(value)) throw failed(`${where} is not a short text`); return value; };

function element(value, request, keySet, where) {
  if (!isObject(value)) throw failed(`${where} is not an object`);
  if (typeof value.k !== 'string' || !KEY.test(value.k) || (keySet && !keySet.has(value.k))) throw failed(`${where} names a key that the request did not ask for`);
  if (!Array.isArray(value.box) || value.box.length !== 4) throw failed(`${where}.box is not four numbers`);
  const who = (other, name) => {
    if (other === null || other === undefined) return null;
    if (!isObject(other)) throw failed(`${where}.${name} is not an object`);
    if (other.k !== null && other.k !== undefined && (typeof other.k !== 'string' || !KEY.test(other.k))) throw failed(`${where}.${name}.k is not a key`);
    if (typeof other.tag !== 'string' || !TAG.test(other.tag)) throw failed(`${where}.${name}.tag is not a tag name`);
    const classes = other.classes ?? [];
    if (!Array.isArray(classes) || classes.length > 3 || classes.some(name => typeof name !== 'string' || !CLASS.test(name))) throw failed(`${where}.${name}.classes is not at most 3 class names`);
    return { k: other.k ?? null, tag: other.tag, classes: [...classes] };
  };
  const styles = {};
  if (value.styles !== undefined && value.styles !== null) {
    if (!isObject(value.styles)) throw failed(`${where}.styles is not an object`);
    for (const [name, text] of Object.entries(value.styles)) {
      if (!request.probes.properties.includes(name)) continue;
      if (typeof text !== 'string') throw failed(`${where}.styles.${name} is not text`);
      styles[name] = text.slice(0, RENDER_LIMITS.styleText);
    }
  }
  return { k: value.k, box: value.box.map((n, i) => finite(n, `${where}.box[${i}]`)), visible: bool(value.visible, `${where}.visible`),
    coveredBy: who(value.coveredBy, 'coveredBy'), clippedBy: who(value.clippedBy, 'clippedBy'), lines: count(value.lines, `${where}.lines`),
    textLength: count(value.textLength, `${where}.textLength`), overflowX: bool(value.overflowX, `${where}.overflowX`), styles };
}

export function validateRenderFacts(facts, request) {
  if (!isObject(facts) || facts.schema !== FACTS_SCHEMA) throw failed(`schema is not ${FACTS_SCHEMA}`);
  const engine = facts.engine;
  if (!isObject(engine) || engine.protocol !== RENDER_PROTOCOL) throw failed(`engine.protocol is not ${RENDER_PROTOCOL}`);
  const byId = new Map(request.documents.map(document => [document.id, document]));
  const byName = new Map(request.viewports.map(viewport => [viewport.name, viewport]));
  const keySet = request.probes.keys === 'all' ? null : new Set(request.probes.keys);
  if (!Array.isArray(facts.documents) || facts.documents.length > request.documents.length) throw failed('documents is not a list of the requested documents');
  const seen = new Set();
  const images = []; const omitted = [];
  const rawImages = Array.isArray(facts.images) ? facts.images : [];
  if (facts.images !== undefined && !Array.isArray(facts.images)) throw failed('images is not a list');
  const documents = facts.documents.map((document, d) => {
    const where = `documents[${d}]`;
    if (!isObject(document) || !byId.has(document.id) || seen.has(document.id)) throw failed(`${where} is not a requested document`);
    seen.add(document.id);
    const views = new Set();
    if (!Array.isArray(document.viewports) || document.viewports.length > request.viewports.length) throw failed(`${where}.viewports is not a list of the requested viewports`);
    const viewports = document.viewports.map((view, v) => {
      const at = `${where}.viewports[${v}]`;
      if (!isObject(view) || !byName.has(view.name) || views.has(view.name)) throw failed(`${at} is not a requested viewport`);
      views.add(view.name);
      const asked = byName.get(view.name);
      if (!isObject(view.page)) throw failed(`${at}.page is not an object`);
      const fonts = view.fonts?.missing ?? [];
      if (!Array.isArray(fonts) || fonts.length > RENDER_LIMITS.fonts) throw failed(`${at}.fonts.missing is not a list`);
      if (!Array.isArray(view.elements)) throw failed(`${at}.elements is not a list`);
      let elements = view.elements;
      let truncated = view.truncated === true;
      if (elements.length > request.probes.maxElements) { elements = elements.slice(0, request.probes.maxElements); truncated = true; }
      let image = null;
      if (view.image !== null && view.image !== undefined) {
        const index = view.image;
        const raw = Number.isSafeInteger(index) ? rawImages[index] : undefined;
        if (!raw) throw failed(`${at}.image is not an index of images`);
        if (request.image !== null) {
          const checked = imageOf(raw, document.id, view.name, request.image, `images[${index}]`);
          if (checked.omitted || images.length >= RENDER_LIMITS.images) omitted.push({ document: document.id, viewport: view.name, reason: checked.omitted ?? 'too-many' });
          else { image = images.length; images.push(checked.image); }
        }
      }
      return { name: view.name, width: asked.width, height: asked.height, ms: count(Math.round(finite(view.ms, `${at}.ms`)), `${at}.ms`),
        page: { scrollWidth: finite(view.page.scrollWidth, `${at}.page.scrollWidth`), scrollHeight: finite(view.page.scrollHeight, `${at}.page.scrollHeight`), overflowX: bool(view.page.overflowX, `${at}.page.overflowX`) },
        fonts: { missing: fonts.map((name, i) => short(name, RENDER_LIMITS.fontName, `${at}.fonts.missing[${i}]`)) },
        elements: elements.map((value, i) => element(value, request, keySet, `${at}.elements[${i}]`)), truncated, image };
    });
    const errors = document.errors ?? [];
    if (!Array.isArray(errors) || errors.length > RENDER_LIMITS.errors) throw failed(`${where}.errors is not a list`);
    return { id: document.id, sha256: byId.get(document.id).sha256, viewports, errors: errors.map((error, e) => {
      if (!isObject(error) || !RENDER_ERROR_CODES.includes(error.code) || (error.viewport !== undefined && error.viewport !== null && !byName.has(error.viewport)))
        throw failed(`${where}.errors[${e}] is not a known error`);
      return { code: error.code, viewport: error.viewport ?? null };
    }) };
  });
  const value = { schema: FACTS_SCHEMA, engine: { name: short(engine.name ?? 'electron', 40, 'engine.name'), version: short(engine.version ?? '', 40, 'engine.version'),
    chromium: short(engine.chromium ?? '', 40, 'engine.chromium'), protocol: RENDER_PROTOCOL }, documents, images, ...(omitted.length ? { imagesOmitted: omitted } : {}) };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > RENDER_LIMITS.valueBytes) throw new AgentError('VALUE_TOO_LARGE', `The render facts have ${bytes} bytes, above ${RENDER_LIMITS.valueBytes}`, { executed: false });
  return value;
}

function imageOf(raw, document, viewport, asked, where) {
  if (!isObject(raw) || raw.document !== document || raw.viewport !== viewport || raw.mime !== 'image/jpeg' || typeof raw.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.base64))
    throw failed(`${where} is not a JPEG of ${document}/${viewport}`);
  if (!int(raw.width, 1, asked.maxEdge) || !int(raw.height, 1, asked.maxEdge)) throw failed(`${where} is larger than maxEdge`);
  const bytes = Buffer.from(raw.base64, 'base64');
  if (bytes.length > RENDER_LIMITS.imageBytes) return { omitted: 'too-large' };
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw failed(`${where} is not a JPEG`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (raw.sha256 !== hash) throw failed(`${where} does not match its sha256`);
  return { image: { document, viewport, mime: 'image/jpeg', width: raw.width, height: raw.height, sha256: hash, base64: raw.base64 } };
}
