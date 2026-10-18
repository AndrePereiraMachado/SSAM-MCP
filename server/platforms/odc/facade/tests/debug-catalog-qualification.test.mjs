// Port review B2: the ops.debugger catalog limits (what ssam_discover announces per lane) are generated from
// debug-adapter-registry, so the catalog follows D7 and the evidence index. Offline; writes only temp copies.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, CAPABILITIES, SEED_EVIDENCE, describeQualification } from '../debug-adapter-registry.mjs';
import { pendingForeign } from '../debug-foreign-pending.mjs';
import { CATALOG_FRAGMENT, CATALOG_QUALIFICATION_TAIL, catalogQualification, catalogQualificationDrift, syncCatalogQualification } from '../debug-catalog-qualification.mjs';

const REGENERATE = 'node platforms/odc/facade/debug-catalog-qualification.mjs --write';
const sentences = text => text.split(/(?<=\.) /);

test('ops.debugger platform limits in the catalog are the generated registry text (drift)', () => {
  const drift = catalogQualificationDrift();
  assert.deepEqual(drift.map(d => d.lane), ['odc', 'o11']);
  for (const d of drift) assert.equal(d.current, d.expected, d.lane + ': the catalog text drifted from debug-adapter-registry; run ' + REGENERATE);
});

test('the generated text is server + client qualification + the fixed tail, and pending rows move when their file arrives', () => {
  // A delivery of every SC/Portal file, simulated: the same rows without dependsOn.
  const delivered = ADAPTERS.map(({ dependsOn: _d, ...row }) => row), deliveredCapabilities = CAPABILITIES.map(({ dependsOn: _d, ...c }) => c);
  for (const lane of ['odc', 'o11']) {
    const now = catalogQualification(lane);
    assert.equal(now, describeQualification(lane, 'server') + ' ' + describeQualification(lane, 'client') + ' ' + CATALOG_QUALIFICATION_TAIL);
    const after = catalogQualification(lane, SEED_EVIDENCE, delivered, deliveredCapabilities);
    assert.doesNotMatch(after, /Unavailable in this build/);
    const waiting = [...ADAPTERS, ...CAPABILITIES].filter(r => r.lane === lane && r.interactive === true && pendingForeign(r.dependsOn).length);
    if (!waiting.length) { assert.equal(now, after, lane + ': nothing pending, nothing changes'); continue; }
    const unavailable = sentences(now).find(s => s.startsWith('Unavailable in this build')) ?? '';
    for (const r of waiting.filter(r => r.adapter)) {
      assert.ok(unavailable.includes(r.label + ' (pending: '), lane + ' ' + r.label + ' must be announced as unavailable');
      assert.ok(!sentences(now).some(s => s !== unavailable && s.includes(r.label)), lane + ' ' + r.label + ' announced as runnable while pending');
      assert.ok(sentences(after).some(s => /^(Live-qualified|Implemented)/.test(s) && s.includes(r.label)), lane + ' ' + r.label + ' after delivery');
    }
    for (const c of waiting.filter(c => c.capability)) assert.ok(now.includes('Capability ' + c.label + ': unavailable in this build'), lane + ' ' + c.label);
    // The drift test then fails until the catalog is regenerated.
    assert.notEqual(now, after);
  }
  assert.throws(() => catalogQualification('odc4'), /lane_invalid/);
});

test('--write rewrites only the two generated texts in place, refuses a missing one and is idempotent', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-catalog-qualification-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = fs.readFileSync(CATALOG_FRAGMENT, 'utf8'), [odc, o11] = catalogQualificationDrift(original);
  assert.ok(odc.current && o11.current);
  // Stale hand copies, like the ones the review found (a pending Timer wake announced as implemented).
  const stale = { odc: odc.current.replace('Unavailable in this build', 'Implemented') + ' Stale.', o11: o11.current.replace('Live-qualified', 'Qualified') };
  const file = path.join(dir, 'operations.json');
  const staleText = original.replace(JSON.stringify(odc.current), () => JSON.stringify(stale.odc)).replace(JSON.stringify(o11.current), () => JSON.stringify(stale.o11));
  fs.writeFileSync(file, staleText);
  const check = syncCatalogQualification({ file });
  assert.equal(check.ok, false); assert.equal(check.written, false); assert.deepEqual(check.drift.map(d => d.lane), ['odc', 'o11']);
  assert.equal(fs.readFileSync(file, 'utf8'), staleText, '--check writes nothing');
  const written = syncCatalogQualification({ file, write: true });
  assert.equal(written.ok, true); assert.equal(written.written, true);
  const expected = staleText.replace(JSON.stringify(stale.odc), () => JSON.stringify(odc.expected)).replace(JSON.stringify(stale.o11), () => JSON.stringify(o11.expected));
  assert.equal(fs.readFileSync(file, 'utf8'), expected, 'every other byte of the fragment is kept');
  assert.deepEqual(syncCatalogQualification({ file, write: true }), { ok: true, written: false, drift: [] });
  // Without a generated limit to replace, nothing is guessed.
  fs.writeFileSync(file, staleText.replace(JSON.stringify(stale.odc), () => JSON.stringify('ODC limits written by hand.')));
  assert.throws(() => syncCatalogQualification({ file, write: true }), /not_rewritable:odc/);
});

test('the CLI checks the real fragment read-only', () => {
  const script = fileURLToPath(new URL('../debug-catalog-qualification.mjs', import.meta.url));
  const before = fs.readFileSync(CATALOG_FRAGMENT, 'utf8');
  const run = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(run.status, catalogQualificationDrift().every(d => d.ok) ? 0 : 1, run.stderr);
  assert.equal(fs.readFileSync(CATALOG_FRAGMENT, 'utf8'), before);
});
