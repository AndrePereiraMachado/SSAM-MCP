import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createStore, digest, laneName, operationName, REPORT_KINDS } from './friction-store.mjs';

const BUFFER_LIMIT = 4 * 1024 * 1024;
const option = (args,key) => { const i=args.indexOf(key);return i<0?undefined:args[i+1]; };
export function boundaryMetadata(root, entry, args, env = process.env) {
  const selected = entry==='ssam' && args[0]==='package';
  const files=['facade/launch.mjs','facade/friction-boundary.mjs','facade/friction-store.mjs',
    'platforms/odc/facade/ssam.mjs','platforms/odc/facade/odc.mjs','platforms/odc/facade/lib.mjs',
    'platforms/odc/facade/kernel-delivery.mjs','platforms/odc/facade/mcp.mjs','facade/package-route.mjs'];
  let toolingSha256=null;
  try { toolingSha256=digest(files.map(file=>file+'\n'+digest(fs.readFileSync(path.join(root,file)))).join('\n')); } catch {}
  let selection=null;
  if(selected) {
    try {
      const pointer=JSON.parse(fs.readFileSync(path.join(root,'.local/releases/active-readonly.json'),'utf8'));
      const file=option(args,'--selection')??pointer.selection?.path;
      const hash=option(args,'--sha256')??pointer.selection?.sha256;
      const bytes=fs.readFileSync(file);
      if(digest(bytes)===hash) selection=JSON.parse(bytes.toString('utf8'));
    } catch { /* The actual router owns admission. Missing identity is explicit, never a guessed version. */ }
  }
  const isMcp=args[0]==='mcp'||(selected&&args[1]==='mcp');
  // Codex CLI child processes carry their real thread ID. A long-lived/shared MCP
  // process may serve more than its launch thread, so it must not infer that binding.
  const taskId=env.SSAM_TASK_ID??(!isMcp?env.CODEX_THREAD_ID:undefined);
  return {taskId,correlationSource:env.SSAM_TASK_ID?'explicit-task':taskId?'client-thread-environment':'absent',sessionId:randomUUID(),profile:selected?'selected-readonly':'operational',
    operation: selected ? option(args,'--operation') : ['studio','portal'].includes(args[0])?args[1]:args[0],
    lane:entry==='odc'?'odc':option(args,'--lane'),toolingSha256,
    selectedPackageId:selection?.packageId,selectedPackageSha256:selection?.packageSha256,
    slowThresholdMs:Number(env.SSAM_FRICTION_SLOW_MS)||undefined};
}

function receiptEvidence(root,value) {
  for(let depth=0;value&&depth<4;depth++,value=value.result??value.structuredContent) {
    if(typeof value.evidence!=='string') continue;
    try {
      const file=path.resolve(value.evidence,'deliver-result.json'),relative=path.relative(root,file);
      if(relative.startsWith('..')||path.isAbsolute(relative)) continue;
      const real=fs.realpathSync(file),realRelative=path.relative(fs.realpathSync(root),real);
      if(realRelative.startsWith('..')||path.isAbsolute(realRelative)||fs.statSync(real).size>BUFFER_LIMIT) continue;
      return {sha256:digest(fs.readFileSync(real)),locatorSha256:digest(real)};
    } catch {}
  }
  return undefined;
}
export function captureJson({limit=BUFFER_LIMIT,onLimit=()=>{}}={}) {
  let buffers=[],size=0,overflow=false;
  return {push(chunk) {
    if(overflow)return;
    const data=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
    size+=data.length;
    if(size>limit){buffers=[];overflow=true;onLimit();}else buffers.push(data);
  },value(){if(overflow)return undefined;try{return JSON.parse(Buffer.concat(buffers).toString('utf8'));}catch{return undefined;}}};
}

export function observeCli({root,entry,args,env=process.env,store=createStore({root}),meta=boundaryMetadata(root,entry,args,env)}={}) {
  const op=store.begin({...meta,interface:'cli'});
  const capture=captureJson({onLimit:()=>store.warn('RESULT_TOO_LARGE_METADATA_INCOMPLETE')});
  const errors=captureJson({onLimit:()=>store.warn('STDERR_TOO_LARGE_METADATA_INCOMPLETE')});
  return {stdout:chunk=>capture.push(chunk),stderr:chunk=>errors.push(chunk),finish(exitCode,interrupted=false,transportError=false){
    const value=capture.value(),error=errors.value();
    // Never overwrite a semantic failure with a successful process exit.
    op.finish({result:value,refusal:error},{exitCode,interrupted,transportError,evidence:receiptEvidence(root,value)});
  }};
}

// For the existing package run fast path: observe bytes without a second Node process.
// The original write return value/callback and all bytes remain untouched.
export function observeInlineCli(options) {
  const observer=observeCli(options);
  for(const [stream,key] of [[process.stdout,'stdout'],[process.stderr,'stderr']]) {
    const write=stream.write;
    stream.write=function(chunk,...rest){try{observer[key](chunk);}catch{}return write.call(this,chunk,...rest);};
  }
  process.once('exit',code=>observer.finish(code));
}

// Incremental line observer. Oversized messages are forwarded unchanged, never retained.
export function lineChannel({onMessage,onRaw,warning=()=>{},limit=BUFFER_LIMIT}) {
  const decoder=new StringDecoder('utf8');let text='',skipping=false;
  function feed(fragment,final=false){
    text+=fragment;
    for(;;){
      const n=text.indexOf('\n');
      if(n<0)break;
      const line=text.slice(0,n+1);text=text.slice(n+1);
      if(skipping){onRaw(line);skipping=false;continue;}
      if(Buffer.byteLength(line)>limit){warning('MCP_MESSAGE_TOO_LARGE_METADATA_INCOMPLETE');onRaw(line);continue;}
      let message;
      try { message=JSON.parse(line); }
      catch { warning('MCP_MESSAGE_NOT_JSON');onRaw(line);continue; }
      let consumed=false;
      try { consumed=onMessage(message,line)===true; }
      catch { warning('MCP_OBSERVER_CALLBACK_FAILED'); }
      // Do not catch and replay a failed forwarding write: it may have written bytes.
      if(!consumed)onRaw(line);
    }
    if(Buffer.byteLength(text)>limit){if(!skipping)warning('MCP_MESSAGE_TOO_LARGE_METADATA_INCOMPLETE');onRaw(text);text='';skipping=true;}
    if(final&&text){onRaw(text);text='';warning('MCP_PARTIAL_MESSAGE');}
  }
  return {write:chunk=>feed(decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk))),end:()=>feed(decoder.end(),true)};
}

// view issues|task reads the queue (failures recorded automatically, task timing); view report writes one manual record
// of a gap, defect or slowness that produced no failure (fell back to native verbs, a workaround, a slow step), linked to
// the last operations of this session. Local queue only; no Studio access, no notification.
export const frictionTool={name:'ssam_friction',description:'The local friction queue of SSAM. issues/task read the operation failures recorded automatically and task timing (metadata only; task IDs must be explicitly correlated). report records a gap, defect or slowness that produced no failure: {view:"report", kind:"gap"|"defect"|"slow", tool, intent, attempted, workaround?, cost?, summary?, taskId?} (e.g. fell back to native verbs because the compact form does not cover the case), linked to the last operations of this session; the user\'s words only in summary. No Studio access or notifications.',
  inputSchema:{type:'object',additionalProperties:false,properties:{view:{type:'string',enum:['issues','task','report']},taskId:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100},max:{type:'integer',minimum:1,maximum:100,description:'issues: groups per page (as limit); each group carries its count and its two last operation ids'},
    kind:{type:'string',enum:REPORT_KINDS,description:'report: gap (no compact form or tool for the case), defect (wrong answer), slow'},
    tool:{type:'string',description:'report: the SSAM tool the case belongs to'},intent:{type:'string',description:'report: what the session wanted to do'},
    attempted:{type:'string',description:'report: what it tried'},workaround:{type:'string',description:'report: what it did instead'},
    cost:{type:['string','number'],description:'report: extra calls or minutes'},summary:{type:'string',description:'report: one or two sentences; the only field for the user\'s words'}}},
  annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}};

const REPORT_KEYS=['view','kind','tool','intent','attempted','workaround','cost','summary','taskId'];
export function readQueue(store,args={},context={}) {
  if(args&&typeof args==='object'&&!Array.isArray(args)&&args.view==='report'){
    if(Object.keys(args).some(k=>!REPORT_KEYS.includes(k)))throw Error('Invalid report: fields are '+REPORT_KEYS.join(', '));
    const {view,...report}=args;
    return store.report(report,context);
  }
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['view','taskId','offset','limit','max'].includes(k)))throw Error('Invalid queue query');
  if(args.taskId!==undefined&&(typeof args.taskId!=='string'||args.taskId.length>512))throw Error('Invalid task ID');
  if(args.view!==undefined&&!['issues','task'].includes(args.view))throw Error('Invalid view');
  // max (C33, atritos 3) is the page size of issues, as limit.
  const offset=args.offset??0,limit=args.max??args.limit??50;
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid pagination');
  if(args.view==='task')return store.task({...args,offset,limit});
  const {max,...rest}=args;
  return store.issues({...rest,offset,limit});
}

// sessionId (C33, atritos 3): the id of the MCP session the transport gives when one process serves several (the hosted
// server's mcp-session-id); without it, one session per observer (per process), as before.
// The queue answers here, synchronously, on the line of the client's requests: its store never rebuilds the index from the
// operation files (rebuild:false), so no friction call scans the whole queue while the session waits.
export function observeMcp({root,entry,args,env=process.env,store=createStore({root,env,rebuild:false}),meta:given=boundaryMetadata(root,entry,args,env),sessionId,toServer,toClient}={}) {
  const meta=sessionId?{...given,sessionId}:given;
  const pending=new Map(),lists=new Set();
  const key=id=>JSON.stringify(id);
  const send=value=>{try{toClient(JSON.stringify(value)+'\n');}catch{store.warn('MCP_FORWARD_WRITE_FAILED');}};
  const request=lineChannel({onRaw:toServer,warning:store.warn,onMessage(message){
    if(!message||typeof message!=='object'||Array.isArray(message)){store.warn('MCP_INVALID_ENVELOPE');return false;}
    if(message.method==='tools/list'&&message.id!==undefined)lists.add(key(message.id));
    if(message.method==='tools/call'&&message.id!==undefined){
      const input=message.params??{};
      if(input.name===frictionTool.name){
        try {
          const value=readQueue(store,input.arguments,{sessionId:meta.sessionId,profile:meta.profile});
          send({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,...(value?.ok===false?{isError:true}:{})}});
        }
        catch(error){
          const refused={ok:false,code:'FRICTION_QUERY_INVALID',error:String(error?.message??'').startsWith('Invalid report')?error.message:'Invalid friction query; use issues or task with an explicit taskId, or report {kind, tool, intent, attempted}.'};
          send({jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:JSON.stringify(refused)}],structuredContent:refused}});
        }
        return true;
      }
      const ref=key(message.id);
      if(pending.has(ref)){store.warn('MCP_DUPLICATE_PENDING_ID');return false;}
      const lane=laneName(input.arguments?.lane);
      const inferred=String(input.name).startsWith('o11_')?'o11':/^(studio_|odc_)/.test(input.name)?'odc':meta.lane;
      const taskId=input._meta?.['ssam/taskId']??input.arguments?.task_id??meta.taskId;
      pending.set(ref,store.begin({...meta,interface:'mcp',operation:operationName(input.name),lane:lane==='unknown'?inferred:lane,taskId,
        correlationSource:taskId?'explicit-task':'absent'}));
    }
    if(message.method==='notifications/cancelled'){
      const ref=key(message.params?.requestId),op=pending.get(ref);
      if(op){op.finish(null,{interrupted:true});pending.delete(ref);}
    }
    return false;
  }});
  const response=lineChannel({onRaw:toClient,warning:store.warn,onMessage(message){
    if(!message||typeof message!=='object'||Array.isArray(message)){store.warn('MCP_INVALID_ENVELOPE');return false;}
    if(message.id===undefined)return false;
    const ref=key(message.id),op=pending.get(ref);
    if(op){op.finish(message.result??message.error,{protocolError:!!message.error,evidence:receiptEvidence(root,message.result)});pending.delete(ref);}
    if(lists.delete(ref)&&message.result&&Array.isArray(message.result.tools)&&!message.result.nextCursor){
      if(!message.result.tools.some(t=>t.name===frictionTool.name))message.result.tools.push(frictionTool);
      send(message);return true;
    }
    return false;
  }});
  return {request,response,close(){request.end();response.end();for(const op of pending.values())op.finish(null,{interrupted:true});pending.clear();}};
}
