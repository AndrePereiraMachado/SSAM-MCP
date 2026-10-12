import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {authorizationContext} from '../../facade/authorization-context.mjs';
import {fail} from './errors.mjs';
import {isUuid} from './write-journal.mjs';
export const DATASET_DELETE='agents.datasetDelete';
export const datasetStateHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function datasetDeleteApproval({file,words,host,raw,lookup,read}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Dataset deletion requires its own creation receipt, exact current state and no connected evaluations. Nothing was sent.');
 const p=raw.inputParameters;
 if(!file||!p||Object.keys(p).join(',')!=='DatasetId'||!isUuid(p.DatasetId)
   ||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length)bad();
 let c;try{if(fs.statSync(file).size>32768)bad();c=JSON.parse(fs.readFileSync(file,'utf8')).constraints;}catch{bad();}
 if(!isUuid(c?.originOperationUuid))bad();
 const origin=lookup(c.originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
   ||origin.identity.operationId!=='agents.datasetCreate'||origin.response?.DatasetId!==p.DatasetId||!origin.authorization?.source)bad();
 const current=await read('agents.dataset',{id:p.DatasetId,_idInDataFetchStatus:1});
 const dataset=current?.data?.Dataset;
 if(current?.ok!==true||current.data.NotFound!==false||dataset?.DatasetId!==p.DatasetId||!dataset.Name)bad();
 const approved=authorizationContext(file,words,{lane:'odc',host,operation:DATASET_DELETE,targets:[dataset.Name],
  constraints:{originOperationUuid:c.originOperationUuid,datasetId:p.DatasetId,expectedDatasetSha256:datasetStateHash(dataset)}});
 if(!approved||approved.source.threadId!==origin.authorization.source.threadId||approved.source.messageId!==origin.authorization.source.messageId)bad();
 const dependencies=await read('agents.datasetEvaluations',{DatasetId:p.DatasetId,_datasetIdInDataFetchStatus:1});
 if(dependencies?.ok!==true||dependencies.dependencyState?.verified!==true||dependencies.dependencyState.datasetId!==p.DatasetId||dependencies.dependencyState.hasConnectedEvaluations!==false)
   fail('DATASET_DEPENDENCIES_UNVERIFIED','Dataset has evaluations or its dependency state could not be verified. Nothing was sent.');
 return approved;
}
