// Focused checks of the phase-1 coverage extractor (identity, ambiguity, inheritance, signatures, correspondence,
// IWebScreen on ODC, pilot family). Pure over the checked-in metadata; no reader, no CLI, no long suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { wt, loadOdcNative, loadO11Native, loadVerbTable, staticSuiteScan, attributor, metadataFor, statusFor, buildMatrix, correspondence } from '../coverage-inventory.mjs';

const odc = loadOdcNative();
const o11 = loadO11Native();
const byName = (n, q) => n.types.find(t => t.name === q);
const model = ns => [
  { namespace: 'OutSystems.Model', name: 'IModelObject', kind: 'interface', bases: [], members: [{ kind: 'method', signature: 'void Delete()' }] },
  { namespace: 'OutSystems.Model', name: 'IObjectSignature', kind: 'interface', bases: ['IModelObject'], members: [] },
  { namespace: 'OutSystems.Model', name: 'IObject', kind: 'interface', bases: ['IObjectSignature'], members: [] },
  ...ns,
];

test('type identity is qualified: short-name collisions are kept apart, not merged', () => {
  const sigs = odc.types.filter(t => t.shortName === 'IStaticEntityRecordSignature');
  assert.equal(sigs.length, 2, 'Data and Signatures variants are both inventoried');
  assert.deepEqual(sigs.map(s => s.namespace).sort(), ['OutSystems.Model.Data', 'OutSystems.Model.Signatures']);
  assert.notEqual(sigs[0].id, sigs[1].id);
  const bySig = Object.fromEntries(sigs.map(s => [s.namespace, s]));
  assert.equal(bySig['OutSystems.Model.Signatures'].nameWritable, 'own');
  assert.equal(bySig['OutSystems.Model.Data'].nameWritable, 'none', 'the Data variant does not inherit the Signatures variant metadata');
  for (const s of sigs) assert.equal(s.shortNameCandidatesInventoried, 2);
  const sa = byName(odc, 'OutSystems.Model.Data.IStructureAttribute');
  assert.equal(sa.shortNameCandidatesInIndex, 3, 'Data, Extensions and ExternalLibraries variants exist in the index');
  assert.equal(sa.shortNameCandidatesInventoried, 1, 'only the Data variant reaches IObject');
  assert.ok(odc.collisions.list.some(c => c.short === 'IStructureAttribute' && c.qualified.length === 3));
  assert.match(odc.rule, /no de-duplication/);
});

test('an ambiguous base or factory return type is recorded and not followed; enclosing namespace resolves like C#', () => {
  const raw = model([
    { namespace: 'X.One', name: 'IFoo', kind: 'interface', bases: ['IObject'], members: [{ kind: 'property', signature: 'string Name { get; set; }' }] },
    { namespace: 'X.Two', name: 'IFoo', kind: 'interface', bases: ['IObject'], members: [] },
    { namespace: 'X.Three', name: 'IBar', kind: 'interface', bases: ['IFoo'], members: [] },
    { namespace: 'X.Root', name: 'IParent', kind: 'interface', bases: ['IObject'], members: [{ kind: 'method', signature: 'IFoo CreateFoo(string name = null)' }] },
    { namespace: 'X', name: 'IBaz', kind: 'interface', bases: ['IObject'], members: [] },
    { namespace: 'X.Two', name: 'IBaz', kind: 'interface', bases: ['IObject'], members: [] },
    { namespace: 'X.Two.Deep', name: 'IQux', kind: 'interface', bases: ['IBaz'], members: [] },
  ]);
  const n = loadOdcNative({ raw, version: 'test' });
  const bar = byName(n, 'X.Three.IBar');
  assert.equal(bar.ambiguousBases.length, 1); assert.equal(bar.ambiguousBases[0].short, 'IFoo'); assert.equal(bar.ambiguousBases[0].candidates.length, 2);
  assert.ok(!bar.bases.some(b => /IFoo$/.test(b.type)), 'neither IFoo candidate is followed');
  assert.equal(bar.role, 'object'); assert.match(bar.roleBasis, /all candidates .* agree/);
  assert.equal(bar.nameWritable, 'none', 'members of an ambiguous base are not merged');
  for (const q of ['X.One.IFoo', 'X.Two.IFoo']) { const t = byName(n, q); assert.equal(t.factories.length, 0); assert.equal(t.factoriesAmbiguous.length, 1); assert.equal(metadataFor(t, 'create').status, 'ambiguous'); }
  const qux = byName(n, 'X.Two.Deep.IQux');
  assert.deepEqual(qux.bases.find(b => /IBaz$/.test(b.type)), { type: 'X.Two.IBaz', resolvedBy: 'enclosing-namespace' });
});

test('evidence keyed by short name is attributed only by the printed rule; ambiguous short names attribute to no type', () => {
  const fake = [
    { id: 'a', shortName: 'IX', namespace: 'OutSystems.Model.Data', name: 'OutSystems.Model.Data.IX' },
    { id: 'b', shortName: 'IX', namespace: 'OutSystems.Model.Extensions', name: 'OutSystems.Model.Extensions.IX' },
    { id: 'c', shortName: 'IY', namespace: 'OutSystems.Model.UI.Mobile', name: 'OutSystems.Model.UI.Mobile.IY' },
    { id: 'd', shortName: 'IY', namespace: 'OutSystems.Model.UI.Web', name: 'OutSystems.Model.UI.Web.IY' },
    { id: 'e', shortName: 'IZ', namespace: 'OutSystems.Model.Logic', name: 'OutSystems.Model.Logic.IZ' },
  ];
  const attribute = attributor(fake);
  assert.equal(attribute('IZ').attribution, 'exact');
  assert.deepEqual([attribute('IX').attribution, attribute('IX').id], ['module-context', 'a']);
  assert.deepEqual([attribute('IX', { op: 'create' }).attribution, attribute('IX', { op: 'create' }).id], ['kernel-rank', 'a']);
  const y = attribute('IY'); assert.equal(y.attribution, 'ambiguous'); assert.equal(y.id, undefined); assert.equal(y.candidates.length, 2);
  assert.equal(attribute('IY', { op: 'create' }).attribution, 'ambiguous', 'UI.Mobile and UI.Web have the same kernel rank');
  const real = attributor(odc.types);
  const collided = odc.collisions.list.find(c => c.inventoried.length > 1 && real(c.short).attribution === 'ambiguous');
  assert.ok(collided, 'at least one real ODC collision stays ambiguous');
  assert.equal(real('IStructure').attribution, 'exact', 'only the Data variant is inventoried');
});

test('inherited operations are suggestions, never applicability; refusals and missing proofs keep their status', () => {
  const rec = byName(odc, 'OutSystems.Model.Data.IStaticEntityRecord');
  assert.ok(rec, 'IStaticEntityRecord exists in the ODC inventory (it was lost by the old short-name dedupe)');
  assert.equal(metadataFor(rec, 'delete').status, 'suggests-inherited');
  assert.equal(metadataFor(rec, 'move').status, 'suggests-inherited');
  assert.equal(metadataFor(rec, 'duplicate').status, 'suggests-inherited');
  const rename = metadataFor(rec, 'rename');
  assert.equal(rename.status, 'no-basis'); assert.deepEqual(rename.sources, ['Identifier']);
  assert.equal(rec.identifierWritable, true);
  const route = { kind: 'generic-verb', verbs: ['rename'] };
  assert.equal(statusFor(rename, route, { attribution: 'exact', attributedToThisType: true, refusal: ['IStaticEntityRecord e o verbo rename'] }).status, 'refused-proven');
  assert.equal(statusFor(metadataFor(rec, 'delete'), { kind: 'generic-verb', verbs: ['delete'] }, { attribution: 'exact', attributedToThisType: true }).status, 'route-only');
  assert.equal(statusFor(metadataFor(rec, 'delete'), { kind: 'generic-verb', verbs: ['delete'] }, { attribution: 'ambiguous', attributedToThisType: false, candidates: ['p', 'q'], executed: { verbs: ['delete'], jobs: ['j'] } }).status, 'undetermined');
  const ent = byName(odc, 'OutSystems.Model.Data.IStaticEntity');
  assert.equal(ent.nameWritable, 'inherited'); assert.equal(metadataFor(ent, 'rename').status, 'suggests-inherited');
  assert.equal(ent.kindClass, 'concrete-authorable'); assert.match(ent.factories[0].factory, /IESpace\.CreateStaticEntity$/); assert.equal(ent.factories[0].resolvedBy, 'module-context');
});

test('a referenced signature never inherits the producer edit permissions', () => {
  const sig = byName(odc, 'OutSystems.Model.Signatures.IStructureAttributeSignature');
  assert.ok(sig.writableOwn.includes('DataType') && sig.writableOwn.includes('Name'), 'metadata lists writable properties');
  assert.equal(sig.kindClass, 'referenced-signature');
  for (const op of ['create', 'set', 'rename', 'move', 'duplicate', 'delete']) assert.equal(metadataFor(sig, op).status, 'context-excluded', op);
  for (const op of ['read', 'address']) assert.equal(metadataFor(sig, op).status, 'suggests', op);
  assert.notEqual(metadataFor(sig, 'usages').status, 'context-excluded');
});

test('ODC/O11 correspondence has no verified level and the ODC descriptor is not O11 exposure', () => {
  const native = { odc, o11 };
  const corr = correspondence(native);
  assert.equal(corr.levels.verifiedContractEquivalence.pairs, 0);
  assert.ok(corr.levels.sameQualifiedName.pairs > 0 && corr.levels.sameQualifiedName.pairs <= corr.levels.sameShortName.odcO11Pairs);
  const odcEnt = byName(odc, 'OutSystems.Model.Data.IStaticEntity'); const o11Ent = byName(o11, 'OutSystems.Model.Data.IStaticEntity');
  assert.ok(corr.sameQualifiedPairs.some(([a, b]) => a === odcEnt.id && b === o11Ent.id));
  assert.equal(o11.types.some(t => t.shortName === 'IStaticEntityRecord'), false, 'the O11 catalog has no IStaticEntityRecord');
  const small = { odc: { ...odc, types: [odcEnt] }, o11: { ...o11, types: [o11Ent] } };
  const descriptor = { lane: 'odc', capabilities: 1, ids: new Set(['cap.x']), exposure: { IStaticEntity: { direct: ['cap.x'], viaProofs: [] } } };
  const ledger = { odc: { byShort: {}, byQualified: { 'OutSystems.Model.Data.IStaticEntity': { verbs: ['set'], props: ['Description'], jobs: ['j'], current: 1, historical: 0 } } }, o11: { byShort: {}, byQualified: {} } };
  const rows = buildMatrix({ native: small, verbs: loadVerbTable(), mentions: {}, builder: { byType: {} }, limits: [], descriptors: { odc: descriptor, o11: null }, ledger, statics: { odc: { perType: {} }, o11: { perType: {} } }, census: null, contracts: { namedTypes: {} } });
  const odcRow = rows.find(r => r.platform === 'odc' && r.op === 'set'); const o11Row = rows.find(r => r.platform === 'o11' && r.op === 'set');
  assert.deepEqual(odcRow.exposure.capabilities, ['cap.x']); assert.equal(odcRow.exposure.attributedToThisType, true);
  assert.equal(odcRow.proven.attribution, 'ledger-qualified'); assert.equal(odcRow.status, 'tested-executed', 'a qualified ledger entry attributes the proof to the exact type');
  assert.equal(o11Row.exposure.effective, false); assert.deepEqual(o11Row.exposure.reusePotential.sameShortNameInDescriptor, ['cap.x']);
  assert.equal(o11Row.status, 'route-only', 'no O11 proof: the ODC descriptor does not count');
});

test('IWebScreen is inventoried on ODC as a web-tagged type, not excluded; its relation to CrossDevice screens comes from the census, not from metadata', () => {
  const web = byName(odc, 'OutSystems.Model.UI.Web.IWebScreen'); const mobile = byName(odc, 'OutSystems.Model.UI.Mobile.IMobileScreen');
  assert.ok(web && mobile);
  assert.equal(web.appFamily, 'web'); assert.equal(web.role, 'object'); assert.equal(web.kindClass, 'concrete-authorable');
  assert.ok(!mobile.bases.some(b => b.type === web.name), 'metadata does not make IMobileScreen implement IWebScreen');
  assert.ok(mobile.bases.some(b => b.type === 'OutSystems.Model.UI.IScreen') && web.bases.some(b => b.type === 'OutSystems.Model.UI.IScreen'));
  const inv = path.join(wt, 'docs', 'evidence', 'descoberta-cobertura-fase1', 'inventory.json');
  if (fs.existsSync(inv)) { const c = JSON.parse(fs.readFileSync(inv, 'utf8')).census; if (c?.WebScreen && c?.MobileScreen) assert.equal(c.WebScreen.count, c.MobileScreen.count, 'the fixture screens implement both interfaces'); }
});

test('pilot family: exact qualified identifiers per platform', () => {
  const v = odc.version; const w = o11.version;
  for (const q of ['IStaticEntity', 'IStaticEntityRecord', 'IRecord', 'IStructure', 'IStructureAttribute', 'IStaticEntityRecordSignature']) assert.ok(odc.types.some(t => t.id === `odc:${v}:OutSystems.Model.V1:OutSystems.Model.Data.${q}`), 'odc ' + q);
  for (const q of ['IStaticEntity', 'IRecord', 'IStructure', 'IStructureAttribute']) assert.ok(o11.types.some(t => t.id === `o11:${w}:OutSystems.Model.Data.${q}`), 'o11 ' + q);
  const rec = byName(odc, 'OutSystems.Model.Data.IStaticEntityRecord'); const irec = byName(odc, 'OutSystems.Model.Data.IRecord');
  assert.equal(rec.factories[0].factory, 'OutSystems.Model.Data.IStaticEntity.CreateRecord'); assert.equal(rec.factories[0].resolvedBy, 'same-namespace');
  assert.equal(irec.kindClass, 'base-interface'); assert.ok(rec.bases.some(b => b.type === irec.name));
  const attr = byName(odc, 'OutSystems.Model.Data.IStructureAttribute');
  assert.equal(attr.role, 'object'); assert.equal(attr.nameWritable, 'inherited'); assert.match(attr.nameWritableFrom, /Types\.IAttribute$/);
  assert.equal(attr.factories[0].factory, 'OutSystems.Model.Data.IStructure.CreateAttribute');
  const o11Rec = byName(o11, 'OutSystems.Model.Data.IRecord'); assert.equal(o11Rec.factories[0].factory, 'OutSystems.Model.Data.IStaticEntity.CreateRecord');
  const statics = staticSuiteScan();
  assert.ok(statics.odc.perType.IRecord?.verbs.create >= 1, 'ODC jobs create records with the short name IRecord');
  assert.equal(statics.odc.perType.IStaticEntityRecord, undefined, 'no job writes IStaticEntityRecord: only the executed ledger records that kind');
});
