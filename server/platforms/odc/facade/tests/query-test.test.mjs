import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { queryTest, queryTestSchema } from '../query-test.mjs';
import { routeTools } from '../tool-routing.mjs';
import { shapeToolResult } from '../responses.mjs';
import { createSsamServer } from '../ssam.mjs';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

const run = (lane = 'o11') => ({ op: 'run', lane, source: 'C:\\captures\\one.oml', expectedSourceSha256: 'a'.repeat(64), moduleKey: 'module', environment: 'personal.example', query: '@query', testValues: { Id: '9223372036854775806' }, ...(lane === 'o11' ? { o11TenantId: 0 } : {}) });
test('run carries explicit values, target, UUID and status continuation without extra calls', async () => {
  let calls = 0;
  const answer = await queryTest(run(), { o11: async r => { calls++; assert.equal(r.testValues.Id, '9223372036854775806'); assert.match(r.operationId,/^[a-f0-9-]{36}$/); return { ok: true, execution: 'native-query', rows: [] }; } });
  assert.equal(calls,1); assert.equal(answer.execution,'native-query'); assert.equal(answer.continuation.arguments.operationId,answer.operationId);
});
test('missing tenant/test values/identity refuses before a transport', async () => {
  for (const key of ['o11TenantId','testValues','source','environment','moduleKey','expectedSourceSha256','query']) {
    const r=run(); delete r[key]; let calls=0;
    const answer=await queryTest(r,{o11:async()=>{calls++;}});
    assert.equal(answer.execution,'not-sent'); assert.equal(calls,0,key);
  }
});
test('unknown fields and excess limits are rejected', () => {
  assert.equal(queryTestSchema.safeParse({...run(),executeSql:'DELETE FROM x'}).success,false);
  assert.equal(queryTestSchema.safeParse({...run(),maxRows:501}).success,false);
  assert.equal(queryTestSchema.safeParse({...run(),testValues:{a:[]}}).success,false);
});
test('ODC binds process once, preserving it for reconciliation', async () => {
  let calls=0;
  const answer=await queryTest(run('odc'),{resolvePid:async()=>451,odc:async r=>{calls++;assert.equal(r.pid,451);return {ok:true,state:'running',execution:'uncertain'};}});
  assert.equal(calls,1); assert.equal(answer.continuation.arguments.pid,451);
});
test('transport loss keeps UUID and never retries',async()=>{
  let calls=0;
  const answer=await queryTest(run(),{o11:async()=>{calls++;throw Object.assign(new Error('lost reply'),{code:'BRIDGE_TIMEOUT'});}});
  assert.equal(calls,1); assert.equal(answer.execution,'uncertain'); assert.equal(answer.continuation.arguments.op,'status');
});
test('cancellation before sending is not-sent; after dispatch returns original operationId',async()=>{
  const pre=new AbortController(); pre.abort(); let calls=0;
  assert.equal((await queryTest(run(),{signal:pre.signal,o11:async()=>{calls++;}})).execution,'not-sent'); assert.equal(calls,0);
  const controller=new AbortController(); let finish;
  const answer=await queryTest(run(),{signal:controller.signal,o11:async()=>{controller.abort();return new Promise(resolve=>{finish=resolve;});}});
  assert.equal(answer.execution,'uncertain'); assert.equal(answer.serverCancelled,false); assert.ok(answer.operationId); finish({ok:true});
});
test('status and cancel preserve op and cannot turn into a run',async()=>{
  for(const op of ['status','cancel']) {
    let called;
    await queryTest({op,lane:'o11',operationId:'c78396ba-d806-4b0a-9c37-099ae9719bab'}, {o11:async r=>{called=r;return {ok:true};}});
    assert.equal(called.op,op); assert.equal(called.source,undefined);
  }
});
test('discovery locates direct SQL and Aggregate native tests in both lanes',async()=>{
  for(const lane of ['o11','odc']) for(const intent of ['testar SQL','testar Aggregate','test SQL query','test Aggregate']) {
    const result=routeTools({intent,lane});
    assert.match(JSON.stringify(result),/ssam_query_test/,`${lane}: ${intent}`);
  }
});
test('native rows and SQL are data, never rewritten into tool instructions',()=>{
  const value={ok:true,rows:[['dotnet build','ssam connect --lane o11']],sql:'SELECT 1 -- dotnet build',execution:'native-query'};
  const result={structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};
  assert.deepEqual(shapeToolResult('ssam_query_test',{},result,{lane:'o11'}),result);
});
test('combined MCP dispatches query testing locally and preserves native error and UUID',async()=>{
  let calls=0;
  const server=await createSsamServer({deps:{queryTest:{o11:async r=>{calls++;return {ok:false,code:'QUERY_TEST_DATABASE_ERROR',execution:'native-query',error:'native syntax error',operationId:r.operationId};}}}});
  const [a,b]=InMemoryTransport.createLinkedPair(); const client=new Client({name:'query-test',version:'1'});
  try {
    await Promise.all([server.connect(a),client.connect(b)]);
    const answer=await client.callTool({name:'ssam_query_test',arguments:run()});
    assert.equal(calls,1); assert.equal(answer.structuredContent.code,'QUERY_TEST_DATABASE_ERROR');
    assert.equal(answer.isError,true); assert.ok(answer.structuredContent.operationId);
  } finally { await client.close(); await server.close(); }
});
