import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export function readQualifiedRelease(file,schema,label){
  try {
    const selection=JSON.parse(fs.readFileSync(file,'utf8'));
    if(selection.schema!==schema||!path.isAbsolute(selection.directory)||!Array.isArray(selection.files)||!selection.files.length)
      throw Error('Invalid selection schema');
    const required=['anvil-odc.dll','anvil-odc.deps.json','anvil-odc.runtimeconfig.json'];
    const names=new Set();
    for(const entry of selection.files){
      if(typeof entry.path!=='string'||path.isAbsolute(entry.path)||entry.path.includes('\\')||entry.path.split('/').some(x=>!x||x==='.'||x==='..')||! /^[a-f0-9]{64}$/.test(entry.sha256))throw Error('Invalid selected file');
      const normalized=entry.path.toLowerCase();if(names.has(normalized))throw Error('Duplicate selected file');names.add(normalized);
      const target=path.join(selection.directory,...entry.path.split('/'));
      if(createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==entry.sha256)throw Error('Selected file hash mismatch: '+entry.path);
    }
    if(required.some(name=>!names.has(name)))throw Error('Incomplete CLI selection');
    const actual=[];
    const walk=(directory,prefix='')=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const relative=prefix+entry.name;if(entry.isSymbolicLink())throw Error('Linked release entry refused');if(entry.isDirectory())walk(path.join(directory,entry.name),relative+'/');else if(entry.isFile())actual.push(relative.toLowerCase());else throw Error('Unsupported release entry');}};
    walk(selection.directory);
    if(actual.length!==names.size||actual.some(name=>!names.has(name)))throw Error('Release file inventory changed');
    return {cli:path.join(selection.directory,'anvil-odc.dll'),source:'persistent',selectionFile:file};
  }catch(error){return {error:label+' selection refused: '+error.message,selectionFile:file};}
}
