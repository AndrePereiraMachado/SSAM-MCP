import {fail} from './errors.mjs';import {isUuid} from './write-journal.mjs';
export async function mobileExtensibilityReadInput(operationId,raw,read){
 const s=raw.screenVariables;
 if(!['appid','stageid','ActivePortfolioKey'].every(k=>isUuid(s?.[k]))
  ||Object.keys(raw.inputParameters??{}).length||Object.keys(raw.clientVariables??{}).length
  ||s.SelectedStage?.Key!==undefined&&s.SelectedStage.Key!==s.stageid
  ||s.SelectedStage?.PortfolioKey!==undefined&&s.SelectedStage.PortfolioKey!==s.ActivePortfolioKey)
  fail('INPUT_INVALID','Exact application, stage and portfolio UUIDs are required.');
 const vars={appid:s.appid,stageid:s.stageid,ActivePortfolioKey:s.ActivePortfolioKey,_appidInDataFetchStatus:1,_stageidInDataFetchStatus:1};
 if(operationId==='mobileExtensibility.stages')return {...raw,screenVariables:vars};
 if(operationId==='mobileExtensibility.setting'){
  if(!isUuid(s.id)||s.libraryid!==undefined&&s.libraryid!==''&&!isUuid(s.libraryid))fail('INPUT_INVALID','The exact setting UUID and optional library UUID are required.');
  Object.assign(vars,{id:s.id,libraryid:s.libraryid??'',_idInDataFetchStatus:1,_libraryidInDataFetchStatus:1});
 }
 const stages=await read('mobileExtensibility.stages',{screenVariables:vars});
 const matches=stages?.data?.EnvironmentsApplicationVersion?.List?.filter(x=>x.Environment?.Key===s.stageid);
 if(matches?.length!==1||matches[0].Environment.PortfolioKey!==s.ActivePortfolioKey||matches[0].Environment.Status!=='Ready')
  fail('MOBILE_BASELINE_UNVERIFIED','The exact current native stage must be available before reading revision or setting.');
 Object.assign(vars,{SelectedStage:matches[0].Environment,GetApplicationStages:{...stages.data,DataFetchStatus:1}});
 if(operationId==='mobileExtensibility.setting'){
  const revision=await read('mobileExtensibility.revision',{screenVariables:vars});
  if(!revision?.data?.AssetRevision||!revision.data.DeployedAppVersion)fail('MOBILE_BASELINE_UNVERIFIED','Native revision prerequisites are unavailable.');
  vars.GetLatestDeployedAppVersion={...revision.data,DataFetchStatus:1};
  // OnInitialize seeds this record before the native data action. The
  // libraryid URL parameter alone does not select a library server-side.
  if(vars.libraryid)vars.ScreenExtensibilitySettingInformationStructure={ExtensibilitySettingInfo:{IsFromLibrary:true,LibraryInfo:{Key:vars.libraryid,Revision:0,Name:''}}};
 }
 return {...raw,screenVariables:vars};
}
