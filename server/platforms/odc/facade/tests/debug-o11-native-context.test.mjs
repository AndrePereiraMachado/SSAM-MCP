import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalO11Context, applyO11Context, invokeO11Lifecycle, trackO11ClientProxies, settleO11ClientProxies } from '../debug-o11-native-context.mjs';
import { parseO11Assets } from '../debug-o11-native-abi.mjs';

const owners = {
  screen: { inputs: [{ name: 'GameId', attribute: 'gameIdIn', dataType: 'LongInteger', wireInput: true }],
    variables: [{ name: 'Count', attribute: 'countVar', dataType: 'Integer' }] },
  block: { inputs: [{ name: 'Visible', attribute: 'visibleIn', dataType: 'Boolean', wireInput: false }],
    variables: [{ name: 'Search', attribute: 'searchVar', dataType: 'Text' }] },
};
test('context validates owner state, canonical long values and excludes undeclared/private attributes before assignment', () => {
  assert.deepEqual(canonicalO11Context(owners, { screen: { inputs: { GameId: 42 }, variables: { Count: 3 } }, block: { inputs: { Visible: false } } }),
    { screen: { inputs: { GameId: '42' }, variables: { Count: 3 } }, block: { inputs: { Visible: false } } });
  assert.throws(() => canonicalO11Context(owners, { screen: { variables: { GameId: 3 } } }), /attribute_unavailable/);
  assert.throws(() => canonicalO11Context(owners, { screen: { variables: { Password: 'secret' } } }), /private_value/);
  assert.throws(() => canonicalO11Context({}, { block: {} }), /owner_unavailable/);
  assert.throws(() => canonicalO11Context(owners, { screen: { variables: { Count: '3' } } }), /type_mismatch/);
  assert.throws(() => canonicalO11Context(owners, { screen: { roles: {} } }), /owner_unavailable/);
});

test('context uses original input setters, keeps owner models distinct and prepares every conversion before writes', () => {
  const calls = [], models = Object.fromEntries(['screen', 'block'].map(owner => [owner, {
    variables: {}, setInputs(inputs) { calls.push([owner, inputs]); Object.assign(this.variables, inputs); },
  }]));
  const value = { screen: { inputs: { GameId: '9223372036854775807' }, variables: { Count: 2 } }, block: { inputs: { Visible: false }, variables: { Search: 'hello' } } };
  const receipt = applyO11Context({ owners, models, value, convert: (model, spec, value) => ({ typed: spec.dataType, value }) });
  assert.deepEqual(calls, [['screen', { GameId: '9223372036854775807' }], ['block', { Visible: { typed: 'Boolean', value: false } }]]);
  assert.deepEqual(models.screen.variables.countVar, { typed: 'Integer', value: 2 });
  assert.deepEqual(models.block.variables.searchVar, { typed: 'Text', value: 'hello' });
  assert.deepEqual(receipt, { screen: { inputs: ['GameId'], variables: ['Count'] }, block: { inputs: ['Visible'], variables: ['Search'] } });
  calls.length = 0;
  assert.throws(() => applyO11Context({ owners, models, value, convert: (model, spec) => { if (spec.name === 'Search') throw Error('bad conversion'); return 1; } }), /bad conversion/);
  assert.deepEqual(calls, []);
});

test('lifecycle invokes and awaits original event wrapper through native fireEvent, with timeout and no extra lifecycle', async () => {
  const calls = [], controller = {
    async fireEvent(handler, event) { calls.push(event); await handler.call(this, { withTimeout: seconds => ({ seconds }) }); calls.push('native-complete'); },
    async onInitializeEventHandler(context) { assert.equal(this, controller); calls.push(context.seconds); await Promise.resolve(); calls.push('original-handler-complete'); },
  };
  await invokeO11Lifecycle(controller, { event: 'OnInitialize', handler: 'onInitializeEventHandler' }, 35);
  assert.deepEqual(calls, ['OnInitialize', 35, 'original-handler-complete', 'native-complete']);
  await assert.rejects(invokeO11Lifecycle(controller, { event: 'OnReady', handler: 'onInitializeEventHandler' }, 35), /handler_unavailable/);
});

test('unreturned JS proxy promises are awaited once, including chained proxies and failures', async () => {
  const pending = new Set(), calls = [], failures = [];
  let release;
  const controller = { clientActionProxies: {
    first() { calls.push('first'); return new Promise(resolve => { release = resolve; }).then(() => { controller.clientActionProxies.second(); }); },
    async second() { calls.push('second'); await Promise.resolve(); throw Error('native failure'); },
  } };
  trackO11ClientProxies(controller, pending, error => failures.push(error.message));
  controller.clientActionProxies.first(); // exactly like an original JS node omitting return
  let done = false; const drain = settleO11ClientProxies(pending).then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false); release(); await drain;
  assert.deepEqual(calls, ['first', 'second']); assert.deepEqual(failures, ['native failure']); assert.equal(pending.size, 0);
});

test('published ABI separates VariablesRecord from data outputs and input state; lifecycle/proxy edges use original handlers', () => {
  const asset = { name: 'Demo.Flow.Page.mvc.js', text: `
define("Demo.Flow.Page.mvc$model", ["OutSystems/ClientRuntime/Main", "Demo.model"], function (OutSystems, DemoModel) {
var DataRecord = {}; DataRecord.attributesToDeclare = function () { return [this.attr("HiddenOutput", "hiddenOut", "HiddenOutput", true, false, OS.DataTypes.DataTypes.Text, function () { return ""; }, true)]; };
var VariablesRecord = {}; VariablesRecord.attributesToDeclare = function () { return [
this.attr("GameId", "gameIdIn", "GameId", true, false, OS.DataTypes.DataTypes.LongInteger, function () { return 0; }, false),
this.attr("_gameIdInDataFetchStatus", "_gameIdInDataFetchStatus", "_gameIdInDataFetchStatus", true, false, OS.DataTypes.DataTypes.Integer, function () { return 1; }, false),
this.attr("Load", "loadDataAct", "loadDataAct", true, true, OS.DataTypes.DataTypes.Record, function () { return null; }, true, DataRecord),
this.attr("Search", "searchVar", "Search", true, false, OS.DataTypes.DataTypes.Text, function () { return ""; }, false)
]; };
Model.prototype.setInputs = function (inputs) { if("GameId" in inputs) { this.variables.gameIdIn = OS.DataConversion.ServerDataConverter.from(inputs.GameId, OS.DataTypes.DataTypes.LongInteger); } };
return new OS.Model.ModelFactory(Model, "Flow.Page");
});
define("Demo.Flow.Page.mvc$view", [], function () { return (OSView.BaseView.BaseWebScreen); });
define("Demo.Flow.Page.mvc$controller", [], function () {
Controller.prototype._initialize$Action = function (callContext) {
OutSystemsDebugger.push("AAAAAAAAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:/path:x", "Demo", "Initialize", "NRFlows.ClientScreenActionFlow", callContext.id, {});
controller.safeExecuteJSNode(SomeJS, "JS", "Initialize", null, null, { Load: controller.clientActionProxies.load$Action }, {});
};
Controller.prototype.onInitializeEventHandler = function (callContext) { return controller.initialize$Action(callContext); };
});` };
  const parsed = parseO11Assets([asset], 'Demo'), component = parsed.components['Flow.Page'];
  assert.equal(component.screen, true); // empty title remains a screen via the native base class
  assert.deepEqual(component.variables.map(v => v.name), ['GameId', 'Search']);
  assert.deepEqual(component.context, { inputs: owners.screen.inputs, variables: [{ name: 'Search', attribute: 'searchVar', dataType: 'Text' }] });
  assert.deepEqual(component.lifecycle, [{ event: 'OnInitialize', handler: 'onInitializeEventHandler', method: 'initialize$Action' }]);
  assert.deepEqual(parsed.clientActions[0].calls, [{ target: 'load', kind: 'Action', via: 'self', viaVariable: null, args: [], proxy: true }]);
});
