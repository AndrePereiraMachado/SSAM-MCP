#!/usr/bin/env node
// Compara duas rodadas do portão (pastas de .local/gate): contagens por suíte lado a lado e as falhas que apareceram,
// sumiram ou ficaram iguais, cada uma com a classificação da lista de falhas conhecidas.
//   node scripts/gate/compare-runs.mjs <pasta A (antes)> <pasta B (depois)> [--known <lista>] [--out <arquivo.md>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnown, diffRuns, counts } from './gate-lib.mjs';
import { collect } from './run-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export function renderComparison(metaA, metaB, a, b, diff) {
  const L = [`# Portão: ${metaA.head} × ${metaB.head}`, '', '| Suíte | Total A | Total B | Falhou A | Falhou B | Instável A | Instável B | Terminou A/B |', '|---|---|---|---|---|---|---|---|'];
  for (const s of Object.keys(b)) {
    const ca = a[s]?.ran ? counts(a[s].tests) : null, cb = b[s]?.ran ? counts(b[s].tests) : null;
    L.push(`| ${s} | ${ca?.total ?? '-'} | ${cb?.total ?? '-'} | ${ca?.fail ?? '-'} | ${cb?.fail ?? '-'} | ${ca?.flaky ?? '-'} | ${cb?.flaky ?? '-'} | ${a[s]?.ran ? (a[s].complete ? 'sim' : 'não') : '-'}/${b[s]?.ran ? (b[s].complete ? 'sim' : 'não') : '-'} |`);
  }
  const kind = f => f.kind ?? 'não classificada';
  const first = m => m ? ` — ${m.split('\n')[0].slice(0, 200)}` : '';
  const list = (title, items, f) => { L.push('', `## ${title} (${items.length})`, ''); if (!items.length) L.push('Nenhuma.'); items.forEach(i => L.push(`- ${f(i)}`)); };
  list('Apareceram em B', diff.appeared, f => `[${kind(f)}] \`${f.suite}\` ${f.id} (em A: ${f.before})${first(f.message)}`);
  list('Sumiram em B', diff.disappeared, f => `[${kind(f)}] \`${f.suite}\` ${f.id} (em B: ${f.after})`);
  list('Iguais', diff.same, f => `[${kind(f)}] \`${f.suite}\` ${f.id}`);
  return L.join('\n') + '\n';
}

function main() {
  const args = process.argv.slice(2);
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const known = loadKnown(path.resolve(opt('--known') || path.join(here, 'known-failures.json')));
  const out = opt('--out');
  if (args.length !== 2) { console.error('uso: compare-runs.mjs <pasta A> <pasta B> [--known <lista>] [--out <arquivo.md>]'); return 2; }
  const [dirA, dirB] = args.map(d => path.resolve(d));
  const load = dir => { const { meta, stages } = JSON.parse(fs.readFileSync(path.join(dir, 'stages.json'), 'utf8')); return { meta, suites: collect(dir, stages) }; };
  const A = load(dirA), B = load(dirB);
  const text = renderComparison(A.meta, B.meta, A.suites, B.suites, diffRuns(A.suites, B.suites, known));
  if (out) fs.writeFileSync(out, text);
  console.log(text);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
