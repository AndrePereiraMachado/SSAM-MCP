// The code under test may write under the user's profile: this process's profile is a temporary folder.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createSsamServer, createAppSessionServer, writeInlineJob } from '../ssam.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');

async function connect(server) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ssam-integration-test', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}
const temp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('one server answers an O11 delivery with "delivered" and the job it used (nextBasedOn), through the shared response shaper', async () => {
  const root = temp('ssam-int-root-');
  const runAnvil = fakeAnvil({ deliver: () => ({ ok: true, command: 'deliver', data: { delivered: true, taskId: 't1', writeState: 'applied' } }) });
  const server = await createSsamServer({ odc: false, deps: { cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil, assertSelected: async () => {}, tasksDir: path.join(root, 'tasks') },
    lock: { o11Root: root, odcRoot: root, connection: () => null } } });
  const client = await connect(server);
  try {
    const reply = await client.callTool({ name: 'o11_deliver', arguments: { module: 'Quotes_CS', job: { ops: [{ op: 'rename', target: 'A', name: 'B' }] }, authorize: 'pode entregar' } });
    assert.notEqual(reply.isError, true, JSON.stringify(reply));
    assert.equal(JSON.parse(reply.content[0].text).result, 'delivered');
    assert.equal(runAnvil.calls[0].args[0], 'deliver');
    // The inline job became a file the CLI read; the words never reached the CLI.
    const job = runAnvil.calls[0].args[runAnvil.calls[0].args.indexOf('--job') + 1];
    // The job in the kernel form (rename {target, name}) is summarized too (job-summary.mjs, 24-1).
    assert.deepEqual(JSON.parse(reply.content[0].text), { ok: true, result: 'delivered', nextBasedOn: { job, sha256: sha256(fs.readFileSync(job)) }, summary: { edited: { count: 1, targets: ['A'] }, ops: 1 } });
    assert.ok(fs.existsSync(job)); assert.doesNotMatch(runAnvil.calls[0].args.join(' '), /pode entregar/);
    // A shape with one meaning (rename {from, to}, ops beside the job) is delivered in the kernel form and listed.
    const shaped = await client.callTool({ name: 'o11_deliver', arguments: { module: 'Quotes_CS', ops: [{ op: 'rename', from: 'A', to: 'B' }], authorize: 'pode entregar' } });
    const value = JSON.parse(shaped.content[0].text);
    assert.equal(value.result, 'delivered', JSON.stringify(value));
    assert.deepEqual(value.normalizations.map(n => n.rule), ['job-ops', 'job-op']);
    const delivered = runAnvil.calls.filter(c => c.args[0] === 'deliver').at(-1).args;
    const second = delivered[delivered.indexOf('--job') + 1];
    assert.deepEqual(JSON.parse(fs.readFileSync(second, 'utf8')).ops, [{ op: 'rename', target: 'A', name: 'B' }]);
  } finally { await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// A08 (atritos 2): the second write waits its turn in the Studio write queue and answers its own result plus `queue`; a
// read of a closed module (A29) reads its published OML, never a tab and never the lock (this temporary root has no CLI,
// so that read answers CLI_NOT_BUILT and nothing is downloaded).
test('two writes on one Studio never overlap through the ssam server: the second waits its turn, shaped; a read passes', async () => {
  const root = temp('ssam-int-lock-');
  let entered; const reached = new Promise(resolve => { entered = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  const runAnvil = fakeAnvil({ deliver: async () => { entered(); await gate; return { ok: true, command: 'deliver', data: { delivered: true, taskId: 't1', writeState: 'applied' } }; } });
  const evidence = path.join(root, '.local', 'journal', 'probe.json');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, JSON.stringify({ ok: true, stage: 'merge', items: [1, 2, 3] }));
  // o11_inspect {module} captures through this fake bridge: Other_CS is not open, so its capture would have to open it.
  const opened = [];
  const bridge = { async ok(method, params = {}) {
    if (method === 'list_open_modules') return { modules: [{ name: 'Quotes_CS', key: 'KQ', hasESpace: true, hasOpenedActiveESpace: true }] };
    if (method === 'open_module') { opened.push(params.name); return { opened: true, name: params.name }; }
    throw new Error('unexpected bridge call ' + method);
  } };
  const server = await createSsamServer({ odc: false, deps: {
    cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil, assertSelected: async () => {}, tasksDir: path.join(root, 'tasks'), bridge,
      lock: { connection: () => null } },
    lock: { o11Root: root, odcRoot: root, connection: () => null }, evidence: { roots: [path.join(root, '.local')] } } });
  const client = await connect(server);
  const words = 'pode entregar, Ana 0912';
  const job = { ops: [{ op: 'rename', from: 'A', to: 'B' }] };
  // Identical calls join under CX12; separate jobs must still queue on the same Studio.
  const secondJob = { ops: [{ op: 'rename', from: 'A', to: 'C' }] };
  try {
    const first = client.callTool({ name: 'o11_deliver', arguments: { module: 'Quotes_CS', job, authorize: words } });
    await reached;
    const second = client.callTool({ name: 'o11_deliver', arguments: { module: 'Quotes_CS', job: secondJob, authorize: words } });
    // A closed module is read from its published OML: no tab is opened under the running delivery and no lock is taken,
    // so this read answers while the write runs.
    const inspect = await client.callTool({ name: 'o11_inspect', arguments: { module: 'Other_CS' } });
    const inspected = JSON.parse(inspect.content[0].text);
    assert.equal(inspected.code, 'CLI_NOT_BUILT', inspect.content[0].text);
    assert.deepEqual(opened, [], 'the other module was never opened');
    // A read never waits for the write (ssam_evidence is registered on the ssam server).
    const read = await client.callTool({ name: 'ssam_evidence', arguments: { file: evidence, select: ['/stage'] } });
    assert.notEqual(read.isError, true, read.content[0].text);
    assert.match(read.content[0].text, /merge/);
    assert.equal(runAnvil.calls.filter(c => c.args[0] === 'deliver').length, 1, 'the second write waits in the queue');
    release();
    assert.equal(JSON.parse((await first).content[0].text).result, 'delivered');
    const waited = await second;
    assert.notEqual(waited.isError, true, JSON.stringify(waited));
    assert.equal(JSON.parse(waited.content[0].text).result, 'delivered');
    const queue = waited.structuredContent?.queue ?? waited.content.map(c => { try { return JSON.parse(c.text).queue; } catch { return undefined; } }).find(Boolean);
    assert.deepEqual([queue?.position, queue?.holder?.tool], [1, 'o11_deliver'], JSON.stringify(waited));
    assert.doesNotMatch(JSON.stringify(waited), /Ana 0912/);
    assert.equal(runAnvil.calls.filter(c => c.args[0] === 'deliver').length, 2);
    // Released: the next write runs, and no lock file is left behind.
    assert.equal(JSON.parse((await client.callTool({ name: 'o11_deliver', arguments: { module: 'Quotes_CS', job, authorize: words } })).content[0].text).result, 'delivered');
    assert.deepEqual(fs.readdirSync(path.join(root, '.local', 'locks')), []);
  } finally { release(); await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('studio_deliver through ssam: a refusal names its job; patch + basedOn corrects it into a new file; a changed base is refused', async () => {
  const odcRoot = temp('ssam-int-odc-');
  const seen = []; const replies = [];
  // A fake ODC server with the strict shape of the real studio_deliver: no Studio, no bridge, no builder.
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_deliver', { title: 'Deliver', description: 'Fake ODC delivery.', inputSchema: z.object({ feature: z.string().min(1), module: z.string().optional(),
      job: z.string().optional(), owners: z.array(z.string()).optional(), changes: z.array(z.string()).optional(),
      until: z.enum(['snapshot', 'build', 'check-base', 'preview', 'merge']).optional(), pid: z.number().int().optional() }).strict() }, async args => {
      seen.push({ args, job: args.job ? JSON.parse(fs.readFileSync(args.job, 'utf8')) : null });
      const value = replies.shift();
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(value.ok === false ? { isError: true } : {}) };
    });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot, lock: { o11Root: odcRoot, odcRoot, connection: () => null } } });
  const client = await connect(server);
  const call = async args => { const r = await client.callTool({ name: 'studio_deliver', arguments: args }); return { r, value: r.structuredContent ?? JSON.parse(r.content[0].text) }; };
  const common = { feature: 'F', module: 'Orders', owners: ['Contact'], changes: ['Name 200'] };
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'studio_deliver');
    assert.ok(tool.inputSchema.properties.patch && tool.inputSchema.properties.basedOn, 'patch/basedOn exposed');
    assert.match(tool.description, /patch \+ basedOn/);
    // 1) The whole job once; the kernel names op #1 -> job, jobSha256 and failedOp come back.
    replies.push({ ok: false, error: 'op #1 (set Contact.Name): Length must be positive', refusal: { stage: 'build' } });
    const job = { ops: [{ op: 'set', name: 'Contact', prop: 'Description', value: 'x' }, { op: 'set', name: 'Contact.Name', prop: 'Length', value: -1 }] };
    const refused = await call({ ...common, job });
    assert.equal(refused.r.isError, true);
    assert.equal(path.dirname(refused.value.job), path.join(odcRoot, '.local', 'jobs', 'inline'));
    assert.equal(refused.value.jobSha256, sha256(fs.readFileSync(refused.value.job)));
    assert.equal(refused.value.failedOp, 1);
    // 2) The correction: only the patch; a NEW job file reaches the ODC server, without patch/basedOn; the base is intact.
    replies.push({ ok: true, merged: true, strictlyEqual: true });
    const before = fs.readFileSync(refused.value.job);
    const fixed = await call({ ...common, patch: [{ op: 'replace', path: '/ops/1/value', value: 200 }], basedOn: { job: refused.value.job, sha256: refused.value.jobSha256 } });
    assert.notEqual(fixed.r.isError, true, JSON.stringify(fixed.value));
    assert.equal(fixed.value.result, 'delivered');
    assert.deepEqual(Object.keys(seen[1].args).sort(), ['changes', 'feature', 'job', 'module', 'owners']);
    assert.notEqual(seen[1].args.job, refused.value.job);
    assert.equal(seen[1].job.ops[1].value, 200);
    assert.deepEqual(fs.readFileSync(refused.value.job), before);
    // 3) A base that changed since the refusal is refused before anything reaches the ODC server.
    fs.appendFileSync(refused.value.job, ' ');
    const stale = await call({ ...common, patch: [{ op: 'replace', path: '/ops/1/value', value: 300 }], basedOn: { job: refused.value.job, sha256: refused.value.jobSha256 } });
    assert.equal(stale.r.isError, true); assert.equal(stale.value.code, 'BASE_CHANGED');
    assert.equal(seen.length, 2);
  } finally { await client.close(); await server.close(); fs.rmSync(odcRoot, { recursive: true, force: true }); }
});

// A08: the refusal comes only when the bounded wait runs out (queueMs 0 here: no wait).
test('a busy Studio on a server of one lane names a continuation that server serves', async () => {
  const odcRoot = temp('ssam-int-busy-');
  let entered; const reached = new Promise(resolve => { entered = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  // A fake ODC server with studio_deliver only (no studio_status): no Studio, no bridge.
  const odcFacade = async () => {
    const fake = new McpServer({ name: 'fake-odc', version: '0.0.1' });
    fake.registerTool('studio_deliver', { inputSchema: z.object({ feature: z.string(), changes: z.array(z.string()).optional(), until: z.string().optional() }).strict() }, async () => {
      entered(); await gate; const value = { ok: true, merged: true, strictlyEqual: true };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    });
    return fake;
  };
  const server = await createSsamServer({ o11: false, odc: true, deps: { odcFacade, odcRoot, lock: { o11Root: odcRoot, odcRoot, connection: () => null, queueMs: 0 } } });
  const client = await connect(server);
  try {
    const names = new Set((await client.listTools()).tools.map(t => t.name));
    assert.equal(names.has('ssam_task'), false, 'no O11 lane, no ssam_task');
    // Distinct changes exercise queue refusal; identical calls join the first operation under CX12.
    const first = client.callTool({ name: 'studio_deliver', arguments: { feature: 'F', changes: ['rename A to B'] } });
    await reached;
    const busy = JSON.parse((await client.callTool({ name: 'studio_deliver', arguments: { feature: 'F', changes: ['rename A to C'] } })).content[0].text);
    assert.deepEqual([busy.code, busy.outcome, busy.holder?.tool, busy.position], ['STUDIO_WRITE_QUEUE_TIMEOUT', 'not-sent', 'studio_deliver', 1], JSON.stringify(busy));
    assert.ok(names.has(busy.continuation.tool), busy.continuation.tool + ' is served here');
    assert.deepEqual([busy.continuation.tool, busy.continuation.arguments], ['ssam_doctor', { lane: 'odc' }]);
    release();
    assert.equal((await first).content[0].text, JSON.stringify({ ok: true, result: 'delivered' }));
  } finally { release(); await client.close(); await server.close(); fs.rmSync(odcRoot, { recursive: true, force: true }); }
});

test('ssam_evidence answers the file as it is: no rewritten hint, no nextCalls, within budgetBytes', async () => {
  const root = temp('ssam-int-evidence-');
  const journal = path.join(root, '.local', 'journal', 'diario.jsonl');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const msg = 'ran dotnet build kernel/src/X.csproj then ssam deliver --module M --job j.json';
  fs.writeFileSync(journal, Array.from({ length: 20 }, (_, i) => JSON.stringify({ i, msg })).join('\n') + '\n');
  const server = await createSsamServer({ o11: false, odc: false, deps: { evidence: { roots: [path.join(root, '.local')] } } });
  const client = await connect(server);
  try {
    const one = JSON.parse((await client.callTool({ name: 'ssam_evidence', arguments: { file: journal, pointer: '/0/msg' } })).content[0].text);
    assert.equal(one.value, msg, 'the evidence says what the file says');
    assert.equal(one.nextCalls, undefined);
    const page = await client.callTool({ name: 'ssam_evidence', arguments: { file: journal, budgetBytes: 2000 } });
    const value = JSON.parse(page.content[0].text);
    assert.equal(value.nextCalls, undefined); assert.equal(value.items[0].msg, msg);
    assert.ok(Buffer.byteLength(page.content[0].text) <= 2000, Buffer.byteLength(page.content[0].text) + ' bytes');
    assert.doesNotMatch(page.content[0].text, /o11_deliver|ssam_doctor/);
  } finally { await client.close(); await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a job tool answer that names a shell command reaches the model as the MCP call that does it', async () => {
  const jobTool = async () => ({ ok: false, code: 'CLI_NOT_BUILT', error: 'The anvil CLI is missing; run dotnet build src/Anvil.Cli -c Release first.' });
  const server = await createSsamServer({ odc: false, deps: { jobTool } });
  const client = await connect(server);
  try {
    const reply = await client.callTool({ name: 'o11_job', arguments: { job: [{ op: 'find', kind: 'Entity' }] } });
    assert.equal(reply.isError, true);
    const value = JSON.parse(reply.content[0].text);
    assert.doesNotMatch(JSON.stringify(value), /dotnet build/);
    assert.equal(value.continuation.tool, 'ssam_doctor');
  } finally { await client.close(); await server.close(); }
});

test('the controlled app profile gets its own server named ssam_hybrid with the four app tools, in process', async () => {
  const server = await createAppSessionServer();
  const client = await connect(server);
  try {
    assert.equal(client.getServerVersion().name, 'ssam_hybrid');
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['context', 'continue', 'propose', 'status']);
  } finally { await client.close(); await server.close(); }
});

test('an inline job becomes a file under the lane root; a path stays as given', () => {
  const root = temp('ssam-int-inline-');
  try {
    const file = writeInlineJob(root, { ops: [{ op: 'find' }] });
    assert.equal(path.dirname(file), path.join(root, '.local', 'jobs', 'inline'));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ops: [{ op: 'find' }] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
