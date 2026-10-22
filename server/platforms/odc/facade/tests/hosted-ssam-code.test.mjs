// servidor/fase4-26 a8 (owner request 18/10): ssam_code served on the hosted server, every read and write of it the
// customer's own. Two synthetic tokens (customers A and B), a fake executor and a fake user machine per customer.
// - L1 the hosted catalog: ssam_code is a server tool, lane by argument, the agent by action (read of a module name, plan,
//   write), every file argument an input of the workspace (target and module when they look like a path, files, stubs,
//   shared, base, basedOn.job, also[].basedOn.job, producers).
// - L2 the gate: each of those paths is the customer's (A's own resolve to A's workspace; B's, the server's or any other are
//   PATH_OUTSIDE_WORKSPACE before the handler); the paths inside the job the call makes (its ops, its .json op files, the job
//   of basedOn) too; the prototype op, a pending generator and patch "verified" are refused as in the job tools.
// - L3 the hosted deps (hosted/code.mjs): the roots are the workspace's; the plan names its files as the session sees them
//   (ws: on the server, the agent folder on the user's machine) and brings its prompts there; the read an edit of logic
//   expands is only one this customer was served.
// - L4/L5 (the server's CLIs): check, plan and read in both lanes over the customer's captures; B sees nothing of A.
// - L6 write: the job it makes is confined like a delivery's; a refusal names no server path.
// - L7 licensee: no internal in any ssam_code answer, nor in the prompts a plan brings to the user's machine.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findings } from './fixtures/internal-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..', '..');
const kernel = path.join(repo, 'kernel');
const cliBuilt = fs.existsSync(path.join(kernel, '.local', 'cli', 'anvil.dll')) && fs.existsSync(path.join(kernel, '.local', 'lane-odc', 'cli', 'anvil-odc.dll'));
const skip = !cliBuilt && 'the lane CLIs are not built in this checkout';
// The Service Studio the server's O11 kernel and readers load headless (the image and the e2e set ANVIL_STUDIO_DIR).
const INSTALLED_STUDIO = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OutSystems', 'Service Studio 11', 'Service Studio');
if (!process.env.ANVIL_STUDIO_DIR && fs.existsSync(INSTALLED_STUDIO)) process.env.ANVIL_STUDIO_DIR = INSTALLED_STUDIO;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-ssam-code-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } });
// The server's own resident readers (ssam_map, the module digest) trust the owner's Anvil authority (hosted-e2e-processes:
// the owner's machine has it initialized); here a private one of this test process, never the user's.
const ownerAuthority = path.join(tmp, 'owner-authority');
fs.mkdirSync(ownerAuthority, { recursive: true });
fs.writeFileSync(path.join(ownerAuthority, 'bridge.key'), createHash('sha256').update(randomUUID()).digest('base64url'));
process.env.ANVIL_AUTHORITY_DIR = ownerAuthority;
// The readers of this run (as hosted-e2e-processes): their own folder, started with this run's authority and stopped at the end.
const readers = path.join(tmp, 'readers');
process.env.SSAM_READER_CACHE_ROOT = readers;
test.after(() => {
  const states = []; const walk = dir => { let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'worker.json') states.push(p); } };
  walk(readers);
  for (const file of states) { try { const pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid; if (Number.isInteger(pid)) process.kill(pid); } catch { /* gone */ } }
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

const { InMemoryTransport } = await import('@modelcontextprotocol/server');
const { Client } = await import('@modelcontextprotocol/client');
const { runWithExecutor, prepareWorkspace, hostedSpawnEnv } = await import('../executor.mjs');
const { o11Lane } = await import('../workspace.mjs');
const { createSsamServer } = await import('../ssam.mjs');
const policy = await import('../hosted/policy.mjs');
const { hostedTools, agentNeed, wrapHostedTool, serverRoots } = policy;
const code = await import('../hosted/code.mjs').catch(() => null);

// ---- a customer: its workspace on the server, its machine (the agent folder) and a fake executor with the mirror's two
// directions (pullFile from the agent folder, putMany to it), as the real AgentExecutor moves files.
class FakeExecutor {
  constructor(workspace, agentRoot, record = null) { this.id = 'fake-' + randomUUID(); this.hosted = true; this.workspace = workspace; this.agentRoot = agentRoot; this.record = record; this.calls = []; this.pulled = []; this.pushed = [];
    const self = this;
    this.mirror = { agentOf: rel => 'agent:' + rel,
      async putMany(entries) {
        for (const entry of entries) {
          assert.match(entry.target, /^agent:(?:o11\/|odc\/lab\/)/, 'a push goes where the agent may write: ' + entry.target);
          const dest = path.join(self.agentRoot, ...entry.target.slice(6).split('/'));
          fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(entry.source, dest);
          self.pushed.push(entry);
        }
        return entries.map(entry => ({ path: entry.target, sha256: sha(fs.readFileSync(entry.source)) }));
      } };
  }
  relayPort() { return 41997; }
  o11Connection() { return this.record; }
  async close() {}
  async call(kind) { this.calls.push(kind); if (kind === 'studio.processes') return { processes: [] }; throw Object.assign(new Error('unexpected ' + kind), { code: 'KIND_NOT_ALLOWED', executed: false }); }
  async pullFile(agentPath) {
    this.pulled.push(agentPath);
    const rel = agentPath.slice('agent:'.length).split('/');
    const source = path.join(this.agentRoot, ...rel), dest = path.join(this.workspace, ...rel);
    if (!fs.existsSync(source)) throw Object.assign(new Error('no file ' + agentPath), { code: 'FILE_NOT_FOUND' });
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(source, dest);
    return dest;
  }
}
const KERNEL = { odc: '1.7.28', odcBridge: 'v97', o11: '11.55.92' };
// studio:true: the customer's Service Studio is connected (the O11 record of the relay), for the calls that need the agent.
function customer(name, { agentRoot = true, studio = false } = {}) {
  const tokenId = 'tok_' + randomUUID().slice(0, 12);
  const workspace = path.join(fs.mkdtempSync(path.join(tmp, 'server-')), 'customers', tokenId);
  prepareWorkspace(workspace);
  const root = path.join(fs.mkdtempSync(path.join(tmp, 'machine-' + name + '-')), 'SSAM-Agent');
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  const record = studio ? { ok: true, lane: 'o11', anvilLane: o11Lane.lane, pid: 5150, startedUtc: '2026-10-18T10:00:00.0000000Z', studioVersion: '11.55.92', port: 41997,
    authorityDir: path.join(workspace, 'state', 'relay-authority'), connectedAt: '2026-10-18T10:00:05.000Z', hosted: true } : null;
  const executor = new FakeExecutor(workspace, root, record);
  const agent = { connected: () => true, protocolError() {},
    info: () => ({ connected: true, credential: true, agentVersion: '0.3.1', ...(agentRoot ? { agentRoot: root } : {}), kernel: KERNEL, compatible: { odc: { ok: true }, o11: { ok: true } } }) };
  return { id: randomUUID(), hosted: true, tokenId, customer: 'Customer ' + name, lanes: ['odc', 'o11'], workspace, agent, executor,
    o11: { lane: o11Lane.lane, ...(process.env.ANVIL_STUDIO_DIR ? { studioDir: process.env.ANVIL_STUDIO_DIR } : {}) }, close: async () => {}, machine: root };
}
const ws = (context, rel) => path.join(context.workspace, ...rel.split('/'));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
// The presenter of these sessions sees the server's code, home and data roots, not the temp folder the fake machines live
// in (on a real server they are other machines).
const presentation = context => ({ workspace: context.workspace, serverRoots: serverRoots({ tmp: '' }) });
async function session(context, { deps = {} } = {}) {
  const server = await runWithExecutor(context, () => createSsamServer({ hosted: { context, session: { agent: context.agent, lanes: context.lanes }, presentation: presentation(context) }, deps }));
  const client = new Client({ name: 'hosted-ssam-code', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const once = async (name, args) => { const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 900000 }); return r.structuredContent ?? JSON.parse(r.content[0].text); };
  const call = async (name, args) => {
    let body = await once(name, args);
    for (let i = 0; i < 600; i++) {
      const next = [body?.continuation, body?.next].find(c => c && typeof c === 'object' && c.arguments && Object.hasOwn(c.arguments, 'continueTask'));
      if (!next) break;
      await sleep(500); body = await once(next.tool, next.arguments);
    }
    return body;
  };
  return { server, call, close: async () => { await client.close(); await server.close(); } };
}
// The no-internals guard over an answer of this customer, its own machine's folder (the agent folder) taken as the user's.
// (the folder as written, and inside JSON text once or twice: a prompt holds the JSON of its check call)
const userForms = context => { const once = JSON.stringify(context.machine).slice(1, -1); return [JSON.stringify(once).slice(1, -1), once, context.machine]; };
const masked = (value, context) => { let text = JSON.stringify(value); for (const form of userForms(context).slice(0, 2)) text = text.split(form).join('<user folder>'); return text; };
const scan = (value, context) => findings(JSON.parse(masked(value, context)))
  .map(f => f.family + ' ' + f.at + ' ' + f.sample.replace(/\s+/g, ' ').slice(0, 140));
// The server's folders an answer must never name (the user's own folder taken out first, as in scan).
const serverPaths = (value, owner, ...others) => { const text = masked(value, owner).toLowerCase();
  return [repo, owner.workspace, ...others.map(c => c.workspace), tmp].filter(p => text.includes(JSON.stringify(p.toLowerCase()).slice(1, -1))); };

// The captures a read of the module would leave in the customer's workspace (the kernel's neutral fixtures).
const O11_FIXTURE = path.join(kernel, 'tests', 'fixtures', 'reactive-ui.oml');
const ODC_FIXTURE = path.join(kernel, 'tests', 'fixtures', 'odc', 'blank-crossdevice.oml');
function captures(context) {
  const o11 = ws(context, 'o11/snapshots/ReactiveUI-20261018100000-a1b2c3d4.oml');
  fs.mkdirSync(path.dirname(o11), { recursive: true }); fs.copyFileSync(O11_FIXTURE, o11);
  const digest = sha(fs.readFileSync(ODC_FIXTURE)).toUpperCase();
  const odc = ws(context, `odc/snapshots/SsamNeutralApp-${digest}.oml`);
  fs.mkdirSync(path.dirname(odc), { recursive: true }); fs.copyFileSync(ODC_FIXTURE, odc);
  put(odc + '.json', JSON.stringify({ module: 'SsamNeutralApp', capturedAt: '2026-10-18T10:00:00Z', sha256: digest }));
  return { o11, odc, o11Module: 'ReactiveUI', odcModule: 'SsamNeutralApp' };
}

// ------------------------------------------------------------------------------------------------------------------ L1
test('L1 ssam_code is a server tool of the hosted catalog: lane by argument, the agent by action, every file argument an input', () => {
  const entry = hostedTools().ssam_code;
  assert.equal(entry.class, 'server', JSON.stringify(entry));
  assert.equal(entry.lane, 'arg:odc');
  assert.deepEqual(entry.paths.in.slice().sort(), ['/also/*/basedOn/job', '/base', '/basedOn/job', '/files/*', '/module', '/producers/*', '/shared/*', '/stubs/*', '/target'].sort());
  assert.deepEqual(entry.paths.out, []);
  assert.equal(entry.cause, undefined, 'no cause: it is served');
  const need = args => agentNeed(entry.agent, args);
  assert.equal(need({ action: 'grammar' }), 'never');
  assert.equal(need({ action: 'check', module: 'M' }), 'never', 'a check runs on the server over a capture');
  assert.equal(need({ action: 'plan', module: 'M' }), 'always', 'a plan brings its prompts to the user\'s machine');
  assert.equal(need({ action: 'write', module: 'M' }), 'always');
  assert.equal(need({ action: 'read', target: 'Orders' }), 'always', 'a module name is captured through the agent');
  assert.equal(need({ action: 'read', module: 'Orders' }), 'always', 'read takes module as target');
  assert.equal(need({ action: 'read', target: 'ws:o11/snapshots/A.oml' }), 'never');
  assert.equal(need({ action: 'read', target: 'ws:o11/snapshots/A.oml', module: 'Orders' }), 'never', 'the target the read runs on');
  assert.equal(need({}), 'never');
});

// ------------------------------------------------------------------------------------------------------------------ L2
test('L2 the gate confines every path ssam_code reads to the customer\'s workspace; another customer\'s or the server\'s never reach it', async () => {
  const A = customer('a', { studio: true }), B = customer('b', { studio: true });
  const mine = put(ws(A, 'o11/snapshots/Mine-20261018100000-aaaaaaaa.oml'), 'capture of A');
  const minePart = put(ws(A, 'inbox/parts/a.flow'), 'server action AOnly\n  end\n');
  const theirs = put(ws(B, 'o11/snapshots/Theirs-20261018100000-bbbbbbbb.oml'), 'capture of B');
  const theirPart = put(ws(B, 'inbox/parts/b.flow'), 'server action BOnly\n  end\n');
  const serverFile = path.join(repo, 'kernel', 'tests', 'fixtures', 'blank-service.oml');
  const seen = [];
  const gated = wrapHostedTool('ssam_code', { inputSchema: {} }, async args => { seen.push(args); return { content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } }; },
    { context: A, link: A.agent, lanes: ['odc', 'o11'], presentation: presentation(A) });
  const refused = async (args, pointer) => {
    const before = seen.length;
    const value = (await gated(args, {})).structuredContent;
    assert.equal(value.code, 'PATH_OUTSIDE_WORKSPACE', pointer + ': ' + JSON.stringify(value).slice(0, 300));
    assert.equal(seen.length, before, pointer + ': the handler never ran');
    const sent = JSON.stringify(args).match(/"[A-Za-z]:\\\\[^"]+"/g) ?? [];
    let said = JSON.stringify(value); for (const s of sent) said = said.split(s.slice(1, -1)).join('<sent>');
    assert.deepEqual(serverPaths(JSON.parse(said), A, B), [], pointer + ': the refusal names nothing of B or the server but what the call sent');
  };
  for (const outside of [theirs, serverFile, 'C:\\Windows\\win.ini']) {
    await refused({ lane: 'o11', action: 'check', module: 'M', text: 'x', base: outside }, '/base');
    await refused({ lane: 'o11', action: 'read', part: 'ddl', target: outside }, '/target');
    await refused({ lane: 'o11', action: 'read', part: 'ddl', module: outside }, '/module');
  }
  for (const outside of [theirPart, path.join(repo, 'kernel', 'tests', 'jobs', 'x.flow')]) {
    await refused({ lane: 'o11', action: 'check', module: 'M', files: [minePart, outside] }, '/files/*');
    await refused({ lane: 'o11', action: 'check', module: 'M', files: [minePart], stubs: [outside] }, '/stubs/*');
    await refused({ lane: 'o11', action: 'plan', module: 'M', items: [{ kind: 'action', name: 'A', intent: 'x' }], shared: [outside] }, '/shared/*');
    await refused({ lane: 'o11', action: 'write', module: 'M', basedOn: { job: outside, sha256: 'a'.repeat(64) }, patch: [] }, '/basedOn/job');
    await refused({ lane: 'odc', action: 'check', module: 'M', element: 'S', also: [{ part: 'html', element: 'S', basedOn: { job: outside, sha256: 'a'.repeat(64) }, edits: [{ find: 'a', with: 'b' }] }] }, '/also/*/basedOn/job');
    await refused({ lane: 'o11', action: 'check', module: 'M', text: 'x', producers: { Lib: outside } }, '/producers/*');
  }
  // A's own files resolve to A's workspace; a module name and "published" are no paths.
  const value = (await gated({ lane: 'o11', action: 'check', module: 'M', base: 'ws:o11/snapshots/Mine-20261018100000-aaaaaaaa.oml', files: ['ws:inbox/parts/a.flow'], producers: { Lib: 'published' } }, {})).structuredContent;
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(seen.at(-1).base, mine); assert.deepEqual(seen.at(-1).files, [minePart]); assert.equal(seen.at(-1).producers.Lib, 'published'); assert.equal(seen.at(-1).module, 'M');
  // The paths inside the job the call makes: its ops (rewritten to the workspace), its .json op files and the job of basedOn.
  await refused({ lane: 'o11', action: 'write', module: 'M', ops: [{ op: 'html', file: theirPart, data: {} }] }, '/ops/0/file');
  await refused({ lane: 'o11', action: 'check', module: 'M', ops: [{ op: 'html', file: serverFile, data: {} }] }, '/ops/0/file (check)');
  put(ws(A, 'inbox/parts/ops.json'), JSON.stringify({ ops: [{ op: 'html', file: theirPart, data: {} }] }));
  await refused({ lane: 'o11', action: 'check', module: 'M', files: ['ws:inbox/parts/ops.json'] }, 'an op of a .json file');
  put(ws(A, 'o11/jobs/check/old/job.json'), JSON.stringify({ ops: [{ op: 'html', file: serverFile, data: { screen: 'S', edit: ['<div k="w1">x</div>'] } }] }));
  await refused({ lane: 'o11', action: 'check', module: 'M', element: 'S', basedOn: { job: 'ws:o11/jobs/check/old/job.json', sha256: 'a'.repeat(64) }, edits: [{ find: 'x', with: 'y' }] }, 'the job of basedOn');
  const inline = put(ws(A, 'inbox/parts/screen.html'), '<div>x</div>');
  const rewritten = (await gated({ lane: 'o11', action: 'write', module: 'M', ops: [{ op: 'html', file: 'ws:inbox/parts/screen.html', data: {} }] }, {})).structuredContent;
  assert.equal(rewritten.ok, true, JSON.stringify(rewritten));
  assert.equal(seen.at(-1).ops[0].file, inline, 'an inline op path is rewritten to the workspace file the kernel reads');
  // The prototype op, a pending generator and patch "verified": refused before anything runs, as in the job tools.
  const before = seen.length;
  const proto = (await gated({ lane: 'o11', action: 'check', module: 'M', ops: [{ op: 'prototype', data: { source: 'ws:inbox/p' } }] }, {})).structuredContent;
  assert.equal(proto.cause, 'PROTOTYPE_IMPORT_DISABLED', JSON.stringify(proto));
  const generator = (await gated({ lane: 'odc', action: 'write', module: 'M', ops: [{ op: 'rest-consume', data: { name: 'X', methods: [{ name: 'P', url: 'http://127.0.0.1:9/x' }] } }] }, {})).structuredContent;
  assert.equal(generator.cause, 'GENERATOR_PENDING', JSON.stringify(generator));
  const verified = (await gated({ lane: 'o11', action: 'write', module: 'M', basedOn: { job: 'ws:o11/jobs/check/old/job.json', sha256: 'a'.repeat(64) }, patch: 'verified' }, {})).structuredContent;
  assert.equal(verified.cause, 'VERIFIED_PATCH_LOCAL', JSON.stringify(verified));
  assert.equal(verified.continuation.tool, 'ssam_code', 'the same call with the explicit patch');
  assert.equal(seen.length, before);
  // A lane the token does not have.
  const oneLane = wrapHostedTool('ssam_code', { inputSchema: {} }, async () => { seen.push('ran'); return { content: [] }; }, { context: { ...A, lanes: ['o11'] }, link: A.agent, lanes: ['o11'] });
  assert.equal((await oneLane({ lane: 'odc', action: 'grammar' }, {})).structuredContent.code, 'HOSTED_LANE_DISABLED');
  assert.deepEqual(A.executor.calls, [], 'nothing reached the customer\'s machine');
  assert.deepEqual(B.executor.calls, []);
});

// ------------------------------------------------------------------------------------------------------------------ L3
test('L3 the hosted deps of ssam_code: the workspace\'s roots, the plan\'s places on both sides, the reads of this customer only', async () => {
  assert.ok(code, 'hosted/code.mjs exists');
  const A = customer('a'), B = customer('b');
  const deps = runWithExecutor(A, () => code.hostedCode(A));
  assert.deepEqual(deps.roots, { o11: ws(A, 'o11'), odc: ws(A, 'odc'), odcWork: ws(A, 'odc/lab') });
  const prompt = put(ws(A, 'o11/plans/0123456789abcdef/batch-1.prompt.md'), '# prompt');
  const batch = ws(A, 'o11/plans/0123456789abcdef/batch-1.flow');
  const odcPrompt = put(ws(A, 'odc/lab/plans/0123456789abcdef/batch-1.prompt.md'), '# prompt');
  assert.equal(deps.place.shown(ws(A, 'o11/snapshots/X.oml')), 'ws:o11/snapshots/X.oml');
  assert.equal(deps.place.shown(ws(A, 'inbox/shared/types.ddl')), 'ws:inbox/shared/types.ddl');
  assert.equal(deps.place.output(batch), path.win32.join(A.machine, 'inbox', 'o11', 'plans', '0123456789abcdef', 'batch-1.flow'));
  assert.equal(deps.place.input(prompt), path.win32.join(A.machine, 'o11', 'plans', '0123456789abcdef', 'batch-1.prompt.md'));
  await runWithExecutor(A, () => deps.place.publish([prompt, odcPrompt]));
  assert.deepEqual(A.executor.pushed.map(e => e.target), ['agent:o11/plans/0123456789abcdef/batch-1.prompt.md', 'agent:odc/lab/plans/0123456789abcdef/batch-1.prompt.md']);
  assert.ok(fs.existsSync(path.join(A.machine, 'o11', 'plans', '0123456789abcdef', 'batch-1.prompt.md')));
  // Without the folder of the agent (an older agent) the plan cannot name where its subagents read and write: one refusal.
  const old = customer('old', { agentRoot: false });
  const oldDeps = runWithExecutor(old, () => code.hostedCode(old));
  await assert.rejects(() => runWithExecutor(old, () => oldDeps.place.publish([put(ws(old, 'o11/plans/x/p.md'), 'p')])), error => error.code === 'AGENT_FOLDER_UNKNOWN');
  // SSAM's documentation in a prompt passes the licensee rule.
  const ruled = deps.place.document('rules', { items: [{ from: 'team', section: 'x', title: 'T', rule: 'see docs/CONHECIMENTO-DO-TIME.md and C:\\srv\\ssam\\kernel\\src\\Anvil.Core\\Kernel\\JobRunner.cs' }] });
  assert.deepEqual(findings(ruled), [], JSON.stringify(ruled));
  // The reads of this customer: a textSha A was served is A's to edit; B never gets A's read.
  const textSha = 'ab12cd34ef567890';
  runWithExecutor(A, () => deps.record('o11', { ok: true, action: { name: 'X', textSha }, entries: [{ name: 'Y', textSha: '0011223344556677' }] }));
  assert.ok(fs.existsSync(ws(A, 'state/code-readings/o11/' + textSha)));
  const asked = [];
  const loader = (lane, sha) => { asked.push(sha); return { textSha: sha, lane }; };
  assert.deepEqual(runWithExecutor(A, () => deps.readReading('o11', textSha, { load: loader })), { textSha, lane: 'o11' });
  assert.equal(runWithExecutor(A, () => deps.readReading('odc', textSha, { load: loader })), null, 'per lane');
  const bDeps = runWithExecutor(B, () => code.hostedCode(B));
  assert.equal(runWithExecutor(B, () => bDeps.readReading('o11', textSha, { load: loader })), null, 'B was never served A\'s read');
  assert.equal(runWithExecutor(A, () => deps.readReading('o11', '../../../x', { load: loader })), null, 'only a textSha');
  assert.deepEqual(asked, [textSha]);
});

// ------------------------------------------------------------------------------------------------------------------ L4
test('L4 hosted check and plan, both lanes: the customer\'s captures and folders only; the other customer sees none of them', { skip, timeout: 1800000 }, async () => {
  const A = customer('a', { studio: true }), B = customer('b', { studio: true });
  const own = captures(A);
  const a = await session(A), b = await session(B);
  // The module index of the code folder (the default of a kernel process without SSAM_MODULE_INDEX_ROOT) is never written.
  const codeIndex = path.join(repo, '.local', 'module-index');
  const listed = () => { const out = []; const walk = d => { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const x of e) { const p = path.join(d, x.name); if (x.isDirectory()) walk(p); else out.push(p + ':' + fs.statSync(p).mtimeMs); } }; walk(codeIndex); return out.sort(); };
  const indexBefore = listed();
  try {
    for (const [lane, module, text, capture] of [['o11', own.o11Module, 'create entity HostedCheck (\n  Id Long Integer identifier auto required,\n  Name Text(50)\n);\n', own.o11],
      ['odc', own.odcModule, 'create entity HostedCheck (\n  Id Long Integer identifier auto required,\n  Name Text(50)\n);\n', own.odc]]) {
      const checked = await a.call('ssam_code', { lane, action: 'check', module, part: 'ddl', text });
      assert.equal(checked.capture?.path, 'ws:' + path.relative(A.workspace, capture).replaceAll('\\', '/'), lane + ': ' + JSON.stringify(checked).slice(0, 600));
      assert.ok(['ok', 'CHECK_REFUSED'].includes(checked.ok ? 'ok' : checked.code), lane + ': ' + JSON.stringify(checked).slice(0, 600));
      const job = checked.job ?? checked.nextBasedOn?.job;
      assert.match(String(job), lane === 'o11' ? /^ws:o11\/jobs\/check\// : /^ws:odc\/lab\/jobs\/check\//, lane + ': the check job is in the workspace');
      assert.deepEqual(serverPaths(checked, A, B), [], lane);
      assert.deepEqual(scan(checked, A), [], lane);
      // B: no capture of the module; A's capture is no file of B's.
      const none = await b.call('ssam_code', { lane, action: 'check', module, part: 'ddl', text });
      assert.equal(none.code, 'CAPTURE_MISSING', lane + ': ' + JSON.stringify(none).slice(0, 400));
      assert.equal(none.continuation?.tool, 'ssam_map');
      const crossed = await b.call('ssam_code', { lane, action: 'check', module, part: 'ddl', text, base: capture });
      assert.equal(crossed.code, 'PATH_OUTSIDE_WORKSPACE', lane + ': ' + JSON.stringify(crossed).slice(0, 400));
      // A file of the workspace that is no capture is no base.
      put(ws(A, 'inbox/Any.oml'), 'any');
      const notCapture = await a.call('ssam_code', { lane, action: 'check', module, part: 'ddl', text, base: 'ws:inbox/Any.oml' });
      assert.equal(notCapture.code, 'INPUT_INVALID', lane + ': ' + JSON.stringify(notCapture).slice(0, 400));
      assert.match(JSON.stringify(notCapture.problems), /base must be a capture/);
      assert.deepEqual(serverPaths(notCapture, A, B), [], lane);

      // The plan: in A's workspace, its prompts brought to A's machine, every name as A sees it.
      const items = [{ kind: 'data', name: 'HostedShape', intent: 'type HostedShape = { Name: Text; }' },
        ...Array.from({ length: 6 }, (_, i) => ({ kind: 'action', name: `HostedAction${i}`, intent: `returns ${i}`, signature: `server action HostedAction${i}\n  out Result: Integer`, calls: i < 5 ? [`HostedAction${i + 1}`] : [] }))];
      const pushedBefore = A.executor.pushed.length;
      const plan = await a.call('ssam_code', { lane, action: 'plan', module, items, workers: 2 });
      assert.equal(plan.ok, true, lane + ': ' + JSON.stringify(plan).slice(0, 800));
      assert.match(plan.dir, lane === 'o11' ? /^ws:o11\/plans\/[0-9a-f]{16}$/ : /^ws:odc\/lab\/plans\/[0-9a-f]{16}$/);
      const folder = ws(A, plan.dir.slice(3));
      assert.ok(fs.existsSync(path.join(folder, 'plan.json')));
      // The answer is the launch (answer-size.mjs X1 may leave a batch's check and files to its prompt and plan.json); plan.json
      // on the user's machine holds every batch whole, as the session sees it.
      const onMachine = path.join(A.machine, ...plan.dir.slice(3).split('/'), 'plan.json');
      assert.ok(fs.existsSync(onMachine), 'plan.json is on the user\'s machine');
      const full = JSON.parse(fs.readFileSync(onMachine, 'utf8'));
      for (const batch of [plan.data, ...plan.batches]) assert.ok(batch.launchPrompt.toLowerCase().includes(A.machine.toLowerCase() + '\\'), 'the launch names the prompt on the user\'s machine: ' + batch.launchPrompt);
      for (const batch of [full.data, ...full.batches]) {
        assert.ok(batch.files.every(f => f.toLowerCase().startsWith(path.win32.join(A.machine, 'inbox').toLowerCase() + '\\')), JSON.stringify(batch.files));
        assert.ok(batch.promptFile.toLowerCase().startsWith(A.machine.toLowerCase() + '\\'), batch.promptFile);
        assert.ok(fs.existsSync(batch.promptFile), 'the prompt is on the user\'s machine: ' + batch.promptFile);
        const text = fs.readFileSync(batch.promptFile, 'utf8');
        assert.deepEqual(scan(text, A), [], lane + ' prompt ' + batch.id);
        assert.deepEqual(serverPaths(text, A, B), [], lane + ' prompt ' + batch.id);
        assert.equal(batch.check.arguments.base, checked.capture.path);
      }
      assert.ok(A.executor.pushed.length > pushedBefore, 'the plan brought its files to the user\'s machine');
      assert.deepEqual(scan(full, A), [], lane + ' plan.json on the user\'s machine');
      assert.deepEqual(serverPaths(full, A, B), [], lane + ' plan.json on the user\'s machine');
      assert.deepEqual(scan(plan, A), [], lane);
      assert.deepEqual(serverPaths(plan, A, B), [], lane);
      // A subagent writes its batch where the plan says (the agent inbox of A's machine) and runs the check it was given.
      const first = full.batches[0];
      for (const file of first.files) put(file, (file.endsWith('.flow') ? first.items : []).map(name => `server action ${name}\n  out Result: Integer\n  assign Result = 1\n  end\n`).join('\n'));
      put(full.data.files[0], 'type HostedShape = { Name: Text; }\n');
      const pulledBefore = A.executor.pulled.length;
      const batchCheck = await a.call(first.check.tool, first.check.arguments);
      assert.ok(A.executor.pulled.length > pulledBefore, 'the batch file came from the user\'s inbox');
      assert.ok(batchCheck.ok === true || batchCheck.code === 'CHECK_REFUSED', lane + ': ' + JSON.stringify(batchCheck).slice(0, 600));
      assert.deepEqual(scan(batchCheck, A), [], lane);
      // B plans the same module: no capture there, nothing of A's.
      const bPlan = await b.call('ssam_code', { lane, action: 'plan', module, items, workers: 2 });
      assert.equal(bPlan.code, 'CAPTURE_MISSING', JSON.stringify(bPlan).slice(0, 300));
      const bPlans = path.join(B.workspace, lane === 'o11' ? 'o11' : path.join('odc', 'lab'), 'plans');
      assert.equal(fs.existsSync(bPlans) && fs.readdirSync(bPlans).length > 0, false);
      const peek = await b.call('ssam_evidence', { file: path.join(folder, 'plan.json') });
      assert.equal(peek.code, 'PATH_OUTSIDE_WORKSPACE', JSON.stringify(peek).slice(0, 300));
    }
    assert.deepEqual(listed().filter(entry => !indexBefore.includes(entry)), [], 'nothing written in the module index of the code folder');
  } finally { await a.close(); await b.close(); }
});

// ------------------------------------------------------------------------------------------------------------------ L5
test('L5 hosted read: the customer\'s capture; the reads it was served are its own to edit, never the other customer\'s', { skip, timeout: 1800000 }, async () => {
  const A = customer('a', { studio: true }), B = customer('b', { studio: true });
  const own = captures(A);
  const a = await session(A), b = await session(B);
  try {
    // B holds a capture of the same content and reads it first: A's read is still answered by A's own capture (the registry
    // of captures by content is each customer's: never another customer's file, nor whether one has the same module).
    const theirs = captures(B);
    const theirTarget = 'ws:' + path.relative(B.workspace, theirs.o11).replaceAll('\\', '/');
    const first = await b.call('ssam_code', { lane: 'o11', action: 'read', part: 'ddl', target: theirTarget });
    assert.equal(first.ok, true, JSON.stringify(first).slice(0, 600));
    const target = 'ws:' + path.relative(A.workspace, own.o11).replaceAll('\\', '/');
    const ddl = await a.call('ssam_code', { lane: 'o11', action: 'read', part: 'ddl', target });
    assert.equal(ddl.ok, true, JSON.stringify(ddl).slice(0, 600));
    assert.equal(ddl.file, target, 'A\'s read is answered by A\'s capture: ' + JSON.stringify({ file: ddl.file, capture: ddl.capture }));
    assert.equal(ddl.capture?.reused, undefined, 'never reused from another customer');
    assert.deepEqual(scan(ddl, A), []); assert.deepEqual(serverPaths(ddl, A, B), []);
    const odcTarget = 'ws:' + path.relative(A.workspace, own.odc).replaceAll('\\', '/');
    const odc = await a.call('ssam_code', { lane: 'odc', action: 'read', part: 'logic', target: odcTarget });
    assert.notEqual(odc.ok, false, JSON.stringify(odc).slice(0, 600));
    assert.deepEqual(scan(odc, A), []); assert.deepEqual(serverPaths(odc, A, B), []);
    const list = await a.call('ssam_code', { lane: 'o11', action: 'read', part: 'logic', target, max: 8 });
    const names = (list.entries ?? []).map(entry => entry.name).filter(Boolean);
    assert.ok(names.length, 'the module has actions: ' + JSON.stringify(Object.keys(list)) + ' ' + JSON.stringify(list).slice(-600));
    let read = null;
    for (const name of names) { const one = await a.call('ssam_code', { lane: 'o11', action: 'read', part: 'logic', target, element: name }); if (one.action?.textSha) { read = one; break; } }
    assert.ok(read, 'an action read with its textSha');
    const textSha = read.action.textSha;
    assert.ok(fs.existsSync(ws(A, 'state/code-readings/o11/' + textSha)), 'A was served that read');
    // An edit of a line the read does not have: A's read expands (the refusal names A's own lines), B's does not exist.
    const edit = { lane: 'o11', action: 'write', module: own.o11Module, part: 'logic', element: read.action.name, basedOn: textSha, edits: [{ replace: '@n999', with: 'x' }] };
    const mine = await a.call('ssam_code', edit);
    assert.match(JSON.stringify(mine), /unknown id @n999/, 'A\'s read expands: ' + JSON.stringify(mine).slice(0, 400));
    assert.doesNotMatch(JSON.stringify(mine), /no read of this textSha is kept/);
    const bEdit = await b.call('ssam_code', edit);
    assert.match(JSON.stringify(bEdit), /no read of this textSha is kept/, 'B never edits A\'s read: ' + JSON.stringify(bEdit).slice(0, 400));
    assert.doesNotMatch(JSON.stringify(bEdit), /unknown id @n999/, 'nothing of A\'s read in B\'s answer');
    // B reads A's capture by its path: refused at the gate.
    const crossed = await b.call('ssam_code', { lane: 'o11', action: 'read', part: 'ddl', target: own.o11 });
    assert.equal(crossed.code, 'PATH_OUTSIDE_WORKSPACE');
  } finally { await a.close(); await b.close(); }
});

// ------------------------------------------------------------------------------------------------------------------ L6
test('L6 hosted write: the job ssam_code makes goes through the gated delivery of its lane; refusals name no server path', async () => {
  const A = customer('a'), B = customer('b');
  const a = await session(A);
  try {
    const theirs = put(ws(B, 'inbox/x.html'), '<div>x</div>');
    const outside = await a.call('ssam_code', { lane: 'odc', action: 'write', module: 'M', ops: [{ op: 'html', file: theirs, data: {} }], feature: 'f', owners: ['M'], changes: ['c'] });
    assert.equal(outside.code, 'PATH_OUTSIDE_WORKSPACE', JSON.stringify(outside).slice(0, 400));
    assert.deepEqual(A.executor.calls, [], 'refused before the customer\'s machine');
    // O11 without the customer's Service Studio: the gate's own refusal, as for o11_deliver, nothing sent.
    const ddlText = 'create entity HostedWrite (\n  Id Long Integer identifier auto required\n);\n';
    const noStudio = await a.call('ssam_code', { lane: 'o11', action: 'write', module: 'M', part: 'ddl', text: ddlText, authorize: 'test' });
    assert.equal(noStudio.code, 'O11_NOT_CONNECTED', JSON.stringify(noStudio).slice(0, 400));
    // ODC: the write reaches studio_deliver through its gate and the customer's executor (the delivery's capture of the open
    // module); the fake machine answers nothing, so one refusal comes back, with no server path and no internal.
    const written = await a.call('ssam_code', { lane: 'odc', action: 'write', module: 'M', part: 'ddl', text: ddlText });
    assert.equal(written.ok, false, JSON.stringify(written).slice(0, 400));
    assert.ok(A.executor.calls.length > 0, 'the delivery reached the customer\'s executor: ' + JSON.stringify(written).slice(0, 300));
    assert.deepEqual(serverPaths(written, A, B), [], JSON.stringify(written).slice(0, 400));
    assert.deepEqual(scan(written, A), []);
    // A refusal of the text itself, in the words of ssam_code, with no internal.
    const sql = await a.call('ssam_code', { lane: 'odc', action: 'write', module: 'M', part: 'ddl', text: 'CREATE TABLE X (Id INT PRIMARY KEY);' });
    assert.equal(sql.code, 'INPUT_INVALID', JSON.stringify(sql).slice(0, 300)); assert.equal(sql.continuation.tool, 'ssam_code');
    assert.deepEqual(scan(sql, A), []);
  } finally { await a.close(); }
});

// ------------------------------------------------------------------------------------------------------------------ L7
test('L7 licensee: the grammar of both lanes and the hosted instructions name no internal; the instructions say where subagent files go', async () => {
  const A = customer('a');
  const a = await session(A);
  try {
    for (const lane of ['o11', 'odc']) for (const part of [undefined, 'ddl', 'logic', 'html']) {
      const card = await a.call('ssam_code', { lane, action: 'grammar', ...(part ? { part } : {}) });
      assert.equal(card.ok, true, JSON.stringify(card).slice(0, 300));
      assert.deepEqual(scan(card, A), [], lane + ' ' + (part ?? 'all'));
    }
    assert.match(a.server.ssamInstructions, /mcp__ssam__ssam_code/);
    assert.doesNotMatch(a.server.ssamInstructions, /ssam_code is unavailable/);
    assert.match(a.server.ssamInstructions, /ssam_code/);
    assert.match(a.server.ssamInstructions, /inbox/);
  } finally { await a.close(); }
});

// ------------------------------------------------------------------------------------------------------------------ L8
// The kernel processes of a customer (check, delivery) keep the module index where the server's readers keep it, the server's
// SSAM_MODULE_INDEX_ROOT (shared by hashes; a job reads only the readings of its own base, M2): never the code folder, which
// is the C# store's default without it (in the Linux image, /app).
test('L8 a hosted kernel process keeps the module index in the server\'s index root, never the folder of the code', () => {
  const A = customer('a', { studio: true });
  const saved = process.env.SSAM_MODULE_INDEX_ROOT;
  const root = path.join(tmp, 'server-index');
  try {
    process.env.SSAM_MODULE_INDEX_ROOT = root;
    for (const lane of ['o11', 'odc']) assert.equal(runWithExecutor(A, () => hostedSpawnEnv(lane).env.SSAM_MODULE_INDEX_ROOT), root, lane);
    process.env.SSAM_MODULE_INDEX_ROOT = 'relative' + path.sep + 'index';
    for (const lane of ['o11', 'odc']) assert.equal(runWithExecutor(A, () => hostedSpawnEnv(lane).env.SSAM_MODULE_INDEX_ROOT), undefined, lane + ': only an absolute root');
  } finally { if (saved === undefined) delete process.env.SSAM_MODULE_INDEX_ROOT; else process.env.SSAM_MODULE_INDEX_ROOT = saved; }
});
