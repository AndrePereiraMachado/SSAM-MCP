import {authorizationContext} from '../../facade/authorization-context.mjs';
import {ipFilterHash as hash} from './ip-filter-approval.mjs';
import {fail} from './errors.mjs';
const root='user-access-management-api-v1:',collection='/organization-roles';
export const ORG_ROLE_CREATE=root+'post:'+collection,ORG_ROLE_PATCH=root+'patch:'+collection+'/{key}',ORG_ROLE_DELETE=root+'delete:'+collection+'/{key}';
export const ORG_ROLE_WRITES=new Set([ORG_ROLE_CREATE,ORG_ROLE_PATCH,ORG_ROLE_DELETE]);
export async function organizationRoleApproval({file,words,host,operationId,input,originOperationUuid,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Role approval requires an agent-created role, no assigned users, exact current configuration, and empty permissions before deletion. Nothing was sent.');
 const create=operationId===ORG_ROLE_CREATE,b=input.body,p=input.path??{};
 const permissionsPatch=operationId===ORG_ROLE_PATCH&&b&&Array.isArray(b.permissions)
  &&Object.keys(b).length===2&&typeof b.name==='string';
 if(!ORG_ROLE_WRITES.has(operationId)||input.query||Object.keys(p).some(k=>k!=='key')||(create&&Object.keys(p).length))bad();
 let name,origin,current;
 if(create){
  if(!b||typeof b.name!=='string'||!b.name.trim()||!Array.isArray(b.permissions)||b.permissions.length
    ||Object.keys(b).some(k=>!['name','permissions'].includes(k)))bad();
  name=b.name;
 }else{
  origin=lookup(originOperationUuid);
  if(typeof p.key!=='string'||!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
    ||origin.identity.operationId!==ORG_ROLE_CREATE||origin.response?.orgRoleKey!==p.key||!origin.authorization?.source)bad();
  name=origin.identity.target?.name;
  const seen=await read(root+'get:'+collection+'/{key}',p);
  if(!seen.ok||seen.data?.key!==p.key)bad();current=seen.data;
  if(current.isReadOnly!==false||!Array.isArray(current.permissions)||(!permissionsPatch&&current.permissions.length))bad();
  const users=await read(root+'get:'+collection+'/{key}/users',p,{limit:1,offset:0});
  if(!users.ok||!Array.isArray(users.data?.results)||users.data.results.length||users.data.page?.totalResults!==0)bad();
  if(permissionsPatch){
   if(b.name!==current.name)bad();
   const keys=new Set(),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
   for(const item of b.permissions){
    if(!item||!uuid.test(item.permissionKey)||keys.has(item.permissionKey)||Object.keys(item).some(k=>!['permissionKey','environmentKeys','portfolioKeys'].includes(k)))bad();
    keys.add(item.permissionKey);
    const permission=await read(root+'get:/permissions/{key}',{key:item.permissionKey});
    if(!permission.ok||permission.data?.key!==item.permissionKey||!permission.data.allowedScopes?.includes('Organization'))bad();
    for(const [field,allowed] of [['environmentKeys','allowStages'],['portfolioKeys','allowPortfolios']]){
     if(item[field]!==undefined&&(!Array.isArray(item[field])||item[field].some(k=>typeof k!=='string'||!uuid.test(k))
      ||new Set(item[field]).size!==item[field].length||item[field].length&&!permission.data[allowed]))bad();
    }
   }
  }
  if(operationId===ORG_ROLE_PATCH&&!permissionsPatch&&(!b||Object.keys(b).length!==1||typeof b.name!=='string'||!b.name.trim()))bad();
  if(operationId===ORG_ROLE_DELETE&&b!==undefined)bad();
 }
 if(create||operationId===ORG_ROLE_PATCH&&!permissionsPatch){
  // The live filtered-empty response can have limit=0 and unknown total. Use a
  // complete unfiltered inventory; never treat that malformed page as absence.
  const list=await read(root+'get:'+collection,{}, {limit:100,offset:0,sort:'name'});
  if(!list.ok||!Array.isArray(list.data?.results)||list.data.page?.totalResults!==list.data.results.length
   ||list.data.results.some(r=>typeof r.name!=='string'||r.name.toLowerCase()===b.name.toLowerCase()&&r.key!==p.key))bad();
 }
 const constraints={bodySha256:hash(b??null),...(create?{}:{originOperationUuid,expectedConfigurationSha256:hash(current)})};
 const approval=authorizationContext(file,words,{lane:'odc',host,operation:operationId,targets:[name],constraints});
 if(!approval||origin&&(approval.source.threadId!==origin.authorization.source.threadId||approval.source.messageId!==origin.authorization.source.messageId))bad();
 return approval;
}
