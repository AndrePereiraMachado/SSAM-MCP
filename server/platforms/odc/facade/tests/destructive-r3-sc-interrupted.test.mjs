import './fixtures/isolated-profile.mjs';
// CX15 r3, CT-5, O11 part (subagent SC): after a process died in the middle of an operation (ZZC A deleted, the delete of
// ZZC B applied by the server when the process died), the same token with the owner's NEW words answers
// OPERATION_INTERRUPTED with a new preview of what is left, and the ANSWER says what happened: this call sent nothing,
// the interrupted operation deleted ZZC A and ZZC B is uncertain (operation: the summary of its record; deleted names A,
// uncertain names B), with ssam_task and the new preview as the next steps; never "nothing was reserved or sent" with
// deleted:[]. The page deletes answer the same way. A real child process dies (fixtures/r3-sc-crash-child.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Journal } from '../service-center/client.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { CONFIRM_MIN_AGE_MS, operationFile } from '../destructive-operations.mjs';
import { CATALOG, FakeBridge } from './fixtures/sc-fake-bridge.mjs';
import { fakeClock } from './fixtures/destructive-flow.mjs';
import { PAGE_DELETES, engineWorld, pageWorld } from './fixtures/r3-sc-world.mjs';
import { registerO11Environment } from '../o11-environment.mjs';

const PERSONAL = 'personal-0000test.outsystemscloud.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');

test('CT-5 (O11 engine): the answer after a dead process names what the interrupted operation did; this call sent nothing; ssam_task and a new preview', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r3-sc-ct5-'));
  const child = spawnSync(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'r3-sc-crash-child.mjs'), dir], { encoding: 'utf8', env: process.env });
  assert.equal(fs.readFileSync(path.join(dir, 'child-died-at.txt'), 'utf8'), 'send of k-b', child.stderr);
  assert.notEqual(child.status, 0, 'the child died');
  const { token, operationId } = JSON.parse(fs.readFileSync(path.join(dir, 'preview.json'), 'utf8'));
  const gone = () => JSON.parse(fs.readFileSync(path.join(dir, 'gone.json'), 'utf8'));
  const apps = ['A', 'B', 'C', 'D'].map(x => ({ key: 'k-' + x.toLowerCase(), name: 'ZZC ' + x }));
  const sends = [];
  const bridge = new FakeBridge({ serviceCenter: CATALOG, api: {
    ListApplications: () => apps.filter(a => !gone().includes(a.key)).map(a => ({ Key: a.key, Name: a.name })),
    ListEspaces: () => [], ListExtensions: [], GetConsumers: [],
    DeleteApplication: args => { if (args.simulate) return { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] }; sends.push(args.appKey); return { success: true }; } } });
  const clock = fakeClock(); clock.advance(60000);
  const root = path.join(dir, 'destructive');
  const deps = { journal: new Journal(path.join(dir, 'receipts')), locate: () => bridge, present: async () => false, running: async () => false, exports: dir, registry: REGISTRY,
    sleep: async () => {}, clock, destructiveRoot: root, backup: async () => ({ files: [] }) };
  const answer = await runServiceCenter(['delete', '--confirmation-token=' + token, '--words=confirmo, apaga os 4 ZZC', '--host=' + PERSONAL], deps);
  assert.deepEqual(sends, [], 'nothing sent now');
  assert.ok(answer.problems?.some(p => p.code === 'OPERATION_INTERRUPTED'), JSON.stringify(answer).slice(0, 400));
  assert.doesNotMatch(answer.error, /nothing was reserved or sent/, 'never "nothing was reserved or sent" after an interrupted operation');
  assert.match(answer.error, /this call sent nothing/i);
  assert.match(answer.error, /ZZC A/, 'the error names what the interrupted operation deleted');
  assert.match(answer.error, /ZZC B[^.;]* uncertain/, 'and what is uncertain');
  assert.deepEqual(answer.deleted?.map(d => d.name), ['ZZC A'], 'deleted is what the operation of this token deleted, never a false []');
  assert.deepEqual(answer.uncertain, ['ZZC B']);
  assert.deepEqual([answer.operation?.operationId, answer.operation?.orphaned, answer.operation?.deleted, answer.operation?.uncertain, answer.operation?.notStarted],
    [operationId, true, ['ZZC A'], ['ZZC B'], ['ZZC C', 'ZZC D']], JSON.stringify(answer.operation));
  assert.deepEqual([answer.continuation?.tool, answer.continuation?.arguments?.id], ['ssam_task', operationId]);
  assert.match(answer.next ?? '', /ssam_task/);
  assert.deepEqual(answer.preview?.items.map(i => i.name), ['ZZC C', 'ZZC D'], 'the new preview lists what is left');
  assert.notEqual(answer.repeat?.confirmationToken, token, 'the next call carries the new preview\'s token, never this one');
});

test('CT-5 (o11_environment delete-app): the refusal after a dead process names what it did; its continuation reads ssam_task first and carries the new preview\'s token', async () => {
  const w = engineWorld({ names: ['A'] });
  const handlers = {};
  registerO11Environment({ registerTool: (name, config, handler) => { handlers[name] = handler; } }, { serviceCenterDeps: w.deps(), studioHosts: async () => [PERSONAL], destructiveRoot: w.root });
  const preview = (await handlers.o11_environment({ action: 'delete-app', app: 'ZZC A', host: PERSONAL })).structuredContent;
  assert.equal(preview.state, 'previewed', JSON.stringify(preview).slice(0, 300));
  w.clock.advance(CONFIRM_MIN_AGE_MS);
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  fs.mkdirSync(path.dirname(operationFile(preview.operationId, { root: w.root })), { recursive: true });
  fs.writeFileSync(operationFile(preview.operationId, { root: w.root }), JSON.stringify({ schema: 'ssam-destructive-operation/1', operationId: preview.operationId, previewId: preview.previewId,
    tool: 'o11_environment', host: PERSONAL, operation: 'delete', pid: dead, startedAt: new Date().toISOString(), state: 'running',
    items: preview.items.map(i => ({ kind: i.kind, key: i.key, name: i.name, state: 'sending', at: new Date().toISOString() })) }));
  const answer = (await handlers.o11_environment({ action: 'delete-app', host: PERSONAL, confirmationToken: preview.confirmationToken, authorize: 'sim, apaga o 1, ZZC A' })).structuredContent;
  assert.deepEqual(w.sends(), []);
  assert.ok(answer.problems?.some(p => p.code === 'OPERATION_INTERRUPTED'), JSON.stringify(answer).slice(0, 400));
  assert.match(answer.error, /this call sent nothing/i);
  assert.deepEqual([answer.operation?.orphaned, answer.uncertain], [true, ['ZZC A']]);
  assert.equal(answer.continuation?.tool, 'o11_environment');
  assert.notEqual(answer.continuation?.arguments?.confirmationToken, preview.confirmationToken, 'the new preview\'s token, never this one');
  assert.match(answer.continuation?.why ?? '', /ssam_task/);
});

test('CT-5 (page delete): a page delete whose process died answers what it did (uncertain) and that this call sent nothing', async () => {
  const w = pageWorld();
  const action = 'db-connection-delete';
  const preview = await w.run(action);
  w.clock.advance(CONFIRM_MIN_AGE_MS);
  // The process that ran it died while sending (its record still says running, its pid is gone).
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  fs.mkdirSync(path.dirname(operationFile(preview.operationId, { root: w.root })), { recursive: true });
  fs.writeFileSync(operationFile(preview.operationId, { root: w.root }), JSON.stringify({ schema: 'ssam-destructive-operation/1', operationId: preview.operationId, previewId: preview.previewId,
    tool: 'o11_service_center_write', host: 'test.example.com', operation: action, pid: dead, startedAt: new Date().toISOString(), state: 'running',
    items: preview.items.map(i => ({ kind: i.kind, key: i.key, name: i.name, state: 'sending', at: new Date().toISOString() })) }));
  const answer = await w.run(action, ['--confirmation-token', preview.confirmationToken, '--words', 'sim, apaga a 1 LegacyERP no test']);
  assert.deepEqual(w.posts(), []);
  assert.ok(answer.problems?.some(p => p.code === 'OPERATION_INTERRUPTED'), JSON.stringify(answer).slice(0, 400));
  assert.doesNotMatch(answer.error, /nothing was reserved or sent/);
  assert.match(answer.error, /this call sent nothing/i);
  assert.deepEqual([answer.operation?.orphaned, answer.operation?.uncertain], [true, [PAGE_DELETES[action].name]], JSON.stringify(answer.operation));
  assert.deepEqual([answer.continuation?.tool, answer.continuation?.arguments?.id], ['ssam_task', preview.operationId]);
});
