// source-rules.mjs: which commit build-window-images.sh may turn into a production image (trilha D, the X1 correction
// window). Nothing here builds, pushes or logs in; git and docker are only read.
//
//   node deploy/window-images/source-rules.mjs signed --repo <dir> --commit <sha> --owner-key <ssh public key file>
//     exit 0 when the commit carries a signature of the owner's key (git verify-commit against an allowed-signers file of
//     that one key), 1 otherwise. `git log %G?` is not this check: without gpg.ssh.allowedSignersFile it says N for the
//     owner's signed merge, and with one it says G for ANY key that file lists.
//
//   node deploy/window-images/source-rules.mjs source --repo <dir> --source <sha> --fix <commit|patch file>[,...] --plan <plan.json>
//        [--owner-key <file>] [--ensaio] [--only 1.7.31,...]
//     The correction rule (an image of a production commit plus only the correction commit):
//       1. --source is not on the remote main (refs/remotes/origin/main): a commit of main is built with --commit;
//       2. --source has one parent, and that parent is the production commit of every pair it is built for: the
//          org.opencontainers.image.revision label of the pair image of versions.json (by digest, local), whose tag names it;
//       3. what --source changes against its parent is exactly what the correction changes (--fix: the commit as it was made,
//          or its patch file): the same files, the same removed and added lines in the same order (the context lines and
//          line numbers may differ: the bases are older than the commit the fix was written on);
//          with several corrections (--fix a,b, in the order they were made: X1 then X1d), --source is ONE commit whose tree
//          is exactly its parent's with each correction applied in that order (git apply --3way, as a cherry-pick, on a scratch index; a correction
//          that does not apply on the ones before it is refused);
//       4. without --ensaio, --source is signed by the owner's key (rule `signed`);
//       5. what --source changes is never the build recipe, the deploy tooling, compiled sources or outside server/
//          (NOT_A_CORRECTION); with --expect-fix <sha40>[,...] the corrections are exactly those reviewed commits in order,
//          and with --expect-blob <server/path>=<blob>[,...] each file has the reviewed blob in --source. Without --ensaio both
//          are required.
//     Prints {source, parent, fix, files[, expectFix, expectBlob]} as JSON; a refusal exits 1 with the reason.
//     CLI: [--expect-fix <sha40,...>] [--expect-blob <server/path>=<blob>,...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const SHA40=/^[0-9a-f]{40}$/,KEY=/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]*)?$/;
export const gitOf=repo=>(args,{allowFailure=false,input,env}={})=>{
 const r=cp.spawnSync('git',['-C',repo,'-c','core.pager=cat',...args],{encoding:'utf8',input,maxBuffer:256*1024*1024,...(env?{env:{...process.env,...env}}:{})});
 if(r.status!==0&&!allowFailure)throw Error(`git ${args.join(' ')}: ${(r.stderr||'').trim().split('\n').at(-1)}`);
 return allowFailure?{code:r.status,stdout:r.stdout,stderr:r.stderr}:r.stdout;
};
const full=(git,c)=>{const r=git(['rev-parse','--verify','-q',`${c}^{commit}`],{allowFailure:true});if(r.code!==0)throw Error(`${c} is not a commit here`);return r.stdout.trim();};

// The signature header of a commit object (gpgsig, its continuation lines unfolded), or null.
export function signatureOf(git,commit){
 const raw=git(['cat-file','commit',full(git,commit)]),head=raw.slice(0,raw.indexOf('\n\n')+1||raw.length).split('\n'),out=[];
 let i=head.findIndex(l=>/^gpgsig(-sha256)? /.test(l));if(i<0)return null;
 out.push(head[i].replace(/^gpgsig(-sha256)? /,''));while(head[++i]?.startsWith(' '))out.push(head[i].slice(1));
 return out.join('\n');
}
// The owner's signature, checked by her key alone. git verify-commit picks the verifier by the kind of signature: an
// OpenPGP or X.509 one would be checked by gpg/gpgsm against the keyring of whoever builds, where any trusted key passes
// (trilha C, B1). So the commit must carry an SSH signature, and gpg and gpgsm are switched off for the check.
export function ownerSigned(git,commit,keyFile){
 const key=fs.readFileSync(keyFile,'utf8').trim();
 if(!KEY.test(key))throw Error(`${keyFile} is not one ssh public key line`);
 if(!signatureOf(git,commit)?.startsWith('-----BEGIN SSH SIGNATURE-----'))return false;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-signers-')),allowed=path.join(dir,'allowed-signers');
 try{
  fs.writeFileSync(allowed,'owner '+key+'\n');
  return git(['-c','gpg.format=ssh','-c',`gpg.ssh.allowedSignersFile=${allowed.replaceAll('\\','/')}`,'-c','gpg.program=false','-c','gpg.x509.program=false',
   'verify-commit',full(git,commit)],{allowFailure:true}).code===0;
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

// What a unified diff changes, without context or line numbers: per file (in order), its header lines that carry meaning
// (modes, new/deleted, renames, binary) and every removed and added line in order. Reads `git diff` output and patch files
// (git format-patch: the mail header before the first `diff --git` and the signature after the last hunk are ignored, since
// every hunk is read by the counts of its @@ line).
export function changesOf(text){
 const lines=String(text).replace(/\r\n/g,'\n').split('\n'),files=[];let cur=null;
 for(let i=0;i<lines.length;){
  const l=lines[i];
  if(l.startsWith('diff --git ')){cur={file:l.slice(11),meta:[],lines:[]};files.push(cur);i++;continue;}
  if(!cur){i++;continue;}
  const h=/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
  if(h){
   let old=h[1]===undefined?1:+h[1],nw=h[2]===undefined?1:+h[2];i++;
   while(old>0||nw>0){
    const x=lines[i++];if(x===undefined)throw Error(`${cur.file}: a hunk ends before its @@ counts`);
    const c=x[0];
    if(c===' '||x===''){old--;nw--;}else if(c==='-'){cur.lines.push(x);old--;}else if(c==='+'){cur.lines.push(x);nw--;}
    else if(c==='\\')cur.lines.push(x);else throw Error(`${cur.file}: line "${x.slice(0,40)}" inside a hunk`);
   }
   while(lines[i]?.startsWith('\\'))cur.lines.push(lines[i++]);
   continue;
  }
  if(/^(old mode|new mode|deleted file mode|new file mode|rename from|rename to|copy from|copy to) /.test(l))cur.meta.push(l);
  else if(/^(Binary files |GIT binary patch)/.test(l))throw Error(`${cur.file}: a binary change; compare it by hand, the rule reads text only`);
  else if(/^(similarity|dissimilarity) index /.test(l))throw Error(`${cur.file}: a rename; give the correction as a commit (--fix <sha>), not as a patch`);
  i++;
 }
 return files;
}
const diffArgs=['diff','--no-color','--no-ext-diff','--no-textconv','--no-renames','--full-index','-U3'];
export const commitChanges=(git,from,to)=>changesOf(git([...diffArgs,from,to]));

// The first difference of two changesOf lists, in words, or null.
export function sameChanges(a,b){
 const fa=a.map(f=>f.file),fb=b.map(f=>f.file);
 const only=(x,y)=>x.filter(f=>!y.includes(f));
 if(only(fa,fb).length||only(fb,fa).length)return `files: the source changes [${fa.join(', ')}], the correction [${fb.join(', ')}]`;
 for(const f of a){const g=b.find(x=>x.file===f.file);
  if(JSON.stringify(f.meta)!==JSON.stringify(g.meta))return `${f.file}: mode or file lines differ (${f.meta.join('; ')} / ${g.meta.join('; ')})`;
  const n=Math.max(f.lines.length,g.lines.length);
  for(let k=0;k<n;k++)if(f.lines[k]!==g.lines[k])return `${f.file}: changed line ${k+1} differs: source ${JSON.stringify(f.lines[k]??'(none)')}, correction ${JSON.stringify(g.lines[k]??'(none)')}`;
 }
 return null;
}

// The production commit of a pair image: its revision label, which its tag must name (prod-<date>[-rNN]-<sha7>-...).
export function productionCommit(inspect,source){
 const rev=inspect(['image','inspect','-f','{{index .Config.Labels "org.opencontainers.image.revision"}}',source]).trim();
 if(!SHA40.test(rev))throw Error(`${source}: label org.opencontainers.image.revision is ${JSON.stringify(rev)}, not a commit (a -dirty build is no production commit)`);
 const tag=(source.match(/:([A-Za-z0-9_][A-Za-z0-9_.-]*)@sha256:/)??[])[1];
 if(tag&&!tag.split('-').includes(rev.slice(0,7)))throw Error(`${source}: the tag does not name its revision ${rev.slice(0,7)}`);
 return rev;
}
// DOCKER_BIN: another docker; a .mjs one runs with this node (the tests' fake docker).
const dockerInspect=args=>{const b=process.env.DOCKER_BIN??'docker';return b.endsWith('.mjs')?cp.execFileSync(process.execPath,[b,...args],{encoding:'utf8'}):cp.execFileSync(b,args,{encoding:'utf8'});};

// One correction: a commit (its diff against its one parent) or a patch file; its changes and the patch git apply takes.
function fixOf(git,fix,src,readFile){
 const asCommit=git(['rev-parse','--verify','-q',`${fix}^{commit}`],{allowFailure:true});
 let patch,name,id;
 if(asCommit.code===0){
  const c=asCommit.stdout.trim(),ps=git(['rev-list','--parents','-n','1',c]).trim().split(' ').slice(1);
  if(ps.length!==1)throw Error(`the correction ${fix} has ${ps.length} parents: name the one commit of the correction`);
  if(c===src)throw Error('--fix is --source itself: name the correction as it was made (the commit of trilha A, or its patch)');
  patch=git([...diffArgs,ps[0],c]);name=c;id=c;
 // A patch is named by its content, not only its file name: two different patches never look the same in source.json and
 // built.json (trilha C, B4).
 }else if(fs.existsSync(fix)){patch=readFile(fix);name=`${path.basename(fix)}@sha256:${crypto.createHash('sha256').update(patch).digest('hex')}`;id=path.resolve(fix);}
 else throw Error(`--fix ${fix} is neither a commit here nor a patch file`);
 const changes=changesOf(patch);
 if(!changes.length||changes.every(f=>!f.lines.length&&!f.meta.length))throw Error(`the correction ${name} changes nothing`);
 return {name,id,patch,changes};
}
// The tree of parent with the corrections applied in order (git apply --cached on a scratch index; nothing else is touched).
function appliedTree(git,parent,fixes){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-fixes-')),env={GIT_INDEX_FILE:path.join(dir,'index')};
 try{
  git(['read-tree',parent],{env});
  fixes.forEach((x,i)=>{
   const r=git(['apply','--cached','--3way','--whitespace=nowarn','-'],{env,input:x.patch,allowFailure:true});
   if(r.code!==0)throw Error(`the correction ${x.name} does not apply on ${parent.slice(0,7)}${i?' after '+fixes.slice(0,i).map(y=>y.name).join(', '):''}: ${(r.stderr||'').trim().split('\n').at(-1)}`);
  });
  return git(['write-tree'],{env}).trim();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}

// What a correction image may carry: files under server/ that `COPY . /app` takes as they are. Never the build recipe
// (Dockerfile, .dockerignore, docker/, the package manifests and lockfiles), the deploy tooling, what the build compiles
// (kernel/, the ODC builder under platforms/odc/studio/) or anything outside server/: a change there is a release of main,
// not a correction image (trilha C, B2: a --fix that carried the Dockerfile along passed the rule).
export const NOT_A_CORRECTION=/^(?!server\/)|^server\/(Dockerfile[^/]*|\.dockerignore|docker\/|deploy\/|kernel\/|platforms\/odc\/studio\/|(platforms\/odc\/)?(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$)/;
// --expect-blob <server/path>=<blob sha, 7 to 40 hex>[,...]: the blob each named file must have in --source.
export function parseExpectBlob(text){
 return String(text??'').split(',').map(x=>x.trim()).filter(Boolean).map(x=>{
  const m=/^(server\/[^=\s]+)=([0-9a-f]{7,40})$/.exec(x);if(!m)throw Error(`--expect-blob ${x}: not <server/path>=<blob sha>`);return {path:m[1],blob:m[2]};});
}

export function checkSource({git,source,fix,plan,ownerKey=null,ensaio=false,expectFix=null,expectBlob=null,inspect=dockerInspect,readFile=f=>fs.readFileSync(f,'utf8')}){
 const src=full(git,source);
 if(git(['rev-parse','--verify','-q','refs/remotes/origin/main'],{allowFailure:true}).code!==0)throw Error('no refs/remotes/origin/main: git fetch origin first');
 if(git(['merge-base','--is-ancestor',src,'refs/remotes/origin/main'],{allowFailure:true}).code===0)
  throw Error(`${source} is on the remote main: an image of main is built with --commit, not --source`);
 const parents=git(['rev-list','--parents','-n','1',src]).trim().split(' ').slice(1);
 if(parents.length!==1)throw Error(`${source} has ${parents.length} parents: the correction is one commit on top of the production commit, never a merge`);
 const [parent]=parents;
 if(!plan.length)throw Error('no pair to build');
 for(const p of plan){
  const prod=new Set(p.sources.map(s=>productionCommit(inspect,s)));
  if(prod.size!==1)throw Error(`pair ${p.id}: its Studio images come from ${prod.size} commits`);
  const [c]=prod;
  if(c!==parent)throw Error(`the parent of ${source} is ${parent.slice(0,7)}, but the production commit of pair ${p.id} (ODC ${p.odc}) is ${c.slice(0,7)}: build each base with its own --source and --only`);
 }
 const names=String(fix).split(',').map(x=>x.trim()).filter(Boolean);
 if(!names.length)throw Error('--fix names no correction');
 const fixes=names.map(f=>fixOf(git,f,src,readFile));
 if(new Set(fixes.map(x=>x.id)).size!==fixes.length)throw Error(`--fix names a correction twice (${names.join(', ')})`);
 const fixName=fixes.map(x=>x.name).join(','),mine=commitChanges(git,parent,src);
 // One correction or several, the proof is the tree: the parent with each correction applied in order must be --source's
 // tree. Comparing only the changed lines (sameChanges) let the right change in the wrong place pass (trilha C, B3); it now
 // only words the refusal of a single correction.
 const want=appliedTree(git,parent,fixes),have=git(['rev-parse',`${src}^{tree}`]).trim();
 if(want!==have){
  const files=git(['diff','--name-only','--no-renames',want,have]).trim().split('\n').filter(Boolean);
  if(fixes.length===1){
   const why=sameChanges(mine,fixes[0].changes)??`the same lines change, but not where the correction changes them (${files.join(', ')})`;
   throw Error(`${source} against its parent ${parent.slice(0,7)} is not only the correction ${fixName}: ${why}`);
  }
  throw Error(`${source} against its parent ${parent.slice(0,7)} is not only the corrections ${fixName} applied in that order: it differs from them in [${files.join(', ')}]`);
 }
 const files=mine.map(f=>f.file.replace(/^a\/(.*) b\/.*$/,'$1'));
 const recipe=files.filter(f=>NOT_A_CORRECTION.test(f));
 if(recipe.length)throw Error(`${source} changes [${recipe.join(', ')}]: the build recipe, the deploy tooling, compiled sources or files outside server/ are never a correction image (a release of main)`);
 // The reviewed corrections, by their full commit ids in order, and the blob each corrected file must have: without them
 // the rule only proves "the parent plus whatever --fix says" (trilha C, B2).
 if(expectFix!=null){
  const want=String(expectFix).split(',').map(x=>x.trim()).filter(Boolean);
  if(!want.length||!want.every(x=>SHA40.test(x)))throw Error('--expect-fix takes the full 40-hex ids of the reviewed corrections, in order');
  const have=fixes.map(x=>x.name);
  if(have.join(',')!==want.join(','))throw Error(`--fix is [${have.join(', ')}], the reviewed corrections are [${want.join(', ')}] (--expect-fix): the image carries those, as commits, in that order`);
 }
 const blobs=parseExpectBlob(expectBlob);
 for(const b of blobs){
  const r=git(['rev-parse','--verify','-q',`${src}:${b.path}`],{allowFailure:true}),got=r.code===0?r.stdout.trim():'(absent)';
  if(!got.startsWith(b.blob))throw Error(`${b.path} in ${source} is blob ${got.slice(0,12)}, not the reviewed ${b.blob} (--expect-blob)`);
 }
 if(!ensaio){
  if(!ownerKey)throw Error('--owner-key <ssh public key file of the owner> is required for a production image');
  if(expectFix==null||!blobs.length)throw Error('--expect-fix <the reviewed correction commits> and --expect-blob <server/path>=<blob> are required for a production image');
  // Every file the correction changes, not only one (trilha C, B3b): a file left out of --expect-blob is held by nothing.
  const named=new Set(blobs.map(b=>b.path)),loose=files.filter(f=>!named.has(f));
  if(loose.length)throw Error(`--expect-blob names ${[...named].join(', ')}, but the correction also changes ${loose.join(', ')}: a production image needs the reviewed blob of every file it changes`);
  if(!ownerSigned(git,src,ownerKey))throw Error(`${source} is not signed by the owner's key (${path.basename(ownerKey)}): the correction image is the commit she signs`);
 }
 return {source:src,parent,fix:fixName,files,...(expectFix!=null?{expectFix:String(expectFix)}:{}),...(blobs.length?{expectBlob:blobs}:{})};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [cmd,...rest]=process.argv.slice(2),a={};
 for(let i=0;i<rest.length;i++){const k=rest[i];if(k==='--ensaio'){a.ensaio=true;continue;}if(!k.startsWith('--')||rest[i+1]===undefined){console.error(`source-rules: unknown or incomplete argument ${k}`);process.exit(2);}a[k.slice(2)]=rest[++i];}
 try{
  const git=gitOf(a.repo??'.');
  if(cmd==='signed'){
   if(!a.commit||!a['owner-key'])throw Error('signed --commit <sha> --owner-key <file>');
   if(!ownerSigned(git,a.commit,a['owner-key'])){console.error(`source-rules: ${a.commit} is not signed by the owner's key (${path.basename(a['owner-key'])})`);process.exit(1);}
   console.log(`signed by the owner's key (${path.basename(a['owner-key'])})`);
  }else if(cmd==='source'){
   if(!a.source||!a.fix||!a.plan)throw Error('source --source <sha> --fix <commit|patch>[,...] --plan <plan.json>');
   const only=a.only?a.only.split(','):null,plan=JSON.parse(fs.readFileSync(a.plan,'utf8')).filter(p=>!only||only.includes(p.odc));
   console.log(JSON.stringify(checkSource({git,source:a.source,fix:a.fix,plan,ownerKey:a['owner-key']??null,ensaio:!!a.ensaio,expectFix:a['expect-fix']??null,expectBlob:a['expect-blob']??null})));
  }else throw Error('signed | source');
 }catch(e){console.error(`source-rules: ${e.message}`);process.exit(1);}
}
