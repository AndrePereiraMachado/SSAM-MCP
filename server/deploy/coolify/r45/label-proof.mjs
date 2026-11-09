// label-proof.mjs (r45 capacity, review R2 M4.4): proves, read-only, that the watcher reads back from the stored compose
// the sizing main holds. Input: the output of read-labels.php (`ssh ... 'docker exec -i coolify php' < read-labels.php >
// labels-after.json`), or --compose <file> to read a local compose.coolify.yml the same way (rehearsal). It parses the
// router label with the watcher's own sizingOfCompose (gen-compose.mjs of the pin, argv[3], default HEAD) and checks that
// it equals versions.json sizing of the pin, and that every backend's tier label, limits, cpu_shares and pools are the
// ones backendTiers / sizedExpectations give. Prints LABELS OK or LABELS FAIL with the reasons; exit 0 / 1.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import cp from 'node:child_process';import assert from 'node:assert/strict';
const git=process.env.R45_GIT??'C:/Program Files/Git/cmd/git.exe',wt=process.env.R45_REPO??'C:/t/r5/wt-capacity';
const args=process.argv.slice(2);const local=args[0]==='--compose';const input=local?args[1]:args[0];const pin=(local?args[2]:args[1])??'HEAD';
const show=f=>cp.execFileSync(git,['-C',wt,'show',`${pin}:server/deploy/coolify/${f}`],{encoding:'utf8'});
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'r45-pin-'));
for(const f of ['gen-compose.mjs','compose.template.json'])fs.writeFileSync(`${tmp}/${f}`,show(f));
let m;try{m=await import('file:///'+tmp.replace(/\\/g,'/')+'/gen-compose.mjs');}finally{fs.rmSync(tmp,{recursive:true,force:true});}
const manifest=JSON.parse(show('versions.json')),exp=m.sizedExpectations(manifest);
let live;
if(local){const c=JSON.parse(fs.readFileSync(input,'utf8').replace(/^#.*\n/,''));live={routerSizing:c.services['ssam-router'].labels?.['ssam.sizing']??null,backends:{}};
 for(const [n,s] of Object.entries(c.services))if(s.labels?.['ssam.backend']==='true')live.backends[n]={tier:s.labels['ssam.sizing']??null,cpus:s.deploy.resources.limits.cpus,memory:s.deploy.resources.limits.memory,cpu_shares:s.cpu_shares??null,SSAM_BUILD_WORKERS:s.environment.SSAM_BUILD_WORKERS,SSAM_O11_WORKERS_MAX:s.environment.SSAM_O11_WORKERS_MAX};}
else live=JSON.parse(fs.readFileSync(input,'utf8').replace(/^runtime check:.*\n/,''));
const problems=[];
let sizing;
try{sizing=m.sizingOfCompose({services:{'ssam-router':{labels:live.routerSizing===null?{}:{'ssam.sizing':live.routerSizing}}}});}catch(e){problems.push('router label: '+e.message);}
if(sizing===undefined&&!problems.length)problems.push('the router carries no ssam.sizing: the watcher would see an unsized window');
else if(sizing){try{assert.deepEqual(sizing,manifest.sizing);}catch{problems.push('the router label is not versions.json sizing of '+pin);}}
const mib=v=>{const x=/^(\d+)([mg])$/.exec(v);return x?Number(x[1])*(x[2]==='g'?1024:1):NaN;};
for(const [svc,e] of Object.entries(exp)){
 if(svc==='ssam-router')continue;
 const b=live.backends[svc];if(!b){problems.push(svc+': missing');continue;}
 const want={tier:e.tier,cpus:e.NanoCpus/1e9,memory:e.Memory/1048576,cpu_shares:e.CpuShares,SSAM_BUILD_WORKERS:e.env.SSAM_BUILD_WORKERS,SSAM_O11_WORKERS_MAX:e.env.SSAM_O11_WORKERS_MAX};
 const got={tier:b.tier,cpus:Number(b.cpus),memory:mib(b.memory),cpu_shares:b.cpu_shares,SSAM_BUILD_WORKERS:b.SSAM_BUILD_WORKERS,SSAM_O11_WORKERS_MAX:b.SSAM_O11_WORKERS_MAX};
 for(const k of Object.keys(want))if(want[k]!==got[k])problems.push(`${svc} ${k}: stored ${JSON.stringify(got[k])}, expected ${JSON.stringify(want[k])}`);
}
const hot=Object.entries(live.backends).filter(([,b])=>b.tier==='hot').map(([n])=>n);
console.log(JSON.stringify({pin,hotPair:manifest.sizing?.hotPair??null,hotBackend:hot,checked:Object.keys(exp).length-1}));
if(problems.length){console.log('LABELS FAIL\n'+problems.join('\n'));process.exit(1);}
console.log('LABELS OK');
