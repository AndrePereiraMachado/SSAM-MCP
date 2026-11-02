import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { usersRequest, registerO11Users, privateCall, openUsersPrompt } from '../o11-users.mjs';
import { runWithExecutor, setDefaultExecutor, DenyExecutor } from '../executor.mjs';
import { UsersClient, UsersTransport, UsersError, usersUrl, userRows, userDetail } from '../users/client.mjs';
import { Page, Document } from '../service-center/html.mjs';

const host='test.example',id='9007199254740993';
const row=(name='Fixture',username='fixture',userId=id)=>`<tr><td>icon</td><td><a href="User_Show.aspx?UserId=${userId}">${name}</a></td><td>${username}</td><td>fixture@example.invalid</td></tr>`;
const wrap=body=>`<html><form method="post" action="User_List.aspx"><input type="hidden" name="__OSVSTATE" value="fixture-state"><input id="x_wtSearchInput" name="x$wtSearchInput"><input type="submit" value="Search" name="x$Search">${body}</form></html>`;
const page=html=>new Page(`https://${host}/Users/User_List.aspx`,new Document(html));
const user={id,username:'fixture',name:'Fixture',isActive:true,roles:[],groups:[]};
function setup(t,extra={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-users-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let calls=0;const client={user:async()=>structuredClone(user),setActive:async(_id,isActive)=>{calls++;return {user:{...user,isActive}};},...extra};
  return {root,client,calls:()=>calls,session:async()=>({client,principal:'administrator'}),guardWrite:()=>{}};
}
test('URL boundary refuses other apps, origins, encoded separators and uncontrolled params',()=>{
  assert.equal(usersUrl(host,'User_Show.aspx?UserId='+id),`https://${host}/Users/User_Show.aspx?UserId=${id}`);
  for(const value of ['https://evil.example/Users/User_List.aspx','/ServiceCenter/Users.aspx','../Users/User_List.aspx','User_Show.aspx?UserId=1&UserId=2','User_Show.aspx?ReturnUrl=https://evil.example','/Users/%2e%2e/User_List.aspx','/Users/User_List.aspx#x','/Users/User_List.aspx?x=1'])assert.throws(()=>usersUrl(host,value));
});
test('rows preserve large ids and exclude sidebar recent items',()=>{
  const p=page(wrap(`<a href="User_Show.aspx?UserId=99">Sidebar</a><table id="x_wtUserTable">${row()}</table>`));
  assert.deepEqual(userRows(p),[{id,name:'Fixture',username:'fixture',email:'fixture@example.invalid'}]);
});
test('inherited roles stay distinct from direct roles',()=>{
 const p=new Page(`https://${host}/Users/User_Show.aspx?UserId=${id}`,new Document(wrap(`<h1>Fixture</h1><a id="x_wtEnableDisableLink">Set as Inactive</a><table id="x_wtUserShow"><tr><td>Username</td><td>fixture</td></tr></table><table id="x_wtUserRoles_wtRoleTable"><tr><td><a href="Role_Show.aspx?RoleId=8">Manager</a></td><td><a href="Group_Show.aspx?GroupId=4">Reviewers</a></td></tr></table>`)));
 assert.deepEqual(userDetail(p).roles,[{id:'8',name:'Manager',inheritedFrom:{id:'4',name:'Reviewers'}}]);
});
test('refuses credentials in MCP arguments',()=>{
 let registered;registerO11Users({registerTool:(name,spec)=>{assert.equal(name,'o11_users');registered=spec;}});
 assert.equal(registered.inputSchema.safeParse({host,operation:'create',password:'never'}).success,false);
 assert.equal(registered.inputSchema.safeParse({host,operation:'create',data:{username:'fixture',password:'never'}}).success,false);
});
test('unauthorized writes make no request',async t=>{
 const d=setup(t);const r=await usersRequest({host,operation:'deactivate',userId:id,operationId:randomUUID()},d);
 assert.equal(r.code,'USERS_AUTHORIZATION_REQUIRED');assert.equal(d.calls(),0);
});

test('update without an exact user id cannot turn into a create',async t=>{
 let writes=0;const d=setup(t,{saveUser:async()=>{writes++;return user;}});
 const r=await usersRequest({host,operation:'update',data:{name:'Fixture'},authorize:'Update fixture',operationId:randomUUID()},d);
 assert.equal(r.code,'USERS_ID_REQUIRED');assert.equal(writes,0);
});
test('one mutation per operation UUID, including across replay',async t=>{
 const d=setup(t),req={host,operation:'deactivate',userId:id,operationId:randomUUID(),authorize:'Deactivate the fixture user'};
 const first=await usersRequest(req,d),second=await usersRequest(req,d);
 assert.equal(first.state,'confirmed');assert.equal(second.replayed,false);assert.equal(d.calls(),1);
 assert.equal((await usersRequest({...req,operation:'activate'},d)).code,'USERS_OPERATION_CONFLICT');
});
test('lost write response persists uncertainty and never resends',async t=>{
 let calls=0;const d=setup(t,{setActive:async()=>{calls++;throw Error('network lost');}});
 const req={host,operation:'deactivate',userId:id,operationId:randomUUID(),authorize:'Deactivate the fixture user'};
 assert.equal((await usersRequest(req,d)).state,'uncertain');assert.equal((await usersRequest(req,d)).state,'uncertain');assert.equal(calls,1);
});
test('delete preview changes nothing; exact later confirmation required',async t=>{
 let calls=0;const d=setup(t,{deleteUser:async()=>{calls++;return {deleted:true};}});
 const p=await usersRequest({host,operation:'delete',userId:id,authorize:'Prepare to delete fixture'},d);
 assert.equal(p.preview,true);assert.equal(calls,0);
 const req={host,operation:'delete',userId:id,operationId:p.operationId,confirmationToken:p.confirmationToken,authorize:'Delete 1 fixture user'};
 assert.equal((await usersRequest({...req,authorize:'yes'},d)).code,'USERS_CONFIRMATION_REQUIRED');assert.equal(calls,0);
 assert.equal((await usersRequest(req,d)).state,'confirmed');assert.equal(calls,1);
});
test('changed user invalidates deletion preview',async t=>{
 const d=setup(t);const p=await usersRequest({host,operation:'delete',userId:id,authorize:'Prepare to delete fixture'},d);
 d.client.user=async()=>({...user,username:'changed'});
 const r=await usersRequest({host,operation:'delete',userId:id,operationId:p.operationId,confirmationToken:p.confirmationToken,authorize:'Delete 1 fixture user'},d);
 assert.equal(r.code,'USERS_PREVIEW_EXPIRED');
});

test('local mode: a form the page refuses is state refused, with the page words in validation only',async t=>{
 const refused=Object.assign(new UsersError('USERS_VALIDATION_FAILED','Users refused the form; its own messages are in validation.'),{validation:['taken']});
 const d=setup(t,{setActive:async()=>{throw refused;}});
 const r=await usersRequest({host,operation:'deactivate',userId:id,operationId:randomUUID(),authorize:'Deactivate the fixture user'},d);
 assert.equal(r.state,'refused');assert.deepEqual(r.validation,['taken']);assert.doesNotMatch(r.error,/taken/);
});
test('confirmed deletion is read from its receipt even when the user no longer exists',async t=>{
 const d=setup(t,{deleteUser:async()=>({deleted:true})});
 const p=await usersRequest({host,operation:'delete',userId:id,authorize:'Prepare to delete fixture'},d);
 const req={host,operation:'delete',userId:id,operationId:p.operationId,confirmationToken:p.confirmationToken,authorize:'Delete 1 fixture user'};
 assert.equal((await usersRequest(req,d)).state,'confirmed');
 d.client.user=async()=>{throw Error('The user no longer exists');};
 assert.equal((await usersRequest(req,d)).state,'confirmed');
});

test('reads the live Users breadcrumb title without requiring an h1',()=>{
 const p=new Page(`https://${host}/Users/User_Show.aspx?UserId=${id}`,new Document(wrap('<div id="x_wtTitle" class="title OSInline">Users</div><div id="y_wtTitle" class="title OSInline">Fixture</div><div id="container_wtTitle">Fixture Edit this User</div><a id="x_wtEnableDisableLink">Set as Inactive</a><table id="x_wtUserShow"><tr><td>Username</td><td>fixture</td></tr></table>')));
 assert.equal(userDetail(p).name,'Fixture');
});
test('refuses to deactivate the current administrator',async t=>{
 const d=setup(t);d.session=async()=>({client:d.client,principal:'fixture'});
 const r=await usersRequest({host,operation:'deactivate',userId:id,operationId:randomUUID(),authorize:'Deactivate fixture'},d);
 assert.equal(r.code,'USERS_SELF_LOCKOUT_REFUSED');assert.equal(d.calls(),0);
});
test('missing password opens a private prompt without dispatching create',async t=>{
 let opened=0;const d=setup(t);d.privateCall=async()=>({ok:true,available:false});d.openPrompt=()=>{opened++;return {opened:true};};
 const r=await usersRequest({host,operation:'create',data:{name:'Fixture',username:'new-fixture'},authorize:'Create the fixture user',operationId:randomUUID()},d);
 assert.equal(r.code,'USERS_PASSWORD_REQUIRED');assert.match(r.passwordRef,/^[a-f0-9]{64}$/);assert.equal(opened,1);assert.equal(d.calls(),0);
});
test('secret fields bypass the ordinary sender and never appear in its body',async()=>{
 let secretRequest;const http=new UsersTransport(host,{send:()=>{throw Error('ordinary sender called');},secretSend:async r=>{secretRequest=r;return {status:200,contentType:'text/html',body:Buffer.from('<html>ok</html>'),setCookie:[]};}});
 await http.fetch('User_Edit.aspx',[['field',''],['public','name']],'html',[{field:'field',kind:'password',entry:'a'.repeat(64),part:'password'}]);
 assert.deepEqual(secretRequest.fields,[['public','name']]);assert.equal(secretRequest.secretRefs[0].field,'field');
});

test('follows the native Users JSON redirect after Save without executing JavaScript',async()=>{
 const p=page(wrap('<input type="submit" name="save" id="save" value="Save" onclick="OsAjax()">'));
 let destination;
 const client=new UsersClient({ajaxPost:()=>['url',[]],reply:async()=>[`https://${host}/Users/User_Edit.aspx`,'OsJSONUpdate({"__RedirectToURL":"User_Show.aspx?UserId=42"});'],url:(v,b)=>usersUrl(host,v,b)});
 client.get=async route=>{destination=route;return p;};
 await client.click(p,p.doc.all('input').find(n=>n.attr('id')==='save'));
 assert.equal(destination,`https://${host}/Users/User_Show.aspx?UserId=42`);
});

for(const kind of ['role','group'])test(`${kind} membership uses its own autocomplete id and verifies add and remove`,async()=>{
 let assigned=false,posts=0;
 const suffix=kind==='role'?'wtNewRole':'wtNewGroupInput',targetId='8',object=kind==='role'?'Role':'Group';
 const tableId=kind==='role'?'x_wtUserRoles_wtRoleTable':'x_wtGroupTable';
 const markup=()=>`<html><form method="post" action="User_Show.aspx"><input type="hidden" name="__OSVSTATE" value="state"><h1>Fixture</h1><a id="x_wtEnableDisableLink">Set as Inactive</a><table id="x_wtUserShow"><tr><td>Username</td><td>fixture</td></tr></table><table id="${tableId}">${assigned?`<tr><td><a href="${object}_Show.aspx?${object}Id=${targetId}">Test</a></td><td><a onclick="OsAjax(event,'remove','remove','','__OSVSTATE,','');">Remove</a></td></tr>`:''}</table><div><input id="x_${suffix}" name="value"><input id="x_wttxtAutoCompleteValue" name="chosen"><input type="submit" name="add" id="add" value="Add" onclick="OsAjax(event,'add','add','','__OSVSTATE,','');"></div></form></html>`;
 const http=new UsersTransport(host,{send:async r=>{
   if(r.method==='POST'){
     const fields=new URLSearchParams(r.body);posts++;
     if(fields.get('__EVENTTARGET')==='add'){assert.equal(fields.get('chosen'),targetId);assigned=true;}
     else {assert.equal(fields.get('__EVENTTARGET'),'remove');assigned=false;}
   }
   return {status:200,contentType:'text/html',setCookie:[],body:Buffer.from(r.url.includes(`${object}_Show.aspx`)?'<html><form><h1>Test</h1></form></html>':markup())};
 }});
 const client=new UsersClient(http);
 assert.equal((await client.membership(id,kind,targetId,true)).changed,true);
 assert.equal((await client.membership(id,kind,targetId,true)).changed,false);
 assert.equal((await client.membership(id,kind,targetId,false)).changed,true);
 assert.equal(posts,2);
});

test('R1: with a user id the local window names the user read from the page, and a username in the request is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-users-r1-'));
  try {
    const opened = [];
    const deps = { root, openPrompt: async (_host, options) => { opened.push(options); return { opened: true }; }, session: async () => ({ principal: 'administrator', client: { user: async () => ({ id: '7', username: 'administrator' }) } }) };
    const refused = await usersRequest({ host: 'env.example.test', operation: 'password-prompt', userId: '7', data: { username: 'ana.silva' } }, deps);
    assert.equal(refused.code, 'USERS_USERNAME_WITH_ID');
    assert.deepEqual(opened, []);
    const shown = await usersRequest({ host: 'env.example.test', operation: 'password-prompt', userId: '7' }, deps);
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.equal(opened[0].subject, 'administrator');
    assert.equal(opened[0].userId, '7');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('C2: on an SSAM installed here, a new password nobody used leaves by a timer, with no other call', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-users-c2-'));
  try {
    const forgotten = [];
    let done; const gone = new Promise(resolve => { done = resolve; });
    const deps = { root, localPasswordMs: 20, privateCall: async (mode, _host, extra) => { if (mode === 'forget') { forgotten.push(extra.Entry); done(); } return { ok: true }; }, openPrompt: async () => ({ opened: true }) };
    const asked = await usersRequest({ host: 'env.example.test', operation: 'password-prompt', data: { username: 'new.user' } }, deps);
    assert.equal(asked.ok, true);
    await gone;
    assert.deepEqual(forgotten, [asked.passwordRef]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// fase4-28 r4-seam-fix: the two PowerShell -File entries of this file (the vault helper and its private window) refuse a hosted call
// and a served process without context before anything starts. SystemRoot points nowhere, so not even a base without the lock
// can start a PowerShell or show a window here.
test('the local vault helper and private window refuse a hosted call and a served process without context, before any spawn', async () => {
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = path.join(os.tmpdir(), 'ssam-no-windows-' + randomUUID());
  try {
    const hosted = { hosted: true, id: 'tok_seam', executor: { call: async () => { throw new Error('no machine call'); } } };
    await runWithExecutor(hosted, async () => {
      await assert.rejects(privateCall('status', host), e => e.code === 'SEAM_LOCAL_IN_HOSTED' && e.executed === false);
      await assert.rejects(openUsersPrompt(host), e => e.code === 'SEAM_LOCAL_IN_HOSTED' && e.executed === false);
    });
    const previous = setDefaultExecutor(new DenyExecutor());
    try {
      await assert.rejects(privateCall('status', host), e => e.code === 'HOSTED_CONTEXT_LOST');
      await assert.rejects(openUsersPrompt(host), e => e.code === 'HOSTED_CONTEXT_LOST');
    } finally { setDefaultExecutor(previous); }
  } finally { if (saved === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = saved; }
});