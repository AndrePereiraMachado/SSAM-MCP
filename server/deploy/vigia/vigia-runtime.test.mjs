// The real Git, PowerShell and file operations of the watcher, on throwaway repositories and folders: the proposal branch,
// the approval pin (publication simulated), the fast-forward of the watcher worktree, the bundle store, the Studio
// runtime detection and the Features.xml protection. No Docker, dotnet, Studio installation or network.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {createRuntime,studioTfm,assemblyTfm,runtimePins} from './runtime.mjs';
import {approve,runVigia,readAttempts,pairTag,EnvironmentError,acquireLock,processStart} from './vigia.mjs';
import {configureJournals,readJournal} from './journal.mjs';
const windows=process.platform==='win32';
const GIT='C:/Program Files/Git/cmd/git.exe',PS='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const server=path.resolve(here,'../..');
const sh=(cmd,args,cwd)=>{const r=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(r.status!==0)throw Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);return r.stdout.trim();};
const git=(cwd,...args)=>sh(GIT,['-C',cwd,'-c','core.autocrlf=false','-c','user.name=Test','-c','user.email=test@example.test',...args]);
const image='docker.io/andrepereiramachado/ssam-server';
const sha=c=>c.repeat(64);
const SNAPSHOT_DLL='C:/t/studio-bundles/o11-11.55.93/snapshot/files/ServiceStudio.Framework.dll';
function tempDir(t,prefix){const d=fs.mkdtempSync(path.join(os.tmpdir(),prefix));t.after(()=>{try{sh(GIT,['-C',d,'worktree','prune']);}catch{}fs.rmSync(d,{recursive:true,force:true});});return d;}
// A repository with the files the window commit needs, its main, and the watcher worktree on server/vigia-run.
function repo(t){
 const root=tempDir(t,'vigia-repo-'),main=path.join(root,'main'),ws=path.join(root,'vigia-run');
 for(const rel of ['deploy/coolify/versions.json','deploy/coolify/gen-compose.mjs','deploy/coolify/compose.template.json','deploy/coolify/gen-compose.test.mjs','deploy/coolify/initial-window.test.mjs','deploy/odc-features-export.ps1','platforms/odc/facade/tests/fixtures/isolated-profile.mjs']){
  const to=path.join(main,'server',rel);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(server,rel),to);
 }
 // Legacy approval fixtures model the pre-R1 two-pair window explicitly.
 const mf=path.join(main,'server/deploy/coolify/versions.json'),m=JSON.parse(fs.readFileSync(mf,'utf8'));
 // By pair (tag), not by lane version: two served pairs may share a Service Studio (1.7.30 and 1.7.31 both on 11.55.94).
 const legacy=new Set(m.odc.filter(x=>x.version<'1.7.30').map(x=>x.tag).filter(tag=>m.o11.some(o=>o.tag===tag&&o.version<'11.55.94')));
 // keepServed (r44) counts the first pairs of the production window; the pre-R1 window predates it, so it has none.
 // The capacity pin of the production window (sizing.hotPair, 1.7.31) names a pair the legacy window does not have.
 m.odc=m.odc.filter(x=>legacy.has(x.tag));m.o11=m.o11.filter(x=>legacy.has(x.tag));delete m.keepServed;if(m.sizing)delete m.sizing.hotPair;fs.writeFileSync(mf,JSON.stringify(m));
 sh(GIT,['init','-q','-b','main',main]);git(main,'add','.');git(main,'commit','-q','-m','base');
 git(main,'worktree','add','-q','-b','server/vigia-run',ws,'main');
 return {root,main,ws,priv:path.join(root,'priv'),out:path.join(root,'out')};
}
const config=r=>({workspace:r.ws,tempRoot:r.priv,outDir:r.out,bundleRoot:path.join(r.root,'store'),notify:false,domains:{ssam:'mcp.example.test',console:'panel.example.test'}});
test('the proposal is a commit on its own branch; the watcher worktree never leaves its branch',{skip:!windows},async t=>{
 const r=repo(t);const runtime=await createRuntime(config(r));
 const base=JSON.parse(fs.readFileSync(path.join(r.ws,'server/deploy/coolify/versions.json'),'utf8'));
 const proposed={window:base.window,odc:[{version:'1.7.30',tag:'prod-x-o115594-odc1730',image},...base.odc].slice(0,base.window),o11:[{version:'11.55.94',tag:'prod-x-o115594-odc1730',image},...base.o11].slice(0,base.window)};
 const dir=path.join(r.out,'o11-11.55.94-odc-1.7.30');fs.mkdirSync(dir,{recursive:true});
 const p=await runtime.propose(proposed,'vigia/o11-11.55.94-odc-1.7.30',dir,'build(deploy): propose\n');
 assert.equal(p.branch,'vigia/o11-11.55.94-odc-1.7.30');assert.equal(git(r.main,'rev-parse','refs/heads/'+p.branch),p.commit);
 assert.equal(git(r.ws,'branch','--show-current'),'server/vigia-run');assert.equal(git(r.ws,'status','--porcelain'),'');
 const onBranch=JSON.parse(git(r.main,'show',p.commit+':server/deploy/coolify/versions.json'));assert.equal(onBranch.odc[0].version,'1.7.30');assert.equal(onBranch.odc[0].sha256,undefined);
 assert.match(git(r.main,'show',p.commit+':server/deploy/coolify/compose.coolify.yml'),/prod-x-o115594-odc1730/);
 assert.deepEqual(git(r.main,'show','--name-only','--format=',p.commit).split('\n').sort(),['server/deploy/coolify/compose.coolify.yml','server/deploy/coolify/versions.json']);
 assert.equal(fs.readdirSync(path.join(r.priv,'wt')).length,0,'the temporary worktree is removed');
 // A second proposal of the same pair (after a rejection) never moves the first branch.
 const again=await runtime.propose(proposed,'vigia/o11-11.55.94-odc-1.7.30',dir,'build(deploy): propose again\n');assert.equal(again.branch,'vigia/o11-11.55.94-odc-1.7.30-2');
});
test('-Approve with a simulated publication pins the digest on the proposal branch, runs the window tests and writes the owner files',{skip:!windows},async t=>{
 const r=repo(t);const runtime=await createRuntime(config(r));
 // A proposal exactly as a round leaves it, through the pipeline with fake heavy operations and the real propose.
 const manifest=runtime.manifest(),features=path.join(r.root,'Features.plain.xml');fs.writeFileSync(features,'<Features/>');
 const side=(lane,v)=>({lane,version:v,fullVersion:v+'.1',file:`${lane}.tar.gz`,sha256:sha('9'),snapshot:'x',features:lane==='odc'?features:null});
 const heavy={preflight:async()=>{},dockerReady:async()=>{},targetFramework:async c=>c.tfm,bundle:async c=>side(c.lane,c.version),companion:async(l,v)=>side(l,v),
  test:async()=>({total:2,passed:2,failures:[]}),build:async pair=>({odc:pair.odc,o11:pair.o11,image,tag:pairTag(pair,'abc1234','20261028'),sha256:sha('a'),revision:'abc1234'}),smoke:async()=>({ok:true})},ops={...runtime,...heavy};
 const round=await runVigia({...config(r),manifest,observed:[{lane:'odc',version:'1.7.30',fullVersion:'1.7.30.10980',studio:'C:/fake/odc',tfm:'net8.0'}],head:'h'},ops);
 assert.equal(round.status,'proposed');
 const before=git(r.main,'rev-parse',round.branch);
 const published=[];
 const done=await approve(config(r),{...runtime,verifyLocalImage:async()=>{},publish:async b=>{published.push(b.tag);return {digest:'sha256:'+sha('a'),already:false};}},'odc-1.7.30');
 assert.deepEqual(published,['prod-20261028-abc1234-o115593-odc1730']);
 assert.equal(git(r.main,'rev-parse',round.branch+'~1'),before,'one pin commit on top of the proposal');
 const pinned=JSON.parse(git(r.main,'show',round.branch+':server/deploy/coolify/versions.json'));assert.equal(pinned.odc[0].sha256,sha('a'));assert.equal(pinned.o11[0].sha256,sha('a'));
 assert.match(git(r.main,'show',round.branch+':server/deploy/coolify/compose.coolify.yml'),new RegExp('ssam.image.digest[^\\n]*sha256:'+sha('a')));
 assert.match(git(r.main,'log','-1','--format=%s',round.branch),/^build\(deploy\): pin the image prod-20261028-abc1234-o115593-odc1730$/);
 assert.equal(git(r.ws,'branch','--show-current'),'server/vigia-run');
 for(const f of ['compose.coolify.literal.yml','compose.rollback.literal.yml','APROVADO.md'])assert.ok(fs.existsSync(path.join(round.dir,f)),f);
 assert.match(done.steps,/kernel write --version odc=1\.7\.30/);
 assert.equal(readAttempts(r.out)[round.id].status,'approved');
 // A moved proposal branch is refused before anything is published.
 const r2=repo(t);const rt2=await createRuntime(config(r2));
 const p2=await runVigia({...config(r2),manifest:rt2.manifest(),observed:[{lane:'odc',version:'1.7.30',fullVersion:'1.7.30.10980',studio:'C:/fake/odc',tfm:'net8.0'}],head:'h'},{...rt2,...heavy});
 git(r2.main,'branch','-f',p2.branch,'main');
 let pushed=false;await assert.rejects(approve(config(r2),{...rt2,verifyLocalImage:async()=>{},publish:async()=>{pushed=true;}},p2.id),/not the proposed commit/);assert.equal(pushed,false);
});
test('the watcher worktree fast-forwards from main and stops when it cannot',{skip:!windows},async t=>{
 const r=repo(t);const runtime=await createRuntime(config(r));
 assert.equal((await runtime.updateWorkspace('main')).updated,false);
 fs.writeFileSync(path.join(r.main,'server/new.txt'),'x');git(r.main,'add','.');git(r.main,'commit','-q','-m','main moves');
 const u=await runtime.updateWorkspace('main');assert.equal(u.updated,true);assert.equal(git(r.ws,'rev-parse','HEAD'),git(r.main,'rev-parse','main'));
 fs.writeFileSync(path.join(r.ws,'server/local.txt'),'y');git(r.ws,'add','.');git(r.ws,'commit','-q','-m','local');
 fs.writeFileSync(path.join(r.main,'server/other.txt'),'z');git(r.main,'add','.');git(r.main,'commit','-q','-m','main again');
 await assert.rejects(runtime.updateWorkspace('main'),/cannot fast-forward/);
 const primary=await createRuntime({...config(r),workspace:r.main});await assert.rejects(primary.updateWorkspace('main'),/dedicated Git worktree/);
 // A worktree edited by hand is an environment problem (the round waits and says so), never a failure of the pair.
 fs.appendFileSync(path.join(r.ws,'server/local.txt'),'edited');
 await assert.rejects(runtime.preflight(),e=>e instanceof EnvironmentError&&e.code==='workspace'&&/changes or untracked files \(server\/local\.txt\)/.test(e.message));
 // An untracked loose file would ship in the image (build.sh sends the tree): it stops the round too.
 git(r.ws,'checkout','--','server/local.txt');fs.writeFileSync(path.join(r.ws,'server/loose.txt'),'x');
 await assert.rejects(runtime.preflight(),e=>e.code==='workspace'&&/server\/loose\.txt/.test(e.message));
});
test('the bundle store: a frozen copy per version, its checksum and Studio version checked, a gap is an environment problem',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},async t=>{
 const r=repo(t),store=path.join(r.root,'store'),stage=path.join(r.root,'stage');
 fs.mkdirSync(path.join(stage,'files'),{recursive:true});fs.copyFileSync(SNAPSHOT_DLL,path.join(stage,'files/ServiceStudio.Framework.dll'));fs.writeFileSync(path.join(stage,'bundle.txt'),'schema ssam-studio-bundle/1\nlane o11\nversion 11.55.93.65289\n');
 const folder=path.join(store,'o11-11.55.93'),tar=path.join(folder,'o11-studio-11.55.93.65289.tar.gz');fs.mkdirSync(folder,{recursive:true});
 sh('C:/Windows/System32/tar.exe',['-czf',tar,'-C',stage,'bundle.txt','files']);
 const digest=createHash('sha256').update(fs.readFileSync(tar)).digest('hex');fs.writeFileSync(tar+'.sha256',`${digest}  ${path.basename(tar)}\n`);
 const runtime=await createRuntime(config(r));
 const c=await runtime.companion('o11','11.55.93');assert.equal(c.sha256,digest);assert.equal(c.fullVersion,'11.55.93.65289');assert.ok(fs.existsSync(path.join(c.snapshot,'ServiceStudio.Framework.dll')));assert.equal(c.tfm,'net8.0','from the Studio assembly when the copy has no runtimeconfig.json');
 assert.equal((await runtime.companion('o11','11.55.93')).snapshot,c.snapshot,'an existing frozen copy is reused');
 // A snapshot folder someone else left (another layout, another build) is never renamed or overwritten.
 const other=path.join(r.root,'store2','o11-11.55.93');fs.mkdirSync(path.join(other,'snapshot'),{recursive:true});fs.writeFileSync(path.join(other,'snapshot','theirs.txt'),'keep');
 for(const f of [tar,tar+'.sha256'])fs.copyFileSync(f,path.join(other,path.basename(f)));
 const c2=await (await createRuntime({...config(r),bundleRoot:path.join(r.root,'store2')})).companion('o11','11.55.93');
 assert.equal(path.basename(path.dirname(c2.snapshot)),'snapshot-11.55.93.65289');assert.equal(fs.readFileSync(path.join(other,'snapshot','theirs.txt'),'utf8'),'keep');
 await assert.rejects(runtime.companion('odc','1.7.29'),e=>e instanceof EnvironmentError&&e.code==='store-incomplete');
 await assert.rejects(createRuntime({...config(r),bundlePins:{'o11-11.55.93':sha('0')}}).then(x=>x.companion('o11','11.55.93')),/not the pinned one/);
 fs.writeFileSync(tar+'.sha256',`${sha('0')}  x\n`);await assert.rejects(runtime.companion('o11','11.55.93'),/does not match/);
});
test('detection records the .NET of each Studio folder: a synthetic net10 Studio',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},t=>{
 const dir=tempDir(t,'vigia-net10-');fs.copyFileSync(SNAPSHOT_DLL,path.join(dir,'ServiceStudio.Framework.dll'));
 fs.writeFileSync(path.join(dir,'ServiceStudio.runtimeconfig.json'),JSON.stringify({runtimeOptions:{tfm:'net10.0',includedFrameworks:[{name:'Microsoft.NETCore.App',version:'10.0.13'}]}}));
 const out=JSON.parse(sh(PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'detect-studios.ps1'),'-O11',dir]));
 assert.deepEqual(out.map(o=>[o.lane,o.version,o.tfm]),[['o11','11.55.93','net10.0']]);assert.equal(studioTfm(dir,'o11'),'net10.0');
 fs.rmSync(path.join(dir,'ServiceStudio.runtimeconfig.json'));
 assert.equal(JSON.parse(sh(PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'detect-studios.ps1'),'-O11',dir]))[0].tfm,null);
 // A frozen copy without runtimeconfig.json: the build rule refuses to guess, so the test build gets the documented pin
 // with the framework the Studio's own assembly declares (.NETCoreApp,Version=v8.0 for 11.55.93); with the file, no pin.
 assert.equal(assemblyTfm(dir),'net8.0');
 assert.deepEqual(runtimePins({o11:{snapshot:dir},odc:{snapshot:dir}}),['-p:AnvilOdcStudioTfm=net8.0','-p:AnvilO11StudioTfm=net8.0']);
 fs.writeFileSync(path.join(dir,'ServiceStudio.runtimeconfig.json'),JSON.stringify({runtimeOptions:{tfm:'net10.0'}}));
 assert.deepEqual(runtimePins({o11:{snapshot:dir}}),[]);
});
test('Features.plain.xml becomes a Features.xml this Windows user decrypts exactly as the ODC Studio export reads it',{skip:!windows},t=>{
 const dir=tempDir(t,'vigia-features-'),plain=path.join(dir,'Features.plain.xml');
 fs.writeFileSync(plain,'<?xml version="1.0" encoding="utf-8"?><Features><Feature Name="A" Enabled="true"/><Feature Name="B" Enabled="false"/></Features>');
 sh(PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'features-protect.ps1'),'-Plain',plain,'-OutDir',path.join(dir,'cache')]);
 const back=path.join(dir,'back.xml');
 sh(PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(server,'deploy/odc-features-export.ps1'),'-Source',path.join(dir,'cache/Features.xml'),'-Out',back]);
 assert.deepEqual(fs.readFileSync(back),fs.readFileSync(plain));assert.doesNotMatch(fs.readFileSync(path.join(dir,'cache/Features.xml'),'utf8'),/Feature Name/);
});
test('publication goes through the real publish.sh (never --latest) and reads the pushed digest; an already published tag of the same digest is accepted',{skip:!windows||!fs.existsSync('C:/Program Files/Git/bin/bash.exe')},async t=>{
 const r=repo(t),bin=path.join(r.root,'bin'),calls=path.join(r.root,'docker-calls.txt');fs.mkdirSync(bin,{recursive:true});
 for(const rel of ['deploy/publish.sh']){const to=path.join(r.ws,'server',rel);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(server,rel),to);}
 const digest='sha256:'+sha('e'),registry='registry.example.test/ns/ssam-server';
 // A docker that records its arguments; "exists" makes the registry already hold the tag.
 fs.writeFileSync(path.join(bin,'docker'),`#!/bin/sh\n[ "$1" = "--context" ] && shift 2\necho "$*" >> '${calls.replaceAll('\\','/')}'\ncase "$1 $2" in\n "image inspect") case "$*" in *revision*) echo abc1234 ;; esac; exit 0 ;;\n "manifest inspect") [ -f '${path.join(r.root,'exists').replaceAll('\\','/')}' ] && exit 0; exit 1 ;;\n "buildx imagetools") echo "Name: x"; echo "Digest: ${digest}"; exit 0 ;;\n "tag "*) exit 0 ;;\n "push "*) echo "prod-x: digest: ${digest} size: 1234"; exit 0 ;;\nesac\nexit 0\n`);
 const runtime=await createRuntime({...config(r),docker:path.join(bin,'docker.exe')});
 const first=await runtime.publish({image:registry,tag:'prod-x-o115594-odc1730',odc:'1.7.30',o11:'11.55.94'});
 assert.deepEqual(first,{digest,already:false});
 const log=fs.readFileSync(calls,'utf8');assert.match(log,/push registry\.example\.test\/ns\/ssam-server:prod-x-o115594-odc1730/);assert.doesNotMatch(log,/:latest/);
 fs.writeFileSync(path.join(r.root,'exists'),'');
 assert.deepEqual(await runtime.publish({image:registry,tag:'prod-x-o115594-odc1730',odc:'1.7.30',o11:'11.55.94'}),{digest,already:true});
});
test('a round whose fetched code does not load still leaves a log line and a notice',t=>{
 const root=tempDir(t,'vigia-broken-'),ws=path.join(root,'ws'),out=path.join(root,'out');
 fs.mkdirSync(path.join(ws,'server/deploy/vigia'),{recursive:true});
 fs.writeFileSync(path.join(ws,'server/deploy/vigia/vigia.mjs'),"// ROUND_PROTOCOL=2\nthrow new Error('broken main');\n");
 const cfg=path.join(root,'config.json');fs.writeFileSync(cfg,JSON.stringify({workspace:ws,tempRoot:path.join(root,'priv'),outDir:out,bundleRoot:path.join(root,'store'),notify:false,automatic:false}));
 const r=spawnSync(process.execPath,[path.join(here,'vigia.mjs'),'--config',cfg,'--no-update'],{encoding:'utf8'});
 const day=fs.readdirSync(path.join(out,'runs'))[0],log=fs.readFileSync(path.join(out,'runs',day,fs.readdirSync(path.join(out,'runs',day))[0]),'utf8');
 assert.match(log,/round process exited 1 without finishing its round: .*broken main/s);
 assert.ok(JSON.parse(fs.readFileSync(path.join(out,'reminders.json'),'utf8'))['round-exit']);
 assert.equal(fs.existsSync(path.join(out,'vigia.lock')),false,'the lock is released');assert.equal(r.status,1,'the scheduler sees the failed round');
});
// A store folder with a real tar (bundle.txt + files/ServiceStudio.Framework.dll of the O11 snapshot) for lane/version.
function storeTar(root,lane,v,full){
 const stage=path.join(root,'stage-'+lane+v);fs.mkdirSync(path.join(stage,'files'),{recursive:true});
 fs.copyFileSync(SNAPSHOT_DLL,path.join(stage,'files/ServiceStudio.Framework.dll'));fs.writeFileSync(path.join(stage,'bundle.txt'),`schema ssam-studio-bundle/1\nlane ${lane}\nversion ${full}\n`);
 const folder=path.join(root,'store',`${lane}-${v}`),tar=path.join(folder,`${lane}-studio-${full}.tar.gz`);fs.mkdirSync(folder,{recursive:true});
 sh('C:/Windows/System32/tar.exe',['-czf',tar,'-C',stage,'bundle.txt','files']);
 fs.writeFileSync(tar+'.sha256',`${createHash('sha256').update(fs.readFileSync(tar)).digest('hex')}  ${path.basename(tar)}\n`);
 return {folder,tar};
}
const cache=(dir,version)=>{const plain=path.join(dir,`plain-${version}.xml`);fs.writeFileSync(plain,`<?xml version="1.0" encoding="utf-16"?>\n<Features Version="${version}">\n  <Feature key="0f8fad5b-d9cb-469f-a165-70867728950e" kind="String">UseCodeDefault</Feature>\n</Features>`);
 sh(PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'features-protect.ps1'),'-Plain',plain,'-OutDir',path.join(dir,'cache-'+version)]);return path.join(dir,'cache-'+version,'Features.xml');};
test('M1/M5: the features of a new ODC version are stored only when the cache is for that version, and only in the private root',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},async t=>{
 const r=repo(t);const {folder}=storeTar(r.root,'odc','1.7.30','1.7.30.1');
 const featuresRoot=path.join(r.priv,'features'),candidate={lane:'odc',version:'1.7.30',fullVersion:'1.7.30.1',studio:path.join(r.root,'no-studio'),tfm:'net10.0'};
 const fresh=await createRuntime({...config(r),featuresRoot,featuresSource:cache(r.root,'1.7.30.1')});
 const b=await fresh.bundle(candidate,path.join(r.out,'x'));
 assert.equal(b.features,path.join(featuresRoot,'odc-1.7.30','Features.plain.xml'));assert.match(fs.readFileSync(b.features,'utf8'),/Version="1\.7\.30\.1"/);
 assert.equal(b.featuresProvenance.mode,'exact');assert.equal(b.featuresProvenance.source.kind,'export');
 assert.equal(fs.existsSync(path.join(folder,'Features.plain.xml')),false,'never under the bundle store (C:/t)');
 await assert.rejects(createRuntime({...config(r),featuresRoot:'C:/t/x'}),/featuresRoot must be private/);
 // A legacy store file of another version is never copied under this one; with no exact file anywhere the lane waits.
 fs.writeFileSync(path.join(r.root,'store','odc-1.7.30','Features.plain.xml'),'<Features Version="1.7.28.10850"/>');fs.rmSync(path.join(featuresRoot,'odc-1.7.30'),{recursive:true});
 const plain=await createRuntime({...config(r),featuresRoot});
 await assert.rejects(plain.bundle(candidate,path.join(r.out,'x')),e=>e.code==='features-unavailable'&&e.lanes[0]==='odc');
 assert.equal(fs.existsSync(path.join(featuresRoot,'odc-1.7.30')),false);
 // One of the right version (another session's) is copied into the private root as exact and used; the store file is left as is.
 fs.writeFileSync(path.join(r.root,'store','odc-1.7.30','Features.plain.xml'),'<Features Version="1.7.30.1"/>');
 const copied=await plain.bundle(candidate,path.join(r.out,'x'));
 assert.equal(copied.features,path.join(featuresRoot,'odc-1.7.30','Features.plain.xml'));assert.equal(copied.featuresProvenance.source.kind,'legacy-store');
 assert.equal(fs.readFileSync(path.join(r.root,'store','odc-1.7.30','Features.plain.xml'),'utf8'),'<Features Version="1.7.30.1"/>');
});
// Synthetic ODC features of a full version (no tenant data), and a private store holding one as a folder of the watcher
// before provenance existed (recorded as exact at its first use).
const KEY=Buffer.alloc(32,7).toString('base64');
const fkey=i=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
const plainFeatures=(full,n=3)=>`<?xml version="1.0" encoding="utf-16"?>\r\n<Features Version="${full}">\r\n${Array.from({length:n},(_,i)=>`  <Feature key="${fkey(i+1)}" kind="Boolean">True</Feature>`).join('\r\n')}\r\n</Features>`;
function exactIn(featuresRoot,v,full){const dir=path.join(featuresRoot,'odc-'+v);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'Features.plain.xml'),plainFeatures(full));return path.join(dir,'Features.plain.xml');}
const odcCandidate=(r,v,full)=>{storeTar(r.root,'odc',v,full);return {lane:'odc',version:v,fullVersion:full,studio:path.join(r.root,'no-studio'),tfm:'net10.0'};};
const provenanceOf=(featuresRoot,v)=>readJournal(path.join(featuresRoot,'odc-'+v,'features.provenance.json'),{automatic:true});
const bytesSha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('a new ODC version without its own cache gets the nearest exact features carried, with a signed provenance',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},async t=>{
 const r=repo(t),featuresRoot=path.join(r.priv,'features');configureJournals(featuresRoot,KEY);
 const source=exactIn(featuresRoot,'1.7.30','1.7.30.10980'),candidate=odcCandidate(r,'1.7.31','1.7.31.20000');
 // featuresSource holds the cache of the Studio that ran last (1.7.30), not of the candidate.
 const runtime=await createRuntime({...config(r),featuresRoot,featuresSource:cache(r.root,'1.7.30.10980')});
 const b=await runtime.bundle(candidate,path.join(r.out,'x'));
 assert.equal(b.features,path.join(featuresRoot,'odc-1.7.31','Features.plain.xml'));
 assert.ok(fs.readFileSync(b.features).equals(fs.readFileSync(source)),'a byte copy of the exact 1.7.30 file');
 const p=provenanceOf(featuresRoot,'1.7.31');
 assert.equal(p.schema,'ssam-odc-features/1');assert.equal(p.version,'1.7.31');assert.equal(p.mode,'carried');assert.equal(p.chain,1);assert.equal(p.sha256,bytesSha(b.features));assert.equal(p.fileVersion,'1.7.30.10980');
 assert.deepEqual({...p.source,from:{...p.source.from,recordedAt:undefined}},{kind:'carry',from:{version:'1.7.30',fullVersion:'1.7.30.10980',sha256:bytesSha(source),kind:'legacy',recordedAt:undefined},direction:'forward'});
 assert.match(p.drift.unknown,/ServiceStudio\.Common\.dll/,'the test snapshot has no ODC assemblies: the drift says so and nothing blocks');
 assert.equal(provenanceOf(featuresRoot,'1.7.30').mode,'exact','the source is recorded as exact');
 assert.deepEqual(b.featuresProvenance,{version:'1.7.31',mode:'carried',sha256:p.sha256,fileVersion:'1.7.30.10980',source:p.source,chain:1,recordedAt:p.recordedAt,drift:{unknown:p.drift.unknown,fileKeys:3}});
 // The same round again uses what was recorded.
 assert.equal((await runtime.bundle(candidate,path.join(r.out,'x'))).featuresProvenance.sha256,p.sha256);
});
test('a cache of another version is stored as that version\'s exact features, never as the candidate\'s',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},async t=>{
 const r=repo(t),featuresRoot=path.join(r.priv,'features');configureJournals(featuresRoot,KEY);
 const candidate=odcCandidate(r,'1.7.31','1.7.31.20000');
 const runtime=await createRuntime({...config(r),featuresRoot,featuresSource:cache(r.root,'1.7.30.10980')});
 const b=await runtime.bundle(candidate,path.join(r.out,'x'));
 const p30=provenanceOf(featuresRoot,'1.7.30');
 assert.equal(p30.mode,'exact');assert.equal(p30.fileVersion,'1.7.30.10980');assert.equal(p30.source.kind,'export');
 assert.match(fs.readFileSync(path.join(featuresRoot,'odc-1.7.30','Features.plain.xml'),'utf8'),/Version="1\.7\.30\.10980"/);
 assert.equal(provenanceOf(featuresRoot,'1.7.31').mode,'carried','the candidate gets a carried copy, never the cache as its own');
 assert.equal(b.featuresProvenance.source.from.version,'1.7.30');
 // A later cache of 1.7.30 changes nothing: the folder of 1.7.30 exists.
 const before=fs.readFileSync(path.join(featuresRoot,'odc-1.7.30','Features.plain.xml'));
 const again=await createRuntime({...config(r),featuresRoot,featuresSource:cache(r.root,'1.7.30.10999')});
 await again.bundle(odcCandidate(r,'1.7.32','1.7.32.1'),path.join(r.out,'y'));
 assert.ok(fs.readFileSync(path.join(featuresRoot,'odc-1.7.30','Features.plain.xml')).equals(before));
});
test('an exact cache for the version supersedes a carried one at the next round; an exact one is never replaced',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},async t=>{
 const r=repo(t),featuresRoot=path.join(r.priv,'features');configureJournals(featuresRoot,KEY);
 exactIn(featuresRoot,'1.7.30','1.7.30.10980');const candidate=odcCandidate(r,'1.7.31','1.7.31.20000');
 const first=await (await createRuntime({...config(r),featuresRoot})).bundle(candidate,path.join(r.out,'x'));
 assert.equal(first.featuresProvenance.mode,'carried');const carried=first.featuresProvenance.sha256;
 const second=await (await createRuntime({...config(r),featuresRoot,featuresSource:cache(r.root,'1.7.31.20000')})).bundle(candidate,path.join(r.out,'x'));
 assert.equal(second.featuresProvenance.mode,'exact');assert.equal(second.featuresProvenance.fileVersion,'1.7.31.20000');assert.equal(second.features,first.features);
 assert.match(fs.readFileSync(second.features,'utf8'),/Version="1\.7\.31\.20000"/);
 const old=path.join(featuresRoot,'odc-1.7.31','superseded',carried.slice(0,8));
 assert.equal(bytesSha(path.join(old,'Features.plain.xml')),carried,'the carried file is kept aside');
 const kept=readJournal(path.join(old,'features.provenance.json'),{automatic:true});assert.equal(kept.mode,'carried');assert.equal(kept.supersededBy,second.featuresProvenance.sha256);
 // Another export of the same version never replaces the exact file.
 const third=await (await createRuntime({...config(r),featuresRoot,featuresSource:cache(r.root,'1.7.31.20001')})).bundle(candidate,path.join(r.out,'x'));
 assert.equal(third.featuresProvenance.sha256,second.featuresProvenance.sha256);assert.match(fs.readFileSync(third.features,'utf8'),/Version="1\.7\.31\.20000"/);
});
test('features whose bytes changed after they were recorded are refused (custody)',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},async t=>{
 const r=repo(t),featuresRoot=path.join(r.priv,'features');configureJournals(featuresRoot,KEY);
 const source=exactIn(featuresRoot,'1.7.30','1.7.30.10980'),candidate=odcCandidate(r,'1.7.31','1.7.31.20000');
 const runtime=await createRuntime({...config(r),featuresRoot});const b=await runtime.bundle(candidate,path.join(r.out,'x'));
 const bytes=fs.readFileSync(b.features),changed=Buffer.concat([bytes,Buffer.from(' ')]);
 // A test run checks the bytes again before it uses them (before any dotnet).
 fs.writeFileSync(b.features,changed);
 await assert.rejects(runtime.test('odc','candidate',{odc:b,o11:{snapshot:'x'}},path.join(r.out,'x')),e=>e.code==='store-mismatch'&&/nothing was used or changed/i.test(e.message));
 await assert.rejects(runtime.bundle(candidate,path.join(r.out,'x')),e=>e.code==='store-mismatch'&&e.lanes[0]==='odc'&&/review the features store; nothing was used or changed/i.test(e.message));
 assert.ok(fs.readFileSync(b.features).equals(changed),'nothing was changed');
 // A provenance edited by hand fails its MAC.
 fs.writeFileSync(b.features,bytes);const prov=path.join(featuresRoot,'odc-1.7.31','features.provenance.json'),recorded=fs.readFileSync(prov,'utf8'),journal=JSON.parse(recorded);
 journal.value.mode='exact';fs.writeFileSync(prov,JSON.stringify(journal));
 await assert.rejects(runtime.bundle(candidate,path.join(r.out,'x')),e=>e.code==='store-mismatch'&&/does not verify/.test(e.message));
 fs.writeFileSync(prov,recorded);
 // An exact source that changed is never carried.
 fs.appendFileSync(source,' ');
 await assert.rejects(runtime.bundle(odcCandidate(r,'1.7.32','1.7.32.1'),path.join(r.out,'y')),e=>e.code==='store-mismatch'&&e.message.includes(path.join(featuresRoot,'odc-1.7.30')));
 assert.equal(fs.existsSync(path.join(featuresRoot,'odc-1.7.32')),false);
});
test('without any exact features the lane waits with the seed instruction; with featuresDefaultsFallback it gets a defaults-only file marked defaults',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},async t=>{
 const r=repo(t),featuresRoot=path.join(r.priv,'features');configureJournals(featuresRoot,KEY);
 const candidate=odcCandidate(r,'1.7.31','1.7.31.20000');
 await assert.rejects((await createRuntime({...config(r),featuresRoot,featuresSource:path.join(r.root,'no-cache','Features.xml')})).bundle(candidate,path.join(r.out,'x')),
  e=>e instanceof EnvironmentError&&e.code==='features-unavailable'&&e.lanes[0]==='odc'&&/No exact ODC features exist to carry; seed one once with vigia\.ps1 -SeedFeatures <Features\.plain\.xml>\./.test(e.message)&&!/Open ODC Studio/.test(e.message));
 assert.equal(fs.existsSync(path.join(featuresRoot,'odc-1.7.31')),false,'nothing stored');
 const b=await (await createRuntime({...config(r),featuresRoot,featuresDefaultsFallback:true})).bundle(candidate,path.join(r.out,'x'));
 assert.equal(fs.readFileSync(b.features,'utf8'),'<Features Version="1.7.31.20000"/>');
 assert.equal(b.featuresProvenance.mode,'defaults');assert.equal(provenanceOf(featuresRoot,'1.7.31').source.kind,'defaults');
 // Once an exact file exists, the defaults-only file gives way to a carried one (kept aside).
 exactIn(featuresRoot,'1.7.30','1.7.30.10980');
 const c=await (await createRuntime({...config(r),featuresRoot,featuresDefaultsFallback:true})).bundle(candidate,path.join(r.out,'x'));
 assert.equal(c.featuresProvenance.mode,'carried');assert.ok(fs.existsSync(path.join(featuresRoot,'odc-1.7.31','superseded',b.featuresProvenance.sha256.slice(0,8),'Features.plain.xml')));
});
test('a carried file is never used as a carry source',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},async t=>{
 const r=repo(t),featuresRoot=path.join(r.priv,'features');configureJournals(featuresRoot,KEY);
 exactIn(featuresRoot,'1.7.29','1.7.29.10940');
 const runtime=await createRuntime({...config(r),featuresRoot});
 const b30=await runtime.bundle(odcCandidate(r,'1.7.30','1.7.30.10980'),path.join(r.out,'x'));
 assert.equal(b30.featuresProvenance.mode,'carried');assert.equal(b30.featuresProvenance.source.from.version,'1.7.29');
 const b31=await runtime.bundle(odcCandidate(r,'1.7.31','1.7.31.20000'),path.join(r.out,'x'));
 assert.equal(b31.featuresProvenance.source.from.version,'1.7.29','the exact 1.7.29, never the carried 1.7.30');assert.equal(b31.featuresProvenance.chain,2);
 assert.equal(b31.featuresProvenance.source.from.fullVersion,'1.7.29.10940');
 // With only carried files left, nothing is carried: the lane waits for a seed.
 fs.rmSync(path.join(featuresRoot,'odc-1.7.29'),{recursive:true});
 const c32=odcCandidate(r,'1.7.32','1.7.32.1');
 await assert.rejects(runtime.bundle(c32,path.join(r.out,'x')),e=>e.code==='features-unavailable');
 // Without a lower exact version, the nearest higher one is carried back.
 exactIn(featuresRoot,'1.7.33','1.7.33.5');
 const b32=await runtime.bundle(c32,path.join(r.out,'x'));
 assert.equal(b32.featuresProvenance.source.from.version,'1.7.33');assert.equal(b32.featuresProvenance.source.direction,'backward');assert.equal(b32.featuresProvenance.chain,1);
});
test('M4: a bundle of the candidate build that does not check out is never bundled over',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},async t=>{
 const r=repo(t);const {tar}=storeTar(r.root,'o11','11.55.94','11.55.94.1');const bytes=fs.readFileSync(tar);
 fs.writeFileSync(tar+'.sha256',`${sha('0')}  x\n`);
 const runtime=await createRuntime(config(r));const candidate={lane:'o11',version:'11.55.94',fullVersion:'11.55.94.1',studio:path.join(r.root,'no-studio'),tfm:'net10.0'};
 await assert.rejects(runtime.bundle(candidate,path.join(r.out,'x')),e=>e.code==='store-mismatch'&&e.lanes[0]==='o11'&&/nothing was bundled over/.test(e.message));
 assert.deepEqual(fs.readFileSync(tar),bytes,'the tar is untouched');assert.equal(fs.existsSync(path.join(path.dirname(tar),'snapshot')),false);
 fs.rmSync(tar+'.sha256');await assert.rejects(runtime.bundle(candidate,path.join(r.out,'x')),e=>e.code==='store-mismatch','a tar without its .sha256 (being written) waits');
 assert.deepEqual(fs.readFileSync(tar),bytes);
});
test('a pin committed before a crash is recognised on resume; the deploy folder of a commit is archived',{skip:!windows},async t=>{
 const r=repo(t);const runtime=await createRuntime(config(r));
 const base=runtime.manifest(),tag='prod-x-o115594-odc1730';
 const proposed={window:base.window,odc:[{version:'1.7.30',tag,image},...base.odc].slice(0,base.window),o11:[{version:'11.55.94',tag,image},...base.o11].slice(0,base.window)};
 const dir=path.join(r.out,'p');fs.mkdirSync(dir,{recursive:true});
 const p=await runtime.propose(proposed,'vigia/p',dir,'propose\n');
 assert.equal(await runtime.pinnedAt(p.branch,p.commit,tag,'sha256:'+sha('a')),null,'nothing pinned yet');
 const pinned=JSON.parse(JSON.stringify(proposed));for(const l of ['odc','o11'])pinned[l][0].sha256=sha('a');
 const {commit}=await runtime.pin(pinned,p.branch,dir,'pin\n');
 assert.equal(await runtime.pinnedAt(p.branch,p.commit,tag,'sha256:'+sha('a')),commit);assert.equal(await runtime.pinnedAt(p.branch,p.commit,tag,'sha256:'+sha('b')),null);
 const file=path.join(dir,'deploy.tar.gz');await runtime.archiveDeploy(commit,file);
 const list=sh('C:/Windows/System32/tar.exe',['-tzf',file]);assert.match(list,/server\/deploy\/coolify\/versions\.json/);assert.doesNotMatch(list,/platforms\//);
});
test('detection says what an installed Studio folder misses (an installation half-way)',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},t=>{
 const dir=tempDir(t,'vigia-incomplete-');fs.copyFileSync(SNAPSHOT_DLL,path.join(dir,'ServiceStudio.Framework.dll'));
 const out=JSON.parse(sh(PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'detect-studios.ps1'),'-O11',dir]))[0];
 assert.deepEqual(out.missing,['ServiceStudio.exe','ServiceStudio.runtimeconfig.json']);assert.equal(out.tfm,null);
 fs.writeFileSync(path.join(dir,'ServiceStudio.exe'),'');fs.writeFileSync(path.join(dir,'ServiceStudio.runtimeconfig.json'),JSON.stringify({runtimeOptions:{tfm:'net10.0'}}));
 assert.deepEqual(JSON.parse(sh(PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'detect-studios.ps1'),'-O11',dir]))[0].missing,[]);
});
test('the lock names a real process by its start time: the live launcher holds it, a dead or reused pid does not',{skip:!windows},t=>{
 const dir=tempDir(t,'vigia-ident-'),file=path.join(dir,'vigia.lock');
 const me=processStart(process.pid);assert.match(me,/^\d{4}-\d{2}-\d{2}T/);assert.equal(processStart(999999),null);
 const held=acquireLock(file);assert.ok(acquireLock(file).busy);held.release();
 fs.writeFileSync(file,JSON.stringify({pid:process.pid,started:'2000-01-01T00:00:00.000Z',token:'old',at:new Date().toISOString()}));
 const taken=acquireLock(file);assert.ok(taken.token,'same pid, another start time: another process');taken.release();
});
test('N1: after the cut a running command reports the cut, no command starts, and the notice still runs',{skip:!windows},async t=>{
 const r=repo(t);const runtime=await createRuntime(config(r));
 const slow=runtime.run(PS,['-NoProfile','-Command','Start-Sleep -Seconds 30'],{allowFailure:true});
 await new Promise(res=>setTimeout(res,1500));const started=Date.now();runtime.stopAll();
 await assert.rejects(slow,e=>e.code==='round-timeout');assert.ok(Date.now()-started<15000,'the command tree was killed, not awaited');
 await assert.rejects(runtime.run(GIT,['--version']),e=>e.code==='round-timeout');
 assert.equal(runtime.stopping,true);await runtime.notify('t','m');assert.match(fs.readFileSync(path.join(r.out,'notifications.jsonl'),'utf8'),/"title":"t"/);
});
test('a second launcher finds the round lock and leaves at once',t=>{
 const dir=tempDir(t,'vigia-lock2-'),file=path.join(dir,'vigia.lock');const held=acquireLock(file);
 const r=spawnSync(process.execPath,['--input-type=module','-e',`import {acquireLock} from ${JSON.stringify(new URL('./host.mjs',import.meta.url).href)};console.log(JSON.stringify(acquireLock(${JSON.stringify(file)})));`],{encoding:'utf8'});
 assert.ok(JSON.parse(r.stdout).busy);held.release();
});

test('automatic pin refuses a development code checkout before writing',{skip:!windows},async t=>{
 const r=repo(t),file=path.join(r.ws,'server/deploy/coolify/r1-kernels.json');
 fs.copyFileSync(path.join(server,'deploy/coolify/r1-kernels.json'),file);git(r.ws,'add','.');git(r.ws,'commit','-m','kernel fixture');
 const runtime=await createRuntime({...config(r),automatic:true,executionBranch:'server/vigia-run'});
 const base=runtime.manifest(),tag='prod-auto-o115594-odc1730',kernel={o11:'11.55.94',odc:'1.7.30',odcBridge:'v100',odcBridgeAccepted:['v100']};
 const manifest={window:3,odc:[{version:'1.7.30',image,tag,sha256:sha('a')},...base.odc],o11:[{version:'11.55.94',image,tag,sha256:sha('a')},...base.o11]};
 const dir=path.join(r.out,'pin');fs.mkdirSync(dir,{recursive:true});
 await assert.rejects(runtime.pinExecution(manifest,dir,'pair',kernel),/execution checkout/);
 assert.equal(git(r.ws,'status','--porcelain'),'');
});
test('every automatic private path, featuresRoot included, goes through the execution-trust check',{skip:!windows},async t=>{
 // child_process.spawn is replaced by a recorder (nothing runs): trust checks pass, git answers like a clean execution
 // branch, and the first other command stops executionSource. Restored at the end.
 const cp=(await import('node:child_process')).default,{syncBuiltinESMExports}=await import('node:module'),{EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream');
 const original=cp.spawn,seen=[];
 cp.spawn=(command,args)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.pid=1;child.kill=()=>{};
  const trust=args.findIndex(a=>/execution-trust\.ps1$/.test(String(a)));let out='',code=0;
  if(trust>=0)seen.push([args[trust+1],args[trust+2]]);
  else if(/git/i.test(path.basename(command))){const a=args.join(' ');if(/branch --show-current/.test(a))out='server/vigia-run\n';else if(/config --local/.test(a))code=1;else if(!/status --porcelain/.test(a))code=1;}
  else code=1;
  setImmediate(()=>{child.stdout.end(out);child.stderr.end('');child.emit('close',code);});return child;
 };
 syncBuiltinESMExports();t.after(()=>{cp.spawn=original;syncBuiltinESMExports();});
 const dir=tempDir(t,'vigia-trust-'),exe=process.execPath;
 const base={workspace:path.resolve(server,'..'),tempRoot:path.join(dir,'tmp'),outDir:path.join(dir,'out'),bundleRoot:path.join(dir,'store'),installersDir:path.join(dir,'installers'),configFile:path.join(dir,'config.json'),vault:path.join(dir,'vault'),
  automatic:true,dryRun:true,notify:false,node:exe,python:exe,dotnet:exe,git:GIT,bash:exe,powershell:exe,tar:exe,docker:exe,sshKeygen:exe,automaticDeployment:{ssh:{executable:exe}}};
 const privatePaths=()=>seen.filter(([kind])=>kind==='-PrivatePaths').map(([,p])=>path.resolve(p).toLowerCase());
 // A featuresRoot outside tempRoot (existing) is checked like every other private path.
 const outside=path.join(dir,'elsewhere','features');fs.mkdirSync(outside,{recursive:true});
 await (await createRuntime({...base,featuresRoot:outside})).executionSource().catch(()=>{});
 assert.ok(privatePaths().includes(path.resolve(outside).toLowerCase()),`checked: ${privatePaths().join(', ')}`);
 const {automaticPrivatePaths}=await import('./runtime.mjs');
 assert.deepEqual(privatePaths(),automaticPrivatePaths({...base,featuresRoot:outside}).map(p=>path.resolve(p).toLowerCase()),'exactly the declared list');
 // A missing featuresRoot outside C:\ssam-priv is refused before anything is created or checked.
 seen.length=0;const missing=path.join(dir,'missing','features');
 await assert.rejects((await createRuntime({...base,featuresRoot:missing})).executionSource(),/featuresRoot must be inside C:\\ssam-priv in automatic mode/);
 assert.equal(fs.existsSync(path.join(dir,'missing')),false,'nothing created');assert.deepEqual(privatePaths(),[]);
 // Without featuresRoot the list names tempRoot/features, resolved.
 assert.equal(automaticPrivatePaths(base).at(-1),path.resolve(base.tempRoot,'features'));
});
test('featuresRoot is created only after its parent passed the execution-trust check',{skip:!windows},async t=>{
 // child_process.spawn is a recorder (trust checks pass, git answers like a clean execution branch, the first other
 // command stops executionSource) and fs.mkdirSync records a folder under C:\ssam-priv without creating it. Both are
 // restored at the end; nothing is written under C:\ssam-priv.
 const cp=(await import('node:child_process')).default,{syncBuiltinESMExports}=await import('node:module'),{EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream'),{randomUUID}=await import('node:crypto');
 const originalSpawn=cp.spawn,originalMkdir=fs.mkdirSync,order=[];
 const inPrivate=p=>/^c:[\\/]ssam-priv[\\/]/i.test(path.resolve(String(p)));
 cp.spawn=(command,args)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.pid=1;child.kill=()=>{};
  const trust=args.findIndex(a=>/execution-trust\.ps1$/.test(String(a)));let out='',code=0;
  if(trust>=0)order.push(`${args[trust+1]} ${path.resolve(args[trust+2]).toLowerCase()}`);
  else if(/git/i.test(path.basename(command))){const a=args.join(' ');if(/branch --show-current/.test(a))out='server/vigia-run\n';else if(/config --local/.test(a))code=1;else if(!/status --porcelain/.test(a))code=1;}
  else code=1;
  setImmediate(()=>{child.stdout.end(out);child.stderr.end('');child.emit('close',code);});return child;
 };
 fs.mkdirSync=(target,options)=>{if(inPrivate(target)){order.push(`mkdir ${path.resolve(String(target)).toLowerCase()}`);return undefined;}return originalMkdir(target,options);};
 syncBuiltinESMExports();t.after(()=>{cp.spawn=originalSpawn;fs.mkdirSync=originalMkdir;syncBuiltinESMExports();});
 const dir=tempDir(t,'vigia-trust3-'),exe=process.execPath,lower=p=>path.resolve(p).toLowerCase();
 const base={workspace:path.resolve(server,'..'),outDir:path.join(dir,'out'),bundleRoot:path.join(dir,'store'),installersDir:path.join(dir,'installers'),configFile:path.join(dir,'config.json'),vault:path.join(dir,'vault'),
  automatic:true,dryRun:true,notify:false,node:exe,python:exe,dotnet:exe,git:GIT,bash:exe,powershell:exe,tar:exe,docker:exe,sshKeygen:exe,automaticDeployment:{ssh:{executable:exe}}};
 // The default featuresRoot (tempRoot\features, missing): created after tempRoot passed and before it is checked itself.
 const tempRoot=`C:/ssam-priv/vigia-test-${randomUUID()}/tmp`,features=path.join(tempRoot,'features');
 assert.equal(fs.existsSync(path.dirname(tempRoot)),false,'a fresh name under C:\\ssam-priv');
 await (await createRuntime({...base,tempRoot})).executionSource().catch(()=>{});
 const at=entry=>order.indexOf(entry);
 assert.ok(at(`mkdir ${lower(features)}`)>=0,`order: ${order.join(' | ')}`);
 assert.ok(at(`-PrivatePaths ${lower(tempRoot)}`)>=0&&at(`-PrivatePaths ${lower(tempRoot)}`)<at(`mkdir ${lower(features)}`),'tempRoot is checked before featuresRoot is created');
 assert.ok(at(`mkdir ${lower(features)}`)<at(`-PrivatePaths ${lower(features)}`),'featuresRoot is checked after it is created');
 assert.equal(order.filter(e=>e.startsWith('mkdir ')).length,1,'one component, not a recursive creation');
 // A missing featuresRoot whose parent is none of the checked paths: refused, nothing created.
 order.length=0;const elsewhere=`C:/ssam-priv/vigia-test-${randomUUID()}/features`;
 await assert.rejects((await createRuntime({...base,tempRoot:path.join(dir,'tmp'),featuresRoot:elsewhere})).executionSource(),/Create featuresRoot inside a checked private path \(for example tempRoot\\features\); nothing was created\./);
 assert.deepEqual(order.filter(e=>e.startsWith('mkdir ')),[],'no mkdir');assert.equal(fs.existsSync(path.dirname(elsewhere)),false);
 assert.ok(!order.includes(`-PrivatePaths ${lower(elsewhere)}`));
 // A link on the way is never followed: a junction below a checked path stops the creation.
 order.length=0;const checked=path.join(dir,'checked'),target=path.join(dir,'target');originalMkdir(checked,{recursive:true});originalMkdir(target,{recursive:true});
 fs.symlinkSync(target,path.join(checked,'link'),'junction');
 const {createBelowChecked}=await import('./runtime.mjs');
 assert.throws(()=>createBelowChecked(path.join(checked,'link','features'),[checked]),/is a link or not a folder; featuresRoot was not created/);
 assert.equal(fs.existsSync(path.join(target,'features')),false,'nothing created through the junction');
});
