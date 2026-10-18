import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Golden: the REAL private worker over the ORIGINAL published Headless_UI runtime assets cached by an earlier proof
// (read only through SSAM_DEBUG_EVIDENCE_ROOT), with a synthetic in-process origin (no network, no vault, no window).
const evidence = process.env.SSAM_DEBUG_EVIDENCE_ROOT;
const harness = fileURLToPath(new URL('./fixtures/debug-o11-native-worker-harness.mjs', import.meta.url));

test('original O11 runtime retains safe HTTP evidence for a non-JSON gateway failure without counting an answer', { skip: !evidence, timeout: 45000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-response-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, ['--experimental-webstorage', harness, evidence, root], {
    encoding: 'utf8', timeout: 40000, windowsHide: true,
    env: { ...process.env, SSAM_DEBUG_RESPONSE_FAILURE_PROOF: '1' },
  });
  assert.equal(run.status, 0, 'harness exited ' + run.status + ': ' + run.stderr);
  const { out: [data], posts } = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(data.results[0].ok, false);
  assert.deepEqual(data.results[0].requests, { submitted: 1, answered: 0 });
  assert.equal(data.receipt.requestUncertain, true);
  assert.equal(data.receipt.memoryCleared, true);
  assert.equal(data.receipt.lastEntryResponse.status, 504);
  assert.equal(data.receipt.lastEntryResponse.nativeEnvelopeAccepted, false);
  assert.ok(data.receipt.lastEntryResponse.bytes > 0);
  assert.ok(data.receipt.lastEntryResponse.durationMs >= 0);
  assert.match(data.receipt.lastEntryResponse.sha256, /^[a-f0-9]{64}$/);
  assert.equal(data.leaks, false);
  assert.equal(posts.filter(p => p.path.endsWith('/DataActionGetUserNameFromServer')).length, 1);
});

test('original O11 runtime answers beyond ordinary invocation timeout within its fixed interactive lease', { skip: !evidence, timeout: 45000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-server-inspection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, ['--experimental-webstorage', harness, evidence, root], {
    encoding: 'utf8', timeout: 40000, windowsHide: true, env: { ...process.env, SSAM_DEBUG_SERVER_INSPECTION_PROOF: '1' },
  });
  assert.equal(run.status, 0, 'harness exited ' + run.status + ': ' + run.stderr);
  const { out: [data] } = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.equal(data.results[0].ok, true, JSON.stringify(data.results[0].exception));
  assert.ok(data.results[0].durationMs >= 11000);
  assert.deepEqual(data.results[0].requests, { submitted: 1, answered: 1 });
  assert.equal(data.receipt.serverInspection.fixed, true);
  assert.equal(data.receipt.serverInspection.nativeTimeoutConfigured, true);
  assert.ok(data.receipt.serverInspection.nativeTimeoutSeconds >= 240);
  assert.equal(data.receipt.requestUncertain, false); assert.equal(data.receipt.memoryCleared, true);
});

test('original runtime keeps a suspended request alive past its native timeout', { skip: !evidence, timeout: 60000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-suspension-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, ['--experimental-webstorage', harness, evidence, root], {
    encoding: 'utf8', timeout: 55000, windowsHide: true, env: { ...process.env, SSAM_DEBUG_SUSPENSION_PROOF: '1' },
  });
  assert.equal(run.status, 0, 'harness exited ' + run.status + ': ' + run.stderr);
  const { out: [data], suspensionChecks } = JSON.parse(run.stdout.trim().split('\n').at(-1));
  assert.ok(suspensionChecks.length > 0, 'original SDK must emit its native suspension request');
  assert.ok(suspensionChecks.every(c => c.tokenPresent));
  assert.deepEqual(data.results[0].requests, { submitted: 1, answered: 1 });
  assert.equal(data.results[0].ok, true);
  assert.equal(data.receipt.requestUncertain, false);
  assert.equal(data.receipt.memoryCleared, true);
});

test('original runtime: typed stub scenarios, server exception, defaults, data action and traced client action', { skip: !evidence, timeout: 180000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-golden-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, ['--experimental-webstorage', harness, evidence, root], { encoding: 'utf8', timeout: 170000, windowsHide: true });
  assert.equal(run.status, 0, 'harness exited ' + run.status);
  const { out, posts } = JSON.parse(run.stdout.trim().split('\n').at(-1));
  const [stub, data, slug, lifecycle] = out;

  // Server action through its original screen stub, typed inputs (Unicode), typed output, one POST per scenario.
  assert.equal(stub.entryKind, 'server-stub'); assert.match(stub.viewName, /^MainFlow\.(Home|Catalog)$/); assert.equal(stub.authenticated, true);
  assert.deepEqual(stub.results[0].outputs, { Url: 'https://example.invalid/back#Tool Ü' });
  assert.deepEqual(stub.results[0].requests, { submitted: 1, answered: 1 });
  assert.deepEqual(stub.results[1].exception, { type: 'ServerException', specificType: 'Users.SyntheticFailure', origin: 'server', message: 'synthetic server failure for [private]' });
  assert.equal(stub.results[1].uncertain, false);
  assert.deepEqual(stub.results[2].outputs, { Url: '#' }); // omitted inputs keep the type default
  assert.deepEqual(stub.submissions.map(s => s.seq), [1, 2, 3]);
  assert.equal(stub.receipt.memoryCleared, true); assert.equal(stub.receipt.requestUncertain, false);
  assert.equal(stub.receipt.nativeScreenPermissionsPassed, true);

  // Data action of a block, hosted by its screen's view name; outputs read from the original data record.
  // The original value is evaluated, but this explicitly private field must
  // remain hidden just as it does in interactive scope inspection.
  assert.deepEqual(data.results[0].outputs, { UserName: '[private]' });
  assert.equal(data.receipt.nativeScreenPermissionsPassed, true);
  // Module-level client action with client trace: node visits and variables from the original debugger hooks.
  assert.equal(slug.entryKind, 'client-action'); assert.deepEqual(slug.results[0].outputs, { Slug: 'Olá Mundo' });
  assert.equal(slug.results[0].visitCount, 4);
  assert.deepEqual(slug.results[0].visits.at(-1).values, { vars: { Text: 'Olá Mundo' }, makeSlugJSResult: { Slug: 'Olá Mundo' }, outVars: { Slug: 'Olá Mundo' } });
  assert.equal(slug.results[1].visits[0].values, undefined); // trace=nodes: visits only
  assert.deepEqual(slug.submissions, []);

  assert.equal(lifecycle.results[0].ok, true, JSON.stringify(lifecycle.results[0].exception));
  assert.deepEqual(lifecycle.results[0].lifecycle, { event: 'OnInitialize', handler: 'onInitializeEventHandler', invoked: true, mounted: false });
  assert.deepEqual(lifecycle.results[0].requests, { submitted: 1, answered: 1 });
  assert.ok(lifecycle.results[0].visits.some(v => v.functionKey === 'Ra0cqNIQbkCP0C9mKy4plg'));
  assert.ok(lifecycle.results[0].visits.some(v => v.functionKey === 'cWXs0rqc6UynDDBNghWU0A'));
  assert.equal(lifecycle.results[0].accessContext.clientIdentityMatchesBeforeAfter, true);
  assert.equal(lifecycle.results[0].accessContext.serverPropagationProved, false);
  assert.equal(lifecycle.receipt.memoryCleared, true);
  assert.ok(posts.every(p => !p.path.endsWith('/DataActionSSAM_DebugServiceContextFromServer')));

  // The login went through the app's own Login screen stub; every later POST carried the authenticated CSRF token.
  const logins = posts.filter(p => p.path.endsWith('/ActionDoLogin'));
  assert.equal(logins.length, 4); assert.ok(logins.every(p => p.viewName === 'Common.Login'));
  assert.ok(posts.filter(p => !p.path.endsWith('/ActionDoLogin')).every(p => p.csrf === 'SyntheticCsrf123='));
  assert.equal(out.some(o => o.leaks), false); // credentials never in receipts or results
});

// ----- typed inputs: the worker checks each canonical value against the ORIGINAL runtime class before conv.from -----
import vm from 'node:vm';
import { o11ClassWire } from '../debug-o11-native-entry-worker.mjs';
import { o11EntryInputValid } from '../debug-o11-native-entry.mjs';
import { parseO11Assets, amdClosure, o11InputClassFor } from '../debug-o11-native-abi.mjs';

const DT = Object.freeze({ Integer: 0, LongInteger: 1, Decimal: 2, Currency: 3, Text: 4, PhoneNumber: 5, Email: 6, Boolean: 7, Date: 8, DateTime: 9,
  Time: 10, Record: 11, RecordList: 12, BinaryData: 13, Object: 14 });
class TextList { static getItemType() { return DT.Text; } }
class LineRec { static getAttributes() { return [{ name: 'Sku', attrName: 'skuAttr', dataType: DT.Text }, { name: 'Qty', attrName: 'qtyAttr', dataType: DT.Integer },
  { name: 'Ref', attrName: 'refAttr', dataType: DT.LongInteger }, { name: 'Tags', attrName: 'tagsAttr', dataType: DT.RecordList, complexType: TextList },
  { name: 'Blob', attrName: 'blobAttr', dataType: DT.BinaryData }, { name: 'Payload', attrName: 'payloadAttr', dataType: DT.Object }]; } }
class LineList { static getItemType() { return LineRec; } }
class OrderRec { static getAttributes() { return [{ name: 'Main', attrName: 'mainAttr', dataType: DT.Record, complexType: LineRec },
  { name: 'Lines', attrName: 'linesAttr', dataType: DT.RecordList, complexType: LineList }, { name: 'Ok', attrName: 'okAttr', dataType: DT.Boolean }]; } }

test('worker cross-checks canonical values against Class.getAttributes()/getItemType() and only shapes nested lists for conv.from', () => {
  assert.deepEqual(o11ClassWire(DT, TextList, ['a', '']), { List: ['a', ''] });
  assert.deepEqual(o11ClassWire(DT, OrderRec, { Main: { Sku: 'A', Tags: ['x'] }, Lines: [{ Qty: 1, Ref: '9223372036854775807', Blob: 'AAEC' }], Ok: true }),
    { Main: { Sku: 'A', Tags: { List: ['x'] } }, Lines: { List: [{ Qty: 1, Ref: '9223372036854775807', Blob: 'AAEC' }] }, Ok: true });
  assert.deepEqual(o11ClassWire(DT, LineRec, { Sku: null }), { Sku: null });
  for (const [Class, value] of [[TextList, [1]], [TextList, [{}]], [TextList, [null]], [TextList, 'a'], [LineList, [1]], [LineList, { List: [] }],
    [LineRec, { Nope: 1 }], [LineRec, { Qty: '1' }], [LineRec, { Qty: 1.5 }], [LineRec, { Ref: 1 }], [LineRec, { Tags: [2] }], [LineRec, { Payload: {} }],
    [OrderRec, { Ok: 'true' }], [OrderRec, { Main: [] }], [class NoAttributes {}, {}], [LineRec, []]])
    assert.throws(() => o11ClassWire(DT, Class, value), /^Error: debug_o11_native_record_class_mismatch$/, Class.name + ' ' + JSON.stringify(value));
});

test('entry contract inputs admit a basic list only as the runtime list of that element', () => {
  const ok = extra => o11EntryInputValid({ name: 'Tags', param: 'tagsIn', dataType: 'RecordList', ...extra });
  assert.equal(ok({ runtimeList: 'TextList', element: 'Text' }), true);
  assert.equal(ok({ runtimeList: 'LongIntegerList', element: 'LongInteger' }), true);
  assert.equal(ok({ recordClass: 'ShopUI.model$LineList' }), true);
  for (const bad of [{ runtimeList: 'LongIntegerList', element: 'Integer' }, { runtimeList: 'ObjectList', element: 'Object' }, { runtimeList: 'TextList' },
    { recordClass: 'ShopUI.model$TextList', element: 'Text' }, { runtimeList: 'TextList', element: 'Record' },
    { recordClass: 'A.model$TextList', runtimeList: 'TextList', element: 'Text' }, { element: 'Text' }])
    assert.equal(ok(bad), false, JSON.stringify(bad));
  assert.equal(o11EntryInputValid({ name: 'Zip', param: 'zipIn', dataType: 'Text', element: 'Text' }), false);
  assert.equal(o11EntryInputValid({ name: 'Zip', param: 'zipIn', dataType: 'Text' }), true);
});

const plain = value => JSON.parse(JSON.stringify(value)); // values from the runtime's vm realm
// Golden: the ORIGINAL published runtime and Headless_UI model (read only) give the class; the asset parser and the runtime agree.
function loadO11Runtime(dir, files) {
  const sandbox = { console: { log() {}, warn() {}, error() {}, debug() {} }, URL, URLSearchParams, TextEncoder, TextDecoder, atob, Blob,
    location: new URL('https://runtime.invalid/Headless_UI/'), OutSystemsApp: { basePath: '/Headless_UI/' }, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0 } };
  sandbox.sessionStorage = sandbox.localStorage; sandbox.window = sandbox; sandbox.self = sandbox; sandbox.global = sandbox;
  const context = vm.createContext(sandbox);
  for (const name of files) vm.runInContext(fs.readFileSync(path.join(dir, name), 'utf8'), context, { filename: name, timeout: 10000 });
  return names => new Promise((resolve, reject) => sandbox.require(names, (...values) => resolve(values), reject));
}
test('golden published Text List and records: asset item type, runtime getItemType/getAttributes and the original converter agree', { skip: !evidence, timeout: 60000 }, async () => {
  const dir = path.join(evidence, 'proofs', 'o11-service-authenticated-chain', 'acquired', 'e662ebb3-16f8-43ca-b548-ee0fcba16a03');
  const names = fs.readdirSync(dir).filter(n => n.endsWith('.js'));
  const parsed = parseO11Assets(names.map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8') })), 'Headless_UI');
  // The module's published "Headless_UI.model$" TextList has a basic item type, so the input uses the runtime's basic list.
  assert.deepEqual(parsed.classes['Headless_UI.model$TextList'], { define: 'Headless_UI.model$', kind: 'list', itemType: { dataType: 'Text' } });
  const tags = o11InputClassFor(parsed, 'Headless_UI', { name: 'Tags', dataType: 'RecordList', modelType: 'ListType:Text List' });
  assert.deepEqual(tags, { runtimeList: 'TextList', element: 'Text' });
  // Every record class that needs only the runtime and its own model file is compared with the original runtime class.
  const runtimeFiles = ['Debugger.js', 'OutSystems.js', 'OutSystemsSettings.js'];
  const records = Object.entries(parsed.classes).filter(([, c]) => c.kind === 'record' &&
    amdClosure(parsed, [c.define]).assets.every(n => runtimeFiles.includes(n) || n === parsed.defines[c.define].asset));
  const files = [...new Set(records.map(([, c]) => parsed.defines[c.define].asset))].sort();
  assert.ok(files.includes('Headless_UI.model.js') && records.length >= 20, 'records: ' + records.length);
  const amd = loadO11Runtime(dir, ['OutSystems.js', 'OutSystemsSettings.js', 'Debugger.js', ...files]);
  const [os, , model] = await amd(['OutSystems/ClientRuntime/Main', 'Headless_UI.model$', 'Headless_UI.model']);
  const types = os.Internal.DataTypes.DataTypes, conv = os.Internal.DataConversion.ServerDataConverter, Class = os.Internal.DataTypes[tags.runtimeList];
  assert.equal(Class.getItemType(), types.Text);
  const list = conv.from(o11ClassWire(types, Class, ['a', 'Olá']), Class);
  assert.deepEqual([list.length, list.getItem(0), list.getItem(1)], [2, 'a', 'Olá']);
  assert.deepEqual(plain(conv.to(list)), { List: ['a', 'Olá'] });
  assert.throws(() => o11ClassWire(types, Class, [{ Value: 'a' }]), /record_class_mismatch/);
  // Evidence for that choice: the original converter cannot instantiate the module's GenericRecordList of a basic type.
  assert.equal(model.TextList.getItemType(), types.Text);
  assert.throws(() => conv.from({ List: ['a'] }, model.TextList), /is not a constructor/);
  for (const [name, wire] of [['IntegerList', [1]], ['LongIntegerList', ['9223372036854775807']], ['DateList', ['2024-02-29']], ['DecimalList', ['10.5']],
    ['BooleanList', [true]], ['BinaryDataList', ['AAEC']], ['DateTimeList', ['2026-10-04T15:30:00Z']], ['TimeList', ['23:59:59']]]) {
    const Runtime = os.Internal.DataTypes[name];
    assert.equal(Runtime.getItemType(), types[name.replace(/List$/, '')], name);
    assert.equal(conv.from(o11ClassWire(types, Runtime, wire), Runtime).length, 1, name);
  }
  // Parsed schema == runtime getAttributes() for each record the runtime initializes offline. Records whose attribute
  // defaults read the application's static entities need an app context this loader does not create; they are counted.
  let compared = 0, needsApp = 0;
  for (const [key, schema] of records) {
    const [base, name] = key.split('$');
    let Rec;
    try { Rec = (await amd([schema.define, base]))[1][name]; }
    catch (error) { assert.match(String(error?.message), /staticEntities/, key); needsApp++; continue; }
    assert.deepEqual(plain(Rec.getAttributes().map(a => [a.name, a.attrName, a.dataType])), schema.attributes.map(a => [a.name, a.attribute, types[a.dataType]]), key);
    assert.throws(() => o11ClassWire(types, Rec, { NotAnAttribute: 1 }), /record_class_mismatch/);
    compared++;
  }
  assert.ok(compared >= 20, 'compared ' + compared + ', needing an app context ' + needsApp);
});
