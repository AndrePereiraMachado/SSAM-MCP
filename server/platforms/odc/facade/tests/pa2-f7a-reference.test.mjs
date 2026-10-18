// A18 (package of 2026-10-06, lane F7a): the vocabulary of ssam_reference. The friction report's real refusals:
// "unknown op 'reference'; allowed: logic, spec, ..." (a job verb asked as op), "api query does not take: find",
// "recipe --ops requires --max" and check-delivery asking for an absolute path the session had to build from a taskId.
// The facade runs a fake CLI (argv checked); when this worktree's own O11 CLI is built, `api --op <verb>` is also asked of it.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { registerSsamReference, referenceArguments, closestForm, RECIPE_OPS_MAX } from '../ssam-reference.mjs';
import { anvilRoot } from '../workspace.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { tempKernel, linked } from './fixtures/o11env-kernel.mjs';

const echo = verb => args => ({ ok: true, command: verb, data: { argv: args } });
async function harness(t, handlers = {}) {
  const kernel = tempKernel({ cli: true });
  const run = fakeAnvil({ api: echo('api'), recipe: echo('recipe'), functions: echo('functions'),
    'check-delivery': args => ({ ok: true, command: 'check-delivery', data: { accepted: true, result: args[2] } }), ...handlers });
  const mcp = await linked(registerSsamReference, { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil: run, uuid: () => 'job-1' });
  t.after(async () => { await mcp.close(); kernel.cleanup(); });
  return { ...mcp, run, root: kernel.root, ask: (lane, kind, query) => mcp.call('ssam_reference', { lane, kind, query }) };
}

test('api {op:<verb>} goes to the kernel as api --op <verb>; an unknown op continues to the verb table', async t => {
  const h = await harness(t, { api: args => (args[2] === 'security'
    ? { ok: false, command: 'api', error: "ArgumentException: unknown op 'security'; allowed: logic, spec; verbs (their line): create, set" }
    : { ok: true, command: 'api', data: { op: 'verbs', verb: args[2], kind: 'write', required: ['producer', 'elements'], optional: ['as'] } }) });
  const verb = await h.ask('o11', 'api', { op: 'reference' });
  assert.equal(verb.ok, true, JSON.stringify(verb));
  assert.deepEqual(h.run.calls[0].args, ['api', '--op', 'reference']);
  assert.equal(verb.data.verb, 'reference');
  const odc = await h.ask('odc', 'api', { op: 'create' });
  assert.deepEqual(h.run.calls[1].args, ['api', '--op', 'create']); assert.equal(odc.ok, true);
  const unknown = await h.ask('o11', 'api', { op: 'security' });
  assert.equal(unknown.code, 'CLI_REFUSED');
  assert.deepEqual(unknown.continuation.arguments, { lane: 'o11', kind: 'api', query: { op: 'verbs' } });
});

test('the O11 CLI of this worktree answers api --op reference with the line of the verb (skipped without a build)', async t => {
  const cli = path.join(anvilRoot, '.local', 'cli', 'anvil.dll');
  if (!fs.existsSync(cli)) { t.skip('no O11 CLI built in ' + anvilRoot); return; }
  const mcp = await linked(registerSsamReference, { root: anvilRoot, lane: 'ss4', env: { ...process.env, ANVIL_WORKER: '0' } });
  t.after(() => mcp.close());
  const value = await mcp.call('ssam_reference', { lane: 'o11', kind: 'api', query: { op: 'reference' } });
  assert.equal(value.ok, true, JSON.stringify(value).slice(0, 400));
  assert.deepEqual([value.data.op, value.data.verb, value.data.kind], ['verbs', 'reference', 'write']);
  assert.deepEqual(value.data.required, ['producer', 'elements']);
});

test('check-delivery takes the taskId of a delivery: <lane.work>/deliver/<taskId>/result.json', async t => {
  const h = await harness(t);
  const taskId = '0f3a9c1e2b4d4e6f8a1b2c3d4e5f6a7b';
  const result = path.join(h.root, '.local', 'work', 'deliver', taskId, 'result.json');
  fs.mkdirSync(path.dirname(result), { recursive: true }); fs.writeFileSync(result, '{"ok":true}');
  for (const query of [{ taskId }, taskId]) {
    const value = await h.ask('o11', 'check-delivery', query);
    assert.equal(value.ok, true, JSON.stringify(value));
    assert.deepEqual(h.run.calls.at(-1).args, ['check-delivery', '--result', result]);
    assert.deepEqual([value.taskId, value.result], [taskId, result]);
  }
  const missing = await h.ask('o11', 'check-delivery', { taskId: 'ffffffffffffffffffffffffffffffff' });
  assert.equal(missing.code, 'TASK_RESULT_NOT_FOUND');
  assert.deepEqual(missing.continuation, { tool: 'ssam_task', arguments: { id: 'ffffffffffffffffffffffffffffffff' }, why: missing.continuation.why });
  assert.equal((await h.ask('o11', 'check-delivery', { taskId: '..\\..\\x' })).code, 'BAD_VALUE', 'never a path');
  assert.equal((await h.ask('o11', 'check-delivery', { taskId, result })).code, 'QUERY_SHAPE');
  // the absolute path still works
  assert.equal((await h.ask('o11', 'check-delivery', result)).ok, true);
});

test('recipe {find, ops:true} without max gets the default bound, on both lanes', async t => {
  const h = await harness(t);
  const value = await h.ask('o11', 'recipe', { find: 'javascript', ops: true });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(h.run.calls[0].args, ['recipe', '--find', 'javascript', '--ops', '--max', String(RECIPE_OPS_MAX)]);
  assert.equal(value.maxDefaulted, RECIPE_OPS_MAX);
  assert.deepEqual(referenceArguments('o11', 'recipe', { find: 'x', ops: true, max: 3 }, { root: h.root }).argv, ['recipe', '--find', 'x', '--ops', '--max', '3']);
  assert.deepEqual(referenceArguments('o11', 'recipe', { find: 'x' }, { root: h.root }).argv, ['recipe', '--find', 'x'], 'no ops, no bound');
});

test('an unknown query field answers the closest valid form, already filled', async t => {
  const h = await harness(t);
  const api = await h.ask('o11', 'api', { find: 'IServerAction' });
  assert.equal(api.code, 'UNKNOWN_FIELD');
  assert.deepEqual(api.closest, { name: 'IServerAction' });
  assert.deepEqual(api.continuation.arguments, { lane: 'o11', kind: 'api', query: { name: 'IServerAction' } });
  assert.match(api.error, /find -> name/);
  const recipe = await h.ask('o11', 'recipe', { search: 'crud', withOps: true });
  assert.deepEqual(recipe.closest, { find: 'crud', ops: true });
  const extra = await h.ask('o11', 'functions', { name: 'AddDays', bogusField: 1 });
  assert.deepEqual([extra.code, extra.closest, extra.dropped], ['UNKNOWN_FIELD', { name: 'AddDays' }, ['bogusField']]);
  assert.equal(h.run.calls.length, 0, 'nothing ran');
  // pure: find stays a search where the kind has find; a typo goes to the closest field
  assert.deepEqual(closestForm({ search: 'date' }, ['name', 'find']).form, { find: 'date' });
  assert.deepEqual(closestForm({ nmae: 'X' }, ['name', 'op', 'type']).form, { name: 'X' });
});
