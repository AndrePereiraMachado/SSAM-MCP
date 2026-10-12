// Node adapter for the shared native inspection core and private V8 transport.
import inspector from 'node:inspector';
import { randomBytes, createHash } from 'node:crypto';
import { createNativeClientInspectionCore } from './debug-native-client-inspection-core.mjs';
import { createPrivateCompareSession, privateCompareCommand } from './debug-private-compare.mjs';
export { redactNativeClientValue } from './debug-native-client-inspection-core.mjs';
const fail = code => { throw new Error('debug_native_client_' + code); };
export function createNativeClientInspection(options) {
  return createNativeClientInspectionCore(options, {
    digest: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    token: () => randomBytes(24).toString('hex'),
    byteLength: value => Buffer.byteLength(value),
    privateCompare: settings => createPrivateCompareSession(settings),
  });
}

// Only the selected breakpoints and the original pauseOnAllExceptions switch
// reach enable(); a non-boolean switch is refused, never coerced.
export function clientInspectionEnableOptions(options = {}) {
  if (options.pauseOnExceptions !== undefined && typeof options.pauseOnExceptions !== 'boolean') fail('pause_on_exceptions_invalid');
  return { breakpoints: options.breakpoints ?? [], pauseOnExceptions: options.pauseOnExceptions === true };
}

// The inspector endpoint is a private worker capability; never put it in receipts.
export function openNativeClientInspector() {
  if (inspector.url()) fail('inspector_already_open');
  inspector.open(0, '127.0.0.1', false);
  return { url: inspector.url(), close: () => inspector.close() };
}

export async function connectNativeClientInspector({ url, helperName, privateConsumerCapability, privateChannel, privateCompare, onEvent = () => {}, WebSocketImpl = WebSocket, leaseMs = 300000, terminate = () => {} }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !/^__ssamInspection_[a-f0-9]{48}$/.test(helperName) ||
      !Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 1800000 ||
      privateConsumerCapability!==undefined && !/^[a-f0-9]{48}$/.test(privateConsumerCapability) ||
      privateChannel && (!privateConsumerCapability || ['publish','consume','invalidate','close'].some(name=>typeof privateChannel[name]!=='function')) ||
      privateCompare!==undefined && (!privateChannel || ['member','compare'].some(name=>typeof privateCompare?.[name]!=='function'))) fail('connection_invalid');
  const socket = new WebSocketImpl(url), pending = new Map();
  const executionContexts = new Set();
  const deadline = Date.now() + leaseMs, expiresAt = new Date(deadline).toISOString();
  const notify = event => { try { onEvent(event); } catch { /* notification cannot silently resume execution */ } };
  let sequence = 0, callFrameId, pauseState, leaseTimer, closed = false, commandQueue = Promise.resolve();
  // Host-held fingerprints of host-sealed captures survive steps; stop/close ends
  // them. An injected public session belongs to its owner: only release our member.
  const compare = privateChannel ? privateCompare ?? createPrivateCompareSession({ runtime: 'client' }) : undefined;
  let compareMember;
  const releaseCompare = () => { try { if (privateCompare) compareMember?.release(); else compare?.close(); } catch { /* idempotent */ } };
  const clearPrivate = (close = false) => { if (close) releaseCompare(); return privateChannel?.[close ? 'close' : 'invalidate'](); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('debug_native_client_closed')); return; }
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('debug_native_client_transport_timeout')); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const invoke = async input => {
    if (!callFrameId) fail('stale_reference');
    const result = await send('Debugger.evaluateOnCallFrame', { callFrameId,
      expression: 'globalThis[' + JSON.stringify(helperName) + '](' + (input.op === 'pause'
        ? '{op:"pause",callContextId:arguments[0],nativeDebugger:this}' : JSON.stringify(input)) + ')',
      returnByValue: true, silent: true });
    if (result.exceptionDetails || !result.result?.value?.ok) {
      const code = result.result?.value?.error;
      const error = new Error(/^debug_native_client_[a-z_]+$/.test(code ?? '') ? code : 'debug_native_client_evaluation_failed');
      error.context = result.result?.value?.context;
      throw error;
    }
    return result.result.value.result;
  };
  socket.addEventListener('message', event => {
    let reply; try { reply = JSON.parse(event.data); } catch { return; }
    if (reply.id) {
      const request = pending.get(reply.id); if (!request) return;
      pending.delete(reply.id); clearTimeout(request.timer);
      reply.error ? request.reject(new Error('debug_native_client_protocol_failed')) : request.resolve(reply.result); return;
    }
    if (reply.method === 'Runtime.executionContextCreated') executionContexts.add(reply.params.context.id);
    if (reply.method === 'Runtime.executionContextDestroyed') executionContexts.delete(reply.params.executionContextId);
    if (reply.method === 'Runtime.executionContextsCleared') executionContexts.clear();
    if (reply.method === 'Debugger.paused') {
      commandQueue = commandQueue.then(async () => {
        // callDebugger is the native runtime boundary. Other JS pauses cannot be
        // promoted into an OutSystems frame or evaluated as one.
        const nativeFrame = reply.params.callFrames.find(f => /(?:^|\.)callDebugger$/.test(f.functionName));
        if (!nativeFrame) { await send('Debugger.resume'); return; }
        callFrameId = nativeFrame.callFrameId;
        try {
          pauseState = await invoke({ op: 'pause' });
          pauseState.expiresAt = expiresAt;
          notify({ kind: 'paused', ...pauseState });
        } catch { notify({ kind: 'inspection-failed', error: 'debug_native_client_context_unavailable' }); terminate(); }
      }).catch(() => { notify({ kind: 'inspection-failed', error: 'debug_native_client_protocol_failed' }); terminate(); });
    }
    if (reply.method === 'Debugger.resumed') { callFrameId = undefined; pauseState = undefined; const cleanup=clearPrivate(); notify({ kind: 'resumed', ...(cleanup ? {privateInspectionCleanup:cleanup} : {}) }); }
  });
  socket.addEventListener('close', () => { closed = true; clearTimeout(leaseTimer); const cleanup=clearPrivate(true); if(cleanup)notify({kind:'private-cleanup',...cleanup}); for (const r of pending.values()) { clearTimeout(r.timer); r.reject(new Error('debug_native_client_closed')); } pending.clear(); });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('debug_native_client_connection_failed')), { once: true }); });
  await send('Runtime.enable');
  await send('Debugger.enable');
  leaseTimer = setTimeout(() => {
    const cleanup=clearPrivate(true); notify({ kind: 'expired', ...pauseState, expiresAt, ...(cleanup ? {privateInspectionCleanup:cleanup} : {}) }); closed = true; terminate(); socket.close();
  }, Math.max(0, deadline - Date.now()));
  return {
    // Internal private-consumer API. No caller code or raw values are accepted
    // by public schemas. The callback result is deliberately never returned.
    consumePrivate(descriptor,consume){
      if(typeof consume!=='function' || !privateConsumerCapability)fail('private_consumer_unauthorized');
      const command=commandQueue.then(async()=>{
        if(Date.now()>=deadline)fail('expired');let result;
        try{result=privateChannel ? await invoke({op:'status'}) : await invoke({op:'private-consume',descriptor,consumerCapability:privateConsumerCapability});
          if(privateChannel)result={...result,value:privateChannel.consume(descriptor,result)};
          await consume(result.value,{stop:result.stop,generation:result.generation,frame:result.frame});
          return{consumed:true,stop:result.stop,generation:result.generation,frame:result.frame};
        }catch{fail('private_consumer_failed');
        }finally{result=undefined;}
      });commandQueue=command.catch(()=>{});return command;
    },
    command(input) {
      const command = commandQueue.then(async () => {
        if (Date.now() >= deadline) fail('expired');
        if(input.op==='private-capture' || input.op==='private-consume')fail('private_consumer_unauthorized');
        if (input.op === 'request-pause') {
          if (callFrameId) fail('pause_not_running');
          const matches = [];
          for (const contextId of executionContexts) {
            const probe = await send('Runtime.evaluate', { contextId,
              expression: 'typeof globalThis[' + JSON.stringify(helperName) + '] === "function"', returnByValue: true, silent: true });
            if (!probe.exceptionDetails && probe.result?.value === true) matches.push(contextId);
          }
          if (matches.length !== 1) fail('pause_context_unavailable');
          if (callFrameId) fail('pause_not_running');
          const result = await send('Runtime.evaluate', {
            contextId: matches[0],
            expression: 'globalThis[' + JSON.stringify(helperName) + ']({op:"request-pause"})',
            returnByValue: true, silent: true,
          });
          if (result.exceptionDetails || !result.result?.value?.ok) {
            const code = result.result?.value?.error;
            throw new Error(/^debug_native_client_[a-z_]+$/.test(code ?? '') ? code : 'debug_native_client_pause_uncertain');
          }
          return result.result.value.result;
        }
        if (input.op === 'status' && !callFrameId) return { paused: false };
        if (input.op === 'stop' && !callFrameId) {
          clearTimeout(leaseTimer); const cleanup=clearPrivate(true); terminate();
          return { paused: false, command: 'stop', executionOutcome: 'requires-reconciliation', workerTerminated: true, ...(cleanup ? {privateInspectionCleanup:cleanup} : {}) };
        }
        if(input.op==='private-read' && privateChannel){
          let capture;
          try{
            capture=await invoke({op:'private-capture',ref:input.ref,detail:input.detail,binary:input.binary,consumerCapability:privateConsumerCapability});
            const {privateEnvelope,...result}=capture;
            const {compareHandle,...privateInspection}=privateChannel.publish(privateEnvelope);
            let privateCompareHandle=compareHandle;
            if(privateCompareHandle===undefined){
              try{compareMember??=compare.member(privateEnvelope.context.sessionId);privateCompareHandle=compareMember.fingerprint(privateEnvelope);}
              catch{privateCompareHandle=null;}
            }
            return {...result,privateInspection,privateCompareHandle,...(pauseState?.expiresAt ? {expiresAt:pauseState.expiresAt} : {})};
          }finally{capture=undefined;}
        }
        if(input.op==='private-compare' && compare){
          // Host fingerprints are compared here; the paused runtime never sees them.
          return privateCompareCommand(compare,input,'debug_native_client_private_compare_');
        }
        const result = await invoke(input);
        if(['frame','invalidate','continue','stepInto','stepOver','stepOut','stop'].includes(input.op)){
          const cleanup=clearPrivate(input.op==='stop');if(cleanup)result.privateInspectionCleanup=cleanup;
        }
        if (input.op === 'stop') {
          clearTimeout(leaseTimer); callFrameId = undefined; pauseState = undefined; terminate();
          return { ...result, executionOutcome: 'requires-reconciliation', workerTerminated: true };
        }
        if (['continue', 'stepInto', 'stepOver', 'stepOut'].includes(input.op)) {
          callFrameId = undefined; pauseState = undefined; await send('Debugger.resume');
        }
        return { ...result, ...(pauseState?.expiresAt ? { expiresAt: pauseState.expiresAt } : {}) };
      });
      commandQueue = command.catch(() => {}); return command;
    },
    async close() {
      clearTimeout(leaseTimer);
      // The worker's stdin cannot run its disposal handler while V8 is paused.
      // Clear private watches through that exact paused frame before terminating;
      // never resume application code just to make cleanup possible.
      const closing = commandQueue.then(async () => {
        let privateInspectionCleanup;
        try {
          if (!closed && callFrameId)
            privateInspectionCleanup = (await invoke({ op: 'stop' })).privateInspectionCleanup;
        } finally {
          const cleanup=clearPrivate(true);if(cleanup)privateInspectionCleanup=cleanup;
          if (callFrameId) terminate();
          callFrameId = undefined; pauseState = undefined; closed = true; socket.close();
        }
        return { closed: true, ...(privateInspectionCleanup ? { privateInspectionCleanup } : {}) };
      });
      commandQueue = closing.catch(() => {});
      return closing;
    },
  };
}
