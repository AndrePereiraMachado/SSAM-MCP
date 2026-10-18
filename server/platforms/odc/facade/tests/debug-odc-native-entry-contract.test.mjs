import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {workspaceRoot} from '../workspace.mjs';
import {readOdcNativeBlockEntryContract} from '../debug-odc-native-entry-contract.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const key=n=>'A'.repeat(19)+String(n).padStart(3,'0');
const node=(kind,k,properties={},references={},children=[])=>({kind,key:k,properties,propertyReferences:Object.fromEntries(Object.entries(references).map(([name,value])=>[name,typeof value==='string'?{key:value}:value])),children,childrenTotal:children.length,childrenOmitted:0,propertyErrors:{},propertiesOmitted:{},propertiesMissing:[]});
function fixture(app='ContractApp',action='LoadRegions'){
 const directory=path.join(workspaceRoot,'.local','debugger','tests','odc-native-block-contract',randomUUID());fs.mkdirSync(directory,{recursive:true});
 const save=(name,value)=>{const filename=path.join(directory,name);fs.writeFileSync(filename,typeof value==='string'?value:JSON.stringify(value));return{path:filename,sha256:digest(fs.readFileSync(filename))};};
 const snapshot=save('consumer.oml','EXPLICIT SYNTHETIC CONSUMER BYTES, NOT A NATIVE MODEL');
 const producer=save('producer.oml','EXPLICIT SYNTHETIC PRODUCER BYTES, NOT A NATIVE MODEL');
 const target={lane:'odc',tenant:'explicit-fixture.outsystems.dev',runtimeUrl:'https://explicit-fixture.outsystems.app/'+app+'/',app,module:app,moduleKey:key(1),consumerRevision:7,consumerSourceSha256:snapshot.sha256};
 const moduleVersion='explicit-fixture-version',assets=Array.from({length:4},(_,i)=>({name:'_oschunk-FIXTURE'+i+'.js',source:save('asset-'+i+'.js','// explicit synthetic source, never executed '+i)}));
 const runtime={moduleVersion,manifest:save('moduleinfo.json',{manifest:{versionToken:moduleVersion}}),versionInfo:save('moduleversioninfo.json',{versionToken:moduleVersion}),
  provenance:save('provenance.json',{runtimeUrl:target.runtimeUrl,appVersion:'7',moduleVersion,missingImports:[],unresolvedImports:[],requests:assets.map(asset=>({kind:'esm',status:200,local:asset.name,sha256:asset.source.sha256,url:new URL(app+'/scripts/'+asset.name,'https://explicit-fixture.outsystems.app/').href}))}),assets};
 const abi={definition:assets[0].name,core:assets[1].name,debugger:assets[1].name,viewFramework:assets[2].name,parentController:assets[3].name,blockController:assets[3].name,roles:assets[0].name,clientVariables:assets[0].name};
 const parent={key:key(2),displayName:'MainFlow.RegionScreen',modelPath:'MobileFlow:MainFlow/MobileScreen:RegionScreen',modelFactory:'parent.modelModule.create',controllerFactory:'parent.controllerModule.create'};
 const block={key:key(3),displayName:'MainFlow.RegionSelector',modelPath:'MobileFlow:MainFlow/MobileBlock:RegionSelector',modelFactory:'block.modelModule.create',controllerFactory:'block.controllerModule.create'};
 const ownerBinding={parentKey:parent.key,blockKey:block.key,widgetKey:key(4),widgetName:'SharedRegionSelector',widgetAlias:'8',viewName:parent.displayName,nativePermissionMethod:'checkPermissions'};
 const entry={kind:'native-block-dataaction',action,actionKey:key(5),refreshMethod:'getRegions$DataActRefresh',dataProperty:'getRegionsDataAct',endpoint:`/${app}/screenservices/${app}/MainFlow/RegionSelector/DataAction${action}`,apiVersion:key(6),parent,block,ownerBinding};
 const output={name:'Regions',attribute:'regionsOut',kind:'RecordList',elementRuntimeName:'Region',nativeListTypeKey:key(7),nativeElementTypeKey:key(8),fields:[{name:'Id',attribute:'idAttr',type:'Text'},{name:'Order',attribute:'orderAttr',type:'Integer'},{name:'Active',attribute:'activeAttr',type:'Boolean'}]};
 const binding={schema:'ssam-odc-native-block-import-binding/1',consumerSourceSha256:snapshot.sha256,producerSnapshot:producer,producerModule:'RegionLibrary',producerRevision:3,producerSourceSha256:producer.sha256,
  referenceKey:key(9),signatureKey:key(10),originalActionKey:key(11),producerAction:'FindRegions',localCallName:'GetRegions',outputName:'Regions',consumerListTypeKey:output.nativeListTypeKey,consumerElementTypeKey:output.nativeElementTypeKey,producerListTypeKey:key(12),
  staticEntityKey:key(13),staticEntityName:'Region',listAppendModule:'System',listAppendName:'ListAppend',listAppendSignatureKey:key(14),listParameterKey:key(15),elementParameterKey:key(16)};
 const connector=(from,to)=>node('ActionConnector',from+'.#Connector',{}, {Target:to});
 const flow=(kind,k,to,props={},refs={},extra=[])=>node(kind,k,{IsDisabled:'False',...props},{...refs,...(to?{Target:to}:{})},[...extra,...(to?[connector(k,to)]:[])]);
 const expression=text=>node('TextBasedExpression',key(99),{Text:text});
 const assignment=node('Assignment',key(21),{Variable:'Regions',Value:'GetRegions.Regions'}, {}, [expression('Regions'),expression('GetRegions.Regions')]);
 const dataTree=node('DataAction',entry.actionKey,{Name:action,Fetch:'AtStart'}, {}, [flow('StartNode',key(17),key(18)),flow('ExecuteServerActionNode',key(18),key(19),{Name:'GetRegions'},{Action:{key:binding.signatureKey,kind:'ServerActionSignature'}}),flow('AssignNode',key(19),key(20),{}, {},[assignment]),flow('EndNode',key(20)),node('OutputParameter',key(22),{Name:'Regions'},{DataType:output.nativeListTypeKey}),node('UILifeCycleEvent',entry.actionKey+'.#OnAfterFetch')]);
 const getArg=node('Argument',key(28),{Value:'Entities.Region.Active'}, {Parameter:binding.staticEntityKey+'.#GetEntity.#Id'},[expression('Entities.Region.Active')]);
 const listArg=node('Argument',key(29),{Value:'Regions'}, {Parameter:binding.listParameterKey},[expression('Regions')]);
 const elementArg=node('Argument',key(30),{Value:'ReadOne.Record'}, {Parameter:binding.elementParameterKey,ConcreteParameterType:{key:binding.staticEntityKey,kind:'StaticEntity'}},[expression('ReadOne.Record')]);
 const producerTree=node('ServerAction',binding.originalActionKey,{Name:binding.producerAction},{},[flow('StartNode',key(23),key(24)),flow('ExecuteServerActionNode',key(24),key(25),{Name:'ReadOne'},{Action:{key:binding.staticEntityKey+'.#GetEntity',kind:'EntityActionSignature'}},[getArg]),flow('ExecuteServerActionNode',key(25),key(26),{Name:'AppendOne'},{Action:{key:binding.listAppendSignatureKey,kind:'ServerActionSignature'}},[listArg,elementArg]),flow('EndNode',key(26)),node('OutputParameter',key(27),{Name:'Regions'},{DataType:binding.producerListTypeKey})]);
 const ownerTree=node('MobileBlockInstanceWidget',ownerBinding.widgetKey,{Name:ownerBinding.widgetName},{SourceBlock:{key:block.key,kind:'MobileBlock'}});ownerTree.path=parent.modelPath+'/MobileBlockInstanceWidget:'+ownerBinding.widgetName;
 const reading=(model,sourceSha256,tree)=>({schema:'ssam-reading/1',model,sourceSha256,tree});
 const ownerRuntime={schema:'ssam-odc-native-block-owner-runtime-binding/1',consumerSourceSha256:snapshot.sha256,parentControllerFile:abi.parentController,parentControllerSha256:assets[3].source.sha256,parentKey:parent.key,blockKey:block.key,parentDisplayName:parent.displayName,blockDisplayName:block.displayName,viewName:parent.displayName,widgetName:ownerBinding.widgetName,widgetAlias:ownerBinding.widgetAlias,parentModelFactory:parent.modelFactory,parentControllerFactory:parent.controllerFactory,blockModelFactory:block.modelFactory,blockControllerFactory:block.controllerFactory};
 const outputRuntime={schema:'ssam-odc-native-block-output-runtime-binding/1',consumerSourceSha256:snapshot.sha256,typeAsset:assets[3].name,typeAssetSha256:assets[3].source.sha256,elementRuntimeName:output.elementRuntimeName,nativeListTypeKey:output.nativeListTypeKey,nativeElementTypeKey:output.nativeElementTypeKey,attributes:output.fields.map(field=>({name:field.name,attribute:field.attribute,nativeDataType:{Text:4,Integer:0,Boolean:7}[field.type]}))};
 const readings={owner:save('owner.json',reading(app,snapshot.sha256,ownerTree)),ownerRuntime:save('owner-runtime.json',ownerRuntime),outputRuntime:save('output-runtime.json',outputRuntime),dataAction:save('data-action.json',reading(app,snapshot.sha256,dataTree)),producer:save('producer.json',reading(binding.producerModule,producer.sha256,producerTree))};
 const value={schema:'ssam-odc-native-block-dataaction-source/1',target,consumerSnapshot:snapshot,runtime,abi,entry,output,readings,importBinding:save('binding.json',binding)};
 const pin=()=>save('source-contract.json',value);
 return {directory,value,target,pin,save,dataTree,producerTree,ownerTree,binding,ownerRuntime,reading};
}
const read=f=>readOdcNativeBlockEntryContract(f.pin(),f.target);
test('structural contract supports different app/action names and stays immutable and unqualified',()=>{
 for(const [app,action] of [['ContractApp','LoadRegions'],['RenamedApp','FetchOptions']]){
  const f=fixture(app,action),r=read(f);assert.equal(r.structuralAccepted,true);assert.equal(r.consumerPlan.inputCount,0);assert.equal(r.consumerPlan.plannedLibraryCalls,1);assert.equal(r.producerPlan.plannedStaticEntityGets,1);
  for(const field of ['freshnessQualified','nativeOwnerIdentityQualified','nativePermissionsQualified','privateAuthenticationQualified','dependencyPublicSignatureCompared','executable','serverTracePermitted','requestOwnershipProved'])assert.equal(r[field],false);
  assert.throws(()=>{r.entry.ownerBinding.viewName='MainFlow.Foreign';},TypeError);assert.throws(()=>r.pins.push({}),TypeError);
 }
});
test('source/hash/target/schema tamper is refused without loading a runtime',()=>{
 const f=fixture();assert.throws(()=>readOdcNativeBlockEntryContract(f.pin(),{...f.target,module:'Other'}),/target_mismatch/);
 f.value.executable=true;assert.throws(()=>read(f),/source_schema_invalid/);delete f.value.executable;
 fs.appendFileSync(f.value.consumerSnapshot.path,'modified');assert.throws(()=>read(f),/source_changed/);
 const g=fixture();fs.appendFileSync(g.value.runtime.assets[0].source.path,'modified');assert.throws(()=>read(g),/source_changed/);
 const h=fixture();h.value.consumerSnapshot.path=path.join(workspaceRoot,'AGENTS.md');assert.throws(()=>read(h),/source_path_invalid/);
});
test('unknown ABI, dangerous selector and incomplete assets are refused',()=>{
 const f=fixture();f.value.entry.parent.controllerFactory='parent.constructor.create';assert.throws(()=>read(f),/abi_invalid/);
 const g=fixture();g.value.abi.parentController='_oschunk-ABSENT.js';assert.throws(()=>read(g),/abi_invalid/);
 const h=fixture();h.value.runtime.assets.pop();assert.throws(()=>read(h),/abi_invalid/);
 const i=fixture();i.value.runtime.moduleVersion='different';assert.throws(()=>read(i),/publication_binding_invalid/);
});
test('owner/view/factory/SourceBlock binding tamper is refused',()=>{
 const f=fixture();f.value.entry.ownerBinding.viewName='MainFlow.Foreign';assert.throws(()=>read(f),/owner_binding_invalid/);
 const g=fixture();g.value.entry.ownerBinding.widgetAlias='9';assert.throws(()=>read(g),/owner_binding_invalid/);
 const h=fixture();h.value.entry.parent.controllerFactory='wrong.controller.create';assert.throws(()=>read(h),/owner_binding_invalid/);
 const i=fixture();i.ownerTree.propertyReferences.SourceBlock.key=key(88);i.value.readings.owner=i.save('owner.json',i.reading(i.target.module,i.target.consumerSourceSha256,i.ownerTree));assert.throws(()=>read(i),/owner_binding_invalid/);
});
test('complete projections and exact import/type bindings are required',()=>{
 const f=fixture();f.dataTree.childrenOmitted=1;f.value.readings.dataAction=f.save('data-action.json',f.reading(f.target.module,f.target.consumerSourceSha256,f.dataTree));assert.throws(()=>read(f),/projection_incomplete/);
 const g=fixture();g.dataTree.children[1].propertyErrors.Action='fixture read failure';g.value.readings.dataAction=g.save('data-action.json',g.reading(g.target.module,g.target.consumerSourceSha256,g.dataTree));assert.throws(()=>read(g),/projection_incomplete/);
 const h=fixture();h.binding.consumerElementTypeKey=key(89);h.value.importBinding=h.save('binding.json',h.binding);assert.throws(()=>read(h),/native_import_invalid/);
 const i=fixture();i.value.output.fields[0].type='Binary';assert.throws(()=>read(i),/native_io_invalid/);
 const j=fixture();j.value.output.fields[0].type='Boolean';assert.throws(()=>read(j),/native_io_invalid/);
});
test('closed zero-input graph rejects foreign calls, cycles, extra nodes and nonempty events',()=>{
 const f=fixture();f.producerTree.children[1].propertyReferences.Action={key:key(90),kind:'ServerActionSignature'};f.value.readings.producer=f.save('producer.json',f.reading(f.binding.producerModule,f.binding.producerSourceSha256,f.producerTree));assert.throws(()=>read(f),/closure_unsupported/);
 const g=fixture();g.dataTree.children[1].propertyReferences.Target.key=g.dataTree.children[1].key;g.value.readings.dataAction=g.save('data-action.json',g.reading(g.target.module,g.target.consumerSourceSha256,g.dataTree));assert.throws(()=>read(g),/native_graph_invalid/);
 const h=fixture();h.dataTree.children.push(node('InputParameter',key(91),{Name:'Extra'}));h.dataTree.childrenTotal++;h.value.readings.dataAction=h.save('data-action.json',h.reading(h.target.module,h.target.consumerSourceSha256,h.dataTree));assert.throws(()=>read(h),/native_entry_unsupported/);
 const i=fixture();i.dataTree.children[5].children.push(node('ExecuteClientActionNode',key(92)));i.dataTree.children[5].childrenTotal++;i.value.readings.dataAction=i.save('data-action.json',i.reading(i.target.module,i.target.consumerSourceSha256,i.dataTree));assert.throws(()=>read(i),/native_io_invalid/);
});
test('caller action mismatch and malformed/private asset URLs refuse with fixed public diagnostics',()=>{
 const f=fixture();assert.throws(()=>readOdcNativeBlockEntryContract(f.pin(),{...f.target,action:'OtherAction'}),/target_mismatch/);
 const g=fixture();const provenance=JSON.parse(fs.readFileSync(g.value.runtime.provenance.path));provenance.requests[0].url='invalid-url';g.value.runtime.provenance=g.save('provenance.json',provenance);assert.throws(()=>read(g),/^Error: debug_odc_native_abi_invalid$/);
 const h=fixture();const privateUrl=JSON.parse(fs.readFileSync(h.value.runtime.provenance.path));privateUrl.requests[0].url='https://fixture-user:fixture-private@explicit-fixture.outsystems.app/'+h.target.app+'/scripts/'+h.value.runtime.assets[0].name;h.value.runtime.provenance=h.save('provenance.json',privateUrl);assert.throws(()=>read(h),/^Error: debug_odc_native_abi_invalid$/);
});
test('aligned duplicate DataAction keys and nested producer calls are rejected as structure, not cuts',()=>{
 const f=fixture();f.dataTree.children[0].key=f.dataTree.children[1].key;f.value.readings.dataAction=f.save('data-action.json',f.reading(f.target.module,f.target.consumerSourceSha256,f.dataTree));assert.throws(()=>read(f),/native_graph_invalid/);
 const g=fixture();g.producerTree.children[0].children.push(node('ExecuteServerActionNode',key(93),{Name:'ExtraForeignCall'}));g.producerTree.children[0].childrenTotal++;g.value.readings.producer=g.save('producer.json',g.reading(g.binding.producerModule,g.binding.producerSourceSha256,g.producerTree));assert.throws(()=>read(g),/closure_unsupported/);
 const h=fixture();h.dataTree.children[0].children[0].children.push(node('ExecuteServerActionNode',key(94)));h.dataTree.children[0].children[0].childrenTotal++;h.value.readings.dataAction=h.save('data-action.json',h.reading(h.target.module,h.target.consumerSourceSha256,h.dataTree));assert.throws(()=>read(h),/native_graph_invalid/);
});
test('malformed missing/error/omitted projection metadata never counts as complete',()=>{
 for(const [property,value] of [['propertiesMissing',{}],['propertiesMissing',null],['propertyErrors',[]],['propertyErrors',null],['propertiesOmitted',[]],['propertiesOmitted',null]]){
  const f=fixture();f.dataTree[property]=value;f.value.readings.dataAction=f.save('data-action.json',f.reading(f.target.module,f.target.consumerSourceSha256,f.dataTree));assert.throws(()=>read(f),/projection_incomplete/);
 }
});
