// The summary of what a delivered (or proven) job created or changed (job-summary.mjs, 2026-10-12): a delivery answers it so
// the model does not map the module again after "delivered". Pure: jobs written inline, plus the suite's single-job example.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jobSummary } from '../job-summary.mjs';

const bytes = v => Buffer.byteLength(JSON.stringify(v), 'utf8');

test('logic and spec ops: each action with its inputs and outputs, each entity and structure with its attribute count', () => {
  const s = jobSummary({ ops: [
    { op: 'spec', data: { entities: [{ name: 'Pedido', attributes: [{ name: 'Numero', type: 'Text' }, { name: 'Total', type: 'Decimal' }] }],
      static: [{ name: 'Status', records: [{ name: 'A' }, { name: 'B' }] }], structures: [{ name: 'PedidoResumo', attributes: [{ name: 'Total', type: 'Decimal' }] }] } },
    { op: 'logic', data: { actions: [
      { name: 'Pedido_Get', inputs: [{ name: 'PedidoId', type: 'Pedido Identifier' }, { name: 'Detalhe', type: 'Boolean', mandatory: false }], outputs: [{ name: 'Pedido', type: 'Pedido' }], steps: [] },
      { name: 'Pedido_Limpa', kind: 'client', replace: true, steps: [] },
    ] } },
  ] });
  assert.deepEqual(s.actions, ['Pedido_Get(PedidoId: Pedido Identifier, Detalhe?: Boolean) -> (Pedido: Pedido)', 'client Pedido_Limpa() (replaced)']);
  assert.deepEqual(s.entities, [{ name: 'Pedido', attributes: 2 }]);
  assert.deepEqual(s.staticEntities, [{ name: 'Status', attributes: 0, records: 2 }]);
  assert.deepEqual(s.structures, [{ name: 'PedidoResumo', attributes: 1 }]);
  assert.equal(s.ops, 2);
});

test('raw verbs: an action with its parameters and their DataType, other top-level elements by interface, edits counted', () => {
  const s = jobSummary([
    { op: 'create', parent: '@espace', type: 'IServerAction', name: 'Event_Write', as: '$a' },
    { op: 'set', target: '$a', prop: 'Description', value: 'Escreve' },
    { op: 'create', parent: '$a', type: 'IInputParameter', name: 'TicketId', as: '$in' },
    { op: 'set', target: '$in', prop: 'DataType', value: 'Ticket Identifier' },
    { op: 'create', parent: '$a', type: 'IInputParameter', name: 'Note', as: '$note' },
    { op: 'set', target: '$note', prop: 'IsMandatory', value: false },
    { op: 'create', parent: '$a', type: 'IOutputParameter', name: 'Ok', as: '$out' },
    { op: 'create', parent: '@espace', type: 'IServerEntity', name: 'Ticket', as: '$t' },
    { op: 'create', parent: '$t', type: 'IEntityAttribute', name: 'Subject', as: '$ts' },
    { op: 'create', parent: '@espace', type: 'UserException', name: 'NotFound', as: '$e' },
    { op: 'set', target: 'ServerAction:Old', prop: 'Description', value: 'x' },
    { op: 'rename', target: 'ServerAction:Old2', name: 'New2' },
    { op: 'get', target: 'ServerAction:Old3' },
  ]);
  assert.deepEqual(s.actions, ['Event_Write(TicketId: Ticket Identifier, Note?) -> (Ok)']);
  assert.deepEqual(s.entities, [{ name: 'Ticket', attributes: 1 }]);
  assert.deepEqual(s.elements, { IUserException: ['NotFound'] });
  assert.deepEqual(s.edited, { count: 2, targets: ['ServerAction:Old', 'ServerAction:Old2'] });
});

test('nothing to name gives no summary; a composite names its parts; a large job stays under 4 KB and counts what it cut', () => {
  assert.equal(jobSummary({ ops: [{ op: 'get', target: 'ServerAction:X' }, { op: 'prototype', data: {} }] }), null);
  assert.equal(jobSummary(null), null);
  assert.deepEqual(jobSummary({ jobs: ['job:a', 'job:b'] }), { parts: ['job:a', 'job:b'] });
  const actions = Array.from({ length: 200 }, (_, i) => ({ name: 'Action_' + i, inputs: [{ name: 'A'.repeat(40), type: 'Text' }], outputs: [{ name: 'B'.repeat(40), type: 'Text' }] }));
  const s = jobSummary({ ops: [{ op: 'logic', data: { actions } }] });
  assert.ok(bytes(s) <= 4096, String(bytes(s)));
  assert.equal(s.actionsTotal, 200); assert.ok(s.actions.length > 0 && s.actions.length < 200);
  assert.match(s.actions[0], /^Action_0\(\)$/, 'over the budget the lines keep only the names');
});

test('the single-job example of the suite: four actions, the entity, the structure, the exception and the site property', () => {
  const file = fileURLToPath(new URL('../../../../kernel/tests/jobs/single-job-actions.json', import.meta.url));
  const s = jobSummary(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(s.actions.length, 4);
  assert.ok(s.actions.includes('Agenda_TemConflito(Inicio: Date Time, DuracaoMinutos: Integer) -> (HasConflito: Boolean)'), JSON.stringify(s.actions));
  assert.deepEqual(s.entities, [{ name: 'Compromisso', attributes: 5 }]);
  assert.deepEqual(s.structures, [{ name: 'ResumoDoDia', attributes: 4 }]);
  assert.deepEqual(s.elements, { IUserException: ['AgendaInvalida'], ISiteProperty: ['FusoHorarioMinutos'] });
});
