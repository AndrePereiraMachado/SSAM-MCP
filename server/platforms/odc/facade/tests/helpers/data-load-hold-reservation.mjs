// A real process that takes the entity reservation and then hangs until it is killed from outside (no finally runs).
// Usage: node data-load-hold-reservation.mjs <inline|load> <journalRoot> <lane> <marker> <rowsFile>
//   inline: inside withDataEntityReservation (an inline insert/update whose native call never returns);
//   load:   a keyed file load between acquireEntity and plan.json (its target read never returns).
import fs from 'node:fs';
import {withDataEntityReservation} from '../../data-load-lock.mjs';
import {runDataLoad} from '../../data-load.mjs';
const [mode,journalRoot,lane,marker,rowsFile]=process.argv.slice(2);
const identity={lane,host:'synthetic.test',tenant:'synthetic.test',moduleKey:'module-m',entityKey:'entity-e',module:'M',entity:'E'};
const hang=()=>{fs.writeFileSync(marker,String(process.pid));setInterval(()=>{},1000);return new Promise(()=>{});};
if(mode==='inline')await withDataEntityReservation(identity,{journalRoot},hang);
else{
  const entity={name:'E',identifier:'Id',attributes:[{name:'Id',type:'E Identifier'},{name:'Code',type:'Text'}],indexes:[]};
  await runDataLoad({lane,host:'synthetic.test',module:'M',entity:'E',operation:'insert',files:[rowsFile],keys:['Code'],operationId:'c0000000-0000-4000-8000-00000000000c',authorization:'load synthetic rows'},
    {identity:async()=>identity,schema:async()=>({entities:[entity]}),check:async()=>({ok:true}),readAll:hang,write:async()=>{throw new Error('never reached');}},{journalRoot});
}
throw new Error('the holder returned');
