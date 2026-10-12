import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fingerprint,isUuid} from './write-journal.mjs';
import {fail} from './errors.mjs';
export const ORGANIZATION_GET='organization-api-v1:get:/organization';
export const ORGANIZATION_RENAME='organization-api-v1:patch:/organization';
const reject=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Organization rename requires the exact organization, name-only body and approved complete before/after state. Nothing was sent.');
function organizationState(result){
 const value=result?.data;
 if(!result?.ok||!value||Array.isArray(value)||!isUuid(value.id)||typeof value.name!=='string'||!value.name.trim())reject();
 return structuredClone(value);
}
export function organizationRenamePlan({result,name}){
 const before=organizationState(result);
 if(typeof name!=='string'||!name.trim()||name===before.name)reject();
 const after={...structuredClone(before),name},plan={schema:'ssam-organization-rename/1',operationId:ORGANIZATION_RENAME,
  body:{name},before,after,targets:[before.name],expectedConfigurationSha256:fingerprint(before),
  resultConfigurationSha256:fingerprint(after),restore:{body:{name:before.name},expectedConfigurationSha256:fingerprint(after)}};
 return {...plan,ok:true,planSha256:fingerprint(plan),sent:false,liveVerified:false};
}
export async function organizationRenameApproval({file,words,host,operationId,input,read}){
 if(operationId!==ORGANIZATION_RENAME||input.path||input.query||!input.body||Object.keys(input.body).join(',')!=='name')reject();
 const plan=organizationRenamePlan({result:await read(ORGANIZATION_GET),name:input.body.name});
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,targets:plan.targets,
  constraints:{organizationId:plan.before.id,expectedConfigurationSha256:plan.expectedConfigurationSha256,
   bodySha256:fingerprint(input.body),resultConfigurationSha256:plan.resultConfigurationSha256}});
 if(!approval)reject();return {approval,before:plan.before,expected:plan.after};
}
export function organizationRenameObservation(expected,result){
 try{return {verified:isUuid(expected?.id)&&fingerprint(organizationState(result))===fingerprint(expected),operationId:ORGANIZATION_GET,organizationId:expected?.id??null};}
 catch{return {verified:false,operationId:ORGANIZATION_GET,organizationId:expected?.id??null};}
}
