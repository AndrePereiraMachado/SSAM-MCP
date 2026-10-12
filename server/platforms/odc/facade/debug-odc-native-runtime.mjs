// Static index of a published ODC reactive app (its public JS chunks), keyed by MODEL KEY.
// Every generated stub carries a telemetry span with outsystems.function.key = the GUID of the model element; the
// GUID in .NET byte order, base64 with '/' -> '_', is the model key. Names are never used to admit an entry: the
// join between the published model and the published runtime is that key. Nothing here executes app code.
import { parse } from 'acorn';
import { nativeLifecycleBinding, nativeLifecycleHelper, nativeLifecycleAbsent } from './debug-odc-native-lifecycle.mjs';
import {inspectOdcApplicationController} from './debug-odc-application-controller.mjs';
import {inspectOdcNativeViewLoader} from './debug-odc-view-loader.mjs';
import {qualifyOdcBootstrapFinalStage} from './debug-odc-bootstrap-final-stage.mjs';
import {createOdcViewFactoryInspector} from './debug-odc-view-factory-construction.mjs';
import {createOdcRecordInitializationInspector} from './debug-odc-record-initialization.mjs';
import {createOdcModelConstructionInspector} from './debug-odc-model-construction.mjs';
import {createOdcViewPermissionInspector} from './debug-odc-view-permissions.mjs';
import {readOdcViewResources} from './debug-odc-view-resources.mjs';
import {createOdcViewComponentInspector} from './debug-odc-view-component.mjs';
import {createOdcEmbeddedWidgetsInspector} from './debug-odc-embedded-widgets.mjs';
import {createOdcViewRenderInspector} from './debug-odc-view-render.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_+]{22}$/;
const CALLS = { callServerAction: 'server-action', callDataAction: 'data-action' };
const LIFECYCLE_HANDLER = /^on(?:Initialize|Ready|Render|Destroy|ParametersChanged|SyncStart|SyncComplete|SyncError)EventHandler$/;
export const isOdcClientCallable = record => record?.type === 'CLIENT_ACTION' || record?.type === 'CLIENT_SCREEN_ACTION';

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
  const keepNames = new Map(), spans = [], groups = [], factories = [], exports = new Map(), classTargets = new Map(), views = [], classes = new Map();
  walk(ast, (node, parents) => {
    if (node.type === 'ClassExpression' || node.type === 'ClassDeclaration') classes.set(node.start, node);
    if (node.type === 'ExportNamedDeclaration' && !node.declaration) for (const s of node.specifiers) exports.set(keyName(s.exported), keyName(s.local));
    // View metadata of a screen/block component: {getAttributes(){return{functionKey:"<GUID>",...}}, displayName:"Flow.Name",
    // modelFactory:M, controllerFactory:C}. functionKey is the GUID of the screen/block model element, so the view joins the
    // published model by key, and names its own model/controller factories.
    if (node.type === 'ObjectExpression') {
      const field = name => node.properties.find(p => p.type === 'Property' && keyName(p.key) === name)?.value;
      const display = str(field('displayName')), modelFactory = field('modelFactory'), controllerFactory = field('controllerFactory'), attrs = field('getAttributes');
      if (display && modelFactory?.type === 'Identifier' && controllerFactory?.type === 'Identifier' && attrs) {
        let functionKey = null, codeFunction = null;
        walk(attrs, n => {
          if (n.type !== 'ObjectExpression') return;
          const fk = n.properties.find(p => p.type === 'Property' && keyName(p.key) === 'functionKey'), cf = n.properties.find(p => p.type === 'Property' && keyName(p.key) === 'codeFunction');
          if (str(fk?.value) && GUID.test(str(fk.value))) { functionKey = str(fk.value); codeFunction = str(cf?.value); }
        });
        if (functionKey) {
          const factoryBody = [...parents].reverse().find(p => /FunctionExpression|ArrowFunctionExpression/.test(p.type));
          const factoryDeclaration = parents.slice(0, parents.indexOf(factoryBody)).reverse().find(p => p.type === 'VariableDeclarator');
          const blocks = [];
          if (factoryBody) walk(factoryBody, n => {
            if (n.type !== 'AssignmentExpression' || prop(n.left) !== 'getBlocks') return;
            walk(n.right, ret => { if (ret.type === 'ReturnStatement' && ret.argument?.type === 'ArrayExpression') {
              for (const item of ret.argument.elements) if (item?.type === 'Identifier') blocks.push(item.name);
            } });
          });
          views.push({ key: guidToKey(functionKey), displayName: display, codeFunction, modelFactory: modelFactory.name, controllerFactory: controllerFactory.name, chunk: file,
            componentFactory: factoryDeclaration?.id?.name ?? null, componentLocal: null, blockComponents: [...new Set(blocks)] });
        }
      }
    }
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
    let call = null, outputGroup = null, moduleController = null, proxyFor = null; const outputs = [], dataActVars = new Set(), groupsUsed = [];
    const spanParameter = node.arguments[1].params[0]?.name;
    walk(body, (n, ancestry) => {
      if (!ancestry.some(p => /Function/.test(p.type)) && spanParameter &&
          n.type === 'CallExpression' && n.callee.object?.type === 'Identifier' && n.callee.object.name === spanParameter &&
          prop(n.callee) === 'setAttribute' && str(n.arguments[0]) && str(n.arguments[1])) attrs[str(n.arguments[0])] = str(n.arguments[1]);
    });
    const holder = holderOf(parents), cls = classOf(parents);
    // The stub body is the holder function (method/getter/function), not only the span callback.
    walk(holder?.node ?? body, n => {
      if (n.type === 'CallExpression' && prop(n.callee) === 'safeExecuteClientAction' && n.arguments[0]?.type === 'MemberExpression')
        proxyFor = prop(n.arguments[0]);
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
      if (n.type === 'CallExpression' && prop(n.callee) === 'getVariableGroupType' && str(n.arguments[0])) {
        const g = str(n.arguments[0]); if (!groupsUsed.includes(g)) groupsUsed.push(g); if (!/\$(vars|outVars)$/.test(g)) outputGroup ??= g;
        const receiver = n.callee.object;
        if (prop(receiver) === 'constructor' && receiver.object?.type === 'Identifier') moduleController ??= receiver.object.name;
      }
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.right.type === 'CallExpression' && prop(n.right.callee) === 'from' && prop(n.right.arguments[0]))
        outputs.push({ attrName: prop(n.left), wire: prop(n.right.arguments[0]), dataType: dataTypeOf(n.right.arguments[1]) });
      if (n.type === 'MemberExpression' && prop(n.object) === 'variables' && /DataAct$/.test(prop(n) ?? '')) dataActVars.add(prop(n));
    });
    const guid = attrs['outsystems.function.key'];
    // Flow exception actions have a native synthetic suffix in both telemetry
    // and the model. Preserve it: dropping the outer span hides its full body
    // and leaves only individual ExceptionHandlerNode spans in the index.
    const suffix = typeof guid === 'string' && guid.endsWith('.#FlowExceptionHandler') ? '.#FlowExceptionHandler' : '';
    const baseGuid = suffix ? guid.slice(0, -suffix.length) : guid;
    if (!GUID.test(baseGuid ?? '')) continue;
    records.push({ key: guidToKey(baseGuid) + suffix, guid, name: attrs['code.function'] ?? str(node.arguments[0]), type: attrs['outsystems.function.type'] ?? null,
      ownerKey: GUID.test(attrs['outsystems.function.owner.key'] ?? '') ? guidToKey(attrs['outsystems.function.owner.key']) : null,
      ownerName: attrs['outsystems.function.owner.name'] ?? null, chunk: file,
      holder: holder ? { kind: holder.kind, name: holder.kind === 'function' ? keepNames.get(holder.local) ?? holder.local : holder.name, local: holder.local ?? null, params: holder.params.length } : null,
      classStart: cls?.start ?? null, call, outputGroup, moduleController, proxyFor,
      lifecycleHandler: cls ? cls.body.body.filter(m => m.kind === 'get' && LIFECYCLE_HANDLER.test(keyName(m.key) ?? '')).flatMap(m => {
        let linked = false;
        walk(m.value, n => { if (n.type === 'CallExpression' && prop(n.callee) === holder?.name) linked = true; });
        return linked ? [keyName(m.key)] : [];
      }) : [],
      lifecycleBindings: cls ? cls.body.body.filter(m => m.kind === 'get' && LIFECYCLE_HANDLER.test(keyName(m.key) ?? '')).flatMap(m => {
        let linked = false;
        walk(m.value, n => { if (n.type === 'CallExpression' && prop(n.callee) === holder?.name) linked = true; });
        return linked ? [{ handler: keyName(m.key), binding: nativeLifecycleBinding(m, holder?.name) }] : [];
      }) : [],
      varsGroup: groupsUsed.find(g => g.endsWith('$vars')) ?? null, outVarsGroup: groupsUsed.find(g => g.endsWith('$outVars')) ?? null, outputs: outputs.length ? outputs : null, dataActVar: dataActVars.size === 1 ? [...dataActVars][0] : null });
  }
  // Class -> controller factory: follow the alias chain of the class expression into a ControllerFactory argument.
  const classFactory = new Map();
  if (classes.size) {
    const declared = new Map(), wanted = new Set(classes.keys());
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
  // Mounting runs every declared lifecycle hook, including hooks whose body
  // has no indexed telemetry span. Keep those declarations visible so a
  // mounted runner cannot mistake an unrecognized handler for an absent one.
  for (const view of views) {
    const candidates = [...classFactory].filter(([, factory]) => factory === view.controllerFactory);
    const cls = candidates.length === 1 ? classes.get(candidates[0][0]) : null;
    view.controllerSurface = cls ? {
      resolved: true,
      classStart: cls.start,
      lifecycleHandlers: cls.body.body.filter(m => m.kind === 'get' && LIFECYCLE_HANDLER.test(keyName(m.key) ?? '')).map(m => ({
        handler: keyName(m.key),
        absentByDefault: nativeLifecycleAbsent(m),
        actionKeys: [...new Set(records.filter(r => r.classStart === cls.start &&
          r.lifecycleBindings.some(b => b.handler === keyName(m.key) && b.binding?.contextPreserved === true)).map(r => r.key))],
      })),
    } : { resolved: false, lifecycleHandlers: null };
  }
  // The public proxy owns exception handling and model flushing. Its signature
  // groups are declared in the generated implementation that it delegates to.
  for (const r of records.filter(r => r.proxyFor)) {
    const implementations = records.filter(i => i.key === r.key && i.classStart === r.classStart && i.holder?.name === r.proxyFor);
    if (implementations.length !== 1) continue;
    const implementation = implementations[0];
    for (const field of ['varsGroup', 'outVarsGroup', 'outputs']) r[field] ??= implementation[field];
    implementation.nativeProxy = r.holder.name;
  }
  for (const view of views.filter(v => v.componentFactory)) {
    const locals = [];
    walk(ast, node => {
      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init?.type === 'CallExpression' && node.init.callee?.name === view.componentFactory)
        locals.push(node.id.name);
    });
    if (locals.length === 1) view.componentLocal = locals[0];
  }
  return { file, records, groups, views, exports: Object.fromEntries(exports), keepNames: Object.fromEntries(keepNames),
    factories: factories.map(({ kind, local, classLocal, start }) => ({ kind, local, classLocal, start })), imports: importsOf(ast),
    topLevel: topLevelNames(ast) };
}

// Names declared at module top level (var/let/const/function/class): only these can be re-exported by an appended
// `export {local as alias}` without changing the module's behavior.
function topLevelNames(ast) {
  const names = [];
  for (const node of ast.body) {
    const decl = node.type === 'ExportNamedDeclaration' && node.declaration ? node.declaration : node;
    if (decl.type === 'VariableDeclaration') for (const d of decl.declarations) { if (d.id.type === 'Identifier') names.push(d.id.name); }
    else if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) names.push(decl.id.name);
  }
  return names;
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
      // Hosts deliberately separate the stages to install native transports.
      // A callback consuming the previous result needs a different protocol;
      // silently dropping that argument would change the published startup.
      // A zero-parameter ordinary callback can still consume the predecessor
      // through arguments. Nested arrows share that binding; nested ordinary
      // functions have their own. Do not silently replace it with an empty list.
      function usesCallbackArguments(n,parent,key){
        if (!n || typeof n !== 'object') return false;
        if (n !== fn && ['FunctionExpression','FunctionDeclaration'].includes(n.type)) return false;
        if (n.type === 'Identifier' && n.name === 'arguments') {
          if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return false;
          if (parent?.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand) return false;
          return true;
        }
        return Object.entries(n).some(([k,v]) => Array.isArray(v) ? v.some(child=>usesCallbackArguments(child,n,k)) : usesCallbackArguments(v,n,k));
      }
      if (fn.params.length || fn.generator || fn.type !== 'ArrowFunctionExpression' && usesCallbackArguments(fn))
        throw new Error('debug_odc_native_bootstrap_stage_contract_unsupported');
      const dynamicImports = [];
      walk(fn, child => { if (child.type === 'ImportExpression') dynamicImports.push(str(child.source)); });
      stages.unshift({ text: ret ? source.slice(ret.start, ret.end) : null, dynamicImports,
        callback: source.slice(fn.start, fn.end), view: source.slice(fn.start, fn.end).includes('staticScreenRoutes') });
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
  // __ssamStages lets the worker run the original stages one by one (it installs its transports between them).
  // Keep entire callbacks, including statements before return, await and
  // finally. Calling a bare function expression also preserves the undefined
  // receiver used by Promise.then, even when a host invokes stages[index]().
  const initModule = kept + '\nexport async function __ssamInit(){for(const stage of __ssamStages)await stage();}\nexport const __ssamStages=[' +
    before.map(s => '()=>(' + s.callback + ')()').join(',') + '];\nexport const __ssamContainer=' + container + ';\nexport const __ssamDefinition=' + definition + ';\n';
  // Kept separately from the default headless module. A mounted host must
  // qualify the entire application startup closure before selecting this
  // variant; importing it still does not start the original view stage.
  // A module-level arrow retains the module lexical receiver for arrow
  // callbacks, and calls ordinary callbacks with the Promise.then receiver
  // (undefined), even when the host invokes boot.__ssamMount().
  const mountModule = initModule + '\nexport const __ssamMount=()=>(' + stages.at(-1).callback + ')();\n';
  return { file, routes, imports: importsOf(ast), stages: stages.map(s => s.text), mountImports: stages.at(-1).dynamicImports,
    initModule, mountModule, container, definition };
}

// Whole app: chunk indexes merged by model key. files: {name: source}.
export function indexRuntime(files) {
  const names = Object.keys(files).sort();
  const bootstrapName = names.find(n => /^_osbundle-.+\.index__.+\.js$/.test(n));
  if (!bootstrapName) throw new Error('debug_odc_native_bootstrap_missing');
  const bootstrap = indexBootstrap(bootstrapName, files[bootstrapName]);
  const chunks = {}, byKey = {}, groups = {}, views = {};
  for (const name of names.filter(n => /^_oschunk-[A-Za-z0-9]+\.js$/.test(n))) {
    const chunk = indexChunk(name, files[name]);
    chunks[name] = { exports: chunk.exports, keepNames: chunk.keepNames, factories: chunk.factories, imports: chunk.imports, topLevel: chunk.topLevel };
    for (const r of chunk.records) (byKey[r.key] ??= []).push(r);
    for (const g of chunk.groups) (groups[g.name] ??= []).push({ chunk: name, attributes: g.attributes });
    for (const v of chunk.views) (views[v.key] ??= []).push(v);
  }
  const screens = Object.fromEntries(bootstrap.routes.filter(r => r.chunk).map(r => [r.screenName, r.chunk]));
  const lifecycleHelperCache = new Map();
  for (const record of Object.values(byKey).flat()) for (const row of record.lifecycleBindings ?? []) {
    if (row.binding?.kind === 'native-cached-event')
      row.helper = nativeLifecycleHelper(row.binding, record.chunk, chunks, files, lifecycleHelperCache);
  }
  const flatViews = Object.values(views).flat();
  function viewForSymbol(file, local, visited = new Set()) {
    const key = file + ':' + local;
    if (visited.has(key)) return null; visited.add(key);
    const own = flatViews.filter(v => v.chunk === file && v.componentLocal === local);
    if (own.length === 1) return own[0];
    const imports = chunks[file]?.imports ?? [];
    const imported = imports.flatMap(i => i.names.filter(n => n.local === local).map(n => ({ file: i.specifier.replace(/^\.\//, ''), exported: n.imported })));
    if (imported.length !== 1) return null;
    const next = imported[0], symbol = chunks[next.file]?.exports?.[next.exported];
    return symbol ? viewForSymbol(next.file, symbol, visited) : null;
  }
  const inspectViewFactory = createOdcViewFactoryInspector(files);
  const inspectRecordInitialization = createOdcRecordInitializationInspector(files);
  const inspectModelConstruction = createOdcModelConstructionInspector(files);
  const inspectViewPermissions = createOdcViewPermissionInspector(files);
  const inspectViewComponent = createOdcViewComponentInspector(files);
  const inspectEmbeddedWidgets = createOdcEmbeddedWidgetsInspector(files);
  const inspectViewRender = createOdcViewRenderInspector(files);
  for (const view of flatViews) {
    try { view.embeddedWidgets = inspectEmbeddedWidgets(view); }
    catch { view.embeddedWidgets = { regionInitializationQualified: false, viewInitializationQualified: false }; }
    try { view.componentRegistration = inspectViewComponent(view); }
    catch { view.componentRegistration = { componentRegistrationQualified: false, viewInitializationQualified: false }; }
    try { view.renderExpressions = inspectViewRender(view); }
    catch(error) { view.renderExpressions = { renderExpressionsQualified: false, renderExecuted: false, executionAuthorized: false,
      error:/^debug_odc_render_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_render_unresolved' }; }
    try { view.resourceDependencies = readOdcViewResources(files[view.chunk], view.componentFactory); }
    catch { view.resourceDependencies = { resolved: false, resourcesFetched: false }; }
    try { view.factoryConstruction = inspectViewFactory(view); }
    catch { view.factoryConstruction = { factoryConstructionQualified: false, viewInitializationQualified: false }; }
    try { view.recordInitialization = inspectRecordInitialization(view); }
    catch { view.recordInitialization = { recordInitializationQualified: false, viewInitializationQualified: false }; }
    try { view.modelConstruction = inspectModelConstruction(view); }
    catch { view.modelConstruction = { modelConstructionQualified: false, viewInitializationQualified: false }; }
    try { view.permissionDeclaration = inspectViewPermissions(view); }
    catch { view.permissionDeclaration = { declarationKind: 'unresolved', permissionsValidated: false }; }
    view.blockKeys = view.blockComponents.flatMap(local => { const block = viewForSymbol(view.chunk, local); return block ? [block.key] : []; });
    view.unresolvedBlockComponents = view.blockComponents.filter(local => !viewForSymbol(view.chunk, local));
  }
  // Resolve the definition through the exact bootstrap import, not by finding
  // an unrelated object with similarly named properties elsewhere in the app.
  const definitions = bootstrap.imports.flatMap(i => i.names.filter(n => n.local === bootstrap.definition)
    .map(n => ({ file: i.specifier.replace(/^\.\//, ''), exported: n.imported })));
  let applicationStartup = null;
  if (definitions.length === 1) {
    const def = definitions[0], local = chunks[def.file]?.exports?.[def.exported];
    if (local && files[def.file]) {
      const objects = [];
      walk(parse(files[def.file], { ecmaVersion: 'latest', sourceType: 'module' }), n => {
        if (n.type === 'VariableDeclarator' && n.id?.name === local && n.init?.type === 'ObjectExpression') objects.push(n.init);
      });
      if (objects.length === 1) {
        const importers = ['homeModuleControllerImporter', 'homeModuleLanguageResourcesImporter'].map(name => {
          const properties = objects[0].properties.filter(p => p.type === 'Property' && !p.computed && keyName(p.key) === name);
          const imports = [];
          if (properties.length === 1) walk(properties[0].value, n => { if (n.type === 'ImportExpression') imports.push(str(n.source)); });
          return { name, imports, resolved: properties.length === 1 && imports.length === 1 && typeof imports[0] === 'string' };
        });
        let controller;
        try{controller={resolved:true,...inspectOdcApplicationController(files,importers.find(i=>i.name==='homeModuleControllerImporter'))};}
        catch(error){controller={resolved:false,error:/^debug_odc_application_controller_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_application_controller_unresolved'};}
        applicationStartup = { definitionChunk: def.file, importers, controller, qualified: false };
      }
    }
  }
  let viewLoader;
  try{viewLoader=inspectOdcNativeViewLoader(files,bootstrap.file);}
  catch(error){viewLoader={nativeLoaderBound:false,applicationStartupQualified:false,
    error:/^debug_odc_view_loader_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_view_loader_unresolved'};}
  let finalStage;
  try{finalStage=qualifyOdcBootstrapFinalStage(files,bootstrap.file);}
  catch(error){finalStage={finalStageStructureQualified:false,applicationStartupQualified:false,executionAuthorized:false,
    error:/^debug_odc_bootstrap_final_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_bootstrap_final_unresolved'};}
  return { schema: 'ssam-odc-runtime-index/1', bootstrap: { file: bootstrap.file, imports: bootstrap.imports, routes: bootstrap.routes, stages: bootstrap.stages, mountImports: bootstrap.mountImports, container: bootstrap.container, applicationStartup, viewLoader, finalStage },
    initModule: bootstrap.initModule, mountModule: bootstrap.mountModule, screens, chunks, functions: byKey, groups, views };
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
