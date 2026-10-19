import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTools, discoverAll } from '../tool-routing.mjs';

const review = [
 'open record 42 of entity Customer as JSON',
 'abrir o registro 42 da entidade Cliente em json',
 'abrir o registro 42 da entidade Cliente no formato csv',
 'open the records of entity Product in a csv file',
 'abrir os registros da entidade Produto num arquivo csv',
 'open record 42 of entity Customer and save it to a file',
 'carregar o registro 42 da entidade Cliente para um arquivo',
 'open the source of record 42 of entity Customer',
 'abrir a fonte do registro 42 da entidade Cliente',
 'load the json of record 42 of entity Order',
 'open the jsonl journal of the records of entity Order',
 'abrir o arquivo de log do registro 7 da entidade Pedido',
];
const skeptic = [
 'open record 42 of entity Customer as JSON', 'open record 7 of entity Invoice in csv',
 'reopen record 3 of entity Order as ndjson',
 'open record 42 of entity Customer and save it to a file',
 'open the records of entity Product and write them to a file',
 'open the source of record 42 of entity Customer', 'load the json of record 42 of entity Order',
 'abrir o registro 42 da entidade Cliente em json', 'reabrir o registro 9 da entidade Fatura em csv',
 'abrir os registros da entidade Produto e salvar num arquivo',
 'carregar o registro 42 da entidade Cliente para um arquivo', 'abrir a fonte do registro 42 da entidade Cliente',
];
const formats = ['csv','json','jsonl','ndjson'];
const opening = ['abrir','abra','open','reabrir','reopen'].flatMap(verb => [
 `${verb} records from customers.csv into entity Customer`,
 `${verb} registros do arquivo clientes.json na entidade Cliente`,
 `${verb} records from source customers into entity Customer`,
]);
const exports = formats.flatMap(format => [
 `load record 42 of entity Customer as ${format}`,
 `carregar registro 42 da entidade Cliente em ${format}`,
 `carregar registro 42 da entidade Cliente no formato ${format}`,
 `load the ${format} of record 42 of entity Customer`,
]);
const loads = formats.flatMap(format => [
 `load records from customers.${format} into entity Customer`,
 `carregar registros do arquivo clientes.${format} na entidade Cliente`,
 `import records from customers.${format} into entity Customer`,
 `importar registros do arquivo clientes.${format} para a entidade Cliente`,
]);
loads.push('load records from source customers into entity Customer',
 'carregue registros da fonte clientes na entidade Cliente',
 'load the records of the file customers.json into entity Customer',
 'carregar linhas do arquivo pedidos.jsonl na entidade Pedido',
 'importar registros de um arquivo csv para a entidade Cliente',
 'import records from a csv file into entity Customer');
const isInsert = item => item.tool === 'studio_data_insert' || item.tool === 'o11_data' && item.verb === 'insert';
for (const lane of ['o11','odc']) {
 test(`N5 review3 ${lane}: review twelve reads and exports never insert`, () => {
  for (const intent of review) assert.ok(!routeTools({lane,intent}).tools.some(isInsert),intent);
 });
 test(`N5 review3 ${lane}: independent twelve reads and format families never insert`, () => {
  for (const intent of [...skeptic,...exports,...opening]) assert.ok(!routeTools({lane,intent}).tools.some(isInsert),intent);
 });
 test(`N5 review3 ${lane}: M10 file loads, import verbs and explicit record inserts survive`, () => {
  for (const intent of [...loads,'inserir registros na entidade Cliente','insert records into entity Customer']) {
   assert.ok(isInsert(routeTools({lane,intent}).tools[0] ?? {}),intent);
  }
 });
 test(`N5 review3 ${lane}: discover agrees with routes for reads and file loads`, async () => {
  for (const intent of [...review,...exports,...loads]) {
   const out=await discoverAll({lane,intent},{discover:async()=>({ok:true,lane,intent,matches:[]})});
   const tools=out.tools?.items ?? out.tools ?? [];
   assert.equal(tools.some(isInsert),loads.includes(intent),intent);
  }
 });
}
