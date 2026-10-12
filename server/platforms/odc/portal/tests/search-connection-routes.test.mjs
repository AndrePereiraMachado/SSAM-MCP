import test from 'node:test';import assert from 'node:assert/strict';
import {PORTAL_READS,PORTAL_WRITES,routeOf} from '../runtime/portal-routes.mjs';
import {CONNECTION_NAME_AVAILABILITY_READS,connectionNameAvailabilityInput,connectionNameAvailabilityResult} from '../runtime/connection-name-availability.mjs';
const routes={
  "connections.azureSearchNameAvailability": "ProviderBlocks/Connection_Edit_AzureAISearch/ActionConnection_CheckNameAvailability_Wrapper",
  "connections.customSearchNameAvailability": "ProviderBlocks/Connection_Edit_CustomAISearch/ActionConnection_CheckNameAvailability_Wrapper",
  "connections.azureSearchQueryTypes": "ProviderBlocks/Connection_Edit_AzureAISearch/DataActionGetQueryTypes",
  "connections.azureSearchQueryTypeLabels": "ProviderBlocks/Connection_View_AzureAISearch/DataActionGetQueryTypeLabels"
};
for(const [id,path] of Object.entries(routes))test(id+' is an exact read and cannot invoke conversion or testing',()=>{
 assert.deepEqual(PORTAL_READS[id],['connections','Connections.connection','connections/'+path]);assert.equal(PORTAL_WRITES[id],undefined);assert.throws(()=>routeOf(id,true));
 assert.equal(Object.values(PORTAL_READS).some(x=>/Connection_Edit_(AzureAISearch|CustomAISearch)\/ActionConnection(?:s)?_(?:Convert|AzureAISearch_Test|CustomAISearch_Test)/.test(x[2])),false);
});
for(const id of Object.keys(routes).filter(id=>id.endsWith('NameAvailability')))test(id+' uses a strict boolean without claiming reservation',()=>{
 assert(CONNECTION_NAME_AVAILABILITY_READS.has(id));const input={inputParameters:{ConnectionName:'SSAMSearchProof',ConnectionId:''}};
 for(const available of [false,true])assert.deepEqual(connectionNameAvailabilityResult(input,{IsNameAvailable:available}),{name:'SSAMSearchProof',connectionId:'',available,reservationMade:false,scope:'queried-name-at-read-time'});
 assert.throws(()=>connectionNameAvailabilityInput({inputParameters:{ConnectionName:'SSAMSearchProof'}}),e=>e.code==='INPUT_INVALID');
 assert.throws(()=>connectionNameAvailabilityResult(input,{IsNameAvailable:'false'}),e=>e.code==='PORTAL_RESPONSE_INVALID');
});
