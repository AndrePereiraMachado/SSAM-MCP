import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, deliveryOfCall, deliveryOfAnswer, jobRef, operationName } from '../facade/friction-store.mjs';
import { observeMcp, readQueue, frictionTool } from '../facade/friction-boundary.mjs';
import { main } from '../facade/friction-cli.mjs';
import { deliveryKpi, isoWeek, KPI_COLUMNS, kpiRange, logicalDeliveries, quantile, readReceipts } from '../facade/friction-kpi.mjs';

// R0 (plano de 24/10/2026): the chain identity the boundary records and the delivery KPI view.
delete process.env.SSAM_FRICTION_DIR;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/friction-kpi-queue.json'), 'utf8'));
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-kpi-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
// The fixture as a queue folder (index/<yyyymmdd>.jsonl by the day of each start) and a receipts folder.
function queue(t, lines = fixture.index, receipts = fixture.receipts) {
  const dir = temp(t), index = path.join(dir, 'friction', 'index'), deliver = path.join(dir, 'deliver');
  fs.mkdirSync(index, { recursive: true });
  for (const line of lines) fs.appendFileSync(path.join(index, line.startedAt.slice(0, 10).replace(/-/g, '') + '.jsonl'), JSON.stringify(line) + '\n');
  fs.writeFileSync(path.join(index, '.complete'), '{}');
  for (const r of receipts) { fs.mkdirSync(path.join(deliver, r.name), { recursive: true }); fs.writeFileSync(path.join(deliver, r.name, 'result.json'), JSON.stringify(r.result)); }
  return { directory: path.join(dir, 'friction'), receipts: deliver };
}
const rowsOf = answer => { const table = answer.paged.tables[0]; return table.rows.map(r => Object.fromEntries(table.columns.map((c, i) => [c, r[i]]))); };
const rowOf = (answer, week, lane) => rowsOf(answer).find(r => r.week === week && r.lane === lane);

test('R0: a delivery call records tool, module, basedOn, continueTask and its answer\'s task, job, codes and phases, nothing else', t => {
  const directory = temp(t); let now = Date.parse('2026-10-20T10:00:00Z');
  const store = createStore({ directory, clock: () => now, warning: () => {} });
  const answers = [];
  const observer = observeMcp({ store, meta: { sessionId: '44444444-4444-4444-8444-444444444444' }, toServer: () => {}, toClient: () => {} });
  t.after(() => observer.close());
  const call = (id, name, args) => (now += 1000) && observer.request.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  const answer = (id, value) => { answers.push(value); observer.response.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) } }) + '\n'); };
  call(1, 'o11_deliver', { lane: 'o11', module: 'Demandas_TW', authorize: 'secret words of the owner', ops: [{ op: 'logic', data: { flow: 'secret flow text' } }],
    basedOn: { job: 'C:\\Users\\someone\\kernel\\.local\\jobs\\inline\\prev.json', sha256: 'A'.repeat(64) }, closePrevious: 'ffc65dfb24774d8083c7d736962a0d7f' });
  now += 9000;
  answer(1, { ok: false, code: 'PREFLIGHT_REFUSED', stage: 'closed-for-revision', taskId: '0123456789abcdef0123456789abcdef',
    nextBasedOn: { job: 'C:\\Users\\someone\\kernel\\.local\\jobs\\inline\\next.json', sha256: 'b'.repeat(64) },
    problems: [{ code: 'FLOW_SYNTAX', phase: 'preflight', message: 'line 3: secret flow text' }, { code: 'FLOW_SYNTAX', phase: 'preflight', message: 'x' },
      { code: 'ExpressionUnknownObject', phase: 'verify', message: 'Unknown secret' }] });
  call(2, 'ssam_code', { lane: 'o11', action: 'read', part: 'logic', target: 'Demandas_TW' });
  answer(2, { ok: true });
  call(3, 'ssam_code', { lane: 'o11', action: 'write', part: 'logic', module: 'Demandas_TW', text: 'secret logic', basedOn: 'textsha-not-a-job' });
  answer(3, { state: 'running', task: { id: 'facadetask-0001', tool: 'ssam_code' }, continuation: { tool: 'ssam_code', arguments: { continueTask: 'facadetask-0001' } } });
  call(4, 'ssam_code', { continueTask: 'facadetask-0001', lane: 'o11' });
  answer(4, { ok: true, result: 'delivered', taskId: 'fedcba9876543210fedcba9876543210' });
  call(5, 'studio_publish', { lane: 'odc', target: 'C:\\apps\\capture.oml', authorize: 'publish it' });
  answer(5, { ok: true });
  const ops = store.snapshot().operations;
  assert.deepEqual(ops.map(o => o.operation), ['deliver', 'code', 'code', 'code', 'publish']);
  const [deliver, read, write, resumed, publish] = ops;
  assert.deepEqual(deliver.delivery, { tool: 'o11_deliver', module: 'Demandas_TW', basedOnJob: jobRef('c:/users/someone/kernel/.local/jobs/inline/prev.json'),
    basedOnSha256: 'a'.repeat(64), closePrevious: 'ffc65dfb24774d8083c7d736962a0d7f', taskId: '0123456789abcdef0123456789abcdef',
    nextJob: jobRef('C:/Users/someone/kernel/.local/jobs/inline/next.json'), nextSha256: 'b'.repeat(64), stage: 'closed-for-revision',
    problems: [{ code: 'FLOW_SYNTAX', phase: 'preflight', count: 2 }, { code: 'ExpressionUnknownObject', phase: 'verify', count: 1 }], problemCount: 3 });
  assert.equal(read.delivery, undefined, 'a read of ssam_code is not a delivery');
  assert.deepEqual(write.delivery, { tool: 'ssam_code', action: 'write', module: 'Demandas_TW', taskId: 'facadetask-0001' });
  assert.equal(write.code, 'CONTINUED');
  assert.deepEqual(resumed.delivery, { tool: 'ssam_code', continueTask: 'facadetask-0001', taskId: 'fedcba9876543210fedcba9876543210', result: 'delivered' });
  assert.deepEqual(publish.delivery, { tool: 'studio_publish' }, 'a capture path is never a module');
  // The index carries the same fields (the KPI reads only the index); no text, message, path or authorize words anywhere.
  const index = fs.readdirSync(path.join(directory, 'index')).filter(n => n.endsWith('.jsonl')).map(n => fs.readFileSync(path.join(directory, 'index', n), 'utf8')).join('');
  assert.equal(index.split('\n').filter(l => l.includes('"delivery"')).length, 8, 'start and end of the three deliveries and the publish; never the read');
  const everything = index + fs.readdirSync(path.join(directory, 'operations')).map(f => fs.readFileSync(path.join(directory, 'operations', f), 'utf8')).join('');
  assert.doesNotMatch(everything, /secret|someone|publish it|line 3|textsha|capture\.oml|inline|message/);
  assert.equal(answers.length, 5);
  // The KPI: the deliver and the ssam_code write (its continuation joined by the hand-off's task); the read and the publish are no delivery.
  const row = rowOf(readQueue(store, { view: 'delivery-kpi' }), 'total', 'o11');
  assert.deepEqual([row.logical, row.chains, row.continuedPct, row.firstAcceptedPct, row.refusedAfterBuildPct], [2, 1, 50, 0, 100]);
});

test('R0: the call and answer sides keep only checked shapes', () => {
  assert.equal(deliveryOfCall('o11_inspect', { module: 'M' }), null);
  assert.equal(deliveryOfCall('ssam_code', { action: 'grammar' }), null);
  assert.deepEqual(deliveryOfCall('ssam_code', { action: 'plan', module: 'M' }), { tool: 'ssam_code', action: 'plan', module: 'M' });
  assert.deepEqual(deliveryOfCall('o11_deliver', { module: '../../etc', continueTask: 'short', basedOn: { taskId: 'x'.repeat(65), job: 7 } }), { tool: 'o11_deliver' });
  assert.equal(jobRef('C:\\A\\b.json'), jobRef('c:/a/B.JSON'));
  assert.deepEqual(deliveryOfAnswer({ ok: false, problems: [{ code: 'not a code', phase: 'apply' }, { code: 'APPLY_FAILED', phase: 'Not A Phase' }] }),
    { problems: [{ code: 'APPLY_FAILED', count: 1 }], problemCount: 1 });
  assert.equal(operationName('ssam_code'), 'code');
});

test('R0 delivery-kpi: each of the eight measures by ISO week and lane, from the index and the receipts', t => {
  const { directory, receipts } = queue(t);
  const store = createStore({ directory, receipts, warning: () => {} });
  const answer = readQueue(store, { view: 'delivery-kpi', since: '2026-10-11', until: '2026-10-24' });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.paged.tables[0].columns, KPI_COLUMNS);
  assert.deepEqual(rowsOf(answer).map(r => r.week + ' ' + r.lane), ['2026-W42 o11', '2026-W43 o11', '2026-W43 odc', 'total o11', 'total odc', 'total all']);
  const w43 = rowOf(answer, '2026-W43', 'o11');
  assert.deepEqual(w43, { week: '2026-W43', lane: 'o11', logical: 6, chains: 3, inferredChains: 1,
    firstAcceptedPct: 33.3,          // (a) only B3's chain is accepted at its first logical delivery
    attemptsPerAccepted: 2,          // (b) A1..A3 (3) and B3 (1)
    sameCodePairs: 2,                // (c) A1-A2 PREFLIGHT_REFUSED, B1-B2 HTML_INVALID
    readsP50: 4, readsP90: 5.6,      // (d) A3: map + discover without lane; B3: 5 inspect + reference without lane (the odc map is not counted)
    continuedPct: 33.3,              // (e) A3 (recorded continueTask) and B3 (25 s RESULT_UNOBSERVED then a call 5 s later)
    wallP50s: 37.5, wallP90s: 39.5,  // (f) A3 40 s, B3 35 s
    refusedAfterBuildPct: 50, refusedAfterBuildOf: 2, refusedAfterBuildSource: 'queue', // (g) A2 (verify) of A1, A2
    kernelP50s: 9, kernelP90s: 9.8, receipts: 4 });                                    // (h) 8 s and 10 s
  assert.deepEqual(rowOf(answer, '2026-W42', 'o11'), { week: '2026-W42', lane: 'o11', logical: 1, chains: 1, inferredChains: 0, firstAcceptedPct: 100,
    attemptsPerAccepted: 1, sameCodePairs: 0, readsP50: 0, readsP90: 0, continuedPct: 0, wallP50s: 10, wallP90s: 10,
    refusedAfterBuildPct: null, refusedAfterBuildOf: 0, refusedAfterBuildSource: null, kernelP50s: null, kernelP90s: null, receipts: 0 });
  assert.equal(rowOf(answer, '2026-W43', 'odc').wallP50s, 44);
  assert.deepEqual([rowOf(answer, 'total', 'all').logical, rowOf(answer, 'total', 'all').chains, rowOf(answer, 'total', 'o11').firstAcceptedPct], [8, 5, 50]);
  assert.deepEqual([answer.logical, answer.calls, answer.recordedCalls], [8, 10, 5]);
  // The lane filter and a range that leaves the week 42 out.
  assert.deepEqual(rowsOf(readQueue(store, { view: 'delivery-kpi', lane: 'odc' })).map(r => r.week + ' ' + r.lane), ['2026-W43 odc', 'total odc', 'total all']);
  assert.equal(rowsOf(readQueue(store, { view: 'delivery-kpi', since: '2026-10-19' })).some(r => r.week === '2026-W42'), false);
  // The view never writes the queue.
  assert.deepEqual(fs.readdirSync(directory).sort(), ['index']);
});

test('R0 delivery-kpi: a recorded link joins a chain across a 85 min gap; the heuristic splits one after 45 min', t => {
  const kpi = lines => { const { directory, receipts } = queue(t, lines, []); return rowOf(readQueue(createStore({ directory, receipts, warning: () => {} }), { view: 'delivery-kpi' }), 'total', 'o11'); };
  const sessionA = fixture.index.filter(l => l.sessionId.startsWith('1111'));
  assert.deepEqual([kpi(sessionA).chains, kpi(sessionA).inferredChains, kpi(sessionA).attemptsPerAccepted, kpi(sessionA).firstAcceptedPct], [1, 0, 3, 0]);
  // The same calls without the recorded identity: A3 starts 85 min after A2 and opens a chain of its own, accepted first.
  const unrecorded = sessionA.map(({ delivery, ...line }) => line);
  assert.deepEqual([kpi(unrecorded).chains, kpi(unrecorded).inferredChains, kpi(unrecorded).attemptsPerAccepted, kpi(unrecorded).firstAcceptedPct], [2, 1, 1, 50]);
});

test('R0 delivery-kpi: refusals after the native build come from the receipts when the queue has no phases', t => {
  const { receipts } = queue(t, [], fixture.receipts);
  const read = readReceipts(receipts, kpiRange({ since: '2026-10-20', until: '2026-10-20' }));
  assert.deepEqual(read.receipts.map(r => [r.delivered, r.kernelMs, r.phases]).sort(), [[false, null, ['apply', 'verify']], [false, null, ['preflight']], [true, 10000, []], [true, 8000, []]]);
  const sessionB = fixture.index.filter(l => l.sessionId.startsWith('2222'));
  const ops = (() => { const { directory } = queue(t, sessionB, []); return createStore({ directory, receipts: null, warning: () => {} }); })();
  const fromQueue = rowOf(ops.deliveryKpi({}), 'total', 'o11');
  assert.deepEqual([fromQueue.refusedAfterBuildPct, fromQueue.refusedAfterBuildSource, fromQueue.receipts], [null, null, 0]);
  const merged = deliveryKpi({ operations: sessionB, receipts: read.receipts }).rows.find(r => r.week === 'total' && r.lane === 'o11');
  assert.deepEqual([merged.refusedAfterBuildPct, merged.refusedAfterBuildOf, merged.refusedAfterBuildSource], [50, 2, 'receipts']);
});

test('R0 delivery-kpi: the boundary records a correction chain the KPI links without the heuristic', t => {
  const directory = temp(t); let now = Date.parse('2026-10-21T09:00:00Z');
  const store = createStore({ directory, clock: () => now, receipts: null, warning: () => {} });
  const observer = observeMcp({ store, meta: { sessionId: '55555555-5555-4555-8555-555555555555' }, toServer: () => {}, toClient: () => {} });
  t.after(() => observer.close());
  const call = (id, args, value, ms) => {
    observer.request.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'o11_deliver', arguments: { lane: 'o11', module: 'M', ...args } } }) + '\n');
    now += ms; observer.response.write(JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent: value } }) + '\n');
  };
  call(1, { ops: [] }, { ok: false, code: 'CHILD_NOT_FOUND', taskId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', nextBasedOn: { job: 'C:\\w\\jobs\\one.json', sha256: 'c'.repeat(64) },
    problems: [{ code: 'CHILD_NOT_FOUND', phase: 'apply' }] }, 12000);
  now += 50 * 60_000; // past the 45 min of the heuristic
  call(2, { patch: [], basedOn: { job: 'c:/w/jobs/ONE.json', sha256: 'c'.repeat(64) } }, { ok: true, result: 'delivered', taskId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, 8000);
  const row = rowOf(readQueue(store, { view: 'delivery-kpi', lane: 'o11' }), 'total', 'o11');
  assert.deepEqual([row.logical, row.chains, row.inferredChains, row.firstAcceptedPct, row.attemptsPerAccepted, row.refusedAfterBuildPct, row.refusedAfterBuildSource, row.wallP50s],
    [2, 1, 0, 0, 2, 100, 'queue', 8]);
});

test('R0 delivery-kpi: MCP and CLI answer it; invalid ranges and fields are refused; --root reads another root without writing', async t => {
  const { directory, receipts } = queue(t);
  const store = createStore({ directory, receipts, warning: () => {} });
  let response;
  const observer = observeMcp({ store, meta: {}, toServer: () => assert.fail('the KPI is answered locally'), toClient: text => { response = JSON.parse(text).result.structuredContent; } });
  t.after(() => observer.close());
  observer.request.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ssam_friction', arguments: { view: 'delivery-kpi', since: '2026-10-20', until: '2026-10-20' } } }) + '\n');
  assert.equal(response.ok, true); assert.equal(rowOf(response, 'total', 'all').logical, 7);
  for (const args of [{ view: 'delivery-kpi', since: 'yesterday' }, { view: 'delivery-kpi', lane: 'both' }, { view: 'delivery-kpi', since: '2026-10-24', until: '2026-10-11' }, { view: 'delivery-kpi', limit: 5 }]) {
    observer.request.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ssam_friction', arguments: args } }) + '\n');
    assert.equal(response.code, 'FRICTION_QUERY_INVALID'); assert.match(response.error, /^Invalid delivery-kpi/);
  }
  assert.ok(frictionTool.inputSchema.properties.view.enum.includes('delivery-kpi'));
  const cli = await main(['delivery-kpi', '--since', '2026-10-11', '--lane', 'o11'], { store });
  assert.equal(rowOf(cli, 'total', 'o11').logical, 7);
  // --root: <root>/.local/friction and <root>/kernel/.local/work/deliver.
  const other = temp(t); fs.mkdirSync(path.join(other, '.local')); fs.mkdirSync(path.join(other, 'kernel', '.local', 'work'), { recursive: true });
  fs.cpSync(directory, path.join(other, '.local', 'friction'), { recursive: true }); fs.cpSync(receipts, path.join(other, 'kernel', '.local', 'work', 'deliver'), { recursive: true });
  const before = fs.readdirSync(path.join(other, '.local', 'friction', 'index')).sort();
  const viaRoot = await main(['delivery-kpi', '--root', other], { store });
  assert.deepEqual(rowOf(viaRoot, '2026-W43', 'o11').kernelP50s, 9);
  assert.deepEqual(fs.readdirSync(path.join(other, '.local', 'friction')).sort(), ['index']);
  assert.deepEqual(fs.readdirSync(path.join(other, '.local', 'friction', 'index')).sort(), before);
});

test('R0 delivery-kpi: helpers (ISO week, quantile, range, continuation of an unrecorded hand-off)', () => {
  assert.deepEqual(['2026-10-11', '2026-10-12', '2026-10-18', '2026-10-19', '2026-10-24', '2027-01-01', '2026-12-31'].map(d => isoWeek(Date.parse(d + 'T12:00:00Z'))),
    ['2026-W41', '2026-W42', '2026-W42', '2026-W43', '2026-W43', '2026-W53', '2026-W53']);
  assert.deepEqual([quantile([], 0.5), quantile([3], 0.9), quantile([1, 2, 3, 4], 0.5), quantile([10, 0, 20], 0.9)], [null, 3, 2.5, 18]);
  assert.deepEqual(kpiRange({ since: '2026-10-11', until: '2026-10-24' }), { from: Date.parse('2026-10-11T00:00:00Z'), to: Date.parse('2026-10-25T00:00:00Z') });
  assert.throws(() => kpiRange({ since: 5 }), /since\/until/);
  // A 25 s RESULT_UNOBSERVED followed 11 min later is not a continuation (the hand-off window is 10 min).
  const line = (id, start, end, code) => ({ id, startedAt: start, endedAt: end, operation: 'deliver', lane: 'o11', sessionId: 's', interface: 'mcp', outcome: code === 'OK' ? 'success' : 'unknown', code });
  assert.equal(logicalDeliveries([line('1', '2026-10-20T10:00:00Z', '2026-10-20T10:00:25Z', 'RESULT_UNOBSERVED'), line('2', '2026-10-20T10:11:26Z', '2026-10-20T10:11:30Z', 'OK')]).length, 2);
  assert.equal(logicalDeliveries([line('1', '2026-10-20T10:00:00Z', '2026-10-20T10:00:25Z', 'RESULT_UNOBSERVED'), line('2', '2026-10-20T10:01:00Z', '2026-10-20T10:01:30Z', 'OK')]).length, 1);
});
