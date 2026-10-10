// Pacote D2: studio_status while the bridge is busy (C10) and studio_publish with a standing grant (C08, I6).
// The bridge serves one command at a time; a status during a merge used to wait for the pipe and fail with BRIDGE_BUSY.
// Now it answers at once from the command in flight and the evidence of that delivery. Fakes only, no Studio, no pipe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { busyEvidence, studioStatus, STATUS_CONNECT_MS } from '../lib.mjs';
import { PipeError } from '../odc-pipe.mjs';
import { publishWithGrant } from '../studio-publish-log.mjs';

function lab(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-d2-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'lab', '07-feature');
  const evidence = path.join(dir, 'delivery', 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const manifest = path.join(dir, 'delivery', 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ module: 'Fixture', evidenceDir: evidence }));
  fs.writeFileSync(path.join(dir, 'deliver-progress.json'), JSON.stringify({ stage: 'merge', since: '2026-10-05T01:44:37.000Z', manifest }));
  fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: '2026-10-05T01:45:32Z', module: 'Fixture', baseSha256: 'B', candidateSha256: 'C' }));
  return { root, dir, manifest, lab: path.join(root, 'lab') };
}

test('studio_status with a busy pipe answers from the evidence of the delivery in flight, without waiting', async t => {
  const l = lab(t);
  const asked = [];
  const call = async (args, pid, options) => { asked.push({ args, pid, options }); throw new PipeError('The ODC bridge v37 of ODC Studio 42 stayed busy for 2 s', { code: 'BRIDGE_BUSY', sent: false }); };
  const registry = new Map([[42, { command: 'merge', since: '2026-10-05T01:45:26.000Z', args: ['merge', l.manifest] }]]);
  const answer = await studioStatus({ pid: 42 }, { call, evidence: input => busyEvidence({ ...input, registry, lab: l.lab }) });
  assert.deepEqual(asked[0].args, ['status', 'brief']);
  assert.equal(asked[0].options.connectMs, STATUS_CONNECT_MS);
  assert.ok(STATUS_CONNECT_MS <= 2000, 'a status never waits the 10 s of a command call');
  assert.equal(answer.ok, true); assert.equal(answer.fromEvidence, true);
  assert.deepEqual(answer.busy, { command: 'merge', since: '2026-10-05T01:45:26.000Z' });
  assert.equal(answer.delivery.evidence, l.dir); assert.equal(answer.delivery.stage, 'merge');
  assert.equal(answer.delivery.mergeStarted.candidateSha256, 'C');
  assert.equal(answer.delivery.result, undefined);
  assert.match(answer.note, /never repeat a write/);
  // Once the delivery wrote its result, the answer carries it.
  fs.writeFileSync(path.join(l.dir, 'deliver-result.json'), JSON.stringify({ ok: true, merged: true }));
  const done = busyEvidence({ pid: 42, registry, lab: l.lab });
  assert.deepEqual(done.delivery.result, { ok: true, merged: true, failed: null, outcome: null, code: null });
});

test('studio_status from another process: the newest delivery with a stage and no result is the one in flight', async t => {
  const l = lab(t);
  const answer = busyEvidence({ registry: new Map(), lab: l.lab });
  assert.deepEqual(answer.busy, { command: 'merge', since: '2026-10-05T01:44:37.000Z' });
  assert.equal(answer.delivery.evidence, l.dir);
  const nothing = busyEvidence({ registry: new Map(), lab: path.join(l.root, 'none') });
  assert.deepEqual(nothing.busy, { command: null, since: null }); assert.equal(nothing.fromEvidence, true);
});

test('studio_status passes the bridge answer through, and every other error stays an error', async () => {
  const value = { ok: true, bridge: 'v37', busy: null };
  assert.equal(await studioStatus({ view: 'full' }, { call: async args => { assert.deepEqual(args, ['status']); return value; } }), value);
  await assert.rejects(studioStatus({}, { call: async () => { throw new PipeError('no pipe', { code: 'BRIDGE_NOT_ATTACHED', sent: false }); } }), /no pipe/);
});

test('studio_publish: a manifest without words takes the standing grant of its app, recorded before the publication', async () => {
  const seen = [];
  const studio = async args => { seen.push(args); return { ok: true }; };
  const grants = { findGrant: async q => (q.app === 'Fixture' && q.verb === 'publish' ? { grantId: 'g-9', words: 'publique o Fixture quando quiser' } : null) };
  const publish = async () => ({ ok: true, published: { revision: 12 }, completedAt: '2026-10-05T03:00:00Z' });
  const answer = await publishWithGrant({ manifest: 'm.json', pid: 7 }, { studio, readManifest: () => ({ module: 'Fixture', publishAuthorization: null }), grants, publish });
  assert.deepEqual(seen[0], ['authorize', 'm.json', 'publish', 'publique o Fixture quando quiser']);
  assert.deepEqual(answer.authorization, { source: 'standing-grant', grantId: 'g-9' });
  assert.deepEqual(answer.lastPublication, { at: '2026-10-05T03:00:00Z', status: 'succeeded', version: 12, author: null, by: 'ssam', source: 'publish-result' });
  // Recorded words: no grant lookup, no second authorize.
  const words = [];
  const own = await publishWithGrant({ manifest: 'm.json' }, { studio: async a => { words.push(a); return { ok: true }; }, readManifest: () => ({ module: 'Fixture', publishAuthorization: 'pode publicar [recorded]' }), grants, publish });
  assert.deepEqual(own.authorization, { source: 'words' }); assert.equal(words.length, 0);
  // Neither: the bridge refuses as before (the fake publish stands for it).
  const none = await publishWithGrant({ manifest: 'm.json' }, { studio, readManifest: () => ({ module: 'Other' }), grants,
    publish: async () => ({ ok: false, outcome: 'gate_refused', gate: 'none', error: 'publish requires manifest.publishAuthorization' }) });
  assert.equal(none.ok, false); assert.equal(none.authorization, undefined);
});
