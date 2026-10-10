import fs from 'node:fs';
import path from 'node:path';
import { LivePipeline } from './pipeline.mjs';
import { readJson, atomicJson, createOfficialAdapters, readPreviousSelection } from './adapters.mjs';

export async function startManagedWatcher(config, { createAdapters = createOfficialAdapters } = {}) {
  if(config.startAllowed !== true) throw Object.assign(new Error('Watcher profile is not activated.'),{code:'WATCHER_NOT_ACTIVATED'});
  fs.mkdirSync(config.outputRoot,{recursive:true});
  const lock=path.join(config.outputRoot,'watcher.lock.json');
  if(fs.existsSync(lock)) {
    const old=readJson(lock); let alive=false;
    try {process.kill(old.pid,0); alive=true;} catch(e){if(e.code!=='ESRCH')throw e;}
    if(alive) throw Object.assign(new Error('A watcher already owns this output directory.'),{code:'PREVIEW_WATCHER_BUSY'});
    fs.renameSync(lock,lock+'.stale-'+Date.now());
  }
  const adapter=await createAdapters(config);
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,sessionId:config.sessionId}),{flag:'wx'});
  try {
  const pipeline=new LivePipeline({adapter,target:config.target,debounceMs:config.debounceMs??1200,...config.captureRecovery,onStatus:state=>{
    const {stale,...generation}=state;
    atomicJson(config.statusFile,{...generation,sourceStale:stale,automaticWatching:true,renderConfirmationFile:config.hostStateFile,entryScreenKey:config.target.screenKey,schema:'ssam-official-live-status/1',origin:'original-o11-compiler-on-adapted-odc-model',sessionId:config.sessionId});
  }});
  if(config.resumeSelection){
    const previous=readPreviousSelection(config);
    if(previous) pipeline.publish({lastExportedSha256:previous.pointer.sourceSha256,lastExportedAt:previous.pointer.promotedAt,lastLinkedSha256:previous.pointer.manifest.sha256,lastLinkedAt:previous.pointer.promotedAt});
  }
  const timer=setInterval(()=>pipeline.tick(),config.pollMs??700);
  pipeline.tick();
  return {
    pipeline,
    async refresh(){
      if(!pipeline.running) throw Object.assign(new Error('Watcher is stopping.'),{code:'PREVIEW_STOPPING'});
      if(pipeline.flight) return {captureRequested:false,inProgress:true};
      await pipeline.tick();
      if(pipeline.state.observedRevision){
        pipeline.pending=pipeline.state.observedRevision; pipeline.blocked=null; pipeline.quietAt=0; pipeline.retryAt=0;
        // capture() first reconciles a prior uncertain receipt. It never replays an uncertain snapshot.
        await pipeline.tick();
      }
      return {captureRequested:true,queued:true};
    },
    async stop(){
      clearInterval(timer); await pipeline.stop();
      if(fs.existsSync(lock)&&readJson(lock).pid===process.pid) fs.renameSync(lock,lock+'.ended-'+Date.now());
    }
  };
  } catch(error) {
    if(fs.existsSync(lock)&&readJson(lock).pid===process.pid)fs.renameSync(lock,lock+'.failed-'+Date.now());
    throw error;
  }
}
