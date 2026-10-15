// Only SC cookies produced by this tool, in this process. Never identity tokens,
// Studio cookies, disk persistence, or a fallback between users/environments.
import {CookieJar} from 'tough-cookie';
const keyOf=auth=>{
 const {host,user,credentialTarget,bridge,credentialSelection}=auth??{};
 if(typeof host!=='string'||!/^[a-z0-9.-]+$/.test(host)||typeof user!=='string'||!user.trim()
  ||typeof credentialTarget!=='string'||!(credentialTarget===`SSAM/O11/${host}/ServiceCenter`||credentialTarget.startsWith(`SSAM/O11/${host}/ServiceCenter/Profiles/`)))return null;
 // Explicit profile selection is revalidated by the broker on every call. It
 // can bind the tool's own cookies without a Studio authenticated on this host.
 // Keep that scope separate from a Studio-bound session, including after attach.
 const binding = bridge == null && credentialSelection==='explicit-target' ? ['vault-profile']
  : Number.isSafeInteger(bridge?.pid)&&bridge.pid>0&&Number.isSafeInteger(bridge.port)&&bridge.port>0 ? ['studio',bridge.pid,bridge.port] : null;
 return binding ? JSON.stringify([host,user.trim().toLowerCase(),credentialTarget,...binding]) : null;
};
export class SsoSessionCache{
 constructor({now=Date.now,ttlMs=300000,maxEntries=16,schedule=(fn,ms)=>{const t=setTimeout(fn,ms);t.unref();return t;},cancel=clearTimeout}={}){
  Object.assign(this,{now,ttlMs,maxEntries,schedule,cancel});this.entries=new Map();this.authenticating=new Map();
 }
 key(auth){return keyOf(auth);}
 async authenticate(auth,create){
  const key=keyOf(auth);
  // Concurrent reads of different pages share one credential exchange. Each
  // caller receives its own cookie jar, and closing one cannot break another.
  let pending=key&&this.authenticating.get(key);
  if(!pending){
   pending=(async()=>{const identity=create();try{
    await identity.authenticateSc();
    this.put(auth,identity.jar);
    const jar=this.scopedJar(auth,identity.jar);
    if(!jar)throw new Error('Authenticated session has no Service Center cookie');
    return jar;
   }finally{await identity.close();}})();
   if(key)this.authenticating.set(key,pending);
  }
  try{return{key,jar:(await pending).cloneSync()};}
  finally{if(key&&this.authenticating.get(key)===pending)this.authenticating.delete(key);}
 }
 drop(key){const entry=this.entries.get(key);if(!entry)return;this.entries.delete(key);this.cancel(entry.timer);entry.jar.removeAllCookiesSync();}
 clear(){for(const key of this.entries.keys())this.drop(key);}
 get(auth){const key=keyOf(auth),entry=this.entries.get(key);if(!entry)return null;
  if(entry.expiresAt<=this.now()){this.drop(key);return null;}
  const jar=entry.jar.cloneSync();
  if(!jar.getCookieStringSync(`https://${auth.host}/ServiceCenter/`)){jar.removeAllCookiesSync();this.drop(key);return null;}
  return{key,jar};
 }
 update(auth,source){
  const key=keyOf(auth),entry=this.entries.get(key);if(!entry)return false;
  if(entry.expiresAt<=this.now()){this.drop(key);return false;}
  const jar=this.scopedJar(auth,source);
  if(!jar){this.drop(key);return false;}
  entry.jar.removeAllCookiesSync();entry.jar=jar;return true;
 }
 scopedJar(auth,source){
  const state=source.serializeSync();
  state.cookies=state.cookies.filter(c=>typeof c.domain==='string'&&c.domain.includes('.')&&(c.domain===auth.host||auth.host.endsWith('.'+c.domain))
   &&typeof c.path==='string'&&(c.path==='/'||c.path.toLowerCase().startsWith('/servicecenter')));
  const jar=CookieJar.deserializeSync(state);
  if(!jar.getCookieStringSync(`https://${auth.host}/ServiceCenter/`)){jar.removeAllCookiesSync();return null;}
  return jar;
 }
 put(auth,source){const key=keyOf(auth);if(!key)return null;
  // A server cookie without Secure is still sent only to HTTPS by Transport.
  // Parent-domain cookies stay bound to this exact host in the cache key.
  const jar=this.scopedJar(auth,source);if(!jar)return null;
  this.drop(key);for(const [k,e]of this.entries)if(e.expiresAt<=this.now())this.drop(k);
  while(this.entries.size>=this.maxEntries)this.drop(this.entries.keys().next().value);
  const entry={jar,expiresAt:this.now()+this.ttlMs,timer:null};this.entries.set(key,entry);
  entry.timer=this.schedule(()=>this.drop(key),this.ttlMs);return key;
 }
}
export const ownSsoSessions=new SsoSessionCache();
