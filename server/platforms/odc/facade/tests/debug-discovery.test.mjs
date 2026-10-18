import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { composeCatalog, applySupersedes } from '../catalog.mjs';
import { projectShared, query } from '../discovery.mjs';

const read = name => JSON.parse(fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
const catalog = composeCatalog({ shared: read('discovery-capabilities-shared.json') });
assert.deepEqual(catalog.problems, []);

for (const lane of ['o11', 'odc']) {
  const source = read(lane === 'o11' ? 'discovery-capabilities-o11.json' : 'discovery-capabilities.json');
  const { descriptor } = applySupersedes(source, catalog.supersedes, lane);
  const caps = [...descriptor.capabilities, ...projectShared(catalog.shared, lane)];
  // Production vocabulary/selection with proof expansion omitted: no Studio or network is needed to test routing.
  const index = { lane, capabilities: [...new Map(caps.map(c => [c.id, { ...c, shared: false, contract: [], proofs: {}, negative: {} }])).values()],
    synonyms: Object.fromEntries([...new Set([...Object.keys(descriptor.synonyms), ...Object.keys(catalog.shared.synonyms)])]
      .map(k => [k, [...new Set([...(descriptor.synonyms[k] ?? []), ...(catalog.shared.synonyms[k] ?? [])])]])),
    contracts: {}, jobs: [], negatives: [], routes: {}, unavailable: [] };
  test(`${lane}: Portuguese debugging requests expose the native runner and retain its limitations`, () => {
    for (const intent of ['depurar uma action com inputs e trace sem publicar', 'depure a server action com os parâmetros informados',
      'debugar client action', 'depuração de uma data action', 'debug headless client action e data action', 'debugger com breakpoint']) {
      const answer = query(index, { intent, limit: 3 });
      const direct = answer.matches.filter(m => m.via === 'match');
      assert.equal(direct[0]?.id, 'ops.debugger', intent + ': ' + direct.map(m => m.id));
      assert.match(direct[0].route.operation, /ssam_debug_run/);
      assert.match(direct[0].guidance, /Direct REST\/SOAP, timers\/processes/);
    }
  });
  test(`${lane}: ordinary action creation does not select the debugger`, () => {
    for (const intent of ['criar uma server action', 'adicionar uma client action com inputs e outputs', 'consumir uma API REST']) {
      const answer = query(index, { intent, limit: 3 });
      assert.ok(!answer.matches.some(m => m.id === 'ops.debugger' && m.via === 'match'), intent);
    }
  });
}
