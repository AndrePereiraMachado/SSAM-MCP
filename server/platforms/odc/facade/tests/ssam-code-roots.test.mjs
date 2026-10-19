// feat/ssam-code-hosted: ssam_code check and plan for a server that keeps each session's files apart (a hosted one).
// - R1 deps.roots {o11, odc, odcWork}: the newest capture, the producer captures, the check job and the plan come from and go
//   to those folders only; nothing is read from or written to the folders of this checkout.
// - R2 with roots a base is only a capture of the lane's capture folder (<o11|odc>/snapshots), never any .oml; without roots a
//   base stays any existing absolute .oml (local use unchanged).
// - R3 deps.place: how a plan names its files for a session whose subagents run elsewhere (shown, output, input), what it
//   does with SSAM's documentation in a prompt (document) and how its files reach that session (publish).
// - R4 the read of an action an edit of logic expands (readReading) is the server's to give: ssam_code write (registerSsamCode
//   write) and check (deps.readReading) take it.
// - R5 createSsamServer deps.code(): the deps of each ssam_code check, plan and write of a server (the roots of the call).
// Injected runners only: no Studio, no kernel process.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as checkModule from '../code-check.mjs';
const { codeCheck, newestCapture } = checkModule;
import { codePlan } from '../code-plan.mjs';
import { registerSsamCode } from '../ssam-code.mjs';
import { createSsamServer } from '../ssam.mjs';
import { DIGEST_EXTRACTOR, DIGEST_SECTIONS } from '../module-digest.mjs';
import { textSha, FLOW_READING_SCHEMA, FLOW_EXTRACTOR } from '../module-flow.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '../../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const values = result => result.structuredContent ?? JSON.parse(result.content[0].text);
function tmp(t) {
  const parent = path.join(workspace, '.local/code-roots-tests');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'roots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(dir, name, text = name) {
  const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text); return file;
}
function listing(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(x => x.isFile()).map(x => {
    const file = path.join(x.parentPath ?? x.path, x.name);
    return [path.relative(dir, file), sha(fs.readFileSync(file))];
  }).sort((a, b) => a[0].localeCompare(b[0]));
}
const within = (dir, file) => { const rel = path.relative(dir, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
// A checkout with captures of its own (what a server must never read for a session) and the session's roots.
function layout(t) {
  const dir = tmp(t);
  const checkout = { root: path.join(dir, 'checkout'), local: path.join(dir, 'checkout', '.local'), odcRoot: path.join(dir, 'checkout', 'odc') };
  put(checkout.local, 'snapshots/Neutral-20261018090000-aaaaaaaa.oml', 'checkout o11 capture');
  const odcName = `snapshots/Neutral-${'b'.repeat(64)}.oml`;
  put(checkout.odcRoot, odcName, 'checkout odc capture');
  put(checkout.odcRoot, odcName + '.json', JSON.stringify({ module: 'Neutral', capturedAt: '2026-10-18T09:00:00Z' }));
  const session = path.join(dir, 'session');
  const roots = { o11: path.join(session, 'o11'), odc: path.join(session, 'odc'), odcWork: path.join(session, 'odc', 'lab') };
  return { dir, checkout, roots, session };
}
const sessionCaptures = roots => {
  const o11 = put(roots.o11, 'snapshots/Neutral-20261018100000-cccccccc.oml', 'session o11 capture');
  const name = `snapshots/Neutral-${'d'.repeat(64)}.oml`;
  const odc = put(roots.odc, name, 'session odc capture');
  put(roots.odc, name + '.json', JSON.stringify({ module: 'Neutral', capturedAt: '2026-10-18T10:00:00Z' }));
  return { o11, odc };
};
const goodFlow = 'server action NeutralRoots\n  end\n';

test('R1 with roots the check reads the session captures and producers only, and writes its job under the roots', async t => {
  const { checkout, roots } = layout(t);
  const own = sessionCaptures(roots);
  // A producer the checkout has captured (O11 producer cache, ODC capture folder) and the session has not.
  const avsig = put(checkout.local, 'producer-cache/lib.avsig', 'checkout producer');
  const payload = JSON.stringify({ producer: 'NeutralLibrary', elements: ['A'], storedAtUtc: '2026-10-18T09:00:00Z', sha256: sha(fs.readFileSync(avsig)) });
  put(checkout.local, 'producer-cache/lib.json', JSON.stringify({ format: 1, payload, sha256: sha(payload) }));
  put(checkout.odcRoot, 'snapshots/producers/NeutralLibrary-20261018T090000Z.avsig', 'checkout odc producer');
  const before = listing(checkout.root);
  const seen = [];
  const deps = { ...checkout, roots, runJob: async request => { seen.push(request); return { ok: true, job: request.job }; } };
  for (const [lane, capture] of [['o11', own.o11], ['odc', own.odc]]) {
    const result = await codeCheck({ lane, module: 'Neutral', part: 'logic', text: goodFlow }, deps);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.capture.path, capture, lane + ': the session capture, never the checkout one');
    const job = seen.at(-1).job;
    assert.ok(within(lane === 'o11' ? roots.o11 : roots.odcWork, job), lane + ': the check job is under the roots: ' + job);
    assert.equal(seen.at(-1).base, capture);
  }
  // The producer the checkout holds is no producer of the session: one problem with the capture to take.
  const missing = await codeCheck({ lane: 'o11', module: 'Neutral', ops: [{ op: 'reference', producer: 'NeutralLibrary', elements: ['A'] }] }, deps);
  assert.equal(missing.code, 'PRODUCER_NOT_CAPTURED', JSON.stringify(missing));
  const mine = put(roots.o11, 'producer-cache/lib.avsig', 'session producer');
  const minePayload = JSON.stringify({ producer: 'NeutralLibrary', elements: ['A'], storedAtUtc: '2026-10-18T10:00:00Z', sha256: sha(fs.readFileSync(mine)) });
  put(roots.o11, 'producer-cache/lib.json', JSON.stringify({ format: 1, payload: minePayload, sha256: sha(minePayload) }));
  const bound = await codeCheck({ lane: 'o11', module: 'Neutral', ops: [{ op: 'reference', producer: 'NeutralLibrary', elements: ['A'] }] }, deps);
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.equal(bound.producers.NeutralLibrary.path, mine);
  // ODC: a producer capture of the checkout's capture folder is not the session's.
  const odcMissing = await codeCheck({ lane: 'odc', module: 'Neutral', ops: [{ op: 'reference', producer: 'NeutralLibrary', elements: ['A'] }] }, deps);
  assert.equal(odcMissing.code, 'PRODUCER_NOT_CAPTURED', JSON.stringify(odcMissing));
  assert.ok(within(roots.odc, odcMissing.problems[0].continuation.arguments.output), 'the capture to take lands in the session: ' + odcMissing.problems[0].continuation.arguments.output);
  // Nothing was written in the checkout (no check job, no capture folder of its own touched).
  assert.deepEqual(listing(checkout.root), before);
  assert.equal(typeof checkModule.codeRoots, 'function', 'codeRoots is exported');
  const { codeRoots } = checkModule;
  assert.deepEqual(codeRoots({ roots }), { o11: path.resolve(roots.o11), odc: path.resolve(roots.odc), odcWork: path.resolve(roots.odcWork), confined: true });
  assert.throws(() => codeRoots({ roots: { o11: 'relative', odc: roots.odc, odcWork: roots.odcWork } }), /absolute/);
});

test('R2 with roots a base is only a capture of the lane\'s capture folder; without roots any absolute .oml, as before', async t => {
  const { checkout, roots, dir } = layout(t);
  const own = sessionCaptures(roots);
  const elsewhere = put(dir, 'elsewhere/Any.oml', 'any oml');
  const inSessionNotCapture = put(roots.o11, 'work/Other.oml', 'a work file of the session');
  const odcInO11 = own.o11;
  const runJob = async request => ({ ok: true, job: request.job });
  const deps = { ...checkout, roots, runJob };
  for (const [lane, base] of [['o11', elsewhere], ['o11', inSessionNotCapture], ['odc', odcInO11], ['odc', put(checkout.odcRoot, 'snapshots/Neutral-' + 'e'.repeat(64) + '.oml', 'x')]]) {
    const refused = await codeCheck({ lane, module: 'Neutral', part: 'logic', text: goodFlow, base }, deps);
    assert.equal(refused.ok, false, lane + ' ' + base);
    assert.equal(refused.code, 'INPUT_INVALID');
    const problem = refused.problems.find(p => p.at === 'base');
    assert.match(problem.message, /base must be a capture/, JSON.stringify(problem));
    assert.equal(await newestCapture({ lane, module: 'Neutral', base }, deps), null);
  }
  for (const [lane, base] of [['o11', own.o11], ['odc', own.odc]]) {
    const given = await codeCheck({ lane, module: 'Neutral', part: 'logic', text: goodFlow, base }, deps);
    assert.equal(given.ok, true, JSON.stringify(given));
    assert.equal(given.capture.path, base); assert.equal(given.capture.source, 'given');
  }
  // local use: any existing absolute .oml is a base
  const local = await codeCheck({ lane: 'o11', module: 'Neutral', part: 'logic', text: goodFlow, base: elsewhere }, { ...checkout, runJob });
  assert.equal(local.ok, true, JSON.stringify(local));
  assert.equal(local.capture.path, elsewhere);
});

function digestOf(lane = 'o11') {
  return { schema: 'ssam-digest/1', extractor: DIGEST_EXTRACTOR, adapter: 'kernel', lane, sourceSha256: 'a'.repeat(64),
    module: { name: 'Neutral', key: 'R0', kind: 'Service' }, actions: [], sections: DIGEST_SECTIONS.map(id => ({ id, title: id, count: 0, blocks: [] })) };
}
const action = (name, calls = []) => ({ kind: 'action', name, intent: `Implement ${name}`, signature: `server action ${name}\n  in Value: Integer`, calls });
const items = () => [{ kind: 'data', name: 'Shape', intent: 'type Shape = { Name: Text; }' },
  ...Array.from({ length: 8 }, (_, i) => action(`Neutral${i}`, i < 7 ? [`Neutral${i + 1}`] : []))];

test('R3 with roots the plan reads the session capture and writes its folder under the roots', async t => {
  const { checkout, roots } = layout(t);
  const own = sessionCaptures(roots);
  const before = listing(checkout.root);
  for (const [lane, capture, under] of [['o11', own.o11, roots.o11], ['odc', own.odc, roots.odcWork]]) {
    const plan = await codePlan({ lane, module: 'Neutral', items: items(), workers: 2 }, { ...checkout, roots, moduleDigest: async () => ({ ok: true, digest: digestOf(lane) }) });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    assert.equal(plan.capture.path, capture);
    assert.ok(within(path.join(under, 'plans'), plan.dir), lane + ': ' + plan.dir);
    assert.ok(fs.existsSync(path.join(plan.dir, 'plan.json')));
  }
  assert.deepEqual(listing(checkout.root), before, 'the checkout is untouched');
  // a base that is no capture of the session
  const refused = await codePlan({ lane: 'o11', module: 'Neutral', items: items(), base: put(checkout.local, 'x/Any.oml', 'any') }, { ...checkout, roots, moduleDigest: async () => ({ ok: true, digest: digestOf() }) });
  assert.equal(refused.ok, false);
  assert.match(JSON.stringify(refused.problems), /base must be a capture/);
});

test('R3 deps.place: shown, output, input, document and publish name and deliver every file of the plan', async t => {
  const { checkout, roots } = layout(t);
  const own = sessionCaptures(roots);
  const published = [];
  const place = {
    shown: file => 'srv:' + path.relative(roots.o11, file).replaceAll('\\', '/'),
    output: file => 'C:\\Client\\inbox\\' + path.basename(file),
    input: file => 'C:\\Client\\read\\' + path.basename(file),
    document: (section, value) => (section === 'grammar' ? value.map(card => ({ ...card, rules: ['[doc] grammar'] })) : { ...value, chosen: '[doc] rules' }),
    publish: async files => { for (const f of files) assert.ok(fs.existsSync(f), 'published after it was written: ' + f); published.push(...files); },
  };
  const deps = { ...checkout, roots, place, moduleDigest: async () => ({ ok: true, digest: digestOf() }) };
  const shared = put(roots.o11, 'shared/types.ddl', 'type Common = { Code: Text; }\n');
  const plan = await codePlan({ lane: 'o11', module: 'Neutral', items: items(), workers: 2, shared: [shared] }, deps);
  assert.equal(plan.ok, true, JSON.stringify(plan));
  const serverDir = path.join(roots.o11, 'plans', plan.planId);
  assert.equal(plan.dir, place.shown(serverDir));
  assert.equal(plan.capture.path, place.shown(own.o11));
  assert.equal(plan.data.file, place.output(path.join(serverDir, 'data.ddl')));
  assert.ok(plan.batches.length === 2);
  for (const batch of [plan.data, ...plan.batches]) {
    assert.ok(batch.files.every(f => f.startsWith('C:\\Client\\inbox\\')), JSON.stringify(batch.files));
    assert.ok(batch.promptFile.startsWith('C:\\Client\\read\\'), batch.promptFile);
    assert.ok(batch.launchPrompt.includes(batch.promptFile));
    assert.equal(batch.check.arguments.base, place.shown(own.o11));
    for (const stub of batch.check.arguments.stubs ?? []) assert.ok(stub.startsWith('srv:plans/'), stub);
    for (const file of batch.check.arguments.files) assert.ok(file === place.shown(shared) || file.startsWith('C:\\Client\\inbox\\'), file);
    const prompt = fs.readFileSync(path.join(serverDir, path.basename(batch.promptFile)), 'utf8');
    assert.match(prompt, /Write UTF-8 files: C:\\Client\\inbox\\/);
    assert.ok(!prompt.includes(roots.o11) && !prompt.includes(path.dirname(roots.o11)), 'no server folder in a prompt');
    // SSAM's documentation in a prompt passes deps.place document (the grammar cards and the rules section)
    assert.ok(prompt.includes('"rules":["[doc] grammar"]'), 'the grammar section passed document');
    assert.ok(prompt.includes('"chosen":"[doc] rules"') || prompt.includes('## rules (cut)'), 'the rules section passed document');
  }
  assert.ok(plan.batches.some(b => (b.check.arguments.stubs ?? []).length), 'a cross-batch call has its stub');
  assert.deepEqual(plan.final.arguments.files, [place.output(path.join(serverDir, 'data.ddl')), place.shown(shared), ...plan.batches.flatMap(b => b.files)]);
  const saved = read(path.join(serverDir, 'plan.json'));
  assert.ok(!JSON.stringify(saved).includes(JSON.stringify(roots.o11).slice(1, -1)), 'plan.json names no server folder');
  assert.equal(saved.dir, plan.dir); assert.equal(saved.capture.path, plan.capture.path);
  assert.deepEqual(published.sort(), [path.join(serverDir, 'plan.json'), path.join(serverDir, 'data.prompt.md'), ...plan.batches.map(b => path.join(serverDir, `batch-${b.id}.prompt.md`))].sort());
  // a publish that fails is the plan's refusal: nothing to launch
  const failing = await codePlan({ lane: 'o11', module: 'Neutral', items: items(), workers: 2 }, { ...deps, place: { ...place, publish: async () => { throw Object.assign(new Error('the session is gone'), { code: 'AGENT_NOT_CONNECTED' }); } } });
  assert.equal(failing.ok, false);
  assert.equal(failing.code, 'AGENT_NOT_CONNECTED');
  assert.equal(failing.batches, undefined);
  assert.match(failing.error, /the session is gone/);
});

const reading = text => ({ schema: FLOW_READING_SCHEMA, extractor: FLOW_EXTRACTOR, lane: 'o11', adapter: 'kernel', sourceSha256: 'a'.repeat(64),
  action: { key: 'K1', kind: 'ServerAction', name: 'Neutral' }, textSha: textSha(text), text, ids: [] });
const readText = 'server action Neutral @K1\n  assign X = 1  @n1\n  end  @n2\n';

test('R4 the read an edit of logic expands is the server\'s to give: registerSsamCode write and codeCheck take readReading', async t => {
  const asked = [];
  const deliver = [];
  let handler;
  registerSsamCode({ registerTool: (_name, _schema, fn) => { handler = fn; } }, {
    fromJsonSchema: value => value,
    deliver: async (tool, args) => { deliver.push({ tool, args }); return { structuredContent: { ok: true } }; },
    write: { readReading: (lane, sha) => { asked.push([lane, sha]); return sha === textSha(readText) ? reading(readText) : null; } },
  });
  const edit = { lane: 'o11', action: 'write', module: 'Neutral', part: 'logic', element: 'Neutral', edits: [{ replace: '@n1', with: 'assign X = 2' }] };
  const unknown = values(await handler({ ...edit, basedOn: 'f'.repeat(16) }));
  assert.equal(unknown.ok, false); assert.match(unknown.error, /no read of this textSha is kept/);
  assert.equal(deliver.length, 0);
  const known = values(await handler({ ...edit, basedOn: textSha(readText) }));
  assert.equal(known.ok, true, JSON.stringify(known));
  assert.match(deliver[0].args.job.ops[0].data.flow[0].text, /assign X = 2/);
  assert.deepEqual(asked.map(a => a[1]), ['f'.repeat(16), textSha(readText)]);
  // the check of the same edit
  const { checkout, roots } = layout(t);
  sessionCaptures(roots);
  const checked = [];
  const deps = { ...checkout, roots, readReading: (lane, sha) => { checked.push(sha); return null; }, runJob: async request => ({ ok: true, job: request.job }) };
  const check = await codeCheck({ lane: 'o11', module: 'Neutral', part: 'logic', element: 'Neutral', basedOn: textSha(readText), edits: edit.edits }, deps);
  assert.equal(check.ok, false); assert.match(JSON.stringify(check.problems), /no read of this textSha is kept/);
  assert.deepEqual(checked, [textSha(readText)]);
});

test('R5 createSsamServer deps.code(): each ssam_code check, plan and write takes the deps of its call', async t => {
  const { checkout, roots, dir } = layout(t);
  sessionCaptures(roots);
  let calls = 0;
  const server = await createSsamServer({ o11: true, odc: false, deps: { answersRoot: dir, lock: { o11Root: dir, odcRoot: dir, connection: () => null },
    code: () => { calls++; return { ...checkout, roots }; } } });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'code-roots', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  const elsewhere = put(dir, 'elsewhere/Any.oml', 'any');
  const check = values(await client.callTool({ name: 'ssam_code', arguments: { lane: 'o11', action: 'check', module: 'Neutral', part: 'logic', text: goodFlow, base: elsewhere } }));
  assert.equal(check.code, 'INPUT_INVALID', JSON.stringify(check));
  assert.match(JSON.stringify(check.problems), /base must be a capture/);
  const plan = values(await client.callTool({ name: 'ssam_code', arguments: { lane: 'o11', action: 'plan', module: 'Missing', items: [action('One')] } }));
  assert.equal(plan.code, 'CAPTURE_MISSING', JSON.stringify(plan));
  assert.equal(calls, 2);
});
