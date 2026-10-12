import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { invokeSchema, registerInvokeTools, parseInvokeCli } from '../debug-invoke.mjs';
import { describeParameters, validateInputs, typeOf, filterOutput, digest } from '../debug-invoke-contract.mjs';
import { executeInvocation, invokeDebug, invokeRoot, writeReceipt, selectNativeEntry } from '../debug-invoke-runtime.mjs';
import { runHeadlessHttp, checkNativeRequest, loadDebugAppSession } from '../debug-invoke-http.mjs';
import { isPreviewProfile } from '../debug-invoke-browser.mjs';
import { ADAPTERS, legacyNotice } from '../debug-adapter-registry.mjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

const sessionId = 'a'.repeat(32), planId = randomUUID(), operationId = randomUUID();
const debug = { op: 'start', lane: 'odc', tenant: 'fixture.outsystems.dev', module: 'Producer', moduleKey: 'AQEBAQEBAQEBAQEBAQEBAQ', nodeKeys: ['AgICAgICAgICAgICAgICAg'], runtimeUrl: 'https://fixture-dev.outsystems.app/Fixture/' };
const request = { op: 'run', planId, operationId, inputs: {}, authorization: 'Run the authorized test', debug };
const plan = { planId, identity: { actionKey: 'entry-key' } };
const httpFixture = () => ({ planId, identity: { module: debug.module, moduleKey: debug.moduleKey, entryPath: '/Fixture/screenservices/Fixture/Test' }, origin: 'https://fixture.test', outputPaths: ['/data'] });
const appSession = () => ({ binding: { lane: 'odc', runtimeUrl: 'https://fixture.test/Fixture/', app: 'Fixture', module: debug.module, moduleKey: debug.moduleKey, sessionId },
  userKey: '11111111-2222-3333-4444-555555555555', accessToken: 'private-current-login', idToken: 'private-current-id', refreshToken: 'private-current-refresh', expiresAt: new Date(Date.now() + 300000).toISOString() });

test('native entry selection resolves a block-owned DataAction and refuses another owner/action', () => {
  // This exact owner kind/path was read by key from the hash-checked published FloodQuotes 291 model.
  const identity = { module: 'FloodQuotes', action: 'GetFloodZones', kind: 'DataAction',
    nativePath: 'MobileFlow:MainFlow/MobileBlock:DeterminationDialogs/DataAction:GetFloodZones' };
  const endpoint = '/FloodQuotes/screenservices/FloodQuotes/MainFlow/DeterminationDialogs/DataActionGetFloodZones';
  assert.equal(selectNativeEntry(identity).entryPath, endpoint);
  assert.equal(selectNativeEntry({ ...identity, nativePath: identity.nativePath.replace('MobileBlock', 'MobileScreen') }).entryPath, endpoint);
  for (const changed of [
    identity.nativePath.replace('DataAction:GetFloodZones', 'DataAction:Other'),
    'MobileFlow:MainFlow/MobileScreen:Other/Container:Nested/DataAction:GetFloodZones',
    identity.nativePath.replace('DeterminationDialogs', '..'),
    identity.nativePath.replace('MobileBlock', 'TraditionalScreen'),
  ]) assert.throws(() => selectNativeEntry({ ...identity, nativePath: changed }), /invoke_entry_not_resolved/);
  assert.throws(() => selectNativeEntry(identity, { entryPath: endpoint.replace('DeterminationDialogs', 'Other') }), /invoke_entry_action_mismatch/);
});

test('invocation requires an explicit existing entry, application origin, stable operation and authorization', () => {
  assert.equal(invokeSchema.parse(request).lane, 'odc');
  for (const bad of [
    { ...request, operationId: undefined }, { ...request, authorization: undefined }, { ...request, debug: undefined },
    { ...request, sessionId }, { ...request, lane: 'o11' }, { ...request, password: 'secret' },
    { ...request, debug: { ...debug, autoContinue: false } }, { ...request, debug: { ...debug, seconds: 30 } },
    { op: 'prepare', tabId: 'b'.repeat(32), origin: 'http://fixture.test', snapshot: 'Fixture.oml', expectedSourceSha256: 'a'.repeat(64), actionKey: debug.moduleKey },
    { op: 'prepare', tabId: 'b'.repeat(32), origin: 'https://fixture.test/', snapshot: 'Fixture.oml', expectedSourceSha256: 'a'.repeat(64), actionKey: debug.moduleKey, reload: true },
  ]) assert.equal(invokeSchema.safeParse(bad).success, false);
  assert.equal(invokeSchema.safeParse({ ...request, debug: undefined, sessionId }).success, true);
});
test('wire contracts preserve Int64 strings, records, list items and reject missing/unknown fields or secret overrides', () => {
  const body = { versionInfo: { moduleVersion: 'version' }, inputParameters: { Coverage: { Amount: '250000', Split: false }, Items: [{ Id: '9223372036854775807', Value: 1 }], AuthorizationToken: 'private' } };
  const parameters = describeParameters(body, ['/inputParameters/Coverage', '/inputParameters/Items']);
  assert.deepEqual(validateInputs({ '/inputParameters/Coverage': { Amount: 300000, Split: true }, '/inputParameters/Items': [{ Id: '9223372036854775807', Value: 2 }] }, parameters), {
    '/inputParameters/Coverage': { Amount: '300000', Split: true }, '/inputParameters/Items': [{ Id: '9223372036854775807', Value: 2 }],
  });
  for (const inputs of [ { '/inputParameters/Coverage': { Amount: '300000' } }, { '/inputParameters/Coverage': { Amount: '300000', Split: true, Extra: 1 } }, { '/unknown': 1 }, { '/inputParameters/AuthorizationToken': 'secret' }, { '/inputParameters/Items': [{ Id: 9223372036854775807, Value: 2 }] } ]) assert.throws(() => validateInputs(inputs, parameters));
  assert.throws(() => describeParameters(body, ['/versionInfo/moduleVersion']), /protected/);
  assert.throws(() => describeParameters(body, ['/inputParameters/Coverage', '/inputParameters/Coverage/Amount']), /overlapping/);
  assert.throws(() => describeParameters(body, ['/inputParameters/__proto__']), /pointer/);
  assert.throws(() => validateInputs({ '/inputParameters/Items': [{ Id: '1', Value: 2.1 }] }, parameters));
  assert.throws(() => typeOf(9223372036854775807), /unsafe_number/);
});
test('filtered results retain diagnostic numbers and hide credentials, arbitrary text, personal data and binary values', () => {
  const result = filterOutput({ PremiumX: '150.20', Description: 'Flood', FullName: 'private-person', Authorization: 'private-token', Message: 'Bearer private-secret', data: { Value: 'arbitrary private text', TotalICC: '8', Logo: 'private-binary' } });
  assert.equal(result.PremiumX, '150.20'); assert.equal(result.Description, 'Flood'); assert.equal(result.data.TotalICC, '8');
  for (const value of ['private-person', 'private-token', 'private-secret', 'arbitrary private text', 'private-binary']) assert.ok(!JSON.stringify(result).includes(value));
});
test('automatic discovery includes client variables, skips native empty-list templates, and declares truncation', () => {
  const body = { screenData: { variables: { Cards: { List: [], EmptyListItem: { Amount: '0' } }, IsLoading: false } }, clientVariables: { PropertyBuildingCoverage: '250000', AuthorizationToken: 'private', UserEmail: 'private' } };
  const parameters = describeParameters(body, []);
  assert.deepEqual(parameters.map(p => p.path), ['/screenData/variables/IsLoading', '/clientVariables/PropertyBuildingCoverage']);
  assert.deepEqual(validateInputs({ '/clientVariables/PropertyBuildingCoverage': 300000 }, parameters), { '/clientVariables/PropertyBuildingCoverage': '300000' });
  assert.deepEqual(describeParameters({}, []), []); // An observed zero-input entry can run unchanged.
  const large = { inputParameters: Object.fromEntries(Array.from({ length: 101 }, (_, i) => ['Value' + i, i])) };
  assert.throws(() => describeParameters(large, []), /discovery_limit/);
  const discovery = { complete: true }; assert.equal(describeParameters(large, [], discovery).length, 100); assert.equal(discovery.complete, false); assert.ok(discovery.continuation.includes('inputPaths'));
});
test('isolated preview verification accepts Codex app virtualization and refuses other profiles', () => {
  const local = 'C:\\Users\\fixture\\AppData\\Local';
  assert.equal(isPreviewProfile(local + '\\CodexBrowserPreview', local), true);
  assert.equal(isPreviewProfile(local + '\\Packages\\OpenAI.Codex_example123\\LocalCache\\Local\\CodexBrowserPreview', local), true);
  for (const profile of [local + '\\Google\\Chrome\\User Data', local + '\\Other\\CodexBrowserPreview', local + '\\Packages\\Other.App_test\\LocalCache\\Local\\CodexBrowserPreview', 'C:\\Users\\other\\AppData\\Local\\CodexBrowserPreview']) assert.equal(isPreviewProfile(profile, local), false);
});
test('target action is proven only by its own stack membership through an existing caller', async () => {
  const internal = { ...plan, target: { actionKey: 'private-target' } };
  const services = { debug: async q => q.op === 'stop' ? { ok: true, state: 'stopped' } : { ok: true, state: 'connected', sessionId, events: [{ kind: 'paused', stop: { stack: [{ functionKey: 'private-target' }] } }] }, run: async () => ({ state: 'completed', httpStatus: 200 }) };
  let statuses = 0; const original = services.debug;
  services.debug = async q => { const r = await original(q); if (q.op === 'status' && statuses++ === 0) r.events = []; return r; };
  const result = await executeInvocation(internal, request, services, () => {});
  assert.equal(result.debug.targetActionObserved, true); assert.equal(result.debug.entryStackObserved, false);
  services.debug = async q => ({ ...await original(q), events: [] });
  assert.equal((await executeInvocation(internal, request, services, () => {})).debug.targetActionObserved, false);
});
test('start/connect comes before POST; capture and stack are returned; created sessions are stopped once', async () => {
  const calls = [], updates = [];
  const services = { debug: async r => {
    calls.push(r.op);
    if (r.op === 'start') return { ok: true, state: 'connected', sessionId };
    if (r.op === 'stop') return { ok: true, state: 'stopped' };
    return { ok: true, state: 'connected', events: calls.includes('post') ? [{ kind: 'paused', stop: { stack: [{ functionKey: 'entry-key' }] } }, { kind: 'variables', values: [] }] : [] };
  }, run: async () => { calls.push('post'); return { state: 'completed', httpStatus: 200, businessSuccess: true, outputs: { '/data/PremiumX': '150' } }; } };
  const r = await executeInvocation(plan, request, services, p => updates.push(p));
  assert.deepEqual(calls, ['start', 'status', 'post', 'status', 'stop']);
  assert.equal(r.ok, true); assert.equal(r.debug.breakpointObserved, true); assert.equal(r.debug.entryStackObserved, true); assert.equal(r.debug.captureCount, 1); assert.equal(r.cleanup.state, 'stopped');
  assert.ok(updates.some(p => p.state === 'invoking' && p.sessionId === sessionId));
});
test('a refused debugger prevents POST; uncertain POST is never retried; caller sessions are not stopped', async () => {
  let posts = 0, stops = 0;
  const services = { debug: async r => { if (r.op === 'stop') stops++; return { ok: false, state: 'stopped', sessionId }; }, run: async () => { posts++; } };
  assert.equal((await executeInvocation(plan, request, services, () => {})).state, 'not-sent');
  assert.equal(posts, 0); assert.equal(stops, 1);
  services.debug = async r => { if (r.op === 'stop') stops++; return { ok: true, state: 'connected', events: [] }; };
  services.run = async () => { posts++; throw new Error('native-secret-error'); };
  const r = await executeInvocation(plan, { ...request, debug: undefined, sessionId }, services, () => {});
  assert.equal(r.state, 'uncertain'); assert.equal(posts, 1); assert.equal(stops, 1); assert.equal(r.cleanup.state, 'caller-owned-session'); assert.ok(!JSON.stringify(r).includes('native-secret'));
});
test('HTTP 200 with failed business response fails; no breakpoint is not reported as proven debug; uncertain stop is visible', async () => {
  const r = await executeInvocation(plan, request, { debug: async q => q.op === 'start' ? { ok: true, state: 'connected', sessionId } : q.op === 'stop' ? { ok: false, state: 'stop-uncertain' } : { ok: true, state: 'connected', events: [] }, run: async () => ({ state: 'completed', httpStatus: 200, businessSuccess: false }) }, () => {});
  assert.equal(r.ok, false); assert.equal(r.debug.breakpointObserved, false); assert.equal(r.cleanup.state, 'stop-uncertain');
});
test('same operationId reconciles the persisted receipt without accessing browser/Studio or launching a worker', async () => {
  const id = randomUUID(), dir = path.join(invokeRoot, 'runs', id); fs.mkdirSync(dir, { recursive: true });
  try {
    writeReceipt(path.join(dir, 'receipt.json'), { ok: false, state: 'uncertain', operationId: id, planId, suppliedInputHash: digest({}), inputPaths: [] });
    const r = await invokeDebug({ ...request, operationId: id }); assert.equal(r.replayedReceipt, true); assert.equal(r.state, 'uncertain');
    await assert.rejects(invokeDebug({ ...request, operationId: id, inputs: { '/x': 1 } }), /input_mismatch/);
    await assert.rejects(invokeDebug({ ...request, operationId: id, planId: randomUUID() }), /identity_mismatch/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('headless HTTP uses the current sign-in, preserves the native envelope, decodes UTF-8 and filters outputs', async () => {
  let calls = 0, sent;
  const httpPlan = httpFixture();
  const native = { url: httpPlan.origin + httpPlan.identity.entryPath, method: 'POST', headers: { Authorization: 'private-native-auth', Cookie: 'private-native-cookie', 'Content-Type': 'application/json' }, body: { versionInfo: { moduleVersion: 'native-version' }, inputParameters: { Amount: '250000' } } };
  const bytes = new TextEncoder().encode('{"data":{"Success":true,"Premium":"125","Title":"Café","Token":"private-output-token","FullName":"private-person"}}');
  const services = { load: async () => native, loadAppUser: async id => { assert.equal(id, sessionId); return appSession(); }, fetchHttp: async (url, options) => {
    calls++; sent = { url, options: { ...options, headers: { ...options.headers } } };
    return { status: 200, body: new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } }) };
  } };
  const r = await runHeadlessHttp(httpPlan, { sessionId, inputs: { '/inputParameters/Amount': '300000' }, outputPaths: [], timeoutSeconds: 1 }, services);
  assert.equal(calls, 1); assert.equal(r.state, 'completed'); assert.equal(r.transport, 'headless-http'); assert.equal(r.businessSuccess, true);
  assert.equal(sent.options.headers.Authorization, 'Bearer private-current-login'); assert.equal(sent.options.headers.Cookie, undefined); assert.equal(sent.options.redirect, 'error');
  assert.equal(JSON.parse(sent.options.body).inputParameters.Amount, '300000'); assert.equal(JSON.parse(sent.options.body).versionInfo.moduleVersion, 'native-version');
  assert.equal(r.outputs['/data'].Title, 'Café'); assert.equal(r.outputs['/data'].Premium, '125');
  for (const secret of ['private-native-auth', 'private-native-cookie', 'private-current-login', 'private-output-token', 'private-person']) assert.ok(!JSON.stringify(r).includes(secret));
});
test('private request target/header drift is rejected before send; timeouts never retry HTTP', async () => {
  const httpPlan = httpFixture();
  const native = { url: httpPlan.origin + httpPlan.identity.entryPath, method: 'POST', headers: { Authorization: 'private' }, body: {} };
  for (const bad of [{ ...native, url: 'https://other.test/Test' }, { ...native, headers: { Host: 'other.test' } }, { ...native, headers: {} }, { ...native, headers: { Authorization: 'a\r\nb' } }]) assert.throws(() => checkNativeRequest(bad, httpPlan.identity, httpPlan.origin));
  let calls = 0;
  const r = await runHeadlessHttp(httpPlan, { sessionId, inputs: {}, outputPaths: [], timeoutSeconds: 1 }, { load: async () => native, loadAppUser: async () => appSession(), fetchHttp: async () => { calls++; throw new Error('private-native-error'); } });
  assert.equal(calls, 1); assert.equal(r.state, 'uncertain'); assert.ok(!JSON.stringify(r).includes('private-native-error'));
});

test('missing, expired or differently bound app sign-in prevents sending an existing entry', async () => {
  const httpPlan = httpFixture(), native = { url: httpPlan.origin + httpPlan.identity.entryPath, method: 'POST', headers: { Authorization: 'old-captured-login' }, body: {} };
  const samples = [null, { ...appSession(), expiresAt: '2000-01-01T00:00:00Z' },
    { ...appSession(), binding: { ...appSession().binding, app: 'Other' } },
    { ...appSession(), binding: { ...appSession().binding, sessionId: 'b'.repeat(32) } },
    { ...appSession(), binding: { ...appSession().binding, moduleKey: 'B'.repeat(22) } }];
  for (const session of samples) {
    const r = await runHeadlessHttp(httpPlan, { sessionId, inputs: {}, outputPaths: [], timeoutSeconds: 1 }, {
      load: async () => native, loadAppUser: async () => session, fetchHttp: async () => assert.fail('must not send'),
    });
    assert.equal(r.state, 'not-sent');
  }
  await assert.rejects(loadDebugAppSession(undefined, httpPlan), /session_required/);
});

test('HTML or scalar 200 responses cannot certify an authenticated native entry execution', async () => {
  const httpPlan = httpFixture(), native = { url: httpPlan.origin + httpPlan.identity.entryPath, method: 'POST', headers: { Authorization: 'old' }, body: {} };
  for (const body of ['<html>Sign In</html>', '[]', 'null']) {
    const r = await runHeadlessHttp(httpPlan, { sessionId, inputs: {}, outputPaths: [], timeoutSeconds: 1 }, {
      load: async () => native, loadAppUser: async () => appSession(), fetchHttp: async () => new Response(body, { status: 200 }),
    });
    assert.equal(r.state, 'invalid-response'); assert.equal(r.httpStatus, 200);
  }
});
test('CLI reads an input file and rejects contradictory op; MCP documents the capability limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoke-test-')); try {
    const file = path.join(dir, 'request.json'); fs.writeFileSync(file, JSON.stringify({ op: 'status', operationId }));
    assert.equal(parseInvokeCli(['status', '--request', file]).operationId, operationId);
    assert.throws(() => parseInvokeCli(['run', '--request', file]), /mismatch/);
    assert.throws(() => parseInvokeCli(['status', '--request', file, '--extra']));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const tools = new Map(); registerInvokeTools({ registerTool(name, config, fn) { tools.set(name, { config, fn }); } }, async () => ({ ok: true }), fn => fn);
  for (const phrase of ['not arbitrary ServerAction', 'private', 'NEVER', 'existing', 'sessionId', 'authorization']) assert.ok(tools.get('ssam_debug_invoke').config.description.includes(phrase));
});
test('ssam_debug_invoke is legacy in the registry, its title/description and its refusals', () => {
  const row = ADAPTERS.find(r => r.adapter === 'ssam_debug_invoke');
  assert.equal(row.interactive, 'legacy'); assert.equal(row.lane, 'odc'); assert.deepEqual(row.branches, []);
  const tools = new Map(); registerInvokeTools({ registerTool(name, config) { tools.set(name, config); } }, async () => ({ ok: true }), fn => fn);
  const { title, description } = tools.get('ssam_debug_invoke');
  // The legacy notice is the first sentence, optionally preceded only by the cross-tool diagnostics rule (D5).
  const notice = description.indexOf(legacyNotice('ssam_debug_invoke'));
  assert.match(title, /^LEGACY/); assert.ok(notice === 0 || notice > 0 && /diagnos/i.test(description.slice(0, notice)), description.slice(0, 200));
  assert.ok(!/O11 invocation integration is pending/.test(description));
  for (const bad of [{ ...request, debug: { ...debug, autoContinue: false } }, { ...request, operationId: undefined },
    { op: 'prepare', tabId: 'b'.repeat(32), origin: 'http://fixture.test', snapshot: 'Fixture.oml', expectedSourceSha256: 'a'.repeat(64), actionKey: debug.moduleKey }]) {
    const custom = invokeSchema.safeParse(bad).error.issues.filter(i => i.code === 'custom');
    assert.ok(custom.length > 0 && custom.every(i => i.message.startsWith('legacy ssam_debug_invoke (not interactive): ')), JSON.stringify(custom));
  }
  assert.throws(() => parseInvokeCli(['run']), /^Error: Usage \(legacy, not interactive\): ssam debug invoke/);
});
test('real stdio MCP discovers invoker and rejects incomplete invocation without runtime access', async () => {
  const client = new Client({ name: 'invoke-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../ssam.mjs', import.meta.url)), 'mcp'], stderr: 'ignore' }));
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'ssam_debug_invoke'); assert.ok(tool);
    const response = await client.callTool({ name: 'ssam_debug_invoke', arguments: { op: 'run', planId } }); assert.equal(response.isError, true);
  } finally { await client.close(); }
});
