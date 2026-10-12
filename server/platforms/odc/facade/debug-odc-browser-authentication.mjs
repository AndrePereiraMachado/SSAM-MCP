// Private host coordinator. An SDK login result alone is insufficient: the
// native background sync must have a confirmed response and durable receipt.
export function createOdcBrowserAuthentication({page,metadata,runtimeHandle,timeoutMs=45000}){
  const fail=code=>{throw new Error('debug_odc_browser_authentication_'+code);};
  if(!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(runtimeHandle??'') ||
    typeof page?.evaluate!=='function' || typeof metadata?.waitForAuthenticationSync!=='function' ||
    !Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)fail('contract_invalid');
  let attempted=false,confirmed=false,failureSync;
  async function settleFailedAuthentication(deadline){
    // The SDK may have submitted its background synchronization before its
    // evaluation failed. Preserve that request's answer before caller cleanup;
    // never submit another sync or promote a failed SDK login to success.
    if(metadata.receipt?.().syncAttempted!==true)return;
    failureSync={attempted:true,confirmed:false};
    const remaining=deadline-Date.now();
    if(remaining<=0){failureSync.error='debug_odc_browser_authentication_deadline';return;}
    try{
      await metadata.waitForAuthenticationSync({timeoutMs:remaining});
      failureSync.confirmed=true;
    }catch(error){
      failureSync.error=/^debug_odc_browser_metadata_[a-z_]+$/.test(error?.message??'')
        ?error.message:'debug_odc_browser_authentication_sync_unconfirmed';
    }
  }
  return {
    async authenticate(session,descriptor){
      if(attempted)fail('already_attempted');
      attempted=true;
      metadata.bindSession(session,descriptor);
      const deadline=Date.now()+timeoutMs;
      let result;
      try{
        result=await page.evaluate(async({handle,session})=>{
          try{
            const value=await globalThis[handle].authenticate(session);
            // Return only known booleans. Native errors and private state never
            // become the public result, even when native authentication fails.
            return {authenticated:value.authenticated===true,identityMatches:value.identityMatches===true,
              tokenMatches:value.tokenMatches===true};
          }catch{return {authenticated:false,identityMatches:false,tokenMatches:false};}
        },{handle:runtimeHandle,session},timeoutMs);
      }catch{await settleFailedAuthentication(deadline);fail('native_result_unconfirmed');}
      if(!result?.authenticated||!result.identityMatches||!result.tokenMatches){
        await settleFailedAuthentication(deadline);fail('identity_unconfirmed');
      }
      const remaining=deadline-Date.now();if(remaining<=0)fail('deadline');
      await metadata.waitForAuthenticationSync({timeoutMs:remaining});
      confirmed=true;
      return {authenticated:true,identityMatches:true,tokenMatches:true,nativeAuthenticationSyncAccepted:true,
        syncResultRecorded:true,mounted:false,permissionCheck:false};
    },
    receipt(){return {attempted,confirmed,...(failureSync?{failureSync:{...failureSync}}:{})};},
  };
}
