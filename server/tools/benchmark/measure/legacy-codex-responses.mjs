// Source: raciocinio/scripts/07-codex-respostas.js; sha256: e424acb86670222fc80cf0fb76e570afe6f2333e1b948ce9428115e1af1a4b40.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export function responses(rows, thread='', isSub=false) {
const WRITE=/^(ssam_code|o11_deliver|o11_publish|studio_deliver|ssam_job|o11_job|propose|studio_merge|studio_publish|applyModelApiCode|omlMerge|apply_patch)$/;
const READ=/ssam_map|ssam_discover|ssam_reference|studio_inspect|o11_inspect|ssam_doctor|studio_status|ssam_evidence|get|list|read|search|exec_command|inspect|describe|status|doctor|view_image/i;
const REFUSAL=/REFUSED|"outcome"\s*:\s*"refused"|\\"outcome\\"\s*:\s*\\"refused\\"|"ok"\s*:\s*false|\\"ok\\"\s*:\s*false|isError"\s*:\s*true/;
function innerTools(input){return [...new Set([...String(input).matchAll(/tools\.([A-Za-z0-9_]+)\s*\(/g)].map(m=>m[1].replace(/^mcp__[a-z_]*?__/,"")))]}
function outText(o){return typeof o==="string"?o:JSON.stringify(o)}
const all=[];
function proc(file,thread,isSub){
 const rows=file;const meta=rows.find(r=>r.type==="session_meta").payload;const tid=meta.id;
 let active=null;const reqs=[];let cur=[];let prevEvent="inicio",prevTs=null,lastUserText="";let reqOf=null;
 for(const r of rows){const p=r.payload||{};const t=Date.parse(r.timestamp);
  if(r.type==="event_msg"&&p.type==="task_started"){const a=p.turn_attribution||{};const child=a.parent_turn_id!=null;
   if(child!==isSub){active=null;continue}
   active={turn:p.turn_id,root:isSub?a.parent_turn_id:p.turn_id};
   if(!isSub){const last=reqs[reqs.length-1];if(last&&last.aborted){last.turns.push(p.turn_id);reqOf=last}else{reqOf={id:p.turn_id,turns:[p.turn_id],aborted:false,prompt:null,start:r.timestamp};reqs.push(reqOf)}}
   prevEvent=isSub?"tarefa-do-pai":"usuario";prevTs=t;continue}
  if(!active)continue;
  if(r.type==="event_msg"&&(p.type==="task_complete"||p.type==="turn_aborted")){if(!isSub&&reqOf){reqOf.aborted=p.type==="turn_aborted";reqOf.end=r.timestamp}active=null;continue}
  if(r.type==="event_msg"&&p.type==="item_completed"&&p.item&&p.item.type==="UserMessage"){const tx=p.item.content.map(c=>c.text||"").join(" ");if(!isSub&&reqOf&&!reqOf.prompt)reqOf.prompt=tx.slice(0,90).replace(/\s+/g," ");prevEvent="usuario";prevTs=t;continue}
  if(r.type==="response_item"){
   if(p.type==="reasoning"){cur.push({k:"reasoning",summary:(p.summary||[]).map(s=>s.text).join("\n"),ts:r.timestamp});continue}
   if(p.type==="custom_tool_call"||p.type==="function_call"){const inp=p.input||p.arguments||"";cur.push({k:"call",name:p.name,bytes:Buffer.byteLength(inp),inner:p.name==="exec"?innerTools(inp):[],sigs:p.name==="exec"?[...String(inp).matchAll(/tools\.([A-Za-z0-9_]+)\s*\(([^;]{0,240})/g)].map(m=>m[1].replace(/^mcp__[a-z_]*?__/,"")+"("+m[2].replace(/\s+/g," ")):[p.name+"("+String(inp).slice(0,240).replace(/\s+/g," ")]});continue}
   if(p.type==="message"&&p.role==="assistant"){const tx=(p.content||[]).map(c=>c.text||"").join(" ");cur.push({k:"msg",bytes:Buffer.byteLength(tx)});continue}
   if(p.type==="custom_tool_call_output"||p.type==="function_call_output"){const o=outText(p.output);prevEvent=REFUSAL.test(o)?"recusa":"saida-ferramenta";prevTs=t;continue}
   if(p.type==="agent_message"){prevEvent="mensagem-agente";prevTs=t;continue}
  }
  if(r.type==="token_usage_record"&&p.thread_id===tid){const u=p.usage;
   const calls=cur.filter(x=>x.k==="call"),msgs=cur.filter(x=>x.k==="msg"),reas=cur.filter(x=>x.k==="reasoning");
   const names=calls.flatMap(c=>c.inner.length?c.inner:[c.name]);
   const callBytes=calls.reduce((n,c)=>n+c.bytes,0),msgBytes=msgs.reduce((n,c)=>n+c.bytes,0);
   let phase;
   if(prevEvent==="recusa")phase="apos-recusa";
   else if(names.some(n=>/spawn_agent|send_message|followup_task/.test(n)))phase="delegar-a-subagente";
   else if(names.some(n=>WRITE.test(n))||callBytes>4000)phase="escrever-codigo";
   else if(prevEvent==="usuario"||prevEvent==="tarefa-do-pai")phase="inicio-planejar";
   else if(names.some(n=>/^wait$|request_user_input|ssam_task/.test(n)))phase="esperar-perguntar";
   else if(calls.length)phase="ler-consultar";
   else phase="responder-texto";
   all.push({thread,sub:isSub?"sub":"",file:"transcript",req:isSub?active.root:(reqOf&&reqOf.id),ts:r.timestamp,
    genSec:prevTs?Math.round((t-prevTs)/100)/10:null,thinkSec:(prevTs&&reas.length)?Math.max(0,Math.round((Date.parse(reas[reas.length-1].ts)-prevTs)/100)/10):0,prevEvent,phase,names:names.join(","),callBytes,msgBytes,
    out:u.output_tokens,reas:u.reasoning_output_tokens,vis:u.output_tokens-u.reasoning_output_tokens,inp:u.input_tokens,cached:u.cached_input_tokens,
    summaries:reas.map(x=>x.summary).filter(Boolean),sigs:calls.flatMap(c=>c.sigs)});
   cur=[];prevTs=t;prevEvent="propria-resposta";}
 }
 return reqs;
}

const requests=proc(rows,thread,isSub);return {requests,responses:all}; }
