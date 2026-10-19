import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTools } from '../tool-routing.mjs';
const formats=['csv','json','jsonl','ndjson'];
const formatsRead=formats.flatMap(f=>['como','em','no','as','in','to'].flatMap(p=>['','a ','the ','um ','formato ','the format '].map(a=>`load record 7 of entity Invoice ${p} ${a}${f}`)));
const destinations=['para','num','em','no','to','into'].flatMap(p=>['','um ','a ','the ','um csv ','a json '].flatMap(a=>['arquivo','file'].map(f=>`load records of entity Invoice ${p} ${a}${f}`)));
const sources=['fonte','source',...formats].flatMap(s=>['de','do','dos','of'].flatMap(p=>['','the ','os '].flatMap(a=>['registro','registros','record','records'].map(r=>`load the ${s} ${p} ${a}${r} 7 of entity Invoice`))));
const controls=[
 'carregar o arquivo clientes.csv e salvar os registros na entidade Cliente',
 'load customers.csv and save the records into entity Customer',
 'carregar os registros do arquivo exportado clientes.csv na entidade Cliente',
 'load the records of the exported file customers.csv into entity Customer',
 'importar os registros do arquivo csv e salvar na entidade Pedido',
 'load records from invoices.csv into entity Invoice',
 'import records from a csv file into entity Invoice',
 'importar registros da fonte de dados externa para a entidade Cliente',
 'import records from the external data source into entity Customer',
];
const isInsert=t=>t.tool==='studio_data_insert'||t.tool==='o11_data'&&t.verb==='insert';
for(const lane of ['o11','odc']) {
 for(const [family,intents] of Object.entries({formatsRead,destinations,sources})) test(`N5 review4 ${lane} ${family}: grammatical read families veto inserts`,()=>{
  const failures=intents.filter(intent=>routeTools({lane,intent}).tools.some(isInsert));
  assert.deepEqual(failures,[]);
 });
 test(`N5 review4 ${lane}: load controls retain save/export data words`,()=>{
  for(const intent of controls) assert.ok(routeTools({lane,intent}).tools.some(isInsert),intent);
 });
}
