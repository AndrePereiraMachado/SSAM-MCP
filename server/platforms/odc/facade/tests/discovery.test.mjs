import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { applicationContext, applyBudget, bindingsOf, buildIndex, classifyExecutions, closure, discover, identityKey, jobLevel, laneSources, levelOf, nativeCacheKey, normalize, parseDiscoverArguments, parseExpand, query, signatureOf, tokens, validateDescriptor, DEFAULT_BUDGET_BYTES, DISCOVERY_SCHEMA, INDEX_SCHEMA } from '../discovery.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { root as odcRoot } from '../lib.mjs';

// The engine is measured over the base catalog: the fronts' fragments (catalog/fragments) are left out here, since the
// catalog tests compose them (request C-004: base assertions must not depend on what a front delivered).
const BASE_ONLY = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-base-only-'));
const sources = { ...laneSources('odc'), fragments: BASE_ONLY };
const cliBuilt = fs.existsSync(sources.cli);
const fixture = sources.fixture;
const LEVELS = ['B', 'route', 'C-suite', 'C-executed-historical', 'C-executed-current'];

// ---- pure: text handling and argument parsing never touch the kernel
test('tokens are accent-insensitive, stemmed and free of stopwords', () => {
  assert.equal(normalize('Formulário Pesquisável'), 'formulario pesquisavel');
  assert.deepEqual(tokens('Criar um formulário com dropdown pesquisável, carregar dados e salvar'), ['formulario', 'dropdown', 'pesquisavel', 'carregar', 'dado', 'salvar']);
  assert.deepEqual(tokens('the actions were renamed'), ['action', 'were', 'renam']);
});

test('discover arguments: words become the intent, options are validated, the budget is bytes, expand is a spec', () => {
  const parsed = parseDiscoverArguments(['form', 'with', 'dropdown', '--lane', 'odc', '--limit', '3', '--app', 'x.oml']);
  assert.deepEqual(parsed, { lane: 'odc', intent: 'form with dropdown', app: 'x.oml', detail: null, expand: null, type: null, limit: 3, rebuild: false, budgetBytes: DEFAULT_BUDGET_BYTES });
  assert.equal(parseDiscoverArguments(['x', '--budget', '8192']).budgetBytes, 8192);
  assert.equal(parseDiscoverArguments(['--expand', 'ui.list:example+bindings,contract:logic.steps.get']).expand, 'ui.list:example+bindings,contract:logic.steps.get');
  assert.throws(() => parseDiscoverArguments(['--lane', 'ss4']), /Unknown lane/);
  assert.throws(() => parseDiscoverArguments(['x', '--limit', '0']), /--limit/);
  assert.throws(() => parseDiscoverArguments(['x', '--budget', '100']), /--budget/);
  assert.throws(() => parseDiscoverArguments(['x', '--nope']), /Unknown discover option/);
});

test('the index key and the native probe key name the Studio folder: a copy with the same names, sizes and times is another key', () => {
  const when = new Date('2026-09-01T00:00:00Z');
  const studio = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-studio-'));
    for (const name of ['OutSystems.Model.dll', 'ODCStudio.exe', 'ODCStudio.deps.json']) { const file = path.join(dir, name); fs.writeFileSync(file, name); fs.utimesSync(file, when, when); }
    return dir;
  };
  const installed = studio(), copy = studio(), descriptor = Buffer.from('{}'), at = dir => ({ ...sources, studioDir: dir });
  try {
    assert.notEqual(identityKey(at(installed), descriptor), identityKey(at(copy), descriptor), 'an index built on the installation is never reused for the copy');
    assert.notEqual(nativeCacheKey(at(installed)), nativeCacheKey(at(copy)), 'nor its native probes');
    // The same folder, however it is spelled, is the same key.
    const spelled = (process.platform === 'win32' ? installed.toUpperCase() : installed) + path.sep;
    assert.equal(identityKey(at(spelled), descriptor), identityKey(at(installed), descriptor));
    assert.equal(nativeCacheKey(at(spelled)), nativeCacheKey(at(installed)));
  } finally { for (const dir of [installed, copy]) fs.rmSync(dir, { recursive: true, force: true }); }
});

test('expand specs name capabilities with parts, raw contract pointers, elements and native types; unknown parts are refused by name', () => {
  const { requests, problems } = parseExpand('ui.list:example+bindings, logic.aggregate, contract:logic.steps.get, element:MobileBlockSignature:DropdownSearch, native:IDropdown, ui.form:all');
  assert.deepEqual(problems, []);
  assert.deepEqual(requests, [
    { kind: 'capability', id: 'ui.list', parts: ['example', 'bindings'] },
    { kind: 'capability', id: 'logic.aggregate', parts: ['contract', 'example', 'evidence', 'bindings'] },
    { kind: 'contract', pointer: 'logic.steps.get' },
    { kind: 'element', selector: 'MobileBlockSignature:DropdownSearch' },
    { kind: 'native', type: 'IDropdown' },
    { kind: 'capability', id: 'ui.form', parts: ['contract', 'example', 'evidence', 'bindings'] },
  ]);
  const bad = parseExpand('ui.list:examples');
  assert.deepEqual(bad.requests, []); assert.match(bad.problems[0], /unknown part\(s\) examples; parts: contract, example, evidence, bindings, native, operations, all/);
});

// ---- the descriptor is a projection: every pointer resolves or the index refuses to build
test('descriptor validation refuses pointers, jobs, dependencies and recommendations that do not resolve', () => {
  const contracts = { spec: { shapes: { entity: ['name'] } }, verbs: { verbs: { create: { required: ['parent'] } } } };
  const jobs = [{ name: 'data-entity' }]; const negatives = [{ name: 'delete-data-in-use' }];
  const good = { schemaVersion: 'ssam-discovery-capabilities/1', lane: 'odc', capabilities: [
    { id: 'a', category: 'data', title: 't', keywords: ['k'], summary: 's', route: { kind: 'job' }, contract: ['spec.shapes.entity', 'verbs.verbs.create'], proofs: { odc: ['data-entity'] }, negative: { odc: ['delete-data-in-use'] }, depends: [{ id: 'b', unless: 'b already exists' }], recommends: [{ id: 'b', when: 'always' }], alternatives: [] },
    { id: 'b', category: 'ui', title: 't', keywords: ['k'], summary: 's', route: { kind: 'job' }, contract: [], proofs: { odc: [] }, depends: ['a'], alternatives: [] }] };
  assert.deepEqual(validateDescriptor(good, { contracts, jobs, negatives }), []);
  const bad = structuredClone(good);
  bad.capabilities[0].contract.push('spec.shapes.nope'); bad.capabilities[0].proofs.odc.push('missing-job'); bad.capabilities[0].depends.push('ghost');
  bad.capabilities[0].recommends.push('phantom'); bad.capabilities[1].depends.push({ unless: 'no id' });
  const problems = validateDescriptor(bad, { contracts, jobs, negatives });
  for (const expected of ['spec.shapes.nope', 'missing-job', 'ghost', 'phantom', 'malformed dependency']) assert.ok(problems.some(p => p.includes(expected)), expected + ' not reported: ' + problems.join('\n'));
});

// ---- dependency closure: transitive, deduplicated, cycle-aware, deterministic, conditional
test('closure follows dependencies transitively, once, in a deterministic order, and reports cycles and unknown ids', () => {
  const caps = [
    { id: 'ui.form', depends: [{ id: 'ui.screen', unless: 'the screen exists' }, 'data.entity', 'logic.action'] },
    { id: 'ui.screen', depends: ['ui.flow'] },
    { id: 'ui.flow', depends: [] },
    { id: 'logic.action', depends: ['data.entity'] },
    { id: 'data.entity', depends: [] },
    { id: 'ui.list', depends: ['ui.screen', 'data.entity'] },
    { id: 'x.a', depends: ['x.b'] }, { id: 'x.b', depends: ['x.c'] }, { id: 'x.c', depends: ['x.a', 'ghost'] },
  ];
  const seed = id => ({ c: caps.find(c => c.id === id), score: 1, why: [], via: 'match' });
  const one = closure(caps, [seed('ui.form'), seed('ui.list')]);
  assert.deepEqual([...one.chosen.keys()].sort(), ['data.entity', 'logic.action', 'ui.flow', 'ui.form', 'ui.list', 'ui.screen']);
  const before = (a, b) => assert.ok(one.order.indexOf(a) < one.order.indexOf(b), a + ' must precede ' + b + ' in ' + one.order.join(' > '));
  before('ui.flow', 'ui.screen'); before('ui.screen', 'ui.form'); before('ui.screen', 'ui.list'); before('data.entity', 'logic.action'); before('logic.action', 'ui.form');
  assert.deepEqual(one.order, ['data.entity', 'logic.action', 'ui.flow', 'ui.screen', 'ui.form', 'ui.list'], 'ready nodes in alphabetical order');
  assert.deepEqual(one.cycles, []); assert.deepEqual(one.invalid, []);
  assert.deepEqual(closure(caps, [seed('ui.list'), seed('ui.form')]).order, one.order);
  const screen = one.chosen.get('ui.screen');
  assert.deepEqual(screen.requiredBy.sort(), ['ui.form', 'ui.list']);
  assert.deepEqual(screen.conditions, [{ requiredBy: 'ui.form', unless: 'the screen exists' }]);
  const cyc = closure(caps, [seed('x.b')]);
  assert.deepEqual(cyc.cycles, [['x.a', 'x.b', 'x.c', 'x.a']]);
  assert.deepEqual(cyc.invalid, [{ from: 'x.c', to: 'ghost' }]);
});

// ---- provenance: a result is current only when every component is known on both sides and equal
const HASH = { fixture: 'f'.repeat(64), kernel: 'k'.repeat(64), model: 'm'.repeat(64), base: 'b'.repeat(64) };
function stamped(name, overrides = {}) {
  return { name, sha256: 'j' + name, base: overrides.base ?? 'tests/fixtures/odc/x.oml', executed: { accepted: true, provenance: { schema: 'anvil-job-provenance/2', jobSha256: 'j' + name, fixtureSha256: HASH.fixture, kernelSha256: HASH.kernel, ideVersion: '1.7.25', base: overrides.base ?? 'tests/fixtures/odc/x.oml', baseKind: overrides.baseKind ?? 'fixture', baseSha256: overrides.baseSha256 ?? HASH.fixture, nativeAssemblies: { 'OutSystems.Model.dll': HASH.model }, ...overrides.stamp } } };
}
const currentIdentity = (overrides = {}) => ({ ideVersion: '1.7.25', fixtureSha256: HASH.fixture, kernelSha256: HASH.kernel, assemblyHash: name => (name === 'OutSystems.Model.dll' ? HASH.model : null), baseHash: spec => (spec === 'tests/fixtures/odc/x.oml' ? HASH.fixture : null), ...overrides });

test('execution classification: current only with a complete, matching stamp; every gap or difference keeps it historical with the reason', () => {
  const ok = classifyExecutions([stamped('a')], currentIdentity())[0];
  assert.equal(ok.executed.current, true); assert.deepEqual(ok.executed.mismatches, []); assert.equal(jobLevel(ok), 'C-executed-current');
  const reason = (jobs, current, re) => { const j = classifyExecutions(jobs, current); assert.equal(j[0].executed.current, false, JSON.stringify(j[0].executed.mismatches)); assert.ok(j[0].executed.mismatches.some(m => re.test(m)), j[0].executed.mismatches.join(' | ')); return j; };
  reason([{ name: 'u', sha256: 'x', executed: { accepted: true, provenance: null } }], currentIdentity(), /unstamped/);
  reason([stamped('a', { stamp: { nativeAssemblies: undefined } })], currentIdentity(), /nativeAssemblies: absent/);
  reason([stamped('a')], currentIdentity({ ideVersion: null }), /ideVersion: current value undetermined/);
  reason([stamped('a')], currentIdentity({ assemblyHash: null }), /current Studio directory undetermined/);
  reason([stamped('a')], currentIdentity({ assemblyHash: () => 'z'.repeat(64) }), /OutSystems\.Model\.dll differs/);
  reason([stamped('a', { stamp: { nativeAssemblies: { 'OutSystems.Model.dll': HASH.model, 'Extra.dll': HASH.model } } })], currentIdentity(), /Extra\.dll not found/);
  reason([stamped('a', { stamp: { kernelSha256: 'k'.repeat(63) + '0' } })], currentIdentity(), /kernelSha256: result/);
  reason([stamped('a', { stamp: { jobSha256: undefined } })], currentIdentity(), /jobSha256: absent/);
  // The same job text with the other line endings (a checkout with another autocrlf): current, and said; any other
  // text stays historical.
  const eol = classifyExecutions([{ ...stamped('a', { stamp: { jobSha256: 'jlf' } }), sha256: 'jcrlf', sha256Eol: ['jlf'] }], currentIdentity())[0];
  assert.equal(eol.executed.current, true, JSON.stringify(eol.executed.mismatches)); assert.match(eol.executed.jobIdentity, /modulo line endings/);
  reason([{ ...stamped('a', { stamp: { jobSha256: 'jother' } }), sha256: 'jcrlf', sha256Eol: ['jlf'] }], currentIdentity(), /jobSha256: result jother vs current jcrlf/);
  reason([stamped('a', { baseSha256: 'c'.repeat(64) })], currentIdentity(), /baseSha256: the fixture the job declares changed/);
  reason([stamped('a', { stamp: { base: 'tests/fixtures/odc/other.oml' } })], currentIdentity(), /base: stamped/);
  reason([stamped('a', { stamp: { baseKind: undefined, base: undefined } })], currentIdentity(), /base: absent from the stamp/);
  const rejected = stamped('a'); rejected.executed.accepted = false;
  reason([rejected], currentIdentity(), /not accepted/);
  // A job whose base is another job is current only when that job's own result is current; a missing or stale base job blocks it.
  const chain = classifyExecutions([stamped('root'), stamped('child', { base: 'job:root', baseKind: 'job', baseSha256: null })], currentIdentity());
  assert.equal(chain.find(j => j.name === 'child').executed.current, true);
  const stale = classifyExecutions([stamped('root', { stamp: { ideVersion: '1.0' } }), stamped('child', { base: 'job:root', baseKind: 'job', baseSha256: null })], currentIdentity());
  assert.match(stale.find(j => j.name === 'child').executed.mismatches[0], /base job 'root' is not current \(ideVersion/);
  const orphan = classifyExecutions([stamped('child', { base: 'job:missing', baseKind: 'job', baseSha256: null })], currentIdentity());
  assert.match(orphan[0].executed.mismatches[0], /base job 'missing' not in the suite/);
  const loop = classifyExecutions([stamped('p', { base: 'job:q', baseKind: 'job', baseSha256: null }), stamped('q', { base: 'job:p', baseKind: 'job', baseSha256: null })], currentIdentity());
  assert.ok(loop.every(j => j.executed.current === false && j.executed.mismatches.some(m => /cycle|not current/.test(m))));
  const index = { lane: 'odc', jobs: [ok, { name: 'c', executed: null }, { name: 'h', executed: { current: false, mismatches: ['x'] } }] };
  assert.equal(levelOf(index, { proofs: { odc: ['h', 'c'] } }), 'C-executed-historical');
  assert.equal(levelOf(index, { proofs: { odc: ['c'] } }), 'C-suite');
  assert.equal(levelOf(index, { proofs: { odc: ['c', 'a'] } }), 'C-executed-current');
  assert.equal(levelOf(index, { proofs: { odc: [] }, route: { kind: 'job' } }), 'B');
});

// ---- bindings: the proven "how X connects to Y" of a job, with alias types resolved
test('bindings are extracted from set/link/args ops with the created type of every alias and ranked element-to-element first', () => {
  const ops = [
    { op: 'create', parent: 'IMobileFlow:MainFlow', type: 'IMobileScreen', name: 'Tasks', as: '$scr' },
    { op: 'set', target: '$scr/#IMobileBlockInstanceWidget', prop: 'SourceBlock', value: 'IMobileBlock:LayoutTopMenu' },
    { op: 'create', parent: '$scr', type: 'IScreenAggregate', name: 'GetTasks', as: '$agg' },
    { op: 'create', parent: '$agg', type: 'IAliasedSource', args: { dataSource: 'IServerEntity:Task' } },
    { op: 'create', parent: '$scr/#IMobileBlockInstanceWidget/MainContent', type: 'IList', name: 'L', as: '$list' },
    { op: 'set', target: '$list', prop: 'Source', value: 'GetTasks.List' },
    { op: 'create', parent: '$list', type: 'IListItem', name: 'I', as: '$item' },
    { op: 'set', target: '$item/OnClick', prop: 'Destination', value: 'IMobileScreen:TaskDetail' },
    { op: 'set', target: '$item/OnClick/TaskId', prop: 'Value', value: 'GetTasks.List.Current.Task.Id' },
    { op: 'set', target: '$item/Content/#IExpression', prop: 'Value', value: 'GetTasks.List.Current.Task.Title' },
    { op: 'link', from: '$start', to: '$end' },
  ];
  const b = bindingsOf(ops);
  assert.deepEqual(b.map(x => x.rule), [
    'set <IMobileScreen>/#IMobileBlockInstanceWidget SourceBlock = IMobileBlock:<name>',
    'create IAliasedSource args.dataSource = IServerEntity:<name>',
    'set <IList> Source = <Aggregate>.List',
    'set <IListItem>/OnClick Destination = IMobileScreen:<name>',
    'set <IListItem>/OnClick/<argument> Value = <Aggregate>.List.Current.<Entity>.<attr>',
    'link $start -> $end',
  ]);
  assert.deepEqual(b.map(x => x.rank), [0, 2, 0, 0, 1, 2]);
  assert.deepEqual(b[3].example, { op: 'set', target: '$item/OnClick', prop: 'Destination', value: 'IMobileScreen:TaskDetail' });
  assert.equal(b[3].op, 7);
  // The element at each end of a set binding: the `#IType` child a path selects, an alias type, an `IType:` reference,
  // the event a path ends in (the OnClick of the item, not the item); an expression names none.
  assert.deepEqual(b[0].ends, [{ type: 'IMobileBlockInstanceWidget' }, { type: 'IMobileBlock' }]);
  assert.deepEqual(b[2].ends, [{ type: 'IList' }, null]);
  assert.deepEqual(b[3].ends, [{ event: 'OnClick' }, { type: 'IMobileScreen' }]);
});

// ---- request A-005: a synthetic lane index (no CLI) for the selection and binding rules of query()
const laneIndex = ({ capabilities, synonyms = {}, jobs = [], unavailable = [] }) => ({ lane: 'odc', synonyms, jobs, unavailable, negatives: [], contracts: {}, routes: {}, nativeRuntime: {},
  capabilities: capabilities.map(c => ({ category: 'x', summary: '', route: { kind: 'job' }, proofs: { odc: [] }, depends: [], alternatives: [], ...c })) });
const directIds = q => q.matches.filter(m => m.via === 'match').map(m => m.id).sort();

test('bindings between element roles of the direct matches come first, one per pair of roles, carry the pair and survive the budget cut to six (request A-005)', () => {
  // Seven element-to-element rules between types no direct match declares come first in the job; the rules that wire
  // the matched roles (an OnClick to a screen action, twice; an extended event handler to it) come after them.
  const ops = [
    ...[0, 1, 2, 3, 4, 5, 6].map(i => ({ op: 'set', target: 'IMobileScreen:S' + i, prop: 'Theme', value: 'ITheme:Main' })),
    { op: 'create', parent: 'IMobileScreen:S0', type: 'ILink', name: 'Open', as: '$lnk' },
    { op: 'create', parent: 'IMobileScreen:S0', type: 'IButton', name: 'Save', as: '$btn' },
    { op: 'create', parent: 'IMobileScreen:S0', type: 'IScreenAction', name: 'SaveOnClick', as: '$act' },
    { op: 'create', parent: 'IMobileScreen:S0', type: 'IEvent', name: 'onkeyup', as: '$evt' },
    { op: 'set', target: '$lnk/OnClick', prop: 'Destination', value: '$act' },
    { op: 'set', target: '$btn/OnClick', prop: 'Destination', value: '$act' },
    { op: 'set', target: '$evt', prop: 'Handler', value: '$act' },
  ];
  const index = laneIndex({ synonyms: { event: ['evento', 'onclick'] }, jobs: [{ name: 'j', description: '', notes: [], opCount: ops.length, bindings: bindingsOf(ops), executed: null }],
    capabilities: [
      { id: 'ui.event', title: 'Events', keywords: ['onclick'], proofs: { odc: ['j'] }, elements: [{ role: 'widget event', native: 'X.Events.IBuiltinEvent', jobType: '(born with the widget)', address: '<widget path>/OnClick' }] },
      { id: 'logic.screen-action', title: 'Screen logic', keywords: ['screen action'], proofs: { odc: ['j'] }, elements: [{ role: 'screen action', native: 'X.IScreenAction', jobType: 'IScreenAction' }] },
      { id: 'logic.app-event', title: 'Application events', keywords: ['extended event'], proofs: { odc: ['j'] }, elements: [{ role: 'extended event', native: 'X.Events.IEvent', jobType: 'IEvent' }] }] });
  const q = query(index, { intent: 'evento onclick de um botao e um extended event ligados a uma screen action' });
  assert.deepEqual(directIds(q), ['logic.app-event', 'logic.screen-action', 'ui.event']);
  const onClick = ['ui.event/widget event', 'logic.screen-action/screen action']; const handler = ['logic.app-event/extended event', 'logic.screen-action/screen action'];
  // The first rule of each pair (with the pair), then the second rule of a pair (without), then the rules that connect
  // no matched roles.
  assert.deepEqual(q.bindings.slice(0, 3).map(b => [b.rule, b.between]), [
    ['set <ILink>/OnClick Destination = <IScreenAction>', onClick], ['set <IEvent> Handler = <IScreenAction>', handler], ['set <IButton>/OnClick Destination = <IScreenAction>', undefined]]);
  assert.ok(q.bindings.slice(3).every(b => !b.between && b.rank === 0 && /Theme/.test(b.rule)), 'rules whose ends are not roles of direct matches carry no pair');
  assert.equal(q.bindings.length, 10);
  // Under a budget that needs the cut to six, the rules between the matched roles are the ones kept. The pair goes with
  // the cut: the entries kept cost what they cost before request A-005 (rule, for, job, op, level).
  const answer = { ok: true, matches: q.matches, contracts: {}, examples: {}, bindings: q.bindings, bindingsTotal: q.bindingsTotal };
  const reduced = applyBudget(structuredClone(answer), Buffer.byteLength(JSON.stringify(answer), 'utf8') - 200);
  const sections = reduced.size.truncated.map(t => t.section);
  assert.ok(sections.includes('bindings') && !sections.includes('bindings.all'), sections.join(','));
  assert.equal(reduced.bindings.length, 6); assert.equal(reduced.bindingsOmitted, 4);
  assert.deepEqual(reduced.bindings.slice(0, 3).map(b => b.rule), q.bindings.slice(0, 3).map(b => b.rule));
  assert.ok(reduced.bindings.every(b => Object.keys(b).join() === 'rule,for,job,op,level'), JSON.stringify(reduced.bindings[0]));
  // Six rules or fewer: the stage takes only the pairs, and declares it (the largest budget that needs a reduction).
  const lean = bindings => ({ ok: true, matches: q.matches.map(m => ({ id: m.id, via: m.via })), bindings, bindingsTotal: bindings.length });
  const few = lean(q.bindings.slice(0, 3));
  let stripped; for (let budget = applyBudget(structuredClone(few), 1e9).size.bytes; !(stripped = applyBudget(structuredClone(few), budget)).size.truncated.length; budget--);
  assert.deepEqual(stripped.size.truncated.map(t => t.section), ['bindings']);
  assert.deepEqual(stripped.bindings.map(b => [b.rule, b.between, b.example]), few.bindings.map(b => [b.rule, undefined, b.example]));
  // The protection holds up to 'bindings.all', which drops every binding (these rules too) before the examples and the
  // contracts go whole; the reduction is declared with the continuation that returns them.
  const small = applyBudget(structuredClone(lean(q.bindings)), 700);
  const all = small.size.truncated.find(t => t.section === 'bindings.all');
  assert.ok(small.size.status === 'reduced' && all && small.bindings.length === 0 && small.bindingsOmitted === 10, JSON.stringify(small.size));
  assert.equal(all.recover, 'continuation.omitted[].expand (bindings)');
});

test('the pairs of roles go by relevance: the pair the intent names first, then two capabilities, then one; a role two matches share is the one named (request A-005)', () => {
  const role = (name, type) => ({ role: name, native: 'X.' + type, jobType: type });
  const ops = [
    ...['IAlpha', 'IOmega', 'IBeta', 'IGamma', 'IDelta', 'IEpsilon', 'IZeta', 'IPsi'].map(t => ({ op: 'create', parent: 'IMobileScreen:S', type: t, name: t.slice(1), as: '$' + t.slice(1).toLowerCase() })),
    // Seven pairs of roles the intent does not name first in the proof (six across two capabilities, one inside one),
    // then the pair it names.
    ...[['$beta', '$delta'], ['$beta', '$epsilon'], ['$gamma', '$delta'], ['$gamma', '$epsilon'], ['$beta', '$gamma'], ['$gamma', '$zeta'], ['$delta', '$psi']].map(([target, value]) => ({ op: 'set', target, prop: 'Destination', value })),
    { op: 'set', target: '$alpha', prop: 'Destination', value: '$omega' },
  ];
  const index = laneIndex({ jobs: [{ name: 'j', description: '', notes: [], opCount: ops.length, bindings: bindingsOf(ops), executed: null }],
    capabilities: [
      { id: 'x.a', title: 'A', keywords: ['alpha'], shared: true, proofs: { odc: ['j'] }, elements: [role('alpha', 'IAlpha'), role('beta', 'IBeta'), role('gamma', 'IGamma')] },
      // x.b also has the type of omega: the end resolves to the role the intent names (x.c), not to the first match.
      { id: 'x.b', title: 'B', keywords: ['kappa'], shared: true, proofs: { odc: ['j'] }, elements: [role('delta', 'IDelta'), role('epsilon', 'IEpsilon'), role('zeta', 'IZeta'), role('omega copy', 'IOmega')] },
      { id: 'x.c', title: 'C', keywords: ['omega'], shared: true, proofs: { odc: ['j'] }, elements: [role('omega', 'IOmega'), role('psi', 'IPsi')] }] });
  const q = query(index, { intent: 'alpha bound to omega in the kappa' });
  assert.deepEqual(directIds(q), ['x.a', 'x.b', 'x.c']);
  assert.deepEqual(q.bindings.map(b => b.between?.join(' > ')), ['x.a/alpha > x.c/omega', 'x.a/beta > x.b/delta', 'x.a/beta > x.b/epsilon', 'x.a/gamma > x.b/delta',
    'x.a/gamma > x.b/epsilon', 'x.a/gamma > x.b/zeta', 'x.b/delta > x.c/psi', 'x.a/beta > x.a/gamma']);
  const answer = { ok: true, matches: q.matches.map(m => ({ id: m.id, via: m.via })), bindings: q.bindings, bindingsTotal: q.bindingsTotal };
  const reduced = applyBudget(structuredClone(answer), Buffer.byteLength(JSON.stringify(answer), 'utf8') - 100);
  assert.equal(reduced.bindings[0].rule, 'set <IAlpha> Destination = <IOmega>', 'the named pair survives the cut to six');
});

test('multi-word keywords are read in the intent word order, each word standing for itself or its own canonical; never across the canonicals of distant words or across token boundaries (request A-005)', () => {
  const index = laneIndex({ synonyms: { screen: ['tela', 'ui'], action: ['acao', 'fluxo'], aggregate: ['agregado'], filter: ['filtro'], 'input parameter': ['parametro de entrada'], delete: ['apagar'], record: ['registo'] },
    capabilities: [{ id: 'x.screen-action', title: 'Handlers', keywords: ['screen action'] }, { id: 'x.aggregate', title: 'Queries', keywords: ['aggregate filter'] },
      { id: 'x.flow', title: 'Wiring', keywords: ['action flow'] }, { id: 'x.parameter', title: 'Signatures', keywords: ['input parameter'] }, { id: 'x.rows', title: 'Rows', keywords: ['delete record'] },
      { id: 'x.pages', title: 'Pages', keywords: ['delete screen'] }],
    unavailable: [{ id: 'u.screen-action', keywords: ['screen action'], reason: 'r' }] });
  // "fluxo" -> action and "ui" -> screen: in the intent "fluxo" comes first and nothing joins them; only the list of
  // canonicals puts "screen action" together. ("fluxo de UI" is a genitive and would say it through this mapping: the
  // legacy ODC descriptor no longer maps fluxo to action.)
  const flow = query(index, { intent: 'um comentario no fluxo e na UI' });
  assert.ok(flow.terms.includes('screen') && flow.terms.includes('action'), JSON.stringify(flow.terms));
  assert.deepEqual(directIds(flow), []); assert.deepEqual(flow.unavailable, []);
  const english = query(index, { intent: 'create a screen action' });
  assert.deepEqual(directIds(english), ['x.screen-action']); assert.deepEqual(english.unavailable.map(u => u.id), ['u.screen-action']);
  // Adjacent words, each read as its own canonical; a multi-word canonical is a phrase of its own.
  assert.deepEqual(directIds(query(index, { intent: 'agregado com filtro por status' })), ['x.aggregate']);
  assert.deepEqual(directIds(query(index, { intent: 'adicionar um parametro de entrada' })), ['x.parameter']);
  // A genitive says the compound the other way round ("filtro do agregado" is an aggregate filter); without one the
  // order of the words is the order of the keyword.
  assert.deepEqual(directIds(query(index, { intent: 'filtro do agregado' })), ['x.aggregate']);
  assert.deepEqual(directIds(query(index, { intent: 'filtro com agregado' })), []);
  // An operation canonical says its keyword ("apagar a tela"), except before a generic child word: "apagar o registo"
  // (of a static entity) is not the "delete record" of another capability; the words said literally are.
  assert.deepEqual(directIds(query(index, { intent: 'apagar a tela de clientes' })), ['x.pages']);
  assert.deepEqual(directIds(query(index, { intent: 'apagar o registo antigo' })), []);
  assert.deepEqual(directIds(query(index, { intent: 'delete the record' })), ['x.rows']);
  // Whole tokens: "serveraction flow" does not hold "action flow".
  assert.deepEqual(directIds(query(index, { intent: 'serveraction flow' })), []);
});

test('phrases compare words through the spellings the stemmer leaves apart: a keyword in the plural or with -ed/-ing is said by the singular (request A-005)', () => {
  // tokens: "references" -> "referenc", "reference" -> "reference"; "attributes" -> "attribut"; "settings" -> "setting"
  // but "setting" -> "sett"; "outdated" -> "outdat". The substring match used to join them at the end of a phrase.
  const index = laneIndex({ synonyms: { 'refresh references': ['redirect references'] },
    capabilities: [{ id: 'x.refresh', title: '-', keywords: ['refresh references', 'outdated references'] }, { id: 'x.move', title: '-', keywords: ['reorder attributes'] },
      { id: 'x.roles', title: '-', keywords: ['role settings'] }] });
  const ids = intent => directIds(query(index, { intent }));
  assert.deepEqual(ids('refresh the reference to the producer'), ['x.refresh']);
  assert.deepEqual(ids('update the outdated reference'), ['x.refresh']);
  assert.deepEqual(ids('reorder attribute of the entity'), ['x.move']);
  assert.deepEqual(ids('change the role setting'), ['x.roles']);
  const form = query(index, { intent: 'redirect reference to the new action' });
  assert.ok(form.terms.includes('refresh referenc'), 'a multi-word synonym form is matched through the same fold: ' + JSON.stringify(form.terms));
});

test('a word stands in for a canonical only through a variant that is the word itself and when it is not the keyword of another capability; a genitive reads backwards (request A-005)', () => {
  const index = laneIndex({ synonyms: { event: ['evento', 'handler', 'on click', 'on change'], block: ['bloco', 'widget'], list: ['lista'], record: ['registo'], api: ['apis'], action: ['acao', 'server action'], flow: ['fluxo'], rename: ['mudar o nome'], client: ['acao de cliente'], variable: ['variavel'], screen: ['ui'] },
    // Titles without words, so only the keywords select.
    capabilities: [['x.widget', ['widget']], ['x.click', ['click']], ['x.instance', ['event handler', 'layout block']], ['x.block', ['block event']], ['x.list', ['record list']],
      ['x.portal', ['list api']], ['x.flow', ['action flow']], ['x.rename', ['rename action']], ['x.settings', ['client variable']], ['x.handlers', ['screen action']]].map(([id, keywords]) => ({ id, title: '-', keywords })) });
  const ids = intent => directIds(query(index, { intent }));
  // "click" and "widget" are keywords of other capabilities; "change" reaches event only through "on change".
  assert.deepEqual(ids('add an on click handler to the button'), ['x.click']);
  assert.deepEqual(ids('change handler'), []);
  assert.deepEqual(ids('evento handler'), ['x.instance']);
  assert.deepEqual(ids('handle the widget event'), ['x.widget']);
  assert.deepEqual(ids('adicionar um layout widget na tela'), ['x.widget']);
  assert.deepEqual(ids('evento do bloco'), ['x.block']);
  // Backwards across a genitive, from the unit before it and the first or last word after it.
  assert.deepEqual(ids('mostrar a lista de registos'), ['x.list']);
  assert.deepEqual(ids('fluxo da server action'), ['x.flow']);
  assert.deepEqual(ids('o fluxo da acao de servidor na ui'), ['x.flow'], 'the run after a connector ends at the next dropped word ("na")');
  // Forward across a genitive only after an operation: "lista de APIs" is not "list APIs"; "mudar o nome" is one unit.
  assert.deepEqual(ids('lista de APIs consumidas'), []);
  assert.deepEqual(ids('mudar o nome da acao'), ['x.rename']);
  // Never through a multi-word form after the connector: the variable of a client action is not a client variable.
  assert.deepEqual(ids('variavel da acao de cliente'), []);
});

test('a word consumed by a multi-word form counts again when the intent says it outside the form, or when another word outside every form produced its canonical (request A-005)', () => {
  const index = laneIndex({ synonyms: { preparation: ['screen preparation'], screen: ['tela'] },
    capabilities: [{ id: 'x.screen', title: 'Pages', keywords: ['screen'] }, { id: 'x.preparation', title: 'Preparations', keywords: ['preparation'] }] });
  const ids = intent => directIds(query(index, { intent }));
  assert.deepEqual(ids('screen preparation'), ['x.preparation'], 'inside the form, "screen" names the preparation');
  assert.deepEqual(ids('screen preparation da tela de clientes'), ['x.preparation', 'x.screen']);
  assert.deepEqual(ids('screen preparation of the customer screen'), ['x.preparation', 'x.screen']);
});

// ---- request A-006: anchored keywords ({form, with?, without?}) count only in the context of the element they name
test('an anchored keyword counts only when the intent also says one of its with-terms and none of its without-terms; alone it never matches (request A-006)', () => {
  const index = laneIndex({ synonyms: { type: ['tipo'], action: ['acao'] },
    // Titles without words, so only the keywords select.
    capabilities: [
      { id: 'x.variable', title: '-', keywords: [{ form: 'variables', with: ['type', 'reset'] }] },
      { id: 'x.variavel', title: '-', keywords: [{ form: 'variaveis', with: ['tipo', 'zerar'] }] },
      { id: 'x.branch', title: '-', keywords: [{ form: 'false branch', with: ['if'], without: ['widget', 'decision'] }] },
      { id: 'x.delete', title: '-', keywords: [{ form: 'delete the unused action', without: ['toolbar'] }] },
      { id: 'x.plain', title: '-', keywords: ['environment variables'] }] });
  const ids = intent => directIds(query(index, { intent }));
  const scoreOf = (intent, id) => query(index, { intent }).matches.find(m => m.id === id)?.score ?? 0;
  // with: one anchor is enough, in any position of the intent; "types" and "type" meet through fold.
  assert.deepEqual(ids('reset the variables of the action'), ['x.variable']);
  assert.deepEqual(ids('variables of several types'), ['x.variable']);
  // Absent anchor: the form alone neither selects nor scores (it is not even an alternative).
  assert.deepEqual(ids('the monitoring dashboard plots the variables of the agent'), []);
  assert.equal(scoreOf('the monitoring dashboard plots the variables of the agent', 'x.variable'), 0);
  // A term is read as a keyword is: the anchor "tipo" is said by "tipos"; the anchor "type", a synonym canonical, is said
  // by every variant of its group ("tipos"); a variant ("tipo") is never said by its canonical ("types"): the front
  // writes both spellings when it wants both.
  assert.deepEqual(ids('zerar as variaveis de varios tipos'), ['x.variavel']);
  assert.deepEqual(ids('variables of several tipos'), ['x.variable']);
  assert.deepEqual(ids('variables and variaveis of several types'), ['x.variable']);
  // without: one exclusion word cancels the keyword even when a with-term is said; both together.
  assert.deepEqual(ids('call it in the false branch of the If'), ['x.branch']);
  assert.deepEqual(ids('show the false branch of the If widget'), []);
  assert.deepEqual(ids('the false branch of the If decision'), []);
  assert.deepEqual(ids('the false branch of the decision'), []);
  // without only: counts unless an exclusion word is said.
  assert.deepEqual(ids('delete the unused action after checking the impact'), ['x.delete']);
  assert.deepEqual(ids('delete the unused action button from the toolbar'), []);
  // The plain keyword keeps today's meaning.
  assert.deepEqual(ids('reiniciar as environment variables do container'), ['x.plain']);
  // why names the form, then in brackets what the intent said for the with-term (its word as tokenized, or the
  // canonical its variant produced); that word is covered, not unmatched.
  const q = query(index, { intent: 'reset the variables of the action' });
  assert.deepEqual(q.matches.find(m => m.id === 'x.variable').why, ['variabl [reset]']);
  assert.ok(!q.unmatched.includes('reset') && !q.unmatched.includes('variabl'), JSON.stringify(q.unmatched));
  const typed = query(index, { intent: 'the variables of several types' });
  assert.deepEqual(typed.matches.find(m => m.id === 'x.variable').why, ['variabl [typ]'], 'the intent word "types", not the term "type"');
  assert.deepEqual(typed.unmatched, ['several']);
  const canonical = query(index, { intent: 'the variables of several tipos' });
  assert.deepEqual(canonical.matches.find(m => m.id === 'x.variable').why, ['variabl [type]'], 'the canonical the variant produced');
  assert.deepEqual(canonical.unmatched, ['several'], '"tipos" is covered through its canonical');
  assert.deepEqual(query(index, { intent: 'delete the unused action' }).matches.find(m => m.id === 'x.delete').why, ['delete unu action']);
});

test('an anchor term is said by its own word or, when it is a canonical, by its group; never by a sibling variant, whatever the lane groups; a derived term only by a derived word (request A-006, C-010)', () => {
  const capabilities = [
    // One-word variants as terms: "api" (of rest) and "database" (of entity on one lane only).
    { id: 'x.logic', title: '-', keywords: [{ form: 'zzlogic', without: ['api', 'database', 'botao'] }] },
    // A canonical as a term: every variant of its group on the lane says it.
    { id: 'x.rest', title: '-', keywords: [{ form: 'zzrest', with: ['rest'] }] },
    // Derived and plain words that stem alike ("publicacao"/"publica", "configuracao"/"configura").
    { id: 'x.publish', title: '-', keywords: [{ form: 'zzpub', with: ['publicacao'] }] },
    { id: 'x.adjective', title: '-', keywords: [{ form: 'zzadj', with: ['publica'] }] },
    { id: 'x.config', title: '-', keywords: [{ form: 'zzcfg', without: ['configuracao'] }] }];
  const lanes = {
    odc: laneIndex({ capabilities, synonyms: { rest: ['api', 'json', 'endpoint'], entity: ['entidade', 'database'], navigate: ['navegar', 'botao'], publish: ['publicacao', 'publicar'] } }),
    o11: laneIndex({ capabilities, synonyms: { rest: ['api', 'json'], entity: ['entidade'], navigate: ['navegar'], publish: ['publicar'] } }) };
  for (const [lane, index] of Object.entries(lanes)) {
    const ids = intent => directIds(query(index, { intent }));
    // A sibling variant ("json" beside "api", "entidade" beside "database", "navegar" beside "botao") does not say the
    // term, on either lane; the word itself does.
    assert.deepEqual(ids('zzlogic que devolve json'), ['x.logic'], lane);
    assert.deepEqual(ids('zzlogic que le a entidade'), ['x.logic'], lane);
    assert.deepEqual(ids('zzlogic e navegar para a tela'), ['x.logic'], lane);
    assert.deepEqual(ids('zzlogic da api'), [], lane);
    assert.deepEqual(ids('zzlogic do database'), [], lane);
    assert.deepEqual(ids('zzlogic do botao'), [], lane);
    // The canonical is said by its group, as a one-word keyword is ("json" -> rest).
    assert.deepEqual(ids('zzrest que devolve json'), ['x.rest'], lane);
    assert.deepEqual(query(index, { intent: 'zzrest que devolve json' }).matches.find(m => m.id === 'x.rest').why, ['zzrest [rest]'], lane);
    // A derived term is said only by a derived word; a plain term never through the group of a derived variant.
    assert.deepEqual(ids('zzpub na api publica'), [], lane);
    assert.deepEqual(ids('zzpub com a publicacao'), ['x.publish'], lane);
    assert.deepEqual(ids('zzadj depois de publicar o app'), [], lane);
    assert.deepEqual(ids('zzadj na api publica'), ['x.adjective'], lane);
    assert.deepEqual(ids('zzcfg que configura e reinicia'), ['x.config'], lane);
    assert.deepEqual(ids('zzcfg da configuracao'), [], lane);
  }
});

test('an anchored one-word form claims its word only where its context holds; out of it, it credits neither the keyword nor the title or summary word (request A-006)', () => {
  const index = laneIndex({ synonyms: { block: ['bloco', 'widget'], event: ['evento'] },
    capabilities: [
      // Plain "block event" is read through "widget" (a variant of block) unless "widget" names another capability.
      { id: 'x.block', title: '-', keywords: ['block event'] },
      { id: 'x.widget', title: '-', keywords: [{ form: 'widget', with: ['screen'] }] },
      // A generic word of the title, anchored in the keywords; and one of the summary.
      { id: 'x.debugger', title: 'Headless debugger: breakpoints, variables, stepping', keywords: ['zzdebug', { form: 'variables', with: ['debugger', 'breakpoint'] }] },
      { id: 'x.summary', title: '-', summary: 'the variables', keywords: ['zzsum', { form: 'variables', with: ['debugger'] }] },
      { id: 'x.site', title: 'Variables of the site', keywords: ['zzsite'] },
      // The word is muted only alone: inside a keyword of the capability that counted, the summary word still counts.
      { id: 'x.prep', title: '-', summary: 'the preparation', keywords: ['screen preparation', { form: 'preparation', without: ['pwa'] }] }] });
  const ids = intent => directIds(query(index, { intent }));
  // Out of its context the anchored "widget" claims nothing: "widget" stands for block. In its context it claims the
  // word as the plain keyword would.
  assert.deepEqual(ids('handle the widget event'), ['x.block']);
  assert.deepEqual(ids('handle the widget event on the screen'), ['x.widget']);
  // The title word "variables" does not select x.debugger out of the anchor's context; a plain title still does.
  assert.deepEqual(ids('reset the variables of the action'), ['x.site']);
  assert.ok(ids('reset the variables at the breakpoint').includes('x.debugger'));
  const score = (intent, id) => query(index, { intent }).matches.find(m => m.id === id)?.score ?? 0;
  assert.equal(score('zzsum reset the variables', 'x.summary'), 3, 'the summary word is muted too (zzsum only)');
  assert.equal(score('zzsum reset the variables of the debugger', 'x.summary'), 6, 'in context the anchored keyword counts (+3)');
  assert.equal(score('the preparation for the pwa build', 'x.prep'), 0, 'alone and out of context: no keyword, no summary word');
  assert.equal(score('the screen preparation for the pwa build', 'x.prep'), 5, '"screen preparation" counted (+4): the summary word is not alone (+1)');
  assert.equal(score('the preparation before the load', 'x.prep'), 3, 'in context (no pwa): the anchored keyword (+3); its summary word is the same word, counted once');
});

test('an anchored one-word form that names an operation (the operation word or a one-word variant of its group) is an operation hit and names no family, in either language (request A-006)', () => {
  const index = laneIndex({ synonyms: { delete: ['excluir', 'apagar'] },
    capabilities: [
      { id: 'x.flow', title: '-', keywords: ['if node', { form: 'excluir', with: ['if'] }, { form: 'delete', with: ['if'] }], elements: [{ role: 'if node' }] },
      { id: 'x.widget', title: '-', keywords: ['widget'], elements: [{ role: 'widget' }] }] });
  for (const intent of ['excluir o if do widget', 'delete the if of the widget', 'excluir o if', 'delete the if']) {
    const q = query(index, { intent });
    assert.ok(!directIds(q).includes('x.flow'), intent);
    assert.match(q.matches.find(m => m.id === 'x.flow')?.reason ?? '', /operation words only/, intent);
  }
  assert.ok(directIds(query(index, { intent: 'excluir o if node' })).includes('x.flow'), 'the element word still selects it');
});

test('anchored keywords and their anchors read the intent in word order (says), in capabilities and unavailable entries (request A-006)', () => {
  const index = laneIndex({
    capabilities: [
      // A multi-word form is said in word order; a multi-word anchor too ("server action", also backwards across a
      // genitive: "action of the server").
      { id: 'x.branch', title: '-', keywords: [{ form: 'true branch', with: ['if'] }] },
      { id: 'x.call', title: '-', keywords: [{ form: 'call', with: ['server action'] }] }],
    unavailable: [{ id: 'u.preparation', keywords: [{ form: 'screen preparation', without: ['pwa'] }], reason: 'r' }] });
  const ids = intent => directIds(query(index, { intent }));
  assert.deepEqual(ids('call it in the true branch of the If'), ['x.branch']);
  assert.deepEqual(ids('the branch that is true in the If'), [], 'the form is not said: its words are not in order');
  assert.deepEqual(ids('call the server action'), ['x.call']);
  assert.deepEqual(ids('call the action of the server'), ['x.call']);
  assert.deepEqual(ids('the server calls an action'), [], 'the anchor is not said: "server" and "action" are not one unit');
  // Unavailable entries take the same keyword forms.
  assert.deepEqual(query(index, { intent: 'create the screen preparation' }).unavailable.map(u => u.id), ['u.preparation']);
  assert.deepEqual(query(index, { intent: 'screen preparation for the pwa build' }).unavailable, []);
  // A multi-word term never stands for the canonical of the group it is a variant of: that canonical is broader ("variaveis
  // de cliente" and "variaveis de tipos diferentes" both produce "variable"), so the exclusion is said only as itself.
  const groups = laneIndex({ synonyms: { variable: ['variaveis de cliente', 'variaveis de tipos diferentes'] },
    capabilities: [{ id: 'x.typed', title: '-', keywords: [{ form: 'variaveis', with: ['tipo'], without: ['variaveis de cliente'] }] }] });
  const both = query(groups, { intent: 'zerar variaveis de varios tipos e variaveis de tipos diferentes' });
  assert.ok(both.terms.includes('variable'), 'the canonical of the exclusion group is among the terms');
  assert.deepEqual(directIds(both), ['x.typed']);
  assert.deepEqual(directIds(query(groups, { intent: 'as variaveis de cliente de varios tipos' })), []);
});

test('an anchored keyword that counts names the family of its own capability: the plural said in context is not demoted as a generic word, and names no other family (request A-006)', () => {
  // Three families: the intent names x.action by its role words; "variaveis" is a keyword of the other two, anchored in
  // x.var and plain in x.plain. Neither role word ("variable") is said: the plural stems to "variavei".
  const index = laneIndex({ capabilities: [
    { id: 'x.action', title: '-', keywords: ['server action'], elements: [{ role: 'server action' }] },
    { id: 'x.var', title: '-', keywords: [{ form: 'variaveis', with: ['tipo'] }], elements: [{ role: 'local variable' }] },
    { id: 'x.plain', title: '-', keywords: ['variaveis'], elements: [{ role: 'client variable' }] }] });
  const q = query(index, { intent: 'uma server action que zera variaveis de varios tipos' });
  assert.deepEqual(directIds(q), ['x.action', 'x.var']);
  assert.match(q.matches.find(m => m.id === 'x.plain').reason, /named through a generic element word only/);
  // Without its anchor the anchored keyword does not count, so it names nothing and x.var is not even scored.
  const bare = query(index, { intent: 'uma server action que zera variaveis' });
  assert.deepEqual(directIds(bare), ['x.action']); assert.ok(!bare.matches.some(m => m.id === 'x.var'));
});

test('descriptor validation refuses malformed anchored keywords, naming the capability and the rule (request A-006)', () => {
  const base = { schemaVersion: 'ssam-discovery-capabilities/1', lane: 'odc', capabilities: [], unavailable: [] };
  const cap = keywords => ({ id: 'x', category: 'data', title: 't', keywords, summary: 's', route: { kind: 'job' }, contract: [], proofs: { odc: [] }, depends: [], alternatives: [] });
  const check = (keywords, unavailable = []) => validateDescriptor({ ...base, capabilities: [cap(keywords)], unavailable }, { contracts: {}, jobs: [], negatives: [] });
  assert.deepEqual(check(['plain', { form: 'false branch', with: ['if', 'if node'], without: ['widget'] }, { form: 'delete the unused action', without: ['toolbar'] }]), []);
  const text = check([{ with: ['if'] }, { form: ' ', with: ['if'] }, { form: 'the', with: ['if'] }, { form: 'branch' }, { form: 'branch', with: [] },
    { form: 'branch', with: ['if', ''] }, { form: 'branch', with: 'if' }, { form: 'branch', without: [7] }, { form: 'branch', with: ['of the'] }, { form: 'branch', with: ['if'], near: ['x'] }, 42, ''],
  [{ id: 'u', keywords: [{ form: 'preparation', with: [] }], reason: 'r' }]).join('\n');
  for (const expected of [/x: anchored keyword without a form: \{"with":\["if"\]\}/, /x: anchored keyword without a form: \{"form":" "/, /x: anchored keyword "the": the form keeps no word after tokenization/,
    /x: anchored keyword "branch" has neither with nor without \(write it as a plain string\)/, /x: anchored keyword "branch": with must be a non-empty list of terms/,
    /x: anchored keyword "branch": empty or non-string with term ""/, /x: anchored keyword "branch": empty or non-string without term 7/,
    /x: anchored keyword "branch": with term "of the" keeps no word after tokenization/, /x: anchored keyword "branch": unknown field\(s\) near/,
    /x: keyword 42 is neither a string nor an anchored form/, /x: empty keyword/, /u: anchored keyword "preparation": with must be a non-empty list of terms/]) assert.match(text, expected);
  // Entries that can never count, and a null side (not a list).
  const never = check([{ form: 'excluir a action', without: ['action'] }, { form: 'call the server action', with: ['if'], without: ['Server Actions'] }, { form: 'branch', with: ['if', 'x1'], without: ['IF'] },
    { form: 'branch', with: null, without: ['x1'] }, { form: 'server action', without: ['action server'] }]).join('\n');
  for (const expected of [/x: anchored keyword "excluir a action": without term "action" is said by the form itself, so the keyword never counts/,
    /x: anchored keyword "call the server action": without term "Server Actions" is said by the form itself/, /x: anchored keyword "branch": term "IF" is in both with and without/,
    /x: anchored keyword "branch": with must be a non-empty list of terms/]) assert.match(never, expected);
  assert.doesNotMatch(never, /"server action"/, 'a term whose words are in another order is not said by the form');
  // Synonym variants are non-empty strings; an anchored form belongs in keywords.
  const synonyms = validateDescriptor({ ...base, capabilities: [cap(['plain'])], synonyms: { variable: [{ form: 'variaveis', with: ['tipo'] }, '', 'variaveis tipadas'], other: 'x' } }, { contracts: {}, jobs: [], negatives: [] }).join('\n');
  assert.match(synonyms, /synonyms\.variable: variant \{"form":"variaveis","with":\["tipo"\]\} is not a non-empty string \(a form in context goes in a capability's keywords as an anchored keyword/);
  assert.match(synonyms, /synonyms\.variable: variant "" is not a non-empty string/);
  assert.match(synonyms, /synonyms\.other is not a list/);
});

// ---- application context with a scripted reader (unchanged behaviour from round 2, kept as regression)
const SHA = 'AB'.repeat(32);
const blockTree = (name, key) => ({ kind: 'MobileBlockSignature', name, key, reference: '@' + key, path: 'Reference:OutSystemsUI/MobileFlowSignature:Interaction/MobileBlockSignature:' + name,
  properties: { Description: 'Enhanced ' + name + ' block.', Name: name }, propertyErrors: {}, childrenTotal: 3, childrenOmitted: 0, children: [
    { kind: 'InputParameterSignature', name: 'OptionsList', properties: { DataType: 'ListType:DropdownOption List', IsMandatory: 'True', Description: 'List of options to show.' }, children: [] },
    { kind: 'InputParameterSignature', name: 'Prompt', properties: { DataType: 'BasicType:Text', IsMandatory: 'False', DefaultValue: '"Select"' }, children: [] },
    { kind: 'BlockEventSignature', name: 'OnChanged', properties: { IsMandatory: 'True' }, children: [
      { kind: 'InputParameterSignature', name: 'SelectedOptionList', properties: { DataType: 'ListType:DropdownOption List', IsMandatory: 'True' } }] }] });
function scriptedReader(script = {}) {
  const calls = [];
  const kindReads = {
    MobileBlockSignature: { count: 3, entries: [{ name: 'DropdownSearch', kind: 'MobileBlockSignature', reference: '@k1' }, { name: 'Search', kind: 'MobileBlockSignature', reference: '@k2' }, { name: 'Accordion', kind: 'MobileBlockSignature', reference: '@k3' }] },
    MobileScreen: { count: 30, entries: [{ name: 'Home', kind: 'MobileScreen', reference: '@s1' }, { name: 'QuoteForm', kind: 'MobileScreen', reference: '@s2' }], omitted: 28, nextOffset: 2 },
    ServerEntity: { count: 0, entries: [], kindObserved: true },
    Widget: { count: 0, entries: [], kindObserved: false, notices: ['No instance of the requested kind was observed in this scope.'] },
  };
  const inspect = async request => {
    calls.push(request);
    if (script.changeFrom != null && calls.length > script.changeFrom && request.expectedSourceSha256) return { ok: false, file: request.target, error: 'Snapshot content changed: expectedSourceSha256 does not match the source bytes' };
    if (request.kind) {
      if (script.failKind === request.kind) return { ok: false, file: request.target, error: 'Read process closed without a complete response' };
      const r = kindReads[request.kind] ?? { count: 0, entries: [], kindObserved: false, notices: ['not observed'] };
      return { ok: true, file: request.target, sourceSha256: SHA, kindObserved: true, searchComplete: true, returned: r.entries.length, omitted: 0, nextOffset: null, ...r, cache: { modelHit: true, generation: 'g' } };
    }
    if (request.text) return { ok: true, file: request.target, sourceSha256: SHA, count: 1, returned: 1, omitted: 0, kindObserved: true, searchComplete: true, entries: [{ name: 'DropdownSearch', kind: 'MobileBlockSignature', reference: '@k1' }] };
    if (request.select) {
      const entries = request.select.map(sel => sel === '@k1' ? { selector: sel, ok: true, data: { tree: blockTree('DropdownSearch', 'k1') } } : sel === '@k2' ? { selector: sel, ok: true, data: { tree: blockTree('Search', 'k2') } } : { selector: sel, ok: false, error: 'Path not found: ' + sel });
      return { ok: true, file: request.target, sourceSha256: SHA, schema: 'ssam-reading-batch/1', requested: entries.length, complete: entries.every(e => e.ok), entries };
    }
    if (request.path) return { ok: true, file: request.target, sourceSha256: SHA, tree: blockTree('DropdownSearch', 'k1') };
    return { ok: false, error: 'unexpected request' };
  };
  return { inspect, calls };
}
const matchesFor = ids => ids.map(id => ({ id, via: 'match', why: ['dropdown search'], context: { kinds: ['MobileBlockSignature', 'MobileScreen', 'ServerEntity'], signatures: ['MobileBlockSignature'] } }));
const terms = ['dropdown', 'pesquisavel', 'search', 'form'];

test('signatures are read from the tree: inputs, mandatory, defaults, events with parameters, references for jobs', () => {
  const s = signatureOf(blockTree('DropdownSearch', 'k1'));
  assert.equal(s.role, 'referenced definition');
  assert.equal(s.jobReference, 'IMobileBlockSignature:DropdownSearch');
  assert.equal(s.instanceSource, 'IMobileBlock:DropdownSearch');
  assert.deepEqual(s.inputs.map(i => [i.name, i.type, i.typeKind, i.mandatory]), [['OptionsList', 'DropdownOption List', 'ListType', true], ['Prompt', 'Text', 'BasicType', false]]);
  assert.deepEqual(s.events, [{ name: 'OnChanged', mandatory: true, parameters: [{ name: 'SelectedOptionList', type: 'DropdownOption List', typeKind: 'ListType', mandatory: true }] }]);
});

test('application context: reads are classified, a changed capture voids everything, a failing read keeps its cause', async () => {
  const { inspect, calls } = scriptedReader();
  const matches = matchesFor(['ui.dropdown-search']); matches[0].context.kinds.push('Widget');
  const c = await applicationContext({ lane: 'odc' }, sources, { app: 'x.oml', matches, terms, inspect });
  assert.equal(c.status, 'partial');
  const byKind = Object.fromEntries(c.reads.map(r => [r.kind, r]));
  assert.equal(byKind.MobileScreen.status, 'partial'); assert.deepEqual(byKind.MobileScreen.continuation, { kind: 'MobileScreen', max: 16, offset: 2, properties: 'Name' });
  // One reader call per item: the lane's tool with the file and the hash guard, plus the item's own arguments.
  assert.deepEqual({ tool: c.continuation.tool, arguments: c.continuation.arguments }, { tool: 'studio_inspect', arguments: { target: 'x.oml', expectedSourceSha256: SHA } });
  const o11 = await applicationContext({ lane: 'o11' }, laneSources('o11'), { app: 'x.oml', matches, terms, inspect: scriptedReader().inspect });
  assert.deepEqual(o11.continuation.arguments, { oml: 'x.oml', expectedSourceSha256: SHA }); assert.equal(o11.continuation.tool, 'o11_inspect');
  assert.ok(c.signatures.every(s => s.continuation && typeof s.continuation === 'object' && s.continuation.path?.startsWith('@')), JSON.stringify(c.signatures.map(s => s.continuation)));
  assert.doesNotMatch(JSON.stringify(c), /--kind|--depth|--text|\.\\odc|\.\\ssam/);
  assert.equal(byKind.ServerEntity.status, 'empty'); assert.equal(byKind.Widget.status, 'unknown-kind');
  assert.ok(calls.slice(1).every(r => r.expectedSourceSha256 === SHA));
  assert.deepEqual(c.signatures.map(s => s.name), ['DropdownSearch', 'Search', 'QuoteForm', 'Accordion']);
  assert.deepEqual(c.signatures.map(s => s.status ?? 'ok'), ['ok', 'ok', 'failed', 'failed']);
  const changed = await applicationContext({ lane: 'odc' }, sources, { app: 'x.oml', matches: matchesFor(['ui.dropdown-search']), terms, inspect: scriptedReader({ changeFrom: 2 }).inspect });
  assert.equal(changed.ok, false); assert.equal(changed.code, 'CAPTURE_CHANGED'); assert.deepEqual(changed.reads, []);
  const failed = await applicationContext({ lane: 'odc' }, sources, { app: 'x.oml', matches: matchesFor(['ui.form']), terms, inspect: scriptedReader({ failKind: 'MobileScreen' }).inspect });
  assert.equal(failed.status, 'partial-with-failures');
  assert.deepEqual(failed.problems, [{ read: 'kind:MobileScreen', error: 'Read process closed without a complete response' }]);
});

// The kind reads of --app come from the module map (ssam-map/1 entries become {kind, name, reference}); text and
// select reads stay on the reader; a map that cannot answer falls back to the reader; a changed capture still voids all.
function scriptedMap(script = {}) {
  const calls = [];
  const rows = { MobileBlockSignature: [['k1', 'DropdownSearch'], ['k2', 'Search'], ['k3', 'Accordion']], MobileScreen: [['s1', 'Home'], ['s2', 'QuoteForm']], ServerEntity: [] };
  const map = async request => {
    calls.push(request);
    if (script.fail) return { ok: false, error: 'The odc reader answered without a module index' };
    if (script.changed && request.expectedSourceSha256) return { ok: false, error: 'Snapshot content changed: expectedSourceSha256 does not match the source bytes' };
    const found = rows[request.kind];
    const entries = (found ?? []).map(([key, name]) => ({ key, kind: request.kind, name, role: 'other', parentKey: null, path: request.kind + ':' + name, childrenTotal: 0 }));
    return { ok: true, schema: 'ssam-map/1', answeredBy: 'module-index', file: 'x.oml', sourceSha256: SHA, count: entries.length, returned: entries.length, omitted: 0,
      truncated: false, nextOffset: null, kindObserved: found != null, searchComplete: true, entries, cache: { index: 'hit' } };
  };
  return { map, calls };
}
test('application context: kind reads come from the module map, text and signatures from the reader', async () => {
  const reader = scriptedReader(); const index = scriptedMap();
  const c = await applicationContext({ lane: 'odc' }, sources, { app: 'x.oml', matches: matchesFor(['ui.dropdown-search']), terms, inspect: reader.inspect, map: index.map });
  assert.equal(c.ok, true);
  assert.deepEqual(index.calls.map(r => r.kind), ['MobileBlockSignature', 'MobileScreen', 'ServerEntity']);
  assert.ok(index.calls.slice(1).every(r => r.expectedSourceSha256 === SHA && r.target === 'x.oml'));
  assert.ok(reader.calls.every(r => !r.kind), 'no kind read reaches the reader');
  assert.ok(reader.calls.some(r => r.text) && reader.calls.some(r => r.select));
  const byKind = Object.fromEntries(c.reads.map(r => [r.kind, r]));
  assert.deepEqual(byKind.MobileBlockSignature.elements, [{ name: 'DropdownSearch', reference: '@k1' }, { name: 'Search', reference: '@k2' }, { name: 'Accordion', reference: '@k3' }]);
  assert.equal(byKind.ServerEntity.status, 'empty');
  assert.deepEqual(c.signatures.map(s => s.name).slice(0, 2), ['DropdownSearch', 'Search']);
  assert.deepEqual(c.cache, { answeredBy: 'module-index', index: 'hit' });
  const fallback = scriptedReader();
  const viaReader = await applicationContext({ lane: 'odc' }, sources, { app: 'x.oml', matches: matchesFor(['ui.dropdown-search']), terms, inspect: fallback.inspect, map: scriptedMap({ fail: true }).map });
  assert.equal(viaReader.ok, true); assert.ok(fallback.calls.some(r => r.kind === 'MobileScreen'), 'the reader answers when the map cannot');
  const changed = await applicationContext({ lane: 'odc' }, sources, { app: 'x.oml', matches: matchesFor(['ui.dropdown-search']), terms, inspect: scriptedReader().inspect, map: scriptedMap({ changed: true }).map });
  assert.equal(changed.ok, false); assert.equal(changed.code, 'CAPTURE_CHANGED');
});

// ---- budget: UTF-8 bytes, fixed reduction order, every reduction declared with the exact expansion that returns it
test('the budget reduces sections in a fixed order, declares each reduction with its expansion, and never removes contracts before examples', () => {
  const big = () => ({ matches: [{ id: 'a', via: 'match', contract: ['verbs.verbs.create'], summary: 'ação '.repeat(80), limits: [{ text: 'x' }, { text: 'y' }], notes: [{ text: 'n'.repeat(500) }] }, { id: 'b', via: 'dependency' }],
    contracts: { 'verbs.verbs.create': { required: ['parent'], optional: ['x'.repeat(400)] } }, relatedJobs: [{ job: 'j'.repeat(300) }],
    examples: { a: { job: 'j', ops: Array.from({ length: 8 }, (_, i) => ({ op: 'set', target: '$x' + i, prop: 'P', value: 'v'.repeat(60) })), opsTotal: 20, fragment: true } },
    bindings: Array.from({ length: 12 }, (_, i) => ({ rule: 'rule ' + i + ' ' + 'r'.repeat(40), for: 'a', job: 'j', op: i, level: 'C-suite', example: { op: 'set', target: '$t', prop: 'P', value: 'v'.repeat(50) } })),
    context: { reads: [{ kind: 'K', elements: Array.from({ length: 16 }, (_, i) => ({ name: 'E' + i, reference: '@' + i })) }], signatures: [1, 2, 3, 4, 5].map(i => ({ name: 'S' + i, reference: '@s' + i, continuation: 'c' + i, inputs: [{ name: 'x'.repeat(100) }] })), reuse: [{ term: 't', elements: Array.from({ length: 12 }, (_, i) => ({ name: 'R' + i })) }], omittedSignatures: [] } });
  const untouched = applyBudget(big(), 1048576);
  assert.equal(untouched.size.bytes, Buffer.byteLength(JSON.stringify(untouched), 'utf8'));
  assert.ok(untouched.size.bytes > JSON.stringify(untouched).length, 'multibyte characters count as bytes, not characters');
  assert.deepEqual(untouched.size.truncated, []); assert.equal(untouched.size.status, 'within');
  // Stages in order (phase 3): derived text, context, lower tiers, the parts of a direct match the intent did not ask
  // for (bindings, examples, contracts, limits, summary), then their removal, then the envelope and the minimal match.
  const ORDER = ['matches.notes', 'relatedJobs', 'evidenceRule', 'identity', 'notes', 'context.reuse', 'context.elements', 'context.signatures', 'matches.alternatives', 'matches.dependencies', 'bindings', 'matches.operations', 'examples', 'matches.limits', 'contracts', 'matches.summary', 'bindings.all', 'examples.all', 'contracts.all', 'expansions', 'matches.alternatives.drop', 'matches.operations.focused', 'envelope', 'matches.direct.minimal'];
  const reduced = applyBudget(big(), 3200);
  const sections = reduced.size.truncated.map(t => t.section);
  assert.deepEqual(sections, ORDER.filter(s => sections.includes(s)), 'fixed order: ' + sections.join(','));
  for (const s of ['matches.notes', 'relatedJobs', 'context.reuse', 'context.elements', 'context.signatures', 'bindings', 'examples', 'matches.limits', 'contracts', 'matches.summary']) assert.ok(sections.includes(s), s + ' reduced');
  assert.ok(!sections.includes('matches.dependencies'), 'a dependency that is already minimal is not reported as reduced');
  assert.equal(reduced.size.status, 'reduced'); assert.ok(reduced.size.bytes <= 3200, 'bytes: ' + reduced.size.bytes);
  assert.equal(reduced.size.truncated.find(t => t.section === 'bindings').recover, 'expand a:bindings');
  assert.equal(reduced.size.truncated.find(t => t.section === 'contracts').recover, 'expand contract:verbs.verbs.create');
  assert.ok(reduced.size.truncated.every(t => !/--[a-z]/.test(t.recover)), 'recoveries name ssam_discover arguments, not CLI flags');
  assert.equal(reduced.examples.a.ops.length, sections.includes('examples.all') ? 0 : 3); assert.equal(reduced.examples.a.expand, 'a:example');
  assert.equal(reduced.bindings.length, sections.includes('bindings.all') ? 0 : 6); assert.equal(reduced.bindingsOmitted, sections.includes('bindings.all') ? 12 : 6);
  assert.deepEqual(reduced.contracts['verbs.verbs.create'].expand, 'contract:verbs.verbs.create');
  assert.equal(reduced.matches.find(m => m.id === 'b').expand, 'b:contract+example+evidence', 'a dependency keeps its id and the expansion that opens it');
  // The budget is a hard limit: when even the minimal answer does not fit, the result says so instead of overflowing.
  const insufficient = applyBudget(big(), 1500);
  assert.equal(insufficient.size.status, 'insufficient'); assert.ok(insufficient.size.bytes <= 1500, 'bytes: ' + insufficient.size.bytes);
  assert.ok(insufficient.size.minimalBytes > 1500); assert.match(insufficient.size.note, /insufficient budget: (the minimal answer needs|minimal) \d+ bytes/);
  assert.ok(!insufficient.hint || /raise budgetBytes/.test(insufficient.hint));
  assert.deepEqual(insufficient.matches.map(m => m.id), ['a']); assert.equal(insufficient.matches[0].expand, 'a:contract+example+evidence+operations+native+bindings');
  assert.deepEqual(insufficient.contracts, {}); assert.deepEqual(insufficient.examples, {}); assert.deepEqual(insufficient.bindings, []);
  assert.ok((insufficient.size.truncated?.length ?? insufficient.size.truncatedStages) >= 11, 'every stage was tried first: ' + JSON.stringify(insufficient.size));
  // Above the API minimum the explicit result keeps its stage list, identity and continuation.
  const roomy = applyBudget({ ...big(), identity: { lane: 'odc', index: 'k', kernel: 'h', studio: { ideVersion: '1.7' } }, matches: [{ id: 'a', via: 'match', contract: ['verbs.verbs.create'], summary: 'ação '.repeat(400), limits: [], notes: [] }] }, 2600);
  if (roomy.size.status === 'insufficient') { assert.ok(roomy.size.bytes <= 2600); assert.ok(Array.isArray(roomy.size.truncated) && roomy.identity && roomy.continuation, JSON.stringify(roomy.size)); }
  const partial = applyBudget(big(), 6000);
  assert.ok(partial.size.bytes <= 6000);
  const order = partial.size.truncated.map(t => t.section);
  assert.ok(!order.includes('contracts') || order.indexOf('examples') < order.indexOf('contracts'), 'examples go before contracts: ' + order.join(','));
});

test('the budget is measured on the answer as returned: at every budget it is within the budget and size.bytes is its real size (request A-005)', () => {
  // The answer used to be measured with size.bytes 0 and the status 'within', then got its byte count and 'reduced'
  // written in: 1 to 5 bytes above the budget just below the size of every stage (12004 bytes at 12000).
  const answer = () => ({ ok: true, matches: [{ id: 'a', via: 'match', summary: 'ação '.repeat(60), limits: [{ text: 'x' }, { text: 'y' }], notes: [{ text: 'n'.repeat(300) }] }],
    relatedJobs: [{ job: 'j'.repeat(200) }], examples: { a: { job: 'j', ops: Array.from({ length: 6 }, (_, i) => ({ op: 'set', target: '$x' + i, value: 'v'.repeat(40) })), opsTotal: 9 } },
    bindings: Array.from({ length: 8 }, (_, i) => ({ rule: 'rule ' + i + ' ' + 'r'.repeat(30), for: 'a', job: 'j', op: i, level: 'C-suite', example: { value: 'v'.repeat(40) } })), continuation: { omitted: [] } });
  const whole = applyBudget(answer(), 1e9).size.bytes;
  const wrong = [];
  for (let budget = 1000; budget <= whole + 8; budget++) {
    const r = applyBudget(answer(), budget); const real = Buffer.byteLength(JSON.stringify(r), 'utf8');
    if (real > budget || r.size.bytes !== real) wrong.push(`${budget}: ${real} bytes (says ${r.size.bytes}, ${r.size.status})`);
  }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} budgets answered above the budget or misreported`);
});

// ---- the real index over the ODC lane sources (needs the built anvil-odc CLI)
test('the ODC index is built from the kernel CLI and the job suite, classifies results strictly, and is reused by identity', { skip: !cliBuilt && 'anvil-odc CLI not built', timeout: 120000 }, async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-discovery-'));
  const isolated = { ...sources, cacheDir };
  try {
    const first = await buildIndex('odc', { sources: isolated, rebuild: true });
    const index = first.index;
    assert.equal(index.schemaVersion, INDEX_SCHEMA);
    for (const op of ['agent', 'verbs', 'spec', 'logic', 'screen', 'html', 'html-visual', 'rest', 'rest-expose', 'soap']) assert.ok(index.contracts[op] && !index.contracts[op].error, op);
    assert.deepEqual(Object.keys(index.contracts.verbs.verbs).sort(), ['agent', 'create', 'delete', 'dump', 'duplicate', 'find', 'get', 'html', 'layout', 'link', 'logic', 'move', 'reference', 'rename', 'replace', 'rest', 'rest-expose', 'screen', 'set', 'soap', 'spec', 'usages']);
    assert.ok(index.jobs.length >= 67, 'jobs: ' + index.jobs.length);
    assert.ok(index.jobs.every(j => typeof j.description === 'string' && j.opCount > 0 && /^[0-9a-f]{64}$/.test(j.sha256) && Array.isArray(j.bindings)));
    for (const j of index.jobs.filter(j => j.executed)) {
      assert.equal(typeof j.executed.current, 'boolean', j.name);
      assert.equal(j.executed.current, j.executed.mismatches.length === 0, j.name + ': ' + j.executed.mismatches.join(' | '));
      if (j.executed.current) { const p = j.executed.provenance; assert.ok(p.nativeAssemblies && Object.keys(p.nativeAssemblies).length > 0 && p.baseKind, j.name + ' current without a complete stamp'); }
    }
    assert.equal(index.identity.jobs.results, index.jobs.filter(j => j.executed).length);
    assert.equal(index.identity.jobs.current + index.identity.jobs.historical, index.identity.jobs.results);
    assert.match(index.identity.cli.sha256, /^[0-9a-f]{16}$/); assert.match(index.identity.cli.kernelSha256, /^[0-9a-f]{16}$/);
    assert.equal(index.identity.studio.platform, 'odc');
    assert.match(String(index.identity.studio.ideVersion), /^1\./);
    assert.ok(typeof index.identity.studio.assemblies === 'object');
    // The version is the one the reflection index declares (regenerated after a Studio update: 1.7.24 -> 1.7.25, M1).
    assert.equal(index.identity.modelApi.version, /ODC Studio ([0-9.]+)/.exec(fs.readFileSync(path.join(sources.modelApiDir, 'INDEX.md'), 'utf8'))[1]);
    for (const level of ['described', 'B', 'C-suite', 'C-executed-historical', 'C-executed-current', 'A', 'D']) assert.ok(index.provenance[level]);
    assert.match(index.provenance['C-executed-current'], /component by component/);
    const second = await buildIndex('odc', { sources: isolated });
    assert.equal(second.cache.hit, true);
    assert.equal(second.index.key, index.key);
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

test('a composite intent returns capabilities, whole contracts, example excerpts, proven bindings, conditional dependencies and decisions in one answer', { skip: !cliBuilt && 'anvil-odc CLI not built', timeout: 120000 }, async () => {
  const { index } = await buildIndex('odc', { sources });
  const q = query(index, { intent: 'Criar um formulário com dropdown pesquisável, carregar dados e salvar' });
  const ids = q.matches.map(m => m.id);
  for (const expected of ['ui.form', 'ui.dropdown-search', 'ui.screen', 'logic.server-action', 'data.entity', 'logic.screen-action']) assert.ok(ids.includes(expected), 'missing ' + expected + ' in ' + ids.join(','));
  const form = q.matches.find(m => m.id === 'ui.form');
  assert.ok(['C-suite', 'C-executed-historical', 'C-executed-current'].includes(form.level), form.level);
  assert.ok(form.depends.every(d => typeof d.unless === 'string' && d.unless.length), JSON.stringify(form.depends));
  const screen = q.matches.find(m => m.id === 'ui.screen');
  assert.equal(screen.via, 'dependency');
  assert.ok(screen.conditions.some(c => c.requiredBy === 'ui.form' && /already exists/.test(c.unless)));
  const dropdown = q.matches.find(m => m.id === 'ui.dropdown-search');
  assert.equal(dropdown.level, 'B'); assert.deepEqual(dropdown.proofs, []);
  assert.ok(!/OptionsList|SelectedOptionList/.test(dropdown.summary), 'no block signature specifics in curated text');
  // Contracts of direct matches come whole: the verb shapes with required/optional/effect, the html-visual tags table.
  assert.deepEqual(q.contracts['verbs.verbs.create'].required, ['parent', 'type']);
  assert.ok(typeof q.contracts['verbs.verbs.create'].effect === 'string' && q.contracts['verbs.verbs.set'].optional.includes('value'));
  assert.ok(q.contracts['html-visual.tags'] && !q.contracts['html-visual.tags'].expand, 'html-visual.tags whole');
  // Bindings: proven rules with the concrete op, element-to-element first.
  assert.ok(q.bindings.length > 0 && q.bindings.every(b => b.rule && b.job && typeof b.op === 'number' && b.example));
  assert.ok(q.bindings.some(b => /Destination = <IScreenAction>|Destination = IMobileScreen/.test(b.rule)), q.bindings.map(b => b.rule).join('\n'));
  assert.ok(q.bindings.every((b, i) => i === 0 || b.rank >= q.bindings[i - 1].rank));
  assert.ok(q.order.indexOf('ui.screen') < q.order.indexOf('ui.form'));
  assert.deepEqual(q.cycles, []); assert.deepEqual(q.invalidDependencies, []);
  assert.deepEqual(q.unmatched, []);
  assert.ok(q.decisions.some(d => d.between.includes('ui.dropdown-search') && d.between.includes('ui.dropdown')));
  const session = query(index, { intent: 'guardar estado numa session variable' });
  assert.equal(session.unavailable[0]?.id, 'session-variable');
  // Request C-010: the variant "publicacao" reaches the token "publica" only through a derivational suffix; the adjective
  // "publica" (public) must not name the publish operation, while the noun and the verb still do.
  const direct = intent => query(index, { intent }).matches.filter(m => m.via === 'match').map(m => m.id);
  assert.ok(!direct('importar a action publica do modulo produtor').includes('deliver.publish'));
  assert.ok(direct('fazer a publicacao do modulo').includes('deliver.publish'));
  assert.ok(direct('publicar o modulo').includes('deliver.publish'));
  const all = closure(index.capabilities, index.capabilities.map(c => ({ c, score: 1, why: [], via: 'match' })));
  assert.deepEqual(all.cycles, []); assert.deepEqual(all.invalid, []);
});

// Lexical gap seen in the round-3 evaluation (case 1): "aggregate ... ordenado" did not reach logic.aggregate, so the
// agent needed a second composite query for the join. The sort/join synonyms were added AFTER the evaluation; this test
// verifies the defect is fixed (the capability, its contracts and the list/aggregate bindings come in one answer). It
// does not measure any time reduction.
test('the list-with-sort-and-join intent reaches logic.aggregate with bindings and declared contract expansions', { skip: !cliBuilt && 'anvil-odc CLI not built', timeout: 120000 }, async () => {
  const answer = await discover({ lane: 'odc', intent: 'tela de listagem de apolices: static entity PolicyStatus, entidade Policy com FK, tela WfPolicies com um aggregate das apolices ordenado por Number e uma lista com Number e Label do status, clique navega para WfPolicyDetail com input PolicyId', sources });
  assert.equal(answer.ok, true);
  const direct = answer.matches.filter(m => m.via === 'match').map(m => m.id);
  for (const id of ['logic.aggregate', 'ui.list', 'data.static', 'ui.screen']) assert.ok(direct.includes(id), id + ' not a direct match: ' + direct.join(','));
  assert.ok(answer.contracts['logic.steps.get'] && answer.contracts['logic.queryJoin'] !== undefined, 'aggregate contracts present');
  const verbContracts = {};
  for (const verb of ['create', 'set']) {
    const pointer = 'verbs.verbs.' + verb;
    const slice = answer.contracts[pointer];
    if (slice.required) verbContracts[verb] = slice;
    else {
      // The C07 UI/example sections may reserve room; a declared cut must remain recoverable.
      assert.equal(slice.expand, 'contract:' + pointer);
      const expanded = await discover({lane:'odc', expand:slice.expand, sources});
      verbContracts[verb] = expanded.expansions[slice.expand];
    }
  }
  assert.ok(verbContracts.create.required.includes('parent') && verbContracts.set.required.includes('prop'));
  assert.equal(answer.examples['logic.aggregate']?.job, 'aggregate-full');
  const rules = answer.bindings.map(b => b.rule);
  for (const expected of ['set <IList> Source = <Aggregate>.List', 'set <IListItem>/OnClick Destination = IMobileScreen:<name>']) assert.ok(rules.includes(expected), expected + ' missing in ' + rules.join('\n'));
  assert.ok(answer.composition.order.indexOf('data.entity') < answer.composition.order.indexOf('ui.list'));
});

test('expansions return exactly the parts named, within the budget, for several capabilities in one call', { skip: !cliBuilt && 'anvil-odc CLI not built', timeout: 120000 }, async () => {
  const one = await discover({ lane: 'odc', expand: 'ui.list:example+bindings,logic.aggregate:example,contract:logic.steps.get,native:IDropdown', sources });
  assert.equal(one.ok, true); assert.equal(one.schemaVersion, DISCOVERY_SCHEMA);
  assert.deepEqual(Object.keys(one.expansions), ['ui.list', 'logic.aggregate', 'contract:logic.steps.get', 'native:IDropdown']);
  assert.equal(one.expansions['ui.list'].example.job, 'screen-list');
  assert.ok(one.expansions['ui.list'].example.ops.length > 8 && one.expansions['ui.list'].bindings.some(b => /<IListItem>\/OnClick Destination/.test(b.rule)));
  assert.equal(one.expansions['ui.list'].contract, undefined, 'contract was not asked for');
  assert.equal(one.expansions['logic.aggregate'].example.job, 'aggregate-full');
  assert.ok(one.expansions['contract:logic.steps.get'].includes('where'));
  assert.equal(one.expansions['native:IDropdown'].provenance, 'A');
  assert.ok(one.size.bytes <= one.size.budgetBytes);
  assert.deepEqual(one.problems, []);
  // --detail is the single-capability form; the example is flagged as a fragment when cut; evidence carries the proofs.
  const detail = await discover({ lane: 'odc', detail: 'data.entity', sources });
  const part = detail.expansions['data.entity'];
  assert.ok(part.contract['verbs.verbs.rename'].required.includes('name'));
  assert.equal(part.example.fragment, true); assert.match(part.example.note, /^FRAGMENT/);
  assert.ok(part.evidence.proofs.every(p => LEVELS.includes(p.level) && Array.isArray(p.mismatches) && typeof p.path === 'string'));
  assert.ok(part.evidence.negative.some(n => n.job === 'delete-entity-in-use'));
  const unknown = await discover({ lane: 'odc', expand: 'nope:example', sources });
  assert.equal(unknown.ok, false); assert.match(unknown.error, /unknown capability/);
  const badPart = await discover({ lane: 'odc', expand: 'ui.list:examples', sources });
  assert.equal(badPart.ok, false); assert.match(badPart.error, /unknown part/);
});

test('answers respect the byte budget, keep contracts and examples of a composite intent, and say precisely what they leave out', { skip: !cliBuilt && 'anvil-odc CLI not built', timeout: 120000 }, async () => {
  const answer = await discover({ lane: 'odc', intent: 'formulário com dropdown pesquisável, carregar dados e salvar', sources });
  assert.equal(answer.ok, true);
  assert.equal(answer.size.budgetBytes, DEFAULT_BUDGET_BYTES);
  assert.ok(answer.size.bytes <= answer.size.budgetBytes, 'bytes: ' + answer.size.bytes);
  assert.equal(answer.size.bytes, Buffer.byteLength(JSON.stringify(answer), 'utf8'));
  assert.ok(!answer.size.truncated.some(t => ['contracts', 'examples', 'matches.dependencies'].includes(t.section)), 'reductions: ' + JSON.stringify(answer.size.truncated));
  for (const m of answer.matches.filter(x => x.via === 'match')) if (answer.examples[m.id]) assert.ok(answer.examples[m.id].ops.length > 0 && typeof answer.examples[m.id].fragment === 'boolean');
  const PARTS = ['contract', 'example', 'evidence', 'operations', 'native', 'bindings'];
  assert.ok(answer.continuation.omitted.every(o => { const [id, parts] = o.expand.split(':'); return /^[a-z.-]+$/.test(id) && parts.split('+').every(p => PARTS.includes(p)) && parts.includes('evidence'); }), JSON.stringify(answer.continuation.omitted));
  assert.ok(answer.identity.cli && answer.identity.kernel && answer.identity.fixture && answer.identity.studio.ideVersion);
  assert.ok(answer.matches.every(m => LEVELS.includes(m.level)));
  assert.ok(answer.matches.every(m => ['match', 'dependency', 'alternative'].includes(m.via)));
  // Alternatives are named compactly with their reason and the expansion that opens them; never with contracts.
  for (const alt of answer.matches.filter(m => m.via === 'alternative')) { assert.ok(alt.reason && alt.expand === alt.id, JSON.stringify(alt)); assert.equal(alt.contract, undefined); }
  const tight = await discover({ lane: 'odc', intent: 'formulário com dropdown pesquisável, carregar dados e salvar', sources, budgetBytes: 8192 });
  assert.ok(tight.size.truncated.length >= 4 && tight.size.truncated.every(t => t.recover), JSON.stringify(tight.size.truncated));
  assert.ok(tight.size.bytes <= 8192 && ['reduced', 'insufficient'].includes(tight.size.status), 'hard budget: ' + tight.size.bytes + ' ' + tight.size.status);
});

// ---- application context through the real reader over the fixture (read-only; never contacts the Studio)
test('with a capture, the composite answer carries the signatures the intent names and an element expansion reads one signature', { skip: (!cliBuilt || !fs.existsSync(fixture)) && 'CLI or fixture missing', timeout: 240000 }, async () => {
  const { inspect } = await import('../lib.mjs');
  const answer = await discover({ lane: 'odc', intent: 'formulário com dropdown pesquisável, carregar dados e salvar', app: fixture, sources, inspect });
  assert.equal(answer.ok, true);
  const c = answer.context;
  assert.equal(c.ok, true, JSON.stringify(c).slice(0, 400));
  assert.match(c.sourceSha256, /^[0-9A-Fa-f]{64}$/);
  const dropdown = c.signatures.find(s => s.name === 'DropdownSearch');
  assert.ok(dropdown, 'DropdownSearch signature: ' + JSON.stringify(c.signatures.map(s => s.name)));
  assert.ok(dropdown.inputs.find(i => i.name === 'OptionsList')?.mandatory === true);
  assert.ok(dropdown.events.find(e => e.name === 'OnChanged')?.parameters.some(p => p.name === 'SelectedOptionList'));
  assert.ok(answer.matches.find(m => m.id === 'ui.screen')?.existingInCapture?.length, 'existing screens');
  assert.ok(answer.size.bytes <= answer.size.budgetBytes, 'bytes: ' + answer.size.bytes + ' ' + JSON.stringify(answer.size.truncated));
  const one = await discover({ lane: 'odc', expand: 'element:MobileBlockSignature:DropdownSearch', app: fixture, sources, inspect });
  assert.equal(one.ok, true);
  const el = one.expansions['element:MobileBlockSignature:DropdownSearch'];
  assert.equal(el.instanceSource, 'IMobileBlock:DropdownSearch'); assert.ok(el.inputs.some(i => i.name === 'OptionsList')); assert.match(el.sourceSha256, /^[0-9A-Fa-f]{64}$/);
  const noApp = await discover({ lane: 'odc', expand: 'element:MobileBlockSignature:DropdownSearch', sources, inspect });
  assert.equal(noApp.ok, false); assert.match(noApp.error, /need app \(a capture \.oml\)/);
});

// ---- the public entries: CLI verb and MCP tool answer with the same shape
test('the MCP tool ssam_discover is registered read-only, accepts expand, and answers like the CLI', { skip: !cliBuilt && 'anvil-odc CLI not built', timeout: 120000 }, async () => {
  const server = await createFacadeServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'discovery-test', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'ssam_discover');
    assert.ok(tool, 'ssam_discover missing');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.ok(tool.inputSchema.properties.budgetBytes && tool.inputSchema.properties.expand);
    const reply = await client.callTool({ name: 'ssam_discover', arguments: { intent: 'renomear uma entidade e ver o que não acompanha', budgetBytes: 20000 } });
    assert.equal(reply.isError, undefined);
    assert.equal(reply.structuredContent.ok, true);
    assert.ok(reply.structuredContent.matches.some(m => m.id === 'refactor.rename'));
    assert.equal(reply.structuredContent.size.budgetBytes, 20000);
    const expanded = await client.callTool({ name: 'ssam_discover', arguments: { expand: 'refactor.rename:contract+example' } });
    assert.equal(expanded.structuredContent.ok, true);
    assert.ok(expanded.structuredContent.expansions['refactor.rename'].contract['verbs.verbs.rename']);
    const empty = await client.callTool({ name: 'ssam_discover', arguments: {} });
    assert.equal(empty.structuredContent.ok, false);
  } finally { await client.close(); await server.close(); }
  const cli = await promisify(execFile)(process.execPath, [path.join(odcRoot, 'facade', 'odc.mjs'), 'discover', '--expand', 'refactor.delete:example', '--budget', '16384'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.expansions['refactor.delete'].example.ops.length > 0 && parsed.expansions['refactor.delete'].example.ops.every(op => ['usages', 'replace', 'delete'].includes(op.op)), 'example ops of the capability verbs');
  assert.equal(parsed.size.budgetBytes, 16384);
});
