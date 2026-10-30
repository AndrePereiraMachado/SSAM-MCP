import fs from 'node:fs';
import path from 'node:path';
import {contentTree,shaFile} from './provenance.mjs';
export function artifactEvidence(target,outputs,assets){
 const owned={};
 for(const output of outputs){
  const rel=path.relative(target,output).replaceAll('\\','/');
  if(rel.startsWith('../')||path.isAbsolute(rel)||!fs.statSync(output).isFile())throw Error('TargetPath escapes the build output.');
  owned[rel]=shaFile(output);
 }
 const packages=new Map();
 for(const file of assets){
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const folder of Object.keys(data.packageFolders??{}))for(const lib of Object.values(data.libraries??{})){
   if(lib.type!=='package')continue;
   const root=path.resolve(folder,lib.path),rel=path.relative(path.resolve(folder),root);
   if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('NuGet path escapes package root.');
   if(fs.existsSync(root))for(const [name,sha]of Object.entries(contentTree(root)))if(/\.(dll|exe)$/i.test(name))packages.set(sha,path.join(root,name));
  }
 }
 const dependencies={};
 for(const [rel,sha]of Object.entries(contentTree(target)))if(/\.(dll|exe)$/i.test(rel)&&!owned[rel]){
  if(!packages.has(sha))throw Error('Dependency bytes do not match a restored NuGet package: '+rel);
  dependencies[rel]={sha256:sha,source:packages.get(sha)};
 }
 return {owned,dependencies};
}
