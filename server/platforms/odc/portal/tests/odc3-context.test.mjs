import test from 'node:test';
import assert from 'node:assert/strict';
import { Odc3PortalBroker, createOdc3HostContext } from '../runtime/odc3-context.mjs';
import { redact, OdcError } from '../runtime/errors.mjs';
import { boundedRead } from '../../facade/read-budget.mjs';
import { createLogScreenDefaults } from '../runtime/log-screen-defaults.mjs';
const origin = 'https://wrightflood.outsystems.dev';
const json = (data, headers = {}) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

test('A2A discovery gives remote fetch 60s, propagates cancellation and never retries',async t=>{
 const deadlines=[];t.mock.method(AbortSignal,'timeout',ms=>{const controller=new AbortController();deadlines.push({ms,controller});return controller.signal;});
 let sends=0,entered;const started=new Promise(resolve=>entered=resolve);
 const broker=new Odc3PortalBroker({origin,fetchImpl:async(url,options)=>{
  sends++;entered();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
 }});
 broker.authenticated=true;broker.metadata={resolve:async()=>({action:'connections/ProviderBlocks/Connection_Edit_A2A/ActionAgentDiscovery_GetAgentCard_Wrapper',moduleVersion:'v',apiVersion:'a'})};
 const request={operationId:'connections.a2aDiscover',write:true,input:{inputParameters:{AgentDiscovery:{url:'https://example.test/',environmentId:'stage'}}}};
 const pending=broker.callScreenservice(request);await started;
 assert.deepEqual(deadlines.map(d=>d.ms),[60000]);assert.equal(sends,1);
 const rejected=assert.rejects(pending,e=>e.name==='TimeoutError');
 deadlines[0].controller.abort(new DOMException('Deadline','TimeoutError'));await rejected;assert.equal(sends,1);
 const caller=new AbortController();caller.abort();
 await assert.rejects(broker.callScreenservice({...request,signal:caller.signal}),e=>e.code==='PORTAL_TIMEOUT');
 assert.equal(sends,1);assert.deepEqual(deadlines.map(d=>d.ms),[60000,60000]);
});
test('custom search test and save have bounded 60s writes with one send and no auth recovery on timeout',async t=>{
 for(const [operationId,action] of [['connections.customSearchTest','ActionConnections_CustomAISearch_Test_Wrapper'],['connections.customSearchSave','ActionConnection_Convert_CustomAISearch']]){
  const deadlines=[];t.mock.method(AbortSignal,'timeout',ms=>{const controller=new AbortController();deadlines.push({ms,controller});return controller.signal;});
  let sends=0,entered;const started=new Promise(resolve=>entered=resolve);
  const broker=new Odc3PortalBroker({origin,fetchImpl:async(url,options)=>{sends++;entered();return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}});
  broker.authenticated=true;broker.metadata={resolve:async()=>({action:'connections/ProviderBlocks/Connection_Edit_CustomAISearch/'+action,moduleVersion:'v',apiVersion:'a'})};
  const pending=broker.callScreenservice({operationId,write:true,input:{inputParameters:{}}});await started;
  assert.deepEqual(deadlines.map(d=>d.ms),[60000]);assert.equal(sends,1);
  const rejected=assert.rejects(pending,e=>e.name==='TimeoutError');deadlines[0].controller.abort(new DOMException('Deadline','TimeoutError'));await rejected;assert.equal(sends,1);
  const caller=new AbortController();caller.abort();await assert.rejects(broker.callScreenservice({operationId,write:true,input:{},signal:caller.signal}),e=>e.code==='PORTAL_TIMEOUT');
  assert.equal(sends,1);t.mock.restoreAll();
 }
});
const actions = {
  provider: '/authentication/screenservices/authentication/UnifiedAuthentication/login/DataActionGetProviders',
  complete: '/authentication/screenservices/authentication/UnifiedAuthentication/redirect/ActionProcessCodeRedirect',
  list: '/connections/screenservices/connections/Connections/connections/DataActionGetProviders',
};
test('all nonpublic cookie values of sufficient length enter the credential registry', async () => {
  const entries = ['TenantRing=1', 'TenantPortfolio=0', 'TenantGeo=US', 'language=pt-BR',
    'Unknown=long-but-not-authentication', 'tenant_session=synthetic-session-credential-12345'];
  const broker = new Odc3PortalBroker({ fetchImpl: async () => {
    const headers = new Headers();
    for (const entry of entries) headers.append('set-cookie', entry + '; Path=/; Secure');
    return new Response('{}', { headers });
  }});
  await broker.request(origin + '/');
  const dto = { Region: 'us-east-1', Hostname: 'wrightflood-dev.outsystems.app', DeploymentDateTime: '1900-01-01T00:00:00' };
  assert.deepEqual(redact(dto, broker.credentialRegistry), dto);
  assert.deepEqual([...broker.credentialRegistry.values()], ['long-but-not-authentication', 'synthetic-session-credential-12345']);
  assert.equal(redact({ cookie: 'TenantRing=1' }, broker.credentialRegistry).cookie, '[REDACTED]');
});
function fixture({ missing = false, challenge = false } = {}) {
  const credentialCalls = [], calls = [];
  const broker = new Odc3PortalBroker({ credentialProvider: async mode => {
    credentialCalls.push(mode);
    return mode === 'status' ? { available: !missing } : { available: true, username: 'PRIVATE_USERNAME', password: 'PRIVATE_PASSWORD' };
  }, fetchImpl: async (value, request) => {
    const url = new URL(value); calls.push({ url, request });
    if (url.pathname === actions.provider) {
      const login = new URL('https://id.outsystems.dev/login');
      login.searchParams.set('authorization_code', 'PRIVATE_AUTH_CODE'); login.searchParams.set('state', 'PRIVATE_STATE');
      login.searchParams.set('client_id', 'public-client'); login.searchParams.set('redirect_uri', origin + '/id/callback');
      return json({ data: { RedirectNowUrl: login.href } });
    }
    if (url.origin === 'https://cognito-idp.eu-west-1.amazonaws.com') {
      const input = JSON.parse(request.body);
      assert.equal(input.AuthParameters.PASSWORD, 'PRIVATE_PASSWORD');
      return json(challenge ? { ChallengeName: 'SOFTWARE_TOKEN_MFA' } : { AuthenticationResult: { AccessToken: 'PRIVATE_ACCESS_TOKEN_LONG', IdToken: 'PRIVATE_ID', RefreshToken: 'PRIVATE_REFRESH' } });
    }
    if (url.origin === 'https://id.outsystems.dev' && url.pathname === '/v1/storage') return json({ ok: true });
    if (url.pathname === '/id/callback') return new Response(null, { status: 302, headers: { Location: origin + '/authentication/redirect?code=PRIVATE_TENANT_CODE&state=PRIVATE_TENANT_STATE' } });
    if (url.pathname === actions.complete) return json({ data: {} }, { 'set-cookie': 'tenant_session=PRIVATE_SESSION_TOKEN_LONG; Path=/; Secure; HttpOnly' });
    if (url.pathname === actions.list) {
      assert.match(request.headers.Cookie, /tenant_session=PRIVATE_SESSION_TOKEN_LONG/);
      return json({ data: { Providers: [{ Id: 'mssql', Label: 'SQL Server' }] } });
    }
    return json({ data: { Logs: [{ LogId: 'log', Message: 'PRIVATE_ACCESS_TOKEN_LONG PRIVATE_SESSION_TOKEN_LONG' }] } });
  } });
  broker.metadata.resolve = async (module, view, action) => ({ moduleVersion: 'current-module', apiVersion: 'current-api', action, view });
  return { broker, calls, credentialCalls };
}

test('ODC3 host without a stored credential refuses without network, secret reads or interactive recovery', async () => {
  const { broker, calls, credentialCalls } = fixture({ missing: true });
  const context = await createOdc3HostContext({ env: {}, broker });
  assert.deepEqual(credentialCalls, ['status']); assert.equal(calls.length, 0);
  assert.equal(context.status().authenticated, false);
  const result = await context.authenticate();
  assert.equal(result.error.code, 'PORTAL_AUTH_REQUIRED');
  assert.equal(result.error.operatorAction, undefined);
  assert.equal(context.status().operatorAction, undefined);
  assert.match(result.error.message, /Headless authentication is unavailable/);
  assert.doesNotMatch(JSON.stringify(result), /-Mode bootstrap|Studio Portal window|private OS prompt/);
  assert.equal(credentialCalls.includes('read'), false); assert.equal(calls.length, 0);
  await assert.rejects(createOdc3HostContext({ env: { ODC_PORTAL_ORIGIN: 'https://other.example' }, broker }), error => error.code === 'PORTAL_TARGET_INVALID');
});

test('managed login completes full mocked session flow, confirms protected read and redacts its own secrets', async () => {
  const { broker, calls } = fixture();
  await broker.initialize();
  const login = await broker.authenticate();
  assert.equal(login.ok, true); assert.equal(login.session.authenticated, true);
  assert.equal(login.session.lastSuccessfulRead.operation, 'connections.providers');
  assert.equal(calls.filter(call => call.url.origin.includes('cognito')).length, 1);
  const output = await broker.readScreenservice({ target: 'odc3', origin, readOnly: true, operationId: 'monitoring.detail',
    module: 'monitoring', view: 'logs.log', action: 'monitoring/logs/log/DataActionGetLogById', inputParameters: {}, screenVariables: {} });
  assert.equal(output.body.data.Logs[0].Message, 'PRIVATE_ACCESS_TOKEN_LONG PRIVATE_SESSION_TOKEN_LONG');
  assert.equal(JSON.stringify(redact(output, broker.credentialRegistry)).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(login).includes('PRIVATE_'), false);
});

test('MFA challenge is explicit and never bypassed, replayed or treated as authenticated', async () => {
  const { broker, calls } = fixture({ challenge: true });
  const output = await broker.authenticate();
  assert.equal(output.error.code, 'PORTAL_LOGIN_CHALLENGE_REQUIRED');
  assert.equal(output.session.authenticated, false);
  assert.equal(calls.some(call => call.url.pathname === '/v1/storage'), false);
  assert.equal(calls.filter(call => call.url.origin.includes('cognito')).length, 1);
});

test('an expired protected read reauthenticates the same broker once and returns the fresh result', async () => {
  const { broker, calls } = fixture();
  assert.equal((await broker.authenticate()).ok, true);
  const fetch = broker.fetch; let expired = true;
  broker.fetch = async (value, options) => {
    if (expired && new URL(value).pathname === actions.list) { expired = false; return new Response('{}', {status:401}); }
    return fetch(value, options);
  };
  const result = await broker.callScreenservice({operationId:'connections.providers',input:{},write:false});
  assert.equal(result.data.Providers[0].Id, 'mssql');
  assert.equal(calls.filter(c=>c.url.origin.includes('cognito')).length, 2);
  assert.equal(broker.authenticated, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});

test('native No Session recovers once; unclassified 250 and a second expiry do not loop',async()=>{
 const {broker}=fixture();let sends=0,logins=0;
 broker.authenticate=async()=>{logins++;return {ok:true};};
 const expired=()=>new OdcError('PORTAL_AUTH_REQUIRED','Expired',{status:250,reason:'native-no-session'});
 assert.deepEqual(await broker.recoverRead(async()=>{if(++sends===1)throw expired();return {ok:true};}),{ok:true});
 assert.equal(sends,2);assert.equal(logins,1);
 sends=0;logins=0;await assert.rejects(broker.recoverRead(async()=>{sends++;throw expired();}),{code:'PORTAL_AUTH_REQUIRED'});
 assert.equal(sends,2);assert.equal(logins,1);
 logins=0;await assert.rejects(broker.recoverRead(async()=>{throw new OdcError('PORTAL_AUTH_REQUIRED','Unknown',{status:250});}),{code:'PORTAL_AUTH_REQUIRED'});assert.equal(logins,0);
});

test('permission denial keeps the session and never triggers reauthentication', async () => {
  const { broker } = fixture(); broker.authenticated = true;
  broker.fetch = async () => new Response('{}', {status:403});
  broker.authenticate = async () => assert.fail('No login on 403');
  await assert.rejects(broker.callScreenservice({operationId:'connections.providers',input:{},write:false}), e=>e.code==='PORTAL_ACCESS_DENIED');
  assert.equal(broker.authenticated, true);
});

test('typed reads recover once, while challenge and unclassified failures remain terminal', async () => {
  const { broker }=fixture(); broker.authenticated=true;
  let sends=0, logins=0;
  broker.action=async()=>{if(++sends===1)throw new OdcError('PORTAL_AUTH_REQUIRED','Expired',{status:401});return{data:{Logs:[]}};};
  broker.authenticate=async()=>{logins++;return{ok:true};};
  const request={target:'odc3',origin,readOnly:true,operationId:'monitoring.detail',module:'monitoring',view:'logs.log',action:'monitoring/logs/log/DataActionGetLogById',inputParameters:{},screenVariables:{}};
  assert.deepEqual((await broker.readScreenservice(request)).body,{data:{Logs:[]}});
  assert.equal(sends,2);assert.equal(logins,1);
  broker.action=async()=>{throw new OdcError('PORTAL_AUTH_REQUIRED','Expired',{status:401});};
  broker.authenticate=async()=>({ok:false,error:{code:'PORTAL_LOGIN_CHALLENGE_REQUIRED'}});
  await assert.rejects(broker.readScreenservice(request),e=>e.code==='PORTAL_LOGIN_CHALLENGE_REQUIRED');
  broker.action=async()=>{throw new OdcError('PORTAL_AUTH_REQUIRED','Unknown state');};
  broker.authenticate=async()=>assert.fail('No speculative login');
  await assert.rejects(broker.readScreenservice(request),e=>e.code==='PORTAL_AUTH_REQUIRED');
});

test('writes and second 401 responses are never replayed by read recovery', async () => {
  const { broker } = fixture(); broker.authenticated = true;
  let reads=0, logins=0;
  broker.action=async()=>{reads++;throw new OdcError('PORTAL_AUTH_REQUIRED','Expired',{status:401});};
  broker.authenticate=async()=>{logins++;return{ok:true};};
  await assert.rejects(broker.callScreenservice({operationId:'connections.relationalTest',input:{},write:true}), e=>e.code==='PORTAL_AUTH_REQUIRED');
  assert.equal(reads,1);assert.equal(logins,0);
  await assert.rejects(broker.callScreenservice({operationId:'connections.providers',input:{},write:false}), e=>e.code==='PORTAL_AUTH_REQUIRED');
  assert.equal(reads,3);assert.equal(logins,1);
});

test('recovery respects the original deadline and never starts another login after it', async () => {
  const { broker } = fixture(); broker.authenticated = true;
  let release, sends=0;
  broker.action=async()=>{sends++;await new Promise(resolve=>{release=resolve;});throw new OdcError('PORTAL_AUTH_REQUIRED','Expired',{status:401});};
  broker.authenticate=async()=>assert.fail('No login after deadline');
  const key='odc-expired-read-recovery-test';
  const result=await boundedRead(key,()=>broker.callScreenservice({operationId:'connections.providers',input:{},write:false}),{timeoutMs:5});
  assert.equal(result.code,'READ_DEADLINE_EXCEEDED');
  release();await new Promise(resolve=>setImmediate(resolve));
  const settled=await boundedRead(key,()=>assert.fail('No retry'));
  assert.equal(settled.code,'READ_DEADLINE_EXCEEDED');assert.equal(sends,1);
});

test('typed pagination survives short secret fragments while log text remains redacted', async () => {
  const { broker } = fixture();
  broker.authenticated = true;
  broker.credentialRegistry.add('1'); broker.credentialRegistry.add('2');
  const { screen } = createLogScreenDefaults();
  const calls = [];
  broker.action = async (_module, _view, action) => {
    calls.push(action.split('/').at(-1));
    if (action.endsWith('DataActionGetSettings')) return { data: screen.GetSettings };
    if (action.endsWith('DataActionGetFilter_Stages')) return { data: { EnvironmentList: { List: [{ Environment:
      { ...screen.SelectedEnviroment, Key: 'stage', PortfolioKey: 'portfolio' } }] } } };
    return { data: {
    LogSearch_Page: { Limit: '3', Offset: '0', NextPageOffset: '-1', TotalPages: '4', TotalResults: '12' },
    LogsList: { List: [{ Message: 'value 12', password: '12' }] }
  } }; };
  const result = await broker.readScreenservice({ target: 'odc3', origin, readOnly: true, operationId: 'monitoring.errors',
    module: 'monitoring', view: 'logs.logs', action: 'monitoring/logs/logs/DataActionLogSearch',
    clientVariables: { StageId: 'stage' }, screenVariables: { SelectedEnviroment: { Key: 'stage' } } });
  assert.deepEqual(calls, ['DataActionGetSettings', 'DataActionGetFilter_Stages', 'DataActionLogSearch']);
  assert.deepEqual(result.body.data.LogSearch_Page, { Limit: '3', Offset: '0', NextPageOffset: '-1', TotalPages: '4', TotalResults: '12' });
  assert.equal(result.body.data.LogsList.List[0].Message, 'value 12');
  assert.equal(result.body.data.LogsList.List[0].password, '12');
});

test('broker refuses cross-tenant/mutating calls and unallowlisted redirect origins', async () => {
  const { broker, calls } = fixture();
  await assert.rejects(broker.request('https://untrusted.example/'), error => error.code === 'PORTAL_ORIGIN_DENIED');
  await assert.rejects(broker.readScreenservice({ target: 'odc1', origin, readOnly: true }), error => error.code === 'PORTAL_ACCESS_DENIED');
  await assert.rejects(broker.readScreenservice({ target: 'odc3', origin, readOnly: false }), error => error.code === 'PORTAL_ACCESS_DENIED');
  assert.equal(calls.length, 0);
});

test('routing-cookie digits never corrupt scoped GUIDs or pagination; credential values remain redacted', async () => {
  const broker = new Odc3PortalBroker({ credentialProvider: async () => ({ available: false }), fetchImpl: async () => {
    const headers = new Headers();
    for (const value of ['TenantPortfolio=1; Path=/; Secure', 'TenantRing=3; Path=/; Secure', 'TenantGeo=us; Path=/; Secure', 'TenantAccess=PRIVATE_ACCESS; Path=/; Secure']) headers.append('Set-Cookie', value);
    return new Response(JSON.stringify({ data: { Page: { TotalResults: '3' }, ApplicationKey: 'e6e54de6-3d28-491d-a43b-079d2b3350f4',
      Message: 'TenantRing=3 PRIVATE_ACCESS_TOKEN_LONG' } }), { status: 200, headers });
  } });
  broker.authenticated = true;
  broker.metadata.resolve = async (_module, _view, action) => ({ moduleVersion: 'current', apiVersion: 'current', action });
  const output = await broker.readScreenservice({ target: 'odc3', origin, readOnly: true, operationId: 'monitoring.detail',
    module: 'monitoring', view: 'logs.log', action: 'monitoring/logs/log/DataActionGetLogById', inputParameters: {}, screenVariables: {} });
  assert.equal(output.body.data.ApplicationKey, 'e6e54de6-3d28-491d-a43b-079d2b3350f4');
  assert.equal(output.body.data.Page.TotalResults, '3');
  assert.equal(output.body.data.Message, 'TenantRing=3 PRIVATE_ACCESS_TOKEN_LONG');
});

test('vault failure does not prevent discovery startup and never leaks raw helper error', async () => {
  const broker = new Odc3PortalBroker({ credentialProvider: async () => { throw new Error('PRIVATE_HELPER_SECRET'); } });
  await broker.initialize();
  assert.equal(broker.status().authenticated, false);
  assert.equal(broker.status().bootstrapRequired, false);
  assert.equal(JSON.stringify(broker.status()).includes('PRIVATE_HELPER_SECRET'), false);
});

test('unverified current contracts require auth, while an explicit contract block fails closed', async () => {
  const { broker, calls } = fixture();
  await assert.rejects(broker.readScreenservice({ target: 'odc3', origin, readOnly: true, operationId: 'monitoring.logs' }),
    error => error.code === 'PORTAL_AUTH_REQUIRED');
  broker.authenticated = true;
  for (const operationId of ['monitoring.logs', 'monitoring.errors', 'monitoring.applications']) {
    broker.blockedOperations.add(operationId);
    await assert.rejects(broker.readScreenservice({ target: 'odc3', origin, readOnly: true, operationId }),
      error => error.code === 'PORTAL_CONTRACT_CHANGED');
  }
  assert.equal(calls.length, 0);
});

test('trace block inherits the containing screen wire view and rejects an unqualified view or discovery route', async () => {
  const calls = [], resolved = [];
  const dependencies = {
    GetStage: { FoundStage: true, Environment: { Key: 'stage', PortfolioKey: 'portfolio', Name: 'DEV', Purpose: 'Development' } },
    GetSettings: { MaxSupportedSpans: '8000', MaxSpansExpandDegreeLevel: 3, IsTraceDuratiomFilterEnabled: true },
    GetTraceById: { NotFound: false, Trace: { Id: 'trace', StartTime: '2026-10-04T19:03:08.247Z', StatusLabel: 'Ok' } },
  };
  const broker = new Odc3PortalBroker({ credentialProvider: async () => ({ available: false }), fetchImpl: async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    const action = new URL(url).pathname.split('/DataAction')[1];
    return json({ data: dependencies[action] ?? { SpansList: {} } });
  } });
  broker.authenticated = true;
  broker.metadata.resolve = async (module, view, action) => { resolved.push({ module, view, action }); return { moduleVersion: 'current-module', apiVersion: 'current-action', action }; };
  const input = { target: 'odc3', origin, operationId: 'monitoring.trace', module: 'monitoring', view: 'traces.trace',
    discoveryView: 'traces.trace', action: 'monitoring/traces/TreeView_multipleRoots/DataActionGetSpans', readOnly: true,
    screenVariables: { StageKey: 'stage', TraceKey: 'trace', IsReadyToLoad: true, FetchAgentTraceData: false } };
  await broker.readScreenservice(input);
  assert.deepEqual(calls.map(call => new URL(call.url).pathname.split('/DataAction')[1]), ['GetStage', 'GetSettings', 'GetTraceById', 'GetSpans']);
  assert.equal(resolved.every(call => call.view === 'traces.trace'), true);
  assert.equal(calls.every(call => call.body.viewName === 'traces.trace'), true);
  const block = calls.at(-1);
  assert.equal(new URL(block.url).pathname, '/monitoring/screenservices/' + input.action);
  assert.equal(block.body.screenData.variables.StageKey, input.screenVariables.StageKey);
  assert.equal(block.body.screenData.variables.TraceKey, input.screenVariables.TraceKey);
  assert.equal(block.body.screenData.variables.TraceStartTime, dependencies.GetTraceById.Trace.StartTime);
  assert.equal(block.body.screenData.variables.MaxSupportedSpans, dependencies.GetSettings.MaxSupportedSpans);
  await assert.rejects(broker.readScreenservice({ ...input, view: 'traces.TreeView_multipleRoots' }), { code: 'PORTAL_ACCESS_DENIED' });
  await assert.rejects(broker.readScreenservice({ ...input, discoveryView: 'traces.agenttrace' }), { code: 'PORTAL_ACCESS_DENIED' });
  assert.equal(calls.length, 4);
  assert.equal(resolved.length, 4);
});

test('native tenant SRP flow passes observed inputs to Portal and proves protected provider read', async () => {
  const { broker } = fixture();
  const received = [];
  broker.cognito = async input => {
    assert.equal(input.config.AuthFlow, 'USER_SRP_AUTH');
    assert.equal(input.password, 'PRIVATE_PASSWORD');
    return { IdToken: 'PRIVATE_ID', AccessToken: 'PRIVATE_ACCESS_TOKEN_LONG', RefreshToken: 'PRIVATE_REFRESH' };
  };
  broker.action = async (module, view, action, parameters, variables) => {
    received.push({ action, parameters, variables });
    if (action.endsWith('/DataActionGetProviders') && module === 'authentication') return { data: { CognitoEnabled: true, CognitoConfig: { AuthFlow: 'USER_SRP_AUTH' } } };
    if (action.endsWith('/DataActionGetRedirect')) return { data: { Url: origin + '/broker/start' } };
    if (action.endsWith('/ActionProcessCognitoToken')) return { data: { AuthCode: 'PRIVATE_COGNITO_CODE' } };
    if (action.endsWith('/ActionProcessCodeRedirect')) return { data: {} };
    if (module === 'connections') return { data: { Providers: { List: [] } } };
    throw new Error('Unexpected action');
  };
  broker.redirects = async url => url.includes('/broker/start')
    ? new URL(origin + '/authentication/login?client_id=client&redirect_uri=' + encodeURIComponent(origin + '/broker/callback') + '&state=PRIVATE_STATE')
    : new URL(origin + '/authentication/redirect?code=PRIVATE_FINAL_CODE&state=PRIVATE_FINAL_STATE');
  const output = await broker.authenticate();
  assert.equal(output.ok, true); assert.equal(output.session.authenticated, true);
  const call = received.find(entry => entry.action.endsWith('/ActionProcessCognitoToken'));
  assert.equal(call.parameters.ClientId, 'client');
  assert.equal(call.parameters.CognitoAccessToken, 'PRIVATE_ACCESS_TOKEN_LONG');
  assert.equal(call.variables.state, 'PRIVATE_STATE');
  assert.equal(JSON.stringify(output).includes('PRIVATE_'), false);
});
