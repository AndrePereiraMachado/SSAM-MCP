import {fail} from './errors.mjs';
import {fingerprint,isUuid} from './write-journal.mjs';
import {readCheckpoint} from '../../facade/read-budget.mjs';
export const USER_APPLICATION_ROLES='user-access-management-api-v1:get:/users/{key}/application-roles';
const SOURCES=['Direct','GroupAssigned','GroupMapped'],PAGE_SIZE=100,MAX_PAGES=30;
const IDENTITY=['key','name','environmentKey','assetKey','externalKey','claim','portfolioKey'];
const bad=()=>fail('USER_ROLE_UNION_UNVERIFIED','Assignment-source union could not verify complete pages and consistent scoped identities. No partial result returned.');
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const compare=(a,b)=>a===b?0:a==null?-1:b==null?1:a<b?-1:1;
function identity(row){
 if(!row||IDENTITY.some(k=>!Object.hasOwn(row,k))||!['key','environmentKey','assetKey','externalKey','portfolioKey'].every(k=>isUuid(row[k]))
  ||row.name!==null&&typeof row.name!=='string'||row.claim!==null&&typeof row.claim!=='string')bad();
 return Object.fromEntries(IDENTITY.map(k=>[k,row[k]]));
}
function validateRow(row,source,query){
 const base=identity(row),groups=row.assignedGroups??[];
 if(!Object.hasOwn(row,'assignedGroups')||!Array.isArray(groups)||row.isDirectlyAssigned!==(source==='Direct'))bad();
 if(source==='Direct'&&groups.length||source!=='Direct'&&!groups.length)bad();
 const seen=new Set();for(const group of groups){
  if(!group||!isUuid(group.key)||group.name!==null&&typeof group.name!=='string'
   ||group.membershipType!==(source==='GroupAssigned'?'Assigned':'Mapped')||seen.has(group.key))bad();
  seen.add(group.key);
 }
 for(const [field,singular,plural]of [['assetKey','assetKey','assetKeys'],['environmentKey','environmentKey','environmentKeys'],['portfolioKey',null,'portfolioKeys'],['key',null,'applicationRoleKeys']]){
  if(singular&&query[singular]!==undefined&&row[field]!==query[singular]||query[plural]?.length&&!query[plural].includes(row[field]))bad();
 }
 if(query.groupKeys?.length&&!groups.some(g=>query.groupKeys.includes(g.key)))bad();
 if(query.nameContains!==undefined&&(typeof row.name!=='string'||!row.name.toLowerCase().includes(query.nameContains.toLowerCase())))bad();
 return{base,groups};
}

// The live API ignored earlier values in a repeated assignmentSources query.
// Fetch each selected source independently, prove complete native inventories,
// merge identities/flags, and paginate the resulting unique role set globally.
// Native one-source reads remain unchanged. This is an explicit projection,
// not a claim that the server supplied an atomic cross-source snapshot.
export async function readUserRoleUnion(operationId,input,send){
 const selected=input.query?.assignmentSources;
 if(operationId!==USER_APPLICATION_ROLES||!Array.isArray(selected)||selected.length<2)return send(input);
 if(selected.some(s=>!SOURCES.includes(s)))fail('INPUT_INVALID','Unknown application-role assignment source.');
 const sources=SOURCES.filter(s=>selected.includes(s)),query=input.query??{},limit=query.limit??100,offset=query.offset??0,sort=query.sort??'name';
 if(typeof sort!=='string')fail('INPUT_INVALID','Role union sort must be a documented string.');
 const descending=sort.startsWith('-'),field=descending?sort.slice(1):sort;
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||!['name','environmentKey','assetKey'].includes(field))
  fail('INPUT_INVALID','Role union requires limit1..100, nonnegative offset and documented name/environmentKey/assetKey sort.');
 if(sources.length===1)return send({...input,query:{...query,assignmentSources:sources}});
 let stopped=false,pages=0,firstError;const outcomes=await Promise.allSettled(sources.map(async source=>{
  const rows=[],keys=new Set();let total,position=0,first;
  while(true){
   readCheckpoint('assignment-source-union');if(stopped)bad();if(++pages>MAX_PAGES)fail('USER_ROLE_UNION_LIMIT','Assignment-source union exceeded its bounded native page budget; no partial result returned.',{maxNativePages:MAX_PAGES,complete:false});
   const result=await send({...input,query:{...query,assignmentSources:[source],limit:PAGE_SIZE,offset:position}});
   if(!result.ok){stopped=true;return{failed:result,source};}
   first??=result;const data=result.data,page=data?.page,batch=data?.results;
   if(!page||!Array.isArray(batch)||!Number.isSafeInteger(page.totalResults)||page.totalResults<0||page.offset!==position
    ||page.limit!==PAGE_SIZE||page.count!==batch.length||page.totalPages!==Math.ceil(page.totalResults/PAGE_SIZE)
    ||total!==undefined&&total!==page.totalResults)bad();
   total??=page.totalResults;
   if(batch.length!==Math.min(PAGE_SIZE,total-position))bad();
   for(const row of batch){validateRow(row,source,query);if(keys.has(row.key))bad();keys.add(row.key);rows.push(row);}
   position+=batch.length;const next=position<total?position:null;
   if(page.nextPageOffset!==next)bad();
   if(next===null)return{source,rows,total,first};
  }
 }).map(work=>work.catch(error=>{firstError??=error;stopped=true;throw error;})));
 const values=outcomes.filter(r=>r.status==='fulfilled').map(r=>r.value),failed=values.find(r=>r.failed);
 if(failed)return{...failed.failed,data:undefined,assignmentResolution:{complete:false,selectedSources:sources,failedSource:failed.source}};
 if(firstError)throw firstError;
 const roles=new Map(),groupNames=new Map();let nativeRows=0;
 for(const {source,rows}of values)for(const row of rows){
  nativeRows++;const {base,groups}=validateRow(row,source,query);let current=roles.get(row.key);
  if(current&&!same(current.base,base))bad();
  if(!current){current={base,isDirectlyAssigned:false,groups:new Map()};roles.set(row.key,current);}
  current.isDirectlyAssigned||=row.isDirectlyAssigned;
  for(const group of groups){
   if(groupNames.has(group.key)&&groupNames.get(group.key)!==group.name)bad();groupNames.set(group.key,group.name);
   const key=group.key+':'+group.membershipType;const previous=current.groups.get(key);if(previous&&!same(previous,group))bad();
   current.groups.set(key,{key:group.key,name:group.name,membershipType:group.membershipType});
  }
 }
 const all=[...roles.values()].map(r=>({...r.base,isDirectlyAssigned:r.isDirectlyAssigned,
  assignedGroups:[...r.groups.values()].sort((a,b)=>compare(a.key,b.key)||compare(a.membershipType,b.membershipType))}));
 all.sort((a,b)=>(descending?-1:1)*compare(a[field],b[field])||compare(a.key,b.key));
 const results=all.slice(offset,offset+limit),first=values[0].first;
 return{...first,data:{...first.data,results,page:{count:results.length,limit,offset,totalResults:all.length,totalPages:Math.ceil(all.length/limit),nextPageOffset:offset+results.length<all.length?offset+results.length:null}},
  assignmentResolution:{source:'verified-assignment-source-union',complete:true,selectedSources:sources,nativePages:pages,nativeRows,uniqueRoles:all.length,duplicatesMerged:nativeRows-all.length,
   sourceTotals:Object.fromEntries(values.map(v=>[v.source,v.total])),globalPagination:true,ordering:'ordinal-UTF16; key ascending tie-break',atomicSnapshotVerified:false}};
}
