// o11_inspect / o11_deliver / ssam_task on a real McpServer over InMemoryTransport, with a fake Anvil CLI, a fake bridge on
// an ephemeral port and a fake reader. No Studio, no dotnet, no Python; every folder is temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Cycle, clean, deliveryOutcome, deliverOutcome, inspectArguments, closeState, WORDS_MARKER } from '../o11-cycle.mjs';
import { kernelReading } from '../kernel-reading.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with { type: 'json' };

const sha256 = text => createHash('sha256').update(text).digest('hex');
const WORDS = 'sim, pode entregar o SaveOrder no Orders';
const SHELL = /dotnet build|python|\.ps1|ssam (connect|doctor|deliver|inspect)|odc /i;

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-cycle-'));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority'), studio = path.join(base, 'Studio');
  for (const dir of [root, home, auth]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  const env = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  // The connection record names the bridge port; nothing listens there and nothing connects to it (the runner is fake).
  fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242,
    startedUtc: '2026-10-02T00:00:00Z', studioDir: studio, authorityDir: auth, port: 45999 }));
  const job = path.join(base, 'jobs', 'save-order.json');
  fs.mkdirSync(path.dirname(job), { recursive: true });
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'get', target: 'ServerAction:SaveOrder' }] }));
  let clock = Date.parse('2026-10-02T10:15:00.000Z');
  return { base, root, env, auth, studio, job, local: path.join(root, '.local'), work: path.join(root, '.local', 'work'),
    now: () => new Date(clock += 1000), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function serve(deps) {
  const server = new McpServer({ name: 'o11-cycle-test', version: '1.0.0' });
  registerO11Cycle(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'o11-cycle-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = (name, args) => client.callTool({ name, arguments: args }).catch(error => ({ isError: true, content: [{ type: 'text', text: error.message }], thrown: true }));
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}

function setup(t, extra = {}) {
  const box = sandbox();
  const selected = [];
  const runAnvil = extra.runAnvil ?? fakeAnvil(extra.handlers ?? { deliver: () => envelopes.delivered });
  const deps = { root: box.root, env: box.env, lane: 'ss4', now: box.now, runAnvil, assertSelected: async () => { selected.push(true); }, ...extra.deps };
  t.after(box.cleanup);
  return { ...box, runAnvil, selected, deps };
}

test('the three tools are exposed with the distribution schema', async t => {
  const box = setup(t);
  const { client, close } = await serve(box.deps); t.after(close);
  const tools = Object.fromEntries((await client.listTools()).tools.map(tool => [tool.name, tool]));
  for (const name of ['o11_inspect', 'o11_deliver', 'ssam_task']) assert.ok(tools[name], 'missing ' + name);
  const inspect = tools.o11_inspect.inputSchema;
  assert.deepEqual(Object.keys(inspect.properties).sort(), ['all', 'budget', 'cold', 'depth', 'expectedSourceSha256', 'full', 'includeInternal', 'kind', 'max',
    'module', 'name', 'offset', 'oml', 'path', 'properties', 'scope', 'select', 'text', 'usages']);
  // oml or module (the open module, captured first), exactly one: checked by the tool, not by `required`.
  assert.ok(!(inspect.required ?? []).includes('oml'));
  assert.equal(inspect.properties.select.maxItems, 32); assert.equal(inspect.properties.depth.maximum, 12); assert.equal(inspect.properties.depth.default, 3);
  assert.equal(inspect.properties.max.maximum, 500); assert.equal(inspect.properties.budget.minimum, 2000); assert.equal(inspect.properties.budget.maximum, 200000);
  assert.deepEqual(inspect.properties.scope.enum, ['direct', 'subtree']);
  assert.equal(inspect.additionalProperties, false);
  assert.equal(tools.o11_inspect.annotations.readOnlyHint, true);
  const deliver = tools.o11_deliver.inputSchema;
  assert.deepEqual(Object.keys(deliver.properties).sort(), ['authorize', 'basedOn', 'captureProducers', 'checks', 'close', 'closePrevious', 'expectedEnvironment', 'job',
    'module', 'patch', 'producers', 'publish', 'resume', 'until']);
  assert.equal(deliver.properties.patch.maxItems, 50);
  assert.deepEqual(deliver.properties.patch.items.properties.op.enum, ['add', 'remove', 'replace', 'test']);
  assert.equal(deliver.properties.patch.items.additionalProperties, false);
  assert.deepEqual(deliver.properties.patch.items.required, ['op', 'path'], 'remove takes no value');
  assert.equal(deliver.properties.basedOn.anyOf.length, 2);
  assert.deepEqual(Object.keys(deliver.properties.close.properties).sort(), ['reason', 'taskId']);
  // authorize: the user's words, or absent when a standing grant covers the module (contract I6).
  assert.ok(!(deliver.required ?? []).includes('authorize'));
  assert.equal(deliver.properties.publish.type, 'boolean');
  assert.ok(!(deliver.required ?? []).includes('module') && !(deliver.required ?? []).includes('job'), 'resume needs neither module nor job');
  assert.deepEqual(deliver.properties.until.enum, ['apply', 'merge']); assert.equal(deliver.properties.until.default, 'merge');
  assert.equal(deliver.additionalProperties, false);
  assert.equal(tools.o11_deliver.annotations.readOnlyHint, false); assert.equal(tools.o11_deliver.annotations.destructiveHint, true);
  // ssam_task {id, close}: close is a write (C15), so the tool is not read-only.
  assert.deepEqual(Object.keys(tools.ssam_task.inputSchema.properties), ['id', 'close']);
  assert.equal(tools.ssam_task.annotations.readOnlyHint, false);
  for (const tool of Object.values(tools)) assert.doesNotMatch(tool.description, SHELL);
});

test('o11_inspect hands the reading to the resident reader with the same arguments as ssam inspect, summary included', async t => {
  const calls = [];
  const read = async (entry, args) => { calls.push({ entry, args }); return { ok: true, command: 'inspect', elapsedMs: 1,
    data: { ok: true, file: args[1], sourceSha256: 'ab'.repeat(32), inline: true, schema: 'ssam-reading/1', tree: { kind: 'ServerAction', name: 'SaveOrder' } } }; };
  const box = setup(t, { deps: { read } });
  const oml = path.join(box.base, 'captures', 'Orders.oml');
  fs.mkdirSync(path.dirname(oml), { recursive: true }); fs.writeFileSync(oml, 'oml bytes');
  const { call, close } = await serve(box.deps); t.after(close);

  const detailed = await call('o11_inspect', { oml, path: '@k1', select: ['Kind:A', 'Kind:B'], depth: 4, usages: true, expectedSourceSha256: 'ab'.repeat(32) });
  assert.equal(detailed.isError, undefined, detailed.content[0].text);
  assert.equal(detailed.structuredContent.tree.name, 'SaveOrder');
  assert.deepEqual(calls[0].args, ['--oml', oml, '--path', '@k1', '--select', 'Kind:A', '--select', 'Kind:B', '--depth', '4', '--max', '60', '--offset', '0',
    '--budget', '60000', '--usages', '--expectedSourceSha256', 'ab'.repeat(32), '--ss-dir', box.studio]);
  assert.equal(calls[0].entry.root, box.root); assert.equal(calls[0].entry.lane, 'ss4'); assert.match(calls[0].entry.cli, /anvil\.dll$/);

  const summary = await call('o11_inspect', { oml });
  assert.equal(summary.isError, undefined);
  assert.deepEqual(calls[1].args, ['--oml', oml, '--depth', '3', '--max', '60', '--offset', '0', '--budget', '60000', '--ss-dir', box.studio]);

  const missing = await call('o11_inspect', { oml: path.join(box.base, 'none.oml') });
  assert.equal(missing.isError, true); assert.equal(missing.structuredContent.code, 'CAPTURE_NOT_FOUND');
  assert.equal(calls.length, 2);
});

// The argv is the contract with kernel-reading.mjs: its parser accepts every flag, and the call stops at the missing CLI
// folder (ENOENT in readerGeneration), before any reader process could start.
test('every o11_inspect argument is accepted by the real kernel-reading parser', async t => {
  const box = setup(t);
  const oml = path.join(box.base, 'Orders.oml'); fs.writeFileSync(oml, 'x');
  const args = inspectArguments({ path: '@k1', select: ['A', 'B'], kind: 'ServerAction', name: 'SaveOrder', text: 'total', properties: 'Name,Label',
    scope: 'direct', depth: 2, max: 10, offset: 5, budget: 3000, usages: true, includeInternal: true, all: true, full: true, cold: true,
    expectedSourceSha256: 'cd'.repeat(32) }, oml, box.studio);
  await assert.rejects(kernelReading({ name: 'o11', root: box.root, lane: 'ss4', cli: path.join(box.root, 'cli', 'anvil.dll') }, args),
    error => error.code === 'ENOENT' && !/Unknown reading argument|Missing value|must be an integer/.test(error.message));
});

test('o11_inspect refuses with O11_READER_UNAVAILABLE and an MCP continuation when the reader cannot start', async t => {
  const box = setup(t); // no deps.read: the real availability check runs; the temporary root has no CLI and no Studio
  const oml = path.join(box.base, 'Orders.oml'); fs.writeFileSync(oml, 'x');
  const { call, close } = await serve(box.deps); t.after(close);
  const result = await call('o11_inspect', { oml });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'O11_READER_UNAVAILABLE');
  assert.deepEqual(result.structuredContent.missing, ['cli', 'studio']);
  assert.deepEqual(result.structuredContent.continuation.tool, 'ssam_doctor');
  assert.deepEqual(result.structuredContent.continuation.arguments, { lane: 'o11' });
  assert.doesNotMatch(result.content[0].text, SHELL);
});

test('o11_deliver without the user words refuses before touching the Studio or the CLI', async t => {
  const box = setup(t);
  const { call, close } = await serve(box.deps); t.after(close);
  const blank = await call('o11_deliver', { module: 'Orders', job: box.job, authorize: '   ' });
  assert.equal(blank.isError, true); assert.equal(blank.structuredContent.code, 'WORDS_REQUIRED');
  assert.equal(blank.structuredContent.continuation.tool, 'o11_deliver');
  const absent = await call('o11_deliver', { module: 'Orders', job: box.job });
  assert.equal(absent.isError, true);
  assert.equal(box.runAnvil.calls.length, 0); assert.equal(box.selected.length, 0);
  assert.ok(!fs.existsSync(path.join(box.local, 'journal', 'o11_deliver.jsonl')));
});

test('a Studio that is no longer selected refuses with ssam_connect, never a shell command', async t => {
  const box = setup(t, { deps: { assertSelected: async () => { throw new Error('The selected Studio session is no longer connected. Run ssam connect --lane o11 to select the current Studio.'); } } });
  const { call, close } = await serve(box.deps); t.after(close);
  const result = await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS });
  assert.equal(result.structuredContent.code, 'STUDIO_NOT_SELECTED');
  assert.deepEqual(result.structuredContent.continuation.arguments, { lane: 'o11' });
  assert.equal(result.structuredContent.continuation.tool, 'ssam_connect');
  assert.doesNotMatch(result.content[0].text, SHELL);
  assert.equal(box.runAnvil.calls.length, 0);
});

test('an inline job becomes a file under the lane jobs folder and that file is what deliver gets', async t => {
  const box = setup(t);
  const { call, close } = await serve(box.deps); t.after(close);
  const job = { ops: [{ op: 'set', target: 'ServerAction:SaveOrder', property: 'Description', value: 'Saves' }] };
  const result = await call('o11_deliver', { module: 'Orders', job, authorize: WORDS });
  assert.equal(result.structuredContent.result, 'entregue');
  const inline = path.join(box.local, 'jobs', 'inline');
  const files = fs.readdirSync(inline);
  assert.equal(files.length, 1); assert.match(files[0], /^[0-9a-f-]{36}\.json$/);
  const argv = box.runAnvil.calls[0].args;
  assert.equal(argv[argv.indexOf('--job') + 1], path.join(inline, files[0]));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(inline, files[0]), 'utf8')), job);
  // an array of ops is a job too
  await call('o11_deliver', { module: 'Orders', job: job.ops, authorize: WORDS });
  assert.equal(fs.readdirSync(inline).length, 2);
});

// 2026-10-12 (production test): after "entregue" the session read the whole module digest again (31 KB) to confirm the
// names and signatures it had just written. The delivered answer now says what the job created.
test('a delivery answers "entregue" with the summary of its job: each action with its inputs and outputs, each entity with its attributes', async t => {
  const box = setup(t);
  const { call, close } = await serve(box.deps); t.after(close);
  const job = { ops: [
    { op: 'spec', data: { entities: [{ name: 'Pedido', attributes: [{ name: 'Numero', type: 'Text' }, { name: 'Total', type: 'Decimal' }] }] } },
    { op: 'logic', data: { actions: [{ name: 'Pedido_Get', inputs: [{ name: 'PedidoId', type: 'Pedido Identifier' }], outputs: [{ name: 'Pedido', type: 'Pedido' }], steps: [] }] } },
  ] };
  const result = await call('o11_deliver', { module: 'Orders', job, authorize: WORDS });
  assert.equal(result.structuredContent.result, 'entregue');
  assert.deepEqual(result.structuredContent.summary, { ops: 2, actions: ['Pedido_Get(PedidoId: Pedido Identifier) -> (Pedido: Pedido)'], entities: [{ name: 'Pedido', attributes: 2 }] });
  // A job that only reads names nothing: no summary.
  const read = await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS });
  assert.equal(read.structuredContent.result, 'entregue'); assert.equal(read.structuredContent.summary, undefined);
});

test('deliver gets the exact argv: module, job, checks, producers, captures, environment, lane work and connection port', async t => {
  const box = setup(t);
  const avsig = path.join(box.base, 'Lib.avsig'); fs.writeFileSync(avsig, '{}');
  const { call, close } = await serve(box.deps); t.after(close);
  await call('o11_deliver', { module: 'Orders', job: box.job, checks: ['SaveOrder', 'OrderList'], producers: { Lib: avsig },
    captureProducers: ['System=(System)'], expectedEnvironment: 'personal-x.outsystemscloud.com', authorize: WORDS });
  assert.deepEqual(box.runAnvil.calls[0].args, ['deliver', '--module', 'Orders', '--job', box.job, '--checks', 'SaveOrder,OrderList',
    '--producer', 'Lib=' + avsig, '--capture-producer', 'System=(System)', '--expected-environment', 'personal-x.outsystemscloud.com',
    '--work', box.work, '--port', '45999', '--close-opened-tab']);
  assert.equal(box.selected.length, 1);
  // a producer with a relative path or a bad binding never reaches the CLI
  const bad = await call('o11_deliver', { module: 'Orders', job: box.job, producers: { Lib: 'Lib.avsig' }, authorize: WORDS });
  assert.equal(bad.structuredContent.code, 'PRODUCER_INVALID');
  assert.deepEqual(bad.structuredContent.continuation.arguments, { module: 'Orders' }); assert.equal(bad.structuredContent.continuation.tool, 'o11_deliver');
  const relative = await call('o11_deliver', { module: 'Orders', job: 'jobs/save-order.json', authorize: WORDS });
  assert.equal(relative.structuredContent.code, 'JOB_PATH_NOT_ABSOLUTE');
  assert.equal(box.runAnvil.calls.length, 1);
});

test('a delivered task answers "entregue" and the job it used, ready for the next basedOn (nextBasedOn)', async t => {
  const box = setup(t);
  const { call, close } = await serve(box.deps); t.after(close);
  const result = await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS });
  assert.equal(result.isError, undefined);
  const value = { ok: true, result: 'entregue', nextBasedOn: { job: box.job, sha256: sha256(fs.readFileSync(box.job)) } };
  assert.deepEqual(result.structuredContent, value);
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(value) }]);
});

test('validation errors come back with stage and taskId, and nothing is delivered', async t => {
  const box = setup(t, { handlers: { deliver: (() => { const queue = [envelopes.refusedBeforeMerge, envelopes.refusedAfterMerge]; return () => queue.shift(); })() } });
  const { call, close } = await serve(box.deps); t.after(close);
  const before = await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS });
  assert.equal(before.isError, true); assert.notEqual(before.content[0].text, 'entregue');
  const b = before.structuredContent;
  assert.equal(b.outcome, 'refused'); assert.equal(b.code, 'VALIDATION_REFUSED'); assert.equal(b.stage, 'apply');
  assert.equal(b.taskId, '1a2b3c4d5e6f708192a3b4c5d6e7f809'); assert.equal(b.merged, undefined);
  assert.equal(b.messages[0], "Error UndefinedVariable: Undefined variable 'Total' @ Orders/ServerAction:SaveOrder");
  assert.match(b.error, /merge was not attempted/);
  assert.equal(b.continuation, undefined, 'no catalog of fixes');

  const after = await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS });
  const a = after.structuredContent;
  assert.equal(a.code, 'VALIDATION_REFUSED'); assert.equal(a.stage, 'verify'); assert.equal(a.merged, true);
  assert.match(a.error, /^merge kept for review: .*Ctrl\+Z in Studio undoes it; nothing was published$/); assert.ok(a.error.length <= 300);
  assert.equal(a.taskId, '2b3c4d5e6f708192a3b4c5d6e7f8091a');
  assert.deepEqual(a.failures.map(f => f.stage), ['verify']);
  assert.ok(a.messages.some(m => /RequiredProperty/.test(m)));
  assert.equal(box.runAnvil.calls.length, 2, 'one CLI run per call, never a retry');
});

// The deterministic engine: a refusal before the merge keeps every change the kernel names (DatabaseUpgradeRules gives one
// line per reference, longer than the clipped error), and a merge that lost defaults (MergeOrder) answers the repair job.
test('every line of a refusal before the merge, and the merge order repair after one, reach the answer', async t => {
  const cascade = 'InvalidOperationException: op #0 (spec PetMessage.InteractionId): PetMessage.InteractionId: set Delete Rule to Ignore or Protect; '
    + 'Pet reaches PetMessage by two cascade paths: Pet->Interaction->PetMessage [Interaction.PetId, PetMessage.InteractionId] and Pet->PetMessage [PetMessage.PetId]; '
    + 'Player reaches PetMessage by two cascade paths: Player->Interaction->PetMessage [Interaction.PlayerId, PetMessage.InteractionId] and Player->PetMessage [PetMessage.PlayerId]. '
    + 'Change: in the spec, "deleteRule":"Ignore" (or "Protect") on attribute InteractionId of PetMessage; the other Delete rules stay.\n'
    + 'op #0 (spec Match.AwayTeamId): Match.AwayTeamId: set Delete Rule to Ignore or Protect; Team reaches Match by two cascade paths: Team->Match [Match.AwayTeamId] and Team->Match [Match.HomeTeamId]. '
    + 'Change: in the spec, "deleteRule":"Ignore" (or "Protect") on attribute AwayTeamId of Match; the other Delete rules stay.\n'
    + 'Why: on O11 a reference with Delete Rule Delete is a FOREIGN KEY ... ON DELETE CASCADE (error 1785). Nothing was delivered: change the job and deliver it again.';
  const repair = { ops: [{ op: 'set', target: '@k1', prop: 'DefaultValue', value: 'Entities.Species.Dog' }, { op: 'set', target: '@k2', prop: 'DefaultValue', value: 'Entities.Stage.Egg' }] };
  const lost = 'Merge kept for review: the native merge did not keep 2 default value(s): Pet.SpeciesId = Entities.Species.Dog, Pet.StageId = Entities.Stage.Egg; nothing else differs. '
    + 'Each element exists now, so a merge keeps a default set on it: deliver mergeOrder.repair as a new job ' + JSON.stringify(repair) + '.';
  const envelopesNow = [
    { ok: false, command: 'deliver', data: { taskId: '7a8b9c0d1e2f30415263748596a7b8c9', module: 'OfficePet_CS', delivered: false, writeState: 'not-sent', stage: 'apply', error: cascade } },
    { ok: false, command: 'deliver', data: { taskId: '8b9c0d1e2f30415263748596a7b8c9d0', module: 'OfficePet_CS', delivered: false, writeState: 'applied', stage: 'data-proof', error: lost,
      merge: { merged: true }, validation: { newErrors: 0, new: [] }, failures: [{ stage: 'data-proof', error: lost }],
      mergeOrder: { missing: [{ key: 'k1', objectKey: 'k1', element: 'Pet.SpeciesId', property: 'DefaultValue', value: 'Entities.Species.Dog', baseValue: null },
        { key: 'k2', objectKey: 'k2', element: 'Pet.StageId', property: 'DefaultValue', value: 'Entities.Stage.Egg', baseValue: null }],
      rule: 'merge order', repair, forcedDeleteRules: [], declare: { ops: [] } } } }];
  const box = setup(t, { handlers: { deliver: () => envelopesNow.shift() } });
  const { call, close } = await serve(box.deps); t.after(close);

  const refused = (await call('o11_deliver', { module: 'OfficePet_CS', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(refused.outcome, 'refused'); assert.equal(refused.stage, 'apply'); assert.equal(refused.merged, undefined);
  assert.ok(refused.error.length <= 300);
  assert.equal(refused.refusalLines.length, 3);
  assert.match(refused.refusalLines[0], /Change: in the spec, "deleteRule":"Ignore" \(or "Protect"\) on attribute InteractionId of PetMessage/);
  assert.match(refused.refusalLines[1], /^op #0 \(spec Match\.AwayTeamId\): Match\.AwayTeamId: set Delete Rule to Ignore or Protect/);
  assert.equal(refused.mergeOrder, undefined);

  const kept = (await call('o11_deliver', { module: 'OfficePet_CS', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(kept.merged, true); assert.equal(kept.refusalLines, undefined);
  assert.deepEqual(kept.mergeOrder, { missing: ['Pet.SpeciesId = Entities.Species.Dog', 'Pet.StageId = Entities.Stage.Egg'], repair });
  assert.equal(kept.continuation.tool, 'o11_deliver');
  // The refused task still holds the module (ModuleReservation): the repair closes it first, in the same call.
  assert.deepEqual(kept.continuation.arguments, { module: 'OfficePet_CS', job: repair, closePrevious: '8b9c0d1e2f30415263748596a7b8c9d0', authorize: WORDS_MARKER });
  assert.equal(box.runAnvil.calls.length, 2, 'one CLI run per call, never a retry');
});

// A hub entity reached by many cascade paths gives fix lines longer than 700 characters, the exact change at their end,
// and more than a dozen of them: none is clipped or dropped.
test('a refusal before the merge keeps every fix line whole, however long and however many', () => {
  const change = i => 'Change: in the spec, "deleteRule":"Ignore" (or "Protect") on attribute Ref' + i + ' of Hub; the other Delete rules stay.';
  const paths = Array.from({ length: 12 }, (_, k) => `Root${k} reaches Hub by two cascade paths: Root${k}->Mid->Hub [Mid.Root${k}Id, Hub.MidId] and Root${k}->Hub [Hub.Root${k}Id]`).join('; ');
  const fix = i => `op #0 (spec Hub.Ref${i}): Hub.Ref${i}: set Delete Rule to Ignore or Protect; ${paths}. ${change(i)}`;
  const error = [...Array.from({ length: 14 }, (_, i) => fix(i)), 'Why: on O11 a reference with Delete Rule Delete is a FOREIGN KEY ... ON DELETE CASCADE.'].join('\n');
  assert.ok(fix(0).length > 1000);
  const answer = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: { taskId: '7a8b9c0d1e2f30415263748596a7b8c9', delivered: false, writeState: 'not-sent', stage: 'apply', error } } },
    { trackId: 't', work: '.', job: null, input: { module: 'Hub_CS' } });
  assert.equal(answer.refusalLines.length, 15);
  for (let i = 0; i < 14; i++) assert.ok(answer.refusalLines[i].endsWith(change(i)), 'line ' + i + ' keeps its change');
  assert.match(answer.refusalLines[14], /^Why: /);
});

// A bridge without the merge order is refused before the merge (Delivery.cs, capability merge_from_oml:first_pass).
test('a delivery refused for a bridge without the merge order says so, with the doctor and the task to resume', () => {
  const answer = deliverOutcome({ envelope: { ok: false, command: 'deliver', data: { taskId: '7a8b9c0d1e2f30415263748596a7b8c9', delivered: false, writeState: 'not-sent',
    stage: 'merge-order', code: 'BRIDGE_OUTDATED', error: 'The Service Studio runs a bridge without the merge order (capability merge_from_oml:first_pass); nothing was merged.' } } },
    { trackId: 't', work: '.', job: null, input: { module: 'OfficePet_CS' } });
  assert.equal(answer.code, 'BRIDGE_OUTDATED'); assert.equal(answer.outcome, 'refused'); assert.equal(answer.merged, undefined);
  assert.equal(answer.continuation.tool, 'ssam_doctor'); assert.match(answer.continuation.why, /resume:"7a8b9c0d1e2f30415263748596a7b8c9"/);
});

// Each native merge that merged is one Studio command: a merge-order delivery kept for review takes two undo steps.
test('a merge kept for review names the undo steps the bridge counted', () => {
  const kept = undoSteps => deliverOutcome({ envelope: { ok: false, command: 'deliver', data: { taskId: '7a8b9c0d1e2f30415263748596a7b8c9', delivered: false,
    writeState: 'applied', stage: 'checks', error: 'requested element Foo was not found', failures: [{ stage: 'checks', error: 'requested element Foo was not found' }],
    merge: { merged: true, ...(undoSteps ? { undoSteps } : {}) }, validation: { newErrors: 0, new: [] } } } }, { trackId: 't', work: '.', job: null, input: { module: 'M' } }).error;
  assert.match(kept(2), /^Merge kept for review in the Studio \(Ctrl\+Z twice undoes it\)/);
  assert.match(kept(1), /^Merge kept for review in the Studio \(Ctrl\+Z undoes it\)/);
  assert.match(kept(), /^Merge kept for review in the Studio \(Ctrl\+Z undoes it\)/);
});

test('an uncertain write is never repeated: resume of the same task, or ssam_task when no task was registered', async t => {
  const box = setup(t, { handlers: { deliver: (() => { const queue = [envelopes.uncertain, envelopes.appliedUnconfirmed, envelopes.moduleHeld]; return () => queue.shift(); })() } });
  const { call, close } = await serve(box.deps); t.after(close);
  const unknown = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(unknown.outcome, 'uncertain'); assert.equal(unknown.code, 'DELIVERY_UNCERTAIN'); assert.equal(unknown.writeState, 'unknown');
  assert.equal(unknown.continuation.tool, 'o11_deliver'); assert.deepEqual(unknown.continuation.arguments, { resume: '3c4d5e6f708192a3b4c5d6e7f8091a2b' });
  assert.equal(box.runAnvil.calls.length, 1);
  const unconfirmed = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(unconfirmed.outcome, 'uncertain', 'a merge applied without a validation result is not settled');
  assert.deepEqual(unconfirmed.continuation.arguments, { resume: '4d5e6f708192a3b4c5d6e7f8091a2b3c' });
  // the kernel holds the module for the uncertain task of this root and says which one to resume (A28, atritos 2: a holder
  // this root does not have continues with ssam_doctor instead, pa2-f1-deliver.test.mjs)
  writeKernelTask(box.work, '3c4d5e6f708192a3b4c5d6e7f8091a2b', { moduleKey: 'k1', writeState: 'unknown', stage: 'merge', error: 'timed out' });
  const held = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(held.code, 'DELIVERY_FAILED'); assert.deepEqual(held.continuation.arguments, { resume: '3c4d5e6f708192a3b4c5d6e7f8091a2b' });
  assert.equal(box.runAnvil.calls.length, 3);
});

test('a timeout after the request is uncertain: the kernel checkpoint decides, else ssam_task', async t => {
  let writeCheckpoint = false;
  const calls = [];
  const box = setup(t, { runAnvil: async (args) => {
    calls.push(args);
    if (writeCheckpoint) { // the kernel registered the task and recorded the merge intent before it was stopped
      const job = args[args.indexOf('--job') + 1], work = args[args.indexOf('--work') + 1], id = '6f708192a3b4c5d6e7f8091a2b3c4d5e';
      const payload = JSON.stringify({ taskId: id, module: 'Orders', request: { Module: 'Orders', JobPath: job, WorkDirectory: work },
        delivered: false, writeState: 'intent', stage: 'merge', updatedAt: new Date().toISOString() });
      fs.mkdirSync(path.join(work, 'deliver', id), { recursive: true });
      fs.writeFileSync(path.join(work, 'deliver', id, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
    }
    return { ok: false, exitCode: 1, envelope: null, stderr: [], wallMs: 1, timedOut: true, line: 'dotnet anvil.dll deliver' };
  } });
  const { call, close } = await serve(box.deps); t.after(close);
  const blind = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(blind.outcome, 'uncertain'); assert.equal(blind.continuation.tool, 'ssam_task');
  const task = (await call('ssam_task', { id: blind.continuation.arguments.id })).structuredContent.task;
  assert.equal(task.state, 'uncertain'); assert.equal(task.tool, 'o11_deliver');
  writeCheckpoint = true;
  const recorded = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(recorded.outcome, 'uncertain'); assert.equal(recorded.writeState, 'intent'); assert.equal(recorded.stage, 'merge');
  assert.deepEqual(recorded.continuation.arguments, { resume: '6f708192a3b4c5d6e7f8091a2b3c4d5e' });
  assert.equal(calls.length, 2);
});

test('failures before any task are plain refusals and carry no shell hint', async t => {
  const box = setup(t, { handlers: { deliver: () => envelopes.argumentError } });
  const { call, close } = await serve(box.deps); t.after(close);
  const result = (await call('o11_deliver', { module: 'Orders', job: box.job, expectedEnvironment: 'https://x', authorize: WORDS })).structuredContent;
  assert.equal(result.outcome, 'refused'); assert.equal(result.code, 'DELIVERY_FAILED'); assert.equal(result.stage, 'start');
  assert.match(result.error, /bare host name/); assert.doesNotMatch(result.error, SHELL);
});

test('until=apply snapshots through the bridge, applies on that capture and never calls deliver', async t => {
  const bridge = await fakeBridge(request => {
    if (request.method === 'open_module') return { success: true, data: { opened: true } };
    if (request.method === 'get_active_module') return { success: true, data: { name: 'Orders', key: 'k1', environment: 'personal-x.outsystemscloud.com' } };
    if (request.method === 'snapshot_module') return { success: true, data: { path: request.params.path, key: 'k1', snapshot_id: 's1' } };
    return { success: false, error: 'unexpected ' + request.method };
  });
  t.after(() => bridge.close());
  const results = [{ ok: true, command: 'apply', data: { isValid: true, accepted: true } },
    { ok: true, command: 'apply', data: { isValid: false, accepted: false, validation: { new: [{ id: 'X', type: 'Error', path: 'Orders/Entity:Order', detail: 'Broken' }] } } }];
  const box = setup(t, { handlers: { apply: () => results.shift(), deliver: () => { throw new Error('deliver must not run'); } },
    deps: { bridge: o11Bridge({ port: bridge.port, authorization: 'TESTKEY' }) } });
  const { call, close } = await serve(box.deps); t.after(close);
  const valid = await call('o11_deliver', { module: 'Orders', job: box.job, until: 'apply', expectedEnvironment: 'personal-x.outsystemscloud.com', authorize: WORDS });
  assert.deepEqual(valid.structuredContent, { ok: true, valid: true, nextBasedOn: { job: box.job, sha256: sha256(fs.readFileSync(box.job)) } });
  assert.deepEqual(bridge.seen.map(r => r.method), ['open_module', 'get_active_module', 'snapshot_module']);
  assert.deepEqual(bridge.seen[0].params, { name: 'Orders', environment: 'personal-x.outsystemscloud.com' });
  const snapshot = bridge.seen[2].params.path;
  assert.equal(path.dirname(snapshot), path.join(box.local, 'snapshots')); assert.match(path.basename(snapshot), /^Orders-\d{8}T\d{9}Z\.oml$/);
  assert.equal(bridge.seen[2].params.module_key, 'k1'); assert.equal(bridge.seen[2].authorization, 'TESTKEY');
  const argv = box.runAnvil.calls[0].args;
  assert.equal(argv[0], 'apply');
  assert.equal(argv[argv.indexOf('--job') + 1], box.job); assert.equal(argv[argv.indexOf('--base') + 1], snapshot);
  assert.ok(argv[argv.indexOf('--out') + 1].startsWith(path.join(box.work, 'apply')));
  assert.ok(argv.includes('--work'));

  const invalid = (await call('o11_deliver', { module: 'Orders', job: box.job, until: 'apply', authorize: WORDS })).structuredContent;
  assert.equal(invalid.ok, false); assert.equal(invalid.valid, false); assert.equal(invalid.code, 'VALIDATION_REFUSED');
  assert.deepEqual(invalid.messages, ['Error X: Broken @ Orders/Entity:Order']);
  assert.ok(box.runAnvil.calls.every(c => c.args[0] === 'apply'));

  const captures = (await call('o11_deliver', { module: 'Orders', job: box.job, until: 'apply', captureProducers: ['Lib'], authorize: WORDS })).structuredContent;
  assert.equal(captures.code, 'CAPTURE_NEEDS_DELIVER'); assert.equal(captures.continuation.tool, 'o11_dependencies');
  assert.equal(box.runAnvil.calls.length, 2);
});

test('until=apply stops when the active module is another one, before any capture', async t => {
  const bridge = await fakeBridge(request => request.method === 'open_module' ? { success: true, data: { alreadyOpen: true } }
    : request.method === 'get_active_module' ? { success: true, data: { name: 'Billing', key: 'k2' } } : { success: false, error: 'no' });
  t.after(() => bridge.close());
  const box = setup(t, { handlers: {}, deps: { bridge: o11Bridge({ port: bridge.port, authorization: 'TESTKEY' }) } });
  const { call, close } = await serve(box.deps); t.after(close);
  const result = (await call('o11_deliver', { module: 'Orders', job: box.job, until: 'apply', authorize: WORDS })).structuredContent;
  assert.equal(result.code, 'ACTIVE_MODULE_CHANGED');
  assert.deepEqual(bridge.seen.map(r => r.method), ['open_module', 'get_active_module']);
  assert.equal(box.runAnvil.calls.length, 0);
});

test('a module label with spaces reaches the one open module with the same letters; several are refused before anything runs', async t => {
  let open = [{ name: 'Orders_CS', key: 'k1' }, { name: 'Billing', key: 'k2' }];
  const bridge = await fakeBridge(request => request.method === 'list_open_modules' ? { success: true, data: { count: open.length, modules: open } }
    : { success: false, error: 'unexpected ' + request.method });
  t.after(() => bridge.close());
  const box = setup(t, { deps: { bridge: o11Bridge({ port: bridge.port, authorization: 'TESTKEY' }) } });
  const { call, close } = await serve(box.deps); t.after(close);
  const delivered = await call('o11_deliver', { module: 'Orders CS', job: box.job, authorize: WORDS });
  assert.equal(delivered.structuredContent.result, 'entregue');
  assert.deepEqual(box.runAnvil.calls[0].args.slice(0, 3), ['deliver', '--module', 'Orders_CS']);
  // Besides the name, a delivered module reads only its last publication (section 3.2 lastPublication, publish_log).
  const studio = () => bridge.seen.map(r => r.method).filter(m => m !== 'publish_log');
  assert.deepEqual(studio(), ['list_open_modules']);
  // A module name without a space is passed on unread: o11_deliver opens a module of the environment by name.
  await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS });
  assert.equal(studio().length, 1); assert.deepEqual(box.runAnvil.calls[1].args.slice(0, 3), ['deliver', '--module', 'Orders']);
  open = [{ name: 'Orders_CS', key: 'k1' }, { name: 'OrdersCS', key: 'k3' }];
  const ambiguous = (await call('o11_deliver', { module: 'Orders CS', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(ambiguous.ok, false); assert.equal(ambiguous.code, 'MODULE_AMBIGUOUS');
  assert.deepEqual(ambiguous.candidates, ['OrdersCS', 'Orders_CS']); assert.equal(ambiguous.continuation.tool, 'o11_deliver');
  assert.equal(box.runAnvil.calls.length, 2, 'nothing ran for the ambiguous name');
});

test('resume becomes deliver --resume <id> --work --port and keeps the task request', async t => {
  const box = setup(t);
  const id = '3c4d5e6f708192a3b4c5d6e7f8091a2b';
  const { call, close } = await serve(box.deps); t.after(close);
  const resumed = await call('o11_deliver', { resume: id, authorize: WORDS });
  assert.equal(resumed.structuredContent.result, 'entregue');
  assert.deepEqual(box.runAnvil.calls[0].args, ['deliver', '--resume', id, '--work', box.work, '--port', '45999', '--close-opened-tab']);
  const replaced = (await call('o11_deliver', { resume: id, job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(replaced.code, 'RESUME_FIXED');
  const payload = JSON.stringify({ taskId: id, module: 'Orders', request: { Module: 'Orders' }, writeState: 'unknown' });
  fs.mkdirSync(path.join(box.work, 'deliver', id), { recursive: true });
  fs.writeFileSync(path.join(box.work, 'deliver', id, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
  const other = (await call('o11_deliver', { resume: id, module: 'Billing', authorize: WORDS })).structuredContent;
  assert.equal(other.code, 'RESUME_MODULE_MISMATCH');
  assert.equal(box.runAnvil.calls.length, 1);
});

test('ssam_task lists and reads the deliveries, by task id or by kernel taskId', async t => {
  const box = setup(t, { handlers: { deliver: (() => { const queue = [envelopes.delivered, envelopes.refusedBeforeMerge]; return () => queue.shift(); })() } });
  const { call, close } = await serve(box.deps); t.after(close);
  await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS });
  await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS });
  const list = (await call('ssam_task', {})).structuredContent;
  assert.equal(list.ok, true); assert.equal(list.tasks.length, 2);
  assert.deepEqual(list.tasks.map(task => task.state), ['failed', 'ok'], 'newest first');
  for (const task of list.tasks) { assert.equal(task.tool, 'o11_deliver'); assert.equal(task.summary.module, 'Orders'); assert.ok(task.endedAt); }
  assert.equal(list.tasks[1].result.result, 'entregue');
  const one = (await call('ssam_task', { id: list.tasks[0].id })).structuredContent;
  assert.equal(one.task.result.code, 'VALIDATION_REFUSED'); assert.equal(one.task.summary.jobSha256, sha256(fs.readFileSync(box.job)));
  const byKernel = (await call('ssam_task', { id: '1a2b3c4d5e6f708192a3b4c5d6e7f809' })).structuredContent;
  assert.equal(byKernel.task.id, list.tasks[0].id);
  const none = (await call('ssam_task', { id: '00000000-0000-4000-8000-000000000000' })).structuredContent;
  assert.equal(none.code, 'TASK_NOT_FOUND'); assert.equal(none.continuation.tool, 'ssam_task');
});

test('the journal keeps only the sha256 of the words, and no task file holds them', async t => {
  const box = setup(t);
  const { call, close } = await serve(box.deps); t.after(close);
  await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS });
  const file = path.join(box.local, 'journal', 'o11_deliver.jsonl');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(WORDS) && !text.includes('pode entregar'));
  const lines = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.map(l => l.event), ['start', 'end']);
  assert.equal(lines[0].wordsSha256, sha256(WORDS)); assert.equal(lines[0].module, 'Orders'); assert.equal(lines[1].outcome, 'delivered');
  assert.ok(lines.every(l => !('authorize' in l)));
  for (const name of fs.readdirSync(path.join(box.local, 'tasks'))) assert.ok(!fs.readFileSync(path.join(box.local, 'tasks', name), 'utf8').includes(WORDS));
});

// ---- closing a refused task (kernel DeliveryTask.CloseKnownFailure through `deliver --close`)
const HELD = '3c4d5e6f708192a3b4c5d6e7f8091a2b';
const REFUSED_ID = '2b3c4d5e6f708192a3b4c5d6e7f8091a';
function writeKernelTask(work, id, state) {
  const payload = JSON.stringify({ taskId: id, module: 'Orders', request: { Module: 'Orders' }, delivered: false, ...state });
  fs.mkdirSync(path.join(work, 'deliver', id), { recursive: true });
  fs.writeFileSync(path.join(work, 'deliver', id, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
}
const refusedAfterMerge = { moduleKey: 'k1', environment: 'personal-x.outsystemscloud.com', writeState: 'applied', stage: 'verify',
  error: envelopes.refusedAfterMerge.data.error, validation: { newErrors: 1, new: [] } };
const closing = refusedId => args => {
  if (!args.includes('--close')) return envelopes.delivered;
  const id = args[args.indexOf('--close') + 1];
  if (id === refusedId) return { ok: false, command: 'deliver', elapsedMs: 5, error: 'InvalidOperationException: Select the original module/environment before closing its failed delivery' };
  return { ok: true, command: 'deliver', elapsedMs: 5, data: { taskId: id, ...refusedAfterMerge, closed: true, closedReason: args[args.indexOf('--reason') + 1] } };
};

test('close alone closes a refused task and answers only "fechada"; never an uncertain one', async t => {
  const box = setup(t, { handlers: { deliver: closing('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') } });
  writeKernelTask(box.work, REFUSED_ID, refusedAfterMerge);
  const { call, close } = await serve(box.deps); t.after(close);
  const closed = await call('o11_deliver', { close: { taskId: REFUSED_ID, reason: 'job corrigido' }, authorize: WORDS });
  assert.equal(closed.isError, undefined, closed.content[0].text);
  assert.deepEqual(closed.content, [{ type: 'text', text: 'fechada' }]); assert.deepEqual(closed.structuredContent, { ok: true, result: 'fechada' });
  assert.deepEqual(box.runAnvil.calls[0].args, ['deliver', '--close', REFUSED_ID, '--reason', 'job corrigido', '--work', box.work, '--port', '45999']);
  assert.equal(box.selected.length, 1);

  const uncertainId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  writeKernelTask(box.work, uncertainId, { moduleKey: 'k1', writeState: 'unknown', stage: 'merge', error: 'merge timed out' });
  const uncertain = (await call('o11_deliver', { close: { taskId: uncertainId, reason: 'x' }, authorize: WORDS })).structuredContent;
  assert.equal(uncertain.outcome, 'uncertain'); assert.equal(uncertain.code, 'PREVIOUS_UNCERTAIN');
  assert.deepEqual(uncertain.continuation.arguments, { resume: uncertainId });
  const kernelRefused = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  writeKernelTask(box.work, kernelRefused, refusedAfterMerge);
  const refused = (await call('o11_deliver', { close: { taskId: kernelRefused, reason: 'x' }, authorize: WORDS })).structuredContent;
  assert.equal(refused.code, 'CLOSE_REFUSED'); assert.equal(refused.stage, 'close'); assert.equal(refused.taskId, kernelRefused);
  assert.match(refused.error, /Select the original module/);
  const alreadyId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  writeKernelTask(box.work, alreadyId, { ...refusedAfterMerge, closed: true });
  assert.equal((await call('o11_deliver', { close: { taskId: alreadyId, reason: 'x' }, authorize: WORDS })).content[0].text, 'fechada');
  assert.equal((await call('o11_deliver', { close: { taskId: 'cccccccccccccccccccccccccccccccc', reason: 'x' }, authorize: WORDS })).structuredContent.code, 'CLOSE_TASK_NOT_FOUND');
  assert.equal((await call('o11_deliver', { close: { taskId: REFUSED_ID, reason: 'x' }, module: 'Orders', authorize: WORDS })).structuredContent.code, 'CLOSE_ALONE');
  assert.equal((await call('o11_deliver', { close: { taskId: REFUSED_ID, reason: 'x' }, authorize: '  ' })).structuredContent.code, 'WORDS_REQUIRED');
  assert.equal(box.runAnvil.calls.length, 2, 'only the two closable tasks reached the CLI');
  const lines = fs.readFileSync(path.join(box.local, 'journal', 'o11_deliver.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.filter(l => l.event === 'end').map(l => l.outcome), ['closed', 'refused']);
});

test('closePrevious closes the refused task first, then delivers the corrected job in the same call', async t => {
  const box = setup(t, { handlers: { deliver: closing() } });
  writeKernelTask(box.work, REFUSED_ID, refusedAfterMerge);
  const { call, close } = await serve(box.deps); t.after(close);
  const result = await call('o11_deliver', { module: 'Orders', job: box.job, checks: ['SaveOrder'], closePrevious: REFUSED_ID, authorize: WORDS });
  assert.equal(result.structuredContent.result, 'entregue');
  assert.deepEqual(box.runAnvil.calls.map(c => c.args), [
    ['deliver', '--close', REFUSED_ID, '--reason', 'superseded by a corrected job', '--work', box.work, '--port', '45999'],
    ['deliver', '--module', 'Orders', '--job', box.job, '--checks', 'SaveOrder', '--work', box.work, '--port', '45999', '--close-opened-tab']]);
  const start = JSON.parse(fs.readFileSync(path.join(box.local, 'journal', 'o11_deliver.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(start.closePrevious, REFUSED_ID);
  // a refused task that never reached the module holds nothing: no close, only the delivery
  const early = 'dddddddddddddddddddddddddddddddd';
  writeKernelTask(box.work, early, { writeState: 'not-sent', stage: 'open', error: 'open_module is blocked: dialog' });
  assert.equal((await call('o11_deliver', { module: 'Orders', job: box.job, closePrevious: early, authorize: WORDS })).structuredContent.result, 'entregue');
  assert.deepEqual(box.runAnvil.calls.slice(2).map(c => c.args[1]), ['--module']);
});

test('closePrevious never closes an uncertain task, and a refused close stops the delivery', async t => {
  const refusedByKernel = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const box = setup(t, { handlers: { deliver: closing(refusedByKernel) } });
  const intent = 'ffffffffffffffffffffffffffffffff';
  writeKernelTask(box.work, intent, { moduleKey: 'k1', writeState: 'intent', stage: 'merge' });
  const { call, close } = await serve(box.deps); t.after(close);
  const uncertain = await call('o11_deliver', { module: 'Orders', job: box.job, closePrevious: intent, authorize: WORDS });
  assert.equal(uncertain.isError, true);
  assert.equal(uncertain.structuredContent.outcome, 'uncertain'); assert.equal(uncertain.structuredContent.code, 'PREVIOUS_UNCERTAIN');
  assert.deepEqual(uncertain.structuredContent.continuation, { tool: 'o11_deliver', arguments: { resume: intent }, why: uncertain.structuredContent.continuation.why });
  assert.equal(box.runAnvil.calls.length, 0); assert.equal(box.selected.length, 0);

  writeKernelTask(box.work, refusedByKernel, refusedAfterMerge);
  const stopped = (await call('o11_deliver', { module: 'Orders', job: box.job, closePrevious: refusedByKernel, authorize: WORDS })).structuredContent;
  assert.equal(stopped.code, 'CLOSE_REFUSED'); assert.equal(stopped.taskId, refusedByKernel);
  assert.deepEqual(box.runAnvil.calls.map(c => c.args[1]), ['--close'], 'the new delivery never ran');
  assert.equal((await call('o11_deliver', { resume: intent, closePrevious: refusedByKernel, authorize: WORDS })).structuredContent.code, 'CLOSE_PREVIOUS_FIXED');
});

test('a module held by a refused task answers with the close-and-deliver continuation, the words only as a marker', async t => {
  const box = setup(t, { handlers: { deliver: () => envelopes.moduleHeld } });
  writeKernelTask(box.work, HELD, refusedAfterMerge);
  const { call, close } = await serve(box.deps); t.after(close);
  const held = await call('o11_deliver', { module: 'Orders', job: box.job, checks: ['SaveOrder'], authorize: WORDS });
  const next = held.structuredContent.continuation;
  assert.equal(next.tool, 'o11_deliver');
  assert.deepEqual(next.arguments, { module: 'Orders', job: box.job, checks: ['SaveOrder'], closePrevious: HELD, authorize: WORDS_MARKER });
  assert.match(next.why, /recusada; feche e entregue o job corrigido/);
  assert.ok(!held.content[0].text.includes(WORDS));
  // the marker is never taken for the user's words
  const marker = (await call('o11_deliver', next.arguments)).structuredContent;
  assert.equal(marker.code, 'WORDS_REQUIRED');
  // an inline job is handed back as the file it was saved to
  const inline = (await call('o11_deliver', { module: 'Orders', job: [{ op: 'get', target: 'X' }], authorize: WORDS })).structuredContent.continuation.arguments.job;
  assert.ok(path.isAbsolute(inline) && fs.existsSync(inline) && inline.startsWith(path.join(box.local, 'jobs', 'inline')));
  // a holder whose write is uncertain is resumed, never closed
  writeKernelTask(box.work, HELD, { moduleKey: 'k1', writeState: 'unknown', stage: 'merge', error: 'timed out' });
  assert.deepEqual((await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent.continuation.arguments, { resume: HELD });
  assert.equal(box.runAnvil.calls.length, 3);
});

test('outcome rules and text cleaning', () => {
  assert.equal(deliveryOutcome({ delivered: true, writeState: 'applied' }), 'delivered');
  assert.equal(deliveryOutcome({ writeState: 'intent' }), 'uncertain');
  assert.equal(deliveryOutcome({ writeState: 'applied' }), 'uncertain');
  assert.equal(deliveryOutcome({ writeState: 'applied', validation: { newErrors: 2 } }), 'refused');
  assert.equal(deliveryOutcome({ writeState: 'not-sent', error: 'x' }), 'refused');
  assert.equal(deliveryOutcome({ writeState: 'not-applied' }), 'refused');
  assert.equal(closeState(null), 'missing'); assert.equal(closeState({ closed: true }), 'closed'); assert.equal(closeState({ delivered: true }), 'delivered');
  assert.equal(closeState({ writeState: 'applied', error: 'x' }), 'uncertain', 'applied without a validation result is never closed');
  assert.equal(closeState({ writeState: 'applied', error: 'x', validation: { newErrors: 1 } }), 'refused');
  assert.equal(closeState({ writeState: 'not-sent' }), 'unsettled', 'no recorded failure: the kernel would not close it');
  assert.equal(clean('Bridge refused. Run ssam connect --lane o11 to select it. Then retry; dotnet build src/Anvil.Cli first.'), 'Bridge refused. Then retry;');
  assert.equal(clean('Use a script.ps1 here. Kept.'), 'Kept.');
  assert.equal(clean('x'.repeat(500)).length, 400);
});

// ---- correcting a refused job with a patch (job-patch.mjs) instead of the whole job again
const queue = (...items) => () => items.shift();
const INLINE = box => path.join(box.local, 'jobs', 'inline');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jobUsed = call => call.args[call.args.indexOf('--job') + 1];
const RENAME = [{ op: 'test', path: '/ops/0/target', value: 'ServerAction:SaveOrder' }, { op: 'replace', path: '/ops/0/target', value: 'ServerAction:SaveOrder2' }];

test('every refusal names the job it ran (job, jobSha256); an uncertain one never does', async t => {
  const box = setup(t, { handlers: { deliver: queue(envelopes.refusedBeforeMerge, envelopes.refusedBeforeMerge, envelopes.uncertain, envelopes.argumentError) } });
  const { call, close } = await serve(box.deps); t.after(close);
  const refused = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(refused.code, 'VALIDATION_REFUSED');
  assert.equal(refused.job, box.job); assert.equal(refused.jobSha256, sha256(fs.readFileSync(box.job)));
  assert.equal(refused.continuation, undefined, 'still no catalog of fixes');
  const inline = (await call('o11_deliver', { module: 'Orders', job: [{ op: 'get', target: 'X' }], authorize: WORDS })).structuredContent;
  assert.equal(path.dirname(inline.job), INLINE(box)); assert.equal(inline.jobSha256, sha256(fs.readFileSync(inline.job)));
  // an array job is named as one (its patch paths are /<i>/...); an {ops} job is the default
  assert.equal(inline.jobShape, 'array'); assert.equal(refused.jobShape, undefined);
  const uncertain = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(uncertain.outcome, 'uncertain'); assert.equal(uncertain.job, undefined); assert.equal(uncertain.jobSha256, undefined);
  const start = (await call('o11_deliver', { module: 'Orders', job: box.job, expectedEnvironment: 'https://x', authorize: WORDS })).structuredContent;
  assert.equal(start.code, 'DELIVERY_FAILED'); assert.equal(start.job, box.job);
});

test('a refusal before the CLI also names the job, so an inline job is never sent twice', async t => {
  const box = setup(t, { deps: { assertSelected: async () => { throw new Error('The selected Studio session is no longer connected.'); } } });
  const { call, close } = await serve(box.deps); t.after(close);
  const result = (await call('o11_deliver', { module: 'Orders', job: { ops: [{ op: 'get', target: 'X' }] }, authorize: WORDS })).structuredContent;
  assert.equal(result.code, 'STUDIO_NOT_SELECTED'); assert.equal(path.dirname(result.job), INLINE(box));
  assert.equal(result.jobSha256, sha256(fs.readFileSync(result.job)));
  assert.equal(box.runAnvil.calls.length, 0);
});

test('refused, then corrected with a patch in one call: deliver gets a new file and the base stays intact', async t => {
  const box = setup(t, { handlers: { deliver: queue(envelopes.refusedBeforeMerge, envelopes.delivered, envelopes.delivered) } });
  const original = fs.readFileSync(box.job);
  const { call, close } = await serve(box.deps); t.after(close);
  const refused = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  const patched = await call('o11_deliver', { module: 'Orders', patch: RENAME, basedOn: { job: refused.job, sha256: refused.jobSha256 }, checks: ['SaveOrder2'], authorize: WORDS });
  assert.equal(patched.structuredContent.result, 'entregue');
  const first = jobUsed(box.runAnvil.calls[1]);
  assert.equal(path.dirname(first), INLINE(box)); assert.notEqual(first, box.job);
  assert.deepEqual(box.runAnvil.calls[1].args, ['deliver', '--module', 'Orders', '--job', first, '--checks', 'SaveOrder2', '--work', box.work, '--port', '45999', '--close-opened-tab']);
  assert.deepEqual(readJson(first), { ops: [{ op: 'get', target: 'ServerAction:SaveOrder2' }] }, 'only the ops changed, no field added');
  assert.ok(fs.readFileSync(box.job).equals(original), 'the base is never rewritten');
  // the provenance is in the journal (and the task summary), the words only as their sha256
  const lines = fs.readFileSync(path.join(box.local, 'journal', 'o11_deliver.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const start = lines.filter(l => l.event === 'start')[1];
  assert.equal(start.job, first); assert.equal(start.jobSha256, sha256(fs.readFileSync(first)));
  assert.deepEqual(start.basedOn, { job: box.job, sha256: sha256(original) }); assert.equal(start.patchOps, 2);
  assert.equal(start.wordsSha256, sha256(WORDS)); assert.ok(!JSON.stringify(lines).includes(WORDS));
  // a second attempt on the same base after that delivery (G16, entrega-respostas.test.mjs): the corrected job is in the
  // module, so its base is refused before anything runs; no file is written and the base stays intact
  const again = (await call('o11_deliver', { module: 'Orders', patch: RENAME, basedOn: { job: box.job, sha256: sha256(original) }, authorize: WORDS })).structuredContent;
  assert.equal(again.code, 'BASED_ON_DELIVERED'); assert.equal(again.delivered.job, first);
  assert.equal(box.runAnvil.calls.length, 2); assert.equal(fs.readdirSync(INLINE(box)).length, 1);
  assert.ok(fs.readFileSync(box.job).equals(original));
});

test('closePrevious + patch on basedOn.taskId: the refused task is closed first, then the patched job is delivered (module from the task)', async t => {
  const box = setup(t, { handlers: { deliver: closing() } });
  writeKernelTask(box.work, REFUSED_ID, { ...refusedAfterMerge, request: { Module: 'Orders', JobPath: box.job }, sources: [{ path: box.job, sha256: sha256(fs.readFileSync(box.job)) }] });
  const { call, close } = await serve(box.deps); t.after(close);
  const result = await call('o11_deliver', { patch: RENAME, basedOn: { taskId: REFUSED_ID }, closePrevious: REFUSED_ID, authorize: WORDS });
  assert.equal(result.structuredContent.result, 'entregue', result.content[0].text);
  const used = jobUsed(box.runAnvil.calls[1]);
  assert.deepEqual(box.runAnvil.calls.map(c => c.args), [
    ['deliver', '--close', REFUSED_ID, '--reason', 'superseded by a corrected job', '--work', box.work, '--port', '45999'],
    ['deliver', '--module', 'Orders', '--job', used, '--work', box.work, '--port', '45999', '--close-opened-tab']]);
  assert.equal(readJson(used).ops[0].target, 'ServerAction:SaveOrder2');
  const start = JSON.parse(fs.readFileSync(path.join(box.local, 'journal', 'o11_deliver.jsonl'), 'utf8').split('\n')[0]);
  assert.deepEqual(start.basedOn, { job: box.job, sha256: sha256(fs.readFileSync(box.job)), taskId: REFUSED_ID });
  assert.equal(start.closePrevious, REFUSED_ID); assert.equal(start.module, 'Orders');
});

test('an uncertain base task is never patched (resume), and a bad patch, base or combination runs nothing', async t => {
  const box = setup(t);
  writeKernelTask(box.work, HELD, { moduleKey: 'k1', writeState: 'unknown', stage: 'merge', error: 'timed out', request: { Module: 'Orders', JobPath: box.job },
    sources: [{ path: box.job, sha256: sha256(fs.readFileSync(box.job)) }] });
  const { call, close } = await serve(box.deps); t.after(close);
  const uncertain = (await call('o11_deliver', { module: 'Orders', patch: RENAME, basedOn: { taskId: HELD }, authorize: WORDS })).structuredContent;
  assert.deepEqual([uncertain.outcome, uncertain.code, uncertain.taskId], ['uncertain', 'BASE_UNCERTAIN', HELD]);
  assert.deepEqual(uncertain.continuation.arguments, { resume: HELD }); assert.equal(uncertain.job, undefined);
  const basedOn = { job: box.job, sha256: sha256(fs.readFileSync(box.job)) };
  const code = async args => (await call('o11_deliver', { authorize: WORDS, ...args })).structuredContent;
  assert.equal((await code({ resume: HELD, patch: RENAME, basedOn })).code, 'RESUME_FIXED');
  assert.equal((await code({ close: { taskId: HELD, reason: 'x' }, patch: RENAME, basedOn })).code, 'CLOSE_ALONE');
  // job + basedOn is a partial job now (patch-por-nome); a partial job that is not one (a composite) is refused before anything runs
  assert.equal((await code({ module: 'Orders', job: { jobs: ['job:a'] }, patch: RENAME, basedOn })).code, 'PARTIAL_INVALID');
  assert.match((await code({ module: 'Orders', patch: RENAME })).error, /patch needs basedOn/);
  assert.match((await code({ module: 'Orders', basedOn })).error, /basedOn goes with patch/);
  assert.equal((await code({ patch: RENAME, basedOn })).code, 'MODULE_AND_JOB_REQUIRED');
  const missing = await code({ module: 'Orders', patch: RENAME, basedOn: { taskId: 'cccccccccccccccccccccccccccccccc' } });
  assert.equal(missing.code, 'BASE_NOT_FOUND'); assert.equal(missing.continuation.tool, 'ssam_task');
  const failedTest = await code({ module: 'Orders', patch: [{ op: 'test', path: '/ops/0/target', value: 'Other' }], basedOn });
  assert.deepEqual([failedTest.code, failedTest.at, failedTest.continuation.tool], ['PATCH_TEST_FAILED', 0, 'o11_deliver']);
  assert.equal((await code({ module: 'Orders', patch: [{ op: 'add', path: '/base', value: 'x.oml' }], basedOn })).code, 'PATCH_PATH_FORBIDDEN');
  // the schema already refuses an op outside the subset
  const move = await call('o11_deliver', { module: 'Orders', patch: [{ op: 'move', path: '/ops/0', from: '/ops/1' }], basedOn, authorize: WORDS });
  assert.equal(move.isError, true);
  // a base changed after the refusal: deliver it as it is, or send the whole job; its new sha256 is never handed back
  const changed = await code({ module: 'Orders', patch: RENAME, basedOn: { job: box.job, sha256: 'ab'.repeat(32) } });
  assert.equal(changed.code, 'BASE_CHANGED'); assert.equal(changed.jobSha256, undefined);
  assert.deepEqual(changed.continuation.arguments, { module: 'Orders', job: box.job, authorize: WORDS_MARKER });
  assert.doesNotMatch(JSON.stringify(changed), SHELL);
  // The rest of the call stays: until=apply is still only a validation; checks, producers, environment and closePrevious too.
  const stale = { patch: RENAME, basedOn: { job: box.job, sha256: 'ab'.repeat(32) }, checks: ['SaveOrder2'], producers: { Lib: path.join(box.base, 'lib.oml') },
    expectedEnvironment: 'h.test' };
  assert.deepEqual((await code({ module: 'Orders', ...stale, until: 'apply' })).continuation.arguments,
    { module: 'Orders', job: box.job, checks: ['SaveOrder2'], producers: stale.producers, expectedEnvironment: 'h.test', until: 'apply', authorize: WORDS_MARKER });
  writeKernelTask(box.work, REFUSED_ID, { ...refusedAfterMerge, request: { Module: 'Orders', JobPath: box.job } });
  const withClose = await code({ module: 'Orders', ...stale, closePrevious: REFUSED_ID });
  assert.equal(withClose.code, 'BASE_CHANGED');
  assert.deepEqual(withClose.continuation.arguments, { module: 'Orders', job: box.job, checks: ['SaveOrder2'], producers: stale.producers, expectedEnvironment: 'h.test',
    closePrevious: REFUSED_ID, authorize: WORDS_MARKER });
  assert.doesNotMatch(JSON.stringify(withClose), new RegExp(WORDS));
  assert.equal(box.runAnvil.calls.length, 0); assert.equal(box.selected.length, 0);
  assert.equal(fs.existsSync(INLINE(box)), false, 'no refused patch wrote a file');
});

test('failedOp only when the kernel names an op of this job', async t => {
  const refusedAt = error => ({ ok: false, command: 'deliver', elapsedMs: 900,
    data: { taskId: '7a8b9c0d1e2f30415263748596a7b8c9', module: 'Orders', delivered: false, writeState: 'not-sent', stage: 'apply', error } });
  const box = setup(t, { handlers: { deliver: queue(
    refusedAt("op #0 (get ): InvalidOperationException: no element 'ServerAction:SaveOrder'"),
    refusedAt('op #0 (set Name): InvalidOperationException: another op'),
    { ok: false, command: 'deliver', elapsedMs: 30, error: 'InvalidOperationException: op #0 (get ): InvalidOperationException: bad target', stack: 'at Anvil' },
    envelopes.refusedBeforeMerge) } });
  const { call, close } = await serve(box.deps); t.after(close);
  const named = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  assert.deepEqual([named.code, named.stage, named.failedOp, named.job], ['DELIVERY_FAILED', 'apply', 0, box.job]);
  const other = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(other.failedOp, undefined, 'op 0 of this job is a get, not a set');
  const start = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  assert.deepEqual([start.stage, start.failedOp], ['start', 0]);
  const validation = (await call('o11_deliver', { module: 'Orders', job: box.job, authorize: WORDS })).structuredContent;
  assert.equal(validation.failedOp, undefined, 'validation messages name elements, not ops');
});

test('a delivered integration job answers its integration reports, at most 10 plus integrationTotal (contract I7)', () => {
  const integration = Array.from({ length: 12 }, (_, i) => ({ op: 'rest', client: { name: 'Api' + i, key: 'k' + i, created: true }, imported: [], skipped: [], updated: [], removed: [], consumersBroken: [], warnings: [] }));
  const value = deliverOutcome({ envelope: { data: { delivered: true, integration } } }, { trackId: 't', work: os.tmpdir(), job: null });
  assert.equal(value.ok, true); assert.equal(value.result, 'entregue');
  assert.deepEqual(value.integration, integration.slice(0, 10)); assert.equal(value.integrationTotal, 12);
  // A job without integration ops answers no integration field.
  assert.equal(deliverOutcome({ envelope: { data: { delivered: true } } }, { trackId: 't', work: os.tmpdir(), job: null }).integration, undefined);
});