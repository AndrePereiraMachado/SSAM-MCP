import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {mobileBinaryContent,mobileBinaryUploadApproval,binaryPatchProvenance,binaryDownloadUrl,MOBILE_FILE_UPLOAD} from '../runtime/mobile-binary-upload.mjs';
import {fingerprint} from '../runtime/write-journal.mjs';import {extensibilityStateHash,extensibilityChanges} from '../runtime/mobile-extensibility.mjs';
test('binary payloads require canonical nonempty Base64 within the explicit size bound',()=>{
 const value=Buffer.from('synthetic proof').toString('base64');assert.equal(mobileBinaryContent(value).byteLength,15);
 assert.equal(mobileBinaryContent(value).contentSha256,crypto.createHash('sha256').update('synthetic proof').digest('hex'));
 for(const x of ['',null,'YQ','YR==',' YQ==','data:text/plain;base64,YQ==',Buffer.alloc(1048577).toString('base64')])assert.throws(()=>mobileBinaryContent(x));
});
test('binary upload binds origin, stage flag, public setting, baseline and exact file before sending',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mobile-binary-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const host='proof.outsystems.dev',words='Own synthetic fixture',source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Own file proof'};
 const applicationKey=crypto.randomUUID(),environmentKey=crypto.randomUUID(),settingKey=crypto.randomUUID(),portfolioKey=crypto.randomUUID(),originOperationUuid=crypto.randomUUID();
 const raw={inputParameters:{FileContent:Buffer.from('fixture').toString('base64')},screenVariables:{},clientVariables:{}};
 let current={settings:[{key:settingKey,name:'File',dataType:'BinaryUrl',isSecret:false,value:null,defaultValue:null,valueOrigin:'Default'}],libraries:[]},flag=false,origin={state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:applicationKey},authorization:{source}};
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Own file upload');
 const constraints={originOperationUuid,applicationKey,environmentKey,settingKey,portfolioKey,inputSha256:fingerprint(raw.inputParameters),expectedConfigurationSha256:extensibilityStateHash(current),...mobileBinaryContent(raw.inputParameters.FileContent)};
 const record={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host,operation:MOBILE_FILE_UPLOAD,targets:['Fixture','File'],environmentKey}],constraints};fs.writeFileSync(file,JSON.stringify(record));
 const args={file,words,host,raw,lookup:()=>origin,read:async id=>({ok:true,data:id.startsWith('asset-')?{assetKey:applicationKey,name:'Fixture',assetType:'MobileApplication',portfolioKey}:current}),portalRead:async()=>({ok:true,data:{EnableNAOSBASE64Patch:flag,EnvironmentsApplicationVersion:{List:[{Environment:{Key:environmentKey,PortfolioKey:portfolioKey,Status:'Ready'}}]}}})};
 assert.equal((await mobileBinaryUploadApproval(args)).expected.contentSha256,constraints.contentSha256);
 flag=true;await assert.rejects(()=>mobileBinaryUploadApproval(args));flag=false;
 current.settings[0].isSecret=true;await assert.rejects(()=>mobileBinaryUploadApproval(args));current.settings[0].isSecret=false;
 current.settings[0].value='drift';await assert.rejects(()=>mobileBinaryUploadApproval(args));current.settings[0].value=null;
 await assert.rejects(()=>mobileBinaryUploadApproval({...args,raw:{...raw,inputParameters:{FileContent:Buffer.from('other').toString('base64')}}}));
 origin={...origin,response:{assetKey:crypto.randomUUID()}};await assert.rejects(()=>mobileBinaryUploadApproval(args));
});
test('binary patch refuses every external URL and permits an explicit empty reset',()=>{
 assert.equal(binaryDownloadUrl('https://proof.example/file?X-Amz-Signature=%5BREDACTED%5D'),null);
 assert.equal(binaryDownloadUrl('https://proof.example/file?sig=[REDACTED]'),null);
 const applicationKey=crypto.randomUUID(),environmentKey=crypto.randomUUID(),originOperationUuid=crypto.randomUUID(),key=crypto.randomUUID(),host='proof.outsystems.dev',id=crypto.randomUUID();
 const current={settings:[{key,dataType:'BinaryUrl',isSecret:false,value:null,defaultValue:null,valueOrigin:'Default'}]},url='https://proof.example/file';
 let upload={state:'confirmed',identity:{tenant:host,operationId:MOBILE_FILE_UPLOAD},response:{downloadUrl:url},reconciliation:{mobileBinaryUpload:{applicationKey,environmentKey,originOperationUuid,settingKey:key}}};
 const args={constraints:{mobileFileOperationUuid:id},body:{settings:[{key,value:url}]},current,lookup:()=>upload,host,applicationKey,environmentKey,originOperationUuid};
 assert.throws(()=>binaryPatchProvenance(args));assert.equal(extensibilityChanges(args.body,current),true);
 upload.state='uncertain';assert.throws(()=>binaryPatchProvenance(args));upload.state='confirmed';
 assert.throws(()=>binaryPatchProvenance({...args,body:{settings:[{key,value:'https://other.example/file'}]}}));
 assert.equal(binaryPatchProvenance({...args,body:{settings:[{key,value:null,metadata:null}]}}),true);
 assert.throws(()=>binaryPatchProvenance({...args,body:{settings:[{key,value:null,metadata:[{key:'name',value:'stale'}]}]}}));
});
test('library binary settings cannot bypass private upload/save via a public PATCH',()=>{
 const libraryKey=crypto.randomUUID(),settingKey=crypto.randomUUID(),current={settings:[],libraries:[{key:libraryKey,revision:2,settings:[{key:settingKey,dataType:'BinaryUrl',isSecret:false}]}]};
 const body=value=>({libraries:[{key:libraryKey,settings:[{key:settingKey,value,metadata:null}]}]});
 assert.throws(()=>binaryPatchProvenance({body:body('https://external.example.test/file'),current}));
 assert.equal(binaryPatchProvenance({body:body(null),current}),true);
 const stale=body(null);stale.libraries[0].settings[0].metadata=[{key:'name',value:'stale'}];assert.throws(()=>binaryPatchProvenance({body:stale,current}));
 const other=body(null);other.libraries[0].key=crypto.randomUUID();assert.throws(()=>binaryPatchProvenance({body:other,current}));
});
