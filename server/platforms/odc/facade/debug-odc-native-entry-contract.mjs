// Structural admission only. This reader cannot issue a runtime capability,
// authenticate, grant roles, certify freshness or authorize an invocation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {workspaceRoot} from './workspace.mjs';

const SHA=/^[a-f0-9]{64}$/, KEY=/^[A-Za-z0-9_+]{22}$/, NAME=/^[A-Za-z_][A-Za-z0-9_]{0,120}$/;
const VIEW=/^[A-Za-z_][A-Za-z0-9_]{0,120}\.[A-Za-z_][A-Za-z0-9_]{0,120}$/;
const ASSET=/^_oschunk-[A-Z0-9]+\.js$/, SELECTOR=/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,6}$/;
const forbidden=new Set(['__proto__','prototype','constructor']);
const fail=code=>{throw new Error('debug_odc_native_'+code);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function freeze(value){if(object(value)||Array.isArray(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function exact(value,fields){if(!object(value)||Object.keys(value).sort().join(',')!==[...fields].sort().join(','))fail('source_schema_invalid');}
function selector(value){return typeof value==='string'&&SELECTOR.test(value)&&!value.split('.').some(part=>forbidden.has(part));}
function complete(tree){
 if(!object(tree)||!Array.isArray(tree.children)||tree.childrenOmitted!==0||tree.childrenTotal!==tree.children.length||
  !object(tree.propertyErrors)||!object(tree.propertiesOmitted)||!Array.isArray(tree.propertiesMissing)||
  Object.keys(tree.propertyErrors).length||Object.keys(tree.propertiesOmitted).length||tree.propertiesMissing.length)fail('projection_incomplete');
 for(const child of tree.children)complete(child);
}
const ref=(node,name)=>node.propertyReferences?.[name]?.key;
function connector(node,target){
 const rows=node.children.filter(child=>child.kind==='ActionConnector');
 if(node.properties?.IsDisabled!=='False'||ref(node,'Target')!==target||rows.length!==1||ref(rows[0],'Target')!==target||rows[0].children.length)fail('native_graph_invalid');
}
function endNode(node){if(node?.kind!=='EndNode'||node.properties?.IsDisabled!=='False'||node.children.length||ref(node,'Target')!==undefined)fail('native_graph_invalid');}
function dataActionProjection(tree,entry,io,binding){
 const flows=tree.children.filter(node=>['StartNode','ExecuteServerActionNode','AssignNode','EndNode'].includes(node.kind));
 if(tree.kind!=='DataAction'||tree.key!==entry.actionKey||tree.properties?.Name!==entry.action||tree.properties?.Fetch!=='AtStart'||flows.length!==4||tree.children.length!==6)fail('native_entry_unsupported');
 if(new Set(flows.map(node=>node.key)).size!==4||flows.some(node=>!KEY.test(node.key??'')))fail('native_graph_invalid');
 const starts=flows.filter(node=>node.kind==='StartNode'),calls=flows.filter(node=>node.kind==='ExecuteServerActionNode'),assigns=flows.filter(node=>node.kind==='AssignNode'),ends=flows.filter(node=>node.kind==='EndNode');
 if([starts,calls,assigns,ends].some(rows=>rows.length!==1))fail('native_graph_invalid');
 const [start]=starts,[call]=calls,[assign]=assigns,[end]=ends;
 if(ref(call,'Action')!==binding.signatureKey||call.propertyReferences?.Action?.kind!=='ServerActionSignature'||call.properties?.Name!==binding.localCallName||call.children.some(child=>child.kind!=='ActionConnector'))fail('native_import_invalid');
 connector(start,call.key);connector(call,assign.key);connector(assign,end.key);endNode(end);
 const outputs=tree.children.filter(node=>node.kind==='OutputParameter'),events=tree.children.filter(node=>node.kind==='UILifeCycleEvent');
 const assignment=assign.children.filter(node=>node.kind==='Assignment');
 if(start.children.some(child=>child.kind!=='ActionConnector')||outputs.length!==1||outputs[0].children.length||outputs[0].properties?.Name!==io.name||ref(outputs[0],'DataType')!==io.nativeListTypeKey||events.length!==1||
  events[0].key!==entry.actionKey+'.#OnAfterFetch'||events[0].children.length||assignment.length!==1||
  assignment[0].properties?.Variable!==io.name||assignment[0].properties?.Value!==binding.localCallName+'.'+binding.outputName||
  assignment[0].children.length!==2||assignment[0].children.some(child=>child.kind!=='TextBasedExpression'||child.children.length))fail('native_io_invalid');
 if(assign.children.some(child=>!['Assignment','ActionConnector'].includes(child.kind)))fail('native_graph_invalid');
 return {actionKey:tree.key,inputCount:0,outputCount:1,nodes:flows.map(({key,kind})=>({key,kind})),plannedLibraryCalls:1};
}
function producerProjection(tree,io,binding){
 if(tree.kind!=='ServerAction'||tree.key!==binding.originalActionKey||tree.properties?.Name!==binding.producerAction)fail('native_import_invalid');
 const flows=tree.children.filter(node=>['StartNode','ExecuteServerActionNode','EndNode'].includes(node.kind));
 const outputs=tree.children.filter(node=>node.kind==='OutputParameter');
 if(outputs.length!==1||outputs[0].children.length||outputs[0].properties?.Name!==binding.outputName||ref(outputs[0],'DataType')!==binding.producerListTypeKey||tree.children.length!==flows.length+1)fail('native_io_invalid');
 const byKey=new Map(flows.map(node=>[node.key,node])),starts=flows.filter(node=>node.kind==='StartNode'),ends=flows.filter(node=>node.kind==='EndNode');
 if(flows.length<4||flows.length>2002||byKey.size!==flows.length||starts.length!==1||ends.length!==1)fail('native_graph_invalid');
 const visited=new Set(),nodes=[];let node=starts[0],lastGet,staticGets=0,listAppends=0;
 while(node){
  if(visited.has(node.key))fail('native_graph_invalid');visited.add(node.key);nodes.push({key:node.key,kind:node.kind});
  if(node.kind==='EndNode'){endNode(node);break;}
  const next=ref(node,'Target');connector(node,next);if(!byKey.has(next))fail('native_graph_invalid');
  if(node.kind==='ExecuteServerActionNode'){
   if(node.children.some(child=>!['Argument','ActionConnector'].includes(child.kind)))fail('closure_unsupported');
   const args=node.children.filter(child=>child.kind==='Argument');for(const arg of args)if(arg.children.length!==1||arg.children[0].kind!=='TextBasedExpression'||arg.children[0].children.length)fail('closure_unsupported');
   if(ref(node,'Action')===binding.staticEntityKey+'.#GetEntity'&&node.propertyReferences.Action.kind==='EntityActionSignature'){
    if(lastGet||args.length!==1||ref(args[0],'Parameter')!==binding.staticEntityKey+'.#GetEntity.#Id'||
     !new RegExp('^Entities\\.'+binding.staticEntityName+'\\.[A-Za-z0-9_]+$').test(args[0].properties?.Value??''))fail('closure_unsupported');
    staticGets++;lastGet=node;
   }else if(ref(node,'Action')===binding.listAppendSignatureKey&&node.propertyReferences.Action.kind==='ServerActionSignature'){
    const list=args.find(arg=>ref(arg,'Parameter')===binding.listParameterKey),element=args.find(arg=>ref(arg,'Parameter')===binding.elementParameterKey);
    if(!lastGet||args.length!==2||list?.properties?.Value!==binding.outputName||element?.properties?.Value!==lastGet.properties?.Name+'.Record'||
     ref(element,'ConcreteParameterType')!==binding.staticEntityKey||element.propertyReferences?.ConcreteParameterType?.kind!=='StaticEntity')fail('closure_unsupported');
    listAppends++;lastGet=undefined;
   }else fail('closure_unsupported');
  }else if(node.kind!=='StartNode'||node.children.some(child=>child.kind!=='ActionConnector'))fail('closure_unsupported');
  node=byKey.get(next);
 }
 if(visited.size!==flows.length||lastGet||!staticGets||staticGets!==listAppends)fail('native_graph_invalid');
 return {nodes,plannedStaticEntityGets:staticGets,plannedMemoryListAppends:listAppends,otherCalls:0};
}

export function readOdcNativeBlockEntryContract(reference,expectedTarget,{root=workspaceRoot}={}){
 if(!path.isAbsolute(root??''))fail('source_path_invalid');
 const scope=path.join(path.resolve(root),'.local','debugger'),pins=[];
 function read(pin,limit=5*1024*1024){
  exact(pin,['path','sha256']);if(!path.isAbsolute(pin.path??'')||!SHA.test(pin.sha256??''))fail('source_pin_invalid');
  const resolved=path.resolve(pin.path),relative=path.relative(scope,resolved);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('source_path_invalid');
  let bytes;try{if(fs.realpathSync(resolved)!==resolved||!fs.lstatSync(resolved).isFile())fail('source_path_invalid');bytes=fs.readFileSync(resolved);}catch(error){if(error.message?.startsWith('debug_odc_native_'))throw error;fail('source_unavailable');}
  if(bytes.length>limit||hash(bytes)!==pin.sha256)fail('source_changed');pins.push({...pin});return bytes;
 }
 const json=pin=>{const bytes=read(pin);try{return JSON.parse(bytes);}catch{fail('source_json_invalid');}};
 const value=json(reference);
 exact(value,['schema','target','consumerSnapshot','runtime','abi','entry','output','readings','importBinding']);
 if(value.schema!=='ssam-odc-native-block-dataaction-source/1')fail('source_schema_invalid');
 const target=value.target;
 exact(target,['lane','tenant','runtimeUrl','app','module','moduleKey','consumerRevision','consumerSourceSha256']);
 if(target.lane!=='odc'||!NAME.test(target.app??'')||target.module!==target.app||!KEY.test(target.moduleKey??'')||
  !Number.isSafeInteger(target.consumerRevision)||target.consumerRevision<1||!SHA.test(target.consumerSourceSha256??''))fail('target_invalid');
 let url,tenant;try{url=new URL(target.runtimeUrl);tenant=new URL('https://'+target.tenant);}catch{fail('target_invalid');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'+target.app+'/'||
  tenant.hostname!==target.tenant||tenant.pathname!=='/'||tenant.username||tenant.password||tenant.port||tenant.search||tenant.hash)fail('target_invalid');
 if(!object(expectedTarget)||['lane','tenant','runtimeUrl','app','module','moduleKey','consumerRevision','consumerSourceSha256'].some(key=>expectedTarget[key]!==undefined&&expectedTarget[key]!==target[key])||
  ['lane','tenant','runtimeUrl','module','moduleKey'].some(key=>expectedTarget[key]===undefined))fail('target_mismatch');
 const consumer=read(value.consumerSnapshot,100*1024*1024);if(hash(consumer)!==target.consumerSourceSha256)fail('source_changed');
 const runtime=value.runtime;exact(runtime,['moduleVersion','manifest','versionInfo','provenance','assets']);
 if(typeof runtime.moduleVersion!=='string'||!runtime.moduleVersion||/[\x00-\x20\x7f]/.test(runtime.moduleVersion))fail('abi_invalid');
 const manifest=json(runtime.manifest),version=json(runtime.versionInfo),provenance=json(runtime.provenance);
 if(manifest?.manifest?.versionToken!==runtime.moduleVersion||version?.versionToken!==runtime.moduleVersion||
  provenance.runtimeUrl!==target.runtimeUrl||Number(provenance.appVersion)!==target.consumerRevision||provenance.moduleVersion!==runtime.moduleVersion||
  provenance.missingImports?.length!==0||provenance.unresolvedImports?.length!==0||!Array.isArray(provenance.requests))fail('publication_binding_invalid');
 if(!Array.isArray(runtime.assets)||runtime.assets.length<4||runtime.assets.length>500||new Set(runtime.assets.map(row=>row.name)).size!==runtime.assets.length)fail('abi_invalid');
 const assets=new Set();for(const asset of runtime.assets){
  exact(asset,['name','source']);if(!ASSET.test(asset.name??''))fail('abi_invalid');read(asset.source);
  const rows=provenance.requests.filter(row=>row.local===asset.name&&row.status===200&&row.sha256===asset.source.sha256);
  let assetUrl;try{assetUrl=rows.length===1?new URL(rows[0].url):undefined;}catch{fail('abi_invalid');}
  if(!assetUrl||assetUrl.origin!==url.origin||assetUrl.username||assetUrl.password||assetUrl.hash||assetUrl.pathname!=='/'+target.app+'/scripts/'+asset.name)fail('abi_invalid');assets.add(asset.name);
 }
 for(const row of provenance.requests.filter(row=>row.kind==='esm'))if(!assets.has(row.local))fail('abi_invalid');
 const abi=value.abi;exact(abi,['definition','core','debugger','viewFramework','parentController','blockController','roles','clientVariables']);
 for(const file of Object.values(abi))if(!assets.has(file))fail('abi_invalid');
 const entry=value.entry;exact(entry,['kind','action','actionKey','refreshMethod','dataProperty','endpoint','apiVersion','parent','block','ownerBinding']);
 if(entry.kind!=='native-block-dataaction'||!NAME.test(entry.action??'')||!KEY.test(entry.actionKey??'')||!KEY.test(entry.apiVersion??'')||
  !selector(entry.refreshMethod)||!selector(entry.dataProperty))fail('abi_invalid');
 if(expectedTarget.action!==undefined&&![entry.action,entry.actionKey].includes(expectedTarget.action))fail('target_mismatch');
 for(const owner of [entry.parent,entry.block]){exact(owner,['key','displayName','modelPath','modelFactory','controllerFactory']);if(!KEY.test(owner.key??'')||!VIEW.test(owner.displayName??'')||!selector(owner.modelFactory)||!selector(owner.controllerFactory))fail('abi_invalid');}
 const [flow,blockName]=entry.block.displayName.split('.');
 const [parentFlow,parentName]=entry.parent.displayName.split('.');
 if(entry.parent.key===entry.block.key||entry.parent.modelPath!==`MobileFlow:${parentFlow}/MobileScreen:${parentName}`||
  entry.block.modelPath!==`MobileFlow:${flow}/MobileBlock:${blockName}`||entry.endpoint!==`/${target.module}/screenservices/${target.module}/${flow}/${blockName}/DataAction${entry.action}`)fail('owner_binding_invalid');
 exact(entry.ownerBinding,['parentKey','blockKey','widgetKey','widgetName','widgetAlias','viewName','nativePermissionMethod']);
 const owner=entry.ownerBinding;
 if(owner.parentKey!==entry.parent.key||owner.blockKey!==entry.block.key||!KEY.test(owner.widgetKey??'')||!NAME.test(owner.widgetName??'')||
  typeof owner.widgetAlias!=='string'||!/^\d{1,9}$/.test(owner.widgetAlias)||owner.viewName!==entry.parent.displayName||owner.nativePermissionMethod!=='checkPermissions')fail('owner_binding_invalid');
 const output=value.output;exact(output,['name','attribute','kind','elementRuntimeName','nativeListTypeKey','nativeElementTypeKey','fields']);
 if(!NAME.test(output.name??'')||!selector(output.attribute)||output.kind!=='RecordList'||!NAME.test(output.elementRuntimeName??'')||
  !KEY.test(output.nativeListTypeKey??'')||!KEY.test(output.nativeElementTypeKey??'')||!Array.isArray(output.fields)||!output.fields.length||output.fields.length>100||new Set(output.fields.map(row=>row.name)).size!==output.fields.length)fail('native_io_invalid');
 for(const field of output.fields){exact(field,['name','attribute','type']);if(!NAME.test(field.name??'')||!selector(field.attribute)||!['Text','Integer','Boolean'].includes(field.type))fail('native_io_invalid');}
 const importPin=value.importBinding;const binding=json(importPin);
 exact(binding,['schema','consumerSourceSha256','producerSnapshot','producerModule','producerRevision','producerSourceSha256','referenceKey','signatureKey','originalActionKey','producerAction','localCallName','outputName','consumerListTypeKey','consumerElementTypeKey','producerListTypeKey','staticEntityKey','staticEntityName','listAppendModule','listAppendName','listAppendSignatureKey','listParameterKey','elementParameterKey']);
 if(binding.schema!=='ssam-odc-native-block-import-binding/1'||binding.consumerSourceSha256!==target.consumerSourceSha256||!NAME.test(binding.producerModule??'')||
  !Number.isSafeInteger(binding.producerRevision)||binding.producerRevision<1||!SHA.test(binding.producerSourceSha256??'')||
  ['referenceKey','signatureKey','originalActionKey','consumerListTypeKey','consumerElementTypeKey','producerListTypeKey','staticEntityKey','listAppendSignatureKey','listParameterKey','elementParameterKey'].some(key=>!KEY.test(binding[key]??''))||
  ['producerAction','localCallName','outputName','staticEntityName'].some(key=>!NAME.test(binding[key]??''))||binding.listAppendModule!=='System'||binding.listAppendName!=='ListAppend'||
  binding.consumerListTypeKey!==output.nativeListTypeKey||binding.consumerElementTypeKey!==output.nativeElementTypeKey)fail('native_import_invalid');
 if(hash(read(binding.producerSnapshot,100*1024*1024))!==binding.producerSourceSha256)fail('source_changed');
 exact(value.readings,['owner','ownerRuntime','outputRuntime','dataAction','producer']);
 const native=(pin,module,sourceSha256)=>{const reading=json(pin);if(reading.schema!=='ssam-reading/1'||reading.model!==module||reading.sourceSha256?.toLowerCase()!==sourceSha256)fail('projection_binding_invalid');complete(reading.tree);return reading.tree;};
 const ownerTree=native(value.readings.owner,target.module,target.consumerSourceSha256);
 if(ownerTree.key!==owner.widgetKey||ownerTree.kind!=='MobileBlockInstanceWidget'||ownerTree.properties?.Name!==owner.widgetName||
  ref(ownerTree,'SourceBlock')!==entry.block.key||ownerTree.propertyReferences?.SourceBlock?.kind!=='MobileBlock'||
  !ownerTree.path?.startsWith(entry.parent.modelPath+'/')||ownerTree.path.split('/').at(-1)!=='MobileBlockInstanceWidget:'+owner.widgetName)fail('owner_binding_invalid');
 // Widget aliases and factory selectors are generated-runtime bindings, not
 // native Model API properties. Their captured ABI remains unqualified here.
 const runtimeOwner=json(value.readings.ownerRuntime);
 exact(runtimeOwner,['schema','consumerSourceSha256','parentControllerFile','parentControllerSha256','parentKey','blockKey','parentDisplayName','blockDisplayName','viewName','widgetName','widgetAlias','parentModelFactory','parentControllerFactory','blockModelFactory','blockControllerFactory']);
 const parentAsset=runtime.assets.find(asset=>asset.name===abi.parentController);
 if(runtimeOwner.schema!=='ssam-odc-native-block-owner-runtime-binding/1'||runtimeOwner.consumerSourceSha256!==target.consumerSourceSha256||
  runtimeOwner.parentControllerFile!==abi.parentController||runtimeOwner.parentControllerSha256!==parentAsset.source.sha256||
  runtimeOwner.parentKey!==entry.parent.key||runtimeOwner.blockKey!==entry.block.key||runtimeOwner.parentDisplayName!==entry.parent.displayName||
  runtimeOwner.blockDisplayName!==entry.block.displayName||runtimeOwner.viewName!==owner.viewName||runtimeOwner.widgetName!==owner.widgetName||runtimeOwner.widgetAlias!==owner.widgetAlias||
  runtimeOwner.parentModelFactory!==entry.parent.modelFactory||runtimeOwner.parentControllerFactory!==entry.parent.controllerFactory||
  runtimeOwner.blockModelFactory!==entry.block.modelFactory||runtimeOwner.blockControllerFactory!==entry.block.controllerFactory)fail('owner_binding_invalid');
 const runtimeOutput=json(value.readings.outputRuntime);
 exact(runtimeOutput,['schema','consumerSourceSha256','typeAsset','typeAssetSha256','elementRuntimeName','nativeListTypeKey','nativeElementTypeKey','attributes']);
 const typeAsset=runtime.assets.find(asset=>asset.name===runtimeOutput.typeAsset),dataTypes={Text:4,Integer:0,Boolean:7};
 if(runtimeOutput.schema!=='ssam-odc-native-block-output-runtime-binding/1'||runtimeOutput.consumerSourceSha256!==target.consumerSourceSha256||
  !typeAsset||runtimeOutput.typeAssetSha256!==typeAsset.source.sha256||runtimeOutput.elementRuntimeName!==output.elementRuntimeName||
  runtimeOutput.nativeListTypeKey!==output.nativeListTypeKey||runtimeOutput.nativeElementTypeKey!==output.nativeElementTypeKey||
  !Array.isArray(runtimeOutput.attributes)||runtimeOutput.attributes.length!==output.fields.length)fail('native_io_invalid');
 for(let i=0;i<output.fields.length;i++){const field=output.fields[i],attribute=runtimeOutput.attributes[i];exact(attribute,['name','attribute','nativeDataType']);
  if(attribute.name!==field.name||attribute.attribute!==field.attribute||attribute.nativeDataType!==dataTypes[field.type])fail('native_io_invalid');}
 const consumerPlan=dataActionProjection(native(value.readings.dataAction,target.module,target.consumerSourceSha256),entry,output,binding);
 const producerPlan=producerProjection(native(value.readings.producer,binding.producerModule,binding.producerSourceSha256),output,binding);
 return freeze({schema:'ssam-odc-native-block-dataaction-structural-admission/1',structuralAccepted:true,sourceContractSha256:reference.sha256,
  target:Object.freeze({...target}),moduleVersion:runtime.moduleVersion,manifestSha256:runtime.manifest.sha256,abi:Object.freeze({...abi}),
  entry:JSON.parse(JSON.stringify(entry)),output:JSON.parse(JSON.stringify(output)),consumerPlan,producerPlan,pins,
  freshnessQualified:false,nativeOwnerIdentityQualified:false,nativePermissionsQualified:false,privateAuthenticationQualified:false,
  dependencyPublicSignatureCompared:false,executable:false,serverTracePermitted:false,requestOwnershipProved:false});
}
