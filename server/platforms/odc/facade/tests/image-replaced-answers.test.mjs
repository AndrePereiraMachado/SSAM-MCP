// Review of W3-CSS (correction 2, S2): what the kernel says in its receipt's highWarnings reaches the answer of both lanes.
// - IMAGE_CONTENT_REPLACED (an image file of the write filled the module image of its name): a HIGH warning of the o11_deliver
//   answer (and so of ssam_code write) and of studio_deliver, with the code and the image's name;
// - CSS_TARGET_UNSERVED of a theme the job creates (medium): a warning of the answer with its severity, never a HIGH one.
// Fake Anvil CLI and temporary folders only; synthetic names.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with { type: 'json' };
import { sandbox, serve } from './fixtures/served-proof-fixtures.mjs';
import { compactDelivery } from '../responses.mjs';
import { interpretKernelResult, requiredFlowLayoutEngine } from '../kernel-delivery.mjs';
import { HIGH } from '../delivery-warnings.mjs';

const WORDS = 'yes, deliver the images of the sales portal';
const KERNEL_WARNINGS = [
  { code: 'IMAGE_CONTENT_REPLACED', severity: 'high', op: 0, path: 'Image:proof_logo', image: 'proof_logo', bytes: 68, previousBytes: 42,
    message: 'the module image proof_logo already existed and took the content of proof-logo.png (68 bytes, it had 42): every screen that shows it shows the new image',
    fix: 'to keep the image the module had, give the file another name (it becomes a new module image) and deliver again' },
  { code: 'CSS_TARGET_UNSERVED', severity: 'medium', op: 1, message: 'set StyleSheet on the theme ProofTheme: no page of this module shows this theme (the theme is new in this job: not refused)',
    fix: 'give the theme to the flow that should show it (set IMobileFlow:<flow> Theme ProofTheme), or make it the BaseTheme of a theme a flow shows' },
];

test('o11_deliver: the image replacement is a HIGH warning of the answer, with its code and image; a medium warning stays medium', async t => {
  const box = sandbox(t);
  const data = structuredClone(envelopes.delivered.data);
  data.apply.highWarnings = KERNEL_WARNINGS;
  const runAnvil = fakeAnvil({ deliver: () => ({ ...envelopes.delivered, data }) });
  const deps = { root: box.root, env: box.env, lane: 'ss4', now: box.now, runAnvil, assertSelected: async () => {}, grantsFile: path.join(box.base, 'grants.json'),
    lastPublication: async () => null, readerCheck: null };
  const value = await (await serve(t, deps))({ module: 'SalesPortal', job: box.job('img.json', { ops: [{ op: 'create', parent: '@espace', type: 'IImage', name: 'proof_logo',
    args: { binary: 'iVBORw0KGgo=', originalPath: 'proof-logo.png' } }] }), authorize: WORDS });
  assert.equal(value.ok, true, JSON.stringify(value));
  const replaced = (value.highWarnings ?? []).find(w => w.id === 'IMAGE_CONTENT_REPLACED');
  assert.ok(replaced, JSON.stringify(value));
  assert.equal(replaced.severity, HIGH); assert.equal(replaced.path, 'Image:proof_logo'); assert.match(replaced.detail, /proof_logo/);
  assert.ok(!(value.highWarnings ?? []).some(w => w.id === 'CSS_TARGET_UNSERVED'), 'a medium warning is never HIGH');
  const unserved = (value.warnings ?? []).find(w => w.id === 'CSS_TARGET_UNSERVED');
  assert.ok(unserved, JSON.stringify(value)); assert.equal(unserved.severity, 'medium'); assert.equal(unserved.op, 1);
});

test('studio_deliver: the ODC kernel result carries the image replacement into the answer\'s HIGH warnings', () => {
  const read = interpretKernelResult({ ok: true, data: { accepted: true, isValid: true, flowLayoutEngine: requiredFlowLayoutEngine, highWarnings: KERNEL_WARNINGS } }, { output: 'o' });
  const replaced = read.warnings.find(w => w.id === 'IMAGE_CONTENT_REPLACED');
  assert.equal(replaced.severity, HIGH); assert.match(replaced.detail, /proof_logo/);
  assert.equal(read.warnings.find(w => w.id === 'CSS_TARGET_UNSERVED').severity, 'medium');
  // The delivery's report keeps the HIGH ones on their own field (kernel-delivery.mjs report.highWarnings), as the answer shows them.
  const highWarnings = read.warnings.filter(w => w.severity === HIGH);
  const answer = compactDelivery('studio_deliver', {}, { ok: true, merged: true, strictlyEqual: true, manifest: 'm.json', steps: [1], highWarnings, warnings: read.warnings });
  assert.deepEqual(answer.highWarnings.map(w => w.id), ['IMAGE_CONTENT_REPLACED']);
  assert.ok(answer.warnings.some(w => w.id === 'CSS_TARGET_UNSERVED' && w.severity === 'medium'));
});
