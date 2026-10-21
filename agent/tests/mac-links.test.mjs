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
test('links: Contents junction is rejected and diagnosed',async t=>{
 const m=machine(t),b=m.app('o11',{files:pair('o11')});const alias='/Applications/Alias.app';fs.mkdirSync(m.physical(alias));
 fs.symlinkSync(m.physical(b+'/Contents'),m.physical(alias+'/Contents'),'junction');
 assert.equal(await inspectBundle(alias,{fs:m.io}),null);
 const d=await macDoctor({deps:m.attach(b,'o11').deps});assert.ok(d.facts.candidates.some(c=>c.bundle===alias&&/link/i.test(c.reason)));
});
test('links: app junction and lexical official location cannot authorize an outside bundle',async t=>{
 const m=machine(t),b=m.app('o11',{files:pair('o11')});fs.mkdirSync(m.physical('/outside'),{recursive:true});fs.renameSync(m.physical(b),m.physical('/outside/Real.app'));
 fs.symlinkSync(m.physical('/outside/Real.app'),m.physical(b),'junction');
 assert.equal(officialBundle(b,'/Users/test',{fs:m.io}),false);assert.equal(await inspectBundle(b,{fs:m.io}),null);
 const d=await macDoctor({deps:m.attach(b,'o11').deps});assert.ok(d.facts.candidates.some(c=>c.bundle===b&&/link/i.test(c.reason)));
});
