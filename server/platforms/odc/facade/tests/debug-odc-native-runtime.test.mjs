import test from 'node:test';
import assert from 'node:assert/strict';
import { indexChunk, indexBootstrap, indexRuntime, guidToKey, keyToGuid, endpointOwner } from '../debug-odc-native-runtime.mjs';
import { nativeOdcEntryKind, resolveOdcRuntimeEntry } from '../debug-odc-native-assets.mjs';

// Synthetic chunks shaped like the generator output: a server-action stub with a telemetry span, a data-action getter,
// a client action with variable groups, and a bootstrap with a route table and the init chain.
const serverChunk = `
var b={ServerDataConverter:{to:function(v,o){return v},from:function(v,o){return v}}},d={DataTypes:{Text:'Text',Boolean:'Boolean'}};
var A={startActiveSpan:function(n,f){return f({setAttribute:function(){},end:function(){}})}};
{let i=class i extends B.BaseViewController{
  myAction$ServerAction(e,t,y){var f=this.controller;return A.startActiveSpan("MyAction",function(S){
    S.setAttribute("code.function","MyAction");
    S.setAttribute("outsystems.function.key","92286166-fbc8-4e11-9678-5a494552415f");
    S.setAttribute("outsystems.function.owner.key","e6e54de6-3d28-491d-a43b-079d2b3350f4");
    S.setAttribute("outsystems.function.type","SCREEN_SERVICE_SERVER_ACTION_CALL");
    var O={Address1:b.ServerDataConverter.to(e,{dataType:d.DataTypes.Text}),IsManual:b.ServerDataConverter.to(t,{dataType:d.DataTypes.Boolean})};
    return f.callServerAction("MyAction","screenservices/App/Flow/Screen/ActionMyAction","NdV4Q1pcQE+EPIrUc3Sp1w",O,f.callContext(y)).then(function(P){
      var v=new(f.constructor.getVariableGroupType("App.Flow.Screen$ActionMyAction"));
      v.okOut=b.ServerDataConverter.from(P.Ok,d.DataTypes.Boolean);return v})},0)}
};let r=i;Qn=r}var Qn,qn=new C.ControllerFactory(Qn,De);
export{qn as controllerModule};
`;
const bootstrap = `
import{a as g}from"./_oschunk-AAA.js";
var y=[{get pathname(){return t("Screen")},screenName:"Flow.Screen",forDefaultPath:!1,lazyComponentInfo:{importer:e(function(){return import("./_oschunk-SCR.js")},"importer")}}];
OutSystemsDebugger.initialize().then(function(){return p(r,{applicationDefinition:g})}).then(function(){return Promise.all([v(r,formats),S()])}).then(function(){return h({initType:Full}).then(function(n){C.load(u.default,{staticScreenRoutes:y})})}).catch(function(n){s.handleError(n)});
`;

test('indexChunk keys a server stub by its telemetry span and reads typed inputs/outputs', () => {
  const ix = indexChunk('_oschunk-SCR.js', serverChunk);
  const rec = ix.records.find(r => r.key === guidToKey('92286166-fbc8-4e11-9678-5a494552415f'));
  assert.ok(rec);
  assert.equal(rec.type, 'SCREEN_SERVICE_SERVER_ACTION_CALL');
  assert.equal(rec.call.kind, 'server-action');
  assert.equal(rec.call.endpoint, 'screenservices/App/Flow/Screen/ActionMyAction');
  assert.deepEqual(rec.call.inputs.map(i => [i.wire, i.dataType]), [['Address1', 'Text'], ['IsManual', 'Boolean']]);
  assert.equal(rec.ownerKey, guidToKey('e6e54de6-3d28-491d-a43b-079d2b3350f4'));
  assert.ok(rec.outputs.some(o => o.wire === 'Ok'));
});

test('indexChunk preserves native flow exception action identity without admitting arbitrary suffixes', () => {
  const guid = '7435742d-eda4-4745-9a8b-9a8185f7eaee';
  const span = suffix => `function handleError(){return A.startActiveSpan("OnException",function(s){s.setAttribute("outsystems.function.key","${guid}${suffix}");return 0;});}`;
  const ix = indexChunk('_oschunk-ERROR.js', span('.#FlowExceptionHandler'));
  assert.equal(ix.records.length, 1);
  assert.equal(ix.records[0].key, 'LXQ1dKTtRUeai5qBhffq7g.#FlowExceptionHandler');
  assert.equal(ix.records[0].guid, guid + '.#FlowExceptionHandler');
  assert.equal(indexChunk('_oschunk-ERROR.js', span('.#Unknown')).records.length, 0);
  const nested = span('.#FlowExceptionHandler').replace('return 0;', `return A.startActiveSpan("HandleAll",function(s){s.setAttribute("outsystems.function.key","82fda077-e3f1-4f1f-92bb-c4001f8329fd");return 0;});`);
  assert.deepEqual(indexChunk('_oschunk-ERROR.js', nested).records.map(r=>r.key),
    ['LXQ1dKTtRUeai5qBhffq7g.#FlowExceptionHandler','d6D9gvHjH0+Su8QAH4Mp_Q']);
});

test('application startup follows the definition import and retains unresolved dynamic imports', () => {
  const definition = `var x={homeModuleControllerImporter:function(){return import("./_oschunk-CTRL.js")},homeModuleLanguageResourcesImporter:function(){return import("./_oschunk-LANG.js")}};export{x as a};`;
  const files = {'_osbundle-App.index__X.js':bootstrap,'_oschunk-AAA.js':definition};
  const startup = indexRuntime(files).bootstrap.applicationStartup;
  assert.equal(startup.definitionChunk,'_oschunk-AAA.js');
  assert.deepEqual(startup.importers.map(i=>i.imports),[['./_oschunk-CTRL.js'],['./_oschunk-LANG.js']]);
  assert.ok(startup.importers.every(i=>i.resolved));
  const computed=indexRuntime({...files,'_oschunk-AAA.js':definition.replace('import("./_oschunk-CTRL.js")','import(selected)')});
  assert.equal(computed.bootstrap.applicationStartup.importers[0].resolved,false);
  assert.equal(indexRuntime({...files,'_oschunk-AAA.js':definition.replace('x as a','x as other')}).bootstrap.applicationStartup,null);
});

test('indexBootstrap extracts the route table and an init module that stops before the view', () => {
  const b = indexBootstrap('_osbundle-App.index__X.js', bootstrap);
  assert.deepEqual(b.routes.map(r => [r.screenName, r.chunk]), [['Flow.Screen', '_oschunk-SCR.js']]);
  assert.equal(b.stages.length, 3);           // two init stages + the view stage
  assert.ok(b.initModule.includes('__ssamInit'));
  assert.ok(!b.initModule.includes('staticScreenRoutes')); // the view stage is not run headless
  assert.ok(!b.initModule.includes('__ssamMount'));
  assert.ok(b.mountModule.startsWith(b.initModule));
  assert.equal(b.container, 'r');
});

test('mount module defers original startup and view stage until explicitly invoked', async () => {
  const source = `var container={calls:[]},definition={};
    function prepare(c,options){c.calls.push('prepare');return Promise.resolve();}
    function startup(){container.calls.push('startup');return Promise.resolve(true);}
    function render(options){container.calls.push('render');return options.staticScreenRoutes;}
    OutSystemsDebugger.initialize().then(function(){return prepare(container,{applicationDefinition:definition});})
      .then(function(){container.calls.push('view-prelude');return startup().then(function(){return render({staticScreenRoutes:['original-route']});});});`;
  const b=indexBootstrap('_osbundle-Test.index__X.js',source);
  const module=await import('data:text/javascript;base64,'+Buffer.from(b.mountModule).toString('base64'));
  assert.deepEqual(module.__ssamContainer.calls,[]);
  await module.__ssamInit();assert.deepEqual(module.__ssamContainer.calls,['prepare']);
  assert.deepEqual(await module.__ssamMount(),['original-route']);
  assert.deepEqual(module.__ssamContainer.calls,['prepare','view-prelude','startup','render']);
  assert.ok(b.mountModule.includes(b.stages.at(-1)));
});

test('indexRuntime merges chunks and the bootstrap by model key', () => {
  const ix = indexRuntime({ '_osbundle-App.index__X.js': bootstrap, '_oschunk-SCR.js': serverChunk });
  assert.ok(ix.functions[guidToKey('92286166-fbc8-4e11-9678-5a494552415f')]);
  assert.equal(ix.screens['Flow.Screen'], '_oschunk-SCR.js');
  assert.ok(ix.mountModule.startsWith(ix.initModule));
  assert.ok(ix.mountModule.includes('__ssamMount'));
});

test('initialization retains complete callbacks, async ordering and the native undefined receiver', async () => {
  const source = `var container={calls:[]},definition={};
    function prepare(c,options){c.calls.push('prepare');return Promise.resolve().finally(()=>c.calls.push('settled'));}
    OutSystemsDebugger.initialize().then(function(){
      container.calls.push(this===undefined?'receiver-native':'receiver-changed');
      container.calls.push('before-prepare');
      return prepare(container,{applicationDefinition:definition});
    }).then(async function(){
      await Promise.resolve();container.calls.push('before-format');
      return Promise.resolve().then(()=>container.calls.push('formatted'));
    }).then(function(){container.calls.push('view');return {staticScreenRoutes:[]};});`;
  const b=indexBootstrap('_osbundle-Callbacks.index__X.js',source);
  const load=text=>import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
  const baseline=await load('var OutSystemsDebugger={initialize:()=>Promise.resolve()};\n'+
    source.replace('OutSystemsDebugger.initialize().then','await OutSystemsDebugger.initialize().then')+'\nexport{container};');
  const combined=await load(b.mountModule);
  assert.deepEqual(combined.__ssamContainer.calls,[]);
  await combined.__ssamInit();
  assert.deepEqual(combined.__ssamContainer.calls,baseline.container.calls.slice(0,-1));
  assert.deepEqual(combined.__ssamContainer.calls,['receiver-native','before-prepare','prepare','settled','before-format','formatted']);
  await combined.__ssamMount();assert.deepEqual(combined.__ssamContainer.calls,baseline.container.calls);
  const split=await load(b.mountModule+'\n// independently hosted stages');
  await split.__ssamStages[0]();await split.__ssamStages[1]();
  assert.deepEqual(split.__ssamContainer.calls,baseline.container.calls.slice(0,-1));
});

test('an initialization prelude failure cannot be dropped or start later stages',async()=>{
  const source=`var container={calls:[]},definition={};function prepare(){container.calls.push('unexpected');}
    OutSystemsDebugger.initialize().then(function(){throw new Error('original prelude');return prepare(container,{applicationDefinition:definition});})
      .then(function(){container.calls.push('unexpected-view');return {staticScreenRoutes:[]};});`;
  const b=indexBootstrap('_osbundle-Failure.index__X.js',source);
  const module=await import('data:text/javascript;base64,'+Buffer.from(b.mountModule).toString('base64'));
  await assert.rejects(module.__ssamInit(),/original prelude/);
  assert.deepEqual(module.__ssamContainer.calls,[]);
});

test('all original callbacks preserve their native receiver through both host entry points',async()=>{
 for(const callback of ['function()','() =>','async function()','async () =>']){
  const source=`var container={calls:[]},definition={};
   function prepare(c){c.calls.push(this===undefined?'call-native':'call-changed');return Promise.resolve();}
   OutSystemsDebugger.initialize().then(${callback}{container.calls.push(this===undefined?'init-native':'init-changed');return prepare(container,{applicationDefinition:definition});})
    .then(${callback}{container.calls.push(this===undefined?'mount-native':'mount-changed');return {staticScreenRoutes:[]};});`;
  const b=indexBootstrap('_osbundle-Receiver.index__X.js',source);
  const load=text=>import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
  const original=await load('var OutSystemsDebugger={initialize:()=>Promise.resolve()};'+
   source.replace('OutSystemsDebugger.initialize().then','await OutSystemsDebugger.initialize().then')+'export{container};');
  for(const split of [false,true]){
   const hosted=await load(b.mountModule+'\n// split='+split);
   if(split)await hosted.__ssamStages[0]();else await hosted.__ssamInit();
   await hosted.__ssamMount();
   assert.deepEqual(hosted.__ssamContainer.calls,original.container.calls);
   assert.deepEqual(hosted.__ssamContainer.calls,['init-native','call-native','mount-native']);
  }
 }
});

test('callbacks requiring a predecessor result are refused before split initialization',()=>{
  assert.throws(()=>indexBootstrap('_osbundle-App.index__X.js',bootstrap.replace('then(function()','then(function(previous)')),
    /bootstrap_stage_contract_unsupported/);
});

test('implicit predecessor reads are refused while nested ordinary arguments retain their scope',()=>{
 for(const access of ['arguments[0]','(()=>arguments[0])()']){
  assert.throws(()=>indexBootstrap('_osbundle-App.index__X.js',bootstrap.replace('then(function(){','then(function(){void '+access+';')),
   /bootstrap_stage_contract_unsupported/);
 }
 const nested=bootstrap.replace('then(function(){','then(function(){(function(){return arguments[0]})(17);');
 assert.ok(indexBootstrap('_osbundle-App.index__X.js',nested).mountModule);
});

test('bootstrap distinguishes startup imports from screen routes and retains computed imports as unresolved',()=>{
  const source=bootstrap.replace('C.load(u.default,',
    'Promise.all([import("./_oschunk-ERROR.js"),import(dynamicPath)]);C.load(u.default,');
  const b=indexBootstrap('_osbundle-App.index__X.js',source);
  assert.deepEqual(b.mountImports,['./_oschunk-ERROR.js',null]);
  assert.deepEqual(b.routes.map(r=>r.chunk),['_oschunk-SCR.js']);
  const ix=indexRuntime({'_osbundle-App.index__X.js':source,'_oschunk-SCR.js':serverChunk});
  assert.deepEqual(ix.bootstrap.mountImports,b.mountImports);
});

test('endpointOwner parses screen-service endpoints', () => {
  assert.deepEqual(endpointOwner('/App/screenservices/App/Flow/Screen/ActionMyAction'), { module: 'App', flow: 'Flow', owner: 'Screen', method: 'ActionMyAction' });
  assert.equal(endpointOwner('/nope'), null);
});

test('guid/key helpers reject malformed input', () => {
  assert.throws(() => guidToKey('not-a-guid'), /guid_invalid/);
  assert.throws(() => keyToGuid('short'), /key_invalid/);
});

test('screen actions use their native public proxy and lifecycle dispatcher with implementation signature', () => {
  const key = guidToKey('92286166-fbc8-4e11-9678-5a494552415f');
  const attrs = `s.setAttribute('outsystems.function.key','92286166-fbc8-4e11-9678-5a494552415f');s.setAttribute('outsystems.function.type','CLIENT_SCREEN_ACTION');`;
  const source = `var events, cf, mf; { let c=class C {
    _handle$Action(cc){return telemetry.startActiveSpan('Handle',function(s){${attrs}return new(this.constructor.getVariableGroupType('App.Flow.Screen.Handle$vars'));});}
    handle$Action(cc){var controller=this;return telemetry.startActiveSpan('Handle__proxy',function(s){${attrs}return controller.safeExecuteClientAction(controller._handle$Action,cc);});}
    get onInitializeEventHandler(){return function(cc){return this.handle$Action(cc);};}
  }; cf=c; cf.registerVariableGroupType('App.Flow.Screen.Handle$vars',[{name:'Value',attrName:'valueVar',dataType:d.DataTypes.Integer}]); }
  var factory = new sdk.ControllerFactory(cf);
  var view = {getAttributes(){return {functionKey:'e6e54de6-3d28-491d-a43b-079d2b3350f4'};},displayName:'Flow.Screen',modelFactory:mf,controllerFactory:factory};`;
  const chunk = indexChunk('_oschunk-SCR.js', source);
  assert.equal(chunk.views[0].controllerSurface.resolved, true);
  assert.deepEqual(chunk.views[0].controllerSurface.lifecycleHandlers, [{ handler: 'onInitializeEventHandler', absentByDefault: false, actionKeys: [key] }]);
  const unknownHook = indexChunk('_oschunk-SCR.js', source.replace(
    'get onInitializeEventHandler()',
    'get onDestroyEventHandler(){return function(cc){return external.cleanup(cc);};} get onInitializeEventHandler()'));
  assert.deepEqual(unknownHook.views[0].controllerSurface.lifecycleHandlers.find(h => h.handler === 'onDestroyEventHandler'),
    { handler: 'onDestroyEventHandler', absentByDefault: false, actionKeys: [] });
  const runtime = { index: { functions: { [key]: chunk.records }, views: { screen: chunk.views }, screens: { 'Flow.Screen': '_oschunk-SCR.js' },
    groups: Object.fromEntries(chunk.groups.map(g => [g.name, [{ ...g, chunk: '_oschunk-SCR.js' }]])) } };
  assert.equal(nativeOdcEntryKind(runtime.index, key), 'client-action');
  const plan = resolveOdcRuntimeEntry({ entry: { key }, path: [{ key }] }, runtime);
  assert.equal(plan.member.holder.name, 'handle$Action');
  assert.equal(plan.member.varsGroup, 'App.Flow.Screen.Handle$vars');
  assert.equal(plan.inputs.length, 0);
  assert.deepEqual(plan.lifecycle, { handler: 'onInitializeEventHandler', mounted: false, scope: 'individual-event' });
  assert.equal(plan.invocation, 'lifecycle-event');
  const altered = indexChunk('_oschunk-SCR.js', source.replace('return this.handle$Action(cc);', 'return other.handle$Action(cc);'));
  assert.throws(() => resolveOdcRuntimeEntry({ entry: { key }, path: [{ key }] }, {
    index: { ...runtime.index, functions: { [key]: altered.records } },
  }), /lifecycle_binding_unqualified/);
});

test('block hosts follow native getBlocks imports rather than chunk co-location', () => {
  const actionGuid = '92286166-fbc8-4e11-9678-5a494552415f', blockGuid = 'e6e54de6-3d28-491d-a43b-079d2b3350f4';
  const block = `var mf,cf; {let C=class C{action$Action(cc){return t.startActiveSpan('Action',function(s){
    s.setAttribute('outsystems.function.key','${actionGuid}');s.setAttribute('outsystems.function.type','CLIENT_SCREEN_ACTION');});}};cf=C;}
    var controller=new sdk.ControllerFactory(cf);
    var make=keep(function(){var v=component(function(){},{getAttributes(){return{functionKey:'${blockGuid}'}},displayName:'Flow.Block',modelFactory:mf,controllerFactory:controller});
    return v.getBlocks=function(){return[];},v;},'componentFactory'),block=make();export{block as view};`;
  const screen = `import{view as child}from'./_oschunk-BLOCK.js';var model,controller;
    var make=keep(function(){var v=component(function(){},{getAttributes(){return{functionKey:'1e937b46-5737-46e5-b341-dd95a86ad3bd'}},displayName:'Flow.Screen',modelFactory:model,controllerFactory:controller});
    return v.getBlocks=function(){return[child];},v;},'componentFactory'),screen=make();export{screen as view};`;
  const ix = indexRuntime({ '_osbundle-App.index__X.js': bootstrap, '_oschunk-SCR.js': screen, '_oschunk-BLOCK.js': block });
  const key = guidToKey(actionGuid), plan = resolveOdcRuntimeEntry({ entry: { key }, path: [{ key }] }, { index: ix });
  assert.equal(plan.view.displayName, 'Flow.Block'); assert.equal(plan.screen.displayName, 'Flow.Screen');
  assert.deepEqual(plan.screen.blockKeys, [guidToKey(blockGuid)]);
  assert.deepEqual(plan.screen.unresolvedBlockComponents, []);
  plan.screen.blockKeys = [];
  assert.throws(() => resolveOdcRuntimeEntry({ entry: { key }, path: [{ key }] }, { index: ix }), /block_parent_unresolved/);
});
