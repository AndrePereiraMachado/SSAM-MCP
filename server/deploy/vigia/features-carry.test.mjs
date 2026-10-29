// The ODC features carried to a version without its own export: the strict parse, the drift on the version's assemblies,
// and (read-only, skipped without them) the installed ODC Studio's catalog and a real exact file. No Studio run, no
// network, no dotnet. Feature values are never printed: names, counts and sha256 only.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createHash} from 'node:crypto';
// Loaded per test, so each test reports on its own against a tree without the module.
const load=()=>import('./features-carry.mjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key=i=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'vigia-features-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
const STUDIO='C:/Program Files/OutSystems/ODC Studio/ODC Studio';
const installed=fs.existsSync(path.join(STUDIO,'ServiceStudio.Common.dll'));
const installedVersion=(()=>{try{return fs.readFileSync(path.join(STUDIO,'Version.txt'),'utf8').trim().split(/\s/)[0];}catch{return '';}})();
const KERNEL_1730=['AI_NL2Agg','FixDragAndDropMultipleElements','FixIconConversionIssues','MultiPortfolioOrganizations','UseNewSystemTrackedClipboard','WrapEditCommandsInDelayedVerySlowOperations'];
const F1728='C:/t/comb/ensaio2/rollback-a857a1e/Features.plain.xml',SHA1728='3840de41e8120eb076d56b85182ba9201fc06d48c47714940e23b67c6aadf9ed';
const exact1728=(()=>{try{return sha(fs.readFileSync(F1728))===SHA1728;}catch{return false;}})();
test('invalid features are refused before use',async t=>{
 const {readFeatures,FEATURES_MAX_BYTES}=await load();
 const dir=tmp(t),K=key(1),K2=key(2);
 const doc=body=>`<?xml version="1.0" encoding="utf-16"?>\r\n<Features Version="1.7.31.20000">\r\n${body}\r\n</Features>`;
 const good=doc(`  <Feature key="${K}" kind="Boolean">True</Feature>\r\n  <Feature key="${K2}" kind="String">UseCodeDefault</Feature>\r\n  <Feature key="${key(3)}" kind="Integer">-42</Feature>`);
 // Accepted: UTF-8 (the export's bytes), UTF-8 with BOM and UTF-16LE with BOM; the entries by key, the sha256 of the bytes.
 for(const bytes of [Buffer.from(good),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(good)]),Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(good,'utf16le')])]){
  const file=path.join(dir,'ok.xml');fs.writeFileSync(file,bytes);const r=readFeatures(file);
  assert.equal(r.version,'1.7.31.20000');assert.equal(r.entries.size,3);assert.equal(r.entries.get(K).kind,'Boolean');assert.equal(r.entries.get(key(3)).kind,'Integer');assert.equal(r.sha256,sha(bytes));
 }
 const empty=path.join(dir,'empty.xml');fs.writeFileSync(empty,'<Features />');assert.equal(readFeatures(empty).entries.size,0);assert.equal(readFeatures(empty).version,null);
 const cases={
  doctype:`<?xml version="1.0"?><!DOCTYPE Features [<!ELEMENT Features ANY>]><Features Version="1.7.31.1"/>`,
  entity:good.replace('UseCodeDefault','<!ENTITY x "y">'),
  'wrong root':good.replaceAll('Features','FeatureToggles'),
  'key not a GUID':good.replace(K,'not-a-guid'),
  'unknown kind':good.replace('kind="String"','kind="Double"'),
  'invalid Boolean':good.replace('>True<','>yes<'),
  'malformed Version':good.replace('1.7.31.20000','1.7.31'),
  'invalid Integer':good.replace('>-42<','>1.5<'),
  'duplicate key':good.replace(K2,K.toUpperCase()),
  'another child':doc('<Other/>'),
  'another attribute':good.replace('kind="Boolean"','kind="Boolean" extra="1"'),
  'unknown entity':good.replace('UseCodeDefault','&custom;'),
  'text in the root':doc('loose text'),
  'unclosed root':good.replace('</Features>',''),
 };
 for(const [name,text] of Object.entries(cases)){
  const file=path.join(dir,name.replaceAll(' ','-')+'.xml');fs.writeFileSync(file,text);
  assert.throws(()=>readFeatures(file),e=>e.code==='features-invalid'&&e.environmental&&e.lanes[0]==='odc'&&/refused before use/.test(e.message),name);
 }
 const big=path.join(dir,'big.xml');fs.writeFileSync(big,doc(' '.repeat(FEATURES_MAX_BYTES)));
 assert.throws(()=>readFeatures(big),e=>e.code==='features-invalid'&&/byte limit/.test(e.message),'above 1 MiB');
});
test('drift names new keys, kind conflicts and missing kernel flags; conflicts are filtered out of the carried copy',async()=>{
 const {parseFeatures,drift,carriedContent,featuresSummary}=await load();
 const text='<?xml version="1.0" encoding="utf-16"?>\r\n<Features Version="1.7.30.10980">\r\n'+[
  `<Feature key="${key(1)}" kind="Boolean">True</Feature>`,
  `<Feature key="${key(2)}" kind="String">On</Feature>`,
  `<Feature key="${key(3)}" kind="Integer">5</Feature>`,
  `<Feature key="${key(8)}" kind="String">UseCodeDefault</Feature>`,
  `<Feature key="${key(9)}" kind="Boolean">False</Feature>`,
 ].map(x=>'  '+x).join('\r\n')+'\r\n</Features>';
 // The version's catalog, injected: ChangedKind is a Boolean now, NewFlag and NewKernelFlag are new, key 8 is a model
 // feature, key 9 is no longer known.
 const catalog={features:new Map([['ChangedKind',{key:key(2),kind:'Boolean'}],['KeptFlag',{key:key(1),kind:'Boolean'}],['NewFlag',{key:key(4),kind:'Boolean'}],['NewKernelFlag',{key:key(5),kind:'String'}],['OtherFlag',{key:key(3),kind:'Integer'}]]),kernelRelevant:['ChangedKind','KeptFlag','NewKernelFlag'],modelKeys:new Set([key(8)])};
 const file=parseFeatures(Buffer.from(text)),d=drift(file,catalog);
 assert.deepEqual([d.studioKeys,d.fileKeys,d.removedKeys],[5,5,1]);
 assert.deepEqual(d.newKeys,['NewFlag','NewKernelFlag']);
 assert.deepEqual(d.kindConflicts,[{name:'ChangedKind',file:'String',studio:'Boolean'}]);
 assert.deepEqual(d.kernelRelevant.map(k=>[k.name,k.inFile]),[['ChangedKind',true],['KeptFlag',true],['NewKernelFlag',false]]);
 assert.deepEqual(d.missingKernelRelevant,['ChangedKind','NewKernelFlag'],'absent, or left out for its kind');
 const carried=carriedContent(file,catalog,d.kindConflicts);
 assert.deepEqual(carried.filtered,['ChangedKind']);assert.equal(carried.sha256,sha(carried.bytes));
 const back=parseFeatures(carried.bytes);assert.equal(back.version,'1.7.30.10980');assert.equal(back.entries.size,4);assert.equal(back.entries.has(key(2)),false);
 assert.equal(back.text,text.replace(`\r\n  <Feature key="${key(2)}" kind="String">On</Feature>`,''),'only the conflicting element goes');
 // UTF-16LE with its BOM stays UTF-16LE with its BOM; without a conflict the copy is the source, byte for byte.
 const wide=parseFeatures(Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(text,'utf16le')])),wideCopy=carriedContent(wide,catalog,drift(wide,catalog).kindConflicts);
 assert.deepEqual([...wideCopy.bytes.subarray(0,2)],[0xff,0xfe]);assert.equal(parseFeatures(wideCopy.bytes).entries.size,4);
 const same=carriedContent(file,catalog,[]);assert.ok(same.bytes.equals(Buffer.from(text)));assert.equal(same.sha256,file.sha256);assert.deepEqual(same.filtered,[]);
 // A catalog that could not be read leaves the drift unknown (it never blocks).
 assert.deepEqual(drift(file,{unknown:'ServiceStudio.Common.dll is not in the frozen Studio copy'}),{unknown:'ServiceStudio.Common.dll is not in the frozen Studio copy',fileKeys:5});
 // What leaves the private store names flags and counts, never a value.
 const summary=JSON.stringify(featuresSummary({schema:'ssam-odc-features/1',version:'1.7.31',mode:'carried',sha256:carried.sha256,drift:d,filtered:carried.filtered}));
 assert.match(summary,/NewKernelFlag/);assert.match(summary,/"filtered":\["ChangedKind"\]/);assert.doesNotMatch(summary,/"value"|True|False|UseCodeDefault|"On"/);
});
test('the installed ODC Studio\'s feature catalog and kernel reads are read from its metadata',{skip:!installed&&'no ODC Studio installed'},async t=>{
 const {studioCatalog}=await load();
 const c=studioCatalog(STUDIO);assert.equal(c.unknown,undefined,c.unknown);
 assert.ok(c.features.size>=100,`${c.features.size} features`);
 const keys=new Set();for(const [name,f] of c.features){assert.match(f.key,GUID,name);assert.ok(['Boolean','Integer','String'].includes(f.kind),name);keys.add(f.key);}
 assert.equal(keys.size,c.features.size,'one key per feature');
 assert.ok(c.kernelRelevant.length>0);for(const name of c.kernelRelevant)assert.ok(c.features.has(name),`${name} is in the catalog`);
 const kinds={};for(const f of c.features.values())kinds[f.kind]=(kinds[f.kind]??0)+1;
 t.diagnostic(`ODC Studio ${installedVersion}: ${c.features.size} features ${JSON.stringify(kinds)}, ${c.assemblies} model-layer assemblies, kernel flags ${c.kernelRelevant.join(', ')}`);
 if(installedVersion.startsWith('1.7.30.10980')){
  assert.equal(c.features.size,316);assert.deepEqual(kinds,{Boolean:270,Integer:8,String:38});
  assert.deepEqual(c.kernelRelevant,KERNEL_1730);
 }
});
test('carrying 1.7.28 into the installed 1.7.30 reports FixIconConversionIssues as a missing kernel flag',{skip:(!installed||!exact1728||!installedVersion.startsWith('1.7.30.'))&&'needs the installed ODC Studio 1.7.30 and the exact 1.7.28 export'},async t=>{
 const {readFeatures,studioCatalog,drift,carriedContent}=await load();
 const file=readFeatures(F1728);assert.equal(file.sha256,SHA1728);assert.equal(file.version,'1.7.28.10850');
 const catalog=studioCatalog(STUDIO),d=drift(file,catalog);
 assert.ok(d.newKeys.includes('FixIconConversionIssues'));assert.deepEqual(d.kindConflicts,[]);
 assert.deepEqual(d.missingKernelRelevant,['FixIconConversionIssues']);
 assert.ok(carriedContent(file,catalog,d.kindConflicts).bytes.equals(fs.readFileSync(F1728)),'carried byte for byte');
 t.diagnostic(`1.7.28.10850 -> ${installedVersion}: ${d.fileKeys} keys in the file, ${d.newKeys.length} new flags, ${d.removedKeys} unknown keys, kernel flags missing: ${d.missingKernelRelevant.join(', ')}`);
});
