import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {resolveOdcBrowserViewResources} from '../debug-odc-browser-view-resources.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(){
 const url='https://fixture.test/App/',handle='__ssamOdcRuntime_'+'a'.repeat(48),body='body{}';
 const helper=function(resource,versions,cdn){return '/App/css/widgets__hash.css?v1';};
 const context={location:{href:url},[handle]:{nativeFunction:()=>helper}};
 return {page:{evaluate:async(fn,args)=>vm.runInNewContext('('+fn.toString()+')',context)(args)},runtimeHandle:handle,runtimeUrl:url,
  views:[{key:'screen',resourceDependencies:{resolved:true,css:['css/widgets.css'],js:[]}}],
  manifest:{versionToken:'version',cdnUrlVersioning:true,urlVersions:{'/App/css/widgets__hash.css':'?v1'}},moduleVersion:'version',
  helperSource:helper.toString(),assets:new Map([[url+'css/widgets__hash.css',{body,contentType:'text/css',originalSha256:hash(body),servedSha256:hash(body)}]])};
}
test('original resolver result is joined to manifest version and pinned served bytes',async()=>{
 const p=await resolveOdcBrowserViewResources(fixture());assert.equal(p.viewResourcesPinned,true);assert.equal(p.resourcesRequested,false);
 assert.equal(p.resources[0].path,'/App/css/widgets__hash.css');assert.equal(p.mountedVerified,false);
});
test('unresolved declarations and missing or changed pins are refused',async()=>{
 for(const mutate of [f=>f.views[0].resourceDependencies.resolved=false,f=>f.assets.clear(),f=>[...f.assets.values()][0].body='changed',f=>f.manifest.versionToken='old']){
  const f=fixture();mutate(f);await assert.rejects(()=>resolveOdcBrowserViewResources(f),/view_resources_/);
 }
});
test('a different helper, foreign result and wrong native version cannot be called a pinned resource',async()=>{
 const f=fixture();f.helperSource='function different(){}';await assert.rejects(()=>resolveOdcBrowserViewResources(f),/native_resolution/);
 for(const url of ['https://foreign.test/css/widgets.css?v1','/Other/css/widgets.css?v1','/App/css/widgets__hash.css?wrong']){
  const f=fixture();f.page={evaluate:async()=>({ok:true,urls:[url]})};await assert.rejects(()=>resolveOdcBrowserViewResources(f),/resolved_scope|version/);
 }
});
