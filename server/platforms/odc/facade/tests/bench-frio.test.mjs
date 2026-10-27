import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BENCH_FIXTURES, CORPORA, PHASES, WORKSPACE, VERDICTS, benchCorpus, cliMissing, corpusFiles, measureText, normalizationsByRule,
  problemsByPhase, splitRules, verdictOf, warmDiscoveryIndex } from '../bench-frio.mjs';

// R8, docs/BENCH-FRIO.md: the lab corpora as ssam_code check calls against the fixture captures, one cold kernel process
// per check (no worker, no hot module, no Studio), measured from outside the check.
//
// Time limits, per corpus, on the wall of the whole check (facade and kernel, one cold kernel process). Measured on
// 24/10/2026 on the developer's machine, one check at a time, two runs: 100 actions 18.6 to 28.3 s, 100 entities 11.0 to
// 14.3 s. The limit is two to three times that: 60 s for 100 actions, 40 s for 100 entities. A machine half as fast
// passes, with some room for `pnpm test`, which runs the test files in parallel processes on the same CPU; a check that
// got three times slower fails. SSAM_BENCH_LIMIT_FACTOR multiplies every limit (default 1) on a slower machine.
const factor = Number(process.env.SSAM_BENCH_LIMIT_FACTOR) > 0 ? Number(process.env.SSAM_BENCH_LIMIT_FACTOR) : 1;
const LIMIT_MS = {
  portuario: 60000, // 100 actions, 205 KB of flow: the largest text
  'naval-2': 60000, // 100 actions over 120 entities
  hx: 60000, // 100 actions, 113 KB
  'museum-model': 40000, // 100 entities, DDL only
};
// The kernel's rewrites a corpus must show, exactly: Hx was refused in the lab by its 133 `assign X=v` (the native parser
// needs `assign X = v`); the tolerant parser of R5 takes them as meant (FLOW_ASSIGN_SPACING).
const RULES = { hx: { FLOW_ASSIGN_SPACING: 133 } };
// Known kernel defects: the corpus still runs and is measured, its failure is reported as TODO and does not fail the
// suite. Removed when the fix is integrated (docs/BENCH-FRIO.md, "O que a rodada mostra").
const TODO = {}; // museum-model: DDL_NATIVE_PLURAL entrou no kernel (R5, 45cbb9f4); nenhum corpus pendente
// What each corpus is expected to give today. Portuário and Naval passed in the lab: accepted, with or without
// normalizations. Hx and Museus are the lab's refused corpora: accepted with normalizations, or refused BEFORE the build
// (input, preflight, base, scope); a refusal of the build itself (apply, verify) fails the test with its problems.
const EXPECTED = {
  portuario: ['clean', 'normalized'],
  'naval-2': ['clean', 'normalized'],
  hx: ['normalized', 'beforeBuild'],
  'museum-model': ['clean', 'normalized', 'beforeBuild'],
};

test('the fixtures are the converted lab corpora their README names', () => {
  const readme = fs.readFileSync(path.join(BENCH_FIXTURES, 'README.md'), 'utf8');
  for (const corpus of CORPORA) {
    assert.match(readme, new RegExp('`' + corpus.id + '`'), corpus.id + ' has its origin in the README');
    const size = measureText(corpusFiles(corpus));
    if (corpus.id === 'museum-model') assert.ok(size.entities >= 100 && size.actions === 0, JSON.stringify(size));
    else assert.equal(size.actions, 100, corpus.id + ': ' + JSON.stringify(size));
    assert.ok(Object.hasOwn(LIMIT_MS, corpus.id) && Object.hasOwn(EXPECTED, corpus.id), corpus.id + ' declares its limit and verdict');
  }
});

test('verdicts, phases and rules are read from the answer of the check as it comes', () => {
  const kernelNotes = { total: 4, byRule: { FLOW_ASSIGN_SPACING: 3, files: 1 }, items: [{ rule: 'files', at: 'files', note: 'read' }] };
  assert.equal(verdictOf({ ok: true, normalizations: [{ rule: 'files', at: 'files', note: 'read' }] }), 'clean', 'how the files were read is not a rewrite of the text');
  assert.equal(verdictOf({ ok: true, normalizations: kernelNotes }), 'normalized');
  assert.deepEqual(splitRules(normalizationsByRule({ normalizations: kernelNotes })), { kernel: { FLOW_ASSIGN_SPACING: 3 }, facade: { files: 1 } });
  const refused = phase => ({ ok: false, verifyRan: false, problems: [{ code: 'X', phase }] });
  for (const phase of ['preflight', 'base', 'scope']) assert.equal(verdictOf(refused(phase)), 'beforeBuild', phase);
  for (const phase of ['apply', 'verify']) assert.equal(verdictOf(refused(phase)), 'afterBuild', phase);
  assert.equal(verdictOf({ ok: false, problems: [{ code: 'INPUT_INVALID', at: 'files/0' }] }), 'beforeBuild');
  assert.deepEqual(problemsByPhase({ problems: [{ code: 'INPUT_INVALID' }, { code: 'A', phase: 'scope' }, { code: 'B', phase: 'scope' }] }),
    { input: 1, preflight: 0, base: 0, scope: 2, apply: 0, verify: 0 });
});

const rows = [];
for (const lane of ['o11', 'odc']) {
  test(`bench a frio, ${lane}: each corpus checks within its limit and with the verdict it has today`, { skip: cliMissing(lane), timeout: 1800000 }, async t => {
    const index = await warmDiscoveryIndex(lane);
    t.diagnostic(JSON.stringify({ discoveryIndex: index }));
    for (const corpus of CORPORA) {
      await t.test(corpus.label, { skip: !corpus.lanes.includes(lane) && (corpus.notOn?.[lane] ?? `not a ${lane} corpus`), todo: TODO[corpus.id] ?? false }, async () => {
        const parent = path.join(WORKSPACE, '.local/bench-frio-tests');
        fs.mkdirSync(parent, { recursive: true });
        const dir = fs.mkdtempSync(path.join(parent, corpus.id + '-'));
        let row;
        try { row = await benchCorpus(corpus, lane, { dir }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
        rows.push(row);
        const { call, ...shown } = row;
        t.diagnostic(JSON.stringify(shown));
        const why = `${corpus.id} on ${lane}: ${VERDICTS[row.verdict]} (${row.refusalCode ?? row.code ?? 'ok'}); ` + JSON.stringify(row.problems.slice(0, 12));
        assert.ok(EXPECTED[corpus.id].includes(row.verdict), why);
        for (const [rule, n] of Object.entries(RULES[corpus.id] ?? {})) assert.equal(row.normalizations[rule], n, `${corpus.id} on ${lane}: ${rule} ` + JSON.stringify(row.normalizations));
        const limit = LIMIT_MS[corpus.id] * factor;
        assert.ok(row.facadeWallMs <= limit, `${corpus.id} on ${lane}: ${row.facadeWallMs} ms > ${limit} ms (kernel ${row.kernelWallMs} ms)`);
      });
    }
  });
}

// The table of docs/BENCH-FRIO.md (pt-BR, the language of the owner's internal reports; the module stays English).
const LABELS = { portuario: 'Portuário, 100 actions', 'naval-2': 'Naval 2º corpus, 100 actions', hx: 'Hx logística, 100 actions', 'museum-model': 'Museus, 100 entidades' };
const VEREDITOS = { clean: 'aceito sem problema', normalized: 'aceito com normalizações', beforeBuild: 'recusado antes do build', afterBuild: 'recusado no build' };
const s = v => v == null ? '—' : (v / 1000).toFixed(1).replace('.', ',') + ' s';
function benchTable(table) {
  const head = '| Corpus | Lane | Bytes | Entidades / actions | Fachada (parede) | Kernel (processo) | Kernel total / scope | Problemas ' + PHASES.join(' / ') + ' | Normalizações do kernel | Veredito |\n|---|---|---:|---|---:|---:|---:|---|---|---|';
  const rules = r => Object.entries(r).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(', ') || '—';
  return [head, ...table.map(r => `| ${LABELS[r.corpus] ?? r.label} | ${r.lane} | ${r.bytes.toLocaleString('pt-BR')} | ${r.entities} / ${r.actions} | ${s(r.facadeWallMs)} | ${s(r.kernelWallMs)} | ${s(r.timings?.totalMs)} / ${r.timings?.scopeMs == null ? '—' : r.timings.scopeMs + ' ms'} | `
    + `${PHASES.map(p => r.phases[p] ?? 0).join(' / ')} | ${rules(r.normalizations)} | ${VEREDITOS[r.verdict]}${['clean', 'normalized'].includes(r.verdict) ? '' : ` (${[...new Set(r.problems.map(p => p.code))].join(', ')})`} |`)].join('\n');
}

test.after(() => {
  if (!rows.length) return;
  // The numbers of this run, for docs/BENCH-FRIO.md (.local is outside Git).
  const out = path.join(WORKSPACE, '.local/bench-frio');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'last.json'), JSON.stringify({ at: new Date().toISOString(), rows }, null, 1));
  fs.writeFileSync(path.join(out, 'last.md'), benchTable(rows) + '\n');
});
