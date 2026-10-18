import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCredentialPrompt, projectPrompt, promptContext } from '../runtime/credential-prompt.mjs';
import { OdcAccess } from '../runtime/access.mjs';

test('a PID or spawn acknowledgement never proves a visible credential window', () => {
  for (const raw of [{ opened: true }, { opened: true, pid: 123 }, { state: 'visible', pid: 123 }, { state: 'starting', pid: 123 }]) {
    const result = projectPrompt(raw); assert.equal(result.visible, false); assert.equal(result.opened, false);
  }
  assert.equal(projectPrompt({ state: 'visible', visible: true, pid: 123, foreground: true, opened: true }).opened, true);
  const result = projectPrompt({ state: 'visible', visible: true, pid: 123, password: 'must-not-leak', username: 'private' });
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|private|password|username/);
});
test('private prompt scope isolates host and credential purpose', () => {
  const keys = ['portal', 'api-client', 'database', 'setting'].map(kind => promptContext(kind, 'example.test', ['database', 'setting'].includes(kind) ? 'Sales' : '').key);
  assert.equal(new Set(keys).size, 4);
  assert.notEqual(keys[0], promptContext('portal', 'other.test').key);
  assert.throws(() => promptContext('portal', 'https://example.test'));
  assert.throws(() => promptContext('setting', 'example.test', '../escape'));
});
test('launcher waits for the verified helper and coalesces concurrent same-context requests', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-window-test-'));t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let calls=0, finish;
  const prompt=createCredentialPrompt({platform:'win32',env:{USERPROFILE:root,SystemRoot:'C:\\Windows'},run:(exe,args,options,callback)=>{
    calls++;assert.match(exe,/powershell.exe$/);assert.equal(args.includes('-NonInteractive'),true);assert.equal(options.windowsHide,true);
    assert.equal(options.detached,undefined);finish=()=>callback(null,JSON.stringify({state:'visible',visible:true,foreground:true,pid:123,opened:true}));
  }});
  const a=prompt('portal','example.test'),b=prompt('portal','example.test');assert.equal(calls,1);finish();
  assert.deepEqual(await a,await b);assert.equal((await a).foreground,true);
});
test('failed spawn and malformed helper output are concrete failures with no stderr disclosure', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-window-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [error,stdout,code]of [[new Error('private'),'', 'CREDENTIAL_PROMPT_UNAVAILABLE'],[null,'private','CREDENTIAL_PROMPT_PROTOCOL_INVALID']]){
    const prompt=createCredentialPrompt({platform:'win32',env:{USERPROFILE:root},run:(_a,_b,_c,done)=>done(error,stdout,'private')});
    const r=await prompt('portal','example.test');assert.equal(r.code,code);assert.equal(r.visible,false);assert.doesNotMatch(JSON.stringify(r),/private/);
  }
});
test('resolver rechecks every prompt instead of trusting a two-minute timestamp', async()=>{
  const replies=[{opened:true},{state:'visible',visible:true,foreground:true,pid:1,opened:true},{state:'failed',visible:false,code:'CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE'},
    {state:'visible',visible:true,foreground:true,pid:2,opened:true,recovered:true}];let calls=0;
  const access=new OdcAccess({prompt:{portal:async()=>{calls++;return replies.shift();}},now:()=>1000});
  const first=await access.openPrompt('portal','example.test');assert.equal(first.code,'CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE');
  assert.equal((await access.openPrompt('portal','example.test')).code,'CREDENTIAL_PROMPT_OPENED');
  assert.equal((await access.openPrompt('portal','example.test')).code,'CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE');
  assert.equal((await access.openPrompt('portal','example.test')).window.recovered,true);assert.equal(calls,4);
});
test('focus denial and cancellation never imply the window is foreground',async()=>{
  const access=new OdcAccess({prompt:{portal:async()=>({state:'visible',visible:true,foreground:false,pid:1,code:'CREDENTIAL_FOCUS_DENIED'})}});
  assert.equal((await access.openPrompt('portal','example.test')).code,'CREDENTIAL_FOCUS_DENIED');
  access.prompt.portal=async()=>({state:'cancelled'});
  assert.equal((await access.openPrompt('portal','example.test')).code,'CREDENTIAL_PROMPT_CANCELLED');
});
test('Portal status reads actual prompt state and explicit recovery reaches the owned manager',async()=>{
  const calls=[];const access=new OdcAccess({prompt:{status:async()=>({state:'visible',visible:true,foreground:false,pid:123}),portal:async(...args)=>{
    calls.push(args);return {state:'visible',visible:true,foreground:true,pid:123,opened:false};}},vault:{portal:async()=>({available:false})}});
  access.studioState=async()=>({sessions:[],running:false});
  const status=await access.portalLogin({tenant:'example.test',action:'status'});assert.equal(status.window.visible,true);assert.equal(calls.length,0);
  const focus=await access.portalLogin({tenant:'example.test',action:'focus'});assert.equal(focus.window.foreground,true);assert.equal(calls[0][3],'focus');
});

// servidor/fase4-25: the second lock of the hosted server. Inside a hosted call the window never starts: no PowerShell, no
// state folder; the answer is the hosted code (lib.mjs refuses first, this holds even if a caller forgot).
test('hosted: the credential window never starts inside a hosted call (HOSTED_PROMPT_UNAVAILABLE, no process)', async () => {
  const { runWithExecutor } = await import('../../facade/executor.mjs');
  const runs = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-hosted-'));
  const prompt = createCredentialPrompt({ env: { USERPROFILE: home }, platform: 'win32', run: (...args) => { runs.push(args); args.at(-1)(null, '{}'); } });
  const context = { hosted: true, workspace: home, executor: { call: async () => { throw new Error('no machine call'); } } };
  for (const action of ['ensure', 'status', 'focus']) {
    const window = await runWithExecutor(context, () => prompt('portal', 'tenant.example.com', '', action));
    assert.deepEqual(window, { state: 'failed', visible: false, opened: false, code: 'HOSTED_PROMPT_UNAVAILABLE' }, action);
  }
  assert.deepEqual(runs, [], 'no PowerShell started');
  assert.deepEqual(fs.readdirSync(home), [], 'no prompt state written');
  fs.rmSync(home, { recursive: true, force: true });
});
