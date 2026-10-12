import {isUuid} from './write-journal.mjs';
import {timerVariables} from './portal-timer.mjs';
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const unknown=(target,reason)=>({scope:'selected-timer',target,state:'unknown',savedNotDeployed:null,absenceProven:false,applicationWideAbsenceProven:false,atomicityProven:false,reason});
const readable=x=>typeof x==='string'&&x.trim().length>0&&!x.includes('[REDACTED]');

export function comparePendingTimer(data,info,target){
 const bad=reason=>unknown(target,reason);
 if(!Number.isInteger(data?.revisionDeployed)||data.revisionDeployed<1||data.revisionBaseline!==data.revisionDeployed)return bad('revision_unverified');
 const rows=data.timers?.filter(x=>same(x.key,target.timerKey)),timer=rows?.[0],native=info?.TimerInfo?.Timer;
 if(rows?.length!==1||!readable(timer.name)||!Array.isArray(timer.configs)||timer.configs.length!==3
   ||info?.NotFound!==false||!same(native?.Key,target.timerKey)||native.Name!==timer.name)return bad('timer_identity_unverified');
 const changes=[];
 for(const [key,type] of [['IsActive','Boolean'],['Schedule','Text'],['Timeout','Integer']]){
  const values=timer.configs.filter(x=>x.key===key),c=values[0],n=native.Configs?.[key];
  if(values.length!==1||c.dataType!==type||c.isSecret!==false||![c.value,c.deployedValue,c.valueOrigin,c.deployedValueOrigin].every(readable)||!n)return bad('timer_values_unverified');
  if(![c.valueOrigin,c.deployedValueOrigin].every(x=>['ApplicationLevelDefault','ApplicationLevelOverride'].includes(x))
    ||(key==='Timeout'&&![c.value,c.deployedValue].every(x=>/^\d+$/.test(x)&&Number.isSafeInteger(Number(x)))))return bad('timer_values_unverified');
  const current=key==='IsActive'?n.Current:n.Value,deployed=key==='IsActive'?n.Deployed:n.DeployedValue;
  const equal=(value,expected)=>key==='IsActive'?typeof value==='boolean'&&/^(True|False)$/i.test(expected)&&value===(expected.toLowerCase()==='true'):String(value)===expected;
  if(!equal(current,c.value)||!equal(deployed,c.deployedValue)||n.ValueOrigin!==c.valueOrigin||n.DeployedValueOrigin!==c.deployedValueOrigin)return bad('public_native_disagreement');
  const valueChanged=key==='IsActive'?c.value.toLowerCase()!==c.deployedValue.toLowerCase():c.value!==c.deployedValue;
  if(valueChanged||c.valueOrigin!==c.deployedValueOrigin)changes.push({key,savedValue:c.value,deployedValue:c.deployedValue,savedOrigin:c.valueOrigin,deployedOrigin:c.deployedValueOrigin});
 }
 return{scope:'selected-timer',target,timerName:timer.name,revision:data.revisionDeployed,state:changes.length?'pending':'none',
  savedNotDeployed:changes.length>0,absenceProven:changes.length===0,applicationWideAbsenceProven:false,atomicityProven:false,
  source:'matching-public-configurations-and-native-timer-info',nativeFlag:typeof info.TimerInfo.HasPendingConfigurations==='boolean'?info.TimerInfo.HasPendingConfigurations:null,changes};
}

export async function readPendingTimer(input,{configuration,application,portalRead}){
 const v=input?.screenVariables,target={environmentKey:v?.stageid,applicationKey:v?.appid,timerKey:v?.id};
 if(!Object.values(target).every(isUuid))return unknown(target,'exact_timer_scope_required');
 const vars=timerVariables({StageKey:target.environmentKey,ApplicationKey:target.applicationKey,TimerKey:target.timerKey});
 const read=()=>configuration({environmentKey:target.environmentKey,applicationKey:target.applicationKey});
 try{
  const first=await read();if(!first?.ok)return unknown(target,'public_configuration_unavailable');
  const revision=first.data?.revisionDeployed;
  if(!Number.isInteger(revision)||revision<1)return unknown(target,'revision_unverified');
  const app=await application({assetKey:target.applicationKey,revisionNumber:revision});
  if(!app?.ok||!same(app.data?.assetKey,target.applicationKey)||app.data.revision!==revision||!readable(app.data.name))return unknown(target,'application_identity_unverified');
  const info=await portalRead('timers.info',vars);if(!info?.ok)return unknown(target,'native_timer_info_unavailable');
  const result=comparePendingTimer(first.data,info.data,target);
  if(result.state==='unknown')return result;
  const last=await read();if(!last?.ok||JSON.stringify(last.data)!==JSON.stringify(first.data))return unknown(target,'configuration_changed_during_read');
  return {...result,applicationName:app.data.name};
 }catch(error){return {...unknown(target,'comparison_unavailable'),causeCode:typeof error?.code==='string'?error.code:'UNCLASSIFIED'};}
}
