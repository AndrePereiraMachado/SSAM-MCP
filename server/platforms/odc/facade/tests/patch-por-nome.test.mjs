// Lane "patch por nome" (2026-10-10): a correction by name instead of positions, or only the changed elements as a partial
// job over the earlier one, and every answer names the job it used ready for the next basedOn (nextBasedOn) with the
// patches of a refusal in both forms (patch by index, patchByName). The model wrote the whole 60 KB job again to fix one
// expression (~2.5 min a correction): these tests hold the shorter roads. Fakes and temporary folders only: no Studio, no
// CLI, no worker.
import { isolatedProfile } from './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
// Namespaces: at the base (before this lane) each test fails on its own rule, not at import.
import * as jobPatch from '../job-patch.mjs';
import * as jobRunner from '../job-runner.mjs';
import { compactDelivery } from '../responses.mjs';
import { registerSsamReference } from '../ssam-reference.mjs';
import { createSsamServer } from '../ssam.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { tempKernel, linked } from './fixtures/o11env-kernel.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const tmp = t => { const dir = fs.mkdtempSync(path.join(isolatedProfile, 'ppn-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const thrown = fn => { try { fn(); } catch (error) { return error; } assert.fail('expected a PatchError'); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// A job as the sessions write them: a spec, two logic ops (the actions split in two), raw verbs.
const JOB = { base: 'tests/fixtures/blank-service.oml', ops: [
  { op: 'spec', data: { entities: [{ name: 'Order', attributes: [{ name: 'Total', type: 'Decimal' }, { name: 'Code', type: 'Text' }] }] } },
  { op: 'logic', data: { actions: [
    { name: 'Order_Create', inputs: [{ name: 'Total', type: 'Decimal' }], steps: [{ assign: { 'Rec.Total': 'Total' }, as: 'AssignTotal' }, { save: 'Order', record: 'Rec', as: 'Save' }] },
    { name: 'OnReady', kind: 'screen', owner: 'Home', steps: [{ assign: { X: '1' }, as: 'Init' }] }] } },
  { op: 'logic', data: { actions: [
    { name: 'Order_Delete', steps: [{ delete: 'Order', id: 'OrderId', as: 'Del' }] },
    { name: 'OnReady', kind: 'screen', owner: 'Detail', steps: [{ assign: { Y: '2' }, as: 'Init' }] }] } },
  { op: 'create', parent: '@espace', type: 'ServerAction', name: 'Legacy', as: '$legacy' },
  { op: 'set', target: '$legacy', prop: 'Description', value: 'old' }] };

function jobFile(t, job = JOB) {
  const dir = tmp(t);
  const file = path.join(dir, 'job.json');
  fs.writeFileSync(file, JSON.stringify(job, null, 2));
  return { dir, file, sha: sha256(fs.readFileSync(file)), inlineDir: path.join(dir, 'inline') };
}

test('P1: a path names elements (name, as, key, id, label) and resolves to the numeric patch of always', () => {
  const byName = jobPatch.patchJob(JOB, [{ op: 'replace', path: '/ops/1/data/actions/Order_Create/steps/AssignTotal/assign/Rec.Total', value: 'Total * 2' },
    { op: 'replace', path: '/ops/0/data/entities/Order/attributes/Code/type', value: 'Long Text' },
    { op: 'replace', path: '/ops/Legacy/name', value: 'Legacy2' }]); // an op by its identity (name before as)
  const byIndex = jobPatch.applyJobPatch(JOB, [{ op: 'replace', path: '/ops/1/data/actions/0/steps/0/assign/Rec.Total', value: 'Total * 2' },
    { op: 'replace', path: '/ops/0/data/entities/0/attributes/1/type', value: 'Long Text' }, { op: 'replace', path: '/ops/3/name', value: 'Legacy2' }]);
  assert.deepEqual(byName.job, byIndex, 'the same job as the numeric patch');
  assert.deepEqual(byName.resolved.map(r => r.path), ['/ops/1/data/actions/0/steps/0/assign/Rec.Total', '/ops/0/data/entities/0/attributes/1/type', '/ops/3/name']);
  assert.equal(byName.named, true);
  // The step of a delete is named by its `as`, not by the expression in its `id`.
  assert.equal(jobPatch.applyJobPatch(JOB, [{ op: 'replace', path: '/ops/2/data/actions/Order_Delete/steps/Del/id', value: 'Id2' }]).ops[2].data.actions[0].steps[0].id, 'Id2');
  // Digits are always an index; the numeric patch of always is unchanged (named:false).
  assert.equal(jobPatch.patchJob(JOB, [{ op: 'replace', path: '/ops/4/value', value: 'new' }]).named, false);
});

test('P1: zero or several matches refuse the patch with the candidates', () => {
  const missing = thrown(() => jobPatch.applyJobPatch(JOB, [{ op: 'replace', path: '/ops/0/data/entities/Order/attributes/Nope/type', value: 'Text' }]));
  assert.equal(missing.code, 'PATCH_NAME_NOT_FOUND'); assert.equal(missing.at, 0);
  assert.deepEqual(missing.candidates, ['Total', 'Code']);
  const twice = thrown(() => jobPatch.applyJobPatch({ ops: [{ op: 'logic', data: { actions: [{ name: 'A', steps: [] }, { name: 'A', steps: [] }] } }] },
    [{ op: 'remove', path: '/ops/0/data/actions/A' }]));
  assert.equal(twice.code, 'PATCH_NAME_AMBIGUOUS');
  assert.deepEqual(twice.candidates, ['/ops/0/data/actions/0', '/ops/0/data/actions/1']);
  // add with the name of an existing element is refused (add inserts before an index); a new name is appended.
  assert.match(thrown(() => jobPatch.applyJobPatch(JOB, [{ op: 'add', path: '/ops/1/data/actions/Order_Create', value: { name: 'Order_Create' } }])).message, /exists/);
  const appended = jobPatch.applyJobPatch(JOB, [{ op: 'add', path: '/ops/1/data/actions/Order_Update', value: { name: 'Order_Update', steps: [] } }]);
  assert.equal(appended.ops[1].data.actions.at(-1).name, 'Order_Update');
  // The candidates reach the answer of a tool (resolvePatchedJob).
  const r = jobPatch.resolvePatchedJob({ patch: [{ op: 'replace', path: 'actions/Nope/name', value: 'x' }], basedOn: { job: 'C:\\none.json', sha256: 'ab'.repeat(32) } }, { inlineDir: os.tmpdir() });
  assert.equal(r.code, 'BASE_NOT_FOUND', 'the base is checked first');
});

test('P1: the shortcut without /ops/<i>/data finds the only element so named in every op holding that list', () => {
  const r = jobPatch.patchJob(JOB, [{ op: 'replace', path: 'actions/Order_Delete/steps/Del/id', value: 'Id3' },
    { op: 'replace', path: 'entities/Order/attributes/Total/type', value: 'Integer' }, { op: 'replace', path: '/actions/Order_Create/name', value: 'Order_New' }]);
  assert.deepEqual(r.resolved.map(x => x.path), ['/ops/2/data/actions/0/steps/0/id', '/ops/0/data/entities/0/attributes/0/type', '/ops/1/data/actions/0/name']);
  // Two ops hold actions: an index after the shortcut is ambiguous; a name found in both is too (screen actions of two screens).
  const index = thrown(() => jobPatch.applyJobPatch(JOB, [{ op: 'remove', path: 'actions/0' }]));
  assert.equal(index.code, 'PATCH_NAME_AMBIGUOUS'); assert.deepEqual(index.candidates, ['/ops/1/data/actions', '/ops/2/data/actions']);
  const screen = thrown(() => jobPatch.applyJobPatch(JOB, [{ op: 'remove', path: 'actions/OnReady' }]));
  assert.equal(screen.code, 'PATCH_NAME_AMBIGUOUS'); assert.deepEqual(screen.candidates, ['/ops/1/data/actions/1', '/ops/2/data/actions/1']);
  // One op holding the list: an index after the shortcut is fine; a new name is appended to the last op holding it.
  assert.equal(jobPatch.applyJobPatch(JOB, [{ op: 'replace', path: 'entities/0/name', value: 'Order2' }]).ops[0].data.entities[0].name, 'Order2');
  const added = jobPatch.applyJobPatch(JOB, [{ op: 'add', path: 'actions/Order_Update', value: { name: 'Order_Update', steps: [] } }]);
  assert.equal(added.ops[2].data.actions.at(-1).name, 'Order_Update');
  const absent = thrown(() => jobPatch.applyJobPatch(JOB, [{ op: 'replace', path: 'actions/Nope/name', value: 'x' }]));
  assert.equal(absent.code, 'PATCH_NAME_NOT_FOUND'); assert.deepEqual(absent.candidates, ['Order_Create', 'OnReady', 'Order_Delete']);
  // Not a list of the ops' data: still forbidden, as before.
  assert.equal(thrown(() => jobPatch.applyJobPatch(JOB, [{ op: 'replace', path: '/base', value: 'x' }])).code, 'PATCH_PATH_FORBIDDEN');
});

test('P2: a partial job replaces the elements with the same name, appends the new ones and adds new ops; removal only by patch', () => {
  const partial = { ops: [
    { op: 'logic', data: { actions: [
      { name: 'Order_Create', inputs: [], steps: [{ assign: { 'Rec.Total': '0' }, as: 'AssignTotal' }] },
      { name: 'OnReady', kind: 'screen', owner: 'Detail', steps: [] }, // the owner tells the two screen actions apart
      { name: 'Order_Update', steps: [] }] } },
    { op: 'spec', data: { structures: [{ name: 'OrderRow', attributes: [{ name: 'Id', type: 'Integer' }] }], entities: [{ name: 'Customer', attributes: [] }] } },
    { op: 'set', target: '$legacy', prop: 'Description', value: 'new' },
    { op: 'set', target: '$legacy', prop: 'Public', value: 'True' },
    { op: 'screen', data: { screens: [{ name: 'Orders' }] } }],
  expectedMessages: [{ id: 'UnusedUserAction', element: 'Order_Update', why: 'used by the next job' }] };
  const { job, summary } = jobPatch.mergePartialJob(JOB, partial);
  assert.equal(job.ops[1].data.actions[0].inputs.length, 0, 'Order_Create replaced in place');
  assert.deepEqual(job.ops[1].data.actions[1].steps, JOB.ops[1].data.actions[1].steps, 'the OnReady of Home stays');
  assert.deepEqual(job.ops[2].data.actions[1].steps, [], 'the OnReady of Detail replaced');
  assert.equal(job.ops[2].data.actions[2].name, 'Order_Update', 'a new action goes to the last logic op');
  assert.deepEqual(job.ops[0].data.structures.map(s => s.name), ['OrderRow']); assert.deepEqual(job.ops[0].data.entities.map(e => e.name), ['Order', 'Customer']);
  assert.equal(job.ops[4].value, 'new', 'a raw set with the same target and prop replaces it');
  assert.deepEqual(job.ops.slice(5).map(o => o.op + ':' + (o.prop ?? '')), ['set:Public', 'screen:'], 'new ops at the end');
  assert.deepEqual(job.expectedMessages, partial.expectedMessages);
  assert.equal(job.base, JOB.base);
  assert.equal(job.ops[2].data.actions[0].name, 'Order_Delete', 'nothing is removed');
  assert.deepEqual(summary, { replaced: ['/ops/1/data/actions/0', '/ops/2/data/actions/1', '/ops/4'],
    added: ['/ops/2/data/actions/2', '/ops/0/data/structures/0', '/ops/0/data/entities/1', '/expectedMessages/0'], ops: ['/ops/5', '/ops/6'] });
  assert.deepEqual(JOB.ops[1].data.actions[0].inputs.length, 1, 'the base given is never changed');
  // A spec no op of the base has goes before the first logic op; a reference after the last reference.
  const fresh = jobPatch.mergePartialJob({ ops: [{ op: 'reference', producer: 'Lib', elements: [] }, { op: 'logic', data: { actions: [] } }] },
    [{ op: 'spec', data: { entities: [{ name: 'E' }] } }, { op: 'reference', producer: 'Other', elements: ['IEntity:X'] }]);
  assert.deepEqual(fresh.job.ops.map(o => o.op + (o.producer ? ':' + o.producer : '')), ['reference:Lib', 'reference:Other', 'spec', 'logic']);
});

// The html op of a whole page has no parent: its screen is its identity. The FarmaVirtual session (2026-10-10) corrected its
// page op round after round; as a partial job, that op used to be appended as a SECOND html op of the same screen (the
// broken one stayed first and failed again): with vars it took the grammar route, whose context wants html, css and
// bindings equal to the base; without, the raw route, whose identity (parent) the page form does not have.
test('P2: an html page op is identified by its screen: a partial replaces its fields, vars by name, and never adds a second page', () => {
  const page = { op: 'html', data: { screen: 'Catalog', title: 'Catalog', layout: 'blank', html: '<div tabindex="0">old</div>', css: '.a{color:red}',
    vars: [{ name: 'Search', type: 'Text' }, { name: 'Page', type: 'Integer', default: '1' }], bindings: { 'c.go': { kind: 'call', action: 'Go' } } } };
  const base = { ops: [JOB.ops[0], page, { op: 'set', target: 'IMobileScreen:Catalog', prop: 'Description', value: 'x' }] };
  const htmlOps = job => job.ops.filter(o => o.op === 'html');
  // Only the html changed (no named list in the partial: the raw route used to append it).
  const onlyHtml = jobPatch.mergePartialJob(base, [{ op: 'html', data: { screen: 'Catalog', html: '<div>new</div>' } }]);
  assert.equal(htmlOps(onlyHtml.job).length, 1, 'one html op for the screen, not two');
  assert.equal(onlyHtml.job.ops[1].data.html, '<div>new</div>');
  assert.equal(onlyHtml.job.ops[1].data.css, page.data.css, 'a field the partial does not bring stays that of basedOn');
  assert.deepEqual(onlyHtml.job.ops[1].data.bindings, page.data.bindings);
  assert.deepEqual(onlyHtml.summary, { replaced: ['/ops/1'], added: [], ops: [] });
  // html, bindings and vars (the grammar route used to append it): vars merge by name, the other fields replace.
  const withVars = jobPatch.mergePartialJob(base, [{ op: 'html', data: { screen: 'catalog', html: '<button data-av="c.go">Go</button>',
    bindings: { 'c.go': { kind: 'call', action: 'Go2' } }, vars: [{ name: 'Page', type: 'Integer', default: '2' }, { name: 'Sort', type: 'Text' }] } }]);
  assert.equal(htmlOps(withVars.job).length, 1, 'the screen name matches without regard to case, as OutSystems names do');
  assert.deepEqual(withVars.job.ops[1].data.bindings, { 'c.go': { kind: 'call', action: 'Go2' } });
  assert.deepEqual(withVars.job.ops[1].data.vars.map(v => v.name + '=' + (v.default ?? '')), ['Search=', 'Page=2', 'Sort=']);
  assert.equal(withVars.job.ops[1].data.screen, 'Catalog', 'the screen keeps the name basedOn gave it');
  assert.deepEqual(withVars.summary, { replaced: ['/ops/1', '/ops/1/data/vars/1'], added: ['/ops/1/data/vars/2'], ops: [] });
  assert.equal(page.data.html, '<div tabindex="0">old</div>', 'the base given is never changed');
  // Another screen is a new page; the same page twice in the partial is refused; two pages of one screen in basedOn too.
  assert.equal(htmlOps(jobPatch.mergePartialJob(base, [{ op: 'html', data: { screen: 'Detail', html: '<div>d</div>', bindings: {} } }]).job).length, 2);
  assert.equal(thrown(() => jobPatch.mergePartialJob(base, [{ op: 'html', data: { screen: 'Catalog', html: 'a' } }, { op: 'html', data: { screen: 'Catalog', css: 'b' } }])).code, 'PARTIAL_AMBIGUOUS');
  const twoPages = { ops: [page, structuredClone(page)] };
  const ambiguous = thrown(() => jobPatch.mergePartialJob(twoPages, [{ op: 'html', data: { screen: 'Catalog', html: 'a' } }]));
  assert.equal(ambiguous.code, 'PARTIAL_AMBIGUOUS'); assert.deepEqual(ambiguous.candidates, ['/ops/0', '/ops/1']);
  // The fragment form keeps its identity (parent).
  const fragment = jobPatch.mergePartialJob({ ops: [{ op: 'html', parent: '$home', html: '<p>a</p>' }] }, [{ op: 'html', parent: '$home', html: '<p>b</p>' }]);
  assert.deepEqual(fragment.job.ops, [{ op: 'html', parent: '$home', html: '<p>b</p>' }]);
});

test('B1: an html op in the document form is identified by the name of its <screen> or <block>: a partial replaces it', () => {
  const doc = name => ({ op: 'html', data: { html: `<!-- page -->\n<screen name="${name}" roles="Registered">\n<var name="Busca" type="Text"/>\n</screen>` } });
  const base = { ops: [doc('Pedidos'), { op: 'logic', data: { actions: [{ name: 'Buscar', kind: 'screen', owner: 'IMobileScreen:Pedidos', steps: [] }] } }] };
  const fixed = { op: 'html', data: { html: '<screen name="pedidos" roles="Registered">\n<var name="Busca" type="Text"/>\n<var name="Total" type="Integer"/>\n</screen>' } };
  const merged = jobPatch.mergePartialJob(base, [fixed]);
  assert.equal(merged.job.ops.filter(o => o.op === 'html').length, 1, 'the corrected document replaces the one of basedOn (the name without regard to case)');
  assert.equal(merged.job.ops[0].data.html, fixed.data.html);
  assert.deepEqual(merged.summary, { replaced: ['/ops/0'], added: [], ops: [] });
  // Another root is a new document; a block too.
  assert.equal(jobPatch.mergePartialJob(base, [doc('Detalhe')]).job.ops.filter(o => o.op === 'html').length, 2);
  const block = { op: 'html', data: { html: "<block name='Cartao'></block>" } };
  assert.equal(jobPatch.mergePartialJob({ ops: [block] }, [{ op: 'html', data: { html: "<block name='Cartao'><var name='X' type='Text'/></block>" } }]).job.ops.length, 1);
});

test('P2: what a partial job cannot merge by name is refused with the candidates, before anything runs', () => {
  const twoOrders = { ops: [{ op: 'logic', data: { actions: [{ name: 'A' }] } }, { op: 'logic', data: { actions: [{ name: 'A' }] } }] };
  const ambiguous = thrown(() => jobPatch.mergePartialJob(twoOrders, [{ op: 'logic', data: { actions: [{ name: 'A', steps: [] }] } }]));
  assert.equal(ambiguous.code, 'PARTIAL_AMBIGUOUS'); assert.deepEqual(ambiguous.candidates, ['/ops/0/data/actions/0', '/ops/1/data/actions/0']);
  assert.equal(thrown(() => jobPatch.mergePartialJob(JOB, [{ op: 'logic', data: { actions: [{ steps: [] }] } }])).code, 'PARTIAL_UNNAMED');
  assert.equal(thrown(() => jobPatch.mergePartialJob(JOB, { base: 'other.oml', ops: [{ op: 'get', target: 'X' }] })).code, 'PARTIAL_INVALID');
  assert.equal(thrown(() => jobPatch.mergePartialJob(JOB, { jobs: ['job:a'] })).code, 'PARTIAL_INVALID');
  assert.equal(thrown(() => jobPatch.mergePartialJob(JOB, { ops: [] })).code, 'PARTIAL_INVALID');
  assert.equal(thrown(() => jobPatch.mergePartialJob(JOB, [{ op: 'logic', data: { actions: [{ name: 'Z' }] } }, { op: 'logic', data: { actions: [{ name: 'Z' }] } }])).code, 'PARTIAL_AMBIGUOUS');
  assert.equal(thrown(() => jobPatch.mergePartialJob(JOB.ops, { ops: [{ op: 'get' }], expectedMessages: [{ id: 'X' }] })).code, 'PARTIAL_INVALID');
});

test('P2/P3: partial job + patch over basedOn: one new file, its sha256 the next basedOn, chained; the base never changes', t => {
  const s = jobFile(t);
  let n = 0; const uuid = () => 'p-' + (++n);
  const options = { inlineDir: s.inlineDir, uuid, journalDir: path.join(s.dir, 'journal'), tool: 'o11_deliver' };
  const first = jobPatch.resolvePatchedJob({ job: { ops: [{ op: 'logic', data: { actions: [{ name: 'Order_Update', steps: [] }] } }] },
    patch: [{ op: 'remove', path: 'actions/Order_Delete' }], basedOn: { job: s.file, sha256: s.sha } }, options);
  assert.equal(first.ok, true, JSON.stringify(first));
  const merged = readJson(first.path);
  assert.deepEqual(merged.ops[2].data.actions.map(a => a.name), ['OnReady', 'Order_Update'], 'merged, then the patch removed Order_Delete');
  assert.equal(first.sha256, sha256(fs.readFileSync(first.path)));
  assert.deepEqual(first.partial, { replaced: 0, added: 1, newOps: 0, addedAt: ['/ops/2/data/actions/2'] });
  // Chained: the answer's sha256 is the next basedOn (a partial job as text, by name).
  const second = jobPatch.resolvePatchedJob({ job: JSON.stringify([{ op: 'set', target: '$legacy', prop: 'Description', value: 'v2' }]), basedOn: { job: first.path, sha256: first.sha256 } }, options);
  assert.equal(second.ok, true, JSON.stringify(second)); assert.equal(readJson(second.path).ops[4].value, 'v2');
  // The first file changed after its answer: refused, nothing written.
  fs.appendFileSync(first.path, ' ');
  assert.equal(jobPatch.resolvePatchedJob({ patch: [{ op: 'remove', path: '/ops/4' }], basedOn: { job: first.path, sha256: first.sha256 } }, options).code, 'BASE_CHANGED');
  assert.equal(fs.readFileSync(s.file, 'utf8'), JSON.stringify(JOB, null, 2), 'the base is intact');
  const lines = fs.readFileSync(path.join(s.dir, 'journal', 'job-patch.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.event), ['partial', 'partial']);
  assert.deepEqual(lines[0].resolved, ['/ops/2/data/actions/0'], 'the numeric patch a name resolved to');
  // A partial job in a file, and errors of the partial come back as values.
  const file = path.join(s.dir, 'partial.json'); fs.writeFileSync(file, JSON.stringify({ ops: [{ op: 'logic', data: { actions: [{ steps: [] }] } }] }));
  assert.equal(jobPatch.resolvePatchedJob({ job: file, basedOn: { job: s.file, sha256: s.sha } }, options).code, 'PARTIAL_UNNAMED');
  const missing = jobPatch.resolvePatchedJob({ patch: [{ op: 'replace', path: 'actions/Nope/name', value: 'x' }], basedOn: { job: s.file, sha256: s.sha } }, options);
  assert.deepEqual([missing.code, missing.at, missing.candidates], ['PATCH_NAME_NOT_FOUND', 0, ['Order_Create', 'OnReady', 'Order_Delete']]);
});

test('P3: a refusal gives each patch by index and by name; both apply with patch + basedOn to the same job', t => {
  const s = jobFile(t);
  const problems = [
    { phase: 'preflight', op: 1, pointer: '/ops/1/data/actions/0/steps/0/assign/Rec.Total', code: 'EXPR_UNKNOWN_IDENTIFIER', severity: 'error', message: 'x', fix: 'y',
      patch: [{ op: 'replace', path: '/ops/1/data/actions/0/steps/0/assign/Rec.Total', value: 'Total + 0' }] },
    { phase: 'preflight', op: 0, pointer: '/ops/0/data/entities/0/attributes/1/type', code: 'SPEC_INVALID', severity: 'error', message: 'x', fix: 'y',
      patch: [{ op: 'replace', path: '/ops/0/data/entities/0/attributes/1/type', value: 'Text' }] },
    { phase: 'verify', op: 1, pointer: '/ops/1/data/actions/1/steps/0', code: 'UnusedElement', severity: 'error', message: 'x', fix: 'y',
      patch: [{ op: 'replace', path: '/ops/1/data/actions/1/steps/0/assign/X', value: '2' }] }, // OnReady is in two ops: no shortcut, named inside its op
    { phase: 'apply', op: 4, pointer: '/ops/4/value', code: 'X', severity: 'error', message: 'x', fix: 'y', patch: [{ op: 'replace', path: '/ops/4/value', value: 'z' }] },
    { phase: 'apply', op: 0, pointer: '/ops/0', code: 'NO_PATCH', severity: 'error', message: 'x', fix: 'y' }];
  const value = jobPatch.withNamedPatches({ ok: false, code: 'PREFLIGHT_REFUSED', problems, job: s.file, jobSha256: s.sha }, s.file);
  assert.deepEqual(value.problems.map(p => p.patchByName?.[0].path ?? null),
    ['actions/Order_Create/steps/AssignTotal/assign/Rec.Total', 'entities/Order/attributes/Code/type', '/ops/1/data/actions/OnReady/steps/Init/assign/X', null, null]);
  assert.deepEqual(value.problems[0].patch, problems[0].patch, 'the numeric patch stays as the kernel gave it');
  const all = form => value.problems.flatMap(p => (form === 'name' ? p.patchByName ?? p.patch : p.patch) ?? []);
  const options = { inlineDir: s.inlineDir };
  const byIndex = jobPatch.resolvePatchedJob({ patch: all('index'), basedOn: { job: s.file, sha256: s.sha } }, { ...options, uuid: () => 'by-index' });
  const byName = jobPatch.resolvePatchedJob({ patch: all('name'), basedOn: { job: s.file, sha256: s.sha } }, { ...options, uuid: () => 'by-name' });
  assert.equal(byName.ok, true, JSON.stringify(byName));
  assert.equal(byName.sha256, byIndex.sha256, 'the same job, byte for byte');
  // Within the room left under the answer ceiling; the rest keep the numeric patch only.
  const tight = jobPatch.withNamedPatches({ ok: false, problems }, s.file, { ceiling: JSON.stringify({ ok: false, problems }).length + 150 });
  assert.equal(tight.problems.filter(p => p.patchByName).length, 1); assert.equal(tight.patchByNameOmitted, 2);
  // Nothing to name, or no job to read: the same value.
  const plain = { ok: false, problems: [problems[3]] };
  assert.equal(jobPatch.withNamedPatches(plain, s.file), plain);
  assert.equal(jobPatch.withNamedPatches(value, path.join(s.dir, 'none.json')), value);
  // The ODC refusal keeps its problems under refusal.
  assert.ok(jobPatch.withNamedPatches({ ok: false, refusal: { problems } }, s.file).refusal.problems[0].patchByName);
});

test('P3: jobIdentity answers nextBasedOn ready for basedOn', t => {
  const s = jobFile(t);
  assert.deepEqual(jobPatch.jobIdentity(s.file).nextBasedOn, { job: s.file, sha256: s.sha });
  assert.deepEqual(jobPatch.nextBasedOnOf(s.file, s.sha.toUpperCase()), { nextBasedOn: { job: s.file, sha256: s.sha } });
  assert.deepEqual(jobPatch.nextBasedOnOf(null, s.sha), {});
});

// ---- the tools
function kernelRoot(t) {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'tests', 'jobs'), { recursive: true });
  const job = path.join(root, 'tests', 'jobs', 'orders.json');
  fs.writeFileSync(job, JSON.stringify(JOB, null, 2));
  const auth = path.join(root, 'auth'); fs.mkdirSync(auth);
  const env = { USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root, ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  let clock = 1000;
  return { root, job, sha: sha256(fs.readFileSync(job)), local: path.join(root, '.local'), deps: extra => ({ root, env, o11Lane: 'ss4', now: () => (clock += 10), ...extra }) };
}
const accepted = { ok: true, command: 'apply', data: { accepted: true, isValid: true, ops: 5, objects: 9 } };
const refusedWith = problems => ({ exitCode: 1, envelope: { ok: false, command: 'apply', code: 'PREFLIGHT_REFUSED', error: 'op #1 (logic) [EXPR_UNKNOWN_IDENTIFIER]: x', problems, verifyRan: true, phases: ['preflight'] } });
const PROBLEM = { phase: 'preflight', op: 1, pointer: '/ops/1/data/actions/0/steps/0/assign/Rec.Total', code: 'EXPR_UNKNOWN_IDENTIFIER', severity: 'error', message: "can't identify 'Totl'", fix: 'write Total',
  patch: [{ op: 'replace', path: '/ops/1/data/actions/0/steps/0/assign/Rec.Total', value: 'Total' }] };

test('ssam_job/o11_job: a partial job + basedOn runs the whole job; every answer names nextBasedOn; a refusal patchByName', async t => {
  const k = kernelRoot(t);
  const runAnvil = fakeAnvil({ apply: () => accepted });
  let n = 0;
  const ok = await jobRunner.jobTool({ job: { ops: [{ op: 'logic', data: { actions: [{ name: 'Order_Update', steps: [] }] } }] }, basedOn: { job: k.job, sha256: k.sha } },
    k.deps({ runAnvil, uuid: () => 'partial-' + (++n) }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const file = path.join(k.local, 'jobs', 'inline', 'partial-1.json');
  assert.equal(runAnvil.calls[0].args[2], file, 'the kernel gets the whole job');
  assert.equal(readJson(file).ops[2].data.actions.at(-1).name, 'Order_Update');
  assert.deepEqual(ok.nextBasedOn, { job: file, sha256: sha256(fs.readFileSync(file)) });
  assert.deepEqual(ok.partial, { replaced: 0, added: 1, newOps: 0, addedAt: ['/ops/2/data/actions/2'] });
  // A refusal: the job, nextBasedOn and each patch also by name; the by-name patch applies with that basedOn.
  const refuses = fakeAnvil({ apply: () => refusedWith([PROBLEM]) });
  const refused = await jobRunner.jobTool({ job: k.job }, k.deps({ runAnvil: refuses, guidance: async (lane, job, result) => result }));
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.nextBasedOn, { job: k.job, sha256: k.sha });
  assert.deepEqual(refused.problems[0].patchByName, [{ op: 'replace', path: 'actions/Order_Create/steps/AssignTotal/assign/Rec.Total', value: 'Total' }]);
  const fixed = await jobRunner.jobTool({ patch: refused.problems[0].patchByName, basedOn: refused.nextBasedOn }, k.deps({ runAnvil, uuid: () => 'fixed' }));
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.equal(readJson(fixed.job).ops[1].data.actions[0].steps[0].assign['Rec.Total'], 'Total');
  // Name errors come back before anything runs, with the candidates.
  const bad = await jobRunner.jobTool({ patch: [{ op: 'remove', path: 'actions/Nope' }], basedOn: { job: k.job, sha256: k.sha } }, k.deps({ runAnvil }));
  assert.deepEqual([bad.code, bad.candidates], ['PATCH_NAME_NOT_FOUND', ['Order_Create', 'OnReady', 'Order_Delete']]);
  assert.equal(runAnvil.calls.length, 2);
});

test('ssam_reference check-job: {basedOn, patch by name | partial job}; the answer names the job checked and nextBasedOn', async t => {
  const kernel = tempKernel({ cli: true });
  const s = jobFile(t);
  const run = fakeAnvil({ apply: () => refusedWith([PROBLEM]) });
  let n = 0;
  const mcp = await linked(registerSsamReference, { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, uuid: () => `chk-${++n}` });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  const refused = await mcp.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: { basedOn: { job: s.file, sha256: s.sha }, patch: [{ op: 'replace', path: 'entities/Order/attributes/Code/type', value: 'Text' }] } });
  assert.equal(refused.code, 'JOB_INVALID', JSON.stringify(refused));
  const checked = run.calls[0].args[run.calls[0].args.indexOf('--job') + 1];
  assert.equal(readJson(checked).ops[0].data.entities[0].attributes[1].type, 'Text');
  assert.deepEqual(refused.nextBasedOn, { job: checked, sha256: sha256(fs.readFileSync(checked)) }); assert.equal(refused.jobSha256, refused.nextBasedOn.sha256);
  assert.equal(refused.problems[0].patchByName[0].path, 'actions/Order_Create/steps/AssignTotal/assign/Rec.Total');
  // A partial job, and a name that does not resolve (refused with its candidates, nothing run).
  const partial = await mcp.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: { basedOn: { job: s.file, sha256: s.sha }, job: [{ op: 'set', target: '$legacy', prop: 'Description', value: 'n' }] } });
  assert.deepEqual(partial.partial, { replaced: 1, added: 0, newOps: 0, replacedAt: ['/ops/4'] });
  const wrong = await mcp.call('ssam_reference', { lane: 'o11', kind: 'check-job', query: { basedOn: { job: s.file, sha256: s.sha }, patch: [{ op: 'remove', path: 'actions/Nope' }] } });
  assert.equal(wrong.code, 'PATCH_NAME_NOT_FOUND'); assert.deepEqual(wrong.candidates, ['Order_Create', 'OnReady', 'Order_Delete']);
  assert.equal(run.calls.length, 2);
});

async function connect(server) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ppn-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

test('o11_deliver: a partial job + basedOn delivers the whole job; success and refusal name nextBasedOn; patchByName applies', async t => {
  const root = tmp(t);
  const s = jobFile(t);
  const replies = [{ ok: true, command: 'deliver', data: { delivered: true, taskId: 't1', writeState: 'applied' } },
    { ok: false, command: 'deliver', code: 'PREFLIGHT_REFUSED', error: 'op #1 (logic) [EXPR_UNKNOWN_IDENTIFIER]: x', problems: [PROBLEM], verifyRan: true, phases: ['preflight'] }];
  const runAnvil = fakeAnvil({ deliver: () => replies.shift() });
  const server = await createSsamServer({ odc: false, deps: { cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil, assertSelected: async () => {}, tasksDir: path.join(root, 'tasks') },
    lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const client = await connect(server);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async args => { const r = await client.callTool({ name: 'o11_deliver', arguments: { module: 'Orders_CS', authorize: 'pode entregar', ...args } }); return JSON.parse(r.content[0].text); };
  const delivered = await call({ job: { ops: [{ op: 'logic', data: { actions: [{ name: 'Order_Create', steps: [] }] } }] }, basedOn: { job: s.file, sha256: s.sha } });
  assert.equal(delivered.result, 'delivered', JSON.stringify(delivered));
  const sent = runAnvil.calls[0].args[runAnvil.calls[0].args.indexOf('--job') + 1];
  assert.deepEqual(readJson(sent).ops[1].data.actions[0].steps, [], 'the whole job with Order_Create replaced');
  assert.deepEqual(delivered.nextBasedOn, { job: sent, sha256: sha256(fs.readFileSync(sent)) });
  assert.equal(delivered.partial.replaced, 1);
  const refused = await call({ job: s.file });
  assert.equal(refused.code, 'PREFLIGHT_REFUSED');
  assert.deepEqual(refused.nextBasedOn, { job: s.file, sha256: s.sha });
  assert.equal(refused.problems[0].patchByName[0].path, 'actions/Order_Create/steps/AssignTotal/assign/Rec.Total');
});

test('studio_deliver through ssam: a partial job + basedOn reaches the ODC server whole; success keeps nextBasedOn; a refusal patchByName', async t => {
  const odcRoot = tmp(t);
  const s = jobFile(t);
  const seen = []; const replies = [];
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_deliver', { title: 'Deliver', description: 'Fake ODC delivery.', inputSchema: z.object({ feature: z.string().min(1), module: z.string().optional(),
      job: z.string().optional(), owners: z.array(z.string()).optional(), changes: z.array(z.string()).optional() }).strict() }, async args => {
      seen.push({ args, job: args.job ? readJson(args.job) : null });
      const value = replies.shift();
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) };
    });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot, lock: { o11Root: odcRoot, odcRoot, connection: () => null } } });
  const client = await connect(server);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async args => { const r = await client.callTool({ name: 'studio_deliver', arguments: { feature: 'F', module: 'Orders', owners: ['Order'], changes: ['c'], ...args } });
    return r.structuredContent ?? JSON.parse(r.content[0].text); };
  const tool = (await client.listTools()).tools.find(x => x.name === 'studio_deliver');
  assert.match(tool.description, /partial job/); assert.match(tool.inputSchema.properties.patch.description, /actions\/<Action>\/steps\/<as>/);
  replies.push({ ok: true, merged: true, strictlyEqual: true });
  const done = await call({ job: [{ op: 'set', target: '$legacy', prop: 'Description', value: 'odc' }], basedOn: { job: s.file, sha256: s.sha } });
  assert.equal(done.result, 'delivered', JSON.stringify(done));
  assert.equal(seen[0].job.ops[4].value, 'odc'); assert.equal(seen[0].job.ops.length, JOB.ops.length);
  assert.deepEqual(done.nextBasedOn, { job: seen[0].args.job, sha256: sha256(fs.readFileSync(seen[0].args.job)) });
  assert.equal(done.partial.replaced, 1);
  replies.push({ ok: false, code: 'PREFLIGHT_REFUSED', error: 'every phase', problems: [PROBLEM], verifyRan: true });
  const refused = await call({ job: s.file });
  assert.deepEqual(refused.nextBasedOn, { job: s.file, sha256: s.sha });
  assert.equal(refused.problems[0].patchByName[0].path, 'actions/Order_Create/steps/AssignTotal/assign/Rec.Total');
  // compactDelivery keeps them (a success keeps only what the next call needs).
  assert.deepEqual(compactDelivery('studio_deliver', {}, { ok: true, merged: true, strictlyEqual: true, nextBasedOn: { job: 'j', sha256: 'h' }, steps: [1] }),
    { ok: true, result: 'delivered', nextBasedOn: { job: 'j', sha256: 'h' } });
});
