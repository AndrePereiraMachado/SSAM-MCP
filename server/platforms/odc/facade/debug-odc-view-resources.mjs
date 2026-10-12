// Read generated dependency callbacks without invoking them. A dynamic callback
// is unresolved, never an empty dependency list or permission to fetch a URL.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>{throw new Error('debug_odc_view_resources_'+code);};
export function readOdcViewResources(source,factoryLocal){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});
 const declarations=ast.body.flatMap(n=>n.type==='VariableDeclaration'?n.declarations:[]).filter(d=>d.id.type==='Identifier'&&d.id.name===factoryLocal);
 if(declarations.length!==1)fail('factory');
 const value=declarations[0].init;
 const fn=value?.type==='FunctionExpression'?value:value?.type==='CallExpression'&&value.arguments[0]?.type==='FunctionExpression'?value.arguments[0]:null;
 if(!fn||fn.async||fn.generator||fn.params.length)fail('factory');
 const statements=fn.body.body,ret=statements.at(-1);
 if(ret?.type!=='ReturnStatement'||ret.argument?.type!=='SequenceExpression')fail('return');
 const sequence=ret.argument.expressions,returned=sequence.at(-1);
 if(returned?.type!=='Identifier')fail('component');
 const names={getCssDependencies:'css',getJsDependencies:'js'},result={resolved:true,css:[],js:[],callbackHashes:{},resourcesFetched:false};
 for(const [method,kind] of Object.entries(names)){
  const assignments=sequence.filter(n=>n.type==='AssignmentExpression'&&n.operator==='='&&n.left.type==='MemberExpression'&&!n.left.computed&&n.left.object.type==='Identifier'&&n.left.object.name===returned.name&&n.left.property.name===method);
  if(assignments.length!==1)fail('callback');
  const callback=assignments[0].right;
  if(callback.type!=='FunctionExpression'||callback.async||callback.generator||callback.params.length||callback.body.body.length!==1)fail('dynamic');
  const body=callback.body.body[0];
  if(body.type!=='ReturnStatement'||body.argument?.type!=='ArrayExpression'||body.argument.elements.some(n=>n?.type!=='Literal'||typeof n.value!=='string'||!n.value))fail('dynamic');
  const resources=body.argument.elements.map(n=>n.value);
  if(new Set(resources).size!==resources.length)fail('duplicate');
  result[kind]=resources;result.callbackHashes[method]=hash(source.slice(callback.start,callback.end));
 }
 return result;
}
