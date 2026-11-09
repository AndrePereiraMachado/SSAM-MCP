import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readJournal,writeJournal} from './journal.mjs';
const terminal=new Set(['live','idle','abandoned','rolled-back','preparation-failed']);
// A live pair, or (window 4x4, S2) a live backend odc-<v> of a backend window.
const PAIR=/^(?:o11-\d+\.\d+\.\d+-)?odc-\d+\.\d+\.\d+$/;
// The attempt folders: a pair, or a round of a backend window (odc-<v>, o11-<v>, retire-<lane>-<v>).
const ROUND=/^(?:o11-\d+\.\d+\.\d+-odc-\d+\.\d+\.\d+|(?:odc|o11)-\d+\.\d+\.\d+|retire-(?:odc|o11)-\d+\.\d+\.\d+)$/;
const key=p=>process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
// The pairs the live baseline served when it was last read; null before the first read (then every 'live' journal counts).
export const livePairsFile=outDir=>path.join(outDir,'live-pairs.json');
export function recordLivePairs(outDir,pairs){writeJournal(livePairsFile(outDir),{at:new Date().toISOString(),pairs:[...pairs].sort()});}
export function readLivePairs(outDir){const file=livePairsFile(outDir);if(!fs.existsSync(file))return null;const value=readJournal(file);if(!Array.isArray(value?.pairs)||value.pairs.some(p=>!PAIR.test(p)))throw Error('Invalid live pair record.');return value.pairs;}
function bundleSha(file){
 try{const recorded=/[a-f0-9]{64}/i.exec(fs.readFileSync(file+'.sha256','utf8'))?.[0];if(recorded)return recorded.toLowerCase();}catch{}
 const digest=createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1<<20);
 try{for(let n;(n=fs.readSync(fd,buffer,0,buffer.length,null))>0;)digest.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}
 return digest.digest('hex');
}
// A later round re-verifies everything still referenced, so none of it may go: the journals of unfinished attempts and of
// the pairs the live baseline serves, every bundle receipt of the store (the extraction and installer it cites), the frozen
// snapshot of each stored bundle, and the installer of each extraction kept. Beyond that, keepArtifacts newest per group.
export function cleanupArtifacts({tempRoot,bundleRoot,outDir,installersDir,keepArtifacts=2,livePairs=null}){
 if(!Number.isInteger(keepArtifacts)||keepArtifacts<0)throw Error('Invalid artifact retention count.');
 if(livePairs!==null&&(!Array.isArray(livePairs)||livePairs.some(p=>!PAIR.test(p))))throw Error('Invalid live pairs.');
 const served=livePairs?new Set(livePairs):null,referenced=new Set();
 const visit=value=>{if(typeof value==='string'&&path.isAbsolute(value))referenced.add(key(value));else if(value&&typeof value==='object')Object.values(value).forEach(visit);};
 const isReferenced=item=>{const k=key(item);return [...referenced].some(ref=>ref===k||ref.startsWith(k+path.sep));};
 if(outDir&&fs.existsSync(outDir))for(const name of fs.readdirSync(outDir)){
  if(!ROUND.test(name))continue;
  const dir=path.join(outDir,name),r=path.join(dir,'release.json'),j=path.join(dir,'deployment.json');
  // A round that names no backend (an O11 round, a retirement) is kept while its journal says live.
  const state=fs.existsSync(j)?readJournal(j):null,live=served&&PAIR.test(name)?served.has(name):state?.status==='live';
  if(state&&!terminal.has(state.status)||live){if(state)visit(state);if(fs.existsSync(r))visit(readJournal(r));}
  else if(!state&&fs.existsSync(r))visit(readJournal(r));
 }
 const groups=[];
 if(bundleRoot&&fs.existsSync(bundleRoot))for(const name of fs.readdirSync(bundleRoot)){
  if(!/^(odc|o11)-\d+\.\d+\.\d+$/.test(name))continue;
  const folder=path.join(bundleRoot,name);if(!fs.statSync(folder).isDirectory())continue;
  for(const entry of fs.readdirSync(folder)){
   const file=path.join(folder,entry);
   if(/\.provenance\.json$/.test(entry))visit(readJournal(file));
   if(/^(odc|o11)-studio-\d+\.\d+\.\d+\.\d+\.tar\.gz$/.test(entry))referenced.add(key(path.join(folder,'snapshot-'+bundleSha(file))));
  }
  groups.push({root:folder,pattern:/^(?:snapshot-[a-f0-9-]{36,64}|\.snapshot-partial-\d+)$/,companions:['.tree.json']});
 }
 const removed=[];
 const prune=({root,pattern,files=false,companions=[]})=>{
  if(!root||!fs.existsSync(root))return [];
  const items=fs.readdirSync(root,{withFileTypes:true}).filter(e=>!e.isSymbolicLink()&&(files?e.isFile():e.isDirectory())&&pattern.test(e.name)).map(e=>path.join(root,e.name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  const gone=items.filter(item=>!isReferenced(item)).slice(keepArtifacts);
  for(const item of gone){
   if(path.dirname(path.resolve(item))!==path.resolve(root))throw Error('Artifact cleanup escaped its root.');
   fs.rmSync(item,{recursive:true,force:true});for(const suffix of companions)fs.rmSync(item+suffix,{force:true});removed.push(item);
  }
  return items.filter(item=>!gone.includes(item));
 };
 // Extractions first: the installer of every extraction kept is still needed to re-verify it.
 const extracted=path.join(tempRoot,'extracted');
 for(const kept of prune({root:extracted,pattern:/^(?:[a-f0-9]{64}|(?:odc|o11)-.*[a-f0-9-]{36})$/,companions:['.provenance.json','.tree.json']})){
  const receipt=kept+'.provenance.json';if(fs.existsSync(receipt))visit(readJournal(receipt).installer);
 }
 for(const group of [{root:path.join(tempRoot,'bridges'),pattern:/^[a-f0-9-]{36}$/},{root:tempRoot,pattern:/^agent-source-[\d-]+$/},...groups])prune(group);
 if(installersDir&&fs.existsSync(installersDir)){
  // A partial download of another process is never resumed.
  for(const entry of fs.readdirSync(installersDir,{withFileTypes:true})){
   const partial=/^(?:odc|o11)-\d+\.\d+\.\d+\.\d+\.exe\.partial-(\d+)(?:\.sha256)?$/.exec(entry.name);
   if(partial&&entry.isFile()&&Number(partial[1])!==process.pid){fs.rmSync(path.join(installersDir,entry.name),{force:true});removed.push(path.join(installersDir,entry.name));}
  }
  prune({root:installersDir,pattern:/^(?:odc|o11)-\d+\.\d+\.\d+\.\d+\.exe$/,files:true,companions:['.sha256']});
 }
 return removed;
}
export function assertDisk(directory,minBytes=25*2**30){
 let existing=path.resolve(directory);while(!fs.existsSync(existing)){const parent=path.dirname(existing);if(parent===existing)throw Error('No storage volume found.');existing=parent;}
 const stats=fs.statfsSync(existing);if(stats.bavail*stats.bsize<minBytes)throw Object.assign(Error('Insufficient private storage capacity.'),{code:'DISK_LOW',environmental:true});
}
