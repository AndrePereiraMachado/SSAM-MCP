// Scripts of a captured page (docs/PROTOTIPO-NATIVO.md 2.1, 2.3 source 4): planned from the document, executed by
// SSAM and not by jsdom (runScripts "outside-only"). Classic scripts are compiled once per capture (vm.Script cached by
// sha256) and run in every window through its VM context; ES modules run through vm.SourceTextModule, linked by URL
// inside source, with import maps; a bare specifier without an import map is a render failure with the vendor patch.
import vm from 'node:vm';
import * as acorn from 'acorn';
import { sha256 } from './ir.mjs';
import { ORIGIN, localPath } from './network.mjs';
import { isRemote } from './vendor.mjs';

export class RenderFailure extends Error {
  constructor(message, detail = {}) { super(message); this.detail = detail; }
}

const CLASSIC_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript', 'text/jscript', 'text/livescript', 'application/x-javascript', 'text/x-javascript']);

export const BABEL_TYPES = new Set(['text/babel', 'text/jsx']);

// The scripts of a document in document order (static plan; dynamic insertions are handled by the runtime).
export function planScripts(document, { nodeLocation } = {}) {
  const plan = [];
  for (const [index, element] of [...document.querySelectorAll('script')].entries()) {
    const type = String(element.getAttribute('type') ?? '').trim().toLowerCase();
    // text/babel and text/jsx are source code too (the page's Babel compiles them): kind babel, read by the static scan
    const kind = CLASSIC_TYPES.has(type) ? 'classic' : type === 'module' ? 'module' : type === 'importmap' ? 'importmap' : BABEL_TYPES.has(type) ? 'babel' : 'data';
    const src = element.getAttribute('src');
    const entry = { index, kind, type, element, defer: element.hasAttribute('defer'), async: element.hasAttribute('async'), nomodule: element.hasAttribute('nomodule') };
    if (src != null) {
      const url = new URL(src, document.URL).href;
      entry.url = url;
      entry.local = localPath(url, document.URL);
      entry.remote = entry.local == null && isRemote(url);
    } else {
      entry.text = element.textContent;
      const location = nodeLocation?.(element);
      entry.line = location?.startTag ? location.startTag.endLine : location?.startLine ?? 1;
      entry.column = location?.startTag ? location.startTag.endCol : 1;
    }
    plan.push(entry);
  }
  return plan;
}

export function remoteScriptUrls(plan) {
  return plan.filter(entry => (entry.kind === 'classic' || entry.kind === 'module') && entry.remote && !entry.nomodule).map(entry => entry.url);
}

// Compiled classic scripts, shared by every window of a child process.
export class ScriptCache {
  constructor() { this.scripts = new Map(); this.errors = new Map(); }
  classic(text, filename, lineOffset = 0, columnOffset = 0) {
    const key = sha256(text) + '|' + filename + '|' + lineOffset + '|' + columnOffset;
    if (this.errors.has(key)) throw this.errors.get(key);
    if (!this.scripts.has(key)) {
      try {
        this.scripts.set(key, new vm.Script(text, { filename, lineOffset, columnOffset }));
      } catch (error) {
        this.errors.set(key, error);
        throw error;
      }
    }
    return this.scripts.get(key);
  }
}

// Code a script evaluated (Babel standalone appends <script> elements with its output and an inline source map): the file
// it names is babel:<file of the source map>, and its lines are mapped back to that file's lines (the first segment of
// each generated line). filename -> {file, lines: generated line (1-based) -> source line}.
const LINE_MAPS = new Map();
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeVlq(segment) {
  const out = []; let value = 0, shift = 0;
  for (const char of segment) {
    const digit = B64.indexOf(char);
    if (digit < 0) return out;
    value += (digit & 31) << shift;
    if (digit & 32) { shift += 5; continue; }
    out.push(value & 1 ? -(value >>> 1) : value >>> 1);
    value = 0; shift = 0;
  }
  return out;
}
// The inline source map of a script text (//# sourceMappingURL=data:application/json;...base64,...), or null.
export function inlineSourceMap(text) {
  const match = /\/\/[#@] sourceMappingURL=data:application\/json[^,]*;base64,([A-Za-z0-9+/=]+)\s*$/m.exec(String(text ?? ''));
  if (!match) return null;
  try { return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')); } catch { return null; }
}
// The name of an evaluated script (babel:<source file>) and its line map, registered for siteOf. -> the name, or null.
// inline: the start lines of the page's inline text/babel scripts ("Inline Babel script (n)" is the n-th), entry the page.
export function registerEvaluated(text, { fallback = null, entry = null, inline = [] } = {}) {
  const map = inlineSourceMap(text);
  let source = map?.sources?.[0] ?? map?.file ?? null;
  let offset = 0;
  const inlineName = /^Inline Babel script(?: \((\d+)\))?$/.exec(String(source ?? ''));
  if (inlineName && entry) { offset = Math.max(0, (inline[Number(inlineName[1] ?? 1) - 1] ?? 1) - 1); source = entry; }
  if (!source && !fallback) return null;
  const raw = String(source ?? fallback).replace(/^https?:\/\/[^/]+\//, '');
  const base = /^[A-Za-z]:[\\/]|^\//.test(raw) ? raw.replace(/^.*[\\/]/, '') : raw.replace(/\\/g, '/');
  const name = 'babel:' + base;
  const lines = [];
  if (map?.mappings) {
    let sourceLine = 0, sourceIndex = 0;
    map.mappings.split(';').forEach((line, generated) => {
      let first = null;
      for (const segment of line.split(',').filter(Boolean)) {
        const fields = decodeVlq(segment);
        if (fields.length >= 4) { sourceIndex += fields[1]; sourceLine += fields[2]; if (first == null && sourceIndex === 0) first = sourceLine; }
      }
      lines[generated + 1] = first == null ? null : first + 1 + offset;
    });
  }
  LINE_MAPS.set(name, { file: base, lines });
  return name;
}
const mappedLine = (file, line) => { const map = LINE_MAPS.get(file); if (!map) return line; for (let at = line; at >= 1; at--) if (map.lines[at] != null) return map.lines[at]; return line; };

// "app.js:344:9" from an Error stack: the first frame inside a prototype file (not the capture's own modules). A file name
// may have spaces ("Folha de Ponto.html"): the frame is "at fn (<file>:<line>:<col>)" or "at <file>:<line>:<col>".
export function siteOf(stack, files = null) {
  for (const line of String(stack ?? '').split('\n').slice(1)) {
    const match = line.match(/\((.+):(\d+):(\d+)\)\s*$/) ?? line.match(/^\s*at (?:async )?(.+?):(\d+):(\d+)\s*$/);
    if (!match) continue;
    const file = match[1].replace(/^(?:new )?\S+ \[as \S+\] \(/, '');
    if (/[\\/]prototype[\\/][a-z-]+\.mjs$/.test(file) || file.startsWith('node:') || /node_modules/.test(file) || /^(?:evalmachine|vm\.js)/.test(file)) continue;
    if (files && !files(file)) continue;
    return { file, line: mappedLine(file, Number(match[2])), column: Number(match[3]) };
  }
  return null;
}

export function siteText(site) { return site ? site.file + ':' + site.line : null; }

function errorSite(error) {
  const stack = String(error?.stack ?? '');
  const syntax = stack.split('\n')[0].match(/^(.+):(\d+)$/);
  if (syntax) return { file: syntax[1], line: Number(syntax[2]), column: 1 };
  return siteOf(stack);
}

export function describeError(error) {
  const site = errorSite(error);
  const message = String(error?.message ?? error);
  return { message, site, where: site ? site.file + ':' + site.line + ':' + site.column : null };
}

// ES module graph of one window. Specifiers resolve against the referencing module URL; import maps apply first.
export async function runModules(entries, { context, importMap, readText, vendors }) {
  const cache = new Map();
  const mapped = specifier => {
    const imports = importMap?.imports ?? {};
    if (imports[specifier]) return imports[specifier];
    const prefix = Object.keys(imports).filter(key => key.endsWith('/') && specifier.startsWith(key)).sort((a, b) => b.length - a.length)[0];
    return prefix ? imports[prefix] + specifier.slice(prefix.length) : null;
  };
  const resolve = (specifier, referrer) => {
    const viaMap = mapped(specifier);
    if (viaMap) return new URL(viaMap, ORIGIN + '/').href;
    if (/^(\.{0,2}\/|https?:)/.test(specifier)) return new URL(specifier, referrer).href;
    throw new RenderFailure('bare module specifier "' + specifier + '" without an import map', { specifier, bare: true });
  };
  const load = async (url) => {
    if (cache.has(url)) return cache.get(url);
    let text, identifier;
    const relative = localPath(url);
    if (relative != null) {
      text = readText(relative);
      identifier = relative;
      if (text == null) throw new RenderFailure('module ' + relative + ' does not exist in source', { url });
    } else if (vendors.has(url)) {
      text = vendors.get(url).text;
      identifier = url;
    } else {
      throw new RenderFailure('module ' + url + ' is outside source and not in the vendor cache', { url, vendor: true });
    }
    const module = new vm.SourceTextModule(text, {
      identifier, context,
      initializeImportMeta(meta) { meta.url = url; },
      importModuleDynamically: async (specifier, referrer) => {
        const target = await load(resolve(specifier, referrer.identifier.startsWith('http') ? referrer.identifier : ORIGIN + '/' + referrer.identifier));
        await target.link(linker);
        await target.evaluate();
        return target;
      }
    });
    module.url = url;
    cache.set(url, module);
    return module;
  };
  const linker = async (specifier, referencing) => load(resolve(specifier, referencing.url));
  for (const entry of entries) {
    const module = entry.inline != null
      ? new vm.SourceTextModule(entry.inline, { identifier: entry.identifier, context, initializeImportMeta(meta) { meta.url = ORIGIN + '/' + entry.identifier; } })
      : await load(entry.url);
    if (entry.inline != null) module.url = ORIGIN + '/' + entry.identifier;
    if (module.status === 'unlinked') await module.link(linker);
    if (module.status === 'linked') await module.evaluate();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Static analysis by tokenization (Acorn), never by line regexes: route literals (2.3 source 4) and the state property
// each delegated branch assigns (used for dimension names).

function parse(text) {
  const options = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, locations: true };
  try { return acorn.parse(text, { ...options, sourceType: 'script' }); } catch { /* try as a module */ }
  try { return acorn.parse(text, { ...options, sourceType: 'module' }); } catch { return null; }
}

function children(node) {
  const list = [];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const item of value) if (item && typeof item.type === 'string') list.push(item); }
    else if (value && typeof value.type === 'string') list.push(value);
  }
  return list;
}

function visit(node, fn, parent = null) {
  if (!node) return;
  fn(node, parent);
  for (const child of children(node)) visit(child, fn, node);
}

function contains(node, predicate) {
  let found = false;
  visit(node, current => { if (!found && predicate(current)) found = true; });
  return found;
}

function memberName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ThisExpression') return 'this';
  if (node.type === 'MemberExpression' && !node.computed) {
    const object = memberName(node.object);
    return object ? object + '.' + node.property.name : null;
  }
  return null;
}

const LOCATION = /^(window\.|document\.|globalThis\.)?location$/;
function isLocationPart(node, part) {
  return node?.type === 'MemberExpression' && !node.computed && node.property.name === part && LOCATION.test(memberName(node.object) ?? '');
}

function stringValues(node, out, weakOut) {
  if (!node) return;
  if (node.type === 'Literal' && typeof node.value === 'string') out.push(node.value);
  else if (node.type === 'TemplateLiteral') {
    out.push(node.quasis.map((quasi, index) => quasi.value.cooked + (index < node.expressions.length ? '{id}' : '')).join(''));
  } else if (node.type === 'ConditionalExpression') { stringValues(node.consequent, out, weakOut); stringValues(node.alternate, out, weakOut); }
  else if (node.type === 'LogicalExpression') { stringValues(node.left, out, weakOut); stringValues(node.right, out, weakOut); }
  else if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = [], right = [];
    stringValues(node.left, left); stringValues(node.right, right);
    if (left.length && !right.length) out.push(...left.map(value => value + '{id}'));
  }
}

const ROUTE_TOKEN = /^[a-z0-9][a-z0-9_-]*(\/([a-z0-9_-]+|\{id\}))*$/i;

export function analyzeScripts(sources) {
  const strong = [], weak = [], hashLiterals = [], paths = [], branches = new Map(), branchSites = new Map();
  const signals = { hashchange: false, popstate: false, pushState: false };
  for (const { file, text } of sources) {
    const ast = parse(text);
    if (!ast) continue;
    const routeFunctions = new Set(), routeVars = new Set();
    const readsRoute = node => contains(node, current => isLocationPart(current, 'hash') || isLocationPart(current, 'pathname'));
    visit(ast, node => {
      if (node.type === 'FunctionDeclaration' && node.id && readsRoute(node.body)) routeFunctions.add(node.id.name);
      if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init && /Function/.test(node.init.type) && readsRoute(node.init.body)) routeFunctions.add(node.id.name);
    });
    const callsRoute = node => contains(node, current => current.type === 'CallExpression' && current.callee.type === 'Identifier' && routeFunctions.has(current.callee.name));
    const patternNames = (pattern, out) => {
      if (!pattern) return;
      if (pattern.type === 'Identifier') out.add(pattern.name);
      else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(element => patternNames(element, out));
      else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(property => patternNames(property.value ?? property.argument, out));
      else if (pattern.type === 'AssignmentPattern') patternNames(pattern.left, out);
      else if (pattern.type === 'RestElement') patternNames(pattern.argument, out);
    };
    visit(ast, node => {
      if (node.type === 'VariableDeclarator' && node.init && !/Function/.test(node.init.type) && (readsRoute(node.init) || callsRoute(node.init))) patternNames(node.id, routeVars);
    });
    const isRouteValue = node => node && ((node.type === 'Identifier' && routeVars.has(node.name)) || (node.type !== 'Literal' && (readsRoute(node) || callsRoute(node))));
    visit(ast, (node, parent) => {
      if (node.type === 'Literal' && typeof node.value === 'string') {
        if (node.value === 'hashchange') signals.hashchange = true;
        if (node.value === 'popstate') signals.popstate = true;
        if (/^#[a-z][\w-]*(\/[\w-]+)*$/i.test(node.value)) hashLiterals.push({ file, route: node.value.slice(1), line: node.loc.start.line });
      }
      if (node.type === 'MemberExpression' && !node.computed) {
        if (node.property.name === 'onhashchange') signals.hashchange = true;
        if (node.property.name === 'onpopstate') signals.popstate = true;
        if (['pushState', 'replaceState'].includes(node.property.name)) signals.pushState = true;
      }
      if (node.type === 'AssignmentExpression' && (isLocationPart(node.left, 'hash') || isLocationPart(node.left, 'pathname'))) {
        const values = []; stringValues(node.right, values);
        for (const value of values) strong.push({ file, route: value.replace(/^#/, ''), line: node.loc.start.line });
      }
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed) {
        const name = node.callee.property.name, object = memberName(node.callee.object) ?? '';
        if (['pushState', 'replaceState'].includes(name) && /history$/.test(object) && node.arguments[2]) {
          const values = []; stringValues(node.arguments[2], values);
          for (const value of values) paths.push({ file, route: value, line: node.loc.start.line });
        }
        if (['assign', 'replace'].includes(name) && LOCATION.test(object) && node.arguments[0]) {
          const values = []; stringValues(node.arguments[0], values);
          for (const value of values) (value.startsWith('#') ? strong : paths).push({ file, route: value.replace(/^#/, ''), line: node.loc.start.line });
        }
        if (name === 'includes' && node.callee.object.type === 'ArrayExpression' && isRouteValue(node.arguments[0])) {
          for (const element of node.callee.object.elements) if (element?.type === 'Literal' && typeof element.value === 'string') weak.push({ file, route: element.value, line: node.loc.start.line });
        }
      }
      if (node.type === 'BinaryExpression' && ['===', '==', '!==', '!='].includes(node.operator)) {
        const [value, literal] = node.right.type === 'Literal' ? [node.left, node.right] : [node.right, node.left];
        if (literal.type === 'Literal' && typeof literal.value === 'string' && isRouteValue(value)) weak.push({ file, route: literal.value.replace(/^#/, ''), line: node.loc.start.line });
      }
      if (node.type === 'SwitchStatement' && isRouteValue(node.discriminant)) {
        for (const item of node.cases) if (item.test?.type === 'Literal' && typeof item.test.value === 'string') weak.push({ file, route: item.test.value.replace(/^#/, ''), line: item.loc.start.line });
      }
      // Delegated branches: if (x === 'literal') { obj.prop = ... } -> literal -> [prop].
      const branch = (test, body) => {
        if (test?.type !== 'BinaryExpression' || !['===', '=='].includes(test.operator)) return;
        const literal = test.right.type === 'Literal' ? test.right : test.left.type === 'Literal' ? test.left : null;
        if (!literal || typeof literal.value !== 'string') return;
        if (!branchSites.has(literal.value)) branchSites.set(literal.value, file + ':' + test.loc.start.line);
        const props = [];
        visit(body, current => {
          const target = current.type === 'AssignmentExpression' ? current.left : current.type === 'UpdateExpression' ? current.argument : null;
          if (target?.type === 'MemberExpression' && !target.computed && target.object.type !== 'ThisExpression') props.push(target.property.name);
        });
        if (!props.length) return;
        if (!branches.has(literal.value)) branches.set(literal.value, []);
        for (const prop of props) if (!branches.get(literal.value).includes(prop)) branches.get(literal.value).push(prop);
      };
      if (node.type === 'IfStatement') branch(node.test, node.consequent);
      if (node.type === 'LogicalExpression' && node.operator === '&&') branch(node.left, node.right);
    });
  }
  const clean = list => list.filter(item => ROUTE_TOKEN.test(item.route) || /^\//.test(item.route));
  return { strong: clean(strong), weak: clean(weak), hashLiterals, paths, branches, branchSites, signals };
}
