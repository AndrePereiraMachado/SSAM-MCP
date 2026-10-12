// Private HTTP broker for the native browser SDK's initialization and auth.
// Action requests belong to the separately authorized debugger transport.
import {odcNativeEndpoints} from './debug-odc-native-transport.mjs';
import {sameAppUserTarget} from './debug-app-user.mjs';
import {createHash} from 'node:crypto';
const fail=code=>{throw new Error('debug_odc_browser_metadata_'+code);};
function responseCorrelation(headers){
  const result={};
  // Only typed correlation identifiers, never arbitrary headers or cookies.
  const trace=headers?.get?.('traceparent');
  const parts=typeof trace==='string'?/^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(trace):null;
  if(parts&&parts[1]!=='0'.repeat(32)&&parts[2]!=='0'.repeat(16))result.traceId=parts[1];
  for(const name of ['x-request-id','x-amzn-requestid']){
    const value=headers?.get?.(name);
    if(typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))result[name]=value;
  }
  return result;
}

export function createOdcBrowserMetadata({runtime,homeModuleKey,fetchImpl=fetch,beforeSync,recordSyncResult,clock=Date.now}){
  const endpoints=odcNativeEndpoints(runtime);
  if(typeof runtime.moduleVersion!=='string' || !runtime.moduleVersion)fail('version_required');
  if(homeModuleKey!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(homeModuleKey))fail('home_module_invalid');
  const abort=new AbortController(),requests=[],pending=new Set(),waiters=new Set();
  const changed=()=>{for(const wake of [...waiters])wake();};
  let session,descriptor,startupProfile,closed=false,syncAttempted=false,syncUncertain=false,syncAccepted=false;
  const expiry=()=>Math.min(Date.parse(session?.expiresAt),Date.parse(descriptor?.expiresAt));
  const receipt=()=>({requests:requests.map(r=>({...r})),pending:pending.size,syncAttempted,syncUncertain,syncAccepted,closed,
    ...(startupProfile?{startupProfile:{...startupProfile}}:{})});
  const broker={
    bindSession(value,owner){
      if(closed || session || !sameAppUserTarget(value?.binding,owner?.binding) || value.binding.runtimeUrl!==endpoints.appUrl ||
        typeof value.accessToken!=='string' || !value.accessToken || !Number.isFinite(Date.parse(value.expiresAt)) ||
        !Number.isFinite(Date.parse(owner.expiresAt)) || Math.min(Date.parse(value.expiresAt),Date.parse(owner.expiresAt))<=clock())fail('session_invalid');
      session=value;descriptor=owner;
    },
    request(input){
      const operation=performRequest(input);
      pending.add(operation);
      const done=()=>{pending.delete(operation);changed();};
      operation.then(done,done);
      return operation;
    },
    // Wait only for requests already submitted to this broker, including their
    // response bodies. Idle does not imply that authentication or sync passed.
    async settle({timeoutMs=15000}={}){
      if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)fail('settle_timeout_invalid');
      const deadline=Date.now()+timeoutMs;
      while(pending.size){
        const remaining=deadline-Date.now();if(remaining<=0)fail('settle_timeout');
        let timer;
        try{
          await Promise.race([Promise.allSettled([...pending]),new Promise((_,reject)=>{
            timer=setTimeout(()=>reject(new Error('debug_odc_browser_metadata_settle_timeout')),remaining);
          })]);
        }finally{clearTimeout(timer);}
      }
      return receipt();
    },
    // Unlike settle, this waits even when the browser has not dispatched the
    // native background sync yet. Only confirmed, journaled sync may pass.
    async waitForAuthenticationSync({timeoutMs=15000}={}){
      if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)fail('sync_timeout_invalid');
      if(typeof recordSyncResult!=='function')fail('result_journal_required');
      const deadline=Date.now()+timeoutMs;
      for(;;){
        if(closed||!session||clock()>=expiry())fail('expired');
        if(syncAttempted && pending.size===0){
          const syncRecord=requests.find(r=>r.method==='POST'&&r.path===endpoints.sync);
          if(!syncAccepted||syncUncertain||syncRecord?.resultRecorded!==true)fail('sync_unconfirmed');
          return receipt();
        }
        const remaining=Math.min(deadline-Date.now(),expiry()-clock());
        if(remaining<=0)fail('sync_timeout');
        await new Promise((resolve,reject)=>{
          const wake=()=>{clearTimeout(timer);waiters.delete(wake);resolve();};
          const timer=setTimeout(()=>{waiters.delete(wake);reject(new Error('debug_odc_browser_metadata_sync_timeout'));},remaining);
          waiters.add(wake);
        });
      }
    },
    receipt,
    close(){closed=true;abort.abort();session=undefined;descriptor=undefined;changed();return receipt();},
  };
  return broker;
  async function performRequest(input){
      if(closed || session && clock()>=expiry())fail('expired');
      let url;try{url=new URL(input.url);}catch{fail('scope_invalid');}
      if(url.origin!==endpoints.origin || url.username || url.password || url.hash)fail('scope_invalid');
      const identity=['/api/user-information/v1/profiles/me','/api/user-information/v1/claims'].includes(url.pathname);
      const sync=input.method==='POST' && url.pathname===endpoints.sync;
      const allowed=[endpoints.authConfigs,endpoints.clientSettings,endpoints.versionInfo,endpoints.moduleInfo,'/identity/.well-known/openid-configuration'].includes(url.pathname) ||
        identity || /^\/auth\/realms\/[a-f0-9-]+\/protocol\/openid-connect\/certs$/.test(url.pathname);
      if(input.method==='GET' ? !allowed : !sync || syncAttempted || !session || typeof beforeSync!=='function')fail('request_refused');
      if(input.postData || input.hasPostData || input.postDataEntries?.length)fail('body_refused');
      const headers={Accept:'application/json'};
      const auth=Object.entries(input.headers??{}).filter(([name])=>name.toLowerCase()==='authorization');
      if(auth.length>1 || auth.length && (!session || auth[0][1]!=='Bearer '+session.accessToken))fail('auth_mismatch');
      if(auth.length)headers.Authorization=auth[0][1];
      if((sync||identity)&&!headers.Authorization)fail('auth_required');
      const record={method:input.method,path:url.pathname,phase:'prepared'};requests.push(record);
      if(url.pathname===endpoints.moduleInfo)startupProfile=undefined;
      if(sync){
        // Reserve before awaiting the durable journal. A concurrent or later
        // second synchronization can never get through this broker instance.
        syncAttempted=true;
        try{if((await beforeSync({method:'POST',path:url.pathname}))?.recorded!==true)fail('journal_failed');}
        catch{record.phase='journal-failed';fail('journal_failed');}
      }
      try{
        if(closed || session && clock()>=expiry())fail('expired');
        record.phase='sent';if(sync)syncUncertain=true;
        const response=await fetchImpl(url,{method:input.method,headers,credentials:'omit',redirect:'error',
          signal:AbortSignal.any([abort.signal,AbortSignal.timeout(Math.max(1,Math.min(15000,session?expiry()-clock():15000)))])});
        record.status=response.status;record.phase='response';
        const correlation=responseCorrelation(response.headers);
        if(Object.keys(correlation).length)record.responseCorrelation=correlation;
        if(!response.ok || response.redirected)fail('response_failed');
        const body=await response.text();if(Buffer.byteLength(body)>8*1024*1024)fail('response_size');
        if(closed || session && clock()>=expiry())fail('expired');
        const data=body && !sync ? JSON.parse(body) : undefined;
        if(url.pathname===endpoints.versionInfo && data?.versionToken!==runtime.moduleVersion ||
          url.pathname===endpoints.moduleInfo && data?.manifest?.versionToken!==runtime.moduleVersion)fail('publication_changed');
        if(url.pathname===endpoints.moduleInfo&&homeModuleKey!==undefined){
          const module=data?.data?.modules?.[homeModuleKey],entities=data?.data?.entityModuleNames;
          if(!module||!Object.hasOwn(module,'splashScreenName')||
            module.splashScreenName!==null&&typeof module.splashScreenName!=='string'||
            !Array.isArray(entities)||entities.some(name=>typeof name!=='string'))fail('startup_profile_invalid');
          startupProfile={homeModuleKey,moduleInfoSha256:createHash('sha256').update(body).digest('hex'),
            hasSplashScreen:!!module.splashScreenName,entityModuleCount:entities.length,
            publicationMatched:true,observedAt:new Date(clock()).toISOString()};
        }
        record.phase='completed';if(sync){syncUncertain=false;syncAccepted=true;}
        return {status:response.status,body,headers:[{name:'Content-Type',value:'application/json'},{name:'Cache-Control',value:'no-store'}]};
      }catch(error){
        record.error=/^debug_odc_browser_metadata_[a-z_]+$/.test(error?.message??'')?error.message:'debug_odc_browser_metadata_request_failed';
        throw new Error(record.error);
      }finally{
        // Persist only transport evidence; never a token, identity or body.
        // A failed journal does not erase an observed response or permit replay.
        if(sync && typeof recordSyncResult==='function'){
          try{
            const result=await recordSyncResult({request:{...record},syncAttempted,syncUncertain,syncAccepted});
            if(result?.recorded!==true)fail('result_journal_failed');
            record.resultRecorded=true;
          }catch{
            record.resultRecorded=false;
            throw new Error('debug_odc_browser_metadata_result_journal_failed');
          }
        }
      }
  }
}
