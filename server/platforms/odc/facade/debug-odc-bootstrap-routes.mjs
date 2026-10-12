import {parse} from 'acorn';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
const core='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d';
const id=n=>n?.type==='Identifier'?n.name:null;
const literal=(n,value)=>n?.type==='Literal'&&n.value===value;
const member=(n,object,key)=>n?.type==='MemberExpression'&&!n.computed&&id(n.object)===object&&n.property.name===key;
const bool=n=>n?.type==='Literal'&&typeof n.value==='boolean'?n.value:n?.type==='UnaryExpression'&&n.operator==='!'&&n.argument.type==='Literal'&&[0,1].includes(n.argument.value)?!n.argument.value:undefined;
export function qualifyOdcBootstrapRoutes(files,bootstrapFile,routesLocal){
 const fail=code=>{throw new Error('debug_odc_bootstrap_routes_'+code);};
 const ast=parse(files[bootstrapFile],{ecmaVersion:'latest',sourceType:'module'}),declarations=new Map(),imports=new Map(),protectedNames=new Set([routesLocal]);
 for(const row of ast.body){
  if(row.type==='FunctionDeclaration')declarations.set(row.id.name,row);
  if(row.type==='VariableDeclaration')for(const d of row.declarations)if(id(d.id))declarations.set(d.id.name,d.init);
  if(row.type==='ImportDeclaration')for(const s of row.specifiers)if(s.type==='ImportSpecifier')imports.set(s.local.name,{file:row.source.value,export:s.imported.name});
 }
 const bind=createOdcSdkBindingReader(files);
 function properties(n,keys){
  if(n?.type!=='ObjectExpression'||n.properties.length!==keys.length)fail('properties');
  const map=new Map();for(const p of n.properties){if(p.type!=='Property'||p.computed||!keys.includes(p.key.name)||map.has(p.key.name))fail('properties');map.set(p.key.name,p);}
  return map;
 }
 function pathHelper(name){
  protectedNames.add(name);const fn=declarations.get(name),param=id(fn?.params?.[0]);
  if(fn?.type!=='FunctionDeclaration'||fn.async||fn.generator||fn.params.length!==1||!param||fn.body.body.length!==2)fail('path_helper');
  const [statement,returned]=fn.body.body,d=statement.declarations?.[0],local=id(d?.id),call=d?.init;
  if(statement.type!=='VariableDeclaration'||statement.declarations.length!==1||!local||local===param||call?.type!=='CallExpression'||call.arguments.length||
   call.callee.type!=='MemberExpression'||call.callee.computed||call.callee.property.name!=='getBasePath'||!imports.has(id(call.callee.object)))fail('base_path');
  if([param,local].includes(id(call.callee.object)))fail('shadowed_sdk');
  const importedBase=imports.get(id(call.callee.object));
  const dependency=bind({...importedBase,member:'getBasePath'});if(dependency.chunkSha256!==core)fail('sdk');
  const canonicalBase=bind({file:importedBase.file,export:'l',member:'getBasePath'});
  if(dependency.declarationSha256!==canonicalBase.declarationSha256)fail('base_path_binding');
  const sequence=returned.argument;
  if(returned.type!=='ReturnStatement'||sequence?.type!=='SequenceExpression'||sequence.expressions.length!==2)fail('path_helper');
  const [trim,choose]=sequence.expressions,replace=trim.right;
  if(trim.type!=='AssignmentExpression'||trim.operator!=='='||id(trim.left)!==local||replace?.type!=='CallExpression'||
   !member(replace.callee,local,'replace')||replace.arguments.length!==2||replace.arguments[0].regex?.pattern!=='\\/$'||replace.arguments[0].regex.flags!==''||!literal(replace.arguments[1],''))fail('trim');
  const joined=choose.consequent;
  if(choose.type!=='ConditionalExpression'||id(choose.test)!==param||id(choose.alternate)!==local||joined?.type!=='BinaryExpression'||joined.operator!=='+'||id(joined.right)!==param||
   joined.left.type!=='BinaryExpression'||joined.left.operator!=='+'||id(joined.left.left)!==local||!literal(joined.left.right,'/'))fail('path_join');
 }
 const array=declarations.get(routesLocal);if(array?.type!=='ArrayExpression'||!array.elements.length)fail('array');
 const routes=array.elements.map(element=>{
  const props=properties(element,['pathname','screenName','forDefaultPath','lazyComponentInfo']);
  const pathname=props.get('pathname'),getter=pathname.value;
  if(pathname.kind!=='get'||getter.params.length||getter.async||getter.generator||getter.body.body.length!==1||getter.body.body[0].type!=='ReturnStatement')fail('getter');
  const call=getter.body.body[0].argument;
  if(call?.type!=='CallExpression'||!id(call.callee)||call.arguments.length>1||call.arguments.some(a=>a.type!=='Literal'||typeof a.value!=='string'||! /^[A-Za-z0-9_-]+$/.test(a.value)))fail('path');
  pathHelper(id(call.callee));
  for(const key of ['screenName','forDefaultPath','lazyComponentInfo'])if(props.get(key).kind!=='init'||props.get(key).method)fail('property_kind');
  const screen=props.get('screenName').value,defaultPath=bool(props.get('forDefaultPath').value);
  if(screen.type!=='Literal'||typeof screen.value!=='string'||defaultPath===undefined||defaultPath!==(call.arguments.length===0))fail('screen');
  const lazy=properties(props.get('lazyComponentInfo').value,['shallSaveStateOnLeave','importer']);
  if([...lazy.values()].some(p=>p.kind!=='init'||p.method)||bool(lazy.get('shallSaveStateOnLeave').value)===undefined)fail('lazy');
  const named=lazy.get('importer').value,helper=imports.get(id(named?.callee)),fn=named?.arguments?.[0];
  if(named?.type!=='CallExpression'||!helper||named.arguments.length!==2||!literal(named.arguments[1],'importer')||fn?.type!=='FunctionExpression'||fn.params.length||fn.async||fn.generator||fn.body.body.length!==1||fn.body.body[0].type!=='ReturnStatement')fail('importer');
  const nameHelper=bind.exportDeclaration(helper);if(nameHelper.chunkSha256!==core)fail('sdk');
  const canonicalHelper=bind.exportDeclaration({file:helper.file,export:'a'});
  if(nameHelper.declarationSha256!==canonicalHelper.declarationSha256)fail('name_helper_binding');
  const dynamic=fn.body.body[0].argument;
  if(dynamic?.type!=='ImportExpression'||dynamic.source.type!=='Literal'||!/^\.\/_oschunk-[A-Za-z0-9]+\.js$/.test(dynamic.source.value)||typeof files[dynamic.source.value.slice(2)]!=='string')fail('import');
  return {screenName:screen.value,defaultPath,segment:call.arguments[0]?.value??'',chunk:dynamic.source.value.slice(2)};
 });
 function writes(n){if(!n||typeof n!=='object')return;
  if(n.type==='AssignmentExpression'&&protectedNames.has(id(n.left))||n.type==='UpdateExpression'&&protectedNames.has(id(n.argument)))fail('reassigned_binding');
  for(const v of Object.values(n))if(Array.isArray(v))v.forEach(writes);else if(v&&typeof v==='object')writes(v);
 }writes(ast);
 return {routeExpressionsQualified:true,routes,nativeEffects:['base-path-read','relative-chunk-import'],applicationStartupQualified:false,executionAuthorized:false};
}
