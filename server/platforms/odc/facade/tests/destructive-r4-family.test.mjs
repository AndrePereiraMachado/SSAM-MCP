import { isolatedProfile } from './fixtures/isolated-profile.mjs';
// CX15 r4, the family test (mandatory): every flow of W-1, W-2, W-4 and W-3 in ONE process with ONE synthetic marker in
// the owner's words, then one sweep: every MCP answer (text, structured, shaped and fitted with the default and a reduced
// budget), the isolated profile, the data roots, the answers folders, the destructive roots, the evidence of the fake pipe
// and the request files of the fake kernel. The marker must appear 0 times. Fakes only (no Studio, bridge, kernel or
// network), synthetic values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { OdcAccess } from '../../portal/runtime/access.mjs';
import { Catalog } from '../../portal/runtime/catalog.mjs';
import { WriteJournal, sha256 } from '../../portal/runtime/write-journal.mjs';
import { rawInput } from '../../portal/runtime/portal-routes.mjs';
import { guardedAccess } from '../../portal/runtime/destructive-preview.mjs';
import { consumerSetHash } from '../../portal/runtime/owned-consumer-deletion-approval.mjs';
import { registerAccessTools } from '../odc-access.mjs';
import { wrap, createFacadeServer } from '../mcp.mjs';
import { createSsamServer } from '../ssam.mjs';
import { root as facadeRoot } from '../lib.mjs';
import { odcDataWriter, o11DataWriter } from '../prototype-seed.mjs';
import { shapeToolResult } from '../responses.mjs';
import { fitResult, ANSWER_BUDGETS } from '../answer-size.mjs';
import { previewFile } from '../destructive-operations.mjs';
import { MARK, count, filesWithMark, filesUnder } from './fixtures/destructive-r4-marker.mjs';

process.env.SSAM_ODC_OFFLINE = '1';
const uuid = () => crypto.randomUUID();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const SMALL = { ...ANSWER_BUDGETS, other: 600, refusal: 600, receipt: 600, read: 600 };

test('CX15 r4 family: the owner\'s words never stay in clear (W-1, W-2, W-4, W-3 with one marker, one sweep)', async t => {
  const family = fs.mkdtempSync(path.join(os.tmpdir(), 'cx15r4-family-')); t.after(() => fs.rmSync(family, { recursive: true, force: true }));
  const sweep = [family, isolatedProfile, path.join(facadeRoot, 'journal', 'data')];
  const outputs = [];
  // The checks that each flow ran as it should: asserted AFTER the sweep, so the sweep always runs (also on an older tree).
  const flows = [], expect = (ok, message) => flows.push({ ok: Boolean(ok), message });
  const answers = path.join(family, 'answers-default'), small = path.join(family, 'answers-small');
  // Every MCP answer as the model and the hub's fitter see it.
  const seen = (tool, args, reply) => {
    outputs.push(JSON.stringify(reply));
    const shaped = shapeToolResult(tool, args, reply, { lane: 'odc' });
    outputs.push(JSON.stringify(fitResult(tool, args, shaped, { root: answers })), JSON.stringify(fitResult(tool, args, shaped, { root: small, budgets: SMALL })));
    return reply.structuredContent ?? JSON.parse(reply.content?.[0]?.text ?? 'null');
  };
  const connect = async server => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cx15r4-family', version: '1.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    t.after(async () => { await client.close(); await server.close(); });
    return async (tool, args) => seen(tool, args, await client.callTool({ name: tool, arguments: args }));
  };

  // ---- W-1: the read-only reconciliations of odc_a2a_connection_delete and of the custom search deletion.
  {
    const HOST = 'personal-zzr4fam.outsystems.dev';
    const studio = { running: async () => true, call: async args => args[0] === 'auth-status'
      ? { ok: true, bridge: 'v38', sessions: [{ host: HOST, loggedIn: true, user: 'dev@example.test' }], portalWindows: [], capabilities: ['portal-call'] } : { ok: false, error: 'Unknown command' } };
    let n = 0;
    const access = new OdcAccess({ catalog: new Catalog(), tenants: { default: HOST, tenants: { [HOST]: { class: 'personal' } } }, studio,
      vault: { apiClient: async () => ({ available: false }), portal: async () => ({ available: false }), bridge: async () => { throw new Error('no vault'); } },
      prompt: { apiClient: async () => ({ opened: true }), portal: async () => ({ opened: true }) },
      portalBroker: () => ({ available: false, authenticated: false, initialize: async () => {} }),
      receipts: new WriteJournal(path.join(family, 'w1', 'receipts')), sleep: async () => {}, requestFile: () => path.join(family, 'w1', 'req-' + (++n) + '.json') });
    const sends = [];
    access.resolvePortal = async () => ({ ok: true, path: 'vault', broker: { callScreenservice: async r => { sends.push(r.operationId); throw new Error('no send'); } } });
    const present = {};
    access.portalRead = async ({ operationId, input }) => {
      if (operationId === 'connections.detail') { const id = input?.connectionId ?? input?.screenVariables?.ConnectionId, c = present[id];
        return c ? { ok: true, data: { NotFound: false, Connection: { connectionId: id, name: c.name, providerId: c.providerId } } } : { ok: true, data: { NotFound: true, Connection: null } }; }
      if (operationId === 'connections.list') return { ok: true, truncated: false, rows: Object.entries(present).map(([id, c]) => ({ ConnectionId: id, Name: c.name })) };
      return { ok: false, error: { code: 'UNEXPECTED_READ' } };
    };
    const server = new McpServer({ name: 'cx15r4-family-w1', version: '1.0.0' });
    registerAccessTools(server, guardedAccess(access, { root: path.join(family, 'w1', 'destructive') }), wrap);
    const call = await connect(server);
    const WORDS = 'sim, pode apagar ZZOwnedAgent e ZZOwnedSearch ' + MARK;
    const connectionId = uuid(), originOperationUuid = uuid(), deleteId = uuid();
    const origin = access.receipts.reserve({ operationUuid: originOperationUuid, identity: { kind: 'odc-portal', tenant: HOST, operationId: 'connections.a2aTest', target: { connectionName: 'ZZOwnedAgent', step: 'test' } },
      wordsSha256: sha256('palavras sinteticas da criacao'), plan: {}, reconciliation: { a2aConnection: { name: 'ZZOwnedAgent' } } });
    access.receipts.settle(origin, { state: 'accepted', response: { Out_ConnectionId: connectionId } });
    const del = access.receipts.reserve({ operationUuid: deleteId, identity: { kind: 'odc-portal', tenant: HOST, operationId: 'connections.delete', target: { connectionId, connectionName: 'ZZOwnedAgent', originOperationUuid } },
      wordsSha256: sha256(WORDS), plan: {} });
    access.receipts.settle(del, { state: 'accepted' });
    present[connectionId] = { name: 'ZZOwnedAgent', providerId: 'a2a' };
    const a = await call('odc_a2a_connection_delete', { tenant: HOST, auth: 'auto', connectionId, originOperationUuid, operationUuid: deleteId, authorize: WORDS });
    expect(a.continuation?.tool === 'odc_a2a_connection_delete', 'W-1: the a2a reconciliation goes on');
    if (a.continuation) await call(a.continuation.tool, a.continuation.arguments);
    const searchId = uuid(), searchUuid = uuid(), input = { inputParameters: { ConnectionId: searchId, ProviderId: 'customAISearch', ConsoleProviderId: '' } };
    const s = access.receipts.reserve({ operationUuid: searchUuid, identity: { kind: 'odc-portal', tenant: HOST, operationId: 'connections.delete', target: { inputSha256: sha256(JSON.stringify(rawInput(input).inputParameters)) } },
      wordsSha256: sha256(WORDS), plan: {}, reconciliation: { customSearchDeletion: { connectionId: searchId, providerId: 'customAISearch', connectionName: 'ZZOwnedSearch' } } });
    access.receipts.settle(s, { state: 'accepted' });
    present[searchId] = { name: 'ZZOwnedSearch', providerId: 'customAISearch' };
    const b = await call('odc_portal_write', { tenant: HOST, auth: 'auto', operationId: 'connections.delete', input, operationUuid: searchUuid, authorize: WORDS });
    expect(b.continuation?.tool === 'odc_portal_write', 'W-1: the custom search reconciliation goes on');
    if (b.continuation) await call(b.continuation.tool, b.continuation.arguments);
    expect(sends.length === 0, 'W-1: no delete sent');
  }

  // ---- W-2: studio_data_insert, studio_data_update, studio_command through a fake pipe; the seed writers.
  const lines = [];
  const journal = path.join(family, 'w2', 'journal', 'data');
  const bridge = async args => {
    const line = args.map(String).join(' '); lines.push(line);
    const tokens = line.split(' ').filter(Boolean);
    const words = (() => { const i = tokens.indexOf('--authorize'); if (i < 0) return tokens.find(x => x.startsWith('--authorize='))?.slice(12) ?? null;
      const w = []; for (const x of tokens.slice(i + 1)) { if (x.startsWith('--')) break; w.push(x); } return w.join(' ') || null; })();
    if (tokens[0] === 'data') return { ok: true, records: [], count: 0 };
    const report = { ok: true, operation: tokens[0], authorization: words, count: 1, reports: [{ recordId: '1', status: 'Success' }] };
    fs.mkdirSync(journal, { recursive: true }); fs.writeFileSync(path.join(journal, lines.length + '-' + tokens[0] + '.json'), JSON.stringify(report));
    return report;
  };
  const requestsDir = path.join(facadeRoot, 'journal', 'data', 'requests');
  const before = new Set(fs.existsSync(requestsDir) ? fs.readdirSync(requestsDir) : []);
  t.after(() => { if (fs.existsSync(requestsDir)) for (const f of fs.readdirSync(requestsDir)) if (!before.has(f)) fs.rmSync(path.join(requestsDir, f), { force: true }); });
  {
    const call = await connect(await createFacadeServer({ deps: { studio: bridge, destructive: { root: path.join(family, 'w2', 'destructive') } } }));
    const words = 'pode gravar em SynthCustomer ' + MARK;
    await call('studio_data_insert', { module: 'SynthOrders', entity: 'SynthCustomer', records: [{ Name: 'Synth 3' }], authorize: words, pid: 999907 });
    await call('studio_data_update', { module: 'SynthOrders', entity: 'SynthCustomer', records: [{ Id: '1', Name: 'Synth 1b' }], authorize: words, pid: 999907 });
    await call('studio_command', { command: 'data-insert', args: ['SynthOrders', 'SynthCustomer', '--records-file', 'r.json', '--authorize', words], pid: 999907 });
    await call('studio_command', { command: 'data-update SynthOrders SynthCustomer --authorize ' + words, pid: 999907 });
    const odc = odcDataWriter({ studio: bridge, pid: 7, dir: path.join(family, 'w2', 'seed') });
    outputs.push(JSON.stringify(await odc({ module: 'Haiku', authorization: words, batch: [{ operation: 'insert', entity: 'E', records: [{ Id: 1 }] }] })));
    const work = path.join(family, 'w2', 'o11-work');
    const o11 = o11DataWriter({ host: 'o11.example.test', oml: path.join(family, 'm.oml'), work, runAnvil: async argv => {
      const request = JSON.parse(fs.readFileSync(argv[argv.indexOf('--request') + 1], 'utf8'));
      fs.writeFileSync(path.join(work, 'receipt.json'), JSON.stringify({ authorization: request.authorization }));
      return { envelope: { ok: true, data: { results: [{ ok: true, inserted: 1 }] } } };
    } });
    outputs.push(JSON.stringify(await o11({ module: 'Haiku_UI', authorization: words, batch: [{ operation: 'insert', entity: 'E', records: [{ Id: 1 }] }] })));
    expect(lines.filter(l => l.startsWith('data-')).length >= 5, 'W-2: the fake pipe got every write');
  }

  // ---- W-4: o11_data insert, update, batch and a read continuation, through the ssam server and a fake kernel.
  {
    const dataRoot = path.join(family, 'w4', 'data'), answersRoot = path.join(family, 'w4', 'answers'), lockRoot = path.join(family, 'w4', 'lock');
    for (const d of [dataRoot, answersRoot, lockRoot]) fs.mkdirSync(d, { recursive: true });
    const runAnvil = async argv => {
      const file = argv[argv.indexOf('--request') + 1], work = argv[argv.indexOf('--work') + 1];
      const body = JSON.parse(fs.readFileSync(file, 'utf8')), ops = Array.isArray(body.batch) ? body.batch : [body];
      fs.mkdirSync(path.join(work, 'receipts'), { recursive: true });
      fs.writeFileSync(path.join(work, 'receipts', uuid() + '.json'), JSON.stringify(ops.map(op => ({ authorization: op.authorization ?? body.authorization ?? null }))));
      return { ok: true, exitCode: 0, envelope: { ok: true, data: { ok: true, results: ops.map(op => (op.operation === 'read' ? { ok: true, continuation: { offset: 1 } } : { ok: true, inserted: 1 })) } } };
    };
    const call = await connect(await createSsamServer({ o11: true, odc: false, deps: { runAnvil, dataRoot, answersRoot, lock: { o11Root: lockRoot, odcRoot: lockRoot } } }));
    const words = 'pode gravar no ZZCliente ' + MARK, target = { host: 'zz-synthetic-o11.example.test', module: 'ZZShop', oml: 'C:/zz-synthetic/ZZShop.oml' };
    for (const request of [
      { operation: 'insert', entity: 'ZZCliente', operationId: uuid(), records: [{ Nome: 'a' }], authorization: words },
      { operation: 'update', entity: 'ZZCliente', operationId: uuid(), ids: ['7'], records: [{ Nome: 'b' }], authorization: words },
      { authorization: words, batch: [{ step: 'a', operation: 'insert', entity: 'ZZCliente', operationId: uuid(), records: [{ Nome: 'c' }] }, { step: 'b', operation: 'read', entity: 'ZZCliente', authorization: words }] },
      { operation: 'read', entity: 'ZZCliente', limit: 1, authorization: words },
    ]) await call('o11_data', { ...target, request });
  }

  // ---- W-3: odc_asset_delete of an own library and its own consumer, with an approval file that binds the reply by hash.
  {
    const { r3OdcWorld, HOST, LIB, files } = await import('./fixtures/r3-odc-world.mjs');
    const APP = '8b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c51', CONSUMERS = [{ key: APP, name: 'ZZScratchApp', type: 'App', revision: 3 }];
    const w = await r3OdcWorld({ extraAssets: { [APP]: { assetKey: APP, name: 'ZZScratchApp', revision: 3, assetType: 'App' } }, consumers: { [LIB]: CONSUMERS } });
    t.after(async () => { await w.close(); });
    sweep.push(w.dir);
    const source = { kind: 'human-conversation', threadId: uuid(), messageId: uuid(), question: 'Synthetic: create the fixtures?' };
    const origins = { [LIB]: uuid(), [APP]: uuid() };
    const receipts = Object.fromEntries(Object.entries(origins).map(([key, id]) => [id, { operationUuid: id, state: 'confirmed', status: 201,
      identity: { kind: 'odc-public', tenant: HOST, operationId: 'asset-repository-api-v1:post:/assets', target: {} }, response: { assetKey: key },
      authorization: { wordsSha256: sha('criacao sintetica'), proposalSha256: sha('x'), source } }]));
    const lookup = w.access.receipts.lookup.bind(w.access.receipts);
    w.access.receipts.lookup = (id, ...rest) => receipts[String(id).toLowerCase()] ?? lookup(id, ...rest);
    const preview = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB }); outputs.push(JSON.stringify(preview));
    w.wait();
    const reply = 'sim, pode apagar o 1: ZZScratchLib, mesmo quebrando a ZZScratchApp ' + MARK;
    const file = path.join(family, 'w3', 'cleanup.json'); fs.mkdirSync(path.dirname(file), { recursive: true });
    const proposal = previewFile(preview.previewId, { root: w.root });
    fs.writeFileSync(file, JSON.stringify({ schema: 'ssam-authorization-context/1', decision: 'approved', wordsSha256: sha(reply), source: { ...source, messageId: uuid() },
      proposal: { file: proposal, sha256: sha(fs.readFileSync(proposal)) }, scope: [{ lane: 'odc', host: HOST, operation: 'asset-repository-api-v1:delete:/assets/{assetKey}', targets: ['ZZScratchLib', 'ZZScratchApp'] }],
      constraints: { allowOwnedConsumerBreakage: true, producerAssetKey: LIB, consumerSetSha256: consumerSetHash(CONSUMERS), ownedAssetOrigins: origins } }));
    const done = await w.call('odc_asset_delete', { tenant: HOST, assetKey: LIB, confirmationToken: preview.confirmationToken, operationUuid: preview.operationId, authorize: reply, authorizationContext: file });
    outputs.push(JSON.stringify(done));
    expect(done.ok === true, 'W-3: the cleanup deletes: ' + JSON.stringify(done).slice(0, 300).split(MARK).join('<MARK>'));
    expect(files(w.dir).length > 0, 'W-3: the world wrote its records');
  }

  // ---- The sweep: the marker 0 times (and the sweep is not empty: the hashed words are where the words were).
  const marked = filesWithMark(sweep);
  t.diagnostic('cx15r4-family ' + JSON.stringify({ outputs: outputs.length, outputsWithMark: outputs.filter(o => count(o) > 0).length,
    pipeLines: lines.length, pipeLinesWithMark: lines.filter(l => count(l) > 0).length, filesSwept: sweep.flatMap(d => filesUnder(d)).length,
    filesWithMark: marked.map(f => path.relative(os.tmpdir(), f).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<uuid>')) }));
  assert.equal(outputs.length > 20, true);
  const hashedFiles = filesWithMark(sweep, 'sha256:').map(f => path.relative(family, f));
  for (const where of [path.join('w2', 'journal', 'data'), path.join('w2', 'o11-work'), path.join('w4', 'data')])
    expect(hashedFiles.some(f => f.startsWith(where)), 'the sweep sees the hashed words under ' + where);
  assert.deepEqual(outputs.map((o, i) => [i, count(o)]).filter(([, c]) => c > 0), [], 'every MCP answer and writer result');
  assert.deepEqual(lines.filter(l => count(l) > 0).map(l => l.replace(MARK, '<MARK>')), [], 'every line that crossed the fake pipe');
  assert.deepEqual(filesWithMark(sweep).map(f => path.relative(os.tmpdir(), f)), [], 'the isolated profile, the data, answers and destructive roots, the fake pipe evidence, the request files');
  assert.deepEqual(flows.filter(f => !f.ok).map(f => f.message), [], 'every flow ran as it should');
});
