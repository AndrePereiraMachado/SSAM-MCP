// Window 4x4 (S2, C:\t\r5\janela-4x4\DESENHO.md 2.2 item 4): a Studio version in its grace period (SSAM_SERVED_VERSIONS
// retiring) is served as it is, and every answer tells the user when it leaves and which Studio to install (studioRetiring).
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { studioIdentity, studioWarningOf, studioRetiringOf, retiringVersions } from '../studio-identity.mjs';

const K = { odc: '1.7.32', o11: '11.55.95', odcBridge: 'v109' };
const env = { SSAM_SERVED_VERSIONS: JSON.stringify({ odc: ['1.7.32', '1.7.31', '1.7.30', '1.7.29', '1.7.28'], o11: ['11.55.92', '11.55.93', '11.55.94', '11.55.95'], retiring: { odc: { version: '1.7.28', retireAt: '2026-11-16T12:00:00.000Z' } } }) };
// The kernel of the backend the router reaches: the user's ODC Studio's own backend (kernel.json odc), and on the O11 lane the
// kernel of the user's Service Studio.
const at = (lane, version, e = env) => studioIdentity(lane, { dir: 'C:\\Users\\someone\\Studio', version }, { ...K, [lane]: version }, e);

test('retiringVersions reads the retiring key of the served versions, and nothing from a list without it', () => {
  assert.deepEqual(retiringVersions(env), { odc: { version: '1.7.28', retireAt: '2026-11-16T12:00:00.000Z' } });
  assert.deepEqual(retiringVersions({ SSAM_SERVED_VERSIONS: JSON.stringify({ odc: ['1.7.32'], o11: ['11.55.95'] }) }), {});
  assert.deepEqual(retiringVersions({ SSAM_SERVED_VERSIONS: 'not json' }), {});
});

test('the retiring Studio is served, with studioRetiring naming the day and the successor', () => {
  const id = at('odc', '1.7.28');
  assert.equal(id.ok, true);
  assert.deepEqual(id.retiring, { version: '1.7.28', retireAt: '2026-11-16T12:00:00.000Z', successor: '1.7.32' });
  const w = studioWarningOf(id);
  assert.equal(w.code, 'studioRetiring');
  assert.equal(w.retireAt, '2026-11-16T12:00:00.000Z');
  assert.match(w.userMessage, /2026-11-16/);
  assert.match(w.userMessage, /1\.7\.32/);
  assert.deepEqual(studioRetiringOf(id), w);
});

test('a kept Studio gets no retiring notice, nor does any Studio when nothing retires', () => {
  assert.equal(at('odc', '1.7.30').retiring, undefined);
  assert.equal(studioRetiringOf(at('odc', '1.7.30')), null);
  const plain = { SSAM_SERVED_VERSIONS: JSON.stringify({ odc: ['1.7.32', '1.7.28'], o11: ['11.55.95'] }) };
  assert.equal(at('odc', '1.7.28', plain).retiring, undefined);
});

test('an O11 version in its grace is retiring on the O11 lane only', () => {
  const o11 = { SSAM_SERVED_VERSIONS: JSON.stringify({ odc: ['1.7.32'], o11: ['11.55.92', '11.55.93', '11.55.94', '11.55.95', '11.55.96'], retiring: { o11: { version: '11.55.92', retireAt: '2026-11-20T00:00:00.000Z' } } }) };
  const id = at('o11', '11.55.92', o11);
  assert.equal(id.retiring?.successor, '11.55.96');
  assert.equal(studioWarningOf(id).code, 'studioRetiring');
  assert.equal(at('odc', '1.7.32', o11).retiring, undefined);
});
