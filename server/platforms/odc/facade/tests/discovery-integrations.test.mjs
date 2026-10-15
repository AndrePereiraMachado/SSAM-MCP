// Discovery of the integration ops (lane restsoap, docs/INTEGRACOES-GITSSAM.md): SOAP is a capability on O11 (op soap)
// and a declared gap on ODC; the OpenAPI import has its own capability; deleting a REST method shows the delete operation
// with the consumer and words preconditions and the proof jobs. Real answers over a private index built with each lane's
// CLI of this checkout (no Studio, no reader, no worker).
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireBytes } from './fixtures/answer-wire.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildIndex, laneSources, discover } from '../discovery.mjs';

const BUDGET = 12000;
const indexes = {};
const direct = a => a.matches.filter(m => m.via === 'match').map(m => m.id);
const unavailable = a => (a.unavailable ?? []).map(u => u.id);

async function ask(lane, intent) {
  if (!indexes[lane]) {
    indexes[lane] = { ...laneSources(lane), cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), `discovery-integrations-${lane}-`)) };
    await buildIndex(lane, { sources: indexes[lane], rebuild: true, persist: true });
  }
  const answer = await discover({ lane, intent, sources: indexes[lane], budgetBytes: BUDGET });
  assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 400));
  assert.ok(wireBytes(answer, { budgetBytes: BUDGET }) <= BUDGET);
  return answer;
}

for (const lane of ['o11', 'odc']) {
  const skip = !fs.existsSync(laneSources(lane).cli) && `the ${lane} CLI is not built in this checkout`;

  test(`integrations (${lane}): importing a WSDL is the op soap on O11 and a declared gap on ODC`, { skip }, async () => {
    const a = await ask(lane, 'importar wsdl soap');
    if (lane === 'o11') {
      assert.ok(direct(a).includes('integration.soap'), JSON.stringify(direct(a)));
      const soap = a.matches.find(m => m.id === 'integration.soap');
      assert.match(soap.route?.operation ?? JSON.stringify(soap), /op soap/);
      assert.ok(!unavailable(a).includes('integration.soap-odc'));
    } else {
      assert.ok(unavailable(a).includes('integration.soap-odc'), JSON.stringify(unavailable(a)));
      assert.ok(!direct(a).includes('integration.soap'), JSON.stringify(direct(a)));
    }
  });

  test(`integrations (${lane}): importing an OpenAPI document selects integration.rest-import`, { skip }, async () => {
    const a = await ask(lane, 'importar openapi swagger');
    assert.ok(direct(a).includes('integration.rest-import'), JSON.stringify(direct(a)));
    const m = a.matches.find(x => x.id === 'integration.rest-import');
    assert.match(m.route?.operation ?? JSON.stringify(m), /openapi/);
  });

  test(`integrations (${lane}): deleting a REST method shows the delete with its consumers and words preconditions`, { skip }, async () => {
    const a = await ask(lane, 'apagar metodo rest');
    assert.ok(direct(a).includes('integration.rest-consume'), JSON.stringify(direct(a)));
    const m = a.matches.find(x => x.id === 'integration.rest-consume');
    // The answer states the delete per role; its route and preconditions are one expansion away (the exact continuation).
    assert.ok(m.operations?.delete, JSON.stringify(m).slice(0, 600));
    const expanded = await discover({ lane, sources: indexes[lane], expand: 'integration.rest-consume:operations', budgetBytes: 60000 });
    const del = expanded.expansions?.['integration.rest-consume']?.operations?.delete;
    assert.ok(del, JSON.stringify(m).slice(0, 600));
    const text = JSON.stringify(del);
    assert.match(text, /DELETE_HAS_CONSUMERS/);
    assert.match(text, /breaks/);
    assert.match(text, /words/);
    const method = del.roles?.['rest method'];
    assert.ok(method, text.slice(0, 400));
    if (lane === 'o11') {
      assert.equal(method.status, 'applicable');
      assert.match(JSON.stringify(method), /rest-spec-edit-delete/);
      assert.match(JSON.stringify(method), /rest-delete-consumers/);
    } else assert.equal(method.status, 'undetermined');
  });

  test(`integrations (${lane}): the contracts of the three ops are in the index`, { skip }, async () => {
    await ask(lane, 'consumir api rest');
    const { index } = await buildIndex(lane, { sources: indexes[lane] });
    for (const op of ['rest', 'rest-consume', 'rest-expose', 'soap']) assert.ok(index.contracts[op] && !index.contracts[op].error, op);
    assert.ok(index.contracts.rest.shapes.client.includes('baseUrl'));
    assert.deepEqual(index.contracts.soap.lanes, ['o11']);
  });
}
