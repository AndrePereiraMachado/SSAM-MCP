import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

// Code identities only; a failed import may still have loaded its dependencies.
const importedBootstrap=new Map();

// Routing only. Compatibility, evidence and selection remain owned by package-session.
export async function routePackage(args,{root}={}) {
  const releaseRoot=path.join(root,'.local','releases');
  const pointerFile=path.join(releaseRoot,'active-readonly.json');
  if(!fs.existsSync(pointerFile)) throw new Error('No readonly package is activated. Existing Studio and delivery entries are unchanged.');
  const pointer=JSON.parse(fs.readFileSync(pointerFile,'utf8'));
  if(pointer.schema!=='ssam-readonly-activation/1'||!pointer.module||path.isAbsolute(pointer.module)) throw new Error('Invalid readonly activation record.');
  const module=path.resolve(root,pointer.module),relative=path.relative(releaseRoot,module);
  if(relative.startsWith('..')||path.isAbsolute(relative)) throw new Error('Activated package must reside under this workspace .local/releases.');
  const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if(!/^[a-f0-9]{64}$/i.test(pointer.moduleSha256??'')||sha(module)!==pointer.moduleSha256.toLowerCase()) throw new Error('Activated package entry changed; no command was dispatched.');
  // The pinned entry imports delivery-status statically, before its first full
  // selection validation. Verify that reviewed bootstrap closure before importing it.
  const record=pointer.package;
  if(!record?.path||!path.isAbsolute(record.path)||!/^[a-f0-9]{64}$/i.test(record.sha256??'')||sha(record.path)!==record.sha256.toLowerCase()) throw new Error('Activated package descriptor changed or is missing; no command was dispatched.');
  const descriptor=JSON.parse(fs.readFileSync(record.path,'utf8'));
  const packageRoot=path.resolve(path.dirname(record.path),descriptor.root??'');
  if(!record.root||path.resolve(record.root).toLowerCase()!==packageRoot.toLowerCase()||path.resolve(packageRoot,'scripts/package-session.mjs').toLowerCase()!==module.toLowerCase()) throw new Error('Activated package bootstrap root differs.');
  // Node resolves ESM imports through realpaths. A directory junction could move
  // the entry's relative imports outside the lexical package despite matching bytes.
  for(const file of [packageRoot,module,path.join(packageRoot,'platforms/odc/facade/delivery-status.mjs')])
    if(path.resolve(fs.realpathSync(file)).toLowerCase()!==path.resolve(file).toLowerCase()) throw new Error('Activated package bootstrap path is redirected: '+file);
  for(const name of ['scripts/package-session.mjs','platforms/odc/facade/delivery-status.mjs']) {
    const pins=descriptor.files?.filter(item=>item.path===name)??[],file=path.join(packageRoot,name);
    if(pins.length!==1||!/^[a-f0-9]{64}$/i.test(pins[0].sha256??'')||sha(file)!==pins[0].sha256.toLowerCase()) throw new Error('Activated package bootstrap dependency changed: '+name);
  }
  const forwarded=[...args];
  if(['run','mcp'].includes(forwarded[0])&&!forwarded.includes('--selection')) {
    if(forwarded.includes('--sha256')) throw new Error('An explicit --sha256 requires an explicit --selection.');
    if(!pointer.selection?.path||!pointer.selection?.sha256||sha(pointer.selection.path)!==pointer.selection.sha256.toLowerCase()) throw new Error('Activated package selection changed; no command was dispatched.');
    forwarded.push('--selection',pointer.selection.path,'--sha256',pointer.selection.sha256);
  }
  if(['run','mcp'].includes(forwarded[0])&&forwarded.includes('--selection')&&!forwarded.includes('--sha256')) throw new Error('An explicit --selection requires an explicit --sha256.');
  const key=module.toLowerCase(),identity=pointer.moduleSha256.toLowerCase()+'\n'+record.sha256.toLowerCase();
  if(importedBootstrap.has(key)&&importedBootstrap.get(key)!==identity) throw new Error('Activated package URL was already imported with other bytes; start a new process.');
  importedBootstrap.set(key,identity);
  return (await import(pathToFileURL(module))).main(forwarded);
}
