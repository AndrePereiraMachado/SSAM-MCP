// The op entity-actions in the facade: its receipt in a delivery answer (entity-actions.mjs), its card in ssam_code grammar
// and in the work packet's text route, and its contract line in ssam_reference. The kernel side (the generator, the corpus
// battery, the proof jobs) is tested in kernel/tests (EntityActionsExpanderTests, EntityActionsCorpusTests, jobs entity-actions).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { entityActionsOf } from '../entity-actions.mjs';
import { grammarCard, ENTITY_ACTIONS_CARD, ENTITY_ACTIONS_OP, writeCall } from '../ssam-code.mjs';
import { packetTextSection } from '../text-packet.mjs';
import { API_OPS } from '../ssam-reference.mjs';
import { DELIVERY_FIELDS } from '../responses.mjs';
import { withGeneratorStates } from '../generators.mjs';

// The offers of the generator (grammar, text section) while it is approved; pending, none (tests/generators.test.mjs).
const approved = fn => withGeneratorStates({ 'entity-actions': { state: 'approved' } }, fn);

const report = {
  entities: ['Cliente', 'Visita'],
  created: [
    { name: 'GetClienteList', kind: 'server', entity: 'Cliente', role: 'list', public: true, key: 'k1' },
    { name: 'SaveCliente', kind: 'server', entity: 'Cliente', role: 'save', public: true, key: 'k2' },
    { name: 'RemoveVisita', kind: 'server', entity: 'Visita', role: 'delete', public: true, key: 'k3' },
  ],
  unchanged: ['GetClienteById'],
  kept: [{ name: 'SaveVisita', entity: 'Visita', role: 'save', why: 'reads otherwise', generated: 'server action SaveVisita\n  end\n', edit: { key: '@k9', basedOn: 'abc' } }],
  notes: [{ code: 'ENTITY_NOT_PUBLIC', message: 'a' }, { code: 'ENTITY_NOT_PUBLIC', message: 'b' }, { code: 'ODC_APP_SERVER_PRIVATE', message: 'c' }],
  exceptions: [{ name: 'NotFound', created: true }, { name: 'AccessDenied', created: false }],
  structures: [{ name: 'ClienteListItem', created: true }],
};

test('entityActionsOf: actions by entity, counts, kept without the generated text, notes grouped', () => {
  const out = entityActionsOf([report]);
  assert.equal(out.created, 3);
  assert.equal(out.unchanged, 1);
  assert.deepEqual(out.actions, { Cliente: ['GetClienteList', 'SaveCliente'], Visita: ['RemoveVisita'] });
  assert.equal(out.kept.length, 1);
  assert.equal(out.kept[0].generated, undefined);
  assert.deepEqual(out.kept[0].edit, { key: '@k9', basedOn: 'abc' });
  assert.deepEqual(out.notes.map(n => n.code), ['ENTITY_NOT_PUBLIC', 'ODC_APP_SERVER_PRIVATE']);
  assert.equal(out.notes[0].count, 2);
  assert.deepEqual(out.exceptionsCreated, ['NotFound']);
  assert.deepEqual(out.structuresCreated, ['ClienteListItem']);
  assert.equal(out.noChange, undefined);
  assert.equal(entityActionsOf([{ created: [], unchanged: ['A'], noChange: true }]).noChange, true);
  assert.equal(entityActionsOf([]), null);
  assert.equal(entityActionsOf(undefined), null);
  assert.ok(DELIVERY_FIELDS.includes('entityActions'));
});

test('approved: ssam_code grammar: the logic card and the overview carry the generator in three lines and a ready write', () => approved(() => {
  assert.equal(ENTITY_ACTIONS_CARD.length, 3);
  for (const lane of ['o11', 'odc']) {
    const logic = grammarCard('logic', lane).card;
    assert.deepEqual(logic.generate.card, ENTITY_ACTIONS_CARD);
    assert.equal(logic.generate.call.arguments.ops[0].op, 'entity-actions');
    assert.ok(logic.rules.some(r => /GENERATED/.test(r)));
    const all = grammarCard(null, lane);
    assert.equal(all.generate.call.arguments.ops[0].op, 'entity-actions');
    // The ready call is a valid write: the op goes first in the job, the business texts after it.
    const call = writeCall({ ...all.generate.call.arguments, module: 'Vendas_CS', text: ['/// Closes a sale.\nserver action FecharVenda\n  end\n'] });
    assert.equal(call.refusal, undefined);
    assert.equal(call.arguments.job.ops[0].op, 'entity-actions');
    assert.equal(call.arguments.job.ops[1].op, 'logic');
  }
  assert.equal(ENTITY_ACTIONS_OP.op, 'entity-actions');
}));

test('approved: work packet: a creation of actions carries the generator; an edit does not', () => approved(() => {
  const created = packetTextSection({ lane: 'o11', intent: 'criar server actions de listar, salvar e excluir para as entidades do modulo' });
  if (created?.value?.id === 'logic.flow') {
    assert.equal(created.value.generate.op.op, 'entity-actions');
    assert.equal(created.value.generate.card.length, 3);
  }
  const route = { id: 'logic.flow', verb: 'change', why: 'test' };
  const edited = packetTextSection({ lane: 'o11', intent: 'mudar a action X', route });
  assert.equal(edited.value.generate, undefined);
  const creating = packetTextSection({ lane: 'odc', intent: 'criar actions', route: { id: 'logic.flow', verb: 'create', why: 'test' } });
  assert.equal(creating.value.generate.op.op, 'entity-actions');
}));

test('pending (the declared state): no generate in the grammar or the text section; the write with the op still works', () => {
  for (const lane of ['o11', 'odc']) {
    assert.equal(grammarCard('logic', lane).card.generate, undefined);
    assert.equal(grammarCard(null, lane).generate, undefined);
    assert.equal(packetTextSection({ lane, intent: 'criar actions', route: { id: 'logic.flow', verb: 'create', why: 'test' } }).value.generate, undefined);
    const call = writeCall({ lane, action: 'write', module: 'Vendas_CS', ops: [ENTITY_ACTIONS_OP], part: 'logic', text: ['/// Closes a sale.\nserver action FecharVenda\n  end\n'] });
    assert.equal(call.refusal, undefined);
    assert.deepEqual(call.arguments.job.ops.map(o => o.op), ['entity-actions', 'logic']);
  }
});

test('ssam_reference: entity-actions is an api op with its line, after the kernel order', () => {
  assert.equal(API_OPS.at(-1), 'entity-actions');
});
