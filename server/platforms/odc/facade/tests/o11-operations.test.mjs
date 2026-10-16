// The code under test writes under the user's profile: this process's profile is a temporary folder.
import './fixtures/isolated-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { serviceCenterArguments, registerO11Operations } from '../o11-operations.mjs';
import { createSsamServer, o11DataArguments } from '../ssam.mjs';
import { Journal } from '../service-center/client.mjs';
import { FakeBridge, temp } from './fixtures/sc-fake-bridge.mjs';
import { CONFIRM_MIN_AGE_MS } from '../destructive-operations.mjs';
import { fakeClock, noBackup } from './fixtures/destructive-flow.mjs';

process.env.ANVIL_WORKER = '0'; process.env.ANVIL_ODC_NO_WORKER = '1';
const registered = (deps = {}) => {
  const entries = new Map();
  registerO11Operations({ registerTool: (name, tool, handler) => entries.set(name, { ...tool, handler }) }, schema => schema, deps);
  return entries;
};

test('typed provider read reaches IntegrationStudio with only its exact target arguments', async () => {
  const bridge = new FakeBridge({api: {TranslateLogicalDatabaseToDbConnection: {providerObserved:true,mappingAbsentProven:false,dbConnection:{name:'Proof',providerName:'SqlServer'}}}});
  const entries = registered({serviceCenter:{locate:()=>bridge,present:async()=>false,running:async()=>false}});
  const result = await entries.get('o11_service_center_read').handler({action:'extension-database-provider',host:'test.example.com',extensionKey:'proof-key',logicalDatabase:'Cargo'});
  assert.equal(result.structuredContent.ok,true,JSON.stringify(result.structuredContent));
  assert.equal(result.structuredContent.result.result.mappingAbsentProven,false,JSON.stringify(result.structuredContent));
  assert.deepEqual(bridge.calls.find(c=>c[0]==='api').slice(1,5), ['integration-studio','TranslateLogicalDatabaseToDbConnection',{extensionKey:'proof-key',logicalDatabase:'Cargo'},false]);
  assert.ok(entries.get('o11_service_center_read').inputSchema.properties.extensionKey);
  assert.ok(entries.get('o11_service_center_read').inputSchema.properties.logicalDatabase);
});

test('Service Center tools answer in this process (no Python, no command line) and never echo the words', async () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'o11-operations.mjs'), 'utf8');
  assert.ok(!source.includes("run('o11', 'service-center'"));
  const dir = temp();
  const modules = [{ Key: 'k-orders', Name: 'Orders' }];
  const bridge = new FakeBridge({ api: { ListApplications: [], ListEspaces: () => [...modules], ListExtensions: [], GetConsumers: [],
    DeleteModule: () => { modules.splice(0, 1); return { success: true, message: null }; } } });
  const clock = fakeClock();
  const entries = registered({ serviceCenter: { journal: new Journal(dir), locate: () => bridge, present: async () => false, running: async () => false,
    opener: () => assert.fail('no prompt'), exports: dir, clock, backup: noBackup } });
  const capabilities = await entries.get('o11_service_center_read').handler({ action: 'capabilities' });
  assert.equal(capabilities.structuredContent.ok, true);
  assert.deepEqual(Object.keys(capabilities.structuredContent), ['ok', 'lane', 'verb', 'exitCode', 'result']);
  assert.equal(capabilities.structuredContent.result.session.length, 4);
  // CX15: the preview, then the token with the owner's words (with the count) after it.
  const preview = await entries.get('o11_service_center_write').handler({ action: 'module-delete', host: 'test.example.com', module: 'Orders' });
  assert.equal(preview.structuredContent.result.state, 'previewed');
  clock.advance(CONFIRM_MIN_AGE_MS);
  const words = 'delete the 1 module Orders on test';
  const deleted = await entries.get('o11_service_center_write').handler({ action: 'module-delete', host: 'test.example.com', words,
    confirmationToken: preview.structuredContent.result.confirmationToken, confirmHost: 'test.example.com' });
  assert.equal(deleted.structuredContent.result.state, 'confirmed');
  assert.ok(!deleted.content[0].text.includes(words));
  assert.ok(!/python|\.py\b|\.ps1/i.test(deleted.content[0].text));
  // A refusal is the same JSON shape, with its code and an MCP continuation (never a command line).
  const empty = registered({ serviceCenter: { journal: new Journal(dir), locate: () => null, present: async () => false, running: async () => true, exports: dir } });
  const refused = await empty.get('o11_service_center_read').handler({ action: 'license', host: 'test.example.com' });
  assert.equal(refused.isError, true);
  assert.deepEqual([refused.structuredContent.exitCode, refused.structuredContent.result.code, refused.structuredContent.result.continuation.tool], [1, 'STUDIO_NOT_CONNECTED', 'ssam_connect']);
  assert.deepEqual(refused.structuredContent.result.continuation.arguments, { lane: 'o11' });
});

test('read tool rejects mutations and argv injection never becomes execute', () => {
  assert.throws(() => serviceCenterArguments({ action: 'timer-run' }));
  assert.throws(() => serviceCenterArguments({ action: 'logs', execute: true }));
  assert.throws(() => serviceCenterArguments({ action: 'timer-run', execute: true }, true));
  const args = serviceCenterArguments({ action: 'timer-run', words: '--execute', name: '--execute' }, true);
  assert.ok(!args.includes('--execute'));
  assert.throws(() => serviceCenterArguments({ action: 'logs', password: 'secret' }));
  // Session actions are their own tool; the session tool takes no words, values or execution.
  assert.deepEqual(serviceCenterArguments({ action: 'web-sign-in', host: 'example.test' }, 'session'), ['session-web-sign-in', '--host=example.test']);
  for (const extra of [{ words: 'x' }, { execute: true }, { valueFile: 'C:\\v.txt' }]) assert.throws(() => serviceCenterArguments({ action: 'sign-in', ...extra }, 'session'));
  assert.throws(() => serviceCenterArguments({ action: 'module-delete' }, 'session'));
});

test('monitoring events are a typed MCP read and require explicit vault transport before resolving identity',async()=>{
 const entries=registered({serviceCenter:{locate:()=>assert.fail('No Studio lookup before transport validation')}});
 const read=entries.get('o11_service_center_read');
 assert.ok(read.inputSchema.properties.action.enum.includes('timer-events'));
 assert.deepEqual(read.inputSchema.properties.eventAuth.enum,['basic','service-token']);
 assert.ok(serviceCenterArguments({action:'timer-events',eventAuth:'service-token'}).includes('--event-auth=service-token'));
 assert.deepEqual(serviceCenterArguments({action:'timer-events',host:'test.example.com',session:'vault',since:'2026-10-09T16:00:00Z',until:'2026-10-09T16:10:00Z',limit:10}),
  ['timer-events','--host=test.example.com','--session=vault','--limit=10','--since=2026-10-09T16:00:00Z','--until=2026-10-09T16:10:00Z']);
 const r=await read.handler({action:'timer-events',host:'test.example.com'});
 assert.equal(r.isError,true);assert.match(JSON.stringify(r.structuredContent),/requires session=vault/);
});

test('new reads and writes map to typed flags; parameters are label=value text only', () => {
  assert.deepEqual(serviceCenterArguments({ action: 'logs', host: 'h.test', kind: 'error', stackContains: 'Pay', export: true, maxPages: 50 }),
    ['logs', '--host=h.test', '--kind=error', '--max-pages=50', '--stack-contains=Pay', '--export']);
  assert.deepEqual(serviceCenterArguments({ action: 'property-value', host: 'h.test', moduleId: '3', name: 'Url', reveal: true }),
    ['property-value', '--host=h.test', '--module-id=3', '--name=Url', '--reveal']);
  const create = serviceCenterArguments({ action: 'db-connection-create', host: 'h.test', connection: 'ERP', dbServer: 'sql', dbDatabase: 'erp',
    parameters: { Port: '1433' }, confirmHost: 'h.test' }, 'write');
  assert.deepEqual(create, ['db-connection-create', '--host=h.test', '--connection=ERP', '--db-server=sql', '--db-database=erp', '--confirm-host=h.test', '--param=Port=1433']);
  assert.throws(() => serviceCenterArguments({ action: 'db-connection-create', parameters: { 'a=b': 'c' } }, 'write'));
  assert.throws(() => serviceCenterArguments({ action: 'db-connection-create', parameters: { Port: 1433 } }, 'write'));
  assert.throws(() => serviceCenterArguments({ action: 'module-delete', reveal: true }, 'write'));
  assert.throws(() => serviceCenterArguments({ action: 'commits', confirmHost: 'h.test' }));
});

test('wave 2: schedule controls, log filters, page-layout and the Studio API writes map to typed flags', () => {
  assert.deepEqual(serviceCenterArguments({ action: 'timer-schedule', host: 'h.test', moduleId: '3', name: 'Q', schedule: { recurrence: 'Every N minutes', every: '15' } }, 'write'),
    ['timer-schedule', '--host=h.test', '--module-id=3', '--name=Q', '--schedule-recurrence=Every N minutes', '--schedule-every=15']);
  for (const schedule of [{ cron: '* * *' }, { every: 15 }]) assert.throws(() => serviceCenterArguments({ action: 'timer-schedule', schedule }, 'write'));
  assert.deepEqual(serviceCenterArguments({ action: 'logs', host: 'h.test', kind: 'integration', logType: 'REST (Consume)', logAction: 'Api', export: true }),
    ['logs', '--host=h.test', '--kind=integration', '--log-type=REST (Consume)', '--log-action=Api', '--export']);
  assert.deepEqual(serviceCenterArguments({ action: 'page-layout', host: 'h.test', path: 'Solutions_List.aspx' }), ['page-layout', '--host=h.test', '--path=Solutions_List.aspx']);
  assert.deepEqual(serviceCenterArguments({ action: 'module-move', host: 'h.test', module: 'M', toApplication: 'App B', moduleKind: 'eSpace' }, 'write'),
    ['module-move', '--host=h.test', '--module=M', '--to-application=App B', '--module-kind=eSpace']);
  assert.deepEqual(serviceCenterArguments({ action: 'extension-publish', host: 'h.test', xifFile: 'C:\\x\\E.xif', commitMessage: 'v4' }, 'write'),
    ['extension-publish', '--host=h.test', '--commit-message=v4', '--xif-file=C:\\x\\E.xif']);
  assert.deepEqual(serviceCenterArguments({ action: 'solution-add-component', host: 'h.test', solution: 'S', component: 'C', includeReferences: true }, 'write'),
    ['solution-add-component', '--host=h.test', '--solution=S', '--component=C', '--include-references']);
  // Writes and their arguments never reach the read tool.
  assert.deepEqual(serviceCenterArguments({action:'integration-detail',host:'h.test',moduleId:'7',integration:'Api',integrationKind:'exposed-rest'}),
    ['integration-detail','--host=h.test','--module-id=7','--integration=Api','--integration-kind=exposed-rest']);
  for (const extra of [{ xifFile: 'C:\\x.xif' }, { schedule: { at: '01:00' } }, { includeReferences: true }]) assert.throws(() => serviceCenterArguments({ action: 'logs', ...extra }));
  assert.throws(() => serviceCenterArguments({ action: 'page-layout' }, 'write'));
});

test('MCP schemas: session, read and write tools with their own arguments', () => {
  const entries = registered();
  const session = entries.get('o11_service_center_session');
  const read = entries.get('o11_service_center_read');
  const write = entries.get('o11_service_center_write');
  assert.deepEqual(session.inputSchema.properties.action.enum, ['status', 'sign-in', 'web-sign-in', 'close']);
  assert.deepEqual(session.inputSchema.properties.surface.enum, ['service-center', 'lifetime']);
  assert.equal(read.annotations.readOnlyHint, true);
  for (const tool of [read, session]) for (const forbidden of ['words', 'execute', 'valueFile', 'valueVault', 'confirmHost']) assert.ok(!tool.inputSchema.properties[forbidden], forbidden);
  // No default: an absent execute is not false (a delete with words executes; execute:false only plans).
  assert.equal(Object.hasOwn(write.inputSchema.properties.execute, 'default'), false);
  assert.equal(write.annotations.destructiveHint, true);
  assert.ok(write.inputSchema.properties.action.enum.includes('delete'));
  for (const list of ['applications', 'modules', 'extensions']) assert.deepEqual([write.inputSchema.properties[list].type, write.inputSchema.properties[list].maxItems], ['array', 100], list);
  assert.deepEqual(write.inputSchema.properties.prefixKind.enum, ['application', 'module', 'extension']);
  assert.deepEqual([write.inputSchema.properties.maxDeletes.minimum, write.inputSchema.properties.maxDeletes.maximum], [1, 100]);
  for (const key of ['applications', 'modules', 'extensions', 'prefix', 'prefixKind', 'maxDeletes']) assert.doesNotMatch(write.inputSchema.properties[key].description, /Alone:|Instead of job/, key);
  // CX15: the delete takes two calls (the preview, then confirmationToken and the owner's words).
  assert.match(write.description, /delete \{applications\|modules\|extensions\|prefix\}: two calls/);
  assert.match(write.description, /read ssam_task \{id:<operationId from the preview>\}/);
  for (const action of ['applications', 'application-dependencies', 'consumers', 'commits', 'developer-operations', 'license', 'databases',
    'solution-components', 'bpt-processes', 'bpt-activity', 'integrations', 'db-connections', 'solutions', 'property-value', 'page-layout'])
    assert.ok(read.inputSchema.properties.action.enum.includes(action), action);
  for (const action of ['timer-schedule', 'solution-create', 'solution-add-component', 'solution-remove-component', 'solution-publish',
    'module-delete', 'extension-delete', 'db-connection-create', 'db-connection-test', 'db-connection-delete', 'extension-db-connection',
    'integration-log-level', 'apply-settings', 'application-database-set', 'application-delete', 'module-move', 'module-add-to-application',
    'commit-message-set', 'extension-publish', 'verify'])
    assert.ok(write.inputSchema.properties.action.enum.includes(action), action);
  assert.deepEqual(Object.keys(write.inputSchema.properties.schedule.properties), ['recurrence', 'at', 'every', 'timeout']);
  assert.equal(write.inputSchema.properties.schedule.additionalProperties, false);
  assert.deepEqual(write.inputSchema.properties.moduleKind.enum, ['eSpace', 'Extension']);
  for (const key of ['logType', 'logAction', 'timer', 'path']) assert.ok(read.inputSchema.properties[key], key);
  for (const key of ['xifFile', 'commitMessage', 'version', 'toApplication', 'toApplicationKey', 'fromApplicationKey', 'includeReferences']) assert.ok(write.inputSchema.properties[key], key);
  assert.match(write.description, /secretRefs/);
  assert.match(write.description, /LAYOUT_UNKNOWN/);
  assert.match(read.description, /page-layout/);
  assert.ok(!read.inputSchema.properties.action.enum.some(a => write.inputSchema.properties.action.enum.includes(a)), 'no action in both tools');
  for (const tool of [session, read, write]) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    // CX15: confirmationToken is the token of a preview, never a credential.
    assert.ok(!Object.keys(tool.inputSchema.properties).some(k => k !== 'confirmationToken' && /password|secret|token|cookie/i.test(k)));
    assert.match(tool.description, /Studio/);
  }
  assert.match(read.description, /SSO/);
  assert.match(write.description, /never replayed/);
  assert.ok(entries.get('o11_dependencies').inputSchema.properties.action.enum.includes('capture'));
});

test('the Service Center tools are served on the ssam MCP and refuse bad writes before running anything', async () => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  // An executed Service Center write takes the Studio write lock: kept in a temporary folder, never the lane's .local.
  const locks = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'ssam-sc-locks-'));
  const server = await createSsamServer({ o11: false, odc: false, deps: { lock: { o11Root: locks, odcRoot: locks, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ssam-service-center-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['o11_service_center_session', 'o11_service_center_read', 'o11_service_center_write']) assert.ok(names.includes(name), name);
    const noWords = await client.callTool({ name: 'o11_service_center_write', arguments: { action: 'module-delete', host: 'h.test', module: 'Orders', execute: true, operationId: '0b3a3c1e-2d1c-4f7a-9c55-0a6f3b1d2e44' } });
    assert.equal(noWords.isError, true);
    assert.match(noWords.content[0].text, /authorization words/);
  } finally { await client.close(); await server.close(); }
});

test('delete: lists become repeated --target, execute:false is --plan-only, the operationId is optional, the other writes keep their rules', () => {
  assert.deepEqual(serviceCenterArguments({ action: 'delete', host: 'h.test', applications: ['App A', 'k-2'], modules: ['Orders'], extensions: ['UtilExt'], words: 'apagar' }, 'write'),
    ['delete', '--host=h.test', '--words=apagar', '--target=application:App A', '--target=application:k-2', '--target=module:Orders', '--target=extension:UtilExt']);
  assert.deepEqual(serviceCenterArguments({ action: 'delete', host: 'h.test', prefix: 'ZZ', prefixKind: 'application', maxDeletes: 40, words: 'apagar ZZ', execute: false }, 'write'),
    ['delete', '--host=h.test', '--words=apagar ZZ', '--prefix=ZZ', '--prefix-kind=application', '--max-deletes=40', '--plan-only']);
  assert.deepEqual(serviceCenterArguments({ action: 'module-delete', host: 'h.test', module: 'Orders', words: 'apagar Orders', execute: true }, 'write'),
    ['module-delete', '--host=h.test', '--module=Orders', '--words=apagar Orders', '--execute']);
  assert.throws(() => serviceCenterArguments({ action: 'delete', applications: ['A'], execute: true }, 'write'), /authorization words/);
  assert.throws(() => serviceCenterArguments({ action: 'delete', applications: [''] }, 'write'), /exact names/);
  assert.throws(() => serviceCenterArguments({ action: 'delete', applications: 'A' }, 'write'), /exact names/);
  assert.throws(() => serviceCenterArguments({ action: 'timer-run', applications: ['A'] }, 'write'), /apply to delete only/);
  assert.throws(() => serviceCenterArguments({ action: 'timer-run', words: 'x', execute: true }, 'write'), /operationId/);
  assert.throws(() => serviceCenterArguments({ action: 'applications', prefix: 'ZZ' }));
  assert.ok(!serviceCenterArguments({ action: 'timer-run', execute: false }, 'write').includes('--plan-only'));
});

test('through the MCP schema an input without execute reaches the handler without the field, and a delete executes with the token of its preview', async () => {
  const { McpServer, InMemoryTransport, fromJsonSchema } = await import('@modelcontextprotocol/server');
  const { Client } = await import('@modelcontextprotocol/client');
  const seen = [];
  const server = new McpServer({ name: 'sc-schema-test', version: '1.0.0' });
  registerO11Operations(server, fromJsonSchema, { tool: async argv => { seen.push(argv); return { ok: true, lane: 'o11', verb: 'service-center', exitCode: 0, result: { ok: true } }; } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'sc-schema-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    await client.callTool({ name: 'o11_service_center_write', arguments: { action: 'delete', host: 'h.test', applications: ['ZZA'], words: 'apagar ZZA' } });
    await client.callTool({ name: 'o11_service_center_write', arguments: { action: 'delete', host: 'h.test', applications: ['ZZA'], words: 'apagar ZZA', execute: false } });
    assert.deepEqual(seen, [['delete', '--host=h.test', '--words=apagar ZZA', '--target=application:ZZA'],
      ['delete', '--host=h.test', '--words=apagar ZZA', '--target=application:ZZA', '--plan-only']]);
  } finally { await client.close(); await server.close(); }

  // The real engine behind the same handler (CX15: two calls): the preview, then the token and words naming the application.
  const dir = temp(); const clock = fakeClock();
  const apps = [{ Key: 'app-z', Name: 'ZZA' }];
  const bridge = new FakeBridge({ api: { ListApplications: () => apps.map(a => ({ ...a })), ListEspaces: [], ListExtensions: [],
    DeleteApplication: args => (args.simulate ? { success: true, simulated: true, messages: [], affectedApplications: [], deletedModules: [] } : (apps.splice(0, 1), { success: true, simulated: false, messages: [] })) } });
  const entries = registered({ serviceCenter: { journal: new Journal(dir), locate: () => bridge, present: async () => false, running: async () => false, exports: dir,
    registry: path.join(import.meta.dirname, 'fixtures', 'sc-hosts.json'), sleep: async () => {}, clock, backup: noBackup } });
  const preview = await entries.get('o11_service_center_write').handler({ action: 'delete', host: 'personal-0000test.outsystemscloud.com', applications: ['ZZA'] });
  clock.advance(CONFIRM_MIN_AGE_MS);
  const deleted = await entries.get('o11_service_center_write').handler({ action: 'delete', host: 'personal-0000test.outsystemscloud.com',
    confirmationToken: preview.structuredContent.result.confirmationToken, words: 'pode apagar a 1, a ZZA' });
  assert.deepEqual([deleted.structuredContent.result.state, deleted.structuredContent.result.deleted.map(d => d.name)], ['confirmed', ['ZZA']]);
  assert.match(deleted.structuredContent.result.operationId, /^[0-9a-f-]{36}$/);
});

test('o11_data runs through the connected Studio session, never the vault path of the verb', () => {
  const argv = o11DataArguments({ host: 'h.test', module: 'Orders', oml: 'C:\\x\\Orders.oml' }, 'C:\\r.json', 'C:\\work');
  assert.equal(argv[0], '--studio');
  assert.ok(!argv.includes('--credentials'));
  assert.equal(argv[argv.indexOf('--oml') + 1], path.resolve('C:\\x\\Orders.oml'));
});
