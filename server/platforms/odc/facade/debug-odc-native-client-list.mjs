// Effect qualification of original local list flows. Execution, iteration and
// input/output conversion remain in the published OutSystems runtime.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {resolveOdcRuntimeEntry,readOdcRuntimeSources} from './debug-odc-native-assets.mjs';
const fail=reason=>{throw new Error('debug_odc_native_client_list_'+reason);};
const sha=x=>createHash('sha256').update(x).digest('hex');
const id=n=>n?.type==='Identifier'?n.name:null;
const prop=n=>n?.type==='MemberExpression'&&!n.computed?n.property.name:null;
function walk(n,visit){if(!n||typeof n.type!=='string')return;visit(n);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(c=>walk(c,visit));else if(v&&typeof v==='object')walk(v,visit);}
export function qualifyClientListModel(tree,prepared){
 if(tree?.kind!=='ClientAction'||tree.key!==prepared.action.key||prepared.entry.key!==tree.key)fail('model_target');
 let count=0;function complete(n){if(++count>1500||!Array.isArray(n.children)||n.childrenOmitted||n.childrenTotal!==n.children.length||
  Object.keys(n.propertyErrors??{}).length||Object.keys(n.propertiesOmitted??{}).length||n.propertiesMissing?.length)fail('model_incomplete');n.children.forEach(complete);}complete(tree);
 const declarations=tree.children.filter(n=>['InputParameter','OutputParameter'].includes(n.kind));
 const variables=declarations.map(n=>({key:n.key,name:n.name,kind:n.kind,type:n.propertyReferences?.DataType}));
 const nodes=tree.children.filter(n=>!declarations.includes(n));
 if(!variables.length||new Set(variables.map(v=>v.name)).size!==variables.length||nodes.some(n=>!['StartNode','EndNode','ForEachNode','IfNode','ExecuteClientActionNode'].includes(n.kind)||n.properties?.IsDisabled==='True'))fail('model_effect');
 const inputs=variables.filter(v=>v.kind==='InputParameter'),outputs=variables.filter(v=>v.kind==='OutputParameter');
 if(inputs.length!==prepared.action.inputs.length||inputs.some(v=>!prepared.action.inputs.some(i=>i.key===v.key&&i.name===v.name))||
  !outputs.length||outputs.some(v=>v.type?.kind!=='ListType'))fail('model_declarations');
 const loops=nodes.filter(n=>n.kind==='ForEachNode');
 if(loops.length!==1||!inputs.some(v=>v.name===loops[0].properties.RecordList&&v.type?.kind==='ListType'))fail('model_loop');
 const calls=nodes.filter(n=>n.kind==='ExecuteClientActionNode').map(n=>{
  const ref=n.propertyReferences?.Action,args=n.children.filter(c=>c.kind==='Argument');
  if(ref?.kind!=='ClientActionSignature'||!['ListClear','ListAppend'].includes(ref.name)||ref.path!=='Reference:(System)/ClientActionSignature:'+ref.name||
   n.children.some(c=>!['Argument','ActionConnector'].includes(c.kind)))fail('model_call');
  const target=args.find(a=>a.name==='List')?.properties?.Value;
  if(!outputs.some(v=>v.name===target)||args.length!==(ref.name==='ListClear'?1:2)||
   ref.name==='ListAppend'&&args.find(a=>a.name==='Element')?.properties?.Value!==loops[0].properties.RecordList+'.Current')fail('model_arguments');
  return {nodeKey:n.key,signatureKey:ref.key,method:ref.name==='ListClear'?'listClear':'listAppend',target};
 });
 if(!calls.some(c=>c.method==='listAppend')||!calls.some(c=>c.method==='listClear'))fail('model_calls');
 return {classification:'native-local-list-flow',kind:tree.kind,actionKey:tree.key,variables,calls,
  listInput:loops[0].properties.RecordList,nodeKeys:nodes.map(n=>n.key),modelTreeSha256:sha(JSON.stringify(tree))};
}
export function qualifyClientListRuntime(prepared,runtime,model){
 const plan=resolveOdcRuntimeEntry(prepared,runtime),sources=readOdcRuntimeSources(runtime);
 if(model.classification!=='native-local-list-flow'||plan.member.holder?.kind!=='function'||plan.view||plan.member.call||plan.lifecycle||
  Object.keys(plan.endpoints).length||prepared.path?.length!==1||prepared.producerTarget||prepared.endpointContract||prepared.adapter||
  prepared.effects?.some(e=>e!=='unknown-call')||prepared.bindings.some(b=>b.control!=='direct'||b.entryInput!==b.targetInput))fail('entry');
 const signatures=new Set(model.calls.map(c=>c.signatureKey));
 if((prepared.effectEvidence??[]).length!==signatures.size||prepared.effectEvidence.some(e=>!signatures.has(e.actionKey)||e.kind!=='ExecuteClientActionNode')||
  (prepared.callBoundary?.boundaries??[]).some(b=>!signatures.has(b.signatureKey))||
  (prepared.runtimeRequestKeys??[]).some(k=>k!==model.actionKey&&!signatures.has(k)))fail('entry_effects');
 const core=Object.entries(runtime.index.chunks).filter(([,c])=>Object.values(c.keepNames).includes('VariableHolder'));
 if(core.length!==1)fail('core');const [coreFile,coreIndex]=core[0];
 const ast=parse(sources[plan.member.chunk],{ecmaVersion:'latest',sourceType:'module'}),coreAst=parse(sources[coreFile],{ecmaVersion:'latest',sourceType:'module'});
 const fn=ast.body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===plan.member.holder.local);
 if(!fn||fn.params.some(p=>!id(p))||fn.params.length!==plan.inputs.length+1)fail('function');
 const imports=new Map(ast.body.filter(n=>n.type==='ImportDeclaration'&&n.source.value==='./'+coreFile).flatMap(n=>n.specifiers.map(s=>[s.local.name,coreIndex.exports[s.imported?.name]])));
 const coreDeclarations=new Map(),coreFunctions=new Map();walk(coreAst,n=>{if(n.type==='VariableDeclarator'&&id(n.id))coreDeclarations.set(n.id.name,n.init);
  if(n.type==='FunctionDeclaration')coreFunctions.set(n.id.name,n);});
 const nativeMethods=new Map();
 function nativeListMethod(receiver,method){
  const value=coreDeclarations.get(imports.get(receiver));
  const obj=value?.type==='CallExpression'&&prop(value.callee)==='freeze'&&id(value.callee.object)==='Object'?value.arguments[0]:null;
  const field=obj?.type==='ObjectExpression'?obj.properties.find(p=>!p.computed&&(p.key.name??p.key.value)===method):null;
  if(!field||coreIndex.keepNames[id(field.value)]!==method)return false;
  if(nativeMethods.has(method))return true;
  const fn=coreFunctions.get(id(field.value));
  if(!fn||fn.params.length!==(method==='listAppend'?3:2)||fn.params.some(p=>!id(p)))fail('native_list_method');
  const list=fn.params[0].name,item=fn.params[1].name,mutation=method==='listAppend'?'append':'clear';let changes=0;
  walk(fn.body,n=>{
   if(n.type==='AssignmentExpression'||n.type==='UpdateExpression'||n.type==='NewExpression'||n.type==='ImportExpression')fail('native_list_method');
   if(n.type!=='CallExpression')return;
   if(id(n.callee)&&['wrapActionInSpan','getIterationContextOrDefault','validateIterationState','logSystemActionError'].includes(coreIndex.keepNames[id(n.callee)]))return;
   if(id(n.callee.object)===list&&prop(n.callee)===mutation&&n.arguments.length===(mutation==='append'?1:0)&&
    (mutation!=='append'||id(n.arguments[0])===item)){changes++;return;}
   if(method==='listClear'&&prop(n.callee)==='setCurrentRowNumber'&&n.arguments.length===2&&id(n.arguments[0])===list&&n.arguments[1].value===0)return;
   fail('native_list_method');
  });
  if(changes!==1)fail('native_list_method');nativeMethods.set(method,sha(sources[coreFile].slice(fn.start,fn.end)));return true;
 }
 const groups=new Map();for(const group of [plan.member.varsGroup,plan.member.outVarsGroup]){
  const candidates=runtime.index.groups[group]?.filter(g=>g.chunk===plan.member.chunk);
  if(candidates?.length!==1)fail('groups');groups.set(group,candidates[0].attributes);
 }
 const attrs=[...groups.values()].flat();
 if(attrs.length!==model.variables.length||model.variables.some(v=>attrs.filter(a=>a.name===v.name).length!==1)||
  plan.inputs.length!==model.variables.filter(v=>v.kind==='InputParameter').length||plan.outputs.length!==model.variables.filter(v=>v.kind==='OutputParameter').length)fail('signature');
 const ctx=fn.params.at(-1).name,controller=plan.member.moduleController,holders=new Map(),bags=new Set(),spans=new Set(),allowedNew=new Set(),groupCalls=new Set();
 walk(ast,n=>{if(n.type==='AssignmentExpression'&&id(n.left?.object)===controller&&['callContext','constructor'].includes(prop(n.left)))fail('controller_override');});
 walk(fn.body,n=>{
  if(n.type==='FunctionExpression'){if(n.params.length!==1||!id(n.params[0]))fail('callback');spans.add(n.params[0].name);}
  if(n.type!=='VariableDeclarator'||!id(n.id))return;
  if(n.init?.type==='ObjectExpression'&&!n.init.properties.length){bags.add(n.id.name);return;}
  const outer=n.init,inner=outer?.arguments?.[0],call=inner?.callee;
  if(outer?.type==='NewExpression'){
   if(prop(outer.callee)!=='VariableHolder'||!imports.has(id(outer.callee.object))||outer.arguments.length!==1||inner?.type!=='NewExpression'||inner.arguments.length||
    call?.type!=='CallExpression'||prop(call.callee)!=='getVariableGroupType'||prop(call.callee.object)!=='constructor'||id(call.callee.object.object)!==controller||call.arguments.length!==1||!groups.has(call.arguments[0].value))fail('holder');
   holders.set(n.id.name,call.arguments[0].value);allowedNew.add(outer);allowedNew.add(inner);groupCalls.add(call);
  }
 });
 if(holders.size!==2||bags.size!==1||spans.size!==1)fail('containers');
 const variable=n=>prop(n?.object)==='value'&&holders.has(id(n.object.object))?groups.get(holders.get(id(n.object.object))).find(a=>a.attrName===prop(n))?.name:null;
 const inputByParam=new Map(plan.inputs.map(p=>[fn.params[p.position]?.name,p.name]));
 const isList=n=>variable(n)===model.listInput;
 const iteration=n=>prop(n)==='iterationContext'&&id(n.object)===ctx;
 const loops=[];walk(fn.body,n=>{if(n.type==='ForStatement')loops.push(n);});
 if(loops.length!==1)fail('loop');const loop=loops[0],decls=loop.init?.declarations;
 const counter=decls?.find(d=>d.init?.type==='Literal'&&d.init.value===0),iterator=decls?.find(d=>prop(d.init?.callee)==='getIterator');
 if(decls?.length!==2||!id(counter?.id)||!id(iterator?.id)||!iteration(iterator.init.callee.object)||!isList(iterator.init.arguments[0]))fail('iterator');
 const counterName=counter.id.name,iteratorName=iterator.id.name;
 const comparisons=[];walk(loop.test,n=>{if(n.type==='BinaryExpression'&&n.operator==='<')comparisons.push(n);});
 if(comparisons.length!==1||id(comparisons[0].left)!==counterName||prop(comparisons[0].right)!=='length'||!isList(comparisons[0].right.object)||loop.update)fail('loop_bound');
 const calls=[],inputWrites=[],breakpoints=new Set();let increments=0,starts=0,ends=0;
 const current=n=>n?.type==='CallExpression'&&prop(n.callee)==='getItem'&&isList(n.callee.object)&&n.arguments.length===1&&prop(n.arguments[0]?.callee)==='valueOf'&&id(n.arguments[0].callee.object)===counterName;
 walk(fn.body,n=>{
  if(['AwaitExpression','YieldExpression','ImportExpression','TaggedTemplateExpression','ArrowFunctionExpression','ForInStatement','ForOfStatement','WhileStatement','DoWhileStatement','WithStatement','FunctionDeclaration'].includes(n.type)||
   n.type==='UnaryExpression'&&n.operator==='delete'||n.type==='MemberExpression'&&n.computed||n.type==='NewExpression'&&!allowedNew.has(n))fail('runtime_effect');
  if(n.type==='UpdateExpression'){if(n.operator!=='++'||n.prefix||id(n.argument)!==counterName)fail('counter');increments++;}
  if(n.type==='CallExpression'){
   const method=prop(n.callee),receiver=id(n.callee.object);
   if(receiver==='OutSystemsDebugger'&&['push','pop','handleBreakpoint','handleException'].includes(method)){
    if(method==='handleBreakpoint')breakpoints.add(n.arguments[0]?.value?.split(':')[1]);return;
   }
   if(groupCalls.has(n)||spans.has(receiver)&&['setAttribute','end'].includes(method)||receiver===controller&&method==='callContext'||
    imports.has(receiver)&&method==='startActiveSpan'&&n.arguments[0]?.value===prepared.action.name&&n.arguments[1]?.type==='FunctionExpression')return;
   if(method==='clone'&&inputByParam.get(receiver)===model.listInput&&!n.arguments.length)return;
   if(method==='valueOf'&&receiver===counterName&&!n.arguments.length||current(n))return;
   if(iteration(n.callee.object)&&['registerIterationStart','registerIterationEnd','getIterator'].includes(method)&&n.arguments.length===1&&isList(n.arguments[0])){
    if(method==='registerIterationStart')starts++;if(method==='registerIterationEnd')ends++;return;
   }
   if(['listAppend','listClear'].includes(method)&&nativeListMethod(receiver,method)&&n.arguments.length===(method==='listAppend'?3:2)&&id(n.arguments.at(-1))===ctx){
    const target=variable(n.arguments[0]);if(!model.variables.some(v=>v.name===target&&v.kind==='OutputParameter')||method==='listAppend'&&!current(n.arguments[1]))fail('list_arguments');
    calls.push({method,target});return;
   }
   fail('runtime_call');
  }
  if(n.type==='AssignmentExpression'){
   if(n.operator!=='=')fail('assignment');
   if(id(n.left)===ctx&&prop(n.right.callee)==='callContext'&&id(n.right.callee.object)===controller)return;
   if(id(n.left?.object)===iteratorName&&prop(n.left)==='currentRowNumber'&&id(n.right)===counterName)return;
   if(bags.has(id(n.left?.object))&&(prop(n.left)==='callContext'&&id(n.right)===ctx||prop(n.left)==='vars'&&holders.get(id(n.right))===plan.member.varsGroup||prop(n.left)==='outVars'&&holders.get(id(n.right))===plan.member.outVarsGroup))return;
   const target=variable(n.left),declaration=model.variables.find(v=>v.name===target);
   if(declaration?.kind!=='InputParameter')fail('write');
   if(target===model.listInput?prop(n.right.callee)!=='clone'||inputByParam.get(id(n.right.callee.object))!==target:inputByParam.get(id(n.right))!==target)fail('input_binding');inputWrites.push(target);
  }
 });
 if(increments!==1||starts!==1||ends!==1||inputWrites.length!==plan.inputs.length||new Set(inputWrites).size!==plan.inputs.length||
  JSON.stringify(calls)!==JSON.stringify(model.calls.map(({method,target})=>({method,target})))||model.nodeKeys.some(k=>!breakpoints.has(k))||breakpoints.size!==model.nodeKeys.length)fail('body_binding');
 return {schema:'ssam-odc-client-local-plan/1',classification:model.classification,actionKey:model.actionKey,model,
  chunk:plan.member.chunk,chunkSha256:runtime.pins[plan.member.chunk].sha256,coreChunk:coreFile,coreChunkSha256:runtime.pins[coreFile].sha256,
  bodySha256:sha(sources[plan.member.chunk].slice(fn.start,fn.end)),nativeMethods:Object.fromEntries(nativeMethods),originalEntry:true,serverDebugger:false,invocationNetworkAllowed:false};
}
