import {fail} from './errors.mjs';
import {isUuid} from './write-journal.mjs';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
export function apiClientInventoryInput(raw){
 const s=raw.screenVariables;
 if(!exact(raw.inputParameters,'')||!exact(raw.clientVariables,'')||!exact(s,'StartIndex,MaxRecords,Filter')
  ||!Number.isSafeInteger(s.StartIndex)||s.StartIndex<0||s.StartIndex>1000000
  ||!Number.isSafeInteger(s.MaxRecords)||s.MaxRecords<1||s.MaxRecords>100
  ||!exact(s.Filter,'NameContains,Status')||typeof s.Filter.NameContains!=='string'||s.Filter.NameContains.length>200
  ||typeof s.Filter.Status!=='string'||s.Filter.Status.length>100
  ||/[\u0000-\u001f]/.test(s.Filter.NameContains+s.Filter.Status))
  fail('INPUT_INVALID','API Client inventory requires bounded StartIndex, MaxRecords and exact NameContains/Status filters.');
 return raw;
}
function page(raw,result){
 apiClientInventoryInput(raw);const data=result?.data,rows=data?.APIClientsList?.List,totalValue=data?.Pagination?.TotalResults;
 const total=typeof totalValue==='number'?totalValue:typeof totalValue==='string'&&/^\d+$/.test(totalValue)?Number(totalValue):NaN;
 const s=raw.screenVariables;
 if(result?.ok!==true||!Array.isArray(rows)||!Number.isSafeInteger(total)||total<0
  ||rows.length!==Math.min(s.MaxRecords,Math.max(0,total-s.StartIndex))
  ||rows.some(r=>!isUuid(r?.Key)||typeof r.Name!=='string'||!r.Name||r.Name.length>500))
  fail('API_CLIENT_INVENTORY_UNVERIFIED','API Client inventory does not match its requested page and total. No absence was proven.');
 return {rows,total};
}
// The live API honors requested StartIndex/MaxRecords but returns zero native
// counters. Never infer offsets or completion from Pagination.Limit/Offset.
export async function collectApiClientInventory({raw,result,maxPages,read}){
 apiClientInventoryInput(raw);
 if(!Number.isInteger(maxPages)||maxPages<1||maxPages>100)fail('INPUT_INVALID','maxPages must be 1..100.');
 const s=raw.screenVariables,first=page(raw,result),rows=[],ids=new Set();let current=first,pages=0,offset=s.StartIndex;
 for(;;){
  if(current.total!==first.total)fail('API_CLIENT_INVENTORY_UNVERIFIED','API Client total changed during pagination. No absence was proven.');
  for(const row of current.rows){const id=row.Key.toLowerCase();if(ids.has(id))fail('API_CLIENT_INVENTORY_UNVERIFIED','API Client pages repeated an identity. No absence was proven.');ids.add(id);rows.push(row);}
  pages++;offset+=current.rows.length;
  if(offset>=first.total||pages>=maxPages)break;
  const next={...raw,screenVariables:{...s,StartIndex:offset}};
  current=page(next,await read(next));
 }
 const nextPageAvailable=offset<first.total;
 return {rows,count:rows.length,totalResults:first.total,pages,requestedOffset:s.StartIndex,requestedLimit:s.MaxRecords,
  scope:{NameContains:s.Filter.NameContains,Status:s.Filter.Status},complete:s.StartIndex===0&&!nextPageAvailable,
  nextPageAvailable,nativePaginationCountersVerified:false,requestedPageConsistencyVerified:true,
  configurationFieldsVerified:false,verificationScope:'api-client-identities-and-pagination',configurationOperation:'apiClients.detail',
  ...(nextPageAvailable?{nextInput:{...raw,screenVariables:{...s,StartIndex:offset}}}:{})};
}
export function apiClientInventoryComplete(inventory){
 return inventory?.ok===true&&inventory.complete===true
  &&inventory.requestedPageConsistencyVerified===true
  &&inventory.requestedOffset===0&&inventory.scope?.NameContains===''&&inventory.scope?.Status===''
  &&Array.isArray(inventory.rows)&&inventory.rows.length===inventory.totalResults
  &&new Set(inventory.rows.map(r=>typeof r?.Key==='string'?r.Key.toLowerCase():null)).size===inventory.rows.length
  &&inventory.rows.every(r=>isUuid(r?.Key)&&typeof r.Name==='string');
}
export function apiClientAbsent(expected,inventory){
 return isUuid(expected?.key)&&typeof expected.name==='string'&&apiClientInventoryComplete(inventory)
  &&inventory.rows.every(r=>r.Key.toLowerCase()!==expected.key.toLowerCase()&&r.Name!==expected.name);
}
