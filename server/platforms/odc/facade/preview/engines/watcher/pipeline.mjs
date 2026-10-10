// Orchestration only: all Studio and filesystem operations are injected adapters.
export class LivePipeline {
  constructor({adapter,target,onStatus=()=>{},now=()=>Date.now(),debounceMs=1200,backoffMs=2000,maxBackoffMs=10000,captureRetryMs=750,captureFastWindowMs=6000}) {
    this.adapter=adapter;this.target=target;this.onStatus=onStatus;this.now=now;
    this.debounceMs=debounceMs;this.backoffMs=backoffMs;this.maxBackoffMs=maxBackoffMs;
    if(captureRetryMs<700||captureRetryMs>1000||captureFastWindowMs<0||captureFastWindowMs>10000||maxBackoffMs<backoffMs)throw new Error('Invalid bounded capture recovery policy');
    this.captureRetryMs=captureRetryMs;this.captureFastWindowMs=captureFastWindowMs;this.captureDeferredSince=null;this.captureSlowFailures=0;
    this.pending=null;this.blocked=null;this.quietAt=0;this.retryAt=0;this.failures=0;this.polling=false;this.running=true;this.flight=null;this.observerRecovery=null;
    this.state={status:'watching',...target,observedRevision:null,lastCapturedAt:null,lastCaptureSha256:null,lastExportedAt:null,lastExportedSha256:null,lastLinkedAt:null,lastLinkedSha256:null,stale:true,latencyMs:null,timings:{},running:true};
    this.publish();
  }
  publish(values={}) {Object.assign(this.state,values,{updatedAt:new Date(this.now()).toISOString()});this.onStatus(structuredClone(this.state));}
  signalToken(signal) {
    if(signal.ok!==true||signal.available!==true)throw Object.assign(new Error(signal.error||'Observer is unavailable'),{code:'OBSERVER_UNAVAILABLE',retryable:true});
    for(const key of ['module','moduleKey','host','pid'])if(signal[key]!==this.target[key])throw Object.assign(new Error(`Observer target mismatch: ${key}`),{code:'OBSERVER_TARGET',retryable:false});
    if(typeof signal.epoch!=='string'||!Number.isSafeInteger(signal.revision)||signal.revision<1)throw Object.assign(new Error('Invalid observer revision'),{code:'OBSERVER_REVISION',retryable:false});
    return `${signal.epoch}:${signal.revision}`;
  }
  observe(signal) {
    const token=this.signalToken(signal);
    if(token!==this.state.observedRevision){
      this.observerRecovery=null;
      this.pending=token;this.blocked=null;this.quietAt=this.now()+this.debounceMs;if(this.captureDeferredSince===null)this.retryAt=0;this.failures=0;
      this.publish({observedRevision:token,lastModelChangedAt:signal.lastChangedAt,signalReason:signal.reason,stale:true,error:null,...(!this.flight?{status:'watching'}:{})});
    }else if(this.observerRecovery){
      const restore=this.observerRecovery;this.observerRecovery=null;
      // Same revision can recover after a transient read failure. Restore only
      // the observer overlay; a subsequent capture/export/link error wins.
      if(this.state.error?.origin==='observer')this.publish(this.state.status==='error'?restore:{error:null});
    }
    return token;
  }
  async tick() {
    if(!this.running||this.polling)return;
    this.polling=true;
    try {
      this.observe(await this.adapter.readSignal());
      if(!this.flight&&this.pending&&this.pending!==this.blocked&&this.now()>=this.quietAt&&this.now()>=this.retryAt){
        const revision=this.pending;
        this.flight=this.run(revision).finally(()=>{this.flight=null;});
      }
    }catch(e){if(this.state.error?.origin!=='observer')this.observerRecovery={status:this.state.status,stale:this.state.stale,error:this.state.error??null};this.publish({status:'error',stale:true,error:{code:e.code||'SIGNAL_ERROR',message:e.message,origin:'observer'}});}
    finally{this.polling=false;}
  }
  async current(revision){return this.observe(await this.adapter.readSignal())===revision;}
  async run(revision) {
    const started=this.now();let stage='capture';
    try{
      this.publish({status:'capturing',error:null,captureRevision:revision,stale:true,retryable:false,retryAt:null,retryDelayMs:null});
      const captured=await this.adapter.capture({revision});
      if(captured.captureRevision!==undefined&&captured.captureRevision!==revision)throw Object.assign(new Error('Capture belongs to a different observed revision'),{code:'CAPTURE_REVISION_MISMATCH',retryable:false});
      this.captureDeferredSince=null;this.captureSlowFailures=0;this.retryAt=0;
      this.publish({lastCapturedAt:captured.capturedAt,lastCaptureSha256:captured.sha256,captureDeferredSince:null,timings:{...this.state.timings,captureMs:this.now()-started}});
      if(!this.running)return;
      if(!await this.current(revision)){this.publish({status:'watching',stale:true,discardedRevision:revision});return;}
      if(captured.sha256===this.state.lastExportedSha256){
        if(this.pending===revision)this.pending=null;
        this.failures=0;this.publish({status:'watching',stale:false,error:null,unchangedCapture:true,latencyMs:this.now()-started});return;
      }
      stage='export';const exportStarted=this.now();
      this.publish({status:'exporting',unchangedCapture:false});
      const exported=await this.adapter.exportCapture(captured);
      this.publish({timings:{...this.state.timings,exportMs:this.now()-exportStarted}});
      if(!await this.current(revision)){this.publish({status:'watching',stale:true,discardedRevision:revision});return;}
      if(!this.running)return;
      stage='link';const linkStarted=this.now();
      this.publish({status:'linking'});
      const linked=await this.adapter.linkExport({captured,exported});
      this.publish({timings:{...this.state.timings,linkMs:this.now()-linkStarted}});
      if(!this.running)return;
      if(!await this.current(revision)){this.publish({status:'watching',stale:true,discardedRevision:revision});return;}
      stage='activation';
      await this.adapter.activate({captured,exported:linked,revision});
      if(this.pending===revision)this.pending=null;
      this.failures=0;
      this.publish({status:'watching',lastExportedAt:new Date(this.now()).toISOString(),lastExportedSha256:captured.sha256,lastLinkedAt:new Date(this.now()).toISOString(),lastLinkedSha256:linked.acquisitionSha256||null,lastLinkReceipt:linked.receipt||null,exportedRevision:revision,linkedRevision:revision,stale:this.pending!==null,error:null,latencyMs:this.now()-started});
    }catch(e){
      this.failures++;
      // Only capture availability proven before a snapshot send can retry.
      // Compiler, assembly, activation and uncertain snapshot failures never replay.
      const retryable=stage==='capture'&&e.captureDeferred===true&&e.writeAttempted===false;
      let delay=null;
      if(retryable){
        this.captureDeferredSince??=this.now();
        delay=this.now()-this.captureDeferredSince<this.captureFastWindowMs?this.captureRetryMs:Math.min(this.maxBackoffMs,this.backoffMs*2**Math.min(this.captureSlowFailures++,8));
        this.retryAt=this.now()+delay;
      }else{this.blocked=revision;this.retryAt=0;}
      this.publish({status:retryable?'capture-deferred':e.reconciliationRequired===true?'capture-reconciliation-required':'error',stale:true,error:{code:e.code||'PIPELINE_ERROR',message:e.message,origin:stage,command:e.command??null,phase:e.phase??null,writeAttempted:e.writeAttempted??null,reconciliationRequired:e.reconciliationRequired===true},retryable,retryDelayMs:delay,retryAt:retryable?new Date(this.retryAt).toISOString():null,captureDeferredSince:this.captureDeferredSince===null?null:new Date(this.captureDeferredSince).toISOString(),latencyMs:this.now()-started});
    }
  }
  async idle(){await this.flight;}
  async stop(){this.running=false;await this.flight;this.publish({running:false,status:'watching'});}
}
