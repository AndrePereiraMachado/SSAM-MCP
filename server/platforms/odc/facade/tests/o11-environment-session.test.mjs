// Lote 4, F3 (24/10/2026): ssam_map of a closed module answered CLI_REFUSED with the stack when the server refused the
// identity of the Studio's session (IDX20803 inside a SOAP fault). The kernel renews the lease once for a read
// (EnvironmentSessionRenewalTests); what is still refused is ENVIRONMENT_SESSION_EXPIRED with the Studio's own sign-in as
// the next step, on o11_environment and on the published-OML way of ssam_map. Never a credential field.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadModule, SESSION_EXPIRED } from '../o11-environment.mjs';
import { captureO11Module } from '../module-map.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { envelopes, tempKernel } from './fixtures/o11env-kernel.mjs';

const HOST = 'personal-test.outsystemscloud.com';
// The kernel's answer after the renewal (EnvironmentSessionExpiredException) and, for an older kernel, the text preserved on
// 24/10 (kernel/.local/answers/d8b6367a...) under ENVIRONMENT_SERVER_ERROR, the host replaced.
const renewedTwice = { ok: false, code: SESSION_EXPIRED, error: `EnvironmentSessionExpiredException: The OutSystems environment ${HOST} refused the session of the connected Studio for 'download' (its login token expired or could not be validated); renewed once from the Studio's current login and refused again; nothing was changed. Sign in again in the Service Studio (o11_studio login), then ssam_connect. Server answer: environment_session: FaultException: Server was unable to process request. ---> IDX20803: Unable to obtain configuration` };
const olderKernel = { ok: false, code: 'ENVIRONMENT_SERVER_ERROR', error: `EnvironmentServerErrorException: The OutSystems environment ${HOST} answered 'modules' with a failure; nothing was changed. Server answer: environment_session: FaultException: Server was unable to process request. ---> One or more errors occurred. ---> IDX20803: Unable to obtain configuration from: 'http://server.example/server.identity/.well-known/openid-configuration'.` };

function deps(t, download) {
  const kernel = tempKernel();
  t.after(() => kernel.cleanup());
  const runAnvil = fakeAnvil({ ...envelopes, download: () => download });
  return { root: kernel.root, lane: 'ss4', env: kernel.env, runAnvil, assertSelected: async () => {}, now: () => new Date('2026-10-25T12:00:00.000Z') };
}

const noCredentialAsked = value => {
  const text = JSON.stringify(value);
  assert.doesNotMatch(JSON.stringify(value.continuation?.arguments ?? {}), /password|secret|credential/i);
  assert.doesNotMatch(text, /CLI_REFUSED|ssam_doctor/);
};

test('a session the server still refuses after the renewal is ENVIRONMENT_SESSION_EXPIRED with the Studio sign-in next', async t => {
  const value = await downloadModule({ module: 'SSAM_DumpProbe' }, deps(t, renewedTwice));
  assert.equal(value.ok, false);
  assert.equal(value.code, SESSION_EXPIRED);
  assert.equal(value.session.renewed, true);
  assert.equal(value.session.source, 'studio');
  assert.deepEqual(value.continuation.arguments, { command: 'login', args: { host: HOST } });
  assert.equal(value.continuation.tool, 'o11_studio');
  assert.match(value.error, /nothing was changed/);
  assert.doesNotMatch(value.error, /FaultException|IDX20803/, 'the stack stays in the kernel answer');
  noCredentialAsked(value);
});

test('an older kernel answering the IDX failure as a server error gets the same refusal', async t => {
  const value = await downloadModule({ module: 'SSAM_DumpProbe' }, deps(t, olderKernel));
  assert.equal(value.code, SESSION_EXPIRED);
  assert.equal(value.session.renewed, false);
  assert.deepEqual(value.continuation.arguments.args, { host: HOST });
  noCredentialAsked(value);
});

test('without a host to name, the next step is ssam_connect', async t => {
  const value = await downloadModule({ module: 'SSAM_DumpProbe' }, deps(t, { ok: false, code: SESSION_EXPIRED, error: 'environment_session: SecurityTokenExpiredException: IDX10223' }));
  assert.equal(value.code, SESSION_EXPIRED);
  assert.deepEqual(value.continuation, { tool: 'ssam_connect', arguments: { lane: 'o11' }, why: value.continuation.why });
});

test('any other kernel refusal keeps its answer (non-regression)', async t => {
  const value = await downloadModule({ module: 'SSAM_DumpProbe' }, deps(t, { ok: false, code: 'ENVIRONMENT_SERVER_ERROR', error: 'EnvironmentServerErrorException: answered with a failure (HTTP 500)' }));
  assert.equal(value.code, 'CLI_REFUSED');
});

test('ssam_map of a module read from the published OML carries the refusal and its continuation', async t => {
  const d = deps(t, renewedTwice);
  const value = await captureO11Module('Users', { root: d.root, lane: d.lane, env: d.env,
    download: (input, options) => downloadModule(input, { ...options, runAnvil: d.runAnvil, assertSelected: d.assertSelected, now: d.now }) });
  assert.equal(value.ok, false);
  assert.equal(value.code, SESSION_EXPIRED);
  assert.equal(value.continuation.tool, 'o11_studio');
  noCredentialAsked(value);
});
