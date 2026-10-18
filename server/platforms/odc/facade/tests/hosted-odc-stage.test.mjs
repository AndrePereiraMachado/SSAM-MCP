// hosted/odc-stage.mjs through the AgentExecutor (docs/FASE2-AGENTE.md 4.5): what each ODC bridge command sends to the
// agent before and brings back after. The fake AgentLink plays the agent and the bridge on a temporary agent root.
import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AgentExecutor } from '../hosted/agent-executor.mjs';
import { MANIFEST_FIELDS } from '../hosted/odc-stage.mjs';
import { fakeAgentLink, hostedDirs, cleanupHostedDirs, agentPaths } from './fixtures/fake-agent-link.mjs';

test.after(cleanupHostedDirs);
const sha = text => createHash('sha256').update(text).digest('hex');
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file; };
// The reply as the agent sends it: the line and the key paths of the strings it rewrote (here every agent: string).
const reply = value => ({ line: JSON.stringify(value), paths: agentPaths(value) });
function setup(pipe) {
  const dirs = hostedDirs(os.tmpdir());
  const seen = [];
  const link = fakeAgentLink({ agentRoot: dirs.agentRoot, handlers: { 'odc.pipe': (params, l) => { seen.push(params.args); return pipe(params.args, l); } } });
  const executor = new AgentExecutor({ link, workspace: dirs.workspace, o11: {} });
  const call = args => executor.call('odc.pipe', { pid: 4120, version: 'v35', args });
  return { ...dirs, link, executor, call, seen };
}

test('snapshot brings the .oml and its .json and rewrites the reply to workspace paths', async () => {
  const hash = sha('model').toUpperCase();
  const h = setup((args, link) => {
    const file = 'agent:odc/snapshots/' + args[1] + '-' + hash + '.oml';
    link.writeAgent(file, 'model');
    link.writeAgent(file + '.json', JSON.stringify({ ok: true, module: args[1], sha256: hash, path: file }));
    return reply({ ok: true, module: args[1], sha256: hash, path: file, host: 'tenant.outsystems.dev' });
  });
  const value = JSON.parse((await h.call(['snapshot', 'Orders'])).line);
  const expected = path.join(h.workspace, 'odc', 'snapshots', 'Orders-' + hash + '.oml');
  assert.equal(value.path, expected);
  assert.equal(fs.readFileSync(expected, 'utf8'), 'model');
  assert.ok(fs.existsSync(expected + '.json'), 'the .json sibling came too');
  assert.deepEqual(h.seen, [['snapshot', 'Orders']]);
  // The same capture again: the server already has it with that sha256, so it is not fetched again.
  const omlGets = () => h.link.gets.filter(g => g.path.endsWith('.oml')).length;
  assert.equal(omlGets(), 1);
  await h.call(['snapshot', 'Orders']);
  assert.equal(omlGets(), 1, 'the same capture (same sha256) is not fetched twice');
});

function manifestFixture(workspace, link) {
  const lab = path.join(workspace, 'odc', 'lab', '01-feature');
  const base = write(path.join(workspace, 'odc', 'snapshots', 'Orders-BASE.oml'), 'base');
  write(base + '.json', '{"module":"Orders"}');
  link.writeAgent('agent:odc/snapshots/Orders-BASE.oml', 'base');
  const candidate = write(path.join(lab, 'candidate.oml'), 'candidate');
  const receipt = write(path.join(lab, 'builder-receipt.json'), '{"addedErrors":[]}');
  const manifestFile = path.join(lab, 'manifest.json');
  const manifest = { schema: 'odc3-manifest/1', feature: 'feature', module: 'Orders', moduleKey: 'k', tenant: 't.outsystems.dev', author: 'a@b.c',
    basePath: base, baseSha256: 'B', candidatePath: candidate, candidateSha256: 'C', owners: ['Orders'], evidenceDir: path.join(lab, 'evidence'),
    changes: ['x'], builderReceipt: receipt, smoke: false };
  write(manifestFile, JSON.stringify(manifest, null, 2));
  return { lab, base, candidate, receipt, manifestFile, manifest };
}

test('manifest commands send the rewritten manifest (only the five fields), base and candidate by sha256, and bring the evidence back after merge', async () => {
  let agentManifest = null;
  const h = setup((args, link) => {
    assert.equal(args[1], 'agent:odc/lab/01-feature/manifest.json');
    agentManifest = JSON.parse(link.readAgent(args[1]));
    link.writeAgent('agent:odc/lab/01-feature/evidence/merge-receipt.json', '{"merged":true}');
    return reply({ ok: true, outcome: 'merged', evidence: 'agent:odc/lab/01-feature/evidence', receipt: 'agent:odc/lab/01-feature/evidence/merge-receipt.json' });
  });
  const f = manifestFixture(h.workspace, h.link);
  const value = JSON.parse((await h.call(['merge', f.manifestFile])).line);
  for (const [key, original] of Object.entries(f.manifest)) {
    if (MANIFEST_FIELDS.includes(key)) assert.ok(agentManifest[key].startsWith(h.agentRoot), key + ' is a path under the agent root');
    else assert.deepEqual(agentManifest[key], original, key + ' untouched');
  }
  const put = p => h.link.puts.find(x => x.path === p);
  assert.equal(put('agent:odc/lab/01-feature/manifest.json').json, 'agent-paths');
  assert.equal(put('agent:odc/snapshots/Orders-BASE.oml').skipped, true, 'the base the agent captured is not sent again');
  assert.equal(put('agent:odc/lab/01-feature/candidate.oml').skipped, false);
  assert.ok(put('agent:odc/lab/01-feature/builder-receipt.json'));
  assert.equal(fs.readFileSync(path.join(f.lab, 'evidence', 'merge-receipt.json'), 'utf8'), '{"merged":true}', 'the evidence came back');
  assert.equal(value.evidence, path.join(f.lab, 'evidence'));
  assert.equal(value.receipt, path.join(f.lab, 'evidence', 'merge-receipt.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifestFile, 'utf8')), f.manifest, 'an unchanged manifest stays as the server wrote it');
});

test('authorize brings back the manifest the bridge changed, with workspace paths in the five fields', async () => {
  const h = setup((args, link) => {
    const m = JSON.parse(link.readAgent(args[1]));
    m.publishAuthorization = 'pode publicar [recorded]';
    link.writeAgent(args[1], JSON.stringify(m, null, 2));
    return reply({ ok: true, kind: 'publish' });
  });
  const f = manifestFixture(h.workspace, h.link);
  await h.call(['authorize', f.manifestFile, 'publish', 'pode', 'publicar']);
  const back = JSON.parse(fs.readFileSync(f.manifestFile, 'utf8'));
  assert.equal(back.publishAuthorization, 'pode publicar [recorded]');
  for (const field of MANIFEST_FIELDS) if (f.manifest[field]) assert.equal(back[field], f.manifest[field], field + ' is the workspace path again');
  assert.equal(h.link.gets.find(g => g.path.endsWith('manifest.json')).json, 'agent-paths');
});

test('open with a local OML, --records-file, portal-call and portal-session fetch send their file to the right agent folder', async () => {
  const h = setup(args => reply({ ok: true, args }));
  const inbox = write(path.join(h.workspace, 'inbox', 'Mine.oml'), 'mine');
  const records = write(path.join(h.workspace, 'odc', 'journal', 'data', 'requests', 'r-1.json'), '[{"Name":"x"}]');
  const call = write(path.join(h.workspace, 'odc', 'tmp', 'call-1.json'), '{"method":"GET"}');
  const fetch = write(path.join(h.workspace, 'odc', 'journal', 'portal', 'requests', 'fetch-1.json'), '{"path":"/x"}');
  await h.call(['open', 'Mine', inbox]);
  await h.call(['data-insert', 'Mine', 'Entity', '--records-file', records, '--authorize', 'pode inserir']);
  await h.call(['portal-call', call, '--tenant', 't.outsystems.dev']);
  await h.call(['portal-session', 'fetch', fetch, '--tenant', 't.outsystems.dev']);
  assert.deepEqual(h.seen, [
    ['open', 'Mine', 'agent:odc/journal/staging/' + sha('mine') + '.oml'],
    ['data-insert', 'Mine', 'Entity', '--records-file', 'agent:odc/journal/data/requests/r-1.json', '--authorize', 'pode inserir'],
    ['portal-call', 'agent:odc/journal/portal/requests/call-1.json', '--tenant', 't.outsystems.dev'],
    ['portal-session', 'fetch', 'agent:odc/journal/portal/requests/fetch-1.json', '--tenant', 't.outsystems.dev'],
  ]);
  assert.equal(h.link.readAgent('agent:odc/journal/staging/' + sha('mine') + '.oml'), 'mine');
  assert.equal(h.link.readAgent('agent:odc/journal/data/requests/r-1.json'), '[{"Name":"x"}]');
  assert.equal(h.link.readAgent('agent:odc/journal/portal/requests/call-1.json'), '{"method":"GET"}');
  assert.equal(h.link.readAgent('agent:odc/journal/portal/requests/fetch-1.json'), '{"path":"/x"}');
});

test('data --out and the reference-snapshot output come back; assets brings modules.json', async () => {
  const h = setup((args, link) => {
    if (args[0] === 'data') { const out = args[args.indexOf('--out') + 1]; link.writeAgent(out, '{"rows":[1]}'); return reply({ ok: true, out }); }
    if (args[0] === 'reference-snapshot') { const { output } = JSON.parse(args[1]); link.writeAgent(output, 'signature'); return reply({ ok: true, path: output }); }
    if (args[0] === 'assets') { link.writeAgent('agent:odc/snapshots/modules.json', '{"modules":[]}'); return reply({ ok: true, count: 0 }); }
    return reply({ ok: false });
  });
  const out = path.join(h.workspace, 'odc', 'lab', 'data', 'rows.json');
  const data = JSON.parse((await h.call(['data', 'M', 'E', '--out', out])).line);
  assert.equal(data.out, out);
  assert.equal(fs.readFileSync(out, 'utf8'), '{"rows":[1]}');
  const output = path.join(h.workspace, 'odc', 'lab', 'refs', 'Producer.avsig');
  await h.call(['reference-snapshot', JSON.stringify({ module: 'M', producer: 'Producer', output })]);
  assert.deepEqual(JSON.parse(h.seen[1][1]), { module: 'M', producer: 'Producer', output: 'agent:odc/lab/refs/Producer.avsig' });
  assert.equal(fs.readFileSync(output, 'utf8'), 'signature');
  await h.call(['assets', 't.outsystems.dev']);
  assert.equal(fs.readFileSync(path.join(h.workspace, 'odc', 'snapshots', 'modules.json'), 'utf8'), '{"modules":[]}');
});

test('data text that starts with agent: is data: only the paths the agent reports (and a capture path) are mapped', async () => {
  // A record value 'agent:smith' (a referrer column) that the agent did not rewrite: no violation, no channel close.
  const rows = { ok: true, rows: [['1', 'agent:smith'], ['2', 'agent:odc/notes']], note: 'agent:..\\..\\x' };
  let answer = { line: JSON.stringify(rows), paths: [] };
  const h = setup(() => answer);
  const data = await h.call(['data', 'Orders', 'Customer', '100', '0']);
  assert.deepEqual(JSON.parse(data.line), rows);
  assert.equal(data.paths, undefined, 'the key paths stay between the agent and the server');
  assert.deepEqual(h.link.protocolErrors, []);
  assert.equal(h.link.gets.length, 0, 'nothing brought for data text');
  // A write whose reply echoes such a value is a normal answer, not an uncertain one.
  const written = await h.call(['data-insert', 'Orders', 'Customer', '--authorize', 'pode inserir']);
  assert.deepEqual(JSON.parse(written.line), rows);
  // The agent reports a path that is not an agent: text, or a malformed key path: violation, channel closed.
  for (const paths of [[['rows', 0, 0]], [['rows', '0', 1]], [['missing']], 'rows', [[{}]]]) {
    answer = { line: JSON.stringify(rows), paths };
    await assert.rejects(h.call(['data', 'Orders', 'Customer', '100', '0']), e => e.code === 'AGENT_PROTOCOL_VIOLATION' && e.sent === true, JSON.stringify(paths));
  }
  assert.equal(h.link.protocolErrors.length, 5);
  // A snapshot or latest names the capture the server reads: it must be an agent: path even when not reported.
  for (const command of ['snapshot', 'latest']) {
    answer = { line: JSON.stringify({ ok: true, module: 'M', path: 'C:\\SSAM-Agent\\odc\\snapshots\\M.oml' }), paths: [] };
    await assert.rejects(h.call([command, 'M']), e => e.code === 'AGENT_PROTOCOL_VIOLATION' && e.sent === true, command);
  }
  answer = { line: JSON.stringify({ ok: true, module: 'M', path: 'agent:..\\..\\..\\.local\\server\\tokens.json' }), paths: [] };
  await assert.rejects(h.call(['snapshot', 'M']), e => e.code === 'AGENT_PROTOCOL_VIOLATION');
  assert.equal(h.link.gets.length, 0);
});

test('a path outside the workspace is PipeError PATH_OUTSIDE_WORKSPACE with sent:false, and the link is never called', async () => {
  const h = setup(() => reply({ ok: true }));
  const outside = path.join(os.tmpdir(), 'not-the-workspace', 'x.oml');
  await assert.rejects(h.call(['open', 'M', outside]), e => e.name === 'PipeError' && e.code === 'PATH_OUTSIDE_WORKSPACE' && e.sent === false);
  await assert.rejects(h.call(['merge', path.join(os.tmpdir(), 'm.json')]), e => e.code === 'PATH_OUTSIDE_WORKSPACE' && e.sent === false);
  await assert.rejects(h.call(['portal-call', path.join(h.workspace, 'state', 'x.json')]), e => e.code === 'PATH_OUTSIDE_WORKSPACE' && e.sent === false);
  assert.equal(h.link.calls.length, 0);
});
