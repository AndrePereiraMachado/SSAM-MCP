// A fake of the public OutSystems pages the vigia reads, answering from responses recorded on 2026-11-09 (trimmed; no
// cookie or session value: only the tokens every visitor's browser gets from the published scripts).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const read=name=>fs.readFileSync(path.join(here,name),'utf8');
const json=name=>JSON.parse(read(name));
export const TOKENS={releases:'yMPHeXJXGMwBq7b7DRdbnQ',guid:'EMLGKMEia6zRUe0vuZPj3A',content:'gIYQgfRTlpqS0CH3hFU+KQ'};
export function fakeSites(){
 const state={
  tokens:{...TOKENS},accepted:null,            // accepted: the tokens the server takes (default: the published ones)
  scripts:{home:read('dl-homescreen.js'),support:read('docs-support.js'),content:read('docs-contentdoc.js'),runtime:read('runtime.js')},
  moduleinfo:{dl:json('dl-moduleinfo.json'),docs:json('docs-moduleinfo.json')},
  releases:{win:json('dl-releases-win.json'),mac:json('dl-releases-mac.json')},
  guid:json('docs-guid.json'),content:json('docs-content.json'),
  hub:json('releaseshub.json'),installer:Buffer.from('MZ-synthetic-installer'),
  calls:[],fail:null                           // fail(url,init) may return a Response or throw, before the routes
 };
 const res=(body,init={})=>new Response(body,init);
 const ok=body=>res(typeof body==='string'?body:JSON.stringify(body),{status:200});
 const badApi=()=>ok(json('dl-releases-badapi.json'));
 const fetcher=async(url,init={})=>{
  const u=new URL(url),method=init.method??'GET';state.calls.push(`${method} ${u.href}`);
  if(state.fail){const r=await state.fail(u,init);if(r)return r;}
  if(init.redirect!=='manual')throw Error('the fake expects redirect:manual');
  const accepted=state.accepted??state.tokens;
  if(u.hostname==='www.outsystems.com'){
   if(u.pathname==='/downloads/moduleservices/moduleinfo')return ok(state.moduleinfo.dl);
   if(u.pathname.includes('/scripts/OutSystems__'))return ok(state.scripts.runtime);
   if(u.pathname.includes('HomeScreen.mvc__'))return ok(state.scripts.home.replace(TOKENS.releases,state.tokens.releases));
   if(method==='POST'&&u.pathname==='/downloads/screenservices/Downloads/MainFlow/HomeScreen/DataActionGetReleases'){
    const b=JSON.parse(init.body);if(init.headers['X-CSRFToken']!=='T6C+9iB49TLra4jEsMeSckDMNhQ=')return res('',{status:403});
    if(b.versionInfo.apiVersion!==accepted.releases)return badApi();
    return ok(b.clientVariables.IsMacUser?state.releases.mac:state.releases.win);
   }
  }
  if(u.hostname==='success.outsystems.com'){
   if(u.pathname==='/moduleservices/moduleinfo')return ok(state.moduleinfo.docs);
   if(u.pathname.includes('/scripts/OutSystems__'))return ok(state.scripts.runtime);
   if(u.pathname.includes('Documentation.Support.mvc__'))return ok(state.scripts.support.replace(TOKENS.guid,state.tokens.guid));
   if(u.pathname.includes('Documentation.ContentDoc.mvc__'))return ok(state.scripts.content.replace(TOKENS.content,state.tokens.content));
   if(method==='POST'&&u.pathname.endsWith('/DataActionGetContentGUID'))return JSON.parse(init.body).versionInfo.apiVersion===accepted.guid?ok(state.guid):badApi();
   if(method==='POST'&&u.pathname.endsWith('/DataActionGetDocContent'))return JSON.parse(init.body).versionInfo.apiVersion===accepted.content?ok(state.content):badApi();
  }
  if(u.hostname==='api.outsystems.com'){
   const m=u.pathname.match(/^\/releaseshub\/v1\/component\/(\w+)\/version\/([\d.]+)\/platform\/(\w+)\/content$/);
   const hit=m&&state.hub[`${m[1]}/${m[2]}/${m[3]}`];
   if(hit)return res(null,{status:301,headers:{location:hit.location}});
   return res('{"Error": "No version found"}',{status:404});
  }
  if(u.hostname==='dxejw4oyledi.cloudfront.net'){
   const hit=Object.values(state.hub).find(h=>h.location===u.href);if(!hit)return res('',{status:403});
   if(method==='HEAD')return res(null,{status:200,headers:{'last-modified':hit.lastModified,'content-length':String(hit.size)}});
   return res(state.installer,{status:200});
  }
  return res('',{status:404});
 };
 return {state,fetcher};
}
