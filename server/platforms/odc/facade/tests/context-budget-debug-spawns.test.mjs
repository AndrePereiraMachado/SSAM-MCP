import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { createMcpSurface } from '../debug-surface-proof.mjs';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
test('A1 real proof MCP child lists both debuggers and shared hook tools without Studio', {timeout:120000}, async()=>{
 let names;
 class ListingClient extends Client {
  async connect(transport){await super.connect(transport);names=new Set((await this.listTools()).tools.map(t=>t.name));}
 }
 const surface=createMcpSurface({root,entry:path.join(root,'facade','ssam.mjs'),runtime:'server',env:{...process.env,SSAM_NO_WARM:'1',ANVIL_WORKER:'0',ANVIL_ODC_NO_WORKER:'1',SSAM_ODC_OFFLINE:'1',SSAM_MCP_PROFILE:'app'},deps:{Client:ListingClient}});
 try{await surface.open();for(const name of ['ssam_debug_server','ssam_debug_client','odc_read','odc_configurations','o11_service_center_read','ssam_map'])assert.ok(names.has(name),name+' absent from actual proof connection');}
 finally{await surface.close();}
});
test('B3 every production ssam MCP spawn expecting debug explicitly selects all for shared hooks',()=>{
 const files=[];
 const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.isDirectory()&&!['tests','node_modules','.local'].includes(e.name))walk(path.join(dir,e.name));else if(e.isFile()&&e.name.endsWith('.mjs'))files.push(path.join(dir,e.name));}};
 for(const dir of ['facade','scripts','platforms/odc/facade'])walk(path.join(root,dir));
 const consumers=[];
 for(const file of files){const text=fs.readFileSync(file,'utf8');if(!text.includes('ssam_debug_'))continue;
  const spawns=[...text.matchAll(/(?:args\s*:\s*|(?:spawn|spawnProcess|spawnSync)\s*\([^,]+,\s*)\[([^\]]*['"]mcp['"][^\]]*)\]/g)];
  for(const spawn of spawns){consumers.push(path.relative(root,file));assert.match(spawn[1],/['"]--profile['"]\s*,\s*['"]all['"]/,path.relative(root,file)+' needs debug and hook tools');}
 }
 assert.ok(consumers.includes(path.join('platforms','odc','facade','debug-surface-proof.mjs')),'proof spawn must be scanned');
});
