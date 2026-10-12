// Bind a generated namespace member to its original SDK declaration. This
// reads source only: neither namespace getters nor initializers are executed.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
const fail=reason=>{throw new Error('debug_odc_sdk_binding_'+reason);};
const name=n=>n?.type==='Identifier'?n.name:n?.type==='Literal'?n.value:null;
export function createOdcSdkBindingReader(files){
 const cache=new Map(),hash=s=>createHash('sha256').update(s).digest('hex');
 function read(file){
  if(!/^_oschunk-[A-Za-z0-9]+\.js$/.test(file)||typeof files[file]!=='string')fail('source');
  if(cache.has(file))return cache.get(file);
  const source=files[file],ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),declarations=new Map(),exports=new Map();
  const add=(key,node)=>{if(declarations.has(key))fail('ambiguous_declaration');declarations.set(key,node);};
  for(const row of ast.body){
   if(row.type==='ExportNamedDeclaration'&&!row.source)for(const spec of row.specifiers)exports.set(name(spec.exported),name(spec.local));
   const node=row.type==='ExportNamedDeclaration'?row.declaration:row;
   if(node?.type==='VariableDeclaration')for(const d of node.declarations)if(d.id.type==='Identifier')add(d.id.name,d.init);
   if(['FunctionDeclaration','ClassDeclaration'].includes(node?.type))add(node.id.name,node);
  }
  const result={source,ast,declarations,exports};cache.set(file,result);return result;
 }
 function resolve(module,local){
  const seen=new Set();let node;
  for(;;){if(seen.has(local))fail('alias_cycle');seen.add(local);node=module.declarations.get(local);
   if(!node)fail('declaration_unresolved');if(node.type!=='Identifier')return {local,node};local=node.name;}
 }
 const describe=(module,file,exported,declaration)=>({file,export:exported,symbol:declaration.local,
  declarationKind:declaration.node.type,chunkSha256:hash(module.source),
  declarationSha256:hash(module.source.slice(declaration.node.start,declaration.node.end)),
  start:declaration.node.start,end:declaration.node.end,sourceBound:true,effectsQualified:false});
 const bind=dependency=>{
  if(!/^\.\/_oschunk-[A-Za-z0-9]+\.js$/.test(dependency?.file??'')||typeof dependency.export!=='string'||typeof dependency.member!=='string')fail('dependency');
  const file=dependency.file.slice(2),module=read(file),exported=module.exports.get(dependency.export);
  if(module.declarations.has(exported)&&module.declarations.get(exported)===null){
   const candidates=module.ast.body.filter(row=>{
    const n=row.expression,arg=n?.arguments?.[0];
    return row.type==='ExpressionStatement'&&n?.type==='CallExpression'&&n.arguments.length===1&&
     arg?.type==='LogicalExpression'&&arg.operator==='||'&&arg.left.type==='Identifier'&&arg.left.name===exported&&
     arg.right.type==='AssignmentExpression'&&arg.right.operator==='='&&arg.right.left.type==='Identifier'&&arg.right.left.name===exported&&
     arg.right.right.type==='ObjectExpression'&&arg.right.right.properties.length===0;
   });
   if(candidates.length!==1)fail('enum_initializer');
   const call=candidates[0].expression,fn=call.callee;
   if(fn.type!=='FunctionExpression'||fn.async||fn.generator||fn.params.length!==1||fn.params[0].type!=='Identifier')fail('enum_initializer');
   const values=new Map();
   const assignment=n=>{
    if(n.type==='SequenceExpression'){n.expressions.forEach(assignment);return;}
    if(n.type!=='AssignmentExpression'||n.operator!=='='||n.left.type!=='MemberExpression'||n.left.computed||
     n.left.object.type!=='Identifier'||n.left.object.name!==fn.params[0].name||n.right.type!=='Literal'||typeof n.right.value!=='string'||
     ['__proto__','prototype','constructor'].includes(n.left.property.name)||values.has(n.left.property.name))fail('enum_initializer');
    values.set(n.left.property.name,n);
   };
   for(const row of fn.body.body){if(row.type!=='ExpressionStatement')fail('enum_initializer');assignment(row.expression);}
   const value=values.get(dependency.member);if(!value)fail('member');
   return {...describe(module,file,dependency.export,{local:exported,node:value.right}),member:dependency.member,
    namespace:exported,namespaceKind:'literal-enum',initializerSha256:hash(module.source.slice(call.start,call.end))};
  }
  const namespace=resolve(module,exported);
  const call=namespace.node;
  if(module.declarations.has('Object')||call.type!=='CallExpression'||call.callee.type!=='MemberExpression'||call.callee.computed||
   call.callee.object.name!=='Object'||call.callee.property.name!=='freeze'||call.arguments.length!==1||call.arguments[0].type!=='ObjectExpression')fail('namespace');
  const properties=call.arguments[0].properties;
  if(properties.some(p=>p.type!=='Property'||p.computed))fail('namespace');
  const rows=properties.filter(p=>name(p.key)===dependency.member);if(rows.length!==1)fail('member');
  const property=rows[0];let target=property.value;
  if(property.kind==='get'){
   if(target.params.length||target.body.body.length!==1||target.body.body[0].type!=='ReturnStatement')fail('getter');
   target=target.body.body[0].argument;
  }else if(property.kind!=='init')fail('member');
  if(target?.type!=='Identifier')fail('member_target');
  const declaration=resolve(module,target.name);
  return {...describe(module,file,dependency.export,declaration),member:dependency.member,namespace:namespace.local};
 };
 // Direct exports (for example the DI container and generated naming helper)
 // are not namespace members. Preserve their exact initializer without running
 // factories, constructors or getters to discover what they return.
 bind.exportDeclaration=dependency=>{
  if(!/^\.\/_oschunk-[A-Za-z0-9]+\.js$/.test(dependency?.file??'')||typeof dependency.export!=='string'||dependency.member!==undefined)fail('dependency');
  const file=dependency.file.slice(2),module=read(file),declaration=resolve(module,module.exports.get(dependency.export));
  return describe(module,file,dependency.export,declaration);
 };
 return bind;
}
