// Private adapter: the browser runs the shared inspector core and the host
// owns the same paused-frame transport and sealed value channel as Node.
import {installNativeBrowserInspection} from './debug-native-browser-inspection-install.mjs';
import {connectNativeClientInspector} from './debug-native-client-inspection.mjs';

export async function connectNativeBrowserInspection({host,options,privateChannel,onEvent,leaseMs=300000},
  {connect=connectNativeClientInspector}={}){
  const fail=code=>{throw new Error('debug_native_browser_inspection_'+code);};
  if(typeof host?.page?.send!=='function'||typeof host?.page?.evaluate!=='function'||typeof host?.dispose!=='function'||
    !privateChannel||['publish','consume','invalidate','close'].some(k=>typeof privateChannel[k]!=='function'))fail('contract_invalid');
  let client,installed,closed=false,started=false,closePromise;
  const terminate=()=>{void host.dispose();};
  async function remove(){
    return installed?.remove();
  }
  try{
    installed=await installNativeBrowserInspection({host,options});
    client=await connect({...installed.capability,privateChannel,onEvent,leaseMs,terminate});
    return {
      command:input=>client.command(input),
      consumePrivate:(descriptor,consume)=>client.consumePrivate(descriptor,consume),
      async start(){
        if(closed||started)fail('start_invalid');started=true;
        try{
          await installed.start();
        }catch{await this.close();fail('start_failed');}
        return {started:true};
      },
      close(){
        if(closePromise)return closePromise;closed=true;
        closePromise=(async()=>{
          // The transport clears private watches in the paused frame and
          // terminates an owned paused browser without resuming app code.
          let transport,browserHelper,channel;
          try{transport=await client.close();}catch{transport={closed:false};terminate();}
          try{browserHelper=await remove();}catch{browserHelper={removed:false};terminate();}
          finally{channel=privateChannel.close();}
          return {closed:true,transport,browserHelper,privateInspectionCleanup:channel};
        })();return closePromise;
      },
      receipt:()=>({...installed.receipt(),started,closed}),
    };
  }catch{
    try{await client?.close();await remove();}catch{terminate();}
    privateChannel.close();fail('setup_failed');
  }
}
