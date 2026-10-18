// Shared capabilities between the ODC and O11 lanes (phase-2 pilot: static entities, records, structures, structure
// attributes): one definition projected per lane, every operation stated per element ROLE, validated against each
// lane's suites and runtime, answered with that lane's proofs only. The evidence of a role is computed from the
// role's qualified native type alone: a record proof never promotes the entity, a structure proof never promotes the
// attribute, an ODC result never proves O11, a historical result never reads as current, an observed behaviour with
// integrity not verified is never applicability. Pure checks always run; index checks need the lane CLI built.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadShared, projectShared, validateDescriptor, classifyExecutions, buildIndex, query, discover, operationsOf, focusOf, applyBudget, tokens, SHARED_SCHEMA } from '../discovery.mjs';
import { snapshotSources } from './fixtures/discovery-results.mjs';

// The pilot families are measured over the base catalog, without the fronts' fragments (request C-004), and over the
// committed snapshot of stamped job results (fixtures/discovery-results.json), never kernel/.local/**/test-work: that
// folder is empty in a fresh worktree and rewritten by the lane suites while these tests run.
const BASE_ONLY = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-base-only-'));
const odc = snapshotSources('odc', { fragments: BASE_ONLY }); const o11 = snapshotSources('o11', { fragments: BASE_ONLY });
const odcCli = fs.existsSync(odc.cli); const o11Cli = fs.existsSync(o11.cli);
const o11Pilot = ['static-entity-lifecycle', 'static-record-refactor', 'structure-lifecycle', 'structure-refactor'].every(j => fs.existsSync(path.join(o11.jobsDir, j + '.json')));
const { shared } = loadShared(odc.shared);
const STATUSES = ['applicable', 'conditional', 'not-applicable', 'undetermined'];

// A synthetic lane index: the projected shared capabilities plus jobs whose results say exactly which verb ran on
// which qualified type (the ledger by interface and the per-op executions), so the evidence rules are tested without
// a Studio. `current` decides whether the result reads as current or historical.
function fakeIndex(lane, results, { current = true } = {}) {
  const capabilities = projectShared(shared, lane);
  const names = new Set(capabilities.flatMap(c => [...(c.proofs[lane] ?? []), ...Object.values(c.operations).flatMap(o => Object.values(o.roles).flatMap(r => [...(r.proofs ?? []), ...(r.observed?.proofs ?? [])]))]));
  const jobs = [...names].map(name => ({ name, description: '', ops: {}, opCount: 0, notes: [], bindings: [], executed: results[name] ? { accepted: true, provenance: { schema: 'anvil-job-provenance/2' }, current, mismatches: current ? [] : ['ideVersion: result 1 vs current 2'], coverageQualified: results[name].ledger ?? null, executions: results[name].executions ?? null } : null }));
  const negatives = [...new Set(capabilities.flatMap(c => [...(c.negative[lane] ?? []), ...Object.values(c.operations).flatMap(o => Object.values(o.roles).flatMap(r => r.negative ?? []))]))].map(name => ({ name, expectError: [name + ': refused'] }));
  return { lane, capabilities, jobs, negatives, synonyms: shared.synonyms, nativeRuntime: {}, contracts: {}, routes: {}, unavailable: [] };
}
const REC_ODC = 'OutSystems.Model.Data.IStaticEntityRecord'; const ENT = 'OutSystems.Model.Data.IStaticEntity'; const STR = 'OutSystems.Model.Data.IStructure'; const ATTR = 'OutSystems.Model.Data.IStructureAttribute'; const REC_O11 = 'OutSystems.Model.Data.IRecord';
// What the real ODC result of static-record-refactor says (ledger by interface + per-op executions), reduced.
const ODC_RESULTS = {
  'static-record-refactor': { ledger: { [REC_ODC]: { shortType: 'IStaticEntityRecord', verbs: ['delete', 'replace'], props: [] }, [ENT]: { shortType: 'IStaticEntity', verbs: ['delete', 'duplicate'], props: [] } },
    executions: [{ i: 1, verb: 'usages', shortType: 'IStaticEntityRecord', iface: REC_ODC, via: 'result-short-mapped', fact: { count: 1, real: 1 } }, { i: 3, verb: 'replace', shortType: 'IStaticEntityRecord', iface: REC_ODC, via: 'result-short-mapped', fact: { consumers: 1, rewired: 1, stillPointingAtFrom: 0, consumersOfTo: 1 } }, { i: 7, verb: 'delete', shortType: 'IStaticEntityRecord', iface: REC_ODC, via: 'result-iface', fact: { brokenConsumers: 0, force: false } }, { i: 10, verb: 'duplicate', shortType: 'IStaticEntity', iface: ENT, via: 'result-iface', fact: { as: 'WfClaimPhase2' } }, { i: 15, verb: 'delete', shortType: 'IStaticEntity', iface: ENT, via: 'result-iface', fact: { brokenConsumers: 1, force: true } }] },
  'structure-refactor': { ledger: { [STR]: { shortType: 'IStructure', verbs: ['delete', 'duplicate', 'rename', 'replace', 'set'], props: ['Public'] }, [ATTR]: { shortType: 'IStructureAttribute', verbs: ['delete', 'move'], props: [] } },
    executions: [{ i: 2, verb: 'move', shortType: 'IStructureAttribute', iface: ATTR, via: 'result-short-mapped', fact: { moved: 'MoveToStart' } }, { i: 7, verb: 'duplicate', shortType: 'IStructure', iface: STR, via: 'result-iface', fact: { as: 'WfCovLocation2' } }, { i: 14, verb: 'replace', shortType: 'IStructure', iface: STR, via: 'result-short-mapped', fact: { consumers: 7, rewired: 7, stillPointingAtFrom: 0, consumersOfTo: 11 } }, { i: 20, verb: 'delete', shortType: 'IStructureAttribute', iface: ATTR, via: 'result-iface', fact: { brokenConsumers: 0, force: false } }, { i: 22, verb: 'delete', shortType: 'IStructure', iface: STR, via: 'result-iface', fact: { brokenConsumers: 0, force: false } }] },
};
const cap = (index, id) => index.capabilities.find(c => c.id === id);
const terms = intent => { const raw = tokens(intent); const out = new Set(raw); for (const [k, vs] of Object.entries(shared.synonyms)) for (const v of [k, ...vs]) { const f = tokens(v).join(' '); if (f && (raw.includes(f) || (f.includes(' ') && raw.join(' ').includes(f)))) out.add(tokens(k).join(' ')); } return [...out]; };

test('a shared capability is projected per lane, one statement per element role and operation: proofs, negatives, scope, observed behaviour and the other lane\'s status of that role only', () => {
  assert.equal(shared.schemaVersion, SHARED_SCHEMA); assert.ok(shared.lanes.includes('odc') && shared.lanes.includes('o11'));
  const forOdc = projectShared(shared, 'odc'); const forO11 = projectShared(shared, 'o11');
  assert.deepEqual(projectShared(shared, 'nope'), []);
  assert.deepEqual(forOdc.map(c => c.id), ['data.static', 'data.structure', 'data.entity']);
  const s = forOdc.find(c => c.id === 'data.static'); const t = forO11.find(c => c.id === 'data.static');
  assert.equal(s.shared, true); assert.deepEqual(s.lanes, ['odc', 'o11']);
  assert.ok(s.proofs.odc.includes('static-record-refactor') && s.proofs.o11 === undefined, 'ODC projection carries ODC proofs only');
  assert.ok(t.proofs.o11 && t.proofs.odc === undefined, 'O11 projection carries O11 proofs only');
  assert.equal(s.elements.find(e => e.role === 'record').native, REC_ODC); assert.equal(t.elements.find(e => e.role === 'record').native, REC_O11);
  assert.equal(s.elements.find(e => e.role === 'record').otherLanes.o11, REC_O11);
  // Every operation is stated per role, with the role's native type of this lane; statuses are one of the four.
  for (const c of [...forOdc, ...forO11]) for (const [op, def] of Object.entries(c.operations)) { assert.ok(def.route && Array.isArray(def.preconditions), c.id + '.' + op); for (const [role, r] of Object.entries(def.roles)) { assert.ok(STATUSES.includes(r.status), `${c.id}.${op}.${role}`); assert.ok(c.elements.some(e => e.role === role), role); assert.equal(r.native, c.elements.find(e => e.role === role).native); } }
  assert.equal(s.operations.move.roles.record.status, 'not-applicable'); assert.deepEqual(s.operations.move.roles.record.negative, ['move-static-record']); assert.match(s.operations.move.roles.record.alternative, /Order/);
  assert.equal(s.operations.rename.roles.record.status, 'conditional'); assert.deepEqual(s.operations.rename.roles.record.verbs, ['set']); assert.deepEqual(s.operations.rename.roles.record.props, ['Identifier']);
  assert.equal(s.operations.rename.roles.record.otherLanes.o11.status, t.operations.rename.roles.record.status);
  // Replace is stated for the record (proven) and for the entity (undetermined) on both lanes; never one statement for both.
  for (const c of [s, t]) { assert.equal(c.operations.replace.roles.record.status, 'applicable'); assert.equal(c.operations.replace.roles['static entity'].status, 'undetermined'); assert.deepEqual(c.operations.replace.roles['static entity'].proofs, []); }
  // The forced delete of the entity is an observed behaviour with integrity not verified, apart from the applicability.
  for (const c of [s, t]) { const d = c.operations.delete.roles['static entity']; assert.equal(d.status, 'undetermined'); assert.equal(d.observed.integrity, 'not-verified'); assert.ok(d.observed.missing.length >= 2); assert.match(d.observed.caution, /not the normal path/); assert.deepEqual(d.observed.proofs, ['static-record-refactor']); }
  assert.equal(s.operations.delete.roles.record.status, 'conditional'); assert.deepEqual(s.operations.delete.roles.record.proofs, ['static-record-refactor']);
  assert.doesNotMatch(s.operations.delete.route, /force/); assert.ok(s.operations.delete.preconditions.some(p => /not a proven path/.test(p)));
  const st = forOdc.find(c => c.id === 'data.structure');
  assert.equal(st.operations.duplicate.roles.structure.status, 'applicable'); assert.equal(st.operations.duplicate.roles['structure attribute'].status, 'undetermined');
  assert.equal(st.operations.replace.roles.structure.status, 'applicable'); assert.equal(st.operations.replace.roles.structure.observed.integrity, 'not-verified'); assert.match(st.operations.replace.roles.structure.observed.behaviour, /anonymous/);
  assert.ok(s.differences.some(d => /IStaticEntityRecord/.test(d)) && s.otherLaneDifferences.o11.some(d => /IRecord/.test(d)));
  assert.ok(!('platforms' in s) && !('platforms' in t), 'the other lane\'s blocks are not carried');
});

test('validation refuses an operation not stated per role, an unknown status, an applicable role without proof, an undeclared role, an undetermined role that lists proofs, an observed behaviour without integrity/missing, a missing job and a native type absent from the runtime', () => {
  const contracts = { spec: { shapes: { static: ['name'] } }, verbs: { verbs: { create: {} } } };
  const jobs = [{ name: 'static-entity' }, { name: 'static-record-refactor' }]; const negatives = [{ name: 'move-static-record' }];
  const base = { schemaVersion: 'ssam-discovery-capabilities/1', lane: 'odc', capabilities: [{ id: 'x', category: 'data', title: 't', keywords: ['k'], summary: 's', route: { kind: 'job' }, contract: ['spec.shapes.static'], proofs: { odc: ['static-entity'] }, depends: [], alternatives: [], native: [ENT, REC_ODC],
    elements: [{ role: 'static entity', native: ENT }, { role: 'record', native: REC_ODC }],
    operations: { create: { roles: { 'static entity': { status: 'applicable', proofs: ['static-entity'] } } }, move: { roles: { record: { status: 'not-applicable', negative: ['move-static-record'] }, 'static entity': { status: 'undetermined' } } },
      delete: { roles: { 'static entity': { status: 'undetermined', observed: { behaviour: 'force breaks the anonymous record', integrity: 'not-verified', missing: ['cleanup'], proofs: ['static-record-refactor'] } } } } } }] };
  assert.deepEqual(validateDescriptor(base, { contracts, jobs, negatives, nativeRuntime: { [ENT]: { found: true }, [REC_ODC]: { found: true } } }), []);
  const bad = structuredClone(base); const ops = bad.capabilities[0].operations;
  ops.create.roles['static entity'].status = 'works'; ops.set = { status: 'applicable', proofs: ['static-entity'] }; ops.move.roles.record.negative = ['ghost'];
  ops.rename = { roles: { attribute: { status: 'applicable', proofs: [] }, record: { status: 'undetermined', proofs: ['static-entity'] } } };
  ops.delete.roles['static entity'].observed = { behaviour: 'x', integrity: 'verified', missing: [], proofs: [] };
  const problems = validateDescriptor(bad, { contracts, jobs, negatives, nativeRuntime: { [ENT]: { found: false, candidates: ['OutSystems.Model.Extensions.IStaticEntity'] }, [REC_ODC]: { found: true } } });
  for (const expected of ['unknown status works', 'operation set has no roles', "role 'attribute' is not a declared element role", "role 'attribute' is applicable without a proof job", "role 'record' is undetermined but lists proof jobs", 'negative job not found: ghost', 'observed must carry integrity: not-verified', 'observed without what is missing', 'observed without the job that ran it', `native type ${ENT} not found`]) assert.ok(problems.some(p => p.includes(expected)), expected + ' not reported: ' + problems.join('\n'));
});

test('a stamp without a lane fixture (O11) is current when the declared base, kernel, IDE and assemblies match; a lane with a fixture still requires it', () => {
  const stamp = { schema: 'anvil-job-provenance/2', jobSha256: 'j', kernelSha256: 'k', ideVersion: '11.55.87.65162', fixtureSha256: null, base: 'tests/fixtures/blank-service.oml', baseKind: 'fixture', baseSha256: 'b', nativeAssemblies: { 'OutSystems.Model.V1.dll': 'h' } };
  const job = { name: 'static-entity', sha256: 'j', base: 'tests/fixtures/blank-service.oml', executed: { accepted: true, provenance: stamp, current: false, mismatches: [] } };
  const current = { fixtureSha256: null, kernelSha256: 'k', ideVersion: '11.55.87.65162', assemblyHash: () => 'h', baseHash: () => 'b' };
  const [o11Job] = classifyExecutions([structuredClone(job)], current);
  assert.equal(o11Job.executed.current, true, o11Job.executed.mismatches.join(' | '));
  const [odcJob] = classifyExecutions([structuredClone(job)], { ...current, fixtureSha256: 'f' });
  assert.equal(odcJob.executed.current, false); assert.ok(odcJob.executed.mismatches.some(m => /fixtureSha256: absent from the stamp/.test(m)));
  const [drifted] = classifyExecutions([structuredClone(job)], { ...current, baseHash: () => 'other' });
  assert.ok(drifted.executed.mismatches.some(m => /baseSha256/.test(m)));
});

test('evidence is computed per role from the role\'s qualified type only: a record replace proof never promotes the entity, a structure duplicate proof never promotes the attribute, even when the same job is declared as their proof', () => {
  const index = fakeIndex('odc', ODC_RESULTS);
  const ops = operationsOf(index, cap(index, 'data.static'));
  assert.equal(ops.replace.roles.record.evidence, 'proven-current'); assert.equal(ops.replace.roles.record.verifiedQualified, 'yes');
  assert.deepEqual(ops.replace.roles.record.proofs[0].verified.verbs, ['replace']); assert.ok(ops.replace.roles.record.proofs[0].verified.via.includes('ledger-qualified'));
  assert.equal(ops.replace.roles['static entity'].evidence, 'undetermined'); assert.equal(ops.replace.roles['static entity'].level, 'undetermined');
  assert.equal(ops.replace.summary.coverage, 'partial'); assert.deepEqual(ops.replace.summary.proven, ['record']); assert.ok(ops.replace.summary.undetermined.includes('static entity'));
  assert.match(ops.replace.summary.text, /partial coverage on odc: proven \(current\) on record; undetermined on static entity/);
  // Tampering: the same job declared as the entity's replace proof does not verify (the ledger names replace on the record type only).
  const tampered = structuredClone(cap(index, 'data.static')); tampered.operations.replace.roles['static entity'] = { ...tampered.operations.replace.roles['static entity'], status: 'applicable', proofs: ['static-record-refactor'] };
  const t = operationsOf(index, tampered).replace.roles['static entity'];
  assert.equal(t.evidence, 'declared-not-proven'); assert.equal(t.level, 'declared'); assert.match(t.verifiedQualified, /^no \(no executed result names replace on OutSystems\.Model\.Data\.IStaticEntity\)/); assert.equal(t.proofs[0].verified, undefined);
  const sops = operationsOf(index, cap(index, 'data.structure'));
  assert.equal(sops.duplicate.roles.structure.evidence, 'proven-current'); assert.equal(sops.duplicate.roles['structure attribute'].evidence, 'undetermined');
  const tampered2 = structuredClone(cap(index, 'data.structure')); tampered2.operations.duplicate.roles['structure attribute'] = { ...tampered2.operations.duplicate.roles['structure attribute'], status: 'applicable', proofs: ['structure-refactor'] };
  assert.equal(operationsOf(index, tampered2).duplicate.roles['structure attribute'].evidence, 'declared-not-proven');
  // Move on the attribute is proven; on the structure it stays undetermined although IStructure ran other verbs in the same job.
  assert.equal(sops.move.roles['structure attribute'].evidence, 'proven-current'); assert.equal(sops.move.roles.structure.evidence, 'undetermined');
});

test('a proof is restricted to its lane and to the execution identity: an ODC result never proves O11, and a historical result never reads as current', () => {
  const odcIndex = fakeIndex('odc', ODC_RESULTS);
  const o11Index = fakeIndex('o11', {}); // no O11 result on this machine: the same job names prove nothing here
  assert.equal(operationsOf(odcIndex, cap(odcIndex, 'data.static')).replace.roles.record.evidence, 'proven-current');
  const o = operationsOf(o11Index, cap(o11Index, 'data.static')).replace.roles.record;
  assert.equal(o.evidence, 'declared-not-proven'); assert.equal(o.level, 'C-suite'); assert.equal(o.verifiedQualified, 'n/a (no executed result)'); assert.equal(o.native, REC_O11);
  // An O11 result whose ledger names IRecord proves the O11 role; the ODC type name in that ledger would not.
  const o11Proven = fakeIndex('o11', { 'static-record-refactor': { ledger: { [REC_O11]: { shortType: 'IRecord', verbs: ['delete', 'replace'], props: [] } }, executions: [] } });
  assert.equal(operationsOf(o11Proven, cap(o11Proven, 'data.static')).replace.roles.record.evidence, 'proven-current');
  const o11Wrong = fakeIndex('o11', { 'static-record-refactor': { ledger: { [REC_ODC]: { shortType: 'IStaticEntityRecord', verbs: ['delete', 'replace'], props: [] } }, executions: [] } });
  assert.equal(operationsOf(o11Wrong, cap(o11Wrong, 'data.static')).replace.roles.record.evidence, 'declared-not-proven');
  const historical = fakeIndex('odc', ODC_RESULTS, { current: false });
  const h = operationsOf(historical, cap(historical, 'data.static'));
  assert.equal(h.replace.roles.record.evidence, 'proven-historical'); assert.equal(h.replace.roles.record.level, 'C-executed-historical'); assert.equal(h.replace.roles.record.proofs[0].mismatches, 1);
  assert.equal(h.replace.summary.coverage, 'none'); assert.deepEqual(h.replace.summary.historical, ['record']); assert.deepEqual(h.replace.summary.proven, []); assert.match(h.replace.summary.text, /historical evidence only on record/); assert.doesNotMatch(h.replace.summary.text, /proven \(current\)/);
  assert.equal(h.delete.roles['static entity'].observed.ran[0].level, 'C-executed-historical');
});

test('the forced delete of a static entity is an observed behaviour with integrity not verified and is never a proven or recommended path; the delete of a record without consumers keeps its proof', () => {
  const index = fakeIndex('odc', ODC_RESULTS);
  const d = operationsOf(index, cap(index, 'data.static')).delete;
  const entity = d.roles['static entity'];
  assert.equal(entity.status, 'undetermined'); assert.equal(entity.evidence, 'undetermined'); assert.deepEqual(entity.proofs, []);
  assert.equal(entity.negative[0].job, 'delete-static-entity-in-use');
  assert.equal(entity.observed.integrity, 'not-verified'); assert.match(entity.observed.caution, /not the normal path/); assert.match(entity.observed.note, /never a recommendation/);
  assert.deepEqual(entity.observed.ran, [{ job: 'static-record-refactor', level: 'C-executed-current', ops: [{ i: 15, verb: 'delete', fact: { brokenConsumers: 1, force: true } }] }]);
  assert.ok(entity.observed.missing.some(m => /publication/.test(m)) && entity.observed.missing.some(m => /Verify/.test(m)));
  assert.doesNotMatch(d.route, /force/);
  assert.ok(!d.summary.proven.includes('static entity') && !d.summary.conditional.includes('static entity')); assert.match(d.summary.text, /undetermined on static entity \(observed: not-verified integrity\)/);
  const record = d.roles.record;
  assert.equal(record.status, 'conditional'); assert.equal(record.evidence, 'proven-current'); assert.equal(record.level, 'C-executed-current');
  assert.deepEqual(record.proofs[0].verified.ops, [{ i: 7, verb: 'delete', fact: { brokenConsumers: 0, force: false } }]); assert.equal(record.negative[0].job, 'delete-static-record-in-use');
  assert.deepEqual(d.summary.conditional, ['record']); assert.equal(d.summary.coverage, 'partial');
  // Structure replace: repointing proven, cleanup observed only; the delete after replace keeps its proof and its leftover.
  const s = operationsOf(index, cap(index, 'data.structure'));
  assert.equal(s.replace.roles.structure.evidence, 'proven-current'); assert.equal(s.replace.roles.structure.observed.integrity, 'not-verified'); assert.match(s.replace.roles.structure.observed.caution, /cleanup is not/);
  assert.equal(s.delete.roles.structure.evidence, 'proven-current'); assert.equal(s.delete.roles.structure.observed.integrity, 'not-verified'); assert.match(s.delete.summary.text, /structure \(observed: not-verified integrity\)/);
});

test('the intent focuses the element role it names (a child role over its container) and the operation; without a role, compact options are listed; under a reduced budget the answer keeps status, evidence, summary and the integrity caution', () => {
  const index = fakeIndex('odc', ODC_RESULTS); const c = cap(index, 'data.static');
  const f1 = focusOf(c, terms('renomear um registo de uma static entity existente e apagar o registo antigo'));
  assert.deepEqual(f1.roles, ['record']); assert.deepEqual(f1.ops.slice(0, 2), ['delete', 'rename']); assert.equal(f1.options, undefined);
  const f2 = focusOf(c, terms('reapontar as referências da static entity Status para outra'));
  assert.deepEqual(f2.roles, ['static entity']); assert.deepEqual(f2.ops, ['replace']);
  const f3 = focusOf(c, terms('reapontar e apagar'));
  assert.deepEqual(f3.roles, []); assert.deepEqual(f3.options.map(o => o.role), ['static entity', 'record', 'record value', 'entity attribute']); assert.match(f3.note, /does not name the element role/);
  const st = cap(index, 'data.structure');
  assert.deepEqual(focusOf(st, terms('apagar um atributo da estrutura')).roles, ['structure attribute']); assert.deepEqual(focusOf(st, terms('duplicar a estrutura')).roles, ['structure']);
  // The focused roles and operations come first in the answer.
  const ops = operationsOf(index, c, { focus: f1 });
  assert.deepEqual(Object.keys(ops).slice(0, 2), ['delete', 'rename']); assert.equal(Object.keys(ops.delete.roles)[0], 'record');
  // Query composition carries the focus and the evidence rule; the budget reduction keeps what must not be lost.
  const q = query(index, { intent: 'reapontar um registo de uma static entity e apagar o registo antigo' });
  const m = q.matches.find(x => x.id === 'data.static');
  assert.ok(m && m.via === 'match'); assert.deepEqual(m.focus.roles, ['record']); assert.match(m.evidenceRule, /never counts for another/);
  const answer = { ok: true, matches: q.matches, contracts: {}, examples: {}, bindings: [], expansions: {} };
  const reduced = applyBudget(structuredClone(answer), 6000);
  assert.ok(reduced.size.truncated.some(t => t.section === 'matches.operations'), JSON.stringify(reduced.size.truncated));
  const r = reduced.matches.find(x => x.id === 'data.static').operations;
  assert.equal(r.delete.roles['static entity'].status, 'undetermined'); assert.equal(r.delete.roles['static entity'].evidence, 'undetermined'); assert.equal(r.delete.roles['static entity'].observed.integrity, 'not-verified'); assert.match(r.delete.roles['static entity'].observed.caution, /not the normal path/);
  assert.equal(r.delete.roles.record.evidence, 'proven-current'); assert.match(r.delete.summary, /undetermined on static entity \(observed: not-verified integrity\)/);
  assert.equal(r.replace.roles['static entity'].evidence, 'undetermined');
  // Phase 3: the operations the intent did not name leave the answer by name (operationsOmitted) before the focused
  // ones are compacted; the refusal alternative of `move` is one expansion away.
  const mm = reduced.matches.find(x => x.id === 'data.static');
  assert.ok(mm.operationsOmitted.includes('move') && r.move === undefined, JSON.stringify(mm.operationsOmitted));
  assert.deepEqual(Object.keys(r).sort(), ['delete', 'replace'].sort());
  assert.equal(operationsOf(index, c).move.roles.record.alternative, 'set <record>/Order prop Value');
  assert.equal(r.delete.roles.record.proofs, undefined, 'proof records are the part the expansion returns');
});

test('the ODC index merges the shared capabilities, reads their native types from the installed Studio and answers the pilot family per role and lane through the public discovery entry', { skip: !odcCli && 'anvil-odc CLI not built', timeout: 180000 }, async () => {
  const { index } = await buildIndex('odc', { sources: odc });
  // Phase 3 added the entity family to the two pilot families; the lane's own count comes from its descriptor file.
  assert.deepEqual(index.shared.capabilities, ['data.static', 'data.structure', 'data.entity']);
  const laneOwn = JSON.parse(fs.readFileSync(odc.descriptor, 'utf8').replace(/^﻿/, '')).capabilities.length;
  assert.equal(index.identity.descriptor.laneCapabilities, laneOwn); assert.equal(index.capabilities.length, laneOwn + 3);
  assert.ok(!index.capabilities.some(c => ['data.edit', 'data.entity'].includes(c.id) && !c.shared), 'the lane descriptor no longer carries its own entity capabilities');
  const rec = index.nativeRuntime[REC_ODC];
  assert.equal(rec.found, true); assert.ok(rec.writable.includes('Identifier') && !rec.writable.includes('Name'), JSON.stringify(rec.writable));
  assert.equal(rec.ideVersion, index.identity.studio.ideVersion);
  assert.ok(index.nativeRuntime[ATTR].bases.some(b => /Types\.IAttribute$/.test(b)));
  const srr = index.jobs.find(j => j.name === 'static-record-refactor');
  const executedLevel = srr.executed?.current ? 'proven-current' : srr.executed ? 'proven-historical' : 'declared-not-proven';
  // (the force broke the generated '<X> Record' until coverage phase 2; the kernel now spares that companion: 0 broken)
  assert.ok(srr.executed?.executions?.some(x => x.verb === 'delete' && x.iface === ENT && x.fact.force === true && x.fact.brokenConsumers === 0), 'the forced entity delete is attributed to IStaticEntity');
  const answer = await discover({ lane: 'odc', intent: 'reapontar um registo de uma static entity para outro registo e apagar o registo antigo', sources: odc, budgetBytes: 80000 });
  assert.equal(answer.ok, true);
  const m = answer.matches.find(x => x.id === 'data.static');
  assert.ok(m && m.via === 'match' && m.shared === true, 'data.static is a direct shared match');
  assert.deepEqual(m.focus.roles, ['record']); assert.ok(m.focus.ops.includes('replace') && m.focus.ops.includes('delete'));
  assert.equal(m.operations.replace.roles.record.evidence, executedLevel); assert.equal(m.operations.replace.roles['static entity'].evidence, 'undetermined');
  assert.equal(m.operations.delete.roles.record.status, 'conditional'); assert.equal(m.operations.delete.roles.record.evidence, executedLevel);
  const entity = m.operations.delete.roles['static entity'];
  assert.equal(entity.status, 'undetermined'); assert.equal(entity.observed.integrity, 'not-verified'); assert.equal(entity.observed.ran[0].ops[0].fact.force, true); assert.deepEqual(entity.negative.map(n => n.job), ['delete-static-entity-in-use']);
  assert.equal(m.operations.rename.roles.record.status, 'conditional'); assert.deepEqual(m.operations.rename.roles.record.negative.map(n => n.job), ['rename-static-record', 'set-identifier-clash']);
  assert.ok(m.operations.rename.roles.record.negative[0].refuses.some(r => /clashes with an existing name/.test(r)));
  assert.equal(m.operations.move.roles.record.status, 'not-applicable'); assert.equal(m.operations.move.roles.record.level, 'refusal-proven');
  assert.ok(m.native.some(n => n.native === REC_ODC && n.runtime?.writable?.includes('Identifier')));
  assert.ok(m.differences.odc.length && m.differences.o11.length);
  assert.equal(answer.coverage.laneSpecific, laneOwn); assert.deepEqual(answer.coverage.shared, ['data.static', 'data.structure', 'data.entity']);
  // The example is scoped to the focused role: only ops the executed result attributes to the record type, no force.
  const ex = answer.examples['data.static'];
  // (the snapshot always carries the executions of static-record-refactor, so the scoped example is always checked)
  assert.equal(ex.scope.role, 'record'); assert.equal(ex.scope.native, REC_ODC); assert.ok(ex.ops.length > 0 && ex.ops.every(o => !o.force && ['replace', 'delete', 'usages', 'get', 'dump'].includes(o.op)), JSON.stringify(ex.ops)); assert.match(ex.note, /scoped to the focused roles/);
  // Under a small budget the answer still says what is undetermined and what is observed with integrity not verified.
  const small = await discover({ lane: 'odc', intent: 'reapontar um registo de uma static entity para outro registo e apagar o registo antigo', sources: odc, budgetBytes: 12000 });
  assert.ok(small.size.truncated.some(t => t.section === 'matches.operations'));
  const sm = small.matches.find(x => x.id === 'data.static');
  assert.equal(sm.operations.replace.roles['static entity'].evidence, 'undetermined'); assert.equal(sm.operations.delete.roles['static entity'].observed.integrity, 'not-verified'); assert.match(sm.operations.delete.summary, /undetermined on static entity/);
  const q = query(index, { intent: 'reordenar um atributo de uma estrutura e duplicar a estrutura' });
  const st = q.matches.find(x => x.id === 'data.structure');
  assert.ok(st && st.via === 'match'); assert.equal(st.operations.move.roles['structure attribute'].status, 'applicable'); assert.equal(st.operations.duplicate.roles.structure.status, 'applicable'); assert.equal(st.operations.duplicate.roles['structure attribute'].status, 'undetermined');
  const ops = operationsOf(index, index.capabilities.find(c => c.id === 'data.structure'));
  assert.equal(Object.keys(ops).length, 9); assert.ok(Object.values(ops).every(o => o.summary && Object.values(o.roles).every(r => STATUSES.includes(r.status))));
  // The expansion returns the full per-role statement.
  const expanded = await discover({ lane: 'odc', expand: 'data.static:operations+native', sources: odc, budgetBytes: 200000 });
  assert.equal(expanded.expansions['data.static'].operations.delete.roles['static entity'].observed.integrity, 'not-verified');
});

test('the O11 index covers only the shared pilot capabilities, measures the Service Studio identity, classifies the stamped results, proves roles with IRecord evidence and never inherits ODC coverage', { skip: (!o11Cli && 'anvil.dll not built') || (!o11Pilot && 'O11 pilot jobs not authored yet'), timeout: 240000 }, async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-discovery-o11-'));
  const isolated = { ...o11, cacheDir };
  try {
    const { index } = await buildIndex('o11', { sources: isolated, rebuild: true });
    assert.equal(index.lane, 'o11'); assert.equal(index.identity.studio.platform, 'ss11'); assert.match(String(index.identity.studio.ideVersion), /^11\./);
    assert.equal(index.identity.descriptor.laneCapabilities, 0); assert.deepEqual(index.capabilities.map(c => c.id), ['data.static', 'data.structure', 'data.entity']);
    assert.equal(index.identity.fixture.available, null);
    assert.equal(index.nativeRuntime[REC_O11].found, true); assert.ok(index.nativeRuntime[REC_O11].writable.includes('Identifier'));
    const stamped = index.jobs.filter(j => j.executed?.provenance);
    assert.ok(stamped.length >= 7, 'stamped O11 results: ' + stamped.length);
    for (const j of stamped) { assert.equal(j.executed.provenance.platform, 'ss11'); assert.equal(j.executed.provenance.fixtureSha256, null); assert.ok(j.executed.provenance.baseSha256 || j.executed.provenance.baseKind === 'job', j.name); }
    const se = index.jobs.find(j => j.name === 'static-entity');
    assert.ok(se.executed?.coverageQualified?.[REC_O11]?.verbs.includes('create'), 'qualified ledger names IRecord on O11');
    const none = await discover({ lane: 'o11', intent: 'formulário com dropdown pesquisável, carregar dados e salvar', sources: isolated });
    assert.equal(none.ok, true); assert.ok(!none.matches.some(m => m.via === 'match'), JSON.stringify(none.matches.map(m => m.id + ':' + m.via))); assert.match(none.hint, /covers only the shared capabilities data.static, data.structure, data.entity/);
    assert.equal(none.coverage.laneSpecific, 0);
    const answer = await discover({ lane: 'o11', intent: 'renomear um registo de uma static entity existente e apagar o registo antigo', sources: isolated, budgetBytes: 80000 });
    const m = answer.matches.find(x => x.id === 'data.static');
    assert.ok(m && m.shared === true); assert.deepEqual(m.focus.roles, ['record']);
    assert.ok(m.proofs.every(p => index.jobs.some(j => j.name === p.job)), 'O11 proofs are O11 jobs');
    const srr = index.jobs.find(j => j.name === 'static-record-refactor'); const level = srr.executed?.current ? 'proven-current' : 'proven-historical';
    assert.equal(m.operations.rename.roles.record.evidence, level); assert.deepEqual(m.operations.rename.roles.record.proofs[0].verified.verbs, ['set']);
    assert.equal(m.operations.delete.roles.record.evidence, level); assert.equal(m.operations.delete.roles.record.native, REC_O11);
    assert.equal(m.operations.delete.roles['static entity'].status, 'undetermined'); assert.equal(m.operations.delete.roles['static entity'].observed.integrity, 'not-verified'); assert.equal(m.operations.delete.roles['static entity'].otherLanes.odc.status, 'undetermined');
    assert.equal(m.operations.replace.roles['static entity'].evidence, 'undetermined');
    assert.ok(m.native.some(n => n.native === REC_O11 && n.otherLanes.odc === REC_ODC));
    assert.ok(m.differences.o11.some(d => /IEnumerable|IRecord/.test(d)));
    // The delivery call leads (it validates inside itself); the headless proof is only for a person who asks for one.
    assert.deepEqual(Object.keys(answer.validation), ['deliver', 'publish', 'gates', 'prove']);
    assert.equal(answer.validation.deliver, 'o11_deliver {module, job, checks, authorize}  (directly: validates inside, refuses before any change)');
    assert.equal(answer.validation.prove, 'ssam_job {lane:"o11", job:"<job.json>"}  (only when the person asks for a headless proof on the base the job declares, or base: <capture.oml>; delivers nothing)');
    const structure = await discover({ lane: 'o11', intent: 'duplicar uma estrutura e reapontar os consumidores para a cópia', sources: isolated, budgetBytes: 80000 });
    const s = structure.matches.find(x => x.id === 'data.structure');
    assert.deepEqual(s.focus.roles, ['structure']); assert.equal(s.operations.duplicate.roles.structure.evidence, level); assert.equal(s.operations.duplicate.roles['structure attribute'].evidence, 'undetermined');
    assert.equal(s.operations.replace.roles.structure.observed.integrity, 'not-verified'); assert.match(s.operations.replace.roles.structure.observed.behaviour, /orphan/);
    assert.ok(srr.executed?.executions, 'the snapshot carries the O11 executions of static-record-refactor');
    assert.equal(structure.examples['data.structure'].scope.role, 'structure'); assert.ok(structure.examples['data.structure'].ops.every(o => ['duplicate', 'replace', 'usages', 'get', 'dump'].includes(o.op)));
  } finally { fs.rmSync(cacheDir, { recursive: true, force: true }); }
});

 test('ODC-only capabilities keep their declared lane and do not appear on O11', () => {
 const restricted = structuredClone(shared);
 restricted.capabilities = [{...restricted.capabilities[0], lanes: ['odc']}];
 assert.deepEqual(projectShared(restricted, 'odc')[0].lanes, ['odc']);
 assert.deepEqual(projectShared(restricted, 'o11'), []);
});
