// Pacote D2 (lane D2 of docs/PACOTE-SESSOES-NOVO.md): ODC delivery rules, each failing at the base 177e204a.
// C17: until=merge goes straight to the merge; the kernel apply is cached by everything it reads.
// C08: publish:true publishes after a clean merge with the request's words or a standing grant (I6), never otherwise.
// C16.1: a structure made public in an app is refused before the build; a library takes it.
// C16.4: an uncertain merge answers one line per divergence and no .NET stack trace.
// Section 3: leftovers and screenRoles come from the kernel result. Fakes only: no Studio, no bridge, no kernel CLI.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deliverKernel, deliveryCache, divergencesOf, jobDigest, publicStructureProblems, collectJobOps, publishOutcomeOf,
  requiredFlowLayoutEngine, withoutStack, leftoversOf, screenRolesOf, studioSteps } from '../kernel-delivery.mjs';
import { deliver } from '../lib.mjs';
import { hashedWords } from '../destructive-operations.mjs';

const kernelResult = (extra = {}) => ({ ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, ...extra } });

function fixture(t, { snapshot = {}, merge = {}, publish, job = '{"ops":[]}', refuse = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-d2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'job.json'), job);
  const calls = [], entries = [], applied = [];
  let lab = 0;
  const studio = async (args) => {
    calls.push(args[0]);
    if (refuse[args[0]]) return refuse[args[0]];
    if (args[0] === 'snapshot') return { ok: true, path: 'base.oml', sha256: 'BASEHASH', host: 'fixture.test', developerId: 'dev@fixture.test', moduleKey: 'KEY', module: 'Fixture', ...snapshot };
    if (args[0] === 'merge') return { ok: true, merged: true, strictlyEqual: true, ...merge };
    if (args[0] === 'authorize') return { ok: true, manifest: args[1], field: 'publishAuthorization', text: args.slice(3).join(' ') };
    if (args[0] === 'publish') return publish ?? { ok: true, module: 'Fixture', completed: true, state: 'CompletedWithSuccess', published: { revision: 7 }, completedAt: '2026-10-05T12:00:00Z' };
    if (args[0] === 'status') return { ok: true, field: 'modules', value: [{ name: 'Fixture', lastPublish: { state: 'CompletedWithSuccessNotOpenedInBrowser', running: false } }] };
    return { ok: true };
  };
  const apply = async ({ output }) => {
    applied.push(output);
    fs.writeFileSync(path.join(output, 'kernel-candidate.oml'), 'candidate-bytes');
    const result = kernelResult({ results: [{ op: 'html', result: { screen: 'Board', mode: 'create', roles: ['Registered'], anonymous: false } }, { op: 'html', parent: 'x', result: {} }],
      validation: { matched: [{ id: 'UnusedVariable', element: 'Board', why: 'kept for later', preexisting: false, count: 1 }],
        verdicts: [{ id: 'UnusedAction', path: 'ServerAction:Tmp', verdict: 'allowlisted', reason: 'unused-created-by-job' }, { id: 'X', verdict: 'unexpected' }] } });
    fs.writeFileSync(path.join(output, 'kernel-result.json'), JSON.stringify(result));
    return { ok: true, candidate: path.join(output, 'kernel-candidate.oml'), receipt: path.join(output, 'kernel-result.json'),
      screenRoles: screenRolesOf(result.data.results), leftovers: leftoversOf(result.data.validation) };
  };
  const deps = { root, studio, apply, journal: e => entries.push(e), guide: null, prefetch: () => {}, cache: null, grants: null, catalog: () => null,
    nextLabDir: () => path.join(root, 'lab', String(++lab).padStart(2, '0') + '-fixture'),
    prepareManifest: async ({ output }) => { calls.push('manifest'); fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ module: 'Fixture', evidenceDir: path.join(output, 'evidence') })); return { ok: true, manifest: path.join(output, 'manifest.json') }; } };
  const input = { module: 'Fixture', feature: 'fixture-change', job: 'job.json', owners: ['Board'], changes: ['Change Board'] };
  return { root, deps, input, calls, entries, applied };
}

test('C17: until=merge calls the merge directly, never check-base or preview; a review still runs them', async t => {
  assert.deepEqual(studioSteps('merge'), ['merge']);
  const f = fixture(t);
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.ok, true); assert.equal(result.merged, true); assert.equal(result.result, 'delivered');
  assert.ok(!f.calls.includes('check-base')); assert.ok(!f.calls.includes('preview'));
  assert.deepEqual(f.calls.filter(c => c !== 'status'), ['snapshot', 'manifest', 'merge']);
  const review = fixture(t);
  await deliverKernel({ ...review.input, until: 'preview' }, review.deps);
  assert.deepEqual(review.calls, ['snapshot', 'manifest', 'check-base', 'preview']);
  // Each stage reaches the progress callback (MCP progress notifications when the request has a token).
  const staged = fixture(t); const stages = [];
  await deliverKernel(staged.input, { ...staged.deps, onStage: stage => stages.push(stage) });
  assert.deepEqual(stages, ['snapshot', 'build', 'merge']);
  // The merge's own refusals of the preview conditions keep their codes.
  const empty = fixture(t, { refuse: { merge: { ok: false, outcome: 'gate_refused', gate: 'none', error: 'Automatic merge requires clean, non-empty changes: the candidate has no changes over the open module (NO_CHANGE); nothing was merged.' } } });
  const refused = await deliverKernel(empty.input, empty.deps);
  assert.equal(refused.code, 'NO_CHANGE'); assert.equal(refused.failed, 'merge'); assert.notEqual(refused.outcome, 'uncertain');
  // The base proof of the merge: a module edited after the capture is refused, and the same delivery is the next call.
  const drift = fixture(t, { refuse: { merge: { ok: false, outcome: 'gate_refused', gate: 'base_drift', error: 'Open Fixture differs from the captured base; capture a new snapshot and rebuild the candidate.' } } });
  const drifted = await deliverKernel(drift.input, drift.deps);
  assert.equal(drifted.code, 'BASE_DRIFT'); assert.equal(drifted.continuation.tool, 'studio_deliver'); assert.equal(drifted.continuation.arguments.module, 'Fixture');
});

test('C17: an identical delivery hits the cache and skips the kernel apply; a changed input or an unresolved file does not', async t => {
  const f = fixture(t, { job: '{"ops":[{"op":"html","parent":"IMobileScreen:Board","file":"frag.html"}]}' });
  fs.writeFileSync(path.join(f.root, 'frag.html'), '<div>one</div>');
  const cache = deliveryCache({ root: f.root, identity: 'kernel-and-builder', dir: path.join(f.root, '.local', 'deliver-cache') });
  const deps = { ...f.deps, cache };
  const first = await deliverKernel(f.input, deps);
  assert.equal(first.ok, true); assert.equal(first.cache.hit, false); assert.equal(f.applied.length, 1);
  const second = await deliverKernel(f.input, deps);
  assert.equal(second.ok, true); assert.equal(second.cache.hit, true); assert.equal(second.cache.key, first.cache.key);
  assert.equal(f.applied.length, 1, 'the second delivery did not run the kernel apply');
  assert.notEqual(second.evidence, first.evidence, 'new evidence goes to a new directory');
  assert.equal(fs.readFileSync(path.join(second.evidence, 'kernel-candidate.oml'), 'utf8'), 'candidate-bytes');
  assert.ok(fs.existsSync(path.join(second.evidence, 'kernel-cache.json')));
  assert.deepEqual(second.screenRoles, first.screenRoles);
  // The fragment the job names is part of the key.
  fs.writeFileSync(path.join(f.root, 'frag.html'), '<div>two</div>');
  const third = await deliverKernel(f.input, deps);
  assert.equal(third.cache.hit, false); assert.equal(f.applied.length, 2);
  // Another base capture is another key.
  const other = await deliverKernel(f.input, { ...deps, studio: async args => args[0] === 'snapshot' ? { ok: true, path: 'base.oml', sha256: 'OTHER', host: 'fixture.test', developerId: 'dev@fixture.test', moduleKey: 'KEY', module: 'Fixture' } : f.deps.studio(args) });
  assert.equal(other.cache.hit, false);
  // A file the job names that does not resolve: never cached.
  fs.writeFileSync(path.join(f.root, 'job2.json'), '{"ops":[{"op":"html","parent":"x","file":"missing.html"}]}');
  assert.equal(jobDigest(path.join(f.root, 'job2.json')), null);
  const uncached = await deliverKernel({ ...f.input, job: 'job2.json' }, deps);
  assert.equal(uncached.cache, undefined);
});

test('C08: publish:true publishes after a clean merge with the words of the request', async t => {
  const f = fixture(t);
  const seen = [];
  const studio = async args => { seen.push(args); return f.deps.studio(args); };
  const result = await deliverKernel({ ...f.input, publish: true, authorize: 'pode publicar o Fixture' }, { ...f.deps, studio });
  assert.equal(result.ok, true); assert.equal(result.result, 'delivered and published');
  assert.deepEqual(result.publish, { requested: true, outcome: 'published', version: 7, at: '2026-10-05T12:00:00Z' });
  assert.deepEqual(result.authorization, { source: 'words' });
  assert.equal(result.lastPublication.status, 'succeeded'); assert.equal(result.lastPublication.by, 'ssam'); assert.equal(result.lastPublication.source, 'publish-result');
  const order = seen.map(a => a[0]);
  assert.ok(order.indexOf('authorize') > order.indexOf('merge') && order.indexOf('publish') > order.indexOf('authorize'));
  // CX15 r5 (N-2, converted): the authorize line carries sha256:<hex> of the words (before: the words).
  assert.deepEqual(seen.find(a => a[0] === 'authorize').slice(2), ['publish', hashedWords('pode publicar o Fixture')]);
  assert.deepEqual(seen.find(a => a[0] === 'publish').slice(2), ['--wait', '10']);
});

test('C08: without words a standing grant of the app authorizes; without either nothing is built', async t => {
  const f = fixture(t);
  const asked = [];
  const grants = { findGrant: async query => { asked.push(query); return query.app === 'Fixture' ? { grantId: 'g-1', words: 'publique o Fixture sempre', verbs: ['publish'] } : null; } };
  const seen = [];
  const result = await deliverKernel({ ...f.input, publish: true }, { ...f.deps, grants, studio: async args => { seen.push(args); return f.deps.studio(args); } });
  assert.equal(result.result, 'delivered and published');
  assert.deepEqual(result.authorization, { source: 'standing-grant', grantId: 'g-1' });
  assert.deepEqual(asked[0], { lane: 'odc', app: 'Fixture', module: 'Fixture', verb: 'publish' });
  assert.deepEqual(seen.find(a => a[0] === 'authorize').slice(3), [hashedWords('publique o Fixture sempre')]); // CX15 r5 (N-2, converted)
  const none = fixture(t);
  const refused = await deliverKernel({ ...none.input, publish: true }, none.deps);
  assert.equal(refused.ok, false); assert.equal(refused.code, 'PUBLISH_AUTHORIZATION_REQUIRED'); assert.equal(refused.failed, 'preflight');
  assert.deepEqual(refused.publish, { requested: true, outcome: 'skipped' });
  assert.equal(none.applied.length, 0); assert.ok(!none.calls.includes('merge'));
  await assert.rejects(deliverKernel({ ...none.input, publish: true, authorize: 'pode publicar o Fixture', until: 'preview' }, none.deps), /until "merge"/);
});

test('C08: a merge that is not clean skips the publication; a failed publication keeps the delivery and continues with studio_publish', async t => {
  const unclean = fixture(t, { merge: { strictlyEqual: false } });
  const skipped = await deliverKernel({ ...unclean.input, publish: true, authorize: 'pode publicar o Fixture' }, unclean.deps);
  assert.equal(skipped.ok, false); assert.equal(skipped.outcome, 'uncertain');
  assert.deepEqual(skipped.publish, { requested: true, outcome: 'skipped' });
  assert.ok(!unclean.calls.includes('publish') && !unclean.calls.includes('authorize'));
  const failing = fixture(t, { publish: { ok: false, outcome: 'native_error', gate: 'none', error: 'Publication of Fixture ended in state CompletedWithFailure with 1 error(s) and 0 warning(s).',
    publishLog: { ok: true, module: 'Fixture', found: true, lastPublish: { state: 'CompletedWithFailure', failed: true, messages: [{ type: 'Warning', text: 'w' }, { type: 'Error', text: 'Build failed', element: { name: 'Board' }, stage: 'compilation' }] } } } });
  const failed = await deliverKernel({ ...failing.input, publish: true, authorize: 'pode publicar o Fixture' }, failing.deps);
  assert.equal(failed.ok, false); assert.equal(failed.result, 'delivered'); assert.equal(failed.merged, true);
  assert.equal(failed.code, 'PUBLISH_FAILED'); assert.equal(failed.failed, 'publish');
  assert.equal(failed.publish.outcome, 'failed'); assert.equal(failed.publish.messages[0].type, 'Error');
  assert.equal(failed.continuation.tool, 'studio_publish'); assert.match(failed.continuation.why, /Never repeat the delivery/);
  assert.equal(failing.calls.filter(c => c === 'merge').length, 1);
  assert.equal(publishOutcomeOf({ ok: false, outcome: 'uncertain', error: 'x' }).outcome, 'uncertain');
  assert.equal(publishOutcomeOf({ ok: false, outcome: 'gate_refused', gate: 'authorship', error: 'Authenticated author mismatch' }).code, 'PUBLISH_AUTHORSHIP');
});

test('C16.1: a structure made public in an app is refused before the build; a library takes it', async t => {
  const job = JSON.stringify({ ops: [
    { op: 'spec', data: { structures: [{ name: 'MatchState', public: true, attributes: [{ name: 'Id', type: 'Integer' }] }, { name: 'Row', attributes: [] }] } },
    { op: 'set', target: 'IStructure:Row', prop: 'Public', value: true },
    { op: 'set', target: 'IServerEntity:Question', prop: 'Public', value: true }] });
  const app = fixture(t, { job, snapshot: { kind: 'app' } });
  const refused = await deliverKernel(app.input, app.deps);
  assert.equal(refused.ok, false); assert.equal(refused.failed, 'preflight'); assert.equal(refused.code, 'PREFLIGHT_REFUSED');
  assert.deepEqual(refused.problems.map(p => [p.code, p.op, p.pointer]), [['ODC_STRUCTURE_PUBLIC_IN_APP', 0, '/ops/0/data/structures/0/public'], ['ODC_STRUCTURE_PUBLIC_IN_APP', 1, '/ops/1/value']]);
  assert.match(refused.problems[0].fix, /flat outputs.*public entity.*library/);
  assert.equal(app.applied.length, 0); assert.deepEqual(app.calls, ['snapshot']);
  assert.equal(refused.evidence, undefined, 'nothing claimed: the refusal comes before any work');
  const library = fixture(t, { job, snapshot: { kind: 'library' } });
  assert.equal((await deliverKernel(library.input, library.deps)).ok, true);
  // Without kind in the capture, the catalog's kind of the asset key decides.
  const catalogApp = fixture(t, { job });
  const byCatalog = await deliverKernel(catalogApp.input, { ...catalogApp.deps, catalog: () => ({ modules: [{ name: 'Fixture', key: 'KEY', kind: 'app' }] }) });
  assert.equal(byCatalog.problems?.length, 2);
  // Composite jobs are read part by part (no pointer into a part).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-d2-parts-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'part.json'), JSON.stringify({ ops: [{ op: 'create', parent: '@espace', type: 'IStructure', name: 'Dto', as: '$dto' }, { op: 'set', target: '$dto', prop: 'Public', value: 'True' }] }));
  const entries = collectJobOps({ jobs: ['part.json'] }, dir);
  assert.deepEqual(publicStructureProblems(entries).map(p => [p.op, p.pointer]), [[1, null]]);
  // DL2: the data text of a spec op names a public structure on its line.
  const text = [{ op: { op: 'spec', data: { ddl: 'type Dto public = {\n  A: Text;\n}\ntype Kept = { -- @k\n  B: Text; -- @b\n}\ntype [Other Dto] folder X public = {\n}' } }, index: 0, pointer: '/ops/0' }];
  assert.deepEqual(publicStructureProblems(text).map(p => [p.pointer, p.line, p.message.includes('Structure Dto') || p.message.includes('Structure [Other Dto]')]),
    [['/ops/0/data/ddl', 1, true], ['/ops/0/data/ddl', 7, true]]);
});

test('C16.4: an uncertain merge answers its divergences and no .NET stack trace', async t => {
  const stack = 'System.InvalidOperationException: Native object differs from the candidate: |    +-- (Object Refresh Data) Refresh GetPeople [ChangedInLocal]\r\n   at NativeMergeVerification.Require(Boolean pass, String message) in C:\\x\\NativeMergeVerification.cs:line 24\r\n--- End of stack trace from previous location ---\r\n   at Bridge.Serve()';
  const f = fixture(t, { refuse: { merge: { ok: false, outcome: 'uncertain', gate: 'equivalence', error: stack } } });
  // An older bridge: the facade reads the comparison dump of the evidence itself.
  f.deps.prepareManifest = async ({ output }) => {
    f.calls.push('manifest'); fs.mkdirSync(path.join(output, 'evidence'), { recursive: true });
    fs.writeFileSync(path.join(output, 'evidence', 'native-equivalence.txt'), [
      '(Object App) Sample [DifferenceInLocalMergeUnit]', '+-- (Folder) UI Flows', '|    |', '|    +-- (Object UI Flow) MainFlow [DifferenceInLocalMergeUnit]', '|    |    |',
      '|    |    +-- (Object Screen) Board [DifferenceInLocalMergeUnit]', '|    |    |    |', '|    |    |    +-- (Object Client Action) LoadWeek [DifferenceInLocalChildren]', '|    |    |    |    |',
      '|    |    |    |    +-- (Object Refresh Data) Refresh GetPeople [ChangedInLocal]', '|    |    |    |    |    |         >> Max. Records[50] / Max. Records[200] [ChangedInLocal]', ''].join('\r\n'));
    fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ evidenceDir: path.join(output, 'evidence') }));
    return { ok: true, manifest: path.join(output, 'manifest.json') };
  };
  const result = await deliverKernel(f.input, f.deps);
  assert.equal(result.outcome, 'uncertain'); assert.equal(result.code, 'MERGE_UNCERTAIN');
  for (const text of [result.error, JSON.stringify(result.refusal)]) { assert.doesNotMatch(text, /\s+at\s+\S+\(/); assert.doesNotMatch(text, /End of stack trace/); }
  assert.deepEqual(result.divergences, [{ element: 'MainFlow/Board/LoadWeek/Refresh GetPeople', kind: 'Refresh Data', property: 'Max. Records', local: '50', candidate: '200' }]);
  assert.match(result.error, /\nMainFlow\/Board\/LoadWeek\/Refresh GetPeople \(Refresh Data\): Max\. Records local '50' \/ candidate '200'/);
  // A bridge that lists them itself is taken as is.
  const listed = [{ element: 'A/B', kind: 'Assign', property: 'Label', local: 'x', candidate: 'y' }];
  const g = fixture(t, { refuse: { merge: { ok: false, outcome: 'uncertain', gate: 'equivalence', error: 'Native object differs\nA/B (Assign): Label local \'x\' / candidate \'y\'', divergences: listed } } });
  assert.deepEqual((await deliverKernel(g.input, g.deps)).divergences, listed);
  assert.equal(withoutStack(stack), 'Native object differs from the candidate: |    +-- (Object Refresh Data) Refresh GetPeople [ChangedInLocal]');
  assert.equal(divergencesOf('(Object App) A\r\n+-- (Folder) F\r\n|    |\r\n|    +-- (Object Assign) New [AddedToLocal]\r\n')[0].local, 'present');
});

test('section 3: the delivery answer carries leftovers and screenRoles from the kernel result, capped', async t => {
  const f = fixture(t);
  const result = await deliverKernel(f.input, f.deps);
  assert.deepEqual(result.screenRoles, [{ screen: 'Board', mode: 'create', roles: ['Registered'], anonymous: false }]);
  assert.deepEqual(result.leftovers, [{ id: 'UnusedVariable', element: 'Board', why: 'kept for later', source: 'expectedMessages' },
    { id: 'UnusedAction', element: 'ServerAction:Tmp', why: 'unused-created-by-job', source: 'allowlist' }]);
  assert.deepEqual(result.lastPublication, { at: null, status: 'succeeded', version: null, author: null, by: 'unknown', source: 'publish-log' });
  const many = leftoversOf({ matched: Array.from({ length: 25 }, (_, i) => ({ id: 'Unused' + i })) });
  assert.equal(many.length, 25);
  const kernelRefusal = fixture(t);
  kernelRefusal.deps.apply = async () => ({ ok: false, code: 'PREFLIGHT_REFUSED', problems: [{ op: 0, pointer: '/ops/0', code: 'X', severity: 'error', message: 'm', fix: 'f', patch: null }], error: 'refused' });
  const preflight = await deliverKernel(kernelRefusal.input, kernelRefusal.deps);
  assert.equal(preflight.code, 'PREFLIGHT_REFUSED'); assert.equal(preflight.failed, 'preflight'); assert.equal(preflight.problems[0].code, 'X');
});

test('C17 and C08 on the C# feature path too: straight to the merge, then the publication', async t => {
  const calls = [];
  const studio = async args => { calls.push(args[0]);
    if (args[0] === 'snapshot') return { ok: true, path: 'b.oml', sha256: 'H', host: 'fixture.test', module: 'Fixture' };
    if (args[0] === 'merge') return { ok: true, merged: true, strictlyEqual: true };
    if (args[0] === 'publish') return { ok: true, published: { revision: 3 }, completedAt: '2026-10-05T00:00:00Z' };
    return { ok: true }; };
  const builder = async () => ({ ok: true, output: [] });
  const result = await deliver({ feature: 'lab-action', module: 'Fixture', publish: true, authorize: 'pode publicar o Fixture' }, { studio, builder, grants: null });
  assert.equal(result.ok, true); assert.equal(result.result, 'delivered and published'); assert.equal(result.publish.version, 3);
  assert.deepEqual(calls, ['snapshot', 'merge', 'authorize', 'publish']);
  const none = await deliver({ feature: 'lab-action', module: 'Fixture', publish: true }, { studio, builder, grants: null });
  assert.equal(none.code, 'PUBLISH_AUTHORIZATION_REQUIRED');
});
