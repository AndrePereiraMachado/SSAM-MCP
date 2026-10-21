import fs from 'node:fs';
import path from 'node:path';
export function runtimeDir(root, version=process.env.SSAM_BACKEND_NAME) {
 if(!version)return root;
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(version))throw new Error('Invalid backend name.');
 return path.join(root,'versions',version);
}
export const customerStateDir=(root,version=process.env.SSAM_BACKEND_NAME)=>runtimeDir(path.join(root,'state'),version);
export function ensureRuntime(root){const dir=runtimeDir(root);fs.mkdirSync(dir,{recursive:true});return dir;}
export function runtimeDirectories(root){let entries=[];try{entries=fs.readdirSync(path.join(root,'versions'),{withFileTypes:true});}catch{}return [root,...entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()).map(e=>path.join(root,'versions',e.name))];}
export function readMachinePin(root, token) {
 const pins=[];
 for(const dir of runtimeDirectories(root)) {
  try { const pin=JSON.parse(fs.readFileSync(path.join(dir,'machine-pins.json'),'utf8'))[token]; if(pin&&typeof pin.id==='string'&&typeof pin.at==='string')pins.push(pin); } catch {}
 }
 return pins.sort((a,b)=>a.at.localeCompare(b.at))[0]??null;
}
