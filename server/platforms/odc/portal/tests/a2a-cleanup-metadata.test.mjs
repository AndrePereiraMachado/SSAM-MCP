import test from 'node:test';import assert from 'node:assert/strict';
import {readA2aCleanupMetadata,readA2aProvisionalState} from '../runtime/a2a-cleanup-metadata.mjs';
import {fingerprint} from '../runtime/write-journal.mjs';
test('provisional cleanup requires never-generated metadata, exact asset-not-found and unchanged native identity',async()=>{
 const connection={connectionId:'owned',name:'Own',portfolioKey:'portfolio',providerId:'a2a',updatedOn:'now',externalMetadata:{selectedObjectCount:0,selectedActionCount:0}};
 const metadata={ok:true,data:{NotFound:false,Name:'Own',PortfolioKey:'portfolio',ProviderId:'a2a',ConnectionUpdateTimestamp:'now',IsRefreshingMetadata:false,IsError:false,LastSuccessfulMetadataUpdateTimestamp:'1900-01-01T00:00:00'}};
 const missing={status:404,data:{errorCode:'OS-APPS-40401'}},after={ok:true,data:{NotFound:false,Connection:connection}};
 const run=(m=metadata,a=missing,d=after)=>readA2aProvisionalState(connection,async op=>op==='connections.connection'?m:d,async()=>a);
 assert.equal((await run()).verified,true);
 for(const mutate of [x=>x.ok=false,x=>x.truncated=true,x=>x.data.Name='other',x=>x.data.IsRefreshingMetadata=true,
  x=>x.data.LastSuccessfulMetadataUpdateTimestamp='2026-10-09T20:00:00',x=>x.data.ConnectionUpdateTimestamp='later']){
  const changed=structuredClone(metadata);mutate(changed);assert.equal((await run(changed)).verified,false);
 }
 for(const value of [{status:403}, {status:404,data:{errorCode:'OTHER'}},{status:200,data:{}}])assert.equal((await run(metadata,value)).verified,false);
 assert.equal((await run(metadata,missing,{...after,data:{...after.data,Connection:{...connection,updatedOn:'later'}}})).verified,false);
});
test('A2A cleanup accepts only the single unchanged native SendMessage action',async()=>{
 const connection={connectionId:'owned',providerId:'a2a',updatedOn:'2026-10-09T20:00:00Z',externalMetadata:{selectedObjectCount:0,selectedActionCount:1}};
 const action={Name:'SendMessage',OriginalName:'SendMessage',IsNotSupported:false};
 const selected={ok:true,data:{ActionList:{List:[action]}}},after={ok:true,data:{NotFound:false,Connection:connection}};
 const calls=[];const read=async(op,input)=>{calls.push({op,input});return op==='connections.selectedActions'?selected:after;};
 const result=await readA2aCleanupMetadata(connection,read);
 assert.equal(result.verified,true);assert.equal(result.stateSha256,fingerprint(connection));assert.deepEqual(result.actions,['SendMessage']);
 assert.equal(calls[0].input.screenVariables.ConnectionId,'owned');assert.equal(calls[1].input.providerId,'a2a');
 for(const change of [x=>x.ok=false,x=>x.truncated=true,x=>x.data.ErrorMessage='private failure',x=>x.data.ActionList.List=[],
  x=>x.data.ActionList.List.push(action),x=>x.data.ActionList.List[0].Name='Other',x=>x.data.ActionList.List[0].OriginalName='Other',
  x=>x.data.ActionList.List[0].IsNotSupported=true,x=>delete x.data.ActionList.List[0].IsNotSupported]){
  const bad=structuredClone(selected);change(bad);assert.equal((await readA2aCleanupMetadata(connection,async op=>op==='connections.selectedActions'?bad:after)).verified,false);
 }
 for(const change of [x=>x.ok=false,x=>x.truncated=true,x=>x.data.NotFound=true,x=>x.data.Connection.updatedOn='later',
  x=>x.data.Connection.externalMetadata.selectedActionCount=2,x=>x.data.Connection.connectionId='foreign']){
  const bad=structuredClone(after);change(bad);assert.equal((await readA2aCleanupMetadata(connection,async op=>op==='connections.selectedActions'?selected:bad)).verified,false);
 }
});
