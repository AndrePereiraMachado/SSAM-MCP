// Round 7 of fix/data-table (M1 of the review of round 6): the receipt of an import says what the kernel did. Every top-level key the
// kernel writes in report.prototype (read here from its own sources, so a new key is caught the day it is written) is copied by
// prototypeReceipt or dropped on purpose (RECEIPT_DROPPED of prototype-op.mjs, each with why); nothing is left out in silence. The
// theme block of F1 (nativeLayout) reaches the agent whole, the lists are cut with their totals, and the answer of the job still
// fits its budget with the receipt recovered exactly.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as op from '../prototype-op.mjs';
import { fitAnswer, ANSWER_BUDGETS } from '../answer-size.mjs';
import { kernelReport } from './fixtures/prototype-surface/fakes.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const kernel = path.join(root, 'kernel', 'src', 'Anvil.Core', 'Kernel');
const read = file => fs.readFileSync(path.join(kernel, file), 'utf8');
const ascii = /^[\x20-\x7E]+$/;

// The top-level keys of report.prototype as the kernel writes them: the plan's report (PrototypePlan.Report: _plan.Report,
// plan.Report, PlanResult.Report in every Prototype/*.cs and in Verbs.Prototype.cs), ReportAll's r[...] in PrototypeExpander.cs less
// what it removes, and the op's report[...] in Verbs.Prototype.cs (report = plan.Report there).
function emittedKeys() {
  const keys = new Set();
  const add = (text, pattern) => { for (const m of text.matchAll(pattern)) keys.add(m[1]); };
  const prototype = fs.readdirSync(path.join(kernel, 'Prototype')).filter(f => f.endsWith('.cs'));
  for (const file of prototype) add(read(path.join('Prototype', file)), /\b(?:_plan|[Pp]lan|PlanResult)\.Report\["(\w+)"\]\s*(?:\?\?)?=(?!=)/g);
  const expander = read(path.join('Prototype', 'PrototypeExpander.cs'));
  const reportAll = expander.slice(expander.indexOf('private void ReportAll()'));
  add(reportAll, /\br\["(\w+)"\]\s*=(?!=)/g);
  for (const m of reportAll.matchAll(/\br\.Remove\("(\w+)"\)/g)) keys.delete(m[1]);
  const verb = read('Verbs.Prototype.cs');
  add(verb, /\b(?:_plan|[Pp]lan|PlanResult)\.Report\["(\w+)"\]\s*(?:\?\?)?=(?!=)/g);
  add(verb, /\breport\["(\w+)"\]\s*=(?!=)/g);
  return keys;
}

// A report with every key the kernel writes: the fake of the surface lane, the round 6 block, and a probe for the rest.
function fullReport(keys) {
  const base = kernelReport();
  const nativeLayout = { code: 'THEME_NATIVE_LAYOUT', theme: 'FarmaVirtualTheme', version: '3', action: 'added',
    note: 'the theme of the import carries the native layout block of the html op after the prototype\'s CSS',
    lists: { code: 'LIST_RENDERS_ALL_ROWS', element: 'List', count: 1, keys: ['v:pedidos/0/2'], note: 'disable-virtualization = True and data-ssam-rows' } };
  const samples = {
    nativeLayout, noChange: true, code: 'NO_CHANGE', logic: { serverActions: 6, sql: 4, screenActions: 40 },
    renamed: [{ kind: 'screen', name: 'FarmaVirtualCarrinho', renamedFrom: 'Carrinho', why: 'a screen Carrinho without the mark exists' }],
    removed: Array.from({ length: 25 }, (_, i) => ({ kind: 'screen', name: 'Old' + i })),
    kept: [{ kind: 'screen', name: 'Relatorio', consumers: ['Haiku_UI (ESpace) / Home (Screen)'] }],
    unevaluableFilters: [{ k: 'v:catalogo/0/1', why: 'a filter over a computed field' }], iconClassesWithoutRule: ['ssam-icon-x'],
    runtime: [{ what: 'setInterval(tick, 1000)', where: 'app.js:12', native: 'no client timer without JavaScript' }],
  };
  return { ...base, ...Object.fromEntries([...keys].filter(k => !Object.hasOwn(base, k)).map(k => [k, Object.hasOwn(samples, k) ? samples[k] : [{ probe: k }]])),
    ...Object.fromEntries(Object.entries(samples).filter(([k]) => keys.has(k))) };
}

test('every key the kernel writes in report.prototype is copied into the receipt or dropped on purpose with why, never left out in silence', () => {
  const keys = emittedKeys();
  for (const key of ['schema', 'screens', 'degraded', 'counts', 'timings', 'nativeLayout', 'removed', 'kept', 'renamed', 'noChange', 'samples', 'runtime'])
    assert.ok(keys.has(key), 'the scan of the kernel sources finds ' + key + ' (found: ' + [...keys].join(', ') + ')');
  const dropped = op.RECEIPT_DROPPED ?? {};
  const receipt = op.prototypeReceipt(fullReport(keys), {});
  const silent = [...keys].filter(k => !Object.hasOwn(receipt, k) && !Object.hasOwn(dropped, k)).sort();
  assert.deepEqual(silent, [], 'kernel keys the receipt drops in silence: ' + silent.join(', '));
  for (const [key, why] of Object.entries(dropped)) {
    assert.ok(keys.has(key), `RECEIPT_DROPPED names ${key}, a key the kernel no longer writes`);
    assert.ok(!Object.hasOwn(receipt, key), `${key} is both copied and dropped`);
    assert.match(why, ascii, `the reason for ${key} is English text`);
  }
});

test('the receipt says what the import did beyond the counts: the theme block of F1 whole, renames, removals, kept elements, a no-change import, what it could not compile; lists cut with their totals', () => {
  const keys = emittedKeys();
  const report = fullReport(keys);
  const receipt = op.prototypeReceipt(report, {});
  assert.deepEqual(receipt.nativeLayout, report.nativeLayout, 'the block the kernel wrote in the theme and the Lists it lays out');
  assert.deepEqual(receipt.renamed, report.renamed);
  assert.equal(receipt.removed.length, 20); assert.equal(receipt.removedTotal, 25); assert.deepEqual(receipt.removed[0], report.removed[0]);
  assert.deepEqual(receipt.kept, report.kept);
  assert.equal(receipt.noChange, true); assert.equal(receipt.code, 'NO_CHANGE');
  assert.deepEqual(receipt.unevaluableFilters, report.unevaluableFilters); assert.deepEqual(receipt.iconClassesWithoutRule, report.iconClassesWithoutRule);
  assert.deepEqual(receipt.runtime, report.runtime);
  // the kernel counts the SQL queries in logic, not in data: the receipt no longer says 0
  const { sql, ...data } = report.data;
  assert.equal(op.prototypeReceipt({ ...report, data }, {}).data.sql, 4);
  // an import with none of these keeps the receipt it had: no new key appears
  const plain = op.prototypeReceipt(kernelReport(), {});
  for (const key of ['nativeLayout', 'renamed', 'removed', 'removedTotal', 'kept', 'noChange', 'code', 'unevaluableFilters', 'iconClassesWithoutRule', 'runtime'])
    assert.ok(!Object.hasOwn(plain, key), key);
});

test('a job answer with the theme block of F1 in its receipt fits the receipt budget, and the receipt is recovered exactly with nativeLayout', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-receipt-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const report = fullReport(emittedKeys());
  const receipt = op.prototypeReceipt(report, {});
  const full = { ok: true, lane: 'o11', job: 'C:\\jobs\\job.json', accepted: true, isValid: true, prototype: receipt };
  const fitted = fitAnswer('o11_job', {}, full, { root: dir });
  assert.ok(Buffer.byteLength(JSON.stringify(fitted), 'utf8') <= ANSWER_BUDGETS.receipt, JSON.stringify(fitted).length + ' bytes');
  const calls = [fitted.omitted, ...(fitted.omitted?.more ?? [])].filter(Boolean);
  const call = calls.find(c => c.arguments.pointer === '/prototype' || c.arguments.pointer === '/prototype/nativeLayout');
  assert.ok(call, 'one call recovers the receipt: ' + JSON.stringify(calls.map(c => c.arguments.pointer)));
  const kept = JSON.parse(fs.readFileSync(call.arguments.file, 'utf8'));
  assert.deepEqual(kept.prototype.nativeLayout, report.nativeLayout);
});
