import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLocalCredentialRuntime, parsePrivatePromptCompletion, capturePrivatePrompt } from '../users/private-runtime.mjs';
import { defaultSession } from '../o11-users.mjs';

const host='tenant.example.com', secret='local-secret-sentinel';
const completion=()=>parsePrivatePromptCompletion(JSON.stringify({ok:true,saved:true,remembered:false,principal:'temporary',privateCredential:{username:'temporary',password:secret}}));

test('local unchecked Remember me reaches status/login and overrides an existing saved credential',async()=>{
  const sessions=new Map(); const runtime=createLocalCredentialRuntime({invalidate:()=>sessions.clear()});
  const calls=[];
  const call=(mode,h,extra,input)=>runtime.call(mode,h,extra,input,async(mode,h,extra,input)=>{
    calls.push(mode); assert.equal(input.privateCredential.password,secret);
    return mode==='status'?{ok:true,available:true,principal:input.privateCredential.username}:{ok:true,authenticated:true};
  });
  runtime.accept(host,completion(),runtime.generation(host));
  const session=await defaultSession(host,{call,sessions,makeClient:()=>({}),openPrompt:()=>assert.fail('No second window')});
  assert.equal(session.principal,'temporary'); assert.deepEqual(calls,['status','login']);
  sessions.clear(); // Session expiry must keep the chosen temporary credential.
  await defaultSession(host,{call,sessions,makeClient:()=>({})});
  assert.deepEqual(calls,['status','login','status','login']);
});

test('local cancellation preserves temporary choice; sign-out passes it privately then rejects late completion',async()=>{
  const runtime=createLocalCredentialRuntime(); runtime.accept(host,completion(),0);
  const generation=runtime.generation(host);
  runtime.accept(host,parsePrivatePromptCompletion('{"ok":true,"saved":false,"remembered":false}'),generation);
  await runtime.call('status',host,{},null,async(m,h,e,p)=>{assert.equal(p.privateCredential.username,'temporary');return {};});
  await runtime.call('sign-out',host,{},null,async(m,h,e,p)=>{assert.equal(p.privateCredential.password,secret);return {};});
  assert.equal(runtime.accept(host,completion(),generation),false);
  await runtime.call('status',host,{},null,async(m,h,e,p)=>{assert.equal(p,null);return {};});
});

test('local private completion needs both stdout EOF and successful process close',()=>{
  const child=new EventEmitter(); child.stdout=new EventEmitter(); const capture=capturePrivatePrompt(child);
  child.stdout.emit('data',Buffer.from(JSON.stringify({ok:true,saved:true,remembered:false,privateCredential:{username:'u',password:secret}})));
  child.emit('exit',0); assert.equal(capture.done,false);
  child.stdout.emit('end'); assert.equal(capture.done,false);
  child.emit('close',0); assert.equal(capture.done,true); assert.equal(capture.failed,false);
});

test('local private completion rejects oversized payload and invalid secret shape',()=>{
  const child=new EventEmitter(); child.stdout=new EventEmitter(); const capture=capturePrivatePrompt(child);
  child.stdout.emit('data',Buffer.alloc(32769,65));child.stdout.emit('end');child.emit('close',0);
  assert.equal(capture.failed,true);assert.equal(capture.value,null);
  assert.throws(()=>parsePrivatePromptCompletion('{"ok":true,"saved":false,"remembered":false,"privateCredential":{}}'));
});

test('local private page echoes are redacted with a normalization signal',async()=>{
  let noted=false; const runtime=createLocalCredentialRuntime({normalized:()=>noted=true});runtime.accept(host,completion(),0);
  const page=await runtime.call('request',host,{},null,async()=>({body:Buffer.from(secret).toString('base64')}));
  assert.equal(Buffer.from(page.body,'base64').toString(),'[redacted]');assert.equal(noted,true);
});

test('local in-flight result cannot restore a signed-out session',async()=>{
  const runtime=createLocalCredentialRuntime();runtime.accept(host,completion(),0);
  let finish;const pending=runtime.call('login',host,{},null,()=>new Promise(r=>finish=r));
  await runtime.call('sign-out',host,{},null,async()=>({}));finish({authenticated:true});
  await assert.rejects(pending,{code:'CREDENTIAL_SESSION_CHANGED'});
});
