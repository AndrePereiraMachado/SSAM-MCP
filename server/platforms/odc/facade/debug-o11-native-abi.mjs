// O11 Reactive published-asset reader. Pure functions over the PUBLIC AMD JavaScript the runtime serves
// (/<Module>/scripts/*.js): controllers, server-action stubs, data actions, client actions, their typed
// parameters/outputs and the AMD dependency closure the private worker must load. No network, no eval.
//
// The generated code is machine-written by the O11 compiler, so its shapes are fixed:
//   Controller.prototype.<x>$ServerAction = function (<a>In, ..., callContext) { ... controller.callServerAction(
//     "<ServerAction>", "screenservices/<Module>/<Flow>/<Screen>/Action<ServerAction>", "<apiVersion>", inputs, ...)
//   Controller.prototype.<x>$DataActRefresh = function (callContext) { OutSystemsDebugger.push("<mk>:<key>:...") ...
//     controller.callDataAction("DataAction<Name>", "screenservices/...", "<apiVersion>", ...) }
//   Controller.prototype._<x>$Action = function (<a>In, ..., callContext) { OutSystemsDebugger.push("<mk>:<key>:...") ... }
//   <Module>Controller.default.<x>$Action = function (...)   (module-level client actions, define "<Module>.controller$<X>")
// Anything that does not match these shapes is simply not an entry: the reader never guesses.

const KEY = '[A-Za-z0-9_+]{22}';
const DEFINE = /\bdefine\((?:"([^"]+)"|'([^']+)'),\s*\[([^\]]*)\]\s*,\s*(?:function\s*\(([^)]*)\)\s*\{)?/g;
const FUNCTION = /(?:^|\n)(?:Controller\.prototype\.|([A-Za-z_$][\w$]*)Controller\.default\.)(_?)([A-Za-z_$][\w$]*)\$(ServerAction|Action|DataActRefresh) = function \(([^)]*)\) \{/g;
const REGISTER = /(?:Controller|\.constructor)\.registerVariableGroupType\("([^"]+)", \[/g;
export const DATA_TYPES = Object.freeze({ Integer: 0, LongInteger: 1, Decimal: 2, Currency: 3, Text: 4, PhoneNumber: 5, Email: 6,
  Boolean: 7, Date: 8, DateTime: 9, Time: 10, Record: 11, RecordList: 12, BinaryData: 13, Object: 14 });

// Index of the closing brace that matches the opening brace at `open`, skipping strings and comments.
export function matchingBrace(text, open, openChar = '{', closeChar = '}') {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 1; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar && --depth === 0) return i;
  }
  return -1;
}

// Top-level comma split of an argument list (no surrounding parentheses).
export function splitArguments(text) {
  const out = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  const last = text.slice(start).trim();
  if (last) out.push(last);
  return out;
}

// AMD relative ids ("./Model", "../X") resolve against the defining module's directory.
export function resolveAmd(parent, dep) {
  if (!/^\.\.?\//.test(dep)) return dep;
  const parts = parent.split('/').slice(0, -1);
  for (const segment of dep.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') parts.pop(); else parts.push(segment);
  }
  return parts.join('/');
}

// Every define("<name>", [deps], function (params) { ... }) block of one asset.
export function defines(text) {
  const found = []; let match;
  text = text.replace(/^﻿/, '');
  DEFINE.lastIndex = 0;
  while ((match = DEFINE.exec(text))) {
    const name = match[1] ?? match[2];
    const deps = [...match[3].matchAll(/"([^"]+)"|'([^']+)'/g)].map(m => resolveAmd(name, m[1] ?? m[2]));
    if (match[4] === undefined) { found.push({ name, deps, params: [], body: '', start: match.index }); continue; }
    const open = match.index + match[0].length - 1, close = matchingBrace(text, open);
    const params = match[4].split(',').map(s => s.trim()).filter(Boolean);
    found.push({ name, deps, params, body: text.slice(open + 1, close < 0 ? text.length : close), start: match.index });
  }
  return found;
}

function registrations(body) {
  const groups = {}; let match;
  REGISTER.lastIndex = 0;
  while ((match = REGISTER.exec(body))) {
    const open = match.index + match[0].length - 1, close = matchingBrace(body, open, '[', ']');
    const list = body.slice(open + 1, close);
    groups[match[1]] = [...list.matchAll(/\{\s*name: "([^"]+)",\s*attrName: "([^"]+)",\s*mandatory: (true|false),\s*dataType: OS\.DataTypes\.DataTypes\.(\w+)/g)]
      .map(m => ({ name: m[1], attribute: m[2], mandatory: m[3] === 'true', dataType: m[4] }));
  }
  return groups;
}
const pushOf = body => {
  const m = new RegExp(`OutSystemsDebugger\\.push\\("(${KEY}):(${KEY}):([^"]*)", "([^"]*)", "([^"]*)", "([^"]*)"`).exec(body);
  return m ? { moduleKey: m[1], key: m[2], keyPath: m[3], moduleName: m[4], name: m[5], flowKind: m[6] } : null;
};
const breakpointsOf = body => [...new Set([...body.matchAll(new RegExp(`OutSystemsDebugger\\.handleBreakpoint\\("(${KEY}):(${KEY})"`, 'g'))].map(m => m[2]))];

// Calls made inside a client action body: other client actions, stubs and data-action refreshes, with their raw arguments.
function callsOf(body, controllerVars) {
  const calls = [];
  const pattern = /(?:\b(controller)|\b([A-Za-z_$][\w$]*)Controller\.default)\.(_?)([A-Za-z_$][\w$]*)\$(ServerAction|Action|DataActRefresh)\(/g;
  let match;
  while ((match = pattern.exec(body))) {
    const open = match.index + match[0].length - 1, close = matchingBrace(body, open, '(', ')');
    const args = splitArguments(body.slice(open + 1, close)).filter(a => a !== 'callContext' && !/^callContext\b/.test(a));
    const via = match[1] ? 'self' : controllerVars[match[2] + 'Controller'] ?? null;
    calls.push({ target: match[4], kind: match[5], via, viaVariable: match[1] ? null : match[2] + 'Controller', args });
  }
  return calls;
}

// Owner of a controller define: "<M>.<Flow>.<Screen>.mvc$controller" -> "Flow.Screen"; "<M>.controller$X" -> "@module".
export function controllerOwner(defineName, module) {
  if (defineName.startsWith(module + '.controller')) return '@module';
  const m = new RegExp('^' + module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(.+)\\.mvc\\$controller$').exec(defineName);
  return m ? m[1] : null;
}

// Parse every controller-like define of one module's assets. Returns stubs, data actions, client actions,
// screen/block component metadata (variables, view blocks, screen flag) and a define -> asset map.
export function parseO11Assets(assets, module) {
  const out = { module, stubs: [], dataActions: [], clientActions: [], components: {}, definedIn: {}, defines: {} };
  for (const asset of [...assets].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    for (const d of defines(asset.text)) {
      if (!(d.name in out.definedIn)) out.definedIn[d.name] = asset.name;
      out.defines[d.name] = { deps: d.deps, asset: asset.name };
      const vars = Object.fromEntries(d.params.map((p, i) => [p, d.deps[i]]));
      const mvc = /^(.+)\.mvc\$(model|view|controller)$/.exec(d.name);
      if (mvc && mvc[1].startsWith(module + '.')) {
        const owner = mvc[1].slice(module.length + 1), component = out.components[owner] ??= { owner, amd: mvc[1] };
        if (mvc[2] === 'model') {
          component.viewName = /new OS\.Model\.ModelFactory\(Model, "([^"]+)"\)/.exec(d.body)?.[1] ?? null;
          component.variables = [...d.body.matchAll(/this\.attr\("([^"]+)", "([^"]+)", "[^"]*", (?:true|false), (?:true|false), OS\.DataTypes\.DataTypes\.(\w+)/g)]
            .map(m => ({ name: m[1], attribute: m[2], dataType: m[3] }));
        }
        if (mvc[2] === 'view') {
          // Blocks compile an empty title; a screen's title is its (non-empty) Title property.
          component.screen = /Object\.defineProperty\(View\.prototype, "title", \{\s*get: function \(\) \{\s*return "(?:[^"\\]|\\.)+";/.test(d.body);
          component.blocks = d.deps.filter(n => /\.mvc\$view$/.test(n)).map(n => n.slice(0, -'.mvc$view'.length));
        }
      }
      const owner = controllerOwner(d.name, module);
      if (!owner) continue;
      const groups = registrations(d.body);
      FUNCTION.lastIndex = 0; let match;
      while ((match = FUNCTION.exec(d.body))) {
        const open = d.body.indexOf('{', match.index + match[0].length - 1), close = matchingBrace(d.body, open);
        const body = d.body.slice(open, close + 1), params = match[5].split(',').map(s => s.trim()).filter(Boolean);
        const inputs = params.filter(p => p !== 'callContext');
        const base = { owner, controller: d.name, asset: asset.name, method: match[3] + '$' + match[4], params: inputs };
        if (match[4] === 'ServerAction') {
          const call = /callServerAction\("([^"]+)", "([^"]+)", "([^"]+)"/.exec(body);
          if (!call) continue;
          const conversions = Object.fromEntries([...body.matchAll(/(\w+): OS\.DataConversion\.ServerDataConverter\.to\((\w+), OS\.DataTypes\.DataTypes\.(\w+)\)/g)]
            .map(m => [m[2], { name: m[1], dataType: m[3] }]));
          const group = /getVariableGroupType\("([^"]+)"\)/.exec(body)?.[1] ?? null;
          out.stubs.push({ ...base, serverAction: call[1], endpoint: call[2], apiVersion: call[3],
            referenced: group ? /\$rss/.test(group) : false, producerHint: group ? /\$rssespace([a-z0-9]+)_/.exec(group)?.[1] ?? null : null,
            inputs: inputs.map(p => ({ param: p, name: conversions[p]?.name ?? null, dataType: conversions[p]?.dataType ?? null })),
            outputs: group ? (groups[group] ?? []) : [] });
        } else if (match[4] === 'DataActRefresh') {
          const push = pushOf(body), call = /callDataAction\("([^"]+)", "([^"]+)", "([^"]+)"/.exec(body);
          if (!push || !call) continue;
          out.dataActions.push({ ...base, key: push.key, moduleKey: push.moduleKey, name: push.name, endpoint: call[2], apiVersion: call[3],
            dataProperty: /model\.variables\.(\w+)\.replaceWith/.exec(body)?.[1] ?? null });
        } else if (match[2] === '_' || match[1]) {
          // Screen/block client actions: the "_x$Action" implementation; module-level: the default.x$Action implementation.
          const push = pushOf(body);
          if (!push) continue;
          const groupPrefix = /getVariableGroupType\("([^"]+)\$vars"\)/.exec(body)?.[1] ?? null;
          const varsGroup = groupPrefix ? groups[groupPrefix + '$vars'] ?? [] : [];
          const outGroup = /getVariableGroupType\("([^"]+\$outVars)"\)/.exec(body)?.[1];
          out.clientActions.push({ ...base, method: match[3] + '$Action', implementation: (match[2] ? '_' : '') + match[3] + '$Action',
            moduleLevel: !!match[1], key: push.key, moduleKey: push.moduleKey, name: push.name, flowKind: push.flowKind,
            inputs: inputs.map(p => { const v = varsGroup.find(g => g.attribute === p + 'Local'); return { param: p, name: v?.name ?? null, dataType: v?.dataType ?? null, mandatory: v?.mandatory ?? false }; }),
            outputs: outGroup ? (groups[outGroup] ?? []) : [], nodes: breakpointsOf(body), calls: callsOf(body, vars) });
        }
      }
    }
  }
  return out;
}

// Screen that hosts a component: the component itself when it is a screen; for a block, the first screen
// (viewName ascending) whose transitive view blocks contain it. Deterministic; null when none.
export function hostViewName(parsed, owner) {
  const component = parsed.components[owner];
  if (!component) return null;
  if (component.screen) return component.viewName ?? null;
  const screens = Object.values(parsed.components).filter(c => c.screen && c.viewName).sort((a, b) => a.viewName < b.viewName ? -1 : 1);
  for (const screen of screens) {
    const seen = new Set(), stack = [screen.amd];
    while (stack.length) {
      const amd = stack.pop(); if (seen.has(amd)) continue; seen.add(amd);
      const c = Object.values(parsed.components).find(x => x.amd === amd);
      for (const b of c?.blocks ?? []) stack.push(b);
    }
    if (seen.has(component.amd)) return screen.viewName;
  }
  return null;
}

// AMD dependency closure of the given roots over the parsed defines. Unknown names fail closed.
export function amdClosure(parsed, roots) {
  const BUILTIN = new Set(['exports', 'require', 'module']);
  const needed = new Set(), assets = new Set(), missing = new Set(), stack = [...roots];
  while (stack.length) {
    const name = stack.pop();
    if (BUILTIN.has(name) || needed.has(name)) continue;
    needed.add(name);
    const owner = parsed.definedIn[name];
    if (!owner) { missing.add(name); continue; }
    assets.add(owner);
    for (const dep of parsed.defines[name].deps) stack.push(dep);
  }
  return { modules: [...needed].sort(), assets: [...assets].sort(), missing: [...missing].sort() };
}

// ----- typed inputs -----------------------------------------------------------------------------------------
// Canonical scenario values -> the server wire format the original ServerDataConverter reads back
// (ServerDataConverter.from(wire, type)) inside the private worker. Never a password, token or cookie.
const SENSITIVE = /password|passwd|secret|credential|authorization|cookie|(?:^|_)token(?:$|_)|bearer/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/, TIME = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const validDate = text => { const m = DATE.exec(text); if (!m) return false; const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]; };
const fail = code => { throw new Error(code); };

// Model DataType ("BasicType:Text", "IdentifierType:Order Identifier", "ServerEntity:Order", "Structure:X", "RecordList...")
// or asset DataTypes name -> { base, of? }.
export function o11TypeOf(parameter) {
  const asset = parameter.dataType && DATA_TYPES[parameter.dataType] !== undefined ? parameter.dataType : null;
  const model = parameter.modelType ?? null; // e.g. "BasicType:Long Integer"
  if (model) {
    const [kind, name = ''] = model.split(':');
    if (kind === 'BasicType') {
      const basic = { 'Text': 'Text', 'Integer': 'Integer', 'Long Integer': 'LongInteger', 'Decimal': 'Decimal', 'Currency': 'Currency',
        'Boolean': 'Boolean', 'Date': 'Date', 'Time': 'Time', 'Date Time': 'DateTime', 'Email': 'Email', 'Phone Number': 'PhoneNumber',
        'Binary Data': 'BinaryData', 'Object': 'Object' }[name];
      if (basic) return { base: basic };
    }
    if (kind === 'IdentifierType') return { base: asset ?? (parameter.identifierBase ?? 'LongInteger'), identifier: name };
    if (/List$/.test(kind) || /List$/.test(name) || parameter.list) return { base: 'RecordList', of: name };
    if (['ServerEntity', 'Entity', 'StaticEntity', 'Structure', 'ServerStructure', 'StructureSignature', 'EntitySignature', 'AnonymousStructure'].includes(kind))
      return { base: 'Record', of: name };
  }
  if (asset) return { base: asset };
  return { base: 'Unknown' };
}

export function canonicalValue(type, value, path = 'value', depth = 0) {
  if (depth > 6) fail('debug_o11_native_input_too_deep:' + path);
  if (value === null || value === undefined) return null;
  switch (type.base) {
    case 'Text': case 'Email': case 'PhoneNumber':
      if (typeof value !== 'string' || value.length > 8192 || /^Bearer\s|^eyJ[A-Za-z0-9_-]{8,}\./.test(value)) fail('debug_o11_native_input_type_mismatch:' + path);
      return value;
    case 'Integer':
      if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) fail('debug_o11_native_input_type_mismatch:' + path);
      return value;
    case 'LongInteger': {
      const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
      if (typeof text !== 'string' || !/^-?\d{1,19}$/.test(text) || BigInt(text) > 9223372036854775807n || BigInt(text) < -9223372036854775808n)
        fail('debug_o11_native_input_type_mismatch:' + path);
      return BigInt(text).toString();
    }
    case 'Decimal': case 'Currency': {
      const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
      if (typeof text !== 'string' || !/^-?\d{1,28}(\.\d{1,8})?$/.test(text)) fail('debug_o11_native_input_type_mismatch:' + path);
      const [int, frac = ''] = text.replace(/^-/, '').split('.');
      const normalized = (text.startsWith('-') ? '-' : '') + int.replace(/^0+(?=\d)/, '') + (frac.replace(/0+$/, '') ? '.' + frac.replace(/0+$/, '') : '');
      return normalized === '-0' ? '0' : normalized;
    }
    case 'Boolean':
      if (typeof value !== 'boolean') fail('debug_o11_native_input_type_mismatch:' + path);
      return value;
    case 'Date':
      if (typeof value !== 'string' || !validDate(value)) fail('debug_o11_native_input_type_mismatch:' + path);
      return value;
    case 'Time':
      if (typeof value !== 'string' || !TIME.test(value)) fail('debug_o11_native_input_type_mismatch:' + path);
      return value;
    case 'DateTime': {
      const m = typeof value === 'string' ? DATETIME.exec(value) : null;
      if (!m || !validDate(m[1])) fail('debug_o11_native_input_type_mismatch:' + path);
      return new Date(value).toISOString().replace(/\.000Z$/, 'Z');
    }
    case 'Record': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('debug_o11_native_input_type_mismatch:' + path);
      const record = {};
      for (const [key, inner] of Object.entries(value)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(key) || SENSITIVE.test(key)) fail('debug_o11_native_input_private_or_invalid:' + path + '.' + key);
        record[key] = canonicalJson(inner, path + '.' + key, depth + 1);
      }
      return record;
    }
    case 'RecordList':
      if (!Array.isArray(value) || value.length > 1000) fail('debug_o11_native_input_type_mismatch:' + path);
      return value.map((item, i) => canonicalValue({ base: 'Record', of: type.of }, item, path + '[' + i + ']', depth + 1));
    default:
      fail('debug_o11_native_input_type_unsupported:' + type.base + ':' + path);
  }
}
// Record attributes are typed by the original record class inside the worker; here only JSON shape and privacy.
function canonicalJson(value, path, depth) {
  if (depth > 6) fail('debug_o11_native_input_too_deep:' + path);
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('debug_o11_native_input_type_mismatch:' + path);
    if (typeof value === 'string' && (value.length > 8192 || /^Bearer\s|^eyJ[A-Za-z0-9_-]{8,}\./.test(value))) fail('debug_o11_native_input_type_mismatch:' + path);
    return value;
  }
  if (Array.isArray(value)) { if (value.length > 1000) fail('debug_o11_native_input_type_mismatch:' + path); return value.map((v, i) => canonicalJson(v, path + '[' + i + ']', depth + 1)); }
  if (typeof value === 'object') return canonicalValue({ base: 'Record' }, value, path, depth);
  fail('debug_o11_native_input_type_mismatch:' + path);
}

// One scenario's inputs against the parameters the chosen entry controls. Unknown, private or uncontrollable
// names refuse before any window; omitted inputs keep the type default (recorded in `presence`).
export function canonicalScenario(parameters, inputs = {}) {
  const byName = new Map(parameters.map(p => [p.name, p]));
  for (const name of Object.keys(inputs)) {
    if (SENSITIVE.test(name)) fail('debug_o11_native_input_private_or_invalid:' + name);
    if (!byName.has(name)) fail('debug_o11_native_input_unknown:' + name);
    if (byName.get(name).controllable === false) fail('debug_o11_native_input_not_controllable:' + name);
  }
  const values = {}, presence = {};
  for (const parameter of parameters) {
    if (!(parameter.name in inputs)) {
      if (parameter.mandatory && parameter.controllable !== false) fail('debug_o11_native_input_required_missing:' + parameter.name);
      presence[parameter.name] = 'omitted'; continue;
    }
    const value = canonicalValue(o11TypeOf(parameter), inputs[parameter.name], parameter.name);
    presence[parameter.name] = value === null ? 'null' : 'value';
    if (value !== null) values[parameter.name] = value;
  }
  return { values, presence };
}
export const o11SensitiveName = name => SENSITIVE.test(name ?? '');
