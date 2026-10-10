import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const canonical = value => JSON.stringify(normalize(value));
function normalize(x) { return Array.isArray(x) ? x.map(normalize) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,normalize(x[k])])) : x; }
export function requireThat(ok,code,message=code) { if(!ok) throw Object.assign(new Error(message),{code}); }
export function pinned(pin) { requireThat(pin&&path.isAbsolute(pin.file)&&/^[a-f0-9]{64}$/.test(pin.sha256),'INVALID_PIN');const b=fs.readFileSync(pin.file);requireThat(sha256(b)===pin.sha256,'PIN_CHANGED',pin.file);return b; }
export const readPinned = pin => JSON.parse(pinned(pin));
export function transportSignature(items) { return sha256(JSON.stringify(items.map(x=>({path:x.path,viewName:x.viewName,apiVersion:x.apiVersion,inputParameters:x.inputParameters})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0))); }
export function atomicJSON(file,value) { fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp-'+process.pid;fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n');fs.renameSync(temp,file); }
export function exactRoute(route) { return typeof route==='string'&&route.startsWith('/')&&!/[?#%\\]/.test(route)&&!route.split('/').includes('..')&&new URL(route,'http://local.invalid').pathname===route; }
export function verifyCodeLock(pin) { const lock=readPinned(pin);requireThat(lock.schema==='ssam-official-host-code-lock/1','CODE_LOCK_SCHEMA');requireThat(Array.isArray(lock.files),'CODE_LOCK_FILES');const here=path.dirname(fileURLToPath(import.meta.url));for(const name of fs.readdirSync(here).filter(n=>/\.(mjs|js|css|html)$/.test(n)))requireThat(lock.files.some(item=>path.resolve(item.file)===path.join(here,name)),'CODE_LOCK_INCOMPLETE',name);requireThat(lock.files.some(item=>path.resolve(item.file)===path.resolve(here,'../scope/host-candidate.mjs')),'CODE_LOCK_SCOPE');for(const item of lock.files)pinned(item);return lock; }
