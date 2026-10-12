import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appUserBinding } from '../debug-app-user.mjs';
import { runOdcNativeLive } from '../debug-odc-native-live.mjs';
import { qualifyClientLocalRuntime, qualifyClientLocalHistory, createClientLocalNetworkBarrier } from '../debug-odc-native-client-local.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const source = `import { telemetry as spans } from './core.js'; class C {
 _close$Action(e) { var r={},t=this.model,g=this.controller,f=this.idService;
  return spans.startActiveSpan("Close",function(d) { try {
   g.ensureControllerAlive("Close"),e=g.callContext(e),r.model=t,r.idService=f,r.callContext=e;
   try { OutSystemsDebugger.push("key",e.id,r),t.variables.flagVar=!1,OutSystemsDebugger.handleBreakpoint("end",e.id); }
   catch(l) { throw OutSystemsDebugger.handleException(l,e.id),l; }
   finally { OutSystemsDebugger.pop("key",e.id); }
  } finally { d&&d.end(); } },1); }
 close$Action(e) { var r=this.controller; return spans.startActiveSpan("Close__proxy",function(t) {
  try { return r.safeExecuteClientAction(r._close$Action,e); } finally { t&&t.end(); }
 },0); }
}`;
function fixture(t, deadPid, changedSource = source, dynamicSidecall = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-client-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, data) => { const f=path.join(root,relative); fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); return f; };
  const operationId='40448a18-0401-4ae0-9731-11cc80ac08a0', sessionId='a'.repeat(32), actionKey='A'.repeat(22);
  const binding={tenant:'dev.example.test',module:'Store',app:'Store',moduleKey:'B'.repeat(22),runtimeUrl:'https://dev.example.test/Store/',revision:1};
  const historical={schema:'ssam-odc-native-run/1',lane:'odc',operationId,sessionId,binding,uncertain:true,lockRetained:true,credentialsReleased:true,
    serverTrace:{sessionId,stopped:true},results:[{name:'old',uncertain:true}]};
  const debug={ok:true,state:'stopped',sessionId,lane:'odc',expiresAt:'2025-01-01T00:00:00Z',processId:deadPid};
  const manifest={sessionId,lane:'odc',appUser:{binding:appUserBinding({...binding,lane:'odc'},sessionId),expiresAt:'2025-01-01T00:00:00Z'}};
  const oldFile=write('.local/debugger/native-runs/odc/'+operationId+'/receipt.json',historical);
  const debugFile=write('.local/debugger/'+sessionId+'/receipt.json',debug), manifestFile=write('.local/debugger/'+sessionId+'/manifest.json',manifest);
  const key=sha('odc|'+binding.runtimeUrl+'|'+binding.moduleKey);
  const lock=write('.local/debugger/native-runs/'+key+'.lock',{operationId,sessionId});
  const latest=write('.local/debugger/native-runs/odc/'+key+'.json',historical);
  const protectedFiles=[oldFile,debugFile,manifestFile,lock,latest], pins=protectedFiles.map(f=>sha(fs.readFileSync(f)));
  const appFile=write('model.oml','synthetic original source'), chunk=write('client.js',changedSource);
  const coreSource='var telemetry=Object.freeze({startActiveSpan:start});function start(){};', core=write('core.js',coreSource);
  const prepared={action:{key:actionKey,kind:'ScreenAction',name:'Close'},entry:{key:actionKey,kind:'ScreenAction'},path:[{key:actionKey}],
    effects:[],effectEvidence:[],bindings:[],runtimeRequestKeys:[actionKey],assumptions:[],scenarios:[{name:'independent',inputs:{}}]};
  const member={key:actionKey,chunk:'client.js',type:'CLIENT_SCREEN_ACTION',classStart:changedSource.indexOf('class C'),holder:{name:'close$Action',kind:'method'}};
  const runtime={moduleVersion:'v1',pins:{'client.js':{path:chunk,sha256:sha(changedSource)},'core.js':{path:core,sha256:sha(coreSource)}},index:{
    chunks:{'core.js':{keepNames:{start:'startActiveSpan',widget:'WidgetIdService'},exports:{telemetry:'telemetry'}}},functions:{[actionKey]:[
    member,{...member,holder:{name:'_close$Action',kind:'method'},nativeProxy:'close$Action'}]},views:{},screens:{},groups:{}}};
  const node=(kind,key,extra={})=>({kind,key,children:[],childrenOmitted:0,propertyErrors:{},...extra});
  const tree=node('ScreenAction',actionKey,{children:[node('StartNode','start',{propertyReferences:{Target:{key:'assign'}}}),
    node('AssignNode','assign',{propertyReferences:{Target:{key:'end'}},children:[node('Assignment','value',{properties:{Variable:'Flag',Value:'False'}})]}),node('EndNode','end')]});
  const readers={binding,sourceContract:{path:appFile,sha256:sha('synthetic original source')},runtime,tree:async()=>tree,verifyPublication:async()=>{}};
  const events=[], network={calls:0}; let barrier, state;
  const services={root,clientLocal:{operationId,receiptSha256:pins[0],debugReceiptSha256:pins[1],manifestSha256:pins[2]},
    prepareUser:async(input,{sessionId:newId})=>{events.push('login');return{ok:true,descriptor:{binding:appUserBinding({...input,lane:'odc'},newId),expiresAt:new Date(Date.now()+60000).toISOString()}};},
    releaseUser:async()=>({ok:true}),debug:async()=>{throw Error('server debugger must not start');},
    broker:()=>({
      prepare:async input=>{events.push('prepare');assert.deepEqual(qualifyClientLocalRuntime(prepared,runtime,input.clientLocal.model),input.clientLocal);barrier=createClientLocalNetworkBarrier(true);},
      authenticate:async()=>{barrier.check('metadata');return{authenticated:true,identityMatches:true,permissionCheck:true};},
      invoke:async call=>{
        events.push('invoke'); barrier.enter();
        const context=vm.createContext({spans:{startActiveSpan:(_name,fn)=>fn(null)},OutSystemsDebugger:{push(){},pop(){},handleBreakpoint(){},handleException(){}},
          nativeSidecall:()=>{barrier.check('action');network.calls++;}});
        const C=vm.runInContext(changedSource.slice(changedSource.indexOf('class C'))+';C',context);const c=new C();c.model={variables:{flagVar:true}};c.controller=c;c.idService={};
        c.ensureControllerAlive=()=>{};c.callContext=e=>e;c.safeExecuteClientAction=(fn,e)=>{if(dynamicSidecall)context.nativeSidecall();return fn.call(c,e);};
        try{c.close$Action({id:'fresh'});state=c.model.variables.flagVar;return{name:call.name,ok:true,uncertain:false,visits:[],clientLocal:barrier.receipt()};}
        catch(error){return{name:call.name,ok:false,error:error.message,uncertain:false,visits:[],clientLocal:barrier.receipt()};}
      },dispose:async()=>({completed:true,receipt:{clientLocal:barrier?.receipt(),transport:{networkRequests:0}}}),
    })};
  return{root,readers,prepared,services,events,network,protectedFiles,pins,state:()=>state};
}

test('independent client-local runs original state flow while preserving uncertain history and denying static/dynamic sidecalls', async t=>{
  const exited=spawnSync(process.execPath,['-e',''],{windowsHide:true});assert.equal(exited.status,0);assert.ok(exited.pid);
  const f=fixture(t,exited.pid);
  const result=await runOdcNativeLive({trace:'none'},f.prepared,f.readers,f.services);
  assert.equal(result.ok,true,result.error);assert.equal(f.state(),false);assert.notEqual(result.sessionId,'a'.repeat(32));
  assert.deepEqual(f.events,['prepare','login','invoke']);assert.equal(result.independentClientLocal.executionOutcomeReconciled,false);
  assert.equal(result.independentClientLocal.historicalLockPreserved,true);assert.equal(f.network.calls,0);
  assert.deepEqual(f.protectedFiles.map(file=>sha(fs.readFileSync(file))),f.pins);
  const ordinary=await runOdcNativeLive({trace:'none'},f.prepared,f.readers,{...f.services,clientLocal:undefined});
  assert.equal(ordinary.error,'debug_odc_native_binding_busy');
  const changed=fixture(t,exited.pid,source.replace('t.variables.flagVar=!1','fetch("https://forbidden.invalid"),t.variables.flagVar=!1'));
  const rejected=await runOdcNativeLive({trace:'none'},changed.prepared,changed.readers,changed.services);
  assert.equal(rejected.error,'debug_odc_native_client_local_runtime_sidecall');assert.deepEqual(changed.events,[]);
  const indirect=fixture(t,exited.pid,source,true);
  const denied=await runOdcNativeLive({trace:'none'},indirect.prepared,indirect.readers,indirect.services);
  assert.equal(denied.ok,false);assert.equal(denied.results[0].error,'debug_odc_native_client_local_isolation_unproved');
  assert.equal(indirect.network.calls,0);assert.equal(denied.results[0].clientLocal.networkAttemptsBlocked,1);
  assert.deepEqual(indirect.protectedFiles.map(file=>sha(fs.readFileSync(file))),indirect.pins);
  assert.throws(()=>qualifyClientLocalHistory(f.root,{...f.readers.binding,module:'Other'},f.services.clientLocal),/history_binding_mismatch/);
  fs.appendFileSync(f.protectedFiles[0],' ');
  assert.throws(()=>qualifyClientLocalHistory(f.root,f.readers.binding,f.services.clientLocal),/evidence_changed/);
});
