import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {approvalOf,contextValues,originId,ownedBy,sameGrant,recorded} from './written-approval.mjs';
import {fail} from './errors.mjs';
import {isUuid} from './write-journal.mjs';
export const DATASET_DELETE='agents.datasetDelete';
export const datasetStateHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// R2-I (owner's rule, 28/10): the written words naming the dataset are the approval; a context file is still accepted.
// Without one, SSAM finds the dataset's own creation in its journal (the receipt that returned this dataset).
export async function datasetDeleteApproval({file,words,host,raw,lookup,read,find}) {
 const bad=()=>fail('AUTHORIZATION_CONTEXT_INVALID','Dataset deletion requires its own creation receipt, exact current state and no connected evaluations. Nothing was sent.');
 const p=raw.inputParameters;
 if(!p||Object.keys(p).join(',')!=='DatasetId'||!isUuid(p.DatasetId)
   ||Object.keys(raw.screenVariables??{}).length||Object.keys(raw.clientVariables??{}).length)bad();
 let c;try{c={...contextValues(file)};}catch{bad();}
 c.originOperationUuid=originId(c,'originOperationUuid',{written:!file,find,what:'The dataset cleanup',
  predicate:r=>ownedBy(host,'agents.datasetCreate')(r)&&r.response?.DatasetId===p.DatasetId});
 if(!isUuid(c?.originOperationUuid))bad();
 const origin=lookup(c.originOperationUuid);
 if(!origin||!['accepted','confirmed'].includes(origin.state)||origin.identity?.tenant!==host
   ||origin.identity.operationId!=='agents.datasetCreate'||origin.response?.DatasetId!==p.DatasetId||!recorded(origin))bad();
 const current=await read('agents.dataset',{id:p.DatasetId,_idInDataFetchStatus:1});
 const dataset=current?.data?.Dataset;
 if(current?.ok!==true||current.data.NotFound!==false||dataset?.DatasetId!==p.DatasetId||!dataset.Name)bad();
 const approved=approvalOf(file,words,{lane:'odc',host,operation:DATASET_DELETE,targets:[dataset.Name],
  constraints:{originOperationUuid:c.originOperationUuid,datasetId:p.DatasetId,expectedDatasetSha256:datasetStateHash(dataset)}});
 if(!approved||!sameGrant(origin.authorization,approved))bad();
 const dependencies=await read('agents.datasetEvaluations',{DatasetId:p.DatasetId,_datasetIdInDataFetchStatus:1});
 if(dependencies?.ok!==true||dependencies.dependencyState?.verified!==true||dependencies.dependencyState.datasetId!==p.DatasetId||dependencies.dependencyState.hasConnectedEvaluations!==false)
   fail('DATASET_DEPENDENCIES_UNVERIFIED','Dataset has evaluations or its dependency state could not be verified. Nothing was sent.');
 return approved;
}
