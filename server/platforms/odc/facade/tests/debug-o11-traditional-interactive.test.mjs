import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { invokePrivateTraditional } from '../debug-o11-traditional-worker.mjs';
import { compileTraditionalEntry, compileTraditionalPreparation } from '../debug-o11-traditional.mjs';
import { prepareTraditionalInteractive, traditionalInspectionScopes } from '../debug-o11-traditional-interactive.mjs';
import { native, actionContract, block, screenPage, html, workerFixture, original, inspectionFake, k } from './fixtures/debug-o11-traditional-action-fixture.mjs';

function interactive(t, contract = actionContract()) {
  const w = workerFixture(t, contract), order = [], plan = compileTraditionalEntry(w.contract);
  const owner = { target: { ...w.contract.binding }, snapshot: w.contract.sourceContract, versionId: w.contract.binding.revision };
  const trace = { server: { allowed: true, module: w.contract.binding.module, moduleKey: w.contract.binding.moduleKey, functionKey: plan.entry.key, startNodeKey: plan.entry.startNodeKey, nodeKeys: [plan.entry.startNodeKey] } };
  const requestDeadline = new Date(Date.now() + 120000).toISOString();
  const services = {
    prepareServerInspection: async binding => { order.push(['prepare', binding.functionKey, binding.derivedScopes.map(s => s.functionKey)]); },
    beforeServerInvocation: async info => { order.push(['before', info.requestId, Number.isFinite(info.nativeDeadlineAt)]); },
    afterServerInvocation: info => { order.push(['after', info.requestId]); },
    invokeTraditional: async (request, options) => { order.push(['invoke', request.inspectionExpiresAt === requestDeadline, options.inspection === services.inspectionEvents]);
      return invokePrivateTraditional(request, { vault: w.vault, fetchImpl: original([], async (url, o) => { order.push(['post', o.method]); return html('<html>done</html>'); }, screenPage()) }); },
    inspectionEvents: inspectionFake(),
  };
  return { ...w, order, plan, owner, trace, services, requestDeadline,
    contractFor: input => ({ input: { timeoutSeconds: 5, inputs: {}, ...input }, trace, source: w.contract, plan, owner, captures: [owner],
      root: w.input.root, directory: w.input.directory, operationId: w.input.operationId }) };
}

test('interactive server inspection binds Preparation (screen + blocks) and action scopes before the original GET', async t => {
  const f = interactive(t);
  const scopes = traditionalInspectionScopes(f.contract, f.plan);
  assert.deepEqual(scopes.map(s => [s.role, s.functionKey, s.nodeKeys[0]]), [
    ['screen-preparation', 'dEWwXGH7NkeApGZ+qJiYJQ.#Preparation', 'Ve1jm59P106LICsn2yCOBA'],
    ['block-preparation', k('HeaderBlk') + '.#Preparation', k('HeaderStart')],
    ['screen-action', k('SaveAction'), k('SaveStart')]]);
  assert.deepEqual(scopes[1].roots, ['Title', 'Expanded', 'GetItems']); assert.ok(scopes[2].roots.includes('GetContact'));
  const session = await prepareTraditionalInteractive(f.contractFor({}), f.services);
  assert.deepEqual(f.order, [['prepare', 'dEWwXGH7NkeApGZ+qJiYJQ.#Preparation', scopes.map(s => s.functionKey)]], 'scopes bound before any request');
  assert.deepEqual(Object.keys(session.traceScopes), scopes.map(s => s.functionKey));
  const reply = await session.invoke({ index: 0, scenario: { values: {} }, descriptor: f.input.descriptor, requestDeadline: f.requestDeadline });
  assert.equal(reply.ok, true, reply.error);
  assert.deepEqual(f.order.slice(1).map(e => e[0]), ['before', 'invoke', 'post', 'after']);
  assert.deepEqual(f.order[1], ['before', 'scenario-0', true]); assert.deepEqual(f.order[2], ['invoke', true, true]);
});

test('a traditional-preparation entry binds its same-module block Preparations (nested included) before the original GET', async t => {
  const contract = structuredClone(native.contract), outer = block(contract.screen, { id: 'Outer' });
  const inner = block(contract.screen, { id: 'Inner', owner: outer.block });
  const f = interactive(t, { ...contract, blocks: [outer, inner] });
  assert.equal(f.plan.screenAction, undefined);
  assert.deepEqual(f.plan.preparations.map(p => [p.kind, p.key]), [['screen', contract.preparation.key], ['block', k('OuterBlk') + '.#Preparation'], ['block', k('InnerBlk') + '.#Preparation']]);
  await prepareTraditionalInteractive(f.contractFor({}), f.services);
  assert.deepEqual(f.order, [['prepare', contract.preparation.key, [contract.preparation.key, k('OuterBlk') + '.#Preparation', k('InnerBlk') + '.#Preparation']]]);
  // An instance owned by an unread block is not a rendered block of this screen.
  const stray = block(contract.screen, { id: 'Stray', owner: { kind: 'WebBlock', name: 'Unread', key: k('Unread'), path: 'WebFlow:Common/WebBlock:Unread' } });
  assert.throws(() => compileTraditionalPreparation({ ...contract, blocks: [stray] }), /traditional_model_binding_invalid/);
});

test('interactive Traditional keeps the owner-state refusal, app-user only, and needs an allowed server trace', async t => {
  const f = interactive(t, structuredClone(native.contract));
  await assert.rejects(prepareTraditionalInteractive(f.contractFor({ context: { session: 'x' } }), f.services), /^Error: debug_o11_native_traditional_owner_state_unsupported$/);
  await assert.rejects(prepareTraditionalInteractive(f.contractFor({ scenarios: [{ inputs: {}, context: {} }] }), f.services), /^Error: debug_o11_native_traditional_owner_state_unsupported$/);
  await assert.rejects(prepareTraditionalInteractive(f.contractFor({ contextMode: 'anonymous' }), f.services), /^Error: debug_o11_native_context_mode_unsupported$/);
  await assert.rejects(prepareTraditionalInteractive({ ...f.contractFor({}), trace: { server: { ...f.trace.server, allowed: false } } }, f.services), /debug_o11_native_server_inspection_trace_required/);
  await assert.rejects(prepareTraditionalInteractive(f.contractFor({}), { ...f.services, beforeServerInvocation: undefined }), /debug_o11_native_traditional_interactive_services_required/);
  assert.deepEqual(f.order, [], 'no scope bound and no request after a refusal');
  const session = await prepareTraditionalInteractive(f.contractFor({}), f.services);
  assert.deepEqual(session.scopes.map(s => s.role), ['screen-preparation']);
});
