import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeOutputShape} from '../debug-native-output-shape.mjs';
test('wire shape distinguishes omitted fields and never retains scalar values',()=>{
 const value={Rows:[{Label:'PRIVATE_VALUE'},{Id:'X',Label:'second',Count:42,Enabled:true}],Password:'PRIVATE_PASSWORD'};
 const shape=nativeOutputShape(value);
 assert.deepEqual(Object.keys(shape.fields.Rows.items[0].fields),['Label']);
 assert.deepEqual(Object.keys(shape.fields.Rows.items[1].fields),['Id','Label','Count','Enabled']);
 assert.equal(shape.fields.Password.type,'string');assert.doesNotMatch(JSON.stringify(shape),/PRIVATE_VALUE|PRIVATE_PASSWORD|second|42/);
 assert.equal(value.Rows[0].Label,'PRIVATE_VALUE');
});
test('private field names, cycles and structural budgets remain explicit',()=>{
 const value={safe:'value',PrivateUser:'hidden'};value.self=value;
 const shape=nativeOutputShape(value,['PrivateUser']);assert.equal(shape.omittedFields,1);
 assert.equal(shape.fields.self.reason,'repeated-object');assert.doesNotMatch(JSON.stringify(shape),/PrivateUser|hidden/);
 const rows=nativeOutputShape(Array.from({length:301},()=>({Id:1})));
 assert.equal(rows.items.length,20);assert.equal(rows.omittedItems,281);
});
