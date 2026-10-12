// Lane E of the 2026-10-05 package (C07): ssam_reference serves the proven examples by id (kind example): the jobs of
// the lane suite and the html sources of tests/html, on both lanes, from the files themselves (no CLI); and ODC answers
// recipe from its suite instead of KIND_NOT_IN_LANE (62a884e8, 2026-10-04 22:09). The examples are the real suite files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSsamReference, REFERENCE_KINDS, resolveExample } from '../ssam-reference.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { linked } from './fixtures/o11env-kernel.mjs';

const kernel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'kernel');
async function harness(t) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laneE-reference-'));
  const run = fakeAnvil({});
  const mcp = await linked(registerSsamReference, { root: kernel, lane: 'ss4', env: { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' }, runAnvil: run, outDir });
  t.after(async () => { await mcp.close(); fs.rmSync(outDir, { recursive: true, force: true }); });
  return { run, ask: (lane, kind, query) => mcp.call('ssam_reference', { lane, kind, query }) };
}

test('example is a kind of the tool, answered from the suite files', () => {
  assert.ok(REFERENCE_KINDS.includes('example'));
  assert.equal(resolveExample(kernel, 'odc', 'timer-action')?.id, 'jobs-odc/timer-action');
  assert.equal(resolveExample(kernel, 'o11', 'jobs/tickets-06-sla')?.id, 'jobs/tickets-06-sla');
  assert.equal(resolveExample(kernel, 'o11', 'html/visual/block-event')?.id, 'html/visual/block-event.html');
  for (const bad of ['../MANIFESTO.md', 'html/../../AGENTS.md', 'C:/Windows/win.ini', '']) assert.equal(resolveExample(kernel, 'o11', bad), null, bad);
});

test('an html example of tests/html comes back whole by id, on both lanes, without the CLI', async t => {
  const h = await harness(t);
  const text = fs.readFileSync(path.join(kernel, 'tests', 'html', 'visual', 'block-event.html'), 'utf8').replace(/^\uFEFF/, '');
  for (const lane of ['o11', 'odc']) for (const id of ['html/visual/block-event.html', 'html/visual/block-event']) {
    const value = await h.ask(lane, 'example', id);
    assert.equal(value.ok, true, JSON.stringify(value));
    assert.equal(value.id, 'html/visual/block-event.html'); assert.equal(value.path, 'tests/html/visual/block-event.html');
    assert.equal(value.data.content, text);
  }
  const dashboard = await h.ask('o11', 'example', { id: 'html/incidents-dashboard.html' });
  assert.ok(dashboard.siblings.includes('html/incidents-dashboard.bindings.json'), JSON.stringify(dashboard.siblings));
  assert.equal(h.run.calls.length, 0, 'no CLI');
});

test('a job example comes back whole by id from the lane suite; find lists the ids', async t => {
  const h = await harness(t);
  const odc = await h.ask('odc', 'example', 'timer-action');
  assert.equal(odc.ok, true); assert.equal(odc.path, 'tests/jobs-odc/timer-action.json');
  assert.deepEqual(odc.data, JSON.parse(fs.readFileSync(path.join(kernel, 'tests', 'jobs-odc', 'timer-action.json'), 'utf8').replace(/^\uFEFF/, '')));
  const o11 = await h.ask('o11', 'example', { id: 'pacote-laneE-timer-schedule' });
  assert.equal(o11.ok, true, JSON.stringify(o11));
  assert.ok(JSON.stringify(o11.data).includes('00:00 01:00 02:00 03:00 04:00 05:00 06:00 07:00 08:00 09:00 10:00 11:00 12:00 13:00 14:00 15:00 16:00 17:00 18:00 19:00 20:00 21:00 22:00 23:00'));
  const listed = await h.ask('odc', 'example', { find: 'timer' });
  assert.ok(listed.matches.some(m => m.id === 'jobs-odc/timer-action'), JSON.stringify(listed.matches));
  assert.equal(listed.continuation.tool, 'ssam_reference');
  const missing = await h.ask('o11', 'example', 'no-such-example');
  assert.equal(missing.code, 'EXAMPLE_NOT_FOUND'); assert.equal(missing.continuation.arguments.kind, 'example');
  assert.equal(h.run.calls.length, 0, 'no CLI');
});

test('ODC answers recipe from its suite (every word of find), never KIND_NOT_IN_LANE', async t => {
  const h = await harness(t);
  const value = await h.ask('odc', 'recipe', { find: 'timer cron' });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.ok(value.data.definitions.some(d => d.name === 'timer-action' && d.path === 'tests/jobs-odc/timer-action.json'), JSON.stringify(value.data));
  const exact = await h.ask('odc', 'recipe', 'timer-lifecycle');
  assert.deepEqual(exact.data.definitions.map(d => d.name), ['timer-lifecycle']);
  const bounded = await h.ask('odc', 'recipe', { find: 'timer', ops: true, max: 2 });
  assert.ok(bounded.data.definitions.reduce((n, d) => n + d.ops.length, 0) <= 2);
  // ops without max: bounded by the default (A18 of the 2026-10-06 package), never refused; a wrong max still is.
  const defaulted = await h.ask('odc', 'recipe', { find: 'timer', ops: true });
  assert.equal(defaulted.ok, true); assert.equal(defaulted.maxDefaulted, 20);
  assert.ok(defaulted.data.definitions.reduce((n, d) => n + d.ops.length, 0) <= 20);
  assert.equal((await h.ask('odc', 'recipe', { find: 'timer', ops: true, max: 0 })).code, 'BAD_VALUE');
  assert.equal(h.run.calls.length, 0, 'no CLI on ODC');
});
