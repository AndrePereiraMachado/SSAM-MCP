import {fail} from './errors.mjs';
import {isUuid,sha256,fingerprint} from './write-journal.mjs';
import {IP_FILTER_DELETE} from './ip-filter-approval.mjs';
export const IP_FILTER_INVENTORY='environment-configurations-api-v1:get:/environments/{environmentKey}/ip-filter-groups';
const bad=()=>fail('IP_FILTER_DELETE_UNVERIFIED','IP filter deletion requires original authorization and the complete inventory of its exact environment. Receipt unchanged.');
export function ipFilterDeleteScope(receipt,{state,read,authorize}){
 const target=receipt.identity?.target;
 if(receipt.identity?.kind!=='odc-public'||receipt.identity.operationId!==IP_FILTER_DELETE||!target
  ||!isUuid(target.environmentKey)||!isUuid(target.ipFilterGroupKey)
  ||state!=='confirmed'||typeof authorize!=='string'||sha256(authorize)!==receipt.authorization?.wordsSha256
  ||read?.tenant&&read.tenant!==receipt.identity.tenant||read?.operationId!==IP_FILTER_INVENTORY
  ||fingerprint(read.path)!==fingerprint({environmentKey:target.environmentKey})
  ||read.query!==undefined&&fingerprint(read.query)!==fingerprint({})||read.body!==undefined)bad();
 return{environmentKey:target.environmentKey,ipFilterGroupKey:target.ipFilterGroupKey};
}
// This API collection is unpaginated (results only). Never treat a detail 404,
// a different stage, malformed rows or a truncated/paged shape as absence.
export function ipFilterDeleteObservation(scope,result){
 if(!result?.ok||result.status!==200||!result.data||Object.keys(result.data).join(',')!=='results'
  ||!Array.isArray(result.data.results))bad();
 const keys=new Set();for(const row of result.data.results){
  if(!row||row.key!=='default'&&!isUuid(row.key)||typeof row.name!=='string'||keys.has(row.key))bad();
  keys.add(row.key);
 }
 return{verified:!keys.has(scope.ipFilterGroupKey),operationId:IP_FILTER_INVENTORY,
  environmentKey:scope.environmentKey,ipFilterGroupKey:scope.ipFilterGroupKey,
  inventoryComplete:true,groupCount:keys.size,groupAbsent:!keys.has(scope.ipFilterGroupKey),
  dataSha256:sha256(result.data),configurationRestorationVerified:false};
}
