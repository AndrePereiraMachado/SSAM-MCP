import {fail} from './errors.mjs';
import {settingSecretTarget,MAX_SECRET_REFS} from './portal-routes.mjs';

// Mobile extensibility libraries have no revision in the PATCH. Resolve their
// identities against GET metadata; the approval separately pins the revision.
export function mobileExtensibilityVaultPlan(host,current,patch,selectors){
 const bad=()=>fail('INPUT_INVALID','Mobile vault selectors require an existing secret Text setting in one exact library and an unused patch location.');
 if(!Array.isArray(selectors)||selectors.length>MAX_SECRET_REFS)bad();
 const body=structuredClone(patch??{}),refs=[],locations=[],seen=new Set();
 const one=(rows,key)=>{const found=Array.isArray(rows)?rows.filter(x=>x?.key===key):[];if(found.length!==1)bad();return found[0];};
 for(const s of selectors){
  if(!s||Object.keys(s).sort().join(',')!=='entry,libraryKey,settingKey'||typeof s.libraryKey!=='string'||!s.libraryKey
   ||typeof s.settingKey!=='string'||!s.settingKey||typeof s.entry!=='string'||!/^[A-Za-z0-9_.-]{1,64}$/.test(s.entry))bad();
  const id=JSON.stringify([s.libraryKey,s.settingKey]);if(seen.has(id))bad();seen.add(id);
  const library=one(current?.libraries,s.libraryKey),setting=one(library.settings,s.settingKey);
  if(!Number.isSafeInteger(library.revision)||library.revision<1||setting.isSecret!==true||setting.dataType!=='Text')bad();
  body.libraries??=[];if(!Array.isArray(body.libraries))bad();
  let matches=body.libraries.filter(x=>x?.key===s.libraryKey);if(matches.length>1)bad();
  if(!matches.length){body.libraries.push({key:s.libraryKey,settings:[]});matches=[body.libraries.at(-1)];}
  const owner=matches[0];if(Object.keys(owner).sort().join(',')!=='key,settings'||!Array.isArray(owner.settings)||owner.settings.some(x=>x?.key===s.settingKey))bad();
  const pointer='/libraries/'+body.libraries.indexOf(owner)+'/settings/'+owner.settings.length+'/value';
  owner.settings.push({key:s.settingKey,value:''});
  refs.push({pointer,target:settingSecretTarget(host,s.entry),field:'password'});
  locations.push({libraryKey:s.libraryKey,settingKey:s.settingKey,pointer});
 }
 return {body,refs,locations};
}
