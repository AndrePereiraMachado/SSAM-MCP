// Static description of generated render expressions, never an evaluator.
// Callback bodies retained for later interactions do not count as executed.
// An onClick is an interaction target only when its widget id is the literal the
// SDK passes to controller.idService.getId (its _idProps name) and its body calls
// exactly one controller "<name>$Action": a static description, never a call.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const id=n=>n?.type==='Identifier'?n.name:null;
const member=n=>n?.type==='MemberExpression'&&!n.computed?n.property.name:null;
export function inspectOdcRenderExpressions(source,{bindings,fields,blocks=[]}){
 const fail=code=>{throw Error('debug_odc_render_'+code);};
 const ast=parse('('+source+')',{ecmaVersion:'latest'}),fn=ast.body[0]?.expression;
 if(ast.body.length!==1||fn?.type!=='FunctionExpression'||fn.id||fn.async||fn.generator||fn.params.length!==1||!id(fn.params[0]))fail('function');
 const locals=new Map(Object.entries(bindings)),attributes=new Set(fields.map(f=>f.attribute)),reads=new Set(),setters=[],callbacks=[],elements=[];
 const textBindings=[],excludedTexts=[],interactionTargets=[],refusedInteractions=[],deferredByStart=new Map();
 if(locals.has(fn.params[0].name))fail('shadow');locals.set(fn.params[0].name,'props');
 const callbackHash=n=>hash(('('+source+')').slice(n.start,n.end));
 function unwrap(n){
  if(n?.type==='CallExpression'&&locals.get(id(n.callee))==='naming'&&n.arguments.length===2&&typeof n.arguments[1].value==='string')return n.arguments[0];
  return n;
 }
 function callback(n,pure=false){
  n=unwrap(n);
  if(n?.type!=='FunctionExpression'||n.id||n.async||n.generator||n.params.length||n.body.body.length!==1||n.body.body[0].type!=='ReturnStatement')fail('callback');
  return expression(n.body.body[0].argument,pure);
 }
 function deferred(n,kind){
  n=unwrap(n);if(n?.type!=='FunctionExpression'||n.id||n.async||n.generator||n.params.some(p=>!id(p)))fail('deferred_callback');
  const entry={kind,sourceSha256:callbackHash(n),executed:false};callbacks.push(entry);deferredByStart.set(n.start,{entry,node:n});return 'callback';
 }
 // The single controller "<name>$Action" a deferred callback body calls; a local
 // rebinding of the controller name or any other count leaves it unresolved.
 function handlerMethod(n){
  const controllers=[...locals].filter(([,t])=>t==='controller').map(([k])=>k),methods=new Set();let shadowed=false;
  const walk=x=>{if(!x||typeof x.type!=='string')return;
   // Any binding that is the controller name or a pattern counts as a rebinding.
   const binds=x.type==='VariableDeclarator'?[x.id]:/Function/.test(x.type)?x.params:x.type==='CatchClause'&&x.param?[x.param]:[];
   if(binds.some(p=>!id(p)||controllers.includes(id(p))))shadowed=true;
   if(x.type==='CallExpression'&&x.callee.type==='MemberExpression'&&!x.callee.computed&&controllers.includes(id(x.callee.object))&&/^[A-Za-z_][A-Za-z0-9_]*\$Action$/.test(x.callee.property.name))methods.add(x.callee.property.name);
   for(const [k,v] of Object.entries(x))if(k!=='type'&&v&&typeof v==='object')(Array.isArray(v)?v:[v]).forEach(walk);};
  walk(n);return !shadowed&&methods.size===1?[...methods][0]:null;
 }
 function setter(n){
  n=unwrap(n);const rows=n?.body?.body;
  if(n?.type!=='FunctionExpression'||n.id||n.async||n.generator||n.params.length!==1||!id(n.params[0])||locals.has(id(n.params[0]))||
   rows?.length!==1||rows[0].type!=='ExpressionStatement')fail('setter');
  const a=rows[0].expression;
  if(a.type!=='AssignmentExpression'||a.operator!=='='||id(a.right)!==id(n.params[0])||
   a.left.type!=='MemberExpression'||a.left.computed||expression(a.left.object)!=='variables'||!attributes.has(a.left.property.name))fail('setter');
  setters.push(a.left.property.name);return 'callback';
 }
 // Syntactic only, on an already qualified node: exactly one variable read,
 // optionally converted to text. Anything else is composite and never compared.
 const typeOf=n=>n?.type==='Identifier'?locals.get(n.name):n?.type==='MemberExpression'&&!n.computed&&typeOf(n.object)==='props'&&n.property.name==='model'?'model':null;
 const calleeOf=n=>n.callee.type==='SequenceExpression'&&n.callee.expressions.length===2&&n.callee.expressions[0].value===0?n.callee.expressions[1]:n.callee;
 function single(n){
  if(n?.type==='MemberExpression'&&!n.computed&&attributes.has(n.property.name)&&n.object?.type==='MemberExpression'&&!n.object.computed&&
   n.object.property.name==='variables'&&typeOf(n.object.object)==='model')return {attribute:n.property.name,form:'variable'};
  if(n?.type!=='CallExpression')return null;
  const callee=calleeOf(n),method=member(callee);
  if(method==='integerToText'&&n.arguments.length===1&&typeOf(callee.object)==='conversions'){const s=single(n.arguments[0]);return s?.form==='variable'?{...s,form:'integerToText'}:null;}
  if(method==='toString'&&!n.arguments.length){const s=single(callee.object);return s?.form==='variable'?{...s,form:'toString'}:null;}
  const fn=unwrap(n.arguments[1]);
  if(method==='getCachedValue'&&typeOf(callee.object)==='model'&&fn?.type==='FunctionExpression'&&fn.body.body.length===1&&fn.body.body[0].type==='ReturnStatement')
   return single(fn.body.body[0].argument);
  return null;
 }
 const literalOf=n=>n?.type==='Literal'&&['string','number'].includes(typeof n.value)?String(n.value):null;
 const propOf=(object,key)=>object?.type==='ObjectExpression'?object.properties.find(p=>p.type==='Property'&&!p.computed&&(id(p.key)??p.key?.value)===key)?.value:undefined;
 function bindText(element,value){
  const s=single(value),field=s&&fields.find(f=>f.attribute===s.attribute);
  if(s&&element.id)textBindings.push({id:element.id,attribute:s.attribute,variable:field?.name??null,form:s.form});
  else excludedTexts.push({id:element.id??null,reason:s?'unnamed':'composite'});
 }
 function expression(n,pure=false,property){
  if(!n)fail('expression');
  if(n.type==='Literal'&&(n.value===null||['string','number','boolean'].includes(typeof n.value)))return 'value';
  if(n.type==='Identifier'){const type=locals.get(n.name);if(!type)fail('unbound');return type;}
  if(n.type==='UnaryExpression'&&['!','-','+'].includes(n.operator)){if(expression(n.argument,pure)!=='value')fail('unary');return 'value';}
  if(n.type==='BinaryExpression'&&['+','-','*','/','===','!==','<','>','<=','>='].includes(n.operator)){
   if(expression(n.left,pure)!=='value'||expression(n.right,pure)!=='value')fail('binary');return 'value';
  }
  if(n.type==='ArrayExpression'){n.elements.forEach(e=>expression(e,pure));return 'array';}
  if(n.type==='ObjectExpression'){
   const seen=new Set();for(const p of n.properties){const key=id(p.key)??p.key?.value;
    if(p.type!=='Property'||p.computed||p.method||p.kind!=='init'||typeof key!=='string'||['__proto__','prototype','constructor'].includes(key)||seen.has(key))fail('object');
    if(['dangerouslySetInnerHTML','ref'].includes(key))fail('object');seen.add(key);expression(p.value,pure,key);
   }return 'object';
  }
  if(n.type==='FunctionExpression'||n.type==='CallExpression'&&locals.get(id(n.callee))==='naming'){
   if(pure)fail('callback_effect');
   if(['onClick','validateWidget','_handleError'].includes(property))return deferred(n,property);
   if(['getOwnerSpan','getOwnerDisposeSpan'].includes(property)){callback(n);return 'callback';}
   fail('callback_position');
  }
  if(n.type==='MemberExpression'&&!n.computed){
   const type=expression(n.object,pure),key=n.property.name;
   if(type==='props'&&['model','controller','rootNodeProperties'].includes(key))return key==='rootNodeProperties'?'object':key;
   if(type==='controller'&&['idService','validationService'].includes(key))return key;
   if(type==='model'&&key==='variables')return 'variables';
   if(type==='variables'&&attributes.has(key)){reads.add(key);return 'value';}
   if(type==='types'&&key==='DataTypes')return 'dataTypes';
   if(type==='dataTypes'&&['Integer','Text','Boolean','Decimal','LongInteger','Date','Time','DateTime'].includes(key))return 'dataType';
   fail('member');
  }
  if(n.type==='CallExpression'){
   const callee=n.callee.type==='SequenceExpression'&&n.callee.expressions.length===2&&n.callee.expressions[0].value===0?n.callee.expressions[1]:n.callee;
   if(id(callee)&&locals.get(callee.name)==='spanHook'&&!n.arguments.length&&!pure)return 'spanProvider';
   const method=member(callee);if(!method)fail('call');
   const owner=expression(callee.object,pure),args=n.arguments;
   if(owner==='controller'&&method==='callContext'&&!args.length&&!pure)return 'callContext';
   if(owner==='spanProvider'&&method==='getChildSpan'&&args.length===1&&['render','destroy'].includes(args[0].value)&&!pure)return 'span';
   if(owner==='idService'&&method==='getId'&&args.length===1&&typeof args[0].value==='string'&&!pure)return 'value';
   if(owner==='conversions'&&method==='integerToText'&&args.length===1&&expression(args[0],pure)==='value')return 'value';
   if(owner==='modelSdk'&&method==='calculateDataFetchStatus'&&args.length===1&&expression(args[0],pure)==='value')return 'value';
   if(owner==='value'&&method==='toString'&&!args.length)return 'value';
   if(owner==='model'&&method==='getCachedValue'&&args.length>=2&&!pure){
    if(expression(args[0])!=='value'||args.slice(1).some(a=>callback(a,true)!=='value'))fail('cache');return 'value';
   }
   if(owner==='model'&&method==='createVariable'&&args.length===3&&!pure){
    if(expression(args[0])!=='dataType'||expression(args[1])!=='value')fail('variable');setter(args[2]);return 'variable';
   }
   if(owner==='react'&&method==='createElement'&&args.length>=2&&!pure){
    const tag=args[0];let element;
    if(tag.type==='Literal'&&['div','span','p','section','main','article','header','footer','label','h1','h2','h3','ul','ol','li','table','thead','tbody','tr','td','th'].includes(tag.value))element={kind:'html',tag:tag.value};
    else if(id(tag)&&locals.get(tag.name)==='widget')element={kind:'native-widget',binding:tag.name};
    else if(id(tag)&&blocks.includes(tag.name))element={kind:'block',binding:tag.name};else fail('element');
    elements.push(element);
    if(!['object','value'].includes(expression(args[1])))fail('props');args.slice(2).forEach(a=>expression(a));
    // The widget id the SDK id service renders: its _idProps name (and block alias).
    const idProps=propOf(args[1],'_idProps'),name=literalOf(propOf(idProps,'name')),alias=literalOf(propOf(idProps,'alias'));
    if(name)Object.assign(element,{id:name},alias!==null?{alias}:{});
    const click=propOf(args[1],'onClick');
    if(click!==undefined){
     const deferredClick=deferredByStart.get(unwrap(click)?.start),named=propOf(idProps,'name'),service=propOf(idProps,'service');
     const method=deferredClick&&handlerMethod(deferredClick.node);
     const reason=named===undefined?'unnamed':!name||!service||expression(service)!=='idService'?'computed-id':!method?'handler-unresolved':null;
     if(reason)refusedInteractions.push({id:name,reason});
     else interactionTargets.push({id:name,event:'click',method,sourceSha256:deferredClick.entry.sourceSha256});
    }
    if(element.kind!=='block'){
     const value=propOf(args[1],'value');
     if(value!==undefined)bindText(element,value);else if(args.length===3&&single(args[2]))bindText(element,args[2]);
    }
    return 'element';
   }
   fail('call');
  }
  fail('expression');
 }
 const rows=fn.body.body;if(rows.length<1||rows.at(-1).type!=='ReturnStatement')fail('body');
 for(const row of rows.slice(0,-1)){
  if(row.type!=='VariableDeclaration')fail('body');
  for(const d of row.declarations){if(!id(d.id)||locals.has(d.id.name))fail('shadow');const type=expression(d.init);locals.set(d.id.name,type);}
 }
 if(expression(rows.at(-1).argument)!=='element')fail('return');
 return {renderExpressionsQualified:true,sourceSha256:hash(source),variableReads:[...reads],nativeVariableSetters:setters,elements,textBindings,excludedTexts,
  deferredInteractions:callbacks,interactionTargets,refusedInteractions,interactionCallbacksQualified:callbacks.length===0,renderExecuted:false,executionAuthorized:false};
}
