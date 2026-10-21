import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function smokeImage({pair,bundle,dir,root,docker,served,pack={odcBridge:'v97',o11BuiltFor:'11.55.92',o11Hook:'dev'}}){
 const name='ssam-vigia-'+randomUUID().slice(0,12),secret=path.resolve(dir,'segredo'),state=path.join(secret,'state'),features=path.join(secret,'features'),cache=path.join(secret,'cache');
 for(const folder of [state,features,cache])fs.mkdirSync(folder,{recursive:true});
 const kernel={o11:pair.o11,odc:pair.odc,odcBridge:pack.odcBridge,odcBridgeAccepted:['v96','v48','v45']};
 fs.writeFileSync(path.join(state,'kernel.json'),JSON.stringify(kernel));fs.writeFileSync(path.join(dir,'kernel.json'),JSON.stringify(kernel,null,2));fs.copyFileSync(bundle.features,path.join(features,'Features.plain.xml'));
 const image=pair.image+':'+pair.tag,mount=(from,to)=>['-v',from.replaceAll('\\','/')+':'+to];
 let created=false,credentials=null;
 try{
  await docker(['run','-d','--name',name,'--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true',...mount(state,'/data/server'),...mount(features,'/data/odc-features'),...mount(cache,'/data/cache'),...mount(path.join(root,'server/deploy/kernel-pair-check.mjs'),'/check.mjs:ro'),'-e','SSAM_WARM_DELAY_MS=0','-e','SSAM_ACCESS_NOTIFY=0','-e','SSAM_SERVED_VERSIONS='+JSON.stringify(served),image],{dir});created=true;
  await docker(['exec',name,'node','/check.mjs','check','/data/server/kernel.json'],{dir});
  let healthy=false;
  for(let i=0;i<60;i++){const r=await docker(['exec',name,'node','-e',"fetch('http://127.0.0.1:7310/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],{allowFailure:true});if(r.code===0){healthy=true;break;}await wait(1000);}
  if(!healthy)throw Error('The image did not become healthy.');
  let warm;
  for(let i=0;i<240;i++){
   const logs=await docker(['logs',name],{allowFailure:true});warm=logs.stdout.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(x=>x.event==='warm');
   if(warm)break;await wait(1000);
  }
  if(!warm?.indexes?.ok||!warm?.delivery?.builder?.ok||!warm?.delivery?.worker?.ok)return {ok:false,healthy,warm,error:'Warm-up failed.'};
  const issued=await docker(['exec',name,'node','facade/ssam.mjs','server-token','issue','--customer','Version smoke','--days','1','--lanes','odc,o11'],{dir,secret:true});credentials=JSON.parse(issued.stdout);
  if(!credentials.token||!credentials.agentCredential)throw Error('Smoke credentials could not be issued.');
  const script=`import {toolListingBytes} from './platforms/odc/facade/tool-listing.mjs';
try {
const credentials=${JSON.stringify(credentials)},pair=${JSON.stringify(pair)},pack=${JSON.stringify(pack)};
const parse=text=>{const line=text.split('\\n').find(x=>x.startsWith('data:'));return JSON.parse(line?line.slice(5):text);};
async function post(route,token,body,headers={}){const r=await fetch('http://127.0.0.1:7310'+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream',...headers},body:JSON.stringify(body)});const text=await r.text();return {status:r.status,sid:r.headers.get('mcp-session-id'),data:text?parse(text):null};}
const hello=await post('/agent/v1/hello',credentials.agentCredential,{t:'hello',protocol:'ssam-agent/1',instance:'smoke',agent:{version:'0.3.1'},pack:{id:'smoke',lanes:['odc','o11'],...pack},studios:{odc:{installed:{version:pair.odc,dir:'C:/Smoke'}},o11:{installed:{version:pair.o11,dir:'C:/Smoke'}}}});
if(hello.status!==200||!hello.data?.compatible?.odc?.ok||!hello.data?.compatible?.o11?.ok)throw Error('The unchanged agent pack was not accepted for both lanes.');
const init=await post('/mcp',credentials.token,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'vigia',version:'1'}}});
if(init.status!==200||!init.sid)throw Error('MCP initialization failed.');
const headers={'mcp-session-id':init.sid};await post('/mcp',credentials.token,{jsonrpc:'2.0',method:'notifications/initialized'},headers);
const listed=await post('/mcp',credentials.token,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},headers),tools=listed.data?.result?.tools;
if(listed.status!==200||!Array.isArray(tools)||tools.length!==92)throw Error('Unexpected hosted tool listing.');
const totalBytes=tools.reduce((n,t)=>n+toolListingBytes(t),0);if(totalBytes>261330)throw Error('Hosted listing grew beyond its approved size.');
console.log(JSON.stringify({ok:true,healthy:true,agentAccepted:true,tools:tools.length,totalBytes}));
} catch(error) { console.error('SMOKE_CHECK:'+error.message); process.exitCode=1; }`;
  const checked=await docker(['exec','-i',name,'node','--input-type=module'],{input:script,dir,secret:true,allowFailure:true});
  if(checked.code!==0)throw Error(checked.stderr.split('\n').find(x=>x.startsWith('SMOKE_CHECK:'))??'Image smoke script failed.');
  return {...JSON.parse(checked.stdout),warm};
 }catch(error){return {ok:false,error:error.message};}
 finally{
  if(created){const logs=await docker(['logs',name],{allowFailure:true});const text=logs.stdout+logs.stderr;
   if(!credentials||![credentials.token,credentials.agentCredential].some(v=>v&&text.includes(v)))fs.writeFileSync(path.join(dir,'smoke-server.log'),text);
   await docker(['rm','-f','-v',name],{allowFailure:true});
  }
  if(secret!==path.resolve(dir,'segredo'))throw Error('Unexpected smoke cleanup path.');
  fs.rmSync(secret,{recursive:true,force:true});
 }
}
