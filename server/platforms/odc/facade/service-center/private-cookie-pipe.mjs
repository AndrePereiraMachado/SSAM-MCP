import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {privateContext,hostedHandoffRefusal} from '../../portal/runtime/private-session-pipe.mjs';
import {hostedContext} from '../executor.mjs';
// servidor/fase4-24 (R3): a local pipe of the machine that runs SSAM; never opened in hosted mode (HOSTED_STUDIO_SESSION_ONLY).

const refused=()=>Object.assign(new Error('Private cookie exchange did not complete; no session value is exposed.'),{code:'PRIVATE_COOKIE_EXCHANGE_UNAVAILABLE'});
export function cookieUpdate(bytes,scope,now=Date.now()){
 try{
  if(bytes.length<1||bytes.length>65536)throw refused();
  const value=JSON.parse(bytes.toString('utf8'));
  const keys=['schema','requestSha256','host','principal','url','issuedAt','expiresAt','cookies'];
  if(!value||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k))
   ||value.schema!=='ssam-o11-cookie-update/1'||value.requestSha256!==scope.requestSha256||value.host!==scope.host
   ||typeof value.principal!=='string'||value.principal.trim().toLowerCase()!==scope.principal.trim().toLowerCase()
   ||value.url!==scope.url||!Array.isArray(value.cookies)||value.cookies.length>64
   ||value.cookies.some(c=>typeof c!=='string'||c.length>48000||/[\x00-\x1f\x7f]/.test(c)))throw refused();
  const issued=Date.parse(value.issuedAt),expires=Date.parse(value.expiresAt);
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.issuedAt)
   ||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.expiresAt)
   ||!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now+5000||expires<=now||expires<=issued||expires-issued>30000)throw refused();
  return value.cookies;
 }catch{throw refused();}
}

export async function withPrivateCookieExchange(scope,invoke,{connect=pipe=>net.createConnection(pipe),platform=process.platform,timeoutMs=60000}={}){
 if(hostedContext())throw hostedHandoffRefusal();
 if(platform!=='win32'||typeof invoke!=='function'||typeof scope.applyCookies!=='function')throw refused();
 const context=privateContext(scope),id=randomUUID(),controller=new AbortController();
 let applied=false;
 const transfer=(async()=>{
  const deadline=Date.now()+timeoutMs;
  while(!controller.signal.aborted&&Date.now()<deadline){
   const outcome=await new Promise(resolve=>{
    const socket=connect('\\\\.\\pipe\\SSAM-O11-CookieExchange-'+id);
    let connected=false,settled=false,buffer=Buffer.alloc(0),expected=null,processing=false;
    const finish=result=>{if(settled)return;settled=true;controller.signal.removeEventListener('abort',abort);socket.destroy();buffer.fill(0);resolve(result);};
    const abort=()=>finish('failed');controller.signal.addEventListener('abort',abort,{once:true});
    socket.setTimeout(Math.max(1,deadline-Date.now()),()=>finish('failed'));
    socket.once('connect',()=>{connected=true;const prefix=Buffer.alloc(4);prefix.writeInt32LE(context.length);socket.write(prefix);socket.write(context);});
    socket.on('data',async chunk=>{
     if(processing||settled)return;
     if(buffer.length+chunk.length>65540)return finish('failed');
     const previous=buffer;buffer=Buffer.concat([buffer,chunk]);previous.fill(0);
     if(expected===null&&buffer.length>=4){expected=buffer.readInt32LE();if(expected<1||expected>65536)return finish('failed');}
     if(expected===null||buffer.length<expected+4)return;
     if(buffer.length!==expected+4)return finish('failed');
     processing=true;
     try{const cookies=cookieUpdate(buffer.subarray(4),scope);await scope.applyCookies(scope.url,cookies);
      socket.end(Buffer.from([1]),()=>{applied=true;finish('applied');});
     }catch{finish('failed');}
    });
    socket.once('error',error=>finish(!connected&&['ENOENT','ECONNREFUSED'].includes(error.code)?'not-ready':'failed'));
    socket.once('close',()=>finish('failed'));
   });
   if(outcome==='applied')return;
   if(outcome!=='not-ready')throw refused();
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw refused();
 })().catch(()=>{});
 try{
  const result=await invoke(id);
  // Native success requires our ACK, therefore a completed update precedes
  // its authoritative response. Never invoke HTTP again after a lost ACK.
  if(result?.ok===true){await transfer;if(!applied)throw Object.assign(refused(),{code:'PRIVATE_CONTEXT_OUTCOME_UNCERTAIN',sent:true});}
  return result;
 }finally{controller.abort();await transfer;context.fill(0);}
}
