import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// The facade server over real stdio with the official SDK client. No tenant request and no Studio
// mutation: SSAM_ODC_OFFLINE keeps it away from the user's own ODC Studio, its bridge and the vault, so the
// assertions that need a running Studio are skipped, and studio_build runs only when the builder is already built.
const builderBuilt = fs.existsSync(fileURLToPath(new URL('../../studio/builder/bin/Release/net10.0/ODC3.Builder.dll', import.meta.url)));
async function connect(env = {}) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../mcp.mjs', import.meta.url))],
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', SSAM_ODC_OFFLINE: '1', ...env }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'ssam-hybrid-odc-test-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, get stderr() { return stderr; } };
}

test('facade serves studio_* and odc_* tools on one stdio server', async () => {
  const connection = await connect();
  const { client } = connection;
  try {
    const tools = (await client.listTools()).tools;
    const names = tools.map(t => t.name);
    for (const expected of ['studio_doctor', 'studio_status', 'studio_build', 'studio_merge', 'studio_publish', 'studio_authorize', 'studio_refresh_references', 'odc_status', 'odc_search_operations', 'odc_read', 'hybrid_tenants', 'ssam_map',
      'odc_auth_status', 'odc_write', 'odc_receipt', 'odc_portal_read', 'odc_portal_write', 'odc_portal_login', 'odc_operation_status', 'odc_deploy', 'odc_configurations', 'odc_asset_delete', 'odc_external_db_connection']) assert.ok(names.includes(expected), expected);
    // Every write tool takes the user's words and a UUID; reads take the tenant per call.
    for (const write of ['odc_write', 'odc_portal_write', 'odc_deploy', 'odc_asset_delete']) {
      const schema = tools.find(t => t.name === write).inputSchema;
      assert.ok(schema.required.includes('authorize') && schema.required.includes('operationUuid'), write);
    }
    assert.ok(tools.find(t => t.name === 'odc_read').inputSchema.properties.tenant);
    // Lane extlib: odc_external_library is served with the schema the routes are written against (contract section 5).
    const library = tools.find(t => t.name === 'odc_external_library');
    assert.ok(library, 'odc_external_library is listed');
    assert.deepEqual(library.inputSchema.required, ['action']);
    assert.deepEqual(library.inputSchema.properties.action.enum, ['build', 'deploy', 'status', 'discard']);
    assert.deepEqual(Object.keys(library.inputSchema.properties).sort(), ['action', 'auth', 'authorizationContext', 'authorize', 'confirmTenant', 'expectedRevision', 'jobKey', 'library', 'operationUuid', 'originOperationUuid', 'pid',
      'releaseNotes', 'releaseTag', 'spec', 'specFile', 'tenant'].sort());
    assert.deepEqual(library.inputSchema.properties.auth.enum, ['auto', 'studio', 'api-client']);
    assert.deepEqual(library.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    assert.doesNotMatch(JSON.stringify(library.inputSchema), /Alone:|Instead of job|password|clientSecret/);
    // Offline, an invalid spec is refused before anything runs.
    const invalid = await client.callTool({ name: 'odc_external_library', arguments: { action: 'build', spec: { name: '9Lib', actions: [] } } });
    assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.code, 'EXTERNAL_LIBRARY_SPEC_INVALID');
    assert.match(client.getInstructions(), /ODC Studio session first.*headless HTTP.*Windows vault.*private Windows prompt only when the tenant has nothing stored/);
    // The map is the first read of an application, both lanes, read-only; the instructions say so.
    const map = tools.find(t => t.name === 'ssam_map');
    assert.equal(map.annotations.readOnlyHint, true);
    assert.deepEqual(map.inputSchema.properties.lane.enum, ['odc', 'o11']);
    assert.ok(map.inputSchema.properties.role.enum.includes('screen'));
    assert.match(client.getInstructions(), /To read an application, start with ssam_map \{lane, target, view:"digest"\}: the whole module as text, in pages.*read it once and work in context\. ssam_map \{lane, target\} lists every element with its @key.*studio_inspect only to go deeper into an @key \(path "@<key>" with expectedSourceSha256\)/);
    // logic: the view flow under the word of ssam_code (part logic).
    assert.deepEqual(map.inputSchema.properties.view.enum, ['map', 'digest', 'ddl', 'flow', 'search', 'uses', 'html', 'logic']);
    assert.match(map.description, /ssam_code/);
    // One action whole, as text with its fixed point (ssam-flow/1).
    assert.match(map.description, /view "flow" \{element: @key, Flow\/Screen\/Action or the action name\}: one action as ssam-flow\/1 text, whole/);
    assert.match(map.description, /view "digest": the whole module as compact text/);
    // The data text: entities, structures, variables and timers as DDL with an @key on every element.
    assert.match(map.description, /view "ddl": the module data as text with an @key on every element/);
    // Cross-cutting questions in one call: search and uses over one capture or the list of an app's modules.
    assert.match(map.description, /view "search" \{text, regex\?, property\?, kind\?, role\?\}.*view "uses" \{element: @key, Module\.Element/);
    assert.ok(map.inputSchema.properties.target.anyOf.some(s => s.type === 'array'), 'target takes a list');
    assert.ok(map.inputSchema.properties.expectedSourceSha256.anyOf.some(s => s.type === 'array'), 'one hash per target');
    for (const field of ['text', 'regex', 'property', 'element']) assert.ok(map.inputSchema.properties[field], field);
    assert.match(client.getInstructions(), /Cross-cutting questions .*: ONE ssam_map call, view "search" \{text\} or view "uses" \{element\}/);
    assert.match(tools.find(t => t.name === 'studio_inspect').description, /Start with ssam_map/);
    assert.ok(names.includes('ssam_debug'));
    assert.ok(!names.includes('studio_debug'));
    const tenantsResult = await client.callTool({ name: 'hybrid_tenants', arguments: {} });
    assert.equal(tenantsResult.structuredContent.ok, true);
    assert.ok(tenantsResult.structuredContent.tenants.length >= 2);
    for (const tenant of tenantsResult.structuredContent.tenants) assert.equal(typeof tenant.credentialAvailable, 'boolean');
    const status = await client.callTool({ name: 'odc_status', arguments: {} });
    assert.equal(status.structuredContent.catalog.operationCount, 163);
    const doctor = await client.callTool({ name: 'studio_doctor', arguments: {} });
    assert.ok(Array.isArray(doctor.structuredContent.checks));
    assert.ok(doctor.structuredContent.checks.some(c => c.name === 'bridge built'));
    const studioRunning = doctor.structuredContent.checks.find(c => c.name === 'ODC Studio running')?.ok === true;
    const attached = doctor.structuredContent.checks.find(c => c.name === 'bridge attached')?.ok === true;
    if (studioRunning && attached) {
      const brief = await client.callTool({ name: 'studio_status', arguments: {} });
      assert.equal(brief.structuredContent.ok, true);
      assert.ok(Array.isArray(brief.structuredContent.modules));
    }
    if (builderBuilt) {
      const build = await client.callTool({ name: 'studio_build', arguments: { feature: 'list', output: 'unused', newModule: true } });
      assert.equal(typeof build.structuredContent.ok, 'boolean');
    }
    // Offline, nothing to authenticate with: the write is refused before any receipt, prompt or send.
    const write = await client.callTool({ name: 'odc_write', arguments: { tenant: 'personal-nv0s5uly.outsystems.dev', operationId: 'portfolio-api-v2:patch:/portfolios/{portfolioKey}',
      path: { portfolioKey: '11111111-1111-4111-8111-111111111111' }, body: {}, authorize: 'short', operationUuid: '11111111-1111-4111-8111-111111111111' } }).catch(error => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(write.isError, true);
    const authStatus = await client.callTool({ name: 'odc_auth_status', arguments: { tenant: 'personal-nv0s5uly.outsystems.dev' } });
    assert.equal(authStatus.structuredContent.ok, true); assert.equal(authStatus.structuredContent.studio.running, false);
    assert.equal(authStatus.structuredContent.tenants[0].resolves.public, 'AUTH_NOT_CONFIGURED');
    assert.equal(connection.stderr, '');
  } finally { await client.close(); }
});
