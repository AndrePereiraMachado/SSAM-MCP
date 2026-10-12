// Original, pinned stylesheets declared by the published document or manifest.
// Views load additional styles lazily; document links alone are insufficient.
// Nested CSS
// resources remain subject to the browser's default-deny asset boundary.
import fs from 'node:fs';
import path from 'node:path';
import {JSDOM} from 'jsdom';
import {assetHash,readOdcRuntimeSources} from './debug-odc-native-assets.mjs';
const fail=code=>{throw new Error('debug_odc_browser_styles_'+code);};
export function odcDocumentStyles(runtime){
 const sources=readOdcRuntimeSources(runtime),html=sources['index.html'],base=new URL(runtime.runtimeUrl);
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||!base.pathname.endsWith('/'))fail('origin');
 const dom=new JSDOM(html),urls=[];
 try{for(const link of dom.window.document.querySelectorAll('link[rel~="stylesheet"]')){
  const href=link.getAttribute('href');if(!href)fail('link');
  const url=new URL(href,base);
  if(url.origin!==base.origin||url.username||url.password||url.hash||!url.pathname.startsWith(base.pathname+'css/')||
   !/^[A-Za-z0-9_+.-]+\.css$/.test(path.posix.basename(url.pathname)))fail('scope');
  if(!urls.includes(url.href))urls.push(url.href);
 }}finally{dom.window.close();}
 if(sources['moduleinfo.json']!==undefined){
  let manifest;try{manifest=JSON.parse(sources['moduleinfo.json']).manifest;}catch{fail('manifest');}
  if(!runtime.moduleVersion||manifest?.versionToken!==runtime.moduleVersion||
   !manifest.urlVersions||typeof manifest.urlVersions!=='object'||Array.isArray(manifest.urlVersions))fail('manifest');
  for(const [resource,version] of Object.entries(manifest.urlVersions)){
   if(!resource.split('?')[0].endsWith('.css'))continue;
   const url=new URL(resource,base);
   if(url.origin!==base.origin||url.username||url.password||url.hash||url.search||
    !url.pathname.startsWith(base.pathname+'css/')||!/^\/[A-Za-z0-9_+./-]+\.css$/.test(resource)||
    !/^[A-Za-z0-9_+.-]+\.css$/.test(path.posix.basename(url.pathname))||
    typeof version!=='string'||!/^\?[A-Za-z0-9_+-]+$/.test(version))fail('scope');
   url.search=version;
   const existing=urls.findIndex(item=>new URL(item).pathname===url.pathname);
   if(existing>=0){
    const previous=new URL(urls[existing]);
    if(previous.search&&previous.search!==url.search)fail('version_conflict');
    urls[existing]=url.href;
   }else urls.push(url.href);
  }
 }
 if(urls.length>64)fail('limit');return urls;
}
export async function acquireOdcDocumentStyles(runtime,directory,{fetchImpl=fetch}={}){
 const urls=odcDocumentStyles(runtime),pins={};let total=0;
 fs.mkdirSync(directory,{recursive:false});
 for(const url of urls){
  let response;try{response=await fetchImpl(url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});}catch{fail('unavailable');}
  if(response.status!==200||response.redirected||response.url&&response.url!==url)fail('response');
  const bytes=Buffer.from(await response.arrayBuffer());total+=bytes.length;
  if(bytes.length>8*1024*1024||total>16*1024*1024)fail('size');
  const name='style-'+assetHash(Buffer.from(url))+'.css',file=path.join(directory,name);
  fs.writeFileSync(file,bytes,{flag:'wx'});pins[name]={path:file,sha256:assetHash(bytes),url,contentType:'text/css'};
 }
 return {pins,sourceDocumentSha256:runtime.pins['index.html'].sha256,urls};
}
export function pinnedOdcDocumentStyles(runtime){
 const expected=odcDocumentStyles(runtime),assets=[];
 for(const url of expected){
  const matches=Object.values(runtime.pins).filter(p=>p.url===url&&p.contentType==='text/css');
  if(matches.length!==1)fail('pin_missing');
  const pin=matches[0],bytes=fs.readFileSync(pin.path);if(assetHash(bytes)!==pin.sha256)fail('changed');
  assets.push({url,body:bytes.toString('utf8'),contentType:'text/css',originalSha256:pin.sha256,servedSha256:pin.sha256});
 }
 return assets;
}
