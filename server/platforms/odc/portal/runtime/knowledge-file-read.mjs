import {isUuid} from './write-journal.mjs';
import {fail} from './errors.mjs';

// Screen state observed in KnowledgeBases.knowledgebase. stageid alone does
// not select the environment used by GetDataSources.
export function knowledgeBaseReadInput({knowledgeBaseId,environmentKey,portfolioKey}) {
  if(![knowledgeBaseId,environmentKey,portfolioKey].every(isUuid))
    fail('INPUT_INVALID','Knowledge base, environment and portfolio UUIDs are required.');
  return {screenVariables:{KnowledgeBaseId:knowledgeBaseId,_knowledgeBaseIdInDataFetchStatus:1,
    stageid:environmentKey,_stageidInDataFetchStatus:1,
    SelectedEnvironmentId:environmentKey,ActivePortfolioKey:portfolioKey}};
}

export function knowledgeFilePage(data,{offset=0}={}) {
  const rows=data?.Files?.List,total=Number(data?.TotalResults),limit=data?.MaxRecords;
  if(!Number.isSafeInteger(offset)||offset<0||!Array.isArray(rows)
      ||!((typeof data?.TotalResults==='string'&&/^(0|[1-9][0-9]*)$/.test(data.TotalResults))
        ||typeof data?.TotalResults==='number')
      ||!Number.isSafeInteger(total)||total<0||!Number.isSafeInteger(limit)||limit<1
      ||rows.length>limit||rows.length>Math.max(0,total-offset))
    fail('PORTAL_CONTRACT_CHANGED','File page counts are unavailable or inconsistent.');
  const ids=new Set();
  for(const row of rows){
    if(!isUuid(row?.FileId)||ids.has(row.FileId.toLowerCase())||typeof row.Filename!=='string'||!row.Filename)
      fail('PORTAL_CONTRACT_CHANGED','File page identities are invalid or duplicated.');
    ids.add(row.FileId.toLowerCase());
  }
  const next=offset+rows.length,more=next<total;
  if(more&&rows.length===0)fail('PORTAL_CONTRACT_CHANGED','File pagination made no progress.');
  return {rows,total,offset,limit,nextOffset:more?next:null,nextPageAvailable:more,
    complete:offset===0&&!more};
}

export function knowledgeFileDetailInput(expected,fileId){
 if(![expected?.knowledgeBaseId,expected?.dataSourceId,expected?.environmentKey,fileId].every(isUuid)
  ||expected.screenVariables?.SelectedStage?.Key!==expected.environmentKey)
  fail('INPUT_INVALID','File detail requires exact identities and the observed selected stage.');
 return {screenVariables:{KnowledgeBaseId:expected.knowledgeBaseId,_knowledgeBaseIdInDataFetchStatus:1,
  DataSourceId:expected.dataSourceId,_dataSourceIdInDataFetchStatus:1,
  StageId:expected.environmentKey,_stageIdInDataFetchStatus:1,Id:fileId,_idInDataFetchStatus:1,
  SelectedStage:structuredClone(expected.screenVariables.SelectedStage),ActivePortfolioKey:expected.screenVariables.ActivePortfolioKey}};
}
