// Separate native component registration from deferred render/lifecycle code.
// This qualifies one factory, never the other top-level effects in its module.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
import {qualifyOdcSdkInitializationPrimitives} from './debug-odc-sdk-initialization-primitives.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>{throw new Error('debug_odc_view_component_'+code);};
const id=n=>n?.type==='Identifier'?n.name:null;
const name=n=>id(n)??(n?.type==='Literal'?n.value:null);
const fn=n=>n&&['FunctionExpression','ArrowFunctionExpression'].includes(n.type)&&!n.async&&!n.generator;
export function readOdcViewComponent(source,view){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=new Map();
 for(const row of ast.body)if(row.type==='ImportDeclaration')for(const spec of row.specifiers)
  if(spec.type==='ImportSpecifier')imports.set(spec.local.name,{file:row.source.value,export:name(spec.imported)});
 const declarations=ast.body.flatMap(n=>n.type==='VariableDeclaration'?n.declarations:[]);
 const matches=declarations.filter(d=>id(d.id)===view.componentFactory);
 if(matches.length!==1)fail('factory');
 const naming=new Set();
 function unwrap(n){
  if(fn(n))return n;
  if(n?.type==='CallExpression'&&id(n.callee)&&imports.has(n.callee.name)&&n.arguments.length===2&&
   fn(n.arguments[0])&&n.arguments[1].type==='Literal'&&typeof n.arguments[1].value==='string'){
   naming.add(n.callee.name);return n.arguments[0];
  }
  fail('callback');
 }
 const factory=unwrap(matches[0].init),body=factory.body.body;
 if(factory.id||factory.params.length||!Array.isArray(body)||body.length!==2||body[0].type!=='VariableDeclaration'||
  body[0].declarations.length!==1||body[1].type!=='ReturnStatement')fail('factory_body');
 const declaration=body[0].declarations[0],component=id(declaration.id),call=declaration.init;
 if(!component||call?.type!=='CallExpression'||!id(call.callee)||!imports.has(call.callee.name)||call.arguments.length!==2)fail('wrapper');
 if(imports.has(component)||[view.modelFactory,view.controllerFactory].includes(component))fail('local_shadow');
 const render=unwrap(call.arguments[0]),metadata=call.arguments[1];
 if(metadata?.type!=='ObjectExpression')fail('metadata');
 const values=new Map(),deferred=[{kind:'render',sourceSha256:hash(source.slice(render.start,render.end))}];
 function literal(n){
  if(n?.type==='Literal'&&['string','number','boolean'].includes(typeof n.value))return n.value;
  if(n?.type==='UnaryExpression'&&n.operator==='!'&&n.argument.type==='Literal'&&[0,1].includes(n.argument.value))return !n.argument.value;
  fail('metadata_value');
 }
 for(const p of metadata.properties){
  if(p.type!=='Property'||p.kind!=='init'||p.method||p.computed||!name(p.key)||values.has(name(p.key)))fail('metadata_property');
  const key=name(p.key);values.set(key,p.value);
  if(['modelFactory','controllerFactory'].includes(key)){
   if(id(p.value)!==view[key])fail('factory_binding');
  }else if(['topLevelComponent','displayName'].includes(key))literal(p.value);
  else if(['getAttributes','getTitle'].includes(key)){
   const callback=unwrap(p.value);deferred.push({kind:key,sourceSha256:hash(source.slice(callback.start,callback.end))});
  }else if(key==='breakpointMinWidths'){
   if(p.value.type!=='ObjectExpression')fail('breakpoints');
   const seen=new Set();for(const width of p.value.properties){
    if(width.type!=='Property'||width.kind!=='init'||width.method||width.computed||!name(width.key)||seen.has(name(width.key))||
     !['ExtraSmall','Small','Medium','Large','ExtraLarge'].includes(name(width.key)))fail('breakpoints');
    seen.add(name(width.key));const value=literal(width.value);if(typeof value!=='number'||!Number.isFinite(value)||value<0)fail('breakpoints');
   }
  }else fail('metadata_unsupported'); // makeSpanProvider would execute at registration.
 }
 if(['topLevelComponent','displayName','getAttributes','modelFactory','controllerFactory'].some(k=>!values.has(k))||
  literal(values.get('displayName'))!==view.displayName||typeof literal(values.get('topLevelComponent'))!=='boolean')fail('metadata_binding');
 const sequence=body[1].argument;
 if(sequence?.type!=='SequenceExpression'||id(sequence.expressions.at(-1))!==component||sequence.expressions.length!==4)fail('return');
 const callbacks=new Set();
 for(const assignment of sequence.expressions.slice(0,-1)){
  const left=assignment.left,key=left?.property?.name;
  if(assignment.type!=='AssignmentExpression'||assignment.operator!=='='||left?.type!=='MemberExpression'||left.computed||
   id(left.object)!==component||!['getCssDependencies','getJsDependencies','getBlocks'].includes(key)||callbacks.has(key))fail('dependency_assignment');
  callbacks.add(key);const callback=unwrap(assignment.right);
  if(callback.params.length||callback.body.type!=='BlockStatement'||callback.body.body.length!==1||
   callback.body.body[0].type!=='ReturnStatement'||callback.body.body[0].argument?.type!=='ArrayExpression')fail('dependency_callback');
  const entries=callback.body.body[0].argument.elements;
  if(key==='getBlocks'){
   if(entries.some(e=>!id(e))||JSON.stringify(entries.map(id))!==JSON.stringify(view.blockComponents))fail('blocks');
  }else if(entries.some(e=>e?.type!=='Literal'||typeof e.value!=='string'))fail('resources');
  deferred.push({kind:key,sourceSha256:hash(source.slice(callback.start,callback.end))});
 }
 return {resolved:true,sourceSha256:hash(source),factorySha256:hash(source.slice(factory.start,factory.end)),
  renderRange:{start:render.start,end:render.end},wrapper:imports.get(call.callee.name),namingHelpers:[...naming].map(n=>imports.get(n)),
  topLevelComponent:literal(values.get('topLevelComponent')),deferredCallbacks:deferred,
  renderExecuted:false,lifecycleExecuted:false,viewInitializationQualified:false,executionAuthorized:false};
}
export function createOdcViewComponentInspector(files){
 const bind=createOdcSdkBindingReader(files),helpers=new Map();
 return view=>{
  const result=readOdcViewComponent(files[view.chunk],view),wrapper=bind.exportDeclaration(result.wrapper);
  // Reviewed original wrappers create React components and retain callbacks.
  // withTraceableView's native ViewSpanProvider constructor retains attributes,
  // span type and startSpan; it does not start a span or invoke app attributes.
  const expected=result.topLevelComponent?'8274509a681de6a23682bb271b864517c10f377970e38525e1cf00ccc7c62b14':
   '475cda34203de83ed8c688ca40387ad4a465da1c5164708c703c9b4245acdf9a';
  if(wrapper.chunkSha256!=='c9565f2d4c2afd26a125afc65f1174e43703d235d4e76035da3fff6185299bca'||wrapper.declarationSha256!==expected)fail('sdk_unreviewed');
  for(const helper of result.namingHelpers){
   const key=helper.file+':'+helper.export;
   if(!helpers.has(key))helpers.set(key,qualifyOdcSdkInitializationPrimitives(files,{file:helper.file.slice(2),helperExport:helper.export,controllerExport:'I'}));
   if(helpers.get(key).naming.qualified!==true)fail('naming_unresolved');
  }
  return {...result,componentRegistrationQualified:true,nativeWrapper:wrapper,
   effects:['native-react-component-registration','native-span-provider-field-storage'],
   importEffectsQualified:false,modelCreated:false,controllerCreated:false,permissionsChecked:false};
 };
}
