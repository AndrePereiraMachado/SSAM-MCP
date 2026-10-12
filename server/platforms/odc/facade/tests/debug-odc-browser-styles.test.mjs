import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {assetHash} from '../debug-odc-native-assets.mjs';
import {odcDocumentStyles,acquireOdcDocumentStyles,pinnedOdcDocumentStyles} from '../debug-odc-browser-styles.mjs';
function fixture(t,href='css/theme.css?v=1'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-styles-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const html='<link rel="stylesheet" href="'+href+'">',file=path.join(root,'index.html');fs.writeFileSync(file,html);
 return {root,runtime:{runtimeUrl:'https://fixture.example/App/',pins:{'index.html':{path:file,sha256:assetHash(html)}}}};
}
test('declared CSS is acquired without credentials and served byte-for-byte with its original pin',async t=>{
 const {root,runtime}=fixture(t),css='body{color:red}',requests=[];
 const acquired=await acquireOdcDocumentStyles(runtime,path.join(root,'styles'),{fetchImpl:async(url,options)=>{requests.push({url,options});return new Response(css);}});
 assert.equal(requests[0].options.credentials,'omit');assert.equal(requests[0].options.redirect,'error');
 const assets=pinnedOdcDocumentStyles({...runtime,pins:{...runtime.pins,...acquired.pins}});
 assert.equal(assets[0].body,css);assert.equal(assets[0].servedSha256,assets[0].originalSha256);
 fs.writeFileSync(Object.values(acquired.pins)[0].path,'changed');assert.throws(()=>pinnedOdcDocumentStyles({...runtime,pins:{...runtime.pins,...acquired.pins}}),/source_changed|styles_changed/);
});
test('external or non-CSS paths and missing pins cannot be used as stylesheet fallbacks',t=>{
 for(const href of ['https://other.example/x.css','../outside.css','css/script.js']){
  const {runtime}=fixture(t,href);assert.throws(()=>odcDocumentStyles(runtime),/styles_scope/);
 }
 const {runtime}=fixture(t);assert.throws(()=>pinnedOdcDocumentStyles(runtime),/pin_missing/);
});
test('redirected responses refuse; existing evidence directory is not overwritten',async t=>{
 const {root,runtime}=fixture(t),dir=path.join(root,'styles');
 await assert.rejects(acquireOdcDocumentStyles(runtime,dir,{fetchImpl:async()=>({status:200,redirected:true})}),/styles_response/);
 await assert.rejects(acquireOdcDocumentStyles(runtime,dir),/EEXIST/);
});
function addManifest(root,runtime,urlVersions,versionToken='published'){
 const body=JSON.stringify({manifest:{versionToken,urlVersions}}),file=path.join(root,'moduleinfo.json');
 fs.writeFileSync(file,body);runtime.pins['moduleinfo.json']={path:file,sha256:assetHash(body)};runtime.moduleVersion='published';
}
test('lazy view styles are acquired from the pinned publication manifest before the view requests them',async t=>{
 const {root,runtime}=fixture(t,'css/theme.css');
 addManifest(root,runtime,{'/App/css/theme.css':'?v1','/App/css/OutSystemsReactWidgets__abc.css':'?abc','/App/scripts/x.js':'?x'});
 const urls=odcDocumentStyles(runtime);assert.equal(urls.length,2);assert.ok(urls[1].endsWith('/css/OutSystemsReactWidgets__abc.css?abc'));
 const acquired=await acquireOdcDocumentStyles(runtime,path.join(root,'styles'),{fetchImpl:async()=>new Response('body{}')});
 const assets=pinnedOdcDocumentStyles({...runtime,pins:{...runtime.pins,...acquired.pins}});
 assert.equal(assets.length,2);assert.equal(assets[1].originalSha256,assetHash('body{}'));
});
test('manifest styles refuse another origin, conflicting publication, paths and versions',t=>{
 for(const [resource,version,token] of [
  ['https://other.example/css/x.css','?v','published'],['/Other/css/x.css','?v','published'],
  ['/App/css/x.css','?v#fragment','published'],['/App/css/x.css','?v','old'],
  ['/App/css/theme.css','?v2','published'],
 ]){
  const {root,runtime}=fixture(t);addManifest(root,runtime,{[resource]:version},token);
  assert.throws(()=>odcDocumentStyles(runtime),/styles_scope|styles_manifest|styles_version_conflict/);
 }
});
