import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_USER_FIELDS, APP_USER_HEADERS, createJob, jobType } from '../debug-wrapper.mjs';

const token = 'b'.repeat(48), loginRef = '@' + 'L'.repeat(22);
const action = { name: 'GuardedAction', key: 'A'.repeat(22), inputs: [], outputs: [] };
const native = lane => createJob({ lane, actions: [action], token, appUser: true, ...(lane === 'o11' ? { loginRef } : {}) });
const props = (job, alias) => Object.fromEntries(job.ops.filter(o => o.op === 'set' && o.target === alias).map(o => [o.prop, o.value]));

test('current native reader basic types use their observed name when label is null', () => {
  assert.equal(jobType({ name: 'RedirectURL', dataTypeRef: { kind: 'BasicType', name: 'Text', label: null, key: 'uROOBXPvQEyU76NWO+1uxQ' } }), 'Text');
});

// A protocol fixture follows the emitted native connectors. It proves the authentication gates dominate the
// target call, including rejected logins and mismatched runtime identities; it is not a model Verify or a real
// Users provider. Those remain separate checks before publishing a candidate.
function execute(job, { suppliedToken = token, username = 'private-user', password = 'private-password',
  privateBody, runtimeUser = null, expectedUser = null, authenticate = () => 'user-1', target = () => 'ok' } = {}) {
  const created = new Map(job.ops.filter(o => o.op === 'create' && o.as).map(o => [o.as, o]));
  const links = job.ops.filter(o => o.op === 'link'), visits = [];
  let current = '$m0/#IStartNode[1]', user = runtimeUser, result, parsedInputs;
  for (let step = 0; step < 40 && !current.includes('/#IEndNode'); step++) {
    const node = created.get(current), p = props(job, current); visits.push(current);
    let branch;
    if (node?.type === 'IIfNode') {
      if (node.name === 'SSAMDebugAuthorized') branch = suppliedToken === token;
      else if (node.name === 'SSAMDebugIdentityValid') branch = Boolean(user) && (!p.Condition.includes('SSAMDebugExpectedUserId') || user === expectedUser);
      else assert.fail('Unexpected condition in fixture: ' + node.name);
    }
    if (node?.type === 'IJSONDeserializeNode') parsedInputs = JSON.parse(privateBody?.toString('utf8') ?? JSON.stringify({ [APP_USER_FIELDS.username]: username, [APP_USER_FIELDS.password]: password }));
    if (node?.type === 'IExecuteServerActionNode') {
      if (node.name === 'SSAMDebugLogin') {
        const inputValue = input => parsedInputs[props(job, current + '/' + input).Value.split('.').at(-1)];
        user = authenticate({ username: inputValue('Username'), password: inputValue('Password') });
      }
      else { assert.equal(p.Action, '@' + action.key); result = target(user); }
    }
    if (node?.name === 'SSAMDebugAuthenticationRequired') result = { error: 'debug_app_user_authentication_required' };
    const next = links.filter(o => o.from === current && (branch === undefined ? !o.connector : o.connector === (branch ? 'TrueTarget' : 'FalseTarget')));
    assert.equal(next.length, 1, 'Every fixture node has exactly one selected native connector: ' + current);
    current = next[0].to;
  }
  assert.ok(current.includes('/#IEndNode'), 'wrapper must terminate');
  return { visits, result, user };
}

test('native O11 requires the resolved published login key and refuses simulated action copies', () => {
  for (const missing of [undefined, 'Users.User_Login', 'IServerActionSignature:User_Login', '@short'])
    assert.throws(() => createJob({ lane: 'o11', actions: [action], token, appUser: true, loginRef: missing }), /login_ref_required/);
  for (const copy of [{ call: { ref: '@' + 'C'.repeat(22), inputs: [] } }, { copy: 'SSAMDebug_GuardedAction_AsUser' }])
    assert.throws(() => createJob({ lane: 'o11', actions: [{ ...action, ...copy }], token, appUser: true, loginRef }), /requires_original_action/);
  assert.throws(() => createJob({ lane: 'odc', actions: [action], token, appUser: true, loginRef }), /odc_login_not_server_side/);
  assert.throws(() => createJob({ actions: [action], token, appUser: { username: 'private-user', password: 'private-password' } }), /option_invalid/);
  for (const name of [APP_USER_FIELDS.username, APP_USER_FIELDS.password, APP_USER_FIELDS.password.toLowerCase()])
    assert.throws(() => createJob({ lane: 'o11', actions: [{ ...action, inputs: [{ name, jobType: 'Text' }] }], token, appUser: true, loginRef }), /reserved_input/);
});

test('O11 job consumes private UTF-8 body fields without secret literals or target credential arguments', () => {
  const job = native('o11'), text = JSON.stringify(job);
  assert.deepEqual(props(job, '$login0'), { Action: loginRef });
  assert.equal(props(job, '$login0/Username').Value, 'SSAMDebugInputs.Data.SSAMDebugUsername');
  assert.equal(props(job, '$login0/Password').Value, 'SSAMDebugInputs.Data.SSAMDebugPassword');
  assert.equal(props(job, '$login0/RememberLogin').Value, 'False');
  for (const name of Object.values(APP_USER_FIELDS)) {
    const attribute = job.ops.find(o => o.op === 'create' && o.type === 'IStructureAttribute' && o.name === name);
    assert.equal(attribute.parent, '$req0'); assert.equal(props(job, attribute.as).DataType, 'Text');
    assert.ok(!job.ops.some(o => o.op === 'create' && o.type === 'IRestServiceActionInput' && o.name === name));
    assert.ok(!job.ops.some(o => o.op === 'set' && o.target === '$call0/' + name));
  }
  assert.equal(props(job, '$identity0').Condition, 'GetUserId() <> NullIdentifier()');
  assert.equal(props(job, '$res2a0').Value, 'SSAMDebugSerialize.Json');
  assert.ok(!text.includes('private-user') && !text.includes('private-password'));
  const username = 'josé@example.invalid', password = 'pãss🔒漢字';
  const privateBody = Buffer.from(JSON.stringify({ [APP_USER_FIELDS.username]: username, [APP_USER_FIELDS.password]: password }), 'utf8');
  const accepted = execute(job, { privateBody, authenticate: received => { assert.deepEqual(received, { username, password }); return 'user-1'; } });
  assert.equal(accepted.result, 'ok'); assert.ok(!text.includes(username) && !text.includes(password));
});

test('O11 token rejection, failed password and missing native identity cannot reach target', () => {
  const job = native('o11'); let logins = 0, targets = 0;
  const authenticate = () => { logins++; return 'user-1'; }, target = () => { targets++; };
  const invalidToken = execute(job, { suppliedToken: 'wrong', authenticate, target });
  assert.equal(invalidToken.result.error, 'debug_app_user_authentication_required');
  assert.equal(logins, 0); assert.equal(targets, 0);
  assert.throws(() => execute(job, { authenticate: () => { throw new Error('invalid-credentials'); }, target }), /invalid-credentials/);
  assert.equal(targets, 0);
  assert.equal(execute(job, { authenticate: () => null, target }).result.error, 'debug_app_user_authentication_required');
  assert.equal(targets, 0);
  const accepted = execute(job, { authenticate, target: user => { targets++; assert.equal(user, 'user-1'); return 'ok'; } });
  assert.equal(accepted.result, 'ok'); assert.equal(targets, 1);
  assert.deepEqual(accepted.visits.slice(0, 5), ['$m0/#IStartNode[1]', '$if0', '$jd0', '$login0', '$identity0']);
});

test('ODC uses actual runtime identity, with no password or bearer model inputs', () => {
  const job = native('odc'); let targets = 0;
  assert.deepEqual(props(job, '$expectedUser0'), { DataType: 'User Identifier', ReceiveIn: 'Header', ReceiveAs: APP_USER_HEADERS.expectedUserId, IsMandatory: true });
  assert.equal(props(job, '$identity0').Condition, 'GetUserId() <> NullTextIdentifier() and GetUserId() = SSAMDebugExpectedUserId');
  assert.ok(!job.ops.some(o => o.op === 'create' && ['SSAMDebugPassword', 'SSAMDebugUsername', 'Authorization', 'SSAMDebugLogin'].includes(o.name)));
  const target = user => { targets++; return user; };
  for (const runtimeUser of [null, 'other-user'])
    assert.equal(execute(job, { runtimeUser, expectedUser: 'user-1', target }).result.error, 'debug_app_user_authentication_required');
  assert.equal(targets, 0);
  assert.equal(execute(job, { runtimeUser: 'user-1', expectedUser: 'user-1', target }).result, 'user-1');
  assert.equal(targets, 1);
});

test('all native methods have their own guards; legacy job stays unchanged by the opt-in', () => {
  const actions = [action, { ...action, name: 'SecondAction', key: 'B'.repeat(22) }];
  const job = createJob({ lane: 'o11', actions, token, appUser: true, loginRef });
  for (const i of [0, 1]) {
    assert.ok(job.ops.some(o => o.op === 'link' && o.from === '$identity' + i && o.connector === 'TrueTarget' && o.to === '$call' + i));
    assert.ok(job.ops.some(o => o.op === 'link' && o.from === '$identity' + i && o.connector === 'FalseTarget' && o.to === '$authFailure' + i));
    assert.equal(job.ops.filter(o => o.op === 'layout' && o.target === '$m' + i).length, 1);
  }
  assert.deepEqual(createJob({ actions, token }), createJob({ actions, token, appUser: false }));
  assert.ok(!createJob({ actions, token }).ops.some(o => o.name === 'SSAMDebugIdentityValid'));
});
