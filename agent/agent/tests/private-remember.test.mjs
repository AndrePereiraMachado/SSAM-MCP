import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capturePrivatePrompt } from '../lib/private-runtime.mjs';
import { createCredentialSession } from '../lib/credential-session.mjs';
import { createUsersKind } from '../lib/users.mjs';
const host='tenant.example.test', profile='0'.repeat(64), privateCredential={username:'person',password:'private-test-value'};
const saved={ok:true,saved:true,remembered:false,profile,principal:'person',privateCredential};
function child(){ const c=new EventEmitter(); c.stdout=new PassThrough(); c.exitCode=null;c.unref=()=>{};c.finish=value=>{c.stdout.end(JSON.stringify(value));c.exitCode=0;setImmediate(()=>c.emit('close',0));};return c; }
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('private prompt waits for EOF and close and refuses invalid UTF8 or oversized output',async()=>{
 for(const bytes of [Buffer.from('{bad'),Buffer.alloc(32769,65),Buffer.from([0xff])]){const c=child(),r=capturePrivatePrompt(c);c.stdout.end(bytes);await tick();assert.equal(r.done,false);c.emit('close',0);assert.equal(r.failed,true);}
 const c=child(),r=capturePrivatePrompt(c);c.stdout.end(JSON.stringify(saved));await tick();assert.equal(r.done,false);c.emit('close',0);assert.equal(r.value.privateCredential.password,privateCredential.password);
});
for(const family of ['credential','users']) test(family+' temporary credentials stay in RAM, survive 401, and disappear on sign-out',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'remember-'));let opened;const calls=[];
 const config={dataRoot:root,platform:'win32',lookup:async()=>[{address:'93.184.216.34'}],start:(file,args)=>{opened=child();fs.writeFileSync(args[args.indexOf('-PromptStatusPath')+1],'visible');return opened;},exec:async(file,args,input)=>{const mode=args[args.indexOf('-Mode')+1];const p=input?JSON.parse(family==='users'?Buffer.from(input,'base64').toString():input):{};calls.push({mode,p});return JSON.stringify({ok:true,hosts:[],available:!!p.privateCredential,principal:p.privateCredential?.username,profile,authenticated:true,status:401,body:Buffer.from('<html>test</html>').toString('base64'),contentType:'text/html'});}};
 const agent=family==='credential'?createCredentialSession(config):createUsersKind(config);const base=family==='credential'?{host,service:'service-center',auth:'credential'}:{host};
 await agent.execute({...base,op:'prompt'});opened.finish(family==='users'?{...saved,profile:undefined}:saved);await tick();await tick();
 const status=await agent.execute({...base,op:'status'});assert.equal(status.available,true);assert.equal(status.remembered,false);
 await agent.execute({...base,op:'login'});assert.deepEqual(calls.at(-1).p.privateCredential,privateCredential);
 await agent.execute({...base,op:'request',url:'https://'+host+(family==='users'?'/Users/User_List.aspx':'/ServiceCenter/Errors_List.aspx'),...(family==='credential'?{method:'GET'}:{})});
 await agent.execute({...base,op:'status'});assert.deepEqual(calls.at(-1).p.privateCredential,privateCredential);
 await agent.execute({...base,op:'sign-out'});await agent.execute({...base,op:'status'});assert.equal(calls.at(-1).p.privateCredential,undefined);
 assert.equal(JSON.stringify(fs.readdirSync(root,{recursive:true}).filter(x=>fs.statSync(path.join(root,x)).isFile()).map(x=>fs.readFileSync(path.join(root,x),'utf8'))).includes(privateCredential.password),false);
});

for (const family of ['credential','users']) test(family+' cancelling replacement preserves RAM and late prompt after sign-out cannot restore it',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'remember-race-'));let opened;const calls=[];
 const config={dataRoot:root,platform:'win32',lookup:async()=>[{address:'93.184.216.34'}],start:(file,args)=>{opened=child();fs.writeFileSync(args[args.indexOf('-PromptStatusPath')+1],'visible');return opened;},exec:async(file,args,input)=>{const p=input?JSON.parse(family==='users'?Buffer.from(input,'base64').toString():input):{};calls.push(p);return JSON.stringify({ok:true,hosts:[],available:!!p.privateCredential,principal:p.privateCredential?.username,profile});}};
 const agent=family==='credential'?createCredentialSession(config):createUsersKind(config),base=family==='credential'?{host,service:'service-center',auth:'credential'}:{host};
 await agent.execute({...base,op:'prompt'});opened.finish(saved);await tick();await tick();
 await agent.execute({...base,op:'prompt'});opened.finish({ok:true,saved:false,remembered:false});await tick();await tick();
 assert.equal((await agent.execute({...base,op:'status'})).available,true);
 await agent.execute({...base,op:'prompt'});await agent.execute({...base,op:'sign-out'});opened.finish(saved);await tick();await tick();
 assert.equal((await agent.execute({...base,op:'status'})).available,false);
 const restarted=family==='credential'?createCredentialSession(config):createUsersKind(config);assert.equal((await restarted.execute({...base,op:'status'})).available,false);
});
test('credential explicit profile and Basic aliases use the same RAM account; other account remains isolated',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'remember-alias-'));let opened;const calls=[];
 const config={dataRoot:root,platform:'win32',lookup:async()=>[{address:'93.184.216.34'}],start:(file,args)=>{opened=child();fs.writeFileSync(args[args.indexOf('-PromptStatusPath')+1],'visible');return opened;},exec:async(file,args,input)=>{const p=JSON.parse(input);calls.push(p);return JSON.stringify({ok:true,available:!!p.privateCredential,profile});}};
 const agent=createCredentialSession({...config,account:'A'}),base={host,service:'service-center',auth:'credential'};
 await agent.execute({...base,op:'prompt'});opened.finish(saved);await tick();await tick();
 for(const extra of [{profile},{auth:'basic'},{auth:'basic',profile}]){assert.equal((await agent.execute({...base,...extra,op:'status'})).available,true);assert.deepEqual(calls.at(-1).privateCredential,privateCredential);}
 assert.equal((await createCredentialSession({...config,account:'B'}).execute({...base,op:'status'})).available,false);
});

test('credential saving during a request refuses its stale result; checked completion contains no RAM password',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'remember-flight-'));let opened, release;
 const base={host,service:'service-center',auth:'credential'},calls=[];
 const agent=createCredentialSession({dataRoot:root,platform:'win32',lookup:async()=>[{address:'93.184.216.34'}],start:(file,args)=>{opened=child();fs.writeFileSync(args[args.indexOf('-PromptStatusPath')+1],'visible');return opened;},exec:async(file,args,input)=>{const p=JSON.parse(input);calls.push(p);if(p.op==='request')return new Promise(resolve=>{release=()=>resolve(JSON.stringify({ok:true,status:200,contentType:'text/html',body:Buffer.from('stale').toString('base64')}));});return JSON.stringify({ok:true,available:true,profile,principal:'stored'});}});
 await agent.execute({...base,op:'prompt'});
 const pending=agent.execute({...base,op:'request',url:'https://'+host+'/ServiceCenter/Errors_List.aspx',method:'GET'});await tick();
 opened.finish(saved);await tick();await tick();release();await assert.rejects(pending,e=>e.code==='CREDENTIAL_SESSION_CHANGED');
 await agent.execute({...base,op:'prompt'});opened.finish({ok:true,saved:true,remembered:true,profile,principal:'stored'});await tick();await tick();
 assert.equal((await agent.execute({...base,op:'status'})).remembered,true);assert.equal(calls.at(-1).privateCredential,undefined);
});

test('a late Users window remains in the shared budget and can complete privately',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'remember-late-'));let opened;
 const agent=createUsersKind({dataRoot:root,platform:'win32',wait:async()=>{},lookup:async()=>[{address:'93.184.216.34'}],start:()=>opened=child(),exec:async()=>JSON.stringify({ok:true,hosts:[],available:true})});
 await assert.rejects(agent.execute({host,op:'prompt'}),e=>e.code==='USERS_PROMPT_NOT_VISIBLE');
 assert.equal((await agent.execute({host,op:'prompt'})).alreadyOpen,true);
 opened.finish(saved);await tick();await tick();assert.equal((await agent.execute({host,op:'status'})).remembered,false);
});

for (const guard of ['generation','secret']) test('Users POST '+guard+' guard reports uncertain execution after helper applied the write',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'remember-post-'));let opened,posts=0;
 const form='<html><form method="post" action="User_List.aspx"><input type="hidden" name="__OSVSTATE" value="s"><input id="x_wtSearchInput" name="s"><input type="submit" name="b" value="Search"></form></html>';
 const agent=createUsersKind({dataRoot:root,platform:'win32',lookup:async()=>[{address:'93.184.216.34'}],start:(file,args)=>{opened=child();fs.writeFileSync(args[args.indexOf('-PromptStatusPath')+1],'visible');return opened;},exec:async(file,args,input)=>{
 const mode=args[args.indexOf('-Mode')+1],p=input?JSON.parse(Buffer.from(input,'base64').toString()):{};
 if(mode!=='request')return JSON.stringify({ok:true,hosts:[],available:true});
 if(p.method==='POST'){posts++;if(guard==='generation'){opened.finish({...saved,privateCredential:{username:'person',password:'replacement-test-value'}});await tick();await tick();}}
 return JSON.stringify({ok:true,status:200,contentType:Buffer.from('text/html').toString('base64'),body:Buffer.from(p.method==='POST'&&guard==='secret'?privateCredential.password:form).toString('base64')});
 }});
 await agent.execute({host,op:'prompt'});opened.finish(saved);await tick();await tick();
 if(guard==='generation')await agent.execute({host,op:'prompt'});
 await assert.rejects(agent.execute({host,op:'search',text:'ana'}),e=>e.code===(guard==='generation'?'USERS_SESSION_CHANGED':'USERS_PRIVATE_RESPONSE_REFUSED')&&e.executed===null&&!e.message.includes('nothing was sent'));
 assert.equal(posts,1);
});
