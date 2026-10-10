// o11_deliver with the integration ops (lane restsoap): a delete of an integration element, a `breaks` list or a change of
// an exposed method's contract needs the user's own words naming each target, checked before the CLI runs (a fake
// runner counts the calls); a standing grant alone never covers a delete; a target is Type:Name, never an alias.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { registerO11Cycle } from '../o11-cycle.mjs';
import { prepareIntegrationJob, destructiveProblems } from '../integration-documents.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import envelopes from './fixtures/o11-cycle-envelopes.json' with { type: 'json' };

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'o11-integration-delete-'));
  const root = path.join(base, 'anvil'), home = path.join(base, 'home'), auth = path.join(base, 'authority');
  for (const dir of [root, home, auth]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(auth, 'bridge.key'), 'TESTKEY');
  const env = { USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    ANVIL_AUTHORITY_DIR: auth, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1', ANVIL_LANE: 'ss4' };
  fs.mkdirSync(path.join(root, '.local', 'connections'), { recursive: true });
  fs.writeFileSync(path.join(root, '.local', 'connections', 'ss4.json'), JSON.stringify({ ok: true, lane: 'o11', anvilLane: 'ss4', pid: 4242,
    startedUtc: '2026-10-02T00:00:00Z', studioDir: path.join(base, 'Studio'), authorityDir: auth, port: 45999 }));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const job = ops => { const file = path.join(base, 'jobs', Math.random().toString(16).slice(2) + '.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ ops })); return file; };
  return { base, root, env, job };
}

async function serve(t, box, deps = {}) {
  const runAnvil = fakeAnvil({ deliver: () => envelopes.delivered });
  const server = new McpServer({ name: 'o11-integration-delete', version: '1.0.0' });
  registerO11Cycle(server, { root: box.root, env: box.env, lane: 'ss4', runAnvil, assertSelected: async () => {}, lastPublication: async () => null, ...deps });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'o11-integration-delete-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  return { runAnvil, call: (name, args) => client.callTool({ name, arguments: args }) };
}

const removeMethod = [{ op: 'rest', data: { client: { name: 'ViaCepApi' }, remove: ['IRestAction:GetAddressByCep'] } }];

test('words that do not name the removed method are INTEGRATION_DELETE_WORDS before the CLI runs', async t => {
  const box = sandbox(t);
  const { runAnvil, call } = await serve(t, box);
  const refused = await call('o11_deliver', { module: 'Orders', job: box.job(removeMethod), authorize: 'pode entregar a integracao do ViaCep' });
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent.code, 'INTEGRATION_DELETE_WORDS');
  assert.equal(refused.structuredContent.stage, 'documents');
  assert.match(refused.structuredContent.problems[0].message, /IRestAction:GetAddressByCep/);
  assert.equal(runAnvil.calls.length, 0);
  // Words naming it (whole word): the delivery runs.
  const delivered = await call('o11_deliver', { module: 'Orders', job: box.job(removeMethod), authorize: 'sim, apague o GetAddressByCep do ViaCepApi' });
  assert.equal(delivered.isError, undefined, JSON.stringify(delivered.structuredContent));
  assert.equal(runAnvil.calls.length, 1);
  // A longer name does not name it: "GetAddressByCep2" is another word.
  const other = await call('o11_deliver', { module: 'Orders', job: box.job(removeMethod), authorize: 'apague o GetAddressByCep2' });
  assert.equal(other.structuredContent.code, 'INTEGRATION_DELETE_WORDS');
  assert.equal(runAnvil.calls.length, 1);
});

test('a standing grant alone never covers a delete', async t => {
  const box = sandbox(t);
  const grant = { grantId: 'g-1', words: 'entregue tudo no Orders, inclusive apagar GetAddressByCep', lane: 'o11', module: 'Orders', verbs: ['deliver'] };
  const { runAnvil, call } = await serve(t, box, { grants: { findGrant: () => grant } });
  const refused = await call('o11_deliver', { module: 'Orders', job: box.job(removeMethod) });
  assert.equal(refused.structuredContent.code, 'INTEGRATION_DELETE_WORDS');
  assert.match(refused.structuredContent.problems[0].message, /standing grant never covers a delete/);
  assert.equal(runAnvil.calls.length, 0);
  // The same grant still covers a job without a delete.
  const plain = await call('o11_deliver', { module: 'Orders', job: box.job([{ op: 'rest', data: { client: { name: 'ViaCepApi', description: 'x' } } }]) });
  assert.equal(plain.isError, undefined, JSON.stringify(plain.structuredContent));
  assert.equal(runAnvil.calls.length, 1);
});

test('breaks not named, an alias target and a raw delete of an integration element', async t => {
  const box = sandbox(t);
  const { runAnvil, call } = await serve(t, box);
  const breaks = [{ op: 'rest', data: { client: { name: 'ViaCepApi' }, remove: ['GetAddressByCep'], breaks: ['IServerAction:Cep_Lookup/IExecuteServerActionNode:GetAddressByCep'] } }];
  const unnamed = await call('o11_deliver', { module: 'Orders', job: box.job(breaks), authorize: 'apague o GetAddressByCep' });
  assert.equal(unnamed.structuredContent.code, 'DELETE_BREAKS_WORDS');
  assert.match(unnamed.structuredContent.problems[0].message, /Cep_Lookup/);
  const alias = [{ op: 'create', parent: '@espace', type: 'IRestClient', name: 'Tmp', as: '$c' }, { op: 'delete', target: '$c' }];
  const form = await call('o11_deliver', { module: 'Orders', job: box.job(alias), authorize: 'apague o Tmp' });
  assert.equal(form.structuredContent.code, 'INTEGRATION_DELETE_TARGET_FORM');
  const raw = await call('o11_deliver', { module: 'Orders', job: box.job([{ op: 'delete', target: 'ISOAPAction:Subtract' }]), authorize: 'pode entregar' });
  assert.equal(raw.structuredContent.code, 'INTEGRATION_DELETE_WORDS');
  assert.equal(runAnvil.calls.length, 0);
  const named = await call('o11_deliver', { module: 'Orders', job: box.job(breaks), authorize: 'apague o GetAddressByCep mesmo quebrando o Cep_Lookup' });
  assert.equal(named.isError, undefined, JSON.stringify(named.structuredContent));
  assert.equal(runAnvil.calls.length, 1);
});

test('changing the path of an existing exposed method needs words naming it', async t => {
  const box = sandbox(t);
  const exposedMethods = async service => (service === 'CepService' ? [{ name: 'GetCep', http: 'GET', path: '/GetCep/{Cep}' }] : []);
  const { runAnvil, call } = await serve(t, box, { exposedMethods });
  const moved = [{ op: 'rest-expose', data: { service: { name: 'CepService' }, methods: [{ name: 'GetCep', http: 'GET', path: '/cep/{Cep}', inputs: [{ name: 'Cep', type: 'Text' }], steps: [] }] } }];
  const refused = await call('o11_deliver', { module: 'Orders', job: box.job(moved), authorize: 'pode entregar o servico' });
  assert.equal(refused.structuredContent.code, 'REST_EXPOSE_CONTRACT_WORDS');
  assert.match(refused.structuredContent.problems[0].message, /GET \/GetCep\/\{Cep\}/);
  assert.equal(runAnvil.calls.length, 0);
  // The same verb and path (another placeholder name): not a contract change.
  const same = [{ op: 'rest-expose', data: { service: { name: 'CepService' }, methods: [{ name: 'GetCep', http: 'GET', path: '/GetCep/{Code}', inputs: [{ name: 'Code', type: 'Text' }], steps: [] }] } }];
  const kept = await call('o11_deliver', { module: 'Orders', job: box.job(same), authorize: 'pode entregar o servico' });
  assert.equal(kept.isError, undefined, JSON.stringify(kept.structuredContent));
  const named = await call('o11_deliver', { module: 'Orders', job: box.job(moved), authorize: 'pode mudar o caminho do GetCep' });
  assert.equal(named.isError, undefined, JSON.stringify(named.structuredContent));
  assert.equal(runAnvil.calls.length, 2);
});

test('the rule is pure: every problem of a job at once', async () => {
  const ops = [
    { op: 'soap', data: { wsdl: 'x', methods: ['Add'], remove: ['Subtract', '@abc'] } },
    { op: 'delete', target: 'IRestClient:Old/GetX' },
    { op: 'rest', data: { client: { name: 'A' }, breaks: ['IServerAction:Caller/IExecuteServerActionNode:X'] } },
  ];
  const { problems, targets } = await destructiveProblems(ops, { words: 'nada' });
  assert.deepEqual(problems.map(p => p.code).sort(), ['DELETE_BREAKS_WORDS', 'INTEGRATION_DELETE_TARGET_FORM', 'INTEGRATION_DELETE_TARGET_FORM', 'INTEGRATION_DELETE_WORDS']);
  assert.deepEqual(targets, ['ISOAPAction:Subtract']);
  assert.equal((await prepareIntegrationJob(path.join(os.tmpdir(), 'missing-' + Date.now() + '.json'))).ok, true, 'an unreadable job is the kernel\'s to judge');
});
