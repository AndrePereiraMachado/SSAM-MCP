// The gate of 2026-10-30, 18:41:49: a consumer job referenced 20 public service actions of FolhaPontoR3_a1Integracao, revision 3.
// The capture's Elements had the 5 entities the v98 bridge's reader knows; its SignatureBinary had the 20 service actions too. The
// answer was 20 x PRODUCER_NOT_PUBLISHED, "its open model has it, public, not published yet": false, and the model worked around it.
// One rule, here: what a capture holds is read from its own bytes by the kernel's one reader, and PRODUCER_NOT_PUBLISHED is said only
// of what was found. The bridge's list changes no answer.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deliverKernel, applyKernel, referenceSnapshot, readSignatureKernel, requiredFlowLayoutEngine } from '../kernel-delivery.mjs';
import { EVERY_KIND } from '../producer-publication.mjs';

const HOST = 'lab.outsystems.dev', CONSUMER = 'FolhaApp', PRODUCER = 'Integracao', MARKER = "<the user's own words>";
const sha = text => createHash('sha256').update(text).digest('hex');
const ENTITY = { Kind: 'entity', Name: 'Pais', Key: 'kPais' };
const SERVICE = { Kind: 'service-action', Name: 'ValidarUf', Key: 'kValidarUf' };

// published: what the signature's bytes hold. listed: what the bridge wrote beside them (v98: no service action).
function world(t, { published = [ENTITY, SERVICE], listed = [ENTITY], others = [], open = ['ValidarUf'], rev = 3, bridgeEmpty = false, readable = true, samePublished = false, publishedRevision = rev, status = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-reader-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const captures = path.join(root, 'snapshots'); fs.mkdirSync(captures);
  const calls = [];
  const openBytes = 'open model of ' + PRODUCER + ' ' + JSON.stringify(open);
  const studio = async ([step, ...rest]) => {
    calls.push(step);
    if (step === 'snapshot') {
      if (rest[0] === CONSUMER) {
        const base = path.join(captures, CONSUMER + '-base.oml'); fs.writeFileSync(base, 'consumer');
        return { ok: true, module: CONSUMER, path: base, sha256: sha('consumer').toUpperCase(), host: HOST, developerId: 'dev', moduleKey: 'kConsumer', dependencies: [] };
      }
      const file = path.join(captures, PRODUCER + '-' + sha(openBytes).toUpperCase() + '.oml'); fs.writeFileSync(file, openBytes);
      return { ok: true, module: PRODUCER, moduleKey: 'k' + PRODUCER, path: file, sha256: sha(openBytes).toUpperCase(), capturedAt: new Date().toISOString(), modified: false, host: HOST };
    }
    if (step === 'reference-snapshot') {
      const request = JSON.parse(rest[0]);
      if (bridgeEmpty) return { ok: false, error: 'Producer has no supported public elements' };
      const bytes = JSON.stringify({ FormatVersion: 2, Environment: HOST, ModuleKey: 'k' + PRODUCER, ModuleKind: 'eSpace', Name: PRODUCER, SignatureHash: 'sig-' + rev, Revision: String(rev), SignatureBinary: 'c2lnbmF0dXJl', Elements: listed });
      fs.mkdirSync(path.dirname(request.output), { recursive: true }); fs.writeFileSync(request.output, bytes);
      return { ok: true, path: request.output, environment: HOST, consumerUnchanged: true, sha256: sha(bytes).toUpperCase(), producer: PRODUCER, producerKey: 'k' + PRODUCER, revision: String(rev), elements: listed };
    }
    if (step === 'status') return { ok: true, pid: 7, ...status, modules: [{ name: CONSUMER, key: 'kConsumer', host: HOST }, { name: PRODUCER, key: 'k' + PRODUCER, host: HOST }] };
    if (step === 'reference-producers') return { ok: true, producers: [{ name: PRODUCER, key: 'k' + PRODUCER }] };
    if (step === 'merge') return { ok: true, merged: true, strictlyEqual: true };
    return { ok: true };
  };
  const producerDigest = async () => ({ ok: true, sourceSha256: 'x', digest: { schema: 'ssam-digest/1', module: { name: PRODUCER, kind: 'CrossDevice' }, sections: [],
    actions: open.map(n => ({ key: 'k' + n, kind: 'ServiceAction', name: n, section: 'actions', public: true })) } });
  const evidence = path.join(root, 'lab', '01-' + PRODUCER, 'delivery', 'evidence'); fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, '..', 'manifest.json'), JSON.stringify({ module: PRODUCER, moduleKey: 'k' + PRODUCER, tenant: HOST, evidenceDir: evidence }));
  fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: '2026-10-30T21:00:00Z' }));
  fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, strictlyEqual: true, sha256: sha(openBytes).toUpperCase() }));
  if (samePublished) {
    fs.writeFileSync(path.join(evidence, 'publish-started.json'), '{}');
    fs.writeFileSync(path.join(evidence, 'publish-receipt.json'), JSON.stringify({ ok: true, published: { revision: publishedRevision }, completedAt: '2026-10-30T21:01:00Z' }));
  }
  const readSignature = async () => { calls.push('read-signature'); return readable ? { ok: true, elements: published, others } : { ok: false, error: 'the signature could not be parsed' }; };
  const cli = path.join(root, 'anvil-odc.dll'); fs.writeFileSync(cli, 'not a CLI');
  // The build reads the same bytes (NativeReferenceSnapshot.Read): it finds what readSignature finds.
  const exec = async (_dotnet, argv) => {
    const at = f => argv[argv.indexOf(f) + 1];
    const job = JSON.parse(fs.readFileSync(at('--job'), 'utf8'));
    calls.push('apply');
    const results = [];
    for (const op of job.ops) if (op.op === 'reference') for (const element of op.elements) {
      assert.ok(published.some(e => e.Name === element.split(':')[1]), 'the build reads the signature: ' + element);
      results.push({ op: 'reference', result: { producer: op.producer, producerKey: 'k' + op.producer, signatureHash: 'sig-' + rev, referenceExisted: false, referenceHashBefore: null } });
    }
    fs.writeFileSync(at('--out'), 'candidate');
    return { stdout: JSON.stringify({ ok: true, command: 'apply', data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, validation: {}, results } }), stderr: '' };
  };
  let lab = 0;
  const deps = { root, studio, guide: null, cache: null, journal: () => {}, prefetch: async () => {}, nextLabDir: () => path.join(root, 'lab-' + (++lab)), signatureCache: path.join(root, '.local', 'producer-cache'),
    producerDigest, readSignature, publishLab: path.join(root, 'lab'),
    apply: args => applyKernel(args, { cli, runOnWorker: async () => ({ used: false }), exec, contentSha: null }),
    prepareManifest: async ({ output }) => { fs.mkdirSync(output, { recursive: true }); const m = path.join(output, 'manifest.json'); fs.writeFileSync(m, '{}'); return { ok: true, manifest: m }; } };
  fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify({ ops: [{ op: 'reference', producer: PRODUCER, elements: ['ServiceAction:ValidarUf'] }] }));
  return { root, calls, deps, input: { module: CONSUMER, feature: 'f', job: 'job.json', owners: ['Owner'], changes: ['Uses the service action'] } };
}
const text = value => JSON.stringify(value);
const tools = continuation => { const out = []; for (let s = continuation; s; s = s.then) out.push(s.tool ?? s.by + ':' + s.action); return out; };

test('a bridge that does not list a service action changes no answer: the signature holds it, the delivery builds, and the receipt says so', async t => {
  const w = world(t, {});
  const r = await deliverKernel(w.input, w.deps);
  assert.notEqual(r.code, 'PRODUCER_NOT_PUBLISHED', text(r.problems));
  assert.ok(w.calls.includes('read-signature'), w.calls.join(' | '));
  assert.ok(w.calls.includes('apply'), 'the build ran: ' + w.calls.join(' | '));
  assert.match(text(r.producers ?? r), /does not list ServiceAction:ValidarUf/);
});

test('a list that already has the element reads no signature: the common delivery costs nothing', async t => {
  const w = world(t, { listed: [ENTITY, SERVICE] });
  await deliverKernel(w.input, w.deps);
  assert.ok(!w.calls.includes('read-signature'), w.calls.join(' | '));
  assert.ok(w.calls.includes('apply'));
});

test('PRODUCER_NOT_PUBLISHED when it was found: the bytes lack it, the open model has it public, the open module is not what was published', async t => {
  const w = world(t, { published: [ENTITY] });
  const r = await deliverKernel(w.input, w.deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text(r.problems));
  assert.equal(r.continuation.tool, 'studio_publish');
  assert.equal(r.continuation.arguments.authorize, MARKER);
  assert.ok(!w.calls.includes('apply'));
});

test('a signature that cannot be read is never called not published: another code, the truth, and a continuation that asks no publication', async t => {
  const w = world(t, { readable: false });
  const r = await deliverKernel(w.input, w.deps);
  assert.equal(r.code, 'PRODUCER_SIGNATURE_UNVERIFIED', text(r.problems));
  assert.equal(r.problems[0].code, 'PRODUCER_SIGNATURE_UNVERIFIED');
  assert.match(r.problems[0].message, /could not confirm/);
  assert.match(r.problems[0].message, /could not be parsed/);
  assert.ok(!/not published yet/.test(text(r)), text(r.problems));
  assert.deepEqual(tools(r.continuation), ['studio_reference_snapshot', 'studio_deliver']);
  assert.ok(!text(r.continuation).includes('studio_publish'));
  assert.ok(!w.calls.includes('apply'));
});

test('the open module is the merge published as this revision: nothing shows it unpublished, and the person\'s publication is the way out', async t => {
  const w = world(t, { published: [ENTITY], samePublished: true });
  const r = await deliverKernel(w.input, w.deps);
  assert.equal(r.code, 'PRODUCER_SIGNATURE_UNVERIFIED', text(r.problems));
  assert.match(r.problems[0].message, /cannot tell why/);
  assert.deepEqual(tools(r.continuation), ['person:publish', 'studio_deliver']);
  assert.ok(!text(r.continuation).includes('authorize'), 'no tool publishes it');
});

test('another revision published since the merge is no proof of anything of the sort: it is found, and the person publishes', async t => {
  const w = world(t, { published: [ENTITY], samePublished: true, publishedRevision: 2 });
  const r = await deliverKernel(w.input, w.deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text(r.problems));
});

test('a bridge that says "no public elements" of a module whose public elements it cannot list proves nothing (delivery)', async t => {
  const w = world(t, { bridgeEmpty: true });
  const r = await deliverKernel(w.input, w.deps);
  assert.equal(r.code, 'PRODUCER_SIGNATURE_UNVERIFIED', text(r.problems));
  assert.match(r.problems[0].message, /before any signature exists/);
  assert.ok(!/exports no public element/.test(r.error), 'what it did not confirm is not said: ' + r.error);
  // No call of a tool gets out of here: attaching again loads the same bridge (no v101 reaches a v98 agent, net8 Studios stay on v97).
  // The way out is the person's, and it says what is missing: both ways are real, the first test of this file is the second one.
  assert.deepEqual(tools(r.continuation), ['person:update-agent', 'studio_deliver']);
  assert.ok(!text(r.continuation).includes('studio_attach'), text(r.continuation));
  assert.match(r.continuation.why, /reference-snapshot:every-kind/);
  assert.match(r.continuation.why, /one more public element/);
  // A running Studio keeps the bridge it loaded: the update counts only after it is reopened, and nothing is clicked inside it.
  assert.match(r.continuation.why, /closed and opened again/);
  assert.match(r.continuation.why, /nothing to click inside it/);
  assert.deepEqual(r.sequence, ['the person updates the SSAM agent, or makes one more element of Integracao public and publishes it', 'studio_deliver FolhaApp']);
});

test('the second way out is real: with one more public element the v98 bridge writes a capture, and the bytes have the service actions', async t => {
  const w = world(t, { listed: [{ Kind: 'structure', Name: 'Extra', Key: 'kExtra' }], published: [{ Kind: 'structure', Name: 'Extra', Key: 'kExtra' }, SERVICE] });
  const r = await deliverKernel(w.input, w.deps);
  assert.ok(![ 'PRODUCER_SIGNATURE_UNVERIFIED', 'PRODUCER_NOT_PUBLISHED' ].includes(r.code), text(r.problems));
  assert.ok(w.calls.includes('apply'), w.calls.join(' | '));
});

// A bridge's silence is a finding only by what it says it can do, never by its number. DLLs named v101 were built before the one reader:
// what their code says of itself is in this fixture, measured from their bytes; a DLL given by SSAM_BRIDGE_DLL_WITHOUT_READER is compared with it.
const WITHOUT_READER = JSON.parse(fs.readFileSync(new URL('./fixtures/bridge-without-reader.json', import.meta.url), 'utf8'));
// The user strings of a .NET assembly are UTF-16 at any offset: both alignments.
const textOf = file => { const bytes = fs.readFileSync(file); return bytes.toString('utf16le') + '\n' + bytes.subarray(1).toString('utf16le'); };
const capabilitiesOf = file => [...new Set(textOf(file).match(/(?:merge:normalized|template-download:have|agent-root:1|reference-snapshot:[a-z-]+)/g) ?? [])].sort();
const dllGiven = process.env.SSAM_BRIDGE_DLL_WITHOUT_READER;
test('the fixture is what a DLL without the reader says of itself', { skip: dllGiven ? false : 'no DLL on this run: SSAM_BRIDGE_DLL_WITHOUT_READER names one to compare with the fixture' }, () => {
  assert.equal(textOf(dllGiven).includes('ReferenceServiceAPIMethod'), WITHOUT_READER.holdsServiceActionTag);
  assert.deepEqual(capabilitiesOf(dllGiven), WITHOUT_READER.capabilities);
});
test('a DLL named v101 without the reader never makes the silence a finding', async t => {
  assert.equal(WITHOUT_READER.holdsServiceActionTag, false, 'this fixture is a DLL without the reader');
  assert.ok(WITHOUT_READER.capabilities.includes('agent-root:1') && !WITHOUT_READER.capabilities.includes(EVERY_KIND), String(WITHOUT_READER.capabilities));
  const w = world(t, { bridgeEmpty: true, status: { bridge: WITHOUT_READER.bridge, capabilities: WITHOUT_READER.capabilities } });
  const r = await deliverKernel(w.input, w.deps);
  assert.equal(r.code, 'PRODUCER_SIGNATURE_UNVERIFIED', text(r.problems));
  assert.ok(!text(r.continuation).includes('authorize'), 'no publication is proposed');
});

test('a bridge that says it lists every kind makes its silence a finding, whatever its number', async t => {
  const w = world(t, { bridgeEmpty: true, status: { bridge: 'v7', capabilities: ['agent-root:1', EVERY_KIND] } });
  const r = await deliverKernel(w.input, w.deps);
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED', text(r.problems));
  assert.equal(r.continuation.tool, 'studio_publish');
  const named = world(t, { bridgeEmpty: true, status: { bridge: 'v999', capabilities: ['agent-root:1'] } });
  assert.equal((await deliverKernel(named.input, named.deps)).code, 'PRODUCER_SIGNATURE_UNVERIFIED', 'a number proves nothing');
  const empty = await referenceSnapshot({ module: CONSUMER, producer: PRODUCER, output: path.join(w.root, 'x', 'I.avsig'), pid: 7 },
    { studio: world(t, { bridgeEmpty: true, status: { capabilities: [EVERY_KIND] } }).deps.studio, captureDir: path.join(w.root, 'snapshots'), producerDigest: w.deps.producerDigest, lab: path.join(w.root, 'lab'), root: w.root });
  assert.equal(empty.code, 'PRODUCER_NOT_PUBLISHED', text(empty));
});

test('the same silence on studio_reference_snapshot: the truth and the newest bridge, no publication', async t => {
  const w = world(t, { bridgeEmpty: true });
  const r = await referenceSnapshot({ module: CONSUMER, producer: PRODUCER, output: path.join(w.root, 'x', 'I.avsig'), pid: 7 },
    { studio: w.deps.studio, captureDir: path.join(w.root, 'snapshots'), producerDigest: w.deps.producerDigest, lab: path.join(w.root, 'lab'), root: w.root });
  assert.equal(r.code, 'PRODUCER_SIGNATURE_UNVERIFIED', text(r));
  assert.ok(!/not published/.test(r.error), r.error);
  assert.match(r.error, /before any signature exists/);
  assert.deepEqual(tools(r.continuation), ['person:update-agent', 'studio_reference_snapshot']);
});

test('studio_reference_snapshot answers what the signature holds, and says the rest of what it holds', async t => {
  const others = [{ tag: 'ReferenceGlobalEvent', name: 'Mudou', key: 'kEvent' }];
  const w = world(t, { others });
  const r = await referenceSnapshot({ module: CONSUMER, producer: PRODUCER, output: path.join(w.root, 'x', 'I.avsig'), pid: 7 }, { studio: w.deps.studio, readSignature: w.deps.readSignature });
  assert.equal(r.ok, true);
  assert.deepEqual(r.elements.map(e => e.kind + ':' + e.name), ['entity:Pais', 'service-action:ValidarUf']);
  assert.deepEqual(r.others, others);
  assert.match(r.note, /listed 1 element.*holds 2/);
});

test('readSignatureKernel: the kernel\'s answer, its refusal said, and a capture without bytes has only its list', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-reader-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'anvil-odc.dll'); fs.writeFileSync(cli, 'x');
  const held = path.join(dir, 'a.avsig'); fs.writeFileSync(held, JSON.stringify({ SignatureBinary: 'c2ln', Elements: [ENTITY] }));
  const bare = path.join(dir, 'b.avsig'); fs.writeFileSync(bare, JSON.stringify({ Elements: [ENTITY] }));
  const asked = [];
  const ok = await readSignatureKernel(held, { cli, exec: async (_d, argv) => { asked.push(argv.slice(1)); return { stdout: JSON.stringify({ ok: true, data: { elements: [{ kind: 'service-action', name: 'V', key: 'k' }], others: [{ tag: 'T', name: 'N', key: 'o' }] } }), stderr: '' }; } });
  assert.deepEqual(asked[0], ['signature-elements', '--avsig', held]);
  assert.deepEqual(ok, { ok: true, elements: [{ Kind: 'service-action', Name: 'V', Key: 'k' }], others: [{ tag: 'T', name: 'N', key: 'o' }] });
  const bad = await readSignatureKernel(held, { cli, exec: async () => { const e = new Error('exit 1'); e.stdout = JSON.stringify({ ok: false, error: 'Expected a public module signature' }); e.stderr = ''; e.code = 1; throw e; } });
  assert.deepEqual(bad, { ok: false, error: 'Expected a public module signature' });
  assert.deepEqual(await readSignatureKernel(bare, { cli, exec: async () => assert.fail('no bytes, no kernel') }), { ok: true, elements: [ENTITY], others: [] });
  assert.equal((await readSignatureKernel(held, { cli: path.join(dir, 'none.dll') })).ok, false);
  // A file cut in half or gone is no capture without bytes: never an empty signature with ok:true.
  const cut = path.join(dir, 'c.avsig'); fs.writeFileSync(cut, '{"SignatureBinary":"c2');
  const none = v => assert.equal(v.ok, false, text(v));
  none(await readSignatureKernel(cut, { cli, exec: async () => assert.fail('no bytes, no kernel') }));
  none(await readSignatureKernel(path.join(dir, 'gone.avsig'), { cli, exec: async () => assert.fail('no file, no kernel') }));
});
