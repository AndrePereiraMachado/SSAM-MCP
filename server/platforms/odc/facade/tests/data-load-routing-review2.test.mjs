import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTools, discoverAll } from '../tool-routing.mjs';
const reads = ['open record 42 of entity Customer','abrir o registro 42 da entidade Cliente','open the records of entity Product','carregar uma linha da entidade Pedido','abra o registro 7 da entidade Pedido','load the row 42 from entity Order','reopen the record of entity Invoice','mostrar o registro 42 da entidade Cliente','ver os registros da entidade Cliente','ler os registros da entidade Produto','load records of entity Product','abrir as linhas da entidade Pedido'];
const loads = ['carregar os registros do arquivo clientes.csv na entidade Cliente','load records from customers.csv into entity Customer','load records from customers.json into entity Customer','load records from customers.jsonl into entity Customer','load records from customers.ndjson into entity Customer','carregar registros da fonte clientes na entidade Cliente','load records from source customers into entity Customer'];
const inserts = ['inserir registros na entidade Cliente','insert records into entity Customer'];
const isInsert = item => item.tool === 'studio_data_insert' || item.tool === 'o11_data' && item.verb === 'insert';
for (const lane of ['o11','odc']) {
 test(`N5 ${lane}: opening, seeing and loading existing entity records never route to insert`, () => {
  for (const intent of reads) assert.ok(!routeTools({lane,intent}).tools.some(isInsert),intent);
 });
 test(`N5 ${lane}: M10 explicit file/source loads and existing inserts still route to insert`, () => {
  for (const intent of [...loads,...inserts]) assert.ok(isInsert(routeTools({lane,intent}).tools[0] ?? {}),intent);
 });
 test(`N5 ${lane}: discover carries no insert for record reads and retains insert for file loads`, async () => {
  for (const intent of [...reads,...loads]) {
   const out=await discoverAll({lane,intent},{discover:async()=>({ok:true,lane,intent,matches:[]})});
   const tools=out.tools?.items ?? out.tools ?? [];
   assert.equal(tools.some(isInsert),loads.includes(intent),intent);
   assert.ok(Buffer.byteLength(JSON.stringify(out))<=12000);
  }
 });
}
