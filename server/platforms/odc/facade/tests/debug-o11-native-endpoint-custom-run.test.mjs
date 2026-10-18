// O11 Custom REST endpoint credential through the runner (P08 wiring, integrated in wave 1).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createO11NativeRun } from '../debug-o11-native-run.mjs';
import { compileNativeRestEndpoint } from '../debug-native-endpoint.mjs';
import { endpointCredentialBinding } from '../debug-app-user.mjs';
import { privateAppUserValues } from '../debug-runtime.mjs';
import { node, header, key } from './fixtures/debug-native-custom-fixture.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const SECRET = 'synthetic-endpoint-header-value';

function fixture(t, { uncertain = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-custom-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pin = (name, value) => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), file = path.join(root, name);
    fs.writeFileSync(file, bytes); return { path: file, sha256: hash(bytes) }; };
  const input = { op: 'run', lane: 'o11', host: 'dev.example.test', module: 'Store', moduleKey: key('a'), applicationKey: key('z'),
    runtimeUrl: 'https://dev.example.test/Store/', action: 'Echo', inputs: { Value: 'hello' }, timeoutSeconds: 30, trace: 'none' };
  const snapshot = pin('published.oml', 'synthetic custom'), calls = [], invocations = [], prompts = [];
  const action = node('RestServiceAction', 'Echo', { HTTPMethod: 'POST', URL: '/Store/rest/Api/Echo' }, [
    node('RestServiceActionInput', 'Value', { ReceiveIn: 'Body', IsMandatory: 'True', DataType: 'BasicType:Text' }, [], 'i'),
    node('RestServiceActionOutput', 'Result', { SendIn: 'Body', DataType: 'BasicType:Text' }, [], 'o'),
    node('StartNode', '', {}, [], 'e'),
  ], 'b');
  action.path = 'RestService:Api/RestServiceAction:Echo';
  const flow = node('RestServiceAuthenticationFlow', 'OnAuthentication', { AuthenticationCallbackType: 'Custom' },
    [node('StartNode', '', {}, [], 's'), header('"X-Api-Key"', 'h', '1'), node('EndNode', '', {}, [], 'n')], 'f');
  const service = node('RestService', 'Api', { URL: '/Store/rest/Api', Authentication: 'Custom' }, [action, flow], 'c');
  const document = { swagger: '2.0', host: input.host, basePath: '/Store/rest/Api', schemes: ['https'], consumes: ['application/json'], produces: ['application/json'],
    paths: { '/Echo': { post: { parameters: [{ in: 'body', name: 'Value', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'OK', schema: { type: 'string' } } } } } } };
  const body = JSON.stringify(document);
  const services = { root,
    capture: async target => ({ versionId: 7, target, snapshot, inventoryProof: pin('inventory.json', {
      host: input.host, capturedAtUtc: new Date().toISOString(), modules: [{ Name: 'Store', Key: input.moduleKey, ApplicationKey: input.applicationKey, VersionId: 7, IsActive: true }] }),
      readings: [{ tree: action }] }),
    assets: async () => { throw Error('REST must not load Reactive AMD assets'); },
    acquireEndpoint: async ({ binding }) => {
      calls.push('acquire'); const contract = { binding, model: { schema: 'ssam-reading/1', model: 'Store', sourceSha256: snapshot.sha256, tree: service },
        entryKey: action.key, source: { url: input.runtimeUrl + 'rest/Api/swagger.json', body, sha256: hash(body) } };
      return { contract, plan: compileNativeRestEndpoint(contract) };
    },
    endpointPublicationCheck: async () => { calls.push('publication'); },
    prepareUser: async () => { calls.push('app-user-prompt'); return { ok: false, state: 'cancelled' }; },
    releaseUser: async () => { calls.push('app-user-release'); return { ok: true }; },
    prepareEndpointCredential: async (target, { sessionId }) => { calls.push('prompt'); prompts.push(target);
      return { ok: true, credentialSource: 'private-dialog', descriptor: { credentialRef: randomUUID(), binding: endpointCredentialBinding(target, sessionId),
        expiresAt: new Date(Date.now() + 60000).toISOString(), kind: 'endpoint-credential', state: 'credentials-entered', authenticated: false } }; },
    releaseEndpointCredential: async descriptor => { calls.push('release:' + descriptor.kind); return { ok: true, forgotten: true }; },
    invokeEndpoint: async value => { calls.push('invoke'); invocations.push(value); return { ok: !uncertain, uncertain, sent: true, answered: !uncertain,
      status: uncertain ? null : 200, result: { outputs: { Result: value.inputs.Value } }, memoryReferencesReleased: true,
      authentication: { appUserIdentityProved: false, rolesProved: false, propagationProved: false } }; },
  };
  return { runner: createO11NativeRun(services), input, calls, invocations, prompts, root };
}

test('O11 Custom REST prepare reports the endpoint-credential context and the published header names, without any dialog', async t => {
  const f = fixture(t);
  // Like explicit anonymous, the receipt names the context to pass instead of assuming app-user.
  const implicit = await f.runner({ ...f.input, op: 'prepare' });
  assert.equal(implicit.error, 'debug_native_endpoint_context_explicit_required'); assert.equal(implicit.needs.contextMode, 'endpoint-credential');
  const prepared = await f.runner({ ...f.input, op: 'prepare', contextMode: 'endpoint-credential' });
  assert.equal(prepared.ok, true, prepared.error); assert.equal(prepared.entryAbi.kind, 'rest-method');
  assert.equal(prepared.entryAbi.authentication.capability.requiredContext, 'endpoint-credential');
  assert.equal(prepared.needs.contextMode, 'endpoint-credential'); assert.equal(prepared.needs.loginWindow, true);
  assert.deepEqual(prepared.needs.endpointCredential.headers, ['X-Api-Key']);
  assert.match(prepared.needs.endpointCredential.dialog, /Endpoint Credential$/);
  assert.deepEqual(f.calls, ['acquire', 'acquire']);
});

test('O11 Custom REST needs explicit endpoint-credential context and validates every input before the private dialog', async t => {
  const f = fixture(t);
  assert.equal((await f.runner(f.input)).error, 'debug_native_endpoint_context_explicit_required');
  assert.equal((await f.runner({ ...f.input, contextMode: 'anonymous' })).error, 'debug_native_endpoint_context_explicit_required');
  const denied = await f.runner({ ...f.input, contextMode: 'endpoint-credential', inputs: { Unknown: 1 } });
  assert.match(denied.error, /input_unknown/);
  assert.ok(!f.calls.some(c => c.includes('prompt')), f.calls.join());
});

test('O11 Custom REST prepares the bound credential, sends once and releases it by its endpoint binding', async t => {
  const f = fixture(t);
  const run = await f.runner({ ...f.input, contextMode: 'endpoint-credential' });
  assert.equal(run.ok, true, run.error); assert.equal(run.results[0].outputs.Result, 'hello');
  assert.equal(run.credentialsReleased, true); assert.equal(run.lockRetained, false);
  assert.deepEqual(f.calls, ['acquire', 'prompt', 'publication', 'invoke', 'release:endpoint-credential']);
  assert.deepEqual(f.prompts[0].headers, ['X-Api-Key']); assert.equal(f.prompts[0].serviceKey, key('c')); assert.equal(f.prompts[0].revision, 7);
  assert.equal(f.invocations.length, 1); assert.equal(f.invocations[0].context, 'endpoint-credential');
  assert.equal(f.invocations[0].descriptor.kind, 'endpoint-credential'); assert.deepEqual(f.invocations[0].descriptor.binding.headers, ['X-Api-Key']);
  for (const field of ['headers', 'credentials', 'endpointCredential', 'privateValues']) assert.equal(Object.hasOwn(f.invocations[0], field), false);
});

test('O11 Custom REST keeps the binding after one uncertain send and never sends the next scenario', async t => {
  const f = fixture(t, { uncertain: true });
  const run = await f.runner({ ...f.input, inputs: undefined, contextMode: 'endpoint-credential',
    scenarios: [{ name: 'first', inputs: { Value: 'one' } }, { name: 'second', inputs: { Value: 'two' } }] });
  assert.equal(run.uncertain, true); assert.equal(run.lockRetained, true); assert.deepEqual(run.notSent, ['second']);
  assert.equal(f.invocations.length, 1); assert.ok(f.calls.includes('release:endpoint-credential'));
  assert.equal((await f.runner({ ...f.input, contextMode: 'endpoint-credential' })).error, 'debug_o11_native_binding_busy');
});

test('debugger redaction values come from the endpoint-credential record kind', async () => {
  const sessionId = 'f'.repeat(32), target = { lane: 'o11', runtimeUrl: 'https://dev.example.test/Store/', module: 'Store', moduleKey: key('a') };
  const binding = endpointCredentialBinding({ ...target, revision: 7, serviceKey: key('c'), headers: ['X-Api-Key'] }, sessionId);
  const descriptor = { credentialRef: randomUUID(), binding, expiresAt: new Date(Date.now() + 60000).toISOString(), kind: 'endpoint-credential' };
  const record = { ok: true, kind: 'endpoint-credential', binding, expiresAt: descriptor.expiresAt, headers: [{ name: 'X-Api-Key', value: SECRET }] };
  const appBinding = { lane: 'o11', runtimeUrl: binding.runtimeUrl, app: binding.app, sessionId, module: 'Store', moduleKey: key('a') };
  assert.deepEqual(await privateAppUserValues(descriptor, appBinding, { vault: async mode => mode === 'read' ? record : assert.fail(mode) }), [SECRET]);
  assert.equal(record.headers[0].value, '');
  await assert.rejects(privateAppUserValues({ ...descriptor, binding: { ...binding, revision: 8 } }, appBinding, { vault: async () => record }), /debug_app_user_/);
});
