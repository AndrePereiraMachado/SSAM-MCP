// Private controller/worker channel. Only opaque DPAPI references reach MCP/CLI.
import { randomBytes, createDecipheriv } from 'node:crypto';
import { createPrivateInspectionChannel } from './debug-private-inspection.mjs';
import { createPrivateCompareSession } from './debug-private-compare.mjs';
import { nativeParityLeaves, parityPrints, compareParityPrints } from './debug-native-output-comparison.mjs';
const fail=()=>{throw new Error('debug_server_private_inspection_unavailable');};
const fields=['threadId','eventId','generation','frame','moduleKey','functionKey','nodeKey'];
const sameContext=(a,b)=>fields.every(k=>a?.[k]===b?.[k]);
// GUID text (ODC user identifiers) compares case-insensitively and without Text quotes, at
// every depth of a server native value, so the app-user anchor and GetUserId() meet.
const GUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function canonicalGuids(node,depth=0){
  if(depth>64||!node||typeof node!=='object'||!Array.isArray(node.children))return node;
  if(node.children.length)return {...node,children:node.children.map(child=>canonicalGuids(child,depth+1))};
  const text=typeof node.value==='string'&&/^".*"$/s.test(node.value)?node.value.slice(1,-1):node.value;
  return typeof text==='string'&&GUID.test(text)?{...node,value:text.toLowerCase()}:node;
}
// services.privateCompare: the public session's compare session (one HMAC key per
// public session, shared by the native sessions of an O11 group). Without it this
// native session owns its key and destroys it on close.
export function createServerPrivateInspection({binding,expiresAt,sources},services={}) {
  const owned=!services.privateCompare,compare=services.privateCompare??createPrivateCompareSession({sessionId:binding.sessionId,lane:binding.lane,runtime:'server'});
  let channel;
  try{
    const member=compare.member(binding.sessionId);
    channel=createPrivateInspectionChannel({binding,expiresAt,sources},{...services,compare:Object.freeze({
      fingerprint:envelope=>member.fingerprint({...envelope,value:canonicalGuids(envelope.value)}),release:()=>member.release()})});
  }
  catch(error){if(owned)compare.close();throw error;}
  const key=randomBytes(32);
  let closed=false;
  const context=c=>({...c,sessionId:binding.sessionId,platform:binding.lane,runtime:'server'});
  const close=()=>{closed=true;key.fill(0);clearTimeout(timer);const cleanup=channel.close();if(owned)compare.close();return cleanup;};
  const timer=setTimeout(close,Math.max(1,Date.parse(expiresAt)-(services.clock??Date.now)()));timer.unref();
  return Object.freeze({
    bootstrapKey(){if(closed)fail();return key.toString('hex');},
    read(result,input){
      let clear;
      try{
        if(closed || result?.ok!==true || result.context?.threadId!==input.threadId || result.context?.eventId!==input.eventId ||
            result.reference!==input.reference)fail();
        const payload=result.privatePayload;
        if(payload?.format!=='ssam-server-private-inspection/1' || typeof payload.ciphertext!=='string' || payload.ciphertext.length>4*1024*1024)fail();
        const nonce=Buffer.from(payload.nonce,'base64'),tag=Buffer.from(payload.tag,'base64');
        if(nonce.length!==12 || tag.length!==16)fail();
        const decipher=createDecipheriv('aes-256-gcm',key,nonce);
        decipher.setAAD(Buffer.from('ssam-server-private-inspection/1|'+binding.sessionId));decipher.setAuthTag(tag);
        clear=Buffer.concat([decipher.update(Buffer.from(payload.ciphertext,'base64')),decipher.final()]);
        const envelope=JSON.parse(clear.toString('utf8'));
        if(!sameContext(envelope.context,result.context) || envelope.variable?.ref!==input.reference ||
            envelope.variable?.moduleKey!==result.context.moduleKey)fail();
        // The fingerprint is taken here, from the native value, before it is discarded.
        const {compareHandle,...descriptor}=channel.publish({...envelope,context:context(envelope.context)});
        return {ok:true,context:result.context,reference:result.reference,evaluationRevision:result.evaluationRevision,
          changed:result.changed,evaluatedAt:result.evaluatedAt,valueComplete:false,privateValueReturnedPublicly:false,privateInspection:descriptor,
          privateCompareHandle:compareHandle};
      }catch{fail();}finally{clear?.fill(0);}
    },
    invalidate:()=>channel.invalidate(),close,
    receipt:()=>channel.receipt(),
    // Booleans only; handles survive steps and are destroyed with this channel.
    compare(handles,options){if(closed)throw new Error('debug_private_compare_closed');return compare.compare(handles,options);},
    async consume(descriptor,currentContext,consumer){
      let value;
      try{
        if(closed || typeof consumer!=='function')fail();
        value=channel.consume(descriptor,context(currentContext));
        await consumer(value);
        return {consumed:true,context:currentContext};
      }catch{fail();}finally{value=undefined;}
    }
  });
}

// 'app-user' anchor of one public session: the coordinator registers the anchor of the
// original authenticated login (debug-app-user-odc.mjs odcAppUserAnchor) and passes
// provider to createPrivateCompareSession({anchorProvider}). The provider only seals it
// (HMAC under that session's key) for the server runtime; nothing is ever returned.
// Anonymous and native-background sessions never register one: compare is refused.
export function createAppUserAnchorRegistry(){
  let anchor=null,closed=false;
  const refuse=code=>{throw new Error('debug_server_private_inspection_anchor_'+code);};
  return Object.freeze({
    register(value){
      if(closed||value?.kind!=='app-user'||value.lane!=='odc'||typeof value.seal!=='function'||anchor&&anchor!==value)refuse('invalid');
      anchor=value;return {registered:true};
    },
    provider:({anchor:name,runtime,seal}={})=>{
      if(closed||!anchor||name!=='app-user'||runtime!=='server'||typeof seal!=='function')refuse('unavailable');
      return anchor.seal(seal,{runtime});
    },
    clear(){closed=true;anchor=null;return {cleared:true};},
    receipt:()=>({registered:!!anchor,closed,valueReturned:false}),
  });
}

// Producer End output vs original response. At the target End stop the coordinator consumes the
// private reads of the output roots (DPAPI channel above) into keyed per-path fingerprints, then
// compares them with the response observer's prints for the same scenario. Values are dropped at
// once; only counts leave (debug-native-output-comparison.mjs compareParityPrints).
export function createProducerOutputParity({random=randomBytes,maxRoots=100}={}){
  const key=random(32);let scenario=null,native=null,closed=false;
  const refuse=code=>{throw new Error('debug_producer_output_parity_'+code);};
  if(!Buffer.isBuffer(key)||key.length!==32)refuse('key_invalid');
  const empty=reason=>({schema:'ssam-producer-output-parity/1',complete:false,reason,compared:0,unequal:0,missing:0,extra:0,typeDifferences:0,parityEqual:false});
  return Object.freeze({
    // Private broker channel only (the native host's response observer).
    responseKey(){if(closed)refuse('closed');return key.toString('hex');},
    begin(id){if(closed||typeof id!=='string'||!/^[A-Za-z0-9_.:-]{1,120}$/.test(id))refuse('scenario_invalid');scenario=id;native=null;},
    async captureEnd(channel,reads,context,{functionKey,endNodeKey,rootMap}={}){
      if(closed)refuse('closed');
      if(!scenario)refuse('scenario_unbound');
      if(native)refuse('end_already_captured');
      if(!functionKey||!endNodeKey||context?.functionKey!==functionKey||context.nodeKey!==endNodeKey)refuse('end_stop_required');
      if(!Array.isArray(reads)||!reads.length||reads.length>maxRoots||typeof channel?.consume!=='function'||
          reads.some(r=>typeof r?.root!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(r.root))||new Set(reads.map(r=>r.root)).size!==reads.length)refuse('reads_invalid');
      const values=[],bound=scenario;
      try{
        for(const read of reads)await channel.consume(read.privateInspection,context,value=>{values.push([read.root,value]);});
        if(bound!==scenario||closed)refuse('scenario_changed');
        native=parityPrints(nativeParityLeaves(values,{rootMap}),key);
      }finally{values.length=0;}
      return {captured:true,roots:reads.length,complete:native.complete,valuesReturned:false};
    },
    // wire: the observer's responsePrints for this scenario's invocation. The capture is consumed.
    compare(wire,id){
      if(closed)refuse('closed');
      if(id!==scenario)refuse('scenario_mismatch');
      if(!native)return empty('producer-end-not-captured');
      if(wire?.schema!=='ssam-native-response-prints/1')return (native=null,empty(wire?.reason==='invocation-mismatch'?'invocation-mismatch':'native-response-not-observed'));
      const result=compareParityPrints(native,wire);native=null;return result;
    },
    close(){closed=true;key.fill(0);native=null;scenario=null;return {closed:true};},
  });
}
