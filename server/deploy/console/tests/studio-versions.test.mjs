import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeEnv,startConsole} from './helpers.mjs';
import {createSources} from '../sources.mjs';
const write=(root,name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
const seen='2026-10-21T02:00:00Z';
function fixture(){
 const env=makeEnv();const root=env.serverDir;
 write(root,'state/backend-versions.json',{window:3,backends:[{name:'new',odc:'1.7.29',o11:'11.55.93',default:true},{name:'old',odc:'1.7.28',o11:'11.55.92',default:false}]});
 write(root,'versions/new/kernel.json',{odc:'1.7.29',o11:'11.55.93'});
 write(root,'state/routing.json',{schema:1,routes:{tok_111111111111:{backend:'new'},tok_222222222222:{backend:'old'},tok_333333333333:{backend:'new'}}});
 write(root,'versions/old/state/studio-versions.json',{tokens:{tok_111111111111:{seen:'2026-10-20T00:00:00Z',odc:{installed:'1.7.28.10'}},tok_222222222222:{seen,odc:{installed:'1.7.28.10'},o11:{installed:'11.55.92.10'}}}});
 write(root,'versions/new/state/studio-versions.json',{tokens:{tok_111111111111:{seen,odc:{installed:'1.7.29.10'},o11:{installed:'11.55.93.10'}},tok_333333333333:{seen,odc:{installed:'1.7.30.10',unserved:true}}}});
 write(root,'state/proposed-versions.json',{leaving:{odc:['1.7.28'],o11:['11.55.92']}});
 return env;
}
test('Studio versions merge newest observations, count backend customers and mark the proposed departures',()=>{
 const env=fixture(),sources=createSources({serverDir:env.serverDir});const v=sources.studioVersions();
 assert.equal(v.window,3);assert.equal(v.error,null);assert.equal(v.rows.length,5);
 assert.deepEqual(v.rows.find(r=>r.lane==='odc'&&r.version==='1.7.29'),{lane:'odc',version:'1.7.29',backend:'new',status:'default',customers:2,lastSeen:new Date(seen).toISOString()});
 assert.equal(v.rows.find(r=>r.lane==='odc'&&r.version==='1.7.28').status,'leaving');
 const missing=v.rows.find(r=>r.status==='unserved');assert.equal(missing.customers,1);assert.equal(missing.version,'1.7.30');assert.equal(missing.backend,null);
 assert.equal(sources.kernel().odc,'1.7.29');
 fs.rmSync(path.join(env.serverDir,'state/proposed-versions.json'));assert.equal(sources.studioVersions().rows.find(r=>r.version==='1.7.28').status,'served');
});
test('overview exposes Studio versions and its unserved alert through the existing alert engine',async t=>{
 const env=fixture(),c=await startConsole(env);t.after(()=>c.close());await c.app.tickAll();await c.app.tickAlerts();
 const ov=(await c.get('/api/overview')).body;assert.equal(ov.studioVersions.rows.length,5);
 assert.ok(ov.alerts.some(a=>a.title==='ODC Studio 1.7.30 not served: 1 customers'&&a.rule==='studio-version-unserved'));
 assert.doesNotMatch(JSON.stringify(ov.studioVersions),/tok_|C:\\|credential/);
});
test('version sources tolerate missing state and report malformed observations without exposing file paths',()=>{
 const env=makeEnv(),sources=createSources({serverDir:env.serverDir});assert.equal(sources.studioVersions().rows.length,2);
 write(env.serverDir,'state/studio-versions.json',{tokens:null});
 const v=sources.studioVersions();assert.equal(v.error,'Studio observations unavailable.');assert.doesNotMatch(JSON.stringify(v),/C:\\|\.json|stack/);
});
test('console file sizes include every backend runtime',()=>{
 const env=fixture();fs.writeFileSync(path.join(env.serverDir,'server.log'),'a');for(const name of ['old','new'])fs.writeFileSync(path.join(env.serverDir,'versions',name,'server.log'),'bb');
 assert.equal(createSources({serverDir:env.serverDir}).statFiles(true).serverLogB,5);
});

test('replacing one backend access log preserves alerts read from another backend',async t=>{
 const env=fixture(),row=id=>JSON.stringify({time:new Date().toISOString(),token:id,customer:'Fixture'})+'\n';
 const old=path.join(env.serverDir,'versions/old/access-alerts.jsonl'),next=path.join(env.serverDir,'versions/new/access-alerts.jsonl');
 fs.writeFileSync(old,row('tok_111111111111'));fs.writeFileSync(next,row('tok_222222222222'));
 const c=await startConsole(env);t.after(()=>c.close());await c.app.tickAll();
 assert.equal(c.app.parts.sources.accessCount('tok_222222222222'),1);
 fs.writeFileSync(old,row('tok_333333333333'));await c.app.tickAll();
 assert.equal(c.app.parts.sources.accessCount('tok_222222222222'),1);
 assert.equal(c.app.parts.sources.accessCount('tok_111111111111'),0);
 assert.equal(c.app.parts.sources.accessCount('tok_333333333333'),1);
});
