// Read-only view of router metadata and the newest Studio observation per license.
import fs from 'node:fs';
import path from 'node:path';
import {readStudioVersions} from '../../platforms/odc/facade/studio-version-state.mjs';
const version=v=>/^(\d+\.\d+\.\d+)(?:\.\d+)?$/.exec(String(v??''))?.[1]??null;
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const newest=values=>values.filter(Boolean).sort().at(-1)??null;
export function studioVersions(serverDir){
 const metadata=read(path.join(serverDir,'state/backend-versions.json'));
 const legacy=read(path.join(serverDir,'kernel.json'));
 const backends=(Array.isArray(metadata?.backends)?metadata.backends:legacy?[{name:'legacy',...legacy,default:true}]:[])
  .filter(b=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(b.name)&&version(b.odc)&&version(b.o11));
 const routes=read(path.join(serverDir,'state/routing.json'))?.routes??{};
 const leaving=read(path.join(serverDir,'state/proposed-versions.json'))?.leaving??{};
 let state={tokens:{}},error=null;try{state=readStudioVersions(serverDir);}catch{error='Studio observations unavailable.';}
 const tokens=Object.entries(state.tokens).filter(([id])=>/^tok_[0-9a-f]{12}$/.test(id));
 const fallback=backends.find(b=>b.default)?.name;
 const rows=[];
 for(const lane of ['odc','o11']){
  for(const b of backends){
   const customers=tokens.filter(([id,t])=>version(t[lane]?.installed)&&(routes[id]?.backend??fallback)===b.name);
   rows.push({lane,version:version(b[lane]),backend:b.name,status:leaving[lane]?.includes(b[lane])?'leaving':b.default?'default':'served',customers:customers.length,lastSeen:newest(customers.map(([,t])=>iso(t.seen)))});
  }
  const missing=new Map();
  for(const [,t]of tokens){const v=version(t[lane]?.installed);if(!v||backends.some(b=>version(b[lane])===v))continue;const list=missing.get(v)??[];list.push(iso(t.seen));missing.set(v,list);}
  for(const [v,seen]of missing)rows.push({lane,version:v,backend:null,status:'unserved',customers:seen.length,lastSeen:newest(seen)});
 }
 return {window:Number.isInteger(metadata?.window)?metadata.window:1,rows,error};
}
