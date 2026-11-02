// Lote 4, F3 (relatos af6dbc48 and e2179576, 18/10/2026): with the Service Studio connected and signed in, session=vault
// was answered by the Studio (sign-in auth.path=studio) and a read with session=vault said STUDIO_NOT_SIGNED_IN. The sign-in
// fix of 18/10 (index.mjs: explicit vault sign-in selects the stored profile even with the Studio open) is proven by
// sc-private-sign-in.test.mjs; here: the vault is consulted for the pages when asked, the API step that only the Studio
// serves refuses with its own code instead of a false STUDIO_NOT_SIGNED_IN, and every answer says which source answered
// (session {requested, source}). Synthetic bridge and profiles: no Studio, no vault, no credential.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Resolver, sessionSource } from '../service-center/auth.mjs';
import { AuthRequired } from '../service-center/errors.mjs';
import { runServiceCenter } from '../service-center/index.mjs';
import { Journal } from '../service-center/client.mjs';
import { FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';

const HOST = 'test.example.com';
const REGISTRY = path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json');
const PROFILE = { target: `SSAM/O11/${HOST}/ServiceCenter`, principal: 'dev@example.test' };

function profiles() {
  const asked = [];
  return { asked, resolve: async (scope, options) => { asked.push({ scope, options }); return { ok: true, ...PROFILE, source: 'selected' }; } };
}
const resolver = (bridge, store, session) => new Resolver(HOST, { session, prompt: 'never', locate: async () => bridge, profiles: store,
  present: async () => false, running: async () => false, opener: () => assert.fail('no prompt: the profile exists') });

test('session=vault consults the stored profile for the pages even with a signed-in Studio, and says so', async () => {
  const bridge = new FakeBridge(); // signed in, with the headless Studio web session
  const store = profiles();
  const auth = await resolver(bridge, store, 'vault').resolve('web');
  assert.equal(auth.path, 'vault');
  assert.equal(store.asked.length, 1, 'the vault was consulted');
  assert.equal(store.asked[0].scope.principal, 'dev@example.test', 'the Studio only constrains the principal');
  assert.deepEqual(auth.session(), { requested: 'vault', source: 'vault' });
  assert.deepEqual(bridge.calls.filter(c => c[0] !== 'session'), [], 'the Studio web session was not used');
});

test('session=auto with the same Studio answers from the Studio, and says so', async () => {
  const bridge = new FakeBridge();
  const store = profiles();
  const r = resolver(bridge, store, 'auto');
  assert.deepEqual((await r.resolve('api')).session(), { requested: 'auto', source: 'studio' });
  assert.equal((await r.resolve('web')).session().source, 'studio');
});

test('the API step under session=vault refuses with its own code, never STUDIO_NOT_SIGNED_IN for a signed-in Studio', async () => {
  const bridge = new FakeBridge();
  const error = await resolver(bridge, profiles(), 'vault').resolve('api').then(() => assert.fail('must refuse'), e => e);
  assert.ok(error instanceof AuthRequired);
  assert.equal(error.code, 'VAULT_API_UNAVAILABLE');
  const answer = error.answer();
  assert.equal(answer.auth.requested, 'vault');
  assert.match(answer.error, /only through the signed-in Studio \(dev@example\.test\)/);
  assert.match(answer.error, /Nothing was sent/);
  assert.deepEqual(answer.continuation.arguments, { action: 'status', host: HOST, session: 'vault' });
  assert.equal(answer.continuation.tool, 'o11_service_center_session');
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'api'), []);
  // A Studio that is really not signed in keeps its own answer.
  const unsigned = await resolver(new FakeBridge({ signed: false }), profiles(), 'vault').resolve('api').then(() => assert.fail('must refuse'), e => e);
  assert.equal(unsigned.code, 'STUDIO_NOT_SIGNED_IN');
});

test('the public answers carry session {requested, source}', async () => {
  const bridge = new FakeBridge({ api: { ListApplications: [{ Key: 'app-1', Name: 'Orders' }] } });
  const dir = temp();
  const run = (...argv) => runServiceCenter([...argv, '--host', HOST], { journal: new Journal(dir), locate: () => bridge, present: async () => false,
    running: async () => false, opener: () => assert.fail('no prompt'), exports: dir, registry: REGISTRY, profiles: profiles(), sleep: async () => {} });
  const read = await run('applications');
  assert.equal(read.ok, true);
  assert.deepEqual(read.session, { requested: 'auto', source: 'studio' });
  const refused = await run('applications', '--session', 'vault');
  assert.equal(refused.code, 'VAULT_API_UNAVAILABLE');
  const signIn = await run('session-sign-in', '--session', 'vault');
  assert.equal(signIn.auth.path, 'vault');
  assert.deepEqual(signIn.session, { requested: 'vault', source: 'vault' });
  const studioSignIn = await run('session-sign-in');
  assert.deepEqual(studioSignIn.session, { requested: 'auto', source: 'studio' });
});

test('every path names its source', () => {
  for (const [p, source] of [['studio', 'studio'], ['studio-http', 'studio'], ['studio-web', 'studio'], ['vault', 'vault'], ['vault-sso', 'vault'],
    ['vault-sso-cache', 'vault'], ['local-receipt', 'local'], ['other', 'unknown']]) assert.equal(sessionSource(p), source, p);
});
