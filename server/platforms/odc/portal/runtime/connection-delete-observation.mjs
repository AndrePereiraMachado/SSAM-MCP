// Separate catalog absence from the native detail. A retained header is never
// silently converted into NotFound, even when all stage configurations are gone.
export function connectionDeleteObservation(after,listing,{connectionId,connectionName,providerId}){
 const listComplete=listing?.ok===true&&listing.truncated===false&&Array.isArray(listing.rows);
 const listAbsent=listComplete?!listing.rows.some(row=>[row.ConnectionId,row.Id].includes(connectionId)
  ||[row.Name,row.ConnectionName].includes(connectionName)):null;
 const detailNotFound=after?.ok===true&&after.data?.NotFound===true;
 const connection=after?.data?.Connection;
 const headerRetained=after?.ok===true&&after.data?.NotFound===false&&connection?.connectionId===connectionId
  &&connection.name===connectionName&&connection.providerId===providerId;
 return {absent:detailNotFound&&listAbsent===true,detailNotFound,listComplete,listAbsent,headerRetained,
  ...(headerRetained?{remainingStageCount:Array.isArray(connection.stageConfigurations)?connection.stageConfigurations.length:null}:{}),
  ...(!after?.ok?{detailError:after?.error}:{})};
}
