// T2 of the CX15 review (C:\t\revisoes\cx15\REVISAO.md, "Porte hospedado"): the hosted line still runs the delete engines
// of before CX15, where one call deletes (seven applications in the incident replay, with confirmHost only). Until the
// two-step destructive protocol is ported, every hosted call that deletes, or may delete, something of the licensee's
// environment or tenant is refused at the gate (hosted/policy.mjs wrapHostedTool, switch HOSTED_DESTRUCTIVE='refuse'):
// HOSTED_UNAVAILABLE, cause DESTRUCTIVE_HOSTED_OFF, outcome not-sent, no continuation, before the agent, any path, any
// read and any send. hosted/destructive.mjs hostedDestructive(name, args) is the single classification; the hosted
// listing says which part of each tool is off (hostedListing). Fakes only: no hub, agent, Studio, network or child process.
// Correction 1 of its review (C:\t\revisoes\hosted-destructive-off\REVISAO.md): F1, revoking access by a *ToRemove body or
// an o11_access manifest is refused like the DELETE of it; F2, an oracle independent of the classifier's tables; F3, a call
// without its selector gets the input layer's INPUT_INVALID, not "deleting is off".
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

// Nothing of this machine is reached: child processes and TCP/pipe connections are spies installed before any facade module.
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const net = require('node:net');
const spawned = [], connections = [];
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; }
  if (typeof options === 'function') callback = options;
  spawned.push({ file, args });
  setImmediate(() => callback?.(new Error('no child process in this test'), '', ''));
  return { stdin: { end() {} }, on() {}, once() {}, unref() {}, kill() {}, pid: 0 };
};
cp.spawn = (file, args) => { spawned.push({ file, args, spawn: true }); throw new Error('spawn is not allowed in this test'); };
net.createConnection = (...args) => { connections.push(args); throw new Error('no TCP or pipe connection in this test'); };
syncBuiltinESMExports();

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const policy = await import('../hosted/policy.mjs');
const { wrapHostedTool, hostedTools } = policy;
// Loaded softly: before the stopgap the module does not exist, and every test below fails on its own assertion.
const destructive = await import('../hosted/destructive.mjs').catch(error => ({ loadError: error }));
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const { PORTAL_READS, PORTAL_WRITES } = await import('../../portal/runtime/portal-routes.mjs');
const { DEPLOY, effectOf } = await import('../../portal/runtime/effects.mjs');
const { Catalog, resolveRef } = await import('../../portal/runtime/catalog.mjs');
const { DELETE_ACTIONS } = await import('../service-center/delete.mjs');
const serviceCenter = await import('../service-center/index.mjs');
const { ENVIRONMENT_WRITES } = await import('../o11-environment.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const classify = (name, args) => {
  assert.equal(typeof destructive.hostedDestructive, 'function', 'hosted/destructive.mjs exports hostedDestructive: ' + (destructive.loadError?.message ?? ''));
  return destructive.hostedDestructive(name, args);
};
// The words of every refusal: synthetic.
const WORDS = 'sim, apaga os 7 do ZZRV';
const HOST = 'zz-licensee.example.test';
const TENANT = 'zz-tenant.example.test';
const ASSET = '11111111-1111-4111-8111-111111111111';
// What deletes (or may delete) and what does not, per family. [tool, arguments, destructive?]
const CASES = [
  // Service Center: the delete engine, its aliases, the page and Studio API deletes; the incident call and its retry.
  ['o11_service_center_write', { action: 'delete', prefix: 'ZZRV', words: WORDS, host: HOST }, true],
  ['o11_service_center_write', { action: 'delete', prefix: 'ZZRV', words: WORDS, host: HOST, confirmHost: HOST }, true],
  ['o11_service_center_write', { action: 'application-delete', applications: ['ZZRV One'], words: WORDS }, true],
  ['o11_service_center_write', { action: 'module-delete', modules: ['ZZRV_CS'], words: WORDS }, true],
  ['o11_service_center_write', { action: 'extension-delete', extensions: ['ZZRVExt'], words: WORDS }, true],
  ['o11_service_center_write', { action: 'solution-delete', solution: 'ZZRV', execute: true, operationId: randomUUID(), words: WORDS }, true],
  ['o11_service_center_write', { action: 'db-connection-delete', connection: 'ZZRV', execute: true, operationId: randomUUID(), words: WORDS }, true],
  ['o11_service_center_write', { action: ' DELETE ', prefix: 'ZZRV', words: WORDS }, true],
  ['o11_service_center_write', { action: 'timer-run', prefix: 'ZZRV' }, true],
  ['o11_service_center_write', { prefix: 'ZZRV', words: WORDS }, true],
  ['o11_service_center_write', { action: 'timer-run', name: 'ZZTimer', moduleId: '7' }, false],
  ['o11_service_center_write', { action: 'property-set', name: 'ZZProp', value: 'x' }, false],
  ['o11_service_center_write', { action: 'discard', operationId: randomUUID(), words: WORDS }, false],
  ['o11_service_center_write', { action: 'verify', operationId: randomUUID() }, false],
  ['o11_service_center_write', { action: 'solution-remove-component', solution: 'ZZ', component: 'ZZ_CS' }, false],
  ['o11_environment', { action: 'delete-app', app: 'ZZRV One', authorize: WORDS }, true],
  ['o11_environment', { action: 'Delete-App', app: 'ZZRV One' }, true],
  ['o11_environment', { action: 'inventory' }, false],
  ['o11_environment', { action: 'create-module', app: 'ZZ', name: 'ZZ_CS', replace: true }, false],
  // Data: a delete alone or in a batch, a request that cannot be read, an operation that is not one of the four writes/reads.
  ['o11_data', { host: HOST, module: 'M', oml: 'ws:o11/M.oml', request: { operation: 'delete', entity: 'E', ids: ['1'] } }, true],
  ['o11_data', { request: { batch: [{ step: 'a', operation: 'insert', entity: 'E', records: [{}] }, { step: 'b', operation: 'delete', entity: 'E', ids: ['1'] }] } }, true],
  ['o11_data', { request: '{"operation":"delete","entity":"E","ids":["1"]}' }, true],
  ['o11_data', { request: '{"operation":"delete",' }, true],
  ['o11_data', { request: 'ws:o11/data/requests/zz.json' }, true],
  ['o11_data', { request: { batch: 'delete' } }, true],
  ['o11_data', { request: { batch: [null] } }, true],
  ['o11_data', { request: { operation: 'DELETE', entity: 'E', ids: ['1'] } }, true],
  ['o11_data', { request: { operation: 'purge', entity: 'E' } }, true],
  ['o11_data', { request: { operation: 7, entity: 'E' } }, true],
  ['o11_data', { request: { operation: 'read', entity: 'E' } }, false],
  ['o11_data', { request: { batch: [{ step: 'a', operation: 'insert', entity: 'E', records: [{}] }, { step: 'b', operation: 'update', entity: 'E', records: [{}] }] } }, false],
  ['o11_data', { request: '{"operation":"read-all","entity":"E"}' }, false],
  ['o11_data', { request: {} }, false],
  ['studio_data_delete', { module: 'M', entity: 'E', ids: [1], authorize: WORDS }, true],
  ['studio_data_delete', {}, true],
  ['studio_data_insert', { module: 'M', entity: 'E', recordsFile: 'ws:inbox/r.json', authorize: WORDS }, false],
  ['studio_data_update', { module: 'M', entity: 'E', recordsFile: 'ws:inbox/r.json', authorize: WORDS }, false],
  // studio_command: the four passthroughs of CX15 §6 line 8, the raw Portal fetch, however the command line is split.
  ['studio_command', { command: 'data-delete', args: ['M', 'E', '--ids', '1', '--authorize', WORDS] }, true],
  ['studio_command', { command: 'portal-call', args: ['ws:odc/journal/portal/requests/x.json', '--tenant', TENANT] }, true],
  ['studio_command', { command: 'portal-private-call', args: ['x.json'] }, true],
  ['studio_command', { command: 'portal-api-client-fixture-cleanup', args: ['x.json', '--tenant', TENANT] }, true],
  ['studio_command', { command: 'data-delete M E --ids 1 --authorize x' }, true],
  ['studio_command', { command: '  data-delete', args: ['M', 'E'] }, true],
  ['studio_command', { command: 'DATA-DELETE', args: ['M', 'E'] }, true],
  ['studio_command', { command: ' ', args: ['data-delete', 'M', 'E'] }, true],
  ['studio_command', { command: 'portal-session', args: ['fetch', 'x.json', '--tenant', TENANT] }, true],
  ['studio_command', { command: 'portal-session fetch x.json' }, true],
  ['studio_command', { command: 7 }, true],
  ['studio_command', { command: 'publish-log', args: ['Orders'] }, false],
  ['studio_command', { command: 'module-info', args: ['Orders'] }, false],
  ['studio_command', { command: 'portal-session', args: ['open', '--tenant', TENANT] }, false],
  ['studio_command', { command: 'close', args: ['Orders', '--discard'] }, false],
  // ODC public API: every DELETE of the catalog and Undeploy (effects.mjs effectOf), whatever the id spelling or body text.
  ['odc_write', { tenant: TENANT, operationId: 'asset-repository-api-v1:delete:/assets/{assetKey}', path: { assetKey: ASSET }, authorize: WORDS }, true],
  ['odc_write', { operationId: 'user-access-management-api-v1:delete:/users/{key}' }, true],
  ['odc_write', { operationId: 'zz-unknown-api-v9:DELETE:/zz' }, true],
  ['odc_write', { operationId: DEPLOY, body: { operation: 'Undeploy', assetKey: ASSET } }, true],
  ['odc_write', { operationId: DEPLOY, body: { operation: 'undeploy' } }, true],
  ['odc_write', { operationId: DEPLOY, body: '{"operation":"Undeploy"}' }, true],
  ['odc_write', { operationId: DEPLOY, body: '{"operation":' }, true],
  ['odc_write', { operationId: 'not-a-catalog-id' }, true],
  ['odc_write', { operationId: 7 }, true],
  ['odc_write', { operationId: DEPLOY, body: { operation: 'Deploy' } }, false],
  ['odc_write', { operationId: 'user-access-management-api-v1:patch:/organization-roles/{key}', path: { key: ASSET } }, false],
  ['odc_write', { operationId: 'dependency-management-api-v1:post:/deletion-analyses' }, false],
  ['odc_deploy', { operation: 'Undeploy', assetKey: ASSET, environmentKey: ASSET }, true],
  ['odc_deploy', { operation: 'UNDEPLOY' }, true],
  ['odc_deploy', { operation: ['Undeploy'] }, true],
  ['odc_deploy', { operation: 'Deploy' }, false],
  ['odc_deploy', { assetKey: ASSET }, false],
  ['odc_deploy', { operation: 'ApplyConfigs' }, false],
  // Internal Portal: the routes of effect 'destructive', and the raw selection saves that drop what their list omits (D).
  ['odc_portal_write', { operationId: 'apiClients.delete', input: {} }, true],
  ['odc_portal_write', { operationId: 'knowledgeBases.delete', input: {} }, true],
  ['odc_portal_write', { operationId: 'aiModels.trialDelete', input: {} }, true],
  ['odc_portal_write', { operationId: 'connections.delete', input: {} }, true],
  ['odc_portal_write', { operationId: 'agents.datasetDelete', input: {} }, true],
  ['odc_portal_write', { operationId: 'agents.evaluationDelete', input: {} }, true],
  ['odc_portal_write', { operationId: 'connections.importEntities', input: { inputParameters: { Entities: [{ IsSelected: true }] } } }, true],
  ['odc_portal_write', { operationId: 'connections.importActions', input: {} }, true],
  ['odc_portal_write', { operationId: 'zz.purgeEverything', input: {} }, true],
  ['odc_portal_write', { operationId: 7, input: {} }, true],
  ['odc_portal_write', { operationId: 'timers.run', input: {} }, false],
  ['odc_portal_write', { operationId: 'connections.relationalTest', input: {} }, false],
  ['odc_portal_write', { operationId: 'zz.unmapped', input: {} }, false],
  ['odc_external_db_connection', { action: 'delete', connectionId: 'c' }, true],
  ['odc_external_db_connection', { action: 'remove-entities', connectionId: 'c', objects: ['T'] }, true],
  ['odc_external_db_connection', { action: 'list' }, false],
  ['odc_external_db_connection', { action: 'import-entities', connectionId: 'c', objects: ['T'] }, false],
  ['odc_asset_delete', { tenant: TENANT, assetKey: ASSET, authorize: WORDS, operationUuid: randomUUID() }, true],
  ['odc_asset_delete', {}, true],
  ['odc_a2a_connection_delete', { tenant: TENANT, connectionId: ASSET }, true],
  ['o11_extension', { action: 'delete', extension: 'ZZExt' }, true],
  ['o11_extension', { action: 'publish' }, false],
  ['odc_external_library', { action: 'discard' }, true],
  ['odc_external_library', { action: 'build' }, false],
  // F1 of the review: the effect on the target, not the HTTP method. A body with a non-empty removal list (*ToRemove, or any
  // field named like a removal) removes access or members: destructive, whatever the operation, the body as object or text.
  ['odc_write', { operationId: 'user-access-management-api-v1:patch:/groups/{key}/users', body: { userKeysToAdd: [], userKeysToRemove: [ASSET] } }, true],
  ['odc_write', { operationId: 'user-access-management-api-v1:patch:/groups/{key}/application-roles', body: { applicationRoleKeysToAdd: [], applicationRoleKeysToRemove: [ASSET] } }, true],
  ['odc_write', { operationId: 'user-access-management-api-v1:patch:/groups/{key}/users', body: '{"userKeysToRemove":["' + ASSET + '"]}' }, true],
  ['odc_write', { operationId: 'user-access-management-api-v1:patch:/groups/{key}/users', body: '{"userKeysToRemove":["' + ASSET + '"' }, true],
  ['odc_write', { operationId: 'user-access-management-api-v1:patch:/groups/{key}/users', body: { UserKeysToRemove: ASSET } }, true],
  ['odc_write', { operationId: 'zz-unknown-api-v9:post:/zz', body: { wrapper: [{ itemsToDelete: ['a'] }] } }, true],
  ['odc_write', { operationId: 'user-access-management-api-v1:patch:/groups/{key}/users', body: { userKeysToAdd: [ASSET], userKeysToRemove: [] } }, false],
  ['odc_write', { operationId: 'user-access-management-api-v1:patch:/groups/{key}/users', body: { userKeysToAdd: [ASSET] } }, false],
  ['odc_write', { operationId: 'user-access-management-api-v1:patch:/groups/{key}/application-roles', body: { applicationRoleKeysToAdd: [ASSET], applicationRoleKeysToRemove: null } }, false],
  ['odc_write', { operationId: 'user-access-management-api-v1:patch:/groups/{key}/users', body: '{"userKeysToAdd":["' + ASSET + '"]}' }, false],
  // F3 of the review: a selector left out is no reading of a deletion (the input layer answers INPUT_INVALID with the
  // correction and runs nothing); a selector present with a value that cannot be read stays refused (fail closed).
  ['odc_write', { operation_id: 'asset-repository-api-v1:post:/assets', body: {} }, false],
  ['odc_write', { operation_id: 'asset-repository-api-v1:delete:/assets/{assetKey}' }, false],
  ['odc_write', { body: {} }, false],
  ['odc_write', { operationId: null }, false],
  ['odc_write', { operationId: '' }, true],
  ['odc_portal_write', { operationID: 'timers.run', input: {} }, false],
  ['odc_portal_write', { input: {} }, false],
  ['studio_command', { cmd: 'module-info' }, false],
  ['studio_command', { cmd: 'data-delete', args: ['M', 'E'] }, false],
  ['studio_command', { command: 'module-info', args: 'Orders' }, false],
  ['studio_command', { command: 'module-info', args: 'data-delete M E --ids 1' }, true],
  ['studio_command', { command: ' ', args: 'data-delete M E' }, true],
  ['studio_command', { command: 'module-info', args: [7, { x: 'data-delete' }] }, true],
  ['studio_command', { command: 'module-info', args: [7] }, false],
  // Outside the family (CX15 §6, the owner decides): no deletion of the environment or tenant.
  ['o11_deliver', { job: { ops: [] }, patch: [{ op: 'remove', path: '/ops/0' }] }, false],
  ['studio_close', { module: 'Orders', discard: true }, false],
  ['ssam_task', {}, false],
  ['ssam_doctor', {}, false],
  ['odc_read', { operationId: 'asset-repository-api-v1:get:/assets/{assetKey}' }, false],
];

test('hostedDestructive classifies every family: what deletes or may delete is true, everything else false', () => {
  const wrong = CASES.filter(([name, args, want]) => classify(name, args) !== want).map(([name, args, want]) => `${name} ${JSON.stringify(args)} -> expected ${want}`);
  assert.deepEqual(wrong, []);
  // Never throws, whatever the arguments: the gate treats a throw as destructive anyway.
  for (const name of Object.keys(hostedTools())) for (const args of [undefined, null, 7, 'x', [], {}]) assert.equal(typeof classify(name, args), 'boolean', name);
});

// ---- the gate: before the lane, the agent, any path, read or send; one refusal, no continuation
const spyLink = ({ connected = true } = {}) => {
  const touched = [];
  const link = new Proxy({}, { get(_, key) { touched.push(String(key)); if (key === 'connected') return () => connected;
    if (key === 'info') return () => ({ connected, credential: true, compatible: { odc: { ok: true }, o11: { ok: true } } });
    if (key === 'waitConnected') return async () => connected; return undefined; } });
  return { link, touched };
};
function harness({ connected = true, lanes = ['odc', 'o11'], destructiveSwitch } = {}) {
  const workspace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-destructive-')), 'customers', 'tok_zz');
  fs.mkdirSync(workspace, { recursive: true });
  const { link, touched } = spyLink({ connected });
  const executorCalls = [];
  const executor = new Proxy({ id: 'fake', hosted: true }, { get(target, key) {
    if (key in target) return target[key];
    executorCalls.push(String(key));
    if (key === 'o11Connection') return () => ({ pid: 6001 });
    if (key === 'quota') return { full: () => false };
    return async (...args) => { executorCalls.push(String(key) + ':called'); return {}; };
  } });
  const context = { id: 'ctx', hosted: true, tokenId: 'tok_zz', customer: 'ZZ', lanes, workspace, agent: link, executor, close: async () => {} };
  const calls = [];
  const gate = name => {
    const handler = async args => { calls.push({ name, args }); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; };
    const wrapped = wrapHostedTool(name, { inputSchema: {} }, handler, { context, link, lanes, run: (ctx, fn) => fn(),
      ...(destructiveSwitch ? { destructive: destructiveSwitch } : {}) });
    return args => wrapped(args, { requestId: 1 });
  };
  return { gate, calls, touched, executorCalls, workspace };
}
const valueOf = result => result.structuredContent;

test('every destructive call is refused at the gate: HOSTED_UNAVAILABLE / DESTRUCTIVE_HOSTED_OFF, not-sent, no continuation, nothing touched', async () => {
  assert.equal(policy.HOSTED_DESTRUCTIVE, 'refuse', 'the switch of the hosted line, refuse by default');
  for (const [name, args] of CASES.filter(c => c[2])) {
    const h = harness();
    const result = await h.gate(name)(args);
    const value = valueOf(result) ?? {};
    assert.equal(result.isError, true, name + ' ' + JSON.stringify(args));
    if (hostedTools()[name].class === 'unavailable') {
      // A tool unavailable on hosted servers (o11_extension, odc_external_library) answers its own HOSTED_UNAVAILABLE first.
      assert.equal(value.code, 'HOSTED_UNAVAILABLE', name); assert.deepEqual(h.calls, [], name); assert.deepEqual(h.touched, [], name);
      continue;
    }
    assert.deepEqual({ ok: value.ok, code: value.code, cause: value.cause, policy: value.policy, tool: value.tool, outcome: value.outcome },
      { ok: false, code: 'HOSTED_UNAVAILABLE', cause: 'DESTRUCTIVE_HOSTED_OFF', policy: 'HOSTED_DESTRUCTIVE', tool: name, outcome: 'not-sent' }, name + ' ' + JSON.stringify(args));
    assert.equal('continuation' in value, false, name + ': no continuation, no workaround');
    assert.equal('alternatives' in value || 'next' in value, false, name);
    assert.deepEqual(h.calls, [], name + ': the handler never runs');
    assert.deepEqual(h.touched, [], name + ': the agent link is never consulted');
    assert.deepEqual(h.executorCalls, [], name + ': no path brought, no quota, no O11 record, no send');
    assert.equal(JSON.stringify(result).includes(WORDS), false, name + ': the words never come back');
    assert.equal(fs.readdirSync(h.workspace).length, 0, name + ': nothing written in the workspace');
  }
});

test('the refusal tells the model, in English and pt-BR, that the user deletes in Service Center or the ODC Portal', async () => {
  const value = valueOf(await harness().gate('o11_service_center_write')({ action: 'delete', prefix: 'ZZRV', words: WORDS }));
  assert.match(value.error, /hosted SSAM server/);
  assert.match(value.error, /Service Center/);
  assert.match(value.error, /ODC Portal/);
  assert.match(value.error, /SSAM hospedado/);
  assert.match(value.error, /Portal do ODC/);
  assert.match(value.error, /nothing was read, reserved or sent/);
  assert.match(value.error, /nada foi lido, reservado nem enviado/);
  assert.equal(typeof destructive.destructiveUnavailable, 'function');
  assert.deepEqual(destructive.destructiveUnavailable('o11_service_center_write'), value, 'the gate answers destructiveUnavailable as is');
});

test('the refusal comes before the agent: disconnected agent, lane outside the token and an agent: path change nothing', async () => {
  const offline = harness({ connected: false });
  assert.equal(valueOf(await offline.gate('odc_asset_delete')({ assetKey: ASSET, authorizationContext: 'agent:inbox/approval.json' })).cause, 'DESTRUCTIVE_HOSTED_OFF');
  assert.deepEqual(offline.touched, []); assert.deepEqual(offline.executorCalls, []);
  const odcOnly = harness({ lanes: ['odc'] });
  assert.equal(valueOf(await odcOnly.gate('o11_environment')({ action: 'delete-app', app: 'ZZRV One' })).cause, 'DESTRUCTIVE_HOSTED_OFF');
  // The incident replay: the first call and the retry with confirmHost are both refused; nothing is ever sent.
  const replay = harness();
  for (const extra of [{}, { confirmHost: HOST }])
    assert.equal(valueOf(await replay.gate('o11_service_center_write')({ action: 'delete', prefix: 'ZZRV', words: WORDS, host: HOST, ...extra })).cause, 'DESTRUCTIVE_HOSTED_OFF');
  assert.deepEqual(replay.calls, []);
});

test('R1: the rule reads the arguments the tool runs and the ones sent; either one deleting is refused', async () => {
  const h = harness();
  const { link } = spyLink();
  const handler = async () => ({ content: [], structuredContent: { ok: true } });
  const renamed = wrapHostedTool('o11_service_center_write', { inputSchema: {} }, handler, { context: { id: 'c', hosted: true, lanes: ['o11'], workspace: h.workspace, executor: {} }, link, lanes: ['o11'],
    argsOf: raw => ({ ...raw, action: raw.actin }) });
  assert.equal(valueOf(await renamed({ actin: 'delete', prefix: 'ZZRV' }, {})).cause, 'DESTRUCTIVE_HOSTED_OFF', 'a renamed field runs as action: delete');
  const hidden = wrapHostedTool('odc_deploy', { inputSchema: {} }, handler, { context: { id: 'c', hosted: true, lanes: ['odc'], workspace: h.workspace, executor: {} }, link, lanes: ['odc'],
    argsOf: raw => ({ ...raw, operation: 'Deploy' }) });
  assert.equal(valueOf(await hidden({ operation: 'Undeploy' }, {})).cause, 'DESTRUCTIVE_HOSTED_OFF', 'the arguments sent say Undeploy');
});

test('non-destructive calls are untouched: they reach the handler as before', async () => {
  for (const [name, args] of CASES.filter(c => !c[2])) {
    const h = harness();
    const result = await h.gate(name)(args);
    assert.notEqual(valueOf(result)?.cause, 'DESTRUCTIVE_HOSTED_OFF', name + ' ' + JSON.stringify(args));
  }
  for (const [name, args] of [['o11_service_center_write', { action: 'timer-run', name: 'ZZTimer', moduleId: '7' }], ['odc_deploy', { operation: 'Deploy' }],
    ['odc_portal_write', { operationId: 'timers.run', input: {} }], ['o11_data', { host: HOST, module: 'M', oml: 'ws:o11/M.oml', request: { operation: 'read', entity: 'E' } }]]) {
    const h = harness();
    assert.notEqual((await h.gate(name)(args)).isError, true, name);
    assert.equal(h.calls.length, 1, name + ' ran');
  }
});

test('the switch: HOSTED_DESTRUCTIVE allow (the CX15 port) lets a destructive call reach the handler', async () => {
  const h = harness({ destructiveSwitch: 'allow' });
  await h.gate('odc_deploy')({ operation: 'Undeploy' });
  assert.equal(h.calls.length, 1);
});

// ---- completeness: every tool and action of the hosted catalog that can delete is classified
// Words that name a deletion. A new action, route, operation or command spelled with one of them is refused unless it is
// listed in KEPT below with the reason it deletes nothing of the licensee's environment or tenant.
const DELETE_WORDS = /delet|remov|undeploy|purg|drop|destroy|discard|wipe|truncat|erase|clean|uninstall/i;
const KEPT = {
  o11_service_center_write: { discard: 'closes an uncertain receipt of the local journal; nothing is sent',
    'solution-remove-component': 'takes a component out of a solution list; the module stays (CX15 §6, outside the family)' },
  odc_operation_status: { 'deletion-analysis': 'reads a deletion analysis' },
  o11_deliver: { remove: 'a JSON patch op of the job (element removal in a module version; CX15 §6, outside the family)' },
  studio_deliver: { remove: 'a JSON patch op of the job (as o11_deliver)' },
  o11_job: { remove: 'a JSON patch op of a fixture proof' },
  ssam_job: { remove: 'a JSON patch op of a fixture proof' },
};
// Refused on a hosted server though no deletion is named, each with its reason (the owner may change it).
const OFF_FOR_NOW = {
  'o11_access /action=apply': 'NEW-1 of review 2: the gate could not pin the manifest bytes the kernel reads (TOCTOU); every apply is off until the sha256 pin (after 19/10)',
};
// Tools the MCP annotations mark destructive (they overwrite or publish) that delete nothing of the environment or tenant.
// o11_access is no longer here (F1 of the review): an apply whose manifest revokes is refused once the manifest is read.
const OVERWRITES_ONLY = {
  o11_deliver: 'merges a job into the open module', o11_publish: 'publishes the open module',
  studio_data_insert: 'inserts records', studio_data_update: 'updates records', studio_close: 'discard closes after a snapshot (CX15 §6)',
  studio_refresh_references: 'refreshes references', studio_dismiss_dialog: 'answers a dialog', studio_merge: 'merges a manifest',
  studio_publish: 'publishes', studio_create: 'creates a module', studio_create_app: 'creates an app', studio_deliver: 'merges a job',
  odc_mcp_import: 'imports tools, preserving the existing ones', odc_asset_revision: 'adds a revision (unavailable hosted)',
  odc_configurations: 'patches settings',
};
const alternatives = node => !node || typeof node !== 'object' ? [] : [node, ...[...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])].flatMap(alternatives)];
function enumValues(schema) {
  const out = [];
  const walk = (node, pointer, depth) => {
    if (depth > 6) return;
    for (const alt of alternatives(node)) {
      for (const value of alt.enum ?? []) if (typeof value === 'string') out.push({ pointer, value });
      for (const [key, child] of Object.entries(alt.properties ?? {})) walk(child, pointer + '/' + key, depth + 1);
      if (alt.items) walk(alt.items, pointer + '/*', depth + 1);
    }
  };
  walk(schema, '', 0);
  return out;
}
const argsAt = (pointer, value) => {
  const segments = pointer.split('/').slice(1);
  const build = i => i === segments.length ? value : segments[i] === '*' ? [build(i + 1)] : { [segments[i]]: build(i + 1) };
  return build(0);
};
const fakeContext = () => {
  const workspace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-destructive-ws-')), 'customers', 'tok_zzlist');
  prepareWorkspace(workspace);
  const executor = { id: 'fake-' + randomUUID(), hosted: true, calls: [], async call(kind) { this.calls.push(kind); throw Object.assign(new Error('no ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); },
    o11Connection: () => ({ pid: 6001 }), relayPort: () => null, quota: { full: () => false }, async close() {} };
  const agent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, credential: true, compatible: { odc: { ok: true }, o11: { ok: true } } }) };
  return { id: randomUUID(), hosted: true, tokenId: 'tok_zzlist', customer: 'ZZ', lanes: ['odc', 'o11'], workspace, agent, executor, o11: { lane: 'o11' }, close: async () => {} };
};
async function listing(server) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-destructive-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, tools: new Map((await client.listTools()).tools.map(t => [t.name, t])), close: async () => { await client.close(); await server.close(); } };
}
let hostedServer = null;
async function hostedListing() {
  if (hostedServer) return hostedServer;
  process.env.SSAM_APP_HOOK_TOOLS = '1';
  const context = fakeContext();
  const server = await runWithExecutor(context, () => createSsamServer({ hosted: { context, session: { agent: context.agent, lanes: context.lanes } } }));
  hostedServer = { ...(await listing(server)), context };
  return hostedServer;
}
test.after(async () => { await hostedServer?.close(); });

// An enum value of another argument is probed inside a call that deletes nothing (a selector left out fails closed).
const BASE = { o11_service_center_write: { action: 'timer-run' }, odc_write: { operationId: 'user-access-management-api-v1:patch:/organization-roles/{key}' },
  odc_portal_write: { operationId: 'timers.run' }, studio_command: { command: 'module-info' } };
// Arguments only a delete takes: any value of them makes the call a delete (o11-operations.mjs serviceCenterArguments).
const DELETE_ONLY_ARGS = { o11_service_center_write: ['applications', 'modules', 'extensions', 'prefix', 'prefixKind', 'maxDeletes'] };
// Every probe of the hosted catalog: the enum values of each tool's schema, the whole tool, and the free-text selectors
// with their server tables (the ODC catalog, PORTAL_WRITES, the bridge commands).
const bridgeCommands = () => [...fs.readFileSync(path.join(HERE, '..', '..', 'studio', 'bridge', 'StartupHook.cs'), 'utf8')
  .matchAll(/^\s*"([a-z][a-z0-9-]*)" => await /gm)].map(m => m[1]);
async function probes() {
  const { tools } = await hostedListing();
  const out = [];
  for (const name of Object.keys(hostedTools())) {
    out.push({ name, args: {}, label: name + ' (no arguments)', wordy: DELETE_WORDS.test(name) });
    const schema = tools.get(name)?.inputSchema;
    for (const { pointer, value } of enumValues(schema)) out.push({ name, args: { ...(BASE[name] ?? {}), ...argsAt(pointer, value) }, label: name + ' ' + pointer + '=' + value, value,
      key: pointer.split('/')[1], wordy: DELETE_WORDS.test(value) });
  }
  return out;
}

test('completeness: every enum value of the hosted catalog named like a deletion is refused (or KEPT with a reason); the rest is not', async () => {
  const { tools } = await hostedListing();
  assert.deepEqual(Object.keys(hostedTools()).filter(n => n !== 'ssam_friction' && !tools.has(n)), [], 'the hosted server lists every classified tool (ssam_friction is added by the served mode)');
  const unclassified = [], overRefused = [];
  for (const probe of await probes()) {
    const kept = probe.value !== undefined && KEPT[probe.name]?.[probe.value];
    const got = classify(probe.name, probe.args);
    const whole = probe.value === undefined;
    const want = (probe.wordy && !kept) || Boolean(DELETE_ONLY_ARGS[probe.name]?.includes(probe.key));
    if (want && !got) unclassified.push(probe.label);
    if (!want && got && !whole && !(probe.name.endsWith('_delete'))) overRefused.push(probe.label);
    if (kept) assert.equal(got, false, probe.label + ' is KEPT: ' + kept);
  }
  assert.deepEqual(unclassified, [], 'a destructive action without classification');
  assert.deepEqual(overRefused, Object.keys(OFF_FOR_NOW), 'an action that names no deletion is refused (only the ones OFF_FOR_NOW, with their reason)');
  // Whole-tool deletes: every hosted tool named like a deletion is refused whatever its arguments.
  assert.deepEqual(Object.keys(hostedTools()).filter(n => DELETE_WORDS.test(n)).sort(), ['odc_a2a_connection_delete', 'odc_asset_delete', 'studio_data_delete']);
  for (const name of ['odc_a2a_connection_delete', 'odc_asset_delete', 'studio_data_delete']) assert.equal(classify(name, {}), true, name);
});

test('completeness: the server tables (Service Center deletes, delete-app, every catalog DELETE, Undeploy, Portal destructive routes, bridge commands)', () => {
  // Service Center: the delete engine with its aliases and index.mjs DESTRUCTIVE (page and Studio API deletes).
  assert.ok(serviceCenter.DESTRUCTIVE instanceof Set, 'service-center/index.mjs exports DESTRUCTIVE');
  const scDeletes = [...new Set([...DELETE_ACTIONS, ...(serviceCenter.DESTRUCTIVE ?? [])])].sort();
  assert.deepEqual(scDeletes, ['application-delete', 'db-connection-delete', 'delete', 'extension-delete', 'module-delete', 'solution-delete']);
  for (const action of scDeletes) assert.equal(classify('o11_service_center_write', { action }), true, action);
  for (const action of serviceCenter.WRITES.filter(a => !scDeletes.includes(a))) assert.equal(classify('o11_service_center_write', { action }), false, action);
  assert.deepEqual(serviceCenter.WRITES.filter(a => DELETE_WORDS.test(a) && !scDeletes.includes(a)), ['solution-remove-component'], 'the only other removal is KEPT');
  // o11_environment: its one destructive write.
  assert.deepEqual(ENVIRONMENT_WRITES.filter(a => classify('o11_environment', { action: a })), ['delete-app']);
  assert.deepEqual(ENVIRONMENT_WRITES.filter(a => DELETE_WORDS.test(a)), ['delete-app']);
  // odc_write: the effect of every catalogued operation (effects.mjs effectOf) decides; the id carries the method. This and
  // the PORTAL_WRITES loop below only check that the classifier reads its tables exactly (nothing else refused, nothing
  // dropped); whether the tables miss a removal is proven by the independent oracle of F2, at the end of this file.
  const catalog = new Catalog();
  let destructiveOps = 0;
  for (const op of catalog.operations.values()) {
    assert.equal(op.id.split(':')[1], op.method.toLowerCase(), op.id + ': the id carries the method');
    const want = effectOf(op, {}) === 'destructive';
    destructiveOps += want ? 1 : 0;
    assert.equal(classify('odc_write', { operationId: op.id }), want, op.id);
  }
  assert.ok(destructiveOps > 10, 'the catalog has its DELETE operations: ' + destructiveOps);
  assert.equal(effectOf(catalog.operations.get(DEPLOY), { operation: 'Undeploy' }), 'destructive');
  assert.equal(classify('odc_write', { operationId: DEPLOY, body: { operation: 'Undeploy' } }), true);
  assert.equal(classify('odc_write', { operationId: DEPLOY, body: { operation: 'Deploy' } }), false);
  // odc_portal_write: every listed route by its effect, plus the raw selection saves (CX15 review D).
  const RAW_SAVES = ['connections.importActions', 'connections.importEntities'];
  assert.equal(new Set(RAW_SAVES.map(id => PORTAL_WRITES[id].route[2])).size, 1, 'both raw saves are the same native save of the selection');
  for (const [id, route] of Object.entries(PORTAL_WRITES))
    assert.equal(classify('odc_portal_write', { operationId: id, input: {} }), route.effect === 'destructive' || RAW_SAVES.includes(id), id);
  for (const [id] of Object.entries(PORTAL_WRITES).filter(([id]) => DELETE_WORDS.test(id))) assert.equal(classify('odc_portal_write', { operationId: id, input: {} }), true, id);
  // studio_command: every command of the ODC bridge's dispatch; the four of CX15 §6 line 8 are refused, the rest pass.
  const commands = bridgeCommands();
  assert.ok(commands.length > 30 && commands.includes('data-delete'), 'the dispatch was read: ' + commands.length);
  const refused = commands.filter(command => classify('studio_command', { command, args: [] }));
  assert.deepEqual(refused.sort(), ['data-delete', 'portal-api-client-fixture-cleanup', 'portal-call', 'portal-private-call']);
  for (const command of commands.filter(c => DELETE_WORDS.test(c))) assert.ok(refused.includes(command), command);
});

test('completeness: every tool the MCP annotations call destructive is classified, or listed as overwriting only', async () => {
  const { tools } = await hostedListing();
  const all = await probes();
  const deleting = new Set(all.filter(p => classify(p.name, p.args)).map(p => p.name));
  for (const name of ['odc_write', 'odc_portal_write', 'studio_command', 'o11_data']) deleting.add(name); // free-text selectors, above
  deleting.add('o11_access'); // a file selector: the revokes of the manifest, read by the gate (F1 tests below)
  // r25 (marco-a5 + this stopgap): a tool the hosted catalog lists as unavailable (ssam_code, SSAM_CODE_HOSTED_PENDING) is
  // refused before this rule (wrapHostedTool: the unavailable tools first) and runs nothing on a hosted server. When it is
  // served, its class changes and this check reviews it again.
  const unreviewed = [...tools.values()].filter(t => t.annotations?.destructiveHint === true && hostedTools()[t.name] && hostedTools()[t.name].class !== 'unavailable' && !deleting.has(t.name) && !OVERWRITES_ONLY[t.name]).map(t => t.name);
  assert.deepEqual(unreviewed, []);
  for (const name of Object.keys(OVERWRITES_ONLY)) assert.equal(deleting.has(name), false, name + ' deletes nothing');
  assert.equal(typeof destructive.HOSTED_OFF, 'object');
  assert.deepEqual(Object.keys(destructive.HOSTED_OFF).sort(), [...deleting].sort(), 'HOSTED_OFF names exactly the tools that have a refused part');
});

test('the hosted listing never promises a deletion: each tool with a refused part says so first; the local listing is unchanged', async () => {
  const { tools } = await hostedListing();
  const off = Object.keys(destructive.HOSTED_OFF ?? {});
  assert.ok(off.length >= 12, 'tools with a refused part: ' + off.length);
  for (const [name, tool] of tools) {
    const says = /^Hosted: deleting is off on this server/.test(tool.description ?? '');
    assert.equal(says, off.includes(name), name + ': ' + String(tool.description).slice(0, 160));
    if (says) assert.match(tool.description, /DESTRUCTIVE_HOSTED_OFF/, name);
  }
  assert.doesNotMatch(tools.get('o11_service_center_write').description.slice(0, 200), /ONE call/);
  assert.match(tools.get('o11_service_center_write').description, /delete, module-delete, extension-delete, application-delete, solution-delete and db-connection-delete/);
  // Local: the same O11 tools of a server without hosted keep their descriptions as they were.
  const local = await listing(await createSsamServer({ o11: true, odc: false }));
  try {
    for (const name of ['o11_service_center_write', 'o11_environment', 'o11_data', 'o11_extension']) {
      const mine = local.tools.get(name).description;
      assert.doesNotMatch(mine, /Hosted: deleting is off/, name);
      assert.equal(tools.get(name).description.endsWith(mine), true, name + ': the hosted listing only adds its note in front');
    }
    // marco-a6 (CX15): the local description is the product's two-call delete; hosted, the note above comes first.
    assert.match(local.tools.get('o11_service_center_write').description, /^delete \{applications\|modules\|extensions\|prefix\}: two calls/);
  } finally { await local.close(); }
});

test('end to end through the hosted server: the incident call is refused and nothing reaches the customer\'s machine', async () => {
  const { client, context } = await hostedListing();
  const before = context.executor.calls.length;
  for (const [name, args] of [
    ['o11_service_center_write', { action: 'delete', prefix: 'ZZRV', words: WORDS, host: HOST, confirmHost: HOST }],
    ['o11_environment', { action: 'delete-app', app: 'ZZRV One', host: HOST, authorize: WORDS }],
    ['studio_command', { command: 'data-delete M E --ids 1 --authorize x' }],
    ['odc_deploy', { tenant: TENANT, assetKey: ASSET, environmentKey: ASSET, operation: 'Undeploy', authorize: WORDS, operationUuid: randomUUID() }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert.equal(value.cause, 'DESTRUCTIVE_HOSTED_OFF', name + ' ' + JSON.stringify(value).slice(0, 300));
    assert.equal(value.continuation, undefined, name);
  }
  assert.equal(context.executor.calls.length, before, 'no executor kind ran');
  assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

// ---- correction 1 of the review (C:\t\revisoes\hosted-destructive-off\REVISAO.md): F1, F2 and F3
const valueOfCall = result => result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? 'null');

test('F3: a call without its selector deletes nothing: INPUT_INVALID with the correction, nothing runs; a well-formed DELETE stays refused', async () => {
  const { client, context } = await hostedListing();
  const before = context.executor.calls.length;
  const call = async (name, args) => valueOfCall(await client.callTool({ name, arguments: args }));
  for (const [name, args, fix] of [
    ['odc_write', { tenant: TENANT, operation_id: 'asset-repository-api-v1:post:/assets', body: {} }, /closest: operationId/],
    ['odc_write', { tenant: TENANT, body: {} }, /\/operationId is required/],
    ['odc_portal_write', { operationID: 'timers.run', input: {} }, /closest: operationId/],
    ['studio_command', { cmd: 'module-info' }, /\/command is required/],
    ['studio_command', { command: 'module-info', args: 'Orders' }, /\/args[^;"]*expected array/],
    // a DELETE under a misspelled field: no selector, nothing runs (the input layer refuses it)
    ['odc_write', { tenant: TENANT, operation_id: 'asset-repository-api-v1:delete:/assets/{assetKey}', path: { assetKey: ASSET } }, /closest: operationId/],
  ]) {
    const value = await call(name, args);
    const label = name + ' ' + JSON.stringify(args) + ' -> ' + JSON.stringify(value).slice(0, 400);
    assert.equal(value.code, 'INPUT_INVALID', label);
    assert.notEqual(value.cause, 'DESTRUCTIVE_HOSTED_OFF', label);
    assert.doesNotMatch(JSON.stringify(value), /Deleting \(applications/, label);
    assert.match(JSON.stringify(value), fix, label);
  }
  // Well formed, it is refused as before; the words of args given as text are read.
  for (const [name, args] of [
    ['odc_write', { tenant: TENANT, operationId: 'asset-repository-api-v1:delete:/assets/{assetKey}', path: { assetKey: ASSET } }],
    ['studio_command', { command: ' ', args: 'data-delete M E --ids 1' }],
  ]) assert.equal((await call(name, args)).cause, 'DESTRUCTIVE_HOSTED_OFF', name + ' ' + JSON.stringify(args));
  assert.equal(context.executor.calls.length, before, 'no executor kind ran');
  assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
});

// A hosted server whose fake executor plays the customer's ODC Studio signed in to TENANT (it answers studio.processes,
// auth-status and portal-call, recording each request it would send) and has an O11 connection; every other kind is
// refused. Nothing reaches a machine.
async function playingServer() {
  const workspace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-destructive-play-')), 'customers', 'tok_zzplay');
  prepareWorkspace(workspace);
  const kinds = [], sent = [];
  const executor = { id: 'fake-' + randomUUID(), hosted: true,
    async call(kind, payload) {
      const args = payload?.args;
      kinds.push(kind + (Array.isArray(args) ? ':' + args[0] : ''));
      if (kind === 'studio.processes') return { processes: [{ pid: 4242 }] };
      if (kind === 'odc.pipe' && args?.[0] === 'auth-status')
        return { line: JSON.stringify({ ok: true, bridge: 'v95', capabilities: [], portalWindows: [], sessions: [{ host: TENANT, loggedIn: true, user: 'zz.owner@example.test', permissions: [] }] }) };
      if (kind === 'odc.pipe' && args?.[0] === 'portal-call') {
        const request = JSON.parse(fs.readFileSync(args[1], 'utf8'));
        sent.push({ method: request.method, path: request.path, body: request.body });
        return { line: JSON.stringify({ ok: true, host: TENANT, status: 200, contentType: 'application/json', body: {} }) };
      }
      throw Object.assign(new Error('fake executor: kind ' + kind + ' not played'), { code: 'KIND_NOT_ALLOWED', executed: false });
    },
    o11Connection: () => ({ pid: 6001 }), relayPort: () => null, quota: { full: () => false }, async close() {} };
  const agent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, credential: true, compatible: { odc: { ok: true }, o11: { ok: true } } }) };
  const context = { id: randomUUID(), hosted: true, tokenId: 'tok_zzplay', customer: 'ZZ', lanes: ['odc', 'o11'], workspace, agent, executor, o11: { lane: 'o11' }, close: async () => {} };
  const server = await runWithExecutor(context, () => createSsamServer({ hosted: { context, session: { agent, lanes: context.lanes } } }));
  return { ...(await listing(server)), kinds, sent, workspace };
}
const GROUP = '22222222-2222-4222-8222-222222222222';
const USERS = ['33333333-3333-4333-8333-333333333331', '33333333-3333-4333-8333-333333333332'];
const ROLE = '44444444-4444-4444-8444-444444444444';
const TENANT_WORDS = 'sim, no tenant zz-tenant, ajusta o grupo';
const accessManifest = actions => ({ schema: 'ssam-access/1', environment: 'zz-o11.example.test', manifestVersion: 2,
  entries: actions.map((action, i) => ({ username: 'zz.user' + i, role: 'ZZApp.ZZRole' + i, action, demo: true })) });

test('F1: revoking access is refused like the DELETE of the same access: *ToRemove bodies and an o11_access apply with revokes, 0 kinds; adds and grants still pass', async () => {
  const play = await playingServer();
  try {
    const call = async (name, args) => { const k = play.kinds.length, s = play.sent.length;
      return { value: valueOfCall(await play.client.callTool({ name, arguments: args })), kinds: play.kinds.slice(k), sent: play.sent.slice(s) }; };
    const write = (operationId, body) => call('odc_write', { tenant: TENANT, operationId, path: { key: GROUP }, body, authorize: TENANT_WORDS, operationUuid: randomUUID(), confirmTenant: TENANT });
    const USERS_OP = 'user-access-management-api-v1:patch:/groups/{key}/users';
    const ROLES_OP = 'user-access-management-api-v1:patch:/groups/{key}/application-roles';
    for (const [operationId, body] of [[USERS_OP, { userKeysToAdd: [], userKeysToRemove: USERS }], [ROLES_OP, { applicationRoleKeysToAdd: [], applicationRoleKeysToRemove: [ROLE] }]]) {
      const { value, kinds, sent } = await write(operationId, body);
      assert.deepEqual([value.code, value.cause, value.outcome], ['HOSTED_UNAVAILABLE', 'DESTRUCTIVE_HOSTED_OFF', 'not-sent'], operationId + ' ' + JSON.stringify(value).slice(0, 300));
      assert.deepEqual(kinds, [], operationId + ': no kind'); assert.deepEqual(sent, []);
      assert.equal(JSON.stringify(value).includes(TENANT_WORDS), false);
    }
    // Controls: the same operations that only add pass the gate and are sent as before.
    for (const [operationId, body] of [[USERS_OP, { userKeysToAdd: [USERS[0]], userKeysToRemove: [] }], [ROLES_OP, { applicationRoleKeysToAdd: [ROLE] }]]) {
      const { value, kinds, sent } = await write(operationId, body);
      assert.notEqual(value.cause, 'DESTRUCTIVE_HOSTED_OFF', operationId + ' ' + JSON.stringify(value).slice(0, 300));
      assert.ok(kinds.includes('odc.pipe:portal-call'), operationId + ': ' + JSON.stringify(kinds));
      assert.deepEqual(sent.map(s => [s.method, s.body]), [['PATCH', body]], operationId);
    }
    // o11_access apply: the manifest is read by the gate; one revoke refuses it before any kind, with the count.
    const inbox = path.join(play.workspace, 'inbox');
    fs.writeFileSync(path.join(inbox, 'revoke.json'), JSON.stringify(accessManifest(['grant', 'revoke'])));
    fs.writeFileSync(path.join(inbox, 'grants.json'), JSON.stringify(accessManifest(['grant', 'grant'])));
    const refused = await call('o11_access', { action: 'apply', manifestPath: 'ws:inbox/revoke.json', words: WORDS });
    // NEW-1 of review 2: every apply is refused by the classifier before the manifest is read, so no count comes back.
    assert.deepEqual([refused.value.code, refused.value.cause, refused.value.outcome, refused.value.revokes], ['HOSTED_UNAVAILABLE', 'DESTRUCTIVE_HOSTED_OFF', 'not-sent', undefined], JSON.stringify(refused.value).slice(0, 400));
    assert.match(refused.value.error ?? '', /aplicar mudanças de acesso/i);
    assert.deepEqual(refused.kinds, [], 'no kind before the refusal');
    assert.equal(JSON.stringify(refused.value).includes(WORDS), false);
    // NEW-1 of review 2: every apply is refused for now, grants only too (fail closed), before any kind.
    const granted = await call('o11_access', { action: 'apply', manifestPath: 'ws:inbox/grants.json', words: WORDS });
    assert.equal(granted.value.cause, 'DESTRUCTIVE_HOSTED_OFF', JSON.stringify(granted.value).slice(0, 300));
    assert.deepEqual(granted.kinds, [], 'a manifest with grants only is refused too, before the Studio check');
    assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
  } finally { await play.close(); }
});

test('F1: the revokes of an access manifest are counted as the kernel reads it (AccessManifest.Read); a manifest the gate cannot read whole is refused', async () => {
  assert.equal(typeof destructive.manifestRevokes, 'function', 'hosted/destructive.mjs exports manifestRevokes');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-destructive-manifest-'));
  const file = (name, content) => { const target = path.join(dir, name); fs.writeFileSync(target, content); return target; };
  const json = value => JSON.stringify(value);
  const revokes = target => destructive.manifestRevokes(target);
  assert.deepEqual(revokes(file('grants.json', json(accessManifest(['grant', ' GRANT '])))), { revokes: 0 });
  assert.deepEqual(revokes(file('one.json', json(accessManifest(['grant', 'revoke'])))), { revokes: 1 });
  // The kernel trims and lowercases (Trim, ToLowerInvariant): every spelling counts, and an action that is not a grant too.
  assert.deepEqual(revokes(file('spellings.json', json(accessManifest(['REVOKE ', 'revoke\u0085', 'Revoke', 'grant', 7])))), { revokes: 4 });
  // UTF-8 with its BOM and UTF-16 LE with its BOM, as File.ReadAllText reads them.
  assert.deepEqual(revokes(file('bom8.json', '\uFEFF' + json(accessManifest(['revoke'])))), { revokes: 1 });
  assert.deepEqual(revokes(file('utf16.json', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json(accessManifest(['revoke', 'revoke'])), 'utf16le')]))), { revokes: 2 });
  // No entries, or a root that is no object: the kernel refuses the whole manifest and applies nothing.
  assert.deepEqual(revokes(file('empty.json', json({ schema: 'ssam-access/1', entries: [] }))), { revokes: 0 });
  assert.deepEqual(revokes(file('array.json', json([{ action: 'revoke' }]))), { revokes: 0 });
  // Not read whole: refused (fail closed), revokes unknown.
  for (const [name, content] of [['dup.json', '{"entries":[{"username":"a","role":"M.R","demo":true,"action":"grant","action":"revoke"}]}'],
    ['bad.json', '{"entries":[{"action":"revoke"}'], ['utf32.json', Buffer.from([0xff, 0xfe, 0, 0, 0x7b, 0, 0, 0, 0x7d, 0, 0, 0])]]) {
    const read = revokes(file(name, content));
    assert.equal(read?.revokes, null, name + ' ' + JSON.stringify(read));
    assert.equal(typeof read.unreadable, 'string', name);
  }
  assert.equal(revokes(path.join(dir, 'missing.json')), null, 'a missing manifest is the handler\'s MANIFEST_NOT_FOUND');
  // The gate's check of a call: only apply, only an existing absolute manifest.
  assert.equal(typeof destructive.hostedDestructiveFiles, 'function');
  const one = path.join(dir, 'one.json');
  assert.deepEqual(destructive.hostedDestructiveFiles('o11_access', { action: 'apply', manifestPath: one }), { revokes: 1, detail: destructive.hostedDestructiveFiles('o11_access', { action: 'apply', manifestPath: one }).detail });
  assert.equal(destructive.hostedDestructiveFiles('o11_access', { action: ' Apply ', manifestPath: one })?.revokes, 1);
  assert.equal(destructive.hostedDestructiveFiles('o11_access', { action: 'plan', manifestPath: one }), null);
  assert.equal(destructive.hostedDestructiveFiles('o11_access', { action: 'apply', manifestPath: path.join(dir, 'grants.json') }), null);
  assert.equal(destructive.hostedDestructiveFiles('o11_access', { action: 'apply', manifestPath: path.join(dir, 'missing.json') }), null);
  assert.equal(destructive.hostedDestructiveFiles('o11_access', { action: 'apply' }), null);
  assert.equal(destructive.hostedDestructiveFiles('odc_write', { action: 'apply', manifestPath: one }), null);
  assert.equal(destructive.hostedDestructiveFiles('o11_access', { action: 'apply', manifestPath: path.join(dir, 'dup.json') })?.revokes, null);
  assert.ok(destructive.hostedDestructiveFiles('o11_access', { action: 'apply', manifestPath: path.join(dir, 'dup.json') }));
});

// ---- NEW-1 of review 2 (C:\t\revisoes\hosted-destructive-off-2\review\RELATORIO.md): the gate counted the revokes of one
// read of the manifest and the kernel read the file again; a second call pulling the same agent:inbox file in between
// handed the kernel [grant, revoke]. Decision of the Integradora for the 19/10 image: on a hosted server every o11_access
// apply is refused at the gate (fail closed), before the agent, any pull of the inbox and any send; plan, verify and users
// still run. The fix that pins the counted bytes by sha256 comes after 19/10.
async function accessServer() {
  const workspace = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-destructive-access-')), 'customers', 'tok_zzaccess');
  prepareWorkspace(workspace);
  const kinds = [], kernel = [], agentInbox = new Map(), hooks = { onSelected: null };
  const executor = { id: 'fake-' + randomUUID(), hosted: true,
    async call(kind) {
      kinds.push(kind);
      if (kind === 'o11.selected') { const hook = hooks.onSelected; hooks.onSelected = null; if (hook) await hook(); return { connected: true, pid: 6001 }; }
      throw Object.assign(new Error('fake executor: kind ' + kind + ' not played'), { code: 'KIND_NOT_ALLOWED', executed: false });
    },
    async pullFile(agentPath) {
      const rel = agentPath.replace(/^agent:/, '');
      kinds.push('file.get:' + rel);
      if (!agentInbox.has(rel)) throw Object.assign(new Error('no such file on the agent: ' + rel), { code: 'FILE_NOT_FOUND' });
      const dest = path.join(workspace, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, agentInbox.get(rel));
      return dest;
    },
    o11Connection: () => ({ ok: true, lane: 'o11', anvilLane: 'o11', pid: 6001, startedUtc: '2026-10-15T00:00:00.000Z', port: 45999, studioDir: path.join(workspace, 'fake-studio'),
      authorityDir: path.join(workspace, 'state', 'relay-authority'), hosted: true }),
    relayPort: () => 45999, quota: { full: () => false }, async close() {} };
  const runAnvil = async argv => {
    const i = argv.indexOf('--manifest');
    let manifest = null;
    if (i >= 0) { try { manifest = JSON.parse(fs.readFileSync(argv[i + 1], 'utf8')); } catch { manifest = null; } }
    kernel.push({ verb: argv.slice(0, 2).join(' '), actions: manifest?.entries?.map(e => e.action) ?? null });
    return { envelope: { data: { ok: false, code: 'FAKE_KERNEL', note: 'fake kernel of this test: nothing ran' } } };
  };
  const agent = { connected: () => true, protocolError() {}, info: () => ({ connected: true, credential: true, compatible: { odc: { ok: true }, o11: { ok: true } } }) };
  const context = { id: randomUUID(), hosted: true, tokenId: 'tok_zzaccess', customer: 'ZZ', lanes: ['odc', 'o11'], workspace, agent, executor, o11: { lane: 'o11' }, close: async () => {} };
  const server = await runWithExecutor(context, () => createSsamServer({ hosted: { context, session: { agent, lanes: context.lanes } }, deps: { access: { runAnvil } } }));
  const linked = await listing(server);
  const call = async (name, args) => { const k = kinds.length, n = kernel.length;
    return { value: valueOfCall(await linked.client.callTool({ name, arguments: args })) ?? {}, kinds: kinds.slice(k), kernel: kernel.slice(n) }; };
  return { ...linked, call, kinds, kernel, agentInbox, hooks, workspace };
}

test('NEW-1: o11_access apply is refused at the gate on a hosted server, grants only too: nothing pulled, no kind, nothing sent', async () => {
  assert.equal(classify('o11_access', { action: 'apply', manifestPath: 'agent:inbox/g.json', words: WORDS }), true, 'the one classifier says apply');
  assert.equal(classify('o11_access', { action: ' Apply ', manifestPath: 'agent:inbox/g.json' }), true, 'any spelling of apply');
  for (const action of ['plan', 'verify', 'users']) assert.equal(classify('o11_access', { action, manifestPath: 'agent:inbox/g.json' }), false, action);
  assert.equal(classify('o11_access', {}), false, 'no action: the input layer answers');
  const play = await accessServer();
  try {
    const GRANTS = JSON.stringify(accessManifest(['grant', 'grant'])), REVOKES = JSON.stringify(accessManifest(['grant', 'revoke']));
    play.agentInbox.set('inbox/g.json', GRANTS);
    fs.writeFileSync(path.join(play.workspace, 'inbox', 'w.json'), GRANTS);
    for (const manifestPath of ['agent:inbox/g.json', 'ws:inbox/w.json']) {
      const { value, kinds, kernel } = await play.call('o11_access', { action: 'apply', manifestPath, words: WORDS });
      assert.deepEqual([value.code, value.cause, value.outcome], ['HOSTED_UNAVAILABLE', 'DESTRUCTIVE_HOSTED_OFF', 'not-sent'], manifestPath + ' ' + JSON.stringify(value).slice(0, 400));
      assert.deepEqual(kinds, [], manifestPath + ': no pull of the inbox, no kind');
      assert.deepEqual(kernel, [], manifestPath + ': nothing reaches the kernel');
      assert.match(value.error ?? '', /applying access changes/i);
      assert.match(value.error ?? '', /aplicar mudanças de acesso/i);
      assert.match(value.error ?? '', /Service Center/);
      assert.equal(value.continuation, undefined);
      assert.equal(JSON.stringify(value).includes(WORDS), false, 'the words never come back');
    }
    // The NEW-1 proof: A and B race on the same agent:inbox file, B swapping in a revoke during the window: 0 sends.
    play.agentInbox.set('inbox/m.json', GRANTS);
    play.hooks.onSelected = async () => { play.agentInbox.set('inbox/m.json', REVOKES); };
    const raced = await Promise.all([
      play.call('o11_access', { action: 'apply', manifestPath: 'agent:inbox/m.json', words: WORDS }),
      (async () => { play.agentInbox.set('inbox/m.json', REVOKES); return play.call('o11_access', { action: 'apply', manifestPath: 'agent:inbox/m.json', words: WORDS }); })(),
    ]);
    for (const [i, { value }] of raced.entries()) assert.equal(value.cause, 'DESTRUCTIVE_HOSTED_OFF', 'call ' + i + ' ' + JSON.stringify(value).slice(0, 300));
    assert.deepEqual(play.kernel, [], 'no apply reached the kernel');
    assert.equal(play.kinds.filter(k => k.startsWith('file.get:') || k === 'o11.selected').length, 0, 'no pull, no Studio check: ' + JSON.stringify(play.kinds));
    // Controls: plan, verify and users still pass the gate (plan reaches the kernel with the pulled manifest).
    const plan = await play.call('o11_access', { action: 'plan', manifestPath: 'agent:inbox/g.json' });
    assert.notEqual(plan.value.cause, 'DESTRUCTIVE_HOSTED_OFF', JSON.stringify(plan.value).slice(0, 300));
    assert.ok(plan.kinds.includes('file.get:inbox/g.json'), 'plan pulls its manifest: ' + JSON.stringify(plan.kinds));
    assert.deepEqual(plan.kernel.map(k => k.verb), ['access plan'], 'plan reaches the kernel');
    for (const args of [{ action: 'verify' }, { action: 'users' }]) {
      const { value } = await play.call('o11_access', args);
      assert.notEqual(value.cause, 'DESTRUCTIVE_HOSTED_OFF', JSON.stringify(args) + ' ' + JSON.stringify(value).slice(0, 300));
    }
    assert.deepEqual(spawned, []); assert.deepEqual(connections, []);
  } finally { await play.close(); }
});

// ---- F2: an oracle independent of the classifier's tables (never effects.mjs effectOf nor PORTAL_WRITES effect). It reads
// what each operation and route says it does: for every ODC public operation that is not a GET, its summary, description,
// request-body property names and enum values, and its method (DELETE); for every Portal route, its id and its native
// action (route[2]). Every occurrence of a removal word is refused by the gate, or listed in KEPT_REMOVALS with its reason.
const REMOVAL = /delet|remov|revok|undeploy|unpublish|purg|prune|clear|deactivat|rotat/i;
const KEPT_REMOVALS = {
  'asset-repository-api-v1:patch:/assets/{assetKey}/revisions/{revisionNumber}#text': '"clears the existing revision tag": sets or unsets the tag label of a revision; the revision and its content stay',
  'dependency-management-api-v1:post:/deletion-analyses#text': 'starts a read-only analysis of what deleting an asset would affect; deletes nothing',
  'environment-configurations-api-v1:patch:/environments/{environmentKey}/domains/{domainKey}#text': '"clear the default app": a null application key unsets the default app of a domain; the domain and the app stay',
  'environment-configurations-api-v1:post:/environments/{environmentKey}/private-gateway/deactivation#text': 'F6 of the review, the owner decides: deactivates the private gateway (reversible: activate it again)',
  'environment-configurations-api-v1:post:/environments/{environmentKey}/private-gateway/key-rotation#text': 'F6 of the review, the owner decides: rotates the private gateway key (the old key stops working)',
  'portal-read:knowledgeBases.consumers#route': 'a data action of the knowledge base delete popup that lists its consumers: odc_portal_read, reads only',
};
// The request-body fields of an operation: {kind:'prop'|'enum', at (pointer, '*' for an item), name}.
function bodyFields(spec, node, at, seen, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  if (node.$ref) { if (seen.has(node.$ref)) return out; seen = new Set(seen).add(node.$ref); node = resolveRef(spec, node); }
  for (const [key, child] of Object.entries(node.properties ?? {})) { out.push({ kind: 'prop', at: at + '/' + key, name: key }); bodyFields(spec, child, at + '/' + key, seen, out, depth + 1); }
  for (const alt of [...(node.allOf ?? []), ...(node.anyOf ?? []), ...(node.oneOf ?? [])]) bodyFields(spec, alt, at, seen, out, depth + 1);
  if (node.items) bodyFields(spec, node.items, at + '/*', seen, out, depth + 1);
  for (const value of node.enum ?? []) if (typeof value === 'string') out.push({ kind: 'enum', at, name: value });
  if (node.content) for (const media of Object.values(node.content)) bodyFields(spec, media.schema, at, seen, out, depth + 1);
  return out;
}
// Every occurrence: {key, probes: [[tool, args]...]}, refused when the gate refuses one of its probes.
function removalOccurrences() {
  const catalog = new Catalog();
  const out = [];
  for (const op of catalog.operations.values()) {
    if (op.method === 'GET') continue;
    const fields = bodyFields(catalog.apis.get(op.apiId).spec, op.requestBody, '', new Set(), []);
    const own = new Map();
    for (const field of fields.filter(f => REMOVAL.test(f.name))) {
      const key = op.id + (field.kind === 'prop' ? '#prop:' + field.at : '#enum:' + field.at + '=' + field.name);
      own.set(key, { key, probes: [['odc_write', { operationId: op.id, body: field.at ? argsAt(field.at, field.kind === 'prop' ? [ASSET] : field.name) : field.name }]] });
    }
    if (op.method === 'DELETE') own.set(op.id + '#method', { key: op.id + '#method', probes: [['odc_write', { operationId: op.id }]] });
    out.push(...own.values());
    // The text of the operation says it removes: some form of the call (bare, or with each removal field) is refused.
    if ([op.summary, op.description].some(text => typeof text === 'string' && REMOVAL.test(text)))
      out.push({ key: op.id + '#text', probes: [['odc_write', { operationId: op.id }], ...[...own.values()].flatMap(o => o.probes)] });
  }
  for (const [id, entry] of Object.entries(PORTAL_WRITES))
    if (REMOVAL.test(id) || REMOVAL.test(entry.route[2])) out.push({ key: 'portal:' + id + '#route', probes: [['odc_portal_write', { operationId: id, input: {} }]] });
  // odc_portal_read is a read tool and is not gated: a read route whose native action names a removal must be KEPT.
  for (const [id, entry] of Object.entries(PORTAL_READS))
    if (REMOVAL.test(id) || REMOVAL.test(entry[2])) out.push({ key: 'portal-read:' + id + '#route', probes: [] });
  return out;
}

test('F2: every ODC operation and Portal route whose own text, body fields, enum values, method or native action names a removal is refused at the gate, or KEPT with its reason', async () => {
  const occurrences = removalOccurrences();
  assert.ok(occurrences.length >= 25, 'the oracle read the catalog and the routes: ' + occurrences.length);
  const unexplained = [], kept = [];
  for (const occurrence of occurrences) {
    let refused = false;
    for (const [name, args] of occurrence.probes) {
      const h = harness();
      const value = valueOf(await h.gate(name)(args)) ?? {};
      if (value.cause === 'DESTRUCTIVE_HOSTED_OFF') { refused = true; assert.deepEqual(h.calls, [], occurrence.key); break; }
    }
    if (refused) continue;
    if (Object.hasOwn(KEPT_REMOVALS, occurrence.key)) kept.push(occurrence.key);
    else unexplained.push(occurrence.key);
  }
  assert.deepEqual(unexplained, [], 'a removal the gate lets through without a KEPT reason');
  assert.deepEqual(Object.keys(KEPT_REMOVALS).filter(key => !kept.includes(key)), [], 'a KEPT entry that no longer matches a removal let through');
  for (const [key, reason] of Object.entries(KEPT_REMOVALS)) assert.ok(reason.length > 20, key);
});
