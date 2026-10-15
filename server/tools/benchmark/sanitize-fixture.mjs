import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { continuationWord } from './measure/legacy-owner-continuation.mjs';
import {privacyIssues,privateField} from './privacy.mjs';
export {privacyIssues} from './privacy.mjs';

const enumKeys=new Set(['type','role','name','tool','server','code','outcome','result','ok','failed','status','lane','step','phase','subtype','kind','action','command','view','until']);
const outcomes=new Set(['entregue','entregue e publicado','delivered','published','refused','uncertain','completed','failed','succeeded','write','read','o11','odc']);
const identifierKeys=/^(id|uuid|.*_id|.*Id|call_id|tool_use_id|parent_thread_id|forked_from_id)$/;
export const MAX_FIXTURE_BYTES=64*1024;
export const MAX_FIXTURE_TOTAL_BYTES=512*1024;
const escapePointer=s=>s.replace(/~/g,'~0').replace(/\//g,'~1');
/** Preserve UTF-8 size and structural evidence; never persist source text. */
export function sanitizeRows(rows,{idMap=new Map(),textMap=new Map(),fillMap=new Map(),ordinalMap=new Map(),removed=[]}={}){
 const ids=idMap,textCache=textMap,fills=fillMap,ordinals=ordinalMap;
 function identifier(s){if(!ids.has(s)){const number=String(ids.size+1);ids.set(s,('id-'+number.padStart(Math.max(0,s.length-3),'0')).slice(-s.length));}return ids.get(s);}
 function neutral(s,ordinal,offset=0,nonce=0) {let seed=((ordinal+1)*2654435761+offset*1013904223+nonce*1664525)>>>0;const alphabets=['','abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789','éèêëàâäöüñçøå','中文土石山水火木金玉田雨','😀😃😄😁😆😅😂🙂🙃😉'];return [...s].map(c=>{if(/\s/.test(c)||c==='"'||c==='\\'||c.charCodeAt(0)<32)return c;seed=(Math.imul(seed,1664525)+1013904223)>>>0;const alphabet=[...alphabets[Buffer.byteLength(c)]];return alphabet[seed%alphabet.length];}).join('');}
 function text(s,pointer='',ownerWord=null){
  try {const value=JSON.parse(s);if(value&&typeof value==='object'){const out=JSON.stringify(walk(value,'',null,pointer+'/$json'));return out+' '.repeat(Math.max(0,Buffer.byteLength(s)-Buffer.byteLength(out)));}}catch{}
  const cacheKey=(ownerWord?'owner:':'text:')+s;
  if(textCache.has(cacheKey))return textCache.get(cacheKey);
  const ordinal=ordinals.get(s);
  const preserved=/Script running with cell ID|still connecting|\[truncated\]|original token count(?::\s*\d+)?|\[BenchSSAM[^\]\r\n]*\]|tools\.(?:mcp__[A-Za-z0-9_-]+|[a-z_]+)|mcp__ssam[A-Za-z0-9_-]*__[a-z0-9_]+|ALL_TOOLS|Some MCP servers are|ssam(?:-[a-z]+)?|<\/?tool_use_error>|InputValidationError\b:?|Request timed out|(?:[A-Z][A-Z0-9_]*_(?:REFUSED|UNCERTAIN|UNREACHABLE|TIMEOUT))|\b(?:CANCELLED|TIMEOUT)\b|^\s*<[A-Za-z_][A-Za-z0-9_-]*|^\s*# AGENTS\.md instructions|^Another Claude session sent a message:|^\[Request interrupted/g;
  const ranges=[...s.matchAll(preserved)].map(m=>({index:m.index,text:m[0]}));if(ownerWord){const index=s.search(/\S/),boundary=s[index+ownerWord.length]??'';ranges.push({index,text:ownerWord+(/^[^\p{L}\p{N}_]$/u.test(boundary)?boundary:'')});}ranges.sort((a,b)=>a.index-b.index);
  let out='',nonce=0;do{out='';let at=0;for(const m of ranges){if(m.index<at)continue;out+=neutral(s.slice(at,m.index),ordinal,at,nonce)+m.text;at=m.index+m.text.length;}out+=neutral(s.slice(at),ordinal,at,nonce);nonce++;}while(fills.has(out)&&fills.get(out)!==cacheKey&&nonce<2048);
  if(fills.has(out)&&fills.get(out)!==s)throw Error('Text filler cannot preserve distinct strings within the original width');
  fills.set(out,cacheKey);textCache.set(cacheKey,out);return out;
 }
 function walk(v,key='',parent=null,pointer='',human=false){
  if(typeof v==='string'){
   if(!ordinals.has(v))ordinals.set(v,ordinals.size);
   if(key==='timestamp'||key==='at'||key==='start'||key==='end'||key.endsWith('_at')){if(Number.isFinite(Date.parse(v)))return v;}
   if(identifierKeys.test(key))return identifier(v);
   if((key==='query'||key==='intent')&&!privacyIssues(v).length&&!/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/i.test(v))return v;
   if((key==='author'||key==='recipient'||key==='agent_path')&&/^\/(?:root|[a-z_]+)(?:\/[a-z0-9_]+)*$/i.test(v))return v;
   if((key==='text'||key==='content')&&human&&!/^\s*</.test(v)){const word=continuationWord(v);if(word)return text(v,pointer,word);}
   const toolName=key==='name'&&(parent?.type==='tool_use'||['function_call','custom_tool_call'].includes(parent?.type)||parent?.input_schema||/^(mcp__|functions\.|collaboration\.)/.test(v));
   if((enumKeys.has(key)&&key!=='name'||toolName)&&(/^[A-Za-z0-9_:-]+$/.test(v)||outcomes.has(v)||toolName&&/^(functions|collaboration)\.[a-z_]+$/.test(v)))return v;
   if(key==='encrypted_content'||/^gAAAA[A-Za-z0-9_-]+$/.test(v))return 'x'.repeat(Buffer.byteLength(v));
   return text(v,pointer);
  }
  if(Array.isArray(v))return v.map((x,i)=>walk(x,key,parent,pointer+'/'+i,human));
  if(v&&typeof v==='object'){let owner=human;if(v.type==='tool_result'||v.type==='tool_use')owner=false;else if(v.type==='user')owner=typeof v.message?.content==='string'||Array.isArray(v.message?.content)&&v.message.content.some(c=>c.type==='text');else if(v.type==='message')owner=v.role==='user';else if(v.role&&v.role!=='user')owner=false;return Object.fromEntries(Object.entries(v).filter(([k,x])=>{const remove=privateField(k);if(remove)removed.push(pointer+'/'+escapePointer(k));return !remove;}).map(([k,x])=>[k,walk(x,k,v,pointer+'/'+escapePointer(k),owner)]));}
  return v;
 }
 return rows.map((r,i)=>walk(r,'',null,'/'+i));
}
/** One identity and text map for all files belonging to a multi-agent excerpt. */
export function createSanitizer(){const state={idMap:new Map(),textMap:new Map(),fillMap:new Map(),ordinalMap:new Map()};return {sanitizeRows:rows=>sanitizeRows(rows,state),sanitizeExcerpt:(rows,options={})=>sanitizeExcerpt(rows,{...state,...options})};}
/** Only explicitly selected, unmeasured context components may shrink. Paths are JSON pointers. */
export function sanitizeExcerpt(rows,{shrinkPaths=[],...options}={}) {
 const removed=[],result=sanitizeRows(rows,{...options,removed}),shrunk=[];
 for(const pointer of shrinkPaths) {
  const keys=pointer.split('/').slice(1).map(s=>s.replace(/~1/g,'/').replace(/~0/g,'~'));
  if(!keys.length||!/^\d+$/.test(keys[0]))throw Error('Shrink path must identify a record: '+pointer);
  const record=result[Number(keys[0])],last=keys.at(-1);
  const contextRecord=['prompt_snapshot','deferred_tools_record','compacted'].includes(record?.type)||['prompt_snapshot','deferred_tools_record','compacted'].includes(record?.payload?.type);
  const unmeasuredComponent=/^(prompt_snapshot|deferred_tools_record|replacement_history|summary|text|content|rendered|snapshot|full_text|fullText|encrypted_content)$/.test(last);
  if(!contextRecord||!unmeasuredComponent||keys.some(k=>/^(usage|duration|timestamp|started_at_ms|completed_at_ms|arguments|output|result|item|message|token_usage|token_usage_record)$/.test(k)))throw Error('Shrink path is not an unmeasured context component: '+pointer);
  let parent=result;for(const k of keys.slice(0,-1)){if(parent==null||!(k in parent))throw Error('Missing shrink path: '+pointer);parent=parent[k];}
  if(!parent||!(last in parent))throw Error('Missing shrink path: '+pointer);
  if(typeof parent[last]!=='string')throw Error('Only unmeasured text may shrink; record keys, types, IDs and counters must stay: '+pointer);
  const before=Buffer.byteLength(JSON.stringify(parent[last]));parent[last]='[shrunk]';
  if(Buffer.byteLength(JSON.stringify(parent[last]))<before)shrunk.push(pointer);
 }
 const bytes=fixtureBytes(result);if(bytes>MAX_FIXTURE_BYTES)throw Error('Excerpt exceeds 64 KiB; choose explicit unmeasured shrink paths');
 const issues=privacyIssues(result);if(issues.length)throw Error('Sanitized excerpt has private data: '+issues.join(', '));
 return {rows:result,shrunk,removed,bytes};
}
export const fixtureBytes=rows=>Buffer.byteLength(rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
export function main(argv=process.argv.slice(2)){
 const options={shrinkPaths:[]},errors=[];for(let i=0;i<argv.length;i++){const k=argv[i];if(!['--input','--output','--from','--to','--shrink','--expected'].includes(k))errors.push('Unknown flag: '+k);else if(!argv[i+1]||argv[i+1].startsWith('--'))errors.push('Missing value: '+k);else if(k==='--shrink')options.shrinkPaths.push(argv[++i]);else options[k.slice(2)]=argv[++i];}
 for(const k of ['input','output'])if(!options[k])errors.push('Required: --'+k);
 for(const k of ['from','to'])if(options[k]&&!Number.isFinite(Date.parse(options[k])))errors.push('Invalid date: --'+k);
 if(options.from&&options.to&&Date.parse(options.from)>Date.parse(options.to))errors.push('--from exceeds --to');
 if(errors.length)throw Error(errors.join('\n'));
 const rows=fs.readFileSync(options.input,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(r=>(!options.from||Date.parse(r.timestamp)>=Date.parse(options.from))&&(!options.to||Date.parse(r.timestamp)<=Date.parse(options.to)));
 const excerpt=sanitizeExcerpt(rows,{shrinkPaths:options.shrinkPaths}),result=excerpt.rows,output=path.resolve(options.output),directory=path.dirname(output);const existingBytes=fs.existsSync(directory)?fs.readdirSync(directory).filter(f=>f.endsWith('.jsonl')&&path.resolve(directory,f)!==output).reduce((n,f)=>n+fs.statSync(path.join(directory,f)).size,0):0;if(existingBytes+excerpt.bytes>MAX_FIXTURE_TOTAL_BYTES)throw Error('Excerpt collection exceeds 512 KiB');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(output,result.map(r=>JSON.stringify(r)).join('\n')+'\n');if(options.expected||excerpt.shrunk.length){const expectedFile=options.expected??options.output.replace(/\.jsonl$/i,'.expected.json');const prior=fs.existsSync(expectedFile)?JSON.parse(fs.readFileSync(expectedFile,'utf8')):{};fs.writeFileSync(expectedFile,JSON.stringify({...prior,records:result.length,bytes:excerpt.bytes,shrunk:excerpt.shrunk,removed:excerpt.removed},null,2)+'\n');}return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{main()}catch(e){console.error(e.message);process.exitCode=1;}}
