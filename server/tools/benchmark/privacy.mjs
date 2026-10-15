import os from 'node:os';
import path from 'node:path';
const userSegment=path.basename(os.homedir()).toLowerCase();
// One policy for every benchmark persistence boundary. No source values in errors.
export const PRIVACY_MARKERS=Object.freeze([
 {label:'user-workspace',field:'workspace',matches:value=>typeof value==='string'&&value.toLowerCase()===userSegment},
 {label:'email',pattern:/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i},
 {label:'outsystems-host',pattern:/\b(?:[a-z0-9-]+\.)*outsystems(?:cloud|enterprise)?\.[a-z0-9.-]+/i},
 {label:'tenant',pattern:/personal-[a-z0-9]{8}|wrightflood|unimedpoa/i},
 {label:'user-path',pattern:/(?:[A-Z]:[\\/]|\/(?:Users|home)\/|\bUsers[\\/]+[^\\/\s]+|\bC--Users-[^-\s]+-)/i},
 {label:'unc-host',pattern:/(?:^|[\s"'(])\\\\[^\\\s]+\\/},
 {label:'backslash-user-path',pattern:/(?:^|[\\/])(?:Users|home)[\\/]+[^\\/\s]+/i},
 {label:'encrypted',pattern:/gAAAA[A-Za-z0-9_-]{12,}/},
 {label:'bearer',pattern:/\bBearer\s+\S+/i},
 {label:'credential-prefix',pattern:/\b(?:sk-|ghp_)[A-Za-z0-9_-]+/i},
 {label:'free-credential',pattern:/\b(?:senha|password|PAT)\b(?:\s*[:=]\s*|\s+)["']?[^\s"']+|\btoken\s*(?:[:=]\s*["']?[^\s"']+|\s+(?!(?:count|usage|limit|budget|input|output)\b)[A-Za-z0-9_+/.=-]{4,})/i},
 {label:'network-ip',pattern:/(?:https?:\/\/)(\d{1,3}(?:\.\d{1,3}){3})\b|\b(\d{1,3}(?:\.\d{1,3}){3}):\d+\b/i},
 {label:'private-key',keyPattern:/^(creator_user_id|creator_account_id|base_instructions|repository_url|password|senha|secret|token|access_token|refresh_token|api_key)$/i}
].map(Object.freeze));
export const privateField=key=>PRIVACY_MARKERS.some(m=>m.keyPattern?.test(key));
export function homeRootSegment(value){if(typeof value!=='string'||!value)return null;const windows=/^(?:[a-z]:|[\\/]{2})/i.test(value),api=windows?path.win32:path.posix;const normalized=api.normalize(value).replace(/[\\/]+$/,''),root=normalized.replace(/\\/g,'/');const match=windows?/^(?:[a-z]:\/Users\/[^/]+|\/\/[^/]+\/(?:[^/]+\/)*(?:Users|home|home\$)\/[^/]+)$/i.test(root):/^\/(?:home|Users)\/[^/]+$/.test(root);return match?api.basename(normalized):null;}
export function privacyFindings(value){
 const found=[];const add=(field,label)=>{if(!found.some(x=>x.field===field&&x.label===label))found.push({field,label});};
 const scan=(s,field)=>{for(const marker of PRIVACY_MARKERS){if(!marker.pattern)continue;const match=marker.pattern.exec(s);if(!match)continue;if(marker.label==='network-ip'&&!(match[1]??match[2]).split('.').every(n=>+n<=255))continue;add(field,marker.label);}};
 const walk=(v,field='')=>{if(v&&typeof v==='object'&&!Array.isArray(v)){const segment=homeRootSegment(v.cwd);if(segment&&typeof v.workspace==='string'&&segment.toLowerCase()===v.workspace.toLowerCase())add(field?field+'/workspace':'workspace','user-home');}if(typeof v==='string'){scan(v,field);try{const parsed=JSON.parse(v);if(parsed&&typeof parsed==='object')walk(parsed,field+'/$json');}catch{}}else if(Array.isArray(v))v.forEach((x,i)=>walk(x,field+'/'+i));else if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){const next=field?field+'/'+k:k;for(const marker of PRIVACY_MARKERS)if(marker.field===k&&marker.matches(x))add(next,marker.label);if(privateField(k)&&x!==null&&x!==''&&x!==undefined)add(next,'private-key:'+k);walk(x,next);}};walk(value);return found;
}
export function privacyIssues(value){return [...new Set(privacyFindings(value).map(x=>x.label))].sort();}
// Exports (--json/--md) persist measured fields only: transcript paths and prompt text stay in memory.
export const SOURCE_TEXT_FIELDS=Object.freeze(['file','prompt']);
export function exportView(value){if(Array.isArray(value))return value.map(exportView);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!SOURCE_TEXT_FIELDS.includes(key)).map(([key,child])=>[key,exportView(child)]));return value;}
// Refusals name destination, field and label only; any unsafe segment of a field path is masked.
const safeSegment=segment=>/^[a-z0-9_$.:-]+$/i.test(segment)&&!privacyIssues(segment).length?segment:'[field]';
export const safeField=field=>String(field??'').split('/').filter(Boolean).map(safeSegment).join('/')||'[root]';
const safeTarget=(flag,file)=>{const name=path.basename(String(file??''));return flag+':'+(/^[a-z0-9_.-]+$/i.test(name)&&!privacyIssues(name).length?name:'[arquivo]');};
const tableCells=line=>line.trim().replace(/^\|/,'').replace(/(?<!\\)\|$/,'').split(/(?<!\\)\|/).map(cell=>cell.trim());
const tableSeparator=line=>/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(line??'');
// Markdown findings point at line and table column; text outside tables, or spanning cells, points at the line.
export function textFindings(text){
 const found=[],add=(field,label)=>{if(!found.some(f=>f.field===field&&f.label===label))found.push({field,label});},lines=String(text??'').split(/\r?\n/);let header=null;
 lines.forEach((line,index)=>{const row=/^\s*\|/.test(line),place='linha-'+(index+1),covered=new Set();if(!row)header=null;else if(tableSeparator(line))return;else if(tableSeparator(lines[index+1]))header=tableCells(line);
  if(row)tableCells(line).forEach((cell,column)=>{const name=header?.[column],where=place+'/'+(name&&safeSegment(name)===name?name:'coluna-'+(column+1));for(const label of privacyIssues(cell)){covered.add(label);add(where,label);}});
  for(const label of privacyIssues(line))if(!covered.has(label))add(place,label);});
 return found;
}
// Structured findings by field path, plus a scan of the serialized text (keys included) as a safety net.
export function exportFindings(flag,file,value){
 const target=safeTarget(flag,file);if(typeof value==='string')return textFindings(value).map(f=>({target,...f}));
 const found=[];for(const f of privacyFindings(value)){const field=safeField(f.field);if(!found.some(x=>x.field===field&&x.label===f.label))found.push({target,field,label:f.label});}
 const labels=new Set(found.map(f=>f.label));for(const label of privacyIssues(JSON.stringify(value)??''))if(!labels.has(label))found.push({target,field:'[texto]',label});return found;
}
// One refusal for every persistence boundary of a run: ledger rows (existing, then new or replaced) and exports. Never values.
export function persistenceRefusal({existing=[],incoming=[],exports=[]}={}){
 if(!existing.length&&!incoming.length&&!exports.length)return null;const rows=list=>list.map(p=>'key='+p.key+' field='+p.field+' label='+p.label).join('\n');
 return Error('Private identifier rejected before any write; nothing was written:'+(existing.length?'\nlinhas existentes:\n'+rows(existing):'')+(incoming.length?'\nlinhas novas ou substituídas:\n'+rows(incoming):'')+(exports.length?'\nexportações:\n'+exports.map(p=>'target='+p.target+' field='+p.field+' label='+p.label).join('\n'):'')+(existing.length?'\nReparo disponível: speed-ledger repair --ledger X (prévia; grava somente com --confirm <n>).':''));
}
