// Source inventory, not an evaluator or an execution authorization. Function
// bodies and instance fields are deferred; class bases, computed keys, static
// fields/blocks and ordinary module expressions execute during module loading.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function inspectOdcModuleInitializers(source,file){
 if(typeof source!=='string'||!/^_oschunk-[A-Za-z0-9]+\.js$/.test(file??''))throw new Error('debug_odc_initializers_source_invalid');
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=[];
 let effects=[],deferred=[];
 const target=n=>n?.type==='Identifier'?n.name:n?.type==='ThisExpression'?'this':n?.type==='Super'?'super':
  n?.type==='MemberExpression'&&!n.computed&&target(n.object)?target(n.object)+'.'+n.property.name:null;
 const site=(node,kind,extra={})=>({kind,start:node.start,end:node.end,sourceSha256:hash(source.slice(node.start,node.end)),...extra});
 function visit(node){
  if(!node||typeof node.type!=='string')return;
  if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type)){
   deferred.push(site(node,'function',{name:node.id?.name??null}));return;
  }
  if(node.type==='ImportDeclaration'){
   imports.push({specifier:node.source.value,bindings:node.specifiers.map(s=>({local:s.local.name,exported:s.imported?.name??(s.type==='ImportDefaultSpecifier'?'default':'*')}))});return;
  }
  if(['ClassDeclaration','ClassExpression'].includes(node.type)){
   visit(node.superClass);
   for(const member of node.body.body){
    if(member.computed)visit(member.key);
    if(member.type==='StaticBlock')member.body.forEach(visit);
    else if(member.type==='PropertyDefinition'){
     if(member.static)visit(member.value);else if(member.value)deferred.push(site(member.value,'instance-field'));
    }else if(member.type==='MethodDefinition')deferred.push(site(member.value,member.kind==='constructor'?'constructor':'method',{name:member.computed?null:member.key.name??member.key.value}));
    else throw new Error('debug_odc_initializers_class_member_unknown');
   }return;
  }
  if(node.type==='CallExpression'||node.type==='NewExpression')effects.push(site(node,node.type==='NewExpression'?'construct':'call',{
   target:target(node.callee),inlineFunction:['FunctionExpression','ArrowFunctionExpression'].includes(node.callee.type),argumentCount:node.arguments.length}));
  if(node.type==='ImportExpression')effects.push(site(node,'dynamic-import',{specifier:node.source.type==='Literal'?node.source.value:null}));
  if(['AssignmentExpression','UpdateExpression'].includes(node.type)||node.type==='UnaryExpression'&&node.operator==='delete')
   effects.push(site(node,'write',{target:target(node.left??node.argument),operator:node.operator}));
  if(node.type==='AwaitExpression')effects.push(site(node,'await'));
  for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
 }
 visit(ast);
 const moduleEffects=effects,moduleDeferred=deferred,declarations=new Map(),ambiguous=new Set();
 const declare=(name,node)=>{if(declarations.has(name))ambiguous.add(name);declarations.set(name,node);};
 for(const row of ast.body){
  const node=row.type==='ExportNamedDeclaration'?row.declaration:row;
  if(node?.type==='VariableDeclaration')for(const d of node.declarations)if(d.id.type==='Identifier')declare(d.id.name,d.init);
  if(node?.type==='ClassDeclaration')declare(node.id.name,node);
 }
 const constructors=moduleEffects.filter(e=>e.kind==='construct').map(effect=>{
  let symbol=effect.target,node;const aliases=[],seen=new Set();
  while(symbol&&!seen.has(symbol)&&!ambiguous.has(symbol)){
   seen.add(symbol);aliases.push(symbol);node=declarations.get(symbol);
   if(node?.type!=='Identifier')break;symbol=node.name;node=undefined;
  }
  if(!['ClassDeclaration','ClassExpression'].includes(node?.type))return {site:effect.start,target:effect.target,resolved:false,aliases};
  const constructor=node.body.body.find(m=>m.kind==='constructor');effects=[];deferred=[];
  if(constructor){constructor.value.params.forEach(visit);visit(constructor.value.body);}
  for(const field of node.body.body)if(field.type==='PropertyDefinition'&&!field.static)visit(field.value);
  return {site:effect.start,target:effect.target,resolved:true,aliases,classSha256:hash(source.slice(node.start,node.end)),
   base:target(node.superClass),implicitConstructor:!constructor,constructorSha256:constructor?hash(source.slice(constructor.start,constructor.end)):null,
   effects,deferred,executionOrderModeled:false,transitiveEffectsQualified:false};
 });
 return {schema:'ssam-odc-module-initializers/1',file,sourceSha256:hash(source),imports,effects:moduleEffects,deferred:moduleDeferred,constructors,
  transitiveEffectsQualified:false,executionAuthorized:false};
}
