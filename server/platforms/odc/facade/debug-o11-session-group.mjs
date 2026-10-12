// Two native O11 module sessions, one logical controller. They may receive the
// same server event: only the channel owning the top frame may control it.
// boundaryKind 'service-action': consumer and Service run in separate threads and
// requests. Each module is its own runtime entry: the Service input keeps its own
// runtime URL and published row (no o11Auth.entry); the consumer binding comes from
// serviceCaller (deriveServiceCaller) with its own runtime URL and row. Top-frame
// routing still applies, request ownership is not proved and no automatic
// step-into crosses the Service hop.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { validateO11PublicationProof } from './debug-o11-auth.mjs';
const KEY=/^[A-Za-z0-9_+]{22}$/,NAME=/^[A-Za-z_][A-Za-z0-9_]{0,198}$/;
// Same-module runtime entry (debug-runtime o11DebugRequest rule): HTTPS, port 443, path = module.
const ownRuntime=(runtimeUrl,module)=>{try{const u=new URL(runtimeUrl);return u.protocol==='https:'&&!u.port&&['/'+module,'/'+module+'/'].includes(u.pathname)?u:null;}catch{return null;}};
const rowValid=(host,target,proof)=>{
  try{
    const bytes=fs.readFileSync(proof.path);
    if(createHash('sha256').update(bytes).digest('hex')!==proof.sha256)return false;
    return validateO11PublicationProof({host,...target},JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')));
  }catch{return false;}
};
// Both published rows before any native start: the Service row in its own proof, the caller row in its own.
function serviceBindingValid(input,caller,context){
  const service=ownRuntime(input.runtimeUrl,input.module),consumer=ownRuntime(caller?.runtimeUrl,caller?.module);
  if(!service||!consumer||input.o11Auth.entry||consumer.origin!==service.origin||(input.tenant&&input.tenant.toLowerCase()!==service.hostname)||
      !NAME.test(caller.module)||!KEY.test(caller.moduleKey??'')||caller.moduleKey===input.moduleKey||!KEY.test(caller.applicationKey??'')||
      !Number.isSafeInteger(caller.publishedVersionId)||context.appUser.binding?.moduleKey!==caller.moduleKey)return false;
  return rowValid(service.hostname,{module:input.module,moduleKey:input.moduleKey,applicationKey:input.o11Auth.applicationKey,
      publishedVersionId:input.o11Auth.publishedVersionId},input.o11Auth.publishedProof??{})&&
    rowValid(service.hostname,{module:caller.module,moduleKey:caller.moduleKey,applicationKey:caller.applicationKey,
      publishedVersionId:caller.publishedVersionId},caller.publishedProof??{});
}
export function createO11SessionGroup(debug,checkActive=()=>{},{boundaryKind='linked-action',serviceCaller}={}) {
  if(!['linked-action','service-action'].includes(boundaryKind))throw Error('debug_o11_group_boundary_kind_invalid');
  const service=boundaryKind==='service-action';
  const members=[]; let unresolvedStart=false, stopAttempt, startAttempted=false;
  const summary=()=>({...(service?{boundaryKind,requestOwnershipProved:false,crossThread:true,serviceHopStepInto:'not-automatic'}:{}),members:members.map(({moduleKey,sessionId,stop})=>({moduleKey,sessionId,
    ...(stop?{stop:{ok:stop.ok,state:stop.state,error:stop.error,privateInspectionCleanup:stop.privateInspectionCleanup,
      credentialCleanup:stop.credentialCleanup}}:{})})),unresolvedStart});
  const retain=(moduleKey,r)=>{
    if(r?.ok===true && r.state==='connected' && !r.sessionId)throw Error('debug_o11_group_session_identity_missing');
    if(r?.sessionId && !(r.ok===false && r.state==='not-started' && r.workerStarted===false && r.uncertain===false)){
      if(!/^[a-f0-9]{32}$/.test(r.sessionId)||members.some(m=>m.sessionId===r.sessionId))throw Error('debug_o11_group_session_identity_invalid');
      members.push({moduleKey,sessionId:r.sessionId});
    }
  };
  return {
    summary,
    async start(input,context) {
      if(startAttempted || stopAttempt)throw Error('debug_o11_group_start_already_attempted');
      startAttempted=true;
      const entry=service?serviceCaller:input.o11Auth?.entry;
      if(input.lane!=='o11' || !input.o11Auth || !entry || entry.moduleKey===input.moduleKey || !context?.appUser || context.redactionOnly!==true ||
          input.autoContinue!==false || !input.inspection || input.trace ||
          input.inspection.scopes?.some(s=>s.moduleKey!==entry.moduleKey&&s.moduleKey!==input.moduleKey) ||
          service && !serviceBindingValid(input,entry,context))
        throw Error('debug_o11_group_binding_invalid');
      // Linked: the consumer is the runtime entry and shares the two-row proof. Service: the consumer
      // session runs on its own runtime URL with its own row; the Service input is passed unchanged.
      const auxiliary={...input,module:entry.module,moduleKey:entry.moduleKey,
        ...(service?{runtimeUrl:ownRuntime(entry.runtimeUrl,entry.module).origin+'/'+entry.module+'/'}:{}),
        o11Auth:{applicationKey:entry.applicationKey,publishedVersionId:entry.publishedVersionId,
          publishedProof:service?entry.publishedProof:input.o11Auth.publishedProof}};
      let result;
      try {
        result=await debug(auxiliary,{...context,additionalO11Session:true});retain(entry.moduleKey,result);
        if(!result?.ok || result.state!=='connected')return {...result,nativeGroup:summary()};
        try{checkActive();}catch{return {ok:false,state:'group-start-cancelled',sessionId:members[0]?.sessionId,
          error:'debug_o11_group_start_cancelled',nativeGroup:summary()};}
        result=await debug(input,context);retain(input.moduleKey,result);
      } catch {
        unresolvedStart=true;
        // With no allocated ID, propagate uncertainty to the runner's start
        // boundary; a failed result without an ID could look like no session.
        if(!members.length)throw Error('debug_o11_group_start_uncertain');
        return {ok:false,state:'group-start-uncertain',sessionId:members[0]?.sessionId,error:'debug_o11_group_start_uncertain',
          uncertain:true,nativeGroup:summary()};
      }
      if(!result?.ok || result.state!=='connected')return {...result,state:'group-start-failed',workerStarted:true,
        sessionId:members.at(-1)?.sessionId,nativeGroup:summary()};
      return {...result,nativeGroup:summary()};
    },
    async status() {
      const pauses=[],events=[];let state='connected';
      for(const member of members){
        const result=await debug({op:'status',sessionId:member.sessionId});
        if(result.state!=='connected')state='ending';
        for(const pause of result.pauses??[]){
          if(!members.some(m=>m.moduleKey===pause.stack?.at(-1)?.moduleKey))throw Error('debug_o11_group_frame_owner_unavailable');
          if(pause.stack.at(-1).moduleKey===member.moduleKey)pauses.push({...pause,nativeSessionId:member.sessionId});
        }
        events.push(...(result.events??[]));
      }
      return {ok:state==='connected',state,pauses,events,nativeGroup:summary()};
    },
    stop(context) {
      if(stopAttempt)return stopAttempt;
      stopAttempt=(async()=>{
        let confirmedFirst=false,ok=!unresolvedStart;
        for(const member of [...members].reverse()){
          try{member.stop=await debug({op:'stop',sessionId:member.sessionId},context);}
          catch{member.stop={ok:false,state:'stop-uncertain',error:'debug_o11_group_stop_uncertain'};}
          const r=member.stop;
          // A confirmed Stop can terminate the shared remote session. Accept
          // that exact peer outcome only with stopped worker and private cleanup.
          const peerEnded=confirmedFirst && r.state==='stopped' && r.error==='debug_server_ended_session' &&
            r.privateInspectionCleanup?.completed===true && r.privateInspectionCleanup.pending===0 &&
            r.credentialCleanup?.state==='runner-owned';
          const confirmed=r.state==='stopped'&&(r.ok===true||peerEnded);
          ok&&=confirmed;confirmedFirst||=confirmed;
        }
        return {ok,state:ok?'stopped':'stop-uncertain',nativeGroup:summary(),
          ...(ok?{}:{error:'debug_o11_group_cleanup_uncertain'})};
      })();
      return stopAttempt;
    }
  };
}
