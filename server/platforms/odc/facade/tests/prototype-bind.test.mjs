// data.bind of the prototype op (docs/PROTOTIPO-NATIVO.md 2.12), facade side: the closed shape, the producer the delivery
// captures by name, the one strict patch and corrected call of PROTOTYPE_BINDING_REQUIRED, the receipt of a bound import.
// The kernel's binding (names, proposal, offline validation, compile) is tested in kernel/tests/Anvil.Tests/PrototypeBindTests.cs.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataProblems, bindProblems, bindingCorrection, prototypeReceipt, PROTOTYPE_CODES, BIND_KEYS, PROTOTYPE_DELIVER_TEXT } from '../prototype-op.mjs';
import { PROTOTYPE_CODES as REGISTERED } from '../refusal-codes.mjs';
import { referencedProducers, autoCaptures } from '../o11-cycle.mjs';
import { runJob } from '../job-runner.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { farmaFolder, fakeCapture, fakeMeasure } from './fixtures/prototype-surface/fakes.mjs';

function tmp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proto-bind-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('bind is a key of the op and its shape is closed at every level, each problem with its patch', () => {
  assert.deepEqual(BIND_KEYS, ['producer', 'screens', 'lists', 'slots', 'events', 'modals']);
  assert.deepEqual(dataProblems({ source: 'C:\\p', bind: { producer: 'FolhaPonto_CS' } }), []);
  const problems = bindProblems({
    producer: 'FolhaPonto CS', screnes: {},
    screens: { bater: { source: { action: 'ObterResumoHoje', argz: {} } } },
    lists: { 'v:bater/3/1': 3 }, slots: { 'v:bater/0/1/0': null },
    events: { cta: { call: 'RegistrarBatida', then: ['refresh Resumo', 'toast now'] }, tab: { navigate: 'espelho' }, reset: null, bad: {} },
  });
  const at = problems.map(p => p.at);
  assert.ok(at.includes('/bind/producer'));
  const screnes = problems.find(p => p.at === '/bind/screnes');
  assert.match(screnes.message, /did you mean screens/);
  assert.deepEqual(screnes.patch, [{ op: 'remove', path: '/bind/screnes' }]);
  assert.ok(at.includes('/bind/screens/bater/source/argz'));
  assert.ok(at.includes('/bind/lists/v:bater~13~11'));
  assert.ok(at.includes('/bind/events/cta/then'));
  assert.ok(at.includes('/bind/events/bad'), 'an event binding calls or navigates');
  assert.ok(!at.some(p => p.startsWith('/bind/slots') || p.startsWith('/bind/events/tab') || p.startsWith('/bind/events/reset')), 'null keeps the prototype\'s own value');
  assert.ok(problems.every(p => p.code === 'INPUT_INVALID'));
});

test('PROTOTYPE_BINDING_REQUIRED is registered, and the delivery text names data.bind', () => {
  assert.ok(PROTOTYPE_CODES.includes('PROTOTYPE_BINDING_REQUIRED'));
  assert.deepEqual([...REGISTERED].sort(), [...PROTOTYPE_CODES].sort());
  assert.match(PROTOTYPE_DELIVER_TEXT, /data\.bind \{producer:"<Module>"\}/);
});

test('the delivery captures the producer data.bind names, as it does a reference op\'s (C27)', t => {
  const dir = tmp(t);
  const job = path.join(dir, 'job.json');
  fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'reference', producer: 'System', elements: [] }, { op: 'prototype', data: { source: 'C:\\p', bind: { producer: 'FolhaPonto_CS' } } }] }));
  assert.deepEqual(referencedProducers(job), ['System', 'FolhaPonto_CS']);
  assert.deepEqual(autoCaptures(job, { producers: { System: 'C:\\s.avsig' } }), ['FolhaPonto_CS']);
});

// the kernel's answer: one member of data.bind per proposal (each built offline), an unresolved item without a patch
const proposals = [
  { code: 'PROTOTYPE_BINDING_REQUIRED', pointer: '/ops/0/data/bind/screens/bater', patch: [{ op: 'add', path: '/ops/0/data/bind/screens/bater', value: { source: { action: 'ObterResumoHoje' } } }], binding: { kind: 'source', validated: true } },
  { code: 'PROTOTYPE_BINDING_REQUIRED', pointer: '/ops/0/data/bind/lists/v:bater~13~11', patch: [{ op: 'add', path: '/ops/0/data/bind/lists/v:bater~13~11', value: 'ObterResumoHoje.Resumo.Dia.Etapas' }], binding: { kind: 'list', validated: true } },
  { code: 'PROTOTYPE_BINDING_REQUIRED', pointer: '/ops/0/data/bind/events/bater:click:cta', patch: [{ op: 'add', path: '/ops/0/data/bind/events/bater:click:cta', value: { call: 'RegistrarBatida', then: ['refresh ObterResumoHoje'] } }], binding: { kind: 'event', validated: true } },
  { code: 'PROTOTYPE_BINDING_REQUIRED', pointer: '/ops/0/data/bind/events/bater:click:tab-espelho', binding: { kind: 'event', validated: false, unresolved: true } },
];

test('the proposals are one strict patch (add /ops/<i>/data/bind, parents present) and the corrected call over the job as given', () => {
  const job = { ops: [{ op: 'prototype', data: { source: 'C:\\p', bind: { producer: 'FolhaPonto_CS' }, capture: 'C:\\x\\capture.json', captureSha256: 'ab' } }] };
  const { patch, correctedJob } = bindingCorrection(proposals, job);
  assert.equal(patch.length, 1);
  assert.equal(patch[0].op, 'add'); assert.equal(patch[0].path, '/ops/0/data/bind');
  assert.deepEqual(patch[0].value, { producer: 'FolhaPonto_CS', screens: { bater: { source: { action: 'ObterResumoHoje' } } },
    lists: { 'v:bater/3/1': 'ObterResumoHoje.Resumo.Dia.Etapas' }, events: { 'bater:click:cta': { call: 'RegistrarBatida', then: ['refresh ObterResumoHoje'] } } });
  assert.equal(correctedJob.ops[0].data.capture, undefined, 'what the facade wrote never reaches the corrected call');
  assert.deepEqual(correctedJob.ops[0].data.bind, patch[0].value);
  assert.deepEqual(bindingCorrection([proposals[3]], job), {}, 'nothing to offer without a validated proposal');
});

test('ssam_job: the kernel\'s PROTOTYPE_BINDING_REQUIRED comes back with every problem, the strict patch and the corrected call', async t => {
  const dir = tmp(t); const source = farmaFolder(dir);
  const root = path.join(dir, 'anvil'); fs.mkdirSync(root, { recursive: true });
  const runAnvil = fakeAnvil({ apply: () => ({ ok: false, command: 'apply', code: 'PROTOTYPE_BINDING_REQUIRED', error: 'prototype: data.bind needs bindings', problems: proposals }) });
  const job = path.join(dir, 'job.json'); fs.writeFileSync(job, JSON.stringify({ ops: [{ op: 'prototype', data: { source, bind: { producer: 'FolhaPonto_CS' } } }] }));
  const value = await runJob({ lane: 'o11', job, producers: { FolhaPonto_CS: path.join(dir, 'cs.oml') } }, { root, env: { ANVIL_WORKER: '0' }, runAnvil, worker: null, o11Lane: 'ss4', capturePrototype: fakeCapture(), measureFidelity: fakeMeasure(),
    prepareIntegrationJob: async () => ({ ok: true }) });
  assert.equal(value.ok, false);
  assert.equal(value.code, 'PROTOTYPE_BINDING_REQUIRED');
  assert.equal(value.problems.length, 4);
  assert.deepEqual(value.problems[3].binding, { kind: 'event', validated: false, unresolved: true });
  assert.equal(value.patch[0].path, '/ops/0/data/bind');
  assert.deepEqual(Object.keys(value.correctedJob.ops[0].data.bind), ['producer', 'screens', 'lists', 'events']);
  assert.ok(runAnvil.calls[0].args.includes('--producer'), 'the producer binding reaches the kernel');
});

test('the receipt counts the calls a binding compiled and carries data.bound', () => {
  const receipt = prototypeReceipt({ events: { total: 2, compiled: 2, byEffect: { call: 1, navigate: 1 } },
    data: { bound: { producer: 'FolhaPonto_CS', dataActions: [{ owner: 'Bater', name: 'ObterResumoHoje', fetch: 'AtStart' }], collections: ['Data'] }, entities: [] } });
  assert.equal(receipt.events.byEffect.call, 1);
  assert.equal(receipt.data.bound.producer, 'FolhaPonto_CS');
  assert.deepEqual(receipt.data.entities, []);
});

test('a configuration list the binding replaced is no static entity: the receipt says so and drops its warning (FolhaPonto zip)', () => {
  const schedule = { value: 'window.SCHEDULE', collection: 'Schedule', rows: 4, role: 'constant list of 4 records; imported as the static entity Schedule' };
  const captures = [{ summary: { configuration: [schedule] } }];
  const warnings = [{ code: 'PrototypeStoreFromConfiguration', lists: [{ value: schedule.value, collection: 'Schedule', role: schedule.role }], alternatives: [] },
    { code: 'PrototypeIntervalSkipped', delay: 1000 }];
  const bound = prototypeReceipt({ data: { bound: { producer: 'FolhaPonto_CS', collections: ['Schedule'] }, entities: [] } }, { captures, warnings });
  assert.deepEqual(bound.warnings.map(w => w.code), ['PrototypeIntervalSkipped']);
  assert.equal(bound.store.configuration[0].bound, true);
  assert.match(bound.store.configuration[0].role, /data\.bind replaced it with the outputs of FolhaPonto_CS/);
  // without a binding the capture's word stands
  const mock = prototypeReceipt({ data: { entities: [] } }, { captures, warnings });
  assert.deepEqual(mock.warnings.map(w => w.code), ['PrototypeStoreFromConfiguration', 'PrototypeIntervalSkipped']);
  assert.equal(mock.store.configuration[0].role, schedule.role);
});
