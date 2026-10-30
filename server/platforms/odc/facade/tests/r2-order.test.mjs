import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderParts, writeCall } from '../ssam-code.mjs';

const action = (name, body = '') => ({ part: 'logic', text: `server action ${name}\n${body}  end\n` });
const html = (name, body = '') => ({ part: 'html', text: `<screen name="${name}">${body}</screen>` });
test('R2 established kind ranks break unrelated ties', () => {
  const parts = [action('First'), html('Second'), { part: 'ddl', text: 'type Third = { Value: Text; }' }];
  assert.deepEqual(orderParts(parts).parts, [parts[2], parts[1], parts[0]]);
});
test('R2 a spec structure precedes the HTML that consumes it', () => {
  const page = html('Overview', '<var name="Summary" type="Totals"/>');
  const spec = { part: 'ops', ops: [{ op: 'spec', data: { structures: [{ name: 'Totals', attributes: [{ name: 'Count', type: 'Integer' }] }] } }] };
  assert.deepEqual(orderParts([page, spec]).parts, [spec, page]);
});
test('R2 navigation puts the destination before its caller', () => {
  const caller = html('Overview', '<a destination="Details">Open</a>'), target = html('Details');
  assert.deepEqual(orderParts([caller, target]).parts, [target, caller]);
});
test('R2 action calls put callees before callers', () => {
  const caller = action('Load', '  Fetch()\n'), target = action('Fetch');
  assert.deepEqual(orderParts([caller, target]).parts, [target, caller]);
});
test('R2 a timer and data split only to resolve a mixed-part dependency cycle', () => {
  const data = { part: 'ddl', text: 'type Totals = { Count: Integer; }\ntimer Nightly action Refresh schedule "03:00"\n' };
  const logic = action('Refresh', '  local Summary: Totals\n');
  const result = orderParts([data, logic]);
  assert.equal(result.cycle, undefined);
  assert.equal(result.parts.length, 3);
  assert.match(result.parts[0].text, /^type Totals/);
  assert.equal(result.parts[1], logic);
  assert.match(result.parts[2].text, /^\s*timer Nightly/);
});
test('R2 splitting preserves documentation and quoted delimiters', () => {
  const text = '/// Summary.\ntype Totals = { Note: Text default "http://host/{x};"; }\n\n/// Runs at night.\ntimer Nightly action Refresh schedule "03:00"\n';
  const data = { part: 'ddl', text }, logic = action('Refresh', '  local Summary: Totals\n');
  const result = orderParts([data, logic]);
  assert.equal(result.cycle, undefined);
  const texts = result.parts.filter(p => p.part === 'ddl').map(p => p.text);
  assert.equal(texts.join(''), text);
  assert.match(texts[1], /^\s*\/\/\/ Runs at night/);
  assert.equal(data.text, text);
});
test('R2 mutually dependent actions retain order for the kernel', () => {
  const result = writeCall({ lane: 'o11', module: 'Sample', ...action('First', '  Second()\n'), also: [action('Second', '  First()\n')] });
  assert.equal(result.refusal, undefined);
  assert.match(JSON.stringify(result.normalizations), /First, Second/);
});
test('R2 delete chains remove descendants before their owners', () => {
  const parts = ['ServerAction:Load', 'ServerAction:Load/If:Ready', 'ServerAction:Load/If:Ready/Assign:Set'].map(target => ({ part: 'ops', ops: [{ op: 'delete', target }] }));
  assert.deepEqual(orderParts(parts).parts, [...parts].reverse());
});
test('R2 a single ops part orders its delete chain', () => {
  const ops = ['ServerAction:Load', 'ServerAction:Load/If:Ready', 'ServerAction:Load/If:Ready/Assign:Set'].map(target => ({ op: 'delete', target }));
  assert.deepEqual(orderParts([{ part: 'ops', ops }]).parts.flatMap(p => p.ops), [...ops].reverse());
});
test('R2 a single ops part puts its timer after the new action', () => {
  const ops = [{ op: 'spec', data: { ddl: 'timer Nightly action Refresh schedule "03:00"' } }, { op: 'logic', data: { actions: [{ name: 'Refresh', steps: [] }] } }];
  assert.deepEqual(orderParts([{ part: 'ops', ops }]).parts.flatMap(p => p.ops), [...ops].reverse());
});
test('R2 visible HTML text is not a reference to another screen', () => {
  const parts = [html('First', '<p>Second</p>'), html('Second', '<a destination="First">Open</a>')];
  assert.equal(orderParts(parts).cycle, undefined);
  assert.deepEqual(orderParts(parts).parts, parts);
});
test('R2 a consumer rewrite with the old reference removed precedes deletion', () => {
  const drop = { part: 'ddl', text: 'drop entity Record;' }, rewrite = action('Load');
  assert.deepEqual(orderParts([drop, rewrite]).parts, [rewrite, drop]);
});
test('R2 quoted text does not create a false action cycle', () => {
  const parts = [action('First', '  message "Second()"\n'), action('Second', '  First()\n')];
  assert.equal(orderParts(parts).cycle, undefined);
});

