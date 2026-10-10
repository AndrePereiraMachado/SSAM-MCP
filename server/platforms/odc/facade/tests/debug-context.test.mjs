import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../debug-context.mjs';
import { classify, container, entryChain, parseRoles } from '../debug-entry.mjs';
import { removeJob, createJob } from '../debug-wrapper.mjs';

test('user functions become context inputs; everything else is untouched', () => {
  assert.deepEqual(C.rewrite('(CheckFloodQuotesRole())'), { text: '(SSAMDebugRole_FloodQuotes)', roles: ['FloodQuotes'], usesUser: false, changed: true });
  assert.equal(C.rewrite('CheckAdminRole(GetUserId()) and x').text, 'SSAMDebugRole_Admin and x');
  assert.equal(C.rewrite('CheckAdminRole(Owner.Id)').text, '(SSAMDebugRole_Admin and Owner.Id = SSAMDebugUserId)');
  assert.equal(C.rewrite('GetUserId() = NullIdentifier()').text, 'SSAMDebugUserId = NullIdentifier()');
  assert.equal(C.rewrite('LocationDrpid <> ""').changed, false);
});

// Shape seen live (FloodQuotes r255, ServerAction:ValidateQuoteRequest): If.Condition and Assignment.Value carry text.
const tree = {
  key: 'A'.repeat(22), children: [
    { kind: 'IfNode', key: 'IF1aaaaaaaaaaaaaaaaaaa', label: 'Access allowed?', properties: { Condition: '(CheckFloodQuotesRole())' }, children: [] },
    { kind: 'IfNode', key: 'IF2aaaaaaaaaaaaaaaaaaa', label: 'Location ready?', properties: { Condition: 'LocationDrpid <> ""' }, children: [] },
    { kind: 'AssignNode', key: 'AS1aaaaaaaaaaaaaaaaaaa', label: 'Who', properties: {}, children: [
      { kind: 'Assignment', key: 'AS1bbbbbbbbbbbbbbbbbbb', properties: { Variable: 'Owner', Value: 'GetUserId()' }, children: [] }] },
  ],
};

test('scan finds every user-context expression, and rebind moves each rewrite to the copy element with identical text', () => {
  const scanned = C.scan(tree);
  assert.deepEqual(scanned.roles, ['FloodQuotes']); assert.equal(scanned.usesUser, true); assert.equal(scanned.edits.length, 2);
  const copy = JSON.parse(JSON.stringify(tree).replace(/IF1a/g, 'CP1a').replace(/AS1b/g, 'CP2b'));
  const edits = C.rebind(scanned, copy);
  assert.deepEqual(edits.map(e => e.key), ['CP1aaaaaaaaaaaaaaaaaaa', 'CP2bbbbbbbbbbbbbbbbbbb']);
  const changed = JSON.parse(JSON.stringify(copy)); changed.children[0].properties.Condition = '(True)';
  assert.throws(() => C.rebind(scanned, changed), /rebind_failed/);
  const ops = C.copyOps('@COPYaaaaaaaaaaaaaaaaaa', scanned, edits, '0');
  assert.ok(ops.some(o => o.name === 'SSAMDebugUserId') && ops.some(o => o.name === 'SSAMDebugRole_FloodQuotes'));
  assert.deepEqual(ops.filter(o => o.prop === 'Condition' || o.prop === 'Value').map(o => [o.target, o.value]), [['@CP1aaaaaaaaaaaaaaaaaaa', '(SSAMDebugRole_FloodQuotes)'], ['@CP2bbbbbbbbbbbbbbbbbbb', 'SSAMDebugUserId']]);
});

test('scenario context: the platform user by default, anonymous with user null, single roles overridden', () => {
  const scanned = { usesUser: true, roles: ['Administrator', 'FloodQuotes'] };
  const me = { key: '8b8c5f87-74aa-4bf4-bf74-ba39557ce2fb', roles: { FloodQuotes: true, Administrator: true } };
  assert.deepEqual(C.contextValues(scanned, me), { SSAMDebugUserId: me.key, SSAMDebugRole_Administrator: true, SSAMDebugRole_FloodQuotes: true });
  assert.deepEqual(C.contextValues(scanned, me, { roles: { FloodQuotes: false } }).SSAMDebugRole_FloodQuotes, false);
  assert.deepEqual(C.contextValues(scanned, me, { user: null }), { SSAMDebugUserId: '', SSAMDebugRole_Administrator: false, SSAMDebugRole_FloodQuotes: false });
});

const contextScope = { assetKey: 'app-A', environmentKey: 'development-A' };
const contextScan = { usesUser: true, roles: ['Administrator', 'FloodQuotes'] };
const currentUser = { key: '8b8c5f87-74aa-4bf4-bf74-ba39557ce2fb', email: 'developer@example.test' };
const loadContextUser = portal => identity => C.platformUser(portal, { email: identity }, contextScope);

for (const deniedRead of ['users', 'application-roles']) {
  test(`context preparation stops when the ${deniedRead} API refuses; private diagnostics are not exposed`, async () => {
    const calls = [];
    const portal = { read: async operation => {
      calls.push(operation);
      if (operation.endsWith(deniedRead === 'users' ? '/users' : '/application-roles')) throw new Error('private Portal transport details');
      return { results: [currentUser] };
    } };
    await assert.rejects(C.prepareScenarioContexts(contextScan, [{ inputs: {} }], {
      defaultUser: currentUser.email, loadUser: loadContextUser(portal),
    }), error => error.message === 'debug_context_unavailable');
    assert.equal(calls.length, deniedRead === 'users' ? 1 : 2);
  });
}

test('a later unavailable user rejects the whole prepared batch without releasing the first scenario', async () => {
  const calls = [];
  const portal = { read: async (operation, args) => {
    calls.push(operation);
    if (operation.endsWith('/application-roles')) return { results: [{ ...contextScope, name: 'FloodQuotes' }] };
    return { results: args.query.nameOrEmailContains === currentUser.email ? [currentUser] : [] };
  } };
  let released = false;
  const batch = C.prepareScenarioContexts(contextScan, [
    { name: 'first', inputs: {}, trace: false },
    { name: 'second', inputs: {}, trace: true, as: { user: 'missing@example.test' } },
  ], { defaultUser: currentUser.email, loadUser: loadContextUser(portal) }).then(prepared => { released = true; return prepared; });
  await assert.rejects(batch, error => error.message === 'debug_context_unavailable');
  assert.equal(released, false);
  assert.equal(calls.length, 3);
});

test('anonymous scenarios need no user or role API reads; overrides remain explicit simulation', async () => {
  let reads = 0;
  const prepared = await C.prepareScenarioContexts(contextScan, [
    { name: 'anonymous', inputs: { Request: 'x' }, as: { user: null } },
    { name: 'simulated-role', inputs: {}, as: { user: null, roles: { FloodQuotes: true } } },
  ], { defaultUser: currentUser.email, loadUser: async () => { reads++; throw new Error('must not read'); } });
  assert.equal(reads, 0);
  assert.deepEqual(prepared[0].call, { body: { Request: 'x', SSAMDebugUserId: '', SSAMDebugRole_Administrator: false, SSAMDebugRole_FloodQuotes: false },
    as: { user: null, roles: { Administrator: false, FloodQuotes: false } } });
  assert.equal(prepared[1].call.body.SSAMDebugRole_FloodQuotes, true);
  assert.equal(prepared[1].call.as.simulated, true);
});

test('users are cached per batch, real roles stay scoped, and simulation cannot be mistaken for assigned roles', async () => {
  const calls = [];
  const portal = { read: async (operation, args) => {
    calls.push({ operation, args });
    if (operation.endsWith('/users')) return { results: [currentUser] };
    return { results: [
      { ...contextScope, name: 'FloodQuotes' },
      { assetKey: 'other-app', environmentKey: contextScope.environmentKey, name: 'Administrator' },
      { assetKey: contextScope.assetKey, environmentKey: 'other-environment', name: 'Administrator' },
    ] };
  } };
  const prepared = await C.prepareScenarioContexts(contextScan, [
    { name: 'default', inputs: { SSAMDebugUserId: 'spoofed' } },
    { name: 'same-user', inputs: {}, as: { user: currentUser.email } },
    { name: 'simulated', inputs: {}, as: { roles: { Administrator: true, FloodQuotes: false } } },
  ], { defaultUser: currentUser.email, loadUser: loadContextUser(portal) });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args.query, { ...contextScope, limit: 100 });
  assert.equal(prepared[0].call.body.SSAMDebugUserId, currentUser.key);
  assert.deepEqual(prepared[0].call.as, { user: currentUser.email, roles: { Administrator: false, FloodQuotes: true } });
  assert.deepEqual(prepared[1].call.as, prepared[0].call.as);
  assert.deepEqual(prepared[2].call.as, { user: currentUser.email, roles: { Administrator: true, FloodQuotes: false }, simulated: true });
});

test('targets without context rewriting do not resolve user APIs', async () => {
  const inputs = { Request: 'x' };
  const prepared = await C.prepareScenarioContexts(null, [{ inputs }], {
    defaultUser: currentUser.email, loadUser: async () => { throw new Error('must not read'); },
  });
  assert.deepEqual(prepared[0].call, { body: inputs, as: null });
});

test('the wrapper calls the copy with the context inputs, and the removal deletes the copy after the service', () => {
  const action = { name: 'ValidateQuoteRequest', key: '4xRgdckMFkiejvGYYpUDuw', inputs: [{ name: 'LocationDrpid', dataTypeRef: { kind: 'BasicType', label: 'Text' } }], outputs: [],
    call: { ref: '@COPYaaaaaaaaaaaaaaaaaa', inputs: [{ name: 'SSAMDebugUserId', jobType: 'User Identifier' }, { name: 'SSAMDebugRole_FloodQuotes', jobType: 'Boolean' }] }, copy: 'SSAMDebug_ValidateQuoteRequest_AsUser' };
  const ops = createJob({ actions: [action], token: 'd'.repeat(48) }).ops;
  assert.ok(ops.some(o => o.prop === 'Action' && o.value === '@COPYaaaaaaaaaaaaaaaaaa'));
  assert.ok(ops.some(o => o.target?.endsWith('/SSAMDebugRole_FloodQuotes') && o.value === 'SSAMDebugInputs.Data.SSAMDebugRole_FloodQuotes'));
  assert.ok(ops.some(o => o.prop === 'DataType' && o.value === 'User Identifier'));
  const removal = removeJob({ actions: [action] }).ops.map(o => o.target);
  assert.deepEqual(removal.slice(0, 2), ['IRestService:SSAMDebug', 'IServerAction:SSAMDebug_ValidateQuoteRequest_AsUser']);
});

test('entries: callers are climbed to the screen, the timer or the REST method, with what each needs from the user', async () => {
  assert.deepEqual(parseRoles('[AppRole:FloodQuotes, AppRole:Administrator]'), ['FloodQuotes', 'Administrator']);
  assert.deepEqual(classify(container('MobileFlow:MainFlow/MobileScreen:Options/DataAction:GetQuoteOptions/ExecuteServerActionNode:ValidateQuoteRequest')),
    { entry: 'screen', screenPath: 'MobileFlow:MainFlow/MobileScreen:Options', via: 'DataAction:GetQuoteOptions' });
  assert.deepEqual(classify(container('ServerAction:Helper/ExecuteServerActionNode:X')), { climb: 'ServerAction:Helper' });
  // Helper (private) is called by a data action of an anonymous screen and by a timer action's flow.
  const usages = { T: [{ path: 'ServerAction:Helper/ExecuteServerActionNode:T' }], H: [{ path: 'MobileFlow:F/MobileScreen:Open/DataAction:Load/ExecuteServerActionNode:Helper' }, { path: 'Timer:Nightly/ExecuteServerActionNode:Helper' }] };
  const props = { 'ServerAction:Helper': { key: 'H', public: false }, 'MobileFlow:F/MobileScreen:Open': { key: 'S', properties: { Roles: '[]', AnonymousAccess: 'True' } } };
  const chain = await entryChain({ targetKey: 'T', targetPath: 'ServerAction:Target', usages: async k => usages[k] ?? [], properties: async p => props[p] });
  assert.deepEqual(chain.entries.map(e => [e.entry, e.depth, e.needsUser]), [['screen', 2, false], ['timer', 2, false]]);
  assert.deepEqual(chain.nearest.chain, ['ServerAction:Target', 'ServerAction:Helper', 'MobileFlow:F/MobileScreen:Open/DataAction:Load']);
});
