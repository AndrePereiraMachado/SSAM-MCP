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

// A compiled class reference: "OS.DataTypes.IntegerList" (runtime basic list) or "<Alias>.<Class>" -> "<define of Alias>$<Class>".
function classRef(text, aliases) {
  const runtime = /^OS\.DataTypes\.([A-Z]\w*List)$/.exec(text ?? '');
  if (runtime) return 'runtime:' + runtime[1];
  const ref = /^([\w$]+)\.([\w$]+)$/.exec(text ?? '');
  return ref && aliases[ref[1]] ? aliases[ref[1]] + '$' + ref[2] : undefined;
}
function registrations(body, aliases = {}) {
  const groups = {}; let match;
  REGISTER.lastIndex = 0;
  while ((match = REGISTER.exec(body))) {
    const open = match.index + match[0].length - 1, close = matchingBrace(body, open, '[', ']');
    const list = body.slice(open + 1, close);
    groups[match[1]] = splitArguments(list).map(item => {
      const m = /^\{\s*name: "([^"]+)",\s*attrName: "([^"]+)",\s*mandatory: (true|false),\s*dataType: OS\.DataTypes\.DataTypes\.(\w+)/.exec(item);
      if (!m) return null;
      const complexType = classRef(/\bcomplexType: ([\w$.]+)\s*\}$/.exec(item)?.[1], aliases);
      return { name: m[1], attribute: m[2], mandatory: m[3] === 'true', dataType: m[4], ...(complexType ? { complexType } : {}) };
    }).filter(Boolean);
  }
  return groups;
}

// Record and list classes of a model define ("<M>.model$XRec", "<M>.model$XList", and the anonymous "<M>.model$" that holds
// the module's basic Text List). Keyed "<model define>$<Class>" as the class is published on its model module.
function modelClasses(define, body, aliases) {
  const classes = {}, declaration = /\bvar ([A-Za-z_$][\w$]*) = \(function \(_super\) \{/g; let match;
  while ((match = declaration.exec(body))) {
    const name = match[1], open = match.index + match[0].length - 1, close = matchingBrace(body, open);
    if (close < 0) continue;
    const kind = /^\)\(OS\.DataTypes\.(GenericRecord|GenericRecordList)\);/.exec(body.slice(close + 1, close + 60))?.[1];
    const published = new RegExp('(?:^|\\n)([\\w$]+)\\.' + name.replace(/\$/g, '\\$') + ' = ' + name.replace(/\$/g, '\\$') + ';').exec(body.slice(close));
    if (!kind || !published || !aliases[published[1]]) continue;
    const block = body.slice(open, close + 1), key = aliases[published[1]] + '$' + name;
    if (kind === 'GenericRecordList') {
      const item = new RegExp(name.replace(/\$/g, '\\$') + '\\.itemType = ([\\w$.]+);').exec(block)?.[1] ?? '';
      const basic = /^OS\.DataTypes\.DataTypes\.(\w+)$/.exec(item)?.[1], recordClass = basic ? undefined : classRef(item, aliases);
      if (basic || recordClass) classes[key] = { define, kind: 'list', itemType: basic ? { dataType: basic } : { recordClass } };
      continue;
    }
    const declared = /\.attributesToDeclare = function \(\) \{/.exec(block);
    if (!declared) continue;
    const start = declared.index + declared[0].length - 1, attributes = [], record = block.slice(start, matchingBrace(block, start) + 1), attr = /this\.attr\(/g;
    let found;
    while ((found = attr.exec(record))) {
      const at = found.index + found[0].length - 1, args = splitArguments(record.slice(at + 1, matchingBrace(record, at, '(', ')')));
      const text = i => /^"([^"]*)"$/.exec(args[i] ?? '')?.[1], dataType = /^OS\.DataTypes\.DataTypes\.(\w+)$/.exec(args[5] ?? '')?.[1];
      if (!text(0) || !text(1) || !dataType) { attributes.length = 0; break; }
      // attr(name, attrName, nameForJson, mandatory, ignoreForServer, dataType, default, optimizeList?, complexType?)
      const complexType = classRef(/^(true|false)$/.test(args[7] ?? '') ? args[8] : args[7], aliases);
      attributes.push({ name: text(0), attribute: text(1), jsonName: text(2) ?? text(0), mandatory: args[3] === 'true', ignoreForServer: args[4] === 'true',
        dataType, ...(complexType ? { complexType } : {}) });
    }
    if (attributes.length) classes[key] = { define, kind: 'record', attributes };
  }
  return classes;
}
const pushOf = body => {
  const m = new RegExp(`OutSystemsDebugger\\.push\\("(${KEY}):(${KEY}):([^"]*)", "([^"]*)", "([^"]*)", "([^"]*)"`).exec(body);
  return m ? { moduleKey: m[1], key: m[2], keyPath: m[3], moduleName: m[4], name: m[5], flowKind: m[6] } : null;
};
const breakpointsOf = body => [...new Set([...body.matchAll(new RegExp(`OutSystemsDebugger\\.handleBreakpoint\\("(${KEY}):(${KEY})"`, 'g'))].map(m => m[2]))];

// Only the component's VariablesRecord is owner state. Data-source records declared earlier in the same
// factory contain outputs, not writable screen variables. The original setInputs method defines input names.
function componentState(body, aliases) {
  const declaration = /VariablesRecord\.attributesToDeclare = function \(\) \{/.exec(body);
  if (!declaration) return { variables: [], context: { inputs: [], variables: [] } };
  const start = declaration.index + declaration[0].length - 1;
  const record = body.slice(start, matchingBrace(body, start) + 1), variables = [];
  const attribute = /this\.attr\(/g; let match;
  while ((match = attribute.exec(record))) {
    const open = match.index + match[0].length - 1, args = splitArguments(record.slice(open + 1, matchingBrace(record, open, '(', ')')));
    const name = /^"([A-Za-z_][\w]*)"$/.exec(args[0] ?? '')?.[1], attr = /^"([A-Za-z_][\w]*)"$/.exec(args[1] ?? '')?.[1];
    const dataType = /^OS\.DataTypes\.DataTypes\.(\w+)$/.exec(args[5] ?? '')?.[1];
    if (!name || !attr || name.startsWith('_') || args[4] !== 'false' || !dataType) continue;
    const complexType = classRef(args[8], aliases), runtimeList = complexType?.startsWith('runtime:') ? complexType.slice(8) : null;
    variables.push({ name, attribute: attr, dataType, ...(runtimeList && O11_RUNTIME_LISTS[runtimeList] ? { runtimeList, element: O11_RUNTIME_LISTS[runtimeList] }
      : complexType && !runtimeList ? { recordClass: complexType } : {}) });
  }
  const setter = /Model\.prototype\.setInputs = function \(inputs\) \{/.exec(body);
  const setterStart = setter ? setter.index + setter[0].length - 1 : -1;
  const setterBody = setter ? body.slice(setterStart, matchingBrace(body, setterStart) + 1) : '';
  const inputs = variables.filter(v => new RegExp('"' + v.name + '" in inputs').test(setterBody)).map(v => ({ ...v,
    wireInput: new RegExp('this\\.variables\\.' + v.attribute + ' = OS\\.DataConversion\\.ServerDataConverter\\.from\\(inputs\\.' + v.name + '[,)]').test(setterBody) }));
  return { variables, context: { inputs, variables: variables.filter(v => !inputs.some(i => i.attribute === v.attribute)) } };
}

function lifecycleBindings(body) {
  const result = [], pattern = /Controller\.prototype\.(on(?:Initialize|Ready|Render|Destroy|ParametersChanged)EventHandler) = function \(callContext\) \{/g;
  let match;
  while ((match = pattern.exec(body))) {
    const open = match.index + match[0].length - 1, inner = body.slice(open + 1, matchingBrace(body, open));
    const calls = [...inner.matchAll(/return controller\.([A-Za-z_$][\w$]*\$Action)\(callContext\)/g)];
    if (calls.length === 1) result.push({ event: match[1].slice(0, -'EventHandler'.length).replace(/^on/, 'On'), handler: match[1], method: calls[0][1] });
  }
  return result;
}

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
  // JS nodes receive native action proxies as an explicit map. Their calls may be asynchronous without the
  // JS node returning the promise; retain the edge and let the private worker await the original proxy.
  for (const proxy of body.matchAll(/\bcontroller\.clientActionProxies\.([A-Za-z_$][\w$]*)\$Action\b/g)) {
    if (!calls.some(c => c.target === proxy[1] && c.kind === 'Action' && c.via === 'self'))
      calls.push({ target: proxy[1], kind: 'Action', via: 'self', viaVariable: null, args: [], proxy: true });
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
  const out = { module, stubs: [], dataActions: [], clientActions: [], components: {}, definedIn: {}, defines: {}, classes: {} };
  for (const asset of [...assets].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    for (const d of defines(asset.text)) {
      if (!(d.name in out.definedIn)) out.definedIn[d.name] = asset.name;
      out.defines[d.name] = { deps: d.deps, asset: asset.name };
      const vars = Object.fromEntries(d.params.map((p, i) => [p, d.deps[i]]));
      if (/\.model\$[\w$]*$/.test(d.name)) for (const [key, value] of Object.entries(modelClasses(d.name, d.body, vars))) out.classes[key] ??= value;
      const mvc = /^(.+)\.mvc\$(model|view|controller)$/.exec(d.name);
      if (mvc && mvc[1].startsWith(module + '.')) {
        const owner = mvc[1].slice(module.length + 1), component = out.components[owner] ??= { owner, amd: mvc[1] };
        if (mvc[2] === 'model') {
          component.viewName = /new OS\.Model\.ModelFactory\(Model, "([^"]+)"\)/.exec(d.body)?.[1] ?? null;
          Object.assign(component, componentState(d.body, vars));
        }
        if (mvc[2] === 'view') {
          // The generated base class is authoritative, including screens whose title is empty/dynamic.
          // The title fallback supports old cached compiler shapes with no explicit BaseWebScreen token.
          component.screen = /OSView\.BaseView\.BaseWebScreen\b/.test(d.body) ||
            !/OSView\.BaseView\.BaseWebBlock\b/.test(d.body) && /Object\.defineProperty\(View\.prototype, "title", \{\s*get: function \(\) \{\s*return "(?:[^"\\]|\\.)+";/.test(d.body);
          component.blocks = d.deps.filter(n => /\.mvc\$view$/.test(n)).map(n => n.slice(0, -'.mvc$view'.length));
        }
        if (mvc[2] === 'controller') component.lifecycle = lifecycleBindings(d.body);
      }
      const owner = controllerOwner(d.name, module);
      if (!owner) continue;
      const groups = registrations(d.body, vars);
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
            inputs: inputs.map(p => { const v = varsGroup.find(g => g.attribute === p + 'Local'); return { param: p, name: v?.name ?? null, dataType: v?.dataType ?? null,
              mandatory: v?.mandatory ?? false, ...(v?.complexType ? { complexType: v.complexType } : {}) }; }),
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
// SSAM transport caps, not OutSystems limits: the JSON of one value and of a scenario's whole inputs, and the POST envelope
// the private worker accepts (submitScenarioPost). Inline Binary base64 inherits the value budget. Exposed, never raised.
export const O11_NATIVE_INPUT_BYTES = 128 * 1024;
export const O11_NATIVE_ENVELOPE_BYTES = 256 * 1024;
export const O11_NATIVE_BINARY_INPUT_BYTES = Math.floor((O11_NATIVE_INPUT_BYTES - 2) / 4) * 3;
function inputBudget(value, path) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail('debug_o11_native_input_transport_budget:' + path); }
  if (encoded !== undefined && Buffer.byteLength(encoded) > O11_NATIVE_INPUT_BYTES)
    fail('debug_o11_native_input_transport_budget:' + path);
}

const BASIC_TYPES = Object.freeze({ 'Text': 'Text', 'Integer': 'Integer', 'Long Integer': 'LongInteger', 'Decimal': 'Decimal', 'Currency': 'Currency',
  'Boolean': 'Boolean', 'Date': 'Date', 'Time': 'Time', 'Date Time': 'DateTime', 'Email': 'Email', 'Phone Number': 'PhoneNumber',
  'Binary Data': 'BinaryData', 'Object': 'Object' });
const SCALARS = new Set(['Text', 'Email', 'PhoneNumber', 'Integer', 'LongInteger', 'Decimal', 'Currency', 'Boolean', 'BinaryData', 'Date', 'Time', 'DateTime']);
const IDENTIFIER_BASES = new Set(['LongInteger', 'Integer', 'Text']);
const RECORD_KINDS = ['ServerEntity', 'Entity', 'StaticEntity', 'Structure', 'ServerStructure', 'StructureSignature', 'EntitySignature', 'AnonymousStructure'];
// Basic lists of the published runtime (OS.DataTypes.<X>List in OutSystems.js); the worker checks their itemType.
export const O11_RUNTIME_LISTS = Object.freeze(Object.fromEntries(['Text', 'Integer', 'LongInteger', 'Decimal', 'Currency', 'Boolean', 'Date', 'Time',
  'DateTime', 'Email', 'PhoneNumber', 'BinaryData'].map(type => [type + 'List', type])));

// Model DataType ("BasicType:Text", "IdentifierType:Order Identifier", "ServerEntity:Order", "Structure:X", "ListType:Text List")
// or asset DataTypes name -> { base, of?, element?, recordClass? }. An identifier takes the published asset type or the
// entity reference base (debug-o11-entry-graph.mjs o11IdentifierBase); without one it refuses instead of guessing.
export function o11TypeOf(parameter) {
  const asset = parameter.dataType && DATA_TYPES[parameter.dataType] !== undefined ? parameter.dataType : null;
  const model = parameter.modelType ?? null; // e.g. "BasicType:Long Integer"
  const recordClass = parameter.recordClass ? { recordClass: parameter.recordClass } : {};
  if (model) {
    const [kind, name = ''] = model.split(':');
    if (kind === 'BasicType' && BASIC_TYPES[name]) return { base: BASIC_TYPES[name] };
    if (kind === 'IdentifierType') {
      const base = asset ?? parameter.identifierBase ?? null;
      if (!IDENTIFIER_BASES.has(base)) fail('debug_o11_native_identifier_base_unresolved:' + (parameter.name ?? name));
      return { base, identifier: name };
    }
    if (/List$/.test(kind) || /List$/.test(name) || parameter.list) {
      const element = parameter.element ?? (parameter.recordClass ? null : BASIC_TYPES[name.replace(/ List$/, '')]);
      return { base: 'RecordList', of: name, ...(element ? { element: { base: element } } : {}), ...recordClass };
    }
    if (RECORD_KINDS.includes(kind)) return { base: 'Record', of: name, ...recordClass };
  }
  if (asset === 'RecordList') return { base: asset, ...(parameter.element ? { element: { base: parameter.element } } : {}), ...recordClass };
  if (asset) return { base: asset, ...(asset === 'Record' ? recordClass : {}) };
  return { base: 'Unknown' };
}

// Class of a Record/RecordList input, from the published assets only: the entry's own complexType when the asset declares
// one, else the model type against parsed.classes (this module first, then one unique class of another module). A list
// whose published itemType is a basic type uses the runtime OS.DataTypes.<X>List: the original converter cannot
// instantiate a module GenericRecordList of a basic type (the "<M>.model$" TextList). A "Text List" whose module class
// lists a Text STRUCTURE stays a record list: the published itemType decides, not the name.
export function o11InputClassFor(parsed, module, input) {
  if (!['Record', 'RecordList'].includes(input.dataType)) return undefined;
  const classes = parsed.classes ?? {}, kind = input.dataType === 'Record' ? 'record' : 'list';
  const unresolved = () => fail('debug_o11_native_record_class_unresolved:' + input.name);
  const runtime = name => kind === 'list' && O11_RUNTIME_LISTS[name] ? { runtimeList: name, element: O11_RUNTIME_LISTS[name] } : null;
  const published = key => classes[key]?.kind !== kind ? null
    : classes[key].itemType?.dataType ? runtime(classes[key].itemType.dataType + 'List') : { recordClass: key };
  if (input.complexType) return (input.complexType.startsWith('runtime:') ? runtime(input.complexType.slice(8)) : published(input.complexType)) ?? unresolved();
  const name = (input.modelType ?? '').split(':').slice(1).join(':');
  if (!name) unresolved();
  const compact = name.replace(/\s+/g, ''), of = name.replace(/ Record$/, '').replace(/\s+/g, '');
  const candidates = kind === 'record' ? [of + 'Rec', of + 'Record'] : [compact, compact.replace(/List$/, 'RecordList')];
  for (const candidate of candidates) {
    const own = classes[module + '.model$' + candidate];
    if (own?.kind === kind && !own.itemType?.dataType) return { recordClass: module + '.model$' + candidate };
  }
  const basic = kind === 'list' ? BASIC_TYPES[name.replace(/ List$/, '')] : null;
  if (basic) return runtime(basic + 'List') ?? unresolved();
  const others = Object.keys(classes).filter(key => classes[key].kind === kind && candidates.some(c => key.endsWith('.model$' + c))).sort();
  if (others.length > 1) fail('debug_o11_native_record_class_ambiguous:' + input.name);
  return (others.length ? published(others[0]) : null) ?? unresolved();
}

function recordSchema(type, path) {
  if (!type.schemas) return null;
  const schema = type.schemas[type.recordClass];
  if (schema?.kind !== 'record') fail('debug_o11_native_record_schema_unresolved:' + path);
  return schema;
}
function listType(ref, schemas) {
  const element = typeof ref === 'string' && ref.startsWith('runtime:') ? O11_RUNTIME_LISTS[ref.slice(8)] : null;
  return element ? { base: 'RecordList', element: { base: element } } : { base: 'RecordList', recordClass: ref, schemas };
}
function attributeType(attribute, schemas) {
  if (attribute.dataType === 'Record') return { base: 'Record', recordClass: attribute.complexType, schemas };
  if (attribute.dataType === 'RecordList') return listType(attribute.complexType, schemas);
  return { base: attribute.dataType };
}
function listElement(type, path) {
  if (type.element) return type.element;
  if (!type.schemas) return { base: 'Record', of: type.of }; // untyped: the worker's class check types the attributes
  const schema = type.schemas[type.recordClass];
  if (schema?.kind !== 'list') fail('debug_o11_native_record_schema_unresolved:' + path);
  return schema.itemType.dataType ? { base: schema.itemType.dataType } : { base: 'Record', recordClass: schema.itemType.recordClass, schemas: type.schemas };
}

export function canonicalValue(type, value, path = 'value', depth = 0) {
  if (depth > 32) fail('debug_o11_native_input_too_deep:' + path);
  const canonical = typedValue(type, value, path, depth);
  if (depth === 0) inputBudget(value, path);
  return canonical;
}
function typedValue(type, value, path, depth) {
  if (value === null || value === undefined) return null;
  switch (type.base) {
    case 'Text': case 'Email': case 'PhoneNumber':
      if (typeof value !== 'string' || /^Bearer\s|^eyJ[A-Za-z0-9_-]{8,}\./.test(value)) fail('debug_o11_native_input_type_mismatch:' + path);
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
    case 'BinaryData': {
      // The original ServerDataConverter accepts inline base64 content. Do not
      // admit URL-backed objects, which would introduce a separate fetch.
      if (typeof value !== 'string') fail('debug_o11_native_input_type_mismatch:' + path);
      const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
      if (Math.floor(value.length * 3 / 4) - padding > O11_NATIVE_BINARY_INPUT_BYTES) fail('debug_o11_native_input_binary_too_large:' + path);
      if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || Buffer.from(value, 'base64').toString('base64') !== value)
        fail('debug_o11_native_input_type_mismatch:' + path);
      return value;
    }
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
      // Typed by the published record schema (parsed.classes) when the caller binds one; untyped JSON otherwise.
      const schema = recordSchema(type, path), record = {};
      for (const [key, inner] of Object.entries(value)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,120}$/.test(key) || SENSITIVE.test(key)) fail('debug_o11_native_input_private_or_invalid:' + path + '.' + key);
        if (!schema) { record[key] = canonicalJson(inner, path + '.' + key, depth + 1); continue; }
        const attribute = schema.attributes.find(a => a.name === key);
        if (!attribute) fail('debug_o11_native_input_unknown_attribute:' + path + '.' + key);
        record[key] = canonicalValue(attributeType(attribute, type.schemas), inner, path + '.' + key, depth + 1);
      }
      return record;
    }
    case 'RecordList': {
      if (!Array.isArray(value)) fail('debug_o11_native_input_type_mismatch:' + path);
      const element = listElement(type, path);
      if (element.base !== 'Record' && !SCALARS.has(element.base)) fail('debug_o11_native_input_type_unsupported:' + element.base + ':' + path);
      return value.map((item, i) => {
        // Basic-type lists hold only scalars of the element type; a typed list never holds a null item.
        if (element.base !== 'Record' && (item === null || item === undefined || typeof item === 'object') ||
            element.schemas && (item === null || item === undefined)) fail('debug_o11_native_input_type_mismatch:' + path + '[' + i + ']');
        return canonicalValue(element, item, path + '[' + i + ']', depth + 1);
      });
    }
    default:
      fail('debug_o11_native_input_type_unsupported:' + type.base + ':' + path);
  }
}
// Untyped record attributes (no schema bound) are typed by the original record class inside the worker; here only JSON shape and privacy.
function canonicalJson(value, path, depth) {
  if (depth > 32) fail('debug_o11_native_input_too_deep:' + path);
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('debug_o11_native_input_type_mismatch:' + path);
    if (typeof value === 'string' && /^Bearer\s|^eyJ[A-Za-z0-9_-]{8,}\./.test(value)) fail('debug_o11_native_input_type_mismatch:' + path);
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => canonicalJson(v, path + '[' + i + ']', depth + 1));
  if (typeof value === 'object') return canonicalValue({ base: 'Record' }, value, path, depth);
  fail('debug_o11_native_input_type_mismatch:' + path);
}

// One scenario's inputs against the parameters the chosen entry controls. Unknown, private or uncontrollable
// names refuse before any window; omitted inputs keep the type default (recorded in `presence`). With `schemas`
// (parseO11Assets().classes) every Record/RecordList parameter must name its published class; `classFor`
// (p => o11InputClassFor(parsed, module, p)) resolves it only for supplied values, so an omitted input never refuses.
export function canonicalScenario(parameters, inputs = {}, { schemas, classFor } = {}) {
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
    let type = o11TypeOf(parameter);
    if (classFor && ['Record', 'RecordList'].includes(type.base) && !parameter.recordClass && !parameter.element)
      type = o11TypeOf({ ...parameter, ...classFor({ ...parameter, dataType: type.base }) });
    if (schemas && ['Record', 'RecordList'].includes(type.base)) type.schemas = schemas;
    const value = canonicalValue(type, inputs[parameter.name], parameter.name);
    presence[parameter.name] = value === null ? 'null' : 'value';
    if (value !== null) values[parameter.name] = value;
  }
  // Each value fits its own budget first (specific refusals); the scenario's inputs then share the same JSON budget.
  inputBudget(inputs, 'inputs');
  return { values, presence };
}
export const o11SensitiveName = name => SENSITIVE.test(name ?? '');
