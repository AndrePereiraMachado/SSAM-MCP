import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {nativeMobileBuildApproval,NATIVE_MOBILE_BUILD} from '../runtime/native-mobile-build-approval.mjs';
import {mobileConfigurationHash,mobileConfigurationStateHash} from '../runtime/mobile-configuration-approval.mjs';
import {ASSET_CREATE} from '../runtime/asset-creation-approval.mjs';
function fixture(t,platform='Android'){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-mobile-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const proposal=path.join(dir,'proposal.md'),file=path.join(dir,'approval.json');fs.writeFileSync(proposal,'Synthetic native build proposal');
 const host='fixture.outsystems.dev',words='Synthetic approval',source={kind:'human-conversation',threadId:crypto.randomUUID(),messageId:crypto.randomUUID(),question:'Synthetic test'};
 const b={applicationKey:crypto.randomUUID(),buildKey:crypto.randomUUID(),environmentKey:crypto.randomUUID(),revision:1,mobilePlatform:platform,mobileVersionNumber:'0.1.0',mobileVersionCode:1};
 const config={buildType:{isSecret:false,value:platform==='Android'?'Debug':'Simulator'},appIdentifier:{isSecret:false,value:'com.ssam.fixture'}};
 const originOperationUuid=crypto.randomUUID(),origin={state:'confirmed',identity:{tenant:host,operationId:ASSET_CREATE},response:{assetKey:b.applicationKey},authorization:{source}};
 const record={schema:'ssam-authorization-context/1',decision:'approved',words,source,proposal:{file:proposal,sha256:mobileConfigurationHash(null)},scope:[{lane:'odc',host,operation:NATIVE_MOBILE_BUILD,targets:['Fixture'],environmentKey:b.environmentKey}],constraints:{originOperationUuid,bodySha256:mobileConfigurationHash(b),expectedConfigurationSha256:mobileConfigurationStateHash(config)}};
 record.proposal.sha256=crypto.createHash('sha256').update(fs.readFileSync(proposal)).digest('hex');fs.writeFileSync(file,JSON.stringify(record));
 const reads=[];const read=async(id,args)=>{reads.push({id,args});if(id.startsWith('asset-repository'))return{ok:true,data:{assetKey:b.applicationKey,assetType:'MobileApplication',name:'Fixture'}};
  if(id.startsWith('build-operations-api'))return{ok:true,data:{buildKey:b.buildKey,assetKey:b.applicationKey,assetRevision:1,status:'Finished'}};
  if(id.endsWith('native-build-validation'))return{ok:true,data:{platformResults:{[platform]:'NativeBuildNeeded'}}};return{ok:true,data:config};};
 return{base:{file,words,host,input:{body:b},originOperationUuid,lookup:()=>origin,read},b,config,origin,reads,read};
}
test('native mobile approval binds each platform, finished revision, stage and configuration before readiness',async t=>{
 for(const platform of ['Android','iOS']){const f=fixture(t,platform);assert.deepEqual((await nativeMobileBuildApproval(f.base)).targets,['Fixture']);assert.equal(f.reads.length,4);assert.deepEqual(f.reads.at(-1).args.body,{applicationKey:f.b.applicationKey,buildKey:f.b.buildKey,environmentKey:f.b.environmentKey,revision:1,mobilePlatform:platform});}
});
test('native mobile build refuses foreign ownership, configuration drift and unfinished builds',async t=>{
 const f=fixture(t);for(const override of [{lookup:()=>({...f.origin,state:'uncertain'})},{input:{body:{...f.b,environmentKey:crypto.randomUUID()}}},
  {read:async(id,args)=>id.startsWith('build-operations-api')?{ok:true,data:{buildKey:f.b.buildKey,assetKey:f.b.applicationKey,assetRevision:1,status:'Running'}}:f.read(id,args)},
  {read:async(id,args)=>id.includes('/configurations/')?{ok:true,data:{...f.config,buildType:{isSecret:false,value:'Release'}}}:f.read(id,args)},
  {read:async(id,args)=>id.includes('/configurations/')?{ok:true,data:{...f.config,appIdentifier:{isSecret:false,value:'com.other'}}}:f.read(id,args)}])await assert.rejects(nativeMobileBuildApproval({...f.base,...override}));
});
test('native mobile build does not submit when validation is missing, not needed or unavailable',async t=>{
 const f=fixture(t);for(const value of ['MissingConfiguration','NativeBuildNotNeeded',undefined])await assert.rejects(nativeMobileBuildApproval({...f.base,read:async(id,args)=>id.endsWith('native-build-validation')?{ok:true,data:{platformResults:{Android:value}}}:f.read(id,args)}),e=>e.code==='NATIVE_BUILD_NOT_READY');
});
