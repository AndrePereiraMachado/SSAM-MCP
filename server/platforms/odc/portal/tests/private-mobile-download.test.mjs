import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {privateMobileDownloader,MOBILE_FILE_DOWNLOAD_PATH as route} from '../runtime/private-mobile-download.mjs';
import {Odc3PortalBroker} from '../runtime/odc3-context.mjs';import {routeOf} from '../runtime/portal-routes.mjs';
const host='personal-test.outsystems.dev',principal='user@example.test',cookie='session=private-cookie-sentinel',csrf='private-csrf-sentinel',bytes=Buffer.from('own persisted proof\n'),sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function fixture(t,change=()=>{},library=false){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'private-mobile-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const requests=path.join(dir,'requests'),downloads=path.join(dir,'downloads');fs.mkdirSync(requests);fs.mkdirSync(downloads);
 let request,calls=0;const expectedContent={settingName:'OwnFile',filename:'proof.txt',filetype:'txt',byteLength:bytes.length,sha256:sha(bytes),uploadObjectUri:'https://plat-test.s3.eu-west-1.amazonaws.com/tenants/uploads/'+crypto.randomUUID()},vars={appid:crypto.randomUUID(),stageid:crypto.randomUUID(),id:crypto.randomUUID()};
 if(library){vars.libraryid=crypto.randomUUID();expectedContent.libraryRevision=2;}
 const sender=privateMobileDownloader({host,principal,requestFile:async value=>{request=value;const file=path.join(requests,'request.json');fs.writeFileSync(file,JSON.stringify(value));assert(!JSON.stringify(value).includes(cookie));return file;},handoff:async(context,invoke)=>{assert.equal(context.cookie,cookie);assert.equal(context.csrf,csrf);assert.equal(context.requestSha256,sha(JSON.stringify(request)));return invoke('pipe-id');},bridge:async args=>{
  calls++;assert.equal(args[0],'portal-private-download');const file=path.join(downloads,'mobile-file-'+request.downloadId+'.bin');fs.writeFileSync(file,bytes);
  const answer={ok:true,host,user:principal,status:200,body:{data:{FileDownloadProof:{downloadId:request.downloadId,applicationKey:vars.appid,environmentKey:vars.stageid,settingKey:vars.id,file,filename:'proof.txt',mimeType:'text/plain',byteLength:bytes.length,sha256:sha(bytes),contentReadBackVerified:true,persistedObjectVerified:true,signedUriExposed:false,unexpected:'private-value-sentinel',...(library?{libraryKey:vars.libraryid,libraryRevision:2}:{})}}}};change(answer,{file});return answer;
 }});
 return {sender,expectedContent,invoke:()=>sender('https://'+host+route,{method:'POST',body:{screenData:{variables:vars}}},{cookie,csrf},expectedContent),get calls(){return calls;}};
}
test('private persisted mobile read hashes the native artifact and returns only its scoped proof',async t=>{const f=fixture(t),r=await f.invoke();assert.equal(r.status,200);const proof=JSON.parse(r.text).data.FileDownloadProof;assert.equal(proof.sha256,sha(bytes));assert.equal(proof.persistedObjectVerified,true);assert.equal(proof.unexpected,undefined);assert(!r.text.includes(cookie));assert.equal(f.calls,1);});
test('private library proof preserves exact key and revision and refuses substituted scope',async t=>{
 const good=fixture(t,()=>{},true),result=JSON.parse((await good.invoke()).text).data.FileDownloadProof;assert.equal(result.libraryRevision,2);assert.match(result.libraryKey,/^[a-f0-9-]{36}$/);
 for(const prop of ['libraryKey','libraryRevision']){const f=fixture(t,a=>a.body.data.FileDownloadProof[prop]=prop==='libraryKey'?crypto.randomUUID():3,true);await assert.rejects(f.invoke(),e=>e.code==='MOBILE_DOWNLOAD_UNVERIFIED');}
 const app=fixture(t,a=>a.body.data.FileDownloadProof.libraryKey=crypto.randomUUID());await assert.rejects(app.invoke(),e=>e.code==='MOBILE_DOWNLOAD_UNVERIFIED');
});
for(const [name,change] of [['host',a=>{a.host='other.test';}],['principal',a=>{a.user='other@example.test';}],['setting',a=>{a.body.data.FileDownloadProof.settingKey=crypto.randomUUID();}],['hash',a=>{a.body.data.FileDownloadProof.sha256='a'.repeat(64);}],['path',a=>{a.body.data.FileDownloadProof.file='../other.bin';}],['URI flag',a=>{a.body.data.FileDownloadProof.signedUriExposed=true;}],['persisted flag',a=>{a.body.data.FileDownloadProof.persistedObjectVerified=false;}],['local bytes',(_a,{file})=>fs.writeFileSync(file,Buffer.alloc(bytes.length,1))]])test('private persisted read refuses changed '+name,async t=>{const f=fixture(t,change);await assert.rejects(f.invoke(),e=>e.code==='MOBILE_DOWNLOAD_UNVERIFIED');assert.equal(f.calls,1);});
test('foreign URL, query and generic proxy refuse before native handoff',async t=>{const f=fixture(t);for(const url of ['https://other.test'+route,'https://'+host+route+'?x=1','https://'+host+'/apps/screenservices/apps/Misc/UploadFile_BinarySetting/ActionRequest_SubmitGetRequest'])await assert.rejects(f.sender(url,{method:'POST',body:{}},{cookie,csrf},f.expectedContent),e=>e.code==='MOBILE_DOWNLOAD_UNVERIFIED');assert.equal(f.calls,0);});
test('native diagnostics are bounded and authentication codes permit only normal read recovery',async t=>{
 for(const status of [401,403]){const f=fixture(t,a=>Object.assign(a,{ok:false,diagnosticStage:'setting-request',portalStatus:status,message:cookie}));await assert.rejects(f.invoke(),e=>e.code===(status===401?'PORTAL_AUTH_REQUIRED':'PORTAL_ACCESS_DENIED')&&!e.message.includes(cookie));}
 const f=fixture(t,a=>Object.assign(a,{ok:false,diagnosticStage:'content-hash',portalStatus:200,remoteUrl:cookie,message:cookie}));await assert.rejects(f.invoke(),e=>{assert.deepEqual(e.details,{diagnosticStage:'content-hash',portalStatus:200});assert(!JSON.stringify(e).includes(cookie));return e.code==='MOBILE_DOWNLOAD_UNVERIFIED';});
});
test('native error code is exposed only as a bounded platform identifier',async t=>{
 for(const code of ['OS-BERT-00000',cookie]){
  const f=fixture(t,a=>Object.assign(a,{ok:false,diagnosticStage:'content-request',portalStatus:250,portalErrorCode:code,message:cookie}));
  await assert.rejects(f.invoke(),e=>{assert.equal(e.details.portalErrorCode,code==='OS-BERT-00000'?code:undefined);assert(!JSON.stringify(e).includes(cookie));return e.code==='MOBILE_DOWNLOAD_UNVERIFIED';});
 }
});
test('content diagnostics expose only a wire enum, bounded length and hash equality',async t=>{
 for(const valid of [true,false]){
  const f=fixture(t,a=>Object.assign(a,{ok:false,diagnosticStage:'content-mime',portalStatus:200,binaryWireKind:valid?'inline-string':cookie,observedByteLength:valid?bytes.length:1048577,contentHashMatches:valid?true:cookie,message:cookie}));
  await assert.rejects(f.invoke(),e=>{assert.equal(e.details.diagnosticStage,'content-mime');assert.equal(e.details.binaryWireKind,valid?'inline-string':undefined);assert.equal(e.details.observedByteLength,valid?bytes.length:undefined);assert.equal(e.details.contentHashMatches,valid?true:undefined);assert(!JSON.stringify(e).includes(cookie));return e.code==='MOBILE_DOWNLOAD_UNVERIFIED';});
 }
});
test('broker derives stage and revision before the fixed private getter; no arbitrary proxy is exposed',async()=>{
 const broker=new Odc3PortalBroker({origin:'https://'+host});broker.authenticated=true;await broker.jar.setCookie(cookie+'; Secure; Path=/',broker.origin);const appid=crypto.randomUUID(),stageid=crypto.randomUUID(),id=crypto.randomUUID(),ActivePortfolioKey=crypto.randomUUID();let prerequisites=0;
 broker.callScreenservice=async({operationId})=>{prerequisites++;return operationId==='mobileExtensibility.stages'?{data:{EnvironmentsApplicationVersion:{List:[{Environment:{Key:stageid,PortfolioKey:ActivePortfolioKey,Status:'Ready'}}]}}}:{data:{AssetRevision:{Revision:1},DeployedAppVersion:{Revision:1}}};};
 broker.metadata.resolve=async(module,view,action)=>{assert.equal(module,'apps');assert.equal(view,'ApplicationMobile.extensibillitysetting');return{moduleVersion:'m',apiVersion:'a',action};};broker.action=()=>{throw Error('Generic transport forbidden');};let reads=0;
 const r=await broker.downloadMobileFile({input:{screenVariables:{appid,stageid,id,ActivePortfolioKey,libraryid:''}},expectedContent:{sha256:'expected'},privateDownload:async(url,options,context,expected)=>{reads++;assert.equal(new URL(url).pathname,route);assert.equal(options.body.screenData.variables.SelectedStage.Key,stageid);assert(options.body.screenData.variables.GetLatestDeployedAppVersion);assert(context.cookie.includes('private-cookie-sentinel'));assert.equal(expected.sha256,'expected');return{status:200,text:JSON.stringify({data:{FileDownloadProof:{persistedObjectVerified:true}}})};}});
 assert.equal(prerequisites,2);assert.equal(reads,1);assert.equal(r.data.FileDownloadProof.persistedObjectVerified,true);assert.throws(()=>routeOf('mobileExtensibility.downloadFile',false));
 broker.authenticated=false;await assert.rejects(broker.downloadMobileFile({}),e=>e.code==='PORTAL_AUTH_REQUIRED');
});
