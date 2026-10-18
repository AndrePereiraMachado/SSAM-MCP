import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { ACCESS_TOOLS, registerAccessTools } from '../odc-access.mjs';
import { OdcAccess } from '../../portal/runtime/access.mjs';
import { Catalog } from '../../portal/runtime/catalog.mjs';
import { WriteJournal } from '../../portal/runtime/write-journal.mjs';
import { PORTAL_CAPTURE } from '../../portal/runtime/portal-routes.mjs';

// The same result shape as mcp.mjs: isError when value.ok === false.
const wrap = fn => async args => { const value = await fn(args); return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) }; };
async function connect(access) {
  const server = new McpServer({ name: 't', version: '0' });
  registerAccessTools(server, access, wrap);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const CLI = /`odc |odc portal|internal-routes|pwsh|powershell|\.ps1|python|--match|--tenant|--view/i;
test('Portal prompt recovery and live status are exposed through MCP without a secret argument',async()=>{
 const seen=[];const {client,close}=await connect({portalLogin:async input=>{seen.push(input);return {ok:true};}});
 try {
  for(const action of ['focus','prompt','status']){
   const result=await client.callTool({name:'odc_portal_login',arguments:{tenant:'example.test',action}});
   assert.equal(result.structuredContent.ok,true);
  }
  assert.deepEqual(seen.map(x=>x.action),['focus','prompt','status']);
  const denied=await client.callTool({name:'odc_portal_login',arguments:{tenant:'example.test',action:'focus',password:'private'}}).catch(()=>({isError:true}));
  assert.equal(denied.isError,true);assert.equal(seen.length,3);
 }finally{await close();}
});
for(const conversion of [false,true])test('native secret binary MCP forwards a vault selector for '+(conversion?'conversion':'upload'),async()=>{
 const seen=[];const {client,close}=await connect({portalWrite:async input=>{seen.push(input);return {ok:true};}});
 try{const input={tenant:'corp.outsystems.dev',auth:'auto',operationId:conversion?'mobileExtensibility.convertFile':'mobileExtensibility.uploadFile',input:{inputParameters:{[conversion?'BinaryData':'FileContent']:''}},vaultFile:'OwnSecretFile',authorize:'Own synthetic secret binary fixture',operationUuid:crypto.randomUUID(),confirmTenant:'corp.outsystems.dev',authorizationContext:'C:/private/approval.json'};
 assert.equal((await client.callTool({name:'odc_portal_write',arguments:input})).structuredContent.ok,true);assert.deepEqual(seen,[input]);
 const bad=await client.callTool({name:'odc_portal_write',arguments:{...input,secretRefs:[{pointer:'/inputParameters/FileContent',target:'arbitrary'}]}}).catch(()=>({isError:true}));assert.equal(bad.isError,true);assert.equal(seen.length,1);
 }finally{await close();}
});
test('typed knowledge-file download uses the public read entry with only receipt/file identity',async()=>{
 const seen=[];const {client,close}=await connect({portalRead:async input=>{seen.push(input);return{ok:true};}});
 try{const input={tenant:'corp.outsystems.dev',auth:'auto',operationId:'knowledgeBases.downloadFile',input:{uploadOperationUuid:crypto.randomUUID(),fileId:crypto.randomUUID()}};
  assert.equal((await client.callTool({name:'odc_portal_read',arguments:input})).structuredContent.ok,true);assert.deepEqual(seen,[{...input,maxPages:3}]);
 }finally{await close();}
});
test('dataset reconciliation MCP preserves original input and approval for typed readback',async()=>{
 const seen=[];const {client,close}=await connect({receipt:async input=>{seen.push(input);return {ok:true};}});
 try{
  const input={operationUuid:crypto.randomUUID(),reconcile:{state:'confirmed',authorize:'Own fixture approval',read:{operationId:'agents.dataset',auth:'portal-credential',
   input:{screenVariables:{id:crypto.randomUUID(),_idInDataFetchStatus:1}},creationInput:{Dataset:{Name:'Synthetic'}},authorizationContext:'C:/private/original.json'}}};
  assert.equal((await client.callTool({name:'odc_receipt',arguments:input})).structuredContent.ok,true);assert.deepEqual(seen,[input]);
 }finally{await close();}
});
test('native mobile MCP dispatch preserves the creation receipt and passes approval outside the body',async()=>{
 const seen=[];const {client,close}=await connect({write:async(input,options)=>{seen.push({input,options});return{ok:true};}});
 try{
  const input={operationId:'native-application-orchestration-service-api-v1:post:/build-operations',tenant:'corp.outsystems.dev',auth:'api-client',body:{applicationKey:crypto.randomUUID()},
   authorize:'Synthetic native package approval',operationUuid:crypto.randomUUID(),originOperationUuid:crypto.randomUUID(),authorizationContext:'C:/private/approval.json'};
  assert.equal((await client.callTool({name:'odc_write',arguments:input})).structuredContent.ok,true);
  assert.deepEqual(seen[0].options,{assetBuildContext:input.authorizationContext,originOperationUuid:input.originOperationUuid});
  assert.deepEqual(seen[0].input.body,input.body);assert.equal(seen[0].input.authorizationContext,undefined);
 }finally{await close();}
});

test('portfolio rename MCP dispatch binds contextual approval to the typed guard',async()=>{
 const seen=[];const {client,close}=await connect({write:async(input,options)=>{seen.push({input,options});return {ok:true,sent:false};}});
 try{
  const input={operationId:'portfolio-api-v2:patch:/portfolios/{portfolioKey}',tenant:'corp.outsystems.dev',auth:'api-client',
   path:{portfolioKey:crypto.randomUUID()},body:{name:'Temporary'},authorize:'Synthetic rename approval',operationUuid:crypto.randomUUID(),
   confirmTenant:'corp.outsystems.dev',authorizationContext:'C:/private/approved.json'};
  assert.equal((await client.callTool({name:'odc_write',arguments:input})).structuredContent.ok,true);
  assert.deepEqual(seen[0].options,{portfolioRenameContext:input.authorizationContext});
  assert.equal(seen[0].input.authorizationContext,undefined);
  assert.deepEqual(seen[0].input.body,input.body);
 }finally{await close();}
});

test('organization rename MCP binds its own context and preserves its name-only body',async()=>{
 const seen=[];const {client,close}=await connect({write:async(input,options)=>{seen.push({input,options});return {ok:true,sent:false};}});
 try{const input={tenant:'corp.outsystems.dev',operationId:'organization-api-v1:patch:/organization',body:{name:'Synthetic organization'},authorize:'Synthetic consent',operationUuid:crypto.randomUUID(),confirmTenant:'corp.outsystems.dev',authorizationContext:'C:/private/organization.json'};
  assert.equal((await client.callTool({name:'odc_write',arguments:input})).structuredContent.ok,true);
  assert.deepEqual(seen[0].options,{organizationRenameContext:input.authorizationContext});assert.deepEqual(seen[0].input.body,input.body);
  const refused=await client.callTool({name:'odc_write',arguments:{...input,organizationRenameContext:'other'}}).catch(()=>({isError:true}));assert.equal(refused.isError,true);assert.equal(seen.length,1);
 }finally{await close();}
});

test('stage rename MCP dispatch binds contextual approval without allowing internal override flags',async()=>{
 const seen=[];const {client,close}=await connect({write:async(input,options)=>{seen.push({input,options});return {ok:true,sent:false};}});
 try{
  const input={operationId:'portfolio-api-v2:patch:/environments/{environmentKey}',tenant:'corp.outsystems.dev',auth:'api-client',
   path:{environmentKey:crypto.randomUUID()},body:{name:'Temporary'},authorize:'Synthetic stage approval',operationUuid:crypto.randomUUID(),
   confirmTenant:'corp.outsystems.dev',authorizationContext:'C:/private/approved.json'};
  assert.equal((await client.callTool({name:'odc_write',arguments:input})).structuredContent.ok,true);
  assert.deepEqual(seen[0].options,{stageRenameContext:input.authorizationContext});
  const batch={...input,operationId:'portfolio-api-v2:patch:/environments',body:{environments:[{key:input.path.environmentKey,name:'Temporary'}]}};
  delete batch.path;
  assert.equal((await client.callTool({name:'odc_write',arguments:batch})).structuredContent.ok,true);
  assert.deepEqual(seen[1].options,{stageRenameContext:input.authorizationContext});
  assert.deepEqual(seen[1].input.body,batch.body);
  const refused=await client.callTool({name:'odc_write',arguments:{...input,stageRenameContext:'other'}}).catch(()=>({isError:true}));
  assert.equal(refused.isError,true);assert.equal(seen.length,2);
  for(const ordered of [{...input,body:{order:101}},{...batch,body:{environments:[{key:input.path.environmentKey,order:101}]}}]){
   assert.equal((await client.callTool({name:'odc_write',arguments:ordered})).structuredContent.ok,true);
   assert.deepEqual(seen.at(-1).options,{stageRenameContext:input.authorizationContext});
   assert.deepEqual(seen.at(-1).input.body,ordered.body);
  }
 }finally{await close();}
});

test('A2A cleanup MCP preserves explicit receipt identity and rejects arbitrary credential input',async()=>{
 const seen=[];const {client,close}=await connect({a2aConnectionDelete:async input=>{seen.push(input);return {ok:true,sent:false};}});
 try{
  const input={tenant:'corp.outsystems.dev',connectionId:crypto.randomUUID(),originOperationUuid:crypto.randomUUID(),operationUuid:crypto.randomUUID(),authorize:'Synthetic fixture grant'};
  assert.equal((await client.callTool({name:'odc_a2a_connection_delete',arguments:input})).structuredContent.ok,true);
  assert.equal(seen[0].originOperationUuid,input.originOperationUuid);
  const refused=await client.callTool({name:'odc_a2a_connection_delete',arguments:{...input,password:'private'}}).catch(()=>({isError:true}));
  assert.equal(refused.isError,true);assert.equal(seen.length,1);
 }finally{await close();}
});

test('A2A MCP planner prepares native inputs without contacting any access backend',async()=>{
 const {client,close}=await connect(new Proxy({}, {get(){throw Error('Planner contacted backend');}}));
 try{
  const args={name:'Proof',agentUrl:'https://example.test/agent/',portfolioKey:crypto.randomUUID(),stage:{Key:crypto.randomUUID(),Name:'Development',Purpose:'Development'},
   card:{protocolVersion:'0.3.0',name:'Proof',description:'Fixture',version:'1',url:'https://example.test/rpc',capabilities:{streaming:false},
    defaultInputModes:['text/plain'],defaultOutputModes:['text/plain'],skills:[{id:'proof',name:'Proof',description:'Constant',tags:['test']}]}};
  const response=await client.callTool({name:'odc_a2a_connection_plan',arguments:args});
  assert.equal(response.structuredContent.ok,true);assert.equal(response.structuredContent.sent,false);assert.equal(response.structuredContent.liveVerified,false);
  assert.equal(response.structuredContent.testInput.inputParameters.ValidStageConfigs.List[0].AuthType,'no_auth');
  const refused=await client.callTool({name:'odc_a2a_connection_plan',arguments:{...args,password:'not-allowed'}}).catch(()=>({isError:true}));
  assert.equal(refused.isError,true);
 }finally{await close();}
});

test('MCP forwards a typed connection header plan and refuses credentials in the header patch',async()=>{
 const seen=[];const {client,close}=await connect({externalDbConnection:async input=>{seen.push(input);return {ok:true,sent:false};}});
 try{
  const input={action:'plan-header',tenant:'wrightflood.outsystems.dev',connectionId:'owned-id',providerId:'mssql',
   headerPatch:{description:''},expectedUpdatedOn:'2026-10-09T22:00:00Z'};
  const result=await client.callTool({name:'odc_external_db_connection',arguments:input});
  assert.equal(result.structuredContent.ok,true);assert.equal(seen[0].headerPatch.description,'');
  const edit=await client.callTool({name:'odc_external_db_connection',arguments:{...input,action:'edit-header',
    expectedPlanSha256:'a'.repeat(64),originOperationUuid:crypto.randomUUID(),operationUuid:crypto.randomUUID(),authorize:'Synthetic own fixture grant',authorizationContext:'C:/synthetic/context.json'}});
  assert.equal(edit.structuredContent.ok,true);assert.equal(seen[1].action,'edit-header');
  const invalid=await client.callTool({name:'odc_external_db_connection',arguments:{...input,headerPatch:{password:'private'}}});
  assert.equal(invalid.isError,true);assert.equal(seen.length,2);
 }finally{await close();}
});

test('configuration MCP forwards typed vault selectors and rejects value-bearing selectors',async()=>{
 const seen=[];const {client,close}=await connect({configurations:async input=>{seen.push(input);return {ok:true};}});
 try{
  const selector={libraryKey:'lib',integrationKey:'api',settingKey:'Password',entry:'PrivateSetting'};
  const args={tenant:'wrightflood.outsystems.dev',environmentKey:'dev',assetKey:'app',action:'set',vaultConfigurations:[selector]};
  await client.callTool({name:'odc_configurations',arguments:args});
  assert.deepEqual(seen[0].vaultConfigurations,[selector]);
  const mobile={...args,scope:'mobile-extensibility',vaultConfigurations:[{libraryKey:'lib',settingKey:'Password',entry:'PrivateSetting'}],originOperationUuid:crypto.randomUUID(),authorizationContext:'C:/proof/context.json'};
  const mobileResult=await client.callTool({name:'odc_configurations',arguments:mobile});
  assert.equal(mobileResult.structuredContent.ok,true);assert.equal(seen[1].scope,'mobile-extensibility');
  for(const changed of [{...selector,value:'must-not-pass'},{...selector,entry:'../wrong'},{...selector,settingKey:''}]){
   const r=await client.callTool({name:'odc_configurations',arguments:{...args,vaultConfigurations:[changed]}}).catch(()=>({isError:true}));
   assert.equal(r.isError,true);
  }
  assert.equal(seen.length,2);
 }finally{await close();}
});

test('asset source MCP accepts exact identity only, without URLs or output paths',async()=>{
 const seen=[];const {client,close}=await connect({assetSource:async input=>{seen.push(input);return {ok:true};}});
 try {
  const args={tenant:'wrightflood.outsystems.dev',assetKey:crypto.randomUUID(),revisionNumber:1};
  await client.callTool({name:'odc_asset_source',arguments:args});
  assert.deepEqual(seen,[{...args,auth:'api-client'}]);
  for(const extra of [{url:'https://arbitrary.test/'},{file:'arbitrary.bin'},{auth:'studio'}]) {
   const refused=await client.callTool({name:'odc_asset_source',arguments:{...args,...extra}}).catch(()=>({isError:true}));
   assert.equal(refused.isError,true);
  }
  assert.equal(seen.length,1);
  assert.equal((await client.listTools()).tools.find(x=>x.name==='odc_asset_source').annotations.readOnlyHint,true);
 }finally{await close();}
});

test('generic write forwards creation approval separately from the public API body', async () => {
  const seen = [];
  const {client, close} = await connect({write: async (...args) => {seen.push(args); return {ok: true};}});
  try {
    const input = {tenant: 'wrightflood.outsystems.dev', operationId: 'asset-repository-api-v1:post:/assets',
      body: {assetCreationDetails: {assetName: 'SSAMTest', assetType: 'LowCodeLibrary'}},
      authorize: 'Synthetic permission', operationUuid: crypto.randomUUID(), authorizationContext: 'approval.json'};
    const result = await client.callTool({name: 'odc_write', arguments: input});
    assert.equal(result.isError, undefined);
    const {authorizationContext, ...request} = input;
    assert.deepEqual(seen, [[{...request, auth: 'auto'}, {assetCreationContext: authorizationContext}]]);
    const revisionPrecondition={originOperationUuid:crypto.randomUUID(),expectedTag:null,expectedCommitMessage:null};
    const patch={...input,operationId:'asset-repository-api-v1:patch:/assets/{assetKey}/revisions/{revisionNumber}',
      path:{assetKey:crypto.randomUUID(),revisionNumber:1},body:{tag:'1.0.0'},revisionPrecondition};
    await client.callTool({name:'odc_write',arguments:patch});
    const {authorizationContext:context,revisionPrecondition:precondition,...native}=patch;
    assert.deepEqual(seen[1],[{...native,auth:'auto'},{assetRevisionContext:context,revisionPrecondition:precondition}]);
    const build={...input,operationId:'build-operations-api-v1:post:/build-operations',body:{assetKey:crypto.randomUUID(),assetRevision:1,buildType:'Release'},originOperationUuid:crypto.randomUUID()};
    await client.callTool({name:'odc_write',arguments:build});
    const {authorizationContext:buildContext,originOperationUuid,...buildRequest}=build;
    assert.deepEqual(seen[2],[{...buildRequest,auth:'auto'},{assetBuildContext:buildContext,originOperationUuid}]);
    const ip={...input,operationId:'environment-configurations-api-v1:post:/environments/{environmentKey}/ip-filter-groups',path:{environmentKey:crypto.randomUUID()},body:{name:'Proof',appKeys:[],ipRules:[],accessType:'DENYLIST'}};
    await client.callTool({name:'odc_write',arguments:ip});
    const {authorizationContext:ipContext,...ipRequest}=ip;
    assert.deepEqual(seen[3],[{...ipRequest,auth:'auto'},{ipFilterContext:ipContext,originOperationUuid:undefined}]);
    const deployment={...build,operationId:'deployments-api-v1:post:/deployment-operations',
      body:{operation:'Deploy',assetKey:build.body.assetKey,revision:1,buildKey:crypto.randomUUID(),environmentKey:crypto.randomUUID()}};
    await client.callTool({name:'odc_write',arguments:deployment});
    const {authorizationContext:deploymentContext,originOperationUuid:creation,...deploymentRequest}=deployment;
    assert.deepEqual(seen[4],[{...deploymentRequest,auth:'auto'},{assetBuildContext:deploymentContext,originOperationUuid:creation}]);
    const mobile={...build,operationId:'native-application-orchestration-service-api-v1:patch:/environments/{environmentKey}/applications/{applicationKey}/configurations/android',
      path:{environmentKey:crypto.randomUUID(),applicationKey:build.body.assetKey},body:{appIdentifier:{value:'com.ssam.proof'}}};
    await client.callTool({name:'odc_write',arguments:mobile});
    const {authorizationContext:mobileContext,originOperationUuid:mobileOrigin,...mobileRequest}=mobile;
    assert.deepEqual(seen[5],[{...mobileRequest,auth:'auto'},{mobileConfigurationContext:mobileContext,originOperationUuid:mobileOrigin}]);
  } finally {await close();}
});

test('MCP import has mutation annotations and requires a reviewed plan and authorization', async () => {
  const seen = [];
  const { client, close } = await connect({ mcpImport: async input => { seen.push(input); return { ok: true }; } });
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'odc_mcp_import');
    assert.equal(tool.annotations.readOnlyHint, false);
    for (const key of ['authorize', 'operationUuid', 'expectedPlanSha256', 'toolNames']) assert.ok(tool.inputSchema.required.includes(key));
    const input = { tenant: 'wrightflood.outsystems.dev', connectionId: 'c', toolNames: ['lookup'],
      expectedPlanSha256: 'a'.repeat(64), authorize: 'Import lookup on wrightflood', operationUuid: crypto.randomUUID(),
      confirmTenant: 'wrightflood.outsystems.dev' };
    await client.callTool({ name: tool.name, arguments: input });
    assert.deepEqual(seen, [{ ...input, auth: 'auto' }]);
  } finally { await close(); }
});

test('MCP readiness is read-only and forwards the explicit tenant without credential arguments', async () => {
  const seen = [];
  const { client, close } = await connect({ mcpConnection: async input => {
    seen.push(input); return { ok: true, readyForToolImport: false };
  } });
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'odc_mcp_connection');
    assert.equal(tool.annotations.readOnlyHint, true);
    const input = { tenant: 'wrightflood.outsystems.dev', action: 'readiness', connectionId: 'existing-connection' };
    const result = await client.callTool({ name: tool.name, arguments: input });
    assert.equal(result.structuredContent.readyForToolImport, false);
    assert.deepEqual(seen, [{ ...input, auth: 'auto' }]);
    const invalid = await client.callTool({ name: tool.name, arguments: { ...input, password: 'not-a-credential' } })
      .catch(() => ({ isError: true }));
    assert.equal(invalid.isError, true);
    assert.equal(seen.length, 1);
    const plan = { ...input, action: 'import-plan', toolNames: ['lookup'] };
    await client.callTool({ name: tool.name, arguments: plan });
    assert.deepEqual(seen[1], { ...plan, auth: 'auto' });
    const missingNames = await client.callTool({ name: tool.name, arguments: { ...input, action: 'import-plan' } })
      .catch(() => ({ isError: true }));
    assert.equal(missingNames.isError, true);
    assert.equal(seen.length, 2);
  } finally { await close(); }
});

// The MCP surface of the tenant-aware access, over an in-memory transport and a recording fake of OdcAccess.
test('access tools: one per capability, writes need words and a UUID, no credential argument exists', async () => {
  const seen = [];
  const method = name => async input => { seen.push([name, input]); return { ok: name !== 'write', echo: name }; };
  const access = Object.fromEntries(['authStatus', 'read', 'write', 'receipt', 'portalRead', 'portalWrite', 'portalLogin', 'portalRoutes', 'operationStatus', 'deploy', 'configurations', 'assetDelete', 'externalDbConnection'].map(n => [n, method(n)]));
  const { client, close } = await connect(access);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), [...ACCESS_TOOLS].sort());
    for (const tool of tools) {
      // confirmationToken (CX15) is the token of a preview, not a credential.
      assert.equal(Object.keys(tool.inputSchema.properties ?? {}).some(k => k !== 'confirmationToken' && /password|secret|token|clientId|cookie/i.test(k)), false, tool.name);
      if (['odc_write', 'odc_portal_write', 'odc_deploy', 'odc_asset_delete'].includes(tool.name)) {
        assert.equal(tool.annotations.destructiveHint, true, tool.name);
        // CX15: a destructive call without confirmationToken previews; the words and the UUID serve the execution.
        assert.ok(['authorize', 'operationUuid', 'confirmationToken', 'ownerRequest'].every(k => tool.inputSchema.properties[k] && !(tool.inputSchema.required ?? []).includes(k)), tool.name);
      }
    }
    assert.deepEqual(tools.find(t => t.name === 'odc_read').inputSchema.properties.auth.enum, ['auto', 'studio', 'api-client']);
    assert.deepEqual(tools.find(t => t.name === 'odc_portal_read').inputSchema.properties.auth.enum, ['auto', 'studio', 'portal-credential']);
    const read = await client.callTool({ name: 'odc_read', arguments: { tenant: 'personal-x.outsystems.dev', operationId: 'portfolio-api-v2:get:/environments' } });
    assert.equal(read.structuredContent.echo, 'read');
    assert.deepEqual(seen.at(-1), ['read', { tenant: 'personal-x.outsystems.dev', operationId: 'portfolio-api-v2:get:/environments', auth: 'auto' }]);
    const write = await client.callTool({ name: 'odc_write', arguments: { operationId: 'x', authorize: 'the user said yes', operationUuid: '11111111-1111-4111-8111-111111111111' } });
    assert.equal(write.isError, true);
    const refused = await client.callTool({ name: 'odc_write', arguments: { operationId: 'x', authorize: 'the user said yes', operationUuid: 'nope' } })
      .catch(error => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(refused.isError, true); assert.equal(seen.filter(s => s[0] === 'write').length, 1);
    const extra = await client.callTool({ name: 'odc_external_db_connection', arguments: { action: 'create', password: 'x' } })
      .catch(error => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(extra.isError, true); assert.equal(seen.some(s => s[0] === 'externalDbConnection'), false);
  } finally { await close(); }
});

// Lane extlib: odc_asset_delete names the consumer rule (read before anything is reserved) and odc_portal_write lists
// the External Library publish route; a consumers refusal reaches the client as a refusal with its consumers.
test('odc_asset_delete states the consumers rule and forwards CONSUMERS_WOULD_BREAK; odc_portal_write lists externalLibraries.publishJob', async () => {
  const access = { assetDelete: async () => ({ ok: false, code: 'CONSUMERS_WOULD_BREAK', sent: false, consumers: ['OrdersApp'], error: { code: 'CONSUMERS_WOULD_BREAK', message: 'OrdersApp would break' },
    problems: [{ code: 'CONSUMERS_WOULD_BREAK', target: 'OrdersApp', message: 'm', fix: 'f', ssamRule: true }] }) };
  for (const name of ['authStatus', 'read', 'write', 'receipt', 'portalRead', 'portalWrite', 'portalLogin', 'portalRoutes', 'operationStatus', 'deploy', 'configurations', 'externalDbConnection']) access[name] = async () => ({ ok: true });
  const { client, close } = await connect(access);
  try {
    const tools = (await client.listTools()).tools;
    const del = tools.find(t => t.name === 'odc_asset_delete');
    assert.match(del.description, /every consumer/); assert.match(del.description, /CONSUMERS_WOULD_BREAK/); assert.match(del.description, /DEPENDENCY_CHECK_UNAVAILABLE/);
    assert.doesNotMatch(del.description, /Consider odc_write dependency-management deletion-analyses first/);
    assert.match(tools.find(t => t.name === 'odc_portal_write').description, /externalLibraries\.publishJob/);
    // Library release (live demo 2026-10-14: the model did not find it): the routes, the exact input and the prerequisites.
    const write = tools.find(t => t.name === 'odc_portal_write').description, read = tools.find(t => t.name === 'odc_portal_read').description;
    assert.match(write, /libraries\.release \(/); assert.match(write, /ApplicationKey, Revision, Version:"x\.y\.z", ReleaseNotes/);
    assert.match(write, /untagged revision/); assert.match(write, /Finished publication/); assert.match(write, /preExisting:true/);
    assert.match(read, /libraries\.releaseSettings/); assert.match(read, /libraries\.releaseRevision/);
    const out = await client.callTool({ name: 'odc_asset_delete', arguments: { assetKey: 'lib-1', authorize: 'delete SSAMTextTools now', operationUuid: '11111111-1111-4111-8111-111111111111' } });
    assert.equal(out.isError, true); assert.equal(out.structuredContent.code, 'CONSUMERS_WOULD_BREAK'); assert.deepEqual(out.structuredContent.consumers, ['OrdersApp']);
  } finally { await close(); }
});

test('odc_portal_routes: a read tool with the Portal auth enum that passes tenant, auth, module, view and match through', async () => {
  const seen = [];
  const { client, close } = await connect({ portalRoutes: async input => { seen.push(input); return { ok: true, tenant: input.tenant, module: input.module, screens: [], actions: [], truncated: false }; } });
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'odc_portal_routes');
    assert.ok(tool, 'odc_portal_routes is listed');
    assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false); assert.equal(tool.annotations.idempotentHint, true);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['auth', 'match', 'module', 'tenant', 'view']);
    assert.deepEqual(tool.inputSchema.required, ['module']);
    assert.deepEqual(tool.inputSchema.properties.auth.enum, ['auto', 'studio', 'portal-credential']);
    assert.doesNotMatch(tool.description, CLI);
    const args = { tenant: 'personal-x.outsystems.dev', auth: 'portal-credential', module: 'connections', view: 'Connections.connection', match: 'Delete' };
    const out = await client.callTool({ name: 'odc_portal_routes', arguments: args });
    assert.equal(out.isError, undefined); assert.deepEqual(seen.at(-1), args);
    await client.callTool({ name: 'odc_portal_routes', arguments: { module: 'apps' } });
    assert.deepEqual(seen.at(-1), { module: 'apps', auth: 'auto' });
    const unknown = await client.callTool({ name: 'odc_portal_routes', arguments: { module: 'apps', url: 'https://x' } }).catch(error => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(unknown.isError, true); assert.equal(seen.length, 2);
    // No tool description tells the model to run a command line.
    for (const t of (await client.listTools()).tools) assert.doesNotMatch(t.description, CLI, t.name);
  } finally { await close(); }
});

// The real OdcAccess behind the tools, on fakes of the ODC Studio bridge (auth-status, portal-session), the vault and
// the prompt: nothing here reaches a Studio, a vault, a tenant or a window.
const PERSONAL = 'personal-test.outsystems.dev', CORPORATE = 'corp.outsystems.dev';
const ASSETS = {
  '/connections/moduleservices/moduleversioninfo': JSON.stringify({ versionToken: 'v-1' }),
  '/connections/': '<script src="scripts/connections._osbundle-1.index.js"></script>',
  '/connections/scripts/connections._osbundle-1.index.js': 'x={screenName:"Connections.connections"},{screenName:"Connections.connection",load:()=>import("./connections.Connections.connection.mvc.js")}',
  '/connections/scripts/connections.Connections.connection.mvc.js': '"screenservices/connections/Connections/connection/ActionFixture_Delete","av1";"screenservices/connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB","av2";"screenservices/other/X/y/ActionZ","av3"',
};
function realAccess({ apiClient = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odc-access-mcp-'));
  const calls = [], gets = [], requests = new Map(), prompts = [];
  let n = 0;
  const studio = { running: async () => true, call: async args => {
    calls.push(args);
    if (args[0] === 'auth-status') return { ok: true, bridge: 'headless-test', capabilities: ['portal-session:headless'], sessions: [{ host: PERSONAL, loggedIn: true, user: 'dev@example.test' }], portalWindows: [] };
    if (args[0] === 'portal-session' && args[1] === 'fetch') {
      const request = requests.get(args[2]); gets.push(request);
      return Object.hasOwn(ASSETS, request.path) ? { ok: true, status: 200, host: PERSONAL, text: ASSETS[request.path] } : { ok: false, code: 'REMOTE_ERROR' };
    }
    if (args[0] === 'portal-session') return { ok: true, host: args.at(-1), signedIn: true };
    if (args[0] === 'portal-call') throw new Error('no public call in this test');
    return { ok: false, error: 'Unknown command' };
  } };
  const vault = { apiClient: async () => ({ available: apiClient }), portal: async () => ({ available: false }), bridge: async () => { throw new Error('no vault in this test'); } };
  const prompt = { apiClient: async host => { prompts.push(host); return { opened: true }; }, portal: async host => { prompts.push(host); return { opened: true }; } };
  const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: PERSONAL, tenants: { [PERSONAL]: { class: 'personal' }, [CORPORATE]: { class: 'corporate' } } },
    studio, vault, prompt, portalBroker: () => ({ available: false, authenticated: false, initialize: async () => {}, status: () => ({}) }),
    receipts: new WriteJournal(path.join(dir, 'receipts')), sleep: async () => {},
    requestFile: json => { const file = path.join(dir, 'req-' + (++n) + '.json'); requests.set(file, json); return file; } });
  return { access, calls, gets, prompts };
}

test('odc_portal_routes on the real access: short answer, GETs only, refused modules never touch a session', async () => {
  const h = realAccess();
  const { client, close } = await connect(h.access);
  try {
    const out = (await client.callTool({ name: 'odc_portal_routes', arguments: { tenant: PERSONAL, module: 'connections', view: 'Connections.connection' } })).structuredContent;
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(Object.keys(out).sort(), ['actions', 'module', 'next', 'ok', 'screens', 'tenant', 'truncated', 'view']);
    assert.deepEqual([out.tenant, out.module, out.view, out.truncated], [PERSONAL, 'connections', 'Connections.connection', false]);
    assert.deepEqual(out.screens, ['Connections.connection', 'Connections.connections']);
    assert.deepEqual(out.actions, [{ action: 'connections/Connections/connection/ActionFixture_Delete', mapped: false },
      { action: 'connections/ProviderBlocks/Connection_Edit_RelationalDB/ActionConnection_Convert_RelationalDB', mapped: true }]);
    assert.doesNotMatch(out.next, CLI);
    assert.ok(h.gets.length > 0 && h.gets.every(g => g.method === 'GET' && g.write === false && g.body === undefined), 'GETs only');
    const plain = (await client.callTool({ name: 'odc_portal_routes', arguments: { tenant: PERSONAL, module: 'connections', view: 'Connections.connection', match: 'convert' } })).structuredContent;
    assert.deepEqual(plain.actions.map(a => a.mapped), [true]); assert.equal(plain.next, undefined); assert.equal('view' in plain, true);
    const before = h.calls.length;
    for (const module of ['authentication', 'identity', 'api', 'Identity', ' API ', '../connections']) {
      const refused = await client.callTool({ name: 'odc_portal_routes', arguments: { tenant: PERSONAL, module } });
      assert.equal(refused.isError, true, module); assert.equal(refused.structuredContent.error.code, 'INPUT_INVALID', module);
    }
    assert.equal(h.calls.length, before, 'a refused module reaches no bridge, session or prompt'); assert.deepEqual(h.prompts, []);
  } finally { await close(); }
});

test('refusals answer code and one callable continuation {tool, arguments, why}, never a command line', async () => {
  const h = realAccess({ apiClient: true });
  const { client, close } = await connect(h.access);
  try {
    // An unmapped route: the continuation is its capture step, with the tenant, at the top of the answer.
    for (const id of Object.keys(PORTAL_CAPTURE)) {
      const out = (await client.callTool({ name: 'odc_portal_write', arguments: { tenant: PERSONAL, operationId: id, input: {}, authorize: 'yes, do it on the personal tenant', operationUuid: crypto.randomUUID() } })).structuredContent;
      assert.equal(out.code, 'PORTAL_ROUTE_UNMAPPED', id); assert.equal(out.error.continuation, undefined, id);
      assert.deepEqual(out.continuation.tool, 'odc_portal_routes'); assert.deepEqual(out.continuation.arguments, { ...PORTAL_CAPTURE[id], tenant: PERSONAL });
      assert.equal(typeof out.continuation.why, 'string'); assert.doesNotMatch(JSON.stringify(out), CLI, id);
    }
    // While connections.delete is a gap (W17 pending), the typed helper refuses it the same way and the step is callable as it stands.
    if (PORTAL_CAPTURE['connections.delete']) {
      const del = (await client.callTool({ name: 'odc_external_db_connection', arguments: { tenant: PERSONAL, action: 'delete', connectionId: 'c-1' } })).structuredContent;
      assert.equal(del.code, 'PORTAL_ROUTE_UNMAPPED'); assert.deepEqual(del.continuation.arguments, { ...PORTAL_CAPTURE['connections.delete'], tenant: PERSONAL });
      const step = await client.callTool({ name: del.continuation.tool, arguments: del.continuation.arguments });
      assert.equal(step.structuredContent.ok, true, JSON.stringify(step.structuredContent));
      assert.deepEqual(step.structuredContent.actions, [{ action: 'connections/Connections/connection/ActionFixture_Delete', mapped: false }]);
    }
    // A retry sentence of the access layer becomes this tool with the other auth; a write's words are never echoed.
    const read = (await client.callTool({ name: 'odc_read', arguments: { tenant: CORPORATE, operationId: 'asset-repository-api-v1:get:/assets' } })).structuredContent;
    assert.equal(read.code, 'STUDIO_NOT_SIGNED_IN');
    assert.deepEqual(read.continuation.arguments, { tenant: CORPORATE, operationId: 'asset-repository-api-v1:get:/assets', auth: 'api-client' });
    assert.equal(read.continuation.tool, 'odc_read'); assert.match(read.continuation.why, /auth:"api-client"/);
    const words = 'yes, delete it on corp now';
    const write = (await client.callTool({ name: 'odc_write', arguments: { tenant: CORPORATE, operationId: 'asset-repository-api-v1:delete:/assets/{assetKey}', path: { assetKey: 'a-1' },
      authorize: words, operationUuid: crypto.randomUUID(), confirmTenant: CORPORATE } })).structuredContent;
    assert.equal(write.code, 'STUDIO_NOT_SIGNED_IN'); assert.equal(write.continuation.tool, 'odc_write'); assert.equal(write.continuation.arguments.auth, 'api-client');
    assert.equal('authorize' in write.continuation.arguments, false); assert.match(write.continuation.why, /authorize/);
    assert.doesNotMatch(JSON.stringify(write.continuation), new RegExp(words));
  } finally { await close(); }
});

test('native package MCP accepts exact receipt identity and refuses arbitrary download URLs',async()=>{
 const seen=[];const {client,close}=await connect({nativePackage:async input=>{seen.push(input);return {ok:true};}});
 try{const input={tenant:'corp.outsystems.dev',operationKey:crypto.randomUUID(),operationUuid:crypto.randomUUID()};
 assert.equal((await client.callTool({name:'odc_native_package',arguments:input})).structuredContent.ok,true);assert.deepEqual(seen,[input]);
 const refused=await client.callTool({name:'odc_native_package',arguments:{...input,url:'https://example.test/unsafe'}}).catch(()=>({isError:true}));assert.equal(refused.isError,true);assert.equal(seen.length,1);
 }finally{await close();}
});

test('environment defaults MCP routes explicit context to its state-bound guard',async()=>{
 const seen=[];const {client,close}=await connect({write:async(...args)=>{seen.push(args);return {ok:true};}});
 try{
  const input={tenant:'corp.outsystems.dev',operationId:'asset-configurations-api-v1:patch:/environments/{environmentKey}/default-system-configurations',path:{environmentKey:crypto.randomUUID()},body:{systemConfigurations:[{key:'Name',value:'Temporary'}]},authorize:'Synthetic approved change',operationUuid:crypto.randomUUID(),authorizationContext:'approved.json'};
  assert.equal((await client.callTool({name:'odc_write',arguments:input})).structuredContent.ok,true);
  assert.deepEqual(seen[0][1],{environmentDefaultsContext:'approved.json'});
  assert.equal(seen[0][0].authorizationContext,undefined);
 }finally{await close();}
});


test('application-role grant and revocation pass both fixture receipts outside the request body',async()=>{
 const seen=[];const {client,close}=await connect({write:async(input,options)=>{seen.push({input,options});return{ok:true};}});
 try{for(const method of ['post','delete']){
  const input={operationId:`user-access-management-api-v1:${method}:/users/{key}/application-roles/{roleKey}`,tenant:'corp.outsystems.dev',auth:'api-client',
   path:{key:crypto.randomUUID(),roleKey:crypto.randomUUID()},authorize:'Synthetic own fixture role proof',operationUuid:crypto.randomUUID(),
   originOperationUuid:crypto.randomUUID(),userOriginOperationUuid:crypto.randomUUID(),authorizationContext:'C:/private/approval.json'};
  assert.equal((await client.callTool({name:'odc_write',arguments:input})).structuredContent.ok,true);
  const got=seen.at(-1);assert.deepEqual(got.options,{applicationRoleAssignmentContext:input.authorizationContext,originOperationUuid:input.originOperationUuid,userOriginOperationUuid:input.userOriginOperationUuid});
  assert.equal(got.input.body,undefined);assert.equal(got.input.originOperationUuid,undefined);assert.equal(got.input.authorizationContext,undefined);
 }}finally{await close();}
});

test('group role assignment routes all three origins outside the native request',async()=>{
 const seen=[];const {client,close}=await connect({write:async(input,options)=>{seen.push({input,options});return{ok:true};}});
 try{
  const input={operationId:'user-access-management-api-v1:patch:/groups/{key}/application-roles',tenant:'corp.outsystems.dev',auth:'api-client',
   path:{key:crypto.randomUUID()},body:{applicationRoleKeysToAdd:[crypto.randomUUID()],applicationRoleKeysToRemove:[]},authorize:'Synthetic own group role fixture proof',operationUuid:crypto.randomUUID(),
   originOperationUuid:crypto.randomUUID(),groupOriginOperationUuid:crypto.randomUUID(),userOriginOperationUuid:crypto.randomUUID(),authorizationContext:'C:/private/approval.json'};
  assert.equal((await client.callTool({name:'odc_write',arguments:input})).structuredContent.ok,true);
  assert.deepEqual(seen[0].options,{groupRoleAssignmentContext:input.authorizationContext,originOperationUuid:input.originOperationUuid,groupOriginOperationUuid:input.groupOriginOperationUuid,userOriginOperationUuid:input.userOriginOperationUuid});
  for(const key of ['originOperationUuid','groupOriginOperationUuid','userOriginOperationUuid','authorizationContext'])assert.equal(seen[0].input[key],undefined);
  assert.deepEqual(seen[0].input.body,input.body);
 }finally{await close();}
});

test('direct role overlap selects the owned-group guard without forwarding fixture origins',async()=>{
 const seen=[];const {client,close}=await connect({write:async(input,options)=>{seen.push({input,options});return{ok:true};}});
 try{for(const method of ['post','delete']){
  const input={operationId:`user-access-management-api-v1:${method}:/users/{key}/application-roles/{roleKey}`,tenant:'corp.outsystems.dev',auth:'api-client',path:{key:crypto.randomUUID(),roleKey:crypto.randomUUID()},
   authorize:'Synthetic own direct inherited overlap',operationUuid:crypto.randomUUID(),originOperationUuid:crypto.randomUUID(),groupOriginOperationUuid:crypto.randomUUID(),userOriginOperationUuid:crypto.randomUUID(),authorizationContext:'C:/private/approval.json'};
  assert.equal((await client.callTool({name:'odc_write',arguments:input})).structuredContent.ok,true);
  assert.deepEqual(seen.at(-1).options,{applicationRoleOverlapContext:input.authorizationContext,originOperationUuid:input.originOperationUuid,groupOriginOperationUuid:input.groupOriginOperationUuid,userOriginOperationUuid:input.userOriginOperationUuid});
  assert.equal(seen.at(-1).input.groupOriginOperationUuid,undefined);assert.equal(seen.at(-1).input.body,undefined);
 }}finally{await close();}
});
