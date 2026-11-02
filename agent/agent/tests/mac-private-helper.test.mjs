import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { macPrivateCommand } from '../lib/mac-private-helper.mjs';
import { createCredentialSession } from '../lib/credential-session.mjs';
import { createUsersKind } from '../lib/users.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r40-mac-helper-'));
  fs.mkdirSync(path.join(root, 'native'));
  fs.writeFileSync(path.join(root, 'native', 'ssam-agent'), 'synthetic executable');
  fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ nativeCore: { runtime: 'native-aot', path: 'native/ssam-agent' } }));
  return root;
}
const argv = ['-NoLogo', '-File', 'ignored.ps1', '-Mode', 'login', '-Scope', 'a'.repeat(32), '-HostName', 'tenant.example.com'];
test('Mac helper receives private values only on stdin and uses its own installed executable', () => {
  const root = fixture(), secret = 'sentinel-mac-password';
  const result = macPrivateCommand({ runtimeRoot: root, dataRoot: root, family: 'credential', argv,
    input: JSON.stringify({ privateCredential: { username: 'tester', password: secret } }) });
  assert.deepEqual(result.args, ['private-helper']);
  assert.equal(JSON.stringify([result.file, result.args]).includes(secret), false);
  const envelope = JSON.parse(result.input);
  assert.equal(envelope.request.privateCredential.password, secret);
  assert.equal(envelope.scope, 'a'.repeat(32));
  assert.equal(envelope.context.runtimeRoot, root);
});
test('Mac Users helper translates private base64 input and public prompt metadata', () => {
  const root = fixture();
  const result = macPrivateCommand({ runtimeRoot: root, dataRoot: root, family: 'users',
    argv: [...argv, '-Kind', 'password', '-Entry', 'b'.repeat(64), '-Subject', 'Tester', '-Rows', 'W10='],
    input: Buffer.from(JSON.stringify({ cookie: 'sentinel-cookie' })).toString('base64') });
  const envelope = JSON.parse(result.input);
  assert.equal(envelope.request.cookie, 'sentinel-cookie');
  assert.equal(envelope.options.kind, 'password');
  assert.equal(envelope.options.rows, 'W10=');
  assert.equal(result.args.includes('sentinel-cookie'), false);
});
test('Mac helper refuses pack paths outside its installation and unsupported runtimes', () => {
  for (const nativeCore of [{ runtime: 'native-aot', path: '../outside' }, { runtime: 'node', path: 'native/ssam-agent' }, null]) {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'pack.json'), JSON.stringify({ nativeCore }));
    assert.throws(() => macPrivateCommand({ runtimeRoot: root, dataRoot: root, family: 'credential', argv }), { code: 'CREDENTIAL_HELPER_UNAVAILABLE' });
  }
});
test('Mac credential and Users kinds route to the same installed private backend', async () => {
  const root = fixture(), requests = [];
  const exec = async (file, args, input) => {
    assert.equal(file, path.join(root, 'native', 'ssam-agent'));
    assert.deepEqual(args, ['private-helper']);
    requests.push(JSON.parse(input));
    return JSON.stringify({ ok: true, available: true, authenticated: false, profiles: [] });
  };
  const options = { runtimeRoot: root, dataRoot: root, platform: 'darwin', exec };
  const credentials = createCredentialSession(options), users = createUsersKind(options);
  assert.equal((await credentials.execute({ op: 'status', host: 'tenant.example.com', service: 'odc-portal', auth: 'credential' })).available, true);
  assert.equal((await users.execute({ op: 'status', host: 'tenant.example.com' })).available, true);
  assert.deepEqual(requests.map(x => x.family), ['credential', 'users']);
  assert.equal(requests[0].scope, requests[1].scope);
});
test('Mac private store failures retain fixed actionable codes without forwarding helper text', async () => {
  for (const code of ['CREDENTIAL_PERMISSION_DENIED', 'CREDENTIAL_STORE_FAILED', 'CREDENTIAL_PRIVATE_HELPER_FAILED']) {
    const root = fixture();
    const agent = createCredentialSession({ runtimeRoot: root, dataRoot: root, platform: 'darwin',
      exec: async () => JSON.stringify({ ok: false, code, message: 'private-sentinel-do-not-forward' }) });
    await assert.rejects(agent.execute({ op: 'status', service: 'odc-portal', auth: 'credential', host: 'tenant.example.com' }),
      error => error.code === code && !error.message.includes('private-sentinel'));
  }
});
for (const method of ['GET','POST']) test('Mac Users propagates cookie privacy refusal without content and preserves '+method+' execution state', async () => {
  const root=fixture(); let opened;
  const { EventEmitter }=await import('node:events'); const { PassThrough }=await import('node:stream');
  const form='<html><form method="post" action="User_List.aspx"><input type="hidden" name="__OSVSTATE" value="s"><input id="x_wtSearchInput" name="s"><input type="submit" name="b" value="Search"></form></html>';
  const agent=createUsersKind({runtimeRoot:root,dataRoot:root,platform:'darwin',lookup:async()=>[{address:'93.184.216.34'}],
    start:(file,args,input)=>{ const envelope=JSON.parse(input); opened=new EventEmitter();opened.stdout=new PassThrough();opened.exitCode=null;opened.unref=()=>{};fs.writeFileSync(envelope.options.promptStatusPath,'visible');return opened; },
    exec:async(file,args,input)=>{const envelope=JSON.parse(input);
      if(envelope.mode==='request') {
        if(method==='GET'||envelope.request.method==='POST')return JSON.stringify({ok:false,code:'USERS_PRIVATE_RESPONSE_REFUSED'});
        return JSON.stringify({ok:true,status:200,body:Buffer.from(form).toString('base64'),contentType:Buffer.from('text/html').toString('base64')});
      }
      return JSON.stringify({ok:true,available:true,hosts:[]});
    }});
  const host='tenant.example.com';await agent.execute({op:'prompt',host});
  opened.stdout.end(JSON.stringify({ok:true,saved:true,remembered:false,privateCredential:{username:'synthetic',password:'synthetic-password'}}));opened.exitCode=0;opened.emit('close',0);
  await new Promise(resolve=>setImmediate(resolve));
  const request=method==='GET'?{op:'request',host,url:'https://'+host+'/Users/User_List.aspx'}:{op:'search',host,text:'test'};
  await assert.rejects(agent.execute(request),error=>error.code==='USERS_PRIVATE_RESPONSE_REFUSED'&&error.executed===(method==='POST'?null:false)&&!error.message.includes('sentinel'));
});
