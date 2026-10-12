// Model qualification for a closed graph of original client functions.
// This parses expressions to compare their structure; it never evaluates them.
import {parseExpressionAt} from 'acorn';
import {createHash} from 'node:crypto';
import {resolveOdcRuntimeEntry,readOdcRuntimeSources} from './debug-odc-native-assets.mjs';
import {qualifyScalarClientBody} from './debug-odc-native-client-scalar.mjs';
const fail=reason=>{throw new Error('debug_odc_native_client_functions_'+reason);};
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const KEY=/^[A-Za-z0-9_+]{22}$/;
const NAME=/^[A-Za-z_][A-Za-z0-9_]{0,120}$/;
const declarations=new Set(['InputParameter','OutputParameter','LocalVariable']);
function declaredType(node){
 const type=node.properties?.DataType?.replace(/^BasicType:/,'');
 if(['Integer','Text'].includes(type))return{dataType:type};
 const ref=node.propertyReferences?.DataType;
 if(!ref||!KEY.test(ref.key??'')||!['ListType','Structure'].includes(ref.kind)||
  !node.properties?.DataType?.startsWith(ref.kind+':'))fail('declarations');
 return{dataType:ref.kind==='ListType'?'RecordList':'Record',modelTypeKey:ref.key};
}
const sameType=(a,b)=>a.dataType===b.dataType&&a.modelTypeKey===b.modelTypeKey;
function complete(tree){
 let count=0;
 function visit(n){
  if(++count>1000||!Array.isArray(n.children)||n.childrenOmitted||
   Number.isInteger(n.childrenTotal)&&n.childrenTotal!==n.children.length||
   Object.keys(n.propertyErrors??{}).length||Object.keys(n.propertiesOmitted??{}).length||n.propertiesMissing?.length)
   fail('model_incomplete');
  n.children.forEach(visit);
 }
 visit(tree);
}
function astOf(value){
 if(typeof value!=='string'||value.length>10000)fail('expression');
 let ast;try{ast=parseExpressionAt(value,0,{ecmaVersion:'latest'});}catch{fail('expression');}
 if(value.slice(ast.end).trim())fail('expression');return ast;
}
export function clientFunctionNames(tree){
 complete(tree);const names=new Set();
 function visit(n){if(n?.type==='CallExpression'){
  if(n.optional||n.callee?.type!=='Identifier'||!NAME.test(n.callee.name))fail('call');
  names.add(n.callee.name);
 }
 for(const value of Object.values(n??{}))if(Array.isArray(value))value.forEach(v=>v&&typeof v.type==='string'&&visit(v));
 else if(value&&typeof value.type==='string')visit(value);}
 for(const n of tree.children.filter(n=>n.kind==='AssignNode'))
  for(const a of n.children.filter(n=>n.kind==='Assignment'))visit(astOf(a.properties?.Value));
 return [...names];
}
export function qualifyClientFunctionsModel(trees,prepared){
 if(!Array.isArray(trees)||trees.length<2||trees.length>16||trees[0]?.key!==prepared.action.key||
  prepared.entry.key!==trees[0].key||new Set(trees.map(t=>t.key)).size!==trees.length||
  new Set(trees.map(t=>t.name)).size!==trees.length)fail('target');
 const actions=trees.map((tree,index)=>{
  complete(tree);
  if(tree.kind!=='ClientAction'||!KEY.test(tree.key)||!NAME.test(tree.name)||tree.path!=='ClientAction:'+tree.name||
   index&&tree.properties?.Function!=='True')fail('target');
  const variables=tree.children.filter(n=>declarations.has(n.kind)).map(n=>({
   key:n.key,name:n.name,kind:n.kind,...declaredType(n)
  }));
  if(!variables.length||variables.length>30||new Set(variables.map(v=>v.name)).size!==variables.length||
   variables.some(v=>!KEY.test(v.key)||!NAME.test(v.name)))fail('declarations');
  if(index&&variables.filter(v=>v.kind==='OutputParameter').length!==1)fail('function_output');
  return{key:tree.key,name:tree.name,kind:tree.kind,isFunction:tree.properties?.Function==='True',variables,
   assignments:[],calls:[],modelTreeSha256:sha(tree)};
 });
 function expression(n,action){
  if(n.type==='Identifier'){
   const variable=action.variables.find(v=>v.name===n.name);if(!variable)fail('variable');
   return{variable:n.name,dataType:variable.dataType,...(variable.modelTypeKey?{modelTypeKey:variable.modelTypeKey}:{})};
  }
  if(n.type==='Literal'&&Number.isSafeInteger(n.value))return{literal:n.value,dataType:'Integer'};
  if(n.type==='UnaryExpression'&&['+','-'].includes(n.operator)){
   const value=expression(n.argument,action);if(value.dataType!=='Integer')fail('expression_type');
   return{unary:n.operator,value,dataType:'Integer'};
  }
  if(n.type==='BinaryExpression'&&['+','-','*'].includes(n.operator)){
   const left=expression(n.left,action),right=expression(n.right,action);
   if(left.dataType!=='Integer'||right.dataType!=='Integer')fail('expression_type');
   return{binary:n.operator,left,right,dataType:'Integer'};
  }
  if(n.type==='CallExpression'&&!n.optional&&n.callee.type==='Identifier'){
   const target=actions.find(a=>a.name===n.callee.name);
   if(!target?.isFunction)fail('call');
   const inputs=target.variables.filter(v=>v.kind==='InputParameter'),outputs=target.variables.filter(v=>v.kind==='OutputParameter');
   const args=n.arguments.map(a=>expression(a,action));
   if(outputs.length!==1||args.length!==inputs.length||args.some((a,i)=>!sameType(a,inputs[i])))fail('call_signature');
   action.calls.push(target.key);return{call:target.key,arguments:args,dataType:outputs[0].dataType,
    ...(outputs[0].modelTypeKey?{modelTypeKey:outputs[0].modelTypeKey}:{})};
  }
  fail('expression');
 }
 trees.forEach((tree,index)=>{
  const action=actions[index],nodes=tree.children.filter(n=>!declarations.has(n.kind));
  if(nodes.some(n=>!['StartNode','AssignNode','EndNode'].includes(n.kind)||n.properties?.IsDisabled==='True'))fail('effect');
  const starts=nodes.filter(n=>n.kind==='StartNode'),seen=new Set();if(starts.length!==1)fail('flow');
  let node=starts[0];
  while(node){
   if(seen.has(node.key))fail('flow');seen.add(node.key);
   if(node.kind==='EndNode'){if(node.children.length)fail('flow');break;}
   if(node.children.some(c=>!['ActionConnector','Assignment'].includes(c.kind)))fail('effect');
   for(const a of node.children.filter(c=>c.kind==='Assignment')){
    const target=action.variables.find(v=>v.name===a.properties?.Variable&&v.kind!=='InputParameter');
    if(!target)fail('write');const value=expression(astOf(a.properties?.Value),action);
    if(!sameType(value,target))fail('assignment_type');
    action.assignments.push({variable:target.name,expression:value});
   }
   node=nodes.find(n=>n.key===node.propertyReferences?.Target?.key);if(!node)fail('flow');
  }
  if(seen.size!==nodes.length||!action.assignments.length||action.assignments.length>30)fail('flow');
  action.calls=[...new Set(action.calls)];
 });
 const reached=new Set(),stack=new Set();
 function visit(key){if(stack.has(key))fail('recursive');if(reached.has(key))return;
  stack.add(key);actions.find(a=>a.key===key).calls.forEach(visit);stack.delete(key);reached.add(key);}
 visit(actions[0].key);if(reached.size!==actions.length)fail('orphan');
 return{classification:'native-local-client-functions',actionKey:actions[0].key,kind:'ClientAction',actions,modelTreeSha256:sha(trees)};
}
export async function prepareClientFunctionsModel(tree,readers,prepared){
 const list=await readers.list('ClientAction'),trees=[tree],seen=new Set([tree.key]);
 for(let i=0;i<trees.length;i++)for(const name of clientFunctionNames(trees[i])){
  const rows=list.filter(a=>a.name===name&&a.path==='ClientAction:'+name);
  if(rows.length!==1)fail('call_resolution');const ref=rows[0];
  if(!seen.has(ref.key)){
   if(seen.size>=16)fail('graph_limit');seen.add(ref.key);trees.push(await readers.tree('@'+ref.key));
  }
 }
 return qualifyClientFunctionsModel(trees,prepared);
}

const id=n=>n?.type==='Identifier'?n.name:null;
const prop=n=>n?.type==='MemberExpression'&&!n.computed?n.property.name:null;
function walk(n,visit){if(!n||typeof n.type!=='string')return;visit(n);
 for(const v of Object.values(n))if(Array.isArray(v))v.forEach(c=>walk(c,visit));else if(v&&typeof v==='object')walk(v,visit);}
function untyped(value){if(Array.isArray(value))return value.map(untyped);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['dataType','modelTypeKey'].includes(k)).map(([k,v])=>[k,untyped(v)]));return value;}
function contextId(n,context){return n?.type==='ConditionalExpression'&&n.test?.type==='BinaryExpression'&&n.test.operator==='=='&&
 id(n.test.left)===context&&n.test.right?.type==='Literal'&&n.test.right.value===null&&
 n.consequent?.type==='UnaryExpression'&&n.consequent.operator==='void'&&n.consequent.argument?.value===0&&
 prop(n.alternate)==='id'&&id(n.alternate.object)===context;}

export function qualifyClientFunctionsRuntime(prepared,runtime,model){
 if(model.classification!=='native-local-client-functions'||prepared.action.key!==prepared.entry.key||prepared.path?.length!==1||
  prepared.action.key!==model.actionKey||prepared.effects?.length||prepared.effectEvidence?.length||prepared.producerTarget||
  prepared.endpointContract||prepared.adapter||prepared.callBoundary?.boundaries?.length||
  prepared.bindings?.some(b=>b.control!=='direct'||b.entryInput!==b.targetInput)||
  prepared.runtimeRequestKeys?.some(k=>!model.actions.some(a=>a.key===k)))fail('entry');
 const sources=readOdcRuntimeSources(runtime),plans=new Map();
 for(const action of model.actions){
  const plan=resolveOdcRuntimeEntry({action:{key:action.key},entry:{key:action.key},path:[{key:action.key}],runtimeRequestKeys:[action.key]},runtime);
  if(plan.member.holder?.kind!=='function'||plan.view||plan.member.call||plan.lifecycle||Object.keys(plan.endpoints).length)fail('runtime_entry');
  const inputs=action.variables.filter(v=>v.kind==='InputParameter'),outputs=action.variables.filter(v=>v.kind==='OutputParameter');
  if(inputs.length!==plan.inputs.length||inputs.some((v,i)=>v.name!==plan.inputs[i].name||v.dataType!==plan.inputs[i].dataType)||
   outputs.length!==plan.outputs.length||outputs.some(v=>!plan.outputs.some(o=>o.name===v.name&&o.dataType===v.dataType)))fail('abi');
  plans.set(action.key,plan);
 }
 const proofs=[];
 for(const action of model.actions){
  const plan=plans.get(action.key),used=new Set(),wrappers=new Map();
  const bodyModel={...action,actionKey:action.key,classification:model.classification,assignments:untyped(action.assignments)};
  const proof=qualifyScalarClientBody(action.name,runtime,bodyModel,plan,sources,({fn,ast,nativeImports,context})=>{
   const callbacks=new Set(),calls=new Set();
   function localSymbol(local){
    const imports=runtime.index.chunks[plan.member.chunk].imports??[];
    const rows=imports.flatMap(i=>i.names.filter(n=>n.local===local).map(n=>({file:i.specifier.replace(/^\.\//,''),symbol:runtime.index.chunks[i.specifier.replace(/^\.\//,'')]?.exports?.[n.imported]})));
    if(rows.length>1)fail('runtime_import');return rows[0]??{file:plan.member.chunk,symbol:local};
   }
   walk(fn.body,n=>{
    if(n.type!=='CallExpression'||id(n.callee?.object)!=='OutSystemsDebugger'||prop(n.callee)!=='handleFunctionCall')return;
    const callback=n.arguments[0],ret=callback?.body?.body?.[0],value=ret?.argument,inner=value?.object;
    if(n.arguments.length!==3||callback?.type!=='FunctionExpression'||callback.async||callback.generator||callback.params.length||
     callback.body.body.length!==1||ret.type!=='ReturnStatement'||value?.type!=='MemberExpression'||value.computed||
     inner?.type!=='CallExpression'||!id(inner.callee)||!contextId(n.arguments[2],context))fail('runtime_callback');
    const symbol=localSymbol(id(inner.callee));
    const targets=model.actions.filter(a=>action.calls.includes(a.key)&&plans.get(a.key).member.chunk===symbol.file&&plans.get(a.key).member.holder.local===symbol.symbol);
    if(targets.length!==1)fail('runtime_call');const target=targets[0],targetPlan=plans.get(target.key),out=targetPlan.outputs;
    if(out.length!==1||prop(value)!==out[0].attrName||inner.arguments.length!==targetPlan.inputs.length+1||id(inner.arguments.at(-1))!==context||
     prop(n.arguments[1])!==out[0].dataType||prop(n.arguments[1]?.object)!=='DataTypes'||!nativeImports.has(id(n.arguments[1].object.object)))fail('runtime_call_abi');
    wrappers.set(n,{call:target.key,arguments:inner.arguments.slice(0,-1)});callbacks.add(callback);calls.add(n);calls.add(inner);
   });
   return{callbacks,calls,expression:(n,recurse)=>{
    const found=wrappers.get(n);if(!found)return null;used.add(n);
    return{call:found.call,arguments:found.arguments.map(recurse)};
   }};
  });
  if(used.size!==wrappers.size)fail('runtime_unbound_call');
  proofs.push({...proof,model:undefined,nativeFunctionReturnWrappers:wrappers.size});
 }
 return{schema:'ssam-odc-client-local-plan/1',classification:model.classification,actionKey:model.actionKey,
  modelTreeSha256:model.modelTreeSha256,actions:proofs,model,originalEntry:true,serverDebugger:false,invocationNetworkAllowed:false};
}
