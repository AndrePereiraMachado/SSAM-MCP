import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {planOdcNativeMount,prepareOdcMountClosures,planOdcAuthorizedMount} from '../debug-odc-native-mount-plan.mjs';
import {classifyEffects} from '../debug-odc-native-run.mjs';
import {nativeLifecycleAbsent} from '../debug-odc-native-lifecycle.mjs';
import {parse} from 'acorn';
test('only the exact native cached-null getter is classified absent by default',()=>{
 const method=s=>parse('class C{'+s+'}',{ecmaVersion:'latest'}).body[0].body.body[0];
 const original='get onRenderEventHandler(){return this.hasOwnProperty("_onRenderEventHandler")||(this._onRenderEventHandler=null),this._onRenderEventHandler}';
 assert.equal(nativeLifecycleAbsent(method(original)),true);
 assert.equal(nativeLifecycleAbsent(method(original.replace('=null','=external()'))),false);
 assert.equal(nativeLifecycleAbsent(method(original.replace('return this.hasOwnProperty','external();return this.hasOwnProperty'))),false);
});
function fixture(){
 const view=(key,action,blocks=[])=>({key,displayName:key,chunk:key+'.js',componentLocal:'view',controllerFactory:'factory',blockKeys:blocks,unresolvedBlockComponents:[],controllerSurface:{resolved:true,lifecycleHandlers:[{handler:'onInitializeEventHandler',actionKeys:[action]}]}});
 const action=(chunk)=>({chunk,controllerFactory:'factory',lifecycleBindings:[{handler:'onInitializeEventHandler',binding:{kind:'direct',contextPreserved:true}}]});
 return {bootstrap:{mountImports:[],applicationStartup:{importers:['homeModuleControllerImporter','homeModuleLanguageResourcesImporter'].map(name=>({name,imports:['./_oschunk-APP.js'],resolved:true}))}},chunks:{'_oschunk-APP.js':{imports:[]}},views:{screen:[view('screen','s',['block'])],block:[view('block','b')]},screens:{screen:'screen.js'},functions:{s:[action('screen.js')],b:[action('block.js')]}};
}

test('resource discovery cannot turn unresolved or unpinned dependencies into a ready mount',()=>{
 const ix=fixture();assert.ok(planOdcNativeMount(ix,'screen').pending.includes('view-resource-dependencies'));
 for(const v of Object.values(ix.views).flat())v.resourceDependencies={resolved:true,css:[],js:[],resourcesFetched:false};
 ix.views.screen[0].resourceDependencies.js=['scripts/plugin.js'];
 const p=planOdcNativeMount(ix,'screen');assert.equal(p.pending.includes('view-resource-dependencies'),false);
 assert.ok(p.pending.includes('view-resource-pins'));assert.equal(p.executionAuthorized,false);
 assert.deepEqual(p.views[0].resourceDependencies.js,['scripts/plugin.js']);
});
test('mounted preparation includes effects of sibling lifecycle and startup actions',async()=>{
 const ix=fixture();ix.functions.ready=[{key:'ready',chunk:'_oschunk-APP.js'}];
 const read=[];
 const p=await prepareOdcMountClosures(ix,'screen',async key=>{
  read.push(key);return key==='@ready'?[{kind:'SendEmailNode',actionKey:'mail'}]:key==='@b'?[{kind:'JavaScriptNode'}]:[];
 },classifyEffects);
 assert.deepEqual(read,['@s','@b','@ready']);assert.deepEqual(p.effects,['unknown-javascript','email']);
 assert.ok(p.runtimeRequestKeys.includes('mail'));assert.equal(p.executionAuthorized,false);
 assert.equal(p.mounted,false);assert.ok(p.pending.includes('application-startup-closure'));
});
test('mounted preparation never treats an unavailable closure as empty',async()=>{
 await assert.rejects(()=>prepareOdcMountClosures(fixture(),'screen',async()=>null,classifyEffects),/model_closure_unavailable/);
 await assert.rejects(()=>prepareOdcMountClosures(fixture(),'screen',undefined,classifyEffects),/model_closure_unavailable/);
});
test('mount discovery retains screen/block roots and refuses to claim execution authority',()=>{
 const ix=fixture();ix.functions.fetch=[{key:'fetch',chunk:'block.js',controllerFactory:'factory',call:{kind:'data-action'}}];
 const p=planOdcNativeMount(ix,'screen');assert.deepEqual(p.requiredModelRoots,['s','b','fetch']);assert.equal(p.executionAuthorized,false);assert.equal(p.mounted,false);
});
test('final bootstrap structure evidence cannot authorize native mounting',()=>{
 const ix=fixture();ix.bootstrap.finalStage={finalStageStructureQualified:true,applicationStartupQualified:false,executionAuthorized:false};
 const p=planOdcNativeMount(ix,'screen');assert.deepEqual(p.startup.finalStage,ix.bootstrap.finalStage);
 assert.equal(p.startup.qualified,false);assert.equal(p.executionAuthorized,false);
 assert.ok(p.pending.includes('application-startup-closure'));
});
test('unknown lifecycle is not silently treated as absent',()=>{
 const ix=fixture();ix.views.block[0].controllerSurface.lifecycleHandlers.push({handler:'onDestroyEventHandler',actionKeys:[]});
 assert.throws(()=>planOdcNativeMount(ix,'screen'),/lifecycle_unresolved/);
});
test('unknown controllers, unresolved imports, recursion and unbound routes refuse',()=>{
 for(const mutate of [ix=>ix.views.block[0].controllerSurface.resolved=false,ix=>ix.views.block[0].unresolvedBlockComponents.push('external'),ix=>ix.views.block[0].blockKeys.push('screen'),ix=>delete ix.screens.screen]){
  const ix=fixture();mutate(ix);assert.throws(()=>planOdcNativeMount(ix,'screen'),/debug_odc_native_mount_/);
 }
});
test('cached event dispatchers require the native helper source proof',()=>{
 const ix=fixture();ix.functions.b[0].lifecycleBindings[0].binding.kind='native-cached-event';
 assert.throws(()=>planOdcNativeMount(ix,'screen'),/lifecycle_binding_unqualified/);
 ix.functions.b[0].lifecycleBindings[0].helper={sourceBindingOnly:true};assert.equal(planOdcNativeMount(ix,'screen').views.length,2);
});
test('mount includes actions from the global error import closure, without authorizing startup',()=>{
 const ix=fixture();ix.bootstrap.mountImports=['./_oschunk-ERROR.js'];
 Object.assign(ix.chunks,{'_oschunk-ERROR.js':{imports:[{specifier:'./_oschunk-HANDLER.js'}]},'_oschunk-HANDLER.js':{imports:[]}});
 ix.functions.error=[{key:'error',chunk:'_oschunk-HANDLER.js',type:'CLIENT_EXCEPTION_HANDLER'}];
 const p=planOdcNativeMount(ix,'screen');
 assert.deepEqual(p.requiredModelRoots,['s','b','error']);assert.deepEqual(p.startup.actionKeys,['error']);
 assert.equal(p.startup.qualified,false);assert.equal(p.executionAuthorized,false);
});

test('mount includes application controller actions and refuses an unresolved definition',()=>{
 const ix=fixture();ix.functions.ready=[{key:'ready',chunk:'_oschunk-APP.js'}];
 assert.ok(planOdcNativeMount(ix,'screen').requiredModelRoots.includes('ready'));
 for(const mutate of [x=>delete x.bootstrap.applicationStartup,x=>x.bootstrap.applicationStartup.importers[0].resolved=false,
   x=>x.bootstrap.applicationStartup.importers[0].imports=[null]]){
  const broken=structuredClone(ix);mutate(broken);assert.throws(()=>planOdcNativeMount(broken,'screen'),/import_unresolved/);
 }
});
test('computed, external, missing and unindexed startup imports cannot disappear from the plan',()=>{
 for(const imports of [undefined,[null],['https://external.test/a.js'],['./_oschunk-MISSING.js']]){
  const ix=fixture();ix.bootstrap.mountImports=imports;
  assert.throws(()=>planOdcNativeMount(ix,'screen'),/startup_import_unresolved/);
 }
});
test('authorized mount navigates only to the default route of the requested screen',()=>{
 const ix=fixture();ix.bootstrap.routes=[{screenName:'screen',chunk:'screen.js',default:true}];
 const p=planOdcAuthorizedMount(ix,'screen');
 assert.deepEqual(p.requiredModelRoots,['s','b']);assert.deepEqual(p.route,{screenName:'screen',default:true});
 assert.equal(p.executionAuthorized,false);assert.equal(p.mounted,false);
 // Published apps also carry the named route of the default screen (seen live in r3c).
 const named=fixture();named.bootstrap.routes=[{screenName:'screen',chunk:'screen.js',default:true},{screenName:'screen',chunk:'screen.js',default:false}];
 assert.deepEqual(planOdcAuthorizedMount(named,'screen').route,{screenName:'screen',default:true});
 for(const routes of [undefined,[],[{screenName:'screen',chunk:'screen.js',default:false}],
  [{screenName:'screen',chunk:'screen.js',default:true},{screenName:'screen',chunk:'other.js',default:true}],
  [{screenName:'other',chunk:'other.js',default:true},{screenName:'screen',chunk:'screen.js',default:false}],
  [{screenName:'screen',chunk:'other.js',default:true}]]){
  const other=fixture();other.bootstrap.routes=routes;
  assert.throws(()=>planOdcAuthorizedMount(other,'screen'),/route_not_default/);
 }
});

import {planOdcNavigationTarget,prepareOdcMountNavigation} from '../debug-odc-native-mount-plan.mjs';
import {createHash} from 'node:crypto';
function navigable(){
 const ix=fixture();
 const target={key:'target',displayName:'target',chunk:'target.js',componentLocal:'view',controllerFactory:'factory',blockKeys:[],unresolvedBlockComponents:[],
  controllerSurface:{resolved:true,lifecycleHandlers:[{handler:'onInitializeEventHandler',actionKeys:['t']},{handler:'onDestroyEventHandler',actionKeys:['d']}]},
  modelConstruction:{inputs:{setInputsQualified:true,copies:[{input:'Seed',attribute:'seedIn',guards:['Seed']},{input:'Name',attribute:'nameIn',guards:['Name']},
   {input:'_seedInDataFetchStatus',attribute:'_seedInDataFetchStatus',guards:['Seed','_seedInDataFetchStatus']}]}}};
 ix.views.target=[target];ix.screens.target='target.js';
 const lifecycle=handler=>({chunk:'target.js',controllerFactory:'factory',lifecycleBindings:[{handler,binding:{kind:'direct',contextPreserved:true}}]});
 ix.functions.t=[lifecycle('onInitializeEventHandler')];ix.functions.d=[lifecycle('onDestroyEventHandler')];
 ix.bootstrap.routes=[{screenName:'screen',chunk:'screen.js',default:true},{screenName:'target',chunk:'target.js',default:false}];
 ix.bootstrap.viewLoader={routeQualification:{routeExpressionsQualified:true,routes:[{screenName:'screen',defaultPath:true,segment:'',chunk:'screen.js'},
  {screenName:'screen',defaultPath:false,segment:'Screen',chunk:'screen.js'},{screenName:'target',defaultPath:false,segment:'Target',chunk:'target.js'}]}};
 return ix;
}
test('authorized mount accepts a qualified named route as the initial deep link; an unqualified segment refuses',()=>{
 const p=planOdcAuthorizedMount(navigable(),'target',{route:{segment:'Target'}});
 assert.deepEqual(p.route,{screenName:'target',default:false,segment:'Target'});assert.deepEqual(p.requiredModelRoots,['t','d']);
 assert.deepEqual(planOdcAuthorizedMount(navigable(),'screen',{route:{segment:'Screen'}}).route,{screenName:'screen',default:false,segment:'Screen'});
 for(const [key,segment,mutate] of [['target','Other'],['target','Screen'],['target',''],['screen','Target'],
  ['target','Target',ix=>{ix.bootstrap.viewLoader.routeQualification.routeExpressionsQualified=false;}],
  ['target','Target',ix=>{delete ix.bootstrap.viewLoader;}],
  ['target','Target',ix=>{ix.bootstrap.viewLoader.routeQualification.routes[2].chunk='other.js';}]]){
  const ix=navigable();mutate?.(ix);assert.throws(()=>planOdcAuthorizedMount(ix,key,{route:{segment}}),/route_unqualified/,key+segment);
 }
 // The non-default target cannot be mounted at the app root.
 assert.throws(()=>planOdcAuthorizedMount(navigable(),'target'),/route_not_default/);
});
test('a navigation target needs a qualified route and setInputs copies for exactly the scenario inputs',()=>{
 const t=planOdcNavigationTarget(navigable(),'target','Target',['Name','Seed']);
 assert.equal(t.screenKey,'target');assert.equal(t.segment,'Target');assert.equal(t.back,true);
 assert.deepEqual(t.views.map(v=>v.key),['target']);assert.deepEqual(t.requiredModelRoots.filter(k=>['t','d'].includes(k)),['t','d']);
 assert.deepEqual(t.inputs.map(c=>c.input),['Seed','Name']);assert.equal(t.executionAuthorized,false);
 for(const [segment,names,expected] of [['Other',[],/route_unqualified/],['Screen',[],/route_unqualified/],['Target',['Missing'],/screen_input_unqualified/],
  ['Target',['_seedInDataFetchStatus'],/screen_input_unqualified/],['Target',['Seed','Seed'],/screen_input_unqualified/]])
  assert.throws(()=>planOdcNavigationTarget(navigable(),'target',segment,names),expected);
 const unqualified=navigable();unqualified.views.target[0].modelConstruction.inputs={setInputsQualified:false};
 assert.throws(()=>planOdcNavigationTarget(unqualified,'target','Target',[]),/screen_inputs_unqualified/);
 const mounted=planOdcAuthorizedMount(navigable(),'screen',{navigation:{screenKey:'target',segment:'Target',inputs:['Seed']}});
 assert.deepEqual(mounted.route,{screenName:'screen',default:true});assert.equal(mounted.navigation.screenKey,'target');
 assert.ok(['s','b','t','d'].every(k=>mounted.requiredModelRoots.includes(k)));
});
test('navigation preparation canonicalizes target inputs against InputParameters and adds closures and effects',async()=>{
 const ix=navigable(),signature=[{name:'Seed',dataType:'Integer',mandatory:true},{name:'Name',dataType:'Text',mandatory:false}];
 const read=[];const readClosure=async key=>{read.push(key);return key==='@d'?[{kind:'JavaScriptNode'}]:[];};
 const base=await prepareOdcMountClosures(ix,'screen',readClosure,classifyEffects);read.length=0;
 const r=await prepareOdcMountNavigation({index:ix,mount:base,navigate:{screen:'@target',back:true},targetInputs:signature,
  scenarios:[{name:'a',inputs:{},context:{screen:{inputs:{Name:'x y',Seed:7}}}},{name:'b',inputs:{},context:{screen:{inputs:{Seed:'8'}}}}],readClosure,classifyEffects});
 assert.deepEqual(read,['@t','@d']);assert.ok(r.mount.effects.includes('unknown-javascript'));
 assert.equal(r.mount.navigation.screenKey,'target');assert.equal(r.mount.navigation.segment,'Target');assert.equal(r.mount.navigation.back,true);
 assert.deepEqual(r.mount.navigation.closures.map(c=>c.actionKey),['t','d']);
 assert.deepEqual(r.scenarios[0].navigation.inputs,[['Seed','7'],['Name','x y']]);
 assert.equal(r.scenarios[0].navigation.query,'Seed=7&Name=x%20y');assert.match(r.scenarios[0].navigation.querySha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(r.scenarios[1].navigation.inputs,[['Seed','8']]);
 for(const [inputs,expected] of [[{Name:'x'},/screen_input_missing/],[{Seed:1,Extra:2},/screen_input_unknown/],[{Seed:1.5},/screen_input_type/],
  [{Seed:'1',Name:3},/screen_input_type/]])
  await assert.rejects(prepareOdcMountNavigation({index:ix,mount:base,navigate:{screen:'@target',back:true},targetInputs:signature,
   scenarios:[{name:'a',inputs:{},context:{screen:{inputs}}}],readClosure,classifyEffects}),expected);
 await assert.rejects(prepareOdcMountNavigation({index:ix,mount:base,navigate:{screen:'@target',back:true},
  targetInputs:[...signature,{name:'When',dataType:'Date',mandatory:true}],scenarios:[{name:'a',inputs:{},context:{screen:{inputs:{Seed:1,When:'2026-01-01'}}}}],readClosure,classifyEffects}),/screen_input_type_unsupported/);
 await assert.rejects(prepareOdcMountNavigation({index:ix,mount:base,navigate:{screen:'@target',back:false},targetInputs:signature,
  scenarios:[{name:'a',inputs:{},context:{screen:{inputs:{Seed:1}}}}],readClosure,classifyEffects}),/navigation_back_required/);
 await assert.rejects(prepareOdcMountNavigation({index:ix,mount:base,navigate:{screen:'@target',back:true},targetInputs:signature,
  scenarios:[{name:'a',inputs:{},context:{screen:{inputs:{Seed:1},variables:{x:1}}}}],readClosure,classifyEffects}),/screen_context_unsupported/);
});
test('deep-link preparation binds the mounted screen to its named route and one scenario query',async()=>{
 const ix=navigable(),readClosure=async()=>[],signature=[{name:'Seed',dataType:'Integer',mandatory:true}];
 const base=await prepareOdcMountClosures(ix,'target',readClosure,classifyEffects);
 const r=await prepareOdcMountNavigation({index:ix,mount:base,targetInputs:signature,scenarios:[{name:'a',inputs:{},context:{screen:{inputs:{Seed:3}}}}],readClosure,classifyEffects});
 assert.deepEqual(r.mount.route,{screenName:'target',default:false,segment:'Target',query:'Seed=3',querySha256:createHash('sha256').update('Seed=3').digest('hex')});
 assert.equal(r.mount.navigation,undefined);
 await assert.rejects(prepareOdcMountNavigation({index:ix,mount:base,targetInputs:signature,scenarios:[{name:'a',inputs:{},context:{screen:{inputs:{Seed:3}}}},{name:'b',inputs:{},context:{screen:{inputs:{Seed:4}}}}],readClosure,classifyEffects}),/deep_link_single_scenario/);
 // The default screen keeps the app root and accepts no inputs.
 const root=await prepareOdcMountNavigation({index:ix,mount:await prepareOdcMountClosures(ix,'screen',readClosure,classifyEffects),targetInputs:[],scenarios:[{name:'a',inputs:{}}],readClosure,classifyEffects});
 assert.deepEqual(root.mount.route,{screenName:'screen',default:true});
});
