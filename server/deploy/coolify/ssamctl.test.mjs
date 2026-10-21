import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./ssamctl.sh',import.meta.url));
const bash=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'bash';
const slash=p=>p.replaceAll('\\','/');
test('operations select the requested pair and reject a kernel before any write',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssamctl-')),log=path.join(dir,'calls'),mock=path.join(dir,'docker.sh'),kernel=path.join(dir,'kernel.json');
 fs.writeFileSync(kernel,'{}');
 fs.writeFileSync(mock,`#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\ncase "$*" in\n*'ps -a'*'ssam.odc=1.7.28'*) echo backend-old;;\n*'ps -a'*'ssam.o11=1.7.28'*) :;;\n*'ps -a'*'ssam.backend=true'*) printf 'backend-new\\nbackend-old\\n';;\n*'ps -a'*) echo legacy;;\n*'inspect'*'.Config.Env'*) echo SSAM_RUNTIME_DIR=/data/server/versions/old;;\n*'inspect'*'.Image'*) echo image-id;;\n*'inspect'*'.Mounts'*) echo volume;;\n*'run'*'/c.mjs check'*) exit 7;;\nesac\n`);
 try{const r=spawnSync(bash,[slash(script),'kernel','write','--version','1.7.28',slash(kernel)],{encoding:'utf8',env:{...process.env,DOCKER:`sh ${slash(mock)}`,CALLS:slash(log),MSYS_NO_PATHCONV:'1'}});assert.notEqual(r.status,0);const calls=fs.readFileSync(log,'utf8');assert.match(calls,/ssam.odc=1.7.28/);assert.match(calls,/\/c.mjs check/);assert.doesNotMatch(calls,/cat > /);const logs=spawnSync(bash,[slash(script),'logs','5'],{encoding:'utf8',env:{...process.env,SSAM_CONTAINER:'backend-old',DOCKER:`sh ${slash(mock)}`,CALLS:slash(log),MSYS_NO_PATHCONV:'1'}});assert.equal(logs.status,0);assert.match(fs.readFileSync(log,'utf8'),/versions\/old\/server.log/);}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('restore refuses shared state while any version backend is running',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ssamctl-restore-')),log=path.join(dir,'calls'),mock=path.join(dir,'docker.sh'),archive=path.join(dir,'backup.tar.gz');
 fs.writeFileSync(archive,'fixture');
 fs.writeFileSync(mock,`#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\ncase "$*" in\n*'ps -a'*'ssam.backend=true'*) printf 'backend-new\\nbackend-old\\n';;\n*'inspect'*'.State.Running'*'backend-old'*) echo false;;\n*'inspect'*'.State.Running'*) echo true;;\n*'inspect'*'.Mounts'*) echo volume;;\n*'inspect'*'.Image'*) echo image-id;;\nesac\n`);
 try{const r=spawnSync(bash,[slash(script),'restore',slash(archive)],{encoding:'utf8',env:{...process.env,SSAM_CONTAINER:'backend-old',DOCKER:`sh ${slash(mock)}`,CALLS:slash(log),MSYS_NO_PATHCONV:'1'}});assert.notEqual(r.status,0);assert.match(r.stderr,/stop all version backends/);assert.doesNotMatch(fs.readFileSync(log,'utf8'),/rm -rf/);}
 finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('explicit container wins and qualified selectors list ambiguous candidates',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'selector-')),mock=path.join(dir,'docker.sh'),log=path.join(dir,'calls');
 fs.writeFileSync(mock,`#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\ncase "$*" in\n*'ps -a'*'ssam.o11=11.55.94'*) echo next;;\n*'ps -a'*) printf 'backend-new\\nbackend-old\\n';;\n*'inspect'*'.Config.Env'*) echo SSAM_RUNTIME_DIR=/data/server;;\n*'inspect'*) echo fixture;;\n*'run'*) echo read;;\nesac\n`);
 const call=(version,container='')=>spawnSync(bash,[slash(script),'kernel','show','--version',version],{encoding:'utf8',env:{...process.env,SSAM_CONTAINER:container,DOCKER:`sh ${slash(mock)}`,CALLS:slash(log),MSYS_NO_PATHCONV:'1'}});
 try{
  assert.equal(call('1.7.29','backend-new').status,0);
  const ambiguous=call('odc=1.7.29');assert.notEqual(ambiguous.status,0);assert.match(ambiguous.stderr,/backend-new/);assert.match(ambiguous.stderr,/backend-old/);
  assert.equal(call('o11=11.55.94').status,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});