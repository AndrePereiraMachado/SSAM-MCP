// servidor/fase4-26 a7, review C:\t\revisoes\vps-a7\REVISAO.md M1 and B2 (one family): the ODC handlers of mcp.mjs that
// take a DATA root (studio_reference_snapshot: the producer cache, the capture folder, lab and root; studio_publish: lab, root
// and the publication ledger) use, hosted, the customer's <ws>/odc (lib.mjs dataPath), never the code root of the server,
// which every customer shares. Locally nothing changes (dataPath is the lane root). Two synthetic customers in the same
// tenant, fake executors and a fake bridge: no Studio, no socket, no process.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const net = require('node:net');
cp.execFile = function execFile(file, args, options, callback) {
  if (typeof args === 'function') { callback = args; args = []; options = {}; }
  if (typeof options === 'function') { callback = options; options = {}; }
  const child = new EventEmitter(); child.stdin = { end() {} }; child.unref = () => {}; child.kill = () => {}; child.pid = 0;
  setImmediate(() => callback?.(new Error('no child process in hosted tests'), '', ''));
  return child;
};
cp.execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) =>
  cp.execFile(file, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))));
cp.spawn = () => { throw new Error('spawn is not allowed in hosted tests'); };
net.createConnection = () => { throw new Error('no TCP or pipe connection in hosted tests'); };
syncBuiltinESMExports();

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace } = await import('../executor.mjs');
const { o11Lane } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const { createFacadeServer } = await import('../mcp.mjs');
const { root: odcCodeRoot } = await import('../lib.mjs');

const TENANT = 'zz-tenant.example';
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const sha = buf => createHash('sha256').update(buf).digest('hex');
const sharedCache = path.join(odcCodeRoot, '.local', 'producer-cache');
const listShared = () => { const out = []; const walk = d => { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else out.push(p); } }; walk(sharedCache); return out; };
const listUnder = dir => { const out = []; const walk = d => { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else out.push(p); } }; walk(dir); return out; };

// The customer's ODC Studio: two modules open (the consumer and the library), a reference snapshot that writes the
// customer's own signature (or answers the bridge's "no supported public elements").
class FakeOdcExecutor {
  constructor(tag, { noPublic = false } = {}) { this.id = 'fake-' + randomUUID(); this.hosted = true; this.calls = []; this.tag = tag; this.noPublic = noPublic; }
  relayPort() { return null; }
  o11Connection() { return null; }
  async close() {}
  async call(kind, params = {}) {
    this.calls.push({ kind, args: params.args });
    if (kind === 'studio.processes') return { processes: [{ pid: 4242, window: true }] };
    if (kind === 'odc.pipe') {
      const [command, request] = params.args ?? [];
      if (command === 'status') return { line: JSON.stringify({ ok: true, pid: 4242, modules: [{ name: 'ZZConsumer', key: 'k-consumer', host: TENANT }, { name: 'ZZLib', key: 'k-zzlib', host: TENANT }] }) };
      if (command === 'reference-snapshot') {
        if (this.noPublic) return { line: JSON.stringify({ ok: false, error: 'Producer has no supported public elements: ZZLib' }) };
        const { output } = JSON.parse(request);
        const bytes = Buffer.from(JSON.stringify({ FormatVersion: 1, Environment: TENANT, ModuleKey: 'k-zzlib', Name: 'ZZLib', SignatureHash: 'h', Revision: '3', Elements: ['SECRET-OF-' + this.tag] }));
        fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, bytes);
        return { line: JSON.stringify({ ok: true, path: output, sha256: sha(bytes), environment: TENANT, producer: 'ZZLib', producerKey: 'k-zzlib', revision: '3' }) };
      }
      return { line: JSON.stringify({ ok: false, error: 'unexpected ' + command }) };
    }
    throw Object.assign(new Error('unexpected kind ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false });
  }
}
const agent = { connected: () => true, protocolError() {},
  info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', kernel: { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' },
    compatible: { odc: { ok: true }, o11: { ok: true } } }) };
function hosted(tag, options) {
  const tokenId = 'tok_' + randomUUID().slice(0, 12);
  const workspace = path.join(temp('ssam-a7-data-'), 'customers', tokenId);
  prepareWorkspace(workspace);
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Customer ' + tag, lanes: ['odc'], workspace, agent, executor: new FakeOdcExecutor(tag, options), o11: { lane: o11Lane.lane }, close: async () => {} };
}
const connect = async server => {
  const [s, c] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hosted-odc-data-root', version: '1' });
  await Promise.all([server.connect(s), client.connect(c)]);
  return { call: async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); },
    close: async () => { await client.close(); await server.close(); } };
};
const hostedServer = context => runWithExecutor(context, () => createSsamServer({ o11: false, odc: true, hosted: { context, session: { agent, lanes: context.lanes } } })).then(connect);
// The ODC facade of one hosted call (createFacadeServer keeps the context of its creation for every handler), with test deps.
const hostedFacade = (context, deps) => runWithExecutor(context, () => createFacadeServer({ deps })).then(connect);
// A clean SSAM merge of ZZLib in a lab folder (the evidence studio_publish {module} and the publication precheck read).
function cleanMerge(lab, sha256) {
  const dir = path.join(lab, '01-zzlib'), evidence = path.join(dir, 'delivery', 'evidence');
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(dir, 'delivery', 'manifest.json'), JSON.stringify({ module: 'ZZLib', moduleKey: 'k-zzlib', tenant: TENANT, feature: 'F', owners: ['A'], changes: ['C'] }));
  fs.writeFileSync(path.join(evidence, 'merge-started.json'), JSON.stringify({ at: '2026-10-17T20:00:00Z', pid: 4242 }));
  fs.writeFileSync(path.join(evidence, 'receipt.json'), JSON.stringify({ ok: true, merged: true, strictlyEqual: true, sha256 }));
  return path.join(dir, 'delivery', 'manifest.json');
}

test('M1: two customers of one tenant capture the same producer: each record and signature stays in its own <ws>/odc, nothing in the code root', async () => {
  const before = new Set(listShared());
  const a = hosted('A'), b = hosted('B');
  const ra = await hostedServer(a), rb = await hostedServer(b);
  try {
    const answerA = await ra.call('studio_reference_snapshot', { module: 'ZZConsumer', producer: 'ZZLib', output: 'ws:odc/snapshots/zzlib.avsig' });
    const answerB = await rb.call('studio_reference_snapshot', { module: 'ZZConsumer', producer: 'ZZLib', output: 'ws:odc/snapshots/zzlib.avsig' });
    assert.equal(answerA.ok, true, JSON.stringify(answerA).slice(0, 400));
    assert.equal(answerB.ok, true, JSON.stringify(answerB).slice(0, 400));
    assert.deepEqual(listShared().filter(f => !before.has(f)), [], 'nothing new in the producer cache of the code root');
    for (const [context, own, other] of [[a, 'A', 'B'], [b, 'B', 'A']]) {
      const records = listUnder(path.join(context.workspace, 'odc', '.local', 'producer-cache', 'odc'));
      assert.ok(records.some(f => f.endsWith('.avsig')) && records.some(f => f.endsWith('.json')), own + ': its record in its own workspace: ' + records.join(', '));
      const text = records.filter(f => f.endsWith('.avsig')).map(f => fs.readFileSync(f, 'utf8')).join('\n');
      assert.match(text, new RegExp('SECRET-OF-' + own));
      assert.doesNotMatch(text, new RegExp('SECRET-OF-' + other), own + ' never holds the other customer\'s signature');
    }
  } finally { await ra.close(); await rb.close(); }
});

test('M1: hosted, PRODUCER_NOT_PUBLISHED finds the customer\'s own clean merge in <ws>/odc/lab and proposes studio_publish; another customer gets the person\'s step', async () => {
  const openSha = 'a'.repeat(64);
  const model = async () => ({ ok: true, source: 'open-model', host: TENANT, file: 'ws:odc/snapshots/ZZLib.oml', sha256: openSha,
    surface: [{ kind: 'ServerAction', name: 'ZZAction', key: 'kZZAction', public: true }] });
  const a = hosted('A', { noPublic: true }), b = hosted('B', { noPublic: true });
  cleanMerge(path.join(a.workspace, 'odc', 'lab'), openSha);
  const fa = await hostedFacade(a, { producerModel: model }), fb = await hostedFacade(b, { producerModel: model });
  try {
    const answerA = await fa.call('studio_reference_snapshot', { module: 'ZZConsumer', producer: 'ZZLib', output: path.join(a.workspace, 'odc', 'snapshots', 'zzlib.avsig') });
    assert.equal(answerA.code, 'PRODUCER_NOT_PUBLISHED', JSON.stringify(answerA).slice(0, 500));
    assert.equal(answerA.continuation?.tool, 'studio_publish', 'A\'s own merge is publishable: ' + JSON.stringify(answerA.continuation).slice(0, 400));
    assert.equal(answerA.continuation.arguments.module, 'ZZLib');
    const answerB = await fb.call('studio_reference_snapshot', { module: 'ZZConsumer', producer: 'ZZLib', output: path.join(b.workspace, 'odc', 'snapshots', 'zzlib.avsig') });
    assert.equal(answerB.code, 'PRODUCER_NOT_PUBLISHED');
    assert.notEqual(answerB.continuation?.tool, 'studio_publish', 'B has no merge of its own: A\'s never counts');
  } finally { await fa.close(); await fb.close(); }
});

test('B2: hosted, studio_publish {module} takes the customer\'s own merge in <ws>/odc/lab and keeps the publication ledger in <ws>/odc', async () => {
  const before = new Set(listShared());
  const a = hosted('A'), b = hosted('B');
  const manifestA = cleanMerge(path.join(a.workspace, 'odc', 'lab'), 'b'.repeat(64));
  const sent = [];
  const studio = async (args, pid) => {
    sent.push(args[0]);
    if (args[0] === 'status') return { ok: true, pid: 4242, modules: [{ name: 'ZZLib', key: 'k-zzlib', host: TENANT }] };
    if (args[0] === 'authorize') return { ok: true };
    if (args[0] === 'publish') return { ok: true, requested: true, manifest: args[1] };
    return { ok: false, error: 'unexpected ' + args[0] };
  };
  const fa = await hostedFacade(a, { studio }), fb = await hostedFacade(b, { studio });
  try {
    const answerA = await fa.call('studio_publish', { module: 'ZZLib', authorize: 'publish ZZLib now, I approve it', wait: false });
    assert.notEqual(answerA.code, 'NO_DELIVERY_TO_PUBLISH', JSON.stringify(answerA).slice(0, 500));
    assert.ok(sent.includes('publish'), 'the publication was requested: ' + sent.join(','));
    assert.equal(path.resolve(answerA.resolvedFrom?.manifest ?? answerA.manifest ?? ''), path.resolve(manifestA), JSON.stringify(answerA).slice(0, 500));
    assert.ok(listUnder(path.join(a.workspace, 'odc', '.local', 'producer-cache')).length > 0, 'the ledger is in A\'s workspace');
    assert.deepEqual(listShared().filter(f => !before.has(f)), [], 'nothing new in the producer cache of the code root');
    const answerB = await fb.call('studio_publish', { module: 'ZZLib', authorize: 'publish ZZLib now, I approve it', wait: false });
    assert.equal(answerB.code, 'NO_DELIVERY_TO_PUBLISH', 'B has no merge of its own: ' + JSON.stringify(answerB).slice(0, 300));
  } finally { await fa.close(); await fb.close(); }
});
