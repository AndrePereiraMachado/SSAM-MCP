// fix/a5-lows: the low findings of the producer-name family left after fix/system-reference (review C:\t\revisoes\system-ref-3,
// RELATORIO.md B9, B10, B11; C:\t\fix-system-ref\RESULTADO-4.md). One rule each, on every lane that has it:
//   B9  the O11 PRODUCER_UNKNOWN continuation for an explicit captureProducers name with / or \ is a call the tools accept;
//   B10 a producers-map key with / or \ is matched only by its exact text: it never binds an op written otherwise
//       ("..\System" never binds the op "(System)"); one refusal names every such key, before anything is captured or built;
//   B11 a capture reused under another name than the job's carries the same note as the delivery that captured it.
// Synthetic values only; a fake consumer session, a fake apply and a fake Anvil CLI; every folder is temporary.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { deliverKernel } from '../kernel-delivery.mjs';
import { o11UnknownProducer, producerBindings } from '../producer-names.mjs';
import { producerArgs as o11ProducerArgs, registerO11Cycle } from '../o11-cycle.mjs';
import { producerArgs as ssamProducerArgs } from '../ssam.mjs';
import { jobToolRequest } from '../job-runner.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with { type: 'json' };

const BS = String.fromCharCode(92);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HOST = 'fixture.test';
const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };

// ---- B9
test('B9: the O11 PRODUCER_UNKNOWN continuation for captureProducers ["Wright/Flood Lib"] binds it by its key, and the filled call is accepted', () => {
  const problems = [{ code: 'PRODUCER_UNKNOWN', producer: 'Wright/Flood Lib', available: ['Wright / Flood Lib', '(System)'] }];
  const call = { tool: 'o11_deliver', arguments: { module: 'M', job: 'C:\\x\\job.json', captureProducers: ['Wright/Flood Lib'], authorize: '<w>' } };
  const unknown = o11UnknownProducer(problems, { call, captures: ['Wright/Flood Lib'] });
  assert.deepEqual(unknown.continuation.arguments.captureProducers, ['WrightFloodLib=<a name of available>']);
  assert.match(unknown.continuation.why, /^Bind WrightFloodLib to one of the names in available/);
  const filled = unknown.continuation.arguments.captureProducers.map(entry => entry.replace('<a name of available>', 'Wright / Flood Lib'));
  assert.deepEqual(o11ProducerArgs({}, filled), ['--capture-producer', 'WrightFloodLib=Wright / Flood Lib']);
  assert.equal(jobToolRequest({ lane: 'o11', job: 'C:\\x\\job.json', captureProducers: filled }).ok, true);
  // the same through the ambiguous refusal, and with a backslash
  const ambiguous = o11UnknownProducer([{ code: 'PRODUCER_AMBIGUOUS', producer: 'Wright' + BS + 'Flood Lib', available: ['A', 'B'] }],
    { call: { tool: 'o11_job', arguments: { lane: 'o11', job: 'C:\\x\\job.json', captureProducers: ['Wright' + BS + 'Flood Lib'] } }, captures: ['Wright' + BS + 'Flood Lib'] });
  assert.deepEqual(ambiguous.continuation.arguments.captureProducers, ['WrightFloodLib=<a name of candidates>']);
  // control: the automatic entry (Key=Name) and a plain name keep their continuation
  const auto = o11UnknownProducer([{ code: 'PRODUCER_UNKNOWN', producer: 'Wright/Flood Lib', available: ['Wright / Flood Lib'] }],
    { call: { tool: 'o11_deliver', arguments: { module: 'M', job: 'C:\\x\\job.json' } }, captures: ['WrightFloodLib=Wright/Flood Lib'] });
  assert.deepEqual(auto.continuation.arguments.captureProducers, ['WrightFloodLib=<a name of available>']);
  const plain = o11UnknownProducer([{ code: 'PRODUCER_UNKNOWN', producer: 'Sistema', available: ['(System)'] }],
    { call: { tool: 'o11_deliver', arguments: { module: 'M', job: 'C:\\x\\job.json', captureProducers: ['Sistema'] } }, captures: ['Sistema'] });
  assert.deepEqual(plain.continuation.arguments.captureProducers, ['Sistema=<a name of available>']);
});

// ---- B10 (pure rule, every lane)
test('B10: a producers-map key with / or \\ binds only ops of exactly its text; else ONE refusal naming every such key', () => {
  const file = 'C:\\captures\\other.avsig';
  // "..\System" for a job that names "(System)": never re-read as the producer of its letters
  const k = producerBindings({ ['..' + BS + 'System']: file }, { names: ['(System)'] });
  assert.deepEqual(k.bindings, {});
  assert.equal(k.problems.length, 1);
  assert.match(k.problems[0].error, /binds only the reference ops whose producer is exactly that text/);
  assert.match(k.problems[0].error, /names "\(System\)"/);
  // the exact text binds by the key of its letters (round 3, H1-R), case and outer parentheses aside
  assert.deepEqual(producerBindings({ 'Wright/Flood Lib': file }, { names: ['Wright/Flood Lib'] }), { bindings: { WrightFloodLib: file }, problems: [] });
  assert.deepEqual(producerBindings({ 'Wright/Flood Lib': file }, { names: ['(wright/flood lib)'] }).problems, []);
  // the slot also written another way: the key would bind that op too
  const twice = producerBindings({ 'Wright/Flood Lib': file }, { names: ['Wright/Flood Lib', 'WrightFloodLib'] });
  assert.deepEqual(twice.bindings, {});
  assert.match(twice.problems[0].error, /also names its slot WrightFloodLib as "WrightFloodLib"/);
  // every such key in one answer
  const two = producerBindings({ ['..' + BS + 'System']: file, 'a/b': file, Users: file }, { names: ['(System)', 'Users'] });
  assert.deepEqual(two.problems.map(p => p.at), ['producers/..' + BS + 'System', 'producers/a/b']);
  assert.deepEqual(two.bindings, { Users: file });
  // a key without a separator is unchanged ("(System)" and "System" are one producer)
  assert.deepEqual(producerBindings({ '(System)': file }, { names: ['System'] }), { bindings: { System: file }, problems: [] });
  // O11 (o11_deliver) and the job tools: the same rule, one refusal
  assert.throws(() => o11ProducerArgs({ ['..' + BS + 'System']: file, 'a/b': 'published' }, [], { names: ['(System)'] }),
    e => e.code === 'PRODUCER_INVALID' && /\.\.\\System/.test(e.message) && /a\/b/.test(e.message) && /exactly that text/.test(e.message));
  assert.deepEqual(o11ProducerArgs({ 'Wright/Flood Lib': file }, [], { names: ['Wright/Flood Lib'] }), ['--producer', 'WrightFloodLib=' + file]);
  assert.throws(() => ssamProducerArgs({ ['..' + BS + 'System']: file }, [], { names: ['(System)'] }), /exactly that text/);
  assert.deepEqual(ssamProducerArgs({ 'Wright/Flood Lib': file }, [], { names: ['Wright/Flood Lib'] }), ['--producer', 'WrightFloodLib=' + file]);
});

// ---- B10 on the ODC delivery (probe r3c K): nothing captured, built or merged
test('B10 (ODC): studio_deliver with producers {"..\\System": a capture of another producer} for a job naming "(System)" is refused before the Studio', async t => {
  const root = temp(t, 'a5l-k-');
  const file = path.join(root, 'other.avsig');
  fs.writeFileSync(file, JSON.stringify({ FormatVersion: 2, Environment: HOST, ModuleKey: 'kOther', Name: 'Flood Utils', SignatureHash: 'h-other', Revision: '3', Elements: [] }));
  const calls = [], applied = [];
  const studio = async ([step]) => { calls.push(step); return step === 'snapshot' ? { ok: true, path: path.join(root, 'base.oml'), sha256: 'HASH', host: HOST } : { ok: true }; };
  let lab = 0;
  const deps = { root, studio, cache: null, guide: null, journal: () => {}, nextLabDir: () => path.join(root, 'lab-' + (++lab)), signatureCache: path.join(root, '.local', 'pc'),
    apply: async input => { applied.push(input); return { ok: true, candidate: 'c.oml', receipt: 'r.json' }; }, prepareManifest: async () => ({ ok: true, manifest: 'm.json' }) };
  fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify({ ops: [{ op: 'reference', producer: '(System)', elements: ['ClientAction:ListAppendAll'] }] }));
  await assert.rejects(deliverKernel({ module: 'FloodQuotes', feature: 'f', job: 'job.json', owners: ['A'], changes: ['B'], producers: { ['..' + BS + 'System']: file } }, deps),
    error => /binds only the reference ops whose producer is exactly that text/.test(error.message) && /names "\(System\)"/.test(error.message));
  assert.deepEqual(calls, []);
  assert.deepEqual(applied, []);
});

// ---- B10 on the O11 delivery: the same refusal, before the CLI runs
function o11Box(t) {
  const base = temp(t, 'a5l-o11-');
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority'), studio = path.join(base, 'Studio');
  for (const dir of [root, home, auth]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  const env = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242,
    startedUtc: '2026-10-02T00:00:00Z', studioDir: studio, authorityDir: auth, port: 45999 }));
  let clock = Date.parse('2026-10-02T10:15:00.000Z');
  const runAnvil = fakeAnvil({ deliver: () => envelopes.delivered });
  return { base, root, runAnvil, deps: { root, env, lane: 'ss4', now: () => new Date(clock += 1000), runAnvil, assertSelected: async () => {} } };
}
async function serve(t, deps) {
  const server = new McpServer({ name: 'a5l-o11', version: '1.0.0' });
  registerO11Cycle(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'a5l-o11-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return (name, args) => client.callTool({ name, arguments: args });
}

test('B10 (O11): o11_deliver with producers {"..\\System": file} for a job naming "(System)" is ONE PRODUCER_INVALID and the CLI never runs', async t => {
  const box = o11Box(t);
  const avsig = path.join(box.base, 'other.avsig'); fs.writeFileSync(avsig, '{}');
  const job = path.join(box.base, 'jobs', 'ref.json');
  fs.mkdirSync(path.dirname(job), { recursive: true });
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'reference', producer: '(System)', elements: ['ServerAction:GetUserId'] }] }));
  const call = await serve(t, box.deps);
  const words = 'sim, pode entregar no Orders';
  const refused = await call('o11_deliver', { module: 'Orders', job, producers: { ['..' + BS + 'System']: avsig }, authorize: words });
  assert.equal(refused.structuredContent.code, 'PRODUCER_INVALID', JSON.stringify(refused.structuredContent));
  assert.match(refused.structuredContent.error ?? refused.content[0].text, /exactly that text/);
  assert.equal(box.runAnvil.calls.length, 0);
  // control: the job's own text binds
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'reference', producer: 'Wright/Flood Lib', elements: ['ServerAction:GetUserId'] }] }));
  await call('o11_deliver', { module: 'Orders', job, producers: { 'Wright/Flood Lib': avsig }, authorize: words });
  assert.ok(box.runAnvil.calls.length >= 1);
  assert.ok(box.runAnvil.calls.at(-1).args.includes('WrightFloodLib=' + avsig), JSON.stringify(box.runAnvil.calls.at(-1).args));
});

// ---- B11 (probe r3b P2)
test('B11: a capture reused from the ledger under another listed name carries the note the capturing delivery gave', async t => {
  const root = temp(t, 'a5l-p2-');
  const listed = [{ name: 'OutSystems UI', key: 'kA' }, { name: '(System)', key: 'kS' }];
  const studio = async ([step, argument]) => {
    if (step === 'reference-snapshot') {
      const request = JSON.parse(argument);
      const p = listed.find(x => x.name.toLowerCase() === String(request.producer).toLowerCase());
      if (!p) return { ok: false, error: 'Producer is not available to the consumer session: ' + request.producer };
      const bytes = JSON.stringify({ FormatVersion: 2, Environment: HOST, ModuleKey: p.key, Name: p.name, SignatureHash: 'hash-7', Revision: '7', Elements: [] });
      fs.mkdirSync(path.dirname(request.output), { recursive: true }); fs.writeFileSync(request.output, bytes);
      return { ok: true, path: request.output, environment: HOST, consumerUnchanged: true, sha256: sha(bytes).toUpperCase(), producer: p.name, producerKey: p.key, revision: '7' };
    }
    if (step === 'reference-producers') return { ok: true, producers: listed };
    if (step === 'snapshot') return { ok: true, path: path.join(root, 'base.oml'), sha256: 'BASE', host: HOST };
    if (step === 'merge') return { ok: true, merged: true, strictlyEqual: true };
    return { ok: true };
  };
  let lab = 0;
  const deps = { root, studio, guide: null, cache: null, journal: () => {}, nextLabDir: () => path.join(root, 'lab-' + (++lab)), prefetch: async () => {},
    apply: async () => ({ ok: true, candidate: path.join(root, 'candidate.oml'), receipt: 'kernel-result.json' }),
    signatureCache: path.join(root, '.local', 'producer-cache'), prepareManifest: async () => ({ ok: true, manifest: path.join(root, 'manifest.json') }) };
  fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify({ ops: [{ op: 'reference', producer: 'OutSystemsUI', elements: ['ClientAction:X'] }] }));
  const input = { module: 'FloodQuotes', feature: 'f', job: 'job.json', owners: ['A'], changes: ['B'] };
  const first = await deliverKernel({ ...input }, deps);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.producerNotes?.length, 1);
  const second = await deliverKernel({ ...input }, deps);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.producers[0].reused, true);
  assert.equal(second.producers[0].studioName, 'OutSystems UI');
  assert.deepEqual(second.producerNotes, first.producerNotes);
  assert.match(second.producerNotes[0].note, /no producer named "OutSystemsUI"; it lists "OutSystems UI"/);
  // control: a capture reused under the job's own text says nothing
  fs.writeFileSync(path.join(root, 'job2.json'), JSON.stringify({ ops: [{ op: 'reference', producer: 'OutSystems UI', elements: ['ClientAction:X'] }] }));
  const plain = await deliverKernel({ ...input, job: 'job2.json' }, deps);
  assert.equal(plain.ok, true);
  assert.equal(plain.producerNotes, undefined);
});
