import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialProfiles, profileContext } from '../credential-profiles.mjs';
import { runServiceCenter } from '../service-center/index.mjs';

const host = 'private.example.test';
const principal = 'developer@example.test';
const context = { lane: 'o11', host, principal };

function setup(t, signedIn = true) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-private-sign-in-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const entries = [], windows = [], calls = [];
  const profiles = new CredentialProfiles({ state, list: async () => entries,
    open: async (...args) => { windows.push(args); fs.writeFileSync(args[2], JSON.stringify({ state: 'visible', pid: process.pid })); } });
  const bridge = { supports: async () => true,
    session: async h => { calls.push(h); return { studio: { signedIn, user: principal } }; } };
  const run = (extra = []) => runServiceCenter(['session-sign-in', '--host', host, '--session', 'vault', ...extra], {
    profiles, locate: async () => bridge, present: async () => false,
    opener: () => assert.fail('must use the managed private profile form'),
    running: () => assert.fail('must not require closing Studio')
  });
  return { state, entries, windows, calls, run };
}

test('explicit vault sign-in opens one private form with Studio open, then reuses the saved profile', async t => {
  const h = setup(t);
  for (let i = 0; i < 2; i++) {
    const pending = await h.run();
    assert.equal(pending.code, 'CREDENTIAL_SELECTION_PENDING');
    assert.equal(pending.auth.resumable, true);
    assert.deepEqual(pending.continuation.arguments, { action: 'sign-in', host, session: 'vault' });
  }
  assert.equal(h.windows.length, 1);
  assert.deepEqual(h.windows[0][0], profileContext(context));
  const selected = { target: `SSAM/O11/${host}/ServiceCenter`, principal };
  h.entries.push(selected);
  fs.writeFileSync(h.windows[0][1], JSON.stringify({ contextKey: profileContext(context).key, ...selected }));
  const result = await h.run();
  assert.equal(result.ok, true);
  assert.equal(result.auth.path, 'vault');
  assert.equal(result.auth.user, principal);
  assert.equal(result.authenticated, false, 'saving a profile does not prove Service Center authentication');
  assert.equal(h.windows.length, 1);
});

test('explicit vault sign-in respects no-prompt and an incompatible explicit target', async t => {
  const h = setup(t);
  assert.equal((await h.run(['--auth-prompt', 'never'])).code, 'AUTH_REQUIRED');
  assert.equal((await h.run(['--credential-target', 'SSAM/O11/foreign.test/ServiceCenter'])).code, 'CREDENTIAL_PROFILE_MISMATCH');
  assert.equal(h.windows.length, 0);
});

test('a signed-out Studio does not supply an unverified principal to the private form', async t => {
  const h = setup(t, false);
  assert.equal((await h.run()).code, 'CREDENTIAL_SELECTION_PENDING');
  assert.equal(h.windows[0][0].principal, '');
});

test('private form cancellation is preserved and never becomes Studio sign-in success', async t => {
  const h = setup(t);
  await h.run();
  fs.writeFileSync(h.windows[0][1], JSON.stringify({ contextKey: profileContext(context).key, cancelled: true, at: Date.now() }));
  assert.equal((await h.run()).code, 'CREDENTIAL_SELECTION_CANCELLED');
  assert.equal(h.windows.length, 1);
});
