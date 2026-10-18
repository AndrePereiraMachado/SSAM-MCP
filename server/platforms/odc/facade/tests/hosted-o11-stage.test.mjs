// hosted/o11-stage.mjs through the AgentExecutor (docs/FASE2-AGENTE.md 4.6): the O11 bridge methods that carry files,
// the refused methods and parameters, and port/authorization never reaching the agent. Fake AgentLink only.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs, agentPaths } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const sha = text => createHash('sha256').update(text).digest('hex');
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
// reported(reply) -> the key paths the agent reports for it; by default every agent: string (as the agent rewrote them).
function setup(bridge, reported = agentPaths) {
  const dirs = hostedDirs(os.tmpdir());
  const seen = [];
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, handlers: { 'o11.bridge': (params, l) => {
    seen.push(params); const reply = bridge(params, l); return { reply, paths: reported(reply) };
  } } });
  const executor = new AgentExecutor({ link, workspace: dirs.workspace, o11: { studioDir: 'C:\\Kernel\\Service Studio', lane: 'ss4' } });
  // The caller's port and key (the relay port and a server key) must never travel.
  const call = (method, params) => executor.call('o11.bridge', { method, params, port: 4516, authorization: 'SERVER-CONTROLLER-KEY' });
  return { ...dirs, link, executor, call, seen };
}
const noSecrets = h => {
  for (const c of h.link.calls) {
    assert.equal(Object.hasOwn(c.params, 'port'), false, 'no port reaches the link');
    assert.equal(Object.hasOwn(c.params, 'authorization'), false, 'no authorization reaches the link');
    assert.ok(!JSON.stringify(c.params).includes('SERVER-CONTROLLER-KEY'));
  }
};

test('snapshot_module writes on the agent, comes back to the workspace path, and the reply is rewritten', async () => {
  const h = setup((request, link) => { link.writeAgent(request.params.path, 'o11 capture'); return { success: true, data: { path: request.params.path, key: 'k1', snapshot_id: 's1' } }; });
  const target = path.join(h.workspace, 'o11', 'snapshots', 'Orders.oml');
  const value = await h.call('snapshot_module', { path: target, module_key: 'k1' });
  assert.deepEqual(h.seen, [{ method: 'snapshot_module', params: { path: 'agent:o11/snapshots/Orders.oml', module_key: 'k1' } }]);
  assert.equal(value.reply.data.path, target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'o11 capture');
  noSecrets(h);
});

test('a snapshot_module data.path that is not agent: is a protocol violation and nothing is written', async () => {
  const h = setup(() => ({ success: true, data: { path: 'C:\\SSAM-Agent\\o11\\snapshots\\Orders.oml' } }));
  const target = path.join(h.workspace, 'o11', 'snapshots', 'Orders.oml');
  await assert.rejects(h.call('snapshot_module', { path: target }), e => e.name === 'BridgeError' && e.code === 'AGENT_PROTOCOL_VIOLATION' && e.executed === undefined);
  assert.equal(h.link.protocolErrors.length, 1);
  assert.equal(fs.existsSync(target), false);
  assert.equal(h.link.gets.length, 0);
});

test('merge_from_oml sends both files by sha256 and rewrites them', async () => {
  const h = setup(() => ({ success: true, data: { merged: true } }));
  const foreign = write(path.join(h.workspace, 'o11', 'work', 'candidate.oml'), 'candidate');
  const base = write(path.join(h.workspace, 'o11', 'snapshots', 'Orders.oml'), 'base');
  h.link.writeAgent('agent:o11/snapshots/Orders.oml', 'base');
  await h.call('merge_from_oml', { foreign_path: foreign, base_path: base, module_key: 'k1' });
  assert.deepEqual(h.seen[0].params, { foreign_path: 'agent:o11/work/candidate.oml', base_path: 'agent:o11/snapshots/Orders.oml', module_key: 'k1' });
  assert.equal(h.link.readAgent('agent:o11/work/candidate.oml'), 'candidate');
  assert.equal(h.link.puts.find(p => p.path === 'agent:o11/snapshots/Orders.oml').skipped, true, 'the base the agent captured is skipped');
  noSecrets(h);
});

test('merge_from_oml with the merge order also sends the first-pass copy and rewrites it', async () => {
  const h = setup(() => ({ success: true, data: { merged: true, undoSteps: 2 } }));
  const foreign = write(path.join(h.workspace, 'o11', 'work', 'candidate.oml'), 'candidate');
  const firstPass = write(path.join(h.workspace, 'o11', 'work', 'first-pass.oml'), 'first pass');
  const base = write(path.join(h.workspace, 'o11', 'snapshots', 'Orders.oml'), 'base');
  h.link.writeAgent('agent:o11/snapshots/Orders.oml', 'base');
  await h.call('merge_from_oml', { foreign_path: foreign, base_path: base, first_pass_path: firstPass, first_pass_sha256: 'cd'.repeat(32), module_key: 'k1' });
  assert.deepEqual(h.seen[0].params, { foreign_path: 'agent:o11/work/candidate.oml', base_path: 'agent:o11/snapshots/Orders.oml',
    first_pass_path: 'agent:o11/work/first-pass.oml', first_pass_sha256: 'cd'.repeat(32), module_key: 'k1' });
  assert.equal(h.link.readAgent('agent:o11/work/first-pass.oml'), 'first pass');
  noSecrets(h);
});

test('environment_session download: a workspace folder is rewritten and FilePath comes back; outputDirectory null uses agent:o11/downloads/<id>', async () => {
  const h = setup((request, link) => {
    const file = request.params.arguments.outputDirectory + '/Orders.oml';
    link.writeAgent(file, 'downloaded');
    return { success: true, data: { value: { Name: 'Orders', Status: 'ok', FilePath: file } } };
  });
  const dir = path.join(h.workspace, 'o11', 'tmp', 'download-1');
  const value = await h.call('environment_session', { operation: 'download', arguments: { module: 'Orders', outputDirectory: dir } });
  assert.equal(h.seen[0].params.arguments.outputDirectory, 'agent:o11/tmp/download-1');
  assert.equal(value.reply.data.value.FilePath, path.join(dir, 'Orders.oml'));
  assert.equal(fs.readFileSync(path.join(dir, 'Orders.oml'), 'utf8'), 'downloaded');
  const second = await h.call('environment_session', { operation: 'download', arguments: { module: 'Orders', outputDirectory: null } });
  const chosen = h.seen[1].params.arguments.outputDirectory;
  assert.match(chosen, /^agent:o11\/downloads\/[0-9a-f-]{36}$/);
  const file = path.join(h.workspace, ...chosen.slice(6).split('/'), 'Orders.oml');
  assert.equal(second.reply.data.value.FilePath, file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'downloaded');
});

test('sc_api PublishSolution: args.file is staged to agent:o11/journal/staging/<sha256>.osp and rewritten', async () => {
  const h = setup(() => ({ success: true, data: { result: { success: true } } }));
  const osp = write(path.join(h.workspace, 'inbox', 'Solution.osp'), 'osp bytes');
  await h.call('sc_api', { host: 'env.outsystemscloud.com', surface: 'soap', operation: 'PublishSolution', args: { file: osp, filename: 'Solution.osp' }, write: true });
  const staged = 'agent:o11/journal/staging/' + sha('osp bytes') + '.osp';
  assert.deepEqual(h.seen[0].params.args, { file: staged, filename: 'Solution.osp' });
  assert.equal(h.link.readAgent(staged), 'osp bytes');
  assert.ok(fs.existsSync(path.join(h.workspace, 'o11', 'journal', 'staging', sha('osp bytes') + '.osp')));
});

test('login, export_* and args.outFile are refused with executed:false before the agent', async () => {
  const h = setup(() => ({ success: true }));
  for (const method of ['login', 'export_modules', 'export_status'])
    await assert.rejects(h.call(method, {}), e => e.name === 'BridgeError' && e.code === 'METHOD_NOT_ALLOWED' && e.executed === false && e.method === method);
  for (const method of ['sc_api', 'sc_web'])
    await assert.rejects(h.call(method, { host: 'h', args: { outFile: path.join(h.workspace, 'o11', 'x.csv') } }), e => e.code === 'HOSTED_PATH_PARAM_REFUSED' && e.executed === false);
  assert.equal(h.link.calls.length, 0);
});

test('every agent: text of a reply becomes a workspace path; an escaping one is a violation', async () => {
  let answer = { success: true, data: { modules: [{ name: 'A', file: 'agent:o11/work/a.oml' }] } };
  const h = setup(() => answer);
  const value = await h.call('list_open_modules', {});
  assert.equal(value.reply.data.modules[0].file, path.join(h.workspace, 'o11', 'work', 'a.oml'));
  answer = { success: true, data: { file: 'agent:o11/../state/relay-authority/bridge.key' } };
  await assert.rejects(h.call('list_open_modules', {}), e => e.code === 'AGENT_PROTOCOL_VIOLATION');
  noSecrets(h);
});

test('reply text the agent did not rewrite stays data, even when it starts with agent:; required paths still must be agent:', async () => {
  let answer = { success: true, data: { records: [{ Name: 'agent:smith' }], modules: [{ file: 'agent:o11/work/a.oml' }] } };
  const h = setup(() => answer, reply => (reply.data?.modules ? [['data', 'modules', 0, 'file']] : []));
  const value = await h.call('sc_api', { host: 'env.outsystemscloud.com', surface: 'soap', operation: 'ListUsers', args: {} });
  assert.equal(value.reply.data.records[0].Name, 'agent:smith');
  assert.equal(value.reply.data.modules[0].file, path.join(h.workspace, 'o11', 'work', 'a.oml'));
  assert.equal(value.paths, undefined);
  assert.equal(answer.data.modules[0].file, 'agent:o11/work/a.oml', 'the reply of the link is not changed in place');
  assert.deepEqual(h.link.protocolErrors, []);
  // snapshot_module data.path is read by the server: a raw path is a violation even when the agent reports nothing.
  answer = { success: true, data: { path: 'agent:o11/../../tokens.json' } };
  await assert.rejects(h.call('snapshot_module', { path: path.join(h.workspace, 'o11', 'snapshots', 'X.oml') }), e => e.code === 'AGENT_PROTOCOL_VIOLATION');
  assert.equal(h.link.protocolErrors.length, 1);
});
