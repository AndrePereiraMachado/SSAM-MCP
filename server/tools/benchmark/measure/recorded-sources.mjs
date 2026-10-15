import fs from 'node:fs';
import path from 'node:path';
const timestampCache=new Map();
function latestRecordedTimestamp(file,stat){
 const previous=timestampCache.get(file);
 if(previous&&previous.size===stat.size&&previous.mtimeMs===stat.mtimeMs&&previous.ctimeMs===stat.ctimeMs)return previous.latest;
 let latest=-Infinity;
 for(const line of fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)){
  try{const timestamp=Date.parse(JSON.parse(line).timestamp);if(Number.isFinite(timestamp))latest=Math.max(latest,timestamp);}catch{}
 }
 timestampCache.set(file,{size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,latest});return latest;
}

/** A saved report selects its exact inputs; directory dates never extend its scope. */
export function selectRecordedSources(report,candidateFiles,{reportMtimeMs}={}) {
 const files=[],changed=[],diagnostics=[];
 for(const source of report.sessions??[]) {
  const candidates=candidateFiles.filter(file=>path.basename(file)===path.basename(source.file));
  if(!candidates.length){changed.push(`fonte mudou: ${source.file}: arquivo ausente`);continue;}
  const expectedSize=source.size??source.bytes??source.stat?.size;
  const mtime=source.mtimeMs??source.stat?.mtimeMs??source.mtime;
  const expectedMtime=typeof mtime==='number'?mtime:typeof mtime==='string'?Date.parse(mtime):undefined;
  const mismatches=[];let matched=null;
  for(const file of candidates) {
   let stat;try{stat=fs.statSync(file);}catch{mismatches.push(`${file}: arquivo ausente`);continue;}
   const problems=[];
   if(Number.isFinite(reportMtimeMs)&&stat.mtimeMs>reportMtimeMs)problems.push(`mtime da fonte posterior à saída gravada`);
   if(Number.isFinite(reportMtimeMs)&&latestRecordedTimestamp(file,stat)>reportMtimeMs)problems.push('timestamp de registro posterior à saída gravada');
   if(expectedSize!==undefined&&stat.size!==expectedSize)problems.push(`tamanho ${stat.size} != ${expectedSize}`);
   if(expectedMtime!==undefined&&stat.mtimeMs!==expectedMtime)problems.push(`mtime ${stat.mtimeMs} != ${expectedMtime}`);
   if(!problems.length){matched=file;break;}mismatches.push(`${file}: ${problems.join(', ')}`);
  }
  if(!matched){changed.push(`fonte mudou: ${source.file}: ${mismatches.join('; ')}`);continue;}
  files.push(matched);
  if(expectedSize===undefined||expectedMtime===undefined)diagnostics.push(`${source.file}: ${[expectedMtime===undefined?'mtime':null,expectedSize===undefined?'tamanho':null].filter(Boolean).join('/')} não registrados; integridade histórica não verificável`);
 }
 return {files,changed,diagnostics};
}
