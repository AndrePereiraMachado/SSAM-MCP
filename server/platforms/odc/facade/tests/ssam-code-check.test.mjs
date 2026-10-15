import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { newestCapture, codeCheck } from '../code-check.mjs';
import { exampleCall, serviceExampleCall, splitActions, writeCall } from '../ssam-code.mjs';
import { createSsamServer } from '../ssam.mjs';
import { isWrite } from '../studio-write-lock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../../../..');
const fixtures = path.join(workspace, 'kernel/tests/fixtures');
const caseRoot = path.join(here, 'fixtures/caso-tickets/check');
const inputFixtures = path.join(workspace, '.local/cx5/fixtures');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const valueOf = r => r.structuredContent ?? JSON.parse(r.content[0].text);
function tmp(t) {
  const parent = path.join(workspace, '.local/cx5-tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(dir, name, text = name) {
  const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text); return file;
}
function listing(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(x => x.isFile()).map(x => {
    const file = path.join(x.parentPath ?? x.path, x.name);
    return [path.relative(dir, file), sha(fs.readFileSync(file)), fs.statSync(file).mtimeMs];
  }).sort((a, b) => a[0].localeCompare(b[0]));
}
const goodFlow = 'server action NeutralCheck\n  end\n';
const fakeSuccess = async () => ({ ok: true, exitCode: 0, envelope: { ok: true, data: { accepted: true, isValid: true, verifyRan: true } }, wallMs: 1, stderr: [] });

test('C3 origins survive merged logic and ordering for text, also, files and raw ops', async t => {
  const dir = tmp(t), base = put(dir, 'base.oml');
  const flow = name => `server action ${name}\n  end\n`;
  const file = put(dir, 'part.flow', flow('FromFile'));
  const ddl = put(dir, 'data.ddl', 'create entity NeutralData { Name: Text; }\n');
  const input = { lane: 'o11', module: 'Neutral', base, part: 'logic', text: flow('FromText'), files: [file, ddl],
    also: [{ part: 'logic', text: flow('FromAlso') }], ops: [{ op: 'logic', data: { flow: [flow('FromOps')] } }] };
  const plain = writeCall(input), traced = writeCall(input, { origins: true });
  assert.deepEqual(traced.arguments, plain.arguments);
  const result = await codeCheck(input, { root: dir, local: dir, runJob: async request => {
    const job = read(request.job); const problems = [];
    for (const [i, op] of job.ops.entries()) {
      if (op.data?.flow) for (const [j, text] of op.data.flow.entries()) problems.push({ code: 'TEST_FLOW', pointer: `/ops/${i}/data/flow/${j}`, message: /action (\w+)/.exec(text)[1] });
      else problems.push({ code: 'TEST_DATA', pointer: `/ops/${i}`, message: 'data' });
    }
    return { ok: false, code: 'PREFLIGHT_REFUSED', job: request.job, problems };
  }, guidance: async (_lane, _job, result) => result });
  const expected = { FromText: ['text', undefined], FromFile: ['files/0', file], FromAlso: ['also/0', undefined], FromOps: ['ops', undefined], data: ['files/1', ddl] };
  assert.equal(result.problems.length, 5);
  for (const p of result.problems) {
    assert.deepEqual([p.origin?.at, p.origin?.file], expected[p.message], JSON.stringify(p));
    if (p.code === 'TEST_FLOW') assert.equal(p.origin.action, p.message);
  }
});

test('C3 captured producer selection covers all elements, prefers exact then smallest then newest, without TTL', async t => {
  const dir = tmp(t), base = put(dir, 'base.oml'), local = path.join(dir, 'local'), odcRoot = path.join(dir, 'odc');
  const cache = path.join(local, 'producer-cache');
  const entry = (name, elements, date) => {
    const file = put(cache, name + '.avsig', name);
    const payload = JSON.stringify({ producer: 'NeutralLibrary', elements, storedAtUtc: date, sha256: sha(fs.readFileSync(file)) });
    put(cache, name + '.json', JSON.stringify({ format: 1, payload, sha256: sha(payload) })); return file;
  };
  const exact = entry('exact', ['A'], '2000-01-01T00:00:00Z');
  entry('larger', ['A', 'B', 'C'], '2026-01-01T00:00:00Z');
  const smaller = entry('smaller', ['A', 'B'], '2024-01-01T00:00:00Z');
  const newest = entry('newest', ['A', 'B'], '2025-01-01T00:00:00Z');
  const run = (lane, elements) => codeCheck({ lane, module: 'Neutral', base, ops: [{ op: 'reference', producer: 'NeutralLibrary', elements }] },
    { root: dir, local, odcRoot, now: () => Date.parse('2026-10-13T00:00:00Z'), runJob: async request => ({ ok: true, job: request.job }) });
  assert.equal((await run('o11', ['A'])).producers.NeutralLibrary.path, exact);
  assert.equal((await run('o11', ['A', 'B'])).producers.NeutralLibrary.path, newest);
  fs.unlinkSync(newest); assert.equal((await run('o11', ['A', 'B'])).producers.NeutralLibrary.path, smaller);
  const missing = await run('o11', ['Z']); assert.equal(missing.code, 'PRODUCER_NOT_CAPTURED');
  const old = put(odcRoot, '.local/producer-cache/odc/old.avsig', 'old');
  put(odcRoot, '.local/producer-cache/odc/old.json', JSON.stringify({ producer: 'NeutralLibrary', sha256: sha('old'), observedAtUtc: '2000-01-01T00:00:00Z' }));
  const odc = await run('odc', ['A']); assert.equal(odc.ok, true); assert.equal(odc.producers.NeutralLibrary.path, old);
  assert.ok(odc.producers.NeutralLibrary.ageSeconds > 86400 * 365);
});

// The kernel's JobNormalizer rewrites reach the job runner's answer as {total, byRule, items} (refusal-problems.mjs
// normalizationsOf); writeCall's own notes are a list. A check answers one field in the facade's one form
// (normalizations.mjs), accepted or refused: an accepted check that carried kernel rewrites used to throw.
test('C7 normalizations: the kernel object and the call notes in one field, accepted or refused', async t => {
  const dir = tmp(t), base = put(dir, 'base.oml');
  const kernel = { total: 2, byRule: { FLOW_KIND_PREFIX_DROPPED: 2 }, items: [
    { rule: 'FLOW_KIND_PREFIX_DROPPED', path: '/ops/0/data/flow/0', from: 'IEntityActionSignature:UpdateTicket(Source=T)', to: 'UpdateTicket(Source=T)' },
    { rule: 'FLOW_KIND_PREFIX_DROPPED', path: '/ops/0/data/flow/0', from: 'IEntityActionSignature:CreateTicket(Source=T)', to: 'CreateTicket(Source=T)' }] };
  const input = { lane: 'o11', module: 'Neutral', base, part: 'flow', text: goodFlow };
  const call = writeCall(input).normalizations;
  assert.deepEqual(call.map(n => n.rule), ['part-synonym']);
  const check = runJob => codeCheck(input, { root: dir, local: dir, runJob, guidance: async (_lane, _job, result) => result });
  const accepted = await check(async request => ({ ok: true, job: request.job, normalizations: kernel }));
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.deepEqual(accepted.normalizations, { total: 3, byRule: { FLOW_KIND_PREFIX_DROPPED: 2, 'part-synonym': 1 }, items: [...call, ...kernel.items] });
  const refused = await check(async request => ({ ok: false, code: 'PREFLIGHT_REFUSED', job: request.job, normalizations: kernel,
    problems: [{ code: 'NAME_COLLISION', pointer: '/ops/0/data/flow/0', message: 'collides' }] }));
  assert.equal(refused.code, 'CHECK_REFUSED');
  assert.deepEqual(refused.normalizations, accepted.normalizations);
  // A list from the runner (the facade's own op shapes) stays a list after the call notes; nothing to say, no field.
  const listed = await check(async request => ({ ok: true, job: request.job, normalizations: [{ rule: 'job-op', at: '/ops/0', note: 'n' }] }));
  assert.deepEqual(listed.normalizations.map(n => n.rule), ['part-synonym', 'job-op']);
  const plain = await codeCheck({ ...input, part: 'logic' }, { root: dir, local: dir, runJob: async request => ({ ok: true, job: request.job }) });
  assert.equal(plain.ok, true); assert.equal(Object.hasOwn(plain, 'normalizations'), false);
});

test('C1 newest capture is read-only: index, scans, explicit base, ODC receipts and revision fallback', async t => {
  const dir = tmp(t), local = path.join(dir, 'local'), odcRoot = path.join(dir, 'odc');
  const old = put(local, 'snapshots/indexed.oml');
  const scanned = put(local, 'snapshots/Neutral-20261013120000-deadbeef.oml');
  fs.utimesSync(scanned, new Date('2026-10-13T12:00:00Z'), new Date('2026-10-13T12:00:00Z'));
  put(local, 'snapshots/captures.json', JSON.stringify({ schema: 'ssam-captures/1', modules: { key: [
    { module: 'NEUTRAL', path: old, at: '2026-10-13T11:00:00Z', source: 'indexed' },
    { module: 'Neutral', path: path.join(dir, 'absent.oml'), at: '2026-10-13T15:00:00Z' },
  ] } }));
  const now = () => Date.parse('2026-10-13T12:01:00Z');
  const deps = { root: path.join(workspace, 'kernel'), local, odcRoot, now };
  let before = listing(dir);
  const selected = await newestCapture({ lane: 'o11', module: 'Neutral' }, deps);
  assert.equal(selected.path, scanned); assert.equal(selected.sha256, sha(fs.readFileSync(scanned)));
  assert.equal(selected.ageSeconds, 60); assert.match(selected.model, /^[a-f0-9]{64}$/);
  const given = await newestCapture({ lane: 'o11', module: 'Neutral', base: old }, deps);
  assert.equal(given.path, old); assert.equal(given.source, 'given');
  assert.equal(await newestCapture({ lane: 'o11', module: 'Missing' }, deps), null);
  assert.deepEqual(listing(dir), before);
  const revision = put(odcRoot, 'snapshots/Neutral-revision-8.oml');
  assert.equal((await newestCapture({ lane: 'odc', module: 'Neutral' }, deps)).source, 'revision');
  const snapshot = put(odcRoot, `snapshots/Neutral-${'a'.repeat(64)}.oml`);
  put(odcRoot, path.relative(odcRoot, snapshot) + '.json', JSON.stringify({ module: 'Neutral', moduleKey: 'k', sha256: 'a'.repeat(64), capturedAt: '2026-10-13T12:00:30Z' }));
  fs.utimesSync(revision, new Date('2026-10-13T12:01:00Z'), new Date('2026-10-13T12:01:00Z'));
  before = listing(dir);
  const odc = await newestCapture({ lane: 'odc', module: 'Neutral' }, deps);
  assert.equal(odc.path, snapshot); assert.equal(odc.ageSeconds, 30);
  assert.equal(odc.sha256, sha(fs.readFileSync(snapshot))); assert.deepEqual(listing(dir), before);
});

test('C2 one refusal collects forbidden fields, missing file, missing capture and producer', async t => {
  const dir = tmp(t); let calls = 0;
  const result = await codeCheck({ lane: 'o11', module: 'Missing', publish: true, until: 'apply', patch: [],
    files: [path.join(dir, 'missing.flow')], ops: [{ op: 'reference', producer: 'AbsentLibrary', elements: ['IServerActionSignature:AbsentAction'] }] },
  { root: path.join(workspace, 'kernel'), local: dir, runAnvil: async () => { calls++; throw new Error('must not run'); } });
  assert.equal(result.ok, false); assert.equal(calls, 0);
  const all = JSON.stringify(result.problems);
  for (const term of ['publish', 'until', 'patch', 'missing.flow', 'CAPTURE_MISSING', 'PRODUCER_NOT_CAPTURED']) assert.ok(all.includes(term), term + ': ' + all);
  assert.equal(result.continuation.tool, 'ssam_map');
});

test('C3 cold apply only, private work directories, origins and server never deliver or lock', async t => {
  const dir = tmp(t), base = put(dir, 'base.oml'); const argv = [];
  put(dir, '.local/lane-odc/cli/anvil-odc.dll', 'runner is injected');
  const deps = { root: dir, local: path.join(dir, 'local'), odcRoot: path.join(dir, 'odc'),
    runAnvil: async (args, options) => { argv.push({ args, options }); return fakeSuccess(); } };
  const input = { lane: 'odc', action: 'check', module: 'Neutral', part: 'logic', text: goodFlow, base };
  const results = await Promise.all([codeCheck(input, deps), codeCheck(input, deps)]);
  for (const result of results) { assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.action, 'check'); assert.equal(result.nextBasedOn, undefined); }
  assert.equal(argv.length, 2);
  const work = argv.map(({ args }) => {
    assert.equal(args[0], 'apply');
    for (const forbidden of ['--bridge-port', 'signature', 'deliver', 'merge']) assert.ok(!args.includes(forbidden));
    return args[args.indexOf('--work') + 1];
  });
  assert.equal(new Set(work).size, 2); assert.ok(work.every(x => x.includes('check')));
  assert.equal(isWrite('ssam_code', { action: 'check' }), false);
  const seen = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'check-no-studio', version: '1' });
    fake.registerTool('studio_deliver', { inputSchema: z.object({}).passthrough() }, async args => {
      seen.push(args); return { content: [{ type: 'text', text: '{}' }] };
    }); return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot: dir, answersRoot: dir,
    codeCheck: args => codeCheck(args, deps), lock: { o11Root: dir, odcRoot: dir, connection: () => null } } });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'check-test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const response = valueOf(await client.callTool({ name: 'ssam_code', arguments: input }));
  assert.equal(response.ok, true, JSON.stringify(response)); assert.equal(seen.length, 0);
});

test('C3 default runner ignores the saved Studio connection and uses only cold apply', async t => {
  const dir = tmp(t), base = put(dir, 'base.oml'), calls = [];
  const connection = { ok: true, lane: 'o11', anvilLane: 'ss4', pid: 789, startedUtc: '2026-10-13T12:00:00Z',
    studioDir: path.join(dir, 'poisoned-studio'), authorityDir: path.join(dir, 'poisoned-authority'), port: 59999 };
  const record = put(dir, '.local/connections/ss4.json', JSON.stringify(connection));
  const env = { ...process.env }; delete env.ANVIL_BRIDGE_PORT; delete env.ANVIL_STUDIO_DIR;
  const result = await codeCheck({ lane: 'o11', module: 'Neutral', base, part: 'logic', text: goodFlow }, {
    root: dir, local: path.join(dir, '.local'), env,
    execFileFn: (file, args, options, callback) => {
      calls.push({ file, args, env: options.env });
      callback(null, JSON.stringify({ ok: true, data: { accepted: true, isValid: true } }), '');
      return { stdin: { end() {} } };
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(calls.length, 1);
  assert.equal(calls[0].args[1], 'apply');
  assert.equal(calls[0].env.ANVIL_BRIDGE_PORT, undefined);
  assert.notEqual(calls[0].env.ANVIL_STUDIO_DIR, connection.studioDir);
  assert.notEqual(calls[0].env.ANVIL_AUTHORITY_DIR, connection.authorityDir);
  assert.deepEqual(read(record), connection);
});

const CLI = { o11: process.env.SSAM_CODE_CLI_O11, odc: process.env.SSAM_CODE_CLI_ODC };
function cliDeps(lane, dir, calls = []) {
  // runJob verifies this path; the real assembly is invoked explicitly by the injected runner below.
  put(dir, '.local/lane-odc/cli/anvil-odc.dll', 'runner is injected');
  const temp = path.join(dir, 'tmp'); fs.mkdirSync(temp, { recursive: true });
  // The ODC feature cache the lane CLI reads: the run's ANVIL_ODC_FEATURES_DIR (a private Features.xml) when it is set, else
  // the CX5 copy of this workspace when present, else the CLI's own lookup.
  const local = path.join(workspace, '.local/cx5/features');
  const features = process.env.ANVIL_ODC_FEATURES_DIR || (fs.existsSync(local) ? local : null);
  const env = { ...process.env, TEMP: temp, TMP: temp, ...(features ? { ANVIL_ODC_FEATURES_DIR: features } : {}),
    ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_NO_WARM: '1', SSAM_MODULE_INDEX_ROOT: path.join(dir, 'index') };
  return { root: dir, local: path.join(dir, 'local'), odcRoot: path.join(dir, 'odc'),
    env,
    runAnvil: (args, options = {}) => new Promise(resolve => {
      calls.push(args); const start = Date.now();
      execFile('dotnet', [path.join(CLI[lane], lane === 'o11' ? 'anvil.dll' : 'anvil-odc.dll'), ...args], {
        cwd: options.cwd, env,
        timeout: 900000, maxBuffer: 1 << 28, windowsHide: true,
      }, (error, stdout, stderr) => {
        let envelope; try { envelope = JSON.parse(stdout); } catch { envelope = { ok: false, error: stdout + stderr }; }
        resolve({ ok: !error && envelope.ok, exitCode: error?.code ?? 0, envelope, stderr: stderr ? [stderr] : [], wallMs: Date.now() - start });
      });
    }) };
}
const gated = lane => !CLI[lane] || !fs.existsSync(path.join(CLI[lane], lane === 'o11' ? 'anvil.dll' : 'anvil-odc.dll')) ? `${lane} CLI not supplied` : false;
const caseFiles = n => ['dados.ddl', 'ops.json', `parte-${n}.flow`].map(x => path.join(caseRoot, x));
const normalizedMessage = p => String(p.message ?? p.error ?? '').replace(/\/ops\/\d+(?:\/data\/flow\/\d+)?/g, '<pointer>');

test('C4/C6 Tickets original parts in parallel and series: complete diagnostics with exact file origins', {
  skip: gated('o11') || !fs.existsSync(inputFixtures) && 'acceptance capture unavailable', timeout: 900000,
}, async t => {
  const dir = tmp(t), calls = [], deps = cliDeps('o11', dir, calls);
  const captureName = fs.readdirSync(inputFixtures).find(x => x.startsWith('DemoFabio_CS-') && x.endsWith('.oml'));
  assert.ok(captureName, 'acceptance capture');
  fs.mkdirSync(path.join(deps.local, 'snapshots'), { recursive: true });
  fs.copyFileSync(path.join(inputFixtures, captureName), path.join(deps.local, 'snapshots', captureName));
  fs.mkdirSync(path.join(deps.local, 'producer-cache'), { recursive: true });
  for (const file of fs.readdirSync(inputFixtures).filter(x => x.startsWith('e30787d7'))) fs.copyFileSync(path.join(inputFixtures, file), path.join(deps.local, 'producer-cache', file));
  const original = read(path.join(here, 'fixtures/caso-tickets/d8ce8b7a.json'));
  assert.equal(fs.readFileSync(caseFiles(1)[0], 'utf8'), original.ops[0].data.ddl);
  assert.deepEqual(read(caseFiles(1)[1]), original.ops.slice(1, 3));
  const actions = splitActions(original.ops[3].data.flow[0]);
  for (let n = 1; n <= 3; n++) assert.equal(fs.readFileSync(caseFiles(n)[2], 'utf8'), actions.slice((n - 1) * 5, n * 5).join('\n'));
  const run = n => codeCheck({ lane: 'o11', module: 'DemoFabio_CS', files: caseFiles(n) }, deps);
  const start = Date.now(); const parallel = await Promise.all([1, 2, 3].map(run)); const parallelMs = Date.now() - start;
  const serial = []; const serialStart = Date.now(); for (const n of [1, 2, 3]) serial.push(await run(n));
  const serialMs = Date.now() - serialStart;
  assert.equal(new Set(calls.map(a => a[a.indexOf('--work') + 1])).size, 6);
  // With the kernel of CX1 (one refusal with every problem) and CX3 (flow text gaps): R1 (DDL_SYNTAX x2 on TicketCategory
  // and TicketAttachmentContent, REFERENCE_UNRESOLVED actions/5) is gone, as in CX1's replay of d8ce8b7a, and part 1 is
  // refused only for the two name collisions its new actions have with the entity actions of Ticket (CreateTicket,
  // UpdateTicket), at their exact file and action; parts 2 and 3 are valid. The six R2 calls
  // IEntityActionSignature:UpdateTicket(...) are kernel rewrites (FLOW_KIND_PREFIX_DROPPED, 3/2/1 per part) listed in
  // the answer's normalizations, accepted or refused, never silent.
  const r2 = [];
  for (const [i, result] of parallel.entries()) {
    const twin = serial[i], text = JSON.stringify(result).slice(0, 3000);
    assert.equal(result.ok, i > 0, text); assert.equal(twin.ok, result.ok, JSON.stringify(twin).slice(0, 3000));
    if (result.ok) assert.equal(result.valid, true, text); else assert.equal(result.code, 'CHECK_REFUSED', text);
    assert.match(result.capture.model, /^ad21f528/); assert.ok(!/EBUSY/.test(JSON.stringify(result)));
    assert.deepEqual((result.problems ?? []).map(p => [p.code, normalizedMessage(p)]), (twin.problems ?? []).map(p => [p.code, normalizedMessage(p)]));
    assert.deepEqual(result.normalizations, twin.normalizations);
    for (const p of result.problems ?? []) {
      const expected = p.code === 'DDL_SYNTAX' ? caseFiles(i + 1)[0]
        : p.code === 'REFERENCE_UNRESOLVED' ? caseFiles(i + 1)[1] : caseFiles(i + 1)[2];
      assert.equal(p.origin?.file, expected, JSON.stringify(p));
    }
    const kernel = result.normalizations?.items ?? [];
    assert.equal(Array.isArray(result.normalizations), false, 'the kernel rewrites keep their object form: ' + JSON.stringify(result.normalizations));
    r2.push(kernel.filter(n => n.rule === 'FLOW_KIND_PREFIX_DROPPED' && /^IEntityActionSignature:UpdateTicket\(/.test(n.from)).length);
    t.diagnostic(JSON.stringify({ part: i + 1, ok: result.ok, parallelWallMs: result.wallMs, serialWallMs: twin.wallMs, problems: result.problems, normalizations: result.normalizations }));
  }
  const all = parallel.flatMap(x => x.problems ?? []);
  assert.deepEqual(all.map(p => [p.code, p.origin?.action]), [['NAME_COLLISION', 'CreateTicket'], ['NAME_COLLISION', 'UpdateTicket']], JSON.stringify(all));
  for (const p of all) assert.match(normalizedMessage(p), new RegExp(`'${p.origin.action}' collides with IEntityActionSignature '${p.origin.action}' of Ticket`));
  assert.ok(!all.some(p => p.code === 'FLOW_SYNTAX' && /unexpected line: \/\/\//.test(normalizedMessage(p))), 'CX2 splits multiple actions');
  assert.deepEqual(r2, [3, 2, 1], 'the six R2 calls are normalized, never refused and never silent');
  t.diagnostic(JSON.stringify({ parallelMs, serialMs, sumSerialWallMs: serial.reduce((sum, x) => sum + x.wallMs, 0), priorRefusalsMs: 90000, R2normalized: r2 }));
});

for (const lane of ['o11', 'odc']) {
  test(`C5 ${lane} grammar examples and broken neutral corpus`, { skip: gated(lane), timeout: 900000 }, async t => {
    const dir = tmp(t), deps = cliDeps(lane, dir);
    const ui = path.join(fixtures, lane === 'o11' ? 'reactive-ui.oml' : 'odc/insurance-reactive-r8.oml');
    const empty = path.join(fixtures, lane === 'o11' ? 'blank-service.oml' : 'odc/blank-mobile.oml');
    for (const [kind, input, base] of [['ui', exampleCall(lane).arguments, ui], ['service', serviceExampleCall(lane).arguments, empty]]) {
      await t.test(`${kind} example`, async () => {
      const result = await codeCheck({ ...input, base }, deps);
      t.diagnostic(JSON.stringify({ lane, kind, module: path.basename(base), ok: result.ok, wallMs: result.wallMs, problems: result.problems }));
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.valid, true);
      });
    }
    const corpus = lane === 'o11' ? ['reactive-ui.oml', 'traditional-ui.oml', 'mobile-ui.oml', 'blank-service.oml']
      : fs.readdirSync(path.join(fixtures, 'odc')).filter(x => x.endsWith('.oml')).map(x => path.join('odc', x));
    const ddl = put(dir, 'broken.ddl', 'create unique index NeutralIndex on EntityNotDeclared (Name);\n');
    const flow = put(dir, 'broken.flow', 'server action NeutralBroken\n  ActionNotDeclared()\n  end\n');
    for (const file of corpus) {
      await t.test(file, async () => {
      const result = await codeCheck({ lane, module: 'NeutralCorpus', files: [ddl, flow], base: path.join(fixtures, file) }, deps);
      t.diagnostic(JSON.stringify({ lane, module: file, wallMs: result.wallMs, ok: result.ok, problems: result.problems }));
      assert.equal(result.ok, false, file); assert.equal(result.code, 'CHECK_REFUSED', JSON.stringify(result));
      for (const [at, expected] of [['files/0', ddl], ['files/1', flow]]) assert.ok(result.problems.some(p => p.origin?.at === at && p.origin.file === expected), file + ': ' + JSON.stringify(result));
      const restrictedRuntime = { 'blank-agent-definition.oml': 'AgentDefinition', 'blank-workflow.oml': 'BusinessProcess' }[path.basename(file)];
      assert.ok(result.problems.some(p => p.origin?.file === flow && (restrictedRuntime
        ? p.code === 'APPLY_FAILED' && p.message.includes(`Server Action can't be created in ${restrictedRuntime} runtime kind`)
        : p.code === 'FLOW_NAME_UNKNOWN' && /ActionNotDeclared/.test(p.message))), JSON.stringify(result));
      });
    }
  });
}
