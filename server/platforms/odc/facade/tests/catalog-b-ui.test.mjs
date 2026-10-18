// Front B (interface and composition) of the comprehensive catalog, 2026-09-23: the UI fragments through the pure check
// (accounting, contract rules, the four layers kept apart) and through the PUBLIC discovery entry on both lanes
// (selection, focus per role, evidence per role and lane, measured refusals, the Traditional context only on O11, the
// widget -> event -> action binding, the hard byte budget, expansions). Index checks need the lane CLI and skip otherwise.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireBytes } from './fixtures/answer-wire.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { laneSources, discover, loadShared, projectShared, DEFAULT_BUDGET_BYTES } from '../discovery.mjs';
import { checkCatalog, composeCatalog } from '../catalog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..');
const odc = laneSources('odc'); const o11 = laneSources('o11');
const odcCli = fs.existsSync(odc.cli); const o11Cli = fs.existsSync(o11.cli);
const { shared } = loadShared(odc.shared);
const composed = composeCatalog({ shared }).shared;
const cap = id => composed.capabilities.find(c => c.id === id);
const direct = a => (a.matches ?? []).filter(m => m.via === 'match').map(m => m.id);
const match = (a, id) => (a.matches ?? []).find(m => m.id === id);
const COMPOSITE = 'botao que navega para a tela de detalhe e evento onclick ligado a uma screen action';

test('front B accounts for every inventory type it owns on both lanes, with no contract error, and its generated files are current', () => {
  const r = checkCatalog({ root, front: 'B' });
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors.slice(0, 5)));
  for (const a of r.accounting) {
    assert.equal(a.owner, 'B'); assert.equal(a.unaccounted, 0, `${a.lane}: ${a.unaccounted} unaccounted`);
    if (a.outsideRoot) assert.equal(a.outsideRoot.unaccounted, 0, `${a.lane}: outside-root types unaccounted`);
  }
  assert.deepEqual(r.accounting.map(a => a.lane).sort(), ['o11', 'odc']);
  for (const script of ['gen-accounting.mjs', 'normalize-fragments.mjs']) execFileSync(process.execPath, [path.join(root, 'docs', 'catalogo', 'B', 'gerador', script), '--check'], { cwd: root, stdio: 'pipe' });
  // Every legacy capability and absence owned by B is superseded by a shared/2 version (ui.form and ui.dropdown-search
  // since references can carry lanes: request B-001).
  assert.deepEqual(r.legacy.capabilities.filter(c => !c.superseded).map(c => c.id), []);
  assert.ok(r.legacy.unavailable.every(u => u.superseded), JSON.stringify(r.legacy.unavailable));
  // Since front A's logic exists on both lanes (D-M2-6), B has no pending requirement left.
  assert.deepEqual(r.pendingRequires.filter(p => p.front === 'B'), [], JSON.stringify(r.pendingRequires));
});

test('the four layers stay apart: native widget, referenced signature (read-only in the consumer), configured instance, binding rule', () => {
  const inst = cap('ui.block-instance');
  const roles = Object.fromEntries(inst.elements.map(e => [e.role, e]));
  assert.equal(roles['referenced block'].platforms.odc.native, 'OutSystems.Model.UI.Mobile.IMobileBlockSignature');
  for (const lane of ['odc', 'o11']) for (const op of ['create', 'set']) {
    const s = inst.operations[op].roles['referenced block'][lane];
    assert.equal(s.status, 'not-applicable'); assert.match(s.alternative, /producer/);
  }
  assert.equal(inst.operations.set.roles['instance event handler'].odc.status, 'applicable');
  assert.equal(inst.operations.create.roles['instance event handler'].odc.status, 'not-applicable', 'the handler slot is born with the instance');
  // The binding is owned here; the action body is front A's and is referenced, never copied.
  const ev = cap('ui.event');
  const raw = JSON.parse(fs.readFileSync(path.join(root, 'platforms/odc/facade/catalog/fragments/B/events.json'), 'utf8')).capabilities.find(c => c.id === 'ui.event');
  assert.ok(raw.recommends.some(r => r.id === 'logic.screen-action' && !r.lanes), 'the action body is a recommendation to front A on both lanes');
  assert.equal(raw.requires, undefined, 'no pending requirement once A publishes both lanes');
  assert.equal(ev.requires, undefined, 'catalog-only fields never reach the composed capability');
  assert.ok(!JSON.stringify(ev).includes('"steps"'), 'no logic contract copied into the UI capability');
  // Accounting of signatures: excluded (edited in the producer), never represented as authorable in the consumer.
  const acc = JSON.parse(fs.readFileSync(path.join(root, 'platforms/odc/facade/catalog/fragments/B/accounting.json'), 'utf8'));
  const sig = acc.coverage.find(e => e.type === 'odc:OutSystems.Model.UI.Mobile.IMobileScreenSignature');
  assert.equal(sig.status, 'excluded'); assert.match(sig.reason, /producer/);
});

test('contexts are not inferred: Traditional Web lives on O11 only, O11 events are stated with the interface the O11 ledger records, lifecycle rests on its own job', () => {
  for (const id of ['ui.traditional-screen', 'ui.traditional-widget']) assert.deepEqual(cap(id).lanes, ['o11']);
  assert.ok(!projectShared(composed, 'odc').some(c => c.id.startsWith('ui.traditional')));
  const ev = cap('ui.event'); const we = ev.elements.find(e => e.role === 'widget event');
  assert.equal(we.platforms.odc.native, 'OutSystems.Model.UI.Mobile.Events.IBuiltinEvent');
  assert.equal(we.platforms.o11.native, 'OutSystems.Model.UI.Mobile.Events.IUILifeCycleEvent');
  // On O11 a button OnClick answers as IUILifeCycleEvent too: the lifecycle statement cites only the lifecycle job.
  assert.deepEqual(ev.operations.set.roles['lifecycle event'].o11.proofs, ['cat-b-screen-lifecycle']);
  assert.equal(ev.operations.set.roles['lifecycle event'].odc.status, 'applicable');
  // A two-lane pattern depends on front A's two-lane logic without lane restriction (B-001 lanes no longer needed).
  const form = cap('ui.form');
  assert.equal(form.depends.find(d => d.id === 'logic.server-action').lanes, undefined);
  for (const lane of ['odc', 'o11']) assert.ok(projectShared(composed, lane).find(c => c.id === 'ui.form').depends.some(d => (d.id ?? d) === 'logic.server-action'), lane);
  // On O11 a comment placed in a UI flow answers as Logic.Nodes.ICommentNode (front A's type): the role says so.
  assert.equal(cap('ui.flow-comment').elements.find(e => e.role === 'comment').platforms.o11.native, 'OutSystems.Model.Logic.Nodes.ICommentNode');
  // A web type of the ODC inventory is excluded with its reason, not silently dropped.
  const acc = JSON.parse(fs.readFileSync(path.join(root, 'platforms/odc/facade/catalog/fragments/B/accounting.json'), 'utf8'));
  const web = acc.coverage.find(e => e.type === 'odc:OutSystems.Model.UI.Web.Widgets.IButtonWidget');
  assert.equal(web.status, 'excluded'); assert.match(web.origin, /HANDOFF\.md:490/);
  // The O11 runtime has no Reactive email: the email role exists on ODC only.
  assert.equal(cap('ui.email-popover').elements.find(e => e.role === 'email').platforms.o11, undefined);
});

test('ODC: widget -> event -> action is answered by the event binding capability with current evidence and the proven binding rule', { skip: !odcCli && 'anvil-odc CLI not built', timeout: 240000 }, async () => {
  const a = await discover({ lane: 'odc', intent: COMPOSITE, sources: odc });
  assert.equal(a.ok, true); assert.ok(wireBytes(a, { budgetBytes: DEFAULT_BUDGET_BYTES }) <= DEFAULT_BUDGET_BYTES);
  for (const id of ['ui.event', 'ui.screen']) assert.ok(direct(a).includes(id), id + ' in ' + direct(a).join(','));
  const ev = match(a, 'ui.event');
  assert.equal(ev.operations.set.roles['widget event'].evidence, 'proven-current');
  assert.equal(ev.operations.create.roles['widget event'].status, 'not-applicable');
  assert.ok(a.bindings.some(b => /<IButton>\/OnClick Destination = <IScreenAction>/.test(b.rule)), a.bindings.map(b => b.rule).join('\n'));
  assert.ok(!direct(a).some(id => id.startsWith('ui.traditional')), 'no Traditional capability on ODC');
});

test('O11: the same intent is read with the same vocabulary; the evidence is O11 own (stamped jobs), lifecycle included', { skip: !o11Cli && 'anvil.dll not built', timeout: 240000 }, async () => {
  // A larger budget than the default so the focused statements keep their proofs (under the default the budget keeps
  // only status and evidence per named role).
  const a = await discover({ lane: 'o11', intent: COMPOSITE, sources: o11, budgetBytes: 80000 });
  assert.equal(a.ok, true);
  for (const id of ['ui.event', 'ui.screen']) assert.ok(direct(a).includes(id), id + ' in ' + direct(a).join(','));
  const ev = match(a, 'ui.event');
  const we = ev.operations.set.roles['widget event'];
  assert.equal(we.evidence, 'proven-current'); assert.ok(we.proofs.every(p => !['screen-list', 'screen-basic'].includes(p.job)), 'O11 proofs are O11 jobs');
  assert.equal(ev.operations.set.roles['lifecycle event'].evidence, 'proven-current');
  assert.deepEqual(ev.operations.set.roles['lifecycle event'].proofs.map(p => p.job), ['cat-b-screen-lifecycle']);
  assert.ok(!direct(a).includes('ui.traditional-screen'), 'a generic event intent does not pull the Traditional context');
});

test('O11: deleting a block with instances is conditional with the measured refusal; Traditional intents reach the O11-only capabilities', { skip: !o11Cli && 'anvil.dll not built', timeout: 240000 }, async () => {
  const del = await discover({ lane: 'o11', intent: 'apagar um bloco que tem instancias', sources: o11, budgetBytes: 80000 });
  const blk = match(del, 'ui.block');
  assert.ok(blk && blk.via === 'match'); assert.deepEqual(blk.focus.ops, ['delete']);
  const d = blk.operations.delete.roles.block;
  assert.equal(d.status, 'conditional'); assert.ok(d.negative.some(n => n.job === 'delete-block-in-use' && n.refuses.some(t => /is used by/.test(t))));
  const trad = await discover({ lane: 'o11', intent: 'tela traditional web com table records e link para detalhe', sources: o11 });
  assert.ok(direct(trad).includes('ui.traditional-screen') && direct(trad).includes('ui.traditional-widget'), direct(trad).join(','));
  const odcTrad = await discover({ lane: 'odc', intent: 'tela traditional web com table records e link para detalhe', sources: odc });
  assert.ok(!(odcTrad.matches ?? []).some(m => m.id.startsWith('ui.traditional')));
});

test('"input" is not read as "form" on either lane: a text input intent reaches the value widgets, a bare "input" never selects the form pattern (A-004)', { skip: (!odcCli || !o11Cli) && 'lane CLI not built', timeout: 240000 }, async () => {
  for (const [lane, sources] of [['odc', odc], ['o11', o11]]) {
    const bare = await discover({ lane, intent: 'input', sources });
    assert.ok(!direct(bare).includes('ui.form'), `${lane}: ${direct(bare).join(',')}`);
    const text = await discover({ lane, intent: 'adicionar um input de texto ligado a uma variavel', sources });
    assert.ok(direct(text).includes('ui.input') && !direct(text).includes('ui.form'), `${lane}: ${direct(text).join(',')}`);
  }
});

test('the composite form regression keeps contracts, examples and dependencies at its original engine budget, with the new default still bounded', { skip: !odcCli && 'anvil-odc CLI not built', timeout: 240000 }, async () => {
  const request = { lane: 'odc', intent: 'formulário com dropdown pesquisável, carregar dados e salvar', sources: odc };
  const first = await discover(request);
  assert.equal(first.ok, true);
  assert.equal(first.size.budgetBytes, DEFAULT_BUDGET_BYTES);
  assert.equal(first.size.bytes, Buffer.byteLength(JSON.stringify(first), 'utf8'));
  assert.ok(wireBytes(first, { budgetBytes: DEFAULT_BUDGET_BYTES }) <= DEFAULT_BUDGET_BYTES);
  // The smaller default may compact dependency metadata; it must still keep the
  // contracts/examples, dependency identities and exact executable recovery.
  assert.ok(!first.size.truncated.some(t => ['contracts', 'examples'].includes(t.section)), JSON.stringify(first.size.truncated));
  const cut = first.size.truncated.find(t => t.section === 'matches.dependencies');
  if (cut) {
    assert.equal(cut.call?.tool, 'ssam_discover');
    assert.equal(cut.call.arguments.lane, request.lane);
    assert.equal(cut.call.arguments.intent, request.intent);
    assert.ok(Number.isInteger(cut.call.arguments.budgetBytes) && cut.call.arguments.budgetBytes > DEFAULT_BUDGET_BYTES);
  }
  // 40960 was this semantic regression's implicit engine budget before CX11.
  // Keep its complete original assertion; B5 covers the shared MCP output ceiling.
  const a = await discover({ ...request, budgetBytes: 40960 });
  assert.ok(!a.size.truncated.some(t => ['contracts', 'examples', 'matches.dependencies'].includes(t.section)), JSON.stringify(a.size.truncated));
  for (const id of ['ui.form', 'ui.dropdown-search']) assert.ok(direct(a).includes(id));
  assert.ok(!direct(a).includes('ui.input'), 'the value widgets do not answer a form intent that names no widget');
  assert.deepEqual(direct(first), direct(a), 'the default budget keeps the same selected capabilities');
  const dependencies = answer => answer.matches.filter(m => m.via === 'dependency').map(m => ({
    id: m.id, level: m.level, route: m.route, requiredBy: m.requiredBy, conditions: m.conditions,
  }));
  assert.deepEqual(dependencies(first), dependencies(a), 'the default keeps dependency identities, evidence, routes and conditions');
});

test('the form pattern answers the same way on both lanes: a direct match that reaches the save and screen actions of front A as dependencies; O11 cites its own stamped job', { skip: (!odcCli || !o11Cli) && 'lane CLI not built', timeout: 240000 }, async () => {
  const intent = 'Criar um formulário com dropdown pesquisável, carregar dados e salvar';
  for (const [lane, sources] of [['odc', odc], ['o11', o11]]) {
    const a = await discover({ lane, intent, sources });
    assert.ok(direct(a).includes('ui.form'), `${lane}: ${direct(a).join(',')}`);
    for (const id of ['logic.server-action', 'logic.screen-action']) assert.ok((a.matches ?? []).some(m => m.id === id && m.via === 'dependency'), `${lane} keeps the dependency ${id}`);
  }
  const x = await discover({ lane: 'o11', expand: 'ui.form:evidence', sources: o11, budgetBytes: 100000 });
  const ev = x.expansions['ui.form'].evidence;
  assert.equal(ev.level, 'C-executed-current'); assert.deepEqual(ev.proofs.map(p => p.job), ['screen-form-reactive']);
});

test('under a small budget a UI answer keeps, per role, the status and evidence of the focused operations; expansions return the full statement', { skip: !odcCli && 'anvil-odc CLI not built', timeout: 240000 }, async () => {
  const small = await discover({ lane: 'odc', intent: COMPOSITE, sources: odc, budgetBytes: 12000 });
  assert.ok(wireBytes(small, { budgetBytes: 12000 }) <= 12000); assert.ok(['reduced', 'insufficient'].includes(small.size.status));
  if (small.size.status === 'reduced') {
    const ev = match(small, 'ui.event');
    assert.ok(ev?.operations?.set?.roles?.['widget event']?.status, JSON.stringify(ev?.operations ?? null).slice(0, 300));
  }
  const x = await discover({ lane: 'odc', expand: 'ui.block-instance:operations+native', sources: odc, budgetBytes: 200000 });
  assert.deepEqual(x.problems, []);
  const e = x.expansions['ui.block-instance'];
  assert.equal(e.operations.set.roles['referenced block'].status, 'not-applicable');
  assert.ok(e.native.some(n => n.native === 'OutSystems.Model.UI.Mobile.IMobileBlockSignature'));
});
