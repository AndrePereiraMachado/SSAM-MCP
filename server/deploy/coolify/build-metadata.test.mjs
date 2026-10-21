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
