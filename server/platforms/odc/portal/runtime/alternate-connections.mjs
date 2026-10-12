import {fail} from './errors.mjs';import {isUuid} from './write-journal.mjs';
export function alternateConnectionsInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['portfolioKey','offset','search'].includes(k))
  ||!isUuid(input.portfolioKey)||!Number.isInteger(input.offset??0)||(input.offset??0)<0||(input.offset??0)>10000
  ||typeof(input.search??'')!=='string'||(input.search??'').length>200||/[\u0000-\u001f]/.test(input.search??''))
  fail('INPUT_INVALID','The alternate connection console requires a portfolio UUID, offset 0..10000 and bounded search text.');
 return {inputParameters:{},clientVariables:{ConnectionListSearchValue:input.search??''},screenVariables:{portfolioid:input.portfolioKey,_portfolioidInDataFetchStatus:1,
  SearchKeyword:input.search??'',StartIndex:input.offset??0,Filter_Category:'',Filter_Exposes:'',Filter_Type:'',Filter_Vendor:'',SortAtribute:'LastUpdated',SortDirection:'DESC'}};
}
export function alternateConnectionsResult(input,data){
 alternateConnectionsInput(input);
 const rows=Array.isArray(data?.Connections)?data.Connections:data?.Connections?.List;
 const number=x=>/^[0-9]+$/.test(String(x))&&Number.isSafeInteger(Number(x))?Number(x):null;
 const total=number(data?.TotalResults),max=number(data?.MaxRecords),offset=input.offset??0;
 if(!Array.isArray(rows)||total===null||max===null||rows.length>total||rows.length>max||!rows.length&&offset<total)
  fail('PORTAL_CONTRACT_CHANGED','The alternate connection inventory has no verifiable collection or pagination.');
 const ids=new Set(),projected=rows.map(row=>{
  if(typeof row?.ConnectionId!=='string'||!row.ConnectionId||row.ConnectionId.length>200||typeof row.Name!=='string'||!row.Name||row.Name.length>500||ids.has(row.ConnectionId.toLowerCase()))
   fail('PORTAL_CONTRACT_CHANGED','The alternate connection inventory has a missing or duplicate identity.');
  ids.add(row.ConnectionId.toLowerCase());
  const out={ConnectionId:row.ConnectionId,Name:row.Name};
  for(const key of ['ConsoleProviderId','ProviderTypeId','ProviderTypeLabel','ProviderCategoryId','ProviderVendorId','OldProviderId','OldVariantid','LastUpdateDateTime','O11CloudResoucesStatus'])if(typeof row[key]==='string')out[key]=row[key];
  for(const key of ['HasElementSelection','IsMissingImportedElements','HasO11SetupError'])if(typeof row[key]==='boolean')out[key]=row[key];
  return out;
 });
 const next=offset+rows.length,truncated=next<total;
 return {rows:projected,totalResults:total,receivedCount:rows.length,offset,maxRecords:max,truncated,complete:!truncated,
  scope:'alternate-native-console; requested-portfolio-and-search',provisionalVisibilityVerified:false,
  ...(truncated?{nextOffset:next}: {})};
}
