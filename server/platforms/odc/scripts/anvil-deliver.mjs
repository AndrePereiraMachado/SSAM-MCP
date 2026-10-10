// Entrega um job DECLARATIVO do kernel do Anvil no modulo vivo, pela ponte do SSAM.
//
// A peca que faltava. O kernel do Anvil ja sabia autorar um OML (`run_job.py --lane odc`, "the same kernel
// compiled against the ODC Studio", facade/lanes.mjs:73) e a ponte ja sabia levar um candidato ao modulo aberto
// (check-base -> preview -> merge). O que nao existia era o manifesto entre os dois: so o ODC3.Builder o
// escrevia, e escreve-lo obriga a compilar uma classe C# IFeature por cada mudanca.
//
// Isto e montagem de JSON, sem uma linha de API do modelo:
//   snapshot do modulo vivo  ->  base.oml + sha256 + capturedAt
//   run_job.py --lane odc --base <base.oml> --out <candidato.oml>
//   manifest.json com os dois lados
//   check-base -> preview -> merge  (os portoes de sempre, intactos)
//
// Duas coisas aprendidas a construi-lo, ambas da mesma familia do tenant:
//  * o `author` do manifesto tem de ser o developer AUTENTICADO, nao o `author` do catalogo -- o portao de
//    autoria compara com a sessao, e o catalogo guarda a identidade corporativa enquanto a sessao e a pessoal.
//  * o `base_drift` dispara mesmo com `modified:false`: abrir um modulo nao e operacao de leitura, e as
//    referencias refrescam-se sozinhas. Por isso o snapshot tira-se AQUI, imediatamente antes, e nao se
//    reaproveita um de ha dez minutos.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { root, studio, nextLabDir } from '../facade/lib.mjs';
import { anvilRoot as ANVIL } from '../facade/workspace.mjs';

const run = promisify(execFile);
// ANVIL_PYTHON, then SSAM_PYTHON (scripts/setup-dev.ps1), then the Python bundled with the Codex runtime under the
// user's profile (the original machine's as fallback), then python on PATH.
const CODEX_PYTHON = path.join(process.env.USERPROFILE ?? 'C:\\Users\\andre', '.cache', 'codex-runtimes', 'codex-primary-runtime',
  'dependencies', 'python', 'python.exe');
const PYTHON = process.env.ANVIL_PYTHON ?? process.env.SSAM_PYTHON ?? (fs.existsSync(CODEX_PYTHON) ? CODEX_PYTHON : 'python');

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();

export async function anvilDeliver({ job, module: moduleName, changes = [], owners = [], pid, label }) {
  if (!job) throw new Error('job e obrigatorio (caminho do JSON do kernel)');
  if (!fs.existsSync(job)) throw new Error('job nao encontrado: ' + job);

  // 1. Snapshot AGORA. O portao base_drift compara o modulo aberto com este ficheiro.
  const snap = await studio(['snapshot', moduleName], pid);
  if (!snap.ok) return { ok: false, passo: 'snapshot', ...snap };

  // 2. O kernel autora o candidato a partir do snapshot.
  const dir = nextLabDir(label ?? path.basename(job, '.json'));
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  const candidato = path.join(dir, moduleName + '-candidate.oml');
  const argv = [path.join(ANVIL, 'scripts', 'run_job.py'), job, '--lane', 'odc', '--base', snap.path, '--out', candidato];
  const saida = await run(PYTHON, argv, { cwd: ANVIL, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    .then(r => ({ ok: true, texto: r.stdout }))
    .catch(e => ({ ok: false, texto: (e.stdout ?? '') + (e.stderr ?? e.message) }));
  if (!saida.ok || !fs.existsSync(candidato))
    return { ok: false, passo: 'kernel', evidencia: dir,
      // O run_job.py ja imprime a linha util; entrega-se essa e nao o despejo todo.
      error: saida.texto.split(/\r?\n/).filter(l => /ok=False|error|Unexpected|Erro/i.test(l)).slice(0, 6).join('\n') || saida.texto.slice(-1200) };

  // 3. O manifesto, que e o unico que faltava.
  const manifesto = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifesto, JSON.stringify({
    schema: 'odc3-manifest/1',
    feature: path.basename(job, '.json'),
    module: moduleName,
    moduleKey: snap.moduleKey,
    tenant: snap.host,
    author: snap.developerId,          // o AUTENTICADO, nao o do catalogo
    basePath: snap.path,
    baseSha256: snap.sha256,
    baseCapturedAt: snap.capturedAt,
    candidatePath: candidato,
    candidateSha256: sha256(candidato),
    owners,
    evidenceDir: path.join(dir, 'evidence'),
    maxBaseAgeMinutes: 60,
    changes: changes.length ? changes : ['Job ' + path.basename(job) + ' aplicado pelo kernel do Anvil'],
    builderReceipt: null,
    smoke: false,
    publishAuthorization: null,
    expectedPublishedRevision: null,
    create: false,
    createAuthorization: null,
    producerPath: null,
    producerSha256: null,
  }, null, 2), 'utf8');

  return { ok: true, manifest: manifesto, candidate: candidato, evidencia: dir,
    base: { path: snap.path, sha256: snap.sha256, capturedAt: snap.capturedAt } };
}

// Uso directo: node scripts/anvil-deliver.mjs <job.json> <Modulo> [--label nome]
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [job, moduleName] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const i = process.argv.indexOf('--label');
  anvilDeliver({ job: job ? path.resolve(job) : undefined, module: moduleName, label: i > 0 ? process.argv[i + 1] : undefined })
    .then(r => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); if (!r.ok) process.exitCode = 1; })
    .catch(e => { process.stdout.write(JSON.stringify({ ok: false, error: e.message }, null, 2) + '\n'); process.exitCode = 1; });
}
