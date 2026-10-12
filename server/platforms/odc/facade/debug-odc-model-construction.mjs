// Inspect the generated model's constructor dependencies without instantiating
// the model. Rendering, setInputs and controller initialization remain separate.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
import {createOdcRecordInitializationInspector} from './debug-odc-record-initialization.mjs';
import {inspectOdcModelInputs} from './debug-odc-model-inputs.mjs';
const fail=code=>{throw new Error('debug_odc_model_construction_'+code);};
const hash=s=>createHash('sha256').update(s).digest('hex');
function returned(method){
 const fn=method?.value,body=fn?.body?.body;
 if(fn?.params.length||body?.length!==1||body[0].type!=='ReturnStatement')fail('getter');
 return body[0].argument;
}
function boolean(node){
 if(node?.type==='Literal'&&typeof node.value==='boolean')return node.value;
 if(node?.type==='UnaryExpression'&&node.operator==='!'&&node.argument.type==='Literal'&&[0,1].includes(node.argument.value))return !node.argument.value;
 fail('validation_flag');
}
export function inspectOdcModelDeclaration(source,factoryLocal){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),declarations=new Map(),imports=new Map();
 for(const row of ast.body){
  if(row.type==='ImportDeclaration')for(const spec of row.specifiers)if(spec.type==='ImportSpecifier')imports.set(spec.local.name,{file:row.source.value,export:spec.imported.name});
  if(row.type==='VariableDeclaration')for(const d of row.declarations)if(d.id.type==='Identifier'){
   if(declarations.has(d.id.name))fail('duplicate');declarations.set(d.id.name,d);
  }
 }
 const references=new Set(),protectedNames=new Set(),nativeNamespaces=new Set();
 function resolve(name){
  const seen=new Set();
  while(true){
   if(seen.has(name))fail('alias_cycle');seen.add(name);protectedNames.add(name);
   const d=declarations.get(name);if(!d)fail('declaration');references.add(d.id);
   if(d.init?.type!=='Identifier'){if(d.init?.id)references.add(d.init.id);return d.init;}
   references.add(d.init);
   if(!declarations.has(d.init.name)||declarations.get(d.init.name).end>d.start)fail('alias_order');name=d.init.name;
  }
 }
 function nativeMember(n,expected){
  if(n?.type!=='MemberExpression'||n.computed||n.object.type!=='Identifier'||n.property.name!==expected)fail('native_member');
  const imported=imports.get(n.object.name);if(!imported)fail('native_import');nativeNamespaces.add(n.object.name);return {...imported,member:expected};
 }
 const factory=resolve(factoryLocal);
 if(factory?.type!=='NewExpression'||factory.arguments.length!==1||factory.arguments[0].type!=='Identifier')fail('factory');
 const bindings={ModelFactory:nativeMember(factory.callee,'ModelFactory')};
 references.add(factory.arguments[0]);
 const model=resolve(factory.arguments[0].name);
 if(model?.type!=='ClassExpression')fail('model');
 bindings.BaseViewModel=nativeMember(model.superClass,'BaseViewModel');
 const names=['getVariablesRecordConstructor','getWidgetsRecordConstructor','hasValidationWidgets','setInputs'];
 if(model.body.body.length!==names.length||model.body.body.some(m=>m.type!=='MethodDefinition'||m.computed||!names.includes(m.key.name))||new Set(model.body.body.map(m=>m.key.name)).size!==names.length)fail('model_effect');
 const methods=Object.fromEntries(model.body.body.map(m=>[m.key.name,m]));
 for(const name of names.slice(0,3))if(!methods[name].static||methods[name].kind!==(name==='hasValidationWidgets'?'get':'method'))fail('getter');
 if(methods.setInputs.static||methods.setInputs.kind!=='method')fail('set_inputs');
 const variables=returned(methods.getVariablesRecordConstructor),widgets=returned(methods.getWidgetsRecordConstructor);
 if(variables?.type!=='Identifier'||widgets?.type!=='Identifier')fail('record_getter');
 references.add(widgets);
 const widgetClass=resolve(widgets.name);
 if(widgetClass?.type!=='ClassExpression')fail('widgets');
 bindings.BaseWidgetRecordMap=nativeMember(widgetClass.superClass,'BaseWidgetRecordMap');
 if(widgetClass.body.body.length!==1)fail('widgets_effect');
 const widgetMethod=widgetClass.body.body[0];
 if(widgetMethod.type!=='MethodDefinition'||widgetMethod.computed||!widgetMethod.static||widgetMethod.kind!=='method'||widgetMethod.key.name!=='getWidgetsType')fail('widgets');
 const types=returned(widgetMethod);if(types?.type!=='ObjectExpression')fail('widgets');
 const widgetTypes=types.properties.map(prop=>{
  if(prop.type!=='Property'||prop.computed||prop.kind!=='init'||prop.method||prop.key.type!=='Identifier')fail('widget_type');
  const binding=nativeMember(prop.value,'ValidationWidgetRecord');
  return {name:prop.key.name,binding};
 });
 if(new Set(widgetTypes.map(w=>w.name)).size!==widgetTypes.length)fail('widget_duplicate');
 const hasValidationWidgets=boolean(returned(methods.hasValidationWidgets));
 if(hasValidationWidgets!==(widgetTypes.length>0))fail('widgets_flag');
 // Other aliases and class escapes can alter virtual constructor callbacks.
 let changed=true;while(changed){changed=false;for(const [name,d] of declarations)if(d.init?.type==='Identifier'&&protectedNames.has(d.init.name)&&!protectedNames.has(name)){protectedNames.add(name);references.add(d.id);references.add(d.init);changed=true;}}
 function walk(n,visit,parent){if(!n||typeof n.type!=='string')return;visit(n,parent);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(x=>walk(x,visit,n));else if(v&&typeof v==='object')walk(v,visit,n);}
 walk(ast,n=>{
  const target=n.type==='AssignmentExpression'?n.left:n.type==='UpdateExpression'||n.type==='UnaryExpression'&&n.operator==='delete'?n.argument:null;
  let root=target;while(root?.type==='MemberExpression')root=root.object;
  if(root?.type==='Identifier'&&nativeNamespaces.has(root.name))fail('sdk_write');
  if(n.type==='CallExpression'||n.type==='NewExpression')for(const arg of n.arguments)walk(arg,(v,parent)=>{if(v.type==='Identifier'&&nativeNamespaces.has(v.name)&&!(parent?.type==='MemberExpression'&&parent.object===v))fail('sdk_escape');});
  if(n.type==='CallExpression'&&n.callee.type==='Identifier'&&n.arguments.length===2&&n.arguments[0].type==='Identifier'&&protectedNames.has(n.arguments[0].name)&&n.arguments[1].type==='Literal'&&typeof n.arguments[1].value==='string'){
   const helper=imports.get(n.callee.name);if(helper?.file===bindings.BaseViewModel.file&&helper?.export==='a')references.add(n.arguments[0]);
  }
  // Generated cache assignment does not override a constructor callback.
  if(n.type==='AssignmentExpression'&&n.operator==='='&&n.left.type==='MemberExpression'&&!n.left.computed&&protectedNames.has(n.left.object?.name)&&n.left.property.name==='_hasValidationWidgetsValue'&&n.right.type==='UnaryExpression'&&n.right.operator==='void'&&n.right.argument.type==='Literal'&&n.right.argument.value===0)references.add(n.left.object);
  // The published factory can be passed to the view wrapper; that import has
  // its own qualification and is not authorized by this declaration result.
  if(n.type==='Property'&&!n.computed&&n.kind==='init'&&n.key.name==='modelFactory'&&n.value.type==='Identifier'&&n.value.name===factoryLocal)references.add(n.value);
  if(n.type==='ExportSpecifier'&&n.local.name===factoryLocal&&n.exported.name==='modelModule')references.add(n.local);
 });
 walk(ast,n=>{if(n.type==='Identifier'&&protectedNames.has(n.name)&&!references.has(n))fail('class_escape');});
 return {factoryLocal,variablesRecord: variables.name,widgetsRecord: widgets.name,bindings,widgetTypes,hasValidationWidgets,
  modelClassSha256:hash(source.slice(model.start,model.end)),widgetClassSha256:hash(source.slice(widgetClass.start,widgetClass.end)),
  setInputsRange:{start:methods.setInputs.start,end:methods.setInputs.end},setInputsQualified:false};
}
export function createOdcModelConstructionInspector(files){
 const bind=createOdcSdkBindingReader(files),records=createOdcRecordInitializationInspector(files);
 return view=>{
  const source=files[view.chunk];if(typeof source!=='string')fail('source');
  const declaration=inspectOdcModelDeclaration(source,view.modelFactory),record=records(view);
  if(record.record.recordLocal!==declaration.variablesRecord)fail('record_binding');
  const expected={ModelFactory:'aca087629e0639cd01b10db824cfa9f48de8c163107cd78d39967066074c1860',BaseViewModel:'214e2edc3a8e3f140eccc9ab7319060f00f5ee23c595987935aa023f9b8c5265',BaseWidgetRecordMap:'1a0064d88e0d4d598d43f8c54503f8e2e1d9b35279cee67936024077aa25c016',ValidationWidgetRecord:'44d69a19173a68c83eea656720ccf34a210735b382c0e58fea0567a2e2df6753'};
  const sdk=[...Object.values(declaration.bindings),...declaration.widgetTypes.map(w=>w.binding)].map(spec=>{
   const resolved=bind(spec);
   if(resolved.chunkSha256!=='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d'||resolved.declarationSha256!==expected[spec.member])fail('sdk_unreviewed');
   return {member:spec.member,file:resolved.file,chunkSha256:resolved.chunkSha256,declarationSha256:resolved.declarationSha256};
  });
  let inputs;
  try{inputs=inspectOdcModelInputs(source.slice(declaration.setInputsRange.start,declaration.setInputsRange.end),record.record.fields);}
  catch(error){inputs={setInputsQualified:false,error:/^debug_odc_model_inputs_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_model_inputs_unresolved'};}
  return {schema:'ssam-odc-model-construction/1',modelConstructionQualified:true,sourceSha256:hash(source),declaration,sdk,inputs,
   effects:['native-variable-record-instance','native-widget-record-map','native-model-cache-and-subscriptions'],
   modelCreated:false,permissionsChecked:false,setInputsQualified:inputs.setInputsQualified,viewInitializationQualified:false,executionAuthorized:false};
 };
}
