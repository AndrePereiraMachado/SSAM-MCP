import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256,canonical,pinned,readPinned,requireThat,atomicJSON,exactRoute} from './common.mjs';
import {schemas,validateConfig,verifyImplementation,readContext} from './contracts.mjs';
import {readDataScenario} from './scenario-dispatcher.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export function createEmptyScenario(plan){requireThat(plan.schema==='ssam-local-empty-scenario/1'&&plan.explicitSynthetic===true&&plan.realBackend===false&&plan.endpoints.length===0,'EMPTY_SCENARIO_REQUIRED');return{paths:[],dispatch(){requireThat(false,'APP_TRANSPORT_REFUSED','This explicit local scenario has no backend responses');}};}

export class ReleaseState {
 constructor({config,onChange=()=>{}}){this.config=config;this.sessionId=config.stableSessionId;this.onChange=onChange;this.releases=new Map();this.sequence=-1;this.pointerDigest=null;this.state={schema:'ssam-official-live-state/1',promoted:null,rendered:null,pipeline:null,error:null};}
 changed(){this.state.updatedAt=new Date().toISOString();this.onChange(this.state);}
 promote(pointer){
  requireThat(pointer?.schema==='ssam-official-live-selection/1'&&Number.isSafeInteger(pointer.sequence)&&pointer.sequence>=0,'POINTER_SCHEMA');
  if(pointer.sequence<this.sequence)return false;
  const digest=sha256(canonical(pointer));if(pointer.sequence===this.sequence){requireThat(digest===this.pointerDigest,'POINTER_SEQUENCE_REUSED');if(this.state.error){this.state.error=null;this.changed();}return false;}
  const release=readPinned(pointer.manifest);
  requireThat(release.schema===schemas.release&&release.generator?.kind==='o11-original-native-model'&&release.sessionId===this.sessionId&&release.testOnly!==true,'RELEASE_SCHEMA_SESSION');
  requireThat(release.executionReady===true&&canonical(release.target)===canonical(this.config.target)&&release.contextContract?.sha256===this.config.contextContract?.sha256&&release.transportPolicy===this.config.transportPolicy&&release.scenarioPlan?.sha256===this.config.scenarioPlan?.sha256,'RELEASE_CONTEXT_TARGET');
  if(this.config.scenarioPlan)requireThat(readDataScenario(this.config).plan.sourceSha256===release.sourceSha256,'RELEASE_SCENARIO_SOURCE');
  requireThat(release.sourceSha256===pointer.sourceSha256,'POINTER_SOURCE_MISMATCH');
  requireThat(release.buildId===sha256(canonical(release.identity)),'RELEASE_IDENTITY');
  requireThat(release.entry==='/builds/'+release.buildId+'/view/index.html','RELEASE_ENTRY');
  const files=new Map();for(const a of release.assets){requireThat(exactRoute(a.route)&&!files.has(a.route),'RELEASE_ROUTE');files.set(a.route,{...a,body:pinned(a)});}
  requireThat(files.has('/view/index.html'),'RELEASE_SHELL_MISSING');
  // Every pin is checked before the visible pointer changes. Old files remain immutable in memory.
  this.releases.set(release.buildId,{release,files});this.sequence=pointer.sequence;this.pointerDigest=digest;
  this.state.promoted={buildId:release.buildId,compilerBuildId:release.compilerBuildId,entry:release.entry,target:release.target,entries:release.entryOptions.map(x=>x.target),sourceSha256:release.sourceSha256,sourceRevision:pointer.observedRevision??release.source.revision??null,capturedAt:pointer.capturedAt??release.source.capturedAt??null,generator:release.generator,timings:release.timings,promotedAt:new Date().toISOString(),sequence:pointer.sequence};
  this.state.error=null;this.changed();return true;
 }
 fail(error){const next={code:error.code??'HOST_SELECTION_ERROR',message:error.message};if(canonical(next)!==canonical(this.state.error)){this.state.error=next;this.changed();}}
 pipeline(value){if(canonical(value)!==canonical(this.state.pipeline)){this.state.pipeline=value;this.changed();}}
 report(value){requireThat(value?.protocol==='ssam-official-frame/2'&&value.buildId===this.state.promoted?.buildId&&this.state.promoted.entries.some(e=>e.screenKey===value.entryScreenKey)&&['rendered','rendered-with-warnings','render-error','render-pending'].includes(value.kind),'RENDER_REPORT');this.state.rendered={buildId:value.buildId,entryScreenKey:value.entryScreenKey,sourceSha256:this.state.promoted.sourceSha256,sourceRevision:this.state.promoted.sourceRevision,kind:value.kind,elapsedMs:value.elapsedMs,details:value.details,observedAt:new Date().toISOString()};this.changed();}
}

export async function startLiveHost(config){
 validateConfig(config,{starting:true});verifyImplementation(config);readContext(config);
 const data=readDataScenario(config),plan=data?.plan??{schema:'ssam-local-empty-scenario/1',explicitSynthetic:true,realBackend:false,endpoints:[],maxBodyBytes:262144};
 const dispatcher=data?.dispatcher??createEmptyScenario(plan);
 const registry=readPinned(config.runtimeAssets);
 const immutable=new Map(registry.assets.filter(x=>x.rootAccessible===true).map(a=>{requireThat(exactRoute(a.route)&&typeof a.contentType==='string','ROOT_RESOURCE_ROUTE');return[a.route,{...a,body:pinned(a)}];}));
 const shell=new Map([['/','shell.html','text/html'],['/shell.js','shell.js','text/javascript'],['/shell.css','shell.css','text/css']].map(([route,file,type])=>[route,{body:fs.readFileSync(path.join(here,file)),contentType:type+'; charset=utf-8'}]));
 const subscribers=new Set();let port;
 const ledger=(event)=>{if(config.ledgerFile)fs.appendFileSync(config.ledgerFile,JSON.stringify({at:new Date().toISOString(),...event})+'\n');};
 const manager=new ReleaseState({config,onChange:state=>{if(config.stateFile)atomicJSON(config.stateFile,state);const packet='event: state\ndata: '+JSON.stringify(state)+'\n\n';for(const s of subscribers)s.write(packet);ledger({event:'state',promoted:state.promoted?.buildId,rendered:state.rendered?.kind,error:state.error});}});
 function poll(){
  try{verifyImplementation(config);if(fs.existsSync(config.selectionFile))manager.promote(JSON.parse(fs.readFileSync(config.selectionFile)));}catch(error){manager.fail(error);}
  try{if(fs.existsSync(config.statusFile))manager.pipeline(JSON.parse(fs.readFileSync(config.statusFile)));}catch(error){manager.pipeline({status:'error',error:{code:'PIPELINE_STATUS_READ',message:error.message}});}
 }
 const server=http.createServer(async(req,res)=>{
  const origin='http://'+config.bindHost+':'+port,allowed=dispatcher.paths.map(p=>origin+p).concat(origin+'/events',origin+'/render-report').join(' ');
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src "+allowed+"; frame-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'"};
  if(req.headers.host!==config.bindHost+':'+port||!['127.0.0.1',config.bindHost,'::ffff:127.0.0.1','::ffff:'+config.bindHost].includes(req.socket.remoteAddress)){res.writeHead(403,headers);res.end();return;}
  try{
   if(req.method==='POST'){
    requireThat(req.headers.origin===origin,'SAME_ORIGIN_REQUIRED');const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;requireThat(length<=plan.maxBodyBytes,'BODY_LIMIT');chunks.push(chunk);}const body=Buffer.concat(chunks);
    if(req.url==='/render-report'){requireThat(body.length<50000,'REPORT_LIMIT');manager.report(JSON.parse(body));res.writeHead(204,headers);res.end();return;}
    requireThat(manager.state.promoted&&(!data||manager.state.promoted.sourceSha256===data.plan.sourceSha256),'ACTIVE_SCENARIO_SOURCE');
    const result=dispatcher.dispatch({method:'POST',path:req.url,contentType:req.headers['content-type'],body});ledger({event:'scenario',path:req.url,status:result.status,responseSha256:result.responseSha256,buildId:manager.state.promoted?.buildId});res.writeHead(result.status,{...headers,'Content-Type':result.contentType});res.end(result.body);return;
   }
   requireThat(['GET','HEAD'].includes(req.method),'METHOD_NOT_ALLOWED');
   const parsed=new URL(req.url,origin),queryKeys=[...parsed.searchParams.keys()];requireThat(parsed.origin===origin,'LOCAL_URL');
   requireThat(queryKeys.length===0||(queryKeys.length===1&&queryKeys[0]==='entry'&&(parsed.pathname==='/'||/^\/builds\/[a-f0-9]{64}\/view\/index\.html$/.test(parsed.pathname))),'QUERY_NOT_ALLOWED');
   if(req.url==='/events'&&req.method==='GET'){res.writeHead(200,{...headers,'Content-Type':'text/event-stream','Connection':'keep-alive'});res.write('event: state\ndata: '+JSON.stringify(manager.state)+'\n\n');subscribers.add(res);req.on('close',()=>subscribers.delete(res));return;}
   let asset=shell.get(parsed.pathname)||immutable.get(parsed.pathname);
   if(req.url==='/status')asset={body:Buffer.from(JSON.stringify(manager.state)),contentType:'application/json'};
   const match=parsed.pathname.match(/^\/builds\/([a-f0-9]{64})(\/.*)$/);if(match){const release=manager.releases.get(match[1]);if(queryKeys.length)requireThat(release?.release.entryOptions.some(e=>e.target.screenKey===parsed.searchParams.get('entry')),'ENTRY_NOT_QUALIFIED');asset=release?.files.get(match[2]);}
   if(!asset){ledger({event:'missing',path:req.url});res.writeHead(404,headers);res.end();return;}
   res.writeHead(200,{...headers,'Content-Type':asset.contentType,'Content-Length':asset.body.length});res.end(req.method==='HEAD'?undefined:asset.body);
  }catch(error){ledger({event:'refused',path:req.url,code:error.code??'REQUEST_REFUSED',message:error.message});if(!res.headersSent)res.writeHead(400,headers);res.end('Request outside the pinned local scenario');}
 });
 const requestedPort=config.port,endpointFile=config.endpointFile;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(requestedPort,config.bindHost,()=>{port=server.address().port;resolve();});});
 atomicJSON(endpointFile,{schema:'ssam-official-live-endpoint/1',bindHost:config.bindHost,port,sessionId:config.stableSessionId,pid:process.pid,url:'http://'+config.bindHost+':'+port+'/'});
 poll();const timer=setInterval(poll,config.pollMs??400),heartbeat=setInterval(()=>{for(const s of subscribers)s.write(': heartbeat\n\n');},15000);
 return {url:'http://'+config.bindHost+':'+port+'/',pid:process.pid,manager,poll,close:()=>{clearInterval(timer);clearInterval(heartbeat);for(const s of subscribers)s.end();return new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){requireThat(process.argv[2]&&path.isAbsolute(process.argv[2]),'EXPLICIT_CONFIG_REQUIRED');const config=JSON.parse(fs.readFileSync(process.argv[2])),host=await startLiveHost(config);console.log(JSON.stringify({url:host.url,pid:host.pid,officialGenerator:true,sourcePlatform:'o11',realBackend:false}));}
