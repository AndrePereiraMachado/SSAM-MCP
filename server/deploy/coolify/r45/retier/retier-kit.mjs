// node retier-kit.mjs --pin <rev> --base-kit <dir> --out <dir> [--after <sha256>] [--since <YYYY-MM-DD>] [--env-keys K1,K2|none] [--reviewed <dir>] [--repo <checkout>]
// Builds the r45 RETIER kit (retier-window.sh) ENTIRELY from one commit, as r45/kit.mjs does for the r45 kit (review R4 B1):
// the generators (r45/retier/gen-retier-php.mjs, r45/php-classes.mjs, r45/gen-checks.mjs) are read from <pin> with git
// show and run from a private copy; every script it stages is <pin>'s own bytes: retier-window.sh, read-raw-sha.php,
// oom-check.sh, ../vigia/with-release-lock.sh, backup-before-redeploy.sh, ssamctl.sh, window-backup.sh.
// --base-kit: the r45 kit that is IN PRODUCTION (e.g. C:/t/r5/capacity/deploy-r45/option-c-main). Its kit.env gives the
// start: BASE = its PIN (the commit whose compose the stored one was made from), BEFORE = its AFTER (the stored raw sha256
// now), and its C6 must be the sha256 of that commit's compose.coolify.yml: a base kit that does not describe its own
// commit is refused. The kit gets env-check.sh (the pin's tiers, checked after the Redeploy) and env-check-base.sh (the
// base's tiers, checked after a rollback), both from gen-checks.mjs of the pin.
// --reviewed <dir>: the retier kit that was reviewed; the new one must equal it byte for byte once PIN and MARK/LABEL are
// put back, with KIND, BASE, BEFORE, AFTER, IMAGES_CHANGE, SINCE, C6, BASE_C6, HOT_FROM, HOT_TO and both router label
// shas and ENV_KEYS the same. --env-keys (revision 2): the environment keys the retier may ADD to every backend (absent:
// derived from the diff and printed; gen-retier-php.mjs has the rules); env-check.sh and env-check-base.sh are then
// extended by retier/env-keys-check.mjs (of the pin) to check them; with tier keys (revision 3, tier-keys.json of the
// generator) also with --tier: each backend's SSAM_CODE_CHECKS[_PER_CUSTOMER] is its compose's literal or absent. Prints KIT DIFF OK or KIT DIFF FAIL (exit 1). --out must be absent, empty or an earlier kit (kit.env):
// it is replaced (review R5 B5). Nothing here touches the VPS.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import cp from 'node:child_process';import crypto from 'node:crypto';
const argv=process.argv.slice(2),opt=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:undefined;};
const git=process.env.R45_GIT??'C:/Program Files/Git/cmd/git.exe',repo=opt('--repo')??process.env.R45_REPO??'C:/t/r5/wt-capacity';
const g=(...a)=>cp.execFileSync(git,['-C',repo,...a],{encoding:'utf8',maxBuffer:64<<20});
const readEnv=dir=>Object.fromEntries(fs.readFileSync(path.join(dir,'kit.env'),'utf8').split('\n').filter(Boolean).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const pinArg=opt('--pin');if(!pinArg)throw new Error('--pin <rev>');
const baseKitDir=opt('--base-kit');if(!baseKitDir)throw new Error('--base-kit <the r45 kit in production>');
const out=opt('--out');if(!out)throw new Error('--out <dir>');
const reviewedDir=opt('--reviewed'),reviewed=reviewedDir?readEnv(reviewedDir):null;
if(reviewedDir&&path.resolve(out)===path.resolve(reviewedDir))throw new Error('--out must not be the reviewed kit');
if(path.resolve(out)===path.resolve(baseKitDir))throw new Error('--out must not be the base kit');
if(fs.existsSync(out)&&fs.readdirSync(out).length&&!fs.existsSync(path.join(out,'kit.env')))throw new Error('--out exists and is not a kit (no kit.env): refusing to replace it');
const baseKit=readEnv(baseKitDir);
if(baseKit.KIND&&baseKit.KIND!=='retier'||!baseKit.PIN||!/^[0-9a-f]{64}$/.test(baseKit.AFTER??'')||!/^[0-9a-f]{64}$/.test(baseKit.C6??''))throw new Error('--base-kit has no PIN, reviewed AFTER and C6');
const pin=g('rev-parse','--verify',pinArg+'^{commit}').trim(),base=g('rev-parse','--verify',baseKit.PIN+'^{commit}').trim();
const BASE_C6=sha(g('show',`${base}:server/deploy/coolify/compose.coolify.yml`));
if(BASE_C6!==baseKit.C6)throw new Error(`the base kit's C6 ${baseKit.C6} is not the compose of its PIN ${baseKit.PIN} (${BASE_C6})`);
const after=opt('--after')??reviewed?.AFTER;
const envKeys=opt('--env-keys')??(reviewed?(reviewed.ENV_KEYS||'none'):undefined);
// Review C A3: whether the kit moves images is said here, never only deduced from the pin: a tier kit is --images none.
const images=opt('--images')??(reviewed?(reviewed.IMAGES||'none'):undefined);
if(images===undefined)throw new Error('--images <service,...>|none (the services whose image this kit moves; none for a tier-only kit)');
const since=opt('--since')??reviewed?.SINCE??new Date().toISOString().slice(0,10);
const show=f=>g('show',`${pin}:${f}`);
const D='server/deploy/coolify/r45/';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'r45h-kit-'));
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
let printed;
try{
 fs.mkdirSync(path.join(tmp,'retier'));
 for(const f of ['php-classes.mjs','gen-checks.mjs'])fs.writeFileSync(path.join(tmp,f),show(D+f));
 for(const f of ['gen-retier-php.mjs','env-keys-check.mjs'])fs.writeFileSync(path.join(tmp,'retier',f),show(D+'retier/'+f));
 const env={...process.env,R45_REPO:repo,R45_GIT:git};
 const node=(script,args)=>cp.execFileSync(process.execPath,[path.join(tmp,script),...args],{encoding:'utf8',env});
 printed=node('retier/gen-retier-php.mjs',['--base',base,'--base-raw',baseKit.AFTER,'--pin',pin,'--out',out,...(after?['--after',after]:[]),...(envKeys!==undefined?['--env-keys',envKeys]:[]),'--images',images]);
 node('gen-checks.mjs',['--option','c','--pin',pin,'--out',out,'--since',since]);
 const baseOut=path.join(tmp,'base-checks');fs.mkdirSync(baseOut);
 node('gen-checks.mjs',['--option','c','--pin',base,'--out',baseOut,'--since',since]);
 fs.writeFileSync(path.join(out,'env-check-base.sh'),fs.readFileSync(path.join(baseOut,'env-check.sh')));
 for(const [f,mode] of [['env-check.sh','after'],['env-check-base.sh','base']])node('retier/env-keys-check.mjs',['--check',path.join(out,f),'--added',path.join(out,'env-added.json'),'--mode',mode,...(fs.existsSync(path.join(out,'tier-keys.json'))?['--tier',path.join(out,'tier-keys.json')]:[])]);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
for(const f of ['read-raw-sha.php','oom-check.sh'])fs.writeFileSync(path.join(out,f),show(D+f));
fs.writeFileSync(path.join(out,'retier-window.sh'),show(D+'retier/retier-window.sh'));
fs.writeFileSync(path.join(out,'with-release-lock.sh'),show('server/deploy/vigia/with-release-lock.sh'));
for(const f of ['backup-before-redeploy.sh','ssamctl.sh','window-backup.sh'])fs.writeFileSync(path.join(out,f),show('server/deploy/coolify/'+f));
const C6=sha(show('server/deploy/coolify/compose.coolify.yml'));
fs.appendFileSync(path.join(out,'kit.env'),`SINCE=${since}\nC6=${C6}\nBASE_C6=${BASE_C6}\n`);
const STAGED=['kit.env','deploy-retier.php','export-retier-raw.php','rollback-retier.php','read-labels.php','read-raw-sha.php','env-check.sh',
 'env-check-base.sh','oom-check.sh','retier-window.sh','with-release-lock.sh','backup-before-redeploy.sh','ssamctl.sh','window-backup.sh'];
for(const f of STAGED){const b=fs.readFileSync(path.join(out,f));if(b.includes(13))throw new Error(f+' has CR bytes: the VPS runs it with bash/php');}
fs.writeFileSync(path.join(out,'SHA256SUMS'),STAGED.map(f=>`${sha(fs.readFileSync(path.join(out,f)))}  ${f}`).join('\n')+'\n');
const kit=readEnv(out);
// Review C A3, also when the pin's generator predates --images: kit.env says which images move (IMAGES, none when absent).
{const set=v=>v==='none'||!v?'':[...new Set(v.split(','))].sort().join();
 if(set(kit.IMAGES)!==set(images)){fs.rmSync(out,{recursive:true,force:true});throw new Error(`--images ${images} but the kit moves ${kit.IMAGES||'none'}: kit removed`);}}
console.log(JSON.stringify({kind:'retier',pin:kit.PIN,commit:pin,base:kit.BASE,mark:kit.MARK,before:kit.BEFORE,after:kit.AFTER,hot:{from:kit.HOT_FROM,to:kit.HOT_TO},envKeys:kit.ENV_KEYS?kit.ENV_KEYS.split(','):[],since,c6:C6,baseC6:BASE_C6,generator:JSON.parse(printed)}));
if(!reviewedDir)process.exit(0);
const problems=[];
for(const k of ['KIND','BASE','BEFORE','AFTER','IMAGES_CHANGE','SINCE','C6','BASE_C6','HOT_FROM','HOT_TO','ROUTER_SIZING_SHA','BASE_ROUTER_SIZING_SHA','ENV_KEYS','TIER_KEY_PATHS','IMAGE_PATHS','IMAGES'])if((kit[k]??'')!==(reviewed[k]??''))problems.push(`kit.env ${k}: reviewed ${reviewed[k]} new ${kit[k]}`);
if(kit.LABEL!==kit.MARK||reviewed.LABEL!==reviewed.MARK)problems.push('LABEL is not MARK');
const back=t=>t.split(kit.MARK).join(reviewed.MARK).split(kit.PIN).join(reviewed.PIN);
for(const f of [...STAGED,'expected-delta.json','env-added.json',...['tier-keys.json'].filter(t=>fs.existsSync(path.join(out,t))||fs.existsSync(path.join(reviewedDir,t)))]){
 const a=path.join(reviewedDir,f),b=path.join(out,f);
 if(!fs.existsSync(a)){problems.push(`${f}: not in the reviewed kit`);continue;}
 if(back(fs.readFileSync(b,'latin1'))!==fs.readFileSync(a,'latin1'))problems.push(`${f}: differs beyond PIN/MARK/LABEL`);
}
const names=d=>fs.readFileSync(path.join(d,'SHA256SUMS'),'utf8').split('\n').filter(Boolean).map(l=>l.slice(66));
if(JSON.stringify(names(out))!==JSON.stringify(names(reviewedDir)))problems.push('SHA256SUMS lists other files');
if(problems.length){console.log('KIT DIFF FAIL\n'+problems.join('\n'));process.exit(1);}
console.log(`KIT DIFF OK: only PIN ${reviewed.PIN} -> ${kit.PIN} and MARK/LABEL ${reviewed.MARK} -> ${kit.MARK}; BEFORE ${kit.BEFORE}; AFTER ${kit.AFTER}; C6 ${kit.C6}; SINCE ${kit.SINCE}`);
