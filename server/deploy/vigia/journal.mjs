import fs from 'node:fs';
import path from 'node:path';
import {createHmac,timingSafeEqual} from 'node:crypto';
const keys=new Map(),required=new Set();
export function requireJournalKey(root){required.add(path.resolve(root).toLowerCase());}
const needsKey=file=>[...required].some(root=>path.resolve(file).toLowerCase().startsWith(root+path.sep));
export function configureJournals(root,key){
 const bytes=Buffer.from(key,'base64');if(bytes.length!==32)throw Error('A 256-bit journal key is required.');
 keys.set(path.resolve(root).toLowerCase(),bytes);
}
const keyFor=file=>[...keys].find(([root])=>path.resolve(file).toLowerCase().startsWith(root+path.sep))?.[1];
const tag=(key,file,value)=>createHmac('sha256',key).update(path.resolve(file).toLowerCase()+'\0'+JSON.stringify(value)).digest('hex');
// macPath: the path the journal will be read at, when it is written elsewhere first (a staged folder renamed in whole).
export function writeJournal(file,value,{macPath=file}={}){
 const key=keyFor(macPath);if(!key&&needsKey(macPath))throw Error('Automatic journal key is unavailable.');const data=key?{journal:1,value,mac:tag(key,macPath,value)}:value;
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.next',JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.next',file);
}
export function readJournal(file,{automatic=false}={}){
 const data=JSON.parse(fs.readFileSync(file,'utf8')),key=keyFor(file);
 if(!key){if(automatic||needsKey(file))throw Error('Automatic journal key is unavailable.');return data;}
 if(data.journal!==1||typeof data.mac!=='string'||!/^\w{64}$/.test(data.mac))throw Error('Unsigned journal refused.');
 const actual=Buffer.from(data.mac,'hex'),expected=Buffer.from(tag(key,file,data.value),'hex');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('Journal MAC is invalid.');
 return data.value;
}
