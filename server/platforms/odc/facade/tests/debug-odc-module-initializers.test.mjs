import './fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {inspectOdcModuleInitializers} from '../debug-odc-module-initializers.mjs';
const inspect=source=>inspectOdcModuleInitializers(source,'_oschunk-APP.js');
test('imports and real initialization sites are distinct from unused action bodies',()=>{
 const r=inspect("import{service as sdk}from './_oschunk-SDK.js';function action(){fetch('private')}var alias=action,instance=new Controller;sdk.register(alias);export{instance as default};");
 assert.deepEqual(r.effects.map(e=>[e.kind,e.target]),[['construct','Controller'],['call','sdk.register']]);
 assert.equal(r.deferred.length,1);assert.equal(r.imports[0].bindings[0].exported,'service');
 assert.equal(r.executionAuthorized,false);assert.equal(r.transitiveEffectsQualified,false);
});
test('class loading executes bases, computed keys, static fields and static blocks; instance bodies stay deferred',()=>{
 const r=inspect('class C extends base(){[key()](){methodEffect()} value=instanceEffect();static value=staticEffect();static{state=blockEffect()}constructor(){constructorEffect()}}');
 assert.deepEqual(r.effects.map(e=>e.target),['base','key','staticEffect','state','blockEffect']);
 assert.deepEqual(r.deferred.map(e=>e.kind),['method','instance-field','constructor']);
});
test('IIFEs and dynamic imports remain explicit unresolved execution sites',()=>{
 const r=inspect('(()=>send())();await import("./_oschunk-NEXT.js");obj[key]();delete obj.value;');
 assert.equal(r.effects[0].inlineFunction,true);assert.equal(r.effects[0].target,null);
 assert.ok(r.effects.some(e=>e.kind==='dynamic-import'&&e.specifier==='./_oschunk-NEXT.js'));
 assert.ok(r.effects.some(e=>e.kind==='write'&&e.operator==='delete'));
 assert.equal(r.transitiveEffectsQualified,false);
});
test('source hashes distinguish initializer changes without executing their code',()=>{
 const a=inspect('let x=first()'),b=inspect('let x=second()');
 assert.notEqual(a.sourceSha256,b.sourceSha256);assert.notEqual(a.effects[0].sourceSha256,b.effects[0].sourceSha256);
});

test('constructed local aliases expose constructor and instance-field effects, not unrelated methods',()=>{
 const r=inspect('class C extends sdk.Base{field=fieldInit();constructor(value=defaultArg()){super(value);state=sdk.resolve(Service);this.callback=()=>later()}method(){unused()}}const Alias=C,instance=new Alias;');
 const c=r.constructors[0];assert.equal(c.resolved,true);assert.deepEqual(c.aliases,['Alias','C']);assert.equal(c.base,'sdk.Base');
 assert.deepEqual(c.effects.filter(e=>e.kind==='call').map(e=>e.target),['defaultArg','super','sdk.resolve','fieldInit']);
 assert.ok(c.effects.some(e=>e.kind==='write'&&e.target==='state'));
 assert.equal(c.deferred.length,1);assert.equal(c.transitiveEffectsQualified,false);
});

test('unbound constructors and alias cycles remain unresolved; inherited defaults remain explicit',()=>{
 for(const source of ['var A=B,B=A;new A','new external.C','var A=first;var A=second;new A']){
  const r=inspect(source);assert.equal(r.constructors[0].resolved,false);
 }
 const r=inspect('class C extends Base{}new C');assert.equal(r.constructors[0].implicitConstructor,true);assert.equal(r.constructors[0].base,'Base');
 assert.equal(r.constructors[0].transitiveEffectsQualified,false);
});
