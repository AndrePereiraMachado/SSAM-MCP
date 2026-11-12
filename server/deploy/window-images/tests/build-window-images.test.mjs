// build-window-images.test.mjs: the checks of build-window-images.sh before any build (trilha D, the X1 correction window), on a
// throwaway repository holding a copy of the script, with a fake docker and throwaway ssh keys. Nothing is built: every run
// ends at a STOP, the accepted ones at "already exists locally" (the fake docker says every image exists), after the rule and
// the clean tree. From server/:
//   node --test deploy/window-images/tests/build-window-images.test.mjs
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url)),server=path.resolve(here,'../../..');
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash',fwd=p=>p.replaceAll('\\','/');
const keygen=!cp.spawnSync('ssh-keygen',['-?']).error;
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-bwi-')),repo=path.join(tmp,'repo'),bin=path.join(tmp,'bin');
const git=(args,opts={})=>{const r=cp.spawnSync('git',['-C',repo,'-c','user.name=t','-c','user.email=t@t','-c','commit.gpgsign=false',...args],{encoding:'utf8',...opts});if(r.status!==0)throw Error(`git ${args.join(' ')}: ${r.stderr}`);return r.stdout.trim();};
const put=(f,t)=>{fs.mkdirSync(path.dirname(path.join(repo,f)),{recursive:true});fs.writeFileSync(path.join(repo,f),t);};
const commit=(m,extra=[])=>{git(['add','-A']);git([...extra,'commit','-q','-m',m]);return git(['rev-parse','HEAD']);};
const keys={owner:path.join(tmp,'owner'),other:path.join(tmp,'other')};
const signArgs=k=>['-c','gpg.format=ssh','-c',`user.signingkey=${fwd(k)}`];

// The history (server/.gitattributes eol=lf, as the product repo keeps its server tree LF on every checkout): P (production, the app only) -> T (main: P plus the tooling; origin/main) ; H = P + the fix C (C made on T).
fs.mkdirSync(repo);git(['init','-q','-b','main']);
put('server/platforms/odc/facade/read-budget.mjs','// budget\nconst key = {scope, args};\nexport {key};\n');put('server/Dockerfile','FROM scratch\n');put('server/.dockerignore','.git\n');put('server/.gitattributes','* text=auto eol=lf\n');
const P=commit('production');
for(const f of ['deploy/window-images/build-window-images.sh','deploy/window-images/window-images.mjs','deploy/window-images/source-rules.mjs','deploy/coolify/versions.json'])
 put('server/'+f,fs.readFileSync(path.join(server,f),'utf8'));
put('.gitignore','server/deploy/.generated/\n');
if(keygen)for(const k of Object.values(keys))cp.execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-C','test','-f',k]);
const T=commit('tooling on main',keygen?['-c','gpg.format=ssh','-c',`user.signingkey=${fwd(keys.owner)}`,'-c','commit.gpgsign=true']:[]);
git(['update-ref','refs/remotes/origin/main',T]);
git(['checkout','-q','-b','fix']);put('server/platforms/odc/facade/read-budget.mjs','// budget\nconst key = {scope, client, args};\nexport {key};\n');const C=commit('fix');
git(['checkout','-q','--detach',P]);git(['cherry-pick',C]);const H=git(['rev-parse','HEAD']);
let Hs=null;if(keygen){git(['checkout','-q','--detach',P]);git([...signArgs(keys.owner),'cherry-pick','-S',C]);Hs=git(['rev-parse','HEAD']);}
git(['checkout','-q','main']);
// The fake docker: every pair image is P's (revision label) and every image exists.
fs.mkdirSync(bin);
const fake=path.join(bin,'fake-docker.mjs');
fs.writeFileSync(fake,`const a=process.argv.slice(2);if(a[0]==='image'&&a[1]==='inspect'){if(a.includes('-f')&&a[a.indexOf('-f')+1].includes('revision'))console.log(${JSON.stringify(P)});process.exit(0);}process.exit(0);\n`);
fs.writeFileSync(path.join(bin,'docker'),`#!/bin/sh\nexec node '${fwd(fake)}' "$@"\n`,{mode:0o755});
const script=path.join(repo,'server/deploy/window-images/build-window-images.sh');
const run=(args,cwd=repo)=>cp.spawnSync(bash,[fwd(script),...args],{encoding:'utf8',cwd,env:{...process.env,PATH:fwd(bin)+path.delimiter+process.env.PATH,DOCKER_BIN:fwd(fake)}});
const v=JSON.parse(fs.readFileSync(path.join(server,'deploy/coolify/versions.json'),'utf8'));
const only=v.odc.filter(e=>e.tag.includes('-60e13ec-')).map(e=>e.version).join(',');
const src=(s,more=[])=>['--source',s,'--fix',C,'--mode','pairs','--only',only,...more];
const prod=['--release','r46','--owner-key',fwd(keys.owner+'.pub')];
const stopped=(r,re)=>{assert.notEqual(r.status,0,r.stdout);assert.match(r.stderr,re,r.stderr+r.stdout);};

test('--source --ensaio: the rule passes, the clean tree of the source is written, then the build loop (fake: the image exists)',()=>{
 const r=run(src(H,['--ensaio']));stopped(r,/already exists locally/);
 const out=path.join(repo,'server/deploy/.generated/window-images-'+H.slice(0,7));
 const rule=JSON.parse(fs.readFileSync(path.join(out,'source.json'),'utf8'));assert.equal(rule.parent,P);assert.deepEqual(rule.files,['server/platforms/odc/facade/read-budget.mjs']);
 assert.equal(fs.readFileSync(path.join(out,'tree/server/platforms/odc/facade/read-budget.mjs'),'utf8'),git(['show',`${H}:server/platforms/odc/facade/read-budget.mjs`])+'\n');
 assert.ok(!fs.existsSync(path.join(out,'tree/server/deploy/window-images')),'the tree is the source commit, without the tooling');
 assert.match(fs.readFileSync(path.join(out,'run.txt'),'utf8'),/tree: .* checked out clean into .* \(4 files of server\/\)/);
 assert.equal(git(['rev-parse','HEAD']),T,'the checkout did not move');assert.equal(git(['status','--porcelain']),'','nor its index or tree');
 assert.match(fs.readFileSync(path.join(out,'plan.json'),'utf8'),new RegExp(`ensaio-\\d{8}-${H.slice(0,7)}-o11`),'the tag names the source');
});

test('--source refusals: on main, wrong parent, more than the fix, backends mode, no --only, no --fix, --commit and --source together',()=>{
 stopped(run(src(P,['--ensaio'])),/on the remote main: an image of main is built with --commit/);
 stopped(run(src(C,['--ensaio'])),/the parent of .* is .*, but the production commit of pair/);
 stopped(run(['--source',H,'--fix',T,'--mode','pairs','--only',only,'--ensaio']),/is not only the correction/);
 stopped(run(['--source',H,'--fix',C,'--only',only,'--ensaio']),/--mode pairs/);
 stopped(run(['--source',H,'--fix',C,'--mode','pairs','--ensaio']),/--only/);
 stopped(run(['--source',H,'--mode','pairs','--only',only,'--ensaio']),/--fix/);
 stopped(run(['--source',H,'--commit',T,'--fix',C]),/not both/);
 stopped(run(['--source',H,'--fix',`${C},${C}`,'--mode','pairs','--only',only,'--ensaio']),/names a correction twice/,'a --fix list reaches the rule');
});

test('production --source: needs --owner-key, refuses an unsigned or other-key source and tooling off main; accepts the owner-signed source',{skip:!keygen&&'no ssh-keygen'},()=>{
 const expect=['--expect-fix',C,'--expect-blob',`server/platforms/odc/facade/read-budget.mjs=${git(['rev-parse',`${H}:server/platforms/odc/facade/read-budget.mjs`]).trim()}`];
 stopped(run(src(Hs,['--release','r46'])),/--owner-key/);
 stopped(run(src(Hs,prod)),/--expect-fix .* and --expect-blob .* are required for a production image/);
 stopped(run(src(H,[...prod,...expect])),/is not signed by the owner's key/);
 stopped(run(src(Hs,['--release','r46','--owner-key',fwd(keys.other+'.pub'),...expect])),/is not signed by the owner's key/);
 stopped(run(src(Hs,[...prod,'--expect-fix',C,'--expect-blob','server/platforms/odc/facade/read-budget.mjs=c7ec887c'])),/not the reviewed c7ec887c/);
 stopped(run(src(Hs,[...prod,...expect])),/already exists locally/);
 git(['checkout','-q','-b','local-tooling']);put('server/x.txt','x\n');commit('not on main');
 try{stopped(run(src(Hs,[...prod,...expect])),/tooling checkout .* is not on the remote main/);}finally{git(['checkout','-q','main']);}
});

test('--commit: the signature is the owner\'s key, not %G? (an unsigned HEAD and another key refused)',{skip:!keygen&&'no ssh-keygen'},()=>{
 stopped(run(['--commit',T,'--mode','pairs','--only',only,...prod]),/already exists locally/);
 stopped(run(['--commit',T,'--mode','pairs','--only',only,'--release','r46','--owner-key',fwd(keys.other+'.pub')]),/is not signed by the owner's key other.pub/);
 git(['checkout','-q','-b','unsigned']);put('server/y.txt','y\n');const U=commit('unsigned');git(['update-ref','refs/remotes/origin/main',U]);
 try{stopped(run(['--commit',U,'--mode','pairs','--only',only,...prod]),/is not signed by the owner's key owner.pub/);}
 finally{git(['update-ref','refs/remotes/origin/main',T]);git(['checkout','-q','main']);}
});

test('--source: the pair images of this checkout must be origin/main\'s',()=>{
 const w=structuredClone(v);w.odc[0].sha256='f'.repeat(64);w.o11[0].sha256='f'.repeat(64);
 git(['checkout','-q','-b','other-pairs']);put('server/deploy/coolify/versions.json',JSON.stringify(w,null,2)+'\n');commit('other pairs');
 try{stopped(run(src(H,['--ensaio'])),/are not origin\/main's/);}finally{git(['checkout','-q','main']);}
});

test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
