import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('whole-window backup restores both Features and cache volumes and shared state',{skip:!process.env.SSAM_TEST_BACKUP_IMAGE},()=>{
 const image=process.env.SSAM_TEST_BACKUP_IMAGE,dir=fs.mkdtempSync(path.join(os.tmpdir(),'backup-'));
 const prefix='ssam-backup-'+process.pid,volumes=['state','friction','features-new','features-old','cache-new','cache-old'].map(n=>prefix+'-'+n),containers=[];
 const docker=process.env.SSAM_DOCKER??'docker';
 const d=(args)=>{const r=spawnSync(docker,['--context','desktop-linux',...args],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout;};
 const script=fileURLToPath(new URL('../coolify/ssamctl.sh',import.meta.url));
 const shell=process.platform==='win32'?'C:/Program Files/Git/bin/bash.exe':'sh';
 const run=(args)=>{const r=spawnSync(shell,[script,...args],{encoding:'utf8',windowsHide:true,env:{...process.env,SSAM_CONTAINER:containers[0],DOCKER:'docker --context desktop-linux',MSYS_NO_PATHCONV:'1'}});assert.equal(r.status,0,r.stdout+r.stderr);};
 try{
  for(const v of volumes)d(['volume','create',v]);
  for(const [n,features,cache,odc,o11] of [['new',volumes[2],volumes[4],'1.7.29','11.55.93'],['old',volumes[3],volumes[5],'1.7.28','11.55.92']]){
   const c=prefix+'-'+n;
   d(['create','--name',c,'--label','ssam.backend=true','--label','ssam.odc='+odc,'--label','ssam.o11='+o11,'-v',volumes[0]+':/data/server','-v',volumes[1]+':/data/friction','-v',features+':/data/odc-features','-v',cache+':/data/cache',image,'true']);containers.push(c);
  }
  for(const [i,v] of volumes.entries())d(['run','--rm','--network=none','-v',v+':/v','--entrypoint','node',image,'-e',`require('fs').writeFileSync('/v/marker',${JSON.stringify('original-'+i)})`]);
  run(['backup',dir]);
  const archive=path.join(dir,fs.readdirSync(dir).find(x=>x.endsWith('.tar.gz')));
  const listing=spawnSync('tar',['-tzf',archive],{encoding:'utf8'});assert.match(listing.stdout,/manifest.tsv/);
  for(const v of volumes)d(['run','--rm','--network=none','-v',v+':/v','--entrypoint','node',image,'-e',"require('fs').writeFileSync('/v/marker','changed');require('fs').writeFileSync('/v/extra','remove')"]);
  run(['restore',archive]);
  for(const [i,v] of volumes.entries())assert.equal(d(['run','--rm','--network=none','-v',v+':/v:ro','--entrypoint','node',image,'-e',"const f=require('fs');if(f.existsSync('/v/extra'))process.exit(2);process.stdout.write(f.readFileSync('/v/marker'))"]),'original-'+i);
 }finally{for(const c of containers)d(['rm',c]);for(const v of volumes)d(['volume','rm',v]);fs.rmSync(dir,{recursive:true,force:true});}
});