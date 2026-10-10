import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readSnapshot, presentReading } from './reader-client.mjs';
import { anvilRoot } from './workspace.mjs';
import { usesWorkspace, workspacePath } from './executor.mjs';

export function isModelReading(args) {
  return args.some(a=>['--path','--kind','--name','--text','--properties','--depth','--max','--offset','--all','--full','--usages','--scope','--include-internal','--select','--cold','--expectedSourceSha256','--budget'].includes(a));
}
// The reads and their journal: hosted (executor.mjs), the customer's <ws>/o11/reading.
const readingDir=entry=>usesWorkspace(entry.root,anvilRoot)?workspacePath('o11','reading'):path.join(entry.root,'.local','reading');

export async function kernelReading(entry,args) {
  try { return await executeReading(entry,args); }
  catch(error) {
    const directory=readingDir(entry);fs.mkdirSync(directory,{recursive:true});
    fs.appendFileSync(path.join(directory,'operations.jsonl'),JSON.stringify({at:new Date().toISOString(),
      command:'inspect',outcome:'error',error:error.message})+'\n');
    throw error;
  }
}

async function executeReading(entry,args) {
  const started=performance.now();
  const values={},options={},select=[];
  const booleans={ '--all':'all','--full':'full','--usages':'usages','--include-internal':'includeInternal' };
  for(let i=0;i<args.length;i++) {
    const flag=args[i];
    if (booleans[flag]) {options[booleans[flag]]=true;continue;}
    if (flag==='--cold') {values.cold=true;continue;}
    if (!['--oml','--path','--kind','--name','--text','--properties','--depth','--max','--offset','--scope','--select','--budget','--expectedSourceSha256','--work','--ss-dir'].includes(flag))
      throw new Error('Unknown reading argument: '+flag);
    const value=args[++i];
    if(value==null || value.startsWith('--')) throw new Error('Missing value for '+flag);
    if(flag==='--select') select.push(value);
    else if(['--kind','--name','--text','--properties','--scope'].includes(flag)) options[flag.slice(2)]=value;
    else if(['--depth','--max','--offset','--budget'].includes(flag)) {
      if(!/^\d+$/.test(value)) throw new Error(flag+' must be an integer');
      (flag==='--budget'?values:options)[flag.slice(2)]=Number(value);
    } else values[flag.slice(2)]=value;
  }
  if(!values.oml) throw new Error('--oml is required');
  const file=path.resolve(values.oml);
  const {readerConfig}=await import('./module-map.mjs');
  const response=await readSnapshot({...readerConfig('o11',{entry,ssDir:values['ss-dir']}),
    request:{file,path:values.path,select:select.length?select:undefined,options,
      cold:values.cold,expectedSourceSha256:values.expectedSourceSha256}});
  const out=path.join(readingDir(entry),'inspect-'+randomUUID()+'.json');
  const result=presentReading(response,{file,out,budget:values.budget??60000});
  result.timings.totalMs=performance.now()-started;
  const journal=path.join(readingDir(entry),'operations.jsonl');
  fs.appendFileSync(journal,JSON.stringify({at:new Date().toISOString(),command:'inspect',outcome:'ok',file,sourceSha256:result.sourceSha256,cache:result.cache,timings:result.timings})+'\n');
  // Preserve the O11 CLI envelope used by callers of ssam inspect.
  return {ok:true,command:'inspect',elapsedMs:result.timings.totalMs,data:result};
}
