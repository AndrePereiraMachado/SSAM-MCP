// The updater's public release feed; installers are downloaded, hashed and
// extracted as data only. No installer is ever executed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const RELEASE_ENDPOINT='https://api.outsystems.com/releaseshub/v1/latest';
export function officialUrl(value) {
 const u=new URL(value);
 if(u.protocol!=='https:' || u.username || u.password || !['api.outsystems.com','dxejw4oyledi.cloudfront.net'].includes(u.hostname))throw Error('Untrusted Studio release URL.');
 return u.href;
}
export async function releaseFor(lane,installed,{fetcher=fetch,endpoint=RELEASE_ENDPOINT,allowTestHttp=false}={}) {
 if(!allowTestHttp)officialUrl(endpoint);
 const u=new URL(endpoint);u.search=new URLSearchParams({component:lane==='odc'?'ODCStudio':'ServiceStudio',version:installed||'0.0.0.0',luv:installed||'0.0.0.0',releaseline:'stable',platform:'Windows'}).toString();
 const r=await fetcher(u,{signal:AbortSignal.timeout(30000),redirect:'error'});
 if(!r.ok)throw Error(`Studio release source returned HTTP ${r.status}.`);
 const data=await r.json();
 if(!/^\d+\.\d+\.\d+\.\d+$/.test(data.version))throw Error('Studio release source returned an invalid version.');
 const link=allowTestHttp?data.link:officialUrl(data.link);
 return {lane,version:data.version.split('.').slice(0,3).join('.'),fullVersion:data.version,url:link,source:u.href,requiresInstallation:true,tfm:null};
}
export async function detectSources(installed,{fetcher=fetch,endpoint,allowTestHttp=false}={}) {
 const releases=[],sources=[],local=installed.map(x=>({...x}));
 for(const lane of ['odc','o11'])try {
  const r=await releaseFor(lane,installed.find(x=>x.lane===lane)?.fullVersion,{fetcher,endpoint,allowTestHttp});
  sources.push({lane,status:'public',version:r.fullVersion,source:r.source});
  const same=local.find(x=>x.lane===lane&&x.fullVersion===r.fullVersion);
  if(same)Object.assign(same,{url:r.url,source:r.source});else releases.push(r);
 } catch {sources.push({lane,status:'unavailable',fallback:'installed Studio'});}
 return {observed:[...local,...releases],sources};
}
export async function downloadInstaller(release,directory,{fetcher=fetch,allowTestHttp=false}={}) {
 const name=`${release.lane}-${release.fullVersion}.exe`,target=path.join(directory,name);
 if(!/^\d+\.\d+\.\d+\.\d+$/.test(release.fullVersion))throw Error('Invalid installer version.');
 const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 if(fs.existsSync(target)){
  if(fs.readFileSync(target+'.sha256','utf8').trim()!==digest(target))throw Error('Stored installer checksum mismatch.');
  return {file:target,sha256:digest(target)};
 }
 let url=allowTestHttp?release.url:officialUrl(release.url),response;
 for(let n=0;n<6;n++){
  response=await fetcher(url,{redirect:'manual',signal:AbortSignal.timeout(120000)});
  if([301,302,303,307,308].includes(response.status)){url=new URL(response.headers.get('location'),url).href;if(!allowTestHttp)officialUrl(url);continue;}
  break;
 }
 if(!response?.ok)throw Error('Studio installer download failed.');
 fs.mkdirSync(directory,{recursive:true});
 const partial=target+`.partial-${process.pid}`;const fd=fs.openSync(partial,'wx',0o600);let total=0;
 try{
  for await(const chunk of response.body){total+=chunk.length;if(total>2*1024**3)throw Error('Studio installer is too large.');fs.writeSync(fd,chunk);}
  fs.closeSync(fd);
  const header=fs.readFileSync(partial).subarray(0,2);if(header.toString()!=='MZ')throw Error('Studio source did not return a Windows installer.');
  const hash=digest(partial);fs.writeFileSync(partial+'.sha256',hash+'\n');fs.renameSync(partial,target);fs.renameSync(partial+'.sha256',target+'.sha256');
  return {file:target,sha256:hash};
 }catch(e){try{fs.closeSync(fd);}catch{}fs.rmSync(partial,{force:true});fs.rmSync(partial+'.sha256',{force:true});throw e;}
}
