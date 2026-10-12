// Front U11 (FarmaVirtual session, 2026-10-10): the answers of an O11 delivery. Pure functions, fakes and temporary folders
// only: no Studio, no CLI, no worker.
// - The warnings that block nothing (A03, I9): the Studio quotes a data: URL whole in each InvalidResourceURL_Offline, so
//   the MCP result of call 99 was 77 k characters (the answer twice), ~40 k of them 20 warnings (of 34) that differed only
//   in the URL; the client cut 15 k from its middle. A data: URL or a base64 run (never a slash path) is cut to its head
//   with its original size, and equal warnings (the same id on the same element: its ownerKey, else its path) come once
//   with count.
// - The job of a delivery (G16): "entregue" names nextBasedOn, but that job is in the module now; a basedOn naming it is
//   refused once, before anything runs (BASED_ON_DELIVERED).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Cycle } from '../o11-cycle.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
// A namespace: at the base (before this front) each test fails on its own rule, not at import.
import * as dw from '../delivery-warnings.mjs';

// Three of the 34 nonblocking verdicts of call 105, as the kernel apply wrote them (replay of the real job over the real
// capture, `anvil apply`): ImageTooBig and two InvalidResourceURL_Offline of the theme stylesheet.
const SVG1 = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22'
  + '%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.7%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%2212%22'
  + '%20cy%3D%2212%22%20r%3D%2210%22%2F%3E%3Cpath%20d%3D%22M12%2016v-4%22%2F%3E%3Cpath%20d%3D%22M12%208h.01%22%2F%3E%3C%2Fsvg%3E';
const SVG2 = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2224%22%20height%3D%2224%22%20viewBox%3D%220%200%2024%2024%22'
  + '%20fill%3D%22none%22%20stroke%3D%22black%22%20stroke-width%3D%221.7%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%3E%3Ccircle%20cx%3D%2212%22'
  + '%20cy%3D%2212%22%20r%3D%2210%22%2F%3E%3Cpath%20d%3D%22M12%206v6h4%22%2F%3E%3C%2Fsvg%3E';
const THEME = 'Haiku_UI (ESpace) / Haiku_UI (MobileTheme) / WebStyleSheet';
// The key is the kernel's JSON text of the message identity, with `+` escaped as \u002B.
const OFFLINE = url => ({ id: 'InvalidResourceURL_Offline', type: 'Warning', path: THEME,
  key: '["InvalidResourceURL_Offline","EHWy15q2lEymE4eJ_Th8yQ.#StyleSheet",["CssSource"],["' + url.replace('+', '\\u002B') + '"]]', ownerKey: 'EHWy15q2lEymE4eJ_Th8yQ.#StyleSheet',
  detail: "Offline Behavior | The url '" + url + "' will not be cached for offline usage. Consider adding this resource to the module and use it in the stylesheet instead.",
  verdict: 'nonblocking', reason: 'warning-non-blocking' });
const IMAGE = { id: 'ImageTooBig', type: 'Warning', path: 'Haiku_UI (ESpace) / FarmaProducts (Image)', key: '["ImageTooBig","FIO0OMNlQEa4X3vE_vriJA",[],["FarmaProducts","500 KB"]]',
  ownerKey: 'FIO0OMNlQEa4X3vE_vriJA', detail: "Performance Warning | Image 'FarmaProducts' is bigger than 500 KB. To avoid performance issues, reduce the image size in bytes.",
  verdict: 'nonblocking', reason: 'warning-non-blocking' };
// The 34 of call 105: ImageTooBig, then 33 InvalidResourceURL_Offline on the same stylesheet (each its own icon).
const VERDICTS_105 = [IMAGE, ...Array.from({ length: 33 }, (_, i) => OFFLINE(i % 2 ? SVG2 : SVG1))];

test('a data: URL in a warning is cut to its head with its original size, so the sentence after it is read', () => {
  assert.equal(SVG1.length, 435);
  assert.match(OFFLINE(SVG1).key, /\["data:image\/svg\\u002Bxml,%3Csvg/, 'the key holds the URL as the kernel escaped it');
  const [w] = dw.warningsFromVerdicts([OFFLINE(SVG1)], { hints: {} });
  assert.equal(w.detail, "Offline Behavior | The url 'data:image/svg+xml,…(435 chars)' will not be cached for offline usage. Consider adding this resource to the module and use it in the stylesheet instead.");
  // The key keeps its identity (id, owner, property) and the URL's size, counted in characters of the URL (\u002B is one).
  assert.equal(w.key, '["InvalidResourceURL_Offline","EHWy15q2lEymE4eJ_Th8yQ.#StyleSheet",["CssSource"],["data:image/svg\\u002Bxml,…(435 chars)"]]');
  assert.equal(w.path, THEME);
  // The detail as the 22nd kernel wrote it in "entregue" (cut at 200 inside the URL): the size is not known, none is said.
  const live = "Offline Behavior | The url '" + SVG1.slice(0, 171) + '…';
  assert.equal(dw.warningOf({ id: 'InvalidResourceURL_Offline', path: THEME, detail: live, fix: null }).detail, "Offline Behavior | The url 'data:image/svg+xml,…");
  // Before: 870 characters, the key carried the whole URL (526) and the detail ended inside it at 200 characters.
  assert.ok(JSON.stringify(w).length < 450, JSON.stringify(w));
});

test('a base64 run is cut with its size; short data: URLs, words and plain long text are left to the line limit', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg' + 'Ab12'.repeat(40);
  assert.equal(dw.shortText('image ' + png + ' too big'), 'image iVBORw0KGgoA…(' + png.length + ' chars) too big');
  assert.equal(dw.shortText('data:image/png;base64,' + png), 'data:image/png;base64,…(' + (22 + png.length) + ' chars)');
  assert.equal(dw.shortText("url('data:,x') stays"), "url('data:,x') stays");
  assert.equal(dw.shortText('y'.repeat(500)), 'y'.repeat(500), 'one letter repeated is not base64');
  // A slash path has the alphabet, mixed case and digits too, but never a "+" or the "=" padding: it stays whole. Base64 with
  // a "/" has one of them (here the padding) and is cut.
  const resource = 'Theme/Resources/Images/Icons2024/Navigation/ArrowLeftCircle/Variants/Outline24/DarkMode/Final3/Large';
  assert.equal(dw.shortText('The resource ' + resource + ' is unused'), 'The resource ' + resource + ' is unused');
  assert.equal(dw.warningOf({ id: 'UnusedResource', path: 'M / ' + resource, detail: 'unused' }).path, 'M / ' + resource);
  const gif = 'R0lGODlhAQABAIAAAP/AAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw/Zm9vYmFyMTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFla==';
  assert.equal(dw.shortText('Icon ' + gif + ' is big'), 'Icon R0lGODlhAQAB…(' + gif.length + ' chars) is big');
  assert.equal(dw.warningOf({ id: 'X', detail: 'y'.repeat(500) }).detail.length, 200, 'the line limit of the detail is unchanged');
  // A long key that holds no URL is cut at 300 characters with its size.
  const key = dw.warningOf({ id: 'X', key: '["X","k",["Value"],["' + 'a b '.repeat(200) + '"]]', detail: 'd' }).key;
  assert.equal(key.length, 300); assert.match(key, /…\(824 chars\)$/);
});

test('equal warnings (same id, same element) come once with count: call 105 is 2 entries, not 20 plus warningsTotal 34', () => {
  const fields = dw.warningFields(dw.warningsFromVerdicts(VERDICTS_105, { hints: {} }));
  assert.deepEqual(fields.warnings.map(w => [w.id, w.count ?? 1]), [['ImageTooBig', 1], ['InvalidResourceURL_Offline', 33]]);
  assert.equal(fields.warningsTotal, undefined, 'every warning is counted in the list');
  assert.equal(fields.warnings[0].count, undefined, 'a single warning has no count');
  assert.equal(fields.warnings[1].detail, "Offline Behavior | The url 'data:image/svg+xml,…(435 chars)' will not be cached for offline usage. Consider adding this resource to the module and use it in the stylesheet instead.");
  assert.ok(JSON.stringify(fields).length < 1000, JSON.stringify(fields).length + ' characters');
  // More distinct elements than the answer holds: the first 20 entries and the total of warnings.
  const many = Array.from({ length: 25 }, (_, i) => ({ id: 'UnusedElement', path: 'M / E' + i + ' (Structure)', detail: 'never used', fix: null }));
  const capped = dw.warningFields([...many, ...many.slice(0, 5)]);
  assert.equal(capped.warnings.length, 20); assert.equal(capped.warningsTotal, 30);
  assert.deepEqual(capped.warnings.slice(0, 5).map(w => w.count), [2, 2, 2, 2, 2]);
  // The element is its key (the verdict's ownerKey), and only without one its path: two elements whose paths read the same
  // are two entries, from the verdicts of a refusal and from the kernel task's own warnings (whose key is the ownerKey).
  const twin = (ownerKey, url) => ({ ...OFFLINE(url), ownerKey });
  assert.deepEqual(dw.warningFields(dw.warningsFromVerdicts([twin('k1', SVG1), twin('k2', SVG1), twin('k1', SVG2)], { hints: {} })).warnings.map(w => w.count ?? 1), [2, 1]);
  const unused = key => ({ id: 'UnusedWidget', path: 'M / S (MobileScreen) / Container (Container)', key, detail: 'unused container', fix: null });
  assert.deepEqual(dw.warningFields(dw.taskWarnings({ warnings: [unused('k1'), unused('k2'), unused('k1')] }, { hints: {} })).warnings.map(w => [w.key, w.count ?? 1]),
    [['k1', 2], ['k2', 1]]);
  assert.equal(dw.warningFields(dw.taskWarnings({ warnings: [unused(undefined), unused(undefined)] }, { hints: {} })).warnings[0].count, 2, 'no key: the path');
  assert.ok(!JSON.stringify(dw.warningFields(dw.warningsFromVerdicts([twin('k1', SVG1)], { hints: {} }))).includes('ownerKey'), 'the ownerKey is never in the answer');
  // Without a path the key names the element; HIGH warnings are never merged (each names its own op).
  assert.equal(dw.warningFields([{ id: 'A', path: '', key: 'k1', detail: 'x' }, { id: 'A', path: '', key: 'k2', detail: 'x' }]).warnings.length, 2);
  const high = { id: 'QUERY_IN_LOOP', severity: 'high', path: 'F / Loop', detail: 'd', fix: null, op: 1 };
  assert.equal(dw.warningFields([high, { ...high, op: 2 }]).warnings.length, 2);
});

// ---- o11_deliver after "entregue" (G16): every answer names nextBasedOn (the contract of the 23rd, patch-por-nome), "entregue"
// too, but a delivered job is in the module: a patch or a partial job over it is that whole job again over the merged
// module. Call 105 delivered 331 ops (the FarmaVirtual screen, its variables and 62 actions); a correction over its
// nextBasedOn would have applied all of them again. Refused once, before anything runs, with the new-job continuation.
const sha256 = data => createHash('sha256').update(data).digest('hex');
const WORDS = 'sim, pode entregar no Orders';
const DELIVERED = { ok: true, command: 'deliver', data: { delivered: true, taskId: 'c0ffee00c0ffee00c0ffee00c0ffee00', writeState: 'applied', validation: { newErrors: 0 } } };
const REFUSED = { ok: false, command: 'deliver', code: 'PREFLIGHT_REFUSED', error: 'op #1 (logic) [EXPR_UNKNOWN_IDENTIFIER]: x', verifyRan: true,
  problems: [{ phase: 'preflight', op: 1, pointer: '/ops/1/data/actions/0/steps/0/assign/X', code: 'EXPR_UNKNOWN_IDENTIFIER', severity: 'error', message: "can't identify 'Y'", fix: 'write 1' }] };
// A job as the session wrote it, in small: the screen, a variable and an action.
const PAGE_JOB = { ops: [{ op: 'html', data: { screen: 'FarmaVirtual', html: '<div class="fv">Farma</div>', vars: [{ name: 'Busca', type: 'Text' }] } },
  { op: 'logic', data: { actions: [{ name: 'FvSave', kind: 'screen', owner: 'FarmaVirtual', steps: [{ assign: { X: 'Y' }, as: 'Init' }] }] } }] };

function o11Box(t, replies) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'entrega-respostas-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority');
  for (const dir of [root, home, auth]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242, port: 45997,
    studioDir: path.join(base, 'Studio'), authorityDir: auth }));
  const env = { USERPROFILE: home, HOME: home, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  const job = path.join(base, 'jobs', 'farmavirtual.json');
  fs.mkdirSync(path.dirname(job), { recursive: true }); fs.writeFileSync(job, JSON.stringify(PAGE_JOB, null, 2));
  const runAnvil = fakeAnvil({ deliver: () => replies.shift() });
  const selected = [];
  let clock = Date.parse('2026-10-10T20:48:07.000Z');
  const deps = { root, env, lane: 'ss4', now: () => new Date(clock += 1000), runAnvil, lastPublication: async () => null, assertSelected: async () => { selected.push(true); },
    grantsFile: path.join(base, 'grants.json') };
  return { base, root, job, sha: sha256(fs.readFileSync(job)), work: path.join(root, '.local', 'work'), runAnvil, selected, deps };
}
async function o11Serve(t, deps) {
  const server = new McpServer({ name: 'entrega-respostas', version: '1.0.0' });
  registerO11Cycle(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'entrega-respostas-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return args => client.callTool({ name: 'o11_deliver', arguments: { authorize: WORDS, ...args } }).then(r => r.structuredContent ?? JSON.parse(r.content[0].text));
}

test('G16: a delivered job is never the base of a patch or a partial job: BASED_ON_DELIVERED once, before anything runs', async t => {
  const box = o11Box(t, [DELIVERED, DELIVERED]);
  const call = await o11Serve(t, box.deps);
  const done = await call({ module: 'Haiku_UI', job: box.job });
  assert.equal(done.result, 'entregue', JSON.stringify(done));
  assert.deepEqual(done.nextBasedOn, { job: box.job, sha256: box.sha }, 'the 23rd contract: "entregue" names the job it used');
  const ran = box.runAnvil.calls.length; const selected = box.selected.length;
  // The correction the 23rd invited: a patch over nextBasedOn, a partial job over it, a validation of either.
  for (const args of [{ patch: [{ op: 'replace', path: '/ops/0/data/html', value: '<div class="fv">Farma 2</div>' }] },
    { job: [{ op: 'logic', data: { actions: [{ name: 'FvSave', kind: 'screen', owner: 'FarmaVirtual', steps: [] }] } }] },
    { patch: [{ op: 'remove', path: '/ops/1' }], until: 'apply' }]) {
    const refused = await call({ module: 'Haiku_UI', basedOn: done.nextBasedOn, ...args });
    assert.equal(refused.code, 'BASED_ON_DELIVERED', JSON.stringify(refused));
    assert.deepEqual(refused.delivered, { job: box.job, sha256: box.sha, module: 'Haiku_UI', at: refused.delivered.at, taskId: 'c0ffee00c0ffee00c0ffee00c0ffee00' });
    assert.equal(refused.continuation.tool, 'o11_deliver');
    assert.equal(refused.continuation.arguments.module, 'Haiku_UI');
    assert.equal(refused.continuation.arguments.basedOn, undefined, 'a new job, never over the delivered one');
    assert.equal(refused.continuation.arguments.patch, undefined);
    assert.equal(refused.nextBasedOn, undefined, 'the refusal never names the delivered job as the next base');
  }
  // The new job keeps the other arguments of the call (as BASE_CHANGED and closeAndDeliver do): its producer bindings, checks,
  // environment and publication.
  const bound = { checks: ['FarmaVirtual'], producers: { Theme: 'published' }, captureProducers: ['System=(System)'], expectedEnvironment: 'dev.example.com', publish: true };
  const kept = await call({ module: 'Haiku_UI', basedOn: done.nextBasedOn, patch: [{ op: 'remove', path: '/ops/1' }], ...bound });
  assert.equal(kept.code, 'BASED_ON_DELIVERED', JSON.stringify(kept));
  assert.deepEqual(kept.continuation.arguments, { module: 'Haiku_UI', job: '<a new job: only the change, over the module as it is now>', ...bound, authorize: '<palavras do usuário>' });
  assert.equal(box.runAnvil.calls.length, ran, 'nothing ran'); assert.equal(box.selected.length, selected, 'the Studio was not touched');
  // The same module named as the person sees it (letters and digits) is the same module; another module takes the patch.
  assert.equal((await call({ module: 'Haiku UI', basedOn: done.nextBasedOn, patch: [{ op: 'remove', path: '/ops/1' }] })).code, 'BASED_ON_DELIVERED');
  const other = await call({ module: 'Billing', basedOn: done.nextBasedOn, patch: [{ op: 'remove', path: '/ops/1' }] });
  assert.equal(other.result, 'entregue', JSON.stringify(other)); assert.equal(box.runAnvil.calls.length, ran + 1);
});

test('G16: the job a delivered job was corrected from is refused too; a refused job stays the base of its correction', async t => {
  const box = o11Box(t, [REFUSED, DELIVERED]);
  const call = await o11Serve(t, box.deps);
  const refused = await call({ module: 'Haiku_UI', job: box.job });
  assert.equal(refused.code, 'PREFLIGHT_REFUSED');
  const fixed = await call({ module: 'Haiku_UI', basedOn: refused.nextBasedOn, patch: [{ op: 'replace', path: '/ops/1/data/actions/0/steps/0/assign/X', value: '1' }] });
  assert.equal(fixed.result, 'entregue', JSON.stringify(fixed));
  assert.notEqual(fixed.nextBasedOn.job, box.job, 'the correction is a new job file');
  for (const basedOn of [fixed.nextBasedOn, refused.nextBasedOn]) {
    const again = await call({ module: 'Haiku_UI', basedOn, patch: [{ op: 'remove', path: '/ops/1' }] });
    assert.equal(again.code, 'BASED_ON_DELIVERED', JSON.stringify(again));
    assert.deepEqual([again.delivered.job, again.delivered.sha256], [fixed.nextBasedOn.job, fixed.nextBasedOn.sha256], 'names the job that was delivered');
    assert.match(again.error, basedOn === fixed.nextBasedOn ? /^The job of basedOn is already in Haiku_UI/ : /^The job of basedOn was corrected into the job delivered to Haiku_UI/);
  }
  assert.equal(box.runAnvil.calls.length, 2);
});

// The session corrected one job twelve times before it was delivered (calls.json of 2026-10-10, o11_deliver): the job of
// call 79 (287 ops), then a patch over the nextBasedOn of each refusal, 82, 88, 89, 90, 91, 92, 93, 94, 95, 96 and 99
// (PREFLIGHT_REFUSED, then VALIDATION_REFUSED), and call 105 delivered the 13th version. Each of the 13 is in the module.
const ASSIGN = value => [{ op: 'replace', path: '/ops/1/data/actions/0/steps/0/assign/X', value }];
test('G16: every version of a corrected job is refused after its delivery, the 13 of the session from the first', async t => {
  const box = o11Box(t, [...Array.from({ length: 12 }, () => REFUSED), DELIVERED]);
  const call = await o11Serve(t, box.deps);
  let answer = await call({ module: 'Haiku_UI', job: box.job });
  const versions = [answer.nextBasedOn];
  for (let i = 1; i < 13; i++) {
    assert.equal(answer.code, 'PREFLIGHT_REFUSED', JSON.stringify(answer));
    answer = await call({ module: 'Haiku_UI', basedOn: answer.nextBasedOn, patch: ASSIGN(String(i)) });
    versions.push(answer.nextBasedOn);
  }
  assert.equal(answer.result, 'entregue', JSON.stringify(answer));
  assert.equal(new Set(versions.map(v => v.sha256)).size, 13, 'thirteen versions, each its own job');
  const delivered = versions[12]; const ran = box.runAnvil.calls.length;
  assert.equal(ran, 13);
  for (const [i, basedOn] of versions.entries()) {
    const again = await call({ module: 'Haiku_UI', basedOn, patch: [{ op: 'remove', path: '/ops/1' }] });
    assert.equal(again.code, 'BASED_ON_DELIVERED', 'version ' + (i + 1) + ' of 13: ' + JSON.stringify(again));
    assert.deepEqual([again.delivered.job, again.delivered.sha256], [delivered.job, delivered.sha256], 'names the delivered version');
  }
  // The refused task of the first version, named by its taskId, is refused the same way.
  const id = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
  const dir = path.join(box.work, 'deliver', id); fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ taskId: id, module: 'Haiku_UI', work: dir, delivered: false, writeState: 'not-sent', error: 'PREFLIGHT_REFUSED',
    updatedAt: '2026-10-10T20:40:00.000Z', request: { JobPath: versions[0].job } });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
  const byTask = await call({ basedOn: { taskId: id }, patch: [{ op: 'remove', path: '/ops/1' }] });
  assert.equal(byTask.code, 'BASED_ON_DELIVERED', JSON.stringify(byTask));
  assert.equal(byTask.delivered.sha256, delivered.sha256);
  assert.equal(box.runAnvil.calls.length, ran, 'nothing ran');
});

test('G16: a version refused before its delivery started is still a version of the delivered job', async t => {
  // A correction refused before the delivery task starts (here the Studio not selected) has no start line in the
  // o11_deliver journal, but its answer names it as nextBasedOn; the line job <- basedOn of job-patch.jsonl keeps the chain.
  const box = o11Box(t, [REFUSED, DELIVERED]);
  let studio = true;
  box.deps.assertSelected = async () => { if (!studio) throw new Error('The selected Service Studio is not confirmed.'); };
  const call = await o11Serve(t, box.deps);
  const first = (await call({ module: 'Haiku_UI', job: box.job })).nextBasedOn;
  studio = false;
  const unselected = await call({ module: 'Haiku_UI', basedOn: first, patch: ASSIGN('1') });
  assert.equal(unselected.code, 'STUDIO_NOT_SELECTED', JSON.stringify(unselected));
  studio = true;
  const done = await call({ module: 'Haiku_UI', basedOn: unselected.nextBasedOn, patch: ASSIGN('2') });
  assert.equal(done.result, 'entregue', JSON.stringify(done));
  for (const basedOn of [first, unselected.nextBasedOn]) {
    const again = await call({ module: 'Haiku_UI', basedOn, patch: ASSIGN('3') });
    assert.equal(again.code, 'BASED_ON_DELIVERED', JSON.stringify(again));
  }
  assert.equal(box.runAnvil.calls.length, 2);
});

test('G16: basedOn {taskId} of a delivered task is refused the same way, for its own module only', async t => {
  const box = o11Box(t, [DELIVERED]);
  const id = 'd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0';
  const dir = path.join(box.work, 'deliver', id); fs.mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify({ taskId: id, module: 'Haiku_UI', work: dir, delivered: true, writeState: 'applied', updatedAt: '2026-10-10T20:48:07.000Z',
    request: { JobPath: box.job } });
  fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
  const call = await o11Serve(t, box.deps);
  const refused = await call({ basedOn: { taskId: id }, patch: [{ op: 'remove', path: '/ops/1' }] });
  assert.equal(refused.code, 'BASED_ON_DELIVERED', JSON.stringify(refused));
  assert.deepEqual(refused.delivered, { job: box.job, module: 'Haiku_UI', at: '2026-10-10T20:48:07.000Z', taskId: id });
  assert.equal(refused.continuation.arguments.module, 'Haiku_UI');
  assert.equal((await call({ module: 'Haiku UI', basedOn: { taskId: id }, patch: [{ op: 'remove', path: '/ops/1' }] })).code, 'BASED_ON_DELIVERED');
  assert.equal(box.runAnvil.calls.length, 0);
  // Another module takes the patch, as with basedOn {job, sha256}.
  const other = await call({ module: 'Billing', basedOn: { taskId: id, sha256: box.sha }, patch: [{ op: 'remove', path: '/ops/1' }] });
  assert.equal(other.result, 'entregue', JSON.stringify(other)); assert.equal(box.runAnvil.calls.length, 1);
});
