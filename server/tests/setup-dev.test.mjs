// The developer setup (scripts/setup-dev.ps1) relies on three portable pieces; each must keep the original machine
// working unchanged when the new variables are absent:
//   - the .cmd wrappers resolve Node as SSAM_NODE -> the Codex runtime's Node -> node on PATH;
//   - the versioned .mcp.json expands ${SSAM_NODE:-...} and ${SSAM_ROOT:-...} to the previous literal paths;
//   - the O11 interpreter is SSAM_PYTHON -> the Codex runtime's Python under USERPROFILE -> python.
import { originalProfile } from '../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codexNode = home => path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe');
const codexPython = home => path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const wrappers = ['ssam.cmd', 'odc.cmd', path.join('platforms', 'odc', 'ssam.cmd'), path.join('platforms', 'odc', 'odc.cmd')];

// A real node.exe at another path (hard link, or a copy across volumes) and a preload that prints which binary ran.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssam-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const probe = path.join(dir, 'probe.cjs');
  fs.writeFileSync(probe, 'process.stdout.write("NODE=" + process.execPath + "\\n"); process.exit(0);\n');
  const place = target => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.linkSync(process.execPath, target); } catch { fs.copyFileSync(process.execPath, target); }
    return target;
  };
  return { dir, probe, place };
}
async function ranWith(wrapper, env) {
  // The preload exits before the entry module runs (a preload that fails to load aborts Node too), so the argument
  // never reaches the facade.
  const { stdout } = await exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', path.join(root, wrapper), '__probe__'], { env, windowsHide: true });
  return stdout.match(/^NODE=(.+)$/m)?.[1].trim();
}
const baseEnv = (probe, extra) => {
  const env = { ...process.env, NODE_OPTIONS: '--require "' + probe.replaceAll('\\', '/') + '"', ...extra };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
};

test('the .cmd wrappers take SSAM_NODE, then the Codex Node of USERPROFILE, then node on PATH', { skip: process.platform !== 'win32' }, async t => {
  const { dir, probe, place } = fixture(t);
  const explicit = place(path.join(dir, 'explicit', 'node.exe'));
  const home = path.join(dir, 'home');
  const codex = place(codexNode(home));
  const empty = path.join(dir, 'empty');
  fs.mkdirSync(empty);
  const onPath = place(path.join(dir, 'pathbin', 'node.exe'));
  const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  for (const wrapper of wrappers) {
    assert.equal(await ranWith(wrapper, baseEnv(probe, { SSAM_NODE: explicit, USERPROFILE: home })), explicit, wrapper + ': SSAM_NODE');
    assert.equal(await ranWith(wrapper, baseEnv(probe, { SSAM_NODE: undefined, USERPROFILE: home })), codex, wrapper + ': Codex Node');
    assert.equal(await ranWith(wrapper, baseEnv(probe, { SSAM_NODE: path.join(dir, 'missing', 'node.exe'), USERPROFILE: home })), codex, wrapper + ': missing SSAM_NODE');
    assert.equal(await ranWith(wrapper, baseEnv(probe, { SSAM_NODE: undefined, USERPROFILE: empty, PATH: path.dirname(onPath) + ';' + system })), onPath, wrapper + ': PATH');
  }
});

// The profile the process started with (the isolation moves USERPROFILE): the wrapper only resolves Node, and the preload
// exits before the entry module runs, so nothing is written under that profile.
test('without SSAM_NODE, the wrappers still run the Codex Node of this profile when it exists', { skip: process.platform !== 'win32' }, async t => {
  const real = codexNode(originalProfile.home);
  if (!fs.existsSync(real)) return t.skip('no Codex runtime on this machine');
  const { probe } = fixture(t);
  for (const wrapper of wrappers) assert.equal(await ranWith(wrapper, baseEnv(probe, { SSAM_NODE: undefined, USERPROFILE: originalProfile.home })), real, wrapper);
});

// The ${VAR} and ${VAR:-default} expansion Claude Code documents for .mcp.json (command, args, env).
const expand = (text, env) => text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name, fallback) => env[name] ?? fallback ?? match);
const expanded = (file, env) => {
  const servers = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).mcpServers;
  return Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, {
    command: expand(server.command, env), args: server.args.map(arg => expand(arg, env)),
    env: Object.fromEntries(Object.entries(server.env ?? {}).map(([key, value]) => [key, expand(value, env)])) }]));
};

test('the versioned .mcp.json expands to the previous literal paths when SSAM_NODE and SSAM_ROOT are absent', () => {
  const node = 'C:\\Users\\andre\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\node\\bin\\node.exe';
  for (const file of ['.mcp.json', path.join('platforms', 'odc', '.mcp.json')]) {
    const servers = expanded(file, {});
    assert.deepEqual(servers.ssam, { command: node, args: ['C:\\Users\\andre\\SSAM-Hybrid\\facade\\ssam.mjs', 'mcp'], env: { ANVIL_LANE: 'ss4' } }, file);
  }
  const servers = expanded('.mcp.json', {});
  assert.deepEqual(servers['ssam-headless-selected'].args, ['C:\\Users\\andre\\SSAM-Hybrid\\facade\\ssam.mjs', 'package', 'mcp']);
  assert.equal(servers['ssam-functional'].command, node.replaceAll('\\', '/'));
  assert.deepEqual(servers['ssam-functional'].args.slice(0, 5), ['C:/Users/andre/SSAM-Hybrid/facade/ssam.mjs', 'package', 'mcp', '--selection',
    'C:/Users/andre/SSAM-Hybrid/.local/releases/sessions/stage1-functional-r5-r2/selection.json']);
});

test('with SSAM_NODE and SSAM_ROOT set, the .mcp.json servers follow them', () => {
  const env = { SSAM_NODE: 'D:\\tools\\node\\node.exe', SSAM_ROOT: 'D:\\dev\\SSAM-Hybrid' };
  const servers = expanded('.mcp.json', env);
  assert.equal(servers.ssam.command, env.SSAM_NODE);
  assert.equal(servers.ssam.args[0], 'D:\\dev\\SSAM-Hybrid\\facade\\ssam.mjs');
  for (const server of Object.values(servers)) for (const value of [server.command, ...server.args, ...Object.values(server.env)])
    assert.doesNotMatch(value, /\$\{|C:[\\/]Users[\\/]andre/i, value);
});

test('the O11 interpreter is SSAM_PYTHON, then the Codex Python of USERPROFILE, with the original profile as fallback', async () => {
  const lanes = pathToFileURL(path.join(root, 'platforms', 'odc', 'facade', 'lanes.mjs')).href;
  const script = 'import(process.argv[1]).then(m => process.stdout.write(m.python()))';
  const run = async env => (await exec(process.execPath, ['-e', script, lanes], { env, windowsHide: true })).stdout;
  // The child resolves the Python of the profile the process started with (the isolation moves USERPROFILE); it only
  // loads lanes.mjs and prints a path.
  const without = { ...process.env, USERPROFILE: originalProfile.home }; delete without.SSAM_PYTHON;
  const profile = originalProfile.home;
  assert.equal(await run(without), fs.existsSync(codexPython(profile)) ? codexPython(profile) : 'python');
  assert.equal(await run({ ...without, SSAM_PYTHON: 'D:\\py\\python.exe' }), 'D:\\py\\python.exe');
  // On Windows a child spawned without USERPROFILE gets it back from the parent (libuv restores the required
  // variables), so the child removes it from its own environment before loading lanes.mjs.
  const noProfile = (await exec(process.execPath, ['-e', 'delete process.env.USERPROFILE; ' + script, lanes], { env: without, windowsHide: true })).stdout;
  assert.equal(noProfile, fs.existsSync(codexPython('C:\\Users\\andre')) ? codexPython('C:\\Users\\andre') : 'python');
});
