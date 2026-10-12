import test from 'node:test';
import assert from 'node:assert/strict';
import { hiddenSignIn, reenterWindow, Resolver } from '../service-center/auth.mjs';
import { BridgeError } from '../service-center/errors.mjs';
const context = { lane: 'o11', host: 'example.test', principal: 'developer@example.test' };
const two = { target: 'SSAM/O11/example.test/ServiceCenter/Profiles/' + 'a'.repeat(64) + '/11111111-2222-3333-4444-555555555555', principal: context.principal };

for (const session of ['auto', 'vault']) {
  test(`${session} page authentication reuses the Studio-bound profile without opening a web window`, async () => {
    const bridge = { supports: async () => true, capabilities: async () => new Set(),
      session: async host => { assert.equal(host, context.host); return { studio: { signedIn: true, user: context.principal }, web: { signedIn: true } }; },
      web: async () => assert.fail('no browser window is allowed'), login: async () => assert.fail('no Studio login dialog is allowed') };
    const resolver = new Resolver(context.host, { session, prompt: 'never', locate: async () => bridge,
      opener: async () => assert.fail('saved profile must not prompt'), profiles: { resolve: async (scope, options) => {
        assert.deepEqual(scope, context); assert.equal(options.interactive, false);
        return { ok: true, ...two, source: 'selected' };
      } } });
    const auth = await resolver.resolve('web');
    assert.equal(auth.path, 'vault'); assert.equal(auth.bridge, bridge); assert.equal(auth.credentialTarget, two.target);
    assert.equal(auth.attempts.at(-1).source, 'selected');
  });
}

test('an unsigned Studio cannot supply the principal of a saved credential', async () => {
  const resolver = new Resolver(context.host, { session: 'vault', prompt: 'never', locate: async () => ({
    supports: async () => true, session: async () => ({ studio: { signedIn: false, user: context.principal } })
  }), profiles: { resolve: async (scope, options) => {
    assert.equal(scope.principal, null); assert.equal(options.interactive, false);
    return { ok: false, code: 'CREDENTIAL_SELECTION_REQUIRED' };
  } } });
  await assert.rejects(resolver.resolve('web'), error => error.code === 'CREDENTIAL_SELECTION_REQUIRED');
});
for (const session of ['auto', 'studio', 'studio-web']) {
  test(`${session} prefers native headless authentication without selecting a credential`, async () => {
    const bridge = { supports: async () => true, capabilities: async () => new Set(['sc_http:studioSession']),
      session: async () => ({ studio: { signedIn: true, user: context.principal } }),
      web: async (_host, action) => { assert.equal(action,'status'); return {signedIn:true}; } };
    const r = new Resolver(context.host, { session, locate: async () => bridge,
      profiles: { resolve: async () => assert.fail('native session takes priority') } });
    assert.equal((await r.resolve('web')).path, 'studio-http');
  });
}

test('explicit Studio selection cannot silently become a vault login', async () => {
  const r = new Resolver(context.host, { session: 'studio', locate: async () => ({ supports: async () => true,
    capabilities: async () => new Set(), session: async () => ({ studio: { signedIn: true, user: context.principal } }) }),
    profiles: { resolve: async () => assert.fail('explicit identity source must be preserved') } });
  await assert.rejects(r.resolve('web'), error => error.code === 'HEADLESS_AUTH_UNAVAILABLE');
});

test('auto probes native HTTP before selecting a compatible profile; explicit Studio never falls back', async () => {
  for(const session of ['auto','studio']) {
    let probes=0,selections=0;
    const r=new Resolver(context.host,{session,locate:async()=>({supports:async()=>true,
      capabilities:async()=>new Set(['sc_http:studioSession']),session:async()=>({studio:{signedIn:true,user:context.principal}}),
      web:async(_host,action)=>{assert.equal(action,'status');probes++;return{signedIn:false};}}),
      profiles:{resolve:async(scope,options)=>{selections++;assert.deepEqual(scope,context);assert.equal(options.interactive,false);return{ok:true,...two};}}});
    assert.equal((await r.resolve('web')).path,session==='auto'?'vault':'studio-http');
    assert.equal(probes,session==='auto'?1:0);assert.equal(selections,session==='auto'?1:0);
  }
});

test('auto does not treat an unprobed native session as authenticated', async () => {
  for (const status of [{signedIn:null,status:'not-probed'},{}]) {
    const r=new Resolver(context.host,{session:'auto',locate:async()=>({supports:async()=>true,
      capabilities:async()=>new Set(['sc_http:studioSession']),session:async()=>({studio:{signedIn:true,user:context.principal}}),
      web:async(_host,action)=>{assert.equal(action,'status');return status;}}),
      profiles:{resolve:async(scope,options)=>{assert.deepEqual(scope,context);assert.equal(options.interactive,false);return{ok:true,...two};}}});
    const auth=await r.resolve('web');assert.equal(auth.path,'vault');assert.equal(auth.attempts[0].outcome,'web-session-unverified');
  }
});

test('legacy sign-in helpers reject window-only bridges without calling them', async () => {
  const bridge = { capabilities: async () => new Set(['sc_web:login']),
    session: async () => ({ studio: { signedIn: true } }), web: async () => assert.fail('no window') };
  await assert.rejects(hiddenSignIn(bridge, context.host), error => error.code === 'HEADLESS_AUTH_UNAVAILABLE');
  await assert.rejects(reenterWindow(bridge, context.host), error => error.code === 'HEADLESS_AUTH_UNAVAILABLE');
});
