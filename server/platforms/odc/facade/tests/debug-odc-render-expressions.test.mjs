import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {inspectOdcRenderExpressions} from '../debug-odc-render-expressions.mjs';
import {odcMountRenderTargets} from '../debug-odc-view-render.mjs';
const contract={bindings:{React:'react',Types:'types',Convert:'conversions',spanHook:'spanHook',name:'naming',Widget:'widget'},
 fields:[{attribute:'count'},{attribute:'text'}],blocks:['Child']};
const render=`function(props){var model=props.model,controller=props.controller,ids=controller.idService,span=spanHook();
return React.createElement('div',props.rootNodeProperties,
 React.createElement(Widget,{value:model.getCachedValue(ids.getId('label'),function(){return model.variables.text+Convert.integerToText(model.variables.count)},function(){return model.variables.count})}),
 React.createElement(Widget,{variable:model.createVariable(Types.DataTypes.Integer,model.variables.count,function(value){model.variables.count=value})}),
 React.createElement(Child,{inputs:{Count:model.variables.count},getOwnerSpan:name(function(){return span.getChildSpan('render')},'getOwnerSpan')}))}`;
test('describes native reads, cache callbacks, setters and block inputs without evaluating values',()=>{
 const r=inspectOdcRenderExpressions(render,contract);assert.equal(r.renderExpressionsQualified,true);
 assert.deepEqual(r.variableReads,['text','count']);assert.deepEqual(r.nativeVariableSetters,['count']);
 assert.equal(r.elements.filter(e=>e.kind==='block').length,1);assert.equal(r.renderExecuted,false);assert.equal(r.executionAuthorized,false);
});
test('interaction callbacks remain unqualified and are never executed by render inspection',()=>{
 const r=inspectOdcRenderExpressions(render.replace("{value:model.getCachedValue","{onClick:function(){throw Error('must not execute')},value:model.getCachedValue"),contract);
 assert.equal(r.deferredInteractions[0].kind,'onClick');assert.equal(r.interactionCallbacksQualified,false);
 assert.equal(r.deferredInteractions[0].executed,false);
});
test('calls hidden in cached expressions, unknown fields and injected render effects refuse',()=>{
 for(const mutate of [s=>s.replace('model.variables.text+','send()+'),s=>s.replace('model.variables.text','model.variables.missing'),
  s=>s.replace("return React.createElement", "send();return React.createElement"),
  s=>s.replace('model.variables.count=value','model.variables.count=send(value)'),
  s=>s.replace('model.variables.count=value','other.variables.count=value'),
  s=>s.replace("'div'","'script'"),s=>s.replace('inputs:{Count:','dangerouslySetInnerHTML:{Count:'),
  s=>s.replace('getOwnerSpan:name(function(){return span.getChildSpan','getOwnerSpan:name(function(){send();return span.getChildSpan')])
  assert.throws(()=>inspectOdcRenderExpressions(mutate(render),contract),/debug_odc_render_/);
});
const named={...contract,fields:[{attribute:'count',name:'Count'},{attribute:'text',name:'Text'}]};
const bound=`function(props){var model=props.model,controller=props.controller,ids=controller.idService,span=spanHook();
return React.createElement('div',props.rootNodeProperties,
 React.createElement(Widget,{value:model.variables.count.toString(),_idProps:{service:ids,name:'CountValue'},_widgetRecordProvider:model}),
 React.createElement(Widget,{value:Convert.integerToText(model.variables.count),_idProps:{service:ids,name:'CountText'}}),
 React.createElement(Widget,{value:model.variables.text,_idProps:{service:ids,name:'TextValue'}}),
 React.createElement(Widget,{value:model.getCachedValue(ids.getId('Cached.Value'),function(){return Convert.integerToText(model.variables.count)},function(){return model.variables.count}),_idProps:{service:ids,name:'CachedValue'}}),
 React.createElement(Widget,{value:model.getCachedValue(ids.getId('Both.Value'),function(){return model.variables.text+':'+Convert.integerToText(model.variables.count)},function(){return model.variables.text},function(){return model.variables.count}),_idProps:{service:ids,name:'BothValue'}}),
 React.createElement(Widget,{_idProps:{service:ids,name:'Label'}},model.variables.text),
 React.createElement(Widget,{value:model.variables.count+1}),
 React.createElement(Child,{inputs:{Count:model.variables.count},_idProps:{service:ids,name:'Badge',alias:'1'},getOwnerSpan:name(function(){return span.getChildSpan('render')},'getOwnerSpan')}))}`;
test('records element id literals and single-variable text bindings; composite texts are excluded from equality',()=>{
 const r=inspectOdcRenderExpressions(bound,named);assert.equal(r.renderExpressionsQualified,true);
 assert.deepEqual(r.elements.filter(e=>e.id).map(e=>[e.kind,e.id,e.alias??null]),[['native-widget','CountValue',null],['native-widget','CountText',null],
  ['native-widget','TextValue',null],['native-widget','CachedValue',null],['native-widget','BothValue',null],['native-widget','Label',null],['block','Badge','1']]);
 assert.deepEqual(r.textBindings,[{id:'CountValue',attribute:'count',variable:'Count',form:'toString'},{id:'CountText',attribute:'count',variable:'Count',form:'integerToText'},
  {id:'TextValue',attribute:'text',variable:'Text',form:'variable'},{id:'CachedValue',attribute:'count',variable:'Count',form:'integerToText'},
  {id:'Label',attribute:'text',variable:'Text',form:'variable'}]);
 // Composite or unnamed texts are never compared with a single native read.
 assert.deepEqual(r.excludedTexts,[{id:'BothValue',reason:'composite'},{id:null,reason:'composite'}]);
 assert.equal(r.renderExecuted,false);assert.equal(r.executionAuthorized,false);
});
test('mount render targets derive DOM ids from the published id namespaces of screen and block instances',()=>{
 const S='W4JQW+OX20iILeFJFpMkqA',B='RDyePs1DwUyB5poRbGhwVA',M='7WNw7ud8AEKh1ftGQYhllg';
 const screen={key:S,componentLocal:'Screen',blockKeys:[B],blockComponents:['Et'],handlers:[{handler:'onReadyEventHandler',actionKey:'ALQheqsdZEGBVNun+Anl5w'}],dataActionKeys:[],
  renderExpressions:{renderExpressionsQualified:true,elements:[{kind:'native-widget',binding:'Ge',id:'ResultValue'},{kind:'block',binding:'Et',id:'LifecycleBadge',alias:'1'}],
   textBindings:[{id:'ResultValue',attribute:'resultVar',variable:'Result',form:'toString'}],excludedTexts:[{id:'ScreenLifecycleValue',reason:'composite'}]}};
 const block={key:B,componentLocal:'Et',blockKeys:[],blockComponents:[],handlers:[{handler:'onInitializeEventHandler',actionKey:'RlJ5nWDBJUGdVNVnSt55DQ'}],dataActionKeys:[],
  renderExpressions:{renderExpressionsQualified:true,elements:[{kind:'native-widget',binding:'Ge',id:'BlockLifecycleValue'}],textBindings:[{id:'BlockLifecycleValue',attribute:'seedIn',variable:'Seed',form:'integerToText'}],excludedTexts:[]}};
 const t=odcMountRenderTargets([screen,block],{moduleKey:M});
 assert.equal(t.complete,true);
 assert.deepEqual(t.instances.map(i=>[i.key,i.namespace,i.ids,i.texts.map(x=>x.id),i.functions,i.ambiguous]),[
  [S,'',['ResultValue'],['ResultValue'],[M+':ALQheqsdZEGBVNun+Anl5w'],false],
  [B,'b1-',['b1-BlockLifecycleValue'],['b1-BlockLifecycleValue'],[M+':RlJ5nWDBJUGdVNVnSt55DQ'],false]]);
 // A reused block cannot attribute its native reads to one instance.
 const twice={...screen,renderExpressions:{...screen.renderExpressions,elements:[...screen.renderExpressions.elements,{kind:'block',binding:'Et',id:'Other',alias:'2'}]}};
 assert.deepEqual(odcMountRenderTargets([twice,block],{moduleKey:M}).instances.filter(i=>i.key===B).map(i=>[i.namespace,i.ambiguous]),[['b1-',true],['b2-',true]]);
 // Unqualified render inspection or an unresolved block makes the targets incomplete.
 assert.equal(odcMountRenderTargets([{...screen,renderExpressions:{renderExpressionsQualified:false}},block],{moduleKey:M}).complete,false);
 assert.equal(odcMountRenderTargets([{...screen,blockComponents:[]},block],{moduleKey:M}).complete,false);
 assert.equal(odcMountRenderTargets(undefined,{moduleKey:M}).complete,false);
});
test('native alias shadowing, computed object properties and unknown components refuse',()=>{
 for(const mutate of [s=>s.replace('var model=','var React=props.model,model='),s=>s.replace('inputs:{Count:','inputs:{[send()]:')])
  assert.throws(()=>inspectOdcRenderExpressions(mutate(render),contract),/debug_odc_render_/);
 assert.throws(()=>inspectOdcRenderExpressions(render,{...contract,blocks:[]}),/element/);
});
import {resolveOdcInteractionTarget,prepareOdcMountInteractions} from '../debug-odc-native-mount-plan.mjs';
import {classifyEffects} from '../debug-odc-native-run.mjs';
const clickable=`function(props){var model=props.model,controller=props.controller,ids=controller.idService,span=spanHook();
return React.createElement('div',props.rootNodeProperties,
 React.createElement(Widget,{onClick:name(function(){var ctx=controller.callContext();controller.save$Action(controller.callContext(ctx))},'onClick'),_idProps:{service:ids,name:'SaveButton'}},'Save'),
 React.createElement(Widget,{value:model.variables.text,_idProps:{service:ids,name:'TextValue'}}))}`;
test('deferred onClick exposes the idService literal of its widget as an interaction target, never executing it',()=>{
 const r=inspectOdcRenderExpressions(clickable,named);
 assert.deepEqual(r.interactionTargets.map(({sourceSha256,...t})=>t),[{id:'SaveButton',event:'click',method:'save$Action'}]);
 assert.match(r.interactionTargets[0].sourceSha256,/^[a-f0-9]{64}$/);assert.equal(r.interactionTargets[0].sourceSha256,r.deferredInteractions[0].sourceSha256);
 assert.deepEqual(r.refusedInteractions,[]);assert.equal(r.deferredInteractions[0].executed,false);assert.equal(r.renderExecuted,false);
 // A computed or missing widget id, or a handler that is not exactly one controller action, is never a target.
 for(const [mutate,reason] of [[s=>s.replace("name:'SaveButton'",'name:model.variables.text'),'computed-id'],
  [s=>s.replace(",_idProps:{service:ids,name:'SaveButton'}",''),'unnamed'],
  [s=>s.replace('controller.save$Action(controller.callContext(ctx))','controller.save$Action(ctx);controller.other$Action(ctx)'),'handler-unresolved'],
  [s=>s.replace('controller.save$Action(controller.callContext(ctx))','ctx.clone()'),'handler-unresolved'],
  [s=>s.replace('var ctx=controller.callContext()','var controller=props.model'),'handler-unresolved'],
  [s=>s.replace('onClick:name(function(){','onClick:name(function(controller){'),'handler-unresolved']]){
  const m=inspectOdcRenderExpressions(mutate(clickable),named);
  assert.deepEqual(m.interactionTargets,[],reason);assert.equal(m.refusedInteractions[0].reason,reason);
 }
 // A computed id passed to idService.getId refuses the whole render inspection.
 assert.throws(()=>inspectOdcRenderExpressions(clickable.replace("value:model.variables.text,","value:model.getCachedValue(ids.getId(model.variables.text),function(){return model.variables.text}),"),named),/debug_odc_render_/);
});
const S='W4JQW+OX20iILeFJFpMkqA',B='RDyePs1DwUyB5poRbGhwVA',M='7WNw7ud8AEKh1ftGQYhllg',SAVE='SvAheqsdZEGBVNun+Anl5w',W='Wd9JnWDBJUGdVNVnSt55DQ';
function interactionIndex(){
 const screen={key:S,blockKeys:[B],handlers:[],dataActionKeys:[],renderExpressions:{renderExpressionsQualified:true,
  elements:[{kind:'block',binding:'Et',id:'Badge',alias:'1'}],textBindings:[],interactionTargets:[]}};
 const block={key:B,blockKeys:[],handlers:[],dataActionKeys:[],renderExpressions:{renderExpressionsQualified:true,
  elements:[{kind:'native-widget',binding:'Ge',id:'SaveButton'}],textBindings:[],interactionTargets:[{id:'SaveButton',event:'click',method:'save$Action',sourceSha256:'a'.repeat(64)}]}};
 const index={views:{[S]:[{key:S,chunk:'s.js',controllerFactory:'sf',blockComponents:['Et']}],[B]:[{key:B,chunk:'s.js',controllerFactory:'bf',blockComponents:[]}]},
  functions:{[SAVE]:[{key:SAVE,chunk:'s.js',controllerFactory:'bf',holder:{kind:'method',name:'save$Action'}},{key:SAVE,chunk:'s.js',controllerFactory:'bf',holder:{kind:'method',name:'_save$Action'}}],
   other:[{key:'other',chunk:'s.js',controllerFactory:'sf',holder:{kind:'method',name:'save$Action'}}]}};
 return {index,views:[screen,block]};
}
test('mount render targets carry namespaced interaction ids; the handler action resolves from the view controller only',()=>{
 const {index,views}=interactionIndex();
 assert.deepEqual(odcMountRenderTargets(views.map(v=>({...v,blockComponents:index.views[v.key][0].blockComponents})),{moduleKey:M}).instances.map(i=>i.interactions),
  [[],[{id:'b1-SaveButton',name:'SaveButton',method:'save$Action'}]]);
 assert.deepEqual(resolveOdcInteractionTarget(index,views,M,{name:'SaveButton'}),{name:'SaveButton',viewKey:B,domId:'b1-SaveButton',method:'save$Action',actionKey:SAVE});
 assert.throws(()=>resolveOdcInteractionTarget(index,views,M,{name:'Missing'}),/interaction_target_unresolved/);
 assert.throws(()=>resolveOdcInteractionTarget(index,views,M,{name:'SaveButton',viewKey:S}),/interaction_target_unresolved/);
 // A reused block cannot attribute the click to one instance.
 const twice=structuredClone(views);twice[0].renderExpressions.elements.push({kind:'block',binding:'Et',id:'Other',alias:'2'});
 assert.throws(()=>resolveOdcInteractionTarget(index,twice,M,{name:'SaveButton'}),/interaction_target_unresolved/);
 const unindexed=structuredClone(index);delete unindexed.functions[SAVE];
 assert.throws(()=>resolveOdcInteractionTarget(unindexed,views,M,{name:'SaveButton'}),/interaction_handler_unresolved/);
 const incomplete=structuredClone(views);incomplete[1].renderExpressions.renderExpressionsQualified=false;
 assert.throws(()=>resolveOdcInteractionTarget(index,incomplete,M,{name:'SaveButton'}),/interaction_targets_incomplete/);
});
test('interaction preparation resolves widget keys and adds the onClick handler closure and effects to the mount',async()=>{
 const {index,views}=interactionIndex(),read=[];
 const mount={screenKey:S,views,requiredModelRoots:['root'],effects:['unknown-javascript'],runtimeRequestKeys:['root']};
 const args={index,mount,moduleKey:M,interactions:[{target:'@'+W,event:'click'},{target:'SaveButton',event:'click'}],
  resolveWidget:async target=>target==='@'+W?{name:'SaveButton'}:null,
  readClosure:async key=>{read.push(key);return key==='@'+SAVE?[{kind:'SendEmailNode',actionKey:'mail'}]:null;},classifyEffects};
 const r=await prepareOdcMountInteractions(args);
 assert.deepEqual(r.mount.interactions,[{target:'@'+W,event:'click',name:'SaveButton',viewKey:B,actionKey:SAVE},{target:'SaveButton',event:'click',name:'SaveButton',viewKey:B,actionKey:SAVE}]);
 assert.deepEqual(read,['@'+SAVE]);assert.deepEqual(r.mount.requiredModelRoots,['root',SAVE]);
 assert.deepEqual(r.mount.effects,['unknown-javascript','email']);assert.deepEqual(r.mount.runtimeRequestKeys,['root',SAVE,'mail']);
 assert.deepEqual(r.mount.interactionClosures.map(c=>[c.actionKey,c.effects]),[[SAVE,['email']]]);
 for(const [patch,code] of [[{interactions:[{target:'@'+W,event:'dblclick'}]},/requests_invalid/],[{interactions:Array(11).fill({target:'SaveButton',event:'click'})},/requests_invalid/],
  [{resolveWidget:async()=>null},/interaction_widget_unresolved/],[{resolveWidget:async()=>({name:'a b'})},/interaction_widget_unresolved/],
  [{interactions:[{target:'Missing',event:'click'}]},/interaction_target_unresolved/],[{readClosure:async()=>null},/model_closure_unavailable/],
  [{moduleKey:'bad'},/interaction_targets_incomplete/]])
  await assert.rejects(prepareOdcMountInteractions({...args,...patch}),code);
});
