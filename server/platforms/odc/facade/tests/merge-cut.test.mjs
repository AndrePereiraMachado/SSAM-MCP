// The check of a delivery after a cut merge (merge-cut.mjs), the bridge's side of it (StartupHook.cs Run), and the answers that stopped
// deciding it (reviews G21-G26). The end-to-end count is in merge-cut-obedient.test.mjs.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cutJobSha, cutVerdict, markCutRead, mergeManifestRefusal, notAtBaseRefusal, readCut, recordCut } from '../merge-cut.mjs';
import { baseContentSha256 } from '../kernel-delivery.mjs';
import { compactDelivery } from '../responses.mjs';
import { deliveryMerges, resolveDeliveryManifest } from '../studio-publish-log.mjs';
import { reconcileMerge } from '../merge-reconcile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ID = { moduleKey: 'k', host: 'h.test' };
const cut = (over = {}) => ({ at: 'then', pid: 1, jobs: { J: 'BASE' }, repairs: ['R'], read: false, ...over });
const box = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-cut-unit-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; };

test('the same job goes only over its own base, whatever was read', () => {
  assert.deepEqual(cutVerdict(cut(), { openSha256: 'base', jobSha256: 'J', pid: 1 }), { refuse: false });
  for (const read of [false, true]) assert.deepEqual(cutVerdict(cut({ read }), { openSha256: 'OTHER', jobSha256: 'J', pid: 1 }), { refuse: true, reason: 'not-at-base' });
});

test('a different job over a module that is not the base goes only after a reading; over the base, it goes', () => {
  assert.deepEqual(cutVerdict(cut(), { openSha256: 'OTHER', jobSha256: 'N', pid: 1 }), { refuse: true, reason: 'not-read' });
  assert.deepEqual(cutVerdict(cut({ read: true }), { openSha256: 'OTHER', jobSha256: 'N', pid: 1 }), { refuse: false });
  assert.deepEqual(cutVerdict(cut(), { openSha256: 'BASE', jobSha256: 'N', pid: 1 }), { refuse: false });
});

test('the repair a cut computed is known by its hash: it needs no reading', () => {
  assert.equal(cutVerdict(cut(), { openSha256: 'OTHER', jobSha256: 'R', pid: 1 }).refuse, false);
  assert.equal(cutVerdict(cut(), { openSha256: 'OTHER', jobSha256: 'R', pid: 2, alive: [1, 2] }).refuse, false);
});

test('another Studio process that is still there: refused unknown; gone: only the bytes decide (G21)', () => {
  assert.deepEqual(cutVerdict(cut(), { openSha256: 'BASE', jobSha256: 'J', pid: 2, alive: [1, 2] }), { refuse: true, reason: 'other-studio' });
  assert.deepEqual(cutVerdict(cut(), { openSha256: 'BASE', jobSha256: 'J', pid: 2, alive: null }), { refuse: true, reason: 'other-studio' }, 'nobody could say: not known to be gone');
  assert.deepEqual(cutVerdict(cut(), { openSha256: 'BASE', jobSha256: 'J', pid: 2, alive: [2] }), { refuse: false });
  assert.deepEqual(cutVerdict(cut({ read: true }), { openSha256: 'OTHER', jobSha256: 'N', pid: 2, alive: [1, 2] }), { refuse: false }, 'a correction after the reading');
});

test('no pid on either side: the list of Studios decides, and with no list it is refused (G32)', () => {
  for (const [cutPid, pid] of [[null, null], [1, null], [null, 1]]) {
    const record = cut({ pid: cutPid });
    assert.deepEqual(cutVerdict(record, { openSha256: 'BASE', jobSha256: 'J', pid, alive: [1, 2] }), { refuse: true, reason: 'other-studio' }, 'two open');
    assert.deepEqual(cutVerdict(record, { openSha256: 'BASE', jobSha256: 'J', pid, alive: null }), { refuse: true, reason: 'other-studio' }, 'nobody can say');
    assert.deepEqual(cutVerdict(record, { openSha256: 'BASE', jobSha256: 'J', pid, alive: [1] }), { refuse: false }, 'only one open');
    assert.deepEqual(cutVerdict(record, { openSha256: 'OTHER', jobSha256: 'N', pid, alive: [1, 2] }), { refuse: true, reason: 'other-studio' }, 'a new job, before a reading');
    assert.deepEqual(cutVerdict({ ...record, read: true }, { openSha256: 'OTHER', jobSha256: 'N', pid, alive: [1, 2] }), { refuse: false }, 'a new job, after it');
  }
  const unnamed = notAtBaseRefusal(cut({ pid: null }), { reason: 'other-studio', jobSha256: 'J', openSha256: 'BASE', module: 'M' });
  assert.match(unnamed.error, /more than one ODC Studio/);
  assert.doesNotMatch(unnamed.error, /process null|undefined/);
});

test('the refusal says what is there, never a delivery, and merged stays unknown', () => {
  for (const reason of ['not-at-base', 'not-read', 'other-studio']) {
    const refusal = notAtBaseRefusal(cut(), { reason, jobSha256: 'J', openSha256: 'OPEN', module: 'M', pid: 2 });
    assert.equal(refusal.code, 'MODULE_NOT_AT_BASE');
    assert.equal(refusal.merged, null);
    assert.equal(refusal.baseSha256, 'BASE');
    assert.equal(refusal.openSha256, 'OPEN');
    assert.deepEqual(Object.keys(refusal.cut), ['at', 'pid'], 'no folder of this server in an answer');
    assert.match(refusal.error, /Nothing was built or merged/);
    assert.notEqual(refusal.continuation.tool, 'studio_deliver');
    assert.ok(!JSON.stringify(refusal.continuation).includes('authorize'));
  }
  assert.match(notAtBaseRefusal(cut(), { reason: 'other-studio', jobSha256: 'J', openSha256: 'BASE', module: 'M', pid: 2 }).error, /process 1, which is still open/);
});

test('the record: a job keeps its first base, jobs accumulate, a reading never frees a job', t => {
  const root = box(t);
  recordCut(root, ID, { jobSha256: 'J', baseSha256: 'B1', pid: 1, repairs: ['R'] });
  recordCut(root, ID, { jobSha256: 'J', baseSha256: 'B2', pid: 1 });
  recordCut(root, ID, { jobSha256: 'N', baseSha256: 'B3', pid: 1, repairs: ['S'] });
  markCutRead(root, ID);
  const record = readCut(root, ID);
  assert.deepEqual(record.jobs, { J: 'B1', N: 'B3' });
  assert.deepEqual(record.repairs, ['R', 'S']);
  assert.equal(record.read, true);
  assert.equal(cutVerdict(record, { openSha256: 'B3', jobSha256: 'J', pid: 1 }).refuse, true);
  assert.equal(readCut(root, { moduleKey: 'k', host: 'another.test' }), null, 'another tenant is another asset');
  assert.equal(cutJobSha({ a: 1 }), cutJobSha({ a: 1 }));
  assert.notEqual(cutJobSha({ a: 1 }), cutJobSha({ a: 2 }));
});

test('a merge reached by another road takes the same rule, on its manifest', t => {
  const root = box(t);
  const manifest = { module: 'M', moduleKey: 'k', tenant: 'h.test', baseSha256: 'OTHER' };
  assert.equal(mergeManifestRefusal(root, manifest), null, 'no record');
  recordCut(root, ID, { jobSha256: 'J', baseSha256: 'content', rawBaseSha256: 'B1', pid: 1 });
  const refused = mergeManifestRefusal(root, manifest);
  assert.equal(refused.ok, false); assert.equal(refused.code, 'MODULE_NOT_AT_BASE');
  assert.equal(mergeManifestRefusal(root, { ...manifest, baseSha256: 'b1' }), null, 'over the base on record: the bridge compares it with the open module');
  assert.equal(mergeManifestRefusal(root, { ...manifest, afterCut: true }), null, 'a delivery that passed the check');
  markCutRead(root, ID);
  assert.equal(mergeManifestRefusal(root, manifest), null, 'read');
});

test('an unchanged module after a restart is its base: the Studio state in the header of an OML does not count, a change of the model does', async t => {
  const root = box(t);
  const oml = (state, nodes, model) => {
    const records = Array.from({ length: 16 }, (_, i) => i === 15 ? state : 'r' + i);
    records.push('/NodesShownInESpaceTree.' + nodes);
    const header = Buffer.from(records.join('|'), 'utf8');
    const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
    return Buffer.concat([Buffer.from('OML'), length, header, Buffer.from(model)]);
  };
  const capture = (name, bytes) => { const file = path.join(root, name); fs.writeFileSync(file, bytes); return { path: file, sha256: 'raw-' + name }; };
  const first = capture('first.oml', oml('A'.repeat(27) + '=', 'a.b', 'the model'));
  const restarted = capture('restarted.oml', oml('B'.repeat(27) + '=', 'a.b.c.d', 'the model'));
  const merged = capture('merged.oml', oml('A'.repeat(27) + '=', 'a.b', 'the model and the job'));
  assert.notEqual(fs.readFileSync(first.path).toString('hex'), fs.readFileSync(restarted.path).toString('hex'), 'the raw bytes differ');
  const [base, again, other] = await Promise.all([first, restarted, merged].map(s => baseContentSha256(s)));
  assert.equal(cutVerdict(cut({ jobs: { J: base } }), { openSha256: again, jobSha256: 'J', pid: 1 }).refuse, false);
  assert.equal(cutVerdict(cut({ jobs: { J: base } }), { openSha256: other, jobSha256: 'J', pid: 1 }).refuse, true);
});

test('the bridge: the check reads the open module before the native comparisons and again as the last thing before the hand-off (G24)', () => {
  const source = fs.readFileSync(path.join(here, '..', '..', 'studio', 'bridge', 'StartupHook.cs'), 'utf8').replace(/\r\n/g, '\n');
  const helper = source.slice(source.indexOf('private static void RequireExpectedBase'), source.indexOf('// Steps 4 and 5 of the cycle'));
  assert.match(helper, /mode != Mode\.Merge/);
  assert.match(helper, /local\.SaveToMemoryStream\(\)/, 'the module itself, no cache');
  assert.match(helper, /MODULE_NOT_AT_BASE: /);
  const run = source.slice(source.indexOf('private static object Run(Manifest m'));
  const first = run.indexOf('RequireExpectedBase(m, mode, local);');
  const last = run.lastIndexOf('RequireExpectedBase(m, mode, local);', run.indexOf('CompareAndMergeCommands.CompareAndMerge'));
  assert.ok(first < run.indexOf('new MatchTree(local, basis, basis'), 'before the comparison that would answer BASE_DRIFT');
  assert.ok(first < last);
  const between = run.slice(last, run.indexOf('string NativeMerge('));
  assert.deepEqual([...between.matchAll(/^\s+(.+?);?$/gm)].map(m => m[1]).filter(line => line.trim() && !line.startsWith('RequireExpectedBase')).map(line => line.slice(0, 40)),
    ['File.WriteAllText(Path.Combine(m.Evidenc', 'handedOff = true; c.HandedOff = true'], 'only the record of the start between the read and the hand-off');
  const shared = fs.readFileSync(path.join(here, '..', '..', 'studio', 'shared', 'Manifest.cs'), 'utf8');
  assert.match(shared, /public string\? ExpectedBaseSha256 \{ get; set; \}/);
});

test('merged:false of a cut reaches the session; the refusal keeps what it compared', () => {
  const answer = compactDelivery('studio_deliver', {}, { ok: false, code: 'MERGE_NOT_STARTED', merged: false, timeout: { now: { state: 'not-started' } }, error: 'x' });
  assert.equal(answer.merged, false);
  const refused = compactDelivery('studio_deliver', {}, { ok: false, code: 'MODULE_NOT_AT_BASE', merged: null, baseSha256: 'B', openSha256: 'O', cut: { at: 'then' }, error: 'x' });
  assert.equal(refused.merged, null);
  assert.deepEqual([refused.baseSha256, refused.openSha256, refused.cut.at], ['B', 'O', 'then']);
  assert.equal('merged' in compactDelivery('studio_deliver', {}, { ok: false, code: 'VALIDATION_REFUSED', merged: false, error: 'x' }), false, 'only for a cut: a refusal before the merge is as it was');
});

test('G25: one clock orders the deliveries: a machine of the Studio ahead of this server does not bring an earlier clean one back', t => {
  const lab = path.join(box(t), 'lab');
  const delivery = (name, started, server) => {
    const dir = path.join(lab, name, 'delivery'), evidence = path.join(dir, 'evidence');
    fs.mkdirSync(evidence, { recursive: true });
    const manifest = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({ module: 'M', moduleKey: 'k', tenant: 'h', evidenceDir: evidence }));
    fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: started, pid: 1 }));
    fs.writeFileSync(path.join(lab, name, 'deliver-result.json'), JSON.stringify({ startedAt: server, completedAt: server }));
    return manifest;
  };
  delivery('earlier', '2026-10-31T12:30:00Z', '2026-10-31T12:00:00Z');
  const latest = delivery('later', '2026-10-31T12:05:00Z', '2026-10-31T12:10:00Z');
  assert.equal(deliveryMerges(lab, { root: path.dirname(lab), module: 'M', moduleKey: 'k' })[0].manifest, latest);
});

test('G26: pass 1 clean and a restart: nothing says it is in the module open now, so no "is in the module" and no repair', async t => {
  const root = box(t); const lab = path.join(root, 'lab');
  const dir = path.join(lab, 'attempt'), manifestDir = path.join(dir, 'delivery-first-pass'), evidence = path.join(manifestDir, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({ module: 'M', moduleKey: 'k', tenant: 'h', evidenceDir: evidence }));
  fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: '2026-10-31T12:00:00Z', pid: 111 }));
  fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, strictlyEqual: true, sha256: 'A' }));
  fs.writeFileSync(path.join(dir, 'merge-order-repair.json'), '{"ops":[]}');
  const answer = await resolveDeliveryManifest({ module: 'M' }, { studio: async () => ({ ok: true, pid: 222, modules: [{ name: 'M', key: 'k', host: 'h' }] }), lab, root, reconcile: async () => { throw new Error('a clean receipt is not reconciled'); } });
  assert.equal(answer.code, 'DELIVERY_IN_OTHER_STUDIO');
  assert.equal(answer.merged, null);
  assert.ok(!JSON.stringify(answer).includes('"studio_deliver"'));
  assert.doesNotMatch(answer.error, /is in the module and pass 2/);
});

test('G21: the merge returned in another process, or in this one, and the capture is the base: this module holds none of it, and merged stays unknown', async t => {
  for (const pid of [111, 222]) {
    const root = box(t); const dir = path.join(root, 'attempt'), evidence = path.join(dir, 'evidence');
    fs.mkdirSync(evidence, { recursive: true });
    const candidatePath = path.join(dir, 'candidate.oml'); fs.writeFileSync(candidatePath, 'c');
    const document = { module: 'M', moduleKey: 'k', baseSha256: 'BASE', candidatePath, candidateSha256: 'C', evidenceDir: evidence };
    fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: 'now', pid }));
    fs.writeFileSync(path.join(evidence, 'native-return.json'), JSON.stringify({ outcome: 'x', publishInvoked: false }));
    const answer = await reconcileMerge({ merge: { dir, manifest: path.join(dir, 'manifest.json'), document, evidence, started: { at: 'now', pid } }, module: 'M', pid: 222, studioPid: 222 },
      { studio: async () => ({ ok: true, sha256: 'base', path: 'capture', moduleKey: 'k' }), prove: async () => assert.fail('nothing to prove') });
    assert.equal(answer.code, 'MERGE_NOT_IN_MODULE');
    assert.equal(answer.merged, null);
    assert.equal(answer.inThisModule, false);
    assert.equal(answer.continuation.tool, 'studio_status');
    assert.ok(!('nothingMerged' in answer));
  }
});

test('a receipt the bridge wrote, with the sha of the base: it ran, so the proof decides, never "none of it is in this module"', async t => {
  const root = box(t); const dir = path.join(root, 'attempt'), evidence = path.join(dir, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const candidatePath = path.join(dir, 'candidate.oml'); fs.writeFileSync(candidatePath, 'c');
  const document = { module: 'M', moduleKey: 'k', baseSha256: 'BASE', candidatePath, candidateSha256: 'c', evidenceDir: evidence };
  fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, strictlyEqual: false, sha256: 'BASE' }));
  let proved = 0;
  const answer = await reconcileMerge({ merge: { dir, manifest: path.join(dir, 'manifest.json'), document, evidence, started: { at: 'now', pid: 1 } }, module: 'M', pid: 1 },
    { studio: async () => ({ ok: true, sha256: 'base', path: 'capture', moduleKey: 'k' }), prove: async () => { proved++; return { ok: true, proof: { schema: 'ssam-merge-content-proof/1', accepted: true, checked: 1, differences: [], inputs: { expected: { sha256: 'c' }, actual: { sha256: 'base' } }, coverage: { complete: true } } }; } });
  assert.notEqual(answer.code, 'MERGE_NOT_IN_MODULE', JSON.stringify(answer));
  assert.equal(proved, 1);
});

test('G23: no evidence folder on this server: the refusal of the proof is written, never a raw ENOENT', async t => {
  const root = box(t); const dir = path.join(root, 'attempt');
  fs.mkdirSync(dir, { recursive: true });
  const candidatePath = path.join(dir, 'candidate.oml'); fs.writeFileSync(candidatePath, 'c');
  const evidence = path.join(dir, 'never', 'made');
  const document = { module: 'M', moduleKey: 'k', baseSha256: 'BASE', candidatePath, candidateSha256: 'c', evidenceDir: evidence };
  const merge = { dir, manifest: path.join(dir, 'manifest.json'), document, evidence, started: null, unseen: true };
  const proof = differences => ({ ok: true, proof: { schema: 'ssam-merge-content-proof/1', accepted: differences.length === 0, checked: 1, differences, inputs: { expected: { sha256: 'c' }, actual: { sha256: 'capture' } }, coverage: { complete: true } } });
  const studio = async () => ({ ok: true, sha256: 'capture', path: 'capture', moduleKey: 'k' });
  const differs = await reconcileMerge({ merge, module: 'M', pid: 1 }, { studio, prove: async () => proof([{ element: 'E', property: 'p' }]) });
  assert.equal(differs.code, 'MERGE_CONTENT_MISMATCH');
  assert.ok(fs.existsSync(differs.reconciliation.file));
  const equal = await reconcileMerge({ merge, module: 'M', pid: 1 }, { studio, prove: async () => proof([]) });
  assert.equal(equal.ok, true, JSON.stringify(equal));
  assert.ok(fs.existsSync(path.join(evidence, 'receipt.json')));
});
