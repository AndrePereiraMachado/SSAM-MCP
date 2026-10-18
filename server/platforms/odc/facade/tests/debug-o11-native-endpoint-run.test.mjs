import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createO11NativeRun } from '../debug-o11-native-run.mjs';
import { compileNativeRestEndpoint } from '../debug-native-endpoint.mjs';
import { compileNativeSoapEndpoint } from '../debug-native-endpoint-soap.mjs';
import { appUserBinding } from '../debug-app-user.mjs';
import { createO11Runner } from '../debug-o11-run.mjs';
import { debugRun, debugRunToolSchema } from '../debug-run.mjs';
import { createServerSessionManager, serverSessionSchema } from '../debug-server-session.mjs';

const hash = value => createHash('sha256').update(value).digest('hex'), key = value => value.repeat(22);
function fixture(t, { anonymous = false, soap = false, uncertain = false, overrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-o11-rest-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pin = (name, value) => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), file = path.join(root, name);
    fs.writeFileSync(file, bytes); return { path: file, sha256: hash(bytes) }; };
  const input = { op: 'run', lane: 'o11', host: 'dev.example.test', module: 'Api', moduleKey: key('a'), applicationKey: key('z'),
    runtimeUrl: 'https://dev.example.test/Api/', action: 'Echo', inputs: { Text: 'hello' }, timeoutSeconds: 30, trace: 'none' };
  const snapshot = pin('published.oml', 'synthetic'), calls = [], invocations = [];
  const node = (kind, name, id, properties = {}, children = []) => ({ kind, name, key: key(id), properties, children,
    childrenTotal: children.length, childrenOmitted: 0, propertyErrors: {}, propertiesOmitted: {}, propertiesMissing: [] });
  const action = node(soap?'SOAPServiceAction':'RestServiceAction', 'Echo', 'b', { URL: '/Api/rest/Service/Echo', HTTPMethod: 'POST' }, [
    node(soap?'InputParameter':'RestServiceActionInput', 'Text', 'c', { ReceiveIn: 'Body', IsMandatory: 'True', DataType: 'BasicType:Text' }),
    node(soap?'OutputParameter':'RestServiceActionOutput', 'Echo', 'd', { SendIn: 'Body', DataType: 'BasicType:Text' }),
    node('StartNode', '', 'e'),
  ]);
  action.path = soap?'SOAPService:Service/SOAPServiceAction:Echo':'RestService:Service/RestServiceAction:Echo';
  const service = node(soap?'SOAPService':'RestService', 'Service', 'f', { URL: '/Api/rest/Service', Authentication: anonymous ? 'None' : 'Basic', IntegratedAuthentication:'False',HTTPSecurity:'SSL' }, [action]);
  const document = { swagger: '2.0', host: input.host, basePath: '/Api/rest/Service', schemes: ['https'], consumes: ['application/json'], produces: ['application/json'],
    securityDefinitions: { basic: { type: 'basic' } }, security: anonymous ? [] : [{ basic: [] }],
    paths: { '/Echo': { post: { parameters: [{ in: 'body', name: 'Text', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'OK', schema: { type: 'string' } } } } } } };
  const body = soap?`<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:test" targetNamespace="urn:test">
<wsdl:types><xsd:schema targetNamespace="urn:test" elementFormDefault="qualified">
<xsd:element name="Echo"><xsd:complexType><xsd:sequence><xsd:element name="Text" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element>
<xsd:element name="EchoResponse"><xsd:complexType><xsd:sequence><xsd:element name="Echo" type="xsd:string"/></xsd:sequence></xsd:complexType></xsd:element></xsd:schema></wsdl:types>
<wsdl:message name="Input"><wsdl:part name="parameters" element="tns:Echo"/></wsdl:message><wsdl:message name="Output"><wsdl:part name="parameters" element="tns:EchoResponse"/></wsdl:message>
<wsdl:portType name="ServiceSoap"><wsdl:operation name="Echo"><wsdl:input message="tns:Input"/><wsdl:output message="tns:Output"/></wsdl:operation></wsdl:portType>
<wsdl:binding name="ServiceBinding" type="tns:ServiceSoap"><soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/><wsdl:operation name="Echo"><soap:operation soapAction="urn:test/Echo"/><wsdl:input><soap:body use="literal"/></wsdl:input><wsdl:output><soap:body use="literal"/></wsdl:output></wsdl:operation></wsdl:binding>
<wsdl:service name="Service"><wsdl:port name="ServiceSoap" binding="tns:ServiceBinding"><soap:address location="https://dev.example.test/Api/Service.asmx"/></wsdl:port></wsdl:service></wsdl:definitions>`:JSON.stringify(document);
  const services = { root,
    capture: async target => ({ versionId: 7, target, snapshot, inventoryProof: pin('inventory.json', {
      host: input.host, capturedAtUtc: new Date().toISOString(), modules: [{ Name: 'Api', Key: input.moduleKey, ApplicationKey: input.applicationKey, VersionId: 7, IsActive: true }] }),
      readings: [{ tree: action }] }),
    assets: async () => { throw Error('REST must not load Reactive AMD assets'); },
    acquireEndpoint: async ({ binding }) => {
      calls.push('acquire'); const contract = { binding, model: { schema: 'ssam-reading/1', model: 'Api', sourceSha256: snapshot.sha256, tree: service },
        entryKey: action.key, source: { url: input.runtimeUrl + (soap?'Service.asmx?WSDL':'rest/Service/swagger.json'), body, sha256: hash(body) } };
      return { contract, plan: (soap?compileNativeSoapEndpoint:compileNativeRestEndpoint)(contract) };
    },
    endpointPublicationCheck: async () => { calls.push('publication'); },
    prepareUser: async (target, { sessionId }) => { calls.push('prompt'); return { ok: true, descriptor: { credentialRef: randomUUID(),
      binding: appUserBinding(target, sessionId), expiresAt: new Date(Date.now() + 60000).toISOString(), authenticated: false } }; },
    releaseUser: async () => { calls.push('release'); return { ok: true }; },
    invokeEndpoint: async value => { calls.push('invoke'); invocations.push(value); return { ok: !uncertain, uncertain, sent: true, answered: !uncertain,
      status: uncertain ? null : 200, result: { outputs: { Echo: value.inputs.Text } }, memoryReferencesReleased: true,
      authentication: { appUserIdentityProved: false, rolesProved: false, propagationProved: false } }; },
    ...overrides,
  };
  const runner = createO11NativeRun(services), runO11 = createO11Runner({ root, native: services });
  const publicRunner = raw => debugRun(debugRunToolSchema.parse(raw), { services: { runO11 } });
  return { runner, publicRunner, input, calls, invocations, root, services };
}

test('O11 REST prepares and invokes an original Basic endpoint without AMD or wrapper, and keeps access proof separate', async t => {
  const f = fixture(t);
  const prepared = await f.runner({ ...f.input, op: 'prepare' });
  assert.equal(prepared.ok, true, prepared.error); assert.equal(prepared.entryAbi.kind, 'rest-method');
  assert.equal(prepared.resolution.entry.runnable, true); assert.deepEqual(f.calls, ['acquire']);
  const run = await f.runner(f.input);
  assert.equal(run.ok, true, run.error); assert.equal(run.results[0].outputs.Echo, 'hello');
  assert.equal(run.results[0].authentication.appUserIdentityProved, false);
  assert.equal(run.credentialsReleased, true); assert.equal(run.lockRetained, false);
  assert.deepEqual(f.calls, ['acquire', 'acquire', 'prompt', 'publication', 'invoke', 'release']);
  assert.equal(f.invocations[0].context, 'app-user'); assert.equal(f.invocations[0].descriptor.binding.module, 'Api');
});

test('O11 anonymous REST needs explicit context; it never silently drops the app-user identity', async t => {
  const f = fixture(t, { anonymous: true });
  const denied = await f.runner(f.input); assert.match(denied.error, /context_explicit_required/); assert.ok(!f.calls.includes('prompt'));
  const run = await f.runner({ ...f.input, contextMode: 'anonymous' });
  assert.equal(run.ok, true, run.error); assert.ok(!f.calls.includes('prompt'));
  assert.equal(f.invocations[0].context, 'explicit-anonymous'); assert.equal(f.invocations[0].descriptor, undefined);
});

test('O11 REST validates all inputs before credentials and retains the binding after a single uncertain send', async t => {
  const f = fixture(t, { uncertain: true });
  const denied = await f.runner({ ...f.input, inputs: { Unknown: 1 } });
  assert.match(denied.error, /input_unknown/); assert.ok(!f.calls.includes('prompt'));
  const run = await f.runner({ ...f.input, inputs: undefined, scenarios: [{ name: 'first', inputs: { Text: 'one' } }, { name: 'second', inputs: { Text: 'two' } }] });
  assert.equal(run.uncertain, true); assert.equal(run.lockRetained, true); assert.deepEqual(run.notSent, ['second']);
  assert.equal(f.invocations.length, 1); assert.equal((await f.runner(f.input)).error, 'debug_o11_native_binding_busy');
});

test('public O11 endpoint preserves trace depth and requires target ThreadEnd; another thread cannot complete it', async t => {
  for (const matchingEnd of [false, true]) {
    const lines = [], starts = [];
    const f = fixture(t, { anonymous: true, overrides: {
      debug: async request => { if (request.op === 'stop') return { ok: true, state: 'stopped' };
        starts.push(request); return { ok: true, state: 'connected', sessionId: 's'.repeat(32) }; },
      traceRead: () => lines,
      settle: async () => { lines.push({ functionKey: key('b'), threadId: 'target', values: [] },
        { kind: 'thread-end', threadId: matchingEnd ? 'target' : 'other' }); },
    } });
    const report = await f.publicRunner({ ...f.input, contextMode: 'anonymous', trace: 'full', depth: 4 });
    assert.equal(starts.length, 1, report.error); assert.equal(starts[0].op, 'watch'); assert.equal(starts[0].trace.depth, 4);
    assert.equal(report.results[0].traceVerified, matchingEnd); assert.equal(report.ok, matchingEnd);
    assert.equal(report.serverTrace.stopped, true); assert.equal(report.lockRetained, false);
  }
});

test('public O11 endpoint keeps unknown Start outcome locked but releases a returned preflight refusal', async t => {
  for (const unknown of [false, true]) {
    const f = fixture(t, { anonymous: true, overrides: { debug: async () => {
      if (unknown) throw Error('private start transport detail');
      return { ok: false, state: 'refused', uncertain: false };
    } } });
    const input = { ...f.input, contextMode: 'anonymous', trace: 'nodes' };
    const report = await f.publicRunner(input);
    assert.equal(report.uncertain, unknown); assert.equal(report.lockRetained, unknown); assert.equal(f.invocations.length, 0);
    assert.doesNotMatch(JSON.stringify(report), /private start transport detail/);
    if (unknown) assert.equal((await f.publicRunner(input)).error, 'debug_o11_native_binding_busy');
  }
});

test('public O11 endpoint promotes worker uncertainty before trace work and never retries the next scenario', async t => {
  let settled = 0, sends = 0;
  const f = fixture(t, { anonymous: true, overrides: {
    debug: async request => request.op === 'stop' ? { ok: true, state: 'stopped' } : { ok: true, state: 'connected', sessionId: 's'.repeat(32) },
    traceRead: () => [], settle: async () => { settled++; throw Error('trace is unavailable'); },
    invokeEndpoint: async () => { sends++; return { ok: false, sent: true, answered: false, uncertain: false, memoryReferencesReleased: true }; },
  } });
  const report = await f.publicRunner({ ...f.input, inputs: undefined, contextMode: 'anonymous', trace: 'full',
    scenarios: [{ name: 'first', inputs: { Text: 'a' } }, { name: 'second', inputs: { Text: 'b' } }] });
  assert.equal(report.uncertain, true); assert.equal(report.lockRetained, true); assert.equal(sends, 1); assert.equal(settled, 0);
  assert.deepEqual(report.notSent, ['second']); assert.equal(report.serverTrace.stopped, true);
});
test('O11 Basic endpoint inspection binds published scope before sign-in and sends the same fixed deadline to every scenario', async t => {
  const lines = [], order = [], starts = [];
  let pinned;
  const f = fixture(t, { overrides: {
    prepareServerInspection: async binding => { pinned = binding; order.push('scope'); },
    beforeServerInvocation: async () => { order.push('before-invoke'); },
    debug: async request => {
      if (request.op === 'stop') return { ok: true, state: 'stopped' };
      starts.push(request); order.push('start');
      return { ok: true, state: 'connected', sessionId: 's'.repeat(32), inspectionMode: 'interactive',
        autoContinue: false, expiresAt: new Date(Date.now() + 45000).toISOString() };
    },
    traceRead: () => lines,
    settle: async () => { lines.push({ functionKey: key('b'), threadId: 'target' }, { kind: 'thread-end', threadId: 'target' }); },
  } });
  const report = await f.publicRunner({ ...f.input, inputs: undefined, trace: 'full',
    scenarios: [{ name: 'a', inputs: { Text: 'first' } }, { name: 'b', inputs: { Text: 'second' } }] });
  assert.equal(report.ok, true, report.error); assert.equal(report.serverTrace.stopped, true);
  assert.equal(pinned.lane, 'o11'); assert.equal(pinned.moduleKey, key('a')); assert.equal(pinned.functionKey, key('b'));
  assert.equal(hash(fs.readFileSync(pinned.source.path)), pinned.source.sha256);
  assert.deepEqual(order, ['scope', 'start', 'before-invoke', 'before-invoke']);
  assert.equal(starts[0].seconds, 600);
  assert.equal(f.invocations.length, 2);
  for (const invocation of f.invocations) {
    assert.equal(invocation.inspectionExpiresAt, report.serverTrace.requestDeadline);
    assert.ok(Date.parse(invocation.inspectionExpiresAt) <= Date.parse(invocation.descriptor.expiresAt));
    assert.equal(invocation.context, 'app-user');
  }
  assert.equal(report.credentialsReleased, true); assert.equal(report.lockRetained, false);
});
test('endpoint interactive preflight failure and cancellation never send a request', async t => {
  for (const atScope of [true, false]) {
    let sends = 0, released = false;
    const f = fixture(t, { overrides: {
      prepareServerInspection: async () => { if (atScope) throw Error('debug_o11_native_scope_source_changed'); },
      beforeServerInvocation: async () => { throw Error('debug_server_session_cancelled'); },
      debug: async request => request.op === 'stop' ? { ok: true, state: 'stopped' } :
        { ok: true, state: 'connected', sessionId: 's'.repeat(32), inspectionMode: 'interactive', autoContinue: false,
          expiresAt: new Date(Date.now() + 45000).toISOString() },
      invokeEndpoint: async () => { sends++; throw Error('must not invoke'); },
      releaseUser: async () => { released = true; return { ok: true }; },
    } });
    const report = await f.publicRunner({ ...f.input, trace: 'full' });
    assert.equal(report.ok, false); assert.equal(sends, 0); assert.equal(report.uncertain, false);
    assert.equal(f.calls.includes('prompt'), !atScope); assert.equal(released, !atScope);
  }
});
for (const [anonymous,soap] of [[false,false],[true,false],[true,true]]) test(`public server coordinator owns the O11 ${anonymous?'explicit anonymous':'Basic'} ${soap?'SOAP':'REST'} request through response and cleanup`, async t => {
  let answer, observedInput, sends = 0, stops = 0;
  const pending = new Promise(resolve => { answer = resolve; });
  let native = { ok: true, state: 'connected', pauses: [], events: [] };
  const f = fixture(t, { anonymous, soap, overrides: { invokeEndpoint: async request => {
    sends++; observedInput = request.inputs.Text;
    assert.ok(request.inspectionExpiresAt);
    assert.equal(request.context,anonymous?'explicit-anonymous':'app-user');
    assert.equal(!!request.descriptor,!anonymous);
    native.pauses = [{ threadId: 'rest-thread', eventId: '1', stack: [
      { frame: 0, module: 'Api', moduleKey: key('a'), action: 'Echo', functionKey: key('b'), nodeKey: key('e') }] }];
    await pending;
    return { ok: true, uncertain: false, sent: true, answered: true, memoryReferencesReleased: true,
      status: 200, result: { outputs: { Echo: observedInput } } };
  } } });
  const manager = createServerSessionManager({ root: f.root, run: debugRun, pollMs: 5,
    o11Runner: services => createO11NativeRun({ ...f.services, ...services }), prepareUser: f.services.prepareUser,
    readScopes: async binding => ({ evidence: [], variables: [{ moduleKey: key('a'), functionKey: key('b'),
      nodeKey: key('e'), variableKey: key('c'), sourceSha256: binding.source.sha256, name: 'Text', category: 'input', path: 'Text' }] }),
    debug: async (input,context) => {
      if (input.op === 'start') {
        assert.equal(input.autoContinue, false); assert.equal(input.trace, undefined); assert.equal(input.seconds, 300);
        if(anonymous){assert.equal(context.anonymousWatch,true);assert.equal(context.anonymousInspection.moduleKey,key('a'));}
        return { ok: true, state: 'connected', sessionId: 'a'.repeat(32), autoContinue: false, inspectionMode: 'interactive',
          expiresAt: new Date(Date.now() + 45000).toISOString() };
      }
      if (input.op === 'status') return structuredClone(native);
      if (input.op === 'scope') return { ok: true, metadataBound: true, variables: [{ reference: 'b'.repeat(32) }] };
      if (input.op === 'read') return { ok: true, value: observedInput };
      if (input.op === 'continue') {
        native.pauses = []; native.events = [{ kind: 'thread-end', threadId: 'rest-thread', eventId: '2' }]; answer(); return { ok: true };
      }
      if (input.op === 'stop') { stops++; native = { ok: true, state: 'stopped', pauses: [], events: [] }; return native; }
      throw Error('unexpected operation');
    },
  });
  const started = await manager(serverSessionSchema(debugRunToolSchema).parse({ op: 'start',
    run: { ...f.input, ...(anonymous?{contextMode:'anonymous'}:{}), execution: 'native-entry', trace: 'full' }, scopes: [{ functionKey: key('b'), nodeKeys: [key('e')] }] }));
  const wait = async expected => {
    let current = started;
    for (let i = 0; i < 100; i++) {
      current = await manager({ op: 'status', sessionId: started.sessionId, afterRevision: current.revision, waitMs: 100 });
      if (current.state === expected) return current;
      if (['failed', 'uncertain'].includes(current.state)) assert.fail(JSON.stringify(current));
    }
    assert.fail('public endpoint session did not reach ' + expected);
  };
  t.after(async () => { answer(); await manager({ op: 'stop', sessionId: started.sessionId }); });
  const paused = await wait('paused');
  const token = { sessionId: started.sessionId, threadId: 'rest-thread', eventId: '1', generation: paused.pauses[0].generation };
  const scope = await manager({ op: 'scope', ...token });
  const value = await manager({ op: 'read', ...token, reference: scope.variables[0].reference });
  assert.equal(value.value, 'hello');
  await manager({ op: 'continue', ...token });
  const done = await wait('completed');
  assert.equal(done.runResult.results[0].outputs.Echo, 'hello');
  assert.equal(done.runResult.results[0].serverThreadEnded, true);
  assert.equal(done.runResult.credentialsReleased, anonymous?undefined:true); assert.equal(done.runResult.lockRetained, false);
  assert.equal(sends, 1); assert.equal(stops, 1);
  assert.equal(f.calls.includes('prompt'),!anonymous);
});
