import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {stageAssetUpload,ASSET_UPLOAD} from '../runtime/asset-upload.mjs';
import {OdcBridge} from '../runtime/bridge.mjs';
import {mockFetch,testConfig} from './helpers.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {OdcAccess} from '../runtime/access.mjs';
import {WriteJournal} from '../runtime/write-journal.mjs';

for(const lost of [false,true])test(`staged revision receipt prevents duplicate dispatch, lost=${lost}`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'staged-write-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const host='tenant.example.test',assetKey=crypto.randomUUID(),operationUuid=crypto.randomUUID();
 const receipts=new WriteJournal(dir),sent=[];
 const mock=mockFetch({apiHandler:r=>{
  const url=new URL(r.url);sent.push(r.method+' '+url.pathname);
  const live=receipts.lookup(operationUuid);
  if(url.pathname.endsWith('/uploads')){
   assert.equal(live.uploadStage.phase,'upload-request-submitted');
   if(lost)throw Error('lost upload response');
   return Response.json({uploadUrl:'https://storage.example.test/upload?sig=private'},{status:201});
  }
  if(r.method==='PUT'){assert.equal(live.uploadStage.phase,'upload-put-submitted');return new Response(null,{status:200});}
  assert.equal(live.uploadStage.phase,'revision-submitted');assert.equal(JSON.parse(r.body).fileUri,'https://storage.example.test/upload?sig=private');
  return Response.json({assetKey,revision:1},{status:201});
 }});
 const operationId='asset-repository-api-v1:post:/assets';
 const bridge=new OdcBridge({fetchImpl:mock.fetchImpl,config:testConfig({allowedWriteOperations:new Set([ASSET_UPLOAD,operationId])})});
 const access=new OdcAccess({catalog:bridge.catalog,receipts,tenants:{tenants:{[host]:{class:'personal'}}},vault:{bridge:async()=>bridge},journal:()=>{}});
 access.pickTenant=async()=>host;access.resolvePublic=async()=>({path:'vault',host});
 const input={tenant:host,auth:'api-client',operationId,operationUuid,authorize:'Synthetic fixture authorization',contentType:'application/octet-stream',body:{$base64:Buffer.from('OML synthetic').toString('base64')}};
 const options={preparedSourceRevision:{assetKey,uploadFormat:'staged',approval:null}};
 const originalPolicy=access.policyOf;
 access.policyOf=()=>new Set([operationId]);
 const blocked=await access.write({...input,operationUuid:crypto.randomUUID()},options);
 assert.equal(blocked.error.code,'WRITE_BLOCKED');assert.equal(sent.length,0);
 access.policyOf=originalPolicy;
 const result=await access.write(input,options);
 assert.equal(result.receipt?.state,lost?'uncertain':'accepted',JSON.stringify(result));
 assert.equal(sent.length,lost?1:3);
 await access.write(input,options);assert.equal(sent.length,lost?1:3);
 assert.doesNotMatch(fs.readFileSync(receipts.file(operationUuid),'utf8'),/private|storage.example/);
});

test('asset staging records boundaries, keeps OAuth on tenant and sends exact bytes once',async()=>{
 const bytes=Buffer.from('OML approved fixture'),expectedSha256=crypto.createHash('sha256').update(bytes).digest('hex');
 const stages=[],sent=[];
 const mock=mockFetch({apiHandler:r=>{
  sent.push(r.method);
  if(r.method==='POST'){assert.equal(stages.at(-1).phase,'upload-request-submitted');return Response.json({uploadUrl:'https://storage.example.test/source?sig=private'}, {status:201});}
  assert.equal(r.method,'PUT');assert.equal(stages.at(-1).phase,'upload-put-submitted');
  assert.equal(r.headers.authorization,undefined);assert.deepEqual(r.body,bytes);
  return new Response(null,{status:200});
 }});
 const bridge=new OdcBridge({fetchImpl:mock.fetchImpl,config:testConfig({allowedWriteOperations:new Set([ASSET_UPLOAD])})});
 const args={bridge,bytes,expectedSha256,onStage:async s=>stages.push(s)};
 const result=await stageAssetUpload(args);assert.equal(result.ok,true);assert.deepEqual(sent,['POST','PUT']);
 assert.equal(stages.at(-1).phase,'upload-put-accepted');assert.doesNotMatch(JSON.stringify(stages),/private|fileUri|storage.example/);
 await assert.rejects(stageAssetUpload({...args,expectedSha256:'0'.repeat(64)}),e=>e.code==='ASSET_UPLOAD_INVALID');
 assert.deepEqual(sent,['POST','PUT']);
});

test('lost upload response is uncertain and never retried; failed persistence prevents its next send',async()=>{
 const bytes=Buffer.from('OML fixture'),expectedSha256=crypto.createHash('sha256').update(bytes).digest('hex');
 let sends=0;
 const mock=mockFetch({apiHandler:()=>{sends++;throw Error('lost');}});
 const bridge=new OdcBridge({fetchImpl:mock.fetchImpl,config:testConfig({allowedWriteOperations:new Set([ASSET_UPLOAD])})});
 const args={bridge,bytes,expectedSha256,onStage:async()=>{}};
 const result=await stageAssetUpload(args);assert.equal(result.state,'uncertain');assert.equal(sends,1);
 await assert.rejects(stageAssetUpload({...args,onStage:async()=>{throw Error('disk failure');}}),/disk failure/);assert.equal(sends,1);
});
