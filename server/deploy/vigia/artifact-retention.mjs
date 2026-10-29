import fs from 'node:fs';
import path from 'node:path';
import {readJournal} from './journal.mjs';
const terminal=new Set(['live','idle','abandoned','rolled-back','preparation-failed']);
export function cleanupArtifacts({tempRoot,bundleRoot,outDir,keepArtifacts=2}){
 if(!Number.isInteger(keepArtifacts)||keepArtifacts<0)throw Error('Invalid artifact retention count.');
 const referenced=new Set();
 const visit=value=>{if(typeof value==='string'&&path.isAbsolute(value))referenced.add(path.resolve(value));else if(value&&typeof value==='object')Object.values(value).forEach(visit);};
 if(fs.existsSync(outDir))for(const name of fs.readdirSync(outDir)){
  if(!/^o11-\d+\.\d+\.\d+-odc-\d+\.\d+\.\d+$/.test(name))continue;
  const dir=path.join(outDir,name),r=path.join(dir,'release.json'),j=path.join(dir,'deployment.json');
  if(fs.existsSync(r)&&(!fs.existsSync(j)||!terminal.has(readJournal(j).status)))visit(readJournal(r));
  if(fs.existsSync(j)&&!terminal.has(readJournal(j).status))visit(readJournal(j));
 }
 const groups=[[path.join(tempRoot,'extracted'),/^(?:[a-f0-9]{64}|(?:odc|o11)-.*[a-f0-9-]{36})$/],[path.join(tempRoot,'bridges'),/^[a-f0-9-]{36}$/],[tempRoot,/^agent-source-[\d-]+$/]];
 if(fs.existsSync(bundleRoot))for(const name of fs.readdirSync(bundleRoot))if(/^(odc|o11)-\d+\.\d+\.\d+$/.test(name))groups.push([path.join(bundleRoot,name),/^(?:snapshot-[a-f0-9-]{36,64}|\.snapshot-partial-\d+)$/]);
 const removed=[];
 for(const [root,pattern]of groups){if(!fs.existsSync(root))continue;
  const dirs=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&pattern.test(e.name)).map(e=>path.join(root,e.name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  const free=dirs.filter(dir=>![...referenced].some(ref=>ref===dir||ref.startsWith(dir+path.sep)));
  for(const dir of free.slice(keepArtifacts)){if(path.dirname(path.resolve(dir))!==path.resolve(root))throw Error('Artifact cleanup escaped its root.');fs.rmSync(dir,{recursive:true,force:true});for(const suffix of ['.provenance.json','.tree.json'])fs.rmSync(dir+suffix,{force:true});removed.push(dir);}
 }
 return removed;
}
export function assertDisk(directory,minBytes=25*2**30){
 let existing=path.resolve(directory);while(!fs.existsSync(existing)){const parent=path.dirname(existing);if(parent===existing)throw Error('No storage volume found.');existing=parent;}
 const stats=fs.statfsSync(existing);if(stats.bavail*stats.bsize<minBytes)throw Object.assign(Error('Insufficient private storage capacity.'),{code:'DISK_LOW',environmental:true});
}
