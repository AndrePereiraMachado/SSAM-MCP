import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { qualifyOriginalDerivedInputs, canonicalizeOriginalScenarioInputs } from '../debug-odc-native-derived-inputs.mjs';
import { prepareNativeEntry } from '../debug-odc-native-run.mjs';
import { nativeScenarioInputs } from '../debug-odc-native-live.mjs';

test('actual native User Identifier expression widens only to the declared Text Identifier local', async t => {
  const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-odc-derived-native-client.json', import.meta.url), 'utf8'));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-real-derived-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'projection.json'), bytes = JSON.stringify(captured); fs.writeFileSync(file, bytes);
  const readers = { sourceContract: { path: file, sha256: createHash('sha256').update(bytes).digest('hex') },
    tree: async selector => captured.trees.find(tree => tree.key === selector.slice(1)) };
  const bindings = await qualifyOriginalDerivedInputs({ resolution: captured.resolution, readers });
  assert.equal(bindings[0].originalDerived.nativeConversion, 'system-user-identifier-to-text-identifier');
  assert.deepEqual(canonicalizeOriginalScenarioInputs({ Seed: 40 }, captured.inputs, bindings), { Seed: { value: 40 }, ExpectedUserId: { omitted: true, originalDerived: true } });
  const assignment = captured.trees[0].children.filter(node => node.kind === 'AssignNode').flatMap(node => node.children)
    .find(node => node.kind === 'Assignment' && node.properties.Variable === 'ClientUserId');
  assignment.children.find(node => node.key.endsWith('.#Value')).propertyReferences.Type.path = 'Reference:(System)/ServerEntitySignature:Account/IdentifierType:Account Identifier';
  const refused = await qualifyOriginalDerivedInputs({ resolution: captured.resolution, readers });
  assert.equal(refused[0].originalDerived, undefined);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-derived-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'source.oml'); fs.writeFileSync(file, 'pinned native projection fixture');
  const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  let count = 0;
  const node = (kind, name, properties = {}, children = []) => ({ key: String(++count).padStart(22, 'a'), kind, name, modelName: name,
    properties: { Name: name, ...properties }, propertyReferences: {}, propertyReferenceCollections: {}, propertiesOmitted: {}, propertyErrors: {}, propertiesMissing: [], children });
  const typed = (kind, name, type = 'type-identifier') => { const n = node(kind, name, { IsMandatory: 'True' }); n.propertyReferences.DataType = { key: type, kind: 'IdentifierType' }; return n; };
  const parameter = name => typed('InputParameter', name, name === 'Seed' ? 'type-integer' : 'type-identifier');
  const client = node('ClientAction', 'RequestUserContext'), server = node('ServerAction', 'ReadUserContext'), target = node('ServiceActionSignature', 'ObserveUserContext');
  const clientSeed = parameter('Seed'), local = typed('LocalVariable', 'ClientUserId');
  const serverUser = parameter('ExpectedUserId'), serverSeed = parameter('Seed'), targetUser = parameter('ExpectedUserId'), targetSeed = parameter('Seed');
  targetUser.kind = targetSeed.kind = 'InputParameterSignature';
  const assignment = node('Assignment', '', { Variable: 'ClientUserId', Value: 'GetUserId()' });
  const expression = node('TextBasedExpression', 'GetUserId()'); expression.key = assignment.key + '.#Value'; expression.propertyReferences.Type = { key: 'type-identifier', kind: 'IdentifierType' }; assignment.children.push(expression);
  const assign = node('AssignNode', 'ReadClientContext', { IsDisabled: 'False' }, [assignment]);
  const argument = (parameter, value) => { const a = node('Argument', '', { Value: value }); a.propertyReferences.Parameter = { key: parameter.key, name: parameter.name }; return a; };
  const clientCall = node('ExecuteServerActionNode', 'ReadUserContext', {}, [argument(serverUser, 'ClientUserId'), argument(serverSeed, 'Seed')]);
  const serverCall = node('ExecuteServiceActionNode', 'ObserveUserContext', {}, [argument(targetUser, 'ExpectedUserId'), argument(targetSeed, 'Seed')]);
  clientCall.propertyReferences.Action = { key: server.key }; serverCall.propertyReferences.Action = { key: target.key };
  const clientStart = node('StartNode', 'Start'), serverStart = node('StartNode', 'Start');
  clientStart.propertyReferences.Target = { key: assign.key }; assign.propertyReferences.Target = { key: clientCall.key }; serverStart.propertyReferences.Target = { key: serverCall.key };
  client.path = 'ClientAction:RequestUserContext'; server.path = 'ServerAction:ReadUserContext'; target.path = 'Reference:Producer/ServiceActionSignature:ObserveUserContext';
  clientCall.path = client.path + '/ExecuteServerActionNode:ReadUserContext'; serverCall.path = server.path + '/ExecuteServiceActionNode:ObserveUserContext';
  client.children = [clientSeed, local, clientStart, assign, clientCall]; server.children = [serverUser, serverSeed, serverStart, serverCall]; target.children = [targetUser, targetSeed];
  const finish = n => { n.children.forEach(finish); n.childrenOmitted = 0; n.childrenTotal = n.children.length; };
  [client, server, target].forEach(finish);
  const trees = [client, server, target], schema = tree => tree.children.filter(n => /InputParameter/.test(n.kind)).map(n => ({ key: n.key, name: n.name, mandatory: true, dataType: n.name === 'Seed' ? 'Integer' : 'Identifier' }));
  const bindings = [{ targetInput: 'ExpectedUserId', targetKey: targetUser.key, dataType: 'Identifier', control: 'derived', entryInput: 'ClientUserId' },
    { targetInput: 'Seed', targetKey: targetSeed.key, dataType: 'Integer', control: 'direct', entryInput: 'Seed' }];
  const resolution = { entry: { key: client.key }, target: { key: target.key }, bindings,
    path: [{ key: client.key, via: clientCall.path }, { key: server.key, via: serverCall.path }, { key: target.key }] };
  const readers = { async: true, sourceContract: { path: file, sha256: hash }, binding: { tenant: 'offline', module: 'Consumer' },
    tree: async selector => trees.find(tree => tree.key === selector.slice(1)),
    resolveTarget: async () => ({ ...target, inputs: schema(target), closureCalls: [] }),
    properties: async selector => { const tree = trees.find(tree => tree.path === selector); return tree ? { ...tree, nativeEntryKind: tree === client ? 'client-action' : null } : null; },
    inputs: async selector => schema(trees.find(tree => tree.path === selector)),
    usages: async key => [{ call: clientCall, caller: client, callee: server }, { call: serverCall, caller: server, callee: target }].filter(edge => edge.callee.key === key).map(edge => ({ consumer: { key: edge.call.key, kind: edge.call.kind, path: edge.call.path } })),
    argumentsOf: async selector => [clientCall, serverCall].find(call => call.path === selector).children.map(arg => ({ parameter: arg.propertyReferences.Parameter.key, parameterName: arg.propertyReferences.Parameter.name, value: arg.properties.Value })) };
  return { file, hash, readers, resolution, signature: schema(target), client, server, target, clientCall, serverCall, local, assign, assignment, expression, finish };
}

test('published caller computes mandatory UserId through both native argument bindings', async t => {
  const f = fixture(t), bindings = await qualifyOriginalDerivedInputs(f);
  assert.equal(bindings[0].originalDerived.expression, 'GetUserId()');
  assert.equal(bindings[0].originalDerived.hops.length, 2);
  assert.equal(bindings[0].originalDerived.sourceSha256, f.hash);
  const inputs = canonicalizeOriginalScenarioInputs({ Seed: 40 }, f.signature, bindings);
  assert.deepEqual(inputs.ExpectedUserId, { omitted: true, originalDerived: true });
  assert.equal(f.signature[0].mandatory, true);
  assert.deepEqual(nativeScenarioInputs({ action: { key: f.target.key }, bindings }, { member: { key: f.client.key }, inputs: [{ name: 'Seed' }] }, { inputs }), { Seed: { value: 40 } });
});

test('explicit derived identity remains forbidden and other mandatory inputs remain required', async t => {
  const f = fixture(t), bindings = await qualifyOriginalDerivedInputs(f);
  for (const value of ['someone-else', null, undefined]) assert.throws(() => canonicalizeOriginalScenarioInputs({ Seed: 40, ExpectedUserId: value }, f.signature, bindings), /target_input_not_controllable/);
  assert.throws(() => canonicalizeOriginalScenarioInputs({}, f.signature, bindings), /input_mandatory_missing:Seed/);
});

test('incomplete projections, other expressions, branches and mismatched argument refs cannot relax mandatory inputs', async t => {
  for (const mutate of [f => { f.client.childrenOmitted = 1; }, f => { f.assignment.properties.Value = 'OtherUserId()'; },
    f => { f.assign.kind = 'IfNode'; }, f => { f.expression.propertyReferences.Type.key = 'wrong-type'; },
    f => { f.clientCall.children[0].propertyReferences.Parameter.key = 'wrong-parameter'; },
    f => { f.clientCall.propertyReferences.Action.key = 'wrong-callee'; }]) {
    const f = fixture(t); mutate(f);
    const bindings = await qualifyOriginalDerivedInputs(f);
    assert.equal(bindings[0].originalDerived, undefined);
    assert.throws(() => canonicalizeOriginalScenarioInputs({ Seed: 40 }, f.signature, bindings), /input_mandatory_missing:ExpectedUserId/);
  }
});

test('changed source refuses the derived input proof', async t => {
  const f = fixture(t); fs.appendFileSync(f.file, ' changed');
  await assert.rejects(() => qualifyOriginalDerivedInputs(f), /derived_input_source_changed/);
});

test('public prepare refuses a global backend entry before any app login', async t => {
  const f = fixture(t);
  const prepared = await prepareNativeEntry({ action: f.target.key, entry: f.client.key, inputs: { Seed: 40 }, persist: false }, f.readers);
  assert.equal(prepared.ok, false); assert.equal(prepared.error, 'debug_odc_native_original_screen_entry_required');
});

function screenFixture(t) {
  const f=fixture(t), node=(key,kind,name,children=[])=>({key,kind,name,modelName:name,properties:{Name:name},propertyReferences:{},propertyReferenceCollections:{},children,propertiesOmitted:{},propertyErrors:{},propertiesMissing:[]});
  const screen=node('screen','MobileScreen','Screen'), action=node('handler','ScreenAction','Invoke'), local=node('seed-local','LocalVariable','ProbeSeed');
  screen.path='MobileFlow:Flow/MobileScreen:Screen'; action.path=screen.path+'/ScreenAction:Invoke';
  local.properties.DefaultValue='40';local.propertyReferences.DataType={key:'type-integer',kind:'BasicType',label:'Integer'};
  const start=node('screen-start','StartNode','Start'),call=node('screen-call','ExecuteClientActionNode','RequestUserContext'),arg=node('screen-arg','Argument','');
  arg.properties.Value='ProbeSeed';arg.propertyReferences.Parameter={key:f.client.children[0].key,name:'Seed'};
  call.children=[arg];call.propertyReferences.Action={key:f.client.key};call.path=action.path+'/ExecuteClientActionNode:RequestUserContext';start.propertyReferences.Target={key:call.key};
  action.children=[start,call];screen.children=[local,action];f.finish(screen);
  const oldTree=f.readers.tree,oldProps=f.readers.properties,oldInputs=f.readers.inputs,oldUsages=f.readers.usages,oldArgs=f.readers.argumentsOf;
  f.readers.tree=async selector=>[screen,action].find(n=>selector==='@'+n.key||selector===n.path)??oldTree(selector);
  f.readers.properties=async selector=>{const n=[screen,action].find(n=>n.path===selector);return n?{...n,nativeEntryKind:n===action?'client-action':null}:oldProps(selector);};
  f.readers.inputs=async selector=>[screen.path,action.path].includes(selector)?[]:oldInputs(selector);
  f.readers.usages=async key=>key===f.client.key?[{consumer:{key:call.key,kind:call.kind,path:call.path}}]:oldUsages(key);
  f.readers.argumentsOf=async selector=>selector===call.path?[{parameter:arg.propertyReferences.Parameter.key,parameterName:'Seed',value:'ProbeSeed'}]:oldArgs(selector);
  f.resolution.entry={key:action.key};f.resolution.path.unshift({key:action.key,via:call.path});f.resolution.bindings[1]={...f.resolution.bindings[1],control:'derived',entryInput:'ProbeSeed'};
  return {...f,screen,action,screenLocal:local,screenCall:call};
}

test('original ScreenAction keeps caller guards and proves the typed default without injecting it', async t=>{
  const f=screenFixture(t),bindings=await qualifyOriginalDerivedInputs(f);
  const original=bindings[1].originalDerived;
  assert.equal(original.kind,'native-screen-local-default');assert.equal(original.ownerKey,f.screen.key);
  assert.equal(original.variableKey,f.screenLocal.key);assert.equal(original.defaultValueSha256,createHash('sha256').update('40').digest('hex'));
  assert.equal(original.hops.length,3);assert.equal(original.evaluatedByDebugger,false);
  assert.deepEqual(canonicalizeOriginalScenarioInputs({},f.signature,bindings),{ExpectedUserId:{omitted:true,originalDerived:true},Seed:{omitted:true,originalDerived:true}});
  assert.throws(()=>canonicalizeOriginalScenarioInputs({Seed:40},f.signature,bindings),/target_input_not_controllable/);
  assert.throws(()=>canonicalizeOriginalScenarioInputs({},f.signature,bindings,{screen:{variables:{ProbeSeed:40}}}),/screen_default_input_overridden/);
  const prepared=await prepareNativeEntry({action:f.target.key,entry:f.action.key,inputs:{},persist:false},f.readers);
  assert.equal(prepared.ok,true);assert.equal(prepared.entry.key,f.action.key);assert.equal(prepared.path.length,4);
  assert.equal(prepared.action.inputs.find(input => input.name === 'ExpectedUserId').mandatory, true);
  assert.equal(prepared.bindings.find(binding => binding.targetInput === 'ExpectedUserId').originalDerived.kind, 'native-caller-user-id');
  assert.deepEqual(prepared.scenarios[0].inputs, { Seed:{omitted:true,originalDerived:true},ExpectedUserId:{omitted:true,originalDerived:true} });
});

test('screen defaults reject expressions, wrong types, shadowing and writes before the call', async t=>{
  for(const mutate of [f=>f.screenLocal.properties.DefaultValue='OtherAction()',f=>f.screenLocal.propertyReferences.DataType.key='foreign-type',
    f=>f.action.children.push({...f.screenLocal,key:'shadow'}),f=>f.screen.childrenOmitted=1]){
    const f=screenFixture(t);mutate(f);if(!f.screen.childrenOmitted)f.finish(f.screen);
    const bindings=await qualifyOriginalDerivedInputs(f);assert.equal(bindings[1].originalDerived,undefined);
  }
});

test('a pure global ClientAction still prepares without inventing a screen',async t=>{
  const f=fixture(t);f.readers.resolveTarget=async()=>({...f.client,inputs:[{name:'Seed',mandatory:true,dataType:'Integer'}],closureCalls:[]});
  const prepared=await prepareNativeEntry({action:f.client.key,entry:f.client.key,inputs:{Seed:40},persist:false},f.readers);
  assert.equal(prepared.ok,true);assert.equal(prepared.entry.key,f.client.key);
});

test('explicit screen state keeps the derived target omitted and native caller intact', async t => {
  const f = screenFixture(t);
  f.screenLocal.properties.DefaultValue = '';
  const context = {screen:{variables:{ProbeSeed:29}}};
  const bindings = await qualifyOriginalDerivedInputs({...f,contexts:[context]});
  assert.equal(bindings[1].originalDerived.kind,'native-screen-local-context');
  assert.deepEqual(canonicalizeOriginalScenarioInputs({},f.signature,bindings,context).Seed,{omitted:true,originalDerived:true});
  assert.throws(()=>canonicalizeOriginalScenarioInputs({Seed:29},f.signature,bindings,context),/target_input_not_controllable/);
  assert.throws(()=>canonicalizeOriginalScenarioInputs({},f.signature,bindings),/screen_context_input_missing/);
  assert.equal((await qualifyOriginalDerivedInputs({...f,contexts:[context,undefined]}))[1].originalDerived,undefined);
  const prepared=await prepareNativeEntry({action:f.target.key,entry:f.action.key,scenarios:[{name:'one',context},{name:'two',context:{screen:{variables:{ProbeSeed:17}}}}],persist:false},f.readers);
  assert.equal(prepared.ok,true);
  assert.equal(prepared.scenarios[1].context.screen.variables.ProbeSeed,17);
  assert.deepEqual(prepared.scenarios[1].inputs.Seed,{omitted:true,originalDerived:true});
  f.screenLocal.propertyReferences.DataType.key='foreign';
  assert.equal((await qualifyOriginalDerivedInputs({...f,contexts:[context]}))[1].originalDerived,undefined);
});

import { bindInputs } from '../debug-odc-native-entry-resolve.mjs';
test('identifier base carried in the signature types native-entry identifier inputs; an unresolved base refuses', () => {
  const signature = [{ name: 'OrderId', dataType: 'Identifier', identifierBase: 'LongInteger', mandatory: true },
    { name: 'Code', dataType: 'Identifier', identifierBase: 'Text', mandatory: false }, { name: 'Raw', dataType: 'Identifier', mandatory: false }];
  assert.deepEqual(canonicalizeOriginalScenarioInputs({ OrderId: 42, Code: 'A-1' }, signature, []),
    { OrderId: { value: '42' }, Code: { value: 'A-1' }, Raw: { omitted: true } });
  assert.throws(() => canonicalizeOriginalScenarioInputs({ OrderId: 'abc' }, signature, []), /input_type_invalid/);
  assert.throws(() => canonicalizeOriginalScenarioInputs({ OrderId: '1', Raw: '1' }, signature, []), /input_identifier_base_unresolved:Raw/);
  // The resolver's bindings keep the target input's identifier base next to its data type.
  const inputs = { target: [{ name: 'OrderId', key: 'k1', dataType: 'Identifier', identifierBase: 'LongInteger', identifierKey: 'E.#IdentifierType' }], entry: [{ name: 'OrderId', key: 'k0' }] };
  const graph = { inputs: key => inputs[key] };
  const bindings = bindInputs(graph, [{ key: 'entry', edge: { arguments: [{ parameter: 'k1', value: 'OrderId' }] } }, { key: 'target' }]);
  assert.deepEqual(bindings, [{ targetInput: 'OrderId', targetKey: 'k1', dataType: 'Identifier', identifierBase: 'LongInteger', control: 'direct', entryInput: 'OrderId' }]);
});
