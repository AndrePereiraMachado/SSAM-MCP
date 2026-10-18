// Round 5 of fix/no-internals (re-review C:\t\revisoes\no-internals-4\REVISAO.md): ssam_friction is answered by the launcher
// (facade/friction-boundary.mjs observeMcp), in the parent process, never by the hub's exposure rule.
// - LOW 4: on a licensee's server its answer passes the licensee rule too, on every MCP entry of the launcher (ssam mcp,
//   odc mcp, package mcp): no folder of the server (a report's file names the queue folder);
// - LOW 2 (decision D13): an answer of ssam_friction the launcher keeps for a later read carries its origin record
//   {tool:"ssam_friction"}, so the licensee's ssam_evidence reads it back (a kept answer without a record is refused).
// The owner's answers are the ones of before, byte for byte, and keep no record.
import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { frictionAnswerShaper, root } from '../facade/launch.mjs';
import { fitResult } from '../platforms/odc/facade/answer-size.mjs';
import { pageAnswer, maxAnswerBytes } from '../platforms/odc/facade/ssam.mjs';
import { findings } from '../platforms/odc/facade/tests/fixtures/internal-text.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-internals-friction-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
const asResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const queue = path.join(root, '.local', 'friction');
const reportAnswer = () => { const reportId = randomUUID(); return { ok: true, recorded: true, reportId, kind: 'gap', file: path.join(queue, 'reports', reportId + '.json'), linkedOperations: 0 }; };
const reportArgs = { view: 'report', kind: 'gap', tool: 'ssam_code', intent: 'a screen', attempted: 'the compact form' };
// A queue page larger than the answer ceiling: kept for a later read.
const largeIssues = () => ({ ok: true, total: 400, offset: 0, limit: 100, health: { damagedRecords: 0, partialRecords: 0, localWriteLosses: 0 },
  issues: Array.from({ length: 400 }, (_, i) => ({ id: 'issue-' + i, operation: 'deliver', lane: 'o11', code: 'PREFLIGHT_REFUSED', count: i + 1, lastStep: 'preflight', lastSeen: '2026-10-17T10:00:00.000Z', lastOperationIds: [randomUUID(), randomUUID()], state: { status: 'new', revision: null, updatedAt: null } })),
  notificationDelivery: 'queue-only; no notification consumer is installed' });
const keptFileOf = value => value?.paged?.file ?? value?.omitted?.arguments?.file ?? null;
const recordOf = file => file.replace(/\.json$/i, '') + '.origin';
const ENTRIES = [['ssam', ['mcp']], ['odc', ['mcp']], ['ssam', ['package', 'mcp']]];

test('licensee: the answer of ssam_friction names no folder of the server, on every MCP entry (LOW 4)', async () => {
  const answerRoot = fs.mkdtempSync(path.join(tmp, 'answers-'));
  for (const [entry, args] of ENTRIES) {
    const label = entry + ' ' + args.join(' ');
    const shape = frictionAnswerShaper({ entry, args, env: { SSAM_EXPOSURE: 'licensee' }, answerRoot });
    assert.equal(typeof shape, 'function', label + ': the answer is shaped');
    const value = reportAnswer();
    const shaped = await shape(reportArgs, asResult(value));
    const text = JSON.stringify(shaped);
    assert.ok(!text.includes(queue) && !text.includes(JSON.stringify(queue).slice(1, -1)), label + ': the queue folder is served: ' + text.slice(0, 300));
    assert.deepEqual(findings(shaped.structuredContent), [], label);
    assert.equal(shaped.structuredContent.reportId, value.reportId, label + ': what the session uses stays');
    assert.equal(shaped.structuredContent.ok, true);
    assert.deepEqual(JSON.parse(shaped.content[0].text), shaped.structuredContent, label + ': the text is the same answer');
  }
});

test('licensee: a large ssam_friction answer is kept with its origin record {tool:"ssam_friction"} (D13)', async () => {
  const answerRoot = fs.mkdtempSync(path.join(tmp, 'answers-'));
  const shape = frictionAnswerShaper({ entry: 'ssam', args: ['mcp'], env: { SSAM_EXPOSURE: 'licensee' }, answerRoot });
  const shaped = await shape({ view: 'issues', limit: 100 }, asResult(largeIssues()));
  const file = keptFileOf(shaped.structuredContent);
  assert.ok(file && fs.existsSync(file), 'the answer was kept: ' + JSON.stringify(shaped.structuredContent).slice(0, 300));
  assert.ok(file.startsWith(path.join(answerRoot, '.local', 'answers')), file);
  assert.ok(fs.existsSync(recordOf(file)), 'the kept answer has its origin record');
  assert.deepEqual(JSON.parse(fs.readFileSync(recordOf(file), 'utf8')), { tool: 'ssam_friction' });
});

test('owner: the answers of ssam_friction are the ones of before, and no record is kept', async () => {
  const answerRoot = fs.mkdtempSync(path.join(tmp, 'answers-'));
  const before = (args, result) => pageAnswer(fitResult('ssam_friction', args, result, { root: answerRoot }), { root: answerRoot, maxBytes: maxAnswerBytes() });
  const shape = frictionAnswerShaper({ entry: 'ssam', args: ['mcp'], env: {}, answerRoot });
  assert.equal(typeof shape, 'function');
  for (const [args, value] of [[reportArgs, reportAnswer()], [{ view: 'issues', limit: 100 }, largeIssues()]]) {
    const result = asResult(value);
    const shaped = await shape(args, result);
    assert.equal(JSON.stringify(shaped), JSON.stringify(before(args, asResult(value))));
    const file = keptFileOf(shaped.structuredContent);
    if (file) assert.equal(fs.existsSync(recordOf(file)), false, 'the owner keeps no origin record');
  }
  // the other entries answer as before: unshaped
  for (const [entry, args] of ENTRIES.slice(1)) assert.equal(frictionAnswerShaper({ entry, args, env: {}, answerRoot }), undefined, entry + ' ' + args.join(' '));
});
