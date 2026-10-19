import './fixtures/isolated-profile.mjs';
// marco-a6 review B1 and the patchedJob decision (C:\t\revisoes\marco-a6\REVISAO.md; the Integradora, 19/10), the path family
// of the licensee rule (exposure.mjs):
// - a handle is ANY path under a handle root, in ANY key: SSAM answers its handles in many keys (studio_snapshot path, a
//   delivery's snapshot and report.snapshot.path, manifest, receipt, evidence, checks, xif, zip, folder...), and the next call
//   takes them back (on a hosted server the gate shows each one as ws:<rel>). Before, only a list of handle keys kept a handle,
//   and every other became <server>: the licensee lost its capture between two calls (the hosted e2e, studio_snapshot path).
//   The rest of the family stays: the root itself, a folder outside the roots, a customers or temp folder, a list of roots
//   only (left out), a path the caller did not send;
// - patchedJob (X3) leaves a licensee's answer whole: its path and hash are those of nextBasedOn (the same corrected job,
//   appliedJobIdentity + nextBasedOnOf: kernel-delivery.mjs, job-runner.mjs, o11-cycle.mjs, ssam.mjs), its source is the
//   server's provenance sidecar ({jobSha256, sourceDirectory}) that no tool takes back, and when the server could not verify
//   the corrected file nextBasedOn names the job that ran, never the unverified one. The owner reads it whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { exposedResult } from '../exposure.mjs';

const ROOT = 'C:\\srv\\ssam\\kernel\\.local';
const roots = [ROOT];
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const licensee = (tool, value, args = {}) => exposedResult(result(value), { exposure: 'licensee', handleRoots: roots, tool, args }).structuredContent;
const owner = (tool, value) => exposedResult(result(value), { exposure: 'owner', tool }).structuredContent;
const at = (...parts) => path.win32.join(ROOT, ...parts);

test('a handle in any key is served as it is; the root, a folder outside the roots and a list of roots are not', () => {
  const capture = at('captures', 'Orders-abc.oml');
  const answer = { ok: true, path: capture, snapshot: capture, report: { snapshot: { path: capture } },
    manifest: at('lab', 'd1', 'manifest.json'), receipt: at('journal', 'r.json'), evidence: at('lab', 'd1', 'evidence.json'),
    checks: [at('answers', 'a.json'), 'module index current'], mine: at('jobs', 'z.json'), xif: at('xif', 'Ext.xif'), zip: at('exports', 'm.zip'),
    folder: at('exports'),
    root: ROOT, sibling: 'C:\\srv\\ssam\\kernel\\other\\x.json', workDir: '/data/server/customers/acme/work', temp: 'C:\\Users\\svc\\AppData\\Local\\Temp\\x.json',
    cli: at('cli', 'anvil.dll'), roots: [ROOT, 'D:\\cache\\ssam'] };
  for (const tool of ['studio_snapshot', 'studio_deliver', 'o11_deliver', 'ssam_job']) {
    const out = licensee(tool, answer);
    const said = tool + ': ' + JSON.stringify(out).slice(0, 700);
    for (const key of ['path', 'snapshot', 'manifest', 'receipt', 'evidence', 'mine', 'xif', 'zip', 'folder']) assert.equal(out[key], answer[key], key + ' ' + said);
    assert.equal(out.report.snapshot.path, capture, said);
    assert.deepEqual(out.checks, answer.checks, said);
    for (const key of ['root', 'sibling', 'workDir', 'temp', 'cli']) assert.equal(out[key], '<server>', key + ' ' + said);
    assert.equal(out.roots, undefined, 'a list of server folders only is left out: ' + said);
    assert.deepEqual(owner(tool, answer), answer, 'the owner reads it whole');
  }
});

test('patchedJob leaves a licensee\'s answer whole; the corrected job goes on through nextBasedOn; the owner reads it whole', () => {
  const corrected = at('jobs', 'a1.oml.patched-job.json');
  const answer = { ok: true, accepted: true, job: corrected,
    patchedJob: { path: corrected, sha256: 'b'.repeat(64), source: { path: corrected + '.source.json', sha256: 'c'.repeat(64) } },
    nextBasedOn: { job: corrected, sha256: 'b'.repeat(64) },
    patchesApplied: [{ code: 'HTML_INVALID', pointer: '/ops/0/data/html', patchRule: 'TEXT_LITERAL_QUOTED', reason: 'quoted', from: 'a', to: '"a"', patchSha256: 'd'.repeat(64) }] };
  for (const tool of ['ssam_job', 'o11_job', 'o11_deliver', 'studio_deliver']) {
    const out = licensee(tool, answer, { job: {} });
    assert.equal(out.patchedJob, undefined, tool + ': ' + JSON.stringify(out).slice(0, 500));
    assert.deepEqual(out.nextBasedOn, answer.nextBasedOn, tool);
    assert.equal(out.job, corrected, tool);
    assert.equal(out.patchesApplied.length, 1, tool);
    assert.deepEqual(owner(tool, answer), answer, 'the owner reads it whole');
  }
  // a refusal that kept the corrected job aside (refusal-problems.mjs keeps patchedJob in its group): the same
  const refused = { ok: false, code: 'KERNEL_REFUSED', problems: [{ code: 'TEXT_LITERAL_CHOICE', message: 'choose', patchedJob: { path: corrected, sha256: 'b'.repeat(64) } }] };
  assert.equal(licensee('ssam_job', refused, { job: {} }).problems[0].patchedJob, undefined);
  // the sidecar, if a licensee names it by guess: its folder is a handle when it is under a root, else <server>
  const inside = licensee('ssam_evidence', { ok: true, value: { jobSha256: 'b'.repeat(64), sourceDirectory: at('jobs', 'inline') } }, { file: corrected + '.source.json' });
  assert.equal(inside.value.sourceDirectory, at('jobs', 'inline'));
  const outside = licensee('ssam_evidence', { ok: true, value: { jobSha256: 'b'.repeat(64), sourceDirectory: 'C:\\srv\\jobs\\acme' } }, { file: corrected + '.source.json' });
  assert.equal(outside.value.sourceDirectory, '<server>');
});
