// fix/system-reference: studio_reference_snapshot takes the producer under the name the Studio lists it by ("System" ->
// "(System)", with a note), refuses an unknown name once with every producer the session offers, and keeps its capture as
// the workspace's observation of the producer, so the offline check of the next job finds it by itself (incident of 15/10:
// the capture written to platforms/odc/snapshots was found by nothing). Fake bridge, temporary folders.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { referenceSnapshot } from '../kernel-delivery.mjs';
import { codeCheck } from '../code-check.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
function bridge(offered = ['(System)', 'OutSystemsUI']) {
  const calls = [];
  const studio = async ([step, argument]) => {
    calls.push(step === 'reference-snapshot' ? JSON.parse(argument).producer : step);
    if (step === 'reference-producers') return { ok: true, producers: offered.map(name => ({ name, key: 'k-' + name })) };
    const request = JSON.parse(argument);
    const name = offered.find(n => n === request.producer);
    if (!name) return { ok: false, error: 'Producer is not available to the consumer session: ' + request.producer };
    const bytes = JSON.stringify({ FormatVersion: 2, Environment: 'fixture.test', ModuleKey: 'uXCIR2Atc0+es3zYuZSnNw', Name: name, SignatureHash: 'aaaaaaaa-0000-1111-2222-333333333333', Revision: '7' });
    fs.mkdirSync(path.dirname(request.output), { recursive: true });
    fs.writeFileSync(request.output, bytes, { flag: 'wx' });
    return { ok: true, path: request.output, sha256: sha(bytes).toUpperCase(), environment: 'fixture.test', producer: name, producerKey: 'uXCIR2Atc0+es3zYuZSnNw', revision: '7', consumerUnchanged: true };
  };
  return { studio, calls };
}

test('studio_reference_snapshot: "System" is captured as (System), noted, and the next offline check binds it by itself', async t => {
  const odcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-ref-snapshot-'));
  t.after(() => fs.rmSync(odcRoot, { recursive: true, force: true }));
  const b = bridge();
  // An output outside the capture folder: only the cache record lets the check find it.
  const output = path.join(odcRoot, 'elsewhere', 'System-producer.avsig');
  const value = await referenceSnapshot({ module: 'FloodQuotes', producer: 'System', output }, { studio: b.studio, cache: path.join(odcRoot, '.local', 'producer-cache') });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(b.calls, ['(System)']);
  assert.equal(value.requested, 'System');
  assert.match(value.note, /lists this producer as "\(System\)"/);
  const base = path.join(odcRoot, 'base.oml'); fs.writeFileSync(base, 'OML');
  const bound = [];
  const checked = await codeCheck({ lane: 'odc', module: 'FloodQuotes', base, ops: [{ op: 'reference', producer: 'System', elements: ['ClientAction:ListAppendAll'] }] },
    { root: odcRoot, local: path.join(odcRoot, 'local'), odcRoot, runJob: async request => { bound.push(request.producers); return { ok: true, job: request.job }; } });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.deepEqual(Object.keys(bound[0]), ['System']);
  assert.equal(fs.readFileSync(bound[0].System, 'utf8'), fs.readFileSync(output, 'utf8'));
});

test('studio_reference_snapshot: an unknown producer is ONE refusal with every producer the session offers', async t => {
  const odcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-ref-snapshot-'));
  t.after(() => fs.rmSync(odcRoot, { recursive: true, force: true }));
  const b = bridge();
  const value = await referenceSnapshot({ module: 'FloodQuotes', producer: 'Sistema', output: path.join(odcRoot, 'x.avsig') }, { studio: b.studio });
  assert.equal(value.ok, false);
  assert.equal(value.code, 'PRODUCER_UNKNOWN');
  assert.deepEqual(value.available, ['(System)', 'OutSystemsUI']);
  assert.match(value.error, /offers no producer named "Sistema"/);
  assert.equal(value.continuation.tool, 'studio_reference_snapshot');
  assert.deepEqual(b.calls, ['Sistema', 'reference-producers']);
  const listed = bridge(['(Tools)']);
  const taken = await referenceSnapshot({ module: 'FloodQuotes', producer: 'Tools', output: path.join(odcRoot, 't.avsig') }, { studio: listed.studio });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  assert.deepEqual(listed.calls, ['Tools', 'reference-producers', '(Tools)']);
  assert.match(taken.note, /lists "\(Tools\)"/);
});
