import test from 'node:test';
import assert from 'node:assert/strict';
import {readOdcViewResources} from '../debug-odc-view-resources.mjs';
const source=`var viewFactory=name(function(){var component=wrap(function(){},{});return component.getCssDependencies=function(){return ['css/widgets.css']},component.getJsDependencies=function(){return []},component.getBlocks=function(){return []},component},'View');`;
test('original dependency callbacks expose literals without fetching or executing',()=>{
 const p=readOdcViewResources(source,'viewFactory');assert.equal(p.resolved,true);assert.deepEqual(p.css,['css/widgets.css']);assert.deepEqual(p.js,[]);assert.equal(p.resourcesFetched,false);
});
test('nonempty script dependencies remain visible',()=>{
 const p=readOdcViewResources(source.replace('getJsDependencies=function(){return []}','getJsDependencies=function(){return ["scripts/plugin.js"]}'),'viewFactory');
 assert.deepEqual(p.js,['scripts/plugin.js']);
});
test('dynamic, missing and effectful callbacks cannot become empty resource lists',()=>{
 for(const mutate of [s=>s.replace("['css/widgets.css']",'[computed()]'),s=>s.replace('getJsDependencies=function(){return []}','getJsDependencies=function(){send();return []}'),s=>s.replace('component.getJsDependencies','other.getJsDependencies'),s=>s.replace('getJsDependencies=function(){return []}','getJsDependencies=callback')])assert.throws(()=>readOdcViewResources(mutate(source),'viewFactory'),/view_resources_/);
});
