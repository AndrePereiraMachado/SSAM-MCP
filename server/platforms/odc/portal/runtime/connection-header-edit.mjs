import {authorizationContext} from '../../facade/authorization-context.mjs';
import {connectionHeaderPlan} from './connection-header-plan.mjs';
import {fail,publicError} from './errors.mjs';
import {isUuid} from './write-journal.mjs';

const operationId='connections.relationalSave';
export async function editConnectionHeader(input,{read,write,receipts}) {
 const {tenant:host,connectionId,providerId,operationUuid,originOperationUuid}=input;
 if(!isUuid(operationUuid)||!isUuid(originOperationUuid))fail('INPUT_INVALID','Header edit requires distinct operation and creation receipt UUIDs.');
 const identity={kind:'odc-portal',tenant:host,operationId,target:{connectionId,step:'header'}};
 const existing=receipts.lookup(operationUuid,identity);
 if(existing){
  if(!['accepted','uncertain'].includes(existing.state))return {ok:existing.ok,receipt:existing};
  return reconcile(existing);
 }
 const origin=receipts.lookup(originOperationUuid);
 const current=await read();
 const plan=connectionHeaderPlan(current,{connectionId,providerId},input.headerPatch,input.expectedUpdatedOn);
 if(plan.planSha256!==input.expectedPlanSha256)fail('CONNECTION_CHANGED','Reviewed header plan does not match the current connection.');
 const baseline=plan.baseline,stage=baseline.stageConfigurations[0];
 const reject=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Header editing requires its own unused temporary SQL connection and exact proposal.');
 if(!origin||origin.identity.kind!=='odc-portal'||origin.identity.tenant!==host
   ||!['connections.relationalTest','connections.relationalSave'].includes(origin.identity.operationId)
   ||!['accepted','confirmed'].includes(origin.state)
   ||(origin.response?.Out_ConnectionId??origin.response?.ConnectionId)!==connectionId
   ||baseline.stageConfigurations.length!==1||baseline.externalMetadata.selectedObjectCount!==0
   ||baseline.externalMetadata.selectedActionCount!==0||!stage.host||!stage.database||!/^\d+$/.test(String(stage.port)))reject();
 const approval=authorizationContext(input.authorizationContext,input.authorize,{lane:'odc',host,operation:operationId,
   targets:[origin.identity.target.connectionName,baseline.name,plan.input.inputParameters.ConnectionDetails.ConnectionDetails_Header.ConnectionName],
   environmentKey:stage.stageKey,constraints:{originOperationUuid,planSha256:plan.planSha256,noStageChanges:true,
    server:stage.host,port:Number(stage.port),database:stage.database,noDdl:true,noDataWrites:true,noBusinessDataReads:true}});
 if(!approval||approval.proposalSha256!==origin.authorization?.proposalSha256)reject();
 if(!plan.changed)return {ok:true,sent:false,changed:false};
 const available=await read('availability',plan.input.inputParameters.ConnectionDetails.ConnectionDetails_Header.ConnectionName);
 if(available!==true)fail('CONNECTION_NAME_UNAVAILABLE','The proposed name is unavailable for this connection. Nothing was sent.');
 const expected={connectionId,providerId,preservedSha256:plan.preservedSha256,
  name:plan.input.inputParameters.ConnectionDetails.ConnectionDetails_Header.ConnectionName,
  description:plan.input.inputParameters.ConnectionDetails.ConnectionDetails_Header.ConnectionDescription};
 const result=await write({tenant:host,auth:input.auth,operationId,input:plan.input,target:identity.target,
  authorize:input.authorize,authorizationContext:input.authorizationContext,operationUuid,confirmTenant:input.confirmTenant},
  {preparedHeaderEdit:{approval,expected}});
 const receipt=receipts.lookup(operationUuid,identity);
 return receipt&&['accepted','uncertain'].includes(receipt.state)?reconcile(receipt,result):result;

 async function reconcile(receipt,result={ok:receipt.ok,receipt}){
  const expected=receipt.reconciliation?.connectionHeader;
  if(!expected||expected.connectionId!==connectionId||expected.providerId!==providerId)
    fail('RECONCILIATION_UNAVAILABLE','The original header edit has no matching durable expectations. Never resend.');
  try{
   const observed=await read();
   const plan=connectionHeaderPlan(observed,{connectionId,providerId},{name:expected.name,description:expected.description},observed?.Connection?.updatedOn);
   const verified=!plan.changed&&plan.preservedSha256===expected.preservedSha256;
   const settled=verified?receipts.reconcile(receipt,{state:'confirmed',observation:{headerVerified:true,configurationPreserved:true,
    observedTimestamp:observed.Connection.updatedOn}}):receipt;
   return {...result,ok:settled.ok,receipt:settled,readBack:{headerVerified:!plan.changed,configurationPreserved:plan.preservedSha256===expected.preservedSha256,confirmed:verified}};
  }catch(error){return {...result,receipt,readBack:{confirmed:false,error:publicError(error)}};}
 }
}
