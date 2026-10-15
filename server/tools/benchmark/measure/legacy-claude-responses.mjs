// Source: raciocinio/scripts/09-claude-respostas.js; sha256: 7e1f34f385f80f4c5b7a9657e251a610f15e28fe3d88c11de2e251ec696ade04.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export function responses(sources, cpt) {
const WRITE=/(ssam_code|o11_deliver|studio_deliver|ssam_job|o11_job|^propose$|__propose$|__continue$|studio_merge|studio_publish|o11_publish|studio_create|^Write$|^Edit$)/;
const REFUSAL=/REFUSED|"outcome"\s*:\s*"refused"|\\"outcome\\"\s*:\s*\\"refused\\"/;
const all=[],reqs={},seen=new Set();
for(const source of sources){ const {label='',rows,from:s,to:e}=source;const t0=s?Date.parse(s):0,t1=e?Date.parse(e):Infinity;
 const resp=new Map();let prevEvent="usuario",prevTs=null,req=null;
 for(const r of rows){if(r.isSidechain)continue;const t=Date.parse(r.timestamp);if(!(t>=t0&&t<=t1))continue;
  if(r.type==="user"){const c=r.message&&r.message.content;
   if(Array.isArray(c)&&c.some(x=>x.type==="tool_result")){for(const x of c){if(x.type!=="tool_result")continue;const tx=typeof x.content==="string"?x.content:JSON.stringify(x.content);prevEvent=(REFUSAL.test(tx)||(x.is_error&&/ssam|o11|odc|REFUS/i.test(tx)))?"recusa":"saida-ferramenta"}prevTs=t}
   else{const tx=typeof c==="string"?c:(c||[]).map(x=>x.text||"").join(" ");if(tx&&!tx.startsWith("<")){req={id:label+"@"+r.timestamp,prompt:tx.slice(0,90).replace(/\s+/g," "),start:r.timestamp,thread:label};reqs[req.id]=req;prevEvent="usuario"}prevTs=t}
   continue}
  if(r.type!=="assistant")continue;const msg=r.message||{};const id=msg.id||r.uuid;
  if(!resp.has(id)&&seen.has(id))continue;let o=resp.get(id);
  if(!o){o={thread:label,sub:"",file:"transcript",req:req&&req.id,ts:r.timestamp,prevEvent,prevTs,names:[],callChars:0,textChars:0,thinkChars:0,thinkBlocks:0,out:0,inp:0,cached:0,summaries:[],model:msg.model};resp.set(id,o);all.push(o);seen.add(id)}
  o.tsEnd=r.timestamp;const u=msg.usage||{};o.out=Math.max(o.out,u.output_tokens||0);o.inp=Math.max(o.inp,(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0));o.cached=Math.max(o.cached,u.cache_read_input_tokens||0);
  for(const c of msg.content||[]){if(c.type==="thinking"||c.type==="redacted_thinking"){o.thinkBlocks++;o.thinkEnd=r.timestamp;const tx=c.thinking||"";o.thinkChars+=tx.length;if(tx)o.summaries.push(tx)}
   if(c.type==="text")o.textChars+=(c.text||"").length;
   if(c.type==="tool_use"){o.names.push(c.name.replace(/^mcp__[^_]+(_[^_]+)*?__/,"").replace(/^mcp__ssam__/,""));o.callChars+=JSON.stringify(c.input||{}).length;(o.sigs??=[]).push(c.name.replace(/^mcp__ssam__/,"")+"("+JSON.stringify(c.input||{}).slice(0,240))}}
  prevEvent="propria-resposta";prevTs=t;
 }
}
// calibracao chars/token nas respostas sem thinking
// calibracao: respostas sem bloco de thinking cujo conteudo e so texto ou SendMessage (conteudo 100% visivel)
let cc=0,ct=0,nn=0;for(const o of all)if(o.thinkBlocks===0&&o.out>100&&o.names.every(n=>/^(SendMessage)$/.test(n))){cc+=o.callChars+o.textChars;ct+=o.out;nn++}
const CPT=cpt?+cpt:(ct?cc/ct:3.0);
for(const o of all){const visChars=o.callChars+o.textChars;o.callBytes=o.callChars;o.msgBytes=o.textChars;o.vis=Math.min(o.out,Math.round(visChars/CPT));o.reas=o.out-o.vis;o.names=o.names.join(",");
 o.genSec=o.prevTs?Math.round((Date.parse(o.tsEnd)-o.prevTs)/100)/10:null;
 const names=o.names.split(",").filter(Boolean);
 if(o.prevEvent==="recusa")o.phase="apos-recusa";else if(names.some(n=>/^(Task|Agent)$/.test(n)))o.phase="delegar-a-subagente";
 else if(names.some(n=>WRITE.test(n))||o.callChars>4000)o.phase="escrever-codigo";else if(o.prevEvent==="usuario")o.phase="inicio-planejar";
 else if(names.some(n=>/wait|status|AskUser/i.test(n)))o.phase="esperar-perguntar";else if(names.length)o.phase="ler-consultar";else o.phase="responder-texto";
 // segundo estimador (tempo): bloco thinking e gravado quando termina; raciocinio_t = saida x (fim do thinking - evento anterior)/(fim da resposta - evento anterior)
 const tot=o.prevTs==null?0:Date.parse(o.tsEnd)-o.prevTs;o.thinkSec=o.thinkEnd?Math.max(0,(Date.parse(o.thinkEnd)-o.prevTs)/1000):0;o.visSec=tot>0?tot/1000-o.thinkSec:0;if(!(tot>0))o.thinkSec=0;o.reasT=(o.thinkEnd&&tot>0)?Math.round(o.out*Math.min(1,o.thinkSec*1000/tot)):0;
 delete o.prevTs;}

return {cpt:CPT,calibN:nn,requests:reqs,responses:all}; }
