import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioPortalBroker } from '../runtime/studio-portal.mjs';
import { Odc3PortalBroker, portalVault, setPointer } from '../runtime/odc3-context.mjs';
import { redact } from '../runtime/errors.mjs';

// Fakes of the bridge `portal-session` command and of the vault: no Studio, window or Portal is contacted.
function studioBroker(answer) {
  const files = new Map(), calls = [];
  const broker = new StudioPortalBroker({ host: 'personal-test.outsystems.dev', requestFile: json => { const f = 'req-' + files.size; files.set(f, json); return f; },
    bridge: async args => { calls.push(args); return answer(args, files.get(args[2])); } });
  broker.metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
  return { broker, files, calls };
}

test('timer prerequisites send only scoped reads and Wake remains distinct from a read', async () => {
  const { broker, files } = studioBroker(() => ({ ok: true, status: 200, host: 'personal-test.outsystems.dev', body: { data: { TimerInfo: { Key: 'timer', Password: 'private' } } } }));
  const variables = { appid: 'app', stageid: 'stage', id: 'timer', _appidInDataFetchStatus: 1, _stageidInDataFetchStatus: 1, _idInDataFetchStatus: 1 };
  for (const [operationId, action] of [['timers.info','DataActionGetTimerInfo'],['timers.currentRun','DataActionGetCurrentTimerRunInformation'],['timers.pendingConfiguration','DataActionGetPendingConfiguration'],['timers.latestDeployment','DataActionGetLatestDeployedAppVersion'],['timers.stages','DataActionGetApplicationStages'],['timers.deploymentStatus','DataActionCheckLatestDeployment']]) {
    const result = await broker.callScreenservice({ operationId, input: { screenVariables: variables } });
    const request = [...files.values()].at(-1);
    assert.equal(request.write, false); assert.equal(request.path, '/apps/screenservices/apps/Timers/timer/' + action);
    assert.deepEqual(request.body.screenData.variables, variables);
    assert.equal(result.data.TimerInfo.Password, 'private');
    assert.doesNotMatch(JSON.stringify(redact(result)), /private/);
  }
  await assert.rejects(broker.callScreenservice({ operationId: 'timers.run', input: {} }), { code: 'PORTAL_OPERATION_NOT_FOUND' });
  for (const operationId of ['timers.pause','timers.resume'])
    await assert.rejects(broker.callScreenservice({ operationId, input: {} }), { code: 'PORTAL_OPERATION_NOT_FOUND' });
  assert.equal(files.size, 6);
  for (const operationId of ['timers.pause','timers.resume']) {
    await broker.callScreenservice({operationId,write:true,input:{inputParameters:{EnvironmentKey:'stage'}},operationUuid:operationId,authorizeSha256:'hash'});
    const request=[...files.values()].at(-1);
    assert.equal(request.path,'/apps/screenservices/apps/Timers/timer/ActionTimers_SaveAndApply');
    assert.equal(request.write,true);assert.equal(request.operationUuid,operationId);
  }
});

test('the Studio headless adapter sends scoped requests and returns raw data for final projection', async () => {
  const { broker, files, calls } = studioBroker(() => ({ ok: true, status: 200, host: 'personal-test.outsystems.dev',
    body: { data: { Connections: [{ ConnectionId: 'c', Password: 'SECRET-PW' }] } } }));
  const body = await broker.callScreenservice({ operationId: 'connections.settings', input: { inputParameters: {}, screenVariables: { ConnectionId: 'c' }, clientVariables: {} } });
  assert.equal(body.data.Connections[0].Password, 'SECRET-PW');
  assert.doesNotMatch(JSON.stringify(redact(body)), /SECRET-PW/);
  assert.deepEqual(calls[0], ['portal-session', 'fetch', 'req-0', '--tenant', 'personal-test.outsystems.dev']);
  const sent = files.get('req-0');
  assert.equal(sent.path, '/connections/screenservices/connections/Connections/connection/DataActionGetSettings');
  assert.equal(sent.write, false); assert.equal(sent.body.viewName, 'Connections.connection');
  await assert.rejects(broker.request('https://other.outsystems.dev/x'), { code: 'PORTAL_ORIGIN_DENIED' });
  await assert.rejects(broker.callScreenservice({ operationId: 'connections.decryptedSecrets', input: {} }), { code: 'PORTAL_OPERATION_NOT_FOUND' });
});

test('headless session refusals keep their code without directing interactive sign-in; another origin is refused', async () => {
  const signIn = studioBroker(() => ({ ok: false, code: 'WEB_SIGN_IN_REQUIRED' }));
  await assert.rejects(signIn.broker.callScreenservice({ operationId: 'connections.settings', input: {} }), { code: 'WEB_SIGN_IN_REQUIRED' });
  const unavailable = studioBroker(() => ({ ok: false, code: 'HEADLESS_AUTH_UNAVAILABLE' }));
  await assert.rejects(unavailable.broker.callScreenservice({ operationId: 'connections.settings', input: {} }), error => {
    assert.equal(error.code, 'HEADLESS_AUTH_UNAVAILABLE'); assert.match(error.message, /private profile/);
    assert.doesNotMatch(error.message, /sign in there|open.*window/i); return true;
  });
  const uncertain = studioBroker(() => ({ ok: false, code: 'UNCERTAIN' }));
  await assert.rejects(uncertain.broker.callScreenservice({ operationId: 'connections.mcpSave', write: true, input: {}, operationUuid: 'u' }), { code: 'UNCERTAIN' });
  const moved = studioBroker(() => ({ ok: true, status: 200, finalUrl: 'https://evil.example/', body: { data: {} } }));
  await assert.rejects(moved.broker.callScreenservice({ operationId: 'connections.settings', input: {} }), { code: 'HOST_MISMATCH' });
  const write = studioBroker(() => ({ ok: true, status: 200, body: { data: { ok: true } } }));
  await write.broker.callScreenservice({ operationId: 'agents.guardrailsSave', write: true, input: { inputParameters: { X: '' } }, operationUuid: 'u-1', authorizeSha256: 'h',
    secretRefs: [{ pointer: '/inputParameters/X', target: 'SSAM/ODC3/personal-test.outsystems.dev/DB/Db', field: 'password' }] });
  const sent = write.files.get('req-0');
  assert.equal(sent.write, true); assert.equal(sent.operationUuid, 'u-1'); assert.equal(sent.authorizeSha256, 'h'); assert.equal(sent.secretRefs.length, 1);
});

test('secretRefs reach the bridge as vault entry names at empty placeholders of the wire body, writes only, this tenant only', async () => {
  const refs = [{ pointer: '/inputParameters/Common/ConnectionPassword', target: 'SSAM/ODC3/personal-test.outsystems.dev/DB/Sales', field: 'password' },
    { pointer: '/screenVariables/Login/User', target: 'SSAM/ODC3/personal-test.outsystems.dev/DB/Sales', field: 'username' }];
  const input = { inputParameters: { Common: { ConnectionPassword: '', ConnectionServer: 'db.test' } }, screenVariables: { Login: { User: '' } } };
  const ok = studioBroker(() => ({ ok: true, status: 200, body: { data: {} } }));
  await ok.broker.callScreenservice({ operationId: 'connections.relationalTest', write: true, input, secretRefs: refs, operationUuid: 'u-2', authorizeSha256: 'h' });
  const sent = ok.files.get('req-0');
  // The screenservice body nests screen variables under screenData.variables: the pointer names the wire body.
  assert.deepEqual(sent.secretRefs, [refs[0], { ...refs[1], pointer: '/screenData/variables/Login/User' }]);
  assert.equal(sent.body.inputParameters.Common.ConnectionPassword, ''); assert.equal(sent.body.screenData.variables.Login.User, '');
  const refused = async (extra, code = 'INPUT_INVALID') => {
    const h = studioBroker(() => ({ ok: true, status: 200, body: { data: {} } }));
    await assert.rejects(h.broker.callScreenservice({ operationId: 'connections.relationalTest', write: true, input, operationUuid: 'u-3', authorizeSha256: 'h', ...extra }), { code });
    assert.equal(h.calls.length, 0, 'nothing reaches the bridge');
  };
  await refused({ secretRefs: [{ ...refs[0], target: 'SSAM/ODC3/other.outsystems.dev/DB/Sales' }] });
  await refused({ secretRefs: [{ ...refs[0], target: 'SSAM/ODC3/personal-test.outsystems.dev/Portal' }] });
  await refused({ secretRefs: [{ ...refs[0], field: 'token' }] });
  await refused({ secretRefs: [{ ...refs[0], value: 'hunter2' }] });
  await refused({ secretRefs: [{ ...refs[0], pointer: '/inputParameters/Common/ConnectionServer' }] }); // not an empty placeholder
  await refused({ secretRefs: [{ ...refs[0], pointer: '/inputParameters/Common/Missing' }] });
  await refused({ secretRefs: [{ ...refs[0], pointer: '/versionInfo/apiVersion' }] });
  // A read never carries secretRefs.
  const read = studioBroker(() => ({ ok: true, status: 200, body: { data: {} } }));
  await assert.rejects(read.broker.request('https://personal-test.outsystems.dev/connections/screenservices/x', { method: 'POST', body: input, secretRefs: refs }), { code: 'INPUT_INVALID' });
  assert.equal(read.calls.length, 0);
});

test('the vault broker serves any tenant origin and never reads a DB secret: secretRefs writes are refused before anything is sent', async () => {
  const origin = 'https://personal-test.outsystems.dev';
  const reads = [], posted = [];
  const broker = new Odc3PortalBroker({ origin, credentialProvider: async (mode, database) => { reads.push([mode, database ?? null]);
    return mode === 'status' ? { available: true } : { available: true, username: 'db_user', password: 'SECRET-DB-PW' }; },
  fetchImpl: async (url, request) => { posted.push({ url: String(url), body: JSON.parse(request.body) });
    return new Response(JSON.stringify({ data: { Saved: true } }), { status: 200 }); } });
  broker.metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
  assert.equal(broker.status().origin, origin);
  assert.equal(broker.status().operatorAction, undefined);
  assert.match(broker.status().explanation, /compatible credential already configured.*personal-test/);
  await assert.rejects(broker.callScreenservice({ operationId: 'connections.settings', input: {} }), { code: 'PORTAL_AUTH_REQUIRED' });
  broker.authenticated = true;
  const input = { inputParameters: { Common: { ConnectionUsername: '', ConnectionPassword: '' } }, screenVariables: {}, clientVariables: {} };
  // CONTRATO.md wave 2 item 1: a secret value never enters the facade process; only the bridge reads it in the Studio.
  await assert.rejects(broker.callScreenservice({ operationId: 'connections.relationalTest', write: true, input,
    secretRefs: [{ pointer: '/inputParameters/Common/ConnectionPassword', target: 'SSAM/ODC3/personal-test.outsystems.dev/DB/Sales', field: 'password' }] }), error => {
      assert.equal(error.code, 'STUDIO_REQUIRED');
      assert.match(error.message, /headless transport/);
      assert.doesNotMatch(error.message, /Portal window|sign in there|open.*page/);
      return true;
    });
  assert.deepEqual(reads, []); assert.equal(posted.length, 0);
  await assert.rejects(portalVault('read', origin, 'Sales'), { code: process.platform === 'win32' ? 'STUDIO_REQUIRED' : 'PORTAL_AUTH_REQUIRED' });
  await assert.rejects(portalVault('read', origin, undefined, 'ApiPassword'), { code: process.platform === 'win32' ? 'STUDIO_REQUIRED' : 'PORTAL_AUTH_REQUIRED' });
  // Writes without secrets still go through the vault broker (its own Portal account sign-in).
  const answer = await broker.callScreenservice({ operationId: 'connections.relationalTest', write: true, input });
  assert.equal(posted[0].url, origin + '/connections/screenservices/connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnections_RelationalDB_Test_Wrapper');
  assert.equal(posted[0].body.inputParameters.Common.ConnectionPassword, '');
  assert.match(JSON.stringify(answer), /"Saved":true/);
  assert.throws(() => setPointer({}, '/headers/Authorization', 'x'), { code: 'INPUT_INVALID' });
});
