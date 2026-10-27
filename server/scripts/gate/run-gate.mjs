#!/usr/bin/env node
// Portão de não regressão do SSAM (docs/MATRIZ-NAO-REGRESSAO.md). Roda, em ordem:
//   build   scripts/setup-dev.ps1 (todos os componentes compilam)
//   o11     dotnet test kernel/tests/Anvil.Tests      (full: suíte inteira; quick: filtros críticos da matriz)
//   odc     dotnet test kernel/tests/Anvil.Tests.Odc  (idem)
//   facade  node --test da raiz, fachada, Portal e platforms/odc (sempre a fachada inteira)
// A fachada vem por último: JobTests e OdcJobTests gravam em .local/test-work os selos (<job>.result.json) que os testes
// de descoberta da fachada (catalog-*) leem como prova atual. Fachada antes do kernel num worktree novo falha neles.
// O portão compara as falhas com scripts/gate/known-failures.json. Passa quando nenhuma falha está fora da lista e toda suíte terminou.
// Falhas novas da fachada e do kernel são repetidas uma vez a sós; as que passam a sós saem como instáveis, não como falhas.
// O portão nunca escreve na lista: as falhas novas ficam em report.json/unknown para alguém classificar.
//
//   node scripts/gate/run-gate.mjs --level quick|full [--only build,facade,o11,odc] [--feature entidades,actions]
//        [--strict] [--out <pasta>] [--from <pasta de um portão anterior>] [--studio-dir <pasta>] [--temp <pasta curta>]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadKnown, parseTrx, parseNodeJsonl, parseSetupSummary, compare, counts, durationsByClass, classOf } from './gate-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const SUITES = ['build', 'o11', 'odc', 'facade'];
const FACADE_GLOBS = ['tests/*.test.mjs', 'platforms/odc/facade/tests/*.test.mjs', 'platforms/odc/portal/tests/*.test.mjs', 'platforms/odc/tests/*.test.mjs'];
const KERNEL = { o11: 'kernel/tests/Anvil.Tests', odc: 'kernel/tests/Anvil.Tests.Odc' };
const RERUN_LIMIT = 40;
const ODC_STUDIO = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OutSystems', 'ODC Studio', 'ODC Studio');

function parseArgs(argv) {
  const a = { level: null, only: SUITES, feature: null, strict: false, out: null, from: null, studioDir: null, temp: null, known: path.join(here, 'known-failures.json'), matrix: path.join(here, 'matrix.json') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => argv[++i];
    if (k === '--level') a.level = v();
    else if (k === '--only') a.only = v().split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--feature') a.feature = v().split(',').map(s => s.trim()).filter(Boolean);
    else if (k === '--strict') a.strict = true;
    else if (k === '--out') a.out = path.resolve(v());
    else if (k === '--from') a.from = path.resolve(v());
    else if (k === '--studio-dir') a.studioDir = v();
    else if (k === '--temp') a.temp = path.resolve(v());
    else if (k === '--known') a.known = path.resolve(v());
    else if (k === '--matrix') a.matrix = path.resolve(v());
    else if (k === '--help' || k === '-h') a.help = true;
    else throw usage(`argumento desconhecido: ${k}`);
  }
  if (a.help) return a;
  if (!a.from && !['quick', 'full'].includes(a.level)) throw usage('--level quick|full é obrigatório (ou --from <pasta>)');
  for (const s of a.only) if (!SUITES.includes(s)) throw usage(`suíte desconhecida em --only: ${s}`);
  return a;
}
function usage(msg) { const e = new Error(msg); e.usage = true; return e; }

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const log = msg => console.log(`[gate ${new Date().toLocaleTimeString('pt-BR')}] ${msg}`);
const fmt = s => s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.round(s % 3600 / 60)).padStart(2, '0')}` : s >= 60 ? `${Math.floor(s / 60)}min${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)}s`;

// Classes do kernel a filtrar: quick = listas "quick" de cada funcionalidade da matriz; --feature = todas as classes citadas
// daquelas funcionalidades. full sem --feature = suíte inteira (null).
export function kernelClasses(matrix, platform, { level, features }) {
  if (level === 'full' && !features) return null;
  const set = new Set();
  for (const f of matrix.features) {
    if (features && !features.includes(f.id)) continue;
    if (features) for (const cell of f.cells || []) if (cell.platform === platform) (cell.kernel || []).forEach(c => set.add(c));
    if (level === 'quick') (f.quick?.[platform] || []).forEach(c => set.add(c));
  }
  return [...set].sort();
}
export const classFilter = classes => classes.map(c => `FullyQualifiedName~.${c}.`).join('|');

function run(cmd, args, { cwd = root, env, logFile, label }) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n### ${cmd} ${args.join(' ')}\n`);
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', out, out], windowsHide: true });
    const beat = setInterval(() => log(`${label}: rodando há ${fmt((Date.now() - t0) / 1000)}`), 10 * 60 * 1000);
    child.on('error', err => { clearInterval(beat); fs.closeSync(out); resolve({ code: -1, error: err.message, seconds: (Date.now() - t0) / 1000 }); });
    child.on('close', code => { clearInterval(beat); fs.closeSync(out); resolve({ code, seconds: (Date.now() - t0) / 1000 }); });
  });
}

function isolatedEnv(a, outDir) {
  const temp = a.temp || path.join(process.env.LOCALAPPDATA || path.dirname(outDir), 'Temp', 'sg', path.basename(outDir).slice(-12));
  fs.mkdirSync(temp, { recursive: true });
  const env = { ...process.env, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_NO_WARM: '1', TEMP: temp, TMP: temp, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
  const studio = a.studioDir || process.env.ANVIL_STUDIO_DIR || 'C:\\Program Files\\OutSystems\\Service Studio 11\\Service Studio';
  if (fs.existsSync(studio)) env.ANVIL_STUDIO_DIR = studio;
  const features = path.join(process.env.LOCALAPPDATA || '', 'OutSystems', 'ODC Studio');
  if (fs.existsSync(path.join(features, 'Features.xml'))) {
    const copy = path.join(temp, 'odc-features');
    fs.mkdirSync(copy, { recursive: true });
    for (const f of ['Features.xml', 'FeaturesOverride.xml']) if (fs.existsSync(path.join(features, f))) fs.copyFileSync(path.join(features, f), path.join(copy, f));
    env.ANVIL_ODC_FEATURES_DIR = copy;
  }
  // Avisos (não bloqueiam): provas que voltam cedo como aprovadas quando falta uma instalação desta máquina.
  const warnings = [];
  const integration = process.env.ANVIL_INTEGRATION_STUDIO_DIR || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OutSystems', 'Integration Studio');
  if (!fs.existsSync(integration)) warnings.push(`sem Integration Studio (${integration}): XifInstalledEngineTests e Pa3K1XifTests voltam cedo`);
  if (!env.ANVIL_ODC_FEATURES_DIR) warnings.push('sem Features.xml do ODC Studio: testes ODC que leem as features recusam ou pulam');
  return { env, temp, studio: env.ANVIL_STUDIO_DIR, warnings };
}

async function stageBuild(ctx) {
  const logFile = path.join(ctx.out, 'build.log');
  const r = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'setup-dev.ps1'), '-Yes', '-NoUserEnv', '-SkipMcp', '-SkipDoctor'], { env: ctx.env, logFile, label: 'build' });
  return { ...r, complete: fs.readFileSync(logFile, 'utf8').includes('Tempo total') };
}

async function stageFacade(ctx) {
  const reporter = path.join(here, 'node-reporter.mjs');
  const jsonl = path.join(ctx.out, 'facade.jsonl');
  const args = ['--test', `--test-reporter=${pathToUrl(reporter)}`, `--test-reporter-destination=${jsonl}`, '--test-reporter=spec', `--test-reporter-destination=${path.join(ctx.out, 'facade-spec.log')}`, ...FACADE_GLOBS];
  const r = await run(process.execPath, args, { env: ctx.env, logFile: path.join(ctx.out, 'facade.log'), label: 'facade' });
  const result = { ...r, complete: [0, 1].includes(r.code) && fs.existsSync(jsonl) };
  // Repetição a sós (concorrência 1) dos arquivos com falha fora da lista: sob carga, testes de tempo falham e passam sozinhos.
  const parsed = parseNodeJsonl(read(jsonl));
  const unknownFiles = [...new Set(compare({ facade: { ran: true, complete: true, tests: parsed.tests } }, ctx.known).unknown.map(u => parsed.tests.find(t => t.id === u.id)?.file).filter(f => f && fs.existsSync(path.join(root, f))))];
  if (unknownFiles.length) {
    log(`facade: repetindo a sós ${unknownFiles.length} arquivo(s) com falha nova`);
    const rerun = path.join(ctx.out, 'facade-rerun.jsonl');
    const r2 = await run(process.execPath, ['--test', '--test-concurrency=1', `--test-reporter=${pathToUrl(reporter)}`, `--test-reporter-destination=${rerun}`, ...unknownFiles], { env: ctx.env, logFile: path.join(ctx.out, 'facade.log'), label: 'facade (repetição)' });
    result.rerunSeconds = r2.seconds;
  }
  return result;
}

async function stageKernel(ctx, platform) {
  const classes = kernelClasses(ctx.matrix, platform, { level: ctx.level, features: ctx.features });
  if (classes && !classes.length) return { skipped: 'nenhuma classe selecionada para esta plataforma', complete: true, code: 0, seconds: 0 };
  // Sem o Studio da plataforma, os testes nativos voltam cedo como aprovados: um verde assim não prova nada.
  const studio = platform === 'o11' ? ctx.studio : ODC_STUDIO;
  if (!studio || !fs.existsSync(path.join(studio, 'OutSystems.Model.V1.dll')))
    return { complete: false, code: -1, seconds: 0, error: `Studio ${platform.toUpperCase()} ausente (${studio || 'sem pasta'}): as provas nativas voltariam cedo como aprovadas` };
  const trx = path.join(ctx.out, `${platform}.trx`);
  const base = trxFile => ['test', path.join(root, KERNEL[platform]), '-c', 'Release', '--nologo', '--results-directory', ctx.out, '--logger', `trx;LogFileName=${trxFile}`, '--blame-hang-timeout', '30m', ...(platform === 'o11' && ctx.studio ? [`-p:SSDir=${ctx.studio}`] : [])];
  const args = [...base(trx), ...(classes ? ['--filter', classFilter(classes)] : [])];
  const logFile = path.join(ctx.out, `${platform}.log`);
  const r = await run('dotnet', args, { env: ctx.env, logFile, label: platform });
  const text = read(trx);
  const aborted = /test run was aborted|Test Run Aborted|host process crashed|The active test run was aborted/i.test(read(logFile).slice(-20000)) || /outcome="Aborted"/.test(text);
  const result = { ...r, classes: classes ? classes.length : 'todas', complete: [0, 1].includes(r.code) && !!text && !aborted };
  if (!result.complete) result.error = !text ? 'sem trx (build falhou ou o dotnet test não rodou: veja o log)' : aborted ? 'execução abortada (host caiu ou travou)' : `código ${r.code}`;
  // Repetição a sós das falhas novas, por método (todas as linhas de uma Theory juntas), até RERUN_LIMIT métodos.
  if (text) {
    const tests = parseTrx(text).tests;
    const unknown = compare({ [platform]: { ran: true, complete: true, tests } }, ctx.known).unknown;
    const methods = [...new Set(unknown.map(u => u.id.split('(')[0]))];
    if (methods.length && methods.length <= RERUN_LIMIT) {
      log(`${platform}: repetindo a sós ${methods.length} método(s) com falha nova`);
      const rerunTrx = path.join(ctx.out, `${platform}-rerun.trx`);
      const rerunArgs = [...base(rerunTrx), '--no-build', '--filter', methods.map(m => `FullyQualifiedName~${m}`).join('|')];
      const r2 = await run('dotnet', rerunArgs, { env: ctx.env, logFile, label: `${platform} (repetição)` });
      result.rerunSeconds = r2.seconds;
    } else if (methods.length) result.rerunSkipped = `${methods.length} métodos com falha nova (> ${RERUN_LIMIT}): sem repetição`;
  }
  return result;
}

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const pathToUrl = p => 'file:///' + p.replace(/\\/g, '/');

// Junta resultados de uma pasta do portão (desta execução ou de --from) e aplica a repetição: falha que passou a sós vira 'flaky'.
export function collect(out, stages) {
  const suites = {};
  const flakyFrom = (tests, rerunTests) => {
    const again = new Map(rerunTests.map(t => [t.id, t.status]));
    return tests.map(t => t.status === 'fail' && again.get(t.id) === 'pass' ? { ...t, status: 'flaky' } : t);
  };
  for (const s of SUITES) {
    const st = stages[s];
    if (!st || st.skipped === 'não selecionada') { suites[s] = { ran: false, tests: [] }; continue; }
    let tests = [];
    if (s === 'build') tests = parseSetupSummary(read(path.join(out, 'build.log'))).tests;
    if (s === 'facade') tests = flakyFrom(parseNodeJsonl(read(path.join(out, 'facade.jsonl'))).tests, parseNodeJsonl(read(path.join(out, 'facade-rerun.jsonl'))).tests);
    if (s === 'o11' || s === 'odc') {
      const rerun = parseTrx(read(path.join(out, `${s}-rerun.trx`))).tests;
      // Theory: a repetição por método roda todas as linhas; vale a linha de mesmo id.
      tests = flakyFrom(parseTrx(read(path.join(out, `${s}.trx`))).tests, rerun);
    }
    suites[s] = { ran: true, complete: !!st.complete, error: st.error, tests };
  }
  return suites;
}

export function renderReport({ meta, stages, suites, verdict }) {
  const L = [];
  L.push(`# Portão de não regressão: ${verdict.pass ? 'PASSOU' : 'FALHOU'}`, '');
  L.push(`- Nível: ${meta.level}${meta.features ? ` (funcionalidades: ${meta.features.join(', ')})` : ''}; HEAD ${meta.head}; início ${meta.startedAt}; total ${fmt(meta.seconds || 0)}`);
  L.push(`- Lista de falhas conhecidas: ${meta.known} (${meta.knownEntries} entradas)`);
  for (const w of meta.warnings || []) L.push(`- Aviso: ${w}`);
  L.push('');
  L.push('| Suíte | Tempo | Total | Passou | Falhou | Pulou | Instável (passou a sós) | Terminou |', '|---|---|---|---|---|---|---|---|');
  for (const s of SUITES) {
    const st = stages[s] || {}, r = suites[s];
    if (!r.ran) { L.push(`| ${s} | - | não rodou | | | | | |`); continue; }
    const c = counts(r.tests);
    L.push(`| ${s}${st.classes ? ` (${st.classes} classes)` : ''} | ${fmt((st.seconds || 0) + (st.rerunSeconds || 0))} | ${c.total} | ${c.pass} | ${c.fail} | ${c.skip} | ${c.flaky} | ${r.complete ? 'sim' : `NÃO: ${r.error || ''}`} |`);
  }
  const list = (title, items, f) => { if (!items.length) return; L.push('', `## ${title} (${items.length})`, ''); items.forEach(i => L.push(`- ${f(i)}`)); };
  list('Falhas fora da lista (bloqueiam; classifique: ambiente, preexistente ou regressão)', verdict.unknown, u => `\`${u.suite}\` ${u.id}${u.message ? `\n  > ${u.message.split('\n')[0].slice(0, 240)}` : ''}`);
  list('Suítes que não terminaram (bloqueiam)', verdict.incomplete, i => `\`${i.suite}\`: ${i.error}`);
  list('Regressões conhecidas ainda abertas' + (meta.strict ? ' (bloqueiam: --strict)' : ''), verdict.openRegressions, e => `\`${e.suite}\` \`${e.match}\` (${e.failures} falha(s)) desde ${e.since}: ${e.reason}`);
  list('Corrigidas: saíram da lista (remova as entradas)', verdict.fixed, e => `\`${e.suite}\` \`${e.match}\` (${e.passes} passaram)`);
  const flaky = Object.entries(suites).flatMap(([s, r]) => r.tests.filter(t => t.status === 'flaky').map(t => ({ suite: s, id: t.id })));
  list('Instáveis: falharam na rodada e passaram a sós', flaky, f => `\`${f.suite}\` ${f.id}`);
  const byKind = {};
  for (const k of verdict.knownFailures) (byKind[k.kind] ||= []).push(k);
  for (const [kind, items] of Object.entries(byKind)) list(`Falhas conhecidas: ${kind}`, items, k => `\`${k.suite}\` ${k.id}`);
  list('Entradas da lista sem teste executado nesta rodada', verdict.notRun, e => `\`${e.suite}\` \`${e.match}\``);
  return L.join('\n') + '\n';
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n')); return 0; }
  const known = loadKnown(a.known);
  const matrix = JSON.parse(fs.readFileSync(a.matrix, 'utf8'));
  const out = a.from || a.out || path.join(root, '.local', 'gate', `${stamp()}-${a.level}`);
  fs.mkdirSync(out, { recursive: true });
  const stagesFile = path.join(out, 'stages.json');
  let meta, stages;
  if (a.from) {
    ({ meta, stages } = JSON.parse(fs.readFileSync(stagesFile, 'utf8')));
    log(`reavaliando ${out} contra ${a.known}`);
  } else {
    const head = (await gitHead()) || 'desconhecido';
    const { env, temp, studio, warnings } = isolatedEnv(a, out);
    meta = { level: a.level, features: a.feature, head, startedAt: new Date().toISOString(), temp, studio, only: a.only, warnings };
    stages = {};
    const ctx = { out, env, studio, known, matrix, level: a.level, features: a.feature };
    const t0 = Date.now();
    log(`nível ${a.level}, HEAD ${head}, resultados em ${out}`);
    for (const s of SUITES) {
      if (!a.only.includes(s)) { stages[s] = { skipped: 'não selecionada' }; continue; }
      log(`${s}: início`);
      stages[s] = s === 'build' ? await stageBuild(ctx) : s === 'facade' ? await stageFacade(ctx) : await stageKernel(ctx, s);
      log(`${s}: fim em ${fmt(stages[s].seconds || 0)} (código ${stages[s].code}${stages[s].complete ? '' : ', NÃO terminou'})`);
      fs.writeFileSync(stagesFile, JSON.stringify({ meta, stages }, null, 2));
    }
    meta.seconds = (Date.now() - t0) / 1000;
    fs.writeFileSync(stagesFile, JSON.stringify({ meta, stages }, null, 2));
  }
  meta.known = path.relative(root, a.known).split(path.sep).join('/');
  meta.knownEntries = known.entries.length;
  meta.strict = a.strict;
  const suites = collect(out, stages);
  const verdict = compare(suites, known, { strict: a.strict });
  for (const p of ['o11', 'odc']) if (suites[p].ran) fs.writeFileSync(path.join(out, `durations-${p}.json`), JSON.stringify(durationsByClass(suites[p].tests), null, 2));
  const report = renderReport({ meta, stages, suites, verdict });
  fs.writeFileSync(path.join(out, 'report.md'), report);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ meta, stages, counts: Object.fromEntries(Object.entries(suites).map(([s, r]) => [s, r.ran ? { ...counts(r.tests), complete: r.complete } : null])), verdict }, null, 2));
  console.log('\n' + report);
  log(`relatório: ${path.join(out, 'report.md')}`);
  return verdict.pass ? 0 : 1;
}

function gitHead() {
  return new Promise(resolve => {
    const c = spawn('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: root, windowsHide: true });
    let s = ''; c.stdout.on('data', d => s += d); c.on('error', () => resolve(null)); c.on('close', () => resolve(s.trim() || null));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), err => { console.error(err.usage ? `uso: ${err.message}` : err.stack || err); process.exit(2); });
}
export { classOf };
