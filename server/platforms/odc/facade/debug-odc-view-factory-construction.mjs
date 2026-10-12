// Constructing these SDK factories only retains the generated class/provider.
// create/initialize, permission checks and lifecycle remain deferred and are
// deliberately not qualified by this constructor inspection.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>{throw new Error('debug_odc_view_factory_'+code);};
export function qualifyOdcViewFactoryConstruction(files,view){
 return createOdcViewFactoryInspector(files)(view);
}
export function createOdcViewFactoryInspector(files){
 const bind=createOdcSdkBindingReader(files),modules=new Map();
 return view=>{
 const source=files?.[view?.chunk];if(typeof source!=='string')fail('source');
 let module=modules.get(view.chunk);
 if(!module){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=new Map(),declarations=new Map();
 for(const row of ast.body){
  if(row.type==='ImportDeclaration')for(const spec of row.specifiers)if(spec.type==='ImportSpecifier')
   imports.set(spec.local.name,{file:row.source.value,export:spec.imported.name});
  if(row.type==='VariableDeclaration')for(const d of row.declarations)if(d.id.type==='Identifier'){
   if(declarations.has(d.id.name))fail('ambiguous');declarations.set(d.id.name,d.init);
  }
 }
 module={ast,imports,declarations};modules.set(view.chunk,module);
 }
 const {ast,imports,declarations}=module,factories=[];
 for(const [local,member,fields] of [[view.modelFactory,'ModelFactory',['modelClass']],
  [view.controllerFactory,'ControllerFactory',['controllerClass','messagesProvider']]]){
  const instance=declarations.get(local),callee=instance?.callee;
  if(instance?.type!=='NewExpression'||callee?.type!=='MemberExpression'||callee.computed||
   callee.object.type!=='Identifier'||callee.property.name!==member||instance.arguments.length!==fields.length||
   instance.arguments.some(a=>a.type!=='Identifier'))fail('instance');
  const imported=imports.get(callee.object.name);if(!imported)fail('binding');
  const binding=bind({...imported,member}),text=files[binding.file].slice(binding.start,binding.end);
  const cls=parse('('+text+')',{ecmaVersion:'latest'}).body[0].expression;
  if(!['ClassExpression','ClassDeclaration'].includes(cls.type)||cls.superClass||
   cls.body.body.some(m=>m.type!=='MethodDefinition'||m.computed||fields.includes(m.key.name)))fail('class');
  const constructors=cls.body.body.filter(m=>m.kind==='constructor');if(constructors.length!==1)fail('constructor');
  const fn=constructors[0].value;
  if(fn.params.length!==fields.length||fn.params.some(p=>p.type!=='Identifier')||
   new Set(fn.params.map(p=>p.name)).size!==fields.length||fn.body.body.some(s=>s.type!=='ExpressionStatement'))fail('constructor');
  const assignments=fn.body.body.flatMap(s=>s.expression.type==='SequenceExpression'?s.expression.expressions:[s.expression]);
  if(assignments.length!==fields.length||assignments.some((a,i)=>a.type!=='AssignmentExpression'||a.operator!=='='||
   a.left.type!=='MemberExpression'||a.left.computed||a.left.object.type!=='ThisExpression'||a.left.property.name!==fields[i]||
   a.right.type!=='Identifier'||a.right.name!==fn.params[i].name))fail('constructor_effect');
  // Imported namespace aliases cannot be reassigned anywhere in this module.
  const visit=n=>{if(!n||typeof n!=='object')return;
   if((n.type==='AssignmentExpression'&&n.left.type==='Identifier'&&n.left.name===callee.object.name)||
    (n.type==='UpdateExpression'&&n.argument.type==='Identifier'&&n.argument.name===callee.object.name))fail('binding_write');
   for(const v of Object.values(n))if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v);
  };visit(ast);
  factories.push({local,member,sdkFile:binding.file,sdkSha256:binding.chunkSha256,
   declarationSha256:binding.declarationSha256,storedFields:fields});
 }
 return {schema:'ssam-odc-view-factory-construction/1',factoryConstructionQualified:true,
  sourceSha256:hash(source),factories,effects:['native-factory-instance-fields'],
  modelCreated:false,controllerCreated:false,permissionsChecked:false,viewInitializationQualified:false,executionAuthorized:false};
 };
}
