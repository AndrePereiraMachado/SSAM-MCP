import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceAddress } from '../../src/main/core/service-address.mjs';
test('production service is fixed; UI test overrides cannot send tokens to external servers', () => {
  assert.equal(serviceAddress({}), 'https://mcp.ssam.pro');
  assert.equal(serviceAddress({ SSAM_TEST_SERVER: 'https://example.com' }), 'https://mcp.ssam.pro');
  assert.equal(serviceAddress({ PLAYWRIGHT_MODULE: 'test', SSAM_TEST_SERVER: 'http://127.0.0.1:1234' }), 'http://127.0.0.1:1234');
  assert.throws(() => serviceAddress({ PLAYWRIGHT_MODULE: 'test', SSAM_TEST_SERVER: 'https://example.com' }));
  assert.throws(() => serviceAddress({ PLAYWRIGHT_MODULE: 'test', SSAM_TEST_SERVER: 'http://127.0.0.1.evil.test' }));
});
