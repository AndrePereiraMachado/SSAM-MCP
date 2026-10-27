import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {composeTraditionalTask} from '../traditional-compose.mjs';
import {traditionalCatalog} from '../traditional-tasks.mjs';
import {composition} from './fixtures/traditional-data-events.mjs';
import {composition as namedEvents} from './fixtures/traditional-named-events.mjs';
import {registerSsamReference} from '../ssam-reference.mjs';
import {tempKernel,linked} from './fixtures/o11env-kernel.mjs';

test('MCP composes a complete job regardless of request language and rejects competing modes',async t=>{
 const kernel=tempKernel({cli:false}),mcp=await linked(registerSsamReference,{root:kernel.root,env:kernel.env});
 t.after(async()=>{await mcp.close();kernel.cleanup();});
 const query={traditionalTask:'利用者が実際に操作できる画面を作る',compose:composition};
 const r=await mcp.call('ssam_reference',{lane:'o11',kind:'recipe',query});
 assert.equal(r.ok,true);assert.equal(r.verified,false);assert.deepEqual(r.job,composeTraditionalTask(composition));
 assert.equal((await mcp.call('ssam_reference',{lane:'o11',kind:'recipe',query:{...query,bind:{}}})).code,'QUERY_SHAPE');
 assert.equal((await mcp.call('ssam_reference',{lane:'odc',kind:'recipe',query})).code,'TRADITIONAL_NOT_IN_LANE');
});

test('complete composition binds nested inputs, queries and notification handlers',()=>{
 const {ops}=composeTraditionalTask(composition);
 assert.ok(ops.some(o=>o.op==='spec'&&o.data.ddl.includes('create entity AuditWidgetItem')));
 assert.ok(ops.some(o=>o.prop==='Variable'&&o.value==='Draft.Name'));
 assert.ok(ops.some(o=>o.prop==='SourceRecordList'&&o.value==='Rows'));
 assert.ok(ops.some(o=>o.target?.endsWith('/OnNotify')&&o.value.endsWith(':PageRows')));
 assert.ok(ops.some(o=>o.target?.endsWith('/OnNotify')&&o.value.endsWith(':SortRows')));
 assert.ok(ops.some(o=>o.prop==='Action'&&o.value==='IServerAction:AuditWidgetList'));
 assert.ok(ops.some(o=>o.op==='logic'&&o.data.flow.includes('AuditWidgetSave(Record=Draft)')));
 for(const o of ops.filter(o=>o.type==='IWebBlockInstanceWidget'))assert.match(o.source,/^IWebBlock:/);
});
test('declared event handlers bind renamed typed arguments; mandatory handlers cannot be omitted',()=>{
 const {ops}=composeTraditionalTask(namedEvents);
 assert.equal(ops.filter(o=>o.prop==='Handler').length,3);
 assert.ok(ops.some(o=>o.target?.endsWith('/OnSelect/Value')&&o.value==='StartDate'));
 assert.ok(ops.some(o=>o.target?.endsWith('/OnChange/Value')&&o.value==='SelectedValue'));
 const c=structuredClone(namedEvents),slider=c.content.find(n=>n.component==='RangeSlider');
 delete slider.events.OnChange;assert.throws(()=>composeTraditionalTask(c),/Missing mandatory event/);
 slider.events.OnChange={action:'ChooseAmount'};assert.throws(()=>composeTraditionalTask(c),/Bind event parameters/);
});
test('composition rejects silent missing bindings and wrong technology slots',()=>{
 const bad=()=>structuredClone(composition);
 let c=bad();c.flows=c.flows.replace('action WidgetDataAudit.PageRows','action WidgetDataAudit.Other');assert.throws(()=>composeTraditionalTask(c),/Missing handler/);
 c=bad();c.content[1].slots.Children=[];assert.throws(()=>composeTraditionalTask(c),/Unknown placeholder/);
 c=bad();c.content[1].inputs.Wrong='True';assert.throws(()=>composeTraditionalTask(c),/Unknown input/);
 c=bad();c.content[1].events.OnChange='SearchRows';assert.throws(()=>composeTraditionalTask(c),/Unsupported Traditional/);
 c=bad();c.content[1].component='ReactiveOnlyMissing';assert.throws(()=>composeTraditionalTask(c),/Unknown public/);
});
test('every public catalog block is composable with contract inputs and nested slot content; structural coverage only',()=>{
 let count=0;
 for(const catalog of traditionalCatalog())for(const block of catalog.data.Blocks.filter(b=>b.Public)){
  const c={screen:{name:'Probe',flow:'MainFlow',title:'Probe'},flows:(block.Events??[]).map((e,i)=>'action Probe.Event'+i+'\n  end').join('\n'),content:[{type:'component',name:'Widget',library:catalog.library,component:block.Name,
   events:Object.fromEntries((block.Events??[]).map((e,i)=>[e.Name,{action:'Event'+i,arguments:Object.fromEntries((e.Params??[]).map(p=>[p.Name,p.Name]))}])),
   inputs:Object.fromEntries((block.Inputs??[]).filter(i=>i.Mandatory&&i.Default==null).map(i=>[i.Name,'ResolvedExpression'])),
   slots:Object.fromEntries((block.Placeholders??[]).map((p,i)=>[p.Name,[{type:'expression',name:'Slot'+i,value:'"Content"'}]]))}]};
  assert.ok(composeTraditionalTask(c).ops.some(o=>o.source==='IWebBlock:'+block.Name));count++;
 }
 assert.ok(count>=125);
});
