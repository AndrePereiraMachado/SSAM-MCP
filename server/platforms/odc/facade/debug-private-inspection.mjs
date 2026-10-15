// Private runtime worker only. Native values use CurrentUser DPAPI and the
// existing current-user ACL vault outside the repository. No public raw mode.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appUserBinding, sameAppUserTarget } from './debug-app-user.mjs';
import { debugStateBase } from './debug-state-root.mjs';

const helper = fileURLToPath(new URL('./debug-invoke-vault.ps1', import.meta.url));
const GUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = code => { throw new Error('debug_private_inspection_' + code); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest();
const contextKeys = ['sessionId','platform','runtime','stop','generation','callContextId','frame','threadId','eventId','moduleKey','functionKey','nodeKey'];
const sameContext = (a,b) => contextKeys.every(key => a?.[key] === b?.[key]);

function canonicalBinding(binding) {
  if (binding?.kind !== 'native-debug-session') return appUserBinding(binding,binding.sessionId);
  const {kind,sessionId,lane,runtimeUrl,moduleKey,module,contextMode,appUser,credentialOwnerSessionId}=binding;
  let url;try{url=new URL(runtimeUrl);}catch{fail('binding_invalid');}
  if (!/^[a-f0-9]{32}$/.test(sessionId ?? '') || !['o11','odc'].includes(lane) || url.protocol!=='https:' ||
      url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_+]{22}$/.test(moduleKey ?? '') ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,198}$/.test(module ?? '') || !['app-user','anonymous','native-background'].includes(contextMode)) fail('binding_invalid');
  const ownerSessionId=credentialOwnerSessionId ?? sessionId;
  if(credentialOwnerSessionId!==undefined && (lane!=='o11' || contextMode!=='app-user' ||
      !/^[a-f0-9]{32}$/.test(credentialOwnerSessionId) || credentialOwnerSessionId===sessionId ||
      !sameAppUserTarget(appUser,appUserBinding(binding,credentialOwnerSessionId))))fail('binding_invalid');
  if(contextMode==='app-user' && (!appUser || appUser.lane!==lane || appUser.sessionId!==ownerSessionId ||
      new URL(appUser.runtimeUrl).origin!==url.origin))fail('binding_invalid');
  if(contextMode!=='app-user' && appUser)fail('binding_invalid');
  return {kind,sessionId,lane,runtimeUrl,moduleKey,module,contextMode,
    ...(credentialOwnerSessionId!==undefined?{credentialOwnerSessionId}:{}),...(appUser?{appUser:appUserBinding(appUser,ownerSessionId)}:{})};
}
const sameBinding=(a,b)=>a?.kind==='native-debug-session' || b?.kind==='native-debug-session'
  ? JSON.stringify(a)===JSON.stringify(b) : sameAppUserTarget(a,b);

// Synchronous because V8 is paused in the original debugger. Async callbacks
// cannot run until that pause is consumed. Only public script/ref/mode/roots in argv.
// Records go to the debugger state root (debug-state-root.mjs); sourceRoot opens one legacy copy read only.
const literal = s => "'" + s.replace(/'/g, "''") + "'";
// Each vault call is one powershell.exe; a call slower than this bound fails as vault_unavailable. A window that wraps
// real vault calls (a credential lease, a channel expiry) is sized as calls x this bound, never as an idle-machine guess.
export const PRIVATE_VAULT_CALL_TIMEOUT_MS = 8000;
export function privateInspectionVault(mode, ref, value, { sourceRoot } = {}) {
  if (!['Seal','Open','Forget'].includes(mode) || !GUID.test(ref ?? '') ||
      sourceRoot !== undefined && (mode !== 'Open' || !path.isAbsolute(sourceRoot ?? ''))) fail('vault_request_invalid');
  let stateRoot; try { stateRoot = debugStateBase(); } catch { fail('vault_unavailable'); }
  const code = '& {\n' + fs.readFileSync(helper,'utf8') + `\n} -Mode '${mode}' -PlanId '${ref}' -StateRoot ${literal(stateRoot)}` +
    (sourceRoot ? ' -SourceRoot ' + literal(sourceRoot) : '');
  let input, output;
  try {
    input = value === undefined ? '' : JSON.stringify(value);
    if (Buffer.byteLength(input) > 4*1024*1024) fail('value_budget');
    const child = spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],
      { windowsHide:true, input, encoding:'utf8', timeout:PRIVATE_VAULT_CALL_TIMEOUT_MS, maxBuffer:4*1024*1024, stdio:['pipe','pipe','ignore'] });
    if (child.error || child.status !== 0) fail('vault_unavailable');
    output = child.stdout;
    const result = JSON.parse(output.replace(/^\uFEFF/,''));
    if (mode !== 'Open' && result?.ok !== true) fail('vault_unavailable');
    return result;
  } catch { fail('vault_unavailable'); }
  finally { input = undefined; output = undefined; }
}

function validateEnvelope(envelope, binding, sources) {
  const c=envelope?.context,v=envelope?.variable;
  const server=binding.kind==='native-debug-session';
  const nativeContext=server ? c?.runtime==='server' && c.sessionId===binding.sessionId &&
    typeof c.threadId==='string' && c.threadId.length>0 && c.threadId.length<=200 && /^\d+$/.test(c.eventId ?? '')
    : c?.runtime==='client' && /^[a-f0-9]{48}$/.test(c.sessionId ?? '') && Number.isInteger(c.stop) && c.stop>=1 && Number.isInteger(c.callContextId);
  if (!c || c.platform !== binding.lane || !nativeContext || !Number.isInteger(c.generation) || c.generation<(server?1:0) ||
      !Number.isInteger(c.frame) || c.frame<0 || !v ||
      !(server?/^[a-f0-9]{32}$/:/^[a-f0-9]{48}$/).test(v.ref ?? '') || !HASH.test(v.sourceSha256 ?? '') ||
      !sources.some(s=>s.moduleKey===v.moduleKey && s.sourceSha256===v.sourceSha256) ||
      typeof envelope.value !== 'object' || envelope.value === null || typeof envelope.value.type !== 'string' ||
      !Object.hasOwn(envelope.value,'value')) fail('scope_invalid');
}

// Optional compare member (debug-private-compare.mjs): a handle to an in-memory
// HMAC fingerprint, minted only after a verified round trip. It is never sealed,
// survives invalidate (steps) and is released by close (stop).
export function createPrivateInspectionChannel({ binding, expiresAt, sources }, { vault=privateInspectionVault, clock=Date.now, compare }={}) {
  const canonical=canonicalBinding(binding),expiry=Date.parse(expiresAt);
  if (!sameBinding(binding,canonical) || !Number.isFinite(expiry) || expiry<=clock() ||
      !Array.isArray(sources) || !sources.length || sources.some(s=>!HASH.test(s.sourceSha256 ?? '')) ||
      compare!==undefined && (typeof compare?.fingerprint!=='function' || typeof compare.release!=='function')) fail('binding_invalid');
  const pending=new Set(),active=new Map(); let closed=false;
  const clear=()=>{
    let completed=true;
    for(const ref of [...pending]){try{if(vault('Forget',ref)?.ok!==true)throw new Error();pending.delete(ref);}catch{completed=false;}}
    return {completed,pending:pending.size};
  };
  return Object.freeze({
    publish(envelope) {
      if (closed || clock()>=expiry) fail('expired');
      if (pending.size>=100) fail('reference_budget');
      validateEnvelope(envelope,canonical,sources);
      const ref=randomUUID(),record={schema:'ssam-private-inspection/1',binding:canonical,expiresAt,
        context:envelope.context,variable:envelope.variable,value:envelope.value};
      // Reserve before I/O. A lost Seal reply is never retried.
      pending.add(ref);let opened;
      try{
        if(vault('Seal',ref,record)?.ok!==true)fail('seal_failed');
        opened=consumePrivateInspection({reference:ref,expiresAt}, {binding:canonical,context:envelope.context,variable:envelope.variable}, {vault,clock});
        if(!timingSafeEqual(digest(opened),digest(envelope.value)))fail('round_trip_failed');
        if(clock()>=expiry)fail('expired');
        active.set(ref,{context:structuredClone(envelope.context),variable:structuredClone(envelope.variable)});
        let compareHandle;
        if(compare){try{compareHandle=compare.fingerprint(envelope);}catch{compareHandle=null;}}
        return {reference:ref,expiresAt,sealed:true,roundTripVerified:true,storage:'windows-current-user-dpapi',plaintextPersisted:false,
          ...(compare?{compareHandle}:{})};
      }catch{try{if(vault('Forget',ref)?.ok===true)pending.delete(ref);}catch{}fail('publish_failed');}
      finally{opened=undefined;}
    },
    consume(descriptor,context){
      const source=active.get(descriptor?.reference);
      if(closed || clock()>=expiry || !source || !sameContext(source.context,context))fail('stale_reference');
      return consumePrivateInspection(descriptor,{binding:canonical,...source},{vault,clock});
    },
    invalidate(){active.clear();return clear();},
    close(){closed=true;active.clear();try{compare?.release();}catch{}return clear();},
    receipt(){return{pending:pending.size,active:active.size,closed,plaintextPersisted:false};},
  });
}

// Only a private consumer calls this function. Never register it as an MCP tool
// or print its return. The public descriptor does not authorize another target,
// native stop/frame/variable, or an expired snapshot.
function consumePrivateInspection(descriptor, expected, {vault=privateInspectionVault,clock=Date.now}={}) {
  if(!GUID.test(descriptor?.reference ?? '') || !Number.isFinite(Date.parse(descriptor.expiresAt)) || Date.parse(descriptor.expiresAt)<=clock())fail('expired');
  let record;
  try{
    record=vault('Open',descriptor.reference);
    if(record?.schema!=='ssam-private-inspection/1' || record.expiresAt!==descriptor.expiresAt ||
        !sameBinding(record.binding,expected?.binding) || !sameContext(record.context,expected?.context) ||
        JSON.stringify(record.variable)!==JSON.stringify(expected?.variable))fail('scope_invalid');
    if(clock()>=Date.parse(record.expiresAt))fail('expired');
    return record.value;
  }catch{fail('unavailable');}
  finally{record=undefined;}
}
