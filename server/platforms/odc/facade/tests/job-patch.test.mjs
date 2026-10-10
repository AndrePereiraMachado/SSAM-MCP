// job-patch.mjs: the JSON Patch subset over a job's ops, the base checked by sha256 (a job file or an O11 kernel task),
// the patched job always a new file, the base never rewritten. Every folder is temporary; nothing runs a process.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { applyJobPatch, resolvePatchedJob, jobIdentity, failedOpOf, readKernelTaskState, PatchError, PATCH_MAX_OPS, patchJsonSchema, basedOnJsonSchema } from '../job-patch.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const JOB = { base: 'tests/fixtures/blank-service.oml', expectValid: true, ops: [
  { op: 'create', parent: '@espace', type: 'ServerAction', name: 'SaveOrder', as: '$save' },
  { op: 'set', target: '$save', prop: 'Description', value: 'Saves' },
  { op: 'create', parent: '$save', type: 'InputParameter', name: 'Total', args: { DataType: 'Integer' } }] };

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'job-patch-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const inlineDir = path.join(base, '.local', 'jobs', 'inline');
  const work = path.join(base, '.local', 'work');
  const job = path.join(base, 'jobs', 'save-order.json');
  fs.mkdirSync(path.dirname(job), { recursive: true });
  fs.writeFileSync(job, JSON.stringify(JOB, null, 2));
  let n = 0;
  return { base, inlineDir, work, job, uuid: () => 'patched-' + (++n), bytes: () => fs.readFileSync(job) };
}
const thrown = fn => { try { fn(); } catch (error) { return error; } assert.fail('expected a PatchError'); };

function writeKernelTask(work, id, state) {
  const payload = JSON.stringify({ taskId: id, module: 'Orders', delivered: false, ...state });
  fs.mkdirSync(path.join(work, 'deliver', id), { recursive: true });
  fs.writeFileSync(path.join(work, 'deliver', id, 'task.json'), JSON.stringify({ format: 1, sha256: sha256(payload), payload }));
}

test('add, replace, remove and test over the ops of {ops} and of an array job; the job given is never changed', () => {
  const before = structuredClone(JOB);
  const patched = applyJobPatch(JOB, [
    { op: 'test', path: '/ops/1/value', value: 'Saves' },
    { op: 'replace', path: '/ops/1/value', value: 'Saves the order' },
    { op: 'add', path: '/ops/2/args/IsMandatory', value: true },
    { op: 'add', path: '/ops/-', value: { op: 'set', target: '$save', prop: 'Public', value: 'Yes' } },
    { op: 'add', path: '/ops/0', value: { op: 'get', target: 'ServerAction:Old' } },
    { op: 'remove', path: '/ops/1/as' },
    { op: 'test', path: '/ops/3/args', value: { IsMandatory: true, DataType: 'Integer' } }, // objects compare by content, not key order
  ]);
  assert.deepEqual(JOB, before);
  assert.deepEqual(patched, { ...before, ops: [{ op: 'get', target: 'ServerAction:Old' },
    { op: 'create', parent: '@espace', type: 'ServerAction', name: 'SaveOrder' },
    { op: 'set', target: '$save', prop: 'Description', value: 'Saves the order' },
    { op: 'create', parent: '$save', type: 'InputParameter', name: 'Total', args: { DataType: 'Integer', IsMandatory: true } },
    { op: 'set', target: '$save', prop: 'Public', value: 'Yes' }] });
  // no field is added outside ops: base and expectValid stay as they were
  assert.deepEqual(Object.keys(patched), ['base', 'expectValid', 'ops']);

  const array = applyJobPatch(JOB.ops, [{ op: 'remove', path: '/0' }, { op: 'replace', path: '/0/value', value: null }, { op: 'test', path: '/0/value', value: null }]);
  assert.equal(array.length, 2); assert.equal(array[0].value, null);
  // ~1 is "/" and ~0 is "~" in a key
  assert.deepEqual(applyJobPatch([{ op: 'set', 'a/b': 1, 'c~d': 2 }], [{ op: 'replace', path: '/0/a~1b', value: 3 }, { op: 'remove', path: '/0/c~0d' }]), [{ op: 'set', 'a/b': 3 }]);
  // a value added twice is two copies
  const twice = applyJobPatch(JOB, [{ op: 'add', path: '/ops/-', value: { op: 'get', args: { x: 1 } } }, { op: 'add', path: '/ops/-', value: { op: 'get', args: { x: 1 } } },
    { op: 'replace', path: '/ops/3/args/x', value: 2 }]);
  assert.deepEqual([twice.ops[3].args.x, twice.ops[4].args.x], [2, 1]);
});

test('paths outside the ops and expectedMessages are forbidden: base, expectValid, ops itself, the root, a composite job, __proto__', () => {
  for (const where of ['/base', '/expectValid', '/ops', '', '/jobs/0'])
    assert.equal(thrown(() => applyJobPatch(JOB, [{ op: 'add', path: where, value: 1 }])).code, 'PATCH_PATH_FORBIDDEN', where);
  assert.equal(thrown(() => applyJobPatch(JOB.ops, [{ op: 'replace', path: '', value: [] }])).code, 'PATCH_PATH_FORBIDDEN');
  const composite = thrown(() => applyJobPatch({ jobs: ['job:a', 'job:b'] }, [{ op: 'replace', path: '/jobs/0', value: 'job:c' }]));
  assert.equal(composite.code, 'PATCH_PATH_FORBIDDEN'); assert.match(composite.message, /composite/);
  const proto = thrown(() => applyJobPatch(JOB, [{ op: 'add', path: '/ops/0/__proto__', value: { polluted: true } }]));
  assert.equal(proto.code, 'PATCH_PATH_FORBIDDEN');
  assert.equal({}.polluted, undefined);
  // the second operation is the forbidden one: its index comes back and nothing is applied
  const second = thrown(() => applyJobPatch(JOB, [{ op: 'replace', path: '/ops/0/name', value: 'X' }, { op: 'replace', path: '/base', value: 'other.oml' }]));
  assert.equal(second.at, 1); assert.match(second.message, /^patch\[1\] replace \/base: only the job's ops and expectedMessages are patched/);
});

test('a failed test refuses the whole patch with PATCH_TEST_FAILED', () => {
  const error = thrown(() => applyJobPatch(JOB, [{ op: 'replace', path: '/ops/1/value', value: 'x' }, { op: 'test', path: '/ops/0/name', value: 'Other' }]));
  assert.ok(error instanceof PatchError);
  assert.equal(error.code, 'PATCH_TEST_FAILED'); assert.equal(error.at, 1);
  assert.equal(thrown(() => applyJobPatch(JOB, [{ op: 'test', path: '/ops/2/args', value: { DataType: 'Integer', Extra: 1 } }])).code, 'PATCH_TEST_FAILED');
  assert.equal(thrown(() => applyJobPatch(JOB, [{ op: 'test', path: '/ops/2/args/DataType', value: ['Integer'] }])).code, 'PATCH_TEST_FAILED');
});

test('malformed patches are PATCH_INVALID with the operation index', () => {
  const cases = [
    [[{ op: 'move', path: '/ops/0', from: '/ops/1' }], /unknown key\(s\) from/],
    [[{ op: 'move', path: '/ops/0' }], /op is one of add, remove, replace, test/],
    [[{ op: 'add', path: '/ops/0' }], /add needs value/],
    [[{ op: 'replace', path: 'ops/0/name', value: 'x' }], /JSON pointer/],
    [[{ op: 'replace', path: '/ops/0/na~2me', value: 'x' }], /~0/],
    [[{ op: 'replace', path: '/ops/9/name', value: 'x' }], /no value at \/ops\/9$/],
    [[{ op: 'replace', path: '/ops/0/missing/deeper', value: 'x' }], /no value at \/ops\/0\/missing$/],
    [[{ op: 'remove', path: '/ops/0/missing' }], /no value at \/ops\/0\/missing$/],
    [[{ op: 'replace', path: '/ops/-', value: {} }], /not an array index/],
    [[{ op: 'replace', path: '/ops/01', value: {} }], /not an array index/],
    [[{ op: 'add', path: '/ops/4', value: {} }], /no value at \/ops\/4$/],
    [[{ op: 'replace', path: '/ops/1/value/x', value: 1 }], /no value at \/ops\/1\/value$/],
    [['remove /ops/0'], /is not an object/],
  ];
  for (const [patch, message] of cases) {
    const error = thrown(() => applyJobPatch(JOB, patch));
    assert.equal(error.code, 'PATCH_INVALID', JSON.stringify(patch)); assert.match(error.message, message); assert.equal(error.at, 0);
  }
  assert.equal(thrown(() => applyJobPatch(JOB, [])).code, 'PATCH_INVALID');
  const many = Array.from({ length: PATCH_MAX_OPS + 1 }, () => ({ op: 'test', path: '/ops/0/op', value: 'create' }));
  assert.match(thrown(() => applyJobPatch(JOB, many)).message, /at most 50/);
  assert.doesNotThrow(() => applyJobPatch(JOB, many.slice(1)));
  // the result is still a job: ops left, each an object
  assert.match(thrown(() => applyJobPatch(JOB, [0, 1, 2].map(() => ({ op: 'remove', path: '/ops/0' })))).message, /no ops left/);
  assert.match(thrown(() => applyJobPatch(JOB, [{ op: 'replace', path: '/ops/1', value: 'set x' }])).message, /op #1 is not an object/);
});

test('resolvePatchedJob writes a new file at every attempt and never touches the base', t => {
  const s = sandbox(t);
  const original = s.bytes();
  const basedOn = { job: s.job, sha256: sha256(original) };
  const first = resolvePatchedJob({ patch: [{ op: 'replace', path: '/ops/1/value', value: 'One' }], basedOn }, { inlineDir: s.inlineDir, uuid: s.uuid });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.path, path.join(s.inlineDir, 'patched-1.json'));
  const text = fs.readFileSync(first.path, 'utf8');
  assert.equal(first.sha256, sha256(text));
  assert.deepEqual(JSON.parse(text), { ...JOB, ops: [JOB.ops[0], { ...JOB.ops[1], value: 'One' }, JOB.ops[2]] });
  assert.deepEqual(first.basedOn, { job: s.job, sha256: basedOn.sha256 });
  const second = resolvePatchedJob({ patch: [{ op: 'replace', path: '/ops/1/value', value: 'Two' }], basedOn }, { inlineDir: s.inlineDir, uuid: s.uuid });
  assert.equal(second.path, path.join(s.inlineDir, 'patched-2.json'));
  assert.notEqual(second.sha256, first.sha256);
  assert.equal(JSON.parse(fs.readFileSync(first.path, 'utf8')).ops[1].value, 'One', 'the first attempt stays as it was');
  assert.ok(s.bytes().equals(original), 'the base is never rewritten');
  // a patch on the patched file: its own path and sha256
  const third = resolvePatchedJob({ patch: [{ op: 'remove', path: '/ops/2' }], basedOn: { job: second.path, sha256: second.sha256.toUpperCase() } }, { inlineDir: s.inlineDir, uuid: s.uuid });
  assert.equal(third.ok, true); assert.equal(JSON.parse(fs.readFileSync(third.path, 'utf8')).ops.length, 2);
  // the same uuid never overwrites a file
  assert.throws(() => resolvePatchedJob({ patch: [{ op: 'remove', path: '/ops/2' }], basedOn }, { inlineDir: s.inlineDir, uuid: () => 'patched-1' }), /EEXIST/);
  assert.deepEqual(fs.readdirSync(s.inlineDir).sort(), ['patched-1.json', 'patched-2.json', 'patched-3.json']);
});

test('a base whose sha256 differs is BASE_CHANGED and nothing is written; missing, relative and malformed bases are refused', t => {
  const s = sandbox(t);
  const options = { inlineDir: s.inlineDir, uuid: s.uuid };
  const patch = [{ op: 'remove', path: '/ops/2' }];
  const changed = resolvePatchedJob({ patch, basedOn: { job: s.job, sha256: 'ab'.repeat(32) } }, options);
  assert.deepEqual([changed.ok, changed.code, changed.job], [false, 'BASE_CHANGED', s.job]);
  assert.equal(changed.jobSha256, undefined, 'the new sha256 is never handed back');
  assert.equal(fs.existsSync(s.inlineDir), false);
  assert.equal(resolvePatchedJob({ patch, basedOn: { job: path.join(s.base, 'none.json'), sha256: 'ab'.repeat(32) } }, options).code, 'BASE_NOT_FOUND');
  assert.equal(resolvePatchedJob({ patch, basedOn: { job: 'jobs/save-order.json', sha256: sha256(s.bytes()) } }, options).code, 'JOB_PATH_NOT_ABSOLUTE');
  assert.equal(resolvePatchedJob({ patch, basedOn: { job: 'jobs/save-order.json', sha256: sha256(s.bytes()) } }, { ...options, root: s.base }).ok, true, 'relative to root when one is given');
  assert.equal(resolvePatchedJob({ patch, basedOn: { job: s.job } }, options).code, 'PATCH_INVALID');
  assert.equal(resolvePatchedJob({ patch, basedOn: { job: s.job, sha256: 'xyz' } }, options).code, 'PATCH_INVALID');
  assert.equal(resolvePatchedJob({ patch, basedOn: { job: s.job, sha256: sha256(s.bytes()), extra: 1 } }, options).code, 'PATCH_INVALID');
  const garbled = path.join(s.base, 'garbled.json'); fs.writeFileSync(garbled, '{ops:');
  assert.equal(resolvePatchedJob({ patch, basedOn: { job: garbled, sha256: sha256('{ops:') } }, options).code, 'PATCH_INVALID');
  // patch errors come back as values with the operation index
  const failed = resolvePatchedJob({ patch: [{ op: 'remove', path: '/ops/2' }, { op: 'test', path: '/ops/0/name', value: 'X' }], basedOn: { job: s.job, sha256: sha256(s.bytes()) } }, options);
  assert.deepEqual([failed.ok, failed.code, failed.at], [false, 'PATCH_TEST_FAILED', 1]);
  assert.equal(resolvePatchedJob({ patch: [{ op: 'add', path: '/base', value: 'x' }], basedOn: { job: s.job, sha256: sha256(s.bytes()) } }, options).code, 'PATCH_PATH_FORBIDDEN');
  assert.deepEqual(fs.readdirSync(s.inlineDir), ['patched-1.json'], 'only the accepted patch (relative to root) wrote a file');
});

test('patch and job are exclusive; patch needs basedOn; job alone is resolved as o11_deliver resolved it', t => {
  const s = sandbox(t);
  const options = { inlineDir: s.inlineDir, uuid: s.uuid };
  const patch = [{ op: 'remove', path: '/ops/2' }];
  assert.equal(resolvePatchedJob({ job: s.job, patch, basedOn: { job: s.job, sha256: sha256(s.bytes()) } }, options).code, 'PATCH_INVALID');
  assert.match(resolvePatchedJob({ patch }, options).error, /patch needs basedOn/);
  assert.match(resolvePatchedJob({ basedOn: { job: s.job, sha256: sha256(s.bytes()) } }, options).error, /basedOn goes with patch/);
  assert.deepEqual(resolvePatchedJob({ job: s.job }, options), { ok: true, path: s.job, sha256: sha256(s.bytes()) });
  const inline = resolvePatchedJob({ job: JOB.ops }, options);
  assert.equal(inline.path, path.join(s.inlineDir, 'patched-1.json')); assert.deepEqual(JSON.parse(fs.readFileSync(inline.path, 'utf8')), JOB.ops);
  assert.equal(inline.sha256, sha256(fs.readFileSync(inline.path)));
  assert.equal(resolvePatchedJob({ job: '{"ops":' }, options).code, 'JOB_INVALID');
  assert.equal(resolvePatchedJob({ job: 'relative.json' }, options).code, 'JOB_PATH_NOT_ABSOLUTE');
  assert.equal(resolvePatchedJob({ job: path.join(s.base, 'none.json') }, options).code, 'JOB_NOT_FOUND');
  assert.throws(() => resolvePatchedJob({ job: s.job }, {}), /inlineDir/);
});

test('basedOn {taskId}: the job of the O11 kernel task, checked against the sha256 the kernel recorded', t => {
  const s = sandbox(t);
  const options = { inlineDir: s.inlineDir, work: s.work, uuid: s.uuid };
  const patch = [{ op: 'replace', path: '/ops/0/name', value: 'SaveOrder2' }];
  const id = 'a1'.repeat(16);
  writeKernelTask(s.work, id, { request: { Module: 'Orders', JobPath: s.job }, sources: [{ path: s.job, sha256: sha256(s.bytes()) }], writeState: 'not-sent', error: 'job rejected' });
  const patched = resolvePatchedJob({ patch, basedOn: { taskId: id } }, options);
  assert.equal(patched.ok, true, JSON.stringify(patched));
  assert.deepEqual(patched.basedOn, { job: s.job, sha256: sha256(s.bytes()), taskId: id });
  assert.equal(JSON.parse(fs.readFileSync(patched.path, 'utf8')).ops[0].name, 'SaveOrder2');
  // a sha256 given with the task must match too
  assert.equal(resolvePatchedJob({ patch, basedOn: { taskId: id, sha256: 'cd'.repeat(32) } }, options).code, 'BASE_CHANGED');
  // the file changed after the task recorded it
  fs.writeFileSync(s.job, JSON.stringify({ ...JOB, expectValid: false }));
  assert.equal(resolvePatchedJob({ patch, basedOn: { taskId: id } }, options).code, 'BASE_CHANGED');
  // no recorded sha256: only with one given
  const bare = 'b2'.repeat(16);
  writeKernelTask(s.work, bare, { request: { JobPath: s.job } });
  assert.equal(resolvePatchedJob({ patch, basedOn: { taskId: bare } }, options).code, 'BASE_UNVERIFIED');
  assert.equal(resolvePatchedJob({ patch, basedOn: { taskId: bare, sha256: sha256(s.bytes()) } }, options).ok, true);
  assert.equal(resolvePatchedJob({ patch, basedOn: { taskId: 'c3'.repeat(16) } }, options).code, 'BASE_NOT_FOUND');
  assert.equal(resolvePatchedJob({ patch, basedOn: { taskId: id } }, { inlineDir: s.inlineDir }).code, 'BASE_TASK_UNSUPPORTED');
  assert.equal(resolvePatchedJob({ patch, basedOn: { taskId: 'short' } }, options).code, 'PATCH_INVALID');
  // a checkpoint whose hash does not match its payload is not read
  const corrupt = 'd4'.repeat(16);
  fs.mkdirSync(path.join(s.work, 'deliver', corrupt), { recursive: true });
  fs.writeFileSync(path.join(s.work, 'deliver', corrupt, 'task.json'), JSON.stringify({ format: 1, sha256: 'ef'.repeat(32), payload: JSON.stringify({ request: { JobPath: s.job } }) }));
  assert.equal(readKernelTaskState(s.work, corrupt), null);
  assert.equal(resolvePatchedJob({ patch, basedOn: { taskId: corrupt, sha256: sha256(s.bytes()) } }, options).code, 'BASE_NOT_FOUND');
});

test('the provenance goes to the journal only; the patched job carries none of it', t => {
  const s = sandbox(t);
  const journalDir = path.join(s.base, '.local', 'journal');
  const patched = resolvePatchedJob({ patch: [{ op: 'remove', path: '/ops/2' }], basedOn: { job: s.job, sha256: sha256(s.bytes()) } },
    { inlineDir: s.inlineDir, uuid: s.uuid, journalDir, tool: 'o11_job', now: () => new Date('2026-10-03T12:00:00Z') });
  const lines = fs.readFileSync(path.join(journalDir, 'job-patch.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines, [{ at: '2026-10-03T12:00:00.000Z', event: 'patch', tool: 'o11_job', job: patched.path, jobSha256: patched.sha256,
    basedOn: { job: s.job, sha256: sha256(s.bytes()) }, patchOps: 1 }]);
  const written = fs.readFileSync(patched.path, 'utf8');
  assert.ok(!written.includes('basedOn') && !written.includes(s.job.replace(/\\/g, '\\\\')));
});

test('jobIdentity and failedOpOf: the op index only when the kernel names it reliably', t => {
  const s = sandbox(t);
  assert.deepEqual(jobIdentity(s.job), { job: s.job, jobSha256: sha256(s.bytes()) });
  assert.deepEqual(jobIdentity(path.join(s.base, 'none.json')), { job: path.join(s.base, 'none.json') });
  assert.deepEqual(jobIdentity(null), {});
  // Verbs.Apply: `op #N (<verb> <name|prop>): <Exception>: ...`, with or without the type in front (Errors.Text)
  assert.equal(failedOpOf("op #2 (create Total): InvalidOperationException: create: unknown key(s) 'bogus'", s.job), 2);
  assert.equal(failedOpOf('InvalidOperationException: op #1 (set Description): no such property', s.job), 1);
  // JobPreflight: `op #N (<verb> ): ...`
  assert.equal(failedOpOf('op #0 (create ): InvalidOperationException: bad parent\nop #2 (create ): other', s.job), 0);
  for (const error of [
    'op #1 (create SaveOrder): wrong verb',           // op 1 is a set
    'op #2 (create Other): wrong name',               // op 2 is named Total
    'op #7 (set Description): out of range',
    'op #3: unknown type Foo on X',                   // no verb in parentheses
    'html op #0 (add class): nested index',           // an inner language index, not the job's
    'merge kept for review: new TrueChange errors',
    null]) assert.equal(failedOpOf(error, s.job), null, String(error));
  const composite = path.join(s.base, 'composite.json'); fs.writeFileSync(composite, JSON.stringify({ jobs: ['job:a'], ops: [{ op: 'set', prop: 'X' }] }));
  assert.equal(failedOpOf('op #0 (set X): spans the parts', composite), null);
  assert.equal(failedOpOf('op #0 (set X): no file', path.join(s.base, 'none.json')), null);
  const array = path.join(s.base, 'array.json'); fs.writeFileSync(array, JSON.stringify([{ op: 'get' }, { op: 'reference', producer: 'p.oml' }]));
  assert.equal(failedOpOf('op #1 (reference): FileNotFoundException: p.oml', array), 1);
});

test('the patched copy keeps resolving the references of its base: job:X, a negative folder and a relative fixture are pinned', t => {
  // A repository as the kernel sees it (MANIFESTO.md): tests/jobs-odc/Lib.json and a different tests/jobs/Lib.json of the
  // O11 lane; from the inline folder, "job:Lib" would silently reach the O11 one.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'job-patch-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const write = (rel, value) => { const file = path.join(repo, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); return file; };
  write('MANIFESTO.md', '# kernel');
  const odcLib = write('tests/jobs-odc/Lib.json', { ops: [{ op: 'get', target: 'odc' }] });
  write('tests/jobs/Lib.json', { ops: [{ op: 'get', target: 'o11' }] });
  write('tests/jobs/Shared.json', { ops: [{ op: 'get', target: 'shared' }] });
  write('tests/fixtures/blank-odc.oml', 'oml');
  const screen = write('tests/jobs-odc/tela.json', { base: 'job:Lib', ops: [
    { op: 'reference', producer: 'job:Lib', name: 'X' }, { op: 'reference', producer: 'Lib', name: 'Y' },
    { op: 'reference', producer: 'job:Shared', name: 'Z' }, { op: 'reference', producer: 'job:Missing', name: 'W' },
    { op: 'set', target: 'Screen:Home', prop: 'Title', value: 'a' }] });
  const inlineDir = path.join(repo, '.local', 'lane-odc', 'jobs', 'inline');
  const patched = resolvePatchedJob({ patch: [{ op: 'replace', path: '/ops/4/value', value: 'b' }], basedOn: { job: screen, sha256: sha256(fs.readFileSync(screen)) } },
    { inlineDir, uuid: () => 'pinned' });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  const job = JSON.parse(fs.readFileSync(patched.path, 'utf8'));
  const pin = 'job:' + odcLib.slice(0, -'.json'.length);
  assert.equal(job.base, pin, 'the base names the ODC Lib, not tests/jobs/Lib.json');
  assert.deepEqual(job.ops.map(o => o.producer ?? null), [pin, 'Lib', 'job:Shared', 'job:Missing', null],
    'a binding, a reference that resolves to the same file from both folders and one that resolves nowhere stay as written');
  assert.equal(job.ops[4].value, 'b');
  // A negative job reaches its positive folder; a fixture relative to the job folder becomes its absolute path.
  const negative = write('tests/jobs-odc-negative/tela-ruim.json', { base: '../fixtures/blank-odc.oml', ops: [{ op: 'reference', producer: 'job:Lib', name: 'X' }, { op: 'get' }] });
  const fixed = resolvePatchedJob({ patch: [{ op: 'remove', path: '/ops/1' }], basedOn: { job: negative, sha256: sha256(fs.readFileSync(negative)) } }, { inlineDir, uuid: () => 'pinned-negative' });
  const neg = JSON.parse(fs.readFileSync(fixed.path, 'utf8'));
  assert.equal(neg.ops[0].producer, pin);
  assert.equal(neg.base, path.join(repo, 'tests', 'fixtures', 'blank-odc.oml'));
  // A base in the inline folder itself (a patch of a patch) is copied as it is.
  const again = resolvePatchedJob({ patch: [{ op: 'remove', path: '/ops/4' }], basedOn: { job: patched.path, sha256: patched.sha256 } }, { inlineDir, uuid: () => 'pinned-again' });
  assert.equal(JSON.parse(fs.readFileSync(again.path, 'utf8')).base, pin);
  assert.ok(fs.readFileSync(screen, 'utf8').includes('"base": "job:Lib"'), 'the base is never rewritten');
});

test('jobIdentity names an array job (jobShape), whose patch paths are /<i>/...', t => {
  const s = sandbox(t);
  const array = path.join(s.base, 'array.json'); fs.writeFileSync(array, JSON.stringify(JOB.ops));
  assert.deepEqual(jobIdentity(array), { job: array, jobSha256: sha256(fs.readFileSync(array)), jobShape: 'array' });
  assert.equal(jobIdentity(s.job).jobShape, undefined);
});

test('the JSON Schemas of patch and basedOn match the zod shape the tools declare', () => {
  assert.equal(patchJsonSchema.maxItems, 50); assert.deepEqual(patchJsonSchema.items.properties.op.enum, ['add', 'remove', 'replace', 'test']);
  assert.equal(patchJsonSchema.items.additionalProperties, false); assert.deepEqual(patchJsonSchema.items.required, ['op', 'path']);
  assert.deepEqual(basedOnJsonSchema.anyOf.map(s => s.required), [['job', 'sha256'], ['taskId']]);
  assert.ok(basedOnJsonSchema.anyOf.every(s => s.additionalProperties === false));
});
