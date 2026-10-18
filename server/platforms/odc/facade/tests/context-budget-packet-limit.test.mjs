import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { INDEX_SCHEMA, identityKey, query } from '../discovery.mjs';
import { discoverAll } from '../tool-routing.mjs';
import { capabilitiesSection } from '../work-packet.mjs';

function restored(value,missing){
  let out=structuredClone(value);
  for(const change of missing){
    const keys=change.path?change.path.slice(1).split('/').map(k=>k.replace(/~1/g,'/').replace(/~0/g,'~')):[];
    let parent=out;for(const key of keys.slice(0,-1))parent=parent[key];const key=keys.at(-1);
    if(change.op==='text'){const current=keys.length?parent[key]:out;assert.equal(current.length,change.offset);if(keys.length)parent[key]+=change.value;else out+=change.value;}
    else if(!keys.length)out=structuredClone(change.value);
    else if(change.op==='remove'){if(Array.isArray(parent))parent.splice(Number(key),1);else delete parent[key];}
    else parent[key]=structuredClone(change.value);
  }return out;
}

// A complete synthetic index, keyed through the production cache contract. Every
// native source is absent: a cache miss fails rather than invoking a CLI/Studio.
function fixture(t, lane, count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packet-limit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = { lane, kernel: root, cacheDir: root, descriptor: path.join(root,'descriptor.json'),
    fragments: path.join(root,'fragments'), shared: path.join(root,'absent-shared.json'),
    cli: path.join(root,'NO-CLI.dll'), kernelDll: path.join(root,'NO-KERNEL.dll'), studioDir: path.join(root,'NO-STUDIO'),
    fixture: path.join(root,'NO-FIXTURE.oml'), modelApiDir: path.join(root,'NO-API'), jobsDir: path.join(root,'NO-JOBS'),
    negativeDir: path.join(root,'NO-NEGATIVES'), testWork: path.join(root,'NO-RESULTS'), naoDa: path.join(root,'NO-LIMITS') };
  fs.mkdirSync(sources.fragments);
  const descriptor = Buffer.from(JSON.stringify({lane,capabilities:[]}));
  fs.writeFileSync(sources.descriptor,descriptor);
  const key = identityKey(sources, descriptor);
  const capabilities = Array.from({length:count},(_,i)=>({ id:'fixture.widget'+i, category:'ui', title:'Widget '+i,
    keywords:['widget'], route:{kind:'job'}, contract:[], guidance:'Keep this complete widget contract. '.repeat(70) }));
  const index = {schemaVersion:INDEX_SCHEMA,lane,key,capabilities,contracts:{},jobs:[],negatives:[],limits:[],synonyms:{},unavailable:[],routes:{},
    identity:{cli:{},studio:{},fixture:{},descriptor:{},jobs:{results:0},nativeRuntime:{}}};
  fs.writeFileSync(path.join(root,'index-'+key+'.json'),JSON.stringify(index));
  const digest = async target => ({ok:true,target,file:target,sourceSha256:'a'.repeat(64),digest:{module:{name:'Fixture'},sections:[],actions:[]}});
  return {sources,digest,index};
}

test('A6 packet recover and budget continuation preserve limit with app and nine or ten real matches',async t=>{
  for (const lane of ['o11','odc']) for(const count of [9,10]) {
    const {sources,digest,index}=fixture(t,lane,count);
    const args={lane,intent:'widget',app:'Fixture.oml',packet:true,limit:12};
    assert.equal(query(index,args).matches.filter(m=>m.via==='match').length,count);
    const engine=arguments_=>discoverAll({...arguments_,sources,digest,textRoutes:false,producerCache:null});
    const server=await createSsamServer({deps:{odcFacade:async()=>{
      const facade=new McpServer({name:'offline-limit',version:'1'});
      facade.registerTool('ssam_discover',{inputSchema:z.object({lane:z.enum(['o11','odc']),intent:z.string(),app:z.string(),packet:z.boolean(),limit:z.number().default(8),expand:z.string().optional(),budgetBytes:z.number().optional()})},async args=>{
        const value=await engine(args);return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
      });return facade;
    }}});
    const client=new Client({name:'a6-packet-limit',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(a),client.connect(b)]);
    t.after(async()=>{await client.close();await server.close();});
    const run=async arguments_=>{const response=await client.callTool({name:'ssam_discover',arguments:arguments_});return response.structuredContent??JSON.parse(response.content[0].text);};
    const packet=await run(args);
    assert.equal(packet.ok,true,JSON.stringify(packet));
    const cuts=packet.cuts.filter(c=>c.section==='capabilities');
    assert.ok(cuts.length,'fixture must cut capabilities');
    const missing=[];
    for(const cut of cuts){
      assert.equal(cut.recover.arguments.limit,12,'recovery retains the content-changing limit');
      assert.equal(cut.recover.arguments.app,args.app);
      const part=await run(cut.recover.arguments);
      assert.equal(part.ok,true,JSON.stringify(part));
      missing.push(...part.missing);
      assert.deepEqual(part,await run({...cut.recover.arguments,...args,expand:cut.recover.arguments.expand,budgetBytes:cut.recover.arguments.budgetBytes}));
      assert.equal((await run({...cut.recover.arguments,limit:8})).code,'PACKET_SOURCE_CHANGED','control: changing limit really changes the nine/ten-match section');
    }
    const expected=JSON.parse(JSON.stringify(capabilitiesSection({intent:args.intent,matches:query(index,args).matches,
      categories:new Map(index.capabilities.map(c=>[c.id,c.category])),slices:()=>({})},Infinity,{lane}).value));
    assert.deepEqual(restored(packet.capabilities,missing),expected,'recover every item and contract exactly');
    const small=await run({...args,budgetBytes:1000});
    assert.equal(small.code,'PACKET_BUDGET_TOO_SMALL');
    assert.ok(small.continuation);
    assert.equal(small.continuation.arguments.limit,12);
    assert.equal(small.continuation.arguments.app,args.app);
    const retried=await run(small.continuation.arguments);
    assert.equal(retried.ok,true,JSON.stringify(retried));
    assert.deepEqual(retried,await run({...small.continuation.arguments,limit:12}));
    const complete=await run({...small.continuation.arguments,budgetBytes:28672});
    assert.equal(complete.capabilities.matched,count);
  }
});
