import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {sha256,canonical,pinned,readPinned,requireThat,atomicJSON,exactRoute} from './common.mjs';
import {definitions,closeAMD} from './amd-closure.mjs';
import {schemas,validateConfig,verifyImplementation,readContext,matchSelected} from './contracts.mjs';
import {readDataScenario} from './scenario-dispatcher.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const mime=route=>({'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.ico':'image/x-icon'})[path.posix.extname(route).toLowerCase()];
const runtimeRoots=['OutSystems/ClientRuntime/Main','OutSystems/ClientRuntime/Injector','OutSystems/ClientRuntime/Injector/KnownServices','OutSystems/ClientRuntime/modules/ClientVariables/LocalStorageClientVariablesService','OutSystems/ReactView/Router','OutSystems/ClientRuntime/Application','history'];
export async function assembleRelease({compilerManifestPath,compilerManifestSha256,sourceSha256,outputDirectory,sessionId,configFile}){
 const started=performance.now();
 requireThat(typeof configFile==='string'&&path.isAbsolute(configFile),'EXPLICIT_CONFIG_REQUIRED');
 const config=validateConfig(JSON.parse(fs.readFileSync(configFile)));verifyImplementation(config);
 requireThat(sessionId===config.stableSessionId,'SESSION_MISMATCH');
 const emitter=readPinned({file:compilerManifestPath,sha256:compilerManifestSha256});
 requireThat(emitter.schema==='ssam-official-emission/1'&&emitter.generator?.kind==='o11-original-native-model','NATIVE_O11_EMISSION_REQUIRED');
 requireThat(emitter.receipt?.allStagesSucceeded===true,'EMISSION_INCOMPLETE');readPinned(emitter.receipt);
 requireThat(/^[a-f0-9]{64}$/.test(sourceSha256)&&emitter.source?.sha256===sourceSha256&&emitter.source.moduleKey===config.target.moduleKey,'SOURCE_MISMATCH');
 requireThat(sha256(fs.readFileSync(emitter.source.path))===sourceSha256,'SOURCE_FILE_CHANGED');
 requireThat(/^[a-f0-9]{64}$/.test(emitter.buildId),'BUILD_ID');
 readDataScenario(config,emitter);
 const catalog=readPinned(emitter.profile.routeCatalog),selected=matchSelected(config,emitter,catalog);
 const modules=readPinned(emitter.profile.moduleDefinitions);
 requireThat(modules[catalog.moduleKey]?.moduleName===catalog.moduleName,'NATIVE_MODULE_DEFINITIONS_REQUIRED');
 const client=readPinned(emitter.profile.clientVariables);
 requireThat(client.schema==='ssam-native-client-variable-descriptors/1'&&client.moduleKey===config.target.moduleKey&&Array.isArray(client.variables),'NATIVE_CLIENT_VARIABLES_REQUIRED');
 requireThat(new Set(client.variables.map(v=>v.key)).size===client.variables.length&&new Set(client.variables.map(v=>v.name)).size===client.variables.length&&client.variables.every(v=>typeof v.key==='string'&&typeof v.name==='string'&&v.type!==undefined&&typeof v.hasDefault==='boolean'),'CLIENT_VARIABLE_DESCRIPTOR');
 const registry=readPinned(config.runtimeAssets);
 requireThat(registry.schema==='ssam-native-o11-runtime-assets/1'&&registry.generatorKind==='original-o11'&&registry.provenance&&Array.isArray(registry.assets),'EXPLICIT_RUNTIME_REGISTRY_REQUIRED');
 for(const pin of registry.moduleDefinitions??[]){
  const additions=readPinned(pin);
  for(const [key,value]of Object.entries(additions)){
   requireThat(!Object.hasOwn(modules,key)||canonical(modules[key])===canonical(value),'MODULE_DEFINITION_COLLISION',key);
   modules[key]=value;
  }
 }
 const files=new Map();
 function add(a,origin,{runtime=false}={}){
  requireThat(exactRoute(a.route)&&mime(a.route)&&!a.route.startsWith('/host/'),'ASSET_ROUTE',a.route);
  const body=pinned(a),old=files.get(a.route);
  requireThat(!old||sha256(old.body)===sha256(body),'ASSET_COLLISION',a.route);
  if(old)return;
  const item={...a,body,origin,contentType:mime(a.route)};
  if(a.route.endsWith('.js')){
   item.definitions=definitions(a.route,body);
   if(!runtime)requireThat(!item.definitions.some(d=>d.id.startsWith('OutSystems/')||['react','react-dom','require','history'].includes(d.id)),'RUNTIME_REPLACEMENT_REFUSED');
  }
  files.set(a.route,item);
 }
 for(const a of registry.assets){requireThat(['runtime','producer','shared-resource'].includes(a.kind),'ASSET_PROVENANCE_KIND');if(a.kind==='producer')requireThat(a.producer?.moduleKey&&a.producer?.sourceSha256&&a.producer.revision!==undefined,'PRODUCER_PROVENANCE');add(a,'pinned-'+a.kind,{runtime:a.kind==='runtime'});}
 for(const a of [...(emitter.emitted??[]),...(emitter.resources??[])]){
  requireThat(typeof a.originProfile==='string'&&a.originProfile.length>0&&a.route.startsWith('/view/'),'EMITTED_ASSET_PROVENANCE');add(a,a.originProfile);
 }
 const clientRoute=emitter.profile.clientVariablesRoute;
 requireThat(typeof clientRoute==='string'&&files.has(clientRoute)&&sha256(files.get(clientRoute).body)===client.source?.sha256,'CLIENT_VARIABLE_SOURCE_MISMATCH');
 const context=readContext(config),qualifiedEntries=config.qualifyAllEntries===false?[selected.entry]:selected.entries,roots=[...qualifiedEntries.flatMap(e=>[e.view,e.model,e.controller,e.flow]),config.target.module+'.controller',config.target.module+'.clientVariables',config.target.module+'.languageResources',...runtimeRoots];
 if(context?.context.locale){roots.push('OutSystems/ClientRuntime/modules/LocaleService/LocaleService');}
 const closure={...closeAMD(files,roots),qualifiedScreenKeys:qualifiedEntries.map(e=>e.screenKey)};
 const entryOptions=qualifiedEntries.map(entry=>({target:selected.targets.find(t=>t.screenKey===entry.screenKey),entry,location:context?.locations.find(l=>l.screenKey===entry.screenKey)?.location??null}));
 if(context)requireThat(entryOptions.every(x=>x.location),'QUALIFIED_ENTRY_LOCATION_REQUIRED');
 const frame={canStart:!!context,sessionId,bindHost:config.bindHost,module:config.target.module,entryScreenKey:config.target.screenKey,entry:selected.entry,entryLocation:context?.location.location??null,context:context?.context??null,application:context?.application??null,clientVariables:client.variables};
 const assignments={__nativeConsumerRouteCatalog:catalog,__nativeModules:modules,__nativeScreenConfig:frame,__officialHostTarget:config.target,__nativeEntryOptions:entryOptions};
 files.set('/host/bootstrap-data.js',{body:Buffer.from(Object.entries(assignments).map(([name,value])=>'window.'+name+'='+JSON.stringify(value)+';').join('\n')),contentType:'text/javascript; charset=utf-8',origin:'native-metadata-bootstrap'});
 for(const name of ['instrument.js','entry-bootstrap.js','frame-report.js','start-gate.js','select-entry.js'])files.set('/host/'+name,{body:fs.readFileSync(path.join(here,name)),contentType:'text/javascript; charset=utf-8',origin:'host-code'});
 if(context)files.set('/host/context-installer.js',{body:pinned(context.context.installer),contentType:'text/javascript; charset=utf-8',origin:'explicit-context-installer'});
 const runtimeOrder=registry.scriptOrder;
 requireThat(Array.isArray(runtimeOrder)&&new Set(runtimeOrder).size===runtimeOrder.length&&runtimeOrder.every(r=>files.has(r)&&registry.assets.some(a=>a.route===r&&a.kind==='runtime')),'RUNTIME_SCRIPT_ORDER');
 const moduleOrder=closure.moduleRoutes.filter(r=>!runtimeOrder.includes(r)).sort();
 const order=['/host/instrument.js','/host/frame-report.js',...runtimeOrder,'/host/bootstrap-data.js','/host/select-entry.js',...moduleOrder,...(context?['/host/context-installer.js']:[]),'/host/entry-bootstrap.js','/host/start-gate.js'];
 const css=registry.rootStyleSheets??[];requireThat(css.every(r=>files.has(r)&&r.endsWith('.css')),'ROOT_STYLESHEETS');
 const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 const links=css.map(r=>{const attrs=Object.entries(registry.styleSheetAttributes?.[r]??{}).map(([k,v])=>{requireThat(/^data-[a-z0-9-]+$/.test(k)&&typeof v==='string','STYLESHEET_ATTRIBUTE');return' '+k+'="'+escape(v)+'"';}).join('');return'<link rel="stylesheet"'+attrs+' href="@@PREFIX@@'+r+'">';}).join('');
 const html='<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Native O11 screen preview</title>'+links+'<body><div id="reactContainer"></div>'+order.map(r=>'<script src="@@PREFIX@@'+r+'"></script>').join('')+'</body></html>';
 const identity={schema:'ssam-native-o11-release-identity/1',compilerBuildId:emitter.buildId,sourceSha256,sessionId,target:config.target,entries:selected.entries,contextSha256:config.contextContract?.sha256??null,scenarioSha256:config.scenarioPlan?.sha256??null,hostCodeSha256:config.hostImplementation.sha256,runtimeAssetsSha256:config.runtimeAssets.sha256,htmlSha256:sha256(html),assets:[...files].map(([route,a])=>({route,sha256:sha256(a.body)})).sort((a,b)=>a.route.localeCompare(b.route))};
 const buildId=sha256(canonical(identity)),prefix='/builds/'+buildId;
 files.set('/view/index.html',{body:Buffer.from(html.replaceAll('@@PREFIX@@',prefix)),contentType:'text/html; charset=utf-8',origin:'host-loader'});
 for(const [route,a]of files)if(route.endsWith('.js'))new vm.Script(a.body.toString('utf8'),{filename:route});
 requireThat(path.isAbsolute(outputDirectory)&&!fs.existsSync(outputDirectory),'FRESH_OUTPUT_REQUIRED');fs.mkdirSync(path.join(outputDirectory,'blobs'),{recursive:true});
 const assets=[];
 for(const [route,a]of files){const hash=sha256(a.body),file=path.join(outputDirectory,'blobs',hash);if(!fs.existsSync(file))fs.writeFileSync(file,a.body);assets.push({route,file,sha256:hash,contentType:a.contentType,origin:a.origin});}
 const release={schema:schemas.release,testOnly:emitter.testOnly===true,executionReady:!!context,source:emitter.source,sourceSha256,buildId,compilerBuildId:emitter.buildId,generator:emitter.generator,identity,sessionId,target:config.target,entryOptions,profile:{...emitter.profile,entry:selected.entry},compilerManifest:{file:compilerManifestPath,sha256:compilerManifestSha256},contextContract:config.contextContract??null,scenarioPlan:config.scenarioPlan??null,transportPolicy:config.transportPolicy,assets,closure,entry:prefix+'/view/index.html',timings:{...(emitter.timingsMs??{}),assemblyMs:Math.round(performance.now()-started)},generatedBytesPreserved:true};
 const manifestPath=path.join(outputDirectory,'release.json');atomicJSON(manifestPath,release);
 return {manifestPath,manifestSha256:sha256(fs.readFileSync(manifestPath)),buildId,sourceSha256,timings:release.timings,executionReady:!!context};
}
