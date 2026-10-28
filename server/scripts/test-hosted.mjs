// The hosted suite in the two modes a hosted server runs (fase4-28 R1, review item 6 of the 28/10 scenario): without
// SSAM_BACKEND_NAME (one backend, the line's own servers) and with it (the multi-version production server, which names
// each backend). Every hosted test ran only without it, so two regressions of the multi-version server passed: the TEMP of
// the kernel outside the agent mirror and empty hosted telemetry. Modes run sequentially so shared test artifacts do not
// race between modes. Individual test files still run with bounded concurrency.
//
//   node scripts/test-hosted.mjs [--backend <name>] [--only plain|backend] [--sequential] [--root <checkout>] [-- <test files or globs>]
//
// The answer: per mode the counts and the full names of the failing tests, and the failures of the backend mode alone
// (what the backend name breaks). Exit 1 when any test fails in any mode.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOSTED_SUITE = Object.freeze(['platforms/odc/facade/tests/hosted-*.test.mjs', 'platforms/odc/facade/tests/no-internals-*.test.mjs',
  'platforms/odc/facade/tests/english-only-*.test.mjs', 'platforms/odc/facade/tests/listing-naming-rules.test.mjs',
  'platforms/odc/facade/tests/quality-*.test.mjs', 'platforms/odc/facade/tests/discovery*.test.mjs',
  'platforms/odc/facade/tests/context-budget-listing*.test.mjs',
  'platforms/odc/facade/tests/o11-cycle.test.mjs', 'platforms/odc/facade/tests/studio-write-lock.test.mjs',
  'platforms/odc/facade/tests/executor.test.mjs', 'tests/friction*.test.mjs', 'tests/no-internals-friction.test.mjs']);
export const DEFAULT_BACKEND = 'test-backend';

export function parseArguments(argv) {
  const options = { backend: DEFAULT_BACKEND, only: null, sequential: true, root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { options.files.push(...argv.slice(i + 1)); break; }
    if (a === '--sequential') { options.sequential = true; continue; }
    if (!['--backend', '--only', '--root'].includes(a) || argv[i + 1] === undefined) throw new Error('usage: node scripts/test-hosted.mjs [--backend <name>] [--only plain|backend] [--sequential] [--root <checkout>] [-- <tests>]');
    options[a.slice(2)] = argv[++i];
  }
  if (options.only && !['plain', 'backend'].includes(options.only)) throw new Error('--only takes plain or backend');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(options.backend)) throw new Error('--backend takes a backend name (letters, digits, . _ -)');
  options.root = path.resolve(options.root);
  return options;
}

// The test files of the patterns, relative to the root (a * in the file name only), in name order.
export function expand(root, patterns) {
  const files = [];
  for (const pattern of patterns) {
    if (!pattern.includes('*')) { files.push(pattern); continue; }
    const dir = path.dirname(pattern);
    const re = new RegExp('^' + path.basename(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)); } catch { names = []; }
    files.push(...names.filter(n => re.test(n)).sort().map(n => path.join(dir, n)));
  }
  return [...new Set(files)].sort();
}

// The failing tests of a TAP text by their full names (parent > child), only the leaves.
export function failuresOf(tap) {
  const stack = [], failed = []; let passed = 0, skipped = 0;
  for (const line of String(tap).split(/\r?\n/)) {
    const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (sub) { const depth = sub[1].length / 4; stack.length = depth; stack[depth] = sub[2]; continue; }
    const res = /^(\s*)(not ok|ok) \d+ - (.*?)(\s+#\s+(SKIP|TODO).*)?$/.exec(line);
    if (!res) continue;
    const depth = res[1].length / 4;
    const name = [...stack.slice(0, depth), res[3]].join(' > ');
    if (res[5]) skipped++; else if (res[2] === 'ok') passed++; else failed.push(name);
    stack.length = depth;
  }
  return { passed, skipped, failures: failed.filter(f => !failed.some(g => g !== f && g.startsWith(f + ' > '))) };
}

function run(root, files, env, mode) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--test', '--test-concurrency=4', '--test-timeout=180000', '--test-reporter=tap', ...files], { cwd: root, env, windowsHide: true });
    let text = '';
    const log = env.SSAM_TEST_LOG_DIR ? path.join(env.SSAM_TEST_LOG_DIR, mode + '.tap') : null;
    if (log) { fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, ''); }
    const output = d => { text += d; if (log) fs.appendFileSync(log, d); };
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.on('error', error => { output(String(error)); resolve({ exit: 1, ms: Date.now() - started, failures: ['Test runner could not start'], passed: 0, skipped: 0 }); });
    child.on('close', code => resolve({ exit: code, ms: Date.now() - started, ...failuresOf(text) }));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const files = expand(options.root, options.files.length ? options.files : HOSTED_SUITE);
  const plainEnv = { ...process.env }; delete plainEnv.SSAM_BACKEND_NAME;
  const modes = [['plain', plainEnv], ['backend', { ...plainEnv, SSAM_BACKEND_NAME: options.backend }]].filter(([name]) => !options.only || options.only === name);
  const results = {};
  if (options.sequential) for (const [name, env] of modes) results[name] = await run(options.root, files, env, name);
  else await Promise.all(modes.map(async ([name, env]) => { results[name] = await run(options.root, files, env, name); }));
  const onlyBackend = results.plain && results.backend ? results.backend.failures.filter(f => !results.plain.failures.includes(f)) : [];
  const answer = { root: options.root, files: files.length, backend: options.backend, modes: results, ...(results.plain && results.backend ? { onlyWithBackend: onlyBackend } : {}) };
  process.stdout.write(JSON.stringify(answer, null, 1) + '\n');
  return Object.values(results).some(r => r.failures.length || r.exit !== 0) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; }, error => { process.stderr.write(String(error?.message ?? error) + '\n'); process.exitCode = 2; });
