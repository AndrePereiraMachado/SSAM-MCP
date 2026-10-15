// The guards of the importer's refusals and of its degradation (docs/PROTOTIPO-NATIVO.md 1.4, 1.4.1), from the FolhaPonto
// session of 2026-10-12: a patch that leaves the call as it was is never offered (the mapping.names {label: label2} loop), and a
// Verify message on a property object of a generated widget reaches the capture k that built it, so the ONE rebuild happens.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prototypeRefusal, withoutIdentityPatches, identityPatchesOut, degradableItems, degradeCapture, findNode, buildWithDegradation } from '../prototype-op.mjs';

function tmp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-guard-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const job = { ops: [{ op: 'prototype', data: { source: 'C:\\p', mapping: { data: 'window.SCHEDULE', names: { label: 'label2' } } } }] };

test('a patch that changes nothing in the call is never offered: the problem comes back as an SSAM defect without it', () => {
  const same = { phase: 'apply', op: 0, pointer: '/ops/0/data/mapping/names/label', code: 'PROTOTYPE_NAME_COLLISION', message: 'label collides', patch: [{ op: 'add', path: '/ops/0/data/mapping/names/label', value: 'label2' }] };
  const real = { phase: 'apply', op: 0, pointer: '/ops/0/data/mapping/names/x', code: 'PROTOTYPE_NAME_COLLISION', message: 'x collides', patch: [{ op: 'add', path: '/ops/0/data/mapping/names/x', value: 'x2' }] };
  const { problems, dropped } = identityPatchesOut([same, real], job);
  assert.equal(dropped, 1);
  assert.equal(problems[0].patch, undefined); assert.equal(problems[0].ssamDefect, true); assert.equal(problems[0].unresolved, true);
  assert.match(problems[0].message, /changes nothing in this call/);
  assert.deepEqual(problems[1].patch, real.patch);
  // the kernel's refusal passed through (job-runner, o11-cycle): the identity patch out, the combined patch only of the rest
  const kernel = { ok: false, code: 'PROTOTYPE_NAME_COLLISION', problems: [same, real], patch: [...same.patch, ...real.patch] };
  const guarded = withoutIdentityPatches(kernel, job);
  assert.equal(guarded.ssamDefect, true);
  assert.deepEqual(guarded.patch, [{ op: 'add', path: '/ops/0/data/mapping', value: { data: 'window.SCHEDULE', names: { label: 'label2', x: 'x2' } } }]);
  assert.equal(guarded.correctedJob.ops[0].data.mapping.names.x, 'x2');
  const only = withoutIdentityPatches({ ok: false, problems: [same], patch: same.patch, correctedJob: job }, job);
  assert.equal(only.patch, undefined); assert.equal(only.correctedJob, undefined);
  // a refusal with nothing to drop is returned as it is
  const clean = { ok: false, problems: [real] };
  assert.equal(withoutIdentityPatches(clean, job), clean);
  // the facade's own refusal applies the same rule
  const refusal = prototypeRefusal([same, real], job);
  assert.equal(refusal.problems[0].patch, undefined); assert.equal(refusal.ssamDefect, true);
  assert.deepEqual(refusal.correctedJob.ops[0].data.mapping.names, { label: 'label2', x: 'x2' });
});

// A capture with a snapshot list whose template holds an svg (the status bar of FolhaPonto): k of the template node.
function capture(dir) {
  const ir = {
    schema: 'ssam-prototype-capture/1', source: { root: 'C:\\p', entry: 'a.html', files: [] },
    views: [{ key: 'v', name: 'V', root: { k: 'v:v', t: 'div', c: [{ k: 'v:v/0', t: 'span', a: [['class', 'bar']], list: { collection: null, mode: 'self', template: { k: 'v:v/0/*', t: 'svg', a: [['viewBox', '0 0 17 11']] }, snapshot: { entity: 'E', attributes: [], rows: [] } } }] } }],
    modals: [], events: [], trees: {},
  };
  const bundle = path.join(dir, 'bundle'); fs.mkdirSync(bundle, { recursive: true });
  const file = path.join(bundle, 'capture.json'); fs.writeFileSync(file, JSON.stringify(ir));
  // the widget keys the kernel wrote next to the bundle (prototype-keys.json): built widget key -> capture k
  fs.writeFileSync(path.join(bundle, 'prototype-keys.json'), JSON.stringify({ 'W1+key': 'v:v/0/*', 'W0+key': 'v:v/0' }));
  return { file, ir, document: { ops: [{ op: 'prototype', data: { source: 'C:\\p', capture: file, captureSha256: 'x' } }] } };
}

test('a Verify message on a property object of a generated widget reaches its capture k (k, widgetKey or prototype-keys.json), template nodes included', t => {
  const dir = tmp(t); const { document, ir } = capture(dir);
  assert.equal(findNode(ir, 'v:v/0/*').node.t, 'svg', 'a list template node is a node of the capture');
  const viaK = degradableItems([{ phase: 'verify', code: 'InvalidPropertyValue_Units', message: "'Value' must be set in Image", k: 'v:v/0/*', key: 'Prop+key' }], document);
  assert.deepEqual(viaK.map(i => [i.k, i.kind]), [['v:v/0/*', 'node']]);
  const viaWidget = degradableItems([{ phase: 'verify', code: 'InvalidHTMLAttribute_Replicated', message: 'viewBox twice', widgetKey: 'W1+key', key: 'Ext+key' }], document);
  assert.deepEqual(viaWidget.map(i => i.k), ['v:v/0/*']);
  const viaMap = degradableItems([{ phase: 'verify', code: 'X', message: 'm', key: 'W0+key' }], document);
  assert.deepEqual(viaMap.map(i => i.k), ['v:v/0']);
  assert.deepEqual(degradableItems([{ phase: 'verify', code: 'X', message: 'm', key: 'unknown' }], document), []);
  // the degradation reaches the template node: it becomes the literal of its tag
  const degraded = degradeCapture(ir, viaK);
  assert.equal(degraded.done.length, 1);
  assert.equal(findNode(degraded.ir, 'v:v/0/*').node.t, 'span');
});

test('the ONE rebuild happens for a Verify problem that names only a model key the kernel mapped', async t => {
  const dir = tmp(t); const { document } = capture(dir);
  const jobFile = path.join(dir, 'job.json'); fs.writeFileSync(jobFile, JSON.stringify(document));
  const attempts = [];
  const attempt = async file => {
    attempts.push(file);
    return attempts.length === 1 ? { ok: false, problems: [{ phase: 'verify', code: 'InvalidPropertyValue_Units', message: "'Value' must be set in Image", widgetKey: 'W1+key', key: 'Prop+key' }] } : { ok: true };
  };
  const b = await buildWithDegradation({ jobFile, attempt, inlineDir: path.join(dir, 'inline') });
  assert.equal(b.rebuilt, true); assert.equal(attempts.length, 2); assert.equal(b.refusal, undefined);
  assert.deepEqual(b.degraded.map(d => d.k), ['v:v/0/*']);
});

test('vendors: the integrity the page pins is checked on the cache and the download; a copy in the prototype folder serves offline', async t => {
  const { resolveVendors, storeInCache, integrityMatches } = await import('../prototype/vendor.mjs');
  const { createHash } = await import('node:crypto');
  const dir = tmp(t); const cache = path.join(dir, 'cache'); const source = path.join(dir, 'proto');
  fs.mkdirSync(path.join(source, 'vendor'), { recursive: true });
  const url = 'https://unpkg.com/react@18.3.1/umd/react.development.js';
  const good = Buffer.from('window.React = {};');
  const pin = 'sha384-' + createHash('sha384').update(good).digest('base64');
  assert.equal(integrityMatches(good, pin), true); assert.equal(integrityMatches(Buffer.from('x'), pin), false); assert.equal(integrityMatches(Buffer.from('x'), null), true);
  // a cache with other bytes than the pinned ones is never run; offline and without a copy it refuses
  storeInCache(cache, url, Buffer.from('window.React = "tampered";'));
  const refused = await resolveVendors([url], { cacheDir: cache, source, integrity: { [url]: pin } });
  assert.equal(refused.vendors.size, 0); assert.equal(refused.problems.length, 1);
  // the copy in <source>/vendor/<file name> (where the mapping.vendor patch points) serves when its bytes are the pinned ones
  fs.writeFileSync(path.join(source, 'vendor', 'react.development.js'), good);
  const served = await resolveVendors([url], { cacheDir: cache, source, integrity: { [url]: pin } });
  assert.equal(served.problems.length, 0); assert.equal(served.vendors.get(url).from, 'folder');
  // a download that does not match the pin is refused (and never cached)
  const wrong = await resolveVendors(['https://unpkg.com/x@1.0.0/x.js'], { cacheDir: cache, source, integrity: { 'https://unpkg.com/x@1.0.0/x.js': pin }, download: async () => Buffer.from('other') });
  assert.equal(wrong.vendors.size, 0); assert.match(wrong.problems[0].message, /do not match the integrity/);
});
