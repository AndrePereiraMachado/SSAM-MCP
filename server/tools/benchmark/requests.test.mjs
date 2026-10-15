import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { actionNames, generatedActions, renderRequest, spec, cases } from './requests.mjs';

test('famílias têm 20 e 100 nomes distintos, sem sobreposição', () => {
  assert.equal(spec.entities.length, 10);
  assert.equal(spec.crudTemplates.length, 10);
  assert.equal(actionNames('C3').length, 20);
  assert.equal(actionNames('C4').length, 100);
  const all = ['S2', 'C1', 'C3', 'C4'].flatMap(actionNames);
  assert.equal(new Set(all).size, 122);
  for (const name of all) assert.match(name, /^[A-Z][A-Za-z]+_[A-Z][A-Za-z]+$/);
  assert.ok(generatedActions().every(action => !/\{\w+\}/.test(JSON.stringify(action))));
});

test('todos os textos começam com a tag e correspondem aos arquivos versionados', t => {
  let count = 0;
  for (const lane of ['o11', 'odc']) for (const caseName of cases) {
    const setup = ['S1', 'S2'].includes(caseName);
    for (const subagents of setup ? ['no'] : ['yes', 'no']) {
      const text = renderRequest({ lane, case: caseName, subagents, round: '01' });
      assert.ok(text.startsWith(`[BenchSSAM round=01 case=${caseName} lane=${lane} subagents=${subagents}]\n`));
      assert.doesNotMatch(text, /Ticket|VisitaCerta|Vet|DemoFabio|FolhaPonto/i);
      assert.match(text, /Critério de pronto: entregue no módulo BenchSSAM_01(?:_CS)?, \d+ actions novas/);
      assert.ok(text.includes(subagents === 'yes' ? 'Use subagentes em paralelo para acelerar.' : 'Faça sem subagentes.'));
      const filename = `${lane}-${caseName}${setup ? '' : `-${subagents}`}.md`;
      assert.equal(fs.readFileSync(new URL(`./requests/${filename}`, import.meta.url), 'utf8'), text);
      t.diagnostic(`${filename}: ${Buffer.byteLength(text)} bytes UTF-8`);
      count++;
    }
  }
  assert.equal(count, 20, 'S1/S2 sem variantes resultam em 20, não 24');
});

test('defaults, contratos e preparação não medida são explícitos', () => {
  for (const name of ['S1', 'S2']) assert.equal(spec.cases[name].measured, false);
  assert.equal(spec.cases.C1.outputs, 'LoanId Loan Identifier');
  assert.match(renderRequest({ lane: 'odc', case: 'C2' }), /somente a alteração de uma linha/);
  assert.match(renderRequest({ lane: 'odc', case: 'S2', subagents: 'yes' }), /subagents=no\]/);
  for (const entity of spec.entities) {
    assert.ok([...spec.commonFields, ...entity.fields].some(field => field.name === entity.lookupField));
  }
});

test('entradas inválidas são rejeitadas', () => {
  for (const round of ['00', '100', '1', 'xx']) assert.throws(() => renderRequest({ lane: 'o11', case: 'C1', round }));
  assert.throws(() => renderRequest({ lane: 'x', case: 'C1' }));
  assert.throws(() => renderRequest({ lane: 'o11', case: 'C5' }));
  assert.throws(() => renderRequest({ lane: 'o11', case: 'C1', subagents: 'maybe' }));
});
