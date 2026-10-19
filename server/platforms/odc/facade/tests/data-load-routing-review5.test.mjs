import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTools } from '../tool-routing.mjs';

// N5 review 5: a file-load verb ("carregar", "load", "import") routes to an insert only when the records go INTO an
// entity. A file or a format on the destination side asks for a representation of existing records; a file or a
// format that describes the source ("do arquivo X", "stored in a csv file", "o json de registros X.json") keeps the load.
const isInsert = t => t.tool === 'studio_data_insert' || (t.tool === 'o11_data' && t.verb === 'insert');

const reads = {
  'claimed destinations': [
    'carregar os registros da entidade Pedido para um novo arquivo',
    'carregar os registros da entidade Pedido no meu arquivo local',
    'carregar os registros da entidade Pedido num ficheiro csv',
    'carregar os registros da entidade Pedido em formato de csv',
  ],
  'verified paraphrases': [
    'carregar os registros da entidade Pedido para um arquivo novo',
    'carregar os registros da entidade Pedido para o meu arquivo',
    'carregar os registros da entidade Pedido pra um arquivo',
    'carregar os registros da entidade Pedido pro arquivo saida.json',
    'carregar os registros da entidade Pedido dentro de um arquivo',
    'carregar os registros da entidade Pedido num documento json',
    'carregar os registros da entidade Pedido para csv',
    'carregar os registros da entidade Pedido pra json',
    'carregar os registros da entidade Pedido sob a forma de json',
    'carregar as linhas da entidade Pedido para uma planilha csv',
    'carregar os registros da entidade Pedido no formato json',
    'carregar os registros da entidade Pedido e salvar num arquivo',
    'load the Order entity records into a brand new file',
    'load the Order entity records into my file',
    'load the Order entity records into csv',
    'load the Order entity records onto a json file',
    'load the Order entity records inside a json file',
    'load the Order entity records out as a csv',
    'load the records of entity Order in json form',
    'load the Order entity records to json',
  ],
  'formats outside the list': [
    'carregar o registro 42 da entidade Cliente em xml',
    'carregar os dados do registro 42 da entidade Cliente para uma planilha',
    'importar a entidade Cliente para um arquivo excel',
    'carregar o conteúdo dos registros da entidade Pedido em texto',
    'load record 42 of entity Customer as xml',
    'load the Customer records into a spreadsheet',
    'load the rows of entity Order as text',
    'load record 7 of entity Product and show it as a table',
  ],
  'file destination with adjective, possessive or synonym': [
    'carregar os registros da entidade Pedido para um novo arquivo',
    'carregar os registros da entidade Pedido no meu arquivo local',
    'carregar os registros da entidade Pedido num ficheiro csv',
    'load the Order records into a new file',
    'load the Order records to my local file',
    'load the Order records onto disk',
  ],
  'format after the object': [
    'carregar os registros da entidade Pedido em formato de csv',
    'carregar todos os registros de Cliente para eu ver em json',
    'load all records of entity Order in csv format for download',
    'load records of Customer so I can view them in json',
    'load the contents of the Customer records into json',
  ],
  'export verb beside the load verb': [
    'carregar os registros de Cliente e exportá-los',
    'carregar o dump dos registros da entidade Pedido',
    'load a dump of the Order records',
    'load the Customer table and export it',
  ],
  'new destination paraphrases': [
    'carregar os registros da entidade Fatura para um arquivo csv separado',
    'carregar todas as linhas da entidade Pedido pra dentro de uma planilha csv',
    'importar os registros da entidade Cliente num arquivo json novo',
    'carregar os registros da entidade Produto na forma de ndjson',
    'carregar os registros da entidade Pedido para o arquivo relatorio.csv',
    'carregar os registros da entidade Cliente em um documento csv no meu disco',
    'carregar os registros na entidade Pedido para um arquivo json',
    'importar os registros da entidade Fatura pros meus arquivos csv',
    'carregar os registros que estão na entidade Pedido num arquivo csv',
    'load every record of the Invoice entity into a separate csv file',
    'import the rows of entity Order into our shared json spreadsheet',
    'load the records of entity Product out to a jsonl document',
    'load the Customer entity records to the file export.json',
    'load the records of entity Order in the form of json',
    'load the records of the Customer entity onto my disk as csv',
    'import the Order entity rows inside of a new csv file',
    'load the records of entity Invoice as a json document',
    'load the records belonging to entity Order into a json file',
  ],
};

// Loads that routed to an insert at f1f10e39 (before the file-read veto) and must keep doing so.
const loads = {
  'source loads that routed to insert before the veto': [
    'importe o json de registros pedidos.json na entidade Pedido',
    'importar para a entidade Cliente os registros que estão no arquivo clientes.json',
    'carregar os registros que estão em um arquivo csv na entidade Pedido',
    'load records stored in a csv file into entity Order',
    'carregar na entidade Pedido os registros do arquivo pedidos.csv',
    'load the records from the json file into the Customer entity',
    'importar os registros do csv clientes.csv para a entidade Cliente',
    'carregar os registros do arquivo exportado clientes.csv na entidade Cliente',
  ],
  'new source paraphrases': [
    'carregar na entidade Fatura os registros que estão no arquivo faturas.csv',
    'carregar os registros guardados num arquivo json na entidade Produto',
    'carregar registros a partir do arquivo produtos.csv na entidade Produto',
    'importar os registros do arquivo json exportado para a entidade Cliente',
    'carregar os registros contidos no arquivo csv para a entidade Pedido',
    'carregar os registros de um arquivo csv novo para a entidade Fatura',
    'importar na entidade Cliente as linhas do arquivo clientes.ndjson',
    'carregar os registros num arquivo csv na entidade Pedido',
    'load the records kept in a csv file into the Invoice entity',
    'import records from the file invoices.ndjson into entity Invoice',
    'load into entity Customer the records that are in customers.jsonl',
    'import the rows stored in a json file into entity Product',
    'load records from my local csv file into entity Order',
    'load records from the csv file in my downloads folder into entity Order',
  ],
};

for (const lane of ['odc', 'o11']) {
  for (const [family, intents] of Object.entries(reads)) test(`N5 review5 ${lane} ${family}: reading or exporting records never routes to insert`, () => {
    const failures = intents.filter(intent => routeTools({ lane, intent }).tools.some(isInsert));
    assert.deepEqual(failures, []);
  });
  for (const [family, intents] of Object.entries(loads)) test(`N5 review5 ${lane} ${family}: a file that is the source keeps the insert`, () => {
    const failures = intents.filter(intent => !routeTools({ lane, intent }).tools.some(isInsert));
    assert.deepEqual(failures, []);
  });
}
