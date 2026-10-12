#!/usr/bin/env node
// The closed registries of the ssam-quality/1 contract (docs/QUALIDADE.md; privacy review of 2026-10-12, finding 1),
// generated from the product sources. The contract (platforms/odc/facade/quality-line.mjs) keeps a code, a problem code
// or a normalization rule only when it is in these lists (or a CamelCase id of the kernel's verify catalogs); anything
// else in a code slot becomes CODE_UNLISTED / RULE_UNLISTED, counted, never the text.
//   CODES  every UPPER_SNAKE string literal (2..64 characters, quoted with ' " or `) of the product sources in ROOTS:
//          the facade (the shaper's refusal codes, the server tools, the hosted executor), the portal (tenant tools), the
//          ODC Studio bridge and builder, the launcher and friction store, the customer's agent and kernel/src (problem
//          codes, bridge and CLI errors). Tests, fixtures, node_modules, bin and obj stay out, and so does
//          quality-line.mjs (it holds the registry). Plus the codes the shaper composes (refusal-codes.mjs):
//          <TOOL>_FAILED for every tool of hosted/tools.json and <STEP>_FAILED for every step of the contract.
//   RULES  the rule ids of the kernel's JobNormalizer (`public const string X = "Y";` in Preflight/JobNormalizer.cs).
//
//   node platforms/odc/scripts/quality-registry.mjs            check: exit 1 when the sources and the registry differ
//   node platforms/odc/scripts/quality-registry.mjs --write    rewrite the generated block of the line's two copies of
//                                                              the contract (facade and tests/fixtures/quality)
// After --write the contract's sha256 changes: the parity tests and the console's copies follow (docs/QUALIDADE.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ROOTS = Object.freeze([
  { dir: 'platforms/odc/facade', ext: ['.mjs', '.js'] },
  { dir: 'platforms/odc/portal', ext: ['.mjs', '.js'] },
  { dir: 'platforms/odc/studio', ext: ['.mjs', '.js', '.cs'] },
  { dir: 'facade', ext: ['.mjs'] },
  { dir: 'agent', ext: ['.mjs'] },
  { dir: 'kernel/src', ext: ['.cs'] },
]);
export const NORMALIZER = 'kernel/src/Anvil.Core/Kernel/Preflight/JobNormalizer.cs';
export const TOOLS_JSON = 'platforms/odc/facade/hosted/tools.json';
export const CONTRACTS = Object.freeze(['platforms/odc/facade/quality-line.mjs', 'platforms/odc/facade/tests/fixtures/quality/quality-line.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'tests', 'test', 'fixtures', 'bin', 'obj', '.local', '.git']);
const SKIP_FILES = new Set(['quality-line.mjs']);
export const BEGIN = '// <generated quality-registry: node platforms/odc/scripts/quality-registry.mjs --write>';
export const END = '// </generated quality-registry>';
const SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const LITERAL = /'([A-Z][A-Z0-9_]{1,63})'|"([A-Z][A-Z0-9_]{1,63})"|`([A-Z][A-Z0-9_]{1,63})`/g;
const upper = value => String(value).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();

function* filesOf(dir, ext) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* filesOf(path.join(dir, e.name), ext); }
    else if (e.isFile() && !SKIP_FILES.has(e.name) && ext.some(x => e.name.endsWith(x))) yield path.join(dir, e.name);
  }
}
// The UPPER_SNAKE literals of one source text.
export function literalsOf(text) {
  const out = new Set();
  for (const m of String(text).matchAll(LITERAL)) { const v = m[1] ?? m[2] ?? m[3]; if (SNAKE.test(v)) out.add(v); }
  return out;
}
// The rule ids a JobNormalizer.cs text declares.
export function rulesOf(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/public\s+const\s+string\s+\w+\s*=\s*"([A-Z][A-Z0-9_]{1,63})"\s*;/g)) if (SNAKE.test(m[1])) out.add(m[1]);
  return out;
}

// scanSources(root) -> {codes, rules, roots: {dir: files}, absent: [dir...]}: what the sources under root declare.
// steps: the contract's STEPS (the <STEP>_FAILED family); read from the contract when not given.
export async function scanSources(root = ROOT, { steps = null } = {}) {
  const codes = new Set(), roots = {}, absent = [];
  for (const { dir, ext } of ROOTS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) { absent.push(dir); continue; }
    let n = 0;
    for (const file of filesOf(abs, ext)) { n++; for (const v of literalsOf(fs.readFileSync(file, 'utf8'))) codes.add(v); }
    roots[dir] = n;
  }
  try {
    const tools = JSON.parse(fs.readFileSync(path.join(root, TOOLS_JSON), 'utf8')).tools ?? {};
    for (const name of Object.keys(tools)) { const code = upper(name) + '_FAILED'; if (SNAKE.test(code) && code.length <= 64) codes.add(code); }
  } catch { absent.push(TOOLS_JSON); }
  const stepList = steps ?? (await import(pathToFileURL(path.join(root, CONTRACTS[0])).href)).STEPS ?? [];
  for (const step of stepList) codes.add(upper(step) + '_FAILED');
  let rules = new Set();
  try { rules = rulesOf(fs.readFileSync(path.join(root, NORMALIZER), 'utf8')); } catch { absent.push(NORMALIZER); }
  return { codes, rules, roots, absent };
}

// The generated block of the contract for these sets (sorted; the codes as one template text wrapped at 120 columns).
export function renderBlock({ codes, rules }) {
  const list = [...codes].sort();
  const lines = [];
  let line = '';
  for (const code of list) {
    if (line && line.length + 1 + code.length > 120) { lines.push(line); line = code; } else line = line ? line + ' ' + code : code;
  }
  if (line) lines.push(line);
  return [BEGIN,
    'const CODE_TEXT = `',
    ...lines,
    '`;',
    'export const RULES = Object.freeze([' + [...rules].sort().map(r => "'" + r + "'").join(', ') + ']);',
    END].join('\n');
}
// The block a contract text holds (BEGIN..END), or null.
export function blockOf(text) {
  const a = text.indexOf(BEGIN), b = text.indexOf(END);
  return a < 0 || b < a ? null : text.slice(a, b + END.length);
}

// What differs between the sources and the registry: missing (a constant of the sources the registry lacks) and stale (a
// registry entry no source declares any more). registry: {CODES, RULES} of the contract module.
export function driftOf(scan, registry) {
  const codes = new Set(registry.CODES), rules = new Set(registry.RULES);
  return { missingCodes: [...scan.codes].filter(c => !codes.has(c)).sort(), staleCodes: [...codes].filter(c => !scan.codes.has(c)).sort(),
    missingRules: [...scan.rules].filter(r => !rules.has(r)).sort(), staleRules: [...rules].filter(r => !scan.rules.has(r)).sort() };
}

async function main() {
  const write = process.argv.includes('--write');
  const scan = await scanSources(ROOT);
  if (scan.absent.length) console.log('absent here (not scanned): ' + scan.absent.join(', '));
  if (write) {
    const block = renderBlock(scan);
    for (const rel of CONTRACTS) {
      const file = path.join(ROOT, rel);
      const text = fs.readFileSync(file, 'utf8');
      const old = blockOf(text);
      if (!old) throw new Error('no generated block in ' + rel);
      fs.writeFileSync(file, text.replace(old, () => block));
      console.log((old === block ? 'unchanged ' : 'rewritten ') + rel);
    }
    console.log(`codes ${scan.codes.size}, rules ${scan.rules.size}`);
    return;
  }
  const registry = await import(pathToFileURL(path.join(ROOT, CONTRACTS[0])).href + '?' + Date.now());
  const d = driftOf(scan, registry);
  const fail = d.missingCodes.length || d.missingRules.length || (!scan.absent.length && (d.staleCodes.length || d.staleRules.length));
  console.log(JSON.stringify({ codes: scan.codes.size, rules: scan.rules.size, roots: scan.roots, ...d }, null, 1));
  if (fail) { console.log('the registry differs from the sources: node platforms/odc/scripts/quality-registry.mjs --write'); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
