import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {privateKnowledgeDownloader} from '../runtime/private-knowledge-download.mjs';import {KNOWLEDGE_FILE_DOWNLOAD_PATH as route} from '../runtime/knowledge-file-download-plan.mjs';
import {Odc3PortalBroker} from '../runtime/odc3-context.mjs';import {routeOf} from '../runtime/portal-routes.mjs';
const host='personal-test.outsystems.dev',principal='user@example.test',cookie='session=private-cookie-sentinel',csrf='private-csrf-sentinel',bytes=Buffer.from('own proof\n'),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function fixture(t,change=()=>{}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'private-knowledge-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const requests=path.join(dir,'requests'),downloads=path.join(dir,'downloads');fs.mkdirSync(requests);fs.mkdirSync(downloads);
 let request,args,calls=0;const expectedContent={filename:'proof.txt',mimeType:'text/plain',byteLength:bytes.length,sha256:sha(bytes)},fileId=crypto.randomUUID();
 const sender=privateKnowledgeDownloader({host,principal,requestFile:async value=>{request=value;const file=path.join(requests,'request.json');fs.writeFileSync(file,JSON.stringify(value));return file;},handoff:async(context,invoke)=>{
  assert.equal(context.cookie,cookie);assert.equal(context.csrf,csrf);assert.equal(context.requestSha256,sha(JSON.stringify(request)));return invoke('pipe-id');},bridge:async value=>{
  calls++;args=value;const file=path.join(downloads,'knowledge-file-'+request.downloadId+'.bin');fs.writeFileSync(file,bytes);
  const answer={ok:true,host,user:principal,status:200,body:{data:{FileDownloadProof:{downloadId:request.downloadId,fileId,file,filename:'proof.txt',mimeType:'text/plain',byteLength:bytes.length,sha256:sha(bytes),contentReadBackVerified:true,ingestionVerified:false,signedUriExposed:false}}}};
  await change(answer,{file,request});return answer;}});
 const invoke=()=>sender('https://'+host+route,{method:'POST',body:{inputParameters:{FileId:fileId}}},{cookie,csrf},expectedContent);
 return{invoke,sender,expectedContent,fileId,dir,get request(){return request;},get args(){return args;},get calls(){return calls;}};
}
test('private read binds request/principal, verifies persisted bytes and returns only allowlisted proof',async t=>{
 const f=fixture(t,a=>{a.body.data.FileDownloadProof.Url='https://private.test/?signed=sentinel';a.body.secretEcho=cookie;}),r=await f.invoke(),proof=JSON.parse(r.text).data.FileDownloadProof;
 assert.equal(proof.sha256,sha(bytes));assert.equal(f.calls,1);assert.equal(f.args[0],'portal-private-download');assert(f.request.deadlineAt>Date.now()&&f.request.deadlineAt<=Date.now()+25000);
 for(const text of [JSON.stringify(f.request),JSON.stringify(f.args),r.text])for(const secret of [cookie,csrf,'private.test','signed=sentinel'])assert(!text.includes(secret));
});
for(const [name,change]of [
 ['native failure with secret echo',a=>{a.ok=false;a.code='UNKNOWN';a.message=cookie;}],['foreign host',a=>{a.host='other.outsystems.dev';}],['foreign principal',a=>{a.user='other@example.test';}],
 ['missing proof',a=>{a.body={};}],['native body file',a=>{a.bodyFile='arbitrary';}],['wrong hash',a=>{a.body.data.FileDownloadProof.sha256='b'.repeat(64);}],
 ['wrong file id',a=>{a.body.data.FileDownloadProof.fileId=crypto.randomUUID();}],['wrong local path',a=>{a.body.data.FileDownloadProof.file='../other.bin';}],
 ['URL exposed flag',a=>{a.body.data.FileDownloadProof.signedUriExposed=true;}],['ingestion inferred',a=>{a.body.data.FileDownloadProof.ingestionVerified=true;}],
 ['persisted bytes modified',(_a,{file})=>{fs.writeFileSync(file,Buffer.alloc(bytes.length,1));}]
])test('private download refuses '+name,async t=>{const f=fixture(t,change);await assert.rejects(f.invoke(),e=>e.code==='KNOWLEDGE_DOWNLOAD_UNVERIFIED'&&!e.message.includes(cookie));assert.equal(f.calls,1);});
test('foreign route/query and non-POST refuse before native handoff',async t=>{
 const f=fixture(t);for(const [url,method]of [['https://other.test'+route,'POST'],['https://'+host+route+'?x=1','POST'],['https://'+host+'/other','POST'],['https://'+host+route,'GET']])await assert.rejects(f.sender(url,{method,body:{}},{cookie,csrf},f.expectedContent),e=>e.code==='KNOWLEDGE_DOWNLOAD_UNVERIFIED');assert.equal(f.calls,0);
});
test('native failure reports only fixed diagnostic stages and bounded HTTP status',async t=>{
 const f=fixture(t,a=>{a.ok=false;a.code='KNOWLEDGE_DOWNLOAD_UNVERIFIED';a.diagnosticStage='storage-url';a.storageUrlCheck='signature-expired';a.portalStatus=200;a.storageStatus=secretStatus();a.message=cookie;a.remoteUrl='https://private.test/?signed=secret';});
 function secretStatus(){return 'private-status';}
 await assert.rejects(f.invoke(),e=>{assert.deepEqual(e.details,{diagnosticStage:'storage-url',portalStatus:200,storageUrlCheck:'signature-expired'});assert(!JSON.stringify(e).includes(cookie));return e.code==='KNOWLEDGE_DOWNLOAD_UNVERIFIED';});
 const unknown=fixture(t,a=>{a.ok=false;a.code='KNOWLEDGE_DOWNLOAD_UNVERIFIED';a.diagnosticStage=cookie;a.storageUrlCheck=cookie;a.portalStatus=600;a.storageStatus=-1;});
 await assert.rejects(unknown.invoke(),e=>{assert.deepEqual(e.details,{});return true;});
});
test('native authentication failures keep typed codes without echoing private messages',async t=>{
 for(const code of ['PORTAL_AUTH_REQUIRED','PORTAL_ACCESS_DENIED']){const f=fixture(t,a=>{a.ok=false;a.code=code;a.message=cookie;a.status=code==='PORTAL_AUTH_REQUIRED'?401:403;});await assert.rejects(f.invoke(),e=>e.code===code&&!e.message.includes(cookie));}
});
test('broker sends only the typed source-list action over private handoff, never its generic transport',async()=>{
 const broker=new Odc3PortalBroker({origin:'https://'+host});broker.authenticated=true;await broker.jar.setCookie(cookie+'; Secure; Path=/',broker.origin);
 broker.metadata.resolve=async(module,view,action)=>{assert.equal(module,'knowledgebases');assert.equal(view,'DataSources.datasource');assert(action.endsWith('DataSources/datasource/ActionDataSourceFile_Download'));return{moduleVersion:'m',apiVersion:'a',action};};
 broker.action=()=>{throw Error('generic action forbidden');};let calls=0;
 const result=await broker.downloadKnowledgeFile({input:{inputParameters:{FileId:'owned-file'}},expectedContent:{sha256:'expected'},privateDownload:async(url,options,context,expected)=>{calls++;assert.equal(new URL(url).pathname,route);assert.equal(options.body.viewName,'DataSources.datasource');assert(context.cookie.includes('private-cookie-sentinel'));assert.equal(expected.sha256,'expected');return{status:200,text:JSON.stringify({data:{FileDownloadProof:{contentReadBackVerified:true}}})};}});
 assert.equal(calls,1);assert.equal(result.data.FileDownloadProof.contentReadBackVerified,true);assert.throws(()=>routeOf('knowledgeBases.downloadFile',false));
 broker.authenticated=false;await assert.rejects(broker.downloadKnowledgeFile({}),e=>e.code==='PORTAL_AUTH_REQUIRED');
});
