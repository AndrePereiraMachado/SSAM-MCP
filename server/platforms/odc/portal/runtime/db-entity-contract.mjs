import {fail} from './errors.mjs';
const name = row => row.OriginalName || row.Name;
const record = x => x && typeof x === 'object' && !Array.isArray(x);
const identifierTypes = new Set(['Integer','LongInteger','Text']);

// Metadata-only equivalent of GitSSAM's object_contracts. Adjustments are
// returned explicitly so a plan can be reviewed before its native save.
export function entityUpdate(entity, attributes, {contract, remove=false, nullWriteBehavior='ConvertNull'}={}) {
 const reject = message => fail('INPUT_INVALID',message);
 if (contract!==undefined&&!record(contract)) reject('Entity contract must be an object.');
 const config=contract??{}, overrides=config.attributes??{};
 if(!record(overrides)||Object.keys(config).some(k=>!['name','identifier','attributes'].includes(k)))reject('Invalid entity contract fields.');
 if(remove&&contract!==undefined)reject('Removal cannot rename or redefine entity metadata.');
 for(const key of ['name','identifier'])if(config[key]!==undefined&&typeof config[key]!=='string')reject('Entity names and identifier must be strings.');
 if(config.name!==undefined&&!config.name.trim())reject('Entity name cannot be empty.');
 const available=new Map(attributes.map(a=>[name(a),a]));
 if(available.size!==attributes.length||attributes.some(a=>!name(a)))reject('Native attribute identities are ambiguous.');
 for(const [original,value] of Object.entries(overrides)){
  if(!available.has(original)||!record(value)||Object.keys(value).some(k=>!['name','selected'].includes(k)))reject('Attribute contract must name an exposed attribute and supported fields.');
  if(value.name!==undefined&&(typeof value.name!=='string'||!value.name.trim()))reject('Attribute name cannot be empty.');
  if(value.selected!==undefined&&typeof value.selected!=='boolean')reject('Attribute selected must be boolean.');
 }
 const originalKeys=attributes.filter(a=>a.IsPrimaryKey).map(name);
 const explicit=Object.hasOwn(config,'identifier');
 const primary=explicit?config.identifier.trim():name(attributes.find(a=>a.IsPrimaryKey&&identifierTypes.has(a.DataType))??attributes.find(a=>a.IsPrimaryKey)??{});
 if(primary&&!available.has(primary))reject('Identifier must name an exposed original attribute.');
 const adjustments=[];
 if(originalKeys.length>1&&primary)adjustments.push({table:name(entity),reason:'composite_primary_key',selectedPrimaryKey:primary,originalPrimaryKeys:originalKeys.join(', ')});
 const rows=attributes.map(a=>{
  const original=name(a), override=overrides[original];
  const selected=remove?Boolean(a.IsMandatory||a.IsPrimaryKey):override?Boolean(override.selected):Object.keys(overrides).length===0;
  const isPrimaryKey=remove?Boolean(a.IsPrimaryKey):Boolean(selected&&primary===original);
  let type=a.DataType??'';
  if(isPrimaryKey&&!remove&&!identifierTypes.has(type)){
   const native=String(a.OriginalDataType??'').toUpperCase();type=native==='BIGINT'?'LongInteger':['CHAR','NCHAR','NVARCHAR','TEXT','VARCHAR'].includes(native)?'Text':'Integer';
   adjustments.push({table:name(entity),reason:'primary_key_data_type',attribute:original,originalDataType:a.DataType,selectedDataType:type});
  }
  return {Id:a.AttributeId??a.Id??'',OriginalName:original,Name:override?.name?.trim()||a.Name||original,Description:a.Description??'',
   IsSelected:a.ChangeStatus!=='Deleted'&&selected,ChangeStatus:a.ChangeStatus||'Unchanged',DefaultValue:isPrimaryKey||a.IsDefaultPrimaryKey?'':a.DefaultValue??'',
   HasCustomDefaultValue:!isPrimaryKey&&!a.IsDefaultPrimaryKey&&Boolean(a.HasCustomDefaultValue),DataType:type,IsPrimaryKey:isPrimaryKey};
 });
 const selectedNames=rows.filter(a=>a.IsSelected).map(a=>a.Name.toLowerCase());
 if(new Set(selectedNames).size!==selectedNames.length)reject('Selected attribute names must be unique.');
 if(!remove&&rows.every(a=>!a.IsSelected))reject('An imported entity must select at least one attribute.');
 if(!remove&&explicit&&primary&&!rows.some(a=>a.OriginalName===primary&&a.IsSelected))reject('The explicit identifier must be selected.');
 return {update:{EntityId:entity.EntityId??entity.Id??'',OriginalName:name(entity),Name:config.name?.trim()||entity.Name||name(entity),Description:entity.Description??'',
  IsSelected:!remove,NullWriteBehavior:entity.NullWriteBehavior||nullWriteBehavior,HasCustomNullWriteBehavior:Boolean(entity.HasCustomNullWriteBehavior),Attributes:{List:rows}},adjustments};
}
