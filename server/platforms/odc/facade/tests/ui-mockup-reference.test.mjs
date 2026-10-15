// UI-Mockup diagnosis (FarmaVirtual session, 2026-10-10), G8-G10: three ssam_reference calls of that session that
// answered nothing usable. 14 {kind:"api", query:{op:"html", name:"file"}} was refused (QUERY_SHAPE) with a continuation
// to {name:"<name>"}, which drops the valid op: the session wanted to know whether op html takes "file" (it is
// html-visual.shape.file, the fragment form). 50 {kind:"api", query:{op:"html-presentation"}} was CLI_REFUSED without a
// candidate (13 edits from html) and continued to op verbs; the next call (53) searched the examples for "presentation"
// and found none. 66 {kind:"rules", query:"HTML"} was RULES_SECTION_NOT_FOUND: the search read only the headings, and
// "html" is in the text of the lesson "Protótipo aprovado: portar 1:1". The facade runs a fake CLI with the kernel's
// contracts in miniature; rules read the real docs/CONHECIMENTO-DO-TIME.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { anvilRoot } from '../workspace.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { tempKernel, linked } from './fixtures/o11env-kernel.mjs';
// A namespace import: on a parent commit an export that does not exist yet fails the assertion that reads it, not the file.
import * as reference from '../ssam-reference.mjs';
import { generatorApproval, generatorShown, withGeneratorStates } from '../generators.mjs';
const { API_OPS, API_OP_LINES, registerSsamReference, rulesAnswer } = reference;
// The generator gate (generators.mjs, 9ebcc472): the op of a pending generator is neither a candidate nor in the allowed
// list of a guessed op; approved (or named literally), it is. The lists below are the ungated ones, filtered here.
const unasked = op => generatorShown(generatorApproval(op)?.op === op ? op : null);
const gated = ops => ops.filter(op => unasked(typeof op === 'string' ? op : op.op));
const allApproved = fn => withGeneratorStates({ 'entity-actions': { state: 'approved' }, 'rest-consume': { state: 'approved' }, 'gen-screen': { state: 'approved' } }, fn);

// The contracts `api --op <op>` answers, cut to what the tests read (shapes of HtmlExpander, HtmlVisual and VerbSurface).
const CHECKBOX = { widget: 'ICheckbox', rule: 'bind -> Boolean Variable' };
const SCHEMAS = {
  html: { kinds: ['text', 'call'], shapes: { data: ['screen', 'title', 'html', 'css', 'bindings'] }, tags: ['div', 'select'],
    kindTags: { 'navigate|call|refresh|page': 'a (Link) or button (Button) with native OnClick' } },
  'html-visual': { op: 'html', shape: { parent: 'the widget that receives the fragment', file: 'path of the .html fragment', html: 'the fragment inline, instead of file' },
    tags: { select: { widget: 'IDropdown', rule: 'bind -> Variable' }, 'input[type=checkbox]': CHECKBOX } },
  logic: { op: 'logic', data: ['actions', 'remove'] },
  verbs: { op: 'verbs', verbs: { html: { kind: 'write', required: ['parent|data'], optional: ['file', 'html'] },
    create: { kind: 'write', required: ['parent', 'type'], optional: ['name', 'args', 'as'], effect: 'Creates a child of `type` under `parent`' },
    reference: { kind: 'read', required: ['ref'], optional: [], effect: 'Resolves a reference of the reference grammar' },
    logic: { kind: 'write', required: ['data'], optional: [] } } },
};
const OPS = ['logic', 'spec', 'screen', 'html', 'html-visual', 'verbs', 'rest', 'rest-consume', 'rest-expose', 'soap', 'agent', 'prototype', 'entity-actions'];
// The kernel's refusal (CommandSurface.UnknownOp), with its closest name only within 3 edits.
const unknownOp = op => `ArgumentException: unknown op '${op}'${op === 'refrence' ? "; closest: 'reference'" : ''}; allowed: ${OPS.join(', ')}; verbs (their line): create, set, reference, html, rest`;
// A native description (NativeSurface.Describe): the interfaces of that name with their properties, and the CLI's note.
const VALUES = { name: 'Values', type: 'IExpression', canRead: true, canWrite: true, declaredBy: 'OutSystems.Model.IDropdown' };
const LABELS = { name: 'Labels', type: 'IExpression', canRead: true, canWrite: true, declaredBy: 'OutSystems.Model.IDropdown' };
const NAME = { name: 'Name', type: 'string', canRead: true, canWrite: true, declaredBy: 'OutSystems.Model.INamedObject' };
const NOT_LOADED = 'no public interface with this name is loaded in this process (use the short name, e.g. IStaticEntity, or the full name)';
const nativeDescription = type => ({ op: 'native', type, platform: 'O11', ...(type === 'INoSuchThing'
  ? { candidates: [], note: NOT_LOADED }
  : { candidates: [{ fullName: 'OutSystems.Model.' + type, name: type, bases: ['OutSystems.Model.INamedObject'], properties: [VALUES, LABELS, NAME], methods: ['void Name()'], writable: ['Values', 'Labels', 'Name'] }],
    note: 'declared members by reflection over the loaded Studio assemblies; inherited properties list their declaring interface' }) });
// The kernel's switch (CommandSurface.Schema): a grammar by its exact name, else a verb without case answers its own line of
// the verb table (CommandSurface.VerbLine: the line with op "verbs" and the verb), else the refusal.
function api(args) {
  const op = args[2];
  if (args[1] === '--name') return { ok: false, command: 'api', error: 'FileNotFoundException: no catalog/model-api-*.json' };
  if (op === 'native') return { ok: true, command: 'api', data: nativeDescription(args[4]) };
  const verb = Object.keys(SCHEMAS.verbs.verbs).find(v => v.toLowerCase() === String(op).trim().toLowerCase());
  if (!OPS.includes(op) && verb) return { ok: true, command: 'api', data: { ...SCHEMAS.verbs.verbs[verb], op: 'verbs', verb } };
  if (!OPS.includes(op)) return { ok: false, command: 'api', error: unknownOp(op) };
  return { ok: true, command: 'api', data: SCHEMAS[op] ?? { op, data: [] } };
}
async function harness(t, handlers = {}) {
  const kernel = tempKernel({ cli: true });
  const run = fakeAnvil({ api, ...handlers });
  const mcp = await linked(registerSsamReference, { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, uuid: () => 'job-1' });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  return { run, ask: (lane, kind, query) => mcp.call('ssam_reference', { lane, kind, query }) };
}

test('G8 (call 14): api {op, name}: the valid op wins, name filters the keys of its contract and is looked up in the other grammars', async t => {
  const h = await harness(t);
  // The real call: file is not a key of the page form; it is html-visual.shape.file (the fragment form of op html).
  const file = await h.ask('o11', 'api', { op: 'html', name: 'file' });
  assert.equal(file.ok, true, JSON.stringify(file));
  assert.deepEqual(h.run.calls[0].args, ['api', '--op', 'html'], 'the op asked runs first');
  assert.deepEqual([file.data.op, file.data.name, file.data.count, file.data.matches], ['html', 'file', 0, []]);
  assert.deepEqual(file.data.elsewhere[0], { op: 'html-visual', jobOp: 'html', matches: [{ path: 'shape.file', value: 'path of the .html fragment' }] });
  assert.deepEqual(file.data.elsewhere[1], { op: 'verbs', matches: [{ path: 'verbs.html.optional', item: 'file' }] });
  assert.equal(file.note, 'file is not a key of api op html; it is in html-visual (job op html) at shape.file, and in verbs at verbs.html.optional');
  assert.deepEqual(file.continuation.arguments, { lane: 'o11', kind: 'api', query: { op: 'html-visual', name: 'file' } }, 'an op, never {name:"<name>"}');
  // A key of the op itself: no other grammar runs. The fragment form names the job op it belongs to.
  const before = h.run.calls.length;
  const own = await h.ask('o11', 'api', file.continuation.arguments.query);
  assert.deepEqual([own.data.op, own.data.jobOp, own.data.matches], ['html-visual', 'html', [{ path: 'shape.file', value: 'path of the .html fragment' }]]);
  const css = await h.ask('o11', 'api', { op: 'html', name: 'CSS' });
  assert.deepEqual(css.data.matches, [{ path: 'shapes.data', item: 'css' }]);
  assert.deepEqual([css.data.elsewhere, css.data.jobOp], [undefined, undefined]);
  const select = await h.ask('o11', 'api', { op: 'html-visual', name: 'select' });
  assert.deepEqual(select.data.matches, [{ path: 'tags.select', value: { widget: 'IDropdown', rule: 'bind -> Variable' } }]);
  const call = await h.ask('o11', 'api', { op: 'html', name: 'call' });
  assert.deepEqual(call.data.matches.map(m => m.path), ['kinds', 'kindTags.navigate|call|refresh|page'], 'a list of keys and a key of alternatives');
  const alternatives = await h.ask('o11', 'api', { op: 'html', name: 'navigate|call|refresh|page' });
  assert.deepEqual(alternatives.data.matches.map(m => m.path), ['kindTags.navigate|call|refresh|page'], 'the whole key of alternatives');
  // No key is named exactly checkbox, but html-visual has input[type=checkbox]: the keys that contain the name, with the
  // exact key as the next name ("checkbox is a key of no api op contract" was wrong).
  const checkbox = await h.ask('o11', 'api', { op: 'html', name: 'checkbox' });
  assert.deepEqual([checkbox.data.count, checkbox.data.matches, checkbox.data.elsewhere], [0, [], []]);
  assert.deepEqual(checkbox.data.containing, [{ op: 'html-visual', jobOp: 'html', matches: [{ path: 'tags.input[type=checkbox]', key: 'input[type=checkbox]', value: CHECKBOX }] }]);
  assert.equal(checkbox.note, `no key of an api op contract (${API_OPS.join(', ')}) is named exactly checkbox; keys that contain it: html-visual (job op html) at tags.input[type=checkbox]`);
  assert.deepEqual(checkbox.continuation.arguments.query, { op: 'html-visual', name: 'input[type=checkbox]' });
  const exact = await h.ask('o11', 'api', checkbox.continuation.arguments.query);
  assert.deepEqual(exact.data.matches, [{ path: 'tags.input[type=checkbox]', value: CHECKBOX }]);
  assert.equal(h.run.calls.length, before, 'the contracts read for the first lookup are reused');
  // A native type: name is an interface or a property of its description, never a field of it (type, name, canWrite) nor
  // an item of its lists of names (writable); a native op without type takes name as the type.
  const values = await h.ask('o11', 'api', { op: 'native', type: 'IDropdown', name: 'values' });
  assert.deepEqual(values.data.matches, [{ path: 'candidates[0].properties[0]', value: VALUES }]);
  assert.equal(values.note, undefined, 'one interface: no note');
  const named = await h.ask('o11', 'api', { op: 'native', type: 'IDropdown', name: 'Name' });
  assert.deepEqual([named.data.count, named.data.matches], [1, [{ path: 'candidates[0].properties[2]', value: NAME }]]);
  const typed = await h.ask('o11', 'api', { op: 'native', type: 'IDropdown', name: 'Type' });
  assert.deepEqual([typed.data.type, typed.data.count, typed.data.matches], ['IDropdown', 0, []]);
  assert.equal(typed.note, 'IDropdown has no property named exactly Type');
  assert.deepEqual(typed.continuation.arguments.query, { op: 'native', type: 'IDropdown' });
  // An interface that is not loaded answers the CLI's note, not an empty match that reads as "no such property".
  const missing = await h.ask('o11', 'api', { op: 'native', type: 'INoSuchThing', name: 'Values' });
  assert.deepEqual([missing.ok, missing.data.count, missing.note], [true, 0, NOT_LOADED]);
  assert.deepEqual(missing.continuation.arguments.query, { op: 'native', type: '<Interface>' });
  const native = await h.ask('o11', 'api', { op: 'native', name: 'IDropdown' });
  assert.equal(native.code, 'QUERY_SHAPE');
  assert.deepEqual(native.continuation.arguments.query, { op: 'native', type: 'IDropdown' });
  // A key of no contract: the answer says so and keeps the op.
  const none = await h.ask('o11', 'api', { op: 'logic', name: 'zzz' });
  assert.equal(none.ok, true); assert.deepEqual([none.data.count, none.data.elsewhere, none.data.containing], [0, [], undefined]);
  assert.equal(none.note, `no key of an api op contract (${API_OPS.join(', ')}) is named exactly zzz`);
  assert.deepEqual(none.continuation.arguments.query, { op: 'logic' });
  // A job verb answers its line of the verb table (op "verbs" and the verb): its job op is the verb itself, the op asked, so
  // none is named ({op:"create", name:"as"} answered jobOp "verbs", and a job step is "op":"create"); a verb asked in
  // another case names the verb. The keys that contain a name never say "job op verbs" either.
  const as = await h.ask('o11', 'api', { op: 'create', name: 'as' });
  assert.deepEqual([as.data.op, as.data.jobOp, as.data.matches], ['create', undefined, [{ path: 'optional', item: 'as' }]], JSON.stringify(as));
  const type = await h.ask('o11', 'api', { op: 'create', name: 'type' });
  assert.deepEqual([type.data.jobOp, type.data.matches], [undefined, [{ path: 'required', item: 'type' }]]);
  const logic = await h.ask('o11', 'api', { op: 'Logic', name: 'data' });
  assert.deepEqual([logic.data.jobOp, logic.data.matches], ['logic', [{ path: 'required', item: 'data' }]]);
  const paren = await h.ask('o11', 'api', { op: 'create', name: 'paren' });
  assert.deepEqual(paren.data.containing[0], { op: 'create', matches: [{ path: 'required', key: 'parent', item: 'parent' }] });
  assert.doesNotMatch(paren.note, /job op verbs/, paren.note);
  assert.deepEqual([paren.continuation.arguments.query, paren.continuation.why], [{ op: 'create', name: 'parent' }, 'the key parent of create']);
  // The top-level op and verb name the contract (its job op, a verb's line), never a key of it.
  const opKey = await h.ask('o11', 'api', { op: 'create', name: 'op' });
  assert.deepEqual([opKey.data.matches, opKey.data.elsewhere], [[], []], JSON.stringify(opKey.data));
  assert.deepEqual((await h.ask('o11', 'api', { op: 'create', name: 'verb' })).data.matches, []);
  assert.deepEqual((await h.ask('o11', 'api', { op: 'html', name: 'op' })).data.elsewhere, [], 'the op of html-visual, logic and verbs');
  // An op the CLI refuses: the name stays a key (of the verb table), never an interface (it went to {op:"native",
  // type:"file"}); only a name without op goes on to op native.
  const security = await h.ask('o11', 'api', { op: 'security', name: 'file' });
  assert.equal(security.code, 'CLI_REFUSED');
  assert.deepEqual(security.continuation.arguments.query, { op: 'verbs', name: 'file' });
  const interfaceName = await h.ask('o11', 'api', { name: 'IDropdown' });
  assert.equal(interfaceName.code, 'CLI_REFUSED');
  assert.deepEqual(interfaceName.continuation.arguments.query, { op: 'native', type: 'IDropdown' });
  // Neither op nor name is still the one refusal; catalog with op keeps the op.
  assert.equal((await h.ask('o11', 'api', { type: 'X', catalog: 'C:\\x.json' })).code, 'QUERY_SHAPE');
  const catalog = await h.ask('o11', 'api', { op: 'html', name: 'file', catalog: 'C:\\x.json' });
  assert.deepEqual(catalog.continuation.arguments.query, { op: 'html', name: 'file' });
  // The ODC lane answers the same from its own CLI.
  const odc = await h.ask('odc', 'api', { op: 'html', name: 'file' });
  assert.equal(odc.ok, true, JSON.stringify(odc));
  assert.equal(odc.data.elsewhere[0].op, 'html-visual');
  assert.match(h.run.calls.at(-1).options.cli, /anvil-odc\.dll$/);
});

test('G8: the other contracts are read 4 at a time within 30 s; one the CLI does not answer is named, and that answer is not cached', async t => {
  // A failed read of rest answered "no key of an api op contract (..., rest, ...) is named exactly baseUrl", cached for the
  // whole session: the answer names what it did not read, and the same lookup reads it again.
  let restUp = false;
  const h = await harness(t, { api: args => (args[2] !== 'rest' ? api(args) : restUp ? { ok: true, command: 'api', data: { op: 'rest', data: ['client', 'baseUrl'] } }
    : { exitCode: 1, envelope: null, stderr: ['Unhandled exception: the CLI crashed'] }) });
  const down = await h.ask('o11', 'api', { op: 'logic', name: 'baseUrl' });
  assert.deepEqual([down.ok, down.data.count, down.data.elsewhere, down.unread], [true, 0, [], [{ op: 'rest', error: 'Unhandled exception: the CLI crashed' }]], JSON.stringify(down));
  assert.equal(down.note, `no key of an api op contract (${API_OPS.filter(op => op !== 'rest').join(', ')}) is named exactly baseUrl; `
    + 'not read, so their keys are missing (the same lookup reads them again): rest (Unhandled exception: the CLI crashed)');
  restUp = true;
  const up = await h.ask('o11', 'api', { op: 'logic', name: 'baseUrl' });
  assert.equal(up.cached, undefined, 'an answer with a contract unread is not cached');
  assert.deepEqual([up.unread, up.data.elsewhere], [undefined, [{ op: 'rest', matches: [{ path: 'data', item: 'baseUrl' }] }]]);
  assert.equal((await h.ask('o11', 'api', { op: 'logic', name: 'baseUrl' })).cached, true, 'a whole answer is cached');
  // Four cold CLIs at a time (ten in a row took 2 s), each within 30 s (a hung one held the call 180 s); the op asked keeps
  // the call's own limit.
  let running = 0; let most = 0;
  const slow = await harness(t, { api: async args => { running++; most = Math.max(most, running); await new Promise(done => setTimeout(done, 5)); running--; return api(args); } });
  const none = await slow.ask('o11', 'api', { op: 'logic', name: 'zzz' });
  assert.deepEqual([none.ok, none.data.count, none.unread], [true, 0, undefined]);
  assert.equal(most, 4, 'four reads at a time');
  assert.deepEqual(slow.run.calls.map(c => [c.args[2], c.options.timeoutMs]), API_OPS.map(op => [op, op === 'logic' ? 180000 : 30000]));
});

test('API_OPS is the kernel list of api --op (CommandSurface.OperationNames), in its order', () => {
  const source = fs.readFileSync(path.join(anvilRoot, 'src', 'Anvil.Core', 'Kernel', 'CommandSurface.cs'), 'utf8');
  const names = /OperationNames\s*=\s*\[([^\]]*)\]/.exec(source)?.[1];
  assert.ok(names, 'OperationNames in CommandSurface.cs');
  assert.deepEqual(API_OPS, [...names.matchAll(/"([^"]+)"/g)].map(m => m[1]));
});

test('call 14 against the O11 CLI of this worktree: file is html-visual.shape.file (skipped without a build)', async t => {
  const cli = path.join(anvilRoot, '.local', 'cli', 'anvil.dll');
  if (!fs.existsSync(cli)) { t.skip('no O11 CLI built in ' + anvilRoot); return; }
  const mcp = await linked(registerSsamReference, { root: anvilRoot, lane: 'ss4', env: { ...process.env, ANVIL_WORKER: '0' } });
  t.after(() => mcp.close());
  // A job verb with a name: its line of the verb table (CommandSurface.VerbLine), whose job op is the verb asked (it
  // answered jobOp "verbs").
  const as = await mcp.call('ssam_reference', { lane: 'o11', kind: 'api', query: { op: 'create', name: 'as' } });
  assert.deepEqual([as.ok, as.data?.jobOp, as.data?.matches], [true, undefined, [{ path: 'optional', item: 'as' }]], JSON.stringify(as).slice(0, 400));
  const value = await mcp.call('ssam_reference', { lane: 'o11', kind: 'api', query: { op: 'html', name: 'file' } });
  assert.equal(value.ok, true, JSON.stringify(value).slice(0, 400));
  assert.deepEqual(value.data.matches, []);
  assert.deepEqual(value.data.elsewhere.map(e => e.op), ['html-visual', 'verbs']);
  assert.deepEqual(value.data.elsewhere[0].matches.map(m => m.path), ['shape.file']);
  assert.equal(value.data.elsewhere[0].jobOp, 'html');
  assert.deepEqual(value.continuation.arguments.query, { op: 'html-visual', name: 'file' });
});

test('G10 (call 66): rules words that no heading has are looked up in the text of the sections and lessons', async t => {
  const h = await harness(t);
  // Call 66 on the real docs/CONHECIMENTO-DO-TIME.md: the lesson that says "a op `html`" is among the answers (lessons the
  // team adds with the same words join it, so nothing here counts them).
  const lesson = { id: '3', title: 'Protótipo aprovado: portar 1:1' };
  const html = await h.ask('o11', 'rules', 'HTML');
  assert.equal(html.ok, true, JSON.stringify(html).slice(0, 400));
  assert.equal(html.matchedIn, 'text');
  assert.ok(html.section.some(s => s.id === lesson.id && s.title === lesson.title), JSON.stringify(html.section));
  assert.match(html.text, /^### Protótipo aprovado: portar 1:1\r?$/m);
  assert.match(html.text, /a op `html` com a marcação do protótipo/);
  const both = await h.ask('odc', 'rules', { section: 'html css' });
  assert.ok(both.section.some(s => s.title === lesson.title), 'every word, in one unit: ' + JSON.stringify(both.section));
  // A heading still wins.
  const title = await h.ask('o11', 'rules', 'Changed Attributes');
  assert.equal(title.matchedIn, undefined);
  assert.ok(title.section.some(s => s.title.startsWith('O11: entidade com "Changed Attributes"')), JSON.stringify(title.section));
  assert.equal(h.run.calls.length, 0, 'no CLI');
  // On a document of the test's own: a section's own text (before its first lesson) is a unit of its own, so the lesson
  // below is not returned with it; every word in the same unit; words that no text has are still the one refusal.
  const read = () => '# T\n\n## 1. Um\n\nalpha beta\n\n### Lição\n\ngamma alpha (2026-10-06, regra 10)\n\n## 2. Dois\n\ndelta\n';
  const head = rulesAnswer('o11', 'beta', { read });
  assert.deepEqual([head.matchedIn, head.section, head.text], ['text', [{ id: '1', title: 'Um' }], '## 1. Um\n\nalpha beta\n']);
  assert.deepEqual(rulesAnswer('o11', 'alpha', { read }).section, [{ id: '1', title: 'Um' }, { id: '1', title: 'Lição' }]);
  assert.equal(rulesAnswer('o11', 'alpha delta', { read }).code, 'RULES_SECTION_NOT_FOUND', 'every word in the same unit');
  assert.equal(rulesAnswer('o11', 'nada disso existe', { read }).code, 'RULES_SECTION_NOT_FOUND');
  // A number is a section id, never text: "10" and "2026" found the dates of two lessons.
  assert.deepEqual(rulesAnswer('o11', '2', { read }).section, [{ id: '2', title: 'Dois' }]);
  for (const number of ['10', '2026', '06']) {
    const refused = rulesAnswer('o11', number, { read });
    assert.deepEqual([refused.code, refused.error], ['RULES_SECTION_NOT_FOUND', `docs/CONHECIMENTO-DO-TIME.md has no section ${number} (sections: 1, 2)`], number);
  }
  assert.equal(rulesAnswer('o11', 'regra 10', { read }).section[0].title, 'Lição', 'a number among words is a word of the text');
});

test('G9 (call 50): an unknown op holding the words of known ops answers UNKNOWN_OP with each candidate and its line', async t => {
  const h = await harness(t);
  const presentation = await h.ask('o11', 'api', { op: 'html-presentation' });
  assert.equal(presentation.ok, false); assert.equal(presentation.code, 'UNKNOWN_OP', JSON.stringify(presentation));
  assert.deepEqual(presentation.candidates.map(c => c.op), ['html-visual', 'html'], 'the synonym first, then the html-* ops');
  assert.equal(presentation.candidates[0].line, API_OP_LINES['html-visual']);
  assert.equal(presentation.candidates[1].line, API_OP_LINES.html);
  assert.match(presentation.error, /^unknown op 'html-presentation'; candidates: html-visual, html \(/);
  assert.deepEqual(presentation.continuation.arguments, { lane: 'o11', kind: 'api', query: { op: 'html-visual' } });
  // The fixed synonyms and every segment of a known op (the last one too: expose is rest-expose), the words split at
  // camelCase as well; a verb of the kernel's list and its closest name are candidates too.
  const first = async (op, lane = 'o11') => (await h.ask(lane, 'api', { op })).candidates?.map(c => c.op);
  assert.deepEqual(await first('page'), ['html', 'html-visual']);
  assert.deepEqual(await first('manifest'), ['html', 'html-visual']);
  assert.deepEqual(await first('fragment'), ['html-visual', 'html']);
  assert.deepEqual(await first('visual'), ['html-visual', 'html']);
  assert.deepEqual(await first('html_page'), ['html', 'html-visual']);
  assert.deepEqual(await first('rest-api'), gated(['rest', 'rest-consume', 'rest-expose']));
  // "entity" is a segment of the op entity-actions (2026-10-13): it is a candidate after the verb (when approved).
  assert.deepEqual(await first('create-entity'), gated(['create', 'entity-actions']));
  await allApproved(async () => {
    assert.deepEqual(await first('rest-api'), ['rest', 'rest-consume', 'rest-expose'], 'approved: the generator op is a candidate');
    assert.deepEqual(await first('create-entity'), ['create', 'entity-actions'], 'approved: the generator op is a candidate');
  });
  assert.deepEqual(await first('refrence'), ['reference']);
  assert.deepEqual(await first('expose'), ['rest-expose']);
  assert.deepEqual(await first('expose-api'), ['rest-expose']);
  assert.deepEqual(await first('htmlPresentation'), ['html-visual', 'html']);
  assert.deepEqual(await first('HTMLPage'), ['html', 'html-visual']);
  // A verb carries its own line of the verb table (api --op verbs, read once), not a template.
  const verb = await h.ask('o11', 'api', { op: 'create-entity' });
  assert.deepEqual(verb.candidates, gated([{ op: 'create', line: SCHEMAS.verbs.verbs.create }, { op: 'entity-actions', line: API_OP_LINES['entity-actions'] }]));
  const reads = h.run.calls.filter(c => c.args.join(' ') === 'api --op verbs').length;
  assert.deepEqual((await h.ask('o11', 'api', { op: 'refrence' })).candidates, [{ op: 'reference', line: SCHEMAS.verbs.verbs.reference }]);
  assert.equal(h.run.calls.filter(c => c.args.join(' ') === 'api --op verbs').length, reads, 'the verb table is read once');
  // A name stays in the continuation; the ODC lane answers the same.
  const named = await h.ask('o11', 'api', { op: 'html-presentation', name: 'file' });
  assert.equal(named.code, 'UNKNOWN_OP');
  assert.deepEqual(named.continuation.arguments.query, { op: 'html-visual', name: 'file' });
  assert.deepEqual(await first('html-presentation', 'odc'), ['html-visual', 'html']);
  // Nothing to offer: the kernel's refusal as before, on to the verb table.
  const security = await h.ask('o11', 'api', { op: 'security' });
  assert.equal(security.code, 'CLI_REFUSED');
  assert.deepEqual(security.continuation.arguments.query, { op: 'verbs' });
  assert.ok(API_OPS.every(op => typeof API_OP_LINES[op] === 'string' && API_OP_LINES[op].length > 0), 'every op has its line');
});

test('the refusal of an unknown op as CommandSurface.UnknownOp writes it (read from CommandSurface.cs, no build) answers UNKNOWN_OP', async t => {
  // The facade reads the kernel's wording; this renders that wording from the C# source, so a reworded kernel message
  // fails here and not only in the test against a built CLI.
  const source = fs.readFileSync(path.join(anvilRoot, 'src', 'Anvil.Core', 'Kernel', 'CommandSurface.cs'), 'utf8');
  const template = /string UnknownOp\(string op\)[\s\S]*?return \$"(.*)";\r?\n/.exec(source)?.[1];
  assert.ok(template, 'UnknownOp of CommandSurface.cs returns one interpolated string');
  const grammars = [.../OperationNames\s*=\s*\[([^\]]*)\]/.exec(source)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const verbs = ['create', 'set', 'reference', 'html', 'rest'];
  const render = (op, closest) => {
    const text = template
      .replace(/\{\(closest != null \? \$"([^"]*)" : ""\)\}/, (_, part) => (closest ? part.replace('{closest}', closest) : ''))
      .replace('{string.Join(", ", OperationNames)}', grammars.join(', '))
      .replace('{string.Join(", ", VerbSurface.Names)}', verbs.join(', '))
      .replace('{op}', op);
    assert.doesNotMatch(text, /[{}]/, 'every interpolation of the kernel message is one the facade reads: ' + text);
    return 'ArgumentException: ' + text;
  };
  const h = await harness(t, { api: args => (OPS.includes(args[2]) || args[2] === 'native' ? api(args)
    : { ok: false, command: 'api', error: render(args[2], args[2] === 'refrence' ? 'reference' : null) }) });
  const presentation = await h.ask('o11', 'api', { op: 'html-presentation' });
  assert.equal(presentation.code, 'UNKNOWN_OP', JSON.stringify(presentation));
  assert.deepEqual([presentation.op, presentation.candidates.map(c => c.op), presentation.allowed], ['html-presentation', ['html-visual', 'html'], gated(grammars)]);
  await allApproved(async () => assert.deepEqual((await h.ask('o11', 'api', { op: 'html-presentation' })).allowed, grammars, 'approved: the whole kernel list'));
  const closest = await h.ask('o11', 'api', { op: 'refrence', name: 'ref' });
  assert.deepEqual([closest.code, closest.candidates, closest.continuation.arguments.query],
    ['UNKNOWN_OP', [{ op: 'reference', line: SCHEMAS.verbs.verbs.reference }], { op: 'reference', name: 'ref' }]);
  assert.equal((await h.ask('o11', 'api', { op: 'security' })).code, 'CLI_REFUSED', 'no candidate');
});

test('call 50 against the O11 CLI of this worktree: html-presentation answers html-visual and html (skipped without a build)', async t => {
  const cli = path.join(anvilRoot, '.local', 'cli', 'anvil.dll');
  if (!fs.existsSync(cli)) { t.skip('no O11 CLI built in ' + anvilRoot); return; }
  const mcp = await linked(registerSsamReference, { root: anvilRoot, lane: 'ss4', env: { ...process.env, ANVIL_WORKER: '0' } });
  t.after(() => mcp.close());
  const value = await mcp.call('ssam_reference', { lane: 'o11', kind: 'api', query: { op: 'html-presentation' } });
  assert.equal(value.code, 'UNKNOWN_OP', JSON.stringify(value).slice(0, 400));
  assert.deepEqual(value.candidates.map(c => c.op), ['html-visual', 'html']);
  assert.deepEqual(value.continuation.arguments.query, { op: 'html-visual' });
  assert.deepEqual(value.allowed, gated(API_OPS), 'the kernel list, read from its refusal (without the pending generators)');
  const expose = await mcp.call('ssam_reference', { lane: 'o11', kind: 'api', query: { op: 'expose' } });
  assert.deepEqual(expose.candidates?.map(c => c.op), ['rest-expose'], JSON.stringify(expose).slice(0, 400));
  const verb = await mcp.call('ssam_reference', { lane: 'o11', kind: 'api', query: { op: 'create-entity' } });
  assert.deepEqual(verb.candidates.map(c => c.op), gated(['create', 'entity-actions']));
  assert.equal(verb.candidates[0].line.kind, 'write', 'the line of create in the verb table: ' + JSON.stringify(verb.candidates[0].line).slice(0, 200));
  assert.ok(verb.candidates[0].line.required.includes('type'));
});
