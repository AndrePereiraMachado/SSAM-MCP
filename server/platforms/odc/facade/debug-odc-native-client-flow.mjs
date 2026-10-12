// Qualify a closed client-only call graph. This is an effect check, not an
// expression evaluator: execution and inspection use the original runtime.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {resolveOdcRuntimeEntry,readOdcRuntimeSources} from './debug-odc-native-assets.mjs';
import {nativeStateAssignments} from './debug-odc-native-client-local.mjs';
const fail=reason=>{throw new Error('debug_odc_native_client_flow_'+reason);};
const sha=s=>createHash('sha256').update(s).digest('hex');
const id=n=>n?.type==='Identifier'?n.name:null;
const prop=n=>n?.type==='MemberExpression'&&!n.computed?n.property.name:null;
const key=n=>n?.type==='Identifier'?n.name:n?.type==='Literal'?n.value:null;
const KEY=/^[A-Za-z0-9_+]{22}$/;
function walk(n,visit){if(!n||typeof n.type!=='string')return;visit(n);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(c=>walk(c,visit));else if(v&&typeof v==='object')walk(v,visit);}
function complete(tree){let count=0;const visit=n=>{if(++count>2500||!Array.isArray(n.children)||n.childrenOmitted||
 Object.keys(n.propertyErrors??{}).length||Object.keys(n.propertiesOmitted??{}).length||n.propertiesMissing?.length||
 Number.isInteger(n.childrenTotal)&&n.childrenTotal!==n.children.length)fail('model_incomplete');n.children.forEach(visit);};visit(tree);}
export function qualifyClientFlowModel(trees,owner,clientVariables,prepared){
 if(!Array.isArray(trees)||trees.length<1||trees.length>16||trees[0].key!==prepared.action.key||
  trees[0].kind!=='ScreenAction'||!owner||owner.childrenOmitted||owner.childrenTotal!==owner.children?.length||
  Object.keys(owner.propertyErrors??{}).length||Object.keys(owner.propertiesOmitted??{}).length||owner.propertiesMissing?.length||
  trees[0].path!==owner.path+'/ScreenAction:'+trees[0].name||!KEY.test(owner.key)||
  new Set(trees.map(t=>t.key)).size!==trees.length)fail('model_target');
 const rootVariables=owner.children.filter(n=>['InputParameter','LocalVariable'].includes(n.kind));
 if(!Array.isArray(clientVariables)||clientVariables.some(v=>v.kind!=='ClientVariable'||!KEY.test(v.key)))fail('client_variables');
 const actions=trees.map((tree,index)=>{
  complete(tree);if(!KEY.test(tree.key)||index&&tree.kind!=='ClientAction')fail('model_target');
  const inputs=tree.children.filter(n=>n.kind==='InputParameter').map(n=>({key:n.key,name:n.name,dataType:n.properties?.DataType?.replace(/^BasicType:/,'').replaceAll(' ','')}));
  if(inputs.some(i=>!['Boolean','Integer','LongInteger','Decimal','Currency','Text','Date','Time','DateTime'].includes(i.dataType))||index&&inputs.length)fail('model_inputs');
  const locals=tree.children.filter(n=>n.kind==='LocalVariable').map(n=>({key:n.key,name:n.name,dataType:n.properties?.DataType?.replace(/^BasicType:/,'').replaceAll(' ','')}));
  if(locals.some(v=>!KEY.test(v.key)||!['Boolean','Integer','LongInteger','Decimal','Currency','Text','Date','Time','DateTime'].includes(v.dataType))||
   new Set([...inputs,...locals].map(v=>v.name)).size!==inputs.length+locals.length)fail('model_locals');
  const nodes=tree.children.filter(n=>!['InputParameter','LocalVariable'].includes(n.kind));
  if(nodes.some(n=>!['StartNode','EndNode','AssignNode','IfNode','ExecuteClientActionNode'].includes(n.kind)||n.properties?.IsDisabled==='True'))fail('model_effect');
  const starts=nodes.filter(n=>n.kind==='StartNode'),visited=new Set(),visiting=new Set();
  if(starts.length!==1)fail('model_flow');
  function traverse(n){if(!n||visiting.has(n.key))fail('model_flow');if(visited.has(n.key))return;visiting.add(n.key);
   const refs=n.kind==='IfNode'?['TrueTarget','FalseTarget']:n.kind==='EndNode'?[]:['Target'];
   for(const ref of refs)traverse(nodes.find(c=>c.key===n.propertyReferences?.[ref]?.key));visiting.delete(n.key);visited.add(n.key);}
  traverse(starts[0]);if(visited.size!==nodes.length)fail('model_flow');
  const calls=[],writes=[];
  for(const n of nodes){
   if(n.kind==='ExecuteClientActionNode'){
    const action=n.propertyReferences?.Action;
    if(action?.kind!=='ClientAction'||!/^ClientAction:[^/]+$/.test(action.path??'')||
      !trees.some(t=>t.key===action.key)||n.children.some(c=>!['ActionConnector'].includes(c.kind)))fail('model_call');
    calls.push(action.key);
   }else if(n.kind==='AssignNode'){
    if(n.children.some(c=>!['Assignment','ActionConnector'].includes(c.kind)))fail('model_effect');
    for(const a of n.children.filter(c=>c.kind==='Assignment')){
     const target=a.properties?.Variable;
     if(typeof target!=='string'||!/^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*$/.test(target))fail('model_write');
     const [root,...fields]=target.split('.');
     if(root==='Client'){
      const variables=clientVariables.filter(v=>v.name===fields[0]);
      if(fields.length!==1||variables.length!==1||/password|token|secret|credential|authorization|^user/i.test(fields[0]))fail('model_identity_write');
      writes.push({client:true,name:fields[0],variableKey:variables[0].key});
     }else{
      const local=locals.find(v=>v.name===root);
      if(local){if(fields.length)fail('model_write');writes.push({local:true,variable:root,variableKey:local.key,fields});continue;}
      const variables=rootVariables.filter(v=>v.name===root);
      if(index||variables.length!==1)fail('model_write');
      writes.push({variable:root,variableKey:variables[0].key,fields});
     }
    }
   }else if(n.children.some(c=>!['ActionConnector','TextBasedExpression'].includes(c.kind)))fail('model_effect');
  }
  return{key:tree.key,name:tree.name,kind:tree.kind,inputs,locals,calls,writes,nodeKeys:nodes.map(n=>n.key),treeSha256:sha(JSON.stringify(tree))};
 });
 const reached=new Set(),stack=new Set();function visit(k){if(stack.has(k))fail('model_recursive');if(reached.has(k))return;stack.add(k);actions.find(a=>a.key===k).calls.forEach(visit);stack.delete(k);reached.add(k);}visit(trees[0].key);
 if(reached.size!==actions.length)fail('model_orphan');
 return{classification:'native-closed-client-flow',actionKey:trees[0].key,kind:'ScreenAction',
  owner:{key:owner.key,path:owner.path,modelTreeSha256:sha(JSON.stringify(owner))},actions,
  modelTreeSha256:sha(JSON.stringify(trees)),clientVariablesSha256:sha(JSON.stringify(clientVariables))};
}
export async function prepareClientFlowModel(tree,owner,readers,prepared){
 const trees=[tree],seen=new Set([tree.key]);
 for(let i=0;i<trees.length;i++)for(const node of trees[i].children.filter(n=>n.kind==='ExecuteClientActionNode')){
  const ref=node.propertyReferences?.Action;
  if(ref?.kind!=='ClientAction'||!/^ClientAction:[^/]+$/.test(ref.path??'')||seen.size>=16)fail('model_call');
  if(!seen.has(ref.key)){seen.add(ref.key);trees.push(await readers.tree('@'+ref.key));}
 }
 return qualifyClientFlowModel(trees,owner,await readers.list('ClientVariable'),prepared);
}
export function qualifyClientFlowRuntime(prepared,runtime,model){
 const plan=resolveOdcRuntimeEntry(prepared,runtime),sources=readOdcRuntimeSources(runtime),asts=new Map();
 const ast=file=>{if(!asts.has(file))asts.set(file,parse(sources[file],{ecmaVersion:'latest',sourceType:'module'}));return asts.get(file);};
 if(model.classification!=='native-closed-client-flow'||plan.view?.key!==model.owner.key||prepared.action.key!==prepared.entry.key||
  prepared.path?.length!==1||plan.member.call||plan.outputs.length||Object.keys(plan.endpoints).length||
  prepared.effects?.length||prepared.producerTarget||prepared.endpointContract||prepared.adapter||prepared.callBoundary?.boundaries?.length||
  prepared.effectEvidence?.some(e=>e.kind!=='ExecuteClientActionNode'||!model.actions.some(a=>a.key===e.actionKey)||e.external||!e.bodyRead)||
  JSON.stringify([...(prepared.runtimeRequestKeys??[])].sort())!==JSON.stringify(model.actions.map(a=>a.key).sort()))fail('entry_effect');
 if(plan.lifecycle){const bindings=plan.member.lifecycleBindings?.filter(b=>b.handler===plan.lifecycle.handler),binding=bindings?.[0]?.binding;
  if(bindings?.length!==1||!['direct','native-cached-event'].includes(binding?.kind)||binding.handler!==plan.lifecycle.handler||
   binding.action!==plan.member.holder.name||binding.contextPreserved!==true||binding.kind==='native-cached-event'&&!bindings[0].helper)fail('lifecycle_binding');}
 const core=Object.entries(runtime.index.chunks).filter(([,c])=>Object.values(c.keepNames).includes('WidgetIdService'));
 if(core.length!==1)fail('core');const coreFile=core[0][0];
 function imported(file,local){const rows=runtime.index.chunks[file].imports.flatMap(i=>i.names.filter(n=>n.local===local).map(n=>({file:i.specifier.replace(/^\.\//,''),local:runtime.index.chunks[i.specifier.replace(/^\.\//,'')]?.exports[n.imported]})));if(rows.length>1)fail('import');return rows[0]??{file,local};}
 function resolve(file,local,seen=new Set()){
  const marker=file+':'+local;if(seen.has(marker))fail('alias');seen.add(marker);
  const imp=imported(file,local);if(imp.file!==file)return resolve(imp.file,imp.local,seen);
  const rows=[];walk(ast(file),n=>{if(n.type==='VariableDeclarator'&&id(n.id)===local)rows.push(n.init);});
  if(rows.length!==1)fail('alias');return id(rows[0])?resolve(file,rows[0].name,seen):{file,node:rows[0]};
 }
 const isCore=(file,local)=>imported(file,local).file===coreFile;
 const storageMethods=new Map();
 function clientStorageAccess(file,receiver,method,action,access){
  // A read-modify-write may use the original getter for the same model-bound
  // client variable. Match its full native body; a matching method name alone
  // cannot admit an arbitrary call or a different storage/authentication service.
  const used=action.writes.filter(w=>w.client&&method===access+w.name);if(!used.length)return null;
  const cache=file+':'+receiver+':'+method;if(storageMethods.has(cache))return storageMethods.get(cache);
  const instance=resolve(file,receiver);if(instance.node?.type!=='NewExpression'||instance.node.arguments.length||!id(instance.node.callee))fail('client_setter');
  const cls=resolve(instance.file,instance.node.callee.name);if(!['ClassExpression','ClassDeclaration'].includes(cls.node.type))fail('client_setter');
  const methods=cls.node.body.body,ctor=methods.find(m=>m.kind==='constructor'),set=methods.filter(m=>key(m.key)===method&&!m.computed);
  const assignment=ctor?.value?.body?.body?.[0]?.expression;
  if(ctor?.value.body.body.length!==1||assignment?.type!=='AssignmentExpression'||assignment.operator!=='='||!id(assignment.left)||
   prop(assignment.right?.callee)!=='resolve'||!isCore(cls.file,id(assignment.right.callee.object))||assignment.right.arguments.length!==1||
   prop(assignment.right.arguments[0])!=='ClientVariablesService'||!isCore(cls.file,id(assignment.right.arguments[0].object))||set.length!==1)fail('client_setter');
  const fn=set[0].value,ret=fn.body.body;
  const call=ret[0]?.argument;
  const writing=access==='set';
  if(fn.params.length!==(writing?1:0)||ret.length!==1||ret[0].type!=='ReturnStatement'||call?.type!=='CallExpression'||
   id(call.callee.object)!==assignment.left.name||prop(call.callee)!==(writing?'setVariable':'getVariable')||call.arguments.length!==(writing?4:3)||
   call.arguments[0].value!==used[0].name||(call.arguments[1].value!==prepared.module&&call.arguments[1].value!==plan.member.ownerName)||
   prop(call.arguments[2]?.object)!=='DataTypes'||!isCore(cls.file,id(call.arguments[2].object.object))||
   writing&&id(call.arguments[3])!==id(fn.params[0]))fail('client_setter');
  storageMethods.set(cache,used[0].name);return used[0].name;
 }
 const proofs=[];
 for(const action of model.actions){
  const members=runtime.index.functions[action.key]??[],candidates=members.filter(m=>m.holder&&!m.nativeProxy);
  if(candidates.length!==1)fail('action_binding');const proxy=candidates[0];
  const implementations=members.filter(m=>m.nativeProxy===proxy.holder.name),body=implementations[0]??proxy;
  if(implementations.length>1||body.call||proxy.call||action.key!==model.actionKey&&(body.holder.kind!=='function'||body.holder.params!==1))fail('action_binding');
  const file=body.chunk,source=sources[file],tree=ast(file),stateWrites=action.writes.filter(w=>!w.client&&!w.local);
  const stateBindings=stateWrites.length?nativeStateAssignments(tree,{owner:model.owner,assignments:stateWrites},plan):[];
  const functions=[];
  for(const member of body===proxy?[body]:[body,proxy]){
   const found=[];walk(tree,n=>{if(member.holder.kind==='function'&&n.type==='FunctionDeclaration'&&id(n.id)===member.holder.local)found.push(n);
    if(['ClassExpression','ClassDeclaration'].includes(n.type)&&n.start===member.classStart)found.push(...n.body.body.filter(m=>m.type==='MethodDefinition'&&!m.computed&&key(m.key)===member.holder.name).map(m=>m.value));});
   if(found.length!==1)fail('method');functions.push({fn:found[0],member,isProxy:member!==body});
  }
  const observedWrites=[],observedCalls=[];
  for(const {fn,member,isProxy} of functions){
   if(fn.params.some(p=>!id(p))||fn.params.length!==action.inputs.length+1)fail('input_abi');
   const context=id(fn.params.at(-1)),aliases=new Map(),bags=new Set(),holders=new Set(),spans=new Set(),allowedNew=new Set(),allowedGroups=new Set(),inputSeen=[];
   const attrs=runtime.index.groups[body.varsGroup]?.filter(g=>g.chunk===file);
   const variables=attrs?.length===1?attrs[0].attributes:[],declared=[...action.inputs,...action.locals];
   if(variables.length!==declared.length||new Set(variables.map(v=>v.attrName)).size!==variables.length||new Set(variables.map(v=>v.name)).size!==variables.length||
    variables.some(v=>declared.filter(d=>d.name===v.name&&d.dataType===v.dataType).length!==1))fail('input_abi');
   const inputs=action.inputs.map(d=>variables.find(v=>v.name===d.name));
   const locals=action.locals.map(d=>variables.find(v=>v.name===d.name));
   walk(fn.body,n=>{
    if(n.type==='FunctionExpression'){if(n.params.length!==1||!id(n.params[0]))fail('callback');spans.add(n.params[0].name);}
    if(n.type!=='VariableDeclarator')return;
    if(!id(n.id))fail('declaration');
    if(n.init?.type==='ObjectExpression'&&!n.init.properties.length){bags.add(n.id.name);return;}
    if(n.init?.object?.type==='ThisExpression'&&['model','controller','idService'].includes(prop(n.init))){aliases.set(n.id.name,prop(n.init));return;}
    const outer=n.init,inner=outer?.arguments?.[0],call=inner?.callee;
    if(isProxy||outer?.type!=='NewExpression'||prop(outer.callee)!=='VariableHolder'||!isCore(file,id(outer.callee.object))||outer.arguments.length!==1||
     inner?.type!=='NewExpression'||inner.arguments.length||call?.type!=='CallExpression'||prop(call.callee)!=='getVariableGroupType'||
     prop(call.callee.object)!=='constructor'||aliases.get(id(call.callee.object.object))!=='controller'||call.arguments.length!==1||call.arguments[0].value!==body.varsGroup)fail('declaration');
    holders.add(n.id.name);allowedNew.add(outer);allowedNew.add(inner);allowedGroups.add(call);
   });
   const input=n=>prop(n?.object)==='value'&&holders.has(id(n.object.object))?inputs.find(a=>a.attrName===prop(n)):null;
   function moduleController(receiver){if(aliases.get(receiver)==='controller')return true;
    if(action.kind!=='ClientAction')return false;
    try{const instance=resolve(file,receiver);if(instance.node.type!=='NewExpression'||instance.node.arguments.length||!id(instance.node.callee))return false;
     const cls=resolve(instance.file,instance.node.callee.name);return prop(cls.node.superClass)==='BaseModuleController'&&isCore(cls.file,id(cls.node.superClass.object))&&
      !cls.node.body.body.some(m=>['callContext','ensureControllerAlive'].includes(key(m.key)));}catch{return false;}}
   walk(fn.body,n=>{
    if(['AwaitExpression','YieldExpression','UpdateExpression','ImportExpression','TaggedTemplateExpression','ArrowFunctionExpression','ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoWhileStatement','WithStatement'].includes(n.type)||
     n.type==='UnaryExpression'&&n.operator==='delete'||n.type==='MemberExpression'&&(n.computed||['__proto__','prototype'].includes(prop(n)))||n.type==='NewExpression'&&!allowedNew.has(n))fail('sidecall');
    if(n.type==='CallExpression'){
     const receiver=id(n.callee?.object),method=prop(n.callee);
     if(allowedGroups.has(n)||receiver==='OutSystemsDebugger'&&['push','pop','handleBreakpoint','handleException'].includes(method)||
      spans.has(receiver)&&['setAttribute','end'].includes(method)||moduleController(receiver)&&['callContext','ensureControllerAlive'].includes(method)||
      isCore(file,receiver)&&['startActiveSpan','integerToDecimal','nullDate'].includes(method))return;
     if(isProxy&&aliases.get(receiver)==='controller'&&method==='safeExecuteClientAction'&&prop(n.arguments[0])===body.holder.name&&id(n.arguments[0].object)===receiver&&
      n.arguments.length===fn.params.length+1&&n.arguments.slice(1).every((a,i)=>id(a)===id(i===0?fn.params.at(-1):fn.params[i-1])))return;
     if(!isProxy&&receiver&&method){
      const access=method.startsWith('set')?'set':method.startsWith('get')?'get':null;
      const target=access&&clientStorageAccess(file,receiver,method,action,access);
      if(target&&n.arguments.length===(access==='set'?1:0)){if(access==='set')observedWrites.push('Client.'+target);return;}
     }
     if(!isProxy&&id(n.callee)){const call=imported(file,id(n.callee));const targets=action.calls.filter(k=>runtime.index.functions[k]?.some(m=>m.holder?.kind==='function'&&m.chunk===call.file&&m.holder.local===call.local));
      if(targets.length===1&&n.arguments.length===1&&id(n.arguments[0])===context){observedCalls.push(targets[0]);return;}}
     fail('sidecall');
    }
    if(n.type!=='AssignmentExpression')return;
    if(n.operator!=='=')fail('write');const left=n.left;
    if(id(left)===context&&prop(n.right.callee)==='callContext'&&moduleController(id(n.right.callee.object))&&n.right.arguments.length===1&&id(n.right.arguments[0])===context)return;
    if(bags.has(id(left.object))&&(['model','idService'].includes(prop(left))&&aliases.get(id(n.right))===prop(left)||prop(left)==='callContext'&&id(n.right)===context||prop(left)==='vars'&&holders.has(id(n.right))))return;
    const parameter=input(left);if(parameter){if(isProxy||id(n.right)!==id(fn.params[inputs.indexOf(parameter)]))fail('input_abi');inputSeen.push(parameter.name);return;}
    const local=prop(left?.object)==='value'&&holders.has(id(left.object.object))?locals.find(v=>v.attrName===prop(left)):null;
    if(local&&!isProxy){observedWrites.push('$local.'+local.name);return;}
    let root=left;while(root?.type==='MemberExpression'&&prop(root.object)!=='variables')root=root.object;
    if(!isProxy&&prop(root?.object)==='variables'&&aliases.get(id(root.object.object))==='model'){
     const bindings=stateBindings.filter(a=>a.attribute===prop(root));if(bindings.length){observedWrites.push(bindings[0].variable);return;}}
    fail('write');
   });
   if(!isProxy&&(inputSeen.length!==inputs.length||new Set(inputSeen).size!==inputs.length))fail('input_abi');
  }
  const expectedWrites=action.writes.map(w=>w.client?'Client.'+w.name:w.local?'$local.'+w.variable:w.variable);
  if(JSON.stringify(observedWrites.sort())!==JSON.stringify(expectedWrites.sort())||JSON.stringify(observedCalls.sort())!==JSON.stringify([...action.calls].sort()))fail('effect_mismatch');
  proofs.push({actionKey:action.key,chunk:file,chunkSha256:runtime.pins[file].sha256,bodySha256:sha(source.slice(functions[0].fn.start,functions[0].fn.end)),writes:observedWrites.length,calls:observedCalls});
 }
 return{schema:'ssam-odc-client-local-plan/1',classification:model.classification,actionKey:model.actionKey,model,
  modelTreeSha256:model.modelTreeSha256,actions:proofs,coreChunk:coreFile,coreChunkSha256:runtime.pins[coreFile].sha256,
  originalEntry:true,serverDebugger:false,invocationNetworkAllowed:false};
}
