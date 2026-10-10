import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const get = async url => {
  const r = await fetch(url, { headers: { 'User-Agent': 'ODC-Portal-API-Catalog' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status}: ${url}`);
  return r.text();
};
const commit = JSON.parse(await get('https://api.github.com/repos/OutSystems/docs-odc/commits/main')).sha;
const tree = JSON.parse(await get(`https://api.github.com/repos/OutSystems/docs-odc/git/trees/${commit}?recursive=1`));
if (tree.truncated) throw new Error('Incomplete source tree');
const sources = tree.tree.filter(x => /^src\/eap\/reference\/apis\/resources\/.*\.json$/.test(x.path));
const methods = new Set(['get','post','put','patch','delete','head','options']);
await fs.mkdir(path.join(root, 'specs'), { recursive: true });
const apis = [];
for (const source of sources) {
  const url = `https://raw.githubusercontent.com/OutSystems/docs-odc/${commit}/${source.path}`;
  const raw = await get(url);
  const spec = JSON.parse(raw);
  if (!spec.openapi && !spec.swagger) throw new Error(`Not an OpenAPI document: ${source.path}`);
  const name = path.basename(source.path, '.json');
  await fs.writeFile(path.join(root, 'specs', `${name}.json`), raw);
  const operations = [];
  for (const [route, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      if (!methods.has(method)) continue;
      operations.push({ id: `${name}:${method}:${route}`, operationId: op.operationId ?? null,
        method: method.toUpperCase(), path: route, summary: op.summary ?? '',
        description: op.description ?? '', deprecated: !!op.deprecated,
        readOnly: ['get','head','options'].includes(method),
        security: op.security ?? spec.security ?? [],
        parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])],
        requestBody: op.requestBody ?? null, responses: op.responses ?? {},
        servers: op.servers ?? item.servers ?? spec.servers ?? [] });
    }
  }
  apis.push({ id: name, title: spec.info?.title, version: spec.info?.version,
    source: url, sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    specFile: `specs/${name}.json`, servers: spec.servers ?? [],
    securitySchemes: spec.components?.securitySchemes ?? spec.securityDefinitions ?? {},
    schemaCount: Object.keys(spec.components?.schemas ?? spec.definitions ?? {}).length,
    operations });
}
const catalog = { generatedAt: new Date().toISOString(), sourceCommit: commit,
  scope: 'Official published OpenAPI documents; runtime access is not established by catalog generation.',
  apiCount: apis.length, operationCount: apis.reduce((n,a)=>n+a.operations.length,0), apis };
await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify(catalog, null, 2));
const lines = ['# ODC public API operation inventory', '', `Source: OutSystems/docs-odc commit ${commit}.`, '',
  'Generated from official OpenAPI documents. This is an inventory, not proof of authenticated access. GET/HEAD/OPTIONS are classified as reads; all other methods require explicit write policy.', ''];
for (const api of apis) {
  lines.push(`## ${api.title}`, '', `[Official specification](${api.source})`, '',
    `Base URLs: ${api.servers.map(s=>s.url).join(', ')}`, '', '| Method | Path | Operation ID | Deprecated |', '|---|---|---|---|');
  for (const op of api.operations) lines.push(`| ${op.method} | \`${op.path}\` | \`${op.operationId ?? ''}\` | ${op.deprecated ? 'yes' : ''} |`);
  lines.push('');
}
await fs.writeFile(path.join(root, 'OPERATIONS.md'), lines.join('\n'));
console.log(JSON.stringify({apiCount:catalog.apiCount, operationCount:catalog.operationCount,
  apis:apis.map(a=>({id:a.id,title:a.title,servers:a.servers,operations:a.operations.length,
    reads:a.operations.filter(o=>o.readOnly).length,securitySchemes:a.securitySchemes,
    monitoringCandidates:a.operations.filter(o=>/logs|traces|observability/i.test(o.path+' '+o.summary)).map(o=>({method:o.method,path:o.path,summary:o.summary}))}))},null,2));
