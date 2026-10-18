// fix/unpublished-library (family OF): the pure parts of producer-publication.mjs. The reference families are the kernel's
// (NativeReferenceKinds.cs, read here so the two never drift), an element is found in a published signature the way the
// kernel selects it (NativeReferenceSnapshot.Select: kind, then name, path or @key), and the open model's public surface
// comes from its module digest (the action index and the public flag of each block's head line, never a word of a
// description). Synthetic values only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAMILIES, familyOf, parseElement, requestedElements, signatureHas, surfaceOf, surfaceFind, classify, odcProducerModel, unpublishedRefusal, noPublicElements,
  ODC_PUBLIC_KINDS, odcExportable, odcExportableSurface } from '../producer-publication.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kinds = path.resolve(here, '..', '..', '..', '..', 'kernel', 'src', 'Anvil.Core', 'Kernel', 'NativeReferenceKinds.cs');

test('the reference families are the kernel\'s, interface and aliases (NativeReferenceKinds.cs)', () => {
  const source = fs.readFileSync(kinds, 'utf8');
  const declared = [...source.matchAll(/new Family\(([^)]*)\)/g)].map(m => [...m[1].matchAll(/"([^"]*)"/g)].map(x => x[1]))
    .map(([kind, _tag, iface, ...aliases]) => ({ kind, types: [iface, ...aliases] }));
  assert.ok(declared.length >= 18, 'the kernel file was read');
  assert.deepEqual(FAMILIES.map(f => ({ kind: f.kind, types: f.types })), declared);
});

test('a type without its Model API "I" is the family of the interface with it (NativeReferenceKinds.ForType)', () => {
  assert.equal(familyOf('ServerAction').kind, 'action');
  assert.equal(familyOf('IServerAction').kind, 'action');
  assert.equal(familyOf('ClientAction').kind, 'client-action');
  assert.equal(familyOf('IBlock').kind, 'mobile-block');
  assert.equal(familyOf('Action'), null);
  assert.deepEqual(parseElement('ServerAction:Flow/GetQuotes'), { text: 'ServerAction:Flow/GetQuotes', type: 'ServerAction', name: 'Flow/GetQuotes', family: familyOf('ServerAction') });
  assert.equal(parseElement('GetQuotes'), null);
});

test('the elements a job asks of one producer, with their pointers (reference ops only)', () => {
  const job = { ops: [{ op: 'reference', producer: 'FloodServices', elements: ['ServerAction:A', 'Structure:S'] }, { op: 'logic' },
    { op: 'reference', producer: 'Other', elements: ['ServerAction:B'] }] };
  assert.deepEqual(requestedElements(job, n => n === 'FloodServices').map(e => [e.pointer, e.family.kind, e.name]),
    [['/ops/0/elements/0', 'action', 'A'], ['/ops/0/elements/1', 'structure', 'S']]);
});

// Round 2 (review C:\t\revisoes\unpublished-lib, A4), changed expectation (declared): another letter case is another element,
// as NativeReferenceSnapshot.Select compares ordinally (the first round matched it ignoring case). A1: a kind the ODC
// signature cannot hold (a service action, a web block) is never in it.
test('a published signature has an element exactly as the kernel selects it: the ODC kind, then name, path or @key, ordinal', () => {
  const elements = [{ Kind: 'action', Name: 'GetQuotes', Key: 'k1' }, { Kind: 'block', Name: 'Card', Path: 'Common/Card', Key: 'k2' }, { Kind: 'structure', Name: 'Quote', Key: 'k3' }];
  assert.ok(signatureHas(elements, parseElement('ServerAction:GetQuotes')));
  assert.ok(!signatureHas(elements, parseElement('ServerAction:getquotes')), 'another letter case is another element (ordinal, as the kernel)');
  assert.ok(signatureHas(elements, parseElement('IBlock:Common/Card')));
  assert.ok(signatureHas(elements, parseElement('IMobileBlock:Card')));
  assert.ok(!signatureHas(elements, parseElement('IWebBlock:Card')), 'the ODC signature holds the mobile block family only');
  assert.ok(signatureHas(elements, parseElement('Structure:@k3')));
  assert.ok(!signatureHas(elements, parseElement('ServerAction:@k3')), 'a key of another kind is another element');
  assert.ok(!signatureHas(elements, parseElement('ClientAction:GetQuotes')), 'another kind is another element');
  assert.ok(!signatureHas(elements, parseElement('ServiceAction:GetQuotes')), 'a kind the ODC signature cannot hold');
  assert.ok(!signatureHas(elements, parseElement('ServerAction:CreateApplication')));
});

test('round 2 (A1): the ODC published signature holds five kinds (an External Library: two); the open model counts only those', () => {
  assert.deepEqual(ODC_PUBLIC_KINDS, ['action', 'entity', 'structure', 'block', 'client-action']);
  assert.ok(odcExportable(parseElement('ServerAction:A')) && odcExportable(parseElement('IMobileBlock:B')) && odcExportable(parseElement('ClientAction:C')));
  assert.ok(!odcExportable(parseElement('ServiceAction:A')) && !odcExportable(parseElement('Role:R')) && !odcExportable(parseElement('IWebBlock:B')) && !odcExportable(parseElement('Action:X')));
  assert.ok(odcExportable(parseElement('Structure:S'), 'ExternalLibrary') && !odcExportable(parseElement('ClientAction:C'), 'ExternalLibrary'));
  assert.ok(odcExportableSurface({ kind: 'ServerAction' }) && odcExportableSurface({ kind: 'WebBlock' }) && !odcExportableSurface({ kind: 'ServiceAction' }) && !odcExportableSurface({ kind: 'Role' }));
  assert.equal(parseElement(' ServerAction:A').family, null, 'the type is read untrimmed, as the kernel reads it');
});

test('the open model\'s public surface: the action index and the head-line flag of each block, never a description word', () => {
  const digest = { actions: [{ key: 'a1', kind: 'ServerAction', name: 'GetQuotes', public: true }, { key: 'a2', kind: 'ServerAction', name: 'Helper', public: false }],
    sections: [{ id: 'module', blocks: [{ key: 'm', kind: 'ESpace', name: 'FloodServices', text: 'ssam-digest/1 module=FloodServices' }] },
      { id: 'structures', blocks: [{ key: 's1', kind: 'Structure', name: 'CoverageAmounts', text: 'structure CoverageAmounts @s1 public "Confirmed limits."' },
        { key: 's2', kind: 'Structure', name: 'QuoteIdentity', text: 'structure QuoteIdentity @s2 "Kept out of the public signature."' }] },
      { id: 'actions', blocks: [{ key: 'a1', kind: 'ServerAction', name: 'GetQuotes', text: 'server action GetQuotes @a1 public' }] }] };
  const surface = surfaceOf(digest);
  assert.deepEqual(surface.map(s => [s.name, s.public]), [['GetQuotes', true], ['Helper', false], ['CoverageAmounts', true], ['QuoteIdentity', false]]);
  // Round 2 (A4), changed expectation (declared): the first round found a path by its last segment (and ignored letter
  // case); the kernel does neither, so that is a spelling problem with the right spelling, never the element itself.
  assert.equal(surfaceFind(surface, parseElement('ServerAction:Flow/GetQuotes')), null, 'a path is not found by its last segment');
  assert.equal(surfaceFind(surface, parseElement('ServerAction:getQuotes')), null, 'nor by another letter case');
  assert.equal(surfaceFind(surface, parseElement('ServerAction:@a1'))?.name, 'GetQuotes');
  assert.equal(surfaceFind(surface, parseElement('ClientAction:GetQuotes')), null);
  assert.deepEqual(classify([parseElement('ServerAction:GetQuotes'), parseElement('ServerAction:Helper'), parseElement('ServerAction:Nope'), parseElement('ServerAction:Flow/GetQuotes'), parseElement('ServerAction:getquotes')], surface)
    .map(m => [m.open, m.spellings ?? null]), [['public', null], ['private', null], ['absent', null], ['spelling', ['ServerAction:GetQuotes']], ['spelling', ['ServerAction:GetQuotes']]]);
});

test('round 2 (A4): a block of the ui section has its Flow/Name path; O11 finds it by that path, ODC never (its signature names no flow)', () => {
  const surface = surfaceOf({ actions: [], sections: [{ id: 'ui', blocks: [{ key: 'b1', kind: 'WebBlock', name: 'Header', text: 'block MainFlow/Header @b1 public' }] }] });
  assert.deepEqual(surface, [{ kind: 'WebBlock', name: 'Header', key: 'b1', public: true, path: 'MainFlow/Header' }]);
  assert.equal(surfaceFind(surface, parseElement('IWebBlock:MainFlow/Header'), { lane: 'o11' })?.key, 'b1');
  assert.equal(surfaceFind(surface, parseElement('IMobileBlock:MainFlow/Header'), { lane: 'odc' }), null);
  assert.equal(surfaceFind(surface, parseElement('IMobileBlock:Header'), { lane: 'odc' })?.key, 'b1');
  assert.deepEqual(classify([parseElement('IMobileBlock:Common/Header')], surface, { lane: 'odc' })[0].spellings, ['IMobileBlock:Header']);
  assert.deepEqual(classify([parseElement('IWebBlock:Common/Header')], surface, { lane: 'o11' })[0].spellings, ['IWebBlock:MainFlow/Header']);
});

// Round 2 (A2), changed expectation (declared): the first round took the newest module capture as the open model
// (source module-capture); a capture is now only a data hint (capture), never the open model.
test('the ODC open model: only the module open in the Studio; the newest module capture is a data hint; a system producer has none', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upl-pp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const digestOf = async file => ({ ok: true, digest: { actions: [{ key: 'a', kind: 'ServerAction', name: path.basename(file), public: true }], sections: [] } });
  // Round 3 (N1), changed input (declared): the open model is the producer's only on the consumer's tenant (host), so the
  // call names that tenant and the snapshot carries its host, as the bridge's snapshot does.
  const open = await odcProducerModel({ producer: 'FloodServices', host: 'tenant.test' }, { studio: async () => ({ ok: true, module: 'FloodServices', path: path.join(dir, 'open.oml'), sha256: 'S', capturedAt: 'T', host: 'tenant.test' }), digestOf, captureDir: dir });
  assert.equal(open.source, 'open-model'); assert.equal(open.surface[0].name, 'open.oml'); assert.equal(open.host, 'tenant.test');
  const noTenant = await odcProducerModel({ producer: 'FloodServices' }, { studio: async () => ({ ok: true, module: 'FloodServices', path: path.join(dir, 'open.oml'), sha256: 'S', host: 'tenant.test' }), digestOf, captureDir: dir });
  assert.equal(noTenant.ok, false, 'without the consumer\'s tenant nothing proves the same asset');
  const other = await odcProducerModel({ producer: 'FloodServices' }, { studio: async () => ({ ok: true, module: 'QuoteApp', path: path.join(dir, 'consumer.oml') }), digestOf, captureDir: dir });
  assert.equal(other.ok, false, 'a capture of another module is never the producer\'s');
  const older = 'FloodServices-' + 'A'.repeat(64) + '.oml', newer = 'FloodServices-' + 'B'.repeat(64) + '.oml';
  fs.writeFileSync(path.join(dir, older), 'x'); fs.writeFileSync(path.join(dir, older + '.json'), JSON.stringify({ capturedAt: '2026-10-15T19:00:00Z' }));
  fs.writeFileSync(path.join(dir, newer), 'y'); fs.writeFileSync(path.join(dir, newer + '.json'), JSON.stringify({ capturedAt: '2026-10-15T19:59:00Z' }));
  fs.writeFileSync(path.join(dir, 'FloodServicesX-' + 'C'.repeat(64) + '.oml'), 'z');
  const captured = await odcProducerModel({ producer: 'FloodServices' }, { studio: async () => ({ ok: false, error: 'Expected exactly one open FloodServices; found 0.' }), digestOf, captureDir: dir });
  assert.equal(captured.ok, false); assert.equal(captured.surface, undefined);
  assert.deepEqual(captured.capture, { file: path.join(dir, newer), capturedAt: '2026-10-15T19:59:00Z' }, 'the newest capture of that producer, as data');
  let asked = 0;
  const system = await odcProducerModel({ producer: '(System)' }, { studio: async () => { asked++; return { ok: true }; }, digestOf, captureDir: dir });
  assert.equal(system.ok, false); assert.equal(asked, 0, 'the system producer is never snapshotted');
});

test('the bridge\'s refusal of a revision that exports nothing is recognized; the refusal text is English and names the sequence', () => {
  assert.ok(noPublicElements({ ok: false, error: 'Producer has no supported public elements' }));
  assert.ok(!noPublicElements({ ok: false, error: 'Producer is not available to the consumer session: X' }));
  const entry = { key: 'Lib', producer: 'Lib', missing: classify([parseElement('ServerAction:A')], [{ kind: 'ServerAction', name: 'A', key: 'k', public: true }]).map(m => ({ ...m, op: 0, pointer: '/ops/0/elements/0' })),
    ops: [], noPublicElements: false, revision: '2', referenced: true, evidence: { source: 'open-model' } };
  const step = (tool, args) => ({ tool, arguments: args, why: tool });
  const r = unpublishedRefusal({ lane: 'odc', module: 'App', entries: [entry], publish: e => step('studio_publish', { module: e.producer }), refresh: e => step('studio_refresh_references', { module: 'App', producer: e.producer }),
    deliver: step('studio_deliver', { module: 'App' }) });
  assert.equal(r.code, 'PRODUCER_NOT_PUBLISHED');
  assert.deepEqual(r.sequence, ['studio_publish Lib', 'studio_refresh_references App (Lib)', 'studio_deliver App']);
  assert.equal(r.continuation.then.then.tool, 'studio_deliver');
  assert.ok(!/[ãçõéêáíóú]/i.test(JSON.stringify(r)), 'English only');
});
