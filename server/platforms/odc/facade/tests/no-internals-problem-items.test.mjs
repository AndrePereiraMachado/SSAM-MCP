import './fixtures/isolated-profile.mjs';
// marco-a6 review M2 (C:\t\revisoes\marco-a6\REVISAO.md; the Integradora, 19/10), as a family of the licensee rule
// (exposure.mjs): the messages of a problem are SSAM's prose wherever they sit. fitProblems (refusal-problems.mjs), the one
// grouping of every refusal, keeps under items[] the message and the fix of each member that differs from the group's first;
// items is also a key of the customer's records (DATA_KEYS), so a licensee got those members' messages whole: a server path,
// a kernel type and its source file ("at Anvil.Core.Kernel.Verbs.Apply in JobRunner.cs:line 12"). Inside a problem, items are
// SSAM's own problems and pass the rule of runtime prose like the group's first message; items anywhere else (a Portal or
// Service Center payload) stay the customer's records. The owner reads both whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exposedResult } from '../exposure.mjs';
import { fitProblems } from '../refusal-problems.mjs';

const roots = ['C:\\srv\\ssam\\.local'];
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const licensee = (tool, value, args = {}) => exposedResult(result(value), { exposure: 'licensee', handleRoots: roots, tool, args }).structuredContent;
const owner = (tool, value) => exposedResult(result(value), { exposure: 'owner', tool }).structuredContent;
const INTERNAL = /Anvil\.|\.cs\b|JobRunner|[A-Za-z]:\\|\/data\/|\/app\//;

const members = [
  { code: 'HTML_FILE_MISSING', severity: 'error', op: 1, pointer: '/ops/1', message: 'op #1 (html Home): cannot read C:\\srv\\ssam\\kernel\\tests\\html\\a.html', fix: 'pass the file' },
  { code: 'HTML_FILE_MISSING', severity: 'error', op: 2, pointer: '/ops/2',
    message: 'op #2 (html Other): cannot read C:\\srv\\ssam\\platforms\\odc\\x\\b.html at Anvil.Core.Kernel.Verbs.Apply in JobRunner.cs:line 12',
    fix: 'pass the file' },
];

test('the members of a grouped problem lose server paths, kernel types and source files like the group\'s first message', () => {
  const fitted = fitProblems(members, { alwaysGroup: true, budget: 100000 });
  const answer = { ok: false, code: 'KERNEL_REFUSED', ...fitted };
  const group = answer.problems[0];
  assert.equal(group.count, 2); assert.equal(group.items.length, 2);
  assert.match(group.items[1].message, /Anvil\.Core/, 'the fixture names a kernel type in the second member');
  for (const tool of ['ssam_job', 'o11_deliver', 'studio_deliver', 'ssam_reference']) {
    const args = tool === 'ssam_reference' ? { kind: 'check-job', query: { ops: [] } } : { job: { ops: [] } };
    const out = licensee(tool, answer, args);
    const said = tool + ': ' + JSON.stringify(out.problems).slice(0, 900);
    const items = out.problems[0].items;
    assert.equal(items.length, 2, said);
    assert.deepEqual(items.map(i => i.pointer), ['/ops/1', '/ops/2'], 'the pointers stay: ' + said);
    assert.doesNotMatch(JSON.stringify(out), INTERNAL, said);
    assert.match(items[1].message, /^op #2 \(html Other\): cannot read /, 'what went wrong stays: ' + said);
    assert.deepEqual(owner(tool, answer), answer, 'the owner reads it whole');
  }
});

test('items outside a problem are the customer\'s records, served as they are', () => {
  const records = { ok: true, items: [{ id: 'C:\\customer\\a.txt', name: 'Anvil.Core-like name', note: 'see JobRunner.cs' }], count: 1 };
  for (const tool of ['odc_portal_read', 'o11_service_center_read']) assert.deepEqual(licensee(tool, records), records, tool);
});
