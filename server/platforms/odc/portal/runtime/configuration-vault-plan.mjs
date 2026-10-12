import {fail} from './errors.mjs';
import {settingSecretTarget,MAX_SECRET_REFS} from './portal-routes.mjs';

// Resolve identity selectors against current metadata before creating any pointer.
// This function has no vault access, side effects, or secret values.
export function configurationVaultPlan(host,current,patch,selectors){
 const bad=()=>fail('INPUT_INVALID','Nested vault configuration selectors must uniquely identify an existing secret field and an unused patch location.');
 if(!Array.isArray(selectors)||selectors.length>MAX_SECRET_REFS)bad();
 const body=structuredClone(patch??{}),refs=[],locations=[],seen=new Set();
 const one=(rows,key)=>{if(!Array.isArray(rows))bad();const matches=rows.filter(r=>r?.key===key);if(matches.length!==1)bad();return matches[0];};
 const array=(owner,key)=>{if(owner[key]===undefined)owner[key]=[];if(!Array.isArray(owner[key]))bad();return owner[key];};
 const member=(rows,key,create)=>{const matches=rows.filter(r=>r?.key===key);if(matches.length>1)bad();if(matches.length)return matches[0];const item=create();rows.push(item);return item;};
 for(const s of selectors){
  if(!s||typeof s!=='object'||Object.keys(s).some(k=>!['libraryKey','integrationKey','settingKey','entry'].includes(k))
   ||typeof s.settingKey!=='string'||!s.settingKey||typeof s.entry!=='string'||!/^[A-Za-z0-9_.-]{1,64}$/.test(s.entry)
   ||(!s.libraryKey&&!s.integrationKey)||['libraryKey','integrationKey'].some(k=>s[k]!==undefined&&(typeof s[k]!=='string'||!s[k])))bad();
  const identity=JSON.stringify([s.libraryKey??null,s.integrationKey??null,s.settingKey]);if(seen.has(identity))bad();seen.add(identity);
  let metadata=current,owner=body,pointer='';
  if(s.libraryKey){
   metadata=one(current.libraries,s.libraryKey);
   if(!Number.isInteger(metadata.revision)||metadata.revision!==metadata.revisionBaseline)bad();
   const rows=array(body,'libraries');owner=member(rows,s.libraryKey,()=>({key:s.libraryKey,revision:metadata.revision}));
   if(owner.revision!==metadata.revision)bad();pointer='/libraries/'+rows.indexOf(owner);
  }
  let group='settings';
  if(s.integrationKey){
   metadata=one(metadata.integrations,s.integrationKey);
   if(typeof metadata.pluginType!=='string'||!metadata.pluginType)bad();
   const rows=array(owner,'integrations');owner=member(rows,s.integrationKey,()=>({key:s.integrationKey}));
   pointer+='/integrations/'+rows.indexOf(owner);group='configs';
  }
  const setting=one(metadata[group],s.settingKey);
  if(setting.isSecret!==true)bad();
  const rows=array(owner,group);if(rows.some(r=>r?.key===s.settingKey))bad();
  pointer+='/'+group+'/'+rows.length+'/value';rows.push({key:s.settingKey,value:''});
  refs.push({pointer,target:settingSecretTarget(host,s.entry),field:'password'});
  locations.push({libraryKey:s.libraryKey??null,integrationKey:s.integrationKey??null,settingKey:s.settingKey,pointer});
 }
 return {body,refs,locations};
}
