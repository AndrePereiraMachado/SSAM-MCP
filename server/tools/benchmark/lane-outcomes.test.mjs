import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sanitizeRows, fixtureBytes } from './sanitize-fixture.mjs';
import { classifyOutcome, inferLane, laneOutcomes, isDeliveryWrite, responseObject } from './measure/lane-outcomes.mjs';
const write = output => ({ name: 'mcp__ssam_test__studio_deliver', args: {}, output });

test('one classifier recognizes each recorded response family on either lane', () => {
  const forms = [
    [{ outcome: 'refused', code: 'PREFLIGHT_REFUSED' }, 'refused'],
    [{ ok: false, failed: 'build' }, 'refused'],
    [{ ok: false, code: 'KERNEL_REFUSED' }, 'refused'],
    [{ outcome: 'uncertain' }, 'uncertain'],
    [{ ok: false, code: 'PUBLISH_UNCERTAIN' }, 'uncertain'],
    [{ ok: false, code: 'CANCELLED' }, 'uncertain'],
    [{ ok: false, code: 'TIMEOUT' }, 'uncertain'],
    ['Request timed out', 'uncertain'],
    [{ ok: true, result: 'entregue' }, 'accepted'],
    [{ ok: true, result: 'entregue e publicado' }, 'accepted'],
    [{ ok: true, result: 'delivered' }, 'accepted'],
    [{ ok: true, result: 'delivered and published' }, 'accepted'],
    [{ ok: false, result: 'delivered', failed: 'publish' }, 'accepted'],
    [{ ok: true, outcome: 'delivered' }, 'accepted'],
    [{ ok: false, result: 'entregue', failed: 'publish' }, 'accepted'],
    [{ ok: false, code: 'OTHER_FAILURE' }, 'failed'],
    [{ ok: true, merged: false, publishInvoked: false, until: 'build' }, 'staged'],
    [{ ok: true, merged: false, publishInvoked: false, until: 'preview' }, 'staged'],
    [{ status: 'queued' }, 'unclassified'],
  ];
  for (const [output, expected] of forms) for (const name of ['studio_deliver', 'o11_deliver']) assert.equal(classifyOutcome({ ...write(output), name }).outcome, expected);
  for (const failed of ['preflight', 'documents', 'apply', 'verify', 'check-base', 'preview']) assert.equal(classifyOutcome(write({ ok: false, failed })).outcome, 'refused');
});
test('publication is separate, first delivery and attempts are measured by lane', () => {
  const result = laneOutcomes([
    { ...write({ ok: false, code: 'KERNEL_REFUSED', problems: [{ code: 'BAD_NAME' }] }), start: 1 },
    { ...write({ ok: false, result: 'entregue', failed: 'publish' }), start: 2 },
    { name: 'studio_publish', output: { outcome: 'published' }, start: 3 },
    { name: 'o11_publish', output: { status: 'succeeded' }, start: 0 },
    { name: 'o11_deliver', output: { ok: true, result: 'entregue e publicado' }, start: 4 },
  ]);
  assert.equal(result.odc.writes, 2); assert.equal(result.odc.refused, 1); assert.equal(result.odc.accepted, 1);
  assert.equal(result.odc.firstTimeRight, false); assert.equal(result.odc.writesUntilAccepted, 2);
  assert.equal(result.odc.publishFailedAfterDelivery, 1); assert.equal(result.odc.publications.accepted, 1);
  assert.deepEqual(result.odc.problemCodes, { BAD_NAME: 1 }); assert.equal(result.o11.firstTimeRight, true);
});
test('lane comes from explicit arguments then prefixes, never a schema default', () => {
  assert.equal(inferLane({ name: 'studio_deliver', args: { lane: 'o11' } }), 'o11');
  for (const name of ['studio_merge', 'odc_deploy', 'hybrid_list']) assert.equal(inferLane({ name }), 'odc');
  for (const name of ['o11_job', 'context', 'propose', 'continue', 'status']) assert.equal(inferLane({ name }), 'o11');
  assert.equal(inferLane({ name: 'ssam_job' }), 'unknown');
  assert.equal(isDeliveryWrite({ name: 'ssam_code', args: { action: 'read' } }), false);
  assert.equal(isDeliveryWrite({ name: 'ssam_code', args: { action: 'write' } }), true);
  assert.equal(isDeliveryWrite({ name: 'o11_data', args: { action: 'insert' } }), true);
});
test('MCP wrappers preserve payload and client errors without JSON are uncertain', () => {
  assert.deepEqual(responseObject({ content: [{ type: 'text', text: '{"ok":false,"failed":"build"}' }] }), { ok: false, failed: 'build' });
  assert.equal(classifyOutcome(write({ isError: true, content: [{ type: 'text', text: 'connection closed' }] })).outcome, 'uncertain');
  assert.equal(classifyOutcome({ ...write('connection closed'), is_error: true }).outcome, 'uncertain');
  assert.equal(classifyOutcome({ ...write('connection closed'), name: 'ssam_map', is_error: true }).outcome, 'unclassified');
});
test('sanitized recorded O11 fixture retains accepted delivery shape', () => {
  const rows = fs.readFileSync(new URL('./fixtures/recorded/o11-refusal-acceptance.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
  const results = rows.filter(row => row.payload?.item?.type === 'McpToolCall').map(row => classifyOutcome({ name: row.payload.item.tool, output: row.payload.item.result })).filter(result => result.outcome !== 'unclassified');
  assert.ok(results.some(result => result.outcome === 'accepted'));
});

test('98 ODC writes include 23 accepted and 14 staged stops with no unclassified responses', { skip: process.env.BENCH_REAL_TRANSCRIPTS !== '1' || !fs.existsSync('C:/t/lacunas/cobertura-geradores/out/events.ndjson') }, t => {
  const base = 'C:/t/lacunas/cobertura-geradores/out/';
  const roots = new Set(JSON.parse(fs.readFileSync(base + 'coverage-sem-dcips.json', 'utf8')).perRoot.map(row => row.root));
  const selected = fs.readFileSync(base + 'events.ndjson', 'utf8').trim().split('\n').map(JSON.parse).filter(event => roots.has(event.root.slice(0, 8)) && event.kind === 'ssam' && /studio_deliver|studio_merge|studio_publish/.test(event.name));
  const cache = new Map(), results = [], forms = {};
  for (const event of selected) {
    assert.equal(event.client, 'claude', 'selection currently uses Claude tool_use/tool_result pairs');
    if (!cache.has(event.file)) {
      const rows = fs.readFileSync(event.file, 'utf8').split('\n').filter(Boolean).map(JSON.parse), pending = new Map(), calls = [];
      for (const row of rows) {
        if (row.type === 'assistant') for (const item of row.message?.content ?? []) if (item.type === 'tool_use') pending.set(item.id, { name: item.name, args: item.input, start: Date.parse(row.timestamp) });
        if (row.type === 'user' && Array.isArray(row.message?.content)) for (const item of row.message.content) if (item.type === 'tool_result' && pending.has(item.tool_use_id)) {
          calls.push({ ...pending.get(item.tool_use_id), output: item.content, is_error: item.is_error, end: Date.parse(row.timestamp) }); pending.delete(item.tool_use_id);
        }
      }
      cache.set(event.file, calls);
    }
    const matches = cache.get(event.file).filter(call => call.name === event.name && call.start === event.t && call.end === event.end);
    assert.equal(matches.length, 1, 'each metadata selection pairs exactly once by tool name and both timestamps');
    const result = classifyOutcome(matches[0]); results.push(result);
    const key = JSON.stringify({ ...result.shape, classification: result.outcome }); forms[key] = (forms[key] ?? 0) + 1;
  }
  assert.equal(selected.length, 98); assert.equal(results.length, 98);
  const counts = results.reduce((value, row) => { value[row.outcome] = (value[row.outcome] ?? 0) + 1; return value; }, {});
  t.diagnostic(JSON.stringify({ matched: results.length, counts, forms }));
  // User-approved addition: successful stops before merge are staged, and never
  // delivery accepts. Unknown shapes still remain explicitly unclassified.
  assert.equal(counts.unclassified ?? 0, 0); assert.equal(counts.staged, 14); assert.equal(counts.accepted, 23); assert.equal(counts.refused, 44);
  assert.equal(counts.uncertain, 13); assert.equal(counts.failed, 4);
});
test('client input validation is refused; explicit uncertainty precedes inferred refusal', () => {
  const result = classifyOutcome({ ...write('<tool_use_error>InputValidationError: bad arguments</tool_use_error>'), is_error: true });
  assert.equal(result.outcome, 'refused'); assert.equal(result.code, 'CLIENT_INPUT_INVALID');
  assert.equal(laneOutcomes([{ ...write('InputValidationError: bad arguments'), is_error: true }]).odc.refusalCodes.CLIENT_INPUT_INVALID, 1);
  for (const output of [{ ok: false, failed: 'build', outcome: 'uncertain' }, { ok: false, code: 'KERNEL_REFUSED', outcome: 'uncertain' }, { ok: false, failed: 'apply', code: 'DELIVERY_UNCERTAIN' }]) assert.equal(classifyOutcome(write(output)).outcome, 'uncertain');
  assert.equal(classifyOutcome(write({ ok: false, outcome: 'refused', code: 'DELIVERY_UNCERTAIN' })).outcome, 'refused');
  assert.equal(classifyOutcome(write({ message: 'InputValidationError: text in a JSON object' })).outcome, 'unclassified');
  assert.equal(classifyOutcome(write('InputValidationError example without a client error flag')).outcome, 'unclassified');
});
test('staged shape is precise and never marks a completed delivery or first-time success', () => {
  const output = { ok: true, merged: false, publishInvoked: false, until: 'build' };
  assert.equal(laneOutcomes([write(output)]).odc.staged, 1);
  assert.equal(laneOutcomes([write(output)]).odc.firstTimeRight, false);
  assert.equal(laneOutcomes([write(output)]).odc.writesUntilAccepted, null);
  for (const unknown of [{ ...output, until: 'merge' }, { ...output, until: 'apply' }, { ...output, merged: true }, { ...output, publishInvoked: true }, { ok: true, until: 'build' }, { outcome: 'staged' }]) assert.equal(classifyOutcome(write(unknown)).outcome, 'unclassified');
});

test('recorded ODC response families match their expected classifiers', () => {
  const directory = new URL('./fixtures/recorded/', import.meta.url);
  for (const name of fs.readdirSync(directory).filter(name => /^odc-.*\.jsonl$/.test(name))) {
    const rows = fs.readFileSync(new URL(name, directory), 'utf8').trim().split('\n').map(JSON.parse);
    const expected = JSON.parse(fs.readFileSync(new URL(name.replace('.jsonl', '.expected.json'), directory), 'utf8'));
    const item = rows[0].message.content[0];
    assert.deepEqual(classifyOutcome({ name: expected.tool, output: item.content, is_error: item.is_error }), expected.result, name);
  }
});
test('ODC original excerpts and sanitized excerpts give identical outcome evidence', { skip: process.env.BENCH_REAL_TRANSCRIPTS !== '1' || !fs.existsSync('C:/t/codex/cx10/w3/odc-build-without-code.original.jsonl') }, () => {
  const directory = new URL('./fixtures/recorded/', import.meta.url);
  for (const name of fs.readdirSync(directory).filter(name => /^odc-.*\.jsonl$/.test(name))) {
    if (name === 'odc-client-input-invalid.jsonl') continue; // Its original belongs to the complement proof below.
    const rows = fs.readFileSync(new URL(name, directory), 'utf8').trim().split('\n').map(JSON.parse);
    const original = fs.readFileSync('C:/t/codex/cx10/w3/' + name.replace('.jsonl', '.original.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(sanitizeRows(original), rows, name);
    assert.ok(Math.abs(fixtureBytes(original) - fixtureBytes(rows)) / fixtureBytes(original) < .01, name);
  }
});
test('recorded client input validation survives sanitization with its refusal code', { skip: process.env.BENCH_REAL_TRANSCRIPTS !== '1' || !fs.existsSync('C:/t/codex/cx10/complement-outcomes/odc-client-input-invalid.original.jsonl') }, () => {
  const original = fs.readFileSync('C:/t/codex/cx10/complement-outcomes/odc-client-input-invalid.original.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
  const rows = fs.readFileSync(new URL('./fixtures/recorded/odc-client-input-invalid.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(sanitizeRows(original), rows);
  assert.equal(fixtureBytes(original), fixtureBytes(rows));
  const result = row => classifyOutcome({ name: 'studio_deliver', output: row.message.content[0].content, is_error: row.message.content[0].is_error });
  assert.deepEqual(result(original[0]), result(rows[0])); assert.equal(result(rows[0]).code, 'CLIENT_INPUT_INVALID');
});
