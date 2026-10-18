import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDebugAppUser, rememberO11EnvironmentAppUserProfile, rememberOdcEnvironmentAppUserProfile } from '../debug-app-user.mjs';
const input = { lane: 'o11', runtimeUrl: 'https://example.invalid/App/', module: 'App', moduleKey: 'A'.repeat(22) };
const profile = { lane: 'o11', runtimeUrl: input.runtimeUrl, host: 'example.invalid',
  target: 'SSAM/O11/example.invalid/ServiceCenter', appUserAuthorized: true };
test('explicit selected app-user profile imports privately without a dialog; defaults keep the dialog', async () => {
  for (const selectedProfile of [undefined, profile]) {
    const modes = [];
    const result = await prepareDebugAppUser(input, { selectedProfile, expire: async () => {},
      vault: async (mode, request) => { modes.push(mode); assert.equal('password' in request, false);
        return { ok: true, binding: request.binding, credentialRef: request.credentialRef, expiresAt: new Date(Date.now() + 120000).toISOString() }; },
      authenticate: async (op, descriptor) => ({ ok: true, state: 'credentials-entered', binding: descriptor.binding }) });
    assert.deepEqual(modes, [selectedProfile ? 'import-profile' : 'prompt']);
    assert.equal(result.descriptor.authenticated, false, 'stored credentials are not proof of O11 app login');
    assert.doesNotMatch(JSON.stringify(result), /profileTarget|password|ServiceCenter/);
  }
});
test('administrative profile is not adopted without explicit matching app-user selection', async () => {
  for (const delta of [{ appUserAuthorized: false }, { lane: 'odc' }, { runtimeUrl: 'https://example.invalid/Other/' }]) {
    let imported = false;
    await assert.rejects(prepareDebugAppUser(input, { selectedProfile: { ...profile, ...delta },
      vault: async mode => { if (mode !== 'forget') imported = true; return { ok: true }; } }), /debug_app_user_profile_scope_mismatch/);
    assert.equal(imported, false);
  }
});

test('O11 environment reuse requires explicit permission and the same environment', async () => {
  const selected = { ...profile, environmentAppUserAuthorized: true };
  const requests = [];
  const vault = async (mode, request) => { requests.push({ mode, request }); return { ok: true, remembered: true }; };
  for (const delta of [{ environmentAppUserAuthorized: false }, { host: 'other.invalid' }, { lane: 'odc' }])
    await assert.rejects(rememberO11EnvironmentAppUserProfile(input, { ...selected, ...delta }, { vault }), /profile_scope_mismatch/);
  await assert.rejects(rememberO11EnvironmentAppUserProfile({ ...input, lane: 'odc' }, selected, { vault }), /profile_scope_mismatch/);
  assert.equal(requests.length, 0);
  assert.equal((await rememberO11EnvironmentAppUserProfile(input, selected, { vault })).remembered, true);
  assert.equal(requests[0].mode, 'remember-environment-profile');
  assert.equal(requests[0].request.binding.runtimeUrl, input.runtimeUrl);
  assert.equal(requests[0].request.profileTarget, selected.target);
});

test('ODC environment reuse binds explicit app-user permission to both tenant and runtime origin', async () => {
  const target = { ...input, lane: 'odc', tenant: 'tenant.invalid', runtimeUrl: 'https://runtime.invalid/App/' };
  const selected = { lane: 'odc', host: 'tenant.invalid', runtimeOrigin: 'https://runtime.invalid',
    target: 'SSAM/ODC3/tenant.invalid/Portal', environmentAppUserAuthorized: true };
  const requests = [];
  const vault = async (mode, request) => { requests.push({ mode, request }); return { ok: true, remembered: true }; };
  for (const delta of [{ environmentAppUserAuthorized: false }, { host: 'other.invalid' },
    { runtimeOrigin: 'https://other.invalid' }, { lane: 'o11' }])
    await assert.rejects(rememberOdcEnvironmentAppUserProfile(target, { ...selected, ...delta }, { vault }), /profile_scope_mismatch/);
  await assert.rejects(rememberOdcEnvironmentAppUserProfile({ ...target, tenant: undefined }, selected, { vault }), /profile_scope_mismatch/);
  assert.equal(requests.length, 0);
  assert.equal((await rememberOdcEnvironmentAppUserProfile(target, selected, { vault })).remembered, true);
  assert.equal(requests[0].mode, 'remember-environment-profile');
  assert.equal(requests[0].request.binding.lane, 'odc');
  assert.equal(requests[0].request.binding.runtimeUrl, target.runtimeUrl);
});
