import { cat } from './wait-categories.mjs';
import { measureColdStart } from './cold-start.mjs';
import { measureOwnerWait } from './owner-wait.mjs';
import { measurePolling } from './codex-polling.mjs';
import { innerExecCalls } from './contract-requeries.mjs';
const ms=t=>typeof t==='number'?t:Date.parse(t);
const parse=x=>{if(typeof x!=='string')return x;try{return JSON.parse(x);}catch{return x;}};
const text=x=>typeof x==='string'?x:JSON.stringify(x??'');
const callCache=new WeakMap(),modelCache=new WeakMap(),boundsCache=new WeakMap();
export function structuredResult(x) {
  x=parse(x); if(x?.structuredContent)return x.structuredContent;
  if(Array.isArray(x?.content))return parse(x.content.filter(c=>c.type==='text').map(c=>c.text).join(''));
  if(Array.isArray(x))return parse(x.filter(c=>c.type==='text').map(c=>c.text).join(''));
  return x;
}
export function callCategory(c) {
  const result=c.result??structuredResult(c.output),network=/UNREACHABLE|TIMEOUT|Request timed out|\b50[24]\b/i;
  const codes=[result?.code,result?.error?.code,result?.statusCode,result?.error?.statusCode,result?.httpStatus].filter(x=>x!==undefined);
  const message=typeof result==='string'?result:typeof result?.error==='string'?result.error:result?.error?.message??result?.message;
  // Contract/schema payloads may describe error codes; only actual response status/error fields prove a stall.
  const plainError=typeof result==='string'&&/^\s*(?:Error\s*:\s*)?(?:Request timed out|\w*(?:UNREACHABLE|TIMEOUT)\b|(?:HTTP\s*)?50[24]\b)/i.test(result);
  return codes.some(c=>network.test(String(c))) || plainError || (typeof message==='string'&&network.test(message)&&(c.isError||result?.ok===false)) ? 'network' : cat(c.tool,c.subop);
}
function normalize(c) {
  c.args=parse(c.args)??{};c.tool=c.tool??c.name?.replace(/^mcp__[^_]+(?:_[^_]+)*__/,'').replace(/^(functions|collaboration)\./,'');
  c.input??=c.args;c.result=structuredResult(c.output); c.subop=String(c.args.command??c.args.action??c.args.verb??c.args.view??c.args.kind??c.args.op??'');
  c.sec??=Math.max(0,(c.end-c.start)/1000);c.isError=!!(c.isError||c.output?.isError||c.output?.is_error||c.status==='failed'||c.result?.ok===false);c.ssam??=/^mcp__ssam/.test(c.name??'')||/^ssam/i.test(c.server??'');c.category=c.ssam?callCategory(c):/^(wait|wait_agent|studio_status)$/.test(c.tool)?'poll':null;return c;
}
export function extractNormalizedCalls(sources,{client='codex'}={}) {
  const all=[];
  for(let si=0;si<sources.length;si++) {
    const source=sources[si],rows=source.rows,thread=source.id??rows.find(r=>r.type==='session_meta')?.payload?.id??rows.find(r=>r.payload?.thread_id)?.payload?.thread_id??source.file??String(si),main=si===0,pending=new Map(),exact=[],fallback=[];
    const cacheKey=client+':'+thread+':'+main,cached=callCache.get(rows)?.get(cacheKey);if(cached){all.push(...cached);continue;}const sourceCalls=[];
    for(const r of rows) {
      const p=r.payload??{},t=ms(r.timestamp);
      if(client==='codex') {
        if(p.type==='item_completed'&&p.item?.type==='McpToolCall') {
          if(p.thread_id&&p.thread_id!==thread)continue;
          const i=p.item,s=ms(p.started_at_ms),e=ms(p.completed_at_ms);
          exact.push(normalize({id:i.id,name:`mcp__${i.server}__${i.tool}`,tool:i.tool,server:i.server,args:i.arguments,output:i.result??i.error,start:s,end:e,sec:i.duration?i.duration.secs+(i.duration.nanos??0)/1e9:(e-s)/1000,status:i.status,isError:!!i.error,thread,main,method:'recorded'}));
        }
        if(['function_call','custom_tool_call'].includes(p.type)) pending.set(p.call_id,{id:p.call_id,name:p.name,args:p.arguments??p.input,start:t,thread,main});
        if(/^(function|custom_tool)_call_output$/.test(p.type)&&pending.has(p.call_id)) {const c=pending.get(p.call_id);pending.delete(p.call_id);fallback.push(normalize({...c,end:t,output:p.output,method:'recorded-call-output'}));}
      } else {
        for(const c of Array.isArray(r.message?.content)?r.message.content:[]) {
          if(c.type==='tool_use')pending.set(c.id,{id:c.id,name:c.name,args:c.input,start:t,thread,main:main&&!r.isSidechain});
          if(c.type==='tool_result'&&pending.has(c.tool_use_id)){const u=pending.get(c.tool_use_id);pending.delete(c.tool_use_id);fallback.push(normalize({...u,end:t,output:c.content,isError:c.is_error,method:'recorded-call-output'}));}
        }
      }
    }
    // Exact MCP telemetry supersedes wrappers only where the matching invocation exists.
    for(const c of fallback) {
      if(c.ssam&&exact.some(e=>e.tool===c.tool&&e.start<=c.end+1000&&e.end>=c.start))continue;
      if(!c.ssam&&/mcp__ssam/.test(text(c.input))) {
        if(!exact.some(e=>e.start>=c.start-1000&&e.start<=c.end+1000)) {
          const invocation=innerExecCalls(text(c.input)).find(c=>/^mcp__ssam/.test(c.name));
          if(invocation){c.ssam=true;c.tool=invocation.name.replace(/^mcp__ssam[\w-]*?__/,'');c.args=invocation.args;c.subop=String(c.args.command??c.args.action??c.args.verb??c.args.view??c.args.kind??c.args.op??'');c.category=callCategory(c);c.method='estimated-exec-wrapper';}
        }
      }
      sourceCalls.push(c);
    }
    sourceCalls.push(...exact);if(!callCache.has(rows))callCache.set(rows,new Map());callCache.get(rows).set(cacheKey,sourceCalls);all.push(...sourceCalls);
  }
  return all.sort((a,b)=>a.start-b.start);
}
export const normalizedCalls=extractNormalizedCalls;
export function subagentIntervals(rows,calls,client='codex') {
  const intervals=calls.filter(c=>/^(Agent|Task|SendMessage|wait_agent)$/.test(c.tool)).map(c=>({...c,kind:'subagentWait'}));
  if(client==='claude')return intervals;
  const outgoing=calls.filter(c=>c.main&&/^(spawn_agent|send_message|followup_task)$/.test(c.tool));
  for(const r of rows){const p=r.payload??{};if(p.type!=='agent_message'&&r.type!=='inter_agent_communication_metadata')continue;const t=ms(r.timestamp);const prior=outgoing.filter(c=>c.end<=t).at(-1);if(prior)intervals.push({start:prior.end,end:t,kind:'subagentWait',method:'estimated-idle-gap'});}
  return intervals;
}
export function modelIntervals(rows,client='codex') {
  if(modelCache.get(rows)?.has(client))return modelCache.get(rows).get(client);
  const out=[];let lastIn=null,prior=null;const seen=new Map();
  for(const r of rows){const p=r.payload??{},t=ms(r.timestamp);
    if(client==='codex') {
      if(r.type==='response_item'&&(/call_output$/.test(p.type)||p.type==='message'&&p.role!=='assistant'||p.type==='agent_message'))lastIn=t;
      if(r.type==='token_usage_record'){const s=Math.max(lastIn??-Infinity,prior??-Infinity);if(Number.isFinite(s)&&t>=s)out.push({start:s,end:t,method:'recorded'});prior=t;}
    }else{
      if(r.isSidechain)continue;
      if(r.type==='user')lastIn=t;
      if(r.type==='assistant'&&r.message?.id){const id=r.message.id;if(!seen.has(id)&&r.message.usage&&lastIn!==null){const m={start:lastIn,end:t,method:'recorded'};seen.set(id,m);out.push(m);}else if(seen.has(id))seen.get(id).end=t;}
    }
  }if(!modelCache.has(rows))modelCache.set(rows,new Map());modelCache.get(rows).set(client,out);return out;
}
export function partitionTime(start,end,intervals) {
  const keys=['ownerWait','coldStart','ssam','otherTool','model','subagentWait'],points=new Set([start,end]);
  const clipped=intervals.filter(i=>i.end>start&&i.start<end).map(i=>({...i,start:Math.max(start,i.start),end:Math.min(end,i.end)}));
  for(const i of clipped){points.add(i.start);points.add(i.end);}const p=[...points].sort((a,b)=>a-b),out={wallSec:(end-start)/1000,modelSec:0,ssamSec:0,otherToolSec:0,ownerWaitSec:0,coldStartSec:0,subagentWaitSec:0,unattributedSec:0,ssamByCategory:{},overlap:{sec:0,modelDuringSsamSec:0,parallelToolsSec:0},method:'recorded'};
  for(let j=1;j<p.length;j++){const s=p[j-1],e=p[j],n=(e-s)/1000,active=clipped.filter(i=>i.start<e&&i.end>s);const chosen=keys.find(k=>active.some(i=>i.kind===k));out[`${chosen??'unattributed'}Sec`]+=n;
    if(chosen==='ssam'){const c=active.find(i=>i.kind==='ssam').category;(out.ssamByCategory[c]??=0);out.ssamByCategory[c]+=n;}
    if(active.length>1)out.overlap.sec+=n;if(active.some(i=>i.kind==='model')&&active.some(i=>i.kind==='ssam'))out.overlap.modelDuringSsamSec+=n;if(active.filter(i=>['ssam','otherTool'].includes(i.kind)).length>1)out.overlap.parallelToolsSec+=n;
  }return out;
}
export function measureTime(sources,options={}) {
  const client=options.client??'codex',rows=sources[0]?.rows??[];let bounds=boundsCache.get(rows);if(!bounds){bounds=[Infinity,-Infinity];for(const r of rows){const t=ms(r.timestamp);if(Number.isFinite(t)){bounds[0]=Math.min(bounds[0],t);bounds[1]=Math.max(bounds[1],t);}}boundsCache.set(rows,bounds);}const start=ms(options.start??options.from??bounds[0]),end=ms(options.end??options.to??bounds[1]);
  const all=extractNormalizedCalls(sources,{client}),calls=all.filter(c=>c.start>=start&&c.start<=end),main=calls.filter(c=>c.main),models=modelIntervals(rows,client).filter(m=>m.end>=start&&m.start<=end),cold=measureColdStart(rows,main,client),owner=measureOwnerWait(rows,main,{...options,client,start,end});
  if(cold.intervals[0]&&(cold.intervals[0].start<start||cold.intervals[0].start>end)){cold.sec=0;cold.lostTurns=0;cold.intervals=[];}
  const intervals=[...models.map(m=>({...m,kind:'model'})),...owner.map(i=>({...i,kind:'ownerWait'})),...cold.intervals.map(i=>({...i,kind:'coldStart'})),...subagentIntervals(rows,main,client)];
  for(const c of main) {
    if(!/^(Agent|Task|SendMessage|wait_agent|AskUserQuestion|request_user_input.*)$/.test(c.tool))intervals.push({...c,kind:c.ssam?'ssam':'otherTool'});
  }
  const ssam=calls.filter(c=>c.ssam),summary={n:ssam.length,secSum:0,failed:0,byTool:{},byCategory:{},byLane:{},method:ssam.some(c=>c.method.startsWith('estimated'))?'mixed-recorded-estimated':'recorded'},stages={};
  for(const c of ssam){summary.secSum+=c.sec;summary.failed+=+c.isError;
    const lane=c.args.lane??(/^o11_|^(context|propose|continue|status)$/.test(c.tool)?'o11':/^(studio_|odc_|hybrid_)/.test(c.tool)?'odc':'unknown');
    for(const [map,k]of[[summary.byTool,c.tool],[summary.byCategory,c.category],[summary.byLane,lane]]){const v=map[k]??={n:0,sec:0,failed:0};v.n++;v.sec+=c.sec;v.failed+=+c.isError;}
    for(const s of Array.isArray(c.result?.steps)?c.result.steps:[]){if(Number.isFinite(s.seconds))stages[s.step]=(stages[s.step]??0)+s.seconds;}
    for(const group of ['phases','timings']) {const walk=(v,p='')=>{if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(typeof x==='number'&&/Ms$/.test(k))stages[p+k]=(stages[p+k]??0)+x/1000;else if(typeof x==='object')walk(x,p+k+'.');}};walk(c.result?.[group],group+'.');}
  }
  const network=ssam.filter(c=>c.category==='network'),codes={};for(const c of network){const code=c.result?.code??c.result?.error?.code??(/\b50[24]\b/.exec(text(c.output))?.[0])??'NETWORK_ERROR';codes[code]=(codes[code]??0)+1;}
  const waits={...measurePolling(rows,main,models,{start,end}),longCalls:{over28:{n:ssam.filter(c=>c.sec>28).length,sec:ssam.filter(c=>c.sec>28).reduce((s,c)=>s+c.sec,0)}},coldStart:cold,networkStalls:{n:network.length,sec:network.reduce((s,c)=>s+c.sec,0),codes},ownerWaits:owner};delete waits.coldStart.intervals;
  const timeSplit=partitionTime(start,end,intervals);timeSplit.modelMethod='recorded';timeSplit.subagentWaitMethod=intervals.some(i=>i.kind==='subagentWait'&&i.method?.startsWith('estimated'))?'estimated-idle-gap':'recorded';
  return {timeSplit,ssamCalls:summary,ssamStages:stages,waits,calls};
}
