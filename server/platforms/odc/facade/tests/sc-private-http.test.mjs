import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transport } from '../service-center/http.mjs';
import { StudioBridge, locateStudioBridge } from '../service-center/bridge.mjs';

test('private GET observes unapplied server cookie changes as booleans only, without reusing stale metadata', async () => {
  let observation={sessionCookieUpdatesObserved:true,sessionCookieUpdatesApplied:false};
  const transport=new Transport('example.test',{privatePrincipal:'fixture@example.test',
    send:()=>assert.fail('GET must use native masking'),privateBridge:{
      capabilities:async()=>new Set(['sc_private_http:secretRefs']),
      privateWeb:async()=>({status:200,finalUrl:'https://example.test/ServiceCenter/Extension_Edit.aspx',
        contentType:'text/html',html:'<html>OK</html>',...observation,unexpectedCookie:'never-export-this'}),
    }});
  transport.preauthenticated=true;
  transport.jar.store(transport.base,['session=synthetic-original; Path=/']);
  await transport.fetch('Extension_Edit.aspx');
  assert.deepEqual(transport.privateSessionObservation,{cookieUpdatesObserved:true,cookieUpdatesApplied:false});
  observation={sessionCookieUpdatesObserved:false,sessionCookieUpdatesApplied:false};
  await transport.fetch('Extension_Edit.aspx');
  assert.deepEqual(transport.privateSessionObservation,{cookieUpdatesObserved:false,cookieUpdatesApplied:false});
  observation={sessionCookieUpdatesObserved:'not-a-boolean',sessionCookieUpdatesApplied:false};
  await transport.fetch('Extension_Edit.aspx');
  assert.equal(transport.privateSessionObservation,null);
  assert.equal(transport.jar.header(transport.base),'session=synthetic-original');
});

test('secret post uses native private bridge and current broker cookie without reading vault in JS', async () => {
  let sent = 0;
  const transport = new Transport('example.test', { privatePrincipal: 'user@example.test',
    send: () => assert.fail('secret write cannot use JS HTTP'), privateBridge: {
      capabilities: async () => new Set(['sc_private_http:secretRefs']),
      privateWeb: async (host, options, context) => {
        sent++; assert.equal(host, 'example.test'); assert.equal(options.form.password, '');
        assert.equal(context.cookie, 'session=broker-owned'); assert.equal(context.principal, 'user@example.test');
        assert.equal(options.write, true);
        return { status: 200, finalUrl: 'https://example.test/ServiceCenter/DBConnection_Edit.aspx',
          contentType: 'text/html', html: '<html>OK</html>', windowCreated: false };
      },
    } });
  transport.jar.store('https://example.test/ServiceCenter/', ['session=broker-owned; Path=/']);
  await transport.authorizing('11111111-2222-3333-4444-555555555555', 'a'.repeat(64), async tracker => {
    await transport.fetch('DBConnection_Edit.aspx', [['password', '']], 'html',
      [{ pointer: '/password', target: 'SSAM/O11/example.test/DatabaseConnection/Test', field: 'password' }]);
    assert.equal(tracker.sent, true);
  });
  assert.equal(sent, 1);
});

test('private handoff binds exact serialized request and never adds cookie to bridge arguments', async () => {
  const bridge = new StudioBridge(1, 'unused');
  bridge.capabilities = async () => new Set(['sc_private_http:secretRefs']);
  let calls = 0;
  bridge.verb = async (method, args, write) => {
    calls++; assert.equal(method, 'sc_private_http'); assert.equal(write, true);
    assert.equal(args.contextPipeId, '11111111-2222-3333-4444-555555555555');
    assert.equal(args.requestSha256, createHash('sha256').update(args.requestJson).digest('hex'));
    assert.equal(JSON.stringify(args).includes('broker-owned'), false);
    return { ok: true };
  };
  await bridge.privateWeb('example.test', { method: 'POST', path: '/ServiceCenter/DBConnection_Edit.aspx',
    form: { password: '' }, write: true, operationId: '22222222-2222-3333-4444-555555555555', authorizeSha256: 'a'.repeat(64) }, {
    principal: 'user@example.test', cookie: 'session=broker-owned',
    handoff: async (scope, invoke) => { assert.equal(scope.cookie, 'session=broker-owned'); return invoke('11111111-2222-3333-4444-555555555555'); },
  });
  assert.equal(calls, 1);
});

test('bridge without private capability refuses before handoff', async () => {
  const bridge = new StudioBridge(1, 'unused'); bridge.capabilities = async () => new Set();
  await assert.rejects(bridge.privateWeb('example.test', { method: 'POST', path: '/ServiceCenter/DBConnection_Edit.aspx' }, {
    handoff: () => assert.fail('must not send session material'),
  }), error => error.code === 'STUDIO_BRIDGE_OUTDATED' && error.extra.executed === false);
});

test('private cookie updates feed the next ordinary POST without exposing headers in a bridge response',async()=>{
 let native=0,posts=0;
 const transport=new Transport('example.test',{privatePrincipal:'fixture@example.test',privateBridge:{
  capabilities:async()=>new Set(['sc_private_http:secretRefs','sc_private_http:cookieUpdates']),
  privateWeb:async(host,options,context)=>{native++;await context.applyCookies('https://example.test/ServiceCenter/',
   ['session=rotated-synthetic; Path=/','obsolete=; Max-Age=0; Path=/']);
   return{status:200,finalUrl:'https://example.test/ServiceCenter/Extension_Edit.aspx',contentType:'text/html',html:'<html>OK</html>',sessionCookieUpdatesObserved:true,sessionCookieUpdatesApplied:true};
  }},send:async req=>{posts++;assert.equal(req.headers.Cookie,'session=rotated-synthetic');return{status:200,contentType:'text/html',body:Buffer.from('<html>OK</html>'),setCookie:[]};}});
 transport.preauthenticated=true;transport.jar.store(transport.base,['session=original-synthetic; Path=/','obsolete=old-synthetic; Path=/']);
 await transport.fetch('Extension_Edit.aspx');assert.deepEqual(transport.privateSessionObservation,{cookieUpdatesObserved:true,cookieUpdatesApplied:true});
 await transport.fetch('Extension_Edit.aspx',[['synthetic','test']]);assert.equal(native,1);assert.equal(posts,1);
});

test('cookie exchange capability is explicit and exact request binding keeps cookies out of arguments',async()=>{
 const bridge=new StudioBridge(1,'unused');let verbs=0;
 bridge.capabilities=async()=>new Set(['sc_private_http:secretRefs']);
 await assert.rejects(bridge.privateWeb('example.test',{method:'GET',path:'/ServiceCenter/Extension_Edit.aspx'},
  {principal:'fixture@example.test',cookie:'never-public',applyCookies:()=>{}}),e=>e.code==='STUDIO_BRIDGE_OUTDATED');
 bridge.capabilities=async()=>new Set(['sc_private_http:secretRefs','sc_private_http:cookieUpdates']);
 bridge.verb=async(method,args)=>{verbs++;assert.equal(method,'sc_private_http_cookie');assert.equal(JSON.stringify(args).includes('never-public'),false);return{ok:true};};
 await bridge.privateWeb('example.test',{method:'GET',path:'/ServiceCenter/Extension_Edit.aspx'},
  {principal:'fixture@example.test',cookie:'never-public',applyCookies:()=>{},cookieExchange:async(scope,invoke)=>{
   assert.equal(scope.url,'https://example.test/ServiceCenter/Extension_Edit.aspx');assert.equal(scope.cookie,'never-public');return invoke('11111111-2222-3333-4444-555555555555');
  }});assert.equal(verbs,1);
});

test('isolated Service Center revision is bound to the selected process and does not replace the general port', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-revision-'));
  try {
    const folder = path.join(root, '.local', 'connections'); fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'ss4.json');
    const record = { ok: true, pid: 1234, port: 4516, startedUtc: '2026-10-08T23:00:00Z', authorityDir: root,
      serviceCenter: { pid: 1234, startedUtc: '2026-10-08T23:00:00Z', port: 4519, sha256: 'a'.repeat(64) } };
    fs.writeFileSync(file, JSON.stringify(record));
    const alive = { bridge: 'anvil', pid: 1234, revisionSha256: 'a'.repeat(64), startedUtc: record.startedUtc };
    const request = async connection => { assert.equal(connection.port, 4519); return { success: true, data: alive }; };
    assert.equal((await locateStudioBridge({ root, lane: 'ss4', request })).port, 4519);
    assert.equal(JSON.parse(fs.readFileSync(file)).port, 4516);
    for (const mutation of [{revisionSha256:'b'.repeat(64)}, {revisionSha256:undefined}, {startedUtc:'2026-10-09T23:00:00Z'}]) {
      await assert.rejects(locateStudioBridge({root,lane:'ss4',request:async()=>({success:true,data:{...alive,...mutation}})}),
        e=>e.code==='STUDIO_NOT_CONNECTED');
    }
    record.serviceCenter.pid = 9999; fs.writeFileSync(file, JSON.stringify(record));
    await assert.rejects(locateStudioBridge({ root, lane: 'ss4', request }), e => e.code === 'STUDIO_NOT_CONNECTED');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
