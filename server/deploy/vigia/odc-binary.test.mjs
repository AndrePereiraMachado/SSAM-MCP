// M3 (review round 2): the static check that the published ODC bridge's Studio references still resolve in a new ODC Studio.
// Real assemblies of the .NET runtime installed here stand in for Studio folders (skipped when it is absent); the rules a
// real pair of folders cannot reach (token, major, a lower version) use a reader of identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bridgeReferences,odcReferenceGaps,odcBinaryCheck} from './odc-binary.mjs';
import {assemblyIdentity} from './pe-metadata.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const tmp=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'odc-binary-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
const shared='C:/Program Files/dotnet/shared/Microsoft.NETCore.App';
const runtime=fs.existsSync(shared)?fs.readdirSync(shared).filter(v=>/^\d+\.\d+\.\d+$/.test(v)).map(v=>path.join(shared,v)).find(d=>['System.Runtime.dll','netstandard.dll','mscorlib.dll'].every(n=>fs.existsSync(path.join(d,n)))):null;
const skip=runtime?false:'no .NET shared runtime with System.Runtime, netstandard and mscorlib on this machine';
const project=fs.readFileSync(path.resolve(here,'../../../agent/platforms/odc/studio/bridge/Bridge.csproj'),'utf8');
const folder=(t,files)=>{const d=tmp(t);for(const [name,from] of Object.entries(files))fs.copyFileSync(path.join(runtime,from+'.dll'),path.join(d,name+'.dll'));return d;};
const names=['System.Runtime','netstandard','mscorlib'];
const same=Object.fromEntries(names.map(n=>[n,n]));

test('the release bridge project names the ODC Studio assemblies it is compiled against',()=>{
 const refs=bridgeReferences(project);
 assert.equal(refs.length,25);assert.equal(refs[0],'OutSystems.Model');assert.ok(refs.includes('ServiceStudio.Framework')&&refs.includes('Xilium.CefGlue.Common'));
 assert.equal(bridgeReferences('<Project/>'),null);assert.equal(bridgeReferences(null),null);
 // Only $(OdcInstall) references: a package or another folder is not a Studio assembly.
 assert.deepEqual(bridgeReferences('<Reference Include="$(OdcInstall)\\A.dll" /><Reference Include="C:\\x\\B.dll" /><Reference Include="$(OdcInstall)/C.dll"/>'),['A','C']);
});
test('the identity reader gives the strong name of real assemblies',{skip},()=>{
 assert.deepEqual(assemblyIdentity(path.join(runtime,'mscorlib.dll')),{name:'mscorlib',version:'4.0.0.0',publicKeyToken:'b77a5c561934e089'});
 assert.equal(assemblyIdentity(path.join(runtime,'netstandard.dll')).publicKeyToken,'cc7b13ffcd2ddd51');
 assert.equal(assemblyIdentity(path.join(runtime,'System.Runtime.dll')).publicKeyToken,'b03f5f7f11d50a3a');
});
test('real folders: identical assemblies match; a missing one, a renamed one or an unreadable one is a gap',{skip},t=>{
 const served={dir:folder(t,same),version:'1.7.31',tfm:'net10.0'};
 const ok=odcReferenceGaps({references:names,reference:served,candidate:{dir:folder(t,same),version:'1.7.33',tfm:'net10.0'}});
 assert.deepEqual(ok.gaps,[]);assert.deepEqual(ok.compared.map(c=>c.name),names);
 const missing=folder(t,{'System.Runtime':'System.Runtime',netstandard:'netstandard'});
 assert.deepEqual(odcReferenceGaps({references:names,reference:served,candidate:{dir:missing,version:'1.7.33',tfm:'net10.0'}}).gaps,['mscorlib.dll is missing in ODC Studio 1.7.33']);
 // mscorlib.dll that holds another assembly (netstandard): its name and strong name differ.
 const swapped=folder(t,{...same,mscorlib:'netstandard'});
 assert.deepEqual(odcReferenceGaps({references:names,reference:served,candidate:{dir:swapped,version:'1.7.33',tfm:'net10.0'}}).gaps,['mscorlib.dll defines assembly netstandard, not mscorlib']);
 const broken=folder(t,same);fs.writeFileSync(path.join(broken,'netstandard.dll'),'MZ not an assembly');
 assert.match(odcReferenceGaps({references:names,reference:served,candidate:{dir:broken,version:'1.7.33',tfm:'net10.0'}}).gaps[0],/^netstandard\.dll metadata is unreadable/);
});
test('a reference the frozen bundles leave out (studio-odc.txt keeps no embedded browser) must exist in the installed Studio, and is listed as not compared',{skip},t=>{
 // The real list: the three browser assemblies the bridge references are not in the bundle list, so no served copy has them.
 const list=fs.readFileSync(path.resolve(here,'../../docker/ssam-server/studio-odc.txt'),'utf8').split(/\r?\n/).map(l=>l.trim().replace(/^\?/,'').trim());
 assert.deepEqual(bridgeReferences(project).filter(n=>!list.includes(n+'.dll')),['WebViewControl.Avalonia','Xilium.CefGlue','Xilium.CefGlue.Common']);
 const served={dir:folder(t,same),version:'1.7.31',tfm:'net10.0'},candidate={dir:folder(t,same),version:'1.7.33',tfm:'net10.0'},refs=[...names,'Xilium.CefGlue'];
 const installed=folder(t,{...same,'Xilium.CefGlue':'System.Runtime'});
 const ok=odcReferenceGaps({references:refs,reference:served,candidate,installed});
 assert.deepEqual(ok.gaps,[]);assert.deepEqual(ok.notCompared.map(n=>[n.name,n.candidate]),[['Xilium.CefGlue',assemblyIdentity(path.join(runtime,'System.Runtime.dll')).version]]);
 assert.deepEqual(odcReferenceGaps({references:refs,reference:served,candidate,installed:folder(t,same)}).gaps,['Xilium.CefGlue.dll is missing in ODC Studio 1.7.33']);
 // Without an installed folder (a served companion) nothing more can be read: not compared, said so.
 assert.match(odcReferenceGaps({references:refs,reference:served,candidate}).notCompared[0].why,/no installed folder to look in/);
});
test('the rules: strong name, major, a lower version are gaps; a higher version of the same major passes',()=>{
 const ids={
  'r/A.dll':{name:'A',version:'13.0.0.0',publicKeyToken:null},'r/B.dll':{name:'B',version:'1.7.31.11000',publicKeyToken:null},'r/C.dll':{name:'C',version:'11.3.22.0',publicKeyToken:'c8d484a7012f9a8b'},
  'n/A.dll':{name:'A',version:'14.0.0.0',publicKeyToken:null},'n/B.dll':{name:'B',version:'1.7.30.9000',publicKeyToken:null},'n/C.dll':{name:'C',version:'11.3.22.0',publicKeyToken:'0000000000000000'},
  'h/A.dll':{name:'A',version:'13.0.0.0',publicKeyToken:null},'h/B.dll':{name:'B',version:'1.7.33.11200',publicKeyToken:null},'h/C.dll':{name:'C',version:'11.3.30.0',publicKeyToken:'c8d484a7012f9a8b'}};
 const identity=file=>ids[path.basename(path.dirname(file))+'/'+path.basename(file)]??{missing:true};
 const bad=odcReferenceGaps({references:['A','B','C'],reference:{dir:'r',version:'1.7.31',tfm:'net10.0'},candidate:{dir:'n',version:'1.7.33',tfm:'net10.0'},identity});
 assert.deepEqual(bad.gaps,['A changed major version (13.0.0.0 -> 14.0.0.0)','B went down (1.7.31.11000 -> 1.7.30.9000); a reference binds only to an equal or higher version','C changed its strong name (public key token c8d484a7012f9a8b -> 0000000000000000)']);
 assert.deepEqual(odcReferenceGaps({references:['A','B','C'],reference:{dir:'r',version:'1.7.31',tfm:'net10.0'},candidate:{dir:'h',version:'1.7.33',tfm:'net10.0'},identity}).gaps,[]);
 // No references, another runtime, or no frozen copy: nothing is proven, so it is a gap.
 assert.match(odcReferenceGaps({references:null,reference:{dir:'r'},candidate:{dir:'n'}}).gaps[0],/declares no ODC Studio references/);
 assert.match(odcReferenceGaps({references:['A'],reference:{dir:'r',version:'1.7.29',tfm:'net8.0'},candidate:{dir:'n',version:'1.7.33',tfm:'net10.0'},identity}).gaps[0],/runs net8\.0, not net10\.0/);
 assert.match(odcReferenceGaps({references:['A'],reference:{version:'1.7.31',tfm:'net10.0'},candidate:{dir:'n',version:'1.7.33',tfm:'net10.0'},identity}).gaps[0],/has no frozen copy/);
});
test('the served Studio compared is the newest of the candidate runtime; none of that runtime is a gap',{skip},async t=>{
 const dirs={'1.7.31':folder(t,same),'1.7.29':folder(t,same)},asked=[];
 const companion=async(lane,v)=>{asked.push(lane+' '+v);return {snapshot:dirs[v],tfm:v==='1.7.29'?'net8.0':'net10.0'};};
 const r=await odcBinaryCheck({references:names,candidate:{snapshot:folder(t,same),version:'1.7.33',tfm:'net10.0'},served:['1.7.29','1.7.31','1.7.29'],companion});
 assert.equal(r.reference,'1.7.31');assert.deepEqual(r.gaps,[]);assert.deepEqual(asked,['odc 1.7.31']);
 const none=await odcBinaryCheck({references:names,candidate:{snapshot:folder(t,same),version:'1.7.33',tfm:'net11.0'},served:['1.7.29','1.7.31'],companion});
 assert.equal(none.reference,null);assert.match(none.gaps[0],/no served ODC Studio runs net11\.0/);
});
