// Portão de não regressão: leitura dos resultados (trx do dotnet test, JSONL do reporter do node --test, resumo do setup-dev)
// e comparação com a lista versionada de falhas conhecidas. Sem efeitos: run-gate.mjs roda as suítes e grava os arquivos.
import fs from 'node:fs';

export const KINDS = ['ambiente', 'preexistente', 'regressao'];

// Identidade estável de um teste: barras normalizadas e caminhos absolutos de pastas temporárias trocados por <tmp>.
export function normalizeId(id) {
  return String(id).replace(/\\/g, '/').replace(/[A-Za-z]:\/[^\s"',)]*?\/(?:Temp|tmp|sg)\/[^\s"',)/]+/gi, '<tmp>').replace(/\s+/g, ' ').trim();
}

// Glob só com '*' (qualquer sequência) e '?' (um caractere); o resto é literal. Casa o id inteiro.
export function globToRegExp(glob) {
  const body = normalizeId(glob).split('').map(c => c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${body}$`);
}

export function loadKnown(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = validateKnown(doc);
  if (problems.length) throw new Error(`${file}: ${problems.join('; ')}`);
  return doc;
}

export function validateKnown(doc) {
  const problems = [];
  if (!doc || !Array.isArray(doc.entries)) return ['falta "entries"'];
  const seen = new Set();
  doc.entries.forEach((e, i) => {
    const at = `entries[${i}]`;
    if (!['build', 'facade', 'o11', 'odc'].includes(e.suite)) problems.push(`${at}.suite inválida`);
    if (!e.match || typeof e.match !== 'string') problems.push(`${at}.match ausente`);
    if (!KINDS.includes(e.kind)) problems.push(`${at}.kind deve ser ${KINDS.join('|')}`);
    if (!e.reason || String(e.reason).length < 10) problems.push(`${at}.reason ausente ou curto`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.since || '')) problems.push(`${at}.since deve ser AAAA-MM-DD`);
    const key = `${e.suite}|${e.match}`;
    if (seen.has(key)) problems.push(`${at} repetida (${key})`);
    seen.add(key);
  });
  return problems;
}

// ---- trx (dotnet test --logger trx) ----
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? decodeXml(m[1]) : undefined; };
const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const seconds = d => { const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(d || ''); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0; };

export function parseTrx(text) {
  const tests = [];
  const re = /<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g;
  for (let m; (m = re.exec(text));) {
    const tag = m[1], body = m[3] || '';
    const outcome = attr(tag, 'outcome');
    const msg = body.match(/<Message>([\s\S]*?)<\/Message>/);
    tests.push({
      id: normalizeId(attr(tag, 'testName')),
      status: outcome === 'Passed' ? 'pass' : outcome === 'NotExecuted' ? 'skip' : 'fail',
      outcome, seconds: seconds(attr(tag, 'duration')),
      message: msg ? decodeXml(msg[1]).slice(0, 600) : undefined,
    });
  }
  const counters = text.match(/<Counters\b([^>]*)\/>/);
  const summary = counters ? Object.fromEntries(['total', 'executed', 'passed', 'failed', 'error', 'timeout', 'aborted', 'notExecuted'].map(k => [k, +(attr(counters[1], k) || 0)])) : null;
  const resultSummary = text.match(/<ResultSummary\b[^>]*outcome="([^"]*)"/);
  return { tests, summary, outcome: resultSummary ? resultSummary[1] : null };
}

// Classe de um teste xunit "Namespace.Classe.Metodo(args)".
export function classOf(id) {
  const head = id.split('(')[0];
  const parts = head.split('.');
  return parts.length >= 2 ? parts.slice(0, -1).join('.') : head;
}

export function durationsByClass(tests) {
  const by = new Map();
  for (const t of tests) { const c = classOf(t.id); const v = by.get(c) || { class: c, tests: 0, seconds: 0, failed: 0 }; v.tests++; v.seconds += t.seconds; if (t.status === 'fail') v.failed++; by.set(c, v); }
  return [...by.values()].map(v => ({ ...v, seconds: Math.round(v.seconds * 10) / 10 })).sort((a, b) => b.seconds - a.seconds);
}

// ---- JSONL do node-reporter.mjs ----
export function parseNodeJsonl(text) {
  const tests = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.event !== 'test') continue;
    tests.push({ id: normalizeId(`${e.file} :: ${e.path.join(' > ')}`), file: e.file, status: e.status, seconds: (e.ms || 0) / 1000, message: e.message });
  }
  return { tests };
}

// ---- resumo do setup-dev.ps1 ----
export function parseSetupSummary(text) {
  const steps = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(Build: .+?|Pre-requisitos|Dependencias JS)\s{2,}(ok|falha|aviso|pulado|simulado)\b/.exec(line.trim());
    if (m) steps.push({ id: m[1], status: m[2] === 'falha' ? 'fail' : m[2] === 'pulado' ? 'skip' : 'pass', outcome: m[2] });
  }
  return { tests: steps };
}

// ---- comparação ----
// suites: { nome: { ran:boolean, complete:boolean, tests:[{id,status}] , error? } }
// Uma falha é conhecida se casa uma entrada da mesma suíte. Entradas de uma suíte que rodou: 'matched' (ainda falha),
// 'fixed' (casou testes executados e todos passaram: remova da lista) ou 'not-run' (nenhum teste executado casou).
// O resultado nunca altera a lista: as falhas novas saem em 'unknown' para alguém classificar.
export function compare(suites, known, { strict = false } = {}) {
  const entries = known.entries.map(e => ({ ...e, re: globToRegExp(e.match), hits: [], passes: 0 }));
  const unknown = [], knownFailures = [], incomplete = [];
  for (const [suite, r] of Object.entries(suites)) {
    if (!r.ran) continue;
    if (!r.complete) incomplete.push({ suite, error: r.error || 'suíte não terminou' });
    for (const t of r.tests) {
      const hit = entries.filter(e => e.suite === suite && e.re.test(t.id));
      if (t.status === 'fail') {
        if (hit.length) { hit.forEach(e => e.hits.push(t.id)); knownFailures.push({ suite, id: t.id, kind: hit[0].kind, match: hit[0].match }); }
        else unknown.push({ suite, id: t.id, message: t.message });
      } else if (t.status === 'pass') hit.forEach(e => e.passes++);
    }
  }
  const ran = new Set(Object.entries(suites).filter(([, r]) => r.ran).map(([s]) => s));
  const entryStatus = entries.filter(e => ran.has(e.suite)).map(e => ({
    suite: e.suite, match: e.match, kind: e.kind, reason: e.reason, since: e.since,
    status: e.hits.length ? 'matched' : e.passes ? 'fixed' : 'not-run', failures: e.hits.length, passes: e.passes,
  }));
  const openRegressions = entryStatus.filter(e => e.kind === 'regressao' && e.status === 'matched');
  const pass = unknown.length === 0 && incomplete.length === 0 && !(strict && openRegressions.length);
  return { pass, unknown, knownFailures, incomplete, fixed: entryStatus.filter(e => e.status === 'fixed'), notRun: entryStatus.filter(e => e.status === 'not-run'), openRegressions, entries: entryStatus };
}

// Duas rodadas lado a lado (suites no formato de compare): falhas que apareceram em B, que sumiram (falhavam em A e em B passaram
// ou não rodaram) e as iguais. Cada falha leva a classificação da lista conhecida (kind) ou null. Instável não é falha.
export function diffRuns(a, b, known) {
  const entries = known.entries.map(e => ({ ...e, re: globToRegExp(e.match) }));
  const kindOf = (suite, id) => entries.find(e => e.suite === suite && e.re.test(id))?.kind ?? null;
  const fails = s => new Map(Object.entries(s).flatMap(([suite, r]) => r.ran ? r.tests.filter(t => t.status === 'fail').map(t => [`${suite}|${t.id}`, { suite, id: t.id, message: t.message }]) : []));
  const statusIn = (s, suite, id) => s[suite]?.ran ? (s[suite].tests.find(t => t.id === id)?.status ?? 'ausente') : 'suíte não rodou';
  const fa = fails(a), fb = fails(b);
  const tag = f => ({ ...f, kind: kindOf(f.suite, f.id) });
  return {
    appeared: [...fb.entries()].filter(([k]) => !fa.has(k)).map(([, f]) => ({ ...tag(f), before: statusIn(a, f.suite, f.id) })),
    disappeared: [...fa.entries()].filter(([k]) => !fb.has(k)).map(([, f]) => ({ ...tag(f), after: statusIn(b, f.suite, f.id) })),
    same: [...fb.entries()].filter(([k]) => fa.has(k)).map(([, f]) => tag(f)),
  };
}

export function counts(tests) {
  const c = { total: tests.length, pass: 0, fail: 0, skip: 0, flaky: 0 };
  for (const t of tests) c[t.status] = (c[t.status] || 0) + 1;
  return c;
}
