import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {installOdcBrowserAssets,odcDocumentRoute,planOdcBrowserAssets} from '../debug-odc-native-browser-assets.mjs';
const url='https://fixture.example/App/',sha=s=>createHash('sha256').update(s).digest('hex');
const qualified={routeExpressionsQualified:true,routes:[{screenName:'Main.Home',defaultPath:true,segment:'',chunk:'a.js'},{screenName:'Main.Home',defaultPath:false,segment:'Home',chunk:'a.js'},
 {screenName:'Main.Probe',defaultPath:false,segment:'Probe',chunk:'b.js'}]};
function plan(route){
 const html={body:'<html></html>',contentType:'text/html',originalSha256:'a'.repeat(64),servedSha256:sha('<html></html>'),documentUrl:url};
 const assets=new Map([[url,html],[url+'scripts/x.js',{body:'1',contentType:'text/javascript',originalSha256:'b'.repeat(64),servedSha256:sha('1')}]]);
 if(route){const d=odcDocumentRoute(url,route,qualified);assets.set(d.key,{...html,documentUrl:d.documentUrl,route:d.route});}
 return {url,assets};
}
function page(){
 const p=new EventEmitter(),sent=[];p.sent=sent;p.send=async(method,params)=>{sent.push([method,params]);};
 p.request=async(requested,method='GET')=>{const before=sent.length;p.emit('Fetch.requestPaused',{requestId:'r'+before,request:{url:requested,method},resourceType:'Document'});
  for(let i=0;i<50&&sent.length===before;i++)await new Promise(r=>setImmediate(r));return sent.at(-1);};
 return p;
}
test('a qualified named route is a document path with exactly the authorized query',()=>{
 const d=odcDocumentRoute(url,{segment:'Probe',query:'Seed=4'},qualified);
 assert.equal(d.key,url+'Probe');assert.equal(d.documentUrl,url+'Probe?Seed=4');
 assert.deepEqual(d.route,{segment:'Probe',querySha256:sha('Seed=4'),screenName:'Main.Probe'});
 assert.equal(odcDocumentRoute(url,{segment:'Probe',query:''},qualified).documentUrl,url+'Probe');
 for(const route of [{segment:'Missing',query:''},{segment:'',query:''},{segment:'../x',query:''},{segment:'Probe',query:'?Seed=4'},{segment:'Probe',query:'a#b'}])
  assert.throws(()=>odcDocumentRoute(url,route,qualified),/debug_odc_browser_route_/);
 assert.throws(()=>odcDocumentRoute(url,{segment:'Probe',query:''},{...qualified,routeExpressionsQualified:false}),/route_unqualified/);
});
test('the pinned document is served at the qualified route path; an unauthorized query or path is refused',async()=>{
 const p=page(),boundary=await installOdcBrowserAssets(p,plan({segment:'Probe',query:'Seed=4'}));
 let [method,params]=await p.request(url+'Probe?Seed=4');assert.equal(method,'Fetch.fulfillRequest');
 assert.equal(Buffer.from(params.body,'base64').toString(),'<html></html>');
 assert.ok(params.responseHeaders.some(h=>h.name==='Content-Security-Policy'));
 [method]=await p.request(url);assert.equal(method,'Fetch.fulfillRequest');
 for(const refused of [url+'Probe?Seed=5',url+'Probe',url+'Probe?Seed=4&x=1',url+'?Seed=4',url+'Other'])
  assert.equal((await p.request(refused))[0],'Fetch.failRequest',refused);
 assert.deepEqual(boundary.receipt().served.map(s=>s.path),['/App/Probe','/App/']);
 assert.equal((await boundary.dispose()).completed,true);
});
test('without an authorized route every document query or route path stays refused',async()=>{
 const p=page();await installOdcBrowserAssets(p,plan());
 assert.equal((await p.request(url+'Probe'))[0],'Fetch.failRequest');
 assert.equal((await p.request(url+'?a=1'))[0],'Fetch.failRequest');
 assert.equal((await p.request(url))[0],'Fetch.fulfillRequest');
});
test('the pinned r3 assets plan the named route document when the evidence is present',t=>{
 const dir=path.resolve(import.meta.dirname,'../../../../.local/debugger/native-runs/odc/55b60b0c-1d96-4381-b918-d8ac35c6b630/assets');
 if(!fs.existsSync(dir)){t.skip('pinned r3 assets absent');return;}
 const pins=Object.fromEntries(fs.readdirSync(dir).map(name=>{const bytes=fs.readFileSync(path.join(dir,name));return [name,{path:path.join(dir,name),sha256:sha(bytes)}];}));
 const runtime={runtimeUrl:'https://fixture.example/SSAMCooperativePauseProof20261009/',pins};
 const p=planOdcBrowserAssets(runtime,{route:{segment:'PauseProbe',query:''}});
 const doc=p.assets.get(runtime.runtimeUrl+'PauseProbe');
 assert.equal(doc.contentType,'text/html');assert.equal(doc.documentUrl,runtime.runtimeUrl+'PauseProbe');
 assert.throws(()=>planOdcBrowserAssets(runtime,{route:{segment:'Other',query:''}}),/route_unqualified/);
});
