// Portable acceptance checks: this exact file runs against the base and head.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithExecutor } from '../executor.mjs';
import { Resolver } from '../service-center/auth.mjs';
import { StudioBridge } from '../service-center/bridge.mjs';
import { CredentialProfiles } from '../credential-profiles.mjs';
import { OdcAccess } from '../../portal/runtime/access.mjs';

const host = 'personal-r40.outsystemscloud.com', tenant = 'r40.outsystems.dev', profile = 'a'.repeat(64), principal = 'person@example.test';
function run(fn) {
  const calls = [];
  const context = { hosted: true, lanes: ['o11', 'odc'], executor: { hosted: true, call: () => assert.fail('No legacy executor') },
    agent: { supports: k => k === 'credential.session', call: async (kind, args) => {
      calls.push({ kind, ...args });
      return args.op === 'request' ? { status: 200, body: 'e30=', contentType: 'application/json', url: args.url }
        : { available: true, authenticated: true, principal, profile, profiles: [{ principal, profile }] };
    } } };
  return runWithExecutor(context, () => fn(calls));
}
test('r40 base-head: Service Center expired web session selects the agent', () => run(async calls => {
  const bridge = { supports: async () => true, capabilities: async () => new Set(['sc_http:studioSession']),
    session: async () => ({ studio: { signedIn: true, user: principal } }), web: async () => ({ signedIn: false }) };
  const result = await new Resolver(host, { locate: async () => bridge, present: () => assert.fail('No server vault') }).resolve('web');
  assert.equal(result.path, 'agent-vault'); assert.equal(calls[0].op, 'status');
}));
test('r40 base-head: private Service Center HTTP executes on the agent', () => run(async calls => {
  const bridge = new StudioBridge(1, null, { request: () => assert.fail('No legacy bridge') });
  const result = await bridge.privateWeb(host, { method: 'GET', path: '/ServiceCenter/Errors_List.aspx' }, { principal });
  assert.equal(result.status, 200); assert.equal(calls.at(-1).op, 'request');
}));
test('r40 base-head: stored profiles resolve on the agent', () => run(async calls => {
  const result = await new CredentialProfiles().resolve({ lane: 'o11', host, principal }, { target: profile, interactive: false });
  assert.equal(result.ok, true); assert.equal(result.target, profile); assert.equal(calls[0].op, 'status');
}));
for (const auth of ['portal-credential', 'api-client']) test(`r40 base-head: Portal ${auth} selects the agent`, () => run(async calls => {
  const access = new OdcAccess({ hosted: true, studio: { running: async () => false }, vault: {} });
  const result = await (auth === 'api-client' ? access.resolvePublic(tenant, auth) : access.resolvePortal(tenant, auth));
  assert.equal(result.path, 'agent-vault'); assert.equal(calls[0].service, 'odc-portal');
}));
