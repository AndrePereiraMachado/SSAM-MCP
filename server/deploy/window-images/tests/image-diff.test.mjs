// image-diff.test.mjs: a correction image against the production image (trilha D, the X1 window), offline (fake lists).
//   node --test deploy/window-images/tests/image-diff.test.mjs
import test from 'node:test';import assert from 'node:assert/strict';import cp from 'node:child_process';
import {compareImages,parseList,readImage,LIST,SKIP,COMPILED,OUTSIDE_FILES} from '../image-diff.mjs';
const h=c=>c.repeat(64);
const cfg=(more={})=>({Env:['A=1'],Cmd:['ssam-server-start'],User:'10001:10001',WorkingDir:'/app',ExposedPorts:{'7310/tcp':{}},Healthcheck:{Test:['CMD','node']},
 Labels:{'org.opencontainers.image.revision':'a'.repeat(40),'org.opencontainers.image.version':'prod-old','org.opencontainers.image.created':'t0','ssam.kernels.o11':'11.55.94','ssam.kernels.odc':'1.7.30'},...more});
const old={'./platforms/odc/facade/read-budget.mjs':h('a'),'./facade/ssam.mjs':h('b'),'./node_modules/x/i.js':h('c'),'./bin/x':'-> ../y'};
const allow=['server/platforms/odc/facade/read-budget.mjs'];

test('PASS: only the correction file changed; the build labels and the added ssam.studio.* labels are the build\'s',()=>{
 const nl={...cfg().Labels,'org.opencontainers.image.revision':'b'.repeat(40),'org.opencontainers.image.version':'prod-new','org.opencontainers.image.created':'t1','ssam.studio.o11.11.55.94.source':'image x','ssam.studio.from-image':'o11 11.55.94,odc 1.7.30'};
 const r=compareImages({oldFiles:old,newFiles:{...old,'./platforms/odc/facade/read-budget.mjs':h('d')},oldConfig:cfg(),newConfig:cfg({Labels:nl}),allow});
 assert.equal(r.ok,true);assert.deepEqual(r.changed,['./platforms/odc/facade/read-budget.mjs']);assert.deepEqual(r.allowedUnchanged,[]);
});

test('FAIL: any other file changed, added or removed, a link moved, the runtime config or another label changed',()=>{
 const base={oldFiles:old,oldConfig:cfg(),newConfig:cfg(),allow};
 for(const [what,o,key,want] of [
  ['other file',{newFiles:{...old,'./facade/ssam.mjs':h('e')}},'outside',['./facade/ssam.mjs']],
  ['added',{newFiles:{...old,'./facade/new.mjs':h('e')}},'outside',['./facade/new.mjs']],
  ['removed',{newFiles:Object.fromEntries(Object.entries(old).filter(([p])=>p!=='./node_modules/x/i.js'))},'outside',['./node_modules/x/i.js']],
  ['link',{newFiles:{...old,'./bin/x':'-> ../z'}},'outside',['./bin/x']],
  ['env',{newFiles:old,newConfig:cfg({Env:['A=2']})},'config',['Env']],
  ['user',{newFiles:old,newConfig:cfg({User:'0'})},'config',['User']],
  ['label',{newFiles:old,newConfig:cfg({Labels:{...cfg().Labels,'ssam.kernels.odc':'1.7.31'}})},'labels',['ssam.kernels.odc']],
  ['studio label of the old image changed',{newFiles:old,oldConfig:cfg({Labels:{...cfg().Labels,'ssam.studio.x':'a'}}),newConfig:cfg({Labels:{...cfg().Labels,'ssam.studio.x':'b'}})},'labels',['ssam.studio.x']],
 ]){const r=compareImages({...base,...o});assert.equal(r.ok,false,what);assert.deepEqual(r[key],want,what);}
 assert.deepEqual(compareImages({...base,newFiles:old}).allowedUnchanged,['./platforms/odc/facade/read-budget.mjs'],'a correction file the image does not carry is named');
});

test('pnpm bookkeeping: only the install time may differ (masked hash N equal: stampOnly); any other change in it fails; only those two names',()=>{
 const st={'./node_modules/.modules.yaml':h('1'),'N ./node_modules/.modules.yaml':h('7'),'./platforms/odc/node_modules/.pnpm-workspace-state-v1.json':h('2'),'N ./platforms/odc/node_modules/.pnpm-workspace-state-v1.json':h('8')};
 const base={...old,...st},b={oldFiles:base,oldConfig:cfg(),newConfig:cfg(),allow};
 const time=compareImages({...b,newFiles:{...base,'./node_modules/.modules.yaml':h('3'),'./platforms/odc/node_modules/.pnpm-workspace-state-v1.json':h('4')}});
 assert.equal(time.ok,true);assert.deepEqual(time.stampOnly,['./node_modules/.modules.yaml','./platforms/odc/node_modules/.pnpm-workspace-state-v1.json']);assert.deepEqual(time.changed,[]);
 assert.equal(time.files,Object.keys(old).length+2,'the N keys are not files');
 const more=compareImages({...b,newFiles:{...base,'./node_modules/.modules.yaml':h('3'),'N ./node_modules/.modules.yaml':h('9')}});
 assert.equal(more.ok,false);assert.deepEqual(more.outside,['./node_modules/.modules.yaml']);
 const noMask=compareImages({...b,newFiles:{...base,'./node_modules/.modules.yaml':h('3'),'N ./node_modules/.modules.yaml':undefined}});
 assert.equal(noMask.ok,false,'without the masked hash on both sides it is a change');
 const other=compareImages({...b,oldFiles:{...base,'N ./facade/ssam.mjs':h('5')},newFiles:{...base,'./facade/ssam.mjs':h('e'),'N ./facade/ssam.mjs':h('5')}});
 assert.deepEqual(other.outside,['./facade/ssam.mjs'],'another file is never masked');
 assert.deepEqual(parseList(`N ${h('a')}  ./node_modules/.modules.yaml\n`),{'N ./node_modules/.modules.yaml':h('a')});
 assert.ok(LIST.includes('-name .modules.yaml -o -name .pnpm-workspace-state-v1.json')&&LIST.includes('(prunedAt|lastValidatedTimestamp)'));
});

test('parseList and the container command: sha256sum and link lines; the compiled folders pruned; read as root in a throwaway container',()=>{
 assert.deepEqual(parseList(`${h('a')}  ./a b.js\nL ../t  ./l\n`),{'./a b.js':h('a'),'./l':'-> ../t'});
 assert.throws(()=>parseList('garbage\n'),/unreadable/);
 for(const p of SKIP)assert.ok(LIST.includes(`-path ${p}`),p);
 const calls=[];readImage('img:t',args=>{calls.push(args);return args[0]==='run'?`${h('a')}  ./x\n`:'{"Env":[]}';});
 assert.deepEqual(calls[0].slice(0,9),['run','--rm','--pull=never','--network','none','-u','0','--entrypoint','sh']);
});

test('compiled folders: same file names and the same *.deps.json / *.runtimeconfig.json, other bytes free (trilha B, I1)',()=>{
 const k={'./kernel/.local/o11/K.deps.json':h('1'),'C ./kernel/.local/o11/K.deps.json':'1','C ./kernel/.local/o11/K.dll':'1','/usr/local/lib/ssam-skia-probe/p.runtimeconfig.json':h('2'),'C /usr/local/lib/ssam-skia-probe/p.dll':'1','C /usr/local/lib/ssam-skia-probe/p.runtimeconfig.json':'1'};
 const base={...old,...k},b={oldFiles:base,oldConfig:cfg(),newConfig:cfg(),allow};
 const same=compareImages({...b,newFiles:base});assert.equal(same.ok,true);assert.equal(same.compiledNames,4);assert.equal(same.files,Object.keys(old).length+2,'C keys are not files');
 for(const [what,nf,want] of [
  ['deps.json changed (a package floated)',{...base,'./kernel/.local/o11/K.deps.json':h('9')},['./kernel/.local/o11/K.deps.json']],
  ['runtimeconfig changed',{...base,'/usr/local/lib/ssam-skia-probe/p.runtimeconfig.json':h('9')},['/usr/local/lib/ssam-skia-probe/p.runtimeconfig.json']],
  ['a compiled file added',{...base,'C ./kernel/.local/o11/Extra.dll':'1'},['C ./kernel/.local/o11/Extra.dll']],
  ['a compiled file removed',Object.fromEntries(Object.entries(base).filter(([p])=>p!=='C ./kernel/.local/o11/K.dll')),['C ./kernel/.local/o11/K.dll']],
 ]){const r=compareImages({...b,newFiles:nf});assert.equal(r.ok,false,what);assert.deepEqual(r.outside,want,what);}
 assert.deepEqual(parseList(`C ./kernel/.local/a b.dll\nC /usr/local/lib/ssam-skia-probe/p.dll\n${h('a')}  /usr/local/bin/node\n`),
  {'C ./kernel/.local/a b.dll':'1','C /usr/local/lib/ssam-skia-probe/p.dll':'1','/usr/local/bin/node':h('a')});
 for(const d of COMPILED)assert.ok(LIST.includes(` ${d}`),d);
 assert.ok(LIST.includes("-name '*.deps.json' -o -name '*.runtimeconfig.json'"));
});

test('outside /app: ssam-server-start and node by sha256 (trilha B, I2)',()=>{
 const o={...old,'/usr/local/bin/ssam-server-start':h('1'),'/usr/local/bin/node':h('2')},b={oldFiles:o,oldConfig:cfg(),newConfig:cfg(),allow};
 assert.equal(compareImages({...b,newFiles:o}).ok,true);
 const r=compareImages({...b,newFiles:{...o,'/usr/local/bin/ssam-server-start':h('3')}});assert.equal(r.ok,false);assert.deepEqual(r.outside,['/usr/local/bin/ssam-server-start']);
 const gone=compareImages({...b,newFiles:{...old,'/usr/local/bin/node':h('2')}});assert.deepEqual(gone.outside,['/usr/local/bin/ssam-server-start']);
 for(const f of OUTSIDE_FILES)assert.ok(LIST.includes(f),f);
});

test('new ssam.studio.* labels: only the closed provenance list passes (trilha B, I4)',()=>{
 const L=more=>cfg({Labels:{...cfg().Labels,...more}});
 const ok=compareImages({oldFiles:old,newFiles:old,oldConfig:cfg(),newConfig:L({'ssam.studio.from-image':'o11 11.55.94,odc 1.7.31','ssam.studio.o11.11.55.94.source':'image x','ssam.studio.odc.1.7.31.source':'image y'}),allow});
 assert.equal(ok.ok,true);
 for(const k of ['ssam.studio.trust.extra','ssam.studio.odc.source','ssam.studio.o11.x.source','ssam.studio.read-me']){
  const r=compareImages({oldFiles:old,newFiles:old,oldConfig:cfg(),newConfig:L({[k]:'v'}),allow});assert.equal(r.ok,false,k);assert.deepEqual(r.labels,[k],k);
 }
});

test('the correction file must have the source tree\'s content (--allow server/<x>=<sha256>; trilha C, I1)',()=>{
 const want=h('d'),b={oldFiles:old,oldConfig:cfg(),newConfig:cfg()};
 const good=compareImages({...b,newFiles:{...old,'./platforms/odc/facade/read-budget.mjs':want},allow:[`server/platforms/odc/facade/read-budget.mjs=${want}`]});
 assert.equal(good.ok,true);assert.deepEqual(good.wrongContent,[]);
 const bad=compareImages({...b,newFiles:{...old,'./platforms/odc/facade/read-budget.mjs':h('e')},allow:[`server/platforms/odc/facade/read-budget.mjs=${want}`]});
 assert.equal(bad.ok,false);assert.deepEqual(bad.wrongContent,['./platforms/odc/facade/read-budget.mjs']);
 assert.equal(compareImages({...b,newFiles:old,allow:[`server/platforms/odc/facade/tests/t.test.mjs=${want}`]}).ok,true,'a correction file the image does not carry (tests) is not compared');
 assert.throws(()=>compareImages({...b,newFiles:old,allow:['server/x.mjs=abc']}),/not server\/<path>\[=<sha256>\]/);
 const cli=cp.spawnSync(process.execPath,[new URL('../image-diff.mjs',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),'--new','n','--old','o','--allow','server/platforms/odc/facade/read-budget.mjs','--out','x.json'],{encoding:'utf8'});
 assert.equal(cli.status,1);assert.match(cli.stderr,/--allow needs the sha256 each correction file has in the source tree/);
});

test('metadata under /app: mode, owner, type and empty folders (M lines; trilha C, I3)',()=>{
 const m={'M ./facade':'0755 10001:10001 d','M ./facade/ssam.mjs':'0644 10001:10001 f','M ./platforms/odc/facade/read-budget.mjs':'0644 10001:10001 f'};
 const o={...old,...m},b={oldFiles:o,oldConfig:cfg(),newConfig:cfg(),allow};
 const same=compareImages({...b,newFiles:o});assert.equal(same.ok,true);assert.equal(same.files,Object.keys(old).length,'M keys are not files');
 for(const [what,nf,want] of [
  ['an empty folder added',{...o,'M ./empty':'0755 0:0 d'},['M ./empty']],
  ['setuid on a file',{...o,'M ./facade/ssam.mjs':'04755 10001:10001 f'},['M ./facade/ssam.mjs']],
  ['another owner',{...o,'M ./facade':'0755 0:0 d'},['M ./facade']],
  ['the correction file\'s mode',{...o,'./platforms/odc/facade/read-budget.mjs':h('d'),'M ./platforms/odc/facade/read-budget.mjs':'0755 10001:10001 f'},['M ./platforms/odc/facade/read-budget.mjs']],
 ]){const r=compareImages({...b,newFiles:nf});assert.equal(r.ok,false,what);assert.deepEqual(r.outside,want,what);}
 assert.deepEqual(parseList('M 04755 0:0 f  ./a b\nM 0755 10001:10001 d  .\n'),{'M ./a b':'04755 0:0 f','M .':'0755 10001:10001 d'});
 assert.ok(LIST.includes("-printf 'M %#m %U:%G %y  %p\\n'"));
});
