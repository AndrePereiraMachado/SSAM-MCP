import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readNativeInspectionScopes } from '../debug-native-scope-reader.mjs';
const key = 'A'.repeat(22), fn = 'B'.repeat(22), node = 'C'.repeat(22);
for (const lane of ['o11', 'odc']) for (const runtime of ['client', 'server'])
  test(lane + ' ' + runtime + ': native scope keeps node/hash/address and rejects changed bytes or wrong runtime', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-scope-reader-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = { path: path.join(root, 'fixture.oml'), sha256: createHash('sha256').update('fixture').digest('hex') };
    fs.writeFileSync(source.path, 'fixture');
    let returnedRuntime = runtime, mutate = false, calls = 0, functionDebuggerHash = 'H'.repeat(22);
    const input = { lane, runtime, source, moduleKey: key, scopes: [{ functionKey: fn, nodeKeys: [node] }], directory: path.join(root, 'scope') };
    const services = { build: async () => ({ dll: 'fixture-cli.dll', studioDir: root }), exec: async (_, argv) => {
      calls++; assert.equal(argv[argv.indexOf('--expected-sha256') + 1], source.sha256);
      assert.equal(argv[argv.indexOf('--function-key') + 1], fn);
      if (mutate) fs.appendFileSync(source.path, 'changed');
      return { stdout: JSON.stringify({ ok: true, data: {
        schema: 'ssam-native-debug-scope/1', authority: 'installed-model-scope-and-watchability',
        modelScopeEnumerated: true, runtimeValuesEvaluated: false, runtime: returnedRuntime,
        moduleKey: key, functionKey: fn, nodeKey: node, sourceSha256: source.sha256, functionDebuggerHash,
        variables: [{ moduleKey: key, variableKey: 'D'.repeat(22), name: 'Action.Result', category: 'local', nativePath: 'Action.Result' }],
      } }) };
    } };
    const value = await readNativeInspectionScopes(input, services);
    assert.equal(value.variables[0].nodeKey, node);
    assert.equal(value.variables[0][runtime === 'server' ? 'path' : 'nativePath'], 'Action.Result');
    assert.equal(value.coverage[0].scopeComplete, false);
    assert.equal(value.evidence.length, 1);
    if (runtime === 'client') {
      assert.deepEqual(value.functionHashes,[{moduleKey:key,functionKey:fn,sourceSha256:source.sha256,debuggerHash:functionDebuggerHash}]);
      for(const invalid of [undefined,'','not-a-native-hash']) {
        functionDebuggerHash=invalid;
        await assert.rejects(readNativeInspectionScopes(input,services),/function_hash_unavailable/);
      }
      functionDebuggerHash='H'.repeat(22);
    }
    returnedRuntime = runtime === 'server' ? 'client' : 'server';
    await assert.rejects(readNativeInspectionScopes(input, services), new RegExp(runtime + '_scope_required'));
    returnedRuntime = runtime; mutate = true;
    await assert.rejects(readNativeInspectionScopes(input, services), /source_changed/);
    const before = calls;
    await assert.rejects(readNativeInspectionScopes(input, services), /source_changed/);
    assert.equal(calls, before);
  });
test('previous breakpoint identity reaches the native model reader and is checked on return', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-previous-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { path: path.join(root, 'fixture.oml'), sha256: createHash('sha256').update('fixture').digest('hex') };
  fs.writeFileSync(source.path, 'fixture');
  const previousNodeKey = 'E'.repeat(22);
  const input = { lane: 'odc', runtime: 'server', source, moduleKey: key,
    scopes: [{ functionKey: fn, nodeKeys: [node], previousNodeKey }], directory: path.join(root, 'scope') };
  let forged = false;
  const services = { build: async () => ({ dll: 'fixture.dll', studioDir: root }), exec: async (_, argv) => {
    assert.equal(argv[argv.indexOf('--previous-node-key') + 1], previousNodeKey);
    return { stdout: JSON.stringify({ ok: true, data: {
      schema: 'ssam-native-debug-scope/1', authority: 'installed-model-scope-and-watchability',
      modelScopeEnumerated: true, runtimeValuesEvaluated: false, runtime: 'server', moduleKey: key,
      functionKey: fn, nodeKey: node, sourceSha256: source.sha256, variables: [],
      previousNodeKey: forged ? 'F'.repeat(22) : previousNodeKey, previousExpressionsEnumerated: true,
    } }) };
  } };
  const result = await readNativeInspectionScopes(input, services);
  assert.equal(result.coverage[0].previousNodeKey, previousNodeKey);
  assert.equal(result.coverage[0].previousExpressionsEnumerated, true);
  forged = true;
  await assert.rejects(readNativeInspectionScopes(input, services), /inspection_model_incomplete/);
});

test('native expression provenance remains tied to the exact source, module and function', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-expression-binding-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const source = {path: path.join(root, 'fixture.oml'), sha256: createHash('sha256').update('fixture').digest('hex')};
  fs.writeFileSync(source.path, 'fixture');
  const identity = {sourceSha256: source.sha256, moduleKey: key, functionKey: fn};
  const input = {lane: 'odc', runtime: 'server', source, moduleKey: key, scopes: [{functionKey: fn, nodeKeys: [node]}], directory: path.join(root, 'scope')};
  const services = {build: async () => ({dll: 'fixture.dll', studioDir: root}), exec: async () => ({stdout: JSON.stringify({ok: true, data: {
    schema: 'ssam-native-debug-scope/1', authority: 'installed-model-scope-and-watchability',
    modelScopeEnumerated: true, runtimeValuesEvaluated: false, runtime: 'server',
    moduleKey: key, functionKey: fn, nodeKey: node, sourceSha256: source.sha256, variables: [],
    expressionBindings: {available: true, identity, expressions: []}
  }})})};
  const result = await readNativeInspectionScopes(input, services);
  assert.deepEqual(result.expressionBindings[0].identity, identity);
  for (const field of ['sourceSha256', 'moduleKey', 'functionKey']) {
    const previous = identity[field]; identity[field] = 'foreign';
    await assert.rejects(readNativeInspectionScopes(input, services), /expression_binding_mismatch/);
    identity[field] = previous;
  }
});

// Screen/block Aggregates (NRNodes.WebScreenDataSet) are not IBreakpointable in either installed model
// (.local/debugger/aggregate-breakpoint-contract/findings.json): a frame of that native type is refused by name.
for (const lane of ['o11', 'odc']) test(lane + ': an Aggregate function frame is refused with a named native limit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-aggregate-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { path: path.join(root, 'fixture.oml'), sha256: createHash('sha256').update('fixture').digest('hex') };
  fs.writeFileSync(source.path, 'fixture');
  let calls = 0;
  const services = { build: async () => ({ dll: 'fixture.dll', studioDir: root }), exec: async () => {
    calls++;
    return { stdout: JSON.stringify({ ok: true, data: { schema: 'ssam-native-debug-scope/1', authority: 'installed-model-scope-and-watchability',
      modelScopeEnumerated: true, runtimeValuesEvaluated: false, runtime: 'server', moduleKey: key, functionKey: fn, nodeKey: node,
      sourceSha256: source.sha256, variables: [] } }) };
  } };
  const input = functionType => ({ lane, runtime: 'server', source, moduleKey: key, directory: path.join(root, 'scope'),
    scopes: [{ functionKey: fn, nodeKeys: [node], functionType }] });
  for (const functionType of ['NRNodes.WebScreenDataSet', 'WebScreenDataSet'])
    await assert.rejects(readNativeInspectionScopes(input(functionType), services), /^Error: debug_native_scope_aggregate_not_breakpointable$/);
  assert.equal(calls, 0);
  const accepted = await readNativeInspectionScopes(input('ServerAction'), services);
  assert.equal(calls, 1);
  assert.equal(accepted.coverage.length, 1);
  await assert.rejects(readNativeInspectionScopes(input(7), services), /function_type_invalid/);
});

// Native REST/SOAP callbacks are their own debugger functions: a node inside OnAuthentication
// (RestServiceAuthenticationFlow) or OnBeforeRequest (RestCallbackActionFlow) is read with
// function = the callback key, never the owning RestService/RestClient.
test('o11 server: a node inside OnAuthentication/OnBeforeRequest resolves with function = callback key', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-callback-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { path: path.join(root, 'fixture.oml'), sha256: createHash('sha256').update('fixture').digest('hex') };
  fs.writeFileSync(source.path, 'fixture');
  const auth = 'G'.repeat(22), before = 'J'.repeat(22), service = 'K'.repeat(22), authNode = 'L'.repeat(22), beforeNode = 'M'.repeat(22);
  let answerWith = null, calls = 0;
  const services = { build: async () => ({ dll: 'fixture.dll', studioDir: root }), exec: async (_, argv) => {
    calls++;
    const functionKey = argv[argv.indexOf('--function-key') + 1], nodeKey = argv[argv.indexOf('--node-key') + 1];
    return { stdout: JSON.stringify({ ok: true, data: { schema: 'ssam-native-debug-scope/1', authority: 'installed-model-scope-and-watchability',
      modelScopeEnumerated: true, runtimeValuesEvaluated: false, runtime: 'server', moduleKey: key, functionKey: answerWith ?? functionKey, nodeKey,
      sourceSha256: source.sha256, variables: [{ moduleKey: key, variableKey: 'N'.repeat(22), name: 'Username', category: 'input', nativePath: 'Username' }] } }) };
  } };
  const scopes = [{ functionKey: auth, nodeKeys: [authNode], callback: { kind: 'RestServiceAuthenticationFlow', name: 'OnAuthentication' } },
    { functionKey: before, nodeKeys: [beforeNode], callback: { kind: 'RestCallbackActionFlow', name: 'OnBeforeRequest' } }];
  // Callback flows of the published capture (runner-derived): the label must name the flow read there.
  const callbackFlows = [{ functionKey: auth, kind: 'RestServiceAuthenticationFlow', callback: 'OnAuthentication' }, { functionKey: before, kind: 'RestCallbackActionFlow', callback: 'OnBeforeRequest' }];
  const input = { lane: 'o11', runtime: 'server', source, moduleKey: key, scopes, callbackFlows, directory: path.join(root, 'scope') };
  const value = await readNativeInspectionScopes(input, services);
  assert.deepEqual(value.variables.map(v => [v.functionKey, v.nodeKey]), [[auth, authNode], [before, beforeNode]]);
  assert.deepEqual(value.callbackScopes, [
    { moduleKey: key, functionKey: auth, nodeKey: authNode, kind: 'RestServiceAuthenticationFlow', name: 'OnAuthentication' },
    { moduleKey: key, functionKey: before, nodeKey: beforeNode, kind: 'RestCallbackActionFlow', name: 'OnBeforeRequest' }]);
  assert.deepEqual(value.breakpoints, [key + ':' + authNode, key + ':' + beforeNode]);
  // The native frame must name the callback itself; the owning service key is a different function.
  answerWith = service;
  await assert.rejects(readNativeInspectionScopes(input, services), /inspection_model_incomplete/);
  answerWith = null; const before0 = calls;
  for (const callback of [{ kind: 'RestServiceAuthenticationFlow', name: 'OnBeforeRequest' }, { kind: 'RestService', name: 'OnAuthentication' }, { kind: 'SOAPCallbackActionFlow', name: 'OnResponse' }, 'OnAuthentication'])
    await assert.rejects(readNativeInspectionScopes({ ...input, scopes: [{ ...scopes[0], callback }] }, services), /debug_native_scope_callback_invalid/);
  assert.equal(calls, before0, 'an invalid callback identity is refused before the native reader');
  // A valid pair on a function that is not that flow of the capture (or with no capture list) is not a callback.
  for (const variant of [{ scopes: [{ ...scopes[1], callback: { kind: 'RestServiceAuthenticationFlow', name: 'OnAuthentication' } }] },
    { scopes: [{ ...scopes[0], functionKey: service }] }, { callbackFlows: undefined }, { callbackFlows: [{ ...callbackFlows[0], callback: 'OnRequest' }, callbackFlows[1]] }])
    await assert.rejects(readNativeInspectionScopes({ ...input, ...variant }, services), /debug_native_scope_callback_unverified/);
  assert.equal(calls, before0, 'an unverified callback label is refused before the native reader');
  // ODC has no SOAP callback flows.
  await assert.rejects(readNativeInspectionScopes({ ...input, lane: 'odc', scopes: [{ ...scopes[0], callback: { kind: 'SOAPCallbackActionFlow', name: 'OnBeforeRequest' } }] }, services), /debug_native_scope_callback_invalid/);
});

// ODC Settings are native SiteProperty variables: the reader forwards its lane to the metadata
// projection, which reports them as 'setting' without touching the native address.
for (const lane of ['odc', 'o11']) test(lane + ': the reader forwards its lane to the metadata projection (site/setting label)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-setting-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { path: path.join(root, 'fixture.oml'), sha256: createHash('sha256').update('fixture').digest('hex') };
  fs.writeFileSync(source.path, 'fixture');
  const services = { build: async () => ({ dll: 'fixture.dll', studioDir: root }), exec: async () => ({ stdout: JSON.stringify({ ok: true, data: {
    schema: 'ssam-native-debug-scope/1', authority: 'installed-model-scope-and-watchability', modelScopeEnumerated: true, runtimeValuesEvaluated: false,
    runtime: 'server', moduleKey: key, functionKey: fn, nodeKey: node, sourceSha256: source.sha256,
    variables: [{ moduleKey: key, variableKey: 'S'.repeat(22), name: 'Site.ApiLimit', category: 'site', nativePath: 'Site.ApiLimit' }] } }) }) };
  const value = await readNativeInspectionScopes({ lane, runtime: 'server', source, moduleKey: key, scopes: [{ functionKey: fn, nodeKeys: [node] }],
    directory: path.join(root, 'scope') }, services);
  assert.equal(value.variables[0].category, lane === 'odc' ? 'setting' : 'site');
  assert.equal(value.variables[0].path, 'Site.ApiLimit');
  assert.equal(value.coverage[0].variableCounts.setting, lane === 'odc' ? 1 : 0);
  assert.equal(value.coverage[0].variableCounts.site, lane === 'odc' ? 0 : 1);
});

// ODC REST callbacks (published RESTService/REST plugin kinds): runner-derived flows only, ODC pairs only.
test('odc server: runner-derived REST callback flows are read with function = callback key; O11-only or SOAP pairs are refused', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-odc-callback-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { path: path.join(root, 'fixture.oml'), sha256: createHash('sha256').update('fixture').digest('hex') };
  fs.writeFileSync(source.path, 'fixture');
  const onRequest = 'G'.repeat(22), after = 'J'.repeat(22), requestNode = 'L'.repeat(22), afterNode = 'M'.repeat(22);
  let calls = 0;
  const services = { build: async () => ({ dll: 'fixture.dll', studioDir: root }), exec: async (_, argv) => { calls++;
    const functionKey = argv[argv.indexOf('--function-key') + 1], nodeKey = argv[argv.indexOf('--node-key') + 1];
    return { stdout: JSON.stringify({ ok: true, data: { schema: 'ssam-native-debug-scope/1', authority: 'installed-model-scope-and-watchability',
      modelScopeEnumerated: true, runtimeValuesEvaluated: false, runtime: 'server', moduleKey: key, functionKey, nodeKey, sourceSha256: source.sha256,
      variables: [{ moduleKey: key, variableKey: 'N'.repeat(22), name: 'Request', category: 'input', nativePath: 'Request' }] } }) }; } };
  const scopes = [{ functionKey: onRequest, nodeKeys: [requestNode], callback: { kind: 'RestServiceCallbackActionFlow', name: 'OnRequest' } },
    { functionKey: after, nodeKeys: [afterNode], callback: { kind: 'RestCallbackActionFlow', name: 'OnAfterResponseAdvanced' } }];
  const callbackFlows = [{ moduleKey: key, functionKey: onRequest, kind: 'RestServiceCallbackActionFlow', callback: 'OnRequest' },
    { moduleKey: key, functionKey: after, kind: 'RestCallbackActionFlow', callback: 'OnAfterResponseAdvanced' }];
  const input = { lane: 'odc', runtime: 'server', source, moduleKey: key, scopes, callbackFlows, directory: path.join(root, 'scope') };
  const value = await readNativeInspectionScopes(input, services);
  assert.deepEqual(value.callbackScopes, [
    { moduleKey: key, functionKey: onRequest, nodeKey: requestNode, kind: 'RestServiceCallbackActionFlow', name: 'OnRequest' },
    { moduleKey: key, functionKey: after, nodeKey: afterNode, kind: 'RestCallbackActionFlow', name: 'OnAfterResponseAdvanced' }]);
  const before0 = calls;
  // ODC has no SOAP callbacks; OnAfterResponseAdvanced is an ODC REST callback only.
  await assert.rejects(readNativeInspectionScopes({ ...input, scopes: [{ ...scopes[0], callback: { kind: 'SOAPCallbackActionFlow', name: 'OnBeforeRequest' } }] }, services), /debug_native_scope_callback_invalid/);
  await assert.rejects(readNativeInspectionScopes({ ...input, lane: 'o11', scopes: [scopes[1]] }, services), /debug_native_scope_callback_invalid/);
  await assert.rejects(readNativeInspectionScopes({ ...input, callbackFlows: [callbackFlows[0]] }, services), /debug_native_scope_callback_unverified/);
  await assert.rejects(readNativeInspectionScopes({ ...input, callbackFlows: [callbackFlows[0], { ...callbackFlows[1], moduleKey: 'P'.repeat(22) }] }, services), /debug_native_scope_callback_unverified/);
  assert.equal(calls, before0);
});
