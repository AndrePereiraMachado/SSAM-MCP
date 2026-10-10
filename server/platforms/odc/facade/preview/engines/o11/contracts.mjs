import path from 'node:path';
import {readPinned,requireThat,canonical,verifyCodeLock} from './common.mjs';
export const schemas={config:'ssam-native-o11-host-config/1',release:'ssam-native-o11-release/1'};
export function verifyImplementation(config){
 const lock=config.hostImplementation;
 requireThat(lock && path.isAbsolute(lock.file),'HOST_LOCK_PATH');
 return verifyCodeLock(lock);
}
export function validateConfig(config,{starting=false}={}){
 requireThat(config.schema===schemas.config&&config.sourcePlatform==='o11','HOST_CONFIG');
 requireThat(typeof config.stableSessionId==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(config.stableSessionId),'SESSION_ID');
 for(const name of ['module','moduleKey','screen','screenKey'])requireThat(typeof config.target?.[name]==='string'&&config.target[name].length>0,'TARGET_'+name);
 requireThat(/^127\.0\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4])$/.test(config.bindHost)&&Number.isInteger(config.port)&&config.port>0&&config.port<=65535,'LOCAL_ADDRESS_REQUIRED');
 for(const name of ['selectionFile','statusFile','stateFile','ledgerFile','endpointFile'])requireThat(path.isAbsolute(config[name]??''),'STATE_PATH_'+name);
 requireThat(['deny-all','local-data-actions'].includes(config.transportPolicy),'NO_BACKEND_PROFILE_REQUIRED');
 requireThat(config.transportPolicy==='local-data-actions'?!!config.scenarioPlan:!config.scenarioPlan,'SCENARIO_POLICY_PIN');
 if(starting)requireThat(config.startAllowed===true&&config.contextContract,'HOST_NOT_ACTIVATED');
 return config;
}
export function readContext(config){
 if(!config.contextContract)return null;
 const context=readPinned(config.contextContract);
 requireThat(context.schema==='ssam-local-render-context/1'&&context.status==='authorized-local-render-scenario','CONTEXT_SCOPE');
 requireThat(context.moduleKey===config.target.moduleKey&&context.screenKeys?.includes(config.target.screenKey),'CONTEXT_TARGET');
 requireThat(context.bindHost===config.bindHost&&context.sessionId===config.stableSessionId,'CONTEXT_ORIGIN');
 requireThat(context.realBackend===false&&context.realAccessValidated===false,'LOCAL_CONTEXT_ONLY');
 if(context.scope){const scope=readPinned(context.scope);requireThat(scope.explicitSynthetic===true&&scope.realBackend===false&&scope.realAccessValidated===false&&scope.moduleKey===context.moduleKey&&canonical(scope.scenario)===canonical(context.scenario),'CONTEXT_SCOPE_PIN');}
 if(context.previousContext){
  const previous=readPinned(context.previousContext);
  requireThat(previous.moduleKey===context.moduleKey&&previous.sessionId===context.sessionId&&previous.bindHost===context.bindHost&&canonical(previous.scenario)===canonical(context.scenario),'PREVIOUS_CONTEXT_MISMATCH');
  const expected=JSON.stringify({schema:1,activationId:previous.activationId,scope:previous.scope.sha256,installer:previous.installer.sha256,moduleKey:previous.moduleKey,sessionId:previous.sessionId,identity:previous.scenario.identity,roles:[],reload:previous.scenario.reload});
  requireThat(context.previousMarker===expected,'PREVIOUS_MARKER_MISMATCH');
 }else requireThat(!context.previousMarker,'UNPINNED_PREVIOUS_MARKER');
 requireThat(context.applicationMetadata&&context.installer&&context.entryLocations,'CONTEXT_INPUTS');
 const application=readPinned(context.applicationMetadata);
 requireThat(application.schema==='ssam-o11-application-bootstrap/1'&&application.moduleKey===config.target.moduleKey,'APPLICATION_METADATA');
 const d=application.definition;
 for(const field of ['applicationName','userProviderName','homeModuleName','homeModuleKey','homeModuleControllerName','homeModuleLanguageResourcesName'])requireThat(typeof d?.[field]==='string'&&d[field].length>0,'APPLICATION_'+field);
 requireThat(typeof d.isWeb==='boolean'&&Array.isArray(d.clientEntitiesModules),'APPLICATION_PLATFORM');
 // Metadata must declare its provenance. AppName is not assumed to be in every OML.
 requireThat(application.provenance&&Object.keys(application.provenance).length>0,'APPLICATION_PROVENANCE');
 const locations=readPinned(context.entryLocations),location=locations.entries?.find(e=>e.screenKey===config.target.screenKey);
 requireThat(locations.schema==='ssam-native-entry-locations/1'&&locations.moduleKey===config.target.moduleKey&&location&&location.provenance,'ENTRY_LOCATION');
 requireThat(typeof location.location==='string'&&location.location.startsWith('/')&&!location.location.startsWith('//')&&!/[\\\r\n]/.test(location.location),'ENTRY_LOCATION_PATH');
 for(const item of locations.entries)requireThat(context.screenKeys.includes(item.screenKey)&&item.provenance&&typeof item.location==='string'&&item.location.startsWith('/')&&!item.location.startsWith('//')&&!/[\\\r\n]/.test(item.location),'ENTRY_LOCATION_SET');
 return {context,application,location,locations:locations.entries};
}
export function nativeEntries(emitter){
 const profile=emitter.profile;
 requireThat(['native-screen','native-screens'].includes(profile?.kind),'NATIVE_PROFILE');
 const targets=profile.kind==='native-screen'?[profile.target]:profile.targets;
 const entries=profile.kind==='native-screen'?[{screenKey:profile.target.screenKey,...profile.entry}]:profile.entries;
 requireThat(Array.isArray(targets)&&targets.length>0&&Array.isArray(entries)&&entries.length===targets.length,'ENTRY_SET');
 requireThat(new Set(targets.map(t=>t.screenKey)).size===targets.length&&new Set(entries.map(e=>e.screenKey)).size===entries.length,'ENTRY_DUPLICATE');
 for(const target of targets){
  const entry=entries.find(e=>e.screenKey===target.screenKey);
  requireThat(target.moduleKey===emitter.source.moduleKey&&entry,'ENTRY_SOURCE');
  for(const field of ['view','model','controller','flow'])requireThat(typeof entry[field]==='string'&&entry[field].length>0,'ENTRY_'+field);
 }
 return {targets,entries};
}
export function matchSelected(config,emitter,catalog){
 const {targets,entries}=nativeEntries(emitter);
 requireThat(targets.some(t=>canonical(t)===canonical(config.target)),'SELECTED_ENTRY_NOT_EMITTED');
 const sourceKeys=emitter.source.screenKeys??[emitter.source.screenKey];
 requireThat(sourceKeys.length===targets.length&&targets.every(t=>sourceKeys.includes(t.screenKey)),'SOURCE_ENTRY_SET');
 requireThat(catalog.moduleName===config.target.module,'CATALOG_MODULE');
 for(const entry of entries){
  const screen=catalog.screens?.find(s=>s.sourceNativeKey===entry.screenKey);
  requireThat(screen&&canonical({view:screen.viewModuleName,model:screen.modelModuleName,controller:screen.controllerModuleName,flow:screen.webFlowControllerModuleName})===canonical({view:entry.view,model:entry.model,controller:entry.controller,flow:entry.flow}),'NATIVE_ENTRY_TUPLE');
 }
 return {targets,entries,entry:entries.find(e=>e.screenKey===config.target.screenKey)};
}
