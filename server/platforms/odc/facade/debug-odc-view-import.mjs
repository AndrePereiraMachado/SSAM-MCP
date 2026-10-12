// Source-only coverage of immediate generated view initialization. Native ESM
// remains the only evaluator. Deferred method/render bodies are not executed.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {createOdcEmbeddedWidgetsInspector} from './debug-odc-embedded-widgets.mjs';
import {createOdcViewComponentInspector} from './debug-odc-view-component.mjs';
import {createOdcViewFactoryInspector} from './debug-odc-view-factory-construction.mjs';
import {createOdcRecordInitializationInspector} from './debug-odc-record-initialization.mjs';
import {createOdcModelConstructionInspector} from './debug-odc-model-construction.mjs';
import {qualifyOdcSdkInitializationPrimitives} from './debug-odc-sdk-initialization-primitives.mjs';
import {qualifyOdcNativeDataTypes} from './debug-odc-native-data-types.mjs';
import {qualifyOdcDebuggerMetadata} from './debug-odc-debugger-metadata.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>{throw new Error('debug_odc_view_import_'+code);};
const id=n=>n?.type==='Identifier'?n.name:null;
const member=n=>n?.type==='MemberExpression'&&!n.computed&&id(n.object)?{object:n.object.name,name:n.property.name}:null;
// This exported syntax checker is not execution authority. The producer below
// recomputes every native qualification and pin from original source bytes.
export function inspectOdcViewImportSyntax(source,contract){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),root=new Map(),effects=[];
 const region=contract.region;
 if(!region||hash(source.slice(region.start,region.end))!==region.regionSha256||
  !ast.body.some(n=>n.start===region.start)||!ast.body.some(n=>n.end===region.end))fail('region');
 const inside=n=>n.start>=region.start&&n.end<=region.end;
 const vendorNames=new Set(ast.body.filter(inside).flatMap(n=>n.type==='VariableDeclaration'?n.declarations.map(d=>id(d.id)):
  ['FunctionDeclaration','ClassDeclaration'].includes(n.type)?[id(n.id)]:[]));
 for(const n of ast.body.filter(n=>!inside(n)))for(const name of n.type==='VariableDeclaration'?n.declarations.map(d=>id(d.id)):
  ['FunctionDeclaration','ClassDeclaration'].includes(n.type)?[id(n.id)]:[])
  if(vendorNames.has(name))fail('vendor_binding_collision');
 function declare(rows,scope){
  for(const row of rows)if(!inside(row)){
   if(row.type==='VariableDeclaration')for(const d of row.declarations){
    if(!id(d.id))fail('declaration');
    if(!scope.has(d.id.name)||row.kind!=='var')scope.set(d.id.name,{value:null});
   }
  }
 }
 declare(ast.body,root);
 const read=(scope,name)=>{const value=scope.get(name)?.value;if(!value)fail('binding_unresolved');return value;};
 for(const row of ast.body)if(row.type==='ImportDeclaration'){
  if(!/^\.\/_oschunk-[A-Za-z0-9]+\.js$/.test(row.source.value))fail('import');
  for(const s of row.specifiers){
   if(s.type!=='ImportSpecifier'||root.has(s.local.name))fail('import');
   root.set(s.local.name,{value:{kind:'import',file:row.source.value.slice(2),export:s.imported.name}});
  }
 }
 const native=(tag,exported)=>tag?.kind==='import'&&tag.file===contract.coreFile&&tag.export===exported;
 const nativeUi=(tag,exported)=>tag?.kind==='import'&&tag.file===contract.uiFile&&tag.export===exported;
 const noted=(n,kind)=>effects.push({start:n.start,end:n.end,kind,sourceSha256:hash(source.slice(n.start,n.end))});
 function expression(n,scope){
  if(!n)fail('expression');
  if(n.type==='Literal')return {kind:'data'};
  if(n.type==='Identifier')return read(scope,n.name);
  if(['FunctionExpression','ArrowFunctionExpression'].includes(n.type))return {kind:'callback',sha256:hash(source.slice(n.start,n.end))};
  if(n.type==='UnaryExpression'&&['void','!'].includes(n.operator)&&n.argument.type==='Literal')return {kind:'data'};
  if(n.type==='ArrayExpression'){n.elements.forEach(e=>expression(e,scope));return {kind:'array'};}
  if(n.type==='ObjectExpression'){
   const keys=new Set();for(const p of n.properties){
    const key=id(p.key)??p.key?.value;
    if(p.type!=='Property'||p.computed||p.kind!=='init'||p.method||typeof key!=='string'||
     ['__proto__','hasOwnProperty'].includes(key)||keys.has(key))fail('metadata');
    keys.add(key);expression(p.value,scope);
   }return {kind:'object'};
  }
  if(n.type==='ClassExpression'){
   const parent=member(n.superClass),namespace=parent&&read(scope,parent.object);
   if(!parent||!({BaseViewController:'I',GenericRecord:'w',BaseViewModel:'M',BaseWidgetRecordMap:'M'}[parent.name])||
    !native(namespace,{BaseViewController:'I',GenericRecord:'w',BaseViewModel:'M',BaseWidgetRecordMap:'M'}[parent.name]))fail('class_base');
   if(n.body.body.some(m=>m.type!=='MethodDefinition'||m.computed||
    ['registerVariableGroupType','_hasValidationWidgetsValue'].includes(m.key.name)))fail('class_static_effect');
   return {kind:'class',base:parent.name,sha256:hash(source.slice(n.start,n.end))};
  }
  if(n.type==='MemberExpression'){
   const group=member(n.object);
   if(n.computed||!group||group.name!=='DataTypes'||!native(read(scope,group.object),'w')||
    !contract.dataTypes.includes(n.property.name))fail('property_read');
   return {kind:'data'};
  }
  if(n.type==='SequenceExpression'){let value;for(const e of n.expressions)value=expression(e,scope);return value;}
  if(n.type==='AssignmentExpression'&&n.operator==='='){
   if(id(n.left)){
    const binding=scope.get(n.left.name);if(!binding||binding.value?.kind==='import')fail('assignment');
    binding.value=expression(n.right,scope);return binding.value;
   }
   const field=member(n.left),target=field&&read(scope,field.object);
   if(field?.name!=='_hasValidationWidgetsValue'||target?.kind!=='class'||target.base!=='BaseViewModel'||
    !contract.modelClasses.includes(target.sha256)||n.right.type!=='UnaryExpression'||n.right.operator!=='void'||n.right.argument.value!==0)fail('assignment');
   noted(n,'native-model-cache-marker');return {kind:'data'};
  }
  if(n.type==='NewExpression'){
   const callee=member(n.callee),namespace=callee&&read(scope,callee.object);
   if(!callee||!['ModelFactory','ControllerFactory'].includes(callee.name)||
    !native(namespace,callee.name==='ModelFactory'?'M':'I')||!contract.factoryOffsets.includes(n.start))fail('factory');
   n.arguments.forEach(a=>expression(a,scope));noted(n,'native-factory-construction');return {kind:'factory'};
  }
  if(n.type==='CallExpression'){
   if(id(n.callee)){
    const target=read(scope,n.callee.name);
    if(native(target,'a')&&n.arguments.length===2&&n.arguments[1].type==='Literal'&&typeof n.arguments[1].value==='string'){
     const value=expression(n.arguments[0],scope);if(!['callback','class'].includes(value.kind))fail('naming');
     noted(n,'native-function-naming');return value;
    }
    if(native(target,'c')&&n.arguments.length===1){
     const call=n.arguments[0];
     if(call.type!=='CallExpression'||call.arguments.length||!id(call.callee)||!nativeUi(read(scope,call.callee.name),'a'))fail('react_import');
     noted(n,'native-react-namespace');return {kind:'react'};
    }
    if(target.kind==='callback'&&!n.arguments.length&&contract.componentFunctions.includes(target.sha256)){
     noted(n,'native-view-component-registration');return {kind:'component'};
    }
    fail('call');
   }
   const callee=member(n.callee);if(!callee)fail('call');
   if(callee.object==='OutSystemsDebugger'&&!scope.has(callee.object)&&callee.name==='registerMetaInfo'&&n.arguments.length===1){
    if(expression(n.arguments[0],scope).kind!=='object')fail('metadata');
    noted(n,'native-debugger-metadata-registration');return {kind:'data'};
   }
   const target=read(scope,callee.object);
   if(target.kind==='class'&&target.base==='BaseViewController'&&callee.name==='registerVariableGroupType'&&
    n.arguments.length===2&&n.arguments[0].type==='Literal'&&typeof n.arguments[0].value==='string'&&
    expression(n.arguments[1],scope).kind==='array'){
    noted(n,'native-variable-group-registration');return {kind:'data'};
   }
   if(target.kind==='class'&&target.base==='GenericRecord'&&callee.name==='init'&&!n.arguments.length&&
    contract.recordClasses.includes(target.sha256)&&contract.recordInitOffsets.includes(n.start)){
    noted(n,'native-record-initialization');return {kind:'data'};
   }
   fail('call');
  }
  fail('expression');
 }
 function statement(n,scope){
  if(inside(n))return;
  if(n.type==='ImportDeclaration'||n.type==='EmptyStatement')return;
  if(n.type==='ExportNamedDeclaration'&&!n.source&&!n.declaration){
   n.specifiers.forEach(s=>read(scope,s.local.name));return;
  }
  if(n.type==='VariableDeclaration'){
   if(scope!==root&&n.kind==='var')fail('block_var');
   for(const d of n.declarations)if(d.init)scope.get(d.id.name).value=expression(d.init,scope);return;
  }
  if(n.type==='ExpressionStatement'){expression(n.expression,scope);return;}
  if(n.type==='BlockStatement'){
   const local=new Map(scope);declare(n.body,local);n.body.forEach(row=>statement(row,local));return;
  }
  fail('statement');
 }
 ast.body.forEach(n=>statement(n,root));
 return {syntaxCovered:true,effects,executionAuthorized:false};
}
export function createOdcViewImportInspector(files){
 const widgets=createOdcEmbeddedWidgetsInspector(files),components=createOdcViewComponentInspector(files),
  factories=createOdcViewFactoryInspector(files),records=createOdcRecordInitializationInspector(files),models=createOdcModelConstructionInspector(files);
 return views=>{
  const chunk=views?.[0]?.chunk,source=files[chunk];
  if(!views?.length||views.some(v=>v.chunk!==chunk)||typeof source!=='string')fail('views');
  const region=widgets(views[0]),cs=views.map(components),rs=views.map(records),ms=views.map(models);
  views.forEach(factories);
  const coreFile=region.dependencies.find(d=>d.local==='a').file.slice(2),uiFile=cs[0].nativeWrapper.file;
  const primitives=qualifyOdcSdkInitializationPrimitives(files,{file:coreFile,helperExport:'a',controllerExport:'I'});
  const types=qualifyOdcNativeDataTypes(files,{file:coreFile,exported:'w'}),metadata=qualifyOdcDebuggerMetadata(files);
  if(!primitives.naming.qualified||!primitives.variableGroupRegistration.qualified||!types.qualified||!metadata.qualified)fail('native_primitives');
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),decls=ast.body.flatMap(n=>n.type==='VariableDeclaration'?n.declarations:[]);
  const factoryOffsets=views.flatMap(v=>[v.modelFactory,v.controllerFactory]).map(name=>{
   const rows=decls.filter(d=>id(d.id)===name);if(rows.length!==1||rows[0].init?.type!=='NewExpression')fail('factory');return rows[0].init.start;
  });
  const syntax=inspectOdcViewImportSyntax(source,{region,coreFile,uiFile,dataTypes:Object.keys(types.types),factoryOffsets,
   recordClasses:rs.map(r=>r.record.classSha256),recordInitOffsets:rs.map(r=>r.record.initOffset),
   modelClasses:ms.map(m=>m.declaration.modelClassSha256),componentFunctions:cs.map(c=>c.factorySha256)});
  const requiredAlreadyLoadedModules=[...new Set(ast.body.filter(n=>n.type==='ImportDeclaration').map(n=>n.source.value.slice(2)))];
  if(!requiredAlreadyLoadedModules.includes(metadata.file)||requiredAlreadyLoadedModules.some(file=>typeof files[file]!=='string'))fail('dependency');
  return {schema:'ssam-odc-view-import/1',viewImportQualified:true,sourceSha256:hash(source),chunk,
   requiredAlreadyLoadedModules,sourceHashes:Object.fromEntries([chunk,...requiredAlreadyLoadedModules].map(file=>[file,hash(files[file])])),
   effects:syntax.effects,embeddedWidgets:region.regionSha256,viewKeys:views.map(v=>v.key),
   renderExecuted:false,lifecycleExecuted:false,permissionsChecked:false,applicationStartupQualified:false,executionAuthorized:false};
 };
}
