// Atritos 2, lane F7b, A10: a capability whose pointer into the extracted sources broke leaves the discover index with a note
// (dropped: [{id, problem}]) and the rest answers; a problem of the descriptor's own shape still refuses the build. Real case,
// 2026-10-06 11:08-11:35: "discovery descriptor does not match the extracted sources: integration.rest-import: contract
// pointer does not resolve: rest.shapes" refused 9 discovers in a row (a process of the 10th release under the 11th). The
// integration test reproduces it with a copy of the catalog fragments whose rest-import names a pointer the lane CLI does
// not have; the CLI and the Studio assemblies are only read (no Studio process).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as m_discovery from '../discovery.mjs';

const capability = (id, extra = {}) => ({ id, category: 'c', title: id, keywords: [id.replace(/\W/g, ' ')], summary: 's', route: { kind: 'job' }, ...extra });
const sourcesOf = { contracts: { rest: { shapes: {}, rules: {} } }, jobs: [{ name: 'job-a' }], negatives: [], nativeRuntime: null };

test('pruneBrokenPointers drops the capability with a broken pointer, keeps the rest and the references to it leave too', () => {
  assert.equal(typeof m_discovery.pruneBrokenPointers, 'function', 'the index survives a broken pointer (A10)');
  const descriptor = { schemaVersion: 'ssam-discovery-capabilities/1', lane: 'odc', capabilities: [
    capability('integration.rest-import', { contract: ['rest.shapes', 'rest.shapesOfANewerRelease'] }),
    capability('integration.rest-consume', { contract: ['rest.shapes'], proofs: { odc: ['job-a'] }, alternatives: [{ id: 'integration.rest-import' }], depends: ['integration.rest-import'] }),
    capability('logic.other', { proofs: { odc: ['job-gone'] } }),
  ], unavailable: [{ id: 'gap.x', keywords: ['gap'], reason: 'r', negative: { odc: ['negative-gone'] } }], synonyms: {} };
  const { problems, dropped } = m_discovery.pruneBrokenPointers(descriptor, sourcesOf);
  assert.deepEqual(problems, []);
  assert.deepEqual(dropped.map(d => d.id).sort(), ['gap.x', 'integration.rest-import', 'logic.other']);
  assert.match(dropped.find(d => d.id === 'integration.rest-import').problem, /contract pointer does not resolve: rest\.shapesOfANewerRelease/);
  assert.match(dropped.find(d => d.id === 'logic.other').problem, /proof job not found: job-gone/);
  assert.deepEqual(descriptor.capabilities.map(c => c.id), ['integration.rest-consume']);
  const kept = descriptor.capabilities[0];
  assert.deepEqual([kept.alternatives, kept.depends], [[], []], 'no reference to a dropped capability remains');
  assert.deepEqual(descriptor.unavailable, []);
});

test('pruneBrokenPointers: a problem of the descriptor\'s own shape still refuses', () => {
  assert.equal(typeof m_discovery.pruneBrokenPointers, 'function', 'the index survives a broken pointer (A10)');
  const descriptor = { schemaVersion: 'ssam-discovery-capabilities/1', lane: 'odc', capabilities: [
    capability('a.one', { contract: ['rest.gone'] }), { id: 'a.two', category: 'c', keywords: ['x'], summary: 's', route: { kind: 'job' } },
    capability('a.three', { depends: ['never.existed'] }), capability('a.four', { contract: ['rest.gone'], summary: undefined })], synonyms: {} };
  const { problems, dropped } = m_discovery.pruneBrokenPointers(descriptor, sourcesOf);
  assert.deepEqual(dropped.map(d => d.id), ['a.one']);
  assert.ok(problems.some(p => /a\.two: missing title/.test(p)), problems.join('\n'));
  assert.ok(problems.some(p => /a\.three: unknown dependency never\.existed/.test(p)), problems.join('\n'));
  // An entry with a shape problem besides its broken pointer stays, and both refuse.
  assert.ok(problems.some(p => /a\.four: missing summary/.test(p)) && problems.some(p => /a\.four: contract pointer does not resolve: rest\.gone/.test(p)), problems.join('\n'));
});

test('the index of a lane whose fragment names a pointer its CLI does not have drops that capability with a note, and discover still answers', { timeout: 600000 }, async t => {
  assert.equal(typeof m_discovery.pruneBrokenPointers, 'function', 'the index survives a broken pointer (A10)');
  const sources = m_discovery.laneSources('o11');
  if (!fs.existsSync(sources.cli)) { t.skip('the O11 CLI of this checkout is not built'); return; }
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'pa2-f7b-disc-'));
  t.after(() => fs.rmSync(box, { recursive: true, force: true }));
  const fragments = path.join(box, 'fragments');
  fs.cpSync(sources.fragments, fragments, { recursive: true });
  const rest = path.join(fragments, 'C', 'rest.json');
  const doc = JSON.parse(fs.readFileSync(rest, 'utf8'));
  const target = doc.capabilities.find(c => c.id === 'integration.rest-import');
  assert.ok(target, 'the fragment holds integration.rest-import');
  target.contract = [...target.contract, 'rest.shapesOfANewerRelease'];
  fs.writeFileSync(rest, JSON.stringify(doc, null, 2));
  const isolated = { ...sources, fragments, cacheDir: path.join(box, 'cache') };
  const built = await m_discovery.buildIndex('o11', { sources: isolated, persist: false });
  assert.deepEqual(built.index.dropped?.map(d => d.id), ['integration.rest-import']);
  assert.match(built.index.dropped[0].problem, /contract pointer does not resolve: rest\.shapesOfANewerRelease/);
  assert.equal(built.index.capabilities.some(c => c.id === 'integration.rest-import'), false);
  assert.ok(built.index.capabilities.some(c => c.id === 'integration.rest-consume'), 'the other capabilities stay');
  // discover answers the other intents and names what left the index.
  const answer = await m_discovery.discover({ lane: 'o11', intent: 'excluir um metodo rest de uma api consumida', sources: isolated, budgetBytes: 12000 });
  assert.equal(answer.ok, true, answer.error);
  assert.deepEqual(answer.dropped?.map(d => d.id), ['integration.rest-import']);
});
