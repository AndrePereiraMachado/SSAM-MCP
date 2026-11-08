// Server-only, ODC lane: a static check that the published ODC bridge's Studio references still resolve in a new ODC Studio.
// The published bridge (agent Bridge.csproj) is compiled against named assemblies of an ODC Studio folder
// (<Reference Include="$(OdcInstall)\X.dll">). The new Studio is compared, assembly by assembly, with the served ODC Studio
// of the same .NET major the published bridge already runs in: each referenced assembly must exist, keep its name and its
// public key token (strong-name identity), keep its major version, and never go below the served version (the .NET loader
// binds a reference only to an equal or higher version).
// What this does NOT prove: that the types, members and signatures the bridge calls still exist with the same shape inside the
// same major (OutSystems builds keep 13.0.0.0 or move the build number on every release), that the Studio behaves the same,
// or that the bridge actually loads and runs there. Only a live attach of the published pack proves that. It also compares
// against the served Studio, not the bridge's own AssemblyRef table (the published bridge binary is not in the store).
// The served Studio is read from its frozen bundle, which keeps only the files of docker/ssam-server/studio-odc.txt: a
// reference that list leaves out (the embedded browser: WebViewControl.Avalonia, Xilium.CefGlue, Xilium.CefGlue.Common) has
// no served identity, so it is only required to exist in the new Studio (its installed folder) and listed as notCompared.
// Reads files only: no process, network or Git.
import fs from 'node:fs';
import path from 'node:path';
import {assemblyIdentity} from './pe-metadata.mjs';
import {tfmMajor,compareVersion} from './window.mjs';
// The ODC Studio assemblies a bridge project references (file names without .dll), or null when it names none.
export function bridgeReferences(project){
 const names=[...String(project??'').matchAll(/<Reference\s+Include="\$\(OdcInstall\)[\\/]([^"\\/]+)\.dll"/g)].map(m=>m[1]);
 return names.length?[...new Set(names)]:null;
}
const four=v=>String(v).split('.').map(Number);
const compare4=(a,b)=>{const x=four(a),y=four(b);for(let i=0;i<4;i++)if((x[i]??0)!==(y[i]??0))return (x[i]??0)-(y[i]??0);return 0;};
const identityOf=file=>{if(!fs.existsSync(file))return {missing:true};try{return assemblyIdentity(file)??{error:'no assembly definition'};}catch(e){return {error:e.message};}};
// The reference differences of one candidate ODC Studio folder against the served one. gaps: why the published bridge may not
// bind there (empty: every reference resolves by identity); compared: the identities read.
// identity: the reader of one file (tests pass their own to reach every rule); the default reads its AssemblyDef.
// installed: the new Studio's full folder (the verified installer's extraction), where a reference the frozen copies do not
// keep must exist.
export function odcReferenceGaps({references,reference,candidate,installed=null,identity=identityOf}){
 if(!references?.length)return {gaps:['the reviewed agent release declares no ODC Studio references (agent/platforms/odc/studio/bridge/Bridge.csproj)'],compared:[]};
 if(tfmMajor(reference.tfm)===null||tfmMajor(reference.tfm)!==tfmMajor(candidate.tfm))return {gaps:[`the served ODC Studio ${reference.version} runs ${reference.tfm??'an unknown runtime'}, not ${candidate.tfm??'an unknown runtime'}: no served Studio to compare with`],compared:[]};
 for(const [what,s] of [['served',reference],['new',candidate]])if(typeof s.dir!=='string'||!s.dir)return {gaps:[`the ${what} ODC Studio ${s.version} has no frozen copy to read`],compared:[]};
 const gaps=[],compared=[],notCompared=[];
 for(const name of references){
  const was=identity(path.join(reference.dir,name+'.dll')),now=identity(path.join(candidate.dir,name+'.dll'));
  if(was.missing){
   // No served identity to compare with: the new Studio must still have it (its frozen copy or its installed folder).
   const full=now.missing&&installed?identity(path.join(installed,name+'.dll')):now;
   if(full.missing&&installed)gaps.push(`${name}.dll is missing in ODC Studio ${candidate.version}`);
   else notCompared.push({name,candidate:full.missing?null:full.version??null,why:`not in the frozen copy of the served ODC Studio ${reference.version}`+(full.missing?', nor in the new one, and no installed folder to look in':'')});
   continue;
  }
  if(now.missing){gaps.push(`${name}.dll is missing in ODC Studio ${candidate.version}`);continue;}
  if(was.error||now.error){gaps.push(`${name}.dll metadata is unreadable (${was.error??now.error})`);continue;}
  const row={name,served:was.version,candidate:now.version,publicKeyToken:now.publicKeyToken};compared.push(row);
  if(now.name!==was.name)gaps.push(`${name}.dll defines assembly ${now.name}, not ${was.name}`);
  else if(now.publicKeyToken!==was.publicKeyToken)gaps.push(`${name} changed its strong name (public key token ${was.publicKeyToken??'none'} -> ${now.publicKeyToken??'none'})`);
  else if(four(now.version)[0]!==four(was.version)[0])gaps.push(`${name} changed major version (${was.version} -> ${now.version})`);
  else if(compare4(now.version,was.version)<0)gaps.push(`${name} went down (${was.version} -> ${now.version}); a reference binds only to an equal or higher version`);
 }
 return {gaps,compared,notCompared};
}
// The served ODC Studio to compare a candidate with: the newest served version whose frozen copy runs the candidate's .NET
// major (the published bridge for that runtime already runs there). companion(lane, version) gives the served bundle.
export async function odcBinaryCheck({references,candidate,installed=null,served,companion}){
 const versions=[...new Set(served)].filter(v=>v!==candidate.version).sort((a,b)=>compareVersion(b,a));
 for(const v of versions){
  const b=await companion('odc',v);
  if(tfmMajor(b?.tfm)!==null&&tfmMajor(b.tfm)===tfmMajor(candidate.tfm))return {reference:v,...odcReferenceGaps({references,reference:{dir:b.snapshot,version:v,tfm:b.tfm},candidate:{dir:candidate.snapshot,version:candidate.version,tfm:candidate.tfm},installed})};
 }
 return {reference:null,gaps:[`no served ODC Studio runs ${candidate.tfm??'an unknown runtime'}, so the published bridge's references cannot be compared`],compared:[]};
}
