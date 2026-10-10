// Static index of a published ODC reactive app (its public JS chunks), keyed by MODEL KEY.
// Every generated stub carries a telemetry span with outsystems.function.key = the GUID of the model element; the
// GUID in .NET byte order, base64 with '/' -> '_', is the model key. Names are never used to admit an entry: the
// join between the published model and the published runtime is that key. Nothing here executes app code.
import { parse } from 'acorn';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_+]{22}$/;
const CALLS = { callServerAction: 'server-action', callDataAction: 'data-action' };

// GUID <-> model key (inverse pair, also used for module/owner keys).
export function guidToKey(guid) {
  if (!GUID.test(guid ?? '')) throw new Error('debug_odc_native_guid_invalid');
  const hex = guid.replace(/-/g, ''), le = s => s.match(/../g).reverse().join('');
  return Buffer.from(le(hex.slice(0, 8)) + le(hex.slice(8, 12)) + le(hex.slice(12, 16)) + hex.slice(16), 'hex').toString('base64').replace(/=+$/, '').replace(/\//g, '_');
}
export function keyToGuid(key) {
  if (!KEY.test(key ?? '')) throw new Error('debug_odc_native_key_invalid');
  const hex = Buffer.from(key.replace(/_/g, '/') + '==', 'base64').toString('hex'), le = s => s.match(/../g).reverse().join('');
  return [le(hex.slice(0, 8)), le(hex.slice(8, 12)), le(hex.slice(12, 16)), hex.slice(16, 20), hex.slice(20)].join('-');
}

function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parents);
  parents.push(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const child of value) if (child && typeof child.type === 'string') walk(child, visit, parents); }
    else if (value && typeof value.type === 'string') walk(value, visit, parents);
  }
  parents.pop();
}
const str = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
const prop = node => node?.type === 'MemberExpression' && !node.computed ? node.property.name : node?.type === 'MemberExpression' ? str(node.property) : null;
const keyName = node => node?.type === 'Identifier' ? node.name : str(node);
// d.DataTypes.Text -> 'Text'; x.getGenericList(T) -> 'RecordList'; anything else -> 'Record' (a record/structure type).
function dataTypeOf(node) {
  if (node?.type === 'MemberExpression' && prop(node.object) === 'DataTypes') return prop(node);
  if (node?.type === 'CallExpression' && prop(node.callee) === 'getGenericList') return 'RecordList';
  if (node?.type === 'ObjectExpression') { const dt = node.properties.find(p => keyName(p.key) === 'dataType'); return dt ? dataTypeOf(dt.value) : null; }
  return node ? 'Record' : null;
}
function holderOf(parents) {
  for (let i = parents.length - 1; i >= 0; i--) {
    const node = parents[i];
    if (node.type === 'MethodDefinition') return { kind: node.kind === 'get' ? 'getter' : 'method', name: keyName(node.key), params: node.value.params, node };
    if (node.type === 'FunctionDeclaration') return { kind: 'function', local: node.id?.name, params: node.params, node };
  }
  return null;
}
function classOf(parents) {
  for (let i = parents.length - 1; i >= 0; i--) if (parents[i].type === 'ClassExpression' || parents[i].type === 'ClassDeclaration') return parents[i];
  return null;
}

// One chunk: spans, stubs, variable groups, keep-name map, factories and exports.
export function indexChunk(file, source) {
  let ast;
  try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true }); }
  catch { throw new Error('debug_odc_native_chunk_unparsable: ' + file); }
  const keepNames = new Map(), spans = [], groups = [], factories = [], exports = new Map(), classTargets = new Map();
  walk(ast, (node, parents) => {
    if (node.type === 'ExportNamedDeclaration' && !node.declaration) for (const s of node.specifiers) exports.set(keyName(s.exported), keyName(s.local));
    if (node.type === 'CallExpression') {
      const name = prop(node.callee);
      // a(fn, "name$Action"): the generator's keep-name helper gives a function its runtime name.
      if (node.callee.type === 'Identifier' && node.arguments.length === 2 && node.arguments[0].type === 'Identifier' && str(node.arguments[1]))
        keepNames.set(node.arguments[0].name, str(node.arguments[1]));
      if (name === 'registerVariableGroupType' && str(node.arguments[0]) && node.arguments[1]?.type === 'ArrayExpression')
        groups.push({ name: str(node.arguments[0]), attributes: node.arguments[1].elements.map(e => {
          const get = k => e.properties?.find(p => keyName(p.key) === k)?.value;
          return { name: str(get('name')), attrName: str(get('attrName')), dataType: dataTypeOf(get('dataType')), mandatory: get('mandatory')?.type === 'UnaryExpression' ? !get('mandatory').argument.value : !!get('mandatory')?.value };
        }) });
      if (name === 'startActiveSpan' && str(node.arguments[0]) && /Function/.test(node.arguments[1]?.type ?? '')) spans.push({ node, parents: [...parents] });
    }
    if (node.type === 'NewExpression' && /^(ControllerFactory|ModelFactory)$/.test(prop(node.callee) ?? node.callee.name ?? '')) {
      const declarator = parents.at(-1)?.type === 'VariableDeclarator' ? parents.at(-1) : null;
      factories.push({ kind: (prop(node.callee) ?? node.callee.name) === 'ControllerFactory' ? 'controller' : 'model', local: declarator?.id?.name ?? null,
        classLocal: node.arguments[0]?.type === 'Identifier' ? node.arguments[0].name : null, start: node.start });
    }
    // {let i=class i extends ...{...}; ...; let r=i; Wn=r}: the class reaches the factory argument through local aliases.
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && node.right.type === 'Identifier') classTargets.set(node.right.name + '@' + node.start, node.left.name);
  });
  const records = [];
  for (const { node, parents } of spans) {
    const body = node.arguments[1].body, attrs = {};
    let call = null, outputGroup = null; const outputs = [], dataActVars = new Set(), groupsUsed = [];
    walk(body, n => {
      if (n.type === 'CallExpression' && prop(n.callee) === 'setAttribute' && str(n.arguments[0]) && str(n.arguments[1])) attrs[str(n.arguments[0])] = str(n.arguments[1]);
    });
    const holder = holderOf(parents), cls = classOf(parents);
    // The stub body is the holder function (method/getter/function), not only the span callback.
    walk(holder?.node ?? body, n => {
      if (n.type === 'CallExpression' && CALLS[prop(n.callee)] && str(n.arguments[1])) {
        const kind = CALLS[prop(n.callee)];
        call = { kind, name: str(n.arguments[0]), endpoint: str(n.arguments[1]), apiVersion: str(n.arguments[2]), inputs: [] };
        let objectArg = n.arguments[3];
        if (objectArg?.type === 'Identifier') { const id = objectArg.name; objectArg = null; walk(holder?.node ?? body, d => { if (d.type === 'VariableDeclarator' && d.id.type === 'Identifier' && d.id.name === id && d.init?.type === 'ObjectExpression') objectArg = d.init; }); }
        if (kind === 'server-action' && objectArg?.type === 'ObjectExpression') {
          const params = (holder?.params ?? []).map(p => p.type === 'Identifier' ? p.name : null);
          for (const p of objectArg.properties) {
            const value = p.value, arg = value?.type === 'CallExpression' && prop(value.callee) === 'to' ? value.arguments : null;
            call.inputs.push({ wire: keyName(p.key), position: arg?.[0]?.type === 'Identifier' ? params.indexOf(arg[0].name) : -1, dataType: arg ? dataTypeOf(arg[1]) : null });
          }
        }
      }
      if (n.type === 'CallExpression' && prop(n.callee) === 'getVariableGroupType' && str(n.arguments[0])) { const g = str(n.arguments[0]); if (!groupsUsed.includes(g)) groupsUsed.push(g); if (!/\$(vars|outVars)$/.test(g)) outputGroup ??= g; }
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.right.type === 'CallExpression' && prop(n.right.callee) === 'from' && prop(n.right.arguments[0]))
        outputs.push({ attrName: prop(n.left), wire: prop(n.right.arguments[0]), dataType: dataTypeOf(n.right.arguments[1]) });
      if (n.type === 'MemberExpression' && prop(n.object) === 'variables' && /DataAct$/.test(prop(n) ?? '')) dataActVars.add(prop(n));
    });
    const guid = attrs['outsystems.function.key'];
    if (!GUID.test(guid ?? '')) continue;
    records.push({ key: guidToKey(guid), guid, name: attrs['code.function'] ?? str(node.arguments[0]), type: attrs['outsystems.function.type'] ?? null,
      ownerKey: GUID.test(attrs['outsystems.function.owner.key'] ?? '') ? guidToKey(attrs['outsystems.function.owner.key']) : null,
      ownerName: attrs['outsystems.function.owner.name'] ?? null, chunk: file,
      holder: holder ? { kind: holder.kind, name: holder.kind === 'function' ? keepNames.get(holder.local) ?? holder.local : holder.name, local: holder.local ?? null, params: holder.params.length } : null,
      classStart: cls?.start ?? null, call, outputGroup, varsGroup: groupsUsed.find(g => g.endsWith('$vars')) ?? null, outVarsGroup: groupsUsed.find(g => g.endsWith('$outVars')) ?? null, outputs: outputs.length ? outputs : null, dataActVar: dataActVars.size === 1 ? [...dataActVars][0] : null });
  }
  // Class -> controller factory: follow the alias chain of the class expression into a ControllerFactory argument.
  const classFactory = new Map();
  if (records.some(r => r.classStart != null)) {
    const declared = new Map(), wanted = new Set(records.map(r => r.classStart).filter(s => s != null));
    walk(ast, (node, parents) => {
      if ((node.type === 'ClassExpression' || node.type === 'ClassDeclaration') && wanted.has(node.start)) {
        // nearest enclosing BlockStatement: aliases are assigned inside it.
        const block = [...parents].reverse().find(p => p.type === 'BlockStatement' || p.type === 'Program');
        const names = new Set([node.id?.name, parents.at(-1)?.type === 'VariableDeclarator' ? parents.at(-1).id.name : null].filter(Boolean));
        let grown = true;
        while (grown) { grown = false; walk(block, n => {
          if (n.type === 'VariableDeclarator' && n.init?.type === 'Identifier' && names.has(n.init.name) && !names.has(n.id.name)) { names.add(n.id.name); grown = true; }
          if (n.type === 'AssignmentExpression' && n.right.type === 'Identifier' && names.has(n.right.name) && n.left.type === 'Identifier' && !names.has(n.left.name)) { names.add(n.left.name); grown = true; }
        }); }
        declared.set(node.start, names);
      }
    });
    for (const [start, names] of declared) {
      const factory = factories.filter(f => f.kind === 'controller' && names.has(f.classLocal));
      if (factory.length === 1) classFactory.set(start, factory[0].local);
    }
  }
  for (const r of records) r.controllerFactory = r.classStart != null ? classFactory.get(r.classStart) ?? null : null;
  return { file, records, groups, exports: Object.fromEntries(exports), keepNames: Object.fromEntries(keepNames),
    factories: factories.map(({ kind, local, classLocal, start }) => ({ kind, local, classLocal, start })), imports: importsOf(ast) };
}

function importsOf(ast) {
  return ast.body.filter(n => n.type === 'ImportDeclaration').map(n => ({ specifier: n.source.value,
    names: n.specifiers.map(s => ({ imported: s.type === 'ImportSpecifier' ? keyName(s.imported) : s.type === 'ImportDefaultSpecifier' ? 'default' : '*', local: s.local.name })) }));
}

// The app bootstrap (_osbundle-<App>.index__*.js): route table and the ORIGINAL init chain, as source slices.
// The chain is OutSystemsDebugger.initialize().then(stage1).then(stage2)...; the last stage starts the view and is
// not run headless. The generated init module keeps the bootstrap's own imports and declarations verbatim and only
// replaces the final chain by an exported function that runs the stages before the view.
export function indexBootstrap(file, source) {
  let ast;
  try { ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }); } catch { throw new Error('debug_odc_native_bootstrap_unparsable'); }
  const routes = [];
  walk(ast, node => {
    if (node.type !== 'ObjectExpression') return;
    const screen = node.properties.find(p => keyName(p.key) === 'screenName'), lazy = node.properties.find(p => keyName(p.key) === 'lazyComponentInfo');
    if (!str(screen?.value) || !lazy) return;
    let chunk = null; walk(lazy.value, n => { if (n.type === 'ImportExpression' && str(n.source)) chunk = str(n.source).replace(/^\.\//, ''); });
    routes.push({ screenName: str(screen.value), chunk, default: node.properties.some(p => keyName(p.key) === 'forDefaultPath' && p.value.type === 'UnaryExpression' && p.value.argument.value === 0) });
  });
  // Find the statement holding OutSystemsDebugger.initialize() and unroll its .then chain.
  const statement = ast.body.find(n => n.type === 'ExpressionStatement' && source.slice(n.start, n.end).includes('OutSystemsDebugger.initialize()'));
  if (!statement) throw new Error('debug_odc_native_bootstrap_chain_missing');
  const stages = [];
  let node = statement.expression;
  while (node?.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
    const method = prop(node.callee);
    if (method === 'then' && /Function/.test(node.arguments[0]?.type ?? '')) {
      const fn = node.arguments[0], ret = fn.body.type === 'BlockStatement' ? fn.body.body.find(s => s.type === 'ReturnStatement')?.argument : fn.body;
      stages.unshift({ text: ret ? source.slice(ret.start, ret.end) : null, view: source.slice(fn.start, fn.end).includes('staticScreenRoutes') });
    } else if (method !== 'catch') break;
    node = node.callee.object;
  }
  if (!stages.length || stages.some(s => !s.text) || !stages.at(-1).view || stages.slice(0, -1).some(s => s.view)) throw new Error('debug_odc_native_bootstrap_chain_unrecognized');
  const before = stages.slice(0, -1);
  // The container: first identifier argument of the first stage call (p(r,{applicationDefinition:g}) -> r).
  const first = parse(before[0].text, { ecmaVersion: 'latest' }).body[0].expression;
  const container = first.type === 'CallExpression' && first.arguments[0]?.type === 'Identifier' ? first.arguments[0].name : null;
  const definitionArg = first.arguments?.[1]?.properties?.find(p => keyName(p.key) === 'applicationDefinition')?.value;
  const definition = definitionArg?.type === 'Identifier' ? definitionArg.name : null;
  if (!container || !definition) throw new Error('debug_odc_native_bootstrap_chain_unrecognized');
  const kept = source.slice(0, statement.start) + source.slice(statement.end);
  const initModule = kept + '\nexport async function __ssamInit(){' + before.map(s => 'await (' + s.text + ');').join('') + '}\nexport const __ssamContainer=' + container + ';\nexport const __ssamDefinition=' + definition + ';\n';
  return { file, routes, imports: importsOf(ast), stages: stages.map(s => s.text), initModule, container, definition };
}

// Whole app: chunk indexes merged by model key. files: {name: source}.
export function indexRuntime(files) {
  const names = Object.keys(files).sort();
  const bootstrapName = names.find(n => /^_osbundle-.+\.index__.+\.js$/.test(n));
  if (!bootstrapName) throw new Error('debug_odc_native_bootstrap_missing');
  const bootstrap = indexBootstrap(bootstrapName, files[bootstrapName]);
  const chunks = {}, byKey = {}, groups = {};
  for (const name of names.filter(n => /^_oschunk-[A-Za-z0-9]+\.js$/.test(n))) {
    const chunk = indexChunk(name, files[name]);
    chunks[name] = { exports: chunk.exports, keepNames: chunk.keepNames, factories: chunk.factories, imports: chunk.imports };
    for (const r of chunk.records) (byKey[r.key] ??= []).push(r);
    for (const g of chunk.groups) (groups[g.name] ??= []).push({ chunk: name, attributes: g.attributes });
  }
  const screens = Object.fromEntries(bootstrap.routes.filter(r => r.chunk).map(r => [r.screenName, r.chunk]));
  return { schema: 'ssam-odc-runtime-index/1', bootstrap: { file: bootstrap.file, routes: bootstrap.routes, stages: bootstrap.stages, container: bootstrap.container },
    initModule: bootstrap.initModule, screens, chunks, functions: byKey, groups };
}

// owner path of a screen-service endpoint: screenservices/<Module>/<Flow>/<Owner>/Action<Name> -> {module, flow, owner}
export function endpointOwner(endpoint) {
  const parts = (endpoint ?? '').replace(/^\//, '').split('/');
  const i = parts.indexOf('screenservices');
  if (i < 0) return null;
  const rest = parts.slice(i + 1);
  if (rest.length === 2) return { module: rest[0], flow: null, owner: null, method: rest[1] };
  if (rest.length === 4) return { module: rest[0], flow: rest[1], owner: rest[2], method: rest[3] };
  return null;
}
