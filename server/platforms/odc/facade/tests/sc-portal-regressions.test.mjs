import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceCenterTool } from '../service-center/index.mjs';
import { AuthRequired } from '../service-center/errors.mjs';
import { withRefusalCode } from '../responses.mjs';
import { outcomeOf, operationName } from '../../../../facade/friction-store.mjs';
import { redact } from '../../portal/runtime/errors.mjs';

test('historical nested AUTH_REQUIRED remains the MCP and friction cause', async () => {
  const result = await serviceCenterTool(['applications', '--host', 'example.test'], {
    locate: async () => { throw new AuthRequired('AUTH_REQUIRED', 'Synthetic authentication refusal'); },
    present: async () => false, running: async () => false, journal: {},
  });
  const shaped = withRefusalCode('o11_service_center_read', result);
  assert.equal(shaped.code, 'AUTH_REQUIRED');
  assert.equal(outcomeOf(shaped).code, 'AUTH_REQUIRED');
  assert.equal(outcomeOf(shaped).step, 'authentication');
  assert.equal(outcomeOf(shaped).cause.kind, 'authentication');
});

test('friction retains safe HTTP/SOAP cause facts without remote bodies', () => {
  const result = outcomeOf({ ok: false, code: 'REMOTE_ERROR', status: 503, cause: { kind: 'soap', body: 'synthetic secret' }, error: 'synthetic secret' });
  assert.deepEqual(result.cause, { kind: 'soap', httpStatus: 503 });
  assert.equal(JSON.stringify(result).includes('synthetic secret'), false);
});

test('Portal and session calls retain their categories in the friction store', () => {
  for (const name of ['odc_portal_read', 'odc_portal_write', 'odc_portal_login', 'odc_portal_capabilities', 'o11_service_center_session'])
    assert.equal(operationName(name), name.replace(/^(odc|o11)_/, '').replaceAll('_', '-'));
});

test('friction rejects arbitrary cause fields, kinds and invalid HTTP status', () => {
  const secret = 'synthetic private server response';
  const invalid = outcomeOf({ok:false,code:'REMOTE_ERROR',status:700,cause:{kind:secret,body:secret,httpStatus:'503'}});
  assert.equal(invalid.cause, undefined);
  const known = outcomeOf({ok:false,code:'REMOTE_ERROR',cause:{kind:'http',httpStatus:403,body:secret,url:secret}});
  assert.deepEqual(known.cause,{kind:'http',httpStatus:403});
  assert.equal(JSON.stringify([invalid,known]).includes(secret),false);
});

test('redaction preserves scoped public UUIDs, but never an actual secret value or field', () => {
  const key = '11111111-2222-3333-4444-555555555555';
  assert.equal(redact({ environmentKey: key }, ['2222']).environmentKey, key);
  assert.equal(redact({ Key: key }, ['2222']).Key, key);
  assert.equal(redact({ environmentKey: key }, [key]).environmentKey, '[REDACTED]');
  assert.equal(redact({ apiKey: key }, ['2222']).apiKey, '[REDACTED]');
  assert.equal(redact({ message: 'secret 2222' }, ['2222']).message, 'secret 2222');
  assert.equal(redact({ message: 'secret fixture-token-long-2222' }, ['fixture-token-long-2222']).message, 'secret [REDACTED]');
});
