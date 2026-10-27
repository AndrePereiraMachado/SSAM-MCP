#!/usr/bin/env node
// Matriz de não regressão: scripts/gate/matrix.json é a fonte; docs/MATRIZ-NAO-REGRESSAO.md traz a forma legível,
// gerada entre <!-- matriz:inicio --> e <!-- matriz:fim -->.
//   node scripts/gate/matrix.mjs --check   valida (toda célula tem prova existente, lacuna nomeada ou n/a) e confere o documento
//   node scripts/gate/matrix.mjs --write   valida e regrava a seção do documento
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLATFORMS = ['o11', 'odc'];
export const OPS = ['criar', 'ler', 'editar', 'refatorar', 'apagar', 'troubleshoot'];
export const LEVELS = { offline: 'O', nativo: 'N', simulado: 'S', vivo: 'V', 'n/a': '–' };
const KERNEL_DIR = { o11: 'kernel/tests/Anvil.Tests', odc: 'kernel/tests/Anvil.Tests.Odc' };
// Fontes de kernel/tests/Shared compilam nos dois projetos (Compile Include nos .csproj).
const SHARED_DIR = 'kernel/tests/Shared';
const FACADE_DIR = { portal: 'platforms/odc/portal/tests', odc: 'platforms/odc/tests', root: 'tests' };

export const facadePath = name => { const [pre, rest] = name.includes('/') ? name.split('/', 2) : [null, name]; return `${pre ? FACADE_DIR[pre] : 'platforms/odc/facade/tests'}/${rest}.test.mjs`; };
export const jobPath = name => `kernel/tests/${name}.json`;

const classIndex = new Map();
function kernelClassExists(root, platform, name) {
  if (!classIndex.has(platform)) {
    const names = new Set();
    for (const dir of [path.join(root, KERNEL_DIR[platform]), path.join(root, SHARED_DIR)]) for (const f of fs.readdirSync(dir)) if (f.endsWith('.cs')) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
    }
    classIndex.set(platform, names);
  }
  return classIndex.get(platform).has(name);
}

export function validateMatrix(matrix, root) {
  const problems = [];
  const ids = new Set();
  for (const f of matrix.features || []) {
    if (!f.id || ids.has(f.id)) problems.push(`funcionalidade sem id ou repetida: ${f.id}`);
    ids.add(f.id);
    if (!f.title) problems.push(`${f.id}: sem título`);
    for (const p of PLATFORMS) for (const c of f.quick?.[p] || []) if (!kernelClassExists(root, p, c)) problems.push(`${f.id}: quick.${p} cita classe inexistente ${c}`);
    for (const p of PLATFORMS) for (const op of OPS) {
      const cells = (f.cells || []).filter(c => c.platform === p && c.op === op);
      const at = `${f.id}/${p}/${op}`;
      if (cells.length !== 1) { problems.push(`${at}: ${cells.length} células (esperada 1)`); continue; }
      const c = cells[0];
      if (!(c.level in LEVELS)) problems.push(`${at}: nível inválido ${c.level}`);
      if (c.level === 'n/a') { if (!c.na) problems.push(`${at}: n/a sem motivo`); continue; }
      const proofs = [...(c.kernel || []), ...(c.facade || []), ...(c.jobs || [])];
      if (!proofs.length && !c.gap) problems.push(`${at}: sem prova e sem lacuna nomeada`);
      if (c.level === 'vivo' && !c.gap) problems.push(`${at}: nível vivo exige a lacuna nomeada (o teste vivo mínimo)`);
      if (c.level !== 'vivo' && !proofs.length) problems.push(`${at}: nível ${c.level} sem prova automatizada`);
      for (const k of c.kernel || []) if (!kernelClassExists(root, p, k)) problems.push(`${at}: classe ${k} não existe em ${KERNEL_DIR[p]} nem em ${SHARED_DIR}`);
      for (const t of c.facade || []) if (!fs.existsSync(path.join(root, facadePath(t)))) problems.push(`${at}: ${facadePath(t)} não existe`);
      for (const j of c.jobs || []) if (!fs.existsSync(path.join(root, jobPath(j)))) problems.push(`${at}: ${jobPath(j)} não existe`);
    }
    for (const c of f.cells || []) if (!PLATFORMS.includes(c.platform) || !OPS.includes(c.op)) problems.push(`${f.id}: célula fora da grade ${c.platform}/${c.op}`);
  }
  return problems;
}

const code = list => list.map(x => `\`${x}\``).join(', ');
const slug = t => t.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMatrix(matrix) {
  const L = [];
  L.push('### Visão geral', '', 'Nível da prova mais forte por célula: **N** nativo headless, **S** entrega simulada pelo servidor, **O** offline puro, **V** só viva (lacuna), **–** não se aplica. Lacuna parcial: **N\\*** etc. (há prova automatizada, mas uma parte só se prova ao vivo).', '');
  L.push(`| Funcionalidade | ${PLATFORMS.flatMap(p => OPS.map(o => `${p.toUpperCase()} ${o}`)).join(' | ')} |`, `|---|${PLATFORMS.flatMap(() => OPS.map(() => ':-:')).join('|')}|`);
  for (const f of matrix.features) {
    const cell = (p, o) => { const c = f.cells.find(x => x.platform === p && x.op === o); return c ? LEVELS[c.level] + (c.gap && c.level !== 'vivo' ? '\\*' : '') : '?'; };
    L.push(`| [${esc(f.title)}](#${slug(f.title)}) | ${PLATFORMS.flatMap(p => OPS.map(o => cell(p, o))).join(' | ')} |`);
  }
  for (const f of matrix.features) {
    L.push('', `### ${f.title}`, '');
    if (f.note) L.push(f.note, '');
    const quick = PLATFORMS.filter(p => (f.quick?.[p] || []).length).map(p => `${p.toUpperCase()}: ${code(f.quick[p])}`);
    L.push(`Filtro do nível quick: ${quick.length ? quick.join('; ') : 'nenhum (só a fachada e o nível full)'}.`, '');
    L.push('| Plat. | Operação | Nível | Kernel (classes) | Fachada (testes) | Jobs canônicos | Lacuna / n/a |', '|---|---|---|---|---|---|---|');
    for (const p of PLATFORMS) for (const o of OPS) {
      const c = f.cells.find(x => x.platform === p && x.op === o);
      if (!c) continue;
      L.push(`| ${p.toUpperCase()} | ${o} | ${c.level} | ${code(c.kernel || [])} | ${code(c.facade || [])} | ${code(c.jobs || [])} | ${esc([c.level === 'n/a' ? `n/a: ${c.na}` : c.gap ? `**Lacuna:** ${c.gap}` : '', (c.outside || []).length ? `Fora do portão: ${c.outside.join('; ')}` : ''].filter(Boolean).join(' '))} |`);
    }
  }
  return L.join('\n') + '\n';
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const matrix = JSON.parse(fs.readFileSync(path.join(root, 'scripts/gate/matrix.json'), 'utf8'));
  const problems = validateMatrix(matrix, root);
  if (problems.length) { console.error(problems.join('\n')); return 1; }
  const docFile = path.join(root, 'docs/MATRIZ-NAO-REGRESSAO.md');
  // O checkout pode trazer CRLF (core.autocrlf): compara e regrava com LF.
  const doc = fs.readFileSync(docFile, 'utf8').replace(/\r\n/g, '\n');
  const [head, rest] = doc.split('<!-- matriz:inicio -->');
  const tail = rest?.split('<!-- matriz:fim -->')[1];
  if (tail === undefined) { console.error('docs/MATRIZ-NAO-REGRESSAO.md sem os marcadores da matriz'); return 1; }
  const next = `${head}<!-- matriz:inicio -->\n${renderMatrix(matrix)}<!-- matriz:fim -->${tail}`;
  if (process.argv.includes('--write')) { fs.writeFileSync(docFile, next); console.log('matriz regravada'); return 0; }
  if (next !== doc) { console.error('documento desatualizado: node scripts/gate/matrix.mjs --write'); return 1; }
  console.log(`matriz ok: ${matrix.features.length} funcionalidades`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
