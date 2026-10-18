// Continuations and runtime guides (lane Z): every refusal points to an MCP tool of plan §4.2 with that tool's own
// argument names, the guides speak only of MCP tools, and no text the release answers names a shell command.
//
// The scan looks for the eight patterns of the plan (python, .ps1, pwsh, dotnet build, ssam connect, odc attach,
// cdp_pages, --credentials) and for four more that the plan's own sites need (a .py script, an ssam, odc or anvil CLI
// verb: kernel-delivery.mjs:18, module-map.mjs:292, discovery.mjs:80-81, FunctionCatalog.cs:129). All twelve fail the
// texts of lane Z and the C# mirror; over the paths given (the release) only the plan's eight fail, the other four are
// reported as diagnostics. Text files are read whole; binary files (a NUL in the first 8 KB: DLLs, V8 bytecode) by
// their printable strings, ASCII and UTF-16LE at both byte alignments (the .NET #US heap). The patterns live only
// here, never in a bundled module.
//
// Parameters (`node --test` passes no arguments: use the environment, or the flags when the file runs directly):
//   SSAM_SCAN / --scan <path>           files or folders to scan as well, separated by ';' (wave 4: the release bundle
//                                       app\ and the release DLLs bin\ and studio\; not runtime\, which is Microsoft's
//                                       and the Node project's)
//   SSAM_SCAN_ALLOW / --allow <file>    JSON array of strings; a finding whose context contains one is allowed
//   SSAM_STAGE / --stage <folder>       a release staging; McpContinuations.cs (lane S) is read there, else from the
//                                       overlay scripts/release/overlay/kernel/src/Anvil.Core/Kernel/ of this repository
//   SSAM_RESPONSES / --responses <file> responses.mjs of the front "MCP completo e velocidade" (default: the one in this
//                                       repository, once merged)
import '../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTINUATIONS, KERNEL_CODES, LANE_CONTINUATIONS, MCP_TOOLS, PACKAGE_CODES, SAME_TOOL, WORDS, callText, continuationFor, formatCall } from '../facade/continuations.mjs';
import { GUIDES, GUIDE_FILES, guideIndex, guideText, readGuide } from '../facade/runtime-guides.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const flag = name => { const out = []; for (let i = 0; i < process.argv.length - 1; i++) if (process.argv[i] === name) out.push(process.argv[i + 1]); return out; };
const listOf = value => (value ?? '').split(';').map(s => s.trim()).filter(Boolean);
const SCAN = [...flag('--scan'), ...listOf(process.env.SSAM_SCAN)];
const ALLOW_FILE = flag('--allow')[0] ?? process.env.SSAM_SCAN_ALLOW ?? null;
const STAGE = flag('--stage')[0] ?? process.env.SSAM_STAGE ?? null;
const RESPONSES = flag('--responses')[0] ?? process.env.SSAM_RESPONSES ?? path.join(repo, 'platforms', 'odc', 'facade', 'responses.mjs');
const MIRROR = 'kernel/src/Anvil.Core/Kernel/McpContinuations.cs';

// ---- the scan
const FORBIDDEN = [
  ['python', /python/gi],
  ['.ps1', /\.ps1\b/gi],
  ['pwsh', /\bpwsh\b/gi],
  ['dotnet build', /\bdotnet\s+build\b/gi],
  ['ssam connect', /\bssam(?:\.cmd)?\s+connect\b/g], // the tool ssam_connect is not the command
  ['odc attach', /\bodc(?:\.cmd)?\s+attach\b/g],     // lower case: the command, not "ODC attach" in a sentence
  ['cdp_pages', /cdp_pages/gi],
  ['--credentials', /--credentials\b/gi],
  // beyond the plan's list: the other CLI commands its sites name (lower case: the command, not a sentence)
  ['.py', /\.py\b/gi],
  ['ssam <verb>', /\bssam(?:\.cmd)?\s+(?:inspect|deliver|discover|map|job|app|doctor|setup|debug|package|access|friction|reprove)\b/g],
  ['odc <verb>', /\bodc(?:\.cmd)?\s+(?:deliver|inspect|discover|app|build|studio|portal|doctor)\b/g],
  ['anvil <verb>', /\banvil(?:\.dll)?\s+(?:functions|api|signature|inspect|deliver|job|serve|types|recipe|where-can|ui-block|check-job|verify-message)\b/g],
];
const PLAN_PATTERNS = new Set(FORBIDDEN.slice(0, 8).map(([p]) => p));
const PRINTABLE = /[\x20-\x7e\t]{4,}/g;

function scanString(text, where = {}) {
  const findings = [];
  for (const [pattern, regex] of FORBIDDEN) {
    regex.lastIndex = 0;
    for (let m = regex.exec(text); m; m = regex.exec(text)) {
      const start = text.lastIndexOf('\n', m.index) + 1; const end = text.indexOf('\n', m.index);
      const line = text.slice(start, end < 0 ? text.length : end).trim();
      findings.push({ ...where, pattern, ...(where.binary ? {} : { line: text.slice(0, m.index).split('\n').length }),
        context: line.length > 200 ? line.slice(Math.max(0, m.index - start - 80), m.index - start + 120) : line });
    }
  }
  return findings;
}
function scanFile(file) {
  const buffer = fs.readFileSync(file);
  if (!buffer.subarray(0, 8192).includes(0)) return scanString(buffer.toString('utf8'), { file });
  const strings = [buffer.toString('latin1'), buffer.toString('utf16le'), buffer.subarray(1).toString('utf16le')]
    .flatMap(t => t.match(PRINTABLE) ?? []);
  return strings.flatMap(s => scanString(s, { file, binary: true }));
}
const filesUnder = target => (fs.statSync(target).isDirectory()
  ? fs.readdirSync(target, { withFileTypes: true }).flatMap(e => filesUnder(path.join(target, e.name))) : [target]);
function scanPaths(targets, allow = []) {
  const files = targets.flatMap(filesUnder);
  const findings = files.flatMap(scanFile).filter(f => !allow.some(a => f.context.includes(a)));
  return { files: files.length, findings };
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-z-'));

// ---- the arguments of each tool a continuation may name (plan §4.2 and the tools' own schemas)
const LANE = ['o11', 'odc'];
const KINDS = ['o11-service-center', 'o11-lifetime', 'o11-debugger', 'o11-db-connection', 'o11-site-property', 'odc-api-client',
  'odc-portal', 'odc-db', 'odc-setting'];
const SPEC = {
  ssam_status: {},
  ssam_doctor: { lane: LANE, checks: ['install', 'license', 'license-gates', 'runtimes', 'signatures', 'studios', 'compat', 'ports',
    'authority', 'vault', 'clients', 'workers'], compat: null },
  ssam_license: { action: ['status', 'activate', 'renew', 'deactivate'], authorize: null },
  ssam_setup: { action: ['plan', 'apply', 'register', 'unregister', 'app-profile'], ports: null, authorityDir: null, defaultTenant: null,
    clients: ['claude-code', 'claude-desktop'], serverName: null, replace: null, enable: null, authorize: null },
  ssam_update: { action: ['check', 'install', 'rollback', 'prune'], source: null, dryRun: null, authorize: null },
  ssam_credentials: { action: ['status', 'prompt', 'forget'], kind: KINDS, host: null, name: null, authorize: null },
  ssam_task: { id: null },
  ssam_connect: { lane: LANE, pid: null, dryRun: null, coexistLegacy: null, authorize: null },
  ssam_discover: { intent: null, lane: LANE, expand: null },
  ssam_reference: { lane: LANE, kind: ['api', 'functions', 'ui-block', 'types', 'where-can', 'recipe', 'check-job', 'check-delivery',
    'verify-message'], query: null },
  ssam_job: { job: null, lane: LANE, base: null, out: null, producers: null, captureProducers: null },
  hybrid_tenants: {},
  o11_inspect: { oml: null, path: null, select: null, kind: null, name: null, text: null, offset: null, properties: null, usages: null,
    depth: null, max: null, budget: null, expectedSourceSha256: null },
  o11_deliver: { module: null, job: null, checks: null, until: ['snapshot', 'apply', 'preview', 'merge'], pid: null, authorize: null },
  // MODULE_TAB_NOT_CLOSABLE (close-module): the publish saves the module, then the tab closes (o11-publish.mjs publishSchema).
  o11_publish: { module: null, authorize: null, message: null, timeoutSeconds: null },
  o11_environment: { action: ['inventory', 'download', 'download-app', 'templates', 'create-app', 'add-modules', 'create-module',
    'update-app', 'refresh-refs', 'set-user-provider', 'delete-app'], host: null, module: null },
  // the tools the codes of the 2026-10-06 package name (docs/PACOTE-ATRITOS-2.md section 5.3)
  ssam_evidence: { file: null, pointer: null, select: null, where: null, fields: null, deep: null, depth: null, groupBy: null, offset: null, max: null, budgetBytes: null },
  ssam_map: { lane: LANE, target: null, kind: null, name: null, prefix: null, role: null, parent: null, key: null, offset: null, max: null, budgetBytes: null,
    includeDetail: null, expectedSourceSha256: null, pid: null },
  o11_dependencies: { action: ['producers', 'list', 'capture', 'inspect', 'help'], producer: null, key: null, producerKind: ['Extension', 'eSpace'], elements: null,
    out: null, oml: null, offset: null, limit: null, expectedSignatureHash: null },
  studio_status: { view: null, pid: null },
  // refresh-references (C26 of the 2026-10-06 package) is the continuation of PUBLISH_BLOCKED_BY_DIALOG (atritos 3, 5.3).
  o11_studio: { command: ['status', 'wait', 'open-module', 'snapshot', 'errors', 'windows', 'dismiss-dialog', 'login', 'refresh-references'], args: null },
  studio_attach: { pid: null },
  studio_wait: { condition: ['idle', 'no-dialogs', 'published', 'open'], module: null, timeoutSeconds: null, pid: null },
  // MODULE_NOT_OPEN: a module name no open module has (studio-module.mjs) opens it from the organization.
  studio_open: { module: null, localOml: null, pid: null },
  studio_dismiss_dialog: { caption: null, action: null, pid: null },
  odc_portal_login: { tenant: null, auth: ['auto', 'studio', 'portal-credential'], action: ['open', 'status', 'close', 'select-profile', 'prompt', 'focus'] },
  odc_portal_routes: { tenant: null, module: null, view: null, match: null },
};
// o11_studio args per command (the strict shapes of the o11_studio tool)
const O11_STUDIO_ARGS = { status: {}, wait: { condition: ['idle', 'no-dialogs', 'open', 'signed-in'], module: null, host: null, timeoutSeconds: null },
  'open-module': { name: null, app: null, environment: null, moduleKey: null, timeoutSeconds: null }, snapshot: { module: null, path: null },
  errors: { max: null, since: null }, windows: { maxTexts: null }, 'dismiss-dialog': { title: null, type: null }, login: { host: null, timeoutSeconds: null } };

const placeholder = v => typeof v === 'string' && /<[^<>]+>/.test(v);
function argumentProblems(where, args, spec) {
  const problems = [];
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(spec, key)) { problems.push(where + ': unknown argument ' + key); continue; }
    if (key === 'authorize') { if (value !== WORDS) problems.push(where + ': authorize must be the placeholder of the user\'s words'); continue; }
    const allowed = spec[key];
    if (!allowed) continue;
    for (const v of Array.isArray(value) ? value : [value]) if (!placeholder(v) && !allowed.includes(v)) problems.push(where + ': ' + key + ' ' + JSON.stringify(v) + ' is not one of ' + allowed.join('|'));
  }
  return problems;
}

// 79 tools of plan §4.2, the two GitSSAM integrations (o11_extension, odc_external_library), ssam_debug, and the live tools
// the guides and the continuations of the 2026-10-06 package name (ssam_grant, ssam_evidence, o11_publish),
// studio_reference_producers of the SC/Portal line (port of 2026-10-11) and ssam_code (the module as code, 2026-10-12).
test('MCP_TOOLS is the list of plan §4.2 plus the live tools the guides and continuations name: 87 tools', () => {
  assert.equal(MCP_TOOLS.length, 87);
  assert.equal(new Set(MCP_TOOLS).size, 87);
  for (const name of ['ssam_grant', 'ssam_evidence', 'o11_publish', 'o11_extension', 'odc_external_library', 'ssam_code']) assert.ok(MCP_TOOLS.includes(name), name);
  for (const name of ['ssam_status', 'ssam_license', 'ssam_setup', 'ssam_update', 'ssam_credentials', 'ssam_reprove', 'ssam_task',
    'ssam_reference', 'o11_inspect', 'o11_deliver', 'o11_environment', 'o11_studio', 'odc_portal_routes']) assert.ok(MCP_TOOLS.includes(name), name);
  assert.equal(MCP_TOOLS.filter(t => t.startsWith('studio_')).length, 30, 'the 28 of the plan, studio_create_app and studio_reference_producers');
  assert.ok(Object.keys(SPEC).every(t => MCP_TOOLS.includes(t)));
});

test('every continuation points to a tool of §4.2, with that tool\'s argument names', () => {
  const problems = [];
  const entries = [...Object.entries(CONTINUATIONS), ...Object.entries(LANE_CONTINUATIONS).flatMap(([lane, table]) => Object.entries(table).map(([code, next]) => [lane + ':' + code, next]))];
  for (const [code, next] of entries) {
    if (!/^(?:(?:o11|odc):)?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(code)) problems.push(code + ': code is not UPPER_SNAKE');
    assert.deepEqual(Object.keys(next), ['tool', 'arguments', 'why'], code);
    // The refused call itself (corrected or repeated): placeholders only, filled by continuationFor from {tool, arguments}.
    if (next.tool === SAME_TOOL) { if (!Object.values(next.arguments).every(v => typeof v === 'string' && /^<[^<>]+>$/.test(v))) problems.push(code + ': the same call takes placeholders only'); continue; }
    if (!MCP_TOOLS.includes(next.tool)) { problems.push(code + ': ' + next.tool + ' is not a tool of §4.2'); continue; }
    if (!SPEC[next.tool]) { problems.push(code + ': no argument spec for ' + next.tool + ' in this test'); continue; }
    if (typeof next.why !== 'string' || next.why.length < 10 || next.why.length > 300) problems.push(code + ': why must be a short sentence');
    problems.push(...argumentProblems(code, next.arguments, SPEC[next.tool]));
    if (next.tool === 'o11_studio') {
      const shape = O11_STUDIO_ARGS[next.arguments.command];
      if (shape && next.arguments.args) problems.push(...argumentProblems(code + ' args', next.arguments.args, shape));
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(Object.isFrozen(CONTINUATIONS) && Object.isFrozen(CONTINUATIONS.DIALOG_OPEN.arguments.args));
});

test('the table covers each kind of refusal of the plan', () => {
  for (const code of ['LICENSE_NOT_ACTIVATED', 'LICENSE_EXPIRED', 'LICENSE_REVOKED', 'LICENSE_CLOCK_INVALID', 'LICENSE_INSTALLATION_MISMATCH',
    'LICENSE_RELEASE_TOO_OLD', 'SETUP_REQUIRED', 'STUDIO_NOT_CONNECTED', 'STUDIO_NOT_OPEN', 'CREDENTIAL_MISSING', 'CREDENTIAL_PROMPT_OPENED',
    'UPDATE_AVAILABLE', 'RECONNECT_REQUIRED', 'INCOMPATIBLE_STUDIO', 'DIALOG_OPEN', 'DIALOG_WEB', 'COMPONENT_MISSING']) assert.ok(CONTINUATIONS[code], code);
  // LICENCA.md §7: the next call of each license state
  assert.deepEqual(continuationFor('LICENSE_NOT_ACTIVATED').arguments, { action: 'activate' });
  assert.deepEqual(continuationFor('LICENSE_REVOKED').arguments, { action: 'status' });
  assert.deepEqual(continuationFor('LICENSE_EXPIRED').arguments, { action: 'renew' });
  assert.equal(continuationFor('LICENSE_RELEASE_TOO_OLD').tool, 'ssam_update');
});

test('no continuation, call or reason names a shell command', () => {
  const texts = Object.keys(CONTINUATIONS).flatMap(code => [JSON.stringify(CONTINUATIONS[code]), callText(code)]);
  assert.deepEqual(texts.flatMap(t => scanString(t)), []);
});

test('continuationFor fills placeholders by argument name and never the user\'s words', () => {
  assert.equal(continuationFor('NOT_A_CODE'), null);
  assert.equal(callText('NOT_A_CODE'), null);
  assert.deepEqual(continuationFor('STUDIO_NOT_CONNECTED', { lane: 'odc' }), { tool: 'ssam_connect', arguments: { lane: 'odc' }, why: CONTINUATIONS.STUDIO_NOT_CONNECTED.why });
  assert.deepEqual(continuationFor('STUDIO_NOT_CONNECTED').arguments, { lane: '<lane>' }, 'without a value the placeholder stays');
  assert.deepEqual(continuationFor('SEVERAL_STUDIOS', { lane: 'o11', pid: 4242 }).arguments, { lane: 'o11', pid: 4242 });
  assert.deepEqual(continuationFor('DIALOG_OPEN', { title: 'Save changes?' }).arguments, { command: 'dismiss-dialog', args: { title: 'Save changes?' } });
  assert.deepEqual(continuationFor('O11_DELIVER', { module: 'Orders', checks: ['a', 'b'], authorize: 'sim, pode entregar' }).arguments,
    { module: 'Orders', job: '<job.json>', checks: ['a', 'b'], authorize: WORDS });
  assert.deepEqual(continuationFor('LEGACY_BRIDGE_LOADED', { lane: 'o11', coexistLegacy: false, authorize: 'x' }).arguments,
    { lane: 'o11', coexistLegacy: true, authorize: WORDS }, 'fixed values and the words never change');
  assert.deepEqual(continuationFor('LICENSE_NOT_ACTIVATED', { action: 'status' }).arguments, { action: 'activate' });
  const copy = continuationFor('DIALOG_OPEN'); copy.arguments.args.title = 'changed';
  assert.equal(CONTINUATIONS.DIALOG_OPEN.arguments.args.title, '<dialog title>', 'a continuation is a copy');
});

test('the refusal codes of the 2026-10-06 package carry the continuation of its section 5.3, outside KERNEL_CODES', () => {
  const expected = {
    DISCOVERY_INDEX_INVALID: 'ssam_doctor {}', DATA_PROOF_DIFFERS: 'ssam_evidence {file:"<task>/result.json", pointer:"/dataProof/differences"}',
    PRODUCER_SIGNATURE_MISSING: 'o11_dependencies {action:"list", producer:"<producer>"}', STUDIO_WRITE_QUEUE_TIMEOUT: 'o11_studio {command:"status"}',
    SYSTEM_MODULE_NOT_OPENABLE: 'ssam_map {lane:"o11", target:"<module>"}', DOCTOR_LANE_UNUSABLE: 'ssam_connect {lane:"<lane>"}', RELEASE_CHANGED: 'ssam_doctor {}',
    WRONG_SERVER: 'ssam_doctor {}', TOOL_CATALOG_STALE: 'ssam_doctor {}', MODULE_RESERVED: 'ssam_task {id:"<id>"}', MODULE_RESERVED_FOREIGN: 'ssam_doctor {lane:"o11"}',
    BLANK_UI_MODULE: 'o11_environment {action:"<action>"}',
  };
  for (const [code, call] of Object.entries(expected)) assert.equal(callText(code), call, code);
  for (const code of PACKAGE_CODES) { assert.ok(CONTINUATIONS[code], code); assert.ok(!KERNEL_CODES.includes(code), code + ' needs no C# mirror'); }
  // per lane: the O11 module that is not open is downloaded, the ODC one opened; the ODC queue reads studio_status
  assert.equal(callText('MODULE_NOT_OPEN', { lane: 'o11', module: 'Users' }), 'o11_environment {action:"download", module:"Users"}');
  assert.equal(callText('MODULE_NOT_OPEN', { lane: 'odc', module: 'Quiz' }), 'studio_open {module:"Quiz"}');
  assert.equal(callText('STUDIO_WRITE_QUEUE_TIMEOUT', { lane: 'odc' }), 'studio_status {}');
  assert.equal(callText('DOCTOR_LANE_UNUSABLE', { lane: 'odc' }), 'ssam_connect {lane:"odc"}');
  // the same tool: from the refused call (corrected arguments), never with the user's words
  assert.equal(CONTINUATIONS.INPUT_INVALID.tool, SAME_TOOL);
  assert.deepEqual(continuationFor('INPUT_INVALID', { tool: 'ssam_discover', arguments: { intent: 'x', budgetBytes: 4096 } }),
    { tool: 'ssam_discover', arguments: { intent: 'x', budgetBytes: 4096 }, why: CONTINUATIONS.INPUT_INVALID.why });
  assert.equal(continuationFor('CREDENTIAL_PROMPT_PENDING', { tool: 'o11_access', arguments: { action: 'users', words: 'pode ler' } }).arguments.words, WORDS);
  assert.equal(continuationFor('INPUT_INVALID').tool, SAME_TOOL, 'without the call the marker stays');
  assert.equal(callText('INPUT_INVALID'), SAME_TOOL + ' {<arguments>:"<corrected>"}');
});

test('formatCall writes the notation of the tool descriptions (the same as responses.mjs)', () => {
  assert.equal(callText('DIALOG_OPEN'), 'o11_studio {command:"dismiss-dialog", args:{title:"<dialog title>"}}');
  assert.equal(callText('COMPONENT_MISSING', { lane: 'odc' }), 'ssam_doctor {lane:"odc"}');
  assert.equal(callText('STUDIO_NOT_OPEN'), 'ssam_status {}');
  assert.equal(callText('INCOMPATIBLE_STUDIO', { lane: 'o11' }), 'ssam_doctor {lane:"o11", checks:["compat"]}');
  assert.equal(callText('RELEASE_IN_USE'), 'ssam_update {action:"prune", dryRun:true}');
  assert.equal(formatCall('o11_studio', { command: 'wait', args: { condition: 'no-dialogs' } }), 'o11_studio {command:"wait", args:{condition:"no-dialogs"}}');
  assert.equal(formatCall('x', { a: undefined, b: 1, c: { d: true } }), 'x {b:1, c:{d}}');
});

test('KERNEL_CODES are codes of the table with a fixed lane (lane S writes them as constants)', () => {
  for (const code of KERNEL_CODES) {
    assert.ok(CONTINUATIONS[code], code);
    assert.ok(!JSON.stringify(CONTINUATIONS[code].arguments).includes('<lane>'), code + ' needs a fixed lane in C#');
  }
  assert.equal(new Set(KERNEL_CODES).size, KERNEL_CODES.length);
});

// ---- guides
const TOOL_CALL = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*\{/g;
const TICKED = /`([a-z][a-z0-9_]*)`/g;
function toolsNamed(text) {
  const named = new Set(); const unknown = new Set();
  for (const m of text.matchAll(TOOL_CALL)) (MCP_TOOLS.includes(m[1]) ? named : unknown).add(m[1]);
  for (const m of text.matchAll(TICKED)) if (MCP_TOOLS.includes(m[1])) named.add(m[1]); else if (/^(ssam|o11|odc|studio|hybrid)_/.test(m[1])) unknown.add(m[1]);
  return { named, unknown };
}

test('guides: one ssam://guide resource per topic, in MCP terms only', () => {
  // The topic padroes is standards since 16/10 (English only; 'padroes' stays an input alias of ssam_reference).
  assert.deepEqual(GUIDES.map(g => g.topic), ['lifecycle', 'o11', 'odc', 'refusals', 'rules', 'standards']);
  const all = new Set(); const problems = [];
  for (const g of GUIDES) {
    assert.equal(g.uri, 'ssam://guide/' + g.topic);
    assert.equal(g.name, 'ssam-guide-' + g.topic);
    assert.equal(g.mimeType, 'text/markdown');
    const { contents } = readGuide(g.uri);
    assert.equal(contents.length, 1);
    assert.equal(contents[0].uri, g.uri);
    const text = contents[0].text;
    assert.ok(text.startsWith('# ') && text.length > 500, g.topic);
    const { named, unknown } = toolsNamed(text);
    if (unknown.size) problems.push(g.topic + ' names tools outside §4.2: ' + [...unknown].join(', '));
    for (const t of named) all.add(t);
    problems.push(...scanString(text, { file: g.uri }).map(f => g.topic + ': ' + f.pattern + ' in "' + f.context + '"'));
    assert.ok(guideIndex().includes(g.uri));
  }
  assert.deepEqual(problems, []);
  assert.deepEqual(MCP_TOOLS.filter(t => !all.has(t)), [], 'every tool of §4.2 appears in some guide');
  const refusals = guideText('refusals');
  for (const code of Object.keys(CONTINUATIONS)) assert.ok(refusals.includes('`' + code + '`'), code);
  assert.throws(() => readGuide('ssam://guide/none'), /Unknown SSAM guide resource/);
  assert.throws(() => guideText('none'), /Unknown SSAM guide/);
  for (const [topic, file] of Object.entries(GUIDE_FILES)) assert.ok(fs.existsSync(path.join(repo, file)), topic);
});

test('in a release the guides come only from the bundle (SSAM_GUIDES), never from a file', async () => {
  assert.throws(() => guideText('o11', { release: true }), /release layout/);
  globalThis.SSAM_GUIDES = { lifecycle: '# lifecycle', o11: '# o11', odc: '# odc' };
  try {
    const bundled = await import(new URL('../facade/runtime-guides.mjs?bundled', import.meta.url).href);
    assert.equal(bundled.guideText('o11', { release: true }), '# o11');
    assert.equal(bundled.readGuide('ssam://guide/lifecycle').contents[0].text, '# lifecycle');
    assert.ok(bundled.guideText('refusals').includes('`LICENSE_REVOKED`'));
    delete globalThis.SSAM_GUIDES.odc;
    assert.throws(() => bundled.guideText('odc'), /missing from the bundle/);
  } finally { delete globalThis.SSAM_GUIDES; }
});

// ---- the scan, on fixtures
test('the scan finds each pattern in a text and in the strings of a binary (fixtures)', () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'clean.md'), [
      'Call ssam_connect {lane:"o11"}, then studio_attach {} and ssam_credentials {action:"prompt", kind:"odc-portal", host}.',
      'The ODC attach failed; credentials stay in the vault; dotnet is private; build nothing; ps1 is not a file here.',
      'The SSAM map and the ODC build are ready; Anvil api docs; ssam_map, odc_portal_routes and ssam_reference; a file.pyc.',
    ].join('\n'));
    const dirtyLines = [['python', 'run python here'], ['pwsh', 'pwsh -File x'], ['.ps1', 'windows-o11-credential.ps1 -Mode bootstrap'],
      ['dotnet build', 'dotnet  build src/Anvil.Cli'], ['ssam connect', '.\\ssam connect --lane o11'], ['odc attach', 'then odc attach'],
      ['cdp_pages', 'see cdp_pages'], ['--credentials', 'use --credentials'], ['.py', 'run scripts/build_odc.py in the root'],
      ['ssam <verb>', 'then .\\ssam inspect --lane o11'], ['odc <verb>', 'odc.cmd deliver X'], ['anvil <verb>', 'anvil.dll functions --find data']];
    fs.writeFileSync(path.join(dir, 'dirty.md'), dirtyLines.map(([, line]) => line).join('\n'));
    const utf16 = Buffer.from('then pwsh -NoProfile', 'utf16le');
    fs.writeFileSync(path.join(dir, 'fake.dll'), Buffer.concat([Buffer.from([0x4d, 0x5a, 0, 0, 1, 2, 0, 7]), Buffer.from([0x23]), utf16,
      Buffer.from([0, 0, 0]), Buffer.from('rebuild: dotnet build x', 'latin1'), Buffer.from([0, 0])]));
    fs.mkdirSync(path.join(dir, 'nested', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'nested', 'deeper', 'app.jsc'), Buffer.concat([Buffer.from([0, 1, 0, 2]), Buffer.from('cdp_pages.click', 'latin1'), Buffer.from([0])]));

    assert.deepEqual(scanPaths([path.join(dir, 'clean.md')]).findings, []);
    const dirty = scanPaths([path.join(dir, 'dirty.md')]).findings.sort((a, b) => a.line - b.line);
    assert.deepEqual(dirty.map(f => f.line + ' ' + f.pattern), dirtyLines.map(([pattern], i) => (i + 1) + ' ' + pattern), 'one finding per line');
    assert.deepEqual(FORBIDDEN.map(([p]) => p).sort(), dirtyLines.map(([p]) => p).sort(), 'every pattern has its line');
    assert.deepEqual([...PLAN_PATTERNS], ['python', '.ps1', 'pwsh', 'dotnet build', 'ssam connect', 'odc attach', 'cdp_pages', '--credentials']);
    const all = scanPaths([dir]);
    assert.equal(all.files, 4);
    const binary = all.findings.filter(f => f.binary).map(f => path.basename(f.file) + ':' + f.pattern).sort();
    assert.deepEqual(binary, ['app.jsc:cdp_pages', 'fake.dll:dotnet build', 'fake.dll:pwsh']);
    const allowed = scanPaths([path.join(dir, 'fake.dll')], ['then pwsh -NoProfile']).findings.map(f => f.pattern);
    assert.deepEqual(allowed, ['dotnet build']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the scan passes over the files of lane Z and what they render', () => {
  const dir = tempDir();
  try {
    const own = ['platforms/odc/facade/continuations.mjs', 'platforms/odc/facade/runtime-guides.mjs', ...Object.values(GUIDE_FILES)].map(f => path.join(repo, f));
    fs.writeFileSync(path.join(dir, 'continuations.json'), JSON.stringify({ table: CONTINUATIONS, calls: Object.keys(CONTINUATIONS).map(c => callText(c)) }, null, 1));
    for (const g of GUIDES) fs.writeFileSync(path.join(dir, g.topic + '.md'), guideText(g.topic));
    fs.writeFileSync(path.join(dir, 'index.txt'), guideIndex());
    const { files, findings } = scanPaths([...own, dir]);
    assert.equal(files, own.length + GUIDES.length + 2);
    assert.deepEqual(findings, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the scan passes over the paths given (SSAM_SCAN / --scan)', t => {
  if (!SCAN.length) { t.skip('no SSAM_SCAN: wave 4 points it at the release bundle (app\\) and the release DLLs (bin\\, studio\\)'); return; }
  const allow = ALLOW_FILE ? JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')) : [];
  assert.ok(Array.isArray(allow) && allow.every(a => typeof a === 'string' && a.length >= 8), 'the allow file is a JSON array of strings (8+ chars)');
  const { files, findings } = scanPaths(SCAN.map(p => path.resolve(p)), allow);
  t.diagnostic(files + ' files scanned' + (allow.length ? ', ' + allow.length + ' allowed contexts' : ''));
  for (const f of findings.filter(x => !PLAN_PATTERNS.has(x.pattern))) t.diagnostic('beyond the plan: ' + f.pattern + ' in ' + f.file + ': ' + f.context);
  assert.ok(files > 0, 'nothing to scan in ' + SCAN.join('; '));
  assert.deepEqual(findings.filter(x => PLAN_PATTERNS.has(x.pattern)), []);
});

// ---- McpContinuations.cs (lane S, wave 2): every constant mirrors a code of the table
function csharpLiteral(s, i) {
  if (s.startsWith('"""', i)) {
    let q = 3; while (s[i + q] === '"') q++;
    const end = s.indexOf('"'.repeat(q), i + q);
    if (end < 0) return null;
    let body = s.slice(i + q, end);
    if (body.includes('\n')) { const lines = body.split(/\r?\n/); const indent = lines.pop().length; lines.shift(); body = lines.map(l => l.slice(indent)).join('\n'); }
    return { value: body, end: end + q };
  }
  if (s[i] === '@' && s[i + 1] === '"') {
    let v = '';
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] !== '"') { v += s[j]; continue; }
      if (s[j + 1] === '"') { v += '"'; j++; continue; }
      return { value: v, end: j + 1 };
    }
    return null;
  }
  if (s[i] !== '"') return null;
  const escapes = { n: '\n', r: '\r', t: '\t', 0: '\0', '\\': '\\', '"': '"', "'": "'" };
  let v = '';
  for (let j = i + 1; j < s.length;) {
    const ch = s[j];
    if (ch === '\n') return null;
    if (ch === '"') return { value: v, end: j + 1 };
    if (ch !== '\\') { v += ch; j++; continue; }
    const next = s[j + 1];
    if (next === 'u') { v += String.fromCharCode(Number.parseInt(s.slice(j + 2, j + 6), 16)); j += 6; continue; }
    if (!Object.hasOwn(escapes, next)) return null;
    v += escapes[next]; j += 2;
  }
  return null;
}
function csharpConstants(source) {
  const constants = []; const problems = [];
  const head = /\bconst\s+string\s+([A-Za-z_]\w*)\s*=/g;
  for (let m = head.exec(source); m; m = head.exec(source)) {
    let i = m.index + m[0].length; let value = ''; let done = false;
    for (;;) {
      while (/\s/.test(source[i] ?? '')) i++;
      const literal = csharpLiteral(source, i);
      if (!literal) break;
      value += literal.value; i = literal.end;
      while (/\s/.test(source[i] ?? '')) i++;
      if (source[i] === '+') { i++; continue; }
      done = source[i] === ';';
      break;
    }
    if (done) constants.push({ name: m[1], value }); else problems.push(m[1] + ': not a plain string literal (literals and + only)');
  }
  return { constants, problems };
}
const pascal = code => code.split('_').map(p => p[0] + p.slice(1).toLowerCase()).join('');
function mirrorProblems(source) {
  const { constants, problems } = csharpConstants(source);
  const codeOf = new Map(Object.keys(CONTINUATIONS).map(code => [pascal(code), code]));
  const seen = new Set();
  for (const { name, value } of constants) {
    if (seen.has(name)) problems.push(name + ': defined twice');
    seen.add(name);
    const call = codeOf.get(name); const why = !call && name.endsWith('Why') ? codeOf.get(name.slice(0, -3)) : undefined;
    if (!call && !why) { problems.push(name + ': no code of continuations.mjs has this name'); continue; }
    const expected = call ? callText(call) : CONTINUATIONS[why].why;
    if (value !== expected) problems.push(name + ': ' + JSON.stringify(value) + ' is not ' + JSON.stringify(expected));
    for (const f of scanString(value)) problems.push(name + ': names ' + f.pattern);
  }
  for (const code of KERNEL_CODES) if (!seen.has(pascal(code))) problems.push(pascal(code) + ': missing (' + code + ')');
  return problems;
}
const csharpFile = entries => 'namespace Anvil.Core.Kernel;\n\ninternal static class McpContinuations\n{\n'
  + entries.map(([name, literal]) => '    public const string ' + name + ' = ' + literal + ';\n').join('') + '}\n';

test('the mirror check of McpContinuations.cs works (synthetic C#)', () => {
  const good = KERNEL_CODES.map(code => [pascal(code), JSON.stringify(callText(code))]);
  assert.equal(pascal('O11_SC_SECRET_NOT_FOUND'), 'O11ScSecretNotFound');
  assert.deepEqual(mirrorProblems(csharpFile(good)), []);
  const call = callText('DIALOG_WEB'); const half = Math.floor(call.length / 2);
  const variants = csharpFile([
    ...good.filter(([n]) => n !== 'DialogWeb' && n !== 'FunctionsLookup' && n !== 'DialogOpen'),
    ['DialogWeb', JSON.stringify(call.slice(0, half)) + '\n        + ' + '@"' + call.slice(half).replace(/"/g, '""') + '"'],
    ['DialogWebWhy', JSON.stringify(CONTINUATIONS.DIALOG_WEB.why)],
    ['DialogOpen', '"""' + callText('DIALOG_OPEN') + '"""'],
    ['LicenseRevoked', JSON.stringify(callText('LICENSE_REVOKED'))],
  ]);
  assert.deepEqual(mirrorProblems(variants), ['FunctionsLookup: missing (FUNCTIONS_LOOKUP)'], 'concatenation, verbatim and raw literals; optional extra codes');
  const bad = csharpFile([...good.filter(([n]) => n !== 'DialogRecovery'),
    ['DialogRecovery', JSON.stringify('o11_studio {command:"windows"}')], ['Helper', '"x"'], ['Composed', 'Helper + "y"'],
    ['O11ScSecretNotFoundWhy', JSON.stringify('use pwsh -File x')]]);
  const problems = mirrorProblems(bad);
  assert.ok(problems.some(p => p.startsWith('DialogRecovery: ')), problems.join('\n'));
  assert.ok(problems.includes('Helper: no code of continuations.mjs has this name'));
  assert.ok(problems.includes('Composed: not a plain string literal (literals and + only)'));
  assert.ok(problems.includes('O11ScSecretNotFoundWhy: names pwsh'));
});

test('McpContinuations.cs of lane S mirrors this table', t => {
  const file = STAGE ? path.join(path.resolve(STAGE), ...MIRROR.split('/')) : path.join(repo, 'scripts', 'release', 'overlay', ...MIRROR.split('/'));
  if (!fs.existsSync(file)) { t.skip('McpContinuations.cs not found (' + file + '): lane S writes it in wave 2; the comparison then runs here'); return; }
  assert.deepEqual(mirrorProblems(fs.readFileSync(file, 'utf8')), [], file);
});

// ---- responses.mjs of the front "MCP completo e velocidade": the same tool and argument names where both cover a case
const ALIGNED = [
  ['DIALOG_OPEN', 'a dialog is open in the Studio: read it with `windows` or `python scripts/cdp_pages.py`, answer it, and retry', {}],
  ['COMPONENT_MISSING', 'Bridge client is not built: dotnet build studio\\bridge\\client\\Client.csproj -c Release', { lane: 'odc' }],
  ['RUN_JOB', '[o11] python scripts/run_job.py <job.json>: applies a job to a fixture', { lane: 'o11' }],
  ['FUNCTIONS_LOOKUP', 'Consulta rapida: `anvil functions --find data` ou `--name Substr`.', { lane: 'o11' }],
  ['API_CONTRACT', 'see anvil api --name Interface for the contract', { lane: 'o11' }],
  ['O11_INSPECT_BY_KEY', 'O11 ssam inspect --lane o11 --oml <capture> --path @<key> --expectedSourceSha256 <hash>), as its continuations say.', { lane: 'o11' }],
  ['O11_DELIVER', 'Deliver with ssam deliver --lane o11 --module <M> --job <job> --checks <names>', { lane: 'o11' }],
  ['STUDIO_NOT_CONNECTED', 'The selected Studio session is no longer connected. Run ssam connect --lane o11 to select the current Studio.', { lane: 'o11' }],
  ['ODC_STUDIO_NOT_RUNNING', "ODC Studio is not running (no ODCStudio.exe process): open it, sign in to the tenant and run 'odc attach'.", { lane: 'odc' }],
  ['ODC_PORTAL_ROUTES', 'capture it with odc portal internal-routes MyModule --tenant t.outsystems.dev', { lane: 'odc' }],
];
// Plan §4.2 against the choices of that front; the merge of wave 3 decides (lane Z report).
const DIVERGENT = [
  ['O11_SC_SECRET_NOT_FOUND', 'store it with the private prompt (kernel\\scripts\\service_center\\windows-o11-credential.ps1 -Mode bootstrap), then repeat; nothing was sent'],
  ['ODC_API_CLIENT_MISSING', 'Store one locally: pwsh -File portal\\runtime\\windows-api-client-credential.ps1 -Mode bootstrap -Origin https://t.outsystems.dev'],
  ['DIALOG_RECOVERY', 'the Studio recovery dialog (Open | Discard) is open: `python scripts/cdp_pages.py --click Discard` (or Open) and retry'],
];
const shapeOf = next => next.tool + ' ' + JSON.stringify(Object.keys(next.arguments).sort().map(k =>
  next.arguments[k] && typeof next.arguments[k] === 'object' && !Array.isArray(next.arguments[k]) ? k + '{' + Object.keys(next.arguments[k]).sort().join(',') + '}' : k));

test('responses.mjs (front "MCP completo e velocidade") uses the same tool and argument names', async t => {
  if (!fs.existsSync(RESPONSES)) { t.skip('responses.mjs not found (' + RESPONSES + '): it arrives in wave 3; set SSAM_RESPONSES to compare earlier'); return; }
  const { rewriteHints, formatCall: theirFormat } = await import(pathToFileURL(RESPONSES).href);
  const problems = [];
  for (const [code, next] of Object.entries(CONTINUATIONS)) {
    if (theirFormat(next.tool, next.arguments) !== formatCall(next.tool, next.arguments)) problems.push(code + ': formatCall differs');
  }
  for (const [code, text, opts] of ALIGNED) {
    const theirs = rewriteHints({ error: text }, opts).continuations[0];
    if (!theirs) { problems.push(code + ': responses.mjs found no command in ' + JSON.stringify(text)); continue; }
    if (shapeOf(theirs) !== shapeOf(continuationFor(code, opts))) problems.push(code + ': ' + shapeOf(theirs) + ' there, ' + shapeOf(continuationFor(code, opts)) + ' here');
  }
  for (const [code, text] of DIVERGENT) {
    const theirs = rewriteHints({ error: text }).continuations[0];
    t.diagnostic(code + ': here ' + callText(code) + '; there ' + (theirs ? formatCall(theirs.tool, theirs.arguments) : 'none'));
  }
  assert.deepEqual(problems, []);
});
