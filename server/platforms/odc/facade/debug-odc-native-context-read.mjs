// Closed, original screen -> client -> server context reads. Model-only checks;
// all execution and values remain in the published OutSystems runtime.
import {createHash} from 'node:crypto';
import {resolveOdcRuntimeEntry} from './debug-odc-native-assets.mjs';
import {nativeBuiltin,qualifyIdentityWitnesses} from './debug-identity-witness.mjs';
const fail=()=>{throw new Error('debug_odc_native_context_read_unqualified');};
const ref=(n,p)=>n.propertyReferences?.[p]?.key;
const declarations=new Set(['InputParameter','OutputParameter','LocalVariable']);
function complete(tree){
 let count=0;
 function visit(n){if(++count>1500||!n?.key||!Array.isArray(n.children)||n.childrenOmitted||
  n.childrenTotal!==undefined&&n.childrenTotal!==n.children.length||Object.keys(n.propertyErrors??{}).length||
  Object.keys(n.propertiesOmitted??{}).length||n.propertiesMissing?.length)fail();n.children.forEach(visit);}
 visit(tree);
}
function scalar(v){
 const type=v.propertyReferences?.DataType;
 if(v.properties?.DataType==='BasicType:Integer'||v.properties?.DataType==='BasicType:Boolean')return;
 if(type?.kind==='IdentifierType'&&type.path?.startsWith('Reference:(System)/ServerEntitySignature:User/'))return;
 fail();
}
function chain(tree){
 const nodes=tree.children.filter(n=>n.kind.endsWith('Node')),starts=nodes.filter(n=>n.kind==='StartNode');
 if(starts.length!==1||tree.children.some(n=>!declarations.has(n.kind)&&
  !['StartNode','AssignNode','EndNode','ExecuteClientActionNode','ExecuteServerActionNode'].includes(n.kind)))fail();
 const seen=new Set(),ordered=[];let n=starts[0];
 while(n){
  if(seen.has(n.key)||n.properties?.IsDisabled==='True')fail();seen.add(n.key);ordered.push(n);
  const links=n.children.filter(c=>c.kind==='ActionConnector');
  if(n.kind==='EndNode'){if(n.children.length||ref(n,'Target'))fail();break;}
  const childKind=n.kind==='AssignNode'?'Assignment':n.kind.startsWith('Execute')?'Argument':null;
  if(n.children.some(c=>c.kind!=='ActionConnector'&&c.kind!==childKind)||links.length!==1||links[0].children.length||ref(links[0],'Target')!==ref(n,'Target'))fail();
  n=nodes.find(c=>c.key===ref(n,'Target'));if(!n)fail();
 }
 if(ordered.at(-1)?.kind!=='EndNode'||seen.size!==nodes.length)fail();return ordered;
}
export function qualifyContextReadModel({prepared,trees,owner,nativeBindings,sourceSha256,moduleKey}){
 if(trees.length!==3||nativeBindings.length!==3||prepared.producerTarget||prepared.endpointContract||prepared.adapter||
  prepared.entry.kind!=='ScreenAction'||prepared.action.kind!=='ServerAction'||prepared.effects.length||prepared.path.length!==3||
  trees.map(t=>t.kind).join(',')!=='ScreenAction,ClientAction,ServerAction'||owner.kind!=='MobileScreen'||
  trees[0].path!==owner.path+'/ScreenAction:'+trees[0].name||prepared.entry.key!==trees[0].key||prepared.action.key!==trees[2].key||
  prepared.path.some((p,i)=>p.key!==trees[i].key)||new Set(trees.map(t=>t.key)).size!==3||
  prepared.runtimeRequestKeys.length!==3||prepared.runtimeRequestKeys.some(k=>!trees.some(t=>t.key===k)))fail();
 trees.forEach(complete);complete(owner);
 const ownerVars=owner.children.filter(n=>declarations.has(n.kind)),usedOwner=new Set(),functionCalls=[],calls=[];
 for(let i=0;i<trees.length;i++){
  const tree=trees[i],flow=chain(tree),vars=tree.children.filter(n=>declarations.has(n.kind));vars.forEach(scalar);
  const next=trees[i+1],invocations=flow.filter(n=>n.kind.startsWith('Execute'));
  if(invocations.length!==(next?1:0)||next&&ref(invocations[0],'Action')!==next.key||
   next&&invocations[0].kind!==(i===0?'ExecuteClientActionNode':'ExecuteServerActionNode'))fail();
  if(i===0&&vars.some(v=>v.kind==='InputParameter'))fail();
  const binding=nativeBindings[i];
  if(binding?.available!==true||binding.authority!=='installed-model-expression-tree'||binding.runtimeValuesEvaluated!==false||
   binding.identity?.moduleKey!==moduleKey||binding.identity?.functionKey!==tree.key||binding.identity?.sourceSha256!==sourceSha256||
   !Array.isArray(binding.expressions))fail();
  const native=new Map(binding.expressions.map(e=>[e.key,e.root]));if(native.size!==binding.expressions.length)fail();
  const expected=new Set(),allowed=new Set(vars.map(v=>v.key)),writable=new Set(vars.filter(v=>v.kind!=='InputParameter').map(v=>v.key));
  for(const variable of ownerVars){allowed.add(variable.key);if(variable.kind==='LocalVariable')writable.add(variable.key);}
  if(next){allowed.add(invocations[0].key);for(const v of next.children.filter(n=>n.kind==='OutputParameter'))allowed.add(v.key);}
  function expression(n){
   if(n.kind!=='TextBasedExpression'||n.children.length||!native.has(n.key))fail();expected.add(n.key);
   function inspect(root,depth=0){
    if(depth>40||!root||!['Identifier','FieldAccess','BinaryOperation','UnaryOperation','IntegerLiteral','BooleanLiteral','FunctionCall','ParenthesizedExpression'].includes(root.kind)||
     !Array.isArray(root.usedObjects)||!Array.isArray(root.children)||root.usedObjects.some(o=>!allowed.has(o.key)))fail();
    for(const object of root.usedObjects){const variable=ownerVars.find(v=>v.key===object.key);if(variable){scalar(variable);usedOwner.add(variable.key);}}
    if(root.functionCall!== (root.kind==='FunctionCall'))fail();
    if(root.functionCall){const name=nativeBuiltin(root,['GetUserId','NullTextIdentifier']);if(!name)fail();functionCalls.push({actionKey:tree.key,name});}
    root.children.forEach(c=>inspect(c,depth+1));
   }
   const root=native.get(n.key);inspect(root);return root;
  }
  for(const node of flow){
   for(const a of node.children.filter(c=>c.kind==='Assignment')){
    if(a.children.length!==2||!['Variable','Value'].every(f=>a.children.some(e=>e.key===a.key+'.#'+f&&e.name===a.properties?.[f])))fail();
    const destination=expression(a.children.find(e=>e.key===a.key+'.#Variable'));expression(a.children.find(e=>e.key===a.key+'.#Value'));
    if(destination.kind!=='Identifier'||destination.usedObjects.length!==1||!writable.has(destination.usedObjects[0].key))fail();
   }
   for(const arg of node.children.filter(c=>c.kind==='Argument')){
    if(arg.children.length!==1||arg.children[0].key!==arg.key+'.#Value'||arg.children[0].name!==arg.properties?.Value)fail();expression(arg.children[0]);
   }
   if(node.kind.startsWith('Execute')){
    const inputs=next.children.filter(c=>c.kind==='InputParameter'),args=node.children.filter(c=>c.kind==='Argument');
    if(args.length!==inputs.length||new Set(args.map(a=>ref(a,'Parameter'))).size!==args.length||args.some(a=>!inputs.some(v=>v.key===ref(a,'Parameter'))))fail();
    calls.push({kind:node.kind,actionKey:next.key});
   }
  }
  // Defaults are part of the original flow and must also be native, scalar literals.
  for(const v of vars)for(const e of v.children){if(e.kind!=='TextBasedExpression'||e.key!==v.key+'.#DefaultValue')fail();const root=expression(e);if(!['IntegerLiteral','BooleanLiteral'].includes(root.kind))fail();}
  if(expected.size!==native.size||[...native.keys()].some(k=>!expected.has(k)))fail();
 }
 for(const v of ownerVars.filter(v=>usedOwner.has(v.key)))if(v.properties?.DefaultValue!==undefined&&v.properties.DefaultValue!==''&&
  !/^(?:-?\d+|True|False)$/.test(v.properties.DefaultValue))fail();
 if(prepared.effectEvidence.length!==calls.length||calls.some((c,i)=>prepared.effectEvidence[i]?.actionKey!==c.actionKey||prepared.effectEvidence[i]?.kind!==c.kind||prepared.effectEvidence[i]?.external===true))fail();
 if(!functionCalls.some(c=>c.actionKey===trees[1].key&&c.name==='GetUserId')||!functionCalls.some(c=>c.actionKey===trees[2].key&&c.name==='GetUserId'))fail();
 // Identity is delegated to the generic native witness qualifier: every GetUserId() assigned to a client/server
 // declaration is a user-id witness, and each of the two actions needs one. The refusals above stay as they were.
 const declared=[];
 for(const i of [1,2]){const tree=trees[i],native=new Map(nativeBindings[i].expressions.map(e=>[e.key,e.root]));
  for(const node of tree.children.filter(n=>n.kind==='AssignNode'))for(const a of node.children.filter(c=>c.kind==='Assignment')){
   const variable=native.get(a.key+'.#Variable').usedObjects[0].key;
   if(nativeBuiltin(native.get(a.key+'.#Value'))&&tree.children.some(v=>v.key===variable&&declarations.has(v.kind)))
    declared.push({id:'context:'+a.key,kind:'user-id',moduleKey,functionKey:tree.key,nodeKey:node.key,variable,sourceSha256});}}
 const witnesses=qualifyIdentityWitnesses(declared,[{moduleKey,sourceSha256,kind:'consumer',trees}],nativeBindings);
 if(witnesses.refused.length||[1,2].some(i=>!witnesses.qualified.some(w=>w.functionKey===trees[i].key)))fail();
 return {schema:'ssam-odc-context-read-model/1',classification:'native-user-context-read',entryKey:trees[0].key,actionKey:trees[2].key,
  ownerKey:owner.key,sourceSha256,moduleKey,functionKeys:trees.map(t=>t.key),calls,functionCalls,identityWitnesses:witnesses.qualified,writesBusinessData:false,
  modelTreeSha256:createHash('sha256').update(JSON.stringify({trees,owner,nativeBindings})).digest('hex'),rolesProved:false};
}
export function qualifyContextReadRuntime(prepared,plan,model,binding,runtime){
 const server=resolveOdcRuntimeEntry({...prepared,entry:prepared.action,path:[prepared.action],runtimeRequestKeys:[prepared.action.key]},runtime);
 if(model.classification!=='native-user-context-read'||plan.member.key!==model.entryKey||plan.invocation!=='screen-action'||plan.inputs.length||plan.lifecycle||
  plan.view?.key!==model.ownerKey||plan.screen?.key!==model.ownerKey||server.member.call?.kind!=='server-action'||
  Object.keys(plan.endpoints).length!==1||!Object.hasOwn(plan.endpoints,server.member.call.endpoint)||
  !/^screenservices\/[A-Za-z0-9_/]+$/.test(server.member.call.endpoint))fail();
 return {...model,endpoint:new URL(server.member.call.endpoint,binding.runtimeUrl).pathname,
  generatedEndpoint:server.member.call.endpoint,apiVersion:server.member.call.apiVersion};
}
