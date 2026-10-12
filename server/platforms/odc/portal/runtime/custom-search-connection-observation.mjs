import {isUuid,fingerprint} from './write-journal.mjs';
import {CUSTOM_SEARCH_SAVE} from './custom-search-connection-approval.mjs';
export function customSearchConnectionObservation(receipt,result){
 const e=receipt?.reconciliation?.customSearchConnection,c=result?.data?.Connection;
 const base={verified:false,operationId:'connections.detail',connectionId:e?.connectionId??null};
 if(receipt?.identity?.operationId!==CUSTOM_SEARCH_SAVE||!isUuid(e?.connectionId)||!result?.ok||result.truncated===true
  ||result.data?.NotFound!==false||!c)return base;
 const h=e.details?.ConnectionDetails_Header,configs=e.details?.ConnectionDetail_StageConfig?.List;
 if(!h||configs?.length!==1||c.connectionId!==e.connectionId||c.providerId!=='customAISearch'
  ||c.name!==h.ConnectionName||c.description!==h.ConnectionDescription||c.portfolioKey!==h.PortfolioKey||c.stageConfigurations?.length!==1)return base;
 const wanted=configs[0],got=c.stageConfigurations[0];
 const verified=got.stageKey===wanted.TenantStage.Key&&got.customSearch?.endpointSha256===fingerprint(wanted.EndpointURL)
  &&got.customSearch?.headersEmpty===true&&got.customSearch?.headerNamesEmpty===true;
 return {...base,verified,stageKey:got.stageKey,configurationVerified:verified};
}
