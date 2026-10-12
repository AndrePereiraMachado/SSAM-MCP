// Bind the actual global debugger installation and check its metadata register.
// The generated metadata must contain own data properties, with no replacement
// for hasOwnProperty. This qualifies registration, never variable evaluation.
import {parse} from 'acorn';import {createHash} from 'node:crypto';
const fail=reason=>{throw new Error('debug_odc_debugger_metadata_'+reason);};
const id=n=>n?.type==='Identifier'?n.name:null;
const path=n=>id(n)??(n?.type==='ThisExpression'?'this':n?.type==='MemberExpression'&&!n.computed&&path(n.object)?path(n.object)+'.'+n.property.name:null);
export function qualifyOdcDebuggerMetadata(files){
 const candidates=[];
 for(const [file,source] of Object.entries(files)){
  if(!/^_oschunk-[A-Za-z0-9]+\.js$/.test(file)||typeof source!=='string'||!source.includes('OutSystemsDebugger'))continue;
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),declarations=new Map(),imports=new Set();
  for(const row of ast.body){
   if(row.type==='ImportDeclaration')row.specifiers.forEach(s=>imports.add(s.local.name));
   if(row.type==='VariableDeclaration')for(const d of row.declarations)if(id(d.id)){
    if(declarations.has(d.id.name))fail('ambiguous_declaration');declarations.set(d.id.name,d.init);
   }
   if(['ClassDeclaration','FunctionDeclaration'].includes(row.type))declarations.set(row.id.name,row);
  }
  function visit(n){
   if(!n||!n.type||['ClassExpression','ClassDeclaration','FunctionExpression','FunctionDeclaration','ArrowFunctionExpression'].includes(n.type))return;
   if(n.type==='AssignmentExpression'&&n.operator==='='&&n.left.type==='MemberExpression'&&!n.left.computed&&n.left.property.name==='OutSystemsDebugger')
    candidates.push({file,source,ast,declarations,imports,installation:n});
   for(const v of Object.values(n))if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v);
  }
  ast.body.forEach(visit);
 }
 if(candidates.length!==1)fail('installation');
 const {file,source,declarations,imports,installation}=candidates[0];
 function resolve(symbol){const seen=new Set();let n;while(symbol&&!seen.has(symbol)){seen.add(symbol);n=declarations.get(symbol);if(n?.type!=='Identifier')return n;symbol=n.name;}fail('alias');}
 if(['Map','window','global','globalThis'].some(n=>declarations.has(n)||imports.has(n)))fail('builtin_shadowed');
 const target=id(installation.left.object),global=target?resolve(target):null;
 const condition=global?.test;
 if(global?.type!=='ConditionalExpression'||id(global.consequent)!=='window'||id(global.alternate)!=='global'||
  condition?.type!=='BinaryExpression'||!['!=','!=='].includes(condition.operator)||condition.left.type!=='UnaryExpression'||condition.left.operator!=='typeof'||
  id(condition.left.argument)!=='window'||condition.right.type!=='Literal'||condition.right.value!=='undefined')fail('global');
 const instance=installation.right;
 if(instance.type!=='NewExpression'||instance.arguments.length||!id(instance.callee))fail('instance');
 let cls=resolve(instance.callee.name),methods;const hierarchy=[],seenClasses=new Set();
 while(cls){
  if(!['ClassExpression','ClassDeclaration'].includes(cls.type)||seenClasses.has(cls)||cls.body.body.some(m=>m.type!=='MethodDefinition'||m.computed))fail('class');
  seenClasses.add(cls);hierarchy.push(cls);
  const own=cls.body.body.filter(m=>!m.static&&m.key.name==='registerMetaInfo');
  if(!methods&&own.length){if(own.length!==1||own[0].kind!=='method')fail('method');methods=own;}
  if(cls.superClass&&!id(cls.superClass))fail('class');
  cls=cls.superClass?resolve(cls.superClass.name):null;
 }
 if(!methods)fail('method');
 const fn=methods[0].value;
 if(fn.async||fn.generator||fn.params.length!==1||!id(fn.params[0])||fn.body.body.length!==2)fail('method');
 const parameter=fn.params[0].name,init=fn.body.body[0].expression,loop=fn.body.body[1];
 const field=path(init?.left),assignment=init?.right;
 if(init?.type!=='LogicalExpression'||init.operator!=='||'||!/^this\.[A-Za-z_$][\w$]*$/.test(field??'')||
  assignment?.type!=='AssignmentExpression'||assignment.operator!=='='||path(assignment.left)!==field||assignment.right.type!=='NewExpression'||
  id(assignment.right.callee)!=='Map'||assignment.right.arguments.length)fail('map');
 if(hierarchy.some(c=>c.body.body.some(m=>m.key.name===field.split('.')[1])))fail('map_accessor');
 function referencesMap(n){if(!n||!n.type)return false;
  if(path(n)===field||path(n)==='this.registerMetaInfo'||n.type==='ReturnStatement'||
   n.type==='CallExpression'&&n.callee.type!=='Super'||n.type==='MemberExpression'&&n.computed&&n.object.type==='ThisExpression')return true;
  return Object.values(n).some(v=>Array.isArray(v)?v.some(referencesMap):v&&typeof v==='object'&&referencesMap(v));}
 for(const c of hierarchy){const ctor=c.body.body.find(m=>m.kind==='constructor');if(ctor&&(ctor.value.params.length||referencesMap(ctor.value.body)))fail('map_constructor');}
 if(loop.type!=='ForInStatement'||loop.left.type!=='VariableDeclaration'||loop.left.declarations.length!==1||
  loop.left.declarations[0].init||!id(loop.left.declarations[0].id)||id(loop.right)!==parameter||loop.body.type!=='ExpressionStatement')fail('loop');
 const key=loop.left.declarations[0].id.name,conditions=[];
 function flatten(n){if(n?.type==='LogicalExpression'&&n.operator==='&&'){flatten(n.left);flatten(n.right);}else conditions.push(n);}
 flatten(loop.body.expression);if(conditions.length!==3)fail('conditions');
 const call=(n,target,args)=>n?.type==='CallExpression'&&path(n.callee)===target&&n.arguments.length===args.length&&n.arguments.every((a,i)=>id(a)===args[i]);
 if(!call(conditions[0],parameter+'.hasOwnProperty',[key])||conditions[1]?.type!=='UnaryExpression'||conditions[1].operator!=='!'||
  !call(conditions[1].argument,field+'.get',[key]))fail('guards');
 const store=conditions[2],value=store?.arguments?.[1];
 if(store?.type!=='CallExpression'||path(store.callee)!==field+'.set'||store.arguments.length!==2||id(store.arguments[0])!==key||
  value?.type!=='MemberExpression'||!value.computed||id(value.object)!==parameter||id(value.property)!==key)fail('store');
 const hash=s=>createHash('sha256').update(s).digest('hex');
 return {schema:'ssam-odc-debugger-metadata/1',file,sourceSha256:hash(source),installationSha256:hash(source.slice(installation.start,installation.end)),
  methodSha256:hash(source.slice(methods[0].start,methods[0].end)),hierarchySha256:hierarchy.map(c=>hash(source.slice(c.start,c.end))),qualified:true,effect:'native-metadata-map-storage',
  requiredInput:'own-data-properties-with-original-hasOwnProperty',applicationStartupQualified:false,executionAuthorized:false};
}
