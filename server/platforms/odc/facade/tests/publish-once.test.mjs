import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createO11Publish, publishSchema, registerO11Publish } from '../o11-publish.mjs';
import { o11Bridge } from '../o11-bridge.mjs';
import { withStudioWriteLock, studioWriteTarget } from '../studio-write-lock.mjs';
import { routeTools, compileToolRoutes, TOOLS_FILE } from '../tool-routing.mjs';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { fakeBridge } from './fixtures/fake-o11-bridge.mjs';

const HOST = 'dev.example.com';
const words = 'Atualize todas as referências e publique Consumer e seus consumidores';
const ok = data => ({ success: true, data, error: null });
const fail = error => ({ success: false, data: null, error });
const references = { kind: 'WebDialog', type: 'DialogWindow', source: 'window', contentKind: 'web', title: '', texts: [] };
const answered = { kind: 'DependenciesDialog', title: 'Incompatible or missing dependencies found', answer: 'Cancel' };

async function publisher(t, initial = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cx12-publish-once-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root');
  const env = { ...process.env, ANVIL_LANE: 'ss4' };
  const state = { active: 'Consumer', dialog: false, ...initial };
  const requests = [];
  const target = studioWriteTarget({ tool: 'o11_publish', deps: { o11Root: root, o11Lane: 'ss4' } });
  const fake = await fakeBridge(async request => {
    const p = request.params ?? {};
    const locks = fs.existsSync(target.dir) ? fs.readdirSync(target.dir).filter(n => n.endsWith('.lock')).map(n => JSON.parse(fs.readFileSync(path.join(target.dir, n), 'utf8'))) : [];
    requests.push({ ...request, locks });
    switch (request.method) {
      case 'bridge_manifest': return ok({ capabilities: ['dialogs:dependencies_auto', 'merge_from_oml:module_key', 'refresh_references'] });
      case 'open_module':
        if (state.crossEnvironment && p.environment !== HOST) return fail('multiple edited tabs named Consumer');
        if (state.dialog) return ok({ name: p.name, opened: false, blockedBy: [references] });
        state.active = p.name;
        return ok({ name: p.name, opened: true, alreadyOpen: true, selected: true, ...(state.outdated ? { referencesOutdated: true } : {}) });
      case 'answer_dependencies_dialog': { const seen = state.dialog ? [answered] : []; state.dialog = false; return ok({ answered: seen, count: seen.length }); }
      case 'list_open_modules': return ok({ modules: [
        ...(state.crossEnvironment ? [{ name: state.active, key: 'k-' + state.active, hasESpace: true, environment: 'personal.example.com', pendingDialogs: [] }] : []),
        { name: state.active, key: 'k-' + state.active, hasESpace: true, environment: HOST, pendingDialogs: [] }] });
      case 'get_active_module': return ok({ name: state.active, key: 'k-' + state.active, environment: state.crossEnvironment ? 'personal.example.com' : HOST, pendingDialogs: [] });
      case 'refresh_references':
        if (state.refreshError) return fail(state.refreshError);
        return ok({ module: state.active, changed: true, refreshed: ['Producer'], upToDate: ['Other'] });
      case 'get_errors': return ok({ isValid: true, errors: 0, warnings: 0, messages: [] });
      case 'publish': return ok({ module: state.active, published: true, state: 'CompletedWithSuccessNotOpenedInBrowser' });
      default: return fail('Unknown method: ' + request.method);
    }
  });
  t.after(() => fake.close());
  const run = createO11Publish({ root, env, lane: 'ss4', bridge: o11Bridge({ port: fake.port, authorization: 'K' }),
    assertSelected: async () => {}, tasksDir: path.join(dir, 'tasks'), journal: () => {}, inventory: () => null,
    consumersOf: async () => [{ name: 'Another' }], now: () => new Date('2026-10-13T12:00:00Z'), grants: { findGrant: () => null } });
  return { requests, target, sent: method => requests.filter(r => r.method === method),
    run: input => withStudioWriteLock({ tool: 'o11_publish', args: input, deps: { o11Root: root, o11Lane: 'ss4', env, queueMs: 0 } }, () => run(input)) };
}

const input = extra => ({ module: 'Consumer', authorize: words, ...extra });

test('publish-once: schema accepts an optional boolean refreshReferences', () => {
  assert.equal(publishSchema.parse(input({ refreshReferences: true })).refreshReferences, true);
  assert.equal(publishSchema.parse(input()).refreshReferences, undefined);
  assert.equal(publishSchema.safeParse(input({ refreshReferences: 'true' })).success, false);
});

test('publish-once: refreshes all references once before publishing once under the same write lock', async t => {
  const h = await publisher(t);
  const value = await h.run(input({ refreshReferences: true }));
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(h.requests.filter(r => ['refresh_references', 'publish'].includes(r.method)).map(r => r.method), ['refresh_references', 'publish']);
  assert.equal(h.sent('refresh_references')[0].params.producers, undefined);
  assert.deepEqual(value.referencesRefreshed, { refreshed: ['Producer'], upToDate: ['Other'] });
  const locks = h.requests.filter(r => ['refresh_references', 'publish'].includes(r.method)).map(r => r.locks);
  for (const records of locks) assert.ok(records.some(r => r.tool === 'o11_publish' && r.pid === process.pid));
  assert.equal(locks[0].find(r => r.tool === 'o11_publish').startedAt, locks[1].find(r => r.tool === 'o11_publish').startedAt);
  assert.deepEqual(fs.readdirSync(h.target.dir).filter(n => n.endsWith('.lock')), []);
});

test('publish-once: failed refresh refuses with a continuation and never publishes', async t => {
  const h = await publisher(t, { refreshError: 'Refresh failed' });
  const value = await h.run(input({ refreshReferences: true }));
  assert.equal(value.ok, false); assert.ok(value.code); assert.ok(value.continuation?.tool);
  assert.match(value.error, /nothing was published/i);
  assert.equal(h.sent('refresh_references').length, 1); assert.equal(h.sent('publish').length, 0);
});

test('publish and refresh keep the requested environment when another window has the same module name and key', async t => {
  const h = await publisher(t, { crossEnvironment: true });
  const result = await h.run(input({ refreshReferences: true, expectedEnvironment: HOST }));
  assert.equal(result.result, 'published', JSON.stringify(result));
  for (const method of ['open_module', 'refresh_references', 'publish']) {
    assert.ok(h.sent(method).length > 0);
    for (const request of h.sent(method)) assert.equal(request.params.environment, HOST, method);
  }
});

test('publish-once: an older bridge refuses BRIDGE_OUTDATED without publishing', async t => {
  const h = await publisher(t, { refreshError: 'Unknown method: refresh_references' });
  const value = await h.run(input({ refreshReferences: true }));
  assert.equal(value.code, 'BRIDGE_OUTDATED'); assert.equal(value.continuation.tool, 'ssam_doctor');
  assert.equal(h.sent('publish').length, 0);
});

test('publish-once: the open MB2 refresh is reused instead of refreshing twice', async t => {
  const h = await publisher(t, { dialog: true });
  const value = await h.run(input({ refreshReferences: true }));
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(h.sent('answer_dependencies_dialog').length, 1);
  assert.equal(h.sent('refresh_references').length, 1); assert.equal(h.sent('publish').length, 1);
  assert.equal(value.dependenciesDialog.answered[0].answer, 'Cancel');
  assert.deepEqual(value.referencesRefreshed.refreshed, ['Producer']);
});

for (const flag of [undefined, false]) test(`publish-once: refreshReferences=${flag} keeps ordinary publication unchanged`, async t => {
  const h = await publisher(t);
  const value = await h.run(input(flag === undefined ? {} : { refreshReferences: flag }));
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(h.sent('refresh_references').length, 0); assert.equal(h.sent('publish').length, 1);
  assert.equal(value.referencesRefreshed, undefined);
});

test('publish-once: outdated references still refresh without the new flag', async t => {
  const h = await publisher(t, { outdated: true });
  const value = await h.run(input());
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(h.sent('refresh_references').length, 1); assert.equal(h.sent('publish').length, 1);
});

test('publish-once: consumers:true still refreshes and publishes consumers after the producer', async t => {
  const h = await publisher(t);
  const value = await h.run(input({ refreshReferences: true, consumers: true }));
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.consumers, [{ module: 'Another', outcome: 'published' }]);
  assert.deepEqual(h.requests.filter(r => ['refresh_references', 'publish'].includes(r.method)).map(r => r.method), ['refresh_references', 'publish', 'refresh_references', 'publish']);
  assert.equal(h.sent('refresh_references')[0].params.producers, undefined);
  assert.deepEqual(h.sent('refresh_references')[1].params.producers, ['Consumer']);
});

const intents = ['refresh de todas as dependências e publique', 'atualize todas as referências do módulo InsuranceApp e publique', 'refresh all dependencies and publish'];
for (const intent of intents) test(`publish-once: discover combines ${intent}`, () => {
  const result = routeTools({ lane: 'o11', intent });
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].tool, 'o11_publish');
  assert.equal(result.tools[0].args.refreshReferences, true);
  assert.equal(result.tools.filter(r => r.tool === 'o11_publish' || (r.tool === 'o11_environment' && r.verb === 'refresh-refs')).length, 1);
});

test('publish-once: a plain publish route never enables refreshReferences', () => {
  const result = routeTools({ lane: 'o11', intent: 'publique o módulo' });
  assert.equal(result.tools[0].tool, 'o11_publish'); assert.equal(result.tools[0].args.refreshReferences, undefined);
});

test('route coverage is generic metadata, including an operation of another tool', () => {
  const data = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'));
  data.tools.o11_publish.verbs['refresh-publish'].triggers = [];
  data.tools.o11_publish.verbs['refresh-publish'].intents = {};
  data.tools.o11_environment.verbs['refresh-refs'].covers = ['o11_publish.publish'];
  const result = routeTools({ lane: 'o11', intent: 'refresh all dependencies and publish' }, compileToolRoutes(data));
  assert.equal(result.tools[0].tool, 'o11_environment');
  assert.ok(result.tools.every(r => r.tool !== 'o11_publish'));
});

// The legacy route registry test stops at pre-existing enum problems before these checks; prove the publish contract here.
test('publish-once: presence modes match UNMARKED, live fields and the description, independently of enum checks', async t => {
  const server = new McpServer({ name: 'publish-presence-contract', version: '1' });
  registerO11Publish(server, { registerGrant: false });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'publish-presence-client', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await Promise.all([server.connect(a), client.connect(b)]);
  const live = (await client.listTools()).tools.find(t => t.name === 'o11_publish');
  const entry = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8')).tools.o11_publish;
  const legacyTest = fs.readFileSync(new URL('./tool-routes.test.mjs', import.meta.url), 'utf8');
  const unmarked = [...legacyTest.match(/o11_publish: \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const marked = Object.entries(live.inputSchema.properties).filter(([, p]) => /\b(Alone:|Instead of job\b)/.test(p.description ?? '')).map(([name]) => name);
  const routes = Object.values(entry.verbs).filter(v => v.selector === 'presence');
  const fields = [...new Set(routes.map(v => v.field))].sort();
  assert.deepEqual(fields, [...new Set([...unmarked, ...marked])].sort());
  for (const field of fields) {
    assert.ok(live.inputSchema.properties[field], `${field} is live`);
    assert.match(live.description, new RegExp(`\\b${field}\\b`), `${field} is described`);
    assert.ok(routes.some(v => v.field === field && v.value !== '<absent>'), `${field} present mode is routed`);
  }
  assert.ok(routes.some(v => v.field === 'consumers' && v.value === '<absent>'));
  const route = entry.verbs['refresh-publish'];
  assert.equal(route.field, 'refreshReferences'); assert.equal(route.value, 'true');
  for (const key of Object.keys(route.args)) assert.ok(live.inputSchema.properties[key], `${key} template field is live`);
  assert.equal(publishSchema.safeParse(route.args).success, true, 'the complete new template fits the strict schema');
  assert.equal(route.args.refreshReferences, true, 'the template selects the present boolean mode');
});

test('publish-once: combined curated intents belong to the compound operation alone', () => {
  const data = JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8'));
  for (const [lang, intent] of [['pt', 'atualizar referências e publicar'], ['en', 'refresh references and publish']]) {
    assert.ok(data.tools.o11_publish.verbs['refresh-publish'].intents[lang].includes(intent));
    assert.ok(!data.tools.o11_environment.verbs['refresh-refs'].intents[lang].includes(intent));
    const routes = routeTools({ lane: 'o11', intent }).tools;
    assert.equal(routes.length, 1); assert.equal(routes[0].args.refreshReferences, true);
  }
});

test('publish-once: all five refresh-only corpus intents keep their environment refresh route', () => {
  const items = ['discover-tool-eval.json', 'discover-tool-heldout.json', 'discover-tool-verifier.json'].flatMap(file =>
    JSON.parse(fs.readFileSync(new URL('./fixtures/' + file, import.meta.url), 'utf8')).items.filter(item =>
      item.expect?.tool === 'o11_environment' && item.expect?.verb?.value === 'refresh-refs'));
  assert.equal(items.length, 5);
  for (const item of items) {
    const routes = routeTools({ lane: item.lane, intent: item.intent }).tools;
    assert.equal(routes[0].tool, 'o11_environment', item.intent);
    assert.equal(routes[0].verb, 'refresh-refs', item.intent);
  }
});
