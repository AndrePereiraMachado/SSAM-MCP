import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createSsamServer } from '../ssam.mjs';
import { SERVER_PROFILES, parseMcpProfile, profileServes } from '../server-profiles.mjs';
import * as z from 'zod/v4';
import { routeTools, discoverAll } from '../tool-routing.mjs';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
async function inProcess(t,profile){const server=await createSsamServer({profile});const[a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'profile-budget-test',version:'1'});await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});return(await client.listTools()).tools;}
test('B3 app excludes six debug tools, debug serves eight, all is exact union',async t=>{
 const names=tools=>tools.map(t=>t.name).sort();const app=names(await inProcess(t,'app')),debug=names(await inProcess(t,'debug')),all=names(await inProcess(t,'all'));
 assert.equal(app.filter(n=>n.startsWith('ssam_debug')).length,0);assert.ok(app.includes('ssam_query_test'));
 assert.deepEqual(debug,[...SERVER_PROFILES.debug.includes].sort());assert.equal(debug.length,8);
 assert.deepEqual(all,[...new Set([...app,...debug])].sort());
});
test('B3 root launcher actual stdio preserves app friction and debug stays exactly eight', {timeout:120000}, async()=>{
 for(const[profile,count]of[['app',86],['debug',8]]){
  const client=new Client({name:'profile-real-root',version:'1'});
  const env={...process.env,SSAM_NO_WARM:'1',ANVIL_WORKER:'0',ANVIL_ODC_NO_WORKER:'1',SSAM_ODC_OFFLINE:'1'};
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'facade','ssam.mjs'),'mcp','--profile',profile],env,stderr:'ignore'});
  await client.connect(transport);
  try{const tools=(await client.listTools()).tools;assert.equal(tools.length,count,profile);assert.equal(tools.some(t=>t.name==='ssam_friction'),profile==='app');if(profile==='debug'){assert.deepEqual(tools.map(t=>t.name).sort(),[...SERVER_PROFILES.debug.includes].sort());await assert.rejects(client.callTool({name:'ssam_friction',arguments:{view:'issues'}}),/not found|Unknown|disabled/i);}}finally{await client.close();}
 }
});
test('B3 profile parsing has explicit CLI precedence and invalid profile is usage error',()=>{
 assert.equal(parseMcpProfile([],{}),'app');assert.equal(parseMcpProfile([],{SSAM_MCP_PROFILE:'debug'}),'debug');assert.equal(parseMcpProfile(['--profile','all'],{SSAM_MCP_PROFILE:'debug'}),'all');
 for(const args of [['--profile'],['--profile','unknown'],['--profile','--x'],['--profile','app','--profile','debug']])assert.throws(()=>parseMcpProfile(args,{}),/Usage/);
 assert.throws(()=>parseMcpProfile([],{SSAM_MCP_PROFILE:'unknown'}),/Usage/);
 for(const args of [['--profile','unknown'],['--profile']]){const result=spawnSync(process.execPath,[path.join(root,'platforms','odc','facade','ssam.mjs'),'mcp',...args],{env:{...process.env,SSAM_NO_WARM:'1'},encoding:'utf8',windowsHide:true,timeout:30000});assert.equal(result.status,1);assert.match(result.stderr,/Usage/);}
});
test('B3 only the served MCP boundary annotates debug routes; the lane router stays profile independent',async t=>{
 const fake=async input=>({ok:true,lane:input.lane,intent:input.intent,matches:[],size:{bytes:0,budgetBytes:input.budgetBytes,status:'within',truncated:[]}});
 const phrases=['depurar a action ValidarPedido com os inputs escolhidos','qual entrada pública chega na action CalcularFrete'];
 for(const profile of ['app','all']){
  const facade=new McpServer({name:'profile-routes-fixture',version:'1'});
  facade.registerTool('ssam_discover',{description:'Offline routes fixture.',inputSchema:z.object({lane:z.enum(['o11','odc']),intent:z.string(),budgetBytes:z.number().optional(),catalog:z.boolean().optional()})},async args=>{
   const value=await discoverAll(args,{discover:fake});return{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
  });
  const server=await createSsamServer({o11:false,odc:true,profile,deps:{odcFacade:async()=>facade,identity:{read:()=>({facadeSha256:'fixed',catalogSha256:'fixed'})}}});
  const[a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'profile-route-boundary',version:'1'});
  await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();await facade.close();});
  for(const lane of ['o11','odc'])for(const intent of phrases){
   const pure=routeTools({lane,intent});assert.ok(pure.tools.some(t=>t.tool.startsWith('ssam_debug')));
   assert.deepEqual(routeTools({lane,intent,profile:'app'}),pure);
   assert.deepEqual(routeTools({lane,intent,profile:'all'}),pure);
   const direct=await discoverAll({lane,intent,budgetBytes:4096},{discover:fake});
   assert.ok(direct.tools.every(t=>t.server===undefined&&t.enable===undefined));
   for(const budgetBytes of [undefined,4096,8192]){
   const response=await client.callTool({name:'ssam_discover',arguments:{lane,intent,...(budgetBytes===undefined?{}:{budgetBytes})}});
   const routes=response.structuredContent.tools.filter(t=>t.tool.startsWith('ssam_debug'));assert.ok(routes.length);
   if(profile==='app')assert.equal(response.structuredContent.size.bytes,Buffer.byteLength(JSON.stringify(response.structuredContent),'utf8'),'profile annotation retains truthful byte accounting');
   for(const route of routes){if(profile==='app'){assert.equal(route.server,'ssam-debug');assert.ok(route.enable.includes(path.join(root,'debug.mcp.json')));assert.match(route.enable,/this root/);}else{assert.equal(route.server,undefined);assert.equal(route.enable,undefined);}}
   assert.ok(Buffer.byteLength(response.content[0].text)<=30720);
   }
  }
 }
});
test('B3 standalone ODC listing and instructions do not acquire the parent app profile from environment',async()=>{
 const{createFacadeServer}=await import('../mcp.mjs');
 const servers=await Promise.all(['app','debug'].map(profile=>createFacadeServer({env:{...process.env,SSAM_MCP_PROFILE:profile}})));
 const clients=[];
 try{
  for(const server of servers){const[a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'standalone-odc-profile',version:'1'});await Promise.all([server.connect(a),client.connect(b)]);clients.push(client);}
  const listings=await Promise.all(clients.map(client=>client.listTools()));
  assert.deepEqual(listings[0],listings[1]);assert.ok(listings[0].tools.some(t=>t.name==='ssam_debug'));
  const{serverInstructions}=await import('../server-instructions.mjs');
  for(const client of clients){assert.ok(client.getInstructions().length>0);assert.equal(client.getInstructions(),serverInstructions({profile:'odc-facade'}));}
 }finally{await Promise.all(clients.map(client=>client.close()));await Promise.all(servers.map(server=>server.close()));}
});
test('B3 every debug continuation names an app/debug tool and default configs never enable debug',async t=>{
 const names=new Set((await inProcess(t,'all')).map(t=>t.name));names.add('ssam_friction');
 const dir=new URL('../',import.meta.url);for(const file of fs.readdirSync(dir).filter(f=>/^debug.*\.mjs$/.test(f))){const text=fs.readFileSync(new URL(file,dir),'utf8');for(const m of text.matchAll(/(?:tool|name)\s*:\s*['"]((?:ssam_|studio_|o11_|odc_)[a-z0-9_]+)['"]/g))assert.ok(names.has(m[1]),file+': '+m[1]);}
 for(const relative of ['.mcp.json','platforms/odc/.mcp.json']){const config=JSON.parse(fs.readFileSync(path.join(root,relative),'utf8'));assert.ok(!Object.hasOwn(config.mcpServers??{},'ssam-debug'));for(const entry of Object.values(config.mcpServers??{}))assert.ok(!entry.args?.some((arg,i,args)=>arg==='--profile'&&args[i+1]==='debug'));}
 const config=JSON.parse(fs.readFileSync(path.join(root,'debug.mcp.json'),'utf8'));
 const{serverName}=await import('../../../../scripts/configure-mcp.mjs');
 const canonicalRoot=path.resolve(root,'..','..','SSAM-Hybrid');
 const name=serverName(canonicalRoot)+'-debug';
 assert.equal(name,'ssam-debug','the canonical release is not a development worktree');
 assert.deepEqual(Object.keys(config.mcpServers),[name]);assert.deepEqual(config.mcpServers[name].args.slice(-3),['mcp','--profile','debug']);
});

test('B3 debug configuration follows root server naming in normal roots and worktrees without touching defaults',async()=>{
 const os=await import('node:os');const{writeMcpConfig,rootEntryOf,serverName}=await import('../../../../scripts/configure-mcp.mjs');
 for(const worktree of [false,true]){
  const box=fs.mkdtempSync(path.join(os.tmpdir(),'cx11-debug-config-'));
  try{
   fs.mkdirSync(path.join(box,'platforms','odc'),{recursive:true});if(worktree)fs.writeFileSync(path.join(box,'.git'),'gitdir: fixture-only-no-git-operation');
   const original='{"mcpServers":{"keep":{"command":"unchanged"}}}\n';
   for(const f of ['.mcp.json','platforms/odc/.mcp.json'])fs.writeFileSync(path.join(box,f),original);
   const result=writeMcpConfig({root:box,execPath:'node-test.exe',env:{},debug:true});const name=serverName(box)+'-debug';
   assert.equal(result.name,name);assert.deepEqual(result.files,[path.join(box,'debug.mcp.json')]);
   assert.equal(name.startsWith('ssam-dev-'),worktree);
   for(const f of ['.mcp.json','platforms/odc/.mcp.json'])assert.equal(fs.readFileSync(path.join(box,f),'utf8'),original);
   const config=JSON.parse(fs.readFileSync(result.files[0],'utf8'));assert.deepEqual(Object.keys(config.mcpServers),[name]);assert.deepEqual(config.mcpServers[name].args,[path.join(box,'facade','ssam.mjs'),'mcp','--profile','debug']);
   assert.equal(rootEntryOf({args:[path.join(box,'facade','ssam.mjs'),'mcp','--profile','app']},box),true);
   assert.equal(rootEntryOf({args:[path.join(box,'facade','ssam.mjs'),'mcp','--profile','debug']},box),false);
  }finally{fs.rmSync(box,{recursive:true,force:true});}
 }
});

// B5 at the real boundary: no CLI/Studio operation, only a fictitious private friction queue.
test('B5 root friction preserves historical small answers and keeps large answers exactly in evidence',{timeout:120000},async()=>{
 const os=await import('node:os');const{createStore}=await import('../../../../facade/friction-store.mjs');
 const box=fs.mkdtempSync(path.join(os.tmpdir(),'cx11-friction-budget-'));
 const store=createStore({root,directory:box,warning:code=>assert.fail(code)});
 const fixture=i=>store.begin({interface:'mcp',operation:'deliver',lane:'o11',profile:'operational',taskId:'cx11-friction-fixture',sessionId:'11111111-1111-4111-8111-111111111111'}).finish({ok:false,code:'CX11_'+('A'.repeat(800))+'_'+i});
 fixture(0);
 const client=new Client({name:'friction-real-budget',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'facade','ssam.mjs'),'mcp','--profile','app'],env:{...process.env,SSAM_FRICTION_DIR:box,SSAM_NO_WARM:'1',ANVIL_WORKER:'0',ANVIL_ODC_NO_WORKER:'1',SSAM_ODC_OFFLINE:'1'},stderr:'ignore'}));
 try{
  const verifyRecovered=async(response,expected)=>{
   assert.ok(Buffer.byteLength(response.content[0].text)<=30720);assert.ok(Buffer.byteLength(JSON.stringify(response.structuredContent))<=30720);
   const value=response.structuredContent,call=value.omitted??value.continuation;
   assert.equal(call?.tool,'ssam_evidence');const file=value.paged?.file??call.arguments.file;
   assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),expected);
   const recovery=await client.callTool({name:call.tool,arguments:call.arguments});assert.notEqual(recovery.isError,true);assert.ok(Buffer.byteLength(recovery.content[0].text)<=30720);
   const exact=await client.callTool({name:'ssam_evidence',arguments:{file,select:['/issues/0'],budgetBytes:4096}});
   assert.deepEqual(exact.structuredContent.values['/issues/0'],expected.issues[0]);
  };
  const before=store.issues({limit:100});assert.ok(Buffer.byteLength(JSON.stringify(before))<4096);
  const small=await client.callTool({name:'ssam_friction',arguments:{view:'issues',limit:100}});
  assert.deepEqual(small.structuredContent,before);assert.equal(small.content[0].text,JSON.stringify(before));
  for(let i=1;i<10;i++)fixture(i);
  const medium=store.issues({limit:100});const mediumBytes=Buffer.byteLength(JSON.stringify(medium));assert.ok(mediumBytes>4096&&mediumBytes<30720);
  await verifyRecovered(await client.callTool({name:'ssam_friction',arguments:{view:'issues',limit:100}}),medium);
  for(let i=10;i<100;i++)fixture(i);
  const expected=store.issues({limit:100});assert.ok(Buffer.byteLength(JSON.stringify(expected))>30720);
  await verifyRecovered(await client.callTool({name:'ssam_friction',arguments:{view:'issues',limit:100}}),expected); }finally{await client.close();fs.rmSync(box,{recursive:true,force:true});}
});
test('B5 asynchronous local boundary formatter preserves RPC errors and catches rejected callbacks',async()=>{
 const{observeMcp}=await import('../../../../facade/friction-boundary.mjs');
 for(const reject of[false,true]){
  const outputs=[],forwarded=[],warnings=[];
  const observer=observeMcp({root,entry:'ssam',args:['mcp'],meta:{sessionId:'fixture',profile:'operational'},store:{warn:code=>warnings.push(code),issues:()=>({ok:true,issues:[]})},toServer:x=>forwarded.push(x),toClient:x=>outputs.push(JSON.parse(x)),shapeFrictionResult:async(args,result)=>{if(reject)throw Error('fixture failure');return result;}});
  observer.request.write(JSON.stringify({jsonrpc:'2.0',id:41,method:'tools/call',params:{name:'ssam_friction',arguments:{view:'invalid'}}})+'\n');
  await new Promise(setImmediate);observer.close();
  assert.equal(forwarded.length,0);assert.equal(outputs.length,1);assert.equal(outputs[0].id,41);assert.equal(outputs[0].result.isError,true);assert.equal(outputs[0].result.structuredContent.ok,false);
  assert.equal(outputs[0].result.structuredContent.code,reject?'FRICTION_ANSWER_FAILED':'FRICTION_QUERY_INVALID');
  assert.deepEqual(warnings,reject?['FRICTION_ANSWER_FAILED']:[]);
 }
});




test('B3 app and debug doctors share the same root without WRONG_SERVER', async t => {
 const workspace=path.resolve(root);
 const lanes={o11:async()=>({ok:true,studio:{open:true}}),odc:async()=>({ok:true,studio:{open:true}})};
 for(const profile of ['app','debug']){
  const identity={name:profile==='debug'?'ssam-debug':'ssam',root:workspace,startedAt:'2026-10-13T00:00:00Z',release:{head:'a'.repeat(40),catalogSha256:'b'.repeat(64)}};
  const server=await createSsamServer({o11:false,odc:false,profile,deps:{doctor:{lanes},identity:{started:identity,read:()=>identity,launchCwd:workspace}}});
  const[a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:profile,version:'1'});
  await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
  const result=await client.callTool({name:'ssam_doctor',arguments:{}}),value=result.structuredContent;
  assert.equal(result.isError,undefined,profile);assert.equal(value.ok,true,profile);assert.equal(value.code,undefined,profile);
  assert.equal(value.server.root,workspace,profile);assert.equal(value.session.root,workspace,profile);
 }
});

test('A5 configure-mcp --debug in a normal root produces the canonical versioned server key',()=>{
 const box=fs.mkdtempSync(path.join(process.env.TEMP,'cx11-normal-debug-cli-'));
 try{
  for(const dir of ['scripts','facade','platforms/odc/facade'])fs.mkdirSync(path.join(box,dir),{recursive:true});
  fs.copyFileSync(path.join(root,'scripts/configure-mcp.mjs'),path.join(box,'scripts/configure-mcp.mjs'));
  fs.copyFileSync(path.join(root,'platforms/odc/facade/server-profiles.mjs'),path.join(box,'platforms/odc/facade/server-profiles.mjs'));
  // Only workspace-location dependency is a fixture; the actual configure CLI and profile parser are copied unchanged.
  fs.writeFileSync(path.join(box,'facade/launch.mjs'),"import {fileURLToPath} from 'node:url'; export const root=fileURLToPath(new URL('../',import.meta.url)); export const layout={o11Lane:'ss4',odc:'platforms/odc'};\n");
  const result=spawnSync(process.execPath,[path.join(box,'scripts/configure-mcp.mjs'),'--debug'],{cwd:box,env:{...process.env},encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/MCP ssam-debug configured/);
  const generated=JSON.parse(fs.readFileSync(path.join(box,'debug.mcp.json'),'utf8'));
  const versioned=JSON.parse(fs.readFileSync(path.join(root,'debug.mcp.json'),'utf8'));
  assert.deepEqual(Object.keys(generated.mcpServers),Object.keys(versioned.mcpServers));
  assert.deepEqual(generated.mcpServers['ssam-debug'].args,[path.join(box,'facade','ssam.mjs'),'mcp','--profile','debug']);
  assert.equal(fs.existsSync(path.join(box,'.mcp.json')),false);assert.equal(fs.existsSync(path.join(box,'platforms/odc/.mcp.json')),false);
 }finally{fs.rmSync(box,{recursive:true,force:true});}
});
