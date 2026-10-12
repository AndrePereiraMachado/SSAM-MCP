// Static evidence for the original exception body. SDK calls remain explicit
// dependencies; matching feedback alone never authorizes application startup.
import {parse} from 'acorn';
import {bindOdcExceptionRuntime} from './debug-odc-native-exception-binding.mjs';
import {indexChunk} from './debug-odc-native-runtime.mjs';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
function walk(n,visit){if(!n||typeof n.type!=='string')return;visit(n);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(c=>walk(c,visit));else if(v&&typeof v==='object')walk(v,visit);}
function member(n){
 if(n?.type==='Identifier')return n.name;
 if(n?.type==='ThisExpression')return 'this';
 if(n?.type==='MemberExpression'&&!n.computed){const base=member(n.object);return base?base+'.'+n.property.name:null;}
 return null;
}
export function inspectOdcExceptionEffects(source,file,model,moduleKey,{files}={}){
 const binding=bindOdcExceptionRuntime(source,file,model,moduleKey);
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=new Map(),calls=[],constructors=[],writes=[],reads=[],feedback=[];
 for(const n of ast.body)if(n.type==='ImportDeclaration')for(const s of n.specifiers)
  imports.set(s.local.name,{file:n.source.value,export:s.imported?.name??(s.type==='ImportDefaultSpecifier'?'default':'*')});
 const record=indexChunk(file,source).records.find(r=>r.key===model.actionKey&&r.ownerKey===moduleKey);
 let getter;walk(ast,n=>{if(n.start===record.classStart&&['ClassDeclaration','ClassExpression'].includes(n.type))getter=n.body.body.find(m=>m.kind==='get'&&m.key.name==='handleError');});
 walk(getter,n=>{
  if(n.type==='MemberExpression'&&n.object.type==='Identifier'&&imports.has(n.object.name)){
   const imported=imports.get(n.object.name);
   reads.push({target:member(n),offset:n.start,dependency:!n.computed?{...imported,member:n.property.name}:null,computed:n.computed});
  }
  if(n.type==='CallExpression'||n.type==='NewExpression'){
   const target=member(n.callee),root=target?.split('.')[0],dependency=imports.get(root);
   const item={target,offset:n.start,dependency:dependency?{...dependency,member:target.slice(root.length+1)}:null};
   (n.type==='CallExpression'?calls:constructors).push(item);
   if(target?.endsWith('.showFeedbackMessage'))feedback.push({target,offset:n.start,
    message:n.arguments[0]?.type==='Literal'?n.arguments[0].value:null,
    type:n.arguments[1]?.type==='Literal'?n.arguments[1].value:null,argumentCount:n.arguments.length});
  }
  if(n.type==='AssignmentExpression'||n.type==='UpdateExpression')writes.push({target:member(n.left??n.argument),operator:n.operator,offset:n.start});
 });
 const expected=(model.effects??[]).filter(e=>e.kind==='feedback');
 // Only Error=3 is currently checked against the published fixture. Other
 // native enum values need independent SDK evidence before being accepted.
 const feedbackMatches=expected.length===feedback.length&&expected.every((e,i)=>e.messageType==='Error'&&
  feedback[i].argumentCount===2&&feedback[i].message===e.messageExpression.slice(1,-1).replaceAll('""','"')&&feedback[i].type===3);
 const dependencies=[...new Map([...calls,...constructors,...reads].filter(c=>c.dependency).map(c=>[JSON.stringify(c.dependency),c.dependency])).values()];
 const unresolvedCalls=[...calls,...constructors].filter(c=>!c.dependency&&!c.target?.startsWith('OutSystemsDebugger.'));
 const bind=files?createOdcSdkBindingReader(files):null;
 const sdkBindings=bind?dependencies.map(dependency=>{
  try{return {resolved:true,...bind(dependency)};}catch(error){return {resolved:false,dependency,
   error:/^debug_odc_sdk_binding_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_sdk_binding_unresolved'};}
 }):undefined;
 return {...binding,schema:'ssam-odc-exception-effects/1',calls,constructors,writes,reads,feedback,feedbackMatches,
  dependencies,unresolvedCalls,...(sdkBindings?{sdkBindings}:{}),runtimeEffectsQualified:false,executionAuthorized:false,
  pending:['sdk-effect-closure','local-call-and-write-closure',...(!feedbackMatches?['feedback-model-mismatch']:[])]};
}
