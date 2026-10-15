import { polling } from './legacy-codex-polling.mjs';
export function measurePolling(rows,calls,modelIntervals=[],{start=-Infinity,end=Infinity}={}) {
  const selected=calls.filter(c=>c.start>=start&&c.start<=end),legacy=polling(rows.filter(r=>Date.parse(r.timestamp)>=start&&Date.parse(r.timestamp)<=end));
  let pollTurnModelSec=0,pollTurnInputTokens=legacy.pollTurnInputTokens;
  const claude=rows.some(r=>r.type==='assistant'&&r.message?.id);
  if(claude) {
    const requests=new Map(),byCall=new Map(calls.map(c=>[c.id,c]));let lastInput=null;
    for(const r of rows) {
      if(r.isSidechain)continue;
      const t=Date.parse(r.timestamp);
      if(r.type==='user')lastInput=t;
      if(r.type!=='assistant'||!r.message?.id)continue;
      const id=r.message.id,request=requests.get(id)??{start:lastInput,end:t,inputTokens:0,toolIds:new Set()};
      request.end=t;
      const u=r.message.usage;
      if(u)request.inputTokens=Math.max(request.inputTokens,(u.input_tokens??0)+(u.cache_creation_input_tokens??0)+(u.cache_read_input_tokens??0));
      for(const c of r.message.content??[])if(c.type==='tool_use')request.toolIds.add(c.id);
      requests.set(id,request);
    }
    pollTurnInputTokens=0;
    for(const request of requests.values()) {
      const tools=[...request.toolIds].map(id=>byCall.get(id));
      if(!tools.length||!tools.every(c=>c&&(c.category==='poll'||c.tool==='wait'))||!tools.some(c=>c.start>=start&&c.start<=end))continue;
      pollTurnInputTokens+=request.inputTokens;
      if(request.start!==null&&request.end>=request.start)pollTurnModelSec+=(request.end-request.start)/1000;
    }
  }else {
    for(const m of modelIntervals) {
      const next=selected.filter(c=>c.start>=m.start&&c.start<=m.end+1000);
      if(next.length&&next.every(c=>c.category==='poll'||c.tool==='wait')) pollTurnModelSec+=(m.end-m.start)/1000;
    }
  }
  const running=c=>/Script running with cell ID/.test(typeof c.output==='string'?c.output:JSON.stringify(c.output));
  return {execYields:selected.filter(c=>c.tool==='exec'&&running(c)).length,waitStillRunning:selected.filter(c=>c.tool==='wait'&&running(c)).length,waitCalls:selected.filter(c=>c.tool==='wait').length,pollCalls:selected.filter(c=>c.category==='poll').length,pollSec:selected.filter(c=>c.category==='poll').reduce((s,c)=>s+c.sec,0),pollTurnInputTokens,pollTurnModelSec,methods:{execYields:'recorded',waitStillRunning:'recorded',waitCalls:'recorded',pollCalls:'recorded',pollSec:selected.some(c=>c.category==='poll'&&c.method?.startsWith('estimated'))?'mixed-recorded-estimated':'recorded',pollTurnInputTokens:'recorded',pollTurnModelSec:'recorded'}};
}
