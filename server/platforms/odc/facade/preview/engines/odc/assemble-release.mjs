import fs from 'node:fs';import path from 'node:path';import vm from 'node:vm';import {fileURLToPath} from 'node:url';
import {sha256,canonical,pinned,readPinned,requireThat,transportSignature,atomicJSON,exactRoute,verifyCodeLock} from './common.mjs';
import {definitions,closeAMD} from './amd-closure.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const mime=route=>({'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.ico':'image/x-icon'})[path.posix.extname(route).toLowerCase()];
function jsonAssignment(text,name){const prefix='window.'+name+'=',line=text.split(/\r?\n/).find(x=>x.startsWith(prefix));requireThat(line,'BASE_HOST_DATA',name);return JSON.parse(line.slice(prefix.length).replace(/;\s*$/,''));}
function artifact(a,origin){requireThat(exactRoute(a.route)&&a.route.startsWith('/view/')&&mime(a.route),'RESOURCE_ROUTE_SCOPE',a.route);return {...a,body:pinned(a),origin,contentType:mime(a.route)};}
export async function assembleRelease({compilerManifestPath,compilerManifestSha256,sourceSha256,outputDirectory,sessionId,configFile=path.join(here,'config.json')}){
 const started=performance.now();
 const config=JSON.parse(fs.readFileSync(configFile)),contract=readPinned(config.scenarioContract),plan=readPinned(contract.scenarioPlan),base=readPinned(config.baselineConfig),emitter=readPinned({file:compilerManifestPath,sha256:compilerManifestSha256});
 const codeLockPin=config.hostImplementation; verifyCodeLock(codeLockPin);
 requireThat(config.schema==='ssam-official-live-host-config/2'&&emitter.schema==='ssam-official-emission/1','SCHEMA');
 requireThat(emitter.generator?.kind==='o11-original-over-adapted-odc'&&emitter.receipt?.allStagesSucceeded===true,'OFFICIAL_EMISSION_REQUIRED');readPinned(emitter.receipt);
 requireThat(/^[a-f0-9]{64}$/.test(sourceSha256)&&emitter.source.sha256===sourceSha256&&emitter.source.moduleKey===config.target.moduleKey&&emitter.source.screenKey===config.target.screenKey,'SOURCE_TARGET_MISMATCH');
 requireThat(sha256(fs.readFileSync(emitter.source.path))===sourceSha256,'SOURCE_FILE_CHANGED');requireThat(/^[a-f0-9]{64}$/.test(emitter.buildId),'BUILD_ID');
 requireThat(emitter.contracts?.scenarioCompatible===true&&emitter.contracts.scenarioContractSha256===config.scenarioContract.sha256&&emitter.contracts.transportSignature===transportSignature([]),'SCENARIO_NOT_QUALIFIED');
 requireThat(plan.schema==='ssam-local-empty-scenario/1'&&plan.endpoints.length===0&&plan.clientOverrides.length===0&&Object.keys(plan.consumerStaticEntities).length===0,'EMPTY_SCENARIO_REQUIRED');
 requireThat(typeof sessionId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId),'SESSION_ID');
 const profile=emitter.profile;requireThat(profile?.kind==='native-screen'&&canonical(profile.target)===canonical(config.target),'ENTRY_PROFILE_MISMATCH');
 const catalog=readPinned(profile.routeCatalog),nativeScreen=catalog.screens.find(x=>x.sourceNativeKey===emitter.source.screenKey);
 requireThat(catalog.moduleName===config.target.module&&nativeScreen,'NATIVE_ROUTE_MISSING');
 const entry={view:nativeScreen.viewModuleName,model:nativeScreen.modelModuleName,controller:nativeScreen.controllerModuleName,flow:nativeScreen.webFlowControllerModuleName};
 requireThat(canonical(entry)===canonical(profile.entry),'NATIVE_ENTRY_TUPLE_MISMATCH');
 const files=new Map();
 for(const a of base.staticRoutes){if(a.route==='/'||a.route.startsWith('/host/')||a.route==='/view/index.html')continue;const item={...a,body:pinned(a),origin:'pinned-runtime-producer-cache'};if(a.route.endsWith('.js')){item.definitions=definitions(a.route,item.body);if(item.definitions.some(d=>d.id.startsWith(config.target.module+'.')))continue;}files.set(a.route,item);}
 const newArtifacts=[...(emitter.emitted??[]),...(emitter.resources??[])],fresh=new Map(),freshIds=new Set();
 for(const a of newArtifacts){requireThat(!fresh.has(a.route),'DUPLICATE_RESOURCE_ROUTE');requireThat(typeof a.originProfile==='string'&&a.originProfile.length>0,'RESOURCE_ORIGIN');const item=artifact(a,a.originProfile);if(a.route.endsWith('.js')){item.definitions=definitions(a.route,item.body);for(const d of item.definitions){requireThat(!d.id.startsWith('OutSystems/')&&!['react','react-dom','require','history'].includes(d.id),'RUNTIME_REPLACEMENT_REFUSED');freshIds.add(d.id);}}fresh.set(a.route,item);}
 requireThat(fresh.size>0,'EMPTY_EMISSION');
 // An emitted module replaces a cache file as a whole. Any lost dependency is then caught by the graph, never silently substituted.
 for(const [route,item]of files)if(!route.startsWith('/runtime/')&&item.definitions?.some(d=>freshIds.has(d.id)))files.delete(route);
 for(const [route,item]of fresh)files.set(route,item);
 for(const a of contract.requiredUnchangedArtifacts)requireThat(fresh.get(a.route)?.sha256===a.sha256,'CLIENT_VARIABLE_CONTRACT_CHANGED',a.route);
 const roots=[...Object.values(entry),config.target.module+'.controller',config.target.module+'.clientVariables',config.target.module+'.languageResources','OutSystems/ClientRuntime/Main','OutSystems/ClientRuntime/Injector','OutSystems/ClientRuntime/Injector/KnownServices','OutSystems/ClientRuntime/modules/LocaleService/LocaleService','OutSystems/ClientRuntime/modules/ClientVariables/LocalStorageClientVariablesService','OutSystems/ReactView/Router','OutSystems/ClientRuntime/Application','history'];
 const closure=closeAMD(files,roots);
 const oldData=pinned(base.staticRoutes.find(x=>x.route==='/host/bootstrap-data.js')).toString('utf8'),oldCatalog=jsonAssignment(oldData,'__nativeConsumerRouteCatalog'),modules=jsonAssignment(oldData,'__nativeScenarioModules');
 requireThat(oldCatalog.moduleKey===catalog.moduleKey,'CONSUMER_MODULE_GUID_CHANGED');
 const oldModule=modules[catalog.moduleKey];requireThat(oldModule?.moduleName===catalog.moduleName,'CONSUMER_MODULE_METADATA');
 modules[catalog.moduleKey]={...oldModule,moduleName:catalog.moduleName,homeScreenName:catalog.homeScreenName,splashScreenName:catalog.splashScreenName,screens:catalog.screens,staticEntities:{}};
 if(profile.moduleDefinitions){const nativeModules=readPinned(profile.moduleDefinitions);requireThat(nativeModules[catalog.moduleKey]?.moduleName===catalog.moduleName&&Object.keys(nativeModules[catalog.moduleKey].staticEntities??{}).length===0,'EMPTY_CONSUMER_CONSTANTS_REQUIRED');Object.assign(modules,nativeModules);}
 const clientMetadata=readPinned(contract.nativeClientVariables),clientRoute='/view/scripts/'+config.target.module+'.clientVariables.js';requireThat(clientMetadata.variables.length===70&&clientMetadata.source.sha256===fresh.get(clientRoute)?.sha256,'CLIENT_METADATA_MISMATCH');
 const frameConfig={canStart:true,activationId:sessionId,applicationName:config.target.module,module:config.target.module,entryScreenKey:config.target.screenKey,entry,authorization:base.authorization,nativeClientVariables:clientMetadata.variables};
 const assignments={__nativeConsumerRouteCatalog:catalog,__nativeScenarioModules:modules,__typedScenarioClientValues:[],__contextSourceSha256:base.authorization.contextInstallerSha256,__candidateExecutionConfig:frameConfig,__officialHostTarget:config.target};
 files.set('/host/bootstrap-data.js',{body:Buffer.from(Object.entries(assignments).map(([name,value])=>'window.'+name+'='+JSON.stringify(value)+';').join('\n')),contentType:'text/javascript; charset=utf-8',origin:'host-native-metadata-adapter'});
 for(const name of ['context-proposal.js','instrument.js']){const a=base.staticRoutes.find(x=>x.route==='/host/'+name);files.set(a.route,{body:pinned(a),contentType:a.contentType,origin:'pinned-v5-context-and-evidence'});}
 for(const name of ['entry-bootstrap.js','frame-report.js','start-gate.js'])files.set('/host/'+name,{body:fs.readFileSync(path.join(here,name)),contentType:'text/javascript; charset=utf-8',origin:'host-entry-and-evidence'});
 const runtimeOrder=base.staticRoutes.filter(a=>a.route.startsWith('/runtime/')).map(a=>a.route),moduleOrder=closure.moduleRoutes.filter(x=>!x.startsWith('/runtime/')).sort();
 const scriptOrder=['/host/instrument.js','/host/frame-report.js',...runtimeOrder,'/host/bootstrap-data.js',...moduleOrder,'/host/context-proposal.js','/host/entry-bootstrap.js','/host/start-gate.js'];
 const html='<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Native screen preview</title><link rel="stylesheet" href="@@PREFIX@@/view/assets/OutSystemsReactWidgets.css"><body><div id="reactContainer"></div>'+scriptOrder.map(r=>'<script src="@@PREFIX@@'+r+'"></script>').join('')+'</body></html>';
 const identity={schema:'ssam-official-release-identity/2',compilerBuildId:emitter.buildId,sourceSha256,sessionId,target:config.target,entry,scenarioContractSha256:config.scenarioContract.sha256,codeLockSha256:codeLockPin.sha256,htmlTemplateSha256:sha256(html),assets:[...files].map(([route,a])=>({route,sha256:sha256(a.body)})).sort((a,b)=>a.route<b.route?-1:1)};
 const buildId=sha256(canonical(identity)),prefix='/builds/'+buildId;files.set('/view/index.html',{body:Buffer.from(html.replaceAll('@@PREFIX@@',prefix)),contentType:'text/html; charset=utf-8',origin:'host-generated-loader-only'});
 for(const [route,a]of files)if(route.endsWith('.js'))new vm.Script(a.body.toString('utf8'),{filename:route});
 requireThat(path.isAbsolute(outputDirectory)&&!fs.existsSync(outputDirectory),'OUTPUT_MUST_BE_FRESH');fs.mkdirSync(path.join(outputDirectory,'blobs'),{recursive:true});
 const assets=[];for(const [route,a]of files){const digest=sha256(a.body),file=path.join(outputDirectory,'blobs',digest);if(!fs.existsSync(file))fs.writeFileSync(file,a.body);assets.push({route,file,sha256:digest,contentType:a.contentType,origin:a.origin});}
 const timings={...(emitter.timingsMs??{}),assemblyMs:Math.round(performance.now()-started)},release={schema:'ssam-official-live-release/2',testOnly:emitter.testOnly===true,buildId,compilerBuildId:emitter.buildId,sourceSha256,source:emitter.source,sessionId,target:config.target,profile:{kind:profile.kind,entry,routeCatalog:profile.routeCatalog},generator:emitter.generator,compilerManifest:{file:compilerManifestPath,sha256:compilerManifestSha256},identity,assets,entry:prefix+'/view/index.html',scenarioPlan:contract.scenarioPlan,scenarioContract:config.scenarioContract,closure,timings,generatedBytesPreserved:true,limits:contract.limits};
 const manifestPath=path.join(outputDirectory,'release.json');atomicJSON(manifestPath,release);return{manifestPath,manifestSha256:sha256(fs.readFileSync(manifestPath)),buildId,sourceSha256,timings};
}
