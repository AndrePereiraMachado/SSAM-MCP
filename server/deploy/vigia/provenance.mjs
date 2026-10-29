// Content custody starts at an authenticated installer, never an installed Studio.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const shaFile=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function contentTree(root){
 const result={};
 function walk(dir){for(const name of fs.readdirSync(dir).sort()){
  const file=path.join(dir,name),s=fs.lstatSync(file);
  if(s.isSymbolicLink())throw Error('Provenance tree cannot contain links.');
  if(s.isDirectory())walk(file);else if(s.isFile())result[path.relative(root,file).replaceAll('\\','/')]=shaFile(file);else throw Error('Unsupported provenance entry.');
 }}walk(root);return result;
}
export function captureProvenance(root,installer,signer){
 if(!signer?.subject||!signer?.ca||signer.status!=='Valid')throw Error('Verified installer signer is required.');
 return {schema:1,root,installer:{file:installer,sha256:shaFile(installer),signer},tree:contentTree(root)};
}
export function verifyProvenance(chain,root=chain?.root,{subset=false}={}){
 if(chain?.schema!==1||!chain.installer?.signer||shaFile(chain.installer.file)!==chain.installer.sha256)throw Error('Installer custody changed.');
 const actual=contentTree(root),expected=chain.tree;
 if(!subset&&Object.keys(actual).length!==Object.keys(expected).length)throw Error('Extracted tree changed.');
 for(const [file,sha] of Object.entries(actual))if(expected[file]!==sha)throw Error('Studio input is outside the verified extraction tree: '+file);
 return chain;
}
export function verifyBundleCustody(bundle,pin){
 if(shaFile(bundle.file)!==bundle.sha256)throw Error('Bundle changed.');
 if(bundle.provenance){verifyProvenance(bundle.provenance);verifyProvenance(bundle.provenance,bundle.snapshot,{subset:true});}
 else if(!pin||pin.toLowerCase()!==bundle.sha256)throw Error('A baseline bundle requires a reviewed bundlePins entry or installer provenance.');
 return true;
}
