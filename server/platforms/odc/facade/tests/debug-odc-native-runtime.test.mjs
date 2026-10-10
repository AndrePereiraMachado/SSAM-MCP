import test from 'node:test';
import assert from 'node:assert/strict';
import { indexChunk, indexBootstrap, indexRuntime, guidToKey, keyToGuid, endpointOwner } from '../debug-odc-native-runtime.mjs';

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

test('indexBootstrap extracts the route table and an init module that stops before the view', () => {
  const b = indexBootstrap('_osbundle-App.index__X.js', bootstrap);
  assert.deepEqual(b.routes.map(r => [r.screenName, r.chunk]), [['Flow.Screen', '_oschunk-SCR.js']]);
  assert.equal(b.stages.length, 3);           // two init stages + the view stage
  assert.ok(b.initModule.includes('__ssamInit'));
  assert.ok(!b.initModule.includes('staticScreenRoutes')); // the view stage is not run headless
  assert.equal(b.container, 'r');
});

test('indexRuntime merges chunks and the bootstrap by model key', () => {
  const ix = indexRuntime({ '_osbundle-App.index__X.js': bootstrap, '_oschunk-SCR.js': serverChunk });
  assert.ok(ix.functions[guidToKey('92286166-fbc8-4e11-9678-5a494552415f')]);
  assert.equal(ix.screens['Flow.Screen'], '_oschunk-SCR.js');
});

test('endpointOwner parses screen-service endpoints', () => {
  assert.deepEqual(endpointOwner('/App/screenservices/App/Flow/Screen/ActionMyAction'), { module: 'App', flow: 'Flow', owner: 'Screen', method: 'ActionMyAction' });
  assert.equal(endpointOwner('/nope'), null);
});

test('guid/key helpers reject malformed input', () => {
  assert.throws(() => guidToKey('not-a-guid'), /guid_invalid/);
  assert.throws(() => keyToGuid('short'), /key_invalid/);
});
