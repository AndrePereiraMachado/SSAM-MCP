import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { serverInstructions, SESSION_RULES, sessionGuide } from '../server-instructions.mjs';
import { createSsamServer } from '../ssam.mjs';
import { createFacadeServer } from '../mcp.mjs';
import { rulesAnswer } from '../ssam-reference.mjs';
import { guideText } from '../runtime-guides.mjs';
async function connected(make, fn) {
 const server=await make(); const [a,b]=InMemoryTransport.createLinkedPair(); const client=new Client({name:'instruction-budget-test',version:'1'});
 await Promise.all([server.connect(a),client.connect(b)]);
 try { return await fn(client); } finally { await client.close(); await server.close(); }
}
test('B1 every profile emits at most 2000 chars and keeps delivery/refusal in the prefix', async()=>{
 for(const profile of ['app','debug','all']) await connected(()=>createSsamServer({profile,o11:false,odc:false}), client=>{
   const text=client.getInstructions(); assert.equal(text,serverInstructions({profile})); assert.ok(text.length<=2000,profile);
   if(profile!=='debug'){assert.match(text,/ONE o11_deliver\/studio_deliver call with EVERY/);assert.match(text,/patch \+ basedOn/);assert.match(text,/never resend the whole job/);}
 });
 await connected(()=>createFacadeServer(), client=>{assert.equal(client.getInstructions(),serverInstructions({profile:'odc-facade'}));assert.ok(client.getInstructions().length<=2000);assert.match(client.getInstructions(),/ONE studio_deliver per module with ALL changes/);assert.match(client.getInstructions(),/patch \+ basedOn/);});
});
test('B1 generated session rules travel intact through the MCP reference on both lanes', async()=>{
 await connected(()=>createSsamServer({o11:false,odc:false}), async client=>{
  for(const lane of ['o11','odc']) {const r=await client.callTool({name:'ssam_reference',arguments:{lane,kind:'rules',query:'session'}});assert.equal(r.isError,undefined);assert.equal(r.structuredContent.text,sessionGuide());}
 });
});
test('B1 all rules remain reachable exactly through generated session guide and both reference lanes',()=>{
 assert.equal(new Set(SESSION_RULES.map(r=>r.id)).size,SESSION_RULES.length);
 assert.equal(guideText('session'),sessionGuide());
 const createRule=SESSION_RULES.find(r=>r.id==='odc-create').text;
 assert.match(createRule,/publishes only with publish:true when requested/);
 assert.match(createRule,/default publish:false/);
 for(const lane of ['o11','odc']) {const r=rulesAnswer(lane,'session');assert.equal(r.ok,true);assert.equal(r.doc,'session');for(const rule of SESSION_RULES)assert.ok(r.text.includes(rule.text),rule.id);}
 const essential=['tools','deferred','connect','discover','deliver','refusal','queue','authorize','links','data','detail'];
 for(const id of essential)assert.ok(SESSION_RULES.some(r=>r.id===id),id);
 for(const id of ['identity','discovery-contract','packet','digest','keys','flow','code','code-parts','plan','cross-cutting','evidence','queue-timeout','delivery-phases','delivered','refusal-details','fixture','studio-state','portal-auth','odc-start','odc-deliver','odc-separate','odc-create','odc-producer','odc-portal','odc-writes','odc-live','odc-gates','continuation','native-bridge','map-filters','url-details'])assert.ok(SESSION_RULES.some(r=>r.id===id),id);
});


test('B1 the complete literal 55a9b647 instructions have audited clause coverage in SESSION_RULES',async()=>{
 const fs=await import('node:fs');const{createHash}=await import('node:crypto');
 const baseline=JSON.parse(fs.readFileSync(new URL('./fixtures/session-rule-baseline.json',import.meta.url),'utf8'));
 assert.equal(baseline.sourceCommit,'55a9b647');assert.equal(baseline.sources.find(s=>s.server==='ssam').chars,4939);
 for(const source of baseline.sources){
  assert.equal(source.original.length,source.chars);assert.equal(createHash('sha256').update(source.original).digest('hex'),source.sha256);
  assert.equal(source.coverage.map(c=>c.original).join(''),source.original,'coverage partitions every original character: '+source.server);
  for(const clause of source.coverage){
   assert.ok(clause.original.trim());assert.ok(clause.ruleIds.length);
   const replacement=clause.ruleIds.map(id=>{const rule=SESSION_RULES.find(r=>r.id===id);assert.ok(rule,source.server+' '+id);return rule.text;}).join(' ').toLowerCase();
   for(const fact of clause.preserves)assert.ok(replacement.includes(fact.toLowerCase()),source.server+' original '+JSON.stringify(clause.original.slice(0,70))+' must preserve '+fact);
  }
 }
});

test('A2 the original fifteen-schema select stays whenever it fits with the eleven essential rules',()=>{
 const names=["ssam_doctor","ssam_connect","ssam_discover","ssam_map","ssam_code","ssam_reference","ssam_evidence","ssam_task","o11_inspect","o11_deliver","o11_publish","o11_studio","studio_deliver","studio_inspect","studio_status"];
 const essential=['tools','deferred','connect','discover','deliver','refusal','queue','authorize','links','data','detail'];
 const select='select:'+names.map(n=>'mcp__ssam__'+n).join(',');
 const deferred='Clients that defer schemas: ONE search "'+select+'" (replace ssam with your server prefix).';
 const minimum=essential.map(id=>id==='deferred'?deferred:SESSION_RULES.find(r=>r.id===id).text).join(' ')+' All session rules: ssam_reference {lane,kind:"rules",query:"session"}.';
 assert.ok(minimum.length<=2000,'fifteen tools fit: '+minimum.length);
 for(const profile of ['app','all']) {const text=serverInstructions({profile});assert.ok(text.includes(select),profile+' must keep the fitting select');}
});
