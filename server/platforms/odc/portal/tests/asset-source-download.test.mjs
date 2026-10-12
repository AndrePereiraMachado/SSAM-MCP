import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {downloadAssetSource,downloadGeneratedCode,verifiedSourceUri} from '../runtime/asset-source-download.mjs';
import {OdcBridge} from '../runtime/bridge.mjs';
import {mockFetch,testConfig} from './helpers.mjs';
for(const [kind,urlField,digestField] of [['icon','iconUrl','iconDigest'],['signature','signatureBinaryUrl','signatureDigest']])
test(`${kind} download preserves exact bytes and digest with no capability URL in evidence`,async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'asset-artifact-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const bytes=Buffer.from([137,80,78,71,0,255]);let calls=0;
 const mock=mockFetch({apiHandler:r=>{
  calls++;
  if(new URL(r.url).hostname==='tenant.example.test'){
   assert.ok(new URL(r.url).pathname.endsWith('/'+kind));
   return Response.json({[urlField]:'https://storage.example.test/artifact?sig=private-capability',[digestField]:'native-digest'});
  }
  assert.equal(r.headers.authorization,undefined);return new Response(bytes,{headers:{'content-type':'application/octet-stream'}});
 }});
 const bridge=new OdcBridge({fetchImpl:mock.fetchImpl,config:testConfig()});
 const args={bridge,directory,assetKey:crypto.randomUUID(),revisionNumber:6,kind};
 const result=await downloadAssetSource(args);
 assert.equal(result.kind,kind);assert.equal(result[digestField],'native-digest');
 assert.deepEqual(fs.readFileSync(result.file),bytes);
 assert.equal(result.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
 assert.doesNotMatch(fs.readFileSync(result.file+'.json','utf8'),/private-capability|storage.example/);
 const before=calls;await assert.rejects(downloadAssetSource({...args,kind:'../bad'}),e=>e.code==='INPUT_INVALID');assert.equal(calls,before);
});
test('internal source URI requires the exact approved remote bytes without forwarding tenant OAuth',async()=>{
 const bytes=Buffer.from('OML synthetic approved source'),assetKey=crypto.randomUUID();
 const expectedSha256=crypto.createHash('sha256').update(bytes).digest('hex');
 const location='https://storage.example.test/source?sig=private-test';let altered=false;
 const mock=mockFetch({apiHandler:r=>{
  if(new URL(r.url).hostname==='tenant.example.test'){
   assert.ok(new URL(r.url).pathname.includes(assetKey+'/revisions/1/'));
   return Response.json({sourceCodeBinaryUrl:location});
  }
  assert.equal(r.headers.authorization,undefined);
  return new Response(altered?Buffer.from('OML altered'):bytes,{headers:{'content-type':'application/octet-stream'}});
 }});
 const args={bridge:new OdcBridge({fetchImpl:mock.fetchImpl,config:testConfig()}),assetKey,revisionNumber:1,expectedSha256};
 assert.equal(await verifiedSourceUri(args),location);
 altered=true;await assert.rejects(verifiedSourceUri(args),e=>e.code==='SOURCE_HASH_CHANGED'&&!e.message.includes('private-test'));
});
test('generated code download requires finished packaging and keeps capability URL private',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'generated-code-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 let status='Running',binaries=0;
 const mock=mockFetch({apiHandler:r=>{
  if(new URL(r.url).hostname==='tenant.example.test')return Response.json({status,uri:'https://storage.example.test/generated?sig=private-capability',errors:[]});
  binaries++;assert.equal(r.headers.authorization,undefined);return new Response(Buffer.from('PK synthetic test archive'),{headers:{'content-type':'application/zip'}});
 }});
 const args={directory,buildKey:crypto.randomUUID(),bridge:new OdcBridge({fetchImpl:mock.fetchImpl,config:testConfig()})};
 await assert.rejects(downloadGeneratedCode(args),e=>e.code==='GENERATED_CODE_NOT_READY');assert.equal(binaries,0);
 status='Finished';const result=await downloadGeneratedCode(args);assert.equal(result.ok,true);assert.equal(binaries,1);
 assert.equal(path.extname(result.file),'.zip');assert.doesNotMatch(JSON.stringify(result),/private-capability/);
});
test('source download contains signed URLs, never forwards OAuth, saves exact bytes without overwrite',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'asset-source-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const bytes=Buffer.from([0,1,2,255]);let location='https://storage.example.test/source?sig=private-signature',status=200;
 const mock=mockFetch({apiHandler:r=>{
  if(new URL(r.url).hostname==='tenant.example.test')return Response.json({sourceCodeBinaryUrl:location,sourceCodeDigest:'digest'});
  assert.equal(r.headers.authorization,undefined);assert.equal(r.redirect,'manual');
  return new Response(bytes,{status,headers:{'content-type':'application/octet-stream'}});
 }});
 const bridge=new OdcBridge({fetchImpl:mock.fetchImpl,config:testConfig()});
 const args={bridge,directory,assetKey:crypto.randomUUID(),revisionNumber:1};
 const a=await downloadAssetSource(args),b=await downloadAssetSource(args);
 assert.notEqual(a.file,b.file);assert.deepEqual(fs.readFileSync(a.file),bytes);
 assert.equal(a.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
 assert.doesNotMatch(JSON.stringify(a),/private-signature|mock-access-token/);
 for(const invalid of ['https://127.0.0.1/a','http://storage.test/a','https://user:pass@storage.test/a','https://storage.test/a#x']) {
  location=invalid;await assert.rejects(downloadAssetSource(args),e=>e.code==='SOURCE_LOCATION_INVALID');
 }
 location='https://storage.example.test/a';status=302;
 await assert.rejects(downloadAssetSource(args),e=>e.code==='REDIRECT_BLOCKED');
 await assert.rejects(downloadAssetSource({...args,assetKey:'../unsafe'}),e=>e.code==='INPUT_INVALID');
});
