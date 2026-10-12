// Lane surface of the prototype importer (docs/PROTOTIPO-NATIVO.md 1.1-1.6, 7.6): the op's capture before any Studio or
// build work, the single refusal with every problem and the ready patch, the silent recapture, the degradation of 1.4.1,
// the receipt, and the hooks in ssam_job/o11_job (job-runner.mjs), studio_deliver (kernel-delivery.mjs) and o11_deliver
// (o11-cycle.mjs). Every other lane is a fake (fixtures/prototype-surface/fakes.mjs): no Studio, no CLI, no network.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { expandPrototypeOps, expandJobFile, resolveSource, inferPrefix, prefixFromTitle, buildWithDegradation, degradeCapture, selectorOf,
  prototypeReceipt, measurePrototypeFidelity, findNativeDom, kernelPrototypeReport, prototypeCall, prototypeDeliveryDefaults, strictPatch, canonicalSha256,
  TIMING_KEYS, RECEIPT_SCHEMA, PROTOTYPE_CODES, receiptWithSeed, prototypeCli, dataProblems } from '../prototype-op.mjs';
import { patchJob } from '../job-patch.mjs';
import { runJob } from '../job-runner.mjs';
import { deliverKernel, requiredFlowLayoutEngine } from '../kernel-delivery.mjs';
import { registerO11Cycle } from '../o11-cycle.mjs';
import { shapeToolResult, compactDelivery } from '../responses.mjs';
import { codeFromText, PROTOTYPE_CODES as REGISTERED } from '../refusal-codes.mjs';
import { prototypeAppUrl, prototypeScreenLinks } from '../next-steps.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { farmaFolder, farmaIr, fakeCapture, kernelReport, fakeMeasure, writeNativeDom } from './fixtures/prototype-surface/fakes.mjs';

const WORDS = 'sim, pode importar o protótipo, publicar e carregar os dados de demonstração no Haiku_UI';
function tmp(t, name = 'proto-op-') { const dir = fs.mkdtempSync(path.join(os.tmpdir(), name)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const jobOf = (source, extra = {}) => ({ ops: [{ op: 'prototype', data: { source, ...extra } }] });

// ---- rule 1: the op gets its capture before anything else
test('rule 1: a prototype op without capture comes back with data.capture and data.captureSha256 (injected capture); the job given is not changed', async t => {
  const dir = tmp(t); const source = farmaFolder(dir); const calls = [];
  const job = jobOf(source);
  const expanded = await expandPrototypeOps(job, { work: path.join(dir, 'work'), capture: fakeCapture({ calls }) });
  assert.equal(expanded.refusal, undefined);
  assert.equal(expanded.expanded, true);
  const data = expanded.job.ops[0].data;
  assert.ok(fs.existsSync(data.capture), 'the bundle capture.json exists');
  assert.equal(data.captureSha256, canonicalSha256(JSON.parse(fs.readFileSync(data.capture, 'utf8'))));
  assert.equal(job.ops[0].data.capture, undefined, 'the job given is never changed');
  assert.equal(calls.length, 1); assert.equal(calls[0].source, source); assert.equal(calls[0].entry, 'index.html'); assert.equal(calls[0].tz, 'UTC');
  assert.equal(expanded.captures[0].summary.views, 6);
  assert.ok(Number.isFinite(expanded.timings.captureMs) && Number.isFinite(expanded.timings.expandMs));
  // The job file form: a new inline file with the expanded job; a job without a prototype op writes nothing.
  const file = path.join(dir, 'job.json'); fs.writeFileSync(file, JSON.stringify(job));
  const written = await expandJobFile(file, { inlineDir: path.join(dir, 'inline'), work: path.join(dir, 'w2'), capture: fakeCapture() });
  assert.notEqual(written.path, file); assert.equal(JSON.parse(fs.readFileSync(written.path, 'utf8')).ops[0].data.captureSha256.length, 64);
  const plain = path.join(dir, 'plain.json'); fs.writeFileSync(plain, JSON.stringify({ ops: [{ op: 'get', target: 'X:Y' }] }));
  assert.equal(await expandJobFile(plain, { inlineDir: path.join(dir, 'inline') }), null);
});

test('rule 1: the entry and the prefix come from the folder (index.html, the <title> up to its separator), never from the model', async t => {
  const dir = tmp(t); const source = farmaFolder(dir);
  assert.deepEqual(resolveSource({ source }), { ok: true, root: source, entry: 'index.html' });
  assert.deepEqual(resolveSource({ source: path.join(source, 'index.html') }), { ok: true, root: source, entry: 'index.html' });
  assert.deepEqual(inferPrefix({ source }), { prefix: 'FarmaVirtual', from: 'title' });
  assert.equal(prefixFromTitle('Painel - Vendas'), 'Painel'); assert.equal(prefixFromTitle('Gestão: pedidos'), 'Gestao');
  assert.deepEqual(inferPrefix({ source, prefix: 'Farma' }), { prefix: 'Farma', from: 'data.prefix' });
  // Two pages and no index.html: the entry is asked with the patch of the first candidate.
  const two = path.join(dir, 'two'); fs.mkdirSync(two); fs.writeFileSync(path.join(two, 'a.html'), '<title>A</title>'); fs.writeFileSync(path.join(two, 'b.html'), '');
  const r = resolveSource({ source: two });
  assert.equal(r.ok, false); assert.equal(r.problem.code, 'PROTOTYPE_SOURCE_INVALID'); assert.deepEqual(r.problem.patch, [{ op: 'add', path: '/entry', value: 'a.html' }]);
  // The ODC delivery fields the prefix implies.
  assert.deepEqual(prototypeDeliveryDefaults(jobOf(source), { module: 'Haiku' }), { feature: 'Protótipo FarmaVirtual', owners: ['FarmaVirtual'], changes: ['Protótipo FarmaVirtual importado como telas nativas'] });
  assert.equal(prototypeDeliveryDefaults({ ops: [{ op: 'get' }] }), null);
});

// ---- rule 2: one refusal with every problem of every op, the patch and the corrected call; nothing is built
const ambiguous = [
  { code: 'PROTOTYPE_AMBIGUOUS', path: '/ops/0/data/mapping/states', message: 'a vista relatorio só renderiza o fallback em todos os estados explorados',
    patch: [{ op: 'add', path: '/ops/0/data/mapping/states', value: { relatorio: { perfil: 'admin' } } }] },
  { code: 'PROTOTYPE_AMBIGUOUS', path: '/mapping/data', message: 'a lista .order-row correlaciona com dados, mas nenhum store foi achado',
    patch: [{ op: 'add', path: '/mapping/data', value: 'App.db.load()' }], alternatives: ['window.DATA', 'Store.initial()'] },
];
test('rule 2: capture problems of every op come back ONCE, with the strict patch over /ops/<i>/data and correctedJob', async t => {
  const dir = tmp(t); const source = farmaFolder(dir);
  const job = { ops: [{ op: 'prototype', data: { source } }, { op: 'get', target: 'X:Y' }, { op: 'prototype', data: { source: path.join(dir, 'missing'), sourc: 'x', tz: 'Mars/Base' } }] };
  const expanded = await expandPrototypeOps(job, { work: path.join(dir, 'w'), capture: fakeCapture({ problems: ambiguous }) });
  const r = expanded.refusal;
  assert.ok(r, 'a refusal');
  assert.equal(r.ok, false); assert.equal(r.outcome, 'refused'); assert.equal(r.stage, 'prototype');
  assert.equal(r.code, 'PROTOTYPE_SOURCE_INVALID', 'the code that stops a capture leads');
  assert.deepEqual(r.problems.map(p => [p.op, p.code, p.pointer]).sort(), [
    [0, 'PROTOTYPE_AMBIGUOUS', '/ops/0/data/mapping/data'], [0, 'PROTOTYPE_AMBIGUOUS', '/ops/0/data/mapping/states'],
    [2, 'INPUT_INVALID', '/ops/2/data/sourc'], [2, 'INPUT_INVALID', '/ops/2/data/tz'], [2, 'PROTOTYPE_SOURCE_INVALID', '/ops/2/data/source']].sort());
  assert.deepEqual(r.problems.find(p => p.pointer.endsWith('/mapping/data')).alternatives, ['window.DATA', 'Store.initial()']);
  // The combined patch applies strictly (job-patch.mjs, as patch + basedOn does) to the job as it was sent and gives correctedJob.
  assert.deepEqual(patchJob(job, r.patch).job, r.correctedJob);
  assert.deepEqual(r.correctedJob.ops[0].data.mapping, { states: { relatorio: { perfil: 'admin' } }, data: 'App.db.load()' });
  assert.equal(r.correctedJob.ops[2].data.tz, 'UTC'); assert.equal(r.correctedJob.ops[2].data.sourc, undefined);
  assert.equal(r.correctedJob.ops[0].data.capture, undefined, 'the corrected call never carries what the facade writes');
  for (const p of r.problems.filter(p => p.patch)) assert.doesNotThrow(() => patchJob(job, p.patch), p.pointer + ': each patch applies alone');
  assert.deepEqual([...REGISTERED].sort(), [...PROTOTYPE_CODES].sort(), 'refusal-codes registers the codes');
  assert.equal(codeFromText('relayed: PROTOTYPE_RENDER_FAILED at app.js:12:3'), 'PROTOTYPE_RENDER_FAILED');
});

test('rule 2: mapping.names (the name map a PROTOTYPE_NAME_COLLISION gives) is a mapping key; a near miss comes back with the patch', () => {
  const names = { 'Catalogo/FecharAviso': 'FecharAviso2', FarmaVirtualTheme: 'FarmaVirtualTema' };
  assert.deepEqual(dataProblems({ source: 'C:\\p', mapping: { names } }), []);
  const near = dataProblems({ source: 'C:\\p', mapping: { name: names } });
  assert.equal(near.length, 1); assert.match(near[0].message, /did you mean names\?/);
  assert.deepEqual(near[0].patch, [{ op: 'remove', path: '/mapping/name' }, { op: 'add', path: '/mapping/names', value: names }]);
});

test('rule 2: the refusal reaches no build and no Studio: ssam_job runs no apply, studio_deliver takes no snapshot, o11_deliver selects no Studio', async t => {
  const dir = tmp(t); const source = farmaFolder(dir);
  // ssam_job / o11_job
  const root = path.join(dir, 'anvil'); fs.mkdirSync(root, { recursive: true });
  const runAnvil = fakeAnvil({ apply: () => { throw new Error('the build must not run'); } });
  const job = path.join(dir, 'job.json'); fs.writeFileSync(job, JSON.stringify(jobOf(source)));
  const value = await runJob({ lane: 'o11', job }, { root, env: { ANVIL_WORKER: '0' }, runAnvil, worker: null, o11Lane: 'ss4', capturePrototype: fakeCapture({ problems: ambiguous }),
    prepareIntegrationJob: async () => ({ ok: true }) });
  assert.equal(value.ok, false); assert.equal(value.code, 'PROTOTYPE_AMBIGUOUS'); assert.equal(value.job, job, 'names the job as given');
  assert.equal(runAnvil.calls.length, 0);
  // studio_deliver
  const calls = [];
  const odc = path.join(dir, 'odc'); fs.mkdirSync(odc, { recursive: true }); fs.writeFileSync(path.join(odc, 'job.json'), JSON.stringify(jobOf(source)));
  const report = await deliverKernel({ module: 'Haiku', feature: 'Protótipo FarmaVirtual', job: 'job.json', owners: ['FarmaVirtual'], changes: ['x'], publish: true, authorize: WORDS },
    { root: odc, studio: async args => { calls.push(args[0]); return { ok: true }; }, apply: async () => { throw new Error('no build'); }, journal: () => {}, guide: null, prefetch: () => {}, cache: null, grants: null,
      catalog: () => null, nextLabDir: () => path.join(odc, 'lab', '01'), prepareManifest: async () => ({ ok: true }), prepareIntegrationJob: async () => ({ ok: true }), capturePrototype: fakeCapture({ problems: ambiguous }) });
  assert.equal(report.ok, false); assert.equal(report.code, 'PROTOTYPE_AMBIGUOUS'); assert.equal(report.failed, 'prototype');
  assert.deepEqual(calls, [], 'no Studio command'); assert.equal(report.publish.outcome, 'skipped');
  assert.ok(report.correctedJob && report.patch?.length);
  const shaped = compactDelivery('studio_deliver', {}, report);
  assert.ok(shaped.patch && shaped.correctedJob, 'the compact answer keeps the patch and the corrected call');
  // o11_deliver
  const o11 = await o11Harness(t, { capture: fakeCapture({ problems: ambiguous }) });
  const answer = await o11.call({ module: 'Orders', job: o11.job(jobOf(source)), authorize: WORDS });
  assert.equal(answer.ok, false); assert.equal(answer.code, 'PROTOTYPE_AMBIGUOUS');
  assert.equal(o11.selected.length, 0, 'the Studio is never selected'); assert.equal(o11.runAnvil.calls.length, 0);
  assert.ok(answer.nextBasedOn && answer.patch?.length && answer.correctedJob);
});

// ---- rule 3: a divergent capture is captured again in silence
test('rule 3: a divergent captureSha256 (or a changed prototype file) is captured again without a refusal; a current one is reused', async t => {
  const dir = tmp(t); const source = farmaFolder(dir); const calls = [];
  const first = await expandPrototypeOps(jobOf(source), { work: path.join(dir, 'w1'), capture: fakeCapture({ calls }) });
  const current = first.job;
  const again = await expandPrototypeOps(current, { work: path.join(dir, 'w2'), capture: fakeCapture({ calls }) });
  assert.equal(calls.length, 1, 'the same capture is reused'); assert.equal(again.captures[0].reused, true); assert.deepEqual(again.warnings, []);
  const stale = structuredClone(current); stale.ops[0].data.captureSha256 = 'f'.repeat(64);
  const refreshed = await expandPrototypeOps(stale, { work: path.join(dir, 'w3'), capture: fakeCapture({ calls }) });
  assert.equal(refreshed.refusal, undefined); assert.equal(calls.length, 2);
  assert.equal(refreshed.warnings[0].code, 'captureRefreshed'); assert.match(refreshed.warnings[0].why, /captureSha256/);
  assert.notEqual(refreshed.job.ops[0].data.captureSha256, 'f'.repeat(64));
  fs.appendFileSync(path.join(source, 'app.js'), '\n// changed');
  const changed = await expandPrototypeOps(current, { work: path.join(dir, 'w4'), capture: fakeCapture({ calls }) });
  assert.equal(calls.length, 3); assert.match(changed.warnings[0].why, /app\.js changed/);
});

// ---- rule 4: the degradation of 1.4.1
test('rule 4: a build problem on a generated k rebuilds ONCE without it (degraded[]); a second failure is VALIDATION_REFUSED with ssamDefect and the ignore patch', async t => {
  const dir = tmp(t); const source = farmaFolder(dir);
  const expanded = await expandPrototypeOps(jobOf(source), { work: path.join(dir, 'w'), capture: fakeCapture() });
  const jobFile = path.join(dir, 'expanded.json'); fs.writeFileSync(jobFile, JSON.stringify(expanded.job));
  const problems = [{ code: 'InvalidHTMLTag', message: 'not a valid HTML tag', k: 'v:catalogo/0/0/2' },
    { code: 'InvalidAttribute', message: 'bad attribute', k: 'v:catalogo/0/0/1', property: 'data-action' },
    { code: 'ActionInvalid', message: 'the generated action does not validate', k: 'catalogo:click:add' },
    { code: 'OTHER', message: 'no k: a problem of the module, never degraded' }];
  const seen = [];
  const ok = await buildWithDegradation({ jobFile, inlineDir: path.join(dir, 'inline'), ok: r => r.ok === true, problemsOf: r => r.problems ?? [],
    attempt: async file => { seen.push(file); return seen.length === 1 ? { ok: false, problems } : { ok: true }; } });
  assert.equal(seen.length, 2, 'exactly one rebuild'); assert.equal(ok.rebuilt, true); assert.equal(ok.refusal, undefined);
  assert.deepEqual(ok.degraded.map(d => [d.k, d.kind]), [['v:catalogo/0/0/2', 'node'], ['v:catalogo/0/0/1', 'property'], ['catalogo:click:add', 'event']]);
  const rebuiltJob = JSON.parse(fs.readFileSync(seen[1], 'utf8'));
  const degradedIr = JSON.parse(fs.readFileSync(rebuiltJob.ops[0].data.capture, 'utf8'));
  assert.match(rebuiltJob.ops[0].data.capture, /capture\.degraded\.json$/);
  const card = degradedIr.views[0].root.c[0].c[0];
  assert.deepEqual(card.c[2], { k: 'v:catalogo/0/0/2', t: 'span', a: [['class', 'stock-label']], c: [{ k: 'v:catalogo/0/0/2/0', x: 'Disponível em estoque' }] }, 'node made literal');
  assert.ok(!card.c[1].a.some(a => a[0] === 'data-action'), 'the attribute left, the widget stays'); assert.ok(!card.c[1].events.includes('catalogo:click:add'));
  assert.equal(degradedIr.events[0].compiled, false);
  assert.equal(rebuiltJob.ops[0].data.captureSha256, canonicalSha256(degradedIr));
  // Second failure: an SSAM defect, the remaining nodes out of the capture by mapping.ignore, on the model's own job.
  const twice = await buildWithDegradation({ jobFile, inlineDir: path.join(dir, 'inline'), ok: r => r.ok === true, problemsOf: r => r.problems ?? [],
    attempt: async () => ({ ok: false, problems: [problems[0], { code: 'X', message: 'h1', k: 'v:pedido/0' }] }) });
  const r = twice.refusal;
  assert.equal(r.code, 'VALIDATION_REFUSED'); assert.equal(r.ssamDefect, true); assert.equal(r.stage, 'build');
  assert.deepEqual(r.patch, [{ op: 'add', path: '/ops/0/data/mapping', value: { ignore: [
    'section.catalog > div.product-grid:nth-child(1) > article.product-card:nth-child(1) > span.stock-label:nth-child(3)', '#order > h1:nth-child(1)'] } }]);
  assert.equal(r.correctedJob.ops[0].data.capture, undefined); assert.deepEqual(r.correctedJob.ops[0].data.mapping.ignore.length, 2);
  assert.equal(r.degraded.length, 2, 'both items were degraded before the second build');
  assert.equal(selectorOf(farmaIr(source), 'v:catalogo/0/0/2'), 'section.catalog > div.product-grid:nth-child(1) > article.product-card:nth-child(1) > span.stock-label:nth-child(3)');
  assert.deepEqual(degradeCapture(farmaIr(source), [{ k: 'nope', kind: 'node' }]).done, [], 'an unknown k degrades nothing');
});

test('rule 4 through ssam_job: the refused apply on a generated k runs once more with the degraded job; the receipt lists degraded', async t => {
  const dir = tmp(t); const source = farmaFolder(dir);
  const root = path.join(dir, 'anvil'); fs.mkdirSync(root, { recursive: true });
  const dom = writeNativeDom(path.join(dir, 'dom'));
  let n = 0;
  const runAnvil = fakeAnvil({ apply: args => {
    n++;
    if (n === 1) return { ok: false, command: 'apply', code: 'PREFLIGHT_REFUSED', error: 'refused', problems: [{ phase: 'verify', code: 'InvalidHTMLTag', message: 'x', k: 'v:catalogo/0/0/2' }] };
    return { ok: true, command: 'apply', data: { accepted: true, isValid: true, ops: 1, results: [{ op: 'prototype', result: kernelReport({ nativeDom: dom }) }] } };
  } });
  const job = path.join(dir, 'job.json'); fs.writeFileSync(job, JSON.stringify(jobOf(source)));
  const value = await runJob({ lane: 'o11', job }, { root, env: { ANVIL_WORKER: '0' }, runAnvil, worker: null, o11Lane: 'ss4', capturePrototype: fakeCapture(), measureFidelity: fakeMeasure(),
    prepareIntegrationJob: async () => ({ ok: true }) });
  assert.equal(value.ok, true, JSON.stringify(value).slice(0, 400));
  assert.equal(n, 2);
  const [first, second] = runAnvil.calls.map(c => c.args[c.args.indexOf('--job') + 1]);
  assert.notEqual(first, second, 'the rebuild runs the degraded job');
  assert.deepEqual(value.prototype.degraded.map(d => d.k), ['v:catalogo/0/0/2']);
  assert.equal(value.prototype.fidelity.score, 1); assert.equal(value.prototypeJob, job);
});

// ---- rule 5: the receipt
test('rule 5: the receipt has screens (renamedFrom, url), popups, blocks, resources, data, events, fidelity per state, verifyWarnings, seed, counts and every timing', () => {
  const report = kernelReport();
  const links = prototypeScreenLinks(report, prototypeAppUrl({ lane: 'o11', host: 'personal-2qqw9srv.outsystemscloud.com', module: 'Haiku_UI' }));
  const receipt = prototypeReceipt(report, { fidelity: fakeMeasure()({}), links,
    phases: { captureMs: 4100, buildMs: 21000, fidelityMs: 900, mergeMs: 52000, publishMs: 14000 },
    seed: { ran: true, entities: 4, rows: 17, seeded: [{ entity: 'FarmaVirtualProduto', rows: 8 }], skippedNotEmpty: [] },
    degraded: [{ k: 'v:x', code: 'C', message: 'm', kind: 'node', action: 'node made literal' }],
    captures: [{ capture: 'C:\\b\\capture.json', captureSha256: 'a'.repeat(64), summary: { probes: 300, windows: 12, pool: 8 } }] });
  assert.equal(receipt.schema, RECEIPT_SCHEMA);
  for (const key of ['source', 'flow', 'theme', 'screens', 'blocks', 'popups', 'resources', 'data', 'events', 'fidelity', 'verifyWarnings', 'degraded', 'seed', 'counts', 'capture', 'timings', 'outOfScope', 'padroes', 'modelBytes'])
    assert.ok(Object.hasOwn(receipt, key), key);
  assert.equal(receipt.screens[1].renamedFrom, 'Carrinho');
  assert.equal(receipt.screens[0].url, 'https://personal-2qqw9srv.outsystemscloud.com/Haiku_UI/Catalogo');
  assert.equal(receipt.popups[0].load, 'ListIndexOf'); assert.equal(receipt.blocks[0].instances, 6);
  assert.equal(receipt.resources.icons.distinct, 33);
  assert.equal(receipt.data.entities.find(e => e.name === 'FarmaVirtualProduto').seeded, 8);
  assert.equal(receipt.events.byEffect.toast, 0); assert.equal(receipt.events.byEffect.upsert, 1); assert.equal(receipt.events.notCompiled.length, 0);
  assert.equal(receipt.fidelity.score, 1); assert.equal(receipt.fidelity.perState.length, 2); assert.equal(receipt.fidelity.css.verbatim, true, 'the construction facts of the kernel stay');
  assert.deepEqual(receipt.verifyWarnings, { total: 34, byCode: { InvalidResourceURL_Offline: 34 } });
  assert.equal(receipt.degraded[0].done, 'node made literal'); assert.deepEqual(receipt.seed, { ran: true, entities: 4, rows: 17, skippedNotEmpty: [] });
  assert.equal(receipt.counts.widgets, 2210); assert.equal(receipt.capture.pool, 8); assert.equal(receipt.source.captureSha256, 'a'.repeat(64));
  assert.deepEqual(Object.keys(receipt.timings), TIMING_KEYS);
  assert.deepEqual(receipt.timings, { captureMs: 4100, expandMs: 1200, buildMs: 21000, verifyMs: 9000, fidelityMs: 900, mergeMs: 52000, publishMs: 14000, seedMs: null });
  assert.equal(receiptWithSeed(receipt, { ran: true, entities: 1, rows: 2, seeded: [], seedMs: 700 }).timings.seedMs, 700);
  // Without a report the receipt still has every key; without the module read back the fidelity says why.
  const bare = prototypeReceipt(null, { fidelity: { measured: false, why: 'no prototype-dom.json' } });
  assert.equal(bare.fidelity.measured, false); assert.deepEqual(Object.keys(bare.timings), TIMING_KEYS); assert.equal(bare.seed.ran, false);
  assert.equal(kernelPrototypeReport({ apply: { results: [{ op: 'prototype', result: report }] } }), report);
});

test('rule 5: the fidelity is measured on prototype-dom.json, never assumed', async t => {
  const dir = tmp(t); const source = farmaFolder(dir);
  const expanded = await expandPrototypeOps(jobOf(source), { work: path.join(dir, 'w'), capture: fakeCapture() });
  const missing = await measurePrototypeFidelity({ captures: expanded.captures, nativeDom: null, measure: fakeMeasure() });
  assert.equal(missing.fidelity.measured, false);
  const dom = writeNativeDom(path.dirname(expanded.captures[0].capture));
  assert.equal(findNativeDom({ captures: expanded.captures }), dom, 'next to the bundle');
  const calls = [];
  const measured = await measurePrototypeFidelity({ captures: expanded.captures, nativeDom: dom, measure: fakeMeasure(calls) });
  assert.equal(measured.fidelity.score, 1); assert.equal(calls[0].capture.schema, 'ssam-prototype-capture/1'); assert.equal(calls[0].nativeDom.schema, 'ssam-prototype-dom/1');
});

// ---- the hooks: studio_deliver (ODC) with merge, publication and seed
function odcFixture(t, { publish = true, nativeDom = true, seedRows = 0 } = {}) {
  const root = tmp(t, 'proto-odc-'); const source = farmaFolder(root);
  fs.writeFileSync(path.join(root, 'job.json'), JSON.stringify(jobOf(source)));
  const calls = []; const writes = [];
  const studio = async args => {
    calls.push(args[0]);
    if (args[0] === 'snapshot') return { ok: true, path: 'base.oml', sha256: 'BASEHASH', host: 'tenant.test', developerId: 'dev@tenant.test', moduleKey: 'KEY', module: 'Haiku',
      appLinks: { available: true, appUrl: 'https://tenant.test/Haiku/' } };
    if (args[0] === 'merge') return { ok: true, merged: true, strictlyEqual: true };
    if (args[0] === 'authorize') return { ok: true };
    if (args[0] === 'publish') return { ok: true, module: 'Haiku', completed: true, state: 'CompletedWithSuccess', published: { revision: 3 }, completedAt: '2026-10-10T22:00:00Z' };
    return { ok: true };
  };
  const apply = async ({ output }) => {
    fs.writeFileSync(path.join(output, 'kernel-candidate.oml'), 'candidate');
    const dom = nativeDom ? writeNativeDom(output) : null;
    fs.writeFileSync(path.join(output, 'kernel-result.json'), JSON.stringify({ ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine,
      results: [{ op: 'prototype', result: kernelReport({ nativeDom: dom }) }] } }));
    return { ok: true, candidate: path.join(output, 'kernel-candidate.oml'), receipt: path.join(output, 'kernel-result.json') };
  };
  const writer = async request => {
    writes.push(request);
    return { ok: true, results: request.batch.map(op => (op.operation === 'insert' ? { ok: true, inserted: op.records.length } : { ok: true, records: op.entity === 'FarmaVirtualPedido' ? Array(seedRows).fill({}) : [] })) };
  };
  let lab = 0;
  const deps = { root, studio, apply, journal: () => {}, guide: null, prefetch: () => {}, cache: null, grants: null, catalog: () => null,
    nextLabDir: () => path.join(root, 'lab', String(++lab).padStart(2, '0')), prepareIntegrationJob: async () => ({ ok: true }),
    prepareManifest: async ({ output }) => { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'manifest.json'), '{}'); return { ok: true, manifest: path.join(output, 'manifest.json') }; },
    publishStep: async () => ({ publish: { requested: true, outcome: 'published', version: 3 }, lastPublication: { at: '2026-10-10T22:00:00Z', status: 'succeeded' } }),
    capturePrototype: fakeCapture(), measureFidelity: fakeMeasure(), prototypeWriter: writer };
  const input = { module: 'Haiku', feature: 'Protótipo FarmaVirtual', job: 'job.json', owners: ['FarmaVirtual'], changes: ['Protótipo FarmaVirtual importado como telas nativas'],
    ...(publish ? { publish: true, authorize: WORDS } : {}) };
  return { root, deps, input, calls, writes };
}

test('studio_deliver: the receipt after the build (fidelity, links), the seed only after a clean publication, the timings of merge, publication and seed', async t => {
  const f = odcFixture(t, { seedRows: 5 });
  const report = await deliverKernel(f.input, f.deps);
  assert.equal(report.ok, true, JSON.stringify(report).slice(0, 600)); assert.equal(report.result, 'entregue e publicado');
  const p = report.prototype;
  assert.equal(p.fidelity.score, 1); assert.equal(p.screens[0].url, 'https://tenant.test/Haiku/Catalogo');
  assert.equal(p.seed.ran, true); assert.deepEqual(p.seed.skippedNotEmpty, ['FarmaVirtualPedido'], 'a table with rows is never written');
  assert.equal(p.seed.entities, 3); assert.equal(p.seed.rows, 8 + 2 + 2);
  assert.equal(f.writes.length, 2, 'one read batch, one insert batch'); assert.equal(f.writes[1].authorization, WORDS);
  for (const key of ['captureMs', 'buildMs', 'fidelityMs', 'publishMs', 'seedMs']) assert.equal(typeof p.timings[key], 'number', key);
  assert.ok(f.calls.indexOf('snapshot') >= 0 && f.calls.indexOf('merge') > f.calls.indexOf('snapshot'));
  // The compact answer keeps the receipt.
  const shaped = shapeToolResult('studio_deliver', f.input, { content: [{ type: 'text', text: JSON.stringify(report) }], structuredContent: report });
  assert.equal(shaped.structuredContent.prototype.schema, RECEIPT_SCHEMA);
  // Without publish:true nothing is seeded.
  const g = odcFixture(t, { publish: false });
  const merged = await deliverKernel(g.input, g.deps);
  assert.equal(merged.ok, true); assert.equal(g.writes.length, 0); assert.equal(merged.prototype.seed.ran, false);
  // A failed publication keeps the delivery (PUBLISH_FAILED, the studio_publish continuation) and seeds nothing.
  const h = odcFixture(t);
  const failed = await deliverKernel(h.input, { ...h.deps, publishStep: async () => ({ publish: { requested: true, outcome: 'failed', error: 'Compilation failed' } }) });
  assert.equal(failed.ok, false); assert.equal(failed.code, 'PUBLISH_FAILED'); assert.equal(failed.result, 'entregue'); assert.equal(failed.continuation.tool, 'studio_publish');
  assert.equal(h.writes.length, 0); assert.equal(failed.prototype.seed.ran, false); assert.match(failed.prototype.seed.reason, /publish/);
});

// ---- the hooks: o11_deliver
async function o11Harness(t, { capture = fakeCapture(), deliver = null, publish = null, writer = null } = {}) {
  const base = tmp(t, 'proto-o11-');
  const root = path.join(base, 'anvil'); const home = path.join(base, 'home'); const auth = path.join(base, 'authority');
  for (const d of [root, home, auth]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, port: 45998, studioDir: path.join(base, 'Studio'), authorityDir: auth }));
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  const runAnvil = fakeAnvil({ deliver: deliver ?? (() => ({ ok: true, command: 'deliver', data: { taskId: 'a'.repeat(32), module: 'Orders', delivered: true, writeState: 'applied', stage: 'complete', environment: 'env.test',
    validation: { newErrors: 0, new: [] }, apply: { isValid: true, accepted: true, validation: { new: [] }, results: [{ op: 'prototype', result: kernelReport() }] } } })) });
  const selected = []; const published = [];
  const deps = { root, env, lane: 'ss4', runAnvil, assertSelected: async () => { selected.push(1); }, lastPublication: async () => null, grantsFile: path.join(base, 'grants.json'),
    capturePrototype: capture, measureFidelity: fakeMeasure(), capture: async () => ({ ok: true, path: path.join(base, 'published.oml'), sha256: 'b'.repeat(64) }),
    ...(writer ? { prototypeWriter: () => writer } : {}),
    ...(publish ? { publish: async input => { published.push(input); return publish; } } : {}) };
  const server = new McpServer({ name: 'proto-o11', version: '1.0.0' });
  registerO11Cycle(server, deps);
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'proto-o11-client', version: '1.0.0' });
  await Promise.all([server.connect(s), client.connect(c)]);
  t.after(async () => { await client.close(); await server.close(); });
  let n = 0;
  return { runAnvil, selected, published, base,
    job: document => { const file = path.join(base, 'jobs', (++n) + '.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(document)); return file; },
    call: args => client.callTool({ name: 'o11_deliver', arguments: args }).then(r => r.structuredContent ?? JSON.parse(r.content[0].text)) };
}

test('o11_deliver: the expanded job is delivered, the receipt carries the screen links; publish:true seeds the empty marked entities with the words of the call', async t => {
  const dir = tmp(t); const source = farmaFolder(dir);
  const writes = [];
  const writer = async request => { writes.push(request); return { ok: true, results: request.batch.map(op => (op.operation === 'insert' ? { ok: true, inserted: op.records.length } : { ok: true, count: 0 })) }; };
  const h = await o11Harness(t, { publish: { ok: true, result: 'publicado', version: 9 }, writer });
  const value = await h.call({ module: 'Orders', job: h.job(jobOf(source)), publish: true, authorize: WORDS });
  assert.equal(value.ok, true, JSON.stringify(value).slice(0, 600)); assert.equal(value.result, 'entregue e publicado');
  const delivered = h.runAnvil.calls.find(c => c.args[0] === 'deliver');
  const file = delivered.args[delivered.args.indexOf('--job') + 1];
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).ops[0].data.captureSha256.length, 64, 'the delivery runs the expanded job');
  assert.equal(value.prototype.screens[0].url, 'https://env.test/Orders/Catalogo');
  assert.equal(value.prototype.seed.ran, true); assert.equal(value.prototype.seed.entities, 4);
  assert.equal(writes[1].authorization, WORDS); assert.equal(typeof value.prototype.timings.publishMs, 'number');
  assert.ok(value.nextBasedOn, 'names the job for the next call');
  // until=apply never publishes nor seeds; the receipt comes with the validation.
  const v = await o11Harness(t, { publish: { ok: true } });
  const dry = await v.call({ module: 'Orders', job: v.job(jobOf(source)), until: 'apply', authorize: WORDS });
  assert.equal(v.published.length, 0); assert.equal(dry.prototype?.seed?.ran ?? false, false);
});

test('o11_deliver without a build phase: a refusal on a generated k delivers the degraded job once; the receipt lists it', async t => {
  const dir = tmp(t); const source = farmaFolder(dir);
  let n = 0;
  const h = await o11Harness(t, { deliver: () => (++n === 1
    ? { ok: true, command: 'deliver', data: { module: 'Orders', delivered: false, writeState: 'not-sent', stage: 'apply', error: 'job rejected by validation contract',
      apply: { isValid: false, accepted: false, problems: [{ phase: 'verify', code: 'InvalidHTMLTag', message: 'x', k: 'v:catalogo/0/0/2' }] } } }
    : { ok: true, command: 'deliver', data: { taskId: 'c'.repeat(32), module: 'Orders', delivered: true, writeState: 'applied', stage: 'complete', validation: { newErrors: 0, new: [] },
      apply: { isValid: true, accepted: true, validation: { new: [] }, results: [{ op: 'prototype', result: kernelReport() }] } } }) });
  const value = await h.call({ module: 'Orders', job: h.job(jobOf(source)), authorize: WORDS });
  assert.equal(value.ok, true, JSON.stringify(value).slice(0, 600)); assert.equal(n, 2);
  assert.deepEqual(value.prototype.degraded.map(d => d.k), ['v:catalogo/0/0/2']);
});

// ---- rule 8: the CLI rehearsal
const REACTIVE = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..', '..', '..', 'kernel', 'tests', 'fixtures', 'reactive-ui.oml');
test('rule 8: ssam prototype --dry against a local base OML captures, applies headless, measures and prints the receipt; without --dry it answers the MCP call', async t => {
  const dir = tmp(t); const source = farmaFolder(dir);
  const root = path.join(dir, 'anvil'); fs.mkdirSync(root, { recursive: true });
  const dom = writeNativeDom(path.join(dir, 'dom'));
  const runAnvil = fakeAnvil({ apply: () => ({ ok: true, command: 'apply', data: { accepted: true, isValid: true, ops: 1, applyMs: 14000, results: [{ op: 'prototype', result: kernelReport({ nativeDom: dom }) }] } }) });
  const printed = await prototypeCli([source, '--lane', 'o11', '--module', 'Haiku_UI', '--base', REACTIVE, '--dry'],
    { jobDeps: { root, env: { ANVIL_WORKER: '0' }, runAnvil, worker: null, o11Lane: 'ss4', capturePrototype: fakeCapture(), measureFidelity: fakeMeasure(), prepareIntegrationJob: async () => ({ ok: true }) } });
  assert.equal(printed.ok, true, JSON.stringify(printed).slice(0, 400)); assert.equal(printed.dry, true); assert.equal(printed.module, 'Haiku_UI');
  assert.equal(printed.prototype.schema, RECEIPT_SCHEMA); assert.equal(printed.prototype.screens.length, 3); assert.equal(printed.prototype.fidelity.score, 1);
  assert.equal(typeof printed.prototype.timings.captureMs, 'number'); assert.equal(printed.prototype.timings.mergeMs, null, 'a rehearsal merges nothing');
  const argv = runAnvil.calls[0].args;
  assert.equal(argv[argv.indexOf('--base') + 1], REACTIVE); assert.equal(argv[0], 'apply');
  assert.equal(printed.next.tool, 'o11_deliver');
  const live = await prototypeCli([source, '--lane', 'odc', '--module', 'Haiku']);
  assert.equal(live.ok, false); assert.equal(live.continuation.tool, 'studio_deliver'); assert.deepEqual(live.continuation.arguments.owners, ['FarmaVirtual']);
  assert.equal((await prototypeCli([source, '--dry'])).code, 'INPUT_INVALID', '--dry needs --base');
});

test('rule 8: the CLI process of this checkout runs the same rehearsal (without the capture engine of the render lane it is an SSAM defect, never a crash)', { skip: fs.existsSync(path.join(path.dirname(REACTIVE), '..', '..', '..', 'platforms', 'odc', 'facade', 'prototype', 'capture.mjs')) && 'the render lane is merged: the live capture runs', timeout: 120000 }, async t => {
  const dir = tmp(t); const source = farmaFolder(dir);
  const { execFileSync } = await import('node:child_process');
  const cli = path.resolve(path.dirname(REACTIVE), '..', '..', '..', 'platforms', 'odc', 'facade', 'ssam.mjs');
  let stdout;
  try { stdout = execFileSync(process.execPath, [cli, 'prototype', source, '--lane', 'o11', '--module', 'Haiku_UI', '--base', REACTIVE, '--dry'], { encoding: 'utf8', env: { ...process.env, ANVIL_WORKER: '0' } }); }
  catch (error) { stdout = error.stdout; }
  const value = JSON.parse(stdout);
  assert.equal(value.ok, false); assert.equal(value.code, 'PROTOTYPE_IR_INVALID'); assert.equal(value.ssamDefect, true); assert.match(value.problems[0].message, /capture engine/);
});

test('the ready call of 1.1 for both lanes', () => {
  const o11 = prototypeCall({ lane: 'o11', source: 'C:\\p\\farmavirtual', module: 'Haiku_UI' });
  assert.deepEqual(o11, { tool: 'o11_deliver', arguments: { module: 'Haiku_UI', job: { ops: [{ op: 'prototype', data: { source: 'C:\\p\\farmavirtual' } }] }, publish: true, authorize: '<palavras do usuário>' } });
  const odc = prototypeCall({ lane: 'odc', source: 'C:\\p\\farmavirtual', module: 'Haiku', prefix: 'FarmaVirtual' });
  assert.deepEqual(odc.arguments.owners, ['FarmaVirtual']); assert.equal(odc.arguments.feature, 'Protótipo FarmaVirtual'); assert.equal(odc.arguments.until, undefined);
  assert.equal(prototypeCall({ lane: 'odc', rehearsal: true }).arguments.until, 'preview'); assert.equal(prototypeCall({ lane: 'o11', rehearsal: true }).arguments.until, 'apply');
  assert.deepEqual(strictPatch({ ops: [{ op: 'prototype', data: { source: 'a' } }] }, { ops: [{ op: 'prototype', data: { source: 'a', mapping: { default: 'x' } } }] }),
    [{ op: 'add', path: '/ops/0/data/mapping', value: { default: 'x' } }]);
});
