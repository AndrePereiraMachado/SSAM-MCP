import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fingerprint,isUuid} from './write-journal.mjs';
import {fail} from './errors.mjs';
export const STAGE_RENAME='portfolio-api-v2:patch:/environments/{environmentKey}';
export const STAGE_BATCH_RENAME='portfolio-api-v2:patch:/environments';
export const STAGES='portfolio-api-v2:get:/environments';
const reject=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Stage rename requires a complete visible stage inventory, exact target and approved name-only change. Nothing was sent.');
function rowsOf(inventory){
 const rows=inventory?.data?.results;
 if(!inventory?.ok||!Array.isArray(rows)||!rows.length||rows.some(r=>!isUuid(r.key)||!isUuid(r.portfolioKey)
   ||typeof r.name!=='string'||!Number.isInteger(r.order)||typeof r.purpose!=='string')
   ||new Set(rows.map(r=>r.key)).size!==rows.length)reject();
 return structuredClone(rows).sort((a,b)=>a.key.localeCompare(b.key));
}
export function stageRenamePlan({inventory,environmentKey,name}){
 const before=rowsOf(inventory),current=before.find(r=>r.key===environmentKey);
 if(!current||typeof name!=='string'||!name.trim()||name.length>50||name===current.name
  ||before.some(r=>r.key!==environmentKey&&r.portfolioKey===current.portfolioKey&&r.name.toLowerCase()===name.toLowerCase()))reject();
 const after=before.map(r=>r.key===environmentKey?{...r,name}:r);
 const plan={schema:'ssam-stage-rename/1',operationId:STAGE_RENAME,path:{environmentKey},body:{name},before,after,
  current,expectedConfigurationSha256:fingerprint(before),resultConfigurationSha256:fingerprint(after),
  restore:{path:{environmentKey},body:{name:current.name},expectedConfigurationSha256:fingerprint(after)}};
 return {ok:true,...plan,planSha256:fingerprint(plan),sent:false,liveVerified:false};
}
export async function stageRenameApproval({file,words,host,operationId,input,read}){
 const hasOrder=Object.hasOwn(input.body??{},'order')||Array.isArray(input.body?.environments)&&input.body.environments.some(r=>r&&Object.hasOwn(r,'order'));
 if(hasOrder)return stageOrderApproval({file,words,host,operationId,input,read});
 if(operationId===STAGE_BATCH_RENAME){
  if(input.path||input.query||!input.body||Object.keys(input.body).length!==1||!Object.hasOwn(input.body,'environments'))reject();
  const plan=stageBatchRenamePlan({inventory:await read(STAGES),updates:input.body.environments});
  const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,targets:plan.targets,
   constraints:{stageKeysSha256:fingerprint(plan.body.environments.map(r=>r.key).sort()),
    expectedConfigurationSha256:plan.expectedConfigurationSha256,bodySha256:fingerprint(input.body),resultConfigurationSha256:plan.resultConfigurationSha256}});
  if(!approval)reject();return {approval,expected:plan.after,before:plan.before};
 }
 if(operationId!==STAGE_RENAME||input.query||!input.path||Object.keys(input.path).length!==1
  ||!input.body||Object.keys(input.body).length!==1||!Object.hasOwn(input.body,'name'))reject();
 const plan=stageRenamePlan({inventory:await read(STAGES),environmentKey:input.path.environmentKey,name:input.body.name});
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,targets:[plan.current.name],
  environmentKey:input.path.environmentKey,constraints:{environmentKey:input.path.environmentKey,
   expectedConfigurationSha256:plan.expectedConfigurationSha256,bodySha256:fingerprint(input.body),resultConfigurationSha256:plan.resultConfigurationSha256}});
 if(!approval)reject();return {approval,expected:plan.after,before:plan.before};
}
// Development and Production anchor the ordering. Only intermediate stages
// move; full-inventory hashes protect unrelated fields and concurrent edits.
export function stageOrderPlan({inventory,updates,batch=true}){
 const before=rowsOf(inventory),bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Stage order requires exact intermediate-stage keys, unique orders between the current Development/Production anchors and an unchanged full inventory. Nothing was sent.');
 if(!Array.isArray(updates)||!updates.length||updates.length>before.length||!batch&&updates.length!==1
  ||updates.some(r=>!r||Array.isArray(r)||typeof r!=='object'||Object.keys(r).sort().join(',')!=='key,order'||!isUuid(r.key)||!Number.isSafeInteger(r.order)||r.order<-2147483648||r.order>2147483647)
  ||new Set(updates.map(r=>r.key)).size!==updates.length)bad();
 const byKey=new Map(updates.map(r=>[r.key,r.order]));
 if(!updates.some(update=>before.some(row=>row.key===update.key&&row.order!==update.order)))bad();
 for(const update of updates){const row=before.find(r=>r.key===update.key);if(!row)bad();if(row.order===update.order)continue;if(row.purpose!=='NonProduction')bad();
  const peers=before.filter(r=>r.portfolioKey===row.portfolioKey),dev=peers.filter(r=>r.purpose==='Development'),prod=peers.filter(r=>r.purpose==='Production');
  if(dev.length!==1||prod.length!==1||dev[0].order>=prod[0].order||update.order<=dev[0].order||update.order>=prod[0].order)bad();
 }
 const after=before.map(r=>byKey.has(r.key)?{...r,order:byKey.get(r.key)}:r);
 if(new Set(after.map(r=>r.portfolioKey+'|'+r.order)).size!==after.length)bad();
 const original=before.filter(r=>byKey.has(r.key)),body=batch?{environments:structuredClone(updates)}:{order:updates[0].order};
 const plan={schema:'ssam-stage-order/1',operationId:batch?STAGE_BATCH_RENAME:STAGE_RENAME,...(!batch?{path:{environmentKey:updates[0].key}}:{}),body,before,after,targets:original.map(r=>r.name),
  expectedConfigurationSha256:fingerprint(before),resultConfigurationSha256:fingerprint(after),
  restore:{...(!batch?{path:{environmentKey:updates[0].key}}:{}),body:batch?{environments:original.map(r=>({key:r.key,order:r.order}))}:{order:original[0].order},expectedConfigurationSha256:fingerprint(after)}};
 return {ok:true,...plan,planSha256:fingerprint(plan),sent:false,liveVerified:false};
}
async function stageOrderApproval({file,words,host,operationId,input,read}){
 const batch=operationId===STAGE_BATCH_RENAME;
 if(![STAGE_RENAME,STAGE_BATCH_RENAME].includes(operationId)||input.query||!input.body
  ||batch&&(input.path||Object.keys(input.body).join(',')!=='environments')
  ||!batch&&(!input.path||Object.keys(input.path).join(',')!=='environmentKey'||Object.keys(input.body).join(',')!=='order'))reject();
 const updates=batch?input.body.environments:[{key:input.path.environmentKey,order:input.body.order}],plan=stageOrderPlan({inventory:await read(STAGES),updates,batch});
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,...(!batch?{environmentKey:updates[0].key}:{}),targets:plan.targets,
  constraints:{...(batch?{stageKeysSha256:fingerprint(updates.map(r=>r.key).sort())}:{environmentKey:updates[0].key}),expectedConfigurationSha256:plan.expectedConfigurationSha256,bodySha256:fingerprint(input.body),resultConfigurationSha256:plan.resultConfigurationSha256}});
 if(!approval)reject();return{approval,expected:plan.after,before:plan.before};
}
export function stageBatchRenamePlan({inventory,updates}){
 const before=rowsOf(inventory);
 if(!Array.isArray(updates)||!updates.length||updates.length>before.length
  ||updates.some(r=>!r||typeof r!=='object'||Object.keys(r).length!==2||!isUuid(r.key)
    ||typeof r.name!=='string'||!r.name.trim()||r.name.length>50)
  ||new Set(updates.map(r=>r.key)).size!==updates.length)reject();
 const byKey=new Map(updates.map(r=>[r.key,r.name]));
 if(updates.some(r=>!before.some(old=>old.key===r.key&&old.name!==r.name)))reject();
 const after=before.map(r=>byKey.has(r.key)?{...r,name:byKey.get(r.key)}:r);
 if(new Set(after.map(r=>r.portfolioKey+'|'+r.name.toLowerCase())).size!==after.length)reject();
 const original=before.filter(r=>byKey.has(r.key));
 const plan={schema:'ssam-stage-batch-rename/1',operationId:STAGE_BATCH_RENAME,body:{environments:structuredClone(updates)},
  before,after,targets:original.map(r=>r.name),expectedConfigurationSha256:fingerprint(before),resultConfigurationSha256:fingerprint(after),
  restore:{body:{environments:original.map(r=>({key:r.key,name:r.name}))},expectedConfigurationSha256:fingerprint(after)}};
 return {ok:true,...plan,planSha256:fingerprint(plan),sent:false,liveVerified:false};
}
export function stageRenameObservation(expected,result){
 let rows;try{rows=rowsOf(result);}catch{return {verified:false,operationId:STAGES,complete:false};}
 return {verified:Array.isArray(expected)&&fingerprint(rows)===fingerprint(expected),operationId:STAGES,complete:true};
}
