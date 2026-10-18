import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { debugSchema, parseDebugCli, registerDebugTools } from '../debug.mjs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { pipeRequest, sessionCommand, bindServerInspectionScope } from '../debug-runtime.mjs';
import os from 'node:os';
import path from 'node:path';
const sessionId = 'a'.repeat(32);
const start = { op: 'start', lane: 'odc', tenant: 'example.outsystems.dev', module: 'Fixture', moduleKey: 'AQEBAQEBAQEBAQEBAQEBAQ', nodeKeys: ['AgICAgICAgICAgICAgICAg'], runtimeUrl: 'https://example-dev.outsystems.app/App/' };
test('explicit breakpoint set, target and bounded lifetime are mandatory', () => {
  assert.equal(debugSchema.parse(start).seconds, 120);
  assert.equal(debugSchema.parse(start).autoContinue, true);
  const cli = ['start', '--lane', 'odc', '--tenant', start.tenant, '--module', start.module, '--module-key', start.moduleKey, '--runtime-url', start.runtimeUrl, '--node-keys', start.nodeKeys[0]];
  assert.equal(parseDebugCli([...cli, '--manual']).autoContinue, false);
  assert.throws(() => parseDebugCli([...cli, '--manual', '--auto-continue']));
  for (const invalid of [
    { ...start, nodeKeys: [] }, { ...start, nodeKeys: [...start.nodeKeys, ...start.nodeKeys] },
    { ...start, lane: undefined }, { ...start, moduleKey: undefined }, { ...start, tenant: undefined },
    { ...start, seconds: 601 }, { ...start, runtimeUrl: 'https://user:secret@example.org/' },
    { ...start, runtimeUrl: 'http://example.org/' }, { ...start, password: 'secret' },
    { ...start, pid: 123 }, { ...start, breakOnAllErrors: true },
  ]) assert.equal(debugSchema.safeParse(invalid).success, false);
});
test('exact string event ids and local variable paths; no arbitrary expressions', () => {
  const r = parseDebugCli(['variables', '--session', sessionId, '--thread-id', 'T1', '--event-id', '9223372036854775806', '--paths', 'Response.Body,Request.Address', '--frame', '2']);
  assert.equal(r.eventId, '9223372036854775806'); assert.deepEqual(r.paths, ['Response.Body', 'Request.Address']);
  for (const invalid of [{ ...r, eventId: 9223372036854775806 }, { ...r, paths: ['GetSecret()'] }, { ...r, paths: ['x"/>'] }, { ...r, sessionId: '../escape' }, { op: 'continue', sessionId }]) assert.equal(debugSchema.safeParse(invalid).success, false);
  assert.throws(() => parseDebugCli(['status', '--session', sessionId, '--session', sessionId]));
});
test('interactive inspection accepts explicit text continuation and rejects legacy auto-continue', () => {
  assert.equal(debugSchema.safeParse({...start,inspection:{variables:[]}}).success,false);
  assert.equal(debugSchema.safeParse({...start,inspection:{variables:[]},autoContinue:false}).success,true);
  const input=parseDebugCli(['read','--session',sessionId,'--thread-id','T1','--event-id','42','--reference','b'.repeat(32),'--text-offset','8192','--text-limit','4096']);
  assert.equal(input.textOffset,8192);assert.equal(input.textLimit,4096);
  assert.equal(debugSchema.safeParse({...input,textLimit:16385}).success,false);
});

test('batch inspection exposes native reference reads and requires a pinned stop', () => {
  const refs=['b'.repeat(32),'c'.repeat(32)];
  const input=parseDebugCli(['read-many','--session',sessionId,'--thread-id','T1','--event-id','42','--references',refs.join(','),'--depth','2']);
  assert.deepEqual(input.references,refs);
  for(const invalid of [{...input,references:[]},{...input,references:[refs[0],refs[0]]},{...input,references:['Seed']},
    {...input,eventId:undefined},{...input,op:'scope'}]) assert.equal(debugSchema.safeParse(invalid).success,false);
});

test('batch references reach the native session without falling back to single-variable reads', async t => {
  const sessionRoot=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-batch-command-'));
  t.after(()=>fs.rmSync(sessionRoot,{recursive:true,force:true}));
  fs.mkdirSync(path.join(sessionRoot,sessionId));
  fs.writeFileSync(path.join(sessionRoot,sessionId,'manifest.json'),JSON.stringify({lane:'odc'}));
  const references=['b'.repeat(32),'c'.repeat(32)],calls=[];
  const result=await sessionCommand(debugSchema.parse({op:'read-many',sessionId,threadId:'T1',eventId:'42',references}),{
    sessionRoot,pipeRequest:async(id,request)=>{calls.push(request);return {ok:true,values:[]};}
  });
  assert.equal(result.ok,true);assert.equal(calls.length,1);assert.deepEqual(calls[0].references,references);
  assert.equal(calls[0].threadId,'T1');assert.equal(calls[0].eventId,'42');
});
test('CLI accepts a complete bounded scope larger than the old bootstrap limit', t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-inspection-scope-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'inspection.json');
  const variables=Array.from({length:318},(_,i)=>({moduleKey:start.moduleKey,functionKey:start.nodeKeys[0],nodeKey:start.nodeKeys[0],
    variableKey:'B'.repeat(22),sourceSha256:'a'.repeat(64),name:'Value'+i,category:'local',path:'Value'+i}));
  const bytes=JSON.stringify({variables});assert.ok(bytes.length>65536);fs.writeFileSync(file,bytes);
  const result=parseDebugCli(['start','--lane','odc','--tenant',start.tenant,'--module',start.module,'--module-key',start.moduleKey,
    '--runtime-url',start.runtimeUrl,'--node-keys',start.nodeKeys[0],'--manual','--inspection',file]);
  assert.equal(result.inspection.variables.length,318);
  fs.writeFileSync(file,' '.repeat(1024*1024+1));
  assert.throws(()=>parseDebugCli(['start','--inspection',file]),/debug_inspection_file_invalid/);
});
test('scope binding is private, preserves exact context and cannot bypass observer command restrictions', async t => {
  const sessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-scope-binding-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(sessionRoot, sessionId));
  const manifest = path.join(sessionRoot, sessionId, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({ lane: 'odc' }));
  const scopeUpdate = { moduleKey: start.moduleKey, functionKey: start.nodeKeys[0], nodeKey: start.nodeKeys[0],
    sourceSha256: 'a'.repeat(64), frame: 1, generation: 2, variables: [] };
  const input = { sessionId, threadId: 'T', eventId: '9223372036854775806', scopeUpdate }, calls = [];
  const services = { sessionRoot, pipeRequest: async (_, request) => { calls.push(request); return { ok: true, metadataBound: true }; } };
  assert.equal(debugSchema.safeParse({ ...input, op: 'bind-scope' }).success, false);
  assert.equal(debugSchema.safeParse({ ...input, op: 'scope' }).success, false);
  assert.equal((await bindServerInspectionScope(input, services)).metadataBound, true);
  assert.deepEqual(calls[0].scopeUpdate, scopeUpdate); assert.equal(calls[0].eventId, input.eventId);
  fs.writeFileSync(manifest, JSON.stringify({ lane: 'odc', backgroundWatch: true }));
  await assert.rejects(bindServerInspectionScope(input, services), /background_watch_command_invalid/);
  assert.equal(calls.length, 1);
});
test('MCP contract explains headless setup and safe troubleshooting without conversation history', async () => {
  const tools = new Map(); const calls = [];
  registerDebugTools({ registerTool(name, config, fn) { tools.set(name, { config, fn }); } }, async input => { calls.push(input); return { ok: true }; }, fn => fn);
  assert.deepEqual([...tools.keys()], ['ssam_debug']);
  const tool = tools.get('ssam_debug');
  for (const phrase of ['neither Studio', 'published snapshot', 'Never supply secrets', 'never retry', 'End with stop', 'required nodeKeys', 'App User Sign In', 'masked Password']) assert.ok(tool.config.description.includes(phrase));
  await tool.fn({ op: 'status', sessionId }); assert.equal(calls[0].sessionId, sessionId);
  assert.equal(tool.config.annotations.idempotentHint, false);
});
test('real stdio MCP discovers debugger and rejects incomplete start without Studio or tenant calls', async () => {
  const client = new Client({ name: 'headless-debug-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../ssam.mjs', import.meta.url)), 'mcp', '--profile', 'debug'], stderr: 'ignore' }));
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'ssam_debug');
    assert.ok(tool); assert.ok(!JSON.stringify(tool.inputSchema).includes('pid'));
    const result = await client.callTool({ name: 'ssam_debug', arguments: { op: 'start', lane: 'odc' } });
    assert.equal(result.isError, true);
  } finally { await client.close(); }
});
test('headless worker has no Studio process, presenter or UI dependencies', () => {
  for (const file of ['Program.cs', 'DebugSession.cs', 'NativeTransport.cs']) {
    const code = fs.readFileSync(new URL('../../../../kernel/debug/shared/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /ServiceStudio\.(Presenter|View)|GetProcessesByName|IAggregatorPresenter|ExecuteInContext/);
  }
});
test('stop and status answer from the final receipt of an exited worker and release the lock; execution never does', async () => {
  // Real session layout: manifest under .local/debugger/<sessionId>, receipt and lock wherever the manifest points; no worker process.
  const id = randomUUID().replaceAll('-', ''), dir = fileURLToPath(new URL('../../../../.local/debugger/' + id + '/', import.meta.url));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-debug-receipt-'));
  const lock = path.join(scratch, 'target.lock'), receiptPath = path.join(scratch, 'receipt.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sessionId: id, lane: 'odc', lock, receiptPath }));
  fs.writeFileSync(lock, JSON.stringify({ sessionId: id }));
  try {
    fs.writeFileSync(receiptPath, JSON.stringify({ ok: false, state: 'starting', sessionId: id }));
    const uncertain = await sessionCommand(debugSchema.parse({ op: 'stop', sessionId: id }));
    assert.equal(uncertain.error, 'debug_start_uncertain'); assert.equal(uncertain.ok, false); assert.ok(fs.existsSync(lock));
    fs.writeFileSync(receiptPath, JSON.stringify({ ok: true, state: 'stopped', sessionId: id, events: [{ kind: 'stopped' }] }));
    await assert.rejects(sessionCommand(debugSchema.parse({ op: 'continue', sessionId: id, threadId: 'T1', eventId: '1' })), /unreachable/);
    assert.ok(fs.existsSync(lock));
    await assert.rejects(sessionCommand(debugSchema.parse({ op: 'stop', sessionId: id, lane: 'o11' })), /lane_mismatch/);
    const stopped = await sessionCommand(debugSchema.parse({ op: 'stop', sessionId: id }));
    assert.equal(stopped.state, 'stopped'); assert.equal(stopped.ok, true); assert.ok(!fs.existsSync(lock));
    assert.equal((await sessionCommand(debugSchema.parse({ op: 'status', sessionId: id }))).state, 'stopped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(scratch, { recursive: true, force: true }); }
});
test('local command pipe preserves stop identifiers and never retries a timed-out execution', { skip: process.platform !== 'win32' }, async () => {
  const id = randomUUID().replaceAll('-', ''), pipe = '\\\\.\\pipe\\ssam-debug-' + id;
  let calls = 0;
  const server = net.createServer(socket => socket.once('data', bytes => {
    calls++; const request = JSON.parse(bytes.toString());
    if (request.op === 'status') socket.end(JSON.stringify({ ok: true, eventId: '9223372036854775806' }) + '\n');
  }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  try {
    assert.equal((await pipeRequest(id, { op: 'status' })).eventId, '9223372036854775806');
    await assert.rejects(pipeRequest(id, { op: 'continue', threadId: 'T1', eventId: '42' }, 200), /uncertain/);
    assert.equal(calls, 2);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
