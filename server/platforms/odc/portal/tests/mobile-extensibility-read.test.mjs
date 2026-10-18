import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {mobileExtensibilityReadInput} from '../runtime/mobile-extensibility-read.mjs';
test('native mobile reads replace supplied prerequisites with freshly scoped stage and revision',async()=>{
 const raw={inputParameters:{},clientVariables:{},screenVariables:{appid:crypto.randomUUID(),stageid:crypto.randomUUID(),ActivePortfolioKey:crypto.randomUUID(),id:crypto.randomUUID(),GetLatestDeployedAppVersion:{fabricated:true}}};
 const calls=[],stage={Key:raw.screenVariables.stageid,PortfolioKey:raw.screenVariables.ActivePortfolioKey,Status:'Ready',Name:'Development'};let foreign=false;
 const read=async(id,input)=>{calls.push(id);if(id.endsWith('.stages'))return {data:{EnableNAOSBASE64Patch:false,EnvironmentsApplicationVersion:{List:[{Environment:foreign?{...stage,PortfolioKey:crypto.randomUUID()}:stage}]}}};assert.deepEqual(input.screenVariables.SelectedStage,stage);return {data:{AssetRevision:{Name:'Own'},DeployedAppVersion:{List:[]}}};};
 const result=await mobileExtensibilityReadInput('mobileExtensibility.setting',raw,read);
 assert.deepEqual(calls,['mobileExtensibility.stages','mobileExtensibility.revision']);assert.deepEqual(result.screenVariables.SelectedStage,stage);assert.equal(result.screenVariables.GetLatestDeployedAppVersion.fabricated,undefined);assert.equal(result.screenVariables.GetLatestDeployedAppVersion.DataFetchStatus,1);
 foreign=true;await assert.rejects(()=>mobileExtensibilityReadInput('mobileExtensibility.setting',raw,read));
 await assert.rejects(()=>mobileExtensibilityReadInput('mobileExtensibility.setting',{...raw,screenVariables:{...raw.screenVariables,id:'invalid'}},read));
 await assert.rejects(()=>mobileExtensibilityReadInput('mobileExtensibility.revision',{...raw,screenVariables:{...raw.screenVariables,SelectedStage:{Key:crypto.randomUUID()}}},read));
});
test('library getter reproduces native initialization and replaces a forged structure',async()=>{
 const libraryid=crypto.randomUUID(),raw={inputParameters:{},clientVariables:{},screenVariables:{appid:crypto.randomUUID(),stageid:crypto.randomUUID(),ActivePortfolioKey:crypto.randomUUID(),id:crypto.randomUUID(),libraryid,ScreenExtensibilitySettingInformationStructure:{ExtensibilitySettingInfo:{IsFromLibrary:false,LibraryInfo:{Key:crypto.randomUUID(),Revision:999}}}}};
 const read=async id=>id.endsWith('.stages')?{data:{EnvironmentsApplicationVersion:{List:[{Environment:{Key:raw.screenVariables.stageid,PortfolioKey:raw.screenVariables.ActivePortfolioKey,Status:'Ready'}}]}}}:{data:{AssetRevision:{Revision:2},DeployedAppVersion:{Revision:2}}};
 const result=await mobileExtensibilityReadInput('mobileExtensibility.setting',raw,read);assert.deepEqual(result.screenVariables.ScreenExtensibilitySettingInformationStructure,{ExtensibilitySettingInfo:{IsFromLibrary:true,LibraryInfo:{Key:libraryid,Revision:0,Name:''}}});
 const app=await mobileExtensibilityReadInput('mobileExtensibility.setting',{...raw,screenVariables:{...raw.screenVariables,libraryid:''}},read);assert.equal(app.screenVariables.ScreenExtensibilitySettingInformationStructure,undefined);
});
