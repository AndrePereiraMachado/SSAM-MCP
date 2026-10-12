import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {knowledgeFileUploadPlan} from '../runtime/knowledge-file-plan.mjs';
const args=()=>({knowledgeBaseId:crypto.randomUUID(),dataSourceId:crypto.randomUUID(),environmentKey:crypto.randomUUID(),
 filename:'proof.txt',mimeType:'text/plain',base64:Buffer.from('SSAM prova de ingestão.').toString('base64'),
 limits:{ok:true,data:{AllowedUploadMimeTypes:'application/pdf, text/plain',MaximumUploadFileSize:'20971520'}}});
test('file plan uses UTF-8 byte size and native metadata, with evidence hashes but no ingestion claim',()=>{
 const a=args(),before=structuredClone(a),p=knowledgeFileUploadPlan(a);
 assert.equal(p.byteLength,Buffer.byteLength('SSAM prova de ingestão.'));assert.equal(p.sent,false);assert.equal(p.ingestionVerified,false);
 assert.deepEqual(p.input.inputParameters.FileMetaData,{Filename:'proof.txt',SizeBytes:String(p.byteLength),ContentType:'text/plain'});
 assert.equal(p.input.inputParameters.EnvironmentId,a.environmentKey);assert.deepEqual(a,before);
 const changed=knowledgeFileUploadPlan({...a,base64:Buffer.from('Different text').toString('base64')});assert.notEqual(p.inputSha256,changed.inputSha256);
});
test('file plan refuses stale/malformed limits, unsupported MIME, invalid content and external paths',()=>{
 const a=args();for(const patch of [{knowledgeBaseId:'bad'},{filename:'../secret.txt'},{filename:'a\\b'},{filename:'x\n.txt'},
  {mimeType:'text/html'},{base64:''},{base64:'YR=='},{base64:'aGVsbG8'},{limits:{ok:false,data:a.limits.data}},
  {limits:{ok:true,data:{...a.limits.data,MaximumUploadFileSize:'NaN'}}},{limits:{ok:true,data:{...a.limits.data,MaximumUploadFileSize:'1'}}}]){
  assert.throws(()=>knowledgeFileUploadPlan({...a,...patch}),{code:'INPUT_INVALID'});
 }
 assert.throws(()=>knowledgeFileUploadPlan({...a,base64:Buffer.alloc(200000,65).toString('base64')}),{code:'REQUEST_TOO_LARGE'});
});
