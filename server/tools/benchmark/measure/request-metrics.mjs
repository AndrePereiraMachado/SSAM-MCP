import crypto from 'node:crypto';import path from 'node:path';import os from 'node:os';
import {measureTime,extractNormalizedCalls} from './time-split.mjs';
import {measureContext} from './context-groups.mjs';
import {laneOutcomes} from './lane-outcomes.mjs';
import {measureRepeats} from './contract-requeries.mjs';
import {homeRootSegment} from '../privacy.mjs';
export const promptHash=prompt=>crypto.createHash('sha256').update(prompt).digest('hex');
function releaseHead(calls,end){let found=null;const seen=new Set();function walk(v,depth=0){if(depth>15||v==null)return;if(typeof v==='string'){if(v.startsWith('{')||v.startsWith('[')){try{walk(JSON.parse(v),depth+1)}catch{}}return;}if(typeof v!=='object'||seen.has(v))return;seen.add(v);if(v.server?.release?.head)found=v.server.release.head;for(const x of Object.values(v))walk(x,depth+1);}for(const call of calls)if(call.ssam&&call.end<=end)walk(call.output??call.result);return found;}
export function workspaceName(cwd='',{home=os.homedir()}={}){
 if(!cwd)return '';
 const windows=/^(?:[a-z]:|[\\/]{2})/i.test(cwd),api=windows?path.win32:path.posix;
 const normalized=api.normalize(cwd).replace(/[\\/]+$/,''),homePath=api.normalize(home).replace(/[\\/]+$/,'');
 const equal=(a,b)=>windows?a.toLowerCase()===b.toLowerCase():a===b;
 const homeRoot=homeRootSegment(normalized)!==null;
 if(homeRoot||equal(normalized,homePath))return '[user-home]';
 const name=api.basename(normalized),homeName=/^(?:[a-z]:|[\\/]{2})/i.test(home)?path.win32.basename(homePath):path.posix.basename(homePath);
 return equal(name,homeName)?'[user-segment]':name;
}

export function enrichRequest(result,rows,sources,options={},prompt=''){
 const start=Date.parse(result.start),end=Date.parse(result.end),client=result.client;
 const all=[{file:options.file,rows,main:true},...sources.map(s=>({...s,main:false}))];
 const timing=measureTime(all,{client,from:start,to:end,start,end,explicitWindow:!!options.windows?.length});
 const composition=measureContext(all,{client,from:start,to:end,turns:!!options.turns});
 const repeats=measureRepeats(all,{client,from:start,to:end});
 const meta=rows.find(r=>r.type==='session_meta')?.payload??{};
 const head=releaseHead(extractNormalizedCalls(all,{client}),end),fallback=options.head??meta.git?.commit_hash??null;
 const tag=/\[BenchSSAM\s+([^\]]+)\]/.exec(prompt);const tagValues=Object.fromEntries([...(tag?.[1]??'').matchAll(/([a-z]+)=([^\s]+)/g)].map(m=>[m[1],m[2]]));
 const otherMcp=(timing.calls??[]).filter(c=>c.server&&!c.ssam);
 return Object.assign(result,{timeSplit:timing.timeSplit,ssamCalls:timing.ssamCalls,ssamStages:timing.ssamStages,otherMcpCalls:{n:otherMcp.length,secSum:otherMcp.reduce((n,c)=>n+c.sec,0),method:'recorded'},waits:timing.waits,...composition,lanes:laneOutcomes(timing.calls??[]),repeats,release:{head:head??fallback,source:head?'ssam_doctor':options.head?'flag':meta.git?.commit_hash?'workspace-git':null},sessionId:meta.id??rows.find(r=>r.sessionId)?.sessionId??path.basename(options.file??'session','.jsonl'),workspace:workspaceName(meta.cwd??rows.find(r=>r.cwd)?.cwd??''),promptSha256:promptHash(prompt),case:tagValues.case??(options.windows?.length?result.id:'prompt:'+promptHash(prompt).slice(0,12)),tag:tagValues});
}
