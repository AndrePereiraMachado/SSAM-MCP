// fix/unpublished-library (family OF), the O11 lane: the kernel's PRODUCER_SIGNATURE_MISSING (ProducerSignatureMissing,
// cause absent or unpublished) for elements the producer's module open in Service Studio has public answers as the ODC lane
// does: ONE refusal PRODUCER_NOT_PUBLISHED with o11_publish of the producer (the person's own words, never automatic), then
// the same o11_deliver, the job unchanged. The kernel's text already said "publish it first"; now the refusal has the same
// shape and continuation on both lanes. The open model is read before the answer is shaped (o11ProducerModels, a fake
// module digest here); a closed module (its published OML) is no evidence, and any other cause keeps the kernel's refusal.
// Synthetic values only; no Studio, no kernel process.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// A namespace import: on a facade without o11ProducerModels the file still loads, and each test fails on its own assertion.
import * as cycle from '../o11-cycle.mjs';
const { deliverOutcome } = cycle;
const o11ProducerModels = (...args) => cycle.o11ProducerModels(...args);

const TASK = '7a8b9c0d1e2f30415263748596a7b8c9';
const MARKER = "<the user's own words>";
const problem = (element, cause = 'absent', producer = 'FloodServices_CS') => ({ code: 'PRODUCER_SIGNATURE_MISSING', severity: 'error', op: null, pointer: null, cause, element, producer,
  message: element + ' is not a visible element of the ' + producer + ' signature',
  fix: 'if ' + element.split(':')[1] + ' was added or made Public in ' + producer + ' after its last publication, publish ' + producer + ' first (o11_dependencies list shows what it publishes)' });
const run = problems => ({ envelope: { ok: false, command: 'deliver', data: { taskId: TASK, delivered: false, writeState: 'not-sent', stage: 'producer-signatures', code: 'PRODUCER_SIGNATURE_MISSING',
  error: 'PRODUCER_SIGNATURE_MISSING: ' + problems.length + ' element(s) of FloodServices_CS are not in its published signature, all listed: ' + problems.map(p => p.element).join(' | '), problems } } });
function setup(t, refs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upl-o11-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = path.join(root, 'job.json');
  fs.writeFileSync(job, JSON.stringify({ ops: refs.map(([producer, elements]) => ({ op: 'reference', producer, elements })) }));
  return { root, job };
}
// The module digest of a producer: open in a Service Studio tab (capturedBy open-tab) or closed (its published OML).
const digest = (actions, capturedBy = 'open-tab') => async name => ({ ok: true, lane: 'o11', target: name, file: 'C:\\synthetic\\' + name + '.oml', sourceSha256: 'synthetic', capturedBy,
  digest: { module: { name }, sections: [], actions: actions.map(([n, pub]) => ({ key: 'k' + n, kind: 'ServerAction', name: n, section: 'actions', public: pub })) } });

test('OF (O11): an element only the open module has, public: ONE PRODUCER_NOT_PUBLISHED, o11_publish then the same o11_deliver', async t => {
  const { root, job } = setup(t, [['FloodServices_CS', ['IServerAction:GetPolicy', 'IServerAction:GetQuotes']]]);
  const kernel = run([problem('IServerAction:GetQuotes')]);
  // The open models as deliverOutcome receives them (o11ProducerModels reads them; its own tests are below).
  const producerModels = { FloodServices_CS: { ok: true, source: 'open-model', file: 'C:\\synthetic\\FloodServices_CS.oml', sha256: 'synthetic', capturedAt: null,
    surface: [{ kind: 'ServerAction', name: 'GetPolicy', key: 'kGetPolicy', public: true }, { kind: 'ServerAction', name: 'GetQuotes', key: 'kGetQuotes', public: true }] } };
  const input = { module: 'QuoteApp_UI', job, producers: 'published' };
  const answer = deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input, producerModels });
  assert.equal(answer.code, 'PRODUCER_NOT_PUBLISHED', JSON.stringify(answer));
  assert.equal(answer.problems.length, 1);
  assert.equal(answer.problems[0].pointer, '/ops/0/elements/1');
  assert.equal(answer.continuation.tool, 'o11_publish');
  assert.deepEqual(answer.continuation.arguments, { module: 'FloodServices_CS', authorize: MARKER });
  assert.equal(answer.continuation.then.tool, 'o11_deliver');
  assert.deepEqual(answer.continuation.then.arguments, { module: 'QuoteApp_UI', job, producers: 'published', closePrevious: TASK, authorize: MARKER });
  assert.deepEqual(answer.sequence, ['o11_publish FloodServices_CS', 'o11_deliver QuoteApp_UI']);
  assert.ok(!/remove it|palavras/i.test(JSON.stringify(answer)), 'English only, never "remove it"');
});

test('OF (O11): the open model read from the Service Studio tab (o11ProducerModels) gives the same refusal', async t => {
  const { root, job } = setup(t, [['FloodServices_CS', ['IServerAction:GetQuotes']]]);
  const kernel = run([problem('IServerAction:GetQuotes', 'unpublished')]);
  const producerModels = await o11ProducerModels(kernel, { digestOf: digest([['GetQuotes', true]]) });
  assert.equal(producerModels.FloodServices_CS.source, 'open-model');
  const answer = deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input: { module: 'QuoteApp_UI', job }, producerModels });
  assert.equal(answer.code, 'PRODUCER_NOT_PUBLISHED');
  assert.equal(answer.continuation.then.tool, 'o11_deliver');
});

test('OF (O11) + review (a): the module already references the producer: publish, the Studio\'s refresh of that reference, then the same delivery', async t => {
  const { root, job } = setup(t, [['FloodServices_CS', ['IServerAction:GetQuotes']]]);
  const kernel = run([problem('IServerAction:GetQuotes')]);
  const producer = digest([['GetQuotes', true]]);
  const digestOf = async name => name === 'QuoteApp_UI'
    ? { ok: true, capturedBy: 'open-tab', digest: { module: { name }, actions: [], sections: [{ id: 'module', blocks: [{ key: 'r1', kind: 'Reference', name: 'FloodServices_CS', text: 'reference FloodServices_CS @r1' }] }] } }
    : producer(name);
  const producerModels = await o11ProducerModels(kernel, { digestOf, consumer: 'QuoteApp_UI' });
  assert.equal(producerModels.FloodServices_CS.referenced, true);
  const answer = deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input: { module: 'QuoteApp_UI', job }, producerModels });
  assert.equal(answer.code, 'PRODUCER_NOT_PUBLISHED');
  assert.deepEqual(answer.sequence, ['o11_publish FloodServices_CS', 'o11_studio refresh-references QuoteApp_UI (FloodServices_CS)', 'o11_deliver QuoteApp_UI']);
  assert.deepEqual(answer.continuation.then.arguments, { command: 'refresh-references', args: { module: 'QuoteApp_UI', producers: ['FloodServices_CS'], published: true } });
  assert.match(answer.continuation.then.why, /person confirms/);
  assert.equal(answer.continuation.then.then.tool, 'o11_deliver');
});

test('OF (O11, control): the producer is closed (its published OML was read): no evidence, the kernel\'s refusal stays', async t => {
  const { root, job } = setup(t, [['FloodServices_CS', ['IServerAction:GetQuotes']]]);
  const kernel = run([problem('IServerAction:GetQuotes')]);
  const producerModels = await o11ProducerModels(kernel, { digestOf: digest([['GetQuotes', true]], 'published-oml') });
  const answer = deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input: { module: 'QuoteApp_UI', job }, producerModels });
  assert.equal(answer.code, 'PRODUCER_SIGNATURE_MISSING');
});

test('OF (O11, control): an element the open module has but not Public keeps the kernel\'s refusal', async t => {
  const { root, job } = setup(t, [['FloodServices_CS', ['IServerAction:GetQuotes']]]);
  const kernel = run([problem('IServerAction:GetQuotes')]);
  const producerModels = await o11ProducerModels(kernel, { digestOf: digest([['GetQuotes', false]]) });
  const answer = deliverOutcome(kernel, { trackId: 't', work: root, job, taskId: null, input: { module: 'QuoteApp_UI', job }, producerModels });
  assert.equal(answer.code, 'PRODUCER_SIGNATURE_MISSING');
});

test('OF (O11): a refusal of another cause (private, foreign) reads no open model', async () => {
  let read = 0;
  const models = await o11ProducerModels(run([problem('IServerAction:GetQuotes', 'private')]), { digestOf: async () => { read++; return { ok: false }; } });
  assert.equal(models, null);
  assert.equal(read, 0);
});
