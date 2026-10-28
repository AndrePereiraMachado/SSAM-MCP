// The real Git, PowerShell and file operations of the watcher, on throwaway repositories and folders: the proposal branch,
// the approval pin (publication simulated), the fast-forward of the watcher worktree, the bundle store, the Studio
// runtime detection and the Features.xml protection. No Docker, dotnet, Studio installation or network.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import {createRuntime,studioTfm} from './runtime.mjs';
import {approve,runVigia,readAttempts,pairTag,EnvironmentError,acquireLock} from './vigia.mjs';
const windows=process.platform==='win32';
const GIT='C:/Program Files/Git/cmd/git.exe',PS='C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const here=path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const server=path.resolve(here,'../..');
const sh=(cmd,args,cwd)=>{const r=spawnSync(cmd,args,{cwd,encoding:'utf8'});if(r.status!==0)throw Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);return r.stdout.trim();};
const git=(cwd,...args)=>sh(GIT,['-C',cwd,'-c','user.name=Test','-c','user.email=test@example.test',...args]);
const image='docker.io/andrepereiramachado/ssam-server';
const sha=c=>c.repeat(64);
const SNAPSHOT_DLL='C:/t/studio-bundles/o11-11.55.93/snapshot/files/ServiceStudio.Framework.dll';
function tempDir(t,prefix){const d=fs.mkdtempSync(path.join(os.tmpdir(),prefix));t.after(()=>{try{sh(GIT,['-C',d,'worktree','prune']);}catch{}fs.rmSync(d,{recursive:true,force:true});});return d;}
// A repository with the files the window commit needs, its main, and the watcher worktree on server/vigia-run.
function repo(t){
 const root=tempDir(t,'vigia-repo-'),main=path.join(root,'main'),ws=path.join(root,'vigia-run');
 for(const rel of ['deploy/coolify/versions.json','deploy/coolify/gen-compose.mjs','deploy/coolify/compose.template.json','deploy/coolify/gen-compose.test.mjs','deploy/coolify/initial-window.test.mjs','platforms/odc/facade/tests/fixtures/isolated-profile.mjs']){
  const to=path.join(main,'server',rel);fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(path.join(server,rel),to);
 }
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
 const heavy={preflight:async()=>{},dockerReady:async()=>{},targetFramework:async()=>null,bundle:async c=>side(c.lane,c.version),companion:async(l,v)=>side(l,v),
  test:async()=>({total:2,passed:2,failures:[]}),build:async pair=>({odc:pair.odc,o11:pair.o11,image,tag:pairTag(pair,'abc1234','20261028'),sha256:sha('a'),revision:'abc1234'}),smoke:async()=>({ok:true})},ops={...runtime,...heavy};
 const round=await runVigia({...config(r),manifest,observed:[{lane:'odc',version:'1.7.30',fullVersion:'1.7.30.10980'}],head:'h'},ops);
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
 const p2=await runVigia({...config(r2),manifest:rt2.manifest(),observed:[{lane:'odc',version:'1.7.30',fullVersion:'1.7.30.10980'}],head:'h'},{...rt2,...heavy});
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
});
test('the bundle store: a frozen copy per version, its checksum and Studio version checked, a gap is an environment problem',{skip:!windows||!fs.existsSync(SNAPSHOT_DLL)},async t=>{
 const r=repo(t),store=path.join(r.root,'store'),stage=path.join(r.root,'stage');
 fs.mkdirSync(path.join(stage,'files'),{recursive:true});fs.copyFileSync(SNAPSHOT_DLL,path.join(stage,'files/ServiceStudio.Framework.dll'));fs.writeFileSync(path.join(stage,'bundle.txt'),'schema ssam-studio-bundle/1\nlane o11\nversion 11.55.93.65289\n');
 const folder=path.join(store,'o11-11.55.93'),tar=path.join(folder,'o11-studio-11.55.93.65289.tar.gz');fs.mkdirSync(folder,{recursive:true});
 sh('C:/Windows/System32/tar.exe',['-czf',tar,'-C',stage,'bundle.txt','files']);
 const digest=createHash('sha256').update(fs.readFileSync(tar)).digest('hex');fs.writeFileSync(tar+'.sha256',`${digest}  ${path.basename(tar)}\n`);
 const runtime=await createRuntime(config(r));
 const c=await runtime.companion('o11','11.55.93');assert.equal(c.sha256,digest);assert.equal(c.fullVersion,'11.55.93.65289');assert.ok(fs.existsSync(path.join(c.snapshot,'ServiceStudio.Framework.dll')));assert.equal(c.tfm,null);
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
});
test('Features.plain.xml becomes a Features.xml this Windows user decrypts exactly as the ODC Studio export reads it',{skip:!windows},t=>{
 const dir=tempDir(t,'vigia-features-'),plain=path.join(dir,'Features.plain.xml');
 fs.writeFileSync(plain,'<?xml version="1.0" encoding="utf-8"?><Features><Feature Name="A" Enabled="true"/><Feature Name="B" Enabled="false"/></Features>');
 sh(PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'features-protect.ps1'),'-Plain',plain,'-OutDir',path.join(dir,'cache')]);
 const back=path.join(dir,'back.xml');
 sh(PS,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(server,'deploy/odc-features-export.ps1'),'-Source',path.join(dir,'cache/Features.xml'),'-Out',back]);
 assert.deepEqual(fs.readFileSync(back),fs.readFileSync(plain));assert.doesNotMatch(fs.readFileSync(path.join(dir,'cache/Features.xml'),'utf8'),/Feature Name/);
});
test('a second launcher finds the round lock and leaves at once',t=>{
 const dir=tempDir(t,'vigia-lock2-'),file=path.join(dir,'vigia.lock');const held=acquireLock(file);
 const r=spawnSync(process.execPath,['--input-type=module','-e',`import {acquireLock} from ${JSON.stringify(new URL('./host.mjs',import.meta.url).href)};console.log(JSON.stringify(acquireLock(${JSON.stringify(file)})));`],{encoding:'utf8'});
 assert.ok(JSON.parse(r.stdout).busy);held.release();
});
