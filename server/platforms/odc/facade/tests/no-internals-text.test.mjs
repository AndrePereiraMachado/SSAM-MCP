import './fixtures/isolated-profile.mjs';
// Round 7b of fix/no-internals (review C:\t\revisoes\no-internals-7\REVISAO.md): a CLI form leaves SSAM's prose without taking
// any information of use with it, and without breaking a sentence.
// - MEDIUM 2: the seven texts of the review's table (a recipe row, three parts of the ssam_debug definition, the producers
//   argument of o11_job and ssam_job, the ODC standards, a job's _why note), each as SSAM serves it today;
// - B2: the rule never reaches the customer's content: a flag is one of SSAM's own command lines (cli-flags.mjs, the closed list
//   of the flags their sources accept), never a word inside double quotes, and a proof level reads the seal only in SSAM's
//   documentation; a Portal payload (body) is the customer's;
// - B3: a loose flag of the kernel in its own messages reads as the option the tools name (camelCase), so the sentence stays
//   whole and an error never vanishes; a flag with a value is a command line and goes;
// - B4: a pointer to SSAM's own reference (api --op, api --name, --find, --app, a producer binding) reads as the MCP form that
//   serves it, never left out;
// - B5: a suite job path becomes its example id only when ssam_reference serves that folder (tests/jobs, tests/jobs-odc and their
//   examples); a job of another folder of the suite (live, negative, coverage) reads as an example of SSAM, never as an id
//   that answers EXAMPLE_NOT_FOUND;
// - B6: the caller's own text, quoted in SSAM's prose (the id a refusal echoes), comes back as the caller sent it; a path on the
//   machine stays the server's (round 6), and a text the caller did not send is read by the rule as before;
// - the anvil family (the owner, 18/10): the code of an example SSAM serves (its ops, never touched by the rule) names no
//   internal name of SSAM: the metadata of a job is managed by "ssam", a CSS class and the names a job creates are neutral.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exposedResult, exposedToolDefinition } from '../exposure.mjs';
import { findings } from './fixtures/internal-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const cliBuilt = fs.existsSync(path.join(kernel, '.local', 'cli', 'anvil.dll')) && fs.existsSync(path.join(kernel, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'));
const skip = !cliBuilt && 'the lane CLIs are not built in this checkout';
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const licensee = (tool, value, args = {}) => exposedResult(result(value), { exposure: 'licensee', handleRoots: [], tool, args }).structuredContent;
const shown = list => list.map(f => f.family + ' ' + f.at + ' ' + f.sample.replace(/\s+/g, ' ').slice(0, 120));
// A CLI flag of SSAM left in a text (a CSS custom property is no flag).
const flagsIn = text => [...String(text).matchAll(/(?<![\w-]|var\()--[a-z][a-z0-9-]*(?![\w-]*\s*:)/g)].map(m => m[0]);
// Parentheses that do not pair, in order.
const balanced = text => { let depth = 0; for (const c of String(text)) { if (c === '(') depth++; if (c === ')' && --depth < 0) return false; } return depth === 0; };

// ---- the texts as SSAM serves them (owner), from kernel/AGENTS.md:638, debug.mjs:146-152, ssam.mjs:359, RULES.md:8-9 and
// tests/jobs/entity-lifecycle.json:27
const RECIPE_ROW = '| Reference to another module | Use a public entity, action or block of another module: `{"op":"reference","producer":"job:producer-public" ou "Headless_CS","elements":["IServerEntity:Product","IServerAction:Product_GetById"]}`; `job:` looks in the job\'s folder and in tests/jobs; named snapshot bound by `--producer Headless_CS=<oml>`; direct paths only for fixtures; the structures that the elements use come along. Producer without a local OML (.NET extension, eSpace or (System)): o11_job {job:"<job.json>", captureProducers:["<Nome>"]} captures the server signature read-only through the logged-in Studio (VersionId guard, type closure) and the job binds `--producer <Nome>=<.avsig>` (`System=<.avsig>` for the (System)), with the `.avsig` refs as the first ops; `elements: []` refreshes an existing reference; in deliver, `--capture-producer Nome[=Produtor]` captures into the task folder (once per producer; the resume captures only the missing ones) and re-attests before the apply and the merge (`docs/proofs/2026-09-26-o11-manage-dependencies.md`) | All | `consume-reference.json`, `consume-reference-screens.json` (screen with Table and detail); live `tests/jobs-live/consume-headless-cs.json` | `find` of the element; TrueChange without `OutdatedReference` |';
const DEBUG = 'Developer/debugger authentication is separate: O11 native SSO uses optional o11Auth metadata {applicationKey, publishedVersionId, publishedProof:{path,sha256}} and a fresh published inventory (at most 15 minutes old) for the exact runtime host/module/application/version; CLI --o11-auth reads that metadata from a JSON file. When a linked producer executes in its consumer, o11Auth.entry declares that consumer module. '
  + 'The nodes must exactly match nodeKeys (maximum 20). CLI --model-scope reads this object from JSON. Reads and verifies the exact capture bytes before any debugger authentication or session lock. '
  + 'read-frame (threadId/eventId of the observed stop; offset = root offset, maxNodes default 2000, cap 20000; CLI --max-nodes) reads every Scope() root of the frame in one native EvaluateMany; implemented, live proof pending. '
  + 'nodeModuleKeys (start/watch; CLI --node-module-keys JSON) declares the owner module of each breakpoint node (native ExtendedBreakpointId): the keys must equal nodeKeys.';
const PRODUCERS = 'Producer bindings {Name: absolute path of a frozen producer .oml or .avsig}, as --producer Name=path.';
const STANDARDS = 'Today every detection reads O11 jobs and OML. In a run with `--platform odc`, the job, truechange and oml stages do not\nrun, and every rule that applies to ODC comes out as "not checked on ODC yet"; AR1 comes out as "does not apply to ODC".\nThe runtime stage does not depend on the platform.';
const WHY = "(2) in O11 too the FK is born with its AutoIndex_ContactId beside the author's index (measured on 2026-09-23; it counts as a consumer of the FK when deleting)";

test('a recipe row keeps the tool form of a producer without a local OML and its parentheses pair (MEDIUM 2, row 1)', () => {
  const out = licensee('ssam_reference', { ok: true, kind: 'recipe', lane: 'o11', preview: { first: [{ rows: [RECIPE_ROW] }] } }, { kind: 'recipe' }).preview.first[0].rows[0];
  assert.match(out, /Producer without a local OML \(\.NET extension, eSpace or \(System\)\): o11_job \{job:"<job\.json>", captureProducers:\["<Nome>"\]\} captures the server signature read-only through the logged-in Studio \(VersionId guard, type closure\)/);
  assert.match(out, /`elements: \[\]` refreshes an existing reference/);
  assert.ok(balanced(out), 'every parenthesis pairs: ' + out);
  assert.doesNotMatch(out, /(?<!\(once per producer; )the resume captures only the missing ones\)/, 'a clause is never cut inside a parenthetical');
  assert.deepEqual(flagsIn(out), []);
  assert.match(out, /\| All \| `consume-reference\.json`/, 'the next cells of the row stay');
  assert.deepEqual(shown(findings({ out })), []);
});

test('the ssam_debug definition keeps what its arguments are, and no sentence is broken (MEDIUM 2, rows 2 to 4)', () => {
  const out = exposedToolDefinition({ name: 'ssam_debug', description: DEBUG }).description;
  assert.match(out, /read-frame \(threadId\/eventId of the observed stop; offset = root offset, maxNodes default 2000, cap 20000\) reads every Scope\(\) root/);
  assert.match(out, /nodeModuleKeys \(start\/watch\) declares the owner module/);
  assert.match(out, /for the exact runtime host\/module\/application\/version\. When a linked producer executes/, 'the CLI sentence goes whole; the sentence before it ends');
  assert.match(out, /The nodes must exactly match nodeKeys \(maximum 20\)\. Reads and verifies the exact capture bytes/);
  assert.doesNotMatch(out, /\bCLI (?:this|that)\b|\bCLI\b/);
  assert.deepEqual(flagsIn(out), []);
  assert.ok(balanced(out));
});

test('the producers argument of o11_job and ssam_job reads as a whole sentence (MEDIUM 2, row 5)', () => {
  const out = exposedToolDefinition({ name: 'o11_job', inputSchema: { type: 'object', properties: { producers: { type: 'object', description: PRODUCERS } } } }).inputSchema.properties.producers.description;
  assert.match(out, /^Producer bindings \{Name: absolute path of a frozen producer \.oml or \.avsig\}/);
  assert.doesNotMatch(out, /as=path|\bas\s*\.$/);
  assert.deepEqual(flagsIn(out), []);
});

test('the ODC standards keep that on ODC the job stages do not run and the rules are not checked yet (MEDIUM 2, row 6)', () => {
  const out = licensee('ssam_reference', { ok: true, kind: 'rules', lane: 'odc', text: STANDARDS }, { kind: 'rules' }).text;
  assert.match(out, /^Today every detection reads O11 jobs and OML\. In a run on ODC, the job, truechange and oml stages do not\nrun, and every rule that applies to ODC comes out as "not checked on ODC yet"; AR1 comes out as "does not apply to ODC"\./);
  assert.deepEqual(flagsIn(out), []);
});

test('a job\'s _why note loses only the part of its parenthetical with a date (MEDIUM 2, row 7)', () => {
  const out = licensee('ssam_reference', { ok: true, kind: 'example', lane: 'o11', data: { ops: [{ op: 'dump', target: '$ContactNote', _why: WHY }] } }, { kind: 'example' }).data.ops[0]._why;
  assert.equal(out, "(2) in O11 too the FK is born with its AutoIndex_ContactId beside the author's index (it counts as a consumer of the FK when deleting)");
  assert.deepEqual(shown(findings({ out })), []);
});

// ---- live: the same texts as a licensee is served them
async function session() {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const server = await createSsamServer({ profile: 'all', deps: { exposure: { profile: 'licensee', caller: () => 'text-' + process.pid + '-' + Date.now(), dayBytes: 500 * 1024 * 1024 } } });
  const client = new Client({ name: 'no-internals-text', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args) => {
    let r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
    let body = r.structuredContent ?? JSON.parse(r.content[0].text);
    for (let i = 0; i < 120 && body?.state === 'running' && body.continuation; i++) { await new Promise(z => setTimeout(z, 250)); r = await client.callTool({ name: body.continuation.tool, arguments: body.continuation.arguments }, undefined, { timeout: 600000 }); body = r.structuredContent ?? JSON.parse(r.content[0].text); }
    return body;
  };
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}
const strings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out); return out; };
test('live: the texts of the review\'s table, as a licensee is served them, keep their use (MEDIUM 2)', { skip, timeout: 900000 }, async () => {
  const s = await session();
  try {
    const recipe = strings(await s.call('ssam_reference', { lane: 'o11', kind: 'recipe', query: { find: 'entity' } })).find(t => t.startsWith('| Reference to another module'));
    assert.ok(recipe, 'the recipe row is served');
    assert.match(recipe, /o11_job \{job:"<job\.json>", captureProducers:\["<Nome>"\]\} captures the server signature/);
    assert.ok(balanced(recipe), recipe);
    const listing = (await s.client.listTools()).tools.find(t => t.name === 'ssam_debug').description;
    const definition = (await s.call('ssam_reference', { lane: 'o11', kind: 'tool', query: 'ssam_debug' })).definition.description;
    for (const text of [listing, definition]) {
      assert.match(text, /read-frame \(threadId\/eventId of the observed stop; offset = root offset, maxNodes default 2000, cap 20000\)/);
      assert.match(text, /nodeModuleKeys \(start\/watch\) declares/);
      assert.doesNotMatch(text, /\bCLI (?:this|that) /);
    }
    for (const tool of ['o11_job', 'ssam_job']) {
      const producers = (await s.call('ssam_reference', { lane: 'o11', kind: 'tool', query: tool })).definition.inputSchema.properties.producers.description;
      assert.doesNotMatch(producers, /as=path/, tool);
    }
    const standards = (await s.call('ssam_reference', { lane: 'odc', kind: 'rules', query: 'standards' })).text;
    assert.match(standards, /In a run on ODC, the job, truechange and oml stages do not\s+run, and every rule that applies to ODC comes out as "not checked on ODC yet"/);
    const example = await s.call('ssam_reference', { lane: 'o11', kind: 'example', query: { id: 'jobs/entity-lifecycle' } });
    assert.ok(strings(example).some(t => t.includes('(it counts as a consumer of the FK when deleting)')), 'the _why keeps its use');
  } finally { await s.close(); }
});

// ---- B2
test('the rule never reaches the customer\'s content: CSS names, an expression, a label, a Portal payload (B2)', () => {
  // StyleSheetRules.cs:186-188, the customer's CSS custom properties named in SSAM's message
  const css = licensee('ssam_job', { ok: false, code: 'PREFLIGHT_REFUSED', problems: [{ code: 'CSS_RULES_DROPPED', message: 'the corrected CSS at /ops/2/data/css has 10 rules, the job it corrects had 12: 2 rule(s) dropped (.card, .hero); 2 custom properties lost their definition (--card, --brand-navy)' }] });
  assert.match(css.problems[0].message, /lost their definition \(--card, --brand-navy\)$/);
  // a customer's expression echoed in an error
  const expression = licensee('ssam_job', { ok: false, error: 'op #3 (logic): the expression Concat("--force", Name) of the assign does not parse' });
  assert.equal(expression.error, 'op #3 (logic): the expression Concat("--force", Name) of the assign does not parse');
  // a business label of the customer that reads like a proof level, in a runtime answer
  const map = licensee('ssam_map', { ok: true, matches: [{ kind: 'StaticRecord', name: 'CSuite', label: 'C-suite' }, { kind: 'Attribute', name: 'Level', description: 'C-suite' }] });
  assert.deepEqual(map.matches.map(m => m.label ?? m.description), ['C-suite', 'C-suite']);
  // a Portal payload of the customer (its own error message, its own paths and flags)
  const portal = { ok: true, body: { status: 'Failed', errorMessage: 'Build failed: see C:\\agent\\work\\b.log; run with --verbose' } };
  assert.deepEqual(licensee('odc_portal_read', portal), portal);
  // SSAM's documentation: a CSS custom property named bare, and a flag-like word of an example's code
  const rules = licensee('ssam_reference', { ok: true, kind: 'rules', text: 'Set --color-primary in the theme, not in a screen; the theme reads var(--color-primary).' }, { kind: 'rules' });
  assert.equal(rules.text, 'Set --color-primary in the theme, not in a screen; the theme reads var(--color-primary).');
  const example = licensee('ssam_reference', { ok: true, kind: 'example', data: { ops: [{ op: 'create', type: 'ServerAction', name: 'Run', description: 'Runs the import with --dry-run first' }] } }, { kind: 'example' });
  assert.equal(example.data.ops[0].description, 'Runs the import with --dry-run first');
  // ... while SSAM's own flags and proof levels still leave SSAM's text
  const own = licensee('ssam_discover', { ok: true, schemaVersion: 'ssam-discovery/1', bindings: [{ rule: 'set Action', level: 'C-suite' }], matches: [{ id: 'x', guidance: 'Bind it with ssam_job; or bind a snapshot on the command: --base <oml> / --producer <Name>=<oml>.' }] });
  assert.equal(own.bindings[0].level, 'proven');
  assert.deepEqual(flagsIn(JSON.stringify(own)), []);
});

test('the closed list of SSAM\'s CLI flags is the one its sources accept (B2)', async t => {
  const { CLI_FLAGS } = await import('../cli-flags.mjs');
  const { scanCliFlags } = await import('../../scripts/cli-flags.mjs');
  const root = path.resolve(here, '..', '..', '..', '..');
  if (!fs.existsSync(path.join(root, 'kernel', 'src'))) { t.skip('the kernel sources are not in this checkout'); return; }
  assert.deepEqual([...CLI_FLAGS].sort(), scanCliFlags(root), 'regenerate it: node platforms/odc/scripts/cli-flags.mjs --write');
  for (const flag of ['expected-environment', 'producer', 'capture-producer', 'base', 'platform', 'authorize', 'max-nodes']) assert.ok(CLI_FLAGS.has(flag), flag);
  // (--force is one of SSAM's flags: a customer's "--force" is held by the quotes around it, the test above)
  for (const word of ['card', 'brand-navy', 'color-primary', 'dry-run']) assert.equal(CLI_FLAGS.has(word), false, word);
});
// ---- B3: the kernel's own messages (DeliverArguments.cs:42, AccessPlanner.cs:102, AccessCommand.cs:36)
test('a loose flag in the kernel\'s messages reads as the option the tools name; no sentence breaks, no error vanishes (B3)', () => {
  const deliver = licensee('o11_deliver', { ok: false, error: 'this task was registered for environment personal-xxxx.outsystemscloud.com; resume or close it without another --expected-environment' });
  assert.equal(deliver.error, 'this task was registered for environment personal-xxxx.outsystemscloud.com; resume or close it without another expectedEnvironment');
  const access = licensee('o11_access', { ok: false, errors: ['ops/0: createIfMissing requires the explicit opt-in --create-accounts of plan (off by default)', '--create-active requires --create-accounts'] });
  assert.deepEqual(access.errors, ['ops/0: createIfMissing requires the explicit opt-in createAccounts of plan (off by default)', 'createActive requires createAccounts']);
  // a flag with a value is a command line: it goes with its value, the sentence ends where it did
  const doc = licensee('ssam_reference', { ok: true, kind: 'recipe', description: 'Over the fixture, with stand-ins for the producer actions; generated by C:\\srv\\x\\gen.mjs --target fixture.' }, { kind: 'recipe' });
  assert.equal(doc.description, 'Over the fixture, with stand-ins for the producer actions; generated by <server>.');
  for (const text of [deliver.error, ...access.errors]) assert.deepEqual(flagsIn(text), []);
});
// ---- B4: the kernel's pointers to its own reference (JobPreflight.cs:582-589, HtmlVisual.cs:112, Anvil.Cli Program.cs:974)
test('a pointer to SSAM\'s own reference reads as the MCP form that serves it (B4)', () => {
  const api = (op, rest = '') => `ssam_reference {kind:"api", query:{op:"${op}"${rest}}}`;
  const job = licensee('ssam_job', { ok: false, code: 'PREFLIGHT_REFUSED', problems: [
    { op: 0, message: "unknown op 'creat'", fix: 'write the op as `api --op verbs` describes it' },
    { fix: 'write the step in the logic grammar (`api --op logic`): one step kind per step, closed keys' },
    { fix: 'write the data in the spec grammar (`api --op spec`)' },
    { fix: 'fix the value as the message says (`api --name <Type>` lists properties and enums)' },
    { fix: 'fix the element at the line and column the message names; the rules of the page form (kinds and their tags, attributes, names, call) are `api --op html`' },
    { fix: 'see anvil api --name Product' }] });
  assert.deepEqual(job.problems.map(p => p.fix), [
    'write the op as `' + api('verbs') + '` describes it',
    'write the step in the logic grammar (`' + api('logic') + '`): one step kind per step, closed keys',
    'write the data in the spec grammar (`' + api('spec') + '`)',
    'fix the value as the message says (`ssam_reference {kind:"api", query:"<Type>"}` lists properties and enums)',
    'fix the element at the line and column the message names; the rules of the page form (kinds and their tags, attributes, names, call) are `' + api('html') + '`',
    'see ssam_reference {kind:"api", query:"Product"}']);
  const rule = licensee('ssam_reference', { ok: true, kind: 'api', rule: 'Tag = the tag, class -> extended property; any tag of the platform\'s HTML Element (api --op html, platformTags), tables too; br: an empty Container' }, { kind: 'recipe' });
  assert.equal(rule.rule, 'Tag = the tag, class -> extended property; any tag of the platform\'s HTML Element (' + api('html') + ', platformTags), tables too; br: an empty Container');
  const block = licensee('ssam_reference', { ok: false, error: "ArgumentException: block 'Button' not in OutSystemsUI 2.28.1; try --find" }, { kind: 'ui-block' });
  assert.equal(block.error, "block 'Button' not in OutSystemsUI 2.28.1; try query:{find:\"<words>\"}", 'review vps-a9 E2: the type of an exception of SSAM leaves the prose, the message stays');
  const limits = licensee('ssam_discover', { ok: true, schemaVersion: 'ssam-discovery/1', matches: [{ id: 'x', limits: [{ text: 'The contract is the signature in the capture (context.signatures with --app, or studio_inspect {target:"<capture>"}).' }],
    guidance: 'Read the existing blocks of the module before creating new ones (an --app capture lists them).' }] });
  assert.equal(limits.matches[0].limits[0].text, 'The contract is the signature in the capture (context.signatures with app, or studio_inspect {target:"<capture>"}).');
  assert.equal(limits.matches[0].guidance, 'Read the existing blocks of the module before creating new ones (an app capture lists them).');
  // a producer binding of a job and of a delivery (the recipe row of MEDIUM 2)
  const row = licensee('ssam_reference', { ok: true, kind: 'recipe', lane: 'o11', preview: { first: [{ rows: [RECIPE_ROW] }] } }, { kind: 'recipe' }).preview.first[0].rows[0];
  assert.match(row, /named snapshot bound by `producers:\{"Headless_CS":"<oml>"\}`/);
  assert.match(row, /and the job binds `producers:\{"<Nome>":"<\.avsig>"\}`/);
  assert.match(row, /in deliver, `captureProducers:\["Nome"\]` captures into the task folder \(once per producer; the resume captures only the missing ones\) and re-attests before the apply and the merge/);
  assert.ok(balanced(row));
  // the operation of a capability (an operation's text keeps no flag, and its pointer reads as the call)
  const capability = licensee('ssam_discover', { ok: true, schemaVersion: 'ssam-packet/1', capabilities: { items: [{ id: 'ui.html-visual', operation: '{"op":"html","parent":"<widget ref>","file":"fragment.html"}  (api --op html-visual)' }] } });
  assert.equal(capability.capabilities.items[0].operation, '{"op":"html","parent":"<widget ref>","file":"fragment.html"}  (' + api('html-visual') + ')');
  for (const value of [job, rule, block, limits, row, capability]) assert.deepEqual(flagsIn(JSON.stringify(value)), []);
});
// ---- B5
test('a suite path becomes an example id only when ssam_reference serves its folder (B5)', () => {
  const doc = licensee('ssam_discover', { ok: true, schemaVersion: 'ssam-discovery/1', matches: [
    { id: 'a', guidance: 'Proven in tests/jobs-odc/examples-live/odc-agents-example.json. Native model tests: kernel/tests/Anvil.Tests/X.cs.' },
    { id: 'b', guidance: 'Example: kernel/tests/jobs-live/consume-headless-cs.json and tests/jobs-coverage/html-dashboard-incidents.json.' },
    { id: 'c', guidance: 'The refusal with the consumer linked is in tests/jobs-odc-negative/delete-static-record-in-use.json.' },
    { id: 'd', guidance: 'Served: tests/jobs-odc/examples/ui-flow-comment.json and tests/jobs/block-events-delete-reactive.json.' }] });
  const text = doc.matches.map(m => m.guidance);
  assert.deepEqual(text, [
    'Proven in a live example of SSAM. Native model tests: <server>.',
    'Example: examples of SSAM.',
    'The refusal with the consumer linked is in an example of SSAM.',
    'Served: ui-flow-comment and block-events-delete-reactive.']);
  // the recipe row of MEDIUM 2 ("live `tests/jobs-live/consume-headless-cs.json`")
  const row = licensee('ssam_reference', { ok: true, kind: 'recipe', lane: 'o11', preview: { first: [{ rows: [RECIPE_ROW] }] } }, { kind: 'recipe' }).preview.first[0].rows[0];
  assert.match(row, /\(screen with Table and detail\); a live example of SSAM \|/);
  assert.doesNotMatch(row, /consume-headless-cs/);
  // the argument of a call form keeps the job's name
  const call = licensee('ssam_discover', { ok: true, schemaVersion: 'ssam-discovery/1', matches: [{ id: 'e', guidance: 'Runs with ssam_job {lane:"odc", job:"tests/jobs-odc-negative/delete-logic-in-use.json"}: it must give ok=False.' }] });
  assert.equal(call.matches[0].guidance, 'Runs with ssam_job {lane:"odc", job:"delete-logic-in-use"}: it must give ok=False.');
});
// ---- B6
const NOT_FOUND = id => ({ ok: false, code: 'EXAMPLE_NOT_FOUND', error: `no example '${id}' in tests/jobs, tests/jobs/examples or tests/html`,
  continuation: { tool: 'ssam_reference', arguments: { lane: 'o11', kind: 'example', query: { find: String(id).split('/').at(-1) } }, why: 'search the ids by text' } });
test('the caller\'s own text, quoted in SSAM\'s prose, comes back as the caller sent it (B6)', () => {
  // the id a refusal echoes, in SSAM's documentation and in its runtime prose
  const echo = licensee('ssam_reference', NOT_FOUND('tests/jobs/x'), { lane: 'o11', kind: 'example', query: { id: 'tests/jobs/x' } });
  assert.equal(echo.error, "no example 'tests/jobs/x' in the proven examples");
  assert.deepEqual(echo.continuation, NOT_FOUND('tests/jobs/x').continuation);
  const runtime = licensee('ssam_job', { ok: false, code: 'JOB_NOT_FOUND', error: 'no job "kernel/tests/jobs-live/mine.json" under the jobs folder' }, { job: 'kernel/tests/jobs-live/mine.json' });
  assert.equal(runtime.error, 'no job "kernel/tests/jobs-live/mine.json" under the jobs folder');
  // the same text, not sent by this caller: the rule reads it as before
  assert.equal(licensee('ssam_reference', NOT_FOUND('tests/jobs/x'), { lane: 'o11', kind: 'example', query: { id: 'x' } }).error, "no example 'x' in the proven examples");
  assert.equal(licensee('ssam_reference', NOT_FOUND('tests/jobs/x'), { lane: 'o11', kind: 'example', query: { id: 'tests/jobs/x' } }).error.includes('tests/jobs,'), false, 'only the echo is held');
  // a path on the machine the caller sent is still the server's (round 6), quoted or not
  const base = licensee('ssam_job', { ok: false, code: 'BASE_NOT_FOUND', error: "the base 'C:\\work\\sales.oml' does not exist" }, { job: { base: 'C:\\work\\sales.oml', ops: [] } });
  assert.doesNotMatch(base.error, /C:\\work/);
  // a word the caller sent is no shield for SSAM's own text around it
  const word = licensee('ssam_reference', { ok: false, code: 'X', error: "no rule 'see' (kernel/scripts/rules/RULES.md:8)" }, { kind: 'rules', query: 'see' });
  assert.equal(word.error, "no rule 'see'");
});
test('live: the id an EXAMPLE_NOT_FOUND refusal echoes is the one the licensee sent (B6)', { timeout: 900000 }, async () => {
  const s = await session();
  try {
    const refused = await s.call('ssam_reference', { lane: 'o11', kind: 'example', query: { id: 'tests/jobs/no-such-example' } });
    assert.equal(refused.code, 'EXAMPLE_NOT_FOUND');
    assert.match(refused.error, /^no example 'tests\/jobs\/no-such-example' in the proven examples/);
    assert.equal(refused.continuation.arguments.query.find, 'no-such-example');
  } finally { await s.close(); }
});
// ---- the anvil family
// Every string of the code of an example ssam_reference serves (tests/jobs, tests/jobs-odc and their examples, tests/html)
// that names the kernel; the prose keys are left out (the rule reads them).
const PROSE_KEYS = new Set(['_why', 'description', 'why', 'note', 'notes', 'title', 'summary', 'expectMessage', 'expectError', 'reason']);
function anvilInExampleCode() {
  const tests = path.join(kernel, 'tests'), hits = [];
  const walk = (value, at, file) => {
    if (typeof value === 'string') { if (/anvil/i.test(value)) hits.push(file + ' ' + at + ' = ' + value.slice(0, 80)); return; }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, at + '/' + i, file)); return; }
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) if (!PROSE_KEYS.has(k)) walk(v, at + '/' + k, file);
  };
  for (const dir of ['jobs', 'jobs/examples', 'jobs-odc', 'jobs-odc/examples']) {
    for (const f of fs.readdirSync(path.join(tests, dir)).filter(f => f.endsWith('.json'))) {
      let doc; try { doc = JSON.parse(fs.readFileSync(path.join(tests, dir, f), 'utf8')); } catch { continue; }
      walk(doc, '', dir + '/' + f);
    }
  }
  const files = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of files(path.join(tests, 'html'))) for (const m of fs.readFileSync(f, 'utf8').matchAll(/.{0,40}anvil.{0,40}/gi)) hits.push(path.relative(tests, f) + ' : ' + m[0]);
  return hits;
}
test('the code of every example SSAM serves names no internal name of SSAM (the anvil family)', () => {
  assert.deepEqual(anvilInExampleCode(), []);
  const metadata = [['jobs', 'cat-b-flow-comment-popover'], ['jobs-odc', 'email-popover-metadata']].map(([dir, name]) => JSON.parse(fs.readFileSync(path.join(kernel, 'tests', dir, name + '.json'), 'utf8')).ops.find(op => op.type === 'ITextMetadata'));
  assert.deepEqual(metadata.map(op => op.args.managedBy), ['ssam', 'ssam'], 'the metadata a job creates is managed by ssam');
});
test('live: the examples a licensee reads name no internal name of SSAM, in their code or their prose (the anvil family)', { timeout: 900000 }, async () => {
  const s = await session();
  try {
    for (const [lane, id] of [['o11', 'jobs/cat-b-flow-comment-popover'], ['o11', 'jobs/performance-lookup'], ['odc', 'jobs-odc/email-popover-metadata'], ['odc', 'jobs-odc/theme-css-halves']]) {
      const example = await s.call('ssam_reference', { lane, kind: 'example', query: { id } });
      assert.equal(example.ok, true, id + ': ' + JSON.stringify(example).slice(0, 300));
      assert.deepEqual(strings(example).filter(t => /anvil/i.test(t)), [], id);
    }
  } finally { await s.close(); }
});