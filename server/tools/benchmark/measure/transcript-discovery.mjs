import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
export function jsonlFiles(dir){if(!fs.existsSync(dir))return[];return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?jsonlFiles(path.join(dir,e.name)):e.isFile()&&e.name.endsWith('.jsonl')?[path.join(dir,e.name)]:[]);}
const headerCache=new Map();
export function transcriptHeader(file,client){
 const stat=fs.statSync(file),key=client+':'+file,prior=headerCache.get(key);if(prior?.mtime===stat.mtimeMs&&prior.size===stat.size)return prior.value;
 const fd=fs.openSync(file,'r');let text;try{const buffer=Buffer.alloc(Math.min(fs.statSync(file).size,262144));const n=fs.readSync(fd,buffer,0,buffer.length,0);text=buffer.subarray(0,n).toString('utf8');}finally{fs.closeSync(fd);}
 for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)){try{const r=JSON.parse(line);let value;if(client==='codex'&&r.type==='session_meta')value={...r.payload,at:r.timestamp};if(client==='claude'&&r.cwd)value={id:r.sessionId??path.basename(file,'.jsonl'),cwd:r.cwd,at:r.timestamp};if(value){headerCache.set(key,{mtime:stat.mtimeMs,size:stat.size,value});return value;}}catch{}}
 return{};
}
export function codexRelatedFiles(file,options={}){
 const header=transcriptHeader(file,'codex');let inferredHome=null,cursor=path.dirname(file);while(path.dirname(cursor)!==cursor){if(['sessions','archived_sessions'].includes(path.basename(cursor))){inferredHome=path.dirname(cursor);break;}cursor=path.dirname(cursor);}const home=options.codexHome??inferredHome;
 const dirs=new Set([path.dirname(file)]);if(home)dirs.add(path.join(home,'archived_sessions'));
 const day=path.dirname(file),dayName=path.basename(day),month=path.basename(path.dirname(day)),year=path.basename(path.dirname(path.dirname(day)));if(/^\d{4}$/.test(year)&&/^\d{2}$/.test(month)&&/^\d{2}$/.test(dayName)){const next=new Date(`${year}-${month}-${dayName}T12:00:00Z`);if(Number.isFinite(next.getTime())){next.setUTCDate(next.getUTCDate()+1);dirs.add(path.resolve(day,'../../..',String(next.getUTCFullYear()),String(next.getUTCMonth()+1).padStart(2,'0'),String(next.getUTCDate()).padStart(2,'0')));}}
 const d=new Date(header.at??header.timestamp);if(home&&Number.isFinite(d.getTime()))for(let i=0;i<2;i++){dirs.add(path.join(home,'sessions',String(d.getUTCFullYear()),String(d.getUTCMonth()+1).padStart(2,'0'),String(d.getUTCDate()).padStart(2,'0')));d.setUTCDate(d.getUTCDate()+1);}
 return [...new Set([...dirs].flatMap(jsonlFiles))].filter(f=>f!==file&&transcriptHeader(f,'codex').parent_thread_id===header.id);
}
export function discoverSessions(options){
 const codexHome=options.codexHome??path.join(os.homedir(),'.codex'),claudeHome=options.claudeHome??path.join(os.homedir(),'.claude');
 const workspaces=new Set(options.workspaces.map(v=>path.resolve(v).toLowerCase()));
 const since=Date.parse(options.since),until=options.until?Date.parse(options.until):Infinity;
 const results={codex:[],claude:[],codexHome,claudeHome};
 for(const client of ['codex','claude']){const files=client==='codex'?jsonlFiles(path.join(codexHome,'sessions')).concat(jsonlFiles(path.join(codexHome,'archived_sessions'))):jsonlFiles(path.join(claudeHome,'projects'));
  for(const f of files){const stat=fs.statSync(f);if(stat.mtimeMs<since)continue;const h=transcriptHeader(f,client);if(h.parent_thread_id||f.split(path.sep).includes('subagents')||!h.cwd||!workspaces.has(path.resolve(h.cwd).toLowerCase()))continue;if(Number.isFinite(Date.parse(h.at))&&Date.parse(h.at)>until)continue;
   const fd=fs.openSync(f,'r');let tail;try{const buffer=Buffer.alloc(Math.min(stat.size,262144)),length=fs.readSync(fd,buffer,0,buffer.length,Math.max(0,stat.size-buffer.length));tail=buffer.subarray(0,length).toString('utf8');}finally{fs.closeSync(fd);}const dates=tail.split(/\r?\n/).flatMap(line=>{try{const r=JSON.parse(line),t=Date.parse(r.timestamp);return Number.isFinite(t)?[t]:[];}catch{return[];}});if(dates.length&&Math.max(...dates)<since)continue;
   results[client].push(f);}
 }return results;
}
