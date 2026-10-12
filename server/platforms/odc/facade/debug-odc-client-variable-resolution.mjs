// The native DI resolve operation reads a previously registered value. Do not
// mistake it for the registration factory that constructs the storage service.
import {parse,parseExpressionAt} from 'acorn';import {createHash} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
const fail=reason=>{throw new Error('debug_odc_client_variable_resolution_'+reason);};
export function qualifyOdcClientVariableResolution(files,{file,containerExport='h',servicesExport='i'}){
 const bind=createOdcSdkBindingReader(files),container=bind.exportDeclaration({file:'./'+file,export:containerExport});
 const token=bind({file:'./'+file,export:servicesExport,member:'ClientVariablesService'}),source=files[file];
 const tokenSource=source.slice(token.start,token.end),literal=parseExpressionAt(tokenSource,0,{ecmaVersion:'latest'});
 if(literal.end!==tokenSource.length||literal.type!=='Literal'||literal.value!=='ClientVariablesService')fail('service_token');
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),declarations=new Map();
 for(const row of ast.body){
  if(row.type==='VariableDeclaration')for(const d of row.declarations)if(d.id.type==='Identifier')declarations.set(d.id.name,d.init);
  if(row.type==='FunctionDeclaration')declarations.set(row.id.name,row);
 }
 function resolve(name){const seen=new Set();let n;while(name&&!seen.has(name)){seen.add(name);n=declarations.get(name);if(n?.type!=='Identifier')return n;name=n.name;}fail('alias');}
 const object=resolve(container.symbol);
 if(object?.type!=='ObjectExpression'||object.properties.some(p=>p.type!=='Property'||p.computed||p.kind!=='init'||p.method))fail('container');
 const entries=object.properties.filter(p=>(p.key.name??p.key.value)==='resolve');
 if(entries.length!==1||entries[0].value.type!=='Identifier')fail('resolve');
 const fn=resolve(entries[0].value.name);
 if(!['FunctionDeclaration','FunctionExpression'].includes(fn?.type)||fn.async||fn.generator||fn.params.length!==1||fn.params[0].type!=='Identifier'||
  fn.body.body.length!==1||fn.body.body[0].type!=='ReturnStatement')fail('resolve');
 const read=fn.body.body[0].argument;
 if(read?.type!=='MemberExpression'||!read.computed||read.object.type!=='Identifier'||read.property.type!=='Identifier'||read.property.name!==fn.params[0].name)fail('resolve');
 const cacheName=read.object.name,cache=declarations.get(cacheName);
 if(cache?.type!=='ObjectExpression'||cache.properties.length)fail('cache');
 let reads=0,writes=0,deletes=0;
 function walk(n,parent){
  if(!n||!n.type)return;
  if(n.type==='Identifier'&&n.name==='Reflect'&&
   (parent?.type==='VariableDeclarator'&&parent.id===n||['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(parent?.type)&&parent.params.includes(n)))fail('builtin_shadowed');
  if(n.type==='Identifier'&&n.name===cacheName){
   if(parent?.type==='VariableDeclarator'&&parent.id===n&&parent.init===cache){}
   else if(parent?.type==='MemberExpression'&&parent.object===n&&parent.computed&&parent.property.type==='Identifier'){}
   else if(parent?.type==='CallExpression'&&parent.callee.type==='MemberExpression'&&!parent.callee.computed&&parent.callee.object.name==='Reflect'&&
    parent.callee.property.name==='deleteProperty'&&parent.arguments.length===2&&parent.arguments[0]===n&&parent.arguments[1].type==='Identifier')deletes++;
   else fail('cache_escape');
  }
  if(n.type==='MemberExpression'&&n.object.type==='Identifier'&&n.object.name===cacheName){
   if(parent?.type==='ReturnStatement'&&parent.argument===n)reads++;
   else if(parent?.type==='AssignmentExpression'&&parent.operator==='='&&parent.left===n)writes++;
   else if(parent?.type==='UnaryExpression'&&parent.operator==='delete'&&parent.argument===n)deletes++;
   else fail('cache_effect');
  }
  for(const v of Object.values(n))if(Array.isArray(v))v.forEach(c=>walk(c,n));else if(v&&typeof v==='object')walk(v,n);
 }
 walk(ast,null);
 if(reads!==1||writes<1)fail('cache_lifecycle');
 const hash=s=>createHash('sha256').update(s).digest('hex');
 return {schema:'ssam-odc-client-variable-resolution/1',file,sdkSha256:container.chunkSha256,qualified:true,
  resolverSha256:hash(source.slice(fn.start,fn.end)),cacheSha256:hash(source.slice(cache.start,cache.end)),tokenSha256:token.declarationSha256,
  cacheUses:{reads,writes,deletes},effect:'native-registered-service-read',constructsService:false,
  serviceAvailabilityProven:false,applicationStartupQualified:false,executionAuthorized:false};
}
