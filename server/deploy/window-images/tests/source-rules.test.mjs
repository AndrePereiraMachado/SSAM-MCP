// source-rules.test.mjs: the rule of a correction image (trilha D, the X1 window), on a throwaway git repository with
// throwaway ssh keys; no docker (the pair image labels are a fake inspect). From server/:
//   node --test deploy/window-images/tests/source-rules.test.mjs
// Must refuse: a wrong parent, a difference larger than the correction, an unsigned source, a source signed by another
// key, a source on main, a merge; must accept the cherry-pick of the correction on the production commit even when the
// context lines around it differ, given as the commit or as its patch file.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import cp from 'node:child_process';
import {checkSource,ownerSigned,signatureOf,changesOf,sameChanges,gitOf,productionCommit} from '../source-rules.mjs';

const keygen=cp.spawnSync('ssh-keygen',['-?'],{encoding:'utf8'}).error?null:'ssh-keygen';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ssam-source-rules-')),repo=path.join(tmp,'repo');
const fwd=p=>p.replaceAll('\\','/');
const run=(args,opts={})=>{const r=cp.spawnSync('git',['-C',repo,'-c','user.name=t','-c','user.email=t@t','-c','commit.gpgsign=false','-c','core.autocrlf=false',...args],{encoding:'utf8',...opts});if(r.status!==0)throw Error(`git ${args.join(' ')}: ${r.stderr}`);return r.stdout.trim();};
const write=(f,t)=>{fs.mkdirSync(path.dirname(path.join(repo,f)),{recursive:true});fs.writeFileSync(path.join(repo,f),t);};
const commit=(msg,extra=[])=>{run(['add','-A']);run([...extra,'commit','-q','-m',msg]);return run(['rev-parse','HEAD']);};
const keys={};
for(const k of ['owner','other'])keys[k]=path.join(tmp,k);
const budget=n=>Array.from({length:40},(_,i)=>i===20?`const key = {scope, args};${n}`:`line ${i}`).join('\n')+'\n';

// The history: base -> P (production) -> main moves on (other lines near the fix change) -> C, the correction written on main.
fs.mkdirSync(repo);run(['init','-q','-b','main']);
write('server/read-budget.mjs',budget(''));write('server/other.mjs','a\n');const base=commit('base');
write('server/other.mjs','a\nb\n');const P=commit('production');
write('server/read-budget.mjs',budget('').replace('line 18','line 18 changed on main').replace('line 23','line 23 changed on main'));const M=commit('main moves on');
run(['update-ref','refs/remotes/origin/main',M]);
run(['checkout','-q','-b','fix']);write('server/read-budget.mjs',fs.readFileSync(path.join(repo,'server/read-budget.mjs'),'utf8').replace('const key = {scope, args};','const key = {scope, client, args};'));const C=commit('fix: the client in the key');
const patchFile=path.join(tmp,'x1-correcao.patch');fs.writeFileSync(patchFile,run(['format-patch','--stdout','-1',C])+'\n');
// H: C cherry-picked on P (the context lines 18 and 23 differ from main's).
run(['checkout','-q','--detach',P]);run(['cherry-pick',C]);const H=run(['rev-parse','HEAD']);
// One commit on P with the correction and one more change.
run(['checkout','-q','--detach',P]);run(['cherry-pick','-n',C]);write('server/other.mjs','a\nb\nc\n');const bigger=commit('fix plus something else');
// One commit on P with the correction and one more line in the same file.
run(['checkout','-q','--detach',P]);run(['cherry-pick','-n',C]);write('server/read-budget.mjs',fs.readFileSync(path.join(repo,'server/read-budget.mjs'),'utf8')+'extra\n');const biggerSameFile=commit('fix plus a line');
// The correction cherry-picked on main's tip (a wrong parent), and a merge.
run(['checkout','-q','--detach',M]);run(['cherry-pick',C]);const onMain=run(['rev-parse','HEAD']);
run(['checkout','-q','--detach',P]);run(['merge','-q','--no-ff','--no-edit',C]);const merge=run(['rev-parse','HEAD']);
let signedH=null,otherH=null;
if(keygen){
 for(const k of Object.values(keys))cp.execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-C','test','-f',k]);
 const sign=k=>{run(['checkout','-q','--detach',P]);run(['-c','gpg.format=ssh','-c',`user.signingkey=${fwd(k)}`,'cherry-pick','-S',C]);return run(['rev-parse','HEAD']);};
 signedH=sign(keys.owner);otherH=sign(keys.other);
}
const git=gitOf(repo),img=c=>`docker.io/andrepereiramachado/ssam-server:prod-20261103-r43b-${c.slice(0,7)}-o115594-odc1730@sha256:${'a'.repeat(64)}`;
const plan=(c=P)=>[{id:'o11-11.55.94-odc-1.7.30',odc:'1.7.30',sources:[img(c)]}];
const known=[P,M,base],inspect=args=>{const m=args.at(-1).match(/-([0-9a-f]{7})-o11/);const c=known.find(x=>x.startsWith(m[1]));return c+'\n';};
const ok=o=>checkSource({git,plan:plan(),inspect,ensaio:true,...o});

test('accepts the correction cherry-picked on the production commit, as the commit or as its patch file, with other context lines',()=>{
 const r=ok({source:H,fix:C});assert.equal(r.parent,P);assert.deepEqual(r.files,['server/read-budget.mjs']);
 const sha=f=>cp.execFileSync(process.execPath,['-e','process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1],"utf8")).digest("hex"))',f],{encoding:'utf8'});
 assert.equal(ok({source:H,fix:patchFile}).fix,`x1-correcao.patch@sha256:${sha(patchFile)}`,'B4 (trilha C): a patch is named by its content');
 // Another patch under the same file name: a different name in source.json.
 const other=path.join(tmp,'outro');fs.mkdirSync(other,{recursive:true});const p2=path.join(other,'x1-correcao.patch');fs.writeFileSync(p2,fs.readFileSync(patchFile,'utf8').replace(/^Subject: .*$/m,'Subject: [PATCH] another'));
 assert.notEqual(ok({source:H,fix:p2}).fix,ok({source:H,fix:patchFile}).fix);
 assert.notEqual(run(['show','--format=','-U3',H]),run(['show','--format=','-U3',C]),'the context lines do differ');
});

test('refuses: --source on main, a wrong parent, a merge, more than the correction, a correction that is --source itself',()=>{
 assert.throws(()=>ok({source:M,fix:C}),/on the remote main: an image of main is built with --commit/);
 assert.throws(()=>ok({source:base,fix:C}),/on the remote main/);
 assert.throws(()=>ok({source:onMain,fix:C}),/the parent of .* is [0-9a-f]{7}, but the production commit of pair o11-11.55.94-odc-1.7.30 \(ODC 1.7.30\) is/);
 assert.throws(()=>checkSource({git,plan:plan(base),inspect,ensaio:true,source:H,fix:C}),/production commit of pair .* is /,'the pair of another production commit');
 assert.throws(()=>ok({source:merge,fix:C}),/2 parents/);
 assert.throws(()=>ok({source:bigger,fix:C}),/files: the source changes \[a\/server\/other.mjs b\/server\/other.mjs, a\/server\/read-budget.mjs/);
 assert.throws(()=>ok({source:bigger,fix:patchFile}),/is not only the correction x1-correcao.patch/);
 assert.throws(()=>ok({source:biggerSameFile,fix:C}),/server\/read-budget.mjs: changed line 3 differs: source "\+extra", correction "\(none\)"/);
 assert.throws(()=>ok({source:H,fix:H}),/--fix is --source itself/);
 assert.throws(()=>ok({source:H,fix:path.join(tmp,'none.patch')}),/neither a commit here nor a patch file/);
 assert.throws(()=>checkSource({git,plan:[],inspect,ensaio:true,source:H,fix:C}),/no pair/);
});

test('several corrections (X1 then X1d): one commit on the production commit whose tree is them applied in order; order, a missing one, more, twice refused',()=>{
 // On the fix branch: a test-only commit, then C2, which needs C (it edits C's line): the parent of C2 is not C.
 run(['checkout','-q','fix']);write('server/tests/t.mjs','t\n');commit('test only');
 write('server/read-budget.mjs',fs.readFileSync(path.join(repo,'server/read-budget.mjs'),'utf8').replace('const key = {scope, client, args};','const key = {scope, client, args, owner};'));const C2=commit('fix: X1d, the owner');
 const patch2=path.join(tmp,'x1d-limite.patch');fs.writeFileSync(patch2,run(['format-patch','--stdout','-1',C2])+'\n');
 const onP=(picks,extra)=>{run(['checkout','-q','--detach',P]);for(const c of picks)run(['cherry-pick','-n',c]);if(extra)extra();return commit('correction '+picks.length);};
 const H2=onP([C,C2]);
 const r=ok({source:H2,fix:`${C},${C2}`});assert.equal(r.parent,P);assert.equal(r.fix,`${C},${C2}`);assert.deepEqual(r.files,['server/read-budget.mjs']);
 assert.match(ok({source:H2,fix:`${patchFile}, ${patch2}`}).fix,/^x1-correcao\.patch@sha256:[0-9a-f]{64},x1d-limite\.patch@sha256:[0-9a-f]{64}$/,'as patch files');
 assert.throws(()=>ok({source:H2,fix:`${C2},${C}`}),/the correction [0-9a-f]{40} does not apply on [0-9a-f]{7}/,'X1d before X1');
 assert.throws(()=>ok({source:H2,fix:C2}),/is not only the correction|does not apply on/,'X1d alone does not explain H2');
 assert.throws(()=>ok({source:H2,fix:C}),/is not only the correction/,'X1 alone does not explain H2');
 assert.throws(()=>ok({source:H,fix:`${C},${C2}`}),/is not only the corrections .* applied in that order: it differs from them in \[server\/read-budget.mjs\]/,'H lacks X1d');
 const more=onP([C,C2],()=>write('server/other.mjs','a\nb\nc\n'));
 assert.throws(()=>ok({source:more,fix:`${C},${C2}`}),/differs from them in \[server\/other.mjs\]/);
 assert.throws(()=>ok({source:H2,fix:`${C},${C}`}),/a correction twice/);
 assert.throws(()=>ok({source:H2,fix:' , '}),/names no correction/);
 // Two commits (X1, then X1d on it) are not one correction commit: the parent of the tip is not the production commit.
 run(['checkout','-q','--detach',P]);run(['cherry-pick',C]);run(['cherry-pick',C2]);const chain=run(['rev-parse','HEAD']);
 assert.throws(()=>ok({source:chain,fix:`${C},${C2}`}),/the parent of .* is [0-9a-f]{7}, but the production commit/);
});

test('B3 (trilha C): one correction is proved by the tree too: the same change in the wrong place is refused',()=>{
 // A production commit with two equal lines; the correction changes the first, the wrong source the second.
 run(['checkout','-q','--detach',P]);write('server/two.mjs','function a() {\n  return 10;\n}\nfunction b() {\n  return 10;\n}\n');const P2=commit('production with two equal lines');known.push(P2);
 const on=(line,msg)=>{run(['checkout','-q','--detach',P2]);const t=fs.readFileSync(path.join(repo,'server/two.mjs'),'utf8').split('\n');t[line]='  return 5;';write('server/two.mjs',t.join('\n'));return commit(msg);};
 const F=on(1,'fix: a() returns 5'),right=on(1,'source: a()'),wrong=on(4,'source: b()');
 const at=o=>checkSource({git,plan:plan(P2),inspect,ensaio:true,...o});
 assert.equal(at({source:right,fix:F}).parent,P2);
 assert.throws(()=>at({source:wrong,fix:F}),/is not only the correction [0-9a-f]{40}: the same lines change, but not where the correction changes them \(server\/two.mjs\)/);
 const pf=path.join(tmp,'two.patch');fs.writeFileSync(pf,run(['format-patch','--stdout','-1',F])+'\n');
 assert.throws(()=>at({source:wrong,fix:pf}),/not where the correction changes them/,'as a patch file');
});

test('B2 (trilha C): --fix is tied to the reviewed corrections and blobs; a correction never carries the build recipe',()=>{
 const blob=run(['rev-parse',`${H}:server/read-budget.mjs`]);
 assert.deepEqual(ok({source:H,fix:C,expectFix:C,expectBlob:`server/read-budget.mjs=${blob.slice(0,8)}`}).expectBlob,[{path:'server/read-budget.mjs',blob:blob.slice(0,8)}]);
 assert.throws(()=>ok({source:H,fix:patchFile,expectFix:C}),/--fix is \[x1-correcao.patch.*\], the reviewed corrections are/,'a patch is not the reviewed commit');
 assert.throws(()=>ok({source:H,fix:C,expectFix:C.slice(0,8)}),/full 40-hex ids/);
 assert.throws(()=>ok({source:H,fix:C,expectFix:P}),/the reviewed corrections are/);
 assert.throws(()=>ok({source:H,fix:C,expectBlob:'server/read-budget.mjs=c7ec887c'}),/is blob [0-9a-f]{12}, not the reviewed c7ec887c/);
 assert.throws(()=>ok({source:H,fix:C,expectBlob:'server/none.mjs=c7ec887c'}),/is blob \(absent\)/);
 assert.throws(()=>ok({source:H,fix:C,expectBlob:'read-budget.mjs=c7'}),/not <server\/path>=<blob sha>/);
 // A "correction" that carries the Dockerfile along, given as the --fix that explains it: refused by what it touches.
 for(const f of ['server/Dockerfile','server/.dockerignore','server/package.json','server/platforms/odc/pnpm-lock.yaml','server/deploy/x.sh','server/kernel/src/K.cs','server/platforms/odc/studio/builder/B.cs','agent/a.js']){
  run(['checkout','-q','--detach',P]);run(['cherry-pick','-n',C]);write(f,'changed\n');const S=commit('fix plus '+f);
  const F=(()=>{run(['checkout','-q','--detach',base]);run(['cherry-pick','-n',C]);write(f,'changed\n');return commit('the fix plus '+f+', as a fix');})();
  assert.throws(()=>ok({source:S,fix:F}),new RegExp(`changes \\[.*${f.replace(/[.]/g,'\\.')}.*\\]: the build recipe`),f);
 }
});

test('without --ensaio: refuses an unsigned source, a source signed by another key, and no --owner-key; accepts the owner\'s signature',{skip:!keygen&&'no ssh-keygen'},()=>{
 const blob=run(['rev-parse',`${H}:server/read-budget.mjs`]);
 const prod=o=>checkSource({git,plan:plan(),inspect,fix:C,ownerKey:keys.owner+'.pub',expectFix:C,expectBlob:`server/read-budget.mjs=${blob}`,...o});
 assert.throws(()=>prod({source:signedH,expectFix:null}),/--expect-fix .* and --expect-blob .* are required for a production image/);
 assert.throws(()=>prod({source:signedH,expectBlob:null}),/are required for a production image/);
 // B3b (trilha C): a correction of two files with the blob of one is refused before anything else is checked.
 run(['checkout','-q','--detach',P]);run(['cherry-pick','-n',C]);write('server/b3b-extra.mjs','extra\n');const S2=commit('fix of two files');known.push(S2);
 const F2=(()=>{run(['checkout','-q','--detach',base]);run(['cherry-pick','-n',C]);write('server/b3b-extra.mjs','extra\n');return commit('the fix of two files');})();
 assert.throws(()=>prod({source:S2,fix:F2,expectFix:F2}),/--expect-blob names server\/read-budget.mjs, but the correction also changes server\/b3b-extra.mjs/);
 assert.throws(()=>prod({source:S2,fix:F2,expectFix:F2,expectBlob:`server/read-budget.mjs=${blob},server/b3b-extra.mjs=${run(['rev-parse',`${S2}:server/b3b-extra.mjs`])}`}),/is not signed by the owner's key/,'with every blob, the next check');
 assert.throws(()=>prod({source:H}),/is not signed by the owner's key \(owner.pub\)/);
 assert.throws(()=>prod({source:otherH}),/is not signed by the owner's key/);
 assert.throws(()=>prod({source:signedH,ownerKey:null}),/--owner-key/);
 assert.equal(prod({source:signedH}).source,signedH);
 assert.equal(ownerSigned(git,signedH,keys.owner+'.pub'),true);assert.equal(ownerSigned(git,signedH,keys.other+'.pub'),false);assert.equal(ownerSigned(git,H,keys.owner+'.pub'),false);
 fs.writeFileSync(path.join(tmp,'bad.pub'),'not a key\n');assert.throws(()=>ownerSigned(git,signedH,path.join(tmp,'bad.pub')),/not one ssh public key line/);
 // B1 (trilha C): an OpenPGP signature is never the owner's, whatever the keyring of the build machine trusts. The commit
 // object of signedH with its SSH signature swapped for a PGP block: refused before any verifier runs.
 assert.match(signatureOf(git,signedH),/^-----BEGIN SSH SIGNATURE-----\n/);assert.equal(signatureOf(git,H),null);
 const raw=run(['cat-file','commit',signedH]),pgp=raw.replace(/^gpgsig [\s\S]*?-----END SSH SIGNATURE-----\n/m,'gpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n');
 assert.notEqual(pgp,raw);
 const pgpH=cp.spawnSync('git',['-C',repo,'hash-object','-t','commit','-w','--stdin'],{input:pgp,encoding:'utf8'}).stdout.trim();
 assert.match(signatureOf(git,pgpH),/^-----BEGIN PGP SIGNATURE-----/);
 assert.equal(ownerSigned(git,pgpH,keys.owner+'.pub'),false);
 assert.throws(()=>prod({source:pgpH}),/is not signed by the owner's key/);
 // A signature of another key passes `%G?` once any allowed-signers file lists that key; the rule names the owner's alone.
 const out=cp.spawnSync('git',['-C',repo,'log','-1','--format=%G?',otherH],{encoding:'utf8'}).stdout.trim();assert.equal(out,'N','without allowed signers %G? says N even for a signed commit');
});

test('changesOf: hunks read by their counts (a format-patch signature line "-- " is not a removed line), modes, binary and renames refused',()=>{
 const p=changesOf(fs.readFileSync(patchFile,'utf8'));assert.equal(p.length,1);assert.deepEqual(p[0].lines,['-const key = {scope, args};','+const key = {scope, client, args};']);
 assert.equal(sameChanges(p,changesOf(run(['diff','--no-renames',P,H]))),null);
 assert.throws(()=>changesOf('diff --git a/x b/x\nBinary files a/x and b/x differ\n'),/binary/);
 assert.throws(()=>changesOf('diff --git a/x b/y\nsimilarity index 90%\nrename from x\nrename to y\n'),/rename/);
 assert.deepEqual(changesOf('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n')[0].meta,['old mode 100644','new mode 100755']);
 assert.throws(()=>changesOf('diff --git a/x b/x\n@@ -1,2 +1,2 @@\n-a\n'),/ends before/);
});

test('productionCommit: the revision label, named by the tag; a -dirty or missing label refused',()=>{
 assert.equal(productionCommit(()=>P+'\n',img(P)),P);
 assert.throws(()=>productionCommit(()=>P+'-dirty\n',img(P)),/not a commit/);
 assert.throws(()=>productionCommit(()=>'\n',img(P)),/not a commit/);
 assert.throws(()=>productionCommit(()=>M+'\n',img(P)),/does not name its revision/);
});

test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
