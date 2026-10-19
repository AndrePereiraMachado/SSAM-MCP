// Real exit after DB persistence, before native acknowledgment: durable pending.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const [moduleFile,inputJson,dbFile,journalRoot]=process.argv.slice(2);
const {runDataLoad}=await import(pathToFileURL(moduleFile).href);
const entity={name:'E',key:'entity-e',moduleKey:'module-m',identifier:'Id',attributes:[{name:'Id',type:'E Identifier'},{name:'Code',type:'Text'},{name:'Value',type:'Text'}]};
const read=()=>JSON.parse(fs.readFileSync(dbFile,'utf8'));let writes=0;
await runDataLoad(JSON.parse(inputJson),{
  context:async()=>({tenant:'synthetic.test',moduleKey:'module-m',entityKey:'entity-e',identifier:'Id'}),
  identity:async()=>({lane:'odc',host:'synthetic.test',tenant:'synthetic.test',module:'module-m',moduleKey:'module-m',entity:'entity-e',entityKey:'entity-e'}),
  schema:async()=>({moduleKey:'module-m',entities:[entity]}),readAll:async()=>({records:read(),complete:true}),
  write:async ops=>{
    const rows=read(),results=[];for(const op of ops){const ids=op.records.map(record=>{const Id=String(rows.length+1);rows.push({...record,Id});return Id;});results.push({ok:true,outcome:'completed',ids});}
    fs.writeFileSync(dbFile,JSON.stringify(rows));if(++writes===2)process.exit(23);return results;
  }
},{journalRoot});
throw new Error('Native writer did not reach second batch');
