import { profileReadPath } from '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { environment, normalizePaths, root, layout } from '../facade/launch.mjs';
import { Client } from '../platforms/odc/node_modules/@modelcontextprotocol/client/dist/index.mjs';
import { StdioClientTransport } from '../platforms/odc/node_modules/@modelcontextprotocol/client/dist/stdio.mjs';

const exec = promisify(execFile);
// The Python of the Codex runtime is read from the profile the process started with (the isolation moves USERPROFILE).
const python = process.env.SSAM_PYTHON ?? profileReadPath('.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');

test('one repository with both original HEAD commits reachable', async () => {
  for (const source of ['anvil', 'odc']) {
    const { stdout } = await exec('git', ['rev-parse', 'refs/remotes/source-' + source + '/imported-head'], { cwd: root });
    await exec('git', ['merge-base', '--is-ancestor', stdout.trim(), 'HEAD'], { cwd: root });
  }
  assert.ok(fs.existsSync(path.join(root, '.git')));
  assert.ok(!fs.existsSync(path.join(root, 'kernel', '.git')));
  assert.ok(!fs.existsSync(path.join(root, 'platforms', 'odc', '.git')));
});

test('root entry overrides stale checkout paths and keeps workers isolated', () => {
  const env = environment({ ANVIL_ROOT: 'old-kernel', SSAM_HYBRID_ODC_ROOT: 'old-odc', ANVIL_LANE: 'ss5' });
  assert.equal(env.ANVIL_ROOT, path.join(root, 'kernel'));
  assert.equal(env.SSAM_HYBRID_ODC_ROOT, path.join(root, 'platforms', 'odc'));
  // The ports come from this checkout's .ssam-workspace.json: an isolated release uses its own.
  assert.equal(env.ANVIL_WORKER_PORT, String(layout.workers.o11ss5));
  assert.equal(env.ANVIL_ODC_PORT, String(layout.workers.odc));
  assert.equal(environment({}).ANVIL_LANE, layout.o11Lane);
  assert.equal(environment({}).ANVIL_WORKER_PORT, String(layout.workers['o11' + layout.o11Lane]));
});

test('CLI resolves filesystem arguments without treating module names as paths', () => {
  const cwd = path.join(root, 'work with spaces');
  assert.deepEqual(normalizePaths(['job', '--lane', 'odc', 'job.json', '--out', 'out.oml'], cwd),
    ['job', '--lane', 'odc', path.join(cwd, 'job.json'), '--out', path.join(cwd, 'out.oml')]);
  assert.deepEqual(normalizePaths(['inspect', '--lane', 'odc', 'Module', '--depth', '3'], cwd), ['inspect', '--lane', 'odc', 'Module', '--depth', '3']);
  assert.equal(normalizePaths(['inspect', '--lane', 'odc', 'base.oml'], cwd)[3], path.join(cwd, 'base.oml'));
  assert.deepEqual(normalizePaths(['inspect', '--full', '--kind', 'MobileScreen', 'base.oml'], cwd),
    ['inspect', '--full', '--kind', 'MobileScreen', path.join(cwd, 'base.oml')]);
  assert.deepEqual(normalizePaths(['inspect', '--usages', '--include-internal', '--scope', 'subtree', 'base.oml'], cwd),
    ['inspect', '--usages', '--include-internal', '--scope', 'subtree', path.join(cwd, 'base.oml')]);
  assert.deepEqual(normalizePaths(['inspect', '--lane', 'o11', '--oml', 'base.oml', '--work', 'work'], cwd),
    ['inspect', '--lane', 'o11', '--oml', path.join(cwd, 'base.oml'), '--work', path.join(cwd, 'work')]);
  assert.deepEqual(normalizePaths(['deliver', '--job', 'job.json', '--producer', 'Source=snapshot.oml'], cwd),
    ['deliver', '--job', path.join(cwd, 'job.json'), '--producer', 'Source=' + path.join(cwd, 'snapshot.oml')]);
  // map, like inspect: a capture .oml follows the caller's directory, a module name stays as typed.
  assert.deepEqual(normalizePaths(['map', '--lane', 'o11', '--detail', 'base.oml', '--kind', 'MobileScreen'], cwd),
    ['map', '--lane', 'o11', '--detail', path.join(cwd, 'base.oml'), '--kind', 'MobileScreen']);
  assert.deepEqual(normalizePaths(['map', '--lane', 'odc', 'Quotes', '--role', 'screen'], cwd), ['map', '--lane', 'odc', 'Quotes', '--role', 'screen']);
  assert.deepEqual(normalizePaths(['map', '--oml', 'base.oml'], cwd), ['map', '--oml', path.join(cwd, 'base.oml')]);
});

test('Python clients and pools discover the unified roots with non-overlapping ports', async () => {
  const code = "import sys,json;sys.path.insert(0,'scripts');import lanes,odc_worker,worker_pool;print(json.dumps({'o11':lanes.lane('ss5').worker,'odc':odc_worker.PORT,'o11pool':worker_pool.portas('o11',8),'odcpool':worker_pool.portas('odc',8),'local':str(lanes.lane('ss5').local)}))";
  const { stdout } = await exec(python, ['-c', code], { cwd: path.join(root, 'kernel'), env: environment({ ...process.env, ANVIL_LANE: 'ss5' }) });
  const facts = JSON.parse(stdout);
  assert.equal(facts.o11, layout.workers.o11ss5); assert.equal(facts.odc, layout.workers.odc);
  assert.equal(facts.local, path.join(root, 'kernel', '.local', 'lane-ss5'));
  assert.equal(new Set([...facts.o11pool, ...facts.odcpool]).size, 16);
});

test('the root MCP starts from an unrelated working directory and serves both platforms', async () => {
  const client = new Client({ name: 'unified-workspace-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    // SSAM_APP_HOOK_TOOLS=1: context and propose are listed on this server only with it (I10 of the atritos 2 package).
    args: [path.join(root, 'facade', 'ssam.mjs'), 'mcp'], cwd: os.tmpdir(), env: { ...process.env, SSAM_NO_WARM: '1', SSAM_APP_HOOK_TOOLS: '1' }, stderr: 'pipe' }); // no discover index built by a test
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(t => t.name);
    const expected = ['context', 'propose', 'ssam_job', 'studio_manifest', 'studio_deliver', 'studio_inspect', 'odc_status', 'ssam_map'];
    // ssam_map (both lanes, own `lane` argument) is served by the ODC facade server and proxied.
    const odcOnly = ['studio_manifest', 'studio_deliver', 'studio_inspect', 'odc_status', 'ssam_map'];
    // An isolated O11 release ("mcpLanes": ["o11"]) serves the O11 lane only.
    for (const name of expected) assert.equal(names.includes(name), !(layout.mcpLanes && !layout.mcpLanes.includes('odc') && odcOnly.includes(name)), name);
  } finally { await client.close(); }
});

test('SSAM_MCP_LANES=o11 serves the O11 lane without the ODC tools', async () => {
  const client = new Client({ name: 'unified-workspace-test-o11', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'platforms', 'odc', 'facade', 'ssam.mjs'), 'mcp'], cwd: os.tmpdir(),
    // SSAM_APP_HOOK_TOOLS=1: the four hook tools of the controlled profile (context, propose, ...) are listed on this server
    // only with it (I10 of the atritos 2 package).
    env: { ...environment({ ...process.env }), SSAM_MCP_LANES: 'o11', SSAM_NO_WARM: '1', SSAM_APP_HOOK_TOOLS: '1' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['context', 'propose', 'o11_job', 'ssam_job', 'ssam_doctor']) assert.ok(names.includes(name), name);
    for (const name of ['studio_manifest', 'studio_deliver', 'studio_inspect', 'odc_status']) assert.ok(!names.includes(name), name);
  } finally { await client.close(); }
});
