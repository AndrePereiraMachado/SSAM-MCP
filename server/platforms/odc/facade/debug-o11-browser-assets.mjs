// O11 Reactive asset boundary for the owned headless Chrome (option B, O11).
// Served only from the published, hash-pinned version: index.html with every
// script removed, AMD scripts/*.js at their exact manifest query, moduleinfo
// and CSS. Every other request is refused or handed to the guarded transport.
// The original bootstrap (<Module>.index.js) is planned, never executed here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {JSDOM} from 'jsdom';

const fail=code=>{throw new Error('debug_o11_browser_'+code);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const NAME=/^[A-Za-z_][A-Za-z0-9_]{0,198}$/,FILE=/^[A-Za-z_][A-Za-z0-9_.-]{0,240}\.(js|css)$/;
const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// Whitespace runs collapse to one space; spaces next to punctuation disappear.
const normalize=text=>text.replace(/\s+/g,' ').replace(/ ?([^\w$ ]) ?/g,'$1').trim();

// The reviewed bootstrap shape of an O11 Reactive web app: platform settings,
// request security, OutSystemsDebugger.initialize, the Full application
// initialization and the router load. Anything else is unqualified.
export function qualifyO11Bootstrap(source,module){
  if(typeof source!=='string'||!NAME.test(module??''))return {bootstrapQualified:false};
  const m=escape(module),str='"[^"\\\\]{0,40}"',settings='(?:[A-Za-z]{1,60}:(?:true|false),){0,20}[A-Za-z]{1,60}:(?:true|false)';
  const template=new RegExp('^'+escape(normalize(`require(["es6-promise","tslib"],function(es6promise,tslib){
require(["OutSystems/ClientRuntime/Main","@M.appDefinition","OutSystems/ClientRuntime/Debugger"],function(OutSystems,@MAppDefinition,Debugger){
var OS=OutSystems.Internal;OS.Settings.setPlatformSettings({@SETTINGS});
if(OS.Navigation.ensureRequestSecurity()){return;}
OutSystemsDebugger.initialize().then(function(){
return OS.Application.default.initialize(@MAppDefinition,OS.Interfaces.Application.InitializationType.Full,new OS.Format.DateTimeFormatInfo(@S,@S),new OS.Format.NumberFormatInfo(@S,@S)).then(function(success){
function initViewPromise(){return OS.Flow.promise(function(resolve,reject){require(["OutSystems/ReactView/Main"],function(OSView){
try{OSView.Router.load(OS.Application.default);resolve();}catch(error){reject(error);}});});};
if(success){return initViewPromise();}});
}).catch(function(error){OS.ErrorHandling.handleError(error);});});});`)).replaceAll('@SETTINGS',settings).replaceAll('@S',str).replaceAll('@M',m)+'$');
  return {bootstrapQualified:template.test(normalize(source)),sha256:sha(source)};
}

// Development evidence comes from the published appDefinition itself.
export function qualifyO11AppDefinition(source,module){
  const text=typeof source==='string'?source.replace(/^\uFEFF/,''):'';
  if(!text.startsWith('define("'+module+'.appDefinition", ["OutSystems/ClientRuntime/Main"], function (OutSystems) {'))fail('app_definition_unresolved');
  const field=(name,pattern)=>{const all=[...text.matchAll(new RegExp('\\n'+name+': '+pattern+',?\\r?\\n','g'))];return all.length===1?all[0][1]:undefined;};
  const value={environmentName:field('environmentName','"([^"\\\\]{1,80})"'),applicationKey:field('applicationKey','"([a-f0-9-]{36})"'),
    userProviderName:field('userProviderName','"([A-Za-z_][A-Za-z0-9_]{0,198})"'),debugEnabled:field('debugEnabled','(true|false)'),
    homeModuleName:field('homeModuleName','"([A-Za-z_][A-Za-z0-9_]{0,198})"'),homeModuleKey:field('homeModuleKey','"([a-f0-9-]{36})"'),
    homeModuleControllerName:field('homeModuleControllerName','"([A-Za-z_][A-Za-z0-9_.]{0,240})"')};
  if(Object.values(value).some(v=>v===undefined)||value.homeModuleName!==module)fail('app_definition_unresolved');
  if(value.environmentName!=='Development'||value.debugEnabled!=='true')fail('development_unproved');
  return {...value,debugEnabled:true,developmentProved:true};
}

const readPin=(pin,limit=16*1024*1024)=>{
  let bytes;try{bytes=fs.readFileSync(pin.path);}catch{fail('asset_unavailable');}
  if(!path.isAbsolute(pin.path)||bytes.length>limit||sha(bytes)!==pin.sha256)fail('asset_changed');
  return bytes;
};

// Published version only: moduleinfo of the inventoried version, then every
// manifest script (acquireO11PublicAssets), the document and the manifest CSS.
export async function acquireO11BrowserAssets({binding,versionId,directory,fetchImpl=fetch,now=Date.now,acquireScripts}){
  const url=new URL(binding?.runtimeUrl??'');
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'+binding.module+'/'||!NAME.test(binding.module))fail('origin_invalid');
  const scripts=await (acquireScripts??(await import('./debug-o11-native-run.mjs')).acquireO11PublicAssets)({
    target:{runtimeUrl:url.href,module:binding.module},versionId,directory,fetchImpl,now}).catch(error=>{
    throw /publication_changed/.test(error?.message??'')?new Error('debug_o11_browser_publication_changed'):new Error('debug_o11_browser_assets_unavailable');});
  const manifest=scripts.manifest.manifest,pins={'moduleinfo.json':scripts.moduleInfo};
  for(const pin of scripts.pins)pins['scripts/'+pin.name]={path:pin.path,sha256:pin.sha256,urlPath:pin.urlPath,query:pin.query};
  const get=async(urlPath,limit)=>{
    const response=await fetchImpl(url.origin+urlPath,{method:'GET',redirect:'error',credentials:'omit',headers:{Accept:'*/*'}});
    if(response.status!==200||(response.url&&response.url!==url.origin+urlPath))fail('assets_unavailable');
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>limit)fail('assets_unavailable');return bytes;
  };
  const index=await get(url.pathname,1024*1024),indexFile=path.join(directory,'index.html');
  fs.writeFileSync(indexFile,index);pins['index.html']={path:indexFile,sha256:sha(index)};
  const css=Object.entries(manifest.urlVersions??{}).filter(([p,q])=>p.startsWith(url.pathname+'css/')&&FILE.test(p.slice(url.pathname.length+4))&&
    p.endsWith('.css')&&typeof q==='string'&&q.startsWith('?')).sort(([a],[b])=>a<b?-1:1);
  if(css.length>200)fail('assets_unavailable');
  fs.mkdirSync(path.join(directory,'css'),{recursive:true});
  for(const [urlPath,query] of css){
    const bytes=await get(urlPath+query,8*1024*1024),name=urlPath.slice(url.pathname.length+4),file=path.join(directory,'css',name);
    fs.writeFileSync(file,bytes);pins['css/'+name]={path:file,sha256:sha(bytes),urlPath,query};
  }
  return {runtimeUrl:url.href,module:binding.module,moduleVersion:manifest.versionToken,versionId:manifest.versionSequence,pins};
}

export function planO11BrowserAssets(runtime){
  const url=new URL(runtime?.runtimeUrl??''),module=runtime.module;
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!NAME.test(module??'')||url.pathname!=='/'+module+'/')fail('origin_invalid');
  const pins=runtime.pins??{},info=pins['moduleinfo.json'],index=pins['index.html'];
  if(!info||!index)fail('asset_unpinned');
  const infoBytes=readPin(info,5*1024*1024);let appInfo,manifest;
  try{appInfo=JSON.parse(infoBytes.toString('utf8').replace(/^\uFEFF/,''));manifest=appInfo.manifest;}catch{fail('publication_unproved');}
  if(manifest?.versionSequence!==runtime.versionId||manifest.versionToken!==runtime.moduleVersion||typeof manifest.urlVersions!=='object')fail('publication_unproved');
  const assets=new Map(),served={};
  for(const [relative,pin] of Object.entries(pins)){
    const kind=/^scripts\/[^/]+\.js$/.test(relative)?'script':/^css\/[^/]+\.css$/.test(relative)?'css':null;
    if(!kind)continue;
    const name=relative.slice(relative.indexOf('/')+1);
    if(!FILE.test(name)||pin.urlPath!==url.pathname+relative||typeof pin.query!=='string'||manifest.urlVersions[pin.urlPath]!==pin.query)fail('asset_unpinned');
    const body=readPin(pin).toString('utf8');served[relative]=body;
    assets.set(url.origin+pin.urlPath,{body,query:pin.query,contentType:kind==='script'?'text/javascript':'text/css',originalSha256:pin.sha256,servedSha256:pin.sha256});
  }
  // moduleinfo is answered from the pin (OSManifestLoader adds ?cached or a timestamp).
  assets.set(url.origin+url.pathname+'moduleservices/moduleinfo',{body:infoBytes.toString('utf8'),queryPattern:/^(\?[A-Za-z0-9]{1,40})?$/,
    contentType:'application/json',originalSha256:info.sha256,servedSha256:info.sha256});
  const appDefinition=qualifyO11AppDefinition(served['scripts/'+module+'.appDefinition.js'],module);
  const html=readPin(index,1024*1024).toString('utf8'),dom=new JSDOM(html),document=dom.window.document;
  const steps=[],removedScripts=[],sources=[];let bootstrap;
  const indexToken=typeof manifest.urlVersions[url.pathname+'index.html']==='string'?manifest.urlVersions[url.pathname+'index.html'].slice(1):undefined;
  for(const script of document.querySelectorAll('script')){
    const src=script.getAttribute('src'),type=(script.getAttribute('type')??'text/javascript').toLowerCase();
    if(type!=='text/javascript')fail('script_unqualified');
    if(src!==null){
      const target=new URL(src,url.href),name=target.pathname.slice(url.pathname.length+'scripts/'.length);
      const asset=assets.get(target.origin+target.pathname);
      if(target.origin!==url.origin||!target.pathname.startsWith(url.pathname+'scripts/')||!asset||asset.query!==target.search)fail('script_unpinned');
      if(bootstrap)fail('bootstrap_unqualified');
      if(name===module+'.index.js')bootstrap={name,urlPath:target.pathname,query:target.search,src:target.href,sha256:asset.originalSha256,
        ...qualifyO11Bootstrap(asset.body,module)};
      else{steps.push({kind:'script',name,src:target.href});sources.push(name);}
      removedScripts.push({kind:'src',name});
      continue;
    }
    const text=script.textContent;
    if(new RegExp('^\\s*window\\.OutSystemsApp\\s*=\\s*\\{\\s*basePath:\\s*\''+escape(url.pathname)+'\'\\s*\\};?\\s*$').test(text)){
      steps.push({kind:'basePath',value:url.pathname});removedScripts.push({kind:'basePath'});continue;
    }
    const token=/^\s*OSManifestLoader\.indexVersionToken\s*=\s*"([A-Za-z0-9_+/=-]{1,64})";?\s*$/.exec(text)?.[1];
    if(token!==undefined){
      if(token!==indexToken)fail('index_version_mismatch');
      steps.push({kind:'indexVersionToken',value:token});removedScripts.push({kind:'indexVersionToken'});continue;
    }
    // Any other inline script (e.g. the native-shell viewport tweak) is not executed.
    removedScripts.push({kind:'inline-skipped',sha256:sha(text)});
  }
  if(!bootstrap)fail('bootstrap_unqualified');
  if(bootstrap.bootstrapQualified!==true)fail('bootstrap_unqualified');
  if(!sources.includes('OutSystems.js')||!sources.includes('Debugger.js')||!sources.includes(module+'.appDefinition.js')||
    steps.findIndex(s=>s.kind==='indexVersionToken')<steps.findIndex(s=>s.name==='OutSystemsManifestLoader.js'))fail('index_unqualified');
  document.querySelectorAll('script').forEach(s=>s.remove());
  const body=dom.serialize();dom.window.close();
  assets.set(url.href,{body,contentType:'text/html',documentUrl:url.href,originalSha256:index.sha256,servedSha256:sha(body)});
  // appInfo (the pinned moduleinfo) goes only to the discarded preparation realm.
  return {url:url.href,origin:url.origin,module,steps,bootstrap,assets,removedScripts,appDefinition,appInfo,versionToken:manifest.versionToken,versionId:manifest.versionSequence};
}

export async function installO11BrowserAssets(page,plan,{request,abort=()=>{}}={}){
  const pending=new Set(),served=[],refused=[];let disposed=false,failed=false;
  const report=()=>({served:served.slice(),refused:refused.slice(),pending:pending.size,failed,disposed});
  const csp="default-src 'none'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src "+plan.origin+"; worker-src 'none'; frame-src 'none'; base-uri 'self'";
  await page.send('Network.enable');
  await page.send('Network.setBypassServiceWorker',{bypass:true});
  await page.send('Network.setBlockedURLs',{urls:['ws://*','wss://*']});
  page.on('Fetch.requestPaused',event=>{
    const work=(async()=>{
      try{
        if(disposed)throw new Error();
        const original=new URL(event.request.url),key=original.origin+original.pathname;
        const asset=plan.assets.get(key);
        let response;
        if(asset){
          // A pinned path is answered from its pin or refused, never forwarded.
          const exact=asset.contentType==='text/html'?original.href===asset.documentUrl:asset.queryPattern?asset.queryPattern.test(original.search):original.search===asset.query;
          if(event.request.method==='GET'&&exact){
            response={status:200,body:asset.body,headers:[{name:'Content-Type',value:asset.contentType},{name:'Cache-Control',value:'no-store'},
              ...(asset.contentType==='text/html'?[{name:'Content-Security-Policy',value:csp}]:[])]};
            served.push({path:original.pathname,originalSha256:asset.originalSha256,servedSha256:asset.servedSha256});
          }
        }else if(original.origin===plan.origin&&original.pathname.startsWith('/'+plan.module+'/scripts/'));
        else if(request)response=await request(event.request,event.resourceType);
        if(!response||!Number.isInteger(response.status)||response.status<100||response.status>599||typeof response.body!=='string'){
          refused.push({method:event.request.method,resourceType:event.resourceType});
          await page.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});return;
        }
        await page.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:response.status,responseHeaders:response.headers??[],body:Buffer.from(response.body).toString('base64')});
      }catch{
        failed=true;try{await page.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});}catch{}
        if(!disposed)try{abort();}catch{}
      }
    })();pending.add(work);void work.finally(()=>pending.delete(work));
  });
  // Every HTTP request is fulfilled or refused here. Nothing uses continueRequest.
  await page.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  return {receipt:report,async dispose(){disposed=true;await Promise.all([...pending]);return {completed:true,pending:pending.size};}};
}
