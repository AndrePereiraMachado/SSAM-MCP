// Contextual discovery: intent -> capabilities, exact public operations, extracted contracts, proofs, limits and
// (optionally) application context. Nothing here restates a signature: contracts come from the kernel CLI
// (`api --op`, the same table the dispatcher enforces), proofs from the job suite of the lane and its stamped
// results, native metadata from the reflection index, application context from the existing reader. A small curated
// descriptor (discovery-capabilities.json) maps intent words to those sources and carries only guidance; every
// pointer in it is checked against the extracted sources when the index is built, so the descriptor cannot drift
// silently.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { anvilRoot, odcRoot, o11Lane } from './workspace.mjs';
import { readConnection } from './studio-session.mjs';
import { registryInstallLocation } from './studio-locate.mjs';
import { composeCatalog, applySupersedes, rewriteAliases, keywordProblems, synonymProblems, FRAGMENTS_DIR, STOP, normalize, derived, stem, words, tokens, fold, folded } from './catalog.mjs';
import { isScreenIntent, appTypesFromKinds, appTypesFromIntent, osuiSection, osuiExpansion, osuiCatalogAvailable, namedPatterns, APP_TYPES } from './osui-catalog.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
export const DISCOVERY_SCHEMA = 'ssam-discovery/4';
export const INDEX_SCHEMA = 'ssam-discovery-index/3';
const DESCRIPTOR_FILE = path.join(here, 'discovery-capabilities.json');
const API_OPS = ['agent', 'verbs', 'spec', 'logic', 'screen', 'html', 'html-visual', 'rest', 'rest-expose', 'soap'];
export const DEFAULT_BUDGET_BYTES = 40 * 1024;
export const EXPAND_PARTS = ['contract', 'example', 'evidence', 'bindings', 'native', 'operations'];

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const exists = file => { try { return fs.existsSync(file); } catch { return false; } };
const stamp = file => { try { const s = fs.statSync(file); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return 'absent'; } };
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');

// ---- lanes: where each source lives. Each lane has its own descriptor (routes, lane-specific capabilities) and both
// share discovery-capabilities-shared.json, composed with the catalog fragments (catalog/fragments/<front>/*.json,
// catalog.mjs), whose capabilities are projected per lane at index build.
const SHARED_FILE = path.join(here, 'discovery-capabilities-shared.json');
// The Service Studio the O11 discover answers for is the one the lane's tools use (W3, 2026-10-10). The suite stamps name
// the Studio that ran it (ideVersion, nativeAssemblies); a discover bound to the lane's old copy (Service Studio 11 - Anvil
// 4516, 11.55.87) while the suite ran on the installed Studio (11.55.91) read every result as historical. Order, first
// folder holding ServiceStudio.Framework.dll wins: the selected connection's Studio (studio-session.mjs readConnection, as
// anvil-cli.mjs laneEnvironment), ANVIL_STUDIO_DIR, the installation the registry names (Uninstall "OutSystems Service
// Studio 11", 64-bit then 32-bit view), %ProgramFiles%, and only then the old copy of the lane. Provenance is not
// relaxed: the stamps are compared as before, against this one folder, which every CLI process of the discover binds too.
const O11_MARKER = 'ServiceStudio.Framework.dll';
// The registry read lives behind the executor seam (studio-locate.mjs, servidor/fase4-23): never inside a hosted call.
export { registryInstallLocation };
export function o11StudioDir({ kernel = anvilRoot, laneName = o11Lane.lane, env = process.env, exists: present = file => exists(file), registry = registryInstallLocation, connection = readConnection } = {}) {
  const valid = dir => typeof dir === 'string' && dir !== '' && present(path.join(dir, O11_MARKER));
  const tried = [];
  const attempt = (source, dir) => { if (!dir) return null; const ok = valid(dir); tried.push({ source, dir, valid: ok }); return ok ? { dir, source } : null; };
  let record = null; try { record = connection(kernel, laneName); } catch { /* an invalid record is reported by the tools that need it */ }
  const bridge = laneName === 'ss5' ? 4536 : 4516;
  const installed = registry();
  const found = attempt('connection', record?.studioDir) ?? attempt('variable', env.ANVIL_STUDIO_DIR)
    ?? attempt('registry', installed ? path.join(installed, 'Service Studio') : null)
    ?? attempt('programfiles', path.join(env.ProgramFiles || 'C:\\Program Files', 'OutSystems', 'Service Studio 11', 'Service Studio'))
    ?? attempt('lane-copy', path.join(env.USERPROFILE ?? '', 'OutSystems', `Service Studio 11 - Anvil ${bridge}`, 'Service Studio'));
  // Nothing valid: the lane copy is named (its absence is reported by the CLI that binds it), as before.
  return { ...(found ?? { dir: path.join(env.USERPROFILE ?? '', 'OutSystems', `Service Studio 11 - Anvil ${bridge}`, 'Service Studio'), source: 'none' }), tried,
    ...(record?.authorityDir && found?.source === 'connection' ? { authorityDir: record.authorityDir } : {}) };
}
export function laneSources(lane, { kernel = anvilRoot, odc = odcRoot, env = process.env, studio = null } = {}) {
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  if (lane === 'odc') {
    const cliDir = path.join(kernel, '.local', 'lane-odc', 'cli');
    const studioDir = env.ANVIL_ODC_STUDIO_DIR ?? path.join(programFiles, 'OutSystems', 'ODC Studio', 'ODC Studio');
    return {
      lane, kernel, odc, shared: SHARED_FILE, fragments: FRAGMENTS_DIR,
      cli: path.join(cliDir, 'anvil-odc.dll'), kernelDll: path.join(cliDir, 'Anvil.Core.Odc.dll'),
      studioDir, env: { ...env, ANVIL_ODC_STUDIO_DIR: studioDir },
      modelDlls: ['OutSystems.Model.dll', 'OutSystems.Model.V1.dll', 'OutSystems.Model.Implementation.dll', 'OutSystems.ModelAPILoader.dll', 'OutSystems.Model.Plugin.NRWidgets.dll'],
      jobsDir: path.join(kernel, 'tests', 'jobs-odc'), negativeDir: path.join(kernel, 'tests', 'jobs-odc-negative'),
      // The proven examples (ExamplesOdcTests): jobs named examples/<job>, results under <testWork>/examples.
      examplesDir: path.join(kernel, 'tests', 'jobs-odc', 'examples'),
      testWork: path.join(kernel, '.local', 'lane-odc', 'test-work'),
      fixture: path.join(kernel, 'tests', 'fixtures', 'odc', 'insurance-reactive-r8.oml'),
      suite: 'dotnet test kernel/tests/Anvil.Tests.Odc -c Release',
      modelApiDir: path.join(odc, 'docs', 'model-api'),
      naoDa: path.join(kernel, 'docs', 'NAO-DA.md'),
      cacheDir: path.join(odc, '.local', 'discovery', 'odc'),
      descriptor: path.join(here, 'discovery-capabilities.json'),
      // Every route an answer names is an MCP call (the CLI stays for developers; a CLI line sent the model to a shell).
      prove: job => `ssam_job {lane:"odc", job:"${job}"}`,
      entries: { job: 'ssam_job {lane:"odc", job}', deliver: 'studio_deliver {feature, module, job, owners, changes}', inspect: 'studio_inspect {target, kind|name|text|path, select, budget}', feature: 'studio_build {feature, base, sha, output} / studio_deliver {feature, module}', data: 'studio_data / studio_data_insert|update|delete (authorize words)', publish: 'studio_authorize {manifest, kind:"publish", text} then studio_publish {manifest, wait:true}', create: 'studio_create_app {kind, name, authorize} (template clone like the Studio, uploaded, opened and published)' },
      inspectCall: (file, sha256) => ({ tool: 'studio_inspect', arguments: { target: file, expectedSourceSha256: sha256 } }),
    };
  }
  if (lane === 'o11') {
    // The O11 lane comes from the single rule in workspace.mjs (explicit ANVIL_LANE, else the workspace's o11Lane).
    const laneName = o11Lane.lane;
    const local = path.join(kernel, laneName === 'ss5' ? path.join('.local', 'lane-ss5') : '.local');
    // studio (tests): the options of o11StudioDir (exists, registry, connection).
    const resolved = o11StudioDir({ kernel, laneName, env, ...(studio ?? {}) });
    return {
      lane, kernel, odc, shared: SHARED_FILE, fragments: FRAGMENTS_DIR, o11Lane: { name: laneName, source: o11Lane.source },
      cli: path.join(local, 'cli', 'anvil.dll'), kernelDll: path.join(local, 'cli', 'Anvil.Core.dll'),
      studioDir: resolved.dir, studioSource: resolved.source,
      // The environment of every CLI process of the discover: the same lane and Studio (and the connection's authority).
      env: { ...env, ANVIL_LANE: laneName, ANVIL_STUDIO_DIR: resolved.dir, ...(resolved.authorityDir ? { ANVIL_AUTHORITY_DIR: resolved.authorityDir } : {}) },
      modelDlls: ['OutSystems.Model.V1.dll', 'ServiceStudio.Framework.dll'],
      jobsDir: path.join(kernel, 'tests', 'jobs'), negativeDir: path.join(kernel, 'tests', 'jobs-negative'),
      // The proven examples (ExamplesO11Tests): jobs named examples/<job>, results under <testWork>/examples.
      examplesDir: path.join(kernel, 'tests', 'jobs', 'examples'),
      // The O11 suite (JobTests) writes <job>.result.json with the provenance stamp for the jobs listed in
      // tests/provenance-o11.json, next to the output OMLs.
      testWork: path.join(local, 'test-work'),
      // No lane fixture on O11: every job declares its own base (four fixtures under tests/fixtures or job:<name>);
      // the stamp carries baseSha256 and a null fixtureSha256, and the classification compares the base.
      fixture: null,
      suite: 'dotnet test kernel/tests/Anvil.Tests -c Release (stamps only the jobs of tests/provenance-o11.json)',
      modelApiDir: path.join(kernel, 'catalog'),
      naoDa: path.join(kernel, 'docs', 'NAO-DA.md'),
      cacheDir: path.join(odc, '.local', 'discovery', 'o11'),
      descriptor: path.join(here, 'discovery-capabilities-o11.json'),
      prove: job => `ssam_job {lane:"o11", job:"${job}"}`,
      entries: { job: 'ssam_job {lane:"o11", job}', deliver: 'o11_deliver {module, job, checks, authorize}', inspect: 'o11_inspect {oml, kind|name|text|path, expectedSourceSha256}', feature: 'n/a on O11 (jobs only)', data: 'o11_data (headless Edit Data)', publish: 'o11_publish {module, authorize} with the user words, after the merge' },
      inspectCall: (file, sha256) => ({ tool: 'o11_inspect', arguments: { oml: file, expectedSourceSha256: sha256 } }),
    };
  }
  throw new Error('Unknown lane ' + lane + '; lanes: odc, o11');
}

// ---- text: accent-insensitive tokens, tiny stemming, PT/EN stopwords (catalog.mjs, shared with the pure contract
// check); synonyms come from the descriptor.
export { normalize, tokens };
// The tokens of an intent (those of tokens()), the positions of the tokens a genitive connector precedes ("fluxo DA
// server action", "lista DE registos", "list OF records": there two nouns say the compound the other way round, record
// list) and the positions a dropped word or a punctuation mark precedes (where a run of words such as "server action"
// ends: "fluxo da acao de servidor NA ui").
const GENITIVE = new Set(['de', 'do', 'da', 'dos', 'das', 'of']);
function intentTokens(text) {
  const list = []; const genitive = new Set(); const gap = new Set(); let connector = false; let dropped = false;
  for (const part of normalize(text).split(/([^a-z0-9_]+)/)) {
    if (!part) continue;
    if (/^[^a-z0-9_]/.test(part)) { if (/\S/.test(part)) dropped = true; continue; }
    if (part.length > 1 && !STOP.has(part)) { if (list.length && connector) genitive.add(list.length); if (list.length && dropped) gap.add(list.length); list.push(stem(part)); connector = false; dropped = false; }
    else { dropped = true; if (GENITIVE.has(part)) connector = true; }
  }
  return { list, genitive, gap };
}
// Phrases compare whole tokens: a substring crossed token boundaries ("serveraction flow" held "action flow"). A token
// is compared through `fold` (catalog.mjs), which joins the spellings of one word the stemmer leaves apart
// ("references" -> "referenc" but "reference"; "settings" -> "setting" but "setting" -> "sett"): the substring match
// joined them at the end of a phrase, and the keywords written in the plural or with -ed/-ing rely on it ("refresh
// references").
// The generic child words every data family shares: an operation said before one of them names the operation on the
// child of the family the intent names, not a keyword of another capability ("apagar o registo" of a static entity is
// not the "delete record" of the development-data capability).
const CHILD_WORDS = new Set(['record', 'attribute', 'value'].map(fold));
// Expand a token set with the descriptor synonyms (canonical -> variants); returns canonical terms too, the map raw
// token -> canonical terms it produced (so an intent word counts as matched when its canonical form matched), the
// consumed words and `says`, the reader of multi-word keywords.
// `derivedTokens`: the tokens of the intent whose word lost a derivational suffix. A one-word variant that only reaches
// its token through such a suffix ("publicacao" -> "publica") matches only a word that also lost one, never the plain
// word it collides with (the adjective "publica"; request C-010). `genitive`, `gap`: see intentTokens. `owners`: the
// capabilities each single-word keyword token belongs to (keywordOwners).
function canonicalize(list, synonyms, derivedTokens = null, { genitive = new Set(), gap = genitive, owners = new Map() } = {}) {
  const out = new Set(list); const from = new Map(list.map(t => [t, new Set([t])]));
  // `consumed`: a raw token that only appeared as PART of a multi-word form ("entity" inside "static entity") names
  // the canonical of that form, not a capability of its own; scoreCapability uses it so "static entity" does not
  // credit the keyword "entity" of another family. Consumption is by position: the same word elsewhere in the
  // intent, outside every form, is not consumed.
  const consumed = new Map(); const inForm = new Set(); const single = new Map(); const spans = [];
  const foldedList = list.map(fold);
  const positions = parts => { const f = parts.map(fold); const found = []; for (let i = 0; i + f.length <= list.length; i++) if (f.every((p, k) => foldedList[i + k] === p)) found.push(i); return found; };
  for (const [canonical, variants] of Object.entries(synonyms ?? {})) {
    const key = tokens(canonical).join(' ');
    for (const [variant, form] of [canonical, ...variants].map(v => [v, tokens(v).join(' ')])) {
      if (!form) continue;
      const needsDerived = derivedTokens && !form.includes(' ') && derived(normalize(variant).trim());
      if (list.includes(form) && (!needsDerived || derivedTokens.has(form))) {
        out.add(key); from.get(form).add(key);
        // `whole`: the variant is the word itself ("on change" reaches "change" only because "on" is a stopword).
        const whole = normalize(variant).split(/[^a-z0-9_]+/).filter(Boolean).length === 1;
        if (!single.has(form)) single.set(form, new Map()); single.get(form).set(key, whole || single.get(form).get(key) === true);
      } else if (form.includes(' ')) {
        const parts = form.split(' '); const found = positions(parts); if (!found.length) continue;
        out.add(key);
        for (const i of found) {
          for (let k = 0; k < parts.length; k++) { const t = list[i + k]; inForm.add(i + k); from.get(t).add(key); if (!consumed.has(t)) consumed.set(t, new Set()); consumed.get(t).add(key); }
          if (!key.includes(' ')) spans.push({ start: i, end: i + parts.length - 1, name: key });
        }
      }
    }
  }
  // A consumed word still counts as itself when the intent also says it outside every form, or when a word outside
  // every form produced the same canonical through a one-word variant ("screen preparation da tela": "tela" -> screen;
  // request A-005).
  const free = new Set(list.filter((_, i) => !inForm.has(i)));
  for (const term of [...consumed.keys()]) if (free.has(term) || [...free].some(t => single.get(t)?.has(term))) consumed.delete(term);
  // `says(keyword, owner)`: a multi-word keyword of `owner` (a capability or unavailable id) is read in the intent's word
  // order over consecutive units: a word standing for itself or for a canonical it produced through a one-word variant
  // ("agregado com filtro" says "aggregate filter"), or a multi-word form standing for its one-word canonical ("mudar
  // o nome" -> rename); a two-word keyword is also read the other way round across a genitive ("evento do bloco" says
  // "block event"); or the keyword is a run of one multi-word canonical the intent produced ("input parameter"). Never
  // across the list of canonicals: there the canonicals of words that are not adjacent in the intent ("fluxo" ->
  // action, "ui" -> screen) were adjacent and matched "screen action" (request A-005).
  // A word stands in for a canonical only when (a) a variant that is the word itself produced it, (b) the word is not a
  // single-word keyword of another capability ("widget" names ui.widget: it does not say the "block event" of
  // ui.block; "click" names ui.event: "click handler" is not the "event handler" of ui.block-instance), and (c) an
  // operation canonical is neither read backwards nor followed by a generic child word.
  const units = [...list.map((t, i) => ({ start: i, end: i, token: t })), ...spans];
  // How unit `u` says keyword word `part`: null, or { literal (the word itself), operation (an operation canonical) }.
  // Test (b) spares operations, which belong to every family ("apagar", a keyword of refactor.delete, still says the
  // "delete screen" of ui.screen).
  const stands = (u, part, owner, next, backwards) => {
    const p = fold(part);
    const via = name => (fold(name) !== p ? null : !OPERATION_CANONICALS.has(name) ? { literal: false, operation: false } : backwards || CHILD_WORDS.has(fold(next ?? '')) ? null : { literal: false, operation: true });
    if (u.name) return via(u.name);
    if (foldedList[u.start] === p) return { literal: true, operation: OPERATION_CANONICALS.has(u.token) };
    const foreign = owners.has(u.token) && !owners.get(u.token).has(owner);
    return [...(single.get(u.token) ?? [])].map(([name, whole]) => (whole ? via(name) : null)).find(s => s && (s.operation || !foreign)) ?? null;
  };
  // Across a genitive connector PT puts the modifier after the noun ("lista de APIs" is a list of APIs, not "list
  // APIs"): a keyword is read forward across one only after an operation ("mudar o nome da acao") or when both words are
  // said literally (a PT keyword such as "conector fluxo"); backwards, a two-word keyword is read from the unit before
  // the connector and the first or last word of the run after it, up to the next dropped word ("fluxo da server action"
  // says "action flow"; "fluxo da acao de servidor na ui" does not say "screen action"), never through an operation or
  // a multi-word form after the connector ("variavel da acao de cliente" is not a client variable).
  const phrases = [...out].filter(t => t.includes(' ')).map(p => ` ${folded(p)} `);
  const runAfter = at => { let end = at; while (end + 1 < list.length && !gap.has(end + 1)) end++; return [at, end]; };
  const says = (keyword, owner = null) => {
    const parts = keyword.split(' ');
    const whole = ` ${folded(keyword)} `; if (phrases.some(p => p.includes(whole))) return true;
    const read = (at, j, previous) => j === parts.length || units.some(u => {
      if (u.start !== at) return false;
      const how = stands(u, parts[j], owner, parts[j + 1], false);
      if (!how || (j > 0 && genitive.has(at) && !previous.operation && !(previous.literal && how.literal))) return false;
      return read(u.end + 1, j + 1, how);
    });
    if (list.some((_, i) => read(i, 0, null))) return true;
    return parts.length === 2 && units.some(y => genitive.has(y.end + 1) && stands(y, parts[1], owner, null, true) && runAfter(y.end + 1).some(i => stands(units[i], parts[0], owner, parts[1], true)));
  };
  return { terms: [...out], from, consumed, says };
}

// ---- sources
// Every CLI process of the discover runs with the lane's environment (sources.env) and binds sources.studioDir, the Studio
// the index names and whose assemblies it hashes (W3): one folder, even for a copy of sources with another studioDir.
// sources.dotnet: the host (tests).
const cliEnv = sources => ({ ...(sources.env ?? process.env), ...(sources.studioDir ? { [sources.lane === 'odc' ? 'ANVIL_ODC_STUDIO_DIR' : 'ANVIL_STUDIO_DIR']: sources.studioDir } : {}) });
const cli = (sources, args, maxBuffer = 16 * 1024 * 1024) => run(sources.dotnet ?? 'dotnet', [sources.cli, ...args],
  { windowsHide: true, maxBuffer, cwd: sources.kernel, env: cliEnv(sources) });
async function apiSchemas(sources) {
  const contracts = {}; const timings = {};
  for (const op of API_OPS) {
    const started = performance.now();
    try {
      const { stdout } = await cli(sources, ['api', '--op', op]);
      const envelope = JSON.parse(stdout);
      contracts[op] = envelope.ok ? envelope.data : { error: envelope.error };
    } catch (error) {
      // An older CLI build lacks `verbs`: record the absence instead of inventing the table.
      contracts[op] = { error: String(error.stderr || error.message).split(/\r?\n/).find(Boolean) };
    }
    timings[op] = Math.round(performance.now() - started);
  }
  return { contracts, timings };
}
// The lane CLI binds the installed Studio for `verify-catalog` and reports platform, IDE version and the count of
// Verify definitions read from its DLL: the identity of the native side, measured, not copied from a doc.
export async function studioIdentity(sources) {
  const dlls = {};
  for (const name of sources.modelDlls) { const file = path.join(sources.studioDir, name); if (exists(file)) dlls[name] = sha256(fs.readFileSync(file)).slice(0, 16); }
  try {
    const { stdout } = await cli(sources, ['verify-catalog'], 32 * 1024 * 1024);
    const data = JSON.parse(stdout).data ?? {};
    return { platform: data.platform ?? null, ideVersion: data.ideVersion ?? null, verifyDefinitions: data.count ?? null, dir: sources.studioDir, modelDlls: dlls };
  } catch (error) { return { error: String(error.stderr || error.message).split(/\r?\n/).find(Boolean), dir: sources.studioDir, modelDlls: dlls }; }
}
function summarizeOps(ops, acc = { ops: {}, types: {}, props: {}, steps: {}, actionKinds: {}, specSections: {}, notes: [] }) {
  for (const [i, op] of (ops ?? []).entries()) {
    if (!op || typeof op !== 'object') continue;
    const kind = op.op; if (!kind) continue;
    acc.ops[kind] = (acc.ops[kind] ?? 0) + 1;
    if (kind === 'create' && op.type) acc.types[op.type] = (acc.types[op.type] ?? 0) + 1;
    if (kind === 'set' && op.prop) acc.props[op.prop] = (acc.props[op.prop] ?? 0) + 1;
    if (kind === 'spec' && op.data) for (const section of Object.keys(op.data)) acc.specSections[section] = (acc.specSections[section] ?? 0) + 1;
    if (kind === 'logic' && op.data?.actions) for (const action of op.data.actions) {
      acc.actionKinds[action.kind ?? 'server'] = (acc.actionKinds[action.kind ?? 'server'] ?? 0) + 1;
      const walk = steps => { for (const step of steps ?? []) { const key = Object.keys(step).find(k => !['as', 'label'].includes(k)); if (key) acc.steps[key] = (acc.steps[key] ?? 0) + 1; if (step.then) walk(step.then); if (step.else) walk(step.else); if (step.do) walk(step.do); } };
      walk(action.steps);
    }
    if (typeof op._why === 'string' && op._why.trim()) acc.notes.push({ op: i, verb: kind, name: op.name ?? op.prop ?? op.type ?? null, text: op._why.trim() });
  }
  return acc;
}
// A job result is evidence of an execution. Reading it never classifies it: `classifyExecutions` decides, with the
// whole current identity in hand, whether it is CURRENT or historical.
function executionOf(resultFile, ops = null) {
  if (!exists(resultFile)) return null;
  let r; let stat;
  try { r = readJson(resultFile); stat = fs.statSync(resultFile); } catch { return { status: 'unreadable', file: path.basename(resultFile), current: false, mismatches: ['unreadable result file'] }; }
  // run_job.py wraps the CLI result as {ok, data, ...}: read the body where the stamp and the ledger live.
  if (r.provenance == null && r.data && typeof r.data === 'object' && (r.data.provenance || r.data.coverage)) r = r.data;
  const p = r.provenance ?? null;
  const coverageQualified = r.coverage?.porInterface ? Object.fromEntries(Object.entries(r.coverage.porInterface).map(([type, v]) => [type, { shortType: v.tipo ?? null, verbs: v.verbos ?? [], props: v.propriedades ?? [] }])) : null;
  return { file: path.basename(resultFile), at: p?.at ?? stat.mtime.toISOString(), accepted: r.accepted ?? null, isValid: r.isValid ?? null, flowLayoutEngine: r.flowLayoutEngine ?? null,
    provenance: p, current: false, mismatches: [],
    coverage: r.coverage?.porTipo ? Object.fromEntries(Object.entries(r.coverage.porTipo).map(([type, v]) => [type, { verbs: v.verbos ?? [], props: v.propriedades ?? [], ...(v.interfaces ? { interfaces: v.interfaces } : {}) }])) : null,
    // The ledger by QUALIFIED interface (anvil-coverage-ledger/2, 2026-09-23): a new proof says which type ran.
    coverageQualified,
    // One entry per op of the job, with the type the verb ran on as the result names it: the evidence for one element
    // ROLE (a record is not its entity) and for the read verbs the ledger does not record.
    executions: executionsOf(ops, r.results, coverageQualified) };
}
// The per-op evidence of a result: which verb ran on which type. The write verbs of the ledger name the qualified
// interface themselves (delete, duplicate, dump carry `iface`; replace/rename/move/usages name "IType 'Name'"); a
// short type name is qualified only through the same job's ledger, and only when exactly one interface bears it
// (`via` says which path qualified it). A `set` is attributed through the ledger when exactly one interface of the job
// wrote that property. Anything else keeps the verb with no type: it proves nothing about a role.
function executionsOf(ops, results, coverageQualified) {
  if (!Array.isArray(ops) || !Array.isArray(results) || ops.length !== results.length) return null;
  const byShort = new Map();
  for (const [q, v] of Object.entries(coverageQualified ?? {})) if (v.shortType) byShort.set(v.shortType, byShort.has(v.shortType) ? null : q);
  const qualify = short => (short && byShort.get(short)) || null;
  const named = text => /^(I[A-Za-z0-9]+) '/.exec(String(text ?? ''))?.[1] ?? null;
  const out = [];
  for (const [i, op] of ops.entries()) {
    const verb = op?.op; const res = results[i]?.result; if (!verb || res == null || typeof res !== 'object') continue;
    let shortType = null; let iface = null; let via = null; const fact = {};
    const fromIface = () => { if (res.iface) { iface = res.iface; shortType = res.type ?? null; via = 'result-iface'; } else if (res.type) { shortType = res.type; iface = qualify(res.type); via = iface ? 'result-short-mapped' : null; } };
    const fromNamed = text => { shortType = named(text); iface = qualify(shortType); via = iface ? 'result-short-mapped' : null; };
    switch (verb) {
      case 'get': fromIface(); break;
      case 'dump': fromIface(); break;
      case 'create': fromIface(); break;
      case 'duplicate': fromIface(); fact.as = res.name ?? null; break;
      case 'find': shortType = typeof op.type === 'string' ? op.type.replace(/^(?!I)/, 'I') : null; iface = qualify(shortType); via = iface ? 'result-short-mapped' : null; fact.found = Array.isArray(res) ? res.length : null; break;
      case 'usages': fromNamed(res.target); fact.count = res.count ?? null; fact.real = res.real ?? null; break;
      case 'replace': fromNamed(res.replaced); Object.assign(fact, { consumers: res.consumers ?? null, rewired: res.rewired ?? null, stillPointingAtFrom: res.stillPointingAtFrom ?? null, consumersOfTo: res.consumersOfTo ?? null }); break;
      case 'rename': fromNamed(res.renamed); Object.assign(fact, { consumers: res.consumers ?? null, expressionsRewritten: res.expressionsRewritten ?? null }); break;
      case 'move': fromNamed(res.target); Object.assign(fact, { moved: res.moved ?? null, order: res.order ?? null }); break;
      case 'delete': if (res.deleted?.iface) { iface = res.deleted.iface; shortType = res.deleted.type ?? null; via = 'result-iface'; } Object.assign(fact, { brokenConsumers: res.brokenConsumers ?? null, force: op.force === true }); break;
      case 'set': { const prop = res.set ?? op.prop ?? null; const owners = Object.entries(coverageQualified ?? {}).filter(([, v]) => v.verbs.includes('set') && v.props.includes(prop)); if (owners.length === 1) { iface = owners[0][0]; shortType = owners[0][1].shortType; via = 'ledger-prop-mapped'; } fact.prop = prop; break; }
      // A spec is one composite write whose result names only the aliases it registered. It is attributed to the
      // interfaces of the shapes it DECLARES that the same job's ledger records a create on (record values: a set),
      // never to the raw creates of other shapes in the same job.
      case 'spec': { for (const q of specInterfaces(op.data, coverageQualified)) out.push({ i, verb: 'spec', shortType: coverageQualified[q].shortType, iface: q, via: 'spec-shape-ledger', fact: { shapes: Object.keys(op.data ?? {}) } }); continue; }
      default: continue;
    }
    if (Array.isArray(res) && verb !== 'find') continue;
    out.push({ i, verb, shortType, iface, via, ...(Object.keys(fact).length ? { fact } : {}) });
  }
  return out;
}
// The qualified interfaces a spec op wrote, by the shapes it declares (entities, static, structures) intersected with
// the job ledger: the entity family, the static family (records and their values) and the structure family.
const SPEC_SHAPES = { entities: s => ['IServerEntity', ...(s.some(e => e.attributes?.length) ? ['IEntityAttribute'] : []), ...(s.some(e => e.indexes?.length) ? ['IEntityIndex'] : [])],
  static: s => ['IStaticEntity', ...(s.some(e => e.attributes?.length) ? ['IEntityAttribute'] : []), ...(s.some(e => e.records?.length) ? ['IStaticEntityRecord', 'IRecord', 'IRecordAttributeValue'] : [])],
  structures: s => ['IStructure', ...(s.some(e => e.attributes?.length) ? ['IStructureAttribute'] : [])] };
function specInterfaces(data, coverageQualified) {
  const declared = new Set();
  for (const [shape, types] of Object.entries(SPEC_SHAPES)) { const list = data?.[shape]; if (Array.isArray(list) && list.length) for (const t of types(list)) declared.add(t); }
  return Object.entries(coverageQualified ?? {}).filter(([q, v]) => { const short = q.split('.').pop(); return declared.has(short) && (v.verbs.includes('create') || (short === 'IRecordAttributeValue' && v.verbs.includes('set'))); }).map(([q]) => q);
}
// Properties whose value binds one element to another: the proven "how X connects to Y" of a job. Rank 0 = element to
// element (navigation, handlers, sources), 1 = data binding of a widget or query part, 2 = flow wiring (links) and
// creation arguments.
const BINDING_PROPS = new Map([['Destination', 0], ['Handler', 0], ['Action', 0], ['Source', 0], ['SourceBlock', 0], ['DataSource', 0], ['OnAfterFetch', 0], ['Entity', 0], ['DefaultScreen', 0], ['Roles', 0], ['Theme', 0], ['Variable', 1], ['List', 1], ['Attribute', 1], ['Values', 1], ['Labels', 1]]);
// Bindings of a job: set ops on binding properties, link ops and creates with args, each with the created type of every
// alias it names, so the rule reads as "<IListItem>/OnClick Destination = IMobileScreen:<name>" instead of "$item".
export function bindingsOf(ops) {
  const aliasType = new Map(); const out = [];
  const typed = value => String(value ?? '').replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, a => (aliasType.has(a) ? `<${aliasType.get(a)}>` : a));
  const shape = value => {
    const s = String(value ?? '');
    if (/^\$/.test(s)) return typed(s);
    if (/^I[A-Z][A-Za-z]+:/.test(s)) return s.replace(/:.*$/, ':<name>');
    if (/^[A-Za-z_][A-Za-z0-9_]*\.List$/.test(s)) return '<Aggregate>.List';
    if (/^[A-Za-z_][A-Za-z0-9_]*\.List\.Current\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return '<Aggregate>.List.Current.<Entity>.<attr>';
    if (/^[A-Za-z_][A-Za-z0-9_]*\.List\.Current\.[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return '<Aggregate>.List.Current.<column>';
    return s.length > 40 ? '<expression>' : s;
  };
  // An argument of a navigation or handler binding: `$item/OnClick/TaskId` Value = <expr>.
  const argumentTarget = t => /\/On[A-Z][A-Za-z]*\/[^/#]+$/.test(String(t ?? ''));
  // The element at each end of a set binding, so query() can tell which element roles a rule connects: the type of an
  // alias or an `IType:` reference, the `#IType` child a path selects, or the event a path ends in (`$btn/OnClick` is
  // the OnClick event of a button, not the button). An expression or a named child names no type (null).
  const endOf = value => {
    const segments = String(value ?? '').split('/'); const head = segments[0]; const last = segments.at(-1);
    if (segments.length > 1) return /^On[A-Z][A-Za-z]*$/.test(last) ? { event: last } : /^#(I[A-Z][A-Za-z0-9]*)(\[\d+\])?$/.test(last) ? { type: /^#(I[A-Z][A-Za-z0-9]*)/.exec(last)[1] } : null;
    const type = head.startsWith('$') ? aliasType.get(head) : /^(I[A-Z][A-Za-z0-9]*):/.exec(head)?.[1];
    return type ? { type } : null;
  };
  for (const [i, op] of (ops ?? []).entries()) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'create') { if (typeof op.as === 'string' && op.type) aliasType.set(op.as, String(op.type).replace(/^(?!I)/, 'I')); if (op.args && typeof op.args === 'object') for (const [k, v] of Object.entries(op.args)) out.push({ op: i, rank: 2, rule: `create ${String(op.type).replace(/^(?!I)/, 'I')} args.${k} = ${shape(v)}`, example: { op: 'create', parent: typed(op.parent), type: op.type, args: { [k]: v } } }); continue; }
    if (op.op === 'set' && BINDING_PROPS.has(op.prop)) { out.push({ op: i, rank: BINDING_PROPS.get(op.prop), rule: `set ${typed(op.target)} ${op.prop} = ${shape(op.value)}`, ends: [endOf(op.target), endOf(op.value)], example: { op: 'set', target: op.target, prop: op.prop, value: op.value } }); continue; }
    if (op.op === 'set' && op.prop === 'Value' && argumentTarget(op.target)) { out.push({ op: i, rank: 1, rule: `set ${typed(op.target).replace(/\/[^/]+$/, '/<argument>')} Value = ${shape(op.value)}`, example: { op: 'set', target: op.target, prop: 'Value', value: op.value } }); continue; }
    if (op.op === 'link') out.push({ op: i, rank: 2, rule: `link ${typed(op.from)} -> ${typed(op.to)}${op.connector ? ' connector ' + op.connector : ''}`, example: { op: 'link', from: op.from, to: op.to, ...(op.connector ? { connector: op.connector } : {}) } });
  }
  return out;
}
// The job files of a lane: the suite (tests/jobs-odc, tests/jobs) by name, then the proven examples of its examples
// folder as examples/<name> (a name that resolves as <jobsDir>/<name>.json and <testWork>/<name>.result.json, like a
// suite job). Of the examples only jobs (ops or jobs) count: the coverage matrix (matriz.json) is data, and an example
// that declares expectError is a refusal proof, read by loadNegatives.
function jobFiles(sources) {
  const list = dir => { try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return []; } };
  const suite = exists(sources.jobsDir) ? list(sources.jobsDir).map(f => ({ name: f.slice(0, -5), full: path.join(sources.jobsDir, f), example: false })) : [];
  const examples = sources.examplesDir && exists(sources.examplesDir) ? list(sources.examplesDir).map(f => ({ name: 'examples/' + f.slice(0, -5), full: path.join(sources.examplesDir, f), example: true })) : [];
  return [...suite, ...examples];
}
const isJobText = job => job !== null && typeof job === 'object' && (Array.isArray(job) || Array.isArray(job.ops) || Array.isArray(job.jobs));
// The ops of a composite example ({"jobs":["job:a","b.json"]}), concatenated in order as JobRunner.CollectOps does: a
// job:<name> part in the example's own folder first, then in the suite; a part that cannot be read adds nothing.
// A job file as an answer shows it: a composite example gets the ops of its parts.
function readJob(file, sources) {
  const job = readJson(file);
  return job && !Array.isArray(job) && Array.isArray(job.jobs) && !Array.isArray(job.ops) ? { ...job, ops: compositeOps(job.jobs, path.dirname(file), sources.jobsDir) } : job;
}
function compositeOps(parts, dir, suiteDir) {
  return parts.flatMap(part => {
    const spec = String(part ?? '');
    const files = spec.startsWith('job:') ? [path.join(dir, spec.slice(4) + '.json'), path.join(suiteDir, spec.slice(4) + '.json')] : [path.resolve(dir, spec)];
    for (const file of files) { try { const j = readJson(file); return Array.isArray(j) ? j : (j.ops ?? []); } catch { /* next */ } }
    return [];
  });
}
function loadJobs(sources) {
  const jobs = [];
  for (const { name, full, example } of jobFiles(sources)) {
    let job; let raw; try { raw = fs.readFileSync(full); job = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    if (example && (!isJobText(job) || job.expectError != null)) continue;
    const composite = example && Array.isArray(job.jobs) && !Array.isArray(job.ops);
    if (composite) job = { ...job, ops: compositeOps(job.jobs, path.dirname(full), sources.jobsDir) };
    // The same job text reaches each checkout with the line endings of its git configuration (autocrlf); in JSON a
    // line break outside a string is whitespace, so the job is identical modulo line endings. The stamp is compared
    // against the bytes as they are and against the LF and CRLF forms of the same text (classifyExecutions).
    const text = raw.toString('utf8'); const lf = text.replace(/\r\n/g, '\n');
    const eolVariants = [...new Set([sha256(Buffer.from(lf, 'utf8')), sha256(Buffer.from(lf.replace(/\n/g, '\r\n'), 'utf8'))])].filter(h => h !== sha256(raw));
    jobs.push({ name, path: path.relative(sources.kernel, full).replaceAll('\\', '/'), ...(composite ? { composite: true } : {}), sha256: sha256(raw), sha256Eol: eolVariants, description: job.description ?? '', base: job.base ?? null,
      expectValid: job.expectValid ?? true, expectedMessages: (job.expectedMessages ?? []).map(m => ({ id: m.id, element: m.element, why: m.why })),
      opCount: (job.ops ?? []).length, ...summarizeOps(job.ops), bindings: bindingsOf(job.ops), executed: executionOf(path.join(sources.testWork, name + '.result.json'), job.ops ?? null) });
  }
  return jobs;
}
// A result is CURRENT only when every component of the identity is known on both sides and equal: the job text, the
// declared base (a fixture hashed now with the same resolution policy, or a base job whose own result must be
// current), the lane fixture when the lane has one (ODC; on O11 the declared base is the fixture and the stamp says
// fixtureSha256 null), the kernel DLL, the Studio version and the hash of every Studio assembly the stamped process
// had loaded. Anything undetermined on the current side, absent in the stamp, or different, keeps the result
// historical with the reason. Not covered (and not claimed): producers (O11 `reference` ops) and files outside these.
export function classifyExecutions(jobs, current) {
  const byName = new Map(jobs.map(j => [j.name, j]));
  const memo = new Map();
  const classify = (job, trail) => {
    if (memo.has(job.name)) return memo.get(job.name);
    const x = job.executed;
    if (!x) return null;
    const mismatches = [];
    const p = x.provenance;
    if (!p) mismatches.push('unstamped: the result carries no provenance (older suite build)');
    else {
      if (x.accepted !== true) mismatches.push('the result was not accepted');
      const components = { jobSha256: job.sha256, kernelSha256: current.kernelSha256, ideVersion: current.ideVersion };
      // The lane fixture is compared whenever either side has one; a lane without a fixture (O11) relies on the base.
      if (current.fixtureSha256 != null || p.fixtureSha256 != null) components.fixtureSha256 = current.fixtureSha256;
      for (const [key, expected] of Object.entries(components)) {
        if (expected == null) mismatches.push(`${key}: current value undetermined`);
        else if (p[key] == null) mismatches.push(`${key}: absent from the stamp`);
        else if (String(p[key]).toLowerCase() === String(expected).toLowerCase()) continue;
        else if (key === 'jobSha256' && (job.sha256Eol ?? []).includes(String(p[key]).toLowerCase())) x.jobIdentity = 'same job text modulo line endings (the stamp hashed the other line-ending form; JSON whitespace only)';
        else mismatches.push(`${key}: result ${String(p[key]).slice(0, 16)} vs current ${String(expected).slice(0, 16)}`);
      }
      if (!p.nativeAssemblies || typeof p.nativeAssemblies !== 'object') mismatches.push('nativeAssemblies: absent from the stamp (older stamp schema)');
      else if (!current.assemblyHash) mismatches.push('nativeAssemblies: current Studio directory undetermined');
      else for (const [name, stamped] of Object.entries(p.nativeAssemblies)) {
        const now = current.assemblyHash(name);
        if (now == null) mismatches.push(`nativeAssemblies: ${name} not found in the current Studio directory`);
        else if (now !== String(stamped).toLowerCase()) mismatches.push(`nativeAssemblies: ${name} differs`);
      }
      if (p.baseKind == null || p.base == null) mismatches.push('base: absent from the stamp (older stamp schema)');
      else if (p.base !== (job.base ?? 'tests/fixtures/blank-service.oml')) mismatches.push(`base: stamped '${p.base}' vs declared '${job.base}'`);
      else if (p.baseKind === 'fixture') {
        const now = current.baseHash ? current.baseHash(p.base) : null;
        if (now == null) mismatches.push(`base: '${p.base}' could not be hashed now`);
        else if (p.baseSha256 == null) mismatches.push('baseSha256: absent from the stamp');
        else if (now !== String(p.baseSha256).toLowerCase()) mismatches.push('baseSha256: the fixture the job declares changed');
      } else if (p.baseKind === 'job') {
        // job:<name> resolves in the job's own folder first (an example chains to examples/<name>), as JobRunner does.
        const folder = job.name.includes('/') ? job.name.slice(0, job.name.lastIndexOf('/') + 1) : '';
        const baseName = folder && byName.has(folder + String(p.base).slice(4)) ? folder + String(p.base).slice(4) : String(p.base).slice(4);
        const baseJob = byName.get(baseName);
        if (!baseJob) mismatches.push(`base job '${baseName}' not in the suite`);
        else if (trail.includes(baseName)) mismatches.push(`base chain cycle: ${[...trail, baseName].join(' -> ')}`);
        else { const b = classify(baseJob, [...trail, job.name]); if (!b) mismatches.push(`base job '${baseName}' has no result`); else if (!b.current) mismatches.push(`base job '${baseName}' is not current (${b.mismatches[0] ?? 'see its result'})`); }
      } else mismatches.push(`base: unknown baseKind '${p.baseKind}'`);
    }
    x.mismatches = mismatches; x.current = mismatches.length === 0;
    memo.set(job.name, x);
    return x;
  };
  for (const job of jobs) classify(job, []);
  return jobs;
}
function loadNegatives(sources) {
  const out = [];
  // The negative suite by name, then the blocked examples (examples/<name> with expectError) of the examples folder.
  const negatives = exists(sources.negativeDir) ? fs.readdirSync(sources.negativeDir).filter(f => f.endsWith('.json')).sort().map(f => ({ name: f.slice(0, -5), full: path.join(sources.negativeDir, f) })) : [];
  for (const { name, full } of [...negatives, ...jobFiles(sources).filter(f => f.example)]) {
    let job; try { job = readJson(full); } catch { continue; }
    if (job === null || typeof job !== 'object' || job.expectError == null) continue;
    out.push({ name, path: path.relative(sources.kernel, full).replaceAll('\\', '/'), description: job.description ?? '',
      expectError: Array.isArray(job.expectError) ? job.expectError : [job.expectError], ...summarizeOps(job.ops) });
  }
  return out;
}
// NAO-DA.md: `### title` + a type tag line + `Visto em:` anchor. The text is a doc; the anchor says what proves it.
export function loadLimits(sources) {
  if (!exists(sources.naoDa)) return [];
  const lines = fs.readFileSync(sources.naoDa, 'utf8').split(/\r?\n/);
  const out = []; let current = null; let section = '';
  for (const line of lines) {
    if (line.startsWith('## ')) { section = line.slice(3).trim(); continue; }
    if (line.startsWith('### ')) { if (current) out.push(current); current = { title: line.slice(4).trim(), section, type: null, seenAt: null, verdict: null }; continue; }
    if (!current) continue;
    const tag = /^`([a-z-]+)`\s*$/.exec(line.trim()); if (tag && !current.type) current.type = tag[1];
    if (/^Visto em:/i.test(line.trim())) current.seenAt = line.trim().replace(/^Visto em:\s*/i, '').slice(0, 300);
    const verdict = /^>\s*\*\*?(CONFIRMADO|IMPRECISO|REFUTADO|OBSOLETO|NAO MEDIDO)/.exec(line.trim()); if (verdict) current.verdict = verdict[1];
  }
  if (current) out.push(current);
  return out.filter(l => l.type).map(l => ({ ...l, source: path.relative(sources.kernel, sources.naoDa).replaceAll('\\', '/') }));
}
function modelApiIdentity(sources) {
  if (!exists(sources.modelApiDir)) return { available: false };
  const files = fs.readdirSync(sources.modelApiDir).filter(f => /^(OutSystems\.[A-Za-z0-9.]+\.json|model-api-[0-9.]+\.json)$/.test(f)).sort();
  if (files.length === 0) return { available: false };
  let version = null;
  const index = path.join(sources.modelApiDir, 'INDEX.md');
  if (exists(index)) version = /ODC Studio ([0-9.]+)/.exec(fs.readFileSync(index, 'utf8'))?.[1] ?? null;
  if (!version) version = /model-api-([0-9.]+)\.json/.exec(files.find(f => f.startsWith('model-api-')) ?? '')?.[1] ?? null;
  return { available: true, dir: path.relative(sources.odc, sources.modelApiDir).replaceAll('\\', '/'), version, files: files.map(f => ({ file: f, sha256: sha256(fs.readFileSync(path.join(sources.modelApiDir, f))).slice(0, 16) })) };
}
function fixtureIdentity(sources) {
  if (!sources.fixture) return { available: null, note: 'no lane fixture on this lane: each job declares its base, stamped as baseSha256' };
  if (!exists(sources.fixture)) return { available: false, path: sources.fixture };
  const content = fs.readFileSync(sources.fixture);
  const info = { available: true, path: path.relative(sources.kernel, sources.fixture).replaceAll('\\', '/'), bytes: content.length, sha256: sha256(content).toUpperCase() };
  const sidecar = sources.fixture + '.json';
  if (exists(sidecar)) { try { const s = readJson(sidecar); Object.assign(info, { module: s.module, capturedAt: s.capturedAt, dependencies: s.dependencies, sidecarSha256: s.sha256 }); if (s.sha256 && s.sha256.toUpperCase() !== info.sha256) info.warning = 'fixture bytes differ from the sidecar sha256'; } catch { /* optional */ } }
  return info;
}

// ---- descriptor validation: every pointer must resolve, or the index refuses to build.
function pointerExists(contracts, pointer) {
  const [op, ...rest] = pointer.split('.');
  let node = contracts[op]; if (!node || node.error) return false;
  for (const key of rest) { if (node == null || typeof node !== 'object') return false; node = Array.isArray(node) ? node.find(x => x === key) : node[key]; }
  return node !== undefined;
}
export const depId = d => (typeof d === 'string' ? d : d?.id);
export function validateDescriptor(descriptor, { contracts, jobs, negatives, nativeRuntime = null }) {
  const problems = [];
  const ids = new Set(); const jobNames = new Set(jobs.map(j => j.name)); const negativeNames = new Set(negatives.map(n => n.name));
  if (descriptor.schemaVersion !== 'ssam-discovery-capabilities/1') problems.push('descriptor schemaVersion');
  for (const c of descriptor.capabilities ?? []) {
    if (!c.id || ids.has(c.id)) problems.push('duplicate or missing id: ' + c.id); ids.add(c.id);
    for (const field of ['category', 'title', 'keywords', 'summary', 'route']) if (c[field] == null) problems.push(c.id + ': missing ' + field);
    // A keyword is a string or an anchored form {form, with?, without?} whose form and terms keep a word and that can
    // count (request A-006; the same check as the pure catalog check).
    for (const k of Array.isArray(c.keywords) ? c.keywords : []) for (const p of keywordProblems(k)) problems.push(`${c.id}: ${p}`);
    for (const pointer of c.contract ?? []) if (!pointerExists(contracts, pointer)) problems.push(c.id + ': contract pointer does not resolve: ' + pointer);
    for (const job of c.proofs?.[descriptor.lane] ?? []) if (!jobNames.has(job)) problems.push(c.id + ': proof job not found: ' + job);
    for (const job of c.negative?.[descriptor.lane] ?? []) if (!negativeNames.has(job)) problems.push(c.id + ': negative job not found: ' + job);
    for (const d of c.depends ?? []) if (typeof d !== 'string' && (typeof d !== 'object' || !d.id || (d.unless != null && typeof d.unless !== 'string'))) problems.push(c.id + ': malformed dependency ' + JSON.stringify(d));
    // Shared capabilities (projected for this lane): every operation is stated per element ROLE declared in
    // `elements`; every proof/negative must exist in this lane's suites, every status must be one of the four, an
    // applicable role needs a proof job, a refused role needs a negative job or a note, an observed behaviour needs
    // the fact, the jobs that ran it, `integrity: not-verified` and what is missing; every native type must be found in
    // the lane runtime when measured.
    const roles = new Set((c.elements ?? []).map(e => e.role));
    for (const [op, def] of Object.entries(c.operations ?? {})) {
      if (!def.roles || typeof def.roles !== 'object' || Array.isArray(def.roles)) { problems.push(`${c.id}: operation ${op} has no roles (one statement per element role)`); continue; }
      for (const [role, r] of Object.entries(def.roles)) {
        const at = `${c.id}: operation ${op} role '${role}'`;
        if (!roles.has(role)) problems.push(`${at} is not a declared element role (${[...roles].join(', ')})`);
        if (!['applicable', 'conditional', 'not-applicable', 'undetermined'].includes(r.status)) problems.push(`${at} has an unknown status ${r.status}`);
        for (const job of r.proofs ?? []) if (!jobNames.has(job)) problems.push(`${at} proof job not found: ${job}`);
        for (const job of r.negative ?? []) if (!negativeNames.has(job)) problems.push(`${at} negative job not found: ${job}`);
        if (r.status === 'applicable' && !(r.proofs ?? []).length) problems.push(`${at} is applicable without a proof job`);
        if (r.status === 'conditional' && !(r.proofs ?? []).length && !(r.negative ?? []).length) problems.push(`${at} is conditional without a proof or a negative job`);
        if (r.status === 'not-applicable' && !(r.negative ?? []).length && !r.note) problems.push(`${at} is not-applicable without a negative job or a note`);
        if (r.status === 'undetermined' && (r.proofs ?? []).length) problems.push(`${at} is undetermined but lists proof jobs (put an observed behaviour under observed, never under proofs)`);
        if (r.observed != null) {
          const o = r.observed;
          if (typeof o !== 'object' || !o.behaviour) problems.push(`${at} observed without a behaviour`);
          if (o?.integrity !== 'not-verified') problems.push(`${at} observed must carry integrity: not-verified (an observed behaviour is never applicability)`);
          if (!Array.isArray(o?.missing) || !o.missing.length) problems.push(`${at} observed without what is missing to verify it`);
          for (const job of o?.proofs ?? []) if (!jobNames.has(job)) problems.push(`${at} observed job not found: ${job}`);
          if (!(o?.proofs ?? []).length) problems.push(`${at} observed without the job that ran it`);
        }
      }
    }
    if (nativeRuntime) for (const type of c.native ?? []) { const r = nativeRuntime[type]; if (r && r.found === false) problems.push(`${c.id}: native type ${type} not found in the lane runtime` + (r.candidates?.length ? ` (candidates: ${r.candidates.join(', ')})` : '')); }
  }
  for (const c of descriptor.capabilities ?? []) {
    for (const dep of c.depends ?? []) if (!ids.has(depId(dep))) problems.push(c.id + ': unknown dependency ' + depId(dep));
    for (const rec of c.recommends ?? []) if (!ids.has(depId(rec))) problems.push(c.id + ': unknown recommendation ' + depId(rec));
    for (const alt of c.alternatives ?? []) if (!ids.has(alt.id)) problems.push(c.id + ': unknown alternative ' + alt.id);
  }
  for (const u of descriptor.unavailable ?? []) {
    if (!u.id || !u.keywords || !u.reason) problems.push('unavailable entry incomplete: ' + u.id);
    for (const k of Array.isArray(u.keywords) ? u.keywords : []) for (const p of keywordProblems(k)) problems.push(`${u.id}: ${p}`);
    for (const job of u.negative?.[descriptor.lane] ?? []) if (!negativeNames.has(job)) problems.push(u.id + ': negative job not found: ' + job);
  }
  // The lane's synonyms after composition (lane, shared and fragment groups): variants are non-empty strings.
  problems.push(...synonymProblems(descriptor.synonyms));
  return problems;
}

// A capability (or unavailable entry) whose pointer into the extracted sources broke leaves the index with a note instead of
// failing every intent (atritos 2, A10): on 2026-10-06 a process of the 10th release kept running after the 11th was
// installed, and one pointer (`integration.rest-import: contract pointer does not resolve: rest.shapes`) refused 9 discovers
// in a row. Broken pointers are the references a release changes under a running process: a contract pointer that no longer
// resolves in the lane CLI, a proof, negative or observed job no longer in the suites, a native type the runtime no longer
// has. The references of the other capabilities to a dropped one leave with it. A problem of the descriptor's own shape
// (schema, duplicate or missing id, keywords, statuses, roles, a dependency that never existed) still refuses the build,
// and so does an entry that has one besides a broken pointer: only an entry whose every problem is a broken pointer leaves.
const BROKEN_POINTER = /^([^:\s]+): (?:.*\b(?:proof|negative|observed) job not found: |contract pointer does not resolve: |native type \S+ not found in the lane runtime)/;
export function pruneBrokenPointers(descriptor, sourcesOf) {
  const dropped = [];
  for (;;) {
    const problems = validateDescriptor(descriptor, sourcesOf);
    const ids = new Set([...(descriptor.capabilities ?? []).map(c => c.id), ...(descriptor.unavailable ?? []).map(u => u.id)]);
    const broken = new Map(); const shaped = new Set();
    for (const p of problems) {
      const owner = /^([^:\s]+): /.exec(p)?.[1];
      if (!owner || !ids.has(owner)) continue;
      if (BROKEN_POINTER.test(p)) broken.set(owner, [...(broken.get(owner) ?? []), p.slice(owner.length + 2)]);
      else shaped.add(owner);
    }
    for (const id of shaped) broken.delete(id);
    if (!broken.size) return { problems, dropped };
    for (const [id, list] of broken) dropped.push({ id, problem: list.slice(0, 3).join('; ') + (list.length > 3 ? ` (+${list.length - 3})` : '') });
    descriptor.capabilities = (descriptor.capabilities ?? []).filter(c => !broken.has(c.id));
    descriptor.unavailable = (descriptor.unavailable ?? []).filter(u => !broken.has(u.id));
    const gone = new Set(dropped.map(d => d.id));
    for (const c of descriptor.capabilities) {
      if (Array.isArray(c.depends)) c.depends = c.depends.filter(d => !gone.has(depId(d)));
      if (Array.isArray(c.recommends)) c.recommends = c.recommends.filter(r => !gone.has(depId(r)));
      if (Array.isArray(c.alternatives)) c.alternatives = c.alternatives.filter(a => !gone.has(a?.id));
    }
  }
}

// ---- index: built from the sources, keyed by their identity, reused while nothing changed.
// The key is cheap on purpose (a query must not hash the Studio): the Studio folder and the file names, sizes and
// mtimes of its runtime, of the fixture, of the native index, of the jobs and results; content hashes of the small
// inputs (descriptor, builder, CLI DLLs, NAO-DA). Detection limit: a file replaced by other bytes with the same size
// and mtime is not seen until `--rebuild`. The index itself records content hashes of the model DLLs, the fixture and
// the native index at build time, so the identity in every answer is exact for the moment the index was built.
// The builder is this file and catalog.mjs (composition, the keyword contract and the tokenization the build checks).
const builderSource = Buffer.concat([fs.readFileSync(fileURLToPath(import.meta.url)), fs.readFileSync(path.join(here, 'catalog.mjs'))]);
function listStamps(dir, pattern) {
  if (!exists(dir)) return ['absent:' + dir];
  try { return fs.readdirSync(dir).filter(f => pattern.test(f)).sort().map(f => f + ':' + stamp(path.join(dir, f))); } catch { return ['unreadable:' + dir]; }
}
// The Studio folder itself (resolved, case-folded on Windows): a copy of the installation keeps its names, sizes and
// times, and an index or a native probe measured on one folder is never reused for the other (as the reader generation,
// reader-client.mjs).
const studioFolder = dir => 'studioDir:' + (dir ? (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir)) : 'none');
export function identityKey(sources, descriptorBytes, sharedBytes = Buffer.alloc(0)) {
  const parts = [INDEX_SCHEMA, sources.lane, sha256(builderSource), sha256(descriptorBytes), sha256(sharedBytes)];
  for (const file of [sources.cli, sources.kernelDll]) parts.push(exists(file) ? sha256(fs.readFileSync(file)) : 'absent:' + file);
  parts.push(studioFolder(sources.studioDir), ...listStamps(sources.studioDir, /\.(dll|exe|json)$/i));
  parts.push('fixture:' + stamp(sources.fixture) + ':' + stamp(sources.fixture + '.json'));
  parts.push(...listStamps(sources.modelApiDir, /\.(json|md)$/i));
  for (const dir of [sources.jobsDir, sources.negativeDir, sources.testWork]) parts.push(...listStamps(dir, /\.json$/));
  if (sources.examplesDir) for (const dir of [sources.examplesDir, path.join(sources.testWork, 'examples')]) parts.push(...listStamps(dir, /\.json$/));
  parts.push(exists(sources.naoDa) ? sha256(fs.readFileSync(sources.naoDa)) : 'no-naoda');
  return sha256(parts.join('\n')).slice(0, 24);
}
export async function buildIndex(lane, { sources = laneSources(lane), descriptorFile = sources.descriptor, rebuild = false, persist = true } = {}) {
  const started = performance.now();
  if (!exists(descriptorFile)) throw new Error('No discovery descriptor for lane ' + lane + ' (' + path.basename(descriptorFile) + '): this lane is not covered; nothing is inferred');
  const descriptorBytes = fs.readFileSync(descriptorFile);
  const { bytes: sharedFileBytes, shared: sharedFile } = loadShared(sources.shared);
  // The shared descriptor composed with the catalog fragments: one shared/2 document, one identity (the file and
  // every fragment, in order). A fragment that does not compose (schema, duplicate id, double supersede) refuses the
  // build like a pointer that does not resolve.
  const catalog = composeCatalog({ shared: sharedFile, sharedBytes: sharedFileBytes, fragmentsDir: sources.fragments ?? FRAGMENTS_DIR });
  if (catalog.problems.length) throw new Error('discovery catalog fragments do not compose:\n' + catalog.problems.join('\n'));
  const shared = catalog.shared; const sharedBytes = catalog.fragments.length ? catalog.bytes : sharedFileBytes;
  const key = identityKey(sources, descriptorBytes, sharedBytes);
  const cached = path.join(sources.cacheDir, 'index-' + key + '.json');
  if (!rebuild && exists(cached)) { try { const index = readJson(cached); if (index.schemaVersion === INDEX_SCHEMA) return { index, cache: { hit: true, file: cached }, buildMs: Math.round(performance.now() - started) }; } catch { /* rebuild */ } }
  if (!exists(sources.cli)) throw new Error('The ' + lane + ' kernel CLI is not built (' + sources.cli + '; the index extracts its contracts from it): the integrator or the user builds it; ssam_doctor {lane:"' + lane + '"} reports the state.');
  const laneDescriptor = JSON.parse(descriptorBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (laneDescriptor.lane !== lane) throw new Error('Descriptor ' + path.basename(descriptorFile) + ' targets lane ' + laneDescriptor.lane + ', not ' + lane);
  // A fragment capability that `supersedes` a lane-own capability (or unavailable entry) replaces it on the lanes it
  // covers; references to the old id answer with the new one.
  const { descriptor, removed: superseded } = applySupersedes(laneDescriptor, catalog.supersedes, lane);
  // Shared capabilities, projected for this lane (proofs, negatives, limits, context, native types, operation statuses
  // of this lane only), appended to the lane's own; their synonyms complete the lane's.
  const sharedProjected = rewriteAliases(projectShared(shared, lane), catalog.supersedes, lane);
  const laneOwn = new Set((descriptor.capabilities ?? []).map(c => c.id));
  descriptor.capabilities = [...(descriptor.capabilities ?? []), ...sharedProjected.filter(c => !laneOwn.has(c.id))];
  descriptor.unavailable = [...(descriptor.unavailable ?? []), ...(shared?.unavailable ?? []).filter(u => !u.lanes || u.lanes.includes(lane))];
  // Same key = union of the variants (lane's first), as the contribution contract states; a fragment group used to
  // be replaced by a legacy lane group with the same key (request A-003).
  const laneSynonyms = descriptor.synonyms ?? {}; const sharedSynonyms = shared?.synonyms ?? {};
  descriptor.synonyms = Object.fromEntries([...new Set([...Object.keys(sharedSynonyms), ...Object.keys(laneSynonyms)])]
    .map(key => [key, [...new Set([...(laneSynonyms[key] ?? []), ...(sharedSynonyms[key] ?? [])])]]));
  const { contracts, timings } = await apiSchemas(sources);
  // Types the kernel synthesizes over native classes (EntityIndex on O11) have no Model API interface: they are not
  // probed in the runtime; the answer says so (provenance kernel).
  const synthesized = new Set(sharedProjected.flatMap(c => (c.elements ?? []).filter(e => e.runtime === 'kernel' && e.native).map(e => e.native)));
  const nativeTypes = [...new Set(sharedProjected.flatMap(c => c.native ?? []))].filter(t => !synthesized.has(t));
  const native = await nativeRuntime(sources, nativeTypes);
  for (const t of synthesized) native[t] = { found: true, provenance: 'kernel', note: 'no Model API interface on this lane: the kernel synthesizes the type over the native class (EntityIndexes.cs); the ledger names it by the class' };
  const studio = await studioIdentity(sources);
  const fixture = fixtureIdentity(sources);
  // The current identity, hashed on demand and only for what a stamp names (memoized): the Studio assemblies the
  // stamped runs had loaded, and the fixture each job declares as base.
  const hashed = new Map();
  const hashFile = file => { if (!hashed.has(file)) hashed.set(file, exists(file) ? sha256(fs.readFileSync(file)) : null); return hashed.get(file); };
  // A stamped assembly is a path relative to the Studio directory (plugins live in subfolders). An older stamp with a
  // bare file name is resolved through a one-time listing of the Studio tree; an ambiguous name (two files) is not
  // resolved, so it stays a mismatch instead of a guess.
  let studioFiles = null;
  const findByName = name => {
    if (!studioFiles) { studioFiles = new Map(); const walk = dir => { let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of entries) { const full = path.join(dir, e.name); if (e.isDirectory()) walk(full); else if (/\.dll$/i.test(e.name)) { const k = e.name.toLowerCase(); studioFiles.set(k, studioFiles.has(k) ? null : full); } } }; walk(sources.studioDir); }
    return studioFiles.get(name.toLowerCase()) ?? null;
  };
  const current = {
    ideVersion: studio.ideVersion ?? null, fixtureSha256: fixture.sha256?.toLowerCase() ?? null, kernelSha256: exists(sources.kernelDll) ? sha256(fs.readFileSync(sources.kernelDll)) : null,
    assemblyHash: exists(sources.studioDir) ? name => { if (!/^[A-Za-z0-9_.+\-/\\ ]+\.dll$/i.test(name)) return null; const direct = path.join(sources.studioDir, name); if (exists(direct)) return hashFile(direct); const found = name.includes('/') || name.includes('\\') ? null : findByName(name); return found ? hashFile(found) : null; } : null,
    baseHash: spec => { if (typeof spec !== 'string' || !spec.endsWith('.oml')) return null; const candidates = path.isAbsolute(spec) ? [spec] : [path.join(sources.kernel, spec), path.join(sources.kernel, 'tests', 'fixtures', spec)]; const fixtures = path.join(sources.kernel, 'tests', 'fixtures') + path.sep; const found = candidates.map(c => path.resolve(c)).find(c => c.toLowerCase().startsWith(fixtures.toLowerCase()) && exists(c)); return found ? hashFile(found) : null; },
  };
  const jobs = classifyExecutions(loadJobs(sources), current); const negatives = loadNegatives(sources); const limits = loadLimits(sources);
  studio.assemblies = Object.fromEntries([...hashed].filter(([f]) => f.toLowerCase().startsWith(sources.studioDir.toLowerCase())).map(([f, h]) => [path.basename(f), h ? h.slice(0, 16) : null]));
  const { problems, dropped } = pruneBrokenPointers(descriptor, { contracts, jobs, negatives, nativeRuntime: native });
  if (problems.length) throw new Error('discovery descriptor does not match the extracted sources:\n' + problems.join('\n'));
  if (dropped.length) {
    const gone = new Set(dropped.map(d => d.id));
    for (let i = sharedProjected.length - 1; i >= 0; i--) if (gone.has(sharedProjected[i].id)) sharedProjected.splice(i, 1);
  }
  const executed = jobs.filter(j => j.executed);
  const index = {
    schemaVersion: INDEX_SCHEMA, lane, key, builtAt: new Date().toISOString(), buildMs: null,
    identity: {
      cli: { path: path.relative(sources.kernel, sources.cli).replaceAll('\\', '/'), sha256: sha256(fs.readFileSync(sources.cli)).slice(0, 16), kernelSha256: current.kernelSha256?.slice(0, 16) ?? null, apiMs: timings },
      studio, fixture, modelApi: modelApiIdentity(sources),
      descriptor: { file: path.basename(descriptorFile), sha256: sha256(descriptorBytes).slice(0, 16), reviewedAt: descriptor.reviewedAt ?? null, capabilities: descriptor.capabilities.length, laneCapabilities: descriptor.capabilities.filter(c => laneOwn.has(c.id)).length,
        shared: shared ? { file: path.basename(sources.shared), sha256: sha256(sharedFileBytes).slice(0, 16), reviewedAt: shared.reviewedAt ?? null, lanes: shared.lanes ?? [], capabilities: sharedProjected.map(c => c.id),
          ...(catalog.fragments.length ? { catalogSha256: sha256(sharedBytes).slice(0, 16), fragments: catalog.fragments.map(f => ({ front: f.front, file: f.file, sha256: f.sha256, capabilities: f.capabilities.length, unavailable: f.unavailable.length, coverage: f.coverage })), superseded } : {}) } : null },
      nativeRuntime: { types: nativeTypes.length, found: Object.values(native).filter(n => n.found).length, ideVersion: Object.values(native).find(n => n.ideVersion)?.ideVersion ?? null, probes: native._probe ? { cached: native._probe.cached, probed: native._probe.probed } : null, note: 'api --op native --type on the lane CLI: the contract of each native type of the shared capabilities as loaded in the installed Studio (provenance A-runtime); answers kept per type under the CLI/kernel/Studio identity' },
      jobs: { dir: path.relative(sources.kernel, sources.jobsDir).replaceAll('\\', '/'), count: jobs.length, examples: jobs.filter(j => j.name.startsWith('examples/')).length, results: executed.length,
        current: executed.filter(j => j.executed.current).length, historical: executed.filter(j => !j.executed.current).length, suite: sources.suite },
      negatives: negatives.length, limits: limits.length,
      keyStrategy: 'Studio folder; names+size+mtime of Studio runtime, fixture, native index, jobs and results; content hashes of descriptor, builder, CLI DLLs and NAO-DA; model DLLs, fixture and native index hashed at build',
    },
    provenance: {
      described: 'the capability is in the curated descriptor (guidance)',
      B: 'the kernel accepts the op: contract extracted from the lane CLI (`api --op`), the same table the dispatcher enforces',
      'C-suite': 'a job of the lane suite exists for it (headless proof when the suite runs)',
      'C-executed-historical': 'a result of that job exists on this machine, but it was not accepted, or its provenance stamp is missing, incomplete, or differs from the current identity in at least one component (mismatches say which)',
      'C-executed-current': 'an accepted result of that job whose stamp matches, component by component, the current job text, the base it declares (fixture hashed now, or a base job that is itself current), the lane fixture, the kernel DLL, the Studio version and every Studio assembly the stamped run had loaded; nothing undetermined on either side',
      A: 'native Model API metadata: reflection index of an installed Studio (identity.modelApi); existence there does not mean the kernel executes it',
      'A-runtime': 'native type contract read by reflection from the Studio this lane CLI binds (api --op native): writable properties and bases of the installed version, not of the older index',
      D: 'present in the examined application capture (context.*, bound to sourceSha256)',
      'refusal-proven': 'a negative job of the lane suite proves the platform (or the kernel) refuses the operation with the recorded message',
    },
    contracts, capabilities: descriptor.capabilities, unavailable: descriptor.unavailable ?? [], synonyms: descriptor.synonyms ?? {}, routes: descriptor.routes ?? {},
    nativeRuntime: native, shared: shared ? { lanes: shared.lanes ?? [], capabilities: sharedProjected.map(c => c.id), note: shared.note ?? null } : null,
    jobs, negatives, limits,
    ...(dropped.length ? { dropped } : {}),
  };
  index.buildMs = Math.round(performance.now() - started);
  if (persist) { try { fs.mkdirSync(sources.cacheDir, { recursive: true }); fs.writeFileSync(cached, JSON.stringify(index)); } catch { /* the cache never blocks an answer */ } }
  return { index, cache: { hit: false, file: cached }, buildMs: index.buildMs };
}

// ---- shared capabilities: one definition serves both lanes; the lane sees only its own projection.
export function loadShared(file) {
  if (!file || !exists(file)) return { bytes: Buffer.alloc(0), shared: null };
  const bytes = fs.readFileSync(file);
  return { bytes, shared: JSON.parse(bytes.toString('utf8').replace(/^﻿/, '')) };
}
export const SHARED_SCHEMA = 'ssam-discovery-capabilities-shared/2';
// The projection keeps what is common once (identity, route, contract pointers, guidance, the operations' route and
// preconditions) and takes, for each operation, one statement per element ROLE for this lane: status, proof jobs,
// negative jobs, the scope the proof established, an observed behaviour whose integrity is not verified, and the
// other lanes' declared status for the same role. A role not stated for an operation is undetermined.
export function projectShared(shared, lane) {
  if (!shared || !(shared.lanes ?? []).includes(lane)) return [];
  if (shared.schemaVersion !== SHARED_SCHEMA) throw new Error(`shared descriptor schemaVersion ${shared.schemaVersion}; expected ${SHARED_SCHEMA} (operations stated per element role)`);
  const others = (shared.lanes ?? []).filter(l => l !== lane);
  return (shared.capabilities ?? []).filter(c => !c.lanes || c.lanes.includes(lane)).map(c => {
    const p = c.platforms?.[lane] ?? {};
    const elements = (c.elements ?? []).map(e => ({ role: e.role, child: e.child === true, ...(e.platforms?.[lane] ?? {}), otherLanes: Object.fromEntries(others.map(o => [o, e.platforms?.[o]?.native ?? null])) }));
    const nativeOfRole = Object.fromEntries(elements.map(e => [e.role, e.native ?? null]));
    const operations = Object.fromEntries(Object.entries(c.operations ?? {}).map(([op, def]) => {
      const roles = Object.fromEntries(Object.entries(def.roles ?? {}).map(([role, byLane]) => {
        const mine = byLane?.[lane] ?? {};
        return [role, { native: nativeOfRole[role] ?? null, status: mine.status ?? 'undetermined', proofs: mine.proofs ?? [], negative: mine.negative ?? [], scope: mine.scope ?? null, note: mine.note ?? null, alternative: mine.alternative ?? null,
          ...(mine.verbs ? { verbs: mine.verbs } : {}), ...(mine.props ? { props: mine.props } : {}), observed: mine.observed ?? null,
          otherLanes: Object.fromEntries(others.map(o => [o, { status: byLane?.[o]?.status ?? 'undetermined', note: byLane?.[o]?.note ?? null, ...(byLane?.[o]?.observed ? { observed: 'behaviour observed there too; integrity not verified' } : {}) }])) }];
      }));
      return [op, { route: def.route ?? null, preconditions: def.preconditions ?? [], roles }];
    }));
    const { platforms, elements: _elements, operations: _operations, ...common } = c;
    // A reference may hold on some lanes only ({id, lanes: ['odc']}, request B-001): off its lanes it is dropped from
    // this projection, on them it is kept without the `lanes` key.
    for (const k of ['depends', 'recommends', 'alternatives']) if (Array.isArray(common[k]))
      common[k] = common[k].filter(e => !(e && typeof e === 'object' && Array.isArray(e.lanes)) || e.lanes.includes(lane))
        .map(e => (e && typeof e === 'object' && e.lanes ? (({ lanes: _l, ...rest }) => rest)(e) : e));
    return { ...common, shared: true, lanes: c.lanes ?? shared.lanes, proofs: { [lane]: p.proofs ?? [] }, negative: { [lane]: p.negative ?? [] }, context: p.context ?? null, limits: p.limits ?? [],
      differences: p.differences ?? [], otherLaneDifferences: Object.fromEntries(others.map(o => [o, c.platforms?.[o]?.differences ?? []])),
      elements, native: [...new Set(elements.map(e => e.native).filter(Boolean))], operations };
  });
}
// The contract of each native type as loaded in the Studio this lane binds (`api --op native --type`), memoized in
// the index: writable properties and bases of the INSTALLED version, which the older reflection index may not have.
// Each probe is one CLI process (~0.7 s); a catalog with hundreds of native types made every rebuild take minutes
// (catalog M2, 2026-09-23: 75 ODC types 63 s, 126 O11 types 85 s). A probe depends only on the CLI, the kernel DLL
// and the Studio runtime it binds (its folder and its files), so its answer is kept per type under that identity
// (native-<key>.json in the lane cache) and a rebuild probes only the types it has not seen; the misses run a few at
// a time.
export function nativeCacheKey(sources) {
  const parts = ['native/1'];
  for (const file of [sources.cli, sources.kernelDll]) parts.push(exists(file) ? sha256(fs.readFileSync(file)) : 'absent:' + file);
  parts.push(studioFolder(sources.studioDir), ...listStamps(sources.studioDir, /\.(dll|exe|json)$/i));
  return sha256(parts.join('\n')).slice(0, 24);
}
async function nativeRuntime(sources, types, { concurrency = Number(process.env.SSAM_DISCOVERY_NATIVE_CONCURRENCY ?? 3) || 1 } = {}) {
  const cacheFile = sources.cacheDir ? path.join(sources.cacheDir, 'native-' + nativeCacheKey(sources) + '.json') : null;
  let cache = {};
  if (cacheFile && exists(cacheFile)) { try { cache = readJson(cacheFile); } catch { cache = {}; } }
  const out = {}; const missing = [];
  for (const type of types) { if (cache[type] && !cache[type].error) out[type] = cache[type]; else missing.push(type); }
  const probe = async type => {
    try {
      const { stdout } = await cli(sources, ['api', '--op', 'native', '--type', type]);
      const envelope = JSON.parse(stdout); const d = envelope.ok ? envelope.data : null;
      const hit = d?.candidates?.find(c => c.fullName === type) ?? null;
      out[type] = hit ? { found: true, platform: d.platform, ideVersion: d.ideVersion, assembly: hit.assembly, bases: hit.bases, writable: hit.writable, properties: hit.properties.length, methods: hit.methods }
        : { found: false, platform: d?.platform ?? null, ideVersion: d?.ideVersion ?? null, candidates: (d?.candidates ?? []).map(c => c.fullName), error: envelope.error ?? null };
    } catch (error) { out[type] = { found: false, error: String(error.stderr || error.message).split(/\r?\n/).find(Boolean) }; }
  };
  const queue = [...missing];
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => { while (queue.length) await probe(queue.shift()); }));
  // A probe that failed to run (error) is not kept: it is retried on the next build instead of being remembered.
  if (cacheFile && missing.length) { try { fs.mkdirSync(sources.cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ ...cache, ...Object.fromEntries(missing.filter(t => !out[t].error || out[t].found === false && out[t].platform).map(t => [t, out[t]])) })); } catch { /* the cache never blocks a build */ } }
  return Object.defineProperty(out, '_probe', { value: { cached: types.length - missing.length, probed: missing.length, cacheFile }, enumerable: false });
}
const OP_VERBS = { read: ['get', 'dump', 'find'], usages: ['usages'], create: ['create', 'spec'], set: ['set', 'link'], rename: ['rename', 'set'], replace: ['replace'], move: ['move'], duplicate: ['duplicate'], delete: ['delete'] };
const OP_PRIORITY = ['replace', 'delete', 'rename', 'move', 'duplicate', 'set', 'usages', 'read', 'create'];
// Canonical intent terms (descriptor synonyms) that name an operation; `create` words are stopwords, so creation is
// never a focus (the capability's default example serves it).
const OP_TERMS = { rename: ['rename'], delete: ['delete'], move: ['reorder', 'move'], duplicate: ['duplicate'], replace: ['replace'], set: ['edit'], usages: ['usages', 'usage', 'consumers', 'consumidores'], read: ['read', 'ler', 'inspect', 'dump'] };
const OPERATION_CANONICALS = new Set(Object.values(OP_TERMS).flat().map(w => tokens(w)[0] ?? w));
export const EVIDENCE_RULE = 'evidence is stated per element role, operation and lane: a proof on one role (a record) never counts for another (its entity), a proof on one lane never counts for the other, an executed verb proves execution on that type only (not semantic preservation or integrity), an observed behaviour with integrity not verified is never applicability, and a role not stated for an operation is undetermined';
// The evidence of one job for one verb set on ONE qualified native type: the ledger by interface (write verbs; a
// required property narrows it, e.g. set Identifier), and the per-op executions of the result (read verbs, and the
// facts of the ops that ran on that type). Nothing here looks at the other types of the same job.
function jobEvidenceFor(job, native, verbs, props = null) {
  if (!job?.executed || !native) return null;
  const ledger = job.executed.coverageQualified?.[native] ?? null;
  const ledgerVerbs = ledger ? ledger.verbs.filter(v => verbs.includes(v)).filter(v => !props || v !== 'set' || props.every(p => ledger.props.includes(p))) : [];
  const runs = (job.executed.executions ?? []).filter(x => x.iface === native && verbs.includes(x.verb) && (!props || x.verb !== 'set' || props.includes(x.fact?.prop)));
  const verbsRan = [...new Set([...ledgerVerbs, ...runs.map(x => x.verb)])];
  if (!verbsRan.length) return null;
  const via = [...new Set([...(ledgerVerbs.length ? ['ledger-qualified'] : []), ...runs.map(x => x.via).filter(Boolean)])];
  return { verbs: verbsRan, via, ops: runs.map(x => ({ i: x.i, verb: x.verb, ...(x.fact ? { fact: x.fact } : {}) })).slice(0, 12) };
}
// Per operation of a shared capability, on this lane, one statement per element ROLE: the declared status, the
// evidence computed for that role's qualified native type only (current vs historical, verb on that type), the
// scope the proof established, the negative jobs with their refusal texts, an observed behaviour with integrity not
// verified (never applicability), the other lanes' declared status; plus a family summary that says which roles are
// covered and which are not. `focus` orders the focused roles and operations first.
export function operationsOf(index, c, { focus = null } = {}) {
  if (!c.operations) return null;
  const allRoles = (c.elements ?? []).map(e => e.role);
  const roleOrder = [...(focus?.roles ?? []), ...allRoles.filter(r => !(focus?.roles ?? []).includes(r))];
  const opOrder = [...(focus?.ops ?? []), ...Object.keys(c.operations).filter(op => !(focus?.ops ?? []).includes(op))];
  const out = {};
  for (const op of opOrder) {
    const def = c.operations[op]; if (!def) continue;
    const roles = {};
    for (const role of roleOrder) {
      const r = def.roles?.[role]; if (!r) continue;
      const verbs = r.verbs ?? OP_VERBS[op] ?? [];
      const proofs = (r.proofs ?? []).map(name => {
        const job = index.jobs.find(j => j.name === name); const level = jobLevel(job);
        const evidence = jobEvidenceFor(job, r.native, verbs, r.props ?? null);
        return { job: name, level, ...(evidence ? { verified: evidence } : {}), ...(job?.executed?.mismatches?.length ? { mismatches: job.executed.mismatches.length } : {}) };
      });
      const negative = (r.negative ?? []).map(n => { const j = index.negatives.find(k => k.name === n); return { job: n, refuses: j?.expectError ?? [] }; });
      const current = proofs.filter(p => p.level === 'C-executed-current' && p.verified);
      const historical = proofs.filter(p => p.level === 'C-executed-historical' && p.verified);
      let level; let evidence;
      if (r.status === 'not-applicable') { level = negative.length ? 'refusal-proven' : 'declared'; evidence = negative.length ? 'refusal-proven' : 'refusal-declared'; }
      else if (r.status === 'undetermined') { level = 'undetermined'; evidence = 'undetermined'; }
      else if (current.length) { level = 'C-executed-current'; evidence = 'proven-current'; }
      else if (historical.length) { level = 'C-executed-historical'; evidence = 'proven-historical'; }
      else { level = proofs.some(p => p.level === 'C-suite') ? 'C-suite' : 'declared'; evidence = 'declared-not-proven'; }
      const verifiedQualified = current.length || historical.length ? 'yes' : r.status === 'not-applicable' || r.status === 'undetermined' ? 'n/a' : proofs.some(p => p.level.startsWith('C-executed')) ? `no (no executed result names ${verbs.join('/')} on ${r.native})` : 'n/a (no executed result)';
      const observed = r.observed ? { behaviour: r.observed.behaviour, integrity: r.observed.integrity, missing: r.observed.missing ?? [], caution: r.observed.caution ?? null,
        ran: (r.observed.proofs ?? []).map(name => { const job = index.jobs.find(j => j.name === name); const e = jobEvidenceFor(job, r.native, verbs); return { job: name, level: jobLevel(job), ...(e ? { ops: e.ops } : { ops: [] }) }; }),
        note: 'observed = it ran and was read back; not a proof of integrity and never a recommendation' } : null;
      roles[role] = { native: r.native, status: r.status, evidence, level, verifiedQualified, scope: r.scope ?? null, note: r.note ?? null, ...(r.alternative ? { alternative: r.alternative } : {}), proofs, negative, ...(observed ? { observed } : {}), otherLanes: r.otherLanes ?? {} };
    }
    out[op] = { route: def.route ?? null, preconditions: def.preconditions ?? [], summary: familySummary(index.lane, allRoles, roles), roles };
  }
  return out;
}
// The family summary of one operation on this lane: which roles are proven (current), conditional, refused,
// historical, declared but not proven, undetermined (with an observed behaviour or not), not stated. Coverage is
// complete only when every declared role is proven, conditional or refused with current evidence.
function familySummary(lane, allRoles, roles) {
  const buckets = { proven: [], conditional: [], refused: [], historical: [], declaredNotProven: [], undetermined: [], notStated: [] };
  for (const role of allRoles) {
    const r = roles[role];
    if (!r) { buckets.notStated.push(role); continue; }
    const tag = r.observed ? `${role} (observed: ${r.observed.integrity} integrity)` : role;
    if (r.evidence === 'proven-current') buckets[r.status === 'conditional' ? 'conditional' : 'proven'].push(tag);
    else if (r.evidence === 'proven-historical') buckets.historical.push(tag);
    else if (r.evidence.startsWith('refusal')) buckets.refused.push(r.alternative ? `${role} (alternative: ${r.alternative})` : tag);
    else if (r.evidence === 'declared-not-proven') buckets.declaredNotProven.push(tag);
    else buckets.undetermined.push(tag);
  }
  const covered = buckets.proven.length + buckets.conditional.length + buckets.refused.length;
  const uncovered = buckets.historical.length + buckets.declaredNotProven.length + buckets.undetermined.length + buckets.notStated.length;
  const coverage = uncovered === 0 && covered > 0 ? 'complete' : covered > 0 ? 'partial' : 'none';
  const parts = [];
  if (buckets.proven.length) parts.push('proven (current) on ' + buckets.proven.join(', '));
  if (buckets.conditional.length) parts.push('conditional (proven under its precondition) on ' + buckets.conditional.join(', '));
  if (buckets.refused.length) parts.push('refused on ' + buckets.refused.join(', '));
  if (buckets.historical.length) parts.push('historical evidence only on ' + buckets.historical.join(', '));
  if (buckets.declaredNotProven.length) parts.push('declared but not proven on ' + buckets.declaredNotProven.join(', '));
  if (buckets.undetermined.length) parts.push('undetermined on ' + buckets.undetermined.join(', '));
  if (buckets.notStated.length) parts.push('not stated (undetermined) for ' + buckets.notStated.join(', '));
  return { coverage, ...buckets, text: `${coverage} coverage on ${lane}: ${parts.join('; ')}` };
}
// Which element role(s) and operation(s) of a shared capability the intent names, from the canonical terms: a child
// role (record, attribute, value) wins over its container when both are named, because the container is usually the
// context ("a record of the static entity"). With no role named, the compact options are listed instead.
// Words of an intent that ask for creation: they are stopwords for matching (every request "creates" something), so the
// focus reads them from the raw intent to choose the create operation when no other operation is named.
const CREATION = /\b(criar|crie|criando|create|creating|new|novo|nova|novos|novas|add|adicionar|acrescentar|declarar|declare|definir|define|modelar|model)\b/i;
export function focusOf(c, terms, intent = '') {
  if (!c.shared || !c.elements?.length) return null;
  const has = t => terms.includes(t);
  const headOf = e => (e.role === 'identifier type' ? 'identifier' : tokens(e.role).at(-1));
  const hits = c.elements.filter(e => { const head = headOf(e); return has(head) || (e.role === 'static entity' && (has('static') || has('entidade'))) || (e.role === 'server entity' && has('entidade')) || (e.role === 'record value' && has('valor')); });
  // Two roles with the same head word (entity attribute / index attribute): when the intent also names the qualifier of
  // one of them, the other is dropped; otherwise both stay and the answer lists them.
  const qualified = hits.filter(e => tokens(e.role).every(has));
  const disambiguated = hits.filter(e => !hits.some(o => o !== e && headOf(o) === headOf(e) && qualified.includes(o) && !qualified.includes(e)));
  // A child role (record, attribute, value) wins over its container when both are named: the container is the context.
  const children = disambiguated.filter(e => e.child);
  const roles = (children.length ? children : disambiguated).map(e => e.role);
  // Every role the intent named, containers included: the example covers all of them (a refactor that renames an
  // attribute AND replaces an index needs the ops of both); `roles` keeps the child-first order for the statement.
  const allRoles = disambiguated.map(e => e.role);
  const ops = OP_PRIORITY.filter(op => c.operations?.[op] && (OP_TERMS[op] ?? []).some(t => has(tokens(t)[0] ?? t)));
  // Creation words add `create` (last: the other operations named come first), alone or beside other operations.
  if (c.operations?.create && !ops.includes('create') && CREATION.test(String(intent ?? ''))) ops.push('create');
  return { roles, ...(allRoles.length > roles.length ? { allRoles } : {}), ops, ...(roles.length ? { note: 'the intent names the element role: its statement and example come first; every other role keeps its own evidence' }
    : { options: c.elements.map(e => ({ role: e.role, native: e.native ?? null, address: e.address ?? null })), note: 'the intent does not name the element role; each role has its own evidence (a proof on one role never counts for another): name the role, or read operations.<op>.roles' }) };
}
export function nativeOf(index, c) {
  if (!c.elements) return null;
  return c.elements.map(e => { const r = e.native ? index.nativeRuntime?.[e.native] : null; return { role: e.role, native: e.native ?? null, jobType: e.jobType ?? null, address: e.address ?? null, note: e.note ?? null, otherLanes: e.otherLanes ?? {},
    runtime: r ? (r.provenance === 'kernel' ? { provenance: 'kernel', note: r.note } : r.found ? { provenance: 'A-runtime', ideVersion: r.ideVersion, assembly: r.assembly, writable: r.writable, bases: r.bases } : { provenance: 'A-runtime', found: false, ideVersion: r.ideVersion ?? null, error: r.error ?? null, candidates: r.candidates ?? [] }) : null }; });
}
// The O11 capture reader for --app / element:, through the lane's resident reader (kernel-reading.mjs), with the same
// request/answer shape the ODC reader has (both present the SnapshotReading envelope).
export function o11Inspect(sources = laneSources('o11')) {
  return async request => {
    const { kernelReading } = await import('./kernel-reading.mjs'); const { LANES } = await import('./lanes.mjs');
    const argv = ['--oml', request.target, '--ss-dir', sources.studioDir];
    const opt = (flag, v) => { if (v != null && v !== '') argv.push(flag, String(v)); };
    opt('--path', request.path ?? '/'); opt('--kind', request.kind); opt('--name', request.name); opt('--text', request.text); opt('--properties', request.properties);
    opt('--depth', request.depth); opt('--max', request.max); opt('--offset', request.offset); opt('--budget', request.budget); opt('--expectedSourceSha256', request.expectedSourceSha256);
    for (const s of request.select ?? []) argv.push('--select', s);
    if (request.usages) argv.push('--usages');
    const r = await kernelReading({ ...LANES.o11, cli: sources.cli, root: sources.kernel }, argv);
    return r?.data ?? r;
  };
}
export function laneInspect(lane, odcInspect) { return lane === 'odc' ? odcInspect : lane === 'o11' ? o11Inspect() : null; }
// The kind reads of --app come from the module index of the capture (module-map.mjs); its miss builds the index in the
// same lane reader o11Inspect/odc inspect use. Text and select reads stay on the reader.
export function laneMap(lane, sources = laneSources(lane)) {
  if (!['odc', 'o11'].includes(lane)) return null;
  const reader = lane === 'o11' ? { entry: { cli: sources.cli, root: sources.kernel, lane: sources.o11Lane.name }, ssDir: sources.studioDir } : {};
  return async request => (await import('./module-map.mjs')).moduleMap({ ...request, lane }, { reader });
}
// The module digest of `app` for the work packet (module-map.mjs moduleDigest): the same lane reader and Studio as laneMap.
export function laneDigest(lane, sources = laneSources(lane)) {
  if (!['odc', 'o11'].includes(lane)) return null;
  const reader = lane === 'o11' ? { entry: { cli: sources.cli, root: sources.kernel, lane: sources.o11Lane.name }, ssDir: sources.studioDir } : {};
  return async target => (await import('./module-map.mjs')).moduleDigest({ lane, target }, { reader });
}

// ---- matching
// A keyword entry as the matcher reads it (request A-006): its form in tokens, and for an ANCHORED keyword
// ({form, with?, without?} in the descriptor) its anchor terms in tokens. An anchored keyword counts only when the
// intent also says one of its `with` terms (when it has any) and none of its `without` terms; without them it never
// scores, so a front can give a generic word ("variaveis", "ramo falso", "excluir a action") to one capability only in
// the context of the element it names.
const phraseOf = text => tokens(text).join(' ');
// An anchor term: its tokens, and for a one-word term whether its word lost a derivational suffix ("configuracao" ->
// "configura"): such a term is said only by a derived word of the intent, as a synonym variant is (request C-010).
const termOf = text => { const w = words(text); return { phrase: w.map(stem).join(' '), derived: w.length === 1 && derived(w[0]) }; };
function keywordEntry(k) {
  if (!k || typeof k !== 'object' || Array.isArray(k)) return { form: phraseOf(k), anchored: false };
  const list = v => (Array.isArray(v) ? v.map(termOf).filter(t => t.phrase) : null);
  return { form: phraseOf(k.form), anchored: true, with: list(k.with), without: list(k.without) ?? [] };
}
// Memoized per descriptor object: an index is not changed once built.
const TEXT = new WeakMap();
function capabilityText(c) {
  if (!TEXT.has(c)) TEXT.set(c, { keywords: (c.keywords ?? []).map(keywordEntry), title: tokens(c.title), summary: tokens(c.summary) });
  return TEXT.get(c);
}
const ENTRIES = new WeakMap();
const keywordEntries = u => { if (!ENTRIES.has(u)) ENTRIES.set(u, (u.keywords ?? []).map(keywordEntry)); return ENTRIES.get(u); };
// The capabilities each single-word keyword token belongs to (canonicalize's `owners`), once per index: the plain
// keywords. An anchored one-word form claims its word only in the intents where its context holds (query()).
const OWNERS = new WeakMap();
function keywordOwners(index) {
  if (!OWNERS.has(index)) { const owners = new Map(); for (const c of index.capabilities ?? []) for (const k of capabilityText(c).keywords) if (!k.anchored && k.form && !k.form.includes(' ')) { if (!owners.has(k.form)) owners.set(k.form, new Set()); owners.get(k.form).add(c.id); } OWNERS.set(index, owners); }
  return OWNERS.get(index);
}
// The one-word synonym canonicals of an index, by their fold, once per index: an anchor term that is one is said by
// every variant of its group on that lane, as a one-word keyword is.
const CANONICALS = new WeakMap();
function canonicalTerms(index) {
  if (!CANONICALS.has(index)) CANONICALS.set(index, new Map(Object.keys(index.synonyms ?? {}).map(phraseOf).filter(k => k && !k.includes(' ')).map(k => [fold(k), k])));
  return CANONICALS.get(index);
}
// `why` words: an anchored keyword appears as "<form> [<word>]", the intent word that said a with-term.
const whyWords = w => w.split(/[^a-z0-9_]+/).filter(Boolean);
// Words that name an OPERATION or a generic notion, never an element: for a shared family (a capability that declares
// element roles) they alone never make a direct match, because "replace" or "delete" belongs to every family.
const OPERATION_WORDS = new Set([...Object.values(OP_TERMS).flat(), 'edit', 'existing', 'exist', 'existente', 'refactor', 'data', 'dado', 'model', 'modelo', 'read', 'inspect', 'create', 'set', 'usages', 'usage'].map(w => tokens(w)[0] ?? w));
// The one-word forms that name an operation, once per index: the operation words and the whole one-word variants of
// their synonym groups ("excluir", "apagar" of delete). An ANCHORED one-word form among them is an operation hit, as
// "delete" is, in either language (request A-006); plain keywords keep OPERATION_WORDS.
const OPERATION_FORMS = new WeakMap();
function operationForms(index) {
  if (!OPERATION_FORMS.has(index)) {
    const set = new Set(OPERATION_WORDS);
    for (const [canonical, variants] of Object.entries(index.synonyms ?? {})) if (OPERATION_WORDS.has(phraseOf(canonical))) for (const v of variants) if (typeof v === 'string' && normalize(v).split(/[^a-z0-9_]+/).filter(Boolean).length === 1 && phraseOf(v)) set.add(phraseOf(v));
    OPERATION_FORMS.set(index, set);
  }
  return OPERATION_FORMS.get(index);
}
const LEXICAL_NOISE = new Set(['odc', 'o11', 'outsystem', 'outsystems', 'lane', 'faixa'].map(w => tokens(w)[0] ?? w));
// `gate(entry)` (query(), per intent): for an anchored keyword, null when its context is absent (no `with` term said,
// or a `without` term said), otherwise the intent word that said a `with` term ('' for a keyword with `without` only);
// '' for a plain keyword. `isOperation(form)`: an anchored one-word form that names an operation (operationForms).
// `anchoredHits`: element hits of anchored keywords. An anchored keyword that counts is the front's statement that, in
// this context, the form names one of the capability's elements: it names the capability's family (query() then does
// not demote it as a family named only through a generic word). An operation form is not an element hit and names no
// family.
function scoreCapability(c, terms, consumed = new Map(), says = () => false, gate = () => '', isOperation = w => OPERATION_WORDS.has(w)) {
  const text = capabilityText(c); const why = new Set(); const labels = new Map(); let score = 0; let elementHits = 0; let operationHits = 0; let anchoredHits = 0;
  const counted = new Set(); // the words of the keywords that counted, by fold
  const credit = (e, points, element) => { score += points; why.add(e.form); for (const w of e.form.split(' ')) counted.add(fold(w)); if (element) elementHits++; else operationHits++; if (e.anchored && element) anchoredHits++; const anchor = gate(e); if (anchor) labels.set(e.form, `${e.form} [${anchor}]`); };
  // The keywords that name a canonical, for the consumed-word rule below: an anchored one only in its context.
  const names = k => text.keywords.some(e => e.form === k && gate(e) !== null);
  for (const e of text.keywords) {
    const keyword = e.form;
    if (!keyword) continue;
    if (keyword.includes(' ')) { if (says(keyword) && gate(e) !== null) credit(e, 4, true); continue; }
    if (!terms.includes(keyword) || gate(e) === null) continue;
    // A token consumed by a multi-word form ("entity" in "static entity") credits only the families whose keywords
    // name that form's canonical ("static"); for the others it is context, not a hit.
    if (consumed.has(keyword) && ![...consumed.get(keyword)].some(names)) continue;
    credit(e, 3, !(e.anchored ? isOperation(keyword) : OPERATION_WORDS.has(keyword)));
  }
  // The anchor governs its word ALONE for the whole capability: out of its context a one-word anchored form credits
  // neither as a keyword nor as a word of the title or summary (compared through fold), unless a plain one-word keyword
  // of the capability has the word or a keyword that counted in this intent contains it ("screen preparation" said:
  // "preparation" is not alone) (request A-006).
  const muted = t => { if (counted.has(fold(t))) return false; const same = text.keywords.filter(e => e.form && !e.form.includes(' ') && fold(e.form) === fold(t)); return same.length > 0 && same.every(e => e.anchored && gate(e) === null); };
  // Lane and product names in a title or summary say where a capability applies, not what it is about: they never
  // select it (request C-008: "ODC"/"O11" in titles picked unrelated capabilities).
  for (const t of terms) { if (LEXICAL_NOISE.has(t) || muted(t)) continue; if (text.title.includes(t) && !why.has(t)) { score += 2; why.add(t); if (!OPERATION_WORDS.has(t)) elementHits++; else operationHits++; } else if (text.summary.includes(t) && !why.has(t)) { score += 1; why.add(t); } }
  return { score, why: [...why].map(w => labels.get(w) ?? w), elementHits, operationHits, anchoredHits };
}
function scoreJob(job, terms) {
  const text = tokens(job.name.replaceAll('-', ' ') + ' ' + job.description + ' ' + job.notes.map(n => n.text).join(' '));
  const hits = terms.filter(t => text.includes(t));
  return { score: hits.length, why: hits };
}
export function jobLevel(job) {
  if (!job?.executed || job.executed.status === 'unreadable') return 'C-suite';
  return job.executed.current === true ? 'C-executed-current' : 'C-executed-historical';
}
function proofsOf(index, c, { full = false } = {}) {
  return (c.proofs?.[index.lane] ?? []).map(name => {
    const job = index.jobs.find(j => j.name === name);
    const level = jobLevel(job);
    const brief = { job: name, level, ...(job?.executed?.mismatches?.length ? { mismatches: job.executed.mismatches.length } : {}) };
    return full ? { ...brief, path: job?.path, sha256: job?.sha256?.slice(0, 16), executedAt: job?.executed?.at ?? null, mismatches: job?.executed?.mismatches ?? [], ops: job?.opCount ?? null, expectedMessages: job?.expectedMessages?.length ?? 0 } : brief;
  });
}
export function levelOf(index, c) {
  const proofs = c.proofs?.[index.lane] ?? [];
  if (proofs.length === 0) return c.route?.kind === 'job' ? 'B' : 'route';
  const levels = proofs.map(name => jobLevel(index.jobs.find(j => j.name === name)));
  if (levels.includes('C-executed-current')) return 'C-executed-current';
  if (levels.includes('C-executed-historical')) return 'C-executed-historical';
  return 'C-suite';
}
// A slice of the extracted contract for a pointer such as "logic.steps.get" or "verbs.verbs.create". `full` returns
// the slice whole up to `capBytes` (a larger one is reduced to its keys with the exact continuation that returns it);
// compact mode keeps arrays, strings and small objects whole and reduces large objects to their keys.
export function contractNode(index, pointer) {
  const [op, ...rest] = pointer.split('.');
  let node = index.contracts?.[op];
  for (const key of rest) node = Array.isArray(node) ? node.find(x => x === key) : node?.[key];
  return node;
}
export function contractSlice(index, pointers, { full = false, capBytes = 6144 } = {}) {
  const out = {};
  const small = v => typeof v !== 'object' || v === null || Array.isArray(v) || (Object.keys(v).length <= 4 && Object.values(v).every(x => typeof x !== 'object' || x === null || Array.isArray(x)));
  for (const pointer of pointers ?? []) {
    const node = contractNode(index, pointer);
    if (node === undefined) continue;
    if (typeof node !== 'object' || node === null || Array.isArray(node)) { out[pointer] = node; continue; }
    if (full) { out[pointer] = bytes(node) <= capBytes ? node : { keys: Object.keys(node), note: `slice of ${bytes(node)} bytes reduced to its keys`, expand: `contract:${pointer}` }; continue; }
    const compact = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, small(v) ? v : Object.keys(v)]));
    out[pointer] = JSON.stringify(compact).length > 900 ? { keys: Object.keys(node), note: 'large: reduced to its keys', expand: `contract:${pointer}` } : compact;
  }
  return out;
}
function routeOf(index, c) {
  const template = index.routes?.[c.route?.kind] ?? {};
  return { kind: c.route?.kind ?? null, operation: c.route?.operation ?? template.operation ?? null, prove: c.route?.prove ?? template.prove ?? null, deliver: c.route?.deliver ?? template.deliver ?? null, entries: template.entries ?? null };
}

// Transitive closure of `depends` over the selected capabilities: every dependency of a dependency is included once,
// cycles are reported instead of followed forever, unknown ids are reported instead of ignored, and the order is a
// deterministic topological order (dependencies before dependants, alphabetical ties). A dependency may be
// conditional ({id, unless}): it is still part of the composition, with its condition, because only the caller (with
// the capture) can tell whether the element already exists.
export function closure(capabilities, seeds) {
  const byId = new Map(capabilities.map(c => [c.id, c]));
  const chosen = new Map(); const invalid = []; const edges = new Map();
  for (const s of seeds) chosen.set(s.c.id, { ...s, requiredBy: [], conditions: [] });
  const queue = [...seeds.map(s => s.c.id)]; const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift(); const c = byId.get(id); edges.set(id, []);
    for (const d of c.depends ?? []) {
      const target = depId(d); const unless = typeof d === 'object' ? d.unless ?? null : null;
      if (!byId.has(target)) { invalid.push({ from: id, to: target }); continue; }
      edges.get(id).push(target);
      if (!chosen.has(target)) chosen.set(target, { c: byId.get(target), score: 0, why: [], via: 'dependency', requiredBy: [], conditions: [] });
      const entry = chosen.get(target);
      if (!entry.requiredBy.includes(id)) entry.requiredBy.push(id);
      if (unless) entry.conditions.push({ requiredBy: id, unless });
      if (!seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  // Kahn: dependencies first; whatever remains is in a cycle.
  const ids = [...chosen.keys()].sort();
  const indegree = new Map(ids.map(id => [id, 0]));
  for (const id of ids) for (const dep of edges.get(id) ?? []) if (chosen.has(dep)) indegree.set(id, indegree.get(id) + 1);
  const order = []; let ready = ids.filter(id => indegree.get(id) === 0).sort();
  while (ready.length) {
    const id = ready.shift(); order.push(id);
    for (const other of ids) if ((edges.get(other) ?? []).includes(id)) { indegree.set(other, indegree.get(other) - 1); if (indegree.get(other) === 0) ready.push(other); }
    ready.sort();
  }
  const cyclic = ids.filter(id => !order.includes(id)).sort();
  // Each cycle once, written from its smallest id (a>b>c>a and b>c>a>b are the same cycle).
  const cycles = [];
  for (const start of cyclic) {
    const visit = (id, trail) => {
      for (const dep of edges.get(id) ?? []) {
        if (dep === start) { const ring = trail.slice(); const pivot = ring.indexOf([...ring].sort()[0]); const cycle = [...ring.slice(pivot), ...ring.slice(0, pivot), ring[pivot]]; if (!cycles.some(x => x.join('>') === cycle.join('>'))) cycles.push(cycle); }
        else if (!trail.includes(dep) && cyclic.includes(dep)) visit(dep, [...trail, dep]);
      }
    };
    visit(start, [start]);
  }
  return { chosen, order: [...order, ...cyclic], cycles, invalid };
}

// Three tiers (phase 3, 2026-09-23). direct (`via: match`): the intent names an element of the capability (a shared
// family needs an element hit; operation words such as replace/delete belong to every family and never select one by
// themselves). dependency: the closure of `depends` of the direct matches, kept because the job cannot run without
// them. alternative: capabilities the intent touched only through operation words, or the descriptor alternatives
// of a direct match: listed compactly with the reason and the exact expansion, never with contracts or examples.
export function query(index, { intent = '', limit = 8 } = {}) {
  const { list: raw, genitive, gap } = intentTokens(intent);
  const derivedTokens = new Set(normalize(intent).split(/[^a-z0-9_]+/).filter(w => w.length > 1 && !STOP.has(w) && derived(w)).map(stem));
  // The owners of single-word keywords (A-005): the plain keywords of the index and, for this intent only, the anchored
  // one-word forms whose context holds (below). `says` reads the map when it is called.
  const owners = new Map(keywordOwners(index));
  const { terms, from, consumed, says } = canonicalize(raw, index.synonyms, derivedTokens, { genitive, gap, owners });
  // Anchor terms of anchored keywords (request A-006) are read as keywords are. A one-word term is said by an intent
  // word that folds to it (a derived term, -cao/-mente/-ing/-ed, only by a derived word of the intent, as a synonym
  // variant: request C-010), or, when the term is a synonym canonical, by any variant of its group on this lane (as a
  // one-word keyword is); a variant never stands for its canonical or its siblings, so its reading does not depend on
  // the lane's groups. A multi-word term is read in word order (`says`), like a multi-word keyword of the same owner.
  // `said` returns what the intent said (its word, the canonical, or the phrase), for `why`; null when not said.
  const rawByFold = new Map(); for (const t of raw) if (!rawByFold.has(fold(t))) rawByFold.set(fold(t), t);
  const derivedFolds = new Set([...derivedTokens].map(fold)); const canonicals = canonicalTerms(index);
  const said = (term, owner) => {
    if (term.phrase.includes(' ')) return says(term.phrase, owner) ? term.phrase : null;
    const f = fold(term.phrase);
    if (rawByFold.has(f) && (!term.derived || derivedFolds.has(f))) return rawByFold.get(f);
    const k = canonicals.get(f); return k && terms.includes(k) ? k : null;
  };
  const holds = (e, owner) => {
    if (e.without.some(t => said(t, owner) !== null)) return null;
    if (!e.with) return '';
    for (const t of e.with) { const w = said(t, owner); if (w !== null) return w; }
    return null;
  };
  // One gate per anchored entry and intent (entries belong to one capability or unavailable entry each).
  const gates = new Map();
  const gate = (e, owner) => { if (!e.anchored) return ''; if (!gates.has(e)) gates.set(e, holds(e, owner)); return gates.get(e); };
  // An anchored one-word form the intent says, whose context holds, claims its word for its capability like a plain
  // one-word keyword (A-005: "widget" then no longer stands for "block" in another capability's "block event"); its
  // gate is read with the index owners, then every other keyword with the claim. Out of its context it claims nothing.
  const claims = index.capabilities.flatMap(c => capabilityText(c).keywords.filter(e => e.anchored && e.form && !e.form.includes(' ') && raw.includes(e.form) && gate(e, c.id) !== null).map(e => [e.form, c.id]));
  for (const [form, id] of claims) owners.set(form, new Set([...(owners.get(form) ?? []), id]));
  const isOperation = w => operationForms(index).has(w);
  const scored = index.capabilities.map(c => ({ c, ...scoreCapability(c, terms, consumed, keyword => says(keyword, c.id), e => gate(e, c.id), isOperation) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.c.id.localeCompare(b.c.id));
  // A shared family is named by its own words (entity, identifier, index; static, record; structure), not by the
  // generic child words it shares with the others (attribute, value): when the intent names one family, the families
  // it does not name leave the direct tier even if "attribute" matched them.
  const familyWords = c => new Set((c.elements ?? []).flatMap(e => tokens(e.role)).filter(w => !['attribute', 'value', 'type', 'entity'].includes(w)).concat(c.id === 'data.entity' ? ['entity'] : []));
  // A family is a capability that declares element roles; a shared capability without roles (operations, delivery,
  // diagnostics: its projection has elements: []) is selected like a lane capability and is never demoted as a
  // family (request C-008).
  const isFamily = c => (c.elements?.length ?? 0) > 0;
  // An anchored keyword that counted names its capability's family too (scoreCapability, request A-006): a plural such
  // as "variaveis"/"variables" never yields the family word "variable", and a derived-word table that made it do so
  // for every family measured new direct matches (security.settings-roles, whose role is "client variable", on
  // environment and monitoring intents); the anchored keyword names the family of its own capability only.
  const namesFamily = x => isFamily(x.c) && (x.anchoredHits > 0 || [...familyWords(x.c)].some(w => terms.includes(w) || (w === 'entity' && terms.includes('entidade'))));
  let eligible = scored.filter(x => x.elementHits > 0 || (!isFamily(x.c) && x.score >= 3));
  const demoted = new Map();
  if (eligible.some(namesFamily)) for (const x of eligible) if (isFamily(x.c) && !namesFamily(x)) demoted.set(x.c.id, 'named through a generic element word only (attribute/record/value); the intent names another family');
  eligible = eligible.filter(x => !demoted.has(x.c.id));
  const top = eligible[0]?.score ?? 0;
  const selected = eligible.filter(x => x.score >= Math.max(2, top * 0.34)).slice(0, limit).map(x => ({ ...x, via: 'match' }));
  const selectedIds = new Set(selected.map(x => x.c.id));
  const operationOnly = scored.filter(x => !selectedIds.has(x.c.id) && x.score >= 3).map(x => ({ ...x, reason: demoted.get(x.c.id) ?? (x.elementHits > 0 ? 'below the direct threshold' : 'operation words only: no element of this capability is named in the intent') }));
  const { chosen, order, cycles, invalid } = closure(index.capabilities, selected);
  const contracts = {};
  // Direct matches carry their summary, limits and notes, and their contract slices whole (up to the per-slice cap);
  // dependencies are brief (id, route, proofs, pointers) with compact slices. `--expand <id>:...` opens any of them.
  const matches = [...chosen.values()].map(x => {
    for (const [pointer, slice] of Object.entries(contractSlice(index, x.c.contract, { full: x.via === 'match' }))) if (!(pointer in contracts) || x.via === 'match') contracts[pointer] = slice;
    const base = {
      id: x.c.id, category: x.c.category, title: x.c.title, via: x.via, score: x.score, why: x.why, level: levelOf(index, x.c),
      route: { kind: x.c.route?.kind ?? null }, contract: x.c.contract ?? [], proofs: proofsOf(index, x.c),
      depends: (x.c.depends ?? []).map(d => (typeof d === 'string' ? { id: d } : { id: d.id, unless: d.unless ?? null })),
      ...(x.requiredBy.length ? { requiredBy: x.requiredBy } : {}), ...(x.conditions.length ? { conditions: x.conditions } : {}),
      context: x.c.context ?? null, ...(x.c.shared ? { shared: true, lanes: x.c.lanes } : {}),
    };
    if (x.via !== 'match') return base;
    return { ...base, route: { kind: x.c.route?.kind ?? null, operation: x.c.route?.operation ?? null }, summary: x.c.summary,
      negative: (x.c.negative?.[index.lane] ?? []).map(n => { const j = index.negatives.find(k => k.name === n); return { job: n, refuses: j?.expectError ?? [] }; }),
      limits: (x.c.limits ?? []).slice(0, 2), guidance: x.c.guidance ?? null, notes: relatedNotes(index, x.c, terms).slice(0, 1),
      // Shared capabilities: the role(s) the intent names, the operations of this lane stated per element role with
      // their evidence, the native types as loaded in the lane runtime, and the differences against the other lane(s).
      ...(x.c.shared ? (() => { const focus = focusOf(x.c, terms, intent); return { focus, evidenceRule: EVIDENCE_RULE, operations: operationsOf(index, x.c, { focus }), native: nativeOf(index, x.c), differences: { [index.lane]: x.c.differences ?? [], ...(x.c.otherLaneDifferences ?? {}) } }; })() : {}) };
  });
  // Decisions: only where the intent really opened two ways (both selected), or an alternative of a direct match.
  const decisions = [];
  for (const x of chosen.values()) for (const alt of x.c.alternatives ?? []) {
    if (chosen.has(alt.id)) { if (!decisions.some(d => d.between.includes(x.c.id) && d.between.includes(alt.id))) decisions.push({ between: [x.c.id, alt.id], choose: alt.when }); }
    else if (x.via === 'match') decisions.push({ between: [x.c.id, alt.id], choose: alt.when, note: alt.id + ' was not selected by the intent' });
  }
  // The alternative tier: descriptor alternatives of the direct matches first, then the operation-only hits (best
  // first, at most four), each with its reason and the expansion that opens it whole.
  const alternatives = [];
  for (const x of [...chosen.values()].filter(x => x.via === 'match')) for (const alt of x.c.alternatives ?? []) {
    const c = index.capabilities.find(k => k.id === alt.id);
    if (c && !chosen.has(alt.id) && !alternatives.some(a => a.id === alt.id)) alternatives.push({ id: alt.id, title: c.title, via: 'alternative', score: scored.find(s => s.c.id === alt.id)?.score ?? 0, why: scored.find(s => s.c.id === alt.id)?.why ?? [], level: levelOf(index, c), reason: `alternative of ${x.c.id}: ${alt.when}`, route: { kind: c.route?.kind ?? null }, expand: alt.id });
  }
  for (const x of operationOnly) { if (alternatives.length >= 4) break; if (chosen.has(x.c.id) || alternatives.some(a => a.id === x.c.id)) continue; alternatives.push({ id: x.c.id, title: x.c.title, via: 'alternative', score: x.score, why: x.why, level: levelOf(index, x.c), reason: x.reason, route: { kind: x.c.route?.kind ?? null }, expand: x.c.id }); }
  matches.push(...alternatives);
  const recommended = [...chosen.values()].flatMap(x => (x.c.recommends ?? []).filter(r => !chosen.has(depId(r))).map(r => ({ id: depId(r), by: x.c.id, when: typeof r === 'object' ? r.when ?? null : null })));
  const unavailable = (index.unavailable ?? []).map(u => ({ u, hits: keywordEntries(u).filter(e => e.form && (terms.includes(e.form) || (e.form.includes(' ') && says(e.form, u.id))))
    .map(e => { const anchor = gate(e, u.id); return anchor === null ? null : anchor ? `${e.form} [${anchor}]` : e.form; }).filter(Boolean) })).filter(x => x.hits.length)
    .map(x => ({ id: x.u.id, why: x.hits, reason: x.u.reason, evidence: x.u.evidence ?? null, negative: (x.u.negative?.[index.lane] ?? []), alternative: x.u.alternative ?? null }));
  const cited = new Set(matches.flatMap(m => (m.proofs ?? []).map(p => p.job)));
  const relatedJobs = index.jobs.filter(j => !cited.has(j.name)).map(j => ({ j, ...scoreJob(j, terms) })).filter(x => x.score > 1).sort((a, b) => b.score - a.score).slice(0, 3)
    .map(x => ({ job: x.j.name, why: x.why, description: x.j.description.slice(0, 120), level: jobLevel(x.j) }));
  const covered = new Set(matches.flatMap(m => m.why).concat(unavailable.flatMap(u => u.why)).flatMap(whyWords));
  const unmatched = raw.filter(t => ![...from.get(t) ?? []].some(c => c.split(' ').every(part => covered.has(part))));
  // Proven bindings: how the elements of the matched capabilities connect, taken from their proof jobs (one rule
  // once), element-to-element bindings first, then data bindings, then flow wiring and creation arguments; within a
  // rank, the order of the matches and of their proofs. The concrete op of the first occurrence comes along.
  // A rank-0 rule whose two ends are element roles of DIRECT matches says how the capabilities the intent named connect
  // (a widget event bound to the screen action of another match): the first rule of each pair of roles carries the pair
  // (`between`) and comes first in its rank, so the budget's cut to six keeps it (request A-005: '<IButton>/OnClick
  // Destination = <IScreenAction>' was 7th and cut). The pairs go by relevance, not by the order of the proofs (a
  // composite with many matches has many pairs): both roles named by the intent (focus) in two capabilities, then any
  // two capabilities, then two roles of one; a second rule for a pair already seen comes after every first one. An end
  // resolves by the role's native or job type, or, for an event, by the event its address names ('<widget
  // path>/OnClick'); when two matches have the role, the one the intent names.
  const focused = new Map(matches.filter(m => m.via === 'match').map(m => [m.id, new Set(m.focus?.allRoles ?? m.focus?.roles ?? [])]));
  const directRoles = [...chosen.values()].filter(x => x.via === 'match').flatMap(x => (x.c.elements ?? []).map(e => ({ id: x.c.id, at: `${x.c.id}/${e.role}`, named: focused.get(x.c.id)?.has(e.role) === true,
    types: [e.native?.split('.').at(-1), e.jobType].filter(t => /^I[A-Z][A-Za-z0-9]*$/.test(t ?? '')), events: [...String(e.address ?? '').matchAll(/\/(On[A-Z][A-Za-z]*)/g)].map(a => a[1]) })));
  const roleOf = end => { if (!end) return null; const all = directRoles.filter(r => (end.event ? r.events.includes(end.event) : r.types.includes(end.type))); return all.find(r => r.named) ?? all[0] ?? null; };
  const bindings = []; const seenRules = new Set(); const tier = new Map(); const pairs = new Set();
  for (const m of matches.filter(x => x.via === 'match')) for (const p of m.proofs) {
    const job = index.jobs.find(j => j.name === p.job);
    for (const b of job?.bindings ?? []) {
      if (seenRules.has(b.rule)) continue; seenRules.add(b.rule);
      const [from, to] = (b.rank ?? 2) === 0 && b.ends ? b.ends.map(roleOf) : [];
      const pair = from && to ? `${from.at} > ${to.at}` : null; const first = pair && !pairs.has(pair); if (pair) pairs.add(pair);
      const binding = { rule: b.rule, for: m.id, job: p.job, op: b.op, level: p.level, rank: b.rank ?? 2, ...(first ? { between: [from.at, to.at] } : {}), example: b.example };
      tier.set(binding, !pair ? 4 : !first ? 3 : from.id === to.id ? 2 : from.named && to.named ? 0 : 1); bindings.push(binding);
    }
  }
  bindings.sort((a, b) => a.rank - b.rank || tier.get(a) - tier.get(b));
  const bindingsTotal = bindings.length; bindings.length = Math.min(bindings.length, 12);
  return { terms, matches, contracts, routes: Object.fromEntries([...new Set(matches.map(m => m.route.kind))].filter(Boolean).map(k => [k, index.routes?.[k] ?? null])),
    order, cycles, invalidDependencies: invalid, decisions, recommended, unavailable, relatedJobs, unmatched, bindings, bindingsTotal };
}
// A capability as a direct match of the work packet when the module holds the element the intent names exactly (W1): the
// fields of a direct match of query() that the packet reads.
export function packetMatch(index, id, why = []) {
  const c = index.capabilities.find(k => k.id === id); if (!c) return null;
  return { id: c.id, category: c.category, title: c.title, via: 'match', score: 0, why, level: levelOf(index, c), route: { kind: c.route?.kind ?? null, operation: c.route?.operation ?? null },
    contract: c.contract ?? [], proofs: proofsOf(index, c), depends: (c.depends ?? []).map(d => (typeof d === 'string' ? { id: d } : { id: d.id, unless: d.unless ?? null })),
    summary: c.summary, limits: (c.limits ?? []).slice(0, 2), guidance: c.guidance ?? null, from: 'module' };
}
function relatedNotes(index, c, terms) {
  const notes = [];
  for (const name of c.proofs?.[index.lane] ?? []) { const job = index.jobs.find(j => j.name === name); for (const n of job?.notes ?? []) if (terms.some(t => tokens(n.text).includes(t))) notes.push({ job: name, op: n.op, verb: n.verb, text: n.text.length > 200 ? n.text.slice(0, 197) + '...' : n.text }); }
  return notes.slice(0, 4);
}

// ---- application context through the existing reader (captures by hash; no full scan).
// Every read is classified: complete, partial (the reader omitted entries), empty (kind observed, nothing found),
// unknown-kind (the kind was never observed: typo or absent on this platform) or failed (the reader said no, with its
// message). A capture that changes between reads (expectedSourceSha256 mismatch) fails the whole context: nothing
// read before is combined with anything read after. Targeted elements get their signature (inputs, outputs, events
// with parameters, placeholders, attributes) from the same reader, in one batched read.
const SIGNATURE_KINDS = {
  inputs: ['InputParameter', 'InputParameterSignature'], outputs: ['OutputParameter', 'OutputParameterSignature'],
  events: ['BlockEvent', 'BlockEventSignature'], lifecycle: ['UILifeCycleEvent'], placeholders: ['PlaceholderWidget', 'PlaceholderWidgetSignature'],
  attributes: ['EntityAttribute', 'StructureAttribute', 'EntityAttributeSignature', 'StructureAttributeSignature'], records: ['StaticEntityRecord', 'StaticEntityRecordSignature'],
  variables: ['LocalVariable'], actions: ['ScreenAction', 'DataAction', 'ScreenAggregate', 'Aggregate'], entityActions: ['EntityActionSignature'],
};
const typeOf = value => { const text = String(value ?? ''); const m = /^([A-Za-z]+):(.*)$/.exec(text); return m ? { type: m[2], typeKind: m[1] } : { type: text || null, typeKind: null }; };
const flag = value => value === 'True' || value === true;
const brief = (text, max) => { const t = String(text).replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 3) + '...' : t; };
function parameterOf(node) { const p = node.properties ?? {}; return { name: node.name, ...typeOf(p.DataType), mandatory: flag(p.IsMandatory), ...(p.DefaultValue != null ? { default: p.DefaultValue } : {}), ...(p.Description ? { description: brief(p.Description, 100) } : {}) }; }
export function signatureOf(tree) {
  const children = tree.children ?? [];
  const pick = names => children.filter(c => names.includes(c.kind));
  const isSignature = /Signature$/.test(tree.kind ?? '');
  const p = tree.properties ?? {};
  // How a job addresses it (verbs.references, Tipo:Nome): referenced elements keep their *Signature interface
  // (jobs write IServerActionSignature:ListAppend); a referenced block is bound to an instance through `source`
  // with the block interface (create ... source IMobileBlock:Name).
  const signature = {
    kind: tree.kind, name: tree.name, reference: tree.reference,
    role: isSignature ? 'referenced definition' : 'own definition',
    jobReference: `I${tree.kind}:${tree.name}`,
    ...(tree.kind === 'MobileBlockSignature' || tree.kind === 'MobileBlock' ? { instanceSource: `IMobileBlock:${tree.name}` } : {}),
    ...(p.Public != null ? { public: flag(p.Public) } : {}), ...(p.Description ? { description: brief(p.Description, 160) } : {}),
  };
  const inputs = pick(SIGNATURE_KINDS.inputs).map(parameterOf); if (inputs.length) signature.inputs = inputs;
  const outputs = pick(SIGNATURE_KINDS.outputs).map(parameterOf); if (outputs.length) signature.outputs = outputs;
  const events = pick(SIGNATURE_KINDS.events).map(e => ({ name: e.name, mandatory: flag(e.properties?.IsMandatory), ...(e.properties?.Description ? { description: brief(e.properties.Description, 100) } : {}),
    parameters: (e.children ?? []).filter(c => SIGNATURE_KINDS.inputs.includes(c.kind)).map(parameterOf), ...(e.childrenOmitted ? { parametersOmitted: e.childrenOmitted } : {}) }));
  if (events.length) signature.events = events;
  const lifecycle = pick(SIGNATURE_KINDS.lifecycle).map(e => e.name); if (lifecycle.length) signature.lifecycle = lifecycle;
  const placeholders = pick(SIGNATURE_KINDS.placeholders).map(e => e.name); if (placeholders.length) signature.placeholders = placeholders;
  const attributes = pick(SIGNATURE_KINDS.attributes).map(a => { const q = a.properties ?? {}; return { name: a.name, ...typeOf(q.DataType), mandatory: flag(q.IsMandatory), ...(q.Length ? { length: Number(q.Length) } : {}), ...(q.IsAutoNumber ? { autoNumber: q.IsAutoNumber === 'Yes' } : {}), ...(q.DefaultValue != null ? { default: q.DefaultValue } : {}) }; });
  if (attributes.length) signature.attributes = attributes;
  const records = pick(SIGNATURE_KINDS.records).map(r => r.name); if (records.length) signature.records = records;
  const variables = pick(SIGNATURE_KINDS.variables).map(v => ({ name: v.name, ...typeOf(v.properties?.DataType), ...(v.properties?.DefaultValue != null ? { default: v.properties.DefaultValue } : {}) })); if (variables.length) signature.variables = variables;
  const actions = pick(SIGNATURE_KINDS.actions).map(a => ({ kind: a.kind, name: a.name })); if (actions.length) signature.actions = actions;
  const entityActions = pick(SIGNATURE_KINDS.entityActions).map(a => a.name); if (entityActions.length) signature.entityActions = entityActions;
  signature.childrenTotal = tree.childrenTotal ?? children.length;
  signature.childrenOmitted = tree.childrenOmitted ?? 0;
  signature.complete = (tree.childrenOmitted ?? 0) === 0 && !Object.keys(tree.propertyErrors ?? {}).length;
  return signature;
}
function classifyRead(kind, r) {
  if (!r || r.ok === false) return { status: 'failed', error: r?.error ?? 'reader returned no result', code: r?.code ?? null };
  if ((r.count ?? 0) === 0) return r.kindObserved === false ? { status: 'unknown-kind', notices: r.notices ?? [] } : { status: 'empty' };
  if ((r.omitted ?? 0) > 0 || r.truncated) return { status: 'partial', omitted: r.omitted ?? null, nextOffset: r.nextOffset ?? null, searchComplete: r.searchComplete ?? null };
  return { status: 'complete', ...(r.searchComplete === false ? { searchComplete: false } : {}) };
}
// The reader's own refusal (SnapshotReading.Read): "Snapshot content changed: expectedSourceSha256 does not match".
const isCaptureChange = r => r && r.ok === false && /Snapshot content changed|expectedSourceSha256/i.test(String(r.error ?? ''));
async function safeInspect(inspect, request) {
  try {
    const r = await inspect(request);
    if (!r) return { ok: false, error: 'reader returned nothing' };
    // Above its inline budget the reader answers with a summary and writes the whole JSON to `out`: read it back.
    if (r.ok && r.inline === false && r.out) {
      try { return { ...readJson(r.out), ok: true, file: r.file, out: r.out, sourceSha256: r.sourceSha256, cache: r.cache, inline: false }; }
      catch (error) { return { ok: false, error: 'reader output could not be read back: ' + error.message }; }
    }
    return r;
  } catch (error) { return { ok: false, error: error.message }; }
}
const NOTE = 'Identities are bound to sourceSha256; after any Studio change take a new capture. Counts, omissions and failures are the reader\'s; nothing beyond these queries was scanned. `signatures` are definitions: role "referenced definition" is the contract of an element of a referenced module (an instance configures arguments against it), "own definition" is an element of this module; neither is an instance configuration.';
export async function applicationContext(index, sources, { app, matches, terms, inspect, map = null, maxPerKind = 16, maxSignatures = 6, maxReuse = 12 }) {
  const wanted = new Map(); const signatureKinds = new Set();
  for (const m of matches) {
    for (const k of m.context?.kinds ?? []) if (!wanted.has(k)) wanted.set(k, []);
    for (const k of m.context?.kinds ?? []) wanted.get(k).push(m.id);
    for (const k of m.context?.signatures ?? []) signatureKinds.add(k);
  }
  const kinds = [...wanted.keys()]; if (kinds.length === 0) kinds.push('MobileScreen');
  const reads = []; const problems = [];
  // A kind read: the module map when the entry has one (same kind semantics, no model walk; entries become the
  // reader's {kind, name, reference}), else the reader. A map that cannot answer falls back to the reader, except
  // for a changed capture, which fails the context as before.
  const kindRead = async request => {
    if (map) {
      const r = await safeInspect(map, { target: request.target, kind: request.kind, max: request.max, expectedSourceSha256: request.expectedSourceSha256 });
      if (r.ok) return { ...r, entries: (r.entries ?? []).map(e => ({ kind: e.kind, name: e.name, reference: '@' + e.key })) };
      if (isCaptureChange(r) || !inspect) return r;
    }
    return safeInspect(inspect, { ...request, properties: 'Name', budget: 200000 });
  };
  const first = await kindRead({ target: app, kind: kinds[0], max: maxPerKind });
  if (!first.ok) return { ok: false, status: 'failed', code: 'READ_FAILED', target: app, error: first.error, reads: [], signatures: [], reuse: [], note: 'the capture could not be read; nothing was inferred' };
  const file = first.file ?? app; const sourceSha256 = first.sourceSha256 ?? null;
  const changed = r => ({ ok: false, status: 'failed', code: 'CAPTURE_CHANGED', target: app, file, sourceSha256, error: r.error, reads: [], signatures: [], reuse: [],
    note: 'the capture changed between reads: nothing read so far is reported; query again against the new capture (take a new snapshot if the module was edited)' });
  // Every continuation below is one call of the lane's reader tool: `continuation.tool` with `continuation.arguments`
  // (the file and the hash guard, written once) merged with the item's own `continuation` arguments, short and exact.
  const continuation = { ...sources.inspectCall(file, sourceSha256), note: 'call tool with arguments plus the item\'s continuation arguments; the hash guard makes the reader refuse a capture that changed' };
  const command = args => args;
  const results = new Map([[kinds[0], first]]);
  for (const kind of kinds.slice(1)) {
    const r = await kindRead({ target: file, kind, max: maxPerKind, expectedSourceSha256: sourceSha256 });
    if (isCaptureChange(r)) return changed(r);
    results.set(kind, r);
  }
  const elementsByKind = new Map();
  for (const [kind, r] of results) {
    const c = classifyRead(kind, r);
    const elements = (r.entries ?? []).map(e => ({ name: e.name, reference: e.reference }));
    elementsByKind.set(kind, elements);
    reads.push({ kind, for: wanted.get(kind) ?? [], ...c, count: r.count ?? null, returned: r.returned ?? null, elements,
      ...(c.status === 'partial' ? { continuation: command({ kind, max: maxPerKind, offset: r.nextOffset ?? maxPerKind, properties: 'Name' }) } : {}),
      ...(c.status === 'failed' ? { continuation: command({ kind, max: maxPerKind, properties: 'Name' }) } : {}) });
    if (c.status === 'failed') problems.push({ read: 'kind:' + kind, error: c.error });
  }
  // Words of the intent that matched a capability, then the other terms: the names an author would look for.
  const why = [...new Set(matches.filter(m => m.via === 'match').flatMap(m => m.why ?? []).flatMap(whyWords))];
  const nameTerms = [...new Set([...why, ...terms])].filter(t => t.length > 3 && !t.includes(' '));
  // Text search (names and text properties) for reuse candidates, bounded per term; also the source of targeted
  // signature candidates in the kinds flagged by the matches.
  const reuse = []; const reuseReads = []; const textHits = [];
  for (const term of nameTerms.slice(0, 3)) {
    const r = await safeInspect(inspect, { target: file, text: term, max: 200, properties: 'Name', budget: 200000, expectedSourceSha256: sourceSha256 });
    if (isCaptureChange(r)) return changed(r);
    const c = classifyRead('text:' + term, r); reuseReads.push({ term, ...c, count: r.count ?? null });
    if (c.status === 'failed') { problems.push({ read: 'text:' + term, error: c.error }); continue; }
    const entries = r.entries ?? [];
    textHits.push(...entries.map(e => ({ kind: e.kind, name: e.name, reference: e.reference })));
    if (entries.length) reuse.push({ term, count: r.count, shown: Math.min(entries.length, maxReuse), searchComplete: r.searchComplete ?? null, elements: entries.slice(0, maxReuse).map(e => ({ kind: e.kind, name: e.name, reference: e.reference })),
      ...(r.count > maxReuse ? { continuation: command({ text: term, max: 40, offset: maxReuse, properties: 'Name' }) } : {}) });
  }
  // Targeted signatures: elements whose name is, starts with or contains an intent word (exact names first), in the
  // flagged kinds or among the listed elements; every element of a flagged kind when it is small. One batched read,
  // bounded; the rest is listed with its exact continuation.
  // Exact name 3, prefix 2, substring 1 per term; names marked deprecated rank after the rest (still listed).
  const score = name => { const n = normalize(name ?? ''); let total = 0; for (const t of nameTerms) { if (n === t) total += 3; else if (n.startsWith(t)) total += 2; else if (n.includes(t)) total += 1; } return total > 0 && /^deprecated/i.test(n) ? total - 1.5 : total; };
  const candidates = new Map();
  const consider = (e, kind, base) => { const s = score(e.name) + base; if (s <= 0) return; const known = candidates.get(e.reference); if (!known) candidates.set(e.reference, { name: e.name, kind, reference: e.reference, score: s }); else known.score = Math.max(known.score, s); };
  for (const e of textHits) if (signatureKinds.has(e.kind)) consider(e, e.kind, 0);
  for (const [kind, elements] of elementsByKind) { const small = signatureKinds.has(kind) && (results.get(kind)?.count ?? elements.length) <= maxSignatures; for (const e of elements) consider(e, kind, small ? 0.5 : 0); }
  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
  const chosen = ranked.slice(0, maxSignatures);
  let signatures = []; let signatureRead = null;
  if (chosen.length) {
    const batch = await safeInspect(inspect, { target: file, path: '/', select: chosen.map(c => c.reference), depth: 2, budget: 200000, expectedSourceSha256: sourceSha256 });
    if (isCaptureChange(batch)) return changed(batch);
    if (!batch.ok) { signatureRead = { status: 'failed', error: batch.error, requested: chosen.length, returned: 0, continuation: chosen.map(c => command({ path: c.reference, depth: 2 })) }; problems.push({ read: 'select', error: batch.error }); }
    else {
      const entries = batch.entries ?? [];
      signatures = chosen.map((c, i) => { const e = entries.find(x => x.selector === c.reference) ?? entries[i]; return e?.ok && e.data?.tree ? { ...signatureOf(e.data.tree), continuation: command({ path: c.reference, depth: 3 }) } : { reference: c.reference, name: c.name, kind: c.kind, status: 'failed', error: e?.error ?? 'no tree returned', continuation: command({ path: c.reference, depth: 2 }) }; });
      signatureRead = { status: batch.complete === false || signatures.some(s => s.status === 'failed') ? 'partial' : 'complete', requested: chosen.length, returned: signatures.filter(s => s.status !== 'failed').length };
    }
  }
  const omittedSignatures = ranked.slice(maxSignatures).map(c => ({ name: c.name, kind: c.kind, reference: c.reference, continuation: command({ path: c.reference, depth: 2 }) }));
  const statuses = [...reads.map(r => r.status), ...(signatureRead ? [signatureRead.status] : []), ...reuseReads.map(r => r.status)];
  const status = statuses.includes('failed') ? 'partial-with-failures' : statuses.includes('partial') ? 'partial' : 'complete';
  return { ok: true, status, target: app, file, sourceSha256,
    cache: first.cache ? (first.answeredBy === 'module-index' ? { answeredBy: 'module-index', index: first.cache.index } : { modelHit: first.cache.modelHit, generation: first.cache.generation }) : null,
    continuation, reads, signatures, signatureRead, omittedSignatures, reuse, reuseReads, problems, note: NOTE };
}

// ---- budget: the answer is measured in UTF-8 bytes (compact JSON) and the budget is a HARD limit (phase 3,
// 2026-09-23). Stages reduce whole sections in a fixed order, cheapest information first: A derived or duplicated
// text, B capture context, C the lower tiers (alternatives, dependencies), D the parts of a direct match that are
// not what the intent asked (bindings, examples, contracts, non-focused operations, limits beyond the first), E the
// focused operations to their summary and per-role status/evidence/integrity caution. Every reduction is declared in
// size.truncated with the exact continuation. When even the minimal answer does not fit, an explicit insufficient
// result is returned (size.status 'insufficient'): never an answer above the budget with a note.
const OMITTED_PART = { examples: 'example', 'examples.all': 'example', contracts: 'contract', bindings: 'bindings', 'bindings.all': 'bindings', 'matches.operations': 'operations', 'matches.operations.focused': 'operations', 'matches.native': 'native', 'matches.limits': 'evidence', 'matches.notes': 'evidence', 'matches.summary': 'evidence', 'matches.direct.minimal': 'evidence' };
// The stages in their fixed order, [name, reduce(answer) in place, recover(answer) -> continuation text].
function budgetStages() {
  const direct = a => (a.matches ?? []).filter(m => m.via === 'match').map(m => m.id);
  // Under budget, a shared match keeps whole only the operations the intent named; when it named none, every operation
  // goes to operationsOmitted (one expansion away) before contracts or examples are touched: with several families
  // matched, their first two operations used to outweigh the contracts of a composite intent (request B-002).
  const focusedOps = m => m.focus?.ops ?? [];
  // An intent that names element roles and no operation keeps every operation reduced to those roles: the statement
  // per role is what it asked (catalog M1, front B: "evento onclick ligado a uma screen action" lost ui.event whole).
  const focusedRoles = m => (focusedOps(m).length ? [] : m.focus?.roles ?? []);
  const compactRoles = roles => Object.fromEntries(Object.entries(roles ?? {}).map(([role, r]) => [role, { status: r.status, evidence: r.evidence, ...(r.alternative ? { alternative: r.alternative } : {}), ...(r.observed ? { observed: { integrity: r.observed.integrity, caution: r.observed.caution } } : {}) }]));
  return [
    // A. derived or duplicated text
    // Recoveries name ssam_discover arguments (expand, detail, budgetBytes), never CLI flags.
    ['matches.notes', a => a.matches?.forEach(m => { delete m.notes; }), a => `expand ${direct(a).map(id => id + ':evidence').join(',')}`],
    ['relatedJobs', a => { a.relatedJobs = []; }, () => 'query with a narrower intent'],
    ['evidenceRule', a => { const rule = a.matches?.find(m => m.evidenceRule)?.evidenceRule; if (rule) { a.evidenceRule = rule; a.matches.forEach(m => { delete m.evidenceRule; }); } }, () => 'answer.evidenceRule, stated once'],
    ['identity', a => { const i = a.identity; if (i && !i.reduced) a.identity = { lane: i.lane, index: i.index, cli: i.cli, kernel: i.kernel, studio: i.studio ? { platform: i.studio.platform, ideVersion: i.studio.ideVersion } : null, fixture: i.fixture ?? null, descriptor: i.descriptor ?? null, jobs: i.jobs ? { results: i.jobs.results, current: i.jobs.current, historical: i.jobs.historical } : null, modelApi: i.modelApi ?? null, warnings: i.warnings?.length ?? 0, reduced: 'keyStrategy, nativeRuntime, shared detail and the warning texts omitted by budget' }; }, () => 'raise budgetBytes to read the whole identity (warnings, key strategy, native runtime)'],
    ['notes', a => { for (const k of ['coverage', 'lexical', 'continuation']) if (a[k]?.note) delete a[k].note; if (a.routes) a.routes = Object.fromEntries(Object.entries(a.routes).map(([k, v]) => [k, v && typeof v === 'object' ? { entries: v.entries ?? null } : v])); }, () => 'docs/DESCOBERTA-CONTEXTUAL.md 1.1; routes: validation.prove/deliver'],
    // The list of every shared capability of the lane grows with the catalog, not with the intent: a count first.
    ['coverage.shared', a => { if (Array.isArray(a.coverage?.shared)) { a.coverage.sharedCount = a.coverage.shared.length; delete a.coverage.shared; } }, () => 'raise budgetBytes to list the shared capabilities of the lane (coverage.shared)'],
    // B. capture context (a continuation is the arguments added to context.continuation's reader call)
    ['context.reuse', a => { a.context?.reuse?.forEach(r => { if (r.elements.length > 4) { r.elements = r.elements.slice(0, 4); r.shown = 4; r.continuation = r.continuation ?? { text: r.term }; } }); }, () => 'context.reuse[].continuation'],
    ['context.elements', a => { a.context?.reads?.forEach(r => { if (r.elements && r.elements.length > 8) { r.elements = r.elements.slice(0, 8).map(e => e.name ?? e); r.elementsShown = 8; r.continuation = r.continuation ?? { kind: r.kind }; } }); }, () => 'context.reads[].continuation'],
    ['context.signatures', a => { if (a.context?.signatures?.length > 3) { a.context.omittedSignatures = [...a.context.signatures.slice(3).map(s => ({ name: s.name, kind: s.kind, reference: s.reference, continuation: s.continuation })), ...(a.context.omittedSignatures ?? [])]; a.context.signatures = a.context.signatures.slice(0, 3); } }, () => 'context.omittedSignatures[].continuation'],
    // C. lower tiers: alternatives to a line, dependencies to what makes them runnable
    ['matches.alternatives', a => { if (a.matches) a.matches = a.matches.map(m => (m.via === 'alternative' ? { id: m.id, via: 'alternative', reason: m.reason, expand: m.expand } : m)); }, () => 'expand <id> opens an alternative whole'],
    ['matches.dependencies', a => { if (a.matches) a.matches = a.matches.map(m => (m.via === 'dependency' ? { id: m.id, title: m.title, via: 'dependency', level: m.level, route: m.route, ...(m.requiredBy ? { requiredBy: m.requiredBy } : {}), ...(m.conditions ? { conditions: m.conditions } : {}), expand: `${m.id}:contract+example+evidence` } : m)); }, () => 'expand <id>:contract+example+evidence for any dependency; composition.order lists the ids'],
    // D. direct matches: what the intent did not ask, first
    // The rules between roles of the direct matches are ordered first (query), so the six kept are those. The pair a
    // rule carries (`between`) did the ordering and is derived from the rule and the matches' roles: it goes here too,
    // so from this stage on the bindings cost what they cost before request A-005.
    ['bindings', a => { if (a.bindings?.length > 6) { a.bindingsOmitted = a.bindings.length - 6; a.bindings = a.bindings.slice(0, 6).map(b => ({ rule: b.rule, for: b.for, job: b.job, op: b.op, level: b.level })); } else if (a.bindings?.some(b => b.between)) a.bindings = a.bindings.map(({ between: _between, ...b }) => b); }, a => `expand ${direct(a).map(id => id + ':bindings').join(',')}`],
    // Non-focused operations go to a name list; focused ones stay whole. Native contracts, differences and guidance
    // are one expansion away; the negative jobs keep their names. This goes before the example cut: the statements
    // of the operations the intent did not name are worth less than the excerpt of the one it did.
    ['matches.operations', a => a.matches?.forEach(m => { if (m.via !== 'match') return; if (m.operations) { const roles = focusedRoles(m); if (roles.length) for (const [op, o] of Object.entries(m.operations)) { const named = Object.fromEntries(Object.entries(o?.roles ?? {}).filter(([role]) => roles.includes(role))); m.operations[op] = Object.keys(named).length ? { roles: Object.fromEntries(Object.entries(compactRoles(named)).map(([role, c]) => [role, { ...c, ...(named[role]?.proofs?.length ? { proofs: named[role].proofs.slice(0, 2).map(p => ({ job: p.job ?? p })) } : {}) }])) } : null; } const keep = new Set(roles.length ? Object.keys(m.operations).filter(op => m.operations[op]) : focusedOps(m)); const omitted = Object.keys(m.operations).filter(op => !keep.has(op)); if (omitted.length) { m.operationsOmitted = omitted; for (const op of omitted) delete m.operations[op]; } if (roles.length) m.operationsReduced = `per role status and evidence of the roles the intent named (${roles.join(', ')}); the rest is one expansion away`; } if (m.native) m.native = m.native.map(n => ({ role: n.role, native: n.native, jobType: n.jobType, address: n.address, ...(n.runtime?.provenance === 'kernel' ? { runtime: 'kernel' } : {}) })); delete m.differences; delete m.guidance; if (m.negative) m.negative = m.negative.map(n => n.job); if (m.focus?.options) m.focus = { roles: m.focus.roles, ops: m.focus.ops, options: m.focus.options.map(o => o.role) }; }), () => 'continuation.omitted[].expand (operations+native+evidence)'],
    // A scoped excerpt keeps the ops of the focused verbs (ex.focusedOps) before the reads around them.
    ['examples', a => { for (const [id, ex] of Object.entries(a.examples ?? {})) if (ex?.ops?.length > 3) { const positions = ex.ops.map((_, k) => k); const keep = keepFocusedFirst(positions, new Set(ex.focusedOps ?? []), 3); ex.ops = keep.map(k => ex.ops[k]); if (ex.focusedOps) ex.focusedOps = keep.map((k, n) => (ex.focusedOps.includes(k) ? n : -1)).filter(n => n >= 0); ex.opsShown = ex.ops.length; ex.fragment = true; ex.note = 'FRAGMENT (reduced by budget): the whole excerpt is one expansion away'; ex.expand = id + ':example'; } }, () => 'continuation.omitted[].expand (example)'],
    ['matches.limits', a => a.matches?.forEach(m => { if (m.limits) m.limits = m.limits.slice(0, 1); }), () => 'continuation.omitted[].expand (evidence)'],
    // A declared refusal or gap is an essential support statement: its evidence text is reduced, the entry never goes
    // (catalog M2, request C-003: at 12000 bytes some answers lost the whole section).
    ['unavailable', a => { if (a.unavailable?.length) a.unavailable = a.unavailable.map(u => ({ id: u.id, reason: brief(u.reason ?? '', 160), ...(u.alternative ? { alternative: brief(u.alternative, 160) } : {}), ...(u.negative?.length ? { negative: u.negative } : {}) })); }, () => 'raise budgetBytes for the evidence of each unavailable entry'],
    // The proof names kept with the roles an intent named go before any contract is reduced.
    ['matches.operations.proofs', a => a.matches?.forEach(m => { if (m.via !== 'match' || !m.operationsReduced) return; for (const o of Object.values(m.operations ?? {})) for (const r of Object.values(o?.roles ?? {})) delete r.proofs; }), () => 'continuation.omitted[].expand (operations)'],
    ['contracts', a => { for (const k of Object.keys(a.contracts ?? {})) { const v = a.contracts[k]; if (v && typeof v === 'object' && !Array.isArray(v) && !v.expand) a.contracts[k] = { keys: Object.keys(v), note: 'reduced by budget', expand: `contract:${k}` }; } }, a => `expand ${Object.keys(a.contracts ?? {}).map(k => 'contract:' + k).join(',')}`],
    ['matches.summary', a => a.matches?.forEach(m => { if (m.summary && m.summary.length > 220) m.summary = m.summary.slice(0, 217) + '...'; }), () => 'continuation.omitted[].expand (evidence)'],
    // Every rule goes here, the ones between the matched roles too: the order of request A-005 protects them from
    // 'bindings' down to this stage, not below it (front B's four-capability composite: about 24 KB on ODC, 22 KB on
    // O11, measured 2026-09-24).
    ['bindings.all', a => { if (a.bindings?.length) { a.bindingsOmitted = (a.bindingsOmitted ?? 0) + a.bindings.length; a.bindings = []; } }, () => 'continuation.omitted[].expand (bindings)'],
    ['examples.all', a => { for (const [id, ex] of Object.entries(a.examples ?? {})) if (ex?.ops?.length) a.examples[id] = { job: ex.job, path: ex.path, ...(ex.scope ? { scope: { role: ex.scope.role, op: ex.scope.op, ops: ex.scope.ops } } : {}), opsTotal: ex.opsTotal, opsShown: 0, ops: [], fragment: true, note: 'ops omitted by budget', expand: id + ':example' }; }, () => 'continuation.omitted[].expand (example)'],
    ['contracts.all', a => { const keys = Object.keys(a.contracts ?? {}); if (keys.length) { a.contracts = { reduced: { pointers: keys, expand: keys.map(k => 'contract:' + k).join(',') } }; } }, () => 'contracts.reduced.expand'],
    ['expansions', a => { for (const [key, part] of Object.entries(a.expansions ?? {})) { if (part?.example?.ops?.length > 4) { part.example.ops = part.example.ops.slice(0, 4); part.example.opsShown = 4; part.example.fragment = true; part.example.note = 'FRAGMENT (reduced by budget)'; } if (part?.evidence?.proofs?.length > 2) { part.evidence.proofsOmitted = part.evidence.proofs.slice(2).map(p => p.job); part.evidence.proofs = part.evidence.proofs.slice(0, 2); } if (part?.bindings?.length > 8) { part.bindingsOmitted = part.bindings.length - 8; part.bindings = part.bindings.slice(0, 8); } } }, a => 'ask for fewer parts per call: ' + Object.keys(a.expansions ?? {}).map(k => 'expand ' + k).join(' | ')],
    ['matches.alternatives.drop', a => { const alts = (a.matches ?? []).filter(m => m.via === 'alternative'); if (alts.length) { a.composition = a.composition ?? {}; a.composition.alternativesOmitted = alts.map(m => m.id); a.matches = a.matches.filter(m => m.via !== 'alternative'); } }, () => 'composition.alternativesOmitted lists the ids; expand <id>'],
    // E. the focused operations themselves, to what must never be lost: the family summary and, per role, the
    // status, the evidence class, the alternative of a refusal and the integrity caution of an observed behaviour.
    ['matches.operations.focused', a => a.matches?.forEach(m => { if (m.via !== 'match' || !m.operations) return; for (const [op, o] of Object.entries(m.operations)) m.operations[op] = { summary: o.summary?.text ?? o.summary ?? null, roles: compactRoles(o.roles) }; if (m.native) m.native = m.native.map(n => n.native); }), () => 'continuation.omitted[].expand (operations+native)'],
    // What survives of validation is the delivery call (it validates inside itself), never the optional headless proof.
    ['envelope', a => { if (a.validation) a.validation = { deliver: a.validation.deliver ?? null }; delete a.routes; delete a.lexical; delete a.terms; if (a.coverage) a.coverage = { lane: a.coverage.lane, laneSpecific: a.coverage.laneSpecific, ...(a.coverage.shared ? { shared: a.coverage.shared } : { sharedCount: a.coverage.sharedCount }) }; if (a.continuation) delete a.continuation.expand; if (a.unavailable?.length) a.unavailable = a.unavailable.map(u => ({ id: u.id, ...(u.alternative ? { alternative: u.alternative } : {}) })); }, () => 'raise budgetBytes to read validation, routes, lexical, coverage.note, continuation.expand and the reasons of unavailable entries'],
    ['matches.direct.minimal', a => a.matches?.forEach(m => { if (m.via !== 'match') return; for (const k of ['category', 'why', 'proofs', 'depends', 'context', 'contract', 'negative', 'lanes', 'native', 'shared', 'score', 'summary', 'title']) delete m[k]; m.expand = `${m.id}:contract+example+evidence+operations+native+bindings`; }), () => 'continuation.omitted[].expand'],
  ];
}
export function applyBudget(answer, budgetBytes) {
  const truncated = [];
  const direct = a => (a.matches ?? []).filter(m => m.via === 'match').map(m => m.id);
  const stages = budgetStages();
  // continuation.omitted names every part a direct match no longer carries, whatever reduced it (design or budget); it
  // is refreshed after every stage so the budget check always measures the answer that will be returned.
  const refreshOmitted = () => {
    if (!Array.isArray(answer.continuation?.omitted)) return;
    const extra = [...new Set(truncated.map(t => OMITTED_PART[t.section]).filter(Boolean))];
    for (const id of direct(answer)) {
      const entry = answer.continuation.omitted.find(o => o.id === id) ?? (() => { const e = { id, parts: [] }; answer.continuation.omitted.push(e); return e; })();
      entry.parts = [...new Set([...entry.parts, ...extra])];
      entry.expand = `${id}:${entry.parts.join('+')}`;
    }
  };
  // `size` is part of the answer, so every check measures the answer exactly as it would be returned: its own byte
  // count written in (fixed point on the digit count) and its final status. Measuring with `bytes: 0` and the status
  // 'within' let an answer end 1 to 5 bytes above the budget once the count and 'reduced' were written in (request
  // A-005: 12004 bytes at 12000).
  answer.size = { bytes: 0, budgetBytes, status: 'within', truncated };
  const measure = () => { let measured = bytes(answer); for (let i = 0; i < 5 && answer.size.bytes !== measured; i++) { answer.size.bytes = measured; measured = bytes(answer); } return measured; };
  refreshOmitted();
  for (const [name, reduce, recover] of stages) {
    if (measure() <= budgetBytes) break;
    const before = bytes(answer); reduce(answer);
    if (bytes(answer) < before) { truncated.push({ section: name, recover: recover(answer) }); answer.size.status = 'reduced'; refreshOmitted(); }
  }
  // The last check is on the returned bytes: above the budget after every stage, the explicit insufficient result.
  if (measure() > budgetBytes) return insufficientAnswer(answer, budgetBytes, truncated);
  return answer;
}
// The explicit result when the minimal answer does not fit: the direct matches by id with their focus and the exact
// expansion, the composition order, and the size that would have been needed. A few hundred bytes; never above the
// budget the API accepts (4096 or more).
function insufficientAnswer(answer, budgetBytes, truncated) {
  const minimalBytes = bytes(answer);
  const matches = (answer.matches ?? []).filter(m => m.via === 'match').map(m => ({ id: m.id, via: 'match', level: m.level ?? null, ...(m.focus ? { focus: { roles: m.focus.roles ?? [], ops: m.focus.ops ?? [] } } : {}), expand: `${m.id}:contract+example+evidence+operations+native+bindings` }));
  const out = { ok: true, schemaVersion: answer.schemaVersion ?? DISCOVERY_SCHEMA, lane: answer.lane ?? null, ...(answer.intent != null ? { intent: answer.intent } : {}),
    identity: answer.identity ? { lane: answer.identity.lane ?? null, index: answer.identity.index ?? null, kernel: answer.identity.kernel ?? null, studio: answer.identity.studio?.ideVersion ?? answer.identity.studio ?? null } : null,
    matches, contracts: {}, examples: {}, bindings: [], composition: { order: answer.composition?.order ?? [] },
    // Declared refusals and gaps survive the minimal result (their ids at least): an intent whose honest answer is a
    // refusal must not lose it to the budget.
    ...(answer.unavailable?.length ? { unavailable: answer.unavailable.map(u => ({ id: u.id, ...(u.alternative ? { alternative: u.alternative } : {}) })) } : {}),
    ...(answer.expansions ? { expansions: Object.fromEntries(Object.keys(answer.expansions).map(k => [k, { omitted: 'budget', expand: k }])) } : {}),
    continuation: { expand: answer.continuation?.expand ?? null, omitted: matches.map(m => ({ id: m.id, parts: ['contract', 'example', 'evidence', 'operations', 'native', 'bindings'], expand: m.expand })) },
    hint: `insufficient budget: the minimal answer needs ${minimalBytes} bytes and the budget is ${budgetBytes}; raise budgetBytes, or narrow with detail <id> / expand <id>:<part>`,
    size: { bytes: 0, budgetBytes, status: 'insufficient', minimalBytes, truncated, note: `insufficient budget: the minimal answer needs ${minimalBytes} bytes; raise budgetBytes or narrow the intent` } };
  const measure = () => { for (let i = 0, measured = bytes(out); i < 5 && out.size.bytes !== measured; i++) { out.size.bytes = measured; measured = bytes(out); } return out.size.bytes; };
  // The budget is a hard limit even below the minimum the API accepts: the explicit result sheds its own detail
  // (stage list, identity, continuation, composition, expansions, focus) down to the ids and the size statement.
  const shed = [
    () => { out.size.truncatedStages = out.size.truncated.length; delete out.size.truncated; },
    () => { delete out.identity; },
    () => { delete out.continuation; delete out.composition; delete out.expansions; },
    () => { out.matches = out.matches.map(m => ({ id: m.id, via: m.via, expand: m.expand })); delete out.intent; if (out.unavailable) out.unavailable = out.unavailable.map(u => ({ id: u.id })); },
    () => { delete out.hint; out.size.note = `insufficient budget: minimal ${minimalBytes} bytes`; },
  ];
  for (const step of shed) { if (measure() <= budgetBytes) break; step(); }
  // Never above the budget (C07): the list of matches is cut from the end (its count stays), then the declared refusals,
  // and last only {ok, size} is left with the bytes the minimal answer needs.
  while (measure() > budgetBytes && out.matches?.length) { out.matches.pop(); out.matchesOmitted = (out.matchesOmitted ?? 0) + 1; }
  if (measure() > budgetBytes && out.unavailable) { out.unavailableOmitted = out.unavailable.length; delete out.unavailable; }
  if (measure() > budgetBytes) { for (const k of Object.keys(out)) if (!['ok', 'size'].includes(k)) delete out[k]; out.size = { bytes: 0, budgetBytes, status: 'insufficient', minimalBytes }; }
  measure();
  return out;
}

// ---- OutSystems UI section (osui-catalog.mjs) for screen-building intents. It is fitted AFTER the model part was
// budgeted, so it never pushes out a match, contract, example, binding, operation or context entry: it goes in at
// the richest level the room left allows (names + one line, then names), then only derived metadata outside the
// matches yields to keep the compact list (the stage-A sections below, each declared in size.truncated), then the
// counts per category, and last a size.truncated note with the expansion. A model answer that did not fit
// (`insufficient`) gets nothing. Never a stage that touches matches (their notes and evidenceRule stay as the model
// budget left them).
const OSUI_YIELDS = ['relatedJobs', 'identity', 'notes', 'coverage.shared'];
const OSUI_RECOVER = lane => `ssam_discover {lane:"${lane}", expand:"osui:<Category>,osui:<Pattern>"} (osui:<appType> lists every pattern of an app type with one line each)`;
export async function outsystemsUiRequest({ lane, intent, matches, context = null, app = null, map = null }) {
  if (!isScreenIntent(intent, matches) || !osuiCatalogAvailable()) return null;
  const request = await outsystemsUiAppTypes({ lane, intent, context, app, map });
  // The patterns the intent names (own name or a catalog synonym: deck -> StackedCards, slider -> RangeSlider).
  const named = namedPatterns(lane, intent, request.appTypes);
  return named.length ? { ...request, named } : request;
}
async function outsystemsUiAppTypes({ lane, intent, context, app, map }) {
  if (context?.ok) {
    const kinds = (context.reads ?? []).map(r => ({ kind: r.kind, count: r.count ?? r.elements?.length ?? 0 }));
    let types = appTypesFromKinds(lane, kinds);
    // An O11 capture whose reads did not say: one cheap probe per flow kind on the module map of the same bytes.
    if (!types.length && lane === 'o11' && map && context.file) {
      const probes = [];
      for (const kind of ['WebFlow', 'MobileFlow']) { const r = await safeInspect(map, { target: context.file, kind, max: 1, expectedSourceSha256: context.sourceSha256 ?? undefined }); if (r.ok) probes.push({ kind, count: r.count ?? r.entries?.length ?? 0 }); }
      types = appTypesFromKinds(lane, probes);
    }
    if (types.length) return { lane, appTypes: types, from: 'capture' };
  }
  const named = appTypesFromIntent(lane, intent);
  if (named.length) return { lane, appTypes: named, from: 'intent' };
  return { lane, appTypes: APP_TYPES[lane] ?? [], from: app ? 'lane (the capture did not say the app type)' : 'lane (app type unknown: every type of the lane)' };
}
export function stripOutsystemsUi(answer) {
  if (!answer || (!('outsystemsUi' in answer) && !answer.size?.truncated?.some(t => t.section === 'outsystemsUi'))) return answer;
  const { outsystemsUi: _section, ...rest } = answer;
  if (rest.size) rest.size = { ...rest.size, truncated: (rest.size.truncated ?? []).filter(t => t.section !== 'outsystemsUi') };
  return rest;
}
// The byte floor of the section (C07 of the 2026-10-05 package): a screen intent at a small budget used to lose the whole
// OutSystems UI list first, so the screen was built from containers. The floor is the counts level (the named patterns
// ride along at every level) plus the room for its size note, when that takes at most a quarter of the budget; else 0.
const OSUI_FLOOR_NOTE = 320;
export function osuiFloor(request, budgetBytes) {
  if (!request || !(budgetBytes > 0)) return 0;
  const need = bytes(osuiSection(request, 'counts')) + OSUI_FLOOR_NOTE;
  return need <= budgetBytes / 4 ? need : 0;
}
// The model part keeps the whole budget when the floor still fits beside it (then it is exactly the answer without the
// section); only when it would leave less than the floor is it budgeted with the floor less (size.reserved says how
// much), and never when that would make it insufficient.
function budgetWithFloor(answer, budgetBytes, request) {
  const floor = osuiFloor(request, budgetBytes);
  const whole = applyBudget(floor ? structuredClone(answer) : answer, budgetBytes);
  if (!floor || whole.size?.status === 'insufficient' || budgetBytes - whole.size.bytes >= floor) return whole;
  const floored = applyBudget(answer, budgetBytes - floor);
  if (floored.size?.status === 'insufficient') return whole;
  floored.size.budgetBytes = budgetBytes; floored.size.reserved = { outsystemsUi: floor };
  return floored;
}
export function fitOutsystemsUi(answer, request, budgetBytes) {
  if (!request || !answer || answer.ok === false) return answer;
  const B0 = budgetBytes ?? answer.size?.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const measure = out => { if (!out.size) return bytes(out); out.size.bytes = 0; let m = bytes(out); for (let i = 0; i < 6 && out.size.bytes !== m; i++) { out.size.bytes = m; m = bytes(out); } return m; };
  // A model answer that did not fit (insufficient) still carries the counts and the named patterns when they fit the
  // room it left: the OutSystems UI list is never the first thing lost (C07).
  if (answer.size?.status === 'insufficient') {
    const out = { ...answer, outsystemsUi: osuiSection(request, 'counts'), size: { ...answer.size } };
    return measure(out) <= B0 ? out : answer;
  }
  const base0 = stripOutsystemsUi(answer);
  const B = B0;
  const place = (base, section, extra) => {
    const out = {}; let placed = false;
    for (const [k, v] of Object.entries(base)) { if (!placed && section && ['validation', 'continuation', 'elapsedMs', 'size'].includes(k)) { out.outsystemsUi = section; placed = true; } out[k] = v; }
    if (!placed && section) out.outsystemsUi = section;
    if (out.size) { out.size = { ...out.size, truncated: [...(out.size.truncated ?? []), ...extra] }; if (extra.length) out.size.status = 'reduced'; }
    return out;
  };
  const attempt = (base, level, yielded = []) => {
    const note = level === 'lines' ? [] : [{ section: 'outsystemsUi', recover: `reduced to ${level}: ` + OSUI_RECOVER(request.lane) }];
    const out = place(base, osuiSection(request, level), [...yielded, ...note]);
    return measure(out) <= B ? out : null;
  };
  for (const level of ['lines', 'names']) { const out = attempt(base0, level); if (out) return out; }
  const base = structuredClone(base0); const yielded = [];
  for (const [name, reduce, recover] of budgetStages().filter(([n]) => OSUI_YIELDS.includes(n))) {
    const before = bytes(base); reduce(base);
    if (bytes(base) >= before) continue;
    yielded.push({ section: name, recover: `${recover(base)} (left out for the OutSystems UI list)` });
    const out = attempt(base, 'names', yielded); if (out) return out;
  }
  const counts = attempt(base0, 'counts'); if (counts) return counts;
  const noted = place(base0, null, [{ section: 'outsystemsUi', recover: `left out: the model part used the budget; ${OSUI_RECOVER(request.lane)}` }]);
  return measure(noted) <= B ? noted : base0;
}

// ---- batch continuation: `--expand <id>:<part>+<part>,<id>:<part>,contract:<pointer>,element:<Kind:Name|@key>`
// Each request names precisely what the composite answer omitted; the parts are the four things an author may still
// need for a capability already selected: its whole contract slices, the example excerpt, the evidence (proof
// records, notes, coverage, negatives) and its proven bindings; `native:<Interface>` adds Model API metadata (A);
// `element:` reads one element's signature from the capture (needs --app).
export function parseExpand(spec) {
  const requests = []; const problems = [];
  for (const item of String(spec ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
    const at = item.indexOf(':');
    if (at < 0) { requests.push({ kind: 'capability', id: item, parts: ['contract', 'example', 'evidence', 'bindings'] }); continue; }
    const head = item.slice(0, at); const tail = item.slice(at + 1);
    if (head === 'contract') { requests.push({ kind: 'contract', pointer: tail }); continue; }
    if (head === 'element') { requests.push({ kind: 'element', selector: tail }); continue; }
    if (head === 'native') { requests.push({ kind: 'native', type: tail }); continue; }
    if (head === 'osui') { requests.push({ kind: 'osui', selector: tail }); continue; }
    const parts = tail.split('+').map(p => p.trim()).filter(Boolean);
    const unknown = parts.filter(p => p !== 'all' && !EXPAND_PARTS.includes(p));
    if (unknown.length) { problems.push(`${item}: unknown part(s) ${unknown.join(', ')}; parts: ${EXPAND_PARTS.join(', ')}, all`); continue; }
    requests.push({ kind: 'capability', id: head, parts: parts.includes('all') ? ['contract', 'example', 'evidence', 'bindings'] : parts });
  }
  // The same capability named twice in one call (`a:example,...,a:operations`) is one request with the union of the
  // parts: the later request used to replace the earlier one silently (seen in the phase-3 evaluation, A-o11).
  const merged = []; for (const r of requests) { const same = r.kind === 'capability' ? merged.find(m => m.kind === 'capability' && m.id === r.id) : null; if (same) same.parts = [...new Set([...same.parts, ...r.parts])]; else merged.push(r); }
  return { requests: merged, problems };
}
function evidenceOf(index, c) {
  const proofs = proofsOf(index, c, { full: true }).map(p => { const job = index.jobs.find(j => j.name === p.job); return { ...p, description: job?.description, base: job?.base, ops: job?.ops, types: job?.types, props: job?.props, steps: job?.steps, notes: job?.notes?.slice(0, 6), coverage: job?.executed?.coverage ?? null, expectedMessages: job?.expectedMessages }; });
  return { level: levelOf(index, c), proofs, negative: (c.negative?.[index.lane] ?? []).map(n => index.negatives.find(k => k.name === n)).filter(Boolean).map(n => ({ job: n.name, description: n.description, expectError: n.expectError })), limits: c.limits ?? [], guidance: c.guidance ?? null, alternatives: c.alternatives ?? [] };
}
async function expandAnswer(index, sources, { requests, app, inspect, lane, osuiCap = Infinity }) {
  const expansions = {}; const problems = [];
  for (const r of requests) {
    if (r.kind === 'osui') {
      let x; try { x = osuiExpansion(lane, r.selector, { capBytes: osuiCap }); } catch (e) { x = { error: 'OutSystems UI catalog unavailable: ' + e.message }; }
      if (x.error) problems.push({ request: 'osui:' + r.selector, error: x.error, known: x.known }); else expansions['osui:' + r.selector] = x;
    } else if (r.kind === 'capability') {
      const c = index.capabilities.find(k => k.id === r.id);
      if (!c) { problems.push({ request: r.id, error: 'unknown capability', known: index.capabilities.map(k => k.id) }); continue; }
      const part = {};
      if (r.parts.includes('contract')) part.contract = contractSlice(index, c.contract, { full: true, capBytes: 65536 });
      if (r.parts.includes('example')) part.example = exampleOps(sources, index, c);
      if (r.parts.includes('evidence')) part.evidence = evidenceOf(index, c);
      if (r.parts.includes('bindings')) { const seen = new Set(); part.bindings = []; for (const name of c.proofs?.[lane] ?? []) for (const b of index.jobs.find(j => j.name === name)?.bindings ?? []) if (!seen.has(b.rule)) { seen.add(b.rule); part.bindings.push({ rule: b.rule, job: name, op: b.op, rank: b.rank ?? 2, example: b.example }); } part.bindings.sort((a, b) => a.rank - b.rank); }
      if (r.parts.includes('native')) part.native = nativeOf(index, c);
      if (r.parts.includes('operations')) part.operations = operationsOf(index, c);
      expansions[r.id] = { title: c.title, route: routeOf(index, c), ...part };
    } else if (r.kind === 'contract') {
      const node = contractNode(index, r.pointer);
      if (node === undefined) problems.push({ request: 'contract:' + r.pointer, error: 'pointer does not resolve in api --op output' }); else expansions['contract:' + r.pointer] = node;
    } else if (r.kind === 'native') {
      const wanted = r.type.replace(/^I?/, 'I');
      const runtime = Object.entries(index.nativeRuntime ?? {}).find(([t]) => t === r.type || t.split('.').at(-1) === wanted)?.[1] ?? null;
      expansions['native:' + r.type] = { ...nativeType(sources, index, r.type), ...(runtime ? { runtime: { provenance: 'A-runtime', ...runtime } } : {}) };
    } else if (r.kind === 'element') {
      if (!app) { problems.push({ request: 'element:' + r.selector, error: 'element expansions need app (a capture .oml)' }); continue; }
      if (!inspect) { problems.push({ request: 'element:' + r.selector, error: 'no reader available in this entry' }); continue; }
      const read = await safeInspect(inspect, { target: app, path: r.selector, depth: 2, budget: 200000 });
      if (!read.ok) { problems.push({ request: 'element:' + r.selector, error: read.error }); continue; }
      const tree = read.tree ?? read.data?.tree;
      expansions['element:' + r.selector] = tree ? { ...signatureOf(tree), sourceSha256: read.sourceSha256 ?? null } : { error: 'no tree returned', keys: Object.keys(read) };
    }
  }
  return { expansions, problems };
}

// ---- what the intent names beyond the capability matches (C07 of the 2026-10-05 package). `steps`: the grammar of each
// logic step the intent names (the logic op contract of the lane, one slice per step) and ONE whole proven job of the lane
// suite whose logic op uses them all; `values`: the closed values of a property the intent names, per lane; `provenExample`:
// among the proofs of the direct matches, the suite job holding the most words of the intent, whole up to a cap, with the
// ssam_reference id that returns it again. All three come from the index (job summaries, contracts): no new source.
const plainWords = text => normalize(text).split(/[^a-z0-9]+/).filter(Boolean);
const ACTION_TERMS = new Set(['action', 'actions', 'acao', 'acoes', 'logic', 'logica', 'fluxo', 'flow', 'funcao', 'function', 'rotina']);
const RECORD_TERMS = new Set(['registro', 'registros', 'record', 'records']);
// Step kinds of the logic op (contract logic.steps) and the words that name each; the record steps only beside a record word.
const STEP_TERMS = [
  ['get', ['aggregate', 'aggregates', 'agregado', 'agregados', 'agregacao', 'query', 'consulta', 'fetch', 'buscar', 'busca']],
  ['if', ['if', 'condicao', 'condicional', 'conditional', 'senao']],
  ['foreach', ['foreach', 'loop', 'percorrer', 'percorre', 'iterar', 'itera', 'iterate']],
  ['while', ['while', 'enquanto']],
  ['switch', ['switch']],
  ['assign', ['assign', 'atribuir', 'atribui', 'atribuicao', 'assignment']],
  ['call', ['chamar', 'chama', 'call', 'invocar', 'invoca', 'invoke']],
  ['raise', ['raise', 'excecao', 'exception', 'lancar', 'lanca', 'throw']],
  ['return', ['return', 'retornar', 'retorna']],
];
const RECORD_STEPS = [['save', ['salvar', 'salva', 'gravar', 'grava', 'save']], ['create', ['inserir', 'insere', 'insert']], ['update', ['atualizar', 'atualiza', 'update', 'alterar', 'altera']], ['delete', ['apagar', 'apaga', 'excluir', 'exclui', 'delete', 'remover', 'remove']]];
export function stepKindsOf(intent) {
  const w = plainWords(intent); const has = list => list.some(t => w.includes(t));
  if (!w.some(t => ACTION_TERMS.has(t))) return [];
  const kinds = STEP_TERMS.filter(([, list]) => has(list)).map(([k]) => k);
  const text = ' ' + w.join(' ') + ' ';
  if (!kinds.includes('foreach') && /\s(for each|para cada)\s/.test(text)) kinds.push('foreach');
  if (w.some(t => RECORD_TERMS.has(t))) for (const [k, list] of RECORD_STEPS) if (has(list) && !kinds.includes(k)) kinds.push(k);
  return kinds;
}
const STEPS_EXAMPLE_CAP = 6144;
// Whether the logic actions of a job that use the named steps fit the steps example cap (stepsSection shows them whole).
function fitsSteps(raw, kinds) {
  const kindsIn = steps => { const found = new Set(); const walk = list => { for (const s of list ?? []) { const k = Object.keys(s ?? {}).find(x => !['as', 'label'].includes(x)); if (k) found.add(k); for (const b of ['then', 'else', 'do', 'otherwise', 'steps']) if (Array.isArray(s[b])) walk(s[b]); for (const c of Array.isArray(s.switch) ? s.switch : []) walk(c?.steps); } }; walk(steps); return found; };
  const actions = (raw?.ops ?? []).filter(op => op?.op === 'logic').flatMap(op => op.data?.actions ?? []).map(a => ({ a, kinds: kindsIn([...(a.steps ?? []), ...(a.handlers ?? []).flatMap(h => h.steps ?? [])]) }));
  const all = actions.filter(x => kinds.every(k => x.kinds.has(k))).sort((p, q) => bytes(p.a) - bytes(q.a));
  const shown = all.length ? [all[0].a] : actions.filter(x => kinds.some(k => x.kinds.has(k))).map(x => x.a);
  return shown.length > 0 && bytes({ op: 'logic', data: { actions: shown } }) <= STEPS_EXAMPLE_CAP;
}
function stepsSection(sources, index, kinds) {
  if (!kinds.length) return null;
  const grammar = Object.fromEntries(kinds.map(k => [k, contractNode(index, 'logic.steps.' + k) ?? null]));
  const action = contractNode(index, 'logic.action') ?? null;
  // The smallest suite job (by bytes) whose logic op uses every step named; ties by name.
  // A composite example (its parts' ops, not its own) is never the smallest job: its file holds only the list of parts.
  const candidates = index.jobs.filter(j => !j.composite && j.ops?.logic && kinds.every(k => j.steps?.[k])).map(j => {
    const file = path.join(sources.jobsDir, j.name + '.json'); let size = Infinity; try { size = fs.statSync(file).size; } catch {}
    return { j, file, size };
  }).filter(x => Number.isFinite(x.size)).sort((a, b) => a.size - b.size || a.j.name.localeCompare(b.j.name));
  let example = null;
  // The smallest candidate whose actions with these steps fit the cap (a small file can hold one large action); else the
  // smallest, whose answer then says to read it whole.
  const shownOf = candidate => { let raw = null; try { raw = readJson(candidate.file); } catch {} return { ...candidate, raw }; };
  if (candidates.length) {
    const { j, raw } = candidates.map(shownOf).find(c => fitsSteps(c.raw, kinds)) ?? shownOf(candidates[0]);
    // The whole action that uses every named step (the smallest one), else every action that uses one of them: each
    // action shown is complete; the other actions of the job are one ssam_reference call away.
    const kindsIn = steps => { const found = new Set(); const walk = list => { for (const s of list ?? []) { const k = Object.keys(s ?? {}).find(x => !['as', 'label'].includes(x)); if (k) found.add(k); for (const b of ['then', 'else', 'do', 'otherwise', 'steps']) if (Array.isArray(s[b])) walk(s[b]); for (const c of Array.isArray(s.switch) ? s.switch : []) walk(c?.steps); } }; walk(steps); return found; };
    const actions = (raw?.ops ?? []).filter(op => op?.op === 'logic').flatMap(op => op.data?.actions ?? []).map(a => ({ a, kinds: kindsIn([...(a.steps ?? []), ...(a.handlers ?? []).flatMap(h => h.steps ?? [])]) }));
    const all = actions.filter(x => kinds.every(k => x.kinds.has(k))).sort((p, q) => bytes(p.a) - bytes(q.a));
    const shown = all.length ? [all[0].a] : actions.filter(x => kinds.some(k => x.kinds.has(k))).map(x => x.a);
    const op = { op: 'logic', data: { actions: shown } };
    const fits = bytes(op) <= STEPS_EXAMPLE_CAP;
    example = { job: j.name, path: j.path, description: brief(j.description, 300), base: j.base, level: jobLevel(j), actionsShown: fits ? shown.length : 0, actionsTotal: actions.length,
      ...(fits ? { ops: [op] } : { ops: [], note: `the actions that use these steps take ${bytes(op)} bytes: read the job whole by its id` }),
      reference: { tool: 'ssam_reference', arguments: { lane: index.lane, kind: 'example', query: { id: j.name } } } };
  }
  return { why: 'the logic op writes one step per flow element; the keys each named step takes come from the logic op contract of this lane', kinds,
    shape: { op: 'logic', data: { actions: [action ? `{${action.join(', ')}}` : '{name, kind, inputs, outputs, vars, steps}'] } }, grammar,
    ...(example ? { example } : { example: null, note: 'no suite job of this lane uses every step named together; each step keeps its grammar above' }) };
}
// Closed values the kernel itself compiles or the Studio wrote back in a proven job, per lane. A rule answers only when
// the intent names its property (or the widget/element it belongs to together with a value word).
const INPUT_TYPES = { text: 'Text', password: 'Password', number: 'Number', time: 'Time', date: 'Date', 'datetime-local': 'Datetime', tel: 'Phone', email: 'Email', search: 'Search' };
const VALUE_RULES = [
  { property: 'InputType', when: w => w.includes('inputtype') || (['input', 'campo', 'field'].some(t => w.includes(t)) && ['tipo', 'type', 'senha', 'password', 'email', 'telefone', 'phone', 'numero', 'number', 'data', 'date'].some(t => w.includes(t))),
    answer: lane => ({ property: 'InputType', element: lane === 'o11' ? 'IInput (Reactive/Mobile); Traditional IInputWidget: read its values with expand native:IInputWidget' : 'IInput',
      set: Object.values(INPUT_TYPES), fragment: { attribute: 'type', values: INPUT_TYPES, rule: 'html fragment and page mode: <input type="..."> maps to these; without type the InputType follows the data type of the bound variable, else Text' },
      source: 'kernel HtmlVisual.InputTypes and ScreenVocabulary IInput.InputType' }) },
  { property: 'Schedule', lanes: ['o11'], when: w => ['timer', 'timers', 'schedule', 'agendamento', 'agendar', 'agendado', 'agendada'].some(t => w.includes(t)),
    answer: () => ({ property: 'Schedule', element: 'ITimer', set: ['Every 60 minutes', 'Every day at 00:00', 'Every Monday at 00:05'],
      rule: 'the O11 schedule is text as the Service Studio writes it: Every <n> minutes | Every day at HH:mm | Every <Weekday> at HH:mm; read it back by get',
      proof: 'tests/jobs/pacote-laneE-timer-schedule.json' }) },
  { property: 'CronSchedule', lanes: ['odc'], when: w => ['timer', 'timers', 'schedule', 'cron', 'agendamento', 'agendar', 'agendado', 'agendada'].some(t => w.includes(t)),
    answer: () => ({ property: 'CronSchedule', element: 'ITimer', set: ['0 * * * *', '0 0 * * *', '5 0 * * 1'],
      rule: 'five fields: minute hour day-of-month month day-of-week (every hour, every day at 00:00, Mondays at 00:05); a six-field cron is refused; the ScheduleConfiguration tree is derived from it',
      proof: 'tests/jobs-odc/timer-action.json' }) },
];
export function valuesFor(lane, intent) {
  const w = plainWords(intent);
  const out = VALUE_RULES.filter(r => (!r.lanes || r.lanes.includes(lane)) && r.when(w)).map(r => r.answer(lane));
  return out.length ? out : null;
}
const PROVEN_CAP = 6144;
const PROVEN_STOP = new Set(['criar', 'crie', 'create', 'com', 'uma', 'umas', 'uns', 'que', 'para', 'the', 'with', 'and', 'for', 'new', 'novo', 'nova', 'add', 'adicionar']);
export function provenExample(sources, index, matches, intent, { unmatched = [] } = {}) {
  const words = [...new Set(plainWords(intent).filter(t => t.length > 2 && !PROVEN_STOP.has(t)))];
  if (!words.length) return null;
  const candidates = [];
  for (const [rank, m] of (matches ?? []).filter(x => x.via === 'match').entries()) {
    const c = index.capabilities.find(k => k.id === m.id);
    for (const [order, name] of (c?.proofs?.[index.lane] ?? []).entries()) {
      const job = index.jobs.find(j => j.name === name); if (!job) continue;
      const text = normalize([job.name.replaceAll('-', ' '), job.description, ...Object.keys(job.types ?? {}), ...Object.keys(job.props ?? {}), ...Object.keys(job.steps ?? {})].join(' '));
      // A job named for another operation (delete-..., rename-...) than the ones the intent focuses is not its example.
      const named = /(?:^|-)(delete|rename|move|reorder|replace|duplicate)(?:-|$)/.exec(job.name)?.[1];
      const off = named && !(m.focus?.ops ?? []).includes(named === 'reorder' ? 'move' : named);
      candidates.push({ m, job, rank, order, off, hits: words.filter(t => text.includes(t)) });
    }
  }
  if (candidates.some(x => !x.off && words.some(t => x.hits.includes(t)))) for (let i = candidates.length - 1; i >= 0; i--) if (candidates[i].off) candidates.splice(i, 1);
  // A word every candidate holds ("tela", "ligado") tells less than one only a few hold ("dropdown", "hora"): each hit
  // weighs 1 + ln(candidates / candidates holding the word). A word that matched nothing of the index (a domain noun such
  // as "cliente", lexical.unmatched) only breaks ties: a quarter of that.
  const df = new Map(words.map(t => [t, candidates.filter(x => x.hits.includes(t)).length]));
  const loose = new Set([...(unmatched ?? [])].map(t => normalize(t)));
  let best = null;
  for (const x of candidates) {
    if (!x.hits.length) continue;
    const score = x.hits.reduce((s, t) => s + (loose.has(t) ? 0.25 : 1) * (1 + Math.log(candidates.length / df.get(t))), 0);
    // Highest weight first; then the earlier direct match, then the earlier proof (descriptor order).
    const key = [Math.round(score * 1000), -x.rank, -x.order];
    const better = !best || (() => { for (let i = 0; i < key.length; i++) if (key[i] !== best.key[i]) return key[i] > best.key[i]; return false; })();
    if (better) best = { ...x, key };
  }
  if (!best) return null;
  let raw; try { raw = readJob(path.join(sources.jobsDir, best.job.name + '.json'), sources); } catch { return null; }
  const all = (raw.ops ?? []).map(({ _why, ...op }) => op);
  const ops = []; for (const op of all) { if (bytes(ops) + bytes(op) > PROVEN_CAP) break; ops.push(op); }
  return { for: best.m.id, job: best.job.name, path: best.job.path, description: brief(best.job.description, 300), base: best.job.base, level: jobLevel(best.job), why: best.hits,
    expectedMessages: best.job.expectedMessages ?? [], opsTotal: all.length, opsShown: ops.length, whole: ops.length === all.length, ops,
    ...(ops.length === all.length ? {} : { note: 'FRAGMENT: the first ops of the job; the whole job by its id' }),
    reference: { tool: 'ssam_reference', arguments: { lane: index.lane, kind: 'example', query: { id: best.job.name } } } };
}

// The three sections out of an answer (discoverAll fits the tools first and puts them back in the room left).
export function stripC07(answer) {
  if (!answer || !['provenExample', 'steps', 'values'].some(k => k in answer)) return { answer, extras: null };
  const { provenExample = null, steps = null, values = null, ...rest } = answer;
  if (rest.size?.truncated) rest.size = { ...rest.size, truncated: rest.size.truncated.filter(t => t.section !== 'c07') };
  return { answer: rest, extras: { provenExample, steps, values } };
}
// The three sections go in AFTER the model part was budgeted and never change it (the same rule as the OutSystems UI
// section): each at the richest form the room left allows. The proven example shrinks first (whole -> its first 6 ops ->
// its id and reference), then the logic example (whole action -> id and reference), then the grammar, then the values;
// what does not fit is named once in size.truncated (section c07) when that note itself fits.
export function fitC07(answer, extras, budgetBytes) {
  if (!answer?.size || answer.ok === false || !extras) return answer;
  const { provenExample: p = null, steps: s = null, values: v = null } = extras;
  if (!p && !s && !v) return answer;
  const ref = x => (x ? { job: x.job, path: x.path, reference: x.reference, note: 'reduced by budget: the whole job by its id' } : null);
  const proven = p ? [p, p.ops?.length > 6 ? { ...p, ops: p.ops.slice(0, 6), opsShown: 6, whole: false, note: 'FRAGMENT (reduced by budget): the whole job by its id (reference)' } : null, ref(p), null].filter((x, i, all) => x !== null || i === all.length - 1) : [null];
  const steps = s ? [s, s.example ? { ...s, example: ref(s.example) } : null, { kinds: s.kinds, grammar: s.grammar }, null].filter((x, i, all) => x !== null || i === all.length - 1) : [null];
  const values = v ? [v, null] : [null];
  const measure = out => { out.size.bytes = 0; let m = bytes(out); for (let i = 0; i < 6 && out.size.bytes !== m; i++) { out.size.bytes = m; m = bytes(out); } return m; };
  const place = (pe, st, va, omitted) => {
    const out = {}; let placed = false;
    const put = () => { if (pe) out.provenExample = pe; if (st) out.steps = st; if (va) out.values = va; placed = true; };
    for (const [k, val] of Object.entries(answer)) { out[k] = val; if (!placed && k === 'examples') put(); }
    if (!placed) { const size = out.size; delete out.size; put(); out.size = size; }
    out.size = { ...answer.size, ...(omitted.length ? { truncated: [...(answer.size.truncated ?? []), { section: 'c07', recover: `left out by the budget: ${omitted.join(', ')}; raise budgetBytes` }], status: answer.size.status === 'within' ? 'reduced' : answer.size.status } : {}) };
    return out;
  };
  // Every combination in degradation order: the proven example first, then the logic example, then the values.
  for (const va of values) for (const st of steps) for (const pe of proven) {
    const omitted = [...(p && !pe ? ['provenExample'] : []), ...(s && !st ? ['steps'] : []), ...(v && !va ? ['values'] : [])];
    const out = place(pe, st, va, omitted);
    if (measure(out) <= budgetBytes) return out;
  }
  return answer;
}

// ---- public entry
export async function discover({ lane = 'odc', intent = '', app = null, detail = null, expand = null, type = null, limit = 8, rebuild = false, budgetBytes = DEFAULT_BUDGET_BYTES, inspect = null, map = null, sources = laneSources(lane), descriptorFile = sources.descriptor, outsystemsUi = true, packet = false, digest = null, operations = null } = {}) {
  const started = performance.now();
  const built = await buildIndex(lane, { sources, descriptorFile, rebuild });
  const index = built.index;
  const identity = { lane, index: index.key, builtAt: index.builtAt, cli: index.identity.cli.sha256, kernel: index.identity.cli.kernelSha256, studio: { platform: index.identity.studio.platform, ideVersion: index.identity.studio.ideVersion, verifyDefinitions: index.identity.studio.verifyDefinitions, assembliesCompared: Object.keys(index.identity.studio.assemblies ?? {}).length },
    fixture: index.identity.fixture?.sha256 ?? null, descriptor: index.identity.descriptor.sha256, jobs: index.identity.jobs, modelApi: index.identity.modelApi?.version ?? null, cache: built.cache.hit ? 'reused' : 'rebuilt', keyStrategy: index.identity.keyStrategy, warnings: [] };
  identity.nativeRuntime = index.identity.nativeRuntime ?? null;
  identity.shared = index.identity.descriptor.shared ?? null;
  // Every source has its own version; when they disagree the answer says so instead of pretending one identity.
  if (identity.modelApi && identity.studio?.ideVersion && identity.modelApi !== identity.studio.ideVersion) identity.warnings.push(`native API metadata (A) was extracted from Studio ${identity.modelApi}; the installed Studio is ${identity.studio.ideVersion}: trust native.runtime (A-runtime, read from the installed Studio) over the index for the shared capabilities; regenerate the index (${lane === 'odc' ? 'platforms/odc/studio/apiindex' : 'anvil catalog --out kernel/catalog'}) before trusting any other difference`);
  if (index.identity.studio?.error) identity.warnings.push('Studio identity could not be measured: ' + index.identity.studio.error);
  if (index.identity.fixture?.available === false) identity.warnings.push('lane fixture not found: proof levels refer to the suite directory only');
  if (index.identity.fixture?.warning) identity.warnings.push(index.identity.fixture.warning);
  // Capabilities that left the index because a pointer into the sources broke (A10): named in every answer, never silent.
  const dropNote = index.dropped?.length ? { dropped: index.dropped.slice(0, 8), ...(index.dropped.length > 8 ? { droppedTotal: index.dropped.length } : {}) } : {};
  if (index.identity.jobs.results === 0) identity.warnings.push('no job result on this machine: every proof is C-suite (run the lane suite to obtain executed levels)');
  else if (index.identity.jobs.current === 0) identity.warnings.push(`job results exist (${index.identity.jobs.results}) but none matches the current job/fixture/kernel/Studio combination: they are historical; rerun the lane suite for current proofs`);
  // `--detail <id>` is the single-capability form of `--expand`; `--type` adds the native metadata of one interface.
  const expandSpec = [expand, detail ? `${detail}:contract+example+evidence+bindings` : null, type ? `native:${type}` : null].filter(Boolean).join(',');
  if (expandSpec && !intent.trim()) {
    const { requests, problems: parseProblems } = parseExpand(expandSpec);
    if (parseProblems.length) return { ok: false, schemaVersion: DISCOVERY_SCHEMA, lane, error: 'invalid expand: ' + parseProblems.join('; '), identity };
    const { expansions, problems } = await expandAnswer(index, sources, { requests, app, inspect, lane });
    if (Object.keys(expansions).length === 0) return { ok: false, schemaVersion: DISCOVERY_SCHEMA, lane, error: 'nothing to expand: ' + problems.map(p => p.request + ': ' + p.error).join('; '), known: index.capabilities.map(k => k.id), identity };
    const answer = { ok: true, schemaVersion: DISCOVERY_SCHEMA, lane, ...dropNote, identity, expansions, problems, elapsedMs: Math.round(performance.now() - started) };
    // The OutSystems UI entries shape themselves (whole, brief, one line, names) to their share of the room the rest
    // of the budgeted answer leaves: the budget stages do not know their parts.
    const osuiKeys = Object.keys(expansions).filter(k => k.startsWith('osui:'));
    if (osuiKeys.length) {
      const bare = applyBudget(structuredClone({ ...answer, expansions: Object.fromEntries(Object.entries(expansions).filter(([k]) => !k.startsWith('osui:'))) }), budgetBytes);
      const share = Math.max(1024, Math.floor((budgetBytes - (bare.size?.bytes ?? 0) - 256) / osuiKeys.length));
      for (const k of osuiKeys) expansions[k] = osuiExpansion(lane, k.slice('osui:'.length), { capBytes: share });
      return applyBudget(answer, budgetBytes);
    }
    // The expansion of a ui.* capability builds screens too: it carries the OutSystems UI section of the lane (every app
    // type of the lane; the capture is not read here), under the same byte floor as a screen intent.
    const ui = Object.keys(expansions).some(k => k.startsWith('ui.')) && osuiCatalogAvailable() ? { lane, appTypes: APP_TYPES[lane] ?? [], from: 'lane (expansion of a ui capability)' } : null;
    return ui ? fitOutsystemsUi(budgetWithFloor(answer, budgetBytes, ui), ui, budgetBytes) : applyBudget(answer, budgetBytes);
  }
  // What this lane covers: its own capabilities plus the shared ones projected for it. Nothing is inherited from
  // another lane's descriptor: an intent outside this coverage answers with this list, not with the other lane's.
  const coverage = { lane, capabilities: index.capabilities.length, laneSpecific: index.identity.descriptor.laneCapabilities ?? index.capabilities.length, shared: index.shared?.capabilities ?? [],
    note: index.shared ? `shared capabilities (${index.shared.capabilities.join(', ')}) are defined once for lanes ${index.shared.lanes.join('/')} and answered here with this lane's proofs, native types and differences only` : 'no shared capabilities' };
  if (!intent.trim()) return { ok: false, schemaVersion: DISCOVERY_SCHEMA, lane, error: 'intent is required (or expand "<id>:<parts>" / detail "<capability>")', categories: [...new Set(index.capabilities.map(c => c.category))], capabilities: index.capabilities.map(c => ({ id: c.id, title: c.title, ...(c.shared ? { shared: true } : {}) })), coverage, identity };
  const q = query(index, { intent, limit });
  // Example excerpts for the direct matches (the first ops of the best proof job for the capability's verbs), so the
  // shape of a valid op is in the same answer as its contract.
  const examples = {};
  for (const m of q.matches.filter(x => x.via === 'match')) { const c = index.capabilities.find(k => k.id === m.id); const ex = exampleOps(sources, index, c, { maxOps: 8, focus: m.focus ?? null }); if (ex) examples[m.id] = ex; }
  // C07: one whole proven job chosen by the words of the intent, the grammar of the logic steps it names, closed values.
  const proven = provenExample(sources, index, q.matches, intent, { unmatched: q.unmatched });
  const steps = stepsSection(sources, index, stepKindsOf(intent));
  const values = valuesFor(lane, intent);
  // packet:true (W1): the work packet an agent starts from (work-packet.mjs), from the same matches, contracts and proven
  // example, plus the elements of the capture the intent names (its module digest) and the team rules; nothing in it
  // depends on the time or the cache, so the same input gives the same bytes. Within the answer ceiling (PACKET_BUDGET).
  if (packet) {
    const { workPacket, PACKET_BUDGET, namedCapabilities } = await import('./work-packet.mjs');
    let found = null;
    if (app) { const reader = digest ?? laneDigest(lane, sources); found = reader ? await reader(app) : { ok: false, target: app, error: 'no module digest reader on lane ' + lane }; }
    // The capabilities of the elements the intent names exactly in the module come first; the proven example is chosen
    // again with them.
    const named = found?.ok ? namedCapabilities(found.digest, intent).filter(n => !q.matches.some(m => m.id === n.id && m.via === 'match')) : [];
    const extra = named.map(n => packetMatch(index, n.id, [n.element + ' (' + n.kind + ' of the module)'])).filter(Boolean);
    const matches = [...extra, ...q.matches];
    const chosen = extra.length ? provenExample(sources, index, matches, intent, { unmatched: q.unmatched }) ?? proven : proven;
    const first = matches.find(m => m.via === 'match');
    const firstExample = !first ? null : examples[first.id] ?? exampleOps(sources, index, index.capabilities.find(k => k.id === first.id), { maxOps: 8, focus: first.focus ?? null });
    return workPacket({ lane, intent, app, basis: { index: index.key }, matches, unavailable: q.unavailable,
      categories: new Map(index.capabilities.map(c => [c.id, c.category])),
      slices: (pointers, form) => contractSlice(index, pointers, { full: form === 'full', capBytes: 3072 }),
      steps: steps ? { kinds: steps.kinds, shape: steps.shape, grammar: steps.grammar } : null,
      proven: chosen, example: firstExample, exampleFor: first?.id ?? null, module: found, operations },
    { budgetBytes: Math.min(budgetBytes, PACKET_BUDGET) });
  }
  let context = null;
  if (app) context = inspect ? await applicationContext(index, sources, { app, matches: q.matches, terms: q.terms, inspect, map }) : { ok: false, status: 'failed', code: 'NO_READER', target: app, error: 'no reader available in this entry for lane ' + lane, reads: [], signatures: [], reuse: [] };
  if (context?.ok) {
    // A conditional dependency whose kind already has elements in the capture may already be satisfied: say which.
    for (const m of q.matches) if (m.conditions?.length && m.context?.kinds?.length) {
      const existing = context.reads.filter(r => m.context.kinds.includes(r.kind) && r.elements?.length).flatMap(r => r.elements.slice(0, 5).map(e => e.name ?? e));
      if (existing.length) m.existingInCapture = existing;
    }
  }
  // Deliver first and directly: the deliver call captures the live module and runs every gate itself, refusing before any
  // change with the fix. The headless proof is for a person who asks for one; leading with it sent sessions through a
  // fixture proof and a preview before every delivery (QuizLive and OfficePet, 2026-10-05).
  const validation = {
    deliver: sources.entries.deliver + '  (directly: validates inside, refuses before any change)', publish: sources.entries.publish,
    gates: 'inside the deliver call: fresh capture of the live module -> candidate validation (no new errors or warnings, a change against that capture) -> check-base -> preview -> merge with strictlyEqual=true; an uncertain result is never retried: read receipt.json and the journal',
    prove: sources.prove('<job.json>') + (sources.fixture ? '  (only when the person asks for a headless proof on the lane fixture; delivers nothing)' : '  (only when the person asks for a headless proof on the base the job declares, or base: <capture.oml>; delivers nothing)'),
  };
  const answer = { ok: true, schemaVersion: DISCOVERY_SCHEMA, lane, intent, ...dropNote, identity, terms: q.terms,
    matches: q.matches, contracts: q.contracts, examples, bindings: q.bindings, bindingsTotal: q.bindingsTotal, routes: q.routes,
    composition: { order: q.order, decisions: q.decisions, recommended: q.recommended, cycles: q.cycles, invalidDependencies: q.invalidDependencies },
    unavailable: q.unavailable, relatedJobs: q.relatedJobs, coverage,
    lexical: { unmatched: q.unmatched, note: 'words of the intent that matched no keyword, title or summary; lexical coverage only, not a judgement on whether the intent was understood or is complete' },
    ...(context ? { context } : {}), validation,
    continuation: {
      note: 'everything reduced by the budget is listed in size.truncated with the exact expand that returns it; one ssam_discover call with expand takes several requests separated by commas',
      expand: `ssam_discover {lane:"${lane}", expand:"<id>:contract+example+evidence+bindings,<id>:example,contract:<pointer>,element:<Kind:Name>", app?:"<capture.oml>", budgetBytes?}`,
      omitted: [],
    },
    elapsedMs: Math.round(performance.now() - started) };
  // What this answer already leaves out on purpose (not by budget): the parts an expansion returns.
  for (const m of q.matches.filter(x => x.via === 'match')) {
    const missing = [];
    if (Object.entries(q.contracts).some(([k, v]) => m.contract.includes(k) && v?.expand)) missing.push('contract');
    if (examples[m.id]?.fragment) missing.push('example');
    missing.push('evidence');
    answer.continuation.omitted.push({ id: m.id, parts: missing, expand: `${m.id}:${missing.join('+')}` });
  }
  const directCount = q.matches.filter(m => m.via === 'match').length; const alternativeIds = q.matches.filter(m => m.via === 'alternative').map(m => m.id);
  if (directCount === 0 && q.unavailable.length === 0) answer.hint = (alternativeIds.length
    ? `No capability is named by an element word of the intent; the operation words touched ${alternativeIds.join(', ')} (listed as alternatives): name the element (entity, attribute, index, static entity, record, structure, screen, action...) or open one with detail <id>.`
    : 'Nothing in the ' + lane + ' index matched these words: ' + (q.unmatched.join(', ') || intent) + '. Try other words, or list capabilities with an empty intent.') + (coverage.laneSpecific === 0 ? ` This lane covers only the shared capabilities ${coverage.shared.join(', ')}; capabilities of another lane are not inherited.` : '');
  // The model part is budgeted first, under the byte floor of the OutSystems UI section when there is one (osuiFloor),
  // and never changes for the section itself (fitOutsystemsUi).
  const osui = outsystemsUi ? await outsystemsUiRequest({ lane, intent, matches: q.matches, context, app, map }) : null;
  // The C07 sections take the room the model part and the OutSystems UI section left (fitC07); the grammar of the steps
  // the intent names keeps a floor in that room (fitWithSteps).
  const fitModel = room => {
    const copy = structuredClone(answer);
    const budgeted = osui ? budgetWithFloor(copy, room, osui) : applyBudget(copy, room);
    return osui ? fitOutsystemsUi(budgeted, osui, room) : budgeted;
  };
  return fitWithSteps(fitModel, { provenExample: proven, steps, values }, budgetBytes);
}

// The grammar of the logic steps an intent names (kinds, grammar and the proven job by reference) is what that intent
// asked: it never goes for model detail the budget can cut. When the model part fills the budget and fitC07 has no room
// left for that form, the model part is budgeted again under a floor of that size, as the OutSystems UI section has one
// (budgetWithFloor), and the answer says so in size.reserved.steps. A floor above a quarter of the budget, or a model part that would then be
// insufficient, keeps the first answer (package 3 integration: with executed results the matches of an aggregate-and-if
// intent grew past the room and the steps were dropped, pacote-laneE-discover C07).
// The floor is the richest steps form that fits it: the whole form first (the grammar and the action of the proven job
// that uses the steps, capped at STEPS_EXAMPLE_CAP), then the example by reference (fitC07's second form). The battery of
// the package (2026-10-08): once the full suites stamped the proofs proven-current, the o11 matches grew and the floor of
// the reference form kept only the job id, so the answer lost the action to copy.
export function fitWithSteps(fitModel, extras, budgetBytes) {
  const first = fitC07(fitModel(budgetBytes), extras, budgetBytes);
  const s = extras?.steps;
  if (!s || first?.ok === false || !first?.size) return first;
  const opsOf = x => (Array.isArray(x?.ops) ? x.ops.length : 0);
  const whole = out => !!out?.steps && (!s.example || (!!out.steps.example && opsOf(out.steps.example) >= opsOf(s.example)));
  const partial = out => !!out?.steps && (!s.example || !!out.steps.example);
  if (whole(first)) return first;
  const example = s.example ? { job: s.example.job, path: s.example.path, reference: s.example.reference, note: 'reduced by budget: the whole job by its id' } : null;
  const forms = [[s, whole], ...(example ? [[{ ...s, example }, partial]] : [])];
  for (const [form, enough] of forms) {
    if (enough === partial && partial(first)) return first; // the reference form is already in the first answer
    const floor = bytes({ steps: form }) + 128;
    if (floor > budgetBytes / 4) continue;
    const model = fitModel(budgetBytes - floor);
    if (!model?.size || model.size.status === 'insufficient') continue;
    model.size = { ...model.size, budgetBytes, reserved: { ...(model.size.reserved ?? {}), steps: floor } };
    const second = fitC07(model, extras, budgetBytes);
    if (enough(second)) return second;
  }
  return first;
}
// The ops of the first proof job that belong to the capability, with what an author needs to know before copying
// them: which base the job assumes, which aliases it uses without defining inside the excerpt, and that a filtered or
// cut excerpt is a fragment, not a runnable job.
function exampleOps(sources, index, c, { maxOps = null, focus = null } = {}) {
  const proofs = c.proofs?.[index.lane] ?? []; if (!proofs.length) return null;
  const scoped = focus?.roles?.length && focus.ops?.length ? scopedExample(sources, index, c, focus, maxOps ?? 8) : null;
  if (scoped) return scoped;
  const wanted = c.example?.ops ?? null; const max = maxOps ?? c.example?.max ?? 24;
  // The first proof job (descriptor order = intent order) in which the wanted verbs are a real share of the ops; when
  // none reaches the share, the job with the most such ops. A capability proven by several jobs may list first a job
  // that exercises it mostly through another verb (logic-steps, a compact `logic` job, before aggregate-full).
  const counted = proofs.map(candidate => { const j = index.jobs.find(x => x.name === candidate); const count = !j ? -1 : !wanted ? j.opCount : wanted.reduce((n, verb) => n + (j.ops?.[verb] ?? 0), 0); return { candidate, count, share: j?.opCount ? count / j.opCount : 0 }; });
  const best = counted.find(c => c.count > 0 && c.share >= 0.3) ?? counted.reduce((a, b) => (b.count > a.count ? b : a), counted[0]);
  const name = best.candidate;
  const file = path.join(sources.jobsDir, name + '.json'); if (!exists(file)) return null;
  let job; try { job = readJob(file, sources); } catch { return null; }
  const all = job.ops ?? [];
  const selected = all.filter(op => !wanted || wanted.includes(op.op)).slice(0, max).map(op => { const { _why, ...rest } = op; return rest; });
  const defined = new Set(); const used = new Set();
  const scan = value => { if (typeof value === 'string') { for (const m of value.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*/g)) used.add(m[0]); } else if (Array.isArray(value)) value.forEach(scan); else if (value && typeof value === 'object') Object.values(value).forEach(scan); };
  for (const op of selected) { if (typeof op.as === 'string') defined.add(op.as); scan(op); }
  const undefinedAliases = [...used].filter(a => !defined.has(a)).sort();
  const fragment = selected.length < all.length;
  return { job: name, path: path.relative(sources.kernel, file).replaceAll('\\', '/'), base: job.base, expectedMessages: job.expectedMessages ?? [],
    fragment, opsShown: selected.length, opsTotal: all.length, undefinedAliases,
    note: fragment ? 'FRAGMENT: ops filtered or cut from the job; aliases listed in undefinedAliases are defined by ops not shown (or by a spec op that registers $Entity aliases); apply the base first' : 'the whole job; its base must be applied first',
    ops: selected };
}
// The example for the focused (operation, role) pairs of a shared capability: the ops of ONE proof job that the
// executed result attributes to the native types of the focused roles (the verbs of the focused operations on each
// role, plus the reads around them), so the excerpt shows only what was proven for those roles. The job is the one
// that covers the most focused pairs (ties: descriptor order); every role the intent named counts (containers
// included: a refactor of an attribute AND an index shows the ops of both — phase-3 evaluation, B sessions). A pair
// with no proof for its role, or a proof without an executed result, contributes nothing; no covered pair yields no
// scoped example (the default one is used, and says so).
function scopedExample(sources, index, c, focus, max) {
  const pairs = [];
  for (const op of focus.ops) for (const role of focus.allRoles ?? focus.roles) { const r = c.operations?.[op]?.roles?.[role]; if (r?.proofs?.length && r.native) pairs.push({ op, role, r }); }
  if (!pairs.length) return null;
  const verbsOf = (op, role) => c.operations[op].roles[role].verbs ?? OP_VERBS[op] ?? [];
  let best = null;
  for (const name of [...new Set(pairs.flatMap(p => p.r.proofs))]) {
    const job = index.jobs.find(j => j.name === name); const runs = job?.executed?.executions; if (!runs) continue;
    const covered = pairs.filter(p => p.r.proofs.includes(name) && runs.some(x => x.iface === p.r.native && verbsOf(p.op, p.role).includes(x.verb)));
    if (covered.length && (!best || covered.length > best.covered.length)) best = { name, job, runs, covered };
  }
  if (!best) return null;
  const { name, job, runs, covered } = best;
  const verbsByNative = new Map();
  for (const p of covered) { const s = verbsByNative.get(p.r.native) ?? new Set(); for (const v of verbsOf(p.op, p.role)) s.add(v); verbsByNative.set(p.r.native, s); }
  // One entry per op (a spec is attributed to several types of the same job).
  const own = []; const seenOps = new Set();
  for (const x of runs) if (verbsByNative.has(x.iface) && (verbsByNative.get(x.iface).has(x.verb) || ['usages', 'get', 'dump'].includes(x.verb)) && !seenOps.has(x.i)) { seenOps.add(x.i); own.push(x); }
  const file = path.join(sources.jobsDir, name + '.json'); if (!exists(file)) return null;
  let raw; try { raw = readJob(file, sources); } catch { return null; }
  const all = raw.ops ?? [];
  // The ops of the focused verbs are the substance; the reads on the same types are context. A cut (here by `max`,
  // later by the budget) keeps the substance first — the first op of each focused verb before a second of any — and
  // the job order always (aliases are defined before use).
  const focused = own.filter(x => verbsByNative.get(x.iface).has(x.verb));
  const focusedIndexes = new Set(focused.map(x => x.i));
  const firstOfVerb = new Map(); for (const x of focused) if (!firstOfVerb.has(x.verb)) firstOfVerb.set(x.verb, x.i);
  const kept = keepFocusedFirst(own.map(x => x.i), focusedIndexes, max, new Set(firstOfVerb.values()));
  const selected = kept.map(i => { const { _why, ...rest } = all[i]; return rest; });
  const focusedOps = kept.map((i, k) => (focusedIndexes.has(i) ? k : -1)).filter(k => k >= 0);
  const defined = new Set(); const used = new Set();
  const scan = value => { if (typeof value === 'string') { for (const m of value.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*/g)) used.add(m[0]); } else if (Array.isArray(value)) value.forEach(scan); else if (value && typeof value === 'object') Object.values(value).forEach(scan); };
  for (const o of selected) { if (typeof o.as === 'string') defined.add(o.as); scan(o); }
  const roles = [...new Set(covered.map(p => p.role))]; const ops = [...new Set(covered.map(p => p.op))];
  const key = p => (roles.length > 1 ? `${p.op}/${p.role}` : p.op);
  const proves = Object.fromEntries(covered.map(p => [key(p), p.r.scope ?? null]));
  const observed = Object.fromEntries(covered.filter(p => p.r.observed).map(p => [key(p), p.r.observed.caution ?? 'integrity not verified']));
  return { job: name, path: path.relative(sources.kernel, file).replaceAll('\\', '/'), base: raw.base, expectedMessages: raw.expectedMessages ?? [],
    scope: { role: roles[0], op: ops[0], roles, ops, native: covered[0].r.native, natives: [...verbsByNative.keys()], level: jobLevel(job), attribution: 'ops whose executed result names one of the focused role types (verbs of the focused operations on that role plus usages/get/dump on the same types)', proves, ...(Object.keys(observed).length ? { observed } : {}) },
    fragment: true, opsShown: selected.length, opsTotal: all.length, undefinedAliases: [...used].filter(a => !defined.has(a)).sort(), focusedOps,
    note: 'FRAGMENT scoped to the focused roles: ops on other types of the same job are not shown and are not evidence for these roles; aliases listed in undefinedAliases are defined by ops not shown; apply the base first', ops: selected };
}
// Up to `max` op indexes: the `first` ones (one op per focused verb), then every other focused one, then the others,
// each group in job order; returned in job order.
function keepFocusedFirst(indexes, focused, max, first = new Set()) {
  const ordered = [...indexes.filter(i => first.has(i)), ...indexes.filter(i => focused.has(i) && !first.has(i)), ...indexes.filter(i => !focused.has(i))];
  return ordered.slice(0, max ?? ordered.length).sort((a, b) => a - b);
}
// Native metadata (A) for one type from the reflection index of the lane: declared members plus the bases.
export function nativeType(sources, index, name) {
  const dir = sources.modelApiDir; if (!exists(dir)) return { available: false };
  const wanted = name.replace(/^I?/, 'I');
  if (index.lane === 'odc') {
    for (const file of fs.readdirSync(dir).filter(f => /^OutSystems\..*\.json$/.test(f))) {
      let list; try { list = readJson(path.join(dir, file)); } catch { continue; }
      const hit = list.find(t => t.name === wanted || t.name === name);
      if (hit) {
        const bases = []; const seen = new Set();
        const resolveBase = b => { if (seen.has(b)) return; seen.add(b); const base = list.find(t => t.name === b); if (base) { bases.push({ name: base.name, members: base.members.filter(m => m.kind === 'property').map(m => m.signature) }); for (const bb of base.bases ?? []) resolveBase(bb); } };
        for (const b of hit.bases ?? []) resolveBase(b);
        return { available: true, provenance: 'A', source: file, studio: index.identity.modelApi?.version ?? null, installedStudio: index.identity.studio?.ideVersion ?? null, type: hit.name, namespace: hit.namespace, kind: hit.kind, bases: hit.bases, members: hit.members, inherited: bases, note: 'Declared members by reflection over an installed Studio; whether the kernel sets them is a B question (verbs/set) and whether it was proven is C (jobs).' };
      }
    }
    return { available: true, provenance: 'A', notFound: name, hint: 'use the interface name, e.g. IDropdown, IServerEntity' };
  }
  const catalog = fs.readdirSync(dir).filter(f => /^model-api-.*\.json$/.test(f)).sort().at(-1); if (!catalog) return { available: false };
  const doc = readJson(path.join(dir, catalog));
  const hit = (doc.Interfaces ?? []).find(i => i.Name === wanted || i.Name.split('.').at(-1) === wanted || i.Name.split('.').at(-1) === name);
  if (!hit) return { available: true, provenance: 'A', notFound: name };
  return { available: true, provenance: 'A', source: catalog, type: hit.Name, bases: hit.Bases, properties: hit.Properties?.map(p => (p.CanWrite ? '*' : '') + p.Name + ': ' + p.Type.split('.').at(-1)), creates: (doc.Creatables ?? []).filter(c => c.Parent === hit.Name).map(c => c.Type.split('.').at(-1)) };
}

// ---- CLI argument parsing shared by odc.mjs / ssam.mjs
export function parseDiscoverArguments(args) {
  const input = { lane: 'odc', intent: '', app: null, detail: null, expand: null, type: null, limit: 8, rebuild: false, budgetBytes: DEFAULT_BUDGET_BYTES };
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--lane') input.lane = args[++i];
    else if (a === '--app') input.app = args[++i];
    else if (a === '--detail') input.detail = args[++i];
    else if (a === '--expand') input.expand = args[++i];
    else if (a === '--type') input.type = args[++i];
    else if (a === '--limit') input.limit = Number(args[++i]);
    else if (a === '--budget') input.budgetBytes = Number(args[++i]);
    else if (a === '--rebuild') input.rebuild = true;
    else if (a === '--packet') input.packet = true;
    else if (a === '--intent') input.intent = args[++i];
    else if (a.startsWith('--')) throw new Error('Unknown discover option ' + a + '; usage: discover <intent words...> [--lane odc|o11] [--app <capture.oml|Module>] [--packet] [--expand <id>:<parts>,contract:<pointer>,element:<Kind:Name>] [--detail <capability>] [--type <Interface>] [--limit N] [--budget <bytes>] [--rebuild]');
    else words.push(a);
  }
  if (input.expand != null && !String(input.expand).trim()) throw new Error('--expand needs a value, e.g. ui.list:example+evidence,logic.aggregate:example');
  if (!input.intent) input.intent = words.join(' ');
  if (!['odc', 'o11'].includes(input.lane)) throw new Error('Unknown lane ' + input.lane + '; lanes: odc, o11');
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 30) throw new Error('--limit must be an integer between 1 and 30');
  if (!Number.isInteger(input.budgetBytes) || input.budgetBytes < 4096 || input.budgetBytes > 1048576) throw new Error('--budget must be an integer number of bytes between 4096 and 1048576');
  return input;
}
