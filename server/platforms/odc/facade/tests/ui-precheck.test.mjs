import './fixtures/isolated-profile.mjs';
// CX16 W7: the UI precheck (ui-precheck.mjs) and its stop rule, through its three hooks: o11_deliver (o11-cycle.mjs, on a
// real McpServer with a fake bridge on an ephemeral port and a fake Anvil CLI), the headless job (job-runner.mjs, and
// ssam_code check through code-check.mjs) and the studio_deliver relay of the ssam server (ssam.mjs). The kernel's
// check-job with the static flags is the fake runner's: its answer has the shape of the CLI contract (W6). No Studio, no
// dotnet, no worker; every folder is temporary.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { registerO11Cycle, WORDS_MARKER } from '../o11-cycle.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { runJob } from '../job-runner.mjs';
import { codeCheck } from '../code-check.mjs';
import { createSsamServer } from '../ssam.mjs';
import { fitAnswer, ANSWER_BUDGETS } from '../answer-size.mjs';
import { withStudioWriteLock, phaseOfCall, phaseGuard } from '../studio-write-lock.mjs';
import { BUILD_VERBS } from '../o11-build-phase.mjs';
import { uiPrecheck, isUiJob, continuationOf, producerFresh, referencedLibraries, moduleOfCapture, joinPrecheck } from '../ui-precheck.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';
import { fakeO11Worker } from './fixtures/fake-o11-worker.mjs';
import { moduleIndex } from './fixtures/module-index.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with { type: 'json' };

const sha = text => createHash('sha256').update(text).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const WORDS = 'sim, pode entregar a tela Stations no Shop_UI';
// The relay of the ssam server reads the module index store of the process (module-map.mjs indexRoot).
const processStore = fs.mkdtempSync(path.join(isolatedProfile, 'precheck-store-'));
process.env.SSAM_MODULE_INDEX_ROOT = processStore;
// CX16 r4: every test of this file but the one of the default turns the UI precheck on explicitly.
process.env.SSAM_UI_PRECHECK = '1';

// ---- the job and the kernel's answer (CLI contract of check-job with the static flags)
const SCREEN = '<screen name="Stations" actions="Refresh">\n<div class="page">\n <Block name="StationCardd"/>\n'
  + ' <select options="LoadOptions.Stations" value="Station.Id" label="Station.Name"/>\n <div if="Rental.Id &gt; 0">{{ Rental.Code }}</div>\n</div>\n</screen>\n';
const BLOCK = '<block name="StationCard">\n<div class="card">{{ Title }}</div>\n</block>\n';
const uiJob = () => ({ ops: [
  { op: 'reference', producer: 'Shop_CS', elements: ['IServerEntity:Station'] },
  { op: 'reference', producer: 'Shop_IS', elements: ['IStructure:AddressInfo'] },
  { op: 'html', data: { html: SCREEN } },
  { op: 'html', data: { html: BLOCK } },
] });
const UNKNOWN_BLOCK = { phase: 'static', severity: 'error', op: 2, pointer: '/ops/2/data/html', code: 'HTML_NAME_UNKNOWN', basis: 'module-index',
  message: "<Block name=\"StationCardd\">: no block of the job, the module, a referenced producer or the UI catalog has this name", fix: "the block StationCard",
  edit: { element: 'Stations', find: '<Block name="StationCardd"/>', with: '<Block name="StationCard"/>' } };
const TYPE_AS_VALUE = { phase: 'static', severity: 'error', op: 2, pointer: '/ops/2/data/html', code: 'HTML_NAME_UNKNOWN', basis: 'reference',
  message: "value=\"Station.Id\": Station names an entity (a type), not a value", fix: 'the record of the options: LoadOptions.Stations.Current.Id',
  edit: { element: 'Stations', find: 'value="Station.Id" label="Station.Name"', with: 'value="LoadOptions.Stations.Current.Id" label="LoadOptions.Stations.Current.Name"' } };
const OUTSIDE_REFERENCE = { phase: 'static', severity: 'error', op: 2, pointer: '/ops/2/data/html', code: 'REFERENCE_MISSING', basis: 'producer-index',
  message: 'Rental is a public entity of Shop_CS that no reference op of the job imports', fix: 'add IServerEntity:Rental to the elements of the reference of Shop_CS',
  patch: [{ op: 'add', path: '/ops/0/elements/-', value: 'IServerEntity:Rental' }] };
const BLOCK_TEXT = { phase: 'static', severity: 'error', op: 3, pointer: '/ops/3/data/html', code: 'HTML_NAME_UNKNOWN', basis: 'module-index',
  message: '{{ Title }}: no input, variable or element of the block is named Title', fix: 'declare <input name="Title" type="Text"/> in the block',
  edit: { element: 'StationCard', find: '<block name="StationCard">', with: '<block name="StationCard">\n<input name="Title" type="Text"/>' } };
const argOf = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const allOf = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
// check-job as W6 answers it: today's data plus phases and static; ok = data.valid. complete (CX16 r2, M3): whether the apply
// path can add anything (true here unless a test says otherwise; the kernel says it from the job, CheckJobCommand.Rest).
function checkJob(problems, warnings = [], { complete = true } = {}) {
  return args => {
    const errors = problems.filter(p => p.severity !== 'warning');
    return { ok: errors.length === 0, command: 'check-job', elapsedMs: 31, data: {
      valid: errors.length === 0, errors: errors.map(p => `op #${p.op} (html) [${p.code}]: ${p.message}`), problems: errors, warnings,
      verifyRan: false, verifyReason: 'only the job was read', elapsedMs: 31, phases: ['preflight', 'static'],
      static: { basis: { module: argOf(args, '--module-index') ? { file: argOf(args, '--module-index'), lane: 'o11', adapter: 'kernel', fresh: argOf(args, '--basis-fresh') === 'true' } : null,
        producers: allOf(args, '--producer-index').map(p => ({ name: p.split('=')[0], file: p.split('=').slice(1).join('=') })),
        uiCatalog: allOf(args, '--ui-catalog').map(file => ({ file, library: path.basename(file).split('-')[0], version: '2.28.1', versionMatches: true })) },
      checked: argOf(args, '--module-index') ? ['block-names', 'block-contract', 'event-targets', 'screen-actions', 'expression-names', 'roles', 'collisions'] : ['block-contract'],
      skipped: [{ class: 'functions', reason: 'no Studio built-ins in this run' }, ...(argOf(args, '--module-index') ? [] : [{ class: 'expression-names', reason: 'no module index' }])],
      complete, rest: complete ? [] : [{ phase: 'base', reason: 'the checks that need the model' }, { phase: 'apply+verify', ops: [0], count: 1, reason: 'the apply runs these ops' }], elapsedMs: 18 } } };
  };
}

// ---- sandbox: the kernel root (UI catalogs), the O11 lane folder, the private index store, the captures
function sandbox(t) {
  const base = fs.mkdtempSync(path.join(isolatedProfile, 'precheck-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority'), store = path.join(base, 'index');
  for (const dir of [root, home, auth, store, path.join(root, 'catalog', 'ui')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'catalog', 'ui', 'OutSystemsUI-2.28.1.json'), '{"name":"OutSystemsUI"}');
  fs.writeFileSync(path.join(root, 'catalog', 'ui', 'OutSystemsCharts-3.10.0.json'), '{"name":"OutSystemsCharts"}');
  const env = { ...process.env, USERPROFILE: home, HOME: home, ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4', SSAM_MODULE_INDEX_ROOT: store };
  const local = path.join(root, '.local');
  let clock = Date.parse('2026-10-15T10:30:00.000Z');
  return { base, root, env, store, local, catalog: path.join(root, 'catalog', 'ui', 'OutSystemsUI-2.28.1.json'), now: () => new Date(clock += 1000) };
}
// The index of a capture in the store, with its digest (section "module": the references of the module).
function storeIndex(store, lane, text, { adapter = lane === 'odc' ? 'builder' : 'kernel', libraries = ['OutSystemsUI', 'Shop_CS'], digest = true, module = 'Shop_UI' } = {}) {
  const sourceSha256 = sha(text);
  const dir = path.join(store, 'v1', lane); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, sourceSha256 + '.' + adapter + '.json');
  fs.writeFileSync(file, JSON.stringify(moduleIndex({ lane, sourceSha256, overrides: { adapter } })));
  if (digest) fs.writeFileSync(path.join(dir, sourceSha256 + '.kernel.digest.json'), JSON.stringify({ schema: 'ssam-digest/1', extractor: 3, lane, adapter: 'kernel', sourceSha256,
    module: { name: module, key: 'Ua3', kind: 'CrossDevice' }, sections: [{ id: 'module', title: 'module and references', count: libraries.length + 1,
      blocks: [{ key: 'Ua3', kind: 'ESpace', name: module, text: 'ssam-digest/1 module=' + module }, ...libraries.map(name => ({ key: 'R' + name, kind: 'Reference', name,
        text: 'reference ' + name + ' @R' + name + ' (ReactiveLibrary)\n  Block: Card' }))] }] }));
  return file;
}
function capture(local, name, text, at) {
  const file = path.join(local, 'snapshots', name);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  if (at) fs.utimesSync(file, new Date(at), new Date(at));
  return file;
}
// The producers: Shop_CS delivered by the lane at 09:00-09:05 and captured after (fresh), Shop_IS captured, never delivered.
function producers(box) {
  const cs = capture(box.local, 'Shop_CS-20261015100000-aaaaaaa1.oml', 'OML Shop_CS after its delivery', '2026-10-15T10:00:00Z');
  const is = capture(box.local, 'Shop_IS-20261015100000-bbbbbbb2.oml', 'OML Shop_IS read once', '2026-10-15T10:00:00Z');
  fs.mkdirSync(path.join(box.local, 'journal'), { recursive: true });
  fs.writeFileSync(path.join(box.local, 'journal', 'o11_deliver.jsonl'), [
    { at: '2026-10-15T09:00:00.000Z', tool: 'o11_deliver', event: 'start', task: 't-cs', module: 'Shop_CS' },
    { at: '2026-10-15T09:05:00.000Z', tool: 'o11_deliver', event: 'end', task: 't-cs', outcome: 'delivered' }].map(l => JSON.stringify(l)).join('\n') + '\n');
  return { cs, is, csIndex: storeIndex(box.store, 'o11', 'OML Shop_CS after its delivery', { digest: false }), isIndex: storeIndex(box.store, 'o11', 'OML Shop_IS read once', { digest: false }) };
}

// o11_deliver on a real McpServer: the fake bridge lists the open tabs (tabs) and writes each snapshot_module.
const CAPTURE_TEXT = 'OML Shop_UI as it is in the Studio';
async function o11Harness(t, { tabs = [{ name: 'Shop_UI', key: 'K-UI', hasESpace: true }], handlers, deps = {} } = {}) {
  const box = sandbox(t);
  const bridge = await fakeBridge(request => {
    if (request.method === 'list_open_modules') return { success: true, data: { count: tabs.length, modules: tabs } };
    if (request.method === 'snapshot_module' && request.params?.module_key) {
      fs.mkdirSync(path.dirname(request.params.path), { recursive: true }); fs.writeFileSync(request.params.path, CAPTURE_TEXT);
      return { success: true, data: { path: request.params.path, key: request.params.module_key } };
    }
    return { success: false, error: 'not in this test: ' + request.method };
  });
  t.after(() => bridge.close());
  const runAnvil = fakeAnvil(handlers);
  const server = new McpServer({ name: 'ui-precheck-test', version: '1.0.0' });
  registerO11Cycle(server, { root: box.root, env: box.env, lane: 'ss4', now: box.now, runAnvil, assertSelected: async () => {}, lastPublication: async () => null,
    bridge: o11Bridge({ port: bridge.port, authorization: 'TESTKEY' }), registerTask: false, ...deps });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ui-precheck-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const deliver = async args => { const begin = performance.now(); const result = await client.callTool({ name: 'o11_deliver', arguments: args }); return { result, ms: performance.now() - begin }; };
  return { ...box, bridge, runAnvil, deliver };
}
const STATIC_FIELDS = ['basis', 'checked', 'skipped', 'complete', 'elapsedMs', 'indexMs', 'checkMs'];
const REFUSAL_FIELDS = ['ok', 'code', 'outcome', 'writeState', 'stage', 'phases', 'verifyRan', 'verifyReason', 'stoppedBefore', 'problems', 'static', 'nextBasedOn', 'continuation'];
function assertRefusal(v, { stoppedBefore, count }) {
  for (const k of REFUSAL_FIELDS) assert.ok(Object.hasOwn(v, k), 'missing ' + k + ': ' + JSON.stringify(v).slice(0, 400));
  assert.equal(v.ok, false); assert.equal(v.code, 'PREFLIGHT_REFUSED'); assert.equal(v.outcome, 'refused'); assert.equal(v.writeState, 'not-sent');
  assert.equal(v.stage, 'static'); assert.deepEqual(v.phases, ['preflight', 'static']); assert.equal(v.verifyRan, false); assert.equal(v.stoppedBefore, stoppedBefore);
  assert.equal(v.verifyReason, 'stopped before the Studio and the apply: the job and the module index already decide ' + count + ' problem(s); the apply and the Verify run once they are fixed');
  assert.equal(v.problems.length, count);
  assert.deepEqual(Object.keys(v.static), STATIC_FIELDS);
  assert.deepEqual(Object.keys(v.static.basis), ['module', 'producers', 'uiCatalog']);
  assert.deepEqual(Object.keys(v.static.basis.module), ['capture', 'sha256', 'fresh', 'source']);
  assert.deepEqual(Object.keys(v.nextBasedOn), ['job', 'sha256']);
  assert.equal(sha(fs.readFileSync(v.nextBasedOn.job)), v.nextBasedOn.sha256, 'nextBasedOn names the bytes of the job judged');
}

test('o11_deliver: an unknown block, an entity used as a value and an entity outside the reference refuse before the Studio, with bridge reads only', async t => {
  const box = await o11Harness(t, { handlers: { 'check-job': checkJob([UNKNOWN_BLOCK, TYPE_AS_VALUE, OUTSIDE_REFERENCE]), deliver: () => envelopes.delivered } });
  const index = storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const p = producers(box);
  const { result, ms } = await box.deliver({ module: 'Shop_UI', job: uiJob(), authorize: WORDS });
  const v = result.structuredContent;
  assert.equal(result.isError, true);
  assertRefusal(v, { stoppedBefore: 'studio', count: 3 });
  assert.deepEqual(v.problems.map(x => x.code), ['HTML_NAME_UNKNOWN', 'HTML_NAME_UNKNOWN', 'REFERENCE_MISSING']);
  assert.deepEqual(v.problems[0].edit, UNKNOWN_BLOCK.edit); assert.deepEqual(v.problems[2].patch, OUTSIDE_REFERENCE.patch);
  // Nothing of the Studio but the reads of the capture by key; no deliver, no apply: the only CLI run is check-job.
  // servidor/fase4-26: the third read is the server line's open-producer lookup (prazos B, o11-open-producer.mjs): a read too.
  assert.deepEqual(box.bridge.seen.map(r => r.method), ['list_open_modules', 'snapshot_module', 'list_open_modules']);
  assert.equal(box.bridge.seen[1].params.module_key, 'K-UI');
  assert.deepEqual(box.runAnvil.calls.map(c => c.args[0]), ['check-job']);
  const args = box.runAnvil.calls[0].args;
  assert.deepEqual(args, ['check-job', '--job', v.nextBasedOn.job, '--module-index', index, '--producer-index', 'Shop_CS=' + p.csIndex, '--producer-index', 'Shop_IS=' + p.isIndex, '--ui-catalog', box.catalog, '--basis-fresh', 'true']);
  // The base: the capture by key (fresh); the producers: Shop_CS fresh (captured after the lane delivered it), Shop_IS not.
  const basis = v.static.basis;
  assert.equal(basis.module.fresh, true); assert.equal(basis.module.source, 'capture-by-key'); assert.equal(basis.module.sha256, sha(CAPTURE_TEXT));
  assert.match(path.basename(basis.module.capture), /^build-Shop_UI-\d{14}-[a-f0-9]{8}\.oml$/);
  assert.deepEqual(basis.producers, [{ name: 'Shop_CS', capture: p.cs, sha256: sha('OML Shop_CS after its delivery'), fresh: true },
    { name: 'Shop_IS', capture: p.is, sha256: sha('OML Shop_IS read once'), fresh: false }]);
  assert.deepEqual(basis.uiCatalog, [{ file: box.catalog, library: 'OutSystemsUI', version: '2.28.1', versionMatches: true }]);
  assert.ok(v.static.checked.length >= 5);
  assert.ok(v.static.skipped.some(s => s.class === 'functions'), 'the kernel skips stay');
  // A producer index that is not fresh is passed too: the kernel reads it only for what it has.
  assert.ok(!v.static.skipped.some(s => s.class === 'producer-index'), JSON.stringify(v.static.skipped));
  // One problem has no certain edit (the reference patch): the continuation reads the first screen.
  assert.deepEqual(v.continuation.tool, 'ssam_map');
  assert.deepEqual(v.continuation.arguments, { lane: 'o11', target: 'Shop_UI', view: 'html', screen: 'Stations' });
  // The answer names the job it judged (withJob of the cycle): the next call corrects it by basedOn.
  assert.equal(v.job, v.nextBasedOn.job); assert.equal(v.jobSha256, v.nextBasedOn.sha256);
  // CX16 r3 (M3): check-job runs inside the delivery's task, alongside the build; the task records the stop before the
  // Studio (its start and end lines), and the precheck's own journal line says it carried a complete verdict.
  const deliveries = fs.readFileSync(path.join(box.local, 'journal', 'o11_deliver.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(deliveries.length, 4);
  assert.equal(deliveries.at(-1).event, 'end'); assert.equal(deliveries.at(-1).outcome, 'refused'); assert.equal(deliveries.at(-1).code, 'PREFLIGHT_REFUSED'); assert.equal(deliveries.at(-1).stage, 'static');
  const line = JSON.parse(fs.readFileSync(path.join(box.local, 'journal', 'ui-precheck.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(line.outcome, 'carried'); assert.equal(line.complete, true); assert.equal(line.parallel, true); assert.equal(line.problems, 3); assert.equal(line.basis.index, index);
  // Time of the facade with a fake runner, and the answer as the MCP client measures it.
  assert.ok(ms <= 2000, 'o11_deliver answered in ' + Math.round(ms) + ' ms'); assert.ok(v.static.elapsedMs <= 2000);
  assert.ok(bytes(v) <= ANSWER_BUDGETS.refusal, bytes(v) + ' bytes');
  const fitted = fitAnswer('o11_deliver', { module: 'Shop_UI' }, JSON.parse(result.content[0].text), { root: box.base });
  assert.ok(bytes(fitted) <= 8192, bytes(fitted) + ' bytes');
});

test('o11_deliver: every problem with a certain edit -> ONE ssam_code write over basedOn, the edits grouped by element, the options kept', async t => {
  const twice = { ...TYPE_AS_VALUE, code: 'EXPR_UNKNOWN_IDENTIFIER', message: 'label="Station.Name": the same text' };
  const box = await o11Harness(t, { handlers: { 'check-job': checkJob([UNKNOWN_BLOCK, TYPE_AS_VALUE, twice, BLOCK_TEXT]) } });
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const { result } = await box.deliver({ module: 'Shop_UI', job: uiJob(), checks: ['Stations'], publish: true, authorize: WORDS });
  const v = result.structuredContent;
  assertRefusal(v, { stoppedBefore: 'studio', count: 4 });
  assert.deepEqual(v.continuation, { tool: 'ssam_code', arguments: { lane: 'o11', action: 'write', module: 'Shop_UI', basedOn: v.nextBasedOn,
    element: 'Stations', edits: [{ find: UNKNOWN_BLOCK.edit.find, with: UNKNOWN_BLOCK.edit.with }, { find: TYPE_AS_VALUE.edit.find, with: TYPE_AS_VALUE.edit.with }],
    also: [{ element: 'StationCard', edits: [{ find: BLOCK_TEXT.edit.find, with: BLOCK_TEXT.edit.with }] }], publish: true, checks: ['Stations'], authorize: WORDS_MARKER },
    why: v.continuation.why });
  assert.ok(!JSON.stringify(v).includes(WORDS), 'the user\'s words never travel in an answer');
  assert.ok(!JSON.stringify(v.continuation).includes('<screen'), 'no document travels again');
  // The producers have no capture here: no --producer-index, both listed as skipped.
  assert.deepEqual(allOf(box.runAnvil.calls[0].args, '--producer-index'), []);
  assert.deepEqual(v.static.basis.producers.map(p => [p.name, p.fresh]), [['Shop_CS', false], ['Shop_IS', false]]);
});

test('a job without html or screen ops pays nothing: no bridge call, no CLI run, no file', async t => {
  const box = sandbox(t);
  const refuse = () => { throw new Error('the precheck reached the Studio or the CLI'); };
  const logic = { ops: [{ op: 'logic', data: { flow: 'server action A\n  end\n' } }, { op: 'reference', producer: 'Shop_CS', elements: ['IServerAction:Get'] }] };
  for (const mode of ['deliver', 'check', 'job']) {
    assert.equal(await uiPrecheck({ lane: 'o11', module: 'Shop_UI', job: logic, mode }, { bridge: refuse, runAnvil: refuse, indexRunner: refuse, root: box.root, local: box.local, env: box.env }), null);
    assert.equal(await uiPrecheck({ lane: 'odc', module: 'Shop_UI', job: logic, mode }, { runAnvil: refuse, root: box.root, odcRoot: path.join(box.base, 'odc'), env: box.env }), null);
  }
  assert.equal(isUiJob(logic), false); assert.equal(isUiJob(uiJob()), true); assert.equal(isUiJob({ jobs: ['a.json'] }), false);
  assert.ok(!fs.existsSync(box.local), 'nothing was written');
  // Through o11_deliver: the delivery runs as before, its CLI and bridge calls unchanged.
  const live = await o11Harness(t, { handlers: { deliver: () => envelopes.delivered } });
  const { result } = await live.deliver({ module: 'Shop_UI', job: { ops: [{ op: 'set', target: 'ServerAction:SaveOrder', prop: 'Description', value: 'Saves' }] }, authorize: WORDS });
  assert.equal(result.structuredContent.result, 'delivered', JSON.stringify(result.structuredContent).slice(0, 400));
  assert.deepEqual(live.runAnvil.calls.map(c => c.args[0]), ['deliver']);
  assert.deepEqual(live.bridge.seen, []);
  assert.ok(!fs.existsSync(path.join(live.local, 'journal', 'ui-precheck.jsonl')));
  assert.ok(!fs.existsSync(path.join(live.local, 'jobs', 'precheck')));
});

test('a base that is not fresh only warns: the delivery goes on, its answer unchanged, the warnings in the lane journal', async t => {
  const warning = { ...UNKNOWN_BLOCK, severity: 'warning', message: 'StationCardd is not in the index of a capture that is not provably the live module' };
  const box = await o11Harness(t, { tabs: [], handlers: { 'check-job': checkJob([], [warning]), deliver: () => envelopes.delivered } });
  const newest = capture(box.local, 'Shop_UI-20261015090000-cccccccc.oml', 'OML Shop_UI of an earlier read', '2026-10-15T09:00:00Z');
  storeIndex(box.store, 'o11', 'OML Shop_UI of an earlier read');
  const { result } = await box.deliver({ module: 'Shop_UI', job: { ops: [{ op: 'html', data: { html: SCREEN } }] }, authorize: WORDS });
  const v = result.structuredContent;
  assert.equal(v.result, 'delivered', JSON.stringify(v).slice(0, 400));
  for (const k of ['stage', 'static', 'stoppedBefore', 'warnings']) assert.equal(Object.hasOwn(v, k), false, k + ' is not in a delivery that went on');
  assert.deepEqual(box.runAnvil.calls.map(c => c.args[0]), ['check-job', 'deliver']);
  assert.equal(argOf(box.runAnvil.calls[0].args, '--basis-fresh'), 'false');
  assert.deepEqual(box.bridge.seen.map(r => r.method), ['list_open_modules'], 'no tab: nothing captured');
  const line = JSON.parse(fs.readFileSync(path.join(box.local, 'journal', 'ui-precheck.jsonl'), 'utf8').trim());
  assert.equal(line.outcome, 'passed'); assert.equal(line.warnings, 1); assert.deepEqual(line.warningCodes, ['HTML_NAME_UNKNOWN 1']);
  assert.equal(line.basis.capture, newest); assert.equal(line.basis.fresh, false); assert.equal(line.basis.source, 'newest-capture');
});

test('whatever the precheck cannot decide lets the delivery go on as before (a CLI without check-job, no capture at all)', async t => {
  const box = await o11Harness(t, { handlers: { deliver: () => envelopes.delivered } });
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const { result } = await box.deliver({ module: 'Shop_UI', job: { ops: [{ op: 'html', data: { html: SCREEN } }] }, authorize: WORDS });
  assert.equal(result.structuredContent.result, 'delivered', JSON.stringify(result.structuredContent).slice(0, 400));
  assert.deepEqual(box.runAnvil.calls.map(c => c.args[0]), ['check-job', 'deliver']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(box.local, 'journal', 'ui-precheck.jsonl'), 'utf8').trim()).outcome, 'undecided');
  // No tab and no capture of the module: nothing to judge against, no CLI run.
  const none = await o11Harness(t, { tabs: [], handlers: { deliver: () => envelopes.delivered } });
  const second = await none.deliver({ module: 'Shop_UI', job: { ops: [{ op: 'html', data: { html: SCREEN } }] }, authorize: WORDS });
  assert.equal(second.result.structuredContent.result, 'delivered');
  assert.deepEqual(none.runAnvil.calls.map(c => c.args[0]), ['deliver']);
  // Never on resume, a prototype op or a composite job.
  const refuse = () => { throw new Error('ran'); };
  assert.equal(await uiPrecheck({ lane: 'o11', module: 'M', job: uiJob(), mode: 'deliver', input: { resume: '0'.repeat(32) } }, { runAnvil: refuse, bridge: refuse }), null);
  assert.equal(await uiPrecheck({ lane: 'o11', module: 'M', job: { ops: [...uiJob().ops, { op: 'prototype', data: {} }] }, mode: 'deliver' }, { runAnvil: refuse, bridge: refuse }), null);
  assert.equal(await uiPrecheck({ lane: 'o11', module: 'M', job: { jobs: ['a.json'] }, mode: 'deliver' }, { runAnvil: refuse, bridge: refuse }), null);
  // SSAM_UI_PRECHECK=0: no precheck at all.
  assert.equal(await uiPrecheck({ lane: 'o11', module: 'M', job: uiJob(), mode: 'deliver' }, { runAnvil: refuse, bridge: refuse, env: { SSAM_UI_PRECHECK: '0' } }), null);
});

test('without a stored index its classes are skipped and the stop rests on the pure ones; a stored index is passed', async t => {
  const box = sandbox(t);
  const base = capture(box.local, 'Shop_UI-20261015090000-dddddddd.oml', 'OML Shop_UI without an index');
  const job = path.join(box.base, 'job.json'); fs.writeFileSync(job, JSON.stringify(uiJob()));
  const pure = { phase: 'preflight', severity: 'error', op: 2, pointer: '/ops/2/data/html', code: 'HTML_TAG_NOT_ALLOWED', message: '<marquee> is not an element of ssam-html/1', fix: 'a <div>' };
  const runAnvil = fakeAnvil({ 'check-job': checkJob([pure]) });
  const v = await uiPrecheck({ lane: 'o11', job, mode: 'job', base }, { runAnvil, root: box.root, local: box.local, env: box.env });
  assertRefusal(v, { stoppedBefore: 'apply', count: 1 });
  assert.deepEqual(runAnvil.calls.map(c => c.args[0]), ['check-job'], 'no index is built (CX16 r3)');
  const args = runAnvil.calls.at(-1).args;
  assert.equal(argOf(args, '--module-index'), undefined, 'no index: the flag is not passed');
  assert.deepEqual(allOf(args, '--ui-catalog'), [], 'no digest: no catalog');
  assert.equal(argOf(args, '--basis-fresh'), 'true', 'a base given is fresh');
  assert.ok(v.static.skipped.some(s => s.class === 'module-index' && /never builds/.test(s.reason)), JSON.stringify(v.static.skipped));
  assert.equal(v.static.basis.module.source, 'base');
  assert.deepEqual(v.continuation.arguments, { lane: 'o11', target: 'Shop_UI', view: 'html', screen: 'Stations' });
  // The index the store keeps for the capture is passed.
  const stored = storeIndex(box.store, 'o11', 'OML Shop_UI without an index', { digest: false });
  const again = fakeAnvil({ 'check-job': checkJob([pure]) });
  const w = await uiPrecheck({ lane: 'o11', job, mode: 'job', base }, { runAnvil: again, root: box.root, local: box.local, env: box.env });
  assert.equal(argOf(again.calls.at(-1).args, '--module-index'), stored, JSON.stringify(w.static.skipped));
  assert.ok(!w.static.skipped.some(s => s.class === 'module-index'));
  // The whole precheck has SSAM_UI_PRECHECK_MS: check-job keeps its minimum.
  const late = fakeAnvil({ 'check-job': checkJob([pure]) });
  await uiPrecheck({ lane: 'o11', job, mode: 'job', base }, { runAnvil: late, root: box.root, local: box.local, env: { ...box.env, SSAM_UI_PRECHECK_MS: '1' } });
  assert.deepEqual(late.calls.map(c => [c.args[0], c.options.timeoutMs]), [['check-job', 3000]]);
});

test('ssam_job/o11_job (runJob with base): a static problem joins the refusal of the apply that ran alongside; without a base nothing runs', async t => {
  const box = sandbox(t);
  const base = capture(box.local, 'Shop_UI-20261015090000-eeeeeeee.oml', CAPTURE_TEXT);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const job = path.join(box.base, 'job.json'); fs.writeFileSync(job, JSON.stringify(uiJob()));
  // CX16 r3 (M3): even a complete verdict (the apply path adds nothing) joins: a headless job has no step to spare.
  const runAnvil = fakeAnvil({ 'check-job': checkJob([UNKNOWN_BLOCK, BLOCK_TEXT]), apply: refusedApply([APPLY_SAME]) });
  const v = await runJob({ lane: 'o11', job, base }, { root: box.root, env: box.env, runAnvil, worker: null });
  assert.equal(v.ok, false); assert.equal(v.lane, 'o11');
  assert.deepEqual(runAnvil.calls.map(c => c.args[0]).sort(), ['apply', 'check-job']);
  assert.equal(v.problems.filter(p => /StationCardd/.test(p.message)).length, 1, 'the same problem once');
  assert.ok(v.problems.some(p => p.phase === 'static' && /Title/.test(p.message)), JSON.stringify(v.problems).slice(0, 600));
  assert.equal(v.static.complete, true); assert.equal(v.static.carried, 2); assert.equal(v.static.joined, 1);
  // Without a base (the kernel's own fixture), no capture is judged: the apply runs as before.
  const plain = fakeAnvil({ apply: () => ({ ok: true, command: 'apply', data: { accepted: true, isValid: true } }) });
  const ran = await runJob({ lane: 'o11', job }, { root: box.root, env: box.env, runAnvil: plain, worker: null });
  assert.equal(ran.ok, true, JSON.stringify(ran).slice(0, 400)); assert.deepEqual(plain.calls.map(c => c.args[0]), ['apply']);
});

// Depends on the pass-through of code-check.mjs (W4, 7.5 b): a refusal of stage "static" keeps stage, stoppedBefore,
// static and its continuation, and names job, jobSha256 and nextBasedOn.
test('ssam_code check with a static problem: the apply runs alongside and the check answers both in one refusal; with SSAM_UI_PRECHECK_STOP=error it answers without the apply, with nextBasedOn and the continuation of the precheck', async t => {
  const box = sandbox(t);
  capture(box.local, 'Shop_UI-20261015090000-ffffffff.oml', CAPTURE_TEXT);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const both = fakeAnvil({ 'check-job': checkJob([UNKNOWN_BLOCK, TYPE_AS_VALUE]), apply: refusedApply([APPLY_SAME]) });
  const joined = await codeCheck({ lane: 'o11', module: 'Shop_UI', part: 'html', text: SCREEN },
    { root: box.root, local: box.local, odcRoot: path.join(box.base, 'odc'), env: box.env, runAnvil: both, guidance: async (_lane, _job, result) => result });
  assert.equal(joined.ok, false); assert.equal(joined.code, 'CHECK_REFUSED');
  assert.deepEqual(both.calls.map(c => c.args[0]).sort(), ['apply', 'check-job']);
  assert.ok(JSON.stringify(joined).includes('LoadOptions.Stations.Current.Id'), 'the static problem the apply did not say is in the answer: ' + JSON.stringify(joined).slice(0, 600));
  // The r1 stop (opt-in): before the apply, as the precheck answers it.
  const runAnvil = fakeAnvil({ 'check-job': checkJob([UNKNOWN_BLOCK, TYPE_AS_VALUE]), apply: () => { throw new Error('the apply ran'); } });
  const v = await codeCheck({ lane: 'o11', module: 'Shop_UI', part: 'html', text: SCREEN },
    { root: box.root, local: box.local, odcRoot: path.join(box.base, 'odc'), env: { ...box.env, SSAM_UI_PRECHECK_STOP: 'error' }, runAnvil, guidance: async (_lane, _job, result) => result });
  assert.equal(v.ok, false); assert.equal(v.code, 'CHECK_REFUSED'); assert.equal(v.refusalCode, 'PREFLIGHT_REFUSED');
  assert.deepEqual(runAnvil.calls.map(c => c.args[0]), ['check-job'], 'no apply');
  assert.equal(v.stage, 'static'); assert.equal(v.stoppedBefore, 'apply'); assert.deepEqual(Object.keys(v.static), STATIC_FIELDS);
  assert.equal(v.static.basis.module.fresh, true, 'the check judges the capture it names');
  assert.match(v.nextBasedOn.job, /[\\/]jobs[\\/]check[\\/]/); assert.equal(v.nextBasedOn.sha256, sha(fs.readFileSync(v.nextBasedOn.job)));
  assert.deepEqual(v.continuation, { tool: 'ssam_code', arguments: { lane: 'o11', action: 'check', module: 'Shop_UI', basedOn: v.nextBasedOn, element: 'Stations',
    edits: [UNKNOWN_BLOCK.edit, TYPE_AS_VALUE.edit].map(e => ({ find: e.find, with: e.with })) }, why: v.continuation.why });
  assert.ok(!JSON.stringify(v.continuation).includes('<screen'), 'the continuation never sends the input again');
  assert.ok(bytes(v) <= ANSWER_BUDGETS.refusal, bytes(v) + ' bytes');
});

// The studio_deliver relay of the ssam server (ODC lane) over a fake ODC facade; the newest snapshot of Shop_UI and its index
// as the ODC kernel CLI writes it (<sha>.kernel.json) in the store of this process.
const ODC_TEXT = 'ODC snapshot of Shop_UI';
const CENTER = { phase: 'preflight', severity: 'error', op: 0, pointer: '/ops/0/data/html', code: 'HTML_TAG_NOT_ALLOWED', message: '<center> is not an element of ssam-html/1', fix: 'a <div>',
  edit: { element: 'Stations', find: '<center>', with: '<div>' } };
const relayJob = () => ({ ops: [{ op: 'html', data: { html: SCREEN.replace('<div class="page">', '<center>') } }] });
const RELAY_ARGS = { feature: 'Stations', module: 'Shop_UI', owners: ['Stations'], changes: ['screen Stations'] };
async function relayHarness(t, { runAnvil: runner = null, reply = null } = {}) {
  const box = sandbox(t);
  const odcRoot = path.join(box.base, 'odc');
  const snapshot = path.join(odcRoot, 'snapshots', 'Shop_UI-' + sha(ODC_TEXT) + '.oml');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true }); fs.writeFileSync(snapshot, ODC_TEXT);
  fs.writeFileSync(snapshot + '.json', JSON.stringify({ module: 'Shop_UI', moduleKey: 'k', sha256: sha(ODC_TEXT), capturedAt: '2026-10-15T10:00:00Z' }));
  const index = storeIndex(processStore, 'odc', ODC_TEXT, { adapter: 'kernel' });
  // The ODC lane CLI must be built for the precheck to run it; the runner is injected.
  fs.mkdirSync(path.join(box.root, '.local', 'lane-odc', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(box.root, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'), 'runner is injected');
  const runAnvil = runner ?? fakeAnvil({ 'check-job': checkJob([CENTER, { ...UNKNOWN_BLOCK, op: 0, pointer: '/ops/0/data/html' }]) });
  const seen = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_deliver', { description: 'Deliver.', inputSchema: z.object({ feature: z.string().min(1), module: z.string().optional(), job: z.string().optional(),
      owners: z.array(z.string()).optional(), changes: z.array(z.string()).optional(), until: z.string().optional(), publish: z.boolean().optional(), authorize: z.string().optional() }).strict() },
    async args => {
      seen.push(args);
      const value = reply ? await reply(args) : { ok: true, result: 'delivered' };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) };
    });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot, answersRoot: box.base, runAnvil, precheck: { root: box.root },
    lock: { o11Root: box.base, odcRoot: box.base, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ui-precheck-relay', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const deliver = async args => { const begin = performance.now(); const result = await client.callTool({ name: 'studio_deliver', arguments: args });
    return { result, value: result.structuredContent ?? JSON.parse(result.content[0].text), ms: performance.now() - begin }; };
  return { ...box, odcRoot, snapshot, index, runAnvil, seen, deliver };
}

test('studio_deliver relay (ODC): a job given as an object is judged on the newest snapshot alongside the relay; the precheck\'s copy is its next base', async t => {
  const relayed = { ok: false, code: 'PREFLIGHT_REFUSED', problems: [{ phase: 'preflight', severity: 'error', op: 0, pointer: '/ops/0/data/html', code: 'HTML_TAG_NOT_ALLOWED', message: '<center> is not an element of ssam-html/1', fix: 'a <div>' }] };
  const box = await relayHarness(t, { reply: () => relayed });
  const job = relayJob();
  // The precheck itself, in series: every field of 7.7, its copy of the job as the next base.
  const direct = await uiPrecheck({ lane: 'odc', module: 'Shop_UI', job, document: job, mode: 'deliver', input: { ...RELAY_ARGS, job } },
    { runAnvil: box.runAnvil, odcRoot: box.odcRoot, root: box.root });
  assertRefusal(direct, { stoppedBefore: 'studio', count: 2 });
  assert.deepEqual(direct.static.basis.module, { capture: box.snapshot, sha256: sha(ODC_TEXT), fresh: false, source: 'newest-snapshot' });
  assert.equal(path.dirname(direct.nextBasedOn.job), path.join(box.odcRoot, '.local', 'jobs', 'precheck'));
  assert.deepEqual(JSON.parse(fs.readFileSync(direct.nextBasedOn.job, 'utf8')), job);
  assert.deepEqual(direct.continuation.arguments, { lane: 'odc', action: 'write', module: 'Shop_UI', basedOn: direct.nextBasedOn, element: 'Stations',
    edits: [{ find: '<center>', with: '<div>' }, { find: UNKNOWN_BLOCK.edit.find, with: UNKNOWN_BLOCK.edit.with }], feature: 'Stations', owners: ['Stations'], changes: ['screen Stations'] });
  // An ODC lane CLI that is not built decides nothing: no run, the relay goes on.
  const unbuilt = fakeAnvil({ 'check-job': () => { throw new Error('ran'); } });
  assert.equal(await uiPrecheck({ lane: 'odc', module: 'Shop_UI', job, document: job, mode: 'deliver' }, { runAnvil: unbuilt, odcRoot: box.odcRoot, root: path.join(box.base, 'no-cli') }), null);
  assert.equal(unbuilt.calls.length, 0);
  // Through the server, as the MCP client sees it (CX16 r3): the relay is the apply path and runs alongside check-job; its
  // refusal carries the static problem it did not say, once.
  const { result, value: v, ms } = await box.deliver({ ...RELAY_ARGS, job });
  assert.equal(result.isError, true);
  assert.equal(box.seen.length, 1, 'the ODC lane got the job');
  assert.deepEqual(v.problems.map(p => p.code), ['HTML_TAG_NOT_ALLOWED', 'HTML_NAME_UNKNOWN'], JSON.stringify(v).slice(0, 600));
  const call = box.runAnvil.calls.filter(c => c.args[0] === 'check-job').at(-1);
  assert.deepEqual(box.runAnvil.calls.map(c => c.args[0]), ['check-job', 'check-job'], 'only check-job here; the apply is the relay\'s');
  assert.equal(call.options.cli, path.join(box.root, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'));
  assert.equal(argOf(call.args, '--module-index'), box.index, 'the ODC index written by the kernel CLI (<sha>.kernel.json) is taken');
  assert.deepEqual(allOf(call.args, '--ui-catalog'), [box.catalog]);
  assert.equal(argOf(call.args, '--basis-fresh'), 'false');
  assert.ok(ms <= 2000, Math.round(ms) + ' ms');
  assert.ok(Buffer.byteLength(result.content[0].text, 'utf8') <= ANSWER_BUDGETS.refusal && bytes(v) <= 8192, bytes(v) + ' bytes');
});

// responses.mjs compactDelivery (out of the scope of CX16) keeps a fixed list of fields on a studio_deliver refusal: it drops
// writeState, stoppedBefore and static, which the precheck returns (the test above checks them on the precheck itself). This
// passes once that list keeps them.
test('studio_deliver relay (ODC): the client sees every field of 7.7', { todo: 'responses.mjs compactDelivery drops writeState, stoppedBefore and static of a studio_deliver refusal' }, async t => {
  // The precheck refuses alone at the relay only with the r1 stop (opt-in, CX16 r3).
  const before = process.env.SSAM_UI_PRECHECK_STOP; process.env.SSAM_UI_PRECHECK_STOP = 'error';
  t.after(() => { if (before === undefined) delete process.env.SSAM_UI_PRECHECK_STOP; else process.env.SSAM_UI_PRECHECK_STOP = before; });
  const box = await relayHarness(t);
  const { value } = await box.deliver({ ...RELAY_ARGS, job: relayJob() });
  assertRefusal(value, { stoppedBefore: 'studio', count: 2 });
});

// CX14: the precheck is pure, without the Studio lock, before the queue. Another write holds the Studio for its whole call;
// a phased o11_deliver (through the ssam server) answers the static refusal meanwhile, never waiting for its turn.
test('a phased o11_deliver answers the static refusal while another write holds the Studio (no lock, no queue)', async t => {
  const box = sandbox(t);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const seen = [];
  const bridge = { ok: async (method, params = {}) => {
    seen.push(method);
    if (method === 'list_open_modules') return { modules: [{ name: 'Shop_UI', key: 'K-UI', hasESpace: true }] };
    if (method === 'snapshot_module' && params.module_key) { fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, CAPTURE_TEXT); return { key: params.module_key, path: params.path }; }
    throw Object.assign(new Error('not in this test: ' + method), { code: 'BRIDGE_NOT_LISTENING' });
  } };
  // CX16 r3 (M3): check-job runs alongside the build phase (its apply in the build pool, never the Studio); the Studio step
  // waits for the verdict, and static.complete stops it there.
  // CX16 r4 (M3): the Studio step waits for the verdict only without an accepted candidate of the build: a complete verdict
  // means the kernel refuses every op whole by its shape, which an accepted candidate disproves. Here the build gives none
  // (the delivery would build inside the Studio, as before), so the complete verdict stops it before the Studio.
  const runAnvil = fakeAnvil({ 'check-job': checkJob([UNKNOWN_BLOCK, TYPE_AS_VALUE]), deliver: () => envelopes.delivered,
    apply: () => ({ ok: false, command: 'apply', error: 'no candidate (synthetic): the delivery builds inside the Studio' }) });
  const lockDeps = { o11Root: box.root, odcRoot: box.root, o11Lane: 'ss4', connection: () => null };
  const { createBuildPool } = await import('../build-pool.mjs');
  const server = await createSsamServer({ odc: false, deps: { cycle: { root: box.root, env: box.env, runAnvil, assertSelected: async () => {}, tasksDir: path.join(box.base, 'tasks'),
    bridge, lastPublication: async () => null, lock: { connection: () => null }, buildPool: createBuildPool({ dir: path.join(box.base, 'pool'), size: 2, queueMs: 10000 }),
    buildRunner: () => runAnvil }, lock: lockDeps } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ui-precheck-phased', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  let release; const held = new Promise(resolve => { release = resolve; });
  let holding; const holds = new Promise(resolve => { holding = resolve; });
  const other = withStudioWriteLock({ tool: 'o11_publish', args: { module: 'Other' }, lane: 'o11', deps: lockDeps }, async () => { holding(); await held; return { ok: true }; });
  await holds;
  let timer;
  try {
    const begin = performance.now();
    const answer = await Promise.race([client.callTool({ name: 'o11_deliver', arguments: { module: 'Shop_UI', job: { ops: [{ op: 'html', data: { html: SCREEN } }] }, authorize: WORDS } }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 5000); })]);
    assert.ok(answer, 'the precheck waited for the Studio');
    const v = answer.structuredContent ?? JSON.parse(answer.content[0].text);
    assert.equal(v.code, 'PREFLIGHT_REFUSED', JSON.stringify(v).slice(0, 500)); assert.equal(v.stoppedBefore, 'studio'); assert.equal(v.static.basis.module.fresh, true);
    assert.deepEqual(runAnvil.calls.map(c => c.args[0]).sort(), ['apply', 'check-job'], 'the build apply and check-job; never deliver');
    // The capture by key of the precheck, then the build's (this fake bridge has no model fingerprint; one that has it lets
    // the build reuse the precheck's capture).
    assert.deepEqual(seen, ['list_open_modules', 'snapshot_module', 'list_open_modules', 'snapshot_module']);
    assert.ok(performance.now() - begin < 2000);
  } finally { clearTimeout(timer); release(); await other; }
});

test('in a phased call the precheck never takes the Studio: no index is built, the guarded runner runs only check-job', async t => {
  const box = sandbox(t);
  const base = capture(box.local, 'Shop_UI-20261015090000-abababab.oml', 'OML Shop_UI phased');
  const guardedCalls = [];
  const guarded = phaseGuard(fakeAnvil({ 'check-job': args => { guardedCalls.push(args[0]); return checkJob([UNKNOWN_BLOCK])(args); },
    inspect: args => { guardedCalls.push(args[0]); return { ok: true, command: 'inspect', data: {} }; } }), args => BUILD_VERBS.has(String(args?.[0] ?? '')));
  const lockDeps = { o11Root: box.root, odcRoot: box.root, o11Lane: 'ss4', connection: () => null };
  const v = await withStudioWriteLock({ tool: 'o11_deliver', args: { module: 'Shop_UI', job: [] }, lane: 'o11', deps: lockDeps, phased: true }, async () => {
    const value = await uiPrecheck({ lane: 'o11', job: uiJob(), mode: 'job', base }, { runAnvil: guarded, root: box.root, local: box.local, env: box.env });
    assert.deepEqual(phaseOfCall(), { promoted: false, tool: 'o11_deliver' }, 'the call never took the Studio');
    return value;
  });
  assert.equal(v.code, 'PREFLIGHT_REFUSED');
  assert.deepEqual(guardedCalls, ['check-job']);
  assert.ok(v.static.skipped.some(s => s.class === 'module-index' && /never builds/.test(s.reason)));
});

test('a refusal with many problems stays within 8192 bytes as the MCP client measures it', async t => {
  const box = await o11Harness(t, { handlers: { 'check-job': checkJob(Array.from({ length: 48 }, (_, i) => ({ ...TYPE_AS_VALUE,
    message: TYPE_AS_VALUE.message + ' #' + i, edit: { element: i % 2 ? 'Stations' : 'StationCard', find: 'value="Entity' + i + '.Id"', with: 'value="LoadOptions.Entity' + i + 's.Current.Id"' } }))) } });
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const { result } = await box.deliver({ module: 'Shop_UI', job: uiJob(), authorize: WORDS });
  const v = JSON.parse(result.content[0].text);
  assert.equal(v.code, 'PREFLIGHT_REFUSED'); assert.equal(v.problems.length, 48);
  const fitted = fitAnswer('o11_deliver', { module: 'Shop_UI', authorize: WORDS }, v, { root: box.base });
  t.diagnostic('raw ' + bytes(v) + ' B -> fitted ' + bytes(fitted) + ' B');
  assert.ok(bytes(fitted) <= ANSWER_BUDGETS.refusal, bytes(fitted) + ' bytes');
  assert.equal(fitted.code, 'PREFLIGHT_REFUSED');
});

// ---- CX16 r2 M3 (provisional): one refusal with everything. The precheck stops only when check-job says the apply path can
// add nothing (static.complete); otherwise its problems are carried and join the refusal of the apply path, the same problem
// once; an accepted apply drops them (the journal keeps them). SSAM_UI_PRECHECK_STOP=error restores the stop of round 1.
const APPLY_SAME = { phase: 'apply', severity: 'error', op: 2, pointer: '/ops/2/data/html', code: 'HTML_NAME_UNKNOWN', message: "block 'StationCardd' does not exist in the module", fix: 'StationCard' };
const APPLY_OTHER = { phase: 'base', severity: 'error', op: 2, pointer: '/ops/2/data/html', code: 'FUNCTION_UNKNOWN', message: "'Lowr(' is not a built-in function of this Studio (o11)", fix: 'use one of: Lower' };
const refusedApply = problems => () => ({ ok: true, command: 'apply', data: { accepted: false, isValid: false, problems, verifyRan: true, phases: ['preflight', 'base', 'apply', 'verify'] } });

test('M3: ssam_job/o11_job with base: a static problem the apply path may add to is carried into ONE refusal with the apply problems', async t => {
  const box = sandbox(t);
  const base = capture(box.local, 'Shop_UI-20261015090000-eeeeeeee.oml', CAPTURE_TEXT);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const job = path.join(box.base, 'job.json'); fs.writeFileSync(job, JSON.stringify(uiJob()));
  const runAnvil = fakeAnvil({ 'check-job': checkJob([UNKNOWN_BLOCK, BLOCK_TEXT], [], { complete: false }), apply: refusedApply([APPLY_SAME, APPLY_OTHER]) });
  const v = await runJob({ lane: 'o11', job, base }, { root: box.root, env: box.env, runAnvil, worker: null });
  assert.deepEqual(runAnvil.calls.map(c => c.args[0]).sort(), ['apply', 'check-job'], 'the apply ran (alongside check-job, CX16 r3)');
  assert.equal(v.ok, false); assert.notEqual(v.stage, 'static'); assert.equal(Object.hasOwn(v, 'stoppedBefore'), false);
  // The apply's own two (its wording) and the static one it did not say (the block text); the unknown block once.
  assert.deepEqual(v.problems.map(p => p.code).sort(), ['FUNCTION_UNKNOWN', 'HTML_NAME_UNKNOWN', 'HTML_NAME_UNKNOWN']);
  assert.equal(v.problems.filter(p => /StationCardd/.test(p.message)).length, 1, 'the same problem once');
  assert.ok(v.problems.some(p => p.phase === 'static' && /Title/.test(p.message)), JSON.stringify(v.problems).slice(0, 600));
  assert.ok(v.phases.includes('static'));
  assert.equal(v.static.complete, false); assert.equal(v.static.carried, 2); assert.equal(v.static.joined, 1);
  assert.deepEqual(v.static.rest.map(r => r.phase), ['base', 'apply+verify']);
  const line = JSON.parse(fs.readFileSync(path.join(box.root, '.local', 'journal', 'ui-precheck.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(line.outcome, 'carried-joined'); assert.equal(line.joined, 1);
});

test('M3: a carried static problem the apply accepts is no proof: the answer is the apply\'s, the journal keeps it', async t => {
  const box = sandbox(t);
  const base = capture(box.local, 'Shop_UI-20261015090000-eeeeeeee.oml', CAPTURE_TEXT);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const job = path.join(box.base, 'job.json'); fs.writeFileSync(job, JSON.stringify(uiJob()));
  const runAnvil = fakeAnvil({ 'check-job': checkJob([UNKNOWN_BLOCK], [], { complete: false }), apply: () => ({ ok: true, command: 'apply', data: { accepted: true, isValid: true } }) });
  const v = await runJob({ lane: 'o11', job, base }, { root: box.root, env: box.env, runAnvil, worker: null });
  assert.equal(v.ok, true, JSON.stringify(v).slice(0, 400));
  for (const k of ['static', 'stage', 'stoppedBefore']) assert.equal(Object.hasOwn(v, k), false, k);
  // CX16 r4: an accepted answer never waits for check-job; its journal line comes when check-job ends.
  const lines = await journalOf(box.local, l => l.some(x => x.outcome === 'carried-accepted'));
  assert.deepEqual(lines.map(l => l.outcome), ['carried', 'carried-accepted']);
  assert.deepEqual(lines[1].codes, ['HTML_NAME_UNKNOWN 1']);
});

test('M3: SSAM_UI_PRECHECK_STOP=error restores the stop of round 1 (any error refuses before the apply); SSAM_UI_PRECHECK=0 still turns it off', async t => {
  const box = sandbox(t);
  const base = capture(box.local, 'Shop_UI-20261015090000-eeeeeeee.oml', CAPTURE_TEXT);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const job = path.join(box.base, 'job.json'); fs.writeFileSync(job, JSON.stringify(uiJob()));
  const runAnvil = fakeAnvil({ 'check-job': checkJob([UNKNOWN_BLOCK], [], { complete: false }), apply: () => { throw new Error('the apply ran'); } });
  const v = await runJob({ lane: 'o11', job, base }, { root: box.root, env: { ...box.env, SSAM_UI_PRECHECK_STOP: 'error' }, runAnvil, worker: null });
  assert.equal(v.code, 'PREFLIGHT_REFUSED'); assert.equal(v.stage, 'static'); assert.equal(v.stoppedBefore, 'apply');
  assert.equal(v.static.complete, false); assert.equal(v.static.stopRule, 'SSAM_UI_PRECHECK_STOP=error'); assert.deepEqual(v.static.rest.map(r => r.phase), ['base', 'apply+verify']);
  assert.deepEqual(runAnvil.calls.map(c => c.args[0]), ['check-job']);
  const off = fakeAnvil({ apply: () => ({ ok: true, command: 'apply', data: { accepted: true, isValid: true } }) });
  const ran = await runJob({ lane: 'o11', job, base }, { root: box.root, env: { ...box.env, SSAM_UI_PRECHECK: '0' }, runAnvil: off, worker: null });
  assert.equal(ran.ok, true); assert.deepEqual(off.calls.map(c => c.args[0]), ['apply'], 'off: no check-job at all');
});

test('M3: o11_deliver with a carried precheck delivers, and a refused delivery answers the static problems with its own', async t => {
  const refused = JSON.parse(JSON.stringify(envelopes.refusedBeforeMerge));
  const box = await o11Harness(t, { handlers: { 'check-job': checkJob([UNKNOWN_BLOCK], [], { complete: false }), deliver: () => refused } });
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  producers(box);
  const { result } = await box.deliver({ module: 'Shop_UI', job: uiJob(), authorize: WORDS });
  const v = result.structuredContent;
  assert.deepEqual(box.runAnvil.calls.map(c => c.args[0]), ['check-job', 'deliver'], 'the delivery ran');
  assert.equal(v.ok, false); assert.notEqual(v.code, 'PREFLIGHT_REFUSED');
  assert.ok(v.problems.some(p => p.phase === 'static' && /StationCardd/.test(p.message)), JSON.stringify(v).slice(0, 600));
  assert.equal(v.static.complete, false); assert.equal(v.static.carried, 1);
  assert.ok(v.phases.includes('static'));
});

test('M3: joinPrecheck keeps the apply\'s wording of a problem it also says, adds the rest once, and never touches an uncertain or accepted answer', () => {
  const local = fs.mkdtempSync(path.join(isolatedProfile, 'join-'));
  const carried = { carry: true, problems: [UNKNOWN_BLOCK, BLOCK_TEXT], local, lane: 'o11', mode: 'job', jobSha256: 'x', static: { complete: false, rest: [] } };
  const joined = joinPrecheck({ ok: false, code: 'JOB_INVALID', problems: [APPLY_SAME], phases: ['apply'] }, carried);
  assert.deepEqual(joined.problems, [APPLY_SAME, BLOCK_TEXT]);
  assert.deepEqual(joined.phases, ['apply', 'static']);
  const bare = joinPrecheck({ ok: false, code: 'X', error: 'no list' }, carried);
  assert.deepEqual(bare.static.problems, [UNKNOWN_BLOCK, BLOCK_TEXT]);
  const uncertain = { ok: false, outcome: 'uncertain', problems: [] };
  assert.equal(joinPrecheck(uncertain, carried), uncertain);
  const accepted = { ok: true, result: 'delivered' };
  assert.equal(joinPrecheck(accepted, carried), accepted);
  assert.equal(joinPrecheck(accepted, null), accepted);
  fs.rmSync(local, { recursive: true, force: true });
});

// ---- CX16 r3 M3: check-job runs ALONGSIDE the apply path (never before it), the precheck never builds an index, and it
// stops early only with static.complete (o11_deliver: before the Studio, after the build that ran alongside it).
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const slowCheck = (at, problems, options, ms = 400) => async args => {
  at.checkStart = performance.now(); await sleep(ms); at.checkEnd = performance.now();
  return checkJob(problems, [], options)(args);
};

test('M3 r3: runJob starts the apply before a slow check-job ends, and its refusal joins the static problems (one refusal)', async t => {
  const box = sandbox(t);
  const base = capture(box.local, 'Shop_UI-20261015090000-eeeeeeee.oml', CAPTURE_TEXT);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const job = path.join(box.base, 'job.json'); fs.writeFileSync(job, JSON.stringify(uiJob()));
  const at = {};
  const runAnvil = fakeAnvil({ 'check-job': slowCheck(at, [UNKNOWN_BLOCK, BLOCK_TEXT], { complete: false }),
    apply: args => { at.applyStart = performance.now(); return refusedApply([APPLY_SAME, APPLY_OTHER])(args); } });
  const begin = performance.now();
  const v = await runJob({ lane: 'o11', job, base }, { root: box.root, env: box.env, runAnvil, worker: null });
  const ms = performance.now() - begin;
  assert.ok(at.applyStart < at.checkEnd, 'the apply started ' + Math.round(at.applyStart - begin) + ' ms in, check-job ended at ' + Math.round(at.checkEnd - begin) + ' ms');
  assert.ok(ms < 400 + 1500, Math.round(ms) + ' ms: the two ran at once');
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems.map(p => p.code).sort(), ['FUNCTION_UNKNOWN', 'HTML_NAME_UNKNOWN', 'HTML_NAME_UNKNOWN']);
  assert.equal(v.static.carried, 2); assert.equal(v.static.joined, 1); assert.equal(v.static.complete, false);
  // With static.complete the headless job has no Studio step to spare: the apply ran alongside, the refusal is still one.
  const at2 = {};
  const complete = fakeAnvil({ 'check-job': slowCheck(at2, [UNKNOWN_BLOCK], { complete: true }),
    apply: args => { at2.applyStart = performance.now(); return refusedApply([APPLY_SAME])(args); } });
  const w = await runJob({ lane: 'o11', job, base }, { root: box.root, env: box.env, runAnvil: complete, worker: null });
  assert.ok(at2.applyStart < at2.checkEnd);
  assert.equal(w.ok, false); assert.equal(w.problems.filter(p => /StationCardd/.test(p.message)).length, 1, 'the same problem once');
  assert.equal(w.static.complete, true);
});

test('M3 r3: without a stored index the precheck builds none: no inspect runs and it never waits for an index budget', async t => {
  const box = sandbox(t);
  const base = capture(box.local, 'Shop_UI-20261015090000-dddddddd.oml', 'OML Shop_UI without an index');
  const job = path.join(box.base, 'job.json'); fs.writeFileSync(job, JSON.stringify(uiJob()));
  const pure = { phase: 'preflight', severity: 'error', op: 2, pointer: '/ops/2/data/html', code: 'HTML_TAG_NOT_ALLOWED', message: '<marquee> is not an element of ssam-html/1', fix: 'a <div>' };
  const inspected = [];
  const runAnvil = fakeAnvil({ inspect: args => { inspected.push(args); return new Promise(() => {}); }, 'check-job': checkJob([pure]) });
  const begin = performance.now();
  const v = await uiPrecheck({ lane: 'o11', job, mode: 'job', base }, { runAnvil, root: box.root, local: box.local, env: box.env });
  const ms = performance.now() - begin;
  assert.deepEqual(inspected, [], 'no inspect: the precheck never builds an index');
  assert.ok(ms < 1500, Math.round(ms) + ' ms (the index budget was 4000 ms)');
  assertRefusal(v, { stoppedBefore: 'apply', count: 1 });
  assert.equal(argOf(runAnvil.calls.at(-1).args, '--module-index'), undefined, 'no index: the flag is not passed');
  assert.ok(v.static.skipped.some(s => s.class === 'module-index' && /never builds/.test(s.reason)), JSON.stringify(v.static.skipped));
  // SSAM_UI_PRECHECK_INDEX_MS no longer builds either.
  const asked = fakeAnvil({ inspect: args => { inspected.push(args); return { ok: true, command: 'inspect', data: {} }; }, 'check-job': checkJob([pure]) });
  await uiPrecheck({ lane: 'o11', job, mode: 'job', base }, { runAnvil: asked, root: box.root, local: box.local, env: { ...box.env, SSAM_UI_PRECHECK_INDEX_MS: '9000' } });
  assert.deepEqual(asked.calls.map(c => c.args[0]), ['check-job']);
});

test('M3 r3: a phased o11_deliver runs check-job alongside the build apply; static.complete stops it before the Studio, a carried precheck joins the delivery', async t => {
  const box = sandbox(t);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const seen = [];
  const bridge = { ok: async (method, params = {}) => {
    seen.push(method);
    if (method === 'list_open_modules') return { modules: [{ name: 'Shop_UI', key: 'K-UI', hasESpace: true }] };
    if (method === 'snapshot_module' && params.module_key) { fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, CAPTURE_TEXT); return { key: params.module_key, path: params.path }; }
    throw Object.assign(new Error('not in this test: ' + method), { code: 'BRIDGE_NOT_LISTENING' });
  } };
  const { createBuildPool } = await import('../build-pool.mjs');
  const serve = async runAnvil => {
    const lockDeps = { o11Root: box.root, odcRoot: box.root, o11Lane: 'ss4', connection: () => null };
    const server = await createSsamServer({ odc: false, deps: { cycle: { root: box.root, env: box.env, runAnvil, assertSelected: async () => {}, tasksDir: path.join(box.base, 'tasks'),
      bridge, lastPublication: async () => null, lock: { connection: () => null }, buildPool: createBuildPool({ dir: path.join(box.base, 'pool-' + Math.random().toString(16).slice(2)), size: 2, queueMs: 10000 }),
      buildRunner: () => runAnvil }, lock: lockDeps } });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ui-precheck-r3', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    t.after(async () => { await client.close(); await server.close(); });
    const answer = await client.callTool({ name: 'o11_deliver', arguments: { module: 'Shop_UI', job: { ops: [{ op: 'html', data: { html: SCREEN } }] }, authorize: WORDS } });
    return answer.structuredContent ?? JSON.parse(answer.content[0].text);
  };
  const build = at => args => {
    at.buildStart = performance.now();
    const out = argOf(args, '--out'); fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'candidate'); fs.writeFileSync(out.replace(/\.oml$/, '.result.json'), JSON.stringify({ isValid: true, accepted: true }));
    return { ok: true, command: 'apply', data: { isValid: true, accepted: true } };
  };
  const at = {};
  // CX16 r4 (M3): the Studio step waits for the verdict only without an accepted candidate of the build: a complete verdict
  // means the kernel refuses every op whole by its shape, which an accepted candidate disproves. Here the build gives none
  // (the delivery would build inside the Studio, as before), so the complete verdict stops it before the Studio.
  const stops = fakeAnvil({ 'check-job': slowCheck(at, [UNKNOWN_BLOCK], { complete: true }),
    apply: () => { at.buildStart = performance.now(); return { ok: false, command: 'apply', error: 'no candidate (synthetic): the delivery builds inside the Studio' }; },
    deliver: () => { throw new Error('the Studio step ran'); } });
  const v = await serve(stops);
  assert.ok(at.buildStart < at.checkEnd, 'the build apply started before check-job ended');
  assert.equal(v.code, 'PREFLIGHT_REFUSED', JSON.stringify(v).slice(0, 500)); assert.equal(v.stoppedBefore, 'studio');
  assert.ok(!stops.calls.some(c => c.args[0] === 'deliver'), 'nothing reached the Studio');
  const at2 = {};
  const refused = JSON.parse(JSON.stringify(envelopes.refusedBeforeMerge));
  const carries = fakeAnvil({ 'check-job': slowCheck(at2, [UNKNOWN_BLOCK], { complete: false }), apply: build(at2), deliver: () => refused });
  const w = await serve(carries);
  assert.ok(at2.buildStart < at2.checkEnd, 'the build apply started before check-job ended');
  assert.ok(carries.calls.some(c => c.args[0] === 'deliver'), 'the delivery ran');
  assert.equal(w.ok, false); assert.equal(w.static.carried, 1);
  assert.ok(w.problems.some(p => p.phase === 'static' && /StationCardd/.test(p.message)), JSON.stringify(w).slice(0, 600));
});

test('M3 r3: the studio_deliver relay starts before a slow check-job ends, and a refused relay answer joins the static problems', async t => {
  const at = {};
  const refusal = { ok: false, code: 'PREFLIGHT_REFUSED', problems: [{ phase: 'preflight', severity: 'error', op: 0, pointer: '/ops/0/data/html', code: 'HTML_TAG_NOT_ALLOWED', message: '<center> is not an element of ssam-html/1', fix: 'a <div>' }] };
  const box = await relayHarness(t, { runAnvil: fakeAnvil({ 'check-job': slowCheck(at, [CENTER, { ...UNKNOWN_BLOCK, op: 0, pointer: '/ops/0/data/html' }], { complete: false }) }),
    reply: () => { at.relayStart = performance.now(); return refusal; } });
  const { value: v } = await box.deliver({ ...RELAY_ARGS, job: relayJob() });
  assert.ok(at.relayStart < at.checkEnd, 'the relay started before check-job ended');
  assert.equal(box.seen.length, 1, 'the ODC lane got the job');
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems.map(p => p.code), ['HTML_TAG_NOT_ALLOWED', 'HTML_NAME_UNKNOWN'], JSON.stringify(v).slice(0, 600));
});

// ---- CX16 r4 M3 (review cx16-3): with the resident worker on (the default; .mcp.json sets no ANVIL_WORKER=0) the lane
// worker runs one request at a time. Alongside the apply path check-job never enters its queue (a process of its own;
// ctx/deps.checkRunner stands for that process here), an accepted or uncertain answer never waits for check-job, and a
// timeout says so. The production wiring: runJob without deps.runAnvil nor deps.worker (the apply goes to the worker on
// ANVIL_WORKER_PORT); o11_deliver with the cycle's worker-first runner and the build on slot 0 (the same worker).
const workerEnv = (box, port) => {
  const studio = path.join(box.base, 'fake-studio'); fs.mkdirSync(studio, { recursive: true });
  const env = { ...box.env, ANVIL_WORKER_PORT: String(port), ANVIL_STUDIO_DIR: studio };
  delete env.ANVIL_WORKER;
  return { env, studio };
};
async function journalOf(local, done, ms = 5000) {
  const file = path.join(local, 'journal', 'ui-precheck.jsonl');
  for (const end = Date.now() + ms; ;) {
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { /* not yet */ }
    if (done(lines) || Date.now() > end) return lines;
    await sleep(25);
  }
}
const spanOf = (events, verb) => events.find(e => e.verb === verb);
async function uiWorkerCase(t, { applyMs, checkMs, apply = refusedApply([APPLY_SAME]) }) {
  const box = sandbox(t);
  const base = capture(box.local, 'Shop_UI-20261015090000-c4c4c4c4.oml', CAPTURE_TEXT);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const job = path.join(box.base, 'job.json'); fs.writeFileSync(job, JSON.stringify(uiJob()));
  const statics = [UNKNOWN_BLOCK, BLOCK_TEXT];
  const studio = path.join(box.base, 'fake-studio'); fs.mkdirSync(studio, { recursive: true });
  // The worker serves check-job too: the facade of 45c920de sends it there (the red); the fix never does.
  const worker = await fakeO11Worker({ studio, handlers: { apply: async args => { await sleep(applyMs); return apply(args); },
    'check-job': async args => { await sleep(checkMs); return checkJob(statics, [], { complete: false })(args); } } });
  t.after(() => worker.close());
  const { env } = workerEnv(box, worker.port);
  const at = {};
  const checkRunner = fakeAnvil({ 'check-job': slowCheck(at, statics, { complete: false }, checkMs) });
  return { box, base, job, worker, env, at, checkRunner };
}

test('M3 r4 (a): with the resident worker, runJob runs check-job outside the worker queue, overlapping the apply', async t => {
  const c = await uiWorkerCase(t, { applyMs: 1500, checkMs: 300 });
  const v = await runJob({ lane: 'o11', job: c.job, base: c.base }, { root: c.box.root, env: c.env, checkRunner: c.checkRunner });
  const apply = spanOf(c.worker.events, 'apply');
  assert.ok(apply, 'the apply ran on the worker: ' + JSON.stringify(c.worker.events.map(e => e.verb)));
  const queued = spanOf(c.worker.events, 'check-job');
  const check = queued ?? { start: c.at.checkStart, end: c.at.checkEnd };
  assert.ok(check.start < apply.end && apply.start < check.end, 'apply ' + Math.round(apply.start) + '-' + Math.round(apply.end) + ', check-job ' + Math.round(check.start) + '-' + Math.round(check.end) + ': they overlap');
  assert.equal(queued, undefined, 'check-job never entered the worker queue');
  assert.equal(v.ok, false);
  assert.ok(v.problems.some(p => p.phase === 'static' && /Title/.test(p.message)), JSON.stringify(v.problems).slice(0, 500));
  assert.equal(v.static.carried, 2); assert.equal(v.static.joined, 1);
});

test('M3 r4 (b): with the resident worker, an apply of 14 s and a check-job of 0.3 s: the refusal brings the static problem', async t => {
  const c = await uiWorkerCase(t, { applyMs: 14000, checkMs: 300 });
  const v = await runJob({ lane: 'o11', job: c.job, base: c.base }, { root: c.box.root, env: c.env, checkRunner: c.checkRunner });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some(p => p.phase === 'static' && /Title/.test(p.message)), 'the static problem is in the refusal: ' + JSON.stringify(v.problems.map(p => p.code)));
  assert.equal(v.static?.carried, 2);
  assert.equal(spanOf(c.worker.events, 'check-job'), undefined, 'check-job never entered the worker queue');
});

test('M3 r4 (c): with the resident worker, an accepted apply answers without waiting for check-job; the journal is written when it ends', async t => {
  const c = await uiWorkerCase(t, { applyMs: 200, checkMs: 2000, apply: () => ({ ok: true, command: 'apply', data: { accepted: true, isValid: true } }) });
  const begin = performance.now();
  const v = await runJob({ lane: 'o11', job: c.job, base: c.base }, { root: c.box.root, env: c.env, checkRunner: c.checkRunner });
  const ms = performance.now() - begin;
  assert.equal(v.ok, true, JSON.stringify(v).slice(0, 400));
  assert.ok(ms < 1500, 'answered in ' + Math.round(ms) + ' ms, check-job takes 2000 ms');
  for (const k of ['static', 'stage', 'stoppedBefore']) assert.equal(Object.hasOwn(v, k), false, k);
  const lines = await journalOf(c.box.local, l => l.some(x => x.outcome === 'carried-accepted'));
  assert.deepEqual(lines.map(l => l.outcome), ['carried', 'carried-accepted']);
  assert.equal(lines[0].timings.checkVia, 'injected');
});

test('M3 r4 (d): o11_deliver with the build on slot 0 of the resident worker: check-job outside its queue; a refusal joins, an accepted delivery never waits', async t => {
  const box = sandbox(t);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const bridge = { ok: async (method, params = {}) => {
    if (method === 'list_open_modules') return { modules: [{ name: 'Shop_UI', key: 'K-UI', hasESpace: true }] };
    if (method === 'snapshot_module' && params.module_key) { fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, CAPTURE_TEXT); return { key: params.module_key, path: params.path }; }
    throw Object.assign(new Error('not in this test: ' + method), { code: 'BRIDGE_NOT_LISTENING' });
  } };
  const { createBuildPool } = await import('../build-pool.mjs');
  const { createWorkerFirstRunner } = await import('../anvil-worker.mjs');
  const deliverOn = async ({ buildMs, checkMs, delivery }) => {
    const studio = path.join(box.base, 'fake-studio'); fs.mkdirSync(studio, { recursive: true });
    const worker = await fakeO11Worker({ studio, handlers: {
      apply: async args => { await sleep(buildMs); const out = argOf(args, '--out'); fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, 'candidate'); fs.writeFileSync(out.replace(/\.oml$/, '.result.json'), JSON.stringify({ isValid: true, accepted: true }));
        return { ok: true, command: 'apply', data: { isValid: true, accepted: true } }; },
      'check-job': async args => { await sleep(checkMs); return checkJob([UNKNOWN_BLOCK], [], { complete: false })(args); },
      deliver: async () => JSON.parse(JSON.stringify(delivery)) } });
    t.after(() => worker.close());
    const { env } = workerEnv(box, worker.port);
    const at = {};
    const checkRunner = fakeAnvil({ 'check-job': slowCheck(at, [UNKNOWN_BLOCK], { complete: false }, checkMs) });
    const runAnvil = createWorkerFirstRunner({ root: box.root, env });
    const lockDeps = { o11Root: box.root, odcRoot: box.root, o11Lane: 'ss4', connection: () => null };
    const server = await createSsamServer({ odc: false, deps: { cycle: { root: box.root, env, runAnvil, checkRunner, assertSelected: async () => {}, tasksDir: path.join(box.base, 'tasks-' + worker.port),
      bridge, lastPublication: async () => null, lock: { connection: () => null }, buildPool: createBuildPool({ dir: path.join(box.base, 'pool-' + worker.port), size: 2, queueMs: 10000 }),
      // slot 0 is the lane's own worker (build-pool.mjs slotWorkerPort): the same worker as the cycle's runner
      buildRunner: slot => createWorkerFirstRunner({ root: box.root, env: { ...env, ANVIL_WORKER_PORT: String(slot.index ? worker.port + 1000 : worker.port) } }) }, lock: lockDeps } });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ui-precheck-r4', version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    t.after(async () => { await client.close(); await server.close(); });
    const begin = performance.now();
    const answer = await client.callTool({ name: 'o11_deliver', arguments: { module: 'Shop_UI', job: { ops: [{ op: 'html', data: { html: SCREEN } }] }, authorize: WORDS } });
    return { v: answer.structuredContent ?? JSON.parse(answer.content[0].text), ms: performance.now() - begin, worker, at };
  };
  // A refused delivery: the build apply (slot 0) and check-job overlap, check-job never queues on the worker, the static problem joins.
  const refused = await deliverOn({ buildMs: 1500, checkMs: 300, delivery: envelopes.refusedBeforeMerge });
  const build = spanOf(refused.worker.events, 'apply');
  assert.ok(build, 'the build ran on slot 0 (the worker): ' + JSON.stringify(refused.worker.events.map(e => e.verb)));
  const queued = spanOf(refused.worker.events, 'check-job');
  const check = queued ?? { start: refused.at.checkStart, end: refused.at.checkEnd };
  assert.ok(check.start < build.end && build.start < check.end, 'the build apply and check-job overlap');
  assert.equal(queued, undefined, 'check-job never entered the worker queue');
  assert.equal(refused.v.ok, false, JSON.stringify(refused.v).slice(0, 400));
  assert.ok(refused.v.problems.some(p => p.phase === 'static' && /StationCardd/.test(p.message)), JSON.stringify(refused.v).slice(0, 600));
  // An accepted build and delivery: neither the Studio step nor the answer waits for a check-job of 2 s.
  const delivered = await deliverOn({ buildMs: 200, checkMs: 2000, delivery: envelopes.delivered });
  assert.equal(delivered.v.ok, true, JSON.stringify(delivered.v).slice(0, 400));
  assert.equal(spanOf(delivered.worker.events, 'check-job'), undefined, 'check-job never entered the worker queue');
  assert.ok(delivered.ms < 1800, 'delivered in ' + Math.round(delivered.ms) + ' ms, check-job takes 2000 ms');
});

test('M3 r4: without an injected runner, with the worker on, the parallel check-job runs in a process of its own (never the worker)', async t => {
  const c = await uiWorkerCase(t, { applyMs: 300, checkMs: 300 });
  const v = await runJob({ lane: 'o11', job: c.job, base: c.base }, { root: c.box.root, env: c.env });
  assert.equal(v.ok, false);
  await c.worker.idle();
  assert.equal(spanOf(c.worker.events, 'check-job'), undefined, 'check-job never entered the worker queue: ' + JSON.stringify(c.worker.events.map(e => e.verb)));
  // The sandbox has no CLI: the process of its own fails, and the precheck says so in words (never a bare "exit 1").
  const lines = await journalOf(c.box.local, l => l.length > 0, 10000);
  assert.equal(lines[0]?.timings?.checkVia, 'own-process', JSON.stringify(lines));
  assert.equal(lines[0].outcome, 'undecided');
  assert.doesNotMatch(lines[0].reason, /^exit \d+$/);
});

test('M3 r4: a check-job that times out is undecided with the timeout in words (on the lane worker: one request at a time), never "exit 1"', async t => {
  const box = sandbox(t);
  const base = capture(box.local, 'Shop_UI-20261015090000-d4d4d4d4.oml', CAPTURE_TEXT);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const job = path.join(box.base, 'job.json'); fs.writeFileSync(job, JSON.stringify(uiJob()));
  // What createWorkerFirstRunner answers when the worker gave no reply within the time (anvil-worker.mjs).
  const lost = async () => ({ ok: false, exitCode: 1, envelope: null, timedOut: true, unknown: true, code: 'WORKER_OUTCOME_UNKNOWN', stderr: ['worker connection failed after submission'], wallMs: 3000, line: 'worker check-job', via: 'worker' });
  assert.equal(await uiPrecheck({ lane: 'o11', job, mode: 'job', base }, { runAnvil: lost, root: box.root, local: box.local, env: box.env }), null);
  const line = (await journalOf(box.local, l => l.length > 0)).at(-1);
  assert.equal(line.outcome, 'undecided'); assert.equal(line.timedOut, true);
  assert.match(line.reason, /no answer within \d+ ms on the lane worker, which runs one request at a time/);
  assert.match(line.reason, /WORKER_OUTCOME_UNKNOWN/);
});

test('M3 r4: an accepted studio_deliver relay answers without waiting for a slow check-job; the journal is written when it ends', async t => {
  const at = {};
  const box = await relayHarness(t, { runAnvil: fakeAnvil({ 'check-job': slowCheck(at, [CENTER, { ...UNKNOWN_BLOCK, op: 0, pointer: '/ops/0/data/html' }], { complete: false }, 1500) }),
    reply: () => ({ ok: true, result: 'delivered' }) }); // what the relay answers since 16/10
  const { result, value: v, ms } = await box.deliver({ ...RELAY_ARGS, job: relayJob() });
  assert.notEqual(result.isError, true); assert.equal(v.ok, true, JSON.stringify(v).slice(0, 300));
  assert.ok(ms < 1200, 'answered in ' + Math.round(ms) + ' ms, check-job takes 1500 ms');
  const lines = await journalOf(path.join(box.odcRoot, '.local'), l => l.some(x => x.outcome === 'carried-accepted'));
  assert.ok(lines.some(x => x.outcome === 'carried-accepted'), JSON.stringify(lines.map(x => x.outcome)));
});

// CX16 r4 (last commit, declared): with check-job outside the worker queue (b6e8c45c) the precheck is ON by default again;
// SSAM_UI_PRECHECK=0 (or off, false) turns it off and every call runs as before CX16. The element edits never depend on it.
test('CX16 r4: the UI precheck is on by default again (check-job outside the worker queue); SSAM_UI_PRECHECK=0 (or off, false) turns it off', async t => {
  const saved = process.env.SSAM_UI_PRECHECK; delete process.env.SSAM_UI_PRECHECK;
  t.after(() => { if (saved === undefined) delete process.env.SSAM_UI_PRECHECK; else process.env.SSAM_UI_PRECHECK = saved; });
  const box = sandbox(t);
  const base = capture(box.local, 'Shop_UI-20261015090000-0f0f0f0f.oml', CAPTURE_TEXT);
  storeIndex(box.store, 'o11', CAPTURE_TEXT);
  const job = path.join(box.base, 'job.json'); fs.writeFileSync(job, JSON.stringify(uiJob()));
  const env = { ...box.env }; delete env.SSAM_UI_PRECHECK;
  // Unset, '' and the on values: check-job runs alongside the apply and joins.
  for (const value of [undefined, '', '1', 'on', 'true']) {
    const e = { ...env }; if (value !== undefined) e.SSAM_UI_PRECHECK = value;
    const on = fakeAnvil({ 'check-job': checkJob([UNKNOWN_BLOCK, BLOCK_TEXT], [], { complete: false }), apply: refusedApply([APPLY_SAME]) });
    const w = await runJob({ lane: 'o11', job, base }, { root: box.root, env: e, runAnvil: on, worker: null });
    assert.deepEqual(on.calls.map(c => c.args[0]).sort(), ['apply', 'check-job'], String(value));
    assert.equal(w.static?.carried, 2, String(value));
  }
  // '0', 'off' and 'false': no check-job, the refusal of the apply as before CX16.
  for (const value of ['0', 'off', 'false', 'OFF']) {
    const off = fakeAnvil({ 'check-job': () => { throw new Error('check-job ran'); }, apply: refusedApply([APPLY_SAME]) });
    const v = await runJob({ lane: 'o11', job, base }, { root: box.root, env: { ...env, SSAM_UI_PRECHECK: value }, runAnvil: off, worker: null });
    assert.deepEqual(off.calls.map(c => c.args[0]), ['apply'], value);
    assert.equal(v.ok, false); assert.equal(Object.hasOwn(v, 'static'), false, value);
    assert.equal(await uiPrecheck({ lane: 'o11', job, mode: 'job', base }, { runAnvil: off, root: box.root, local: box.local, env: { ...env, SSAM_UI_PRECHECK: value } }), null, value);
  }
});

test('the pieces: producer freshness, referenced libraries, the module of a capture, the continuation', () => {
  const delivery = { startAt: Date.parse('2026-10-15T09:00:00Z'), endAt: Date.parse('2026-10-15T09:05:00Z') };
  assert.equal(producerFresh({ at: '2026-10-15T09:06:00Z', source: 'snapshot' }, delivery), true);
  assert.equal(producerFresh({ at: '2026-10-15T09:04:00Z', source: 'delivered' }, delivery), true, 'the delivered snapshot of that delivery');
  assert.equal(producerFresh({ at: '2026-10-15T09:04:00Z', source: 'build' }, delivery), false, 'a capture before the merge');
  assert.equal(producerFresh({ at: '2026-10-15T09:06:00Z' }, undefined), false, 'no delivery recorded: not fresh');
  assert.deepEqual(referencedLibraries({ sections: [{ id: 'module', blocks: [{ kind: 'ESpace', name: 'M' }, { kind: 'Reference', name: 'OutSystemsUI' }, { text: 'reference OutSystemsMaps @k (ReactiveLibrary)' }] }] }),
    ['OutSystemsUI', 'OutSystemsMaps']);
  assert.equal(moduleOfCapture('C:\\x\\build-Shop_UI-20261015101010-abcdef12.oml'), 'Shop_UI');
  assert.equal(moduleOfCapture('C:\\x\\DemoLATAM_UI-20261014024815.oml'), 'DemoLATAM_UI');
  assert.equal(moduleOfCapture('/x/Shop_UI-' + 'a'.repeat(64) + '.oml'), 'Shop_UI');
  // Two edits of one text with different results: no certain correction, the reading.
  const conflicting = continuationOf({ lane: 'o11', mode: 'deliver', module: 'M', basedOn: { job: 'j', sha256: 'a'.repeat(64) }, ops: uiJob().ops,
    problems: [UNKNOWN_BLOCK, { ...UNKNOWN_BLOCK, edit: { ...UNKNOWN_BLOCK.edit, with: '<Block name="Other"/>' } }] });
  assert.deepEqual(conflicting.arguments, { lane: 'o11', target: 'M', view: 'html', screen: 'Stations' });
});
