// A21 (package of 2026-10-06, lane F7a): ssam_evidence reads every folder an SSAM answer names. The friction report's real
// refusals: OUTSIDE_ROOTS for the reservation file the doctor named (<authority>\reservations\<sha>.json) and for the
// preview plan (.local\preview\cardapio-20261006\...). The roots come from one registry (evidence-roots.mjs), and a path
// contract checks every function that names a file. select with fields is merged instead of refused. Synthetic files.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ssamPathRoots } from '../evidence-roots.mjs';
import { createEvidenceReader, evidenceRoots } from '../ssam-evidence.mjs';
import { moduleReservations, pageAnswer } from '../ssam.mjs';
import { indexRoot } from '../module-map.mjs';
import { o11LaneOf } from '../o11-lane.mjs';
import { createStore, frictionDirectory } from '../../../../facade/friction-store.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa2-f7a-evidence-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const workspace = path.join(tmp, 'ws'), anvil = path.join(workspace, 'kernel'), odc = path.join(workspace, 'platforms', 'odc');
const authority = path.join(tmp, 'authority');
const env = { ANVIL_AUTHORITY_DIR: authority, LOCALAPPDATA: path.join(tmp, 'local') };
const roots = ssamPathRoots({ anvil, odc, workspace, env, readUserEnvironment: () => null });
const read = input => createEvidenceReader({ roots }).read(input);
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
const covered = file => roots.some(r => inside(r, path.resolve(file)));

test('the registry holds the folders answers name: reservations, preview, friction, answers, module index', () => {
  for (const folder of [path.join(authority, 'reservations'), path.join(workspace, '.local', 'preview'), path.join(workspace, '.local', 'friction'),
    path.join(anvil, '.local', 'answers'), path.join(workspace, '.local', 'module-index'), path.join(workspace, '.local', 'debugger'),
    path.join(anvil, '.local'), path.join(odc, '.local'), path.join(odc, 'lab'), path.join(odc, 'journal'), path.join(odc, 'snapshots')])
    assert.ok(roots.includes(path.resolve(folder)), folder);
  assert.ok(!covered(path.join(workspace, '.local', 'scratch', 'x.json')), 'the rest of the workspace .local stays outside');
  assert.ok(!covered(path.join(authority, 'bridge.key.json')), 'the authority folder itself stays outside: only its reservations');
  // env overrides of the friction queue and the module index are roots too
  const moved = ssamPathRoots({ anvil, odc, workspace, env: { ...env, SSAM_FRICTION_DIR: path.join(tmp, 'fq'), SSAM_MODULE_INDEX_ROOT: path.join(tmp, 'mi') }, readUserEnvironment: () => null });
  assert.ok(moved.includes(path.resolve(tmp, 'fq')) && moved.includes(path.resolve(tmp, 'mi')));
  // ssam_evidence takes its roots from the registry
  assert.deepEqual(evidenceRoots({ anvil, odc, workspace, env }), ssamPathRoots({ anvil, odc, workspace, env }));
});

test('the reservation the doctor names and the preview plan are read (they were OUTSIDE_ROOTS)', () => {
  const payload = JSON.stringify({ owner: 'a471638cb0484920a6d0c0166b6f8a46', environment: 'personal.outsystemscloud.com', moduleKey: 'k1' });
  const reservation = put(path.join(authority, 'reservations', 'ab12.json'),
    { format: 1, sha256: createHash('sha256').update(payload, 'utf8').digest('hex'), payload });
  const answer = read({ file: reservation, select: ['owner', 'moduleKey'] });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.values, { owner: 'a471638cb0484920a6d0c0166b6f8a46', moduleKey: 'k1' });
  assert.equal(answer.envelope, 'verified');
  const plan = put(path.join(workspace, '.local', 'preview', 'cardapio-20261006', 'plan.json'), { app: 'Cardapio_UI', screens: ['Home'] });
  assert.equal(read({ file: plan, pointer: '/app' }).value, 'Cardapio_UI');
  const report = put(path.join(workspace, '.local', 'friction', 'reports', 'r1.json'), { schema: 'ssam-friction-report/1', kind: 'gap' });
  assert.equal(read({ file: report, pointer: '/kind' }).value, 'gap');
  const index = put(path.join(workspace, '.local', 'module-index', 'o11', 'abc.json'), { entries: [{ key: 'k', kind: 'ServerAction' }] });
  assert.equal(read({ file: index, pointer: '/entries/0/kind' }).value, 'ServerAction');
});

test('select with fields is merged into one read of the same object', () => {
  const file = put(path.join(anvil, '.local', 'work', 'deliver', 't1', 'result.json'), { ok: false, stage: 'apply', writeState: 'not-sent', error: 'x' });
  const merged = read({ file, select: ['stage'], fields: ['writeState', 'stage', 'nothing'] });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.deepEqual(merged.values, { stage: 'apply', writeState: 'not-sent' });
  assert.deepEqual(merged.missing, ['nothing']); assert.deepEqual(merged.fieldsMerged, ['writeState', 'nothing']);
  assert.equal(read({ file, select: ['stage'], where: 'ok=false' }).code, 'BAD_ARGUMENTS', 'where still lists items');
});

test('path contract: every absolute path the path-naming functions return passes the roots', () => {
  // reservations (ssam.mjs moduleReservations): the folder and each active file
  put(path.join(authority, 'reservations', 'cd34.json'), { format: 1, sha256: 'x', payload: JSON.stringify({ owner: 'task1', moduleKey: 'k2', environment: 'e' }) });
  const reservations = moduleReservations({ env, readUserEnvironment: () => null });
  assert.ok(covered(path.join(reservations.directory, 'any.json')));
  assert.ok(reservations.active.length >= 1);
  for (const r of reservations.active) assert.ok(covered(r.file), r.file);
  // a paged answer (ssam.mjs pageAnswer)
  const big = { ok: true, items: Array.from({ length: 400 }, (_, i) => ({ i, text: 'x'.repeat(100) })) };
  const paged = pageAnswer({ content: [{ type: 'text', text: JSON.stringify(big) }], structuredContent: big }, { root: anvil, maxBytes: 4096 });
  const pagedFile = paged.structuredContent.paged.file;
  assert.ok(covered(pagedFile), 'paged answer file: ' + pagedFile);
  assert.equal(read({ file: pagedFile, pointer: '/items/0/i' }).value, 0, 'its continuation (ssam_evidence) reads it');
  // o11_environment folders, task receipts and reference files of both O11 lanes
  for (const lane of ['ss4', 'ss5']) {
    const l = o11LaneOf(lane, { root: anvil, workspace, env });
    for (const file of [path.join(l.local, 'environment', 'download', '20261006T162952193Z', 'Users.json'), path.join(l.local, 'environment', 'download-app', '20261006T162952193Z', 'App', 'receipt.json'),
      path.join(l.work, 'deliver', '0f3a9c1e2b4d4e6f8a1b2c3d4e5f6a7b', 'result.json'), path.join(l.local, 'reference', 'ab.json'), path.join(l.local, 'jobs', 'inline', 'j.json')])
      assert.ok(covered(file), file);
  }
  // the friction queue (default and SSAM_FRICTION_DIR) and a report written there
  assert.ok(covered(path.join(frictionDirectory({ root: workspace, env: {} }), 'reports', 'r.json')));
  const store = createStore({ root: workspace, env: {}, warning: () => {} });
  const written = store.report({ kind: 'gap', tool: 'studio_deliver', intent: 'ButtonGroup in the html fragment', attempted: 'html op' });
  assert.equal(written.ok, true); assert.ok(covered(written.file), written.file);
  // the module index (module-map.mjs indexRoot) by default (the installation's workspace) and by SSAM_MODULE_INDEX_ROOT
  assert.ok(ssamPathRoots({ env, readUserEnvironment: () => null }).includes(path.resolve(indexRoot({}))), 'the installation roots hold the default index folder');
  const custom = path.join(tmp, 'index-elsewhere');
  assert.ok(ssamPathRoots({ anvil, odc, workspace, env: { ...env, SSAM_MODULE_INDEX_ROOT: custom }, readUserEnvironment: () => null }).includes(path.resolve(indexRoot({ SSAM_MODULE_INDEX_ROOT: custom }))));
  // the debugger and the preview folders of the workspace
  for (const file of [path.join(workspace, '.local', 'debugger', 's1', 'receipt.json'), path.join(workspace, '.local', 'preview', 'p1', 'plan.json')]) assert.ok(covered(file), file);
});
