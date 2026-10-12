import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable, PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInspectionCli, inspectionHandler } from '../debug-inspection-cli.mjs';

async function exercise(lines, options = {}) {
  let text = '';
  const output = new Writable({ write(chunk, _encoding, next) { text += chunk; next(); } });
  await runInspectionCli({ runtime: 'server', input: Readable.from(lines.map(line =>
    typeof line === 'string' ? line + '\n' : JSON.stringify(line) + '\n')), output, ...options });
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('persistent CLI preserves stop tokens and native values, prevents duplicate request replay', async () => {
  const calls = [];
  const handler = async request => {
    calls.push(request);
    if (request.op === 'start') return { ok: true, sessionId: 's', state: 'preparing' };
    if (request.op === 'read') return { ok: true, value: { type: 'Integer', value: '42' } };
    return { ok: true, sessionId: 's', state: 'completed', runResult: { uncertain: false } };
  };
  const token = { sessionId: 's', threadId: 't', eventId: '9007199254740993', generation: 2 };
  const rows = await exercise([
    { id: 'start', request: { op: 'start', run: { lane: 'o11' } } },
    { id: 'read', request: { op: 'read', ...token, reference: 'native' } },
    { id: 'read', request: { op: 'continue', ...token } },
    { id: 'end', request: { op: 'status', sessionId: 's' } },
  ], { handler, lane: 'o11' });
  assert.deepEqual(calls.map(c => c.op), ['start', 'read', 'status']);
  assert.equal(calls[1].eventId, token.eventId);
  assert.deepEqual(rows[1].result.value, { type: 'Integer', value: '42' });
  assert.equal(rows[2].result.error, 'debug_inspection_cli_duplicate_id');
  assert.equal(rows.length, 4);
});

test('EOF stops each owned session once and waits for the original terminal receipt', async () => {
  const calls = [];
  const rows = await exercise([{ id: 's', request: { op: 'start' } }], { handler: async request => {
    calls.push(request);
    if (request.op === 'start') return { ok: true, sessionId: 's', state: 'paused' };
    if (request.op === 'stop') return { ok: true, sessionId: 's', state: 'ending', revision: 8 };
    return { ok: true, sessionId: 's', state: 'completed', runResult: { uncertain: false } };
  } });
  assert.deepEqual(calls.map(c => c.op), ['start', 'stop', 'status']);
  assert.equal(calls[2].afterRevision, 8);
  assert.equal(rows[1].event, 'owner-closing');
  assert.equal(rows[1].terminalObserved, true);
  assert.equal('cleanupConfirmed' in rows[1], false);
});

test('lane mismatch and malformed input never reach a runner or leak payload text', async () => {
  const calls = [];
  const rows = await exercise([
    'secret:bad-json',
    { id: 'x', request: { op: 'start', run: { lane: 'odc' } } },
    { id: 'y', request: { op: 'status' }, password: 'secret' },
  ], { lane: 'o11', handler: async request => calls.push(request) });
  assert.equal(calls.length, 0);
  assert.equal(rows[1].result.error, 'debug_run_lane_mismatch');
  assert.doesNotMatch(JSON.stringify(rows), /secret/);
});

test('lost stdout cancels owned sessions without sending an unobservable new start', async () => {
  const calls = [];
  const output = new Writable({ write(_chunk, _encoding, next) { next(new Error('EPIPE private diagnostic')); } });
  await runInspectionCli({ runtime: 'client', input: Readable.from([
    JSON.stringify({id:'first',request:{op:'start'}})+'\n',
    JSON.stringify({id:'second',request:{op:'start'}})+'\n',
  ]), output, handler: async request => {
    calls.push(request.op);
    return {ok:true,sessionId:'s',state:request.op==='start'?'paused':request.op==='stop'?'ending':'uncertain',revision:1};
  } });
  assert.deepEqual(calls,['start','stop','status']);
});

test('stdout failure during EOF cleanup does not skip another owned session', async () => {
  const calls = []; let writes = 0, sessions = 0;
  const output = new Writable({ write(_chunk, _encoding, next) { next(++writes===3?new Error('EPIPE'):undefined); } });
  await runInspectionCli({runtime:'server',input:Readable.from(['a','b'].map(id=>JSON.stringify({id,request:{op:'start'}})+'\n')),
    output,handler:async request=>{
      calls.push([request.op,request.sessionId]);
      if(request.op==='start')return {ok:true,sessionId:String(++sessions),state:'paused'};
      return {ok:true,sessionId:request.sessionId,state:request.op==='stop'?'ending':'uncertain',revision:1};
    }});
  assert.deepEqual(calls.slice(2),[['stop','1'],['status','1'],['stop','2'],['status','2']]);
});

test('stdout failure while waiting for input closes ownership without requiring stdin EOF', {timeout:1500}, async () => {
  const input=new PassThrough(),calls=[];let observed;
  const started=new Promise(resolve=>observed=resolve);
  const output=new Writable({write(_chunk,_encoding,next){next();observed();}});
  const running=runInspectionCli({runtime:'client',input,output,handler:async request=>{
    calls.push(request.op);return {ok:true,sessionId:'s',state:request.op==='start'?'paused':'uncertain'};
  }});
  input.write(JSON.stringify({id:'start',request:{op:'start'}})+'\n');await started;
  output.emit('error',new Error('EPIPE'));
  await running;input.destroy();
  assert.deepEqual(calls,['start','stop']);
});

test('both CLI runtimes apply the existing MCP schema before native work', async () => {
  for (const runtime of ['client', 'server']) {
    const rows = await exercise([{ id: 'invalid', request: { op: 'start', evaluator: 'secret' } }],
      { runtime, handler: inspectionHandler(runtime) });
    assert.equal(rows[0].result.ok, false);
    assert.equal(rows[0].result.error, 'debug_inspection_cli_invalid_request');
  }
});

test('root CLI dispatches both persistent runtimes and returns structured validation errors', () => {
  const rootEntry = fileURLToPath(new URL('../../../../facade/ssam.mjs', import.meta.url));
  for (const runtime of ['server', 'client']) {
    const text = execFileSync(process.execPath, [rootEntry, 'debug', runtime, '--stdio', '--lane', 'o11'], {
      input: JSON.stringify({ id: 'invalid', request: { op: 'start', evaluator: 'private-value' } }) + '\n',
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    const rows = text.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(rows, [{ id: 'invalid', result: { ok: false, error: 'debug_inspection_cli_invalid_request' } }]);
  }
});
