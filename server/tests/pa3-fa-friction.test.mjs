// Atritos 3, lane fa, C33: the friction store keeps a daily index, so `issues` answers from it (counts and the two last
// ids per group) instead of reading every operation file (6,000 records took 1.45 s and 23.9 KB); an observer takes the
// MCP session id of its transport; auditOutcome reads structuredContent.ok and the code for the hosted audit. Temporary
// folders only.
import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createStore, auditOutcome, sessionKey } from '../facade/friction-store.mjs';
import { observeMcp, readQueue } from '../facade/friction-boundary.mjs';

const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa3-friction-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const CODES = ['PREFLIGHT_REFUSED', 'MERGE_UNCERTAIN', 'TIMEOUT', 'STUDIO_WRITE_QUEUE_TIMEOUT', 'BUILD_FAILED', 'RELEASE_CHANGED'];

// 5,000 operation records as the store writes them (start and end files), without the index: a store from before C33.
function seed(directory, count) {
  const folder = path.join(directory, 'operations');
  fs.mkdirSync(folder, { recursive: true });
  const base = Date.parse('2026-10-06T20:00:00Z');
  for (let i = 0; i < count; i++) {
    const operationId = randomUUID();
    const startedAt = new Date(base + i * 1000).toISOString();
    const start = { schema: 'ssam-friction-operation/1', operationId, sessionId: null, pid: 1, taskRef: null, correlation: 'absent', interface: 'mcp',
      operation: i % 2 ? 'deliver' : 'map', lane: i % 3 ? 'odc' : 'o11', profile: 'operational', startedAt };
    fs.writeFileSync(path.join(folder, operationId + '.start.json'), JSON.stringify(start));
    if (i % 997 === 5) continue; // a few without a completion receipt
    const failed = i % 10 !== 0;
    fs.writeFileSync(path.join(folder, operationId + '.end.json'), JSON.stringify({ ...start, outcome: failed ? 'failure' : 'success', code: failed ? CODES[i % CODES.length] : 'OK',
      step: failed ? 'merge' : null, endedAt: new Date(base + i * 1000 + 500).toISOString(), durationMs: 500 }));
  }
}
const strip = answer => ({ ...answer, health: undefined });

test('C33: 5,000 operations: issues answers from the index in under 300 ms and 8 KB; the rebuilt index equals the scan', t => {
  const directory = temp(t);
  seed(directory, 5000);
  const store = createStore({ directory });
  const scan = store.issues({ source: 'scan' });
  const first = store.issues(); // the store had no index: it is rebuilt once from the operation files
  assert.ok(fs.existsSync(path.join(directory, 'index', '.complete')));
  assert.deepEqual(strip(first), strip(scan), 'the index answers what the scan answers');
  const started = performance.now();
  const fast = createStore({ directory }).issues();
  const ms = performance.now() - started;
  const bytes = Buffer.byteLength(JSON.stringify(fast), 'utf8');
  assert.ok(ms < 300, 'issues took ' + Math.round(ms) + ' ms');
  assert.ok(bytes < 8192, 'issues answered ' + bytes + ' bytes');
  assert.equal(fast.total, scan.total);
  assert.deepEqual(fast.issues.map(i => [i.id, i.count, i.lastOperationIds]), scan.issues.map(i => [i.id, i.count, i.lastOperationIds]));
  assert.equal(fast.issues.reduce((n, i) => n + i.count, 0), scan.issues.reduce((n, i) => n + i.count, 0));
  // A lost index is rebuilt from disk, equal again.
  fs.rmSync(path.join(directory, 'index'), { recursive: true, force: true });
  assert.deepEqual(strip(createStore({ directory }).issues()), strip(scan));
  // max and offset page the groups.
  const page = readQueue(createStore({ directory }), { view: 'issues', max: 2, offset: 1 });
  assert.equal(page.issues.length, 2); assert.equal(page.offset, 1); assert.equal(page.limit, 2); assert.equal(page.issues[0].id, fast.issues[1].id);
});

test('C33: a new store writes its index as it records (no rebuild), one line per start and end', t => {
  const directory = temp(t);
  const store = createStore({ directory });
  for (let i = 0; i < 3; i++) store.begin({ interface: 'mcp', operation: 'deliver', lane: 'o11' }).finish({ ok: false, code: 'PREFLIGHT_REFUSED' });
  store.begin({ interface: 'mcp', operation: 'map', lane: 'odc' });
  assert.ok(fs.existsSync(path.join(directory, 'index', '.complete')), 'an empty store starts with a complete index');
  const lines = fs.readdirSync(path.join(directory, 'index')).filter(n => n.endsWith('.jsonl')).flatMap(n => fs.readFileSync(path.join(directory, 'index', n), 'utf8').trim().split('\n'));
  assert.equal(lines.length, 7);
  assert.deepEqual(strip(store.issues()), strip(store.issues({ source: 'scan' })));
  const text = lines.join('\n');
  assert.doesNotMatch(text, /PREFLIGHT_REFUSED.*error|arguments/, 'metadata only');
});

test('C33: each MCP session of one process keeps its own sessionId; without one, the observer has its own', t => {
  const directory = temp(t);
  const store = createStore({ directory });
  const run = sessionId => {
    const out = [];
    const observer = observeMcp({ root: directory, entry: 'ssam', args: ['mcp'], store, ...(sessionId ? { sessionId } : {}), toServer: () => {}, toClient: chunk => out.push(chunk) });
    observer.request.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"o11_deliver","arguments":{}}}\n');
    observer.response.write('{"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"ok":true}}}\n');
    observer.close();
  };
  run('mcp-session-a'); run('mcp-session-b'); run(null); run(null);
  const sessions = store.snapshot().operations.map(e => e.sessionId);
  assert.equal(new Set(sessions).size, 4);
  assert.ok(sessions.includes(sessionKey('mcp-session-a'))); assert.ok(sessions.includes(sessionKey('mcp-session-b')));
  assert.match(sessionKey('mcp-session-a'), /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.equal(JSON.stringify(store.snapshot()).includes('mcp-session-a'), false, 'never the transport id itself');
});

test('C33: auditOutcome counts structuredContent.ok false as a failure with its code', () => {
  const doctor = { content: [{ type: 'text', text: '{}' }], structuredContent: { ok: false, code: 'DOCTOR_LANE_UNUSABLE', lanes: {} } };
  assert.deepEqual(auditOutcome(doctor), { ok: false, code: 'DOCTOR_LANE_UNUSABLE' });
  assert.deepEqual(auditOutcome({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'PORTAL_TIMEOUT' } }) }] }), { ok: false, code: 'PORTAL_TIMEOUT' });
  assert.deepEqual(auditOutcome({ isError: true, content: [{ type: 'text', text: 'Input validation error: Invalid arguments for tool x' }] }), { ok: false, code: 'INPUT_INVALID' });
  assert.deepEqual(auditOutcome({ isError: true, content: [{ type: 'text', text: 'something odd' }] }), { ok: false, code: 'TOOL_ERROR' });
  assert.deepEqual(auditOutcome({ content: [{ type: 'text', text: 'entregue' }] }), { ok: true, code: null });
  assert.deepEqual(auditOutcome({ structuredContent: { ok: true } }), { ok: true, code: null });
});
