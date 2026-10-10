import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { atomicJson, readJson, loadProfile, publicProfile, summarizeState } from './profile.mjs';

const request = readJson(process.argv[2]);
const receiptFile = path.join(request.directory, 'receipt.json');
let host, watcher, server, status = 'starting';
const base = { sessionId:request.sessionId, instanceId:request.instanceId, profileSha256:request.profile.sha256 };
function receipt(value) { atomicJson(receiptFile, {...base, ...value, updatedAt:new Date().toISOString()}); }
try {
  const {profile:p, host:config} = loadProfile(request.profile);
  const module = await import(pathToFileURL(p.host.module.file).href);
  host = await module.startLiveHost(config);
  if (p.watcher) {
    const watchModule = await import(pathToFileURL(p.watcher.module.file).href);
    watcher = await watchModule.startManagedWatcher(readJson(p.watcher.config.file));
  }
  status = 'running';
  const token = randomBytes(32).toString('hex');
  const describe = () => ({ok:true,...base,status,url:host.url,profile:publicProfile(p),...summarizeState(host.manager?.state)});
  let stopping;
  async function stop() {
    if (stopping) return stopping;
    status='stopping'; receipt(describe());
    stopping=(async()=>{
      let failure;
      try { await watcher?.stop(); } catch(e) { failure=e; }
      try { await host.close(); } catch(e) { failure??=e; }
      status=failure?'failed':'stopped';
      receipt({...describe(),ok:!failure,...(failure?{code:'PREVIEW_STOP_FAILED',error:failure.message}:{})});
      server.close();server.closeIdleConnections?.();
    })();
    return stopping;
  }
  server=http.createServer(async(req,res)=>{
    const supplied=Buffer.from(req.headers.authorization || ''), expected=Buffer.from('Bearer '+token);
    if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)){res.writeHead(403);res.end();return;}
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    try {
      if(req.method==='GET' && req.url==='/status') {res.end(JSON.stringify(describe()));return;}
      if(req.method==='POST' && req.url==='/stop') {status='stopping';res.end(JSON.stringify(describe()));stop().catch(e=>receipt({status:'failed',error:e.message}));return;}
      if(req.method==='POST' && req.url==='/refresh') {
        if(status!=='running')throw Object.assign(new Error('The session is stopping.'),{code:'PREVIEW_STOPPING'});
        if(watcher?.refresh){const result=await watcher.refresh();res.end(JSON.stringify({...describe(),refresh:result}));}
        else {host.poll?.();res.end(JSON.stringify({...describe(),refresh:{captureRequested:false,code:'PREVIEW_STATIC_CAPTURE',note:'Reloaded the prepared artifact feed. This profile does not capture new Studio edits automatically.'}}));}
        return;
      }
      res.writeHead(404);res.end(JSON.stringify({...base,ok:false,code:'PREVIEW_CONTROL_ROUTE'}));
    } catch(e){res.end(JSON.stringify({...base,ok:false,code:e.code || 'PREVIEW_CONTROL_ERROR',error:e.message}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  atomicJson(path.join(request.directory,'control.json'),{...base,host:'127.0.0.1',port:server.address().port,token,pid:process.pid});
  receipt(describe());
  process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
} catch(e) {
  await watcher?.stop().catch(()=>{}); await host?.close().catch(()=>{});
  receipt({status:'failed',code:e.code || 'PREVIEW_START_FAILED',error:e.message});
  process.exitCode=1;
}
