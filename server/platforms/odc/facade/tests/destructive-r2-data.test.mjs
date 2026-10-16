import './fixtures/isolated-profile.mjs';
// CX15 r2, data deletes: the kernel works on the host of the preview (J: a line without --host runs with it; a read again
// from another host is PREVIEW_OTHER_TARGET), a preview keeps no row and the kernel never gets the owner's words (C6), and
// no refusal of the words carries a ready phrase with the number and the name (F1, the fix of WORDS_MUST_NAME). Offline: a
// fake O11 kernel whose Studio can be switched from one host to another, a fake ODC data service, synthetic records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliDataDelete, studioDataDelete } from '../data-delete-gate.mjs';
import { CONFIRM_MIN_AGE_MS, wordsSha256 } from '../destructive-operations.mjs';

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const DEV = 'dev.example.test', QA = 'qa.example.test';
const base = ['--module', 'Orders_CS', '--oml', 'C:\\captures\\Orders_CS.oml'];

// The kernel of `ssam data`: the Studio is connected to `studio.host`. With --host H through the Studio, a Studio on
// another host refuses (honorsHost); a kernel that ignored it would answer from the connected Studio.
function kernelLine({ honorsHost = true } = {}) {
  const tables = { [DEV]: new Map([1, 2].map(id => [String(id), { Id: String(id), Name: 'Customer ' + id }])), [QA]: new Map([1, 2].map(id => [String(id), { Id: String(id), Name: 'QA customer ' + id }])) };
  const studio = { host: DEV };
  const calls = [];
  const send = async argv => {
    const file = argv[argv.indexOf('--request') + 1];
    const request = JSON.parse(fs.readFileSync(file, 'utf8'));
    const asked = argv.includes('--host') ? argv[argv.indexOf('--host') + 1] : null;
    calls.push({ argv, request, file });
    if (asked && honorsHost && asked !== studio.host)
      return { ok: false, lane: 'o11', verb: 'data', exitCode: 1, code: 'STUDIO_NOT_SELECTED', error: `the Studio is connected to ${studio.host}, not ${asked}` };
    const table = tables[studio.host];
    const ops = Array.isArray(request.batch) ? request.batch : [request];
    const results = ops.map(op => (op.operation === 'read' ? { ok: true, operation: 'read', entity: op.entity, records: op.ids.map(String).filter(id => table.has(id)).map(id => table.get(id)) }
      : (op.ids.forEach(id => table.delete(String(id))), { ok: true, operation: 'delete', entity: op.entity, reports: op.ids.map(id => ({ recordId: String(id), status: 'Success', error: null })) })));
    return { ok: true, lane: 'o11', verb: 'data', exitCode: 0, result: { ok: true, command: 'data', data: { ok: true, host: studio.host, submitted: results.length, total: results.length, results } } };
  };
  return { tables, studio, calls, send, deletes: () => calls.flatMap(c => (Array.isArray(c.request.batch) ? c.request.batch : [c.request])).filter(op => op.operation === 'delete') };
}
async function previewThenConfirm(line, { previewArgs, confirmArgs, root, cwd, switchTo = null }) {
  let now = Date.parse('2026-10-15T12:00:00Z');
  const file = path.join(cwd, 'request.json');
  fs.writeFileSync(file, JSON.stringify({ operation: 'delete', entity: 'Customer', ids: ['1', '2'] }));
  const preview = await cliDataDelete([...previewArgs, '--request', file], { send: line.send, cwd, now: () => now, root });
  assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 300));
  if (switchTo) line.studio.host = switchTo; // the owner (or another session) switched the Studio to another environment
  now += CONFIRM_MIN_AGE_MS + 1000;
  fs.writeFileSync(file, JSON.stringify({ ...preview.confirmRequest, authorization: 'pode apagar os 2 registros de Customer' }));
  const done = await cliDataDelete([...confirmArgs, '--request', file], { send: line.send, cwd, now: () => now, root });
  return { preview, done };
}

test('J: ssam data without --host in both calls: the execution runs on the host of the preview (through the Studio); with the Studio switched to qa nothing is deleted in qa', async () => {
  for (const honorsHost of [true, false]) {
    const cwd = tmp('cx15r2-j-'); const root = tmp('cx15r2-j-root-');
    try {
      const line = kernelLine({ honorsHost });
      const { preview, done } = await previewThenConfirm(line, { previewArgs: base, confirmArgs: base, root, cwd, switchTo: QA });
      assert.equal(preview.items.length, 2);
      const execution = line.calls.slice(1);
      assert.ok(execution.length >= 1 && execution.every(c => c.argv.includes('--studio') && c.argv[c.argv.indexOf('--host') + 1] === DEV),
        'every kernel call of the execution names the host of the preview, through the Studio: ' + JSON.stringify(execution.map(c => c.argv.slice(-4))));
      assert.equal(done.ok, false, JSON.stringify(done).slice(0, 300));
      if (!honorsHost) assert.ok(done.problems.some(p => p.code === 'PREVIEW_OTHER_TARGET' && p.host === QA && p.previewHost === DEV), JSON.stringify(done.problems));
      assert.deepEqual(line.deletes(), [], 'nothing deleted');
      assert.equal(line.tables[QA].size, 2, 'qa untouched'); assert.equal(line.tables[DEV].size, 2);
    } finally { for (const d of [cwd, root]) fs.rmSync(d, { recursive: true, force: true }); }
  }
});

test('J: --host only in the preview: the execution without it runs on the preview host; with the Studio still there it deletes there, once', async () => {
  const cwd = tmp('cx15r2-j2-'); const root = tmp('cx15r2-j2-root-');
  try {
    const line = kernelLine();
    const { done } = await previewThenConfirm(line, { previewArgs: ['--studio', '--host', DEV, ...base], confirmArgs: ['--studio', ...base], root, cwd });
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 300));
    assert.ok(line.calls.slice(1).every(c => c.argv[c.argv.indexOf('--host') + 1] === DEV));
    assert.equal(line.deletes().length, 1); assert.equal(line.tables[DEV].size, 0);
    // and the Studio switched to qa between the two calls: nothing deleted.
    const again = kernelLine({ honorsHost: false });
    const cwd2 = tmp('cx15r2-j3-'); const root2 = tmp('cx15r2-j3-root-');
    try {
      const switched = await previewThenConfirm(again, { previewArgs: ['--studio', '--host', DEV, ...base], confirmArgs: ['--studio', ...base], root: root2, cwd: cwd2, switchTo: QA });
      assert.ok(switched.done.problems.some(p => p.code === 'PREVIEW_OTHER_TARGET'), JSON.stringify(switched.done).slice(0, 300));
      assert.deepEqual(again.deletes(), []);
    } finally { for (const d of [cwd2, root2]) fs.rmSync(d, { recursive: true, force: true }); }
  } finally { for (const d of [cwd, root]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('C6: a preview leaves no row file (O11 and ODC); the execution backs the rows up; the kernel request files never hold the owner\'s words', async () => {
  const cwd = tmp('cx15r2-c6-'); const root = tmp('cx15r2-c6-root-');
  try {
    const line = kernelLine();
    let now = Date.parse('2026-10-15T12:00:00Z');
    const file = path.join(cwd, 'request.json');
    const words = 'pode apagar os 2 registros de Customer';
    fs.writeFileSync(file, JSON.stringify({ operation: 'delete', entity: 'Customer', ids: ['1', '2'] }));
    const preview = await cliDataDelete(['--studio', '--host', DEV, ...base, '--request', file], { send: line.send, cwd, now: () => now, root });
    assert.equal(preview.backup, undefined);
    assert.equal(fs.existsSync(path.join(root, 'backups')), false, 'a preview keeps no row');
    now += CONFIRM_MIN_AGE_MS + 1000;
    fs.writeFileSync(file, JSON.stringify({ ...preview.confirmRequest, authorization: words }));
    const done = await cliDataDelete(['--studio', '--host', DEV, ...base, '--request', file], { send: line.send, cwd, now: () => now, root });
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 300));
    const rows = fs.readdirSync(path.join(root, 'backups', preview.operationId));
    assert.deepEqual(rows, ['Customer-before-delete.json'], 'the execution backed up the rows it read again');
    const sent = line.calls.at(-1);
    assert.equal(sent.request.authorization, 'sha256:' + wordsSha256(words));
    for (const c of line.calls) assert.ok(!fs.readFileSync(c.file, 'utf8').includes(words), 'no request file of the kernel holds the words: ' + c.file);
    // ODC: the preview keeps no row either.
    const studioData = async ({ op }) => (op === 'read' ? { ok: true, tenant: 'personal-c6.outsystems.dev', module: 'Shop', entity: 'Product', records: [{ Id: '7', Name: 'P 7', Secret: 'SYNTH-SECRET-0001' }], more: false } : { ok: true, reports: [] });
    const odc = await studioDataDelete({ module: 'Shop', entity: 'Product', ids: ['7'] }, { studioData, now: () => now, root });
    assert.equal(odc.state, 'previewed');
    assert.equal(odc.backup, undefined);
    assert.equal(fs.existsSync(path.join(root, 'backups', odc.operationId)), false);
  } finally { for (const d of [cwd, root]) fs.rmSync(d, { recursive: true, force: true }); }
});

test('F1 (residual): the WORDS_MUST_NAME refusal of a data delete gives the rule, never a phrase with the number and the name to copy', async () => {
  const root = tmp('cx15r2-fix-');
  try {
    let now = Date.parse('2026-10-15T12:00:00Z');
    const studioData = async ({ op }) => (op === 'read' ? { ok: true, tenant: 'personal-fix.outsystems.dev', module: 'Shop', entity: 'Product', records: [{ Id: '1', Name: 'P 1' }, { Id: '2', Name: 'P 2' }], more: false } : { ok: true, reports: [] });
    const preview = await studioDataDelete({ module: 'Shop', entity: 'Product', ids: ['1', '2'] }, { studioData, now: () => now, root });
    now += CONFIRM_MIN_AGE_MS + 1000;
    const refused = await studioDataDelete({ module: 'Shop', entity: 'Product', confirmationToken: preview.confirmationToken, authorize: 'pode apagar os 2' }, { studioData, now: () => now, root });
    const named = refused.problems.find(p => p.code === 'WORDS_MUST_NAME');
    assert.ok(named, JSON.stringify(refused.problems));
    assert.doesNotMatch(named.fix, /e\.g\.|"[^"]*\b2\b[^"]*Product[^"]*"/, 'no ready phrase: ' + named.fix);
    assert.match(named.fix, /never write, complete or reuse words yourself/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('L6: the preview of a mixed batch says which of its ops did not run (the whole call is the preview)', async () => {
  const cwd = tmp('cx15r2-l6-'); const root = tmp('cx15r2-l6-root-');
  try {
    const line = kernelLine();
    const file = path.join(cwd, 'request.json');
    fs.writeFileSync(file, JSON.stringify({ authorization: 'grava o novo e apaga o 1', batch: [
      { step: 'new', operation: 'insert', entity: 'Customer', operationId: '7a1c4e1e-6666-4666-8666-666666666666', records: [{ Name: 'Novo' }] },
      { operation: 'delete', entity: 'Customer', ids: ['1'] },
      { operation: 'read', entity: 'Customer', ids: ['2'] }] }));
    const preview = await cliDataDelete(['--studio', '--host', DEV, ...base, '--request', file], { send: line.send, cwd, now: Date.parse('2026-10-15T12:00:00Z'), root });
    assert.equal(preview.code, 'CONFIRMATION_REQUIRED', JSON.stringify(preview).slice(0, 300));
    assert.deepEqual(preview.notRun, [{ op: 0, operation: 'insert' }, { op: 2, operation: 'read' }]);
    assert.match(preview.notRunNote, /did not run/);
    assert.deepEqual(line.calls.flatMap(c => (Array.isArray(c.request.batch) ? c.request.batch : [c.request])).map(op => op.operation), ['read'], 'only the read of the delete\'s ids ran');
  } finally { for (const d of [cwd, root]) fs.rmSync(d, { recursive: true, force: true }); }
});