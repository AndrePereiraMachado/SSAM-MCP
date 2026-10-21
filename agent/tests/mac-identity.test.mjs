import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {inspectBundle,officialBundle} from '../agent/lib/macos.mjs';
import {createMacAttach} from '../agent/lib/attach-unix.mjs';
import {macDoctor} from '../agent/lib/mac-doctor.mjs';
function machine(t) {
 const disk=fs.mkdtempSync(path.join(os.tmpdir(),'mac-identity-'));
 t.after(()=>fs.rmSync(disk,{recursive:true,force:true}));
 const physical=p=>typeof p==='string'&&p.startsWith('/')?path.join(disk,...p.split('/').filter(Boolean)):p;
 const io={...fs};
 for(const k of ['readFileSync','readdirSync','statSync','lstatSync','existsSync','openSync'])io[k]=(...a)=>fs[k](physical(a[0]),...a.slice(1));
 io.realpathSync=p=>'/'+path.relative(disk,fs.realpathSync(physical(p))).replaceAll('\\','/');
 const put=(p,data='fixture')=>{fs.mkdirSync(path.dirname(physical(p)),{recursive:true});fs.writeFileSync(physical(p),data)};
 const app=(lane,{exe='Calculator',id='org.example.calculator',files={},name=lane}={})=>{
  const b='/Applications/'+name+'.app';
  const values={CFBundleExecutable:exe,CFBundleIdentifier:id,CFBundleShortVersionString:'11.55.71',CFBundleVersion:'1234'};
  put(b+'/Contents/Info.plist','<plist><dict>'+Object.entries(values).map(([k,v])=>'<key>'+k+'</key><string>'+v+'</string>').join('')+'</dict></plist>');
  put(b+'/Contents/MacOS/'+exe);
  put(b+'/Contents/Resources/deps/'+(lane==='odc'?'OutSystems.Model.dll':'OutSystems.Model.V1.dll'));
  for(const [p,v]of Object.entries(files))put(b+'/Contents/'+p,v);
  return b;
 };
 const sec=Math.floor(new Date(2026,9,21,8).getTime()/1000);
 const attach=(b,lane,{entrypoint=lane==='odc'?'ODCStudio':'ServiceStudio',commandLine,exe='Calculator'}={})=>{
  put('/sockets/dotnet-diagnostic-701-'+sec+'-socket');put('/hooks/ODC3.Bridge.v97.dll');put('/hooks/Anvil.RuntimeHook.dll');
  let sent=0;
  const deps={fs:io,home:'/Users/test',env:{TMPDIR:'/sockets'},ps:async()=>`701 Wed Oct 21 08:00:00 2026 ${b}/Contents/MacOS/${exe}`,
   run:async file=>file.endsWith('getconf')?'/sockets':file.endsWith('lsof')?'n'+b+'/Contents/Resources/ServiceStudio.dll\n':'',
   readers:{checked:async()=>({sec,usec:123000})},calibrate:async()=>({trusted:['checked'],results:[]}),
   ipc:{processInfo2:async()=>({pid:701,clrVersion:'8.0.1',entrypoint,commandLine:commandLine??`"${b}/Contents/MacOS/${exe}" --flag`,arch:'arm64',os:'OSX'}),applyStartupHook:async()=>{sent++}}};
  const a=createMacAttach(deps);
  return {a,deps,sent:()=>sent,go:async()=>{if(lane==='odc')return a.attachOdc({pid:701,bridge:physical('/hooks/ODC3.Bridge.v97.dll'),version:'v97'}); const d=await a.describeO11(701);return a.attachO11(701,d.startedUtc,physical('/hooks/Anvil.RuntimeHook.dll'));}};
 };
 return {app,put,attach,io,physical};
}
const family=lane=>lane==='odc'?'ODCStudio':'ServiceStudio';
const pair=lane=>({['Resources/bin/'+family(lane)+'.dll']:'fixture',['Resources/config/'+family(lane)+'.runtimeconfig.json']:'{}'});
for(const lane of ['o11','odc'])test(`identity: ${lane} dependency alone cannot authorize discovery or a hook`,async t=>{
 const m=machine(t),b=m.app(lane),a=m.attach(b,lane);
 assert.equal(await inspectBundle(b,{fs:m.io}),null);
 await assert.rejects(a.go);assert.equal(a.sent(),0);
 const d=await macDoctor({deps:a.deps});const c=d.facts.candidates.find(c=>c.bundle===b);
 assert.match(c.reason,/candidate with OutSystems assemblies and no Studio identity/);
 assert.ok(c.markers.every(p=>p.startsWith('Contents/')));assert.deepEqual(c.runtimeConfigs,[]);assert.equal(c.plist.CFBundleExecutable,'Calculator');
 const positive=m.app(lane,{name:'Positive',files:{...pair(lane),'Resources/other/OutSystems.Model.V1.dll':'fixture'}});
 assert.equal((await inspectBundle(positive,{fs:m.io})).kind,lane);
 const good=m.attach(positive,lane);await good.go();assert.equal(good.sent(),1);
});
test('config: family DLL alone must not hide the executable hooks-off config',async t=>{
 const m=machine(t),b=m.app('o11',{files:{'Resources/ServiceStudio.dll':'fixture','MacOS/Calculator.dll':'fixture','MacOS/Calculator.runtimeconfig.json':JSON.stringify({runtimeOptions:{configProperties:{'System.StartupHookProvider.IsSupported':false}}})}});
 assert.equal((await inspectBundle(b,{fs:m.io})).entry,'Calculator');
 const a=m.attach(b,'o11');await assert.rejects(a.go);assert.equal(a.sent(),0);
});
test('config: missing coherent runtimeconfig is unknown and refuses before sending',async t=>{
 const m=machine(t),b=m.app('o11',{files:{'Resources/ServiceStudio.dll':'fixture'}}),a=m.attach(b,'o11');
 const info=await inspectBundle(b,{fs:m.io});assert.equal(info.entry,null);assert.deepEqual(info.runtimeConfig,{missing:true});
 await assert.rejects(a.go,/cannot tell whether the Studio allows startup hooks/);assert.equal(a.sent(),0);
 assert.equal((await macDoctor({deps:a.deps})).facts.studios[0].startupHooks,'unknown');
});
test('IPC: wrong managed entrypoint is refused in both lanes',async t=>{
 const m=machine(t);
 for(const lane of ['o11','odc']) {const b=m.app(lane,{files:pair(lane)}),a=m.attach(b,lane,{entrypoint:'Calculator.dll'});await assert.rejects(a.go,/entrypoint/);assert.equal(a.sent(),0);}
});
test('IPC: empty, foreign and prefix-collision command lines are refused',async t=>{
 const m=machine(t);
 for(const lane of ['o11','odc']){const b=m.app(lane,{files:pair(lane)});for(const commandLine of ['', '/Downloads/Calculator',b+'/Contents/MacOS/CalculatorOther']){const a=m.attach(b,lane,{commandLine});await assert.rejects(a.go,/command line/i);assert.equal(a.sent(),0);}}
});
