import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {downloadNativePackage} from '../runtime/asset-source-download.mjs';
import {OdcBridge} from '../runtime/bridge.mjs';
import {mockFetch,testConfig} from './helpers.mjs';
function zip(){
 const name=Buffer.from('test.txt'),body=Buffer.from('synthetic package'),crc=zlib.crc32(body);
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(name.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(name.length,28);
 const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+body.length,16);
 return Buffer.concat([local,name,body,central,name,end]);
}
for(const mobilePlatform of ['Android','iOS'])test('native package '+mobilePlatform+' binds identity and checks ZIP CRC without exposing signed URLs',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-package-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const operationKey=crypto.randomUUID(),target={environmentKey:crypto.randomUUID(),applicationKey:crypto.randomUUID(),buildKey:crypto.randomUUID(),revision:1,mobilePlatform,mobileVersionNumber:'0.1.0',mobileVersionCode:1};
 const receipt={state:'confirmed',identity:{operationId:'native-application-orchestration-service-api-v1:post:/build-operations',target},response:{key:operationKey}};
 let data={...target,key:operationKey,status:'Finished',appBinaryDownloadUrl:'https://storage.example.test/package?sig=private'},bytes=zip(),downloads=0;
 const mock=mockFetch({apiHandler:r=>{
  if(new URL(r.url).hostname==='tenant.example.test'){assert.equal(new URL(r.url).searchParams.get('applicationKey'),target.applicationKey);assert.equal(new URL(r.url).searchParams.get('environmentKey'),target.environmentKey);return Response.json(data);}
  downloads++;assert.equal(r.headers.authorization,undefined);assert.equal(r.redirect,'manual');return new Response(bytes,{headers:{'content-type':'application/zip'}});
 }});
 const args={directory,operationKey,receipt,bridge:new OdcBridge({fetchImpl:mock.fetchImpl,config:testConfig()})};
 const result=await downloadNativePackage(args);assert.equal(result.integrity.crc32Verified,true);assert.equal(result.integrity.semanticValidation,false);assert.deepEqual(fs.readFileSync(result.file),bytes);assert.doesNotMatch(JSON.stringify(result),/sig=|storage.example/);
 data={...data,revision:2};await assert.rejects(downloadNativePackage(args),e=>e.code==='OPERATION_IDENTITY_UNVERIFIED');assert.equal(downloads,1);
 data={...data,revision:1,status:'Running'};await assert.rejects(downloadNativePackage(args),e=>e.code==='GENERATED_CODE_NOT_READY');assert.equal(downloads,1);
 data={...data,status:'Finished'};bytes=Buffer.from(bytes);bytes[38]^=1;await assert.rejects(downloadNativePackage(args),e=>e.code==='NATIVE_PACKAGE_INVALID');
 receipt.state='accepted';await assert.rejects(downloadNativePackage(args),e=>e.code==='OPERATION_RECEIPT_MISMATCH');
});
