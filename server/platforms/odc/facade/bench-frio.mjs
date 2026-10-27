// R8 (bench a frio, docs/BENCH-FRIO.md): the lab corpora as ssam_code check calls against a local fixture capture, measured
// from outside the check (wall of the facade, the kernel processes it ran, problems per phase, normalizations per rule).
// Measurement only: not an MCP tool, and it changes nothing of the check it measures.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codeCheck } from './code-check.mjs';
import { buildIndex, laneSources } from './discovery.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WORKSPACE = path.resolve(here, '../../..');
export const BENCH_FIXTURES = path.join(here, 'tests/fixtures/bench-frio');
const kernelFixtures = path.join(WORKSPACE, 'kernel/tests/fixtures');
// The captures of the lane fixtures: blank-service.oml (O11) and blank-mobile.oml, the blank module of Anvil.Tests.Odc.
export const BASES = { o11: path.join(kernelFixtures, 'blank-service.oml'), odc: path.join(kernelFixtures, 'odc/blank-mobile.oml') };
// The local CLIs scripts/setup-dev.ps1 builds in this checkout: only run here, never built or replaced.
export const CLIS = {
  o11: process.env.SSAM_BENCH_CLI_O11 || path.join(WORKSPACE, 'kernel/.local/cli/anvil.dll'),
  odc: process.env.SSAM_BENCH_CLI_ODC || path.join(WORKSPACE, 'kernel/.local/lane-odc/cli/anvil-odc.dll'),
};
export const PHASES = ['input', 'preflight', 'base', 'scope', 'apply', 'verify'];
const AFTER_BUILD = new Set(['apply', 'verify']);

// The corpora (tests/fixtures/bench-frio/README.md has where each came from in the lab). Files in the order of the lab's
// job: raw ops (exceptions, roles) first, then the data, then the logic. A corpus runs on odc only when its text is neutral:
// the three of 100 actions were written for an O11 module (public server actions, references to User with the default
// delete rule Protect), which an ODC app refuses by rule, so on odc they would measure the lane, not the corpus.
const O11_SHAPED = 'written for O11: public server actions and references to User with deleteRule Protect, both refused in an ODC app';
export const CORPORA = [
  { id: 'portuario', label: 'Port operations, 100 actions', module: 'BenchPortuario', lanes: ['o11'], notOn: { odc: O11_SHAPED }, files: ['ops.json', 'dados.ddl', 'logica.flow'],
    lab: 'delivered on the first submission', diagnostic: 'docs/diagnosticos/2026-10-17-portuario-100-actions.md' },
  { id: 'naval-2', label: 'Naval, second corpus, 100 actions', module: 'BenchNaval', lanes: ['o11'], notOn: { odc: 'written for O11: references to User with deleteRule Protect, refused in an ODC app' }, files: ['ops.json', 'dados.ddl', 'logica.flow'],
    lab: 'delivered on the first submission', diagnostic: 'docs/diagnosticos/2026-10-18-cem-actions-entidades.md' },
  { id: 'hx', label: 'Hx humanitarian logistics, 100 actions', module: 'BenchHx', lanes: ['o11'], notOn: { odc: O11_SHAPED }, files: ['ops.json', 'dados.ddl', 'logica.flow'],
    lab: 'refused by the native build: 133 `assign X=v`', diagnostic: 'docs/PROVA-100-LOGISTICA-2026-10-18.md' },
  { id: 'museum-model', label: 'Museums, 100 entities', module: 'BenchMuseus', lanes: ['o11', 'odc'], files: ['dados.ddl'],
    lab: 'delivered on the first submission', diagnostic: 'docs/PLANO-COMPILADOR-GERAL-BATCH-LAB.md (museum-model-cold.batch, 19/10)' },
];

export const cliMissing = lane => !fs.existsSync(CLIS[lane]) && `the ${lane} CLI is not built (${path.relative(WORKSPACE, CLIS[lane])}; scripts/setup-dev.ps1 builds it)`;
export const corpusFiles = corpus => corpus.files.map(f => path.join(BENCH_FIXTURES, corpus.id, f));

/** Bytes of the texts and the elements they write: entities (static ones too), structures, actions, raw ops. */
export function measureText(files) {
  let bytes = 0, entities = 0, structures = 0, actions = 0, ops = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    bytes += Buffer.byteLength(text);
    if (file.endsWith('.ddl')) {
      entities += (text.match(/^create (?:static )?entity\b/gm) ?? []).length;
      structures += (text.match(/^create structure\b/gm) ?? []).length;
    } else if (file.endsWith('.flow')) actions += (text.match(/^(?:server action|service action|client action|data action|action)[ \t]+\S/gm) ?? []).length;
    else if (file.endsWith('.json')) ops += JSON.parse(text).length;
  }
  return { bytes, entities, structures, actions, ops };
}

/**
 * The check's runner, as the CLI tests inject it (ssam-code-check.test.mjs cliDeps): one cold `dotnet <cli>` per call, no
 * worker. Each call is recorded with its process wall and what its envelope says of the kernel's own time.
 */
export function benchDeps(lane, dir, calls = []) {
  // runJob looks for the ODC CLI under its root; the real assembly runs through the injected runner below.
  const marker = path.join(dir, '.local/lane-odc/cli/anvil-odc.dll');
  fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, 'runner is injected');
  const temp = path.join(dir, 'tmp'); fs.mkdirSync(temp, { recursive: true });
  const env = { ...process.env, TEMP: temp, TMP: temp, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', SSAM_NO_WARM: '1', SSAM_MODULE_INDEX_ROOT: path.join(dir, 'index') };
  return { root: dir, local: path.join(dir, 'local'), odcRoot: path.join(dir, 'odc'), env,
    runAnvil: (args, options = {}) => new Promise(resolve => {
      const start = process.hrtime.bigint();
      execFile('dotnet', [CLIS[lane], ...args], { cwd: options.cwd, env, timeout: 900000, maxBuffer: 1 << 28, windowsHide: true }, (error, stdout, stderr) => {
        const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
        let envelope; try { envelope = JSON.parse(stdout); } catch { envelope = { ok: false, error: stdout + stderr }; }
        calls.push({ command: args[0], wallMs, elapsedMs: envelope?.elapsedMs ?? null, timings: envelope?.data?.timings ?? null });
        resolve({ ok: !error && envelope.ok, exitCode: error?.code ?? 0, envelope, stderr: stderr ? [stderr] : [], wallMs });
      });
    }) };
}

/** Problems per phase: the kernel's `phase`, else `input` for the facade's own refusals of the input. */
export function problemsByPhase(result) {
  const counts = Object.fromEntries(PHASES.map(p => [p, 0]));
  for (const p of result?.problems ?? []) {
    const phase = typeof p?.phase === 'string' ? p.phase : (p?.code === 'INPUT_INVALID' || p?.code === 'CAPTURE_MISSING' ? 'input' : 'unknown');
    counts[phase] = (counts[phase] ?? 0) + 1;
  }
  return counts;
}

/**
 * Normalizations per rule, of the one `normalizations` field (normalizations.mjs): a list of the facade's notes, or the
 * kernel's {total, byRule, items} with the facade's merged in; byRule counts every item, also those `items` leaves out.
 */
export function normalizationsByRule(result) {
  const notes = result?.normalizations, counts = {};
  const add = (rule, n = 1) => { counts[rule] = (counts[rule] ?? 0) + n; };
  if (Array.isArray(notes)) for (const n of notes) add(String(n?.rule ?? 'UNKNOWN'));
  else if (notes?.byRule && typeof notes.byRule === 'object') for (const [rule, n] of Object.entries(notes.byRule)) add(rule, Number(n) || 0);
  else if (Array.isArray(notes?.items)) for (const n of notes.items) add(String(n?.rule ?? 'UNKNOWN'));
  return counts;
}
// The kernel names its rewrites of the text in capitals (FLOW_ASSIGN_SPACING, OWNER_CHILD_CREATED); the facade's notes of
// how it read the call are kebab-case (files, logic-split, parts-order): they say how the files were taken, not that a
// text was rewritten.
const kernelRule = rule => /^[A-Z][A-Z0-9_]*$/.test(rule);
export const splitRules = rules => ({
  kernel: Object.fromEntries(Object.entries(rules).filter(([r]) => kernelRule(r))),
  facade: Object.fromEntries(Object.entries(rules).filter(([r]) => !kernelRule(r))),
});

export const VERDICTS = {
  clean: 'accepted, no problem',
  normalized: 'accepted with normalizations',
  beforeBuild: 'refused before the build',
  afterBuild: 'refused in the build',
};

/**
 * The verdict of one check: accepted (clean, or with the kernel's normalizations of the text), refused before the build
 * (input, preflight, base, scope), or in it (apply, verify).
 */
export function verdictOf(result, phases = problemsByPhase(result), rules = normalizationsByRule(result)) {
  if (result?.ok) return Object.keys(splitRules(rules).kernel).length ? 'normalized' : 'clean';
  if (Object.entries(phases).some(([phase, n]) => n && AFTER_BUILD.has(phase))) return 'afterBuild';
  if (result?.verifyRan === true) return 'afterBuild';
  return 'beforeBuild';
}

/**
 * The discovery index the check's refusal guidance reads (job-guidance.mjs), built once per release and kept under the
 * lane's .local/discovery: built here before the corpora, so no corpus pays it for its place in the order. Measured on
 * 24/10/2026: about 50 s cold, a cache read afterwards.
 */
export async function warmDiscoveryIndex(lane) {
  const start = process.hrtime.bigint();
  const { cache } = await buildIndex(lane, { sources: laneSources(lane, { studio: { connection: () => null } }) });
  return { lane, ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6), cached: cache?.hit === true };
}

/** One corpus on one lane: compose ssam_code {action:"check"}, run it and measure it. */
export async function benchCorpus(corpus, lane, { dir, base = BASES[lane] } = {}) {
  const files = corpusFiles(corpus);
  const call = { tool: 'ssam_code', arguments: { action: 'check', lane, module: corpus.module, base, files } };
  const calls = [];
  const deps = benchDeps(lane, dir, calls);
  const start = process.hrtime.bigint();
  const result = await codeCheck({ ...call.arguments }, deps);
  const facadeWallMs = Number(process.hrtime.bigint() - start) / 1e6;
  const kernelWallMs = calls.reduce((sum, c) => sum + c.wallMs, 0);
  const kernelElapsedMs = calls.some(c => c.elapsedMs != null) ? calls.reduce((sum, c) => sum + (c.elapsedMs ?? 0), 0) : null;
  const timings = calls.find(c => c.timings)?.timings ?? null;
  const phases = problemsByPhase(result), rules = normalizationsByRule(result);
  return {
    corpus: corpus.id, label: corpus.label, lane, base: path.relative(WORKSPACE, base).replace(/\\/g, '/'), call,
    ...measureText(files),
    facadeWallMs: Math.round(facadeWallMs), checkWallMs: result.wallMs ?? null, kernelWallMs: Math.round(kernelWallMs), kernelElapsedMs,
    // What the facade adds around the kernel processes it waited for (write of the job, guidance, answer).
    facadeOnlyMs: Math.round(facadeWallMs - kernelWallMs), kernelCalls: calls.map(c => ({ command: c.command, wallMs: Math.round(c.wallMs), elapsedMs: c.elapsedMs })),
    timings: timings && { totalMs: timings.totalMs ?? null, loadMs: timings.loadMs ?? null, normalizeMs: timings.normalizeMs ?? null, baseCheckMs: timings.baseCheckMs ?? null,
      scopeMs: timings.scopeMs ?? null, applyMs: timings.applyMs ?? null, verifyAfterMs: timings.verifyAfterMs ?? null, saveMs: timings.saveMs ?? null },
    ok: result.ok === true, code: result.ok ? null : result.code ?? null, refusalCode: result.refusalCode ?? null, verifyRan: result.verifyRan ?? null,
    phases, normalizations: splitRules(rules).kernel, facadeNotes: splitRules(rules).facade,
    normalizationsTotal: Object.values(splitRules(rules).kernel).reduce((a, b) => a + b, 0),
    problems: (result.problems ?? []).map(p => ({ code: p.code, phase: p.phase ?? null, ...(p.rule ? { rule: p.rule } : {}), message: String(p.message ?? p.error ?? '').slice(0, 300),
      ...(p.origin?.action ? { action: p.origin.action } : {}) })),
    verdict: verdictOf(result, phases, rules),
  };
}
