import { isolatedProfile } from './fixtures/isolated-profile.mjs';
// Wave 2 of the proto (C-20, ported from proto aafddc51): a tool accepts every field its own published schema lists. The schemas are read from the tools as
// published (frictionTool, the live ssam_map registry), each field given a minimal value of its own schema, and the
// validator of the tool must take it in at least one view; the field a view does not take is refused with the view that
// takes it, never "fields are ..." for a field the schema offers. The real cases: ssam_friction {view:"report", lane}
// (EW, F-FigmaReactive-12c, F-FT-20, F-FitBody-53b), {view:"issues", since} (the consolidation), ssam_map view ddl with a
// list in element (F-FitBody-48a), view html with a list in screen (F-FitBody-53a), the continuation of a long call that
// repeats the fields the schema requires (o11_data, F-FitBody-48b). No Studio, no kernel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { frictionTool, readQueue } from '../../../../facade/friction-boundary.mjs';
import { createStore } from '../../../../facade/friction-store.mjs';
import { createSsamServer } from '../ssam.mjs';
import { moduleMap } from '../module-map.mjs';
import { createCallDeadline } from '../call-deadline.mjs';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(isolatedProfile, 'c20-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A minimal value of a JSON schema (the first of an enum, the minimum, one item of a list).
function minimal(schema) {
  if (!schema) return 'x';
  if (schema.enum) return schema.enum[0];
  if (schema.pattern && schema.pattern.includes('{64}')) return 'a'.repeat(64);
  if (schema.anyOf) return minimal(schema.anyOf[0]);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'integer' || type === 'number') return schema.minimum ?? 1;
  if (type === 'boolean') return true;
  if (type === 'array') return [minimal(schema.items)];
  if (type === 'object') return {};
  if (schema.description && /YYYY-MM-DD/.test(schema.description)) return '2026-10-27';
  return 'x';
}

const fakeStore = () => {
  const calls = [];
  const answer = name => args => { calls.push({ name, args }); return { ok: true, name, args }; };
  return { calls, report: answer('report'), issues: answer('issues'), reports: answer('reports'), task: answer('task'), timeline: answer('timeline'), deliveryKpi: answer('deliveryKpi') };
};
const REPORT = { kind: 'gap', tool: 'ssam_code', intent: 'i', attempted: 'a' };
const baseOf = view => (view === 'report' ? REPORT : view === 'task' ? { taskId: 't1' } : {});

test('C-20: ssam_friction takes every field its schema publishes, in a view where it means something', () => {
  const views = frictionTool.inputSchema.properties.view.enum;
  for (const [field, schema] of Object.entries(frictionTool.inputSchema.properties)) {
    if (field === 'view') continue;
    const accepted = views.filter(view => {
      try { readQueue(fakeStore(), { view, ...baseOf(view), [field]: minimal(schema) }); return true; } catch { return false; }
    });
    assert.ok(accepted.length > 0, `${field}: no view of ssam_friction takes it, though the schema lists it`);
  }
  // The cases of the reports (EW, F-FigmaReactive-12c, F-FT-20, F-FitBody-53b): a report with its lane.
  const store = fakeStore();
  readQueue(store, { view: 'report', ...REPORT, lane: 'o11' });
  assert.equal(store.calls[0].args.lane, 'o11');
  assert.throws(() => readQueue(fakeStore(), { view: 'report', ...REPORT, lane: 'both' }), /lane is o11 or odc/);
  // On this line since, until and lane are the range of view delivery-kpi (review F5 of fase4-28 R1, hosted-friction-telemetry):
  // a field a view does not take is refused naming the view that takes it.
  assert.throws(() => readQueue(fakeStore(), { view: 'report', ...REPORT, since: '2026-10-20' }), /since and until belong to view delivery-kpi/);
  assert.throws(() => readQueue(fakeStore(), { view: 'issues', since: '2026-10-20' }), /since is not a field of view issues/);
});

test('C-20: the friction store keeps the lane of a report', t => {
  const store = createStore({ directory: path.join(tmp(t), 'friction'), rebuild: false, warning: () => {} });
  assert.equal(store.report({ ...REPORT, lane: 'o11' }).ok, true);
  assert.equal(store.report({ ...REPORT }).ok, true);
  assert.deepEqual(store.reports({}).reports.map(r => r.lane ?? null).sort(), ['o11', null].sort());
  assert.equal(store.reports({}).total, 2);
});

async function liveSchema(name) {
  const server = await createSsamServer({ profile: 'all' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'contrato-schema', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try { return (await client.listTools()).tools.find(t => t.name === name)?.inputSchema; } finally { await client.close(); await server.close(); }
}

// The answer of ssam_map is a refusal of its arguments when the code is INPUT_INVALID (the target that is not there is
// MODULE_NOT_FOUND, CAPTURE_NOT_FOUND or another, after the arguments were taken).
const argumentRefusal = answer => answer?.ok === false && answer.code === 'INPUT_INVALID' ? answer.error : null;

test('C-20: ssam_map takes every field its schema publishes in a view, and a list where the schema says list', async t => {
  const schema = await liveSchema('ssam_map');
  assert.ok(schema?.properties, 'ssam_map is listed with its schema');
  const target = path.join(tmp(t), 'none.oml');
  const views = schema.properties.view.enum;
  const needs = { search: { text: 'x' }, uses: { element: 'X' } };
  for (const [field, fieldSchema] of Object.entries(schema.properties)) {
    if (['view', 'target', 'lane'].includes(field)) continue;
    const taken = [];
    for (const view of views) {
      const answer = await moduleMap({ lane: 'o11', target, view, ...(needs[view] ?? {}), [field]: field === 'element' && view === 'flow' ? 'A' : minimal(fieldSchema) }).catch(error => ({ ok: false, code: 'INPUT_INVALID', error: String(error.message) }));
      if (!argumentRefusal(answer)) taken.push(view);
    }
    assert.ok(taken.length > 0, `${field}: no view of ssam_map takes it, though the schema lists it`);
  }
  // element is a list in the schema: views flow and ddl take it (F-FitBody-48a).
  for (const view of ['flow', 'ddl']) {
    const answer = await moduleMap({ lane: 'o11', target, view, element: ['FBContent', 'FBExercise'] });
    assert.equal(argumentRefusal(answer), null, `${view} with a list of elements: ${JSON.stringify(answer)}`);
  }
  // screen is one screen: a list written in one string says so (F-FitBody-53a: ELEMENT_NOT_FOUND before).
  const listed = await moduleMap({ lane: 'o11', target, view: 'html', screen: 'FB_Home,FB_Favorites' });
  assert.match(argumentRefusal(listed) ?? '', /screen is ONE screen or block.*read each one in its own ssam_map call/);
});

test('C-20 (F-FitBody-48b): a continuation that repeats the original call\'s fields with the same values is the same continuation', async t => {
  const dir = tmp(t);
  const deadline = createCallDeadline({ root: dir, timeoutMs: 30, writeTimeoutMs: 30 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const handler = deadline.wrap('o11_data', async () => { await gate; return { content: [{ type: 'text', text: '{"ok":true,"rows":1}' }], structuredContent: { ok: true, rows: 1 } }; }, { annotations: { readOnlyHint: false } });
  const required = { lane: 'o11', host: 'personal.outsystemscloud.com', module: 'FigmaMobile', oml: 'C:/t/x.oml', request: { action: 'read', entity: 'FBContent' } };
  const original = { ...required, operationId: 'op-1' };
  const first = await handler(original);
  const firstValue = first.structuredContent ?? JSON.parse(first.content[0].text);
  const id = firstValue.continuation?.arguments?.continueTask;
  assert.ok(id, JSON.stringify(first));
  release();
  // The fields the schema marks required, repeated as in the original call (not the whole call): taken, the extras ignored.
  const again = await handler({ continueTask: id, ...required });
  const value = again.structuredContent ?? JSON.parse(again.content[0].text);
  assert.notEqual(value.code, 'INPUT_INVALID', JSON.stringify(value));
  // A field with another value is still refused, and said as different from the original call.
  const changed = await handler({ continueTask: id, ...required, module: 'Other' });
  const refused = changed.structuredContent ?? JSON.parse(changed.content[0].text);
  assert.equal(refused.code, 'INPUT_INVALID');
  assert.equal(refused.violations.find(v => v.path === '/module').message, 'Differs from the original call of this task');
});
