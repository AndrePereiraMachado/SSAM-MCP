import { appendJsonLine } from '../../../correlation.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256,canonical,pinned,readPinned,requireThat,atomicJSON,exactRoute,verifyCodeLock} from './common.mjs';
import {assertExecutionAuthority} from '../scope/host-candidate.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export function createEmptyScenario(plan){requireThat(plan.schema==='ssam-local-empty-scenario/1'&&plan.explicitSynthetic===true&&plan.realBackend===false&&plan.endpoints.length===0,'EMPTY_SCENARIO_REQUIRED');return{paths:[],dispatch(){requireThat(false,'APP_TRANSPORT_REFUSED','This explicit local scenario has no backend responses');}};}

export class ReleaseState {
 constructor({sessionId,config,onChange=()=>{}}){this.config=config;this.sessionId=sessionId;this.onChange=onChange;this.releases=new Map();this.sequence=-1;this.pointerDigest=null;this.state={schema:'ssam-official-live-state/1',promoted:null,rendered:null,pipeline:null,error:null};}
 changed(){this.state.updatedAt=new Date().toISOString();this.onChange(this.state);}
 promote(pointer){
  requireThat(pointer?.schema==='ssam-official-live-selection/1'&&Number.isSafeInteger(pointer.sequence)&&pointer.sequence>=0,'POINTER_SCHEMA');
  if(pointer.sequence<this.sequence)return false;
  const digest=sha256(canonical(pointer));if(pointer.sequence===this.sequence){requireThat(digest===this.pointerDigest,'POINTER_SEQUENCE_REUSED');if(this.state.error){this.state.error=null;this.changed();}return false;}
  const release=readPinned(pointer.manifest);
  requireThat(release.schema==='ssam-official-live-release/2'&&release.sessionId===this.sessionId&&release.testOnly!==true,'RELEASE_SCHEMA_SESSION');
  if(this.config)requireThat(canonical(release.target)===canonical(this.config.target)&&release.scenarioContract?.sha256===this.config.scenarioContract?.sha256&&release.generator?.kind==='o11-original-over-adapted-odc','RELEASE_CONTEXT_TARGET');
  requireThat(release.sourceSha256===pointer.sourceSha256,'POINTER_SOURCE_MISMATCH');
  requireThat(release.buildId===sha256(canonical(release.identity)),'RELEASE_IDENTITY');
  requireThat(release.entry==='/builds/'+release.buildId+'/view/index.html','RELEASE_ENTRY');
  const files=new Map();for(const a of release.assets){requireThat(exactRoute(a.route)&&!files.has(a.route),'RELEASE_ROUTE');files.set(a.route,{...a,body:pinned(a)});}
  requireThat(files.has('/view/index.html'),'RELEASE_SHELL_MISSING');
  // Every pin is checked before the visible pointer changes. Old files remain immutable in memory.
  this.releases.set(release.buildId,{release,files});this.sequence=pointer.sequence;this.pointerDigest=digest;
  this.state.promoted={buildId:release.buildId,compilerBuildId:release.compilerBuildId,entry:release.entry,target:release.target,sourceSha256:release.sourceSha256,sourceRevision:pointer.observedRevision??release.source.revision??null,capturedAt:pointer.capturedAt??release.source.capturedAt??null,generator:release.generator,timings:release.timings,promotedAt:new Date().toISOString(),sequence:pointer.sequence};
  this.state.error=null;this.changed();return true;
 }
 fail(error){const next={code:error.code??'HOST_SELECTION_ERROR',message:error.message};if(canonical(next)!==canonical(this.state.error)){this.state.error=next;this.changed();}}
 pipeline(value){if(canonical(value)!==canonical(this.state.pipeline)){this.state.pipeline=value;this.changed();}}
 report(value){requireThat(value?.protocol==='ssam-official-frame/2'&&value.buildId===this.state.promoted?.buildId&&value.entryScreenKey===this.state.promoted.target.screenKey&&['rendered','render-error','render-pending'].includes(value.kind),'RENDER_REPORT');this.state.rendered={buildId:value.buildId,entryScreenKey:value.entryScreenKey,sourceSha256:this.state.promoted.sourceSha256,sourceRevision:this.state.promoted.sourceRevision,kind:value.kind,elapsedMs:value.elapsedMs,details:value.details,observedAt:new Date().toISOString()};this.changed();}
}

export async function startLiveHost(config){
 const codeLockPin=config.hostImplementation;
 verifyCodeLock(codeLockPin);
 requireThat(config.schema==='ssam-official-live-host-config/2'&&config.startAllowed===true,'HOST_NOT_ACTIVATED');
 const baseline=readPinned(config.baselineConfig);readPinned(config.baselineProof);const scope=readPinned(config.scope);
 requireThat(config.bindHost==='127.0.0.2'&&scope.status==='authorized-local-render-scenario','HOST_SCOPE');assertExecutionAuthority(baseline);
 const contract=readPinned(config.scenarioContract),plan=readPinned(contract.scenarioPlan);
 const dispatcher=createEmptyScenario(plan);
 const immutable=new Map(baseline.staticRoutes.filter(x=>/^\/view\/(fonts|img)\//.test(x.route)).map(a=>[a.route,{...a,body:pinned(a)}]));
 const shell=new Map([['/','shell.html','text/html'],['/shell.js','shell.js','text/javascript'],['/shell.css','shell.css','text/css']].map(([route,file,type])=>[route,{body:fs.readFileSync(path.join(here,file)),contentType:type+'; charset=utf-8'}]));
 const subscribers=new Set();let port;
 const ledger=(event)=>{if(config.ledgerFile)appendJsonLine(config.ledgerFile, {at:new Date().toISOString(),...event});};
 const manager=new ReleaseState({sessionId:config.stableSessionId,config,onChange:state=>{if(config.stateFile)atomicJSON(config.stateFile,state);const packet='event: state\ndata: '+JSON.stringify(state)+'\n\n';for(const s of subscribers)s.write(packet);ledger({event:'state',promoted:state.promoted?.buildId,rendered:state.rendered?.kind,error:state.error});}});
 function poll(){
  try{verifyCodeLock(codeLockPin);if(fs.existsSync(config.selectionFile))manager.promote(JSON.parse(fs.readFileSync(config.selectionFile)));}catch(error){manager.fail(error);}
  try{if(fs.existsSync(config.statusFile))manager.pipeline(JSON.parse(fs.readFileSync(config.statusFile)));}catch(error){manager.pipeline({status:'error',error:{code:'PIPELINE_STATUS_READ',message:error.message}});}
 }
 const server=http.createServer(async(req,res)=>{
  const origin='http://'+config.bindHost+':'+port,allowed=dispatcher.paths.map(p=>origin+p).concat(origin+'/events',origin+'/render-report').join(' ');
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src "+allowed+"; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'"};
  if(req.headers.host!==config.bindHost+':'+port||!['127.0.0.1','127.0.0.2','::ffff:127.0.0.1','::ffff:127.0.0.2'].includes(req.socket.remoteAddress)){res.writeHead(403,headers);res.end();return;}
  try{
   if(req.method==='POST'){
    requireThat(req.headers.origin===origin,'SAME_ORIGIN_REQUIRED');const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;requireThat(length<=plan.maxBodyBytes,'BODY_LIMIT');chunks.push(chunk);}const body=Buffer.concat(chunks);
    if(req.url==='/render-report'){requireThat(body.length<50000,'REPORT_LIMIT');manager.report(JSON.parse(body));res.writeHead(204,headers);res.end();return;}
    const result=dispatcher.dispatch({method:'POST',path:req.url,contentType:req.headers['content-type'],body});ledger({event:'scenario',path:req.url,status:result.status,responseSha256:result.responseSha256,buildId:manager.state.promoted?.buildId});res.writeHead(result.status,{...headers,'Content-Type':result.contentType});res.end(result.body);return;
   }
   requireThat(['GET','HEAD'].includes(req.method),'METHOD_NOT_ALLOWED');
   if(req.url==='/events'&&req.method==='GET'){res.writeHead(200,{...headers,'Content-Type':'text/event-stream','Connection':'keep-alive'});res.write('event: state\ndata: '+JSON.stringify(manager.state)+'\n\n');subscribers.add(res);req.on('close',()=>subscribers.delete(res));return;}
   let asset=shell.get(req.url)||immutable.get(req.url);
   if(req.url==='/status')asset={body:Buffer.from(JSON.stringify(manager.state)),contentType:'application/json'};
   const match=req.url.match(/^\/builds\/([a-f0-9]{64})(\/.*)$/);if(match)asset=manager.releases.get(match[1])?.files.get(match[2]);
   if(!asset){ledger({event:'missing',path:req.url});res.writeHead(404,headers);res.end();return;}
   res.writeHead(200,{...headers,'Content-Type':asset.contentType,'Content-Length':asset.body.length});res.end(req.method==='HEAD'?undefined:asset.body);
  }catch(error){ledger({event:'refused',path:req.url,code:error.code??'REQUEST_REFUSED',message:error.message});if(!res.headersSent)res.writeHead(400,headers);res.end('Request outside the pinned local scenario');}
 });
 let requestedPort=config.port??0;const endpointFile=config.endpointFile??path.join(path.dirname(config.stateFile),'endpoint.json');
 if(requestedPort===0&&fs.existsSync(endpointFile)){const prior=JSON.parse(fs.readFileSync(endpointFile));requireThat(prior.bindHost===config.bindHost&&prior.sessionId===config.stableSessionId,'ENDPOINT_OWNERSHIP');requestedPort=prior.port;}
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(requestedPort,config.bindHost,()=>{port=server.address().port;resolve();});});
 atomicJSON(endpointFile,{schema:'ssam-official-live-endpoint/1',bindHost:config.bindHost,port,sessionId:config.stableSessionId,pid:process.pid,url:'http://'+config.bindHost+':'+port+'/'});
 poll();const timer=setInterval(poll,config.pollMs??400),heartbeat=setInterval(()=>{for(const s of subscribers)s.write(': heartbeat\n\n');},15000);
 return {url:'http://'+config.bindHost+':'+port+'/',pid:process.pid,manager,poll,close:()=>{clearInterval(timer);clearInterval(heartbeat);for(const s of subscribers)s.end();return new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const config=JSON.parse(fs.readFileSync(process.argv[2]??path.join(here,'config.json'))),host=await startLiveHost(config);console.log(JSON.stringify({url:host.url,pid:host.pid,officialGenerator:true,odcRuntimeCompatibility:false,synthetic:true}));}
