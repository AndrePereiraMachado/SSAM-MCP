// U1 (ODC bridge v106/v107): a completed publication whose revision the bridge did not verify against the bytes sent
// (before-publish.oml) answers ok:false, verified:false and the receipt's published block (StartupHook.cs Publish,
// PublishVerification.cs). It is the line's F1 family: PUBLISHED_REVISION_DIFFERS, outcome stale, staleRevisionNext, from
// studio_publish and from studio_deliver alike; never PUBLISH_FAILED (no message to fix: the server said CompletedWithSuccess),
// never PUBLISH_UNCERTAIN ("result unknown": it is known), and never a continuation that publishes the same manifest again,
// which the bridge refuses (publish-started.json). The refusal text is the one PublishVerification.Refusal writes
// (Bridge.Tests VerifiedPublicationTests holds it).
import './fixtures/isolated-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishWithLog, publishWithGrant } from '../studio-publish-log.mjs';
import { publishOutcomeOf, publishDelivered, unverifiedPublication } from '../kernel-delivery.mjs';

const REFUSAL = 'Publication of FloodQuotes ended in state CompletedWithSuccess, but the published revision 513 is not verified: 1 stylesheet(s) whose source differs from before-publish.oml, is missing or is new (sheet-1). The server may serve what the delivery did not send. Nothing was repeated; publish-receipt.json (published.differencesOutsideReferences, published.stylesheetSourceDifferences) and open-vs-published.txt name each difference.';
const LOG = { ok: true, module: 'FloodQuotes', moduleKey: 'k', lastPublish: { running: false, failed: false, messages: [], counts: { errors: 0, warnings: 0 }, summary: 'CompletedWithSuccess' } };
const PUBLISHED = { revision: 513, path: 'C:\\x\\FloodQuotes.oml', sha256: 'ABC', verified: false, sentBytes: false, matchesOpenModule: false, strictlyEqual: false,
  refreshedReferences: [], differencesOutsideReferences: [], stylesheetSourceDifferences: ['sheet-1'], comparisonError: null };
// The bridge's answer (ServeLine, PublishFailedException with Unverified).
const ANSWER = { ok: false, outcome: 'uncertain', gate: 'none', error: REFUSAL, verified: false, published: PUBLISHED, dialogsClosed: [], publishLog: LOG };

// A lab delivery whose evidence holds the bridge's publish receipt, as v106 writes it.
function lab(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-verified-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestDir = path.join(root, 'lab', '81-FEATURE', 'delivery'); const evidence = path.join(manifestDir, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const manifest = path.join(manifestDir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', feature: 'FEATURE', module: 'FloodQuotes', moduleKey: 'k', tenant: 'fixture.test', evidenceDir: evidence }));
  fs.writeFileSync(path.join(evidence, 'publish-receipt.json'), JSON.stringify({ ok: false, verified: false, completed: true, state: 'CompletedWithSuccess', published: PUBLISHED }));
  return { root, manifest, evidence };
}
const bridge = answer => { const calls = []; return { calls, studio: async args => { calls.push(args[0]); return args[0] === 'publish' ? answer : { ok: true, modules: [] }; } }; };

test('the unverified answer of the bridge is the F1 family: PUBLISHED_REVISION_DIFFERS, stale, with the revision', () => {
  const outcome = publishOutcomeOf(ANSWER);
  assert.equal(outcome.outcome, 'stale');
  assert.equal(outcome.code, 'PUBLISHED_REVISION_DIFFERS');
  assert.equal(outcome.version, 513);
  assert.match(outcome.error, /^The publication completed, but revision 513 the server holds is not the module sent: 1 stylesheet\(s\) whose source is not the one sent \(sheet-1\)/);
  // A download or comparison that failed is not "differs by content", and says so.
  const failed = unverifiedPublication({ ...ANSWER, published: { error: 'Latest published revision could not be verified for FloodQuotes', verified: false } });
  assert.equal(failed.code, 'PUBLISHED_REVISION_DIFFERS'); assert.match(failed.error, /could not be downloaded and compared/);
  // Any other answer is none of it.
  assert.equal(unverifiedPublication({ ok: false, error: 'Publication of X ended in state CompletedWithFailure.' }), null);
  assert.equal(unverifiedPublication({ ok: true, published: PUBLISHED }), null);
});

test('studio_publish {manifest}: PUBLISHED_REVISION_DIFFERS, stale, and the receipt to read; never the same publication again', async t => {
  const box = lab(t); const b = bridge(ANSWER);
  // publishWithLog keeps the bridge's own answer: no PUBLISH_FAILED mapping of a CompletedWithSuccess.
  const raw = await publishWithLog({ manifest: box.manifest, wait: true, minutes: 10, pid: 7 }, { studio: b.studio, moduleOf: () => 'FloodQuotes' });
  assert.equal(raw.code, undefined); assert.equal(raw.verified, false);
  b.calls.length = 0;
  const answer = await publishWithGrant({ manifest: box.manifest, authorize: 'yes, publish FloodQuotes now', pid: 7 },
    { studio: b.studio, readManifest: file => JSON.parse(fs.readFileSync(file, 'utf8')), lab: path.join(box.root, 'lab'), root: box.root, catalog: () => null, grants: { findGrant: async () => null } });
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.equal(answer.code, 'PUBLISHED_REVISION_DIFFERS');
  assert.equal(answer.outcome, 'stale');
  assert.equal(answer.version, 513);
  assert.deepEqual(answer.continuation.tool, 'ssam_evidence');
  assert.deepEqual(answer.continuation.arguments, { file: path.join(box.evidence, 'publish-receipt.json'), pointer: '/published' });
  assert.match(answer.continuation.why, /did not verify the revision/);
  assert.equal(b.calls.filter(c => c === 'publish').length, 1);
  assert.ok(!JSON.stringify(answer.continuation).includes('"studio_publish"'), 'never the same publication again');
});

test('studio_deliver publish:true (publishDelivered): the same outcome, never PUBLISH_UNCERTAIN', async t => {
  const box = lab(t); const b = bridge(ANSWER);
  const { publish } = await publishDelivered({ manifest: box.manifest, module: 'FloodQuotes', words: 'yes, publish FloodQuotes now', pid: 7 }, { studio: b.studio });
  assert.equal(publish.outcome, 'stale');
  assert.equal(publish.code, 'PUBLISHED_REVISION_DIFFERS');
  assert.equal(publish.version, 513);
  assert.equal(publish.verified, false);
});

test('a verified publication of bridge v106 stays published, also when the open module changed (the bytes sent)', () => {
  const value = { ok: true, verified: true, completedAt: '2026-10-31T00:00:00Z', published: { revision: 514, sha256: 'ab', verified: true, sentBytes: true, matchesOpenModule: false, strictlyEqual: false, differencesOutsideReferences: ['M/Screen [ChangedInLocal]'], stylesheetSourceDifferences: [] } };
  assert.equal(publishOutcomeOf(value, { sentSha256: 'ab' }).outcome, 'published');
});
