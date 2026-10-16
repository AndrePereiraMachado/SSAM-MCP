import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import {McpServer,InMemoryTransport} from '@modelcontextprotocol/server';
import {Client} from '@modelcontextprotocol/client';
import {fakeBridge} from './fixtures/fake-o11-bridge.mjs';
import {o11Bridge,flightOf} from '../o11-bridge.mjs';
import {o11Studio} from '../o11-studio.mjs';
import {deliverOutcome} from '../o11-cycle.mjs';
import {stallRecovery} from '../studio-recovery.mjs';
import {withStudioWriteLock,busyToolResult} from '../studio-write-lock.mjs';

// CX14 R2: what the person typed in a Studio dialog (a TextBox: the password of a sign-in) never reaches an answer, a
// receipt or a lock file. The same rule as dialogsFromWindows: "[TextBox]" texts are dropped. Synthetic markers only.
const MARK='SYNTH-SECRET-R2-0004',USER='synthetic.user.r2';
const signIn={title:'Sign in',type:'DialogWindow',isVisible:true,isModal:true,
  texts:['Sign in to synthetic.example',`[TextBox] ${USER} (Username)`,`[TextBox] ${MARK} (Password)`,'[Button] Log In','[Button] Cancel']};
const leaks=text=>[MARK,USER,'[TextBox]'].filter(m=>text.includes(m));
const valueOf=r=>r.structuredContent??JSON.parse(r.content[0].text);
const reply=v=>({content:[{type:'text',text:JSON.stringify(v)}],structuredContent:v,...(v.ok===false?{isError:true}:{})});

test('a stalled o11_studio call answers through MCP without the typed text, and its flight files hold none',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cx14-r2-typed-'));let visible=false;
  const bridge=await fakeBridge(req=>{
    if(req.method==='windows')return{success:true,data:{windows:visible?[signIn]:[]}};
    if(req.method==='ping')return{success:true,data:{pid:process.pid}};
    if(req.method==='bridge_manifest')return{success:true,data:{capabilities:[]}};
    if(req.method==='open_module'){visible=true;return undefined;}
    return{success:true,data:{}};
  });
  const record={pid:process.pid,port:bridge.port},deps={o11Root:root,o11Lane:'ss4',connection:()=>record,queueMs:2000};
  const client=o11Bridge({port:bridge.port,pid:process.pid,record,flight:flightOf({lane:'ss4',root,record})});
  const fast={ok:(m,p,o)=>client.ok(m,p,{probeMs:25,probeTimeoutMs:200,timeoutMs:5000,...o})};
  const studio=o11Studio({bridge:fast,root,lane:'ss4',assertSelected:async()=>{},inventory:async()=>null});
  const server=new McpServer({name:'cx14-r2',version:'1'});
  server.registerTool('o11_studio',{inputSchema:z.object({command:z.string(),args:z.record(z.string(),z.unknown()).optional()})},
    async a=>withStudioWriteLock({tool:'o11_studio',args:a,deps,onBusy:busyToolResult},async()=>reply(await studio(a))));
  const [a,b]=InMemoryTransport.createLinkedPair(),mcp=new Client({name:'cx14-r2-client',version:'1'});
  await Promise.all([server.connect(a),mcp.connect(b)]);
  try{
    const response=await mcp.callTool({name:'o11_studio',arguments:{command:'open-module',args:{name:'SynthModule'}}});
    const value=valueOf(response);
    assert.equal(value.code,'BRIDGE_STALLED');assert.equal(value.stalled.blockedBy.title,'Sign in');
    assert.equal(value.stalled.blockedBy.question,'Sign in | Sign in to synthetic.example | [Button] Log In | [Button] Cancel');
    assert.deepEqual(leaks(JSON.stringify(response)),[]);
    const lockDir=path.join(root,'.local','locks');
    const files=fs.readdirSync(lockDir);assert.ok(files.some(f=>f.endsWith('.holder')),'the stalled flight is fenced');
    for(const f of files)assert.deepEqual(leaks(fs.readFileSync(path.join(lockDir,f),'utf8')),[],f);
    const windows=valueOf(await mcp.callTool({name:'o11_studio',arguments:{command:'windows'}}));
    assert.equal(windows.ok,true);assert.equal(windows.windows[0].title,'Sign in');assert.deepEqual(leaks(JSON.stringify(windows)),[]);
  }finally{await mcp.close();await server.close();await bridge.close()}
});

test('a delivery receipt or recovery that carries typed text (written before R2) is answered without it',()=>{
  const stalled={verdict:'dialog',method:'merge_from_oml',afterMs:16000,studio:{pid:4242},blockedBy:{title:'Sign in',type:'DialogWindow',kind:'MessageBox',seenMs:14000,
    texts:signIn.texts,buttons:['Log In','Cancel'],question:['Sign in',...signIn.texts].join(' | ')}};
  const value=deliverOutcome({envelope:{ok:false,data:{taskId:'a'.repeat(32),stage:'reconcile',writeState:'unknown',error:'The Studio stopped answering the merge: dialog (Sign in)',
    stalled,pendingBridgeOperation:{method:'merge_from_oml',operationId:'op',moduleKey:'K'}}}},{trackId:'facade',work:fs.mkdtempSync(path.join(os.tmpdir(),'cx14-r2-'))});
  assert.equal(value.code,'DELIVERY_UNCERTAIN');assert.equal(value.recovery[0].question,'Sign in | Sign in to synthetic.example | [Button] Log In | [Button] Cancel');
  assert.deepEqual(leaks(JSON.stringify(value)),[]);
  const bare=stallRecovery({verdict:'dialog',blockedBy:{title:'Sign in',kind:'Modal',question:['Sign in',...signIn.texts].join(' | ')}},null);
  assert.deepEqual(leaks(JSON.stringify(bare)),[]);assert.match(bare[0].question,/Sign in/);
});
