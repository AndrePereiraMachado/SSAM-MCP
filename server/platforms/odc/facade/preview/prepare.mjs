import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { atomicJson, check, digest, loadProfile, pinned, readJson, SCHEMA } from './profile.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const pin=file=>({file:path.resolve(file),sha256:digest(fs.readFileSync(file))});
// The input of a preparation (the integrator's command below and ssam_preview's own, auto-prepare.mjs): the arguments of
// prepareProfile but the directory, with hostConfig/watcherConfig pinned by sha256.
export const INPUT_SCHEMA='ssam-preview-input/1';
export const PREPARE_SCRIPT='platforms/odc/facade/preview/prepare.mjs';
// A profile id names the folders of its preparation and its session: checked before any path is built from it.
const validId=id=>typeof id==='string'&&/^[a-z0-9][a-z0-9-]{0,79}$/.test(id);
// Integrator API. Inputs are already qualified private artifacts, never inferred from a URL.
// This writes a fresh preparation directory; it does not start a host or touch Studio. engines: the engines folder (tests:
// a simulated one).
export function prepareProfile({directory,id,lane,target,screens,limitations,hostConfig,watcherConfig,port,engines=path.join(here,'engines')}) {
  check(validId(id),'PREVIEW_PROFILE_SCHEMA','A profile id is ^[a-z0-9][a-z0-9-]{0,79}$.');
  check(path.isAbsolute(directory??'')&&!fs.existsSync(directory),'PREVIEW_FRESH_DIRECTORY');
  check(['o11','odc'].includes(lane),'PREVIEW_LANE');
  const host=JSON.parse(pinned(hostConfig));
  check(Number.isInteger(port)&&port>0&&port<=65535,'PREVIEW_PORT');
  const engine=path.join(engines,lane);
  const code=fs.readdirSync(engine).filter(n=>/\.(mjs|js|css|html)$/.test(n)).map(n=>pin(path.join(engine,n)));
  if(lane==='odc') code.push(pin(path.join(engines,'scope/host-candidate.mjs')));
  // The folder is created here, never reused: another process's folder of the same name is PREVIEW_FRESH_DIRECTORY, and an
  // error after this point names the folder this call created (createdDirectory), the only one a caller may remove.
  fs.mkdirSync(path.dirname(directory),{recursive:true});
  try{fs.mkdirSync(directory);}catch(error){if(error.code==='EEXIST')check(false,'PREVIEW_FRESH_DIRECTORY');throw error;}
  try{
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
    w.codePins=['run.mjs','pipeline.mjs','adapters.mjs','pipe.mjs'].map(n=>pin(path.join(engines,'watcher',n)));
    w.assembler=pin(path.join(engine,'assemble-release.mjs'));w.resumeSelection=true;
    atomicJson(path.join(directory,'watcher.config.json'),w);
    p.watcher={module:pin(path.join(engines,'watcher/run.mjs')),config:pin(path.join(directory,'watcher.config.json'))};
  }
  const file=path.join(directory,'profile.json');atomicJson(file,p);
  const result=pin(file);loadProfile(result);
  atomicJson(path.join(directory,'preparation.json'),{schema:'ssam-preview-preparation/1',profile:result,preparedAt:new Date().toISOString(),hostInput:hostConfig,watcherInput:watcherConfig??null,started:false,privateDependenciesCopied:false});
  return result;
  }catch(error){if(error&&typeof error==='object')error.createdDirectory=directory;throw error;}
}

// Before preparing (the integrator's command, the automatic preparation): an id already in the catalog is refused, and the
// folder of a new preparation is always new (<id>-<UTC second>, then -2, -3... in the same second; proto d5394178).
export function notRegistered({catalogFile,id}){
  if(!fs.existsSync(catalogFile))return;
  const catalog=readJson(catalogFile);
  check(catalog.schema==='ssam-preview-catalog/1'&&Array.isArray(catalog.profiles),'PREVIEW_CATALOG_SCHEMA');
  check(!catalog.profiles.some(p=>{try{return loadProfile(p).profile.id===id;}catch{return false;}}),'PREVIEW_DUPLICATE_PROFILE','A profile with this ID is already registered. Review and stop its session before replacing it.');
}
export function freshFolder(root,id,at=new Date()){
  check(validId(id),'PREVIEW_PROFILE_SCHEMA','A profile id is ^[a-z0-9][a-z0-9-]{0,79}$.');
  const base=path.join(root,id+'-'+at.toISOString().replace(/[-:]/g,'').replace(/\..*$/,'').replace('T','-'));
  let folder=base;for(let n=2;fs.existsSync(folder);n++)folder=base+'-'+n;
  return folder;
}
// One preparation at a time per catalog, for every preparer (ssam_preview's own and the integrator's command): <profiles>/
// prepare.lock holds {pid, startedAt, token}. A lock whose process is gone (ESRCH) or older than PREPARE_LOCK_MAX_MS is
// reclaimed by an atomic rename to prepare.lock.stale-<time>-<pid> (only one reclaimer wins the rename), then taken again with
// wx, as the watcher does with its own lock (engines/watcher/run.mjs). Held: PREVIEW_PREPARE_BUSY with the file. The lock is
// removed only while it is still this call's (its token).
export const PREPARE_LOCK_MAX_MS=120000;
export const prepareLockFile=catalogFile=>path.join(path.dirname(catalogFile),'profiles','prepare.lock');
function lockIsStale(lock,{now=Date.now(),alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}}={}){
  let held=null,mtime=now;
  try{mtime=fs.statSync(lock).mtimeMs;}catch{return false;}
  try{held=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{/* being written, or damaged: judged by its age */}
  const started=Number.isFinite(Date.parse(held?.startedAt))?Date.parse(held.startedAt):mtime;
  if(now-started>PREPARE_LOCK_MAX_MS)return true;
  return Number.isInteger(held?.pid)&&held.pid>0&&!alive(held.pid);
}
export function withPrepareLock(catalogFile,fn,options={}){
  const lock=prepareLockFile(catalogFile);
  fs.mkdirSync(path.dirname(lock),{recursive:true});
  const token=randomUUID();
  const take=()=>{const fd=fs.openSync(lock,'wx',0o600);try{fs.writeSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),token}));}finally{fs.closeSync(fd);}};
  try{take();}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    let reclaimed=false;
    // (the text judged stale is the one renamed away: a lock another reclaimer took meanwhile is put back, never taken)
    let judged=null;try{judged=fs.readFileSync(lock,'utf8');}catch{/* gone: take it below */}
    if(judged===null||lockIsStale(lock,options)){
      const aside=lock+'.stale-'+Date.now()+'-'+process.pid;
      try{fs.renameSync(lock,aside);reclaimed=true;}catch(e){if(e.code!=='ENOENT')throw e;reclaimed=judged===null;}
      if(reclaimed&&judged!==null&&fs.readFileSync(aside,'utf8')!==judged){reclaimed=false;try{fs.renameSync(aside,lock);}catch{/* the other preparer's lock stays aside; it removes it by token */}}
    }
    try{if(!reclaimed)throw Object.assign(new Error('held'),{code:'EEXIST'});take();}
    catch(e){if(e.code!=='EEXIST')throw e;check(false,'PREVIEW_PREPARE_BUSY','Another preparation holds '+lock+'; repeat the call. A lock whose process ended, or older than '+PREPARE_LOCK_MAX_MS/1000+' s, is reclaimed by the next preparation.');}
  }
  try{return fn();}
  finally{try{if(JSON.parse(fs.readFileSync(lock,'utf8')).token===token)fs.rmSync(lock,{force:true});}catch{/* not ours, or already gone */}}
}
export function registerProfile({catalogFile,profile}){
  const selected=loadProfile(profile);
  const catalog=fs.existsSync(catalogFile)?readJson(catalogFile):{schema:'ssam-preview-catalog/1',profiles:[]};
  check(catalog.schema==='ssam-preview-catalog/1'&&Array.isArray(catalog.profiles),'PREVIEW_CATALOG_SCHEMA');
  check(!catalog.profiles.some(p=>loadProfile(p).profile.id===selected.profile.id),'PREVIEW_DUPLICATE_PROFILE','A profile with this ID is already registered. Review and stop its session before replacing it.');
  atomicJson(catalogFile,{...catalog,profiles:[...catalog.profiles,profile]});
}

// The integrator's command (PREVIEW_PROFILE_NOT_PREPARED names it): node platforms/odc/facade/preview/prepare.mjs --input <file>
// [--catalog <file>] [--directory <new folder>]. The input is ssam-preview-input/1; it prepares and registers. It runs in the
// integrator's shell, so the files the input pins are read wherever they are installed (ssam_preview's own preparation reads
// only inside the workspace).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const option = name => { const i = process.argv.indexOf('--' + name); return i < 0 ? undefined : process.argv[i + 1]; };
  try {
    const input = readJson(path.resolve(option('input') ?? ''));
    check(input?.schema === INPUT_SCHEMA, 'PREVIEW_INPUT_SCHEMA', 'The input is not ' + INPUT_SCHEMA + '.');
    const workspace = path.resolve(here, '../../../..');
    const catalogFile = path.resolve(option('catalog') ?? process.env.SSAM_PREVIEW_CATALOG ?? path.join(workspace, '.local', 'preview', 'catalog.json'));
    // (only the fields of the input schema: an input never chooses the engines folder)
    const { id, lane, target, screens, limitations, hostConfig, watcherConfig, port } = input;
    const { profile, directory } = withPrepareLock(catalogFile, () => {
      notRegistered({ catalogFile, id });
      const directory = path.resolve(option('directory') ?? freshFolder(path.join(path.dirname(catalogFile), 'profiles'), id));
      const profile = prepareProfile({ directory, id, lane, target, screens, limitations, hostConfig, watcherConfig, port });
      registerProfile({ catalogFile, profile });
      return { profile, directory };
    });
    process.stdout.write(JSON.stringify({ ok: true, code: 'PREVIEW_PROFILE_PREPARED', profile, catalogFile, directory }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? 'PREVIEW_PREPARE_FAILED', error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
