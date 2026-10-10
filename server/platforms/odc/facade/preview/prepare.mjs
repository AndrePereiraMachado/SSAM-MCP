import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, check, digest, loadProfile, pinned, readJson, SCHEMA } from './profile.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const pin=file=>({file:path.resolve(file),sha256:digest(fs.readFileSync(file))});
// Integrator API. Inputs are already qualified private artifacts, never inferred from a URL.
// This writes a fresh preparation directory; it does not start a host or touch Studio.
export function prepareProfile({directory,id,lane,target,screens,limitations,hostConfig,watcherConfig,port}) {
  check(path.isAbsolute(directory??'')&&!fs.existsSync(directory),'PREVIEW_FRESH_DIRECTORY');
  check(['o11','odc'].includes(lane),'PREVIEW_LANE');
  const host=JSON.parse(pinned(hostConfig));
  check(Number.isInteger(port)&&port>0&&port<=65535,'PREVIEW_PORT');
  const engine=path.join(here,'engines',lane);
  const code=fs.readdirSync(engine).filter(n=>/\.(mjs|js|css|html)$/.test(n)).map(n=>pin(path.join(engine,n)));
  if(lane==='odc') code.push(pin(path.join(here,'engines/scope/host-candidate.mjs')));
  fs.mkdirSync(directory,{recursive:true});
  atomicJson(path.join(directory,'host-code-lock.json'),{schema:'ssam-official-host-code-lock/1',files:code});
  const originalSelection=host.selectionFile;
  host.port=port;
  host.hostImplementation=pin(path.join(directory,'host-code-lock.json'));
  for(const name of ['selectionFile','statusFile','stateFile','ledgerFile','endpointFile'])host[name]=path.join(directory,name+'.json');
  // Preserve immutable, qualified input identity while allocating all mutable state anew.
  if(originalSelection&&fs.existsSync(originalSelection))atomicJson(host.selectionFile,readJson(originalSelection));
  atomicJson(path.join(directory,'host.config.json'),host);
  const p={schema:SCHEMA,id,lane,target,screens,limitations,implementation:lane==='o11'?'o11-native':'odc-adapted-o11',syntheticData:true,realBackend:false,realAccessValidated:false,automaticWatching:!!watcherConfig,host:{module:pin(path.join(engine,'host.mjs')),config:pin(path.join(directory,'host.config.json'))}};
  if(watcherConfig){
    check(lane==='odc','PREVIEW_WATCHER_UNQUALIFIED');
    const w=JSON.parse(pinned(watcherConfig));
    w.hostConfig=p.host.config;w.outputRoot=path.join(directory,'watcher');
    w.hostStateFile=host.stateFile;w.selectionFile=host.selectionFile;w.statusFile=host.statusFile;
    w.codePins=['run.mjs','pipeline.mjs','adapters.mjs','pipe.mjs'].map(n=>pin(path.join(here,'engines/watcher',n)));
    w.assembler=pin(path.join(engine,'assemble-release.mjs'));w.resumeSelection=true;
    atomicJson(path.join(directory,'watcher.config.json'),w);
    p.watcher={module:pin(path.join(here,'engines/watcher/run.mjs')),config:pin(path.join(directory,'watcher.config.json'))};
  }
  const file=path.join(directory,'profile.json');atomicJson(file,p);
  const result=pin(file);loadProfile(result);
  atomicJson(path.join(directory,'preparation.json'),{schema:'ssam-preview-preparation/1',profile:result,preparedAt:new Date().toISOString(),hostInput:hostConfig,watcherInput:watcherConfig??null,started:false,privateDependenciesCopied:false});
  return result;
}

export function registerProfile({catalogFile,profile}){
  const selected=loadProfile(profile);
  const catalog=fs.existsSync(catalogFile)?readJson(catalogFile):{schema:'ssam-preview-catalog/1',profiles:[]};
  check(catalog.schema==='ssam-preview-catalog/1'&&Array.isArray(catalog.profiles),'PREVIEW_CATALOG_SCHEMA');
  check(!catalog.profiles.some(p=>loadProfile(p).profile.id===selected.profile.id),'PREVIEW_DUPLICATE_PROFILE','A profile with this ID is already registered. Review and stop its session before replacing it.');
  atomicJson(catalogFile,{...catalog,profiles:[...catalog.profiles,profile]});
}
