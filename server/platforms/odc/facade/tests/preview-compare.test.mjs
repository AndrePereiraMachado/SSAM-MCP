import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareObservations, compareBrowserPages, observePage } from '../preview/compare.mjs';
import { registerPreviewTools } from '../preview/mcp.mjs';

const item = text => ({ text, rect: [10, 20, 30, 40], display: 'block', visibility: 'visible', font: '14px Arial',
  padding: '0px', margin: '0px', color: 'black', background: 'white', whiteSpace: 'normal', disabled: false, checked: null, value: null });
const snapshot = () => ({ schema: 'ssam-browser-observation/1', scenario: 'catalog', locale: 'pt-BR', timezone: 'America/Sao_Paulo',
  viewport: [1440, 900, 1], fonts: 'loaded', overflow: false, items: { rows: [item('Equipment 1')], counter: [item('1–25')] } });
test('equal observations pass and geometric shifts fail', () => {
  const a = snapshot(), b = snapshot();
  assert.equal(compareObservations(a, b).passed, true);
  b.items.rows[0].rect[0] += 2;
  assert.equal(compareObservations(a, b).passed, false);
  assert.equal(compareObservations(a, b, { tolerance: 2 }).passed, true);
});
for (const property of ['text', 'font', 'whiteSpace', 'disabled', 'checked', 'value', 'focused', 'containsFocus', 'required', 'valid', 'role', 'ariaExpanded', 'ariaSelected']) test(`detects ${property} regression`, () => {
  const a = snapshot(), b = snapshot(); b.items.rows[0][property] = 'changed';
  assert.ok(compareObservations(a, b).differences.some(d => d.property === property));
});
for (const property of ['scenario', 'locale', 'timezone', 'viewport', 'fonts']) test(`does not approve mismatched ${property}`, () => {
  const a = snapshot(), b = snapshot(); b[property] = property === 'viewport' ? [1280, 720, 1] : 'different';
  assert.equal(compareObservations(a, b).passed, false);
});
test('missing selectors cannot produce a vacuous pass', () => {
  const a = snapshot(), b = snapshot(); a.items.rows = []; b.items.rows = [];
  assert.equal(compareObservations(a, b).passed, false);
});
test('empty tables pass only with an explicit zero-row expectation', () => {
  const a=snapshot(), b=snapshot(); a.items.rows=[]; b.items.rows=[];
  assert.equal(compareObservations(a,b,{selectors:[{key:'rows',count:0}]}).passed,true);
  b.items.rows=[item('unexpected')];
  assert.equal(compareObservations(a,b,{selectors:[{key:'rows',count:0}]}).passed,false);
});
test('expected page records are checked, not just different page text', () => {
  const a=snapshot(), b=snapshot(); b.items.rows[0].text='wrong record'; b.items.counter[0].text='26–50';
  assert.equal(compareObservations(a,b,{relation:'pagination',rowKey:'rows',counterKey:'counter',selectors:[{key:'rows',expected:{candidate:['Equipment 26']}}]}).passed,false);
});

test('duplicate popup or upload controls cannot pass by matching their first element', () => {
  const a = snapshot(), b = snapshot(); b.items.rows.push(item('Equipment 1'));
  assert.ok(compareObservations(a, b).differences.some(d => d.property === 'count'));
});

test('overflow and hidden-panel geometry are checked', () => {
  const a = snapshot(), b = snapshot(); b.overflow = true; b.items.rows[0].rect[3] += 80;
  const result = compareObservations(a, b);
  assert.ok(result.differences.some(d => d.property === 'overflow'));
  assert.ok(result.differences.some(d => d.property === 'rect'));
});

test('a second timezone conversion is detected in displayed dates', () => {
  const a = snapshot(), b = snapshot(); a.items.rows[0].text = '23/10/2026 12:00'; b.items.rows[0].text = '23/10/2026 09:00';
  assert.equal(compareObservations(a, b).passed, false);
});

test('invalid measurements or empty observations fail closed', () => {
  const a = snapshot(), b = snapshot(); b.items.rows[0].rect[0] = NaN;
  assert.throws(() => compareObservations(a, b), { code: 'PREVIEW_COMPARISON_OBSERVATION_INVALID' });
  b.items = {};
  assert.throws(() => compareObservations(a, b), { code: 'PREVIEW_COMPARISON_OBSERVATION_INVALID' });
});
test('a changing counter with repeated records fails the migration pagination regression', () => {
  const a = snapshot(), b = snapshot(); b.items.counter[0].text = '26–50';
  const args = { relation: 'pagination', rowKey: 'rows', counterKey: 'counter' };
  assert.equal(compareObservations(a, b, args).passed, false);
  b.items.rows[0].text = 'Equipment 26';
  assert.equal(compareObservations(a, b, args).passed, true);
  assert.throws(() => compareObservations(a, b, { relation: 'pagination' }), { code: 'PREVIEW_PAGINATION_EVIDENCE_REQUIRED' });
});
test('live comparison saves evidence and pixel mismatch cannot be overridden by equal geometry', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-compare-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let closed = 0; const commands = [];
  const result = await compareBrowserPages({ reference: { tabId: 'a', origin: 'https://example.com' },
    candidate: { tabId: 'b', origin: 'https://example.com' }, scenario: 'catalog', selectors: [{ key: 'rows', selector: 'table tr' }] },
  { workspace, target: async id => id, connect: async () => ({
    evaluate: async fn => fn === observePage ? { ...snapshot(), url: 'https://example.com/catalog' } : { equal: false, ratio: .1 },
    send: async command => { commands.push(command); return { data: Buffer.from('fixture').toString('base64') }; }, close: () => closed++ }) });
  assert.equal(result.passed, false); assert.equal(result.writesBusinessData, false);
  assert.equal(closed, 3); assert.deepEqual(commands, ['Page.bringToFront', 'Page.captureScreenshot', 'Page.bringToFront', 'Page.captureScreenshot']);
  assert.ok(fs.existsSync(result.evidence.referenceImage.file)); assert.ok(fs.existsSync(result.evidence.receipt.file));
});
test('invalid origins and selectors never reach the browser', async () => {
  const options = { workspace: path.resolve(os.tmpdir()), target: () => assert.fail('must not connect') };
  const input = { reference: { tabId: 'a', origin: 'https://user:secret@example.com' }, candidate: { tabId: 'b', origin: 'https://example.com' },
    scenario: 'test', selectors: [{ key: 'main', selector: 'main' }] };
  await assert.rejects(compareBrowserPages(input, options), { code: 'PREVIEW_COMPARISON_ORIGIN' });
  input.selectors.push(input.selectors[0]);
  await assert.rejects(compareBrowserPages(input, options), { code: 'PREVIEW_COMPARISON_SELECTORS' });
});
test('MCP exposes comparison without accepting arbitrary browser scripts', async () => {
  let tool; const ran = [];
  registerPreviewTools({ registerTool: (...args) => tool = args }, { preview: async args => { ran.push(args); return { ok: true }; } });
  const schema = tool[1].inputSchema;
  // The comparison inputs come in one object, compare (the listing budget: integ/proto-into-product); the handler checks it
  // whole and hands the manager its fields beside the others.
  const compare = { scenario: 'catalog', selectors: [{ key: 'table', selector: 'table' }],
    reference: { tabId: 'a', origin: 'https://example.com' }, candidate: { tabId: 'b', origin: 'https://example.com' } };
  assert.equal(schema.safeParse({ action: 'compare', compare }).success, true);
  assert.equal(schema.safeParse({ action: 'compare', script: 'doAnything()' }).success, false);
  assert.equal(schema.safeParse({ action: 'compare', ...compare }).success, false, 'the fields go inside compare');
  const ok = await tool[2]({ action: 'compare', compare });
  assert.equal(ok.isError, undefined); assert.deepEqual(ran, [{ action: 'compare', ...compare }]);
  // Negative: a script inside a selector, an unknown field or a bad origin is refused before anything is read, each named.
  const bad = await tool[2]({ action: 'compare', compare: { ...compare, script: 'doAnything()', selectors: [{ key: 'table', selector: 'table', run: 'x' }],
    reference: { tabId: 'a', origin: 'not a url' } } });
  assert.equal(bad.isError, true); assert.equal(bad.structuredContent.code, 'INPUT_INVALID');
  const paths = bad.structuredContent.violations.map(v => v.path).join(' ');
  assert.match(paths, /\/compare\/reference\/origin/); assert.match(paths, /\/compare\/selectors\/0/); assert.match(paths, /\/compare/);
  assert.equal(ran.length, 1, 'nothing ran for the refused input');
});
