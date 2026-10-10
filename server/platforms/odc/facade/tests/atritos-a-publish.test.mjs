// Frictions of 2026-10-06, lane a, A2: publish without hunting the manifest. studio_publish took only a manifest and the
// compact studio_deliver answer dropped its path, so a session asked later to publish listed the lab folders. Now
// studio_publish {module} takes the manifest of the module's last SSAM merge from the delivery evidence (same tenant and
// Studio), refuses before anything when that merge is not clean, already published, from another Studio process, or the
// open module changed since, and the compact delivery keeps the manifest and names the publication. Offline: the evidence
// is a temporary lab with the bridge's receipt shapes; the bridge is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { deliveryMerges, publishWithGrant } from '../studio-publish-log.mjs';
import { compactDelivery, shapeToolResult } from '../responses.mjs';

const TENANT = 'personal-test.outsystems.dev';
const WORDS = 'pode publicar o GameStore agora';
const STUDIO_PID = 4242;

// One delivery of the lab: lab/<name>/delivery/manifest.json and its evidence, as studio_deliver and the bridge leave them.
function delivery(lab, name, { module = 'GameStore', moduleKey = 'k-game', tenant = TENANT, mergedAt, pid = STUDIO_PID, receipt = 'clean', published = null, job = true } = {}) {
  const dir = path.join(lab, name); const manifestDir = path.join(dir, 'delivery'); const evidence = path.join(manifestDir, 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  const manifest = path.join(manifestDir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ schema: 'odc3-manifest/1', feature: 'AddGenres', module, moduleKey, tenant, author: 'dev@example.test',
    owners: ['Genre'], changes: ['Add the Genre entity'], evidenceDir: evidence }, null, 2));
  if (job) fs.writeFileSync(path.join(dir, 'deliver-result.json'), JSON.stringify({ ok: receipt === 'clean', module, feature: 'AddGenres', job: path.join(lab, '..', 'jobs', name + '.json'),
    ...(receipt === 'incomplete' ? { continuation: { tool: 'studio_deliver', arguments: { feature: 'AddGenres', module, job: path.join(dir, 'repair.json'), owners: ['Genre'], changes: ['Default Genre.Name = x'] }, why: 'repair' } } : {}) }));
  if (mergedAt === undefined) return { dir, manifest, evidence }; // refused before the merge: no merge-started.json
  fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: mergedAt, pid, module, baseSha256: 'b', candidateSha256: 'c', passes: 1, publishInvoked: false }));
  if (receipt === 'clean') fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, module, outcome: 'merged', sha256: 'after', strictlyEqual: true }));
  if (receipt === 'incomplete') fs.writeFileSync(path.join(evidence, 'incomplete-receipt.json'), JSON.stringify({ ok: false, merged: true, outcome: 'incomplete', module }));
  if (published) {
    fs.writeFileSync(path.join(evidence, 'publish-started.json'), JSON.stringify({ at: mergedAt, pid, module }));
    if (published !== 'started') fs.writeFileSync(path.join(evidence, 'publish-receipt.json'), JSON.stringify({ ok: published === 'ok', module, published: { revision: 14 }, completedAt: '2026-10-06T10:05:00Z' }));
  }
  return { dir, manifest, evidence };
}

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atritos-a-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, lab: path.join(root, 'lab') };
}

// The fake bridge: status lists the open modules of this Studio; authorize and publish answer as the bridge does.
function bridge({ modules = [{ name: 'GameStore', key: 'k-game', host: TENANT, loggedIn: true }], pid = STUDIO_PID, publishAnswer } = {}) {
  const calls = [];
  const studio = async (args, callPid) => {
    calls.push([...args]);
    if (args[0] === 'status') return { ok: true, pid, modules };
    if (args[0] === 'authorize') return { ok: true };
    if (args[0] === 'publish') return publishAnswer ?? { ok: true, module: 'GameStore', published: { revision: 13 }, completedAt: '2026-10-06T11:00:00Z' };
    return { ok: false, error: 'unexpected ' + args[0] };
  };
  return { studio, calls };
}
const deps = (box, b, extra = {}) => ({ studio: b.studio, readManifest: file => JSON.parse(fs.readFileSync(path.resolve(box.root, file), 'utf8')), lab: box.lab, root: box.root,
  catalog: () => null, grants: { findGrant: async () => null }, ...extra });

test('A2: studio_publish {module, authorize} publishes the manifest of the last clean merge, found in the delivery evidence', async t => {
  const box = sandbox(t);
  delivery(box.lab, '05-AddGenres', { mergedAt: '2026-10-06T09:00:00Z' });
  const last = delivery(box.lab, '07-AddGenres', { mergedAt: '2026-10-06T10:00:00Z' });
  delivery(box.lab, '08-AddGenres', {}); // refused before the merge: changed nothing, never the last merge
  const b = bridge();
  const answer = await publishWithGrant({ module: 'GameStore', authorize: WORDS, pid: STUDIO_PID }, deps(box, b));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(b.calls, [['status'], ['authorize', last.manifest, 'publish', WORDS], ['publish', last.manifest, '--wait', '10']]);
  assert.equal(answer.resolvedFrom.manifest, last.manifest);
  assert.equal(answer.resolvedFrom.mergedAt, '2026-10-06T10:00:00Z');
  assert.deepEqual(answer.authorization, { source: 'words' });
  assert.deepEqual(answer.lastPublication, { at: '2026-10-06T11:00:00Z', status: 'succeeded', version: 13, author: null, by: 'ssam', source: 'publish-result' });
  assert.deepEqual(deliveryMerges(box.lab, { module: 'GameStore', moduleKey: 'k-game' }).map(m => path.basename(m.dir)), ['07-AddGenres', '05-AddGenres']);
});

test('A2: the app name the person sees reaches the open module; a module that is not open is refused with studio_open', async t => {
  const box = sandbox(t);
  const last = delivery(box.lab, '03-AddGenres', { mergedAt: '2026-10-06T10:00:00Z' });
  const b = bridge();
  const answer = await publishWithGrant({ module: 'Game Store', authorize: WORDS }, deps(box, b));
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(b.calls.at(-1)[1], last.manifest);
  const closed = await publishWithGrant({ module: 'Billing', authorize: WORDS }, deps(box, bridge()));
  assert.equal(closed.code, 'MODULE_NOT_OPEN'); assert.equal(closed.continuation.tool, 'studio_open');
});

test('A2: a last merge that is not clean is refused before anything, with its repair or the read of its receipt', async t => {
  const box = sandbox(t);
  delivery(box.lab, '01-AddGenres', { mergedAt: '2026-10-06T08:00:00Z' });
  const incomplete = delivery(box.lab, '02-AddGenres', { mergedAt: '2026-10-06T09:00:00Z', receipt: 'incomplete' });
  const b = bridge();
  const refused = await publishWithGrant({ module: 'GameStore', authorize: WORDS }, deps(box, b));
  assert.equal(refused.ok, false); assert.equal(refused.code, 'LAST_DELIVERY_NOT_CLEAN'); assert.equal(refused.outcome, 'incomplete');
  assert.equal(refused.continuation.tool, 'studio_deliver'); assert.equal(refused.continuation.arguments.job, path.join(incomplete.dir, 'repair.json'));
  assert.deepEqual(b.calls, [['status']], 'nothing authorized or published');
  const uncertain = delivery(box.lab, '03-AddGenres', { mergedAt: '2026-10-06T10:00:00Z', receipt: 'none', job: false });
  const second = await publishWithGrant({ module: 'GameStore', authorize: WORDS }, deps(box, bridge()));
  assert.equal(second.code, 'LAST_DELIVERY_NOT_CLEAN'); assert.equal(second.outcome, 'uncertain');
  assert.deepEqual(second.continuation, { tool: 'ssam_evidence', arguments: { file: path.join(uncertain.evidence, 'merge-started.json') }, why: second.continuation.why });
});

test('A2: a merge already published, or whose publication was already requested, is never published again', async t => {
  const box = sandbox(t);
  delivery(box.lab, '04-AddGenres', { mergedAt: '2026-10-06T10:00:00Z', published: 'ok' });
  const b = bridge();
  const done = await publishWithGrant({ module: 'GameStore', authorize: WORDS, pid: STUDIO_PID }, deps(box, b));
  assert.equal(done.code, 'ALREADY_PUBLISHED');
  assert.deepEqual(done.continuation.arguments, { command: 'publish-log', args: ['GameStore'], pid: STUDIO_PID });
  assert.equal(done.lastPublication.version, 14);
  delivery(box.lab, '05-AddGenres', { mergedAt: '2026-10-06T11:00:00Z', published: 'started' });
  const requested = await publishWithGrant({ module: 'GameStore', authorize: WORDS }, deps(box, b));
  assert.equal(requested.code, 'PUBLISH_ALREADY_REQUESTED'); assert.equal(requested.continuation.tool, 'studio_command');
  assert.equal(b.calls.filter(c => c[0] !== 'status').length, 0, 'nothing authorized or published');
});

test('A2: a merge of another Studio process or of another tenant is not this Studio\'s; the exact next call is the delivery again', async t => {
  const box = sandbox(t);
  delivery(box.lab, '06-AddGenres', { mergedAt: '2026-10-06T10:00:00Z', pid: 999 });
  const b = bridge();
  const other = await publishWithGrant({ module: 'GameStore', authorize: WORDS }, deps(box, b));
  assert.equal(other.code, 'DELIVERY_IN_OTHER_STUDIO');
  assert.equal(other.continuation.tool, 'studio_deliver');
  assert.deepEqual(Object.keys(other.continuation.arguments).sort(), ['changes', 'feature', 'job', 'module', 'owners', 'publish']);
  assert.equal(other.continuation.arguments.publish, true);
  assert.ok(!JSON.stringify(other.continuation).includes(WORDS), 'the words never travel');
  const box2 = sandbox(t);
  delivery(box2.lab, '01-AddGenres', { mergedAt: '2026-10-06T10:00:00Z', tenant: 'corp.outsystems.app' });
  const tenant = await publishWithGrant({ module: 'GameStore', authorize: WORDS }, deps(box2, bridge()));
  assert.equal(tenant.code, 'NO_DELIVERY_TO_PUBLISH'); assert.equal(tenant.continuation.tool, 'studio_deliver');
});

test('A2: the bridge\'s own check (the open module changed since the merge) comes back with its code and the delivery again', async t => {
  const box = sandbox(t);
  const last = delivery(box.lab, '09-AddGenres', { mergedAt: '2026-10-06T10:00:00Z' });
  const b = bridge({ publishAnswer: { ok: false, gate: 'none', error: 'System.InvalidOperationException: Open module differs from the merged receipt; do not publish an unverified model.' } });
  const changed = await publishWithGrant({ module: 'GameStore', authorize: WORDS }, deps(box, b));
  assert.equal(changed.code, 'MODULE_CHANGED_SINCE_DELIVERY'); assert.equal(changed.executed, false);
  assert.equal(changed.continuation.tool, 'studio_deliver');
  assert.equal(changed.continuation.arguments.job, path.join(box.lab, '..', 'jobs', '09-AddGenres.json'));
  // The same with the manifest given directly.
  const direct = await publishWithGrant({ manifest: last.manifest }, deps(box, b));
  assert.equal(direct.code, 'MODULE_CHANGED_SINCE_DELIVERY'); assert.equal(direct.continuation.arguments.module, 'GameStore');
});

test('A2: module or manifest, exactly one', async t => {
  const box = sandbox(t);
  for (const input of [{}, { module: 'GameStore', manifest: 'm.json' }]) {
    const refused = await publishWithGrant(input, deps(box, bridge()));
    assert.equal(refused.code, 'PUBLISH_TARGET'); assert.equal(refused.continuation.tool, 'studio_publish');
  }
});

test('A2: the compact delivery keeps the manifest and, when it did not publish, names studio_publish {module}', () => {
  const merged = { ok: true, until: 'merge', module: 'GameStore', merged: true, strictlyEqual: true, result: 'entregue', manifest: 'C:\\x\\lab\\07\\delivery\\manifest.json', steps: [] };
  const compact = compactDelivery('studio_deliver', { module: 'Game Store', pid: 7 }, merged);
  assert.equal(compact.result, 'entregue'); assert.equal(compact.manifest, merged.manifest);
  assert.deepEqual(compact.continuation.arguments, { module: 'GameStore', pid: 7 });
  assert.equal(compact.continuation.tool, 'studio_publish');
  const published = compactDelivery('studio_deliver', {}, { ...merged, result: 'entregue e publicado', publish: { requested: true, outcome: 'published', version: 3 } });
  assert.equal(published.continuation, undefined); assert.equal(published.manifest, merged.manifest);
  // Through the whole shaper the continuation survives (an exact answer gets no `next`).
  const shaped = shapeToolResult('studio_deliver', { module: 'GameStore' }, { content: [{ type: 'text', text: JSON.stringify(merged) }], structuredContent: merged }).structuredContent;
  assert.equal(shaped.continuation.tool, 'studio_publish'); assert.equal(shaped.next, undefined);
});

test('A2: the live studio_publish schema takes module and authorize, and tools.json routes module', async () => {
  const { createFacadeServer } = await import('../mcp.mjs');
  const server = await createFacadeServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'atritos-a', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const tool = (await client.listTools()).tools.find(x => x.name === 'studio_publish');
    assert.ok(tool.inputSchema.properties.module); assert.ok(tool.inputSchema.properties.authorize);
    assert.ok(!(tool.inputSchema.required ?? []).includes('manifest'), 'manifest is optional');
    assert.match(tool.description, /LAST_DELIVERY_NOT_CLEAN/);
  } finally { await client.close(); await server.close(); }
  const routes = JSON.parse(fs.readFileSync(new URL('../catalog/tools.json', import.meta.url), 'utf8'));
  assert.equal(routes.tools.studio_publish.args.module, '<Module>');
  assert.equal(routes.tools.studio_publish.args.manifest, undefined);
});
