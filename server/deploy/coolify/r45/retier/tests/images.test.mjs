// images.test.mjs: revision 4 of the retier, the image swap (trilha D, IMAGENS.md 12-13), offline (no VPS). Run from server/:
//   node --test deploy/coolify/r45/retier/tests/images.test.mjs
// The pair images built from a signed main move by the retier kit: the image of a service and, for a backend, its
// ssam.image.digest label; nothing else of that service. Positive: one backend (the canary, v5 or v3), all five backends with
// the router, console, admin and ops on the default backend's image (14 paths), images together with a tier move. Negative: an
// image of another repository, a digest that is not sha256:<64 hex>, an image without a new digest, a digest without a new
// image, the console on an image that is not the default backend's, an image with a volume. A kit without images is byte for
// byte the one of the generator before this revision (PREV_REV).
import test,{after} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),dir=path.resolve(here,'..');
const repo=path.resolve(dir,'../../../../..');
const git=process.env.R45_GIT??(process.platform==='win32'?'C:/Program Files/Git/cmd/git.exe':'git');
const g=(...a)=>cp.execFileSync(git,['-C',repo,...a],{encoding:'utf8',maxBuffer:64<<20});
const PIN=process.env.RETIER_PIN??'HEAD';
// The generator before revision 4 (tier keys, 9147ab5): kits without images must not change by one byte.
const PREV_REV=process.env.RETIER_PREV_REV??'9147ab5';
const BASE_RAW='130826ffac94f1102d186ba931dbc11fdf672098d6588aaeee7b0684c1a37020';
const made=[];after(()=>{for(const d of made)fs.rmSync(d,{recursive:true,force:true});});
const tmp=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'retier-img-'));made.push(d);return d;};
const env={...process.env,R45_REPO:repo,R45_GIT:git};
const run=(script,args,cwd=dir)=>cp.spawnSync(process.execPath,[path.join(cwd,script),...args],{encoding:'utf8',env});
const parse=t=>JSON.parse(t.replace(/^#.*\n/,''));
const write=(d,name,c)=>{const f=path.join(d,name);fs.writeFileSync(f,'# test\n'+JSON.stringify(c,null,2)+'\n');return f;};
const gen=(base,next,extra=[],cwd=dir)=>{const d=tmp(),out=path.join(d,'out');
 const r=run('gen-retier-php.mjs',['--base-raw',BASE_RAW,'--out',out,'--base-file',write(d,'base.yml',base),'--c6-file',write(d,'new.yml',next),...extra],cwd);return {...r,out};};
const pinC=()=>parse(g('show',PIN+':server/deploy/coolify/compose.coolify.yml'));
const refused=(r,re,what)=>{assert.notEqual(r.status,0,what+': accepted');assert.match(r.stderr,re,what);};
const BACKENDS=['ssam-server-v1','ssam-server-v2','ssam-server-v3','ssam-server-v4','ssam-server-v5'],OTHERS=['ssam-router','ssam-console','ssam-admin','ssam-ops'];
const kitEnv=d=>Object.fromEntries(fs.readFileSync(path.join(d,'kit.env'),'utf8').trim().split('\n').map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const phpImages=d=>JSON.parse(Buffer.from(fs.readFileSync(path.join(d,'deploy-retier.php'),'utf8').match(/\$IMAGES = json_decode\(base64_decode\('([^']+)'\)/)[1],'base64').toString());
const REPO='docker.io/andrepereiramachado/ssam-server';
const hex=c=>'sha256:'+c.repeat(64);
// The new image of one backend: the tag of a new build of its pair, a new digest.
const move=(c,svc,i)=>{const s=c.services[svc],tag=s.image.split(':').pop().replace(/^prod-\d{8}-[a-z0-9]+-[0-9a-f]{7}/,'prod-20261112-r46-abcdef0');
 s.image=REPO+':'+tag;s.labels['ssam.image.digest']=hex(String(i));return c;};
const defaultOf=c=>BACKENDS.find(b=>c.services[b].labels['ssam.default']==='true');
const all=()=>{const c=pinC();BACKENDS.forEach((b,i)=>move(c,b,String(i+1)));const img=c.services[defaultOf(c)].image;for(const o of OTHERS)c.services[o].image=img;return c;};

test('images: one backend first (the canary, v5 or v3): 2 paths, nothing else moves, and the kit says which',()=>{
 for(const [svc,n] of [['ssam-server-v5','5'],['ssam-server-v3','3']]){
  const N=move(pinC(),svc,n),r=gen(pinC(),N);assert.equal(r.status,0,r.stderr);
  const rep=JSON.parse(r.stdout);assert.equal(rep.delta,2);assert.equal(rep.imagePaths,2);assert.equal(rep.tierPaths,0);assert.deepEqual(rep.envKeys,[]);
  assert.deepEqual(Object.keys(rep.images),[svc]);assert.equal(rep.images[svc].to,N.services[svc].image);assert.equal(rep.images[svc].digestTo,hex(n));
  const kit=kitEnv(r.out);assert.equal(kit.IMAGES_CHANGE,'1');assert.equal(kit.IMAGE_PATHS,'2');assert.equal(kit.IMAGES,svc);assert.equal(kit.HOT_FROM,kit.HOT_TO,'no tier move');
  assert.equal(kit.ROUTER_SIZING_SHA,kit.BASE_ROUTER_SIZING_SHA,'the router label stays: the Redeploy is seen by the restarts');
  assert.deepEqual(phpImages(r.out),rep.images);
  const delta=JSON.parse(fs.readFileSync(path.join(r.out,'expected-delta.json'),'utf8'));
  assert.deepEqual(delta.sort(),[`/services/${svc}/image`,`/services/${svc}/labels/ssam.image.digest`].sort());
 }
});

test('images: the five backends and the router, console, admin and ops on the default backend\'s image: 14 paths',()=>{
 const N=all(),r=gen(pinC(),N);assert.equal(r.status,0,r.stderr);
 const rep=JSON.parse(r.stdout);assert.equal(rep.delta,14);assert.equal(rep.imagePaths,14);assert.equal(Object.keys(rep.images).length,9);
 for(const o of OTHERS){assert.equal(rep.images[o].to,N.services[defaultOf(N)].image);assert.equal(rep.images[o].digestTo,null);}
 const php=fs.readFileSync(path.join(r.out,'deploy-retier.php'),'utf8');
 for(const s of ["stop(\"$name image is not the recorded move\")","stop(\"$name digest is not the recorded move\")","stop('not every recorded image moved')","'imagesChanged' => $imagesChanged","const IMAGE_PATH_COUNT = 14;"])assert.ok(php.includes(s),s);
 assert.ok(!php.includes("foreach (['volumes','networks','image'] as $k)"),'the image is no longer a fixed field of the PHP');
 assert.ok(php.includes("foreach (['volumes','networks'] as $k)"),'volumes and networks still are');
 // retier-window.sh dry_keys prints the counts by grepping these three side by side in the report.
 assert.ok(php.includes("'changedPaths' => count($change), 'tierPaths' => count($change) - count($ENV_ADDED) - IMAGE_PATH_COUNT, 'envAddedPaths' => count($ENV_ADDED), 'imagePaths' => IMAGE_PATH_COUNT,"),'the report keeps changedPaths, tierPaths, envAddedPaths together');
});

test('images: together with a tier move (the hot backend changes in the same window)',()=>{
 const N=move(pinC(),'ssam-server-v5','5'),B=pinC();
 // The base has the hot on v4 and the tiers of v4 and v5 swapped: the pin moves it back to v5 with v5's new image.
 for(const k of ['deploy','cpu_shares'])[B.services['ssam-server-v4'][k],B.services['ssam-server-v5'][k]]=[structuredClone(N.services['ssam-server-v5'][k]),structuredClone(N.services['ssam-server-v4'][k])];
 for(const k of ['SSAM_BUILD_WORKERS','SSAM_O11_WORKERS_MAX','SSAM_BUILD_QUEUE_MS'])[B.services['ssam-server-v4'].environment[k],B.services['ssam-server-v5'].environment[k]]=[N.services['ssam-server-v5'].environment[k],N.services['ssam-server-v4'].environment[k]];
 B.services['ssam-server-v4'].labels['ssam.sizing']='hot';B.services['ssam-server-v5'].labels['ssam.sizing']='other';
 const s=JSON.parse(B.services['ssam-router'].labels['ssam.sizing']);s.changedFor='test';B.services['ssam-router'].labels['ssam.sizing']=JSON.stringify(s);
 const r=gen(B,N);assert.equal(r.status,0,r.stderr);const rep=JSON.parse(r.stdout);
 assert.equal(rep.imagePaths,2);assert.ok(rep.tierPaths>0);assert.deepEqual(rep.hot,{from:'ssam-server-v4',to:'ssam-server-v5'});
});

test('images: refused: another repository, a bad digest, an image without a new digest, a digest without a new image, the console off the default, an image with a volume',()=>{
 const cases=[
  ['another repository',c=>{move(c,'ssam-server-v5','5');c.services['ssam-server-v5'].image='docker.io/someone/else:prod-x';},/not another tag of/],
  ['a digest that is not hex',c=>{move(c,'ssam-server-v5','5');c.services['ssam-server-v5'].labels['ssam.image.digest']='sha256:xyz';},/sha256:<64 hex>/],
  ['an image with the old digest',c=>{const d=c.services['ssam-server-v5'].labels['ssam.image.digest'];move(c,'ssam-server-v5','5');c.services['ssam-server-v5'].labels['ssam.image.digest']=d;},/with the old digest/],
  ['a digest without a new image',c=>{c.services['ssam-server-v5'].labels['ssam.image.digest']=hex('5');},/keeps the tag/],
  ['the console off the default backend',c=>{move(c,'ssam-server-v5','5');c.services['ssam-console'].image=c.services['ssam-server-v5'].image;},/not the image of the default backend/],
  ['an image with a volume',c=>{move(c,'ssam-server-v5','5');c.services['ssam-server-v5'].volumes.push({type:'volume',source:'x',target:'/x'});},/outside the tier paths/],
  ['an image with a served list',c=>{move(c,'ssam-server-v5','5');c.services['ssam-server-v5'].environment.SSAM_SERVED_VERSIONS='[]';},/outside the tier paths/],
 ];
 for(const [what,mut,re] of cases){const n=pinC();mut(n);refused(gen(pinC(),n),re,what);}
 refused(gen(pinC(),pinC()),/does not change/,'no image and no tier: nothing to do');
});

test('images: with no image in the delta every output is byte for byte the generator before revision 4',()=>{
 const prev=tmp();fs.mkdirSync(path.join(prev,'retier'));
 fs.writeFileSync(path.join(prev,'php-classes.mjs'),g('show',PREV_REV+':server/deploy/coolify/r45/php-classes.mjs'));
 fs.writeFileSync(path.join(prev,'retier','gen-retier-php.mjs'),g('show',PREV_REV+':server/deploy/coolify/r45/retier/gen-retier-php.mjs'));
 const base=parse(g('show','c70b570:server/deploy/coolify/compose.coolify.yml'));
 const a=gen(base,pinC()),b=gen(base,pinC(),[],path.join(prev,'retier'));
 assert.equal(a.status,0,a.stderr);assert.equal(b.status,0,b.stderr);assert.equal(a.stdout,b.stdout);
 const files=d=>fs.readdirSync(d).sort();assert.deepEqual(files(a.out),files(b.out));
 for(const f of files(a.out))assert.equal(fs.readFileSync(path.join(a.out,f),'utf8'),fs.readFileSync(path.join(b.out,f),'utf8'),f);
 assert.equal(kitEnv(a.out).IMAGES_CHANGE,'0');
});

// Review C A3: the command line says which images the kit moves (retier-kit.mjs requires --images; none for a tier kit).
test('images: --images must name exactly the moved services; a tier kit is --images none; the report names them for the window',()=>{
 const N=move(pinC(),'ssam-server-v5','5');
 const ok=gen(pinC(),N,['--images','ssam-server-v5']);assert.equal(ok.status,0,ok.stderr);
 assert.ok(fs.readFileSync(path.join(ok.out,'deploy-retier.php'),'utf8').includes("'imageNames' => implode(',', array_keys($imagesChanged))"),'the dry run report names the moved images');
 refused(gen(pinC(),N,['--images','none']),/--images none but the base->new delta moves ssam-server-v5/,'a tier kit whose pin moves an image');
 refused(gen(pinC(),N,['--images','ssam-server-v3']),/moves ssam-server-v5/,'another backend');
 const A=all(),order=[...OTHERS,...BACKENDS].join(',');
 const every=gen(pinC(),A,['--images',order]);assert.equal(every.status,0,every.stderr);
 refused(gen(pinC(),A,['--images',BACKENDS.join(',')]),/moves .*ssam-router/,'the router, console, admin and ops left out');
 const base=parse(g('show','c70b570:server/deploy/coolify/compose.coolify.yml'));
 const tier=gen(base,pinC(),['--images','none']);assert.equal(tier.status,0,tier.stderr);
 assert.ok(!fs.readFileSync(path.join(tier.out,'deploy-retier.php'),'utf8').includes('imageNames'),'a tier kit carries no imageNames');
 refused(gen(base,pinC(),['--images','ssam-server-v5']),/--images ssam-server-v5 but the base->new delta moves none/,'a tier kit said to move an image');
});

// Review C A4: the canary is never the default backend; moving it moves the router, console, admin and ops with it.
test('images: the default backend moves only with every service on its image (no v1 canary)',()=>{
 const N=pinC(),d=defaultOf(N);move(N,d,'1');
 refused(gen(pinC(),N),/the default backend ssam-server-v1 moves, so ssam-admin, ssam-console, ssam-ops, ssam-router \(on its image\) must move with it/,'the default backend alone');
 const half=pinC();move(half,d,'1');half.services['ssam-router'].image=half.services[d].image;
 refused(gen(pinC(),half),/so ssam-admin, ssam-console, ssam-ops \(on its image\)/,'the default backend with the router only');
 const whole=pinC();move(whole,d,'1');for(const o of OTHERS)whole.services[o].image=whole.services[d].image;
 const r=gen(pinC(),whole);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).imagePaths,6);
 const lone=pinC();lone.services['ssam-router'].image=REPO+':prod-20261112-r46-abcdef0-o115594-odc1730';
 refused(gen(pinC(),lone),/not the image of the default backend/,'the router without the default backend');
});
