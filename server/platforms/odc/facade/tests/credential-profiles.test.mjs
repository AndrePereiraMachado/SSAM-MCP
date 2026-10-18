import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CredentialProfiles, profileContext } from '../credential-profiles.mjs';
const context = { lane: 'o11', host: 'example.test', principal: 'developer@example.test' };
const base = profileContext(context).base;
const one = { target: base, principal: context.principal };
const two = { target: base + '/Profiles/' + 'a'.repeat(64) + '/11111111-2222-3333-4444-555555555555', principal: context.principal };
function harness(t, entries) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-profiles-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  let opened = 0;
  const broker = new CredentialProfiles({ state, list: async () => entries,
    open: async (_c, _file, pending) => { opened++; fs.writeFileSync(pending, ''); } });
  return { broker, state, opened: () => opened };
}
test('explicit headless selection binds the offered profile without requiring a Studio principal or opening UI',async t=>{
 const entries=[one,two],h=harness(t,entries),scope={...context,principal:null};
 const authorize=`Use ${one.principal} on ${context.host}`;
 assert.equal((await h.broker.resolve(scope,{interactive:false})).code,'CREDENTIAL_SELECTION_REQUIRED');
 assert.equal((await h.broker.select(scope,{...one,authorize:'Use saved profile'})).code,'CREDENTIAL_SELECTION_AUTHORIZATION_REQUIRED');
 assert.equal((await h.broker.select(scope,{...one,target:base+'/foreign',authorize})).code,'CREDENTIAL_PROFILE_MISMATCH');
 const selected=await h.broker.select(scope,{...one,authorize});assert.equal(selected.ok,true);assert.equal(selected.windowCreated,false);
 assert.equal((await h.broker.resolve(scope,{interactive:false})).target,one.target);assert.equal(h.opened(),0);
 assert.equal((await h.broker.select({...context,principal:'someone-else@example.test'},{...one,authorize})).code,'CREDENTIAL_PROFILE_MISMATCH');
 entries.splice(0,1);assert.equal((await h.broker.resolve(scope,{interactive:false})).code,'CREDENTIAL_SELECTION_REQUIRED');
});

test('per-call explicit vault target disambiguates only compatible metadata without persisting selection',async t=>{
 const h=harness(t,[one,two]);
 assert.equal((await h.broker.resolve(context,{interactive:false,target:two.target})).source,'explicit-target');
 assert.equal(h.opened(),0);assert.deepEqual(fs.readdirSync(h.state),[]);
 for(const target of ['SSAM/O11/foreign.test/ServiceCenter',base+'/unknown'])assert.equal((await h.broker.resolve(context,{interactive:false,target})).code,'CREDENTIAL_PROFILE_MISMATCH');
 assert.equal((await h.broker.resolve({...context,principal:'other@example.test'},{interactive:false,target:two.target})).code,'CREDENTIAL_PROFILE_MISMATCH');
});

test('one compatible credential is automatic; another principal or host is not', async t => {
  const h = harness(t, [one, { ...two, principal: 'other@example.test' }, { ...two, target: two.target.replace('example.test', 'other.test') }]);
  assert.equal((await h.broker.resolve(context)).target, base);
  assert.equal(h.opened(), 0);
});
test('multiple compatible profiles open one cancellable selector, without waiting for a password', async t => {
  const h = harness(t, [one, two]);
  assert.equal((await h.broker.resolve(context)).code, 'CREDENTIAL_SELECTION_PENDING');
  assert.equal((await h.broker.resolve(context)).code, 'CREDENTIAL_SELECTION_PENDING');
  assert.equal(h.opened(), 1);
  const c = profileContext(context);
  fs.writeFileSync(path.join(h.state, c.key + '.json'), JSON.stringify({ contextKey: c.key, cancelled: true, at: Date.now() }));
  assert.equal((await h.broker.resolve(context)).code, 'CREDENTIAL_SELECTION_CANCELLED');
  assert.equal(h.opened(), 1);
});
test('a private selection persists only within the exact principal and host, and is revalidated', async t => {
  const entries = [one, two]; const h = harness(t, entries); const c = profileContext(context);
  fs.writeFileSync(path.join(h.state, c.key + '.json'), JSON.stringify({ contextKey: c.key, ...two }));
  assert.equal((await h.broker.resolve(context)).target, two.target);
  assert.equal((await h.broker.resolve({ ...context, principal: 'different@example.test' }, { interactive: false })).code, 'AUTH_REQUIRED');
  entries.splice(1, 1);
  assert.equal((await h.broker.resolve(context, { interactive: false })).code, 'CREDENTIAL_SELECTION_REQUIRED');
  assert.equal((await h.broker.resolve(context)).code, 'CREDENTIAL_SELECTION_PENDING');
  assert.equal(h.opened(), 1);
});
test('unproven principal never auto-selects a single global credential', async t => {
  const h = harness(t, [one]);
  assert.equal((await h.broker.resolve({ ...context, principal: null }, { interactive: false })).code, 'CREDENTIAL_SELECTION_REQUIRED');
  assert.equal(h.opened(), 0);
});
test('a rejected unique profile must be selected again, and cancellation is respected', async t => {
  const h = harness(t, [one]);
  assert.equal((await h.broker.resolve(context)).ok, true);
  await h.broker.resolve(context, { force: true });
  assert.equal((await h.broker.resolve(context)).code, 'CREDENTIAL_SELECTION_PENDING');
  assert.equal(h.opened(), 1);
});

test('metadata or dialog failure is explicit and never selects a fallback credential', async t => {
  const h = harness(t, []);
  h.broker.list = async () => { throw new Error('synthetic private detail'); };
  const unavailable = await h.broker.resolve(context);
  assert.equal(unavailable.code, 'CREDENTIAL_METADATA_UNAVAILABLE'); assert.equal(h.opened(), 0);
  assert.equal(JSON.stringify(unavailable).includes('synthetic private detail'), false);
  h.broker.list = async () => [];
  h.broker.open = async () => { throw new Error('synthetic private detail'); };
  assert.equal((await h.broker.resolve(context)).code, 'CREDENTIAL_DIALOG_UNAVAILABLE');
});

test('native dialog reconciles dead or legacy markers and does not duplicate a live process', async t => {
  const h = harness(t, []), c = profileContext(context);
  h.broker.nativeDialog = true;
  const pending = path.join(h.state, c.key + '.pending');
  fs.writeFileSync(pending, '');
  await h.broker.resolve(context);
  assert.equal(h.opened(), 1);
  fs.writeFileSync(pending, JSON.stringify({state: 'visible', pid: process.pid}));
  await h.broker.resolve(context);
  assert.equal(h.opened(), 1);
  fs.writeFileSync(pending, JSON.stringify({state: 'starting', pid: 2147483647}));
  await h.broker.resolve(context);
  assert.equal(h.opened(), 2);
});

test('the entry typed in the private window is remembered for its context and reused headless; removing it from the vault forgets it', async t => {
  const entries = [], h = harness(t, entries), scope = { ...context, principal: null };
  assert.equal((await h.broker.resolve(scope, { interactive: false })).code, 'AUTH_REQUIRED');
  // windows-o11-credential.ps1 -Mode bootstrap stored SSAM/O11/<host>/ServiceCenter with the typed user name.
  entries.push(one);
  assert.equal((await h.broker.resolve(scope, { interactive: false })).code, 'CREDENTIAL_SELECTION_REQUIRED', 'an unproven principal is never chosen silently');
  assert.equal((await h.broker.remember(scope, { target: base + '/unknown', principal: one.principal })).code, 'CREDENTIAL_PROFILE_MISMATCH');
  const kept = await h.broker.remember(scope, one);
  assert.deepEqual([kept.ok, kept.target, kept.source], [true, one.target, 'private-window']);
  const reused = await h.broker.resolve(scope, { interactive: false });
  assert.deepEqual([reused.ok, reused.target, reused.principal, reused.source], [true, one.target, one.principal, 'selected']);
  assert.equal(h.opened(), 0);
  // The selection file names only target, principal and context; no secret.
  const saved = fs.readdirSync(h.state).map(n => fs.readFileSync(path.join(h.state, n), 'utf8')).join('\n');
  assert.doesNotMatch(saved, /password|secret/i);
  entries.splice(0, 1);
  assert.equal((await h.broker.resolve(scope, { interactive: false })).code, 'AUTH_REQUIRED', 'a revoked entry is not offered, so its choice is ignored');
});
