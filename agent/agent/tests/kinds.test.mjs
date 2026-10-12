// The closed list of kinds, the ODC command allowlist, path positions, the final line of odc.pipe, the per-pid
// version check and file.* (docs/FASE2-AGENTE.md 4.4, 4.8). Fakes only: a fake named pipe, fake process lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createKinds, O11_METHODS, ODC_COMMANDS } from '../lib/kinds.mjs';
import { createWorkspace } from '../lib/workspace.mjs';
import { createAgent, readPack } from '../lib/agent.mjs';
import { pipeName } from '../lib/odc-pipe.mjs';
import { PART_BYTES } from '../lib/blobs.mjs';
import { fakeBridge } from './fixtures/fake-bridge.mjs';
import { makeRoot, removeRoot, CREDENTIAL } from './fixtures/agent-root.mjs';

const PID = 4100000 + Math.floor(Math.random() * 90000) * 4;
const OLD = PID + 4;
const KERNEL = { odc: '1.7.27', o11: '11.55.91', odcBridge: 'v35' };
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const PROCESSES = {
  'ODCStudio.exe': [{ pid: PID, path: 'C:\\Program Files\\OutSystems\\ODC Studio\\ODC Studio\\ODCStudio.exe', version: '1.7.27.4021' },
    { pid: OLD, path: 'C:\\Other\\ODCStudio.exe', version: '1.7.28.100' }],
  'ServiceStudio.exe': [{ pid: 5000, path: 'C:\\Program Files\\OutSystems\\Service Studio 11\\Service Studio\\ServiceStudio.exe', version: '11.55.90.1' }],
};

function memoryBlobs() {
  const store = new Map();
  const blobs = {
    store, downloads: 0,
    offer(buffer) {
      const ref = { transfer: randomBytes(16).toString('hex'), sha256: sha(buffer), size: buffer.length, parts: Math.max(1, Math.ceil(buffer.length / PART_BYTES)), partBytes: PART_BYTES };
      store.set(ref.transfer, buffer);
      return ref;
    },
    async download(ref, dest) { blobs.downloads++; fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, store.get(ref.transfer)); return { sha256: ref.sha256, size: ref.size }; },
    async upload(source) { return blobs.offer(Buffer.isBuffer(source) ? source : fs.readFileSync(source)); },
  };
  return blobs;
}

function kindsFor(root, { kernel = KERNEL, blobs = memoryBlobs(), attachOdc, processes = PROCESSES } = {}) {
  const counts = { processes: 0, attach: 0 };
  const kinds = createKinds({ root, ws: createWorkspace(root), pack: readPack(root), kernel: () => kernel, blobs, limits: () => ({}),
    deps: { processes: async image => { counts.processes++; return processes[image] ?? []; }, fileVersion: async () => null,
      attachOdc: attachOdc ?? (async () => { counts.attach++; return { ok: true, attached: true, note: 'Run status first.' }; }) } });
  return { kinds, counts, blobs };
}

const refused = (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); assert.equal(error.executed, false); return true; });

async function fakePipe(version, pid, reply = line => ({ ok: true, received: line })) {
  const lines = [];
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const line = buffer.slice(0, index); lines.push(line);
      socket.end(JSON.stringify(reply(line)) + '\n');
    });
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(pipeName(version, pid), resolve));
  return { lines, close: () => new Promise(resolve => server.close(resolve)) };
}

test('unknown kinds (file.stat, agent.info, studio.locate, ...) are refused with executed:false', async () => {
  const root = makeRoot();
  try {
    const agent = createAgent({ root, config: { server: 'http://127.0.0.1:7499', credential: CREDENTIAL }, deps: { processes: async () => [], locate: async () => null } });
    for (const kind of ['file.stat', 'agent.info', 'studio.locate', 'shell.exec', 'toString', '__proto__', 'constructor', '']) {
      const result = await agent.execute(kind, {});
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'KIND_NOT_ALLOWED', kind);
      assert.equal(result.error.executed, false);
    }
  } finally { removeRoot(root); }
});

test('attach and unknown commands never go through odc.pipe; login, export_*, find_element and get_flow_nodes never through o11.bridge', async () => {
  const root = makeRoot();
  try {
    const { kinds } = kindsFor(root);
    for (const args of [['attach', 'C:\\x\\ODC3.Bridge.v35.dll'], ['attach'], ['exec', 'calc'], ['Status'], ['']])
      await refused(kinds.execute('odc.pipe', { pid: PID, version: 'v35', args }), 'COMMAND_NOT_ALLOWED');
    for (const method of ['login', 'export_modules', 'export_status', 'find_element', 'get_flow_nodes', 'eval', 'shell'])
      await refused(kinds.execute('o11.bridge', { method, params: {} }), 'METHOD_NOT_ALLOWED');
  } finally { removeRoot(root); }
});

test('24th release: reference-producers passes odc.pipe; the private Portal commands, portal-upload and the private SC transport never pass', async () => {
  const root = makeRoot();
  const pipe = await fakePipe('v35', PID);
  try {
    const { kinds } = kindsFor(root);
    assert.ok(ODC_COMMANDS.includes('reference-producers'));
    const answer = await kinds.execute('odc.pipe', { pid: PID, version: 'v35', args: ['reference-producers', 'Quotes'] });
    assert.equal(JSON.parse(answer.line).ok, true);
    assert.equal(pipe.lines[0], 'reference-producers Quotes');
    // A path hidden in the module word is still a path of the final line.
    await refused(kinds.execute('odc.pipe', { pid: PID, version: 'v35', args: ['reference-producers', 'Quotes C:\\x.oml'] }), 'PATH_FORBIDDEN');
    for (const command of ['portal-private-call', 'portal-private-download', 'portal-api-client-fixture-cleanup', 'portal-upload']) {
      assert.equal(ODC_COMMANDS.includes(command), false, command);
      await refused(kinds.execute('odc.pipe', { pid: PID, version: 'v35', args: [command, 'agent:odc/journal/portal/requests/x.json'] }), 'COMMAND_NOT_ALLOWED');
    }
    for (const method of ['sc_private_http', 'sc_private_http_cookie']) {
      assert.equal(O11_METHODS.includes(method), false, method);
      await refused(kinds.execute('o11.bridge', { method, params: { host: 'lab.example.com' } }), 'METHOD_NOT_ALLOWED');
    }
    assert.equal(pipe.lines.length, 1, 'only reference-producers reached the bridge');
  } finally { await pipe.close(); removeRoot(root); }
});

test('o11.bridge passes exactly the 23 verbs of the thin bridge, in the order of its manifest (docs/O11-BRIDGE-FINA.md 3.2, 14, 16)', async () => {
  // refresh_references (ninth release): the Studio's own Refresh References; answer_dependencies_dialog (servidor/fase4): the
  // Manage Dependencies dialog answered as Cancel; sc_http (24th release): the Service Center over the Studio's own HTTP
  // session. No path in any of them, so nothing to confine (sc_http args.outFile is refused like sc_web's).
  assert.deepEqual(O11_METHODS, ['ping', 'bridge_manifest', 'get_active_module', 'list_open_modules', 'get_errors', 'open_module', 'close_module',
    'publish', 'windows', 'ui_alive', 'close_dialog', 'snapshot_module', 'merge_from_oml', 'merge_status', 'environment_session', 'sc_api',
    'sc_web', 'sc_http', 'studio_login', 'sc_session', 'publish_log', 'refresh_references', 'answer_dependencies_dialog']);
  const root = makeRoot();
  const bridge = await fakeBridge(request => ({ success: true, data: { method: request.method } }));
  try {
    fs.writeFileSync(path.join(root, 'private', 'o11-connection.json'), JSON.stringify({ ok: true, lane: 'o11', pid: 6000, startedUtc: 'x', port: bridge.port }));
    fs.writeFileSync(path.join(root, 'private', 'authority', 'bridge.key'), 'local-agent-key');
    const { kinds } = kindsFor(root);
    const params = { snapshot_module: { path: 'agent:o11/snapshots/M.oml' }, merge_from_oml: { foreign_path: 'agent:o11/work/c.oml', base_path: 'agent:o11/snapshots/M.oml',
      reference_plan: { Changes: [], Conflicts: [], HasChanges: false, HasConflicts: false } } };
    for (const method of O11_METHODS) {
      const { reply } = await kinds.execute('o11.bridge', { method, params: params[method] ?? {} });
      assert.equal(reply.data.method, method);
    }
    assert.deepEqual(bridge.seen.map(r => r.method), O11_METHODS);
    // reference_plan is not a path: it reaches the bridge unchanged.
    assert.deepEqual(bridge.seen.find(r => r.method === 'merge_from_oml').params.reference_plan, params.merge_from_oml.reference_plan);
  } finally { await bridge.close(); removeRoot(root); }
});

test('an absolute (or otherwise non-agent) value at a path position gives PATH_NOT_AGENT', async () => {
  const root = makeRoot();
  try {
    const { kinds } = kindsFor(root);
    for (const args of [['merge', 'C:\\x\\manifest.json'], ['authorize', 'C:\\x\\manifest.json', 'publish', 'ok'], ['open', 'Mod', 'C:\\x.oml'],
      ['data', 'M', 'E', '--out', 'C:\\x.json'], ['data-insert', 'M', 'E', '--records-file', 'C:\\r.json', '--authorize', 'ok'],
      ['portal-call', 'C:\\r.json'], ['portal-session', 'fetch', 'C:\\r.json'], ['publish', 'lab\\manifest.json'],
      ['reference-snapshot', JSON.stringify({ module: 'M', producer: 'P', output: 'C:\\x.avsig' })]])
      await refused(kinds.execute('odc.pipe', { pid: PID, version: 'v35', args }), 'PATH_NOT_AGENT');
    for (const [method, params] of [['snapshot_module', { path: 'C:\\x.oml' }], ['merge_from_oml', { foreign_path: 'C:\\x.oml' }],
      ['merge_from_oml', { foreign_path: 'agent:o11/x.oml', base_path: 'C:\\b.oml' }],
      ['merge_from_oml', { foreign_path: 'agent:o11/x.oml', base_path: 'agent:o11/b.oml', first_pass_path: 'C:\\first-pass.oml' }], ['sc_api', { args: { file: 'C:\\x.osp' } }],
      ['environment_session', { operation: 'download', arguments: { outputDirectory: 'C:\\out' } }]])
      await refused(kinds.execute('o11.bridge', { method, params }), 'PATH_NOT_AGENT');
  } finally { removeRoot(root); }
});

test('final line: paths hidden inside one argument, line breaks and NUL are refused; ellipses pass', async () => {
  const root = makeRoot();
  const pipe = await fakePipe('v35', PID);
  try {
    const { kinds } = kindsFor(root);
    const run = args => kinds.execute('odc.pipe', { pid: PID, version: 'v35', args });
    await refused(run(['open', 'Mod C:\\x.oml']), 'PATH_FORBIDDEN');
    await refused(run(['data-insert', 'M', 'E', '--authorize', 'x --records-file C:\\s.json']), 'PATH_FORBIDDEN');
    await refused(run(['data', 'M', 'E', '--limit', '5 --out agent:inbox/x.json']), 'PATH_FORBIDDEN');
    await refused(run(['data', 'M', 'E', '--limit', '5 --out studio\\bridge\\x.json']), 'PATH_FORBIDDEN');
    await refused(run(['status', '..\\..\\private\\credential']), 'PATH_FORBIDDEN');
    await refused(run(['status', '\\\\server\\share\\x']), 'PATH_FORBIDDEN');
    await refused(run(['status', 'agent:private/credential']), 'PATH_FORBIDDEN');
    for (const bad of ['a\rb', 'a\nstatus', 'a\0b'])
      await refused(run(['authorize', 'agent:odc/lab/j/manifest.json', 'publish', bad]), 'COMMAND_NOT_ALLOWED');
    assert.equal(pipe.lines.length, 0, 'nothing reached the bridge');
    const answer = await run(['authorize', 'agent:odc/lab/j/manifest.json', 'publish', 'pode', 'publicar...', '"ok..."']);
    assert.equal(JSON.parse(answer.line).ok, true);
    assert.equal(pipe.lines[0], 'authorize ' + path.join(root, 'odc', 'lab', 'j', 'manifest.json') + ' publish pode publicar... "ok..."');
    // portal-session fetch with an agent: request passes, mapped to this machine's folder.
    await run(['portal-session', 'fetch', 'agent:odc/journal/portal/requests/x.json', '--tenant', 'acme.outsystems.dev']);
    assert.equal(pipe.lines[1], 'portal-session fetch ' + path.join(root, 'odc', 'journal', 'portal', 'requests', 'x.json') + ' --tenant acme.outsystems.dev');
    await refused(run(['portal-session', 'fetch', 'C:\\Users\\cliente\\x.json']), 'PATH_NOT_AGENT');
    // Any other agent: word is mapped for reading; reference-snapshot's output for writing.
    await run(['open', 'Quotes', 'agent:inbox/Quotes.oml']);
    assert.equal(pipe.lines[2], 'open Quotes ' + path.join(root, 'inbox', 'Quotes.oml'));
    await run(['reference-snapshot', JSON.stringify({ module: 'App', producer: 'Lib', output: 'agent:odc/lab/ref/Lib.avsig' })]);
    assert.equal(JSON.parse(pipe.lines[3].slice('reference-snapshot '.length)).output, path.join(root, 'odc', 'lab', 'ref', 'Lib.avsig'));
    await refused(run(['reference-snapshot', JSON.stringify({ module: 'App', producer: 'Lib', output: 'agent:inbox/Lib.avsig' })]), 'PATH_FORBIDDEN');
  } finally { await pipe.close(); removeRoot(root); }
});

test('a manifest whose own path fields leave the agent folders is refused before the bridge', async () => {
  const root = makeRoot();
  const pipe = await fakePipe('v35', PID);
  try {
    const { kinds } = kindsFor(root);
    const folder = path.join(root, 'odc', 'lab', 'j');
    fs.mkdirSync(folder, { recursive: true });
    const write = manifest => fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
    const run = () => kinds.execute('odc.pipe', { pid: PID, version: 'v35', args: ['merge', 'agent:odc/lab/j/manifest.json'] });
    write({ basePath: 'C:\\Users\\cliente\\segredo.oml', candidatePath: path.join(folder, 'c.oml'), evidenceDir: path.join(folder, 'evidence') });
    await refused(run(), 'PATH_FORBIDDEN');
    write({ basePath: path.join(root, 'odc', 'snapshots', 'Q.oml'), candidatePath: path.join(folder, 'c.oml'), EvidenceDir: path.join(root, 'inbox', 'e') });
    await refused(run(), 'PATH_FORBIDDEN');
    assert.equal(pipe.lines.length, 0);
    write({ basePath: path.join(root, 'odc', 'snapshots', 'Q.oml'), candidatePath: path.join(folder, 'c.oml'), evidenceDir: path.join(folder, 'evidence'), producerPath: '' });
    await run();
    assert.equal(pipe.lines.length, 1);
  } finally { await pipe.close(); removeRoot(root); }
});

test('per-pid version: odc.pipe, odc.attach and o11.connect refuse a Studio whose ProductVersion differs from the kernel', async () => {
  const root = makeRoot();
  try {
    const { kinds, counts } = kindsFor(root);
    await refused(kinds.execute('odc.pipe', { pid: OLD, version: 'v35', args: ['status', 'brief'] }), 'STUDIO_VERSION_MISMATCH');
    await refused(kinds.execute('odc.attach', { pid: OLD }), 'STUDIO_VERSION_MISMATCH');
    await refused(kinds.execute('o11.connect', { pid: 5000 }), 'STUDIO_VERSION_MISMATCH');
    await refused(kinds.execute('o11.connect', {}), 'STUDIO_VERSION_MISMATCH');
    assert.equal(counts.attach, 0);
    // A pid of the last listing is not listed again; an unknown pid triggers exactly one listing.
    const before = counts.processes;
    await refused(kinds.execute('odc.attach', { pid: OLD }), 'STUDIO_VERSION_MISMATCH');
    assert.equal(counts.processes, before);
    await refused(kinds.execute('odc.attach', { pid: 8 }), 'STUDIO_NOT_SELECTED');
    assert.equal(counts.processes, before + 1);
    // No kernel for the lane on the server: refused too.
    const none = kindsFor(root, { kernel: { odc: null, o11: null, odcBridge: null } });
    await refused(none.kinds.execute('odc.attach', { pid: PID }), 'STUDIO_VERSION_MISMATCH');
  } finally { removeRoot(root); }
});

test('odc.pipe against a fake named pipe: the line goes out, the reply comes back relativized; another bridge version is refused', async () => {
  const root = makeRoot();
  const snapshot = path.join(root, 'odc', 'snapshots', 'Quotes.oml');
  const pipe = await fakePipe('v35', PID, line => ({ ok: true, command: line, path: snapshot, bridgeDll: path.join(root, 'odc', 'studio', 'bridge', 'x.dll'), referrer: 'agent:smith' }));
  try {
    const { kinds } = kindsFor(root);
    const answer = await kinds.execute('odc.pipe', { pid: PID, version: 'v35', args: ['snapshot', 'Quotes'] });
    const reply = JSON.parse(answer.line);
    assert.equal(reply.command, 'snapshot Quotes');
    assert.equal(reply.path, 'agent:odc/snapshots/Quotes.oml');
    assert.equal(reply.bridgeDll, path.join(root, 'odc', 'studio', 'bridge', 'x.dll'));
    // Only the rewritten string is reported; data text that starts with agent: is not.
    assert.equal(reply.referrer, 'agent:smith');
    assert.deepEqual(answer.paths, [['path']]);
    await refused(kinds.execute('odc.pipe', { pid: PID, version: 'v34', args: ['status'] }), 'BRIDGE_VERSION_MISMATCH');
    assert.equal(pipe.lines.length, 1);
    // No pipe for that pid: the transport code comes back as is, nothing sent.
    const other = PID + 400000;
    const { kinds: lonely } = kindsFor(root, { processes: { 'ODCStudio.exe': [{ pid: other, path: 'C:\\x\\ODCStudio.exe', version: '1.7.27.1' }] } });
    await assert.rejects(lonely.execute('odc.pipe', { pid: other, version: 'v35', args: ['status'], connectMs: 50 }),
      error => error.code === 'BRIDGE_NOT_ATTACHED' && error.sent === false && error.executed === false);
  } finally { await pipe.close(); removeRoot(root); }
});

test('odc.attach uses only the pack client and bridge, never a path from the server', async () => {
  const root = makeRoot();
  try {
    let seen = null;
    const { kinds } = kindsFor(root, { attachOdc: async input => { seen = input; return { ok: true, attached: true, note: 'Run status before any other command.' }; } });
    await refused(kinds.execute('odc.attach', { pid: PID, dll: 'C:\\evil.dll' }), 'ATTACH_FAILED');
    const client = path.join(root, 'odc', 'studio', 'bridge', 'client', 'bin', 'Release', 'net10.0', 'ODC3.Bridge.Client.dll');
    const bridge = path.join(root, 'odc', 'studio', 'bridge', 'bin', 'Release', 'net8.0', 'ODC3.Bridge.v35.dll');
    for (const file of [client, bridge]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'dll'); }
    const result = await kinds.execute('odc.attach', { pid: PID, dll: 'C:\\evil.dll' });
    assert.deepEqual(result, { ok: true, attached: true, pid: PID, version: 'v35', note: 'Run status before any other command.' });
    assert.deepEqual(seen, { pid: PID, client, bridge });
  } finally { removeRoot(root); }
});

test('file.put / file.get / file.list stay in the agent folders; agent-paths maps the manifest both ways', async () => {
  const root = makeRoot();
  try {
    const { kinds, blobs } = kindsFor(root);
    const data = Buffer.from('candidate bytes');
    const put = await kinds.execute('file.put', { path: 'agent:odc/lab/j/candidate.oml', blob: blobs.offer(data) });
    assert.deepEqual(put, { path: 'agent:odc/lab/j/candidate.oml', sha256: sha(data), size: data.length, skipped: false });
    assert.equal(blobs.downloads, 1);
    const again = await kinds.execute('file.put', { path: 'agent:odc/lab/j/candidate.oml', blob: blobs.offer(data) });
    assert.equal(again.skipped, true);
    assert.equal(blobs.downloads, 1, 'same sha256: nothing downloaded');
    for (const target of ['agent:inbox/x.oml', 'agent:private/credential', 'agent:pack.json', 'agent:bin/o11/x.dll', 'agent:odc/studio/x.dll'])
      await refused(kinds.execute('file.put', { path: target, blob: blobs.offer(data) }), 'PATH_FORBIDDEN');
    await refused(kinds.execute('file.put', { path: 'C:\\x.oml', blob: blobs.offer(data) }), 'PATH_NOT_AGENT');
    await refused(kinds.execute('file.put', { path: 'agent:o11/x.oml', blob: { transfer: 'x' } }), 'TRANSFER_INVALID');

    // agent-paths in: absolute paths on this machine only in the 5 fields; an absolute value there is refused.
    const manifest = { schema: 'odc3-manifest/1', basePath: 'agent:odc/snapshots/Q.oml', candidatePath: 'agent:odc/lab/j/candidate.oml',
      evidenceDir: 'agent:odc/lab/j/evidence', builderReceipt: '', module: 'Q', note: 'agent:odc/lab/not-a-field' };
    await kinds.execute('file.put', { path: 'agent:odc/lab/j/manifest.json', blob: blobs.offer(Buffer.from(JSON.stringify(manifest))), json: 'agent-paths' });
    const written = JSON.parse(fs.readFileSync(path.join(root, 'odc', 'lab', 'j', 'manifest.json'), 'utf8'));
    assert.equal(written.basePath, path.join(root, 'odc', 'snapshots', 'Q.oml'));
    assert.equal(written.evidenceDir, path.join(root, 'odc', 'lab', 'j', 'evidence'));
    assert.equal(written.note, manifest.note);
    await refused(kinds.execute('file.put', { path: 'agent:odc/lab/k/manifest.json', json: 'agent-paths',
      blob: blobs.offer(Buffer.from(JSON.stringify({ ...manifest, basePath: 'C:\\Users\\cliente\\x.oml' }))) }), 'PATH_FORBIDDEN');
    assert.equal(fs.existsSync(path.join(root, 'odc', 'lab', 'k', 'manifest.json')), false);

    // agent-paths out: the inverse.
    const got = await kinds.execute('file.get', { path: 'agent:odc/lab/j/manifest.json', json: 'agent-paths' });
    assert.deepEqual(JSON.parse(blobs.store.get(got.blob.transfer).toString('utf8')), manifest);
    const raw = await kinds.execute('file.get', { path: 'agent:odc/lab/j/candidate.oml' });
    assert.deepEqual(blobs.store.get(raw.blob.transfer), data);
    fs.writeFileSync(path.join(root, 'inbox', 'cliente.oml'), 'from the customer');
    assert.equal((await kinds.execute('file.get', { path: 'agent:inbox/cliente.oml' })).blob.size, 17);
    await refused(kinds.execute('file.get', { path: 'agent:inbox/missing.oml' }), 'FILE_NOT_FOUND');
    await refused(kinds.execute('file.get', { path: 'agent:private/credential' }), 'PATH_FORBIDDEN');

    // file.list: recursive, with sha256, never following links, truncated at max.
    fs.symlinkSync(path.join(root, 'private'), path.join(root, 'odc', 'lab', 'j', 'link'), 'junction');
    const listing = await kinds.execute('file.list', { path: 'agent:odc/lab' });
    assert.deepEqual(listing.entries.map(e => e.path).sort(), ['agent:odc/lab/j/candidate.oml', 'agent:odc/lab/j/manifest.json']);
    assert.equal(listing.entries.find(e => e.path.endsWith('candidate.oml')).sha256, sha(data));
    assert.equal(listing.truncated, false);
    const one = await kinds.execute('file.list', { path: 'agent:odc/lab', max: 1 });
    assert.equal(one.entries.length, 1); assert.equal(one.truncated, true);
    assert.deepEqual((await kinds.execute('file.list', { path: 'agent:o11/none' })).entries, []);
    await refused(kinds.execute('file.list', { path: 'agent:private' }), 'PATH_FORBIDDEN');
  } finally { removeRoot(root); }
});

test('studio.processes lists only the two Studio images, with versions', async () => {
  const root = makeRoot();
  try {
    const { kinds } = kindsFor(root);
    const { processes } = await kinds.execute('studio.processes', { image: 'ODCStudio.exe' });
    assert.deepEqual(processes.map(p => [p.pid, p.version]), [[PID, '1.7.27.4021'], [OLD, '1.7.28.100']]);
    await refused(kinds.execute('studio.processes', { image: 'notepad.exe' }), 'PARAMS_INVALID');
  } finally { removeRoot(root); }
});

test('a lane the pack does not carry is disabled', async () => {
  const root = makeRoot({ lanes: ['odc'], o11BuiltFor: null });
  try {
    const { kinds } = kindsFor(root);
    await refused(kinds.execute('o11.bridge', { method: 'ping', params: {} }), 'LANE_DISABLED');
    await refused(kinds.execute('o11.connect', {}), 'LANE_DISABLED');
  } finally { removeRoot(root); }
});
