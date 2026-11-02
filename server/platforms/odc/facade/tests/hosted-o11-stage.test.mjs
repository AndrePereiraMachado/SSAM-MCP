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

// fase4-28 r4-f3-import (criterion C3): integration_import through an agent that declares it (hello agent.o11Methods). The base,
// the pinned document and its imports go to the agent (the document's folder kept under agent:o11/imports/<sha>/, so an xsd
// import resolves next to the WSDL), out_path is an agent:o11/ output, and the candidate the bridge wrote comes back to the
// workspace path the kernel reads. An agent without the method keeps INTEGRATION_IMPORT_NEEDS_BRIDGE: nothing is sent, and the
// import capabilities of its bridge never reach the kernel (which then refuses the job before the snapshot).
const IMPORT_AGENT = { agentVersion: '0.3.7', agentO11Methods: ['ping', 'bridge_manifest', 'snapshot_module', 'merge_from_oml', 'integration_import'] };
const importRequest = h => {
  const folder = path.join(h.workspace, 'o11', 'documents', 'aa'.repeat(32));
  const wsdl = write(path.join(folder, 'service.wsdl'), '<definitions/>');
  const xsd = write(path.join(folder, 'types', 'common.xsd'), '<schema/>');
  const base = write(path.join(h.workspace, 'o11', 'deliveries', 't1', 'base.oml'), 'base');
  return { kind: 'wsdl', module_key: 'k1', operation_id: 'op1', base_path: base, base_sha256: sha('base'), document_path: wsdl, document_sha256: 'aa'.repeat(32),
    dependencies: [{ uri: 'types/common.xsd', path: xsd, sha256: sha('<schema/>') }], client: 'Calc', source: 'https://example.com/calc?wsdl',
    selection: { port: 'CalculatorSoap', methods: ['Add'] }, out_path: path.join(h.workspace, 'o11', 'deliveries', 't1', 'import-0.oml') };
};

test('r4-f3: integration_import stages the base, the document and its imports, and brings the candidate back', async () => {
  const h = setup((request, link) => {
    link.writeAgent(request.params.out_path, 'candidate');
    return { success: true, data: { candidate_path: request.params.out_path, candidate_sha256: sha('candidate'), client: { name: 'Calc', created: true }, imported: ['Add'], skipped: [], warnings: [], errors: [] } };
  });
  h.link.setInfo(IMPORT_AGENT);
  const request = importRequest(h);
  const value = await h.call('integration_import', request);
  const sent = h.seen[0].params;
  const docs = 'agent:o11/imports/' + 'aa'.repeat(32);
  assert.equal(sent.base_path, 'agent:o11/deliveries/t1/base.oml');
  assert.equal(sent.document_path, docs + '/service.wsdl');
  assert.deepEqual(sent.dependencies, [{ uri: 'types/common.xsd', path: docs + '/types/common.xsd', sha256: sha('<schema/>') }]);
  assert.equal(sent.out_path, 'agent:o11/deliveries/t1/import-0.oml');
  assert.deepEqual(sent.selection, request.selection);
  assert.equal(h.link.readAgent(docs + '/service.wsdl'), '<definitions/>');
  assert.equal(h.link.readAgent(docs + '/types/common.xsd'), '<schema/>');
  assert.equal(value.reply.data.candidate_path, request.out_path);
  assert.equal(fs.readFileSync(request.out_path, 'utf8'), 'candidate');
  noSecrets(h);
});

test('r4-f3: an importer refusal (errors, no candidate) comes back as it is and nothing is pulled', async () => {
  const h = setup(() => ({ success: true, data: { code: 'SOAP_METHOD_NOT_FOUND', client: { name: 'Calc' }, imported: [], skipped: [], warnings: [], errors: ['the selected port has no operation \'Sub\''] } }));
  h.link.setInfo(IMPORT_AGENT);
  const request = importRequest(h);
  const value = await h.call('integration_import', request);
  assert.equal(value.reply.data.code, 'SOAP_METHOD_NOT_FOUND');
  assert.equal(fs.existsSync(request.out_path), false);
  assert.equal(h.link.gets.length, 0);
});

test('r4-f3: a document outside the workspace is refused before anything is sent', async () => {
  const h = setup(() => ({ success: true, data: {} }));
  h.link.setInfo(IMPORT_AGENT);
  const request = importRequest(h);
  request.document_path = path.join(os.tmpdir(), 'elsewhere', 'service.wsdl');
  await assert.rejects(h.call('integration_import', request), e => e.name === 'BridgeError' && e.code === 'PATH_OUTSIDE_WORKSPACE' && e.executed === false);
  assert.equal(h.seen.length, 0);
});

test('r4-f3: an agent that does not declare integration_import (0.4.0-native, every older agent) keeps INTEGRATION_IMPORT_NEEDS_BRIDGE', async () => {
  for (const info of [{}, { agentVersion: '0.4.0-native', agentO11Methods: null }, { agentVersion: '0.3.6', agentO11Methods: ['ping', 'bridge_manifest'] }]) {
    const h = setup(request => ({ success: true, data: request.method === 'bridge_manifest'
      ? { flavor: 'thin', capabilities: ['refresh_references', 'integration_import:wsdl', 'integration_import:openapi', 'thin'] } : {} }));
    h.link.setInfo(info);
    await assert.rejects(h.call('integration_import', importRequest(h)), e => e.name === 'BridgeError' && e.code === 'INTEGRATION_IMPORT_NEEDS_BRIDGE'
      && e.executed === false && /does not run the Service Studio integration import/.test(e.message) && /Install the current SSAM Agent app/.test(e.message));
    assert.equal(h.seen.length, 0, 'nothing sent');
    // Its bridge's manifest never shows the import to the kernel (Delivery.Offers then refuses the job before the snapshot).
    const manifest = await h.call('bridge_manifest', {});
    assert.deepEqual(manifest.reply.data.capabilities, ['refresh_references', 'thin']);
  }
  // The agent that declares it: the manifest is unchanged.
  const h = setup(() => ({ success: true, data: { capabilities: ['refresh_references', 'integration_import:wsdl', 'integration_import:openapi'] } }));
  h.link.setInfo(IMPORT_AGENT);
  assert.deepEqual((await h.call('bridge_manifest', {})).reply.data.capabilities, ['refresh_references', 'integration_import:wsdl', 'integration_import:openapi']);
});
