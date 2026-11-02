// Review of W3-CSS, R2-1: the authorization to fill an existing module image travels outside the job. Only an image FILE that
// readCodeFiles read grants it (image-fill-grants.mjs), per account, and every kernel call on a job file passes it as
// --image-fill <name>=<sha256>; no field of the job's text (a _from:"file" a generated job carried, any other) ever does.
// Through the three ways a job reaches the kernel: ssam_code (parts ops, an ops.json among files, image files), o11_deliver
// and studio_deliver (applyKernel's argv: imageFillArgs of the job file). The kernel side is ImageFills.cs (its tests:
// ScreenHtmlEditJobTests and ModuleImageOdcTests). Fake Anvil CLI and temporary folders only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with { type: 'json' };
import { sandbox, serve } from './fixtures/served-proof-fixtures.mjs';
import { readCodeFiles, writeCall } from '../ssam-code.mjs';
import { imageFillArgs, grantImageFills, clearImageFillGrants, IMAGE_FILL_ARGUMENT } from '../image-fill-grants.mjs';

const WORDS = 'yes, deliver the logo of the sales portal';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const OTHER = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const handWritten = (bytes, extra = {}) => ({ op: 'create', parent: '@espace', type: 'IImage', name: 'Logo', args: { binary: bytes.toString('base64'), originalPath: 'logo.png' }, ...extra });
function folder(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-fill-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
const jobFile = (dir, name, ops) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify({ ops })); return file; };
const fills = argv => argv.flatMap((a, i) => (a === IMAGE_FILL_ARGUMENT ? [argv[i + 1]] : []));

test('R2-1: a _from:"file" written by hand grants nothing; only an image file read by readCodeFiles does, for its own name and bytes', t => {
  clearImageFillGrants(); t.after(clearImageFillGrants);
  const dir = folder(t);
  // Written by hand, with the marker a generated job carried: in a job file, in ssam_code parts ops, in an ops.json of files.
  const forged = handWritten(PNG, { _from: 'file' });
  const M = { lane: 'o11', module: 'M' };
  assert.deepEqual(imageFillArgs(jobFile(dir, 'hand.json', [forged]), M), []);
  const parts = writeCall({ lane: 'o11', module: 'M', part: 'ops', ops: [forged] });
  assert.ok(!parts.refusal, JSON.stringify(parts.refusal));
  assert.deepEqual(imageFillArgs(jobFile(dir, 'parts.json', parts.arguments.job.ops), M), []);
  const opsFile = path.join(dir, 'ops.json'); fs.writeFileSync(opsFile, JSON.stringify({ ops: [forged] }));
  const fromOpsFile = writeCall({ lane: 'o11', module: 'M', files: [opsFile] });
  assert.ok(!fromOpsFile.refusal, JSON.stringify(fromOpsFile.refusal));
  assert.deepEqual(imageFillArgs(jobFile(dir, 'opsfile.json', fromOpsFile.arguments.job.ops), M), []);
  // Reading an image file grants nothing by itself: the write that reads it does, for its own module (R3-S1).
  const logo = path.join(dir, 'Logo.png'); fs.writeFileSync(logo, PNG);
  const read = readCodeFiles([logo]);
  assert.deepEqual(read.problems, []);
  assert.equal(read.parts[0].ops[0]._from, undefined, 'the op carries no authorization of its own');
  const file = jobFile(dir, 'file.json', read.parts[0].ops);
  assert.deepEqual(imageFillArgs(file, M), []);
  // A real image file of a write: the grant of its name (logo) and bytes; the job's create of it is passed, a create of other bytes is not.
  const written = writeCall({ lane: 'o11', module: 'M', expectedEnvironment: 'env-a.example.test', files: [logo] });
  assert.ok(!written.refusal, JSON.stringify(written.refusal));
  const at = { ...M, environment: 'env-a.example.test' };
  assert.deepEqual(fills(imageFillArgs(file, at)), ['Logo=' + sha(PNG)]);
  assert.deepEqual(imageFillArgs(jobFile(dir, 'other.json', [handWritten(OTHER, { _from: 'file' })]), at), [], 'other bytes under the same name');
  assert.deepEqual(imageFillArgs(jobFile(dir, 'nested.json', [{ ...read.parts[0].ops[0], parent: 'IMobileFlow:MainFlow' }]), at), [], 'only a module image of the module');
  // R3-S1: bound to the write's module, environment and lane; a call that names no module gets nothing.
  assert.deepEqual(imageFillArgs(file, { ...at, module: 'OtherModule' }), [], 'another module of the same account');
  assert.deepEqual(imageFillArgs(file, { ...at, environment: 'env-b.example.test' }), [], 'another environment');
  assert.deepEqual(imageFillArgs(file, M), [], 'the write named an environment: a call without it is another place');
  assert.deepEqual(imageFillArgs(file, { ...at, lane: 'odc' }), [], 'another lane');
  assert.deepEqual(imageFillArgs(file, {}), [], 'no module');
  assert.deepEqual(fills(imageFillArgs(file, { lane: 'o11', module: 'm', environment: 'ENV-A.example.test' })), ['Logo=' + sha(PNG)], 'names without case');
  // Per account: a hosted customer's grants are never another's (the scope is the workspace; local is its own).
  grantImageFills([{ name: 'Shared', sha256: sha(OTHER) }], { lane: 'o11', module: 'M', scope: 'hosted:C:/ws/a' });
  assert.deepEqual(imageFillArgs(jobFile(dir, 'b.json', [{ ...handWritten(OTHER), name: 'Shared' }]), { ...M, scope: 'hosted:C:/ws/b' }), []);
  assert.deepEqual(fills(imageFillArgs(jobFile(dir, 'a.json', [{ ...handWritten(OTHER), name: 'Shared' }]), { ...M, scope: 'hosted:C:/ws/a' })), ['Shared=' + sha(OTHER)]);
  // A grant expires.
  assert.deepEqual(imageFillArgs(file, { ...at, now: Date.now() + 31 * 60 * 1000 }), []);
});

test('R2-1: o11_deliver passes --image-fill only for the image a file of ssam_code granted, never for a hand-written _from', async t => {
  clearImageFillGrants(); t.after(clearImageFillGrants);
  const box = sandbox(t);
  const runAnvil = fakeAnvil({ deliver: () => envelopes.delivered });
  const deps = { root: box.root, env: box.env, lane: 'ss4', now: box.now, runAnvil, assertSelected: async () => {}, grantsFile: path.join(box.base, 'grants.json'),
    lastPublication: async () => null, readerCheck: null };
  const call = await serve(t, deps);
  const kernelFills = () => fills(runAnvil.calls.filter(c => ['deliver', 'apply', 'check-job'].includes(c.args[0])).flatMap(c => c.args));
  // Hand-written job file and inline job, with the marker: the kernel gets no grant (and answers NAME_COLLISION, ImageFills.cs).
  const forged = handWritten(PNG, { _from: 'file' });
  assert.equal((await call({ module: 'SalesPortal', job: box.job('hand.json', { ops: [forged] }), authorize: WORDS })).ok, true);
  assert.equal((await call({ module: 'SalesPortal', job: { ops: [forged] }, authorize: WORDS })).ok, true);
  assert.deepEqual(kernelFills(), []);
  // The image file read by ssam_code (readCodeFiles): the same create is passed with its grant.
  const dir = folder(t);
  const logo = path.join(dir, 'Logo.png'); fs.writeFileSync(logo, PNG);
  const written = writeCall({ lane: 'o11', module: 'SalesPortal', files: [logo] });
  assert.equal(written.tool, 'o11_deliver');
  assert.equal((await call({ ...written.arguments, authorize: WORDS })).ok, true);
  assert.deepEqual([...new Set(kernelFills())], ['Logo=' + sha(PNG)]);
  // R3-S1: the same job delivered to another module of the account within the 30 minutes takes no grant.
  const before = runAnvil.calls.length;
  assert.equal((await call({ ...written.arguments, module: 'OtherPortal', authorize: WORDS })).ok, true);
  assert.deepEqual(fills(runAnvil.calls.slice(before).flatMap(c => c.args)), []);
});

test('R2-1: studio_deliver\'s kernel apply and check take the grants from imageFillArgs of the job file, never from its text', async t => {
  clearImageFillGrants(); t.after(clearImageFillGrants);
  const dir = folder(t);
  const source = fs.readFileSync(new URL('../kernel-delivery.mjs', import.meta.url), 'utf8');
  // The two kernel calls on a job file of the ODC delivery build their argv with the job's grants.
  assert.match(source, /\['apply', '--job', job, \.\.\.imageFillArgs\(job, /);
  assert.match(source, /\['check-job', '--job', job, \.\.\.imageFillArgs\(job, /);
  const forged = jobFile(dir, 'studio.json', [handWritten(PNG, { _from: 'file' })]);
  const P = { lane: 'odc', module: 'Portal' };
  assert.deepEqual(imageFillArgs(forged, P), []);
  const logo = path.join(dir, 'Logo.png'); fs.writeFileSync(logo, PNG);
  const written = writeCall({ lane: 'odc', module: 'Portal', files: [logo] });
  assert.equal(written.tool, 'studio_deliver');
  const own = jobFile(dir, 'studio-file.json', written.arguments.job.ops);
  assert.deepEqual(fills(imageFillArgs(own, P)), ['Logo=' + sha(PNG)]);
  assert.deepEqual(imageFillArgs(own, { ...P, module: 'OtherApp' }), [], 'R3-S1: another app of the account');
  assert.deepEqual(imageFillArgs(own, { ...P, lane: 'o11' }), [], 'R3-S1: the other lane');
  assert.deepEqual(fills(imageFillArgs(forged, P)), ['Logo=' + sha(PNG)], 'the same name and the very same bytes as the file just read: the same write');
  // The ODC delivery passes its module to both kernel calls.
  assert.match(source, /imageFillArgs\(job, \{ lane: 'odc', module \}\)/);
  assert.match(source, /check\(\{ job, module \}\)/);
});
