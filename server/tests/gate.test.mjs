import '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
// Portão de não regressão (scripts/gate): comparação com a lista de falhas conhecidas, leitura de trx e do reporter,
// filtros do kernel pela matriz e a matriz em si (toda célula tem prova existente ou lacuna nomeada).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, parseTrx, parseNodeJsonl, parseSetupSummary, globToRegExp, validateKnown, normalizeId, loadKnown, durationsByClass, diffRuns } from '../scripts/gate/gate-lib.mjs';
import { renderComparison } from '../scripts/gate/compare-runs.mjs';
import { kernelClasses, classFilter, collect } from '../scripts/gate/run-gate.mjs';
import { validateMatrix, renderMatrix } from '../scripts/gate/matrix.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const known = entries => ({ version: 1, entries });
const entry = (suite, match, kind = 'ambiente') => ({ suite, match, kind, reason: 'motivo de teste suficiente', since: '2026-10-24' });
const suite = (tests, extra = {}) => ({ ran: true, complete: true, tests, ...extra });

test('glob: * casa qualquer sequência, o resto é literal, e o id inteiro', () => {
  const re = globToRegExp('Anvil.Tests.JobTests.Job(jobName: "screen-*")');
  assert.ok(re.test('Anvil.Tests.JobTests.Job(jobName: "screen-generate")'));
  assert.ok(!re.test('Anvil.Tests.JobTests.Job(jobName: "spec-data")'));
  assert.ok(!globToRegExp('Anvil.Tests.X').test('Anvil.Tests.XY'));
  assert.ok(globToRegExp('a.b?c').test('a.bXc') && !globToRegExp('a.b').test('aXb'));
});

test('compare: falha fora da lista bloqueia; falha conhecida não; suíte incompleta bloqueia', () => {
  const k = known([entry('o11', '*ScreenCoverageTests*')]);
  const ok = compare({ o11: suite([{ id: 'Anvil.Tests.ScreenCoverageTests.A', status: 'fail' }, { id: 'Anvil.Tests.B.C', status: 'pass' }]) }, k);
  assert.equal(ok.pass, true);
  assert.equal(ok.knownFailures.length, 1);
  const bad = compare({ o11: suite([{ id: 'Anvil.Tests.B.C', status: 'fail' }]) }, k);
  assert.equal(bad.pass, false);
  assert.deepEqual(bad.unknown.map(u => u.id), ['Anvil.Tests.B.C']);
  const cut = compare({ o11: suite([], { complete: false, error: 'abortou' }) }, k);
  assert.equal(cut.pass, false);
  assert.equal(cut.incomplete[0].error, 'abortou');
});

test('compare: a entrada só vale para a sua suíte', () => {
  const r = compare({ odc: suite([{ id: 'Anvil.Tests.Odc.ScreenCoverageTests.A', status: 'fail' }]) }, known([entry('o11', '*ScreenCoverageTests*')]));
  assert.equal(r.pass, false);
});

test('compare: corrigida (só passes), ainda falhando, sem teste executado e suíte não rodada', () => {
  const k = known([entry('o11', '*Fixed*'), entry('o11', '*Still*'), entry('o11', '*Absent*'), entry('odc', '*Other*')]);
  const r = compare({ o11: suite([{ id: 'X.Fixed.a', status: 'pass' }, { id: 'X.Still.a', status: 'fail' }, { id: 'X.Absent.a', status: 'skip' }]), odc: { ran: false, tests: [] } }, k);
  assert.deepEqual(r.fixed.map(e => e.match), ['*Fixed*']);
  assert.deepEqual(r.notRun.map(e => e.match), ['*Absent*']);
  assert.equal(r.entries.find(e => e.match === '*Still*').status, 'matched');
  assert.equal(r.entries.some(e => e.suite === 'odc'), false, 'entrada de suíte que não rodou não é avaliada');
});

test('compare: instável (passou a sós) não é falha nem casa entrada', () => {
  const r = compare({ facade: suite([{ id: 'f :: t', status: 'flaky' }]) }, known([]));
  assert.equal(r.pass, true);
});

test('compare: regressão conhecida aberta passa por padrão e bloqueia com strict', () => {
  const k = known([entry('build', 'Build: builder ODC', 'regressao')]);
  const s = { build: suite([{ id: 'Build: builder ODC', status: 'fail' }]) };
  assert.equal(compare(s, k).pass, true);
  assert.equal(compare(s, k).openRegressions.length, 1);
  assert.equal(compare(s, k, { strict: true }).pass, false);
});

test('compare nunca altera a lista de falhas conhecidas', () => {
  const k = known([entry('o11', '*A*')]);
  const before = JSON.stringify(k);
  compare({ o11: suite([{ id: 'B', status: 'fail' }, { id: 'A', status: 'fail' }]) }, k);
  assert.equal(JSON.stringify(k), before);
});

test('validateKnown exige suíte, glob, tipo, motivo e data; a lista versionada é válida', () => {
  assert.deepEqual(validateKnown(known([entry('o11', 'x')])), []);
  const p = validateKnown(known([{ suite: 'x', match: '', kind: 'talvez', reason: 'curto', since: 'ontem' }, entry('o11', 'x'), entry('o11', 'x')]));
  assert.equal(p.length, 6);
  assert.doesNotThrow(() => loadKnown(path.join(root, 'scripts/gate/known-failures.json')));
});

test('parseTrx: resultado, duração, mensagem e contadores', () => {
  const trx = `<TestRun><Results>
    <UnitTestResult testId="1" testName="Anvil.Tests.A.B(x: &quot;C:\\Users\\u\\AppData\\Local\\Temp\\sg\\abc\\f.oml&quot;)" duration="00:01:02.5000000" outcome="Failed"><Output><ErrorInfo><Message>esperado &lt;1&gt;</Message></ErrorInfo></Output></UnitTestResult>
    <UnitTestResult testId="2" testName="Anvil.Tests.A.C" duration="00:00:00.2500000" outcome="Passed" />
    <UnitTestResult testId="3" testName="Anvil.Tests.D.E" duration="00:00:00" outcome="NotExecuted" />
  </Results><ResultSummary outcome="Failed"><Counters total="3" executed="2" passed="1" failed="1" error="0" timeout="0" aborted="0" notExecuted="1" /></ResultSummary></TestRun>`;
  const r = parseTrx(trx);
  assert.deepEqual(r.tests.map(t => t.status), ['fail', 'pass', 'skip']);
  assert.equal(r.tests[0].seconds, 62.5);
  assert.equal(r.tests[0].message, 'esperado <1>');
  assert.ok(r.tests[0].id.includes('<tmp>'), r.tests[0].id);
  assert.equal(r.summary.failed, 1);
  assert.deepEqual(durationsByClass(r.tests).map(c => c.class), ['Anvil.Tests.A', 'Anvil.Tests.D']);
});

test('parseNodeJsonl e parseSetupSummary', () => {
  const jsonl = '{"event":"test","file":"a/b.test.mjs","path":["s","t"],"status":"fail","ms":1500,"message":"m"}\nlixo\n';
  assert.deepEqual(parseNodeJsonl(jsonl).tests[0], { id: 'a/b.test.mjs :: s > t', file: 'a/b.test.mjs', status: 'fail', seconds: 1.5, message: 'm' });
  const setup = 'Build: CLI O11 (ss4)                  ok        17.6s C:\\x\nBuild: builder ODC                    falha     3.3s  veja y\nTenant/host e MCP                     pulado          -SkipMcp';
  assert.deepEqual(parseSetupSummary(setup).tests.map(t => [t.id, t.status]), [['Build: CLI O11 (ss4)', 'pass'], ['Build: builder ODC', 'fail']]);
});

test('normalizeId: barras e espaços', () => {
  assert.equal(normalizeId('a\\b  c'), 'a/b c');
});

test('collect: falha que passou na repetição a sós vira instável', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || root, 'gate-'));
  try {
    fs.writeFileSync(path.join(dir, 'facade.jsonl'), ['{"event":"test","file":"f.test.mjs","path":["a"],"status":"fail","ms":1}', '{"event":"test","file":"f.test.mjs","path":["b"],"status":"fail","ms":1}'].join('\n'));
    fs.writeFileSync(path.join(dir, 'facade-rerun.jsonl'), ['{"event":"test","file":"f.test.mjs","path":["a"],"status":"pass","ms":1}', '{"event":"test","file":"f.test.mjs","path":["b"],"status":"fail","ms":1}'].join('\n'));
    const s = collect(dir, { facade: { complete: true }, build: { skipped: 'não selecionada' } });
    assert.deepEqual(s.facade.tests.map(t => t.status), ['flaky', 'fail']);
    assert.equal(s.build.ran, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const matrix = JSON.parse(fs.readFileSync(path.join(root, 'scripts/gate/matrix.json'), 'utf8'));

test('filtros do kernel: full = suíte inteira; quick = listas críticas; --feature = classes citadas', () => {
  assert.equal(kernelClasses(matrix, 'o11', { level: 'full' }), null);
  const quick = kernelClasses(matrix, 'o11', { level: 'quick' });
  assert.ok(quick.length > 0, 'o nível quick tem classes O11');
  assert.ok(kernelClasses(matrix, 'odc', { level: 'quick' }).length > 0, 'o nível quick tem classes ODC');
  assert.equal(classFilter(['JobTests', 'XifSpecTests']), 'FullyQualifiedName~.JobTests.|FullyQualifiedName~.XifSpecTests.');
  const one = matrix.features[0];
  const byFeature = kernelClasses(matrix, 'o11', { level: 'full', features: [one.id] });
  for (const c of one.cells.filter(c => c.platform === 'o11').flatMap(c => c.kernel || [])) assert.ok(byFeature.includes(c), c);
});

test('matriz: toda funcionalidade × plataforma × operação tem prova existente, lacuna nomeada ou n/a', () => {
  assert.deepEqual(validateMatrix(matrix, root), []);
});

test('matriz: o documento traz a matriz gerada de matrix.json', () => {
  const doc = fs.readFileSync(path.join(root, 'docs/MATRIZ-NAO-REGRESSAO.md'), 'utf8').replace(/\r\n/g, '\n');
  const body = doc.split('<!-- matriz:inicio -->')[1]?.split('<!-- matriz:fim -->')[0];
  assert.ok(body, 'marcadores da matriz no documento');
  assert.equal(body.trim(), renderMatrix(matrix).trim(), 'rode: node scripts/gate/matrix.mjs --write');
});

test('diffRuns: apareceram, sumiram e iguais, com a classificação da lista', () => {
  const a = { o11: suite([{ id: 'X.Old', status: 'fail' }, { id: 'X.Same', status: 'fail' }, { id: 'X.New', status: 'pass' }]), odc: { ran: false, tests: [] } };
  const b = { o11: suite([{ id: 'X.Old', status: 'pass' }, { id: 'X.Same', status: 'fail' }, { id: 'X.New', status: 'fail', message: 'quebrou\nmais' }]), odc: suite([{ id: 'Y.A', status: 'fail' }]) };
  const d = diffRuns(a, b, known([entry('o11', 'X.Same', 'preexistente')]));
  assert.deepEqual(d.appeared.map(f => [f.suite, f.id, f.before, f.kind]), [['o11', 'X.New', 'pass', null], ['odc', 'Y.A', 'suíte não rodou', null]]);
  assert.deepEqual(d.disappeared.map(f => [f.id, f.after]), [['X.Old', 'pass']]);
  assert.deepEqual(d.same.map(f => [f.id, f.kind]), [['X.Same', 'preexistente']]);
  assert.match(renderComparison({ head: 'a' }, { head: 'b' }, a, b, d), /Apareceram em B \(2\)[\s\S]*X\.New \(em A: pass\) — quebrou/);
});
