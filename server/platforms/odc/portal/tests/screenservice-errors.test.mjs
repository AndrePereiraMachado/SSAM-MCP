import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenservice, PORTAL_READS } from '../runtime/portal-routes.mjs';

test('dataset action selector resolves the current shared dropdown controller',()=>{
 assert.deepEqual(PORTAL_READS['agents.serviceActions'],['agents','Evaluations_Datasets.dataset','agents/Evaluations_Components/Dropdown_ServiceActions/DataActionGetServiceActionsByApp']);
});

test('HTTP 200 exception envelopes retain only typed diagnostics and never recover or replay writes',async()=>{
 const route={module:'usersaccess',view:'APIClients.apiclient',action:'usersaccess/APIClients/DeleteAPIClient/ActionAPIClients_Delete',extra:{write:true}};
 for(const field of ['exception','error'])for(const remote of [
  {errorCode:'OS-BERT-00000',name:'UserException',message:JSON.stringify({ErrorCode:'OS-UAUC-60002',Detail:'private',Title:'private'}),stack:'private'},
  {errorCode:'OS-BERT-00000 private',type:'private',message:'private'},
  'private',42,
 ]){
  let calls=0;
  await assert.rejects(screenservice({origin:'https://tenant.test',metadata:{resolve:async()=>({action:route.action,moduleVersion:'v',apiVersion:'a'})},
   request:async()=>{calls++;return {status:200,text:JSON.stringify({[field]:remote})};}},route),error=>{
    assert.equal(error.code,'PORTAL_REQUEST_FAILED');
    assert.deepEqual(error.details,typeof remote==='object'&&remote.name==='UserException'
     ?{sent:true,status:200,remoteCode:'OS-BERT-00000',remoteCauseCode:'OS-UAUC-60002',remoteType:'UserException'}:{sent:true,status:200});
    assert.doesNotMatch(JSON.stringify(error),/private/);return true;
   });
  assert.equal(calls,1);
 }
});

test('only exact read-only native No Session tuple is recoverable',async()=>{
 const route={module:'connections',view:'Connections.connections',action:'connections/Connections/connections/DataActionGetConnections'};
 const message={Type:'OS-UAUC-60002',ErrorCode:'OS-UAUC-60002',Detail:'No Session',IsParsed:true,Title:'PRIVATE'};
 const exception={name:'UserException',specificType:'Connections_CS.INTC_ConsoleException',errorCode:'OS-BERT-00000',message:JSON.stringify(message)};
 const call=(e=exception,change={})=>screenservice({origin:'https://tenant.test',metadata:{resolve:async()=>({action:route.action,moduleVersion:'v',apiVersion:'a'})},request:async()=>({status:250,text:JSON.stringify({exception:e})})},{...route,...change});
 await assert.rejects(call(),error=>error.code==='PORTAL_AUTH_REQUIRED'&&error.details.reason==='native-no-session'&&!JSON.stringify(error).includes('PRIVATE'));
 for(const [key,value] of [['Type','Other'],['ErrorCode','Other'],['Detail','Access denied'],['IsParsed',false]]){
  await assert.rejects(call({...exception,message:JSON.stringify({...message,[key]:value})}),{code:'PORTAL_REQUEST_FAILED'});
 }
 for(const change of [{extra:{write:true}},{view:'Connections.connection'},{action:'connections/Other'}])await assert.rejects(call(exception,change),{code:'PORTAL_REQUEST_FAILED'});
 for(const change of [{name:'SecurityException'},{specificType:'Other'},{errorCode:'OS-OTHER-00000'},{message:'No Session'}])await assert.rejects(call({...exception,...change}),{code:'PORTAL_REQUEST_FAILED'});
});

test('HTTP 250 exposes only a typed platform code, never exception text or arbitrary type', async () => {
  for (const exception of [
    { errorCode: 'OS-BEW-00000', type: 'SecurityException', message: 'password=private', stack: 'private' },
    { errorCode: 'private', type: 'private', message: 'private' },
  ]) {
    let calls = 0;
    await assert.rejects(screenservice({ origin: 'https://tenant.test',
      metadata: { async resolve() { return { action: 'monitoring/traces/TreeView_multipleRoots/DataActionGetSpans', moduleVersion: 'v', apiVersion: 'a' }; } },
      async request() { calls++; return { status: 250, text: JSON.stringify({ exception }) }; },
    }, { module: 'monitoring', view: 'traces.TreeView_multipleRoots', action: 'monitoring/traces/TreeView_multipleRoots/DataActionGetSpans' }), error => {
      assert.equal(error.code, 'PORTAL_REQUEST_FAILED');
      assert.equal(error.details.status, 250);
      assert.equal(error.details.sent, true);
      assert.equal(error.details.remoteCode, exception.errorCode.startsWith('OS-') ? exception.errorCode : undefined);
      assert.equal(error.details.remoteType, exception.type === 'SecurityException' ? exception.type : undefined);
      assert.doesNotMatch(JSON.stringify(error), /private/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('nested native error code remains diagnostic and never exposes free text or triggers replay',async()=>{
 const route={module:'agents',view:'Evaluations_Datasets.dataset',action:'agents/Evaluations_Datasets/Dataset_TestCase_Create/DataActionGetJsonSchema'};
 for(const ErrorCode of ['OS-AIAC-40001','private','OS-AIAC-40001 private',42,null]) {
  let calls=0;
  await assert.rejects(screenservice({origin:'https://tenant.test',metadata:{resolve:async()=>({action:route.action,moduleVersion:'v',apiVersion:'a'})},request:async()=>{
   calls++;return {status:250,text:JSON.stringify({exception:{errorCode:'OS-BERT-00000',name:'UserException',message:JSON.stringify({ErrorCode,Detail:'private password',Title:'private',stack:'private'})}})};
  }},route),error=>{
   assert.equal(error.code,'PORTAL_REQUEST_FAILED');
   assert.equal(error.details.remoteCauseCode,ErrorCode==='OS-AIAC-40001'?ErrorCode:undefined);
   assert.equal(error.details.remoteType,'UserException');
   assert.doesNotMatch(JSON.stringify(error),/private/);return true;
  });
  assert.equal(calls,1);
 }
});


test('deleted connection lookup normalizes only its exact native missing-ID exception',async()=>{
 const id='9f0c173c-1634-46e3-9d7a-7f584ea72c28',other='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 const route={module:'connections',view:'Connections.connection',action:'connections/Connections/connection/DataActionGetConnection',screenVariables:{ConnectionId:id}};
 const exception={name:'UserException',specificType:'Connections_CS.INTC_ConsoleException',errorCode:'OS-BERT-00000',message:`Connection with id '${id}' does not exist. PRIVATE_STACK`};
 async function call(e=exception,change={}){return screenservice({origin:'https://tenant.test',metadata:{resolve:async()=>({action:route.action,moduleVersion:'v',apiVersion:'a'})},request:async()=>({status:250,text:JSON.stringify({exception:e})})},{...route,...change});}
 assert.deepEqual(await call(),{data:{NotFound:true,Connection:null},absenceEvidence:{source:'native-missing-connection',connectionId:id}});
 for(const e of [{...exception,message:`Connection '${other}' does not exist`},{...exception,message:`Connection '${other}' and '${id}' does not exist`},
 {...exception,message:`Connection '${id}' timed out`},{...exception,specificType:'Other'},{...exception,name:'SecurityException'},{...exception,errorCode:'OS-OTHER-00000'}]) {
  await assert.rejects(call(e),err=>err.code==='PORTAL_REQUEST_FAILED'&&!JSON.stringify(err).includes('PRIVATE_STACK'));
 }
 await assert.rejects(call(exception,{extra:{write:true}}),{code:'PORTAL_REQUEST_FAILED'});
 await assert.rejects(call(exception,{view:'Connections.elements'}),{code:'PORTAL_REQUEST_FAILED'});
});
