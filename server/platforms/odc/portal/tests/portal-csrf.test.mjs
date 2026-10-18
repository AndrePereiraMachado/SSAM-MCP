import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { portalCsrf } from '../runtime/portal-csrf.mjs';
test('own Portal context supports direct and native URL-encoded nr2 CSRF cookies', () => {
  assert.equal(portalCsrf([{ key: 'crf', value: 'direct-value' }]), 'direct-value');
  assert.equal(portalCsrf([{ key: 'nr2Users', value: encodeURIComponent('uid=1;crf=embedded-value;flags=0') }]), 'embedded-value');
  assert.equal(portalCsrf([{ key: 'nr2Users', value: encodeURIComponent('crf=embedded-value') }]), 'embedded-value');
  assert.equal(portalCsrf([{ key: 'nr2Users', value: '%zz' }, { key: 'unrelated', value: 'crf=wrong' }]), '');
  assert.equal(portalCsrf([{ key: 'crf', value: 'value\r\nInjected: value' }]), '');
  assert.equal(portalCsrf([]), '');
});
