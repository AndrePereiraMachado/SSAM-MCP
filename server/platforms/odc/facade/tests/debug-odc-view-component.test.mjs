import test from 'node:test';
import assert from 'node:assert/strict';
import {readOdcViewComponent,createOdcViewComponentInspector} from '../debug-odc-view-component.mjs';
const view={chunk:'_oschunk-VIEW.js',componentFactory:'make',displayName:'Flow.Screen',modelFactory:'model',controllerFactory:'controller',blockComponents:['child']};
const source=`import {o as wrap} from './_oschunk-UI.js';import {a as named} from './_oschunk-CORE.js';
var make=named(function(){var component=wrap(function(props){throw new Error('deferred render')},{
topLevelComponent:!0,displayName:'Flow.Screen',modelFactory:model,controllerFactory:controller,
getAttributes:named(function(){throw new Error('deferred attributes')},'getAttributes'),getTitle:function(){return 'Screen'},
breakpointMinWidths:{ExtraSmall:0,Small:768}});
return component.getCssDependencies=function(){return ['css/widgets.css']},component.getJsDependencies=function(){return []},component.getBlocks=function(){return [child]},component;},'View');`;
test('component registration separates retained callbacks from initialization',()=>{
 const result=readOdcViewComponent(source,view);
 assert.deepEqual(result.wrapper,{file:'./_oschunk-UI.js',export:'o'});
 assert.equal(result.deferredCallbacks.length,6);assert.equal(result.renderExecuted,false);
 assert.equal(result.viewInitializationQualified,false);assert.equal(result.executionAuthorized,false);
 assert.deepEqual(result.namingHelpers,[{file:'./_oschunk-CORE.js',export:'a'}]);
});
test('active metadata calls, getters and custom span factories are not registration-only',()=>{
 for(const mutation of [
  s=>s.replace('getTitle:function(){return \'Screen\'}','getTitle:run()'),
  s=>s.replace('getTitle:function(){return \'Screen\'}','get getTitle(){return run()}'),
  s=>s.replace("displayName:'Flow.Screen'","displayName:readName()"),
  s=>s.replace('topLevelComponent:!0','topLevelComponent:!0,makeSpanProvider:function(){return run()}'),
  s=>s.replace('Small:768','Small:getWidth()'),
  s=>s.replace('topLevelComponent:!0','...metadata,topLevelComponent:!0'),
 ])assert.throws(()=>readOdcViewComponent(mutation(source),view),/view_component_/);
});
test('extra initialization, dependency effects and model rebinding are refused',()=>{
 for(const mutation of [
  s=>s.replace('var component=wrap','run();var component=wrap'),
  s=>s.replace('modelFactory:model','modelFactory:other'),
  s=>s.replace('return [child]','run();return [child]'),
  s=>s.replace('return [child]','return [other]'),
  s=>s.replace('},component;','},run(),component;'),
  s=>s.replace('function(){var component','function(wrap){var component'),
  s=>s.replace('function(){var component','function wrap(){var component'),
  s=>s.replaceAll('component','wrap'),
 ])assert.throws(()=>readOdcViewComponent(mutation(source),view),/view_component_/);
});
test('duplicate and computed metadata cannot hide an active value',()=>{
 for(const mutation of [
  s=>s.replace('topLevelComponent:!0','topLevelComponent:!0,topLevelComponent:!1'),
  s=>s.replace('topLevelComponent:!0',"['topLevelComponent']:!0"),
  s=>s.replace('Small:768','Small:768,Small:1024'),
 ])assert.throws(()=>readOdcViewComponent(mutation(source),view),/view_component_/);
});
test('a similarly named wrapper cannot inherit qualification from an unreviewed SDK',()=>{
 const inspect=createOdcViewComponentInspector({[view.chunk]:source,'_oschunk-UI.js':"var wrapper=(render,metadata)=>render;export {wrapper as o};"});
 assert.throws(()=>inspect(view),/sdk_unreviewed/);
});
