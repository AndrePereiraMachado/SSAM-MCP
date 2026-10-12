// A31 (package of 2026-10-06, lane F7a): ssam_friction records a gap, defect or slowness that produced no failure, by MCP
// (view "report"), linked to the last operations of the same session; the reads return it. Real case: the owner's notes
// (ButtonGroup missing from the html fragment, the session fell back to native create) and the Cardápio session, where
// "isso é uma friccao use ssam friction" ended in the CLI because the MCP tool only read. Synthetic queue folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore, outcomeOf, reportProblems, REPORT_KINDS } from '../facade/friction-store.mjs';
import { observeMcp, frictionTool, readQueue } from '../facade/friction-boundary.mjs';
import { main } from '../facade/friction-cli.mjs';

delete process.env.SSAM_FRICTION_DIR;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa2-f7a-friction-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const GAP = { kind: 'gap', tool: 'studio_deliver', intent: 'ButtonGroup Yes/No on the Options screen', attempted: 'op html with a <ButtonGroup> fragment',
  workaround: 'native create IButtonGroup + set Variable', cost: '4 calls', summary: 'o usuário: isso é uma fricção, registre' };

function session(t) {
  const directory = temp(t); const store = createStore({ directory, warning: () => {} });
  const sent = []; const received = [];
  const observer = observeMcp({ root, entry: 'ssam', args: ['mcp'], store, meta: { sessionId: randomUUID(), profile: 'operational' },
    toServer: s => sent.push(s), toClient: s => received.push(s) });
  t.after(() => observer.close());
  let id = 0;
  const answer = n => received.flatMap(s => s.split('\n')).filter(line => line.trim()).map(line => JSON.parse(line)).filter(m => m.id === n).at(-1);
  const call = (name, args) => { const n = ++id; observer.request.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) + '\n'); return n; };
  const respond = (n, value) => observer.response.write(JSON.stringify({ jsonrpc: '2.0', id: n, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) } }) + '\n');
  return { directory, store, sent, received, call, respond, answer };
}

test('ssam_friction {view:"report"} writes one record linked to this session, and issues returns it', t => {
  const s = session(t);
  const refused = s.call('o11_deliver', { module: 'Cardapio_UI', job: { ops: [] } });
  s.respond(refused, { ok: false, code: 'PREFLIGHT_REFUSED', error: '1 problem' });
  const forwarded = s.sent.length;
  const n = s.call('ssam_friction', { view: 'report', ...GAP });
  assert.equal(s.sent.length, forwarded, 'answered by the boundary, never forwarded to the server');
  const written = s.answer(n).result.structuredContent;
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.deepEqual([written.recorded, written.kind, written.linkedOperations], [true, 'gap', 1]);
  assert.ok(fs.existsSync(written.file) && written.file.startsWith(path.join(s.directory, 'reports')));
  const record = JSON.parse(fs.readFileSync(written.file, 'utf8'));
  assert.equal(record.schema, 'ssam-friction-report/1');
  assert.deepEqual([record.tool, record.intent, record.attempted, record.workaround, record.cost, record.summary], [GAP.tool, GAP.intent, GAP.attempted, GAP.workaround, GAP.cost, GAP.summary]);
  assert.deepEqual(record.recent.map(r => [r.operation, r.code]), [['deliver', 'PREFLIGHT_REFUSED']], 'linked to the last receipts of the session');
  assert.doesNotMatch(JSON.stringify(record), /Cardapio_UI/, 'never the arguments of other calls');
  const issues = s.call('ssam_friction', { view: 'issues' });
  const queue = s.answer(issues).result.structuredContent;
  assert.equal(queue.reportsTotal, 1); assert.equal(queue.reports[0].reportId, written.reportId);
  assert.equal(queue.issues[0].code, 'PREFLIGHT_REFUSED', 'the automatic records are still there');
});

test('a report without its fields refuses with every problem; an unknown field is a refusal with a code', t => {
  const s = session(t);
  const missing = s.answer(s.call('ssam_friction', { view: 'report', kind: 'bug', tool: 'o11_deliver' })).result;
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.code, 'REPORT_INVALID');
  assert.deepEqual(missing.structuredContent.problems, ['kind is one of gap, defect, slow', 'intent is required text', 'attempted is required text']);
  const extra = s.answer(s.call('ssam_friction', { view: 'report', ...GAP, transcript: 'x' })).result;
  assert.equal(extra.structuredContent.code, 'FRICTION_QUERY_INVALID'); assert.match(extra.structuredContent.error, /fields are view, kind/);
  assert.equal(fs.existsSync(path.join(s.directory, 'reports')), false, 'nothing written');
  assert.deepEqual(reportProblems({ ...GAP, summary: 'x'.repeat(1501) }), ['summary has 1501 characters; at most 1500']);
});

test('the tool lists the report view and its kinds; it is no longer read-only', () => {
  assert.deepEqual(frictionTool.inputSchema.properties.view.enum, ['issues', 'task', 'report']);
  assert.deepEqual(frictionTool.inputSchema.properties.kind.enum, REPORT_KINDS);
  for (const key of ['tool', 'intent', 'attempted', 'workaround', 'cost', 'summary', 'taskId']) assert.ok(frictionTool.inputSchema.properties[key], key);
  assert.equal(frictionTool.annotations.readOnlyHint, false);
  assert.match(frictionTool.description, /report records a gap, defect or slowness/);
});

test('a report correlated by taskId comes back in the task view; the CLI writes and reads the same records', async t => {
  const directory = temp(t); const store = createStore({ directory, warning: () => {} });
  const written = readQueue(store, { view: 'report', kind: 'slow', tool: 'ssam_map', intent: 'map of SS360_Backoffice', attempted: 'ssam_map', cost: 95, taskId: 'task-9' });
  assert.equal(written.ok, true);
  assert.equal(readQueue(store, { view: 'task', taskId: 'task-9' }).reports[0].kind, 'slow');
  assert.equal(readQueue(store, { view: 'task', taskId: 'other' }).reports, undefined);
  const cli = await main(['report', '--kind', 'defect', '--tool', 'ssam_evidence', '--intent', 'read the preview plan', '--attempted', 'ssam_evidence', '--task-id', 'task-9'], { root, store });
  assert.equal(cli.ok, true);
  const listed = await main(['issues'], { root, store });
  assert.deepEqual(listed.reports.map(r => r.kind).sort(), ['defect', 'slow']);
});

test('a refusal recorded without a code takes the code of its text before OPERATION_FAILED (A20, the same table as the shaper)', t => {
  const directory = temp(t); const store = createStore({ directory, warning: () => {} });
  const op = store.begin({ interface: 'mcp', operation: 'discover', lane: 'odc' });
  op.finish({ content: [{ type: 'text', text: 'Input validation error: Invalid arguments for tool ssam_discover: data/budgetBytes must be >= 4096' }], isError: true });
  const issue = store.issues().issues[0];
  assert.equal(issue.code, 'INPUT_INVALID');
  assert.doesNotMatch(fs.readdirSync(path.join(directory, 'operations')).map(f => fs.readFileSync(path.join(directory, 'operations', f), 'utf8')).join(), /budgetBytes/, 'the text is never stored');
  assert.equal(outcomeOf({ ok: false, error: 'debug_o11_native_execution_failed' }, {}, { tool: 'debug-run' }).code, 'DEBUG_O11_NATIVE_EXECUTION_FAILED');
  // only the debugger's own operations turn a debug_<x> word into a code (privacy review of 2026-10-12)
  assert.equal(outcomeOf({ ok: false, error: 'debug_o11_native_execution_failed' }).code, 'OPERATION_FAILED');
  assert.equal(outcomeOf({ ok: false, error: "Invalid object name 'debug_folha_pagamento_sntl'." }, {}, { tool: 'read' }).code, 'OPERATION_FAILED');
});
