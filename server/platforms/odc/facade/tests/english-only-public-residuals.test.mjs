import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { portugueseIn } from './fixtures/portuguese-text.mjs';
import { prepareIntegrationJob, destructiveProblems } from '../integration-documents.mjs';
import { debugMatrix } from '../debug-final-matrix.mjs';
import { packetMatch } from '../discovery.mjs';
import { exposedValue } from '../exposure.mjs';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const show = (value, tool) => exposedValue(value, { exposure: 'licensee', tool, args: {} });
const english = text => assert.equal(portugueseIn(text), null, text);

test('english-only r2 M1: generated integration deletion example is English', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'english-r2-'));
  try {
    const job = path.join(dir, 'job.json');
    fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'delete', target: 'IRestClient:Orders' }] }));
    const result = show(await prepareIntegrationJob(job, { lane: 'o11', words: 'remove OtherClient', localRoot: dir,
      fetchImpl: () => { throw new Error('Network prohibited'); } }), 'o11_deliver');
    assert.equal(result.code, 'INTEGRATION_DELETE_WORDS');
    english(result.problems[0].fix);
    assert.equal(result.problems[0].fix, 'words that name Orders (whole word), e.g. "delete IRestClient:Orders"');
    const ops = [{ op: 'delete', target: 'IRestClient:Pedidos' }];
    const words = 'apagar Pedidos';
    const accepted = await destructiveProblems(ops, { words });
    assert.deepEqual(accepted.problems, [], 'actual Portuguese user words remain accepted');
    assert.deepEqual(accepted.targets, ['IRestClient:Pedidos']);
    assert.deepEqual(ops, [{ op: 'delete', target: 'IRestClient:Pedidos' }]);
    assert.equal(words, 'apagar Pedidos');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('english-only r2 M2: generated public debugger pointer is English', async () => {
  const result = show(await debugMatrix({}, { root, write: false, studioDirs: { o11: path.join(os.tmpdir(), 'absent-o11'), odc: path.join(os.tmpdir(), 'absent-odc') },
    inventory: () => ({ locks: [], blockedBindings: [] }), seedEvidence: {} }), 'ssam_debug_matrix');
  assert.equal(result.ok, true);
  english(result.pointer);
  assert.match(result.pointer, /Final matrix generated:/);
  assert.match(result.pointer, /Regenerate with/);
  assert.match(result.pointer, /exits with an error on any divergence/);
});

test('english-only r2 M3: all catalog fragments and assembled reference summaries use English placeholders', () => {
  const dir = path.join(root, 'platforms/odc/facade/catalog/fragments');
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'C/references.json'), 'utf8')).capabilities.find(c => c.id === 'reference.producer-import');
  const result = show({ matches: [packetMatch({ lane: 'o11', capabilities: [c], jobs: [] }, c.id)] }, 'ssam_discover');
  english(result.matches[0].summary);
  for (const file of fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.json'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(/\bI?Tipo:|<Tipo>Signature/.test(text), false, file);
  }

  for (const placeholder of ['Type:Name', '<Type>Signature', 'Type:@producerKey/elementKey']) assert.ok(result.matches[0].summary.includes(placeholder));
});

test('english-only r2: inline examples are checked while actual identifiers stay data', () => {
  for (const text of ['`apagar IRestClient:Orders`', '`Tipo:Nome`', '`<Tipo>Signature`', '`Tipo:@producerKey/elementKey`', '`ITipo:Name`']) assert.ok(portugueseIn(text), text);
  for (const text of ['`IRestClient:Pedidos`', '`Pedido_CS.Id`', '`docs/CONHECIMENTO-DO-TIME.md`', '`Type:Name`', '`<Type>Signature`']) english(text);
});