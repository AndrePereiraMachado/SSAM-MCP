import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as z from 'zod/v4';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer } from '../ssam.mjs';
import { repetition } from './answer-replay.mjs';
import * as replay from './answer-replay.mjs';

test('A7 recovery observes every continuation.more branch',async()=>{
  const call=part=>({tool:'ssam_evidence',arguments:{file:'fixture.json',pointer:'/'+part}});
  const observed=await replay.observeRecovery({tool:'fixture',arguments:{}},async request=>request.tool==='fixture'
    ? {ok:true,continuation:{...call('one'),more:[call('two')]}}
    : {ok:true,value:request.arguments.pointer});
  assert.equal(observed.calls,3);
  assert.deepEqual(observed.records.slice(1).map(r=>r.value.value),['/one','/two']);
});

test('A7 W8 counts a real recovery round instead of assuming the fixed R7 length', async t => {
  assert.equal(typeof replay.observeRecovery, 'function', 'recovery must be observable');
  const server=await createSsamServer({o11:false,odc:false,deps:{identity:{read:()=>({facadeSha256:'fixed',catalogSha256:'fixed'})}}});
  const contract='Keep the complete input signature and ownership. '.repeat(1800);
  server.registerTool('ssam_discover',{inputSchema:z.object({lane:z.enum(['o11','odc']),intent:z.string()})},async()=>{
    const value={ok:true,lane:'o11',matches:[{id:'fixture.large',contract}]};
    return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
  });
  const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'a7-observe',version:'1'});
  await Promise.all([server.connect(a),client.connect(b)]);t.after(async()=>{await client.close();await server.close();});
  const observed=await replay.observeRecovery({tool:'ssam_discover',arguments:{lane:'o11',intent:'read complete large contract'}},call=>client.callTool({name:call.tool,arguments:call.arguments}));
  assert.equal(observed.initialCalls,1);
  assert.ok(observed.recoveryCalls>=1,'an oversized contract requires actual recovery calls: '+JSON.stringify(observed.records[0].value).slice(-4500));
  assert.ok(observed.parallelRounds>=2,'recovery depends on the first response');
  assert.equal(observed.calls,observed.records.length);
  assert.ok(observed.records.some(r=>r.call.tool==='ssam_evidence'));
  assert.ok(observed.bytes>observed.records[0].bytes);
  assert.ok(observed.records.every(r=>r.value.ok!==false),JSON.stringify(observed.records));
  const parts=observed.records.filter(r=>r.call.arguments.pointer==='/matches/0/contract');
  assert.equal(parts.map(r=>r.value.value).join(''),contract,'all pages restore the complete contract');
});

test('W8: repeated requests retain their complete contract in the same and in a fresh connection', async t => {
  const contract = 'An input uses its declared type; an output keeps its signature and ownership. '.repeat(8);
  let calls = 0;
  const connect = async () => {
    const server = await createSsamServer({ o11: false, odc: false, deps: { identity: { read: () => ({ facadeSha256: 'fixed', catalogSha256: 'fixed' }) } } });
    server.registerTool('ssam_discover', {
      description: 'Deterministic contract fixture.',
      inputSchema: z.object({ lane: z.enum(['o11', 'odc']), intent: z.string() }),
    }, async ({ lane, intent }) => {
      calls++;
      const value = { ok: true, lane, intent, matches: [{ id: 'fixture.contract', contract }] };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cx11-context-reset', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
  };
  const client = await connect();
  const call = { name: 'ssam_discover', arguments: { lane: 'o11', intent: 'read the fixture contract' } };
  const first = await client.callTool(call), repeated = await client.callTool(call);
  const fresh = await (await connect()).callTool(call);
  const value = r => r.structuredContent ?? JSON.parse(r.content[0].text);
  assert.equal(value(first).matches[0].contract, contract);
  assert.deepEqual(value(repeated), value(first), 'a shared MCP connection cannot assume its callers share context');
  assert.deepEqual(value(fresh), value(first), 'context reset cannot require an earlier answer');
  assert.equal(calls, 3, 'one tool call per request, no reference round trip');
  const metric = repetition([first, repeated].map(r => ({ tool: call.name, text: JSON.stringify(value(r)) })));
  assert.equal(metric.total.n, 2);
  assert.equal(metric.total.wholeDup, 1);
});
