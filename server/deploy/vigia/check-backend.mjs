// Executed inside a backend by the remote verifier. Credentials never leave
// this process; its only stdout value is a successful check receipt.
import fs from 'node:fs';
import {openTokenStore} from './platforms/odc/facade/server-tokens.mjs';
import {toolListingBytes} from './platforms/odc/facade/tool-listing.mjs';
import {readStudioVersions} from './platforms/odc/facade/studio-version-state.mjs';
const store=await openTokenStore({dir:process.env.SSAM_SERVER_DIR||'/data/server',env:process.env});
let issued;
try {
 const kernel=JSON.parse(fs.readFileSync((process.env.SSAM_RUNTIME_DIR||'/data/server')+'/kernel.json','utf8'));
 if(expected.kernel&&JSON.stringify(kernel)!==JSON.stringify(expected.kernel))throw Error('Rollback kernel differs from the snapshot.');
 const health=await fetch('http://127.0.0.1:7310/health',{signal:AbortSignal.timeout(30000)});if(!health.ok)throw Error('Backend health failed.');
 issued=await store.issue({customer:'Version verification',days:1,lanes:'odc,o11',verification:true});
 await new Promise(r=>setTimeout(r,1200));
 const post=async(route,token,body,headers={})=>{
  const r=await fetch('http://127.0.0.1:7310'+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',accept:'application/json, text/event-stream',...headers},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const text=await r.text(),line=text.split('\n').find(x=>x.startsWith('data:'));
  if(!r.ok)throw Error('Protocol verification refused.');
  return {data:text?JSON.parse(line?line.slice(5):text):null,sid:r.headers.get('mcp-session-id')};
 };
 // The agent of this release: it runs reconcile-merge, which the ODC bridges from v106 on need (agent-hub.mjs laneCompatibility).
 const hello={t:'hello',protocol:'ssam-agent/1',instance:'vigia-verification',agent:{version:'1',odcCommands:['merge','reconcile-merge']},pack:{id:'verification',lanes:['odc','o11'],odcBridge:kernel.odcBridge,o11BuiltFor:kernel.o11,o11Hook:kernel.o11Hook??'dev'},studios:{odc:{installed:{version:kernel.odc,dir:'C:/Verification'}},o11:{installed:{version:kernel.o11,dir:'C:/Verification'}}}};
 const accepted=await post('/agent/v1/hello',issued.agentCredential,hello);
 if(!accepted.data.compatible.odc.ok||!accepted.data.compatible.o11.ok)throw Error('Synthetic hello failed.');
 // Server-only bridge mode: the new pair must accept the hello of the published agent pack (its real bridges and commands).
 const presented=expected.packHellos?.[kernel.o11+'|'+kernel.odc];
 if(presented){const r=await post('/agent/v1/hello',issued.agentCredential,presented);if(!r.data.compatible.odc?.ok||!r.data.compatible.o11?.ok)throw Error('Published agent pack hello failed.');}
 for(const offer of (expected.offers??[]).filter(x=>kernel[x.lane]===x.studioVersion)){
  // The agent that may take it: from ODC v106 on only one whose hello lists reconcile-merge (bridge-store.mjs AGENT_NEEDS).
  const old=structuredClone(hello);old.capabilities={bridgeOffer:true};old.agent={version:'1',odcCommands:['merge','reconcile-merge']};
  old.pack.odcBridge='v0';old.pack.o11BuiltFor='0.0.0';
  const response=await post('/agent/v1/hello',issued.agentCredential,old);
  const received=response.data.compatible[offer.lane]?.bridgeOffer;
  if(received?.protocol!==offer.protocol)throw Error('Signed bridge was not offered.');
  if(offer.lane==='odc'&&/^v\d+$/.test(offer.protocol)&&Number(offer.protocol.slice(1))>=106){
   const without=structuredClone(old);without.agent={version:'1'};
   const refused=(await post('/agent/v1/hello',issued.agentCredential,without)).data.compatible.odc?.bridgeOffer;
   if(refused&&Number(String(refused.protocol).slice(1))>=106)throw Error('A bridge from v106 on was offered to an agent without reconcile-merge.');
  }
  const manifest=typeof received.manifest==='string'?JSON.parse(received.manifest):received.manifest;
  for(const f of manifest.files){
   const r=await fetch(`http://127.0.0.1:7310/agent/bridges/${offer.lane}/${offer.studioVersion}/${offer.protocol}/${f.sha256}`,{headers:{authorization:'Bearer '+issued.agentCredential},signal:AbortSignal.timeout(30000)});
   if(!r.ok||(await r.arrayBuffer()).byteLength!==f.size)throw Error('Authenticated bridge delivery failed.');
  }
 }
 const init=await post('/mcp',issued.token,{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'vigia',version:'1'}}});
 if(!init.sid)throw Error('MCP initialization failed.');
 const headers={'mcp-session-id':init.sid};
 await post('/mcp',issued.token,{jsonrpc:'2.0',method:'notifications/initialized'},headers);
 const list=await post('/mcp',issued.token,{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},headers);
 const tools=list.data?.result?.tools;
 const budget={tools:tools?.length,totalBytes:tools?.reduce((n,t)=>n+toolListingBytes(t),0),core:expected.budget?.core??[]};
 budget.coreBytes=tools?.filter(t=>budget.core.includes(t.name)).reduce((n,t)=>n+toolListingBytes(t),0);
 if(!tools||(!expected.capture&&(budget.tools!==expected.budget.tools||budget.totalBytes>expected.budget.totalBytes)))throw Error('Listing budget failed.');
 if(!expected.capture&&expected.budget.coreBytes&&budget.coreBytes>expected.budget.coreBytes)throw Error('Core listing budget failed.');
 console.log(JSON.stringify({ok:true,kernel,budget,telemetry:expected.capture?readStudioVersions(process.env.SSAM_SERVER_DIR||'/data/server',await store.list()):undefined}));
} finally {
 if(issued?.id)await store.revoke(issued.id);
 await store.close?.();
}
