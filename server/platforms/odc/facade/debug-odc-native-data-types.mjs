// Read the native numeric enum used by generated metadata. No enum initializer
// or namespace getter is executed to discover these primitive constants.
import {parse} from 'acorn';import {createHash} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
const fail=reason=>{throw new Error('debug_odc_data_types_'+reason);};
export function qualifyOdcNativeDataTypes(files,{file,exported}){
 const binding=createOdcSdkBindingReader(files).exportDeclaration({file:'./'+file,export:exported});
 const source=files[file],ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),declarations=new Map();
 for(const row of ast.body)if(row.type==='VariableDeclaration')for(const d of row.declarations)if(d.id.type==='Identifier')declarations.set(d.id.name,d.init);
 const ns=declarations.get(binding.symbol);
 if(declarations.has('Object')||ns?.type!=='CallExpression'||ns.callee.type!=='MemberExpression'||ns.callee.computed||
  ns.callee.object.name!=='Object'||ns.callee.property.name!=='freeze'||ns.arguments.length!==1||ns.arguments[0].type!=='ObjectExpression')fail('namespace');
 const properties=ns.arguments[0].properties;if(properties.some(p=>p.type!=='Property'||p.computed))fail('namespace');
 const entries=properties.filter(p=>(p.key.name??p.key.value)==='DataTypes');if(entries.length!==1)fail('namespace');
 const entry=entries[0];let reference=entry.value;
 if(entry.kind==='get'){
  if(reference.async||reference.generator||reference.params.length||reference.body.body.length!==1||reference.body.body[0].type!=='ReturnStatement')fail('getter');
  reference=reference.body.body[0].argument;
 }else if(entry.kind!=='init')fail('namespace');
 if(reference?.type!=='Identifier'||!declarations.has(reference.name)||declarations.get(reference.name)!==null)fail('enum');
 const symbol=reference.name,candidates=ast.body.filter(row=>{
  const call=row.expression,arg=call?.arguments?.[0];return row.type==='ExpressionStatement'&&call?.type==='CallExpression'&&call.arguments.length===1&&
   arg?.type==='LogicalExpression'&&arg.operator==='||'&&arg.left.type==='Identifier'&&arg.left.name===symbol&&
   arg.right.type==='AssignmentExpression'&&arg.right.operator==='='&&arg.right.left.type==='Identifier'&&arg.right.left.name===symbol&&
   arg.right.right.type==='ObjectExpression'&&arg.right.right.properties.length===0;
 });
 if(candidates.length!==1)fail('initializer');
 const call=candidates[0].expression,fn=call.callee;
 if(fn.type!=='FunctionExpression'||fn.async||fn.generator||fn.params.length!==1||fn.params[0].type!=='Identifier')fail('initializer');
 const target=fn.params[0].name,types={},numbers=new Set();
 function assignment(n){
  if(n.type==='SequenceExpression'){n.expressions.forEach(assignment);return;}
  const outer=n.left,inner=outer?.property,field=inner?.left;
  if(n.type!=='AssignmentExpression'||n.operator!=='='||outer?.type!=='MemberExpression'||!outer.computed||outer.object.name!==target||
   inner?.type!=='AssignmentExpression'||inner.operator!=='='||field?.type!=='MemberExpression'||field.computed||field.object.name!==target||
   n.right.type!=='Literal'||n.right.value!==field.property.name||inner.right.type!=='Literal'||!Number.isSafeInteger(inner.right.value)||inner.right.value<0||
   ['__proto__','prototype','constructor'].includes(field.property.name)||Object.hasOwn(types,field.property.name)||numbers.has(inner.right.value))fail('enum_assignment');
  types[field.property.name]=inner.right.value;numbers.add(inner.right.value);
 }
 for(const row of fn.body.body){if(row.type!=='ExpressionStatement')fail('initializer');assignment(row.expression);}
 if(!Object.keys(types).length)fail('enum');
 return {schema:'ssam-odc-native-data-types/1',file,export:exported,sdkSha256:binding.chunkSha256,types,qualified:true,
  initializerSha256:createHash('sha256').update(source.slice(call.start,call.end)).digest('hex'),
  effect:'native-numeric-enum-read',applicationStartupQualified:false,executionAuthorized:false};
}
