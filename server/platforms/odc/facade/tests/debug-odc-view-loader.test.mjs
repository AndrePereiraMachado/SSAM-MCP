import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {inspectOdcNativeViewLoader} from '../debug-odc-view-loader.mjs';
const entry='_osbundle-App__abc.js';
const source='import {g as router} from "./_oschunk-UI.js"; import {E as app} from "./_oschunk-SDK.js"; var routes=[{}],splash=null; function mount(){router.load(app.default,{staticScreenRoutes:routes,staticSplashRoute:splash});}';
test('bootstrap refuses injected render/router overrides before loading native dependencies',()=>{
 for(const key of ['render','createRouter','makeScreenLoader']){
  const changed=source.replace('staticSplashRoute:splash','staticSplashRoute:splash,'+key+':custom');
  assert.throws(()=>inspectOdcNativeViewLoader({[entry]:changed},entry),/view_loader_call/);
 }
});
test('shadowed router, runtime or route bindings are not native loader evidence',()=>{
 for(const name of ['router','app','routes','splash']){
  const changed=source.replace('function mount()','function mount('+name+')');
  assert.throws(()=>inspectOdcNativeViewLoader({[entry]:changed},entry),/shadowed_binding/);
 }
 const local=source.replace('function mount(){','function mount(){const router=custom;');
 assert.throws(()=>inspectOdcNativeViewLoader({[entry]:local},entry),/shadowed_binding/);
});
