// Fixtures of the o11env front: the kernel's answers per verb (shapes of Program.cs and the Anvil.Core records:
// records serialize PascalCase, anonymous objects camelCase), a temporary kernel root with the CLI files present,
// and an MCP client linked in memory to a server where one register function was called.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';

export const outOf = args => args[args.indexOf('--out') + 1];
const publish = (ok = true) => ({ Started: true, HasErrors: !ok, Completed: true, ESpaceId: 7, VersionId: 70, Key: 'pk',
  Messages: ok ? [] : [{ Id: 'e1', Type: 'Error', Message: 'Compilation failed\nstack', Detail: null }], StartMs: 10, TotalMs: 900 });
const validation = { Total: 0, ByType: {}, Sample: [] };

export const envelopes = {
  inventory: args => ({ ok: true, command: 'inventory', data: { host: 'personal-test.outsystemscloud.com', serverVersion: '11.38', ideVersion: '11.55',
    applications: [{ Name: 'Demo', Key: 'app-1' }, { Name: 'ZZScratch', Key: 'app-2' }],
    modules: [{ Name: 'Demo_CS', Key: 'mod-1', ApplicationName: 'Demo' }, { Name: 'ZZScratch_UI', Key: 'mod-2', ApplicationName: 'ZZScratch' }], catalogs: [] } }),
  download: args => ({ ok: true, command: 'download', data: { Name: 'Demo_CS', Key: 'mod-1', Kind: 'eSpace', VersionId: 42, Bytes: 1000,
    FilePath: path.join(outOf(args), 'Demo_CS.oml'), IsPublishedVersion: true, ElapsedMs: 5, Status: 'ok' } }),
  'download-app': args => ({ ok: true, command: 'download-app', data: { total: 2, ok: 1, bytes: 1000, elapsedMs: 9, results: [
    { Name: 'Demo_CS', Key: 'mod-1', Status: 'ok', FilePath: path.join(outOf(args), 'Demo', 'Demo_CS.oml') },
    { Name: 'Demo_Ext', Key: 'ext-1', Status: 'skipped: Extension', FilePath: null }] } }),
  templates: () => ({ ok: true, command: 'templates', data: [{ Key: 'tpl-1', Label: 'Reactive Web App', Description: null, IsMobile: false, ApplicationKind: 'CrossDevice' }] }),
  referenceable: () => ({ ok: true, command: 'referenceable', data: [
    { Key: 'ref-1', Name: 'Users', Kind: 'eSpace', SignatureHash: 'h1', IsSystem: true, ApplicationKey: null },
    { Key: 'ref-2', Name: 'OutSystemsUI', Kind: 'eSpace', SignatureHash: 'h2', IsSystem: false, ApplicationKey: 'a' }] }),
  references: () => ({ ok: true, command: 'references', data: [{ Name: 'OutSystemsUI', Key: 'ref-2', Kind: 'eSpace', ReferenceHash: 'h2', Elements: 12, ElementsByType: {} }] }),
  'create-app': () => ({ ok: true, command: 'create-app', data: { ApplicationName: 'Demo App', ApplicationKey: 'app-9', ApplicationOk: true,
    ApplicationMessage: null, ApplicationExisted: false, ApplicationKind: 'CrossDevice', TemplateKey: 'tpl-1',
    Modules: [{ Name: 'Demo_UI', Kind: 'CrossDevice', Key: 'mod-9', IsValid: true, Publish: publish(), Error: null, Succeeded: true }], Succeeded: true } }),
  'add-modules': () => ({ ok: true, command: 'add-modules', data: { application: { Name: 'Demo', Key: 'app-1' },
    modules: [{ Name: 'Demo_Lib', Kind: 'ReactiveLibrary', Key: 'mod-10', IsValid: true, Publish: publish(), Error: null, Skipped: false, Succeeded: true }], succeeded: true } }),
  'create-module': (args) => ({ ok: true, command: 'create-module', data: { ModuleName: 'Demo_UI2', ModuleKey: 'mod-11', TemplateKey: 'tpl-1',
    IsValid: true, Validation: validation, OmlPath: path.join(outOf(args), 'Demo_UI2.oml'), Publish: publish(), ServerModuleAfter: { Name: 'Demo_UI2', Key: 'mod-11' } } }),
  'update-app': () => ({ ok: true, command: 'update-app', data: { key: 'app-1', ok: true, message: null, after: { Name: 'Demo', Key: 'app-1' } } }),
  'refresh-refs': (args) => ({ ok: true, command: 'refresh-refs', data: { ModuleName: 'Demo_CS', ModuleKey: 'mod-1',
    Before: [{ Name: 'Users', Stale: true, InCatalog: true }, { Name: 'OutSystemsUI', Stale: false, InCatalog: true }], RefreshApplied: true, Changed: true,
    After: [{ Name: 'Users', Stale: false, InCatalog: true }, { Name: 'OutSystemsUI', Stale: false, InCatalog: true }],
    SavedOmlPath: path.join(outOf(args), 'Demo_CS.refreshed.oml'), Publish: args.includes('--publish') ? publish() : null } }),
  'set-user-provider': () => ({ ok: true, command: 'set-user-provider', data: { ModuleName: 'Demo_CS', ModuleKey: 'mod-1', IsValid: true, Validation: validation, Publish: publish() } }),
  'delete-app': () => ({ ok: true, command: 'delete-app', data: { application: { Name: 'ZZScratch', Key: 'app-2' }, Ok: true, Simulated: false,
    Messages: [], AffectedApplications: ['ZZScratch'], DeletedModules: ['ZZScratch_UI'] } }),
};
export const failedPublish = publish(false);

// A kernel root in the temp folder: the O11 and ODC CLI files exist (empty: the runner is always a fake), plus UI catalogs.
export function tempKernel({ cli = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'o11env-'));
  if (cli) {
    for (const file of [path.join(root, '.local', 'cli', 'anvil.dll'), path.join(root, '.local', 'lane-odc', 'cli', 'anvil-odc.dll')]) {
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '');
    }
  }
  const ui = path.join(root, 'catalog', 'ui'); fs.mkdirSync(ui, { recursive: true });
  for (const name of ['OutSystemsUI-2.9.0.json', 'OutSystemsUI-2.28.1.json', 'RichWidgets-unversioned.json']) fs.writeFileSync(path.join(ui, name), '{}');
  const home = path.join(root, 'home');
  const env = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ANVIL_AUTHORITY_DIR: path.join(home, 'authority'), ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  return { root, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// An MCP client talking to a server where `register(server, deps)` was called. call() returns the parsed answer.
export async function linked(register, deps) {
  const server = new McpServer({ name: 'o11env-test', version: '1.0.0' });
  register(server, deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'o11env-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const raw = (name, args) => client.callTool({ name, arguments: args }).catch(error => ({ isError: true, content: [{ type: 'text', text: error.message }] }));
  const call = async (name, args) => {
    const result = await raw(name, args);
    let value; try { value = JSON.parse(result.content[0].text); } catch { value = { sdkError: result.content[0].text }; }
    return { ...value, isError: result.isError === true };
  };
  return { client, call, raw, close: async () => { await client.close(); await server.close(); } };
}
