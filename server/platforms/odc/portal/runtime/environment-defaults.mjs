import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fingerprint,isUuid} from './write-journal.mjs';
import {fail} from './errors.mjs';
export const ENV_DEFAULTS_GET='asset-configurations-api-v1:get:/environments/{environmentKey}/default-system-configurations';
export const ENV_DEFAULTS_PATCH='asset-configurations-api-v1:patch:/environments/{environmentKey}/default-system-configurations';
const reject=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Environment defaults require exact public fields, current state and explicit environment authorization. Nothing was sent.');
export function environmentDefaultsState(result){
 const rows=result?.data?.systemConfigurations;
 if(!result?.ok||!Array.isArray(rows)||!rows.length||new Set(rows.map(x=>x.key)).size!==rows.length)reject();
 return rows.map(r=>{
  if(typeof r.key!=='string'||!r.key||typeof r.isSecret!=='boolean'||typeof r.dataType!=='string')reject();
  const row={key:r.key,dataType:r.dataType,isSecret:r.isSecret,valueOrigin:r.valueOrigin??null};
  if(!r.isSecret){
   if(!['EnvironmentLevelDefault','EnvironmentLevelOverride'].includes(r.valueOrigin)||!Object.hasOwn(r,'value')||!Object.hasOwn(r,'defaultValue'))reject();
   row.value=r.value;row.defaultValue=r.defaultValue;
  }
  return row;
 }).sort((a,b)=>a.key.localeCompare(b.key));
}
export function environmentDefaultsPlan({result,environmentKey,body}){
 if(!isUuid(environmentKey)||!body||Object.keys(body).length!==1||!Array.isArray(body.systemConfigurations)||!body.systemConfigurations.length)reject();
 const before=environmentDefaultsState(result),after=structuredClone(before),restore=[];
 const keys=new Set();
 for(const change of body.systemConfigurations){
  if(!change||Object.keys(change).length!==2||!Object.hasOwn(change,'key')||!Object.hasOwn(change,'value')||keys.has(change.key))reject();
  keys.add(change.key);const current=before.find(r=>r.key===change.key),next=after.find(r=>r.key===change.key);
  if(!current||current.isSecret||!['Text','Integer','Boolean'].includes(current.dataType))reject();
  const v=change.value;
  if(v!==null&&(typeof v!=='string'||current.dataType==='Integer'&&!/^-?\d+$/.test(v)||current.dataType==='Boolean'&&!/^(true|false)$/i.test(v)))reject();
  next.value=v===null?current.defaultValue:v;next.valueOrigin=v===null?'EnvironmentLevelDefault':'EnvironmentLevelOverride';
  if(fingerprint(current)===fingerprint(next))reject();
  restore.push({key:current.key,value:current.valueOrigin==='EnvironmentLevelDefault'?null:current.value});
 }
 const plan={operationId:ENV_DEFAULTS_PATCH,path:{environmentKey},body:structuredClone(body),before,after,
  expectedConfigurationSha256:fingerprint(before),resultConfigurationSha256:fingerprint(after),
  restore:{body:{systemConfigurations:restore},expectedConfigurationSha256:fingerprint(after)}};
 return {...plan,planSha256:fingerprint(plan),sent:false,secretValuesVerified:false};
}
export async function environmentDefaultsApproval({file,words,host,operationId,input,read}){
 if(operationId!==ENV_DEFAULTS_PATCH||input.query||!input.path||Object.keys(input.path).length!==1)reject();
 const plan=environmentDefaultsPlan({result:await read(ENV_DEFAULTS_GET,input.path),environmentKey:input.path.environmentKey,body:input.body});
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,environmentKey:input.path.environmentKey,targets:[input.path.environmentKey],
  constraints:{expectedConfigurationSha256:plan.expectedConfigurationSha256,resultConfigurationSha256:plan.resultConfigurationSha256,bodySha256:fingerprint(input.body)}});
 if(!approval)reject();return {approval,expected:plan.after,before:plan.before};
}
export function environmentDefaultsObservation(expected,result){
 try{return {verified:fingerprint(environmentDefaultsState(result))===fingerprint(expected),secretValuesVerified:false,operationId:ENV_DEFAULTS_GET};}
 catch{return {verified:false,secretValuesVerified:false,operationId:ENV_DEFAULTS_GET};}
}
