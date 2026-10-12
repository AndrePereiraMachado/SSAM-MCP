import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createNativeModelReader } from '../debug-native-model.mjs';

const node = (key, kind, children = [], extra = {}) => ({ key, kind, name: key, path: kind + ':' + key, properties: {}, children, ...extra });
function fixture(t, nodes, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-model-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.oml'); fs.writeFileSync(file, options.body ?? 'synthetic model');
  const base = { file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }, reads = [];
  const reader = createNativeModelReader({ base, lane: 'odc', ...options,
    inspect: async request => {
      assert.equal(request.expectedSourceSha256, base.sha256); reads.push(request);
      if (request.usages) return options.usages(request);
      const key = request.path.replace(/^@/, ''), value = nodes.find(n => n.key === key || n.path === key);
      assert.ok(value, 'fixture node missing: ' + key); return { ok: true, tree: structuredClone(value), sourceSha256: base.sha256 };
    },
    map: async request => { assert.equal(request.expectedSourceSha256, base.sha256); return options.map?.(request) ?? { entries: [], count: 0 }; },
  });
  return { reader, base, reads };
}

test('22-character action names resolve by name; explicit keys and legacy bare keys retain identity', async t => {
  const action = node('A'.repeat(22), 'ServerAction', [], { name: 'SSAMDbgReadUserContext' });
  const collision = node('SSAMDbgReadUserContext', 'ServerAction', [], { name: 'DifferentAction' });
  const { reader } = fixture(t, [action, collision], {
    map: ({ name }) => ({ entries: name === action.name ? [action] : [], count: name === action.name ? 1 : 0 }),
  });
  assert.equal((await reader.resolveTarget(action.name)).key, action.key);
  assert.equal((await reader.resolveTarget('@' + collision.key)).key, collision.key);
  assert.equal((await reader.resolveTarget(action.key)).key, action.key);
  const ambiguous = fixture(t, [action, collision], {
    map: () => ({ entries: [action, collision], count: 2 }),
  });
  await assert.rejects(ambiguous.reader.resolveTarget(action.name), /action_ambiguous_use_key/);
});

test('all omitted children and all usage pages participate in the same hash-bound read', async t => {
  const a = node('action', 'ServerAction', [], { childrenOmitted: 2, childrenTotal: 2 });
  const children = [node('first', 'StartNode'), node('last', 'EndNode')];
  const { reader, reads } = fixture(t, [a, ...children], {
    map: ({ offset }) => ({ entries: [children[offset]], count: 2, nextOffset: offset === 0 ? 1 : null }),
    usages: ({ offset }) => ({ entries: [{ consumer: { key: String(offset) } }], count: 2, nextOffset: offset === 0 ? 1 : null }),
  });
  assert.deepEqual((await reader.tree('@action')).children.map(n => n.key), ['first', 'last']);
  assert.equal((await reader.usages('action')).length, 2);
  assert.equal(reads.filter(r => r.usages).length, 2);
});

test('incomplete pagination and changed snapshots cannot be mistaken for empty graphs', async t => {
  const { reader, base } = fixture(t, [node('action', 'ServerAction')], { usages: () => ({ entries: [], count: 1 }) });
  await assert.rejects(reader.usages('action'), /pagination_incomplete/);
  await reader.tree('@action'); fs.writeFileSync(base.file, 'changed');
  await assert.rejects(reader.tree('@action'), /source_changed/);
});

test('list and nested record inputs retain their type and mandatory attributes', async t => {
  const basic = { key: 'text', kind: 'BasicType', label: 'Text' };
  const attribute = node('Label', 'Attribute', [], { propertyReferences: { DataType: basic }, properties: { IsMandatory: 'True' } });
  const record = node('record', 'Structure', [attribute]);
  const list = node('list', 'ListType', [], { propertyReferences: { ElementType: { key: 'record', kind: 'Structure' } } });
  const parameter = node('Rows', 'InputParameter', [], { properties: { IsMandatory: 'True' }, propertyReferences: { DataType: { key: 'list', kind: 'ListType' } } });
  const { reader } = fixture(t, [node('action', 'ServerAction', [parameter]), list, record, attribute]);
  const [input] = await reader.inputs('@action');
  assert.equal(input.dataType, 'RecordList'); assert.equal(input.mandatory, true);
  assert.equal(input.elementType.dataType, 'Record');
  assert.deepEqual(input.complexType, [{ name: 'Label', mandatory: true, dataType: 'Text' }]);
});

test('library effects follow producer identity and retain pinned provenance', async t => {
  const signature = node('imported', 'ServerActionSignature', [], { properties: { OriginalKey: 'original' }, path: 'Reference:Lib/ServerActionSignature:Work' });
  const reference = node('lib', 'Reference', [], { path: 'Reference:Lib', properties: { Revision: '7' } });
  const call = node('call', 'ExecuteServerActionNode', [], { propertyReferences: { Action: { key: signature.key, kind: signature.kind, path: signature.path } } });
  const producer = fixture(t, [node('original', 'ServerAction', [node('sql', 'SQLNode')])], { body: 'producer revision seven' });
  let resolved = 0;
  const { reader } = fixture(t, [node('target', 'ServerAction', [call]), signature, reference], {
    readExternal: async value => {
      resolved++; assert.equal(value.signature.properties.OriginalKey, 'original'); assert.equal(value.reference.properties.Revision, '7');
      return { reader: producer.reader, key: 'original', source: { revision: 7, sha256: producer.base.sha256 } };
    },
  });
  const closure = await reader.closure('@target');
  assert.equal(resolved, 1); assert.equal(closure[0].bodyRead, true);
  assert.deepEqual(closure[0].reference, { consumerSourceSha256: createHash('sha256').update('synthetic model').digest('hex'),
    moduleKey: null, moduleType: null, revision: '7', originalActionKey: 'original' });
  assert.equal(closure[1].kind, 'SQLNode'); assert.equal(closure[1].producer.revision, 7);
});

test('native system-model refusal remains an unread call; corruption is still fatal', async t => {
  const signature = node('imported', 'ClientActionSignature', [], { path: 'Reference:System/ClientActionSignature:ListClear' });
  const reference = node('lib', 'Reference', [], { path: 'Reference:System' });
  const call = node('call', 'ExecuteClientActionNode', [], { propertyReferences: { Action: { key: signature.key, kind: signature.kind, path: signature.path } } });
  let message = 'debug_native_model_read_failed: System modules cannot be loaded with the Model API.';
  const { reader } = fixture(t, [node('target', 'ClientAction', [call]), signature, reference], {
    readExternal: async () => ({ key: 'original', source: { revision: 4 }, reader: { closure: async () => { throw new Error(message); } } }),
  });
  const [unread] = await reader.closure('@target'); assert.equal(unread.bodyRead, false); assert.equal(unread.bodyUnavailable, 'system-model-unavailable');
  message = 'debug_native_model_source_changed'; await assert.rejects(reader.closure('@target'), /source_changed/);
});

test('native expression references traverse local functions and acquire the exact imported producer without name matching', async t => {
  const imported = node('imported', 'ClientActionSignature', [], { name: 'SameName', properties: { Function: 'True', OriginalKey: 'original' }, path: 'Reference:Library/ClientActionSignature:SameName' });
  const reference = node('library', 'Reference', [], { path: 'Reference:Library', properties: { Revision: '8' } });
  const outer = node('outer.#Value', 'TextBasedExpression');
  const inner = node('inner.#Value', 'TextBasedExpression');
  const local = node('local', 'ClientAction', [inner], { name: 'SameName', properties: { Function: 'True' } });
  const producer = fixture(t, [node('original', 'ClientAction', [node('js', 'JavaScriptNode')])], { body: 'revision eight' });
  const resolved = [];
  const f = fixture(t, [node('entry', 'ClientAction', [outer]), local, imported, reference], {
    map: ({ kind }) => { const entries = [local, imported].filter(n => n.kind === kind); return { entries, count: entries.length }; },
    usages: ({ path }) => ({ entries: [{ target: { key: path.slice(1) }, consumer: { key: path === '@local' ? outer.key : inner.key }, relation: 'direct' }], count: 1 }),
    readExternal: async value => { resolved.push(value.signature.key); return { reader: producer.reader, key: 'original', source: { revision: 8 } }; },
  });
  const calls = await f.reader.closure('@entry');
  assert.deepEqual(calls.map(c => c.actionKey ?? c.kind), ['local', 'imported', 'JavaScriptNode']);
  assert.equal(calls[1].bodyRead, true); assert.equal(calls[1].reference.revision, '8');
  assert.deepEqual(resolved, ['imported']);
  await f.reader.closure('@entry');
  assert.equal(f.reads.filter(r => r.usages).length, 2, 'native usage index is reused for the same pinned model');
});

test('function usage with a different native target is refused instead of acquiring a guessed producer', async t => {
  const fn = node('fn', 'ClientActionSignature', [], { properties: { Function: 'True' }, path: 'Reference:Lib/ClientActionSignature:Fn' });
  const f = fixture(t, [node('entry', 'ClientAction'), fn], {
    map: ({ kind }) => ({ entries: kind === fn.kind ? [fn] : [], count: kind === fn.kind ? 1 : 0 }),
    usages: () => ({ entries: [{ target: { key: 'another' }, consumer: { key: 'entry' }, relation: 'direct' }], count: 1 }),
    readExternal: async () => { assert.fail('must not acquire a producer from mismatched usage'); },
  });
  await assert.rejects(f.reader.closure('@entry'), /function_usage_invalid/);
});

test('O11 reads real parameter children when the ScreenAction collection getter is unimplemented', async t => {
  const a = node('action', 'ScreenAction', [node('end', 'EndNode')], { propertyErrors: { OutputParameters: 'The method or operation is not implemented.' } });
  const f = fixture(t, [a], { lane: 'o11' });
  const value = await f.reader.tree('@action'); assert.equal(value.children[0].kind, 'EndNode');
  assert.ok(value.propertyErrors.OutputParameters, 'the native diagnostic remains visible');
  const g = fixture(t, [{ ...a, propertyErrors: { Roles: 'The method or operation is not implemented.' } }], { lane: 'o11' });
  await assert.rejects(g.reader.tree('@action'), /projection_incomplete/);
});

test('O11 synthetic LaunchProcess input retains its native diagnostic without blocking unrelated Preparation', async t => {
  const key='4+alaFPb6EaTOhmUvpYDxA', process='x9V_hqwviUWPKHnvgsiTtQ', action=process+'.#LaunchProcess';
  const parameter=node(key,'InputParameter',[],{name:'ContactId',path:'Process:ApproveContact/ActionSignature:LaunchApproveContact/InputParameter:ContactId',
    properties:{Key:'/Processes.'+process+'/ProcessActions.#LaunchProcess/SyntheticInputParameters.'+key,Type:'EntityReferenceLongInteger'},
    propertyErrors:{DataType:'The method or operation is not implemented.'}});
  const signature=node(action,'ActionSignature',[parameter]);
  const preparation=node('dEWwXGH7NkeApGZ+qJiYJQ.#Preparation','Preparation');
  const f=fixture(t,[signature,parameter,preparation],{lane:'o11'});
  assert.equal((await f.reader.tree('@'+action)).children[0].propertyErrors.DataType,parameter.propertyErrors.DataType);
  assert.equal((await f.reader.tree('@'+preparation.key)).kind,'Preparation');
  await assert.rejects(f.reader.inputs('@'+action),/type_unresolved/);
  const odc=fixture(t,[signature,parameter],{lane:'odc'});
  await assert.rejects(odc.reader.tree('@'+action),/projection_incomplete/);
  const ordinary=fixture(t,[{...parameter,properties:{...parameter.properties,Key:'/ServerActions.'+action+'/InputParameters.'+key}}],{lane:'o11'});
  await assert.rejects(ordinary.reader.tree('@'+key),/projection_incomplete/);
});

test('client runtime presence uses complete local projections, excluding imports and following pages', async t => {
  const visited = [];
  const f = fixture(t, [], { map: ({ kind, offset }) => {
    visited.push([kind, offset]);
    if (kind !== 'ClientAction') return { entries: [], count: 0 };
    return { entries: [{ kind, path: offset === 0 ? 'Reference:Lib/ClientAction:Imported' : 'ClientAction:Local' }],
      count: 2, nextOffset: offset === 0 ? 1 : null };
  } });
  assert.equal(await f.reader.hasClientRuntime(), true);
  assert.deepEqual(visited, [['MobileScreen', 0], ['MobileBlock', 0], ['ClientAction', 0], ['ClientAction', 1]]);
  const service = fixture(t, [], { map: ({ kind }) => ({ entries: [{ kind, path: 'Reference:Lib/' + kind + ':Imported' }], count: 1 }) });
  assert.equal(await service.reader.hasClientRuntime(), false);
  const incomplete = fixture(t, [], { map: () => ({ entries: [], count: 1 }) });
  await assert.rejects(incomplete.reader.hasClientRuntime(), /pagination_incomplete/);
  const changed = fixture(t, []);
  fs.writeFileSync(changed.base.file, 'changed');
  await assert.rejects(changed.reader.hasClientRuntime(), /source_changed/);
});

test('local kind list follows all pages and imported target selection is opt-in for ODC only', async t => {
  const signature = node('S'.repeat(22), 'ServerActionSignature', [], { path: 'Reference:Lib/ServerActionSignature:Work' });
  const reference = node('R'.repeat(22), 'Reference', [], { path: 'Reference:Lib' });
  const mapping = ({ offset }) => ({ entries: [{ key: String(offset), kind: 'ProcessFlow',
    path: offset === 0 ? 'Reference:Lib/ProcessFlow:Imported' : 'ProcessFlow:Local' }], count: 2, nextOffset: offset === 0 ? 1 : null });
  const f = fixture(t, [signature, reference], { map: mapping, allowImportedTargets: true });
  assert.deepEqual((await f.reader.list('ProcessFlow')).map(n => n.path), ['ProcessFlow:Local']);
  assert.equal((await f.reader.resolveTarget('@' + signature.key)).importedSignature.reference.key, reference.key);
  const ordinary = fixture(t, [signature, reference]);
  await assert.rejects(ordinary.reader.resolveTarget('@' + signature.key), /target_not_action/);
  const o11 = fixture(t, [signature, reference], { lane: 'o11', allowImportedTargets: true });
  await assert.rejects(o11.reader.resolveTarget('@' + signature.key), /target_not_action/);
});
