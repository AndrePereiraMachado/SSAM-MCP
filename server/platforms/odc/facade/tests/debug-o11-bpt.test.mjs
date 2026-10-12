import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nativeO11Process } from '../debug-o11-bpt.mjs';
import { graphFromReadings, buildO11CallGraph, resolveO11Entry } from '../debug-o11-entry-graph.mjs';
import { createO11NativeRun } from '../debug-o11-native-run.mjs';

// Captured by the O11 native reader from kernel/tests/jobs/process-bpt.json's local
// OML (94dc0bbee426f0ab22a9326d8e2c11c7405e8f518e2d80876066fed0e5d4b672).
// Consumer below is a synthetic graph edge; no endpoint or application is executed.
const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/debug-o11-bpt-native-reading.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const module = { module: 'Headless_CS', moduleKey: 'Kawk_WFx5USxo7qFAB0lCQ' };
const key = c => c.repeat(22);
const process = () => structuredClone(captured.tree);
const consumer = (p, kind = 'RestServiceAction') => ({ kind, key: key('X'), name: 'Submit', path: kind + ':Submit', properties: {}, children: [{
  kind: 'ExecuteServerActionNode', key: key('Y'), propertyReferences: { Action: p.propertyReferences.LaunchProcessAction }, children: [],
}] });
const graph = (p, ...extra) => buildO11CallGraph([graphFromReadings([p, ...extra], module)]);

test('native BPT reader preserves the generated launch key and separates activity body from process flow', () => {
  assert.equal(captured.sourceSha256.toLowerCase(), '94dc0bbee426f0ab22a9326d8e2c11c7405e8f518e2d80876066fed0e5d4b672');
  const p = nativeO11Process(process());
  assert.equal(p.launchActionKey, p.processKey + '.#LaunchProcess');
  assert.deepEqual(p.trigger, { kind: 'explicit-launch' }); assert.equal(p.activities.length, 1);
  assert.equal(p.activities[0].reachable, true); assert.equal(p.activities[0].name, 'Notify');
  assert.equal(p.activities[0].startNodeKey, 'tYnx5xiHeES0yb1JK_l9SQ');
  assert.deepEqual(p.activities[0].flowPath, ['M6PjIflXhUWQjwGGxM_I5w', '4g5q+CpcFUqZEKg0sBKQDw']);
  assert.equal(p.executionCompleted, false); assert.equal(p.requestOwnershipProved, false);
});

test('BPT launch resolves to the original app entry while the activity remains an asynchronous target', () => {
  const p = process(), g = graph(p, consumer(p));
  const resolved = resolveO11Entry(g, 'Notify');
  assert.equal(resolved.state, 'background-trigger-resolved'); assert.equal(resolved.entry.runnable, false);
  assert.equal(resolved.originalLaunch.state, 'resolved'); assert.equal(resolved.originalLaunch.entry.name, 'Submit');
  assert.equal(resolved.originalLaunch.target.key, p.key + '.#LaunchProcess');
  assert.deepEqual(resolved.originalLaunch.entryInputs, []); assert.deepEqual(resolved.bindings, []);
  assert.equal(resolved.background.launcherContext, 'app-user'); assert.equal(resolved.background.activityContext, 'native-background');
  assert.equal(resolved.background.directActivityInvocation, false); assert.equal(resolved.background.executionCompleted, false);
  assert.equal(resolveO11Entry(g, '@' + p.key + '.#LaunchProcess').state, 'resolved');
  assert.equal(resolveO11Entry(g, '@' + p.key).state, 'background-trigger-resolved');
});

test('unconsumed launch signature exposes no invocable app entry; disconnected activities are not guessed reachable', () => {
  const p = process();
  assert.equal(resolveO11Entry(graph(p), 'Notify').state, 'no-invocable-entry');
  const start = p.children.find(c => c.key === 'M6PjIflXhUWQjwGGxM_I5w');
  start.children = []; start.childrenTotal = 0;
  for (const name of ['Targets', 'Connectors']) start.propertyReferenceCollections[name] = { items: [], total: 0, omitted: 0 };
  assert.equal(nativeO11Process(p).activities[0].reachable, false);
  assert.equal(resolveO11Entry(graph(p, consumer(p)), 'Notify').state, 'no-invocable-entry');
});

test('native process metadata refuses omitted nodes, disagreement and entity event without exact identity', () => {
  for (const [change, code] of [
    [p => { p.childrenOmitted = 1; }, /process_children_incomplete/],
    [p => { p.propertyReferenceCollections.Nodes.omitted = 1; }, /native_nodes_incomplete/],
    [p => { p.children.find(c => c.kind === 'StartNode').propertyReferenceCollections.Targets.items[0].key = key('Z'); }, /flow_target_outside_process/],
    [p => { p.properties.LaunchOnAction = 'Create'; }, /launch_entity_identity_unavailable/],
  ]) { const p = process(); change(p); assert.throws(() => nativeO11Process(p), code); }
  const p = process(); p.properties.LaunchOnAction = 'Create'; p.propertyReferences.LaunchOnEntity = { key: key('E'), kind: 'Entity', name: 'Booking' };
  const plan = nativeO11Process(p); assert.equal(plan.trigger.kind, 'entity-event'); assert.equal(plan.trigger.executable, false);
  assert.match(plan.trigger.missingCapability, /native entity Create\/Update action identity/);
});

test('An unimplemented native launch input type cannot become an executable process route', () => {
  const p=process(), signature=p.children.find(n=>n.kind==='ActionSignature');
  signature.children.push({kind:'InputParameter',name:'ContactId',key:key('I'),children:[],childrenTotal:0,childrenOmitted:0,
    properties:{Type:'EntityReferenceLongInteger'},propertyErrors:{DataType:'The method or operation is not implemented.'}});
  signature.childrenTotal=signature.children.length;
  assert.throws(()=>nativeO11Process(p),/launch_input_type_unavailable/);
  const g=graph(p,consumer(p));
  assert.equal(g.nodes.get(module.moduleKey+'*'+p.key).process.error,'debug_o11_native_bpt_launch_input_type_unavailable');
  assert.notEqual(resolveO11Entry(g,'Notify').state,'background-trigger-resolved');
});

test('a synchronous caller of an activity callee wins over the asynchronous process route', () => {
  const p = process(), activity = p.children.find(c => c.kind === 'AutomaticActivityNode');
  const action = { kind: 'ServerAction', key: key('A'), name: 'SendNotice', properties: {}, children: [] };
  activity.children.push({ kind: 'ExecuteServerActionNode', key: key('B'), propertyReferences: { Action: { kind: action.kind, key: action.key, name: action.name } }, children: [] });
  const direct = { kind: 'RestServiceAction', key: key('C'), name: 'SendDirect', properties: {}, children: [{
    kind: 'ExecuteServerActionNode', key: key('D'), propertyReferences: { Action: { kind: action.kind, key: action.key, name: action.name } }, children: [],
  }] };
  const resolved = resolveO11Entry(graph(p, action, direct, consumer(p)), action.name);
  assert.equal(resolved.state, 'resolved'); assert.equal(resolved.entry.name, 'SendDirect');
  const asyncOnly = resolveO11Entry(graph(p, action, consumer(p)), action.name);
  assert.equal(asyncOnly.state, 'background-trigger-resolved'); assert.equal(asyncOnly.originalLaunch.entry.name, 'Submit');
});

test('public O11 prepare exposes original-launcher inputs and never executes an activity body', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-bpt-prepare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pin = (name, value) => { const bytes = Buffer.from(JSON.stringify(value)), file = path.join(root, name);
    fs.writeFileSync(file, bytes); return { path: file, sha256: createHash('sha256').update(bytes).digest('hex') }; };
  const p = process(), source = pin('source.oml', captured), input = { op: 'prepare', host: 'dev.example.test', ...module,
    applicationKey: key('Z'), runtimeUrl: 'https://dev.example.test/Headless_CS/', action: 'Notify', trace: 'none', contextMode: 'native-background' };
  const runner = createO11NativeRun({ root, capture: async target => ({ versionId: 7, snapshot: source,
    inventoryProof: pin('inventory.json', { host: input.host, capturedAtUtc: new Date().toISOString(), modules: [{
      Name: target.module, Key: target.moduleKey, ApplicationKey: target.applicationKey, VersionId: 7, IsActive: true }] }),
    readings: [{ tree: p }, { tree: consumer(p) }] }),
    assets: async () => { throw Error('BPT REST launch plan must not load AMD'); },
    prepareUser: async () => { throw Error('prepare cannot prompt or execute'); },
  });
  const prepared = await runner(input);
  assert.equal(prepared.ok, true, prepared.error); assert.equal(prepared.resolution.state, 'background-trigger-resolved');
  assert.equal(prepared.background.originalEntryResolved, true); assert.equal(prepared.background.executable, false);
  assert.equal(prepared.background.originalLaunch.entry.name, 'Submit');
  assert.deepEqual(prepared.background.originalLaunch.entryInputs, []); assert.equal(prepared.background.directActivityInvocation, false);
  const refused = await runner({ ...input, op: 'run', words: 'Run once in background' });
  assert.equal(refused.error, 'debug_native_background_bpt_original_launcher_contract_required'); assert.equal(refused.lockRetained, false);
  const directLaunch = await runner({ ...input, op: 'run', action: '@' + p.key + '.#LaunchProcess' });
  assert.equal(directLaunch.error, 'debug_native_background_bpt_original_launcher_contract_required'); assert.equal(directLaunch.lockRetained, false);
});
