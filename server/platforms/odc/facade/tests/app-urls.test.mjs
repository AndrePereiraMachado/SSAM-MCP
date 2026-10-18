import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { applicationUrls, resolveApplicationUrls, withAppLinks } from '../app-urls.mjs';
import { createSsamServer } from '../ssam.mjs';
import { tenants } from '../lib.mjs';

const environment = 'https://www.personal-nv0s5uly.outsystems.dev';
const app = 'SSAMDLV2CanaryODC1', screen = 'Stage1BindingProbe';
const config = { default: 'wrong.test', tenants: {
  'personal-nv0s5uly.outsystems.dev': { stages: { Development: { domain: 'www.personal-nv0s5uly.outsystems.dev' } } },
  'company.test': { stages: { Development: { domain: 'company-dev.test' }, Production: { domain: 'company.test' } } }
} };

test('home and screen links match the user supplied runtime route, without claiming publication', () => {
  const result = applicationUrls({ app, screen, environment });
  assert.equal(result.appUrl, environment + '/' + app + '/');
  assert.equal(result.homeUrl, result.appUrl);
  assert.equal(result.screenUrl, environment + '/' + app + '/' + screen);
  assert.equal(result.url, result.screenUrl);
  assert.equal(applicationUrls({ app, environment }).url, result.appUrl);
  assert.equal(result.publicationVerified, false);
  assert.equal(result.browserVerified, false);
  assert.equal(applicationUrls({ app, environment: 'https://custom.example:8443/' }).appUrl, 'https://custom.example:8443/' + app + '/');
  assert.equal(applicationUrls({ app: 'My App', screen: 'Edição #1', environment }).screenUrl, environment + '/My%20App/Edi%C3%A7%C3%A3o%20%231');
});

test('configured stages are exact; explicit runtime domains take precedence without inventing www', () => {
  assert.equal(applicationUrls({ app, host: 'https://personal-nv0s5uly.outsystems.dev/' }, config).environment, environment);
  assert.equal(applicationUrls({ app, host: 'company.test', stage: 'production' }, config).environment, 'https://company.test');
  assert.throws(() => applicationUrls({ app, host: 'company.test', stage: 'prod' }, config), /No runtime origin/);
  assert.throws(() => applicationUrls({ app, host: 'unknown.test' }, config), /Pass environment \(the runtime origin\)/);
  assert.equal(applicationUrls({ app, environment: 'https://explicit.test', host: 'company.test' }, config).environment, 'https://explicit.test');
});

test('invalid origins and route traversal cannot silently redirect to another path', () => {
  for (const value of ['https://user:secret@host.test', 'https://host.test/App', 'https://host.test/?x=1', 'https://host.test/#x', 'file:///tmp', 'javascript://alert'])
    assert.throws(() => applicationUrls({ app, environment: value }));
  for (const value of ['', ' ', '..', '.', '../Other', 'Screen/Sub', 'Screen\\Sub', ' App'])
    assert.throws(() => applicationUrls({ app, screen: value, environment }));
});

test('implicit environment follows the connected target and refuses ambiguous or disconnected sessions', async () => {
  let reads = 0;
  const deps = { config, status: async () => { reads++; return { ok: true, modules: [{ name: app, host: 'personal-nv0s5uly.outsystems.dev', loggedIn: true }], sessions: [{ host: 'company.test', loggedIn: true }] }; } };
  assert.equal((await resolveApplicationUrls({ app, screen }, deps)).screenUrl, environment + '/' + app + '/' + screen);
  assert.equal(reads, 1);
  await resolveApplicationUrls({ app, environment }, deps);
  assert.equal(reads, 1, 'explicit environment requires neither Studio nor authentication');
  for (const sessions of [[], [{ host: 'company.test', loggedIn: false }], [{ host: 'company.test', loggedIn: true }, { host: 'personal-nv0s5uly.outsystems.dev', loggedIn: true }]])
    await assert.rejects(resolveApplicationUrls({ app }, { config, status: async () => ({ ok: true, sessions }) }), /missing or ambiguous/);
});

test('reader and delivery presentation keep URLs without turning blocks into screens or changing outcome', () => {
  const value = { ok: false, writeState: 'uncertain', error: 'lost response' };
  const decorated = withAppLinks(value, { app, environment }, config, { entries: [
    { data: { tree: { kind: 'MobileScreen', name: screen, children: [{ kind: 'MobileBlock', name: 'NotARoute' }] } } }
  ] });
  assert.equal(decorated.ok, false);
  assert.equal(decorated.writeState, 'uncertain');
  assert.deepEqual(decorated.appLinks.screens, [{ screen, url: environment + '/' + app + '/' + screen }]);
  assert.equal(withAppLinks(value, { app, host: 'unknown.test' }, config).appLinks.available, false);
  assert.equal(withAppLinks(value, { app }, config).appLinks.available, false, 'never use config.default for an unrelated capture');
  // The capability that decorates other answers names the tool, never a CLI line.
  const unavailable = withAppLinks(value, { app }, config).appLinks;
  assert.equal(unavailable.tool, 'ssam_app_url'); assert.equal(unavailable.cli, undefined);
  assert.doesNotMatch(JSON.stringify(unavailable), /ssam app |--environment|--lane/);
});

test('root ssam and odc CLIs expose identical app/screen URLs from an explicit environment, outside repo cwd', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  for (const entry of ['ssam', 'odc']) {
    const args = [path.join(root, 'facade', entry + '.mjs'), 'app', app, screen, '--environment', environment, ...(entry === 'ssam' ? ['--lane', 'odc'] : [])];
    const result = await promisify(execFile)(process.execPath, args, { cwd: path.parse(root).root, windowsHide: true });
    assert.equal(JSON.parse(result.stdout).screenUrl, environment + '/' + app + '/' + screen);
    assert.equal(result.stderr, '');
  }
});

test('new LLM sessions discover the URL tool in instructions and call it through the SSAM MCP proxy', async () => {
  const server = await createSsamServer({ o11: false });
  const client = new Client({ name: 'ssam-app-url-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    assert.match(client.getInstructions(), /ssam_app_url/);
    const tool = (await client.listTools()).tools.find(t => t.name === 'ssam_app_url');
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, true);
    // tenant selects the exactly configured stage (platforms/odc/tenants.json: the Development runtime origin of the
    // configured default personal tenant), never the portal host with www.
    const tenant = tenants().default;
    const configured = 'https://' + tenants().tenants[tenant].stages.Development.domain;
    for (const [args, origin] of [[{ app, screen, environment }, environment], [{ app, screen, tenant }, configured]]) {
      const result = await client.callTool({ name: 'ssam_app_url', arguments: args });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.screenUrl, origin + '/' + app + '/' + screen);
    }
    const invalid = await client.callTool({ name: 'ssam_app_url', arguments: { app, environment: environment + '/Other' } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await server.close(); }
});
