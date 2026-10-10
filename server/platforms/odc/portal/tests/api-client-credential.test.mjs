import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicApiEnvironment } from '../runtime/api-client-credential.mjs';

test('public API credentials already supplied by the trusted host take precedence', async () => {
  let calls = 0;
  const result = await resolvePublicApiEnvironment({ ODC_CLIENT_ID: 'host-id', ODC_CLIENT_SECRET: 'host-secret' }, async () => {
    calls++;
    return { available: true, clientId: 'vault-id', clientSecret: 'vault-secret' };
  });
  assert.equal(calls, 0);
  assert.equal(result.ODC_CLIENT_ID, 'host-id');
  assert.equal(result.ODC_CLIENT_SECRET, 'host-secret');
});

test('an absent API Client vault keeps catalog-only operation available', async () => {
  const result = await resolvePublicApiEnvironment({ ODC_PORTAL_ORIGIN: 'https://tenant.example.test' },
    async mode => ({ available: false, mode }));
  assert.equal(result.ODC_CLIENT_ID, undefined);
  assert.equal(result.ODC_CLIENT_SECRET, undefined);
});

test('the private API Client vault injects credentials only into the broker environment', async () => {
  const calls = [];
  const result = await resolvePublicApiEnvironment({}, async mode => {
    calls.push(mode);
    return mode === 'status' ? { available: true } : { available: true, clientId: 'vault-id', clientSecret: 'vault-secret' };
  });
  assert.deepEqual(calls, ['status', 'read']);
  assert.equal(result.ODC_CLIENT_ID, 'vault-id');
  assert.equal(result.ODC_CLIENT_SECRET, 'vault-secret');
  assert.equal(JSON.stringify({ configured: Boolean(result.ODC_CLIENT_ID && result.ODC_CLIENT_SECRET) }).includes('vault-secret'), false);
});

test('partial host or vault credentials fail closed', async () => {
  await assert.rejects(resolvePublicApiEnvironment({ ODC_CLIENT_ID: 'only-id' }), { code: 'CONFIGURATION_INVALID' });
  await assert.rejects(resolvePublicApiEnvironment({}, async mode => mode === 'status'
    ? { available: true } : { available: true, clientId: 'id' }), { code: 'API_CLIENT_VAULT_INCOMPLETE' });
});
