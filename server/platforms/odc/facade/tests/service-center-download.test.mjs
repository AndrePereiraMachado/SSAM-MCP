import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {CookieJar as ToughCookieJar} from 'tough-cookie';
import {runServiceCenter} from '../service-center/index.mjs';
import {serviceCenterArguments} from '../o11-operations.mjs';
import {DownloadContextStore} from '../service-center/download-context.mjs';
import {ownedSsoJar,solutionDownload} from '../service-center/solution-download.mjs';
import {StudioWebTransport} from '../service-center/http.mjs';
import {boundedRead} from '../read-budget.mjs';
import {validateSolutionPackage} from '../service-center/solution-package.mjs';
import {FakeBridge,SC,html,temp,uuid, zip } from './fixtures/sc-fake-bridge.mjs';

const host='sc.example.test',solution='SampleRelease';
const preparation=`<html><body onload="Bootstrap('123', '.aspx', 2, 'err', -1, -1, -1, -1, -1); return false;">
<form method="post" action="Solution_Download.aspx"><input type="hidden" name="__OSVSTATE" value="private-opaque-state">
<div class="sc-content-main"><div class="heading2">Download Running Version of Solution SampleRelease</div>
<div id="ButtonZoneDoneOK" style="display:none"><input type="submit" name="download" value="Download"></div>
<textarea name="err" id="err"></textarea></div></form></body></html>`;
const osp=zip({'Solution.xml':'<Solution/>'});

test('preparation resumes after expiration during creation or reservation without repeating form discovery',async()=>{
 for(const pauseAt of ['create','reserve']){
  let record=null,posts=0,discoveries=0,pause=true,release,entered;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  const delay=async where=>{if(pause&&pauseAt===where){pause=false;entered();await gate;}};
  const store={find:async()=>structuredClone(record),create:async(_id,_identity,context)=>{
   assert.equal(record,null);record={revision:0,context:structuredClone(context)};await delay('create');return structuredClone(record);
  },replace:async(_id,_identity,revision,context)=>{
   assert.equal(revision,record.revision);record={revision:revision+1,context:structuredClone(context)};
   if(context.phase==='reserved')await delay('reserve');return structuredClone(record);
  }};
  const http=new StudioWebTransport(host,{});http.fetch=async(_url,fields)=>{assert.deepEqual(fields,[['prepare','Download']]);posts++;return [null,'application/octet-stream',osp];};
  const dir=temp(),client={vault:{host},http,exports:dir,solutionDownloadRequest:async()=>{discoveries++;return {url:'Solution_Edit.aspx',fields:[['prepare','Download']],version:'current-running'};},
   save:(_name,_extension,body)=>{const file=dir+'/proof.osp';fs.writeFileSync(file,body);return {file,size:body.length};}};
  const operationId=uuid(),options={operationId,principal:'dev@example.test',store,create:true};let work;
  const key='prepare-budget-'+operationId;
  const timeout=boundedRead(key,()=>work=solutionDownload(client,solution,options).catch(error=>({error})),{timeoutMs:25});
  await started;assert.equal((await timeout).code,'READ_DEADLINE_EXCEEDED');release();assert.equal((await work).sent,false);
  assert.equal(record.context.phase,'preparation-ready');assert.equal(posts,0);
  assert.equal((await solutionDownload(client,solution,options)).complete,true);
  assert.equal(posts,1);assert.equal(discoveries,1);assert.equal(record.context.request,undefined);assert.equal(record.context.session,undefined);
  await boundedRead(key,()=>assert.fail('Observe old result without resending'));
 }
});

test('deadline during durable reservation preserves a resumable final form only before fetch',async()=>{
 for(const conflict of [false,true]){
  const id=uuid();let record={revision:1,context:{phase:'ready',version:'current-running',
   session:{kind:'native'},preparation:{url:'Solution_Download.aspx',fields:{download:'Download'}}}};
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const reserved=new Promise(resolve=>{entered=resolve;});
  let pause=true,posts=0;
  const store={find:async()=>structuredClone(record),replace:async(_id,_identity,revision,context)=>{
   assert.equal(revision,record.revision,'replacement must use current revision');
   record={revision:revision+1,context:structuredClone(context)};
   const result=structuredClone(record);
   if(context.phase==='downloading'&&pause){pause=false;entered();await gate;
    if(conflict)record={revision:record.revision+1,context:{...record.context,otherWriter:true}};
   }
   return result;
  }};
  const http=new StudioWebTransport(host,{});
  http.fetch=async(_url,fields)=>{if(fields){posts++;return [null,'application/octet-stream',osp];}
   return [null,'text/html',Buffer.from('<a href="Logout.aspx">Logout</a>')];};
  const dir=temp();
  const client={vault:{host},http,exports:dir,save:(_name,_extension,body)=>{
   const file=dir+'/proof.osp';fs.writeFileSync(file,body);return {file,size:body.length};}};
  let work;
  const key='reservation-'+id;
  const timeout=boundedRead(key,()=>work=solutionDownload(client,solution,{operationId:id,principal:'dev@example.test',store}),{timeoutMs:25});
  await reserved;
  assert.equal((await timeout).code,'READ_DEADLINE_EXCEEDED');release();
  if(conflict){await assert.rejects(work);assert.equal(record.context.phase,'downloading');assert.equal(record.context.otherWriter,true);}
  else{
   const stopped=await work;assert.equal(stopped.sent,false);assert.equal(stopped.state,'ready');
   assert.equal(stopped.continuation.arguments.operationId,id);assert.equal(posts,0);
   assert.equal((await solutionDownload(client,solution,{operationId:id,principal:'dev@example.test',store})).complete,true);
   assert.equal(posts,1);
  }
  await boundedRead(key,()=>assert.fail('Must observe existing work without another request'));
 }
});
function fixture({state='done',count=0,final=osp,first=preparation,id:preset=null}={}) {
 const bridge=new FakeBridge({pages:{
  [`GET ${SC}Solutions_List.aspx`]:html('solutions/solutions-list.html'),
  [`GET ${SC}Solution_Edit.aspx?SolutionId=11`]:html('solutions/solution-edit.html'),
  [`POST ${SC}Solution_Edit.aspx`]:first,
  [`GET ${SC}Home.aspx`]:'<a href="Logout.aspx">Logout</a>',
  [`POST ${SC}Solution_Download.aspx`]:(fields)=>{assert.equal(fields.__OSVSTATE,'private-opaque-state');return final;}
 }});
 const original=bridge.web.bind(bridge);let polls=0;
 bridge.web=(h,action,args={})=>{
  if(args.path?.startsWith(SC+'AjaxStepsGetInfo.aspx?')){
   polls++;assert.equal(args.method,'GET');
   const query=new URL(args.path,'https://'+h).searchParams;
   assert.equal(query.get('AsyncOperationId'),'123');
   return {ok:true,status:200,finalUrl:'https://'+h+args.path,contentType:'application/octet-stream',bodyBase64:Buffer.from(`<servermessage><state>${state}</state><errorcount>${count}</errorcount><lastmessageid>31</lastmessageid><messagelist/></servermessage>`).toString('base64')};
  }
  return original(h,action,args);
 };
 // The first call starts without an operationId; every later call resumes the UUID the tool answered.
 let id=preset;const exports=temp();
 const argsOf=()=>serviceCenterArguments({action:'solution-download',host,solution,...(id?{operationId:id}:{})},'read');
 const call=async(extra={},argv=argsOf())=>{
  const result=await runServiceCenter(argv,{locate:()=>bridge,present:async()=>false,running:async()=>true,exports,opener:()=>assert.fail('No UI'),...extra});
  id??=result.operationId??result.continuation?.arguments?.operationId??null;return result;
 };
 return {bridge,get id(){return id;},get args(){return argsOf();},call,polls:()=>polls,identity:{host,principal:'dev@example.test',solution},exports};
}

test('public download resumes preparation, polls once, then sends final form once and reuses a verified artifact',async()=>{
 const s=fixture();
 const a=await s.call();assert.equal(a.state,'prepared');assert.equal(a.complete,false);assert.equal(a.asyncOperationId,'123');
 assert.equal(a.continuation.arguments.operationId,s.id);assert.equal(s.bridge.posts().length,1);assert.equal(s.polls(),0);
 assert.ok(!JSON.stringify(a).includes('private-opaque-state'));
 const b=await s.call();assert.equal(b.state,'ready');assert.equal(b.complete,false);assert.equal(s.polls(),1);assert.equal(s.bridge.posts().length,1);
 const c=await s.call();assert.equal(c.complete,true);assert.deepEqual(fs.readFileSync(c.file),osp);assert.equal(s.bridge.posts().length,2);
 const d=await s.call();assert.equal(d.file,c.file);assert.equal(s.bridge.posts().length,2);assert.equal(s.polls(),1);
 const stored=await new DownloadContextStore().read(s.id,s.identity);
 assert.equal(stored.context.session,undefined);assert.equal(stored.context.preparation,undefined);
 fs.writeFileSync(c.file,'corrupt');
 const refused=await s.call();assert.equal(refused.code,'SC_DOWNLOAD_CONTEXT_UNAVAILABLE');assert.equal(s.bridge.posts().length,2);
});

test('failed or running preparation cannot submit the hidden final Download',async()=>{
 for(const scenario of [{state:'done',count:1,expected:'failed'},{state:'running',expected:'prepared'}]){
  const s=fixture(scenario);assert.equal((await s.call()).state,'prepared');
  assert.equal((await s.call()).state,scenario.expected);assert.equal(s.bridge.posts().length,1);
 }
});

test('lost preparation or final response leaves a durable no-replay state',async()=>{
 for(const phase of ['preparation','download','download-deadline']){
  const failure=Object.assign(new Error('lost response'),phase==='download-deadline'?{code:'READ_DEADLINE_EXCEEDED'}:{});
  const s=fixture(phase==='preparation'?{first:failure}:{final:failure});
  const first=await s.call();
  if(phase!=='preparation'){assert.equal(first.state,'prepared');assert.equal((await s.call()).state,'ready');assert.equal((await s.call()).status.stage,'final-download-request');}
  else assert.equal(first.status.stage,'preparation-request');
  const count=s.bridge.posts().length;
  const again=await s.call();assert.equal(again.code,'SC_DOWNLOAD_SEND_UNCERTAIN');assert.equal(again.continuation.arguments.action,'solution-download-status');assert.equal(s.bridge.posts().length,count);
 }
});

test('invalid final archive records safe response metadata and a distinct failure stage',async()=>{
 const s=fixture({final:Buffer.from('PK-not-an-archive')});
 await s.call();await s.call();
 const result=await s.call();assert.deepEqual(result.status,{stage:'archive-validation',cause:'archive-integrity'});
 const record=await new DownloadContextStore().read(s.id,s.identity);
 assert.equal(record.context.received.bytes,17);
 assert.match(record.context.received.sha256,/^[a-f0-9]{64}$/);
 assert.equal(record.context.phase,'downloading');
 assert.equal((await s.call()).code,'SC_DOWNLOAD_SEND_UNCERTAIN');assert.equal(s.bridge.posts().length,2);
});

test('private SSO snapshot keeps same-host cookies and excludes identity-provider cookies',()=>{
 const jar=new ToughCookieJar();
 jar.setCookieSync('sc=own-session; Secure; HttpOnly; Path=/ServiceCenter/','https://'+host+'/ServiceCenter/');
 jar.setCookieSync('id=identity-session; Secure; Path=/','https://id.outsystems.com/');
 const saved=ownedSsoJar(jar,host).downloadState();
 assert.equal(saved.jar.cookies.length,1);assert.equal(saved.jar.cookies[0].key,'sc');
 const restored=ownedSsoJar(ToughCookieJar.deserializeSync(saved.jar),host);
 assert.equal(restored.header('https://'+host+'/ServiceCenter/Home.aspx'),'sc=own-session');
 assert.equal(restored.header('https://id.outsystems.com/'),'');
});

test('an owned SSO download survives auth-resource closure and resumes without a second login',async()=>{
 const s=fixture(),jar=new ToughCookieJar();let logins=0,closes=0;
 const deps={exports:s.exports,locate:()=>s.bridge,running:async()=>true,
  profiles:{resolve:async()=>({ok:true,principal:'dev@example.test',target:'SSAM/O11/'+host+'/ServiceCenter'})},
  present:async()=>false,opener:()=>assert.fail('No UI'),
  createSso:()=>({jar,authenticateSc:async()=>{logins++;jar.setCookieSync('sc=private-session; Secure; Path=/ServiceCenter/','https://'+host+'/ServiceCenter/');},close:async()=>{closes++;jar.removeAllCookiesSync();}}),
  send:async request=>{
   const url=new URL(request.url);
   if(url.pathname===SC+'Login.aspx')return {status:200,contentType:'text/html',body:Buffer.from('<input type="submit" value="Log in with SSO">'),setCookie:[]};
   assert.equal(request.headers.Cookie,'sc=private-session');
   const reply=await s.bridge.web(host,'fetch',{method:request.method,path:url.pathname+url.search,form:request.body?Object.fromEntries(new URLSearchParams(request.body)):null,accept:'binary',write:false});
   return {status:reply.status,contentType:reply.contentType,body:reply.bodyBase64?Buffer.from(reply.bodyBase64,'base64'):Buffer.from(reply.html),setCookie:[]};
  }};
 const call=()=>s.call(deps,[...s.args,'--session','vault']);
 assert.equal((await call()).state,'prepared');assert.equal(closes,1);assert.equal(jar.getCookieStringSync('https://'+host+'/ServiceCenter/'),'');
 assert.equal((await call()).state,'ready');
 const downloaded=await call();assert.equal(downloaded.complete,true);assert.equal(downloaded.auth.path,'private-download-session');
 assert.equal(logins,1);assert.equal(s.bridge.posts().length,2);
});

test('a sign-in page at the session probe closes the download as expired, never posts the final form, and points to a new download',async()=>{
 const s=fixture();
 assert.equal((await s.call()).state,'prepared');assert.equal((await s.call()).state,'ready');assert.equal(s.bridge.posts().length,1);
 s.bridge.pages[`GET ${SC}Home.aspx`]='<html><body><div class="sc-layout-login"><form method="post" action="Login.aspx"><input type="submit" value="Log in with SSO"></form></div></body></html>';
 const expired=await s.call();
 assert.equal(expired.code,'SC_DOWNLOAD_SESSION_EXPIRED');assert.equal(expired.state,'expired');assert.equal(expired.sent,false);
 assert.deepEqual(expired.continuation.arguments,{action:'solution-download',host,solution});
 assert.equal(s.bridge.posts().length,1);
 const stored=await new DownloadContextStore().read(s.id,s.identity);
 assert.equal(stored.context.phase,'expired');assert.equal(stored.context.preparation,undefined);assert.equal(stored.context.session,undefined);
 const fetches=s.bridge.calls.filter(c=>c[0]==='web'&&c[1]==='fetch').length;
 const again=await s.call();assert.equal(again.code,'SC_DOWNLOAD_SESSION_EXPIRED');
 assert.equal(s.bridge.calls.filter(c=>c[0]==='web'&&c[1]==='fetch'&&c[2]?.path?.endsWith('Home.aspx')).length,
  s.bridge.calls.slice(0,fetches).filter(c=>c[0]==='web'&&c[1]==='fetch'&&c[2]?.path?.endsWith('Home.aspx')).length,'a closed record is not probed again');
 assert.equal(s.bridge.posts().length,1);
 const status=await runServiceCenter(serviceCenterArguments({action:'solution-download-status',host,solution,operationId:s.id},'read'),
  {locate:()=>s.bridge,present:async()=>false,running:async()=>true,exports:s.exports});
 assert.equal(status.state,'expired');assert.equal(status.reconciliationRequired,false);assert.equal(status.expired.sent,false);
});

test('an unexpected page at the session probe stays recoverable, never expired and never posted',async()=>{
 const s=fixture();
 await s.call();await s.call();
 s.bridge.pages[`GET ${SC}Home.aspx`]='<html><body>maintenance</body></html>';
 const refused=await s.call();assert.equal(refused.code,'SC_DOWNLOAD_CONTEXT_UNAVAILABLE');assert.equal(s.bridge.posts().length,1);
 assert.equal((await new DownloadContextStore().read(s.id,s.identity)).context.phase,'ready');
 s.bridge.pages[`GET ${SC}Home.aspx`]='<a href="Logout.aspx">Logout</a>';
 assert.equal((await s.call()).complete,true);assert.equal(s.bridge.posts().length,2);
});

test('an owned session answered by the sign-in page expires the download without the final POST',async()=>{
 const s=fixture(),jar=new ToughCookieJar();let expiredHome=false;
 const deps={exports:s.exports,locate:()=>s.bridge,running:async()=>true,
  profiles:{resolve:async()=>({ok:true,principal:'dev@example.test',target:'SSAM/O11/'+host+'/ServiceCenter'})},
  present:async()=>false,opener:()=>assert.fail('No UI'),
  createSso:()=>({jar,authenticateSc:async()=>{jar.setCookieSync('sc=private-session; Secure; Path=/ServiceCenter/','https://'+host+'/ServiceCenter/');},close:async()=>{jar.removeAllCookiesSync();}}),
  send:async request=>{
   const url=new URL(request.url);
   if(url.pathname===SC+'Login.aspx'||(expiredHome&&url.pathname===SC+'Home.aspx'))
    return {status:200,contentType:'text/html',body:Buffer.from('<div class="sc-layout-login"><form action="Login.aspx"><input type="submit" value="Log in with SSO"></form></div>'),setCookie:[]};
   const reply=await s.bridge.web(host,'fetch',{method:request.method,path:url.pathname+url.search,form:request.body?Object.fromEntries(new URLSearchParams(request.body)):null,accept:'binary',write:false});
   return {status:reply.status,contentType:reply.contentType,body:reply.bodyBase64?Buffer.from(reply.bodyBase64,'base64'):Buffer.from(reply.html),setCookie:[]};
  }};
 const call=()=>s.call(deps,[...s.args,'--session','vault']);
 assert.equal((await call()).state,'prepared');assert.equal((await call()).state,'ready');
 expiredHome=true;
 const expired=await call();assert.equal(expired.code,'SC_DOWNLOAD_SESSION_EXPIRED');assert.equal(expired.expired.observed,'SC_AUTH_EXPIRED');
 assert.equal(s.bridge.posts().length,1);
});

test('package integrity requires complete ZIP records and CRC, not only a PK prefix',()=>{
 assert.equal(validateSolutionPackage(osp).crc32Verified,true);
 const damaged=Buffer.from(osp);damaged[40]^=1;
 for(const body of [Buffer.from('PKfake'),osp.subarray(0,osp.length-1),damaged,zip({'../escape.oml':'no'})])
  assert.throws(()=>validateSolutionPackage(body),/intact supported ZIP/);
});

test('public download status inspects every pending phase without login, polling or POST and omits private state',async()=>{
 const store=new DownloadContextStore();
 for(const phase of ['preparation-ready','reserved','prepared','ready','downloading','failed']){
  const s=fixture(),id=uuid();
  await store.create(id,s.identity,{phase,cursor:31,preparation:{asyncOperationId:'123',fields:[['__OSVSTATE','private-state-sentinel']]},
   request:{url:'private-form-sentinel',fields:[['state','private-request-sentinel']]},session:{kind:'owned',cookies:'private-cookie-sentinel'},status:{state:'done',errorCount:0,messages:['private-message-sentinel']},lastFailure:{stage:'final-download-request',cause:'transport-failed'}});
  const args=serviceCenterArguments({action:'solution-download-status',host,solution,operationId:id},'read');
  const result=await runServiceCenter(args,{locate:()=>s.bridge,present:async()=>false,running:async()=>true,exports:s.exports,opener:()=>assert.fail('No UI')});
  assert.equal(result.state,phase);assert.equal(result.complete,false);assert.equal(result.remoteStateRefreshed,false);
  assert.equal(result.reconciliationRequired,['reserved','downloading'].includes(phase));
  assert.equal(result.statusContinuation.arguments.action,'async-operation-status');
  assert.equal(result.statusContinuation.arguments.lastMessageId,'31');
  assert.ok(!JSON.stringify(result).includes('sentinel'));
  assert.equal(s.bridge.calls.filter(c=>c[0]==='web'&&c[1]==='fetch').length,0);
  assert.equal((await store.read(id,s.identity)).revision,0);
 }
});

test('download status verifies a completed artifact locally, and missing or wrong-target records never create preparation',async()=>{
 const s=fixture({first:osp});const completed=await s.call();assert.equal(completed.complete,true);
 const inspect=(changes={})=>runServiceCenter(serviceCenterArguments({action:'solution-download-status',host,solution,operationId:s.id,...changes},'read'),
  {locate:()=>s.bridge,present:async()=>false,running:async()=>true,exports:s.exports});
 assert.equal((await inspect()).artifact.verified,true);
 fs.writeFileSync(completed.file,'changed');
 const changed=await inspect();assert.equal(changed.state,'complete');assert.equal(changed.complete,false);assert.equal(changed.artifact.verified,false);
 assert.equal((await inspect({operationId:uuid()})).code,'SC_DOWNLOAD_NOT_FOUND');
 assert.equal((await inspect({solution:'Another'})).code,'SC_DOWNLOAD_CONTEXT_UNAVAILABLE');
 assert.equal(s.bridge.posts().length,1);
});

// Packaged (MSIX) apps each see a private %LOCALAPPDATA%: another app's record must still stop a resend.
const otherApp=family=>path.join(process.env.LOCALAPPDATA,'Packages',family,'LocalCache','Local','SSAM','ServiceCenterDownloads');
const sharedRoot=()=>path.join(process.env.USERPROFILE,'.ssam-hybrid','o11','service-center','downloads');
const writeAt=(dir,id,identity,context)=>new DownloadContextStore({roots:{root:dir,legacy:[]}}).create(id,identity,context);
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('a caller UUID with no record anywhere is refused before any request',async()=>{
 const s=fixture({id:uuid()});
 const result=await s.call();assert.equal(result.code,'SC_DOWNLOAD_NOT_FOUND');
 assert.equal(s.bridge.posts().length,0);
 assert.equal(fs.existsSync(path.join(sharedRoot(),s.id+'.dpapi')),false);
});

test('a record only in another app\'s store is found, never resent, and stays untouched',{skip:process.platform!=='win32'},async()=>{
 const id=uuid(),s=fixture({id}),dir=otherApp('Other.App_test1');
 await writeAt(dir,id,s.identity,{phase:'downloading',version:'current-running',preparation:{asyncOperationId:'123'},status:{asyncOperationId:'123',state:'done',errorCount:0,lastMessageId:31,terminal:true,completedSuccessfully:true}});
 const before=digest(path.join(dir,id+'.dpapi'));
 const status=await runServiceCenter(serviceCenterArguments({action:'solution-download-status',host,solution,operationId:id},'read'),
  {locate:()=>s.bridge,present:async()=>false,running:async()=>true,exports:s.exports});
 assert.equal(status.state,'downloading');assert.equal(status.recordOrigin.path,path.join(dir,id+'.dpapi'));assert.equal(status.recordOrigin.sha256,before);
 const again=await s.call();assert.equal(again.code,'SC_DOWNLOAD_SEND_UNCERTAIN');
 assert.equal(s.bridge.posts().length,0);
 assert.equal(digest(path.join(dir,id+'.dpapi')),before);
 assert.equal(fs.existsSync(path.join(sharedRoot(),id+'.dpapi')),false);
});

test('the first state change copies a legacy record to the shared store with its origin; the original is kept',{skip:process.platform!=='win32'},async()=>{
 const id=uuid(),s=fixture({id}),dir=otherApp('Other.App_test2');
 await writeAt(dir,id,s.identity,{phase:'prepared',version:'current-running',preparation:{asyncOperationId:'123',url:'Solution_Download.aspx',fields:[['__OSVSTATE','private-opaque-state']]},session:{kind:'native'},cursor:-1});
 const original=path.join(dir,id+'.dpapi'),before=digest(original);
 const ready=await s.call();assert.equal(ready.state,'ready');assert.equal(s.polls(),1);assert.equal(s.bridge.posts().length,0);
 assert.equal(digest(original),before);
 const migrated=await new DownloadContextStore().read(id,s.identity);
 assert.equal(migrated.revision,1);assert.equal(migrated.context.phase,'ready');
 assert.deepEqual(migrated.origin,{path:original,sha256:before,revision:0});
 assert.ok(fs.existsSync(path.join(sharedRoot(),id+'.dpapi')));
 // The migrated record wins over its unchanged source; a changed source makes the UUID ambiguous.
 assert.equal((await s.call()).complete,true);assert.equal(s.bridge.posts().length,1);
 fs.writeFileSync(original,Buffer.concat([fs.readFileSync(original),Buffer.from([0])]));
 await assert.rejects(new DownloadContextStore().read(id,s.identity),{code:'SC_DOWNLOAD_CONTEXT_AMBIGUOUS'});
});

test('abandoning a legacy uncertain record is local, keeps the words as sha256 and closes the UUID for good',{skip:process.platform!=='win32'},async()=>{
 const id=uuid(),s=fixture({id}),dir=otherApp('Other.App_test6'),words='Abandonar sem reenvio (Recomendado)',question='Posso marcar como abandonada?';
 await writeAt(dir,id,s.identity,{phase:'downloading',version:'current-running',preparation:{asyncOperationId:'123',fields:[['__OSVSTATE','private-opaque-state']]},session:{kind:'native'}});
 const original=path.join(dir,id+'.dpapi'),before=digest(original);
 const deps={locate:()=>s.bridge,present:async()=>false,running:async()=>true,exports:s.exports,opener:()=>assert.fail('No UI')};
 const write=input=>runServiceCenter(serviceCenterArguments({action:'solution-download-abandon',host,solution,operationId:id,...input},'write'),deps);
 const plan=await write({});assert.equal(plan.prepared,true);assert.equal(plan.sent,false);
 assert.equal((await new DownloadContextStore().read(id,s.identity)).context.phase,'downloading');
 const done=await write({execute:true,words,question});
 assert.equal(done.state,'abandoned');assert.equal(done.previousPhase,'downloading');assert.equal(done.sent,false);
 assert.equal(done.wordsSha256,crypto.createHash('sha256').update(words).digest('hex'));assert.ok(!JSON.stringify(done).includes(words));
 assert.deepEqual(done.recordOrigin,{path:original,sha256:before});
 const stored=await new DownloadContextStore().read(id,s.identity);
 assert.equal(stored.context.abandoned.question,question);assert.equal(stored.context.preparation,undefined);assert.equal(stored.context.session,undefined);
 assert.equal(digest(original),before);
 assert.equal((await write({execute:true,words})).alreadyAbandoned,true);
 const resumed=await s.call();assert.equal(resumed.code,'SC_DOWNLOAD_ABANDONED');
 const status=await runServiceCenter(serviceCenterArguments({action:'solution-download-status',host,solution,operationId:id},'read'),deps);
 assert.equal(status.state,'abandoned');assert.equal(status.reconciliationRequired,false);assert.equal(status.abandoned.previousPhase,'downloading');
 assert.equal(s.bridge.posts().length,0);
 assert.equal((await write({execute:true,words,operationId:uuid()})).code,'SC_DOWNLOAD_NOT_FOUND');
});

test('a completed download is never abandoned',{skip:process.platform!=='win32'},async()=>{
 const s=fixture({first:osp});assert.equal((await s.call()).complete,true);
 const refused=await runServiceCenter(serviceCenterArguments({action:'solution-download-abandon',host,solution,operationId:s.id,execute:true,words:'Abandonar'},'write'),
  {locate:()=>s.bridge,present:async()=>false,running:async()=>true,exports:s.exports});
 assert.equal(refused.code,'SC_DOWNLOAD_COMPLETE');
});

test('different legacy copies of one UUID are ambiguous; identical ones are not',{skip:process.platform!=='win32'},async()=>{
 const id=uuid(),s=fixture({id}),a=otherApp('Other.App_test3'),b=otherApp('Other.App_test4');
 await writeAt(a,id,s.identity,{phase:'downloading',version:'current-running'});
 fs.mkdirSync(b,{recursive:true});fs.copyFileSync(path.join(a,id+'.dpapi'),path.join(b,id+'.dpapi'));
 assert.equal((await new DownloadContextStore().read(id,s.identity)).context.phase,'downloading');
 await writeAt(otherApp('Other.App_test5'),id,s.identity,{phase:'failed',version:'current-running'});
 const refused=await s.call();assert.equal(refused.code,'SC_DOWNLOAD_CONTEXT_AMBIGUOUS');
 assert.equal(s.bridge.posts().length,0);
 await assert.rejects(new DownloadContextStore().create(id,s.identity,{phase:'preparation-ready'}),{code:'SC_DOWNLOAD_CONTEXT_AMBIGUOUS'});
});
