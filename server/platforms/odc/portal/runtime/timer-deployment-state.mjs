import {isUuid} from './write-journal.mjs';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const text=x=>typeof x==='string'&&x.trim().length>0;
function validDate(value){
 if(typeof value!=='string')return false;
 const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!m||!Number.isFinite(Date.parse(value)))return false;
 const [year,month,day,hour,minute,second]=m.slice(1).map(Number),leap=year%4===0&&(year%100!==0||year%400===0);
 return year>1900&&month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]&&hour<=23&&minute<=59&&second<=59;
}
const unknown=(target,reason)=>({state:'unknown',scope:'selected-application-and-stage',target,reason,atomicityProven:false});
export async function readTimerDeployment(input,native,{asset,deployments,revision}){
 const v=input?.screenVariables,target={applicationKey:v?.appid,environmentKey:v?.stageid};
 const bad=reason=>unknown(target,reason);
 if(!Object.values(target).every(isUuid))return bad('exact_application_and_stage_required');
 if(v.SelectedStage&&!same(v.SelectedStage.Key,target.environmentKey))return bad('selected_stage_mismatch');
 try{
  const current=await asset({assetKey:target.applicationKey}),app=current?.data;
  if(!current?.ok||!same(app?.assetKey,target.applicationKey)||!isUuid(app.portfolioKey))return bad('asset_portfolio_unverified');
  const query={portfolioKey:app.portfolioKey,environmentKey:target.environmentKey,key:target.applicationKey,limit:100,offset:0};
  const response=await deployments(query),data=response?.data,p=data?.page,rows=data?.results;
  if(!response?.ok||!Array.isArray(rows)||rows.length!==1||p?.totalResults!==1||p.count!==1||p.offset!==0||p.nextPageOffset!==null)return bad('deployment_page_unverified');
  const row=rows[0],items=row.deployments;
  if(!same(row.key,target.applicationKey)||!Array.isArray(items)||items.length!==1)return bad('deployment_identity_unverified');
  const d=items[0];
  if(!same(d.environmentKey,target.environmentKey)||!same(d.portfolioKey,app.portfolioKey)||!text(d.name)
   ||!Number.isSafeInteger(d.revision)||d.revision<1||!isUuid(d.buildKey)||!isUuid(d.deploymentKey)
   ||!validDate(d.deploymentDateTime))return bad('deployment_metadata_unverified');
  const nativeRows=native?.DeployedAppVersion?.List,nativeItems=nativeRows?.[0]?.Deployments?.List;
  if(nativeRows?.length!==1||nativeItems?.length!==1||nativeItems[0].Revision!==d.revision||native.AssetRevision?.Name!==d.name)return bad('public_native_disagreement');
  const exact=await revision({assetKey:target.applicationKey,revisionNumber:d.revision});
  if(!exact?.ok||!same(exact.data?.assetKey,target.applicationKey)||exact.data.revision!==d.revision||exact.data.name!==d.name)return bad('deployed_revision_unverified');
  return{state:'verified',scope:'selected-application-and-stage',target,atomicityProven:false,
   source:'public-deployment-metadata-with-native-revision-and-name-crosscheck',
   deployment:{applicationKey:row.key,environmentKey:d.environmentKey,portfolioKey:d.portfolioKey,name:d.name,revision:d.revision,
    buildKey:d.buildKey,deploymentKey:d.deploymentKey,deployedAt:d.deploymentDateTime,deployedBy:d.deploymentUserId??null,url:d.url??null},
   limitation:'Native placeholder fields are preserved in data and are not deployment metadata. This proves observed metadata, not browser interaction or an atomic snapshot.'};
 }catch(error){return{...bad('comparison_unavailable'),causeCode:error?.code??'UNCLASSIFIED'};}
}
