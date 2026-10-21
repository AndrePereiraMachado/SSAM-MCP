// One Studio pair per backend. Authentication maps both credentials to the same license id.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
import {threePart} from '../studio-identity.mjs';
import {readStudioVersions} from '../studio-version-state.mjs';
export const TIMEOUT_MS = 65 * 60 * 1000;
export function validateBackends(value, window = 3) {
  if (!Number.isInteger(window) || window < 1 || !Array.isArray(value) || !value.length || value.length > window) throw new Error('Invalid version window');
  const names = new Set();
  for (const backend of value) {
    const url = new URL(backend.url);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(backend.name) || names.has(backend.name) || !['http:','https:'].includes(url.protocol)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !threePart(backend.odc) || !threePart(backend.o11)) throw new Error('Invalid backend');
    names.add(backend.name);
  }
  if (value.filter(b=>b.default===true).length!==1) throw new Error('Exactly one default backend is required');
  return value;
}
export function selectBackend(backends, hello) {
  const studios=hello?.studios;
  const lane=studios?.odc?.installed?'odc':studios?.o11?.installed?'o11':null;
  const version=lane?threePart(studios[lane].installed.version):null;
  const installed=['odc','o11'].filter(l=>studios?.[l]?.installed);
  return backends.find(b=>installed.length && installed.every(l=>threePart(b[l])===threePart(studios[l].installed.version)))
    ?? backends.find(b=>lane&&threePart(b[lane])===version) ?? backends.find(b=>b.default);
}
const hop=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
function headersOf(headers) {
  const excluded=new Set([...hop,...String(headers.connection??'').toLowerCase().split(',').map(v=>v.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name])=>!excluded.has(name.toLowerCase())));
}
function reply(res,status,code,message) {
  if(res.destroyed||res.writableEnded)return;
  const body=JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32000,message,data:{code}}});
  if(res.headersSent) {if(String(res.getHeader('content-type')).includes('text/event-stream'))res.write('event: message\ndata: '+body+'\n\n');res.end();return;}
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(body);
}
function atomic(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(value)+'\n',{mode:0o600});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
}
async function helloBody(req) {
  const chunks=[];let bytes=0;
  for await(const chunk of req){bytes+=chunk.length;if(bytes>1024*1024)throw new Error('Hello too large');chunks.push(chunk);}
  const body=Buffer.concat(chunks);const value=JSON.parse(body.toString('utf8'));
  if(value?.t!=='hello'||value.protocol!=='ssam-agent/1')throw new Error('Invalid hello');
  return {body,value};
}
export async function createRouter({backends,store,dir,port=7300,host='127.0.0.1',window=3,publicHosts=[],consoleHost=null,consoleUrl=null}={}) {
  validateBackends(backends,window);
  if(!store?.verify||!store?.verifyAgent||!dir)throw new Error('Router authentication and state are required');
  const fallback=backends.find(b=>b.default), byName=new Map(backends.map(b=>[b.name,b]));
  const file=path.join(dir,'state','routing.json');let routes={};
  try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));if(saved.schema!==1||!saved.routes)throw new Error('Invalid routing state');routes=saved.routes;}catch(e){if(e.code!=='ENOENT')throw e;}
  atomic(path.join(dir,'state','backend-versions.json'),{window,backends:backends.map(({name,odc,o11,default:isDefault})=>({name,odc,o11,default:!!isDefault}))});
  const sessions=new Map(), active=new Set(), queues=new Map();let closed=false;
  const routeOf=id=>byName.get(routes[id]?.backend)??fallback;
  function reroute(id,backend){
    if(routeOf(id).name===backend.name&&routes[id])return;
    const before=routeOf(id).name;
    const next={...routes,[id]:{backend:backend.name,revision:(routes[id]?.revision??0)+1}};
    atomic(file,{schema:1,routes:next});routes=next;
    if(before===backend.name)return;
    for(const session of sessions.values())if(session.token===id)session.stale=true;
    for(const request of active)if(request.token===id&&request.backend!==backend.name){
      if(request.sid){const session=sessions.get(request.sid);if(session?.notified)request.res.destroy();else{if(session)session.notified=true;reply(request.res,409,'SESSION_REROUTED','Your Studio version changed. Open a new MCP session.');}}
      else request.res.destroy();
      request.upstream.destroy();
    }
  }
  async function health(res){
    const versions=await Promise.all(backends.map(async b=>{let ok=false;try{const r=await fetch(b.url+'/health',{signal:AbortSignal.timeout(4000)});ok=r.ok;await r.body?.cancel();}catch{}return {name:b.name,odc:b.odc,o11:b.o11,default:!!b.default,ok};}));
    const ok=versions.find(b=>b.default).ok;res.writeHead(ok?200:503,{'content-type':'application/json'});res.end(JSON.stringify({ok,versions}));
  }
  function proxy(req,res,backend,{token=null,sid=null,body=null,onAccepted=null,mcp=false}={}){
    return new Promise(resolve=>{
      const target=new URL(req.url,backend.url);const transport=target.protocol==='https:'?https:http;
      const headers=headersOf(req.headers);if(backend.preserveHost===false)headers.host=target.host;if(body){headers['content-length']=body.length;delete headers['transfer-encoding'];}
      let finished=false;const finish=()=>{if(finished)return;finished=true;active.delete(record);resolve();};
      const upstream=transport.request(target,{method:req.method,headers,timeout:TIMEOUT_MS},response=>{
        try{
          if(onAccepted&&response.statusCode>=200&&response.statusCode<300)onAccepted();
          if(mcp&&routeOf(token).name!==backend.name){response.destroy();reply(res,409,'SESSION_REROUTED','Your Studio version changed. Open a new MCP session.');finish();return;}
          const newSid=response.headers['mcp-session-id'];
          if(mcp&&typeof newSid==='string'&&response.statusCode>=200&&response.statusCode<300){
            const previous=sessions.get(newSid);
            if(previous&&previous.token!==token)throw new Error('Conflicting session');
            sessions.set(newSid,{token,backend:backend.name,stale:false,notified:false,seen:Date.now()});
          }
          if(res.destroyed||res.writableEnded){response.destroy();finish();return;}
          for(const [name,value]of Object.entries(headersOf(response.headers)))if(value!==undefined)res.setHeader(name,value);
          res.writeHead(response.statusCode);res.flushHeaders();
          response.pipe(res);response.on('end',finish);response.on('error',()=>{res.destroy();finish();});
        }catch{response.destroy();reply(res,503,'ROUTING_UNAVAILABLE','The connection could not be prepared. Reconnect and try again.');finish();}
      });
      const record={token,sid,backend:backend.name,res,upstream};active.add(record);
      upstream.on('timeout',()=>upstream.destroy(new Error('Timed out')));
      upstream.on('error',()=>{reply(res,502,'BACKEND_UNAVAILABLE','The connection is temporarily unavailable. Try again.');finish();});
      req.on('aborted',()=>upstream.destroy());res.on('close',()=>{upstream.destroy();finish();});
      if(body)upstream.end(body);else req.pipe(upstream);
    });
  }
  const server=http.createServer(async(req,res)=>{
    try{
      if(!req.url.startsWith('/')||req.url.startsWith('//')||req.url.includes(String.fromCharCode(92)))return reply(res,400,'MESSAGE_INVALID','Invalid request target.');
      const hostName=String(req.headers.host??'').split(':')[0].toLowerCase();
      if(consoleHost&&hostName===consoleHost.toLowerCase())return await proxy(req,res,{name:'console',url:consoleUrl});
      const localHealth=req.url==='/health'&&hostName==='127.0.0.1'&&['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress);
      if(!localHealth&&publicHosts.length&&!publicHosts.map(h=>h.toLowerCase()).includes(hostName))return reply(res,400,'HOST_NOT_ALLOWED','Host not allowed.');
      const url=new URL(req.url,'http://router.local');
      if(url.pathname==='/health'&&req.method==='GET')return await health(res);
      const agent=url.pathname==='/agent'||url.pathname.startsWith('/agent/');const mcp=url.pathname==='/mcp';
      if(!agent&&!mcp)return reply(res,404,'NOT_FOUND','Not found.');
      const credential=/^Bearer ([^\s]+)$/i.exec(req.headers.authorization??'')?.[1];
      const auth=await (agent?store.verifyAgent(credential):store.verify(credential));
      if(auth?.status!=='ok')return reply(res,auth?.status==='unknown'?401:403,'UNAUTHORIZED','A valid credential is required.');
      const token=auth.id;
      if(agent&&url.pathname==='/agent/v1/hello'&&req.method==='POST'){
        let parsed;try{parsed=await helloBody(req);}catch{return reply(res,400,'MESSAGE_INVALID','Invalid agent hello.');}
        const previous=queues.get(token)??Promise.resolve();
        const work=previous.catch(()=>{}).then(()=>proxy(req,res,selectBackend(backends,parsed.value),{token,body:parsed.body,onAccepted:()=>reroute(token,selectBackend(backends,parsed.value))}));
        queues.set(token,work);try{await work;}finally{if(queues.get(token)===work)queues.delete(token);}return;
      }
      const sid=mcp?req.headers['mcp-session-id']:null;
      if(sid){
        const session=sessions.get(sid);
        if(session&&session.token!==token)return reply(res,404,'SESSION_NOT_FOUND','Session not found.');
        if(!session||session.stale||session.backend!==routeOf(token).name){
          if(session?.notified)return reply(res,404,'SESSION_NOT_FOUND','Session not found.');
          sessions.set(sid,{token,backend:routeOf(token).name,stale:true,notified:true,seen:Date.now()});
          return reply(res,409,'SESSION_REROUTED','Your Studio version changed. Open a new MCP session.');
        }
        session.seen=Date.now();
      }
      await proxy(req,res,routeOf(token),{token,sid,mcp});
      if(mcp&&sid&&req.method==='DELETE')sessions.delete(sid);
    }catch{reply(res,503,'ROUTING_UNAVAILABLE','The connection is temporarily unavailable. Try again.');}
  });
  server.requestTimeout=TIMEOUT_MS;server.headersTimeout=TIMEOUT_MS;server.setTimeout(TIMEOUT_MS);server.keepAliveTimeout=4000;
  const sweep=setInterval(()=>{for(const [id,s]of sessions)if(Date.now()-s.seen>TIMEOUT_MS)sessions.delete(id);try{const data=readStudioVersions(dir);atomic(path.join(dir,'state','studio-versions.json'),data);}catch{}},30000);sweep.unref();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  return {server,url:`http://${host}:${server.address().port}`,async close(){if(closed)return;closed=true;clearInterval(sweep);for(const r of active){r.upstream.destroy();r.res.destroy();}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
