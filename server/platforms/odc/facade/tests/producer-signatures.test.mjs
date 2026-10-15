// F5, the family rule of producer signatures, on the facade's side (producer-signatures.mjs): the files it shares with the
// kernel (ProducerLedger.cs, ProducerCache.cs), the publication record every SSAM publication leaves, what each o11_deliver
// answer says it reused, the PRODUCER_CHANGED continuation and, F6, the producers section of the work packet. Temporary
// folders only; no Studio, no CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID as randomUUIDv4 } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { producerCacheDir, ledgerId, recordPublished, recordPublicationEnded, unsafeUntil, publicationOpen, reuseOdcReference, rememberOdcReference,
  cacheEntries, producerSignaturesOf, packetProducers, PUBLISHED_SCHEMA, PUBLISHING_SCHEMA, MAX_PUBLICATION_MS } from '../producer-signatures.mjs';
import { deliverOutcome, WORDS_MARKER } from '../o11-cycle.mjs';
import { registerO11Publish } from '../o11-publish.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { workPacket, PACKET_ORDER } from '../work-packet.mjs';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const TASK = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const HOST = 'personal-x.outsystemscloud.com';

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-signatures-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil');
  const work = path.join(root, '.local', 'work');
  fs.mkdirSync(work, { recursive: true });
  return { base, root, work, cache: path.join(root, '.local', 'producer-cache') };
}

// A capture as the kernel stores it (ProducerCache.Store): <key>.avsig and its DurableJson envelope <key>.json.
function storeLikeKernel(cache, { environment, producer, elements, receipt, avsig = '{"Name":"' + producer + '"}' }) {
  const key = sha256(environment.trim().toLowerCase() + '\n' + producer + '\n' + [...new Set(elements)].sort().join('\n'));
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, key + '.avsig'), avsig);
  const payload = JSON.stringify({ environment, producer, elements, sha256: sha256(avsig), receipt, storedAtUtc: '2026-10-12T21:13:34.000Z' });
  fs.writeFileSync(path.join(cache, key + '.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
  return path.join(cache, key + '.avsig');
}

test('the lane cache folder and the ledger id are the kernel\'s (ProducerCache.ForWork, ProducerLedger.Id)', t => {
  const s = sandbox(t);
  assert.equal(producerCacheDir(s.work), s.cache);
  assert.equal(producerCacheDir(path.join(s.root, '.local', 'lane-ss5', 'work')), s.cache, 'ss5 shares the nearest .local');
  assert.equal(producerCacheDir(path.join(s.root, '.local', 'jobs')), null, 'only a lane work folder');
  assert.equal(ledgerId(' Personal-X.OutSystemsCloud.com ', 'VisitaCerta_IS'), sha256(HOST + '\nvisitacerta_is').slice(0, 40));
});

test('every publication SSAM starts is recorded for the kernel\'s ledger, with its end: the same files, the newest wins', t => {
  const s = sandbox(t);
  const handle = recordPublished(s.cache, { environment: HOST, module: 'VisitaCerta_IS', key: 'k', source: 'o11_publish', at: new Date('2026-10-12T21:09:58Z'), id: 'p1' });
  assert.deepEqual(handle, { dir: s.cache, environment: HOST, module: 'VisitaCerta_IS', publicationId: 'p1' });
  const file = path.join(s.cache, 'published', ledgerId(HOST, 'VisitaCerta_IS') + '.json');
  const marker = path.join(s.cache, 'publishing', ledgerId(HOST, 'VisitaCerta_IS') + '.p1.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema: PUBLISHED_SCHEMA, environment: HOST, module: 'VisitaCerta_IS', key: 'k',
    publishedAtUtc: '2026-10-12T21:09:58.000Z', source: 'o11_publish', publicationId: 'p1' });
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, 'utf8')), { schema: PUBLISHING_SCHEMA, environment: HOST, module: 'VisitaCerta_IS', publicationId: 'p1',
    startedAtUtc: '2026-10-12T21:09:58.000Z', source: 'o11_publish' });
  // In flight: nothing observed before start + MAX_PUBLICATION_MS counts.
  assert.equal(unsafeUntil(s.cache, { environment: HOST, producer: 'VisitaCerta_IS' }), Date.parse('2026-10-12T21:09:58Z') + MAX_PUBLICATION_MS);
  assert.equal(recordPublicationEnded(handle, { at: new Date('2026-10-12T21:10:18Z') }), true);
  assert.equal(fs.existsSync(marker), false, 'the marker goes at the end');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).endedAtUtc, '2026-10-12T21:10:18.000Z');
  assert.equal(unsafeUntil(s.cache, { environment: HOST, producer: 'visitacerta_is' }), Date.parse('2026-10-12T21:10:18Z'));
  recordPublished(s.cache, { environment: HOST, module: 'visitacerta_is', at: new Date('2026-10-12T21:20:00Z') });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).publishedAtUtc, '2026-10-12T21:20:00.000Z');
  assert.equal(recordPublished(null, { environment: HOST, module: 'X' }), false, 'no workspace: nothing, never a throw');
  assert.equal(recordPublished(s.cache, { environment: '', module: 'X' }), false);
  assert.equal(recordPublicationEnded(false), false);
});

test('a publication covers its producer from before its start to its end; overlapping ones, unknown modules and tenants too', t => {
  const s = sandbox(t);
  const T0 = Date.parse('2026-10-12T21:00:00Z');
  const at = ms => new Date(T0 + ms);
  const a = recordPublished(s.cache, { environment: HOST, module: 'Lib', at: at(0), id: 'a' });
  const b = recordPublished(s.cache, { environment: HOST, module: 'Lib', at: at(10_000), id: 'b' });
  recordPublicationEnded(a, { at: at(20_000) });
  assert.equal(unsafeUntil(s.cache, { environment: HOST, producer: 'Lib' }), T0 + 10_000 + MAX_PUBLICATION_MS, 'b still runs');
  recordPublicationEnded(b, { at: at(30_000) });
  assert.equal(unsafeUntil(s.cache, { environment: HOST, producer: 'Lib' }), T0 + 30_000);
  // A solution publish (modules unknown) covers every producer of its environment; an unknown tenant covers every environment.
  recordPublished(s.cache, { environment: HOST, module: '*', at: at(60_000), id: 'sol' });
  assert.equal(unsafeUntil(s.cache, { environment: HOST, producer: 'Other' }), T0 + 60_000 + MAX_PUBLICATION_MS);
  assert.equal(unsafeUntil(s.cache, { environment: 'other.example', producer: 'Other' }), -Infinity);
  recordPublished(s.cache, { environment: '*', module: 'Other', at: at(70_000), id: 'odc' });
  assert.equal(unsafeUntil(s.cache, { environment: 'other.example', producer: 'Other' }), T0 + 70_000 + MAX_PUBLICATION_MS);
  // What does not prove a publication over leaves it running.
  for (const open of [undefined, { ok: false, outcome: 'uncertain' }, { state: 'uncertain' }, { code: 'PUBLISH_RUNNING' }, { state: 'accepted', executionCompleted: false }, { publish: { outcome: 'uncertain' } }])
    assert.equal(publicationOpen(open), true, JSON.stringify(open));
  for (const over of [{ ok: true }, { ok: false, outcome: 'failed', code: 'PUBLISH_FAILED' }, { outcome: 'published' }, { ok: true, state: 'confirmed' }])
    assert.equal(publicationOpen(over), false, JSON.stringify(over));
});

test('the captures the kernel stored are read back; a capture whose file changed is not', t => {
  const s = sandbox(t);
  const file = storeLikeKernel(s.cache, { environment: HOST, producer: 'VisitaCerta_IS', elements: ['IServiceAction:GetAddressByCep'], receipt: { producer: 'VisitaCerta_IS', versionIdBefore: 6773 } });
  storeLikeKernel(s.cache, { environment: 'other.example', producer: 'VisitaCerta_IS', elements: ['IServiceAction:GetAddressByCep'], receipt: { producer: 'VisitaCerta_IS', versionIdBefore: 1 } });
  assert.equal(cacheEntries(s.cache).length, 2);
  const mine = cacheEntries(s.cache, { environment: HOST });
  assert.deepEqual(mine.map(e => [e.path, e.producer, e.receipt.versionIdBefore, e.elements]), [[file, 'VisitaCerta_IS', 6773, ['IServiceAction:GetAddressByCep']]]);
  fs.appendFileSync(file, ' ');
  assert.deepEqual(cacheEntries(s.cache, { environment: HOST }), []);
});

test('each o11_deliver answer says what it reused and how each producer was observed', () => {
  const state = { taskId: TASK, writeState: 'not-sent', error: 'job rejected by validation contract; merge was not attempted', stage: 'apply',
    apply: { isValid: false, accepted: false },
    capturedProducers: {
      VisitaCerta_IS: { producer: 'VisitaCerta_IS', path: 'C:\\w\\producers\\VisitaCerta_IS.avsig', versionId: 6773, reusedFromCache: true, observed: { by: 'ledger', observedAtUtc: '2026-10-13T00:13:34Z' } },
      System: { producer: '(System)', path: 'C:\\w\\producers\\owner-x.avsig', advertisedSignatureHash: 'h', reason: 'foreign-owner-of:VisitaCerta_CS', observed: { by: 'capture', observedAtUtc: '2026-10-13T00:14:00Z' } } },
    producerAttestation: [{ path: 'C:\\w\\producers\\VisitaCerta_IS.avsig', by: 'ledger', attested: true }, { path: 'C:\\w\\producers\\owner-x.avsig', by: 'capture', attested: true },
      { path: 'C:\\bound\\Lib.avsig', producer: 'Lib', versionId: 3, by: 'server', attested: true }] };
  const value = deliverOutcome({ envelope: { ok: true, data: state } }, { trackId: 't', work: 'C:\\w', job: 'C:\\j.json', input: { module: 'VisitaCerta_CS' } });
  assert.equal(value.ok, false);
  assert.deepEqual(value.producers, [
    { binding: 'VisitaCerta_IS', producer: 'VisitaCerta_IS', versionId: 6773, signature: 'reused', observed: 'ledger', observedAtUtc: '2026-10-13T00:13:34Z' },
    { binding: 'System', producer: '(System)', advertisedSignatureHash: 'h', signature: 'captured', observed: 'capture', observedAtUtc: '2026-10-13T00:14:00Z', owner: 'VisitaCerta_CS' },
    { producer: 'Lib', versionId: 3, signature: 'bound', observed: 'server' }]);
  assert.match(value.producersNote, /1 de 3 reaproveitadas/);
  assert.match(value.producersNote, /1 sem chamada ao servidor/);
  // A delivery says it too, with the server observation of the merge.
  const delivered = deliverOutcome({ envelope: { ok: true, data: { ...state, delivered: true, writeState: 'applied', validation: { newErrors: 0 },
    producerAttestationBeforeMerge: [{ path: 'C:\\w\\producers\\VisitaCerta_IS.avsig', by: 'server', attested: true }] } } }, { trackId: 't', work: 'C:\\w', job: 'C:\\j.json' });
  assert.equal(delivered.result, 'entregue');
  assert.equal(delivered.producers[0].beforeMerge, 'server');
  // Without producers nothing is added (the answers of before stay byte for byte).
  assert.equal(producerSignaturesOf({}).producers, undefined);
  assert.equal(deliverOutcome({ envelope: { ok: true, data: { delivered: true, writeState: 'applied', validation: { newErrors: 0 } } } }, { trackId: 't', work: 'C:\\w' }).producers, undefined);
});

test('PRODUCER_CHANGED: nothing written, and the same delivery again (closing the refused task) captures the new version', () => {
  const state = { taskId: TASK, writeState: 'not-sent', code: 'PRODUCER_CHANGED', stage: 'producer-attestation',
    error: 'VersionIdChanged: VisitaCerta_IS changed since its capture (6773 -> 6774); capture it again',
    capturedProducers: { VisitaCerta_IS: { producer: 'VisitaCerta_IS', path: 'C:\\w\\p.avsig', versionId: 6773, reusedFromCache: true, observed: { by: 'ledger' } } },
    producerAttestationBeforeMerge: [] };
  const input = { module: 'VisitaCerta_CS', captureProducers: ['VisitaCerta_IS'], expectedEnvironment: HOST };
  const value = deliverOutcome({ envelope: { ok: true, data: state } }, { trackId: 't', work: 'C:\\w', job: 'C:\\jobs\\j.json', input });
  assert.equal(value.code, 'PRODUCER_CHANGED');
  assert.equal(value.continuation.tool, 'o11_deliver');
  assert.deepEqual(value.continuation.arguments, { module: 'VisitaCerta_CS', job: 'C:\\jobs\\j.json', captureProducers: ['VisitaCerta_IS'], expectedEnvironment: HOST,
    closePrevious: TASK, authorize: WORDS_MARKER });
  assert.match(value.continuation.why, /captura a versão nova/);
});

test('F6: the packet lists the cached signatures the intent needs, with the reference op, deterministically', t => {
  const s = sandbox(t);
  storeLikeKernel(s.cache, { environment: HOST, producer: 'VisitaCerta_IS', elements: ['IServiceAction:GetWeeklyForecastByCep', 'IServiceAction:GetAddressByCep'],
    receipt: { producer: 'VisitaCerta_IS', versionIdBefore: 6773 } });
  storeLikeKernel(s.cache, { environment: HOST, producer: 'Pagamentos_IS', elements: ['IServiceAction:Cobrar'], receipt: { producer: 'Pagamentos_IS', versionIdBefore: 9 } });
  storeLikeKernel(s.cache, { environment: HOST, producer: '@uXCIR2Atc0+es3zYuZSnNw', elements: ['@x'], receipt: { producer: '(System)', advertisedSignatureHash: 'h' } });
  storeLikeKernel(s.cache, { environment: HOST, producer: 'VisitaCerta_CS', elements: ['IServerAction:X'], receipt: { producer: 'VisitaCerta_CS', versionIdBefore: 1 } });
  const section = packetProducers(s.cache, { intent: 'crie as actions de visita no mesmo módulo', module: 'VisitaCerta_CS' });
  assert.deepEqual(section.producers, [{ producer: 'VisitaCerta_IS', environment: HOST, versionId: 6773,
    op: { op: 'reference', producer: 'VisitaCerta_IS', elements: ['IServiceAction:GetAddressByCep', 'IServiceAction:GetWeeklyForecastByCep'] } }], 'the app\'s producer, never the module itself, an owner or an unrelated producer');
  // Named by the intent (or by one of its elements), another app's producer comes too.
  assert.deepEqual(packetProducers(s.cache, { intent: 'cobrar o pedido com Pagamentos_IS', module: 'Vendas_CS' }).producers.map(p => p.producer), ['Pagamentos_IS']);
  assert.deepEqual(packetProducers(s.cache, { intent: 'usar a previsao semanal GetWeeklyForecastByCep', module: 'Outro_CS' }).producers.map(p => p.producer), ['VisitaCerta_IS']);
  assert.equal(packetProducers(s.cache, { intent: 'nada a ver', module: 'Outro_CS' }), null);
  assert.equal(packetProducers(path.join(s.base, 'missing'), { intent: 'VisitaCerta_IS' }), null);
  // In the packet: the environment section, the order unchanged, the same bytes twice, no time.
  const input = { lane: 'o11', intent: 'crie as actions', basis: null, matches: [], unavailable: [], categories: new Map(), slices: () => ({}), module: null, producers: section };
  const a = workPacket(input), b = workPacket(input);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(Object.keys(a).filter(k => PACKET_ORDER.includes(k)), PACKET_ORDER);
  assert.deepEqual(a.environment.producers, section);
  assert.doesNotMatch(JSON.stringify(a), /storedAtUtc|observedAtUtc|"cache"/);
  assert.equal(workPacket({ ...input, producers: null }).environment, null, 'no producers: the section as before');
});

// ---- the ODC lane (kernel-delivery.mjs): the reference snapshot of a producer reused for the build, acquired again before
// the merge (the only write) and compared byte for byte.
function odcFixture(t, { revision = () => '1' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-odc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify({ ops: [{ op: 'reference', producer: 'Biblioteca', elements: ['IAction:Calcular'] }] }));
  const calls = []; let lab = 0;
  const deps = { root, nextLabDir: () => path.join(root, 'lab-' + (++lab)), journal: () => {}, cache: null, guide: null, grants: null, prefetch: () => {},
    studio: async ([step, argument]) => {
      calls.push(step);
      if (step === 'snapshot') return { ok: true, path: 'base.oml', sha256: 'HASH', host: 'tenant.test', module: 'App' };
      if (step === 'reference-snapshot') {
        const request = JSON.parse(argument); const bytes = JSON.stringify({ Name: request.producer, Revision: revision() });
        fs.writeFileSync(request.output, bytes);
        return { ok: true, environment: 'tenant.test', consumerUnchanged: true, sha256: sha256(bytes), producerKey: 'k', revision: revision() };
      }
      if (step === 'merge') return { ok: true, merged: true, strictlyEqual: true };
      return { ok: true };
    },
    apply: async () => { calls.push('apply'); return { ok: true, candidate: 'candidate.oml', receipt: 'kernel-result.json' }; },
    prepareManifest: async () => { calls.push('manifest'); return { ok: true, manifest: 'manifest.json' }; } };
  const input = { module: 'App', feature: 'f5', job: 'job.json', owners: ['A'], changes: ['C'] };
  return { root, deps, calls, input, cache: path.join(root, '.local', 'producer-cache') };
}

test('ODC: a delivery that merges reuses the reference snapshot acquired lately for its build, acquires it again and merges on the same bytes', async t => {
  const { deliverKernel } = await import('../kernel-delivery.mjs');
  const f = odcFixture(t);
  const first = await deliverKernel({ ...f.input, until: 'build' }, f.deps);
  assert.equal(first.ok, true);
  assert.deepEqual(f.calls, ['snapshot', 'reference-snapshot', 'apply', 'manifest']);
  assert.equal(first.producers[0].reused, undefined);
  f.calls.length = 0;
  const merged = await deliverKernel(f.input, f.deps);
  assert.equal(merged.ok, true, merged.error);
  assert.deepEqual(f.calls.slice(0, 5), ['snapshot', 'apply', 'manifest', 'reference-snapshot', 'merge'], 'no acquisition for the build, one right before the merge');
  assert.deepEqual([merged.producers[0].reused, merged.producers[0].observed, merged.producers[0].beforeMerge], [true, 'ledger', 'acquired']);
});

test('ODC: build, check-base and preview never reuse: the manifest they hand to a later studio_merge is built on a producer acquired now', async t => {
  const { deliverKernel } = await import('../kernel-delivery.mjs');
  let current = '1';
  const f = odcFixture(t, { revision: () => current });
  await deliverKernel({ ...f.input, until: 'build' }, f.deps);   // the workspace has a valid snapshot of revision 1
  current = '2';   // Biblioteca published by the Portal, by hand or by another workspace: nothing recorded it
  for (const until of ['build', 'check-base', 'preview']) {
    f.calls.length = 0;
    const stopped = await deliverKernel({ ...f.input, until }, f.deps);
    assert.equal(stopped.ok, true, stopped.error);
    assert.equal(f.calls[1], 'reference-snapshot', until + ' acquires the producer for its build');
    assert.equal(stopped.producers[0].reused, undefined);
    assert.equal(stopped.producers[0].revision, '2', until + ': the manifest is built on the published revision');
  }
  // The next delivery that merges reuses the revision the preview acquired, and refuses if it moved again since.
  current = '3';
  f.calls.length = 0;
  const changed = await deliverKernel(f.input, f.deps);
  assert.equal(changed.code, 'PRODUCER_CHANGED');
  assert.ok(!f.calls.includes('merge'), 'nothing merged');
});

test('an observation made while a publication runs is never reused, not even after its end; one made after its end is', t => {
  const s = sandbox(t);
  const T0 = Date.parse('2026-10-12T21:09:58Z'); const at = ms => new Date(T0 + ms);
  const avsig = path.join(s.base, 'Lib.avsig'); fs.writeFileSync(avsig, '{"Name":"VisitaCerta_IS","Revision":6773}');
  const target = path.join(s.base, 'out', 'Lib.avsig');
  // Session A starts publishing VisitaCerta_IS at T0 (the server changes at T0+20s); session B observes it at T0+5s, still 6773.
  const publication = recordPublished(s.cache, { environment: HOST, module: 'VisitaCerta_IS', at: at(0), id: 'a' });
  rememberOdcReference(s.cache, { environment: HOST, producer: 'VisitaCerta_IS', file: avsig, now: at(5_000) });
  for (const later of [10 * 60_000, 28 * 60_000])
    assert.equal(reuseOdcReference(s.cache, { environment: HOST, producer: 'VisitaCerta_IS', target, now: at(later) }), null, 'in flight, ' + later / 60_000 + ' min later');
  recordPublicationEnded(publication, { at: at(21_000) });
  assert.equal(reuseOdcReference(s.cache, { environment: HOST, producer: 'VisitaCerta_IS', target, now: at(10 * 60_000) }), null, 'observed inside [start, end]');
  // Observed again after the end: it counts.
  rememberOdcReference(s.cache, { environment: HOST, producer: 'VisitaCerta_IS', file: avsig, now: at(30_000) });
  assert.ok(reuseOdcReference(s.cache, { environment: HOST, producer: 'VisitaCerta_IS', target, now: at(10 * 60_000) }));
  // A publication whose end was never recorded (a crash) counts as running for MAX_PUBLICATION_MS after its start.
  recordPublished(s.cache, { environment: HOST, module: 'VisitaCerta_IS', at: at(60_000), id: 'crash' });
  rememberOdcReference(s.cache, { environment: HOST, producer: 'VisitaCerta_IS', file: avsig, now: at(90_000) });
  assert.equal(reuseOdcReference(s.cache, { environment: HOST, producer: 'VisitaCerta_IS', target, now: at(120_000) }), null);
  rememberOdcReference(s.cache, { environment: HOST, producer: 'VisitaCerta_IS', file: avsig, now: at(60_000 + MAX_PUBLICATION_MS + 1_000) });
  assert.ok(reuseOdcReference(s.cache, { environment: HOST, producer: 'VisitaCerta_IS', target, now: at(60_000 + MAX_PUBLICATION_MS + 60_000) }));
});

test('ODC: a producer published again since the reused snapshot stops before the merge (PRODUCER_CHANGED) and is acquired next time', async t => {
  const { deliverKernel } = await import('../kernel-delivery.mjs');
  let current = '1';
  const f = odcFixture(t, { revision: () => current });
  await deliverKernel({ ...f.input, until: 'build' }, f.deps);
  current = '2';   // published by someone else: nothing recorded it
  f.calls.length = 0;
  const changed = await deliverKernel({ ...f.input, publish: true, authorize: 'pode publicar o App' }, f.deps);
  assert.equal(changed.ok, false);
  assert.equal(changed.code, 'PRODUCER_CHANGED');
  assert.ok(!f.calls.includes('merge'), 'nothing merged');
  assert.equal(changed.merged, false);
  assert.deepEqual(changed.publish, { requested: true, outcome: 'skipped' });
  assert.equal(changed.continuation.tool, 'studio_deliver');
  assert.equal(changed.continuation.arguments.job, 'job.json');
  f.calls.length = 0;
  const next = await deliverKernel({ ...f.input, until: 'build' }, f.deps);
  assert.deepEqual(f.calls, ['snapshot', 'reference-snapshot', 'apply', 'manifest'], 'the next delivery acquires it again');
  assert.equal(next.producers[0].revision, '2');
});

test('ODC: a publication SSAM records (studio_deliver publish, studio_publish) ends the reuse of that producer', async t => {
  const { deliverKernel } = await import('../kernel-delivery.mjs');
  const f = odcFixture(t);
  await deliverKernel({ ...f.input, until: 'build' }, f.deps);
  await new Promise(resolve => setTimeout(resolve, 15));
  const publication = recordPublished(f.cache, { environment: '*', module: 'Biblioteca', source: 'studio_publish' });   // a manifest without its tenant
  recordPublicationEnded(publication);
  f.calls.length = 0;
  await deliverKernel(f.input, f.deps);
  assert.deepEqual(f.calls.slice(0, 5), ['snapshot', 'reference-snapshot', 'apply', 'manifest', 'merge'], 'acquired for the build; nothing reused, so no second acquisition');
  // signatureCache:null turns the rule off.
  f.calls.length = 0;
  await deliverKernel(f.input, { ...f.deps, signatureCache: null });
  assert.deepEqual(f.calls.slice(0, 5), ['snapshot', 'reference-snapshot', 'apply', 'manifest', 'merge']);
});

test('Service Center publications are in the ledger: extension-publish until its confirmed answer, solution-publish until its status read sees the job finish', async t => {
  const s = sandbox(t);
  const { registerO11Operations } = await import('../o11-operations.mjs');
  const tools = new Map(); const seen = [];
  let answer = { ok: true, state: 'confirmed', executionCompleted: true };
  registerO11Operations({ registerTool: (name, config, handler) => tools.set(name, handler) }, schema => schema,
    { signatureCache: s.cache, tool: async argv => { seen.push([argv[0], unsafeUntil(s.cache, { environment: HOST, producer: 'Pdf' }) > Date.now()]); return answer; } });
  const write = args => tools.get('o11_service_center_write')({ host: HOST, words: 'pode publicar', execute: true, operationId: randomUUIDv4(), ...args });
  await write({ action: 'extension-publish', extension: 'Pdf', xifFile: 'C:\\x\\Pdf.xif' });
  assert.deepEqual(seen.pop(), ['extension-publish', true], 'recorded before the Service Center call');
  assert.ok(unsafeUntil(s.cache, { environment: HOST, producer: 'Pdf' }) <= Date.now(), 'ended by the confirmed answer');
  answer = { ok: false, state: 'uncertain' };
  await write({ action: 'extension-publish', extension: 'Pdf', xifFile: 'C:\\x\\Pdf.xif' });
  assert.ok(unsafeUntil(s.cache, { environment: HOST, producer: 'Pdf' }) > Date.now(), 'an uncertain one stays running');
  // A solution publish: every producer of the environment, until its job is seen finished.
  answer = { ok: true, state: 'accepted', executionCompleted: false };
  const operationId = randomUUIDv4();
  await write({ action: 'solution-publish', solution: 'Sol', operationId });
  assert.ok(unsafeUntil(s.cache, { environment: HOST, producer: 'AnyModule' }) > Date.now());
  answer = { ok: true, publicationObservation: { terminal: true, success: true } };
  await tools.get('o11_service_center_read')({ action: 'solution-publish-status', host: HOST, publishId: '7', operationId });
  assert.equal(fs.readdirSync(path.join(s.cache, 'publishing')).filter(n => n.includes(operationId)).length, 0, 'the status read ends it');
  // A plan (no execute) records nothing.
  const before = fs.readdirSync(path.join(s.cache, 'publishing')).length;
  await tools.get('o11_service_center_write')({ action: 'extension-publish', host: HOST, extension: 'Pdf', xifFile: 'C:\\x\\Pdf.xif' });
  assert.equal(fs.readdirSync(path.join(s.cache, 'publishing')).length, before);
});

test('o11_job: a round built on a reused signature says it is not valid for a direct OML merge', async () => {
  const { summarize } = await import('../job-runner.mjs');
  const saved = { ok: true, data: { accepted: true, isValid: true }, capturedProducers: [{ producer: 'VisitaCerta_IS', versionIdBefore: 6773, reused: true, observed: { by: 'ledger' }, mergeReady: false }] };
  const value = summarize({ lane: 'o11', job: 'j.json', out: 'o.oml', resultFile: 'r.json', saved });
  assert.deepEqual([value.capturedProducers[0].reused, value.capturedProducers[0].mergeReady], [true, false]);
  assert.match(value.capturedProducersNote, /não vale para merge direto/);
  const fresh = summarize({ lane: 'o11', job: 'j.json', out: 'o.oml', resultFile: 'r.json', saved: { ...saved, capturedProducers: [{ producer: 'VisitaCerta_IS', versionIdBefore: 6773 }] } });
  assert.equal(fresh.capturedProducersNote, undefined);
});

test('o11_publish records the publication before it reaches the Studio', async t => {
  const s = sandbox(t);
  const home = path.join(s.base, 'home'); fs.mkdirSync(home, { recursive: true });
  const env = { ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4', USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home, ANVIL_AUTHORITY_DIR: home };
  const ok = data => ({ success: true, data, error: null });
  const seen = [];
  const fake = await fakeBridge(async request => {
    switch (request.method) {
      case 'open_module': return ok({ name: request.params.name, opened: true, alreadyOpen: true, selected: true, serverSilentMode: false, elapsedMs: 3 });
      case 'get_active_module': return ok({ name: 'Orders_IS', key: 'k-orders', kind: 'Service', environment: HOST, isModified: false, pendingDialogs: [] });
      case 'get_errors': return ok({ isValid: true, errors: 0, warnings: 0, total: 0, byType: {}, messages: [], rawMessages: [] });
      case 'publish':
        seen.push(fs.existsSync(path.join(s.cache, 'published', ledgerId(HOST, 'Orders_IS') + '.json')));
        return ok({ module: 'Orders_IS', published: true, state: 'CompletedWithSuccessNotOpenedInBrowser', isValid: true, elapsedMs: 42 });
      default: return { success: false, data: null, error: 'Unknown method: ' + request.method };
    }
  });
  const server = new McpServer({ name: 'f5-publish', version: '1.0.0' });
  let clock = Date.parse('2026-10-12T21:09:00.000Z');
  registerO11Publish(server, { root: s.root, env, lane: 'ss4', now: () => new Date(clock += 1000), bridge: o11Bridge({ port: fake.port, authorization: 'K' }), assertSelected: async () => {} });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'f5-publish-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); await fake.close(); });
  const reply = await client.callTool({ name: 'o11_publish', arguments: { module: 'Orders_IS', authorize: 'sim, pode publicar o Orders_IS' } });
  assert.equal(JSON.parse(reply.content[0].text).ok, true, reply.content[0].text);
  assert.deepEqual(seen, [true], 'recorded before the publish call');
  const record = JSON.parse(fs.readFileSync(path.join(s.cache, 'published', ledgerId(HOST, 'Orders_IS') + '.json'), 'utf8'));
  assert.deepEqual([record.environment, record.module, record.key, record.source], [HOST, 'Orders_IS', 'k-orders', 'o11_publish']);
  // ... and its end after the confirmed publication: no marker left, observations after the end count.
  assert.ok(Date.parse(record.endedAtUtc) > Date.parse(record.publishedAtUtc));
  assert.deepEqual(fs.readdirSync(path.join(s.cache, 'publishing')), []);
});
