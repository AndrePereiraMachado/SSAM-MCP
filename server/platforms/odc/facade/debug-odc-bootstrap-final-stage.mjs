// Recognize the original final bootstrap stage without running callbacks.
// Native post-initialization, exception registration and View.load stay intact.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {createOdcSdkBindingReader} from './debug-odc-native-sdk-binding.mjs';
import {inspectOdcNativeViewLoader} from './debug-odc-view-loader.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>{throw new Error('debug_odc_bootstrap_final_'+code);};
const id=n=>n?.type==='Identifier'?n.name:null;
const path=n=>id(n)??(n?.type==='MemberExpression'&&!n.computed&&path(n.object)?path(n.object)+'.'+n.property.name:null);
const expressions=n=>n?.type==='SequenceExpression'?n.expressions:[n];
export function inspectOdcBootstrapFinalStage(source){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),imports=new Map(),parents=new Map(),candidates=[];
 for(const row of ast.body)if(row.type==='ImportDeclaration')for(const s of row.specifiers){
  if(s.type!=='ImportSpecifier')fail('import');imports.set(s.local.name,{file:row.source.value,export:s.imported.name});
 }
 function walk(n,parent){if(!n||typeof n.type!=='string')return;parents.set(n,parent);
  if(n.type==='CallExpression'&&id(n.callee)&&n.arguments[0]?.type==='ObjectExpression'&&
   n.arguments[0].properties.some(p=>p.key?.name==='initType'))candidates.push(n);
  for(const v of Object.values(n))if(Array.isArray(v))v.forEach(c=>walk(c,n));else if(v&&typeof v==='object')walk(v,n);
 }
 walk(ast);if(candidates.length!==1)fail('post_initialization');
 const post=candidates[0],options=post.arguments[0];
 if(post.arguments.length!==1||options.properties.length!==1)fail('options');
 const prop=options.properties[0],initPath=path(prop.value)?.split('.');
 if(prop.type!=='Property'||prop.kind!=='init'||prop.computed||prop.method||prop.key.name!=='initType'||
  initPath?.length!==4||initPath.slice(1).join('.')!=='Application.InitializationType.Full'||!imports.has(initPath[0])||!imports.has(post.callee.name))fail('options');
 const reserved=new Set(['Promise',...imports.keys()]);
 function body(fn,count){
  if(fn?.type!=='FunctionExpression'||fn.id||fn.async||fn.generator||fn.params.length!==count||
   fn.params.some(p=>!id(p)||reserved.has(p.name))||new Set(fn.params.map(id)).size!==count||fn.body.type!=='BlockStatement')fail('callback');
  return fn.body.body;
 }
 function oneReturn(fn,count){const rows=body(fn,count);if(rows.length!==1||rows[0].type!=='ReturnStatement')fail('callback_body');return rows[0].argument;}
 function call(n,target,args=[]){return n?.type==='CallExpression'&&path(n.callee)===target&&n.arguments.length===args.length&&n.arguments.every((a,i)=>id(a)===args[i]);}
 function promise(fn,count){
  const ret=oneReturn(fn,0);if(ret?.type!=='NewExpression'||id(ret.callee)!=='Promise'||ret.arguments.length!==1)fail('promise');
  const executor=ret.arguments[0];body(executor,count);return executor;
 }
 // This call must be returned by the final .then callback, not an unused helper.
 const method=parents.get(post),then=parents.get(method),ret=parents.get(then),block=parents.get(ret),stage=parents.get(block),chain=parents.get(stage);
 if(method?.type!=='MemberExpression'||method.object!==post||method.computed||method.property.name!=='then'||
  then?.type!=='CallExpression'||then.callee!==method||then.arguments.length!==1||ret?.type!=='ReturnStatement'||
  oneReturn(stage,0)!==then||chain?.type!=='CallExpression'||chain.arguments.length!==1||chain.arguments[0]!==stage||
  chain.callee?.type!=='MemberExpression'||chain.callee.computed||chain.callee.property.name!=='then')fail('stage');
 const gate=then.arguments[0],gateBody=body(gate,1),condition=gateBody[0];
 if(gateBody.length!==1||condition.type!=='IfStatement'||id(condition.test)!==id(gate.params[0])||condition.alternate||
  condition.consequent.type!=='BlockStatement'||condition.consequent.body.length!==2)fail('gate');
 const [variables,returned]=condition.consequent.body;
 if(variables.type!=='VariableDeclaration'||variables.declarations.length!==2||returned.type!=='ReturnStatement')fail('initializers');
 const [errorInit,viewInit]=variables.declarations;
 if(!id(errorInit.id)||!id(viewInit.id)||errorInit.id.name===viewInit.id.name||[errorInit.id.name,viewInit.id.name].some(n=>reserved.has(n)||n===id(gate.params[0])))fail('initializers');
 const sequence=expressions(returned.argument),naming=[];
 if(sequence.length!==3)fail('sequence');
 for(const [i,decl,label] of [[0,errorInit,'initGlobalExceptionHandler'],[1,viewInit,'initView']]){
  const n=sequence[i];if(n?.type!=='CallExpression'||!imports.has(id(n.callee))||n.arguments.length!==2||
   id(n.arguments[0])!==decl.id.name||n.arguments[1]?.value!==label)fail('naming');naming.push(imports.get(n.callee.name));
 }
 const last=sequence[2];if(last?.type!=='CallExpression'||last.arguments.length!==1||id(last.arguments[0])!==viewInit.id.name||
  last.callee?.type!=='MemberExpression'||last.callee.computed||last.callee.property.name!=='then'||!call(last.callee.object,errorInit.id.name))fail('sequence');
 const errorExecutor=promise(errorInit.init,1),errorRows=errorExecutor.body.body,resolveError=id(errorExecutor.params[0]);
 const allThen=errorRows[0]?.expression,all=allThen?.callee?.object;
 if(errorRows.length!==1||allThen?.type!=='CallExpression'||allThen.callee.type!=='MemberExpression'||allThen.callee.computed||allThen.callee.property.name!=='then'||
  allThen.arguments.length!==1||all?.type!=='CallExpression'||path(all.callee)!=='Promise.all'||all.arguments.length!==1||all.arguments[0].type!=='ArrayExpression')fail('error_import');
 const importsList=all.arguments[0].elements;
 if(importsList.length!==1||importsList[0]?.type!=='ImportExpression'||importsList[0].source.type!=='Literal'||
  !/^\.\/_oschunk-[A-Za-z0-9]+\.js$/.test(importsList[0].source.value))fail('error_import');
 const importedCallback=allThen.arguments[0],errorBody=body(importedCallback,1).flatMap(row=>row.type==='ExpressionStatement'?expressions(row.expression).map(expression=>({type:'ExpressionStatement',expression})):[row]);
 if(errorBody.length!==3||errorBody[0].type!=='VariableDeclaration'||errorBody[0].declarations.length!==1)fail('error_registration');
 const module=errorBody[0].declarations[0],read=module.init;
 if(!id(module.id)||reserved.has(module.id.name)||module.id.name===resolveError||module.id.name===id(importedCallback.params[0])||
  read?.type!=='MemberExpression'||!read.computed||id(read.object)!==id(importedCallback.params[0])||read.property.value!==0)fail('error_registration');
 const register=errorBody[1].expression,appPath=path(register?.callee)?.split('.');
 if(register?.type!=='CallExpression'||appPath?.length!==3||appPath.slice(1).join('.')!=='default.registerDefaultErrorHandler'||!imports.has(appPath[0])||register.arguments.length!==1)fail('error_registration');
 const handler=oneReturn(register.arguments[0],0),handlerReturn=oneReturn(handler,2);
 if(handler.params.some(p=>p.name===module.id.name)||id(importedCallback.params[0])===resolveError||
  !call(handlerReturn,module.id.name+'.default.handleError',handler.params.map(id))||
  !call(errorBody[2].expression,resolveError))fail('error_handler');
 const viewExecutor=promise(viewInit.init,2),viewRows=viewExecutor.body.body,attempt=viewRows[0];
 if(attempt?.type==='TryStatement')attempt.block.body=attempt.block.body.flatMap(row=>row.type==='ExpressionStatement'?expressions(row.expression).map(expression=>({type:'ExpressionStatement',expression})):[row]);
 if(viewRows.length!==1||attempt.type!=='TryStatement'||attempt.finalizer||attempt.block.body.length!==2||
  !call(attempt.block.body[1].expression,id(viewExecutor.params[0]))||!id(attempt.handler?.param)||
  attempt.handler.body.body.length!==1||!call(attempt.handler.body.body[0].expression,id(viewExecutor.params[1]),[id(attempt.handler.param)]))fail('view_callback');
 if(viewExecutor.params.some(p=>p.name===id(attempt.handler.param)))fail('view_callback');
 const viewCall=attempt.block.body[0].expression;
 if(viewCall?.type!=='CallExpression'||viewCall.callee?.type!=='MemberExpression'||viewCall.callee.computed||
  viewCall.callee.property.name!=='load'||!imports.has(id(viewCall.callee.object)))fail('view_load');
 const catchMember=parents.get(chain),catchCall=parents.get(catchMember);
 if(catchMember?.type!=='MemberExpression'||catchMember.computed||catchMember.property.name!=='catch'||
  catchCall?.type!=='CallExpression'||catchCall.callee!==catchMember||catchCall.arguments.length!==1)fail('final_catch');
 const catchFn=catchCall.arguments[0],catchRows=body(catchFn,1),catchExpression=catchRows[0]?.expression;
 const catchPath=path(catchExpression?.callee)?.split('.');
 if(catchRows.length!==1||catchPath?.length!==2||catchPath[1]!=='handleError'||!imports.has(catchPath[0])||
  !call(catchExpression,catchPath.join('.'),catchFn.params.map(id)))fail('final_catch');
 // Promise must refer to the native global throughout this module.
 function shadows(n){if(!n||typeof n.type!=='string')return false;
  if(n.type==='VariableDeclarator'&&id(n.id)==='Promise'||['FunctionDeclaration','ClassDeclaration'].includes(n.type)&&id(n.id)==='Promise')return true;
  return Object.values(n).some(v=>Array.isArray(v)?v.some(shadows):v&&typeof v==='object'&&shadows(v));
 }
 if(imports.has('Promise')||shadows(ast))fail('promise_shadowed');
 return {sourceSha256:hash(source),stageSha256:hash(source.slice(stage.start,stage.end)),postInitialization:imports.get(post.callee.name),
  initializationType:imports.get(initPath[0]),application:imports.get(appPath[0]),naming,errorHandler:imports.get(catchPath[0]),
  exceptionImport:importsList[0].source.value,viewCallSha256:hash(source.slice(viewCall.start,viewCall.end)),
  callbacksPreserved:true,executed:false,applicationStartupQualified:false,executionAuthorized:false};
}
export function qualifyOdcBootstrapFinalStage(files,bootstrapFile){
 const result=inspectOdcBootstrapFinalStage(files[bootstrapFile]),bind=createOdcSdkBindingReader(files);
 const post=bind.exportDeclaration(result.postInitialization);
 if(post.chunkSha256!=='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d'||
  post.declarationSha256!=='a9d341441c9228046e75288842779d40e170d09b0be2958babdb207416517fb5'||
  result.initializationType.file!==result.postInitialization.file||result.initializationType.export!=='K'||
  result.application.file!==result.postInitialization.file||result.application.export!=='E'||
  result.errorHandler.file!==result.postInitialization.file||result.errorHandler.export!=='t'||
  result.naming.some(n=>n.file!==result.postInitialization.file||n.export!=='a'))fail('native_binding');
 const viewLoader=inspectOdcNativeViewLoader(files,bootstrapFile);
 return {...result,finalStageStructureQualified:true,nativePostInitialization:post,viewLoader,
  pending:['native-post-initialization-effects','model-effects-and-authenticated-mount','native-hook-completion']};
}
