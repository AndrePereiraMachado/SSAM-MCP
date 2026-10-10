import { Catalog } from './catalog.mjs';

const catalog = new Catalog();
let schemas = 0;
const failures = [];
for (const api of catalog.apis.values()) {
  for (const operation of api.operations) {
    catalog.describe(operation.id);
    const candidates = [...operation.parameters.map(p => p.schema),
      ...Object.values(operation.requestBody?.content ?? {}).map(m => m.schema)].filter(Boolean);
    for (const schema of candidates) {
      schemas++;
      try { catalog.validate(api, schema, null, 'contract-check'); }
      catch (error) { if (error.code !== 'INPUT_INVALID') failures.push({ operationId: operation.id, code: error.code }); }
    }
  }
}
console.log(JSON.stringify({ apis: catalog.apis.size, operations: catalog.operations.size, schemas, failures }, null, 2));
if (failures.length) process.exitCode = 1;
