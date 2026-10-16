// A kernel call can stop waiting while its work remains queued in Studio. Fence it without sending any UI write.
// A terminal journal receipt, positive idle for an unjournaled operation, a dead Studio, or the flight cap releases it.
import {registerBridgeFlight,FLIGHT_CAP_MS,processAlive} from './studio-write-lock.mjs';
import {currentBlocker} from './bridge-stall.mjs';
import {o11Bridge,bridgeTarget} from './o11-bridge.mjs';
import {hostedContext} from './executor.mjs';

// CX14 N3: after = the UI calls (open/refresh/close) the kernel recorded as sent and stopped beside a journaled operation
// (pendingBridgeOperation.after): a terminal journal releases the fence only once those are proven idle too.
export function watchPendingOperation({lane,root,record,method,operationId,moduleKey,taskId,kernelTaskId,blockedBy,bridge,after,
  settleMs=3000,capMs=FLIGHT_CAP_MS,alive}={}) {
  // servidor/fase4-26 (M4): hosted, the record's pid is the customer's Studio on the user's machine, never a process of this
  // server: no liveness evidence (undefined), so only the journal, a proven idle or the cap release the fence.
  alive??=hostedContext()?()=>undefined:processAlive;
  const waitsForUi=!operationId||(Array.isArray(after)&&after.length>0);
  const flight=registerBridgeFlight({lane,root,record,method,operationId,taskId,kernelTaskId,blockedBy,module:moduleKey?{key:moduleKey}:null});
  let stopped=false,timer=null,idleSamples=0,blocker=blockedBy;
  const release=()=>{if(stopped)return;stopped=true;clearTimeout(timer);clearTimeout(cap);flight()};
  const cap=setTimeout(release,capMs);cap.unref?.();
  const read=async(client,verb,args={})=>{
    try{return await client.ok(verb,args,{timeoutMs:5000,probeMs:0})}catch{return null}
  };
  const schedule=()=>{if(!stopped){timer=setTimeout(settle,settleMs);timer.unref?.()}};
  async function settle() {
    if(stopped)return;
    // A failed liveness check is not evidence of death.
    try{if(Number.isSafeInteger(record?.pid)&&alive(record.pid)===false)return release()}catch{}
    try {
      // Resolve the selected target on every sample: reconnect may have attached a replacement bridge.
      const client=typeof bridge==='function'?bridge():bridge??o11Bridge(bridgeTarget({lane,root}));
      const sampledAt=Date.now();
      const [status,windows,ui,modules]=await Promise.all([
        operationId?read(client,'merge_status',{operation_id:operationId,...(moduleKey?{module_key:moduleKey}:{})}):null,
        read(client,'windows',{max_texts:20}),
        waitsForUi?read(client,'ui_alive',{timeout_ms:1000}):null,
        waitsForUi?read(client,'list_open_modules'):null,
      ]);
      if(stopped)return;
      const journalEnded=operationId&&['applied','unchanged','not-applied'].includes(status?.state);
      if(journalEnded&&!waitsForUi)return release();
      const optionalFlag=v=>v==null||typeof v==='boolean';
      // CX14 R5: every valid read says what blocks now. A window that counts (the same blocker, or one that came back
      // after it was dismissed or went away) marks the holder stalled again, so a write answers at once with the recovery;
      // none clears it. observedAt: a dismiss that cleared the blocker after this read began wins over this read.
      const now=currentBlocker(windows?.windows,blocker);
      const noDialogs=now===null;
      if(now) flight.update?.({blockedBy:now,observedAt:sampledAt});
      else if(now===null&&blocker) flight.update?.({blockedBy:null});
      if(now!==undefined) blocker=now;
      if(waitsForUi) {
        const listed=Array.isArray(modules?.modules)?modules.modules:null;
        const validModules=listed!==null&&listed.every(m=>m&&typeof m==='object'&&!Array.isArray(m)&&optionalFlag(m.serverSilentMode)&&optionalFlag(m.hasOpenedActiveESpace)&&(m.serverOperation==null||(typeof m.serverOperation==='object'&&!Array.isArray(m.serverOperation)&&optionalFlag(m.serverOperation.running))));
        const idle=noDialogs&&!blocker&&ui?.alive===true&&validModules
          &&!listed.some(m=>m.serverSilentMode===true||m.hasOpenedActiveESpace===false||m.serverOperation?.running===true);
        idleSamples=idle?idleSamples+1:0;
        if(idleSamples>=2&&(!operationId||journalEnded))return release();
      }
    }catch{ /* Unknown or refused reads leave the operation fenced. */ }
    schedule();
  }
  schedule();
  return release;
}
