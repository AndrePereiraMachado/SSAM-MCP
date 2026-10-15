// gen-screen/1 (kernel ScreenGenerator): the standard list, detail and form screens of entities are one op, never written by
// hand. The ssam_code html card and the work packet's text section for a new screen carry that op, three lines, on both lanes,
// while gen-screen is approved (generators.mjs GENERATOR_APPROVAL; pending, neither carries it: tests/generators.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { grammarCard, generateScreensCall, GENERATE_SCREENS_OP, GENERATE_SCREENS_RULE } from '../ssam-code.mjs';
import { packetTextSection } from '../text-packet.mjs';
import { withGeneratorStates } from '../generators.mjs';

const approved = fn => withGeneratorStates({ 'gen-screen': { state: 'approved' } }, fn);

test('the html card of ssam_code says the standard screens are generated, with the call', () => approved(() => {
  for (const lane of ['o11', 'odc']) {
    const { card } = grammarCard('html', lane);
    assert.ok(card.rules.includes(GENERATE_SCREENS_RULE), lane);
    const call = card.standardScreens.call;
    assert.equal(call.tool, 'ssam_code');
    assert.equal(call.arguments.action, 'write');
    assert.deepEqual(call.arguments.ops, [GENERATE_SCREENS_OP]);
    assert.deepEqual(Object.keys(GENERATE_SCREENS_OP.data.generate), ['entities']);
    // Three lines: the op as the model writes it.
    assert.ok(JSON.stringify(GENERATE_SCREENS_OP, null, 1).split('\n').length <= 12);
    assert.deepEqual(generateScreensCall(lane), call);
  }
}));

test('the text section of a new screen carries the generate op as its standard call', () => approved(() => {
  for (const lane of ['o11', 'odc']) {
    const section = packetTextSection({ lane, intent: 'criar tela nova de cadastro de clientes com lista e formulario', route: { id: 'ui.screen-html', why: [] } });
    assert.ok(section, lane);
    const standard = section.value.standard;
    assert.ok(standard, lane + ': standard');
    const op = standard.call.arguments.job.ops[0];
    assert.equal(op.op, 'screen');
    assert.ok(Array.isArray(op.data.generate.entities));
    assert.equal(standard.call.tool, lane === 'o11' ? 'o11_deliver' : 'studio_deliver');
    assert.match(section.value['ssam-html/1'].rules[0], /generated, never written/);
  }
  // An edit of an existing screen is no creation: no standard call.
  const edit = packetTextSection({ lane: 'o11', intent: 'mudar a tela Pedidos', route: { id: 'ui.screen-html-edit', verb: 'change', why: [] } });
  assert.equal(edit?.value.standard, undefined);
}));

test('pending (the declared state): no standard call, rule or card for new screens', () => {
  for (const lane of ['o11', 'odc']) {
    const { card } = grammarCard('html', lane);
    assert.equal(card.standardScreens, undefined);
    assert.ok(!card.rules.includes(GENERATE_SCREENS_RULE));
    const section = packetTextSection({ lane, intent: 'criar tela nova de cadastro de clientes com lista e formulario', route: { id: 'ui.screen-html', why: [] } });
    assert.equal(section.value.standard, undefined);
    assert.doesNotMatch(section.value['ssam-html/1'].rules[0], /generated, never written/);
  }
});
