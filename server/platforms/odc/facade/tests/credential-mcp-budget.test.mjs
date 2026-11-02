import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer, registerServedTool } from '../ssam.mjs';
import { readOptions } from '../read-budget.mjs';
import { prepareWorkspace, runWithExecutor } from '../executor.mjs';

test('MCP outer budget propagates 120 seconds to private O11 and Portal handlers and retains legacy limits', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'r40-mcp-budget-'));prepareWorkspace(root);
  let supported=true; const observed=[];
  const agent={supports:()=>supported,connected:()=>true,info:()=>({credential:true})};
  const context={hosted:true,workspace:root,tokenId:'budget',customer:'test',lanes:['o11','odc'],agent,executor:{hosted:true,quota:{full:()=>false},o11Connection:()=>null,call:async()=>({})},close:async()=>{}};
  const names=['odc_read','odc_portal_read','o11_service_center_read'];
  const tools=Object.fromEntries(names.map(name=>[name,{class:'server',lane:'none',agent:'never',paths:{in:[],out:[]}}]));
  const identity={root,release:{head:'test',facadeSha256:'test',catalogSha256:'test'}};
  const fakeFacade=async()=>{const fake=new McpServer({name:'budget-fake',version:'1'});
  for(const name of names.filter(x=>x!=='o11_service_center_read'))fake.registerTool(name,{inputSchema:z.object({auth:z.string().optional(),session:z.string().optional()}),annotations:{readOnlyHint:true}},async()=>{
    const timeout=readOptions().timeoutMs;observed.push(timeout);const value={ok:true,timeout};return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
  });
  return fake;};
  const server=await runWithExecutor(context,()=>createSsamServer({o11:false,odc:true,hosted:{context,session:{agent,lanes:context.lanes},tools},deps:{odcRoot:root,odcFacade:fakeFacade,answersRoot:root,identity:{read:()=>identity},writeLock:async(_,fn)=>fn(),o11Operations:{tool:async()=>{const timeout=readOptions().timeoutMs;observed.push(timeout);return {ok:true,timeout};}}}}));
  const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'budget',version:'1'});
  await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
  const check=async(name,args,ceiling)=>{const before=observed.length;await client.callTool({name,arguments:args});assert.equal(observed.length,before+1);assert.ok(observed.at(-1)>ceiling-5000&&observed.at(-1)<=ceiling,`${name}: ${observed.at(-1)}`);};
  await check('odc_read',{auth:'api-client'},120000);
  await check('odc_portal_read',{auth:'portal-credential'},120000);
  await check('o11_service_center_read',{action:'logs',host:'tenant.example.com',session:'vault'},120000);
  await check('odc_portal_read',{auth:'studio'},29000);
  await check('o11_service_center_read',{action:'logs',host:'tenant.example.com',session:'studio'},90000);
  supported=false;await check('odc_read',{auth:'api-client'},29000);
});
