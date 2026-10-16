import './fixtures/isolated-profile.mjs';
// CX15 r3, data deletes (o11_data / ssam data --lane o11 and studio_data_delete):
//   F3 (N2, CT-4): ONE exit for any exception of an execution. An exception in the read again (BRIDGE_NOT_ATTACHED) closes
//   the record refused/notSent, releases the lease and answers with operationId and ssam_task; the owner's new reply then
//   deletes (before: the record stayed running, and the new reply got "This confirmationToken already ran"). A record that
//   cannot be written after the send (EPERM) answers uncertain with operationId, releases the lease and reads interrupted;
//   a running record of a process that is gone answers OPERATION_INTERRUPTED, never CONFIRMATION_ALREADY_USED.
//   CT-6: studio_data_delete gives the bridge the sha256 of the owner's words, never the words; the answer never spreads
//   the bridge's authorization, and nothing kept (profile, records, a saved answer) holds the words.
// Offline: a fake O11 kernel line, a fake ODC data service, synthetic records and words.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { cliDataDelete, studioDataDelete } from '../data-delete-gate.mjs';
import { CONFIRM_MIN_AGE_MS, beginOperation, leaseFile, markItem, operationFile, readOperation, readPreview } from '../destructive-operations.mjs';
import { keepAnswer } from '../answer-size.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { isolatedProfile } from './fixtures/isolated-profile.mjs';

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const T0 = Date.parse('2026-10-15T12:00:00Z');
const REPLY_1 = 'sim pode apagar os 2 de Customer agora mesmo';
const REPLY_2 = 'confirmo de novo, apaga os 2 de Customer';
const bridgeDown = () => Object.assign(new Error('The ODC bridge v95 is not attached to ODC Studio 4242 (no pipe for 10 s); call studio_attach'), { code: 'BRIDGE_NOT_ATTACHED', sent: false });

// ---- ODC: a fake Studio data service (the bridge answers DeleteRecords with the authorization it got, as DataCommands.cs does).
function odcData({ failReadAt = null } = {}) {
  const table = new Map([1, 2].map(id => [String(id), { Id: String(id), Name: 'Customer ' + id }]));
  const h = { table, reads: 0, deletes: [], authorizations: [], afterDelete: () => {} };
  h.studioData = async ({ op, ids, authorize }) => {
    if (op === 'read') {
      h.reads++;
      if (failReadAt !== null && h.reads === failReadAt) throw bridgeDown();
      return { ok: true, tenant: 'odc-dev.example.test', module: 'Orders', entity: 'Customer', records: [...table.values()], more: false };
    }
    h.deletes.push([...ids]); h.authorizations.push(authorize);
    for (const id of ids) table.delete(String(id));
    h.afterDelete();
    return { ok: true, authorization: authorize, reports: ids.map(id => ({ recordId: String(id), status: 'Success', error: null })) };
  };
  return h;
}

// ---- O11: a fake kernel line of `ssam data`.
function kernelLine({ failReadAt = null } = {}) {
  const table = new Map([1, 2].map(id => [String(id), { Id: String(id), Name: 'Customer ' + id }]));
  const h = { table, reads: 0, deletes: [], afterDelete: () => {} };
  h.send = async argv => {
    const request = JSON.parse(fs.readFileSync(argv[argv.indexOf('--request') + 1], 'utf8'));
    const ops = Array.isArray(request.batch) ? request.batch : [request];
    if (ops.every(op => op.operation === 'read')) { h.reads++; if (failReadAt !== null && h.reads === failReadAt) throw bridgeDown(); }
    const results = ops.map(op => (op.operation === 'read' ? { ok: true, operation: 'read', entity: op.entity, records: op.ids.map(String).filter(id => table.has(id)).map(id => table.get(id)) }
      : (h.deletes.push([...op.ids]), op.ids.forEach(id => table.delete(String(id))), { ok: true, operation: 'delete', entity: op.entity, reports: op.ids.map(id => ({ recordId: String(id), status: 'Success', error: null })) })));
    if (ops.some(op => op.operation === 'delete')) h.afterDelete();
    return { ok: true, lane: 'o11', verb: 'data', exitCode: 0, result: { ok: true, command: 'data', data: { ok: true, host: 'dev.example.test', submitted: results.length, total: results.length, results } } };
  };
  return h;
}
const ARGS = ['--host', 'dev.example.test', '--module', 'Orders_CS', '--oml', 'C:\\captures\\Orders_CS.oml'];
async function o11Preview(line, { root, cwd, clock }) {
  const file = path.join(cwd, 'request.json');
  fs.writeFileSync(file, JSON.stringify({ operation: 'delete', entity: 'Customer', ids: ['1', '2'] }));
  const preview = await cliDataDelete([...ARGS, '--request', file], { send: line.send, cwd, now: () => clock.now, root });
  assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 300));
  return { file, preview, confirm: async words => { fs.writeFileSync(file, JSON.stringify({ ...preview.confirmRequest, authorization: words })); return cliDataDelete([...ARGS, '--request', file], { send: line.send, cwd, now: () => clock.now, root }); } };
}
const call = async fn => { try { return { value: await fn() }; } catch (error) { return { thrown: error }; } };

test('N2 (studio_data_delete): an exception in the read again closes the record refused/notSent with operationId and ssam_task; the owner\'s new reply then deletes', async () => {
  const root = tmp('cx15r3-n2-odc-'); const clock = { now: T0 };
  const h = odcData({ failReadAt: 2 }); // read 1 = the preview, read 2 = the read again of the execution
  const deps = { studioData: h.studioData, now: () => clock.now, root };
  const preview = await studioDataDelete({ module: 'Orders', entity: 'Customer', ids: ['1', '2'] }, deps);
  clock.now += CONFIRM_MIN_AGE_MS + 1000;
  const first = await call(() => studioDataDelete({ module: 'Orders', entity: 'Customer', confirmationToken: preview.confirmationToken, authorize: REPLY_1 }, deps));
  assert.equal(first.thrown, undefined, 'answered, never thrown: ' + first.thrown?.message);
  assert.deepEqual([first.value.ok, first.value.code, first.value.outcome, first.value.operationId], [false, 'BRIDGE_NOT_ATTACHED', 'not-sent', preview.operationId]);
  assert.equal(first.value.continuation?.tool, 'ssam_task');
  assert.deepEqual(h.deletes, []);
  const record = readOperation(preview.operationId, { root });
  assert.deepEqual([record.state, record.notSent, record.items.map(i => i.state)], ['refused', true, ['not-started', 'not-started']]);
  assert.ok(!fs.existsSync(leaseFile(preview.operationId, { root })), 'the lease is released');
  clock.now += 30000;
  const second = await studioDataDelete({ module: 'Orders', entity: 'Customer', confirmationToken: preview.confirmationToken, authorize: REPLY_2 }, deps);
  assert.equal(second.ok, true, JSON.stringify(second).slice(0, 400));
  assert.deepEqual(h.deletes, [['1', '2']]);
  assert.equal(second.operation.state, 'completed');
});

test('N2 (ssam data --lane o11): an exception in the read again closes the record refused/notSent with operationId and ssam_task; the owner\'s new reply then deletes', async () => {
  const root = tmp('cx15r3-n2-o11-'); const cwd = tmp('cx15r3-n2-o11-cwd-'); const clock = { now: T0 };
  const line = kernelLine({ failReadAt: 2 });
  const { preview, confirm } = await o11Preview(line, { root, cwd, clock });
  clock.now += CONFIRM_MIN_AGE_MS + 1000;
  const first = await call(() => confirm(REPLY_1));
  assert.equal(first.thrown, undefined, 'answered, never thrown: ' + first.thrown?.message);
  assert.deepEqual([first.value.ok, first.value.code, first.value.outcome, first.value.operationId], [false, 'BRIDGE_NOT_ATTACHED', 'not-sent', preview.operationId]);
  assert.equal(first.value.continuation?.tool, 'ssam_task');
  assert.deepEqual(line.deletes, []);
  assert.deepEqual([readOperation(preview.operationId, { root }).state, fs.existsSync(leaseFile(preview.operationId, { root }))], ['refused', false]);
  clock.now += 30000;
  const second = await confirm(REPLY_2);
  assert.notEqual(second.code, 'CONFIRMATION_ALREADY_USED');
  assert.deepEqual(line.deletes, [['1', '2']], JSON.stringify(second).slice(0, 400));
  assert.equal(second.operation.state, 'completed');
});

test('CT-4 (both data paths): a record that cannot be written after the send answers uncertain with operationId and ssam_task, releases the lease and reads interrupted; the same token answers OPERATION_INTERRUPTED', async () => {
  for (const lane of ['odc', 'o11']) {
    const root = tmp('cx15r3-ct4-' + lane + '-'); const cwd = tmp('cx15r3-ct4-cwd-'); const clock = { now: T0 };
    let file = null;
    try {
      let preview, run, sends;
      if (lane === 'odc') {
        const h = odcData(); const deps = { studioData: h.studioData, now: () => clock.now, root };
        preview = await studioDataDelete({ module: 'Orders', entity: 'Customer', ids: ['1', '2'] }, deps);
        h.afterDelete = () => fs.chmodSync(file, 0o444); // the rename over the record fails from here (EPERM)
        run = words => studioDataDelete({ module: 'Orders', entity: 'Customer', confirmationToken: preview.confirmationToken, authorize: words }, deps);
        sends = () => h.deletes.length;
      } else {
        const line = kernelLine(); const o = await o11Preview(line, { root, cwd, clock });
        preview = o.preview; line.afterDelete = () => fs.chmodSync(file, 0o444);
        run = words => o.confirm(words);
        sends = () => line.deletes.length;
      }
      file = operationFile(preview.operationId, { root });
      clock.now += CONFIRM_MIN_AGE_MS + 1000;
      const answer = await call(() => run(REPLY_1));
      assert.equal(answer.thrown, undefined, lane + ': answered, never thrown: ' + answer.thrown?.message);
      assert.equal(sends(), 1, lane);
      assert.deepEqual([answer.value.ok, answer.value.outcome, answer.value.operationId, answer.value.continuation?.tool], [false, 'uncertain', preview.operationId, 'ssam_task'], lane + ' ' + JSON.stringify(answer.value).slice(0, 300));
      assert.ok(!fs.existsSync(leaseFile(preview.operationId, { root })), lane + ': the lease is released');
      const read = readOperation(preview.operationId, { root });
      assert.deepEqual([read.orphaned, read.items.map(i => i.state)], [true, ['uncertain', 'uncertain']], lane + ': the record reads interrupted, its items uncertain');
      fs.chmodSync(file, 0o666);
      clock.now += 60000;
      const again = await run(REPLY_2);
      assert.equal(again.code, 'OPERATION_INTERRUPTED', lane + ' ' + JSON.stringify(again).slice(0, 300));
      assert.equal(again.continuation?.tool, 'ssam_task');
      assert.equal(sends(), 1, lane + ': nothing sent again');
    } finally { try { if (file) fs.chmodSync(file, 0o666); } catch { /* gone */ } }
  }
});

test('F3: a running record of a process that is gone answers OPERATION_INTERRUPTED (with the record and ssam_task), never CONFIRMATION_ALREADY_USED, in both data paths', async () => {
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  for (const lane of ['odc', 'o11']) {
    const root = tmp('cx15r3-dead-' + lane + '-'); const cwd = tmp('cx15r3-dead-cwd-'); const clock = { now: T0 };
    let preview, run, sends;
    if (lane === 'odc') {
      const h = odcData(); const deps = { studioData: h.studioData, now: () => clock.now, root };
      preview = await studioDataDelete({ module: 'Orders', entity: 'Customer', ids: ['1', '2'] }, deps);
      run = words => studioDataDelete({ module: 'Orders', entity: 'Customer', confirmationToken: preview.confirmationToken, authorize: words }, deps);
      sends = () => h.deletes.length;
    } else {
      const line = kernelLine(); const o = await o11Preview(line, { root, cwd, clock });
      preview = o.preview; run = words => o.confirm(words); sends = () => line.deletes.length;
    }
    // The process that ran the execution died while sending.
    const record = beginOperation({ preview: readPreview(preview.previewId, { root }), now: T0 + 6000, root, pid: dead, words: REPLY_1 });
    markItem(record, record.items[0], { state: 'sending' }, { now: T0 + 7000, root });
    clock.now += 120000;
    const answer = await run(REPLY_2);
    assert.equal(answer.code, 'OPERATION_INTERRUPTED', lane + ' ' + JSON.stringify(answer).slice(0, 300));
    assert.ok(!(answer.problems ?? []).some(p => p.code === 'CONFIRMATION_ALREADY_USED'), lane);
    assert.equal(answer.continuation?.tool, 'ssam_task', lane);
    assert.equal(answer.operation?.operationId ?? answer.operationId, preview.operationId, lane);
    assert.equal(sends(), 0, lane);
  }
});

test('CT-6: studio_data_delete (MCP) gives the bridge the sha256 of the words, never the words; neither the answer nor anything kept holds them', async () => {
  const root = tmp('cx15r3-ct6-'); const answers = tmp('cx15r3-ct6-answers-'); const clock = { now: T0 };
  const h = odcData();
  const server = await createFacadeServer({ deps: { studioData: h.studioData, destructive: { now: () => clock.now, root } } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cx15r3-ct6', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const valueOf = reply => reply.structuredContent ?? JSON.parse(reply.content[0].text);
  try {
    const preview = valueOf(await client.callTool({ name: 'studio_data_delete', arguments: { module: 'Orders', entity: 'Customer', ids: ['1', '2'] } }));
    clock.now += CONFIRM_MIN_AGE_MS + 1000;
    const done = valueOf(await client.callTool({ name: 'studio_data_delete', arguments: { module: 'Orders', entity: 'Customer', confirmationToken: preview.confirmationToken, authorize: REPLY_1 } }));
    assert.equal(done.ok, true, JSON.stringify(done).slice(0, 300));
    assert.deepEqual(h.deletes, [['1', '2']]);
    assert.match(h.authorizations[0], /^sha256:[0-9a-f]{64}$/, 'the bridge gets the sha256 of the words');
    const answerText = JSON.stringify(done);
    assert.ok(!answerText.includes(REPLY_1), 'the answer never carries the words');
    assert.ok(!/"authori[sz]ation"|"authorize"/.test(answerText), 'the answer never spreads the bridge\'s authorization');
    keepAnswer(done, answers); // what the answer fitter keeps under .local\answers
    const scan = dir => { const hits = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (fs.readFileSync(p).toString('utf8').includes(REPLY_1)) hits.push(p); } }; walk(dir); return hits; };
    assert.deepEqual([...scan(root), ...scan(answers), ...scan(isolatedProfile)], [], 'no file of the isolated profile, the destructive root or the kept answers holds the words');
  } finally { await client.close(); await server.close(); }
});
