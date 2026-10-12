// Check generated controller initialization syntax without evaluating it.
// Native SDK dependencies are retained separately; this cannot authorize an
// import until their behavior has also been qualified.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {inspectOdcApplicationController} from './debug-odc-application-controller.mjs';
import {qualifyOdcSdkInitializationPrimitives} from './debug-odc-sdk-initialization-primitives.mjs';
import {qualifyOdcNativeDataTypes} from './debug-odc-native-data-types.mjs';
import {qualifyOdcDebuggerMetadata} from './debug-odc-debugger-metadata.mjs';
import {qualifyOdcBaseControllerConstruction} from './debug-odc-base-controller-construction.mjs';
import {qualifyOdcClientVariableResolution} from './debug-odc-client-variable-resolution.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>{throw new Error('debug_odc_controller_initialization_'+code);};
const id=n=>n?.type==='Identifier'?n.name:null;
const member=n=>n?.type==='MemberExpression'&&!n.computed&&id(n.object)?id(n.object)+'.'+n.property.name:null;
export function inspectOdcControllerInitialization(files,importer,moduleName,{baseMember='BaseModuleController',applicationImporter}={}){
 if(typeof moduleName!=='string'||!moduleName)fail('module');
 let applicationInitialization;
 if(baseMember==='BaseController'){
  if(!applicationImporter)fail('application_importer');
  applicationInitialization=inspectOdcControllerInitialization(files,applicationImporter,moduleName);
  if(!applicationInitialization.initializationQualified)fail('application_initialization');
 }
 const controller=inspectOdcApplicationController(files,importer,{baseMember}),source=files[controller.controllerChunk];
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=new Map(),declarations=new Map(),dependencies=[];
 for(const row of ast.body){
  if(row.type==='ImportDeclaration')for(const spec of row.specifiers){
   if(spec.type!=='ImportSpecifier')fail('import');
   imports.set(spec.local.name,{file:row.source.value,export:spec.imported.name});
  }
  if(row.type==='VariableDeclaration')for(const d of row.declarations){
   if(!id(d.id)||declarations.has(d.id.name)||imports.has(d.id.name))fail('declaration');declarations.set(d.id.name,d.init);
  }
  if(['ClassDeclaration','FunctionDeclaration'].includes(row.type)){
   if(declarations.has(row.id.name)||imports.has(row.id.name))fail('declaration');declarations.set(row.id.name,row);
  }
 }
 const sdkFile='./'+controller.baseImport.file;
 let debuggerMetadata;
 try{debuggerMetadata=qualifyOdcDebuggerMetadata(files);}
 catch(error){debuggerMetadata={qualified:false,error:/^debug_odc_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_debugger_metadata_unresolved'};}
 const applicationDependency=applicationInitialization?.controller.controllerChunk;
 if(applicationInitialization&&applicationInitialization.requiredAlreadyLoadedSdk!==controller.baseImport.file)fail('application_sdk_mismatch');
 if(ast.body.some(row=>row.type==='ImportDeclaration'&&row.source.value!==sdkFile&&row.source.value!=='./'+applicationDependency))fail('additional_import');
 // The wrapper path may only forward bindings. An unused import or top-level
 // expression there would also execute during loading and must not be skipped.
 for(const [file,expectedHash] of Object.entries(controller.sourceHashes)){
  if(file===controller.controllerChunk)continue;
  if(typeof files[file]!=='string'||sha(files[file])!==expectedHash)fail('wrapper_source');
  const wrapper=parse(files[file],{ecmaVersion:'latest',sourceType:'module'}),locals=new Set();
  const allowedImport=specifier=>typeof specifier==='string'&&specifier.startsWith('./')&&
   (Object.hasOwn(controller.sourceHashes,specifier.slice(2))||specifier===sdkFile||specifier==='./'+applicationDependency||debuggerMetadata.qualified&&specifier==='./'+debuggerMetadata.file);
  for(const row of wrapper.body){
   if(row.type==='ImportDeclaration'){
    if(!allowedImport(row.source.value)||row.specifiers.some(s=>s.type==='ImportNamespaceSpecifier'))fail('wrapper_import');
    row.specifiers.forEach(s=>locals.add(s.local.name));continue;
   }
   if(row.type==='ExportNamedDeclaration'&&!row.declaration&&(!row.source||allowedImport(row.source.value)))continue;
   if(row.type==='ExportDefaultDeclaration'&&id(row.declaration)&&locals.has(row.declaration.name))continue;
   if(row.type==='VariableDeclaration'){
    for(const d of row.declarations){if(!id(d.id)||!id(d.init)||locals.has(d.id.name)||!locals.has(d.init.name))fail('wrapper_alias');locals.add(d.id.name);}continue;
   }
   if(row.type!=='EmptyStatement')fail('wrapper_effect');
  }
 }
 const sdk=(local,exported)=>imports.get(local)?.file===sdkFile&&imports.get(local)?.export===exported;
 function resolve(name){
  const seen=new Set();let n;
  while(name&&!seen.has(name)){seen.add(name);n=declarations.get(name);if(n?.type!=='Identifier')return n;name=n.name;}
  fail('alias');
 }
 const record=(n,kind,dependency)=>dependencies.push({kind,start:n.start,end:n.end,sourceSha256:sha(source.slice(n.start,n.end)),dependency});
 function cls(n){
  if(n.body.body.some(m=>m.type!=='MethodDefinition'||m.static||m.computed))fail('class_shape');
  const ctor=n.body.body.find(m=>m.kind==='constructor');
  if(n.superClass){
   if(member(n.superClass)!==id(n.superClass.object)+'.'+baseMember||!sdk(id(n.superClass.object),'I')||
    sha(source.slice(n.start,n.end))!==controller.classSha256||!controller.constructorDelegates)fail('controller_constructor');
   if(n.body.body.some(m=>['translationResources','fireApplicationResume'].includes(m.key.name)))fail('controller_override');
   record(n,'native-base-controller',{file:sdkFile,export:'I',member:baseMember});return;
  }
  const statements=ctor?.value.body.body,assignment=statements?.[0]?.expression,call=assignment?.right;
  if(!ctor||ctor.value.params.length||statements.length!==1||assignment?.type!=='AssignmentExpression'||assignment.operator!=='='||
   !id(assignment.left)||!declarations.has(assignment.left.name)||declarations.get(assignment.left.name)!==null||
   call?.type!=='CallExpression'||call.arguments.length!==1||call.callee?.type!=='MemberExpression'||call.callee.computed||
   call.callee.property.name!=='resolve'||!sdk(id(call.callee.object),'h')||
   member(call.arguments[0])!==id(call.arguments[0]?.object)+'.ClientVariablesService'||!sdk(id(call.arguments[0].object),'i'))fail('client_variables_constructor');
  record(n,'native-client-variables-service',{file:sdkFile,export:'i',member:'ClientVariablesService'});
 }
 function expr(n){
  if(!n)return;
  if(['Literal','FunctionExpression','ArrowFunctionExpression'].includes(n.type))return;
  if(n.type==='UnaryExpression'&&['!','-','+','void'].includes(n.operator)&&n.argument.type==='Literal')return;
  if(n.type==='Identifier'){if(!declarations.has(n.name))fail('external_value');return;}
  if(['ClassExpression','ClassDeclaration'].includes(n.type)){cls(n);return;}
  if(n.type==='ArrayExpression'){if(n.elements.some(e=>!e))fail('array');n.elements.forEach(expr);return;}
  if(n.type==='ObjectExpression'){
   for(const p of n.properties){
    const name=p.key?.name??p.key?.value;
    if(p.type!=='Property'||p.computed||p.kind!=='init'||p.method||['__proto__','prototype','constructor'].includes(name))fail('object');
    expr(p.value);
   }return;
  }
  if(n.type==='MemberExpression'&&!n.computed&&n.object.type==='MemberExpression'&&!n.object.computed&&
   n.object.property.name==='DataTypes'&&sdk(id(n.object.object),'w')){
   record(n,'native-data-type',{file:sdkFile,export:'w',member:'DataTypes.'+n.property.name});return;
  }
  if(n.type==='NewExpression'&&id(n.callee)&&n.arguments.length===0){
   const c=resolve(n.callee.name);if(!['ClassExpression','ClassDeclaration'].includes(c?.type))fail('construct');cls(c);return;
  }
  if(n.type==='CallExpression'){
   if(sdk(id(n.callee),'a')&&n.arguments.length===2&&n.arguments[1].type==='Literal'&&typeof n.arguments[1].value==='string'){
    const value=n.arguments[0],resolved=value.type==='Identifier'?resolve(value.name):value;
    if(!['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression','ClassDeclaration','ClassExpression'].includes(resolved?.type))fail('name_target');
    if(resolved.type.startsWith('Class'))cls(resolved);
    record(n,'native-name-helper',{file:sdkFile,export:'a'});return;
   }
   if(member(n.callee)==='OutSystemsDebugger.registerMetaInfo'&&n.arguments.length===1){
    const value=n.arguments[0].type==='Identifier'?resolve(n.arguments[0].name):n.arguments[0];
    if(value?.type!=='ObjectExpression'||value.properties.some(p=>(p.key?.name??p.key?.value)==='hasOwnProperty'))fail('metadata');
    expr(value);record(n,'native-debugger-metadata',null);return;
   }
   const callee=n.callee;
   if(callee.type==='MemberExpression'&&!callee.computed&&callee.property.name==='registerVariableGroupType'&&
    callee.object.type==='MemberExpression'&&!callee.object.computed&&callee.object.property.name==='constructor'&&
    id(callee.object.object)&&id(callee.object.object)===controller.instanceBinding?.local&&n.arguments.length===2&&
    n.arguments[0].type==='Literal'&&typeof n.arguments[0].value==='string'&&n.arguments[0].value.startsWith(moduleName+'.')&&n.arguments[1].type==='ArrayExpression'){
    expr(n.arguments[1]);record(n,'native-variable-group',null);return;
   }
  }
  fail('expression');
 }
 for(const row of ast.body){
  if(['ImportDeclaration','FunctionDeclaration','EmptyStatement'].includes(row.type))continue;
  if(row.type==='ExportNamedDeclaration'&&!row.source&&!row.declaration)continue;
  if(row.type==='VariableDeclaration'){row.declarations.forEach(d=>expr(d.init));continue;}
  if(row.type==='ClassDeclaration'){cls(row);continue;}
  if(row.type==='ExpressionStatement'){expr(row.expression);continue;}
  fail('statement');
 }
 let sdkPrimitives,dataTypes,baseConstruction,clientVariableResolution,qualifiedNativeEffectKinds=[];
 if(typeof files[controller.baseImport.file]==='string'){
  try{
   sdkPrimitives=qualifyOdcSdkInitializationPrimitives(files,{file:controller.baseImport.file,helperExport:'a',controllerExport:controller.baseImport.exported});
   qualifiedNativeEffectKinds=['native-name-helper','native-variable-group'];
  }catch(error){sdkPrimitives={qualified:false,error:/^debug_odc_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_sdk_initialization_unresolved'};}
  try{
   dataTypes=qualifyOdcNativeDataTypes(files,{file:controller.baseImport.file,exported:'w'});
   if(dependencies.filter(d=>d.kind==='native-data-type').every(d=>Object.hasOwn(dataTypes.types,d.dependency.member.slice('DataTypes.'.length))))
    qualifiedNativeEffectKinds.push('native-data-type');
   else dataTypes={...dataTypes,qualified:false,error:'debug_odc_data_types_member_missing'};
  }catch(error){dataTypes={qualified:false,error:/^debug_odc_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_data_types_unresolved'};}
 }
 if(debuggerMetadata.qualified)qualifiedNativeEffectKinds.push('native-debugger-metadata');
 try{baseConstruction=qualifyOdcBaseControllerConstruction(files,controller);qualifiedNativeEffectKinds.push('native-base-controller');}
 catch(error){baseConstruction={qualified:false,error:/^debug_odc_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_base_construction_unresolved'};}
 try{clientVariableResolution=qualifyOdcClientVariableResolution(files,{file:controller.baseImport.file});qualifiedNativeEffectKinds.push('native-client-variables-service');}
 catch(error){clientVariableResolution={qualified:false,error:/^debug_odc_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_client_variable_resolution_unresolved'};}
 const pendingNativeEffectKinds=[...new Set(dependencies.map(d=>d.kind))].filter(kind=>!qualifiedNativeEffectKinds.includes(kind));
 return {schema:'ssam-odc-controller-initialization/1',controller,sourceSha256:sha(source),dependencies,sdkPrimitives,dataTypes,debuggerMetadata,baseConstruction,clientVariableResolution,qualifiedNativeEffectKinds,
  ...(applicationInitialization?{applicationInitialization}:{}),
  pendingNativeEffectKinds,requiredAlreadyLoadedSdk:controller.baseImport.file,
  requiredAlreadyLoadedModules:[controller.baseImport.file,...(debuggerMetadata.qualified?[debuggerMetadata.file]:[]),...(applicationDependency?[applicationDependency]:[])],
  generatedSyntaxQualified:true,wrapperSyntaxQualified:true,nativeEffectsQualified:pendingNativeEffectKinds.length===0,
  initializationQualified:pendingNativeEffectKinds.length===0,applicationStartupQualified:false,executionAuthorized:false};
}
