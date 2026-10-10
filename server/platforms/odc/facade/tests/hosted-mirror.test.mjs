// hosted/mirror.mjs (docs/FASE2-AGENTE.md 4.5, 6.1, 6.2): fromAgent is the only door for an agent path, the mirror rule
// (inputs staged, outputs only in writable prefixes, server copies never replace a bridge receipt) and the quota.
// A fake AgentLink and temporary folders only: no hub, no agent, no Studio.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Mirror, MirrorError, fromAgent, agentSegments, createQuota, classify } from '../hosted/mirror.mjs';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const sha = text => createHash('sha256').update(text).digest('hex');
const setup = (options = {}) => {
  const dirs = hostedDirs(os.tmpdir());
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, ...options });
  const mirror = new Mirror({ workspace: dirs.workspace, link, ...(options.quota ? { quota: options.quota(dirs.workspace) } : {}) });
  return { ...dirs, link, mirror };
};
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
// The server secret a modified agent would aim at: <root>/.local/server/tokens.json, three levels above the workspace.
const sentinel = root => {
  const file = write(path.join(root, '.local', 'server', 'tokens.json'), '{"schema":"ssam-server-tokens/1","tokens":[]}');
  const before = { content: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs };
  return { file, untouched: () => fs.readFileSync(file, 'utf8') === before.content && fs.statSync(file).mtimeMs === before.mtimeMs };
};
const ESCAPE = 'agent:..\\..\\..\\.local\\server\\tokens.json';

test('fromAgent refuses every form outside odc/, o11/ and inbox/, calls protocolError, and creates or reads nothing', t => {
  const { workspace, root, link } = setup();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-outside-'));
  fs.symlinkSync(outsideDir, path.join(workspace, 'odc', 'escape'), 'junction');
  t.after(() => { fs.unlinkSync(path.join(workspace, 'odc', 'escape')); fs.rmSync(outsideDir, { recursive: true, force: true }); });
  const cases = [
    'agent:odc/../state/relay-authority/bridge.key', 'agent:odc/./x.oml', 'agent:/Windows/win.ini', 'agent:\\Windows\\win.ini',
    'agent:C:/Windows/win.ini', 'agent:C:\\x.oml', 'agent:\\\\server\\share\\x.oml', 'agent:odc/x.oml:stream', 'agent:odc/a\u0000b.oml',
    'agent:odc/CON', 'agent:odc/nul.txt', 'agent:odc/lpt1.json', 'agent:odc/x.', 'agent:odc/x ', 'agent:odc//x.oml', 'agent:',
    'agent:state/relay-authority/bridge.key', 'agent:.local/friction/x.json', 'agent:lab/x.oml', 'agent:ODC2/x', 'C:\\Users\\x.oml',
    'ws:odc/x.oml', ESCAPE, 'agent:odc/escape/stolen.txt',
    // Inside the visible area but not a folder the agent may name: the server's own files there.
    'agent:odc/tenants.json', 'agent:odc/Tenants.json', 'agent:odc/tmp/manifest-1.json', 'agent:odc/.local/jobs/x.json', 'agent:odc',
  ];
  for (const value of cases) {
    const before = link.protocolErrors.length;
    assert.throws(() => fromAgent(value, { workspace, link }), e => e instanceof MirrorError && e.code === 'AGENT_PROTOCOL_VIOLATION', value);
    assert.equal(link.protocolErrors.length, before + 1, 'protocolError for ' + JSON.stringify(value));
  }
  assert.deepEqual(fs.readdirSync(outsideDir), [], 'nothing created through the junction');
  assert.equal(fs.existsSync(path.join(root, '.local')), false);
  assert.equal(link.calls.length, 0, 'fromAgent never calls the agent');
  // The accepted forms, with either separator.
  assert.equal(fromAgent('agent:odc/snapshots/M-1.oml', { workspace, link }), path.join(workspace, 'odc', 'snapshots', 'M-1.oml'));
  assert.equal(fromAgent('agent:o11\\work\\c.oml', { workspace, link }), path.join(workspace, 'o11', 'work', 'c.oml'));
  assert.equal(fromAgent('agent:inbox/x.json', { workspace, link }), path.join(workspace, 'inbox', 'x.json'));
  assert.equal(fromAgent('agent:o11', { workspace, link }), path.join(workspace, 'o11'));
  assert.equal(fromAgent('agent:odc/snapshots', { workspace, link }), path.join(workspace, 'odc', 'snapshots'));
  assert.equal(agentSegments('agent:odc/a b.oml').rel, 'odc/a b.oml');
});

test('a reply that names agent:odc/tenants.json never replaces the tenants file the server keeps', async () => {
  const { workspace, agentRoot } = setup();
  const tenants = write(path.join(workspace, 'odc', 'tenants.json'), '{"default":null,"tenants":{}}');
  const link = fakeAgentLink({ agentRoot, handlers: { 'odc.pipe': () => ({ line: JSON.stringify({ ok: true, file: 'agent:odc/tenants.json' }), paths: [['file']] }) } });
  fs.mkdirSync(path.join(agentRoot, 'odc'), { recursive: true });
  link.writeAgent('agent:odc/tenants.json', '{"default":null,"tenants":{"h":{"policyFile":"..\\\\..\\\\x.json"}}}');
  const executor = new AgentExecutor({ link, workspace, o11: {} });
  await assert.rejects(executor.call('odc.pipe', { pid: 1, version: 'v35', args: ['status'] }), e => e.code === 'AGENT_PROTOCOL_VIOLATION' && e.sent === true);
  await assert.rejects(new Mirror({ workspace, link }).pull('agent:odc/tenants.json'), e => e.code === 'AGENT_PROTOCOL_VIOLATION');
  assert.equal(fs.readFileSync(tenants, 'utf8'), '{"default":null,"tenants":{}}');
  assert.equal(link.calls.filter(c => c.kind === 'file.get').length, 0, 'nothing was fetched');
});

test('agent:..\\..\\..\\.local\\server\\tokens.json in a reply, in a file.list entry or as a bring-back destination never touches the file', async () => {
  const { workspace, root, agentRoot } = setup();
  const secret = sentinel(root);
  const link = fakeAgentLink({ agentRoot, handlers: {
    'odc.pipe': () => ({ line: JSON.stringify({ ok: true, path: ESCAPE }) }),
    'file.list': () => ({ entries: [{ path: ESCAPE, size: 10, sha256: sha('x'), mtimeMs: 1 }], truncated: false }),
  } });
  const mirror = new Mirror({ workspace, link });
  const executor = new AgentExecutor({ link, workspace, o11: {} });
  await assert.rejects(executor.call('odc.pipe', { pid: 1, version: 'v35', args: ['snapshot', 'M'] }), e => e.code === 'AGENT_PROTOCOL_VIOLATION' && e.sent === true);
  await assert.rejects(mirror.pullDir('agent:odc/lab/01-x'), e => e.code === 'AGENT_PROTOCOL_VIOLATION');
  await assert.rejects(mirror.pull(ESCAPE), e => e.code === 'AGENT_PROTOCOL_VIOLATION');
  assert.ok(secret.untouched(), 'tokens.json unchanged');
  assert.equal(link.calls.filter(c => c.kind === 'file.get').length, 0, 'nothing was fetched');
  assert.equal(link.protocolErrors.length, 3);
});

test('an inbox input is copied to <lane>/journal/staging/<sha256><ext> before it goes to the agent; a writable one keeps its path', async () => {
  const { workspace, mirror, link } = setup();
  const content = 'oml bytes';
  const inbox = write(path.join(workspace, 'inbox', 'Delivered.oml'), content);
  write(inbox + '.json', '{"module":"Delivered"}');
  const target = await mirror.input(inbox, 'odc');
  assert.equal(target, 'agent:odc/journal/staging/' + sha(content) + '.oml');
  assert.equal(fs.readFileSync(path.join(workspace, 'odc', 'journal', 'staging', sha(content) + '.oml'), 'utf8'), content);
  assert.equal(link.readAgent(target), content);
  assert.equal(link.readAgent(target + '.json'), '{"module":"Delivered"}', 'the .json sibling travels with the .oml');
  const lab = write(path.join(workspace, 'odc', 'lab', '01-x', 'candidate.oml'), 'candidate');
  assert.equal(await mirror.input(lab, 'odc'), 'agent:odc/lab/01-x/candidate.oml');
  assert.equal(await mirror.input(lab, 'odc'), 'agent:odc/lab/01-x/candidate.oml');
  assert.deepEqual(link.puts.filter(p => p.path.endsWith('candidate.oml')).map(p => p.skipped), [false, true], 'by sha256: the second push is skipped');
  await assert.rejects(mirror.input(path.join(os.tmpdir(), 'elsewhere.oml'), 'odc'), e => e.code === 'PATH_OUTSIDE_WORKSPACE' && e.sent === false);
});

test('an output outside a writable prefix is PATH_NOT_STAGEABLE (sent:false) and the link is never called', async () => {
  const { workspace, mirror, link, agentRoot } = setup();
  assert.throws(() => mirror.output(path.join(workspace, 'inbox', 'out.json')), e => e.code === 'PATH_NOT_STAGEABLE' && e.sent === false);
  assert.throws(() => mirror.output(path.join(workspace, 'odc', 'tenants.json')), e => e.code === 'PATH_NOT_STAGEABLE');
  assert.throws(() => mirror.output(path.join(workspace, 'state', 'x.json')), e => e.code === 'PATH_OUTSIDE_WORKSPACE');
  assert.equal(mirror.output(path.join(workspace, 'odc', 'lab', 'r', 'P.avsig')), 'agent:odc/lab/r/P.avsig');
  assert.equal(mirror.output(path.join(workspace, 'o11', 'anything', 'x.oml')), 'agent:o11/anything/x.oml');
  assert.deepEqual(classify(workspace, path.join(workspace, 'odc', 'snapshots')), { visible: true, rel: 'odc/snapshots', writable: true });
  const executor = new AgentExecutor({ link, workspace, o11: {} });
  await assert.rejects(executor.call('odc.pipe', { pid: 1, version: 'v35', args: ['data', 'M', 'E', '--out', path.join(workspace, 'inbox', 'rows.json')] }),
    e => e.code === 'PATH_NOT_STAGEABLE' && e.sent === false);
  assert.equal(link.calls.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(agentRoot, 'inbox')), []);
});

test('the manifest folder sends only what the agent lacks: a receipt the bridge wrote there is never replaced', async () => {
  const { workspace, mirror, link } = setup();
  const dir = path.join(workspace, 'odc', 'lab', '03-feature');
  write(path.join(dir, 'evidence', 'merge-receipt.json'), '{"by":"server copy"}');
  write(path.join(dir, 'evidence', 'only-on-server.json'), '{"by":"server"}');
  link.writeAgent('agent:odc/lab/03-feature/evidence/merge-receipt.json', '{"by":"bridge"}');
  const pushed = await mirror.pushMissing(dir);
  assert.deepEqual(pushed.map(f => path.basename(f)), ['only-on-server.json']);
  assert.equal(link.readAgent('agent:odc/lab/03-feature/evidence/merge-receipt.json'), '{"by":"bridge"}');
  assert.equal(link.readAgent('agent:odc/lab/03-feature/evidence/only-on-server.json'), '{"by":"server"}');
  // And the bridge's version comes back to the server (agent -> server is what the bridge wrote).
  await mirror.pullDir('agent:odc/lab/03-feature');
  assert.equal(fs.readFileSync(path.join(dir, 'evidence', 'merge-receipt.json'), 'utf8'), '{"by":"bridge"}');
});

test('over the workspace quota a bring-back is WORKSPACE_FULL and nothing is written; the walk is cached and received bytes count', async () => {
  let clock = 0;
  const { workspace, mirror, link } = setup({ quota: workspace => createQuota(workspace, { limitBytes: 64, ttlMs: 60000, now: () => clock }) });
  write(path.join(workspace, 'odc', 'lab', 'big.bin'), 'x'.repeat(60));
  link.writeAgent('agent:odc/snapshots/M.oml', 'y'.repeat(10));
  await assert.rejects(mirror.pull('agent:odc/snapshots/M.oml'), e => e.code === 'WORKSPACE_FULL');
  assert.equal(fs.existsSync(path.join(workspace, 'odc', 'snapshots', 'M.oml')), false);
  const quota = createQuota(workspace, { limitBytes: 100, ttlMs: 60000, now: () => clock });
  assert.equal(quota.used(), 60);
  write(path.join(workspace, 'odc', 'lab', 'more.bin'), 'z'.repeat(30));
  assert.equal(quota.used(), 60, 'the walk is kept for 60 s');
  quota.add(30);
  assert.equal(quota.full(20), true, 'received bytes count before the next walk');
  clock = 60000;
  assert.equal(quota.used(), 90);
});

test('a file.get error keeps its code; a missing agent folder lists as empty', async () => {
  const { mirror, link } = setup();
  assert.deepEqual(await mirror.list('agent:odc/lab/none'), []);
  await assert.rejects(mirror.pull('agent:odc/snapshots/missing.oml'), e => e.code === 'FILE_NOT_FOUND');
  link.disconnect();
  await assert.rejects(mirror.pull('agent:odc/snapshots/missing.oml'), e => e.code === 'AGENT_NOT_CONNECTED' && e.executed === false);
});
