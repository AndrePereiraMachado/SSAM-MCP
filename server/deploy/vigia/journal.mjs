import fs from 'node:fs';
import path from 'node:path';
import {createHmac,timingSafeEqual} from 'node:crypto';
const keys=new Map();
export function configureJournals(root,key){
 const bytes=Buffer.from(key,'base64');if(bytes.length!==32)throw Error('A 256-bit journal key is required.');
 keys.set(path.resolve(root).toLowerCase(),bytes);
}
const keyFor=file=>[...keys].find(([root])=>path.resolve(file).toLowerCase().startsWith(root+path.sep))?.[1];
const tag=(key,file,value)=>createHmac('sha256',key).update(path.resolve(file).toLowerCase()+'\0'+JSON.stringify(value)).digest('hex');
export function writeJournal(file,value){
 const key=keyFor(file);const data=key?{journal:1,value,mac:tag(key,file,value)}:value;
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.next',JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(file+'.next',file);
}
export function readJournal(file){
 const data=JSON.parse(fs.readFileSync(file,'utf8')),key=keyFor(file);
 if(!key)return data;
 if(data.journal!==1||typeof data.mac!=='string'||!/^\w{64}$/.test(data.mac))throw Error('Unsigned journal refused.');
 const actual=Buffer.from(data.mac,'hex'),expected=Buffer.from(tag(key,file,data.value),'hex');
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('Journal MAC is invalid.');
 return data.value;
}
