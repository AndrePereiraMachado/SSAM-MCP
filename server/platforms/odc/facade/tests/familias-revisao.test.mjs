// The review of integration 24-1 familias (2026-10-13), the facade's part of each family:
//   1. one patch per document: patches of one refusal that write different values at one path are no patch (the last would
//      undo the first): each such problem says patchOmitted and why, no verified call is written, and a verified file that
//      has such a union is refused when it is applied;
//   4. removal goes the other way of creation: a data text that only drops goes after the parts that change its consumers,
//      in any order the model wrote them, both lanes; a data text that drops and creates keeps the order it was given.
// Fakes only: no Studio, no worker, no CLI.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { refusalFields } from '../refusal-problems.mjs';
import { resolvePatchedJob } from '../job-patch.mjs';
import { patchConflicts, verifiedPatchFile, VERIFIED_PATCH_SCHEMA } from '../verified-patch.mjs';
import { writeCall, orderParts } from '../ssam-code.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(isolatedProfile, 'fam-rev-'));

test('two patches of one path with different values are no patch: patchOmitted with why, no verified call', () => {
  const html = '<screen name="S">\n<aggregate name="A" from="E" where="E.Id &gt; 1"/>\n<input placeholder="Buscar por nome"/>\n</screen>';
  const aggregate = html.replace('E.Id &gt; 1', 'IdentifierToLongInteger(E.Id) &gt; 1');
  const prose = html.replace('placeholder="Buscar por nome"', 'placeholder=\'"Buscar por nome"\'');
  const problems = [
    { phase: 'preflight', op: 0, pointer: '/ops/0/data/html', code: 'OPERAND_TYPES', severity: 'error', message: 'a', fix: 'f', patch: [{ op: 'replace', path: '/ops/0/data/html', value: aggregate }], patchCertain: true },
    { phase: 'apply', op: 0, pointer: '/ops/0/data/html', code: 'HTML_INVALID', severity: 'error', message: 'b', fix: 'f', patch: [{ op: 'replace', path: '/ops/0/data/html', value: prose }], patchCertain: true },
    { phase: 'apply', op: 1, pointer: '/ops/1/value', code: 'OTHER', severity: 'error', message: 'c', fix: 'f', patch: [{ op: 'replace', path: '/ops/1/value', value: 'x' }], patchCertain: true },
  ];
  assert.deepEqual(patchConflicts(problems.flatMap(p => p.patch)), [{ path: '/ops/0/data/html', values: 2 }]);
  const dir = tmp(); const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify({ ops: [{ op: 'html', data: { html } }, { op: 'set', value: 'y' }] }));
  const fields = refusalFields(problems, { verifyRan: true }, { jobFile: file });
  const [a, b, c] = fields.problems;
  for (const p of [a, b]) { assert.equal(p.patch, undefined); assert.equal(p.patchOmitted, true); assert.match(p.patchOmittedWhy, /same path/); }
  // The patch of another path stays, and is the only one of the verified call.
  assert.deepEqual(c.patch, [{ op: 'replace', path: '/ops/1/value', value: 'x' }]);
  assert.equal(fields.verifiedPatch.ops, 1);
  // The same value twice is one patch (no conflict), and one value per path is the union as before.
  assert.deepEqual(patchConflicts([{ op: 'replace', path: '/p', value: 'v' }, { op: 'replace', path: '/p', value: 'v' }, { op: 'add', path: '/q', value: 1 }]), []);
});

test('a verified file whose union writes one path twice is refused when it is applied', () => {
  const dir = tmp(); const file = path.join(dir, 'job.json'); const text = JSON.stringify({ ops: [{ op: 'html', data: { html: 'a' } }] });
  fs.writeFileSync(file, text);
  fs.writeFileSync(verifiedPatchFile(file), JSON.stringify({ schema: VERIFIED_PATCH_SCHEMA, job: path.resolve(file), jobSha256: sha(text),
    patch: [{ op: 'replace', path: '/ops/0/data/html', value: 'b' }, { op: 'replace', path: '/ops/0/data/html', value: 'c' }] }));
  const resolved = resolvePatchedJob({ patch: 'verified', basedOn: { job: file, sha256: sha(text) } }, { inlineDir: path.join(dir, 'inline') });
  assert.equal(resolved.ok, false);
  assert.match(resolved.error ?? resolved.message ?? '', /same path/);
});

test('a data text that only drops goes after the parts that change its consumers, in any order, both lanes', () => {
  const logic = 'action Visitas.Cancelar\n  end\n';
  const drop = 'drop entity FamFoo;';
  const placeOf = (ops, kind) => ops.findIndex(o => kind === 'ddl' ? o.data?.ddl != null : o.data?.flow != null);
  for (const lane of ['o11', 'odc']) {
    const options = lane === 'odc' ? { owners: ['Visitas'], changes: ['c'] } : {};
    // The model's order (logic, then the drop) passes as given: nothing moved.
    const given = writeCall({ lane, action: 'write', module: 'M', part: 'logic', text: logic, also: [{ part: 'ddl', text: drop }], ...options });
    const job = given.arguments.job.ops;
    assert.ok(placeOf(job, 'logic') < placeOf(job, 'ddl'), lane + ': ' + JSON.stringify(job));
    assert.ok(!(given.normalizations ?? []).some(n => n.rule === 'parts-order'));
    // The drop written first: it goes after the logic (removal the other way of creation), noted.
    const first = writeCall({ lane, action: 'write', module: 'M', part: 'ddl', text: drop, also: [{ part: 'logic', text: logic }], ...options });
    const ops = first.arguments.job.ops;
    assert.ok(placeOf(ops, 'logic') < placeOf(ops, 'ddl'), lane + ': ' + JSON.stringify(ops));
    assert.ok(first.normalizations.some(n => n.rule === 'parts-order'));
  }
  // A data text that creates goes first, as before.
  const creates = orderParts([{ part: 'logic', text: logic }, { part: 'ddl', text: 'create entity FamBar (\n  Id Long Integer identifier auto required\n);' }]);
  assert.deepEqual(creates.parts.map(p => p.part), ['ddl', 'logic']);
  // A data text that drops and creates: two places, two readings: the order as given.
  const mixed = [{ part: 'logic', text: logic }, { part: 'ddl', text: 'create entity FamBar (\n  Id Long Integer identifier auto required\n);\ndrop entity FamFoo;' }];
  assert.deepEqual(orderParts(mixed), { parts: mixed, moved: false });
  // A comment that says drop is no drop.
  assert.deepEqual(orderParts([{ part: 'logic', text: logic }, { part: 'ddl', text: '-- drop entity X\ncreate entity FamBar (\n  Id Long Integer identifier auto required\n);' }]).parts.map(p => p.part), ['ddl', 'logic']);
});
