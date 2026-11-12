// gen-retier.test.mjs: the retier generator and kit builder, offline (no VPS). Run from server/:
//   node --test deploy/coolify/r45/retier/tests/gen-retier.test.mjs
// Positive: the r45 compose in production (base c70b570, stored raw 130826ff...) to the compose of RETIER_PIN (default
// HEAD) is a tier-only delta (v4 hot -> v5 hot), the generated PHP passes the class guard and records the start, the
// delta, the hot backend and the router label; the kit is made from one commit with both env-checks and SHA256SUMS.
// Negative: an image, a volume, a served list or a new path in the delta, two hot backends, an unsized base (the r44
// compose), no change, a non-literal value, a bad sha, a base kit whose C6 is not its commit, an --out that is not a kit.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import cp from 'node:child_process';import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),dir=path.resolve(here,'..');
const repo=path.resolve(dir,'../../../../..');
const git=process.env.R45_GIT??(process.platform==='win32'?'C:/Program Files/Git/cmd/git.exe':'git');
const g=(...a)=>cp.execFileSync(git,['-C',repo,...a],{encoding:'utf8',maxBuffer:64<<20});
const PIN=process.env.RETIER_PIN??'HEAD',BASE='c70b570';
const BASE_RAW='130826ffac94f1102d186ba931dbc11fdf672098d6588aaeee7b0684c1a37020';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'retier-test-'));
const env={...process.env,R45_REPO:repo,R45_GIT:git};
const run=(script,args)=>cp.spawnSync(process.execPath,[path.join(dir,script),...args],{encoding:'utf8',env});
const composeAt=rev=>g('show',rev+':server/deploy/coolify/compose.coolify.yml');
const parse=t=>JSON.parse(t.replace(/^#.*\n/,''));
const write=(d,name,c)=>{const f=path.join(d,name);fs.writeFileSync(f,'# test\n'+JSON.stringify(c,null,2)+'\n');return f;};
const gen=(base,next,extra=[])=>{const d=tmp(),out=path.join(d,'out');
 const r=run('gen-retier-php.mjs',['--base-raw',BASE_RAW,'--out',out,'--base-file',write(d,'base.yml',base),'--c6-file',write(d,'new.yml',next),...extra]);return {...r,out};};
const baseC=()=>parse(composeAt(BASE)),pinC=()=>parse(composeAt(PIN));
// The pin without the environment keys it adds to the backends (a pin with the perf switches, as the rehearsal commit,
// gives back the tier-only compose of today; a tier-only pin is unchanged): the r2 cases add their own keys to it.
const tierPinC=()=>{const c=pinC(),b=baseC();for(const [n,s] of Object.entries(c.services))if(s.labels?.['ssam.backend']==='true')for(const k of Object.keys(s.environment))if(!(k in b.services[n].environment))delete s.environment[k];return c;};
const ENV_ADDED_PATH=/^\/services\/ssam-server-v[1-5]\/environment\/[A-Z0-9_]+ \(added\)$/;
const refused=(r,re,what)=>{assert.notEqual(r.status,0,what+': accepted');assert.match(r.stderr,re,what);};

test('retier: the r45 compose in production to the pin is a tier-only delta, v4 hot -> v5 hot',()=>{
 const d=tmp(),out=path.join(d,'out');
 const r=run('gen-retier-php.mjs',['--base',BASE,'--base-raw',BASE_RAW,'--pin',PIN,'--out',out]);
 assert.equal(r.status,0,r.stderr);
 const rep=JSON.parse(r.stdout);
 assert.equal(rep.cb,'925dcd51266aeb1d6ab402cbf5af3212cdfc8202dcd1798c48592080546d6184','the base is the compose the r45 kit in production was made from');
 assert.deepEqual(rep.hot,{from:'ssam-server-v4',to:'ssam-server-v5'});
 const delta=JSON.parse(fs.readFileSync(path.join(out,'expected-delta.json'),'utf8'));
 // The tier part is exactly the 13 paths; a pin with the perf switches (revision 2) adds only backend environment keys.
 const tier=delta.filter(p=>!ENV_ADDED_PATH.test(p)),added=delta.filter(p=>ENV_ADDED_PATH.test(p));
 assert.equal(tier.length,13);
 for(const v of ['v4','v5'])for(const p of ['deploy/resources/limits/cpus','deploy/resources/limits/memory','environment/SSAM_BUILD_WORKERS','environment/SSAM_O11_WORKERS_MAX','labels/ssam.sizing','cpu_shares'])
  assert.ok(tier.includes(`/services/ssam-server-${v}/${p}`),v+' '+p);
 assert.ok(tier.includes('/services/ssam-router/labels/ssam.sizing'));
 assert.ok(!tier.some(p=>/\((added|removed)\)|image|volumes|SERVED/.test(p)));assert.ok(!delta.some(p=>/\(removed\)|image|volumes|SERVED/.test(p)));
 const keys=[...new Set(added.map(p=>p.split('/')[4].replace(/ \(added\)$/,'')))].sort();
 assert.equal(added.length,keys.length*5,'every added key is on the five backends');
 assert.deepEqual(rep.envKeys,keys);assert.equal(rep.tierPaths,13);assert.equal(rep.envAddedPaths,added.length);
 const kit=Object.fromEntries(fs.readFileSync(path.join(out,'kit.env'),'utf8').trim().split('\n').map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
 assert.equal(kit.ENV_KEYS,keys.join(','));assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(out,'env-added.json'),'utf8')).keys).sort(),keys);
 assert.equal(kit.KIND,'retier');assert.equal(kit.BEFORE,BASE_RAW);assert.equal(kit.AFTER,'unknown-run-the-dry-run-first');assert.match(kit.MARK,/^r45h-[0-9a-f]{7,}$/);assert.equal(kit.LABEL,kit.MARK);
 const label=c=>c.services['ssam-router'].labels['ssam.sizing'];
 assert.equal(kit.ROUTER_SIZING_SHA,sha(label(pinC())));assert.equal(kit.BASE_ROUTER_SIZING_SHA,sha(label(baseC())));
 // The router label of the r45 release read back on 2026-11-09 (labels-after.json of the window) hashes to 14b4312d...
 assert.equal(kit.BASE_ROUTER_SIZING_SHA,'14b4312dcb4c5dc8155b284a906861abcf0d90ce39e1f353caf09aef8ac23685');
 const php=fs.readFileSync(path.join(out,'deploy-retier.php'),'utf8');
 assert.match(php,new RegExp(`BASE_RAW_SHA256 = '${BASE_RAW}'`));assert.match(php,/SSAM_RELEASE_APPLY'\) === 'r45h-/);
 assert.match(php,/\/tmp\/ssam-r45h-coolify-before\.json/);assert.doesNotMatch(php,/\/tmp\/ssam-r45-coolify-before\.json/,'never the r45 kit copy');
 assert.match(php,/const HOT_TO = 'ssam-server-v5'/);
 for(const f of ['rollback-retier.php','export-retier-raw.php'])assert.match(fs.readFileSync(path.join(out,f),'utf8'),new RegExp(BASE_RAW),f);
 // The tiers in the delta are the pin's; applying the delta onto the base gives the pin, path by path.
 const B=baseC(),N=pinC(),get=(o,p)=>p.split('/').slice(1).reduce((n,k)=>n?.[k],o);
 for(const q of delta){const p=q.replace(/ \(added\)$/,''),parts=p.split('/').slice(1),last=parts.pop();parts.reduce((n,k)=>n[k],B)[last]=structuredClone(get(N,p));}
 assert.deepEqual(B,N);
 // Today's case on its own: the pin without the switches is a tier-only delta (13 paths, no key).
 const t=gen(baseC(),tierPinC());assert.equal(t.status,0,t.stderr);const tr=JSON.parse(t.stdout);
 assert.deepEqual(tr.envKeys,[],'the tier-only case adds no environment key');assert.equal(tr.delta,13);assert.equal(tr.envAddedPaths,0);
 assert.match(fs.readFileSync(path.join(t.out,'kit.env'),'utf8'),/^ENV_KEYS=$/m);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.out,'env-added.json'),'utf8')),{keys:{},backends:[]});
});

test('retier: --after records the dry run sha; a bad --after or --base-raw is refused',()=>{
 const after='ab'.repeat(32),r=gen(baseC(),pinC(),['--after',after]);assert.equal(r.status,0,r.stderr);
 assert.match(fs.readFileSync(path.join(r.out,'kit.env'),'utf8'),new RegExp('^AFTER='+after+'$','m'));
 assert.match(fs.readFileSync(path.join(r.out,'rollback-retier.php'),'utf8'),new RegExp(`releaseRawSha256'\\] !== '${after}'`));
 refused(gen(baseC(),pinC(),['--after','123']),/--after/,'short after');
 const d=tmp();refused(run('gen-retier-php.mjs',['--base-raw','xyz','--out',d,'--base-file','a','--c6-file','b']),/--base-raw/,'bad base raw');
});

test('retier: anything but tier values in the delta is refused',()=>{
 const cases=[
  // Revision 4 (images): an image without its digest, or a digest without its image, is not an image move.
  ['an image',c=>{c.services['ssam-server-v5'].image+='-x';},/with the old digest/],
  ['a digest label',c=>{c.services['ssam-server-v5'].labels['ssam.image.digest']='sha256:'+'0'.repeat(64);},/keeps the tag/],
  ['a volume',c=>{c.services['ssam-server-v4'].volumes.push({type:'volume',source:'x',target:'/x'});},/outside the tier paths/],
  ['a served list',c=>{c.services['ssam-server-v1'].environment.SSAM_SERVED_VERSIONS='[]';},/outside the tier paths/],
  ['the console',c=>{c.services['ssam-console'].deploy.resources.limits.memory='1g';},/outside the tier paths/],
 ];
 for(const [what,mut,re] of cases){const n=pinC();mut(n);refused(gen(baseC(),n),re,what);}
});

test('retier: two hot backends, an unsized base, no change and a non-literal value are refused',()=>{
 const two=pinC();two.services['ssam-server-v1'].labels['ssam.sizing']='hot';refused(gen(baseC(),two),/2 hot backends/,'two hot');
 refused(gen(parse(g('show','fb3be56:server/deploy/coolify/compose.coolify.yml')),pinC()),/not sized/,'the r44 compose as the base');
 refused(gen(baseC(),baseC()),/does not change/,'no change');
 const lit=pinC();lit.services['ssam-server-v5'].environment.SSAM_BUILD_WORKERS='${SSAM_BUILD_WORKERS:-4}';refused(gen(baseC(),lit),/not literal/,'non-literal');
 const svc=pinC();svc.services['ssam-extra']={image:'x'};refused(gen(baseC(),svc),/services of the base and the new compose differ/,'a new service');
});

test('retier kit: made from one commit, base taken from the production kit, both env-checks; guards on --base-kit and --out',()=>{
 const d=tmp(),baseKit=path.join(d,'base-kit');fs.mkdirSync(baseKit);
 const c6=sha(composeAt(BASE));
 fs.writeFileSync(path.join(baseKit,'kit.env'),`OPTION=c\nPIN=${BASE}\nMARK=r45-c-${BASE}\nAFTER=${BASE_RAW}\nC6=${c6}\n`);
 const out=path.join(d,'kit');
 const r=run('retier-kit.mjs',['--pin',PIN,'--base-kit',baseKit,'--out',out,'--after','cd'.repeat(32),'--since','2026-11-12','--images','none','--repo',repo]);
 assert.equal(r.status,0,r.stderr);
 const files=fs.readFileSync(path.join(out,'SHA256SUMS'),'utf8').trim().split('\n').map(l=>l.slice(66));
 assert.deepEqual(files,['kit.env','deploy-retier.php','export-retier-raw.php','rollback-retier.php','read-labels.php','read-raw-sha.php','env-check.sh','env-check-base.sh','oom-check.sh','retier-window.sh','with-release-lock.sh','backup-before-redeploy.sh','ssamctl.sh','window-backup.sh']);
 for(const l of fs.readFileSync(path.join(out,'SHA256SUMS'),'utf8').trim().split('\n'))assert.equal(sha(fs.readFileSync(path.join(out,l.slice(66)))),l.slice(0,64),l);
 const pin=g('rev-parse',PIN).trim();
 assert.equal(fs.readFileSync(path.join(out,'retier-window.sh'),'utf8'),g('show',`${pin}:server/deploy/coolify/r45/retier/retier-window.sh`),'the window script is the pin bytes');
 const kit=fs.readFileSync(path.join(out,'kit.env'),'utf8');
 assert.match(kit,new RegExp(`^BASE_C6=${c6}$`,'m'));assert.match(kit,/^SINCE=2026-11-12$/m);assert.match(kit,/^HOT_TO=ssam-server-v5$/m);
 const ec=fs.readFileSync(path.join(out,'env-check.sh'),'utf8'),eb=fs.readFileSync(path.join(out,'env-check-base.sh'),'utf8');
 assert.match(ec,/ssam-server-v5 tier hot/);assert.match(ec,/ssam-server-v4 tier other/);
 assert.match(eb,/ssam-server-v4 tier hot/);assert.match(eb,/ssam-server-v5 tier other/);
 // Reviewed: the same kit again is KIT DIFF OK; another AFTER is KIT DIFF FAIL.
 const again=run('retier-kit.mjs',['--pin',PIN,'--base-kit',baseKit,'--out',path.join(d,'kit2'),'--reviewed',out,'--repo',repo]);
 assert.equal(again.status,0,again.stdout+again.stderr);assert.match(again.stdout,/KIT DIFF OK/);
 const other=run('retier-kit.mjs',['--pin',PIN,'--base-kit',baseKit,'--out',path.join(d,'kit3'),'--reviewed',out,'--after','ef'.repeat(32),'--repo',repo]);
 assert.equal(other.status,1);assert.match(other.stdout,/KIT DIFF FAIL\nkit.env AFTER/);
 // A base kit whose C6 is not the compose of its PIN is refused; so is an --out that holds something else.
 fs.writeFileSync(path.join(baseKit,'kit.env'),`OPTION=c\nPIN=${BASE}\nAFTER=${BASE_RAW}\nC6=${'0'.repeat(64)}\n`);
 const bad=run('retier-kit.mjs',['--pin',PIN,'--base-kit',baseKit,'--out',path.join(d,'kit4'),'--images','none','--repo',repo]);
 assert.notEqual(bad.status,0);assert.match(bad.stderr,/is not the compose of its PIN/);
 fs.writeFileSync(path.join(baseKit,'kit.env'),`OPTION=c\nPIN=${BASE}\nAFTER=${BASE_RAW}\nC6=${c6}\n`);
 const precious=path.join(d,'precious');fs.mkdirSync(precious);fs.writeFileSync(path.join(precious,'keep.txt'),'x');
 const guard=run('retier-kit.mjs',['--pin',PIN,'--base-kit',baseKit,'--out',precious,'--images','none','--repo',repo]);
 assert.notEqual(guard.status,0);assert.match(guard.stderr,/not a kit/);assert.ok(fs.existsSync(path.join(precious,'keep.txt')));
 // Review C A3: --images is required (a tier kit says none), and a kit that moves other images than it says is removed.
 const noImages=run('retier-kit.mjs',['--pin',PIN,'--base-kit',baseKit,'--out',path.join(d,'kit5'),'--repo',repo]);
 assert.notEqual(noImages.status,0);assert.match(noImages.stderr,/--images <service,\.\.\.>\|none/);assert.ok(!fs.existsSync(path.join(d,'kit5','kit.env')));
 const said=run('retier-kit.mjs',['--pin',PIN,'--base-kit',baseKit,'--out',path.join(d,'kit6'),'--after','cd'.repeat(32),'--images','ssam-server-v5','--repo',repo]);
 assert.notEqual(said.status,0);assert.match(said.stderr,/--images ssam-server-v5 but the (base->new delta|kit) moves none/);assert.ok(!fs.existsSync(path.join(d,'kit6','kit.env')));
});

// Revision 2: environment keys ADDED to every backend (the perf switches of trilhas I and G), besides the tiers.
const SWITCHES={SSAM_HUB_ACCEPT_WITH_RESULT:'1',SSAM_HUB_PART_GZIP:'1',SSAM_HUB_PART_PARALLEL:'3',SSAM_HUB_RESULT_TIMING:'1',SSAM_O11_CAPTURE_REUSE:'0',SSAM_O11_WORKER_BUSY_WAIT_MS:'0'};
const NAMES=Object.keys(SWITCHES).sort();
const BACKENDS=['ssam-server-v1','ssam-server-v2','ssam-server-v3','ssam-server-v4','ssam-server-v5'];
const withKeys=(c=tierPinC(),keys=SWITCHES)=>{for(const b of BACKENDS)for(const [k,d] of Object.entries(keys))c.services[b].environment[k]=`\${${k}:-${d}}`;return c;};
test('retier r2: tiers + environment keys added to every backend are accepted (derived list, or the same list given)',()=>{
 const r=gen(baseC(),withKeys());assert.equal(r.status,0,r.stderr);
 const rep=JSON.parse(r.stdout);
 assert.deepEqual(rep.envKeys,NAMES);assert.equal(rep.envKeysFrom,'derived from the diff');assert.equal(rep.tierPaths,13);assert.equal(rep.envAddedPaths,30);assert.equal(rep.delta,43);
 const kit=fs.readFileSync(path.join(r.out,'kit.env'),'utf8');assert.match(kit,new RegExp('^ENV_KEYS='+NAMES.join(',')+'$','m'));
 const added=JSON.parse(fs.readFileSync(path.join(r.out,'env-added.json'),'utf8'));
 assert.deepEqual(added.backends,BACKENDS);for(const k of NAMES)assert.deepEqual(added.keys[k],{value:`\${${k}:-${SWITCHES[k]}}`,default:SWITCHES[k]});
 const php=fs.readFileSync(path.join(r.out,'deploy-retier.php'),'utf8');
 assert.ok(php.includes(`const ENV_KEYS = [${NAMES.map(k=>`'${k}'`).join(',')}];`),'the PHP records the list');
 assert.match(php,/'envAddedKeys' => implode\(',', ENV_KEYS\)/);
 // The rollback still restores the saved r45 compose (no key): its PHP is the tier-only one byte for byte.
 const t=gen(baseC(),tierPinC());assert.equal(fs.readFileSync(path.join(r.out,'rollback-retier.php'),'utf8'),fs.readFileSync(path.join(t.out,'rollback-retier.php'),'utf8'));
 const given=gen(baseC(),withKeys(),['--env-keys',[...NAMES].reverse().join(',')]);assert.equal(given.status,0,given.stderr);assert.equal(JSON.parse(given.stdout).envKeysFrom,'--env-keys');
 assert.equal(fs.readFileSync(path.join(given.out,'deploy-retier.php'),'utf8'),php,'the same list, given or derived, makes the same PHP');
 // A seventh key (trilha G) is one more name, 5 more paths.
 const g7=gen(baseC(),withKeys(tierPinC(),{...SWITCHES,SSAM_O11_PULL_BY_SHA:'0'}));assert.equal(g7.status,0,g7.stderr);assert.equal(JSON.parse(g7.stdout).envAddedPaths,35);
});
test('retier r2: a key outside the list, or a listed key not added, is refused',()=>{
 refused(gen(baseC(),withKeys(),['--env-keys',NAMES.slice(1).join(',')]),/is not in the list/,'a key outside the list');
 refused(gen(baseC(),withKeys(),['--env-keys','none']),/is not in the list/,'keys with --env-keys none');
 refused(gen(baseC(),withKeys(),['--env-keys',[...NAMES,'SSAM_O11_PULL_BY_SHA'].join(',')]),/SSAM_O11_PULL_BY_SHA is not added to every backend/,'a listed key not added');
 refused(gen(baseC(),tierPinC(),['--env-keys','SSAM_X']),/not added to every backend/,'a list on a tier-only delta');
});
test('retier r2: a key with another value in one backend, or not added to every backend, is refused',()=>{
 const one=withKeys();one.services['ssam-server-v3'].environment.SSAM_HUB_PART_PARALLEL='${SSAM_HUB_PART_PARALLEL:-4}';
 refused(gen(baseC(),one),/SSAM_HUB_PART_PARALLEL has another value/,'another value in one backend');
 const only=tierPinC();only.services['ssam-server-v5'].environment.SSAM_NEW='${SSAM_NEW:-1}';refused(gen(baseC(),only),/SSAM_NEW is not added to every backend/,'one backend only');
 for(const [what,v] of [['a literal','1'],['another variable','${SSAM_OTHER:-1}'],['a required variable','${SSAM_HUB_PART_GZIP:?x}'],['a default with a space','${SSAM_HUB_PART_GZIP:-1 2}'],['a nested default','${SSAM_HUB_PART_GZIP:-${X}}']]){
  const c=withKeys();for(const b of BACKENDS)c.services[b].environment.SSAM_HUB_PART_GZIP=v;refused(gen(baseC(),c),/is not \$\{SSAM_HUB_PART_GZIP:-default\}/,what);}
 const tierName=withKeys(tierPinC(),{...SWITCHES,SSAM_HOT_CPUS:'5'});refused(gen(baseC(),tierName),/tier-variable name/,'a tier variable name');
});
test('retier r2: an existing key changed or removed, or a key on the router or the console, is refused',()=>{
 const changed=withKeys();changed.services['ssam-server-v1'].environment.SSAM_O11_WORKER_BASE_CACHE='${SSAM_O11_WORKER_BASE_CACHE:-on}';
 refused(gen(baseC(),changed),/outside the tier paths and the added backend environment keys: \/services\/ssam-server-v1\/environment\/SSAM_O11_WORKER_BASE_CACHE$/m,'an existing key changed');
 const removed=withKeys();delete removed.services['ssam-server-v2'].environment.SSAM_LOCAL_UPLOAD;refused(gen(baseC(),removed),/SSAM_LOCAL_UPLOAD \(removed\)/,'an existing key removed');
 const router=withKeys();router.services['ssam-router'].environment.SSAM_HUB_PART_GZIP='${SSAM_HUB_PART_GZIP:-1}';refused(gen(baseC(),router),/ssam-router\/environment\/SSAM_HUB_PART_GZIP \(added\)/,'a key on the router');
 const console_=withKeys();console_.services['ssam-console'].environment.SSAM_HUB_PART_GZIP='${SSAM_HUB_PART_GZIP:-1}';refused(gen(baseC(),console_),/ssam-console\/environment\/SSAM_HUB_PART_GZIP \(added\)/,'a key on the console');
 const label=withKeys();label.services['ssam-server-v1'].labels['ssam.switch']='1';refused(gen(baseC(),label),/outside the tier paths/,'a label added');
});
test('retier r2: env-check.sh checks every added key in every backend (missing and other value FAIL); env-check-base.sh only the queries',()=>{
 const r=gen(baseC(),withKeys());assert.equal(r.status,0,r.stderr);
 const d=tmp(),U='ksqommjgowjjilpgpbmf7cdo';
 const chk=run('../gen-checks.mjs',['--option','c','--pin','HEAD','--out',d,'--since','2026-11-12']);assert.equal(chk.status,0,chk.stderr);
 const plain=fs.readFileSync(path.join(d,'env-check.sh'),'utf8');
 fs.copyFileSync(path.join(d,'env-check.sh'),path.join(d,'env-check-base.sh'));
 for(const [f,mode] of [['env-check.sh','after'],['env-check-base.sh','base']]){const p=run('env-keys-check.mjs',['--check',path.join(d,f),'--added',path.join(r.out,'env-added.json'),'--mode',mode]);assert.equal(p.status,0,p.stderr);}
 const ec=fs.readFileSync(path.join(d,'env-check.sh'),'utf8'),eb=fs.readFileSync(path.join(d,'env-check-base.sh'),'utf8');
 const notIn=`  and v.key not in (${NAMES.map(k=>`'${k}'`).join(',')})\n`;
 for(const t of [ec,eb]){assert.ok(t.includes("v.created_at >= '2026-11-12')\n"+notIn),'the rows of the added keys are not "new variables"');assert.match(t,/info resource variables of the added keys/);assert.match(t,/ENVCHECK FAIL \$fail"\n$/);}
 assert.doesNotMatch(eb,/arrived with the compose default/,'after a rollback the r45 compose does not list the keys');
 for(const b of BACKENDS)for(const k of NAMES)assert.ok(ec.includes(`grep -qx '${k}=${SWITCHES[k]}'`)&&ec.includes(`echo "ok   ${b} ${k} arrived with the compose default"`),b+' '+k);
 // No key: the file stays as gen-checks wrote it.
 const none=path.join(d,'none.json');fs.writeFileSync(none,'{"keys":{},"backends":[]}');fs.writeFileSync(path.join(d,'plain.sh'),plain);
 assert.equal(run('env-keys-check.mjs',['--check',path.join(d,'plain.sh'),'--added',none,'--mode','after']).status,0);assert.equal(fs.readFileSync(path.join(d,'plain.sh'),'utf8'),plain);
 // Run it against a fake docker: every backend carries its keys; then one missing, one with another value.
 const bin=path.join(d,'bin');fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin,'docker'),`#!/bin/bash\ncase "$*" in *'{{range .Config.Env}}'*) c="\${@: -1}"; cat "$FAKE/env-$c" 2>/dev/null;; *coolify-db*) cat >/dev/null;; esac\nexit 0\n`,{mode:0o755});
 const envOf=(b,ks)=>fs.writeFileSync(path.join(d,`env-${b}-${U}`),Object.entries(ks).map(([k,v])=>`${k}=${v}`).join('\n')+'\nPATH=/usr/bin\n');
 const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
 const runEc=()=>{const x=cp.spawnSync(bash,[path.join(d,'env-check.sh').replace(/\\/g,'/')],{encoding:'utf8',env:{...process.env,FAKE:d.replace(/\\/g,'/'),PATH:bin+path.delimiter+process.env.PATH}});return x.stdout;};
 const fails=o=>{const last=o.trim().split('\n').pop();assert.match(last,/^ENVCHECK (OK|FAIL \d+)$/);return last==='ENVCHECK OK'?0:Number(last.split(' ')[2]);};
 for(const b of BACKENDS)envOf(b,SWITCHES);
 const all=runEc();for(const b of BACKENDS)for(const k of NAMES)assert.match(all,new RegExp(`^ok   ${b} ${k} arrived with the compose default$`,'m'));
 assert.doesNotMatch(all,/did not arrive|another value/);const base=fails(all);
 const {SSAM_HUB_PART_GZIP,...rest}=SWITCHES;envOf('ssam-server-v3',rest);
 const miss=runEc();assert.match(miss,/^FAIL ssam-server-v3 SSAM_HUB_PART_GZIP did not arrive$/m);assert.equal(fails(miss),base+1,'one variable missing is one more FAIL');
 envOf('ssam-server-v3',SWITCHES);envOf('ssam-server-v5',{...SWITCHES,SSAM_O11_WORKER_BUSY_WAIT_MS:'6000'});
 const other=runEc();assert.match(other,/^FAIL ssam-server-v5 SSAM_O11_WORKER_BUSY_WAIT_MS arrived with another value/m);assert.doesNotMatch(other,/6000/,'never the value');assert.equal(fails(other),base+1);
});
