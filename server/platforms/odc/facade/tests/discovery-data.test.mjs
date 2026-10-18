// The data lot (phase 3, 2026-09-23): entities, attributes, identifiers (foreign keys) and indexes shared between the
// ODC and O11 lanes, through the PUBLIC discovery entry; the selection tiers (direct / dependency / alternative) and
// the hard byte budget. Index checks need the lane CLI built and skip otherwise; the pure checks always run.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { wireBytes } from './fixtures/answer-wire.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { laneSources, loadShared, projectShared, buildIndex, query, discover, applyBudget, focusOf, tokens } from '../discovery.mjs';

// The data lot is measured over the base catalog, without the fronts' fragments (request C-004).
const BASE_ONLY = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-base-only-'));
const odc = { ...laneSources('odc'), fragments: BASE_ONLY }; const o11 = { ...laneSources('o11'), fragments: BASE_ONLY };
const odcCli = fs.existsSync(odc.cli); const o11Cli = fs.existsSync(o11.cli);
const { shared } = loadShared(odc.shared);
const bytesOf = a => Buffer.byteLength(JSON.stringify(a), 'utf8');
const direct = a => (a.matches ?? []).filter(m => m.via === 'match');
const terms = intent => { const raw = tokens(intent); const out = new Set(raw); for (const [k, vs] of Object.entries(shared.synonyms)) for (const v of [k, ...vs]) { const f = tokens(v).join(' '); if (f && (raw.includes(f) || (f.includes(' ') && raw.join(' ').includes(f)))) out.add(tokens(k).join(' ')); } return [...out]; };

test('data.entity is one shared capability stated per role and lane: entity, attribute (a foreign key is an attribute typed <Entity> Identifier), identifier type, index, index attribute', () => {
  const s = projectShared(shared, 'odc').find(c => c.id === 'data.entity'); const t = projectShared(shared, 'o11').find(c => c.id === 'data.entity');
  assert.ok(s && t); assert.deepEqual(s.elements.map(e => e.role), ['server entity', 'entity attribute', 'identifier type', 'index', 'index attribute']);
  assert.equal(s.elements.find(e => e.role === 'index').native, 'OutSystems.Model.Data.IEntityIndex');
  assert.equal(t.elements.find(e => e.role === 'index').native, 'ServiceStudio.Model.EntityIndex'); assert.equal(t.elements.find(e => e.role === 'index').runtime, 'kernel');
  assert.ok(s.elements.find(e => e.role === 'entity attribute').note.includes('Identifier'), 'the relationship is the attribute type, not an element');
  for (const c of [s, t]) {
    assert.equal(c.operations.replace.roles['server entity'].status, 'not-applicable'); assert.deepEqual(c.operations.replace.roles['server entity'].negative, ['replace-entity']);
    assert.equal(c.operations.replace.roles['entity attribute'].status, 'applicable');
    assert.equal(c.operations.delete.roles['server entity'].status, 'undetermined'); assert.equal(c.operations.delete.roles['server entity'].observed.integrity, 'not-verified');
    assert.equal(c.operations.delete.roles['entity attribute'].status, 'conditional'); assert.ok(c.operations.delete.roles['entity attribute'].negative.includes('delete-fk-attribute-autoindex'));
    assert.equal(c.operations.create.roles.index.status, 'applicable'); assert.ok(c.operations.create.roles.index.negative.includes('index-name-too-long'));
    assert.equal(c.operations.move.roles.index.status, 'not-applicable'); assert.equal(c.operations.rename.roles.index.status, 'applicable');
    assert.equal(c.operations.duplicate.roles.index.status, 'not-applicable');
    assert.equal(c.operations.set.roles['entity attribute'].status, 'conditional'); assert.ok(c.operations.set.roles['entity attribute'].negative.includes('fk-type-change-with-default'));
  }
  // The one platform difference of the lot that changes a status: index attributes reorder on ODC, not on O11.
  assert.equal(s.operations.move.roles['index attribute'].status, 'applicable'); assert.equal(t.operations.move.roles['index attribute'].status, 'not-applicable');
  assert.equal(t.operations.move.roles['index attribute'].otherLanes.odc.status, 'applicable');
});

test('the focus names the element role from entity words: entity, attribute (entity vs index), identifier, index; creation words choose the create operation', () => {
  const c = projectShared(shared, 'odc').find(x => x.id === 'data.entity');
  assert.deepEqual(focusOf(c, terms('criar uma entidade Order com FK para Customer e um indice unico composto'), 'criar uma entidade Order com FK para Customer e um indice unico composto').roles, ['server entity', 'identifier type', 'index']);
  assert.deepEqual(focusOf(c, terms('criar uma entidade'), 'criar uma entidade').ops, ['create']);
  assert.deepEqual(focusOf(c, terms('renomear o atributo Email da entidade Contact'), '').roles, ['entity attribute']);
  assert.deepEqual(focusOf(c, terms('reordenar os atributos de um indice'), '').roles, ['index attribute']);
  assert.deepEqual(focusOf(c, terms('apagar um atributo'), '').roles, ['entity attribute', 'index attribute'], 'ambiguous: both attribute roles stay');
  assert.deepEqual(focusOf(c, terms('mover a entidade'), '').ops, ['move']);
});

test('selection has three tiers: a family is direct only when an element of it is named; operation words alone make an alternative; dependencies stay', { skip: !odcCli && 'anvil-odc CLI not built', timeout: 180000 }, async () => {
  const { index } = await buildIndex('odc', { sources: odc });
  assert.deepEqual(index.shared.capabilities, ['data.static', 'data.structure', 'data.entity']);
  assert.ok(!index.capabilities.some(c => c.id === 'data.edit'), 'data.edit is no longer a separate capability: its route lives in the families');
  const q = query(index, { intent: 'reapontar um registo de uma static entity para outro registo e apagar o registo antigo' });
  assert.deepEqual(direct(q).map(m => m.id), ['data.static'], JSON.stringify(q.matches.map(m => m.id + ':' + m.via)));
  const alternatives = q.matches.filter(m => m.via === 'alternative');
  assert.ok(alternatives.some(m => m.id === 'data.structure' && /operation words only/.test(m.reason)), JSON.stringify(alternatives));
  assert.ok(alternatives.some(m => m.id === 'data.entity'), 'the entity family is an alternative (its word "entity" was consumed by "static entity")');
  for (const a of alternatives) { assert.equal(a.expand, a.id); assert.equal(a.contract, undefined); assert.equal(a.operations, undefined); }
  // A family named by a generic child word only (attribute) leaves the direct tier when another family is named.
  const q2 = query(index, { intent: 'renomear o atributo Email da entidade Contact e apagar o atributo Phone sem consumidores' });
  assert.deepEqual(direct(q2).map(m => m.id), ['data.entity']); assert.ok(q2.matches.some(m => m.id === 'data.structure' && m.via === 'alternative' && /generic element word/.test(m.reason)));
  // Ambiguous: only operation words -> no direct family; the generic refactor capabilities answer and the families are alternatives.
  const q3 = query(index, { intent: 'reapontar e apagar' });
  assert.ok(!direct(q3).some(m => m.id.startsWith('data.')), JSON.stringify(direct(q3).map(m => m.id)));
  assert.ok(q3.matches.some(m => m.via === 'alternative' && m.id === 'data.entity'));
  // Composite with dependencies: the dependency tier survives with its conditions.
  const q4 = query(index, { intent: 'formulário com dropdown pesquisável, carregar dados e salvar' });
  assert.ok(q4.matches.some(m => m.id === 'ui.screen' && m.via === 'dependency' && m.conditions?.length));
  assert.ok(q4.matches.some(m => m.id === 'data.entity' && m.via === 'dependency'), 'the form depends on the shared entity capability by the same id');
});

test('through the public entry: a simple, a composite, an ambiguous and an unsupported intent, the 12000-byte budget, the expansion of what was omitted, and the static/structure regression', { skip: !odcCli && 'anvil-odc CLI not built', timeout: 240000 }, async () => {
  // Simple intent, 12000 bytes: the focused operations stay whole, the answer fits, everything omitted is expandable.
  const simple = await discover({ lane: 'odc', intent: 'renomear o atributo Email da entidade Contact e apagar o atributo Phone sem consumidores', sources: odc, budgetBytes: 12000 });
  assert.equal(simple.ok, true); assert.ok(wireBytes(simple, { budgetBytes: 12000 }) <= 12000 && simple.size.bytes === bytesOf(simple), 'hard budget: ' + bytesOf(simple));
  assert.ok(['within', 'reduced'].includes(simple.size.status));
  const m = direct(simple)[0]; assert.equal(m.id, 'data.entity'); assert.deepEqual(m.focus.roles, ['entity attribute']); assert.ok(m.focus.ops.includes('rename') && m.focus.ops.includes('delete'));
  assert.ok(Object.keys(m.operations).includes('delete') && Object.keys(m.operations).includes('rename'), 'focused operations kept: ' + Object.keys(m.operations));
  assert.ok(m.operations.delete.roles['entity attribute'].status === 'conditional', JSON.stringify(m.operations.delete.roles['entity attribute']));
  assert.ok(m.operations.delete.roles['server entity'].observed?.integrity === 'not-verified' || m.operations.delete.roles['server entity'].evidence === 'undetermined', 'the entity delete never reads as safe');
  assert.ok(simple.continuation.omitted.some(o => o.id === 'data.entity' && o.parts.includes('evidence')), JSON.stringify(simple.continuation.omitted));
  // Creation intent, composite with an index: the create operation is focused and the example is the spec.
  const creation = await discover({ lane: 'odc', intent: 'criar uma entidade Order com FK para Customer e um indice unico composto por Number e CustomerId', sources: odc, budgetBytes: 40960 });
  const c = direct(creation).find(x => x.id === 'data.entity'); assert.ok(c); assert.deepEqual(c.focus.ops, ['create']); assert.ok(c.focus.roles.includes('index') && c.focus.roles.includes('identifier type'));
  // The excerpt is scoped to the entity role and keeps the spec (the op that created the entity) whatever the cut;
  // the reads around it stay in job order. The spec is attributed through the shapes it declares and the job ledger.
  const ex = creation.examples['data.entity']; assert.equal(ex.scope.role, 'server entity'); assert.equal(ex.scope.op, 'create');
  assert.ok(ex.ops.some(o => o.op === 'spec' && o.data?.entities?.some(e => e.indexes?.length && e.attributes?.some(a => /Identifier$/.test(a.type)))), JSON.stringify(ex.ops.map(o => o.op)));
  assert.ok(ex.focusedOps.map(k => ex.ops[k].op).includes('spec'), JSON.stringify(ex.focusedOps.map(k => ex.ops[k].op)));
  assert.ok(wireBytes(creation, { budgetBytes: 40960 }) <= 40960);
  // Final version (after the evaluation): a refactor that names an attribute AND an index gets ONE excerpt covering
  // both roles (the job that covers the most focused pairs), so the raw `create EntityIndex` is in it; creation words
  // beside other operations add `create` to the focus; the same id named twice in one --expand is merged.
  const refactor = await discover({ lane: 'odc', intent: 'renomear o atributo Title da entidade WfCovTask, apagar o indice IX_WfCovTask_ProjectDone e criar um indice unico composto, apagar o atributo IsDone e renomear a entidade', sources: odc, budgetBytes: 60000 });
  const r = direct(refactor).find(x => x.id === 'data.entity'); assert.ok(r.focus.ops.includes('create') && r.focus.ops.includes('rename') && r.focus.ops.includes('delete'), JSON.stringify(r.focus));
  assert.ok(r.focus.allRoles.includes('index') && r.focus.allRoles.includes('server entity'), JSON.stringify(r.focus));
  const rex = refactor.examples['data.entity']; assert.ok(rex.scope.roles.length >= 2, JSON.stringify(rex.scope));
  const kinds = rex.ops.map(o => o.op + (o.type ? ':' + o.type : ''));
  assert.ok(kinds.includes('create:EntityIndex') && kinds.includes('rename'), kinds.join(','));
  assert.ok(rex.ops.find(o => o.op === 'create' && o.type === 'EntityIndex').args.attributes.every(a => /^IServerEntity:/.test(a)), 'index attributes are paths');
  const twice = await discover({ lane: 'odc', expand: 'data.entity:example,contract:verbs.verbs.get,data.entity:operations', sources: odc, budgetBytes: 200000 });
  assert.ok(twice.expansions['data.entity'].example && twice.expansions['data.entity'].operations, 'both parts of the same id are returned: ' + Object.keys(twice.expansions['data.entity']).join(','));
  assert.ok(twice.expansions['contract:verbs.verbs.get'], 'the contract in between is kept');
  assert.ok(r.contract.includes('verbs.verbs.get') && r.contract.includes('verbs.verbs.dump'), 'read verbs are among the family contract pointers');
  // Unsupported operation: stated as refused with the alternative, never as a route.
  const unsupported = await discover({ lane: 'odc', intent: 'mover a entidade para outro modulo', sources: odc, budgetBytes: 12000 });
  const u = direct(unsupported).find(x => x.id === 'data.entity'); assert.ok(u && u.focus.ops.includes('move'));
  assert.equal(u.operations.move.roles['server entity'].status, 'not-applicable'); assert.ok(wireBytes(unsupported, { budgetBytes: 12000 }) <= 12000);
  // Ambiguous intent: no family is direct; the hint says which words would name the element.
  const ambiguous = await discover({ lane: 'odc', intent: 'reapontar e apagar', sources: odc, budgetBytes: 12000 });
  assert.ok(!direct(ambiguous).some(x => x.id.startsWith('data.'))); assert.ok(ambiguous.matches.some(x => x.via === 'alternative' && x.id === 'data.entity')); assert.ok(wireBytes(ambiguous, { budgetBytes: 12000 }) <= 12000);
  // A budget too small for the minimal answer is said explicitly, within the budget.
  const tiny = await discover({ lane: 'odc', intent: 'renomear o atributo Email da entidade Contact e apagar o atributo Phone sem consumidores', sources: odc, budgetBytes: 4096 });
  assert.ok(wireBytes(tiny, { budgetBytes: 4096 }) <= 4096); assert.ok(['insufficient', 'reduced', 'within'].includes(tiny.size.status)); if (tiny.size.status === 'insufficient') { assert.ok(tiny.size.minimalBytes > 4096); assert.match(tiny.hint, /insufficient budget/); }
  // Expansion of the omitted parts returns the whole statement per role.
  const expanded = await discover({ lane: 'odc', expand: 'data.entity:operations+native+evidence', sources: odc, budgetBytes: 200000 });
  assert.equal(expanded.ok, true); const e = expanded.expansions['data.entity'];
  assert.equal(e.operations.delete.roles['server entity'].observed.integrity, 'not-verified'); assert.ok(e.native.some(n => n.role === 'index' && n.native === 'OutSystems.Model.Data.IEntityIndex'));
  assert.ok(e.evidence.negative.some(n => n.job === 'delete-entity-in-use'));
  // Regression of the phase-2 pilot: static entities and structures still answer per role.
  const pilot = await discover({ lane: 'odc', intent: 'reapontar um registo de uma static entity para outro registo e apagar o registo antigo', sources: odc, budgetBytes: 12000 });
  const p = direct(pilot)[0]; assert.equal(p.id, 'data.static'); assert.deepEqual(p.focus.roles, ['record']); assert.equal(p.operations.replace.roles['static entity'].evidence, 'undetermined'); assert.ok(wireBytes(pilot, { budgetBytes: 12000 }) <= 12000);
  const structure = await discover({ lane: 'odc', intent: 'reordenar um atributo de uma estrutura e duplicar a estrutura', sources: odc, budgetBytes: 12000 });
  assert.equal(direct(structure)[0]?.id, 'data.structure'); assert.ok(wireBytes(structure, { budgetBytes: 12000 }) <= 12000);
});

test('the O11 lane answers the entity family with its own proofs, the kernel-synthesized index type and the reorder refusal', { skip: !o11Cli && 'anvil.dll not built', timeout: 240000 }, async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-discovery-o11-data-')); const isolated = { ...o11, cacheDir };
  try {
    const answer = await discover({ lane: 'o11', intent: 'criar uma entidade Ticket relacionada com Contact e um indice unico', sources: isolated, budgetBytes: 12000 });
    assert.ok(wireBytes(answer, { budgetBytes: 12000 }) <= 12000, 'hard budget: ' + bytesOf(answer));
    const m = direct(answer)[0]; assert.equal(m.id, 'data.entity'); assert.deepEqual(m.focus.ops, ['create']); assert.ok(m.focus.roles.includes('index'));
    assert.ok(m.native.some(n => (n.role === 'index' && n.native === 'ServiceStudio.Model.EntityIndex') || n === 'ServiceStudio.Model.EntityIndex'), JSON.stringify(m.native));
    const full = await discover({ lane: 'o11', expand: 'data.entity:operations+native', sources: isolated, budgetBytes: 200000 });
    const ops = full.expansions['data.entity'].operations;
    assert.equal(ops.move.roles['index attribute'].status, 'not-applicable'); assert.equal(ops.move.roles['index attribute'].level, 'refusal-proven'); assert.equal(ops.move.roles['index attribute'].otherLanes.odc.status, 'applicable');
    assert.equal(full.expansions['data.entity'].native.find(n => n.role === 'index').runtime.provenance, 'kernel');
    for (const [op, o] of Object.entries(ops)) for (const [role, r] of Object.entries(o.roles)) if (r.proofs?.length) assert.ok(r.proofs.every(p => isolatedJobs(isolated).has(p.job)), `${op}/${role} proofs are O11 jobs`);
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
});
function isolatedJobs(sources) { return new Set(fs.readdirSync(sources.jobsDir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))); }
