import { isCont } from './legacy-owner-continuation.mjs';
export function measureOwnerWait(rows, calls, {client='codex',explicitWindow=false,start=-Infinity,end=Infinity}={}) {
  const waits=[]; let stopped=null,last=null;
  for (const r of rows) {
    const p=r.payload??{},t=Date.parse(r.timestamp);
    const human=client==='codex' ? p.type==='message'&&p.role==='user' : r.type==='user'&&(typeof r.message?.content==='string'||Array.isArray(r.message?.content)&&r.message.content.some(c=>c.type==='text'));
    if (human) {
      const text=client==='codex' ? (p.content??[]).map(c=>c.text??'').join('') : typeof r.message.content==='string'?r.message.content:r.message.content.map(c=>c.text??'').join('');
      if (/^\s*</.test(text)&&!/^\s*<(send_user_message_question_reply)/.test(text)||/^\s*# AGENTS\.md instructions/.test(text)) continue;
      const stop=client==='claude' ? last : stopped;
      const finish=t;
      if (stop!==null&&stop>=start&&finish>stop&&(explicitWindow||isCont(text))&&t>=start&&t<=end) waits.push({at:new Date(stop).toISOString(),start:stop,end:finish,sec:(finish-stop)/1000,kind:'continuation',method:'recorded'});
      stopped=null;
    }
    if (client==='codex'&&['task_complete','turn_aborted'].includes(p.type)) stopped=t;
    if (client==='codex'&&p.type==='task_started') stopped=null;
    if (client==='claude'&&(r.type==='assistant'||r.type==='user')) last=t;
  }
  for(const c of calls) if (/^(AskUserQuestion|request_user_input.*)$/.test(c.tool)&&c.start>=start&&c.start<=end&&!(c.tool.endsWith('_async')&&c.result?.accepted===true)) waits.push({at:new Date(c.start).toISOString(),start:c.start,end:c.end,sec:c.sec,kind:'question-tool',method:'recorded'});
  return waits;
}
