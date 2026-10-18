import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { createFacadeServer } from '../mcp.mjs';
import * as listing from '../tool-listing.mjs';
import { TOOL_LISTING, listedTool, toolListingBytes, toolListingLimit, toolStructureBytes, toolSourceSha256, schemaWithoutDescriptions, toolTexts, TOOL_PARAMETER_OMISSIONS } from '../tool-listing.mjs';
import { projectionProblems, OMISSION_REASONS } from '../tool-listing-guard.mjs';
import { frictionTool } from '../../../../facade/friction-boundary.mjs';
async function connection(t, deps = {}, hooks = false, profile = 'app') {
 // SSAM_APP_HOOK_TOOLS is read when the app session tools register; it is restored right after.
 const saved=process.env.SSAM_APP_HOOK_TOOLS; process.env.SSAM_APP_HOOK_TOOLS=hooks?'1':'0';
 let server; try { server = await createSsamServer({profile,deps}); } finally { if(saved===undefined)delete process.env.SSAM_APP_HOOK_TOOLS; else process.env.SSAM_APP_HOOK_TOOLS=saved; }
 const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'listing-budget-test',version:'1'});
 await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
 return {client,tools:(await client.listTools()).tools};
}
// A declared overrun is the exact byte cost of rules kept over a tool's computed limit; nothing else may exceed it.
const overrun=name=>(listing.TOOL_LISTING_OVERRUN_BYTES??{})[name]??0;
for(const hooks of [false,true]) test('B2 every app listing meets its computed limit; no schema keyword changes; hooks='+hooks, async t=>{
 // Full listing is the SDK source oracle, never a substitute for checking the delivered short listing.
 const full=await connection(t,{listing:'full'},hooks),short=await connection(t,{},hooks);
 assert.deepEqual(short.tools.map(x=>x.name),full.tools.map(x=>x.name));
 assert.equal(short.tools.some(x=>x.name==='context'),hooks,'hooks='+hooks+' registers the app session tools');
 const byName=new Map(full.tools.map(x=>[x.name,x]));
 for(const tool of [...short.tools,frictionTool]){
  assert.ok(toolListingBytes(tool)<=toolListingLimit(tool)+overrun(tool.name),`${tool.name}: ${toolListingBytes(tool)} > ${toolListingLimit(tool)} + declared ${overrun(tool.name)}`);
  assert.equal(overrun(tool.name),Math.max(0,toolListingBytes(tool)-toolListingLimit(tool)),tool.name+': declared overrun must be the exact cost');
  const original=byName.get(tool.name)??frictionTool;
  assert.deepEqual(schemaWithoutDescriptions(tool.inputSchema),schemaWithoutDescriptions(original.inputSchema),tool.name);
  for(const key of ['annotations','execution','outputSchema','_meta','title','icons'])assert.deepEqual(tool[key],original[key],tool.name+' '+key);
 }
 // CX11 integrated onto CX15: 144968 + 18164 B, the CX15 delete rules served by 14 reprojected tools, the four new o11_data
 // parameters served whole (a token-named parameter cannot be projected) and the CX15 tools outside the projection.
 // a5-final (CX12 r4, CX16, CX15 r4 under the CX11 listing): +4615 B, the continueTask input of every tool and the
 // tools those junctions changed (measured: root app + hooks 160927 -> 165542 B).
 assert.ok([...short.tools,frictionTool].reduce((sum,t)=>sum+toolListingBytes(t),0)<=167747);
 const fixedCore=['ssam_doctor','ssam_connect','ssam_discover','ssam_map','ssam_code','ssam_reference','ssam_evidence','ssam_task','o11_inspect','o11_deliver','o11_publish','o11_studio','studio_deliver','studio_inspect','studio_status'];
 assert.ok(fixedCore.reduce((sum,name)=>{const tool=short.tools.find(t=>t.name===name);assert.ok(tool,name);return sum+toolListingBytes(tool);},0)<=34178);
});
test('B2 every replacement has reviewed source hash, exact original detail and mode markers',async t=>{
 const full=await connection(t,{listing:'full'}),short=await connection(t);const original=new Map(full.tools.map(t=>[t.name,t]));
 for(const [name,entry]of Object.entries(TOOL_LISTING)){
  const source=original.get(name);assert.ok(source,name);assert.equal(toolSourceSha256(source,entry),entry.sourceSha256,name);
  const response=await short.client.callTool({name:'ssam_reference',arguments:{lane:'o11',kind:'tool',query:name}});
  assert.equal(response.isError,undefined,name);assert.deepEqual(response.structuredContent.definition,source,name);
  const projected=short.tools.find(t=>t.name===name);
  const markers=tool=>Object.fromEntries(Object.entries(tool.inputSchema.properties??{}).map(([k,p])=>[k,[/\bAlone:/.test(p.description??''),/\bInstead of job\b/.test(p.description??'')]]));
  assert.deepEqual(markers(projected),markers(source),name);
 }
 // Both lanes serve identical source detail, including the reference tool's own new kind.
 const sample=Object.keys(TOOL_LISTING)[0];const response=await short.client.callTool({name:'ssam_reference',arguments:{lane:'odc',kind:'tool',query:sample}});
 assert.deepEqual(response.structuredContent.definition,original.get(sample));
});
test('B2 schema stripping preserves fields named description and data-valued schema keywords',()=>{
 const schema={contentSchema:{type:'object',description:'content docs',properties:{description:{type:'string',description:'nested docs'}}},type:'object',description:'schema documentation',required:['description'],properties:{description:{type:'string',description:'field docs',default:'kept'},payload:{type:'object',default:{description:'kept'},const:{description:'kept'},enum:[{description:'kept'}],examples:[{description:'kept'}]}},$defs:{description:{type:'string',description:'definition docs'}}};
 const tool={name:'schema_fixture',description:'documentation',inputSchema:schema};
 assert.equal(toolStructureBytes(tool),Buffer.byteLength(JSON.stringify({name:'mcp__ssam__schema_fixture',description:'',input_schema:schemaWithoutDescriptions(schema)})));
 assert.deepEqual(schemaWithoutDescriptions(schema),{contentSchema:{type:'object',properties:{description:{type:'string'}}},type:'object',required:['description'],properties:{description:{type:'string',default:'kept'},payload:{type:'object',default:{description:'kept'},const:{description:'kept'},enum:[{description:'kept'}],examples:[{description:'kept'}]}},$defs:{description:{type:'string'}}});
});
test('B2 stale source falls back to original text instead of breaking the tool catalog',async t=>{
 const {tools}=await connection(t,{listing:'full'});const source=tools.find(t=>TOOL_LISTING[t.name]);assert.ok(source);
 const changed={...source,description:source.description+' Source changed.'};assert.strictEqual(listedTool(changed),changed);
 assert.notEqual(toolSourceSha256(changed),TOOL_LISTING[changed.name].sourceSha256);
});




test('B2 an oversized immutable original tool definition keeps exact bytes in evidence under the ceiling',async t=>{
 const fs=await import('node:fs');
 const description='run dotnet build; python scripts/fixture.py; ssam app Example. '.repeat(1800);
 const {client,tools}=await connection(t,{listing:'full',registerAppSession:server=>server.registerTool('context_fixture',{description},async()=>({content:[{type:'text',text:'not called'}]}))});
 const original=tools.find(t=>t.name==='context_fixture');assert.ok(original);
 const response=await client.callTool({name:'ssam_reference',arguments:{lane:'o11',kind:'tool',query:'context_fixture'}});
 assert.ok(Buffer.byteLength(response.content[0].text)<=30720);assert.ok(response.structuredContent.paged?.file);
 const saved=JSON.parse(fs.readFileSync(response.structuredContent.paged.file,'utf8'));
 assert.equal(saved.schemaVersion,'ssam-tool-definition/1');// JSON evidence preserves the exact wire definition; SDK-only undefined optional fields are absent on the wire.
 assert.deepEqual(saved.definition,JSON.parse(JSON.stringify(original)));
 assert.equal(response.structuredContent.continuation.tool,'ssam_evidence');
 const recovered=await client.callTool({name:response.structuredContent.continuation.tool,arguments:response.structuredContent.continuation.arguments});assert.notEqual(recovered.isError,true);
 const chunk=await client.callTool({name:'ssam_evidence',arguments:{file:response.structuredContent.paged.file,pointer:'/definition/description',budgetBytes:4096}});
 assert.ok(chunk.structuredContent.value.length>0);assert.equal(chunk.structuredContent.value,description.slice(0,chunk.structuredContent.value.length));
});


test('B2 compact text preserves paths, identity, ownership and authorization policy', () => {
 for (const term of ['SQL DDL', 'pseudocode', 'HTML', 'grammar']) assert.ok(TOOL_LISTING.ssam_code.description.includes(term), term);
 for (const name of ['o11_deliver', 'studio_deliver']) assert.ok(TOOL_LISTING[name].description.includes('prototype'), name);
 for (const name of ['o11_inspect','studio_inspect']) {
  const text=TOOL_LISTING[name].params['/properties/path'];
  assert.match(text,/Kind:Name/); assert.match(text,/@key/); assert.doesNotMatch(text,/ServiceCenter|HTTP/);
 }
 assert.match(TOOL_LISTING.o11_access.description,/roles/);
 assert.match(TOOL_LISTING.o11_access.description,/users reads/);
 assert.match(TOOL_LISTING.studio_create_app.description,/publish:false/);
 assert.match(TOOL_LISTING.odc_asset_revision.description,/Upload.*OML/);
 assert.match(TOOL_LISTING.odc_asset_revision.description,/API Client only/);
 assert.match(TOOL_LISTING.odc_a2a_connection_delete.description,/owned no_auth/);
 assert.match(TOOL_LISTING.ssam_query_test.description,/Studio developer identity/);
 for (const name of ['ssam_query_test','o11_extension','o11_access']) assert.doesNotMatch(TOOL_LISTING[name].params['/properties/operationId'],/Download/);
 for (const name of ['odc_a2a_connection_delete','odc_asset_revision','odc_portal_write','odc_deploy','odc_asset_delete']) {
  assert.match(TOOL_LISTING[name].params['/properties/authorize'],/words verbatim/);
  assert.doesNotMatch(TOOL_LISTING[name].params['/properties/authorize'],/standing grant/);
 }
});

// The closed tables of one tool, only where the served tool is a reviewed projection (an unprojected tool keeps its text).
const tables=(name,projected)=>projected?{omissions:(listing.TOOL_PARAMETER_OMISSIONS??{})[name]??{},parameterClauses:(listing.PROTECTED_PARAMETER_CLAUSES??{})[name]??{},toolClauses:(listing.PROTECTED_TOOL_CLAUSES??{})[name]??[],requiredToolClauses:(listing.REQUIRED_TOOL_CLAUSES??{})[name]??[],shortened:(listing.SHORTENED_PARAMETER_EVIDENCE??{})[name]??{},reviews:(listing.TOOL_LISTING_REVIEWS??{})[name]??{}}:{};
async function facadeTools(t){
 const server=await createFacadeServer();const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'listing-guard-odc',version:'1'});
 await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
 return (await client.listTools()).tools;
}
const PROFILES=[['app',{profile:'app'}],['all',{profile:'all'}],['debug',{profile:'debug'}],['app-hooks',{profile:'app',hooks:true}]];
test('A3 every served tool of every profile keeps its parameter rules: closed reasons, real evidence, protected clauses', async t => {
 const problems=[];
 for(const [label,{profile,hooks=false}] of PROFILES){
  const full=await connection(t,{listing:'full'},hooks,profile), short=await connection(t,{},hooks,profile);
  assert.deepEqual(short.tools.map(x=>x.name),full.tools.map(x=>x.name),label);
  const originals=new Map(full.tools.map(x=>[x.name,x]));
  for(const tool of short.tools){
   const original=originals.get(tool.name), entry=TOOL_LISTING[tool.name];
   for(const text of Object.values(toolTexts(tool).params))assert.ok(text.trim(),label+' '+tool.name+' has blank text');
   if(entry)assert.equal(tool.description,entry.description,label+' '+tool.name+' serves its reviewed projection, not a fallback');
   problems.push(...projectionProblems(original,tool,tables(tool.name,Boolean(entry))).map(p=>label+' '+p));
  }
 }
 for(const tool of await facadeTools(t))problems.push(...projectionProblems(tool,tool,tables(tool.name,false)).map(p=>'odc-facade '+p));
 assert.deepEqual(problems,[],problems.length+' listing rule problems');
});
test('A3 negative: an omission with a free or unsupported reason is refused, never served', async t => {
 const {tools}=await connection(t,{listing:'full'}),source=tools.find(x=>x.name==='o11_deliver'),pointer='/properties/authorize';
 const entry=TOOL_LISTING.o11_deliver,omissions=TOOL_PARAMETER_OMISSIONS.o11_deliver,savedText=entry.params[pointer],savedReason=omissions[pointer];
 const refused=()=>{let served;try{served=listedTool(source);}catch{return true;}return served.inputSchema.properties.authorize.description===source.inputSchema.properties.authorize.description;};
 try{
  entry.params[pointer]=null;
  for(const reason of ['x',{reason:'x'},{reason:'name-and-type'},{reason:'stated-in-tool-text',evidence:['x']},{reason:'stated-in-tool-text',evidence:['words or module grant required']},{reason:'carried-by-schema',evidence:[{schema:'type'}]}]){
   omissions[pointer]=reason;
   assert.ok(refused(),'o11_deliver.authorize omitted with '+JSON.stringify(reason)+' must be refused');
   const projected=JSON.parse(JSON.stringify(source));delete projected.inputSchema.properties.authorize.description;
   assert.ok(projectionProblems(source,projected,{omissions}).some(p=>p.includes('/properties/authorize')),JSON.stringify(reason));
  }
 }finally{entry.params[pointer]=savedText;if(savedReason===undefined)delete omissions[pointer];else omissions[pointer]=savedReason;}
});
test('A3 every tool with an omitted parameter description points to ssam_reference in its short description', () => {
 const missing=Object.keys(TOOL_PARAMETER_OMISSIONS).filter(name=>Object.keys(TOOL_PARAMETER_OMISSIONS[name]).length&&!TOOL_LISTING[name].description.includes('ssam_reference'));
 assert.deepEqual(missing,[]);
 for(const name of ['o11_service_center_read','o11_service_center_write','o11_environment'])assert.match(TOOL_LISTING[name].description,/ssam_reference kind tool/,name);
});
test('A3 tool clauses removed by the compact listing are back (09060df0 -> 179021dd comparison)', () => {
 const kept={ssam_code:['Refusal: patch + basedOn, never whole text'],o11_deliver:['validates before mutation'],odc_write:['odc_receipt reconciles'],o11_service_center_read:['Secrets stay private'],ssam_map:['ssam_code writes these forms'],o11_environment:['create/update/delete/refresh'],odc_external_library:['discard deletes open job']};
 for(const [name,clauses]of Object.entries(kept))for(const clause of clauses){
  assert.ok(TOOL_LISTING[name].description.includes(clause),name+': '+clause);
  assert.ok(((listing.REQUIRED_TOOL_CLAUSES??{})[name]??[]).includes(clause),name+' requires '+clause);
 }
});
test('A3 the reviewed minimum parameter rules are served again', async t => {
 const {tools}=await connection(t);const tool=name=>tools.find(x=>x.name===name);
 // The rule is in the parameter text, or in the tool text next to the parameter name.
 const rule=(name,key,re)=>{const t=tool(name),own=t.inputSchema.properties[key]?.description??'';const clauses=t.description.split(/[.;]\s*/).filter(c=>new RegExp('\\b'+key+'\\b').test(c));
  assert.ok(re.test(own)||clauses.some(c=>re.test(c)),name+'.'+key+' '+re);};
 for(const name of ['o11_service_center_read','o11_service_center_write']){rule(name,'credentialTarget',/vault/i);rule(name,'credentialTarget',/never a credential/);}
 for(const re of [/absolute/i,/ssam-authorization-context\/1/,/exact scope/,/words stays (?:the )?exact human response/])rule('o11_service_center_write','authorizationContext',re);
 for(const re of [/Name=Producer/,/System=\(System\)/])rule('o11_deliver','captureProducers',re);
 rule('o11_deliver','expectedEnvironment',/bare host/i);
 for(const re of [/o11/,/refused/,/taskId/,/close first/])rule('ssam_code','closePrevious',re);
 for(const re of [/create-module/,/replace/,/existing module/,/destructive/])rule('o11_environment','replace',re);
});
test('B2 argument selection preserves authorization, privacy, edits and reconciliation rules', () => {
 const p=(name,key)=>TOOL_LISTING[name].params['/properties/'+key];
 for(const name of ['o11_deliver','ssam_code']) assert.match(p(name,'until'),/only.*(?:person|user).*asks/i);
 assert.match(p('o11_deliver','authorize'),/verbatim/i); assert.match(p('o11_deliver','authorize'),/grant.*nothing runs/);
 assert.match(TOOL_LISTING.o11_deliver.description,/uncertain.*continuation.*resume/i);
 for(const key of ['edits']) for(const marker of ['replace','with','after','before','insert','delete','@n','textSha']) assert.ok(p('ssam_code',key).includes(marker),key+' '+marker);
 assert.equal(p('ssam_code','also/items/properties/edits'),null);
 assert.deepEqual(TOOL_PARAMETER_OMISSIONS.ssam_code['/properties/also/items/properties/edits'],{reason:'same-text-as',evidence:[{param:'/properties/edits'}]});
 assert.match(p('ssam_code','removes'),/intentional|ON PURPOSE/i); assert.match(p('ssam_code','removes'),/refuse/);
 assert.match(p('ssam_code','files'),/one delivery/i); assert.match(p('ssam_code','part'),/read.*required/i);
 assert.match(p('o11_service_center_read','reveal'),/user.*asked/);assert.match(p('o11_service_center_read','reveal'),/masked.*never/);
 for(const marker of ['omit','repeat','unknown','refused']) assert.ok(p('o11_service_center_read','operationId').includes(marker));
 assert.match(p('odc_write','operationId'),/odc_search_operations/); assert.ok(p('odc_write','body').includes('$base64'));assert.match(p('odc_write','body'),/filename/);
 assert.match(TOOL_LISTING.odc_write.description,/^\[odc\] .*user's words/);
 assert.match(p('o11_service_center_write','words'),/every target.*consumer.*outside/);
 assert.match(p('o11_service_center_write','value'),/never.*password/);
 // The served listing of a tool: its description and every parameter text it keeps.
 const served=name=>[TOOL_LISTING[name].description,...Object.values(TOOL_LISTING[name].params).filter(Boolean)].join(' ');
 const read=served('o11_service_center_read'),write=served('o11_service_center_write'),code=served('ssam_code');
 for(const marker of ['includeSystem=false','applicationLimit/moduleLimit/maxPages=20','applicationBatchSize=3','moduleBatchSize=10','ownerParallelism=1','same host','from the prior call; drift refuses','immutable capture bound to host/principal/profile/hash'])assert.ok(read.includes(marker),marker);
 for(const marker of ['confirmHost:exact host, required for corporate/unregistered host','exact scope','SSAM/O11/<host>/SiteProperty/<name>','parameters:non-secret form labels, never user/password','prefixKind=application,maxDeletes=25','mismatch refuses prewrite','none (new)','xifFile:absolute, sha256-checked','moduleKind:eSpace/Extension'])assert.ok(write.includes(marker),marker);
 for(const marker of ['items/element','shared absolute ddl/json','workers batches','latest capture,base absolute OML','stubs absolute flow/html signatures','Absolute UTF-8','feature/changes default from the code; owners default: names','publish:clean merge+words/grant','authorize:verbatim user words','patch:JSON Patch/verified'])assert.ok(code.includes(marker),marker);
 assert.match(TOOL_LISTING.o11_environment.description,/kind default Reactive/);
 for(const marker of ['name(exact)/prefix:case-insensitive','kind:I-less e.g. MobileScreen, list or *','parent:direct children','pid:auto if exactly one'])assert.ok(TOOL_LISTING.ssam_map.description.includes(marker),marker);
});

test('B2 empty projections and unreviewed omissions are rejected',async t=>{
 const {tools}=await connection(t,{listing:'full'}),source=tools.find(x=>x.name==='o11_deliver');
 const entry=TOOL_LISTING.o11_deliver, pointer='/properties/authorize', saved=entry.params[pointer];
 try { entry.params[pointer]=' '; assert.throws(()=>listedTool(source),/empty parameter text/); entry.params[pointer]=null; assert.throws(()=>listedTool(source),/unreviewed omission/); }
 finally {entry.params[pointer]=saved;}
 for(const [name,omissions]of Object.entries(TOOL_PARAMETER_OMISSIONS))for(const [pointer,entry]of Object.entries(omissions)) {
  assert.equal(TOOL_LISTING[name].params[pointer],null,name+pointer); assert.ok(Object.hasOwn(OMISSION_REASONS,entry?.reason),name+pointer+' closed reason');
 }
});

test('B2 shared SDK schema objects retain independent parameter projections',async t=>{
 const {tools}=await connection(t,{listing:'full'}),source=tools.find(x=>x.name==='ssam_code');
 source.inputSchema.properties.also.items.properties.edits=source.inputSchema.properties.edits;
 const original=JSON.stringify(source),entry=TOOL_LISTING.ssam_code,saved=entry.sourceSha256;
 try{
  entry.sourceSha256=toolSourceSha256(source);
  const short=listedTool(source);
  assert.match(short.inputSchema.properties.edits.description,/replace.*with/);
  assert.equal(short.inputSchema.properties.also.items.properties.edits.description,undefined);
  assert.equal(JSON.stringify(source),original,'immutable SDK definition');
 }finally{entry.sourceSha256=saved;}
});
