// A disposable merge preview refused only by its content proof is proven again by the content-proof engine installed
// beside the kernel (reproveContentPreview): the native merge recreates the consumer's copy of a producer reference with
// keys of its own, which the kernel's proof read as lost content. Accepted only when that engine accepts the same two
// files (both sha256 bound, both unchanged on disk); a conflict, a new error, a difference or another file keeps the
// refusal, which names its elements (contentLossRefusal). Offline: temporary files and a fake engine.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { reproveContentPreview, contentLossRefusal } from '../kernel-delivery.mjs';

const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function lab(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-reproof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const candidate = path.join(dir, 'kernel-candidate.oml'); fs.writeFileSync(candidate, 'candidate bytes');
  const merged = path.join(dir, 'merge-content-preview.oml'); fs.writeFileSync(merged, 'merged bytes');
  const engine = path.join(dir, 'engine', 'anvil-odc.dll'); fs.mkdirSync(path.dirname(engine)); fs.writeFileSync(engine, 'engine');
  fs.writeFileSync(path.join(path.dirname(engine), 'content-proof.json'), JSON.stringify({ commit: 'abc1234', branch: 'fix/merge-content-loss', rule: 'producer elements by GlobalKey' }));
  const kernelDifference = { objectKey: 'k1', address: 'k1', property: 'api:Action', missing: false, unexpected: false };
  const plan = (over = {}) => ({ ok: true, deferred: [], firstPass: null, contentPreviewSupported: true, contentPreview: {
    path: merged, sha256: sha(merged), accepted: false, isValid: true, newErrors: 0, hasConflicts: false,
    contentProof: { schema: 'ssam-merge-content-proof/1', accepted: false, checked: 10, differences: [kernelDifference],
      inputs: { expected: { path: candidate, sha256: sha(candidate) }, actual: { path: merged, sha256: sha(merged) } } }, ...over } });
  return { dir, candidate, merged, engine, plan, noCli: path.join(dir, 'no-kernel-cli', 'anvil-odc.dll') };
}

const engineAnswer = (proof, runs) => async (cmd, argv) => {
  runs.push([cmd, ...argv]);
  return { stdout: JSON.stringify({ ok: true, command: 'content-proof', data: proof }), stderr: '' };
};
const proofOf = (l, { differences = [], actualSha = null } = {}) => ({ schema: 'ssam-merge-content-proof/1', accepted: differences.length === 0, checked: 141860, differences,
  inputs: { expected: { path: l.candidate, sha256: sha(l.candidate) }, actual: { path: l.merged, sha256: actualSha ?? sha(l.merged) } } });

test('a preview refused only by the kernel proof is accepted when the engine proves the same two files', async t => {
  const l = lab(t); const runs = [];
  const result = await reproveContentPreview(l.plan(), { proofCli: l.engine, cli: l.noCli, exec: engineAnswer(proofOf(l), runs) });
  assert.equal(result.contentPreview.accepted, true);
  assert.deepEqual(runs, [['dotnet', l.engine, 'content-proof', '--expected', l.candidate, '--actual', l.merged]]);
  assert.equal(result.contentPreview.reproof.engine, 'abc1234'); assert.equal(result.contentPreview.reproof.kernelDifferences, 1);
  assert.equal(result.contentPreview.contentProof.checked, 141860);
});

test('the engine finding differences keeps the refusal, with its named elements', async t => {
  const l = lab(t); const runs = [];
  const differences = [{ element: 'ServerAction:ConsumerAction/ExecuteServerActionNode:Save', property: 'api:Action', expectedValue: 'reference:Reference:ProducerApp/ServerActionSignature:SaveAction', actualValue: 'reference:Reference:ProducerApp/ServerActionSignature:SaveOtherAction' }];
  const result = await reproveContentPreview(l.plan(), { proofCli: l.engine, cli: l.noCli, exec: engineAnswer(proofOf(l, { differences }), runs) });
  assert.equal(result.contentPreview.accepted, false); assert.equal(result.contentPreview.reproof.accepted, false);
  const refusal = contentLossRefusal(result.contentPreview, path.join(l.dir, 'merge-order.json'));
  assert.match(refusal.error, /ServerAction:ConsumerAction\/ExecuteServerActionNode:Save api:Action: reference:Reference:ProducerApp\/ServerActionSignature:SaveAction -> reference:Reference:ProducerApp\/ServerActionSignature:SaveOtherAction/);
  assert.deepEqual(refusal.differences[0], { element: 'ServerAction:ConsumerAction/ExecuteServerActionNode:Save', path: 'api:Action',
    candidate: 'reference:Reference:ProducerApp/ServerActionSignature:SaveAction', merged: 'reference:Reference:ProducerApp/ServerActionSignature:SaveOtherAction' });
  assert.equal(refusal.continuation.tool, 'ssam_evidence');
});

test('a proof of another file is never accepted', async t => {
  const l = lab(t); const runs = [];
  const result = await reproveContentPreview(l.plan(), { proofCli: l.engine, cli: l.noCli, exec: engineAnswer(proofOf(l, { actualSha: 'f'.repeat(64) }), runs) });
  assert.equal(result.contentPreview.accepted, false); assert.equal(result.contentPreview.reproof.accepted, false);
});

test('a conflict, a new error, a missing engine or a file changed on disk never runs or never accepts the engine', async t => {
  const l = lab(t); const runs = [];
  const exec = engineAnswer(proofOf(l), runs);
  for (const over of [{ hasConflicts: true }, { newErrors: 1 }]) {
    const result = await reproveContentPreview(l.plan(over), { proofCli: l.engine, cli: l.noCli, exec });
    assert.equal(result.contentPreview.accepted, false); assert.equal(result.contentPreview.reproof, undefined);
  }
  assert.equal((await reproveContentPreview(l.plan(), { proofCli: path.join(l.dir, 'none.dll'), cli: l.noCli, exec })).contentPreview.accepted, false);
  assert.equal(runs.length, 0);
  const plan = l.plan(); fs.writeFileSync(l.merged, 'changed bytes');
  const changed = await reproveContentPreview(plan, { proofCli: l.engine, cli: l.noCli, exec });
  assert.equal(changed.contentPreview.accepted, false); assert.match(changed.contentPreview.reproof.error, /changed on disk/);
  assert.equal(runs.length, 0);
});

test('an accepted preview is returned as it is', async t => {
  const l = lab(t); const runs = [];
  const plan = l.plan({ accepted: true, contentProof: { accepted: true, differences: [] } });
  assert.equal(await reproveContentPreview(plan, { proofCli: l.engine, cli: l.noCli, exec: engineAnswer(proofOf(l), runs) }), plan);
  assert.equal(runs.length, 0);
});

// R6: the kernel's own ODC CLI proves again when it has the verb; the side engine only when it does not.
const kernelCli = l => { const cli = path.join(l.dir, 'kernel-cli', 'anvil-odc.dll'); fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, 'kernel cli'); return cli; };
const noWorker = async () => ({ used: false, note: 'worker disabled' });

test('the kernel CLI with content-proof proves again, cold, and the side engine never runs', async t => {
  const l = lab(t); const runs = []; const cli = kernelCli(l);
  const result = await reproveContentPreview(l.plan(), { proofCli: l.engine, cli, runOnWorker: noWorker, exec: engineAnswer({ ...proofOf(l), canon: { rule: 'canonical identity' } }, runs) });
  assert.equal(result.contentPreview.accepted, true);
  assert.deepEqual(runs, [['dotnet', cli, 'content-proof', '--expected', l.candidate, '--actual', l.merged]]);
  assert.deepEqual([result.contentPreview.reproof.engine, result.contentPreview.reproof.engineSource, result.contentPreview.reproof.via, result.contentPreview.reproof.rule],
    ['kernel-cli', cli, 'cold', 'canonical identity']);
});

test('a kernel CLI without the verb falls back to the side engine', async t => {
  const l = lab(t); const runs = []; const cli = kernelCli(l);
  const exec = async (cmd, argv) => {
    runs.push([cmd, ...argv]);
    if (argv[0] === cli) throw Object.assign(new Error('exit 2'), { stdout: '', stderr: 'unknown command: content-proof\nusage: anvil-odc <command>', code: 2 });
    return { stdout: JSON.stringify({ ok: true, command: 'content-proof', data: proofOf(l) }), stderr: '' };
  };
  const result = await reproveContentPreview(l.plan(), { proofCli: l.engine, cli, runOnWorker: noWorker, exec });
  assert.equal(result.contentPreview.accepted, true);
  assert.deepEqual(runs.map(r => r[1]), [cli, l.engine]);
  assert.equal(result.contentPreview.reproof.engine, 'abc1234');
});

test('a worker that advertises content-proof answers it; a kernel CLI failure keeps the refusal', async t => {
  const l = lab(t); const runs = []; const cli = kernelCli(l); const asked = [];
  const runOnWorker = async (argv, options) => { asked.push([argv, options.needs]); return { used: true, envelope: { ok: true, command: 'content-proof', data: proofOf(l) } }; };
  const result = await reproveContentPreview(l.plan(), { proofCli: l.engine, cli, runOnWorker, exec: engineAnswer(proofOf(l), runs) });
  assert.equal(result.contentPreview.accepted, true); assert.equal(result.contentPreview.reproof.via, 'worker');
  assert.deepEqual(asked, [[['content-proof', '--expected', l.candidate, '--actual', l.merged], ['content-proof']]]); assert.equal(runs.length, 0);
  const failing = async () => { throw Object.assign(new Error('exit 4'), { stdout: JSON.stringify({ ok: false, command: 'content-proof', error: 'model load failed' }), stderr: '', code: 4 }); };
  const refused = await reproveContentPreview(l.plan(), { proofCli: l.engine, cli, runOnWorker: noWorker, exec: failing });
  assert.equal(refused.contentPreview.accepted, false); assert.equal(refused.contentPreview.reproof.accepted, false);
  assert.match(refused.contentPreview.reproof.error, /model load failed/);
});
