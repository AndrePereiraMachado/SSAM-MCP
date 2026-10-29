// The ODC features (Features.plain.xml: the tenant's feature toggles the ODC kernel initializes its static provider with)
// the watcher gives each ODC version, without a signed-in Studio per version. The headless model answers from the
// ModelAPI provider compiled into each version; the file only has to be a readable <Features> document and carry the
// values of the few flags the kernel's assemblies read. So a version without its own exact export gets the nearest exact
// file CARRIED (a byte copy), with a static drift check on the new version's frozen assemblies and a signed provenance.
// Feature values are never logged or written outside the private store: counts, names and sha256 only.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readJournal,writeJournal} from './journal.mjs';
import {EnvironmentError} from './pipeline.mjs';
import {featureCatalog,featureReads,userStringGuids} from './pe-metadata.mjs';
import {version as threeOf,compareVersion} from './window.mjs';
export const FEATURES_SCHEMA='ssam-odc-features/1';
export const FEATURES_MAX_BYTES=1024*1024;
const MODES=new Set(['exact','carried','defaults']);
const KINDS=new Set(['Boolean','Integer','String']);
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL=/^\d+\.\d+\.\d+\.\d+$/;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const refuse=(label,why)=>Object.assign(new EnvironmentError(`The ODC features ${label} are refused before use: ${why}. Nothing was used or stored.`,'features-invalid',['odc']),{why});
const ENTITY={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
function unescape(text,label){
 return text.replace(/&([^;&\s]*);?/g,(all,name)=>{
  if(!all.endsWith(';'))throw refuse(label,'a bare & outside an entity reference');
  if(Object.hasOwn(ENTITY,name))return ENTITY[name];
  const m=/^#(?:x([0-9a-f]{1,6})|(\d{1,7}))$/i.exec(name);
  if(m){const code=m[1]?parseInt(m[1],16):Number(m[2]);if(code===0||code>0x10ffff)throw refuse(label,'an invalid character reference');return String.fromCodePoint(code);}
  throw refuse(label,'an unknown entity reference');
 });
}
// Strict parse of a Features.plain.xml: at most 1 MiB, UTF-8 without a byte order mark (the export's bytes, the only
// encoding features-protect.ps1 prepares), no DOCTYPE or ENTITY, root <Features>
// with an optional Version (a.b.c.d), children only <Feature key="GUID" kind="Boolean|Integer|String">, Boolean True or
// False, Integer an integer, no duplicate key. Returns the version, the entries by lowercase key, the sha256 and what the
// carry needs to filter entries out (the decoded text and each entry's span).
export function parseFeatures(input,label='(in memory)'){
 const bytes=Buffer.from(input);
 if(bytes.length>FEATURES_MAX_BYTES)throw refuse(label,`${bytes.length} bytes, above the ${FEATURES_MAX_BYTES} byte limit`);
 if((bytes[0]===0xff&&bytes[1]===0xfe)||(bytes[0]===0xfe&&bytes[1]===0xff)||(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf))throw refuse(label,"not the export's encoding (UTF-8 without a byte order mark, the one features-protect.ps1 and the ODC Studio provider read)");
 let text;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw refuse(label,'not valid UTF-8');}
 if(/<!DOCTYPE|<!ENTITY/i.test(text))throw refuse(label,'a DOCTYPE or ENTITY declaration');
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(text))throw refuse(label,'a control character');
 let i=0;const ws=()=>{while(i<text.length&&/[ \t\r\n]/.test(text[i]))i++;};
 // name="value" pairs up to > or />; only the names given are accepted, each once.
 const attributes=(allowed,what)=>{
  const out={};
  for(;;){
   const before=i;ws();
   if(text.startsWith('/>',i)){i+=2;return {out,empty:true};}
   if(text[i]==='>'){i++;return {out,empty:false};}
   if(i===before)throw refuse(label,`${what} is malformed`);
   const m=/^([A-Za-z_][\w.-]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(text.slice(i,i+4096));
   if(!m)throw refuse(label,`${what} has a malformed attribute`);
   if(!allowed.includes(m[1]))throw refuse(label,`${what} has an unexpected attribute ${m[1]}`);
   if(m[1] in out)throw refuse(label,`${what} repeats the attribute ${m[1]}`);
   out[m[1]]=unescape(m[3]??m[4],label);i+=m[0].length;
  }
 };
 ws();
 if(text.startsWith('<?xml',i)){
  const end=text.indexOf('?>',i);if(end<0)throw refuse(label,'the XML declaration does not end');
  if(!/^<\?xml\s+version\s*=\s*(["'])1\.\d\1(\s+encoding\s*=\s*(["'])[A-Za-z][\w.-]*\3)?(\s+standalone\s*=\s*(["'])(yes|no)\5)?\s*\?>$/.test(text.slice(i,end+2)))throw refuse(label,'a malformed XML declaration');
  i=end+2;ws();
 }
 if(!/^<Features[\s/>]/.test(text.slice(i,i+10)))throw refuse(label,'the root element is not <Features>');
 i+='<Features'.length;
 const root=attributes(['Version'],'<Features>'),version=root.out.Version??null;
 if(version!==null&&!FULL.test(version))throw refuse(label,'the Features Version is not a four-part version');
 const entries=new Map(),spans=new Map();
 if(!root.empty)for(;;){
  const lead=i;ws();
  if(text.startsWith('</Features',i)){i+='</Features'.length;ws();if(text[i]!=='>')throw refuse(label,'the root element does not close');i++;break;}
  if(!/^<Feature[\s/>]/.test(text.slice(i,i+9)))throw refuse(label,i>=text.length?'the root element does not close':'an element, text or markup other than <Feature> inside <Features>');
  i+='<Feature'.length;
  const a=attributes(['key','kind'],'a <Feature>');
  if(!a.out.key||!GUID.test(a.out.key))throw refuse(label,'a Feature key is not a GUID');
  if(!KINDS.has(a.out.kind))throw refuse(label,'a Feature kind is not Boolean, Integer or String');
  let value='';
  if(!a.empty){
   const end=text.indexOf('<',i);if(end<0)throw refuse(label,'a Feature does not close');
   value=unescape(text.slice(i,end),label);i=end;
   if(!text.startsWith('</Feature',i))throw refuse(label,'a Feature holds markup');
   i+='</Feature'.length;ws();if(text[i]!=='>')throw refuse(label,'a Feature does not close');i++;
  }
  if(a.out.kind==='Boolean'&&!/^(True|False)$/.test(value))throw refuse(label,'a Boolean Feature is not True or False');
  if(a.out.kind==='Integer'&&!/^-?\d{1,19}$/.test(value))throw refuse(label,'an Integer Feature is not an integer');
  const key=a.out.key.toLowerCase();
  if(entries.has(key))throw refuse(label,'a Feature key appears twice');
  entries.set(key,{kind:a.out.kind,value});spans.set(key,[lead,i]);
 }
 ws();if(i!==text.length)throw refuse(label,'content after the root element');
 return {version,entries,sha256:sha256(bytes),size:bytes.length,bytes,text,spans};
}
// The Studio version a Features.plain.xml says it was exported from (<Features Version="1.7.29.10940">), or null; a
// lenient look at its head, for messages only (readFeatures decides what is used).
export function featuresVersion(file){
 try{const b=fs.readFileSync(file).subarray(0,4096);const text=b[0]===0xff&&b[1]===0xfe?b.toString('utf16le'):b.toString('utf8');
  return /<Features\b[^>]*\bVersion="([^"]+)"/.exec(text)?.[1]??null;}catch{return null;}
}
// Each use of a recorded file (tests, smoke) checks its bytes against the provenance it was resolved with.
export function verifyFeaturesUse(file,summary){
 if(!file||!summary?.sha256)return;
 let actual=null;try{actual=sha256(fs.readFileSync(file));}catch{}
 if(actual!==summary.sha256)throw new EnvironmentError(`The ODC features ${file} changed after they were recorded (sha256 ${summary.sha256}). Review the features store; nothing was used or changed.`,'store-mismatch',['odc']);
}
export function readFeatures(file){
 let size;try{size=fs.statSync(file).size;}catch(e){throw refuse(file,`it cannot be read (${e.code??e.message})`);}
 if(size>FEATURES_MAX_BYTES)throw refuse(file,`${size} bytes, above the ${FEATURES_MAX_BYTES} byte limit`);
 return parseFeatures(fs.readFileSync(file),file);
}
// The assemblies of the "model" layer the headless kernel exercises; everything else of the Studio (Presenter, View,
// ServerCommunications, Identity...) is the IDE's "ui" layer and stays out of the drift check.
const REQUIRED=['ServiceStudio.Common.dll','ServiceStudio.BuiltInBehaviors.dll','ServiceStudio.Framework.dll','OutSystems.Model.dll'];
function modelLayer(dir){
 const root=fs.readdirSync(dir).filter(n=>/^(ServiceStudio\.BuiltInBehaviors|ServiceStudio\.Framework)\.dll$|^OutSystems\.Model.*\.dll$/i.test(n)).map(n=>path.join(dir,n));
 const plugins=[];const walk=d=>{let list=[];try{list=fs.readdirSync(d,{withFileTypes:true});}catch{return;}for(const e of list){const f=path.join(d,e.name);if(e.isDirectory())walk(f);else if(/^(ServiceStudio\.Plugin\.|OutSystems\.Model\.Plugin\.).*\.dll$/i.test(e.name))plugins.push(f);}};
 walk(path.join(dir,'Plugins'));
 return [...root,...plugins].sort();
}
// What a Studio version knows of its features, from its frozen assemblies: the catalog (name -> key, kind) of
// ServiceStudio.Common.dll, the flags the model layer reads (kernelRelevant) and the GUID literals of OutSystems.Model*
// (its model features). {unknown: why} when an assembly is missing or unreadable: the drift is then not checked.
export function studioCatalog(snapshotDir){
 if(!snapshotDir)return {unknown:'no frozen Studio copy'};
 try{
  for(const name of REQUIRED)if(!fs.existsSync(path.join(snapshotDir,name)))return {unknown:`${name} is not in the frozen Studio copy`};
  const features=featureCatalog(path.join(snapshotDir,'ServiceStudio.Common.dll'));
  const reads=new Set(),modelKeys=new Set(),assemblies=modelLayer(snapshotDir);
  for(const file of assemblies){
   try{for(const n of featureReads(file))reads.add(n);if(/^OutSystems\.Model/i.test(path.basename(file)))for(const g of userStringGuids(file))modelKeys.add(g);}
   catch(e){return {unknown:`${path.relative(snapshotDir,file)}: ${e.message}`};}
  }
  return {features,kernelRelevant:[...reads].sort(),modelKeys,assemblies:assemblies.length};
 }catch(e){return {unknown:`ServiceStudio.Common.dll: ${e.message}`};}
}
// The file against the version: the version's flags the file lacks (they use the Studio's code defaults), the file's keys
// the version no longer has (counted), the keys whose kind differs (filtered out of a carried copy), and the kernel flags
// with their presence. missingKernelRelevant: the kernel flags the copy will not carry (absent or filtered).
export function drift(features,catalog){
 if(!catalog||catalog.unknown)return {unknown:catalog?.unknown??'no catalog',fileKeys:features.entries.size};
 const known=new Set([...catalog.features.values()].map(f=>f.key));
 const newKeys=[],kindConflicts=[];
 for(const [name,{key,kind}] of catalog.features){const e=features.entries.get(key);if(!e)newKeys.push(name);else if(e.kind!==kind)kindConflicts.push({name,file:e.kind,studio:kind});}
 let removedKeys=0;for(const key of features.entries.keys())if(!known.has(key)&&!catalog.modelKeys?.has(key))removedKeys++;
 const conflicting=new Set(kindConflicts.map(c=>c.name));
 const kernelRelevant=catalog.kernelRelevant.map(name=>{const key=catalog.features.get(name)?.key,e=key?features.entries.get(key):null;return {name,inFile:!!e,value:e?e.value:null};});
 return {studioKeys:catalog.features.size,fileKeys:features.entries.size,newKeys:newKeys.sort(),removedKeys,kindConflicts,kernelRelevant,missingKernelRelevant:kernelRelevant.filter(k=>!k.inFile||conflicting.has(k.name)).map(k=>k.name)};
}
// The carried content: the source's bytes exactly, or, when some keys have another kind in the new version, the source
// without those <Feature> elements (UTF-8 without a byte order mark, like the source).
export function carriedContent(features,catalog,kindConflicts=[]){
 if(!kindConflicts.length)return {bytes:features.bytes,filtered:[],sha256:features.sha256};
 const keys=kindConflicts.map(c=>catalog.features.get(c.name).key),cut=keys.map(k=>features.spans.get(k)).sort((a,b)=>b[0]-a[0]);
 let text=features.text;for(const [from,to] of cut)text=text.slice(0,from)+text.slice(to);
 const bytes=Buffer.from(text,'utf8');
 return {bytes,filtered:kindConflicts.map(c=>c.name).sort(),sha256:sha256(bytes)};
}
// A provenance without any feature value (attempt.json, release.json, bundles.json and the texts carry this one).
export function featuresSummary(p){
 if(!p)return null;
 const d=p.drift;
 return {version:p.version,mode:p.mode,sha256:p.sha256,fileVersion:p.fileVersion??null,source:p.source,chain:p.chain??0,recordedAt:p.recordedAt,
  ...(d?{drift:d.unknown?{unknown:d.unknown,fileKeys:d.fileKeys}:{studioKeys:d.studioKeys,fileKeys:d.fileKeys,newKeys:d.newKeys,removedKeys:d.removedKeys,kindConflicts:d.kindConflicts,kernelRelevant:d.kernelRelevant.map(k=>k.name),missingKernelRelevant:d.missingKernelRelevant}}:{}),
  ...(p.filtered?.length?{filtered:p.filtered}:{})};
}
// The private store: featuresRoot/odc-<a.b.c>/Features.plain.xml with features.provenance.json (a journal: MAC-signed
// with the watcher's key in automatic mode, bound to its path) recording how it got there. An exact export is never
// replaced; a carried or defaults-only file is moved to odc-<v>/superseded/<sha8>/ when an exact one arrives for its
// version, and a defaults-only one also when a carry becomes possible. A new folder appears whole (file and provenance
// staged, then one rename), so an interrupted write never leaves a file without provenance.
export function createFeaturesStore({root,legacyRoot=null,automatic=false,defaultsFallback=false,log=()=>{},clock=()=>new Date()}){
 const folder=v=>path.join(root,`odc-${v}`),plainOf=dir=>path.join(dir,'Features.plain.xml'),provOf=dir=>path.join(dir,'features.provenance.json');
 const review=(dir,why)=>new EnvironmentError(`The ODC features store ${dir}: ${why}. Review the features store; nothing was used or changed.`,'store-mismatch',['odc']);
 const recordAt=(file,macPath,v,fields)=>{const p={schema:FEATURES_SCHEMA,version:v,...fields,recordedAt:clock().toISOString()};writeJournal(file,p,{macPath});return p;};
 const record=(dir,v,fields)=>recordAt(provOf(dir),provOf(dir),v,fields);
 const versions=()=>{let names=[];try{names=fs.readdirSync(root);}catch{}return names.map(n=>/^odc-(\d+\.\d+\.\d+)$/.exec(n)?.[1]).filter(Boolean);};
 // What odc-<v> holds, verified (provenance and sha256). A folder without provenance is never trusted in automatic mode;
 // in manual mode a folder of the watcher from before provenance becomes an exact one when its Version is v and it holds
 // features (a defaults-only document never does). null when there is no folder.
 function held(v){
  const dir=folder(v);if(!fs.existsSync(dir))return null;
  const plain=plainOf(dir),prov=provOf(dir);
  if(fs.existsSync(prov)){
   let p;try{p=readJournal(prov,{automatic});}catch(e){throw review(dir,`its provenance does not verify (${e.message})`);}
   if(p?.schema!==FEATURES_SCHEMA||p.version!==v||!MODES.has(p.mode)||!/^[a-f0-9]{64}$/.test(p.sha256??''))throw review(dir,'its provenance is not a features record of this version');
   let bytes;try{bytes=fs.readFileSync(plain);}catch{throw review(dir,'Features.plain.xml is missing');}
   if(sha256(bytes)!==p.sha256)throw review(dir,'Features.plain.xml changed after it was recorded');
   return {dir,path:plain,provenance:p};
  }
  if(automatic)throw new EnvironmentError(`The ODC features store ${dir} has no provenance. Review it, delete odc-${v} by name and seed it again with vigia.ps1 -SeedFeatures <Features.plain.xml>; nothing was used or changed.`,'store-mismatch',['odc']);
  if(!fs.existsSync(plain))throw review(dir,'the folder holds no Features.plain.xml');
  const parsed=readFeatures(plain);
  if(threeOf(parsed.version)!==v)throw review(dir,`Features.plain.xml has no provenance and is for ${parsed.version??'no version'}, not ${v}`);
  if(!parsed.entries.size)throw review(dir,'Features.plain.xml has no provenance and no feature (a defaults-only document is never recorded as exact); delete odc-'+v+' by name and seed it again with vigia.ps1 -SeedFeatures <Features.plain.xml>');
  const p=record(dir,v,{mode:'exact',sha256:parsed.sha256,fileVersion:parsed.version,source:{kind:'legacy'},chain:0});
  log(`features of ODC ${v}: the folder without provenance is recorded as exact ${parsed.version} (sha256 ${parsed.sha256})`);
  return {dir,path:plain,provenance:p};
 }
 // A new odc-<v>, whole: the file and its provenance (signed for its final path) are staged, then one rename puts them in
 // place. A failure before the rename leaves no odc-<v>; the watcher's own staging folders of v are removed.
 function install(v,bytes,fields){
  const dir=folder(v);if(fs.existsSync(dir))throw review(dir,'the folder appeared while the watcher was writing it');
  fs.mkdirSync(root,{recursive:true});
  for(const name of fs.readdirSync(root))if(name.startsWith(`.odc-${v}-partial-`)&&/^\.odc-\d+\.\d+\.\d+-partial-\d+$/.test(name))fs.rmSync(path.join(root,name),{recursive:true,force:true});
  const stage=path.join(root,`.odc-${v}-partial-${process.pid}`);fs.mkdirSync(stage);
  try{
   fs.writeFileSync(plainOf(stage),bytes,{mode:0o600});
   const provenance=recordAt(provOf(stage),provOf(dir),v,fields);
   fs.renameSync(stage,dir);
   return {dir,path:plainOf(dir),provenance};
  }catch(e){fs.rmSync(stage,{recursive:true,force:true});throw e;}
 }
 // A carried or defaults-only file makes way for an exact one: it goes, with its provenance, to superseded/<sha8>/.
 function supersede(current,bytes,fields){
  const {dir,provenance:old}=current,to=path.join(dir,'superseded',old.sha256.slice(0,8));
  if(old.mode==='exact')throw review(dir,'an exact file is never replaced');
  fs.mkdirSync(to,{recursive:true});fs.copyFileSync(plainOf(dir),plainOf(to));
  writeJournal(provOf(to),{...old,supersededAt:clock().toISOString(),supersededBy:fields.sha256});
  const next=plainOf(dir)+'.next';fs.writeFileSync(next,bytes,{mode:0o600});fs.renameSync(next,plainOf(dir));
  log(`features of ODC ${old.version}: the ${old.mode} file (sha256 ${old.sha256}) moved to ${to}`);
  return {dir,path:plainOf(dir),provenance:record(dir,old.version,fields)};
 }
 // An exact file for its own version: new, or over a carried/defaults one; never over an exact one.
 function putExact(parsed,source){
  const v=threeOf(parsed.version),current=held(v),fields={mode:'exact',sha256:parsed.sha256,fileVersion:parsed.version,source,chain:0};
  if(current?.provenance.mode==='exact')return {stored:false,current};
  return {stored:true,current:current?supersede(current,parsed.bytes,fields):install(v,parsed.bytes,fields)};
 }
 // The legacy store (bundleRoot/odc-<v>/Features.plain.xml) when it is this version's: copied into the private store.
 function legacy(v){
  if(!legacyRoot)return null;const file=path.join(legacyRoot,`odc-${v}`,'Features.plain.xml');if(!fs.existsSync(file))return null;
  if(automatic){log(`features: ${file} has no provenance; not used in automatic mode; seed it with vigia.ps1 -SeedFeatures`);return null;}
  const found=featuresVersion(file);
  if(threeOf(found)!==v){log(`features: ${file} is for ${found??'no version'}, not ${v}; not used`);return null;}
  const parsed=readFeatures(file),r=putExact(parsed,{kind:'legacy-store',file});
  if(r.stored)log(`features of ODC ${v} copied into the private store from ${file} (sha256 ${parsed.sha256})`);
  return r.current;
 }
 // An export of the Studio's feature cache (featuresSource): the exact file of the version it says, never of another one.
 function offer(v,file,source){
  let parsed;
  try{parsed=readFeatures(file);}catch(e){throw new EnvironmentError(`The ODC Studio feature cache ${source.file} exported to an invalid Features document (${e.why??e.message}). Open ODC Studio ${v} once, signed in, so it rewrites its feature cache, or remove featuresSource; nothing was stored.`,'features-invalid',['odc']);}
  if(!parsed.version){log(`features: the export of ${source.file} names no Version; not stored`);return null;}
  const x=threeOf(parsed.version);
  if(x!==v&&fs.existsSync(folder(x))){log(`features: the export of ${source.file} is ${parsed.version}; odc-${x} exists, so it is not stored`);return null;}
  const r=putExact(parsed,source);
  if(r.stored)log(`features of ODC ${x} stored as exact ${parsed.version} from the export of ${source.file} (${parsed.entries.size} features, sha256 ${parsed.sha256})${x!==v?`; not used for ${v}`:''}`);
  return x===v?r.current:null;
 }
 // The nearest exact file of another version (the newest lower one, else the oldest higher one), never a carried one.
 function source(v){
  const all=versions().filter(x=>x!==v);
  const order=[...all.filter(x=>compareVersion(x,v)<0).sort((a,b)=>compareVersion(b,a)).map(x=>[x,'forward']),...all.filter(x=>compareVersion(x,v)>0).sort(compareVersion).map(x=>[x,'backward'])];
  for(const [x,direction] of order){const h=held(x);if(h.provenance.mode==='exact')return {...h,direction,between:all.filter(y=>direction==='forward'?compareVersion(y,x)>0&&compareVersion(y,v)<0:compareVersion(y,v)>0&&compareVersion(y,x)<0).length};}
  return null;
 }
 function carry(v,{snapshot,replace}={}){
  const from=source(v);if(!from)return null;
  const parsed=readFeatures(from.path);
  if(parsed.sha256!==from.provenance.sha256)throw review(from.dir,'Features.plain.xml changed while it was read');
  const catalog=studioCatalog(snapshot),d=drift(parsed,catalog);
  const content=carriedContent(parsed,catalog,d.unknown?[]:d.kindConflicts);
  const fields={mode:'carried',sha256:content.sha256,fileVersion:parsed.version,source:{kind:'carry',from:{version:from.provenance.version,fullVersion:parsed.version,sha256:parsed.sha256,kind:from.provenance.source?.kind??null,recordedAt:from.provenance.recordedAt},direction:from.direction},chain:1+from.between,drift:d,...(content.filtered.length?{filtered:content.filtered}:{})};
  const done=replace?supersede(replace,content.bytes,fields):install(v,content.bytes,fields);
  log(`features of ODC ${v} carried from ${parsed.version} (exact, sha256 ${parsed.sha256.slice(0,12)}, chain ${fields.chain}): ${d.unknown?`drift not checked (${d.unknown})`:`${d.studioKeys} flags in the Studio, ${d.newKeys.length} new use code defaults, ${d.removedKeys} unknown keys kept, ${d.kindConflicts.length} kind conflicts filtered${content.filtered.length?' ('+content.filtered.join(', ')+')':''}; kernel flags missing: ${d.missingKernelRelevant.join(', ')||'none'}`}`);
  return done;
 }
 function defaults(v,fullVersion,{snapshot}={}){
  if(defaultsFallback!==true)throw new EnvironmentError(`No exact ODC features exist to carry; seed one once with vigia.ps1 -SeedFeatures <Features.plain.xml>.`,'features-unavailable',['odc']);
  const label=FULL.test(fullVersion??'')&&threeOf(fullVersion)===v?fullVersion:`${v}.0`;
  const bytes=Buffer.from(`<Features Version="${label}"/>`),parsed=parseFeatures(bytes),d=drift(parsed,studioCatalog(snapshot));
  const done=install(v,bytes,{mode:'defaults',sha256:parsed.sha256,fileVersion:label,source:{kind:'defaults'},chain:0,drift:d});
  log(`features of ODC ${v}: no exact features exist; the Studio's code defaults only (featuresDefaultsFallback)`);
  return done;
 }
 // The owner's one-time seed: an exact export of a known version, stored once (over a carried or defaults-only file at
 // most). Returns only its version, count and sha256; the same bytes seeded again are already there (already: true).
 function seed(file){
  const parsed=readFeatures(file);
  if(!parsed.version)throw new EnvironmentError(`${file} has no <Features Version="...">: a seed must name the ODC Studio version it was exported from. Nothing was stored.`,'features-invalid',['odc']);
  const r=putExact(parsed,{kind:'seed',file:path.basename(file),sha256:parsed.sha256});
  if(!r.stored&&r.current.provenance.sha256===parsed.sha256)return {version:parsed.version,count:parsed.entries.size,sha256:parsed.sha256,already:true};
  if(!r.stored)throw Object.assign(Error(`ODC ${threeOf(parsed.version)} already has exact features (${r.current.provenance.fileVersion}, sha256 ${r.current.provenance.sha256}); nothing was changed.`),{code:'features-exist'});
  log(`features of ODC ${threeOf(parsed.version)} seeded: ${parsed.version}, ${parsed.entries.size} features, sha256 ${parsed.sha256}`);
  return {version:parsed.version,count:parsed.entries.size,sha256:parsed.sha256};
 }
 return {held,legacy,offer,carry,defaults,seed};
}
