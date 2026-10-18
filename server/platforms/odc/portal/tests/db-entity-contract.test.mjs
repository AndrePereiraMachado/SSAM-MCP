import '../../facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {entityUpdate} from '../runtime/db-entity-contract.mjs';
const entity={EntityId:'e',OriginalName:'Cargo',Name:'Cargo'};
const attributes=[{AttributeId:'id',OriginalName:'id',Name:'id',DataType:'Integer',OriginalDataType:'INT',IsPrimaryKey:true},{AttributeId:'name',OriginalName:'nome',Name:'nome',DataType:'Text',OriginalDataType:'VARCHAR'},{AttributeId:'pay',OriginalName:'salario',Name:'salario',DataType:'Decimal',OriginalDataType:'DECIMAL'}];
test('custom entity and attribute names preserve original wire identity and explicit selection',()=>{
 const {update,adjustments}=entityUpdate(entity,attributes,{contract:{name:'Role',identifier:'id',attributes:{id:{name:'Id',selected:true},nome:{name:'Name',selected:true}}}});
 assert.equal(update.OriginalName,'Cargo');assert.equal(update.Name,'Role');assert.deepEqual(update.Attributes.List.map(a=>[a.OriginalName,a.Name,a.IsSelected,a.IsPrimaryKey]),[['id','Id',true,true],['nome','Name',true,false],['salario','salario',false,false]]);assert.deepEqual(adjustments,[]);
});
test('an explicit empty identifier produces selected attributes with no primary key',()=>{
 const result=entityUpdate(entity,attributes,{contract:{identifier:''}});assert(result.update.Attributes.List.every(a=>a.IsSelected&&!a.IsPrimaryKey));
});
test('composite identifiers choose the first supported type and report the adjustment',()=>{
 const attrs=[{...attributes[0],DataType:'Decimal'},{...attributes[1],IsPrimaryKey:true}];const result=entityUpdate(entity,attrs);
 assert.equal(result.update.Attributes.List[1].IsPrimaryKey,true);assert.equal(result.update.Attributes.List[0].IsPrimaryKey,false);assert.equal(result.adjustments[0].reason,'composite_primary_key');
});
test('unsupported identifier metadata conversions match the legacy explicit adjustments',()=>{
 for(const [native,expected] of [['BIGINT','LongInteger'],['VARCHAR','Text'],['DECIMAL','Integer']]){
  const result=entityUpdate(entity,[{...attributes[0],DataType:'Decimal',OriginalDataType:native}]);assert.equal(result.update.Attributes.List[0].DataType,expected);assert.equal(result.adjustments[0].reason,'primary_key_data_type');
 }
});
test('invalid or ambiguous contracts refuse before any network interaction',()=>{
 for(const contract of [{attributes:{missing:{selected:true}}},{identifier:'missing'},{identifier:'id',attributes:{nome:{selected:true}}},{attributes:{id:{selected:'true'}}},{name:''},{attributes:[]},{attributes:{id:{name:'Same',selected:true},nome:{name:'same',selected:true}}},{unknown:true}])assert.throws(()=>entityUpdate(entity,attributes,{contract}),{code:'INPUT_INVALID'});
 assert.throws(()=>entityUpdate(entity,[attributes[0],attributes[0]]),{code:'INPUT_INVALID'});
 assert.throws(()=>entityUpdate(entity,attributes,{remove:true,contract:{name:'Other'}}),{code:'INPUT_INVALID'});
});
