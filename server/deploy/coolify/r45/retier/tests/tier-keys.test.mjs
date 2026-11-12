// tier-keys.test.mjs: revision 3 of the retier, the tier keys (trilha I, Revisão 7), offline (no VPS). Run from server/:
//   node --test deploy/coolify/r45/retier/tests/tier-keys.test.mjs
// SSAM_CODE_CHECKS / SSAM_CODE_CHECKS_PER_CUSTOMER of a backend are tier values: added, changed or removed with the tiers,
// each a literal 1..16 equal to the field of the backend's tier in the router's ssam.sizing label of the new compose.
// Positive: profile (a) (hot 2/1, other 1/1) on top of the pin, a change of one tier's value, the way back (removed).
// Negative: a 2 on an other backend, a hot without the value, ${...}, 17 (in the backend or in the label), a key on the
// router, a removal while the label still names the field, a key in the backends whose label has no field, the two names
// as added keys (--env-keys). Today's kit (no tier key) is byte for byte the one of the revision 2 generator (R2_REV).
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import cp from 'node:child_process';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url)),dir=path.resolve(here,'..');
const repo=path.resolve(dir,'../../../../..');
const git=process.env.R45_GIT??(process.platform==='win32'?'C:/Program Files/Git/cmd/git.exe':'git');
const g=(...a)=>cp.execFileSync(git,['-C',repo,...a],{encoding:'utf8',maxBuffer:64<<20});
const PIN=process.env.RETIER_PIN??'HEAD',BASE='c70b570';
// The revision 2 generator the byte-for-byte case compares with: the one of the coordinator's rehearsal kit (pin a35213e).
const R2_REV=process.env.RETIER_R2_REV??'a35213e';
const BASE_RAW='130826ffac94f1102d186ba931dbc11fdf672098d6588aaeee7b0684c1a37020';
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'retier-tier-'));
const env={...process.env,R45_REPO:repo,R45_GIT:git};
const run=(script,args,cwd=dir)=>cp.spawnSync(process.execPath,[path.join(cwd,script),...args],{encoding:'utf8',env});
const parse=t=>JSON.parse(t.replace(/^#.*\n/,''));
const write=(d,name,c)=>{const f=path.join(d,name);fs.writeFileSync(f,'# test\n'+JSON.stringify(c,null,2)+'\n');return f;};
const gen=(base,next,extra=[],cwd=dir)=>{const d=tmp(),out=path.join(d,'out');
 const r=run('gen-retier-php.mjs',['--base-raw',BASE_RAW,'--out',out,'--base-file',write(d,'base.yml',base),'--c6-file',write(d,'new.yml',next),...extra],cwd);return {...r,out};};
const baseC=()=>parse(g('show',BASE+':server/deploy/coolify/compose.coolify.yml')),pinC=()=>parse(g('show',PIN+':server/deploy/coolify/compose.coolify.yml'));
const refused=(r,re,what)=>{assert.notEqual(r.status,0,what+': accepted');assert.match(r.stderr,re,what);};
const BACKENDS=['ssam-server-v1','ssam-server-v2','ssam-server-v3','ssam-server-v4','ssam-server-v5'];
const K='SSAM_CODE_CHECKS',KP='SSAM_CODE_CHECKS_PER_CUSTOMER';
// Profile (a) of trilha I: the label names hot 2/1 and other 1/1; every backend carries its tier's literal.
const profile=(c=pinC(),vals={hot:[2,1],other:[1,1]})=>{
 const r=c.services['ssam-router'].labels,s=JSON.parse(r['ssam.sizing']);
 for(const [t,[a,b]] of Object.entries(vals)){s[t].codeChecks=a;s[t].codeChecksPerCustomer=b;}
 r['ssam.sizing']=JSON.stringify(s);
 for(const n of BACKENDS){const e=c.services[n].environment,[a,b]=vals[c.services[n].labels['ssam.sizing']];e[K]=String(a);e[KP]=String(b);}
 return c;};
const files=d=>fs.readdirSync(d).sort();
const kitEnv=d=>Object.fromEntries(fs.readFileSync(path.join(d,'kit.env'),'utf8').trim().split('\n').map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const applyDelta=(B,N,delta)=>{const get=(o,p)=>p.split('/').slice(1).reduce((n,k)=>n?.[k],o);
 for(const q of delta){const p=q.replace(/ \((added|removed)\)$/,''),parts=p.split('/').slice(1),last=parts.pop(),node=parts.reduce((n,k)=>n[k],B);
  if(q.endsWith(' (removed)'))delete node[last];else node[last]=structuredClone(get(N,p));}
 return B;};

test('tier keys: profile (a) on the pin is accepted; the 10 paths are tier keys, not added keys, and the PHP and kit record them',()=>{
 const N=profile(),r=gen(baseC(),N);assert.equal(r.status,0,r.stderr);
 const rep=JSON.parse(r.stdout),plain=JSON.parse(gen(baseC(),pinC()).stdout);
 assert.equal(rep.tierKeyPaths,10);assert.equal(rep.delta,plain.delta+10);assert.equal(rep.tierPaths,plain.tierPaths+10,'tier keys count as tier paths');
 assert.equal(rep.envAddedPaths,plain.envAddedPaths,'not as added keys');assert.deepEqual(rep.envKeys,plain.envKeys);assert.ok(!rep.envKeys.includes(K)&&!rep.envKeys.includes(KP));
 const delta=JSON.parse(fs.readFileSync(path.join(r.out,'expected-delta.json'),'utf8'));
 for(const b of BACKENDS)for(const k of [K,KP])assert.ok(delta.includes(`/services/${b}/environment/${k} (added)`),b+' '+k);
 assert.deepEqual(applyDelta(baseC(),N,delta),N,'the delta onto the base gives the new compose');
 const kit=kitEnv(r.out);assert.equal(kit.TIER_KEY_PATHS,'10');assert.ok(!kit.ENV_KEYS.split(',').includes(K));
 const tk=JSON.parse(fs.readFileSync(path.join(r.out,'tier-keys.json'),'utf8'));
 assert.deepEqual(tk.after['ssam-server-v5'],{[K]:'2',[KP]:'1'});assert.deepEqual(tk.after['ssam-server-v1'],{[K]:'1',[KP]:'1'});assert.deepEqual(tk.base['ssam-server-v5'],{[K]:null,[KP]:null});
 const php=fs.readFileSync(path.join(r.out,'deploy-retier.php'),'utf8');
 const T=JSON.parse(Buffer.from(php.match(/\$TIER_KEYS = json_decode\(base64_decode\('([^']+)'\)/)[1],'base64').toString());
 assert.equal(Object.keys(T).length,10);assert.equal(T['/services/ssam-server-v5/environment/SSAM_CODE_CHECKS'],'2');assert.equal(T['/services/ssam-server-v2/environment/SSAM_CODE_CHECKS'],'1');
 const added=JSON.parse(Buffer.from(php.match(/\$ENV_ADDED = json_decode\(base64_decode\('([^']+)'\)/)[1],'base64').toString());
 assert.ok(!Object.keys(added).some(p=>/SSAM_CODE_CHECKS/.test(p)),'never in $ENV_ADDED');
 for(const s of ['function del(&$root, $path)','$tierSvcs[$m[1]] = true; continue;','foreach (array_keys($envSvcs + $tierSvcs) as $name)',"stop(\"$name $k is not the value of its tier in the router label\")","'tierKeyPaths' => count($TIER_KEYS)"])assert.ok(php.includes(s),s);
 // The same profile on the tier-only pin (no perf switch) is tier paths only: 13 + 10.
 const t=tierOnly(),rt=gen(baseC(),profile(t));assert.equal(rt.status,0,rt.stderr);assert.equal(JSON.parse(rt.stdout).delta,23);
});
const tierOnly=()=>{const c=pinC(),b=baseC();for(const n of BACKENDS)for(const k of Object.keys(c.services[n].environment))if(!(k in b.services[n].environment))delete c.services[n].environment[k];return c;};

test('tier keys: a 2 on an other backend, a hot without the value, ${...} and 17 are refused',()=>{
 const cold=profile();cold.services['ssam-server-v1'].environment[K]='2';refused(gen(baseC(),cold),/SSAM_CODE_CHECKS on ssam-server-v1 \(other\) is 2, the router label's other\.codeChecks is 1/,'a 2 on a cold backend');
 const hot=profile();delete hot.services['ssam-server-v5'].environment[KP];refused(gen(baseC(),hot),/SSAM_CODE_CHECKS_PER_CUSTOMER missing on ssam-server-v5 \(hot\)/,'a hot without the value');
 for(const [what,v] of [['${...}','${SSAM_CODE_CHECKS:-1}'],['17','17'],['0','0'],['a number','1 '],['two values','1,2']]){
  const c=profile();for(const n of BACKENDS)if(c.services[n].labels['ssam.sizing']==='other')c.services[n].environment[K]=v;
  refused(gen(baseC(),c),/SSAM_CODE_CHECKS on ssam-server-v1 is not a literal 1\.\.16/,what);}
 const as=profile();as.services['ssam-server-v1'].environment[K]=1;refused(gen(baseC(),as),/not a literal 1\.\.16/,'a JSON number');
 refused(gen(baseC(),profile(pinC(),{hot:[17,1],other:[1,1]})),/hot\.codeChecks is not an integer 1\.\.16/,'17 in the label and the backend');
});

test('tier keys: on the router, on a backend whose tier has no field, or as added keys (--env-keys), refused',()=>{
 const router=profile();router.services['ssam-router'].environment[K]='2';refused(gen(baseC(),router),/outside the tier paths and the added backend environment keys: \/services\/ssam-router\/environment\/SSAM_CODE_CHECKS \(added\)/,'on the router');
 const console_=profile();console_.services['ssam-console'].environment[K]='2';refused(gen(baseC(),console_),/ssam-console\/environment\/SSAM_CODE_CHECKS \(added\)/,'on the console');
 const nofield=pinC();nofield.services['ssam-server-v5'].environment[K]='2';refused(gen(baseC(),nofield),/SSAM_CODE_CHECKS on ssam-server-v5 \(hot\) but the router label has no hot\.codeChecks/,'the label without the field');
 const half=profile(pinC());const s=JSON.parse(half.services['ssam-router'].labels['ssam.sizing']);delete s.other.codeChecksPerCustomer;half.services['ssam-router'].labels['ssam.sizing']=JSON.stringify(s);
 refused(gen(baseC(),half),/SSAM_CODE_CHECKS_PER_CUSTOMER on ssam-server-v1 \(other\) but the router label has no other\.codeChecksPerCustomer/,'one field less in the label');
 // The label names the field but no backend carries the key (no tier-key path in the delta at all): still refused.
 const bare=pinC(),bl=JSON.parse(bare.services['ssam-router'].labels['ssam.sizing']);bl.hot.codeChecks=2;bare.services['ssam-router'].labels['ssam.sizing']=JSON.stringify(bl);
 refused(gen(baseC(),bare),/SSAM_CODE_CHECKS missing on ssam-server-v5 \(hot\), whose tier names codeChecks 2/,'a label field without the keys');
 refused(gen(baseC(),profile(),['--env-keys',[...JSON.parse(gen(baseC(),pinC()).stdout).envKeys,K].join(',')]),/SSAM_CODE_CHECKS is a tier, pool, served-list or tier-variable name/,'listed as an added key');
 // As ${KEY:-default} on every backend (the shape of an added key) it is still a tier key: refused as not literal.
 const shaped=pinC();for(const n of BACKENDS)shaped.services[n].environment[K]='${SSAM_CODE_CHECKS:-1}';refused(gen(baseC(),shaped),/but the router label has no/,'the switch shape');
});

test('tier keys: a changed value and the way back (removed) are accepted; a removal while the label names the field is refused',()=>{
 const A=profile(),A2=profile(pinC(),{hot:[3,2],other:[1,1]});
 const ch=gen(A,A2);assert.equal(ch.status,0,ch.stderr);const rc=JSON.parse(ch.stdout);
 assert.equal(rc.tierKeyPaths,2);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ch.out,'expected-delta.json'),'utf8')).sort(),['/services/ssam-router/labels/ssam.sizing','/services/ssam-server-v5/environment/SSAM_CODE_CHECKS','/services/ssam-server-v5/environment/SSAM_CODE_CHECKS_PER_CUSTOMER']);
 const back=gen(profile(),pinC());assert.equal(back.status,0,back.stderr);
 const delta=JSON.parse(fs.readFileSync(path.join(back.out,'expected-delta.json'),'utf8'));assert.equal(JSON.parse(back.stdout).tierKeyPaths,10);
 for(const b of BACKENDS)for(const k of [K,KP])assert.ok(delta.includes(`/services/${b}/environment/${k} (removed)`),b+' '+k);
 assert.deepEqual(applyDelta(profile(),pinC(),delta),pinC());
 const T=JSON.parse(Buffer.from(fs.readFileSync(path.join(back.out,'deploy-retier.php'),'utf8').match(/\$TIER_KEYS = json_decode\(base64_decode\('([^']+)'\)/)[1],'base64').toString());
 assert.ok(Object.values(T).every(v=>v===null),'removed: null');
 const tk=JSON.parse(fs.readFileSync(path.join(back.out,'tier-keys.json'),'utf8'));assert.deepEqual(tk.after['ssam-server-v5'],{[K]:null,[KP]:null});assert.deepEqual(tk.base['ssam-server-v5'],{[K]:'2',[KP]:'1'});
 const early=profile();delete early.services['ssam-server-v2'].environment[K];refused(gen(profile(),early),/SSAM_CODE_CHECKS missing on ssam-server-v2 \(other\), whose tier names codeChecks 1/,'removed with the field in the label');
});

test('tier keys: with no tier key every output is byte for byte the revision 2 generator\'s (the kit of today)',()=>{
 const d=tmp(),r2=path.join(d,'r2');fs.mkdirSync(path.join(r2,'retier'),{recursive:true});
 fs.writeFileSync(path.join(r2,'php-classes.mjs'),g('show',R2_REV+':server/deploy/coolify/r45/php-classes.mjs'));
 fs.writeFileSync(path.join(r2,'retier','gen-retier-php.mjs'),g('show',R2_REV+':server/deploy/coolify/r45/retier/gen-retier-php.mjs'));
 for(const [what,next] of [['the pin (tiers + the added keys)',pinC()],['tiers only',tierOnly()]]){
  const now=gen(baseC(),next),was=gen(baseC(),next,[],path.join(r2,'retier'));assert.equal(now.status,0,now.stderr);assert.equal(was.status,0,was.stderr);
  assert.deepEqual(files(now.out),files(was.out),what+': the same files (no tier-keys.json)');
  for(const f of files(now.out))assert.ok(fs.readFileSync(path.join(now.out,f)).equals(fs.readFileSync(path.join(was.out,f))),what+': '+f);
  assert.equal(now.stdout,was.stdout,what+': the same report');
 }
});

test('tier keys: env-check.sh checks each backend\'s literal after the Redeploy, env-check-base.sh their absence after a rollback',()=>{
 const r=gen(baseC(),profile(tierOnly()));assert.equal(r.status,0,r.stderr);
 const d=tmp(),U='ksqommjgowjjilpgpbmf7cdo';
 const chk=run('../gen-checks.mjs',['--option','c','--pin','HEAD','--out',d,'--since','2026-11-12']);assert.equal(chk.status,0,chk.stderr);
 fs.copyFileSync(path.join(d,'env-check.sh'),path.join(d,'env-check-base.sh'));
 const plain=fs.readFileSync(path.join(d,'env-check.sh'),'utf8');
 for(const [f,mode] of [['env-check.sh','after'],['env-check-base.sh','base']]){const p=run('env-keys-check.mjs',['--check',path.join(d,f),'--added',path.join(r.out,'env-added.json'),'--mode',mode,'--tier',path.join(r.out,'tier-keys.json')]);assert.equal(p.status,0,p.stderr);}
 const ec=fs.readFileSync(path.join(d,'env-check.sh'),'utf8'),eb=fs.readFileSync(path.join(d,'env-check-base.sh'),'utf8');
 assert.ok(ec.includes("v.created_at >= '2026-11-12')\norder by"),'no added key: the resource variable query is gen-checks\' (a literal tier key makes no row; a row is a FAIL)');
 assert.ok(ec.startsWith(plain.slice(0,plain.lastIndexOf('[ "$fail" = 0 ]'))),'only a block before the last line');
 assert.ok(ec.includes("grep -qx 'SSAM_CODE_CHECKS=2'")&&eb.includes("grep -q '^SSAM_CODE_CHECKS='"));
 const bin=path.join(d,'bin');fs.mkdirSync(bin);
 fs.writeFileSync(path.join(bin,'docker'),`#!/bin/bash\ncase "$*" in *'{{range .Config.Env}}'*) c="\${@: -1}"; cat "$FAKE/env-$c" 2>/dev/null;; *coolify-db*) cat >/dev/null;; esac\nexit 0\n`,{mode:0o755});
 const envOf=(b,ks)=>fs.writeFileSync(path.join(d,`env-${b}-${U}`),Object.entries(ks).map(([k,v])=>`${k}=${v}`).join('\n')+'\nPATH=/usr/bin\n');
 const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
 const runSh=f=>cp.spawnSync(bash,[path.join(d,f).replace(/\\/g,'/')],{encoding:'utf8',env:{...process.env,FAKE:d.replace(/\\/g,'/'),PATH:bin+path.delimiter+process.env.PATH}}).stdout;
 const fails=o=>{const last=o.trim().split('\n').pop();assert.match(last,/^ENVCHECK (OK|FAIL \d+)$/);return last==='ENVCHECK OK'?0:Number(last.split(' ')[2]);};
 const tier=b=>b==='ssam-server-v5'?{[K]:'2',[KP]:'1'}:{[K]:'1',[KP]:'1'};
 for(const b of BACKENDS)envOf(b,tier(b));
 const good=runSh('env-check.sh');for(const b of BACKENDS)assert.match(good,new RegExp(`^ok   ${b} SSAM_CODE_CHECKS=${tier(b)[K]} \\(tier\\)$`,'m'));const base=fails(good);
 envOf('ssam-server-v1',{[K]:'2',[KP]:'1'});const cold=runSh('env-check.sh');assert.match(cold,/^FAIL ssam-server-v1 SSAM_CODE_CHECKS is not 1$/m);assert.equal(fails(cold),base+1);
 envOf('ssam-server-v1',{[KP]:'1'});assert.equal(fails(runSh('env-check.sh')),base+1,'missing');
 // After a rollback to the r45 compose (no key): a leftover value is a FAIL, absence is ok.
 for(const b of BACKENDS)envOf(b,{});const rb=runSh('env-check-base.sh');for(const b of BACKENDS)assert.match(rb,new RegExp(`^ok   ${b} SSAM_CODE_CHECKS absent, as the compose$`,'m'));const rbase=fails(rb);
 envOf('ssam-server-v5',{[K]:'2'});const left=runSh('env-check-base.sh');assert.match(left,/^FAIL ssam-server-v5 SSAM_CODE_CHECKS is set but the compose does not list it/m);assert.equal(fails(left),rbase+1);
});
