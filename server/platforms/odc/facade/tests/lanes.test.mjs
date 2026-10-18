import './fixtures/isolated-profile.mjs';
import { sessionText } from './fixtures/session-rules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { command, LANES, laneNames, verbs, anvilDataCli, o11Capture, jobRequest, run } from '../lanes.mjs';
import { fakeAnvil } from './fixtures/fake-anvil.mjs';
import { createSsamServer, producerArgs } from '../ssam.mjs';
import { accessArguments } from '../o11-access.mjs';
import { resolveO11Lane, o11Lane, O11_LANES } from '../workspace.mjs';

// One rule for the O11 lane, shared by the launcher, the lane table, discovery and the readers: an explicit
// ANVIL_LANE wins, otherwise the workspace's o11Lane; nothing defaults a lane on its own, and an unknown or absent
// lane is refused by name instead of binding a Studio the target was not built for.
test('the O11 lane is resolved once: explicit ANVIL_LANE, else the workspace o11Lane, never a silent default', () => {
  assert.deepEqual(O11_LANES, ['ss4', 'ss5']);
  assert.deepEqual(resolveO11Lane({ ANVIL_LANE: 'SS5' }, { o11Lane: 'ss4' }), { lane: 'ss5', source: 'env:ANVIL_LANE', configured: 'ss4', explicit: 'ss5' });
  assert.deepEqual(resolveO11Lane({}, { o11Lane: 'ss4' }), { lane: 'ss4', source: 'workspace:o11Lane', configured: 'ss4', explicit: null });
  assert.deepEqual(resolveO11Lane({ ANVIL_LANE: '  ' }, { o11Lane: 'ss4' }).source, 'workspace:o11Lane');
  assert.throws(() => resolveO11Lane({}, {}), /No O11 lane: set ANVIL_LANE \(ss4\|ss5\) or `o11Lane` in \.ssam-workspace\.json; nothing is assumed/);
  assert.throws(() => resolveO11Lane({ ANVIL_LANE: 'ss6' }, { o11Lane: 'ss4' }), /Unknown O11 lane 'ss6' \(ANVIL_LANE\)/);
  assert.throws(() => resolveO11Lane({}, { o11Lane: 'prod' }), /Unknown O11 lane 'prod' \(\.ssam-workspace\.json o11Lane\)/);
  // The lane table and the resolved lane agree, and the table says where the lane came from.
  assert.equal(LANES.o11.lane, o11Lane.lane); assert.equal(LANES.o11.laneSource, o11Lane.source);
  assert.match(LANES.o11.cli, o11Lane.lane === 'ss5' ? /lane-ss5[\\/]cli[\\/]anvil\.dll$|anvil\.dll$/ : /anvil\.dll$/);
});

// Manage Dependencies inputs of o11_job/ssam_job: bindings and read-only captures become the job flags.
test('job tools turn producer bindings and captures into job flags, refusing ambiguous input', () => {
  const avsig = path.resolve('HMISPdfText.avsig');
  assert.deepEqual(producerArgs({ HMISPdfText: avsig }, ['System=(System)', 'AgentOps_Core_CS']),
    ['--producer', 'HMISPdfText=' + avsig, '--capture-producer', 'System=(System)', '--capture-producer', 'AgentOps_Core_CS']);
  assert.deepEqual(producerArgs(undefined, undefined), []);
  assert.throws(() => producerArgs({ HMISPdfText: 'relative.avsig' }), /absolute path/);
  // fix/system-reference round 2 (H1): "Sys tem" is a producer name bound by its letters and digits (System); a name with
  // / or \ is no binding name.
  assert.deepEqual(producerArgs({ 'Sys tem': avsig }), ['--producer', 'System=' + avsig]);
  // Round 3 (H1-R): "a/b" takes the slot of its letters (ab); a name with no letter or digit is no binding name.
  // fix/a5-lows (B10, declared change): only for a job that writes exactly "a/b"; without the job's names it is refused.
  assert.deepEqual(producerArgs({ 'a/b': avsig }, [], { names: ['a/b'] }), ['--producer', 'ab=' + avsig]);
  assert.throws(() => producerArgs({ 'a/b': avsig }), /no job was given to match it against/);
  assert.throws(() => producerArgs({ '-': avsig }), /binding name/);
  // fix/system-reference: the Studio form (System) is the binding System, never an invalid name.
  assert.deepEqual(producerArgs({ '(System)': avsig }), ['--producer', 'System=' + avsig]);
  assert.throws(() => producerArgs({}, ['System=']), /captureProducers entry/);
  assert.throws(() => producerArgs({ HMISPdfText: avsig }, ['HMISPdfText']), /both bound and captured/);
});

// Every verb of the lane table becomes one command line per lane, built and never executed.
test('each verb builds the lane command line, without running anything', () => {
  assert.deepEqual(laneNames, ['o11', 'odc']);
  assert.deepEqual(verbs, ['doctor', 'inspect', 'map', 'deliver', 'data', 'publish', 'job', 'create-app', 'add-modules', 'inventory', 'download', 'dependencies', 'signature', 'referenceable', 'service-center', 'access']);
  // The module map is answered by ssam itself for both lanes (module-map.mjs), never delegated to a CLI.
  for (const lane of laneNames) assert.equal(command(lane, 'map', []).facade, true);

  const odcCli = path.join(LANES.odc.root, 'facade', 'odc.mjs');
  assert.equal(command('odc', 'inspect', []).exe, process.execPath);
  assert.deepEqual(command('odc', 'inspect', ['WrightFlood', '--depth', '4']).argv, [odcCli, 'inspect', 'WrightFlood', '--depth', '4']);
  assert.deepEqual(command('odc', 'deliver', ['pin-banner']).argv, [odcCli, 'deliver', 'pin-banner']);
  // Jobs of both lanes run in this process (job-runner.mjs), in the Anvil root: a request, never a python line.
  const odcJob = command('odc', 'job', ['tests/jobs-odc/data-entity.json']);
  assert.deepEqual(odcJob.request, { lane: 'odc', job: 'tests/jobs-odc/data-entity.json', producers: [], captureProducers: [] });
  assert.deepEqual([odcJob.available, odcJob.runner, odcJob.root, odcJob.exe, odcJob.argv], [true, 'job-runner.mjs', LANES.o11.root, undefined, undefined]);
  assert.doesNotMatch(odcJob.line, /python|run_job/);
  assert.deepEqual(command('odc', 'data', ['WrightFlood', 'Carrier']).argv, [odcCli, 'studio', 'data', 'WrightFlood', 'Carrier']);
  assert.deepEqual(command('odc', 'publish', ['manifest.json', '--wait']).argv, [odcCli, 'studio', 'publish', 'manifest.json', '--wait']);

  const o11 = command('o11', 'deliver', ['--module', 'Headless_UI']);
  assert.equal(o11.exe, 'dotnet');
  assert.deepEqual(o11.argv, [LANES.o11.cli, 'deliver', '--module', 'Headless_UI']);
  assert.match(LANES.o11.cli, /anvil\.dll$/);
  assert.deepEqual(command('o11', 'inspect', ['X']).argv, [LANES.o11.cli, 'inspect', 'X']);
  const job = command('o11', 'job', ['tests/jobs/spec-data.json']);
  assert.deepEqual(job.request, { lane: 'o11', job: 'tests/jobs/spec-data.json', producers: [], captureProducers: [] });
  assert.equal(job.runner, 'job-runner.mjs'); assert.equal(job.line, 'job-runner o11 tests/jobs/spec-data.json');
  // No lane verb spawns Python: the Service Center runs in this process (service-center/index.mjs).
  const sc = command('o11', 'service-center', ['status']);
  assert.equal(sc.runner, 'service-center/index.mjs'); assert.equal(sc.exe, undefined); assert.doesNotMatch(sc.line, /python|\.py\b/);

  // Data delegates to the headless native adapter; publication keeps its existing policy.
  for (const lane of laneNames) assert.equal(command(lane, 'doctor', []).facade, true);
  // A verb the Anvil CLI does not have refuses by naming where that work goes in O11, never just "not available".
  assert.deepEqual(command('o11', 'data', ['--request', 'seed.json']).argv, [anvilDataCli(), 'data', '--request', 'seed.json']);
  assert.match(command('o11', 'publish', []).reason, /the MCP tool o11_publish \{module, authorize\}/);
  for (const verb of ['publish']) {
    assert.equal(command('o11', verb, []).available, false);
    assert.equal(command('o11', verb, []).checkedIn, 'src\\Anvil.Cli\\Program.cs');
  }
  // Environment operations go to the O11 CLI as they are; without --credentials it uses the Studio login (SSO).
  assert.deepEqual(command('o11', 'create-app', ['--name', 'Demo App', '--modules', 'Demo_CS:Service']).argv,
    [LANES.o11.cli, 'create-app', '--name', 'Demo App', '--modules', 'Demo_CS:Service']);
  for (const verb of ['add-modules', 'inventory', 'download']) assert.deepEqual(command('o11', verb, []).argv, [LANES.o11.cli, verb]);
  // ODC has its own creation and listing paths; the facade names them instead of inventing a verb.
  assert.match(command('odc', 'create-app', []).reason, /studio_create_app/);
  assert.match(command('odc', 'inventory', []).reason, /odc studio assets/);
  assert.throws(() => command('o11', 'merge', []), /Unknown verb merge/);
  assert.throws(() => command('ss4', 'inspect', []), /Unknown lane ss4/);
});

// ssam job: the run_job.py arguments become one job-runner request; run() answers the runner's JSON, no Python.
test('job arguments become a job-runner request and run() answers its JSON summary without spawning Python', async t => {
  assert.deepEqual(jobRequest('o11', ['x.json', '--base', 'b.oml', '--out=o.oml', '--producer', 'P=p.oml', '--producer=Q=q.oml',
    '--capture-producer', 'System=(System)', '--quiet']),
  { lane: 'o11', job: 'x.json', base: 'b.oml', out: 'o.oml', producers: ['P=p.oml', 'Q=q.oml'], captureProducers: ['System=(System)'], quiet: true });
  assert.equal(jobRequest('o11', ['x.json', '--lane', 'odc']).lane, 'odc', 'a --lane among the arguments wins, as run_job.py --lane did');
  assert.throws(() => jobRequest('o11', []), /takes one job/);
  assert.throws(() => jobRequest('o11', ['a.json', 'b.json']), /takes one job/);
  assert.throws(() => jobRequest('o11', ['a.json', '--nope']), /Unknown job argument --nope/);
  assert.throws(() => jobRequest('o11', ['a.json', '--base']), /--base needs a value/);
  assert.throws(() => jobRequest('o11', ['a.json', '--lane', 'ss4']), /Unknown lane ss4/);
  assert.match(command('o11', 'job', ['a.json', '--nope']).error, /Unknown job argument/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-lanes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'tests', 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests', 'jobs', 'x.json'), '{"ops":[]}');
  const env = { USERPROFILE: root, HOME: root, APPDATA: root, LOCALAPPDATA: root, ANVIL_AUTHORITY_DIR: root, ANVIL_WORKER: '0', ANVIL_ODC_NO_WORKER: '1' };
  const runAnvil = fakeAnvil({ apply: () => ({ ok: true, command: 'apply', elapsedMs: 1, data: { accepted: true, isValid: true, ops: 0, objects: 1, messages: 0, applyMs: 1 } }) });
  const reply = await run('o11', 'job', ['tests/jobs/x.json', '--producer', 'P=p.oml'], { jobDeps: { root, env, o11Lane: 'ss4', runAnvil } });
  assert.deepEqual([reply.ok, reply.lane, reply.verb, reply.line, reply.via], [true, 'o11', 'job', 'job-runner o11 tests/jobs/x.json --producer P=p.oml', 'process']);
  assert.deepEqual(runAnvil.calls[0].args.slice(-2), ['--producer', 'P=' + path.join(root, 'p.oml')]);
  assert.ok(fs.existsSync(reply.resultFile));
  const bad = await run('odc', 'job', ['x.json', 'y.json'], { jobDeps: { root, env, runAnvil } });
  assert.deepEqual([bad.ok, bad.code, bad.verb], [false, 'invalid-arguments', 'job']);
});

// ssam access: the O11 CLI verb as it is; the printed line never repeats the user's words; ODC names where that work goes.
test('access goes to the O11 CLI, hides the words in the printed line and checks the MCP arguments first', () => {
  const manifest = path.join(LANES.o11.root, 'tests', 'access', 'hmisjha-demo-roles.json');
  assert.deepEqual(command('o11', 'access', ['plan', '--manifest', manifest]).argv, [LANES.o11.cli, 'access', 'plan', '--manifest', manifest]);
  const apply = command('o11', 'access', ['apply', '--manifest', manifest, '--words', 'yes, grant the six demo roles']);
  assert.deepEqual(apply.argv.slice(-2), ['--words', 'yes, grant the six demo roles']);
  assert.doesNotMatch(apply.line, /grant the six demo roles/);
  assert.match(apply.line, /--words <words>/);
  assert.equal(command('odc', 'access', []).available, false);
  assert.match(command('odc', 'access', []).reason, /ODC Portal/);

  // Through MCP, apply EXECUTES (o11-access.mjs; decision of 2026-10-02): --execute, never --prepare-only, the words last.
  const ctx = { operationId: '0123456789abcdef0123456789abcdef', port: 45999, deliverWork: path.join(LANES.o11.root, '.local', 'work') };
  assert.deepEqual(accessArguments({ action: 'plan', manifestPath: manifest }).argv, ['access', 'plan', '--manifest', manifest]);
  assert.deepEqual(accessArguments({ action: 'verify', manifestPath: manifest }).argv, ['access', 'verify']);
  const executed = accessArguments({ action: 'apply', manifestPath: manifest, words: 'ok' }, ctx).argv;
  assert.ok(executed.includes('--execute')); assert.ok(!executed.includes('--prepare-only')); assert.deepEqual(executed.slice(-2), ['--words', 'ok']);
  assert.match(accessArguments({ action: 'apply', manifestPath: manifest }, ctx).error, /authorization words|words/);
  assert.match(accessArguments({ action: 'plan', manifestPath: manifest, words: 'ok' }).error, /no authorization words|words/);
  assert.match(accessArguments({ action: 'plan', manifestPath: 'relative.json' }).error, /absolute/);
  assert.match(accessArguments({ action: 'execute', manifestPath: manifest }).error, /plan, apply or verify/);
  assert.equal(accessArguments({ action: 'apply', manifestPath: manifest, words: 'ok', execute: true }, ctx).ok, false);
});
test('the o11_access MCP tool is served without the lane servers and refuses bad arguments before running anything', async t => {
  // apply takes the Studio write lock: kept in a temporary folder, never the lane's .local.
  const locks = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-access-locks-'));
  t.after(() => fs.rmSync(locks, { recursive: true, force: true }));
  const server = await createSsamServer({ o11: false, odc: false, deps: { lock: { o11Root: locks, odcRoot: locks, connection: () => null } } });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ssam-access-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === 'o11_access');
    assert.ok(tool, 'missing o11_access');
    // users (A13 of the atritos 2 package): the read-only lookup of users and roles, with its own optional fields.
    assert.deepEqual(tool.inputSchema.properties.action.enum, ['plan', 'apply', 'verify', 'users']);
    const noWords = await client.callTool({ name: 'o11_access', arguments: { action: 'apply', manifestPath: path.resolve('m.json') } });
    assert.equal(noWords.isError, true);
    assert.match(noWords.content[0].text, /authorization words/);
    const relative = await client.callTool({ name: 'o11_access', arguments: { action: 'plan', manifestPath: 'm.json' } });
    assert.equal(relative.isError, true);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['action', 'continueTask', 'email', 'host', 'manifestPath', 'max', 'operationId', 'role', 'username', 'words']); // no execution argument: apply always executes
    // refused for the extra argument itself (by the schema or by accessArguments), before anything runs
    const execute = await client.callTool({ name: 'o11_access', arguments: { action: 'apply', manifestPath: 'm.json', words: 'ok', execute: true } })
      .catch(error => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(execute.isError, true);
    // Since the input layer (I1, tool-input.mjs): INPUT_INVALID, "/execute is not a field here", with the corrected call.
    assert.match(execute.content[0].text, /never offered through MCP|additional|unrecognized|is not a field here/i);
  } finally { await client.close(); await server.close(); }
});

test('ssam really reaches the ODC CLI and preserves JSON arguments without a shell', async () => {
  const args = ['deliver', '--lane', 'odc', '--feature', 'test & quoted', '--job', 'does-not-exist.json', '--module', 'Fixture',
    '--owners', '["Screen with spaces"]', '--changes', '["Quote: \\"literal\\" & text"]'];
  const result = await promisify(execFile)(process.execPath, [path.join(LANES.odc.root, 'facade', 'ssam.mjs'), ...args], { windowsHide: true })
    .catch(e => ({ stdout: e.stdout, stderr: e.stderr }));
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.ok, false);
  assert.ok(reply.stderr.some(s => /ENOENT.*does-not-exist/.test(s)), JSON.stringify(reply));
  assert.doesNotMatch(JSON.stringify(reply), /spawn EINVAL/);
});

// One MCP server for a whole session: the ODC tools and the O11 tools on the same stdio server.
test('the ssam MCP server lists the tools of both lanes', async t => {
  // The four hook tools of the controlled profile are listed on this server only with SSAM_APP_HOOK_TOOLS=1 (I10).
  const hook = process.env.SSAM_APP_HOOK_TOOLS;
  process.env.SSAM_APP_HOOK_TOOLS = '1';
  t.after(() => { if (hook === undefined) delete process.env.SSAM_APP_HOOK_TOOLS; else process.env.SSAM_APP_HOOK_TOOLS = hook; });
  const server = await createSsamServer();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ssam-lanes-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const odc of ['studio_doctor', 'studio_snapshot', 'studio_merge', 'studio_publish', 'odc_status', 'hybrid_tenants',
      'odc_auth_status', 'odc_read', 'odc_write', 'odc_receipt', 'odc_portal_read', 'odc_portal_write', 'odc_portal_login',
      'odc_operation_status', 'odc_deploy', 'odc_configurations', 'odc_asset_delete', 'odc_external_db_connection'])
      assert.ok(names.includes(odc), 'missing ODC tool ' + odc);
    // The ODC access tools reach the ssam MCP with the lane prefix, and the session instructions give the auth order.
    assert.match((await client.listTools()).tools.find(t => t.name === 'odc_write').description, /^\[odc\] .*user's words/);
    assert.match(sessionText(client), /Studio session first, compatible Windows-vault credential next, private Windows prompt only when none is stored/);
    for (const o11 of ['context', 'propose', 'continue', 'status', 'o11_job', 'o11_data', 'o11_inspect', 'o11_deliver',
      'o11_studio', 'o11_environment', 'ssam_reference', 'ssam_task', 'odc_portal_routes'])
      assert.ok(names.includes(o11), 'missing tool ' + o11);
    // One process: the O11 app tools are served here (no Python proxy), with the [o11] prefix the proxy showed.
    assert.match((await client.listTools()).tools.find(t => t.name === 'propose').description, /^\[o11\] /);
    // No answer or description of the server sends the model to a shell.
    for (const tool of (await client.listTools()).tools)
      assert.doesNotMatch(tool.description ?? '', /python scripts|run_job\.py|dotnet build|ssam inspect --lane|--click /, tool.name);
    assert.doesNotMatch(client.getInstructions(), /python |\bCLI ssam\b|ssam inspect --lane|cdp_pages/);
    assert.ok(names.includes('ssam_doctor'));
    assert.ok(names.includes('ssam_job'), 'missing the both-lanes job runner ssam_job');
    assert.ok(names.includes('o11_access'), 'missing the O11 end-user roles tool o11_access');
    // The module map serves both lanes through its own `lane` argument: listed once, without an [odc] prefix.
    const tools = (await client.listTools()).tools;
    const map = tools.find(t => t.name === 'ssam_map');
    assert.ok(map, 'missing ssam_map');
    assert.deepEqual(map.inputSchema.properties.lane.enum, ['odc', 'o11']);
    assert.equal(map.annotations.readOnlyHint, true);
    for (const own of ['ssam_map', 'ssam_discover']) assert.doesNotMatch(tools.find(t => t.name === own).description, /^\[odc\]/, own);
    assert.match(tools.find(t => t.name === 'ssam_app_url').description, /^\[odc\] /);
    assert.match(sessionText(client), /Read an app once with ssam_map/);
  } finally { await client.close(); await server.close(); }
});

// The same map for either lane through the ssam MCP: a stored index answers without Studio, reader or .NET.
test('ssam_map answers O11 and ODC captures from their module index through the ssam MCP', async t => {
  const { writeCapture, writeIndex } = await import('./fixtures/module-index.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-map-mcp-'));
  const previous = process.env.SSAM_MODULE_INDEX_ROOT;
  process.env.SSAM_MODULE_INDEX_ROOT = path.join(dir, 'store');
  t.after(() => { if (previous === undefined) delete process.env.SSAM_MODULE_INDEX_ROOT; else process.env.SSAM_MODULE_INDEX_ROOT = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const server = await createSsamServer({ o11: false });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ssam-map-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    for (const lane of ['o11', 'odc']) {
      const capture = writeCapture(dir, lane + ' capture');
      writeIndex(process.env.SSAM_MODULE_INDEX_ROOT, lane, capture.sha256);
      const reply = await client.callTool({ name: 'ssam_map', arguments: { lane, target: capture.file, role: 'screen' } });
      assert.notEqual(reply.isError, true, JSON.stringify(reply.content));
      const map = JSON.parse(reply.content[0].text);
      assert.equal(map.lane, lane); assert.equal(map.cache.index, 'hit'); assert.equal(map.sourceSha256, capture.sha256);
      assert.deepEqual(map.entries.map(e => e.name), ['Home', 'QuoteForm', 'QuoteList']);
      // The next read is an MCP call in both lanes, never a CLI line.
      assert.equal(map.continuations.inspect.tool, lane === 'o11' ? 'o11_inspect' : 'studio_inspect');
      assert.equal(map.continuations.inspect.cli, undefined);
    }
  } finally { await client.close(); await server.close(); }
});

test('the captures an O11 verb produced are warmed: the downloaded module, the delivered snapshot or the candidate', () => {
  assert.equal(o11Capture('download', { Status: 'ok', FilePath: 'C:\\m\\Quotes.oml' }), 'C:\\m\\Quotes.oml');
  assert.equal(o11Capture('download', { Status: 'failed: 404', FilePath: null }), null);
  const artifact = p => ({ path: p, sha256: 'x' });
  assert.equal(o11Capture('deliver', { delivered: true, artifacts: [artifact('base.oml'), artifact('foreign.oml'), artifact('delivered-1.oml')] }), 'delivered-1.oml');
  assert.equal(o11Capture('deliver', { delivered: true, artifacts: [artifact('base.oml'), artifact('foreign.oml')] }), 'foreign.oml');
  assert.equal(o11Capture('deliver', { delivered: true }), null);
  assert.equal(o11Capture('inventory', { FilePath: 'x.oml', Status: 'ok' }), null);
});
