import test from 'node:test';
import assert from 'node:assert/strict';
import { identityScript, vaultIdentityLogin } from '../service-center/identity-vault.mjs';
import { createPowerShellRunner } from '../service-center/vault.mjs';

const host = 'lab.example';
const target = `SSAM/O11/${host}/ServiceCenter`;
const principal = 'tester@example.test';
const options = { host, principal };
const config = `$config = @{ authConfigurations = @(@{ type='cognito'; kc_hint='os-builtin'; configs=@{ region='us-east-1'; authFlow='USER_PASSWORD_AUTH'; poolId='us-east-1_TestPool'; amplifyClientId='fictionalclient123' } }) }`;
const credential = { setup: '', read: `$found=$true; $size=32; $user='tester@example.test'; $secret='fictional-password-only'` };
const tokens = { AccessToken: 'fictional-access-token', IdToken: 'fictional-id-token', RefreshToken: 'fictional-refresh-token' };
const send = `$identity = @{ AuthenticationResult=@{ AccessToken='${tokens.AccessToken}'; IdToken='${tokens.IdToken}'; RefreshToken='${tokens.RefreshToken}'; NewDeviceMetadata=@{ DeviceKey='do-not-enroll' } } }`;
const run = createPowerShellRunner({ timeoutMs: 10000 });
const native = { skip: process.platform !== 'win32' };
function assertFailure(answer, code, stage) {
  assert.equal(answer.ok, false);
  assert.equal(answer.code, code);
  assert.equal(answer.stage, stage);
  assert.ok(Number.isSafeInteger(answer.elapsedMs) && answer.elapsedMs >= 0);
  assert.deepEqual(Object.keys(answer).sort(), ['code','elapsedMs','ok','stage']);
}

test('identity helper refuses cross-host profiles and absent principal before invoking a process', async () => {
  for (const [t, o] of [[target, {host:'other.example',principal}], [target, {host,principal:''}], [`SSAM/O11/${host}/DatabaseConnection/x`, options]]) {
    await assert.rejects(vaultIdentityLogin(t, o, {run:()=>{throw Error('must not run');}}), /same-host/);
  }
});
test('the same private identity helper accepts only same-host ODC Portal entries, never API Client or settings',async()=>{
 const base=`SSAM/ODC3/${host}/Portal`;
 for(const entry of [base,base+'/Profiles/'+'a'.repeat(64)+'/11111111-2222-3333-4444-555555555555']){
  assert.deepEqual(await vaultIdentityLogin(entry,options,{run:async(_script,input)=>{assert.equal(input.target,entry);assert.equal(input.principal,principal);return {ok:true,tokens};}}),tokens);
 }
 for(const entry of [base.replace(host,'other.example'),`SSAM/ODC3/${host}/APIClient`,`SSAM/ODC3/${host}/Setting/A`])
  await assert.rejects(vaultIdentityLogin(entry,options,{run:()=>assert.fail('must not read')}),/same-host/);
});

test('private protocol strips unexpected token response fields and does not expose transport errors', async () => {
  assert.deepEqual(await vaultIdentityLogin(target, options, {run:async()=>({ok:true,tokens:{...tokens,password:'do-not-return'}})}),tokens);
  await assert.rejects(vaultIdentityLogin(target, options, {run:async()=>{throw Error('raw secret response');}}), e=>e.code==='IDENTITY_LOGIN_UNCERTAIN'&&!e.message.includes('raw secret'));
  await assert.rejects(vaultIdentityLogin(target, options, {run:async()=>({ok:false,code:'raw-secret-code'})}), e=>e.code==='IDENTITY_RESPONSE_INVALID');
});

test('PowerShell identity flow returns only the token session, without device enrollment or password', native, async () => {
  const script = identityScript({config,credential,send});
  const answer = await run(script,{target,principal});
  assert.deepEqual(answer,{ok:true,tokens});
  assert.doesNotMatch(JSON.stringify(answer),/fictional-password|DeviceKey/);
});

test('provider drift and ambiguous providers refuse before reading any credential', native, async () => {
  for(const setup of [config.replace('USER_PASSWORD_AUTH','USER_SRP_AUTH'), config+'; $config.authConfigurations += $config.authConfigurations[0]']) {
    const answer = await run(identityScript({config:setup,credential:{setup:'',read:'throw "must not read"'},send:'throw "must not send"'}),{target,principal});
    assertFailure(answer,'IDENTITY_PROVIDER_UNSUPPORTED','provider');
  }
});

test('principal mismatch refuses before sending a password to the provider', native, async () => {
  const answer = await run(identityScript({config,credential,send:'throw "must not send"'}),{target,principal:'other@example.test'});
  assertFailure(answer,'AUTH_PRINCIPAL_MISMATCH','principal');
});

test('provider client must still match broker discovery before a credential read', native, async () => {
  const answer=await run(identityScript({config,credential:{setup:'',read:'throw "must not read"'},send:'throw "must not send"'}),{target,principal,expectedClientId:'changed-client'});
  assertFailure(answer,'IDENTITY_PROVIDER_UNSUPPORTED','provider');
});

test('challenge and malformed token results never count as successful authentication', native, async () => {
  for(const [payload,code] of [[`$identity=@{ChallengeName='SMS_MFA';AuthenticationResult=@{}}`,'IDENTITY_CHALLENGE_REQUIRED'],[`$identity=@{AuthenticationResult=@{AccessToken='partial'}}`,'IDENTITY_RESPONSE_INVALID']]) {
    const answer=await run(identityScript({config,credential,send:payload}),{target,principal});
    assertFailure(answer,code,code==='IDENTITY_CHALLENGE_REQUIRED'?'challenge':'response');
  }
});

test('a native request failure with credential text returns only a fixed code', native, async () => {
  const answer = await run(identityScript({config,credential,send:'throw "fictional-password-only raw response"'}),{target,principal});
  assertFailure(answer,'IDENTITY_LOGIN_UNCERTAIN','authentication');
});

test('native timeout and network failures are distinguished from a rejected login without exposing text', native, async () => {
  for (const [status,code] of [['Timeout','IDENTITY_TIMEOUT'],['ConnectFailure','IDENTITY_PROVIDER_UNAVAILABLE']]) {
    const fail=`throw [Net.WebException]::new('fictional-password-only',[Net.WebExceptionStatus]::${status})`;
    for (const where of ['provider','authentication']) {
      const script=identityScript({config:where==='provider'?fail:config,credential,send:fail});
      assertFailure(await run(script,{target,principal}),code,where);
    }
    await assert.rejects(vaultIdentityLogin(target,options,{run:async()=>({ok:false,code})}),e=>e.code===code&&!e.message.includes('fictional-password'));
  }
});

test('diagnostics expose only a whitelisted stage and bounded elapsed number', async () => {
  await assert.rejects(vaultIdentityLogin(target,options,{run:async()=>({ok:false,code:'IDENTITY_TIMEOUT',stage:'authentication',elapsedMs:15002})}),e=>e.auth.identityStage==='authentication'&&e.auth.elapsedMs===15002);
  await assert.rejects(vaultIdentityLogin(target,options,{run:async()=>({ok:false,code:'IDENTITY_TIMEOUT',stage:'secret-value',elapsedMs:'secret-value'})}),e=>JSON.stringify(e.auth)==='{}');
});
