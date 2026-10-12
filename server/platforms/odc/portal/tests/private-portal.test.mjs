import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { privatePortalSender } from '../runtime/private-portal.mjs';
import { Odc3PortalBroker } from '../runtime/odc3-context.mjs';

const host = 'personal-test.outsystems.dev', principal = 'user@example.test';
const cookie = 'crf=fixture-csrf; session=fixture-session', csrf = 'fixture-csrf';
const refs = [{ pointer: '/inputParameters/Password', target: `SSAM/ODC3/${host}/DB/Fixture`, field: 'password' }];
const options = { method: 'POST', write: true, body: { inputParameters: { Password: '' } }, secretRefs: refs,
  operationId: 'connections.relationalTest', operationUuid: '7a60381d-39a5-48d7-ad36-1541153ffca0', authorizeSha256: 'b'.repeat(64), confirmTenant: host };
test('API client creation always uses private native capture even with no input secret references',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'api-client-native-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const broker=new Odc3PortalBroker({origin:'https://'+host,fetchImpl:()=>{throw Error('ordinary POST forbidden');}});broker.authenticated=true;
 await broker.jar.setCookie('session=fixture-session; Secure; HttpOnly; Path=/',broker.origin);
 broker.metadata.resolve=async(module,view,action)=>({moduleVersion:'m',apiVersion:'a',action});
 let sends=0;const name='SSAMApiClientProof20261010',operationUuid=options.operationUuid;
 const sender=privatePortalSender({host,principal,optionalCsrf:true,apiClientVault:true,
  requestFile:r=>{const file=path.join(dir,'request.json');fs.writeFileSync(file,JSON.stringify(r));return file;},handoff:async(c,invoke)=>invoke(operationUuid),
  bridge:async()=>{sends++;return {ok:true,host,user:principal,status:200,body:{Unexpected:'synthetic-secret',data:{ClientSecret:'synthetic-secret',ApiClientProof:{key:'7a60381d-39a5-48d7-ad36-1541153ffca1',name,operationUuid,vaultRef:'urn:ssam:api-client:'+operationUuid,vaultStored:true,rawValueExposed:false,responseProjected:true,Extra:'synthetic-secret'}}}};}});
 const request={...options,operationId:'apiClients.create',secretRefs:[],input:{inputParameters:{OIDCClientCreate:{Name:name}}},privateSender:sender};
 sender.apiClientVault=false;await assert.rejects(broker.callScreenservice(request),{code:'HEADLESS_AUTH_UNAVAILABLE'});assert.equal(sends,0);
 sender.apiClientVault=true;const result=await broker.callScreenservice(request);assert.equal(sends,1);assert.equal(JSON.stringify(result).includes('synthetic-secret'),false);
});
for(const conversion of [false,true])test('vault binary broker preserves its Setting reference for '+(conversion?'conversion':'upload'),async()=>{
 const key=conversion?'BinaryData':'FileContent',operationId=conversion?'mobileExtensibility.convertFile':'mobileExtensibility.uploadFile';
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vault-binary-pipe-'));let calls=0;
 try{const broker=new Odc3PortalBroker({origin:'https://'+host,fetchImpl:()=>{throw Error('ordinary POST forbidden');}});broker.authenticated=true;
 await broker.jar.setCookie('session=fixture-session; Secure; HttpOnly; Path=/',broker.origin);broker.metadata.resolve=async(module,view,action)=>({moduleVersion:'m',apiVersion:'a',action});
 const expected={sha256:'a'.repeat(64),byteLength:32},secretRefs=[{pointer:'/inputParameters/'+key,target:'SSAM/ODC3/'+host+'/Setting/OwnFile',field:'password'}];
 const sender=privatePortalSender({host,principal,optionalCsrf:true,mobileUpload:true,mobileVaultUpload:true,mobileBase64:true,requestFile:request=>{
  assert.deepEqual(request.mobileExpectedContent,expected);assert.deepEqual(request.secretRefs,secretRefs);assert.equal(request.body.inputParameters[key],'');assert.equal(request.path.endsWith(conversion?'ActionBinaryToBase64':'ActionFileUpload_Wrapper'),true);const file=path.join(dir,'request.json');fs.writeFileSync(file,JSON.stringify(request));return file;
 },handoff:async(context,invoke)=>invoke(options.operationUuid),bridge:async()=>{calls++;return {ok:true,host,user:principal,status:200,body:{data:{UploadProof:{}}}};}});
 await broker.callScreenservice({...options,operationId,input:{inputParameters:{[key]:''}},secretRefs,mobileExpectedContent:expected,privateSender:sender});assert.equal(calls,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('a bridge without native Base64 support cannot receive conversion or Base64 save bindings',async()=>{
 const sender=privatePortalSender({host,principal,mobileUpload:true,mobileVaultUpload:true,requestFile:()=>{throw Error('must not reserve or invoke');}});
 for(const operationId of ['mobileExtensibility.convertFile','mobileExtensibility.saveFile'])await assert.rejects(()=>sender('https://'+host+'/apps/screenservices/action',{...options,operationId,mobileObjectUri:'urn:ssam:mobile-base64:'+options.operationUuid},{cookie,csrf}),e=>e.code==='HEADLESS_AUTH_UNAVAILABLE');
});
test('private sender binds the exact public file hash and keeps sessions out of bridge arguments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-portal-'));
  let publicRequest, args;
  try {
    const sender = privatePortalSender({ host, principal,
      requestFile: request => { publicRequest = request; const file = path.join(dir, 'request.json'); fs.writeFileSync(file, JSON.stringify(request)); return file; },
      bridge: async value => { args = value; return { ok: true, host, user: principal, status: 200, body: { data: { Out_ConnectionId: 'id' } } }; },
      handoff: async (context, invoke) => {
        assert.equal(context.cookie, cookie); assert.equal(context.csrf, csrf);
        assert.equal(context.requestSha256, createHash('sha256').update(JSON.stringify(publicRequest)).digest('hex'));
        return invoke('7a60381d-39a5-48d7-ad36-1541153ffca1');
      },
    });
    const response = await sender(`https://${host}/connections/screenservices/connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionTestConnection`, options, { cookie, csrf });
    assert.equal(JSON.parse(response.text).data.Out_ConnectionId, 'id');
    for (const serialized of [JSON.stringify(args), JSON.stringify(publicRequest), fs.readFileSync(path.join(dir, 'request.json'), 'utf8')]) {
      assert.ok(!serialized.includes(csrf)); assert.ok(!serialized.includes('fixture-session'));
    }
    assert.equal(args[0], 'portal-private-call'); assert.equal(publicRequest.body.inputParameters.Password, '');
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('foreign origin and nonempty placeholders are refused before creating files or invoking native transport', async () => {
  const sender = privatePortalSender({ host, principal, requestFile: () => { throw new Error('must not create file'); } });
  await assert.rejects(sender('https://other.test/connections/x', options, { cookie, csrf }), { code: 'PORTAL_ORIGIN_DENIED' });
  await assert.rejects(sender(`https://${host}/connections/x`, { ...options, body: { inputParameters: { Password: 'inline' } } }, { cookie, csrf }), { code: 'INPUT_INVALID' });
});
test('broker metadata stays read-only and only final write uses the native credential sender', async () => {
  const broker = new Odc3PortalBroker({ origin: 'https://' + host, fetchImpl: () => { throw new Error('no ordinary POST allowed'); } });
  broker.authenticated = true;
  await broker.jar.setCookie(`crf=${csrf}; Secure; Path=/`, broker.origin);
  await broker.jar.setCookie('session=fixture-session; Secure; HttpOnly; Path=/', broker.origin);
  broker.metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
  let sends = 0;
  const result = await broker.callScreenservice({ ...options, input: options.body, privateSender: async (url, request, context) => {
    sends++; assert.equal(new URL(url).hostname, host); assert.equal(request.write, true);
    assert.equal(context.csrf, csrf); assert.match(context.cookie, /fixture-session/);
    assert.equal(request.body.inputParameters.Password, '');
    return { status: 200, text: JSON.stringify({ data: { Out_ConnectionId: 'id' } }) };
  } });
  assert.equal(sends, 1); assert.equal(result.data.Out_ConnectionId, 'id');
});

test('optional CSRF requires an explicit native capability and still keeps the broker authenticated', async () => {
  const broker = new Odc3PortalBroker({ origin: 'https://' + host });
  broker.authenticated = true;
  await broker.jar.setCookie('session=fixture-session; Secure; HttpOnly; Path=/', broker.origin);
  broker.metadata.resolve = async (module, view, action) => ({ moduleVersion: 'm', apiVersion: 'a', action });
  let calls = 0;
  const privateSender = async (url, request, context) => {
    calls++; assert.equal(context.csrf, ''); assert.match(context.cookie, /fixture-session/);
    return { status: 200, text: '{"data":{}}' };
  };
  await assert.rejects(broker.callScreenservice({ ...options, input: options.body, privateSender }), { code: 'HEADLESS_AUTH_UNAVAILABLE' });
  assert.equal(calls, 0);
  privateSender.optionalCsrf = true;
  await broker.callScreenservice({ ...options, input: options.body, privateSender }); assert.equal(calls, 1);
  broker.authenticated = false;
  await assert.rejects(broker.callScreenservice({ ...options, input: options.body, privateSender }), { code: 'PORTAL_AUTH_REQUIRED' });
  assert.equal(calls, 1);
});

test('mobile calls without secretRefs require the private capability and forward only opaque save bindings', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'private-mobile-'));
  try {
    const broker=new Odc3PortalBroker({origin:'https://'+host,fetchImpl:()=>{throw new Error('ordinary POST forbidden');}});
    broker.authenticated=true;
    await broker.jar.setCookie(`crf=${csrf}; Secure; Path=/`,broker.origin);
    await broker.jar.setCookie('session=fixture-session; Secure; HttpOnly; Path=/',broker.origin);
    broker.metadata.resolve=async(module,view,action)=>({moduleVersion:'m',apiVersion:'a',action});
    const uploadOperationUuid='7a60381d-39a5-48d7-ad36-1541153ffca2';
    const mobileObjectUri='https://plat-proof.s3.us-east-1.amazonaws.com/tenants/uploads/'+uploadOperationUuid;
    let calls=0;
    const sender=privatePortalSender({host,principal,mobileUpload:true,requestFile:request=>{
      assert.equal(request.mobileUploadOperationUuid,uploadOperationUuid);
      assert.equal(request.mobileObjectUri,mobileObjectUri);
      assert.equal(Object.hasOwn(request,'secretRefs'),false);
      const file=path.join(dir,'request.json');fs.writeFileSync(file,JSON.stringify(request));return file;
    },handoff:async(context,invoke)=>invoke(uploadOperationUuid),bridge:async()=>{
      calls++;return {ok:true,host,user:principal,status:200,body:{data:{}}};
    }});
    const args={...options,operationId:'mobileExtensibility.saveFile',secretRefs:[],input:{inputParameters:{}},mobileUploadOperationUuid:uploadOperationUuid,mobileObjectUri,privateSender:sender};
    sender.mobileUpload=false;
    await assert.rejects(broker.callScreenservice(args),{code:'HEADLESS_AUTH_UNAVAILABLE'});
    assert.equal(calls,0);sender.mobileUpload=true;
    await broker.callScreenservice(args);assert.equal(calls,1);
  } finally {fs.rmSync(dir,{recursive:true});}
});
