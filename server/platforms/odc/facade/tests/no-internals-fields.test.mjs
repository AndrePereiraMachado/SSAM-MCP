import './fixtures/isolated-profile.mjs';
// Round 6 of fix/no-internals (re-review C:\t\revisoes\no-internals-5\REVISAO.md; D17 of the Integradora, 17/10: the family
// rule "nothing internal reaches a licensee by any field"):
// - LOW 3: a list of SSAM's prose (errors, warnings, messages, notes...) follows the rule its key follows as one string (a
//   JOB_INVALID check repeats its problems in errors[]); a state report loses its server paths in its lists too;
// - LOW 4: a suite path in SSAM's prose (tests/fixtures, the kernel's own folders) is left out, in an answer and in the
//   documentation it carries (the base error of ssam_job);
// - LOW 5: a tool's definition (ssam_reference {kind:"tool"} and the listing a licensee is served) is SSAM's documentation:
//   its description and the descriptions of its schemas lose internal names; names, types and values stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exposedResult } from '../exposure.mjs';
import { findings } from './fixtures/internal-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kernel = path.resolve(here, '..', '..', '..', '..', 'kernel');
const cliBuilt = fs.existsSync(path.join(kernel, '.local', 'cli', 'anvil.dll')) && fs.existsSync(path.join(kernel, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'));
const skip = !cliBuilt && 'the lane CLIs are not built in this checkout';
const roots = ['C:\\srv\\ssam\\kernel\\.local'];
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const licensee = (tool, value, args = {}) => exposedResult(result(value), { exposure: 'licensee', handleRoots: roots, tool, args }).structuredContent;
const shown = list => list.map(f => f.family + ' ' + f.at + ' ' + f.sample.replace(/\s+/g, ' ').slice(0, 120));
// Two words the guard reads as internal that a tool definition uses for the customer's side: an example of the customer's
// extension source file (o11_extension) and the provenance of an ODC API (the platform's own word, odc_list_apis).
const DECLARED = [['file:line or source file', /\bHelpers\.cs\b/], ['proof level or stamp', /\bODC API domain\b.*\bprovenance\b|\bprovenance and deprecation\b/]];
const undeclared = list => list.filter(f => !DECLARED.some(([family, re]) => f.family === family && re.test(f.sample)));

// ---- LOW 3
test('a list of SSAM\'s prose follows the runtime rule like one prose field; the customer\'s words and records stay (LOW 3)', () => {
  const check = { ok: false, code: 'JOB_INVALID', error: 'the job does not pass the preflight',
    errors: ['op #0 (logic) [FLOW_SYNTAX]: write the line in the ssam-flow/1 grammar (docs/TEXTO-LOGICA.md)',
      'op #1 (spec) [ATTRIBUTE_UNKNOWN]: entity Invoices has no attribute ReviewedOn (at Anvil.Core.Kernel.JobPreflight.Check in C:\\srv\\ssam\\kernel\\src\\Anvil.Core\\Kernel\\JobPreflight.cs:line 318)'],
    warnings: ['see kernel/src/Anvil.Core/Kernel/FlowMerge.cs:95 for the merge of Invoices'], messages: ['read C:\\srv\\ssam\\kernel\\.local\\cli\\anvil.dll'],
    notes: ['Anvil.Core.PreflightRules checked the job'] };
  const out = licensee('ssam_reference', check, { kind: 'check-job' });
  assert.deepEqual(shown(findings(out)), []);
  assert.equal(out.errors.length, 2);
  assert.match(out.errors[1], /entity Invoices has no attribute ReviewedOn/, 'the customer\'s words stay');
  assert.match(out.warnings[0], /merge of Invoices/);
  assert.deepEqual(shown(findings(licensee('ssam_job', check))), [], 'the same in any runtime answer');
  // a state report: its server paths in a list too (a handle under the answers stays)
  const handle = 'C:\\srv\\ssam\\kernel\\.local\\answers\\a.json';
  const report = { ok: true, checks: ['C:\\srv\\ssam\\kernel\\.local\\cli\\anvil.dll', 'C:\\srv\\ssam\\platforms\\odc\\odc.cmd', handle, 'bridge answers'] };
  const shownReport = licensee('ssam_doctor', report);
  // (the guard cannot tell a handle in a list, which has no key, from a server path: the handle is checked apart)
  assert.deepEqual(shown(findings({ ...shownReport, checks: shownReport.checks.filter(item => item !== handle) })), []);
  assert.deepEqual(shownReport.checks.slice(2), [handle, 'bridge answers']);
  // the customer's records keep every list as it is
  const rows = { ok: true, rows: [{ errors: ['C:\\customer\\file.txt', 'docs/README.md'], notes: ['Anvil.Core'] }], records: [{ messages: ['kernel/x'] }] };
  for (const tool of ['studio_data', 'o11_data']) assert.deepEqual(licensee(tool, rows), rows, tool);
});

// ---- LOW 4
const BASE_ERROR = "ArgumentException: base 'C:\\nope\\none.oml' points to an OML outside tests/fixtures and outside the SSAM capture folders "
  + "(<kernel>/.local/**/snapshots|downloads|download|download-app|work, C:\\srv\\ssam\\kernel\\.local\\snapshots): a loose file another run may rewrite. "
  + 'Use job:<name>, a fixture, a capture of those folders (o11_studio snapshot, o11_environment download), or bind a snapshot on the command.';
test('a suite path in SSAM\'s prose is left out, in an answer and in the documentation it carries (LOW 4)', () => {
  const value = { ok: false, code: 'ARGUMENT_INVALID', error: BASE_ERROR,
    discovery: { schemaVersion: 'ssam-job-guidance/1', lane: 'o11', failure: { stage: 'runner', message: BASE_ERROR } } };
  const out = licensee('ssam_job', value);
  assert.deepEqual(shown(findings(out)), []);
  for (const text of [out.error, out.discovery.failure.message]) {
    assert.doesNotMatch(text, /tests[\\/]fixtures|\.local[\\/]/, text);
    assert.match(text, /o11_studio snapshot, o11_environment download/, 'what to do stays: ' + text);
  }
});

// ---- LOW 5
test('a tool definition is SSAM\'s documentation: descriptions lose internal names, names, types and values stay (LOW 5)', () => {
  const definition = { name: 'o11_data', title: 'o11_data', description: 'Reads and writes the records of an entity. See docs/O11-DADOS-HEADLESS.md.',
    inputSchema: { type: 'object', properties: {
      spec: { type: 'string', description: 'sources?:[{path:"Helpers.cs", text}]; generated from platforms/odc/facade/debug-matrix/matrix-source.js; lane odc uses tests/jobs-odc over the ODC fixture' },
      description: { type: 'string', description: 'the job\'s description. Live coverage and restrictions: docs/DEBUGGER-HEADLESS-FALTA.md.' },
      mode: { type: 'string', enum: ['read', 'write'], default: 'read' } }, required: ['spec'] } };
  const value = { ok: true, lane: 'o11', kind: 'tool', schemaVersion: 'ssam-tool-definition/1', query: 'o11_data', definition };
  const out = licensee('ssam_reference', value, { kind: 'tool' });
  assert.deepEqual(shown(undeclared(findings(out))), []);
  const props = out.definition.inputSchema.properties;
  assert.match(props.spec.description, /path:"Helpers\.cs"/, 'an example of the customer\'s input stays');
  assert.deepEqual(props.mode, definition.inputSchema.properties.mode, 'values stay');
  assert.deepEqual(out.definition.inputSchema.required, ['spec']);
  assert.equal(out.definition.name, 'o11_data');
  assert.equal(out.definition.description, 'Reads and writes the records of an entity.', 'a sentence that only pointed to a project document is left out');
  assert.equal(props.description.description, 'the job\'s description.');
});

// ---- round 6b (re-review C:\t\revisoes\no-internals-6\REVISAO.md, LOW 1): no internal name of the kernel or of the project
// in a tool definition: the kernel's name (Anvil) reads SSAM, a folder of the project its root, a state folder of the server
// <server>, the owner's own environments the placeholder personal-xxxx. A vault entry name and the placeholder stay.
const INTERNAL_NAMES = /\banvil\b|\bANVIL_\w+|SSAM-Hybrid|\.ssam-hybrid|\bpersonal-(?!xxxx\b)[a-z0-9]{5,}\b/i;
const namesIn = (node, at = '', out = []) => {
  if (Array.isArray(node)) node.forEach((v, i) => namesIn(v, at + '/' + i, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && INTERNAL_NAMES.test(v)) out.push(at + '/' + k + ' ' + v.match(INTERNAL_NAMES)[0]);
    else namesIn(v, at + '/' + k, out);
  }
  return out;
};
test('a tool definition names no internal name of the kernel or the project (LOW 1 of round 6)', () => {
  const definition = { name: 'ssam_job', description: 'lane o11 (default) uses the Anvil fixtures; lane odc uses tests/jobs-odc over the ODC fixture. State lives in %USERPROFILE%\\.ssam-hybrid\\debugger and every legacy %LOCALAPPDATA%\\SSAM copy.',
    inputSchema: { type: 'object', properties: {
      job: { type: 'string', description: 'Path of the job JSON (absolute or relative to the Anvil root), or the job itself' },
      odcJob: { type: 'string', description: 'Path of the job JSON (absolute or relative to the SSAM-Hybrid-ODC root)' },
      captureProducers: { type: 'array', description: 'Producers to capture read-only before the job (anvil signature): "Name"' },
      host: { type: 'string', description: 'O11 environment host (DNS name), e.g. personal-2qqw9srv.outsystemscloud.com.' },
      tenant: { type: 'string', description: 'Tenant host (e.g. personal-xxxx.outsystems.dev). Default: the only Studio session, else personal-aiupndln.outsystems.dev.' },
      credential: { type: 'string', description: 'Vault entry name SSAM/ODC3/<tenant>/DB/<credential>' } } } };
  const out = licensee('ssam_reference', { ok: true, lane: 'o11', kind: 'tool', schemaVersion: 'ssam-tool-definition/1', query: 'ssam_job', definition }, { kind: 'tool' });
  assert.deepEqual(namesIn(out), []);
  const props = out.definition.inputSchema.properties;
  assert.match(out.definition.description, /uses the SSAM fixtures/, 'the kernel\'s name reads SSAM');
  assert.match(props.job.description, /relative to the SSAM root/);
  assert.match(props.odcJob.description, /relative to the SSAM root/);
  assert.match(props.captureProducers.description, /\(SSAM signature\)/);
  assert.match(props.host.description, /e\.g\. personal-xxxx\.outsystemscloud\.com/, 'an environment of the owner reads the placeholder');
  assert.match(props.tenant.description, /^Tenant host \(e\.g\. personal-xxxx\.outsystems\.dev\)/, 'the placeholder stays');
  assert.equal(props.credential.description, definition.inputSchema.properties.credential.description, 'a vault entry name stays');
});

// ---- round 6c: the same family in all the documentation a licensee is served (every kind of ssam_reference, the discover
// pages): the kernel's name and its CLI in SSAM's prose. A parenthetical that is the kernel's CLI or one of its command
// lines is left out, a quoted command line reads SSAM, the name reads SSAM; the code of an example stays as it is.
const KERNEL_WORDS = /\banvil(?:-odc)?\b|\bANVIL_[A-Z0-9_]+/i;
const CODE = new Set(['ops', 'patch', 'value', 'args', 'arguments', 'code', 'html', 'flow', 'ddl']);
const kernelWordsIn = (node, at = '', out = []) => {
  if (Array.isArray(node)) node.forEach((v, i) => kernelWordsIn(v, at + '/' + i, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
    if (CODE.has(k)) continue;
    if (typeof v === 'string' && KERNEL_WORDS.test(v)) out.push(at + '/' + k + ' ' + v.slice(Math.max(0, v.search(KERNEL_WORDS) - 40), v.search(KERNEL_WORDS) + 50));
    else kernelWordsIn(v, at + '/' + k, out);
  }
  return out;
};
test('the documentation a licensee is served names neither the kernel nor its CLI; an example\'s code stays (round 6c)', () => {
  const ops = [{ op: 'theme', value: '/* anvil:theme-css-halves */ .anvil-halves { color: #0066db; }' }, { op: 'create', args: { managedBy: 'anvil' } }];
  const example = { ok: true, lane: 'odc', kind: 'example', id: 'jobs-odc/timer-lifecycle',
    description: 'verify-messages, generated from the installed ODC Studio by `anvil-odc verify-catalog --out`. Before this the job was refused. A service action arrives as ReferenceServiceAPIMethod, which Anvil reads as IServiceActionSignature; reads that Anvil prints in the result.',
    data: { description: 'The question the job answers: the census (anvil-odc census --oml C:\\srv\\x\\capture.oml) marks ITimer.ScheduleConfiguration.', ops } };
  const out = licensee('ssam_reference', example, { kind: 'example' });
  assert.deepEqual(kernelWordsIn(out), []);
  assert.equal(out.data.description, 'The question the job answers: the census marks ITimer.ScheduleConfiguration.');
  assert.match(out.description, /generated from the installed ODC Studio by SSAM\. Before this/);
  assert.match(out.description, /which SSAM reads as IServiceActionSignature; reads that SSAM prints in the result/);
  assert.deepEqual(out.data.ops, ops, 'the code of an example stays as it is');
  const refusal = { ok: false, code: 'KIND_NOT_IN_LANE', error: 'the ODC CLI (anvil-odc) has no functions; it answers api, check-job, verify-message, recipe, example, rules, tool' };
  const shownRefusal = licensee('ssam_reference', refusal, { kind: 'functions' });
  assert.equal(shownRefusal.error, 'the ODC CLI has no functions; it answers api, check-job, verify-message, recipe, example, rules, tool');
  // the same steps hold in a tool definition (round 6b): a name in a parenthetical that is no command reads SSAM
  const definition = { name: 'x', description: 'Producers to capture read-only before the job (anvil signature), with ANVIL_LANE as set.' };
  const def = licensee('ssam_reference', { ok: true, kind: 'tool', schemaVersion: 'ssam-tool-definition/1', definition }, { kind: 'tool' }).definition;
  assert.match(def.description, /\(SSAM signature\), with <server> as set\./);
});

// ---- round 7, the port from servidor/fase4-26 (a7 phase 3, review vps-a7-2 B4): the layout of the Linux image too
test('a path of the Linux image (its temp folder, its /data volumes) is the server\'s; a JSON pointer stays (port of a7 B4)', () => {
  const runtime = { ok: false, code: 'X', error: 'cannot read /tmp/ssam-x/answers/a.json nor /data/server/state/day.json; see /data/results and /data/html of the answer' };
  const out = licensee('ssam_job', runtime);
  assert.deepEqual(shown(findings(out)), []);
  assert.match(out.error, /^cannot read <server> nor <server>; see \/data\/results and \/data\/html of the answer$/);
  const report = { ok: true, cache: '/data/cache/discovery/o11.json', friction: '/data/friction/queue' };
  assert.deepEqual(licensee('ssam_doctor', report), { ok: true, cache: '<server>', friction: '<server>' });
});

// ---- round 7 (review C:\t\revisoes\vps-a7-3\REVISAO.md, B1 and B2, and the same family the sweep found): no kernel layout,
// CLI flag or internal proof level reaches a licensee in any field
const CLI_FLAG = /(?<![\w-]|var\()--[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?![\w-]*\s*:)/;
const CODE_KEYS_R7 = new Set(['ops', 'patch', 'arguments', 'code', 'html', 'flow', 'ddl', 'content']);
const flagsIn = (node, at = '', out = []) => {
  if (Array.isArray(node)) node.forEach((v, i) => flagsIn(v, at + '/' + i, out));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
    if (CODE_KEYS_R7.has(k)) continue;
    if (typeof v === 'string' && (CLI_FLAG.test(v) || /<kernel>/.test(v))) out.push(at + '/' + k + ' ' + v.slice(Math.max(0, v.search(CLI_FLAG) - 50), v.search(CLI_FLAG) + 50));
    else flagsIn(v, at + '/' + k, out);
  }
  return out;
};
const BASE_REASON = "the base or a producer of the job could not be loaded (ArgumentException: base 'C:\\Users\\cust\\mybase.oml' points to an OML outside tests/fixtures and outside the SSAM capture folders (<kernel>/.local/**/snapshots|downloads|download|download-app|work, platforms/odc/snapshots): a loose file another run may rewrite. Use job:<name>, a fixture, a capture of those folders (o11_studio snapshot, o11_environment download), or bind a snapshot on the command: --base <oml> / --producer <Name>=<oml>): only the job was read, so the base check, the apply and the Verify did not run";
test('SSAM\'s prose in any *Reason/*Message field names no kernel layout, suite folder or CLI flag (B1)', () => {
  const job = { ok: false, code: 'PREFLIGHT_REFUSED', verifyRan: false, verifyReason: BASE_REASON, closeReason: 'see C:\\srv\\ssam\\kernel\\.local\\work\\x.json', skipMessage: 'skipped by Anvil.Core.JobRunner' };
  const out = licensee('ssam_job', job);
  assert.deepEqual([...shown(findings(out)), ...flagsIn(out)], []);
  assert.match(out.verifyReason, /o11_studio snapshot, o11_environment download/, 'what to do stays');
  assert.match(out.verifyReason, /only the job was read, so the base check, the apply and the Verify did not run$/);
  const check = { ok: true, verifyRan: false, data: { verifyReason: 'only the job was read (no base loaded): the base check, the apply and the Verify did not run; `apply --job <job> --base <oml> --out <oml>` runs every phase and refuses once with all of them' } };
  const shownCheck = licensee('ssam_reference', check, { kind: 'check-job' });
  assert.deepEqual(flagsIn(shownCheck), []);
  assert.equal(shownCheck.data.verifyReason, 'only the job was read (no base loaded): the base check, the apply and the Verify did not run');
});
test('a CLI flag leaves SSAM\'s documentation; a tool form, a CSS custom property and code stay (B1, the family)', () => {
  const doc = { ok: true, kind: 'example', lane: 'odc',
    description: 'On the blank Mobile app (create-blank --kind Mobile), a public service action. The output is the fixture p.oml (apply with --base blank.oml --out p.oml). Bind the producer with ssam_job captureProducers:["<Module>"] or --producer <Module>=<snapshot.oml>.',
    rules: ['Style the runtime box, not the bare tag (api --op html: document.runtime); a visual warning names its check.', 'Set `--color-primary` in the theme; var(--color-primary) reads it.'],
    text: 'Every detection reads O11 jobs. In a run with `--platform odc`, the job stages do not run. The rest applies.',
    error: "ArgumentException: block 'Button' not in OutSystemsUI 2.28.1; try --find",
    limits: [{ text: 'The contract is the signature in the capture (context.signatures with --app, or studio_inspect {target:"<capture>"}).' }],
    data: { ops: [{ op: 'theme', value: '.x { --crv-navy: #142446; color: var(--crv-navy); }' }] } };
  const out = licensee('ssam_reference', doc, { kind: 'example' });
  assert.deepEqual(flagsIn(out), []);
  // (round 7b, review no-internals-7 B4: a pointer to SSAM's own reference and a producer binding read as the MCP form)
  assert.equal(out.description, 'On the blank Mobile app, a public service action. The output is the fixture p.oml. Bind the producer with ssam_job captureProducers:["<Module>"] or producers:{"<Module>":"<snapshot.oml>"}.');
  assert.equal(out.rules[0], 'Style the runtime box, not the bare tag (ssam_reference {kind:"api", query:{op:"html"}}: document.runtime); a visual warning names its check.');
  assert.equal(out.rules[1], doc.rules[1], 'a CSS custom property is no flag');
  // (round 7b, review no-internals-7 MEDIUM 2: the run of a lane reads as the lane, so what holds on ODC stays)
  assert.equal(out.text, 'Every detection reads O11 jobs. In a run on ODC, the job stages do not run. The rest applies.');
  assert.equal(out.error, "block 'Button' not in OutSystemsUI 2.28.1; try query:{find:\"<words>\"}", 'review vps-a9 E2: the type of an exception of SSAM leaves the prose, the message stays');
  assert.equal(out.limits[0].text, 'The contract is the signature in the capture (context.signatures with app, or studio_inspect {target:"<capture>"}).');
  assert.deepEqual(out.data.ops, doc.data.ops, 'code stays');
});
test('an internal proof level reads the seal in any field, under a code key and in a packet\'s patch; a packet\'s prose too (B2)', () => {
  const discover = { ok: true, schemaVersion: 'ssam-discovery/1', bindings: [{ rule: 'set Action', job: 'smoke-data-logic', op: 41, level: 'C-executed-historical' }, { rule: 'r', level: 'C-suite' }],
    native: [{ type: 'IServerAction', evidence: 'proven-historical' }] };
  const out = licensee('ssam_discover', discover);
  assert.deepEqual(shown(findings(out)), []);
  assert.deepEqual(out.bindings.map(b => b.level), ['proven', 'proven']);
  assert.equal(out.bindings[0].job, 'smoke-data-logic', 'an example id stays');
  const part = { ok: true, schemaVersion: 'ssam-packet-part/1', section: 'rules', missing: [
    { op: 'add', path: '/items/1/level', value: 'C-executed-historical' },
    { op: 'add', path: '/items/1/rule', value: "The owner's decision (2026-10-09), a kernel rule on both lanes. Fetch the related data at once, before the loop." },
    { op: 'add', path: '/items/2/proofs', value: [{ job: 'x', provenance: { kernelSha256: 'ab' } }] },
    { op: 'add', path: '/chosen', value: 'by the words of the intent' }] };
  const shownPart = licensee('ssam_discover', part);
  assert.deepEqual(shown(findings(shownPart)), []);
  assert.equal(shownPart.missing.find(m => m.path === '/items/1/level').value, 'proven');
  assert.match(shownPart.missing.find(m => m.path === '/items/1/rule').value, /Fetch the related data at once, before the loop\.$/);
  assert.equal(shownPart.missing.some(m => m.path === '/items/2/proofs'), false, 'an internal field of the documentation is left out of the patch too');
  assert.equal(shownPart.missing.find(m => m.path === '/chosen').value, 'by the words of the intent');
});
test('a text cut at its end, an html example\'s file and a job\'s _why note name nothing internal (the sweep of round 7)', () => {
  const doc = { ok: true, kind: 'example', lane: 'o11', matches: [
    { id: 'a', description: 'UsdRate returns Rate = Rates.USD (written by an LLM with no context in the cold session E of 2026-09-04, passed the first...' },
    { id: 'b', description: 'the order that makes it pass was only measured in O11 (tests/jobs/block-events-delete-reactive.j…' }],
    files: [{ path: 'tests/html/dcips-approval.css' }],
    data: { ops: [{ op: 'delete', _why: 'The refusal with the consumer linked is in tests/jobs-odc-negative/delete-static-record-in-use.json; the two tie at Rank 2 (Verbs.cs:877-880).' }] } };
  const out = licensee('ssam_reference', doc, { kind: 'example' });
  assert.deepEqual(shown(findings(out)), []);
  assert.match(out.matches[0].description, /^UsdRate returns Rate = Rates\.USD…$/);
  // (round 7b, review no-internals-7 B5: tests/jobs-odc-negative is no folder ssam_reference serves: no id that answers
  // EXAMPLE_NOT_FOUND)
  assert.match(out.data.ops[0]._why, /^The refusal with the consumer linked is in an example of SSAM; the two tie at Rank 2\.?$/);
});

test('the origin of a fact in SSAM\'s documentation names neither the kernel\'s layout nor a suite job (the sweep of round 7)', () => {
  const doc = { ok: true, schemaVersion: 'ssam-discovery/1', differences: { o11: [{ property: 'Schedule', origin: 'kernel/catalog/model-api-11.55.69.json ITimer (writable: Action, Description, Priority, Schedule, TimeoutInMinutes); tests/jobs-odc/timer-action.json description' }] } };
  const out = licensee('ssam_discover', doc);
  assert.deepEqual(shown(findings(out)), []);
  assert.match(out.differences.o11[0].origin, /ITimer \(writable: Action, Description, Priority, Schedule, TimeoutInMinutes\); timer-action description$/, 'the fact stays');
  // a runtime origin is the customer's (ssam_code problems): as it is
  const code = { ok: false, problems: [{ code: 'X', origin: { at: 'files/1', file: 'C:\\work\\caller.flow' } }] };
  // (marco-a6) the file the call named comes back as the caller sent it; a path it did not send is the server's
  // (no-internals-paths.test.mjs)
  assert.deepEqual(licensee('ssam_code', code, { action: 'check', files: ['C:\\work\\other.flow', 'C:\\work\\caller.flow'] }).problems, code.problems);
});

test('the steps of round 7 keep the text whole: a folder of examples, a parenthetical left open, a period after a path', () => {
  const doc = { ok: true, kind: 'example', lane: 'o11',
    error: "no example 'timer-action' in tests/jobs, tests/jobs/examples or tests/html",
    negative: [{ description: 'it must give ok=False with the expectError message (runs in tests/jobs-odc-negative/delete-logic-in-use.json. The clean path, with replace, is in delete-logic-consumers.' }],
    matches: [{ id: 'x', description: 'Over the fixture, with stand-ins for the producer actions; generated by C:\\srv\\x\\gen.mjs --target fixture.' },
      { id: 'y', description: 'Over the fixture; generated by scripts/gen-fixture.mjs --target fixture.' },
      // a find cuts a description to its room without a mark
      { id: 'z', description: 'Fx_GetUsdRate that returns Rate = Rates.USD (written by an LLM with no context in the cold session E of 2026-09-04, passed the first ti' }] };
  const out = licensee('ssam_reference', doc, { kind: 'example' });
  assert.equal(out.error, "no example 'timer-action' in the proven examples");
  assert.match(out.negative[0].description, /The clean path, with replace, is in delete-logic-consumers\.$/, 'a parenthetical left open in a whole text keeps what follows');
  assert.equal(out.matches[0].description, 'Over the fixture, with stand-ins for the producer actions; generated by <server>.');
  assert.equal(out.matches[1].description, 'Over the fixture; generated by <server>.', 'a repository path leaves its period too');
  assert.equal(out.matches[2].description, 'Fx_GetUsdRate that returns Rate = Rates.USD\u2026', 'a text cut without a mark inside an internal parenthetical');
  assert.deepEqual(shown(findings(out)), []);
  // a suite job in any folder of the suite is its name (tests/jobs-odc/examples-live/x.json)
  const guidance = licensee('ssam_discover', { ok: true, schemaVersion: 'ssam-discovery/1', matches: [{ id: 'a', guidance: 'Proven in tests/jobs-odc/examples-live/odc-agents-example.json. Native model tests: kernel/tests/Anvil.Tests/X.cs.' }] });
  // (round 7b, B5: a job of a folder ssam_reference does not serve reads as an example of SSAM, not as an id)
  assert.equal(guidance.matches[0].guidance, 'Proven in a live example of SSAM. Native model tests: <server>.');
  // and in any suite folder of jobs (jobs-live, as served in a discover guidance)
  const live = licensee('ssam_discover', { ok: true, schemaVersion: 'ssam-discovery/1', matches: [{ id: 'a', guidance: 'Example: kernel/tests/jobs-live/odc-agents-example.json. See tests/jobs-live for the rest.' }] });
  assert.equal(live.matches[0].guidance, 'Example: a live example of SSAM. See the proven examples for the rest.');
});

// ---- live
async function session() {
  const { createSsamServer } = await import('../ssam.mjs');
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const server = await createSsamServer({ profile: 'all', deps: { exposure: { profile: 'licensee', caller: () => 'fields-' + process.pid + '-' + Date.now(), dayBytes: 500 * 1024 * 1024 } } });
  const client = new Client({ name: 'no-internals-fields', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  const call = async (name, args) => {
    let body = await once(name, args);
    for (let i = 0; i < 120 && body?.state === 'running' && body.continuation; i++) { await new Promise(resolve => setTimeout(resolve, 250)); body = await once(body.continuation.tool, body.continuation.arguments); }
    return body;
  };
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}
test('live: a check-job with errors and an ssam_job with a base outside the fixtures name nothing internal (LOW 3, LOW 4)', { skip, timeout: 900000 }, async () => {
  const s = await session();
  try {
    const check = await s.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: { description: 'x', ops: [{ op: 'logic', data: { action: 'A', flow: 'Start -> End' } }] } });
    assert.equal(check.code, 'JOB_INVALID', JSON.stringify(check).slice(0, 300));
    assert.ok(Array.isArray(check.errors) && check.errors.length, 'the check lists its errors');
    const job = await s.call('ssam_job', { lane: 'o11', job: { description: 'x', base: 'C:/nope/none.oml', ops: [{ op: 'create', type: 'NoSuchType', parent: '$x' }] } });
    assert.equal(job.ok, false, JSON.stringify(job).slice(0, 300));
    assert.deepEqual([...shown(findings(check)), ...shown(findings(job))], []);
  } finally { await s.close(); }
});
test('live: every tool definition and the listing a licensee is served name nothing internal (LOW 5)', { skip, timeout: 900000 }, async () => {
  const s = await session();
  try {
    const listing = (await s.client.listTools()).tools;
    const problems = [];
    for (const tool of listing) {
      for (const f of undeclared(findings({ description: tool.description, inputSchema: tool.inputSchema }))) problems.push('listing ' + tool.name + ' ' + shown([f])[0]);
      let answer = await s.call('ssam_reference', { lane: 'o11', kind: 'tool', query: tool.name });
      if (answer?.continuation?.tool === 'ssam_evidence') answer = await s.call('ssam_evidence', answer.continuation.arguments);
      assert.equal(answer.ok, true, tool.name + ' ' + JSON.stringify(answer).slice(0, 200));
      for (const f of undeclared(findings(answer))) problems.push('definition ' + tool.name + ' ' + shown([f])[0]);
    }
    assert.ok(listing.length > 80, 'every tool of the profile was read: ' + listing.length);
    assert.deepEqual(problems, []);
  } finally { await s.close(); }
});
test('live: the documentation the sweep found names neither the kernel nor its CLI (round 6c)', { skip, timeout: 900000 }, async () => {
  const s = await session();
  try {
    const problems = [];
    const calls = [
      ['ssam_reference', { lane: 'odc', kind: 'example', query: { id: 'jobs-odc/timer-lifecycle' } }],
      ['ssam_reference', { lane: 'odc', kind: 'example', query: { id: 'jobs-odc/global-event-unused' } }],
      ['ssam_reference', { lane: 'odc', kind: 'example', query: { id: 'jobs-odc/service-action' } }],
      ['ssam_reference', { lane: 'odc', kind: 'recipe', query: 'timer' }],
      ...['functions', 'ui-block', 'where-can', 'types'].map(kind => ['ssam_reference', { lane: 'odc', kind, query: kind === 'where-can' || kind === 'types' ? { name: 'Text' } : { find: 'Text' } }]),
    ];
    for (const [name, args] of calls) {
      let answer = await s.call(name, args);
      // a large answer is read back from its reference file, page by page
      for (let page = 0; page < 20 && answer?.continuation?.tool === 'ssam_evidence'; page++) {
        for (const at of kernelWordsIn(answer)) problems.push(JSON.stringify(args.query) + ' ' + at);
        const next = await s.call('ssam_evidence', answer.continuation.arguments);
        answer = next?.next != null ? { ...next, continuation: { tool: 'ssam_evidence', arguments: { ...answer.continuation.arguments, offset: next.next } } } : next;
      }
      for (const at of kernelWordsIn(answer)) problems.push(args.kind + ' ' + JSON.stringify(args.query) + ' ' + at);
    }
    assert.deepEqual(problems, []);
  } finally { await s.close(); }
});
test('live: no kernel layout, CLI flag or internal proof level in the answers the sweep of round 7 found (B1, B2)', { skip, timeout: 900000 }, async () => {
  const s = await session();
  const dir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'r7-loose-'));
  const loose = path.join(dir, 'mybase.oml'); fs.writeFileSync(loose, 'not an oml');
  const badOps = [{ op: 'create', type: 'NoSuchType', parent: '$x' }, { op: 'logic', data: { action: 'A', flow: 'Start -> End' } }];
  try {
    const problems = [];
    const calls = [
      ['ssam_job', { lane: 'o11', job: { description: 'x', base: loose, ops: badOps } }],
      ['ssam_reference', { lane: 'o11', kind: 'check-job', query: { description: 'x', ops: [] } }],
      ['ssam_discover', { lane: 'o11', intent: 'add an entity Customer with name and email', budgetBytes: 40960 }],
      ['ssam_discover', { lane: 'odc', intent: 'create a mobile app', budgetBytes: 40960 }],
      ['ssam_reference', { lane: 'o11', kind: 'rules', query: 'standards' }],
      ['ssam_reference', { lane: 'o11', kind: 'ui-block', query: 'Button' }],
      ['ssam_reference', { lane: 'o11', kind: 'recipe', query: { find: 'entity' } }],
      ['ssam_reference', { lane: 'odc', kind: 'example', query: { find: 'process' } }],
      ['ssam_reference', { lane: 'odc', kind: 'example', query: { id: 'jobs-odc/agent-definition-tools' } }],
      ['ssam_reference', { lane: 'o11', kind: 'example', query: { id: 'jobs/examples/pat-consumer-reference-action' } }],
      ['ssam_doctor', { lane: 'o11' }],
    ];
    for (const [name, args] of calls) {
      const answer = await s.call(name, args);
      for (const at of [...shown(findings(answer)), ...flagsIn(answer)]) problems.push(name + ' ' + JSON.stringify(args).slice(0, 80) + ' ' + at);
    }
    // a packet's parts (the patch that rebuilds its sections)
    const base = { lane: 'o11', intent: 'create an entity Customer with name and email and its CRUD actions', limit: 8, packet: true };
    const packet = await s.call('ssam_discover', base);
    for (const expand of [...new Set(JSON.stringify(packet).match(/packet:(?:rules|capabilities|text):[^"]+/g) ?? [])]) {
      const piece = await s.call('ssam_discover', { ...base, expand });
      for (const at of [...shown(findings(piece)), ...flagsIn(piece)]) problems.push('packet ' + expand.slice(0, 20) + ' ' + at);
    }
    assert.deepEqual(problems, []);
  } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('live: no internal name of the kernel or the project in the listing or any tool definition (LOW 1 of round 6)', { skip, timeout: 900000 }, async () => {
  const s = await session();
  try {
    const listing = (await s.client.listTools()).tools;
    const problems = [];
    for (const tool of listing) {
      for (const at of namesIn({ description: tool.description, inputSchema: tool.inputSchema })) problems.push('listing ' + tool.name + ' ' + at);
      const answer = await s.call('ssam_reference', { lane: 'o11', kind: 'tool', query: tool.name });
      for (const at of namesIn(answer)) problems.push('definition ' + tool.name + ' ' + at);
    }
    assert.ok(listing.length > 80, 'every tool of the profile was read: ' + listing.length);
    assert.deepEqual(problems, []);
  } finally { await s.close(); }
});
