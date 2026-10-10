import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ReleaseState} from '../preview/engines/odc/host.mjs';
import {digest,summarizeState} from '../preview/profile.mjs';
import {definitions,closeAMD} from '../preview/engines/o11/amd-closure.mjs';

test('ODC release from another target or scenario is refused before promotion',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-preview-release-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'release.json'),target={module:'Test',moduleKey:'test',screen:'Home',screenKey:'home'};
 const config={target,scenarioContract:{sha256:'a'.repeat(64)}};
 const manager=new ReleaseState({sessionId:'test',config});
 function pointer(target,scenario){const r={schema:'ssam-official-live-release/2',sessionId:'test',target,scenarioContract:{sha256:scenario},generator:{kind:'o11-original-over-adapted-odc'}};fs.writeFileSync(file,JSON.stringify(r));return{schema:'ssam-official-live-selection/1',sequence:1,manifest:{file,sha256:digest(fs.readFileSync(file))}};}
 assert.throws(()=>manager.promote(pointer({...target,screenKey:'other'},config.scenarioContract.sha256)),{code:'RELEASE_CONTEXT_TARGET'});
 assert.throws(()=>manager.promote(pointer(target,'b'.repeat(64))),{code:'RELEASE_CONTEXT_TARGET'});assert.equal(manager.state.promoted,null);
});
test('readiness separates a running host from build and browser evidence',()=>{
 assert.equal(summarizeState({}).readiness,'waiting-for-build');
 assert.equal(summarizeState({promoted:{buildId:'new'},rendered:{buildId:'old',kind:'rendered'}}).readiness,'waiting-for-browser');
 assert.equal(summarizeState({promoted:{buildId:'new'},rendered:{buildId:'new',kind:'render-error'}}).readiness,'render-error');
 assert.equal(summarizeState({promoted:{buildId:'new'},rendered:{buildId:'new',kind:'rendered'}}).readiness,'rendered');
});
test('public Acorn parses AMD and rejects an incomplete native dependency closure',()=>{
 const body=Buffer.from('define("App.Main", ["exports", "./Data"], function(exports, data){});');
 assert.deepEqual(definitions('/view/main.js',body),[{id:'App.Main',deps:['exports','Data']}]);
 assert.throws(()=>closeAMD(new Map([['/view/main.js',{body}]]),['App.Main']),{code:'AMD_CLOSURE_MISSING'});
});
