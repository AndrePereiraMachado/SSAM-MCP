import test from 'node:test';import assert from 'node:assert/strict';
import {readOdcControllerDispatchSource} from '../debug-odc-controller-dispatch-source.mjs';
const controller={baseMember:'BaseModuleController',overriddenDispatch:[],baseImport:{file:'_oschunk-SDK.js',exported:'I'}};
const source='var CP=class {fireApplicationReady(){return 1} setupOnApplicationResumeListener(){} setupSyncOnResume(){} fireApplicationResume(){}};var ns=Object.freeze({get BaseModuleController(){return CP}});export {ns as I};';
test('binds methods through the original SDK export and class',()=>{
 const rows=readOdcControllerDispatchSource({'_oschunk-SDK.js':source},controller);
 assert.equal(rows.length,4);assert.equal(rows[0].source,'fireApplicationReady(){return 1}');
});
test('rejects application overrides, missing methods and accessor dispatch',()=>{
 assert.throws(()=>readOdcControllerDispatchSource({'_oschunk-SDK.js':source},{...controller,overriddenDispatch:['fireApplicationReady']}),/unbound/);
 assert.throws(()=>readOdcControllerDispatchSource({'_oschunk-SDK.js':source.replace('fireApplicationResume(){}','')},controller),/unbound/);
 assert.throws(()=>readOdcControllerDispatchSource({'_oschunk-SDK.js':source.replace('fireApplicationResume(){}','get fireApplicationResume(){}')},controller),/unbound/);
});
