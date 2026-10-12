import {fingerprint} from './write-journal.mjs';

// A failed test may leave a provisional connection with no generated asset.
// Absence of one asset alone is insufficient: require never-generated metadata,
// zero public elements, and an unchanged native connection as well.
export async function readA2aProvisionalState(connection,read,readAsset){
 const refused={verified:false};
 if(connection?.providerId!=='a2a'||connection.externalMetadata?.selectedObjectCount!==0
  ||connection.externalMetadata?.selectedActionCount!==0||!connection.updatedOn)return refused;
 const screenVariables={ConnectionId:connection.connectionId,_connectionIdInDataFetchStatus:1,Source:'',_sourceInDataFetchStatus:1,
  ForceRefreshFail:false,_forceRefreshFailInDataFetchStatus:1,ForceSupportBoth:false,_forceSupportBothInDataFetchStatus:1};
 const result=await read('connections.connection',{screenVariables}),data=result?.data;
 if(!result?.ok||result.truncated===true||data?.NotFound!==false||data.Name!==connection.name||data.ProviderId!=='a2a'
  ||data.PortfolioKey!==connection.portfolioKey||data.ConnectionUpdateTimestamp!==connection.updatedOn
  ||data.IsRefreshingMetadata!==false||data.IsError!==false||data.LastSuccessfulMetadataUpdateTimestamp!=='1900-01-01T00:00:00')return refused;
 const asset=await readAsset(connection.connectionId);
 if(asset?.status!==404||asset.data?.errorCode!=='OS-APPS-40401')return refused;
 const after=await read('connections.detail',{connectionId:connection.connectionId,providerId:'a2a'});
 if(!after?.ok||after.truncated===true||after.data?.NotFound!==false||fingerprint(after.data.Connection)!==fingerprint(connection))return refused;
 return {verified:true,connectionId:connection.connectionId,stateSha256:fingerprint(connection),neverGenerated:true,assetAbsent:true,atomic:false};
}

// Inspect the documented auto-generated action, not arbitrary imports. The
// connection is reread after the metadata so a changed version/count cannot
// inherit the earlier approval. This is observational, not an atomic lock.
export async function readA2aCleanupMetadata(connection,read){
 const refused={verified:false};
 if(connection?.providerId!=='a2a'||connection.externalMetadata?.selectedObjectCount!==0
  ||connection.externalMetadata?.selectedActionCount!==1||!connection.updatedOn)return refused;
 const screenVariables={ConnectionId:connection.connectionId,_connectionIdInDataFetchStatus:1,Source:'',_sourceInDataFetchStatus:1,
  ForceRefreshFail:false,_forceRefreshFailInDataFetchStatus:1,ForceSupportBoth:false,_forceSupportBothInDataFetchStatus:1};
 const result=await read('connections.selectedActions',{screenVariables});
 const actions=Array.isArray(result?.data?.ActionList)?result.data.ActionList:result?.data?.ActionList?.List;
 if(!result?.ok||result.truncated===true||result.data?.ErrorMessage||!Array.isArray(actions)||actions.length!==1)return refused;
 const action=actions[0];
 if(action?.Name!=='SendMessage'||action?.OriginalName!=='SendMessage'||action.IsNotSupported!==false)return refused;
 const after=await read('connections.detail',{connectionId:connection.connectionId,providerId:'a2a'});
 if(!after?.ok||after.truncated===true||after.data?.NotFound!==false||fingerprint(after.data.Connection)!==fingerprint(connection))return refused;
 return {verified:true,connectionId:connection.connectionId,stateSha256:fingerprint(connection),actions:['SendMessage'],atomic:false};
}
