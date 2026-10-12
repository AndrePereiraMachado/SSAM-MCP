import {parse} from 'acorn';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const fail=code=>{throw new Error('debug_odc_browser_view_resources_'+code);};
export function readNativeVersionedUrlSource(sources){
 const matches=Object.values(sources).filter(s=>hash(s)==='1dbfad22bdf417ed43aa1ac716b3a0b402345f4608efbb4025e0be4acdfeb40d');
 if(matches.length!==1)fail('sdk_unreviewed');
 const source=matches[0],ast=parse(source,{ecmaVersion:'latest',sourceType:'module'}),functions=[];
 for(const row of ast.body)for(const d of row.type==='VariableDeclaration'?row.declarations:[]){
  const call=d.init;
  if(call?.type==='CallExpression'&&call.arguments.length===2&&call.arguments[0].type==='FunctionExpression'&&call.arguments[1].type==='Literal'&&call.arguments[1].value==='getVersionedUrl')functions.push(call.arguments[0]);
 }
 if(functions.length!==1)fail('helper_unresolved');
 return source.slice(functions[0].start,functions[0].end);
}
export async function resolveOdcBrowserViewResources({page,runtimeHandle,runtimeUrl,views,manifest,moduleVersion,helperSource,assets}){
 if(typeof page?.evaluate!=='function'||!/^__ssamOdcRuntime_[a-f0-9]{48}$/.test(runtimeHandle??'')||!(assets instanceof Map)||typeof helperSource!=='string'||!Array.isArray(views)||!views.length)fail('contract');
 const base=new URL(runtimeUrl);
 if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||!base.pathname.endsWith('/'))fail('origin');
 if(!moduleVersion||manifest?.versionToken!==moduleVersion||typeof manifest.cdnUrlVersioning!=='boolean'||!manifest.urlVersions||typeof manifest.urlVersions!=='object'||Array.isArray(manifest.urlVersions))fail('manifest');
 const requested=[];
 for(const view of views){
  const dependencies=view.resourceDependencies;if(dependencies?.resolved!==true)fail('unresolved');
  for(const kind of ['css','js']){
   if(!Array.isArray(dependencies[kind]))fail('declarations');
   for(const declared of dependencies[kind]){
    if(typeof declared!=='string'||!declared)fail('declarations');
    const url=new URL(declared,base),prefix=base.pathname+(kind==='css'?'css/':'scripts/');
    if(url.origin!==base.origin||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(prefix)||!url.pathname.endsWith('.'+kind))fail('scope');
    requested.push({viewKey:view.key,kind,declared});
   }
  }
 }
 if(requested.length>512)fail('limit');
 const result=await page.evaluate(({handle,url,helperSource,manifest,requested})=>{
  if(location.href!==url)return {ok:false};
  try{
   const runtime=globalThis[handle],helper=runtime?.nativeFunction?.('getVersionedUrl');
   if(typeof helper!=='function'||Function.prototype.toString.call(helper)!==helperSource)return {ok:false};
   return {ok:true,urls:requested.map(r=>helper(r.declared,manifest.urlVersions,manifest.cdnUrlVersioning))};
  }catch{return {ok:false};}
 },{handle:runtimeHandle,url:runtimeUrl,helperSource,manifest:{urlVersions:manifest.urlVersions,cdnUrlVersioning:manifest.cdnUrlVersioning},requested},5000);
 if(result?.ok!==true||!Array.isArray(result.urls)||result.urls.length!==requested.length)fail('native_resolution');
 const resources=result.urls.map((resolved,i)=>{
  if(typeof resolved!=='string'||!resolved)fail('native_resolution');
  const request=requested[i],url=new URL(resolved,base),prefix=base.pathname+(request.kind==='css'?'css/':'scripts/');
  if(url.origin!==base.origin||url.username||url.password||url.hash||!url.pathname.startsWith(prefix)||!url.pathname.endsWith('.'+request.kind))fail('resolved_scope');
  const version=manifest.urlVersions[url.pathname];
  if(typeof version!=='string'||!version||url.search!==version)fail('version');
  url.search='';const asset=assets.get(url.href);
  if(!asset||asset.contentType!==(request.kind==='css'?'text/css':'text/javascript')||typeof asset.body!=='string'||!/^[a-f0-9]{64}$/.test(asset.originalSha256??'')||hash(asset.body)!==asset.servedSha256)fail('pin');
  return {...request,path:url.pathname,version,originalSha256:asset.originalSha256,servedSha256:asset.servedSha256};
 });
 return {nativeUrlResolverMatched:true,viewResourcesPinned:true,resources,resourcesRequested:false,
  helperSha256:hash(helperSource),mountedVerified:false,lifecycleComplete:false};
}
