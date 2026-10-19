import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Reservation scope is one journalRoot. Only persistent resolved keys identify a
// data target; requested names are presentation aliases and never participate.
export function normalizeDataTarget(identity) {
  const lane=String(identity.lane??'').toLowerCase();
  let host=String((lane==='odc'?identity.tenant??identity.host:identity.host??identity.tenant)??'').trim();
  if(host){try{const url=new URL(host.includes('://')?host:`https://${host}`);host=url.host.toLowerCase()+url.pathname.replace(/\/+$/,'');}catch{host=host.toLowerCase().replace(/\/+$/,'');}}
  const module=String(identity.moduleKey??identity.module??'').trim();
  const entity=String(identity.entityKey??identity.entity??'').trim();
  if(!lane||!host||!module||!entity)throw Object.assign(new Error('The channel did not resolve a canonical data target.'),{code:'DATA_TARGET_IDENTITY_REQUIRED'});
  return {lane,host,module,entity};
}
export async function withDataEntityReservation(identity,options,run){
  return withDataLoadLock({operationId:crypto.randomUUID()},{...options,transientEntity:true},async ({acquireEntity})=>{
    const refusal=await acquireEntity(identity);return refusal??await run();
  });
}
// An inline insert or update (records) of a lane (CX13 review 6: the fence with CX15/CX12 and the PERF of review 5). It reads
// no data target identity first: a marker (.entities/inline-*.json, its lane and process) stands for the call while it
// writes, and only when this journalRoot holds an unfinished file load reservation of the lane are the identities read
// (identities(): the canonical targets of the call) and reserved as before (DATA_ENTITY_LOAD_BUSY on the same entity).
// A file load that starts while a live marker of its lane exists answers BUSY (acquireEntity below): one of the two
// always sees the other, since each writes its own file before it looks for the other's.
export async function withInlineDataReservation({lane},identities,options,run){
  if(!options?.journalRoot)throw new Error('journalRoot is required for durable data loads');
  const dir=path.join(options.journalRoot,'.entities');fs.mkdirSync(dir,{recursive:true});
  const name=`inline-${process.pid}-${++sequence}`,marker={pid:process.pid,token:name,lane:String(lane??'').toLowerCase(),inline:true,at:new Date().toISOString()};
  const file=path.join(dir,name+'.json');create(file,marker);
  try{
    if(!openLoadOfLane(options.journalRoot,marker.lane))return await run();
    const targets=[...await identities()];
    const reserve=index=>index===targets.length?run():withDataEntityReservation(targets[index],options,()=>reserve(index+1));
    return await reserve(0);
  }finally{removeOwn(file,marker);}
}

let sequence=0;
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const alive=pid=>{if(!Number.isInteger(pid)||pid<1)return true;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
const token=()=>`${process.pid}:${++sequence}`;
function create(file,value){const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,JSON.stringify(value));}finally{fs.closeSync(fd);}}
function removeOwn(file,owner){if(read(file)?.token===owner.token)fs.unlinkSync(file);}
function take(file,owner){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const reaper=file+'.reap';
  if(fs.existsSync(reaper))return null;
  try{create(file,owner);return owner;}catch(error){if(error.code!=='EEXIST')throw error;}
  const old=read(file);
  // Age alone never steals a running load. Damaged locks require inspection;
  // only an owner PID known to have exited can be reaped.
  if(!old||alive(old.pid))return null;
  const reap={pid:process.pid,token:token()};
  try{create(reaper,reap);}catch(error){if(error.code==='EEXIST')return null;throw error;}
  try{
    const current=read(file);
    if(current?.token!==old.token||alive(current.pid))return null;
    fs.unlinkSync(file);
    try{create(file,owner);return owner;}catch(error){if(error.code==='EEXIST')return null;throw error;}
  }finally{removeOwn(reaper,reap);}
}
// Inline markers and open load reservations of a lane in one journalRoot (dead-pid markers are removed, as S1 does).
const INLINE_MARKER=/^inline-.*\.json$/;
function liveInlineMarkers(journalRoot,lane){
  const dir=path.join(journalRoot,'.entities');let names=[];try{names=fs.readdirSync(dir).filter(name=>INLINE_MARKER.test(name));}catch{return[];}
  const live=[];for(const name of names){const file=path.join(dir,name),marker=read(file);if(!marker||marker.lane!==lane)continue;if(!alive(marker.pid)){removeOwn(file,marker);continue;}live.push(marker);}
  return live;
}
function openLoadOfLane(journalRoot,lane){
  const dir=path.join(journalRoot,'.entities');let names=[];try{names=fs.readdirSync(dir).filter(name=>name.endsWith('.json')&&!INLINE_MARKER.test(name));}catch{return false;}
  return names.some(name=>{const reservation=read(path.join(dir,name));if(!reservation)return true;if(reservation.identity?.lane!==lane)return false;
    const plan=read(path.join(String(reservation.dir??''),'plan.json')),receipt=read(path.join(String(reservation.dir??''),'receipt.json'));
    return!(receipt?.complete===true||['closed','completed'].includes(plan?.state));});
}
// Whether a load directory's journal records anything that may have reached the Studio.
const sentFrom=dir=>{try{return fs.readFileSync(path.join(dir,'journal.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).some(entry=>entry.kind!=='resume'&&entry.state!=='not-submitted');}catch(error){return error.code!=='ENOENT';}};
const busy=(code,otherOperationId,detail)=>({ok:false,complete:false,code,outcome:'not-sent',written:0,otherOperationId,error:detail,next:`Resume load ${otherOperationId} after its current call finishes; inspect its receipt before starting another load.`});
// An MCP client abort rejects its RPC promise before the lane handler settles.
// Keep the outer Studio lock until the owning load handler releases this file.
export async function waitForDataLoadEnd(journalRoot,operationId){
  if(!operationId||!journalRoot)return;
  const file=path.join(journalRoot,'.locks',`${operationId.toLowerCase()}.lock`);
  while(fs.existsSync(file)){
    const owner=read(file);if(owner&&!alive(owner.pid))return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
}
export async function withDataLoadLock(input,options,run){
  if(!options.journalRoot)throw new Error('journalRoot is required for durable data loads');
  if(input.dryRun||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.operationId??''))return run(options);
  const owner={pid:process.pid,token:token(),operationId:input.operationId,rule:'dead-pid-only'};
  const lock=path.join(options.journalRoot,'.locks',`${input.operationId.toLowerCase()}.lock`);
  if(!take(lock,owner))return busy('DATA_LOAD_BUSY',input.operationId,'Another call owns this load; no journal or data was changed.');
  let entityFile,entityOwner;
  const acquireEntity=identity=>{
    identity=normalizeDataTarget(identity);
    const key=crypto.createHash('sha256').update(JSON.stringify([identity.lane,identity.host,identity.module,identity.entity])).digest('hex');
    entityFile=path.join(options.journalRoot,'.entities',`${key}.json`);fs.mkdirSync(path.dirname(entityFile),{recursive:true});
    const candidate={...owner,dir:path.join(options.journalRoot,input.operationId),identity,rule:'one-open-load-per-entity',...(options.transientEntity?{transient:true}:{})};
    for(let attempt=0;attempt<2;attempt++){
      try{create(entityFile,candidate);entityOwner=candidate;}catch(error){if(error.code!=='EEXIST')throw error;}
      if(entityOwner===candidate){
        // A live inline call of this lane (its entity unread): this new load waits for it; the same call again is the way out.
        const inline=options.transientEntity?[]:liveInlineMarkers(options.journalRoot,identity.lane);
        if(!inline.length)return null;
        removeOwn(entityFile,candidate);entityOwner=undefined;
        return{...busy('DATA_ENTITY_LOAD_BUSY','inline',`Another call (process ${inline[0].pid}) is writing records of this lane inline now; nothing of this call was sent.`),
          ownerHasPlan:false,otherPid:inline[0].pid,ownerKind:'inline',
          next:`Retry this same call after that call ends (process ${inline[0].pid}). A marker whose process exited is removed by the next call, so retrying is always the way out.`};
      }
      const existing=read(entityFile);
      if(existing?.operationId===input.operationId){entityOwner=existing;return null;}
      const receipt=existing&&read(path.join(existing.dir,'receipt.json'));
      const plan=existing&&read(path.join(existing.dir,'plan.json'));
      const active=existing&&read(path.join(options.journalRoot,'.locks',`${existing.operationId.toLowerCase()}.lock`));
      const running=Boolean(active&&alive(active.pid));
      // CX13 review 5 (S1): a reservation without a validated plan and with nothing sent whose process died (an inline
      // insert/update killed inside its native call, or a load killed between acquireEntity and plan.json) holds
      // nothing that can be resumed or closed: it is removed, like a finished load's.
      const orphan=Boolean(existing)&&!running&&!alive(existing.pid)&&!plan?.validated&&!sentFrom(existing.dir);
      if(existing&&!running&&(orphan||receipt?.complete===true||['closed','completed'].includes(plan?.state))){
        removeOwn(entityFile,existing);continue;
      }
      if(existing&&!plan?.validated){
        const what=existing.transient?'an inline insert or update':'a file load that has not saved its plan yet';
        return {...busy('DATA_ENTITY_LOAD_BUSY',existing.operationId??'unknown',`Another call (process ${existing.pid}) is writing this host/module/entity now: ${what}; nothing of this call was sent.`),
          ownerHasPlan:false,otherPid:existing.pid,ownerKind:existing.transient?'inline':'load-before-plan',
          next:`Retry this same call after that call ends (process ${existing.pid}). A reservation whose process exited without a plan is removed by the next call, so retrying is always the way out.`};
      }
      return {...busy('DATA_ENTITY_LOAD_BUSY',existing?.operationId??'unknown','Another resumable load owns this host/module/entity; resume that load.'),
        ...(existing?{receiptFile:path.join(existing.dir,'receipt.json')}:{}),
        ...(plan?.resumeContinuation?{continuation:plan.resumeContinuation}:{})};
    }
    return busy('DATA_ENTITY_LOAD_BUSY',read(entityFile)?.operationId??'unknown','Another unfinished load owns this entity.');
  };
  try{
    const result=await run({...options,acquireEntity});
    if(entityOwner){
      const journal=path.join(entityOwner.dir,'journal.jsonl');
      const sent=fs.existsSync(journal)&&fs.readFileSync(journal,'utf8').split(/\r?\n/).filter(Boolean)
        .map(line=>JSON.parse(line)).some(entry=>entry.kind!=='resume'&&entry.state!=='not-submitted');
      const plan=read(path.join(entityOwner.dir,'plan.json'));
      if(result?.complete===true||['closed','completed'].includes(plan?.state)||(!plan?.validated&&!sent))removeOwn(entityFile,entityOwner);
    }
    // A refusal may precede acquireEntity. Only a durable terminal state can
    // release an existing reservation; a call-level error cannot abandon it.
    const durable=read(path.join(options.journalRoot,input.operationId,'plan.json'));
    if(['closed','completed'].includes(durable?.state)){
      const directory=path.join(options.journalRoot,'.entities');
      if(fs.existsSync(directory))for(const name of fs.readdirSync(directory)){
        const file=path.join(directory,name),reservation=read(file);
        if(reservation?.operationId===input.operationId)removeOwn(file,reservation);
      }
    }
    return result;
  }finally{if(options.transientEntity&&entityOwner)removeOwn(entityFile,entityOwner);removeOwn(lock,owner);}
}
