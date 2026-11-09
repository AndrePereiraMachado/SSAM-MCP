// node kit.mjs --option c --pin <rev> --out <dir> [--reviewed <dir>] [--after <sha256>] [--since <YYYY-MM-DD>] [--repo <checkout>]
// Builds the r45 kit for one option ENTIRELY from one commit (review R4 B1/B2): the generators (this folder) are read from
// <rev> with git show and run from a private copy, the PHP and env-check.sh they write describe <rev>'s compose, and every
// script the kit runs on the VPS is <rev>'s own bytes: r45-window.sh, rollback-check.sh, read-raw-sha.php, oom-check.sh
// (server/deploy/coolify/r45), with-release-lock.sh (server/deploy/vigia) and backup-before-redeploy.sh, ssamctl.sh,
// window-backup.sh (server/deploy/coolify). Writes <out>/SHA256SUMS (r45-window.sh refuses any staged file that differs).
// kit.env also records SINCE (the env-check day) and C6 (sha256 of <rev>'s compose.coolify.yml).
// --reviewed <dir>: the kit that was reviewed (e.g. the one made from the branch tip before the signed merge into main).
// AFTER, SINCE and OPTION default to its own, and the new kit must equal it byte for byte once its PIN and MARK/LABEL are
// put back to the reviewed ones; OPTION, BEFORE, AFTER, IMAGES_CHANGE, SINCE and C6 must be the same. Prints KIT DIFF OK
// or KIT DIFF FAIL with every difference (exit 1). Nothing here touches the VPS.
// --repo: the SSAM-MCP checkout that holds <rev> (default R45_REPO, else C:/t/r5/wt-capacity).
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import cp from 'node:child_process';import crypto from 'node:crypto';
const argv=process.argv.slice(2),opt=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:undefined;};
const git=process.env.R45_GIT??'C:/Program Files/Git/cmd/git.exe',repo=opt('--repo')??process.env.R45_REPO??'C:/t/r5/wt-capacity';
const g=(...a)=>cp.execFileSync(git,['-C',repo,...a],{encoding:'utf8',maxBuffer:64<<20});
const readEnv=dir=>Object.fromEntries(fs.readFileSync(path.join(dir,'kit.env'),'utf8').split('\n').filter(Boolean).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
const reviewedDir=opt('--reviewed'),reviewed=reviewedDir?readEnv(reviewedDir):null;
const OPTION=opt('--option')??reviewed?.OPTION;if(!['a','c'].includes(OPTION))throw new Error('--option a|c');
const pinArg=opt('--pin');if(!pinArg)throw new Error('--pin <rev>');
const out=opt('--out');if(!out)throw new Error('--out <dir>');
if(reviewedDir&&path.resolve(out)===path.resolve(reviewedDir))throw new Error('--out must not be the reviewed kit');
const pin=g('rev-parse','--verify',pinArg+'^{commit}').trim();
const after=opt('--after')??reviewed?.AFTER;
const since=opt('--since')??reviewed?.SINCE??new Date().toISOString().slice(0,10);
const D='server/deploy/coolify/r45/';
const show=f=>g('show',`${pin}:${f}`);
// The generators of the pin, from a private copy.
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'r45-kit-'));
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
let printed;
try{
 for(const f of g('ls-tree','--name-only',pin,D).split('\n').filter(Boolean))fs.writeFileSync(path.join(tmp,path.basename(f)),show(f));
 const env={...process.env,R45_REPO:repo,R45_GIT:git};
 const node=(script,args)=>cp.execFileSync(process.execPath,[path.join(tmp,script),...args],{encoding:'utf8',env});
 printed=node('gen-deploy-php.mjs',['--option',OPTION,'--pin',pin,'--out',out,...(after?['--after',after]:[]),...(OPTION==='a'?['--allow-images']:[])]);
 node('gen-checks.mjs',['--option',OPTION,'--pin',pin,'--out',out,'--since',since]);
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
for(const f of ['r45-window.sh','rollback-check.sh','read-raw-sha.php','oom-check.sh'])fs.writeFileSync(path.join(out,f),show(D+f));
fs.writeFileSync(path.join(out,'with-release-lock.sh'),show('server/deploy/vigia/with-release-lock.sh'));
for(const f of ['backup-before-redeploy.sh','ssamctl.sh','window-backup.sh'])fs.writeFileSync(path.join(out,f),show('server/deploy/coolify/'+f));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const C6=sha(show('server/deploy/coolify/compose.coolify.yml'));
fs.appendFileSync(path.join(out,'kit.env'),`SINCE=${since}\nC6=${C6}\n`);
const STAGED=['kit.env','deploy-coolify.php','export-coolify-raw.php','rollback-coolify.php','read-labels.php','read-raw-sha.php','env-check.sh',
 'rollback-check.sh','oom-check.sh','r45-window.sh','with-release-lock.sh','backup-before-redeploy.sh','ssamctl.sh','window-backup.sh'];
for(const f of STAGED){const b=fs.readFileSync(path.join(out,f));if(b.includes(13))throw new Error(f+' has CR bytes: the VPS runs it with bash/php');}
fs.writeFileSync(path.join(out,'SHA256SUMS'),STAGED.map(f=>`${sha(fs.readFileSync(path.join(out,f)))}  ${f}`).join('\n')+'\n');
const kit=readEnv(out);
console.log(JSON.stringify({option:OPTION,pin:kit.PIN,commit:pin,mark:kit.MARK,after:kit.AFTER,since,c6:C6,generator:JSON.parse(printed)}));
if(!reviewedDir)process.exit(0);
// The diff against the reviewed kit: only PIN and MARK/LABEL may move.
const problems=[];
for(const k of ['OPTION','BEFORE','AFTER','IMAGES_CHANGE','SINCE','C6'])if(kit[k]!==reviewed[k])problems.push(`kit.env ${k}: reviewed ${reviewed[k]} new ${kit[k]}`);
if(kit.LABEL!==kit.MARK||reviewed.LABEL!==reviewed.MARK)problems.push('LABEL is not MARK');
const back=t=>t.split(kit.MARK).join(reviewed.MARK).split(kit.PIN).join(reviewed.PIN);
const compared=[...STAGED,'expected-delta.json'];
for(const f of compared){
 const a=path.join(reviewedDir,f),b=path.join(out,f);
 if(!fs.existsSync(a)){problems.push(`${f}: not in the reviewed kit`);continue;}
 if(back(fs.readFileSync(b,'latin1'))!==fs.readFileSync(a,'latin1'))problems.push(`${f}: differs beyond PIN/MARK/LABEL`);
}
const names=d=>fs.readFileSync(path.join(d,'SHA256SUMS'),'utf8').split('\n').filter(Boolean).map(l=>l.slice(66));
if(JSON.stringify(names(out))!==JSON.stringify(names(reviewedDir)))problems.push('SHA256SUMS lists other files');
if(problems.length){console.log('KIT DIFF FAIL\n'+problems.join('\n'));process.exit(1);}
console.log(`KIT DIFF OK: only PIN ${reviewed.PIN} -> ${kit.PIN} and MARK/LABEL ${reviewed.MARK} -> ${kit.MARK}; AFTER ${kit.AFTER}; C6 ${kit.C6}; SINCE ${kit.SINCE}`);
