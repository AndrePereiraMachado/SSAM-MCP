// Qualify two bounded SDK operations by their bodies: naming a generated
// function and storing an unexecuted variable-group definition in a native Map.
// This does not qualify the SDK or application startup as a whole.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
const fail=reason=>{throw new Error('debug_odc_sdk_initialization_'+reason);};
const id=n=>n?.type==='Identifier'?n.name:null;
const path=n=>id(n)??(n?.type==='ThisExpression'?'this':n?.type==='MemberExpression'&&!n.computed&&path(n.object)?path(n.object)+'.'+n.property.name:null);
export function qualifyOdcSdkInitializationPrimitives(files,{file,helperExport,controllerExport}){
 const bind=createOdcSdkBindingReader(files),helper=bind.exportDeclaration({file:'./'+file,export:helperExport});
 const base=bind({file:'./'+file,export:controllerExport,member:'BaseModuleController'});
 const source=files[file],ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),declarations=new Map();
 for(const row of ast.body){
  if(row.type==='ImportDeclaration'&&row.specifiers.some(s=>['Object','Map'].includes(s.local.name)))fail('builtin_shadowed');
  if(row.type==='VariableDeclaration')for(const d of row.declarations)if(id(d.id))declarations.set(d.id.name,d.init);
  if(['ClassDeclaration','FunctionDeclaration'].includes(row.type))declarations.set(row.id.name,row);
 }
 function resolve(symbol){
  const seen=new Set();let node;
  while(symbol&&!seen.has(symbol)){seen.add(symbol);node=declarations.get(symbol);if(node?.type!=='Identifier')return node;symbol=node.name;}
  fail('alias');
 }
 function params(fn,count){if(!fn||!['FunctionExpression','FunctionDeclaration','ArrowFunctionExpression'].includes(fn.type)||fn.async||fn.generator||fn.params.length!==count||fn.params.some(p=>!id(p)))fail('parameters');return fn.params.map(id);}
 function expression(fn){const b=fn.body;if(b.type!=='BlockStatement')return b;
  if(b.body.length!==1||!['ReturnStatement','ExpressionStatement'].includes(b.body[0].type))fail('body');return b.body[0].argument??b.body[0].expression;}
 const naming=resolve(helper.symbol),[value,name]=params(naming,2),call=expression(naming);
 if(call?.type!=='CallExpression'||call.arguments.length!==3||id(call.arguments[0])!==value||call.arguments[1]?.value!=='name')fail('naming');
 const callee=id(call.callee)?resolve(call.callee.name):call.callee;
 if(declarations.has('Object')||naming.params.some(p=>p.name==='Object')||path(callee)!=='Object.defineProperty')fail('naming');
 const properties=call.arguments[2];
 if(properties?.type!=='ObjectExpression'||properties.properties.length!==2||properties.properties.some(p=>p.type!=='Property'||p.computed||p.kind!=='init'||p.method))fail('naming');
 const entries=new Map(properties.properties.map(p=>[p.key.name??p.key.value,p.value]));
 const configurable=entries.get('configurable'),isTrue=configurable?.type==='Literal'&&configurable.value===true||
  configurable?.type==='UnaryExpression'&&configurable.operator==='!'&&configurable.argument.type==='Literal'&&configurable.argument.value===0;
 if(id(entries.get('value'))!==name||!isTrue)fail('naming');
 let cls=resolve(base.symbol),registration;const hierarchy=new Set();
 while(cls){
  if(!['ClassDeclaration','ClassExpression'].includes(cls.type)||hierarchy.has(cls))fail('controller_base');hierarchy.add(cls);
  const matches=cls.body.body.filter(m=>m.type==='MethodDefinition'&&m.static&&!m.computed&&m.key.name==='registerVariableGroupType');
  if(matches.length>1)fail('registration');if(matches.length){registration=matches[0];break;}
  cls=cls.superClass&&id(cls.superClass)?resolve(cls.superClass.name):null;
 }
 if(!registration)fail('registration');
 const [key,definition]=params(registration.value,2),delegation=expression(registration.value);
 if(delegation?.type!=='CallExpression'||delegation.callee.type!=='MemberExpression'||delegation.callee.computed||
  delegation.callee.property.name!=='registerTypeDefinition'||!id(delegation.callee.object)||delegation.arguments.length!==2||
  id(delegation.arguments[0])!==key||id(delegation.arguments[1])!==definition)fail('registration');
 const instance=resolve(delegation.callee.object.name);
 if(instance?.type!=='NewExpression'||instance.arguments.length||!id(instance.callee))fail('registry_instance');
 const registry=resolve(instance.callee.name);
 if(!['ClassDeclaration','ClassExpression'].includes(registry?.type)||registry.superClass||registry.body.body.some(m=>m.type!=='MethodDefinition'||m.computed))fail('registry_class');
 const method=registry.body.body.find(m=>!m.static&&m.kind==='method'&&m.key.name==='registerTypeDefinition');
 const ctor=registry.body.body.find(m=>m.kind==='constructor');if(!method||!ctor||ctor.value.params.length)fail('registry_class');
 const [mapKey,mapValue]=params(method.value,2),store=expression(method.value);
 if(store?.type!=='CallExpression'||store.arguments.length!==2||id(store.arguments[0])!==mapKey||id(store.arguments[1])!==mapValue||
  !/^this\.[A-Za-z_$][\w$]*\.set$/.test(path(store.callee)??''))fail('registry_store');
 const mapField=path(store.callee).split('.')[1];
 if(registry.body.body.some(m=>m.key.name===mapField)||declarations.has('Map'))fail('registry_map');
 const assignments=[];
 function assignment(n){if(n.type==='SequenceExpression'){n.expressions.forEach(assignment);return;}
  if(n.type!=='AssignmentExpression'||n.operator!=='='||!/^this\.[A-Za-z_$][\w$]*$/.test(path(n.left)??'')||
   n.right.type!=='NewExpression'||id(n.right.callee)!=='Map'||n.right.arguments.length)fail('registry_constructor');
  assignments.push(path(n.left));}
 for(const row of ctor.value.body.body){if(row.type!=='ExpressionStatement')fail('registry_constructor');assignment(row.expression);}
 if(assignments.filter(p=>p==='this.'+mapField).length!==1||new Set(assignments).size!==assignments.length)fail('registry_map');
 const hash=n=>createHash('sha256').update(source.slice(n.start,n.end)).digest('hex');
 return {schema:'ssam-odc-sdk-initialization-primitives/1',file,sdkSha256:helper.chunkSha256,
  naming:{qualified:true,effect:'generated-function-name-property',declarationSha256:hash(naming)},
  variableGroupRegistration:{qualified:true,effect:'native-map-definition-storage',dispatchSha256:hash(registration),
   storeSha256:hash(method),constructorSha256:hash(ctor)},
  applicationStartupQualified:false,executionAuthorized:false};
}
