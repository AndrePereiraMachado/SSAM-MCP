// Private Chromium asset boundary. Generated function bodies remain unchanged;
// only native export aliases and the deferred bootstrap are exposed to the host.
import {JSDOM} from 'jsdom';
import {readOdcRuntimeSources,assetHash} from './debug-odc-native-assets.mjs';
import {indexRuntime} from './debug-odc-native-runtime.mjs';
import {pinnedOdcDocumentStyles} from './debug-odc-browser-styles.mjs';
import {createHash} from 'node:crypto';

const fail=code=>{throw new Error('debug_odc_browser_'+code);};
// Deep link: the pinned document is also served at runtimeUrl+segment, for a
// route qualified by qualifyOdcBootstrapRoutes and only with the authorized query.
export function odcDocumentRoute(runtimeUrl,route,qualification){
  const segment=route?.segment,query=route?.query;
  if(typeof segment!=='string'||!/^[A-Za-z0-9_-]+$/.test(segment))fail('route_segment_invalid');
  if(typeof query!=='string'||/[?#]/.test(query))fail('route_query_invalid');
  const matches=qualification?.routeExpressionsQualified===true&&Array.isArray(qualification.routes)?qualification.routes.filter(r=>r.defaultPath===false&&r.segment===segment):[];
  if(matches.length!==1)fail('route_unqualified');
  const key=new URL(segment,runtimeUrl).href;
  return {key,documentUrl:key+(query?'?'+query:''),route:{segment,querySha256:createHash('sha256').update(query).digest('hex'),screenName:matches[0].screenName}};
}
export function planOdcBrowserAssets(runtime,{includeDocumentStyles=false,route}={}){
  const sources=readOdcRuntimeSources(runtime),url=new URL(runtime.runtimeUrl);
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/'))fail('origin_invalid');
  const index=indexRuntime(Object.fromEntries(Object.entries(sources).filter(([name])=>name.endsWith('.js'))));
  const assets=new Map(),exports={};
  if(includeDocumentStyles)for(const asset of pinnedOdcDocumentStyles(runtime)){
    const key=new URL(asset.url);key.search='';
    if(assets.has(key.href))fail('style_ambiguous');
    assets.set(key.href,asset);
  }
  for(const [name,source] of Object.entries(sources)){
    if(!name.endsWith('.js'))continue;
    if(!/^_os(?:chunk-[A-Za-z0-9]+|bundle-[A-Za-z0-9_.]+__[A-Za-z0-9_+]+)\.js$/.test(name))fail('asset_invalid');
    const metadata=index.chunks[name];
    const names=[...new Set([...(metadata?.topLevel??[]),...(metadata?.imports??[]).flatMap(i=>i.names.map(n=>n.local))])];
    if(names.some(n=>!/^[A-Za-z_$][\w$]*$/.test(n)))fail('export_invalid');
    exports[name]=names;
    const body=name===index.bootstrap.file ? index.mountModule : source+(names.length?'\nexport {'+names.map((n,i)=>`${n} as __ssam_${i}`).join(',')+'};\n':'');
    assets.set(new URL('scripts/'+name,url).href,{body,contentType:'text/javascript',originalSha256:runtime.pins[name].sha256,servedSha256:assetHash(body)});
  }
  const dom=new JSDOM(sources['index.html']);
  // Importing the deferred bootstrap is explicit. Classic/plugin/SW scripts
  // must not execute as an unqualified side effect of opening the document.
  const removedScripts=[...dom.window.document.querySelectorAll('script')].map(s=>({src:s.getAttribute('src'),type:s.getAttribute('type')}));
  dom.window.document.querySelectorAll('script').forEach(s=>s.remove());
  const html=dom.serialize();dom.window.close();
  const documentAsset={body:html,contentType:'text/html',originalSha256:runtime.pins['index.html'].sha256,servedSha256:assetHash(html)};
  assets.set(url.href,{...documentAsset,documentUrl:url.href});
  if(route!==undefined){
    const d=odcDocumentRoute(url.href,route,index.bootstrap?.viewLoader?.routeQualification);
    if(assets.has(d.key))fail('route_ambiguous');
    assets.set(d.key,{...documentAsset,documentUrl:d.documentUrl,route:d.route});
  }
  return {url:url.href,index,exports,assets,removedScripts};
}

export async function installOdcBrowserAssets(page,plan,{request,abort=()=>{}}={}){
  const pending=new Set(),served=[],refused=[];let disposed=false,failed=false;
  const report=()=>({served:served.slice(),refused:refused.slice(),pending:pending.size,failed,disposed});
  const csp="default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src "+new URL(plan.url).origin+"; worker-src 'none'; frame-src 'none'; base-uri 'self'";
  await page.send('Network.enable');
  await page.send('Network.setBypassServiceWorker',{bypass:true});
  await page.send('Network.setBlockedURLs',{urls:['ws://*','wss://*']});
  page.on('Fetch.requestPaused',event=>{
    const work=(async()=>{
      try{
        if(disposed)throw new Error();
        const original=event.request.url,url=new URL(original);url.search='';
        const asset=event.request.method==='GET' && plan.assets.get(url.href);
        let response;
        if(asset){
          // A document is served only at its exact URL: the app root, or the authorized route with its query.
          if(asset.contentType==='text/html' && original!==(asset.documentUrl??plan.url))fail('document_scope_invalid');
          response={status:200,body:asset.body,headers:[{name:'Content-Type',value:asset.contentType},{name:'Cache-Control',value:'no-store'},
            ...(asset.contentType==='text/html'?[{name:'Content-Security-Policy',value:csp}]:[])]};
          served.push({path:url.pathname,originalSha256:asset.originalSha256,servedSha256:asset.servedSha256});
        }else if(request)response=await request(event.request,event.resourceType);
        if(!response || !Number.isInteger(response.status) || response.status<100 || response.status>599 || typeof response.body!=='string'){
          refused.push({method:event.request.method,resourceType:event.resourceType});
          await page.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});return;
        }
        await page.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:response.status,responseHeaders:response.headers??[],body:Buffer.from(response.body).toString('base64')});
      }catch{
        failed=true;try{await page.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});}catch{}
        try{abort();}catch{}
      }
    })();pending.add(work);void work.finally(()=>pending.delete(work));
  });
  // Every HTTP request is fulfilled or refused here. Nothing uses continueRequest.
  await page.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  return {receipt:report,async dispose(){disposed=true;await Promise.all([...pending]);return{completed:true,pending:pending.size};}};
}
