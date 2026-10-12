import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Client, Journal } from '../service-center/client.mjs';
import { StudioWebTransport } from '../service-center/http.mjs';
import { main } from '../service-center/index.mjs';
import { serviceCenterArguments } from '../o11-operations.mjs';
import { FakeBridge, SC, fakeVault, html, uuid } from './fixtures/sc-fake-bridge.mjs';
const host = 'sc.example.test';
test('missing export control falls back to the same filtered page, without claiming a file or complete export', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scp-export-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source = html('logs/error-logs.page1.html').replaceAll('Export to excel', 'Unavailable control');
  const bridge = new FakeBridge({pages:{[`GET ${SC}Error_Logs.aspx`]:source}});
  const result = await new Client(fakeVault(host),new StudioWebTransport(host,bridge),dir).logs('error',2,null,{exportAll:true});
  assert.equal(result.export.available,false);
  assert.equal(result.export.code,'SC_EXPORT_UNAVAILABLE');
  assert.equal(result.rows.length,2); assert.equal(result.truncated,true); assert.equal(result.complete,false);
  assert.equal(fs.readdirSync(dir).length,0);
});
test('one property-set intention accepts a nonsecret value and resolves the exact module name internally', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scp-value-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const property=SC+'eSpace_SiteProperty_Edit.aspx?SitePropertyId=501&EspaceId=102';
  let page=html('site-properties/site-property-edit.integer.html');
  const bridge=new FakeBridge({api:{ListEspaces:[{Name:'SampleOrders',Id:102,Key:'module-key'}]},pages:{
    [`GET ${SC}eSpace_Edit.aspx?EspaceId=102`]:html('factory/espace-edit.html'),
    [`GET ${property}`]:()=>page,[`POST ${SC}eSpace_SiteProperty_Edit.aspx`]:()=>{page=html('site-properties/site-property-set.response.html');return page;}
  }});
  const registry=path.join(dir,'hosts.json');fs.writeFileSync(registry,JSON.stringify({hosts:{[host]:{class:'personal'}}}));
  const args=serviceCenterArguments({action:'property-set',host,module:'SampleOrders',name:'MaxBatchSize',value:'500',execute:true,words:'Set MaxBatchSize to 500',operationId:uuid()},'write');
  const result=await main(args,{locate:async()=>bridge,present:async()=>true,running:async()=>true,journal:new Journal(dir),registry});
  assert.equal(result.state,'confirmed',JSON.stringify(result));
  assert.equal(bridge.calls.filter(c=>c[0]==='api'&&c[2]==='ListEspaces').length,1);
  const sends=bridge.writes().length;
  const repeated=await main(args,{locate:async()=>bridge,present:async()=>true,running:async()=>true,journal:new Journal(dir),registry});
  assert.equal(repeated.existingReceipt,true); assert.equal(bridge.writes().length,sends);
});
