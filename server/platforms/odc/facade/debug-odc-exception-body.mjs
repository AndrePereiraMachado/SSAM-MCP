// Qualify generated local effects against the exception model. Native SDK
// dependencies remain explicit; this proof alone never authorizes startup.
import {parse} from 'acorn';
import {inspectOdcExceptionEffects} from './debug-odc-native-exception-effects.mjs';
const fail=reason=>{throw new Error('debug_odc_exception_body_'+reason);};
const id=n=>n?.type==='Identifier'?n.name:null;
const member=n=>n?.type==='MemberExpression'&&!n.computed?n.property.name:null;
function walk(n,visit,parent){if(!n||typeof n.type!=='string')return;visit(n,parent);for(const v of Object.values(n))
 if(Array.isArray(v))v.forEach(c=>walk(c,visit,n));else if(v&&typeof v==='object')walk(v,visit,n);}
export function qualifyOdcExceptionBody(source,file,model,moduleKey,{files}={}){
 const evidence=inspectOdcExceptionEffects(source,file,model,moduleKey,{files});
 if(!evidence.feedbackMatches)fail('feedback');
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=new Map();
 for(const row of ast.body)if(row.type==='ImportDeclaration')for(const s of row.specifiers){
  if(s.type!=='ImportSpecifier')fail('import');imports.set(s.local.name,{file:row.source.value,export:s.imported.name});
 }
 const holders=[];walk(ast,n=>{if(n.type==='MethodDefinition'&&n.kind==='get'&&member({type:'MemberExpression',computed:n.computed,property:n.key})==='handleError')holders.push(n);});
 if(holders.length!==1)fail('getter');
 const getter=holders[0],body=getter.value.body.body,sequence=body[0]?.argument;
 if(body.length!==1||body[0].type!=='ReturnStatement'||sequence?.type!=='SequenceExpression'||sequence.expressions.length!==2)fail('cache');
 const [guard,last]=sequence.expressions,assignment=guard?.right;
 const own=n=>n?.object?.type==='ThisExpression'&&member(n)==='_handleError';
 if(guard.type!=='LogicalExpression'||guard.operator!=='||'||guard.left?.type!=='CallExpression'||
  guard.left.callee?.object?.type!=='ThisExpression'||member(guard.left.callee)!=='hasOwnProperty'||
  guard.left.arguments.length!==1||guard.left.arguments[0].value!=='_handleError'||assignment?.type!=='AssignmentExpression'||assignment.operator!=='='||
  !own(assignment.left)||!own(last)||assignment.right.type!=='FunctionExpression'||assignment.right.params.length!==2||assignment.right.params.some(p=>!id(p)))fail('cache');
 const fn=assignment.right,[exception,context]=fn.params.map(id),bags=new Set(),controllers=new Set(),values=new Set(),spans=new Set(),catches=new Set(),allowedNew=new Set(),parents=new WeakMap();
 const native=(n,exported,name)=>{const i=imports.get(id(n?.object));return member(n)===name&&i?.export===exported&&
  evidence.sdkBindings?.some(b=>b.resolved&&b.file===i.file.slice(2)&&b.export===exported&&b.member===name);};
 walk(fn,(n,parent)=>{
  if(parent)parents.set(n,parent);
  if(n.type==='CatchClause'){if(!id(n.param))fail('catch');catches.add(id(n.param));}
  if(n.type==='FunctionExpression'&&n!==fn){
   if(n.params.length!==1||!id(n.params[0])||parent?.type!=='CallExpression'||parent.arguments[1]!==n||!native(parent.callee,'j','startActiveSpan'))fail('callback');
   spans.add(id(n.params[0]));
  }
  if(n.type!=='VariableDeclarator')return;
  if(!id(n.id)||imports.has(n.id.name))fail('declaration');
  if(n.init?.type==='ObjectExpression'&&!n.init.properties.length){bags.add(n.id.name);return;}
  if(n.init?.object?.type==='ThisExpression'&&member(n.init)==='controller'){controllers.add(n.id.name);return;}
  const outer=n.init,inner=outer?.arguments?.[0];
  if(outer?.type==='NewExpression'&&native(outer.callee,'w','VariableHolder')&&outer.arguments.length===1&&
   inner?.type==='NewExpression'&&native(inner.callee,'w','ErrorHandlerOutputType')&&!inner.arguments.length){
   values.add(n.id.name);allowedNew.add(outer);allowedNew.add(inner);return;
  }
  fail('declaration');
 });
 const regular=[exception,context,...bags,...controllers,...values],locals=[...regular,...spans,...catches];
 if(new Set(regular).size!==regular.length||regular.some(n=>spans.has(n)||catches.has(n))||locals.some(n=>imports.has(n)))fail('shadowing');
 // Minified native code can reuse a span parameter's spelling for a catch
 // parameter in another lexical scope. Resolve that binding before allowing
 // span methods; an exception named like a span must never inherit its calls.
 function scopedRole(name,node){
  for(let owner=node;owner;owner=parents.get(owner)){
   if(owner.type==='CatchClause'&&id(owner.param)===name)return 'catch';
   if(owner.type==='FunctionExpression'&&owner.params.some(p=>id(p)===name))return owner===fn?'entry':'span';
  }
  return null;
 }
 walk(fn,n=>{
  if(['FunctionDeclaration','ArrowFunctionExpression','AwaitExpression','YieldExpression','UpdateExpression','ImportExpression','TaggedTemplateExpression',
   'ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoWhileStatement','WithStatement','ClassExpression','ClassDeclaration'].includes(n.type)||
   n.type==='UnaryExpression'&&n.operator==='delete'||n.type==='NewExpression'&&!allowedNew.has(n)||
   n.type==='MemberExpression'&&(n.computed||['__proto__','prototype','constructor'].includes(member(n)))||
   n.type==='ObjectExpression'&&n.properties.length||n.type==='ArrayExpression')fail('effect');
  if(n.type==='MemberExpression'){
   const root=id(n.object),prop=member(n),imported=imports.get(root);
   const allowed=imported&&evidence.sdkBindings?.some(b=>b.resolved&&b.file===imported.file.slice(2)&&b.export===imported.export&&b.member===prop)||
    root==='OutSystemsDebugger'&&['push','pop','handleBreakpoint'].includes(prop)||scopedRole(root,n)==='span'&&['setAttribute','end'].includes(prop)||
    controllers.has(root)&&prop==='callContext'||root===context&&prop==='id'||bags.has(root)&&prop==='handleAllVar'||values.has(root)&&prop==='value'||
    prop==='exceptionMessageAttr'&&member(n.object)==='value'&&values.has(id(n.object.object))||n.object.type==='ThisExpression'&&prop==='controller';
   if(!allowed)fail('read');
  }
  if(n.type==='AssignmentExpression'){
   if(n.operator!=='=')fail('write');const left=n.left,right=n.right;
   if(id(left)===context&&right.type==='CallExpression'&&controllers.has(id(right.callee.object))&&member(right.callee)==='callContext'&&right.arguments.length===1&&id(right.arguments[0])===context)return;
   if(bags.has(id(left.object))&&member(left)==='handleAllVar'&&values.has(id(right)))return;
   if(member(left)==='exceptionMessageAttr'&&member(left.object)==='value'&&values.has(id(left.object.object))&&
    right.type==='CallExpression'&&native(right.callee,'g','getMessage')&&right.arguments.length===1&&id(right.arguments[0])===exception)return;
   fail('write');
  }
  if(n.type!=='CallExpression')return;
  const receiver=id(n.callee?.object),method=member(n.callee),args=n.arguments;
  if(receiver==='OutSystemsDebugger'&&['push','pop','handleBreakpoint'].includes(method))return;
  if(scopedRole(receiver,n)==='span'&&method==='end'&&!args.length)return;
  if(scopedRole(receiver,n)==='span'&&method==='setAttribute'&&args.length===2&&args.every(a=>a.type==='Literal'&&typeof a.value==='string'))return;
  if(controllers.has(receiver)&&method==='callContext'&&args.length===1&&id(args[0])===context)return;
  if(native(n.callee,'j','startActiveSpan')&&args.length===3&&args[0].type==='Literal'&&typeof args[0].value==='string'&&args[1].type==='FunctionExpression'&&args[2].value===1)return;
  if(['getMessage','isSystem'].some(m=>native(n.callee,'g',m))&&args.length===1&&id(args[0])===exception)return;
  if(native(n.callee,'j','debug')&&args.length===2&&args[0].type==='Literal'&&typeof args[0].value==='string'&&args[1].type==='CallExpression'&&native(args[1].callee,'g','getMessage'))return;
  if(native(n.callee,'t','ignoreError')&&args.length===2&&id(args[0])===exception&&id(args[1])===context)return;
  if(native(n.callee,'t','defaultErrorHandler')&&args.length===2&&scopedRole(id(args[0]),n)==='catch'&&id(args[1])===context)return;
  if(native(n.callee,'u','showFeedbackMessage')&&args.length===2&&args.every(a=>a.type==='Literal'))return;
  fail('call');
 });
 return {...evidence,schema:'ssam-odc-exception-local-body/1',localEffectsQualified:true,
  localEffects:{contextBindings:controllers.size,variableHolders:values.size,debuggerBags:bags.size,spanCallbacks:spans.size},
  pending:['sdk-effect-closure','exception-module-initialization'],runtimeEffectsQualified:false,executionAuthorized:false};
}
