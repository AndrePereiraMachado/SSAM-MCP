import test from 'node:test';import assert from 'node:assert/strict';
import {inspectOdcModelInputs} from '../debug-odc-model-inputs.mjs';
const fields=[{attribute:'seedIn',jsonName:'Seed'},{attribute:'_seedInDataFetchStatus',jsonName:'_seedInDataFetchStatus'}];
const source='setInputs(input){"Seed" in input&&(this.variables.seedIn=input.Seed,"_seedInDataFetchStatus" in input&&(this.variables._seedInDataFetchStatus=input._seedInDataFetchStatus))}';
test('guarded native input and data-fetch status copies preserve their exact dependency',()=>{
 const r=inspectOdcModelInputs(source,fields);assert.equal(r.setInputsQualified,true);
 assert.deepEqual(r.copies,[{input:'Seed',attribute:'seedIn',guards:['Seed']},
  {input:'_seedInDataFetchStatus',attribute:'_seedInDataFetchStatus',guards:['Seed','_seedInDataFetchStatus']}]);
 assert.equal(r.valuesChanged,false);assert.equal(r.executionAuthorized,false);
});
test('no-input screens and direct compound input copies need no alternate conversion',()=>{
 assert.deepEqual(inspectOdcModelInputs('setInputs(input){}',[]).copies,[]);
 for(const dataType of ['Integer','Record','List','BinaryData']){
  const r=inspectOdcModelInputs('setInputs(x){"Value" in x&&(this.variables.valueIn=x.Value)}',[{attribute:'valueIn',jsonName:'Value',dataType}]);
  assert.equal(r.copies[0].input,'Value');assert.equal(r.valuesRead,false);
 }
});
test('ungated copies, transformations, calls and unknown destination fields refuse',()=>{
 for(const s of ['setInputs(x){this.variables.seedIn=x.Seed}',
  'setInputs(x){"Other" in x&&(this.variables.seedIn=x.Seed)}',
  'setInputs(x){"Seed" in x&&(this.variables.seedIn=transform(x.Seed))}',
  'setInputs(x){"Seed" in x&&(this.variables.unknown=x.Seed)}',
  'setInputs(x){"Seed" in x&&(this.variables.seedIn=x.Other)}',
  'setInputs(x){"Seed" in x&&(this.variables.seedIn=x.Seed,send()))}',
  'setInputs(x){send()}', 'setInputs(x){return x}',
  'setInputs(x){"Seed" in x&&(this.variables.seedIn=x.Seed,this.variables.seedIn=x.Seed)}'])
  assert.throws(()=>inspectOdcModelInputs(s,fields));
});
test('computed paths, unsafe names and additional methods cannot inherit input-copy qualification',()=>{
 for(const s of [source.replace('this.variables.seedIn','this.variables["seedIn"]'),
  source.replace('input.Seed','other.Seed'),source+'extra(){send()}',
  source.replace('setInputs(input)','static setInputs(input)'),source.replace('setInputs(input)','async setInputs(input)')])
  assert.throws(()=>inspectOdcModelInputs(s,fields));
 assert.throws(()=>inspectOdcModelInputs('setInputs(x){}',[{attribute:'__proto__',jsonName:'Value'}]),/fields/);
});
