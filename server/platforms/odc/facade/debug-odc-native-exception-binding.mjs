// Match the native debugger frame and breakpoint identities to a complete
// exception model. This binding alone is not a runtime effect qualification.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {indexChunk} from './debug-odc-native-runtime.mjs';
const fail=reason=>{throw new Error('debug_odc_exception_binding_'+reason);};
function walk(n,visit){if(!n||typeof n.type!=='string')return;visit(n);for(const v of Object.values(n))if(Array.isArray(v))v.forEach(c=>walk(c,visit));else if(v&&typeof v==='object')walk(v,visit);}
export function bindOdcExceptionRuntime(source,file,model,moduleKey){
 if(model?.modelQualified!==true||!Array.isArray(model.nodeKeys)||!Array.isArray(model.handlerKeys))fail('model');
 const index=indexChunk(file,source),records=index.records.filter(r=>r.key===model.actionKey&&r.ownerKey===moduleKey);
 if(records.length!==1||records[0].type!=='CLIENT_EXCEPTION_HANDLER'||records[0].holder?.kind!=='getter'||records[0].holder.name!=='handleError')fail('action');
 const action=records[0],ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),methods=[];
 walk(ast,n=>{if(n.start===action.classStart&&['ClassExpression','ClassDeclaration'].includes(n.type))
  methods.push(...n.body.body.filter(m=>m.kind==='get'&&!m.computed&&m.key.name==='handleError'));});
 if(methods.length!==1)fail('holder');
 const calls={push:[],pop:[],handleBreakpoint:[]};
 walk(methods[0],n=>{
  if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&n.callee.object?.name==='OutSystemsDebugger'){
   const method=n.callee.computed?null:n.callee.property.name;
   if(!Object.hasOwn(calls,method)||n.arguments[0]?.type!=='Literal'||typeof n.arguments[0].value!=='string')fail('debugger_call');
   calls[method].push(n.arguments[0].value);
  }
 });
 const frame=moduleKey+':'+model.actionKey;
 if(calls.push.length!==1||!calls.push[0].startsWith(frame+':')||calls.pop.length!==1||calls.pop[0]!==frame)fail('frame');
 const expected=model.nodeKeys.map(k=>moduleKey+':'+k).sort();
 if(JSON.stringify([...calls.handleBreakpoint].sort())!==JSON.stringify(expected))fail('breakpoints');
 for(const key of model.handlerKeys){const candidates=index.records.filter(r=>r.key===key&&r.ownerKey===moduleKey&&r.classStart===action.classStart);
  if(candidates.length!==1||candidates[0].type!=='CLIENT_EXCEPTION_HANDLER')fail('handler');}
 return {schema:'ssam-odc-exception-binding/1',actionKey:model.actionKey,moduleKey,chunk:file,
  chunkSha256:createHash('sha256').update(source).digest('hex'),modelTreeSha256:model.treeSha256,
  nodeKeys:[...model.nodeKeys],nativeFrameBound:true,nativeBreakpointsBound:true,
  runtimeEffectsQualified:false,executionAuthorized:false};
}
