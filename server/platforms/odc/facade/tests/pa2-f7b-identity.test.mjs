import './fixtures/isolated-profile.mjs';
import { sessionText } from './fixtures/session-rules.mjs';
// Atritos 2, lane F7b, A09 and A10: the identity of the MCP server ({name, root, release, startedAt}, server-identity.mjs) is
// in every doctor answer; once the release under a running server changes, every tool answers RELEASE_CHANGED before any
// action (except ssam_doctor, ssam_evidence and the ssam_task read); the doctor answers WRONG_SERVER when the session's SSAM
// root is another folder and TOOL_CATALOG_STALE when catalog/tools.json changed. configure-mcp gives a development worktree
// its own server name. Real cases: 2026-10-06 11:08-11:35 (a process of the 10th release under the 11th: 9 discovers failed
// with "discovery descriptor does not match"), and the Cardapio agents that started on the `ssam` of another root.
// Fakes and temporary folders only: no Studio, no client configuration outside the sandbox.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import * as m_ssam from '../ssam.mjs';
import { workspaceRoot } from '../workspace.mjs';
process.env.SSAM_ODC_OFFLINE = '1'; // nothing here may touch an ODC Studio, a vault entry or a prompt

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..', '..');
const identityModule = () => import(pathToFileURL(path.join(here, '..', 'server-identity.mjs')).href);
const temp = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const identity = (over = {}) => ({ name: 'ssam', root: workspaceRoot, startedAt: '2026-10-06T11:08:00.000Z',
  release: { head: 'a'.repeat(40), catalogSha256: 'c'.repeat(64), cli: { path: 'C:\\k\\anvil.dll', mtimeMs: 1000, size: 10 }, ...over } });
const lanes = { o11: async () => ({ lane: 'o11', ok: true, studio: { open: true } }), odc: async () => ({ lane: 'odc', ok: true, studio: { open: true } }) };

async function serve(t, deps, clientOptions) {
  const server = await m_ssam.createSsamServer({ odc: false, deps });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa2-f7b-identity', version: '1' }, clientOptions);
  if (clientOptions?.roots) client.setRequestHandler('roots/list', async () => ({ roots: clientOptions.roots }));
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name, args) => { try { return await client.callTool({ name, arguments: args }); } catch (error) { return { isError: true, structuredContent: { ok: false, error: error.message } }; } };
  return { client, call };
}
function o11Deps(root, extra = {}) {
  return { cycle: { root, env: { USERPROFILE: root, LOCALAPPDATA: root }, runAnvil: async () => { throw new Error('the kernel must not run'); }, assertSelected: async () => {}, tasksDir: path.join(root, 'tasks') },
    lock: { o11Root: root, odcRoot: root, connection: () => null }, doctor: { lanes }, ...extra };
}

test('the release changed under the server: a write answers RELEASE_CHANGED before any action; doctor, evidence and the task read still answer', async t => {
  assert.equal(typeof m_ssam.RESTART_NEXT, 'string', 'the server identity of the atritos 2 package (A09/A10)'); // never a real doctor at the base
  const root = temp(t, 'pa2-f7b-rel-');
  let current = identity();
  let ran = 0;
  const jobTool = async () => { ran++; return { ok: true, job: 'x' }; };
  const evidence = path.join(root, '.local', 'probe.json'); fs.mkdirSync(path.dirname(evidence), { recursive: true }); fs.writeFileSync(evidence, '{"ok":true}');
  const { call } = await serve(t, o11Deps(root, { jobTool, identity: { started: identity(), read: () => current, cacheMs: 0, launchCwd: workspaceRoot }, evidence: { roots: [path.join(root, '.local')] } }));
  current = identity({ head: 'b'.repeat(40) }); // the setup checked out another commit under this process
  const job = await call('ssam_job', { job: { ops: [] } });
  assert.equal(job.structuredContent?.code, 'RELEASE_CHANGED', JSON.stringify(job.structuredContent));
  assert.equal(ran, 0, 'nothing ran');
  assert.equal(job.isError, true);
  assert.deepEqual(job.structuredContent.release.changed, ['head']);
  assert.match(job.structuredContent.next, /restart this MCP server \(Claude Code: \/mcp and reconnect; Codex: restart the session\)/);
  assert.deepEqual([job.structuredContent.continuation.tool, job.structuredContent.continuation.arguments], ['ssam_doctor', {}]);
  const close = await call('ssam_task', { id: 'f'.repeat(32), close: { reason: 'x' } });
  assert.equal(close.structuredContent?.code, 'RELEASE_CHANGED');
  const read = await call('ssam_task', {});
  assert.notEqual(read.structuredContent?.code, 'RELEASE_CHANGED');
  const ev = await call('ssam_evidence', { file: evidence });
  assert.notEqual(ev.structuredContent?.code, 'RELEASE_CHANGED', JSON.stringify(ev.structuredContent));
  const doctor = (await call('ssam_doctor', {})).structuredContent;
  assert.equal(doctor.code, 'RELEASE_CHANGED');
  assert.deepEqual([doctor.ok, doctor.server.root, doctor.server.release.head], [false, workspaceRoot, 'a'.repeat(40)]);
  assert.deepEqual(doctor.release.changed, ['head']);
  assert.ok(doctor.lanes.o11, 'the lanes stay in the answer');
});

test('the doctor always answers the server identity; same release and root: no refusal', async t => {
  assert.equal(typeof m_ssam.RESTART_NEXT, 'string', 'the server identity of the atritos 2 package (A09/A10)'); // never a real doctor at the base
  const root = temp(t, 'pa2-f7b-same-');
  const { call } = await serve(t, o11Deps(root, { identity: { started: identity(), read: () => identity(), cacheMs: 0, launchCwd: workspaceRoot } }));
  const doctor = (await call('ssam_doctor', {})).structuredContent;
  assert.equal(doctor.ok, true, JSON.stringify(doctor));
  assert.deepEqual(doctor.server, { name: 'ssam', root: workspaceRoot, release: identity().release, startedAt: '2026-10-06T11:08:00.000Z' });
  assert.equal(doctor.code, undefined);
});

test('the catalog changed on disk: the doctor answers TOOL_CATALOG_STALE, other tools RELEASE_CHANGED', async t => {
  assert.equal(typeof m_ssam.RESTART_NEXT, 'string', 'the server identity of the atritos 2 package (A09/A10)'); // never a real doctor at the base
  const root = temp(t, 'pa2-f7b-cat-');
  let current = identity();
  const { call } = await serve(t, o11Deps(root, { jobTool: async () => ({ ok: true }), identity: { started: identity(), read: () => current, cacheMs: 0, launchCwd: workspaceRoot } }));
  current = identity({ catalogSha256: 'd'.repeat(64) });
  const job = (await call('ssam_job', { job: { ops: [] } })).structuredContent;
  assert.equal(job.code, 'RELEASE_CHANGED'); assert.deepEqual(job.release.changed, ['catalog']);
  const doctor = (await call('ssam_doctor', {})).structuredContent;
  assert.equal(doctor.code, 'TOOL_CATALOG_STALE', JSON.stringify(doctor));
  assert.equal(doctor.ok, false);
  assert.match(doctor.next, /restart this MCP server/);
});

test('WRONG_SERVER: the session works in another SSAM root (the cwd the client launched the server with, or its MCP roots)', async t => {
  assert.equal(typeof m_ssam.RESTART_NEXT, 'string', 'the doctor of the atritos 2 package (A09)');
  const box = temp(t, 'pa2-f7b-wrong-');
  const other = path.join(box, 'SSAM-Hybrid-novo');
  fs.mkdirSync(path.join(other, 'platforms'), { recursive: true });
  fs.writeFileSync(path.join(other, '.ssam-workspace.json'), '{"schema":"ssam-workspace/1"}');
  const root = temp(t, 'pa2-f7b-wrong-root-');
  // Launch cwd inside the other root.
  const { call } = await serve(t, o11Deps(root, { identity: { started: identity(), read: () => identity(), cacheMs: 0, launchCwd: path.join(other, 'platforms') } }));
  const doctor = (await call('ssam_doctor', {})).structuredContent;
  assert.equal(doctor.code, 'WRONG_SERVER', JSON.stringify(doctor));
  assert.deepEqual([doctor.ok, doctor.session.root, doctor.session.from, doctor.server.root], [false, other, 'launch cwd', workspaceRoot]);
  assert.deepEqual([doctor.continuation.tool, doctor.continuation.arguments], ['ssam_doctor', {}]);
  // The client's MCP roots win over the launch cwd.
  const viaRoots = await serve(t, o11Deps(root, { identity: { started: identity(), read: () => identity(), cacheMs: 0, launchCwd: workspaceRoot } }),
    { capabilities: { roots: { listChanged: false } }, roots: [{ uri: pathToFileURL(other).href, name: 'novo' }] });
  const byRoots = (await viaRoots.call('ssam_doctor', {})).structuredContent;
  assert.deepEqual([byRoots.code, byRoots.session?.root, byRoots.session?.from], ['WRONG_SERVER', other, 'mcp roots'], JSON.stringify(byRoots));
  const { sessionRoot } = await identityModule();
  assert.equal(sessionRoot({ roots: [pathToFileURL(other).href], cwd: workspaceRoot }), other, 'roots first');
  // A client root inside this server's own root: no refusal.
  const same = await serve(t, o11Deps(root, { identity: { started: identity(), read: () => identity(), cacheMs: 0, launchCwd: other } }),
    { capabilities: { roots: { listChanged: false } }, roots: [{ uri: pathToFileURL(path.join(workspaceRoot, 'platforms')).href, name: 'here' }] });
  const fine = (await same.call('ssam_doctor', {})).structuredContent;
  assert.deepEqual([fine.ok, fine.code, fine.session?.from], [true, undefined, 'mcp roots'], JSON.stringify(fine));
});

test('server identity: the commit from the .git files (worktree pointer, loose ref, packed ref), the catalog hash and the CLI stamp', async t => {
  const { serverIdentity, gitHead, releaseChanged, sessionRoot, releaseWatch } = await identityModule();
  const box = temp(t, 'pa2-f7b-git-');
  const common = path.join(box, 'main', '.git');
  fs.mkdirSync(path.join(common, 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(common, 'worktrees', 'wt'), { recursive: true });
  fs.writeFileSync(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(common, 'refs', 'heads', 'main'), '1'.repeat(40) + '\n');
  fs.writeFileSync(path.join(common, 'packed-refs'), '# pack-refs with: peeled\n' + '2'.repeat(40) + ' refs/heads/feat\n');
  const wt = path.join(box, 'wt'); fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), 'gitdir: ' + path.join(common, 'worktrees', 'wt') + '\n');
  fs.writeFileSync(path.join(common, 'worktrees', 'wt', 'commondir'), '../..\n');
  fs.writeFileSync(path.join(common, 'worktrees', 'wt', 'HEAD'), 'ref: refs/heads/feat\n');
  assert.equal(gitHead(path.join(box, 'main')), '1'.repeat(40));
  assert.equal(gitHead(wt), '2'.repeat(40), 'a worktree reads its HEAD and the packed ref of the common folder');
  fs.writeFileSync(path.join(common, 'worktrees', 'wt', 'HEAD'), '3'.repeat(40) + '\n');
  assert.equal(gitHead(wt), '3'.repeat(40), 'a detached HEAD');
  assert.equal(gitHead(box), null);
  const catalog = path.join(box, 'tools.json'); fs.writeFileSync(catalog, '{"tools":{}}');
  const cli = path.join(box, 'anvil.dll'); fs.writeFileSync(cli, 'x');
  const started = serverIdentity({ root: path.join(box, 'main'), catalogFile: catalog, cliFile: cli, release: false });
  assert.deepEqual([started.name, started.root, started.release.head, typeof started.release.catalogSha256, started.release.cli.size], ['ssam', path.join(box, 'main'), '1'.repeat(40), 'string', 1]);
  assert.equal(releaseChanged(started, serverIdentity({ root: path.join(box, 'main'), catalogFile: catalog, cliFile: cli, release: false })), null);
  fs.writeFileSync(catalog, '{"tools":{"x":{}}}'); fs.writeFileSync(cli, 'xy');
  fs.writeFileSync(path.join(common, 'refs', 'heads', 'main'), '4'.repeat(40) + '\n');
  const changed = releaseChanged(started, serverIdentity({ root: path.join(box, 'main'), catalogFile: catalog, cliFile: cli, release: false }));
  // C11 (atritos 3): the CLI runs per call, so its change is only information; without facade sources (here, as in a
  // release bundle) the commit is the code and still counts.
  assert.deepEqual(changed.changed, ['head', 'catalog']);
  assert.deepEqual(changed.info, ['cli']);
  // A release bundle: release.json names the commit.
  assert.equal(serverIdentity({ root: box, release: true, manifest: { version: '2026.10.6', sourceCommit: '5'.repeat(40) }, catalogFile: catalog, cliFile: cli }).release.head, '5'.repeat(40));
  // The per-call check reads again only after its cache.
  let reads = 0; let clock = 0;
  const watch = releaseWatch({ started, read: () => { reads++; return started; }, cacheMs: 2000, now: () => clock });
  watch.check(); watch.check(); clock = 2500; watch.check();
  assert.equal(reads, 2);
  // The session root: the folder holding .ssam-workspace.json above the cwd; none above a folder outside any root.
  fs.writeFileSync(path.join(box, 'main', '.ssam-workspace.json'), '{}');
  fs.mkdirSync(path.join(box, 'main', 'a', 'b'), { recursive: true });
  assert.equal(sessionRoot({ cwd: path.join(box, 'main', 'a', 'b') }), path.join(box, 'main'));
  assert.equal(sessionRoot({ cwd: wt }), null);
});

test('configure-mcp: a development worktree registers ssam-dev-<folder> and never a server named ssam; the main checkout keeps ssam', async t => {
  const { writeMcpConfig, serverName } = await import(pathToFileURL(path.join(repo, 'scripts', 'configure-mcp.mjs')).href);
  const box = temp(t, 'pa2-f7b-mcp-');
  const worktree = path.join(box, 'Pa2 F7b'); fs.mkdirSync(path.join(worktree, 'platforms', 'odc'), { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: C:/somewhere/.git/worktrees/pa2\n');
  // The checked-in .mcp.json names `ssam` for another root: a worktree drops it.
  fs.writeFileSync(path.join(worktree, '.mcp.json'), JSON.stringify({ mcpServers: { ssam: { command: 'node', args: ['C:\\Users\\x\\SSAM-Hybrid\\facade\\ssam.mjs', 'mcp'] }, keep: { command: 'x' } } }));
  const layout = { kernel: 'kernel', odc: 'platforms/odc', o11Lane: 'ss4' };
  const result = writeMcpConfig({ root: worktree, layout, execPath: 'node.exe', env: {} });
  assert.deepEqual([result.name, result.dev], ['ssam-dev-pa2-f7b', true]);
  for (const file of result.files) {
    const servers = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers;
    assert.equal(servers.ssam, undefined, file);
    assert.deepEqual(servers['ssam-dev-pa2-f7b'].args, [path.join(worktree, 'facade', 'ssam.mjs'), 'mcp']);
  }
  assert.ok(JSON.parse(fs.readFileSync(path.join(worktree, '.mcp.json'), 'utf8')).mcpServers.keep, 'other servers stay');
  const main = path.join(box, 'main'); fs.mkdirSync(path.join(main, '.git'), { recursive: true }); fs.mkdirSync(path.join(main, 'platforms', 'odc'), { recursive: true });
  assert.equal(serverName(main), 'ssam');
  const mainResult = writeMcpConfig({ root: main, layout, execPath: 'node.exe', env: {} });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(mainResult.files[0], 'utf8')).mcpServers), ['ssam']);
  assert.deepEqual(result.files.concat(mainResult.files).filter(f => !f.startsWith(box)), [], 'writes only inside the checkout');
  assert.doesNotMatch(fs.readFileSync(path.join(repo, 'scripts', 'configure-mcp.mjs'), 'utf8'), /\.codex/, 'never reads or writes a client configuration outside the checkout');
});

test('the instructions and AGENTS.md no longer fix the mcp__ssam__ prefix to a server named "ssam"', async t => {
  const server = await m_ssam.createSsamServer({ o11: false, odc: false });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'pa2-f7b-instructions', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  t.after(async () => { await client.close(); await server.close(); });
  const instructions = sessionText(client);
  assert.doesNotMatch(instructions, /registered as "ssam"/);
  assert.match(instructions, /replace ssam with your server prefix/);
  assert.match(instructions, /writes to one Studio queue.*STUDIO_WRITE_QUEUE_TIMEOUT only follows a bounded wait/);
  const agents = fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8');
  assert.match(agents, /servidor MCP desta pasta \(`ssam_doctor` mostra a raiz dele\)/);
  assert.doesNotMatch(agents, /ToolSearch|select:/);
  assert.doesNotMatch(agents, /servidor MCP `ssam`\.|MCP server `ssam`\.|`ssam` MCP server\./);
});
