import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { codePlan, batchItems, signatureOf, planSize, KIND_BYTES, PLAN_MIN_ITEMS, PACKET_TARGET_BYTES } from '../code-plan.mjs';
import { codeCheck } from '../code-check.mjs';
import { registerSsamCode, headerOf, splitActions, writeCall } from '../ssam-code.mjs';
import { moduleDigest } from '../module-map.mjs';
import { DIGEST_EXTRACTOR, DIGEST_SECTIONS } from '../module-digest.mjs';
import { modelSha256 } from '../o11-capture-store.mjs';
import { workPacket } from '../work-packet.mjs';
import { isWrite } from '../studio-write-lock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../../../..');
const fixtureRoot = path.join(workspace, 'kernel/tests/fixtures');
const acceptanceRoot = path.join(workspace, '.local/x1/fixtures');
const reportRoot = path.join(workspace, '.local/x1');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = text => createHash('sha256').update(text).digest('hex');
const bytes = text => Buffer.byteLength(text, 'utf8');
const values = result => result.structuredContent ?? JSON.parse(result.content[0].text);
const names = items => items.map(item => typeof item === 'string' ? item : item.name);
const flow = (name, calls = []) => `server action ${name}\n${calls.map(name => `  ${name}()\n`).join('')}  end\n`;
const action = (name, calls = []) => ({ kind: 'action', name, intent: `Implement ${name}`, signature: `server action ${name}`, calls });
function tmp(t) {
  const parent = path.join(workspace, '.local/x1-tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'plan-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}
function put(dir, name, text) {
  const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text); return file;
}
function metric(t, name, value) {
  fs.mkdirSync(reportRoot, { recursive: true });
  fs.writeFileSync(path.join(reportRoot, `test-${name}.json`), JSON.stringify(value, null, 2));
  t.diagnostic(JSON.stringify(value));
}
function digestOf(lane = 'o11', module = 'Neutral') {
  return { schema: 'ssam-digest/1', extractor: DIGEST_EXTRACTOR, adapter: 'kernel', lane,
    sourceSha256: 'a'.repeat(64), module: { name: module, key: 'R0', kind: 'Service' }, actions: [],
    sections: DIGEST_SECTIONS.map(id => ({ id, title: id, count: 0, blocks: [] })) };
}
function fakeDeps(dir, lane = 'o11') {
  const base = put(dir, 'base.oml', 'fake capture');
  return { root: dir, local: path.join(dir, 'local'), odcRoot: path.join(dir, 'odc'),
    now: () => 1791849600000,
    newestCapture: () => ({ path: base, sha256: sha('fake capture'), model: sha('fake capture'), at: '2026-10-13T00:00:00.000Z', ageSeconds: 0 }),
    moduleDigest: async () => ({ ok: true, digest: digestOf(lane) }) };
}
const estimate = item => KIND_BYTES[item.kind] + bytes(item.intent ?? '') + bytes(item.signature ?? '');
const edges = items => items.flatMap(a => (a.calls ?? []).map(b => [a.name, b]));
function score(parts, graph) {
  const owner = new Map(parts.flatMap((part, i) => part.map(item => [item.name, i])));
  return graph.filter(([a, b]) => owner.has(a) && owner.has(b) && owner.get(a) !== owner.get(b)).length;
}
function partitions(items, n, prefix = []) {
  if (n === 1) return [[...prefix, items]];
  const result = [];
  for (let cut = 1; cut <= items.length - n + 1; cut++) result.push(...partitions(items.slice(cut), n - 1, [...prefix, items.slice(0, cut)]));
  return result;
}

test('P0 one refusal reports invalid input, missing capture and every cross-batch signature', async t => {
  const dir = tmp(t), deps = fakeDeps(dir);
  const items = [action('First', ['Second', 'Third']), { kind: 'action', name: 'Second', intent: 'Implement Second' },
    { kind: 'action', name: 'Third', intent: 'Implement Third' }, { kind: 'unknown', name: 'Invalid', intent: '' }];
  const result = await codePlan({ lane: 'o11', module: 'Neutral', items, workers: 3 }, { ...deps, newestCapture: () => null });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => p.code === 'CAPTURE_MISSING'));
  assert.ok(result.problems.some(p => p.code === 'INPUT_INVALID'));
  assert.deepEqual(result.problems.filter(p => p.code === 'SIGNATURE_NEEDED').map(p => p.item), ['Second', 'Third']);
  assert.equal(result.continuation.tool, 'ssam_map');
  for (const item of [{ ...action('WrongKind'), signature: '<screen name="WrongKind">' },
    { kind: 'block', name: 'WrongOwner', intent: '', signature: '<screen name="WrongOwner">' },
    { ...action('WrongName'), signature: 'server action OtherName' }]) {
    const refusal = await codePlan({ lane: 'o11', module: 'Neutral', items: [item] }, deps);
    assert.ok(refusal.problems.some(p => p.code === 'INPUT_INVALID' && p.at === 'items/0/signature'), JSON.stringify(refusal));
  }
});

test('P6 exact context uses FK/type neighbours, explicit calls and complete recoverable cuts', async t => {
  const dir = tmp(t), deps = fakeDeps(dir), digest = digestOf();
  const section = id => digest.sections.find(section => section.id === id);
  section('entities').blocks = [
    { key: 'E1', kind: 'ServerEntity', name: 'Order', text: 'entity Order @E1\n  CustomerId: Customer Identifier ->Customer' },
    { key: 'E2', kind: 'ServerEntity', name: 'Customer', text: 'entity Customer @E2\n  Name: Text' },
    { key: 'E3', kind: 'ServerEntity', name: 'Unrelated', text: 'entity Unrelated @E3\n  Secret: Text' },
  ];
  section('structures').blocks = [{ key: 'T1', kind: 'Structure', name: 'OrderResult', text: 'structure OrderResult @T1\n  Total: Decimal' }];
  digest.actions = [{ key: 'A1', kind: 'ServerAction', name: 'ExistingLookup', in: 'Id: Integer', out: 'Result: OrderResult', calls: [], calledBy: [] }];
  section('actions').blocks = [{ key: 'A1', kind: 'ServerAction', name: 'ExistingLookup', text: 'server action ExistingLookup\n  BodyShouldNotBeIncluded()\n  end' }];
  deps.moduleDigest = async () => ({ ok: true, digest });
  const plan = await codePlan({ lane: 'o11', module: 'Neutral', items: [{ ...action('NewLookup', ['ExistingLookup']), intent: 'Use Order for lookup' }] }, deps);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const saved = read(path.join(plan.dir, 'plan.json')), context = saved.sections[1].module;
  for (const name of ['Order', 'Customer', 'ExistingLookup', 'OrderResult']) assert.ok(context.includes(name), name + ': ' + context);
  assert.ok(!context.includes('Unrelated') && !context.includes('BodyShouldNotBeIncluded'));
  const huge = await codePlan({ lane: 'o11', module: 'Neutral', items: [{ ...action('LargeWork'), intent: 'x'.repeat(30000) }] }, deps);
  assert.equal(huge.ok, true, JSON.stringify(huge));
  const record = read(path.join(huge.dir, 'plan.json')), prompt = fs.readFileSync(huge.batches[0].promptFile, 'utf8');
  assert.ok(bytes(prompt) <= PACKET_TARGET_BYTES);
  assert.ok(record.measurements[0].cuts.includes('work'));
  for (const cut of record.measurements[0].cuts) {
    assert.ok(prompt.includes(`## ${cut} (cut)`)); assert.ok(prompt.includes(path.join(huge.dir, 'plan.json')));
    assert.ok(record.sections[1][cut], cut);
  }
  const signature = signatureOf('<block name="Widget"><input name="Value" type="Text"/><input id="editor" bind="Value"/><style>.large{color:red}</style></block>');
  assert.ok(signature.includes('name="Value"')); assert.ok(!signature.includes('id="editor"')); assert.ok(!signature.includes('<style'));
});

test('P1 seeded families: bounds, order, owner cohesion, feasible ceiling and exhaustive minimum cut', () => {
  const equal = Array.from({ length: 4 }, (_, i) => ({ kind: 'action', name: `Equal${i}`, intent: '' }));
  assert.deepEqual(batchItems(equal, { workers: 3 }).map(batch => batch.items.length), [1, 1, 2], 'equal balance chooses the earliest cuts without floating-point drift');
  let seed = 0x51a73;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let n = 1; n <= 40; n++) for (let repetition = 0; repetition < 4; repetition++) {
    const items = Array.from({ length: n }, (_, i) => ({ ...action(`Neutral${i}`),
      kind: ['action', 'screen', 'block'][Math.floor(random() * 3)], intent: 'x'.repeat(Math.floor(random() * 300)) }));
    for (const item of items) item.calls = items.filter(other => other !== item && random() < .08).map(other => other.name);
    const workers = 1 + Math.floor(random() * Math.min(n, 8));
    const batches = batchItems(items, { workers });
    assert.equal(batches.length, workers);
    assert.deepEqual(batches.flatMap(batch => batch.items), items);
    assert.ok(batches.every(batch => batch.items.length > 0));
    const total = items.reduce((sum, item) => sum + estimate(item), 0), ceiling = 1.25 * total / workers;
    const prefix = [0]; for (const item of items) prefix.push(prefix.at(-1) + estimate(item));
    const possible = Array.from({ length: workers + 1 }, () => Array(n + 1).fill(false)); possible[0][0] = true;
    for (let k = 1; k <= workers; k++) for (let end = k; end <= n; end++) {
      possible[k][end] = Array.from({ length: end }, (_, start) => start).some(start => possible[k - 1][start] && prefix[end] - prefix[start] <= ceiling + 1e-8);
    }
    if (possible[workers][n]) assert.ok(batches.every(batch => batch.items.reduce((sum, item) => sum + estimate(item), 0) <= ceiling + 1e-8));
    if (n <= 10) {
      const feasible = partitions(items, workers).filter(parts => parts.every(part => part.reduce((sum, item) => sum + estimate(item), 0) <= ceiling + 1e-8));
      if (feasible.length) {
        assert.ok(batches.every(batch => batch.items.reduce((sum, item) => sum + estimate(item), 0) <= ceiling + 1e-8));
        assert.equal(score(batches.map(batch => batch.items), edges(items)), Math.min(...feasible.map(parts => score(parts, edges(items)))), `n=${n}, workers=${workers}`);
      }
    }
    const automatic = batchItems(items, {});
    assert.ok(automatic.length >= 1 && automatic.length <= Math.min(8, n));
  }
  for (let n = 1; n <= 12; n++) {
    const items = Array.from({ length: n }, (_, i) => [
      { kind: i % 2 ? 'screen' : 'block', name: `Owner${i}`, intent: 'render', signature: `<block name="Owner${i}">` },
      action(`Owner${i}.Save`), action(`Owner${i}.Load`),
    ]).flat();
    const batches = batchItems([{ kind: 'data', name: 'Shape', intent: 'type Shape' }, ...items], {});
    assert.deepEqual(batches.flatMap(batch => batch.items), items);
    assert.ok(batches.length <= Math.min(8, n));
    for (const owner of items.filter(item => item.kind !== 'action')) {
      const batch = batches.find(batch => names(batch.items).includes(owner.name));
      assert.ok(names(batch.items).includes(owner.name + '.Save') && names(batch.items).includes(owner.name + '.Load'));
    }
  }
});

test('P2 trigger corpus and grammar/write guidance never blocks a large direct write', async () => {
  const corpus = [['create 6 actions', 6], ['criar 8 blocos', 8], ['build 12 screens', 12], ['criar 5 telas', 5], ['create 1 action', 1],
    ['actions: Save, Load, Close, Open, Send, Reset', 6], ['blocos: Um, Dois e Tres', 3], ['Create actions for saving and loading records', 0],
    ['Implement AlphaOne, BetaTwo, GammaThree, DeltaFour, EpsilonFive, ZetaSix', 6]];
  for (const [intent, count] of corpus) {
    assert.equal(planSize(intent, digestOf()), count, intent);
    const packet = workPacket({ lane: 'o11', intent, matches: [], categories: new Map(), module: { ok: true, digest: digestOf(), module: { name: 'Neutral' } } });
    assert.equal(Boolean(packet.next.plan), count >= PLAN_MIN_ITEMS, intent);
  }
  let handler, delivered = 0, planned = 0;
  registerSsamCode({ registerTool: (_name, _schema, fn) => { handler = fn; } }, {
    fromJsonSchema: value => value,
    deliver: async () => { delivered++; return { structuredContent: { ok: true } }; },
    plan: async input => { planned++; return { ok: true, action: 'plan', items: input.items }; },
  });
  assert.ok(values(await handler({ lane: 'o11', action: 'grammar', part: 'logic' })).plan);
  const result = values(await handler({ lane: 'o11', action: 'write', module: 'Neutral', text: Array.from({ length: 40 }, (_, i) => flow('Neutral' + i)).join('\n') }));
  assert.equal(delivered, 1); assert.equal(result.ok, true); assert.ok(result.plan);
  const html = values(await handler({ lane: 'o11', action: 'write', module: 'Neutral', also: Array.from({ length: 6 }, (_, i) => ({ part: 'html', text: `<screen name="NeutralScreen${i}"></screen>` })) }));
  assert.equal(html.ok, true); assert.ok(html.plan);
  const six = values(await handler({ lane: 'o11', action: 'write', module: 'Neutral', text: Array.from({ length: 6 }, (_, i) => flow('New' + i)) }));
  assert.equal(six.ok, true); assert.ok(six.plan);
  const edits = values(await handler({ lane: 'o11', action: 'write', module: 'Neutral', text: Array.from({ length: 6 }, (_, i) => `server action Existing${i} @ExistingKey${i}\n  end\n`) }));
  assert.equal(edits.ok, true); assert.ok(!edits.plan);
  const dispatched = values(await handler({ lane: 'o11', action: 'plan', module: 'Neutral', items: [action('NewOne')] }));
  assert.equal(planned, 1); assert.equal(dispatched.action, 'plan');
  const beforeInvalid = delivered;
  const refused = values(await handler({ lane: 'o11', action: 'write', module: 'Neutral', stubs: ['x.flow'], text: flow('Neutral') }));
  assert.equal(refused.code, 'INPUT_INVALID'); assert.equal(delivered, beforeInvalid);
  for (const extra of [{ items: [action('NewOne')] }, { workers: 2 }, { shared: ['data.ddl'] }]) {
    const invalid = values(await handler({ lane: 'o11', action: 'write', module: 'Neutral', text: flow('Neutral'), ...extra }));
    assert.equal(invalid.code, 'INPUT_INVALID'); assert.equal(delivered, beforeInvalid);
  }
  assert.equal(isWrite('ssam_code', { action: 'plan' }), false);
});

test('P3 stub order, a single logic op, stable input indices and refusal origins', async t => {
  const dir = tmp(t), base = put(dir, 'base.oml', 'capture');
  const stub = put(dir, 'stub.flow', flow('Dependency'));
  const code = put(dir, 'batch.flow', flow('Caller', ['Dependency']));
  let seen;
  const result = await codeCheck({ lane: 'o11', module: 'Neutral', base, files: [code], stubs: [stub] }, {
    root: dir, local: dir, runJob: async request => {
      seen = read(request.job);
      return { ok: false, problems: seen.ops[0].data.flow.map((text, i) => ({ code: 'TEST', pointer: `/ops/0/data/flow/${i}`, message: headerOf(text).name })) };
    }, guidance: async (_lane, _job, value) => value,
  });
  assert.equal(seen.ops.length, 1);
  assert.deepEqual(seen.ops[0].data.flow.map(text => headerOf(text).name), ['Dependency', 'Caller']);
  assert.deepEqual(result.problems.map(p => [p.origin.at, p.origin.file]), [['stubs/0', stub], ['files/0', code]]);
  const missing = path.join(dir, 'missing.flow');
  const invalid = await codeCheck({ lane: 'o11', module: 'Neutral', base, files: [code], stubs: [missing] }, { root: dir, local: dir });
  assert.ok(invalid.problems.some(p => p.origin?.at === 'stubs/0' && p.origin?.file === missing), JSON.stringify(invalid));
});

test('P6/P7 compact file prompts and deterministic plan in a fresh process', async t => {
  const dir = tmp(t), deps = fakeDeps(dir), items = Array.from({ length: 24 }, (_, i) => action(`Neutral${i}`, i < 23 ? [`Neutral${i + 1}`] : []));
  const input = { lane: 'o11', module: 'Neutral', items, workers: 4 };
  const before = JSON.stringify(input);
  const first = await codePlan(input, deps), second = await codePlan(input, deps);
  assert.equal(first.ok, true, JSON.stringify(first)); assert.deepEqual(first, second); assert.equal(JSON.stringify(input), before);
  const files = fs.readdirSync(first.dir).filter(name => /prompt|stubs|plan\.json/.test(name));
  const snapshot = Object.fromEntries(files.map(name => [name, fs.readFileSync(path.join(first.dir, name), 'utf8')]));
  const script = `import {codePlan} from ${JSON.stringify(pathToFileURL(path.join(here, '../code-plan.mjs')).href)};\nconst input=${JSON.stringify(input)};const deps=${JSON.stringify({ root: deps.root, local: deps.local, odcRoot: deps.odcRoot })};deps.newestCapture=()=>(${JSON.stringify(deps.newestCapture())});deps.moduleDigest=async()=>(${JSON.stringify(await deps.moduleDigest())});process.stdout.write(JSON.stringify(await codePlan(input,deps)));`;
  const spawned = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: process.env, windowsHide: true });
  assert.equal(spawned.status, 0, spawned.stderr); assert.deepEqual(JSON.parse(spawned.stdout), first);
  for (const [name, text] of Object.entries(snapshot)) assert.equal(fs.readFileSync(path.join(first.dir, name), 'utf8'), text, name);
  const changed = await codePlan({ ...input, workers: 3 }, deps); assert.notEqual(changed.planId, first.planId);
  assert.ok(!first.final.arguments.stubs);
  assert.ok(!/server action/.test(JSON.stringify(first.batches.map(batch => batch.launchPrompt))));
  for (const batch of first.batches) {
    const text = fs.readFileSync(batch.promptFile, 'utf8');
    assert.equal(batch.promptBytes, bytes(text)); assert.ok(batch.promptBytes <= PACKET_TARGET_BYTES, `${batch.id}: ${batch.promptBytes}`);
    assert.equal(batch.check.arguments.base, first.capture.path);
    assert.ok(batch.launchPrompt.includes(batch.promptFile)); assert.ok(!batch.launchPrompt.includes('\n'));
    assert.match(text, /ssam_discover\/ssam_map\/ssam_code read|ssam_discover.*ssam_map.*ssam_code read/);
  }
  metric(t, 'bytes', { responseBytes: bytes(JSON.stringify(first)), formerBytesPerAgent: [143 * 1024, 195 * 1024], batches: first.batches.map(batch => ({ id: batch.id, bytes: batch.promptBytes })), measurements: read(path.join(first.dir, 'plan.json')).measurements });
});

const CLI = { o11: process.env.SSAM_CODE_CLI_O11, odc: process.env.SSAM_CODE_CLI_ODC };
const gate = lane => !CLI[lane] || !fs.existsSync(path.join(CLI[lane], lane === 'o11' ? 'anvil.dll' : 'anvil-odc.dll')) ? `${lane} CLI not supplied` : false;
function cliDeps(lane, dir) {
  put(dir, '.local/lane-odc/cli/anvil-odc.dll', 'runner injected');
  const temp = path.join(dir, 'tmp'); fs.mkdirSync(temp, { recursive: true });
  // The ODC feature cache the lane CLI reads: the run's ANVIL_ODC_FEATURES_DIR (a private Features.xml) when it is set, else a
  // copy of the CX5 one when that worktree is beside this one, else the CLI's own lookup.
  let features = process.env.ANVIL_ODC_FEATURES_DIR || null;
  const source = path.resolve(workspace, '../cx-autochecagem/.local/cx5/features/Features.xml');
  if (!features && lane === 'odc' && fs.existsSync(source)) {
    features = path.join(workspace, '.local/x1/features');
    fs.mkdirSync(features, { recursive: true });
    fs.copyFileSync(source, path.join(features, 'Features.xml'));
  }
  const env = { ...process.env, TEMP: temp, TMP: temp, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_NO_WARM: '1',
    ANVIL_STUDIO_DIR: path.resolve(workspace, '../../OutSystems/Service Studio 11 - Anvil 4516/Service Studio'),
    ANVIL_ODC_STUDIO_DIR: 'C:/Program Files/OutSystems/ODC Studio/ODC Studio',
    SSAM_MODULE_INDEX_ROOT: path.join(dir, 'module-index'), SSAM_READER_CACHE_ROOT: path.join(dir, 'readers'), ...(features ? { ANVIL_ODC_FEATURES_DIR: features } : {}) };
  const deps = { root: dir, local: path.join(dir, 'local'), odcRoot: path.join(dir, 'odc'), env,
    guidance: async (_lane, _job, result) => result };
  deps.runAnvil = (args, options = {}) => new Promise(resolve => {
    const start = Date.now();
    execFile('dotnet', [path.join(CLI[lane], lane === 'o11' ? 'anvil.dll' : 'anvil-odc.dll'), ...args], {
      cwd: options.cwd, env, timeout: 900000, maxBuffer: 1 << 28, windowsHide: true,
    }, (error, stdout, stderr) => {
      let envelope; try { envelope = JSON.parse(stdout); } catch { envelope = { ok: false, error: stdout + stderr }; }
      resolve({ ok: !error && envelope.ok, exitCode: error?.code ?? 0, envelope, stderr: stderr ? [stderr] : [], wallMs: Date.now() - start });
    });
  });
  // Use the same kernel digest/store, through its cold CLI; no live reader, Studio, or authority key is needed.
  deps.moduleDigest = input => moduleDigest(input, { env, read: async ({ request }) => {
    const result = await deps.runAnvil(['digest', '--oml', request.file, '--work', path.join(dir, 'digest-work')]);
    if (!result.ok) throw new Error(result.envelope.error ?? JSON.stringify(result.envelope));
    return { digest: result.envelope.data };
  } });
  return deps;
}
function fillPlan(plan, texts, data) {
  if (plan.data) fs.writeFileSync(plan.data.file, data);
  for (const batch of plan.batches) for (const file of batch.files) {
    const html = /\.html$/.test(file);
    const selected = names(batch.items).filter(name => texts[name] && /^\s*(?:<|\/\/\/[^]*?\n<)/.test(texts[name]) === html);
    fs.writeFileSync(file, selected.map(name => texts[name]).join('\n'));
  }
}
async function checks(plan, deps) {
  const start = Date.now();
  const parallel = await Promise.all(plan.batches.map(batch => codeCheck(batch.check.arguments, deps)));
  const parallelMs = Date.now() - start, serialStart = Date.now(), serial = [];
  for (const batch of plan.batches) serial.push(await codeCheck(batch.check.arguments, deps));
  return { parallelMs, serialMs: Date.now() - serialStart, parallel, serial };
}
function actionItems(texts) {
  const qualified = text => { const h = headerOf(text); return h.owner ? `${h.owner}.${h.name}` : h.name; };
  const names = texts.map(qualified);
  return texts.map(text => ({ kind: 'action', name: qualified(text), intent: /^\/\/\/\s*(.*)$/m.exec(text)?.[1] ?? '', signature: signatureOf(text),
    calls: names.filter(name => {
      if (name === qualified(text)) return false;
      const h = headerOf(text), simple = h.owner && name.startsWith(h.owner + '.') ? name.slice(h.owner.length + 1) : name;
      return [name, simple].some(value => new RegExp(`(?<![\\w.])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(text));
    }) }));
}

for (const lane of ['o11', 'odc']) test(`P3 ${lane} only a cross-batch stub resolves the call`, { skip: gate(lane), timeout: 900000 }, async t => {
  const dir = tmp(t), deps = cliDeps(lane, dir), base = path.join(fixtureRoot, lane === 'o11' ? 'blank-service.oml' : 'odc/blank-mobile.oml');
  const stub = put(dir, 'stub.flow', flow('NeutralDependency')), file = put(dir, 'batch.flow', flow('NeutralCaller', ['NeutralDependency']));
  const input = { lane, module: 'Neutral', base, files: [file] };
  const withStub = await codeCheck({ ...input, stubs: [stub] }, deps), without = await codeCheck(input, deps);
  assert.equal(withStub.ok, true, JSON.stringify(withStub));
  assert.ok(without.problems.some(p => p.code === 'FLOW_NAME_UNKNOWN' && p.origin?.file === file), JSON.stringify(without));
});

test('P4 Tickets: accepted texts, 3–4 batches, checks and exact final job', { skip: gate('o11'), timeout: 900000 }, async t => {
  const dir = tmp(t), deps = cliDeps('o11', dir), original = read(path.join(here, 'fixtures/caso-tickets/2549ac63.json'));
  const file = fs.readdirSync(acceptanceRoot).find(name => /^DemoFabio_CS-.*\.oml$/i.test(name)); assert.ok(file, 'Tickets capture is required');
  const base = path.join(acceptanceRoot, file); assert.match(modelSha256(base), /^ad21f528/);
  const acceptedBase = 'C:/Users/andre/SSAM-Hybrid-proto/kernel/.local/work/deliver/836443837b61450b9b7ede4ad0a7afd0/attempt-0/base.oml';
  assert.ok(fs.existsSync(acceptedBase), 'accepted receipt base must exist'); assert.match(modelSha256(acceptedBase), /^ad21f528/);
  fs.mkdirSync(path.join(deps.local, 'producer-cache'), { recursive: true });
  for (const name of fs.readdirSync(acceptanceRoot).filter(name => /^e30787d7/.test(name))) fs.copyFileSync(path.join(acceptanceRoot, name), path.join(deps.local, 'producer-cache', name));
  const texts = original.ops[3].data.flow.flatMap(text => splitActions(text) ?? [text]), items = actionItems(texts);
  const shared = [path.join(here, 'fixtures/caso-tickets/ops.json')];
  const plan = await codePlan({ lane: 'o11', module: 'DemoFabio_CS', base, items: [{ kind: 'data', name: 'TicketDashboardSummary', intent: 'summary structure' }, ...items], shared }, deps);
  assert.equal(plan.ok, true, JSON.stringify(plan)); assert.ok(plan.batches.length >= 3 && plan.batches.length <= 4, JSON.stringify(plan));
  fillPlan(plan, Object.fromEntries(items.map((item, i) => [item.name, texts[i]])), original.ops[0].data.ddl);
  assert.deepEqual(writeCall(plan.final.arguments).arguments.job.ops, original.ops);
  const measured = await checks(plan, deps);
  const controls = await Promise.all(plan.batches.map(batch => codeCheck({ ...batch.check.arguments, stubs: [] }, deps)));
  const itemByName = new Map(items.map(item => [item.name, item]));
  const crossing = score(plan.batches.map(batch => batch.items.map(name => itemByName.get(name))), edges(items));
  // An optimal default plan can eliminate every crossing. A constrained eight-worker plan supplies the negative control.
  const constrained = await codePlan({ lane: 'o11', module: 'DemoFabio_CS', base, items: [{ kind: 'data', name: 'TicketDashboardSummary', intent: 'summary structure' }, ...items], shared, workers: 8 }, deps);
  assert.equal(constrained.ok, true, JSON.stringify(constrained));
  fillPlan(constrained, Object.fromEntries(items.map((item, i) => [item.name, texts[i]])), original.ops[0].data.ddl);
  const crossingBatches = constrained.batches.filter(batch => batch.check.arguments.stubs?.length);
  const forcedWith = await Promise.all(crossingBatches.map(batch => codeCheck(batch.check.arguments, deps)));
  const forcedWithout = await Promise.all(crossingBatches.map(batch => codeCheck({ ...batch.check.arguments, stubs: [] }, deps)));
  metric(t, 'tickets', { N: plan.batches.length, responseBytes: bytes(JSON.stringify(plan)), dataPromptBytes: plan.data?.promptBytes, edges: crossing, batches: plan.batches.map(batch => ({ id: batch.id, items: names(batch.items), promptBytes: batch.promptBytes, stubs: batch.check.arguments.stubs ?? [] })), ...measured, controls,
    measurements: read(path.join(plan.dir, 'plan.json')).measurements, finalEqual: true, forcedControl: { N: constrained.batches.length, batches: crossingBatches.map(batch => batch.id), withStubs: forcedWith, withoutStubs: forcedWithout } });
  assert.ok(measured.parallel.every(result => result.ok), JSON.stringify(measured.parallel));
  assert.ok(measured.serial.every(result => result.ok), JSON.stringify(measured.serial));
  if (crossing) assert.ok(controls.some(result => result.problems?.some(p => p.code === 'FLOW_NAME_UNKNOWN')), JSON.stringify(controls));
  else assert.ok(controls.every(result => result.ok), JSON.stringify(controls));
  assert.ok(forcedWith.length > 0 && forcedWith.every(result => result.ok), JSON.stringify(forcedWith));
  assert.ok(forcedWithout.some(result => result.problems?.some(p => p.code === 'FLOW_NAME_UNKNOWN')), JSON.stringify(forcedWithout));
  assert.ok(!/EBUSY/.test(JSON.stringify(measured)));
});

test('P5 eight blocks: owner units, style-free prompts and final code order', { skip: gate('o11'), timeout: 900000 }, async t => {
  const dir = tmp(t), deps = cliDeps('o11', dir), original = read(path.join(here, 'fixtures/caso-blocks/3a2d82bd.json'));
  const htmlOps = original.ops.slice(3, 11), flowTexts = original.ops[82].data.flow.flatMap(text => splitActions(text) ?? [text]);
  const htmlTexts = htmlOps.map(op => op.data.html), actions = actionItems(flowTexts);
  const blocks = htmlTexts.map(text => ({ kind: 'block', name: /<block\b[^>]*\bname="([^"]+)"/.exec(text)[1], intent: 'Implement the component contract', signature: signatureOf(text) }));
  const texts = Object.fromEntries([...blocks.map((item, i) => [item.name, htmlTexts[i]]), ...actions.map((item, i) => [item.name, flowTexts[i]])]);
  const raw = put(dir, 'shared.json', JSON.stringify([...original.ops.slice(11, 81), original.ops[81]]));
  const plan = await codePlan({ lane: 'o11', module: 'DemoFabio_UI', base: path.join(acceptanceRoot, 'DemoFabio_UI-base.oml'),
    items: [{ kind: 'data', name: 'ViewStructures', intent: 'Declare presentation structures' }, ...blocks.flatMap(block => [block, ...actions.filter(action => action.name.startsWith(block.name + '.'))])], shared: [raw], ops: original.ops.slice(1, 3) }, deps);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  fillPlan(plan, texts, original.ops[0].data.ddl);
  for (const block of blocks) {
    const batch = plan.batches.find(batch => names(batch.items).includes(block.name));
    for (const action of actions.filter(item => item.name.startsWith(block.name + '.'))) assert.ok(names(batch.items).includes(action.name));
  }
  for (const batch of plan.batches) { assert.doesNotMatch(fs.readFileSync(batch.promptFile, 'utf8'), /<style\b[^>]*>[\s\S]*?<\/style>/i); assert.ok(batch.promptBytes <= PACKET_TARGET_BYTES); }
  const result = writeCall(plan.final.arguments); assert.ok(!result.refusal, JSON.stringify(result));
  const codeOps = result.arguments.job.ops.filter(op => op.op === 'spec' || op.op === 'html' || (op.op === 'logic' && op.data.flow));
  const expected = [original.ops[0], ...htmlOps, original.ops[82]];
  const normalizeTerminalLf = op => ({ ...op, data: { ...op.data,
    ...(typeof op.data.html === 'string' ? { html: op.data.html.replace(/\n+$/, '') } : {}),
    ...(op.data.flow ? { flow: op.data.flow.map(text => text.replace(/\n+$/, '')) } : {}),
  } });
  const rawEqual = JSON.stringify(codeOps) === JSON.stringify(expected);
  const terminalNewlineDifferences = codeOps.flatMap((op, i) => JSON.stringify(op) === JSON.stringify(expected[i]) ? [] : [i]);
  assert.deepEqual(codeOps.map(normalizeTerminalLf), expected.map(normalizeTerminalLf));
  const measured = await checks(plan, deps);
  metric(t, 'blocks', { N: plan.batches.length, responseBytes: bytes(JSON.stringify(plan)), dataPromptBytes: plan.data?.promptBytes,
    htmlWithoutStyleBytes: htmlTexts.map(text => bytes(text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ''))),
    ...measured, codeOpsIdentical: rawEqual, codeContentsAndOrderIdentical: true, terminalNewlineDifferences,
    rawOps: { inline: 2, shared: 70, withoutPostLogicSlot: 43 }, inlinePermutation: 'ops 1–2 precede spec 0',
    proposal: 'A future explicit post-code ops field can represent accepted ops 83–125 without changing orderParts.',
    measurements: read(path.join(plan.dir, 'plan.json')).measurements,
    batches: plan.batches.map(batch => ({ id: batch.id, items: names(batch.items), bytes: batch.promptBytes })) });
  assert.equal(measured.parallel.length, plan.batches.length);
  for (const result of measured.parallel) {
    assert.ok(result.ok || result.problems?.length > 0, JSON.stringify(result));
    assert.ok(!/EBUSY/.test(JSON.stringify(result)));
    for (const problem of result.problems ?? []) assert.ok(problem.code && problem.pointer, JSON.stringify(problem));
  }
});

for (const lane of ['o11', 'odc']) test(`P8 ${lane} fixture corpus: real digests, compact deterministic plans and neutral checks`, { skip: gate(lane), timeout: 900000 }, async t => {
  const dir = tmp(t), deps = cliDeps(lane, dir), metrics = [];
  const files = lane === 'o11' ? ['reactive-ui.oml', 'traditional-ui.oml', 'mobile-ui.oml', 'blank-service.oml']
    : fs.readdirSync(path.join(fixtureRoot, 'odc')).filter(name => name.endsWith('.oml')).map(name => path.join('odc', name));
  for (const file of files) {
    const start = Date.now(), base = path.join(fixtureRoot, file), items = Array.from({ length: 7 }, (_, i) => action(`Neutral${i}`, i < 6 ? [`Neutral${i + 1}`] : []));
    const found = await deps.moduleDigest({ lane, target: base }); assert.equal(found.ok, true, JSON.stringify(found));
    if (found.digest.sections.find(section => section.id === 'ui')?.blocks.length) for (let i = 0; i < 2; i++) items.push({ kind: 'screen', name: `NeutralScreen${i}`, intent: 'Render an empty screen', signature: `<screen name="NeutralScreen${i}">` }, { ...action(`NeutralScreen${i}.Refresh`), signature: `action NeutralScreen${i}.Refresh` });
    const input = { lane, module: path.basename(file, '.oml'), base, items, workers: 3 };
    const plan = await codePlan(input, deps), again = await codePlan(input, deps);
    assert.equal(plan.ok, true, JSON.stringify(plan));
    const withoutAge = plan => ({ ...plan, capture: { ...plan.capture, ageSeconds: 0 } });
    assert.deepEqual(withoutAge(plan), withoutAge(again));
    assert.ok(plan.batches.every(batch => batch.promptBytes <= PACKET_TARGET_BYTES));
    let checked;
    if (['blank-service.oml', 'blank-mobile.oml'].includes(path.basename(file))) {
      fillPlan(plan, Object.fromEntries(items.map(item => [item.name, item.kind === 'screen' ? `${item.signature}</screen>` : `${item.signature}\n${(item.calls ?? []).map(name => `  ${name}()\n`).join('')}  end\n`])));
      checked = await Promise.all(plan.batches.map(batch => codeCheck(batch.check.arguments, deps)));
      assert.ok(checked.every(result => result.ok), JSON.stringify(checked));
    }
    metrics.push({ module: file, N: plan.batches.length, bytes: plan.batches.map(batch => batch.promptBytes), wallMs: Date.now() - start, ok: true, checked });
  }
  metric(t, `corpus-${lane}`, metrics);
});
