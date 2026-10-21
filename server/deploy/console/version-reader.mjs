import path from 'node:path';
import {runtimeDirectories} from '../../platforms/odc/facade/hosted/storage.mjs';
export function versionReader(create,options){
 const readers=new Map();let saved={};
 function refresh(){for(const dir of runtimeDirectories(options.dir)){const key=path.relative(options.dir,dir)||'.';if(!readers.has(key)){const reader=create({...options,dir});reader.restore(saved[key]);readers.set(key,reader);}}return [...readers.values()];}
 return {
  async tick(){let done=true;for(const r of refresh())if(!await r.tick())done=false;return done;},
  async coldStart(){for(const r of refresh())if(r.coldStart)await r.coldStart();else await r.tick();},
  get busy(){return refresh().some(r=>r.busy);},
  get stats(){const out={};for(const r of refresh())for(const [k,v]of Object.entries(r.stats??{}))if(typeof v==='number')out[k]=(out[k]??0)+v;return out;},
  sizes(){return refresh().reduce((sum,r)=>sum+(r.sizes?.()??0),0);},
  checkpoint(){refresh();if(readers.size===1&&readers.has('.'))return readers.get('.').checkpoint();return {versions:Object.fromEntries([...readers].map(([k,r])=>[k,r.checkpoint()]))};},
  restore(value){saved=value?.versions??{'.':value};for(const [k,r]of readers)r.restore(saved[k]);}
 };
}
