#!/usr/bin/env node
// The closed registries of the ssam-quality/1 contract (docs/QUALIDADE.md; privacy review of 2026-10-12, finding 1, and its
// re-check), generated from the product sources. The contract (platforms/odc/facade/quality-line.mjs) keeps a code, a
// problem code or a normalization rule only when it is in these lists (or a CamelCase id of the kernel's verify catalogs);
// anything else in a code slot becomes CODE_UNLISTED / RULE_UNLISTED, counted, never the text.
//   CODES  1. every UPPER_SNAKE string literal (2..64 characters, quoted with ' " or `) of the product sources in ROOTS:
//             the facade (the shaper's refusal codes, the server tools, the hosted executor), the portal (tenant tools), the
//             ODC Studio bridge and builder, the launcher and friction store, the customer's agent, kernel/src (problem
//             codes, bridge and CLI errors) and kernel/query-test (the codes of ssam_query_test, compiled into both
//             bridges). Tests, fixtures, node_modules, bin and obj stay out, and so does quality-line.mjs (it holds the
//             registry).
//          2. the codes the product composes at runtime from a word of its own sources, each by its composer's rule:
//             <TOOL>_FAILED   every tool of hosted/tools.json (refusal-codes.mjs toolCode)
//             <STEP>_FAILED   every step of the contract (STEPS)
//             <VERB>_INVALID  every verb of VerbSurface.Verbs and every CommandSurface.OperationNames entry, and OP_INVALID
//                             (JobPreflight.cs: the generic preflight problem of an op of a job)
//             <OP>_REFUSED    every op an IntegrationRefusalException names (SoapPlan.cs: rest, rest-expose, soap)
//             stepCode        every step word (a failed or stage slot) and every gate word of the sources
//                             (refusal-codes.mjs stepCode: <WORD>_FAILED; a snake_case gate as UPPER_SNAKE)
//             PUBLISH_<GATE>  every gate word but none (kernel-delivery.mjs publishOutcomeOf)
//   RULES  the rule ids of the kernel's JobNormalizer (`public const string X = "Y";` in Preflight/JobNormalizer.cs).
// Coverage (coverageOf): every C# source compiled into a project of the scanned C# roots (the two bridges, the kernel, the
// ODC builder; Compile Include globs, default items and ProjectReference closure) and the file that registers each hosted
// tool must be under a scanned root, so a code of the hosted path can never be outside the scan.
//
//   node platforms/odc/scripts/quality-registry.mjs            check: exit 1 when the sources and the registry differ, or
//                                                              a compiled source or a hosted tool's handler is not scanned
//   node platforms/odc/scripts/quality-registry.mjs --write    rewrite the generated block of the line's two copies of
//                                                              the contract (facade and tests/fixtures/quality)
// After --write the contract's sha256 changes: the parity tests and the console's copies follow (docs/QUALIDADE.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stepCode } from '../facade/refusal-codes.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ROOTS = Object.freeze([
  { dir: 'platforms/odc/facade', ext: ['.mjs', '.js'] },
  { dir: 'platforms/odc/portal', ext: ['.mjs', '.js'] },
  { dir: 'platforms/odc/studio', ext: ['.mjs', '.js', '.cs'] },
  { dir: 'facade', ext: ['.mjs'] },
  { dir: 'agent', ext: ['.mjs'] },
  { dir: 'kernel/src', ext: ['.cs'] },
  { dir: 'kernel/query-test', ext: ['.cs'] },
]);
export const NORMALIZER = 'kernel/src/Anvil.Core/Kernel/Preflight/JobNormalizer.cs';
export const VERB_SURFACE = 'kernel/src/Anvil.Core/Kernel/VerbSurface.cs';
export const COMMAND_SURFACE = 'kernel/src/Anvil.Core/Kernel/CommandSurface.cs';
export const TOOLS_JSON = 'platforms/odc/facade/hosted/tools.json';
export const CONTRACTS = Object.freeze(['platforms/odc/facade/quality-line.mjs', 'platforms/odc/facade/tests/fixtures/quality/quality-line.mjs']);
// The bridges whose compiled sources the coverage check resolves first (every other project of a scanned C# root follows).
export const BRIDGES = Object.freeze(['platforms/odc/studio/bridge/Bridge.csproj', 'kernel/src/Anvil.Bridge/Anvil.Bridge.csproj']);
const SKIP_DIRS = new Set(['node_modules', 'tests', 'test', 'fixtures', 'bin', 'obj', '.local', '.git']);
const SKIP_FILES = new Set(['quality-line.mjs']);
export const BEGIN = '// <generated quality-registry: node platforms/odc/scripts/quality-registry.mjs --write>';
export const END = '// </generated quality-registry>';
const SNAKE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const LITERAL = /'([A-Z][A-Z0-9_]{1,63})'|"([A-Z][A-Z0-9_]{1,63})"|`([A-Z][A-Z0-9_]{1,63})`/g;
const upper = value => String(value).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
const isCodeWord = code => typeof code === 'string' && code.length >= 2 && code.length <= 64 && SNAKE.test(code);
const posix = p => p.replaceAll('\\', '/');

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

// ---- the composed families: the words of the sources and the composers' rules
// The verbs of VerbSurface.Verbs (`new("set", "write", ...)`) and the entries of CommandSurface.OperationNames.
export function verbsOf(text) {
  return new Set([...String(text).matchAll(/\bnew\(\s*"([a-z][a-z0-9-]{0,47})"\s*,\s*"(?:write|read)"/g)].map(m => m[1]));
}
export function operationsOf(text) {
  const list = /\bOperationNames\s*=\s*\[([^\]]*)\]/.exec(String(text))?.[1] ?? '';
  return new Set([...list.matchAll(/"([a-z][a-z0-9-]{0,47})"/g)].map(m => m[1]));
}
// A step or gate word: the literal of a slot (failed: 'merge', stage: "kernel", ["stage"] = "model", stage = "open",
// GateName = "known_losses") or the literal arms of a conditional or a default in it (gate = same ? "none" : "base_drift",
// entry.gate ?? 'none'). A slot whose value has a call, an object or an array before its first literal names no word.
const SLOT = /(?:\b(failed|stage|gate|GateName)|\["(failed|stage|gate)"\])\s*(?::|=(?!=))[ \t]*([^,;)}\n]{1,200})/g;
const WORD = `['"\`]([a-z][a-z0-9_-]{1,40})['"\`]`;
const FIRST = new RegExp('^' + WORD);
const ARM = new RegExp('(?:\\?\\??|:|\\|\\|)\\s*' + WORD, 'g');
// The other gate words: a Gate("...") helper (ScSecrets.cs), the last argument of a Refusal or a Fail whose first argument
// is a code (PortalCore.cs: new Refusal("NOT_ALLOWED", message, "retry_refused")), and the `return "..."` of a
// `string Gate(...)` method (Journal.cs: the ODC bridge's gate vocabulary).
const GATE_CALL = /\bGate\(\s*"([a-z][a-z0-9_]{1,40})"\s*\)/g;
const GATE_ARG_CALL = /(?:\bnew\s+Refusal|\bFail)\(\s*(?="[A-Z][A-Z0-9_]*"\s*,)/g;
const GATE_ARG = /^"([a-z][a-z0-9_]{1,40})"$/;
const GATE_METHOD = /\bstring\??\s+Gate\s*\([^)]*\)\s*\{/g;
const INTEGRATION = /\bIntegrationRefusalException\(\s*"([a-z][a-z0-9-]{0,40})"/g;
// From just after an opening bracket to its matching close (string literals skipped, every bracket kind nested): the inner
// text and its top-level comma-separated parts, trimmed.
function bracketAt(text, open) {
  let depth = 1, i = open, quote = null, start = open;
  const args = [];
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') { if (--depth === 0) break; }
    else if (ch === ',' && depth === 1) { args.push(text.slice(start, i).trim()); start = i + 1; }
  }
  args.push(text.slice(start, i).trim());
  return { inner: text.slice(open, i), args };
}
// {steps, gates, integrationOps}: the words one source text gives the composed families.
export function composedWordsOf(text) {
  const steps = new Set(), gates = new Set(), integrationOps = new Set();
  text = String(text);
  for (const m of text.matchAll(SLOT)) {
    const key = m[1] ?? m[2], value = m[3];
    const quote = value.search(/['"`]/);
    if (quote < 0 || /[({[]/.test(value.slice(0, quote))) continue;
    const into = key === 'gate' || key === 'GateName' ? gates : steps;
    const first = FIRST.exec(value);
    if (first) into.add(first[1]);
    else for (const arm of value.matchAll(ARM)) into.add(arm[1]);
  }
  for (const m of text.matchAll(GATE_CALL)) gates.add(m[1]);
  for (const m of text.matchAll(GATE_ARG_CALL)) {
    const { args } = bracketAt(text, m.index + m[0].length);
    const gate = args.length >= 3 ? GATE_ARG.exec(args[args.length - 1]) : null;
    if (gate) gates.add(gate[1]);
  }
  for (const m of text.matchAll(GATE_METHOD))
    for (const r of bracketAt(text, m.index + m[0].length).inner.matchAll(/\breturn\s+"([a-z][a-z0-9_]{1,40})"\s*;/g)) gates.add(r[1]);
  for (const m of text.matchAll(INTEGRATION)) integrationOps.add(m[1]);
  return { steps, gates, integrationOps };
}
// The composers' rules, each as its source writes it.
// JobPreflight.cs: (kind.Length == 0 ? "OP" : Regex.Replace(kind, "[^A-Za-z0-9]", "_").ToUpperInvariant()) + "_INVALID"
export const invalidCodeOf = kind => (kind ? String(kind).replace(/[^A-Za-z0-9]/g, '_').toUpperCase() : 'OP') + '_INVALID';
// SoapPlan.cs IntegrationRefusalException: op.ToUpperInvariant().Replace('-', '_') + "_REFUSED"
export const refusedCodeOf = op => String(op).toUpperCase().replaceAll('-', '_') + '_REFUSED';
// kernel-delivery.mjs publishOutcomeOf: value.gate && value.gate !== 'none' ? 'PUBLISH_' + String(value.gate).toUpperCase()
export const publishGateCodeOf = gate => (gate && gate !== 'none' ? 'PUBLISH_' + String(gate).toUpperCase() : null);
// refusal-codes.mjs stepCode, the shaper's own function: a step word as <WORD>_FAILED, a gate word as the shaper reads it.
export const stepCodeOf = word => stepCode({ failed: word });
export const gateCodeOf = gate => stepCode({ gate });

// scanSources(root) -> {codes, rules, roots: {dir: files}, absent: [dir...], families}: what the sources under root declare.
// steps: the contract's STEPS (the <STEP>_FAILED family); read from the contract when not given.
export async function scanSources(root = ROOT, { steps = null } = {}) {
  const codes = new Set(), roots = {}, absent = [];
  const words = { steps: new Set(), gates: new Set(), integrationOps: new Set() };
  for (const { dir, ext } of ROOTS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) { absent.push(dir); continue; }
    let n = 0;
    for (const file of filesOf(abs, ext)) {
      n++;
      const text = fs.readFileSync(file, 'utf8');
      for (const v of literalsOf(text)) codes.add(v);
      const found = composedWordsOf(text);
      for (const k of Object.keys(words)) for (const w of found[k]) words[k].add(w);
    }
    roots[dir] = n;
  }
  const add = code => { if (isCodeWord(code)) codes.add(code); };
  try {
    const tools = JSON.parse(fs.readFileSync(path.join(root, TOOLS_JSON), 'utf8')).tools ?? {};
    for (const name of Object.keys(tools)) add(upper(name) + '_FAILED');
  } catch { absent.push(TOOLS_JSON); }
  const stepList = steps ?? (await import(pathToFileURL(path.join(root, CONTRACTS[0])).href)).STEPS ?? [];
  for (const step of stepList) add(upper(step) + '_FAILED');
  const read = rel => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { absent.push(rel); return ''; } };
  const verbs = verbsOf(read(VERB_SURFACE)), operations = operationsOf(read(COMMAND_SURFACE));
  add(invalidCodeOf(''));
  for (const kind of [...verbs, ...operations]) add(invalidCodeOf(kind));
  for (const op of words.integrationOps) add(refusedCodeOf(op));
  for (const word of words.steps) add(stepCodeOf(word));
  for (const gate of words.gates) { add(gateCodeOf(gate)); add(publishGateCodeOf(gate)); }
  let rules = new Set();
  try { rules = rulesOf(fs.readFileSync(path.join(root, NORMALIZER), 'utf8')); } catch { absent.push(NORMALIZER); }
  const sorted = set => [...set].sort();
  return { codes, rules, roots, absent, families: { verbs: sorted(verbs), operations: sorted(operations), integrationOps: sorted(words.integrationOps),
    steps: sorted(words.steps), gates: sorted(words.gates) } };
}

// ---- coverage: what the hosted path runs is under a scanned root
// A file (absolute) is scanned when it is under a root of ROOTS with one of its extensions, outside the skipped folders.
export function isScanned(root, file) {
  const rel = posix(path.relative(root, file));
  if (rel.startsWith('../') || path.isAbsolute(rel) || SKIP_FILES.has(path.basename(rel))) return false;
  const under = ROOTS.find(r => rel.startsWith(r.dir + '/') && r.ext.some(x => rel.endsWith(x)));
  return Boolean(under) && !rel.slice(under.dir.length + 1).split('/').slice(0, -1).some(s => SKIP_DIRS.has(s));
}
function csFilesUnder(dir, recursive = true) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (recursive && !['bin', 'obj', 'node_modules', '.git', '.local'].includes(e.name)) out.push(...csFilesUnder(p)); }
    else if (e.isFile() && e.name.endsWith('.cs')) out.push(p);
  }
  return out;
}
// The C# sources a project compiles: the default items of its folder (unless EnableDefaultCompileItems is false), every
// <Compile Include> (a file, a *.cs or a **\*.cs glob) and the same for every <ProjectReference>, transitively.
// compiledSources(root, projects) -> Map(file -> project, relative to root); a missing project is listed under missing.
export function compiledSources(root, projects) {
  const files = new Map(), seen = new Set(), missing = [];
  const visit = abs => {
    if (seen.has(abs)) return;
    seen.add(abs);
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch { missing.push(posix(path.relative(root, abs))); return; }
    const dir = path.dirname(abs), from = posix(path.relative(root, abs));
    if (!/<EnableDefaultCompileItems>\s*false\s*</i.test(text)) for (const f of csFilesUnder(dir)) files.set(f, from);
    for (const m of text.matchAll(/<Compile\s+Include\s*=\s*"([^"]+)"/g))
      for (const include of m[1].split(';').map(s => posix(s.trim())).filter(Boolean)) {
        const star = include.indexOf('*');
        if (star < 0) { files.set(path.resolve(dir, include), from); continue; }
        const base = path.resolve(dir, include.slice(0, include.lastIndexOf('/', star) + 1) || '.');
        for (const f of csFilesUnder(base, include.includes('**'))) files.set(f, from);
      }
    for (const m of text.matchAll(/<ProjectReference\s+Include\s*=\s*"([^"]+)"/g)) visit(path.resolve(dir, posix(m[1])));
  };
  for (const p of projects) visit(path.resolve(root, p));
  return { files, projects: [...seen].map(p => posix(path.relative(root, p))).sort(), missing };
}
// The projects of the scanned C# roots (outside tests).
function projectsUnder(root) {
  const out = [];
  const walk = dir => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); }
      else if (e.name.endsWith('.csproj')) out.push(posix(path.relative(root, p)));
    }
  };
  for (const r of ROOTS) if (r.ext.includes('.cs')) walk(path.join(root, r.dir));
  return out.sort();
}
// The files that register each hosted tool, searched in every JS file of the tree (outside tests, fixtures and dependencies):
// registerTool / register / tool('<name>', ...); else registerTool(X, ...) with const X = '<name>' in the same file; else a
// tool definition { name: '<name>' }.
export function hostedHandlers(root) {
  const tools = JSON.parse(fs.readFileSync(path.join(root, TOOLS_JSON), 'utf8')).tools ?? {};
  const direct = new Map(), byConst = new Map(), byName = new Map();
  const add = (m, k, f) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(f); };
  for (const file of filesOf(root, ['.mjs', '.js', '.cjs'])) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/registerTool|register\(|tool\(|name\s*:/.test(text)) continue;
    for (const m of text.matchAll(/\b(?:registerTool|register|tool)\(\s*['"`]([a-z][a-z0-9_]{1,63})['"`]/g)) add(direct, m[1], file);
    const consts = new Map([...text.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*['"`]([a-z][a-z0-9_]{1,63})['"`]/g)].map(m => [m[1], m[2]]));
    for (const m of text.matchAll(/\bregisterTool\(\s*([A-Za-z_$][\w$]*)\s*,/g)) if (consts.has(m[1])) add(byConst, consts.get(m[1]), file);
    for (const m of text.matchAll(/\bname\s*:\s*['"`]([a-z][a-z0-9_]{1,63})['"`]/g)) add(byName, m[1], file);
  }
  const out = {};
  for (const [name, def] of Object.entries(tools)) {
    if (def?.class === 'unavailable') continue;
    out[name] = [...(direct.get(name) ?? byConst.get(name) ?? byName.get(name) ?? [])].sort();
  }
  return out;
}
// coverageOf(root) -> {projects, compiled, outside: [{file, project}], missingProjects, handlers: {tool: [file]}, unhandled,
// handlersOutside: [{tool, file}]} (paths relative to root).
export function coverageOf(root = ROOT) {
  const { files, projects, missing } = compiledSources(root, [...BRIDGES, ...projectsUnder(root)]);
  const outside = [...files].filter(([f]) => !isScanned(root, f)).map(([f, project]) => ({ file: posix(path.relative(root, f)), project }));
  let handlers = {};
  try { handlers = hostedHandlers(root); } catch { /* no hosted/tools.json here */ }
  const rel = f => posix(path.relative(root, f));
  const entries = Object.entries(handlers);
  return { projects, compiled: files.size, outside, missingProjects: missing,
    handlers: Object.fromEntries(entries.map(([tool, list]) => [tool, list.map(rel)])),
    unhandled: entries.filter(([, list]) => !list.length).map(([tool]) => tool),
    handlersOutside: entries.flatMap(([tool, list]) => list.filter(f => !isScanned(root, f)).map(f => ({ tool, file: rel(f) }))) };
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
  const cover = coverageOf(ROOT);
  const fail = d.missingCodes.length || d.missingRules.length || (!scan.absent.length && (d.staleCodes.length || d.staleRules.length))
    || cover.outside.length || cover.unhandled.length || cover.handlersOutside.length;
  const families = Object.fromEntries(Object.entries(scan.families).map(([k, v]) => [k, v.length]));
  console.log(JSON.stringify({ codes: scan.codes.size, rules: scan.rules.size, roots: scan.roots, families, ...d,
    compiled: cover.compiled, projects: cover.projects.length, outside: cover.outside, unhandled: cover.unhandled, handlersOutside: cover.handlersOutside }, null, 1));
  if (fail) { console.log('the registry differs from the sources (node platforms/odc/scripts/quality-registry.mjs --write), or a source of the hosted path is outside ROOTS'); process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
