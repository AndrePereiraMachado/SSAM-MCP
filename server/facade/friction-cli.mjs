import fs from 'node:fs';
import path from 'node:path';
import { createStore, digest, operationName } from './friction-store.mjs';
import { readQueue } from './friction-boundary.mjs';

export async function main(args,{root,store=createStore({root})}={}) {
  const [verb='help',...rest]=args;
  if(verb==='help')return {ok:true,commands:[
    'ssam friction issues [--task-id <id>] [--offset N] [--limit N]',
    'ssam friction task --task-id <id>',
    'ssam friction ingest --receipt <deliver-result.json> [--task-id <id>] [--lane odc|o11] [--operation <known-operation>]',
    'ssam friction state --issue <id> --status investigating|corrected|verified [--revision <revision>] [--proof <proof.json>]',
    'ssam friction report --kind gap|defect|slow --tool <tool> --intent <text> --attempted <text> [--workaround <text>] [--cost <text>] [--summary <text>] [--task-id <id>]'],
    correlation:'Set SSAM_TASK_ID for CLI/MCP, or MCP params._meta["ssam/taskId"]. Without it no task association is invented.',
    states:'corrected requires a local proof file with checksPassed:true and versionSha256; verified also requires a later successful matching operationId in that version.',
    scope:'Local queue only. Does not notify external systems or modify Studio/releases.',
    isolation:'SSAM_FRICTION_DIR=<folder> keeps the records of a test run or bench out of the shared <root>/.local/friction queue.'};
  const allowed={issues:['task-id','offset','limit'],task:['task-id','offset','limit'],ingest:['receipt','task-id','lane','operation'],state:['issue','status','revision','proof'],
    report:['kind','tool','intent','attempted','workaround','cost','summary','task-id']}[verb];
  if(!allowed)throw Error('Unknown friction command');
  const options={};
  for(let i=0;i<rest.length;i+=2){
    const name=rest[i]?.slice(2);
    if(!rest[i]?.startsWith('--')||!allowed.includes(name)||rest[i+1]===undefined||rest[i+1].startsWith('--')||Object.hasOwn(options,name))throw Error('Invalid option');
    options[name]=rest[i+1];
  }
  if(verb==='report'){const {'task-id':taskId,...fields}=options;return readQueue(store,{view:'report',...fields,...(taskId!==undefined?{taskId}:{})});}
  if(verb==='issues'||verb==='task')return readQueue(store,{view:verb,taskId:options['task-id'],
    ...(options.offset!==undefined?{offset:Number(options.offset)}:{}),...(options.limit!==undefined?{limit:Number(options.limit)}:{})});
  if(verb==='state'){
    let proof;
    if(options.proof){
      const bytes=fs.readFileSync(options.proof);if(bytes.length>65536)throw Error('Proof too large');
      const value=JSON.parse(bytes.toString('utf8'));
      if(value.schema!=='ssam-friction-proof/1'||value.checksPassed!==true)throw Error('Invalid proof');
      proof={sha256:digest(bytes),versionSha256:value.versionSha256,operationId:value.operationId};
    }
    return store.transition({issueId:options.issue,status:options.status,expectedRevision:options.revision??null,proof});
  }
  const file=path.resolve(options.receipt??''),stat=fs.statSync(file);
  if(!stat.isFile()||stat.size>4*1024*1024)throw Error('Invalid receipt');
  const bytes=fs.readFileSync(file),value=JSON.parse(bytes.toString('utf8')),sha256=digest(bytes);
  if(typeof value.ok!=='boolean')throw Error('Not an operation receipt');
  const recognizedDelivery=path.basename(file).toLowerCase()==='deliver-result.json'&&(value.source==='kernel-job'||Array.isArray(value.steps));
  const operation=options.operation??(recognizedDelivery?'deliver':undefined);
  if(!operation||operation==='other'||operationName(operation)!==operation)throw Error('Generic receipt requires an explicit known --operation');
  const existing=store.snapshot().operations.find(e=>e.evidence?.sha256===sha256);
  if(existing){if(existing.operation!==operation)throw Error('Receipt already recorded under a different operation');return {ok:true,alreadyRecorded:true,operationId:existing.operationId};}
  const op=store.begin({interface:'receipt-import',operation,lane:options.lane,taskId:options['task-id'],receiptSha256:sha256});
  op.finish(value,{evidence:{sha256,locatorSha256:digest(file)},receiptDurationMs:Number.isFinite(value.totalSeconds)?value.totalSeconds*1000:undefined});
  return {ok:true,operationId:op.operationId,receiptSha256:sha256,
    note:'Historical receipt imported. Tooling version and full task duration are unknown; import time is not task execution time.'};
}
