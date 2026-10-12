// Qualifies the generated variable-record initializer, not the enclosing view
// import or render. The original SDK still performs every metadata/property write.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
const fail=code=>{throw new Error('debug_odc_record_initialization_'+code);};
const hash=s=>createHash('sha256').update(s).digest('hex');
const member=(n,object,key)=>n?.type==='MemberExpression'&&!n.computed&&n.object?.type==='Identifier'&&n.object.name===object&&n.property.name===key;
function literal(n){
 if(n?.type==='Literal'&&['string','number','boolean'].includes(typeof n.value))return n.value;
 if(n?.type==='UnaryExpression'&&n.operator==='!'&&n.argument.type==='Literal'&&[0,1].includes(n.argument.value))return !n.argument.value;
 if(n?.type==='UnaryExpression'&&n.operator==='-'&&n.argument.type==='Literal'&&typeof n.argument.value==='number')return -n.argument.value;
 fail('literal');
}
function walk(n,visit){if(!n||typeof n.type!=='string')return;visit(n);for(const v of Object.values(n)){if(Array.isArray(v))v.forEach(x=>walk(x,visit));else if(v&&typeof v==='object')walk(v,visit);}}
function indexSource(source){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),declarations=new Map(),imports=new Map();
 for(const row of ast.body){
  if(row.type==='ImportDeclaration')for(const spec of row.specifiers)if(spec.type==='ImportSpecifier')imports.set(spec.local.name,{file:row.source.value,export:spec.imported.name});
  if(row.type==='VariableDeclaration')for(const d of row.declarations)if(d.id.type==='Identifier'){
   if(declarations.has(d.id.name))fail('ambiguous');declarations.set(d.id.name,d);
  }
 }
 return {ast,declarations,imports};
}
function inspect(index,recordLocal){
 const {ast,declarations,imports}=index,aliases=new Set();
 let local=recordLocal,decl;
 while(true){
  if(aliases.has(local))fail('alias_cycle');aliases.add(local);decl=declarations.get(local);
  if(!decl)fail('declaration');if(decl.init?.type!=='Identifier')break;
  if(!declarations.has(decl.init.name)||declarations.get(decl.init.name).end>decl.start)fail('alias_order');
  local=decl.init.name;
 }
 const cls=decl.init,base=cls?.superClass;
 if(cls?.type!=='ClassExpression'||base?.type!=='MemberExpression'||base.computed||base.object.type!=='Identifier'||base.property.name!=='GenericRecord')fail('class');
 const namespace=base.object.name,imported=imports.get(namespace);if(!imported)fail('sdk_import');
 if(cls.body.body.length!==1)fail('class_effect');
 const method=cls.body.body[0];
 if(method.type!=='MethodDefinition'||method.computed||method.kind!=='method'||!method.static||method.key.name!=='attributesToDeclare'||method.value.params.length||method.value.body.body.length!==1)fail('attributes');
 const returned=method.value.body.body[0];
 const concat=returned.argument;
 if(returned.type!=='ReturnStatement'||concat?.type!=='CallExpression'||concat.callee.type!=='MemberExpression'||concat.callee.computed||concat.callee.property.name!=='concat'||concat.callee.object.type!=='ArrayExpression'||concat.arguments.length!==1)fail('attributes');
 const inherited=concat.arguments[0],call=inherited?.callee,attrs=call?.object;
 if(inherited?.type!=='CallExpression'||call?.type!=='MemberExpression'||call.computed||call.property.name!=='call'||attrs?.type!=='MemberExpression'||attrs.computed||attrs.property.name!=='attributesToDeclare'||!member(attrs.object,namespace,'GenericRecord')||inherited.arguments.length!==1||inherited.arguments[0].type!=='ThisExpression')fail('inheritance');
 const fields=concat.callee.object.elements.map(item=>{
  if(item?.type!=='CallExpression'||item.callee.type!=='MemberExpression'||item.callee.computed||item.callee.object.type!=='ThisExpression'||item.callee.property.name!=='attr'||![7,8].includes(item.arguments.length))fail('attribute');
  const [name,attribute,jsonName,mandatory,ignore,type,defaultFn,optimize]=item.arguments;
  const strings=[name,attribute,jsonName].map(literal),booleans=[mandatory,ignore,...optimize?[optimize]:[]].map(literal);
  if(strings.some(x=>typeof x!=='string'||!x)||booleans.some(x=>typeof x!=='boolean'))fail('attribute');
  if(type?.type!=='MemberExpression'||type.computed||!member(type.object,namespace,'DataTypes')||!['Integer','Text','Boolean','Decimal'].includes(type.property.name))fail('type');
  if(defaultFn?.type!=='FunctionExpression'||defaultFn.async||defaultFn.generator||defaultFn.params.length||defaultFn.body.body.length!==1||defaultFn.body.body[0].type!=='ReturnStatement')fail('default');
  const defaultValue=literal(defaultFn.body.body[0].argument),dataType=type.property.name;
  if(dataType==='Text'&&typeof defaultValue!=='string'||dataType==='Boolean'&&typeof defaultValue!=='boolean'||['Integer','Decimal'].includes(dataType)&&typeof defaultValue!=='number')fail('default_type');
  return {name:strings[0],attribute:strings[1],jsonName:strings[2],dataType,defaultValue};
 });
 if(new Set(fields.map(f=>f.attribute)).size!==fields.length)fail('duplicate_attribute');
 const initCalls=ast.body.filter(row=>row.type==='ExpressionStatement'&&row.expression.type==='CallExpression'&&member(row.expression.callee,recordLocal,'init'));
 if(initCalls.length!==1||initCalls[0].expression.arguments.length||initCalls[0].start<Math.max(...[...aliases].map(a=>declarations.get(a).end)))fail('init_call');
 // No rebinding or direct mutation of any alias or its imported namespace.
 // Include aliases declared elsewhere, which can otherwise mutate the class
 // without spelling the factory's selected alias.
 let changed=true;while(changed){changed=false;for(const [name,d] of declarations)if(d.init?.type==='Identifier'&&aliases.has(d.init.name)&&!aliases.has(name)){aliases.add(name);changed=true;}}
 const protectedNames=new Set([...aliases,namespace]);
 const references=new Set([cls.id,initCalls[0].expression.callee.object]);
 for(const name of aliases){const d=declarations.get(name);references.add(d.id);if(d.init?.type==='Identifier')references.add(d.init);}
 function root(n){while(n?.type==='MemberExpression')n=n.object;return n?.type==='Identifier'?n.name:null;}
 walk(ast,n=>{
  const target=n.type==='AssignmentExpression'?n.left:n.type==='UpdateExpression'||n.type==='UnaryExpression'&&n.operator==='delete'?n.argument:null;
  if(target&&protectedNames.has(root(target)))fail('binding_write');
  if(n.type!=='CallExpression'&&n.type!=='NewExpression')return;
  if(aliases.has(root(n.callee))&&n!==initCalls[0].expression)fail('class_call');
  if(!n.arguments.some(arg=>aliases.has(root(arg))))return;
  const helper=n.callee.type==='Identifier'?imports.get(n.callee.name):null;
  if(n.type!=='CallExpression'||helper?.file!==imported.file||helper?.export!=='a'||n.arguments.length!==2||n.arguments[0].type!=='Identifier'||!aliases.has(n.arguments[0].name)||n.arguments[1].type!=='Literal'||typeof n.arguments[1].value!=='string')fail('class_escape');
  references.add(n.arguments[0]);
 });
 walk(ast,n=>{
  if(n.type==='MethodDefinition'&&n.static&&!n.computed&&n.key.name==='getVariablesRecordConstructor'&&n.value.params.length===0&&n.value.body.body.length===1){
   const r=n.value.body.body[0];if(r.type==='ReturnStatement'&&r.argument?.type==='Identifier'&&aliases.has(r.argument.name))references.add(r.argument);
  }
 });
 walk(ast,n=>{if(n.type==='Identifier'&&aliases.has(n.name)&&!references.has(n))fail('class_escape');});
 return {recordLocal,classLocal:local,namespace,imported,fields,classSha256:hash(index.source.slice(cls.start,cls.end)),initOffset:initCalls[0].start};
}
export function inspectOdcRecordDeclaration(source,recordLocal){return inspect({...indexSource(source),source},recordLocal);}
export function createOdcRecordInitializationInspector(files){
 const bind=createOdcSdkBindingReader(files),cache=new Map();
 return view=>{
  const source=files[view.chunk];if(typeof source!=='string')fail('source');
  if(!cache.has(view.chunk))cache.set(view.chunk,{...indexSource(source),source});
  const index=cache.get(view.chunk),factory=index.declarations.get(view.modelFactory)?.init;
  if(factory?.type!=='NewExpression'||factory.arguments.length!==1||factory.arguments[0].type!=='Identifier')fail('model_factory');
  let model=factory.arguments[0].name;const seen=new Set();
  while(index.declarations.get(model)?.init?.type==='Identifier'){if(seen.has(model))fail('alias_cycle');seen.add(model);model=index.declarations.get(model).init.name;}
  const cls=index.declarations.get(model)?.init,methods=cls?.body?.body?.filter(m=>m.type==='MethodDefinition'&&!m.computed&&m.static&&m.key.name==='getVariablesRecordConstructor');
  if(cls?.type!=='ClassExpression'||methods?.length!==1)fail('model_record');
  const fn=methods[0].value,statements=fn.body.body;
  if(fn.params.length||statements.length!==1||statements[0].type!=='ReturnStatement'||statements[0].argument?.type!=='Identifier')fail('model_record');
  const record=inspect(index,statements[0].argument.name),sdk=bind({...record.imported,member:'GenericRecord'});
  // Reviewed native init: calls the declared defaults, defines own metadata and
  // prototype accessors, and constructs the SDK immutable record class. Its
  // complete chunk pin also covers inherited helpers and default-value helpers.
  if(sdk.chunkSha256!=='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d'||sdk.declarationSha256!=='6a5ca01be0edb3fc87cf619f9c254961ee4aef2ca498813ab64f1d29113b8e4a')fail('sdk_unreviewed');
  return {schema:'ssam-odc-record-initialization/1',recordInitializationQualified:true,sourceSha256:hash(source),record,
   sdk:{file:sdk.file,chunkSha256:sdk.chunkSha256,declarationSha256:sdk.declarationSha256},
   effects:['record-class-metadata','record-prototype-accessors','immutable-record-class'],
   viewImportQualified:false,viewInitializationQualified:false,executionAuthorized:false};
 };
}
