// Review of the original bundled client-runtime-widgets initialization region.
// Keep vendor bytes in private published assets, never in the product package.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>{throw new Error('debug_odc_embedded_widgets_'+code);};
const coreHash='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d';
const uiHash='c9565f2d4c2afd26a125afc65f1174e43703d235d4e76035da3fff6185299bca';
const regionHash='ff796d1a1f8c2c3797e5b2cb151605d1d98dba545d8ff6b2641938b1acbab5bb';
export function findOdcEmbeddedWidgetRegions(source){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=new Map(),names=[];
 for(const row of ast.body){
  if(row.type==='ImportDeclaration')for(const s of row.specifiers){
   names.push(s.local.name);
   if(s.type==='ImportSpecifier')imports.set(s.local.name,{file:row.source.value,export:s.imported.name});
  }
  if(row.type==='VariableDeclaration')for(const d of row.declarations){
   if(d.id.type!=='Identifier')fail('binding_pattern');names.push(d.id.name);
  }
  if(['FunctionDeclaration','ClassDeclaration'].includes(row.type))names.push(row.id.name);
 }
 if(['Object','Symbol','String','RegExp'].some(n=>names.includes(n)))fail('builtin_shadowed');
 const markers=ast.body.filter(row=>{
  const call=row.expression;
  return row.type==='ExpressionStatement'&&call?.type==='CallExpression'&&call.callee.type==='MemberExpression'&&
   !call.callee.computed&&call.callee.property.name==='registerPackage'&&call.arguments[0]?.value==='client-runtime-widgets';
 });
 if(markers.length!==1)fail('package_marker');
 const marker=markers[0],call=marker.expression;
 if(call.arguments.length!==2||call.callee.object.type!=='Identifier'||call.arguments[1].type!=='Identifier')fail('package_marker');
 const versions=ast.body.flatMap(row=>row.type==='VariableDeclaration'?row.declarations:[])
  .filter(d=>d.id.name===call.arguments[1].name);
 if(versions.length!==1||versions[0].init?.type!=='Literal'||typeof versions[0].init.value!=='string')fail('package_version');
 const candidates=ast.body.filter(row=>{
  if(row.type!=='VariableDeclaration'||row.start>=marker.start)return false;
  const init=row.declarations[0]?.init;
  return init?.type==='CallExpression'&&init.callee.type==='Identifier'&&imports.get(init.callee.name)?.export==='c'&&
   init.arguments.length===1&&init.arguments[0].type==='CallExpression'&&init.arguments[0].arguments.length===0&&
   init.arguments[0].callee.type==='Identifier'&&imports.get(init.arguments[0].callee.name)?.export==='a';
 }).map(start=>({start:start.start,end:marker.end,regionSha256:hash(source.slice(start.start,marker.end)),
  version:versions[0].init.value,versionInsideRegion:versions[0].start>=start.start&&versions[0].end<=marker.end}));
 return {candidates,imports:Object.fromEntries(imports),packageAlias:call.callee.object.name};
}
export function createOdcEmbeddedWidgetsInspector(files){
 const cache=new Map();
 return view=>{
  if(cache.has(view.chunk))return cache.get(view.chunk);
  const source=files[view.chunk];if(typeof source!=='string')fail('source');
  const discovered=findOdcEmbeddedWidgetRegions(source),matches=discovered.candidates.filter(c=>c.regionSha256===regionHash);
  if(matches.length!==1||matches[0].version!=='6.28.0'||!matches[0].versionInsideRegion||discovered.packageAlias!=='Tt')fail('runtime_unreviewed');
  // The region includes local helper bodies and widget callbacks. Its free SDK
  // aliases must still resolve to the reviewed exports, not lookalike imports.
  const groups=[{sha256:coreHash,aliases:{Be:'I',fe:'M',a:'a',Fe:'c',Tt:'f',Nt:'h',It:'i',Z:'j',kt:'l',ie:'n',Lt:'q',Qe:'s',A:'w',Ct:'x',Ve:'y',Ae:'z'}},
   {sha256:uiHash,aliases:{Ye:'a',Bn:'b',Wt:'c',Ft:'d',b:'e',Vt:'f',ve:'h',Mt:'i',tt:'j',nt:'k',jt:'l',z:'m',$e:'n',Ht:'o',Gt:'p',ye:'q',me:'r',Qt:'s'}}];
  const dependencies=[];
  for(const group of groups)for(const [local,exported] of Object.entries(group.aliases)){
   const binding=discovered.imports[local],file=binding?.file?.slice(2);
   if(!/^\.\/_oschunk-[A-Za-z0-9]+\.js$/.test(binding?.file??'')||binding.export!==exported||
    typeof files[file]!=='string'||hash(files[file])!==group.sha256)fail('sdk_binding');
   dependencies.push({local,...binding,sha256:group.sha256});
  }
  const result={schema:'ssam-odc-embedded-widgets/1',regionInitializationQualified:true,
   package:'client-runtime-widgets',...matches[0],sourceSha256:hash(source),dependencies,
   effects:['native-react-component-registration','local-feature-probe','local-enum-and-helper-exports','native-package-version-map'],
   renderExecuted:false,eventsExecuted:false,viewInitializationQualified:false,executionAuthorized:false};
  cache.set(view.chunk,result);return result;
 };
}
