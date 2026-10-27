import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { packetTextSection } from '../text-packet.mjs';
import { isTraditionalUiIntent, traditionalMatches } from '../traditional-components.mjs';

test('Traditional creation gets its tested native document and action job', () => {
  const result = packetTextSection({ lane: 'o11', intent: 'criar frontend Traditional' });
  assert.equal(result.value.id, 'ui.traditional-screen');
  assert.equal(result.value.call.tool, 'o11_deliver');
  assert.equal(result.value.officialStarter.arguments.query.id, 'osui-web-patterns');
  assert.deepEqual(result.value.call.arguments.job.ops.map(op => op.op), ['html', 'logic']);
  assert.match(result.value.call.arguments.job.ops[1].data.flow, /action AjaxAudit.Toggle/);
  for (const method of ['Ajax', 'Submit', 'Navigate'])
    assert.ok(result.value.call.arguments.job.ops[0].data.html.includes(`method="${method}"`));
  assert.match(result.value.call.arguments.job.ops[1].data.flow, /AjaxRefreshNode/);
  assert.equal(result.value.standard, undefined);
  assert.match(result.value.grammar.join('\n'), /checkbox\|password\|radio/);
  assert.match(result.value.grammar.join('\n'), /source-entity=.*source-attribute=/);
  assert.match(result.value.grammar.join('\n'), /legacy selector has no OnChange/);
  assert.match(result.value.rules.join('\n'), /retain the native Form class/);
});

test('official components and their full popup lifecycle are discoverable at creation and editing', () => {
  // The kind of a request is F4's (app-kinds.mjs): a kind word next to what is built or changed.
  for (const intent of ['criar app Traditional', 'editar popup RichWidgets da tela Traditional']) {
    const result = packetTextSection({ lane: 'o11', intent }).value;
    assert.ok(result.components.some(c => c.arguments.query.name === 'Popup_Editor'));
    assert.ok(result.components.some(c => c.arguments.query.name === 'LayoutPopup'));
    assert.match(result.rules.join('\n'), /Popup_Editor_Notify.*Popup_Editor_Close/);
    assert.match(result.rules.join('\n'), /deprecated.*not supported on mobile/);
    assert.match(result.rules.join('\n'), /do not add a second shell/);
    assert.match(result.rules.join('\n'), /retain the native Form class/);
  }
});

test('Traditional UI selection respects runtime and leaves pure logic alone', () => {
  const found = { digest: { module: { type: 'WebResponsive' } } };
  assert.equal(isTraditionalUiIntent('o11', 'criar tela', found), true);
  assert.equal(isTraditionalUiIntent('o11', 'criar bloco Traditional', found), true);
  assert.equal(isTraditionalUiIntent('o11', 'otimizar SQL Traditional', found), false);
  assert.equal(isTraditionalUiIntent('odc', 'criar tela Traditional', found), false);
  assert.equal(isTraditionalUiIntent('o11', 'criar tela Traditional', { digest: { module: { kind: 'Reactive' } } }), false);
  assert.deepEqual(traditionalMatches([{id:'ui.popup'}, {id:'ui.traditional-screen'}, {id:'logic.assign'}]).map(m=>m.id), ['ui.traditional-screen','logic.assign']);
});

test('Traditional capture selects native grammar without a type in the intent', () => {
  const result = packetTextSection({ lane: 'o11', intent: 'criar uma tela', found: { digest: { module: { kind: 'WebResponsive', name: 'Test' } } } });
  assert.equal(result.value.call.arguments.module, 'Test');
  assert.equal(result.value.id, 'ui.traditional-screen');
});

test('Traditional offers keyed HTML editing but never on ODC', () => {
  const edit = packetTextSection({ lane: 'o11', intent: 'editar tela Traditional' }).value;
  assert.equal(edit.creating, false);
  assert.deepEqual(edit.forms, ['ssam-html/1', 'ssam-flow/1']);
  assert.match(edit.use, /basedOn/);
  assert.equal(edit.read.arguments.view, 'html');
  assert.equal(edit.example.op, 'html');
  assert.equal(packetTextSection({ lane: 'odc', intent: 'criar frontend Traditional' }), null);
});

test('creation and editing teach method selection, fetch vs render and browser evidence', () => {
  for (const intent of ['criar tela Traditional', 'editar tela Traditional']) {
    const result = packetTextSection({ lane: 'o11', intent }).value;
    const rules = result.rules.join('\n');
    assert.match(rules, /input\/textarea.*onchange=.*native OnChange/);
    for (const pattern of [/Navigate/, /Ajax Submit/, /upload\/download/, /does not rerun.*Preparation/, /persistent outer container/, /validation=None/, /server authorization/, /not browser proof/])
      assert.match(rules, pattern);
  }
});
