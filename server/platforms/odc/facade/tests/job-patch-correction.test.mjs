// R1 (plano 24/10, "o loop de correção deixa de ter atrito próprio"): a refused patch never comes back dry (patchByName
// mended and ready), a path rooted the other way or without its data segment is read as it can only mean, the patches a
// refusal proposed apply as one fix, and the change over a delivered job is computed as a job of its own. Temporary
// folders only; nothing runs a process.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolvePatchedJob, patchJob, mendPatch, applyFixes, changeOnly } from '../job-patch.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const LOGIC = { ops: [
  { op: 'spec', data: { entities: [{ name: 'Pedido', attributes: [{ name: 'Numero', type: 'Text' }] }] } },
  { op: 'logic', data: { actions: [
    { name: 'Pedido_Get', inputs: [{ name: 'PedidoId', type: 'Pedido Identifier' }], steps: [{ as: 'get', assign: { Total: '1' } }] },
    { name: 'Pedido_Save', inputs: [], steps: [] }] } },
  { op: 'set', name: 'Describe', target: 'ServerAction:Pedido_Get', prop: 'Description', value: 'Lê' }] };

function sandbox(t, job = LOGIC) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'job-patch-r1-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, 'jobs', 'pedido.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(job, null, 2));
  let n = 0;
  return { base, file, sha: sha256(fs.readFileSync(file)), inlineDir: path.join(base, 'inline'), uuid: () => 'p' + (++n) };
}
const resolve = (box, patch) => resolvePatchedJob({ patch, basedOn: { job: box.file, sha256: box.sha } }, { inlineDir: box.inlineDir, uuid: box.uuid });
const written = r => JSON.parse(fs.readFileSync(r.path, 'utf8'));

test('a path rooted the other way, or naming an op, or without its data segment is the path it can only mean, and said', t => {
  const box = sandbox(t);
  const r = resolve(box, [
    { op: 'replace', path: '/1/data/actions/Pedido_Save/name', value: 'Pedido_Store' }, // {ops} job written as an array job
    { op: 'replace', path: 'Describe/value', value: 'Lê o pedido' }, // the op named Describe
    { op: 'add', path: '/ops/1/actions/Pedido_Get/steps/-', value: { as: 'save' } }]); // actions without data
  assert.equal(r.ok, true, JSON.stringify(r));
  const job = written(r);
  assert.equal(job.ops[1].data.actions[1].name, 'Pedido_Store');
  assert.equal(job.ops[2].value, 'Lê o pedido');
  assert.deepEqual(job.ops[1].data.actions[0].steps.map(s => s.as), ['get', 'save']);
  assert.deepEqual(r.normalizations.map(n => [n.rule, n.at]), [['patch-path', '/patch/0'], ['patch-path', '/patch/1'], ['patch-path', '/patch/2']]);
  // an array job written as {ops}
  const array = patchJob(LOGIC.ops, [{ op: 'replace', path: '/ops/2/value', value: 'x' }]);
  assert.equal(array.job[2].value, 'x'); assert.equal(array.notes.length, 1);
});

test('a refused patch comes back with patchByName mended and ready: verb, add of what exists, case of a name, extra keys', t => {
  const box = sandbox(t);
  const r = resolve(box, [
    { op: 'replace', path: '/ops/0/data/entities/0/name', value: 'Pedido' },
    { op: 'set', path: '/ops/2/value', value: 'Lê' },
    { op: 'add', path: 'actions/pedido_get/name', value: 'Pedido_Read', from: 'x' }]);
  assert.equal(r.ok, false); assert.equal(r.code, 'PATCH_INVALID');
  assert.equal(r.ready, true);
  assert.deepEqual(r.patchByName, [
    { op: 'replace', path: 'entities/Pedido/name', value: 'Pedido' },
    { op: 'replace', path: '/ops/Describe/value', value: 'Lê' },
    { op: 'add', path: 'actions/Pedido_Get/name', value: 'Pedido_Read' }]);
  assert.deepEqual(r.repaired.map(x => x.at), [1, 2]);
  // what it says is what applies
  const again = resolve(box, r.patchByName);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(written(again).ops[1].data.actions[0].name, 'Pedido_Read');
});

test('PATCH_PATH_FORBIDDEN that no reading mends still names the patch by name, not ready', t => {
  const box = sandbox(t);
  const r = resolve(box, [{ op: 'replace', path: '/ops/1/data/actions/0/name', value: 'A' }, { op: 'replace', path: '/base', value: 'other.oml' }]);
  assert.equal(r.code, 'PATCH_PATH_FORBIDDEN');
  assert.equal(r.ready, false);
  assert.deepEqual(r.patchByName[0], { op: 'replace', path: 'actions/Pedido_Get/name', value: 'A' });
  assert.equal(r.patchByName[1].path, '/base');
  assert.equal(mendPatch(LOGIC, [{ op: 'replace', path: '/base', value: 1 }]).ready, false);
});

test('applyFixes applies each proposed patch whole, once, and leaves out the one that does not apply or would undo another', () => {
  const fixes = [
    { code: 'A', pointer: '/ops/2/value', patch: [{ op: 'replace', path: '/ops/2/value', value: 'B' }] },
    { code: 'A', pointer: '/ops/2/value', patch: [{ op: 'replace', path: '/ops/2/value', value: 'B' }] },
    { code: 'C', pointer: '/ops/9', patch: [{ op: 'replace', path: '/ops/9/value', value: 'x' }] },
    { code: 'D', pointer: '/ops/2/value', patch: [{ op: 'replace', path: '/ops/2/value', value: 'other' }] },
    { code: 'E', pointers: ['/ops/1'], patch: [{ op: 'add', path: '/ops/1/data/actions/-', value: { name: 'New', steps: [] } }] },
    { code: 'F', pointer: '/ops/0', message: 'no patch' }];
  const r = applyFixes(LOGIC, fixes);
  assert.deepEqual(r.applied.map(a => a.code), ['A', 'A', 'E']);
  assert.deepEqual(r.notApplied.map(a => a.code), ['C', 'D']);
  assert.match(r.notApplied[1].error, /different value/);
  assert.equal(r.patch.length, 2);
  assert.equal(patchJob(LOGIC, r.patch).job.ops[1].data.actions.at(-1).name, 'New');
});

test('changeOnly keeps only what a patch changed over a delivered job; a removal is never computable', () => {
  const changed = patchJob(LOGIC, [{ op: 'replace', path: 'actions/Pedido_Save/steps', value: [{ as: 'x' }] },
    { op: 'add', path: '/ops/-', value: { op: 'set', target: 'ServerAction:Pedido_Save', prop: 'Description', value: 'Grava' } }]).job;
  const only = changeOnly(LOGIC, changed);
  assert.deepEqual(only, { ops: [
    { op: 'logic', data: { actions: [{ name: 'Pedido_Save', inputs: [], steps: [{ as: 'x' }] }] } },
    { op: 'set', target: 'ServerAction:Pedido_Save', prop: 'Description', value: 'Grava' }] });
  assert.equal(changeOnly(LOGIC, patchJob(LOGIC, [{ op: 'remove', path: 'actions/Pedido_Save' }]).job), null);
  assert.equal(changeOnly(LOGIC, patchJob(LOGIC, [{ op: 'remove', path: '/ops/2' }]).job), null);
  assert.equal(changeOnly(LOGIC, structuredClone(LOGIC)), null);
});
