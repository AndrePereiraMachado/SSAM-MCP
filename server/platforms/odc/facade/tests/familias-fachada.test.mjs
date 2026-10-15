// Families of the facade (owner direction 2026-10-12: one rule per family, never a scenario patch; the evidence is the
// owner session of 2026-10-12, 22 writes and 13 refusals, generalized here with neutral names):
//   1. the shape of a call: every ssam_code / o11_deliver / studio_deliver / job shape with one meaning is taken as meant
//      and listed in normalizations (call-shapes.mjs, ssam-code.mjs writeCall and normalizeCodeOps), both lanes;
//   2. the grammar cards: the exact forms the parsers take (no ";" after a declaration line, nothing after end/raise/
//      navigate, a client variable with its default, a popup from scratch with open/close and the Transition of its events),
//      each one inside an example (the CLI round trip of ssam-code.test.mjs applies and reads them back);
//   3. the shape of a refusal: every problem once, the cascade summarized (CASCADE, APPLY_SKIPPED) with blocks on the roots,
//      a pointer once per group with the lines it names.
// Fakes only: no Studio, no worker, no CLI.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';
import { EXAMPLE_HTML, EXAMPLE_LOGIC, exampleCall, grammarCard, normalizeCodeOps, writeCall, codeRead } from '../ssam-code.mjs';
import { relaxTool } from '../tool-input.mjs';
import { resolvePatchedJob } from '../job-patch.mjs';
import { fitProblems, refusalFields } from '../refusal-problems.mjs';
import { deliverOutcome } from '../o11-cycle.mjs';
import { deliverKernel } from '../kernel-delivery.mjs';
import { createSsamServer } from '../ssam.mjs';
import { moduleMap } from '../module-map.mjs';
import { DDL_EXTRACTOR } from '../module-ddl.mjs';
import { writeCapture } from './fixtures/module-index.mjs';

const tmp = t => { const dir = fs.mkdtempSync(path.join(isolatedProfile, 'familias-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const valueOf = r => r.structuredContent ?? JSON.parse(r.content[0].text);
const rules = n => (n ?? []).map(x => x.rule);

// Neutral pieces of a module written by hand: screens, their screen actions, client variables, raw ops.
const screenDoc = (name, actions = []) => `<screen name="${name}"${actions.length ? ` actions="${actions.join(', ')}"` : ''}>\n<div class="page">\n`
  + actions.map(a => ` <button class="btn" onclick="${a}">${a}</button>\n`).join('') + '</div>\n</screen>\n';
const screenAction = (screen, name) => `action ${screen}.${name}\n  end\n`;
const setupOps = n => Array.from({ length: n }, (_, i) => ({ op: 'create', parent: '@espace', type: 'IRole', name: 'Role' + i }));

// A fake ODC lane (studio_deliver records the job the relay wrote), the real ssam server around it.
async function liveServer(t, { answer = () => ({ ok: true, result: 'entregue' }), codeMap = async input => ({ ok: true, echo: input }) } = {}) {
  const root = tmp(t); const seen = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_deliver', { description: 'Deliver.', inputSchema: z.object({ feature: z.string().min(1), module: z.string().optional(), job: z.string().optional(),
      owners: z.array(z.string()).optional(), changes: z.array(z.string()).optional(), until: z.string().optional(), publish: z.boolean().optional(), authorize: z.string().optional() }).strict() },
    async args => { seen.push(args); const value = answer(args); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) }; });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot: root, answersRoot: root, codeMap, lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'familias-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const code = args => client.callTool({ name: 'ssam_code', arguments: { lane: 'odc', module: 'App_UI', ...args } }).then(valueOf);
  const job = () => JSON.parse(fs.readFileSync(seen.at(-1).job, 'utf8'));
  return { client, seen, root, code, job };
}

// ---- 1. the shape of a call -----------------------------------------------------------------------------------------

test('call shape: several new screens in text, 60 screen actions in also and 120 ops go in ONE write (no list limit), listed', async t => {
  const { code, job, seen } = await liveServer(t);
  const screens = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  const actions = screens.flatMap(s => Array.from({ length: 15 }, (_, i) => screenAction(s, 'Go' + i)));
  const w = await code({ action: 'write', part: 'html', text: screens.map(s => screenDoc(s, ['Go0'])), also: [{ part: 'logic', text: actions }], ops: setupOps(120) });
  assert.equal(w.ok, true, JSON.stringify(w).slice(0, 800));
  assert.equal(seen.length, 1);
  const ops = job().ops;
  assert.deepEqual([...new Set(ops.map(o => o.op))], ['create', 'html', 'logic']);
  assert.equal(ops.filter(o => o.op === 'html').length, 4, 'one document op per screen');
  assert.equal(ops.find(o => o.op === 'logic').data.flow.length, 60);
  assert.ok(rules(w.normalizations).includes('html-document-list'), JSON.stringify(w.normalizations));
});

test('call shape: the data goes first whatever the order of the parts (a screen names a client variable of the same write)', async t => {
  const { code, job } = await liveServer(t);
  const w = await code({ action: 'write', part: 'html', text: screenDoc('Alpha', ['Go']),
    also: [{ part: 'logic', text: screenAction('Alpha', 'Go') }, { part: 'ddl', text: 'client variable Counter: Integer = 0' }] });
  assert.equal(w.ok, true, JSON.stringify(w).slice(0, 500));
  assert.deepEqual(job().ops.map(o => o.op), ['spec', 'html', 'logic']);
  assert.ok(rules(w.normalizations).includes('parts-order'));
  // A new block goes before the screen that uses it; a timer that names an action of the write keeps its place.
  const blocks = writeCall({ lane: 'o11', module: 'M', part: 'html', text: ['<screen name="S">\n<Block name="Card"/>\n</screen>', '<block name="Card">\n<div/>\n</block>'] });
  assert.deepEqual(blocks.arguments.job.ops.map(o => /<(screen|block)/.exec(o.data.html)[1]), ['block', 'screen']);
  const timer = writeCall({ lane: 'o11', module: 'M', part: 'logic', text: 'server action Nightly\n  end\n', also: [{ part: 'ddl', text: 'timer Run action Nightly schedule "When Published"' }] });
  assert.deepEqual(timer.arguments.job.ops.map(o => o.op), ['logic', 'spec']);
});

test('call shape: a correction (patch + basedOn) needs no part; a write of ops alone is the job of those ops', async t => {
  const { code, job, seen } = await liveServer(t);
  await code({ action: 'write', part: 'ddl', text: 'create entity A (\n  Id Long Integer identifier auto required\n);' });
  const base = seen.at(-1).job; const sha256 = createHash('sha256').update(fs.readFileSync(base)).digest('hex');
  const fixed = await code({ action: 'write', patch: [{ op: 'replace', path: '/ops/0/data/ddl', value: 'create entity B (\n  Id Long Integer identifier auto required\n);' }], basedOn: { job: base, sha256 } });
  assert.equal(fixed.ok, true, JSON.stringify(fixed).slice(0, 500));
  assert.match(job().ops[0].data.ddl, /create entity B/);
  // ops alone (a part named without text says nothing to deliver), with a set of several properties at once.
  const alone = await code({ action: 'write', part: 'html', ops: [{ op: 'set', target: 'IMobileTheme:AppTheme', props: { StyleSheet: '.a{}', Description: 'd' } }] });
  assert.equal(alone.ok, true, JSON.stringify(alone).slice(0, 500));
  assert.deepEqual(job().ops, [{ op: 'set', target: 'IMobileTheme:AppTheme', prop: 'StyleSheet', value: '.a{}' }, { op: 'set', target: 'IMobileTheme:AppTheme', prop: 'Description', value: 'd' }]);
  assert.ok(rules(alone.normalizations).includes('write-ops-alone')); assert.ok(rules(alone.normalizations).includes('job-op'));
});

test('call shape: the kernel rewrites a delivery answers (object) keep their entries when the job notes join them', async t => {
  const kernel = { total: 1, byRule: { SORT_KEYS_SPLIT: 1 }, items: [{ rule: 'SORT_KEYS_SPLIT', path: '/ops/0/data/actions/0/steps/3/sort', from: 'A.B, A.C', to: '["A.B","A.C"]' }] };
  const { code } = await liveServer(t, { answer: () => ({ ok: true, result: 'entregue', normalizations: kernel }) });
  const w = await code({ action: 'write', part: 'html', ops: [{ op: 'set', target: 'IMobileTheme:AppTheme', props: { StyleSheet: '.a{}', Description: 'd' } }] });
  assert.equal(w.ok, true, JSON.stringify(w).slice(0, 500));
  assert.equal(Array.isArray(w.normalizations), false, JSON.stringify(w.normalizations));
  assert.ok(w.normalizations.items.some(n => n.rule === 'SORT_KEYS_SPLIT'), 'the kernel entry stays: ' + JSON.stringify(w.normalizations));
  for (const rule of ['job-op', 'write-ops-alone']) assert.ok(w.normalizations.byRule[rule] >= 1, rule + ': ' + JSON.stringify(w.normalizations));
  assert.equal(w.normalizations.total, w.normalizations.items.length);
});

test('call shape: the words a model uses for action, part, text and element; data {...} around them; also items as texts', async t => {
  const { code, job, seen } = await liveServer(t);
  // action synonym, part synonym, html as the text field.
  const a = await code({ action: 'deliver', part: 'screen', html: screenDoc('Alpha') });
  assert.equal(a.ok, true, JSON.stringify(a).slice(0, 500));
  assert.equal(job().ops[0].data.html, screenDoc('Alpha'));
  assert.deepEqual(rules(a.normalizations).slice(0, 3), ['action-synonym', 'part-synonym', 'text-field']);
  // data {text} around the text; no part: the form of the text says ddl.
  const b = await code({ action: 'write', data: { text: 'create entity A (\n  Id Long Integer identifier auto required\n);' } });
  assert.equal(b.ok, true, JSON.stringify(b).slice(0, 500));
  assert.equal(job().ops[0].op, 'spec'); assert.ok(rules(b.normalizations).includes('data-wrapper')); assert.ok(rules(b.normalizations).includes('part-from-text'));
  // also: one object, an item that is only a text, an item with logic as the text field, an item with ops (they are the write's).
  const c = await code({ action: 'write', part: 'ddl', text: 'create entity A (\n  Id Long Integer identifier auto required\n);',
    also: [screenAction('Alpha', 'Go'), { logic: screenAction('Alpha', 'Back') }, { ops: setupOps(1) }] });
  assert.equal(c.ok, true, JSON.stringify(c).slice(0, 800));
  assert.deepEqual(job().ops.map(o => o.op), ['create', 'spec', 'logic']);
  assert.deepEqual(job().ops[2].data.flow, [screenAction('Alpha', 'Go'), screenAction('Alpha', 'Back')]);
  assert.ok(rules(c.normalizations).includes('logic-merge'));
  const single = await code({ action: 'write', part: 'ddl', text: 'create entity A (\n  Id Long Integer identifier auto required\n);', also: { text: screenAction('Alpha', 'Go') } });
  assert.equal(single.ok, true); assert.ok(rules(single.normalizations).includes('also-list'));
  // A text in no form of the three is refused once, naming what to give.
  const before = seen.length;
  const bad = await code({ action: 'write', text: 'hello world' });
  assert.equal(bad.code, 'INPUT_INVALID'); assert.match(bad.error, /give part/); assert.equal(seen.length, before);
});

test('call shape: a list of screens to read is read one by one in one answer; screen is the element', async t => {
  const asked = [];
  const { code } = await liveServer(t, { codeMap: async input => { asked.push(input); return { ok: true, screen: input.screen, html: '<screen name="' + input.screen + '"/>' }; } });
  const r = await code({ action: 'read', part: 'html', target: 'App_UI', element: ['Alpha', 'Beta'], budgetBytes: 20000 });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 500));
  assert.deepEqual(r.elements.map(e => e.screen), ['Alpha', 'Beta']);
  assert.deepEqual(asked.map(a => [a.screen, a.budgetBytes]), [['Alpha', 10000], ['Beta', 10000]]);
  assert.deepEqual(rules(r.normalizations), ['read-element-list']);
  const s = await code({ action: 'read', target: 'App_UI', screen: 'Gamma' });
  assert.equal(s.ok, true, JSON.stringify(s).slice(0, 500)); assert.equal(asked.at(-1).screen, 'Gamma');
  // codeRead itself (no server): the same.
  const direct = await codeRead({ lane: 'o11', part: 'html', target: 'M', element: ['A', 'A', 'B'] }, { map: async q => ({ ok: true, screen: q.screen }) });
  assert.deepEqual(direct.elements.map(e => e.element), ['A', 'B']);
});

test('call shape: o11_deliver / studio_deliver / jobs: ops beside the job and a job of one op are the job (before the schema)', async t => {
  const seen = [];
  const config = { inputSchema: z.object({ module: z.string().optional(), job: z.union([z.string(), z.array(z.record(z.string(), z.unknown())), z.record(z.string(), z.unknown())]).optional() }).strict() };
  for (const name of ['o11_deliver', 'studio_deliver', 'ssam_job', 'o11_job']) {
    const { handler } = relaxTool(name, config, async args => { seen.push(args); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; });
    const r = await handler({ module: 'M', ops: [{ op: 'set', target: 'T', prop: 'P', value: 1 }] }, {});
    assert.equal(r.structuredContent.ok, true, name + ' ' + JSON.stringify(r.structuredContent));
    assert.deepEqual(seen.at(-1).job, { ops: [{ op: 'set', target: 'T', prop: 'P', value: 1 }] });
    assert.deepEqual(rules(r.structuredContent.normalizations), ['job-ops']);
    const one = await handler({ module: 'M', job: { op: 'rename', target: 'T', name: 'U' } }, {});
    assert.deepEqual(seen.at(-1).job, { ops: [{ op: 'rename', target: 'T', name: 'U' }] }); assert.deepEqual(rules(one.structuredContent.normalizations), ['job-single-op']);
  }
});

test('job op shapes: set props{}, property, rename newName/to, create kind, raw keys in data, text beside data; listed by pointer', t => {
  const { job, changed, normalizations } = normalizeCodeOps({ ops: [
    { op: 'set', target: 'T', props: { StyleSheet: 'x', Description: 'y' } },
    { op: 'set', target: 'T', property: 'Name', value: 'N' },
    { op: 'rename', target: 'A', newName: 'B' }, { op: 'rename', target: 'C', to: 'D' },
    { op: 'create', parent: '@espace', kind: 'IRole', name: 'R' },
    { op: 'delete', data: { target: '@k1' } },
    { op: 'html', html: '<screen name="S"/>' },
    { op: 'html', screen: 'S', edit: ['<div k="w1"/>'], basedOn: { capture: 'c', html: 'h' } },
    { op: 'logic', flow: 'server action X\n  end\n' },
    { op: 'spec', ddl: 'create entity A ();' },
  ] });
  assert.equal(changed, true);
  assert.deepEqual(job.ops, [
    { op: 'set', target: 'T', prop: 'StyleSheet', value: 'x' }, { op: 'set', target: 'T', prop: 'Description', value: 'y' },
    { op: 'set', target: 'T', value: 'N', prop: 'Name' },
    { op: 'rename', target: 'A', name: 'B' }, { op: 'rename', target: 'C', name: 'D' },
    { op: 'create', parent: '@espace', name: 'R', type: 'IRole' },
    { op: 'delete', target: '@k1' },
    { op: 'html', data: { html: '<screen name="S"/>' } },
    { op: 'html', data: { screen: 'S', edit: ['<div k="w1"/>'], basedOn: { capture: 'c', html: 'h' } } },
    { op: 'logic', data: { flow: ['server action X\n  end\n'] } },
    { op: 'spec', data: { ddl: 'create entity A ();' } },
  ]);
  assert.deepEqual(normalizations.map(n => n.at), ['/ops/0', '/ops/1', '/ops/2', '/ops/3', '/ops/4', '/ops/5', '/ops/6', '/ops/7', '/ops/8', '/ops/9']);
  // A shape with two readings stays as it came: set with prop AND props, a raw key in data that the verb does not read.
  const kept = normalizeCodeOps({ ops: [{ op: 'set', target: 'T', prop: 'P', props: { Q: 1 } }, { op: 'delete', data: { target: '@k', other: 1 } }] });
  assert.equal(kept.changed, false);
  // Every job that enters a delivery (job-patch: o11_deliver, ssam_job/o11_job, the studio_deliver patch) says so.
  const dir = tmp(t);
  const resolved = resolvePatchedJob({ job: { ops: [{ op: 'set', target: 'T', props: { A: 1 } }] } }, { inlineDir: dir });
  assert.deepEqual(JSON.parse(fs.readFileSync(resolved.path, 'utf8')).ops, [{ op: 'set', target: 'T', prop: 'A', value: 1 }]);
  assert.equal(resolved.normalizations[0].rule, 'job-op');
});

test('call shape: a read budget below the smallest page of the data text is read at that page (ssam_map and ssam_code)', async t => {
  const dir = tmp(t);
  const store = path.join(dir, 'store');
  const env = { ...process.env, SSAM_MODULE_INDEX_ROOT: store, SSAM_READER_CACHE_ROOT: path.join(dir, 'readers') };
  const capture = writeCapture(dir, 'capture of a module with data');
  const ddl = { schema: 'ssam-ddl/1', extractor: DDL_EXTRACTOR, lane: 'o11', adapter: 'kernel', sourceSha256: capture.sha256, sourceBytes: 42, createdAt: '2026-10-12T00:00:00Z',
    module: { name: 'App', key: 'R0' }, elements: 2, blocks: [{ key: 'E1', kind: 'ServerEntity', name: 'Visit', section: 'entities', elements: 2,
      text: 'create entity Visit ( -- @E1\n  Id Long Integer identifier auto required -- @E1a\n);' }] };
  const file = path.join(store, 'v1', 'o11', capture.sha256 + '.kernel.ddl.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(ddl));
  const noReader = async () => { throw new Error('the store serves'); };
  const page = await moduleMap({ lane: 'o11', target: capture.file, view: 'ddl', budgetBytes: 2000 }, { env, read: noReader });
  assert.equal(page.ok, true, page.error);
  assert.match(page.text, /create entity Visit/);
  assert.deepEqual(rules(page.normalizations), ['budget-minimum']);
  assert.ok(page.size.budgetBytes > 2000);
  const viaCode = await codeRead({ lane: 'o11', part: 'ddl', target: capture.file, budgetBytes: 2000 }, { map: q => moduleMap(q, { env, read: noReader }) });
  assert.equal(viaCode.ok, true); assert.deepEqual(rules(viaCode.normalizations), ['budget-minimum']);
});

// ---- 2. the grammar cards ---------------------------------------------------------------------------------------------

test('cards: the exact forms the parsers take, each one inside an example; no paraphrase that reads as another form', () => {
  const ddl = grammarCard('ddl', 'o11').card; const logic = grammarCard('logic', 'o11').card; const html = grammarCard('html', 'odc').card;
  // ";" ends only the bracketed statements; a declaration line has none (the parser reads "client variable V: Type;" as an error).
  assert.ok(ddl.rules.some(r => /NO ";" at the end/.test(r) && /client variable V: Type \[= default\]/.test(r)), JSON.stringify(ddl.rules));
  assert.ok(!ddl.rules.some(r => /client variable V: Type;/.test(r)), 'no rule writes a declaration with ";"');
  assert.ok(ddl.rules.some(r => /#2026-01-31#/.test(r) && /never TextToDate/.test(r)), 'a Date default is a literal');
  // Nothing after end, raise or navigate; assign lines 2 spaces deeper.
  assert.ok(logic.rules.some(r => /never "end" after raise or navigate/.test(r)));
  assert.ok(logic.rules.some(r => /indented 2 spaces deeper than assign/.test(r)));
  // A popup from scratch: a Boolean variable, open and close, the Transition of the events inside it. Fade is the
  // platform's default there (kernel ScreenHtml.PopupTransition): the kernel writes it, the reader omits it, so the example
  // writes the event as it reads back and the rule writes os-onclick.Transition only for another transition.
  assert.ok(html.rules.some(r => /<popup show="Var">/.test(r) && /never a <div if>/.test(r) && /Transition Fade/.test(r) && /only for another transition/.test(r)));
  assert.match(EXAMPLE_HTML, /<popup show="MostrarResumo">[\s\S]*<button class="btn" onclick="FecharResumo">Fechar<\/button>[\s\S]*<\/popup>/);
  assert.doesNotMatch(EXAMPLE_HTML, /os-onclick\.Transition="Fade"/, 'the example writes no default the reader omits');
  assert.ok(EXAMPLE_LOGIC.some(t => /action Visitas\.AbrirResumo\n  assign MostrarResumo = True\n  end/.test(t)));
  assert.ok(EXAMPLE_LOGIC.some(t => /action Visitas\.FecharResumo\n  assign MostrarResumo = False\n  end/.test(t)));
  // Every exact form is inside the example the CLI round trip applies (ssam-code.test.mjs) and read back.
  const ui = exampleCall('odc').arguments;
  const sources = { ddl: ui.text, logic: [].concat(ui.also.find(p => p.part === 'logic').text).join('\n'), html: ui.also.find(p => p.part === 'html').text };
  for (const [part, card] of Object.entries({ ddl, logic, html })) {
    assert.ok(card.forms && Object.keys(card.forms).length >= 3, part + ' card names its forms');
    for (const [name, form] of Object.entries(card.forms)) assert.ok(sources[part].includes(form), `${part} form "${name}" is in the example: ${form}`);
  }
  assert.match(ui.text, /\nclient variable UltimoFiltro: Text = "todas"\n/);
  assert.match(ddl.exampleWithUi, /client variable UltimoFiltro: Text = "todas"/);
  // The service example (an empty or _CS module) has no client variable and no screen.
  assert.doesNotMatch(grammarCard(null, 'o11').example.call.arguments.text, /client variable/);
});

test('answer: what a write removed names only what existed before it (the shell nodes of a new action are no deletion)', async () => {
  const { removedOf } = await import('../ssam-code.mjs');
  const results = [{ op: 'logic', result: { flow: [
    { action: 'Go', owner: 'Alpha', new: true, filledShell: true, deleted: ['@n1'] },
    { action: 'Make', owner: null, new: true, deleted: ['@n1'] },
    { action: 'Save', owner: null, new: false, deleted: ['@n3'] }] } }];
  assert.deepEqual(removedOf(results), [{ part: 'logic', action: 'Save', deleted: ['@n3'] }]);
});

// ---- 3. the shape of a refusal ----------------------------------------------------------------------------------------

// A job written by hand: data with a client variable, two new screens, their screen actions (neutral names).
const HAND_JOB = { ops: [
  { op: 'create', parent: '@espace', type: 'IRole', name: 'Reader' },
  { op: 'spec', data: { ddl: '/// Count.\nclient variable Counter: Integer = 0;\n/// Name.\nclient variable Label: Text = "a";\n' } },
  { op: 'html', data: { html: screenDoc('Alpha', ['GoBeta']).replace('</div>', ' {{ Client.Counter }}\n <div class="{{ por menor }}"/>\n</div>') } },
  { op: 'html', data: { html: screenDoc('Beta', ['GoAlpha']) } },
  { op: 'logic', data: { flow: ['action Alpha.GoBeta\n  navigate Beta()\n  end\n', 'action Beta.GoAlpha\n  navigate Alpha()\n'] } },
] };
const HAND_PROBLEMS = [
  ...[2, 4].map(line => ({ phase: 'preflight', op: 1, pointer: '/ops/1/data/ddl', code: 'DDL_SYNTAX', severity: 'error', message: `line ${line}: unknown declaration clause ''`, fix: 'write the statement as ssam_code read (part ddl) reads it' })),
  { phase: 'preflight', op: 4, pointer: '/ops/4/data/flow/0', code: 'FLOW_SYNTAX', severity: 'error', message: 'logic: line 3: unexpected line: end', fix: 'write the line in the ssam-flow/1 grammar' },
  { phase: 'apply', op: 2, pointer: '/ops/2/data/html', code: 'HTML_INVALID', severity: 'error', message: "html: line 5 col 14: class: Invalid Expression | Syntax error caused by unexpected 'por' element", fix: 'write the expression in the OutSystems expression language' },
  { phase: 'apply', op: 2, pointer: '/ops/2/data/html', code: 'HTML_NAME_UNKNOWN', severity: 'error', message: "html: line 4 col 5: {{ }}: no variable, input, aggregate or element of the page or the module is named 'Counter'", fix: 'declare it',
    // The nearest name of the module: wrong here, the job declares Counter.
    patch: [{ op: 'replace', path: '/ops/2/data/html', value: '<screen name="Alpha"/>' }] },
  { phase: 'apply', op: 2, pointer: '/ops/2/data/html', code: 'HTML_NAME_UNKNOWN', severity: 'error', message: "html: line 1 col 1: screen action 'GoBeta' is not declared", fix: 'declare it in a logic op of this job' },
  { phase: 'apply', op: 3, pointer: '/ops/3/data/html', code: 'HTML_NAME_UNKNOWN', severity: 'error', message: "html: line 1 col 1: screen action 'GoAlpha' is not declared", fix: 'declare it in a logic op of this job' },
  { phase: 'apply', op: 3, pointer: '/ops/3/data/html', code: 'HTML_NAME_UNKNOWN', severity: 'error', message: 'html: line 3 col 30: onclick="GoAlpha": no Object is named \'GoAlpha\'', fix: 'fix the element' },
  { phase: 'apply', op: 4, pointer: '/ops/4/data/flow/1', code: 'FLOW_OWNER_UNKNOWN', severity: 'error', message: 'the header names the owner Beta, and the module has no screen, block or email of that name (nearest: Login)', fix: 'name an owner of the module' },
  ...[5, 6, 7].map(op => ({ phase: 'apply', op, pointer: `/ops/${op}`, code: 'APPLY_SKIPPED', severity: 'warning', message: `skipped: it uses Alpha, which failed op #2 would have created`, fix: 'fix op #2; this op runs with it' })),
];

test('refusal: the cascade of a job written by hand is ONE entry; the roots stay, each saying how many it blocks', () => {
  const { problems } = fitProblems(HAND_PROBLEMS, { job: HAND_JOB });
  const codes = problems.map(p => p.code);
  assert.deepEqual(codes, ['DDL_SYNTAX', 'DDL_SYNTAX', 'FLOW_SYNTAX', 'HTML_INVALID', 'APPLY_SKIPPED', 'CASCADE']);
  const cascade = problems.find(p => p.code === 'CASCADE');
  assert.equal(cascade.count, 5);
  assert.deepEqual(cascade.codes, { HTML_NAME_UNKNOWN: 4, FLOW_OWNER_UNKNOWN: 1 });
  // Each failed part (one action text of a logic op is one part) with the names it would have declared.
  const byOp = {};
  for (const b of cascade.because) (byOp[b.op] ??= []).push(...b.names);
  assert.deepEqual(Object.keys(byOp).map(Number).sort(), [1, 3, 4]);
  assert.deepEqual(byOp[1], ['counter']); assert.deepEqual(byOp[4].sort(), ['goalpha', 'gobeta']); assert.deepEqual(byOp[3], ['beta']);
  assert.deepEqual(cascade.because.filter(b => b.op === 4).map(b => b.pointer).sort(), ['/ops/4/data/flow/0', '/ops/4/data/flow/1']);
  assert.match(cascade.message, /listed once here, not repeated/);
  assert.equal(cascade.patchesLeftOut, 1, 'the nearest-name patch of a cascade problem is never offered');
  assert.ok(!problems.some(p => (p.patch ?? []).some(x => x.value === '<screen name="Alpha"/>')));
  // The skipped ops: once, with the op they wait for.
  const skipped = problems.find(p => p.code === 'APPLY_SKIPPED');
  assert.equal(skipped.count, 3); assert.deepEqual(skipped.ops, [5, 6, 7]); assert.deepEqual(skipped.because.map(b => b.op), [2]);
  // blocks on the first root of each failed op: the data blocks 1; the logic op 4 (whose text failed) blocks its two
  // actions named by the screen Beta and, through Beta, the owner Beta of its other text: 4; the screen Alpha 3 (skipped).
  assert.equal(problems.find(p => p.code === 'DDL_SYNTAX').blocks, 1);
  assert.equal(problems.find(p => p.code === 'FLOW_SYNTAX').blocks, 4);
  assert.equal(problems.find(p => p.code === 'HTML_INVALID').blocks, 3);
  // Without the job the names cannot be told apart: only the skipped ops are summarized.
  assert.deepEqual(fitProblems(HAND_PROBLEMS).problems.filter(p => p.code === 'HTML_NAME_UNKNOWN').length, 4);
  // A name no op of the job declares stays a root.
  const own = fitProblems([...HAND_PROBLEMS, { phase: 'apply', op: 3, pointer: '/ops/3/data/html', code: 'HTML_NAME_UNKNOWN', severity: 'error', message: "no Object is named 'Typo'", fix: 'x' }], { job: HAND_JOB });
  assert.ok(own.problems.some(p => p.code === 'HTML_NAME_UNKNOWN' && /Typo/.test(p.message)));
  // Nothing left as a root: nothing summarized.
  const only = HAND_PROBLEMS.filter(p => p.code === 'HTML_NAME_UNKNOWN' || p.code === 'FLOW_OWNER_UNKNOWN');
  assert.equal(fitProblems(only, { job: HAND_JOB }).problems.length, only.length);
});

test('refusal: a group of one text says its pointer once and the lines its members name', () => {
  const many = Array.from({ length: 41 }, (_, i) => ({ phase: 'preflight', op: 1, pointer: '/ops/1/data/ddl', code: 'DDL_SYNTAX', severity: 'error',
    message: `line ${2 * i + 2}: unknown declaration clause ''`, fix: 'write the statement as ssam_code read (part ddl) reads it' }));
  const { problems, grouped } = fitProblems(many, { budget: 3000 });
  assert.equal(grouped, true);
  const group = problems.find(p => p.count === 41);
  assert.deepEqual(group.pointers, ['/ops/1/data/ddl']);
  assert.equal(group.lines.length, 41); assert.equal(group.lines[0], '2'); assert.equal(group.lines.at(-1), '82');
});

test('refusal: o11_deliver and studio_deliver relay the cascade summarized over the job they ran', async t => {
  const dir = tmp(t);
  const jobFile = path.join(dir, 'hand.json'); fs.writeFileSync(jobFile, JSON.stringify(HAND_JOB));
  // O11: the CLI's single refusal (PREFLIGHT_REFUSED with problems) of the delivery.
  const o11 = deliverOutcome({ envelope: { ok: false, code: 'PREFLIGHT_REFUSED', error: 'every phase', problems: HAND_PROBLEMS, verifyRan: true } }, { trackId: 't', work: dir, job: jobFile });
  assert.equal(o11.code, 'PREFLIGHT_REFUSED');
  assert.ok(o11.problems.some(p => p.code === 'CASCADE' && p.count === 5), JSON.stringify(o11.problems.map(p => p.code)));
  assert.ok(!o11.problems.some(p => p.code === 'HTML_NAME_UNKNOWN'));
  // ODC: the apply over the capture refuses with every phase (kernel-delivery.mjs).
  const root = path.join(dir, 'odc'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify(HAND_JOB));
  const result = await deliverKernel({ module: 'App', feature: 'hand', job: 'job.json', owners: ['Alpha'], changes: ['screens'] }, { root, nextLabDir: () => path.join(root, 'attempt'),
    journal: () => {}, cache: null, guide: null, prefetch: () => {},
    studio: async ([step]) => (step === 'snapshot' ? { ok: true, path: path.join(root, 'base.oml'), sha256: 'HASH', host: 'fixture.test' } : { ok: true }),
    apply: async () => ({ ok: false, code: 'PREFLIGHT_REFUSED', problems: HAND_PROBLEMS, verifyRan: true, phases: ['preflight', 'apply'], error: 'every phase' }),
    prepareManifest: async () => ({ ok: true, manifest: path.join(root, 'm.json') }) });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some(p => p.code === 'CASCADE' && p.count === 5), JSON.stringify(result.problems.map(p => p.code)));
  // refusalFields without a job (a refusal that ran none) is as before.
  assert.equal(refusalFields(HAND_PROBLEMS, {}).problems.filter(p => p.code === 'HTML_NAME_UNKNOWN').length, 4);
});
