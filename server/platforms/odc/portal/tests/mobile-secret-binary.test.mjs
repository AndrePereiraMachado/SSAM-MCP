import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {mobileBinaryUploadApproval,MOBILE_FILE_UPLOAD,MOBILE_FILE_CONVERT,mobileUploadObservation} from '../runtime/mobile-binary-upload.mjs';
import {mobileBinarySaveObservation} from '../runtime/mobile-binary-save.mjs';
import {extensibilityStateHash,extensibilityChanges,extensibilityExpectation,verifyExtensibility} from '../runtime/mobile-extensibility.mjs';import {fingerprint} from '../runtime/write-journal.mjs';
import {redact} from '../runtime/errors.mjs';
test('native secret flag and numeric upload limit remain typed while uppercase secret values are hidden',()=>{
 const r=redact({BinarySetting_Secret_MaxFileSize:64,Setting:{IsSecret:true,Value:'private-content',DefaultValue:'private-default',DeployedValue:'private-deployed'}});
 assert.equal(r.BinarySetting_Secret_MaxFileSize,64);assert.equal(r.Setting.IsSecret,true);for(const key of ['Value','DefaultValue','DeployedValue'])assert.equal(r.Setting[key],'[REDACTED]');
 assert.equal(redact({BinarySetting_Secret_MaxFileSize:'64'}).BinarySetting_Secret_MaxFileSize,'64');assert.equal(redact({BinarySetting_Secret_MaxFileSize:'5.8'}).BinarySetting_Secret_MaxFileSize,'5.8');
 assert.equal(redact({IsSecret:'private'}).IsSecret,'[REDACTED]');assert.equal(redact({BinarySetting_Secret_MaxFileSize:'private'}).BinarySetting_Secret_MaxFileSize,'[REDACTED]');assert.equal(redact({BinarySetting_Secret_MaxFileSize:{Value:'private'}}).BinarySetting_Secret_MaxFileSize,'[REDACTED]');
});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'secret-binary-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const host='proof.outsystems.dev',words='Own binary vault proof',source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Private binary'};
 const scope=Object.fromEntries(['applicationKey','environmentKey','settingKey','portfolioKey','originOperationUuid'].map(k=>[k,crypto.randomUUID()]));
 const raw={screenVariables:{},clientVariables:{},inputParameters:{FileContent:''}},refs=[{pointer:'/inputParameters/FileContent',target:'SSAM/ODC3/'+host+'/Setting/Proof',field:'password'}];
 const current={settings:[{key:scope.settingKey,name:'File',dataType:'BinaryUrl',isSecret:true,value:null,defaultValue:null,valueOrigin:'Default'}],libraries:[]};
 const constraints={...scope,isSecret:true,inputSha256:fingerprint(raw.inputParameters),expectedConfigurationSha256:extensibilityStateHash(current),secretRefsSha256:fingerprint(refs),contentSha256:'a'.repeat(64),byteLength:32};
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Own secret file proof');
 fs.writeFileSync(file,JSON.stringify({schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex')},scope:[{lane:'odc',host,operation:MOBILE_FILE_UPLOAD,environmentKey:scope.environmentKey,targets:['Fixture','File']}],constraints}));
 const native={ok:true,data:{NotFound:false,BinarySetting_Secret_MaxFileSize:64,ExtensibilitySettingInfo:{IsFromLibrary:false,Setting:{Key:scope.settingKey,IsSecret:true}}}};
 const stages={ok:true,data:{EnableNAOSBASE64Patch:false,EnvironmentsApplicationVersion:{List:[{Environment:{Key:scope.environmentKey,PortfolioKey:scope.portfolioKey,Status:'Ready'}}]}}};
 const args={host,words,file,raw,secretRefs:refs,lookup:()=>({state:'confirmed',identity:{tenant:host,operationId:'asset-repository-api-v1:post:/assets'},response:{assetKey:scope.applicationKey},authorization:{source}}),read:async id=>({ok:true,data:id.startsWith('asset-')?{assetKey:scope.applicationKey,name:'Fixture',assetType:'MobileApplication',portfolioKey:scope.portfolioKey}:current}),portalRead:async id=>id==='mobileExtensibility.setting'?native:stages};return {args,native,stages,current,scope,refs};
}
test('secret binary upload binds a vault reference and approved bytes without accepting secret input',async t=>{const f=fixture(t),p=await mobileBinaryUploadApproval(f.args);assert.equal(p.expected.isSecret,true);assert.equal(p.expected.byteLength,32);assert.equal(p.expected.secretRefsSha256,fingerprint(f.refs));});
test('secret native Base64 conversion binds its own operation, flag, vault pointer and exact content proof',async t=>{
 const f=fixture(t);f.stages.data.EnableNAOSBASE64Patch=true;f.args.operationId=MOBILE_FILE_CONVERT;
 f.args.raw.inputParameters={BinaryData:''};f.refs[0].pointer='/inputParameters/BinaryData';
 const record=JSON.parse(fs.readFileSync(f.args.file));record.scope[0].operation=MOBILE_FILE_CONVERT;
 Object.assign(record.constraints,{transportMode:'base64',inputSha256:fingerprint(f.args.raw.inputParameters),secretRefsSha256:fingerprint(f.refs)});fs.writeFileSync(f.args.file,JSON.stringify(record));
 const prepared=await mobileBinaryUploadApproval(f.args);assert.equal(prepared.expected.transportMode,'base64');assert.equal(prepared.expected.isSecret,true);
 const id=crypto.randomUUID(),proof={uploadOperationUuid:id,objectUri:'urn:ssam:mobile-base64:'+id,transportMode:'base64',contentSha256:prepared.expected.contentSha256,byteLength:32,contentVerified:true,signedUriExposed:false};
 assert.equal(mobileUploadObservation(prepared.expected,{UploadProof:proof},id).transportMode,'base64');
 for(const changed of [{objectUri:'https://untrusted.example/file'},{contentSha256:'b'.repeat(64)},{transportMode:'signed-upload'},{uploadOperationUuid:crypto.randomUUID()},{byteLength:33}])assert.equal(mobileUploadObservation(prepared.expected,{UploadProof:{...proof,...changed}},id),null);
 f.stages.data.EnableNAOSBASE64Patch=false;await assert.rejects(()=>mobileBinaryUploadApproval(f.args),e=>e.code==='MOBILE_BINARY_TRANSPORT_MISMATCH');
});
for(const variant of ['no-ref','wrong-pointer','wrong-kind','wrong-field','literal-content','native-limit','native-secret','native-setting','flag','changed-ref'])test('secret binary upload refuses '+variant,async t=>{const f=fixture(t);
 switch(variant){case'no-ref':f.args.secretRefs=[];break;case'wrong-pointer':f.refs[0].pointer='/inputParameters/Other';break;case'wrong-kind':f.refs[0].target=f.refs[0].target.replace('/Setting/','/DB/');break;case'wrong-field':f.refs[0].field='username';break;case'literal-content':f.args.raw.inputParameters.FileContent='YQ==';break;case'native-limit':f.native.data.BinarySetting_Secret_MaxFileSize=0.001;break;case'native-secret':f.native.data.ExtensibilitySettingInfo.Setting.IsSecret=false;break;case'native-setting':f.native.data.ExtensibilitySettingInfo.Setting.Key=crypto.randomUUID();break;case'flag':f.stages.data.EnableNAOSBASE64Patch=true;break;case'changed-ref':f.refs[0].target+='Changed';break;}
 await assert.rejects(()=>mobileBinaryUploadApproval(f.args),variant==='flag'?e=>e.code==='MOBILE_BINARY_TRANSPORT_MISMATCH':undefined);});
test('secret binary readback verifies only origin and identity, never hidden content',()=>{const key=crypto.randomUUID(),expected={settingKey:key,isSecret:true,objectUri:'https://proof.example/upload',contentSha256:'a'.repeat(64),byteLength:32};const pub={ok:true,data:{settings:[{key,dataType:'BinaryUrl',isSecret:true,valueOrigin:'Override',value:'[REDACTED]'}]}};
 const native={ok:true,data:{NotFound:false,ExtensibilitySettingInfo:{IsFromLibrary:false,Setting:{Key:key,DataType:'BinaryUrl',IsSecret:true,ValueOrigin:'Override',Value:'[REDACTED]'}}}};
 const p=mobileBinarySaveObservation(expected,pub,native);assert.equal(p.verified,true);assert.equal(p.valueVerified,false);assert.equal(p.persistedContentVerified,false);assert.equal(p.metadataVerified,false);pub.data.settings[0].valueOrigin='Default';assert.equal(mobileBinarySaveObservation(expected,pub,native).verified,false);});
test('secret binary supports explicit reset only; vault values cannot bypass native file save',()=>{const key=crypto.randomUUID(),current={settings:[{key,dataType:'BinaryUrl',isSecret:true,value:'[REDACTED]',defaultValue:null,valueOrigin:'Override'}]},body={settings:[{key,value:null,metadata:null}]};assert.equal(extensibilityChanges(body,current),true);
 assert.throws(()=>extensibilityChanges({settings:[{key,value:''}]},current,[{pointer:'/settings/0/value'}]));assert.throws(()=>extensibilityChanges({settings:[{key,value:null,metadata:[{key:'name',value:'stale'}]}]},current));
 const e=extensibilityExpectation(body,current),seen={ok:true,status:200,data:{settings:[{...current.settings[0],valueOrigin:'Default',metadata:[]}]}};assert.equal(verifyExtensibility(e,seen).verified,true);assert.equal(verifyExtensibility(e,seen).valueVerified,false);});
