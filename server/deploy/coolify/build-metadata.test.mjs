import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const slash=p=>p.replaceAll('\\','/');
test('local build preserves the manifest digest for a reviewable unpublished image',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'build-metadata-')),mock=path.join(dir,'docker.sh'),record=path.join(dir,'metadata.json');
 const digest='sha256:'+'a'.repeat(64);
 fs.writeFileSync(mock,`#!/bin/sh\ncase "$1 $2" in\n'buildx build') while [ $# -gt 0 ]; do if [ "$1" = --metadata-file ]; then shift; printf '%s' '{"containerimage.digest":"${digest}"}' > "$1"; fi; shift; done;;\n'image inspect') echo 123;;\n*) :;;\nesac\n`);
 try {
  const script=fileURLToPath(new URL('../build.sh',import.meta.url));
  const result=spawnSync(process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash',[slash(script),'--image','ssam-local-test','--tag','candidate'],{encoding:'utf8',env:{...process.env,DOCKER:'sh '+slash(mock),STUDIO_INSTALLERS_DIR:slash(dir),SSAM_BUILD_METADATA_FILE:slash(record),SSAM_ENV_FILE:slash(path.join(dir,'missing.env'))}});
  assert.equal(result.status,0,result.stderr);assert.ok(fs.existsSync(record),'local metadata must survive the temporary file cleanup');assert.equal(JSON.parse(fs.readFileSync(record,'utf8'))['containerimage.digest'],digest);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('SSAM_BUILD_CONTEXT: the guard and the build read the clean tree of another commit, labelled with its VCS_REF, never git',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'build-context-')),mock=path.join(dir,'docker.sh'),log=path.join(dir,'calls.txt'),ctx=path.join(dir,'tree','server');
 fs.mkdirSync(ctx,{recursive:true});fs.writeFileSync(path.join(ctx,'Dockerfile'),'ARG NODE_IMAGE=node:test@sha256:'+'b'.repeat(64)+'\n');fs.writeFileSync(path.join(ctx,'.dockerignore'),'.git\n');
 fs.writeFileSync(mock,`#!/bin/sh\necho "$(pwd) | $*" >> '${slash(log)}'\ncase "$1 $2" in\n'buildx build') while [ $# -gt 0 ]; do if [ "$1" = --metadata-file ]; then shift; printf '{}' > "$1"; fi; shift; done;;\n'image inspect') echo 123;;\n*) :;;\nesac\n`);
 const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash',script=slash(fileURLToPath(new URL('../build.sh',import.meta.url))),rev='c'.repeat(40);
 const run=(env,args=['--image','ssam-ensaio','--tag','ensaio-x'])=>spawnSync(bash,[script,...args],{encoding:'utf8',env:{...process.env,DOCKER:'sh '+slash(mock),STUDIO_INSTALLERS_DIR:slash(dir),SSAM_ENV_FILE:slash(path.join(dir,'missing.env')),SSAM_BUILD_CONTEXT:slash(ctx),...env}});
 try {
  const r=run({VCS_REF:rev});assert.equal(r.status,0,r.stderr);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n');
  assert.ok(calls[0].includes("tree/server:/src:ro")&&calls[0].includes(" run --rm --network none "),"the guard mounts the context: "+calls[0]);
  assert.match(calls[1],/\/tree\/server \| buildx build /,'the build runs in the context');assert.match(calls[1],new RegExp(`--build-arg VCS_REF=${rev} `));
  assert.match(r.stdout,new RegExp(`\(revision ${rev}\)`));
  for(const [env,args,re] of [[{},undefined,/requires --tag and VCS_REF/],[{VCS_REF:rev},['--image','x'],/requires --tag and VCS_REF/],[{VCS_REF:'c'.repeat(39)},undefined,/40-hex/],[{VCS_REF:rev+'-dirty'},undefined,/invalid VCS_REF/],
   [{VCS_REF:rev,SSAM_BUILD_CONTEXT:slash(dir)},undefined,/is not a server\/ folder/],[{VCS_REF:rev,SSAM_BUILD_CONTEXT:slash(path.join(dir,'none'))},undefined,/no build context folder/]]){
   const x=run(env,args);assert.equal(x.status,2,JSON.stringify(env));assert.match(x.stderr,re);
  }
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
